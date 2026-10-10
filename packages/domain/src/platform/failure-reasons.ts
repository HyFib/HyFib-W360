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
 * The year's failed sends by reason (ADR-350), from the counts the worker keeps as days pass: the
 * codes of the days whose failed sends by code are counted, and how many of the 365 days before
 * today are not counted yet.
 */
export interface FailureReasonYear {
  reasons: FailureReasons;
  /** Days of the 365 before today whose failed sends by code are not counted yet. */
  uncounted: number;
}

/**
 * The year's failed sends by code, the platform's or one company's (platform administrators;
 * companies deleted are left out), with the days not counted yet. Read in one snapshot, so the
 * days counted are those the reasons cover.
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
  return {
    reasons: failureReasons(
      result.rows.map((r) => ({
        code: r.reason_code,
        failed: Number(r.failed_sends),
        codes: Number(r.codes),
      })),
    ),
    uncounted: MESSAGE_DAYS_KEPT - Number(row.days),
  };
}
