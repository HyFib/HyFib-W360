import type { Job } from 'pg-boss';
import { authorizedTenantScope } from '@w360/db';
import {
  authorizeJob,
  enqueueStoreJob,
  enqueueStoreMessage,
  findDueStoreMessages,
  findDueStoreWork,
  processStoreJob,
  processStoreMessage,
} from '@w360/domain';
import type { WorkerRuntime } from '../runtime';
import { RetryableJobError } from './email';

/**
 * `commerce.store`: one store's work under a lease on its row (the row is the source of truth and
 * is re-read under the company's RLS scope). A store that cannot be reached is tried again by the
 * sweep; only a busy connection handshake is retried here.
 */
export const commerceStoreHandler =
  (rt: WorkerRuntime) =>
  async ([job]: Job<unknown>[]) => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'commerce.store',
      requireActiveTenant: true,
      requireActiveActor: false,
    });
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'store job dropped');
      return;
    }
    const outcome = await processStoreJob(
      {
        db: rt.db,
        keyring: rt.keyring,
        clock: rt.clock,
        jobs: rt.jobs,
        signer: rt.signer,
        egress: rt.storeEgress,
        shopify: rt.shopify,
        appBaseUrl: rt.config.APP_BASE_URL,
      },
      auth.scope,
      auth.envelope.ref,
    );
    rt.logger.info({ jobId: job.id, ref: auth.envelope.ref, outcome }, 'store job');
    if (outcome === 'retry') {
      throw new RetryableJobError('commerce.store: the store could not be reached');
    }
  };

/** Signals stores with work due (called from the messaging sweep, every minute). */
export async function sweepStoreWork(rt: WorkerRuntime): Promise<number> {
  const due = await findDueStoreWork(rt.db);
  for (const item of due) {
    // Tenant ids come from the database (SECURITY DEFINER sweep query), not from a payload.
    const scope = authorizedTenantScope(item.tenantId, null);
    await enqueueStoreJob(rt, null, scope.tenantId, item.storeId, `sweep:${item.storeId}`);
  }
  return due.length;
}

/**
 * `commerce.store-message`: one order message at its send time (order messages). The store message
 * row, re-read under the company's RLS scope, decides; a message that is not due or no longer
 * waiting is left alone.
 */
export const commerceStoreMessageHandler =
  (rt: WorkerRuntime) =>
  async ([job]: Job<unknown>[]) => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'commerce.store-message',
      requireActiveTenant: true,
      requireActiveActor: false,
    });
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'store message job dropped');
      return;
    }
    const result = await processStoreMessage(
      { db: rt.db, clock: rt.clock, jobs: rt.jobs, signer: rt.signer },
      auth.scope,
      auth.envelope.ref,
    );
    rt.logger.info(
      {
        jobId: job.id,
        ref: auth.envelope.ref,
        outcome: result.outcome,
        ...(result.outcome === 'skipped' ? { reason: result.reason } : {}),
      },
      'store message',
    );
  };

/** Signals order messages whose send time has come (called from the messaging sweep). */
export async function sweepStoreMessages(rt: WorkerRuntime): Promise<number> {
  const due = await findDueStoreMessages(rt.db);
  for (const item of due) {
    // Tenant ids come from the database (SECURITY DEFINER sweep query), not from a payload.
    const scope = authorizedTenantScope(item.tenantId, null);
    await enqueueStoreMessage(rt, null, scope.tenantId, item.storeMessageId, item.sendAt);
  }
  return due.length;
}
