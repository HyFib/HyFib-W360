import type { Job } from 'pg-boss';
import {
  READ_RECEIPT_KIND,
  TYPING_INDICATOR_KIND,
  authorizeJob,
  sendReadReceipt,
} from '@w360/domain';
import type { WorkerRuntime } from '../runtime';
import { RetryableJobError } from './email';

/**
 * Sends a read receipt or a typing indicator for a customer's message (see inbox/read-receipts).
 * The kind is read from the payload only to choose which kind the signed envelope must carry; the
 * envelope is then verified for that kind before anything is read.
 */
export function messageReadHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const claimed = (job.data as { kind?: unknown } | null)?.kind;
    const kind = claimed === TYPING_INDICATOR_KIND ? TYPING_INDICATOR_KIND : READ_RECEIPT_KIND;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: kind,
      requireActiveTenant: true,
      requireActiveActor: false,
    });
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, kind, outcome: auth.outcome }, 'read receipt job dropped');
      return;
    }
    if (!rt.graph) throw new RetryableJobError('Meta is not configured');
    const result = await sendReadReceipt(
      { db: rt.db, keyring: rt.keyring, graph: rt.graph },
      auth.scope,
      auth.envelope.ref,
      kind === TYPING_INDICATOR_KIND,
    );
    const log = { jobId: job.id, kind, messageId: auth.envelope.ref, ...result };
    if (result.outcome === 'rejected') rt.logger.warn(log, 'read receipt refused by WhatsApp');
    else rt.logger.info(log, 'read receipt');
  };
}
