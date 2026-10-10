import type { Job } from 'pg-boss';
import { countMessageDays } from '@w360/domain';
import type { WorkerRuntime } from '../runtime';

/**
 * Counts the platform's messages a day kept for the Usage tab's year (ADR-341): every minute, a few
 * days a run, after deleting the counts kept past their time. The days due are read from the
 * database, so the job's payload is not read. Logs how many days it counted and how many company
 * days it deleted, when either is any: never a company or a message.
 */
export function messageDaysHandler(rt: WorkerRuntime) {
  return async (_jobs: Job<unknown>[]): Promise<void> => {
    const { purged, counted } = await countMessageDays({ db: rt.db });
    if (counted > 0 || purged > 0) {
      rt.logger.info({ days: counted, purged }, 'messages a day counted');
    }
  };
}
