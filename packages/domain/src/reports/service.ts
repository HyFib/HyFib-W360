import { z } from 'zod';
import type { Clock } from '@w360/core';
import {
  CSAT_SKIP_REASONS,
  RATE_CATEGORIES,
  desc,
  eq,
  memberships,
  messagingSettings,
  metricDefinitions,
  sql,
  users,
  type CsatSkipReason,
  type Database,
  type RateCategory,
  type SQL,
  type TenantRole,
  type Tx,
} from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
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
import { openPeriods } from '../inbox/business-hours';
import { loadReplyTarget, type ReplyTarget } from '../inbox/sla';
import { parseInput } from '../validation';
import { METRIC_DEFINITIONS, type MetricDefinition } from './definitions';
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
 * audited.
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
  targetMinutes: number | null;
  /** Business hours are on: the target and the business-hours figures count opening hours only. */
  businessHours: boolean;
  now: {
    open: number;
    unassigned: number;
    waiting: number;
    oldestWaitSeconds: number | null;
    windowsClosing: number;
    windowsClosed: number;
    /** Waiting turns past the target (null without a target). */
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
  agents: AgentRow[];
  campaigns: CampaignFunnel;
  /** Latest version of every persisted definition, in registry order. */
  definitions: MetricDefinition[];
}

export const REPORT_SECTIONS = [
  'messaging',
  'costs',
  'inbox',
  'csat',
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
 * number Meta reported delivering to) and Meta's pricing category.
 */
async function costReport(
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
 * Business time of [from, to) in seconds, as the overlap with the company's opening periods held
 * in the `iv(lo, hi)` CTE (see openingPeriodsCte).
 */
const businessSeconds = (from: SQL, to: SQL) =>
  sql`(select coalesce(sum(extract(epoch from least(${to}, iv.hi) - greatest(${from}, iv.lo))), 0)::float8
         from iv where iv.lo < ${to} and iv.hi > ${from})`;

async function openingPeriodsCte(
  tx: Tx,
  tenantId: string,
  target: ReplyTarget,
  period: ReportPeriod,
  now: Date,
): Promise<SQL | null> {
  if (!target.calendar) return null;
  // From the oldest turn the report measures (the period start, or an older waiting turn) to now.
  const oldest = await tx.execute<{ started_ms: number | null }>(sql`
    select (extract(epoch from min(t.started_at)) * 1000)::float8 as started_ms
      from app.conversation_turns t where t.tenant_id = ${tenantId} and t.ended_at is null`);
  const oldestMs = oldest.rows[0]?.started_ms;
  const from =
    oldestMs !== null && oldestMs !== undefined && oldestMs < period.start.getTime()
      ? new Date(oldestMs)
      : period.start;
  const periods = openPeriods(target.calendar, from, now);
  return sql`iv(lo, hi) as (select * from unnest(
    ${sql.param(periods.map((p) => p.start.toISOString()))}::timestamptz[],
    ${sql.param(periods.map((p) => p.end.toISOString()))}::timestamptz[]))`;
}

async function inboxReport(
  tx: Tx,
  tenantId: string,
  period: ReportPeriod,
  now: Date,
  target: ReplyTarget,
): Promise<InboxReport> {
  const targetMinutes = target.minutes;
  const targetSeconds = targetMinutes === null ? null : targetMinutes * 60;
  const iv = await openingPeriodsCte(tx, tenantId, target, period, now);
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
        targetSeconds === null
          ? sql`null::int`
          : sql`(count(*) filter (where w.waited >= ${targetSeconds}::float8))::int`
      } as over_target
    from (
      select t.started_at, c.last_inbound_at,
             ${iv ? businessSeconds(sql`t.started_at`, ts(now)) : sql`extract(epoch from ${ts(now)} - t.started_at)::float8`} as waited
        from app.conversation_turns t
        join app.conversations c on c.tenant_id = t.tenant_id and c.id = t.conversation_id
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
           ${iv ? sql`case when t.end_reason = 'replied' then ${businessSeconds(sql`t.started_at`, sql`t.ended_at`)} end` : sql`null::float8`} as biz_dur,
           ${
             iv
               ? sql`case when t.ended_at is null then ${businessSeconds(sql`t.started_at`, ts(now))} end`
               : sql`case when t.ended_at is null then extract(epoch from ${ts(now)} - t.started_at)::float8 end`
           } as waited
      from app.conversation_turns t
     where t.tenant_id = ${tenantId} and t.started_at >= ${ts(period.start)}
       and t.started_at < ${ts(period.end)}`;
  // The target is met by a reply within it; turns still waiting count once they pass it.
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
        targetSeconds === null
          ? sql`null::int as within_target, null::int as target_denominator`
          : sql`(count(*) filter (where pt.end_reason = 'replied'
                                    and ${replyTime} <= ${targetSeconds}::float8))::int as within_target,
                (count(*) filter (where pt.end_reason = 'replied'
                                    or (pt.ended_at is null and pt.waited >= ${targetSeconds}::float8)))::int
                  as target_denominator`
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
  return {
    targetMinutes,
    businessHours: iv !== null,
    now: {
      open: num(l.open),
      unassigned: num(l.unassigned),
      waiting: num(l.waiting),
      oldestWaitSeconds: seconds(l.oldest_wait),
      windowsClosing: num(l.closing),
      windowsClosed: num(l.closed),
      overTarget: targetSeconds === null ? null : num(l.over_target),
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
      withinTarget:
        targetSeconds === null
          ? null
          : { numerator: num(p.within_target), denominator: num(p.target_denominator) },
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
  const target = await loadReplyTarget(tx, tenantId, timezone);
  return {
    costCurrency: row?.costCurrency ?? null,
    csatEnabled: row?.csatEnabled === true,
    target,
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

export function createReportsService(deps: ReportsDeps) {
  const { db, clock } = deps;

  async function getReport(ctx: TenantContext, input: unknown): Promise<Report> {
    assertCan(ctx, 'reports.read');
    const now = clock.now();
    const period = resolvePeriod(input, ctx.tenant.timezone, now);
    return db.run(
      ctx.scope,
      async (tx) => {
        const settings = await loadReportSettings(tx, ctx.tenant.id, ctx.tenant.timezone);
        const messaging = await messagingReport(tx, ctx.tenant.id, period);
        const costs = await costReport(tx, ctx.tenant.id, period, settings.costCurrency);
        const inbox = await inboxReport(tx, ctx.tenant.id, period, now, settings.target);
        const csat = await csatReport(tx, ctx.tenant.id, period, settings.csatEnabled);
        const agents = await agentReport(tx, ctx.tenant.id, period);
        const campaigns = await campaignFunnel(tx, ctx.tenant.id, period, settings.costCurrency);
        const definitions = await loadDefinitions(tx);
        return {
          period,
          generatedAt: now,
          messaging,
          costs,
          inbox,
          csat,
          agents,
          campaigns,
          definitions,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  return {
    getReport,

    /**
     * One report section as CSV (formula-safe, see contacts/csv). Needs `reports.export`; the
     * export is audited before any data is returned.
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
      const report = await getReport(ctx, input);
      const { period } = report;
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
            },
          },
          meta,
        ),
      );
      return {
        filename: `${which}-${period.from}-to-${period.to}.csv`,
        body: sectionCsv(which, report),
      };
    },
  };
}

export type ReportsService = ReturnType<typeof createReportsService>;
