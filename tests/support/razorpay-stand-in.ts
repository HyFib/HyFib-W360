import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * TEST-ONLY local stand-in for the Razorpay endpoints our client calls, so the financial test
 * suite can drive captures, failures, late authorisations, lost responses and provider errors
 * deterministically. It lives under tests/ and is never shipped: production configuration refuses
 * any Razorpay origin other than https://api.razorpay.com outside APP_ENV=local|test.
 *
 * Shapes follow docs/research/razorpay-billing.md (R-001..R-095); they are fixtures, not a claim
 * about every field Razorpay returns.
 */
export type CallBehaviour =
  | { kind: 'ok' }
  | { kind: 'error'; status: number; code?: string; description?: string }
  /** The request is processed, then the connection drops before the response (unknown outcome). */
  | { kind: 'process_then_drop' }
  /** The connection drops before the request is processed. */
  | { kind: 'drop' }
  /**
   * `run` completes first (a test changes the database while the call is in flight), then the next
   * queued behaviour applies (ok when there is none).
   */
  | { kind: 'before'; run: () => Promise<void> };

export interface StandInOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string | null;
  status: 'created' | 'attempted' | 'paid';
  customerId: string | null;
  token: { max_amount: number; expire_at: number; frequency: string } | null;
  paymentCapture: boolean | null;
}

export interface StandInPayment {
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  captured: boolean;
  customerId: string | null;
  tokenId: string | null;
  method: string;
  errorCode: string | null;
  errorDescription: string | null;
  amountRefunded: number;
}

export interface StandInToken {
  id: string;
  customerId: string;
  status: 'initiated' | 'confirmed' | 'rejected' | 'cancelled' | 'paused';
  deleted: boolean;
  card: {
    network: string;
    issuer: string;
    last4: string;
    expiry_month: number;
    expiry_year: number;
  };
}

export interface StandInRefund {
  id: string;
  paymentId: string;
  amount: number;
  status: 'pending' | 'processed' | 'failed';
  idempotencyKey: string | null;
}

export interface StandInDispute {
  id: string;
  paymentId: string;
  amount: number;
  amountDeducted: number;
  status: 'open' | 'under_review' | 'won' | 'lost' | 'closed';
}

/** A Payment Link in a company's own Razorpay account (research R-016, R-106 to R-109). */
export interface StandInPaymentLink {
  id: string;
  merchantKeyId: string;
  referenceId: string | null;
  amount: number;
  amountPaid: number;
  currency: string;
  description: string | null;
  status: 'created' | 'partially_paid' | 'paid' | 'expired' | 'cancelled';
  shortUrl: string;
  expireBy: number | null;
  notify: unknown;
}

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface RazorpayStandInState {
  keyId: string;
  keySecret: string;
  orders: Map<string, StandInOrder>;
  payments: Map<string, StandInPayment>;
  customers: Map<string, { id: string; email: string; contact: string | null }>;
  tokens: Map<string, StandInToken>;
  refunds: Map<string, StandInRefund>;
  disputes: Map<string, StandInDispute>;
  /** Companies' own accounts (key id → secret), used for Payment Links. */
  merchants: Map<string, string>;
  paymentLinks: Map<string, StandInPaymentLink>;
  /** Answers Payment Link calls without `short_url` while set (a response HyFib cannot send). */
  omitShortUrl: boolean;
  /** The status of refunds created from now on (default `processed`; `pending` as with normal speed). */
  refundStatusOnCreate: StandInRefund['status'];
  /** Behaviours consumed by the next calls of each kind (default: ok). */
  queues: {
    createOrder: CallBehaviour[];
    recurring: CallBehaviour[];
    refund: CallBehaviour[];
    fetch: CallBehaviour[];
    createPaymentLink: CallBehaviour[];
    paymentLinks: CallBehaviour[];
  };
  calls: RecordedCall[];
}

export interface RazorpayStandIn {
  baseUrl: string;
  state: RazorpayStandInState;
  /** Browser-side Checkout: a payment on the order (default captured, as with auto-capture). */
  pay(
    orderId: string,
    options?: {
      status?: StandInPayment['status'];
      errorDescription?: string;
      tokenStatus?: StandInToken['status'];
      /** The payment method Razorpay reports (default `card`). */
      method?: string;
    },
  ): StandInPayment;
  setPaymentStatus(paymentId: string, status: StandInPayment['status'], error?: string): void;
  addDispute(paymentId: string, amount: number, status?: StandInDispute['status']): StandInDispute;
  /** A company's Razorpay account whose keys may create and read Payment Links. */
  addMerchant(keyId: string, keySecret: string): void;
  /** The customer pays a Payment Link in full (what the hosted page does). */
  payLink(linkId: string): StandInPaymentLink;
  setLinkStatus(linkId: string, status: StandInPaymentLink['status']): StandInPaymentLink;
  /** Razorpay finishes a pending refund; a failed one no longer counts as refunded. */
  setRefundStatus(refundId: string, status: StandInRefund['status']): StandInRefund;
  close(): Promise<void>;
}

const id = (prefix: string) => `${prefix}_${randomBytes(7).toString('hex')}`;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function rzpError(res: ServerResponse, status: number, code: string, description: string) {
  json(res, status, {
    error: { code, description, source: 'business', reason: 'input_validation_failed' },
  });
}

function orderJson(o: StandInOrder) {
  return {
    id: o.id,
    entity: 'order',
    amount: o.amount,
    currency: o.currency,
    receipt: o.receipt,
    status: o.status,
    attempts: 0,
  };
}

function paymentJson(p: StandInPayment) {
  return {
    id: p.id,
    entity: 'payment',
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    order_id: p.orderId,
    captured: p.captured,
    method: p.method,
    customer_id: p.customerId,
    token_id: p.tokenId,
    amount_refunded: p.amountRefunded,
    error_code: p.errorCode,
    error_description: p.errorDescription,
  };
}

function refundJson(r: StandInRefund) {
  return {
    id: r.id,
    entity: 'refund',
    payment_id: r.paymentId,
    amount: r.amount,
    status: r.status,
  };
}

export async function startRazorpayStandIn(options: {
  keyId: string;
  keySecret: string;
  port?: number;
}): Promise<RazorpayStandIn> {
  const state: RazorpayStandInState = {
    keyId: options.keyId,
    keySecret: options.keySecret,
    orders: new Map(),
    payments: new Map(),
    customers: new Map(),
    tokens: new Map(),
    refunds: new Map(),
    disputes: new Map(),
    merchants: new Map(),
    paymentLinks: new Map(),
    omitShortUrl: false,
    refundStatusOnCreate: 'processed',
    queues: {
      createOrder: [],
      recurring: [],
      refund: [],
      fetch: [],
      createPaymentLink: [],
      paymentLinks: [],
    },
    calls: [],
  };
  const expectedAuth = `Basic ${Buffer.from(`${options.keyId}:${options.keySecret}`).toString('base64')}`;

  function markOrderPaid(orderId: string) {
    const order = state.orders.get(orderId);
    if (order) order.status = 'paid';
  }

  function pay(
    orderId: string,
    opts: {
      status?: StandInPayment['status'];
      errorDescription?: string;
      tokenStatus?: StandInToken['status'];
      method?: string;
    } = {},
  ): StandInPayment {
    const order = state.orders.get(orderId);
    if (!order) throw new Error(`stand-in: unknown order ${orderId}`);
    const status = opts.status ?? 'captured';
    let tokenId: string | null = null;
    if (order.token && order.customerId) {
      const token: StandInToken = {
        id: id('token'),
        customerId: order.customerId,
        status: opts.tokenStatus ?? 'confirmed',
        deleted: false,
        card: {
          network: 'Visa',
          issuer: 'HDFC',
          last4: '1111',
          expiry_month: 12,
          expiry_year: 2031,
        },
      };
      state.tokens.set(token.id, token);
      tokenId = token.id;
    }
    const payment: StandInPayment = {
      id: id('pay'),
      orderId,
      amount: order.amount,
      currency: order.currency,
      status,
      captured: status === 'captured',
      customerId: order.customerId,
      tokenId,
      method: opts.method ?? 'card',
      errorCode: status === 'failed' ? 'BAD_REQUEST_ERROR' : null,
      errorDescription: status === 'failed' ? (opts.errorDescription ?? 'Payment failed') : null,
      amountRefunded: 0,
    };
    state.payments.set(payment.id, payment);
    if (status === 'captured') markOrderPaid(orderId);
    else if (order.status === 'created') order.status = 'attempted';
    return payment;
  }

  function merchantFor(authorization: string | undefined): string | null {
    if (!authorization?.startsWith('Basic ')) return null;
    const [keyId, secret] = Buffer.from(authorization.slice(6), 'base64')
      .toString('utf8')
      .split(':');
    return keyId && secret !== undefined && state.merchants.get(keyId) === secret ? keyId : null;
  }

  function linkJson(l: StandInPaymentLink) {
    return {
      id: l.id,
      entity: 'payment_link',
      reference_id: l.referenceId,
      amount: l.amount,
      amount_paid: l.amountPaid,
      currency: l.currency,
      description: l.description,
      status: l.status,
      short_url: state.omitShortUrl ? null : l.shortUrl,
      expire_by: l.expireBy ?? 0,
      accept_partial: false,
      notify: l.notify,
    };
  }

  function paymentLinkRoute(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    seg: string[],
    url: URL,
    body: Record<string, unknown> | undefined,
    merchantKeyId: string,
  ): Promise<void> | void {
    const own = (linkId: string | undefined) => {
      const link = linkId ? state.paymentLinks.get(linkId) : undefined;
      return link && link.merchantKeyId === merchantKeyId ? link : undefined;
    };
    const run = async (
      queue: CallBehaviour[],
      process: () => { status: number; body: unknown },
    ) => {
      let behaviour = queue.shift() ?? { kind: 'ok' };
      while (behaviour.kind === 'before') {
        await behaviour.run();
        behaviour = queue.shift() ?? { kind: 'ok' };
      }
      if (behaviour.kind === 'drop') {
        req.socket.destroy();
        return;
      }
      if (behaviour.kind === 'error') {
        return rzpError(
          res,
          behaviour.status,
          behaviour.code ?? (behaviour.status >= 500 ? 'SERVER_ERROR' : 'BAD_REQUEST_ERROR'),
          behaviour.description ?? 'Request failed',
        );
      }
      const result = process();
      if (behaviour.kind === 'process_then_drop') {
        req.socket.destroy();
        return;
      }
      json(res, result.status, result.body);
    };
    // POST /v1/payment_links (reference ids are single-use per account, R-106)
    if (method === 'POST' && seg.length === 2) {
      return run(state.queues.createPaymentLink, () => {
        const amount = Number(body?.amount);
        const referenceId = typeof body?.reference_id === 'string' ? body.reference_id : null;
        if (!Number.isInteger(amount) || amount < 100) {
          return {
            status: 400,
            body: { error: { code: 'BAD_REQUEST_ERROR', description: 'amount invalid' } },
          };
        }
        if (referenceId && referenceId.length > 40) {
          return {
            status: 400,
            body: { error: { code: 'BAD_REQUEST_ERROR', description: 'reference_id too long' } },
          };
        }
        if (
          referenceId &&
          [...state.paymentLinks.values()].some(
            (l) => l.merchantKeyId === merchantKeyId && l.referenceId === referenceId,
          )
        ) {
          return {
            status: 400,
            body: {
              error: {
                code: 'BAD_REQUEST_ERROR',
                description: 'payment link creation with reference ID already attempted',
              },
            },
          };
        }
        const link: StandInPaymentLink = {
          id: id('plink'),
          merchantKeyId,
          referenceId,
          amount,
          amountPaid: 0,
          currency: typeof body?.currency === 'string' ? body.currency : 'INR',
          description: typeof body?.description === 'string' ? body.description : null,
          status: 'created',
          shortUrl: `https://rzp.io/i/${randomBytes(5).toString('hex')}`,
          expireBy: typeof body?.expire_by === 'number' ? body.expire_by : null,
          notify: body?.notify ?? null,
        };
        state.paymentLinks.set(link.id, link);
        return { status: 200, body: linkJson(link) };
      });
    }
    // GET /v1/payment_links?reference_id= (R-107)
    if (method === 'GET' && seg.length === 2) {
      return run(state.queues.paymentLinks, () => {
        const reference = url.searchParams.get('reference_id');
        const links = [...state.paymentLinks.values()].filter(
          (l) => l.merchantKeyId === merchantKeyId && (!reference || l.referenceId === reference),
        );
        return { status: 200, body: { payment_links: links.map(linkJson) } };
      });
    }
    // GET /v1/payment_links/:id
    if (method === 'GET' && seg.length === 3) {
      return run(state.queues.paymentLinks, () => {
        const link = own(seg[2]);
        return link
          ? { status: 200, body: linkJson(link) }
          : {
              status: 400,
              body: {
                error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' },
              },
            };
      });
    }
    // POST /v1/payment_links/:id/cancel (R-109)
    if (method === 'POST' && seg.length === 4 && seg[3] === 'cancel') {
      return run(state.queues.paymentLinks, () => {
        const link = own(seg[2]);
        if (!link) {
          return {
            status: 400,
            body: {
              error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' },
            },
          };
        }
        if (link.status === 'paid' || link.status === 'partially_paid') {
          return {
            status: 400,
            body: {
              error: {
                code: 'BAD_REQUEST_ERROR',
                description: 'cannot cancel or expire an already paid/partially paid link',
              },
            },
          };
        }
        if (link.status === 'created') link.status = 'cancelled';
        return { status: 200, body: linkJson(link) };
      });
    }
    return rzpError(
      res,
      404,
      'BAD_REQUEST_ERROR',
      'The requested URL was not found on the server.',
    );
  }

  /** A failed refund no longer counts against the payment. */
  const finishRefund = (refund: StandInRefund, status: StandInRefund['status']) => {
    const payment = state.payments.get(refund.paymentId);
    if (payment && status === 'failed' && refund.status !== 'failed') {
      payment.amountRefunded -= refund.amount;
      if (payment.status === 'refunded') payment.status = 'captured';
    }
    refund.status = status;
    return refund;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stand-in');
      const body = (await readBody(req)) as Record<string, unknown> | undefined;
      state.calls.push({
        method: req.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: {
          'x-refund-idempotency': req.headers['x-refund-idempotency'] as string | undefined,
        },
        body,
      });
      // TEST-ONLY: what Standard Checkout does in the browser (a captured payment on the order)
      // plus the handler response it would pass back, signed with the key secret (R-004, R-005).
      if (req.method === 'POST' && url.pathname === '/__stand-in/checkout') {
        const orderId = String(body?.order_id ?? '');
        if (!state.orders.has(orderId))
          return rzpError(res, 400, 'BAD_REQUEST_ERROR', 'order not found');
        const payment = pay(orderId);
        const signature = createHmac('sha256', options.keySecret)
          .update(`${orderId}|${payment.id}`)
          .digest('hex');
        return json(res, 200, {
          razorpay_payment_id: payment.id,
          razorpay_order_id: orderId,
          razorpay_signature: signature,
        });
      }
      // TEST-ONLY: a company's own Razorpay account (its key id and secret).
      if (req.method === 'POST' && url.pathname === '/__stand-in/merchant') {
        const keyId = String(body?.key_id ?? '');
        const keySecret = String(body?.key_secret ?? '');
        if (!keyId || !keySecret) return rzpError(res, 400, 'BAD_REQUEST_ERROR', 'keys missing');
        state.merchants.set(keyId, keySecret);
        return json(res, 200, { ok: true });
      }
      // TEST-ONLY: the Payment Links created with a company's key id, newest first.
      if (req.method === 'GET' && url.pathname === '/__stand-in/payment-links') {
        const keyId = url.searchParams.get('key_id') ?? '';
        const links = [...state.paymentLinks.values()]
          .filter((l) => l.merchantKeyId === keyId)
          .reverse()
          .map(linkJson);
        return json(res, 200, { payment_links: links });
      }
      // TEST-ONLY: the status refunds get when created (normal-speed refunds start pending).
      if (req.method === 'POST' && url.pathname === '/__stand-in/refund-status') {
        const status = String(body?.status ?? '');
        if (status !== 'pending' && status !== 'processed' && status !== 'failed')
          return rzpError(res, 400, 'BAD_REQUEST_ERROR', 'unknown refund status');
        state.refundStatusOnCreate = status;
        return json(res, 200, { ok: true });
      }
      // TEST-ONLY: Razorpay finishes a refund (processed or failed).
      if (req.method === 'POST' && url.pathname === '/__stand-in/finish-refund') {
        const refund = state.refunds.get(String(body?.id ?? ''));
        const status = String(body?.status ?? '');
        if (!refund) return rzpError(res, 400, 'BAD_REQUEST_ERROR', 'refund not found');
        if (status !== 'processed' && status !== 'failed')
          return rzpError(res, 400, 'BAD_REQUEST_ERROR', 'unknown refund status');
        return json(res, 200, refundJson(finishRefund(refund, status)));
      }
      // TEST-ONLY: what the hosted payment page does when the customer pays the link in full.
      if (req.method === 'POST' && url.pathname === '/__stand-in/pay-link') {
        const link = state.paymentLinks.get(String(body?.id ?? ''));
        if (!link) return rzpError(res, 400, 'BAD_REQUEST_ERROR', 'payment link not found');
        link.status = 'paid';
        link.amountPaid = link.amount;
        return json(res, 200, linkJson(link));
      }
      const seg = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';
      // Companies' accounts: Payment Links only, each account seeing its own links.
      const merchant = merchantFor(req.headers.authorization);
      if (seg[0] === 'v1' && seg[1] === 'payment_links') {
        if (!merchant) {
          return rzpError(res, 401, 'BAD_REQUEST_ERROR', 'The api key provided is invalid');
        }
        return paymentLinkRoute(req, res, method, seg, url, body, merchant);
      }
      if (req.headers.authorization !== expectedAuth) {
        return rzpError(res, 401, 'BAD_REQUEST_ERROR', 'The api key provided is invalid');
      }

      const behave = async (
        queue: CallBehaviour[],
        process: () => { status: number; body: unknown },
      ): Promise<void> => {
        let behaviour = queue.shift() ?? { kind: 'ok' };
        while (behaviour.kind === 'before') {
          await behaviour.run();
          behaviour = queue.shift() ?? { kind: 'ok' };
        }
        if (behaviour.kind === 'drop') {
          req.socket.destroy();
          return;
        }
        if (behaviour.kind === 'error') {
          return rzpError(
            res,
            behaviour.status,
            behaviour.code ?? (behaviour.status >= 500 ? 'SERVER_ERROR' : 'BAD_REQUEST_ERROR'),
            behaviour.description ?? 'Request failed',
          );
        }
        const result = process();
        if (behaviour.kind === 'process_then_drop') {
          req.socket.destroy();
          return;
        }
        json(res, result.status, result.body);
      };

      // POST /v1/orders
      if (method === 'POST' && url.pathname === '/v1/orders') {
        return behave(state.queues.createOrder, () => {
          const amount = Number(body?.amount);
          if (!Number.isInteger(amount) || amount < 100) {
            return {
              status: 400,
              body: { error: { code: 'BAD_REQUEST_ERROR', description: 'amount invalid' } },
            };
          }
          const token = (body?.token ?? null) as StandInOrder['token'];
          const order: StandInOrder = {
            id: id('order'),
            amount,
            currency: String(body?.currency ?? 'INR'),
            receipt: typeof body?.receipt === 'string' ? body.receipt : null,
            status: 'created',
            customerId: typeof body?.customer_id === 'string' ? body.customer_id : null,
            token,
            paymentCapture:
              typeof body?.payment_capture === 'boolean' ? body.payment_capture : null,
          };
          state.orders.set(order.id, order);
          return { status: 200, body: orderJson(order) };
        });
      }
      // GET /v1/orders?receipt=
      if (method === 'GET' && url.pathname === '/v1/orders') {
        return behave(state.queues.fetch, () => {
          const receipt = url.searchParams.get('receipt');
          const items = [...state.orders.values()]
            .filter((o) => !receipt || o.receipt === receipt)
            .map(orderJson);
          return { status: 200, body: { entity: 'collection', count: items.length, items } };
        });
      }
      // GET /v1/orders/:id and /v1/orders/:id/payments
      if (method === 'GET' && seg[0] === 'v1' && seg[1] === 'orders' && seg[2]) {
        return behave(state.queues.fetch, () => {
          const order = state.orders.get(seg[2] ?? '');
          if (!order)
            return {
              status: 400,
              body: { error: { code: 'BAD_REQUEST_ERROR', description: 'order not found' } },
            };
          if (seg[3] === 'payments') {
            const items = [...state.payments.values()]
              .filter((p) => p.orderId === order.id)
              .map(paymentJson);
            return { status: 200, body: { entity: 'collection', count: items.length, items } };
          }
          return { status: 200, body: orderJson(order) };
        });
      }
      // POST /v1/payments/create/recurring
      if (method === 'POST' && url.pathname === '/v1/payments/create/recurring') {
        return behave(state.queues.recurring, () => {
          const order = state.orders.get(String(body?.order_id ?? ''));
          const token = state.tokens.get(String(body?.token ?? ''));
          if (!order || order.status === 'paid') {
            return {
              status: 400,
              body: { error: { code: 'BAD_REQUEST_ERROR', description: 'order invalid' } },
            };
          }
          if (!token || token.status !== 'confirmed' || token.deleted) {
            return {
              status: 400,
              body: { error: { code: 'BAD_REQUEST_ERROR', description: 'token is not confirmed' } },
            };
          }
          if (Number(body?.amount) !== order.amount) {
            return {
              status: 400,
              body: { error: { code: 'BAD_REQUEST_ERROR', description: 'amount mismatch' } },
            };
          }
          const payment: StandInPayment = {
            id: id('pay'),
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            status: 'created',
            captured: false,
            customerId: String(body?.customer_id ?? ''),
            tokenId: token.id,
            method: 'card',
            errorCode: null,
            errorDescription: null,
            amountRefunded: 0,
          };
          state.payments.set(payment.id, payment);
          order.status = 'attempted';
          return {
            status: 200,
            body: {
              razorpay_payment_id: payment.id,
              razorpay_order_id: order.id,
              razorpay_signature: 'x',
            },
          };
        });
      }
      // POST /v1/payments/:id/refund
      if (method === 'POST' && seg[1] === 'payments' && seg[3] === 'refund') {
        return behave(state.queues.refund, () => {
          const payment = state.payments.get(seg[2] ?? '');
          const key = (req.headers['x-refund-idempotency'] as string | undefined) ?? null;
          if (key) {
            const existing = [...state.refunds.values()].find((r) => r.idempotencyKey === key);
            if (existing) return { status: 200, body: refundJson(existing) };
          }
          const amount = Number(body?.amount);
          if (!payment || (payment.status !== 'captured' && payment.status !== 'refunded')) {
            return {
              status: 400,
              body: { error: { code: 'BAD_REQUEST_ERROR', description: 'payment not refundable' } },
            };
          }
          if (payment.amountRefunded + amount > payment.amount) {
            return {
              status: 400,
              body: {
                error: {
                  code: 'BAD_REQUEST_ERROR',
                  description: 'The payment has been fully refunded already',
                },
              },
            };
          }
          const refund: StandInRefund = {
            id: id('rfnd'),
            paymentId: payment.id,
            amount,
            status: state.refundStatusOnCreate,
            idempotencyKey: key,
          };
          state.refunds.set(refund.id, refund);
          payment.amountRefunded += amount;
          if (payment.amountRefunded === payment.amount) payment.status = 'refunded';
          return { status: 200, body: refundJson(refund) };
        });
      }
      // GET /v1/payments/:id/refunds/:rid
      if (method === 'GET' && seg[1] === 'payments' && seg[3] === 'refunds' && seg[4]) {
        return behave(state.queues.fetch, () => {
          const refund = state.refunds.get(seg[4] ?? '');
          if (!refund || refund.paymentId !== seg[2]) {
            return {
              status: 400,
              body: { error: { code: 'BAD_REQUEST_ERROR', description: 'refund not found' } },
            };
          }
          return { status: 200, body: refundJson(refund) };
        });
      }
      // GET /v1/payments/:id
      if (method === 'GET' && seg[1] === 'payments' && seg[2] && !seg[3]) {
        return behave(state.queues.fetch, () => {
          const payment = state.payments.get(seg[2] ?? '');
          if (!payment)
            return {
              status: 400,
              body: { error: { code: 'BAD_REQUEST_ERROR', description: 'payment not found' } },
            };
          return { status: 200, body: paymentJson(payment) };
        });
      }
      // POST /v1/customers (fail_existing "0" returns the existing customer)
      if (method === 'POST' && url.pathname === '/v1/customers') {
        const email = String(body?.email ?? '');
        const contact = typeof body?.contact === 'string' ? body.contact : null;
        const existing = [...state.customers.values()].find(
          (c) => c.email === email && c.contact === contact,
        );
        if (existing && body?.fail_existing === '0')
          return json(res, 200, { id: existing.id, entity: 'customer' });
        const customer = { id: id('cust'), email, contact };
        state.customers.set(customer.id, customer);
        return json(res, 200, { id: customer.id, entity: 'customer', email, contact });
      }
      // GET / DELETE /v1/customers/:cid/tokens/:tid
      if (seg[1] === 'customers' && seg[3] === 'tokens' && seg[4]) {
        const token = state.tokens.get(seg[4]);
        if (!token || token.customerId !== seg[2]) {
          return rzpError(res, 400, 'BAD_REQUEST_ERROR', 'token not found');
        }
        if (method === 'DELETE') {
          token.deleted = true;
          token.status = 'cancelled';
          return json(res, 200, { deleted: true });
        }
        return json(res, 200, {
          id: token.id,
          entity: 'token',
          method: 'card',
          recurring: true,
          recurring_details: { status: token.status, failure_reason: null },
          card: token.card,
        });
      }
      // GET /v1/disputes/:id
      if (method === 'GET' && seg[1] === 'disputes' && seg[2]) {
        const dispute = state.disputes.get(seg[2]);
        if (!dispute) return rzpError(res, 400, 'BAD_REQUEST_ERROR', 'dispute not found');
        return json(res, 200, {
          id: dispute.id,
          entity: 'dispute',
          payment_id: dispute.paymentId,
          amount: dispute.amount,
          amount_deducted: dispute.amountDeducted,
          status: dispute.status,
        });
      }
      return rzpError(res, 404, 'NOT_FOUND', `stand-in has no route ${method} ${url.pathname}`);
    })().catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    pay,
    setPaymentStatus(paymentId, status, error) {
      const payment = state.payments.get(paymentId);
      if (!payment) throw new Error(`stand-in: unknown payment ${paymentId}`);
      payment.status = status;
      payment.captured = status === 'captured' || status === 'refunded';
      if (status === 'failed') {
        payment.errorCode = 'BAD_REQUEST_ERROR';
        payment.errorDescription = error ?? 'Payment failed';
      }
      if (status === 'captured') markOrderPaid(payment.orderId);
    },
    addDispute(paymentId, amount, status = 'lost') {
      const dispute: StandInDispute = {
        id: id('disp'),
        paymentId,
        amount,
        amountDeducted: status === 'lost' ? amount : 0,
        status,
      };
      state.disputes.set(dispute.id, dispute);
      return dispute;
    },
    addMerchant(keyId: string, keySecret: string) {
      state.merchants.set(keyId, keySecret);
    },
    payLink(linkId: string) {
      const link = state.paymentLinks.get(linkId);
      if (!link) throw new Error(`stand-in: unknown payment link ${linkId}`);
      link.status = 'paid';
      link.amountPaid = link.amount;
      return link;
    },
    setLinkStatus(linkId: string, status: StandInPaymentLink['status']) {
      const link = state.paymentLinks.get(linkId);
      if (!link) throw new Error(`stand-in: unknown payment link ${linkId}`);
      link.status = status;
      return link;
    },
    setRefundStatus(refundId: string, status: StandInRefund['status']) {
      const refund = state.refunds.get(refundId);
      if (!refund) throw new Error(`stand-in: unknown refund ${refundId}`);
      return finishRefund(refund, status);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
