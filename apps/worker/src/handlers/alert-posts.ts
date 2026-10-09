import type { Job } from 'pg-boss';
import { sendAlertPosts } from '@w360/domain';
import type { WorkerRuntime } from '../runtime';

/**
 * Sends the operations alerts' posts to the platform's chat channel (ADR-338): every minute, and
 * when an alert or a test post is queued. The posts due are claimed from the database, so the job's
 * payload is not read. Logs post ids, kinds, statuses and error codes only: never the channel's
 * address nor a post's text.
 */
export function alertPostsHandler(rt: WorkerRuntime) {
  return async (_jobs: Job<unknown>[]): Promise<void> => {
    const result = await sendAlertPosts({
      db: rt.db,
      keyring: rt.keyring,
      egress: rt.alertEgress,
    });
    if (result.unopenable !== null) {
      rt.logger.error(
        { reason: result.unopenable },
        'the chat channel’s address does not open with the configured keys; its posts are tried again (check W360_ENCRYPTION_KEYS)',
      );
    }
    for (const post of result.failed) {
      rt.logger.warn(
        { postId: post.id, kind: post.kind, status: post.status, error: post.error },
        'an alert post to the chat channel failed for good',
      );
    }
    if (result.claimed + result.purged > 0) {
      const { claimed, sent, retrying, purged } = result;
      rt.logger.info(
        { claimed, sent, retrying, failed: result.failed.length, purged },
        'alert posts',
      );
    }
  };
}
