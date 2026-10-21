import type { Job } from 'pg-boss';
import { QUEUES } from '@w360/contracts';
import { toError } from '@w360/core';
import {
  authorizeJob,
  findDueTenantDeletions,
  runStoredExport,
  runTenantDeletion,
  sweepStoredExports,
  type StoredExportDeps,
} from '@w360/domain';
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

function storedExportDeps(rt: WorkerRuntime, db = rt.db): StoredExportDeps {
  return {
    db,
    clock: rt.clock,
    keyring: rt.keyring,
    jobs: rt.jobs,
    signer: rt.signer,
    appBaseUrl: rt.config.APP_BASE_URL,
  };
}

/**
 * `company.export`: one run of a stored company export (ADR-415). The company comes from the
 * verified envelope and the export from its row in that company; the run decides whether to start,
 * take over a crashed run or give up, and records a failure itself (its error is logged here). A
 * company waiting for deletion or suspended still exports (ADR-055); a deleted one is rejected.
 */
export function companyExportHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'company.export',
      requireActiveTenant: false,
      requireActiveActor: false,
    });
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'stored export job dropped');
      return;
    }
    const exportId = auth.envelope.ref;
    const tenantId = auth.scope.tenantId;
    // A transient database error is thrown on (the job is retried; the lease lets a run take over).
    const result = await runStoredExport(storedExportDeps(rt, rt.exportDb), auth.scope, exportId);
    if (result.outcome === 'failed') {
      rt.logger.warn(
        {
          jobId: job.id,
          tenantId,
          exportId,
          reason: result.reason,
          ...(result.error ? { err: toError(result.error) } : {}),
        },
        'stored export failed',
      );
      return;
    }
    if (result.outcome === 'ready') {
      rt.logger.info(
        {
          jobId: job.id,
          tenantId,
          exportId,
          bytes: result.byteSize,
          parts: result.partCount,
          attempt: result.attempt,
        },
        'stored export ready',
      );
      return;
    }
    // missing, finished, busy (a live run holds it), locked (another export of the company is
    // being read: the sweep signals it again) or lost_lease (another run took it over).
    rt.logger.info({ jobId: job.id, tenantId, exportId, outcome: result.outcome }, 'stored export');
  };
}

/** Expires stored exports and signals waiting or crashed ones (from the minute billing sweep). */
export async function sweepCompanyExports(rt: WorkerRuntime): Promise<void> {
  const result = await sweepStoredExports(storedExportDeps(rt));
  for (const failure of result.failed) {
    rt.logger.warn(
      { tenantId: failure.tenantId, exportId: failure.exportId, err: toError(failure.error) },
      'stored export sweep failed for an export; will retry',
    );
  }
  if (result.expired + result.signalled > 0) {
    rt.logger.info(
      { expired: result.expired, signalled: result.signalled },
      'stored exports swept',
    );
  }
}
