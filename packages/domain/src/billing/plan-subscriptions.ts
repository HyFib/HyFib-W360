import { AppError, displayMoney, uuidv7, type Clock, type RazorpayConfig } from '@w360/core';
import {
  and,
  billingCustomers,
  count,
  desc,
  eq,
  gt,
  inArray,
  or,
  planPaymentRefunds,
  planPayments,
  planSettings,
  planSubscriptions,
  plans,
  sql,
  systemScope,
  authorizedTenantScope,
  tenantPlans,
  tenants,
  LIVE_PLAN_SUBSCRIPTION_STATUSES,
  type Database,
  type PlanPaymentRefundOrigin,
  type PlanPaymentRefundStatus,
  type PlanSubscriptionStatus,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { recordAudit, recordSystemAudit, type RequestMeta } from '../audit';
import { assertCan, type TenantContext } from '../authz/context';
import { assertRecentSignIn } from '../authz/step-up';
import {
  planPaymentQuote,
  planPaymentStart,
  PLAN_PAYMENT_UNAVAILABLE_TEXT,
  type PlanPaymentQuote,
  type PlanPaymentUnavailable,
} from '../plans/model';
import { paymentMethodLabel } from './history';
import { notifyBillingManagers, type BillingNoticeDeps } from './notices';
import { transient, TransientProviderError, type BillingProviderDeps } from './provider';
import {
  verifySubscriptionCheckoutSignature,
  type RazorpayClient,
  type RazorpayInvoice,
  type RazorpayPayment,
  type RazorpaySubscription,
} from './razorpay';

/**
 * Paying for plans with Razorpay Subscriptions (P5-07, ADR-063). A company pays for the plan
 * version it is on, with its add-ons, every billing interval. HyFib records its subscription before
 * calling Razorpay, and follows the subscription only as Razorpay reports it when asked: the
 * browser's Checkout response, webhook payloads and notes only prompt a fetch. Each paid invoice is
 * recorded once as a plan payment, and a definer function makes the plan active for exactly the
 * paid billing cycle.
 */

/** Cycles asked for: five years (Razorpay charges a subscription for at most ten years). */
export const PLAN_SUBSCRIPTION_YEARS = 5;
/** How long Checkout can authorise a new subscription (`expire_by`). */
export const PLAN_SUBSCRIPTION_AUTHORIZE_MS = 3600_000;
/** A subscription still being created after this long failed (its two calls time out sooner). */
export const PLAN_SUBSCRIPTION_CREATING_MS = 10 * 60_000;
const INVOICE_PAGE_SIZE = 100;
/** More pages than five years of monthly invoices. */
const INVOICE_MAX_PAGES = 12;
const PERIODS = { 1: 'monthly', 3: 'quarterly', 12: 'yearly' } as const;
const EVERY: Record<number, string> = {
  1: 'every month',
  3: 'every three months',
  12: 'every year',
};
const PAYMENT_ID_RE = /^pay_[A-Za-z0-9]{1,40}$/;
const PAYMENT_METHOD_RE = /^[a-z_]{1,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENDED: readonly PlanSubscriptionStatus[] = ['cancelled', 'completed', 'expired', 'failed'];
const LIVE: readonly PlanSubscriptionStatus[] = LIVE_PLAN_SUBSCRIPTION_STATUSES;

type SubscriptionRow = typeof planSubscriptions.$inferSelect;

export interface PlanSubscriptionSummary {
  id: string;
  status: PlanSubscriptionStatus;
  intervalMonths: number;
  subtotalMinor: number;
  taxBp: number;
  taxMinor: number;
  amountMinor: number;
  currentStart: Date | null;
  currentEnd: Date | null;
  chargeAt: Date | null;
  endedAt: Date | null;
  cancelAtPeriodEnd: boolean;
  cancelRequestedAt: Date | null;
  failureReason: string | null;
  authorizeBy: Date;
  createdAt: Date;
  /** When the first charge is due, at the trial's end (ADR-102); null: charged in Checkout. */
  startsAt: Date | null;
  /** Billing cycles Razorpay has charged. */
  paidCount: number;
  /** Its first charge, due at the trial's end, is still ahead (ADR-102). */
  firstChargeAhead: boolean;
  /** Checkout can still authorise it: created and its window is open. */
  checkoutOpen: boolean;
}

export interface PlanPaymentRecord {
  id: string;
  amountMinor: number;
  periodStart: Date;
  periodEnd: Date;
  paidAt: Date;
  method: string | null;
  /** Refunds Razorpay processed (ADR-103). */
  refundedMinor: number;
  /** A refund HyFib asked for that Razorpay has not finished. */
  openRefundMinor: number | null;
}

/** A refund of a plan payment as the company sees it (ADR-103): no staff reason or name. */
export interface PlanPaymentReceiptRefund {
  id: string;
  amountMinor: number;
  status: PlanPaymentRefundStatus;
  /** Asked for by HyFib, or made at Razorpay (for example in its Dashboard). */
  origin: PlanPaymentRefundOrigin;
  requestedAt: Date;
  processedAt: Date | null;
}

export type PlanPaymentOffer =
  | {
      available: true;
      quote: PlanPaymentQuote;
      intervalMonths: number;
      /** A trial far enough away is paid from its end (ADR-102); null: charged at once. */
      startsAt: Date | null;
    }
  | { available: false; reason: PlanPaymentUnavailable };

/**
 * The receipt of a plan payment (ADR-064): a payment confirmation for the plan, not a tax invoice.
 * The breakdown is the subscription's, shown only when the payment is exactly its total (as every
 * recorded payment is).
 */
export interface PlanPaymentReceipt {
  id: string;
  /** Razorpay's invoice id, which Razorpay also shows for the charge. */
  receiptNumber: string;
  amountMinor: number;
  currency: 'INR';
  breakdown: { subtotalMinor: number; taxBp: number; taxMinor: number } | null;
  planName: string;
  planCode: string;
  planVersion: number;
  intervalMonths: number;
  extraSeats: number;
  extraNumbers: number;
  runPacks: number;
  periodStart: Date;
  periodEnd: Date;
  paidAt: Date;
  method: string | null;
  methodLabel: string | null;
  providerPaymentId: string;
  providerInvoiceId: string;
  providerSubscriptionId: string | null;
  companyName: string;
  billingEmail: string | null;
  timezone: string;
  /** The payment's refunds, oldest first, except those that failed (ADR-103). */
  refunds: PlanPaymentReceiptRefund[];
  /** What Razorpay refunded of it. */
  refundedMinor: number;
}

export interface PlanPaymentOverview {
  offer: PlanPaymentOffer;
  /** The subscription that may still be charged, or else the latest one that was paid. */
  subscription: PlanSubscriptionSummary | null;
  payments: PlanPaymentRecord[];
}

/** What the browser needs to open Checkout for a subscription (R-072). */
export interface SubscriptionCheckoutStart {
  subscriptionId: string;
  providerSubscriptionId: string;
  keyId: string;
  amountMinor: number;
  intervalMonths: number;
  planName: string;
  companyName: string;
  prefill: { name: string; email: string };
}

export interface PlanSubscriptionServiceDeps {
  db: Database;
  clock: Clock;
  razorpay: RazorpayClient | null;
  razorpayConfig: RazorpayConfig | null;
  notices: BillingNoticeDeps;
}

function summary(row: SubscriptionRow, now: Date): PlanSubscriptionSummary {
  return {
    id: row.id,
    status: row.status,
    intervalMonths: row.intervalMonths,
    subtotalMinor: row.subtotalMinor,
    taxBp: row.taxBp,
    taxMinor: row.taxMinor,
    amountMinor: row.amountMinor,
    currentStart: row.currentStart,
    currentEnd: row.currentEnd,
    chargeAt: row.chargeAt,
    endedAt: row.endedAt,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    cancelRequestedAt: row.cancelRequestedAt,
    failureReason: row.failureReason,
    authorizeBy: row.authorizeBy,
    createdAt: row.createdAt,
    startsAt: row.startsAt,
    paidCount: row.paidCount,
    firstChargeAhead: row.startsAt !== null && row.paidCount === 0 && now < row.startsAt,
    checkoutOpen:
      row.status === 'created' && row.providerSubscriptionId !== null && now < row.authorizeBy,
  };
}

/**
 * Whether and at what price the company can start paying for its plan (ADR-063). `liveSeen`:
 * a subscription that may still be charged exists (then it cannot start another).
 */
async function offerIn(
  tx: Tx,
  tenantId: string,
  enabled: boolean,
  liveSeen: boolean,
  now: Date,
): Promise<{ offer: PlanPaymentOffer; planName: string | null }> {
  const [company] = await tx
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  const [state] = await tx.select().from(tenantPlans).where(eq(tenantPlans.tenantId, tenantId));
  if (!state) throw new Error('The company has no plan state');
  const [plan] = state.planId
    ? await tx
        .select({
          name: plans.name,
          status: plans.status,
          priceMinor: plans.priceMinor,
          intervalMonths: plans.intervalMonths,
          seatPriceMinor: plans.seatPriceMinor,
          numberPriceMinor: plans.numberPriceMinor,
          runPackPriceMinor: plans.runPackPriceMinor,
        })
        .from(plans)
        .where(eq(plans.id, state.planId))
    : [];
  const [settings] = await tx.select({ planTaxBp: planSettings.planTaxBp }).from(planSettings);
  const planName = plan?.name ?? null;
  const no = (reason: PlanPaymentUnavailable) => ({
    offer: { available: false as const, reason },
    planName,
  });
  if (!enabled) return no('not_offered');
  if (company?.status === 'pending_deletion' || company?.status === 'deleted') {
    return no('deleting');
  }
  if (liveSeen) return no('subscribed');
  if (state.status === 'complimentary' || !plan) return no('complimentary');
  if (state.status === 'active') return no('paid_period');
  if (plan.status !== 'published') return no('plan_not_published');
  if (settings?.planTaxBp === null || settings?.planTaxBp === undefined) return no('no_tax');
  const quote = planPaymentQuote(plan, state, settings.planTaxBp);
  if (!quote.ok) return no(quote.reason);
  return {
    offer: {
      available: true,
      quote: quote.quote,
      intervalMonths: plan.intervalMonths,
      startsAt: planPaymentStart(state, now),
    },
    planName,
  };
}

async function failCreating(tx: Tx, tenantId: string, id: string, reason: string) {
  await tx
    .update(planSubscriptions)
    .set({ status: 'failed', failureReason: reason.slice(0, 500) })
    .where(
      and(
        eq(planSubscriptions.tenantId, tenantId),
        eq(planSubscriptions.id, id),
        eq(planSubscriptions.status, 'creating'),
      ),
    );
}

async function companyDay(tx: Tx, tenantId: string) {
  const [company] = await tx
    .select({ timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return (at: Date) =>
    new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeZone: company?.timezone ?? 'Asia/Kolkata',
    }).format(at);
}

async function planNameOf(tx: Tx, planId: string): Promise<string> {
  const [plan] = await tx.select({ name: plans.name }).from(plans).where(eq(plans.id, planId));
  return plan?.name ?? 'your';
}

const fromUnix = (seconds: number | null) => (seconds === null ? null : new Date(seconds * 1000));

/** Every invoice of the subscription Razorpay returns, page by page (null: unreadable). */
async function subscriptionInvoices(
  razorpay: RazorpayClient,
  providerSubscriptionId: string,
): Promise<(RazorpayInvoice | null)[]> {
  const all: (RazorpayInvoice | null)[] = [];
  for (let page = 0; page < INVOICE_MAX_PAGES; page += 1) {
    const res = await razorpay.fetchSubscriptionInvoices(providerSubscriptionId, {
      count: INVOICE_PAGE_SIZE,
      skip: page * INVOICE_PAGE_SIZE,
    });
    if (!res.ok) throw transient(res, 'invoice fetch');
    all.push(...res.data.items);
    if (res.data.items.length < INVOICE_PAGE_SIZE) return all;
  }
  throw new TransientProviderError('invoice fetch: more invoices than HyFib reads');
}

interface NewPlanPayment {
  providerPaymentId: string;
  providerInvoiceId: string;
  amountMinor: number;
  periodStart: Date;
  periodEnd: Date;
  paidAt: Date;
  method: string | null;
}

/**
 * A paid invoice of the subscription as a plan payment, when Razorpay reports its payment captured
 * for the subscription's amount (fetched, never taken from the invoice alone); null otherwise.
 */
async function planPaymentFrom(
  razorpay: RazorpayClient,
  row: SubscriptionRow,
  invoice: RazorpayInvoice,
): Promise<NewPlanPayment | null> {
  if (
    invoice.status !== 'paid' ||
    invoice.subscriptionId !== row.providerSubscriptionId ||
    !invoice.paymentId ||
    invoice.billingStart === null ||
    invoice.billingEnd === null ||
    invoice.billingEnd <= invoice.billingStart ||
    invoice.amountPaid !== row.amountMinor ||
    (invoice.currency !== null && invoice.currency !== 'INR')
  ) {
    return null;
  }
  const fetched = await razorpay.fetchPayment(invoice.paymentId);
  if (!fetched.ok) {
    if (fetched.kind === 'permanent') return null;
    throw transient(fetched, 'payment fetch');
  }
  const payment = fetched.data;
  if (
    payment.status !== 'captured' ||
    !payment.captured ||
    payment.amount !== row.amountMinor ||
    payment.currency !== 'INR'
  ) {
    return null;
  }
  return {
    providerPaymentId: payment.id,
    providerInvoiceId: invoice.id,
    amountMinor: payment.amount,
    periodStart: new Date(invoice.billingStart * 1000),
    periodEnd: new Date(invoice.billingEnd * 1000),
    paidAt: fromUnix(invoice.paidAt) ?? new Date(),
    method: payment.method && PAYMENT_METHOD_RE.test(payment.method) ? payment.method : null,
  };
}

export type PlanPeriodResult = 'applied' | 'unchanged' | 'not_paid' | 'mismatch';

export interface PlanSubscriptionSyncResult {
  status: PlanSubscriptionStatus;
  /** Plan payments recorded by this sync. */
  recorded: number;
  period: PlanPeriodResult | null;
}

/**
 * Follows one subscription as Razorpay reports it now (ADR-063): records its paid invoices once as
 * plan payments, stores its state, makes the plan active for a paid current cycle, and emails the
 * billing managers when a payment made the plan active or a charge failed. An unpaid subscription
 * whose authorisation window closed is cancelled at Razorpay, so it can never be paid late. Only a
 * Razorpay failure that may pass is thrown (TransientProviderError).
 */
export async function syncPlanSubscription(
  deps: BillingProviderDeps,
  scope: TenantScope,
  subscriptionId: string,
): Promise<PlanSubscriptionSyncResult | null> {
  const tenantId = scope.tenantId;
  const where = and(
    eq(planSubscriptions.tenantId, tenantId),
    eq(planSubscriptions.id, subscriptionId),
  );
  const [row] = await deps.db.run(scope, (tx) => tx.select().from(planSubscriptions).where(where), {
    accessMode: 'read only',
  });
  if (!row) return null;
  const now = deps.clock.now();
  const unchanged = { status: row.status, recorded: 0, period: null };
  if (row.status === 'creating') {
    if (now.getTime() - row.createdAt.getTime() < PLAN_SUBSCRIPTION_CREATING_MS) return unchanged;
    await deps.db.run(scope, (tx) =>
      failCreating(tx, tenantId, row.id, 'The payment could not be started.'),
    );
    return { status: 'failed', recorded: 0, period: null };
  }
  if (!row.providerSubscriptionId || ENDED.includes(row.status)) return unchanged;

  const note = async (reason: string) => {
    await deps.db.run(scope, (tx) =>
      tx
        .update(planSubscriptions)
        .set({ failureReason: reason.slice(0, 500), syncedAt: now })
        .where(where),
    );
    return unchanged;
  };
  const fetched = await deps.razorpay.fetchSubscription(row.providerSubscriptionId);
  if (!fetched.ok) {
    if (fetched.kind === 'permanent') {
      return note(`Razorpay did not return the subscription: ${fetched.description}`);
    }
    throw transient(fetched, 'subscription fetch');
  }
  let sub: RazorpaySubscription = fetched.data;
  if (sub.id !== row.providerSubscriptionId || sub.planId !== row.providerPlanId) {
    return note('Razorpay returned a subscription for another plan.');
  }
  if (sub.status === 'created' && now >= row.authorizeBy) {
    const cancelled = await deps.razorpay.cancelSubscription(sub.id, { cancelAtCycleEnd: false });
    if (cancelled.ok) {
      sub = cancelled.data;
    } else if (cancelled.kind !== 'permanent') {
      throw transient(cancelled, 'subscription cancel');
    } else {
      const again = await deps.razorpay.fetchSubscription(sub.id);
      if (!again.ok) throw transient(again, 'subscription fetch');
      sub = again.data;
      if (sub.status === 'created') {
        return note(
          `Razorpay kept the unpaid subscription open after its payment window: ${cancelled.description}`,
        );
      }
    }
  }

  // Paid invoices, only while Razorpay counts more paid cycles than HyFib recorded.
  const [recordedCount] = await deps.db.run(
    scope,
    (tx) =>
      tx
        .select({ n: count() })
        .from(planPayments)
        .where(and(eq(planPayments.tenantId, tenantId), eq(planPayments.subscriptionId, row.id))),
    { accessMode: 'read only' },
  );
  const payments: NewPlanPayment[] = [];
  if (sub.paidCount > Number(recordedCount?.n ?? 0)) {
    const known = new Set(
      (
        await deps.db.run(
          scope,
          (tx) =>
            tx
              .select({ id: planPayments.providerPaymentId })
              .from(planPayments)
              .where(
                and(eq(planPayments.tenantId, tenantId), eq(planPayments.subscriptionId, row.id)),
              ),
          { accessMode: 'read only' },
        )
      ).map((p) => p.id),
    );
    for (const invoice of await subscriptionInvoices(deps.razorpay, sub.id)) {
      if (!invoice?.paymentId || known.has(invoice.paymentId)) continue;
      const payment = await planPaymentFrom(deps.razorpay, row, invoice);
      if (payment) payments.push(payment);
    }
  }

  return deps.db.run(scope, async (tx) => {
    const [current] = await tx.select().from(planSubscriptions).where(where).for('update');
    if (!current) throw new Error('subscription disappeared');
    let recorded = 0;
    for (const payment of payments) {
      const inserted = await tx
        .insert(planPayments)
        .values({ id: uuidv7(), tenantId, subscriptionId: row.id, currency: 'INR', ...payment })
        .onConflictDoNothing()
        .returning({ id: planPayments.id });
      recorded += inserted.length;
    }
    // A subscription that ended stays ended; a status HyFib does not know keeps the stored one;
    // an older answer (fewer paid cycles) than the stored one changes nothing.
    const stale = sub.paidCount < current.paidCount;
    const status: PlanSubscriptionStatus =
      ENDED.includes(current.status) || stale || sub.status === null ? current.status : sub.status;
    await tx
      .update(planSubscriptions)
      .set({
        status,
        ...(stale
          ? {}
          : {
              currentStart: fromUnix(sub.currentStart),
              currentEnd: fromUnix(sub.currentEnd),
              chargeAt: fromUnix(sub.chargeAt),
              paidCount: sub.paidCount,
              endedAt: fromUnix(sub.endedAt),
            }),
        failureReason: null,
        syncedAt: now,
      })
      .where(where);

    let period: PlanPeriodResult | null = null;
    if (status === 'active') {
      const res = await tx.execute<{ result: PlanPeriodResult }>(
        sql`select app.apply_plan_subscription_period(${tenantId}::uuid, ${row.id}::uuid) as result`,
      );
      period = res.rows[0]?.result ?? null;
    }
    const becamePending = status === 'pending' && current.status !== 'pending';
    const becameHalted = status === 'halted' && current.status !== 'halted';
    // Authorised in Checkout, to be charged first when the trial ends (ADR-102).
    const becameScheduled =
      status === 'authenticated' && current.status !== 'authenticated' && current.startsAt !== null;
    if (period === 'applied' || becamePending || becameHalted || becameScheduled) {
      const day = await companyDay(tx, tenantId);
      const planName = await planNameOf(tx, row.planId);
      const amount = displayMoney(BigInt(row.amountMinor), 'INR');
      const [after] = await tx.select().from(planSubscriptions).where(where);
      const paidUntil = after?.currentEnd ?? null;
      if (period === 'applied') {
        // The payment of the latest billing period: the one that paid the cycle just applied.
        const [latest] = await tx
          .select({ id: planPayments.id })
          .from(planPayments)
          .where(and(eq(planPayments.tenantId, tenantId), eq(planPayments.subscriptionId, row.id)))
          .orderBy(desc(planPayments.periodStart))
          .limit(1);
        await notifyBillingManagers(deps.notices, tx, scope, {
          subject: 'Payment received for your HyFib plan',
          ...(latest ? { billingPath: `plan-payments/${latest.id}` } : {}),
          lines: [
            `We received ${amount} for the ${planName} plan${paidUntil ? `. It is paid until ${day(paidUntil)}` : ''}.`,
            after?.cancelAtPeriodEnd
              ? 'The subscription is cancelled, so nothing more is charged.'
              : 'Razorpay charges the same amount at the start of each billing period until the subscription is cancelled in billing.',
          ],
        });
      } else if (becamePending) {
        // A trial waiting for its first charge (ADR-102) says how long it waits.
        const wait =
          after?.startsAt && after.paidCount === 0
            ? ((
                await tx.execute<{ until: Date | string | null }>(
                  sql`select app.trial_charge_wait_until(${tenantId}::uuid) as until`,
                )
              ).rows[0]?.until ?? null)
            : null;
        await notifyBillingManagers(deps.notices, tx, scope, {
          subject: 'A payment for your HyFib plan failed',
          lines: [
            `Razorpay could not charge ${amount} for the ${planName} plan and will try again.`,
            wait
              ? `Everything keeps working until ${day(new Date(wait))} while Razorpay tries again; the payer can change the card through the link in Razorpay’s email.`
              : 'The payer can change the card through the link in Razorpay’s email.',
          ],
        });
      } else if (becameHalted) {
        await notifyBillingManagers(deps.notices, tx, scope, {
          subject: 'Payments for your HyFib plan have stopped',
          lines: [
            `Razorpay could not charge ${amount} for the ${planName} plan and has stopped trying.`,
            `The payer can change the card through the link in Razorpay’s email; the plan is paid${(after?.paidCount ?? 0) > 0 ? ' again' : ''} once a charge goes through. You can also cancel the subscription in billing and pay again.`,
          ],
        });
      } else if (current.startsAt) {
        await notifyBillingManagers(deps.notices, tx, scope, {
          subject: 'Payments for your HyFib plan start when the trial ends',
          lines: [
            `Razorpay charges ${amount} for the ${planName} plan on ${day(current.startsAt)}, when the trial ends, and ${EVERY[row.intervalMonths] ?? 'each period'} after that until the subscription is cancelled in billing.`,
            'Nothing is charged for the plan before then, and the trial goes on as it is.',
          ],
        });
      }
    }
    return { status, recorded, period };
  });
}

/**
 * A payment HyFib has no order for may be a subscription charge: its invoice (fetched) names the
 * subscription. Syncs that subscription when it is one of ours and returns it; null when the
 * payment is not a charge of one of our subscriptions.
 */
export async function syncPlanSubscriptionForPayment(
  deps: BillingProviderDeps,
  payment: RazorpayPayment,
): Promise<{ tenantId: string; subscriptionId: string } | null> {
  if (!payment.invoiceId) return null;
  const invoice = await deps.razorpay.fetchInvoice(payment.invoiceId);
  if (!invoice.ok) {
    if (invoice.kind === 'permanent') return null;
    throw transient(invoice, 'invoice fetch');
  }
  if (!invoice.data.subscriptionId) return null;
  const binding = await resolvePlanSubscription(deps.db, invoice.data.subscriptionId);
  if (!binding) return null;
  await syncPlanSubscription(
    deps,
    authorizedTenantScope(binding.tenantId, null),
    binding.subscriptionId,
  );
  return binding;
}

/** Our subscription for a Razorpay subscription id (ids only), from our own records. */
export async function resolvePlanSubscription(
  db: Database,
  providerSubscriptionId: string,
): Promise<{ tenantId: string; subscriptionId: string } | null> {
  return db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{ tenant_id: string; subscription_id: string }>(
        sql`select tenant_id, subscription_id from ops.billing_resolve_subscription(${providerSubscriptionId})`,
      );
      const row = res.rows[0];
      return row ? { tenantId: row.tenant_id, subscriptionId: row.subscription_id } : null;
    },
    { accessMode: 'read only' },
  );
}

/** The refunds of some of the company's plan payments, oldest first (ADR-103). */
async function refundsOf(tx: Tx, tenantId: string, planPaymentIds: string[]) {
  if (planPaymentIds.length === 0) return [];
  return tx
    .select({
      id: planPaymentRefunds.id,
      planPaymentId: planPaymentRefunds.planPaymentId,
      amountMinor: planPaymentRefunds.amountMinor,
      status: planPaymentRefunds.status,
      origin: planPaymentRefunds.origin,
      requestedAt: planPaymentRefunds.requestedAt,
      processedAt: planPaymentRefunds.processedAt,
    })
    .from(planPaymentRefunds)
    .where(
      and(
        eq(planPaymentRefunds.tenantId, tenantId),
        inArray(planPaymentRefunds.planPaymentId, planPaymentIds),
      ),
    )
    .orderBy(planPaymentRefunds.requestedAt, planPaymentRefunds.id);
}

const refundedOf = (refunds: readonly { status: string; amountMinor: number }[]) =>
  refunds.filter((r) => r.status === 'processed').reduce((sum, r) => sum + r.amountMinor, 0);

/**
 * The plan payment HyFib recorded for a Razorpay payment id, if any (the settlement check, and
 * refunds of plan payments, ADR-103).
 */
export async function findPlanPayment(
  db: Database,
  providerPaymentId: string,
): Promise<{
  tenantId: string;
  planPaymentId: string;
  subscriptionId: string;
  amountMinor: number;
} | null> {
  return db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{
        tenant_id: string;
        plan_payment_id: string;
        subscription_id: string;
        amount_minor: string | number;
      }>(
        sql`select tenant_id, plan_payment_id, subscription_id, amount_minor
              from ops.billing_resolve_plan_payment(${providerPaymentId})`,
      );
      const row = res.rows[0];
      return row
        ? {
            tenantId: row.tenant_id,
            planPaymentId: row.plan_payment_id,
            subscriptionId: row.subscription_id,
            amountMinor: Number(row.amount_minor),
          }
        : null;
    },
    { accessMode: 'read only' },
  );
}

export interface PlanSubscriptionSweepResult {
  synced: number;
  failed: { tenantId: string; subscriptionId: string; error: unknown }[];
}

/**
 * The minute sweep's subscription checks (ops.plan_subscriptions_due): subscriptions that were
 * never created at Razorpay fail, unpaid ones whose window closed are cancelled, and those that may
 * still be charged are synced after each billing cycle and at least daily. One failure does not
 * hold up the others.
 */
export async function sweepPlanSubscriptions(
  deps: BillingProviderDeps,
  limit = 100,
): Promise<PlanSubscriptionSweepResult> {
  const due = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ tenant_id: string; subscription_id: string }>(
        sql`select tenant_id, subscription_id from ops.plan_subscriptions_due(${limit})`,
      ),
    { accessMode: 'read only' },
  );
  const result: PlanSubscriptionSweepResult = { synced: 0, failed: [] };
  for (const { tenant_id: tenantId, subscription_id: subscriptionId } of due.rows) {
    try {
      await syncPlanSubscription(deps, authorizedTenantScope(tenantId, null), subscriptionId);
      result.synced += 1;
    } catch (error) {
      result.failed.push({ tenantId, subscriptionId, error });
    }
  }
  return result;
}

/**
 * The company's subscription that may still be charged, synced before the plan sweep moves an ended
 * period or trial on: the one that paid the current period (a renewal whose webhook was missed then
 * counts), or one whose first charge was due at the trial's end (ADR-102). A company has at most one
 * live subscription; one still in Checkout is left alone.
 */
export async function syncPlanSubscriptionOfPlan(
  deps: BillingProviderDeps,
  scope: TenantScope,
): Promise<void> {
  const [live] = await deps.db.run(
    scope,
    (tx) =>
      tx
        .select({ id: planSubscriptions.id })
        .from(planSubscriptions)
        .where(
          and(
            eq(planSubscriptions.tenantId, scope.tenantId),
            inArray(planSubscriptions.status, [
              'authenticated',
              'active',
              'pending',
              'halted',
              'paused',
            ]),
          ),
        ),
    { accessMode: 'read only' },
  );
  if (live) await syncPlanSubscription(deps, scope, live.id);
}

/**
 * Company deletion (ADR-055): cancels the company's subscription at Razorpay at once, so nothing
 * more is charged. Returns what happened, for the deletion's clean-up record.
 */
export async function cancelPlanSubscriptionForDeletion(
  deps: Pick<BillingProviderDeps, 'db' | 'clock'> & { razorpay: RazorpayClient | null },
  scope: TenantScope,
): Promise<{ label: string; outcome: 'done' | 'failed' | 'skipped'; code?: string } | null> {
  const [row] = await deps.db.run(
    scope,
    (tx) =>
      tx
        .select()
        .from(planSubscriptions)
        .where(
          and(
            eq(planSubscriptions.tenantId, scope.tenantId),
            inArray(planSubscriptions.status, [...LIVE]),
          ),
        ),
    { accessMode: 'read only' },
  );
  if (!row) return null;
  const label = 'Plan subscription at Razorpay';
  const stop = async (status: PlanSubscriptionStatus) =>
    deps.db.run(scope, async (tx) => {
      const now = deps.clock.now();
      await tx
        .update(planSubscriptions)
        .set({
          status,
          ...(status === 'cancelled' ? { endedAt: now, cancelRequestedAt: now } : {}),
          ...(status === 'failed' ? { failureReason: 'The company was deleted.' } : {}),
        })
        .where(
          and(eq(planSubscriptions.tenantId, scope.tenantId), eq(planSubscriptions.id, row.id)),
        );
      await recordSystemAudit(tx, scope.tenantId, {
        action: 'billing.plan_subscription_cancelled',
        subjectType: 'plan_subscription',
        subjectId: row.id,
        metadata: { reason: 'company_deleted', status },
      });
    });
  if (!row.providerSubscriptionId) {
    // Never created at Razorpay: nothing can be charged.
    await stop('failed');
    return { label, outcome: 'skipped', code: 'not_created' };
  }
  if (!deps.razorpay) return { label, outcome: 'skipped', code: 'razorpay_not_set_up' };
  const res = await deps.razorpay.cancelSubscription(row.providerSubscriptionId, {
    cancelAtCycleEnd: false,
  });
  // A permanent refusal: Razorpay already ended it (cancelled, completed or expired).
  if (!res.ok && res.kind !== 'permanent') {
    return { label, outcome: 'failed', code: `razorpay_${res.kind}` };
  }
  await stop('cancelled');
  return { label, outcome: 'done' };
}

/** The company side: the plan payment overview, starting, confirming and cancelling. */
export function createPlanSubscriptionService(deps: PlanSubscriptionServiceDeps) {
  const { db, clock } = deps;
  const enabled = () => Boolean(deps.razorpay && deps.razorpayConfig?.subscriptionsEnabled);

  function provider(): { razorpay: RazorpayClient; config: RazorpayConfig } {
    if (!deps.razorpay || !deps.razorpayConfig) {
      throw new AppError(
        'provider_unavailable',
        'Card payments are not configured for this platform yet.',
      );
    }
    return { razorpay: deps.razorpay, config: deps.razorpayConfig };
  }

  function providerDeps(razorpay: RazorpayClient): BillingProviderDeps {
    return { db, razorpay, clock, notices: deps.notices };
  }

  async function liveRow(tx: Tx, tenantId: string): Promise<SubscriptionRow | undefined> {
    const [row] = await tx
      .select()
      .from(planSubscriptions)
      .where(
        and(eq(planSubscriptions.tenantId, tenantId), inArray(planSubscriptions.status, [...LIVE])),
      );
    return row;
  }

  function checkoutFor(
    ctx: TenantContext,
    config: RazorpayConfig,
    row: SubscriptionRow,
    planName: string,
  ): SubscriptionCheckoutStart {
    if (!row.providerSubscriptionId) throw new Error('subscription not created at Razorpay');
    return {
      subscriptionId: row.id,
      providerSubscriptionId: row.providerSubscriptionId,
      keyId: config.keyId,
      amountMinor: row.amountMinor,
      intervalMonths: row.intervalMonths,
      planName,
      companyName: ctx.tenant.name,
      prefill: { name: ctx.user.name, email: ctx.user.email },
    };
  }

  const unavailable = () =>
    new AppError('provider_unavailable', 'We could not reach Razorpay. Try again in a moment.');

  return {
    /** What the company pays for its plan, its subscription and its plan payments (`billing.read`). */
    async overview(ctx: TenantContext): Promise<PlanPaymentOverview> {
      assertCan(ctx, 'billing.read');
      const now = clock.now();
      return db.run(
        ctx.scope,
        async (tx) => {
          const live = await liveRow(tx, ctx.tenant.id);
          const { offer } = await offerIn(tx, ctx.tenant.id, enabled(), Boolean(live), now);
          const [shown] = live
            ? [live]
            : await tx
                .select()
                .from(planSubscriptions)
                .where(
                  and(
                    eq(planSubscriptions.tenantId, ctx.tenant.id),
                    or(
                      inArray(planSubscriptions.status, [...LIVE]),
                      gt(planSubscriptions.paidCount, 0),
                    ),
                  ),
                )
                .orderBy(desc(planSubscriptions.createdAt))
                .limit(1);
          const paid = await tx
            .select({
              id: planPayments.id,
              amountMinor: planPayments.amountMinor,
              periodStart: planPayments.periodStart,
              periodEnd: planPayments.periodEnd,
              paidAt: planPayments.paidAt,
              method: planPayments.method,
            })
            .from(planPayments)
            .where(eq(planPayments.tenantId, ctx.tenant.id))
            .orderBy(desc(planPayments.paidAt))
            .limit(24);
          const refunds = await refundsOf(
            tx,
            ctx.tenant.id,
            paid.map((p) => p.id),
          );
          const payments: PlanPaymentRecord[] = paid.map((p) => {
            const own = refunds.filter((r) => r.planPaymentId === p.id);
            const open = own.find((r) => r.status === 'requested' || r.status === 'submitted');
            return {
              ...p,
              refundedMinor: refundedOf(own),
              openRefundMinor: open ? open.amountMinor : null,
            };
          });
          return { offer, subscription: shown ? summary(shown, now) : null, payments };
        },
        { accessMode: 'read only' },
      );
    },

    /** The receipt of one of the company's plan payments (`billing.read`). */
    async receipt(ctx: TenantContext, planPaymentId: string): Promise<PlanPaymentReceipt> {
      assertCan(ctx, 'billing.read');
      if (!UUID_RE.test(planPaymentId)) {
        throw new AppError('not_found', 'There is no such receipt.');
      }
      return db.run(
        ctx.scope,
        async (tx) => {
          const [found] = await tx
            .select({
              id: planPayments.id,
              amountMinor: planPayments.amountMinor,
              periodStart: planPayments.periodStart,
              periodEnd: planPayments.periodEnd,
              paidAt: planPayments.paidAt,
              method: planPayments.method,
              providerPaymentId: planPayments.providerPaymentId,
              providerInvoiceId: planPayments.providerInvoiceId,
              providerSubscriptionId: planSubscriptions.providerSubscriptionId,
              subtotalMinor: planSubscriptions.subtotalMinor,
              taxBp: planSubscriptions.taxBp,
              taxMinor: planSubscriptions.taxMinor,
              subscriptionAmountMinor: planSubscriptions.amountMinor,
              intervalMonths: planSubscriptions.intervalMonths,
              extraSeats: planSubscriptions.extraSeats,
              extraNumbers: planSubscriptions.extraNumbers,
              runPacks: planSubscriptions.runPacks,
              planName: plans.name,
              planCode: plans.code,
              planVersion: plans.version,
            })
            .from(planPayments)
            .innerJoin(
              planSubscriptions,
              and(
                eq(planSubscriptions.tenantId, planPayments.tenantId),
                eq(planSubscriptions.id, planPayments.subscriptionId),
              ),
            )
            .innerJoin(plans, eq(plans.id, planSubscriptions.planId))
            .where(
              and(eq(planPayments.tenantId, ctx.tenant.id), eq(planPayments.id, planPaymentId)),
            );
          if (!found) throw new AppError('not_found', 'There is no such receipt.');
          const [customer] = await tx
            .select({ email: billingCustomers.email })
            .from(billingCustomers)
            .where(eq(billingCustomers.tenantId, ctx.tenant.id));
          const refunds = (await refundsOf(tx, ctx.tenant.id, [found.id])).filter(
            (r) => r.status !== 'failed',
          );
          return {
            id: found.id,
            receiptNumber: found.providerInvoiceId,
            amountMinor: found.amountMinor,
            currency: 'INR' as const,
            breakdown:
              found.amountMinor === found.subscriptionAmountMinor
                ? {
                    subtotalMinor: found.subtotalMinor,
                    taxBp: found.taxBp,
                    taxMinor: found.taxMinor,
                  }
                : null,
            planName: found.planName,
            planCode: found.planCode,
            planVersion: found.planVersion,
            intervalMonths: found.intervalMonths,
            extraSeats: found.extraSeats,
            extraNumbers: found.extraNumbers,
            runPacks: found.runPacks,
            periodStart: found.periodStart,
            periodEnd: found.periodEnd,
            paidAt: found.paidAt,
            method: found.method,
            methodLabel: paymentMethodLabel(found.method),
            providerPaymentId: found.providerPaymentId,
            providerInvoiceId: found.providerInvoiceId,
            providerSubscriptionId: found.providerSubscriptionId,
            companyName: ctx.tenant.name,
            billingEmail: customer?.email ?? null,
            timezone: ctx.tenant.timezone,
            refunds: refunds.map(({ planPaymentId: _payment, ...refund }) => refund),
            refundedMinor: refundedOf(refunds),
          };
        },
        { accessMode: 'read only' },
      );
    },

    /**
     * Starts paying for the plan (`billing.manage`, recent sign-in): records the subscription,
     * then creates its Razorpay plan and subscription; the browser opens Checkout with it. An
     * unpaid subscription whose Checkout is still open is returned again instead; one whose window
     * closed is cancelled at Razorpay and replaced.
     */
    async start(ctx: TenantContext, meta: RequestMeta = {}): Promise<SubscriptionCheckoutStart> {
      assertCan(ctx, 'billing.manage');
      // A subscription lets Razorpay charge the card every period (ADR-056).
      assertRecentSignIn(ctx, clock.now());
      const { razorpay, config } = provider();
      if (!config.subscriptionsEnabled) {
        throw new AppError(
          'unsupported',
          'Paying for plans is not available on this platform yet.',
        );
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const step = await db.run(ctx.scope, async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`w360:plan-subscriptions:${ctx.tenant.id}`}, 0))`,
          );
          const now = clock.now();
          let live = await liveRow(tx, ctx.tenant.id);
          if (live?.status === 'creating') {
            if (now.getTime() - live.createdAt.getTime() < PLAN_SUBSCRIPTION_CREATING_MS) {
              throw new AppError(
                'conflict',
                'A payment is already being started. Try again in a moment.',
              );
            }
            await failCreating(tx, ctx.tenant.id, live.id, 'The payment could not be started.');
            live = undefined;
          }
          if (live?.status === 'created') {
            const planName = await planNameOf(tx, live.planId);
            return now < live.authorizeBy
              ? { kind: 'reopen' as const, row: live, planName }
              : { kind: 'replace' as const, row: live, planName };
          }
          if (live) {
            throw new AppError(
              'conflict',
              'Your company already pays for its plan by subscription.',
            );
          }
          const { offer, planName } = await offerIn(tx, ctx.tenant.id, true, false, now);
          if (!offer.available) {
            throw new AppError('precondition_failed', PLAN_PAYMENT_UNAVAILABLE_TEXT[offer.reason]);
          }
          const [state] = await tx
            .select()
            .from(tenantPlans)
            .where(eq(tenantPlans.tenantId, ctx.tenant.id));
          if (!state?.planId) throw new Error('The company has no plan');
          const id = uuidv7();
          const [row] = await tx
            .insert(planSubscriptions)
            .values({
              id,
              tenantId: ctx.tenant.id,
              planId: state.planId,
              intervalMonths: offer.intervalMonths,
              extraSeats: state.extraSeats,
              extraNumbers: state.extraNumbers,
              runPacks: state.runPacks,
              subtotalMinor: offer.quote.subtotalMinor,
              taxBp: offer.quote.taxBp,
              taxMinor: offer.quote.taxMinor,
              amountMinor: offer.quote.totalMinor,
              totalCount: (PLAN_SUBSCRIPTION_YEARS * 12) / offer.intervalMonths,
              authorizeBy: new Date(now.getTime() + PLAN_SUBSCRIPTION_AUTHORIZE_MS),
              createdByUserId: ctx.user.id,
              // A trial far enough away is paid from its end (ADR-102).
              startsAt: offer.startsAt,
            })
            .returning();
          if (!row) throw new Error('subscription was not recorded');
          await recordAudit(
            tx,
            ctx,
            {
              action: 'billing.plan_subscription_started',
              subjectType: 'plan_subscription',
              subjectId: id,
              metadata: {
                planId: state.planId,
                amountMinor: offer.quote.totalMinor,
                taxBp: offer.quote.taxBp,
                intervalMonths: offer.intervalMonths,
                startsAt: offer.startsAt?.toISOString() ?? null,
              },
            },
            meta,
          );
          return { kind: 'create' as const, row, planName: planName ?? 'your' };
        });
        if (step.kind === 'reopen') return checkoutFor(ctx, config, step.row, step.planName);
        if (step.kind === 'replace') {
          // Its window closed, so it cannot be paid any more: cancelled at Razorpay by the sync.
          try {
            await syncPlanSubscription(providerDeps(razorpay), ctx.scope, step.row.id);
          } catch (error) {
            if (error instanceof TransientProviderError) throw unavailable();
            throw error;
          }
          continue;
        }

        const row = step.row;
        const fail = async (reason: string) => {
          await db.run(ctx.scope, (tx) => failCreating(tx, ctx.tenant.id, row.id, reason));
          throw new AppError(
            'provider_unavailable',
            'We could not start the payment. Try again in a moment.',
          );
        };
        const period = PERIODS[row.intervalMonths as keyof typeof PERIODS];
        if (!period) throw new Error(`unsupported billing interval ${row.intervalMonths}`);
        const notes = { purpose: 'plan_subscription', subscription: row.id };
        const plan = await razorpay.createPlan({
          period,
          amount: row.amountMinor,
          currency: 'INR',
          name: `HyFib ${step.planName} plan`,
          notes,
        });
        if (!plan.ok) return fail(`Razorpay did not create the plan: ${plan.description}`);
        if (plan.data.amount !== row.amountMinor || plan.data.currency !== 'INR') {
          return fail('Razorpay created a plan for another amount.');
        }
        await db.run(ctx.scope, (tx) =>
          tx
            .update(planSubscriptions)
            .set({ providerPlanId: plan.data.id })
            .where(
              and(
                eq(planSubscriptions.tenantId, ctx.tenant.id),
                eq(planSubscriptions.id, row.id),
                eq(planSubscriptions.status, 'creating'),
              ),
            ),
        );
        const sub = await razorpay.createSubscription({
          planId: plan.data.id,
          totalCount: row.totalCount,
          expireBy: Math.floor(row.authorizeBy.getTime() / 1000),
          customerNotify: true,
          ...(row.startsAt ? { startAt: Math.floor(row.startsAt.getTime() / 1000) } : {}),
          notes,
        });
        if (!sub.ok) return fail(`Razorpay did not create the subscription: ${sub.description}`);
        if (sub.data.planId !== plan.data.id) {
          return fail('Razorpay created a subscription for another plan.');
        }
        const [created] = await db.run(ctx.scope, (tx) =>
          tx
            .update(planSubscriptions)
            .set({
              providerSubscriptionId: sub.data.id,
              status: sub.data.status ?? 'created',
              syncedAt: clock.now(),
            })
            .where(
              and(
                eq(planSubscriptions.tenantId, ctx.tenant.id),
                eq(planSubscriptions.id, row.id),
                eq(planSubscriptions.status, 'creating'),
              ),
            )
            .returning(),
        );
        // Null: the sweep failed it meanwhile (the calls took longer than it waits).
        if (!created) return fail('The payment took too long to start.');
        return checkoutFor(ctx, config, created, step.planName);
      }
      throw new AppError('conflict', 'The payment could not be started. Try again.');
    },

    /**
     * Called with Checkout's response. Verifies the signature against OUR subscription id, then
     * syncs the subscription from Razorpay: only a paid cycle Razorpay reports makes the plan
     * active. Anything short of that reports `processing`, and the webhook or the sweep finishes.
     */
    async confirmCheckout(
      ctx: TenantContext,
      input: { subscriptionId: string; paymentId: string; signature: string },
    ): Promise<{ status: 'active' | 'scheduled' | 'processing' | 'failed' }> {
      assertCan(ctx, 'billing.manage');
      const { razorpay, config } = provider();
      const where = and(
        eq(planSubscriptions.tenantId, ctx.tenant.id),
        eq(planSubscriptions.id, input.subscriptionId),
      );
      const [row] = await db.run(
        ctx.scope,
        (tx) => tx.select().from(planSubscriptions).where(where),
        {
          accessMode: 'read only',
        },
      );
      if (!row) throw new AppError('not_found', 'Subscription not found.');
      if (!row.providerSubscriptionId || !PAYMENT_ID_RE.test(input.paymentId)) {
        throw new AppError('validation_failed', 'The payment response is not valid.');
      }
      if (
        !verifySubscriptionCheckoutSignature(
          row.providerSubscriptionId,
          input.paymentId,
          input.signature,
          config.keySecret,
        )
      ) {
        throw new AppError('validation_failed', 'The payment response could not be verified.');
      }
      try {
        await syncPlanSubscription(providerDeps(razorpay), ctx.scope, row.id);
      } catch (error) {
        if (error instanceof TransientProviderError) return { status: 'processing' };
        throw error;
      }
      return db.run(
        ctx.scope,
        async (tx) => {
          const [after] = await tx.select().from(planSubscriptions).where(where);
          const [state] = await tx
            .select({ status: tenantPlans.status, subscriptionId: tenantPlans.subscriptionId })
            .from(tenantPlans)
            .where(eq(tenantPlans.tenantId, ctx.tenant.id));
          if (state?.status === 'active' && state.subscriptionId === row.id) {
            return { status: 'active' as const };
          }
          // Authorised, and first charged when the trial ends (ADR-102).
          if (after?.status === 'authenticated' && after.startsAt) {
            return { status: 'scheduled' as const };
          }
          return after && ENDED.includes(after.status)
            ? { status: 'failed' as const }
            : { status: 'processing' as const };
        },
        { accessMode: 'read only' },
      );
    },

    /**
     * Cancels the company's subscription (`billing.manage`, recent sign-in): an active one at the
     * end of the paid period (the plan then ends, without grace days), any other at once.
     */
    async cancel(
      ctx: TenantContext,
      meta: RequestMeta = {},
    ): Promise<{ atPeriodEnd: boolean; periodEnd: Date | null }> {
      assertCan(ctx, 'billing.manage');
      assertRecentSignIn(ctx, clock.now());
      const { razorpay } = provider();
      let row = await db.run(ctx.scope, (tx) => liveRow(tx, ctx.tenant.id), {
        accessMode: 'read only',
      });
      if (!row) throw new AppError('not_found', 'There is no subscription to cancel.');
      // A first charge due at the trial's end (ADR-102) may have been made without HyFib hearing of
      // it yet: Razorpay is asked first, so a charged subscription is cancelled at the end of the
      // period it paid rather than at once.
      if (
        row.startsAt &&
        row.startsAt <= clock.now() &&
        row.paidCount === 0 &&
        (row.status === 'authenticated' || row.status === 'active' || row.status === 'pending')
      ) {
        await syncPlanSubscription(providerDeps(razorpay), ctx.scope, row.id).catch(
          (error: unknown) => {
            throw error instanceof TransientProviderError ? unavailable() : error;
          },
        );
        row = await db.run(ctx.scope, (tx) => liveRow(tx, ctx.tenant.id), {
          accessMode: 'read only',
        });
        if (!row) throw new AppError('not_found', 'There is no subscription to cancel.');
      }
      if (row.status === 'creating' || !row.providerSubscriptionId) {
        throw new AppError(
          'conflict',
          'The payment is still being started. Try again in a moment.',
        );
      }
      if (row.cancelAtPeriodEnd) return { atPeriodEnd: true, periodEnd: row.currentEnd };
      const atPeriodEnd = row.status === 'active';
      const res = await razorpay.cancelSubscription(row.providerSubscriptionId, {
        cancelAtCycleEnd: atPeriodEnd,
      });
      if (!res.ok) {
        if (res.kind !== 'permanent') throw unavailable();
        // Refused: it may have ended at Razorpay meanwhile.
        await syncPlanSubscription(providerDeps(razorpay), ctx.scope, row.id).catch(
          (error: unknown) => {
            if (!(error instanceof TransientProviderError)) throw error;
          },
        );
        const still = await db.run(ctx.scope, (tx) => liveRow(tx, ctx.tenant.id), {
          accessMode: 'read only',
        });
        if (!still) return { atPeriodEnd: false, periodEnd: row.currentEnd };
        throw new AppError(
          'precondition_failed',
          `Razorpay did not cancel the subscription: ${res.description}`,
        );
      }
      await db.run(ctx.scope, async (tx) => {
        const now = clock.now();
        await tx
          .update(planSubscriptions)
          .set({
            ...(atPeriodEnd ? { cancelAtPeriodEnd: true } : {}),
            cancelRequestedAt: now,
            cancelledByUserId: ctx.user.id,
          })
          .where(
            and(eq(planSubscriptions.tenantId, ctx.tenant.id), eq(planSubscriptions.id, row.id)),
          );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'billing.plan_subscription_cancelled',
            subjectType: 'plan_subscription',
            subjectId: row.id,
            metadata: { atPeriodEnd },
          },
          meta,
        );
        const day = await companyDay(tx, ctx.tenant.id);
        const planName = await planNameOf(tx, row.planId);
        await notifyBillingManagers(deps.notices, tx, ctx.scope, {
          subject: 'Your HyFib plan subscription is cancelled',
          lines: [
            `${ctx.user.name} cancelled the subscription for the ${planName} plan. Nothing more is charged.`,
            atPeriodEnd && row.currentEnd && row.paidCount === 0
              ? `Razorpay’s first charge is under way: if it goes through, the plan stays paid until ${day(row.currentEnd)}, then ends.`
              : atPeriodEnd && row.currentEnd
                ? `The plan ends on ${day(row.currentEnd)}, at the end of the paid period.`
                : row.startsAt && row.paidCount === 0
                  ? row.startsAt > now
                    ? `Nothing was charged for it, and the trial goes on until ${day(row.startsAt)}.`
                    : `Nothing was charged for it, and the trial ended on ${day(row.startsAt)}.`
                  : 'The plan keeps any period already paid, then ends.',
          ],
        });
      });
      if (!atPeriodEnd) {
        // Stores Razorpay's cancelled state now (the sweep would otherwise).
        await syncPlanSubscription(providerDeps(razorpay), ctx.scope, row.id).catch(
          (error: unknown) => {
            if (!(error instanceof TransientProviderError)) throw error;
          },
        );
      }
      return { atPeriodEnd, periodEnd: row.currentEnd };
    },
  };
}

export type PlanSubscriptionService = ReturnType<typeof createPlanSubscriptionService>;
