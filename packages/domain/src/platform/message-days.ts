import { sql, systemScope, type Database, type Tx } from '@w360/db';
import type { OpsDailyActivity } from './ops';

/**
 * Messages a day kept as days pass (P5-10, ADR-341). The Usage tab counts messages a day live, 93
 * days back at most (ADR-333); the worker now counts each UTC day once it has ended, for every
 * company not deleted, and keeps the counts, so the tab can draw a year. A few days a run, newest
 * first, back to 365 days before today; the 7 days before today are counted again once a day while
 * statuses Meta reports late arrive, and older days keep their counts. Counts only: never a contact,
 * a message or its text.
 */

/** Days the year reads: the 365 before today. */
export const MESSAGE_DAYS_KEPT = 365;
/** Days one run of the counting job counts at most (`ops.count_platform_message_days`). */
export const MESSAGE_DAYS_PER_RUN = 3;
/** The counting job's key: one run waits and one runs at most. */
export const MESSAGE_DAYS_JOB_KEY = 'message-days';

/** A kept day as read: its counts, and whether it was counted yet. */
export interface KeptMessageDay extends OpsDailyActivity {
  counted: boolean;
}

/** The year as the Usage tab draws it. */
export interface MessageYear {
  /** The run of counted days that ends at the latest one counted, oldest first. */
  days: OpsDailyActivity[];
  /** Days of the 365 not counted yet. */
  uncounted: number;
}

/**
 * The days to draw: the latest days not counted yet are left out (the worker counts a day after it
 * ends), and so is everything before the last day not counted before them, so the days drawn are
 * consecutive and each was counted.
 */
export function messageYear(days: readonly KeptMessageDay[]): MessageYear {
  const counted = (i: number) => days[i]?.counted === true;
  let end = days.length;
  while (end > 0 && !counted(end - 1)) end -= 1;
  let start = end;
  while (start > 0 && counted(start - 1)) start -= 1;
  return {
    days: days.slice(start, end).map(({ day, outbound, failed, inbound }) => ({
      day,
      outbound,
      failed,
      inbound,
    })),
    uncounted: days.filter((d) => !d.counted).length,
  };
}

/**
 * The kept days before today, oldest first (platform administrators): every company's not deleted,
 * or one company's, each with whether it was counted yet.
 */
export async function keptMessageDays(
  tx: Tx,
  days: number,
  tenantId: string | null,
): Promise<KeptMessageDay[]> {
  const result = await tx.execute<{
    day: string;
    outbound: number;
    failed: number;
    inbound: number;
    counted: boolean;
  }>(sql`
    select to_char(utc_day, 'YYYY-MM-DD') as day, outbound, failed, inbound, counted
      from ops.platform_ops_message_days(${days}::int, ${tenantId}::uuid)
     order by utc_day`);
  return result.rows.map((r) => ({
    day: String(r.day),
    outbound: Number(r.outbound),
    failed: Number(r.failed),
    inbound: Number(r.inbound),
    counted: r.counted === true,
  }));
}

/**
 * The counting job (every minute): counts up to `limit` days due, newest first, each in a
 * transaction (and a statement) of its own, so a day's count has the whole statement timeout and
 * the days counted before it stay counted; stops at the first call that finds none due. Each call
 * also deletes the counts older than 400 days and those of deleted companies. How many days it
 * counted.
 */
export async function countMessageDays(
  deps: { db: Database },
  limit: number = MESSAGE_DAYS_PER_RUN,
): Promise<{ counted: number }> {
  let counted = 0;
  for (let i = 0; i < limit; i += 1) {
    const result = await deps.db.run(systemScope, (tx) =>
      tx.execute<{ counted: number }>(sql`select ops.count_platform_message_days(1) as counted`),
    );
    if (Number(result.rows[0]?.counted ?? 0) === 0) break;
    counted += 1;
  }
  return { counted };
}
