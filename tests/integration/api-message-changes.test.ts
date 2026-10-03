import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, Keyring, sha256Hex, systemClock, uuidv7 } from '@w360/core';
import { authorizedTenantScope, sql } from '@w360/db';
import {
  apiListMessages,
  apiMessageChanges,
  apiSendText,
  authenticateApiToken,
  createApiKeysService,
  createContactsService,
  processSendIntent,
  sealChangeCursor,
  sealContactChangeCursor,
  type ApiContext,
  type ApiMessageChange,
  type ApiScope,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Following messages through the public API (ADR-116) against real PostgreSQL: every message once,
 * as it is now, in the order its changes were saved; what counts as a change (a message received or
 * sent, its status, status time or error, its contact's erasure) and what does not (the provider's
 * id, pricing, a value written again); a cursor that never passes a change still being saved; and
 * cursors sealed to their company and to this feed.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx?.close();
});

const deps = () => ({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });
const feedDeps = () => ({ db: fx.dbs.app, keyring: fx.keyring });

let waSeq = 0;
const nextWaId = () => `9198333${String(10000 + (waSeq += 1)).padStart(5, '0')}`;

/** A key of the company created by its owner, and the context a request with it gets. */
async function apiKey(c: Company, scopes: ApiScope[]): Promise<ApiContext> {
  const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
  const created = await keys.create(await fx.ctx(c, c.owner), {
    name: 'Helpdesk sync',
    scopes,
    expiresInDays: 0,
  });
  const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
  if (!ctx) throw new Error('a new key does not authenticate');
  return ctx;
}

/** A customer writes to the company's number; the message's id. */
async function inbound(c: Company, waId: string, text: string): Promise<string> {
  const wamid = `wamid.in.${randomBytes(6).toString('hex')}`;
  await fx.deliver(fx.messagesBody(c, { messages: [{ id: wamid, waId, text }] }));
  const [row] = await fx.query<{ id: string }>(
    'SELECT id FROM app.messages WHERE tenant_id = $1 AND external_message_id = $2',
    [c.tenant.id, wamid],
  );
  if (!row) throw new Error('the inbound message was not stored');
  return row.id;
}

/** A text reply through the API, then sent to WhatsApp by the send worker; its id and WhatsApp id. */
async function reply(c: Company, ctx: ApiContext, waId: string, text: string) {
  const key = uuidv7();
  const sent = await apiSendText(
    deps(),
    ctx,
    { type: 'text', to: `+${waId}`, text },
    { key, requestHash: sha256Hex(key) },
  );
  const id = (sent.body as { data: { id: string } }).data.id;
  return { id, send: () => sendQueued(c) };
}

async function sendQueued(c: Company) {
  const intents = await fx.query<{ id: string; actor_user_id: string | null }>(
    `SELECT id, actor_user_id FROM app.send_intents WHERE tenant_id = $1 AND state = 'queued'
      ORDER BY created_at`,
    [c.tenant.id],
  );
  for (const intent of intents) {
    await processSendIntent(
      {
        ...deps(),
        keyring: fx.keyring,
        graph: fx.graph,
        rate: { capacity: 1000, refillPerSecond: 1000 },
      },
      authorizedTenantScope(c.tenant.id, intent.actor_user_id),
      intent.id,
    );
  }
}

async function wamidOf(messageId: string) {
  const [row] = await fx.query<{ external_message_id: string | null }>(
    'SELECT external_message_id FROM app.messages WHERE id = $1',
    [messageId],
  );
  if (!row?.external_message_id) throw new Error('the message has no WhatsApp id');
  return row.external_message_id;
}

/** A status webhook for a message the company sent. */
async function status(
  c: Company,
  messageId: string,
  waId: string,
  value: 'sent' | 'delivered' | 'read' | 'failed',
  at = Math.floor(Date.now() / 1000),
) {
  await fx.deliver(
    fx.messagesBody(c, {
      statuses: [
        {
          id: await wamidOf(messageId),
          status: value,
          timestamp: String(at),
          recipient_id: waId,
          ...(value === 'failed'
            ? { errors: [{ code: 131026, title: 'Message undeliverable' }] }
            : {}),
        },
      ],
    }),
  );
}

/** Every page from `cursor` until `hasMore` is false: the changes and the last `nextCursor`. */
async function readFeed(ctx: ApiContext, cursor?: string, limit = 100) {
  const changes: ApiMessageChange[] = [];
  let next = cursor;
  for (let pages = 0; pages < 1_000; pages += 1) {
    const page = await apiMessageChanges(feedDeps(), ctx, {
      limit: String(limit),
      ...(next === undefined ? {} : { cursor: next }),
    });
    changes.push(...page.data);
    next = page.nextCursor;
    if (!page.hasMore) return { changes, cursor: next };
  }
  throw new Error('the feed did not end');
}

const ids = (changes: ApiMessageChange[]) => changes.map((c) => c.id);
const statuses = (changes: ApiMessageChange[]) =>
  changes.map((c) => [c.id, c.message?.status ?? null]);

/** The code of a refusal and the paths it names. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { code: error.code, paths: (error.issues ?? []).map((i) => i.path) };
  }
  throw new Error('expected a refusal');
}

/** The code of a refusal by the database and the messages of its causes. */
async function refusalWithCause(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    const messages: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
      messages.push(current.message);
      current = current.cause;
    }
    return { code: error.code, causes: messages.join(' | ') };
  }
  throw new Error('expected a refusal');
}

const rowsOf = async (messageId: string) =>
  (
    await fx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.message_changes WHERE message_id = $1',
      [messageId],
    )
  )[0]!.n;

describe('following messages through the public API (ADR-116)', () => {
  it('reads every message once, as it is now, in the order its changes were saved, and a cursor reads what changed since', async () => {
    const c = await fx.company();
    const ctx = await apiKey(c, ['conversations.read', 'messages.reply']);
    const waId = nextWaId();
    const question = await inbound(c, waId, 'Where is my order A-1001?');

    const first = await readFeed(ctx);
    expect(ids(first.changes)).toEqual([question]);
    // Each message as the message feed gives it (ADR-088).
    const listed = (await apiListMessages(deps(), ctx, {})).data;
    expect(first.changes).toEqual([{ id: question, erased: false, message: listed[0] }]);
    expect(first.changes[0]!.message).toMatchObject({
      direction: 'inbound',
      text: 'Where is my order A-1001?',
      status: 'received',
    });

    // A reply through the API: queued, then accepted by WhatsApp, then delivered and read.
    const answer = await reply(c, ctx, waId, 'Order A-1001 ships today.');
    const queued = await readFeed(ctx, first.cursor);
    expect(statuses(queued.changes)).toEqual([[answer.id, 'queued']]);
    await answer.send();
    const accepted = await readFeed(ctx, queued.cursor);
    expect(statuses(accepted.changes)).toEqual([[answer.id, 'accepted']]);
    expect(accepted.changes[0]!.message).toMatchObject({ sentBy: 'api', direction: 'outbound' });
    const at = Math.floor(Date.now() / 1000);
    await status(c, answer.id, waId, 'delivered', at);
    await status(c, answer.id, waId, 'read', at + 1);
    // Two changes read since: the message once, as it is now.
    const read = await readFeed(ctx, accepted.cursor);
    expect(statuses(read.changes)).toEqual([[answer.id, 'read']]);
    // A late "delivered" leaves the status as it is: no change.
    await status(c, answer.id, waId, 'delivered', at + 2);
    expect((await readFeed(ctx, read.cursor)).changes).toEqual([]);

    // From the start: each message once, at its latest change, in that change's order.
    const all = await readFeed(ctx);
    expect(statuses(all.changes)).toEqual([
      [question, 'received'],
      [answer.id, 'read'],
    ]);
    // One message a page: the same messages in the same order, never one twice.
    const paged = await readFeed(ctx, undefined, 1);
    expect(ids(paged.changes)).toEqual([question, answer.id]);
    // An empty page keeps the place it was given.
    const still = await apiMessageChanges(feedDeps(), ctx, { cursor: all.cursor });
    expect(still).toMatchObject({ data: [], hasMore: false });
    expect((await readFeed(ctx, still.nextCursor)).changes).toEqual([]);
  });

  it('records a change whoever makes it and only what changes a message: a failure, an erasure, not pricing or a value written again', async () => {
    const c = await fx.company();
    const ctx = await apiKey(c, ['conversations.read', 'messages.reply']);
    const waId = nextWaId();
    const kept = nextWaId();
    const question = await inbound(c, waId, 'Is it in stock?');
    const other = await inbound(c, kept, 'Thanks!');
    const answer = await reply(c, ctx, waId, 'It is.');
    await answer.send();
    let at = (await readFeed(ctx)).cursor;
    const next = async () => {
      const read = await readFeed(ctx, at);
      at = read.cursor;
      return read.changes;
    };

    // Nothing that leaves the message's description as it was.
    const before = await rowsOf(answer.id);
    await fx.query(
      `UPDATE app.messages SET status = status, status_at = status_at, content = content,
              pricing = '{"billable": true}'::jsonb WHERE id = $1`,
      [answer.id],
    );
    expect(await next()).toEqual([]);
    expect(await rowsOf(answer.id)).toBe(before);

    // A failure, with its error.
    await status(c, answer.id, waId, 'failed');
    const failed = await next();
    expect(failed.map((ch) => [ch.id, ch.message?.status, ch.message?.error])).toEqual([
      [answer.id, 'failed', { code: '131026', title: 'Message undeliverable' }],
    ]);

    // Two changes in one transaction are one change, and a message has one row however often
    // it changes.
    const client = await fx.dbs.adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE app.messages SET status_at = now() WHERE id = $1', [answer.id]);
      await client.query(`UPDATE app.messages SET error_title = 'Not delivered' WHERE id = $1`, [
        answer.id,
      ]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(ids(await next())).toEqual([answer.id]);
    expect(await rowsOf(answer.id)).toBe(1);
    // An error alone is a change too.
    await fx.query(`UPDATE app.messages SET error_code = '131049' WHERE id = $1`, [answer.id]);
    expect((await next()).map((ch) => ch.message?.error)).toEqual([
      { code: '131049', title: 'Not delivered' },
    ]);

    // Erasing the contact redacts every message of theirs: each comes once more, as erased, with
    // nothing of it. Another contact's message stays as it was.
    const owner = await fx.ctx(c, c.owner);
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: (
        await fx.query<{ contact_id: string }>(
          `SELECT cv.contact_id FROM app.messages m JOIN app.conversations cv
              ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id WHERE m.id = $1`,
          [question],
        )
      )[0]!.contact_id,
      suppress: false,
    });
    const erased = await next();
    expect(erased).toEqual([
      { id: question, erased: true, message: null },
      { id: answer.id, erased: true, message: null },
    ]);
    expect(JSON.stringify(erased)).not.toContain(waId);
    const fromStart = await readFeed(ctx);
    expect(fromStart.changes.map((ch) => [ch.id, ch.erased, ch.message?.text ?? null])).toEqual([
      [other, false, 'Thanks!'],
      [question, true, null],
      [answer.id, true, null],
    ]);
  });

  it('never reads past a change still being saved, so following the cursor misses nothing', async () => {
    const c = await fx.company();
    const ctx = await apiKey(c, ['conversations.read']);
    const held = await inbound(c, nextWaId(), 'First');
    const later = await inbound(c, nextWaId(), 'Second');
    const last = await inbound(c, nextWaId(), 'Third');
    const start = await readFeed(ctx);
    expect(ids(start.changes)).toEqual([held, later, last]);

    const holder = await fx.dbs.adminPool.connect();
    let during: Awaited<ReturnType<typeof readFeed>>;
    let fromStart: Awaited<ReturnType<typeof readFeed>>;
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE app.messages SET status_at = now() WHERE id = $1`, [held]);
      // Saved after the held change began, and committed first.
      await fx.query(`UPDATE app.messages SET status_at = now() WHERE id = $1`, [later]);
      // Saved last, by the transaction that began first.
      await holder.query(`UPDATE app.messages SET status_at = now() WHERE id = $1`, [last]);
      during = await readFeed(ctx, start.cursor);
      fromStart = await readFeed(ctx);
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    // The committed change lies beyond the ones still being saved, so none is read yet.
    expect(during.changes).toEqual([]);
    // From the start, the messages the held transaction changes are read where they were; the one
    // already changed again waits for its new place.
    expect(ids(fromStart.changes)).toEqual([held, last]);
    // In the order of the transactions: both changes of the one that began first, then the other.
    const after = await readFeed(ctx, during.cursor);
    expect(ids(after.changes)).toEqual([held, last, later]);
    expect((await readFeed(ctx, after.cursor)).changes).toEqual([]);
    expect(ids((await readFeed(ctx)).changes)).toEqual([held, last, later]);
  });

  it('opens a cursor only for the company that read it and only in this feed, and refuses forged ones; a key needs conversations.read', async () => {
    const mine = await fx.company();
    const theirs = await fx.company();
    const ctx = await apiKey(mine, ['conversations.read']);
    const other = await apiKey(theirs, ['conversations.read']);
    const message = await inbound(mine, nextWaId(), 'Hello');
    await inbound(theirs, nextWaId(), 'Another company');
    const read = await readFeed(ctx);
    expect(ids(read.changes)).toEqual([message]);
    expect((await readFeed(other)).changes.map((ch) => ch.message?.text)).toEqual([
      'Another company',
    ]);

    const elsewhere = sealChangeCursor(
      new Keyring({ primaryKeyId: 'other', keys: { other: randomBytes(32) } }),
      'message-changes',
      mine.tenant.id,
      { xact: '0', id: '0' },
    );
    const contactFeed = sealContactChangeCursor(fx.keyring, mine.tenant.id, { xact: '0', id: '0' });
    const [version, keyId, iv, body, tag] = Buffer.from(read.cursor, 'base64url')
      .toString('utf8')
      .split(':') as [string, string, string, string, string];
    const flipped = `${body.startsWith('A') ? 'B' : 'A'}${body.slice(1)}`;
    const tampered = Buffer.from([version, keyId, iv, flipped, tag].join(':')).toString(
      'base64url',
    );
    for (const [key, cursor] of [
      [other, read.cursor],
      [ctx, elsewhere],
      [ctx, contactFeed],
      [ctx, tampered],
      [ctx, 'not-a-cursor'],
    ] as const) {
      expect(await refusal(apiMessageChanges(feedDeps(), key, { cursor }))).toEqual({
        code: 'validation_failed',
        paths: ['cursor'],
      });
    }
    const sender = await apiKey(mine, ['messages.reply', 'contacts.read']);
    expect((await refusal(apiMessageChanges(feedDeps(), sender, {}))).code).toBe('forbidden');

    // Only the trigger writes the rows: the runtime role cannot move a message, or add one.
    for (const statement of [
      sql`UPDATE app.message_changes SET xact = '1'`,
      sql`INSERT INTO app.message_changes (tenant_id, message_id) VALUES (${mine.tenant.id}, ${message})`,
    ]) {
      const refused = await refusalWithCause(
        fx.dbs.app.run(authorizedTenantScope(mine.tenant.id, mine.owner.id), (tx) =>
          tx.execute(statement),
        ),
      );
      expect(refused.code).toBe('forbidden');
      expect(refused.causes).toMatch(/permission denied for table message_changes/);
    }
  });
});
