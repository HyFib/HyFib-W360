import { z } from 'zod';
import type { Clock } from '@w360/core';
import {
  CSAT_SKIP_REASONS,
  RATE_CATEGORIES,
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  memberships,
  messagingSettings,
  metricDefinitions,
  sql,
  teams,
  users,
  type CsatSkipReason,
  type Database,
  type RateCategory,
  type SQL,
  type TenantRole,
  type Tx,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { permissionsForRoles } from '../authz/permissions';
import { recordAudit, type RequestMeta } from '../audit';
import {
  loadRateTables,
  marketFor,
  microsToMinor,
  minorDigits,
  priceFor,
} from '../campaigns/costs';
import { CSV_BOM, csvLine } from '../contacts/csv';
import {
  DEAL_FIELD_FILTER_MAX_LENGTH,
  dealFieldFilterAudit,
  dealFieldFilterText,
  dealFieldMatch,
  requireDealFieldFilter,
  type ResolvedDealFieldFilter,
} from '../crm/deal-field-filter';
import { loadDealFields } from '../crm/deal-fields';
import { minorToInput } from '../crm/money';
import { loadTeamSchedules, openPeriods, type BusinessCalendars } from '../inbox/business-hours';
import { calendarsOf, hasAnyTarget, loadReplyTargets, type ReplyTargets } from '../inbox/sla';
import { parseInput } from '../validation';
import {
  assertReportDealFilterAllowed,
  reportDealFilter,
  reportExportFilename,
  type ReportDealFilter,
} from './deal-filter';
import { METRIC_DEFINITIONS, type MetricDefinition } from './definitions';
import {
  forecastByMonth,
  forecastMonths,
  readForecastGroups,
  type MonthForecast,
} from '../crm/forecast';
import { resolvePeriod, type ReportPeriod } from './period';

/**
 * Company reports, computed on request from operational tables inside the company's RLS scope and
 * one repeatable-read snapshot, so every number on a page comes from the same moment. Each number
 * follows a persisted definition (ops.metric_definitions, see ./definitions): denominators, time
 * windows, time-zone rules and missing-data semantics. Nothing is extrapolated: what HyFib cannot
 * measure is reported as unavailable, and cost estimates list what they could not price.
 *
 * Reports expose aggregates and member names only (no message content or contact details), so
 * `reports.read` is enough to view them; exports additionally need `reports.export` and are
 * audited. Filtering the deals section by a deal field also needs `crm.read`, since its choices
 * name the company's deal fields and options (ADR-396).
 */

export interface Ratio {
  numerator: number;
  denominator: number;
}

export interface MessagingCounts {
  inbound: number;
  outbound: number;
  byMember: number;
  byCampaign: number;
  byOther: number;
  canceled: number;
  inProgress: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  unknown: number;
}

export interface MessagingDay extends MessagingCounts {
  day: string;
}

export interface MessagingReport {
  totals: MessagingCounts;
  rates: { sent: Ratio; delivered: Ratio; read: Ratio; failure: Ratio };
  days: MessagingDay[];
  failureCodes: { code: string; count: number }[];
}

export interface CostLine {
  category: RateCategory;
  market: string;
  count: number;
  micros: number;
}

export interface CostReport {
  /** The company's billing currency (Settings → Messaging); null when not chosen. */
  currency: string | null;
  cards: { id: string; effectiveFrom: Date }[];
  /** Delivered outbound messages in the period (the only ones Meta charges). */
  delivered: number;
  /** Meta reported them billable. */
  billable: number;
  /** Meta reported them free (for example inside the free service tier). */
  free: number;
  /** No pricing from Meta yet. */
  notReported: number;
  priced: number;
  totalMicros: number;
  lines: CostLine[];
  unpriced: {
    noCurrency: number;
    noRateCard: number;
    otherCategory: number;
    marketUnknown: number;
    noPrice: number;
  };
}

export interface InboxReport {
  /** The company's first-response target (Settings → Inbox); null without one. */
  targetMinutes: number | null;
  /**
   * Teams with their own first-response target (ADR-377): their conversations are measured against
   * it instead of the company's. By name.
   */
  teamTargets: { teamId: string; name: string; minutes: number }[];
  /** Business hours are on: the target and the business-hours figures count opening hours only. */
  businessHours: boolean;
  /**
   * While business hours are on, the teams with their own (ADR-389): their conversations count
   * business time by the team's weekly schedule instead of the company's. By name.
   */
  teamBusinessHours: { teamId: string; name: string }[];
  /**
   * While business hours are on, the teams with their own closed days (ADR-392): their
   * conversations skip the team's closed days instead of the company's. By name.
   */
  teamClosedDays: { teamId: string; name: string }[];
  now: {
    open: number;
    unassigned: number;
    waiting: number;
    oldestWaitSeconds: number | null;
    windowsClosing: number;
    windowsClosed: number;
    /** Waiting turns past their target (null when neither the company nor a team has one). */
    overTarget: number | null;
    byAssignee: {
      membershipId: string | null;
      name: string | null;
      waiting: number;
      oldestWaitSeconds: number;
    }[];
  };
  turns: {
    started: number;
    answered: number;
    resolvedWithoutReply: number;
    waiting: number;
    medianSeconds: number | null;
    p90Seconds: number | null;
    /** Reply times counting business hours only (null when business hours are off). */
    businessMedianSeconds: number | null;
    businessP90Seconds: number | null;
    buckets: { upTo5m: number; upTo1h: number; upTo24h: number; over24h: number };
    withinTarget: Ratio | null;
  };
  resolution: {
    resolved: number;
    medianSeconds: number | null;
    p90Seconds: number | null;
  };
  days: {
    day: string;
    started: number;
    answered: number;
    resolvedWithoutReply: number;
    waiting: number;
    medianSeconds: number | null;
    businessMedianSeconds: number | null;
    casesResolved: number;
    medianResolutionSeconds: number | null;
  }[];
}

export interface CsatReport {
  enabled: boolean;
  surveys: number;
  sent: number;
  skipped: Record<CsatSkipReason, number>;
  delivered: number;
  answered: number;
  ratings: { best: number; middle: number; worst: number };
  responseRate: Ratio;
  score: Ratio;
  days: {
    day: string;
    surveys: number;
    sent: number;
    skipped: number;
    delivered: number;
    answered: number;
    best: number;
    middle: number;
    worst: number;
  }[];
}

export const AUTOMATION_OUTCOMES = [
  'completed',
  'handed_off',
  'taken_over',
  'stopped',
  'failed',
] as const;
export type AutomationOutcome = (typeof AUTOMATION_OUTCOMES)[number];

export interface AutomationOutcomeCounts {
  started: number;
  active: number;
  completed: number;
  handed_off: number;
  taken_over: number;
  stopped: number;
  failed: number;
}

export interface AutomationReport {
  totals: AutomationOutcomeCounts;
  /** Share of finished runs with each outcome. */
  shares: Record<AutomationOutcome, Ratio>;
  /** Failed runs by reason (budget, closed window, errors). */
  failures: { reason: string; runs: number }[];
  automations: ({ id: string; name: string } & AutomationOutcomeCounts)[];
  days: ({ day: string } & AutomationOutcomeCounts)[];
}

/** Deals closed in the period, per pipeline currency (values are never added across currencies). */
export interface DealAmount {
  currency: string;
  deals: number;
  valueMinor: number;
}

export interface DealReport {
  won: DealAmount[];
  lost: DealAmount[];
  /** Deals won among deals closed (won or lost) in the period. */
  winRate: Ratio;
  /** Median time from creation to win of deals won in the period; null when none was won. */
  medianSecondsToWin: number | null;
  /** Open deals now, by pipeline and stage (pipelines and stages in use). */
  pipelines: {
    id: string;
    name: string;
    currency: string;
    stages: { id: string; name: string; deals: number; valueMinor: number }[];
    /** Its open deals by expected close month, weighed by each stage's chance (ADR-252). */
    forecast: MonthForecast;
  }[];
  /** Closed deals per day and currency (days without any are left out). */
  days: {
    day: string;
    currency: string;
    won: number;
    wonValueMinor: number;
    lost: number;
    lostValueMinor: number;
  }[];
  /**
   * The choice or yes/no field's value every figure above counts deals by (ADR-396), found among
   * the company's fields; null when every deal is counted.
   */
  field: ResolvedDealFieldFilter | null;
}

export interface AgentRow {
  membershipId: string;
  name: string;
  roles: TenantRole[];
  status: string;
  replies: number;
  templates: number;
  turnsAnswered: number;
  medianSeconds: number | null;
  resolved: number;
  /** CSAT answers credited to the member (assignee at resolution) and how many were the best. */
  csatAnswered: number;
  csatBest: number;
}

export interface CampaignFunnelRow {
  id: string;
  name: string;
  status: string;
  startedAt: Date;
  currency: string | null;
  audience: number;
  skipped: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  unknown: number;
  replied: number;
  optedOut: number;
  estimateMicros: number;
  estimateMissing: number;
}

export interface CampaignFunnel {
  rows: CampaignFunnelRow[];
  /** More campaigns started in the period than are listed. */
  truncated: boolean;
}

export interface Report {
  period: ReportPeriod;
  generatedAt: Date;
  messaging: MessagingReport;
  costs: CostReport;
  inbox: InboxReport;
  csat: CsatReport;
  automations: AutomationReport;
  deals: DealReport;
  agents: AgentRow[];
  campaigns: CampaignFunnel;
  /** Latest version of every persisted definition, in registry order. */
  definitions: MetricDefinition[];
}

/**
 * The report as the Reports page reads it: the deals section's filter by a choice or yes/no field
 * too, as the page offers it (ADR-396): the fields to choose from, the filter applied and whether
 * one asked for was not.
 */
export interface ReportPage extends Report {
  dealFilter: ReportDealFilter;
}

export const REPORT_SECTIONS = [
  'messaging',
  'costs',
  'inbox',
  'csat',
  'automations',
  'deals',
  'agents',
  'campaigns',
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export const MAX_FUNNEL_CAMPAIGNS = 100;

const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const num = (v: unknown) => Number(v ?? 0);
const seconds = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const ZERO_COUNTS: MessagingCounts = {
  inbound: 0,
  outbound: 0,
  byMember: 0,
  byCampaign: 0,
  byOther: 0,
  canceled: 0,
  inProgress: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  unknown: 0,
};

async function messagingReport(
  tx: Tx,
  tenantId: string,
  period: ReportPeriod,
): Promise<MessagingReport> {
  const res = await tx.execute<Record<string, string | number>>(sql`
    select to_char(m.created_at at time zone ${period.timezone}, 'YYYY-MM-DD') as day,
      (count(*) filter (where m.direction = 'inbound' and m.sender_type = 'contact'
                          and m.type not in ('reaction', 'system')))::int as inbound,
      (count(*) filter (where m.direction = 'outbound'))::int as outbound,
      (count(*) filter (where m.direction = 'outbound' and m.sender_type = 'agent'))::int as by_member,
      (count(*) filter (where m.direction = 'outbound' and m.sender_type = 'campaign'))::int as by_campaign,
      (count(*) filter (where m.direction = 'outbound'
                          and m.sender_type not in ('agent', 'campaign')))::int as by_other,
      (count(*) filter (where m.direction = 'outbound' and m.status = 'canceled'))::int as canceled,
      (count(*) filter (where m.direction = 'outbound'
                          and m.status in ('queued', 'sending', 'accepted')))::int as in_progress,
      (count(*) filter (where m.direction = 'outbound'
                          and m.status in ('sent', 'delivered', 'read', 'played')))::int as sent,
      (count(*) filter (where m.direction = 'outbound'
                          and m.status in ('delivered', 'read', 'played')))::int as delivered,
      (count(*) filter (where m.direction = 'outbound' and m.status in ('read', 'played')))::int as read,
      (count(*) filter (where m.direction = 'outbound' and m.status = 'failed'))::int as failed,
      (count(*) filter (where m.direction = 'outbound' and m.status = 'unknown_outcome'))::int as unknown
    from app.messages m
    where m.tenant_id = ${tenantId} and m.created_at >= ${ts(period.start)}
      and m.created_at < ${ts(period.end)}
    group by 1`);
  const byDay = new Map(res.rows.map((r) => [String(r.day), r]));
  const days: MessagingDay[] = period.days.map((day) => {
    const r = byDay.get(day);
    return {
      day,
      inbound: num(r?.inbound),
      outbound: num(r?.outbound),
      byMember: num(r?.by_member),
      byCampaign: num(r?.by_campaign),
      byOther: num(r?.by_other),
      canceled: num(r?.canceled),
      inProgress: num(r?.in_progress),
      sent: num(r?.sent),
      delivered: num(r?.delivered),
      read: num(r?.read),
      failed: num(r?.failed),
      unknown: num(r?.unknown),
    };
  });
  const totals = { ...ZERO_COUNTS };
  for (const d of days) {
    for (const key of Object.keys(totals) as (keyof MessagingCounts)[]) totals[key] += d[key];
  }
  const attempted = totals.outbound - totals.canceled;
  const failures = await tx.execute<{ code: string; count: number }>(sql`
    select coalesce(m.error_code, 'unknown') as code, count(*)::int as count
      from app.messages m
     where m.tenant_id = ${tenantId} and m.direction = 'outbound' and m.status = 'failed'
       and m.created_at >= ${ts(period.start)} and m.created_at < ${ts(period.end)}
     group by 1 order by 2 desc, 1 limit 10`);
  return {
    totals,
    rates: {
      sent: { numerator: totals.sent, denominator: attempted },
      delivered: { numerator: totals.delivered, denominator: totals.sent },
      read: { numerator: totals.read, denominator: totals.delivered },
      failure: { numerator: totals.failed + totals.unknown, denominator: attempted },
    },
    days,
    failureCodes: failures.rows.map((r) => ({ code: r.code, count: r.count })),
  };
}

/**
 * Estimated Meta charges: delivered messages (Meta charges per delivered message, research M-065)
 * that Meta's status webhook marked billable (M-076), priced at the list price (tier 0) of the
 * published rate card in force when each message was recorded, by the recipient's market (the
 * number Meta reported delivering to) and Meta's pricing category. Shared by Reports and Billing →
 * Usage and rates (ADR-060); runs in the caller's company-scoped snapshot.
 */
export async function estimateMetaCharges(
  tx: Tx,
  tenantId: string,
  period: ReportPeriod,
  currency: string | null,
): Promise<CostReport> {
  const tables = currency ? await loadRateTables(tx, currency, period.start, period.end) : [];
  const cardFor: SQL =
    tables.length > 0
      ? sql`case ${sql.join(
          tables.map(
            (t) => sql`when m.created_at >= ${ts(t.effectiveFrom)} then ${t.cardId}::text`,
          ),
          sql` `,
        )} else null end`
      : sql`null::text`;
  const res = await tx.execute<{
    card_id: string | null;
    prefix: string | null;
    category: string | null;
    billing: 'none' | 'billable' | 'free';
    n: number;
  }>(sql`
    select ${cardFor} as card_id,
           substring(e.wa_id from 1 for 6) as prefix,
           m.pricing ->> 'category' as category,
           case when m.pricing is null
                  or jsonb_typeof(m.pricing -> 'billable') is distinct from 'boolean' then 'none'
                when m.pricing -> 'billable' = 'true'::jsonb then 'billable'
                else 'free' end as billing,
           count(*)::int as n
      from app.messages m
      left join lateral (
        select se.recipient_wa_id as wa_id from app.message_status_events se
         where se.tenant_id = m.tenant_id and se.message_id = m.id and se.recipient_wa_id is not null
         order by se.provider_timestamp limit 1) e on true
     where m.tenant_id = ${tenantId} and m.direction = 'outbound'
       and m.status in ('delivered', 'read', 'played')
       and m.created_at >= ${ts(period.start)} and m.created_at < ${ts(period.end)}
     group by 1, 2, 3, 4`);
  const byId = new Map(tables.map((t) => [t.cardId, t]));
  const out: CostReport = {
    currency,
    cards: tables.map((t) => ({ id: t.cardId, effectiveFrom: t.effectiveFrom })),
    delivered: 0,
    billable: 0,
    free: 0,
    notReported: 0,
    priced: 0,
    totalMicros: 0,
    lines: [],
    unpriced: { noCurrency: 0, noRateCard: 0, otherCategory: 0, marketUnknown: 0, noPrice: 0 },
  };
  const lines = new Map<string, CostLine>();
  for (const r of res.rows) {
    out.delivered += r.n;
    if (r.billing === 'none') {
      out.notReported += r.n;
      continue;
    }
    if (r.billing === 'free') {
      out.free += r.n;
      continue;
    }
    out.billable += r.n;
    if (!currency) {
      out.unpriced.noCurrency += r.n;
      continue;
    }
    const table = r.card_id ? byId.get(r.card_id) : undefined;
    if (!table) {
      out.unpriced.noRateCard += r.n;
      continue;
    }
    const category = (RATE_CATEGORIES as readonly string[]).includes(r.category ?? '')
      ? (r.category as RateCategory)
      : null;
    if (!category) {
      out.unpriced.otherCategory += r.n;
      continue;
    }
    const market = r.prefix ? marketFor(table, `+${r.prefix}`) : null;
    if (!market) {
      out.unpriced.marketUnknown += r.n;
      continue;
    }
    const price = priceFor(table, market, category);
    if (price === null) {
      out.unpriced.noPrice += r.n;
      continue;
    }
    out.priced += r.n;
    out.totalMicros += price * r.n;
    const key = `${category}|${market}`;
    const line = lines.get(key) ?? { category, market, count: 0, micros: 0 };
    line.count += r.n;
    line.micros += price * r.n;
    lines.set(key, line);
  }
  out.lines = [...lines.values()].sort(
    (a, b) => b.micros - a.micros || a.market.localeCompare(b.market),
  );
  return out;
}

const DURATION = sql`extract(epoch from t.ended_at - t.started_at)`;
const DELIVERED = sql`('delivered', 'read', 'played')`;

/**
 * Business time of [from, to) in seconds, as the overlap with the opening periods of calendar `cal`
 * held in the `iv(cal, lo, hi)` CTE (see openingPeriodsCte): '' for the company's, a team's id for
 * a team's own (ADR-389).
 */
const businessSeconds = (from: SQL, to: SQL, cal: SQL) =>
  sql`(select coalesce(sum(extract(epoch from least(${to}, iv.hi) - greatest(${from}, iv.lo))), 0)::float8
         from iv where iv.cal = ${cal} and iv.lo < ${to} and iv.hi > ${from})`;

/** The opening periods of each calendar between `from` and `to`, keyed as `iv.cal` keys them. */
export function calendarPeriods(
  calendars: BusinessCalendars,
  from: Date,
  to: Date,
): { cal: string; start: Date; end: Date }[] {
  if (!calendars.company) return [];
  const all = [['', calendars.company] as const, ...calendars.teams];
  return all.flatMap(([cal, calendar]) =>
    openPeriods(calendar, from, to).map((p) => ({ cal, start: p.start, end: p.end })),
  );
}

async function openingPeriodsCte(
  tx: Tx,
  tenantId: string,
  calendars: BusinessCalendars,
  period: ReportPeriod,
  now: Date,
): Promise<SQL | null> {
  if (!calendars.company) return null;
  // From the oldest turn the report measures (the period start, or an older waiting turn) to now.
  const oldest = await tx.execute<{ started_ms: number | null }>(sql`
    select (extract(epoch from min(t.started_at)) * 1000)::float8 as started_ms
      from app.conversation_turns t where t.tenant_id = ${tenantId} and t.ended_at is null`);
  const oldestMs = oldest.rows[0]?.started_ms;
  const from =
    oldestMs !== null && oldestMs !== undefined && oldestMs < period.start.getTime()
      ? new Date(oldestMs)
      : period.start;
  // Only the weeks of teams whose conversations have turns the report measures (open, started or
  // ended in the period): every turn scans `iv`, so a week no turn uses would only slow it (ADR-389).
  const used =
    calendars.teams.size === 0
      ? new Set<string>()
      : new Set(
          (
            await tx.execute<{ team_id: string }>(sql`
              select distinct c.team_id::text as team_id
                from app.conversation_turns t
                join app.conversations c on c.tenant_id = t.tenant_id and c.id = t.conversation_id
               where t.tenant_id = ${tenantId} and c.team_id is not null
                 and (t.ended_at is null
                      or (t.started_at >= ${ts(period.start)} and t.started_at < ${ts(period.end)})
                      or (t.ended_at >= ${ts(period.start)} and t.ended_at < ${ts(period.end)}))`)
          ).rows.map((r) => r.team_id),
        );
  const periods = calendarPeriods(
    { ...calendars, teams: new Map([...calendars.teams].filter(([id]) => used.has(id))) },
    from,
    now,
  );
  return sql`iv(cal, lo, hi) as (select * from unnest(
    ${sql.param(periods.map((p) => p.cal))}::text[],
    ${sql.param(periods.map((p) => p.start.toISOString()))}::timestamptz[],
    ${sql.param(periods.map((p) => p.end.toISOString()))}::timestamptz[]))`;
}

async function inboxReport(
  tx: Tx,
  tenantId: string,
  period: ReportPeriod,
  now: Date,
  targets: ReplyTargets,
): Promise<InboxReport> {
  const anyTarget = hasAnyTarget(targets);
  // Each turn's target in seconds: its conversation's team's own (ADR-377), else the company's;
  // null when neither has one. `c` is the conversation and `tm` its team.
  const targetSeconds = sql`(coalesce(tm.first_response_target_minutes,
    ${targets.companyMinutes}::int) * 60)::float8`;
  const teamJoin = sql`left join app.teams tm on tm.tenant_id = c.tenant_id and tm.id = c.team_id`;
  // Each turn's calendar: its conversation's team's own, from its own week (ADR-389) or closed days
  // (ADR-392), else the company's ('').
  const ownCalendars = [...targets.teamCalendars.keys()];
  const cal = sql`(case when c.team_id = any(${sql.param(ownCalendars)}::uuid[])
    then c.team_id::text else '' end)`;
  const iv = await openingPeriodsCte(tx, tenantId, calendarsOf(targets), period, now);
  const withIv = iv ? sql`with ${iv}` : sql``;
  const live = await tx.execute<Record<string, number | null>>(sql`
    ${withIv}
    select
      (select count(*)::int from app.conversations c
        where c.tenant_id = ${tenantId} and c.status in ('open', 'pending')) as open,
      (select count(*)::int from app.conversations c
        where c.tenant_id = ${tenantId} and c.status in ('open', 'pending')
          and c.assigned_membership_id is null) as unassigned,
      count(w.started_at)::int as waiting,
      extract(epoch from ${ts(now)} - min(w.started_at))::float8 as oldest_wait,
      (count(*) filter (where w.last_inbound_at > ${ts(now)} - interval '24 hours'
                          and w.last_inbound_at <= ${ts(now)} - interval '22 hours'))::int as closing,
      (count(*) filter (where w.last_inbound_at is null
                          or w.last_inbound_at <= ${ts(now)} - interval '24 hours'))::int as closed,
      ${
        anyTarget
          ? sql`(count(*) filter (where w.target_s is not null and w.waited >= w.target_s))::int`
          : sql`null::int`
      } as over_target
    from (
      select t.started_at, c.last_inbound_at, ${targetSeconds} as target_s,
             ${iv ? businessSeconds(sql`t.started_at`, ts(now), cal) : sql`extract(epoch from ${ts(now)} - t.started_at)::float8`} as waited
        from app.conversation_turns t
        join app.conversations c on c.tenant_id = t.tenant_id and c.id = t.conversation_id
        ${teamJoin}
       where t.tenant_id = ${tenantId} and t.ended_at is null) w`);
  const l = live.rows[0] ?? {};
  const assignees = await tx.execute<{
    membership_id: string | null;
    name: string | null;
    waiting: number;
    oldest_wait: number;
  }>(sql`
    select c.assigned_membership_id as membership_id, u.name, count(*)::int as waiting,
           extract(epoch from ${ts(now)} - min(t.started_at))::float8 as oldest_wait
      from app.conversation_turns t
      join app.conversations c on c.tenant_id = t.tenant_id and c.id = t.conversation_id
      left join app.memberships ms on ms.tenant_id = c.tenant_id and ms.id = c.assigned_membership_id
      left join auth.users u on u.id = ms.user_id
     where t.tenant_id = ${tenantId} and t.ended_at is null
     group by 1, 2 order by 3 desc, 2 nulls first`);
  // Turns that started in the period, with absolute and (when business hours are on) business
  // reply times, and business waiting time for turns still open.
  const periodTurns = sql`
    select t.started_at, t.ended_at, t.end_reason, ${DURATION}::float8 as dur,
           ${targetSeconds} as target_s,
           ${iv ? sql`case when t.end_reason = 'replied' then ${businessSeconds(sql`t.started_at`, sql`t.ended_at`, cal)} end` : sql`null::float8`} as biz_dur,
           ${
             iv
               ? sql`case when t.ended_at is null then ${businessSeconds(sql`t.started_at`, ts(now), cal)} end`
               : sql`case when t.ended_at is null then extract(epoch from ${ts(now)} - t.started_at)::float8 end`
           } as waited
      from app.conversation_turns t
      join app.conversations c on c.tenant_id = t.tenant_id and c.id = t.conversation_id
      ${teamJoin}
     where t.tenant_id = ${tenantId} and t.started_at >= ${ts(period.start)}
       and t.started_at < ${ts(period.end)}
       -- Turns an automation took over while the customer waited were answered by the automation.
       and t.end_reason is distinct from 'automated'`;
  // A target is met by a reply within it; turns still waiting count once they pass it. Turns of
  // conversations without a target are left out.
  const replyTime = iv ? sql`pt.biz_dur` : sql`pt.dur`;
  const turns = await tx.execute<Record<string, number | null>>(sql`
    ${withIv}
    select count(*)::int as started,
      (count(*) filter (where pt.end_reason = 'replied'))::int as answered,
      (count(*) filter (where pt.end_reason = 'resolved'))::int as resolved,
      (count(*) filter (where pt.ended_at is null))::int as waiting,
      (percentile_cont(0.5) within group (order by pt.dur)
         filter (where pt.end_reason = 'replied'))::float8 as median,
      (percentile_cont(0.9) within group (order by pt.dur)
         filter (where pt.end_reason = 'replied'))::float8 as p90,
      (percentile_cont(0.5) within group (order by pt.biz_dur)
         filter (where pt.end_reason = 'replied'))::float8 as biz_median,
      (percentile_cont(0.9) within group (order by pt.biz_dur)
         filter (where pt.end_reason = 'replied'))::float8 as biz_p90,
      (count(*) filter (where pt.end_reason = 'replied' and pt.dur <= 300))::int as upto_5m,
      (count(*) filter (where pt.end_reason = 'replied' and pt.dur <= 3600))::int as upto_1h,
      (count(*) filter (where pt.end_reason = 'replied' and pt.dur <= 86400))::int as upto_24h,
      ${
        anyTarget
          ? sql`(count(*) filter (where pt.end_reason = 'replied' and pt.target_s is not null
                                    and ${replyTime} <= pt.target_s))::int as within_target,
                (count(*) filter (where pt.target_s is not null
                                    and (pt.end_reason = 'replied'
                                         or (pt.ended_at is null and pt.waited >= pt.target_s))))::int
                  as target_denominator`
          : sql`null::int as within_target, null::int as target_denominator`
      }
    from (${periodTurns}) pt`);
  const p = turns.rows[0] ?? {};
  const daily = await tx.execute<Record<string, string | number | null>>(sql`
    ${withIv}
    select to_char(pt.started_at at time zone ${period.timezone}, 'YYYY-MM-DD') as day,
      count(*)::int as started,
      (count(*) filter (where pt.end_reason = 'replied'))::int as answered,
      (count(*) filter (where pt.end_reason = 'resolved'))::int as resolved,
      (count(*) filter (where pt.ended_at is null))::int as waiting,
      (percentile_cont(0.5) within group (order by pt.dur)
         filter (where pt.end_reason = 'replied'))::float8 as median,
      (percentile_cont(0.5) within group (order by pt.biz_dur)
         filter (where pt.end_reason = 'replied'))::float8 as biz_median
    from (${periodTurns}) pt
    group by 1`);
  const byDay = new Map(daily.rows.map((r) => [String(r.day), r]));
  const resolution = await tx.execute<Record<string, string | number | null>>(sql`
    select to_char(c.resolved_at at time zone ${period.timezone}, 'YYYY-MM-DD') as day,
      count(*)::int as resolved,
      (percentile_cont(0.5) within group (order by extract(epoch from c.resolved_at - c.opened_at)))::float8 as median,
      (percentile_cont(0.9) within group (order by extract(epoch from c.resolved_at - c.opened_at)))::float8 as p90
    from app.conversation_cases c
    where c.tenant_id = ${tenantId} and c.resolved_at >= ${ts(period.start)}
      and c.resolved_at < ${ts(period.end)}
    group by grouping sets ((1), ())`);
  const resolutionTotal = resolution.rows.find((r) => r.day === null);
  const resolutionByDay = new Map(
    resolution.rows.filter((r) => r.day !== null).map((r) => [String(r.day), r]),
  );
  const answered = num(p.answered);
  const upTo5m = num(p.upto_5m);
  const upTo1h = num(p.upto_1h);
  const upTo24h = num(p.upto_24h);
  const teamTargets = await tx
    .select({ teamId: teams.id, name: teams.name, minutes: teams.firstResponseTargetMinutes })
    .from(teams)
    .where(and(eq(teams.tenantId, tenantId), isNotNull(teams.firstResponseTargetMinutes)))
    .orderBy(asc(teams.name), asc(teams.id));
  // Teams whose conversations count business time by their own week (ADR-389) or closed days
  // (ADR-392), while business hours are on. The weeks are read on their own: Drizzle writes the
  // columns of a one-table select's SQL fields without their table, so a subquery there would
  // compare its own columns.
  const ownCalendarTeams =
    ownCalendars.length === 0
      ? []
      : await tx
          .select({ teamId: teams.id, name: teams.name, ownClosedDays: teams.ownClosedDays })
          .from(teams)
          .where(and(eq(teams.tenantId, tenantId), inArray(teams.id, ownCalendars)))
          .orderBy(asc(teams.name), asc(teams.id));
  const ownWeeks = await loadTeamSchedules(tx, tenantId, ownCalendars);
  const named = (r: { teamId: string; name: string }) => ({ teamId: r.teamId, name: r.name });
  return {
    targetMinutes: targets.companyMinutes,
    teamTargets: teamTargets.flatMap((r) =>
      r.minutes === null ? [] : [{ ...r, minutes: r.minutes }],
    ),
    businessHours: iv !== null,
    teamBusinessHours: ownCalendarTeams.filter((r) => ownWeeks.has(r.teamId)).map(named),
    teamClosedDays: ownCalendarTeams.filter((r) => r.ownClosedDays).map(named),
    now: {
      open: num(l.open),
      unassigned: num(l.unassigned),
      waiting: num(l.waiting),
      oldestWaitSeconds: seconds(l.oldest_wait),
      windowsClosing: num(l.closing),
      windowsClosed: num(l.closed),
      overTarget: anyTarget ? num(l.over_target) : null,
      byAssignee: assignees.rows.map((r) => ({
        membershipId: r.membership_id,
        name: r.name,
        waiting: r.waiting,
        oldestWaitSeconds: Number(r.oldest_wait),
      })),
    },
    turns: {
      started: num(p.started),
      answered,
      resolvedWithoutReply: num(p.resolved),
      waiting: num(p.waiting),
      medianSeconds: seconds(p.median),
      p90Seconds: seconds(p.p90),
      businessMedianSeconds: iv ? seconds(p.biz_median) : null,
      businessP90Seconds: iv ? seconds(p.biz_p90) : null,
      buckets: {
        upTo5m,
        upTo1h: upTo1h - upTo5m,
        upTo24h: upTo24h - upTo1h,
        over24h: answered - upTo24h,
      },
      withinTarget: anyTarget
        ? { numerator: num(p.within_target), denominator: num(p.target_denominator) }
        : null,
    },
    resolution: {
      resolved: num(resolutionTotal?.resolved),
      medianSeconds: seconds(resolutionTotal?.median),
      p90Seconds: seconds(resolutionTotal?.p90),
    },
    days: period.days.map((day) => {
      const r = byDay.get(day);
      const res = resolutionByDay.get(day);
      return {
        day,
        started: num(r?.started),
        answered: num(r?.answered),
        resolvedWithoutReply: num(r?.resolved),
        waiting: num(r?.waiting),
        medianSeconds: seconds(r?.median),
        businessMedianSeconds: iv ? seconds(r?.biz_median) : null,
        casesResolved: num(res?.resolved),
        medianResolutionSeconds: seconds(res?.median),
      };
    }),
  };
}

async function csatReport(
  tx: Tx,
  tenantId: string,
  period: ReportPeriod,
  enabled: boolean,
): Promise<CsatReport> {
  const res = await tx.execute<Record<string, string | number | null>>(sql`
    select to_char(s.created_at at time zone ${period.timezone}, 'YYYY-MM-DD') as day,
      count(*)::int as surveys,
      (count(*) filter (where s.skip_reason is null))::int as sent,
      ${sql.join(
        CSAT_SKIP_REASONS.map(
          (reason) =>
            sql`(count(*) filter (where s.skip_reason = ${reason}))::int as ${sql.identifier(`skip_${reason}`)}`,
        ),
        sql`, `,
      )},
      (count(*) filter (where s.skip_reason is null
                          and (s.answered_at is not null or m.status in ${DELIVERED})))::int as delivered,
      (count(*) filter (where s.answered_at is not null))::int as answered,
      (count(*) filter (where s.score = 3))::int as best,
      (count(*) filter (where s.score = 2))::int as middle,
      (count(*) filter (where s.score = 1))::int as worst
    from app.csat_surveys s
    left join app.messages m on m.tenant_id = s.tenant_id and m.id = s.message_id
    where s.tenant_id = ${tenantId} and s.created_at >= ${ts(period.start)}
      and s.created_at < ${ts(period.end)}
    group by grouping sets ((1), ())`);
  const total = res.rows.find((r) => r.day === null) ?? {};
  const byDay = new Map(res.rows.filter((r) => r.day !== null).map((r) => [String(r.day), r]));
  const skipped = Object.fromEntries(
    CSAT_SKIP_REASONS.map((reason) => [reason, num(total[`skip_${reason}`])]),
  ) as Record<CsatSkipReason, number>;
  const answered = num(total.answered);
  return {
    enabled,
    surveys: num(total.surveys),
    sent: num(total.sent),
    skipped,
    delivered: num(total.delivered),
    answered,
    ratings: { best: num(total.best), middle: num(total.middle), worst: num(total.worst) },
    responseRate: { numerator: answered, denominator: num(total.delivered) },
    score: { numerator: num(total.best), denominator: answered },
    days: period.days.map((day) => {
      const r = byDay.get(day);
      return {
        day,
        surveys: num(r?.surveys),
        sent: num(r?.sent),
        skipped: num(r?.surveys) - num(r?.sent),
        delivered: num(r?.delivered),
        answered: num(r?.answered),
        best: num(r?.best),
        middle: num(r?.middle),
        worst: num(r?.worst),
      };
    }),
  };
}

/** Live runs (started by customer messages) that started in the period, by outcome. */
async function automationReport(
  tx: Tx,
  tenantId: string,
  period: ReportPeriod,
): Promise<AutomationReport> {
  const res = await tx.execute<Record<string, string | number | null>>(sql`
    select to_char(r.started_at at time zone ${period.timezone}, 'YYYY-MM-DD') as day,
      r.automation_id, a.name,
      count(*)::int as started,
      (count(*) filter (where r.status in ('running', 'waiting')))::int as active,
      ${sql.join(
        AUTOMATION_OUTCOMES.map(
          (o) => sql`(count(*) filter (where r.status = ${o}))::int as ${sql.identifier(o)}`,
        ),
        sql`, `,
      )}
    from app.automation_runs r
    join app.automations a on a.tenant_id = r.tenant_id and a.id = r.automation_id
    where r.tenant_id = ${tenantId} and r.mode = 'live'
      and r.started_at >= ${ts(period.start)} and r.started_at < ${ts(period.end)}
    group by grouping sets ((1), (2, 3), ())`);
  const failures = await tx.execute<{ reason: string; runs: number }>(sql`
    select r.end_reason as reason, count(*)::int as runs
      from app.automation_runs r
     where r.tenant_id = ${tenantId} and r.mode = 'live' and r.status = 'failed'
       and r.started_at >= ${ts(period.start)} and r.started_at < ${ts(period.end)}
     group by 1 order by 2 desc, 1`);
  const counts = (
    r: Record<string, string | number | null> | undefined,
  ): AutomationOutcomeCounts => ({
    started: num(r?.started),
    active: num(r?.active),
    completed: num(r?.completed),
    handed_off: num(r?.handed_off),
    taken_over: num(r?.taken_over),
    stopped: num(r?.stopped),
    failed: num(r?.failed),
  });
  // Grouping sets: per day (day set), per automation (automation set), and the total (neither).
  const total = res.rows.find((r) => r.day === null && r.automation_id === null);
  const byDay = new Map(res.rows.filter((r) => r.day !== null).map((r) => [String(r.day), r]));
  const totals = counts(total);
  const finished = totals.started - totals.active;
  return {
    totals,
    shares: Object.fromEntries(
      AUTOMATION_OUTCOMES.map((o) => [o, { numerator: totals[o], denominator: finished }]),
    ) as Record<AutomationOutcome, Ratio>,
    failures: failures.rows.map((f) => ({ reason: f.reason, runs: f.runs })),
    automations: res.rows
      .filter((r) => r.automation_id !== null)
      .map((r) => ({ id: String(r.automation_id), name: String(r.name), ...counts(r) }))
      .sort((x, y) => y.started - x.started || x.name.localeCompare(y.name)),
    days: period.days.map((day) => ({ day, ...counts(byDay.get(day)) })),
  };
}

/**
 * Deals closed in the period (by close time) and open deals now, with their forecast. With a
 * filter by a choice or yes/no field (ADR-396), every one of its queries counts only the deals the
 * filter matches: the closed deals (per currency, per day, the win rate), the time to win, the open
 * deals by stage (in the join, so every active stage stays listed, with none when none match) and
 * the forecast. Stages' chances are the stages' own, so whether a pipeline has one does not change.
 */
export async function dealReport(
  tx: Tx,
  tenantId: string,
  period: ReportPeriod,
  now: Date,
  filter: ResolvedDealFieldFilter | null = null,
): Promise<DealReport> {
  const match = filter === null ? sql`` : sql`and ${dealFieldMatch(filter, sql`d.attributes`)}`;
  const closed = await tx.execute<{
    day: string;
    currency: string;
    won: number;
    won_value: string;
    lost: number;
    lost_value: string;
  }>(sql`
    select to_char(d.closed_at at time zone ${period.timezone}, 'YYYY-MM-DD') as day, p.currency,
      (count(*) filter (where d.status = 'won'))::int as won,
      (coalesce(sum(d.value_minor) filter (where d.status = 'won'), 0))::text as won_value,
      (count(*) filter (where d.status = 'lost'))::int as lost,
      (coalesce(sum(d.value_minor) filter (where d.status = 'lost'), 0))::text as lost_value
    from app.crm_deals d
    join app.crm_pipelines p on p.tenant_id = d.tenant_id and p.id = d.pipeline_id
    where d.tenant_id = ${tenantId} and d.status in ('won', 'lost')
      and d.closed_at >= ${ts(period.start)} and d.closed_at < ${ts(period.end)}
      ${match}
    group by 1, 2 order by 1, 2`);
  const [median] = (
    await tx.execute<{ median: number | null }>(sql`
      select (percentile_cont(0.5) within group (order by extract(epoch from d.closed_at - d.created_at)))::float8 as median
        from app.crm_deals d
       where d.tenant_id = ${tenantId} and d.status = 'won'
         and d.closed_at >= ${ts(period.start)} and d.closed_at < ${ts(period.end)}
         ${match}`)
  ).rows;
  const open = await tx.execute<{
    pipeline_id: string;
    pipeline_name: string;
    currency: string;
    stage_id: string;
    stage_name: string;
    win_percent: number | null;
    deals: number;
    value: string;
  }>(sql`
    select p.id as pipeline_id, p.name as pipeline_name, p.currency, s.id as stage_id,
           s.name as stage_name, s.win_percent, count(d.id)::int as deals,
           coalesce(sum(d.value_minor), 0)::text as value
      from app.crm_pipelines p
      join app.crm_stages s on s.tenant_id = p.tenant_id and s.pipeline_id = p.id and s.archived_at is null
      left join app.crm_deals d on d.tenant_id = s.tenant_id and d.stage_id = s.id and d.status = 'open'
        ${match}
     where p.tenant_id = ${tenantId} and p.archived_at is null
     group by p.id, p.name, p.currency, p.position, s.id, s.name, s.win_percent, s.position
     order by p.position, lower(p.name), s.position`);
  // The forecast (ADR-252): open deals in active stages by stage and expected close month.
  const byMonth = await readForecastGroups(tx, tenantId, undefined, filter);
  const months = forecastMonths(now, period.timezone);

  const totals = (status: 'won' | 'lost'): DealAmount[] => {
    const byCurrency = new Map<string, DealAmount>();
    for (const r of closed.rows) {
      const deals = status === 'won' ? r.won : r.lost;
      if (deals === 0) continue;
      const entry = byCurrency.get(r.currency) ?? { currency: r.currency, deals: 0, valueMinor: 0 };
      entry.deals += deals;
      entry.valueMinor += num(status === 'won' ? r.won_value : r.lost_value);
      byCurrency.set(r.currency, entry);
    }
    return [...byCurrency.values()];
  };
  const won = totals('won');
  const lost = totals('lost');
  const wonDeals = won.reduce((n, a) => n + a.deals, 0);
  const pipelines: DealReport['pipelines'] = [];
  for (const r of open.rows) {
    let pipeline = pipelines.find((p) => p.id === r.pipeline_id);
    if (!pipeline) {
      pipeline = {
        id: r.pipeline_id,
        name: r.pipeline_name,
        currency: r.currency,
        stages: [],
        forecast: forecastByMonth(
          byMonth.filter((m) => m.pipelineId === r.pipeline_id),
          months,
          // Every active stage's chance, with open deals or not, as the board reads them.
          open.rows.filter((s) => s.pipeline_id === r.pipeline_id).map((s) => s.win_percent),
        ),
      };
      pipelines.push(pipeline);
    }
    pipeline.stages.push({
      id: r.stage_id,
      name: r.stage_name,
      deals: r.deals,
      valueMinor: num(r.value),
    });
  }
  return {
    won,
    lost,
    winRate: { numerator: wonDeals, denominator: wonDeals + lost.reduce((n, a) => n + a.deals, 0) },
    medianSecondsToWin: seconds(median?.median),
    pipelines,
    days: closed.rows.map((r) => ({
      day: r.day,
      currency: r.currency,
      won: r.won,
      wonValueMinor: num(r.won_value),
      lost: r.lost,
      lostValueMinor: num(r.lost_value),
    })),
    field: filter,
  };
}

async function agentReport(tx: Tx, tenantId: string, period: ReportPeriod): Promise<AgentRow[]> {
  const replies = await tx.execute<{ membership_id: string; replies: number; templates: number }>(
    sql`
    select m.sender_membership_id as membership_id, count(*)::int as replies,
           (count(*) filter (where m.type = 'template'))::int as templates
      from app.messages m
     where m.tenant_id = ${tenantId} and m.direction = 'outbound' and m.sender_type = 'agent'
       and m.sender_membership_id is not null
       and m.created_at >= ${ts(period.start)} and m.created_at < ${ts(period.end)}
     group by 1`,
  );
  const answered = await tx.execute<{ membership_id: string; answered: number; median: number }>(
    sql`
    select t.ended_by_membership_id as membership_id, count(*)::int as answered,
           (percentile_cont(0.5) within group (order by ${DURATION}))::float8 as median
      from app.conversation_turns t
     where t.tenant_id = ${tenantId} and t.end_reason = 'replied'
       and t.ended_by_membership_id is not null
       and t.ended_at >= ${ts(period.start)} and t.ended_at < ${ts(period.end)}
     group by 1`,
  );
  const resolved = await tx.execute<{ user_id: string; resolved: number }>(sql`
    select a.actor_id as user_id, count(*)::int as resolved
      from app.audit_events a
     where a.tenant_id = ${tenantId} and a.action = 'conversation.status_changed'
       and a.result = 'success' and a.actor_type = 'user' and a.actor_id is not null
       and a.metadata ->> 'to' = 'resolved'
       and a.occurred_at >= ${ts(period.start)} and a.occurred_at < ${ts(period.end)}
     group by 1`);
  const csat = await tx.execute<{ membership_id: string; answered: number; best: number }>(sql`
    select s.assigned_membership_id as membership_id,
           (count(*) filter (where s.answered_at is not null))::int as answered,
           (count(*) filter (where s.score = 3))::int as best
      from app.csat_surveys s
     where s.tenant_id = ${tenantId} and s.assigned_membership_id is not null
       and s.created_at >= ${ts(period.start)} and s.created_at < ${ts(period.end)}
     group by 1`);
  const members = await tx
    .select({
      membershipId: memberships.id,
      userId: memberships.userId,
      name: users.name,
      roles: memberships.roles,
      status: memberships.status,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.tenantId, tenantId));
  const repliesBy = new Map(replies.rows.map((r) => [r.membership_id, r]));
  const answeredBy = new Map(answered.rows.map((r) => [r.membership_id, r]));
  const resolvedBy = new Map(resolved.rows.map((r) => [r.user_id, r.resolved]));
  const csatBy = new Map(csat.rows.map((r) => [r.membership_id, r]));
  const rows: AgentRow[] = [];
  for (const m of members) {
    const rep = repliesBy.get(m.membershipId);
    const ans = answeredBy.get(m.membershipId);
    const res = resolvedBy.get(m.userId) ?? 0;
    const rated = csatBy.get(m.membershipId);
    const active = rep || ans || res > 0 || (rated && rated.answered > 0);
    // Members who can reply are listed even without activity, so a quiet period is visible.
    const canReply =
      m.status === 'active' && permissionsForRoles(m.roles as TenantRole[]).has('inbox.reply');
    if (!active && !canReply) continue;
    rows.push({
      membershipId: m.membershipId,
      name: m.name,
      roles: m.roles as TenantRole[],
      status: m.status,
      replies: rep?.replies ?? 0,
      templates: rep?.templates ?? 0,
      turnsAnswered: ans?.answered ?? 0,
      medianSeconds: ans ? Number(ans.median) : null,
      resolved: res,
      csatAnswered: rated?.answered ?? 0,
      csatBest: rated?.best ?? 0,
    });
  }
  return rows.sort(
    (a, b) =>
      b.turnsAnswered - a.turnsAnswered || b.replies - a.replies || a.name.localeCompare(b.name),
  );
}

async function campaignFunnel(
  tx: Tx,
  tenantId: string,
  period: ReportPeriod,
  costCurrency: string | null,
): Promise<CampaignFunnel> {
  const res = await tx.execute<Record<string, string | number | null>>(sql`
    select c.id, c.name, c.status, (extract(epoch from c.started_at) * 1000)::float8 as started_ms,
      coalesce(c.estimate_currency, c.budget_currency) as currency,
      count(r.id)::int as audience,
      (count(*) filter (where r.state = 'skipped'))::int as skipped,
      (count(*) filter (where r.state = 'queued'))::int as queued,
      (count(*) filter (where r.state = 'queued'
                          and m.status in ('sent', 'delivered', 'read', 'played')))::int as sent,
      (count(*) filter (where r.state = 'queued'
                          and m.status in ('delivered', 'read', 'played')))::int as delivered,
      (count(*) filter (where r.state = 'queued' and m.status in ('read', 'played')))::int as read,
      (count(*) filter (where r.state = 'queued' and m.status = 'failed'))::int as failed,
      (count(*) filter (where r.state = 'queued' and m.status = 'unknown_outcome'))::int as unknown,
      (count(*) filter (where r.replied_at is not null
                          and m.status in ('delivered', 'read', 'played')))::int as replied,
      (count(*) filter (where r.opted_out_at is not null
                          and m.status in ('delivered', 'read', 'played')))::int as opted_out,
      coalesce(sum(r.estimated_cost_micros) filter (where r.state = 'queued'), 0)::bigint as estimate_micros,
      (count(*) filter (where r.state = 'queued' and r.estimated_cost_micros is null))::int
        as estimate_missing
    from app.campaigns c
    left join app.campaign_recipients r on r.tenant_id = c.tenant_id and r.campaign_id = c.id
    left join app.messages m on m.tenant_id = r.tenant_id and m.id = r.message_id
    where c.tenant_id = ${tenantId} and c.started_at >= ${ts(period.start)}
      and c.started_at < ${ts(period.end)}
    group by c.id
    order by c.started_at desc, c.id
    limit ${MAX_FUNNEL_CAMPAIGNS + 1}`);
  const rows = res.rows.slice(0, MAX_FUNNEL_CAMPAIGNS).map((r) => ({
    id: String(r.id),
    name: String(r.name),
    status: String(r.status),
    startedAt: new Date(Number(r.started_ms)),
    // Campaigns started before the estimate currency was recorded fall back to the company's.
    currency: (r.currency as string | null) ?? costCurrency,
    audience: num(r.audience),
    skipped: num(r.skipped),
    queued: num(r.queued),
    sent: num(r.sent),
    delivered: num(r.delivered),
    read: num(r.read),
    failed: num(r.failed),
    unknown: num(r.unknown),
    replied: num(r.replied),
    optedOut: num(r.opted_out),
    estimateMicros: num(r.estimate_micros),
    estimateMissing: num(r.estimate_missing),
  }));
  return { rows, truncated: res.rows.length > MAX_FUNNEL_CAMPAIGNS };
}

async function loadDefinitions(tx: Tx): Promise<MetricDefinition[]> {
  const rows = await tx
    .select()
    .from(metricDefinitions)
    .orderBy(metricDefinitions.key, desc(metricDefinitions.version));
  const latest = new Map<string, MetricDefinition>();
  for (const r of rows) {
    if (latest.has(r.key)) continue;
    latest.set(r.key, {
      key: r.key,
      version: r.version,
      label: r.label,
      unit: r.unit,
      description: r.description,
      numerator: r.numerator,
      denominator: r.denominator,
      window: r.windowRule,
      timezoneRule: r.timezoneRule,
      missingData: r.missingData,
      freshness: r.freshness,
      available: r.available,
    });
  }
  const order = new Map(METRIC_DEFINITIONS.map((m, i) => [m.key, i]));
  return [...latest.values()].sort(
    (a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity),
  );
}

async function loadReportSettings(tx: Tx, tenantId: string, timezone: string) {
  const [row] = await tx
    .select({
      costCurrency: messagingSettings.costCurrency,
      csatEnabled: messagingSettings.csatEnabled,
    })
    .from(messagingSettings)
    .where(eq(messagingSettings.tenantId, tenantId));
  const targets = await loadReplyTargets(tx, tenantId, timezone);
  return {
    costCurrency: row?.costCurrency ?? null,
    csatEnabled: row?.csatEnabled === true,
    targets,
  };
}

/** Exact decimal amount in major units for exports (no floating point). */
export function microsToDecimal(micros: number, currency: string): string {
  const digits = minorDigits(currency);
  const minor = microsToMinor(micros, currency);
  if (digits === 0) return String(minor);
  const scale = 10 ** digits;
  return `${Math.floor(minor / scale)}.${String(minor % scale).padStart(digits, '0')}`;
}

function sectionCsv(section: ReportSection, report: Report): string {
  const tz = report.period.timezone;
  const lines: string[] = [];
  switch (section) {
    case 'messaging':
      lines.push(
        csvLine([
          'day',
          'time_zone',
          'customer_messages',
          'messages_sent',
          'by_members',
          'by_campaigns',
          'by_other_senders',
          'canceled_before_sending',
          'in_progress',
          'sent',
          'delivered',
          'read',
          'failed',
          'unknown_outcome',
        ]),
      );
      for (const d of report.messaging.days) {
        lines.push(
          csvLine([
            d.day,
            tz,
            d.inbound,
            d.outbound,
            d.byMember,
            d.byCampaign,
            d.byOther,
            d.canceled,
            d.inProgress,
            d.sent,
            d.delivered,
            d.read,
            d.failed,
            d.unknown,
          ]),
        );
      }
      break;
    case 'costs': {
      const c = report.costs;
      lines.push(
        csvLine([
          'status',
          'pricing_category',
          'market',
          'delivered_messages',
          'estimated_cost',
          'estimated_cost_micros',
          'currency',
        ]),
      );
      for (const line of c.lines) {
        lines.push(
          csvLine([
            'priced',
            line.category,
            line.market,
            line.count,
            c.currency ? microsToDecimal(line.micros, c.currency) : '',
            line.micros,
            c.currency,
          ]),
        );
      }
      const other: [string, number][] = [
        ['free_reported_by_meta', c.free],
        ['pricing_not_reported_yet', c.notReported],
        ['unpriced_no_currency_chosen', c.unpriced.noCurrency],
        ['unpriced_no_rate_card', c.unpriced.noRateCard],
        ['unpriced_category_without_rate', c.unpriced.otherCategory],
        ['unpriced_market_unknown', c.unpriced.marketUnknown],
        ['unpriced_no_price_for_market', c.unpriced.noPrice],
      ];
      for (const [status, count] of other) {
        if (count > 0) lines.push(csvLine([status, '', '', count, '', '', c.currency]));
      }
      break;
    }
    case 'inbox': {
      const secondsOrEmpty = (v: number | null) => (v === null ? '' : Math.round(v));
      lines.push(
        csvLine([
          'day',
          'time_zone',
          'reply_turns_started',
          'answered',
          'resolved_without_reply',
          'still_waiting',
          'median_first_response_seconds',
          'median_first_response_business_seconds',
          'cases_resolved',
          'median_resolution_seconds',
        ]),
      );
      for (const d of report.inbox.days) {
        lines.push(
          csvLine([
            d.day,
            tz,
            d.started,
            d.answered,
            d.resolvedWithoutReply,
            d.waiting,
            secondsOrEmpty(d.medianSeconds),
            secondsOrEmpty(d.businessMedianSeconds),
            d.casesResolved,
            secondsOrEmpty(d.medianResolutionSeconds),
          ]),
        );
      }
      break;
    }
    case 'csat':
      lines.push(
        csvLine([
          'day',
          'time_zone',
          'surveys',
          'sent',
          'not_sent',
          'delivered',
          'answered',
          'best_rating',
          'middle_rating',
          'worst_rating',
        ]),
      );
      for (const d of report.csat.days) {
        lines.push(
          csvLine([
            d.day,
            tz,
            d.surveys,
            d.sent,
            d.skipped,
            d.delivered,
            d.answered,
            d.best,
            d.middle,
            d.worst,
          ]),
        );
      }
      break;
    case 'automations':
      lines.push(
        csvLine([
          'day',
          'time_zone',
          'runs_started',
          'still_running',
          'completed',
          'handed_off',
          'taken_over',
          'stopped',
          'failed',
        ]),
      );
      for (const d of report.automations.days) {
        lines.push(
          csvLine([
            d.day,
            tz,
            d.started,
            d.active,
            d.completed,
            d.handed_off,
            d.taken_over,
            d.stopped,
            d.failed,
          ]),
        );
      }
      break;
    case 'deals':
      lines.push(
        csvLine([
          'day',
          'time_zone',
          'currency',
          'deals_won',
          'value_won',
          'deals_lost',
          'value_lost',
        ]),
      );
      for (const d of report.deals.days) {
        lines.push(
          csvLine([
            d.day,
            tz,
            d.currency,
            d.won,
            minorToInput(d.wonValueMinor, d.currency),
            d.lost,
            minorToInput(d.lostValueMinor, d.currency),
          ]),
        );
      }
      break;
    case 'agents':
      lines.push(
        csvLine([
          'member',
          'roles',
          'membership_status',
          'replies_sent',
          'templates_sent',
          'turns_answered',
          'median_first_response_seconds',
          'resolved',
          'csat_answers',
          'csat_best_ratings',
        ]),
      );
      for (const a of report.agents) {
        lines.push(
          csvLine([
            a.name,
            a.roles.join(' '),
            a.status,
            a.replies,
            a.templates,
            a.turnsAnswered,
            a.medianSeconds === null ? '' : Math.round(a.medianSeconds),
            a.resolved,
            a.csatAnswered,
            a.csatBest,
          ]),
        );
      }
      break;
    case 'campaigns':
      lines.push(
        csvLine([
          'campaign',
          'status',
          'started_at',
          'audience',
          'not_sent',
          'handed_to_whatsapp',
          'sent',
          'delivered',
          'read',
          'failed',
          'unknown_outcome',
          'replied',
          'opted_out',
          'estimated_cost',
          'estimated_cost_micros',
          'currency',
          'unpriced_messages',
        ]),
      );
      for (const r of report.campaigns.rows) {
        lines.push(
          csvLine([
            r.name,
            r.status,
            r.startedAt.toISOString(),
            r.audience,
            r.skipped,
            r.queued,
            r.sent,
            r.delivered,
            r.read,
            r.failed,
            r.unknown,
            r.replied,
            r.optedOut,
            r.currency ? microsToDecimal(r.estimateMicros, r.currency) : '',
            r.estimateMicros,
            r.currency,
            r.estimateMissing,
          ]),
        );
      }
      break;
  }
  return CSV_BOM + lines.join('');
}

export interface ReportsDeps {
  db: Database;
  clock: Clock;
}

/**
 * The company's report for a period, as Reports shows it and the API reads it (ADR-297). The
 * caller runs it in one repeatable-read, read-only transaction, so every number comes from the same
 * moment. `dealFilter`, resolved by the caller against the company's fields in that transaction,
 * filters the deals section only (ADR-396); report emails never pass one.
 */
export async function readReport(
  tx: Tx,
  tenantId: string,
  timezone: string,
  period: ReportPeriod,
  now: Date,
  dealFilter: ResolvedDealFieldFilter | null = null,
): Promise<Report> {
  const settings = await loadReportSettings(tx, tenantId, timezone);
  const messaging = await messagingReport(tx, tenantId, period);
  const costs = await estimateMetaCharges(tx, tenantId, period, settings.costCurrency);
  const inbox = await inboxReport(tx, tenantId, period, now, settings.targets);
  const csat = await csatReport(tx, tenantId, period, settings.csatEnabled);
  const automations = await automationReport(tx, tenantId, period);
  const deals = await dealReport(tx, tenantId, period, now, dealFilter);
  const agents = await agentReport(tx, tenantId, period);
  const campaigns = await campaignFunnel(tx, tenantId, period, settings.costCurrency);
  const definitions = await loadDefinitions(tx);
  return {
    period,
    generatedAt: now,
    messaging,
    costs,
    inbox,
    csat,
    automations,
    deals,
    agents,
    campaigns,
    definitions,
  };
}

/** A section export's deal field filter (ADR-396): refused unless it resolves, as the CRM export's. */
const reportExportInputSchema = z.object({
  field: z
    .string()
    .max(DEAL_FIELD_FILTER_MAX_LENGTH, 'The deal field filter is not valid.')
    .optional(),
});

const SNAPSHOT = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

/**
 * The page's deal field filter (ADR-396), read in the report's transaction: the company's own
 * fields are read, and the filter resolved against them, only for members who may see the CRM.
 */
export async function readReportDealFilter(
  tx: Tx,
  ctx: TenantContext,
  raw: string | null | undefined,
): Promise<ReportDealFilter> {
  return reportDealFilter(
    can(ctx, 'crm.read') ? await loadDealFields(tx, ctx.tenant.id) : null,
    raw,
  );
}

export function createReportsService(deps: ReportsDeps) {
  const { db, clock } = deps;

  /**
   * The report for the page. Its deals section follows the filter by a choice or yes/no field in
   * `input.field` (ADR-396) for members who may see the CRM, resolved against the company's own
   * fields in the report's snapshot; for others it is neither read nor applied. The filter's text is
   * read as the board reads it, apart from the input's validation, so no text fails the page.
   */
  async function getReport(ctx: TenantContext, input: unknown): Promise<ReportPage> {
    assertCan(ctx, 'reports.read');
    const now = clock.now();
    const period = resolvePeriod(input, ctx.tenant.timezone, now);
    const field = dealFieldFilterText(input);
    return db.run(
      ctx.scope,
      async (tx) => {
        const dealFilter = await readReportDealFilter(tx, ctx, field);
        const report = await readReport(
          tx,
          ctx.tenant.id,
          ctx.tenant.timezone,
          period,
          now,
          dealFilter.applied,
        );
        return { ...report, dealFilter };
      },
      SNAPSHOT,
    );
  }

  return {
    getReport,

    /**
     * One report section as CSV (formula-safe, see contacts/csv). Needs `reports.export`; the
     * export is audited before any data is returned. The deals section takes the page's deal field
     * filter (ADR-396), strictly: refused for another section, without `crm.read`, or when it does
     * not resolve, before anything is audited; audited with the field's key and the kind of match,
     * never the option.
     */
    async exportSection(
      ctx: TenantContext,
      input: unknown,
      section: unknown,
      meta: RequestMeta = {},
    ): Promise<{ filename: string; body: string }> {
      assertCan(ctx, 'reports.read');
      assertCan(ctx, 'reports.export');
      const which = parseInput(z.enum(REPORT_SECTIONS), section);
      const { field } = parseInput(reportExportInputSchema, input ?? {});
      if (field !== undefined) assertReportDealFilterAllowed(which, can(ctx, 'crm.read'));
      const now = clock.now();
      const period = resolvePeriod(input, ctx.tenant.timezone, now);
      const report = await db.run(
        ctx.scope,
        async (tx) =>
          readReport(
            tx,
            ctx.tenant.id,
            ctx.tenant.timezone,
            period,
            now,
            field === undefined
              ? null
              : requireDealFieldFilter(await loadDealFields(tx, ctx.tenant.id), field),
          ),
        SNAPSHOT,
      );
      const filter = report.deals.field;
      await db.run(ctx.scope, (tx) =>
        recordAudit(
          tx,
          ctx,
          {
            action: 'report.exported',
            subjectType: 'report',
            subjectId: which,
            metadata: {
              from: period.from,
              to: period.to,
              timezone: period.timezone,
              preset: period.preset,
              // The field's key and the kind of match, never the option (ADR-396, as ADR-391);
              // left out without a filter, so exports audited before it read the same.
              ...(filter ? { field: dealFieldFilterAudit(filter) } : {}),
            },
          },
          meta,
        ),
      );
      return {
        filename: reportExportFilename(which, period, filter),
        body: sectionCsv(which, report),
      };
    },
  };
}

export type ReportsService = ReturnType<typeof createReportsService>;
