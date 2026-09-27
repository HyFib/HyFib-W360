import type { Job } from 'pg-boss';
import {
  advanceAutomationRun,
  applyAutomationRetention,
  authorizeJob,
  findDueAutomationRuns,
  signalAutomationRun,
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
      { db: rt.db, jobs: rt.jobs, signer: rt.signer, clock: rt.clock },
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
  const retention = await applyAutomationRetention(rt.db);
  if (retention.cleared + retention.deleted > 0) {
    rt.logger.info(retention, 'automation retention applied');
  }
  return { signalled: due.length };
}
