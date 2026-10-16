import { z } from 'zod';
import { clipText, uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  eq,
  inArray,
  lte,
  memberships,
  REPORT_EMAIL_FREQUENCIES,
  reportEmailSubscriptions,
  sql,
  systemScope,
  tenants,
  users,
  type Database,
  type ReportEmailFrequency,
  type TenantRole,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
import { permissionsForRoles } from '../authz/permissions';
import { recordAudit, type RequestMeta } from '../audit';
import { formatMicros } from '../campaigns/costs';
import { resolveLocalTime, zonedParts } from '../campaigns/schedule';
import { formatMinor } from '../crm/money';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import type { EmailPayload } from '../email/templates';
import { parseInput } from '../validation';
import { formatCount, formatDayLong, formatDuration, formatPercent } from './format';
import { formatDay, resolvePeriod } from './period';
import { readReport, type DealAmount, type Ratio, type Report } from './service';

/**
 * Report emails (ADR-376): a member who can read reports chooses, for themselves, an email of the
 * company's report totals each week (Monday to Sunday) or each month. It goes out at 07:00 in the
 * company's time zone on the first day after the period, from the worker: the minute sweep signals
 * a `report.email` job per company with an email due, and the job computes each period's report
 * once in one repeatable-read snapshot, then queues one email per member who chose it. Whether an
 * email is due, and whether its member is still active and can read reports, is decided again under
 * a lock on the member's row, so each period is emailed at most once; a member who left or lost
 * `reports.read` is not emailed and their choice is deleted. An email more than 72 hours late (the
 * worker was down, the company suspended) is skipped for the next period's, and one whose period
 * was emailed already (the company's time zone moved west since it was scheduled) waits for the
 * next sending time in the company's time zone. Emails carry the company's totals only, never a
 * contact's or a message's details.
 */

/** The local hour report emails go out, on the first day after their period. */
export const REPORT_EMAIL_HOUR = 7;
/** An email later than this after its time is skipped; the next period's comes instead. */
export const REPORT_EMAIL_LATE_LIMIT_MS = 72 * 3_600_000;

export const REPORT_EMAIL_LABELS: Record<ReportEmailFrequency, string> = {
  weekly: 'Weekly report',
  monthly: 'Monthly report',
};

interface Day {
  year: number;
  month: number;
  day: number;
}

function addDays(d: Day, days: number): Day {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

function addMonths(d: Day, months: number): Day {
  const t = new Date(Date.UTC(d.year, d.month - 1 + months, 1));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: 1 };
}

/** The first day of the week (Monday) or month that contains `day`. */
function periodStart(frequency: ReportEmailFrequency, day: Day): Day {
  if (frequency === 'monthly') return { ...day, day: 1 };
  const weekday = (new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay() + 6) % 7;
  return addDays(day, -weekday);
}

function sendInstant(day: Day, timezone: string): Date {
  return resolveLocalTime({ ...day, hour: REPORT_EMAIL_HOUR, minute: 0 }, timezone).instant;
}

function localDay(instant: Date, timezone: string): Day {
  const p = zonedParts(instant.getTime(), timezone);
  return { year: p.year, month: p.month, day: p.day };
}

/**
 * When the next report email of this frequency goes out after `after`: 07:00 in the time zone on
 * the Monday (weekly) or the first of the month (monthly), the first such time later than `after`.
 */
export function nextReportEmailAt(
  frequency: ReportEmailFrequency,
  timezone: string,
  after: Date,
): Date {
  const start = periodStart(frequency, localDay(after, timezone));
  const candidate = sendInstant(start, timezone);
  if (candidate.getTime() > after.getTime()) return candidate;
  const next = frequency === 'weekly' ? addDays(start, 7) : addMonths(start, 1);
  return sendInstant(next, timezone);
}

/**
 * The period an email due at `sendAt` reports: the whole week (Monday to Sunday) or month before
 * the week or month of its local day, so a time zone changed since it was scheduled still names
 * whole periods.
 */
export function reportEmailPeriod(
  frequency: ReportEmailFrequency,
  timezone: string,
  sendAt: Date,
): { from: string; to: string } {
  const start = periodStart(frequency, localDay(sendAt, timezone));
  const first = frequency === 'weekly' ? addDays(start, -7) : addMonths(start, -1);
  return { from: formatDay(first), to: formatDay(addDays(start, -1)) };
}

export interface ReportEmailRow {
  label: string;
  value: string;
}

/** Longest value of a row; amounts in many currencies are cut there. */
const ROW_VALUE_MAX = 200;

function amounts(list: readonly DealAmount[]): string {
  return list.length === 0
    ? 'no value'
    : list.map((a) => formatMinor(a.valueMinor, a.currency)).join(' + ');
}

/**
 * The figures of a report email, labelled as Reports labels them: messages, replies and
 * resolutions always; answers within the target, CSAT, automation runs, closed deals and estimated
 * Meta charges when the company has them in the period.
 */
export function reportEmailRows(report: Report): ReportEmailRow[] {
  const label = (key: string) => report.definitions.find((d) => d.key === key)?.label ?? key;
  const count = (n: number) => formatCount(n);
  const share = (r: Ratio, of: string) =>
    `${formatPercent(r.numerator, r.denominator)} (${count(r.numerator)} of ${count(r.denominator)}${of})`;
  const m = report.messaging;
  const t = m.totals;
  const turns = report.inbox.turns;
  const rows: ReportEmailRow[] = [
    { label: label('messaging.inbound'), value: count(t.inbound) },
    { label: label('messaging.outbound'), value: count(t.outbound) },
    { label: label('messaging.delivered_rate'), value: share(m.rates.delivered, ' sent') },
    {
      label: label('messaging.read_rate'),
      // Customers can turn read receipts off, so the share is a lower bound.
      value: `${m.rates.read.denominator > 0 ? 'at least ' : ''}${share(m.rates.read, ' delivered')}`,
    },
    { label: label('messaging.failure_rate'), value: share(m.rates.failure, '') },
    {
      label: 'Reply turns',
      value: `${count(turns.started)} (${count(turns.answered)} answered, ${count(turns.resolvedWithoutReply)} resolved without a reply, ${count(turns.waiting)} still waiting)`,
    },
    {
      label: `${label('inbox.first_response_time')} (median)`,
      value: formatDuration(turns.medianSeconds),
    },
  ];
  if (turns.withinTarget && report.inbox.targetMinutes !== null) {
    const of = ` within ${report.inbox.targetMinutes} min${report.inbox.businessHours ? ' of business hours' : ''}`;
    rows.push({ label: label('inbox.within_target'), value: share(turns.withinTarget, of) });
  }
  rows.push({
    label: `${label('inbox.resolution_time')} (median)`,
    value: `${formatDuration(report.inbox.resolution.medianSeconds)} (${count(report.inbox.resolution.resolved)} resolved)`,
  });
  const csat = report.csat;
  if (csat.enabled || csat.surveys > 0) {
    rows.push({ label: label('csat.score'), value: share(csat.score, ' answers') });
  }
  const runs = report.automations.totals;
  if (runs.started > 0) {
    const outcomes = [
      [runs.completed, 'completed'],
      [runs.handed_off, 'handed off'],
      [runs.taken_over, 'taken over'],
      [runs.stopped, 'stopped'],
      [runs.failed, 'failed'],
      [runs.active, 'still running'],
    ] as const;
    const parts = outcomes.filter(([n]) => n > 0).map(([n, text]) => `${count(n)} ${text}`);
    rows.push({
      label: label('automation.runs'),
      value: `${count(runs.started)}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`,
    });
  }
  const deals = report.deals;
  const won = deals.won.reduce((n, a) => n + a.deals, 0);
  const lost = deals.lost.reduce((n, a) => n + a.deals, 0);
  if (won + lost > 0) {
    rows.push(
      { label: 'Deals won', value: `${count(won)} (${amounts(deals.won)})` },
      { label: 'Deals lost', value: `${count(lost)} (${amounts(deals.lost)})` },
      { label: label('crm.win_rate'), value: share(deals.winRate, ' closed') },
    );
  }
  const costs = report.costs;
  if (costs.currency && costs.cards.length > 0) {
    rows.push({
      label: 'Estimated Meta charges',
      value: `${formatMicros(costs.totalMicros, costs.currency)} (${count(costs.priced)} priced of ${count(costs.billable)} billable delivered messages)`,
    });
  }
  return rows.map((row) => ({ label: row.label, value: clipText(row.value, ROW_VALUE_MAX) }));
}

type ReportSummaryPayload = Extract<EmailPayload, { kind: 'reports.summary' }>;

/** A member's report email for a period: the figures, what they count, and how to stop it. */
export function reportEmailPayload(input: {
  frequency: ReportEmailFrequency;
  companyName: string;
  timezone: string;
  period: { from: string; to: string };
  report: Report;
  url: string;
}): ReportSummaryPayload {
  const rows = reportEmailRows(input.report);
  const which = input.frequency === 'weekly' ? 'weekly' : 'monthly';
  return {
    kind: 'reports.summary',
    companyName: input.companyName,
    title: REPORT_EMAIL_LABELS[input.frequency],
    period: `${formatDayLong(input.period.from)} – ${formatDayLong(input.period.to)}`,
    timezone: input.timezone,
    rows,
    notes: [
      'The numbers are as HyFib computed them for this email; delivery statuses that reach HyFib later can still change them. Reports shows every figure with what it counts.',
      ...(rows.some((r) => r.label === 'Estimated Meta charges')
        ? [
            'Meta charges are estimates at list prices, not Meta’s invoice; Meta bills your company directly.',
          ]
        : []),
      `You get this email because you turned on the ${which} report email on the Reports page, where you can turn it off.`,
    ],
    url: input.url,
  };
}

export const reportEmailsSchema = z.object({
  weekly: z.boolean(),
  monthly: z.boolean(),
});

export interface ReportEmailChoice {
  frequency: ReportEmailFrequency;
  nextSendAt: Date;
  /** The period of the last email sent, if any. */
  lastPeriod: { from: string; to: string } | null;
  lastSentAt: Date | null;
}

async function loadOwnChoices(tx: Tx, ctx: TenantContext): Promise<ReportEmailChoice[]> {
  const rows = await tx
    .select({
      frequency: reportEmailSubscriptions.frequency,
      nextSendAt: reportEmailSubscriptions.nextSendAt,
      lastPeriodFrom: reportEmailSubscriptions.lastPeriodFrom,
      lastPeriodTo: reportEmailSubscriptions.lastPeriodTo,
      lastSentAt: reportEmailSubscriptions.lastSentAt,
    })
    .from(reportEmailSubscriptions)
    .where(
      and(
        eq(reportEmailSubscriptions.tenantId, ctx.tenant.id),
        eq(reportEmailSubscriptions.membershipId, ctx.membership.id),
      ),
    );
  return REPORT_EMAIL_FREQUENCIES.flatMap((frequency) =>
    rows
      .filter((r) => r.frequency === frequency)
      .map((r) => ({
        frequency,
        nextSendAt: r.nextSendAt,
        lastPeriod:
          r.lastPeriodFrom && r.lastPeriodTo
            ? { from: r.lastPeriodFrom, to: r.lastPeriodTo }
            : null,
        lastSentAt: r.lastSentAt,
      })),
  );
}

export function createReportEmailsService(deps: { db: Database; clock: Clock }) {
  const { db, clock } = deps;
  return {
    /** The report emails the member chose in this company. */
    async getReportEmails(ctx: TenantContext): Promise<ReportEmailChoice[]> {
      assertCan(ctx, 'reports.read');
      return db.run(ctx.scope, (tx) => loadOwnChoices(tx, ctx), { accessMode: 'read only' });
    },

    /**
     * Turns the member's own weekly and monthly report emails on or off; only their own rows
     * change. A choice turned on is due at the next sending time; a change is audited.
     */
    async updateReportEmails(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<ReportEmailChoice[]> {
      assertCan(ctx, 'reports.read');
      const data = parseInput(reportEmailsSchema, input);
      const now = clock.now();
      return db.run(ctx.scope, async (tx) => {
        const own = and(
          eq(reportEmailSubscriptions.tenantId, ctx.tenant.id),
          eq(reportEmailSubscriptions.membershipId, ctx.membership.id),
        );
        const existing = await tx
          .select({
            id: reportEmailSubscriptions.id,
            frequency: reportEmailSubscriptions.frequency,
          })
          .from(reportEmailSubscriptions)
          .where(own)
          .for('update');
        const added = REPORT_EMAIL_FREQUENCIES.filter(
          (frequency) => data[frequency] && !existing.some((r) => r.frequency === frequency),
        );
        const removed = existing.filter((r) => !data[r.frequency]);
        for (const frequency of added) {
          await tx
            .insert(reportEmailSubscriptions)
            .values({
              id: uuidv7(),
              tenantId: ctx.tenant.id,
              membershipId: ctx.membership.id,
              frequency,
              nextSendAt: nextReportEmailAt(frequency, ctx.tenant.timezone, now),
            })
            // A concurrent request of the member's added it first: the choice stands.
            .onConflictDoNothing();
        }
        if (removed.length > 0) {
          await tx.delete(reportEmailSubscriptions).where(
            and(
              own,
              inArray(
                reportEmailSubscriptions.id,
                removed.map((r) => r.id),
              ),
            ),
          );
        }
        if (added.length + removed.length > 0) {
          await recordAudit(
            tx,
            ctx,
            {
              action: 'membership.report_emails_updated',
              subjectType: 'membership',
              subjectId: ctx.membership.id,
              metadata: { weekly: data.weekly, monthly: data.monthly },
            },
            meta,
          );
        }
        return loadOwnChoices(tx, ctx);
      });
    },
  };
}

export type ReportEmailsService = ReturnType<typeof createReportEmailsService>;

/**
 * Companies with a report email due at `now` (SECURITY DEFINER sweep query, migration 0295):
 * active companies, each at most once an hour while its emails fail.
 */
export async function findDueReportEmailCompanies(
  db: Database,
  now: Date,
  limit = 100,
): Promise<string[]> {
  return db.run(
    systemScope,
    async (tx) =>
      (
        await tx.execute<{ tenant_id: string }>(
          sql`select tenant_id from ops.due_report_email_companies(${now.toISOString()}::timestamptz, ${limit})`,
        )
      ).rows.map((r) => r.tenant_id),
    { accessMode: 'read only' },
  );
}

export interface ReportEmailDeps {
  db: Database;
  clock: Clock;
  outbox: OutboxDeps;
  appBaseUrl: string;
}

export interface ReportEmailOutcome {
  /** Emails queued. */
  sent: number;
  /** Reports computed (one per period and frequency due). */
  reports: number;
  /** Emails more than 72 hours late, skipped for the next period's. */
  late: number;
  /**
   * Emails whose period was emailed already (the company's time zone moved west since they were
   * scheduled), moved to the next sending time in the company's time zone instead.
   */
  repeated: number;
  /** Choices of members who left or can no longer read reports, deleted. */
  stopped: number;
}

/**
 * Sends the company's due report emails (the `report.email` job, in the company's scope from a
 * verified job). The attempt is recorded first and committed, so a failure later waits an hour
 * before the sweep signals the company again; each period's report is computed once; the emails
 * are queued and each member's row moved to its next time in one transaction, under a lock.
 */
export async function sendDueReportEmails(
  deps: ReportEmailDeps,
  scope: TenantScope,
): Promise<ReportEmailOutcome> {
  const outcome: ReportEmailOutcome = { sent: 0, reports: 0, late: 0, repeated: 0, stopped: 0 };
  const tenantId = scope.tenantId;
  const now = deps.clock.now();
  const started = await deps.db.run(scope, async (tx) => {
    const [company] = await tx
      .select({ name: tenants.name, slug: tenants.slug, timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    const due = await tx
      .update(reportEmailSubscriptions)
      .set({ attemptedAt: now })
      .where(
        and(
          eq(reportEmailSubscriptions.tenantId, tenantId),
          lte(reportEmailSubscriptions.nextSendAt, now),
        ),
      )
      .returning({
        id: reportEmailSubscriptions.id,
        frequency: reportEmailSubscriptions.frequency,
        nextSendAt: reportEmailSubscriptions.nextSendAt,
        lastPeriodFrom: reportEmailSubscriptions.lastPeriodFrom,
      });
    return { company, due };
  });
  const { company, due } = started;
  if (!company || due.length === 0) return outcome;

  // What an email due now is: too late, a period already emailed, or the period to email.
  const classify = (s: {
    frequency: ReportEmailFrequency;
    nextSendAt: Date;
    lastPeriodFrom: string | null;
  }): 'late' | 'repeated' | { from: string; to: string } => {
    if (now.getTime() - s.nextSendAt.getTime() > REPORT_EMAIL_LATE_LIMIT_MS) return 'late';
    const period = reportEmailPeriod(s.frequency, company.timezone, s.nextSendAt);
    // Dates as YYYY-MM-DD compare as strings.
    return s.lastPeriodFrom !== null && period.from <= s.lastPeriodFrom ? 'repeated' : period;
  };
  const periodKey = (frequency: ReportEmailFrequency, from: string) => `${frequency}:${from}`;
  const reports = new Map<string, { period: { from: string; to: string }; report: Report }>();
  for (const s of due) {
    const period = classify(s);
    if (typeof period === 'string') continue;
    const key = periodKey(s.frequency, period.from);
    if (reports.has(key)) continue;
    const resolved = resolvePeriod({ preset: 'custom', ...period }, company.timezone, now);
    const report = await deps.db.run(
      scope,
      (tx) => readReport(tx, tenantId, company.timezone, resolved, now),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    reports.set(key, { period, report });
    outcome.reports += 1;
  }

  return deps.db.run(scope, async (tx) => {
    const locked = await tx
      .select({
        id: reportEmailSubscriptions.id,
        membershipId: reportEmailSubscriptions.membershipId,
        frequency: reportEmailSubscriptions.frequency,
        nextSendAt: reportEmailSubscriptions.nextSendAt,
        lastPeriodFrom: reportEmailSubscriptions.lastPeriodFrom,
      })
      .from(reportEmailSubscriptions)
      .where(
        and(
          eq(reportEmailSubscriptions.tenantId, tenantId),
          inArray(
            reportEmailSubscriptions.id,
            due.map((s) => s.id),
          ),
          lte(reportEmailSubscriptions.nextSendAt, now),
        ),
      )
      .orderBy(asc(reportEmailSubscriptions.id))
      .for('update');
    if (locked.length === 0) return outcome;
    // Locked for share until the emails are queued: a member's suspension, removal or change of
    // role waits for this, or comes first and is seen here.
    const members = new Map(
      (
        await tx
          .select({
            id: memberships.id,
            status: memberships.status,
            roles: memberships.roles,
            email: users.email,
          })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.tenantId, tenantId),
              inArray(memberships.id, [...new Set(locked.map((s) => s.membershipId))]),
            ),
          )
          .orderBy(asc(memberships.id))
          .for('share', { of: memberships })
      ).map((m) => [m.id, m]),
    );
    for (const s of locked) {
      const row = and(
        eq(reportEmailSubscriptions.tenantId, tenantId),
        eq(reportEmailSubscriptions.id, s.id),
      );
      const member = members.get(s.membershipId);
      if (
        !member ||
        member.status !== 'active' ||
        !permissionsForRoles(member.roles as TenantRole[]).has('reports.read')
      ) {
        await tx.delete(reportEmailSubscriptions).where(row);
        outcome.stopped += 1;
        continue;
      }
      const next = nextReportEmailAt(s.frequency, company.timezone, now);
      const period = classify(s);
      if (typeof period === 'string') {
        await tx
          .update(reportEmailSubscriptions)
          .set({ nextSendAt: next, updatedAt: now })
          .where(row);
        outcome[period] += 1;
        continue;
      }
      const computed = reports.get(periodKey(s.frequency, period.from));
      // Due since the report was computed: the next signal sends it.
      if (!computed) continue;
      const path = `/c/${company.slug}/reports?preset=custom&from=${period.from}&to=${period.to}`;
      await enqueueEmail(deps.outbox, tx, {
        to: member.email,
        tenantId,
        // One email per member's choice and period, whatever retries the job takes.
        dedupeKey: `report-email:${s.id}:${period.from}`,
        payload: reportEmailPayload({
          frequency: s.frequency,
          companyName: company.name,
          timezone: company.timezone,
          period,
          report: computed.report,
          url: new URL(path, deps.appBaseUrl).toString(),
        }),
      });
      await tx
        .update(reportEmailSubscriptions)
        .set({
          nextSendAt: next,
          lastPeriodFrom: period.from,
          lastPeriodTo: period.to,
          lastSentAt: now,
          updatedAt: now,
        })
        .where(row);
      outcome.sent += 1;
    }
    return outcome;
  });
}
