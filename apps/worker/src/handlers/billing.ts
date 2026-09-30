import type { Job } from 'pg-boss';
import { QUEUES } from '@w360/contracts';
import { toError } from '@w360/core';
import { authorizedTenantScope } from '@w360/db';
import {
  advanceAutoRechargeAttempt,
  alertSettlementReconFindings,
  alertUnsettledPayments,
  announceRefundRequests,
  announceRateChanges,
  authorizeJob,
  beginAutoRecharge,
  deferAutoRechargeAttempt,
  findAutoRechargeCandidates,
  findBillingReconciliationDue,
  findDueCreditRefunds,
  findDuePlanPaymentRefunds,
  findDueSettlementRecons,
  findStaleReceipts,
  notifyRefundRequestDeclines,
  notifyStaffDeletions,
  notifyStaffPlanChanges,
  notifyStaffSubscriptionCancellations,
  processCreditRefund,
  processPlanPaymentRefund,
  processRazorpayReceipt,
  reconcileTopup,
  releaseExpiredHolds,
  runSettlementRecon,
  sweepPlanStates,
  sweepPlanSubscriptions,
  syncPlanSubscriptionOfPlan,
  type BillingProviderDeps,
} from '@w360/domain';
import type { WorkerRuntime } from '../runtime';
import { RetryableJobError } from './email';
import { sweepTenantDeletions } from './tenancy';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function providerDeps(rt: WorkerRuntime): BillingProviderDeps | null {
  if (!rt.razorpay) return null;
  return { db: rt.db, razorpay: rt.razorpay, clock: rt.clock, notices: rt.notices };
}

/** Processes one stored Razorpay webhook receipt (idempotent; see processRazorpayReceipt). */
export function billingEventProcessHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'billing.event-process',
      requireActiveTenant: false,
      requireActiveActor: false,
    });
    if (auth.outcome !== 'authorized' || auth.envelope.tenantId !== null) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'billing event job dropped');
      return;
    }
    const deps = providerDeps(rt);
    if (!deps) throw new RetryableJobError('Razorpay is not configured');
    const outcome = await processRazorpayReceipt(
      { ...deps, keyring: rt.keyring },
      auth.envelope.ref,
    );
    rt.logger.info(
      { jobId: job.id, receiptId: auth.envelope.ref, outcome },
      'billing event processed',
    );
  };
}

/**
 * `ref = "check"`: decide whether the company needs a recharge now (and start it);
 * `ref = <attempt id>`: advance that attempt. Runs for suspended companies too, so a debit the bank
 * already accepted is still credited; new attempts are refused in SQL for inactive companies.
 */
export function autoRechargeHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'billing.auto-recharge',
      requireActiveTenant: false,
      requireActiveActor: false,
    });
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'auto-recharge job dropped');
      return;
    }
    const deps = providerDeps(rt);
    if (!deps) {
      rt.logger.warn({ jobId: job.id }, 'auto-recharge skipped: Razorpay is not configured');
      return;
    }
    const scope = auth.scope;
    let attemptId = auth.envelope.ref;
    if (attemptId === 'check') {
      const begun = await beginAutoRecharge(rt.db, scope);
      rt.logger.info(
        { jobId: job.id, tenantId: scope.tenantId, outcome: begun.outcome },
        'auto-recharge check',
      );
      if (!begun.attemptId) return;
      attemptId = begun.attemptId;
    }
    if (!UUID_RE.test(attemptId)) {
      rt.logger.warn({ jobId: job.id }, 'auto-recharge job has an invalid reference');
      return;
    }
    try {
      const result = await advanceAutoRechargeAttempt(deps, scope, attemptId);
      rt.logger.info(
        { jobId: job.id, attemptId, outcome: result.outcome, nextCheckAt: result.nextCheckAt },
        'auto-recharge attempt advanced',
      );
    } catch (error) {
      const message = toError(error).message;
      await deferAutoRechargeAttempt(
        rt.db,
        scope,
        attemptId,
        new Date(rt.clock.now().getTime() + 3600_000),
        `internal: ${message}`,
      );
      throw error;
    }
  };
}

/**
 * `billing.credit-refund`: one step of a refund a platform owner asked for (ADR-058): ask Razorpay
 * for it, or check a refund Razorpay is processing. Provider failures leave the request due again
 * for the minute sweep; only unexpected errors fail the job (and are retried).
 */
export function creditRefundHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'billing.credit-refund',
      requireActiveTenant: false,
      requireActiveActor: false,
    });
    if (auth.outcome !== 'authorized' || !auth.scope || !UUID_RE.test(auth.envelope.ref)) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'credit refund job dropped');
      return;
    }
    const deps = providerDeps(rt);
    if (!deps) throw new RetryableJobError('Razorpay is not configured');
    const outcome = await processCreditRefund(deps, auth.scope, auth.envelope.ref);
    rt.logger.info(
      { jobId: job.id, tenantId: auth.scope.tenantId, refundId: auth.envelope.ref, outcome },
      'credit refund step',
    );
  };
}

/**
 * `billing.plan-payment-refund`: one step of a refund of a plan payment a platform owner asked for
 * (ADR-103): ask Razorpay for it, or check a refund Razorpay is processing. Provider failures leave
 * the request due again for the minute sweep; only unexpected errors fail the job (and are retried).
 */
export function planPaymentRefundHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'billing.plan-payment-refund',
      requireActiveTenant: false,
      requireActiveActor: false,
    });
    if (auth.outcome !== 'authorized' || !auth.scope || !UUID_RE.test(auth.envelope.ref)) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'plan payment refund job dropped');
      return;
    }
    const deps = providerDeps(rt);
    if (!deps) throw new RetryableJobError('Razorpay is not configured');
    const outcome = await processPlanPaymentRefund(deps, auth.scope, auth.envelope.ref);
    rt.logger.info(
      { jobId: job.id, tenantId: auth.scope.tenantId, refundId: auth.envelope.ref, outcome },
      'plan payment refund step',
    );
  };
}

/**
 * `billing.settlement-recon`: one attempt at a day's settlement reconciliation (ADR-059). The run
 * row decides: a run that is not due (finished, or held by another attempt) is left alone, and
 * Razorpay failures leave it due again for the minute sweep. Only unexpected errors fail the job.
 */
export function settlementReconHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'billing.settlement-recon',
      requireActiveTenant: false,
      requireActiveActor: false,
    });
    if (
      auth.outcome !== 'authorized' ||
      auth.envelope.tenantId !== null ||
      !UUID_RE.test(auth.envelope.ref)
    ) {
      rt.logger.warn(
        { jobId: job.id, outcome: auth.outcome },
        'settlement reconciliation job dropped',
      );
      return;
    }
    const deps = providerDeps(rt);
    if (!deps) {
      rt.logger.warn(
        { jobId: job.id },
        'settlement reconciliation skipped: Razorpay is not configured',
      );
      return;
    }
    const result = await runSettlementRecon(deps, auth.envelope.ref);
    rt.logger.info(
      { jobId: job.id, runId: auth.envelope.ref, ...result },
      'settlement reconciliation attempt',
    );
  };
}

/**
 * Every minute: move plans whose trial, paid period or grace period ended to their next state
 * (after syncing the Razorpay subscription that paid the period, ADR-063) and announce reached
 * automation run limits (ADR-051); tell billing managers of plans HyFib staff set (ADR-100) and of
 * subscriptions staff cancelled (ADR-101); email billing managers before Meta's rates for their
 * currency change (ADR-065) and platform owners about reconciliation days that need a person or
 * failed (ADR-066); re-signal Razorpay receipts whose signal was lost, reconcile
 * open manual top-ups, due auto-recharge attempts and due plan subscriptions with Razorpay (the
 * backstop for missed webhooks), queue due steps of staff credit refunds (ADR-058) and the
 * settlement reconciliations owed (ADR-059), start auto-recharge checks for companies below their
 * threshold, and release expired holds.
 */
export function billingSweepHandler(rt: WorkerRuntime) {
  return async (): Promise<void> => {
    const provider = providerDeps(rt);
    const plans = await sweepPlanStates({
      db: rt.db,
      clock: rt.clock,
      notices: rt.notices,
      ...(provider
        ? {
            planPayments: {
              offered: rt.razorpayConfig?.subscriptionsEnabled === true,
              syncBeforeTransition: (scope) => syncPlanSubscriptionOfPlan(provider, scope),
            },
          }
        : {}),
    });
    for (const failure of plans.failed) {
      rt.logger.warn(
        { tenantId: failure.tenantId, err: toError(failure.error).message },
        'plan sweep failed for a company; will retry',
      );
    }
    if (plans.transitioned + plans.announced > 0) {
      rt.logger.info(
        { transitioned: plans.transitioned, announced: plans.announced },
        'plan sweep',
      );
    }
    // Plans HyFib staff set (ADR-100): the company's billing managers are told from here, as the
    // platform role cannot queue email. After the plan sweep, so a change it replaced is not told.
    const staffPlans = await notifyStaffPlanChanges({ db: rt.db, notices: rt.notices });
    for (const failure of staffPlans.failed) {
      rt.logger.warn(
        { tenantId: failure.tenantId, err: toError(failure.error).message },
        'plan change notice failed for a company; will retry',
      );
    }
    if (staffPlans.notified + staffPlans.superseded > 0) {
      rt.logger.info(
        { notified: staffPlans.notified, superseded: staffPlans.superseded },
        'plan change notices',
      );
    }
    // Subscriptions platform owners cancelled (ADR-101), told the same way.
    const staffCancels = await notifyStaffSubscriptionCancellations({
      db: rt.db,
      notices: rt.notices,
    });
    for (const failure of staffCancels.failed) {
      rt.logger.warn(
        {
          tenantId: failure.tenantId,
          subscriptionId: failure.subscriptionId,
          err: toError(failure.error).message,
        },
        'subscription cancellation notice failed for a company; will retry',
      );
    }
    if (staffCancels.notified > 0) {
      rt.logger.info({ notified: staffCancels.notified }, 'subscription cancellation notices');
    }
    // Rate change notices (ADR-065), reconciliation alerts (ADR-066, ADR-071) and company deletions
    // (ADR-055) run whether or not Razorpay is configured.
    const rates = await announceRateChanges({ db: rt.db, clock: rt.clock, notices: rt.notices });
    for (const failure of rates.failed) {
      rt.logger.warn(
        {
          tenantId: failure.tenantId,
          rateCardId: failure.rateCardId,
          err: toError(failure.error).message,
        },
        'rate change notice failed for a company; will retry',
      );
    }
    if (rates.announced > 0) rt.logger.info({ announced: rates.announced }, 'rate change notices');
    const alerts = await alertSettlementReconFindings({
      db: rt.db,
      outbox: rt.notices.outbox,
      appBaseUrl: rt.notices.appBaseUrl,
    });
    if (alerts.alerted > 0) {
      rt.logger.info(
        { days: alerts.alerted, recipients: alerts.recipients },
        'settlement reconciliation alert emailed',
      );
    }
    if (alerts.unsent > 0) {
      rt.logger.warn(
        { days: alerts.unsent },
        'settlement reconciliation needs a person but there is no platform owner to email',
      );
    }
    const unsettled = await alertUnsettledPayments({
      db: rt.db,
      outbox: rt.notices.outbox,
      appBaseUrl: rt.notices.appBaseUrl,
    });
    if (unsettled.alerted > 0) {
      rt.logger.info(
        { payments: unsettled.alerted, recipients: unsettled.recipients },
        'unsettled payments alert emailed',
      );
    }
    if (unsettled.unsent > 0) {
      rt.logger.warn(
        { payments: unsettled.unsent },
        'payments were not settled but there is no platform owner to email',
      );
    }
    // Refund requests from companies (ADR-073): platform owners hear of new ones, billing managers of
    // a decline.
    const requests = await announceRefundRequests({
      db: rt.db,
      outbox: rt.notices.outbox,
      appBaseUrl: rt.notices.appBaseUrl,
    });
    if (requests.announced > 0) {
      rt.logger.info(
        { requests: requests.announced, recipients: requests.recipients },
        'refund requests announced to platform owners',
      );
    }
    if (requests.unsent > 0) {
      rt.logger.warn(
        { requests: requests.unsent },
        'companies asked for refunds but there is no platform owner to email',
      );
    }
    const declines = await notifyRefundRequestDeclines({ db: rt.db, notices: rt.notices });
    for (const failure of declines.failed) {
      rt.logger.warn(
        {
          tenantId: failure.tenantId,
          requestId: failure.requestId,
          err: toError(failure.error).message,
        },
        'refund request decline notice failed for a company; will retry',
      );
    }
    if (declines.notified > 0) {
      rt.logger.info({ declines: declines.notified }, 'refund request declines emailed');
    }
    const deletions = await sweepTenantDeletions(rt);
    if (deletions > 0) rt.logger.info({ deletions }, 'company deletions due');
    // Deletions HyFib staff scheduled or cancelled (ADR-090): the company's owners and
    // administrators are told from here, as the platform role cannot queue email.
    const staffDeletions = await notifyStaffDeletions({
      db: rt.db,
      outbox: rt.notices.outbox,
      appBaseUrl: rt.notices.appBaseUrl,
    });
    for (const failure of staffDeletions.failed) {
      rt.logger.warn(
        {
          tenantId: failure.tenantId,
          deletionId: failure.deletionId,
          notice: failure.notice,
          err: toError(failure.error).message,
        },
        'staff deletion notice failed for a company; will retry',
      );
    }
    if (staffDeletions.notified > 0) {
      rt.logger.info({ notices: staffDeletions.notified }, 'staff deletion notices emailed');
    }
    const released = await releaseExpiredHolds(rt.db);
    const deps = providerDeps(rt);
    if (!deps) {
      if (released > 0) rt.logger.info({ released }, 'billing sweep');
      return;
    }
    const subscriptions = await sweepPlanSubscriptions(deps);
    for (const failure of subscriptions.failed) {
      rt.logger.warn(
        {
          tenantId: failure.tenantId,
          subscriptionId: failure.subscriptionId,
          err: toError(failure.error).message,
        },
        'plan subscription check failed; will retry',
      );
    }
    const receipts = await findStaleReceipts(rt, 500, 'razorpay');
    for (const id of receipts) {
      await rt.jobs.enqueue(
        null,
        QUEUES.billingEventProcess.name,
        rt.signer.sign({
          kind: 'billing.event-process',
          tenantId: null,
          actorUserId: null,
          ref: id,
        }),
        { singletonKey: id },
      );
    }
    const due = await findBillingReconciliationDue(rt.db);
    let reconciled = 0;
    for (const item of due) {
      // Tenant ids come from the database (definer sweep query), never from a payload.
      if (item.kind === 'attempt') {
        await rt.jobs.enqueue(
          null,
          QUEUES.autoRecharge.name,
          rt.signer.sign({
            kind: 'billing.auto-recharge',
            tenantId: item.tenantId,
            actorUserId: null,
            ref: item.id,
          }),
          { singletonKey: item.id },
        );
        continue;
      }
      try {
        const outcome = await reconcileTopup(
          deps,
          authorizedTenantScope(item.tenantId, null),
          item.id,
        );
        if (outcome !== 'waiting') reconciled += 1;
      } catch (error) {
        rt.logger.warn(
          { topupId: item.id, err: toError(error).message },
          'top-up reconciliation failed; will retry',
        );
      }
    }
    // Staff refunds of unused credit (ADR-058): one job per request that is due.
    const refunds = await findDueCreditRefunds(rt.db);
    for (const item of refunds) {
      await rt.jobs.enqueue(
        null,
        QUEUES.billingCreditRefund.name,
        rt.signer.sign({
          kind: 'billing.credit-refund',
          tenantId: item.tenantId,
          actorUserId: null,
          ref: item.refundId,
        }),
        { singletonKey: item.refundId },
      );
    }
    // Staff refunds of plan payments (ADR-103): one job per request that is due.
    const planRefunds = await findDuePlanPaymentRefunds(rt.db);
    for (const item of planRefunds) {
      await rt.jobs.enqueue(
        null,
        QUEUES.billingPlanPaymentRefund.name,
        rt.signer.sign({
          kind: 'billing.plan-payment-refund',
          tenantId: item.tenantId,
          actorUserId: null,
          ref: item.refundId,
        }),
        { singletonKey: item.refundId },
      );
    }
    // Settlement reconciliation (ADR-059): the runs the daily schedule owes, and runs due again.
    const recons = await findDueSettlementRecons(rt.db, rt.clock.now());
    for (const run of recons) {
      await rt.jobs.enqueue(
        null,
        QUEUES.billingSettlementRecon.name,
        rt.signer.sign({
          kind: 'billing.settlement-recon',
          tenantId: null,
          actorUserId: null,
          ref: run.runId,
        }),
        { singletonKey: run.runId },
      );
    }
    const candidates = await findAutoRechargeCandidates(rt.db);
    for (const tenantId of candidates) {
      await rt.jobs.enqueue(
        null,
        QUEUES.autoRecharge.name,
        rt.signer.sign({
          kind: 'billing.auto-recharge',
          tenantId,
          actorUserId: null,
          ref: 'check',
        }),
        { singletonKey: `check:${tenantId}` },
      );
    }
    if (
      receipts.length + due.length + refunds.length + recons.length + candidates.length + released >
      0
    ) {
      rt.logger.info(
        {
          receipts: receipts.length,
          due: due.length,
          reconciled,
          refunds: refunds.length,
          settlementRecons: recons.length,
          candidates: candidates.length,
          released,
        },
        'billing sweep',
      );
    }
  };
}
