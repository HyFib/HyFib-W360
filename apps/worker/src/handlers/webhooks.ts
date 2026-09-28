import type { Job } from 'pg-boss';
import {
  authorizeJob,
  dispatchDueWebhooks,
  processWebhookDeliveries,
  purgeWebhookData,
} from '@w360/domain';
import type { WorkerRuntime } from '../runtime';

/**
 * Delivers one company's due webhook deliveries (see webhooks/delivery). Every attempt is recorded
 * on its delivery, so a duplicate or retried job repeats nothing that finished; logs carry counts,
 * never URLs, payloads or secrets.
 */
export function webhookDeliverHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'webhook.deliver',
      requireActiveTenant: true,
      requireActiveActor: false,
    });
    if (auth.outcome === 'deferred') {
      // Suspended or restricted company: deliveries wait; the sweep wakes it once it is active.
      rt.logger.info({ jobId: job.id }, 'webhook delivery deferred');
      return;
    }
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'webhook delivery job dropped');
      return;
    }
    const run = await processWebhookDeliveries(
      {
        db: rt.db,
        clock: rt.clock,
        keyring: rt.keyring,
        jobs: rt.jobs,
        signer: rt.signer,
        egress: rt.egress,
        timeoutMs: rt.egressPolicy.timeoutMs,
        notices: rt.notices,
      },
      auth.scope,
    );
    if (run.attempted + run.failed > 0) {
      rt.logger.info(
        { jobId: job.id, tenantId: auth.scope.tenantId, ...run },
        'webhooks delivered',
      );
    }
  };
}

/**
 * Wakes delivery for companies with due deliveries (retries, interrupted attempts, missed
 * notifications) and applies webhook retention. Called from the per-minute messaging sweep.
 */
export async function sweepWebhooks(rt: WorkerRuntime): Promise<{ woken: number; purged: number }> {
  const woken = await dispatchDueWebhooks(rt);
  const purged = await purgeWebhookData(rt.db);
  return { woken, purged };
}
