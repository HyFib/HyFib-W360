import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock, uuidv7 } from '@w360/core';
import {
  apiCreateContact,
  apiListContactTags,
  apiListConversationTags,
  apiUpdateContact,
  apiUpdateConversation,
  authenticateApiToken,
  createApiKeysService,
  createContactsService,
  type ApiContext,
  type ApiScope,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * The tags in use through the public API (ADR-272) against real PostgreSQL: keys list the company's
 * contact tags and conversation tags alphabetically, each with how many contacts or conversations
 * have it, on pages that continue after the last tag, narrowed by a prefix; another company's tags,
 * an erased contact's and a tag nobody has any more are never listed.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx.close();
});

const deps = () => ({ db: fx.dbs.app, clock: systemClock });

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

/** A contact added through the API with the tags given; its id. */
async function contactWith(ctx: ApiContext, phone: string, tags: string[]) {
  const created = await apiCreateContact(
    deps(),
    ctx,
    { phone, name: `Customer ${phone}`, tags },
    null,
  );
  return (created.body.data as { id: string }).id;
}

/** A conversation the customer opened by writing. */
async function conversationWith(c: Company, waId: string) {
  await fx.deliver(fx.messagesBody(c, { messages: [{ waId, text: 'Is my parcel on its way?' }] }));
  const [row] = await fx.query<{ conversation_id: string }>(
    `SELECT m.conversation_id FROM app.messages m
      WHERE m.tenant_id = $1 AND m.type = 'text' ORDER BY m.created_at DESC LIMIT 1`,
    [c.tenant.id],
  );
  return row!.conversation_id;
}

describe('the tags in use through the API (ADR-272)', () => {
  it('lists the contact tags alphabetically with their contacts, page after page, by prefix', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const ctx = await apiKey(c, ['contacts.read', 'contacts.write']);
    const asha = await contactWith(ctx, '+919845003001', ['VIP', 'gold']);
    await contactWith(ctx, '+919845003002', ['vip']);
    const chitra = await contactWith(ctx, '+919845003003', ['New  Customer']);
    const deepa = await contactWith(ctx, '+919845003004', ['gold', 'vip']);
    await contactWith(await apiKey(other, ['contacts.write']), '+919845003005', ['secret']);
    const list = (query: Record<string, string>) => apiListContactTags(deps(), ctx, query);

    // Alphabetically, two to a page and the last on the next; another company's tag never.
    const first = await list({ limit: '2' });
    expect(first.data).toEqual([
      { tag: 'gold', contacts: 2 },
      { tag: 'new customer', contacts: 1 },
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const last = await list({ limit: '2', cursor: first.nextCursor! });
    expect(last).toEqual({ data: [{ tag: 'vip', contacts: 3 }], nextCursor: null });
    expect((await list({})).data.map((t) => t.tag)).toEqual(['gold', 'new customer', 'vip']);

    // A prefix, written as tags are, narrows the list.
    expect((await list({ prefix: ' V' })).data).toEqual([{ tag: 'vip', contacts: 3 }]);
    expect((await list({ prefix: 'NEW  c' })).data).toEqual([{ tag: 'new customer', contacts: 1 }]);
    expect((await list({ prefix: 'x' })).data).toEqual([]);

    // A page continues after its cursor's tag even once nobody has that tag any more.
    const one = await list({ limit: '1' });
    expect(one.data).toEqual([{ tag: 'gold', contacts: 2 }]);
    await apiUpdateContact(deps(), ctx, asha, { removeTags: ['gold'] });
    await apiUpdateContact(deps(), ctx, deepa, { removeTags: ['gold'] });
    expect((await list({ cursor: one.nextCursor! })).data.map((t) => t.tag)).toEqual([
      'new customer',
      'vip',
    ]);
    expect((await list({})).data.map((t) => t.tag)).not.toContain('gold');

    // An erased contact's tags are gone, and so is a tag removed from its last contact.
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(
      await fx.ctx(c, c.owner),
      { contactId: deepa, suppress: false },
    );
    await apiUpdateContact(deps(), ctx, chitra, { removeTags: ['new customer'] });
    expect((await list({})).data).toEqual([{ tag: 'vip', contacts: 2 }]);
  });

  it('lists the conversation tags alphabetically with their conversations, page after page, by prefix', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const ctx = await apiKey(c, ['conversations.read', 'conversations.write']);
    const first = await conversationWith(c, '919845003101');
    const second = await conversationWith(c, '919845003102');
    const third = await conversationWith(c, '919845003103');
    const theirs = await conversationWith(other, '919845003104');
    await apiUpdateConversation(deps(), ctx, first, { addTags: ['refund', 'Urgent'] });
    await apiUpdateConversation(deps(), ctx, second, { addTags: ['refund'] });
    await apiUpdateConversation(deps(), ctx, third, { addTags: ['delivery delay', 'urgent'] });
    await apiUpdateConversation(deps(), await apiKey(other, ['conversations.write']), theirs, {
      addTags: ['secret'],
    });
    const list = (query: Record<string, string>) => apiListConversationTags(deps(), ctx, query);

    const page = await list({ limit: '2' });
    expect(page.data).toEqual([
      { tag: 'delivery delay', conversations: 1 },
      { tag: 'refund', conversations: 2 },
    ]);
    expect(await list({ limit: '2', cursor: page.nextCursor! })).toEqual({
      data: [{ tag: 'urgent', conversations: 2 }],
      nextCursor: null,
    });
    expect((await list({ prefix: 'Delivery' })).data).toEqual([
      { tag: 'delivery delay', conversations: 1 },
    ]);

    // A tag removed from its last conversation is not listed; the counts follow the changes.
    await apiUpdateConversation(deps(), ctx, third, { removeTags: ['delivery delay'] });
    await apiUpdateConversation(deps(), ctx, first, { removeTags: ['refund'] });
    expect((await list({})).data).toEqual([
      { tag: 'refund', conversations: 1 },
      { tag: 'urgent', conversations: 2 },
    ]);
  });
});
