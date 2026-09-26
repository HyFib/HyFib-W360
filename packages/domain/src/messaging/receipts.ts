import { sha256Hex, uuidv7, type Clock, type Keyring } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  eq,
  inArray,
  lt,
  or,
  sql,
  systemScope,
  webhookReceipts,
  type Database,
} from '@w360/db';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';

/**
 * Stores a verified webhook body durably before the provider is acknowledged. The body is encrypted
 * (AAD binds it to the receipt id) and deduplicated by SHA-256, so provider retries of the same
 * delivery never create a second receipt. Processing is signalled through the job queue inside
 * the same transaction.
 */
export const RAW_WEBHOOK_LIMIT_BYTES = 4 * 1024 * 1024;

export function receiptAad(receiptId: string): string {
  return `webhook_receipt:${receiptId}`;
}

export async function storeWebhookReceipt(
  deps: { db: Database; keyring: Keyring; jobs: JobQueue; signer: JobSigner },
  input: { provider: 'meta_whatsapp' | 'razorpay'; rawBody: Buffer; eventId?: string | null },
): Promise<{ receiptId: string; duplicate: boolean }> {
  if (input.rawBody.length > RAW_WEBHOOK_LIMIT_BYTES) throw new Error('Webhook body exceeds limit');
  const id = uuidv7();
  const hash = sha256Hex(input.rawBody);
  return deps.db.run(systemScope, async (tx) => {
    const inserted = await tx
      .insert(webhookReceipts)
      .values({
        id,
        provider: input.provider,
        bodySha256: hash,
        bodyCiphertext: deps.keyring.encrypt(input.rawBody, receiptAad(id)),
        bodySize: input.rawBody.length,
        eventId: input.eventId ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: webhookReceipts.id });
    if (inserted.length === 0) {
      const [existing] = await tx
        .select({ id: webhookReceipts.id })
        .from(webhookReceipts)
        .where(
          and(eq(webhookReceipts.provider, input.provider), eq(webhookReceipts.bodySha256, hash)),
        );
      return { receiptId: existing?.id ?? id, duplicate: true };
    }
    const queue =
      input.provider === 'meta_whatsapp'
        ? QUEUES.webhookProcess.name
        : QUEUES.billingEventProcess.name;
    const kind = input.provider === 'meta_whatsapp' ? 'webhook.process' : 'billing.event-process';
    await deps.jobs.enqueue(
      tx,
      queue,
      deps.signer.sign({ kind, tenantId: null, actorUserId: null, ref: id }),
      {
        singletonKey: id,
      },
    );
    return { receiptId: id, duplicate: false };
  });
}

/** Receipts are re-signalled by the sweeper at most this many times before operators step in. */
export const MAX_RECEIPT_ATTEMPTS = 12;

/**
 * Receipts whose processing signal was lost or whose worker died: pending or failed for over two
 * minutes, or processing with an expired lease. Receipts that exhausted their attempts are left for
 * operators (docs/RUNBOOKS.md) instead of being retried forever.
 */
export async function findStaleReceipts(
  deps: { db: Database; clock: Clock },
  limit = 500,
  provider: 'meta_whatsapp' | 'razorpay' = 'meta_whatsapp',
): Promise<string[]> {
  const now = deps.clock.now();
  const staleBefore = new Date(now.getTime() - 2 * 60_000);
  return deps.db.run(
    systemScope,
    async (tx) => {
      const rows = await tx
        .select({ id: webhookReceipts.id })
        .from(webhookReceipts)
        .where(
          and(
            eq(webhookReceipts.provider, provider),
            lt(webhookReceipts.attempts, MAX_RECEIPT_ATTEMPTS),
            or(
              and(
                inArray(webhookReceipts.status, ['pending', 'failed']),
                lt(webhookReceipts.receivedAt, staleBefore),
              ),
              and(eq(webhookReceipts.status, 'processing'), lt(webhookReceipts.leaseUntil, now)),
            ),
          ),
        )
        .orderBy(webhookReceipts.receivedAt)
        .limit(limit);
      return rows.map((r) => r.id);
    },
    { accessMode: 'read only' },
  );
}

/** Applies webhook body/row retention and prunes the live-update event log (bounded per call). */
export async function applyMessagingRetention(
  db: Database,
  limit = 1000,
): Promise<{ bodiesErased: number; receiptsDeleted: number; eventsPruned: number }> {
  return db.run(systemScope, async (tx) => {
    const receipts = await tx.execute<{ erased: number; deleted: number }>(
      sql`select erased, deleted from ops.apply_webhook_retention(${limit})`,
    );
    const events = await tx.execute<{ pruned: number }>(
      sql`select ops.prune_tenant_events(${limit}) as pruned`,
    );
    return {
      bodiesErased: receipts.rows[0]?.erased ?? 0,
      receiptsDeleted: receipts.rows[0]?.deleted ?? 0,
      eventsPruned: events.rows[0]?.pruned ?? 0,
    };
  });
}
