import { toError } from '@w360/core';
import type { WorkerRuntime } from './runtime';

/**
 * Logs a job attempt whose handler threw, then rethrows so pg-boss records the failure (it retries
 * the job and, after the queue's retry limit, moves it to the dead-letter queue). pg-boss itself
 * logs nothing for a failed attempt, so without this a job that keeps failing is silent.
 */
export function logFailures<J extends { id: string }>(
  rt: Pick<WorkerRuntime, 'logger'>,
  queue: string,
  handler: (jobs: J[]) => Promise<void>,
): (jobs: J[]) => Promise<void> {
  return async (jobs) => {
    try {
      await handler(jobs);
    } catch (error) {
      rt.logger.warn(
        { queue, jobIds: jobs.map((job) => job.id), err: toError(error) },
        'job attempt failed',
      );
      throw error;
    }
  };
}
