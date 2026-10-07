import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7 } from '@w360/core';
import {
  apiCreateChatLink,
  apiGetChatLink,
  apiListChatLinks,
  apiUpdateChatLink,
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
 * Chat links through the public API (ADR-299, ADR-300) against real PostgreSQL: keys read the
 * company's links as the Growth pages do, with the same clicks and attributed conversations,
 * archived ones when asked, and each link with its clicks per day; another company's links are
 * never read. Keys add links on the company's active numbers, once per Idempotency-Key, change,
 * archive and restore them from a version, recorded as the key's.
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
const deps = () => ({
  db: fx.dbs.app,
  clock: systemClock,
  appBaseUrl: 'https://app.example.test',
});

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
      createdBy: 'member',
      createdByApiKeyId: null,
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

describe('chat links written through the API (ADR-300)', () => {
  it('adds links once per key, changes, archives and restores them as the key, as members do', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const writer = await apiKey(c, ['chat_links.read', 'chat_links.write']);
    const idempotency = { key: `links-${uuidv7()}`, requestHash: 'body-1' };

    const created = await apiCreateChatLink(
      deps(),
      writer,
      { name: 'Newsletter', channelId: c.channelAccountId, message: 'Hi from the newsletter' },
      idempotency,
    );
    expect(created.status).toBe(201);
    const link = created.body.data as Awaited<ReturnType<typeof apiGetChatLink>>;
    expect(link).toMatchObject({
      name: 'Newsletter',
      message: 'Hi from the newsletter',
      includeRef: true,
      archived: false,
      version: 1,
      createdBy: 'api',
      createdByApiKeyId: writer.key.id,
      channel: { id: c.channelAccountId, active: true },
      last30Days: { clicks: 0, conversations: 0 },
    });
    // A retry with the same key answers the first response and adds nothing.
    const again = await apiCreateChatLink(
      deps(),
      writer,
      { name: 'Newsletter', channelId: c.channelAccountId, message: 'Hi from the newsletter' },
      idempotency,
    );
    expect(again).toMatchObject({ status: 201, replayed: true, body: { data: { id: link.id } } });
    const [row] = await fx.query<{ by_member: string | null; by_key: string | null }>(
      `SELECT created_by_membership_id AS by_member, created_by_api_key_id AS by_key
         FROM app.chat_links WHERE id = $1`,
      [link.id],
    );
    expect(row).toEqual({ by_member: null, by_key: writer.key.id });
    expect(
      (await fx.query(`SELECT 1 FROM app.chat_links WHERE tenant_id = $1`, [c.tenant.id])).length,
    ).toBe(1);
    // Members see it under Growth, and its short link opens WhatsApp.
    const [shown] = await growth().listLinks(owner);
    expect(shown).toMatchObject({ id: link.id, waMeUrl: link.waMeUrl, refCode: link.refCode });
    expect(await followChatLink(fx.dbs.app, shown!.slug)).toBe(link.waMeUrl);

    // Only one of the company's active numbers.
    for (const channelId of [other.channelAccountId, uuidv7()]) {
      await expectAppError(
        apiCreateChatLink(deps(), writer, { name: 'Elsewhere', channelId }, null),
        'validation_failed',
        /active WhatsApp number/,
      );
    }

    // Changed from its version, the rest kept; a stale version is refused.
    const renamed = await apiUpdateChatLink(deps(), writer, link.id, {
      expectedVersion: 1,
      name: 'Newsletter (October)',
      includeRef: false,
    });
    expect(renamed).toMatchObject({
      name: 'Newsletter (October)',
      message: 'Hi from the newsletter',
      includeRef: false,
      version: 2,
      last30Days: { conversations: null },
    });
    await expectAppError(
      apiUpdateChatLink(deps(), writer, link.id, { expectedVersion: 1, name: 'Lost edit' }),
      'conflict',
      /its version is 2/,
    );
    // The same values again change nothing and add no audit entry.
    expect(
      await apiUpdateChatLink(deps(), writer, link.id, { name: 'Newsletter (October)' }),
    ).toMatchObject({ version: 2 });

    // Archived: the short link opens nothing and changes wait for a restore.
    expect(
      await apiUpdateChatLink(deps(), writer, link.id, { expectedVersion: 2, archived: true }),
    ).toMatchObject({ archived: true, version: 3 });
    expect(await followChatLink(fx.dbs.app, shown!.slug)).toBeNull();
    await expectAppError(
      apiUpdateChatLink(deps(), writer, link.id, { message: 'Too late' }),
      'conflict',
      /Restore the link/,
    );
    await expectAppError(
      apiUpdateChatLink(deps(), writer, link.id, { archived: false, name: 'Back' }),
      'validation_failed',
      /in a request of its own/,
    );
    expect(await apiUpdateChatLink(deps(), writer, link.id, { archived: false })).toMatchObject({
      archived: false,
      version: 4,
    });
    expect(await followChatLink(fx.dbs.app, shown!.slug)).not.toBeNull();

    // The audit log names the key for each change, never a member.
    const audit = await fx.query<{ action: string; actor_type: string; actor_id: string }>(
      `SELECT action, actor_type, actor_id FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 ORDER BY created_at, id`,
      [c.tenant.id, link.id],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'growth.link_created',
      'growth.link_updated',
      'growth.link_archived',
      'growth.link_restored',
    ]);
    expect(new Set(audit.map((a) => `${a.actor_type}:${a.actor_id}`))).toEqual(
      new Set([`api_key:${writer.key.id}`]),
    );

    // Another company's link is not found; suspended companies' keys write nothing; granting the
    // scope needs campaigns.write.
    const [theirs] = await fx.query<{ id: string }>(
      `SELECT id FROM app.chat_links WHERE tenant_id = $1 LIMIT 1`,
      [c.tenant.id],
    );
    const outsider = await apiKey(other, ['chat_links.write']);
    await expectAppError(
      apiUpdateChatLink(deps(), outsider, theirs!.id, { name: 'Mine' }),
      'not_found',
    );
    const suspended: ApiContext = {
      ...writer,
      tenant: { ...writer.tenant, status: 'suspended' as const },
    };
    await expectAppError(
      apiCreateChatLink(deps(), suspended, { name: 'Paused', channelId: c.channelAccountId }, null),
      'tenant_suspended',
    );
    const narrower: TenantContext = {
      ...owner,
      permissions: new Set([...owner.permissions].filter((p) => p !== 'campaigns.write')),
    };
    await expectAppError(
      keys().create(narrower, { name: 'Links', scopes: ['chat_links.write'], expiresInDays: 30 }),
      'forbidden',
      /Write chat links/,
    );

    // The database keeps exactly one author per link.
    for (const [member, key] of [
      [null, null],
      [owner.membership.id, writer.key.id],
    ]) {
      await expect(
        fx.query(
          `INSERT INTO app.chat_links (id, tenant_id, channel_account_id, name, ref_code, slug,
             created_by_membership_id, created_by_api_key_id)
           VALUES ($1, $2, $3, 'Authors', 'XYZ234', 'abcdefghjkmn', $4, $5)`,
          [uuidv7(), c.tenant.id, c.channelAccountId, member, key],
        ),
      ).rejects.toThrow(/chat_links_author/);
    }
  });
});
