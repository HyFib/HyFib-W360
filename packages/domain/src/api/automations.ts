import { z } from 'zod';
import { AppError, notFound, uuidv7 } from '@w360/core';
import {
  and,
  asc,
  automationRuns,
  automations,
  automationVersions,
  channelAccounts,
  conversations,
  eq,
  exactTimestamp,
  gt,
  inArray,
  isNotNull,
  messageTemplates,
  sql,
  type AutomationEndReason,
  type AutomationRunStatus,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import {
  apiInputValues,
  graphSchema,
  RUN_BUDGETS,
  templatesOf,
  triggerSchema,
} from '../automations/graph';
import { appendRunStep, endRun, lockActiveRun, signalAutomationRun } from '../automations/runs';
import { checkTemplateEligibility } from '../consent/service';
import { contactForPhone } from '../contacts/service';
import { emitTenantEvent } from '../messaging/events';
import type { OutboundDeps } from '../messaging/outbound';
import { consumeAutomationRun } from '../plans/entitlements';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { apiActor, assertScope, type ApiContext } from './context';
import type { ApiResponse, IdempotencyInput } from './idempotency';
import { API_LIMITS } from './model';
import { explicitPhone, idempotent, phoneField } from './resources';

/**
 * Automations through the public API (ADR-077). A key with `automations.start` lists the
 * automations whose published version starts through the API, starts one for a contact with the
 * inputs its trigger declares, and reads and stops the runs keys started (ADR-079). A run starts with
 * the checks an order message rule's run gets (ADR-050); its template steps check consent and the
 * marketing frequency cap again when they send.
 */

export const apiAutomationListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
  })
  .strict();

export const apiStartAutomationSchema = z
  .object({
    to: phoneField,
    inputs: z
      .record(z.string(), z.string())
      .default({})
      .describe(
        'A text for each input the automation declares (`inputs` in GET /api/v1/automations), by name.',
      ),
  })
  .strict();

export interface ApiAutomation {
  id: string;
  name: string;
  status: 'active' | 'paused';
  inputs: string[];
  channelId: string | null;
  phoneNumber: string | null;
  createdAt: string;
}

export interface ApiAutomationRun {
  id: string;
  automationId: string;
  contactId: string;
  conversationId: string;
  channelId: string;
  status: AutomationRunStatus;
  endReason: AutomationEndReason | null;
  startedAt: string;
  endedAt: string | null;
}

/** Reading needs the scope only; starting and stopping (writes) also need an active company. */
function assertStartScopeHeld(ctx: ApiContext) {
  if (!ctx.key.scopes.has('automations.start')) assertScope(ctx, 'automations.start');
}

const runColumns = {
  id: automationRuns.id,
  automationId: automationRuns.automationId,
  contactId: automationRuns.contactId,
  conversationId: automationRuns.conversationId,
  channelId: automationRuns.channelAccountId,
  status: automationRuns.status,
  endReason: automationRuns.endReason,
  startedAt: automationRuns.startedAt,
  endedAt: automationRuns.endedAt,
};

const toApiRun = (r: {
  id: string;
  automationId: string;
  contactId: string;
  conversationId: string;
  channelId: string;
  status: AutomationRunStatus;
  endReason: AutomationEndReason | null;
  startedAt: Date;
  endedAt: Date | null;
}): ApiAutomationRun => ({
  id: r.id,
  automationId: r.automationId,
  contactId: r.contactId,
  conversationId: r.conversationId,
  channelId: r.channelId,
  status: r.status,
  endReason: r.endReason,
  startedAt: r.startedAt.toISOString(),
  endedAt: r.endedAt?.toISOString() ?? null,
});

/**
 * The automations whose published version starts through the API, active or paused, oldest first.
 * Drafts, archived automations and those started otherwise are left out.
 */
export async function apiListAutomations(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiAutomation[]; nextCursor: string | null }> {
  assertStartScopeHeld(ctx);
  const q = parseInput(apiAutomationListQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const rows = await tx
        .select({
          id: automations.id,
          name: automations.name,
          status: automations.status,
          trigger: automationVersions.trigger,
          channelId: automationVersions.channelAccountId,
          phoneNumber: channelAccounts.displayPhoneNumber,
          createdAt: automations.createdAt,
          cursorAt: exactTimestamp(automations.createdAt),
        })
        .from(automations)
        .innerJoin(
          automationVersions,
          and(
            eq(automationVersions.tenantId, automations.tenantId),
            eq(automationVersions.id, automations.activeVersionId),
          ),
        )
        .leftJoin(
          channelAccounts,
          and(
            eq(channelAccounts.tenantId, automationVersions.tenantId),
            eq(channelAccounts.id, automationVersions.channelAccountId),
          ),
        )
        .where(
          and(
            eq(automations.tenantId, ctx.tenant.id),
            inArray(automations.status, ['active', 'paused']),
            sql`${automationVersions.trigger} ->> 'type' = 'api'`,
            cursor
              ? sql`(${automations.createdAt}, ${automations.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(automations.createdAt), asc(automations.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      const last = shown.at(-1);
      return {
        data: shown.map((r) => {
          const trigger = triggerSchema.safeParse(r.trigger);
          return {
            id: r.id,
            name: r.name,
            status: r.status === 'paused' ? 'paused' : 'active',
            inputs: trigger.success && trigger.data.type === 'api' ? trigger.data.inputs : [],
            channelId: r.channelId,
            phoneNumber: r.phoneNumber,
            createdAt: r.createdAt.toISOString(),
          } satisfies ApiAutomation;
        }),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
}

/** A refusal with a reason integrations can act on. */
const refused = (
  code: 'conflict' | 'precondition_failed' | 'forbidden',
  message: string,
  apiReason: string,
) => new AppError(code, message, { details: { apiReason } });

/**
 * Starts an automation whose published version starts through the API for the contact with this
 * number (created when new), with the inputs its trigger declares. One run per idempotency key; a
 * refusal changes nothing.
 */
export async function apiStartAutomationRun(
  deps: OutboundDeps,
  ctx: ApiContext,
  automationId: string,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertScope(ctx, 'automations.start');
  if (!z.uuid().safeParse(automationId).success) throw notFound('Automation');
  const data = parseInput(apiStartAutomationSchema, input);
  const phone = explicitPhone(data.to);
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, (tx) =>
    idempotent(tx, ctx, idempotency, now, async () => {
      const run = await startRun(deps, tx, ctx, automationId, phone, data.inputs, now);
      return { status: 201, body: { data: run } };
    }),
  );
}

async function startRun(
  deps: OutboundDeps,
  tx: Tx,
  ctx: ApiContext,
  automationId: string,
  phone: string,
  givenInputs: Record<string, string>,
  now: Date,
): Promise<ApiAutomationRun> {
  const tenantId = ctx.tenant.id;
  const [automation] = await tx
    .select({
      id: automations.id,
      status: automations.status,
      activeVersionId: automations.activeVersionId,
    })
    .from(automations)
    .where(and(eq(automations.tenantId, tenantId), eq(automations.id, automationId)))
    .for('share');
  if (!automation) throw notFound('Automation');
  if (automation.status === 'archived' || !automation.activeVersionId) {
    throw refused(
      'precondition_failed',
      automation.status === 'archived'
        ? 'This automation is archived.'
        : 'This automation has not been published.',
      'automation_unavailable',
    );
  }
  const [version] = await tx
    .select({
      id: automationVersions.id,
      trigger: automationVersions.trigger,
      graph: automationVersions.graph,
      channelAccountId: automationVersions.channelAccountId,
    })
    .from(automationVersions)
    .where(
      and(
        eq(automationVersions.tenantId, tenantId),
        eq(automationVersions.id, automation.activeVersionId),
      ),
    );
  const trigger = triggerSchema.safeParse(version?.trigger);
  const graph = graphSchema.safeParse(version?.graph);
  if (!version || !trigger.success || !graph.success || trigger.data.type !== 'api') {
    throw refused(
      'precondition_failed',
      'This automation does not start through the API.',
      'automation_unavailable',
    );
  }
  if (automation.status !== 'active') {
    throw refused('precondition_failed', 'This automation is paused.', 'automation_paused');
  }
  const inputs = apiInputValues(trigger.data.inputs, givenInputs);
  if (!inputs.ok) {
    throw new AppError('validation_failed', inputs.message, {
      issues: [{ path: 'inputs', message: inputs.message }],
    });
  }
  // Marketing templates need the key's marketing scope, as publishing them needs campaigns.send.
  const templateIds = templatesOf(graph.data);
  if (templateIds.length > 0 && !ctx.key.scopes.has('messages.send_marketing')) {
    const [marketing] = await tx
      .select({ id: messageTemplates.id })
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.tenantId, tenantId),
          inArray(messageTemplates.id, templateIds),
          eq(messageTemplates.category, 'MARKETING'),
        ),
      )
      .limit(1);
    if (marketing) {
      throw new AppError(
        'forbidden',
        'This automation sends marketing templates, which needs the messages.send_marketing scope.',
      );
    }
  }
  const channelId = version.channelAccountId;
  const [channel] = channelId
    ? await tx
        .select({ status: channelAccounts.status })
        .from(channelAccounts)
        .where(and(eq(channelAccounts.tenantId, tenantId), eq(channelAccounts.id, channelId)))
    : [];
  if (!channelId || !channel || channel.status !== 'active') {
    throw refused(
      'precondition_failed',
      'The WhatsApp number of this automation is not active.',
      'channel_unavailable',
    );
  }

  // Erasure, suppression and opt-outs; a refusal rolls back a contact created for the number. Each
  // template step checks its own category's consent when it sends.
  const contactId = await contactForPhone(tx, tenantId, {
    phoneE164: phone,
    displayName: null,
    source: 'api',
  });
  const eligibility = await checkTemplateEligibility(tx, {
    tenantId,
    contactId,
    recipientPhones: [phone],
    category: 'UTILITY',
  });
  if (!eligibility.ok) throw new AppError('precondition_failed', eligibility.message);

  // A conversation the run starts is resolved, like a campaign's; the customer's reply opens it.
  await tx
    .insert(conversations)
    .values({
      id: uuidv7(),
      tenantId,
      channelAccountId: channelId,
      contactId,
      status: 'resolved',
      resolvedAt: now,
    })
    .onConflictDoNothing();
  const [conversation] = await tx
    .select({
      id: conversations.id,
      status: conversations.status,
      resolvedAt: conversations.resolvedAt,
      assignedMembershipId: conversations.assignedMembershipId,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.channelAccountId, channelId),
        eq(conversations.contactId, contactId),
      ),
    )
    .for('update');
  if (!conversation) throw new Error('Conversation upsert failed');
  if (conversation.assignedMembershipId) {
    throw refused(
      'conflict',
      'The conversation with this contact is assigned to a member.',
      'conversation_assigned',
    );
  }
  if (await lockActiveRun(tx, tenantId, conversation.id)) {
    throw refused(
      'conflict',
      'An automation is already handling the conversation with this contact.',
      'automation_busy',
    );
  }
  const [recent] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.tenantId, tenantId),
        eq(automationRuns.conversationId, conversation.id),
        gt(automationRuns.startedAt, new Date(now.getTime() - 3600_000)),
      ),
    );
  if ((recent?.n ?? 0) >= RUN_BUDGETS.maxRunsPerConversationPerHour) {
    throw refused(
      'conflict',
      `At most ${RUN_BUDGETS.maxRunsPerConversationPerHour} automation runs start in one conversation in an hour.`,
      'automation_limit',
    );
  }
  // The company's plan: automations included and a run left this month (ADR-051).
  const counted = await consumeAutomationRun(tx, tenantId, now);
  if (!counted.ok) {
    throw counted.reason === 'not_in_plan'
      ? refused('forbidden', "Your company's plan does not include automations.", 'not_in_plan')
      : refused(
          'precondition_failed',
          "Your company's plan has no automation runs left this month.",
          'automation_quota',
        );
  }

  // The run may work in the conversation while it stays resolved as it is now (the runner compares
  // the time it was resolved with the run's start), so the start is never before that time.
  const startedAt =
    conversation.status === 'resolved' && conversation.resolvedAt && conversation.resolvedAt > now
      ? conversation.resolvedAt
      : now;
  const runId = uuidv7();
  await tx.insert(automationRuns).values({
    id: runId,
    tenantId,
    automationId: automation.id,
    versionId: version.id,
    conversationId: conversation.id,
    contactId,
    channelAccountId: channelId,
    mode: 'live',
    triggerType: 'api',
    apiKeyId: ctx.key.id,
    variables: inputs.variables,
    status: 'running',
    currentNodeId: graph.data.start,
    nextStepAt: now,
    startedAt,
  });
  await appendRunStep(tx, tenantId, runId, {
    nodeId: null,
    nodeType: null,
    outcome: 'started',
    detail: 'api',
  });
  await emitTenantEvent(tx, tenantId, {
    type: 'automation.started',
    conversationId: conversation.id,
    payload: { runId, automationId: automation.id },
  });
  await recordSystemAudit(
    tx,
    tenantId,
    {
      action: 'automation.run_started',
      subjectType: 'automation_run',
      subjectId: runId,
      metadata: { automationId: automation.id, source: 'api' },
      correlationId: ctx.requestId,
    },
    apiActor(ctx),
  );
  await signalAutomationRun(deps, tx, { tenantId, runId, actorUserId: null, key: 'start' });
  return toApiRun({
    id: runId,
    automationId: automation.id,
    contactId,
    conversationId: conversation.id,
    channelId,
    status: 'running',
    endReason: null,
    startedAt,
    endedAt: null,
  });
}

/** A run started through the API, by any key of the company. */
export async function apiGetAutomationRun(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  runId: string,
): Promise<ApiAutomationRun> {
  assertStartScopeHeld(ctx);
  if (!z.uuid().safeParse(runId).success) throw notFound('Automation run');
  const row = await deps.db.run(
    ctx.scope,
    async (tx) => {
      const [r] = await tx
        .select(runColumns)
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.tenantId, ctx.tenant.id),
            eq(automationRuns.id, runId),
            eq(automationRuns.triggerType, 'api'),
            isNotNull(automationRuns.apiKeyId),
          ),
        );
      return r ?? null;
    },
    { accessMode: 'read only' },
  );
  if (!row) throw notFound('Automation run');
  return toApiRun(row);
}

/**
 * Stops a run started through the API (ADR-079). An active run ends as stopped with the reason
 * `stopped_by_api`: its queued messages are cancelled and the conversation is not routed (a customer
 * who wrote waits for a member, as after a reply through the API). A run that has ended is answered
 * as it is, so a retry changes nothing.
 */
export async function apiStopAutomationRun(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  runId: string,
): Promise<ApiAutomationRun> {
  assertScope(ctx, 'automations.start');
  if (!z.uuid().safeParse(runId).success) throw notFound('Automation run');
  return deps.db.run(ctx.scope, async (tx) => {
    const startedByKey = and(
      eq(automationRuns.tenantId, ctx.tenant.id),
      eq(automationRuns.id, runId),
      eq(automationRuns.triggerType, 'api'),
      isNotNull(automationRuns.apiKeyId),
    );
    const [peek] = await tx
      .select({
        conversationId: automationRuns.conversationId,
        automationId: automationRuns.automationId,
      })
      .from(automationRuns)
      .where(startedByKey);
    if (!peek) throw notFound('Automation run');
    // The conversation row first, as for every change to its run.
    await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, peek.conversationId)),
      )
      .for('update');
    const run = await lockActiveRun(tx, ctx.tenant.id, peek.conversationId);
    if (run?.id === runId) {
      await appendRunStep(tx, ctx.tenant.id, run.id, {
        nodeId: run.currentNodeId,
        nodeType: null,
        outcome: 'stopped',
        detail: 'stopped_by_api',
      });
      await endRun(tx, run, { status: 'stopped', reason: 'stopped_by_api', now: deps.clock.now() });
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action: 'automation.run_stopped',
          subjectType: 'automation_run',
          subjectId: run.id,
          metadata: { automationId: peek.automationId, source: 'api' },
          correlationId: ctx.requestId,
        },
        apiActor(ctx),
      );
    }
    const [row] = await tx.select(runColumns).from(automationRuns).where(startedByKey);
    if (!row) throw new Error('The run was not found after stopping it');
    return toApiRun(row);
  });
}
