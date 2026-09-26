import { and, emailOutbox, eq, inArray, lt, or, sql, systemScope, type Database } from '@w360/db';
import type { Clock, Keyring } from '@w360/core';
import { outboxAad } from './outbox';
import { EmailSendError, type EmailSender } from './sender';
import { emailPayloadSchema, renderEmail } from './templates';

/**
 * Delivers one outbox email. Uses a short claim transaction (status -> sending with a lease)
 * instead of holding a row lock across the SMTP round trip. A crash after the provider accepted
 * the message but before we recorded it leads to a duplicate on retry: delivery is at-least-once,
 * which is acceptable for transactional notices and documented in docs/RUNBOOKS.md.
 */
export const EMAIL_MAX_ATTEMPTS = 12;
const LEASE_MS = 2 * 60_000;

export type EmailProcessResult = 'sent' | 'not_claimable' | 'failed_permanent' | 'retry_scheduled';

export async function processEmailOutbox(
  deps: { db: Database; keyring: Keyring; sender: EmailSender; clock: Clock },
  outboxId: string,
): Promise<EmailProcessResult> {
  const now = deps.clock.now();
  const claimed = await deps.db.run(systemScope, async (tx) => {
    const rows = await tx
      .update(emailOutbox)
      .set({ status: 'sending', lockedUntil: new Date(now.getTime() + LEASE_MS), attempts: sql`${emailOutbox.attempts} + 1` })
      .where(
        and(
          eq(emailOutbox.id, outboxId),
          or(
            eq(emailOutbox.status, 'pending'),
            and(eq(emailOutbox.status, 'sending'), lt(emailOutbox.lockedUntil, now)),
          ),
        ),
      )
      .returning();
    return rows[0];
  });
  if (!claimed) return 'not_claimable';

  const finish = async (values: Partial<typeof emailOutbox.$inferInsert>) => {
    await deps.db.run(systemScope, async (tx) => {
      await tx
        .update(emailOutbox)
        .set({ ...values, lockedUntil: null })
        .where(and(eq(emailOutbox.id, outboxId), eq(emailOutbox.status, 'sending')));
    });
  };

  let rendered;
  try {
    if (!claimed.payloadCiphertext) throw new Error('payload missing');
    const payload = emailPayloadSchema.parse(JSON.parse(deps.keyring.decryptString(claimed.payloadCiphertext, outboxAad(claimed.id))));
    rendered = renderEmail(payload);
  } catch {
    await finish({ status: 'failed', lastError: 'payload could not be decrypted or validated', payloadCiphertext: null });
    return 'failed_permanent';
  }

  try {
    const result = await deps.sender.send({ to: claimed.toAddress, ...rendered });
    await finish({ status: 'sent', sentAt: deps.clock.now(), providerMessageId: result.providerMessageId, payloadCiphertext: null, lastError: null });
    return 'sent';
  } catch (error) {
    const permanent = error instanceof EmailSendError && error.permanent;
    const exhausted = claimed.attempts >= EMAIL_MAX_ATTEMPTS;
    const message = error instanceof Error ? error.message.slice(0, 500) : 'send failed';
    if (permanent || exhausted) {
      await finish({ status: 'failed', lastError: permanent ? `permanent: ${message}` : `attempts exhausted: ${message}`, payloadCiphertext: null });
      return 'failed_permanent';
    }
    const backoffMs = Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, claimed.attempts - 1));
    await finish({ status: 'pending', lastError: message, nextAttemptAt: new Date(deps.clock.now().getTime() + backoffMs) });
    return 'retry_scheduled';
  }
}

/** Outbox rows that should have been processed but have no live job (lost signal or expired lease). */
export async function findStaleOutboxRows(deps: { db: Database; clock: Clock }, limit = 500): Promise<string[]> {
  const now = deps.clock.now();
  const staleBefore = new Date(now.getTime() - 60_000);
  return deps.db.run(
    systemScope,
    async (tx) => {
      const rows = await tx
        .select({ id: emailOutbox.id })
        .from(emailOutbox)
        .where(
          or(
            and(eq(emailOutbox.status, 'pending'), lt(emailOutbox.nextAttemptAt, staleBefore)),
            and(inArray(emailOutbox.status, ['sending']), lt(emailOutbox.lockedUntil, now)),
          ),
        )
        .limit(limit);
      return rows.map((r) => r.id);
    },
    { accessMode: 'read only' },
  );
}
