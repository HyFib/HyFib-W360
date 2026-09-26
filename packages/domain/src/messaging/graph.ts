/**
 * Minimal typed client for the Meta Graph API endpoints we use (docs/research/meta-whatsapp.md).
 * - Version pinned by configuration (e.g. v26.0).
 * - Tokens travel in the Authorization header, except where Meta documents query parameters
 *   (OAuth code exchange, debug_token). URLs are never logged.
 * - Every call has a timeout and returns a classified result instead of throwing:
 *   `retryable`   the request was rejected in a way that is safe to retry (rate limits, 5xx, or
 *                 a connection that failed before the request could be sent);
 *   `permanent`   do not retry (validation, policy, closed service window...);
 *   `auth`        the token is invalid or revoked (reconnect required);
 *   `unknown`     the request may have reached Meta but no response was received (timeouts,
 *                 resets). Callers must NOT blindly retry sends in this case.
 */
export type GraphFailureKind = 'retryable' | 'permanent' | 'auth' | 'unknown';

export type GraphResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      kind: GraphFailureKind;
      httpStatus?: number;
      code?: number;
      subcode?: number;
      title: string;
      detail?: string;
    };

export interface GraphClientOptions {
  baseUrl: string;
  version: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007, 130429, 131056]);
const TRANSIENT_CODES = new Set([1, 2, 131000]);
const AUTH_CODES = new Set([190, 102, 10]);

/** Errors raised before any bytes reached the server: safe to retry. */
const PRE_SEND_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function causeCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let i = 0; i < 4 && current; i += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function classifyGraphError(
  httpStatus: number,
  body: unknown,
): Extract<GraphResult<never>, { ok: false }> {
  const err = (body as { error?: Record<string, unknown> } | null)?.error ?? {};
  const code = typeof err.code === 'number' ? err.code : undefined;
  const subcode = typeof err.error_subcode === 'number' ? err.error_subcode : undefined;
  const title =
    typeof err.error_user_title === 'string'
      ? err.error_user_title
      : typeof err.type === 'string'
        ? err.type
        : `HTTP ${httpStatus}`;
  const detail = typeof err.message === 'string' ? err.message.slice(0, 500) : undefined;
  let kind: GraphFailureKind;
  if ((code !== undefined && AUTH_CODES.has(code)) || httpStatus === 401) kind = 'auth';
  else if (httpStatus === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code)))
    kind = 'retryable';
  else if (httpStatus >= 500 || (code !== undefined && TRANSIENT_CODES.has(code)))
    kind = 'retryable';
  else kind = 'permanent';
  return {
    ok: false,
    kind,
    httpStatus,
    ...(code !== undefined ? { code } : {}),
    ...(subcode !== undefined ? { subcode } : {}),
    title,
    ...(detail ? { detail } : {}),
  };
}

export class GraphClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GraphClientOptions) {
    if (!/^v\d+\.\d+$/.test(options.version)) throw new Error('Invalid Graph API version');
    this.base = `${options.baseUrl.replace(/\/$/, '')}/${options.version}`;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { token?: string; query?: Record<string, string>; body?: unknown },
    map: (json: Record<string, unknown>) => T | null,
  ): Promise<GraphResult<T>> {
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const code = causeCode(error);
      if (code && PRE_SEND_ERROR_CODES.has(code)) {
        return { ok: false, kind: 'retryable', title: 'connection_failed', detail: code };
      }
      return {
        ok: false,
        kind: 'unknown',
        title: 'no_response',
        ...(code ? { detail: code } : {}),
      };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      if (response.ok)
        return {
          ok: false,
          kind: 'unknown',
          httpStatus: response.status,
          title: 'unreadable_response',
        };
      return classifyGraphError(response.status, null);
    }
    if (!response.ok) return classifyGraphError(response.status, json);
    const mapped =
      typeof json === 'object' && json !== null ? map(json as Record<string, unknown>) : null;
    if (mapped === null)
      return {
        ok: false,
        kind: 'unknown',
        httpStatus: response.status,
        title: 'unexpected_response_shape',
      };
    return { ok: true, data: mapped };
  }

  /** POST /{phone-number-id}/messages */
  sendMessage(phoneNumberId: string, token: string, body: Record<string, unknown>) {
    return this.request(
      'POST',
      `/${encodeURIComponent(phoneNumberId)}/messages`,
      { token, body },
      (json) => {
        const messages = json.messages as { id?: unknown }[] | undefined;
        const id = messages?.[0]?.id;
        return typeof id === 'string' && id.length > 0 ? { messageId: id } : null;
      },
    );
  }

  /** GET /oauth/access_token (Embedded Signup code exchange; the code is valid for 30 seconds). */
  exchangeCode(appId: string, appSecret: string, code: string) {
    return this.request(
      'GET',
      '/oauth/access_token',
      { query: { client_id: appId, client_secret: appSecret, code } },
      (json) => (typeof json.access_token === 'string' ? { accessToken: json.access_token } : null),
    );
  }

  /** GET /debug_token with an app access token ("app_id|app_secret"). */
  debugToken(inputToken: string, appId: string, appSecret: string) {
    return this.request(
      'GET',
      '/debug_token',
      { query: { input_token: inputToken, access_token: `${appId}|${appSecret}` } },
      (json) => {
        const data = json.data as Record<string, unknown> | undefined;
        if (!data) return null;
        const granular = Array.isArray(data.granular_scopes)
          ? (data.granular_scopes as { scope?: unknown; target_ids?: unknown }[]).map((g) => ({
              scope: String(g.scope ?? ''),
              targetIds: Array.isArray(g.target_ids) ? g.target_ids.map(String) : [],
            }))
          : [];
        return {
          appId: typeof data.app_id === 'string' ? data.app_id : String(data.app_id ?? ''),
          isValid: data.is_valid === true,
          scopes: Array.isArray(data.scopes) ? data.scopes.map(String) : [],
          granularScopes: granular,
          expiresAt:
            typeof data.expires_at === 'number' && data.expires_at > 0
              ? new Date(data.expires_at * 1000)
              : null,
        };
      },
    );
  }

  /** GET /{waba-id}/phone_numbers */
  listPhoneNumbers(wabaId: string, token: string) {
    return this.request('GET', `/${encodeURIComponent(wabaId)}/phone_numbers`, { token }, (json) =>
      Array.isArray(json.data)
        ? { ids: (json.data as { id?: unknown }[]).map((p) => String(p.id ?? '')) }
        : null,
    );
  }

  /** GET /{phone-number-id}?fields=... */
  getPhoneNumber(phoneNumberId: string, token: string) {
    return this.request(
      'GET',
      `/${encodeURIComponent(phoneNumberId)}`,
      {
        token,
        query: {
          fields:
            'display_phone_number,verified_name,quality_rating,name_status,code_verification_status',
        },
      },
      (json) => ({
        displayPhoneNumber:
          typeof json.display_phone_number === 'string' ? json.display_phone_number : null,
        verifiedName: typeof json.verified_name === 'string' ? json.verified_name : null,
        qualityRating: typeof json.quality_rating === 'string' ? json.quality_rating : null,
        nameStatus: typeof json.name_status === 'string' ? json.name_status : null,
        codeVerificationStatus:
          typeof json.code_verification_status === 'string' ? json.code_verification_status : null,
      }),
    );
  }

  /** POST /{waba-id}/subscribed_apps */
  subscribeApp(wabaId: string, token: string) {
    return this.request(
      'POST',
      `/${encodeURIComponent(wabaId)}/subscribed_apps`,
      { token, body: {} },
      (json) => (json.success === true ? { subscribed: true } : null),
    );
  }

  /** POST /{phone-number-id}/register with a six-digit two-step verification PIN. */
  registerNumber(phoneNumberId: string, token: string, pin: string) {
    if (!/^\d{6}$/.test(pin)) throw new Error('PIN must be six digits');
    return this.request(
      'POST',
      `/${encodeURIComponent(phoneNumberId)}/register`,
      { token, body: { messaging_product: 'whatsapp', pin } },
      (json) => (json.success === true ? { registered: true } : null),
    );
  }
}
