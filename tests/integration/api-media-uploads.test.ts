import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex, systemClock, uuidv7 } from '@w360/core';
import {
  apiSendMessage,
  apiUploadMedia,
  authenticateApiToken,
  createApiKeysService,
  createReceivedMediaService,
  type ApiContext,
  type ApiScope,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Files keys upload to send by id (ADR-219) against real PostgreSQL and the Graph stand-in: the
 * upload for a number with its account's token, recorded as the company's; sends that name it from
 * that number, of its kind, within 30 days, as often as needed; refusals of everything else.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx.close();
});

const deps = () => ({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });
const mediaDeps = () => ({
  db: fx.dbs.app,
  keyring: fx.keyring,
  graph: fx.graph,
  clock: systemClock,
});
const idem = (key: string) => ({ key, requestHash: sha256Hex(key) });

async function apiKey(c: Company, scopes: ApiScope[]): Promise<ApiContext> {
  const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
  const created = await keys.create(await fx.ctx(c, c.owner), {
    name: `Files ${uuidv7().slice(-6)}`,
    scopes,
    expiresInDays: 0,
  });
  const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
  if (!ctx) throw new Error('a new key does not authenticate');
  return ctx;
}

const wrote = (c: Company, waId: string) =>
  fx.deliver(fx.messagesBody(c, { messages: [{ waId, text: 'Send the menu please' }] }));

const pdf = (text = '%PDF-1.4 menu') => ({
  name: 'Menu.pdf',
  type: 'application/pdf',
  bytes: new Uint8Array(Buffer.from(text)),
});

describe('files keys upload and send by id (ADR-219)', () => {
  it('uploads a file for the number, then sends it by id to customers who wrote', async () => {
    const c = await fx.company();
    const ctx = await apiKey(c, ['messages.reply', 'conversations.read']);
    const [first, second] = ['919845000701', '919845000702'];
    await wrote(c, first);
    await wrote(c, second);

    const uploaded = await apiUploadMedia(mediaDeps(), ctx, {}, pdf());
    expect(uploaded).toMatchObject({
      channelId: c.channelAccountId,
      type: 'document',
      mimeType: 'application/pdf',
      size: 13,
      fileName: 'Menu.pdf',
    });
    expect(Date.parse(uploaded.expiresAt) - Date.parse(uploaded.createdAt)).toBe(
      30 * 24 * 3600_000,
    );
    const upload = fx.standIn.state.requests
      .filter((r) => r.method === 'POST' && r.path === `/v26.0/${c.phoneNumberId}/media`)
      .pop();
    expect(upload?.authorization).toBe(`Bearer ${c.token}`);
    const [row] = await fx.query<{
      message_id: string | null;
      channel_account_id: string;
      api_key_id: string;
      provider_media_id: string;
    }>(
      'SELECT message_id, channel_account_id, api_key_id, provider_media_id FROM app.media_objects WHERE id = $1',
      [uploaded.id],
    );
    expect(row).toMatchObject({
      message_id: null,
      channel_account_id: c.channelAccountId,
      api_key_id: ctx.key.id,
    });

    // Sent by id twice: each message names WhatsApp's media, a document under its name.
    const sends = [];
    for (const [to, key] of [
      [first, 'send-1'],
      [second, 'send-2'],
    ] as const) {
      const sent = await apiSendMessage(
        deps(),
        ctx,
        { type: 'document', to: `+${to}`, mediaId: uploaded.id, caption: ' Our menu ' },
        idem(key),
      );
      expect(sent.status).toBe(201);
      sends.push((sent.body.data as { id: string }).id);
    }
    const media = { id: row!.provider_media_id, caption: 'Our menu', filename: 'Menu.pdf' };
    const stored = await fx.query<{ content: unknown; request: Record<string, unknown> }>(
      `SELECT m.content, si.request FROM app.messages m
         JOIN app.send_intents si ON si.tenant_id = m.tenant_id AND si.message_id = m.id
        WHERE m.id = ANY($1::uuid[]) ORDER BY m.created_at`,
      [sends],
    );
    expect(stored.map((s) => s.content)).toEqual([
      { ...media, mime_type: 'application/pdf' },
      { ...media, mime_type: 'application/pdf' },
    ]);
    expect(stored[0]!.request).toMatchObject({ type: 'document', document: media, to: first });
    expect(stored[1]!.request).toMatchObject({ type: 'document', document: media, to: second });
    // Each message has its media, which members open in the inbox.
    const [conversation] = await fx.query<{ conversation_id: string }>(
      'SELECT conversation_id FROM app.messages WHERE id = $1',
      [sends[0]],
    );
    const file = await createReceivedMediaService({
      db: fx.dbs.app,
      keyring: fx.keyring,
      graph: fx.graph,
    }).openReceivedMedia(await fx.ctx(c, c.owner), conversation!.conversation_id, sends[0]!);
    expect(file.filename).toBe('Menu.pdf');
    await file.body.cancel();
  });

  it('refuses an upload or a send that does not fit, naming why', async () => {
    const c = await fx.company();
    const ctx = await apiKey(c, ['messages.reply']);
    const waId = '919845000801';
    await wrote(c, waId);
    const uploaded = await apiUploadMedia(mediaDeps(), ctx, {}, pdf());
    const send = (body: Record<string, unknown>) =>
      apiSendMessage(deps(), ctx, { to: `+${waId}`, ...body }, idem(uuidv7()));

    // Uploads: the scope, the type, the number, Meta's refusal.
    await expect(
      apiUploadMedia(mediaDeps(), await apiKey(c, ['contacts.read']), {}, pdf()),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      apiUploadMedia(mediaDeps(), ctx, {}, { ...pdf(), type: 'text/html' }),
    ).rejects.toMatchObject({ code: 'validation_failed', issues: [{ path: 'file' }] });
    await expect(apiUploadMedia(mediaDeps(), ctx, { from: 'nope' }, pdf())).rejects.toMatchObject({
      code: 'validation_failed',
      issues: [{ path: 'from' }],
    });
    await expect(apiUploadMedia(mediaDeps(), ctx, { from: uuidv7() }, pdf())).rejects.toMatchObject(
      { code: 'not_found' },
    );
    fx.standIn.state.uploadError = { status: 400, code: 131053, message: 'Media upload error' };
    await expect(apiUploadMedia(mediaDeps(), ctx, {}, pdf())).rejects.toMatchObject({
      code: 'provider_rejected',
    });
    fx.standIn.state.uploadError = null;

    // Sends: both sources or none, the wrong kind, an unknown id, another company's.
    await expect(
      send({ type: 'document', link: 'https://cdn.example.com/m.pdf', mediaId: uploaded.id }),
    ).rejects.toMatchObject({ code: 'validation_failed', issues: [{ path: 'link' }] });
    await expect(send({ type: 'document' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(send({ type: 'image', mediaId: uploaded.id })).rejects.toMatchObject({
      code: 'validation_failed',
      issues: [{ path: 'mediaId', message: 'This file is sent as type document.' }],
    });
    await expect(send({ type: 'document', mediaId: uuidv7() })).rejects.toMatchObject({
      issues: [{ path: 'mediaId', message: 'No file with this id was uploaded for the company.' }],
    });
    const other = await fx.company();
    await wrote(other, waId);
    const otherKey = await apiKey(other, ['messages.reply']);
    await expect(
      apiSendMessage(
        deps(),
        otherKey,
        { type: 'document', to: `+${waId}`, mediaId: uploaded.id },
        idem(uuidv7()),
      ),
    ).rejects.toMatchObject({
      issues: [{ path: 'mediaId', message: 'No file with this id was uploaded for the company.' }],
    });

    // Another number: its uploads go only from it.
    const b = await fx.addNumber(c, { phone: '+91 90000 00002' });
    await expect(apiUploadMedia(mediaDeps(), ctx, {}, pdf())).rejects.toMatchObject({
      code: 'validation_failed',
      publicMessage: expect.stringContaining('several WhatsApp numbers') as unknown as string,
    });
    const forB = await apiUploadMedia(mediaDeps(), ctx, { from: b.channelAccountId }, pdf());
    expect(forB.channelId).toBe(b.channelAccountId);
    await expect(
      send({ type: 'document', mediaId: forB.id, from: c.channelAccountId }),
    ).rejects.toMatchObject({
      issues: [{ path: 'mediaId', message: expect.stringContaining('another WhatsApp number') }],
    });

    // Older than 30 days: WhatsApp no longer keeps it.
    await fx.query(
      `UPDATE app.media_objects SET created_at = now() - interval '31 days' WHERE id = $1`,
      [uploaded.id],
    );
    await expect(
      send({ type: 'document', mediaId: uploaded.id, from: c.channelAccountId }),
    ).rejects.toMatchObject({
      code: 'precondition_failed',
      details: { apiReason: 'file_expired' },
    });
  });
});
