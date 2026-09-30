import { displayMoney, type Clock } from '@w360/core';
import {
  and,
  eq,
  inArray,
  planPaymentRefunds,
  planPayments,
  sql,
  systemScope,
  type Database,
  type PlanPaymentRefundStatus,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { REFUND_DAYS_NOTE, refundCheckDelayMs } from './credit-refunds';
import { notifyBillingManagers, type BillingNoticeDeps } from './notices';
import type { RazorpayClient, RazorpayRefund } from './razorpay';

/**
 * Refunds of plan payments (ADR-103). A platform owner asks for one in SQL
 * (`ops.platform_request_plan_payment_refund`); the worker asks Razorpay for it with an idempotency
 * key and checks it until Razorpay processes or fails it. `app.record_plan_payment_refund` records
 * every processed refund of a plan payment, HyFib's own and those made at Razorpay (for example in
 * its Dashboard). Plan payments never touch the wallet, so nothing is held, and a refund never
 * changes the plan or the subscription.
 */

export type { PlanPaymentRefundStatus };

export const PLAN_PAYMENT_REFUND_STATUS_LABELS: Record<PlanPaymentRefundStatus, string> = {
  requested: 'Being sent to Razorpay',
  submitted: 'With Razorpay',
  processed: 'Refunded',
  failed: 'Failed',
};

/**
 * The note HyFib's refunds carry: the request's id. Razorpay returns a refund's notes (R-120), so a
 * refund whose creation response was lost is still recognised as the request's when its webhook,
 * or the daily reconciliation, reports it first.
 */
export const PLAN_REFUND_NOTE = 'hyfib_plan_refund';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUBMIT_RETRY_MINUTES = [1, 5, 15, 60];
const MINUTE_MS = 60_000;

function submitRetryDelayMs(attempt: number): number {
  return (SUBMIT_RETRY_MINUTES[attempt - 1] ?? 60) * MINUTE_MS;
}

export interface PlanPaymentRefundDeps {
  db: Database;
  razorpay: RazorpayClient;
  clock: Clock;
  notices: BillingNoticeDeps;
}

export type PlanPaymentRefundOutcome =
  'not_found' | 'done' | 'submitted' | 'processed' | 'failed' | 'pending' | 'retry';

/** Requests the worker should act on now (the minute billing sweep queues one job each). */
export async function findDuePlanPaymentRefunds(
  db: Database,
  limit = 100,
): Promise<{ tenantId: string; refundId: string }[]> {
  return db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{ tenant_id: string; refund_id: string }>(
        sql`select tenant_id, refund_id from ops.plan_payment_refunds_due(${limit})`,
      );
      return res.rows.map((r) => ({ tenantId: r.tenant_id, refundId: r.refund_id }));
    },
    { accessMode: 'read only' },
  );
}

/**
 * Records a refund Razorpay processed, fetched from Razorpay, in the company's scope: the request it
 * belongs to becomes processed, or it is recorded as made at Razorpay. The company's audit log gets
 * one entry per refund recorded.
 */
export async function recordPlanPaymentRefund(
  tx: Tx,
  scope: TenantScope,
  refund: RazorpayRefund,
): Promise<'recorded' | 'already_recorded'> {
  const note = refund.notes[PLAN_REFUND_NOTE];
  const requestId = note && UUID_RE.test(note) ? note : null;
  const res = await tx.execute<{ result: string }>(
    sql`select app.record_plan_payment_refund(${refund.paymentId}, ${refund.id},
          ${refund.amount}::bigint, ${requestId}::uuid) as result`,
  );
  if (res.rows[0]?.result === 'already_recorded') return 'already_recorded';
  const [row] = await tx
    .select({
      id: planPaymentRefunds.id,
      planPaymentId: planPaymentRefunds.planPaymentId,
      origin: planPaymentRefunds.origin,
    })
    .from(planPaymentRefunds)
    .where(
      and(
        eq(planPaymentRefunds.tenantId, scope.tenantId),
        eq(planPaymentRefunds.providerRefundId, refund.id),
      ),
    );
  if (row) {
    await recordSystemAudit(
      tx,
      scope.tenantId,
      {
        action: 'billing.plan_payment_refund_processed',
        subjectType: 'plan_payment_refund',
        subjectId: row.id,
        metadata: {
          planPaymentId: row.planPaymentId,
          origin: row.origin,
          amountMinor: refund.amount,
          providerRefundId: refund.id,
        },
      },
      { type: 'provider', id: 'razorpay' },
    );
  }
  return 'recorded';
}

interface LoadedRefund {
  id: string;
  planPaymentId: string;
  amountMinor: number;
  status: PlanPaymentRefundStatus;
  providerRefundId: string | null;
  attempts: number;
  submittedAt: Date | null;
  paymentId: string;
  receipt: string;
}

async function loadRefund(
  db: Database,
  scope: TenantScope,
  refundId: string,
): Promise<LoadedRefund | null> {
  return db.run(
    scope,
    async (tx) => {
      const [row] = await tx
        .select({
          id: planPaymentRefunds.id,
          planPaymentId: planPaymentRefunds.planPaymentId,
          amountMinor: planPaymentRefunds.amountMinor,
          status: planPaymentRefunds.status,
          providerRefundId: planPaymentRefunds.providerRefundId,
          attempts: planPaymentRefunds.attempts,
          submittedAt: planPaymentRefunds.submittedAt,
          paymentId: planPayments.providerPaymentId,
          receipt: planPayments.providerInvoiceId,
        })
        .from(planPaymentRefunds)
        .innerJoin(
          planPayments,
          and(
            eq(planPayments.tenantId, planPaymentRefunds.tenantId),
            eq(planPayments.id, planPaymentRefunds.planPaymentId),
          ),
        )
        .where(
          and(
            eq(planPaymentRefunds.tenantId, scope.tenantId),
            eq(planPaymentRefunds.id, refundId),
            eq(planPaymentRefunds.origin, 'staff'),
          ),
        );
      return row ?? null;
    },
    { accessMode: 'read only' },
  );
}

async function recordProcessed(
  db: Database,
  scope: TenantScope,
  refund: RazorpayRefund,
): Promise<void> {
  await db.run(scope, (tx) => recordPlanPaymentRefund(tx, scope, refund));
}

/**
 * Fails an open request, audited and emailed to the billing managers. Nothing moves: plan payments
 * never touch the wallet. A request processed meanwhile is left alone.
 */
export async function failPlanPaymentRefund(
  deps: Pick<PlanPaymentRefundDeps, 'db' | 'notices'>,
  scope: TenantScope,
  refundId: string,
  error: string,
): Promise<'failed' | 'done'> {
  const message = error.slice(0, 500);
  return deps.db.run(scope, async (tx) => {
    const [failed] = await tx
      .update(planPaymentRefunds)
      .set({ status: 'failed', failedAt: sql`now()`, lastError: message })
      .where(
        and(
          eq(planPaymentRefunds.tenantId, scope.tenantId),
          eq(planPaymentRefunds.id, refundId),
          inArray(planPaymentRefunds.status, ['requested', 'submitted']),
        ),
      )
      .returning({
        amountMinor: planPaymentRefunds.amountMinor,
        planPaymentId: planPaymentRefunds.planPaymentId,
      });
    if (!failed) return 'done' as const;
    const [payment] = await tx
      .select({ receipt: planPayments.providerInvoiceId })
      .from(planPayments)
      .where(
        and(eq(planPayments.tenantId, scope.tenantId), eq(planPayments.id, failed.planPaymentId)),
      );
    await recordSystemAudit(
      tx,
      scope.tenantId,
      {
        action: 'billing.plan_payment_refund_failed',
        subjectType: 'plan_payment_refund',
        subjectId: refundId,
        metadata: { planPaymentId: failed.planPaymentId, error: message.slice(0, 200) },
      },
      { type: 'provider', id: 'razorpay' },
    );
    const amount = displayMoney(BigInt(failed.amountMinor), 'INR');
    await notifyBillingManagers(deps.notices, tx, scope, {
      subject: 'A refund could not be completed',
      lines: [
        `The refund of ${amount} of your plan payment ${payment?.receipt ?? ''} could not be completed at Razorpay. Nothing was refunded.`,
        'Contact HyFib support if you still want it refunded.',
      ],
      billingPath: `plan-payments/${failed.planPaymentId}`,
    });
    return 'failed' as const;
  });
}

/**
 * One step of a staff refund of a plan payment: ask Razorpay for it (idempotency key `ppr_<id>`, the
 * same body on every try), or check a refund Razorpay is processing. The attempt is written down
 * before the call, so a crash or a lost response only delays it; a refusal fails the request;
 * anything uncertain is tried again later and never fails a refund Razorpay may still pay.
 */
export async function processPlanPaymentRefund(
  deps: PlanPaymentRefundDeps,
  scope: TenantScope,
  refundId: string,
): Promise<PlanPaymentRefundOutcome> {
  const { db, razorpay, clock } = deps;
  const refund = await loadRefund(db, scope, refundId);
  if (!refund) return 'not_found';
  if (refund.status === 'processed' || refund.status === 'failed') return 'done';
  const now = clock.now();
  const openRequest = and(
    eq(planPaymentRefunds.tenantId, scope.tenantId),
    eq(planPaymentRefunds.id, refundId),
    eq(planPaymentRefunds.status, refund.status),
  );

  if (refund.status === 'requested') {
    const attempt = refund.attempts + 1;
    await db.run(scope, (tx) =>
      tx
        .update(planPaymentRefunds)
        .set({
          attempts: attempt,
          nextAttemptAt: new Date(now.getTime() + submitRetryDelayMs(attempt)),
        })
        .where(openRequest),
    );
    const result = await razorpay.createRefund(refund.paymentId, {
      amount: refund.amountMinor,
      idempotencyKey: `ppr_${refundId}`,
      notes: { [PLAN_REFUND_NOTE]: refundId },
    });
    if (!result.ok) {
      // 409: a request with this key is still being processed (R-086). Anything else that is not a
      // clear refusal may have reached Razorpay: try again later with the same key.
      if (result.kind !== 'permanent' || result.httpStatus === 409) return 'retry';
      return failPlanPaymentRefund(
        deps,
        scope,
        refundId,
        `${result.code ?? 'refused'}: ${result.description}`,
      );
    }
    const first = await db.run(scope, async (tx) => {
      const updated = await tx
        .update(planPaymentRefunds)
        .set({
          status: 'submitted',
          providerRefundId: result.data.id,
          submittedAt: now,
          nextAttemptAt: new Date(now.getTime() + refundCheckDelayMs(now, now)),
          lastError: null,
        })
        .where(openRequest)
        .returning({ id: planPaymentRefunds.id });
      if (updated.length === 0) return false;
      await recordSystemAudit(
        tx,
        scope.tenantId,
        {
          action: 'billing.plan_payment_refund_submitted',
          subjectType: 'plan_payment_refund',
          subjectId: refundId,
          metadata: {
            planPaymentId: refund.planPaymentId,
            amountMinor: refund.amountMinor,
            providerRefundId: result.data.id,
          },
        },
        { type: 'provider', id: 'razorpay' },
      );
      const amount = displayMoney(BigInt(refund.amountMinor), 'INR');
      await notifyBillingManagers(deps.notices, tx, scope, {
        subject: 'HyFib is refunding a plan payment',
        lines: [
          `HyFib started a refund of ${amount} of your plan payment ${refund.receipt}. ${REFUND_DAYS_NOTE}`,
          'Your plan and its paid period do not change.',
        ],
        billingPath: `plan-payments/${refund.planPaymentId}`,
      });
      return true;
    });
    if (result.data.status === 'processed') {
      await recordProcessed(db, scope, result.data);
      return 'processed';
    }
    if (result.data.status === 'failed') {
      return failPlanPaymentRefund(deps, scope, refundId, 'failed: Razorpay failed the refund');
    }
    return first ? 'submitted' : 'done';
  }

  // Submitted: check the refund until Razorpay processes or fails it.
  const submittedAt = refund.submittedAt ?? now;
  const later = new Date(now.getTime() + refundCheckDelayMs(submittedAt, now));
  const fetched = refund.providerRefundId
    ? await razorpay.fetchRefund(refund.paymentId, refund.providerRefundId)
    : null;
  if (fetched?.ok) {
    if (fetched.data.status === 'processed') {
      await recordProcessed(db, scope, fetched.data);
      return 'processed';
    }
    if (fetched.data.status === 'failed') {
      return failPlanPaymentRefund(deps, scope, refundId, 'failed: Razorpay failed the refund');
    }
  }
  await db.run(scope, (tx) =>
    tx.update(planPaymentRefunds).set({ nextAttemptAt: later }).where(openRequest),
  );
  return fetched?.ok ? 'pending' : 'retry';
}
