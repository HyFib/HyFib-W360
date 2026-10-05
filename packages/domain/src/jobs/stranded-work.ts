import type { Clock } from '@w360/core';
import { authorizedTenantScope, sql, systemScope, type Database, type Tx } from '@w360/db';
import { settlePaymentAccountCheck } from '../commerce/worker';
import { settleChannelOnboarding } from '../messaging/onboarding';
import { settleTemplateDeletion } from '../templates/service';

/**
 * Work left in progress when its job ran out of retries (ADR-111): a number's setup, the check of a
 * company's Razorpay keys and a template deletion. The minute sweep settles each one's work in its
 * company's scope and marks the dead letter in the same transaction, unless a job for the same work
 * is waiting or running again. The company and the work come from the dead letter, which the worker
 * recorded from the envelope it verified.
 */
export const STRANDED_WORK_QUEUES = [
  'channel.onboard',
  'commerce.account',
  'template.delete',
] as const;
export type StrandedWorkQueue = (typeof STRANDED_WORK_QUEUES)[number];

export interface StrandedWork {
  deadLetterId: string;
  queue: StrandedWorkQueue;
  tenantId: string;
  /** The envelope's reference: the number, payment account or template. */
  ref: string;
}

export type StrandedWorkOutcome = 'ended' | 'nothing_left' | 'skipped';

export interface StrandedWorkResult {
  /** Work ended for its company. */
  ended: number;
  /** Dead letters whose work had finished, failed or been started again and done meanwhile. */
  nothingLeft: number;
  /** Dead letters left alone: retried or settled meanwhile, or their work is being done again. */
  skipped: number;
  failed: { deadLetterId: string; error: unknown }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const END_WORK: Record<
  StrandedWorkQueue,
  (tx: Tx, tenantId: string, ref: string, at: Date) => Promise<boolean>
> = {
  'channel.onboard': (tx, tenantId, ref) => settleChannelOnboarding(tx, tenantId, ref),
  'commerce.account': settlePaymentAccountCheck,
  'template.delete': settleTemplateDeletion,
};

/** Dead letters whose work the sweep settles, oldest first (`ops.dead_letters_to_settle`). */
export async function findStrandedWork(db: Database, limit = 50): Promise<StrandedWork[]> {
  const res = await db.run(
    systemScope,
    (tx) =>
      tx.execute<{
        dead_letter_id: string;
        source_queue: StrandedWorkQueue;
        tenant_id: string;
        ref: string;
      }>(
        sql`select dead_letter_id, source_queue, tenant_id, ref from ops.dead_letters_to_settle(${limit})`,
      ),
    { accessMode: 'read only' },
  );
  return res.rows.map((r) => ({
    deadLetterId: r.dead_letter_id,
    queue: r.source_queue,
    tenantId: r.tenant_id,
    ref: r.ref,
  }));
}

class LeftAlone extends Error {}

/**
 * Settles one dead letter's work in its company's scope. When the dead letter was retried or settled
 * meanwhile, or a job for its work is waiting or running again, the transaction is rolled back, so
 * work a job is doing is never ended under it.
 */
export async function settleDeadLetterWork(
  deps: { db: Database; clock: Clock },
  work: StrandedWork,
): Promise<StrandedWorkOutcome> {
  const scope = authorizedTenantScope(work.tenantId, null);
  try {
    return await deps.db.run(scope, async (tx) => {
      // Signed references of these jobs are record ids; anything else names no record.
      const ended = UUID.test(work.ref)
        ? await END_WORK[work.queue](tx, work.tenantId, work.ref, deps.clock.now())
        : false;
      const res = await tx.execute<{ settled: boolean }>(
        sql`select ops.settle_dead_letter(${work.deadLetterId}::uuid, ${ended}) as settled`,
      );
      if (res.rows[0]?.settled !== true) throw new LeftAlone();
      return ended ? 'ended' : 'nothing_left';
    });
  } catch (error) {
    if (error instanceof LeftAlone) return 'skipped';
    throw error;
  }
}

/** The minute sweep's part: one dead letter's failure does not hold up the others. */
export async function settleStrandedWork(
  deps: { db: Database; clock: Clock },
  limit = 50,
): Promise<StrandedWorkResult> {
  const result: StrandedWorkResult = { ended: 0, nothingLeft: 0, skipped: 0, failed: [] };
  for (const work of await findStrandedWork(deps.db, limit)) {
    try {
      const outcome = await settleDeadLetterWork(deps, work);
      if (outcome === 'ended') result.ended += 1;
      else if (outcome === 'nothing_left') result.nothingLeft += 1;
      else result.skipped += 1;
    } catch (error) {
      result.failed.push({ deadLetterId: work.deadLetterId, error });
    }
  }
  return result;
}
