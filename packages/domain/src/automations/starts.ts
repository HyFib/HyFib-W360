import { AppError, isAppError, notFound, uuidv7 } from '@w360/core';
import {
  and,
  automationRuns,
  automations,
  automationVersions,
  channelAccounts,
  conversations,
  eq,
  gt,
  inArray,
  messageTemplates,
  sql,
  type TemplateCategory,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { checkTemplateEligibility, type EligibilityBlock } from '../consent/service';
import { emitTenantEvent } from '../messaging/events';
import { consumeAutomationRun } from '../plans/entitlements';
import { apiInputValues, graphSchema, RUN_BUDGETS, templatesOf, triggerSchema } from './graph';
import { appendRunStep, lockActiveRun, signalAutomationRun, type RunSignalDeps } from './runs';

/**
 * The steps of a start of one run of an automation started by a member or through the API (trigger
 * `api`), shared by every way such a run starts: a key's start of one run (ADR-077) or of many
 * (ADR-161), and a member's enrolment (ADR-401). The automation's checks run once per call, batch
 * or enrolment (`loadStartableAutomation`, `startInputVariables`, `automationSendsMarketing`,
 * `activeStartChannel`); each contact then takes `startRunForContact` (erasure, suppression and
 * opt-outs; the conversation, not held by a member or handled by another run; the hourly limit; the
 * plan's runs). A refusal throws an AppError carrying its code as `details.startRefusal` (and, for
 * the codes the API names, as `details.apiReason`); the caller's transaction or savepoint rolls back
 * what the start wrote.
 */

/** Why a start was refused, as a code (ADR-077's reasons and the consent refusals, ADR-052). */
export const START_REFUSALS = [
  'automation_unavailable',
  'automation_paused',
  'channel_unavailable',
  'contact_erased',
  'suppressed',
  'opted_out',
  'no_marketing_opt_in',
  'conversation_assigned',
  'automation_busy',
  'automation_limit',
  'automation_quota',
  'not_in_plan',
] as const;
export type StartRefusal = (typeof START_REFUSALS)[number];

/** A refusal with its code; the codes the API answers with are also its `reason` (ADR-077). */
function refused(
  code: 'conflict' | 'precondition_failed' | 'forbidden',
  message: string,
  reason: StartRefusal,
  answeredAsApiReason = true,
) {
  return new AppError(code, message, {
    details: { ...(answeredAsApiReason ? { apiReason: reason } : {}), startRefusal: reason },
  });
}

/** The code of a refused start, or null when the error is not one. */
export function startRefusalOf(error: unknown): StartRefusal | null {
  if (!isAppError(error)) return null;
  const reason = error.details?.startRefusal;
  return typeof reason === 'string' && (START_REFUSALS as readonly string[]).includes(reason)
    ? (reason as StartRefusal)
    : null;
}

/** What a start needs of the automation, checked once for a call, batch or enrolment. */
export interface StartableAutomation {
  id: string;
  versionId: string;
  /** The inputs its trigger declares. */
  inputs: readonly string[];
  /** The step a run starts at. */
  start: string;
  /** The templates its steps send. */
  templateIds: string[];
  channelAccountId: string | null;
}

/**
 * The automation, when it is published, started by a member or through the API and active
 * (archived, unpublished, other triggers and paused automations are refused). Takes the
 * automation's row lock for share, so it is not archived or paused under the start.
 */
export async function loadStartableAutomation(
  tx: Tx,
  tenantId: string,
  automationId: string,
): Promise<StartableAutomation> {
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
  return {
    id: automation.id,
    versionId: version.id,
    inputs: trigger.data.inputs,
    start: graph.data.start,
    templateIds: templatesOf(graph.data),
    channelAccountId: version.channelAccountId,
  };
}

/**
 * A start's inputs as the run's variables (`input.<name>`), validated as the API validates them
 * (ADR-077): each declared input a text of 1 to 1,000 characters, nothing else. Refused at `path`.
 */
export function startInputVariables(
  automation: Pick<StartableAutomation, 'inputs'>,
  given: unknown,
  path: string,
): Record<string, string> {
  const inputs = apiInputValues(automation.inputs, given);
  if (!inputs.ok) {
    throw new AppError('validation_failed', inputs.message, {
      issues: [{ path, message: inputs.message }],
    });
  }
  return inputs.variables;
}

/** Whether the automation's steps send a marketing template (which needs more to start). */
export async function automationSendsMarketing(
  tx: Tx,
  tenantId: string,
  automation: Pick<StartableAutomation, 'templateIds'>,
): Promise<boolean> {
  if (automation.templateIds.length === 0) return false;
  const [marketing] = await tx
    .select({ id: messageTemplates.id })
    .from(messageTemplates)
    .where(
      and(
        eq(messageTemplates.tenantId, tenantId),
        inArray(messageTemplates.id, automation.templateIds),
        eq(messageTemplates.category, 'MARKETING'),
      ),
    )
    .limit(1);
  return Boolean(marketing);
}

/** The number the automation sends from, when it is active. */
export async function activeStartChannel(
  tx: Tx,
  tenantId: string,
  automation: Pick<StartableAutomation, 'channelAccountId'>,
): Promise<string> {
  const channelId = automation.channelAccountId;
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
  return channelId;
}

/**
 * Who starts a run: a key, audited per run as the key (ADR-077), or a member's enrolment, audited
 * once for the enrolment (ADR-401). Either way the run is live and acts for the company (ADR-038).
 */
export type RunStarter =
  | { kind: 'key'; apiKeyId: string; correlationId: string }
  | { kind: 'enrollment'; enrollmentId: string };

/** A run a start began. */
export interface StartedRun {
  id: string;
  contactId: string;
  conversationId: string;
  channelId: string;
  startedAt: Date;
}

/**
 * Starts a run of the automation for this contact: the checks that depend on the contact and its
 * conversation, then the run, its first step, the live `automation.started` event and its first
 * job. `consent` lists the categories whose consent the contact must allow now (utility always; a
 * member's enrolment of an automation that sends marketing templates also marketing, ADR-401). A
 * refusal throws; the caller's transaction or savepoint rolls back what it wrote.
 */
export async function startRunForContact(
  deps: RunSignalDeps,
  tx: Tx,
  input: {
    tenantId: string;
    automation: StartableAutomation;
    channelId: string;
    /** The contact and its number (none once erased: the erasure check refuses it first). */
    contact: { id: string; phone: string | null };
    variables: Record<string, string>;
    consent: readonly TemplateCategory[];
    starter: RunStarter;
    now: Date;
  },
): Promise<StartedRun> {
  const { tenantId, automation, channelId, contact, now, starter } = input;
  // Erasure, suppression and opt-outs. Each template step checks its own category's consent again
  // when it sends.
  for (const category of input.consent) {
    const eligibility = await checkTemplateEligibility(tx, {
      tenantId,
      contactId: contact.id,
      recipientPhones: contact.phone ? [contact.phone] : [],
      category,
    });
    if (!eligibility.ok) throw eligibilityRefusal(eligibility.code, eligibility.message);
  }

  // A conversation the run starts is resolved, like a campaign's; the customer's reply opens it.
  await tx
    .insert(conversations)
    .values({
      id: uuidv7(),
      tenantId,
      channelAccountId: channelId,
      contactId: contact.id,
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
        eq(conversations.contactId, contact.id),
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
    versionId: automation.versionId,
    conversationId: conversation.id,
    contactId: contact.id,
    channelAccountId: channelId,
    mode: 'live',
    triggerType: 'api',
    apiKeyId: starter.kind === 'key' ? starter.apiKeyId : null,
    enrollmentId: starter.kind === 'enrollment' ? starter.enrollmentId : null,
    variables: input.variables,
    status: 'running',
    currentNodeId: automation.start,
    nextStepAt: now,
    startedAt,
  });
  await appendRunStep(tx, tenantId, runId, {
    nodeId: null,
    nodeType: null,
    outcome: 'started',
    detail: starter.kind === 'key' ? 'api' : 'enrollment',
  });
  await emitTenantEvent(tx, tenantId, {
    type: 'automation.started',
    conversationId: conversation.id,
    payload: { runId, automationId: automation.id },
  });
  if (starter.kind === 'key') {
    await recordSystemAudit(
      tx,
      tenantId,
      {
        action: 'automation.run_started',
        subjectType: 'automation_run',
        subjectId: runId,
        metadata: { automationId: automation.id, source: 'api' },
        correlationId: starter.correlationId,
      },
      { type: 'api_key', id: starter.apiKeyId },
    );
  }
  await signalAutomationRun(deps, tx, { tenantId, runId, actorUserId: null, key: 'start' });
  return {
    id: runId,
    contactId: contact.id,
    conversationId: conversation.id,
    channelId,
    startedAt,
  };
}

/**
 * A consent refusal (ADR-052): answered by the API with its message only, as for template sends,
 * and recorded with its code by an enrolment.
 */
function eligibilityRefusal(code: EligibilityBlock, message: string): AppError {
  return refused('precondition_failed', message, code, false);
}
