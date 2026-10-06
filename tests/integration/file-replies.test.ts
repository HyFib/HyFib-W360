import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock, uuidv7 } from '@w360/core';
import { authorizedTenantScope } from '@w360/db';
import {
  authenticateApiToken,
  createApiKeysService,
  createFileRepliesService,
  createReceivedMediaService,
  processSendIntent,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Files members send from the inbox (ADR-218) against real PostgreSQL and the Graph stand-in:
 * checked as a text reply is, uploaded for the conversation's number with its account's token,
 * queued as a reply naming the media and sent as Meta's spec sends media by id; refused before the
 * upload when the reply could not be sent.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx.close();
});

const service = () =>
  createFileRepliesService({
    db: fx.dbs.app,
    jobs: fx.jobs(),
    signer: fx.signer,
    clock: systemClock,
    keyring: fx.keyring,
    graph: fx.graph,
  });

const uploads = (c: Company) =>
  fx.standIn.state.requests.filter(
    (r) => r.method === 'POST' && r.path === `/v26.0/${c.phoneNumberId}/media`,
  );

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** A conversation the customer opened by writing, so its window is open. */
async function conversationWith(c: Company, waId: string) {
  await fx.deliver(fx.messagesBody(c, { messages: [{ waId, text: 'Please send the invoice' }] }));
  const [row] = await fx.query<{ conversation_id: string }>(
    `SELECT conversation_id FROM app.messages WHERE tenant_id = $1 AND type = 'text'
      ORDER BY created_at DESC LIMIT 1`,
    [c.tenant.id],
  );
  return row!.conversation_id;
}

const bytesOf = (text: string) => new Uint8Array(Buffer.from(text));

describe('files members send from the inbox (ADR-218)', () => {
  it('uploads a document for the number, queues it as a reply naming the media, and sends it once', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const waId = '919845000501';
    const conversationId = await conversationWith(c, waId);
    const pdf = bytesOf('%PDF-1.4 invoice');

    const sent = await service().queueFileReply(
      owner,
      { conversationId, clientKey: 'file-invoice-1', caption: '  Your invoice  ' },
      { name: 'Invoice "Oct".pdf', type: 'application/pdf', bytes: pdf },
    );
    expect(sent.duplicate).toBe(false);
    // Uploaded once, for the conversation's number, with the account's token.
    const [upload] = uploads(c);
    expect(uploads(c)).toHaveLength(1);
    expect(upload).toMatchObject({
      authorization: `Bearer ${c.token}`,
      body: {
        messaging_product: 'whatsapp',
        file: { filename: 'Invoice Oct .pdf', type: 'application/pdf' },
      },
    });
    expect(
      Buffer.from((upload!.body as { file: { base64: string } }).file.base64, 'base64').toString(),
    ).toBe('%PDF-1.4 invoice');
    const mediaId = [...fx.standIn.state.media.keys()].pop()!;

    const [message] = await fx.query<{
      type: string;
      direction: string;
      sender_type: string;
      content: Record<string, unknown>;
      request: Record<string, unknown>;
      preview: string;
    }>(
      `SELECT m.type, m.direction, m.sender_type, m.content, si.request,
              cv.last_message_preview AS preview
         FROM app.messages m
         JOIN app.send_intents si ON si.tenant_id = m.tenant_id AND si.message_id = m.id
         JOIN app.conversations cv ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
        WHERE m.id = $1`,
      [sent.messageId],
    );
    const media = { id: mediaId, caption: 'Your invoice', filename: 'Invoice Oct .pdf' };
    expect(message).toEqual({
      type: 'document',
      direction: 'outbound',
      sender_type: 'agent',
      content: { ...media, mime_type: 'application/pdf' },
      request: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: waId,
        type: 'document',
        document: media,
      },
      preview: 'Your invoice',
    });
    expect(
      await fx.query(
        'SELECT provider_media_id, mime_type, filename, size_bytes FROM app.media_objects WHERE message_id = $1',
        [sent.messageId],
      ),
    ).toEqual([
      {
        provider_media_id: mediaId,
        mime_type: 'application/pdf',
        filename: 'Invoice Oct .pdf',
        size_bytes: String(pdf.byteLength),
      },
    ]);

    // A retry of the same submission answers the first message without uploading again.
    expect(
      await service().queueFileReply(
        owner,
        { conversationId, clientKey: 'file-invoice-1', caption: 'Your invoice' },
        { name: 'Invoice "Oct".pdf', type: 'application/pdf', bytes: pdf },
      ),
    ).toEqual({ messageId: sent.messageId, duplicate: true });
    expect(uploads(c)).toHaveLength(1);

    // The worker sends it as the spec sends a document by id, and Meta accepts it.
    const [intent] = await fx.query<{ id: string }>(
      'SELECT id FROM app.send_intents WHERE message_id = $1',
      [sent.messageId],
    );
    const result = await processSendIntent(
      {
        db: fx.dbs.app,
        keyring: fx.keyring,
        graph: fx.graph,
        clock: systemClock,
        rate: { capacity: 80, refillPerSecond: 80 },
        jobs: fx.jobs(),
        signer: fx.signer,
      },
      authorizedTenantScope(c.tenant.id, null),
      intent!.id,
    );
    expect(result.outcome).toBe('accepted');
    const send = fx.standIn.state.requests
      .filter((r) => r.path === `/v26.0/${c.phoneNumberId}/messages`)
      .pop();
    expect(send?.body).toMatchObject({ type: 'document', document: media, to: waId });

    // Members open the file they sent; keys get only customers' files.
    const received = createReceivedMediaService({
      db: fx.dbs.app,
      keyring: fx.keyring,
      graph: fx.graph,
    });
    const file = await received.openReceivedMedia(owner, conversationId, sent.messageId);
    expect(file).toMatchObject({ disposition: 'attachment', filename: 'Invoice Oct .pdf' });
    expect((await readAll(file.body)).toString()).toBe('%PDF-1.4 invoice');
    const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
    const created = await keys.create(owner, {
      name: 'Reader',
      scopes: ['conversations.read'],
      expiresInDays: 0,
    });
    const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    await expect(received.openReceivedMediaForKey(key!, sent.messageId)).rejects.toMatchObject({
      code: 'not_found',
      details: { apiReason: 'no_file' },
    });

    // A photo goes as an image; a recording drops the caption WhatsApp would not show.
    const photo = await service().queueFileReply(
      owner,
      { conversationId, clientKey: 'file-photo-1' },
      { name: 'shelf.jpg', type: 'image/jpeg', bytes: new Uint8Array(randomBytes(64)) },
    );
    const voice = await service().queueFileReply(
      owner,
      { conversationId, clientKey: 'file-voice-1', caption: 'Listen' },
      { name: 'note.ogg', type: 'audio/ogg; codecs=opus', bytes: new Uint8Array(randomBytes(64)) },
    );
    const requests = await fx.query<{ message_id: string; request: Record<string, unknown> }>(
      'SELECT message_id, request FROM app.send_intents WHERE message_id = ANY($1::uuid[])',
      [[photo.messageId, voice.messageId]],
    );
    const requestOf = (id: string) => requests.find((r) => r.message_id === id)!.request;
    expect(requestOf(photo.messageId)).toMatchObject({
      type: 'image',
      image: { id: expect.any(String) as unknown as string },
    });
    expect(requestOf(voice.messageId)).toMatchObject({ type: 'audio' });
    expect(requestOf(voice.messageId).audio).toEqual({ id: expect.any(String) as unknown });
  });

  it('refuses a file that cannot be sent, before uploading it', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const conversationId = await conversationWith(c, '919845000601');
    const send = (
      input: Record<string, unknown>,
      file: { name: string; type: string; bytes: Uint8Array<ArrayBuffer> },
      who = owner,
    ) =>
      service().queueFileReply(
        who,
        { conversationId, clientKey: `file-${uuidv7()}`, ...input },
        file,
      );
    const pdf = { name: 'a.pdf', type: 'application/pdf', bytes: bytesOf('%PDF-1.4') };

    for (const [file, message] of [
      [{ ...pdf, bytes: new Uint8Array(0) }, 'Choose a file to send.'],
      [{ ...pdf, bytes: new Uint8Array(16 * 1024 * 1024 + 1) }, 'Files are limited to 16 MB.'],
      [{ ...pdf, type: 'image/gif' }, expect.stringContaining('Send a JPEG or PNG photo')],
      [{ ...pdf, type: 'text/html' }, expect.stringContaining('Send a JPEG or PNG photo')],
    ] as const) {
      await expect(send({}, file)).rejects.toMatchObject({
        code: 'validation_failed',
        publicMessage: message,
        issues: [{ path: 'file' }],
      });
    }
    await expect(send({ caption: 'x'.repeat(1025) }, pdf)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    // A member who cannot reply, and an agent who cannot see the conversation.
    const marketer = await fx.ctx(c, c.marketer);
    await expect(send({}, pdf, marketer)).rejects.toMatchObject({ code: 'forbidden' });
    const [ownerMembership] = await fx.query<{ id: string }>(
      'SELECT id FROM app.memberships WHERE tenant_id = $1 AND user_id = $2',
      [c.tenant.id, c.owner.id],
    );
    await fx.query('UPDATE app.conversations SET assigned_membership_id = $1 WHERE id = $2', [
      ownerMembership!.id,
      conversationId,
    ]);
    await expect(send({}, pdf, await fx.ctx(c, c.agent))).rejects.toMatchObject({
      code: 'not_found',
    });
    // The window closed.
    await fx.query(
      `UPDATE app.conversations SET last_inbound_at = now() - interval '25 hours' WHERE id = $1`,
      [conversationId],
    );
    await expect(send({}, pdf)).rejects.toMatchObject({
      code: 'precondition_failed',
      publicMessage: expect.stringContaining('24-hour') as unknown as string,
    });
    expect(uploads(c)).toHaveLength(0);
    expect(
      await fx.query(
        `SELECT 1 FROM app.messages WHERE conversation_id = $1 AND direction = 'outbound'`,
        [conversationId],
      ),
    ).toEqual([]);

    // Meta refuses the upload, or the account's token: nothing is queued.
    await fx.query(`UPDATE app.conversations SET last_inbound_at = now() WHERE id = $1`, [
      conversationId,
    ]);
    fx.standIn.state.uploadError = { status: 400, code: 131053, message: 'Media upload error' };
    await expect(send({}, pdf)).rejects.toMatchObject({
      code: 'provider_rejected',
      publicMessage: 'WhatsApp did not accept the file: Media upload error',
    });
    fx.standIn.state.uploadError = null;
    fx.standIn.state.tokens.set(c.token, { appId: '1000000000001', valid: false, scopes: [] });
    await expect(send({}, pdf)).rejects.toMatchObject({ code: 'precondition_failed' });
    expect(
      await fx.query(
        `SELECT 1 FROM app.messages WHERE conversation_id = $1 AND direction = 'outbound'`,
        [conversationId],
      ),
    ).toEqual([]);
  });
});
