import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7 } from '@w360/core';
import {
  apiListSegmentContacts,
  apiSearchContacts,
  authenticateApiToken,
  createApiKeysService,
  createCampaignsService,
  createContactsService,
  createSegmentsService,
  type ApiContext,
  type ApiScope,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Segments by store orders (ADR-231) against real PostgreSQL: orders matched to contacts by
 * number, the orders that count, a period and a store, spend in one currency, the member's access
 * to store orders, and another company's orders left out; through the API, with orders.read.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx.close();
});

const segments = () => createSegmentsService({ db: fx.dbs.app, clock: systemClock });
const contacts = () => createContactsService({ db: fx.dbs.app, clock: systemClock });
const phone = () => `+9198${String(randomInt(0, 10 ** 8)).padStart(8, '0')}`;
const webhookId = () =>
  Array.from({ length: 16 }, () => 'abcdefghijklmnopqrstuvwxyz234567'[randomInt(0, 32)]).join('');

async function store(c: Company, name: string) {
  const [row] = await fx.query<{ id: string }>(
    `INSERT INTO app.commerce_stores (id, tenant_id, platform, store_url, name, webhook_public_id,
       webhook_secret_ciphertext, created_by_membership_id)
     VALUES (gen_random_uuid(), $1, 'woocommerce', $5, $2, $3, 'x', $4)
     RETURNING id`,
    [
      c.tenant.id,
      name,
      webhookId(),
      c.tenant.ownerMembershipId,
      `https://${webhookId()}.example.test`,
    ],
  );
  return row!.id;
}

/** A key of the company created by its owner, and the context a request with it gets. */
async function apiKey(c: Company, scopes: ApiScope[]): Promise<ApiContext> {
  const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
  const created = await keys.create(await fx.ctx(c, c.owner), {
    name: 'Order segments',
    scopes,
    expiresInDays: 0,
  });
  const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
  if (!ctx) throw new Error('a new key does not authenticate');
  return ctx;
}

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

let orderNumber = 1000;
async function order(
  c: Company,
  storeId: string,
  customerPhone: string,
  o: {
    totalMinor?: number;
    currency?: string;
    daysAgo?: number;
    status?: string;
    financialStatus?: string | null;
    test?: boolean;
    cancelled?: boolean;
    deleted?: boolean;
  } = {},
) {
  orderNumber += 1;
  await fx.query(
    `INSERT INTO app.commerce_store_orders (id, tenant_id, store_id, external_id, name, status,
       financial_status, test, currency, total_minor, placed_at, cancelled_at, remote_updated_at,
       customer_phone, deleted_at, synced_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9,
       now() - make_interval(days => $10), CASE WHEN $11 THEN now() END, now(), $12,
       CASE WHEN $13 THEN now() END, now())`,
    [
      c.tenant.id,
      storeId,
      String(orderNumber),
      `#${orderNumber}`,
      o.status ?? 'processing',
      o.financialStatus ?? null,
      o.test ?? false,
      o.currency ?? 'INR',
      o.totalMinor ?? 100_000,
      o.daysAgo ?? 1,
      o.cancelled ?? false,
      customerPhone,
      o.deleted ?? false,
    ],
  );
}

describe('segments by store orders (ADR-231)', () => {
  it('counts the orders that count, matched by number, in a period and a store', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const shop = await store(c, 'Main shop');
    const outlet = await store(c, 'Outlet');
    const people = {
      loyal: phone(),
      once: phone(),
      lapsed: phone(),
      cancelledOnly: phone(),
      outletOnly: phone(),
      never: phone(),
    };
    for (const [name, number] of Object.entries(people)) {
      await contacts().createContact(owner, { displayName: name, phone: number });
    }
    for (let i = 0; i < 3; i += 1) await order(c, shop, people.loyal, { daysAgo: 5 + i });
    await order(c, shop, people.once, { daysAgo: 2 });
    await order(c, shop, people.lapsed, { daysAgo: 400 });
    // None of these count.
    await order(c, shop, people.cancelledOnly, { cancelled: true, status: 'cancelled' });
    await order(c, shop, people.cancelledOnly, { status: 'refunded' });
    await order(c, shop, people.cancelledOnly, { status: 'failed' });
    await order(c, shop, people.cancelledOnly, { financialStatus: 'voided' });
    await order(c, shop, people.cancelledOnly, { test: true });
    await order(c, shop, people.cancelledOnly, { deleted: true });
    await order(c, outlet, people.outletOnly, { daysAgo: 3 });
    // Another company's orders for the same number are not this company's.
    const other = await fx.company();
    const theirs = await store(other, 'Theirs');
    await order(other, theirs, people.never, { daysAgo: 1 });

    const matching = async (conditions: unknown[]) => {
      const preview = await segments().previewDefinition(owner, { match: 'all', conditions });
      return preview.sample.map((s) => s.displayName).sort();
    };
    expect(await matching([{ type: 'orders', op: 'at_least', count: 1 }])).toEqual([
      'lapsed',
      'loyal',
      'once',
      'outletOnly',
    ]);
    expect(await matching([{ type: 'orders', op: 'at_least', count: 2 }])).toEqual(['loyal']);
    expect(await matching([{ type: 'orders', op: 'at_least', count: 1, days: 30 }])).toEqual([
      'loyal',
      'once',
      'outletOnly',
    ]);
    expect(
      await matching([{ type: 'orders', op: 'at_least', count: 1, days: 30, storeId: shop }]),
    ).toEqual(['loyal', 'once']);
    // Fewer than one order in the last 30 days: the lapsed, those whose orders do not count, and
    // contacts without any.
    expect(await matching([{ type: 'orders', op: 'fewer_than', count: 1, days: 30 }])).toEqual([
      'cancelledOnly',
      'lapsed',
      'never',
    ]);
    // Another company's store is refused, as one that no longer exists.
    await expect(
      segments().previewDefinition(owner, {
        conditions: [{ type: 'orders', op: 'at_least', count: 1, storeId: theirs }],
      }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      publicMessage: 'A condition refers to a store that is no longer connected.',
    });
  });

  it('totals what a contact spent in one currency', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const shop = await store(c, 'Main shop');
    const big = phone();
    const small = phone();
    const dollars = phone();
    for (const [name, number] of [
      ['big', big],
      ['small', small],
      ['dollars', dollars],
    ] as const) {
      await contacts().createContact(owner, { displayName: name, phone: number });
    }
    await order(c, shop, big, { totalMinor: 300_000 });
    await order(c, shop, big, { totalMinor: 250_000, daysAgo: 100 });
    await order(c, shop, big, { totalMinor: 900_000, financialStatus: 'refunded' });
    await order(c, shop, small, { totalMinor: 49_999 });
    await order(c, shop, dollars, { totalMinor: 900_000, currency: 'USD' });

    const matching = async (condition: Record<string, unknown>) =>
      (await segments().previewDefinition(owner, { conditions: [condition] })).sample
        .map((s) => s.displayName)
        .sort();
    const spend = { type: 'spend', currency: 'INR' };
    expect(await matching({ ...spend, op: 'at_least', amountMinor: 500_000 })).toEqual(['big']);
    expect(await matching({ ...spend, op: 'at_least', amountMinor: 500_000, days: 30 })).toEqual(
      [],
    );
    expect(await matching({ ...spend, op: 'at_least', amountMinor: 49_999 })).toEqual([
      'big',
      'small',
    ]);
    expect(await matching({ ...spend, op: 'less_than', amountMinor: 50_000 })).toEqual([
      'dollars',
      'small',
    ]);
    expect(
      await matching({ type: 'spend', currency: 'USD', op: 'at_least', amountMinor: 1 }),
    ).toEqual(['dollars']);
  });

  it('needs access to store orders to save or preview such a segment', async () => {
    const c = await fx.company();
    const marketer = await fx.ctx(c, c.marketer);
    const definition = { conditions: [{ type: 'orders', op: 'at_least', count: 1 }] };
    // Marketers read store orders: allowed.
    await expect(segments().previewDefinition(marketer, definition)).resolves.toMatchObject({
      count: 0,
    });
    const saved = await segments().createSegment(
      marketer,
      { name: 'Buyers', definition },
      { ipAddress: '203.0.113.9' },
    );
    expect(saved.id).toEqual(expect.any(String));
    // Without commerce.read (the store module left out), refused before anything is saved.
    const withoutOrders = {
      ...marketer,
      permissions: new Set([...marketer.permissions].filter((p) => p !== 'commerce.read')),
    } as typeof marketer;
    await expect(segments().previewDefinition(withoutOrders, definition)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      segments().createSegment(
        withoutOrders,
        { name: 'Buyers 2', definition },
        { ipAddress: '203.0.113.9' },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // Nor can such a member give a campaign draft an audience on store orders.
    const campaigns = createCampaignsService({
      db: fx.dbs.app,
      jobs: fx.jobs(),
      signer: fx.signer,
      clock: systemClock,
      notices: fx.notices(),
    });
    const { id: draft } = await campaigns.createDraft(marketer, { name: 'Win back' }, {});
    const update = {
      expectedVersion: 0,
      name: 'Win back',
      channelAccountId: null,
      templateId: null,
      variables: {},
      audience: { kind: 'conditions', definition },
      schedule: { kind: 'now', timezone: 'Asia/Kolkata' },
      window: null,
      ratePerMinute: null,
      maxMessages: null,
      budget: null,
      stopAfterHours: 24,
    };
    await expect(campaigns.updateDraft(withoutOrders, draft, update, {})).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(campaigns.updateDraft(marketer, draft, update, {})).resolves.toEqual({
      id: draft,
    });
  });

  it('finds buyers through the API with orders.read, never in another company’s store', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const shop = await store(c, 'Main shop');
    const buyer = phone();
    await contacts().createContact(owner, { displayName: 'buyer', phone: buyer });
    await contacts().createContact(owner, { displayName: 'browser', phone: phone() });
    await order(c, shop, buyer, { totalMinor: 250_000 });
    const other = await fx.company();
    const theirs = await store(other, 'Theirs');
    await order(other, theirs, buyer, { totalMinor: 900_000 });

    const deps = { db: fx.dbs.app, clock: systemClock };
    const key = await apiKey(c, ['contacts.read', 'campaigns.read', 'orders.read']);
    const names = (page: { data: { name: string | null }[] }) => page.data.map((x) => x.name);
    const buyers = { type: 'orders', op: 'at_least', count: 1, storeId: shop };
    expect(names(await apiSearchContacts(deps, key, { conditions: [buyers] }))).toEqual(['buyer']);
    // The other company's order for the same number is not counted.
    const spentLittle = { type: 'spend', op: 'less_than', currency: 'INR', amountMinor: 500_000 };
    expect(names(await apiSearchContacts(deps, key, { conditions: [spentLittle] })).sort()).toEqual(
      ['browser', 'buyer'],
    );
    expect(
      await refusal(apiSearchContacts(deps, key, { conditions: [{ ...buyers, storeId: theirs }] })),
    ).toEqual({ code: 'validation_failed', paths: ['conditions.0.storeId'] });

    // A saved segment with such a condition lists its contacts only to a key with orders.read.
    const saved = await segments().createSegment(
      owner,
      { name: 'Buyers', definition: { conditions: [buyers] } },
      { ipAddress: '203.0.113.9' },
    );
    expect(names(await apiListSegmentContacts(deps, key, saved.id, {}))).toEqual(['buyer']);
    // In the app, a member who cannot read store orders sees how many it matches, never which.
    const ownerWithoutOrders = {
      ...owner,
      permissions: new Set([...owner.permissions].filter((p) => p !== 'commerce.read')),
    } as typeof owner;
    expect((await segments().getSegment(owner, saved.id)).preview).toMatchObject({
      count: 1,
      sample: [expect.objectContaining({ displayName: 'buyer' })],
    });
    expect((await segments().getSegment(ownerWithoutOrders, saved.id)).preview).toEqual({
      count: 1,
      sample: [],
    });
    const withoutOrders = await apiKey(c, ['contacts.read', 'campaigns.read']);
    expect(await refusal(apiListSegmentContacts(deps, withoutOrders, saved.id, {}))).toEqual({
      code: 'forbidden',
      paths: [],
    });
  });
});
