import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7 } from '@w360/core';
import { authorizedTenantScope, channelAccounts, sql } from '@w360/db';
import {
  GROWTH_LIMITS,
  chatWidgetConfig,
  createContactsService,
  createGrowthService,
  createInboxService,
  followChatLink,
  newRefCode,
  newSlug,
  newWidgetId,
  renderWidgetScript,
  type TenantContext,
} from '@w360/domain';
import { acceptInvitation, createUser, invite, type TestUser } from './helpers';
import {
  nextExternalId,
  startWhatsAppFixture,
  type Company,
  type WhatsAppFixture,
} from './whatsapp-fixture';

/**
 * Growth tools against real PostgreSQL: chat links (permissions, validation, versions, archive,
 * audit), the public short link (clicks counted per link and company day, nothing for archived
 * links, inactive numbers or deleted companies), reference-code attribution on the link's own
 * number only, click-to-WhatsApp ad sources without the ad click id, the inbox source line,
 * erasure, website widgets, limits and company isolation.
 */
let fx: WhatsAppFixture;
beforeAll(async () => {
  fx = await startWhatsAppFixture();
});
afterAll(async () => {
  await fx?.close();
});

const growth = () => createGrowthService({ db: fx.dbs.app, clock: systemClock });
const inbox = () => createInboxService({ db: fx.dbs.app, clock: systemClock });
const waId = () => `91${randomInt(7_000_000_000, 9_999_999_999)}`;

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

async function member(c: Company, role: string): Promise<TestUser> {
  const user = await createUser(fx.dbs, { name: `A ${role}` });
  const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, [role]);
  await acceptInvitation(fx.dbs, user, token);
  return user;
}

/** A second number of the same company (bound to its WhatsApp account so messages can arrive). */
async function addChannel(c: Company, status: 'active' | 'disconnected') {
  const id = uuidv7();
  const phoneNumberId = nextExternalId();
  await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), async (tx) => {
    await tx.insert(channelAccounts).values({
      id,
      tenantId: c.tenant.id,
      whatsappAccountId: c.whatsappAccountId,
      phoneNumberId,
      status,
      displayPhoneNumber: '+91 90000 11111',
    });
    await tx.execute(
      sql`select app.bind_provider_asset('meta_whatsapp', 'phone_number', ${phoneNumberId}, ${id}::uuid, ${c.wabaId})`,
    );
  });
  return { id, phoneNumberId };
}

async function newLink(ctx: TenantContext, c: Company, overrides: Record<string, unknown> = {}) {
  const { id } = await growth().createLink(ctx, {
    name: 'Instagram bio',
    channelAccountId: c.channelAccountId,
    message: 'Hello from Instagram',
    includeRef: true,
    ...overrides,
  });
  const { link } = await growth().getLink(ctx, id);
  return link;
}

async function conversationOf(c: Company, from: string) {
  const [row] = await fx.query<{ id: string; contact_id: string }>(
    `SELECT cv.id, cv.contact_id FROM app.conversations cv
       JOIN app.contact_identities i ON i.tenant_id = cv.tenant_id AND i.contact_id = cv.contact_id
      WHERE cv.tenant_id = $1 AND i.wa_id = $2`,
    [c.tenant.id, from],
  );
  if (!row) throw new Error('conversation not created');
  return row;
}

/** A text message with a click-to-WhatsApp ad referral attached, as the webhook sends it. */
function adMessage(
  c: Company,
  from: string,
  text: string,
  referral: Record<string, unknown>,
  secondsAgo = 0,
) {
  const timestamp = Math.floor(Date.now() / 1000) - secondsAgo;
  const body = fx.messagesBody(c, { messages: [{ waId: from, text, timestamp }] }) as {
    entry: { changes: { value: { messages: Record<string, unknown>[] } }[] }[];
  };
  body.entry[0]!.changes[0]!.value.messages[0]!.referral = referral;
  return body;
}

const diwaliAd = {
  source_url: 'https://fb.me/diwali',
  source_id: '120200000000001',
  source_type: 'ad',
  headline: 'Diwali offer',
  body: 'Twenty percent off every order this week',
  media_type: 'image',
  image_url: 'https://scontent.example.test/ad.jpg',
  ctwa_clid:
    'ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNDBH0CD3qpjd0HR4irJ6LEkR7JwFF4XvnO2E4Nx0-eM-GABDLOPaOdRMv-_zfUQ2a',
};

async function sources(tenantId: string) {
  return fx.query<{
    kind: string;
    link_id: string | null;
    contact_id: string;
    conversation_id: string;
    ad_source_id: string | null;
    ad_source_type: string | null;
    ad_source_url: string | null;
    ad_headline: string | null;
    row: string;
  }>(
    `SELECT s.kind, s.link_id, s.contact_id, s.conversation_id, s.ad_source_id, s.ad_source_type,
            s.ad_source_url, s.ad_headline, to_jsonb(s)::text AS row
       FROM app.conversation_sources s WHERE s.tenant_id = $1 ORDER BY s.occurred_at, s.id`,
    [tenantId],
  );
}

const companyDay = async () =>
  (
    await fx.query<{ day: string }>(`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS day`)
  )[0]!.day;

describe('chat links', () => {
  it('creates, edits, archives and restores links with permissions, versions and audit', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const marketer = await fx.ctx(c, c.marketer);
    const agent = await fx.ctx(c, c.agent);
    const supervisor = await fx.ctx(c, await member(c, 'supervisor'));
    const analyst = await fx.ctx(c, await member(c, 'analyst'));

    const link = await newLink(marketer, c);
    expect(link).toMatchObject({
      name: 'Instagram bio',
      message: 'Hello from Instagram',
      includeRef: true,
      channelAccountId: c.channelAccountId,
      channelActive: true,
      archivedAt: null,
      version: 1,
      clicks30: 0,
      conversations30: 0,
    });
    expect(link.refCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(link.slug).toMatch(/^[a-z2-7]{12}$/);
    expect(link.waMeUrl).toBe(
      `https://wa.me/919000000000?text=Hello%20from%20Instagram%20(ref%20${link.refCode})`,
    );

    // Reading needs campaigns.read (supervisors and analysts read; agents do not), writing needs
    // campaigns.write (marketers and owners).
    expect((await growth().listLinks(supervisor)).map((l) => l.id)).toEqual([link.id]);
    expect((await growth().getLink(analyst, link.id)).canManage).toBe(false);
    expect((await growth().getLink(owner, link.id)).canManage).toBe(true);
    await expectAppError(growth().listLinks(agent), 'forbidden');
    await expectAppError(growth().getLink(agent, link.id), 'forbidden');
    for (const reader of [supervisor, analyst, agent]) {
      await expectAppError(
        growth().createLink(reader, {
          name: 'Nope',
          channelAccountId: c.channelAccountId,
          message: '',
          includeRef: false,
        }),
        'forbidden',
      );
      await expectAppError(
        growth().setLinkArchived(reader, { id: link.id, expectedVersion: 1 }, true),
        'forbidden',
      );
    }

    // Only the company's active numbers can be chosen, and names are required and bounded.
    const disconnected = await addChannel(c, 'disconnected');
    expect(await growth().channelOptions(owner)).toEqual(
      expect.arrayContaining([
        { id: c.channelAccountId, name: '+91 90000 00000', active: true },
        { id: disconnected.id, name: '+91 90000 11111', active: false },
      ]),
    );
    await expectAppError(
      newLink(owner, c, { channelAccountId: disconnected.id }),
      'validation_failed',
      /active WhatsApp number/,
    );
    await expectAppError(newLink(owner, c, { name: '  ' }), 'validation_failed');
    await expectAppError(newLink(owner, c, { name: 'x'.repeat(81) }), 'validation_failed');
    await expectAppError(newLink(owner, c, { message: 'x'.repeat(501) }), 'validation_failed');

    // Edits carry the version they started from; a stale one is refused.
    const edited = await growth().updateLink(owner, {
      id: link.id,
      expectedVersion: 1,
      name: 'Instagram bio (autumn)',
      channelAccountId: c.channelAccountId,
      message: '  I saw your autumn post  ',
      includeRef: false,
    });
    expect(edited).toEqual({ version: 2 });
    await expectAppError(
      growth().updateLink(marketer, {
        id: link.id,
        expectedVersion: 1,
        name: 'Lost edit',
        channelAccountId: c.channelAccountId,
        message: '',
        includeRef: true,
      }),
      'conflict',
      /Someone else changed this/,
    );
    await expectAppError(
      growth().updateLink(owner, {
        id: link.id,
        expectedVersion: 2,
        name: 'Moved',
        channelAccountId: disconnected.id,
        message: '',
        includeRef: true,
      }),
      'validation_failed',
    );
    const afterEdit = (await growth().getLink(owner, link.id)).link;
    expect(afterEdit).toMatchObject({
      name: 'Instagram bio (autumn)',
      message: 'I saw your autumn post',
      includeRef: false,
      refCode: link.refCode,
      slug: link.slug,
      version: 2,
    });
    // Without the reference code the message is sent as written.
    expect(afterEdit.waMeUrl).toBe(
      'https://wa.me/919000000000?text=I%20saw%20your%20autumn%20post',
    );

    // Archived links leave the list, cannot be edited until restored, and archiving is idempotent.
    expect(
      await growth().setLinkArchived(owner, { id: link.id, expectedVersion: 2 }, true),
    ).toEqual({ version: 3 });
    expect(
      await growth().setLinkArchived(owner, { id: link.id, expectedVersion: 3 }, true),
    ).toEqual({ version: 3 });
    expect(await growth().listLinks(owner)).toEqual([]);
    expect((await growth().listLinks(owner, { archived: true })).map((l) => l.id)).toEqual([
      link.id,
    ]);
    await expectAppError(
      growth().updateLink(owner, {
        id: link.id,
        expectedVersion: 3,
        name: 'While archived',
        channelAccountId: c.channelAccountId,
        message: '',
        includeRef: true,
      }),
      'conflict',
      /Restore the link/,
    );
    expect(
      await growth().setLinkArchived(marketer, { id: link.id, expectedVersion: 3 }, false),
    ).toEqual({ version: 4 });
    expect((await growth().listLinks(owner)).map((l) => l.id)).toEqual([link.id]);

    await expectAppError(growth().getLink(owner, uuidv7()), 'not_found');
    await expectAppError(growth().getLink(owner, 'not-a-uuid'), 'not_found');

    const audit = await fx.query<{ action: string; subject_id: string }>(
      `SELECT action, subject_id FROM app.audit_events
        WHERE tenant_id = $1 AND action LIKE 'growth.%' ORDER BY occurred_at, id`,
      [c.tenant.id],
    );
    expect(audit).toEqual([
      { action: 'growth.link_created', subject_id: link.id },
      { action: 'growth.link_updated', subject_id: link.id },
      { action: 'growth.link_archived', subject_id: link.id },
      { action: 'growth.link_restored', subject_id: link.id },
    ]);
  });

  it('counts clicks per link and company day and opens WhatsApp only while the link can work', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const link = await newLink(owner, c);
    const other = await newLink(owner, c, { name: 'Shop window QR', includeRef: false });

    const before = await companyDay();
    for (let i = 0; i < 3; i += 1) {
      expect(await followChatLink(fx.dbs.app, link.slug)).toBe(link.waMeUrl);
    }
    expect(await followChatLink(fx.dbs.app, other.slug)).toBe(
      'https://wa.me/919000000000?text=Hello%20from%20Instagram',
    );
    const after = await companyDay();

    const { days } = await growth().getLink(owner, link.id);
    expect(days.reduce((sum, d) => sum + d.clicks, 0)).toBe(3);
    for (const d of days) expect([before, after]).toContain(d.day);
    const listed = await growth().listLinks(owner);
    expect(listed.find((l) => l.id === link.id)?.clicks30).toBe(3);
    expect(listed.find((l) => l.id === other.id)?.clicks30).toBe(1);
    // Only a count per link and day is kept: no address, agent, referrer or time of the click.
    const columns = await fx.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'chat_link_clicks' ORDER BY column_name`,
    );
    expect(columns.map((col) => col.column_name)).toEqual([
      'clicks',
      'day',
      'id',
      'link_id',
      'tenant_id',
    ]);

    // Unknown or malformed slugs open nothing.
    for (const slug of [newSlug(), 'ABCDEFGHJKMN', 'short', `${link.slug}/x`, '']) {
      expect(await followChatLink(fx.dbs.app, slug)).toBeNull();
    }

    const clicks = async () =>
      (
        await fx.query<{ n: number }>(
          `SELECT coalesce(sum(clicks), 0)::int AS n FROM app.chat_link_clicks WHERE link_id = $1`,
          [link.id],
        )
      )[0]!.n;

    // A number that needs reconnecting opens nothing, and the click is not counted.
    await fx.query(`UPDATE app.channel_accounts SET status = 'needs_reconnect' WHERE id = $1`, [
      c.channelAccountId,
    ]);
    expect(await followChatLink(fx.dbs.app, link.slug)).toBeNull();
    expect((await growth().listLinks(owner)).find((l) => l.id === link.id)?.channelActive).toBe(
      false,
    );
    await fx.query(`UPDATE app.channel_accounts SET status = 'active' WHERE id = $1`, [
      c.channelAccountId,
    ]);
    expect(await clicks()).toBe(3);

    // A suspended company still receives chats (customers write to it), but cannot change links.
    await fx.query(`UPDATE app.tenants SET status = 'suspended' WHERE id = $1`, [c.tenant.id]);
    const suspended = await fx.ctx(c, c.owner);
    expect(await followChatLink(fx.dbs.app, link.slug)).toBe(link.waMeUrl);
    expect((await growth().listLinks(suspended)).length).toBe(2);
    await expectAppError(
      growth().setLinkArchived(suspended, { id: link.id, expectedVersion: 1 }, true),
      'tenant_suspended',
    );
    // A company waiting for deletion works like a suspended one (ADR-055); a deleted one opens
    // nothing.
    await fx.query(`UPDATE app.tenants SET status = 'pending_deletion' WHERE id = $1`, [
      c.tenant.id,
    ]);
    expect(await followChatLink(fx.dbs.app, link.slug)).toBe(link.waMeUrl);
    await fx.query(`UPDATE app.tenants SET status = 'deleted' WHERE id = $1`, [c.tenant.id]);
    expect(await followChatLink(fx.dbs.app, link.slug)).toBeNull();
    await fx.query(`UPDATE app.tenants SET status = 'active' WHERE id = $1`, [c.tenant.id]);
    expect(await clicks()).toBe(5);

    // An archived link opens nothing and is not counted.
    await growth().setLinkArchived(owner, { id: link.id, expectedVersion: 1 }, true);
    expect(await followChatLink(fx.dbs.app, link.slug)).toBeNull();
    expect(await clicks()).toBe(5);
  });

  it('keeps a company within its limits', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const refs = new Set<string>();
    while (refs.size < GROWTH_LIMITS.links - 1) refs.add(newRefCode());
    await fx.query(
      `INSERT INTO app.chat_links (id, tenant_id, channel_account_id, name, ref_code, slug,
                                   created_by_membership_id)
       SELECT gen_random_uuid(), $1, $2, 'Bulk ' || r.n, r.ref, r.slug, $3
         FROM unnest($4::text[], $5::text[]) WITH ORDINALITY AS r (ref, slug, n)`,
      [
        c.tenant.id,
        c.channelAccountId,
        c.tenant.ownerMembershipId,
        [...refs],
        [...refs].map(() => newSlug()),
      ],
    );
    const last = await newLink(owner, c, { name: 'Link 500' });
    await expectAppError(newLink(owner, c, { name: 'Link 501' }), 'conflict', /at most 500 links/);
    // Archiving one makes room again.
    await growth().setLinkArchived(owner, { id: last.id, expectedVersion: 1 }, true);
    await newLink(owner, c, { name: 'Link 500 again' });

    const ids = Array.from({ length: GROWTH_LIMITS.widgets - 1 }, () => newWidgetId());
    await fx.query(
      `INSERT INTO app.chat_widgets (id, tenant_id, link_id, public_id, label,
                                     created_by_membership_id)
       SELECT gen_random_uuid(), $1, $2, p, 'Chat', $3 FROM unnest($4::text[]) AS p`,
      [c.tenant.id, last.id, c.tenant.ownerMembershipId, ids],
    );
    const open = (await growth().listLinks(owner))[0]!;
    const widget = {
      linkId: open.id,
      label: 'Chat',
      greeting: '',
      side: 'right',
      color: '#1f7a4d',
      enabled: true,
    };
    await growth().createWidget(owner, widget);
    await expectAppError(growth().createWidget(owner, widget), 'conflict', /at most 50 widgets/);
  });
});

describe('where conversations come from', () => {
  it('attributes a conversation to a link by its reference code, on the link number only', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const link = await newLink(owner, c);
    const second = await addChannel(c, 'active');

    // The customer sends the pre-filled message (codes are matched case-insensitively).
    const priya = waId();
    const body = fx.messagesBody(c, {
      messages: [{ waId: priya, text: `Hello from Instagram (ref ${link.refCode.toLowerCase()})` }],
    });
    await fx.deliver(body);
    // A redelivered webhook stores nothing twice.
    await fx.deliver(body);
    const conv = await conversationOf(c, priya);
    expect(await sources(c.tenant.id)).toMatchObject([
      { kind: 'link', link_id: link.id, conversation_id: conv.id, contact_id: conv.contact_id },
    ]);
    const thread = await inbox().getConversation(owner, conv.id);
    expect(thread.source).toMatchObject({
      kind: 'link',
      linkId: link.id,
      linkName: 'Instagram bio',
      adHeadline: null,
    });
    expect((await growth().getLink(owner, link.id)).link.conversations30).toBe(1);

    // The same code sent to the company's other number is not attributed (another number's
    // customers may type it), and neither is a message without a complete marker.
    const arjun = waId();
    await fx.deliver(
      fx.messagesBody(
        { ...c, phoneNumberId: second.phoneNumberId },
        { messages: [{ waId: arjun, text: `Hi (ref ${link.refCode})` }] },
      ),
    );
    await fx.deliver(
      fx.messagesBody(c, { messages: [{ waId: waId(), text: `ref ${link.refCode}` }] }),
    );
    expect((await sources(c.tenant.id)).length).toBe(1);
    const other = await conversationOf(c, arjun);
    expect((await inbox().getConversation(owner, other.id)).source).toBeNull();

    // Another company's customer typing this company's code is not attributed to anything.
    const b = await fx.company();
    await fx.deliver(
      fx.messagesBody(b, { messages: [{ waId: waId(), text: `Hi (ref ${link.refCode})` }] }),
    );
    expect(await sources(b.tenant.id)).toEqual([]);
  });

  it('records click-to-WhatsApp ads without the ad click id, media addresses or ad text', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const link = await newLink(owner, c);
    const priya = waId();
    const arjun = waId();
    await fx.deliver(adMessage(c, priya, 'Is the offer still on?', diwaliAd, 120));
    await fx.deliver(adMessage(c, arjun, `Hi (ref ${link.refCode})`, diwaliAd, 60));
    await fx.deliver(
      adMessage(c, priya, 'Clicked it again', {
        ...diwaliAd,
        source_url: 'javascript:alert(1)',
        headline: 'x'.repeat(300),
      }),
    );

    const rows = await sources(c.tenant.id);
    // An ad referral wins over a reference code in the same message (one source per message).
    expect(rows.map((r) => r.kind)).toEqual(['ad', 'ad', 'ad']);
    expect(rows[0]).toMatchObject({
      ad_source_id: '120200000000001',
      ad_source_type: 'ad',
      ad_source_url: 'https://fb.me/diwali',
      ad_headline: 'Diwali offer',
      link_id: null,
    });
    // Only web addresses are kept, and text is bounded.
    expect(rows[2]).toMatchObject({ ad_source_url: null, ad_headline: 'x'.repeat(200) });
    for (const r of rows) {
      expect(r.row).not.toContain(diwaliAd.ctwa_clid);
      expect(r.row).not.toContain('scontent.example.test');
      expect(r.row).not.toContain('Twenty percent');
    }
    const stored = await fx.query<{ referral: unknown; content: string }>(
      `SELECT referral, content::text AS content FROM app.messages WHERE tenant_id = $1`,
      [c.tenant.id],
    );
    expect(stored.length).toBe(3);
    for (const m of stored) {
      expect(m.referral).toBeNull();
      expect(m.content).not.toContain(diwaliAd.ctwa_clid);
    }

    const conv = await conversationOf(c, priya);
    expect((await inbox().getConversation(owner, conv.id)).source).toMatchObject({
      kind: 'ad',
      linkId: null,
      adHeadline: 'x'.repeat(200),
      adSourceUrl: null,
      adSourceType: 'ad',
    });
    const ads = await growth().adSources(owner);
    expect(ads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: '120200000000001',
          headline: 'Diwali offer',
          sourceUrl: 'https://fb.me/diwali',
          conversations: 2,
          messages: 2,
        }),
        expect.objectContaining({ headline: 'x'.repeat(200), conversations: 1, messages: 1 }),
      ]),
    );
    expect(ads.length).toBe(2);
    await expectAppError(growth().adSources(await fx.ctx(c, c.agent)), 'forbidden');
  });

  it('erases where a contact came from with the contact', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const link = await newLink(owner, c);
    const priya = waId();
    const arjun = waId();
    await fx.deliver(adMessage(c, priya, 'Is the offer still on?', diwaliAd));
    await fx.deliver(
      fx.messagesBody(c, { messages: [{ waId: priya, text: `Also (ref ${link.refCode})` }] }),
    );
    await fx.deliver(
      fx.messagesBody(c, { messages: [{ waId: arjun, text: `Hi (ref ${link.refCode})` }] }),
    );
    const conv = await conversationOf(c, priya);
    // A referral stored raw before this release is removed by erasure too.
    await fx.query(
      `UPDATE app.messages SET referral = '{"ctwa_clid": "legacy-click-id"}'::jsonb
        WHERE conversation_id = $1`,
      [conv.id],
    );

    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: conv.contact_id,
      suppress: false,
    });
    const remaining = await sources(c.tenant.id);
    expect(remaining.map((r) => r.contact_id)).toEqual([
      (await conversationOf(c, arjun)).contact_id,
    ]);
    const referrals = await fx.query<{ referral: unknown }>(
      `SELECT referral FROM app.messages WHERE conversation_id = $1`,
      [conv.id],
    );
    expect(referrals.length).toBe(2);
    expect(referrals.every((m) => m.referral === null)).toBe(true);
    expect((await inbox().getConversation(owner, conv.id)).source).toBeNull();
    expect((await growth().getLink(owner, link.id)).link.conversations30).toBe(1);
  });
});

describe('website widgets', () => {
  it('serves a widget only while it is enabled and its link can open WhatsApp', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const supervisor = await fx.ctx(c, await member(c, 'supervisor'));
    const link = await newLink(owner, c);
    const spare = await newLink(owner, c, { name: 'Spare' });

    await expectAppError(
      growth().createWidget(owner, {
        linkId: link.id,
        label: 'Chat',
        greeting: '',
        side: 'right',
        color: 'green',
        enabled: true,
      }),
      'validation_failed',
    );
    await expectAppError(
      growth().createWidget(supervisor, {
        linkId: link.id,
        label: 'Chat',
        greeting: '',
        side: 'right',
        color: '#1f7a4d',
        enabled: true,
      }),
      'forbidden',
    );
    const { id, publicId } = await growth().createWidget(owner, {
      linkId: link.id,
      label: '  Chat with us  ',
      greeting: '',
      side: 'left',
      color: '#1F7A4D',
      enabled: true,
    });
    expect(publicId).toMatch(/^[a-z2-7]{16}$/);
    const config = await chatWidgetConfig(fx.dbs.app, publicId);
    expect(config).toEqual({
      label: 'Chat with us',
      greeting: null,
      side: 'left',
      color: '#1f7a4d',
      slug: link.slug,
    });
    expect(renderWidgetScript(config!, publicId, 'https://app.example.test')).toContain(
      `"href":"https://app.example.test/l/${link.slug}"`,
    );
    expect(await growth().listWidgets(supervisor)).toEqual([
      expect.objectContaining({
        id,
        publicId,
        linkName: 'Instagram bio',
        linkArchived: false,
        channelActive: true,
      }),
    ]);
    for (const unknown of [newWidgetId(), 'short', publicId.toUpperCase()]) {
      expect(await chatWidgetConfig(fx.dbs.app, unknown)).toBeNull();
    }

    // Disabled, stale edits refused, then enabled on another link with a greeting.
    await growth().updateWidget(owner, {
      id,
      expectedVersion: 1,
      linkId: link.id,
      label: 'Chat with us',
      greeting: '',
      side: 'left',
      color: '#1f7a4d',
      enabled: false,
    });
    expect(await chatWidgetConfig(fx.dbs.app, publicId)).toBeNull();
    await expectAppError(
      growth().updateWidget(owner, {
        id,
        expectedVersion: 1,
        linkId: link.id,
        label: 'Lost',
        greeting: '',
        side: 'left',
        color: '#1f7a4d',
        enabled: true,
      }),
      'conflict',
    );
    await growth().updateWidget(owner, {
      id,
      expectedVersion: 2,
      linkId: spare.id,
      label: 'Talk to us',
      greeting: 'Questions? We reply on WhatsApp.',
      side: 'right',
      color: '#ffd400',
      enabled: true,
    });
    expect(await chatWidgetConfig(fx.dbs.app, publicId)).toEqual({
      label: 'Talk to us',
      greeting: 'Questions? We reply on WhatsApp.',
      side: 'right',
      color: '#ffd400',
      slug: spare.slug,
    });

    // An archived link, or a number that is not active, hides the button.
    await growth().setLinkArchived(owner, { id: spare.id, expectedVersion: 1 }, true);
    expect(await chatWidgetConfig(fx.dbs.app, publicId)).toBeNull();
    expect((await growth().listWidgets(owner))[0]?.linkArchived).toBe(true);
    await expectAppError(
      growth().createWidget(owner, {
        linkId: spare.id,
        label: 'Chat',
        greeting: '',
        side: 'right',
        color: '#1f7a4d',
        enabled: true,
      }),
      'validation_failed',
      /not archived/,
    );
    await growth().setLinkArchived(owner, { id: spare.id, expectedVersion: 2 }, false);
    expect(await chatWidgetConfig(fx.dbs.app, publicId)).not.toBeNull();
    await fx.query(`UPDATE app.channel_accounts SET status = 'disconnected' WHERE id = $1`, [
      c.channelAccountId,
    ]);
    expect(await chatWidgetConfig(fx.dbs.app, publicId)).toBeNull();
    expect((await growth().listWidgets(owner))[0]?.channelActive).toBe(false);
    await fx.query(`UPDATE app.channel_accounts SET status = 'active' WHERE id = $1`, [
      c.channelAccountId,
    ]);

    // Deleted widgets are gone for good.
    await growth().deleteWidget(owner, { id, expectedVersion: 3 });
    expect(await chatWidgetConfig(fx.dbs.app, publicId)).toBeNull();
    expect(await growth().listWidgets(owner)).toEqual([]);
    const audit = await fx.query<{ action: string }>(
      `SELECT action FROM app.audit_events
        WHERE tenant_id = $1 AND action LIKE 'growth.widget%' ORDER BY occurred_at, id`,
      [c.tenant.id],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'growth.widget_created',
      'growth.widget_updated',
      'growth.widget_updated',
      'growth.widget_deleted',
    ]);
  });
});

describe('growth isolation', () => {
  it("keeps one company's links, widgets and sources from another", async () => {
    const a = await fx.company();
    const b = await fx.company();
    const ownerA = await fx.ctx(a, a.owner);
    const ownerB = await fx.ctx(b, b.owner);
    const link = await newLink(ownerA, a);
    const { id: widgetId } = await growth().createWidget(ownerA, {
      linkId: link.id,
      label: 'Chat',
      greeting: '',
      side: 'right',
      color: '#1f7a4d',
      enabled: true,
    });
    await fx.deliver(adMessage(a, waId(), 'From the ad', diwaliAd));
    expect(await followChatLink(fx.dbs.app, link.slug)).toBe(link.waMeUrl);

    expect(await growth().listLinks(ownerB)).toEqual([]);
    expect(await growth().listWidgets(ownerB)).toEqual([]);
    expect(await growth().adSources(ownerB)).toEqual([]);
    expect((await growth().channelOptions(ownerB)).map((ch) => ch.id)).toEqual([
      b.channelAccountId,
    ]);
    await expectAppError(growth().getLink(ownerB, link.id), 'not_found');
    await expectAppError(
      growth().updateLink(ownerB, {
        id: link.id,
        expectedVersion: 1,
        name: 'Taken over',
        channelAccountId: b.channelAccountId,
        message: '',
        includeRef: true,
      }),
      'not_found',
    );
    await expectAppError(
      growth().setLinkArchived(ownerB, { id: link.id, expectedVersion: 1 }, true),
      'not_found',
    );
    // Another company's number or link cannot be used.
    await expectAppError(
      newLink(ownerB, b, { channelAccountId: a.channelAccountId }),
      'validation_failed',
    );
    await expectAppError(
      growth().createWidget(ownerB, {
        linkId: link.id,
        label: 'Chat',
        greeting: '',
        side: 'right',
        color: '#1f7a4d',
        enabled: true,
      }),
      'validation_failed',
    );
    await expectAppError(
      growth().deleteWidget(ownerB, { id: widgetId, expectedVersion: 1 }),
      'not_found',
    );

    // Row level security hides the rows even from a direct query in the other company's scope.
    const counts = await fx.dbs.app.run(authorizedTenantScope(b.tenant.id, b.owner.id), (tx) =>
      tx.execute<{ links: number; widgets: number; sources: number; clicks: number }>(sql`
        select (select count(*) from app.chat_links)::int as links,
               (select count(*) from app.chat_widgets)::int as widgets,
               (select count(*) from app.conversation_sources)::int as sources,
               (select count(*) from app.chat_link_clicks)::int as clicks`),
    );
    expect(counts.rows[0]).toEqual({ links: 0, widgets: 0, sources: 0, clicks: 0 });
    expect((await growth().getLink(ownerA, link.id)).link.version).toBe(1);
  });
});
