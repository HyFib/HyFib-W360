import { displayMoney, isAppError, type Clock } from '@w360/core';
import {
  and,
  creditRefunds,
  eq,
  sql,
  systemScope,
  topups,
  type CreditRefundStatus,
  type Database,
  type TenantScope,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { notifyBillingManagers, type BillingNoticeDeps } from './notices';
import type { RazorpayClient, RazorpayRefund } from './razorpay';

/**
 * Refunds of unused service credit started by platform owners (ADR-058). The request holds the
 * credit aside in SQL (`ops.platform_request_credit_refund`); the worker asks Razorpay for the
 * refund with an idempotency key and checks it until Razorpay processes or fails it; the refund is
 * recorded by `app.billing_record_refund`, which releases the hold in the same transaction, and a
 * refusal or failed refund releases it through `app.billing_fail_credit_refund`.
 */

export type { CreditRefundStatus };

export const CREDIT_REFUND_STATUS_LABELS: Record<CreditRefundStatus, string> = {
  requested: 'Being sent to Razorpay',
  submitted: 'With Razorpay',
  processed: 'Refunded',
  failed: 'Failed',
};

/** Razorpay normally completes a refund in 5–7 working days (R-077). */
export const REFUND_DAYS_NOTE =
  'Razorpay usually completes a refund in 5–7 working days, back to the card, UPI or bank account the payment came from.';

const SUBMIT_RETRY_MINUTES = [1, 5, 15, 60];
const MINUTE_MS = 60_000;

function submitRetryDelayMs(attempt: number): number {
  return (SUBMIT_RETRY_MINUTES[attempt - 1] ?? 60) * MINUTE_MS;
}

/** How long to wait before checking a refund Razorpay is still processing. */
export function refundCheckDelayMs(submittedAt: Date, now: Date): number {
  const age = now.getTime() - submittedAt.getTime();
  if (age < 60 * MINUTE_MS) return 15 * MINUTE_MS;
  if (age < 24 * 60 * MINUTE_MS) return 60 * MINUTE_MS;
  return 6 * 60 * MINUTE_MS;
}

// Worker side ----------------------------------------------------------------------------------------

export interface CreditRefundDeps {
  db: Database;
  razorpay: RazorpayClient;
  clock: Clock;
  notices: BillingNoticeDeps;
}

export type CreditRefundOutcome =
  'not_found' | 'done' | 'submitted' | 'processed' | 'failed' | 'pending' | 'retry';

interface LoadedRefund {
  id: string;
  topupId: string;
  amountMinor: number;
  status: CreditRefundStatus;
  providerRefundId: string | null;
  attempts: number;
  submittedAt: Date | null;
  paymentId: string | null;
  receipt: string;
}

/** Requests the worker should act on now (the minute billing sweep queues one job each). */
export async function findDueCreditRefunds(
  db: Database,
  limit = 100,
): Promise<{ tenantId: string; refundId: string }[]> {
  return db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{ tenant_id: string; refund_id: string }>(
        sql`select tenant_id, refund_id from ops.credit_refunds_due(${limit})`,
      );
      return res.rows.map((r) => ({ tenantId: r.tenant_id, refundId: r.refund_id }));
    },
    { accessMode: 'read only' },
  );
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
          id: creditRefunds.id,
          topupId: creditRefunds.topupId,
          amountMinor: creditRefunds.amountMinor,
          status: creditRefunds.status,
          providerRefundId: creditRefunds.providerRefundId,
          attempts: creditRefunds.attempts,
          submittedAt: creditRefunds.submittedAt,
          paymentId: topups.providerPaymentId,
          receipt: topups.receipt,
        })
        .from(creditRefunds)
        .innerJoin(
          topups,
          and(eq(topups.tenantId, creditRefunds.tenantId), eq(topups.id, creditRefunds.topupId)),
        )
        .where(and(eq(creditRefunds.tenantId, scope.tenantId), eq(creditRefunds.id, refundId)));
      return row ?? null;
    },
    { accessMode: 'read only' },
  );
}

/** Records a refund Razorpay processed; `app.billing_record_refund` releases the request's hold. */
async function recordProcessed(
  db: Database,
  scope: TenantScope,
  topupId: string,
  refund: RazorpayRefund,
): Promise<void> {
  await db.run(scope, (tx) =>
    tx.execute(
      sql`select app.billing_record_refund(${topupId}::uuid, ${refund.id}, ${refund.amount}::bigint)`,
    ),
  );
}

/**
 * Fails a request and releases its hold (one definer function), audited and emailed to the billing
 * managers. A request that was processed meanwhile is left alone.
 */
export async function failCreditRefund(
  deps: Pick<CreditRefundDeps, 'db' | 'notices'>,
  scope: TenantScope,
  refundId: string,
  error: string,
): Promise<'failed' | 'done'> {
  try {
    return await deps.db.run(scope, async (tx) => {
      const res = await tx.execute<{ result: string }>(
        sql`select app.billing_fail_credit_refund(${refundId}::uuid, ${error.slice(0, 500)}) as result`,
      );
      if (res.rows[0]?.result !== 'failed') return 'done' as const;
      const [row] = await tx
        .select({ amountMinor: creditRefunds.amountMinor, receipt: topups.receipt })
        .from(creditRefunds)
        .innerJoin(
          topups,
          and(eq(topups.tenantId, creditRefunds.tenantId), eq(topups.id, creditRefunds.topupId)),
        )
        .where(and(eq(creditRefunds.tenantId, scope.tenantId), eq(creditRefunds.id, refundId)));
      await recordSystemAudit(
        tx,
        scope.tenantId,
        {
          action: 'billing.credit_refund_failed',
          subjectType: 'credit_refund',
          subjectId: refundId,
          metadata: { error: error.slice(0, 200) },
        },
        { type: 'provider', id: 'razorpay' },
      );
      if (row) {
        const amount = displayMoney(BigInt(row.amountMinor), 'INR');
        await notifyBillingManagers(deps.notices, tx, scope, {
          subject: 'A refund could not be completed',
          lines: [
            `The refund of ${amount} from your payment ${row.receipt} could not be completed at Razorpay. The amount is back in your available service credit.`,
            'Contact HyFib support if you still want it refunded.',
          ],
        });
      }
      return 'failed' as const;
    });
  } catch (error) {
    // Processed meanwhile (the refund was recorded first): nothing to release.
    if (isAppError(error) && error.code === 'conflict') return 'done';
    throw error;
  }
}

/**
 * One step of a staff refund: ask Razorpay for it (idempotency key `crf_<id>`, the same body on
 * every try), or check a refund Razorpay is processing. The attempt is written down before the call
 * so a crash or a lost response only delays it; a refusal fails the request and releases the hold;
 * anything uncertain is tried again later and never fails a refund Razorpay may still pay.
 */
export async function processCreditRefund(
  deps: CreditRefundDeps,
  scope: TenantScope,
  refundId: string,
): Promise<CreditRefundOutcome> {
  const { db, razorpay, clock } = deps;
  const refund = await loadRefund(db, scope, refundId);
  if (!refund) return 'not_found';
  if (refund.status === 'processed' || refund.status === 'failed') return 'done';
  if (!refund.paymentId) {
    return failCreditRefund(
      deps,
      scope,
      refundId,
      'no_payment: the top-up has no Razorpay payment',
    );
  }
  const now = clock.now();
  const openRequest = and(
    eq(creditRefunds.tenantId, scope.tenantId),
    eq(creditRefunds.id, refundId),
    eq(creditRefunds.status, refund.status),
  );

  if (refund.status === 'requested') {
    const attempt = refund.attempts + 1;
    await db.run(scope, (tx) =>
      tx
        .update(creditRefunds)
        .set({
          attempts: attempt,
          nextAttemptAt: new Date(now.getTime() + submitRetryDelayMs(attempt)),
        })
        .where(openRequest),
    );
    const result = await razorpay.createRefund(refund.paymentId, {
      amount: refund.amountMinor,
      idempotencyKey: `crf_${refundId}`,
      notes: { hyfib_refund: refundId },
    });
    if (!result.ok) {
      // 409: a request with this key is still being processed (R-086). Anything else that is not a
      // clear refusal may have reached Razorpay: try again later with the same key.
      if (result.kind !== 'permanent' || result.httpStatus === 409) return 'retry';
      return failCreditRefund(
        deps,
        scope,
        refundId,
        `${result.code ?? 'refused'}: ${result.description}`,
      );
    }
    const first = await db.run(scope, async (tx) => {
      const updated = await tx
        .update(creditRefunds)
        .set({
          status: 'submitted',
          providerRefundId: result.data.id,
          submittedAt: now,
          nextAttemptAt: new Date(now.getTime() + refundCheckDelayMs(now, now)),
          lastError: null,
        })
        .where(openRequest)
        .returning({ id: creditRefunds.id });
      if (updated.length === 0) return false;
      await recordSystemAudit(
        tx,
        scope.tenantId,
        {
          action: 'billing.credit_refund_submitted',
          subjectType: 'credit_refund',
          subjectId: refundId,
          metadata: { amountMinor: refund.amountMinor, providerRefundId: result.data.id },
        },
        { type: 'provider', id: 'razorpay' },
      );
      const amount = displayMoney(BigInt(refund.amountMinor), 'INR');
      await notifyBillingManagers(deps.notices, tx, scope, {
        subject: 'HyFib is refunding service credit',
        lines: [
          `HyFib started a refund of ${amount} from your payment ${refund.receipt}. ${REFUND_DAYS_NOTE}`,
          'The amount is set aside from your service credit until the refund is complete.',
        ],
        billingPath: `receipts/${refund.topupId}`,
      });
      return true;
    });
    if (result.data.status === 'processed') {
      await recordProcessed(db, scope, refund.topupId, result.data);
      return 'processed';
    }
    if (result.data.status === 'failed') {
      return failCreditRefund(deps, scope, refundId, 'failed: Razorpay failed the refund');
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
      await recordProcessed(db, scope, refund.topupId, fetched.data);
      return 'processed';
    }
    if (fetched.data.status === 'failed') {
      return failCreditRefund(deps, scope, refundId, 'failed: Razorpay failed the refund');
    }
  }
  await db.run(scope, (tx) =>
    tx.update(creditRefunds).set({ nextAttemptAt: later }).where(openRequest),
  );
  return fetched?.ok ? 'pending' : 'retry';
}
