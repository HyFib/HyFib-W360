import type { Database } from '@w360/db';
import { API_NOT_IN_PLAN, consumeApiRequest } from '../plans/entitlements';
import type { ApiContext, ApiKeyContext } from './context';

/**
 * Whether a request may go on, with its context under the plan (ADR-092), and the refusal the API
 * sends when not (ADR-061, ADR-097).
 */
export type ApiAdmission =
  | { ok: true; ctx: ApiContext }
  | {
      ok: false;
      status: 403 | 429;
      code: 'forbidden' | 'rate_limited';
      reason: 'not_in_plan' | 'quota_exceeded' | 'key_quota_exceeded';
      message: string;
      /** Seconds until the next usage period, for Retry-After. */
      retryAfterSeconds: number | null;
    };

/** Whole seconds from `now` until `end`, at least 1. */
export const secondsUntil = (end: Date, now: Date): number =>
  Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 1000));

/**
 * Counts the request against its key's and its company's monthly API requests (ADR-061, ADR-097),
 * after authentication and the rate limits and before the request is read: refused when the plan
 * leaves the API out, or the key's or the company's requests for the month are used up. An
 * admitted request may use only the scopes the plan includes (ADR-092), which its context carries.
 */
export async function admitApiRequest(
  db: Database,
  key: ApiKeyContext,
  now: Date,
): Promise<ApiAdmission> {
  const counted = await db.run(key.scope, (tx) =>
    consumeApiRequest(tx, key.tenant.id, key.key.id, now),
  );
  if (counted.ok) return { ok: true, ctx: { ...key, planScopes: counted.apiScopes } };
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
  if (counted.reason === 'key_quota_exceeded') {
    return {
      ok: false,
      status: 429,
      code: 'rate_limited',
      reason: 'key_quota_exceeded',
      message: `This API key allows ${counted.limit.toLocaleString('en-US')} requests a month, and all are used. Requests are accepted again from ${counted.periodEnd.toISOString()}, or once the key's limit is raised in Settings → API keys.`,
      retryAfterSeconds: secondsUntil(counted.periodEnd, now),
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
