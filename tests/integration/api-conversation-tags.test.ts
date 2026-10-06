import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock, uuidv7 } from '@w360/core';
import {
  apiGetConversation,
  apiListConversations,
  apiUpdateConversation,
  apiUpdateManyConversations,
  apiUpdateMatchingConversations,
  authenticateApiToken,
  createApiKeysService,
  createContactsService,
  createConversationTagsService,
  createInboxService,
  type ApiContext,
  type ApiScope,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Conversation tags through the public API (ADR-221) against real PostgreSQL: keys read the tags
 * members put on conversations, list the conversations with a tag, and tag them one at a time,
 * many at once or by a filter, at most 20 on a conversation; a change of the tags is a change of
 * the conversation, for keys and members alike.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx.close();
});

const deps = () => ({ db: fx.dbs.app, clock: systemClock });
const tags = () => createConversationTagsService({ db: fx.dbs.app });

async function apiKey(c: Company, scopes: ApiScope[]): Promise<ApiContext> {
  const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
  const created = await keys.create(await fx.ctx(c, c.owner), {
    name: `Tags ${uuidv7().slice(-6)}`,
    scopes,
    expiresInDays: 0,
  });
  const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
  if (!ctx) throw new Error('a new key does not authenticate');
  return ctx;
}

/** A conversation the customer opened by writing, with its contact. */
async function conversationWith(c: Company, waId: string) {
  await fx.deliver(fx.messagesBody(c, { messages: [{ waId, text: 'Is my parcel on its way?' }] }));
  const [row] = await fx.query<{ conversation_id: string; contact_id: string }>(
    `SELECT m.conversation_id, cv.contact_id FROM app.messages m
       JOIN app.conversations cv ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
      WHERE m.tenant_id = $1 AND m.type = 'text' ORDER BY m.created_at DESC LIMIT 1`,
    [c.tenant.id],
  );
  return { id: row!.conversation_id, contactId: row!.contact_id };
}

const updatedAt = async (id: string) =>
  (
    await fx.query<{ updated_at: Date }>('SELECT updated_at FROM app.conversations WHERE id = $1', [
      id,
    ])
  )[0]!.updated_at;

describe('conversation tags through the API (ADR-221)', () => {
  it('reads, lists by and changes the tags members see, as a change of the conversation', async () => {
    const c = await fx.company();
    const ctx = await apiKey(c, ['conversations.read', 'conversations.write']);
    const owner = await fx.ctx(c, c.owner);
    const first = await conversationWith(c, '919845002001');
    const second = await conversationWith(c, '919845002002');

    // A member's tags show through the API, and a member's change moves updatedAt.
    const before = await updatedAt(first.id);
    await tags().addTags(owner, { conversationId: first.id, tags: 'vip' });
    expect((await updatedAt(first.id)).getTime()).toBeGreaterThan(before.getTime());
    expect((await apiGetConversation(deps(), ctx, first.id)).tags).toEqual(['vip']);

    // A key adds and removes, written as members write tags.
    const changed = await apiUpdateConversation(deps(), ctx, first.id, {
      addTags: [' Refund ', 'FOLLOW  up'],
      removeTags: ['VIP', 'never there'],
    });
    expect(changed.tags).toEqual(['follow up', 'refund']);
    expect(Date.parse(changed.updatedAt)).toBeGreaterThan(before.getTime());
    const [audit] = await fx.query<{ metadata: Record<string, unknown>; actor_id: string }>(
      `SELECT metadata, actor_id FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'conversation.tags_changed' AND subject_id = $2`,
      [c.tenant.id, first.id],
    );
    expect(audit).toEqual({
      metadata: { added: 2, removed: 1, source: 'api' },
      actor_id: ctx.key.id,
    });
    const [event] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.tenant_events
        WHERE conversation_id = $1 AND type = 'conversation.tags'`,
      [first.id],
    );
    expect(event!.n).toBe(2);
    // The same change again changes nothing: no audit entry, the same updatedAt.
    const again = await apiUpdateConversation(deps(), ctx, first.id, { addTags: ['refund'] });
    expect(again.updatedAt).toBe(changed.updatedAt);
    // Members see the key's tags in the inbox.
    expect((await tags().tagsInUse(owner)).map((t) => t.tag)).toEqual(['follow up', 'refund']);

    // Listed by a tag, however it is cased; the filter combines with the others.
    const listed = (q: Record<string, unknown>) =>
      apiListConversations(deps(), ctx, q).then((r) => r.data.map((v) => v.id));
    expect(await listed({ tag: 'REFUND' })).toEqual([first.id]);
    expect(await listed({ tag: 'refund', status: 'resolved' })).toEqual([]);
    expect(await listed({ tag: 'unused' })).toEqual([]);
    expect((await listed({})).sort()).toEqual([first.id, second.id].sort());
    await expect(apiListConversations(deps(), ctx, { tag: 'a,b' })).rejects.toMatchObject({
      code: 'validation_failed',
      issues: [{ path: 'tag' }],
    });

    // At most 20 tags: a change that would give more is refused whole.
    const eighteen = Array.from({ length: 18 }, (_, i) => `t${i}`);
    await apiUpdateConversation(deps(), ctx, first.id, { addTags: eighteen });
    await expect(
      apiUpdateConversation(deps(), ctx, first.id, { addTags: ['one', 'two'], status: 'resolved' }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      issues: [{ path: 'addTags', message: expect.stringContaining('at most 20 tags') }],
    });
    const kept = await apiGetConversation(deps(), ctx, first.id);
    expect(kept.tags).toHaveLength(20);
    expect(kept.status).toBe('open');
    // Removing one makes room in the same change.
    expect(
      (await apiUpdateConversation(deps(), ctx, first.id, { addTags: ['one'], removeTags: ['t0'] }))
        .tags,
    ).toHaveLength(20);
  });

  it('tags many conversations at once or by a filter, all of a call or none', async () => {
    const c = await fx.company();
    const ctx = await apiKey(c, ['conversations.read', 'conversations.write']);
    const a = await conversationWith(c, '919845002101');
    const b = await conversationWith(c, '919845002102');
    const full = await conversationWith(c, '919845002103');
    await apiUpdateConversation(deps(), ctx, full.id, {
      addTags: Array.from({ length: 20 }, (_, i) => `t${i}`),
    });

    const many = await apiUpdateManyConversations(deps(), ctx, {
      conversationIds: [b.id, a.id],
      addTags: ['Callback'],
    });
    expect(many.map((v) => [v.id, v.tags])).toEqual([
      [b.id, ['callback']],
      [a.id, ['callback']],
    ]);
    // One conversation that would have more than 20 refuses the whole call.
    await expect(
      apiUpdateManyConversations(deps(), ctx, {
        conversationIds: [a.id, full.id],
        addTags: ['urgent'],
      }),
    ).rejects.toMatchObject({ issues: [{ path: 'addTags' }] });
    expect((await apiGetConversation(deps(), ctx, a.id)).tags).toEqual(['callback']);

    // By a filter: the tag goes from every conversation that has it, and none is read again.
    const page = await apiUpdateMatchingConversations(deps(), ctx, {
      filter: { tag: 'callback' },
      change: { removeTags: ['callback'], addTags: ['called'] },
      limit: 1,
    });
    expect(page.data.map((v) => v.tags)).toEqual([['called']]);
    const rest = await apiUpdateMatchingConversations(deps(), ctx, {
      filter: { tag: 'callback' },
      change: { removeTags: ['callback'], addTags: ['called'] },
      limit: 1,
      cursor: page.nextCursor ?? undefined,
    });
    expect([...page.data, ...rest.data].map((v) => v.id).sort()).toEqual([a.id, b.id].sort());
    expect(
      (await apiListConversations(deps(), ctx, { tag: 'callback' })).data.map((v) => v.id),
    ).toEqual([]);
    await expect(
      apiUpdateMatchingConversations(deps(), ctx, {
        filter: { tag: 't1' },
        change: { addTags: ['urgent'] },
      }),
    ).rejects.toMatchObject({ issues: [{ path: 'change.addTags' }] });
  });

  it('keeps tags to the company, and away from erased contacts', async () => {
    const c = await fx.company();
    const ctx = await apiKey(c, ['conversations.read', 'conversations.write']);
    const reader = await apiKey(c, ['conversations.read']);
    const conv = await conversationWith(c, '919845002201');
    await apiUpdateConversation(deps(), ctx, conv.id, { addTags: ['legal'] });

    await expect(
      apiUpdateConversation(deps(), reader, conv.id, { addTags: ['x'] }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const d = await fx.company();
    const outsider = await apiKey(d, ['conversations.read', 'conversations.write']);
    await expect(
      apiUpdateConversation(deps(), outsider, conv.id, { addTags: ['x'] }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect((await apiListConversations(deps(), outsider, { tag: 'legal' })).data).toEqual([]);

    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(
      await fx.ctx(c, c.owner),
      { contactId: conv.contactId, suppress: false },
    );
    await expect(
      apiUpdateConversation(deps(), ctx, conv.id, { addTags: ['x'] }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect((await apiListConversations(deps(), ctx, { tag: 'legal' })).data).toEqual([]);
    expect(
      await fx.query('SELECT tag FROM app.conversation_tags WHERE conversation_id = $1', [conv.id]),
    ).toEqual([]);
    // The inbox's list shows no erased tag either.
    const inbox = createInboxService({ db: fx.dbs.app, clock: systemClock });
    const items = (await inbox.listConversations(await fx.ctx(c, c.owner), {})).items;
    expect(items.find((i) => i.id === conv.id)?.tags ?? []).toEqual([]);
  });
});
