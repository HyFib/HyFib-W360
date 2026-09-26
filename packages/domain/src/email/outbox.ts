import { uuidv7, type Keyring } from '@w360/core';
import { emailOutbox, type Tx } from '@w360/db';
import { QUEUES } from '@w360/contracts';
import type { JobQueue } from '../jobs/queue';
import type { JobSigner } from '../jobs/envelope';
import { emailPayloadSchema, type EmailPayload } from './templates';

/**
 * Enqueues a transactional email durably inside the caller's transaction. The payload (which may
 * contain one-time links) is encrypted with the application keyring and bound to the outbox row id
 * through AAD; the worker clears it after delivery.
 */
export interface OutboxDeps {
  keyring: Keyring;
  jobs: JobQueue;
  signer: JobSigner;
}

export function outboxAad(outboxId: string): string {
  return `email_outbox:${outboxId}`;
}

export async function enqueueEmail(
  deps: OutboxDeps,
  tx: Tx,
  input: { to: string; payload: EmailPayload; tenantId?: string | null; dedupeKey?: string },
): Promise<string> {
  const payload = emailPayloadSchema.parse(input.payload);
  const id = uuidv7();
  await tx.insert(emailOutbox).values({
    id,
    tenantId: input.tenantId ?? null,
    kind: payload.kind,
    toAddress: input.to,
    payloadCiphertext: deps.keyring.encrypt(JSON.stringify(payload), outboxAad(id)),
    dedupeKey: input.dedupeKey ?? null,
  });
  await deps.jobs.enqueue(
    tx,
    QUEUES.emailSend.name,
    deps.signer.sign({ kind: 'email.send', tenantId: input.tenantId ?? null, actorUserId: null, ref: id }),
    { singletonKey: id },
  );
  return id;
}
