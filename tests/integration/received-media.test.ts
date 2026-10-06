import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock, uuidv7 } from '@w360/core';
import {
  authenticateApiToken,
  createApiKeysService,
  createContactsService,
  createReceivedMediaService,
  type ApiScope,
} from '@w360/domain';
import {
  nextExternalId,
  startWhatsAppFixture,
  type Company,
  type WhatsAppFixture,
} from './whatsapp-fixture';

/**
 * Files customers send (ADR-216) against real PostgreSQL and the Graph stand-in: fetched for a
 * member who can see the conversation, with the token of the account that received it, and passed
 * on as they arrive; refused with a reason when the member, the message, the account or WhatsApp
 * cannot give one.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx.close();
});

const service = () =>
  createReceivedMediaService({ db: fx.dbs.app, keyring: fx.keyring, graph: fx.graph });

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** A file the customer sends: kept by the stand-in, delivered in a webhook, found in the inbox. */
async function receive(
  c: Company,
  waId: string,
  type: string,
  fields: Record<string, unknown>,
  file: { bytes: Buffer; mimeType: string } | null,
) {
  const mediaId = nextExternalId();
  if (file) fx.standIn.state.media.set(mediaId, file);
  const externalId = `wamid.in.${randomBytes(6).toString('hex')}`;
  await fx.deliver(
    fx.messagesBody(c, {
      messages: [{ id: externalId, waId, type, extra: { [type]: { id: mediaId, ...fields } } }],
    }),
  );
  const [row] = await fx.query<{ id: string; conversation_id: string }>(
    'SELECT id, conversation_id FROM app.messages WHERE tenant_id = $1 AND external_message_id = $2',
    [c.tenant.id, externalId],
  );
  return { mediaId, messageId: row!.id, conversationId: row!.conversation_id };
}

describe('files customers send (ADR-216)', () => {
  it('passes a file on to members who can see the conversation, fetched with the account’s token', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const waId = '919845000101';
    const photo = { bytes: randomBytes(2048), mimeType: 'image/jpeg' };
    const image = await receive(c, waId, 'image', { mime_type: 'image/jpeg', sha256: 'x' }, photo);
    fx.standIn.state.requests.length = 0;

    const file = await service().openReceivedMedia(owner, image.conversationId, image.messageId);
    expect(file).toMatchObject({
      contentType: 'image/jpeg',
      disposition: 'inline',
      filename: `whatsapp-image-${image.messageId.slice(0, 8)}.jpg`,
    });
    expect((await readAll(file.body)).equals(photo.bytes)).toBe(true);
    // Where the file is, then the file, both with the account's own token.
    expect(
      fx.standIn.state.requests.map(({ method, path, authorization }) => ({
        method,
        path,
        authorization,
      })),
    ).toEqual([
      { method: 'GET', path: `/v26.0/${image.mediaId}`, authorization: `Bearer ${c.token}` },
      { method: 'GET', path: `/__media/${image.mediaId}`, authorization: `Bearer ${c.token}` },
    ]);
    // HyFib keeps nothing: the media row is as the webhook left it.
    expect(
      await fx.query(
        'SELECT status, storage_key, size_bytes FROM app.media_objects WHERE message_id = $1',
        [image.messageId],
      ),
    ).toEqual([{ status: 'pending', storage_key: null, size_bytes: null }]);

    // A document downloads under the name it came with; a voice note plays in the page.
    const pdf = { bytes: Buffer.from('%PDF-1.4 quote'), mimeType: 'application/pdf' };
    const document = await receive(
      c,
      waId,
      'document',
      { mime_type: 'application/pdf', filename: 'Quote "A".pdf', caption: 'Our quote' },
      pdf,
    );
    const quote = await service().openReceivedMedia(
      agent,
      document.conversationId,
      document.messageId,
    );
    expect(quote).toMatchObject({
      contentType: 'application/octet-stream',
      disposition: 'attachment',
      filename: 'Quote A .pdf',
    });
    expect((await readAll(quote.body)).toString()).toBe('%PDF-1.4 quote');
    const voice = await receive(
      c,
      waId,
      'audio',
      { mime_type: 'audio/ogg; codecs=opus', voice: true },
      { bytes: randomBytes(512), mimeType: 'audio/ogg; codecs=opus' },
    );
    const note = await service().openReceivedMedia(owner, voice.conversationId, voice.messageId);
    expect(note).toMatchObject({ contentType: 'audio/ogg', disposition: 'inline' });
    await note.body.cancel();

    // An agent sees unassigned conversations and their own, not another member's.
    const [ownerMembership] = await fx.query<{ id: string }>(
      'SELECT id FROM app.memberships WHERE tenant_id = $1 AND user_id = $2',
      [c.tenant.id, c.owner.id],
    );
    await fx.query('UPDATE app.conversations SET assigned_membership_id = $1 WHERE id = $2', [
      ownerMembership!.id,
      image.conversationId,
    ]);
    await expect(
      service().openReceivedMedia(agent, image.conversationId, image.messageId),
    ).rejects.toMatchObject({ code: 'not_found', publicMessage: 'Message not found.' });
    // Another company's owner, another conversation's id and malformed ids find nothing.
    const other = await fx.company();
    await expect(
      service().openReceivedMedia(
        await fx.ctx(other, other.owner),
        image.conversationId,
        image.messageId,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    const elsewhere = await receive(c, '919845000102', 'image', { mime_type: 'image/jpeg' }, photo);
    await expect(
      service().openReceivedMedia(owner, elsewhere.conversationId, image.messageId),
    ).rejects.toMatchObject({ code: 'not_found', publicMessage: 'Message not found.' });
    await expect(
      service().openReceivedMedia(owner, 'not-a-uuid', image.messageId),
    ).rejects.toMatchObject({ code: 'not_found' });
    // A message without a file from the customer has none to give.
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId, text: 'Did you get it?' }] }));
    const [textMessage] = await fx.query<{ id: string }>(
      `SELECT id FROM app.messages WHERE conversation_id = $1 AND type = 'text'`,
      [image.conversationId],
    );
    await expect(
      service().openReceivedMedia(owner, image.conversationId, textMessage!.id),
    ).rejects.toMatchObject({
      code: 'not_found',
      publicMessage: 'This message has no file.',
    });
  });

  it('says why a file cannot be fetched, and gives none once the customer is erased', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const waId = '919845000201';
    const photo = { bytes: randomBytes(64), mimeType: 'image/png' };

    // WhatsApp no longer keeps it.
    const expired = await receive(c, waId, 'image', { mime_type: 'image/png' }, null);
    await expect(
      service().openReceivedMedia(owner, expired.conversationId, expired.messageId),
    ).rejects.toMatchObject({
      code: 'not_found',
      publicMessage:
        'WhatsApp no longer gives this file. It keeps the files customers send for a limited time.',
    });
    // The download fails: WhatsApp is unavailable, or refuses the token.
    const failing = await receive(c, waId, 'image', { mime_type: 'image/png' }, photo);
    fx.standIn.state.media.set(failing.mediaId, { ...photo, downloadStatus: 503 });
    await expect(
      service().openReceivedMedia(owner, failing.conversationId, failing.messageId),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      publicMessage: 'WhatsApp did not give the file. Try again in a moment.',
    });
    fx.standIn.state.media.set(failing.mediaId, { ...photo, downloadStatus: 401 });
    await expect(
      service().openReceivedMedia(owner, failing.conversationId, failing.messageId),
    ).rejects.toMatchObject({ code: 'precondition_failed' });
    // Meta no longer admits the account's token.
    const ok = await receive(c, waId, 'image', { mime_type: 'image/png' }, photo);
    fx.standIn.state.tokens.set(c.token, { appId: '1000000000001', valid: false, scopes: [] });
    await expect(
      service().openReceivedMedia(owner, ok.conversationId, ok.messageId),
    ).rejects.toMatchObject({
      code: 'precondition_failed',
      publicMessage: expect.stringContaining('refused HyFib’s access') as unknown as string,
    });
    fx.standIn.state.tokens.set(c.token, {
      appId: '1000000000001',
      valid: true,
      scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
    });
    const again = await service().openReceivedMedia(owner, ok.conversationId, ok.messageId);
    expect((await readAll(again.body)).equals(photo.bytes)).toBe(true);
    // The account was disconnected.
    await fx.query(
      `UPDATE app.whatsapp_accounts SET status = 'disconnected', credential_ciphertext = NULL WHERE id = $1`,
      [c.whatsappAccountId],
    );
    await expect(
      service().openReceivedMedia(owner, ok.conversationId, ok.messageId),
    ).rejects.toMatchObject({
      code: 'precondition_failed',
      publicMessage: expect.stringContaining('is disconnected') as unknown as string,
    });

    // An erased customer's files are gone from HyFib with their messages' content.
    const d = await fx.company();
    const dOwner = await fx.ctx(d, d.owner);
    const sent = await receive(d, '919845000301', 'image', { mime_type: 'image/png' }, photo);
    const [contact] = await fx.query<{ contact_id: string }>(
      'SELECT contact_id FROM app.conversations WHERE id = $1',
      [sent.conversationId],
    );
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(dOwner, {
      contactId: contact!.contact_id,
      suppress: false,
    });
    await expect(
      service().openReceivedMedia(dOwner, sent.conversationId, sent.messageId),
    ).rejects.toMatchObject({
      code: 'not_found',
      publicMessage: 'This message has no file.',
    });
  });
});

describe('files customers send, through the API (ADR-217)', () => {
  it('gives a key that reads conversations the file with its type, and refuses with reasons', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
    const key = async (scopes: ApiScope[]) => {
      const created = await keys.create(owner, { name: 'Files', scopes, expiresInDays: 0 });
      const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
      if (!ctx) throw new Error('a new key does not authenticate');
      return ctx;
    };
    const reader = await key(['conversations.read']);
    const waId = '919845000401';
    const pdf = { bytes: Buffer.from('%PDF-1.4 menu'), mimeType: 'application/pdf' };
    const menu = await receive(
      c,
      waId,
      'document',
      { mime_type: 'application/pdf', filename: 'Menu.pdf' },
      pdf,
    );

    // A download with the type WhatsApp gave, under the name the document came with.
    const file = await service().openReceivedMediaForKey(reader, menu.messageId);
    expect(file).toMatchObject({
      contentType: 'application/pdf',
      disposition: 'attachment',
      filename: 'Menu.pdf',
    });
    expect((await readAll(file.body)).toString()).toBe('%PDF-1.4 menu');
    const photo = await receive(
      c,
      waId,
      'image',
      { mime_type: 'image/jpeg' },
      { bytes: randomBytes(32), mimeType: 'image/jpeg' },
    );
    const image = await service().openReceivedMediaForKey(reader, photo.messageId);
    expect(image).toMatchObject({ contentType: 'image/jpeg', disposition: 'attachment' });
    await image.body.cancel();

    // A key that does not read conversations, another company's key, an unknown id.
    await expect(
      service().openReceivedMediaForKey(await key(['messages.reply']), menu.messageId),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const other = await fx.company();
    const otherOwner = await fx.ctx(other, other.owner);
    const otherKey = await keys.create(otherOwner, {
      name: 'Other',
      scopes: ['conversations.read'],
      expiresInDays: 0,
    });
    await expect(
      service().openReceivedMediaForKey(
        (await authenticateApiToken(fx.dbs.app, otherKey.token, uuidv7()))!,
        menu.messageId,
      ),
    ).rejects.toMatchObject({ code: 'not_found', publicMessage: 'Message not found.' });
    await expect(service().openReceivedMediaForKey(reader, 'nope')).rejects.toMatchObject({
      code: 'not_found',
    });

    // The reasons the API names: no file, a file WhatsApp no longer gives, a disconnected account.
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId, text: 'And the prices?' }] }));
    const [textMessage] = await fx.query<{ id: string }>(
      `SELECT id FROM app.messages WHERE conversation_id = $1 AND type = 'text'`,
      [menu.conversationId],
    );
    await expect(service().openReceivedMediaForKey(reader, textMessage!.id)).rejects.toMatchObject({
      code: 'not_found',
      details: { apiReason: 'no_file' },
    });
    const gone = await receive(c, waId, 'image', { mime_type: 'image/jpeg' }, null);
    await expect(service().openReceivedMediaForKey(reader, gone.messageId)).rejects.toMatchObject({
      code: 'not_found',
      details: { apiReason: 'file_expired' },
    });
    await fx.query(
      `UPDATE app.whatsapp_accounts SET status = 'disconnected', credential_ciphertext = NULL WHERE id = $1`,
      [c.whatsappAccountId],
    );
    await expect(service().openReceivedMediaForKey(reader, menu.messageId)).rejects.toMatchObject({
      code: 'precondition_failed',
      details: { apiReason: 'channel_disconnected' },
    });

    // A message of an erased contact is not found, as its conversation is to keys.
    const [contact] = await fx.query<{ contact_id: string }>(
      'SELECT contact_id FROM app.conversations WHERE id = $1',
      [menu.conversationId],
    );
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: contact!.contact_id,
      suppress: false,
    });
    await expect(service().openReceivedMediaForKey(reader, menu.messageId)).rejects.toMatchObject({
      code: 'not_found',
      publicMessage: 'Message not found.',
    });
  });
});
