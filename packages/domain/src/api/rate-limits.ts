import type { Database } from '@w360/db';
import { takeToken } from '../messaging/rate-limit';
import { API_LIMITS } from './model';

/**
 * The public API's rate limits (ADR-052, ADR-068): failed authentication per client address, then
 * each authenticated request per key and per company. Token buckets in PostgreSQL shared by every
 * web replica: a bucket holds a burst (its capacity) and refills continuously.
 */

/**
 * Counts a failed authentication from a client address: false once the address has used up its
 * attempts. Requests whose address could not be resolved share one bucket.
 */
export function admitFailedApiAuthentication(
  db: Database,
  clientIp: string | null,
): Promise<boolean> {
  return takeToken(db, `api:auth-failure:${clientIp ?? 'unknown'}`, API_LIMITS.authFailureRate);
}

/**
 * Takes a token from the key's bucket, then from its company's: false when either is empty. A
 * request the key's bucket refuses takes nothing from the company's, so one busy key does not use up
 * what the company's other keys may send.
 */
export async function admitApiRate(
  db: Database,
  request: { keyId: string; tenantId: string },
): Promise<boolean> {
  if (!(await takeToken(db, `api:key:${request.keyId}`, API_LIMITS.keyRate))) return false;
  return takeToken(db, `api:company:${request.tenantId}`, API_LIMITS.companyRate);
}
