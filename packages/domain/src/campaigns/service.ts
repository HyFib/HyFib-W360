import { z } from 'zod';
import { AppError, forbidden, isAppError, notFound, uuidv7, type Clock } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
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
  messageTemplates,
  messagingSettings,
  rateCards,
  segments,
  sql,
  users,
  type CampaignEventType,
  type CampaignStatus,
  type Database,
  type SkipReason,
  type SQL,
  type Tx,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { recordAudit, type RequestMeta } from '../audit';
import {
  consentPurposeFor,
  DEFAULT_MESSAGING_SETTINGS,
  loadMessagingSettings,
} from '../consent/service';
import { CSV_BOM, csvLine } from '../contacts/csv';
import { normalizePhone } from '../contacts/phone';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { STATUS_RANK } from '../messaging/status';
import { queueTemplateMessage } from '../messaging/outbound';
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
import { RECIPIENT_OUTCOME_SQL } from './outcomes';
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

async function lockCampaign(tx: Tx, tenantId: string, campaignId: string): Promise<CampaignRow> {
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
  ctx: TenantContext,
  c: CampaignRow,
  now: Date,
): Promise<Readiness> {
  const problems: string[] = [];
  const channel = await loadChannel(tx, ctx.tenant.id, c.channelAccountId);
  if (!channel) problems.push('Choose the WhatsApp number to send from.');
  else if (channel.status !== 'active')
    problems.push('The chosen WhatsApp number is not active. Reconnect it in Settings → Channels.');
  const template = await loadTemplate(tx, ctx.tenant.id, c.templateId);
  if (!template) problems.push('Choose an approved template.');
  else {
    if (template.status !== 'approved') problems.push('The template is not approved by Meta.');
    if (channel && template.whatsappAccountId !== channel.whatsappAccountId)
      problems.push('The template belongs to another WhatsApp account than the chosen number.');
    if (!template.spec.supported) problems.push(template.spec.reason);
    else {
      const fields = await loadFieldTypes(tx, ctx.tenant.id);
      const problem = checkVariables(
        readCampaignVariables(c.variables),
        template.spec,
        new Set(fields.keys()),
      );
      if (problem) problems.push(problem);
    }
  }
  const def = await currentDefinition(tx, ctx.tenant.id, c);
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
    const settings = await loadMessagingSettings(tx, ctx.tenant.id);
    rules = {
      tenantId: ctx.tenant.id,
      whatsappAccountId: channel.whatsappAccountId,
      purpose: consentPurposeFor(template.category),
      requireMarketingOptIn: settings.requireMarketingOptIn,
      requiredFields: fieldsWithoutFallback(readCampaignVariables(c.variables)),
    };
    where = segmentWhere(
      ctx.tenant.id,
      def.definition,
      ctx.tenant.timezone,
      await loadFieldTypes(tx, ctx.tenant.id),
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

export interface CampaignAnalytics {
  audience: number;
  pending: number;
  skipped: number;
  canceled: number;
  queued: number;
  inProgress: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  unknown: number;
  messageCanceled: number;
  replied: number;
  optedOut: number;
  estimateMicros: number;
  estimateMissing: number;
  skipReasons: { reason: SkipReason; count: number }[];
  failureCodes: { code: string; count: number }[];
}

export async function campaignAnalytics(
  tx: Tx,
  tenantId: string,
  campaignId: string,
): Promise<CampaignAnalytics> {
  const o = RECIPIENT_OUTCOME_SQL;
  const res = await tx.execute<Record<string, number | string | null>>(sql`
    select count(*)::int as audience,
      (count(*) filter (where ${o.pending}))::int as pending,
      (count(*) filter (where ${o.skipped}))::int as skipped,
      (count(*) filter (where ${o.canceled}))::int as canceled,
      (count(*) filter (where ${o.queued}))::int as queued,
      (count(*) filter (where ${o.in_progress}))::int as in_progress,
      (count(*) filter (where ${o.sent}))::int as sent,
      (count(*) filter (where ${o.delivered}))::int as delivered,
      (count(*) filter (where ${o.read}))::int as read,
      (count(*) filter (where ${o.failed}))::int as failed,
      (count(*) filter (where ${o.unknown}))::int as unknown,
      (count(*) filter (where ${o.message_canceled}))::int as message_canceled,
      (count(*) filter (where ${o.replied}))::int as replied,
      (count(*) filter (where ${o.opted_out}))::int as opted_out,
      coalesce(sum(r.estimated_cost_micros) filter (where r.state = 'queued'), 0)::bigint as estimate_micros,
      (count(*) filter (where r.state = 'queued' and r.estimated_cost_micros is null))::int as estimate_missing
    from app.campaign_recipients r
    left join app.messages m on m.tenant_id = r.tenant_id and m.id = r.message_id
    where r.tenant_id = ${tenantId} and r.campaign_id = ${campaignId}`);
  const row = res.rows[0] ?? {};
  const n = (k: string) => Number(row[k] ?? 0);
  const reasons = await tx
    .select({ reason: campaignRecipients.skipReason, count: sql<number>`count(*)::int` })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.tenantId, tenantId),
        eq(campaignRecipients.campaignId, campaignId),
        eq(campaignRecipients.state, 'skipped'),
      ),
    )
    .groupBy(campaignRecipients.skipReason);
  const failures = await tx.execute<{ code: string | null; count: number }>(sql`
    select m.error_code as code, count(*)::int as count
      from app.campaign_recipients r
      join app.messages m on m.tenant_id = r.tenant_id and m.id = r.message_id
     where r.tenant_id = ${tenantId} and r.campaign_id = ${campaignId} and m.status = 'failed'
     group by m.error_code order by count(*) desc limit 10`);
  return {
    audience: n('audience'),
    pending: n('pending'),
    skipped: n('skipped'),
    canceled: n('canceled'),
    queued: n('queued'),
    inProgress: n('in_progress'),
    sent: n('sent'),
    delivered: n('delivered'),
    read: n('read'),
    failed: n('failed'),
    unknown: n('unknown'),
    messageCanceled: n('message_canceled'),
    replied: n('replied'),
    optedOut: n('opted_out'),
    estimateMicros: n('estimate_micros'),
    estimateMissing: n('estimate_missing'),
    skipReasons: reasons
      .filter((r): r is { reason: SkipReason; count: number } => r.reason !== null)
      .sort((a, b) => b.count - a.count),
    failureCodes: failures.rows.map((r) => ({ code: r.code ?? 'unknown', count: r.count })),
  };
}

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
          const events = await tx
            .select({
              id: campaignEvents.id,
              type: campaignEvents.type,
              detail: campaignEvents.detail,
              occurredAt: campaignEvents.occurredAt,
              actorName: users.name,
            })
            .from(campaignEvents)
            .leftJoin(users, eq(users.id, campaignEvents.actorUserId))
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
      const data = parseInput(updateCampaignSchema, input);
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
      const budget = toBudget(data.budget);
      return db.run(ctx.scope, async (tx) => {
        const c = await lockCampaign(tx, ctx.tenant.id, campaignId);
        if (c.status !== 'draft')
          throw new AppError('conflict', 'Only draft campaigns can be edited.');
        if (c.version !== data.expectedVersion)
          throw new AppError(
            'conflict',
            'Someone else changed this campaign. Reload the page to see their version.',
          );
        if (data.channelAccountId && !(await loadChannel(tx, ctx.tenant.id, data.channelAccountId)))
          throw notFound('WhatsApp number');
        const template = await loadTemplate(tx, ctx.tenant.id, data.templateId);
        if (data.templateId && !template) throw notFound('Template');
        let segmentId: string | null = null;
        let audienceDefinition: SegmentDefinition | null = null;
        if (data.audience.kind === 'segment') {
          const [s] = await tx
            .select({ id: segments.id })
            .from(segments)
            .where(
              and(
                eq(segments.tenantId, ctx.tenant.id),
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
            ctx.tenant.id,
            def,
            await loadFieldTypes(tx, ctx.tenant.id),
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
            variables: variables.data,
            segmentId,
            audienceDefinition,
            timezone: data.schedule.timezone,
            scheduleKind: data.schedule.kind,
            scheduledLocal,
            windowStart:
              window && window.start !== null ? `${formatTimeOfDay(window.start)}:00` : null,
            windowEnd: window && window.end !== null ? `${formatTimeOfDay(window.end)}:00` : null,
            ratePerMinute: data.ratePerMinute,
            maxMessages: data.maxMessages,
            ...budget,
            stopAfterHours: data.stopAfterHours,
            version: sql`${campaigns.version} + 1`,
          })
          .where(and(eq(campaigns.tenantId, ctx.tenant.id), eq(campaigns.id, campaignId)));
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

    /**
     * What submitting would do now: problems that block it, the audience broken down by skip
     * reason, and the estimated cost (an upper bound; see costs.ts).
     */
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
          const r = await evaluateReadiness(tx, ctx, c, now);
          const settings = await loadCampaignSettings(tx, ctx.tenant.id);
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
        const r = await evaluateReadiness(tx, ctx, c, now);
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
        const snapshot = await insertSnapshot(tx, campaignId, r.rules, r.where);
        if (snapshot.pending === 0)
          throw new AppError(
            'precondition_failed',
            'No contact in this audience can receive the campaign now.',
          );
        const settings = await loadCampaignSettings(tx, ctx.tenant.id);
        const submitted = {
          audienceUsed: r.definition,
          audienceCount: snapshot.total,
          skippedCount: snapshot.skipped,
          submittedByUserId: ctx.user.id,
          submittedAt: now,
          reviewNote: null,
        };
        await recordCampaignEvent(tx, ctx.tenant.id, campaignId, 'submitted', ctx.user.id, {
          audience: snapshot.total,
          pending: snapshot.pending,
          skipped: snapshot.skipped,
        });
        if (settings.approvalRequired) {
          await tx
            .update(campaigns)
            .set({
              ...submitted,
              status: 'pending_approval',
              scheduledAt: r.schedule.at,
              scheduleAdjustment: r.schedule.adjustment,
              version: sql`${campaigns.version} + 1`,
            })
            .where(and(eq(campaigns.tenantId, ctx.tenant.id), eq(campaigns.id, campaignId)));
        } else {
          await launch(
            tx,
            ctx,
            c,
            { launcherUserId: ctx.user.id, at: r.schedule.at, adjustment: r.schedule.adjustment },
            submitted,
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
              category: r.template.category,
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

    /** Four-eyes approval: a member other than the submitter, holding `campaigns.approve`. */
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
        if (!c.submittedByUserId) throw new Error('Submitted campaign without submitter');
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
            launcherUserId: c.submittedByUserId,
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
        const released = await releaseQueuedSends(
          tx,
          ctx.tenant.id,
          campaignId,
          { code: 'campaign_paused', message: 'Not sent: the campaign was paused.' },
          now,
        );
        await requeueReleased(tx, ctx.tenant.id, campaignId, released);
        await tx
          .update(campaigns)
          .set({
            status: 'paused',
            pauseReason: 'manual',
            pausedAt: now,
            nextRunAt: null,
            ...recountedCounters(ctx.tenant.id, campaignId),
            version: sql`${campaigns.version} + 1`,
          })
          .where(and(eq(campaigns.tenantId, ctx.tenant.id), eq(campaigns.id, campaignId)));
        await recordCampaignEvent(tx, ctx.tenant.id, campaignId, 'paused', ctx.user.id, {
          reason: 'manual',
          released: released.length,
        });
        await recordAudit(
          tx,
          ctx,
          { action: 'campaign.paused', subjectType: 'campaign', subjectId: campaignId },
          meta,
        );
        return { released: released.length };
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
        const template = await loadTemplate(tx, ctx.tenant.id, c.templateId);
        if (!template || template.status !== 'approved')
          throw new AppError('precondition_failed', 'The template is not approved by Meta.');
        if (template.category === 'MARKETING' && !can(ctx, 'campaigns.send'))
          throw forbidden('Sending marketing templates needs the campaign sending permission.');
        const channel = await loadChannel(tx, ctx.tenant.id, c.channelAccountId);
        if (!channel || channel.status !== 'active')
          throw new AppError('precondition_failed', 'The WhatsApp number is not active.');
        const [counts] = await tx
          .update(campaigns)
          .set(recountedCounters(ctx.tenant.id, campaignId))
          .where(and(eq(campaigns.tenantId, ctx.tenant.id), eq(campaigns.id, campaignId)))
          .returning({
            queuedCount: campaigns.queuedCount,
            spentEstimateMicros: campaigns.spentEstimateMicros,
          });
        if (counts) Object.assign(c, counts);
        if (
          c.pauseReason === 'message_cap_reached' ||
          (c.maxMessages !== null && c.queuedCount >= c.maxMessages)
        )
          throw new AppError(
            'precondition_failed',
            'The message cap is reached. Raise it before resuming.',
          );
        if (
          c.pauseReason === 'budget_reached' ||
          (c.budgetMicros !== null && c.spentEstimateMicros >= c.budgetMicros)
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
            launchedByUserId: ctx.user.id,
            nextRunAt: at,
            version: sql`${campaigns.version} + 1`,
          })
          .where(and(eq(campaigns.tenantId, ctx.tenant.id), eq(campaigns.id, campaignId)));
        await recordCampaignEvent(tx, ctx.tenant.id, campaignId, 'resumed', ctx.user.id);
        await signalCampaignRunner(deps, tx, {
          tenantId: ctx.tenant.id,
          campaignId,
          actorUserId: ctx.user.id,
          at,
        });
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
        const pending = await tx
          .update(campaignRecipients)
          .set({ state: 'canceled' })
          .where(
            and(
              eq(campaignRecipients.tenantId, ctx.tenant.id),
              eq(campaignRecipients.campaignId, campaignId),
              eq(campaignRecipients.state, 'pending'),
            ),
          )
          .returning({ id: campaignRecipients.id });
        const released = await releaseQueuedSends(
          tx,
          ctx.tenant.id,
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
                eq(campaignRecipients.tenantId, ctx.tenant.id),
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
            canceledByUserId: ctx.user.id,
            nextRunAt: null,
            ...recountedCounters(ctx.tenant.id, campaignId),
            version: sql`${campaigns.version} + 1`,
          })
          .where(and(eq(campaigns.tenantId, ctx.tenant.id), eq(campaigns.id, campaignId)));
        await recordCampaignEvent(tx, ctx.tenant.id, campaignId, 'canceled', ctx.user.id, {
          canceledRecipients: pending.length,
          releasedSends: released.length,
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'campaign.canceled',
            subjectType: 'campaign',
            subjectId: campaignId,
            metadata: { canceledRecipients: pending.length, releasedSends: released.length },
          },
          meta,
        );
        return {
          status: 'canceled' as CampaignStatus,
          changed: true,
          canceledRecipients: pending.length,
          releasedSends: released.length,
        };
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
    await tx
      .delete(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.tenantId, ctx.tenant.id),
          eq(campaignRecipients.campaignId, campaignId),
        ),
      );
    await tx
      .update(campaigns)
      .set({
        status: 'draft',
        audienceUsed: null,
        audienceCount: 0,
        skippedCount: 0,
        submittedByUserId: null,
        submittedAt: null,
        scheduledAt: null,
        scheduleAdjustment: null,
        reviewNote: extra.reviewNote ?? null,
        version: sql`${campaigns.version} + 1`,
      })
      .where(and(eq(campaigns.tenantId, ctx.tenant.id), eq(campaigns.id, campaignId)));
  }
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
