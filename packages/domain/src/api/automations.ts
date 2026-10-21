import { z } from 'zod';
import { AppError, isAppError, notFound } from '@w360/core';
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
  inArray,
  isNotNull,
  sql,
  type AutomationEndReason,
  type AutomationRunStatus,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { triggerSchema } from '../automations/graph';
import { appendRunStep, endRun, lockActiveRun } from '../automations/runs';
import {
  activeStartChannel,
  automationSendsMarketing,
  loadStartableAutomation,
  startInputVariables,
  startRunForContact,
  type StartableAutomation,
} from '../automations/starts';
import { contactForPhone } from '../contacts/service';
import type { OutboundDeps } from '../messaging/outbound';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { apiActor, assertAnyScope, assertScope, hasScope, type ApiContext } from './context';
import { apiErrorResponse } from './errors';
import type { ApiResponse, IdempotencyInput } from './idempotency';
import { API_LIMITS } from './model';
import { assertEachNumberOnce, explicitPhone, idempotent, phoneAt, phoneField } from './resources';

/**
 * Automations through the public API (ADR-077). A key with `automations.start` lists the
 * automations whose published version starts through the API, starts one for a contact with the
 * inputs its trigger declares, and reads and stops the runs keys started (ADR-079). A run starts with
 * the checks an order message rule's run gets (ADR-050), through the start steps members'
 * enrolments share (automations/starts, ADR-401); its template steps check consent and the
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

/** Starting an automation for many contacts in one call (ADR-161): what one start takes, each. */
export const apiStartManyAutomationRunsSchema = z
  .object({
    runs: z
      .array(apiStartAutomationSchema)
      .min(1, 'Give at least one run to start')
      .max(API_LIMITS.runsPerStart, `At most ${API_LIMITS.runsPerStart} runs start in one call`)
      .describe(
        `The contacts to start the automation for, each with its own inputs, at most ${API_LIMITS.runsPerStart}; each number once.`,
      ),
  })
  .strict();

/** Stopping many runs in one call (ADR-162): the runs, each as POST /automation-runs/{id}/stop takes it. */
export const apiStopManyAutomationRunsSchema = z
  .object({
    runIds: z
      .array(z.uuid({ error: 'Give the ids of runs keys started (POST /automations/{id}/runs).' }))
      .min(1, 'Give at least one run.')
      .max(API_LIMITS.runsPerStop, `Give at most ${API_LIMITS.runsPerStop} runs.`)
      .refine((ids) => new Set(ids).size === ids.length, 'Give each run once.')
      .describe(
        `The runs to stop, 1 to ${API_LIMITS.runsPerStop}, each once; they are stopped in this order.`,
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
  assertAnyScope(ctx, ['automations.start']);
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
      const automation = await loadStartableAutomation(tx, ctx.tenant.id, automationId);
      const variables = startInputVariables(automation, data.inputs, 'inputs');
      const channelId = await sendingChannel(tx, ctx, automation);
      const run = await startRunFor(deps, tx, ctx, automation, channelId, phone, variables, now);
      return { status: 201, body: { data: run } };
    }),
  );
}

/** What a start of many runs answered for one number (ADR-161): its run, or why it did not start. */
export interface ApiAutomationRunStart {
  to: string;
  run: ApiAutomationRun | null;
  error: { code: string; message: string; reason?: string } | null;
}

/**
 * Starts an automation for many contacts in one call (ADR-161), in the order given: the
 * automation's checks once for the call, then each start with a single start's checks in a
 * savepoint, so a refusal that depends on the contact (consent, the suppression list, the
 * conversation, the plan's runs left) rolls back that start alone, a contact created for it
 * included, and is answered in its place. Numbers that are not valid and a number given twice
 * refuse the call before anything is read, inputs the automation does not take before any start.
 * One call per idempotency key.
 */
export async function apiStartManyAutomationRuns(
  deps: OutboundDeps,
  ctx: ApiContext,
  automationId: string,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertScope(ctx, 'automations.start');
  if (!z.uuid().safeParse(automationId).success) throw notFound('Automation');
  const data = parseInput(apiStartManyAutomationRunsSchema, input);
  const runs = data.runs.map((run, i) => ({
    place: `runs.${i}`,
    phone: phoneAt(run.to, `runs.${i}.to`),
    inputs: run.inputs,
  }));
  assertEachNumberOnce(runs);
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, (tx) =>
    idempotent(tx, ctx, idempotency, now, async () => {
      const automation = await loadStartableAutomation(tx, ctx.tenant.id, automationId);
      const prepared = runs.map((run) => ({
        phone: run.phone,
        variables: startInputVariables(automation, run.inputs, `${run.place}.inputs`),
      }));
      const channelId = await sendingChannel(tx, ctx, automation);
      const starts: ApiAutomationRunStart[] = [];
      for (const { phone, variables } of prepared) {
        try {
          const run = await tx.transaction((sp) =>
            startRunFor(deps, sp, ctx, automation, channelId, phone, variables, now),
          );
          starts.push({ to: phone, run, error: null });
        } catch (error) {
          // A plan without automations (forbidden) refuses the whole call, as for one start.
          if (
            !isAppError(error) ||
            (error.code !== 'conflict' && error.code !== 'precondition_failed')
          ) {
            throw error;
          }
          const { code, message, reason } = apiErrorResponse(error, ctx.requestId).body.error;
          starts.push({
            to: phone,
            run: null,
            error: { code, message, ...(reason ? { reason } : {}) },
          });
        }
      }
      return { status: 200, body: { data: starts } };
    }),
  );
}

/**
 * The number the automation sends from, when the key may start what it sends (marketing templates
 * need the marketing scope) and the number is active.
 */
export async function sendingChannel(
  tx: Tx,
  ctx: ApiContext,
  automation: StartableAutomation,
): Promise<string> {
  // Marketing templates need the key's marketing scope, as publishing them needs campaigns.send,
  // and the plan must include it (ADR-092).
  if (
    !hasScope(ctx, 'messages.send_marketing') &&
    (await automationSendsMarketing(tx, ctx.tenant.id, automation))
  ) {
    if (ctx.key.scopes.has('messages.send_marketing')) assertScope(ctx, 'messages.send_marketing');
    throw new AppError(
      'forbidden',
      'This automation sends marketing templates, which needs the messages.send_marketing scope.',
    );
  }
  return activeStartChannel(tx, ctx.tenant.id, automation);
}

/**
 * Starts a run of the automation for the contact with this number (created when new, with source
 * `api`) through the shared start steps (automations/starts). A refusal throws; the caller's
 * transaction or savepoint rolls back what it wrote, a contact created for the number included.
 */
async function startRunFor(
  deps: OutboundDeps,
  tx: Tx,
  ctx: ApiContext,
  automation: StartableAutomation,
  channelId: string,
  phone: string,
  variables: Record<string, string>,
  now: Date,
): Promise<ApiAutomationRun> {
  const contactId = await contactForPhone(tx, ctx.tenant.id, {
    phoneE164: phone,
    displayName: null,
    source: 'api',
  });
  const run = await startRunForContact(deps, tx, {
    tenantId: ctx.tenant.id,
    automation,
    channelId,
    contact: { id: contactId, phone },
    variables,
    consent: ['UTILITY'],
    starter: { kind: 'key', apiKeyId: ctx.key.id, correlationId: ctx.requestId },
    now,
  });
  return toApiRun({
    id: run.id,
    automationId: automation.id,
    contactId: run.contactId,
    conversationId: run.conversationId,
    channelId: run.channelId,
    status: 'running',
    endReason: null,
    startedAt: run.startedAt,
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
    const [peek] = await tx
      .select(stopColumns)
      .from(automationRuns)
      .where(startedByKey(ctx.tenant.id, [runId]));
    if (!peek) throw notFound('Automation run');
    // The conversation row first, as for every change to its run.
    await lockConversations(tx, ctx.tenant.id, [peek.conversationId]);
    await stopRunIfActive(tx, ctx, peek, deps.clock.now());
    const [row] = await tx
      .select(runColumns)
      .from(automationRuns)
      .where(startedByKey(ctx.tenant.id, [runId]));
    if (!row) throw new Error('The run was not found after stopping it');
    return toApiRun(row);
  });
}

/**
 * Stops many runs keys started in one call (ADR-162), each as POST /automation-runs/{id}/stop stops
 * one, in one transaction: all of them or none. An id that names no run a key of the company
 * started refuses the call, naming its place, before anything is locked. The runs' conversations are
 * then locked in id order in one statement, as changing many conversations locks them (ADR-120), so
 * calls stopping the same runs take turns instead of deadlocking; each run is stopped in the order
 * given, or answered as it is when it has ended.
 */
export async function apiStopManyAutomationRuns(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  input: unknown,
): Promise<ApiAutomationRun[]> {
  assertScope(ctx, 'automations.start');
  const { runIds } = parseInput(apiStopManyAutomationRunsSchema, input);
  return deps.db.run(ctx.scope, async (tx) => {
    const found = new Map(
      (
        await tx.select(stopColumns).from(automationRuns).where(startedByKey(ctx.tenant.id, runIds))
      ).map((run) => [run.id, run]),
    );
    const runs = runIds.map((id, index) => {
      const run = found.get(id);
      if (!run) throw unknownRun(index);
      return run;
    });
    await lockConversations(
      tx,
      ctx.tenant.id,
      runs.map((run) => run.conversationId),
    );
    const now = deps.clock.now();
    for (const run of runs) await stopRunIfActive(tx, ctx, run, now);
    const rows = new Map(
      (
        await tx.select(runColumns).from(automationRuns).where(startedByKey(ctx.tenant.id, runIds))
      ).map((row) => [row.id, row]),
    );
    return runIds.map((id) => {
      const row = rows.get(id);
      if (!row) throw new Error('A run was not found after stopping it');
      return toApiRun(row);
    });
  });
}

/** The runs with these ids that keys of the company started (ADR-077). */
const startedByKey = (tenantId: string, ids: string[]) =>
  and(
    eq(automationRuns.tenantId, tenantId),
    inArray(automationRuns.id, ids),
    eq(automationRuns.triggerType, 'api'),
    isNotNull(automationRuns.apiKeyId),
  );

const stopColumns = {
  id: automationRuns.id,
  conversationId: automationRuns.conversationId,
  automationId: automationRuns.automationId,
};

const unknownRun = (index: number) => {
  const message =
    'Give the id of a run a key of the company started (POST /automations/{id}/runs).';
  return new AppError('validation_failed', message, {
    issues: [{ path: `runIds.${index}`, message }],
  });
};

/** Locks the conversations' rows for update, in id order, in one statement. */
async function lockConversations(tx: Tx, tenantId: string, ids: string[]): Promise<void> {
  await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), inArray(conversations.id, [...new Set(ids)])))
    .orderBy(asc(conversations.id))
    .for('update');
}

/**
 * Ends the run as `stopped_by_api` when it is still its conversation's active run (ADR-079), with
 * its step and the audit entry as the key; a run that has ended is left as it is. The caller holds
 * the conversation's row lock, which every change to its run takes first.
 */
async function stopRunIfActive(
  tx: Tx,
  ctx: ApiContext,
  run: { id: string; automationId: string; conversationId: string },
  now: Date,
): Promise<void> {
  const active = await lockActiveRun(tx, ctx.tenant.id, run.conversationId);
  if (active?.id !== run.id) return;
  await appendRunStep(tx, ctx.tenant.id, active.id, {
    nodeId: active.currentNodeId,
    nodeType: null,
    outcome: 'stopped',
    detail: 'stopped_by_api',
  });
  await endRun(tx, active, { status: 'stopped', reason: 'stopped_by_api', now });
  await recordSystemAudit(
    tx,
    ctx.tenant.id,
    {
      action: 'automation.run_stopped',
      subjectType: 'automation_run',
      subjectId: active.id,
      metadata: { automationId: run.automationId, source: 'api' },
      correlationId: ctx.requestId,
    },
    apiActor(ctx),
  );
}
