import { displayMoney, uuidv7 } from '@w360/core';
import {
  and,
  autoRechargeAttempts,
  autoRechargeSettings,
  billingCustomers,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  paymentMandates,
  sql,
  systemScope,
  tenants,
  topups,
  type AttemptStatus,
  type Database,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { failTopup } from './attempts';
import { notifyBillingManagers } from './notices';
import { creditFromPayment, type BillingProviderDeps } from './payments';
import type { RazorpayResult } from './razorpay';

/**
 * Auto-recharge (opt-in, card mandate). One attempt at a time per wallet, decided atomically in
 * app.billing_begin_auto_recharge, then advanced by this state machine:
 *
 *   scheduled ──create order──▶ order_created ──request debit──▶ payment_requested ──▶ succeeded
 *        │                           │                                  │              (credit)
 *        └──────────▶ unknown ◀──────┘                                  └──▶ failed
 *
 * Before every provider call the attempt is moved to `unknown` (write-ahead), so a crash or an
 * unanswered request leaves a state that is reconciled with Razorpay before anything is retried:
 * orders are looked up by our receipt, debit requests by the order's payments. Razorpay has no
 * idempotency key for either call (R-085); an order accepts at most one captured payment (R-002)
 * and a top-up is credited at most once, so reconciliation can never produce a second credit.
 * Card debits complete 36-72 hours after the request (R-042) and are never retried automatically.
 */

export type BeginAutoRechargeOutcome =
  | 'scheduled'
  | 'disabled'
  | 'company_not_active'
  | 'mandate_not_active'
  | 'amount_above_mandate'
  | 'no_wallet'
  | 'above_threshold'
  | 'attempt_in_flight'
  | 'recent_failure'
  | 'daily_cap_reached'
  | 'monthly_cap_reached';

export function autoRechargeReceipt(attemptId: string): string {
  return `ar_${attemptId}`;
}

/** Decides and records at most one attempt (settings row lock + one-active-attempt index). */
export async function beginAutoRecharge(
  db: Database,
  scope: TenantScope,
): Promise<{ outcome: BeginAutoRechargeOutcome; attemptId: string | null }> {
  const attemptId = uuidv7();
  const topupId = uuidv7();
  const outcome = await db.run(scope, async (tx) => {
    const res = await tx.execute<{ result: BeginAutoRechargeOutcome }>(
      sql`select app.billing_begin_auto_recharge(${attemptId}::uuid, ${topupId}::uuid,
                                                 ${autoRechargeReceipt(attemptId)}) as result`,
    );
    const result = res.rows[0]?.result;
    if (!result) throw new Error('auto-recharge decision returned no result');
    return result;
  });
  return { outcome, attemptId: outcome === 'scheduled' ? attemptId : null };
}

export type AttemptAdvanceOutcome =
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'payment_requested'
  | 'waiting'
  | 'unknown'
  | 'retry_later'
  | 'not_due'
  | 'finished';

export interface AttemptAdvanceResult {
  outcome: AttemptAdvanceOutcome;
  /** When the attempt should be looked at again (null when it is resolved). */
  nextCheckAt: Date | null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Wait before reconciling an unanswered order creation (lets a slow request finish). */
const ORDER_RECONCILE_DELAY_MS = 5 * MINUTE;
/** Wait before reconciling an unanswered debit request. */
const PAYMENT_RECONCILE_DELAY_MS = 15 * MINUTE;
/** Retry after a rejection that proves the request was not processed (429, connection refused). */
const NOT_SENT_RETRY_MS = 5 * MINUTE;
/** Our API key was refused: an operator problem, retried slowly without failing the customer. */
const AUTH_RETRY_MS = HOUR;
const FETCH_RETRY_MS = 15 * MINUTE;
const PAYMENT_CHECK_INTERVAL_MS = 6 * HOUR;
/** A requested debit that never shows up as a payment on the order is failed after this long. */
const NO_PAYMENT_TIMEOUT_MS = 24 * HOUR;
/** Consecutive failed attempts after which auto-recharge is turned off. */
export const AUTO_RECHARGE_FAILURES_TO_SUSPEND = 3;

type Attempt = typeof autoRechargeAttempts.$inferSelect;
type Failure = Extract<RazorpayResult<never>, { ok: false }>;
type From = { status: AttemptStatus; unknownStep?: 'create_order' | 'request_payment' | null };

interface AttemptContext {
  attempt: Attempt;
  receipt: string;
  orderId: string | null;
}

/** How an unsuccessful provider call must be treated. */
function classify(result: Failure): 'not_sent' | 'maybe_processed' | 'rejected' | 'auth' {
  if (result.kind === 'auth') return 'auth';
  if (result.kind === 'permanent') return 'rejected';
  // 429 and connection failures before sending prove nothing was processed; 5xx and missing
  // responses do not.
  if (result.kind === 'retryable' && (result.httpStatus === 429 || result.httpStatus === undefined))
    return 'not_sent';
  return 'maybe_processed';
}

function fromCondition(scope: TenantScope, attemptId: string, from: From) {
  return and(
    eq(autoRechargeAttempts.tenantId, scope.tenantId),
    eq(autoRechargeAttempts.id, attemptId),
    eq(autoRechargeAttempts.status, from.status),
    from.unknownStep === undefined
      ? undefined
      : from.unknownStep === null
        ? isNull(autoRechargeAttempts.unknownStep)
        : eq(autoRechargeAttempts.unknownStep, from.unknownStep),
  );
}

async function moveAttempt(
  tx: Tx,
  scope: TenantScope,
  attemptId: string,
  from: From,
  set: Partial<typeof autoRechargeAttempts.$inferInsert>,
  dueBy?: Date,
): Promise<boolean> {
  const rows = await tx
    .update(autoRechargeAttempts)
    .set(set)
    .where(
      and(
        fromCondition(scope, attemptId, from),
        dueBy ? lte(autoRechargeAttempts.nextCheckAt, dueBy) : undefined,
      ),
    )
    .returning({ id: autoRechargeAttempts.id });
  return rows.length === 1;
}

async function loadAttempt(
  db: Database,
  scope: TenantScope,
  attemptId: string,
): Promise<AttemptContext | null> {
  const [row] = await db.run(
    scope,
    (tx) =>
      tx
        .select({
          attempt: autoRechargeAttempts,
          receipt: topups.receipt,
          orderId: topups.providerOrderId,
        })
        .from(autoRechargeAttempts)
        .innerJoin(
          topups,
          and(
            eq(topups.tenantId, autoRechargeAttempts.tenantId),
            eq(topups.id, autoRechargeAttempts.topupId),
          ),
        )
        .where(
          and(
            eq(autoRechargeAttempts.tenantId, scope.tenantId),
            eq(autoRechargeAttempts.id, attemptId),
          ),
        ),
    { accessMode: 'read only' },
  );
  return row ?? null;
}

interface ChargeContext {
  customerId: string;
  tokenId: string;
  email: string;
  contact: string;
}

/**
 * Everything a charge step needs, or the reason the attempt must stop before asking Razorpay for
 * money: auto-recharge turned off or pointed at another mandate, mandate no longer active, company
 * not active.
 */
async function chargeContext(
  db: Database,
  scope: TenantScope,
  attempt: Attempt,
): Promise<{ ok: true; charge: ChargeContext } | { ok: false; reason: string }> {
  const [row] = await db.run(
    scope,
    (tx) =>
      tx
        .select({
          enabled: autoRechargeSettings.enabled,
          settingsMandateId: autoRechargeSettings.mandateId,
          mandateStatus: paymentMandates.status,
          maxAmountMinor: paymentMandates.maxAmountMinor,
          tokenId: paymentMandates.providerTokenId,
          customerId: billingCustomers.providerCustomerId,
          email: billingCustomers.email,
          contact: billingCustomers.contact,
          tenantStatus: tenants.status,
        })
        .from(paymentMandates)
        .innerJoin(
          billingCustomers,
          and(
            eq(billingCustomers.tenantId, paymentMandates.tenantId),
            eq(billingCustomers.id, paymentMandates.billingCustomerId),
          ),
        )
        .innerJoin(tenants, eq(tenants.id, paymentMandates.tenantId))
        .leftJoin(autoRechargeSettings, eq(autoRechargeSettings.tenantId, paymentMandates.tenantId))
        .where(
          and(
            eq(paymentMandates.tenantId, scope.tenantId),
            eq(paymentMandates.id, attempt.mandateId),
          ),
        ),
    { accessMode: 'read only' },
  );
  if (!row) return { ok: false, reason: 'The card mandate no longer exists.' };
  if (row.tenantStatus !== 'active') return { ok: false, reason: 'The company is not active.' };
  if (!row.enabled || row.settingsMandateId !== attempt.mandateId)
    return { ok: false, reason: 'Auto-recharge was turned off.' };
  if (row.mandateStatus !== 'active' || !row.tokenId)
    return { ok: false, reason: 'The card mandate is no longer active.' };
  if (attempt.amountMinor > row.maxAmountMinor)
    return { ok: false, reason: 'The recharge amount is above the card mandate limit.' };
  return {
    ok: true,
    charge: {
      customerId: row.customerId,
      tokenId: row.tokenId,
      email: row.email,
      contact: row.contact,
    },
  };
}

/** Advances one attempt as far as it can go now. Safe to call concurrently and repeatedly. */
export async function advanceAutoRechargeAttempt(
  deps: BillingProviderDeps,
  scope: TenantScope,
  attemptId: string,
): Promise<AttemptAdvanceResult> {
  // A run chains at most a few steps (e.g. scheduled → order_created → payment_requested).
  let last: AttemptAdvanceResult = { outcome: 'finished', nextCheckAt: null };
  for (let step = 0; step < 4; step += 1) {
    const ctx = await loadAttempt(deps.db, scope, attemptId);
    if (!ctx) return { outcome: 'finished', nextCheckAt: null };
    const { attempt } = ctx;
    if (!['scheduled', 'order_created', 'payment_requested', 'unknown'].includes(attempt.status)) {
      return step === 0 ? { outcome: 'finished', nextCheckAt: null } : last;
    }
    const now = deps.clock.now();
    if (attempt.nextCheckAt > now) {
      return step === 0 ? { outcome: 'not_due', nextCheckAt: attempt.nextCheckAt } : last;
    }
    const result = await runStep(deps, scope, ctx, now);
    last = result.result;
    if (!result.proceed) return last;
  }
  return last;
}

type StepResult = { result: AttemptAdvanceResult; proceed: boolean };

const stop = (outcome: AttemptAdvanceOutcome, nextCheckAt: Date | null): StepResult => ({
  result: { outcome, nextCheckAt },
  proceed: false,
});
const proceed = (outcome: AttemptAdvanceOutcome): StepResult => ({
  result: { outcome, nextCheckAt: null },
  proceed: true,
});

async function runStep(
  deps: BillingProviderDeps,
  scope: TenantScope,
  ctx: AttemptContext,
  now: Date,
): Promise<StepResult> {
  const { attempt } = ctx;
  switch (attempt.status) {
    case 'scheduled':
      return createOrderStep(deps, scope, ctx, now);
    case 'order_created':
      return requestPaymentStep(deps, scope, ctx, now);
    case 'payment_requested':
      return checkPaymentStep(deps, scope, ctx, now);
    case 'unknown':
      return attempt.unknownStep === 'create_order'
        ? reconcileOrderStep(deps, scope, ctx, now)
        : reconcilePaymentStep(deps, scope, ctx, now);
    default:
      return stop('finished', null);
  }
}

const at = (now: Date, ms: number) => new Date(now.getTime() + ms);

async function createOrderStep(
  deps: BillingProviderDeps,
  scope: TenantScope,
  ctx: AttemptContext,
  now: Date,
): Promise<StepResult> {
  const { attempt } = ctx;
  const from: From = { status: 'scheduled' };
  const ready = await chargeContext(deps.db, scope, attempt);
  if (!ready.ok) return cancelAttempt(deps, scope, ctx, from, ready.reason);
  // Write-ahead: if we crash or get no answer, the attempt is reconciled by receipt.
  const claimed = await deps.db.run(scope, (tx) =>
    moveAttempt(
      tx,
      scope,
      attempt.id,
      from,
      {
        status: 'unknown',
        unknownStep: 'create_order',
        nextCheckAt: at(now, ORDER_RECONCILE_DELAY_MS),
      },
      now,
    ),
  );
  if (!claimed) return stop('not_due', null);
  const created = await deps.razorpay.createOrder({
    amount: attempt.amountMinor,
    currency: 'INR',
    receipt: ctx.receipt,
    paymentCapture: true,
    notes: { purpose: 'auto_recharge', topup: attempt.topupId },
  });
  const unknownCreate: From = { status: 'unknown', unknownStep: 'create_order' };
  if (created.ok) {
    if (created.data.amount !== attempt.amountMinor || created.data.currency !== 'INR') {
      return failAttempt(
        deps,
        scope,
        ctx,
        unknownCreate,
        'Razorpay returned an order for a different amount.',
      );
    }
    return adoptOrder(deps, scope, ctx, unknownCreate, created.data.id, now);
  }
  switch (classify(created)) {
    case 'not_sent':
      return revert(
        deps,
        scope,
        attempt,
        unknownCreate,
        'scheduled',
        at(now, NOT_SENT_RETRY_MS),
        created,
        'retry_later',
      );
    case 'auth':
      return revert(
        deps,
        scope,
        attempt,
        unknownCreate,
        'scheduled',
        at(now, AUTH_RETRY_MS),
        created,
        'retry_later',
      );
    case 'rejected':
      return failAttempt(
        deps,
        scope,
        ctx,
        unknownCreate,
        `The payment order was refused: ${created.description}`,
      );
    case 'maybe_processed':
      return stop('unknown', at(now, ORDER_RECONCILE_DELAY_MS));
  }
}

async function adoptOrder(
  deps: BillingProviderDeps,
  scope: TenantScope,
  ctx: AttemptContext,
  from: From,
  orderId: string,
  now: Date,
): Promise<StepResult> {
  const moved = await deps.db.run(scope, async (tx) => {
    const ok = await moveAttempt(tx, scope, ctx.attempt.id, from, {
      status: 'order_created',
      unknownStep: null,
      lastError: null,
      nextCheckAt: now,
    });
    if (!ok) return false;
    await tx
      .update(topups)
      .set({ providerOrderId: orderId, status: 'awaiting_payment' })
      .where(
        and(
          eq(topups.tenantId, scope.tenantId),
          eq(topups.id, ctx.attempt.topupId),
          eq(topups.status, 'creating'),
          isNull(topups.providerOrderId),
        ),
      );
    return true;
  });
  return moved ? proceed('waiting') : stop('not_due', null);
}

async function requestPaymentStep(
  deps: BillingProviderDeps,
  scope: TenantScope,
  ctx: AttemptContext,
  now: Date,
): Promise<StepResult> {
  const { attempt } = ctx;
  const from: From = { status: 'order_created' };
  if (!ctx.orderId) {
    return failAttempt(deps, scope, ctx, from, 'The payment order is missing.');
  }
  const ready = await chargeContext(deps.db, scope, attempt);
  if (!ready.ok) return cancelAttempt(deps, scope, ctx, from, ready.reason);
  const claimed = await deps.db.run(scope, (tx) =>
    moveAttempt(
      tx,
      scope,
      attempt.id,
      from,
      {
        status: 'unknown',
        unknownStep: 'request_payment',
        nextCheckAt: at(now, PAYMENT_RECONCILE_DELAY_MS),
      },
      now,
    ),
  );
  if (!claimed) return stop('not_due', null);
  const requested = await deps.razorpay.createRecurringPayment({
    email: ready.charge.email,
    contact: ready.charge.contact,
    amount: attempt.amountMinor,
    currency: 'INR',
    orderId: ctx.orderId,
    customerId: ready.charge.customerId,
    tokenId: ready.charge.tokenId,
    description: 'HyFib W360 service credit (auto-recharge)',
    notes: { purpose: 'auto_recharge', topup: attempt.topupId },
  });
  const unknownRequest: From = { status: 'unknown', unknownStep: 'request_payment' };
  if (requested.ok) {
    const next = at(now, PAYMENT_CHECK_INTERVAL_MS);
    const moved = await deps.db.run(scope, (tx) =>
      moveAttempt(tx, scope, attempt.id, unknownRequest, {
        status: 'payment_requested',
        unknownStep: null,
        lastError: null,
        paymentRequestedAt: now,
        nextCheckAt: next,
      }),
    );
    return stop(moved ? 'payment_requested' : 'not_due', moved ? next : null);
  }
  switch (classify(requested)) {
    case 'not_sent':
      return revert(
        deps,
        scope,
        attempt,
        unknownRequest,
        'order_created',
        at(now, NOT_SENT_RETRY_MS),
        requested,
        'retry_later',
      );
    case 'auth':
      return revert(
        deps,
        scope,
        attempt,
        unknownRequest,
        'order_created',
        at(now, AUTH_RETRY_MS),
        requested,
        'retry_later',
      );
    case 'rejected':
      return failAttempt(
        deps,
        scope,
        ctx,
        unknownRequest,
        `The card debit was refused: ${requested.description}`,
      );
    case 'maybe_processed':
      return stop('unknown', at(now, PAYMENT_RECONCILE_DELAY_MS));
  }
}

async function checkPaymentStep(
  deps: BillingProviderDeps,
  scope: TenantScope,
  ctx: AttemptContext,
  now: Date,
): Promise<StepResult> {
  const { attempt } = ctx;
  const from: From = { status: 'payment_requested' };
  if (!ctx.orderId) return failAttempt(deps, scope, ctx, from, 'The payment order is missing.');
  const payments = await deps.razorpay.fetchOrderPayments(ctx.orderId);
  if (!payments.ok)
    return reschedule(deps, scope, attempt, from, at(now, FETCH_RETRY_MS), payments);
  const captured = payments.data.find((p) => p.status === 'captured' && p.captured);
  if (captured) {
    await creditFromPayment(deps, scope, attempt.topupId, captured);
    return stop('succeeded', null);
  }
  if (payments.data.some((p) => p.status === 'created' || p.status === 'authorized')) {
    // The bank is still processing the debit (36-72 h, R-042).
    return reschedule(deps, scope, attempt, from, at(now, PAYMENT_CHECK_INTERVAL_MS), null);
  }
  const failed = payments.data.filter((p) => p.status === 'failed');
  if (failed.length > 0 && failed.length === payments.data.length) {
    const reason = failed[failed.length - 1]?.errorDescription ?? 'The card debit failed.';
    return failAttempt(deps, scope, ctx, from, `The card debit failed: ${reason}`);
  }
  const requestedAt = attempt.paymentRequestedAt ?? attempt.updatedAt;
  if (payments.data.length === 0 && now.getTime() - requestedAt.getTime() > NO_PAYMENT_TIMEOUT_MS) {
    return failAttempt(deps, scope, ctx, from, 'Razorpay never created the requested card debit.');
  }
  return reschedule(deps, scope, attempt, from, at(now, HOUR), null);
}

async function reconcileOrderStep(
  deps: BillingProviderDeps,
  scope: TenantScope,
  ctx: AttemptContext,
  now: Date,
): Promise<StepResult> {
  const { attempt } = ctx;
  const from: From = { status: 'unknown', unknownStep: 'create_order' };
  if (ctx.orderId) return adoptOrder(deps, scope, ctx, from, ctx.orderId, now);
  const found = await deps.razorpay.findOrdersByReceipt(ctx.receipt);
  if (!found.ok) return reschedule(deps, scope, attempt, from, at(now, FETCH_RETRY_MS), found);
  const order = found.data.find(
    (o) => o.receipt === ctx.receipt && o.amount === attempt.amountMinor && o.currency === 'INR',
  );
  if (order) return adoptOrder(deps, scope, ctx, from, order.id, now);
  // No order exists for our receipt, so creating one now cannot duplicate it.
  const moved = await deps.db.run(scope, (tx) =>
    moveAttempt(tx, scope, attempt.id, from, {
      status: 'scheduled',
      unknownStep: null,
      nextCheckAt: now,
    }),
  );
  return moved ? proceed('retry_later') : stop('not_due', null);
}

async function reconcilePaymentStep(
  deps: BillingProviderDeps,
  scope: TenantScope,
  ctx: AttemptContext,
  now: Date,
): Promise<StepResult> {
  const { attempt } = ctx;
  const from: From = { status: 'unknown', unknownStep: 'request_payment' };
  if (!ctx.orderId) return failAttempt(deps, scope, ctx, from, 'The payment order is missing.');
  const payments = await deps.razorpay.fetchOrderPayments(ctx.orderId);
  if (!payments.ok)
    return reschedule(deps, scope, attempt, from, at(now, FETCH_RETRY_MS), payments);
  if (payments.data.length > 0) {
    // The debit request reached Razorpay; follow that payment instead of asking again.
    const moved = await deps.db.run(scope, (tx) =>
      moveAttempt(tx, scope, attempt.id, from, {
        status: 'payment_requested',
        unknownStep: null,
        paymentRequestedAt: attempt.paymentRequestedAt ?? now,
        nextCheckAt: now,
      }),
    );
    return moved ? proceed('payment_requested') : stop('not_due', null);
  }
  // Nothing was created on the order: asking again cannot create a second debit, and the order
  // itself accepts only one captured payment.
  const moved = await deps.db.run(scope, (tx) =>
    moveAttempt(tx, scope, attempt.id, from, {
      status: 'order_created',
      unknownStep: null,
      nextCheckAt: now,
    }),
  );
  return moved ? proceed('retry_later') : stop('not_due', null);
}

async function revert(
  deps: BillingProviderDeps,
  scope: TenantScope,
  attempt: Attempt,
  from: From,
  status: 'scheduled' | 'order_created',
  nextCheckAt: Date,
  failure: Failure,
  outcome: AttemptAdvanceOutcome,
): Promise<StepResult> {
  await deps.db.run(scope, (tx) =>
    moveAttempt(tx, scope, attempt.id, from, {
      status,
      unknownStep: null,
      lastError: `${failure.kind}: ${failure.description}`.slice(0, 500),
      nextCheckAt,
    }),
  );
  return stop(outcome, nextCheckAt);
}

async function reschedule(
  deps: BillingProviderDeps,
  scope: TenantScope,
  attempt: Attempt,
  from: From,
  nextCheckAt: Date,
  failure: Failure | null,
): Promise<StepResult> {
  await deps.db.run(scope, (tx) =>
    moveAttempt(tx, scope, attempt.id, from, {
      nextCheckAt,
      ...(failure ? { lastError: `${failure.kind}: ${failure.description}`.slice(0, 500) } : {}),
    }),
  );
  return stop(from.status === 'unknown' ? 'unknown' : 'waiting', nextCheckAt);
}

async function cancelAttempt(
  deps: BillingProviderDeps,
  scope: TenantScope,
  ctx: AttemptContext,
  from: From,
  reason: string,
): Promise<StepResult> {
  const canceled = await deps.db.run(scope, async (tx) => {
    const ok = await moveAttempt(tx, scope, ctx.attempt.id, from, {
      status: 'canceled',
      unknownStep: null,
      lastError: reason.slice(0, 500),
      resolvedAt: deps.clock.now(),
    });
    if (!ok) return false;
    await failTopup(tx, scope, ctx.attempt.topupId, reason);
    await recordSystemAudit(tx, scope.tenantId, {
      action: 'billing.auto_recharge_canceled',
      subjectType: 'auto_recharge_attempt',
      subjectId: ctx.attempt.id,
      metadata: { reason },
    });
    return true;
  });
  return stop(canceled ? 'canceled' : 'not_due', null);
}

async function failAttempt(
  deps: BillingProviderDeps,
  scope: TenantScope,
  ctx: AttemptContext,
  from: From,
  reason: string,
): Promise<StepResult> {
  const { attempt } = ctx;
  const failed = await deps.db.run(scope, async (tx) => {
    const ok = await moveAttempt(tx, scope, attempt.id, from, {
      status: 'failed',
      unknownStep: null,
      lastError: reason.slice(0, 500),
      resolvedAt: deps.clock.now(),
    });
    if (!ok) return false;
    await failTopup(tx, scope, attempt.topupId, reason);
    await recordSystemAudit(tx, scope.tenantId, {
      action: 'billing.auto_recharge_failed',
      subjectType: 'auto_recharge_attempt',
      subjectId: attempt.id,
      result: 'failure',
      metadata: { amountMinor: attempt.amountMinor },
    });
    const suspended = await suspendAfterRepeatedFailures(tx, scope, attempt.walletId);
    await notifyBillingManagers(deps.notices, tx, scope, {
      subject: suspended
        ? 'Auto-recharge turned off after failed charges'
        : 'Auto-recharge charge failed',
      lines: [
        `We could not add ${displayMoney(BigInt(attempt.amountMinor), 'INR')} to your service credit. ${reason}`,
        suspended
          ? `Auto-recharge failed ${AUTO_RECHARGE_FAILURES_TO_SUSPEND} times in a row, so it has been turned off. Check your card and turn it on again, or add credit manually.`
          : 'We will try again after 24 hours if your balance is still below your threshold. You can also add credit manually.',
      ],
    });
    return true;
  });
  return stop(failed ? 'failed' : 'not_due', null);
}

async function suspendAfterRepeatedFailures(
  tx: Tx,
  scope: TenantScope,
  walletId: string,
): Promise<boolean> {
  const recent = await tx
    .select({ status: autoRechargeAttempts.status })
    .from(autoRechargeAttempts)
    .where(
      and(
        eq(autoRechargeAttempts.tenantId, scope.tenantId),
        eq(autoRechargeAttempts.walletId, walletId),
      ),
    )
    .orderBy(desc(autoRechargeAttempts.createdAt), desc(autoRechargeAttempts.id))
    .limit(AUTO_RECHARGE_FAILURES_TO_SUSPEND);
  if (
    recent.length < AUTO_RECHARGE_FAILURES_TO_SUSPEND ||
    recent.some((r) => r.status !== 'failed')
  ) {
    return false;
  }
  const updated = await tx
    .update(autoRechargeSettings)
    .set({ enabled: false })
    .where(
      and(
        eq(autoRechargeSettings.tenantId, scope.tenantId),
        eq(autoRechargeSettings.enabled, true),
      ),
    )
    .returning({ tenantId: autoRechargeSettings.tenantId });
  if (updated.length === 0) return false;
  await recordSystemAudit(tx, scope.tenantId, {
    action: 'billing.auto_recharge_suspended',
    subjectType: 'auto_recharge_settings',
    subjectId: scope.tenantId,
    metadata: { consecutiveFailures: AUTO_RECHARGE_FAILURES_TO_SUSPEND },
  });
  return true;
}

/** Attempts and open manual top-ups due for a provider check, across companies (ids only). */
export async function findBillingReconciliationDue(
  db: Database,
  limit = 200,
): Promise<{ tenantId: string; kind: 'topup' | 'attempt'; id: string }[]> {
  return db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{ tenant_id: string; kind: 'topup' | 'attempt'; id: string }>(
        sql`select tenant_id, kind, id from ops.billing_reconciliation_due(${limit})`,
      );
      return res.rows.map((r) => ({ tenantId: r.tenant_id, kind: r.kind, id: r.id }));
    },
    { accessMode: 'read only' },
  );
}

/** Companies whose auto-recharge may be due (enabled, below threshold, nothing in flight). */
export async function findAutoRechargeCandidates(db: Database, limit = 200): Promise<string[]> {
  return db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{ tenant_id: string }>(
        sql`select tenant_id from ops.billing_auto_recharge_candidates(${limit})`,
      );
      return res.rows.map((r) => r.tenant_id);
    },
    { accessMode: 'read only' },
  );
}

/**
 * Pushes an in-flight attempt's next check out after an unexpected error, so a persistent fault
 * (reported in logs and the attempt's last error) is retried hourly instead of every sweep.
 */
export async function deferAutoRechargeAttempt(
  db: Database,
  scope: TenantScope,
  attemptId: string,
  until: Date,
  error: string,
): Promise<void> {
  await db.run(scope, (tx) =>
    tx
      .update(autoRechargeAttempts)
      .set({ nextCheckAt: until, lastError: error.slice(0, 500) })
      .where(
        and(
          eq(autoRechargeAttempts.tenantId, scope.tenantId),
          eq(autoRechargeAttempts.id, attemptId),
          inArray(autoRechargeAttempts.status, [
            'scheduled',
            'order_created',
            'payment_requested',
            'unknown',
          ]),
        ),
      ),
  );
}
