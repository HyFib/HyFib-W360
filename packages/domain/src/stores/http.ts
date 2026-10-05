import { clipText, parseExternalJson } from '@w360/core';
import { EgressError, type EgressClient, type EgressMethod } from '@w360/core/egress';

/**
 * Requests to stores go through the egress client (address checks, no redirects, size and time
 * limits), whatever the platform: WooCommerce sites are addresses chosen by companies, and Shopify
 * shops are reached the same way for uniform limits. Errors never carry credentials.
 */

export const STORE_USER_AGENT = 'HyFib-W360-Stores/1';

export type StoreApiFailure =
  /** The request may not have arrived, or the store did not answer in time: try again later. */
  | 'unreachable'
  /** The address is not allowed (not https, private or blocked address, bad port). */
  | 'address'
  /** The store rejected the credentials (401/403). */
  | 'unauthorized'
  | 'not_found'
  /** Rate limited (HTTP 429 or Shopify's THROTTLED). */
  | 'throttled'
  /** Another 4xx: the request was refused. */
  | 'rejected'
  | 'server'
  /** The answer was not what the API documents. */
  | 'malformed';

export class StoreApiError extends Error {
  constructor(
    readonly failure: StoreApiFailure,
    message: string,
    readonly status: number | null = null,
    /** For `throttled`: how long to wait before the next request. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'StoreApiError';
  }
}

export interface StoreResponse {
  status: number;
  headers: Record<string, string>;
  /** The parsed JSON body, or null when it is empty or not JSON. */
  json: unknown;
}

const ADDRESS_CODES = new Set([
  'invalid_url',
  'scheme_not_allowed',
  'credentials_in_url',
  'port_not_allowed',
  'address_blocked',
]);

export async function storeRequest(
  egress: EgressClient,
  input: {
    method: EgressMethod;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<StoreResponse> {
  let response;
  try {
    response = await egress.request({
      method: input.method,
      url: input.url,
      headers: {
        'user-agent': STORE_USER_AGENT,
        accept: 'application/json',
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...input.headers,
      },
      body: input.body === undefined ? null : JSON.stringify(input.body),
    });
  } catch (error) {
    if (error instanceof EgressError) {
      throw new StoreApiError(
        ADDRESS_CODES.has(error.code) ? 'address' : 'unreachable',
        error.message,
      );
    }
    throw error;
  }
  let json: unknown = null;
  if (response.body.length > 0) {
    try {
      // Product, order and customer text keeps any NUL character as U+FFFD (ADR-130).
      json = parseExternalJson(response.body.toString('utf8'));
    } catch {
      json = null;
    }
  }
  return { status: response.status, headers: response.headers, json };
}

/** Short, single-line text from a store's error, for status messages (never credentials). */
export function storeErrorText(json: unknown): string | null {
  const pick = (value: unknown): string | null =>
    typeof value === 'string' && value.trim()
      ? clipText(value.replace(/\s+/g, ' ').trim(), 200)
      : null;
  if (typeof json !== 'object' || json === null) return null;
  const record = json as Record<string, unknown>;
  return (
    pick(record.message) ??
    pick(record.error_description) ??
    pick(record.error) ??
    (Array.isArray(record.errors)
      ? pick((record.errors[0] as Record<string, unknown> | undefined)?.message)
      : pick(record.errors))
  );
}

/** Throws the matching `StoreApiError` unless the response is 2xx. */
export function expectOk(response: StoreResponse, what: string): void {
  const { status } = response;
  if (status >= 200 && status < 300) return;
  const detail = storeErrorText(response.json);
  const suffix = detail ? `: ${detail}` : '';
  if (status === 401 || status === 403) {
    throw new StoreApiError(
      'unauthorized',
      `${what} was refused (HTTP ${status})${suffix}`,
      status,
    );
  }
  if (status === 404) {
    throw new StoreApiError('not_found', `${what} was not found (HTTP 404)${suffix}`, status);
  }
  if (status === 429) {
    const retryAfter = Number(response.headers['retry-after']);
    throw new StoreApiError(
      'throttled',
      `${what} was rate limited (HTTP 429)`,
      status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(Math.ceil(retryAfter), 3600) : 60,
    );
  }
  if (status >= 500) {
    throw new StoreApiError('server', `${what} failed at the store (HTTP ${status})`, status);
  }
  if (status >= 300 && status < 400) {
    // Redirects are never followed (a moved site must be connected again at its new address).
    throw new StoreApiError('rejected', `${what} was redirected (HTTP ${status})`, status);
  }
  throw new StoreApiError('rejected', `${what} was refused (HTTP ${status})${suffix}`, status);
}

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
