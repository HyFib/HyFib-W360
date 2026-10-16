import type { Job } from 'pg-boss';
import {
  advanceAutomationRun,
  applyAutomationRetention,
  authorizeJob,
  endEnrollmentForRemovedMember,
  findDueAutomationRuns,
  findDueHttpCalls,
  processEnrollmentBatch,
  processHttpCall,
  signalEnrollment,
  signalAutomationRun,
  signalHttpCall,
  stopRunForRemovedTester,
} from '@w360/domain';
import type { WorkerRuntime } from '../runtime';

/**
 * Advances one automation run (see automations/runner). The run row is the source of truth: the
 * job is only a signal, so duplicate or late jobs do nothing, and a run whose job was lost is
 * signalled again by the sweep.
 */
export function automationRunHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'automation.run',
      requireActiveTenant: true,
      // Test runs carry the member who started them; live runs act for the company.
      requireActiveActor: true,
    });
    if (auth.outcome === 'deferred') {
      // Suspended company: the run waits; the sweep signals it again after reactivation.
      rt.logger.info({ jobId: job.id, runId: auth.envelope.ref }, 'automation run deferred');
      return;
    }
    if (auth.outcome === 'rejected' && 'cleanupScope' in auth) {
      const stopped = await stopRunForRemovedTester(
        { db: rt.db, clock: rt.clock },
        auth.cleanupScope,
        auth.envelope.ref,
      );
      rt.logger.info(
        { jobId: job.id, runId: auth.envelope.ref, stopped },
        'test run tester removed',
      );
      return;
    }
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'automation job dropped');
      return;
    }
    const result = await advanceAutomationRun(
      { db: rt.db, jobs: rt.jobs, signer: rt.signer, clock: rt.clock, keyring: rt.keyring },
      auth.scope,
      auth.envelope.ref,
      auth.envelope.actorUserId,
    );
    rt.logger.info(
      { jobId: job.id, runId: auth.envelope.ref, outcome: result.outcome, steps: result.steps },
      'automation run advanced',
    );
  };
}

/** Minutes before a suspended company's enrolment job looks again (ADR-401). */
const ENROLLMENT_DEFER_MINUTES = 5;

/**
 * Handles one batch of a member's enrolment of contacts in an automation (see
 * automations/enrollments, ADR-401). The enrolment row is the source of truth: each batch records
 * its contacts' outcomes with their runs and queues the next batch in the same transaction, so a
 * duplicate or retried job starts nothing twice. The job is signed with the member who started the
 * enrolment: a member who left ends it; a suspended company's enrolment waits and is looked at again.
 */
export function automationEnrollHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'automation.enroll',
      requireActiveTenant: true,
      requireActiveActor: true,
    });
    if (auth.outcome === 'deferred') {
      // Suspended company: no run starts; the same signed job is queued again for later (the
      // tenant id comes from the verified envelope).
      const minute = Math.floor(rt.clock.now().getTime() / 60_000);
      const { tenantId, actorUserId, ref } = auth.envelope;
      if (tenantId && actorUserId) {
        await signalEnrollment(rt, null, {
          tenantId,
          enrollmentId: ref,
          actorUserId,
          key: `${ref}:deferred:${minute}`,
          at: new Date(rt.clock.now().getTime() + ENROLLMENT_DEFER_MINUTES * 60_000),
        });
      }
      rt.logger.info({ jobId: job.id, enrollmentId: ref }, 'automation enrolment deferred');
      return;
    }
    if (auth.outcome === 'rejected' && 'cleanupScope' in auth) {
      const ended = await endEnrollmentForRemovedMember(
        { db: rt.db, clock: rt.clock },
        auth.cleanupScope,
        auth.envelope.ref,
      );
      rt.logger.info(
        { jobId: job.id, enrollmentId: auth.envelope.ref, ended },
        'automation enrolment member removed',
      );
      return;
    }
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'automation enrolment job dropped');
      return;
    }
    const result = await processEnrollmentBatch(
      { db: rt.db, jobs: rt.jobs, signer: rt.signer, clock: rt.clock },
      auth.scope,
      auth.envelope.ref,
    );
    rt.logger.info(
      { jobId: job.id, enrollmentId: auth.envelope.ref, ...result },
      'automation enrolment batch',
    );
  };
}

/**
 * Makes one automation HTTP call (see automations/http). Only a queued call is ever sent, so a
 * duplicate or retried job does nothing; logs carry the call's outcome, never its request.
 */
export function automationHttpHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'automation.http',
      requireActiveTenant: true,
      requireActiveActor: true,
    });
    if (auth.outcome === 'deferred') {
      // Suspended company: the call waits; the run's deadline cancels it if it is still queued.
      rt.logger.info({ jobId: job.id, callId: auth.envelope.ref }, 'automation HTTP call deferred');
      return;
    }
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'automation HTTP job dropped');
      return;
    }
    const outcome = await processHttpCall(
      {
        db: rt.db,
        clock: rt.clock,
        keyring: rt.keyring,
        jobs: rt.jobs,
        signer: rt.signer,
        egress: rt.egress,
        timeoutMs: rt.egressPolicy.timeoutMs,
      },
      auth.scope,
      auth.envelope.ref,
    );
    rt.logger.info({ jobId: job.id, callId: auth.envelope.ref, outcome }, 'automation HTTP call');
  };
}

/**
 * Signals runs whose next step is overdue (lost signals, due reply deadlines and wait timers) and
 * applies automation retention. Called from the per-minute messaging sweep.
 */
export async function sweepAutomationRuns(rt: WorkerRuntime): Promise<{ signalled: number }> {
  const due = await findDueAutomationRuns(rt.db);
  const minute = Math.floor(rt.clock.now().getTime() / 60_000);
  for (const run of due) {
    // Tenant ids come from the database (SECURITY DEFINER sweep query), not from a payload.
    await signalAutomationRun(rt, null, {
      tenantId: run.tenantId,
      runId: run.runId,
      actorUserId: run.actorUserId,
      key: `sweep:${minute}`,
    });
  }
  // Queued HTTP calls whose job was lost (tenant ids from the definer sweep query).
  for (const call of await findDueHttpCalls(rt.db)) await signalHttpCall(rt, call);
  const retention = await applyAutomationRetention(rt.db);
  if (retention.cleared + retention.deleted > 0) {
    rt.logger.info(retention, 'automation retention applied');
  }
  return { signalled: due.length };
}
