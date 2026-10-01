import { z } from 'zod';
import { AppError, displayMoney, notFound, uuidv7, type Clock } from '@w360/core';
import {
  and,
  desc,
  eq,
  inArray,
  isUniqueViolation,
  planPaymentRefundRequests,
  planPaymentRefunds,
  planPayments,
  sql,
  tenants,
  users,
  type Database,
  type PlanPaymentRefundRequestStatus,
  type PlanPaymentRefundStatus,
  type Tx,
} from '@w360/db';
import { recordAudit, type RequestMeta } from '../audit';
import { assertCan, type TenantContext } from '../authz/context';
import { assertRecentSignIn } from '../authz/step-up';
import { parseInput } from '../validation';
import {
  REFUND_REQUEST_LIMITS,
  assertRefundRequestAllowance,
  refundAmountFromInput,
  type RefundAskable,
} from './refund-requests';

/**
 * Refunds of plan payments asked for by companies (ADR-104). A company's billing managers ask from a
 * plan payment's receipt; a platform owner decides on /platform/refunds, and approving starts the
 * staff refund of ADR-103, which checks everything again. A request moves no money and changes
 * nothing about the plan.
 */

export type { PlanPaymentRefundRequestStatus };

const askSchema = z.object({
  planPaymentId: z.uuid(),
  amount: z.string().trim().min(1, 'Enter the amount to refund.').max(20),
  reason: z
    .string()
    .trim()
    .min(REFUND_REQUEST_LIMITS.reasonMin, 'Tell HyFib why, in at least 10 characters.')
    .max(REFUND_REQUEST_LIMITS.reasonMax, 'Keep the reason under 1,000 characters.'),
});

export interface PlanRefundRequestView {
  id: string;
  planPaymentId: string;
  amountMinor: number;
  reason: string;
  status: PlanPaymentRefundRequestStatus;
  requestedAt: Date;
  requestedByName: string | null;
  withdrawnAt: Date | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  /** The staff refund an approval started, and where it stands. */
  refund: { id: string; status: PlanPaymentRefundStatus } | null;
}

export interface PlanRefundRequestDeps {
  db: Database;
  clock: Clock;
}

const inr = (minor: number) => displayMoney(BigInt(minor), 'INR');

/** What Razorpay has not refunded of a company's plan payment, and whether a refund of it runs. */
async function paymentLeft(
  tx: Tx,
  tenantId: string,
  planPaymentId: string,
): Promise<{ left: number; refundRunning: boolean } | null> {
  const [payment] = await tx
    .select({ amountMinor: planPayments.amountMinor })
    .from(planPayments)
    .where(and(eq(planPayments.tenantId, tenantId), eq(planPayments.id, planPaymentId)));
  if (!payment) return null;
  const [refunded] = await tx
    .select({ total: sql<number>`coalesce(sum(${planPaymentRefunds.amountMinor}), 0)::bigint` })
    .from(planPaymentRefunds)
    .where(
      and(
        eq(planPaymentRefunds.tenantId, tenantId),
        eq(planPaymentRefunds.planPaymentId, planPaymentId),
        eq(planPaymentRefunds.status, 'processed'),
      ),
    );
  const [running] = await tx
    .select({ id: planPaymentRefunds.id })
    .from(planPaymentRefunds)
    .where(
      and(
        eq(planPaymentRefunds.tenantId, tenantId),
        eq(planPaymentRefunds.planPaymentId, planPaymentId),
        inArray(planPaymentRefunds.status, ['requested', 'submitted']),
      ),
    )
    .limit(1);
  return {
    left: payment.amountMinor - Number(refunded?.total ?? 0),
    refundRunning: running !== undefined,
  };
}

export function createPlanRefundRequestsService(deps: PlanRefundRequestDeps) {
  const { db, clock } = deps;
  return {
    /**
     * Asks HyFib to refund part or all of a plan payment (billing managers, with a recent sign-in):
     * at most what Razorpay has not refunded of it; one open request per payment and none while a
     * refund of it is in progress; at most 5 refund requests of either kind a day.
     */
    async ask(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<{ requestId: string }> {
      assertCan(ctx, 'billing.manage');
      assertRecentSignIn(ctx, clock.now());
      const data = parseInput(askSchema, input);
      const amountMinor = refundAmountFromInput(data.amount);
      const requestId = uuidv7();
      try {
        await db.run(ctx.scope, async (tx) => {
          // The status now, not the context's: an owner may have asked for the company's deletion
          // since the context was read. app.request_tenant_deletion locks the row for update, so
          // under this share lock it waits for the request, or the request sees the new status.
          const [company] = await tx
            .select({ status: tenants.status })
            .from(tenants)
            .where(eq(tenants.id, ctx.tenant.id))
            .for('share');
          if (!company) throw notFound('Company');
          if (company.status === 'pending_deletion' || company.status === 'deleted') {
            throw new AppError(
              'precondition_failed',
              'The company is being deleted, so it can no longer ask for refunds.',
            );
          }
          await assertRefundRequestAllowance(tx, ctx.tenant.id);
          const payment = await paymentLeft(tx, ctx.tenant.id, data.planPaymentId);
          if (!payment) throw notFound('Payment');
          if (payment.left <= 0) {
            throw new AppError('precondition_failed', 'This payment was refunded in full.');
          }
          if (amountMinor > payment.left) {
            throw new AppError(
              'validation_failed',
              `At most ${inr(payment.left)} is left of this payment.`,
              { issues: [{ path: 'amount', message: `At most ${inr(payment.left)}` }] },
            );
          }
          if (payment.refundRunning) {
            throw new AppError('conflict', 'A refund of this payment is already in progress.');
          }
          // Only the columns the company role may insert (an open request): a query builder insert
          // names every column, and PostgreSQL checks the grant for each even when it is DEFAULT.
          await tx.execute(
            sql`insert into app.plan_payment_refund_requests
                  (id, tenant_id, plan_payment_id, amount_minor, reason, requested_by_user_id)
                values (${requestId}::uuid, ${ctx.tenant.id}::uuid, ${data.planPaymentId}::uuid,
                  ${amountMinor}::bigint, ${data.reason}, ${ctx.user.id})`,
          );
          await recordAudit(
            tx,
            ctx,
            {
              action: 'billing.plan_payment_refund_requested',
              subjectType: 'plan_payment_refund_request',
              subjectId: requestId,
              metadata: { planPaymentId: data.planPaymentId, amountMinor },
            },
            meta,
          );
        });
      } catch (error) {
        if (isUniqueViolation(error, 'plan_payment_refund_requests_one_open_uq')) {
          throw new AppError(
            'conflict',
            'You already asked for a refund of this payment. Withdraw that request to ask again.',
          );
        }
        throw error;
      }
      return { requestId };
    },

    /** Withdraws an open request (billing managers). */
    async withdraw(ctx: TenantContext, requestId: string, meta: RequestMeta = {}): Promise<void> {
      assertCan(ctx, 'billing.manage');
      if (!z.uuid().safeParse(requestId).success) throw notFound('Refund request');
      await db.run(ctx.scope, async (tx) => {
        const [withdrawn] = await tx
          .update(planPaymentRefundRequests)
          .set({ status: 'withdrawn', withdrawnAt: clock.now() })
          .where(
            and(
              eq(planPaymentRefundRequests.tenantId, ctx.tenant.id),
              eq(planPaymentRefundRequests.id, requestId),
              eq(planPaymentRefundRequests.status, 'open'),
            ),
          )
          .returning({ planPaymentId: planPaymentRefundRequests.planPaymentId });
        if (!withdrawn) {
          const [existing] = await tx
            .select({ status: planPaymentRefundRequests.status })
            .from(planPaymentRefundRequests)
            .where(
              and(
                eq(planPaymentRefundRequests.tenantId, ctx.tenant.id),
                eq(planPaymentRefundRequests.id, requestId),
              ),
            );
          if (!existing) throw notFound('Refund request');
          throw new AppError('conflict', 'This request was already decided or withdrawn.');
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'billing.plan_payment_refund_request_withdrawn',
            subjectType: 'plan_payment_refund_request',
            subjectId: requestId,
            metadata: { planPaymentId: withdrawn.planPaymentId },
          },
          meta,
        );
      });
    },

    /**
     * What a plan payment's receipt offers: its requests, and either the most that can be asked for
     * now (what Razorpay has not refunded of it) or why nothing can be. Only a help for the page:
     * asking checks every rule again, and so does approving.
     */
    async forPlanPayment(
      ctx: TenantContext,
      planPaymentId: string,
    ): Promise<{ requests: PlanRefundRequestView[]; askable: RefundAskable }> {
      assertCan(ctx, 'billing.read');
      if (!z.uuid().safeParse(planPaymentId).success) throw notFound('Payment');
      return db.run(
        ctx.scope,
        async (tx) => {
          const payment = await paymentLeft(tx, ctx.tenant.id, planPaymentId);
          if (!payment) throw notFound('Payment');
          const requests = await selectPlanRequests(tx, ctx.tenant.id, planPaymentId);
          const no = (reason: string) => ({ requests, askable: { maxMinor: null, reason } });
          if (ctx.tenant.status === 'pending_deletion' || ctx.tenant.status === 'deleted') {
            return no('The company is being deleted, so it can no longer ask for refunds.');
          }
          if (payment.left <= 0) return no('This payment was refunded in full.');
          if (requests.some((r) => r.status === 'open')) {
            return no('You asked for a refund of this payment; HyFib has not decided yet.');
          }
          if (payment.refundRunning) return no('A refund of this payment is in progress.');
          return { requests, askable: { maxMinor: payment.left, reason: null } };
        },
        { accessMode: 'read only' },
      );
    },
  };
}

async function selectPlanRequests(
  tx: Tx,
  tenantId: string,
  planPaymentId: string,
): Promise<PlanRefundRequestView[]> {
  const rows = await tx
    .select({
      id: planPaymentRefundRequests.id,
      planPaymentId: planPaymentRefundRequests.planPaymentId,
      amountMinor: planPaymentRefundRequests.amountMinor,
      reason: planPaymentRefundRequests.reason,
      status: planPaymentRefundRequests.status,
      requestedAt: planPaymentRefundRequests.requestedAt,
      requestedByName: users.name,
      withdrawnAt: planPaymentRefundRequests.withdrawnAt,
      decidedAt: planPaymentRefundRequests.decidedAt,
      decisionNote: planPaymentRefundRequests.decisionNote,
      refundId: planPaymentRefunds.id,
      refundStatus: planPaymentRefunds.status,
    })
    .from(planPaymentRefundRequests)
    .leftJoin(users, eq(users.id, planPaymentRefundRequests.requestedByUserId))
    .leftJoin(
      planPaymentRefunds,
      and(
        eq(planPaymentRefunds.tenantId, planPaymentRefundRequests.tenantId),
        eq(planPaymentRefunds.id, planPaymentRefundRequests.planPaymentRefundId),
      ),
    )
    .where(
      and(
        eq(planPaymentRefundRequests.tenantId, tenantId),
        eq(planPaymentRefundRequests.planPaymentId, planPaymentId),
      ),
    )
    .orderBy(desc(planPaymentRefundRequests.requestedAt), desc(planPaymentRefundRequests.id))
    .limit(50);
  return rows.map(({ refundId, refundStatus, ...r }) => ({
    ...r,
    refund: refundId && refundStatus ? { id: refundId, status: refundStatus } : null,
  }));
}

export type PlanRefundRequestsService = ReturnType<typeof createPlanRefundRequestsService>;
