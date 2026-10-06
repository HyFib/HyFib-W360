import { z } from 'zod';
import { AppError, forbidden, isAppError, notFound, uuidv7, type Clock } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  apiKeys,
  asc,
  campaignEvents,
  campaignRecipients,
  campaigns,
  channelAccounts,
  contacts,
  desc,
  eq,
  exactTimestamp,
  inArray,
  isNull,
  memberships,
  messageTemplates,
  messagingSettings,
  rateCards,
  segments,
  sql,
  tenants,
  users,
  type CampaignEventType,
  type CampaignStatus,
  type Database,
  type SQL,
  type TenantRole,
  type Tx,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { permissionsForRoles } from '../authz/permissions';
import { recordAudit, type RequestMeta } from '../audit';
import {
  consentPurposeFor,
  DEFAULT_MESSAGING_SETTINGS,
  loadMessagingSettings,
} from '../consent/service';
import { CSV_BOM, csvLine } from '../contacts/csv';
import { normalizePhone } from '../contacts/phone';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { STATUS_RANK } from '../messaging/status';
import { queueTemplateMessage } from '../messaging/outbound';
import { formatCompanyTime } from '../tenancy/deletion';
import { sendSpecFor } from '../templates/definition';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import {
  MAX_AUDIENCE,
  classifyAudience,
  countAudience,
  eligiblePhones,
  insertSnapshot,
  type AudienceBreakdown,
  type AudienceRules,
} from './audience';
import { loadRateTable, marketFor, parseAmountToMicros, priceFor, rateCategoryFor } from './costs';
import { recountedCounters } from './counters';
import { campaignAnalytics, type CampaignAnalytics } from './results';
import {
  formatTimeOfDay,
  isValidTimeZone,
  parseLocalDateTime,
  parseTimeOfDay,
  resolveLocalTime,
  type ScheduleAdjustment,
} from './schedule';
import {
  loadFieldTypes,
  segmentDefinitionSchema,
  checkSegmentDefinition,
  segmentWhere,
  type SegmentDefinition,
} from './segments';
import {
  campaignVariablesSchema,
  checkVariables,
  fieldsWithoutFallback,
  readCampaignVariables,
  resolveVariables,
} from './variables';

/**
 * Campaigns: a template sent to a frozen audience through the Phase 2 send pipeline.
 *
 * Lifecycle: draft → (pending_approval →) scheduled → running → completed, with paused and
 * canceled as side states. Submitting freezes the audience (snapshot) and records who submitted;
 * when the company requires approval, a different member with `campaigns.approve` approves. Sends
 * run under the authority of the member who submitted (or last resumed) the campaign; if they
 * leave the company or lose `campaigns.send`, the runner pauses the campaign.
 *
 * Cancellation is idempotent: pending recipients are cancelled, queued sends that no worker has
 * claimed are cancelled with their messages, and a second cancel changes nothing. Sends a worker
 * already claimed cannot be recalled and are reported as they end.
 */

export { recountedCounters };
export const CAMPAIGN_TICK_MS = 10_000;
export const MAX_SCHEDULE_AHEAD_DAYS = 90;
export const MAX_TEST_RECIPIENTS = 5;

export interface CampaignDeps {
  db: Database;
  jobs: JobQueue;
  signer: JobSigner;
  clock: Clock;
  /** Emails to the members who can approve a campaign waiting for approval (ADR-204). */
  notices: CampaignNoticeDeps;
}

/** What emailing a company's approvers needs (ADR-204): the outbox and the links' base. */
export interface CampaignNoticeDeps {
  outbox: OutboxDeps;
  appBaseUrl: string;
}

// Settings ---------------------------------------------------------------------------------------

export interface CampaignSettings {
  approvalRequired: boolean;
  capCount: number | null;
  capDays: number | null;
  costCurrency: string | null;
}

export async function loadCampaignSettings(tx: Tx, tenantId: string): Promise<CampaignSettings> {
  const [row] = await tx
    .select({
      approvalRequired: messagingSettings.campaignApprovalRequired,
      capCount: messagingSettings.marketingCapCount,
      capDays: messagingSettings.marketingCapDays,
      costCurrency: messagingSettings.costCurrency,
    })
    .from(messagingSettings)
    .where(eq(messagingSettings.tenantId, tenantId));
  return row ?? { approvalRequired: false, capCount: null, capDays: null, costCurrency: null };
}

export const updateCampaignSettingsSchema = z.object({
  approvalRequired: z.boolean(),
  cap: z
    .object({
      count: z.coerce.number().int().min(1).max(50),
      days: z.coerce.number().int().min(1).max(30),
    })
    .nullable(),
  costCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
});

// Draft input ------------------------------------------------------------------------------------

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(120),
});

const audienceInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('segment'), segmentId: z.uuid() }),
  z.object({ kind: z.literal('conditions'), definition: z.unknown() }),
]);

export const updateCampaignSchema = z.object({
  expectedVersion: z.number().int().min(0),
  name: z.string().trim().min(1, 'Enter a name').max(120),
  channelAccountId: z.uuid().nullable(),
  templateId: z.uuid().nullable(),
  variables: z.unknown(),
  audience: audienceInputSchema,
  schedule: z.object({
    kind: z.enum(['now', 'later']),
    local: z.string().max(25).optional(),
    timezone: z.string().min(1).max(64),
  }),
  window: z.object({ start: z.string().max(8), end: z.string().max(8) }).nullable(),
  ratePerMinute: z.number().int().min(1).max(6000).nullable(),
  maxMessages: z.number().int().min(1).max(1_000_000).nullable(),
  budget: z
    .object({ amount: z.string().max(20), currency: z.string().regex(/^[A-Z]{3}$/) })
    .nullable(),
  stopAfterHours: z.number().int().min(1).max(168),
});

export const reviewNoteSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

export const rejectSchema = z.object({
  note: z.string().trim().min(1, 'Say what needs to change').max(500),
});

export const guardrailsSchema = z.object({
  ratePerMinute: z.number().int().min(1).max(6000).nullable(),
  maxMessages: z.number().int().min(1).max(1_000_000).nullable(),
  budget: z
    .object({ amount: z.string().max(20), currency: z.string().regex(/^[A-Z]{3}$/) })
    .nullable(),
});

export const testSendSchema = z.object({
  phones: z
    .array(z.string().trim().max(40))
    .min(1, 'Enter a phone number')
    .max(MAX_TEST_RECIPIENTS, `Send a test to at most ${MAX_TEST_RECIPIENTS} numbers`),
});

export const recipientFilterSchema = z.object({
  filter: z
    .enum([
      'all',
      'pending',
      'skipped',
      'in_progress',
      'sent',
      'delivered',
      'read',
      'replied',
      'failed',
    ])
    .default('all'),
  cursor: z.string().max(200).optional(),
});

// Helpers ----------------------------------------------------------------------------------------

type CampaignRow = typeof campaigns.$inferSelect;

export async function lockCampaign(
  tx: Tx,
  tenantId: string,
  campaignId: string,
): Promise<CampaignRow> {
  const [row] = await tx
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, campaignId)))
    .for('update');
  if (!row) throw notFound('Campaign');
  return row;
}

export async function recordCampaignEvent(
  tx: Tx,
  tenantId: string,
  campaignId: string,
  type: CampaignEventType,
  actorUserId: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await tx.insert(campaignEvents).values({
    id: uuidv7(),
    tenantId,
    campaignId,
    type,
    actorUserId,
    detail,
  });
}

/** Who stopped a campaign: a member, or an API key with `campaigns.stop` (ADR-128). */
export type CampaignStopper = { userId: string } | { apiKeyId: string };

const stopperEvent = (by: CampaignStopper) =>
  'userId' in by
    ? { actorUserId: by.userId, detail: {} }
    : { actorUserId: null, detail: { apiKeyId: by.apiKeyId } };

/**
 * Pauses a scheduled or running campaign whose row the caller has locked: sends no worker claimed
 * are released and their recipients wait again (a claimed send cannot be recalled). A member's
 * pause says `manual`, a key's `api`; the event names who paused it.
 */
export async function pauseLockedCampaign(
  tx: Tx,
  tenantId: string,
  campaignId: string,
  by: CampaignStopper,
  now: Date,
): Promise<{ released: number }> {
  const released = await releaseQueuedSends(
    tx,
    tenantId,
    campaignId,
    { code: 'campaign_paused', message: 'Not sent: the campaign was paused.' },
    now,
  );
  await requeueReleased(tx, tenantId, campaignId, released);
  const reason = 'userId' in by ? 'manual' : 'api';
  await tx
    .update(campaigns)
    .set({
      status: 'paused',
      pauseReason: reason,
      pausedAt: now,
      nextRunAt: null,
      ...recountedCounters(tenantId, campaignId),
      version: sql`${campaigns.version} + 1`,
    })
    .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, campaignId)));
  const event = stopperEvent(by);
  await recordCampaignEvent(tx, tenantId, campaignId, 'paused', event.actorUserId, {
    reason,
    released: released.length,
    ...event.detail,
  });
  return { released: released.length };
}

/**
 * Whether the member whose authority a campaign sends under may still send campaigns: an active
 * member holding `campaigns.send`. The runner checks it before each batch, and a key's resume
 * before it lifts its pause (ADR-176).
 */
export async function campaignLauncherStanding(
  tx: Tx,
  tenantId: string,
  launchedByUserId: string | null,
): Promise<'permitted' | 'launcher_removed' | 'launcher_not_permitted'> {
  if (!launchedByUserId) return 'launcher_removed';
  const [membership] = await tx
    .select({ roles: memberships.roles })
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.userId, launchedByUserId),
        eq(memberships.status, 'active'),
      ),
    );
  if (!membership) return 'launcher_removed';
  return permissionsForRoles(membership.roles as TenantRole[]).has('campaigns.send')
    ? 'permitted'
    : 'launcher_not_permitted';
}

/**
 * Who resumes a paused campaign: a member, whose authority it then sends under, or a key (ADR-176),
 * which only lifts its pause, so it keeps sending under the authority of the member who launched it.
 */
export type CampaignResumer = { userId: string } | { apiKeyId: string };

/**
 * Resumes a paused campaign whose row the caller has locked, once members' checks pass: the
 * template still approved by Meta, the number active, neither cap reached (counted again first)
 * and a rate card for a spending cap's currency. It runs again, or waits for its scheduled time if
 * it never started; the event names who resumed it. Callers check the statuses and reasons they
 * allow, and write their own audit row.
 */
export async function resumeLockedCampaign(
  deps: Pick<CampaignDeps, 'jobs' | 'signer'>,
  tx: Tx,
  c: CampaignRow,
  by: CampaignResumer,
  now: Date,
): Promise<void> {
  const template = await loadTemplate(tx, c.tenantId, c.templateId);
  if (!template || template.status !== 'approved')
    throw new AppError('precondition_failed', 'The template is not approved by Meta.');
  const channel = await loadChannel(tx, c.tenantId, c.channelAccountId);
  if (!channel || channel.status !== 'active')
    throw new AppError('precondition_failed', 'The WhatsApp number is not active.');
  const [counts] = await tx
    .update(campaigns)
    .set(recountedCounters(c.tenantId, c.id))
    .where(and(eq(campaigns.tenantId, c.tenantId), eq(campaigns.id, c.id)))
    .returning({
      queuedCount: campaigns.queuedCount,
      spentEstimateMicros: campaigns.spentEstimateMicros,
    });
  const queuedCount = counts?.queuedCount ?? c.queuedCount;
  const spentEstimateMicros = counts?.spentEstimateMicros ?? c.spentEstimateMicros;
  if (
    c.pauseReason === 'message_cap_reached' ||
    (c.maxMessages !== null && queuedCount >= c.maxMessages)
  )
    throw new AppError(
      'precondition_failed',
      'The message cap is reached. Raise it before resuming.',
    );
  if (
    c.pauseReason === 'budget_reached' ||
    (c.budgetMicros !== null && spentEstimateMicros >= c.budgetMicros)
  )
    throw new AppError(
      'precondition_failed',
      'The spending cap is reached. Raise it before resuming.',
    );
  if (c.budgetCurrency && !(await loadRateTable(tx, c.budgetCurrency, now)))
    throw new AppError(
      'precondition_failed',
      `No ${c.budgetCurrency} rate card is published, so the spending cap cannot be checked.`,
    );
  const status: CampaignStatus = c.startedAt ? 'running' : 'scheduled';
  const at = c.startedAt ? now : c.scheduledAt && c.scheduledAt > now ? c.scheduledAt : now;
  await tx
    .update(campaigns)
    .set({
      status,
      pauseReason: null,
      pausedAt: null,
      // A member's resume puts the campaign under their authority; a key's leaves it as it was.
      ...('userId' in by ? { launchedByUserId: by.userId } : {}),
      nextRunAt: at,
      version: sql`${campaigns.version} + 1`,
    })
    .where(and(eq(campaigns.tenantId, c.tenantId), eq(campaigns.id, c.id)));
  const event = stopperEvent(by);
  await recordCampaignEvent(tx, c.tenantId, c.id, 'resumed', event.actorUserId, event.detail);
  await signalCampaignRunner(deps, tx, {
    tenantId: c.tenantId,
    campaignId: c.id,
    actorUserId: 'userId' in by ? by.userId : c.launchedByUserId,
    at,
  });
}

/**
 * Cancels a campaign that has not finished, whose row the caller has locked: waiting recipients
 * and sends no worker claimed are cancelled with their messages. The event names who cancelled it.
 */
export async function cancelLockedCampaign(
  tx: Tx,
  tenantId: string,
  campaignId: string,
  by: CampaignStopper,
  now: Date,
): Promise<{ canceledRecipients: number; releasedSends: number }> {
  const pending = await tx
    .update(campaignRecipients)
    .set({ state: 'canceled' })
    .where(
      and(
        eq(campaignRecipients.tenantId, tenantId),
        eq(campaignRecipients.campaignId, campaignId),
        eq(campaignRecipients.state, 'pending'),
      ),
    )
    .returning({ id: campaignRecipients.id });
  const released = await releaseQueuedSends(
    tx,
    tenantId,
    campaignId,
    { code: 'campaign_canceled', message: 'Not sent: the campaign was cancelled.' },
    now,
  );
  if (released.length > 0) {
    await tx
      .update(campaignRecipients)
      .set({ state: 'canceled' })
      .where(
        and(
          eq(campaignRecipients.tenantId, tenantId),
          eq(campaignRecipients.campaignId, campaignId),
          inArray(campaignRecipients.messageId, released),
        ),
      );
  }
  await tx
    .update(campaigns)
    .set({
      status: 'canceled',
      canceledAt: now,
      canceledByUserId: 'userId' in by ? by.userId : null,
      nextRunAt: null,
      ...recountedCounters(tenantId, campaignId),
      version: sql`${campaigns.version} + 1`,
    })
    .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, campaignId)));
  const event = stopperEvent(by);
  const counts = { canceledRecipients: pending.length, releasedSends: released.length };
  await recordCampaignEvent(tx, tenantId, campaignId, 'canceled', event.actorUserId, {
    ...counts,
    ...event.detail,
  });
  return counts;
}

/** Wakes the runner for a campaign at `at` (duplicate signals for one instant collapse). */
export async function signalCampaignRunner(
  deps: Pick<CampaignDeps, 'jobs' | 'signer'>,
  tx: Tx | null,
  input: { tenantId: string; campaignId: string; actorUserId: string | null; at: Date },
): Promise<void> {
  await deps.jobs.enqueue(
    tx,
    QUEUES.campaignRun.name,
    deps.signer.sign({
      kind: 'campaign.run',
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      ref: input.campaignId,
    }),
    {
      singletonKey: `${input.campaignId}:${input.at.getTime()}`,
      startAfter: input.at,
    },
  );
}

/**
 * Cancels the campaign's queued sends that no worker has claimed, marking their messages
 * cancelled. Returns the affected message ids.
 */
export async function releaseQueuedSends(
  tx: Tx,
  tenantId: string,
  campaignId: string,
  reason: { code: 'campaign_paused' | 'campaign_canceled'; message: string },
  now: Date,
): Promise<string[]> {
  const res = await tx.execute<{ id: string }>(sql`
    with released as (
      update app.send_intents s
         set state = 'canceled', lease_until = null, resolved_at = ${now.toISOString()}::timestamptz,
             last_error_code = ${reason.code}, last_error = ${reason.message}
       where s.tenant_id = ${tenantId} and s.state in ('queued', 'deferred')
         and s.message_id in (select m.id from app.messages m
                               where m.tenant_id = ${tenantId} and m.campaign_id = ${campaignId})
      returning s.message_id)
    update app.messages m
       set status = 'canceled', status_rank = ${STATUS_RANK.canceled},
           status_at = ${now.toISOString()}::timestamptz, error_code = ${reason.code},
           error_title = ${reason.message}
      from released
     where m.tenant_id = ${tenantId} and m.id = released.message_id
    returning m.id`);
  return res.rows.map((r) => r.id);
}

/** Puts recipients whose queued message was released back to pending (pause only). */
export async function requeueReleased(
  tx: Tx,
  tenantId: string,
  campaignId: string,
  messageIds: string[],
): Promise<void> {
  if (messageIds.length === 0) return;
  await tx
    .update(campaignRecipients)
    .set({
      state: 'pending',
      messageId: null,
      queuedAt: null,
      market: null,
      estimatedCostMicros: null,
    })
    .where(
      and(
        eq(campaignRecipients.tenantId, tenantId),
        eq(campaignRecipients.campaignId, campaignId),
        inArray(campaignRecipients.messageId, messageIds),
      ),
    );
}

interface TemplateInfo {
  id: string;
  name: string;
  language: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  status: string;
  whatsappAccountId: string;
  spec: ReturnType<typeof sendSpecFor>;
}

async function loadTemplate(tx: Tx, tenantId: string, templateId: string | null) {
  if (!templateId) return null;
  const [t] = await tx
    .select()
    .from(messageTemplates)
    .where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.id, templateId)));
  if (!t) return null;
  const info: TemplateInfo = {
    id: t.id,
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    whatsappAccountId: t.whatsappAccountId,
    spec: sendSpecFor(t.category, t.components),
  };
  return info;
}

async function loadChannel(tx: Tx, tenantId: string, channelAccountId: string | null) {
  if (!channelAccountId) return null;
  const [c] = await tx
    .select({
      id: channelAccounts.id,
      status: channelAccounts.status,
      whatsappAccountId: channelAccounts.whatsappAccountId,
      displayPhoneNumber: channelAccounts.displayPhoneNumber,
      verifiedName: channelAccounts.verifiedName,
    })
    .from(channelAccounts)
    .where(and(eq(channelAccounts.tenantId, tenantId), eq(channelAccounts.id, channelAccountId)));
  return c ?? null;
}

/** The definition a campaign's audience uses now (segment or inline), or a problem. */
async function currentDefinition(
  tx: Tx,
  tenantId: string,
  c: Pick<CampaignRow, 'segmentId' | 'audienceDefinition'>,
): Promise<{ ok: true; definition: SegmentDefinition } | { ok: false; problem: string }> {
  let raw: unknown = c.audienceDefinition;
  if (c.segmentId) {
    const [s] = await tx
      .select({ definition: segments.definition, archivedAt: segments.archivedAt })
      .from(segments)
      .where(and(eq(segments.tenantId, tenantId), eq(segments.id, c.segmentId)));
    if (!s || s.archivedAt) return { ok: false, problem: 'The chosen segment was archived.' };
    raw = s.definition;
  }
  if (!raw) return { ok: false, problem: 'Choose who receives the campaign.' };
  const parsed = segmentDefinitionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problem: 'The audience conditions are incomplete.' };
  const problem = await checkSegmentDefinition(
    tx,
    tenantId,
    parsed.data,
    await loadFieldTypes(tx, tenantId),
  );
  return problem ? { ok: false, problem } : { ok: true, definition: parsed.data };
}

function resolveSchedule(
  c: Pick<CampaignRow, 'scheduleKind' | 'scheduledLocal' | 'timezone'>,
  now: Date,
): { ok: true; at: Date; adjustment: ScheduleAdjustment | null } | { ok: false; problem: string } {
  if (!isValidTimeZone(c.timezone)) return { ok: false, problem: 'Choose a valid time zone.' };
  if (c.scheduleKind === 'now') return { ok: true, at: now, adjustment: null };
  const local = c.scheduledLocal ? parseLocalDateTime(c.scheduledLocal.slice(0, 16)) : null;
  if (!local) return { ok: false, problem: 'Enter the date and time to send.' };
  const { instant, adjustment } = resolveLocalTime(local, c.timezone);
  if (instant.getTime() <= now.getTime()) {
    return { ok: false, problem: 'The scheduled time has passed. Choose a later time.' };
  }
  if (instant.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_DAYS * 86_400_000) {
    return {
      ok: false,
      problem: `Campaigns can be scheduled at most ${MAX_SCHEDULE_AHEAD_DAYS} days ahead.`,
    };
  }
  return { ok: true, at: instant, adjustment };
}

/** The company a draft is checked for: its id, and the time zone its conditions on dates read in. */
export interface CampaignCompany {
  id: string;
  timezone: string;
}

interface Readiness {
  problems: string[];
  template: TemplateInfo | null;
  channel: Awaited<ReturnType<typeof loadChannel>>;
  definition: SegmentDefinition | null;
  rules: AudienceRules | null;
  where: SQL | null;
  schedule: { at: Date; adjustment: ScheduleAdjustment | null } | null;
}

async function evaluateReadiness(
  tx: Tx,
  company: CampaignCompany,
  c: CampaignRow,
  now: Date,
): Promise<Readiness> {
  const problems: string[] = [];
  const channel = await loadChannel(tx, company.id, c.channelAccountId);
  if (!channel) problems.push('Choose the WhatsApp number to send from.');
  else if (channel.status !== 'active')
    problems.push('The chosen WhatsApp number is not active. Reconnect it in Settings → Channels.');
  const template = await loadTemplate(tx, company.id, c.templateId);
  if (!template) problems.push('Choose an approved template.');
  else {
    if (template.status !== 'approved') problems.push('The template is not approved by Meta.');
    if (channel && template.whatsappAccountId !== channel.whatsappAccountId)
      problems.push('The template belongs to another WhatsApp account than the chosen number.');
    if (!template.spec.supported) problems.push(template.spec.reason);
    else {
      const fields = await loadFieldTypes(tx, company.id);
      const problem = checkVariables(
        readCampaignVariables(c.variables),
        template.spec,
        new Set(fields.keys()),
      );
      if (problem) problems.push(problem);
    }
  }
  const def = await currentDefinition(tx, company.id, c);
  if (!def.ok) problems.push(def.problem);
  const schedule = resolveSchedule(c, now);
  if (!schedule.ok) problems.push(schedule.problem);
  if (c.windowStart && c.windowEnd) {
    if (parseTimeOfDay(c.windowStart) === null || parseTimeOfDay(c.windowEnd) === null)
      problems.push('Enter a valid sending window.');
  }
  if (c.budgetCurrency) {
    const table = await loadRateTable(tx, c.budgetCurrency, schedule.ok ? schedule.at : now);
    if (!table) {
      problems.push(
        `No ${c.budgetCurrency} rate card is published, so a spending cap cannot be checked. Remove the cap or ask HyFib support to publish Meta's rates.`,
      );
    }
  }
  let rules: AudienceRules | null = null;
  let where: SQL | null = null;
  if (def.ok && channel && template) {
    const settings = await loadMessagingSettings(tx, company.id);
    rules = {
      tenantId: company.id,
      whatsappAccountId: channel.whatsappAccountId,
      purpose: consentPurposeFor(template.category),
      requireMarketingOptIn: settings.requireMarketingOptIn,
      requiredFields: fieldsWithoutFallback(readCampaignVariables(c.variables)),
    };
    where = segmentWhere(
      company.id,
      def.definition,
      company.timezone,
      await loadFieldTypes(tx, company.id),
    );
  }
  return {
    problems,
    template,
    channel,
    definition: def.ok ? def.definition : null,
    rules,
    where,
    schedule: schedule.ok ? { at: schedule.at, adjustment: schedule.adjustment } : null,
  };
}

export interface CostEstimate {
  currency: string;
  totalMicros: number;
  pricedCount: number;
  unpricedCount: number;
  byMarket: { market: string; count: number; micros: number }[];
}

async function estimateCost(
  tx: Tx,
  currency: string,
  at: Date,
  category: TemplateInfo['category'],
  phones: string[],
): Promise<CostEstimate | null> {
  const table = await loadRateTable(tx, currency, at);
  if (!table) return null;
  const rateCategory = rateCategoryFor(category);
  const markets = new Map<string, { count: number; micros: number }>();
  let unpriced = 0;
  let total = 0;
  for (const phone of phones) {
    const market = marketFor(table, phone);
    const price = priceFor(table, market, rateCategory);
    if (market === null || price === null) {
      unpriced += 1;
      continue;
    }
    total += price;
    const entry = markets.get(market) ?? { count: 0, micros: 0 };
    entry.count += 1;
    entry.micros += price;
    markets.set(market, entry);
  }
  return {
    currency,
    totalMicros: total,
    pricedCount: phones.length - unpriced,
    unpricedCount: unpriced,
    byMarket: [...markets.entries()]
      .map(([market, v]) => ({ market, ...v }))
      .sort((a, b) => b.micros - a.micros),
  };
}

/** What submitting a draft would do now (ADR-193), as members' review and the API show it. */
export interface CampaignDraftReview {
  /** What blocks submitting it, in the order members' review lists them; empty when nothing does. */
  problems: string[];
  /** The audience by skip reason; null until it is complete, or when it is too large. */
  audience: AudienceBreakdown | null;
  /** An upper bound of Meta's charges for the contacts that can receive it now; null without one. */
  estimate: CostEstimate | null;
  costCurrency: string | null;
  scheduledAt: Date | null;
  adjustment: ScheduleAdjustment | null;
  approvalRequired: boolean;
  frequencyCap: { count: number; days: number } | null;
}

/**
 * What submitting a draft would do now: problems that block it, the audience broken down by skip
 * reason, and the estimated cost (an upper bound; see costs.ts). Members' review and keys' through
 * the API (ADR-193) both read it here, so they never differ; it changes nothing.
 */
export async function reviewCampaignDraft(
  tx: Tx,
  company: CampaignCompany,
  c: CampaignRow,
  now: Date,
): Promise<CampaignDraftReview> {
  const r = await evaluateReadiness(tx, company, c, now);
  const settings = await loadCampaignSettings(tx, company.id);
  let audience: AudienceBreakdown | null = null;
  let estimate: CostEstimate | null = null;
  const problems = [...r.problems];
  if (r.rules && r.where) {
    const total = await countAudience(tx, r.where);
    if (total > MAX_AUDIENCE) {
      problems.push(
        `This audience has ${total} contacts; campaigns are limited to ${MAX_AUDIENCE}. Narrow the conditions.`,
      );
    } else {
      audience = await classifyAudience(tx, r.rules, r.where);
      if (audience.eligible === 0)
        problems.push('No contact in this audience can receive the campaign now.');
      const currency = c.budgetCurrency ?? settings.costCurrency;
      if (currency && r.template && audience.eligible > 0) {
        estimate = await estimateCost(
          tx,
          currency,
          r.schedule?.at ?? now,
          r.template.category,
          await eligiblePhones(tx, r.rules, r.where),
        );
      }
    }
  }
  return {
    problems,
    audience,
    estimate,
    costCurrency: c.budgetCurrency ?? settings.costCurrency,
    scheduledAt: r.schedule?.at ?? null,
    adjustment: r.schedule?.adjustment ?? null,
    approvalRequired: settings.approvalRequired,
    frequencyCap:
      settings.capCount && settings.capDays && r.template?.category === 'MARKETING'
        ? { count: settings.capCount, days: settings.capDays }
        : null,
  };
}

// Counted in one statement in ./results (ADR-150); exported here as before.
export { campaignAnalytics, type CampaignAnalytics };

function toScheduledLocal(local: string | undefined): string | null {
  if (!local) return null;
  const parsed = parseLocalDateTime(local);
  if (!parsed) throw new AppError('validation_failed', 'Enter a valid date and time.');
  const p = (v: number, w = 2) => String(v).padStart(w, '0');
  return `${p(parsed.year, 4)}-${p(parsed.month)}-${p(parsed.day)} ${p(parsed.hour)}:${p(parsed.minute)}:00`;
}

function toBudget(budget: { amount: string; currency: string } | null) {
  if (!budget) return { budgetMicros: null, budgetCurrency: null };
  const micros = parseAmountToMicros(budget.amount);
  if (micros === null)
    throw new AppError('validation_failed', 'Enter the spending cap as an amount, like 2500.');
  return { budgetMicros: micros, budgetCurrency: budget.currency };
}

/** Members' and keys' refusal to edit a campaign that is no longer a draft (ADR-186). */
export const DRAFTS_ONLY = 'Only draft campaigns can be edited.';

/** A draft's settings, as members save them and keys give them (ADR-186), without its version. */
export type CampaignDraftInput = Omit<z.infer<typeof updateCampaignSchema>, 'expectedVersion'>;

/**
 * A draft's settings checked as far as they can be without the database: the time zone, the
 * sending window, the variables, the date and time to send and the spending cap. Members' checks,
 * shared with keys (ADR-186).
 */
export function prepareCampaignDraft(data: CampaignDraftInput) {
  if (!isValidTimeZone(data.schedule.timezone))
    throw new AppError('validation_failed', 'Choose a valid time zone.');
  const window = data.window
    ? { start: parseTimeOfDay(data.window.start), end: parseTimeOfDay(data.window.end) }
    : null;
  if (window && (window.start === null || window.end === null || window.start === window.end))
    throw new AppError(
      'validation_failed',
      'Enter a sending window with different start and end times.',
    );
  const variables = campaignVariablesSchema.safeParse(data.variables ?? {});
  if (!variables.success)
    throw new AppError('validation_failed', 'Choose a value for every template variable.');
  const scheduledLocal =
    data.schedule.kind === 'later' ? toScheduledLocal(data.schedule.local) : null;
  if (data.schedule.kind === 'later' && !scheduledLocal)
    throw new AppError('validation_failed', 'Enter the date and time to send.');
  return { data, window, variables: variables.data, scheduledLocal, budget: toBudget(data.budget) };
}
export type PreparedCampaignDraft = ReturnType<typeof prepareCampaignDraft>;

/**
 * Writes a prepared draft to a campaign the caller locked and found to be a draft (members also
 * compare the version they saw): its number, template and segment must be the company's (a segment
 * not archived) and conditions must pass segments' rules, and the version goes up. The caller
 * records the campaign event and the audit (ADR-186).
 */
export async function writeLockedCampaignDraft(
  tx: Tx,
  tenantId: string,
  campaignId: string,
  draft: PreparedCampaignDraft,
): Promise<void> {
  const { data, window, variables, scheduledLocal, budget } = draft;
  if (data.channelAccountId && !(await loadChannel(tx, tenantId, data.channelAccountId)))
    throw notFound('WhatsApp number');
  const template = await loadTemplate(tx, tenantId, data.templateId);
  if (data.templateId && !template) throw notFound('Template');
  let segmentId: string | null = null;
  let audienceDefinition: SegmentDefinition | null = null;
  if (data.audience.kind === 'segment') {
    const [s] = await tx
      .select({ id: segments.id })
      .from(segments)
      .where(
        and(
          eq(segments.tenantId, tenantId),
          eq(segments.id, data.audience.segmentId),
          isNull(segments.archivedAt),
        ),
      );
    if (!s) throw notFound('Segment');
    segmentId = s.id;
  } else if (data.audience.kind === 'conditions') {
    const def = parseInput(segmentDefinitionSchema, data.audience.definition);
    const problem = await checkSegmentDefinition(
      tx,
      tenantId,
      def,
      await loadFieldTypes(tx, tenantId),
    );
    if (problem) throw new AppError('validation_failed', problem);
    audienceDefinition = def;
  }
  await tx
    .update(campaigns)
    .set({
      name: data.name,
      channelAccountId: data.channelAccountId,
      templateId: data.templateId,
      variables,
      segmentId,
      audienceDefinition,
      timezone: data.schedule.timezone,
      scheduleKind: data.schedule.kind,
      scheduledLocal,
      windowStart: window && window.start !== null ? `${formatTimeOfDay(window.start)}:00` : null,
      windowEnd: window && window.end !== null ? `${formatTimeOfDay(window.end)}:00` : null,
      ratePerMinute: data.ratePerMinute,
      maxMessages: data.maxMessages,
      ...budget,
      stopAfterHours: data.stopAfterHours,
      version: sql`${campaigns.version} + 1`,
    })
    .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, campaignId)));
}

/** An amount in micros as members type it: major units, without trailing zeros (ADR-186). */
export function microsToAmount(micros: number): string {
  const units = Math.floor(micros / 1_000_000);
  const fraction = String(micros % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return fraction ? `${units}.${fraction}` : String(units);
}

/**
 * A stored draft's settings as members' editor shows them and keys read and give them (ADR-186):
 * the date and time to send as YYYY-MM-DDTHH:mm, the window as HH:MM, the spending cap in major
 * units.
 */
export function campaignDraftInputOf(c: CampaignRow): CampaignDraftInput {
  return {
    name: c.name,
    channelAccountId: c.channelAccountId,
    templateId: c.templateId,
    variables: readCampaignVariables(c.variables),
    audience: c.segmentId
      ? { kind: 'segment', segmentId: c.segmentId }
      : c.audienceDefinition
        ? { kind: 'conditions', definition: c.audienceDefinition }
        : { kind: 'none' },
    schedule: {
      kind: c.scheduleKind,
      ...(c.scheduledLocal ? { local: c.scheduledLocal.slice(0, 16).replace(' ', 'T') } : {}),
      timezone: c.timezone,
    },
    window:
      c.windowStart && c.windowEnd
        ? { start: c.windowStart.slice(0, 5), end: c.windowEnd.slice(0, 5) }
        : null,
    ratePerMinute: c.ratePerMinute,
    maxMessages: c.maxMessages,
    budget:
      c.budgetMicros !== null && c.budgetCurrency
        ? { amount: microsToAmount(c.budgetMicros), currency: c.budgetCurrency }
        : null,
    stopAfterHours: c.stopAfterHours,
  };
}

/** Who submits a draft: a member, or a key through the API (ADR-202). */
export type CampaignSubmitter = { userId: string } | { apiKeyId: string };

/** What a submission took, for the caller that launches it or leaves it waiting for approval. */
export interface CampaignSubmission {
  snapshot: { total: number; pending: number; skipped: number };
  schedule: { at: Date; adjustment: ScheduleAdjustment | null };
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  /** The columns a submission sets, whatever follows it. */
  submitted: Partial<typeof campaigns.$inferInsert>;
}

/**
 * Submits a locked draft, for a member and for a key (ADR-202) alike: the readiness members' review
 * reads, the audience's size and the snapshot of who it goes to, each refused as members are told,
 * and the submission's event. The caller then launches it under a member's authority, or leaves it
 * waiting for approval (`awaitCampaignApproval`), as a key's submission always is.
 */
export async function submitLockedDraft(
  tx: Tx,
  company: CampaignCompany,
  c: CampaignRow,
  by: CampaignSubmitter,
  now: Date,
): Promise<CampaignSubmission> {
  const r = await evaluateReadiness(tx, company, c, now);
  const first = r.problems[0];
  if (first) throw new AppError('precondition_failed', first);
  if (!r.rules || !r.where || !r.schedule || !r.definition || !r.template)
    throw new Error('Readiness without an audience');
  const total = await countAudience(tx, r.where);
  if (total > MAX_AUDIENCE)
    throw new AppError(
      'precondition_failed',
      `This audience has ${total} contacts; campaigns are limited to ${MAX_AUDIENCE}.`,
    );
  const snapshot = await insertSnapshot(tx, c.id, r.rules, r.where);
  if (snapshot.pending === 0)
    throw new AppError(
      'precondition_failed',
      'No contact in this audience can receive the campaign now.',
    );
  const member = 'userId' in by ? by.userId : null;
  const key = 'apiKeyId' in by ? by.apiKeyId : null;
  await recordCampaignEvent(tx, company.id, c.id, 'submitted', member, {
    ...(key ? { apiKeyId: key } : {}),
    audience: snapshot.total,
    pending: snapshot.pending,
    skipped: snapshot.skipped,
  });
  return {
    snapshot,
    schedule: r.schedule,
    category: r.template.category,
    submitted: {
      audienceUsed: r.definition,
      audienceCount: snapshot.total,
      skippedCount: snapshot.skipped,
      submittedByUserId: member,
      submittedByApiKeyId: key,
      submittedAt: now,
      reviewNote: null,
    },
  };
}

/** Leaves a submitted campaign waiting for a member's approval, set to start when it would. */
export async function awaitCampaignApproval(
  tx: Tx,
  tenantId: string,
  campaignId: string,
  submission: CampaignSubmission,
): Promise<void> {
  await tx
    .update(campaigns)
    .set({
      ...submission.submitted,
      status: 'pending_approval',
      scheduledAt: submission.schedule.at,
      scheduleAdjustment: submission.schedule.adjustment,
      version: sql`${campaigns.version} + 1`,
    })
    .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, campaignId)));
}

/**
 * The email that a campaign waits for approval (ADR-204): who submitted it (a member, or a key whose
 * submission sends under the approver's authority, ADR-202), how many contacts it would reach and
 * when it would start once approved, in the campaign's time zone. Counts only, never contacts.
 */
export function campaignApprovalNotice(input: {
  campaignName: string;
  submitter: { kind: 'member' | 'key'; name: string };
  pending: number;
  total: number;
  /** When it is set to start, or null when it starts once approved. */
  startsAt: Date | null;
  /** The campaign's time zone, the one its page shows its schedule in. */
  timeZone: string;
}): { subject: string; lines: string[] } {
  const count = (n: number) => n.toLocaleString('en-IN');
  const by =
    input.submitter.kind === 'key' ? `The API key “${input.submitter.name}”` : input.submitter.name;
  return {
    subject: `Campaign “${input.campaignName}” waits for your approval`,
    lines: [
      `${by} submitted the campaign “${input.campaignName}”, and it waits for a member's approval.`,
      `It would be sent to ${count(input.pending)} of the ${count(input.total)} ${input.total === 1 ? 'contact' : 'contacts'} in its audience.`,
      input.startsAt
        ? `Once approved, it starts at ${formatCompanyTime(input.startsAt, input.timeZone)}, or at once if that time has passed.`
        : 'Once approved, it starts at once.',
      input.submitter.kind === 'key'
        ? 'Approving it needs permission to send campaigns, as it then sends under your authority. You can also send it back with a note.'
        : 'Approve it, or send it back with a note, on its page.',
    ],
  };
}

/**
 * Emails the members who can approve a campaign that now waits for approval (ADR-204), in the
 * submission's transaction, so a refused submission emails nobody: active members whose roles
 * grant `campaigns.approve`, except the member who submitted it, and for a key's submission only
 * those who may also send campaigns, as approving it needs (ADR-202). Returns how many it emailed.
 */
export async function emailCampaignApprovers(
  notices: CampaignNoticeDeps,
  tx: Tx,
  tenantId: string,
  campaignId: string,
): Promise<number> {
  const [c] = await tx
    .select({
      name: campaigns.name,
      status: campaigns.status,
      version: campaigns.version,
      scheduleKind: campaigns.scheduleKind,
      scheduledAt: campaigns.scheduledAt,
      audienceCount: campaigns.audienceCount,
      skippedCount: campaigns.skippedCount,
      submittedByUserId: campaigns.submittedByUserId,
      submittedByApiKeyId: campaigns.submittedByApiKeyId,
      timezone: campaigns.timezone,
      company: tenants.name,
      slug: tenants.slug,
    })
    .from(campaigns)
    .innerJoin(tenants, eq(tenants.id, campaigns.tenantId))
    .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, campaignId)));
  if (!c || c.status !== 'pending_approval') return 0;
  let submitter: { kind: 'member' | 'key'; name: string };
  if (c.submittedByApiKeyId) {
    const [key] = await tx
      .select({ name: apiKeys.name })
      .from(apiKeys)
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, c.submittedByApiKeyId)));
    // The foreign key keeps the key that submitted a campaign (migration 0140).
    if (!key) throw new Error(`Campaign ${campaignId} names an API key that does not exist`);
    submitter = { kind: 'key', name: key.name };
  } else {
    const [member] = c.submittedByUserId
      ? await tx.select({ name: users.name }).from(users).where(eq(users.id, c.submittedByUserId))
      : [];
    submitter = { kind: 'member', name: member?.name ?? 'A member' };
  }
  const members = await tx
    .select({ userId: users.id, email: users.email, roles: memberships.roles })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.status, 'active')))
    .orderBy(users.id);
  const approvers = members.filter((m) => {
    const granted = permissionsForRoles(m.roles as TenantRole[]);
    return (
      granted.has('campaigns.approve') &&
      m.userId !== c.submittedByUserId &&
      (submitter.kind === 'member' || granted.has('campaigns.send'))
    );
  });
  const { subject, lines } = campaignApprovalNotice({
    campaignName: c.name,
    submitter,
    pending: c.audienceCount - c.skippedCount,
    total: c.audienceCount,
    startsAt: c.scheduleKind === 'now' ? null : c.scheduledAt,
    timeZone: c.timezone,
  });
  const url = new URL(`/c/${c.slug}/campaigns/${campaignId}`, notices.appBaseUrl).toString();
  for (const approver of approvers) {
    await enqueueEmail(notices.outbox, tx, {
      to: approver.email,
      tenantId,
      // One email per approver for each submission: a submission raises the campaign's version.
      dedupeKey: `campaign-approval:${campaignId}:${c.version}:${approver.userId}`,
      payload: {
        kind: 'tenant.notice',
        companyName: c.company,
        subject,
        lines,
        url,
        actionLabel: 'Review campaign',
      },
    });
  }
  return approvers.length;
}

// Service ----------------------------------------------------------------------------------------

export function createCampaignsService(deps: CampaignDeps) {
  const { db, clock } = deps;

  /** Moves a campaign to `scheduled` under `launcher`'s authority and wakes the runner. */
  async function launch(
    tx: Tx,
    ctx: TenantContext,
    c: CampaignRow,
    input: { launcherUserId: string; at: Date; adjustment: ScheduleAdjustment | null },
    extra: Partial<typeof campaigns.$inferInsert>,
  ) {
    await tx
      .update(campaigns)
      .set({
        ...extra,
        status: 'scheduled',
        scheduledAt: input.at,
        scheduleAdjustment: input.adjustment,
        launchedByUserId: input.launcherUserId,
        nextRunAt: input.at,
        version: sql`${campaigns.version} + 1`,
      })
      .where(and(eq(campaigns.tenantId, ctx.tenant.id), eq(campaigns.id, c.id)));
    await recordCampaignEvent(tx, ctx.tenant.id, c.id, 'scheduled', ctx.user.id, {
      at: input.at.toISOString(),
      ...(input.adjustment ? { adjustment: input.adjustment } : {}),
    });
    await signalCampaignRunner(deps, tx, {
      tenantId: ctx.tenant.id,
      campaignId: c.id,
      actorUserId: input.launcherUserId,
      at: input.at,
    });
  }

  return {
    async getSettings(ctx: TenantContext) {
      assertCan(ctx, 'campaigns.read');
      return db.run(
        ctx.scope,
        async (tx) => {
          const settings = await loadCampaignSettings(tx, ctx.tenant.id);
          const currencies = await tx
            .selectDistinct({ currency: rateCards.currency })
            .from(rateCards)
            .where(eq(rateCards.status, 'published'))
            .orderBy(asc(rateCards.currency));
          return { ...settings, availableCurrencies: currencies.map((c) => c.currency) };
        },
        { accessMode: 'read only' },
      );
    },

    async updateSettings(ctx: TenantContext, input: unknown, meta: RequestMeta) {
      assertCan(ctx, 'tenant.settings.manage');
      const data = parseInput(updateCampaignSettingsSchema, input);
      await db.run(ctx.scope, async (tx) => {
        const values = {
          campaignApprovalRequired: data.approvalRequired,
          marketingCapCount: data.cap?.count ?? null,
          marketingCapDays: data.cap?.days ?? null,
          costCurrency: data.costCurrency,
          updatedByUserId: ctx.user.id,
          updatedAt: clock.now(),
        };
        await tx
          .insert(messagingSettings)
          .values({
            tenantId: ctx.tenant.id,
            optOutKeywords: [...DEFAULT_MESSAGING_SETTINGS.optOutKeywords],
            marketingOptOutKeywords: [...DEFAULT_MESSAGING_SETTINGS.marketingOptOutKeywords],
            optInKeywords: [...DEFAULT_MESSAGING_SETTINGS.optInKeywords],
            requireMarketingOptIn: DEFAULT_MESSAGING_SETTINGS.requireMarketingOptIn,
            ...values,
          })
          .onConflictDoUpdate({ target: messagingSettings.tenantId, set: values });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'campaigns.settings_updated',
            subjectType: 'tenant',
            subjectId: ctx.tenant.id,
            metadata: {
              approvalRequired: data.approvalRequired,
              cap: data.cap,
              costCurrency: data.costCurrency,
            },
          },
          meta,
        );
      });
    },

    async listCampaigns(ctx: TenantContext, input: { cursor?: string } = {}) {
      assertCan(ctx, 'campaigns.read');
      const cursor = decodeKeysetCursor(input.cursor);
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: campaigns.id,
              name: campaigns.name,
              status: campaigns.status,
              pauseReason: campaigns.pauseReason,
              templateName: messageTemplates.name,
              audienceCount: campaigns.audienceCount,
              queuedCount: campaigns.queuedCount,
              skippedCount: campaigns.skippedCount,
              scheduledAt: campaigns.scheduledAt,
              startedAt: campaigns.startedAt,
              completedAt: campaigns.completedAt,
              createdAt: campaigns.createdAt,
              cursorAt: exactTimestamp(campaigns.createdAt),
            })
            .from(campaigns)
            .leftJoin(
              messageTemplates,
              and(
                eq(messageTemplates.tenantId, campaigns.tenantId),
                eq(messageTemplates.id, campaigns.templateId),
              ),
            )
            .where(
              and(
                eq(campaigns.tenantId, ctx.tenant.id),
                cursor
                  ? sql`(${campaigns.createdAt}, ${campaigns.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
                  : undefined,
              ),
            )
            .orderBy(desc(campaigns.createdAt), desc(campaigns.id))
            .limit(51),
        { accessMode: 'read only' },
      );
      const page = rows.slice(0, 50);
      const last = page.at(-1);
      return {
        items: page.map(({ cursorAt: _cursorAt, ...item }) => item),
        nextCursor: rows.length > 50 && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },

    async getCampaign(ctx: TenantContext, campaignId: string) {
      assertCan(ctx, 'campaigns.read');
      if (!z.uuid().safeParse(campaignId).success) throw notFound('Campaign');
      return db.run(
        ctx.scope,
        async (tx) => {
          const [c] = await tx
            .select()
            .from(campaigns)
            .where(and(eq(campaigns.tenantId, ctx.tenant.id), eq(campaigns.id, campaignId)));
          if (!c) throw notFound('Campaign');
          const template = await loadTemplate(tx, ctx.tenant.id, c.templateId);
          const channel = await loadChannel(tx, ctx.tenant.id, c.channelAccountId);
          const [segment] = c.segmentId
            ? await tx
                .select({ id: segments.id, name: segments.name, archivedAt: segments.archivedAt })
                .from(segments)
                .where(and(eq(segments.tenantId, ctx.tenant.id), eq(segments.id, c.segmentId)))
            : [];
          // A key that paused or cancelled the campaign is named by its id in the detail (ADR-128).
          const events = await tx
            .select({
              id: campaignEvents.id,
              type: campaignEvents.type,
              detail: campaignEvents.detail,
              occurredAt: campaignEvents.occurredAt,
              actorName: users.name,
              apiKeyName: apiKeys.name,
            })
            .from(campaignEvents)
            .leftJoin(users, eq(users.id, campaignEvents.actorUserId))
            .leftJoin(
              apiKeys,
              and(
                eq(apiKeys.tenantId, campaignEvents.tenantId),
                sql`${apiKeys.id}::text = ${campaignEvents.detail}->>'apiKeyId'`,
              ),
            )
            .where(
              and(
                eq(campaignEvents.tenantId, ctx.tenant.id),
                eq(campaignEvents.campaignId, campaignId),
              ),
            )
            .orderBy(desc(campaignEvents.occurredAt), desc(campaignEvents.id))
            .limit(50);
          const names = await tx
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(
              inArray(
                users.id,
                [
                  c.submittedByUserId,
                  c.approvedByUserId,
                  c.launchedByUserId,
                  c.createdByUserId,
                ].filter((v): v is string => Boolean(v)),
              ),
            );
          const nameOf = (id: string | null) => names.find((n) => n.id === id)?.name ?? null;
          // The key that submitted it through the API (ADR-202), named as the timeline names keys.
          const [submittingKey] = c.submittedByApiKeyId
            ? await tx
                .select({ name: apiKeys.name })
                .from(apiKeys)
                .where(
                  and(eq(apiKeys.tenantId, ctx.tenant.id), eq(apiKeys.id, c.submittedByApiKeyId)),
                )
            : [];
          return {
            campaign: c,
            variables: readCampaignVariables(c.variables),
            template: template
              ? {
                  id: template.id,
                  name: template.name,
                  language: template.language,
                  category: template.category,
                  status: template.status,
                  whatsappAccountId: template.whatsappAccountId,
                  spec: template.spec.supported
                    ? {
                        supported: true as const,
                        headerParams: template.spec.headerParams,
                        bodyParams: template.spec.bodyParams,
                        definition: template.spec.definition,
                      }
                    : { supported: false as const, reason: template.spec.reason },
                }
              : null,
            channel,
            segment: segment ?? null,
            events,
            people: {
              submittedBy: nameOf(c.submittedByUserId),
              submittedByKey: submittingKey?.name ?? null,
              approvedBy: nameOf(c.approvedByUserId),
              launchedBy: nameOf(c.launchedByUserId),
              createdBy: nameOf(c.createdByUserId),
            },
            analytics:
              c.status === 'draft' ? null : await campaignAnalytics(tx, ctx.tenant.id, campaignId),
          };
        },
        { accessMode: 'read only' },
      );
    },

    async createDraft(ctx: TenantContext, input: unknown, meta: RequestMeta) {
      assertCan(ctx, 'campaigns.write');
      const data = parseInput(createCampaignSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const id = uuidv7();
        await tx.insert(campaigns).values({
          id,
          tenantId: ctx.tenant.id,
          name: data.name,
          variables: { header: [], body: [] },
          timezone: ctx.tenant.timezone,
          createdByUserId: ctx.user.id,
        });
        await recordCampaignEvent(tx, ctx.tenant.id, id, 'created', ctx.user.id);
        await recordAudit(
          tx,
          ctx,
          { action: 'campaign.created', subjectType: 'campaign', subjectId: id },
          meta,
        );
        return { id };
      });
    },

    async updateDraft(ctx: TenantContext, campaignId: string, input: unknown, meta: RequestMeta) {
      assertCan(ctx, 'campaigns.write');
      if (!z.uuid().safeParse(campaignId).success) throw notFound('Campaign');
      const { expectedVersion, ...data } = parseInput(updateCampaignSchema, input);
      const draft = prepareCampaignDraft(data);
      return db.run(ctx.scope, async (tx) => {
        const c = await lockCampaign(tx, ctx.tenant.id, campaignId);
        if (c.status !== 'draft') throw new AppError('conflict', DRAFTS_ONLY);
        if (c.version !== expectedVersion)
          throw new AppError(
            'conflict',
            'Someone else changed this campaign. Reload the page to see their version.',
          );
        await writeLockedCampaignDraft(tx, ctx.tenant.id, campaignId, draft);
        await recordCampaignEvent(tx, ctx.tenant.id, campaignId, 'edited', ctx.user.id);
        await recordAudit(
          tx,
          ctx,
          { action: 'campaign.updated', subjectType: 'campaign', subjectId: campaignId },
          meta,
        );
        return { id: campaignId };
      });
    },

    /** What submitting would do now, as `reviewCampaignDraft` reads it for keys too (ADR-193). */
    async reviewDraft(ctx: TenantContext, campaignId: string) {
      assertCan(ctx, 'campaigns.read');
      if (!z.uuid().safeParse(campaignId).success) throw notFound('Campaign');
      const now = clock.now();
      return db.run(
        ctx.scope,
        async (tx) => {
          const [c] = await tx
            .select()
            .from(campaigns)
            .where(and(eq(campaigns.tenantId, ctx.tenant.id), eq(campaigns.id, campaignId)));
          if (!c) throw notFound('Campaign');
          return reviewCampaignDraft(tx, ctx.tenant, c, now);
        },
        { accessMode: 'read only' },
      );
    },

    /** Freezes the audience and sends the campaign for approval or schedules it. */
    async submitCampaign(
      ctx: TenantContext,
      campaignId: string,
      input: unknown,
      meta: RequestMeta,
    ) {
      assertCan(ctx, 'campaigns.write');
      assertCan(ctx, 'campaigns.send');
      if (!z.uuid().safeParse(campaignId).success) throw notFound('Campaign');
      const { expectedVersion } = parseInput(
        z.object({ expectedVersion: z.number().int().min(0) }),
        input,
      );
      const now = clock.now();
      return db.run(ctx.scope, async (tx) => {
        const c = await lockCampaign(tx, ctx.tenant.id, campaignId);
        if (c.status !== 'draft')
          throw new AppError('conflict', 'This campaign was already submitted.');
        if (c.version !== expectedVersion)
          throw new AppError(
            'conflict',
            'Someone else changed this campaign. Reload the page to see their version.',
          );
        const submission = await submitLockedDraft(tx, ctx.tenant, c, { userId: ctx.user.id }, now);
        const { snapshot } = submission;
        const settings = await loadCampaignSettings(tx, ctx.tenant.id);
        if (settings.approvalRequired) {
          await awaitCampaignApproval(tx, ctx.tenant.id, campaignId, submission);
          await emailCampaignApprovers(deps.notices, tx, ctx.tenant.id, campaignId);
        } else {
          await launch(
            tx,
            ctx,
            c,
            {
              launcherUserId: ctx.user.id,
              at: submission.schedule.at,
              adjustment: submission.schedule.adjustment,
            },
            submission.submitted,
          );
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'campaign.submitted',
            subjectType: 'campaign',
            subjectId: campaignId,
            metadata: {
              audience: snapshot.total,
              pending: snapshot.pending,
              approvalRequired: settings.approvalRequired,
              category: submission.category,
            },
          },
          meta,
        );
        return {
          status: (settings.approvalRequired ? 'pending_approval' : 'scheduled') as CampaignStatus,
          audience: snapshot.total,
          pending: snapshot.pending,
        };
      });
    },

    /**
     * Four-eyes approval: a member other than the submitter, holding `campaigns.approve`. A key's
     * submission (ADR-202) is approved by any such member who may also send campaigns, under whose
     * authority it then sends.
     */
    async approveCampaign(
      ctx: TenantContext,
      campaignId: string,
      input: unknown,
      meta: RequestMeta,
    ) {
      assertCan(ctx, 'campaigns.approve');
      if (!z.uuid().safeParse(campaignId).success) throw notFound('Campaign');
      const { note } = parseInput(reviewNoteSchema, input ?? {});
      const now = clock.now();
      await db.run(ctx.scope, async (tx) => {
        const c = await lockCampaign(tx, ctx.tenant.id, campaignId);
        if (c.status !== 'pending_approval')
          throw new AppError('conflict', 'This campaign is not waiting for approval.');
        if (c.submittedByUserId === ctx.user.id)
          throw forbidden('A different member must approve a campaign you submitted.');
        // A key's submission sends under the approving member's authority (ADR-202).
        const launcherUserId = c.submittedByUserId ?? (c.submittedByApiKeyId ? ctx.user.id : null);
        if (!launcherUserId) throw new Error('Submitted campaign without submitter');
        if (launcherUserId === ctx.user.id && !can(ctx, 'campaigns.send'))
          throw forbidden(
            'An API key submitted this campaign, so it sends under the authority of the member who approves it: approving it needs permission to send campaigns.',
          );
        const template = await loadTemplate(tx, ctx.tenant.id, c.templateId);
        if (!template || template.status !== 'approved')
          throw new AppError('precondition_failed', 'The template is no longer approved by Meta.');
        const scheduled = c.scheduledAt ?? now;
        if (scheduled.getTime() + c.stopAfterHours * 3_600_000 <= now.getTime()) {
          throw new AppError(
            'precondition_failed',
            'The scheduled sending period has already ended. Reject the campaign so it can be rescheduled.',
          );
        }
        // Scheduled in the past (approval came late): start now.
        const at = c.scheduleKind === 'now' || scheduled < now ? now : scheduled;
        await launch(
          tx,
          ctx,
          c,
          {
            launcherUserId,
            at,
            adjustment: c.scheduleAdjustment,
          },
          { approvedByUserId: ctx.user.id, approvedAt: now, reviewNote: note ?? null },
        );
        await recordCampaignEvent(tx, ctx.tenant.id, campaignId, 'approved', ctx.user.id, {
          ...(note ? { note } : {}),
        });
        await recordAudit(
          tx,
          ctx,
          { action: 'campaign.approved', subjectType: 'campaign', subjectId: campaignId },
          meta,
        );
      });
    },

    async rejectCampaign(
      ctx: TenantContext,
      campaignId: string,
      input: unknown,
      meta: RequestMeta,
    ) {
      assertCan(ctx, 'campaigns.approve');
      if (!z.uuid().safeParse(campaignId).success) throw notFound('Campaign');
      const { note } = parseInput(rejectSchema, input);
      await db.run(ctx.scope, async (tx) => {
        const c = await lockCampaign(tx, ctx.tenant.id, campaignId);
        if (c.status !== 'pending_approval')
          throw new AppError('conflict', 'This campaign is not waiting for approval.');
        await backToDraft(tx, ctx, c.id, { reviewNote: note });
        await recordCampaignEvent(tx, ctx.tenant.id, campaignId, 'rejected', ctx.user.id, { note });
        await recordAudit(
          tx,
          ctx,
          { action: 'campaign.rejected', subjectType: 'campaign', subjectId: campaignId },
          meta,
        );
      });
    },

    /** The submitter (or an approver) takes a submission back to draft. */
    async withdrawCampaign(ctx: TenantContext, campaignId: string, meta: RequestMeta) {
      assertCan(ctx, 'campaigns.write');
      if (!z.uuid().safeParse(campaignId).success) throw notFound('Campaign');
      await db.run(ctx.scope, async (tx) => {
        const c = await lockCampaign(tx, ctx.tenant.id, campaignId);
        if (c.status !== 'pending_approval')
          throw new AppError('conflict', 'This campaign is not waiting for approval.');
        if (c.submittedByUserId !== ctx.user.id && !can(ctx, 'campaigns.approve'))
          throw forbidden('Only the member who submitted this campaign can withdraw it.');
        await backToDraft(tx, ctx, c.id, {});
        await recordCampaignEvent(tx, ctx.tenant.id, campaignId, 'withdrawn', ctx.user.id);
        await recordAudit(
          tx,
          ctx,
          { action: 'campaign.withdrawn', subjectType: 'campaign', subjectId: campaignId },
          meta,
        );
      });
    },

    async pauseCampaign(ctx: TenantContext, campaignId: string, meta: RequestMeta) {
      assertCan(ctx, 'campaigns.send');
      if (!z.uuid().safeParse(campaignId).success) throw notFound('Campaign');
      const now = clock.now();
      return db.run(ctx.scope, async (tx) => {
        const c = await lockCampaign(tx, ctx.tenant.id, campaignId);
        if (c.status === 'paused') return { released: 0 };
        if (c.status !== 'scheduled' && c.status !== 'running')
          throw new AppError('conflict', 'Only scheduled or running campaigns can be paused.');
        const result = await pauseLockedCampaign(
          tx,
          ctx.tenant.id,
          campaignId,
          { userId: ctx.user.id },
          now,
        );
        await recordAudit(
          tx,
          ctx,
          { action: 'campaign.paused', subjectType: 'campaign', subjectId: campaignId },
          meta,
        );
        return result;
      });
    },

    /** Changes pacing and caps of a campaign that has not finished (often before resuming). */
    async updateGuardrails(
      ctx: TenantContext,
      campaignId: string,
      input: unknown,
      meta: RequestMeta,
    ) {
      assertCan(ctx, 'campaigns.send');
      if (!z.uuid().safeParse(campaignId).success) throw notFound('Campaign');
      const data = parseInput(guardrailsSchema, input);
      const budget = toBudget(data.budget);
      await db.run(ctx.scope, async (tx) => {
        const c = await lockCampaign(tx, ctx.tenant.id, campaignId);
        if (!['draft', 'pending_approval', 'scheduled', 'running', 'paused'].includes(c.status))
          throw new AppError('conflict', 'This campaign has finished.');
        if (budget.budgetCurrency && !(await loadRateTable(tx, budget.budgetCurrency, clock.now())))
          throw new AppError(
            'precondition_failed',
            `No ${budget.budgetCurrency} rate card is published, so a spending cap cannot be checked.`,
          );
        // Raising (or removing) the cap that paused the campaign lets it be resumed.
        const raised =
          (c.pauseReason === 'budget_reached' &&
            (budget.budgetMicros === null ||
              (c.budgetMicros !== null && budget.budgetMicros > c.budgetMicros))) ||
          (c.pauseReason === 'message_cap_reached' &&
            (data.maxMessages === null ||
              (c.maxMessages !== null && data.maxMessages > c.maxMessages)));
        await tx
          .update(campaigns)
          .set({
            ratePerMinute: data.ratePerMinute,
            maxMessages: data.maxMessages,
            ...budget,
            ...(raised ? { pauseReason: 'manual' as const } : {}),
            version: sql`${campaigns.version} + 1`,
          })
          .where(and(eq(campaigns.tenantId, ctx.tenant.id), eq(campaigns.id, campaignId)));
        await recordCampaignEvent(tx, ctx.tenant.id, campaignId, 'edited', ctx.user.id, {
          guardrails: true,
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'campaign.guardrails_updated',
            subjectType: 'campaign',
            subjectId: campaignId,
            metadata: {
              ratePerMinute: data.ratePerMinute,
              maxMessages: data.maxMessages,
              budget: Boolean(data.budget),
            },
          },
          meta,
        );
      });
    },

    /** Resumes a paused campaign under the resuming member's authority. */
    async resumeCampaign(ctx: TenantContext, campaignId: string, meta: RequestMeta) {
      assertCan(ctx, 'campaigns.send');
      if (!z.uuid().safeParse(campaignId).success) throw notFound('Campaign');
      const now = clock.now();
      await db.run(ctx.scope, async (tx) => {
        const c = await lockCampaign(tx, ctx.tenant.id, campaignId);
        if (c.status !== 'paused') throw new AppError('conflict', 'This campaign is not paused.');
        await resumeLockedCampaign(deps, tx, c, { userId: ctx.user.id }, now);
        await recordAudit(
          tx,
          ctx,
          { action: 'campaign.resumed', subjectType: 'campaign', subjectId: campaignId },
          meta,
        );
      });
    },

    /**
     * Cancels the campaign (idempotent). Returns what this call changed; a repeated call on a
     * cancelled or completed campaign changes nothing.
     */
    async cancelCampaign(ctx: TenantContext, campaignId: string, meta: RequestMeta) {
      if (!z.uuid().safeParse(campaignId).success) throw notFound('Campaign');
      const now = clock.now();
      return db.run(ctx.scope, async (tx) => {
        const c = await lockCampaign(tx, ctx.tenant.id, campaignId);
        if (c.status === 'draft') assertCan(ctx, 'campaigns.write');
        else assertCan(ctx, 'campaigns.send');
        if (c.status === 'canceled' || c.status === 'completed') {
          return { status: c.status, changed: false, canceledRecipients: 0, releasedSends: 0 };
        }
        const counts = await cancelLockedCampaign(
          tx,
          ctx.tenant.id,
          campaignId,
          { userId: ctx.user.id },
          now,
        );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'campaign.canceled',
            subjectType: 'campaign',
            subjectId: campaignId,
            metadata: counts,
          },
          meta,
        );
        return { status: 'canceled' as CampaignStatus, changed: true, ...counts };
      });
    },

    /**
     * Sends the campaign's template to up to five contacts the member chooses, through the normal
     * template path (consent, suppression and permissions apply). Test sends are not counted in
     * the campaign's results.
     */
    async sendTest(ctx: TenantContext, campaignId: string, input: unknown, meta: RequestMeta) {
      assertCan(ctx, 'campaigns.send');
      if (!z.uuid().safeParse(campaignId).success) throw notFound('Campaign');
      const { phones } = parseInput(testSendSchema, input);
      const numbers = phones.filter(Boolean).map((raw) => ({
        raw,
        parsed: normalizePhone(raw, { kind: 'explicit' }),
      }));
      const valid = numbers.flatMap((n) => (n.parsed.ok ? [n.parsed.e164] : []));
      const prepared = await db.run(
        ctx.scope,
        async (tx) => {
          const [c] = await tx
            .select()
            .from(campaigns)
            .where(and(eq(campaigns.tenantId, ctx.tenant.id), eq(campaigns.id, campaignId)));
          if (!c) throw notFound('Campaign');
          if (!c.channelAccountId || !c.templateId)
            throw new AppError('precondition_failed', 'Choose the number and template first.');
          const template = await loadTemplate(tx, ctx.tenant.id, c.templateId);
          if (!template?.spec.supported)
            throw new AppError('precondition_failed', 'Choose an approved template first.');
          const variables = readCampaignVariables(c.variables);
          const problem = checkVariables(
            variables,
            template.spec,
            new Set((await loadFieldTypes(tx, ctx.tenant.id)).keys()),
          );
          if (problem) throw new AppError('precondition_failed', problem);
          const people =
            valid.length > 0
              ? await tx
                  .select({
                    id: contacts.id,
                    phoneE164: contacts.phoneE164,
                    displayName: contacts.displayName,
                    attributes: contacts.attributes,
                  })
                  .from(contacts)
                  .where(
                    and(eq(contacts.tenantId, ctx.tenant.id), inArray(contacts.phoneE164, valid)),
                  )
              : [];
          return { c, variables, people };
        },
        { accessMode: 'read only' },
      );
      const results: { phone: string; ok: boolean; message: string }[] = [];
      for (const n of numbers) {
        if (!n.parsed.ok) {
          results.push({ phone: n.raw, ok: false, message: n.parsed.message });
          continue;
        }
        const e164 = n.parsed.e164;
        const person = prepared.people.find((p) => p.phoneE164 === e164);
        if (!person) {
          results.push({ phone: e164, ok: false, message: 'Not a contact yet. Add them first.' });
          continue;
        }
        const resolved = resolveVariables(prepared.variables, person);
        if (!resolved.ok) {
          results.push({
            phone: e164,
            ok: false,
            message: 'A variable has no value for this contact.',
          });
          continue;
        }
        try {
          await queueTemplateMessage(deps, ctx, {
            contactId: person.id,
            channelAccountId: prepared.c.channelAccountId,
            templateId: prepared.c.templateId,
            params: resolved.params,
            clientKey: `cmptest-${uuidv7()}`,
          });
          results.push({ phone: e164, ok: true, message: 'Queued.' });
        } catch (error) {
          if (!isAppError(error)) throw error;
          results.push({ phone: e164, ok: false, message: error.publicMessage });
        }
      }
      await db.run(ctx.scope, async (tx) => {
        await recordCampaignEvent(tx, ctx.tenant.id, campaignId, 'test_sent', ctx.user.id, {
          queued: results.filter((r) => r.ok).length,
          refused: results.filter((r) => !r.ok).length,
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'campaign.test_sent',
            subjectType: 'campaign',
            subjectId: campaignId,
            metadata: { recipients: numbers.length },
          },
          meta,
        );
      });
      return results;
    },

    async listRecipients(ctx: TenantContext, campaignId: string, input: unknown) {
      assertCan(ctx, 'campaigns.read');
      assertCan(ctx, 'contacts.read');
      if (!z.uuid().safeParse(campaignId).success) throw notFound('Campaign');
      const q = parseInput(recipientFilterSchema, input ?? {});
      const after = q.cursor && /^[0-9a-f-]{36}$/.test(q.cursor) ? q.cursor : null;
      const outcome: Record<typeof q.filter, SQL | undefined> = {
        all: undefined,
        pending: sql`r.state = 'pending'`,
        skipped: sql`r.state = 'skipped'`,
        in_progress: sql`r.state = 'queued' and m.status in ('queued', 'sending', 'accepted')`,
        sent: sql`r.state = 'queued' and m.status in ('sent', 'delivered', 'read', 'played')`,
        delivered: sql`r.state = 'queued' and m.status in ('delivered', 'read', 'played')`,
        read: sql`r.state = 'queued' and m.status in ('read', 'played')`,
        replied: sql`r.replied_at is not null`,
        failed: sql`r.state = 'queued' and m.status in ('failed', 'unknown_outcome')`,
      };
      const res = await db.run(
        ctx.scope,
        (tx) =>
          tx.execute<{
            id: string;
            contact_id: string;
            display_name: string | null;
            phone_e164: string | null;
            state: string;
            skip_reason: string | null;
            message_status: string | null;
            error_code: string | null;
            queued_at: string | null;
            replied_at: string | null;
            opted_out_at: string | null;
          }>(sql`
            select r.id, r.contact_id, c.display_name, c.phone_e164, r.state, r.skip_reason,
                   m.status as message_status, m.error_code, r.queued_at, r.replied_at, r.opted_out_at
              from app.campaign_recipients r
              join app.contacts c on c.tenant_id = r.tenant_id and c.id = r.contact_id
              left join app.messages m on m.tenant_id = r.tenant_id and m.id = r.message_id
             where r.tenant_id = ${ctx.tenant.id} and r.campaign_id = ${campaignId}
               ${outcome[q.filter] ? sql`and ${outcome[q.filter]}` : sql``}
               ${after ? sql`and r.id > ${after}::uuid` : sql``}
             order by r.id
             limit 51`),
        { accessMode: 'read only' },
      );
      const items = res.rows.slice(0, 50);
      return {
        items: items.map((r) => ({
          id: r.id,
          contactId: r.contact_id,
          displayName: r.display_name,
          phoneE164: r.phone_e164,
          state: r.state,
          skipReason: r.skip_reason,
          messageStatus: r.message_status,
          errorCode: r.error_code,
          queuedAt: r.queued_at ? new Date(r.queued_at) : null,
          repliedAt: r.replied_at ? new Date(r.replied_at) : null,
          optedOutAt: r.opted_out_at ? new Date(r.opted_out_at) : null,
        })),
        nextCursor: res.rows.length > 50 ? (items[items.length - 1]?.id ?? null) : null,
      };
    },

    /** Per-recipient outcomes as CSV (formula-safe), streamed in batches; audited. */
    async *exportRecipients(
      ctx: TenantContext,
      campaignId: string,
      meta: RequestMeta = {},
    ): AsyncGenerator<string> {
      assertCan(ctx, 'campaigns.read');
      assertCan(ctx, 'contacts.export');
      if (!z.uuid().safeParse(campaignId).success) throw notFound('Campaign');
      await db.run(ctx.scope, async (tx) => {
        const [c] = await tx
          .select({ id: campaigns.id })
          .from(campaigns)
          .where(and(eq(campaigns.tenantId, ctx.tenant.id), eq(campaigns.id, campaignId)));
        if (!c) throw notFound('Campaign');
        await recordAudit(
          tx,
          ctx,
          { action: 'campaign.exported', subjectType: 'campaign', subjectId: campaignId },
          meta,
        );
      });
      yield CSV_BOM +
        csvLine([
          'phone',
          'name',
          'recipient_state',
          'skip_reason',
          'message_status',
          'error_code',
          'queued_at',
          'replied_at',
          'opted_out_at',
          'market',
          'estimated_cost_micros',
        ]);
      let after: string | null = null;
      for (;;) {
        const res: { rows: Record<string, string | number | null>[] } = await db.run(
          ctx.scope,
          (tx) =>
            tx.execute<Record<string, string | number | null>>(sql`
              select r.id, c.phone_e164, c.display_name, r.state, r.skip_reason, m.status,
                     m.error_code, r.queued_at, r.replied_at, r.opted_out_at, r.market,
                     r.estimated_cost_micros
                from app.campaign_recipients r
                join app.contacts c on c.tenant_id = r.tenant_id and c.id = r.contact_id
                left join app.messages m on m.tenant_id = r.tenant_id and m.id = r.message_id
               where r.tenant_id = ${ctx.tenant.id} and r.campaign_id = ${campaignId}
                 ${after ? sql`and r.id > ${after}::uuid` : sql``}
               order by r.id limit 1000`),
          { accessMode: 'read only' },
        );
        if (res.rows.length === 0) break;
        let chunk = '';
        for (const r of res.rows) {
          const iso = (v: string | number | null | undefined) =>
            v ? new Date(String(v)).toISOString() : '';
          chunk += csvLine([
            r.phone_e164 as string | null,
            r.display_name as string | null,
            r.state as string,
            r.skip_reason as string | null,
            r.status as string | null,
            r.error_code as string | null,
            iso(r.queued_at),
            iso(r.replied_at),
            iso(r.opted_out_at),
            r.market as string | null,
            r.estimated_cost_micros as number | null,
          ]);
        }
        yield chunk;
        after = String(res.rows[res.rows.length - 1]?.id);
        if (res.rows.length < 1000) break;
      }
    },
  };

  async function backToDraft(
    tx: Tx,
    ctx: TenantContext,
    campaignId: string,
    extra: { reviewNote?: string },
  ) {
    await returnLockedCampaignToDraft(tx, ctx.tenant.id, campaignId, extra);
  }
}

/**
 * Takes a locked submission waiting for approval back to a draft, as a rejection, a member's
 * withdrawal and a key's (ADR-203) do: its audience snapshot (nothing was sent) and submission are
 * dropped, and its version goes up, so a submission made from the old version is refused.
 */
export async function returnLockedCampaignToDraft(
  tx: Tx,
  tenantId: string,
  campaignId: string,
  extra: { reviewNote?: string },
): Promise<void> {
  await tx
    .delete(campaignRecipients)
    .where(
      and(eq(campaignRecipients.tenantId, tenantId), eq(campaignRecipients.campaignId, campaignId)),
    );
  await tx
    .update(campaigns)
    .set({
      status: 'draft',
      audienceUsed: null,
      audienceCount: 0,
      skippedCount: 0,
      submittedByUserId: null,
      submittedByApiKeyId: null,
      submittedAt: null,
      scheduledAt: null,
      scheduleAdjustment: null,
      reviewNote: extra.reviewNote ?? null,
      version: sql`${campaigns.version} + 1`,
    })
    .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, campaignId)));
}

export type CampaignsService = ReturnType<typeof createCampaignsService>;

/** Messages attached to a campaign are identified in threads (see inbox message rendering). */
export async function campaignNames(tx: Tx, tenantId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const rows = await tx
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(and(eq(campaigns.tenantId, tenantId), inArray(campaigns.id, ids)));
  return new Map(rows.map((r) => [r.id, r.name]));
}
