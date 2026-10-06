import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock, uuidv7 } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import { authorizedTenantScope } from '@w360/db';
import {
  READ_RECEIPT_KIND,
  TYPING_INDICATOR_KIND,
  createContactsService,
  createInboxService,
  createReadReceiptsService,
  sendReadReceipt,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Read receipts and typing indicators (ADR-223) against real PostgreSQL and the Graph stand-in:
 * off until the company turns them on; a member opening a conversation with unread messages queues
 * one read receipt for the customer's latest message, and a member writing queues a typing
 * indicator; the job checks everything again and sends the request research M-045 gives.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx.close();
});

const receipts = () =>
  createReadReceiptsService({
    db: fx.dbs.app,
    clock: systemClock,
    jobs: fx.jobs(),
    signer: fx.signer,
  });
const inbox = () =>
  createInboxService({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });
const send = (c: Company, messageId: string, typing: boolean) =>
  sendReadReceipt(
    { db: fx.dbs.app, keyring: fx.keyring, graph: fx.graph },
    authorizedTenantScope(c.tenant.id, null),
    messageId,
    typing,
  );

/** The customer writes; returns the conversation and their message with WhatsApp's id. */
async function customerWrites(c: Company, waId: string, text: string) {
  await fx.deliver(fx.messagesBody(c, { messages: [{ waId, text }] }));
  const [row] = await fx.query<{ conversation_id: string; id: string; external_id: string }>(
    `SELECT conversation_id, id, external_message_id AS external_id FROM app.messages
      WHERE tenant_id = $1 AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1`,
    [c.tenant.id],
  );
  return { conversationId: row!.conversation_id, messageId: row!.id, externalId: row!.external_id };
}

const jobsFor = (messageId: string) =>
  fx.query<{ singleton_key: string; data: unknown }>(
    `SELECT singleton_key, data FROM pgboss.job WHERE name = $1 AND singleton_key LIKE '%:' || $2`,
    [QUEUES.messageRead.name, messageId],
  );

const readRequests = (c: Company) =>
  fx.standIn.state.requests.filter(
    (r) =>
      r.method === 'POST' &&
      r.path === `/v26.0/${c.phoneNumberId}/messages` &&
      (r.body as { status?: unknown } | null)?.status === 'read',
  );

describe('read receipts and typing indicators (ADR-223)', () => {
  it('marks the customer’s latest message read when a member opens the conversation, once turned on', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const first = await customerWrites(c, '919845003001', 'Hello?');

    // Off by default: opening the conversation queues nothing.
    expect(await receipts().getSettings(owner)).toEqual({ enabled: false });
    await inbox().markRead(owner, first.conversationId);
    expect(await jobsFor(first.messageId)).toEqual([]);

    await receipts().updateSettings(owner, { enabled: true });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'inbox.read_receipts_updated'`,
      [c.tenant.id],
    );
    expect(audit!.metadata).toEqual({ enabled: true });

    // The customer writes again: opening the conversation queues one receipt for that message.
    const second = await customerWrites(c, '919845003001', 'Anyone there?');
    expect(second.conversationId).toBe(first.conversationId);
    await inbox().markRead(owner, second.conversationId);
    const jobs = await jobsFor(second.messageId);
    expect(jobs.map((j) => j.singleton_key)).toEqual([`${READ_RECEIPT_KIND}:${second.messageId}`]);
    expect(fx.signer.verify(jobs[0]!.data)).toMatchObject({
      kind: READ_RECEIPT_KIND,
      tenantId: c.tenant.id,
      actorUserId: null,
      ref: second.messageId,
    });
    // Nothing unread any more: opening it again queues nothing new.
    await inbox().markRead(owner, second.conversationId);
    expect(await jobsFor(second.messageId)).toHaveLength(1);

    // The job sends Meta's read receipt with the account's token, without a typing indicator.
    expect(await send(c, second.messageId, false)).toEqual({ outcome: 'sent' });
    const [request] = readRequests(c);
    expect(request).toMatchObject({ authorization: `Bearer ${c.token}` });
    expect(request!.body).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: second.externalId,
    });
  });

  it('shows a typing indicator while a member who can reply writes inside the window', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const message = await customerWrites(c, '919845003101', 'Can you help?');
    expect(await receipts().showTyping(owner, message.conversationId)).toBe('off');

    await receipts().updateSettings(owner, { enabled: true });
    expect(await receipts().showTyping(owner, message.conversationId)).toBe('queued');
    const [job] = await jobsFor(message.messageId);
    expect(job!.singleton_key).toBe(`${TYPING_INDICATOR_KIND}:${message.messageId}`);
    expect(fx.signer.verify(job!.data)).toMatchObject({ kind: TYPING_INDICATOR_KIND });
    expect(await send(c, message.messageId, true)).toEqual({ outcome: 'sent' });
    expect(readRequests(c).pop()!.body).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: message.externalId,
      typing_indicator: { type: 'text' },
    });

    // Who may: a marketer has no inbox; another company does not see the conversation.
    await expect(
      receipts().showTyping(await fx.ctx(c, c.marketer), message.conversationId),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const d = await fx.company();
    await expect(
      receipts().showTyping(await fx.ctx(d, d.owner), message.conversationId),
    ).rejects.toMatchObject({ code: 'not_found' });

    // Outside the window, no indicator.
    await fx.query(
      `UPDATE app.conversations SET last_inbound_at = now() - interval '25 hours' WHERE id = $1`,
      [message.conversationId],
    );
    expect(await receipts().showTyping(owner, message.conversationId)).toBe('window_closed');
  });

  it('checks again when the job runs, and reports what Meta refused', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const message = await customerWrites(c, '919845003201', 'Status of my order?');
    const before = readRequests(c).length;

    // Turned off after the job was queued: nothing is sent.
    expect(await send(c, message.messageId, false)).toEqual({ outcome: 'off' });
    await receipts().updateSettings(owner, { enabled: true });

    // Meta refuses: the job says so; a failure worth trying again is thrown for a read receipt,
    // and only reported for a typing indicator, which would show late.
    fx.standIn.state.readError = { status: 400, code: 100, message: 'Invalid parameter' };
    expect(await send(c, message.messageId, false)).toMatchObject({ outcome: 'rejected' });
    fx.standIn.state.readError = {
      status: 503,
      code: 2,
      message: 'Service temporarily unavailable',
    };
    await expect(send(c, message.messageId, false)).rejects.toThrow(/read receipt/);
    expect(await send(c, message.messageId, true)).toMatchObject({ outcome: 'rejected' });
    fx.standIn.state.readError = null;

    // No such message of the company, or an erased contact's: nothing is sent.
    expect(await send(c, uuidv7(), false)).toEqual({ outcome: 'not_found' });
    expect(await send(c, 'not-an-id', false)).toEqual({ outcome: 'not_found' });
    const [contact] = await fx.query<{ contact_id: string }>(
      'SELECT contact_id FROM app.conversations WHERE id = $1',
      [message.conversationId],
    );
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: contact!.contact_id,
      suppress: false,
    });
    expect(await send(c, message.messageId, false)).toEqual({ outcome: 'contact_erased' });
    // Only the three refused attempts reached Meta.
    expect(readRequests(c).length - before).toBe(3);
  });
});
