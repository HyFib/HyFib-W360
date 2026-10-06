import type { Job } from 'pg-boss';
import { authorizeJob, sendMentionEmail } from '@w360/domain';
import type { WorkerRuntime } from '../runtime';

/**
 * Emails a member mentioned in a note who has not opened it (see inbox/mention-emails). The
 * mention row decides: one read, gone, out of the member's sight or followed by a newer mention is
 * not emailed, and a job run again finds its email already queued.
 */
export function noteMentionHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'note.mention',
      requireActiveTenant: true,
      requireActiveActor: false,
    });
    if (auth.outcome === 'deferred') {
      // Suspended company: no email for this mention; the inbox still shows it as unread.
      rt.logger.info({ jobId: job.id, mentionId: auth.envelope.ref }, 'mention email deferred');
      return;
    }
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'mention email job dropped');
      return;
    }
    const outcome = await sendMentionEmail(
      { db: rt.db, clock: rt.clock, outbox: rt.notices.outbox, appBaseUrl: rt.notices.appBaseUrl },
      auth.scope,
      auth.envelope.ref,
    );
    rt.logger.info({ jobId: job.id, mentionId: auth.envelope.ref, outcome }, 'mention email');
  };
}
