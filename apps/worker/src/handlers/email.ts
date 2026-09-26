import type { Job } from 'pg-boss';
import { QUEUES } from '@w360/contracts';
import { authorizeJob, findStaleOutboxRows, processEmailOutbox } from '@w360/domain';
import type { WorkerRuntime } from '../runtime';

/** Thrown to hand a job back to pg-boss for a retry with backoff. */
export class RetryableJobError extends Error {
  override name = 'RetryableJobError';
}

export function emailSendHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'email.send',
      requireActiveTenant: false,
      requireActiveActor: false,
    });
    if (auth.outcome !== 'authorized') {
      rt.logger.warn(
        { jobId: job.id, outcome: auth.outcome, reason: auth.reason },
        'email job dropped',
      );
      return;
    }
    if (!rt.email) throw new RetryableJobError('SMTP not configured');
    const result = await processEmailOutbox(
      { db: rt.db, keyring: rt.keyring, sender: rt.email, clock: rt.clock },
      auth.envelope.ref,
    );
    rt.logger.info({ jobId: job.id, outboxId: auth.envelope.ref, result }, 'email job processed');
    if (result === 'retry_scheduled') throw new RetryableJobError('transient email failure');
  };
}

/** Re-signals outbox rows whose job was lost (crash between commit and enqueue, expired lease). */
export function outboxSweepHandler(rt: WorkerRuntime) {
  return async (): Promise<void> => {
    const stale = await findStaleOutboxRows(rt);
    for (const id of stale) {
      await rt.jobs.enqueue(
        null,
        QUEUES.emailSend.name,
        rt.signer.sign({ kind: 'email.send', tenantId: null, actorUserId: null, ref: id }),
        {
          singletonKey: id,
        },
      );
    }
    if (stale.length > 0) rt.logger.info({ count: stale.length }, 'outbox sweep re-signalled rows');
  };
}
