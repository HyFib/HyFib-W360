import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7 } from '@w360/core';
import { authorizedTenantScope, sql } from '@w360/db';
import {
  SAVED_REPLY_FILES_MAX_TOTAL_BYTES,
  apiDeleteSavedReply,
  apiListSavedReplies,
  apiUpdateSavedReply,
  authenticateApiToken,
  createApiKeysService,
  createFileRepliesService,
  createSavedRepliesService,
  processSendIntent,
  type TenantContext,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Saved replies that carry a file (ADR-411, migration 0321) against real PostgreSQL and the Graph
 * stand-in: the file kept once per company under RLS and composite foreign keys, shared by replies
 * and deleted with the last of them, the caption limit, the company's total, the split between
 * members who manage replies and members who use them, the API's description of the file, and
 * sending an inserted file through the inbox's own file path.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx.close();
});

const replies = () => createSavedRepliesService({ db: fx.dbs.app, clock: systemClock });
const files = () =>
  createFileRepliesService({
    db: fx.dbs.app,
    jobs: fx.jobs(),
    signer: fx.signer,
    clock: systemClock,
    keyring: fx.keyring,
    graph: fx.graph,
  });

const png = (seed: string, size = 64) => {
  const bytes = new Uint8Array(size);
  bytes.set(Buffer.from(seed.padEnd(size, '.')).subarray(0, size));
  return { name: `${seed}.png`, type: 'image/png', bytes: bytes as Uint8Array<ArrayBuffer> };
};

async function storedFiles(tenantId: string) {
  return fx.query<{ id: string; filename: string; size_bytes: number; sha256: string }>(
    `SELECT id, filename, size_bytes, sha256 FROM app.saved_reply_files WHERE tenant_id = $1
      ORDER BY created_at`,
    [tenantId],
  );
}

async function attachmentsOf(tenantId: string) {
  return fx.query<{ saved_reply_id: string; file_id: string }>(
    `SELECT saved_reply_id, file_id FROM app.saved_reply_attachments WHERE tenant_id = $1
      ORDER BY saved_reply_id`,
    [tenantId],
  );
}

async function addReply(owner: TenantContext, shortcut: string, body = 'Our price list') {
  return (await replies().createSavedReply(owner, { shortcut, title: shortcut, body })).id;
}

/** A conversation the customer opened by writing (window open), assigned to the agent. */
async function conversationFor(c: Company, waId: string) {
  await fx.deliver(fx.messagesBody(c, { messages: [{ waId, text: 'Prices please' }] }));
  const [row] = await fx.query<{ conversation_id: string }>(
    `SELECT conversation_id FROM app.messages WHERE tenant_id = $1 AND type = 'text'
      ORDER BY created_at DESC LIMIT 1`,
    [c.tenant.id],
  );
  const [agent] = await fx.query<{ id: string }>(
    'SELECT id FROM app.memberships WHERE tenant_id = $1 AND user_id = $2',
    [c.tenant.id, c.agent.id],
  );
  await fx.query(
    'UPDATE app.conversations SET assigned_membership_id = $3 WHERE tenant_id = $1 AND id = $2',
    [c.tenant.id, row!.conversation_id, agent!.id],
  );
  return row!.conversation_id;
}

describe('the files saved replies carry (ADR-411)', () => {
  it('stores a file once, shares it between replies and deletes it with the last reply that has it', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const first = await addReply(owner, 'prices');
    const second = await addReply(owner, 'prices-again');
    const a = await replies().attachSavedReplyFile(owner, first, png('list'));
    const b = await replies().attachSavedReplyFile(owner, second, png('list'));
    // The same bytes, type and name are one row.
    expect(b.fileId).toBe(a.fileId);
    const [stored] = await storedFiles(c.tenant.id);
    expect(await storedFiles(c.tenant.id)).toHaveLength(1);
    expect(stored).toMatchObject({
      filename: 'list.png',
      size_bytes: 64,
      sha256: createHash('sha256').update(png('list').bytes).digest('hex'),
    });
    expect(await attachmentsOf(c.tenant.id)).toHaveLength(2);

    // Replacing the second reply's file keeps the shared one for the first.
    const replaced = await replies().attachSavedReplyFile(owner, second, png('other'));
    expect(replaced.fileId).not.toBe(a.fileId);
    expect((await storedFiles(c.tenant.id)).map((f) => f.filename).sort()).toEqual([
      'list.png',
      'other.png',
    ]);
    // Giving it back the first file shares it again and deletes the one only it had.
    await replies().attachSavedReplyFile(owner, second, png('list'));
    expect((await storedFiles(c.tenant.id)).map((f) => f.filename)).toEqual(['list.png']);

    // Deleting one reply keeps the file the other still has; deleting the other deletes it.
    await replies().deleteSavedReply(owner, first);
    expect(await storedFiles(c.tenant.id)).toHaveLength(1);
    await replies().deleteSavedReply(owner, second);
    expect(await storedFiles(c.tenant.id)).toEqual([]);
    expect(await attachmentsOf(c.tenant.id)).toEqual([]);

    // Removing a file deletes it when no other reply has it.
    const third = await addReply(owner, 'menu');
    await replies().attachSavedReplyFile(owner, third, png('menu'));
    await replies().removeSavedReplyFile(owner, third);
    expect(await storedFiles(c.tenant.id)).toEqual([]);
    await expect(replies().removeSavedReplyFile(owner, third)).rejects.toMatchObject({
      code: 'not_found',
    });

    // Audited with the kind and size, never the name or the content.
    const audits = await fx.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action LIKE 'saved_reply.file_%' ORDER BY occurred_at, id`,
      [c.tenant.id],
    );
    expect(audits[0]).toEqual({
      action: 'saved_reply.file_attached',
      metadata: {
        shortcut: 'prices',
        kind: 'image',
        sizeBytes: 64,
        shared: false,
        replaced: false,
      },
    });
    expect(audits.at(-1)).toMatchObject({
      action: 'saved_reply.file_removed',
      metadata: { shortcut: 'menu', kind: 'image', fileDeleted: true },
    });
    expect(JSON.stringify(audits)).not.toContain('.png');
  });

  it('keeps the caption limit both ways and the company within its total', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const long = await addReply(owner, 'long', 'x'.repeat(1025));
    await expect(replies().attachSavedReplyFile(owner, long, png('a'))).rejects.toMatchObject({
      code: 'validation_failed',
    });
    // A recording takes no caption: a long text is fine with it.
    await replies().attachSavedReplyFile(owner, long, {
      name: 'hello.ogg',
      type: 'audio/ogg',
      bytes: new Uint8Array(randomBytes(32)),
    });
    const short = await addReply(owner, 'short', 'Prices');
    await replies().attachSavedReplyFile(owner, short, png('b'));
    await expect(
      replies().updateSavedReply(owner, short, {
        shortcut: 'short',
        title: 'short',
        body: 'y'.repeat(1025),
      }),
    ).rejects.toMatchObject({ code: 'validation_failed', issues: [{ path: 'body' }] });

    // The total: a stored row of the company's near the limit (written directly, as the bytes
    // would take too long to send), then a file that would pass it.
    const big = 16 * 1024 * 1024;
    const [member] = await fx.query<{ id: string }>(
      'SELECT id FROM app.memberships WHERE tenant_id = $1 AND user_id = $2',
      [c.tenant.id, c.owner.id],
    );
    // Each filler is a reply's file, as the service would have stored it: a file no reply names
    // would be deleted before the next one is stored, and count for nothing.
    const fillers: { replyId: string; fileId: string }[] = [];
    for (let i = 0; i < Math.floor(SAVED_REPLY_FILES_MAX_TOTAL_BYTES / big); i += 1) {
      const replyId = await addReply(owner, `filler-${i}`, 'Brochure');
      const fileId = uuidv7();
      await fx.query(
        `INSERT INTO app.saved_reply_files (id, tenant_id, kind, mime_type, filename, size_bytes,
           sha256, content, created_by_membership_id)
         SELECT $1, $2, 'document', 'application/pdf', $3, $4,
                encode(sha256(convert_to(repeat('z', $4), 'UTF8')), 'hex'),
                convert_to(repeat('z', $4), 'UTF8'), $5`,
        [fileId, c.tenant.id, `filler-${i}.pdf`, big - i, member!.id],
      );
      await fx.query(
        `INSERT INTO app.saved_reply_attachments (id, tenant_id, saved_reply_id, file_id,
           attached_by_membership_id) VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), c.tenant.id, replyId, fileId, member!.id],
      );
      fillers.push({ replyId, fileId });
    }
    const total = async () =>
      Number(
        (
          await fx.query<{ bytes: string }>(
            'SELECT coalesce(sum(size_bytes), 0)::text AS bytes FROM app.saved_reply_files WHERE tenant_id = $1',
            [c.tenant.id],
          )
        )[0]!.bytes,
      );
    const room = SAVED_REPLY_FILES_MAX_TOTAL_BYTES - (await total());
    expect(room).toBeGreaterThan(0);
    expect(room).toBeLessThan(8 * 1024 * 1024);
    const third = await addReply(owner, 'third', 'Menu');
    const fourth = await addReply(owner, 'fourth', 'Menu again');
    const fifth = await addReply(owner, 'fifth', 'Another menu');
    // Past the limit: refused, nothing stored.
    await expect(
      replies().attachSavedReplyFile(owner, third, png('c', 8 * 1024 * 1024)),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await total()).toBe(SAVED_REPLY_FILES_MAX_TOTAL_BYTES - room);
    // Exactly to the limit: allowed.
    await replies().attachSavedReplyFile(owner, third, png('exact', room));
    expect(await total()).toBe(SAVED_REPLY_FILES_MAX_TOTAL_BYTES);
    // The same file for another reply is shared and counts once, so it fits at the limit.
    await replies().attachSavedReplyFile(owner, fourth, png('exact', room));
    expect(await total()).toBe(SAVED_REPLY_FILES_MAX_TOTAL_BYTES);
    // One byte of a new file does not.
    await expect(replies().attachSavedReplyFile(owner, fifth, png('d', 1))).rejects.toMatchObject({
      code: 'conflict',
    });
    // Replacing a file only its reply has frees it: 16 MB out, 8 MB in.
    await replies().attachSavedReplyFile(owner, fillers[0]!.replyId, png('e', 8 * 1024 * 1024));
    expect(
      await fx.query('SELECT id FROM app.saved_reply_files WHERE id = $1', [fillers[0]!.fileId]),
    ).toEqual([]);
    expect(await total()).toBe(SAVED_REPLY_FILES_MAX_TOTAL_BYTES - big + 8 * 1024 * 1024);
    // Replacing a file another reply still has frees nothing: the third reply's shared file stays,
    // so 8 MB and a byte more no longer fit.
    await expect(
      replies().attachSavedReplyFile(owner, third, png('f', 8 * 1024 * 1024 + 1)),
    ).rejects.toMatchObject({ code: 'conflict' });
    await replies().attachSavedReplyFile(owner, third, png('g', 8 * 1024 * 1024));
    expect(await total()).toBe(SAVED_REPLY_FILES_MAX_TOTAL_BYTES);
  });

  it('refuses in the database what the service never writes: bytes that do not match, other types, another company’s rows', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const reply = await addReply(owner, 'prices');
    const otherReply = await addReply(await fx.ctx(other, other.owner), 'theirs');
    const file = await replies().attachSavedReplyFile(owner, reply, png('mine'));
    const [member] = await fx.query<{ id: string }>(
      'SELECT id FROM app.memberships WHERE tenant_id = $1 AND user_id = $2',
      [c.tenant.id, c.owner.id],
    );
    const insertFile = (overrides: Partial<Record<string, unknown>>) => {
      const row = {
        kind: 'image',
        mime_type: 'image/png',
        filename: 'x.png',
        size_bytes: 3,
        sha256: createHash('sha256').update('abc').digest('hex'),
        content: Buffer.from('abc'),
        ...overrides,
      };
      return fx.query(
        `INSERT INTO app.saved_reply_files (id, tenant_id, kind, mime_type, filename, size_bytes,
           sha256, content, created_by_membership_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          uuidv7(),
          c.tenant.id,
          row.kind,
          row.mime_type,
          row.filename,
          row.size_bytes,
          row.sha256,
          row.content,
          member!.id,
        ],
      );
    };
    await insertFile({});
    const fresh = () => `${uuidv7()}.png`;
    for (const bad of [
      { filename: fresh(), content: Buffer.from('abd') },
      { filename: fresh(), size_bytes: 4 },
      { filename: fresh(), kind: 'video' },
      { filename: fresh(), mime_type: 'image/gif' },
      { filename: '' },
      { filename: 'n'.repeat(151) },
      { filename: fresh(), sha256: 'ABC' },
    ]) {
      await expect(insertFile(bad), JSON.stringify(bad)).rejects.toThrow();
    }
    // A reply of another company cannot name this company's file, nor this reply theirs.
    await expect(
      fx.query(
        `INSERT INTO app.saved_reply_attachments (id, tenant_id, saved_reply_id, file_id, attached_by_membership_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), c.tenant.id, otherReply, file.fileId, member!.id],
      ),
    ).rejects.toThrow(/saved_reply_attachments_reply_fk/);
    await expect(
      fx.query(
        `INSERT INTO app.saved_reply_attachments (id, tenant_id, saved_reply_id, file_id, attached_by_membership_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), other.tenant.id, otherReply, file.fileId, member!.id],
      ),
    ).rejects.toThrow(/saved_reply_attachments_(file|attached_by)_fk/);
    // One file per reply; a file a reply names cannot be deleted under it.
    await expect(
      fx.query(
        `INSERT INTO app.saved_reply_attachments (id, tenant_id, saved_reply_id, file_id, attached_by_membership_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), c.tenant.id, reply, file.fileId, member!.id],
      ),
    ).rejects.toThrow(/saved_reply_attachments_reply_uq/);
    await expect(
      fx.query('DELETE FROM app.saved_reply_files WHERE id = $1', [file.fileId]),
    ).rejects.toThrow(/saved_reply_attachments_file_fk/);

    // Under the other company's scope neither table shows this company's rows.
    const seen = await fx.dbs.app.run(authorizedTenantScope(other.tenant.id, null), async (tx) => ({
      files: (await tx.execute(sql`select id from app.saved_reply_files`)).rows,
      attachments: (await tx.execute(sql`select id from app.saved_reply_attachments`)).rows,
    }));
    expect(seen).toEqual({ files: [], attachments: [] });
    expect(
      await replies().openSavedReplyFile(await fx.ctx(other, other.owner), file.fileId),
    ).toBeNull();
    // The runtime role may not change a stored file: PostgreSQL refuses it, which the database
    // layer maps to forbidden ("Operation not permitted.") with the reason as its cause.
    const refusal = await fx.dbs.app
      .run(authorizedTenantScope(c.tenant.id, null), (tx) =>
        tx.execute(sql`update app.saved_reply_files set filename = 'renamed.png'`),
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(isAppError(refusal) ? refusal.code : refusal).toBe('forbidden');
    const reasons: string[] = [];
    for (let e: unknown = refusal; e instanceof Error; e = e.cause) reasons.push(e.message);
    expect(reasons.join(' | ')).toMatch(/permission denied/);
  });

  it('lets members who reply use replies’ files, and only supervisors manage them', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const reply = await addReply(owner, 'prices', 'Here is our list, {{name}}');
    await expect(replies().attachSavedReplyFile(agent, reply, png('x'))).rejects.toMatchObject({
      code: 'forbidden',
    });
    const file = await replies().attachSavedReplyFile(owner, reply, png('list'));
    await expect(replies().removeSavedReplyFile(agent, reply)).rejects.toMatchObject({
      code: 'forbidden',
    });
    const conversationId = await conversationFor(c, '919845004101');
    const [listed] = await replies().savedRepliesFor(agent, conversationId);
    expect(listed?.attachment).toEqual({
      fileId: file.fileId,
      kind: 'image',
      mimeType: 'image/png',
      filename: 'list.png',
      sizeBytes: 64,
    });
    expect(await replies().savedReplyFileForInsert(agent, conversationId, reply)).toEqual({
      ...listed!.attachment,
      caption: true,
    });
    expect((await replies().openSavedReplyFile(agent, file.fileId))?.content).toEqual(
      png('list').bytes,
    );
    // A marketer neither replies nor manages.
    const marketer = await fx.ctx(c, c.marketer);
    await expect(
      replies().savedReplyFileForInsert(marketer, conversationId, reply),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // Gone after the page loaded: reported when inserted.
    await replies().removeSavedReplyFile(owner, reply);
    await expect(
      replies().savedReplyFileForInsert(agent, conversationId, reply),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('sends an inserted file through the inbox’s file path, and refuses one changed since', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const waId = '919845004102';
    const conversationId = await conversationFor(c, waId);
    const reply = await addReply(owner, 'prices', 'Our prices');
    const file = await replies().attachSavedReplyFile(owner, reply, png('list'));
    const sent = await files().queueSavedReplyFileReply(agent, {
      conversationId,
      clientKey: 'file-saved-0001',
      caption: 'Our prices',
      savedReplyId: reply,
      savedReplyFileId: file.fileId,
    });
    expect(sent.duplicate).toBe(false);
    const upload = fx.standIn.state.requests
      .filter((r) => r.method === 'POST' && r.path === `/v26.0/${c.phoneNumberId}/media`)
      .pop();
    expect(
      Buffer.from((upload!.body as { file: { base64: string } }).file.base64, 'base64'),
    ).toEqual(Buffer.from(png('list').bytes));
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
    expect(send?.body).toMatchObject({ type: 'image', to: waId, image: { caption: 'Our prices' } });

    // Replaced after the member inserted it: nothing is uploaded or queued.
    const before = fx.standIn.state.requests.length;
    await replies().attachSavedReplyFile(owner, reply, png('newer'));
    await expect(
      files().queueSavedReplyFileReply(agent, {
        conversationId,
        clientKey: 'file-saved-0002',
        savedReplyId: reply,
        savedReplyFileId: file.fileId,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(fx.standIn.state.requests.length).toBe(before);
  });

  it('gives keys the file’s details only, keeps it on a change of the text and deletes it with the reply', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const reply = await addReply(owner, 'prices', 'Our prices');
    const file = await replies().attachSavedReplyFile(owner, reply, png('list'));
    const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
    const created = await keys.create(owner, {
      name: 'Replies',
      scopes: ['saved_replies.manage'],
      expiresInDays: 0,
    });
    const key = (await authenticateApiToken(fx.dbs.app, created.token, uuidv7()))!;
    const { data } = await apiListSavedReplies({ db: fx.dbs.app }, key);
    expect(data[0]?.attachment).toEqual({
      id: file.fileId,
      type: 'image',
      mimeType: 'image/png',
      filename: 'list.png',
      sizeBytes: 64,
      caption: true,
    });
    expect(JSON.stringify(data)).not.toMatch(/content|base64|storage/i);
    const changed = await apiUpdateSavedReply({ db: fx.dbs.app }, key, reply, { title: 'Prices' });
    expect(changed.attachment?.id).toBe(file.fileId);
    await expect(
      apiUpdateSavedReply({ db: fx.dbs.app }, key, reply, { body: 'z'.repeat(1025) }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    // A text an older server stored past 1,024 characters with the photo still lets the title
    // change; only a change of the text is refused.
    await fx.query('UPDATE app.saved_replies SET body = $2 WHERE id = $1', [
      reply,
      'w'.repeat(1500),
    ]);
    expect(
      (await apiUpdateSavedReply({ db: fx.dbs.app }, key, reply, { title: 'Prices again' })).title,
    ).toBe('Prices again');
    await apiDeleteSavedReply({ db: fx.dbs.app }, key, reply);
    expect(await storedFiles(c.tenant.id)).toEqual([]);
  });

  it('reads only the part of a file a Range request asks for, from the database', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const reply = await addReply(owner, 'clip');
    const bytes = new Uint8Array(randomBytes(4096));
    const file = await replies().attachSavedReplyFile(owner, reply, {
      name: 'clip.mp4',
      type: 'video/mp4',
      bytes,
    });
    const part = await replies().openSavedReplyFile(owner, file.fileId, (size) => {
      expect(size).toBe(4096);
      return { kind: 'part', start: 1000, end: 2999 };
    });
    expect(part?.part).toEqual({ kind: 'part', start: 1000, end: 2999 });
    expect(Buffer.from(part!.content)).toEqual(Buffer.from(bytes.subarray(1000, 3000)));
    const last = await replies().openSavedReplyFile(owner, file.fileId, () => ({
      kind: 'part',
      start: 4095,
      end: 4095,
    }));
    expect(Buffer.from(last!.content)).toEqual(Buffer.from(bytes.subarray(4095)));
    const whole = await replies().openSavedReplyFile(owner, file.fileId);
    expect(Buffer.from(whole!.content)).toEqual(Buffer.from(bytes));
    // Stored uncompressed out of line, so a slice reads only its own chunks.
    expect(
      await fx.query(
        `SELECT attstorage FROM pg_attribute
          WHERE attrelid = 'app.saved_reply_files'::regclass AND attname = 'content'`,
      ),
    ).toEqual([{ attstorage: 'e' }]);
  });

  it('deletes the files an older server left without a reply before storing another', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const old = await addReply(owner, 'old');
    await replies().attachSavedReplyFile(owner, old, png('left'));
    // A server of the release before deletes the reply as it always did: the attachment row goes
    // with it (the cascade), the file stays.
    await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, null), (tx) =>
      tx.execute(sql`delete from app.saved_replies where id = ${old}::uuid`),
    );
    expect((await storedFiles(c.tenant.id)).map((f) => f.filename)).toEqual(['left.png']);
    expect(await attachmentsOf(c.tenant.id)).toEqual([]);
    const fresh = await addReply(owner, 'fresh');
    await replies().attachSavedReplyFile(owner, fresh, png('new'));
    expect((await storedFiles(c.tenant.id)).map((f) => f.filename)).toEqual(['new.png']);
  });

  it('serialises writes under the company’s lock: two replies taking the same new file store it once', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const first = await addReply(owner, 'one');
    const second = await addReply(owner, 'two');
    const [a, b] = await Promise.all([
      replies().attachSavedReplyFile(owner, first, png('same')),
      replies().attachSavedReplyFile(owner, second, png('same')),
    ]);
    expect(a.fileId).toBe(b.fileId);
    expect(await storedFiles(c.tenant.id)).toHaveLength(1);
    // Deleting one while the other is replaced leaves no file without a reply and none missing.
    await Promise.all([
      replies().deleteSavedReply(owner, first),
      replies().attachSavedReplyFile(owner, second, png('fresh')),
    ]);
    expect((await storedFiles(c.tenant.id)).map((f) => f.filename)).toEqual(['fresh.png']);
    expect(await attachmentsOf(c.tenant.id)).toHaveLength(1);
  });
});
