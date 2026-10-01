import { z } from 'zod';
import { AppError, displayMoney, notFound, parseMajorUnits, uuidv7, type Clock } from '@w360/core';
import {
  and,
  authorizedTenantScope,
  creditRefundRequests,
  creditRefunds,
  desc,
  eq,
  gt,
  inArray,
  isUniqueViolation,
  ledgerAccounts,
  planPaymentRefundRequests,
  planPayments,
  sql,
  systemScope,
  tenants,
  topups,
  users,
  type CreditRefundRequestStatus,
  type CreditRefundStatus,
  type Database,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { recordAudit, type RequestMeta } from '../audit';
import { assertCan, type TenantContext } from '../authz/context';
import { assertRecentSignIn } from '../authz/step-up';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import { NOTICE_LINE_MAX, splitEmailText } from '../email/templates';
import { parseInput } from '../validation';
import { notifyBillingManagers, type BillingNoticeDeps } from './notices';

/**
 * Refunds of unused service credit asked for by companies (ADR-073). A company's billing managers
 * ask; a platform owner decides on /platform/refunds, and approving starts the staff refund of
 * ADR-058, which checks everything again. A request moves no money and holds no credit.
 */
export const REFUND_REQUEST_LIMITS = {
  /** Requests a company may make in 24 hours. */
  perDay: 5,
  reasonMin: 10,
  reasonMax: 1000,
  /** Requests the minute sweep announces, and declines it tells companies about, per run. */
  sweepBatch: 50,
} as const;

export const REFUND_REQUEST_STATUS_LABELS: Record<CreditRefundRequestStatus, string> = {
  open: 'Waiting for HyFib',
  approved: 'Approved',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

const askSchema = z.object({
  topupId: z.uuid(),
  amount: z.string().trim().min(1, 'Enter the amount to refund.').max(20),
  reason: z
    .string()
    .trim()
    .min(REFUND_REQUEST_LIMITS.reasonMin, 'Tell HyFib why, in at least 10 characters.')
    .max(REFUND_REQUEST_LIMITS.reasonMax, 'Keep the reason under 1,000 characters.'),
});

export interface RefundRequestView {
  id: string;
  topupId: string;
  amountMinor: number;
  reason: string;
  status: CreditRefundRequestStatus;
  requestedAt: Date;
  requestedByName: string | null;
  withdrawnAt: Date | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  /** The staff refund an approval started, and where it stands. */
  refund: { id: string; status: CreditRefundStatus } | null;
}

export interface RefundRequestDeps {
  db: Database;
  clock: Clock;
}

const inr = (minor: number) => displayMoney(BigInt(minor), 'INR');

/** A refund amount typed in rupees, in paise (above ₹0). */
export function refundAmountFromInput(amount: string): number {
  let minor: number;
  try {
    minor = Number(parseMajorUnits(amount, 'INR'));
  } catch {
    throw new AppError('validation_failed', 'Enter the amount in rupees, like 250 or 250.50.', {
      issues: [{ path: 'amount', message: 'Enter the amount in rupees' }],
    });
  }
  if (!Number.isSafeInteger(minor) || minor < 1) {
    throw new AppError('validation_failed', 'Enter an amount above ₹0.', {
      issues: [{ path: 'amount', message: 'Enter an amount above ₹0' }],
    });
  }
  return minor;
}

/**
 * The daily limit on a company's refund requests, of service credit (ADR-073) and of plan payments
 * (ADR-104) together, counted under one per-company lock so concurrent requests cannot pass it. The
 * lock keeps the key requests of service credit took before ADR-104, so servers of both releases
 * serialise during a rolling deploy.
 */
export async function assertRefundRequestAllowance(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`credit_refund_request:${tenantId}`}, 0))`,
  );
  const [credit] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(creditRefundRequests)
    .where(
      and(
        eq(creditRefundRequests.tenantId, tenantId),
        gt(creditRefundRequests.requestedAt, sql`now() - interval '24 hours'`),
      ),
    );
  const [plan] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(planPaymentRefundRequests)
    .where(
      and(
        eq(planPaymentRefundRequests.tenantId, tenantId),
        gt(planPaymentRefundRequests.requestedAt, sql`now() - interval '24 hours'`),
      ),
    );
  if ((credit?.n ?? 0) + (plan?.n ?? 0) >= REFUND_REQUEST_LIMITS.perDay) {
    throw new AppError(
      'rate_limited',
      `A company can ask for ${REFUND_REQUEST_LIMITS.perDay} refunds a day. Try again tomorrow.`,
    );
  }
}

export function createRefundRequestsService(deps: RefundRequestDeps) {
  const { db, clock } = deps;
  return {
    /**
     * Asks HyFib to refund part or all of a paid top-up's unused credit (billing managers, with a
     * recent sign-in). At most what is left of the payment and the unused credit now; one open request
     * per top-up and none while a refund of it is in progress; at most 5 requests a day.
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
          const [topup] = await tx
            .select({
              status: topups.status,
              providerPaymentId: topups.providerPaymentId,
              amountMinor: topups.amountMinor,
              refundedMinor: topups.refundedMinor,
              walletId: topups.walletId,
            })
            .from(topups)
            .where(and(eq(topups.tenantId, ctx.tenant.id), eq(topups.id, data.topupId)));
          if (!topup) throw notFound('Payment');
          if (
            (topup.status !== 'paid' && topup.status !== 'partially_refunded') ||
            !topup.providerPaymentId
          ) {
            throw new AppError(
              'precondition_failed',
              'Only a paid top-up that is not fully refunded can be refunded.',
            );
          }
          const left = topup.amountMinor - topup.refundedMinor;
          if (amountMinor > left) {
            throw new AppError(
              'validation_failed',
              `At most ${inr(left)} is left of this payment.`,
              {
                issues: [{ path: 'amount', message: `At most ${inr(left)}` }],
              },
            );
          }
          const [running] = await tx
            .select({ id: creditRefunds.id })
            .from(creditRefunds)
            .where(
              and(
                eq(creditRefunds.tenantId, ctx.tenant.id),
                eq(creditRefunds.topupId, data.topupId),
                inArray(creditRefunds.status, ['requested', 'submitted']),
              ),
            );
          if (running) {
            throw new AppError('conflict', 'A refund of this payment is already in progress.');
          }
          const [account] = await tx
            .select({ balance: ledgerAccounts.balanceMinor })
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.tenantId, ctx.tenant.id),
                eq(ledgerAccounts.walletId, topup.walletId),
                eq(ledgerAccounts.code, 'wallet_available'),
              ),
            );
          const available = account?.balance ?? 0;
          if (amountMinor > available) {
            throw new AppError(
              'validation_failed',
              `You have ${inr(available)} of unused credit: HyFib refunds only credit you have not spent.`,
              { issues: [{ path: 'amount', message: `At most ${inr(available)}` }] },
            );
          }
          // Only the columns the company role may insert (an open request): a query builder insert
          // names every column, and PostgreSQL checks the grant for each even when it is DEFAULT.
          await tx.execute(
            sql`insert into app.credit_refund_requests
                  (id, tenant_id, topup_id, amount_minor, reason, requested_by_user_id)
                values (${requestId}::uuid, ${ctx.tenant.id}::uuid, ${data.topupId}::uuid,
                  ${amountMinor}::bigint, ${data.reason}, ${ctx.user.id})`,
          );
          await recordAudit(
            tx,
            ctx,
            {
              action: 'billing.credit_refund_requested',
              subjectType: 'credit_refund_request',
              subjectId: requestId,
              metadata: { topupId: data.topupId, amountMinor },
            },
            meta,
          );
        });
      } catch (error) {
        if (isUniqueViolation(error, 'credit_refund_requests_one_open_uq')) {
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
          .update(creditRefundRequests)
          .set({ status: 'withdrawn', withdrawnAt: clock.now() })
          .where(
            and(
              eq(creditRefundRequests.tenantId, ctx.tenant.id),
              eq(creditRefundRequests.id, requestId),
              eq(creditRefundRequests.status, 'open'),
            ),
          )
          .returning({ topupId: creditRefundRequests.topupId });
        if (!withdrawn) {
          const [existing] = await tx
            .select({ status: creditRefundRequests.status })
            .from(creditRefundRequests)
            .where(
              and(
                eq(creditRefundRequests.tenantId, ctx.tenant.id),
                eq(creditRefundRequests.id, requestId),
              ),
            );
          if (!existing) throw notFound('Refund request');
          throw new AppError('conflict', 'This request was already decided or withdrawn.');
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'billing.credit_refund_request_withdrawn',
            subjectType: 'credit_refund_request',
            subjectId: requestId,
            metadata: { topupId: withdrawn.topupId },
          },
          meta,
        );
      });
    },

    /** The company's requests, newest first (the latest 50), or those of one top-up. */
    async list(
      ctx: TenantContext,
      options: { topupId?: string } = {},
    ): Promise<RefundRequestView[]> {
      assertCan(ctx, 'billing.read');
      if (options.topupId !== undefined && !z.uuid().safeParse(options.topupId).success) return [];
      return db.run(ctx.scope, (tx) => selectRequests(tx, ctx.tenant.id, options.topupId), {
        accessMode: 'read only',
      });
    },

    /**
     * What a top-up's receipt offers: its requests, and either the most that can be asked for now
     * (what is left of the payment, capped by the unused credit) or why nothing can be. Only a help
     * for the page: asking checks every rule again, and so does approving.
     */
    async forTopup(
      ctx: TenantContext,
      topupId: string,
    ): Promise<{ requests: RefundRequestView[]; askable: RefundAskable }> {
      assertCan(ctx, 'billing.read');
      if (!z.uuid().safeParse(topupId).success) throw notFound('Payment');
      return db.run(
        ctx.scope,
        async (tx) => {
          const requests = await selectRequests(tx, ctx.tenant.id, topupId);
          const [topup] = await tx
            .select({
              status: topups.status,
              providerPaymentId: topups.providerPaymentId,
              amountMinor: topups.amountMinor,
              refundedMinor: topups.refundedMinor,
              walletId: topups.walletId,
            })
            .from(topups)
            .where(and(eq(topups.tenantId, ctx.tenant.id), eq(topups.id, topupId)));
          if (!topup) throw notFound('Payment');
          const no = (reason: string) => ({ requests, askable: { maxMinor: null, reason } });
          if (ctx.tenant.status === 'pending_deletion' || ctx.tenant.status === 'deleted') {
            return no('The company is being deleted, so it can no longer ask for refunds.');
          }
          const left = topup.amountMinor - topup.refundedMinor;
          if (
            (topup.status !== 'paid' && topup.status !== 'partially_refunded') ||
            !topup.providerPaymentId ||
            left <= 0
          ) {
            return no('Nothing is left of this payment to refund.');
          }
          if (requests.some((r) => r.status === 'open')) {
            return no('You asked for a refund of this payment; HyFib has not decided yet.');
          }
          const [running] = await tx
            .select({ id: creditRefunds.id })
            .from(creditRefunds)
            .where(
              and(
                eq(creditRefunds.tenantId, ctx.tenant.id),
                eq(creditRefunds.topupId, topupId),
                inArray(creditRefunds.status, ['requested', 'submitted']),
              ),
            );
          if (running) return no('A refund of this payment is in progress.');
          const [account] = await tx
            .select({ balance: ledgerAccounts.balanceMinor })
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.tenantId, ctx.tenant.id),
                eq(ledgerAccounts.walletId, topup.walletId),
                eq(ledgerAccounts.code, 'wallet_available'),
              ),
            );
          const available = account?.balance ?? 0;
          if (available <= 0) return no('You have no unused credit to refund.');
          return { requests, askable: { maxMinor: Math.min(left, available), reason: null } };
        },
        { accessMode: 'read only' },
      );
    },
  };
}

/** Whether a top-up's receipt offers a refund request, and up to how much. */
export type RefundAskable = { maxMinor: number; reason: null } | { maxMinor: null; reason: string };

async function selectRequests(
  tx: Tx,
  tenantId: string,
  topupId: string | undefined,
): Promise<RefundRequestView[]> {
  const rows = await tx
    .select({
      id: creditRefundRequests.id,
      topupId: creditRefundRequests.topupId,
      amountMinor: creditRefundRequests.amountMinor,
      reason: creditRefundRequests.reason,
      status: creditRefundRequests.status,
      requestedAt: creditRefundRequests.requestedAt,
      requestedByName: users.name,
      withdrawnAt: creditRefundRequests.withdrawnAt,
      decidedAt: creditRefundRequests.decidedAt,
      decisionNote: creditRefundRequests.decisionNote,
      refundId: creditRefunds.id,
      refundStatus: creditRefunds.status,
    })
    .from(creditRefundRequests)
    .leftJoin(users, eq(users.id, creditRefundRequests.requestedByUserId))
    .leftJoin(
      creditRefunds,
      and(
        eq(creditRefunds.tenantId, creditRefundRequests.tenantId),
        eq(creditRefunds.id, creditRefundRequests.creditRefundId),
      ),
    )
    .where(
      and(
        eq(creditRefundRequests.tenantId, tenantId),
        topupId ? eq(creditRefundRequests.topupId, topupId) : undefined,
      ),
    )
    .orderBy(desc(creditRefundRequests.requestedAt), desc(creditRefundRequests.id))
    .limit(50);
  return rows.map(({ refundId, refundStatus, ...r }) => ({
    ...r,
    refund: refundId && refundStatus ? { id: refundId, status: refundStatus } : null,
  }));
}

export type RefundRequestsService = ReturnType<typeof createRefundRequestsService>;

/**
 * The email platform owners get about requests waiting for a decision: counts only, of service credit
 * (ADR-073) and of plan payments (ADR-104).
 */
export function refundRequestsAnnouncement(
  credit: number,
  appBaseUrl: string,
  plan = 0,
): { subject: string; lines: string[]; url: string; actionLabel: string } {
  const count = credit + plan;
  const what =
    plan === 0
      ? count === 1
        ? 'A company asked HyFib to refund unused service credit from a paid top-up.'
        : `Companies asked HyFib ${count} times to refund unused service credit from paid top-ups.`
      : credit === 0
        ? count === 1
          ? 'A company asked HyFib to refund a plan payment.'
          : `Companies asked HyFib ${count} times to refund plan payments.`
        : `Companies asked HyFib ${count} times for refunds: ${credit} of unused service credit and ${plan} of plan payments.`;
  return {
    subject:
      count === 1
        ? 'A refund request is waiting for a decision'
        : `${count} refund requests are waiting for a decision`,
    lines: [
      what,
      'A platform owner approves each request, which refunds it through Razorpay as a staff refund does, or declines it with a note the company reads.',
      plan === 0
        ? 'Platform → Refunds lists them with the companies, amounts and reasons.'
        : credit === 0
          ? 'Platform → Refunds → Plan payments lists them with the companies, amounts and reasons.'
          : 'Platform → Refunds lists them with the companies, amounts and reasons, under Service credit and Plan payments.',
    ],
    // Straight to the plan payments' list when every request is of a plan payment.
    url: new URL(
      plan > 0 && credit === 0 ? '/platform/refunds?kind=plan' : '/platform/refunds',
      appBaseUrl,
    ).toString(),
    actionLabel: 'Open refunds',
  };
}

export interface RefundRequestNoticeDeps {
  db: Database;
  outbox: OutboxDeps;
  appBaseUrl: string;
  notices: BillingNoticeDeps;
}

/**
 * The minute sweep's email to platform owners about requests not announced yet, of both kinds (counts
 * only), each marked in the transaction that queues the email. Nothing is marked while there is no
 * platform owner, so the requests are announced once there is one.
 */
export async function announceRefundRequests(
  deps: Pick<RefundRequestNoticeDeps, 'db' | 'outbox' | 'appBaseUrl'>,
  limit: number = REFUND_REQUEST_LIMITS.sweepBatch,
): Promise<{ announced: number; unsent: number; recipients: number }> {
  const due = await deps.db.run(
    systemScope,
    async (tx) => {
      const credit = await tx.execute<{ request_id: string }>(
        sql`select request_id from ops.credit_refund_requests_to_announce(${limit}::int)`,
      );
      const plan = await tx.execute<{ request_id: string }>(
        sql`select request_id from ops.plan_payment_refund_requests_to_announce(${limit}::int)`,
      );
      return {
        credit: credit.rows.map((r) => r.request_id),
        plan: plan.rows.map((r) => r.request_id),
      };
    },
    { accessMode: 'read only' },
  );
  const dueCount = due.credit.length + due.plan.length;
  if (dueCount === 0) return { announced: 0, unsent: 0, recipients: 0 };
  const recipients = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ user_id: string; email: string }>(
        sql`select user_id, email from ops.platform_owner_recipients()`,
      ),
    { accessMode: 'read only' },
  );
  if (recipients.rows.length === 0) {
    return { announced: 0, unsent: dueCount, recipients: 0 };
  }
  return deps.db.run(systemScope, async (tx) => {
    const credit =
      due.credit.length > 0
        ? await tx.execute<{ request_id: string }>(
            sql`select request_id from ops.credit_refund_requests_mark_announced(${sql.param(due.credit)}::uuid[])`,
          )
        : { rows: [] };
    const plan =
      due.plan.length > 0
        ? await tx.execute<{ request_id: string }>(
            sql`select request_id from ops.plan_payment_refund_requests_mark_announced(${sql.param(due.plan)}::uuid[])`,
          )
        : { rows: [] };
    const announced = credit.rows.length + plan.rows.length;
    if (announced === 0) {
      return { announced: 0, unsent: 0, recipients: recipients.rows.length };
    }
    const alert = refundRequestsAnnouncement(credit.rows.length, deps.appBaseUrl, plan.rows.length);
    for (const recipient of recipients.rows) {
      await enqueueEmail(deps.outbox, tx, {
        to: recipient.email,
        // Platform work: the email names no company.
        tenantId: null,
        payload: { kind: 'platform.notice', ...alert },
      });
    }
    return { announced, unsent: 0, recipients: recipients.rows.length };
  });
}

/**
 * The minute sweep's email to a company's billing managers about a declined request, of service credit
 * (ADR-073) or of a plan payment (ADR-104), with the note, marked in the company's own scope in the
 * transaction that queues it. A company that fails is reported and tried again the next minute.
 */
export async function notifyRefundRequestDeclines(
  deps: Pick<RefundRequestNoticeDeps, 'db' | 'notices'>,
  limit: number = REFUND_REQUEST_LIMITS.sweepBatch,
): Promise<{
  notified: number;
  failed: {
    kind: 'credit' | 'plan_payment';
    tenantId: string;
    requestId: string;
    error: unknown;
  }[];
}> {
  const due = await deps.db.run(
    systemScope,
    async (tx) => {
      const credit = await tx.execute<{ tenant_id: string; request_id: string }>(
        sql`select tenant_id, request_id from ops.credit_refund_request_declines_due(${limit}::int)`,
      );
      const plan = await tx.execute<{ tenant_id: string; request_id: string }>(
        sql`select tenant_id, request_id from ops.plan_payment_refund_request_declines_due(${limit}::int)`,
      );
      return [
        ...credit.rows.map((r) => ({ kind: 'credit' as const, ...r })),
        ...plan.rows.map((r) => ({ kind: 'plan_payment' as const, ...r })),
      ];
    },
    { accessMode: 'read only' },
  );
  let notified = 0;
  const failed: {
    kind: 'credit' | 'plan_payment';
    tenantId: string;
    requestId: string;
    error: unknown;
  }[] = [];
  for (const { kind, tenant_id: tenantId, request_id: requestId } of due) {
    const scope = authorizedTenantScope(tenantId, null);
    try {
      const told = await deps.db.run(scope, (tx) =>
        kind === 'credit'
          ? tellCreditDecline(deps, tx, scope, requestId)
          : tellPlanPaymentDecline(deps, tx, scope, requestId),
      );
      if (told) notified += 1;
    } catch (error) {
      failed.push({ kind, tenantId, requestId, error });
    }
  }
  return { notified, failed };
}

async function tellCreditDecline(
  deps: Pick<RefundRequestNoticeDeps, 'notices'>,
  tx: Tx,
  scope: TenantScope,
  requestId: string,
): Promise<boolean> {
  const marked = await tx.execute<{ marked: boolean }>(
    sql`select app.credit_refund_request_mark_decline_notified(${requestId}::uuid) as marked`,
  );
  if (marked.rows[0]?.marked !== true) return false;
  const [request] = await tx
    .select({
      amountMinor: creditRefundRequests.amountMinor,
      topupId: creditRefundRequests.topupId,
      decisionNote: creditRefundRequests.decisionNote,
    })
    .from(creditRefundRequests)
    .where(
      and(
        eq(creditRefundRequests.tenantId, scope.tenantId),
        eq(creditRefundRequests.id, requestId),
      ),
    );
  if (!request) return false;
  await notifyBillingManagers(deps.notices, tx, scope, {
    subject: 'HyFib declined your refund request',
    lines: [
      `HyFib declined your request to refund ${inr(request.amountMinor)} of unused service credit.`,
      // The note may hold 1,000 characters, twice a notice's line.
      ...splitEmailText(`HyFib's note: ${request.decisionNote ?? ''}`, NOTICE_LINE_MAX.billing),
      'The credit stays in your wallet. You can ask again from the payment’s receipt.',
    ],
    billingPath: `receipts/${request.topupId}`,
  });
  return true;
}

async function tellPlanPaymentDecline(
  deps: Pick<RefundRequestNoticeDeps, 'notices'>,
  tx: Tx,
  scope: TenantScope,
  requestId: string,
): Promise<boolean> {
  const marked = await tx.execute<{ marked: boolean }>(
    sql`select app.plan_payment_refund_request_mark_decline_notified(${requestId}::uuid) as marked`,
  );
  if (marked.rows[0]?.marked !== true) return false;
  const [request] = await tx
    .select({
      amountMinor: planPaymentRefundRequests.amountMinor,
      planPaymentId: planPaymentRefundRequests.planPaymentId,
      decisionNote: planPaymentRefundRequests.decisionNote,
      receipt: planPayments.providerInvoiceId,
    })
    .from(planPaymentRefundRequests)
    .innerJoin(
      planPayments,
      and(
        eq(planPayments.tenantId, planPaymentRefundRequests.tenantId),
        eq(planPayments.id, planPaymentRefundRequests.planPaymentId),
      ),
    )
    .where(
      and(
        eq(planPaymentRefundRequests.tenantId, scope.tenantId),
        eq(planPaymentRefundRequests.id, requestId),
      ),
    );
  if (!request) return false;
  await notifyBillingManagers(deps.notices, tx, scope, {
    subject: 'HyFib declined your refund request',
    lines: [
      `HyFib declined your request to refund ${inr(request.amountMinor)} of your plan payment ${request.receipt}.`,
      ...splitEmailText(`HyFib's note: ${request.decisionNote ?? ''}`, NOTICE_LINE_MAX.billing),
      'Your plan and its paid period do not change. You can ask again from the payment’s receipt.',
    ],
    billingPath: `plan-payments/${request.planPaymentId}`,
  });
  return true;
}
