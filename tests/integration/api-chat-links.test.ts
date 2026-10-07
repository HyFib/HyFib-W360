import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7 } from '@w360/core';
import {
  apiGetChatLink,
  apiListChatLinks,
  authenticateApiToken,
  createApiKeysService,
  createGrowthService,
  followChatLink,
  type ApiContext,
  type ApiScope,
  type TenantContext,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Chat links through the public API (ADR-299) against real PostgreSQL: keys read the company's
 * links as the Growth pages do, with the same clicks and attributed conversations, archived ones
 * when asked, and each link with its clicks per day; another company's links are never read.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx?.close();
});

const growth = () => createGrowthService({ db: fx.dbs.app, clock: systemClock });
const keys = () => createApiKeysService({ db: fx.dbs.app, clock: systemClock });
const deps = () => ({ db: fx.dbs.app, appBaseUrl: 'https://app.example.test' });

async function expectAppError(promise: Promise<unknown>, code: string, message?: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe(code);
      if (message) expect(error.publicMessage).toMatch(message);
    }
    return;
  }
  throw new Error(`expected ${code}`);
}

async function apiKey(c: Company, scopes: ApiScope[]): Promise<ApiContext> {
  const created = await keys().create(await fx.ctx(c, c.owner), {
    name: `Links ${uuidv7().slice(-6)}`,
    scopes,
    expiresInDays: 0,
  });
  const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
  if (!ctx) throw new Error('a new key does not authenticate');
  return ctx;
}

/** A link a member made on the company's number, as the Growth pages read it. */
async function newLink(ctx: TenantContext, c: Company, name: string, includeRef: boolean) {
  const { id } = await growth().createLink(ctx, {
    name,
    channelAccountId: c.channelAccountId,
    message: 'Hello from Instagram',
    includeRef,
  });
  return (await growth().getLink(ctx, id)).link;
}

describe('chat links through the API (ADR-299)', () => {
  it('lists and reads the links as the Growth pages do, with their clicks and conversations', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const key = await apiKey(c, ['chat_links.read']);
    const first = await newLink(owner, c, 'Instagram bio', true);
    const second = await newLink(owner, c, 'Shop window', false);
    const theirs = await newLink(await fx.ctx(other, other.owner), other, 'Their link', true);

    // Two clicks and a conversation for the first link, a click for the second and for theirs.
    expect(await followChatLink(fx.dbs.app, first.slug)).toBe(first.waMeUrl);
    expect(await followChatLink(fx.dbs.app, first.slug)).toBe(first.waMeUrl);
    expect(await followChatLink(fx.dbs.app, second.slug)).toBe(second.waMeUrl);
    expect(await followChatLink(fx.dbs.app, theirs.slug)).toBe(theirs.waMeUrl);
    await fx.deliver(
      fx.messagesBody(c, {
        messages: [{ waId: '919811100501', text: `Hello from Instagram (ref ${first.refCode})` }],
      }),
    );

    const listed = await apiListChatLinks(deps(), key, {});
    expect(listed.nextCursor).toBeNull();
    expect(listed.data.map((l) => l.id)).toEqual([second.id, first.id]);
    expect(listed.data[1]).toEqual({
      id: first.id,
      name: 'Instagram bio',
      message: 'Hello from Instagram',
      refCode: first.refCode,
      includeRef: true,
      shortUrl: `https://app.example.test/l/${first.slug}`,
      waMeUrl: first.waMeUrl,
      channel: { id: c.channelAccountId, phone: '+91 90000 00000', active: true },
      archived: false,
      version: 1,
      createdAt: first.createdAt,
      updatedAt: expect.any(String),
      last30Days: { clicks: 2, conversations: 1 },
    });
    // A link without its reference counts no conversations.
    expect(listed.data[0]?.last30Days).toEqual({ clicks: 1, conversations: null });
    // The Growth pages count the same.
    for (const shown of await growth().listLinks(owner)) {
      const read = listed.data.find((l) => l.id === shown.id);
      expect(read?.last30Days.clicks).toBe(shown.clicks30);
      expect(read?.last30Days.conversations).toBe(shown.includeRef ? shown.conversations30 : null);
    }

    // Exact pages.
    const page = await apiListChatLinks(deps(), key, { limit: '1' });
    expect(page.data.map((l) => l.id)).toEqual([second.id]);
    expect(await apiListChatLinks(deps(), key, { limit: '1', cursor: page.nextCursor! })).toEqual({
      data: [listed.data[1]],
      nextCursor: null,
    });

    // One link with the days it was clicked on, as the link's page shows them.
    const detail = await apiGetChatLink(deps(), key, first.id);
    const { days } = await growth().getLink(owner, first.id);
    expect(detail).toEqual({ ...listed.data[1], clicksByDay: [...days].reverse() });
    expect(detail.clicksByDay).toEqual([
      { day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), clicks: 2 },
    ]);

    // Archived links only when asked, and still read one by one.
    await growth().setLinkArchived(owner, { id: second.id, expectedVersion: 1 }, true);
    expect((await apiListChatLinks(deps(), key, {})).data.map((l) => l.id)).toEqual([first.id]);
    expect((await apiListChatLinks(deps(), key, { archived: 'true' })).data).toEqual([
      expect.objectContaining({ id: second.id, archived: true, version: 2 }),
    ]);
    expect((await apiGetChatLink(deps(), key, second.id)).archived).toBe(true);

    // Another company's link is not found; a suspended company's keys read; a key without the
    // scope is refused; granting it needs campaigns.read.
    await expectAppError(apiGetChatLink(deps(), key, theirs.id), 'not_found');
    const suspended: ApiContext = {
      ...key,
      tenant: { ...key.tenant, status: 'suspended' as const },
    };
    expect((await apiListChatLinks(deps(), suspended, {})).data).toHaveLength(1);
    await expectAppError(
      apiListChatLinks(deps(), await apiKey(c, ['campaigns.read']), {}),
      'forbidden',
      /chat_links\.read/,
    );
    const narrower: TenantContext = {
      ...owner,
      permissions: new Set([...owner.permissions].filter((p) => p !== 'campaigns.read')),
    };
    await expectAppError(
      keys().create(narrower, { name: 'Links', scopes: ['chat_links.read'], expiresInDays: 30 }),
      'forbidden',
      /Read chat links/,
    );
  });
});
