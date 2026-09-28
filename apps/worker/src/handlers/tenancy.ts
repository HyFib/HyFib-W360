import type { Job } from 'pg-boss';
import { QUEUES } from '@w360/contracts';
import { authorizeJob, findDueTenantDeletions, runTenantDeletion } from '@w360/domain';
import type { WorkerRuntime } from '../runtime';

/**
 * `tenant.delete`: one run of a company's deletion (ADR-055). The deletion register decides
 * whether the company is due; a run deletes for a few minutes and the minute sweep starts the next
 * one until the company is a tombstone. A company being deleted is never active, so the job runs
 * for inactive companies; a deleted one is rejected by `authorizeJob`.
 */
export function tenantDeleteHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'tenant.delete',
      requireActiveTenant: false,
      requireActiveActor: false,
    });
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'company deletion job dropped');
      return;
    }
    const tenantId = auth.scope.tenantId;
    const result = await runTenantDeletion(
      {
        db: rt.db,
        clock: rt.clock,
        keyring: rt.keyring,
        jobs: rt.jobs,
        signer: rt.signer,
        graph: rt.graph,
        razorpay: rt.razorpay,
        stores: {
          db: rt.db,
          keyring: rt.keyring,
          clock: rt.clock,
          jobs: rt.jobs,
          signer: rt.signer,
          egress: rt.storeEgress,
          shopify: rt.shopify,
          appBaseUrl: rt.config.APP_BASE_URL,
        },
      },
      tenantId,
    );
    if (result.outcome === 'not_due') {
      rt.logger.info({ jobId: job.id, tenantId }, 'company deletion not due');
      return;
    }
    if (result.outcome === 'waiting_for_refund') {
      rt.logger.info({ jobId: job.id, tenantId }, 'company deletion waits for a credit refund');
      return;
    }
    if (result.outcome === 'continue') {
      rt.logger.info(
        { jobId: job.id, tenantId, rowsDeleted: result.rowsDeleted },
        'company deletion continues',
      );
      return;
    }
    rt.logger.info(
      {
        jobId: job.id,
        tenantId,
        rowsDeleted: result.rowsDeleted,
        cleanupFailed: result.cleanup.filter((item) => item.outcome === 'failed').length,
      },
      'company deleted',
    );
  };
}

/**
 * Starts a run for every company whose deletion is due or under way (called from the billing
 * sweep, every minute). Tenant ids come from the deletion register, never from a payload; the
 * singleton key keeps one run per company.
 */
export async function sweepTenantDeletions(rt: WorkerRuntime): Promise<number> {
  const due = await findDueTenantDeletions(rt.db);
  for (const tenantId of due) {
    await rt.jobs.enqueue(
      null,
      QUEUES.tenantDelete.name,
      rt.signer.sign({ kind: 'tenant.delete', tenantId, actorUserId: null, ref: tenantId }),
      { singletonKey: tenantId },
    );
  }
  return due.length;
}
