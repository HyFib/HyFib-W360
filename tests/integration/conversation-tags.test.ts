import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock, uuidv7 } from '@w360/core';
import {
  MAX_TAGS_PER_CONVERSATION,
  createContactsService,
  createConversationTagsService,
  createInboxService,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Conversation tags (ADR-220) against real PostgreSQL: members who can reply tag conversations
 * they can see, the inbox shows the tags and lists the conversations with one, the filter offers
 * only tags on conversations the member can see, and erasing the contact deletes the tags.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx.close();
});

const tags = () => createConversationTagsService({ db: fx.dbs.app });
const inbox = () => createInboxService({ db: fx.dbs.app, clock: systemClock });

/** A conversation the customer opened by writing. */
async function conversationWith(c: Company, waId: string) {
  await fx.deliver(fx.messagesBody(c, { messages: [{ waId, text: 'Where is my refund?' }] }));
  const [row] = await fx.query<{ conversation_id: string; contact_id: string }>(
    `SELECT m.conversation_id, cv.contact_id FROM app.messages m
       JOIN app.conversations cv ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
      WHERE m.tenant_id = $1 AND m.type = 'text' ORDER BY m.created_at DESC LIMIT 1`,
    [c.tenant.id],
  );
  return { conversationId: row!.conversation_id, contactId: row!.contact_id };
}

const tagEvents = async (conversationId: string) =>
  (
    await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.tenant_events
        WHERE conversation_id = $1 AND type = 'conversation.tags'`,
      [conversationId],
    )
  )[0]!.n;

describe('conversation tags (ADR-220)', () => {
  it('tags a conversation, shows and filters the inbox by its tags, and removes them', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { conversationId } = await conversationWith(c, '919845001001');
    const other = await conversationWith(c, '919845001002');

    // Written as tags are, without repeats; blank pieces are skipped.
    expect(
      await tags().addTags(owner, { conversationId, tags: ' Refund , VIP,refund,, ' }),
    ).toEqual({ tags: ['refund', 'vip'], added: ['refund', 'vip'] });
    expect(await tags().addTags(owner, { conversationId, tags: 'vip, Follow   up' })).toEqual({
      tags: ['follow up', 'refund', 'vip'],
      added: ['follow up'],
    });
    // Nothing new: no change and no live event.
    expect(await tags().addTags(owner, { conversationId, tags: 'VIP' })).toEqual({
      tags: ['follow up', 'refund', 'vip'],
      added: [],
    });
    expect(await tagEvents(conversationId)).toBe(2);
    await tags().addTags(owner, { conversationId: other.conversationId, tags: 'vip' });

    // The inbox shows each conversation's tags and lists those with a tag, however it is typed.
    const tagged = await inbox().listConversations(owner, { tag: ' VIP ' });
    expect(tagged.items.map((i) => [i.id, i.tags]).sort()).toEqual(
      [
        [conversationId, ['follow up', 'refund', 'vip']],
        [other.conversationId, ['vip']],
      ].sort(),
    );
    expect(
      (await inbox().listConversations(owner, { tag: 'refund' })).items.map((i) => i.id),
    ).toEqual([conversationId]);
    expect((await inbox().listConversations(owner, { tag: 'unused' })).items).toEqual([]);
    // A value that cannot be a tag matches nothing.
    expect((await inbox().listConversations(owner, { tag: 'a,b' })).items).toEqual([]);
    expect((await inbox().listConversations(owner, {})).items).toHaveLength(2);
    expect((await inbox().getConversation(owner, conversationId)).conversation.tags).toEqual([
      'follow up',
      'refund',
      'vip',
    ]);
    expect(await tags().tagsInUse(owner)).toEqual([
      { tag: 'follow up', conversations: 1 },
      { tag: 'refund', conversations: 1 },
      { tag: 'vip', conversations: 2 },
    ]);

    // At most 20 tags on a conversation, and none that cannot be a tag.
    const more = Array.from({ length: MAX_TAGS_PER_CONVERSATION - 3 }, (_, i) => `t${i}`);
    expect(
      (await tags().addTags(owner, { conversationId, tags: more.join(',') })).tags,
    ).toHaveLength(MAX_TAGS_PER_CONVERSATION);
    await expect(tags().addTags(owner, { conversationId, tags: 'one more' })).rejects.toMatchObject(
      {
        code: 'validation_failed',
        publicMessage: 'A conversation can have at most 20 tags.',
        issues: [{ path: 'tags' }],
      },
    );
    await expect(
      tags().addTags(owner, { conversationId, tags: 'x'.repeat(41) }),
    ).rejects.toMatchObject({ code: 'validation_failed', issues: [{ path: 'tags' }] });
    await expect(tags().addTags(owner, { conversationId, tags: ' , ' })).rejects.toMatchObject({
      code: 'validation_failed',
      publicMessage: 'Write a tag.',
    });

    // Removing: a tag it has goes once; one it does not have changes nothing.
    expect(await tags().removeTag(owner, { conversationId, tag: 'VIP' })).toMatchObject({
      removed: true,
    });
    const events = await tagEvents(conversationId);
    expect(await tags().removeTag(owner, { conversationId, tag: 'vip' })).toMatchObject({
      removed: false,
    });
    expect(await tagEvents(conversationId)).toBe(events);
    expect((await inbox().listConversations(owner, { tag: 'vip' })).items.map((i) => i.id)).toEqual(
      [other.conversationId],
    );
  });

  it('keeps tags to members who can reply and see the conversation, and to its company', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const { conversationId } = await conversationWith(c, '919845001101');
    await tags().addTags(owner, { conversationId, tags: 'legal' });

    // A marketer has no inbox: they neither tag nor see the tags in use.
    const marketer = await fx.ctx(c, c.marketer);
    await expect(tags().addTags(marketer, { conversationId, tags: 'x' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      tags().removeTag(marketer, { conversationId, tag: 'legal' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(tags().tagsInUse(marketer)).rejects.toMatchObject({ code: 'forbidden' });

    // An agent tags unassigned conversations, but not one assigned to someone else, whose tags
    // the filter no longer offers them.
    expect((await tags().addTags(agent, { conversationId, tags: 'callback' })).tags).toEqual([
      'callback',
      'legal',
    ]);
    const [ownerMembership] = await fx.query<{ id: string }>(
      'SELECT id FROM app.memberships WHERE tenant_id = $1 AND user_id = $2',
      [c.tenant.id, c.owner.id],
    );
    await fx.query('UPDATE app.conversations SET assigned_membership_id = $1 WHERE id = $2', [
      ownerMembership!.id,
      conversationId,
    ]);
    await expect(tags().addTags(agent, { conversationId, tags: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(tags().removeTag(agent, { conversationId, tag: 'legal' })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await tags().tagsInUse(agent)).toEqual([]);
    expect((await inbox().listConversations(agent, { tag: 'legal' })).items).toEqual([]);
    expect(await tags().tagsInUse(owner)).toEqual([
      { tag: 'callback', conversations: 1 },
      { tag: 'legal', conversations: 1 },
    ]);

    // Another company sees neither the conversation nor its tags.
    const d = await fx.company();
    const outsider = await fx.ctx(d, d.owner);
    await expect(tags().addTags(outsider, { conversationId, tags: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      tags().removeTag(outsider, { conversationId, tag: 'legal' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await tags().tagsInUse(outsider)).toEqual([]);
    await expect(
      tags().addTags(owner, { conversationId: uuidv7(), tags: 'x' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      tags().addTags(owner, { conversationId: 'nope', tags: 'x' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('deletes the tags of the contact’s conversations when the contact is erased', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const erased = await conversationWith(c, '919845001201');
    const kept = await conversationWith(c, '919845001202');
    await tags().addTags(owner, { conversationId: erased.conversationId, tags: 'pregnant, vip' });
    await tags().addTags(owner, { conversationId: kept.conversationId, tags: 'vip' });

    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: erased.contactId,
      suppress: false,
    });
    expect(
      await fx.query('SELECT tag FROM app.conversation_tags WHERE conversation_id = $1', [
        erased.conversationId,
      ]),
    ).toEqual([]);
    expect(
      await fx.query('SELECT tag FROM app.conversation_tags WHERE conversation_id = $1', [
        kept.conversationId,
      ]),
    ).toEqual([{ tag: 'vip' }]);
    // Nothing about the person can be tagged again.
    await expect(
      tags().addTags(owner, { conversationId: erased.conversationId, tags: 'vip' }),
    ).rejects.toMatchObject({ code: 'conflict', publicMessage: 'This contact was erased.' });
    expect(await tags().tagsInUse(owner)).toEqual([{ tag: 'vip', conversations: 1 }]);
  });
});
