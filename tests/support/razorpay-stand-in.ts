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
  | { kind: 'before'; run: () => Promise<void> }
  /**
   * The request is processed, then its response body is changed before it is sent: Razorpay
   * answering with something HyFib must refuse.
   */
  | { kind: 'alter'; alter: (body: Record<string, unknown>) => unknown };

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
  /** The invoice a subscription charge paid (R-065); null for other payments. */
  invoiceId: string | null;
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

/** A plan (R-063): the amount a subscription charges every billing cycle. */
export interface StandInPlan {
  id: string;
  period: string;
  interval: number;
  amount: number;
  currency: string;
  name: string;
}

/** A subscription (R-064 to R-068), advanced by the test hooks below as Razorpay would. */
export interface StandInSubscription {
  id: string;
  planId: string;
  status:
    | 'created'
    | 'authenticated'
    | 'active'
    | 'pending'
    | 'halted'
    | 'paused'
    | 'cancelled'
    | 'completed'
    | 'expired';
  totalCount: number;
  quantity: number;
  customerNotify: boolean;
  expireBy: number | null;
  notes: unknown;
  customerId: string | null;
  /** Unix seconds. */
  currentStart: number | null;
  currentEnd: number | null;
  chargeAt: number | null;
  endedAt: number | null;
  paidCount: number;
  cancelAtCycleEnd: boolean;
  createdAt: number;
  /** Unix seconds: the first charge is due then (`start_at`, R-119); null: charged in Checkout. */
  startAt: number | null;
}

/** An invoice of a subscription: one per billing cycle, paid when its charge is captured. */
export interface StandInInvoice {
  id: string;
  subscriptionId: string;
  orderId: string;
  paymentId: string | null;
  status: 'issued' | 'paid' | 'cancelled' | 'expired';
  amount: number;
  amountPaid: number;
  currency: string;
  paidAt: number | null;
  billingStart: number | null;
  billingEnd: number | null;
  createdAt: number;
}

/**
 * A settled transaction as the settlement report shows it (R-111). Kept raw so tests can also add
 * items of shapes HyFib must refuse to read.
 */
export type StandInReconItem = Record<string, unknown>;

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
  /** Settlement report items by settlement day (YYYY-MM-DD), in report order. */
  settlements: Map<string, StandInReconItem[]>;
  plans: Map<string, StandInPlan>;
  subscriptions: Map<string, StandInSubscription>;
  invoices: Map<string, StandInInvoice>;
  /** Behaviours consumed by the next calls of each kind (default: ok). */
  queues: {
    createOrder: CallBehaviour[];
    recurring: CallBehaviour[];
    refund: CallBehaviour[];
    fetch: CallBehaviour[];
    createPaymentLink: CallBehaviour[];
    paymentLinks: CallBehaviour[];
    recon: CallBehaviour[];
    createPlan: CallBehaviour[];
    createSubscription: CallBehaviour[];
    cancelSubscription: CallBehaviour[];
    /** Subscription and invoice reads. */
    subscriptionFetch: CallBehaviour[];
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
  /**
   * Razorpay settles transactions on `date` (YYYY-MM-DD): each listed captured payment and processed
   * refund (by default every one not settled yet) becomes a report item, and `extra` raw items are
   * appended as they are. A payment's fee is a test fixture (2% including 18% GST), not Razorpay's
   * pricing.
   */
  settle(
    date: string,
    options?: { paymentIds?: string[]; refundIds?: string[]; extra?: StandInReconItem[] },
  ): StandInReconItem[];
  /**
   * Checkout for a subscription: one that starts at once has its first cycle charged (captured by
   * default) and becomes active, and a failed charge leaves it created. One whose `start_at` is
   * still ahead is only authenticated (R-119): its authentication payment pays no invoice and is
   * refunded (the stand-in does not model its amount, which Razorpay does not document), and a
   * later `chargeSubscription` charges the first cycle from the start. Returns the payment and the
   * handler response Checkout would pass back, signed with the key secret (R-072).
   */
  authorizeSubscription(
    subscriptionId: string,
    options?: { status?: 'captured' | 'failed'; method?: string },
  ): {
    payment: StandInPayment;
    response: {
      razorpay_payment_id: string;
      razorpay_subscription_id: string;
      razorpay_signature: string;
    };
  };
  /**
   * Razorpay's charge at the start of the next billing cycle (the first one, from `start_at`, for a
   * subscription that started later, R-119), or a retry of the current unpaid one: captured makes
   * the cycle paid and the subscription active; failed leaves the cycle unpaid and the subscription
   * pending.
   */
  chargeSubscription(
    subscriptionId: string,
    options?: { status?: 'captured' | 'failed' },
  ): { payment: StandInPayment; invoice: StandInInvoice };
  /** The current cycle ends: a subscription cancelled at cycle end becomes cancelled. */
  endSubscriptionCycle(subscriptionId: string): StandInSubscription;
  setSubscriptionStatus(
    subscriptionId: string,
    status: StandInSubscription['status'],
  ): StandInSubscription;
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
    invoice_id: p.invoiceId,
  };
}

function planJson(p: StandInPlan) {
  return {
    id: p.id,
    entity: 'plan',
    interval: p.interval,
    period: p.period,
    item: { name: p.name, amount: p.amount, unit_amount: p.amount, currency: p.currency },
    notes: [],
  };
}

function subscriptionJson(s: StandInSubscription) {
  return {
    id: s.id,
    entity: 'subscription',
    plan_id: s.planId,
    customer_id: s.customerId,
    status: s.status,
    current_start: s.currentStart,
    current_end: s.currentEnd,
    ended_at: s.endedAt,
    quantity: s.quantity,
    // Razorpay sends notes as [] when there are none; the fixture keeps both shapes.
    notes: s.notes ?? [],
    charge_at: s.chargeAt,
    start_at: s.startAt ?? s.currentStart,
    end_at: null,
    auth_attempts: 0,
    total_count: s.totalCount,
    paid_count: s.paidCount,
    customer_notify: s.customerNotify,
    created_at: s.createdAt,
    expire_by: s.expireBy,
    short_url: `https://rzp.io/i/${s.id.slice(4, 12)}`,
    has_scheduled_changes: false,
    change_scheduled_at: null,
    remaining_count: Math.max(s.totalCount - s.paidCount, 0),
  };
}

function invoiceJson(i: StandInInvoice) {
  return {
    id: i.id,
    entity: 'invoice',
    type: 'invoice',
    order_id: i.orderId,
    subscription_id: i.subscriptionId,
    payment_id: i.paymentId,
    status: i.status,
    amount: i.amount,
    amount_paid: i.amountPaid,
    amount_due: i.amount - i.amountPaid,
    currency: i.currency,
    issued_at: i.createdAt,
    paid_at: i.paidAt,
    billing_start: i.billingStart,
    billing_end: i.billingEnd,
    notes: [],
    created_at: i.createdAt,
  };
}

/** `seconds` plus whole months, on the same day and time (the month's last day when shorter). */
function addMonthsUnix(seconds: number, months: number): number {
  const d = new Date(seconds * 1000);
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes()),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  target.setUTCSeconds(d.getUTCSeconds());
  return Math.floor(target.getTime() / 1000);
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
    settlements: new Map(),
    plans: new Map(),
    subscriptions: new Map(),
    invoices: new Map(),
    queues: {
      createOrder: [],
      recurring: [],
      refund: [],
      fetch: [],
      createPaymentLink: [],
      paymentLinks: [],
      recon: [],
      createPlan: [],
      createSubscription: [],
      cancelSubscription: [],
      subscriptionFetch: [],
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
      invoiceId: null,
    };
    state.payments.set(payment.id, payment);
    if (status === 'captured') markOrderPaid(orderId);
    else if (order.status === 'created') order.status = 'attempted';
    return payment;
  }

  // Subscriptions ------------------------------------------------------------------------------------
  const nowUnix = () => Math.floor(Date.now() / 1000);
  function subscriptionOf(subscriptionId: string): StandInSubscription {
    const sub = state.subscriptions.get(subscriptionId);
    if (!sub) throw new Error(`stand-in: unknown subscription ${subscriptionId}`);
    return sub;
  }
  function cycleMonths(plan: StandInPlan): number {
    const perPeriod: Record<string, number> = { monthly: 1, quarterly: 3, yearly: 12 };
    const months = perPeriod[plan.period];
    if (!months) throw new Error(`stand-in: no billing cycles for period ${plan.period}`);
    return months * plan.interval;
  }
  /**
   * One charge of a billing cycle: an order and an invoice for it, and a payment on the order.
   * Captured pays the invoice; failed leaves it issued.
   */
  function chargeCycle(
    sub: StandInSubscription,
    cycle: { start: number; end: number },
    status: 'captured' | 'failed',
    method = 'card',
  ): { payment: StandInPayment; invoice: StandInInvoice } {
    const plan = state.plans.get(sub.planId);
    if (!plan) throw new Error(`stand-in: unknown plan ${sub.planId}`);
    const amount = plan.amount * sub.quantity;
    const now = nowUnix();
    const order: StandInOrder = {
      id: id('order'),
      amount,
      currency: plan.currency,
      receipt: null,
      status: status === 'captured' ? 'paid' : 'attempted',
      customerId: sub.customerId,
      token: null,
      paymentCapture: true,
    };
    state.orders.set(order.id, order);
    const invoice: StandInInvoice = {
      id: id('inv'),
      subscriptionId: sub.id,
      orderId: order.id,
      paymentId: null,
      status: 'issued',
      amount,
      amountPaid: 0,
      currency: plan.currency,
      paidAt: null,
      billingStart: cycle.start,
      billingEnd: cycle.end,
      createdAt: now,
    };
    const payment: StandInPayment = {
      id: id('pay'),
      orderId: order.id,
      amount,
      currency: plan.currency,
      status,
      captured: status === 'captured',
      customerId: sub.customerId,
      tokenId: null,
      method,
      errorCode: status === 'failed' ? 'BAD_REQUEST_ERROR' : null,
      errorDescription: status === 'failed' ? 'Payment failed' : null,
      amountRefunded: 0,
      invoiceId: invoice.id,
    };
    state.payments.set(payment.id, payment);
    if (status === 'captured') {
      invoice.status = 'paid';
      invoice.paymentId = payment.id;
      invoice.amountPaid = amount;
      invoice.paidAt = now;
    }
    state.invoices.set(invoice.id, invoice);
    return { payment, invoice };
  }
  function authorizeSubscription(
    subscriptionId: string,
    opts: { status?: 'captured' | 'failed'; method?: string } = {},
  ) {
    const sub = subscriptionOf(subscriptionId);
    if (sub.status !== 'created') {
      throw new Error(`stand-in: subscription ${sub.id} is ${sub.status}, not created`);
    }
    const plan = state.plans.get(sub.planId);
    if (!plan) throw new Error(`stand-in: unknown plan ${sub.planId}`);
    if (!sub.customerId) {
      const customer = { id: id('cust'), email: 'payer@example.test', contact: null };
      state.customers.set(customer.id, customer);
      sub.customerId = customer.id;
    }
    const start = nowUnix();
    const status = opts.status ?? 'captured';
    let payment: StandInPayment;
    if (sub.startAt !== null && sub.startAt > start) {
      payment = {
        id: id('pay'),
        orderId: id('order'),
        amount: 100,
        currency: plan.currency,
        status: status === 'captured' ? 'refunded' : 'failed',
        captured: false,
        customerId: sub.customerId,
        tokenId: null,
        method: opts.method ?? 'card',
        errorCode: status === 'failed' ? 'BAD_REQUEST_ERROR' : null,
        errorDescription: status === 'failed' ? 'Payment failed' : null,
        amountRefunded: status === 'captured' ? 100 : 0,
        invoiceId: null,
      };
      state.payments.set(payment.id, payment);
      if (status === 'captured') {
        sub.status = 'authenticated';
        sub.chargeAt = sub.startAt;
      }
    } else {
      const cycle = { start, end: addMonthsUnix(start, cycleMonths(plan)) };
      payment = chargeCycle(sub, cycle, status, opts.method).payment;
      if (status === 'captured') {
        sub.status = 'active';
        sub.currentStart = cycle.start;
        sub.currentEnd = cycle.end;
        sub.chargeAt = cycle.end;
        sub.paidCount += 1;
      }
    }
    const signature = createHmac('sha256', options.keySecret)
      .update(`${payment.id}|${sub.id}`)
      .digest('hex');
    return {
      payment,
      response: {
        razorpay_payment_id: payment.id,
        razorpay_subscription_id: sub.id,
        razorpay_signature: signature,
      },
    };
  }
  function chargeSubscription(
    subscriptionId: string,
    opts: { status?: 'captured' | 'failed' } = {},
  ) {
    const sub = subscriptionOf(subscriptionId);
    const plan = state.plans.get(sub.planId);
    // The first charge of one that started later: its first cycle begins at its start (R-119).
    const first = sub.status === 'authenticated' && sub.startAt !== null && sub.currentEnd === null;
    if (!plan || (!first && (sub.currentEnd === null || sub.currentStart === null))) {
      throw new Error(`stand-in: subscription ${sub.id} has no billing cycle to charge`);
    }
    // A charge while pending or halted retries the current (unpaid) cycle; otherwise the next one
    // starts at the end of the current one.
    const retry = sub.status === 'pending' || sub.status === 'halted';
    const cycle =
      first && sub.startAt !== null
        ? { start: sub.startAt, end: addMonthsUnix(sub.startAt, cycleMonths(plan)) }
        : retry
          ? { start: sub.currentStart!, end: sub.currentEnd! }
          : { start: sub.currentEnd!, end: addMonthsUnix(sub.currentEnd!, cycleMonths(plan)) };
    const status = opts.status ?? 'captured';
    const charged = chargeCycle(sub, cycle, status);
    sub.currentStart = cycle.start;
    sub.currentEnd = cycle.end;
    if (status === 'captured') {
      sub.status = 'active';
      sub.paidCount += 1;
      sub.chargeAt = cycle.end;
    } else if (sub.status !== 'halted') {
      sub.status = 'pending';
    }
    return charged;
  }
  function endSubscriptionCycle(subscriptionId: string) {
    const sub = subscriptionOf(subscriptionId);
    if (sub.cancelAtCycleEnd && sub.status !== 'cancelled') {
      sub.status = 'cancelled';
      sub.endedAt = sub.currentEnd ?? nowUnix();
    } else if (sub.paidCount >= sub.totalCount) {
      sub.status = 'completed';
      sub.endedAt = sub.currentEnd ?? nowUnix();
    }
    return sub;
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
      json(
        res,
        result.status,
        behaviour.kind === 'alter'
          ? behaviour.alter(result.body as Record<string, unknown>)
          : result.body,
      );
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

  const settled = new Set<string>();
  function settle(
    date: string,
    options: { paymentIds?: string[]; refundIds?: string[]; extra?: StandInReconItem[] } = {},
  ): StandInReconItem[] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`stand-in: bad settlement day ${date}`);
    const settledAt = Math.floor(Date.parse(`${date}T12:00:00Z`) / 1000);
    const settlementId = id('setl');
    const utr = `UTR${randomBytes(6).toString('hex').toUpperCase()}`;
    const common = (createdAt: number) => ({
      currency: 'INR',
      on_hold: false,
      settled: true,
      created_at: createdAt,
      settled_at: settledAt,
      settlement_id: settlementId,
      posted_at: null,
      credit_type: 'default',
      description: null,
      notes: null,
      settlement_utr: utr,
      card_network: null,
      card_issuer: null,
      card_type: null,
      dispute_id: null,
    });
    const items: StandInReconItem[] = [];
    const paymentIds =
      options.paymentIds ??
      [...state.payments.values()].filter((p) => p.captured && !settled.has(p.id)).map((p) => p.id);
    for (const paymentId of paymentIds) {
      const payment = state.payments.get(paymentId);
      if (!payment) throw new Error(`stand-in: unknown payment ${paymentId}`);
      const fee = Math.floor((payment.amount * 2) / 100);
      settled.add(payment.id);
      items.push({
        ...common(settledAt - 2 * 86_400),
        entity_id: payment.id,
        type: 'payment',
        debit: 0,
        credit: payment.amount - fee,
        amount: payment.amount,
        fee,
        tax: Math.floor((fee * 18) / 118),
        payment_id: null,
        order_id: payment.orderId,
        order_receipt: state.orders.get(payment.orderId)?.receipt ?? null,
        method: payment.method,
      });
    }
    const refundIds =
      options.refundIds ??
      [...state.refunds.values()]
        .filter((r) => r.status === 'processed' && !settled.has(r.id))
        .map((r) => r.id);
    for (const refundId of refundIds) {
      const refund = state.refunds.get(refundId);
      if (!refund) throw new Error(`stand-in: unknown refund ${refundId}`);
      const payment = state.payments.get(refund.paymentId);
      settled.add(refund.id);
      items.push({
        ...common(settledAt - 86_400),
        entity_id: refund.id,
        type: 'refund',
        debit: refund.amount,
        credit: 0,
        amount: refund.amount,
        fee: 0,
        tax: 0,
        payment_id: refund.paymentId,
        order_id: payment?.orderId ?? null,
        order_receipt: null,
        method: payment?.method ?? null,
      });
    }
    items.push(...(options.extra ?? []));
    state.settlements.set(date, [...(state.settlements.get(date) ?? []), ...items]);
    return items;
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
      if (
        req.method === 'POST' &&
        url.pathname === '/__stand-in/checkout' &&
        body?.subscription_id
      ) {
        const sub = state.subscriptions.get(String(body.subscription_id));
        if (!sub || sub.status !== 'created')
          return rzpError(res, 400, 'BAD_REQUEST_ERROR', 'subscription cannot be authorised');
        return json(res, 200, authorizeSubscription(sub.id).response);
      }
      // TEST-ONLY: Razorpay charges a subscription's next cycle (or retries the current one).
      if (req.method === 'POST' && url.pathname === '/__stand-in/charge-subscription') {
        const status = body?.status === 'failed' ? 'failed' : 'captured';
        try {
          const charged = chargeSubscription(String(body?.subscription_id ?? ''), { status });
          return json(res, 200, { payment_id: charged.payment.id, invoice_id: charged.invoice.id });
        } catch (error) {
          return rzpError(res, 400, 'BAD_REQUEST_ERROR', String(error));
        }
      }
      // TEST-ONLY: a subscription's current billing cycle ends.
      if (req.method === 'POST' && url.pathname === '/__stand-in/end-subscription-cycle') {
        try {
          return json(
            res,
            200,
            subscriptionJson(endSubscriptionCycle(String(body?.subscription_id ?? ''))),
          );
        } catch (error) {
          return rzpError(res, 400, 'BAD_REQUEST_ERROR', String(error));
        }
      }
      // TEST-ONLY: the subscriptions of the account, newest first (what the Dashboard lists).
      if (req.method === 'GET' && url.pathname === '/__stand-in/subscriptions') {
        return json(res, 200, {
          items: [...state.subscriptions.values()].reverse().map(subscriptionJson),
        });
      }
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
      // TEST-ONLY: Razorpay settles transactions on a day (see `settle`).
      if (req.method === 'POST' && url.pathname === '/__stand-in/settle') {
        try {
          const items = settle(String(body?.date ?? ''), {
            ...(Array.isArray(body?.payment_ids)
              ? { paymentIds: body.payment_ids.map(String) }
              : {}),
            ...(Array.isArray(body?.refund_ids) ? { refundIds: body.refund_ids.map(String) } : {}),
            ...(Array.isArray(body?.extra) ? { extra: body.extra as StandInReconItem[] } : {}),
          });
          return json(res, 200, { items });
        } catch (error) {
          return rzpError(res, 400, 'BAD_REQUEST_ERROR', String(error));
        }
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
        json(
          res,
          result.status,
          behaviour.kind === 'alter'
            ? behaviour.alter(result.body as Record<string, unknown>)
            : result.body,
        );
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
            invoiceId: null,
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
      // GET /v1/settlements/recon/combined (R-110): daily reports only.
      if (method === 'GET' && url.pathname === '/v1/settlements/recon/combined') {
        return behave(state.queues.recon, () => {
          const q = (name: string) => url.searchParams.get(name) ?? '';
          const invalid = (field: string, description: string) => ({
            status: 400,
            body: { error: { code: 'BAD_REQUEST_ERROR', description, field } },
          });
          if (!/^\d{4}$/.test(q('year'))) return invalid('year', 'The year must be 4 digits.');
          const month = Number(q('month'));
          if (!/^\d{1,2}$/.test(q('month')) || month < 1 || month > 12)
            return invalid('month', 'The month is not a valid month.');
          const day = Number(q('day'));
          if (!/^\d{1,2}$/.test(q('day')) || day < 1 || day > 31)
            return invalid('day', 'The day must be between 1 and 2 digits.');
          const count = Number(q('count') || '10');
          if (!Number.isInteger(count) || count < 1)
            return invalid('count', 'The count must be at least 1.');
          if (count > 1000) return invalid('count', 'The count may not be greater than 1000.');
          const skip = Number(q('skip') || '0');
          if (!Number.isInteger(skip) || skip < 0) return invalid('skip', 'The skip is invalid.');
          const date = `${q('year')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const items = (state.settlements.get(date) ?? []).slice(skip, skip + count);
          return { status: 200, body: { entity: 'collection', count: items.length, items } };
        });
      }
      // POST /v1/plans (R-063)
      if (method === 'POST' && url.pathname === '/v1/plans') {
        return behave(state.queues.createPlan, () => {
          const item = (body?.item ?? {}) as Record<string, unknown>;
          const amount = Number(item.amount);
          const interval = Number(body?.interval);
          const period = String(body?.period ?? '');
          const invalid = (description: string) => ({
            status: 400,
            body: { error: { code: 'BAD_REQUEST_ERROR', description } },
          });
          if (!['daily', 'weekly', 'monthly', 'quarterly', 'yearly'].includes(period))
            return invalid('The period is invalid.');
          if (!Number.isInteger(interval) || interval < 1)
            return invalid('The interval is invalid.');
          if (!Number.isInteger(amount) || amount < 100) return invalid('The amount is invalid.');
          if (typeof item.name !== 'string' || !item.name) return invalid('The name is required.');
          const plan: StandInPlan = {
            id: id('plan'),
            period,
            interval,
            amount,
            currency: String(item.currency ?? 'INR'),
            name: item.name,
          };
          state.plans.set(plan.id, plan);
          return { status: 200, body: planJson(plan) };
        });
      }
      // POST /v1/subscriptions (R-064)
      if (method === 'POST' && url.pathname === '/v1/subscriptions') {
        return behave(state.queues.createSubscription, () => {
          const plan = state.plans.get(String(body?.plan_id ?? ''));
          const totalCount = Number(body?.total_count);
          if (!plan) {
            return {
              status: 400,
              body: {
                error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' },
              },
            };
          }
          if (!Number.isInteger(totalCount) || totalCount < 1) {
            return {
              status: 400,
              body: {
                error: {
                  code: 'BAD_REQUEST_ERROR',
                  description: 'The total count field is required.',
                },
              },
            };
          }
          const sub: StandInSubscription = {
            id: id('sub'),
            planId: plan.id,
            status: 'created',
            totalCount,
            quantity: Number(body?.quantity ?? 1),
            customerNotify: body?.customer_notify !== false,
            expireBy: typeof body?.expire_by === 'number' ? body.expire_by : null,
            notes: body?.notes ?? [],
            customerId: null,
            currentStart: null,
            currentEnd: null,
            chargeAt: null,
            endedAt: null,
            paidCount: 0,
            cancelAtCycleEnd: false,
            createdAt: nowUnix(),
            startAt: typeof body?.start_at === 'number' ? body.start_at : null,
          };
          state.subscriptions.set(sub.id, sub);
          return { status: 200, body: subscriptionJson(sub) };
        });
      }
      // POST /v1/subscriptions/:id/cancel (R-068)
      if (method === 'POST' && seg[1] === 'subscriptions' && seg[2] && seg[3] === 'cancel') {
        return behave(state.queues.cancelSubscription, () => {
          const sub = state.subscriptions.get(seg[2] ?? '');
          if (!sub) {
            return {
              status: 400,
              body: {
                error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' },
              },
            };
          }
          if (
            sub.status === 'cancelled' ||
            sub.status === 'completed' ||
            sub.status === 'expired'
          ) {
            return {
              status: 400,
              body: {
                error: {
                  code: 'BAD_REQUEST_ERROR',
                  description: `Subscription is not cancellable in ${sub.status} status.`,
                  field: 'status',
                },
              },
            };
          }
          if (body?.cancel_at_cycle_end === true && sub.status === 'active') {
            sub.cancelAtCycleEnd = true;
          } else {
            sub.status = 'cancelled';
            sub.endedAt = nowUnix();
          }
          return { status: 200, body: subscriptionJson(sub) };
        });
      }
      // GET /v1/subscriptions/:id
      if (method === 'GET' && seg[1] === 'subscriptions' && seg[2] && !seg[3]) {
        return behave(state.queues.subscriptionFetch, () => {
          const sub = state.subscriptions.get(seg[2] ?? '');
          if (!sub) {
            return {
              status: 400,
              body: {
                error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' },
              },
            };
          }
          return { status: 200, body: subscriptionJson(sub) };
        });
      }
      // GET /v1/invoices?subscription_id=&count=&skip= (R-065), newest first
      if (method === 'GET' && url.pathname === '/v1/invoices') {
        return behave(state.queues.subscriptionFetch, () => {
          const subscriptionId = url.searchParams.get('subscription_id');
          const count = Number(url.searchParams.get('count') ?? '10');
          const skip = Number(url.searchParams.get('skip') ?? '0');
          if (!Number.isInteger(count) || count < 1 || count > 100) {
            return {
              status: 400,
              body: {
                error: {
                  code: 'BAD_REQUEST_ERROR',
                  description: 'The count may not be greater than 100.',
                },
              },
            };
          }
          const items = [...state.invoices.values()]
            .filter((i) => !subscriptionId || i.subscriptionId === subscriptionId)
            .reverse()
            .slice(skip, skip + count)
            .map(invoiceJson);
          return { status: 200, body: { entity: 'collection', count: items.length, items } };
        });
      }
      // GET /v1/invoices/:id
      if (method === 'GET' && seg[1] === 'invoices' && seg[2]) {
        return behave(state.queues.subscriptionFetch, () => {
          const invoice = state.invoices.get(seg[2] ?? '');
          if (!invoice) {
            return {
              status: 400,
              body: {
                error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' },
              },
            };
          }
          return { status: 200, body: invoiceJson(invoice) };
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
    settle,
    authorizeSubscription,
    chargeSubscription,
    endSubscriptionCycle,
    setSubscriptionStatus(subscriptionId, status) {
      const sub = subscriptionOf(subscriptionId);
      sub.status = status;
      if ((status === 'cancelled' || status === 'completed') && sub.endedAt === null) {
        sub.endedAt = nowUnix();
      }
      return sub;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
