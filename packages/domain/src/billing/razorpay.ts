import { constantTimeEqual, hmacSha256Hex } from '@w360/core';

/**
 * Minimal typed client for the Razorpay endpoints we use (docs/research/razorpay-billing.md). Keys
 * travel only in the Authorization header; URLs are never logged. Every call has a timeout, refuses
 * redirects and returns a classified result instead of throwing:
 *   `retryable` rejected in a way that is safe to retry (429, 5xx, connection refused before send);
 *   `permanent` do not retry as-is (validation, business rule);
 *   `auth`      the API key is wrong or revoked;
 *   `unknown`   the request may have been processed but no response arrived. Orders and recurring
 *               payments have no idempotency key (R-085), so callers reconcile (lookup by receipt or
 *               order payments) before anything is retried.
 */
export type RazorpayFailureKind = 'retryable' | 'permanent' | 'auth' | 'unknown';

export type RazorpayResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      kind: RazorpayFailureKind;
      httpStatus?: number;
      code?: string;
      description: string;
    };

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string | null;
  status: 'created' | 'attempted' | 'paid' | string;
}

export interface RazorpayPayment {
  id: string;
  orderId: string | null;
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed' | string;
  captured: boolean;
  customerId: string | null;
  tokenId: string | null;
  method: string | null;
  errorCode: string | null;
  errorDescription: string | null;
}

export interface RazorpayToken {
  id: string;
  recurringStatus: string | null;
  card: {
    network: string | null;
    issuer: string | null;
    last4: string | null;
    expiryMonth: number | null;
    expiryYear: number | null;
  } | null;
}

export interface RazorpayRefund {
  id: string;
  paymentId: string;
  amount: number;
  status: 'pending' | 'processed' | 'failed' | string;
}

export interface RazorpayDispute {
  id: string;
  paymentId: string;
  amount: number;
  amountDeducted: number;
  status: 'open' | 'under_review' | 'won' | 'lost' | 'closed' | string;
}

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

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function mapPayment(json: Record<string, unknown>): RazorpayPayment | null {
  const id = str(json.id);
  const amount = num(json.amount);
  if (!id || amount === null) return null;
  return {
    id,
    orderId: str(json.order_id),
    amount,
    currency: str(json.currency) ?? '',
    status: str(json.status) ?? 'unknown',
    captured: json.captured === true,
    customerId: str(json.customer_id),
    tokenId: str(json.token_id),
    method: str(json.method),
    errorCode: str(json.error_code),
    errorDescription: str(json.error_description),
  };
}

function mapOrder(json: Record<string, unknown>): RazorpayOrder | null {
  const id = str(json.id);
  const amount = num(json.amount);
  if (!id || amount === null) return null;
  return {
    id,
    amount,
    currency: str(json.currency) ?? '',
    receipt: str(json.receipt),
    status: str(json.status) ?? 'unknown',
  };
}

export class RazorpayClient {
  private readonly base: string;
  private readonly authorization: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    baseUrl: string;
    keyId: string;
    keySecret: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  }) {
    this.base = options.baseUrl.replace(/\/$/, '');
    this.authorization = `Basic ${Buffer.from(`${options.keyId}:${options.keySecret}`).toString('base64')}`;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string> },
    map: (json: Record<string, unknown>) => T | null,
  ): Promise<RazorpayResult<T>> {
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: this.authorization,
      ...(options.headers ?? {}),
    };
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
        return { ok: false, kind: 'retryable', description: `connection failed (${code})` };
      }
      return {
        ok: false,
        kind: 'unknown',
        description: code ? `no response (${code})` : 'no response',
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
          description: 'unreadable response',
        };
      json = null;
    }
    if (!response.ok) {
      const err = (json as { error?: Record<string, unknown> } | null)?.error ?? {};
      const code = str(err.code) ?? undefined;
      const description = (str(err.description) ?? `HTTP ${response.status}`).slice(0, 500);
      const kind: RazorpayFailureKind =
        response.status === 401
          ? 'auth'
          : response.status === 429 || response.status >= 500
            ? 'retryable'
            : 'permanent';
      return {
        ok: false,
        kind,
        httpStatus: response.status,
        ...(code ? { code } : {}),
        description,
      };
    }
    const mapped =
      typeof json === 'object' && json !== null ? map(json as Record<string, unknown>) : null;
    if (mapped === null) {
      return {
        ok: false,
        kind: 'unknown',
        httpStatus: response.status,
        description: 'unexpected response shape',
      };
    }
    return { ok: true, data: mapped };
  }

  /** POST /v1/orders. `receipt` (≤ 40 chars) is our own id and the key for reconciliation. */
  createOrder(input: {
    amount: number;
    currency: 'INR';
    receipt: string;
    notes?: Record<string, string>;
    paymentCapture?: boolean;
    customerId?: string;
    recurringToken?: { maxAmount: number; expireAt: number; frequency: 'as_presented' };
  }) {
    return this.request(
      'POST',
      '/v1/orders',
      {
        body: {
          amount: input.amount,
          currency: input.currency,
          receipt: input.receipt,
          ...(input.notes ? { notes: input.notes } : {}),
          ...(input.paymentCapture !== undefined ? { payment_capture: input.paymentCapture } : {}),
          ...(input.customerId ? { customer_id: input.customerId } : {}),
          ...(input.recurringToken
            ? {
                method: 'card',
                token: {
                  max_amount: input.recurringToken.maxAmount,
                  expire_at: input.recurringToken.expireAt,
                  frequency: input.recurringToken.frequency,
                },
              }
            : {}),
        },
      },
      mapOrder,
    );
  }

  fetchOrder(orderId: string) {
    return this.request('GET', `/v1/orders/${encodeURIComponent(orderId)}`, {}, mapOrder);
  }

  /** GET /v1/orders?receipt=… — reconciliation before retrying an order whose creation was unanswered. */
  findOrdersByReceipt(receipt: string) {
    return this.request('GET', '/v1/orders', { query: { receipt } }, (json) =>
      Array.isArray(json.items)
        ? (json.items as Record<string, unknown>[])
            .map(mapOrder)
            .filter((o): o is RazorpayOrder => o !== null)
        : null,
    );
  }

  fetchOrderPayments(orderId: string) {
    return this.request('GET', `/v1/orders/${encodeURIComponent(orderId)}/payments`, {}, (json) =>
      Array.isArray(json.items)
        ? (json.items as Record<string, unknown>[])
            .map(mapPayment)
            .filter((p): p is RazorpayPayment => p !== null)
        : null,
    );
  }

  fetchPayment(paymentId: string) {
    return this.request('GET', `/v1/payments/${encodeURIComponent(paymentId)}`, {}, mapPayment);
  }

  /** POST /v1/customers with fail_existing "0": returns the existing customer for the same details. */
  createCustomer(input: {
    name: string;
    email: string;
    contact?: string;
    notes?: Record<string, string>;
  }) {
    return this.request(
      'POST',
      '/v1/customers',
      {
        body: {
          name: input.name.slice(0, 50),
          email: input.email.slice(0, 64),
          ...(input.contact ? { contact: input.contact } : {}),
          fail_existing: '0',
          ...(input.notes ? { notes: input.notes } : {}),
        },
      },
      (json) => (str(json.id) ? { id: str(json.id) as string } : null),
    );
  }

  fetchToken(customerId: string, tokenId: string) {
    return this.request(
      'GET',
      `/v1/customers/${encodeURIComponent(customerId)}/tokens/${encodeURIComponent(tokenId)}`,
      {},
      (json): RazorpayToken | null => {
        const id = str(json.id);
        if (!id) return null;
        const details = (json.recurring_details ?? {}) as Record<string, unknown>;
        const card = json.card as Record<string, unknown> | undefined;
        return {
          id,
          recurringStatus: str(details.status),
          card: card
            ? {
                network: str(card.network),
                issuer: str(card.issuer),
                last4: str(card.last4),
                expiryMonth:
                  num(card.expiry_month) ??
                  (str(card.expiry_month) ? Number(card.expiry_month) : null),
                expiryYear:
                  num(card.expiry_year) ??
                  (str(card.expiry_year) ? Number(card.expiry_year) : null),
              }
            : null,
        };
      },
    );
  }

  deleteToken(customerId: string, tokenId: string) {
    return this.request(
      'DELETE',
      `/v1/customers/${encodeURIComponent(customerId)}/tokens/${encodeURIComponent(tokenId)}`,
      {},
      (json) => (json.deleted === true ? { deleted: true } : null),
    );
  }

  /** POST /v1/payments/create/recurring — a merchant-initiated charge on a confirmed card mandate. */
  createRecurringPayment(input: {
    email: string;
    contact: string;
    amount: number;
    currency: 'INR';
    orderId: string;
    customerId: string;
    tokenId: string;
    description: string;
    notes?: Record<string, string>;
  }) {
    return this.request(
      'POST',
      '/v1/payments/create/recurring',
      {
        body: {
          email: input.email,
          contact: input.contact,
          amount: input.amount,
          currency: input.currency,
          order_id: input.orderId,
          customer_id: input.customerId,
          token: input.tokenId,
          recurring: true,
          description: input.description.slice(0, 255),
          ...(input.notes ? { notes: input.notes } : {}),
        },
      },
      (json) => {
        const id = str(json.razorpay_payment_id) ?? str(json.id);
        return id ? { paymentId: id } : null;
      },
    );
  }

  /** POST /v1/payments/:id/refund with `X-Refund-Idempotency` (R-086). */
  createRefund(
    paymentId: string,
    input: { amount: number; idempotencyKey: string; notes?: Record<string, string> },
  ) {
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(input.idempotencyKey))
      throw new Error('Invalid refund idempotency key');
    return this.request(
      'POST',
      `/v1/payments/${encodeURIComponent(paymentId)}/refund`,
      {
        body: {
          amount: input.amount,
          speed: 'normal',
          ...(input.notes ? { notes: input.notes } : {}),
        },
        headers: { 'x-refund-idempotency': input.idempotencyKey },
      },
      (json): RazorpayRefund | null => {
        const id = str(json.id);
        const amount = num(json.amount);
        return id && amount !== null
          ? {
              id,
              paymentId: str(json.payment_id) ?? paymentId,
              amount,
              status: str(json.status) ?? 'unknown',
            }
          : null;
      },
    );
  }

  fetchRefund(paymentId: string, refundId: string) {
    return this.request(
      'GET',
      `/v1/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(refundId)}`,
      {},
      (json): RazorpayRefund | null => {
        const id = str(json.id);
        const amount = num(json.amount);
        return id && amount !== null
          ? {
              id,
              paymentId: str(json.payment_id) ?? paymentId,
              amount,
              status: str(json.status) ?? 'unknown',
            }
          : null;
      },
    );
  }

  fetchDispute(disputeId: string) {
    return this.request(
      'GET',
      `/v1/disputes/${encodeURIComponent(disputeId)}`,
      {},
      (json): RazorpayDispute | null => {
        const id = str(json.id);
        const amount = num(json.amount);
        const paymentId = str(json.payment_id);
        return id && amount !== null && paymentId
          ? {
              id,
              paymentId,
              amount,
              amountDeducted: num(json.amount_deducted) ?? 0,
              status: str(json.status) ?? 'unknown',
            }
          : null;
      },
    );
  }
}

/** `X-Razorpay-Signature`: hex HMAC-SHA256 of the raw body with the webhook secret (R-017). */
export function verifyRazorpayWebhookSignature(
  rawBody: Buffer,
  header: string | null,
  secrets: string[],
): boolean {
  if (!header) return false;
  const provided = header.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  let valid = false;
  for (const secret of secrets) {
    if (!secret) continue;
    if (constantTimeEqual(provided, hmacSha256Hex(secret, rawBody))) valid = true;
  }
  return valid;
}

/**
 * Checkout response signature: HMAC-SHA256 of "<order_id>|<payment_id>" with the API key secret
 * (R-005). `orderId` must come from our database, never from the browser.
 */
export function verifyCheckoutSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  keySecret: string,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  return constantTimeEqual(signature, hmacSha256Hex(keySecret, `${orderId}|${paymentId}`));
}
