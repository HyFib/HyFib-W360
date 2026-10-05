import type { Job } from 'pg-boss';
import { QUEUES } from '@w360/contracts';
import type { TenantScope } from '@w360/db';
import {
  authorizeJob,
  findTemplateSyncsDue,
  processTemplateDelete,
  processTemplateSubmit,
  syncTemplates,
  TEMPLATE_SYNC_PRIORITY,
  type TemplateJobOutcome,
  type TemplateWorkerDeps,
} from '@w360/domain';
import type { WorkerRuntime } from '../runtime';
import { RetryableJobError } from './email';

type TemplateKind = 'template.submit' | 'template.delete' | 'template.sync';

/**
 * Template jobs: the template (or WABA) row is the source of truth and each job re-reads it under
 * the company's RLS scope. Only a connection that failed before sending is retried automatically;
 * lost responses are settled by the next sync (see templates/service).
 */
function templateHandler(
  rt: WorkerRuntime,
  kind: TemplateKind,
  run: (deps: TemplateWorkerDeps, scope: TenantScope, ref: string) => Promise<TemplateJobOutcome>,
) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: kind,
      requireActiveTenant: true,
      requireActiveActor: false,
    });
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, kind, outcome: auth.outcome }, 'template job dropped');
      return;
    }
    if (!rt.graph) throw new RetryableJobError('Meta is not configured');
    const deps = { db: rt.db, keyring: rt.keyring, graph: rt.graph, clock: rt.clock };
    const outcome = await run(deps, auth.scope, auth.envelope.ref);
    rt.logger.info({ jobId: job.id, kind, ref: auth.envelope.ref, outcome }, 'template job');
    if (outcome === 'retry')
      throw new RetryableJobError(`${kind}: provider temporarily unavailable`);
  };
}

export const templateSubmitHandler = (rt: WorkerRuntime) =>
  templateHandler(rt, 'template.submit', processTemplateSubmit);

export const templateDeleteHandler = (rt: WorkerRuntime) =>
  templateHandler(rt, 'template.delete', processTemplateDelete);

export const templateSyncHandler = (rt: WorkerRuntime) =>
  templateHandler(rt, 'template.sync', syncTemplates);

/**
 * Signals a sync for every WABA that needs one (called from the messaging sweep). One asked for
 * since its last sync (a member's refresh, or Meta's template webhook) goes before routine syncs
 * (ADR-178).
 */
export async function signalDueTemplateSyncs(rt: WorkerRuntime): Promise<number> {
  if (!rt.graph) return 0;
  const due = await findTemplateSyncsDue(rt.db);
  for (const item of due) {
    const singletonKey = `sync:${item.whatsappAccountId}`;
    // Tenant ids come from the database (SECURITY DEFINER sweep query), not from a payload.
    await rt.jobs.enqueue(
      null,
      QUEUES.templateSync.name,
      rt.signer.sign({
        kind: 'template.sync',
        tenantId: item.tenantId,
        actorUserId: null,
        ref: item.whatsappAccountId,
      }),
      {
        singletonKey,
        priority: item.requested
          ? TEMPLATE_SYNC_PRIORITY.requested
          : TEMPLATE_SYNC_PRIORITY.routine,
      },
    );
    // A routine sync queued earlier and still waiting stands for one asked for since: raised.
    if (item.requested) {
      await rt.jobs.raisePriority(
        null,
        QUEUES.templateSync.name,
        singletonKey,
        TEMPLATE_SYNC_PRIORITY.requested,
      );
    }
  }
  return due.length;
}
