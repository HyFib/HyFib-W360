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
  | { kind: 'drop' };

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
  /** Behaviours consumed by the next calls of each kind (default: ok). */
  queues: {
    createOrder: CallBehaviour[];
    recurring: CallBehaviour[];
    refund: CallBehaviour[];
    fetch: CallBehaviour[];
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
    },
  ): StandInPayment;
  setPaymentStatus(paymentId: string, status: StandInPayment['status'], error?: string): void;
  addDispute(paymentId: string, amount: number, status?: StandInDispute['status']): StandInDispute;
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
    queues: { createOrder: [], recurring: [], refund: [], fetch: [] },
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
      method: 'card',
      errorCode: status === 'failed' ? 'BAD_REQUEST_ERROR' : null,
      errorDescription: status === 'failed' ? (opts.errorDescription ?? 'Payment failed') : null,
      amountRefunded: 0,
    };
    state.payments.set(payment.id, payment);
    if (status === 'captured') markOrderPaid(orderId);
    else if (order.status === 'created') order.status = 'attempted';
    return payment;
  }

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
      if (req.headers.authorization !== expectedAuth) {
        return rzpError(res, 401, 'BAD_REQUEST_ERROR', 'The api key provided is invalid');
      }
      const seg = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      const behave = async (
        queue: CallBehaviour[],
        process: () => { status: number; body: unknown },
      ): Promise<void> => {
        const behaviour = queue.shift() ?? { kind: 'ok' };
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
            status: 'processed',
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
