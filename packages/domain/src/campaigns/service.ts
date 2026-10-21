import { z } from 'zod';
import { AppError, forbidden, isAppError, notFound, uuidv7, type Clock } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  apiKeys,
  asc,
  campaignEvents,
  campaignRecipients,
  campaignVariants,
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
  notInArray,
  rateCards,
  segments,
  sql,
  tenants,
  users,
  type CampaignEventType,
  type CampaignPauseReason,
  type CampaignStatus,
  type Database,
  type SQL,
  type TenantRole,
  type Tx,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { shownNumber } from '../contacts/number-masking';
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
import { NOTICE_LINE_MAX, splitEmailText } from '../email/templates';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { STATUS_RANK } from '../messaging/status';
import { queueTemplateMessage } from '../messaging/outbound';
import { formatCompanyTime } from '../tenancy/deletion';
import { wantsEmail } from '../tenancy/email-preferences';
import { linkButtons, sendSpecFor, type SendSpec } from '../templates/definition';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import {
  MAX_AUDIENCE,
  armWhere,
  classifyAudience,
  countAudience,
  eligiblePhones,
  insertSnapshot,
  type AudienceArm,
  type AudienceBreakdown,
} from './audience';
import {
  combineEstimates,
  estimateFromTable,
  loadRateTable,
  parseAmountToMicros,
  type CostEstimate,
} from './costs';
import { recountedCounters } from './counters';
import {
  SUBMITTED_NOTICE_STATUSES,
  campaignMessagingLimitNotice,
  loadNumberMessagingLimit,
  submittedCampaignRecipients,
  type CampaignMessagingLimitNotice,
} from './messaging-limit-notice';
import {
  campaignAnalytics,
  campaignVariantAnalytics,
  type CampaignAnalytics,
  type CampaignVariantAnalytics,
} from './results';
import {
  formatTimeOfDay,
  isValidTimeZone,
  parseLocalDateTime,
  parseTimeOfDay,
  resolveLocalTime,
  type ScheduleAdjustment,
} from './schedule';
import {
  assertCanUseDefinition,
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
  type CampaignVariables,
} from './variables';
import {
  DEFAULT_VARIANTS_LIMIT,
  VARIANT_LABELS,
  parseVariantLabel,
  variantConditionSql,
  variantInputSchema,
  variantLabelAt,
  variantLimitProblem,
  variantSetProblem,
  variantsInputSchema,
  variantTemplateProblems,
  type VariantLabel,
} from './variants';

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
  /**
   * The most variants a draft may be given, A included (ADR-410): `CAMPAIGN_VARIANTS_MAX`, two
   * (`DEFAULT_VARIANTS_LIMIT`) unless the deployment raised it once no server of the release
   * before is left.
   */
  variantsLimit?: number;
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
  /**
   * Variant B (ADR-405): a second template with its own mapping and its share of the recipients;
   * null removes it (and any variant after it, ADR-410), given it keeps C to E, and left out (keys'
   * edits that do not name it) it stays as it is.
   */
  variantB: variantInputSchema.nullable().optional(),
  /**
   * Every variant after A in label order (ADR-410): B, then C to E. Given, it replaces them all (an
   * empty list or null removes them); left out, they stay. Never given with `variantB`.
   */
  variants: variantsInputSchema.nullable().optional(),
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
  /** Which variant's template and mapping to test (ADR-405, ADR-410); A without variants. */
  variant: z.enum(VARIANT_LABELS).default('A'),
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
  // Without variants, A's template is checked as always; with them, each variant's only while it
  // has pending recipients (ADR-405, ADR-410), as the runner checks them.
  await assertVariantTemplatesApproved(tx, c, 'is not');
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

/**
 * Refuses a resume or an approval while a template it would send is not approved by Meta (ADR-405,
 * ADR-410): without variants, the campaign's one template; with them, each variant's (A to E) while
 * it has pending recipients, so a finished variant never holds the others back and a variant that
 * got no recipients is ignored. The refusal names the variant ("Variant C’s template …").
 */
export async function assertVariantTemplatesApproved(
  tx: Tx,
  c: Pick<CampaignRow, 'tenantId' | 'id' | 'templateId'>,
  wording: 'is not' | 'is no longer',
): Promise<void> {
  const variants = await loadCampaignVariants(tx, c.tenantId, c.id);
  const pending = variants.length > 0 ? await pendingByVariant(tx, c.tenantId, c.id) : null;
  const sources: { label: VariantLabel; templateId: string | null }[] = [
    { label: 'A', templateId: c.templateId },
    ...variants.map((v) => ({ label: v.label, templateId: v.templateId })),
  ];
  for (const source of sources) {
    if (pending !== null && !pending.has(source.label)) continue;
    const template = await loadTemplate(tx, c.tenantId, source.templateId);
    if (!template || template.status !== 'approved')
      throw new AppError(
        'precondition_failed',
        pending === null
          ? `The template ${wording} approved by Meta.`
          : `Variant ${source.label}’s template ${wording} approved by Meta.`,
      );
  }
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

/** What a mapping is checked against: the template's counts and its links that take a value. */
function variableSpec(spec: Extract<SendSpec, { supported: true }>) {
  return {
    headerParams: spec.headerParams,
    bodyParams: spec.bodyParams,
    links: linkButtons(spec.definition),
  };
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

/** A campaign's variant after A as stored (ADR-405, ADR-410); A is the campaign's own template. */
export interface StoredCampaignVariant {
  label: VariantLabel;
  templateId: string | null;
  variables: CampaignVariables;
  sharePercent: number;
}

/**
 * The campaign's variants after A in label order (B, then C to E, ADR-410); empty for a campaign
 * without variants.
 */
export async function loadCampaignVariants(
  tx: Tx,
  tenantId: string,
  campaignId: string,
): Promise<StoredCampaignVariant[]> {
  const rows = await tx
    .select({
      label: campaignVariants.label,
      templateId: campaignVariants.templateId,
      variables: campaignVariants.variables,
      sharePercent: campaignVariants.sharePercent,
    })
    .from(campaignVariants)
    .where(
      and(eq(campaignVariants.tenantId, tenantId), eq(campaignVariants.campaignId, campaignId)),
    )
    .orderBy(asc(campaignVariants.label));
  return rows.map((row) => ({
    label: parseVariantLabel(row.label),
    templateId: row.templateId,
    variables: readCampaignVariables(row.variables),
    sharePercent: row.sharePercent,
  }));
}

/** The campaign's variant B (ADR-405), or null for a campaign without variants. */
export async function loadCampaignVariant(
  tx: Tx,
  tenantId: string,
  campaignId: string,
): Promise<StoredCampaignVariant | null> {
  return (
    (await loadCampaignVariants(tx, tenantId, campaignId)).find((v) => v.label === 'B') ?? null
  );
}

/** One variant of a campaign: its template, its mapping and its share of the recipients. */
export interface CampaignVariantPlan {
  label: VariantLabel;
  template: TemplateInfo | null;
  variables: CampaignVariables;
  /** Its share of the recipients, in percent (100 for A without B). */
  sharePercent: number;
}

/**
 * The campaign's variants: A alone (the campaign's template and mapping, every recipient), or A and
 * the variants after it (B to E, ADR-405 and ADR-410), each with its share and A the rest.
 */
async function campaignVariantPlans(
  tx: Tx,
  tenantId: string,
  c: Pick<CampaignRow, 'id' | 'templateId' | 'variables'>,
): Promise<CampaignVariantPlan[]> {
  const others = await loadCampaignVariants(tx, tenantId, c.id);
  const plans: CampaignVariantPlan[] = [
    {
      label: 'A',
      template: await loadTemplate(tx, tenantId, c.templateId),
      variables: readCampaignVariables(c.variables),
      sharePercent: 100 - others.reduce((sum, v) => sum + v.sharePercent, 0),
    },
  ];
  for (const v of others) {
    plans.push({
      label: v.label,
      template: await loadTemplate(tx, tenantId, v.templateId),
      variables: v.variables,
      sharePercent: v.sharePercent,
    });
  }
  return plans;
}

/** A variant ready to be counted and frozen: its template is known and its audience rules set. */
interface ReadyVariant extends AudienceArm {
  template: TemplateInfo;
  sharePercent: number;
}

interface Readiness {
  problems: string[];
  variants: CampaignVariantPlan[];
  /** A's template (the campaign's own). */
  template: TemplateInfo | null;
  channel: Awaited<ReturnType<typeof loadChannel>>;
  definition: SegmentDefinition | null;
  /** Each variant's rules and share; null until the number, every template and the audience are. */
  arms: ReadyVariant[] | null;
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
  const variants = await campaignVariantPlans(tx, company.id, c);
  const fieldTypes = await loadFieldTypes(tx, company.id);
  const fieldKeys = new Set(fieldTypes.keys());
  // Each variant is checked on its own, B to E as A (ADR-410); with variants, each problem names
  // its variant (ADR-405).
  for (const v of variants) {
    problems.push(
      ...variantTemplateProblems(
        variants.length > 1 ? v.label : null,
        v.template,
        channel,
        v.variables,
        fieldKeys,
      ),
    );
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
  let arms: ReadyVariant[] | null = null;
  let where: SQL | null = null;
  // The shares of the variants after A, in label order: they fix each variant's buckets. Drafts are
  // written with valid shares; checked again, as a stored set is what the snapshot splits by.
  const shares = variants.slice(1).map((v) => v.sharePercent);
  const setProblem = variantSetProblem(shares);
  if (setProblem) problems.push(setProblem);
  if (def.ok && channel && variants.every((v) => v.template)) {
    const settings = await loadMessagingSettings(tx, company.id);
    arms = variants.map((v) => {
      const template = v.template as TemplateInfo;
      return {
        label: v.label,
        template,
        sharePercent: v.sharePercent,
        rules: {
          tenantId: company.id,
          whatsappAccountId: channel.whatsappAccountId,
          purpose: consentPurposeFor(template.category),
          requireMarketingOptIn: settings.requireMarketingOptIn,
          requiredFields: fieldsWithoutFallback(v.variables),
        },
        // Without variants every contact is A; with them each falls into one by its hash.
        filter:
          shares.length === 0
            ? null
            : variantConditionSql(c.id, sql`${contacts.id}`, v.label, shares),
      };
    });
    where = segmentWhere(company.id, def.definition, company.timezone, fieldTypes);
  }
  return {
    problems,
    variants,
    template: variants[0]?.template ?? null,
    channel,
    definition: def.ok ? def.definition : null,
    arms,
    where,
    schedule: schedule.ok ? { at: schedule.at, adjustment: schedule.adjustment } : null,
  };
}

/** The refusal of a variant none of whose contacts can receive the campaign (ADR-405). */
export const emptyVariantProblem = (label: VariantLabel) =>
  `Variant ${label}: no contact in its share of the audience can receive the campaign now.`;

/** One variant in a draft's review (ADR-405): its template, its share, who and what it would cost. */
export interface CampaignVariantReview {
  label: VariantLabel;
  templateId: string | null;
  templateName: string | null;
  category: TemplateInfo['category'] | null;
  /** Its share of the recipients, in percent. */
  sharePercent: number;
  /** Its contacts by skip reason; null while the review's audience is. */
  audience: AudienceBreakdown | null;
  /** Its contacts who can receive it now at its template's category's rates; null without one. */
  estimate: CostEstimate | null;
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
  /**
   * The chosen number's messaging limit against the contacts who can receive it now (ADR-400); null
   * until it has a number of the company and an audience counted. A notice: it never blocks.
   */
  messagingLimit: CampaignMessagingLimitNotice | null;
  /**
   * Its variants side by side, A and B to E (ADR-405, ADR-410), whose audiences and estimates add
   * up to the review's; null for a campaign without variants.
   */
  variants: CampaignVariantReview[] | null;
}

/** Breakdowns of disjoint parts of an audience added up. */
export function sumBreakdowns(parts: readonly AudienceBreakdown[]): AudienceBreakdown {
  const out: AudienceBreakdown = { total: 0, eligible: 0, skipped: {} };
  for (const part of parts) {
    out.total += part.total;
    out.eligible += part.eligible;
    for (const [reason, n] of Object.entries(part.skipped) as [
      keyof AudienceBreakdown['skipped'],
      number,
    ][])
      out.skipped[reason] = (out.skipped[reason] ?? 0) + n;
  }
  return out;
}

/**
 * What submitting a draft would do now: problems that block it, the audience broken down by skip
 * reason, and the estimated cost (an upper bound; see costs.ts). Members' review and keys' through
 * the API (ADR-193) both read it here, so they never differ; it changes nothing. With variants
 * (ADR-405, ADR-410) each variant's contacts are classified by its own template's rules and priced at its
 * category's rates, and the totals are their sums: each recipient is counted and priced once.
 */
export async function reviewCampaignDraft(
  tx: Tx,
  company: CampaignCompany,
  c: CampaignRow,
  now: Date,
): Promise<CampaignDraftReview> {
  const r = await evaluateReadiness(tx, company, c, now);
  const settings = await loadCampaignSettings(tx, company.id);
  const withVariants = r.variants.length > 1;
  let audience: AudienceBreakdown | null = null;
  let estimate: CostEstimate | null = null;
  const perVariant = new Map<
    VariantLabel,
    { audience: AudienceBreakdown; estimate: CostEstimate | null }
  >();
  const problems = [...r.problems];
  if (r.arms && r.where) {
    const where = r.where;
    const total = await countAudience(tx, where);
    if (total > MAX_AUDIENCE) {
      problems.push(
        `This audience has ${total} contacts; campaigns are limited to ${MAX_AUDIENCE}. Narrow the conditions.`,
      );
    } else {
      for (const arm of r.arms) {
        perVariant.set(arm.label, {
          audience: await classifyAudience(tx, arm.rules, armWhere(arm, where)),
          estimate: null,
        });
      }
      audience = sumBreakdowns([...perVariant.values()].map((v) => v.audience));
      if (audience.eligible === 0)
        problems.push('No contact in this audience can receive the campaign now.');
      else if (withVariants) {
        for (const arm of r.arms) {
          if (perVariant.get(arm.label)?.audience.eligible === 0)
            problems.push(emptyVariantProblem(arm.label));
        }
      }
      const currency = c.budgetCurrency ?? settings.costCurrency;
      if (currency && audience.eligible > 0) {
        const table = await loadRateTable(tx, currency, r.schedule?.at ?? now);
        if (table) {
          for (const arm of r.arms) {
            const entry = perVariant.get(arm.label);
            if (!entry) continue;
            entry.estimate = estimateFromTable(
              table,
              arm.template.category,
              await eligiblePhones(tx, arm.rules, armWhere(arm, where)),
            );
          }
          estimate = combineEstimates(
            [...perVariant.values()].flatMap((v) => (v.estimate ? [v.estimate] : [])),
          );
        }
      }
    }
  }
  // The audience's own count, in this transaction under the company's scope (ADR-400): every
  // variant's recipients, as the number sends them all.
  let messagingLimit: CampaignMessagingLimitNotice | null = null;
  if (r.channel && audience) {
    const number = await loadNumberMessagingLimit(tx, company.id, r.channel.id);
    if (number) messagingLimit = campaignMessagingLimitNotice(number, audience.eligible);
  }
  const marketing = r.variants.some((v) => v.template?.category === 'MARKETING');
  return {
    problems,
    audience,
    estimate,
    costCurrency: c.budgetCurrency ?? settings.costCurrency,
    scheduledAt: r.schedule?.at ?? null,
    adjustment: r.schedule?.adjustment ?? null,
    approvalRequired: settings.approvalRequired,
    frequencyCap:
      settings.capCount && settings.capDays && marketing
        ? { count: settings.capCount, days: settings.capDays }
        : null,
    messagingLimit,
    variants: withVariants
      ? r.variants.map((v) => ({
          label: v.label,
          templateId: v.template?.id ?? null,
          templateName: v.template?.name ?? null,
          category: v.template?.category ?? null,
          sharePercent: v.sharePercent,
          audience: perVariant.get(v.label)?.audience ?? null,
          estimate: perVariant.get(v.label)?.estimate ?? null,
        }))
      : null,
  };
}

// Counted in one statement in ./results (ADR-150); exported here as before.
export { campaignAnalytics, type CampaignAnalytics, type CampaignVariantAnalytics };

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
  return {
    data,
    window,
    variables: variables.data,
    scheduledLocal,
    budget: toBudget(data.budget),
    variants: prepareVariantsChange(data),
  };
}
export type PreparedCampaignDraft = ReturnType<typeof prepareCampaignDraft>;

/** A draft's variant after A, its mapping checked as A's is. */
export interface PreparedVariant {
  templateId: string | null;
  variables: CampaignVariables;
  sharePercent: number;
}

/**
 * How a draft's variants after A change (ADR-405, ADR-410): kept (left out), replaced in full by
 * `variants` (B first; empty removes them), or B alone set by `variantB`, the variants after it
 * kept (so a client of ADR-405 that edits B never drops C to E). `variantB: null` removes them all,
 * as a C without B would leave a gap.
 */
export type VariantsChange =
  | { kind: 'keep' }
  | { kind: 'replace'; variants: PreparedVariant[] }
  | { kind: 'setB'; variant: PreparedVariant };

function prepareVariantsChange(
  data: Pick<CampaignDraftInput, 'variantB' | 'variants'>,
): VariantsChange {
  if (data.variantB !== undefined && data.variants !== undefined)
    throw new AppError('validation_failed', 'Give either variantB or variants, not both.');
  const prepare = (
    v: NonNullable<CampaignDraftInput['variantB']>,
    label: VariantLabel,
  ): PreparedVariant => {
    const parsed = campaignVariablesSchema.safeParse(v.variables ?? {});
    if (!parsed.success)
      throw new AppError(
        'validation_failed',
        `Variant ${label}: Choose a value for every template variable.`,
      );
    return { templateId: v.templateId, variables: parsed.data, sharePercent: v.sharePercent };
  };
  if (data.variants !== undefined) {
    const variants = (data.variants ?? []).map((v, i) => prepare(v, variantLabelAt(i)));
    const problem = variantSetProblem(variants.map((v) => v.sharePercent));
    if (problem) throw new AppError('validation_failed', problem);
    return { kind: 'replace', variants };
  }
  if (data.variantB === null) return { kind: 'replace', variants: [] };
  if (data.variantB) return { kind: 'setB', variant: prepare(data.variantB, 'B') };
  return { kind: 'keep' };
}

/**
 * Writes a prepared draft to a campaign the caller locked and found to be a draft (members also
 * compare the version they saw): its number, template and segment must be the company's (a segment
 * not archived) and conditions must pass segments' rules, and the version goes up. The caller
 * records the campaign event and the audit (ADR-186). `variantsLimit` is the most variants this web
 * server lets a draft reach (ADR-410).
 */
export async function writeLockedCampaignDraft(
  tx: Tx,
  tenantId: string,
  campaignId: string,
  draft: PreparedCampaignDraft,
  variantsLimit: number = DEFAULT_VARIANTS_LIMIT,
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
  await writeLockedCampaignVariants(tx, tenantId, campaignId, draft.variants, variantsLimit);
}

/**
 * The variants after A a draft would have once `change` applies to the `stored` ones (ADR-410),
 * and why that is refused, if it is: the shares must leave A at least 10%, and a draft may not grow
 * past `limit` variants (this web server's `CAMPAIGN_VARIANTS_MAX`), though one that already has
 * more (made before the limit was lowered for a rollback) can still be edited or trimmed.
 */
export function nextCampaignVariants(
  stored: readonly StoredCampaignVariant[],
  change: Exclude<VariantsChange, { kind: 'keep' }>,
  limit: number,
): { variants: PreparedVariant[]; problem: string | null } {
  const variants =
    change.kind === 'replace'
      ? change.variants
      : [change.variant, ...stored.filter((v) => v.label !== 'B')];
  const problem = variantSetProblem(variants.map((v) => v.sharePercent));
  if (problem) return { variants, problem };
  if (variants.length + 1 > limit && variants.length > stored.length)
    return { variants, problem: variantLimitProblem(limit) };
  return { variants, problem: null };
}

/**
 * Writes a draft's variants after A (ADR-405, ADR-410) in the transaction that writes the draft:
 * left out they stay as they are; otherwise they become `nextCampaignVariants`, labelled B, C, … in
 * order, each template the company's own (another company's template id is not found, as for A),
 * and rows past the last label are removed.
 */
async function writeLockedCampaignVariants(
  tx: Tx,
  tenantId: string,
  campaignId: string,
  change: VariantsChange,
  limit: number,
): Promise<void> {
  if (change.kind === 'keep') return;
  const stored = await loadCampaignVariants(tx, tenantId, campaignId);
  const { variants, problem } = nextCampaignVariants(stored, change, limit);
  if (problem) throw new AppError('validation_failed', problem);
  for (const variant of variants) {
    if (variant.templateId && !(await loadTemplate(tx, tenantId, variant.templateId)))
      throw notFound('Template');
  }
  const labels = variants.map((_, i) => variantLabelAt(i));
  await tx
    .delete(campaignVariants)
    .where(
      and(
        eq(campaignVariants.tenantId, tenantId),
        eq(campaignVariants.campaignId, campaignId),
        ...(labels.length > 0 ? [notInArray(campaignVariants.label, labels)] : []),
      ),
    );
  for (const [i, variant] of variants.entries()) {
    await tx
      .insert(campaignVariants)
      .values({
        id: uuidv7(),
        tenantId,
        campaignId,
        label: variantLabelAt(i),
        templateId: variant.templateId,
        variables: variant.variables,
        sharePercent: variant.sharePercent,
      })
      .onConflictDoUpdate({
        target: [campaignVariants.tenantId, campaignVariants.campaignId, campaignVariants.label],
        set: {
          templateId: variant.templateId,
          variables: variant.variables,
          sharePercent: variant.sharePercent,
          updatedAt: sql`now()`,
        },
      });
  }
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
  /** Variant A's (the campaign's own template's) category. */
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  /**
   * Each variant's label, template category and share (ADR-405, ADR-410), for the audit; null
   * without variants. No template names, as audits record none.
   */
  variants:
    { label: VariantLabel; category: TemplateInfo['category']; sharePercent: number }[] | null;
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
  if (!r.arms || !r.where || !r.schedule || !r.definition || !r.template)
    throw new Error('Readiness without an audience');
  const total = await countAudience(tx, r.where);
  if (total > MAX_AUDIENCE)
    throw new AppError(
      'precondition_failed',
      `This audience has ${total} contacts; campaigns are limited to ${MAX_AUDIENCE}.`,
    );
  // Each recipient is given its variant here, once, from the hash of the campaign and the contact
  // (ADR-405), and classified by its variant's template's rules.
  const snapshot = await insertSnapshot(tx, c.id, r.arms, r.where);
  if (snapshot.pending === 0)
    throw new AppError(
      'precondition_failed',
      'No contact in this audience can receive the campaign now.',
    );
  const withVariants = r.arms.length > 1;
  if (withVariants) {
    for (const arm of r.arms) {
      if ((snapshot.byVariant[arm.label]?.pending ?? 0) === 0)
        throw new AppError('precondition_failed', emptyVariantProblem(arm.label));
    }
  }
  const member = 'userId' in by ? by.userId : null;
  const key = 'apiKeyId' in by ? by.apiKeyId : null;
  await recordCampaignEvent(tx, company.id, c.id, 'submitted', member, {
    ...(key ? { apiKeyId: key } : {}),
    audience: snapshot.total,
    pending: snapshot.pending,
    skipped: snapshot.skipped,
    ...(withVariants
      ? {
          variants: Object.fromEntries(
            r.arms.map((arm) => [
              arm.label,
              {
                share: arm.sharePercent,
                pending: snapshot.byVariant[arm.label]?.pending ?? 0,
                skipped: snapshot.byVariant[arm.label]?.skipped ?? 0,
              },
            ]),
          ),
        }
      : {}),
  });
  return {
    snapshot,
    schedule: r.schedule,
    category: r.template.category,
    variants: withVariants
      ? r.arms.map((arm) => ({
          label: arm.label,
          category: arm.template.category,
          sharePercent: arm.sharePercent,
        }))
      : null,
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
 * Until when a campaign waiting for approval can be approved (ADR-209): the end of its sending
 * period, counted from when it was set to start, which for a campaign that starts at once is its
 * submission. Approving it later is refused: it has to be sent back and scheduled again.
 */
export function campaignApprovalDeadline(scheduledAt: Date, stopAfterHours: number): Date {
  return new Date(scheduledAt.getTime() + stopAfterHours * 3_600_000);
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
  /** Until when it can be approved (ADR-209), or null when that is not known. */
  approveBy: Date | null;
  /** The campaign's time zone, the one its page shows its schedule in. */
  timeZone: string;
  /** Its variants, A to E, with their templates, shares and pending recipients; none without. */
  variants?: readonly {
    label: VariantLabel;
    templateName: string;
    sharePercent: number;
    pending: number;
  }[];
}): { subject: string; lines: string[] } {
  const count = (n: number) => n.toLocaleString('en-IN');
  const variants = input.variants ?? [];
  const by =
    input.submitter.kind === 'key' ? `The API key “${input.submitter.name}”` : input.submitter.name;
  return {
    subject: `Campaign “${input.campaignName}” waits for your approval`,
    lines: [
      `${by} submitted the campaign “${input.campaignName}”, and it waits for a member's approval.`,
      `It would be sent to ${count(input.pending)} of the ${count(input.total)} ${input.total === 1 ? 'contact' : 'contacts'} in its audience.`,
      // Template names can be long: the line is split as long notes are.
      ...(variants.length > 1
        ? splitEmailText(
            `It tests ${variants.length} templates side by side: ${variants
              .map(
                (v) =>
                  `${v.label} “${v.templateName}” (${v.sharePercent}% of the audience) to ${count(v.pending)} ${v.pending === 1 ? 'contact' : 'contacts'}`,
              )
              .join(
                '; ',
              )}. Approving it approves ${variants.length === 2 ? 'both' : `all ${variants.length}`}; its page shows each variant's template and counts, and picks no winner.`,
            NOTICE_LINE_MAX.tenant,
          )
        : []),
      input.startsAt
        ? `Once approved, it starts at ${formatCompanyTime(input.startsAt, input.timeZone)}, or at once if that time has passed.`
        : 'Once approved, it starts at once.',
      ...(input.approveBy
        ? [
            `It can be approved until ${formatCompanyTime(input.approveBy, input.timeZone)}, when its sending period ends; after that it has to be sent back and scheduled again.`,
          ]
        : []),
      input.submitter.kind === 'key'
        ? 'Approving it needs permission to send campaigns, as it then sends under your authority. You can also send it back with a note.'
        : 'Approve it, or send it back with a note, on its page.',
    ],
  };
}

/**
 * A submitted campaign's variants as the approval email names them (ADR-405): each template, share
 * and pending recipients from the frozen audience; empty for a campaign without variants.
 */
async function approvalVariants(
  tx: Tx,
  tenantId: string,
  campaignId: string,
): Promise<{ label: VariantLabel; templateName: string; sharePercent: number; pending: number }[]> {
  const [c] = await tx
    .select({ id: campaigns.id, templateId: campaigns.templateId, variables: campaigns.variables })
    .from(campaigns)
    .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, campaignId)));
  if (!c) return [];
  const plans = await campaignVariantPlans(tx, tenantId, c);
  if (plans.length < 2) return [];
  const counts = await pendingByVariant(tx, tenantId, campaignId);
  return plans.map((p) => ({
    label: p.label,
    templateName: p.template?.name ?? 'a template no longer available',
    sharePercent: p.sharePercent,
    pending: counts.get(p.label) ?? 0,
  }));
}

/**
 * A campaign's pending recipients by variant (ADR-405). With variants, a variant's template is
 * checked (by the runner, a resume and an approval) only while the variant has pending recipients,
 * so a finished variant never holds the others back.
 */
export async function pendingByVariant(
  tx: Tx,
  tenantId: string,
  campaignId: string,
): Promise<Map<string, number>> {
  const rows = await tx
    .select({ variant: campaignRecipients.variant, n: sql<number>`count(*)::int` })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.tenantId, tenantId),
        eq(campaignRecipients.campaignId, campaignId),
        eq(campaignRecipients.state, 'pending'),
      ),
    )
    .groupBy(campaignRecipients.variant);
  return new Map(rows.map((r) => [r.variant, Number(r.n)]));
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
      stopAfterHours: campaigns.stopAfterHours,
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
    .select({
      userId: users.id,
      email: users.email,
      roles: memberships.roles,
      optOuts: memberships.emailOptOuts,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.status, 'active')))
    .orderBy(users.id);
  const approvers = members.filter((m) => {
    const granted = permissionsForRoles(m.roles as TenantRole[]);
    return (
      wantsEmail(m.optOuts, 'campaign_approvals') &&
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
    approveBy: c.scheduledAt ? campaignApprovalDeadline(c.scheduledAt, c.stopAfterHours) : null,
    timeZone: c.timezone,
    variants: await approvalVariants(tx, tenantId, campaignId),
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

/** What an approver did with a member's submission, for the email to that member (ADR-205). */
export type CampaignReviewOutcome = 'approved' | 'rejected' | 'withdrawn';

/**
 * The email to the member who submitted a campaign about what an approver did with it (ADR-205):
 * approved (when it starts, in the campaign's time zone, and that it sends under their authority),
 * sent back with the approver's note, or taken back to a draft. A note is the approver's own words,
 * split into lines as long notes are.
 */
export function campaignReviewNotice(input: {
  campaignName: string;
  outcome: CampaignReviewOutcome;
  /** The member who approved it, sent it back or took it back. */
  reviewer: string;
  note: string | null;
  /** When an approved campaign starts, or null when it starts at once. */
  startsAt: Date | null;
  /** The campaign's time zone, the one its page shows its schedule in. */
  timeZone: string;
}): { subject: string; lines: string[] } {
  const name = `“${input.campaignName}”`;
  const note = input.note
    ? splitEmailText(`Their note: “${input.note}”`, NOTICE_LINE_MAX.tenant)
    : [];
  switch (input.outcome) {
    case 'approved':
      return {
        subject: `Campaign ${name} was approved`,
        lines: [
          `${input.reviewer} approved your campaign ${name}.`,
          input.startsAt
            ? `It starts at ${formatCompanyTime(input.startsAt, input.timeZone)}.`
            : 'It starts now.',
          ...note,
          'It sends under your authority, so it pauses if you leave the company or can no longer send campaigns. You can follow, pause or cancel it on its page.',
        ],
      };
    case 'rejected':
      return {
        subject: `Campaign ${name} was sent back`,
        lines: [
          `${input.reviewer} sent your campaign ${name} back to you as a draft. Nothing was sent.`,
          ...note,
          'Change what is needed, then submit it again for approval.',
        ],
      };
    case 'withdrawn':
      return {
        subject: `Campaign ${name} was taken back to a draft`,
        lines: [
          `${input.reviewer} took your campaign ${name} back to a draft while it waited for approval. Nothing was sent.`,
          'Submit it again when it is ready.',
        ],
      };
  }
}

/**
 * Emails the member who submitted a campaign what an approver did with it (ADR-205), in the same
 * transaction, so a refused approval emails nobody. Nobody is emailed for a key's submission (its
 * integration reads `campaign.status_changed`), when the member acted on their own submission, or
 * when they are no longer an active member. The submitter is passed in, as sending a campaign back
 * clears it. Returns whether it emailed.
 */
export async function emailCampaignSubmitter(
  notices: CampaignNoticeDeps,
  tx: Tx,
  tenant: { id: string; name: string; slug: string },
  campaignId: string,
  review: {
    submittedByUserId: string | null;
    reviewer: { id: string; name: string };
    outcome: CampaignReviewOutcome;
    note: string | null;
    startsAt: Date | null;
  },
): Promise<boolean> {
  const submitterId = review.submittedByUserId;
  if (!submitterId || submitterId === review.reviewer.id) return false;
  const [submitter] = await tx
    .select({ email: users.email, optOuts: memberships.emailOptOuts })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.tenantId, tenant.id),
        eq(memberships.userId, submitterId),
        eq(memberships.status, 'active'),
      ),
    );
  if (!submitter || !wantsEmail(submitter.optOuts, 'campaign_reviews')) return false;
  const [c] = await tx
    .select({ name: campaigns.name, version: campaigns.version, timezone: campaigns.timezone })
    .from(campaigns)
    .where(and(eq(campaigns.tenantId, tenant.id), eq(campaigns.id, campaignId)));
  if (!c) return false;
  const { subject, lines } = campaignReviewNotice({
    campaignName: c.name,
    outcome: review.outcome,
    reviewer: review.reviewer.name,
    note: review.note,
    startsAt: review.startsAt,
    timeZone: c.timezone,
  });
  await enqueueEmail(notices.outbox, tx, {
    to: submitter.email,
    tenantId: tenant.id,
    // Approving, sending back and taking back each raise the version: one email for each.
    dedupeKey: `campaign-review:${campaignId}:${c.version}:${submitterId}`,
    payload: {
      kind: 'tenant.notice',
      companyName: tenant.name,
      subject,
      lines,
      url: new URL(`/c/${tenant.slug}/campaigns/${campaignId}`, notices.appBaseUrl).toString(),
      actionLabel: 'Open campaign',
    },
  });
  return true;
}

/** The pauses HyFib makes by itself, which members are emailed about (ADR-210). */
export type AutomaticPauseReason = Exclude<CampaignPauseReason, 'manual' | 'api'>;

/** Each automatic pause: the end of the email's subject, and why it paused and what to do. */
const AUTOMATIC_PAUSES: Record<AutomaticPauseReason, { subject: string; line: string }> = {
  budget_reached: {
    subject: 'its spending cap was reached',
    line: 'It reached its spending cap. Raise or remove the cap on its page, then resume it.',
  },
  message_cap_reached: {
    subject: 'its message cap was reached',
    line: 'It reached its message cap. Raise or remove the cap on its page, then resume it.',
  },
  template_not_approved: {
    subject: 'its template can no longer be sent',
    line: 'Its template is no longer approved by Meta, or no longer takes the variables the campaign fills in. Resume it once Meta approves the template again; if the template’s variables changed, cancel it and create a new campaign.',
  },
  channel_inactive: {
    subject: 'its WhatsApp number is not active',
    line: 'The WhatsApp number it sends from is not active. An administrator can reconnect it in Settings → Channels; then resume the campaign.',
  },
  launcher_removed: {
    subject: 'another member must resume it',
    line: 'The member whose authority it sent under is no longer an active member of the company. A member who can send campaigns can resume it, and it then sends under their authority.',
  },
  launcher_not_permitted: {
    subject: 'another member must resume it',
    line: 'The member whose authority it sent under can no longer send campaigns. A member who can send campaigns can resume it, and it then sends under their authority.',
  },
  rate_card_missing: {
    subject: 'its costs cannot be checked',
    line: 'No rate card is published for the currency of its spending cap, so its costs cannot be checked against the cap. Resume it once one is published, or remove the cap on its page first.',
  },
};

/**
 * The email that HyFib paused a campaign by itself (ADR-210): why, what a member does about it, and
 * what happens to the messages it has not sent, in the campaign's time zone. No counts: messages
 * still queued at the pause are held back by the send worker, so they would be out of date.
 */
export function campaignPauseNotice(input: {
  campaignName: string;
  reason: AutomaticPauseReason;
  /** When its sending period ends, or null when it had not started. */
  sendUntil: Date | null;
  /** The campaign's time zone, the one its page shows its schedule in. */
  timeZone: string;
}): { subject: string; lines: string[] } {
  const pause = AUTOMATIC_PAUSES[input.reason];
  return {
    subject: `Campaign “${input.campaignName}” paused: ${pause.subject}`,
    lines: [
      `HyFib paused the campaign “${input.campaignName}”, and it sends nothing more until it is resumed.`,
      pause.line,
      input.sendUntil
        ? `Messages that had not gone out yet wait until it is resumed. Its sending period ends at ${formatCompanyTime(input.sendUntil, input.timeZone)}, and contacts it has not sent to by then are skipped.`
        : 'It had not started, so nothing was sent. Once resumed, it starts at its scheduled time, or at once if that time has passed.',
    ],
  };
}

/**
 * Emails the members who can act on a campaign HyFib paused by itself (ADR-210), in the pause's
 * transaction: the member whose authority it sends under, while they may still send campaigns, as
 * they can resume it; otherwise the active members who may approve and send campaigns (owners and
 * administrators), as one of them must resume it. Members' and keys' own pauses are not emailed.
 * Returns how many it emailed.
 */
export async function emailCampaignPaused(
  notices: CampaignNoticeDeps,
  tx: Tx,
  tenantId: string,
  campaignId: string,
  reason: AutomaticPauseReason,
): Promise<number> {
  const [c] = await tx
    .select({
      name: campaigns.name,
      version: campaigns.version,
      launchedByUserId: campaigns.launchedByUserId,
      deadlineAt: campaigns.deadlineAt,
      timezone: campaigns.timezone,
      company: tenants.name,
      slug: tenants.slug,
    })
    .from(campaigns)
    .innerJoin(tenants, eq(tenants.id, campaigns.tenantId))
    .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, campaignId)));
  if (!c) return 0;
  const members = await tx
    .select({
      userId: users.id,
      email: users.email,
      roles: memberships.roles,
      optOuts: memberships.emailOptOuts,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.status, 'active')))
    .orderBy(users.id);
  const grants = (m: { roles: string[] }) => permissionsForRoles(m.roles as TenantRole[]);
  const launcher = members.find(
    (m) => m.userId === c.launchedByUserId && grants(m).has('campaigns.send'),
  );
  // Who must act, then those of them who did not turn these emails off (ADR-215).
  const recipients = (
    launcher
      ? [launcher]
      : members.filter((m) => grants(m).has('campaigns.approve') && grants(m).has('campaigns.send'))
  ).filter((m) => wantsEmail(m.optOuts, 'campaign_pauses'));
  const { subject, lines } = campaignPauseNotice({
    campaignName: c.name,
    reason,
    sendUntil: c.deadlineAt,
    timeZone: c.timezone,
  });
  const url = new URL(`/c/${c.slug}/campaigns/${campaignId}`, notices.appBaseUrl).toString();
  for (const member of recipients) {
    await enqueueEmail(notices.outbox, tx, {
      to: member.email,
      tenantId,
      // A pause raises the campaign's version: one email per member for each pause.
      dedupeKey: `campaign-paused:${campaignId}:${c.version}:${member.userId}`,
      payload: {
        kind: 'tenant.notice',
        companyName: c.company,
        subject,
        lines,
        url,
        actionLabel: 'Open campaign',
      },
    });
  }
  return recipients.length;
}

/**
 * The email that a campaign finished (ADR-214): every contact in its audience was handed to
 * WhatsApp or skipped, or its sending period ended and those it had not reached were skipped.
 * Counts only, never contacts; deliveries keep arriving after it.
 */
export function campaignCompletionNotice(input: {
  campaignName: string;
  reason: 'all_processed' | 'deadline_passed';
  audience: number;
  queued: number;
  skipped: number;
  /** Contacts skipped because its sending period ended before it reached them. */
  expired: number;
  /** When its sending period ended, for a campaign stopped by it. */
  sendUntil: Date | null;
  timeZone: string;
}): { subject: string; lines: string[] } {
  const count = (n: number) => n.toLocaleString('en-IN');
  const contacts = (n: number) => `${count(n)} ${n === 1 ? 'contact' : 'contacts'}`;
  const name = input.campaignName;
  const ended = input.reason === 'deadline_passed';
  const until = input.sendUntil ? ` at ${formatCompanyTime(input.sendUntil, input.timeZone)}` : '';
  return {
    subject: ended
      ? `Campaign “${name}” ended: its sending period is over`
      : `Campaign “${name}” finished sending`,
    lines: [
      !ended
        ? `The campaign “${name}” finished: every contact in its audience was handed to WhatsApp or skipped.`
        : input.expired === 0
          ? `The sending period of the campaign “${name}” ended${until}, after every contact in its audience was handed to WhatsApp or skipped.`
          : `The sending period of the campaign “${name}” ended${until}, so the ${contacts(input.expired)} it had not reached ${input.expired === 1 ? 'was' : 'were'} skipped.`,
      `It handed ${count(input.queued)} ${input.queued === 1 ? 'message' : 'messages'} to WhatsApp and skipped ${count(input.skipped)} of the ${contacts(input.audience)} in its audience; its page says why each was skipped.`,
      'WhatsApp keeps reporting deliveries, reads and replies after this, and its page shows them as they arrive.',
    ],
  };
}

/**
 * Emails the member a finished campaign sent under (ADR-214), in the transaction that completes
 * it, while they are an active member. A cancelled campaign emails nobody: a member or key did it.
 * Returns whether it emailed.
 */
export async function emailCampaignCompleted(
  notices: CampaignNoticeDeps,
  tx: Tx,
  tenantId: string,
  campaignId: string,
  reason: 'all_processed' | 'deadline_passed',
): Promise<boolean> {
  const [c] = await tx
    .select({
      name: campaigns.name,
      version: campaigns.version,
      launchedByUserId: campaigns.launchedByUserId,
      audienceCount: campaigns.audienceCount,
      queuedCount: campaigns.queuedCount,
      skippedCount: campaigns.skippedCount,
      deadlineAt: campaigns.deadlineAt,
      timezone: campaigns.timezone,
      company: tenants.name,
      slug: tenants.slug,
      expired: sql<number>`(select count(*)::int from app.campaign_recipients r
        where r.tenant_id = ${campaigns.tenantId} and r.campaign_id = ${campaigns.id}
          and r.state = 'skipped' and r.skip_reason = 'expired')`,
    })
    .from(campaigns)
    .innerJoin(tenants, eq(tenants.id, campaigns.tenantId))
    .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, campaignId)));
  if (!c?.launchedByUserId) return false;
  const [member] = await tx
    .select({ userId: users.id, email: users.email, optOuts: memberships.emailOptOuts })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.userId, c.launchedByUserId),
        eq(memberships.status, 'active'),
      ),
    );
  if (!member || !wantsEmail(member.optOuts, 'campaign_completions')) return false;
  const { subject, lines } = campaignCompletionNotice({
    campaignName: c.name,
    reason,
    audience: c.audienceCount,
    queued: c.queuedCount,
    skipped: c.skippedCount,
    expired: c.expired,
    sendUntil: c.deadlineAt,
    timeZone: c.timezone,
  });
  await enqueueEmail(notices.outbox, tx, {
    to: member.email,
    tenantId,
    dedupeKey: `campaign-completed:${campaignId}:${c.version}:${member.userId}`,
    payload: {
      kind: 'tenant.notice',
      companyName: c.company,
      subject,
      lines,
      url: new URL(`/c/${c.slug}/campaigns/${campaignId}`, notices.appBaseUrl).toString(),
      actionLabel: 'Open campaign',
    },
  });
  return true;
}

// Service ----------------------------------------------------------------------------------------

export function createCampaignsService(deps: CampaignDeps) {
  const { db, clock } = deps;
  const variantsLimit = deps.variantsLimit ?? DEFAULT_VARIANTS_LIMIT;

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
          // A submitted campaign not yet finished: its number's limit against its frozen audience
          // less those skipped (ADR-400). A draft's comes with its review.
          const number =
            SUBMITTED_NOTICE_STATUSES.includes(c.status) && c.channelAccountId
              ? await loadNumberMessagingLimit(tx, ctx.tenant.id, c.channelAccountId)
              : null;
          // The variants after A (B to E) and, once submitted, each variant's results side by side
          // (ADR-405, ADR-410).
          const variants = [];
          for (const v of await loadCampaignVariants(tx, ctx.tenant.id, campaignId)) {
            const t = await loadTemplate(tx, ctx.tenant.id, v.templateId);
            variants.push({
              label: v.label,
              templateId: v.templateId,
              variables: v.variables,
              sharePercent: v.sharePercent,
              template: t
                ? {
                    id: t.id,
                    name: t.name,
                    language: t.language,
                    category: t.category,
                    status: t.status,
                  }
                : null,
            });
          }
          const variantResults =
            variants.length > 0 && c.status !== 'draft'
              ? await campaignVariantAnalytics(tx, ctx.tenant.id, campaignId, [
                  'A',
                  ...variants.map((v) => v.label),
                ])
              : null;
          return {
            /** Variant B as ADR-405 gave it (see `variants` for every variant after A). */
            variantB: variants.find((v) => v.label === 'B') ?? null,
            variants,
            variantResults,
            /** The most variants this web server lets the draft reach (ADR-410). */
            variantsLimit,
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
                        buttonParams: template.spec.buttonParams,
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
            messagingLimit: number
              ? campaignMessagingLimitNotice(number, submittedCampaignRecipients(c))
              : null,
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
          variables: { header: [], body: [], buttons: [] },
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
      if (draft.data.audience.kind === 'conditions') {
        assertCanUseDefinition(
          ctx,
          parseInput(segmentDefinitionSchema, draft.data.audience.definition),
        );
      }
      return db.run(ctx.scope, async (tx) => {
        const c = await lockCampaign(tx, ctx.tenant.id, campaignId);
        if (c.status !== 'draft') throw new AppError('conflict', DRAFTS_ONLY);
        if (c.version !== expectedVersion)
          throw new AppError(
            'conflict',
            'Someone else changed this campaign. Reload the page to see their version.',
          );
        await writeLockedCampaignDraft(tx, ctx.tenant.id, campaignId, draft, variantsLimit);
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
              ...(submission.variants ? { variants: submission.variants } : {}),
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
        // Every variant is approved together (ADR-405, ADR-410), each checked while it has pending
        // recipients (a variant that got none, as from a web server of a release before, is
        // ignored).
        await assertVariantTemplatesApproved(tx, c, 'is no longer');
        const scheduled = c.scheduledAt ?? now;
        if (campaignApprovalDeadline(scheduled, c.stopAfterHours).getTime() <= now.getTime()) {
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
        await emailCampaignSubmitter(deps.notices, tx, ctx.tenant, campaignId, {
          submittedByUserId: c.submittedByUserId,
          reviewer: ctx.user,
          outcome: 'approved',
          note: note ?? null,
          startsAt: at.getTime() === now.getTime() ? null : at,
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
        await emailCampaignSubmitter(deps.notices, tx, ctx.tenant, campaignId, {
          submittedByUserId: c.submittedByUserId,
          reviewer: ctx.user,
          outcome: 'rejected',
          note,
          startsAt: null,
        });
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
        await emailCampaignSubmitter(deps.notices, tx, ctx.tenant, campaignId, {
          submittedByUserId: c.submittedByUserId,
          reviewer: ctx.user,
          outcome: 'withdrawn',
          note: null,
          startsAt: null,
        });
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
      const { phones, variant } = parseInput(testSendSchema, input);
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
          // A test of variant B to E sends its template with its mapping (ADR-405, ADR-410).
          const other =
            variant === 'A'
              ? null
              : ((await loadCampaignVariants(tx, ctx.tenant.id, campaignId)).find(
                  (v) => v.label === variant,
                ) ?? null);
          if (variant !== 'A' && !other?.templateId)
            throw new AppError(
              'precondition_failed',
              `Choose variant ${variant}’s template first.`,
            );
          const templateId = other?.templateId ?? c.templateId;
          const template = await loadTemplate(tx, ctx.tenant.id, templateId);
          if (!template?.spec.supported)
            throw new AppError('precondition_failed', 'Choose an approved template first.');
          const variables = other ? other.variables : readCampaignVariables(c.variables);
          const spec = variableSpec(template.spec);
          const problem = checkVariables(
            variables,
            spec,
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
          return { c, templateId, variables, links: spec.links, people };
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
        const resolved = resolveVariables(prepared.variables, person, prepared.links);
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
            templateId: prepared.templateId,
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
          ...(variant !== 'A' ? { variant } : {}),
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
      const { res, withVariants } = await db.run(
        ctx.scope,
        async (tx) => ({
          // Whether the campaign has variants (ADR-405), so the page names each recipient's.
          withVariants: (await loadCampaignVariants(tx, ctx.tenant.id, campaignId)).length > 0,
          res: await tx.execute<{
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
            variant: string;
          }>(sql`
            select r.id, r.contact_id, c.display_name, c.phone_e164, r.state, r.skip_reason,
                   m.status as message_status, m.error_code, r.queued_at, r.replied_at, r.opted_out_at,
                   r.variant
              from app.campaign_recipients r
              join app.contacts c on c.tenant_id = r.tenant_id and c.id = r.contact_id
              left join app.messages m on m.tenant_id = r.tenant_id and m.id = r.message_id
             where r.tenant_id = ${ctx.tenant.id} and r.campaign_id = ${campaignId}
               ${outcome[q.filter] ? sql`and ${outcome[q.filter]}` : sql``}
               ${after ? sql`and r.id > ${after}::uuid` : sql``}
             order by r.id
             limit 51`),
        }),
        { accessMode: 'read only' },
      );
      const items = res.rows.slice(0, 50);
      return {
        withVariants,
        items: items.map((r) => ({
          id: r.id,
          contactId: r.contact_id,
          displayName: r.display_name,
          phoneE164: shownNumber(ctx, r.phone_e164),
          state: r.state,
          skipReason: r.skip_reason,
          messageStatus: r.message_status,
          errorCode: r.error_code,
          queuedAt: r.queued_at ? new Date(r.queued_at) : null,
          repliedAt: r.replied_at ? new Date(r.replied_at) : null,
          optedOutAt: r.opted_out_at ? new Date(r.opted_out_at) : null,
          variant: r.variant,
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
          // Added last (ADR-405), so columns read by position keep their place.
          'variant',
        ]);
      let after: string | null = null;
      for (;;) {
        const res: { rows: Record<string, string | number | null>[] } = await db.run(
          ctx.scope,
          (tx) =>
            tx.execute<Record<string, string | number | null>>(sql`
              select r.id, c.phone_e164, c.display_name, r.state, r.skip_reason, m.status,
                     m.error_code, r.queued_at, r.replied_at, r.opted_out_at, r.market,
                     r.estimated_cost_micros, r.variant
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
            // Numbers as the member may see them (ADR-226).
            shownNumber(ctx, r.phone_e164 as string | null),
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
            r.variant as string,
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
