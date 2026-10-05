import 'server-only';
import type { NextRequest } from 'next/server';
import { resolveClientIp, sha256Hex, systemClock, toError } from '@w360/core';
import {
  API_LIMITS,
  IDEMPOTENCY_KEY_RE,
  admitApiRate,
  admitApiRequest,
  admitFailedApiAuthentication,
  apiAddressRefusal,
  apiErrorResponse,
  apiRequestError,
  assertNoNulCharacter,
  authenticateApiRequest,
  bearerToken,
  type ApiContext,
  type ApiResponse,
  type IdempotencyInput,
} from '@w360/domain';
import { getRuntime } from './runtime';
import { readLimitedBody } from './webhook-body';

type Runtime = Awaited<ReturnType<typeof getRuntime>>;

/** What an API handler gets: the key's context, the runtime and the parsed request parts. */
export interface ApiCall {
  ctx: ApiContext;
  runtime: Runtime;
  /** The JSON body (POST, PATCH), already parsed. */
  body: unknown;
  /** The Idempotency-Key header with the request's hash, when the header was sent. */
  idempotency: IdempotencyInput | null;
  query: Record<string, string>;
}

type HandlerResult = ApiResponse | { status: number; body: Record<string, unknown> };

// Responses are never cached: next.config sets `Cache-Control: private, no-store` for them.
const baseHeaders = (requestId: string): HeadersInit => ({
  'Content-Type': 'application/json; charset=utf-8',
  'X-Request-Id': requestId,
});

function respond(
  status: number,
  body: unknown,
  requestId: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...baseHeaders(requestId), ...extra },
  });
}

/**
 * Runs one public API request (ADR-052): authenticates the bearer key from the client's address
 * (failed attempts, and keys that do not accept the address (ADR-076), are limited per client
 * address), applies the key's and the company's rate limits, counts the request against the plan's
 * monthly API requests (ADR-061), reads a bounded JSON body, checks the Idempotency-Key header,
 * refuses text holding the NUL character (ADR-124), and turns results and errors into JSON
 * responses. Tokens are never logged.
 */
export async function handleApiRequest(
  request: NextRequest,
  handler: (call: ApiCall) => Promise<HandlerResult>,
  options: { json?: boolean; idempotency?: 'required' | 'optional' } = {},
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const runtime = await getRuntime();
  const log = runtime.logger;
  const path = request.nextUrl.pathname;
  try {
    const token = bearerToken(request.headers.get('authorization'));
    const ip = resolveClientIp(
      request.headers.get('x-forwarded-for'),
      request.headers.get('x-real-ip'),
      runtime.trustedProxies,
    );
    const auth = token ? await authenticateApiRequest(runtime.db, token, requestId, ip) : null;
    if (!auth || 'refused' in auth) {
      if (!(await admitFailedApiAuthentication(runtime.db, ip))) {
        const e = apiRequestError(429, 'rate_limited', 'Too many failed attempts.', requestId);
        return respond(e.status, e.body, requestId, { 'Retry-After': '60' });
      }
      if (auth) {
        log.info(
          {
            requestId,
            method: request.method,
            path,
            tenantId: auth.tenantId,
            apiKeyId: auth.keyId,
          },
          auth.by === 'company'
            ? 'api request refused: the company does not accept the address'
            : 'api request refused: the key does not accept the address',
        );
        const e = apiRequestError(
          403,
          'forbidden',
          apiAddressRefusal(auth.by, ip),
          requestId,
          'ip_not_allowed',
        );
        return respond(e.status, e.body, requestId);
      }
      const e = apiRequestError(
        401,
        'unauthenticated',
        'Send a valid API key as "Authorization: Bearer <key>".',
        requestId,
      );
      return respond(e.status, e.body, requestId, { 'WWW-Authenticate': 'Bearer' });
    }
    const key = auth.authenticated;

    if (!(await admitApiRate(runtime.db, { keyId: key.key.id, tenantId: key.tenant.id }))) {
      const e = apiRequestError(429, 'rate_limited', 'Too many requests. Slow down.', requestId);
      return respond(e.status, e.body, requestId, { 'Retry-After': '1' });
    }

    // The plan's monthly API requests (ADR-061): counted here, before the request is read. The
    // handler gets the admitted context, which holds the request to the plan's scopes (ADR-092).
    const admission = await admitApiRequest(runtime.db, key, systemClock.now());
    if (!admission.ok) {
      const e = apiRequestError(
        admission.status,
        admission.code,
        admission.message,
        requestId,
        admission.reason,
      );
      return respond(
        e.status,
        e.body,
        requestId,
        admission.retryAfterSeconds === null
          ? {}
          : { 'Retry-After': String(admission.retryAfterSeconds) },
      );
    }
    const { ctx } = admission;

    let body: unknown = undefined;
    let raw = '';
    if (options.json) {
      const type = request.headers.get('content-type') ?? '';
      if (!/^application\/json(;|$)/i.test(type.trim())) {
        const e = apiRequestError(
          415,
          'bad_request',
          'Send the body as JSON with Content-Type: application/json.',
          requestId,
        );
        return respond(e.status, e.body, requestId);
      }
      const bytes = await readLimitedBody(request, API_LIMITS.bodyBytes);
      if (!bytes) {
        const e = apiRequestError(413, 'bad_request', 'The body is larger than 64 KB.', requestId);
        return respond(e.status, e.body, requestId);
      }
      raw = bytes.toString('utf8');
      try {
        body = JSON.parse(raw);
      } catch {
        const e = apiRequestError(400, 'bad_request', 'The body is not valid JSON.', requestId);
        return respond(e.status, e.body, requestId);
      }
    }

    let idempotency: IdempotencyInput | null = null;
    const idempotencyKey = request.headers.get('idempotency-key');
    if (options.idempotency && idempotencyKey !== null) {
      if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
        const e = apiRequestError(
          400,
          'bad_request',
          'The Idempotency-Key header must be 1 to 255 visible ASCII characters.',
          requestId,
        );
        return respond(e.status, e.body, requestId);
      }
      idempotency = {
        key: idempotencyKey,
        requestHash: sha256Hex(`${request.method} ${path}\n${raw}`),
      };
    } else if (options.idempotency === 'required') {
      const e = apiRequestError(
        400,
        'bad_request',
        'Send an Idempotency-Key header (for example a UUID) so a retry never does the work twice.',
        requestId,
      );
      return respond(e.status, e.body, requestId);
    }

    const query = Object.fromEntries(request.nextUrl.searchParams.entries());
    // Text PostgreSQL cannot store is refused here, naming where it is, not failed in a query.
    assertNoNulCharacter(query, body);
    const result = await handler({ ctx, runtime, body, idempotency, query });
    const replayed = 'replayed' in result && result.replayed;
    log.info(
      {
        requestId,
        method: request.method,
        path,
        status: result.status,
        tenantId: ctx.tenant.id,
        apiKeyId: ctx.key.id,
        replayed,
      },
      'api request',
    );
    return respond(
      result.status,
      result.body,
      requestId,
      replayed ? { 'Idempotent-Replayed': 'true' } : {},
    );
  } catch (error) {
    const mapped = apiErrorResponse(error, requestId);
    if (mapped.internal) {
      log.error(
        { requestId, method: request.method, path, err: toError(error) },
        'api request failed',
      );
    }
    return respond(mapped.status, mapped.body, requestId);
  }
}
