import type { JobWithMetadata } from 'pg-boss';
import { deadLetterJob, recordDeadLetters } from '@w360/domain';
import type { WorkerRuntime } from '../runtime';

/**
 * `dead-letter`: records each job that failed all its retries in ops.dead_letters (ADR-054) so
 * platform staff see it in the operations console. The job then completes; pg-boss keeps it, with
 * its full output, for the queue's retention.
 */
export function deadLetterHandler(rt: WorkerRuntime) {
  return async (jobs: JobWithMetadata<unknown>[]): Promise<void> => {
    if (jobs.length === 0) return;
    const recorded = await recordDeadLetters(rt, jobs.map(deadLetterJob));
    rt.logger.warn(
      { recorded, queues: [...new Set(jobs.map((job) => job.sourceName ?? 'unknown'))] },
      'dead letters recorded',
    );
  };
}
