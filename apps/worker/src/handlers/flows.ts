import type { Job } from 'pg-boss';
import { QUEUES } from '@w360/contracts';
import { authorizedTenantScope, type TenantScope } from '@w360/db';
import {
  authorizeJob,
  findDueFlowWork,
  giveUpFlowSync,
  isManagementPaused,
  processFlowKeys,
  processFlowSync,
  type FlowJobOutcome,
  type FlowWorkerDeps,
} from '@w360/domain';
import type { WorkerRuntime } from '../runtime';
import { RetryableJobError } from './email';
import { deferPausedWork } from './management-deferral';

type FlowKind = 'flow.sync' | 'flow.keys';

/**
 * WhatsApp Flows jobs: the flow (or WhatsApp account) row is the source of truth and each job
 * re-reads it under the company's RLS scope; a failure worth another attempt is retried with backoff.
 */
function flowHandler(
  rt: WorkerRuntime,
  kind: FlowKind,
  run: (deps: FlowWorkerDeps, scope: TenantScope, ref: string) => Promise<FlowJobOutcome>,
) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: kind,
      requireActiveTenant: true,
      requireActiveActor: false,
    });
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, kind, outcome: auth.outcome }, 'flow job dropped');
      return;
    }
    if (!rt.graph) throw new RetryableJobError('Meta is not configured');
    const deps: FlowWorkerDeps = {
      db: rt.db,
      keyring: rt.keyring,
      graph: rt.graph,
      clock: rt.clock,
      appBaseUrl: rt.config.APP_BASE_URL,
    };
    const outcome = await run(deps, auth.scope, auth.envelope.ref);
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
    rt.logger.info({ jobId: job.id, kind, ref: auth.envelope.ref, outcome }, 'flow job');
    if (outcome === 'retry') throw new RetryableJobError(`${kind}: Meta temporarily unavailable`);
  };
}

export const flowSyncHandler = (rt: WorkerRuntime) => flowHandler(rt, 'flow.sync', processFlowSync);
export const flowKeysHandler = (rt: WorkerRuntime) => flowHandler(rt, 'flow.keys', processFlowKeys);

/**
 * Re-signals flow operations whose job was lost (failing those pending for over 30 minutes) and
 * key work that is due (called from the messaging sweep).
 */
export async function sweepFlowWork(rt: WorkerRuntime): Promise<number> {
  if (!rt.graph) return 0;
  const due = await findDueFlowWork(rt.db);
  for (const item of due) {
    // Tenant ids come from the database (SECURITY DEFINER sweep query), not from a payload.
    if (item.kind === 'sync') {
      await giveUpFlowSync(rt, authorizedTenantScope(item.tenantId, null), item.ref);
    }
    await rt.jobs.enqueue(
      null,
      item.kind === 'sync' ? QUEUES.flowSync.name : QUEUES.flowKeys.name,
      rt.signer.sign({
        kind: item.kind === 'sync' ? 'flow.sync' : 'flow.keys',
        tenantId: item.tenantId,
        actorUserId: null,
        ref: item.ref,
      }),
      { singletonKey: `sweep:${item.ref}` },
    );
  }
  return due.length;
}
