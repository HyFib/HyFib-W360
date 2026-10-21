import type { Job } from 'pg-boss';
import { QUEUES } from '@w360/contracts';
import { authorizedTenantScope, type TenantScope } from '@w360/db';
import {
  authorizeJob,
  findDueCommerceWork,
  giveUpCommerceSync,
  isManagementPaused,
  processCommerceSync,
  processPaymentAccountCheck,
  processPaymentLink,
  queueDailyCommerceSync,
  type CommerceJobOutcome,
  type ManagementPaused,
  type CommerceWorkerDeps,
} from '@w360/domain';
import type { WorkerRuntime } from '../runtime';
import { RetryableJobError } from './email';
import { deferPausedWork } from './management-deferral';

type CommerceKind = 'commerce.sync' | 'commerce.link' | 'commerce.account';

/**
 * Commerce jobs: the catalog read, the Payment Link or the payment account row is the source of
 * truth and each job re-reads it under the company's RLS scope; Meta and Razorpay being
 * unreachable is retried with backoff.
 */
function commerceHandler(
  rt: WorkerRuntime,
  kind: CommerceKind,
  run: (
    deps: CommerceWorkerDeps,
    scope: TenantScope,
    ref: string,
  ) => Promise<CommerceJobOutcome | ManagementPaused | 'no_meta'>,
) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: kind,
      requireActiveTenant: true,
      requireActiveActor: false,
    });
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, kind, outcome: auth.outcome }, 'commerce job dropped');
      return;
    }
    const deps: CommerceWorkerDeps = {
      db: rt.db,
      keyring: rt.keyring,
      clock: rt.clock,
      razorpayBaseUrl: rt.razorpayBaseUrl,
      jobs: rt.jobs,
      signer: rt.signer,
    };
    const outcome = await run(deps, auth.scope, auth.envelope.ref);
    if (outcome === 'no_meta') throw new RetryableJobError('Meta is not configured');
    if (isManagementPaused(outcome)) {
      // Meta throttles the account's management calls (ADR-399): nothing failed.
      await deferPausedWork(rt, {
        jobId: job.id,
        kind: kind,
        tenantId: auth.scope.tenantId,
        actorUserId: auth.envelope.actorUserId,
        ref: auth.envelope.ref,
        pausedUntil: outcome.paused,
      });
      return;
    }
    rt.logger.info({ jobId: job.id, kind, ref: auth.envelope.ref, outcome }, 'commerce job');
    if (outcome === 'retry') {
      throw new RetryableJobError(`${kind}: provider unavailable or the row is busy`);
    }
  };
}

export const commerceSyncHandler = (rt: WorkerRuntime) =>
  commerceHandler(rt, 'commerce.sync', (deps, scope, ref) =>
    rt.graph
      ? processCommerceSync({ ...deps, graph: rt.graph }, scope, ref)
      : Promise.resolve('no_meta' as const),
  );
export const commerceLinkHandler = (rt: WorkerRuntime) =>
  commerceHandler(rt, 'commerce.link', processPaymentLink);
export const commerceAccountHandler = (rt: WorkerRuntime) =>
  commerceHandler(rt, 'commerce.account', processPaymentAccountCheck);

/**
 * Signals catalog reads whose job was lost (failing those older than 30 minutes) or that are a day
 * old, and Payment Links due to be created, cancelled or checked (called from the messaging sweep).
 */
export async function sweepCommerceWork(rt: WorkerRuntime): Promise<number> {
  const due = await findDueCommerceWork(rt.db);
  let signalled = 0;
  for (const item of due) {
    // Tenant ids come from the database (SECURITY DEFINER sweep query), not from a payload.
    const scope = authorizedTenantScope(item.tenantId, null);
    if (item.kind === 'sync') {
      if (!rt.graph) continue;
      await giveUpCommerceSync(rt, scope, item.ref);
      await queueDailyCommerceSync(rt, scope, item.ref);
    }
    await rt.jobs.enqueue(
      null,
      item.kind === 'sync' ? QUEUES.commerceSync.name : QUEUES.commerceLink.name,
      rt.signer.sign({
        kind: item.kind === 'sync' ? 'commerce.sync' : 'commerce.link',
        tenantId: item.tenantId,
        actorUserId: null,
        ref: item.ref,
      }),
      { singletonKey: `sweep:${item.ref}` },
    );
    signalled += 1;
  }
  return signalled;
}
