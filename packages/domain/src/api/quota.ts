import type { Database } from '@w360/db';
import { API_NOT_IN_PLAN, consumeApiRequest } from '../plans/entitlements';
import type { ApiContext } from './context';

/** Whether a request may go on, and the refusal the API sends when not (ADR-061). */
export type ApiAdmission =
  | { ok: true }
  | {
      ok: false;
      status: 403 | 429;
      code: 'forbidden' | 'rate_limited';
      reason: 'not_in_plan' | 'quota_exceeded';
      message: string;
      /** Seconds until the next usage period, for Retry-After. */
      retryAfterSeconds: number | null;
    };

/** Whole seconds from `now` until `end`, at least 1. */
export const secondsUntil = (end: Date, now: Date): number =>
  Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 1000));

/**
 * Counts the request against the company's monthly API requests (ADR-061), after authentication and
 * the rate limits and before the request is read: refused when the plan leaves the API out or the
 * month's requests are used up.
 */
export async function admitApiRequest(
  db: Database,
  ctx: ApiContext,
  now: Date,
): Promise<ApiAdmission> {
  const counted = await db.run(ctx.scope, (tx) => consumeApiRequest(tx, ctx.tenant.id, now));
  if (counted.ok) return { ok: true };
  if (counted.reason === 'not_in_plan') {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      reason: 'not_in_plan',
      message: API_NOT_IN_PLAN,
      retryAfterSeconds: null,
    };
  }
  return {
    ok: false,
    status: 429,
    code: 'rate_limited',
    reason: 'quota_exceeded',
    message: `Your company's plan allows ${counted.limit.toLocaleString('en-US')} API requests a month, and all are used. Requests are accepted again from ${counted.periodEnd.toISOString()}.`,
    retryAfterSeconds: secondsUntil(counted.periodEnd, now),
  };
}
