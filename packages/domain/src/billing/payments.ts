import { displayMoney, uuidv7, type Clock, type Keyring } from '@w360/core';
import {
  and,
  autoRechargeAttempts,
  autoRechargeSettings,
  authorizedTenantScope,
  creditRefunds,
  eq,
  inArray,
  isNull,
  lt,
  or,
  paymentMandates,
  planPaymentRefunds,
  sql,
  type MandateStatus,
  systemScope,
  topups,
  webhookQuarantine,
  webhookReceipts,
  type Database,
  type TenantScope,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { receiptAad } from '../messaging/receipts';
import { cancelPendingAutoRecharge, failTopup } from './attempts';
import { failCreditRefund } from './credit-refunds';
import { notifyBillingManagers } from './notices';
import {
  failPlanPaymentRefund,
  PLAN_REFUND_NOTE,
  recordPlanPaymentRefund,
} from './plan-payment-refunds';
import {
  findPlanPayment,
  resolvePlanSubscription,
  syncPlanSubscription,
  syncPlanSubscriptionForPayment,
} from './plan-subscriptions';
import { transient, type BillingProviderDeps } from './provider';
import type { RazorpayPayment, RazorpayRefund, RazorpayToken } from './razorpay';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export { TransientProviderError, type BillingProviderDeps } from './provider';

/*
 * Applying provider facts to the ledger. Every credit is based on an authoritative fetch from
 * Razorpay (never on a webhook body, a browser redirect or a checkout signature alone), requires
 * `captured`, and goes through app.billing_credit_topup, which credits a top-up exactly once.
 * Companies are resolved from our own provider-id mappings, never from ids inside payloads.
 */

export async function resolveProviderOrder(
  db: Database,
  orderId: string,
): Promise<{ tenantId: string; subject: 'topup' | 'mandate'; subjectId: string } | null> {
  return db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{
        tenant_id: string;
        subject: 'topup' | 'mandate';
        subject_id: string;
      }>(sql`select tenant_id, subject, subject_id from ops.billing_resolve_order(${orderId})`);
      const row = res.rows[0];
      return row
        ? { tenantId: row.tenant_id, subject: row.subject, subjectId: row.subject_id }
        : null;
    },
    { accessMode: 'read only' },
  );
}

export type CreditOutcome = 'credited' | 'already_credited' | 'not_captured';

/** Razorpay payment methods are lower-case words (card, upi, netbanking, ...); 0029 checks the same. */
const PAYMENT_METHOD_RE = /^[a-z_]{1,32}$/;

/**
 * Credits a top-up from a payment fetched from Razorpay. The first credit is audited and emailed to
 * the billing managers with a link to its receipt, in the same transaction as the ledger posting.
 * The payment method Razorpay reported is recorded for the receipt (also for a top-up credited
 * earlier, when the same payment is seen again); an unexpected method is left out, never failing
 * the credit.
 */
export async function creditFromPayment(
  deps: Pick<BillingProviderDeps, 'db' | 'notices'>,
  scope: TenantScope,
  topupId: string,
  payment: RazorpayPayment,
): Promise<CreditOutcome> {
  if (payment.status !== 'captured' || !payment.captured || !payment.orderId) return 'not_captured';
  return deps.db.run(scope, async (tx) => {
    const res = await tx.execute<{ result: 'credited' | 'already_credited' }>(
      sql`select app.billing_credit_topup(${topupId}::uuid, ${payment.orderId}, ${payment.id},
                                          ${payment.amount}::bigint, ${payment.currency}, 'razorpay') as result`,
    );
    const result = res.rows[0]?.result;
    if (!result) throw new Error('credit returned no result');
    if (payment.method && PAYMENT_METHOD_RE.test(payment.method)) {
      await tx.execute(
        sql`select app.billing_record_payment_method(${topupId}::uuid, ${payment.id}, ${payment.method})`,
      );
    }
    if (result === 'credited') {
      const [topup] = await tx
        .select({ kind: topups.kind, amountMinor: topups.amountMinor, receipt: topups.receipt })
        .from(topups)
        .where(and(eq(topups.tenantId, scope.tenantId), eq(topups.id, topupId)));
      await recordSystemAudit(
        tx,
        scope.tenantId,
        {
          action: 'billing.topup_credited',
          subjectType: 'topup',
          subjectId: topupId,
          metadata: {
            amountMinor: payment.amount,
            kind: topup?.kind ?? null,
            paymentId: payment.id,
          },
        },
        { type: 'provider', id: 'razorpay' },
      );
      if (topup) {
        const amount = displayMoney(BigInt(topup.amountMinor), 'INR');
        await notifyBillingManagers(
          deps.notices,
          tx,
          scope,
          topup.kind === 'auto_recharge'
            ? {
                subject: 'Auto-recharge added service credit',
                lines: [
                  `Your card was charged ${amount} through your auto-recharge mandate, and the amount was added to your service credit.`,
                  `The receipt (${topup.receipt}) is in billing; it is a payment confirmation, not a tax invoice.`,
                  'You can change or turn off auto-recharge in billing settings.',
                ],
                billingPath: `receipts/${topupId}`,
              }
            : {
                subject: 'Payment received: service credit added',
                lines: [
                  `We received your payment of ${amount}, and the amount was added to your service credit.`,
                  `The receipt (${topup.receipt}) is in billing; it is a payment confirmation, not a tax invoice.`,
                ],
                billingPath: `receipts/${topupId}`,
              },
        );
      }
    }
    return result;
  });
}

async function markTopupFailed(db: Database, scope: TenantScope, topupId: string, reason: string) {
  await db.run(scope, async (tx) => {
    await tx
      .update(topups)
      .set({ status: 'failed', failureReason: reason.slice(0, 500) })
      .where(
        and(
          eq(topups.tenantId, scope.tenantId),
          eq(topups.id, topupId),
          inArray(topups.status, ['creating', 'awaiting_payment']),
        ),
      );
  });
}

export type PaymentApplication =
  | { outcome: CreditOutcome | 'failed_recorded' | 'pending' | 'mandate_updated' }
  | { outcome: 'subscription_synced'; tenantId: string }
  | { outcome: 'unknown_order'; orderId: string | null };

/**
 * Fetches a payment authoritatively and applies it to whatever our records say it belongs to. A
 * payment on no order of ours may be a charge of one of our plan subscriptions (its invoice names
 * the subscription), which is then synced from Razorpay (ADR-063).
 */
export async function applyPaymentById(
  deps: BillingProviderDeps,
  paymentId: string,
): Promise<PaymentApplication> {
  const fetched = await deps.razorpay.fetchPayment(paymentId);
  if (!fetched.ok) {
    if (fetched.kind === 'permanent') return { outcome: 'unknown_order', orderId: null };
    throw transient(fetched, 'payment fetch');
  }
  const payment = fetched.data;
  const binding = payment.orderId ? await resolveProviderOrder(deps.db, payment.orderId) : null;
  if (!binding) {
    const subscription = await syncPlanSubscriptionForPayment(deps, payment);
    if (subscription) return { outcome: 'subscription_synced', tenantId: subscription.tenantId };
    return { outcome: 'unknown_order', orderId: payment.orderId };
  }
  const scope = authorizedTenantScope(binding.tenantId, null);
  if (binding.subject === 'mandate') {
    await applyMandateAuthorization(deps, scope, binding.subjectId, payment);
    return { outcome: 'mandate_updated' };
  }
  if (payment.status === 'captured') {
    return { outcome: await creditFromPayment(deps, scope, binding.subjectId, payment) };
  }
  if (payment.status === 'failed') {
    // A later capture of another (or late-authorised) payment still credits the top-up. An
    // auto-recharge charge is failed by its attempt (audit, notice, cooldown), which is nudged to
    // check the order now instead of at its next scheduled check.
    const reason = payment.errorDescription ?? 'Payment failed';
    await deps.db.run(scope, async (tx) => {
      const nudged = await tx
        .update(autoRechargeAttempts)
        .set({ nextCheckAt: deps.clock.now() })
        .where(
          and(
            eq(autoRechargeAttempts.tenantId, scope.tenantId),
            eq(autoRechargeAttempts.topupId, binding.subjectId),
            eq(autoRechargeAttempts.status, 'payment_requested'),
          ),
        )
        .returning({ id: autoRechargeAttempts.id });
      const [topup] = await tx
        .select({ kind: topups.kind })
        .from(topups)
        .where(and(eq(topups.tenantId, scope.tenantId), eq(topups.id, binding.subjectId)));
      if (nudged.length === 0 && topup?.kind === 'manual') {
        await failTopup(tx, scope, binding.subjectId, reason);
      }
    });
    return { outcome: 'failed_recorded' };
  }
  return { outcome: 'pending' };
}

export type MandateAuthorizationOutcome = 'active' | 'not_active' | 'no_token' | 'not_this_mandate';

/**
 * The mandate's authorisation payment carries the token; activation follows the token status
 * (R-036). Once the mandate is active, the authorisation charge is refunded so it never becomes a
 * charge without service (R-035, R-075). The refund uses an idempotency key, so repeats are safe.
 */
export async function applyMandateAuthorization(
  deps: BillingProviderDeps,
  scope: TenantScope,
  mandateId: string,
  payment: RazorpayPayment,
): Promise<MandateAuthorizationOutcome> {
  const [mandate] = await deps.db.run(
    scope,
    (tx) =>
      tx
        .select({
          orderId: paymentMandates.authorizationOrderId,
          refundId: paymentMandates.authorizationRefundId,
        })
        .from(paymentMandates)
        .where(
          and(eq(paymentMandates.tenantId, scope.tenantId), eq(paymentMandates.id, mandateId)),
        ),
    { accessMode: 'read only' },
  );
  if (!mandate || !payment.orderId || mandate.orderId !== payment.orderId)
    return 'not_this_mandate';
  if (!payment.tokenId || !payment.customerId) return 'no_token';
  const token = await deps.razorpay.fetchToken(payment.customerId, payment.tokenId);
  if (!token.ok) {
    if (token.kind === 'permanent') return 'no_token';
    throw transient(token, 'token fetch');
  }
  const status = await updateMandateFromToken(deps.db, scope, mandateId, token.data, deps.clock);
  if (status === 'cancelled' && token.data.recurringStatus === 'confirmed') {
    await retireToken(deps, payment.customerId, token.data.id);
  }
  if (status !== 'active') return 'not_active';
  if (payment.status === 'captured' && !mandate.refundId) {
    await deps.db.run(scope, (tx) =>
      tx
        .update(paymentMandates)
        .set({ authorizationPaymentId: payment.id })
        .where(
          and(eq(paymentMandates.tenantId, scope.tenantId), eq(paymentMandates.id, mandateId)),
        ),
    );
    const refund = await deps.razorpay.createRefund(payment.id, {
      amount: payment.amount,
      idempotencyKey: `mauth_${mandateId}`,
      notes: { purpose: 'mandate_authorization' },
    });
    if (refund.ok) {
      await deps.db.run(scope, (tx) =>
        tx
          .update(paymentMandates)
          .set({ authorizationRefundId: refund.data.id })
          .where(
            and(eq(paymentMandates.tenantId, scope.tenantId), eq(paymentMandates.id, mandateId)),
          ),
      );
    } else if (refund.kind !== 'permanent') {
      // Retried by the caller (job retry); the idempotency key makes the retry safe (R-086).
      throw transient(refund, 'authorisation refund');
    }
    // A permanent refusal means the charge was already refunded (for example automatically).
  }
  return 'active';
}

const TOKEN_STATUS_TO_MANDATE: Record<string, MandateStatus> = {
  confirmed: 'active',
  rejected: 'rejected',
  cancelled: 'cancelled',
  paused: 'paused',
  initiated: 'pending_authorization',
};

/** Applies a fetched token to its mandate and returns the mandate's resulting status. */
export async function updateMandateFromToken(
  db: Database,
  scope: TenantScope,
  mandateId: string,
  token: RazorpayToken,
  clock: Clock,
): Promise<MandateStatus | null> {
  const status = TOKEN_STATUS_TO_MANDATE[token.recurringStatus ?? ''] ?? 'pending_authorization';
  return db.run(scope, async (tx) => {
    const [current] = await tx
      .select({ status: paymentMandates.status, tokenId: paymentMandates.providerTokenId })
      .from(paymentMandates)
      .where(and(eq(paymentMandates.tenantId, scope.tenantId), eq(paymentMandates.id, mandateId)))
      .for('update');
    if (!current) return null;
    if (current.tokenId && current.tokenId !== token.id) return current.status;
    // A mandate the company cancelled stays cancelled even if a late event says otherwise, and a
    // confirmed mandate never moves back to pending.
    if (current.status === 'cancelled' || current.status === 'rejected') return current.status;
    if (current.status === 'active' && status === 'pending_authorization') return current.status;
    const ended = status === 'rejected' || status === 'cancelled';
    await tx
      .update(paymentMandates)
      .set({
        providerTokenId: token.id,
        status,
        ...(token.card
          ? {
              cardNetwork: token.card.network,
              cardIssuer: token.card.issuer,
              cardLast4:
                token.card.last4 && /^[0-9]{4}$/.test(token.card.last4) ? token.card.last4 : null,
              cardExpiryMonth: token.card.expiryMonth,
              cardExpiryYear: token.card.expiryYear,
            }
          : {}),
        ...(status === 'active' && current.status !== 'active' ? { confirmedAt: clock.now() } : {}),
        ...(ended ? { endedAt: clock.now() } : {}),
      })
      .where(and(eq(paymentMandates.tenantId, scope.tenantId), eq(paymentMandates.id, mandateId)));
    if (status !== 'active') {
      // A mandate that stops being usable disables auto-recharge and stops attempts that have not
      // yet asked the bank for money.
      await tx
        .update(autoRechargeSettings)
        .set({ enabled: false })
        .where(
          and(
            eq(autoRechargeSettings.tenantId, scope.tenantId),
            eq(autoRechargeSettings.mandateId, mandateId),
          ),
        );
      await cancelPendingAutoRecharge(tx, scope, `The card mandate is ${status}.`, clock.now());
    }
    if (current.status !== status) {
      await recordSystemAudit(
        tx,
        scope.tenantId,
        {
          action: 'billing.mandate_status_changed',
          subjectType: 'payment_mandate',
          subjectId: mandateId,
          metadata: { from: current.status, to: status },
        },
        { type: 'provider', id: 'razorpay' },
      );
    }
    return status;
  });
}

async function applyTokenEvent(deps: BillingProviderDeps, tokenId: string, customerId: string) {
  const binding = await deps.db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{ tenant_id: string; mandate_id: string }>(
        sql`select tenant_id, mandate_id from ops.billing_resolve_token(${tokenId})`,
      );
      return res.rows[0] ?? null;
    },
    { accessMode: 'read only' },
  );
  if (!binding) return 'unknown_token' as const;
  const token = await deps.razorpay.fetchToken(customerId, tokenId);
  if (!token.ok) {
    if (token.kind === 'permanent') return 'unknown_token' as const;
    throw transient(token, 'token fetch');
  }
  const status = await updateMandateFromToken(
    deps.db,
    authorizedTenantScope(binding.tenant_id, null),
    binding.mandate_id,
    token.data,
    deps.clock,
  );
  if (status === 'cancelled' && token.data.recurringStatus === 'confirmed') {
    await retireToken(deps, customerId, token.data.id);
  }
  return 'mandate_updated' as const;
}

/**
 * A mandate the company already removed (or abandoned) must not stay registered with the bank:
 * delete its token at Razorpay (R-037, R-053). A permanent refusal means it is already gone.
 */
async function retireToken(deps: BillingProviderDeps, customerId: string, tokenId: string) {
  const deleted = await deps.razorpay.deleteToken(customerId, tokenId);
  if (!deleted.ok && deleted.kind !== 'permanent') throw transient(deleted, 'token deletion');
}

/**
 * Records a refund Razorpay processed, fetched first (never from a payload): the refund of a payment
 * that credited a top-up goes through app.billing_record_refund, once per refund id, and the refund
 * of a plan payment through app.record_plan_payment_refund (ADR-103). Used for `refund.processed`
 * and by the settlement reconciliation (ADR-059).
 */
export async function applyRefundById(
  deps: BillingProviderDeps,
  paymentId: string,
  refundId: string,
) {
  const refund = await deps.razorpay.fetchRefund(paymentId, refundId);
  if (!refund.ok) {
    if (refund.kind === 'permanent') return 'unknown_refund' as const;
    throw transient(refund, 'refund fetch');
  }
  if (refund.data.status !== 'processed') return 'refund_pending' as const;
  const payment = await deps.razorpay.fetchPayment(paymentId);
  if (!payment.ok) {
    if (payment.kind === 'permanent') return 'unknown_refund' as const;
    throw transient(payment, 'payment fetch');
  }
  const binding = payment.data.orderId
    ? await resolveProviderOrder(deps.db, payment.data.orderId)
    : null;
  if (!binding) {
    // A subscription's charge is on an order Razorpay made for its invoice, not one of HyFib's: the
    // plan payment HyFib recorded for the payment, if any, names the company.
    const plan = await findPlanPayment(deps.db, payment.data.id);
    if (!plan) return 'unknown_refund' as const;
    const scope = authorizedTenantScope(plan.tenantId, null);
    return deps.db.run(scope, (tx) =>
      recordPlanPaymentRefund(tx, scope, { ...refund.data, paymentId: payment.data.id }),
    );
  }
  if (binding.subject === 'mandate') return 'mandate_authorization_refund' as const;
  return deps.db.run(authorizedTenantScope(binding.tenantId, null), async (tx) => {
    const res = await tx.execute<{ result: string }>(
      sql`select app.billing_record_refund(${binding.subjectId}::uuid, ${refund.data.id}, ${refund.data.amount}::bigint) as result`,
    );
    return (res.rows[0]?.result ?? 'recorded') as 'recorded' | 'already_recorded';
  });
}

/**
 * A refund Razorpay failed (R-023): when it is a refund a platform owner asked for (ADR-058), the
 * request fails and its hold is released so the credit is available again. The refund is fetched
 * first; a failed refund nobody asked for through HyFib (a Dashboard refund) changes nothing.
 */
async function applyRefundFailure(deps: BillingProviderDeps, paymentId: string, refundId: string) {
  const refund = await deps.razorpay.fetchRefund(paymentId, refundId);
  if (!refund.ok) {
    if (refund.kind === 'permanent') return 'unknown_refund' as const;
    throw transient(refund, 'refund fetch');
  }
  if (refund.data.status !== 'failed') return 'refund_not_failed' as const;
  const payment = await deps.razorpay.fetchPayment(paymentId);
  if (!payment.ok) {
    if (payment.kind === 'permanent') return 'unknown_refund' as const;
    throw transient(payment, 'payment fetch');
  }
  const binding = payment.data.orderId
    ? await resolveProviderOrder(deps.db, payment.data.orderId)
    : null;
  if (!binding) return applyPlanRefundFailure(deps, payment.data.id, refund.data);
  if (binding.subject !== 'topup') return 'unknown_refund' as const;
  const scope = authorizedTenantScope(binding.tenantId, null);
  const [request] = await deps.db.run(
    scope,
    (tx) =>
      tx
        .select({ id: creditRefunds.id })
        .from(creditRefunds)
        .where(
          and(
            eq(creditRefunds.tenantId, binding.tenantId),
            eq(creditRefunds.providerRefundId, refundId),
          ),
        ),
    { accessMode: 'read only' },
  );
  if (!request) return 'refund_failed_not_requested' as const;
  const outcome = await failCreditRefund(
    deps,
    scope,
    request.id,
    'failed: Razorpay failed the refund',
  );
  return outcome === 'failed' ? ('credit_refund_failed' as const) : ('already_settled' as const);
}

/**
 * A failed refund of a plan payment (ADR-103): the staff request it belongs to (by refund id, or by
 * the request its notes name) fails and the billing managers are emailed. A failed refund nobody
 * asked for through HyFib changes nothing.
 */
async function applyPlanRefundFailure(
  deps: BillingProviderDeps,
  paymentId: string,
  refund: RazorpayRefund,
) {
  const plan = await findPlanPayment(deps.db, paymentId);
  if (!plan) return 'unknown_refund' as const;
  const scope = authorizedTenantScope(plan.tenantId, null);
  const note = refund.notes[PLAN_REFUND_NOTE];
  const [request] = await deps.db.run(
    scope,
    (tx) =>
      tx
        .select({ id: planPaymentRefunds.id })
        .from(planPaymentRefunds)
        .where(
          and(
            eq(planPaymentRefunds.tenantId, plan.tenantId),
            eq(planPaymentRefunds.planPaymentId, plan.planPaymentId),
            eq(planPaymentRefunds.origin, 'staff'),
            note && UUID_RE.test(note)
              ? or(
                  eq(planPaymentRefunds.providerRefundId, refund.id),
                  and(eq(planPaymentRefunds.id, note), isNull(planPaymentRefunds.providerRefundId)),
                )
              : eq(planPaymentRefunds.providerRefundId, refund.id),
          ),
        ),
    { accessMode: 'read only' },
  );
  if (!request) return 'refund_failed_not_requested' as const;
  const outcome = await failPlanPaymentRefund(
    deps,
    scope,
    request.id,
    'failed: Razorpay failed the refund',
  );
  return outcome === 'failed' ? ('plan_refund_failed' as const) : ('already_settled' as const);
}

async function applyDispute(deps: BillingProviderDeps, disputeId: string) {
  const dispute = await deps.razorpay.fetchDispute(disputeId);
  if (!dispute.ok) {
    if (dispute.kind === 'permanent') return 'unknown_dispute' as const;
    throw transient(dispute, 'dispute fetch');
  }
  if (dispute.data.status !== 'lost') return 'dispute_open' as const;
  const payment = await deps.razorpay.fetchPayment(dispute.data.paymentId);
  if (!payment.ok) {
    if (payment.kind === 'permanent') return 'unknown_dispute' as const;
    throw transient(payment, 'payment fetch');
  }
  if (!payment.data.orderId) return 'unknown_dispute' as const;
  const binding = await resolveProviderOrder(deps.db, payment.data.orderId);
  if (!binding || binding.subject !== 'topup') return 'unknown_dispute' as const;
  const amount =
    dispute.data.amountDeducted > 0 ? dispute.data.amountDeducted : dispute.data.amount;
  return deps.db.run(authorizedTenantScope(binding.tenantId, null), async (tx) => {
    const res = await tx.execute<{ result: string }>(
      sql`select app.billing_record_dispute_loss(${binding.subjectId}::uuid, ${dispute.data.id}, ${amount}::bigint) as result`,
    );
    return (res.rows[0]?.result ?? 'recorded') as 'recorded' | 'already_recorded';
  });
}

const LEASE_MS = 2 * 60_000;

function entityId(payload: unknown, key: string): string | null {
  const entity = (payload as Record<string, { entity?: Record<string, unknown> }> | null)?.[key]
    ?.entity;
  const id = entity?.id;
  return typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : null;
}

function entityField(payload: unknown, key: string, field: string): string | null {
  const entity = (payload as Record<string, { entity?: Record<string, unknown> }> | null)?.[key]
    ?.entity;
  const value = entity?.[field];
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null;
}

export type RazorpayReceiptOutcome = 'processed' | 'ignored' | 'quarantined' | 'not_claimable';

/**
 * Processes one stored Razorpay webhook receipt. Idempotent: every effect is keyed (ledger
 * idempotency keys, one credit per top-up), so duplicates and out-of-order events are harmless.
 */
export async function processRazorpayReceipt(
  deps: BillingProviderDeps & { keyring: Keyring },
  receiptId: string,
): Promise<RazorpayReceiptOutcome> {
  const now = deps.clock.now();
  const claimed = await deps.db.run(systemScope, async (tx) => {
    const rows = await tx
      .update(webhookReceipts)
      .set({
        status: 'processing',
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        attempts: sql`${webhookReceipts.attempts} + 1`,
      })
      .where(
        and(
          eq(webhookReceipts.id, receiptId),
          eq(webhookReceipts.provider, 'razorpay'),
          or(
            eq(webhookReceipts.status, 'pending'),
            eq(webhookReceipts.status, 'failed'),
            and(eq(webhookReceipts.status, 'processing'), lt(webhookReceipts.leaseUntil, now)),
          ),
        ),
      )
      .returning();
    return rows[0];
  });
  if (!claimed) return 'not_claimable';

  /**
   * The receipt's outcome, with its quarantine entry in the same transaction, so the operations
   * console never lists an entry whose receipt is still being processed.
   */
  const finish = async (
    status: 'processed' | 'ignored' | 'quarantined',
    summary: Record<string, unknown>,
    quarantine?: { reason: 'unknown_asset' | 'malformed'; externalIds: Record<string, unknown> },
  ) => {
    await deps.db.run(systemScope, async (tx) => {
      if (quarantine) {
        await tx
          .insert(webhookQuarantine)
          .values({ id: uuidv7(), receiptId, provider: 'razorpay', ...quarantine })
          .onConflictDoNothing();
      }
      await tx
        .update(webhookReceipts)
        .set({ status, summary, processedAt: deps.clock.now(), leaseUntil: null, lastError: null })
        .where(eq(webhookReceipts.id, receiptId));
    });
  };

  try {
    let event: { event?: unknown; payload?: unknown };
    try {
      if (!claimed.bodyCiphertext) throw new Error('body erased');
      event = JSON.parse(
        deps.keyring.decryptString(claimed.bodyCiphertext, receiptAad(claimed.id)),
      ) as typeof event;
    } catch {
      await finish(
        'quarantined',
        { error: 'unreadable body' },
        { reason: 'malformed', externalIds: {} },
      );
      return 'quarantined';
    }
    const name = typeof event.event === 'string' ? event.event.slice(0, 64) : '';
    const payload = event.payload;
    let result: string;
    switch (name) {
      case 'payment.authorized':
      case 'payment.captured':
      case 'payment.failed':
      case 'order.paid': {
        const paymentId = entityId(payload, 'payment');
        if (!paymentId) {
          await finish('ignored', { event: name, reason: 'no payment id' });
          return 'ignored';
        }
        const applied = await applyPaymentById(deps, paymentId);
        if (applied.outcome === 'unknown_order') {
          await finish(
            'quarantined',
            { event: name },
            {
              reason: 'unknown_asset',
              externalIds: { paymentId, orderId: 'orderId' in applied ? applied.orderId : null },
            },
          );
          return 'quarantined';
        }
        result = applied.outcome;
        break;
      }
      case 'refund.processed': {
        const refundId = entityId(payload, 'refund');
        const paymentId = entityField(payload, 'refund', 'payment_id');
        result =
          refundId && paymentId ? await applyRefundById(deps, paymentId, refundId) : 'no refund id';
        break;
      }
      case 'refund.failed': {
        const refundId = entityId(payload, 'refund');
        const paymentId = entityField(payload, 'refund', 'payment_id');
        result =
          refundId && paymentId
            ? await applyRefundFailure(deps, paymentId, refundId)
            : 'no refund id';
        break;
      }
      case 'payment.dispute.lost': {
        const disputeId = entityId(payload, 'dispute');
        result = disputeId ? await applyDispute(deps, disputeId) : 'no dispute id';
        break;
      }
      case 'subscription.authenticated':
      case 'subscription.activated':
      case 'subscription.charged':
      case 'subscription.completed':
      case 'subscription.updated':
      case 'subscription.pending':
      case 'subscription.halted':
      case 'subscription.cancelled':
      case 'subscription.paused':
      case 'subscription.resumed': {
        // The payload only names the subscription: its state is fetched from Razorpay (ADR-063).
        const subscriptionId = entityId(payload, 'subscription');
        if (!subscriptionId) {
          await finish('ignored', { event: name, reason: 'no subscription id' });
          return 'ignored';
        }
        const binding = await resolvePlanSubscription(deps.db, subscriptionId);
        if (!binding) {
          await finish(
            'quarantined',
            { event: name },
            { reason: 'unknown_asset', externalIds: { subscriptionId } },
          );
          return 'quarantined';
        }
        const synced = await syncPlanSubscription(
          deps,
          authorizedTenantScope(binding.tenantId, null),
          binding.subscriptionId,
        );
        result = synced ? `subscription_${synced.status}` : 'subscription_missing';
        break;
      }
      case 'token.confirmed':
      case 'token.rejected':
      case 'token.cancelled':
      case 'token.paused': {
        const tokenId = entityId(payload, 'token');
        const customerId = entityField(payload, 'token', 'customer_id');
        result =
          tokenId && customerId ? await applyTokenEvent(deps, tokenId, customerId) : 'no token id';
        break;
      }
      default:
        await finish('ignored', { event: name });
        return 'ignored';
    }
    await finish('processed', { event: name, result });
    return 'processed';
  } catch (error) {
    await deps.db.run(systemScope, (tx) =>
      tx
        .update(webhookReceipts)
        .set({
          status: 'failed',
          leaseUntil: null,
          lastError: error instanceof Error ? error.message.slice(0, 1000) : 'processing failed',
        })
        .where(eq(webhookReceipts.id, receiptId)),
    );
    throw error;
  }
}

export type ReconcileOutcome = CreditOutcome | 'expired' | 'failed' | 'waiting' | 'skipped';

const ORDER_EXPIRY_MS = 24 * 3600_000;
const TOPUP_MIN_RECHECK_MS = 15 * 60_000;
const TOPUP_MAX_RECHECK_MS = 4 * 3600_000;

/** Backstop for missed webhooks: checks an open manual top-up's order with Razorpay. */
export async function reconcileTopup(
  deps: BillingProviderDeps,
  scope: TenantScope,
  topupId: string,
): Promise<ReconcileOutcome> {
  const [topup] = await deps.db.run(
    scope,
    (tx) =>
      tx
        .select()
        .from(topups)
        .where(and(eq(topups.tenantId, scope.tenantId), eq(topups.id, topupId))),
    { accessMode: 'read only' },
  );
  if (!topup || !['creating', 'awaiting_payment'].includes(topup.status)) return 'skipped';
  const age = deps.clock.now().getTime() - topup.createdAt.getTime();
  if (!topup.providerOrderId) {
    // The order was never recorded, so no browser could have paid it.
    await markTopupFailed(deps.db, scope, topup.id, 'The payment order could not be created.');
    return 'failed';
  }
  const payments = await deps.razorpay.fetchOrderPayments(topup.providerOrderId);
  if (!payments.ok) throw transient(payments, 'order payments fetch');
  const captured = payments.data.find((p) => p.status === 'captured' && p.captured);
  if (captured) return creditFromPayment(deps, scope, topup.id, captured);
  const inFlight = payments.data.some((p) => p.status === 'created' || p.status === 'authorized');
  if (!inFlight && age > ORDER_EXPIRY_MS) {
    await deps.db.run(scope, (tx) =>
      tx
        .update(topups)
        .set({ status: 'expired', failureReason: 'No completed payment within 24 hours.' })
        .where(
          and(
            eq(topups.tenantId, scope.tenantId),
            eq(topups.id, topup.id),
            inArray(topups.status, ['creating', 'awaiting_payment']),
          ),
        ),
    );
    return 'expired';
  }
  // Back off with age: 15 minutes at first, up to every 4 hours.
  const delay = Math.min(Math.max(age, TOPUP_MIN_RECHECK_MS), TOPUP_MAX_RECHECK_MS);
  await deps.db.run(scope, (tx) =>
    tx
      .update(topups)
      .set({ nextCheckAt: new Date(deps.clock.now().getTime() + delay) })
      .where(
        and(
          eq(topups.tenantId, scope.tenantId),
          eq(topups.id, topup.id),
          inArray(topups.status, ['creating', 'awaiting_payment']),
        ),
      ),
  );
  return 'waiting';
}
