import type { Job } from 'pg-boss';
import { QUEUES } from '@w360/contracts';
import { toError } from '@w360/core';
import { authorizedTenantScope } from '@w360/db';
import {
  advanceAutoRechargeAttempt,
  authorizeJob,
  beginAutoRecharge,
  deferAutoRechargeAttempt,
  findAutoRechargeCandidates,
  findBillingReconciliationDue,
  findStaleReceipts,
  processRazorpayReceipt,
  reconcileTopup,
  releaseExpiredHolds,
  sweepPlanStates,
  type BillingProviderDeps,
} from '@w360/domain';
import type { WorkerRuntime } from '../runtime';
import { RetryableJobError } from './email';

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
 * Every minute: move plans whose trial, paid period or grace period ended to their next state and
 * announce reached automation run limits (ADR-051); re-signal Razorpay receipts whose signal was
 * lost, reconcile open manual top-ups and due auto-recharge attempts with Razorpay (the backstop
 * for missed webhooks), start auto-recharge checks for companies below their threshold, and
 * release expired holds.
 */
export function billingSweepHandler(rt: WorkerRuntime) {
  return async (): Promise<void> => {
    const plans = await sweepPlanStates({ db: rt.db, clock: rt.clock, notices: rt.notices });
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
    const released = await releaseExpiredHolds(rt.db);
    const deps = providerDeps(rt);
    if (!deps) {
      if (released > 0) rt.logger.info({ released }, 'billing sweep');
      return;
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
    if (receipts.length + due.length + candidates.length + released > 0) {
      rt.logger.info(
        {
          receipts: receipts.length,
          due: due.length,
          reconciled,
          candidates: candidates.length,
          released,
        },
        'billing sweep',
      );
    }
  };
}
