import { createHash } from 'node:crypto';
import { EgressError, type EgressClient, type EgressRequest } from '@w360/core/egress';
import { WEBHOOK_LIMITS } from './model';

/**
 * OAuth 2.0 client credentials for webhook endpoints (ADR-173). An endpoint may get an access token
 * from its receiver's authorization server and send it as a bearer token with every delivery: the
 * token request of RFC 6749 section 4.4 (`grant_type=client_credentials`, the client authenticated
 * with HTTP Basic as section 2.3.1 says) and the bearer usage of RFC 6750 section 2.1. Only what a
 * client needs is here: the request, reading the answer of section 5.1 or the refusal of 5.2, and
 * the tokens a worker keeps in memory.
 */

/** Binds an endpoint's OAuth client secret to its company and the endpoint. */
export const webhookOAuthSecretAad = (tenantId: string, endpointId: string) =>
  `webhook-oauth-secret:${tenantId}:${endpointId}`;

/** An endpoint's OAuth client, its secret opened. */
export interface WebhookOAuthClient {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** The scope to ask for (space-separated scope tokens), or none. */
  scope: string | null;
}

/** An access token from the authorization server. */
export interface WebhookOAuthToken {
  accessToken: string;
  /**
   * Until when HyFib uses it for later deliveries: a minute before it expires, and at most a day
   * after it was obtained. Null when the answer gave no lifetime, or one of two minutes or less:
   * then it serves only the deliveries being sent with it.
   */
  usableUntil: Date | null;
}

export type WebhookOAuthTokenResult =
  { ok: true; token: WebhookOAuthToken } | { ok: false; error: string };

/**
 * A client identifier or secret: visible ASCII and space (RFC 6749 A.1, A.2). The schemas refuse an
 * empty one with their own message.
 */
export const WEBHOOK_OAUTH_CLIENT_RE = /^[\x20-\x7e]*$/;
/** A scope: scope tokens separated by single spaces (RFC 6749 section 3.3). */
export const WEBHOOK_OAUTH_SCOPE_RE = /^[\x21\x23-\x5b\x5d-\x7e]+( [\x21\x23-\x5b\x5d-\x7e]+)*$/;
/** A token a bearer header can carry: RFC 6750's b64token. */
const BEARER_TOKEN_RE = /^[A-Za-z0-9\-._~+/]+=*$/;

/** Kept at most this long, and dropped this long before it expires. */
const MAX_KEPT_SECONDS = 86_400;
const EXPIRY_MARGIN_SECONDS = 60;

/** `application/x-www-form-urlencoded`, as RFC 6749 Appendix B encodes a name or a value. */
const formEncode = (value: string) => new URLSearchParams([['', value]]).toString().slice(1);

/**
 * The token request (RFC 6749 section 4.4.2): `grant_type=client_credentials`, with the scope when
 * one is set, the client authenticated with HTTP Basic (section 2.3.1: its identifier and secret
 * each form-encoded, joined by a colon, base64-encoded). Sent through the egress client, like
 * deliveries, so the authorization server is held to the same address rules.
 */
export function webhookOAuthTokenRequest(
  client: WebhookOAuthClient,
  userAgent: string,
): EgressRequest {
  const form = new URLSearchParams([['grant_type', 'client_credentials']]);
  if (client.scope) form.append('scope', client.scope);
  const basic = Buffer.from(
    `${formEncode(client.clientId)}:${formEncode(client.clientSecret)}`,
    'utf8',
  ).toString('base64');
  return {
    method: 'POST',
    url: client.tokenUrl,
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'user-agent': userAgent,
    },
    body: form.toString(),
  };
}

/** A lifetime in seconds as RFC 6749 section 5.1 gives it (a few servers send it as a string). */
function lifetimeSeconds(value: unknown): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d{1,10}$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Reads the authorization server's answer: a 200 with a JSON object holding a bearer
 * `access_token` (RFC 6749 section 5.1, RFC 6750) is a token; any other status is a refusal
 * (`oauth_token_refused_<status>`), and a 200 without a usable bearer token is
 * `oauth_token_invalid`. Nothing of the answer but the token is kept.
 */
export function readWebhookOAuthTokenAnswer(
  answer: { status: number; body: Buffer },
  obtainedAt: Date,
): WebhookOAuthTokenResult {
  if (answer.status !== 200) {
    const known = Number.isInteger(answer.status) && answer.status >= 100 && answer.status <= 599;
    return {
      ok: false,
      error: known ? `oauth_token_refused_${answer.status}` : 'oauth_token_refused',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body.toString('utf8'));
  } catch {
    return { ok: false, error: 'oauth_token_invalid' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'oauth_token_invalid' };
  }
  const fields = parsed as Record<string, unknown>;
  const accessToken = fields.access_token;
  if (
    typeof accessToken !== 'string' ||
    accessToken.length > WEBHOOK_LIMITS.oauthTokenLength ||
    !BEARER_TOKEN_RE.test(accessToken) ||
    typeof fields.token_type !== 'string' ||
    fields.token_type.toLowerCase() !== 'bearer'
  ) {
    return { ok: false, error: 'oauth_token_invalid' };
  }
  const lifetime = lifetimeSeconds(fields.expires_in);
  const kept = lifetime === null ? 0 : Math.min(lifetime, MAX_KEPT_SECONDS) - EXPIRY_MARGIN_SECONDS;
  return {
    ok: true,
    token: {
      accessToken,
      usableUntil:
        kept > EXPIRY_MARGIN_SECONDS ? new Date(obtainedAt.getTime() + kept * 1000) : null,
    },
  };
}

/** The error a token request that failed in the egress client records (`oauth_token_timeout`). */
export const webhookOAuthEgressError = (code: string) => `oauth_token_${code}`;

/**
 * Asks the endpoint's authorization server for a token through the egress client, which holds it to
 * the same address rules as deliveries; the token's lifetime counts from when it was asked for. A
 * request the egress client refused, or that failed, is `oauth_token_<its code>`.
 */
export async function fetchWebhookOAuthToken(
  egress: EgressClient,
  client: WebhookOAuthClient,
  userAgent: string,
  now: () => Date,
): Promise<WebhookOAuthTokenResult> {
  const askedAt = now();
  try {
    return readWebhookOAuthTokenAnswer(
      await egress.request(webhookOAuthTokenRequest(client, userAgent)),
      askedAt,
    );
  } catch (error) {
    if (!(error instanceof EgressError)) throw error;
    return { ok: false, error: webhookOAuthEgressError(error.code) };
  }
}

/** An endpoint whose tokens are kept: its company and id. */
export interface WebhookOAuthTokenOwner {
  tenantId: string;
  endpointId: string;
}

/** The endpoints whose tokens a process keeps at most; the least recently used goes first. */
const MAX_KEPT_TOKENS = 1_000;

/** Tells clients apart without keeping their secrets: a hash of everything a token request sends. */
const clientFingerprint = (client: WebhookOAuthClient) =>
  createHash('sha256')
    .update(JSON.stringify([client.tokenUrl, client.clientId, client.clientSecret, client.scope]))
    .digest('base64url');

/**
 * The access tokens a worker keeps for webhook endpoints (ADR-173), in its memory only: never
 * stored, logged or shown. A token is kept for its endpoint and client, so a changed token URL,
 * identifier, secret or scope gets a new one, and until a minute before it expires (at most a day).
 * The deliveries of an endpoint that need a token at the same time share one request; a token
 * without a lifetime serves only them, and a failure is never kept: the next attempt asks again.
 */
export class WebhookOAuthTokenCache {
  readonly #kept = new Map<string, { client: string; token: WebhookOAuthToken }>();
  readonly #asking = new Map<
    string,
    { client: string; result: Promise<WebhookOAuthTokenResult> }
  >();

  constructor(private readonly maxKept: number = MAX_KEPT_TOKENS) {}

  /**
   * A token for the endpoint's client: the one kept, if usable at `now`; the one being asked for;
   * or one asked for now with `ask`.
   */
  token(
    owner: WebhookOAuthTokenOwner,
    client: WebhookOAuthClient,
    now: Date,
    ask: () => Promise<WebhookOAuthTokenResult>,
  ): Promise<WebhookOAuthTokenResult> {
    const key = `${owner.tenantId}:${owner.endpointId}`;
    const fingerprint = clientFingerprint(client);
    const kept = this.#kept.get(key);
    if (kept?.client === fingerprint && kept.token.usableUntil && kept.token.usableUntil > now) {
      // The most recently used last.
      this.#kept.delete(key);
      this.#kept.set(key, kept);
      return Promise.resolve({ ok: true, token: kept.token });
    }
    const asking = this.#asking.get(key);
    if (asking?.client === fingerprint) return asking.result;
    const entry = { client: fingerprint, result: ask() };
    this.#asking.set(key, entry);
    // Runs before the callers' own reactions, so a later call finds the token kept. Only the
    // request still current for the endpoint keeps what it got.
    const settle = (result: WebhookOAuthTokenResult | null) => {
      if (this.#asking.get(key) !== entry) return;
      this.#asking.delete(key);
      if (result?.ok && result.token.usableUntil) this.#keep(key, fingerprint, result.token);
    };
    entry.result.then(settle, () => settle(null));
    return entry.result;
  }

  /** Forgets the endpoint's token if it is still `accessToken`: its receiver refused it. */
  drop(owner: WebhookOAuthTokenOwner, accessToken: string): void {
    const key = `${owner.tenantId}:${owner.endpointId}`;
    if (this.#kept.get(key)?.token.accessToken === accessToken) this.#kept.delete(key);
  }

  #keep(key: string, client: string, token: WebhookOAuthToken): void {
    this.#kept.delete(key);
    if (this.#kept.size >= this.maxKept) {
      const oldest = this.#kept.keys().next();
      if (!oldest.done) this.#kept.delete(oldest.value);
    }
    this.#kept.set(key, { client, token });
  }
}
