import { sql, type Tx } from '@w360/db';
import { MESSAGE_DAYS_KEPT } from './message-days';

/**
 * Failed sends by reason (P5-10, ADR-347). A failed message keeps the code it failed with: Meta's,
 * from the status webhook or the answer to the send (or that answer's HTTP status when it carried no
 * code), or HyFib's own when the send was refused before it left or its last attempt could not reach
 * Meta. The Usage tab and a company's platform page list a window's failed sends by code, the
 * most frequent first, so platform staff see why sends fail without opening a company's inbox.
 * Codes and counts only: never a contact, a message or its error title.
 */

/**
 * Codes listed one by one (`ops.platform_ops_failure_reasons`); the rest share one row when two or
 * more are left, and a ninth alone is listed.
 */
export const FAILURE_REASONS_SHOWN = 8;

/** A code the window's failed sends failed with, as listed. */
export interface FailureReason {
  /** The code; '' for failures recorded without one; null for the rest of the codes together. */
  code: string | null;
  /** The failed sends with it. */
  failed: number;
  /** How many codes the row holds: 1, or the rest's. */
  codes: number;
  /** Its share of the window's failed sends, from 0 to 1. */
  share: number;
}

export interface FailureReasons {
  /** The most frequent codes first, ties by code, then the rest; none when no send failed. */
  reasons: FailureReason[];
  /** The window's failed sends. */
  failed: number;
}

/** The rows as listed, each with its share of all the failed sends in them. */
export function failureReasons(
  rows: readonly { code: string | null; failed: number; codes: number }[],
): FailureReasons {
  const failed = rows.reduce((total, r) => total + r.failed, 0);
  return {
    reasons: rows.map((r) => ({ ...r, share: failed > 0 ? r.failed / failed : 0 })),
    failed,
  };
}

/**
 * The failed sends since `since` (at most 93 days back) by code, the platform's or one company's
 * (platform administrators; companies deleted are left out).
 */
export async function readFailureReasons(
  tx: Tx,
  since: Date,
  tenantId: string | null,
): Promise<FailureReasons> {
  const result = await tx.execute<{
    reason_code: string | null;
    failed_sends: number | string;
    codes: number | string;
  }>(sql`
    select reason_code, failed_sends, codes
      from ops.platform_ops_failure_reasons(${since.toISOString()}::timestamptz, ${tenantId}::uuid)
     order by reason_code is null, failed_sends desc, reason_code`);
  return failureReasons(
    result.rows.map((r) => ({
      code: r.reason_code,
      failed: Number(r.failed_sends),
      codes: Number(r.codes),
    })),
  );
}

/**
 * A UTC calendar month the year's failed sends by reason span (ADR-360). The year starts 365 days
 * before today and ends yesterday, so its first month is partial unless it starts on the 1st, and
 * its last unless today is the 1st.
 */
export interface FailureReasonMonth {
  /** The month, YYYY-MM. */
  month: string;
  /** The days of it the year holds. */
  days: number;
  /** Whether the year holds only some of its days. */
  partial: boolean;
}

/**
 * The year's failed sends by reason (ADR-350), from the counts the worker keeps as days pass: the
 * codes of the days whose failed sends by code are counted, and how many of the 365 days before
 * today are not counted yet; and each listed reason's failed sends month by month (ADR-360).
 */
export interface FailureReasonYear {
  reasons: FailureReasons;
  /** Days of the 365 before today whose failed sends by code are not counted yet. */
  uncounted: number;
  /** The months the year spans, oldest first. */
  months: FailureReasonMonth[];
  /** Each listed reason's failed sends in each month, in the order of the reasons and the months. */
  byMonth: number[][];
}

const DAY_MS = 86_400_000;

/** The UTC calendar months of the 365 days before `today` (YYYY-MM-DD), oldest first. */
export function failureReasonYearMonths(today: string): FailureReasonMonth[] {
  const end = /^\d{4}-\d{2}-\d{2}$/.test(today) ? Date.parse(`${today}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(end)) throw new Error(`Not a day: ${today}`);
  const months: FailureReasonMonth[] = [];
  for (let from = end - MESSAGE_DAYS_KEPT * DAY_MS; from < end;) {
    const day = new Date(from);
    const year = day.getUTCFullYear();
    const month = day.getUTCMonth();
    const next = Date.UTC(year, month + 1, 1);
    const days = Math.round((Math.min(next, end) - from) / DAY_MS);
    months.push({
      month: `${year}-${String(month + 1).padStart(2, '0')}`,
      days,
      partial: days < Math.round((next - Date.UTC(year, month, 1)) / DAY_MS),
    });
    from = next;
  }
  return months;
}

/**
 * Each listed reason's failed sends in each month (ADR-360), in the order of the reasons and of
 * the months, 0 for a month without one, from the months' rows, which name the rest of the codes
 * together as the year lists them (null). The rows are read with the year's ranking in its snapshot,
 * so one naming a code or a month the year does not list is an error.
 */
export function failureReasonsByMonth(
  reasons: readonly FailureReason[],
  months: readonly FailureReasonMonth[],
  rows: readonly { month: string; code: string | null; failed: number }[],
): number[][] {
  const byMonth = reasons.map(() => months.map(() => 0));
  for (const row of rows) {
    const reason = reasons.findIndex((r) => r.code === row.code);
    const month = months.findIndex((m) => m.month === row.month);
    const counts = byMonth[reason];
    if (!counts || month < 0) {
      throw new Error(
        `The year's failed sends by month name ${counts ? 'a month' : 'a code'} the year does not list`,
      );
    }
    counts[month] = (counts[month] ?? 0) + row.failed;
  }
  return byMonth;
}

/**
 * The year's failed sends by code, the platform's or one company's (platform administrators;
 * companies deleted are left out), with the days not counted yet and each listed code's months.
 * Read in one snapshot, so the days counted are those the reasons cover, and a code's months add up
 * to its year.
 */
export async function readFailureReasonYear(
  tx: Tx,
  tenantId: string | null,
): Promise<FailureReasonYear> {
  const result = await tx.execute<{
    reason_code: string | null;
    failed_sends: number | string;
    codes: number | string;
  }>(sql`
    select reason_code, failed_sends, codes
      from ops.platform_ops_failure_reason_year(${tenantId}::uuid)
     order by reason_code is null, failed_sends desc, reason_code`);
  const counted = await tx.execute<{ days: number | string }>(
    sql`select ops.platform_ops_failure_reason_days() as days`,
  );
  const [row] = counted.rows;
  if (!row) throw new Error('ops.platform_ops_failure_reason_days answered no row');
  const monthRows = await tx.execute<{
    month: string;
    reason_code: string | null;
    failed_sends: number | string;
  }>(sql`
    select to_char(month, 'YYYY-MM') as month, reason_code, failed_sends
      from ops.platform_ops_failure_reason_months(${tenantId}::uuid)`);
  // The day the functions above take for today: the transaction's.
  const [day] = (
    await tx.execute<{ today: string }>(
      sql`select to_char((now() at time zone 'UTC')::date, 'YYYY-MM-DD') as today`,
    )
  ).rows;
  if (!day) throw new Error('The database answered no day for today');
  const reasons = failureReasons(
    result.rows.map((r) => ({
      code: r.reason_code,
      failed: Number(r.failed_sends),
      codes: Number(r.codes),
    })),
  );
  const months = failureReasonYearMonths(day.today);
  return {
    reasons,
    uncounted: MESSAGE_DAYS_KEPT - Number(row.days),
    months,
    byMonth: failureReasonsByMonth(
      reasons.reasons,
      months,
      monthRows.rows.map((r) => ({
        month: r.month,
        code: r.reason_code,
        failed: Number(r.failed_sends),
      })),
    ),
  };
}
