import { QUEUES, type QueueName } from '@w360/contracts';
import { deferPausedJob } from '@w360/domain';
import type { WorkerRuntime } from '../runtime';
import { RetryableJobError } from './email';

/**
 * Where each paced job kind goes when Meta throttles its account's management calls (ADR-399):
 * its own queue, to run again just after the pause, or null for a template sync, which stays due
 * and which the minute sweep signals again once the pause ends.
 */
export const PAUSE_DEFERRAL_QUEUES = {
  'template.submit': QUEUES.templateSubmit.name,
  'template.delete': QUEUES.templateDelete.name,
  'template.sync': null,
  'flow.sync': QUEUES.flowSync.name,
  'flow.keys': QUEUES.flowKeys.name,
  'commerce.sync': QUEUES.commerceSync.name,
  'channel.onboard': QUEUES.channelOnboard.name,
} as const satisfies Record<string, QueueName | null>;

export type PacedJobKind = keyof typeof PAUSE_DEFERRAL_QUEUES;

/**
 * Handles a job whose work Meta's pause deferred: nothing failed, so no retry is spent. The job is
 * queued again for just after the pause (signed as before, keyed by this job's id); when nothing
 * could be queued the job fails with `RetryableJobError`, so pg-boss retries it and the deferral is
 * never silently lost. A kind without pacing that reports a pause is a programming error.
 */
export async function deferPausedWork(
  rt: Pick<WorkerRuntime, 'jobs' | 'signer' | 'logger'>,
  work: {
    jobId: string;
    kind: string;
    tenantId: string;
    actorUserId: string | null;
    ref: string;
    pausedUntil: Date;
  },
): Promise<void> {
  if (!Object.hasOwn(PAUSE_DEFERRAL_QUEUES, work.kind)) {
    throw new Error(`${work.kind} is not paced by Meta's usage header`);
  }
  const queue = PAUSE_DEFERRAL_QUEUES[work.kind as PacedJobKind];
  const resumeAt =
    queue === null
      ? null
      : await deferPausedJob(
          rt,
          queue,
          {
            kind: work.kind,
            tenantId: work.tenantId,
            actorUserId: work.actorUserId,
            ref: work.ref,
          },
          work.pausedUntil,
          work.jobId,
        );
  if (queue !== null && resumeAt === null) {
    throw new RetryableJobError(`${work.kind}: the job deferred for Meta's pause was not queued`);
  }
  rt.logger.info(
    {
      jobId: work.jobId,
      kind: work.kind,
      ref: work.ref,
      pausedUntil: work.pausedUntil,
      resumeAt,
    },
    queue === null
      ? 'job deferred: Meta is limiting management requests; the sweep signals it after the pause'
      : 'job deferred: Meta is limiting management requests; queued for after the pause',
  );
}
