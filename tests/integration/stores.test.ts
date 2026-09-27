import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, type Clock } from '@w360/core';
import { createEgressClient, DEFAULT_EGRESS_POLICY } from '@w360/core/egress';
import { authorizedTenantScope } from '@w360/db';
import {
  createContactsService,
  createStoreService,
  findDueStoreWork,
  handleShopifyWebhook,
  handleWooWebhook,
  processStoreJob,
  saveStoreOrders,
  saveStoreProducts,
  STORE_LIMITS,
  type StoreWorkerDeps,
  type TenantContext,
} from '@w360/domain';
import { startShopifyStandIn, type ShopifyStandIn } from '../support/shopify-stand-in';
import { startWooStandIn, type WooStandIn } from '../support/woocommerce-stand-in';
import { acceptInvitation, createUser, invite, type TestUser } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Store connectors against real PostgreSQL and the test-only Shopify and WooCommerce stand-ins:
 * the handshakes (Shopify's signed callback, WooCommerce's key handover), the first read, webhooks
 * that only signal what to read (verified, deduplicated, never trusted for data), recovery of
 * missed webhooks and of lost subscriptions, token refresh, rate limits, withheld customer details,
 * uninstall and Shopify's privacy requests, removal, contact erasure and company isolation. A small
 * HTTP server stands in for HyFib's routes so the stand-ins can call back as the real stores do.
 */

const CLIENT_ID = 'w360clientid0001';
const CLIENT_SECRET = 'shopify-client-secret-'.padEnd(40, 'x');

let fx: WhatsAppFixture;
let shopify: ShopifyStandIn;
let woo: WooStandIn;
let app: Server;
let appBase = '';
/** The time webhooks are handled at (a test can make every signal share one instant). */
let webhookClock: Clock = systemClock;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  app = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', 'http://app');
      const header = (name: string) => (req.headers[name] as string | undefined) ?? null;
      let status = 404;
      if (url.pathname === '/api/webhooks/shopify') {
        status = (
          await handleShopifyWebhook(webhookDeps(), {
            rawBody: body,
            hmac: header('x-shopify-hmac-sha256'),
            topic: header('x-shopify-topic'),
            shopDomain: header('x-shopify-shop-domain'),
            webhookId: header('x-shopify-webhook-id'),
          })
        ).status;
      } else if (url.pathname.startsWith('/api/webhooks/woocommerce/')) {
        status = (
          await handleWooWebhook(webhookDeps(), {
            publicId: url.pathname.split('/').pop() ?? '',
            rawBody: body,
            signature: header('x-wc-webhook-signature'),
            topic: header('x-wc-webhook-topic'),
            deliveryId: header('x-wc-webhook-delivery-id'),
          })
        ).status;
      } else if (url.pathname === '/api/stores/woocommerce/callback') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          parsed = null;
        }
        status = (await service().acceptWooKeys(parsed)).status;
      }
      res.writeHead(status);
      res.end();
    })().catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  appBase = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  shopify = await startShopifyStandIn({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    complianceUri: `${appBase}/api/webhooks/shopify`,
  });
  woo = await startWooStandIn();
});
afterAll(async () => {
  await woo?.close();
  await shopify?.close();
  await new Promise<void>((resolve) => (app ? app.close(() => resolve()) : resolve()));
  await fx?.close();
});

const shopifyConfig = () => ({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  secrets: [CLIENT_SECRET],
  apiVersion: '2026-07',
  testBaseUrl: shopify.baseUrl,
});
const egress = () =>
  createEgressClient({
    ...DEFAULT_EGRESS_POLICY,
    allowLoopbackForTests: true,
    maxResponseBytes: 4 << 20,
  });

const service = (clock: Clock = systemClock) =>
  createStoreService({
    db: fx.dbs.app,
    clock,
    jobs: fx.jobs(),
    signer: fx.signer,
    keyring: fx.keyring,
    appBaseUrl: appBase,
    shopify: shopifyConfig(),
    allowHttpStores: true,
  });
const workerDeps = (clock: Clock = systemClock): StoreWorkerDeps => ({
  db: fx.dbs.app,
  keyring: fx.keyring,
  clock,
  jobs: fx.jobs(),
  signer: fx.signer,
  egress: egress(),
  shopify: shopifyConfig(),
  appBaseUrl: appBase,
});
const webhookDeps = () => ({
  db: fx.dbs.app,
  keyring: fx.keyring,
  clock: webhookClock,
  jobs: fx.jobs(),
  signer: fx.signer,
  shopifySecrets: [CLIENT_SECRET],
});
const scopeOf = (c: Company) => authorizedTenantScope(c.tenant.id, null);
const later = (ms: number): Clock => ({ now: () => new Date(Date.now() + ms) });
let shopCounter = 0;
const newShop = () => `store-${Date.now().toString(36)}-${(shopCounter += 1)}.myshopify.com`;
const iso = (offsetMs = 0) =>
  new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');

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

async function storeRow(id: string) {
  const [row] = await fx.query<Record<string, unknown>>(
    'SELECT * FROM app.commerce_stores WHERE id = $1',
    [id],
  );
  return row;
}

async function orderRows(storeId: string) {
  return fx.query<Record<string, unknown>>(
    'SELECT * FROM app.commerce_store_orders WHERE store_id = $1 ORDER BY external_id::bigint',
    [storeId],
  );
}

/** Runs store jobs until the store has nothing left to do right now (bounded). */
async function drain(c: Company, storeId: string, clock: Clock = systemClock) {
  const outcomes: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    const outcome = await processStoreJob(workerDeps(clock), scopeOf(c), storeId);
    outcomes.push(outcome);
    if (outcome !== 'continuing' && outcome !== 'connected') break;
  }
  return outcomes;
}

/** Walks a member through the Shopify handshake: redirect, signed callback, approval. */
async function connectShopify(c: Company, owner: TenantContext, shop: string) {
  const { url } = await service().startShopifyConnect(owner, { shop, callingCode: '91' });
  const redirect = await fetch(url, { redirect: 'manual' });
  expect(redirect.status).toBe(302);
  const callback = new URL(redirect.headers.get('location') ?? '');
  expect(callback.pathname).toBe('/api/stores/shopify/callback');
  const checked = await service().shopifyCallback(callback.searchParams);
  if (!checked.ok) throw new Error(`callback refused: ${checked.reason}`);
  expect(checked.tenantSlug).toBe(c.tenant.slug);
  const { storeId } = await service().acceptShopifyApproval(owner, checked);
  return { storeId, callback };
}

describe('Shopify stores', () => {
  it('connects through a signed callback, reads orders and products, and links orders to contacts', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const shop = newShop();
    shopify.addShop(shop, { name: 'Tea House', currency: 'INR' });
    // A customer who is already a contact, and one whose number has no country code.
    const contact = await createContactsService({
      db: fx.dbs.app,
      clock: systemClock,
    }).createContact(owner, {
      displayName: 'Asha',
      phone: '+919812345678',
    });
    shopify.upsertOrder(shop, {
      id: '5001',
      name: '#1001',
      total: { amount: '1999.50', currencyCode: 'INR' },
      phone: '+91 98123 45678',
      email: 'Asha@Example.com',
      shippingAddress: { name: 'Asha K', phone: null },
      lineItems: [
        {
          name: 'Assam tea',
          sku: 'TEA-1',
          quantity: 2,
          total: { amount: '1000.00', currencyCode: 'INR' },
        },
        {
          name: 'Kettle',
          sku: null,
          quantity: 1,
          total: { amount: '999.50', currencyCode: 'INR' },
        },
      ],
      updatedAt: iso(-60_000),
    });
    shopify.upsertOrder(shop, {
      id: '5002',
      total: { amount: '10.999', currencyCode: 'INR' },
      phone: '09876543210',
      displayFinancialStatus: 'PENDING',
      cancelledAt: iso(-30_000),
      updatedAt: iso(-30_000),
    });
    shopify.upsertProduct(shop, {
      id: '7001',
      title: 'Assam tea',
      variants: [
        { sku: 'TEA-1', price: '500.00' },
        { sku: 'TEA-2', price: '900.00' },
      ],
    });
    shopify.upsertProduct(shop, {
      id: '7002',
      title: 'Kettle',
      variants: [{ sku: 'KET', price: '999.50' }],
    });

    const { storeId } = await connectShopify(c, owner, shop);
    expect(await storeRow(storeId)).toMatchObject({
      state: 'connecting',
      connect_token_hash: null,
    });
    expect(await drain(c, storeId)).toEqual(['connected', 'synced']);

    const store = await storeRow(storeId);
    expect(store).toMatchObject({ state: 'connected', name: 'Tea House', currency: 'INR' });
    expect(store?.backfilled_at).not.toBeNull();
    // HyFib's subscriptions, pointing at its webhook route (SH-021, SH-022).
    const subs = shopify.shops.get(shop)?.subscriptions ?? [];
    expect(subs.map((s) => s.topic).sort()).toEqual(
      [
        'APP_UNINSTALLED',
        'ORDERS_CREATE',
        'ORDERS_DELETE',
        'ORDERS_UPDATED',
        'PRODUCTS_CREATE',
        'PRODUCTS_DELETE',
        'PRODUCTS_UPDATE',
      ].sort(),
    );
    expect(new Set(subs.map((s) => s.uri))).toEqual(new Set([`${appBase}/api/webhooks/shopify`]));
    expect(subs.find((s) => s.topic === 'ORDERS_UPDATED')?.includeFields).toEqual([
      'id',
      'admin_graphql_api_id',
      'updated_at',
    ]);

    const orders = await orderRows(storeId);
    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({
      name: '#1001',
      status: 'open',
      financial_status: 'paid',
      fulfillment_status: 'unfulfilled',
      total_minor: '199950',
      currency: 'INR',
      customer_phone: '+919812345678',
      customer_email: 'asha@example.com',
      customer_name: 'Asha K',
    });
    // More decimals than INR has: unknown, never rounded. A national number becomes +91 (setting).
    expect(orders[1]).toMatchObject({
      status: 'cancelled',
      total_minor: null,
      customer_phone: '+919876543210',
    });
    const items = await fx.query<Record<string, unknown>>(
      'SELECT title, sku, quantity, total_minor FROM app.commerce_store_order_items WHERE order_id = $1 ORDER BY position',
      [orders[0]?.id],
    );
    expect(items).toEqual([
      { title: 'Assam tea', sku: 'TEA-1', quantity: 2, total_minor: '100000' },
      { title: 'Kettle', sku: null, quantity: 1, total_minor: '99950' },
    ]);
    const products = await fx.query<Record<string, unknown>>(
      'SELECT external_id, title, sku, price_min_minor, price_max_minor, variants FROM app.commerce_store_products WHERE store_id = $1 ORDER BY external_id',
      [storeId],
    );
    expect(products).toEqual([
      {
        external_id: '7001',
        title: 'Assam tea',
        sku: null,
        price_min_minor: '50000',
        price_max_minor: '90000',
        variants: 2,
      },
      {
        external_id: '7002',
        title: 'Kettle',
        sku: 'KET',
        price_min_minor: '99950',
        price_max_minor: '99950',
        variants: 1,
      },
    ]);
    // An older copy of a product never replaces a newer one either.
    await fx.dbs.app.run(scopeOf(c), (tx) =>
      saveStoreProducts(
        tx,
        { id: storeId, tenantId: c.tenant.id },
        [
          {
            externalId: '7002',
            title: 'Stale kettle',
            status: 'active',
            sku: null,
            url: null,
            currency: 'INR',
            priceMinMinor: 1,
            priceMaxMinor: 1,
            inventory: null,
            variants: 1,
            remoteUpdatedAt: new Date(Date.now() - 86_400_000),
          },
        ],
        new Date(),
      ),
    );
    const [kettle] = await fx.query<{ title: string }>(
      "SELECT title FROM app.commerce_store_products WHERE store_id = $1 AND external_id = '7002'",
      [storeId],
    );
    expect(kettle?.title).toBe('Kettle');

    // The order page links the order to the contact with that number.
    const detail = await service().storeOrder(owner, orders[0]?.id as string);
    expect(detail.contact).toMatchObject({ id: contact.id });
    const list = await service().storeOrders(owner, { storeId });
    expect(list.orders.map((o) => o.name).sort()).toEqual(
      [orders[0]?.name, orders[1]?.name].sort(),
    );
    expect(list.next).toBeNull();
  });

  it('refuses forged, stale and replayed callbacks and another member finishing the handshake', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const admin = await fx.ctx(c, await member(c, 'admin'));
    const shop = newShop();
    shopify.addShop(shop);
    const { url } = await service().startShopifyConnect(owner, { shop });
    const redirect = await fetch(url, { redirect: 'manual' });
    const query = new URL(redirect.headers.get('location') ?? '').searchParams;

    const forged = new URLSearchParams(query);
    forged.set('shop', newShop());
    expect(await service().shopifyCallback(forged)).toEqual({ ok: false, reason: 'bad_signature' });
    const stale = new URLSearchParams(query);
    const staleParams = Object.fromEntries(stale);
    delete staleParams.hmac;
    staleParams.timestamp = String(Math.trunc(Date.now() / 1000) - 600);
    const sorted = Object.entries(staleParams).sort(([a], [b]) => (a < b ? -1 : 1));
    const staleQuery = new URLSearchParams(sorted);
    staleQuery.set(
      'hmac',
      createHmac('sha256', CLIENT_SECRET)
        .update(new URLSearchParams(sorted).toString())
        .digest('hex'),
    );
    expect(await service().shopifyCallback(staleQuery)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });

    const checked = await service().shopifyCallback(query);
    if (!checked.ok) throw new Error('expected a valid callback');
    await expectAppError(service().acceptShopifyApproval(admin, checked), 'forbidden');
    await service().acceptShopifyApproval(owner, checked);
    // The state is single-use.
    expect(await service().shopifyCallback(query)).toEqual({ ok: false, reason: 'unknown_state' });

    // Another company cannot connect the same shop while it is connected here (SH-007).
    const other = await fx.company();
    await expectAppError(
      service().startShopifyConnect(await fx.ctx(other, other.owner), { shop }),
      'conflict',
      /another HyFib company/,
    );
    // An agent can see stores but not connect them.
    await expectAppError(
      service().startShopifyConnect(await fx.ctx(c, c.agent), { shop: newShop() }),
      'forbidden',
    );
  });

  it('reads what signed webhooks signal, ignores repeats and forgeries, and marks deletions', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const shop = newShop();
    shopify.addShop(shop);
    shopify.upsertOrder(shop, {
      id: '6001',
      total: { amount: '100.00', currencyCode: 'INR' },
      updatedAt: iso(-120_000),
    });
    const { storeId } = await connectShopify(c, owner, shop);
    await drain(c, storeId);

    shopify.upsertOrder(shop, {
      id: '6001',
      total: { amount: '250.00', currencyCode: 'INR' },
      displayFulfillmentStatus: 'FULFILLED',
    });
    const [delivery] = await shopify.deliver(shop, 'orders/updated', {
      id: 6001,
      admin_graphql_api_id: 'gid://shopify/Order/6001',
      updated_at: iso(),
      email: 'not-used@example.com',
    });
    expect(delivery?.status).toBe(200);
    const signals = await fx.query<{ kind: string; external_id: string }>(
      'SELECT kind, external_id FROM app.commerce_store_fetches WHERE store_id = $1',
      [storeId],
    );
    expect(signals).toEqual([{ kind: 'order', external_id: '6001' }]);
    // The same delivery again does nothing; a forged one is refused with 401 (SH-027).
    const body = JSON.stringify({ id: 6001, updated_at: iso() });
    const signed = (raw: string) =>
      createHmac('sha256', CLIENT_SECRET).update(raw).digest('base64');
    const repeat = await handleShopifyWebhook(webhookDeps(), {
      rawBody: Buffer.from(body),
      hmac: signed(body),
      topic: 'orders/updated',
      shopDomain: shop,
      webhookId: delivery?.webhookId ?? null,
    });
    expect(repeat).toMatchObject({ status: 200, log: { outcome: 'duplicate' } });
    const forged = await handleShopifyWebhook(webhookDeps(), {
      rawBody: Buffer.from(body),
      hmac: createHmac('sha256', 'wrong').update(body).digest('base64'),
      topic: 'orders/updated',
      shopDomain: shop,
      webhookId: 'forged-1',
    });
    expect(forged).toMatchObject({ status: 401, log: { outcome: 'bad_signature' } });

    expect(await drain(c, storeId)).toContain('synced');
    const [order] = await orderRows(storeId);
    // The amount comes from the order as read from Shopify, not from the webhook body.
    expect(order).toMatchObject({
      total_minor: '25000',
      fulfillment_status: 'fulfilled',
      customer_email: null,
    });
    expect(
      await fx.query('SELECT 1 FROM app.commerce_store_fetches WHERE store_id = $1', [storeId]),
    ).toHaveLength(0);

    // An older copy never replaces a newer one (webhooks and reads can arrive out of order).
    await fx.dbs.app.run(scopeOf(c), (tx) =>
      saveStoreOrders(
        tx,
        { id: storeId, tenantId: c.tenant.id, phoneCallingCode: null },
        [
          {
            externalId: '6001',
            name: '#stale',
            status: 'open',
            financialStatus: 'pending',
            fulfillmentStatus: 'unfulfilled',
            test: false,
            currency: 'INR',
            totalMinor: 1,
            itemsTruncated: false,
            placedAt: new Date(),
            cancelledAt: null,
            remoteUpdatedAt: new Date(Date.now() - 3_600_000),
            customerName: null,
            customerPhone: null,
            customerEmail: null,
            statusUrl: null,
            items: [],
          },
        ],
        new Date(),
      ),
    );
    expect((await orderRows(storeId))[0]).toMatchObject({ total_minor: '25000' });

    const deleted = await shopify.deliver(shop, 'orders/delete', { id: 6001 });
    expect(deleted[0]?.status).toBe(200);
    expect((await orderRows(storeId))[0]?.deleted_at).not.toBeNull();
  });

  it('catches up with missed webhooks, bursts sharing one second, lost subscriptions and expiring tokens', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const shop = newShop();
    shopify.addShop(shop);
    const { storeId } = await connectShopify(c, owner, shop);
    await drain(c, storeId);
    expect(await orderRows(storeId)).toHaveLength(0);

    // 130 orders updated in the same second (more than one job reads) and no webhook at all.
    const second = iso(-10_000);
    for (let i = 0; i < 130; i += 1) {
      shopify.upsertOrder(shop, {
        id: String(8000 + i),
        total: { amount: `${i}.00`, currencyCode: 'INR' },
        updatedAt: second,
      });
    }
    // Shopify deleted the subscriptions after failed deliveries (SH-025), and the token expires.
    const state = shopify.shops.get(shop);
    if (!state) throw new Error('no shop');
    state.subscriptions = [];
    const oldToken = [...state.accessTokens.keys()][0];
    // Seven hours on: the token is past its 60 minutes and the 6-hourly webhook check is due.
    const hoursLater = later(7 * 60 * 60_000);
    // One job reads five pages and queues the next job itself, in the transaction that ends it.
    const continuations = async () =>
      (
        await fx.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'commerce.store' AND singleton_key LIKE $1",
          [`store:${storeId}:next:%`],
        )
      )[0]?.n ?? 0;
    const queuedBefore = await continuations();
    expect(await processStoreJob(workerDeps(hoursLater), scopeOf(c), storeId)).toBe('continuing');
    expect(await continuations()).toBe(queuedBefore + 1);
    const outcomes = await drain(c, storeId, hoursLater);
    expect(outcomes.at(-1)).toBe('synced');
    expect(await orderRows(storeId)).toHaveLength(130);
    expect(state.subscriptions).toHaveLength(7);
    // The token was refreshed before it expired (SH-007): a new pair was stored atomically.
    const store = await storeRow(storeId);
    expect(Number(store?.credentials_version)).toBeGreaterThan(2);
    expect(state.accessTokens.has(oldToken as string)).toBe(false);

    // Shopify slows HyFib down: the store waits, without an error (SH-011).
    state.available = 10;
    shopify.upsertOrder(shop, { id: '8999', updatedAt: iso() });
    await fx.query(
      "UPDATE app.commerce_stores SET next_sync_at = now() - interval '1 minute' WHERE id = $1",
      [storeId],
    );
    expect(await processStoreJob(workerDeps(hoursLater), scopeOf(c), storeId)).toBe('waiting');
    const waiting = await storeRow(storeId);
    expect(waiting?.sync_error).toBeNull();
    expect((waiting?.next_sync_at as Date).getTime()).toBeGreaterThan(Date.now());
    state.available = 1000;

    // A refresh Shopify refuses fails the store: it must be connected again.
    state.refreshTokens.clear();
    await fx.query('UPDATE app.commerce_stores SET next_sync_at = now() WHERE id = $1', [storeId]);
    expect(await processStoreJob(workerDeps(later(9 * 60 * 60_000)), scopeOf(c), storeId)).toBe(
      'failed',
    );
    expect(await storeRow(storeId)).toMatchObject({ state: 'failed' });
    expect(String((await storeRow(storeId))?.status_error)).toMatch(/Connect the store again/);
  });

  it('reads an order again when it is signalled while its read is running', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const shop = newShop();
    shopify.addShop(shop);
    shopify.upsertOrder(shop, {
      id: '6101',
      total: { amount: '100.00', currencyCode: 'INR' },
      updatedAt: iso(-60_000),
    });
    const { storeId } = await connectShopify(c, owner, shop);
    await drain(c, storeId);
    // Both signals carry the same time, as when two web instances handle them in one millisecond.
    const instant = new Date();
    webhookClock = { now: () => instant };
    try {
      shopify.upsertOrder(shop, { id: '6101', total: { amount: '200.00', currencyCode: 'INR' } });
      await shopify.deliver(shop, 'orders/updated', { id: 6101, updated_at: iso() });
      // The order changes again after Shopify answered HyFib's read, before HyFib saves it.
      shopify.beforeAnswer = async (request) => {
        if (request.shop !== shop || request.operation !== 'W360OrderNodes') return;
        shopify.beforeAnswer = null;
        shopify.upsertOrder(shop, { id: '6101', total: { amount: '300.00', currencyCode: 'INR' } });
        await shopify.deliver(shop, 'orders/updated', { id: 6101, updated_at: iso() });
      };
      await processStoreJob(workerDeps(), scopeOf(c), storeId);
      expect((await orderRows(storeId))[0]).toMatchObject({ total_minor: '20000' });
      // The second signal outlived the first read, so the next job reads the order again.
      expect(
        await fx.query('SELECT 1 FROM app.commerce_store_fetches WHERE store_id = $1', [storeId]),
      ).toHaveLength(1);
      await drain(c, storeId);
      expect((await orderRows(storeId))[0]).toMatchObject({ total_minor: '30000' });
    } finally {
      shopify.beforeAnswer = null;
      webhookClock = systemClock;
    }
  });

  it('drops a refreshed token when the store’s credentials changed during the refresh', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const shop = newShop();
    shopify.addShop(shop);
    const { storeId } = await connectShopify(c, owner, shop);
    await drain(c, storeId);
    const before = await storeRow(storeId);
    // While Shopify answers the refresh, another writer replaces the credentials (a reconnect).
    shopify.beforeAnswer = async (request) => {
      if (request.shop !== shop || request.grant !== 'refresh_token') return;
      shopify.beforeAnswer = null;
      await fx.query(
        'UPDATE app.commerce_stores SET credentials_version = credentials_version + 1 WHERE id = $1',
        [storeId],
      );
    };
    try {
      expect(await processStoreJob(workerDeps(later(2 * 60 * 60_000)), scopeOf(c), storeId)).toBe(
        'skipped',
      );
    } finally {
      shopify.beforeAnswer = null;
    }
    const after = await storeRow(storeId);
    expect(Number(after?.credentials_version)).toBe(Number(before?.credentials_version) + 1);
    expect(after?.credentials_ciphertext).toEqual(before?.credentials_ciphertext);
    expect(after?.lease_until).toBeNull();
  });

  it('keeps orders without customer details when Shopify withholds them', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const shop = newShop();
    const state = shopify.addShop(shop);
    state.withhold = true;
    shopify.upsertOrder(shop, {
      id: '9101',
      phone: '+919800000001',
      email: 'x@example.com',
      total: { amount: '5.00', currencyCode: 'INR' },
    });
    const { storeId } = await connectShopify(c, owner, shop);
    await drain(c, storeId);
    expect(await orderRows(storeId)).toMatchObject([
      { customer_phone: null, customer_email: null, total_minor: '500' },
    ]);
    expect(await storeRow(storeId)).toMatchObject({ details_withheld: true });
  });

  it('handles uninstall, customer redaction, data requests, shop redaction and removal', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const shop = newShop();
    shopify.addShop(shop);
    shopify.upsertOrder(shop, {
      id: '9201',
      phone: '+919811111111',
      email: 'r@example.com',
      statusPageUrl: `https://${shop}/s/1`,
    });
    shopify.upsertOrder(shop, { id: '9202', phone: '+919822222222' });
    const { storeId } = await connectShopify(c, owner, shop);
    await drain(c, storeId);

    // customers/redact: the named order loses the customer's details for good (SH-027).
    const status = await shopify.deliverCompliance('customers/redact', {
      shop_id: 1,
      shop_domain: shop,
      customer: { id: 1, email: 'r@example.com', phone: '+919811111111' },
      orders_to_redact: [9201],
    });
    expect(status).toBe(200);
    const [redacted] = await orderRows(storeId);
    expect(redacted).toMatchObject({
      customer_phone: null,
      customer_email: null,
      status_url: null,
    });
    expect(redacted?.redacted_at).not.toBeNull();
    // Later reads from Shopify do not bring them back, and the redaction itself stays.
    for (const offset of [5_000, 10_000]) {
      shopify.upsertOrder(shop, { id: '9201', updatedAt: iso(offset) });
      await shopify.deliver(shop, 'orders/updated', { id: 9201, updated_at: iso(offset) });
      await drain(c, storeId);
      const [reread] = await orderRows(storeId);
      expect(reread).toMatchObject({ customer_phone: null, customer_email: null });
      expect(reread?.redacted_at).not.toBeNull();
    }

    // customers/data_request: kept for the company until answered.
    expect(
      await shopify.deliverCompliance('customers/data_request', {
        shop_id: 1,
        shop_domain: shop,
        customer: { id: 2, email: 'q@example.com', phone: '+919822222222' },
        orders_requested: [9202],
        data_request: { id: 55 },
      }),
    ).toBe(200);
    const detail = await service().store(owner, storeId);
    const request = detail.privacyRequests.find((r) => r.kind === 'data_request');
    expect(request).toMatchObject({
      customerEmail: 'q@example.com',
      orderIds: ['9202'],
      answeredAt: null,
    });
    const agentView = await service().store(await fx.ctx(c, c.agent), storeId);
    expect(
      agentView.privacyRequests.find((r) => r.kind === 'data_request')?.customerEmail,
    ).toBeNull();
    await service().answerPrivacyRequest(owner, request?.id as string);
    expect(
      (await service().store(owner, storeId)).privacyRequests.find(
        (r) => r.kind === 'data_request',
      ),
    ).toMatchObject({
      customerEmail: null,
      customerPhone: null,
    });

    // shop/redact does nothing to a store that is still installed.
    expect(await shopify.deliverCompliance('shop/redact', { shop_id: 1, shop_domain: shop })).toBe(
      200,
    );
    expect(await storeRow(storeId)).toMatchObject({ state: 'connected' });

    // An app/uninstalled body naming another shop is refused (the HMAC does not cover headers).
    const body = JSON.stringify({ id: 1, myshopify_domain: 'other.myshopify.com' });
    const mismatch = await handleShopifyWebhook(webhookDeps(), {
      rawBody: Buffer.from(body),
      hmac: createHmac('sha256', CLIENT_SECRET).update(body).digest('base64'),
      topic: 'app/uninstalled',
      shopDomain: shop,
      webhookId: 'uninstall-forged',
    });
    expect(mismatch).toMatchObject({ status: 400, log: { outcome: 'shop_mismatch' } });
    expect(await storeRow(storeId)).toMatchObject({ state: 'connected' });

    // The merchant uninstalls HyFib: access goes, the copy stays until shop/redact (SH-028).
    const [uninstalled] = await shopify.uninstall(shop);
    expect(uninstalled?.status).toBe(200);
    expect(await storeRow(storeId)).toMatchObject({
      state: 'uninstalled',
      credentials_ciphertext: null,
    });
    expect(await shopify.deliverCompliance('shop/redact', { shop_id: 1, shop_domain: shop })).toBe(
      200,
    );
    expect(await storeRow(storeId)).toBeUndefined();
    expect(await orderRows(storeId)).toHaveLength(0);

    // Removal by the company uninstalls HyFib from the shop and deletes the copy.
    const shop2 = newShop();
    shopify.addShop(shop2);
    shopify.upsertOrder(shop2, { id: '9301' });
    const { storeId: second } = await connectShopify(c, owner, shop2);
    await drain(c, second);
    await service().removeStore(owner, second);
    expect(await processStoreJob(workerDeps(), scopeOf(c), second)).toBe('removed');
    expect(shopify.shops.get(shop2)?.installed).toBe(false);
    expect(await storeRow(second)).toBeUndefined();
    const audit = await fx.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'commerce.store_removed'",
      [c.tenant.id],
    );
    expect(audit.at(-1)?.metadata).toMatchObject({ platform: 'shopify', remote: 'done' });
  });
});

describe('WooCommerce stores', () => {
  it('connects through the key handover, creates signed webhooks and reads orders and products', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const site = `site-${Date.now().toString(36)}`;
    woo.addSite(site, 'INR');
    woo.upsertOrder(site, {
      id: 41,
      number: '41',
      status: 'processing',
      total: '1234.50',
      billing: {
        first_name: 'Ravi',
        last_name: 'S',
        email: 'ravi@example.com',
        phone: '+91 99000 11122',
      },
      line_items: [{ id: 1, name: 'Mug', sku: 'MUG', quantity: 3, total: '1234.50', price: 411.5 }],
    });
    woo.upsertProduct(site, { id: 900, name: 'Mug', price: '411.50', sku: 'MUG' });

    const { url, storeId } = await service().startWooConnect(owner, { url: woo.siteUrl(site) });
    expect(new URL(url).searchParams.get('scope')).toBe('read_write');
    // The owner approves: WooCommerce posts the keys to HyFib, then sends the browser back.
    const back = await fetch(url, { redirect: 'manual' });
    expect(back.status).toBe(302);
    expect(new URL(back.headers.get('location') ?? '').searchParams.get('success')).toBe('1');
    expect(await storeRow(storeId)).toMatchObject({ state: 'connecting' });

    expect(await drain(c, storeId)).toEqual(['connected', 'synced']);
    const hooks = woo.sites.get(site)?.webhooks;
    expect([...(hooks?.values() ?? [])].map((h) => h.topic).sort()).toEqual(
      [
        'order.created',
        'order.deleted',
        'order.restored',
        'order.updated',
        'product.created',
        'product.deleted',
        'product.restored',
        'product.updated',
      ].sort(),
    );
    // HyFib answered every creation ping with 200 (WC-012).
    expect(woo.sites.get(site)?.pings.every((s) => s === 200)).toBe(true);
    expect(await orderRows(storeId)).toMatchObject([
      {
        name: '#41',
        status: 'processing',
        total_minor: '123450',
        customer_phone: '+919900011122',
        customer_name: 'Ravi S',
      },
    ]);
    const [product] = await fx.query<Record<string, unknown>>(
      'SELECT title, price_min_minor, currency FROM app.commerce_store_products WHERE store_id = $1',
      [storeId],
    );
    expect(product).toEqual({ title: 'Mug', price_min_minor: '41150', currency: 'INR' });

    // A signed delivery signals a read; a forged one is refused; a deletion is marked.
    woo.upsertOrder(site, { id: 41, status: 'completed' });
    expect((await woo.deliver(site, 'order.updated', 41))[0]?.status).toBe(200);
    await drain(c, storeId);
    expect((await orderRows(storeId))[0]).toMatchObject({ status: 'completed' });
    const store = await storeRow(storeId);
    const forged = await handleWooWebhook(webhookDeps(), {
      publicId: String(store?.webhook_public_id),
      rawBody: Buffer.from('{"id":41}'),
      signature: createHmac('sha256', 'guess').update('{"id":41}').digest('base64'),
      topic: 'order.updated',
      deliveryId: 'x1',
    });
    expect(forged.status).toBe(401);
    // Only WooCommerce's creation ping may come without a signature, and it changes nothing.
    const unsigned = await handleWooWebhook(webhookDeps(), {
      publicId: String(store?.webhook_public_id),
      rawBody: Buffer.from('{"id":41}'),
      signature: null,
      topic: 'order.updated',
      deliveryId: 'x2',
    });
    expect(unsigned.status).toBe(401);
    expect((await woo.deliver(site, 'order.deleted', 41))[0]?.status).toBe(200);
    expect((await orderRows(storeId))[0]?.deleted_at).not.toBeNull();

    // WooCommerce disabled a webhook after failed deliveries (WC-018): the check re-enables it.
    const hook = [...(hooks?.values() ?? [])].find((h) => h.topic === 'order.updated');
    if (!hook) throw new Error('no webhook');
    hook.status = 'disabled';
    await fx.query(
      "UPDATE app.commerce_stores SET webhooks_checked_at = now() - interval '7 hours' WHERE id = $1",
      [storeId],
    );
    await processStoreJob(workerDeps(), scopeOf(c), storeId);
    expect(hook.status).toBe('active');

    // Revoked keys fail the store with a reason the company can act on.
    woo.revokeKeys(site);
    await fx.query('UPDATE app.commerce_stores SET next_sync_at = now() WHERE id = $1', [storeId]);
    expect(await processStoreJob(workerDeps(), scopeOf(c), storeId)).toBe('failed');
    expect(String((await storeRow(storeId))?.status_error)).toMatch(/refused the keys/);
  });

  it('refuses keys without write access and keys for another store', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const site = `ro-${Date.now().toString(36)}`;
    woo.addSite(site);
    // The handover of read-only keys is refused, so WooCommerce deletes them again (WC-003).
    woo.grantPermissions = 'read';
    try {
      const { url, storeId } = await service().startWooConnect(owner, { url: woo.siteUrl(site) });
      const denied = await fetch(url, { redirect: 'manual' });
      expect(denied.status).toBe(401);
      expect(woo.sites.get(site)?.keys.size).toBe(0);
      expect(await storeRow(storeId)).toMatchObject({ state: 'authorizing' });
    } finally {
      woo.grantPermissions = 'read_write';
    }
    // Pasted keys that belong to another site fail against this store's own address.
    const otherSite = `other-${Date.now().toString(36)}`;
    const keys = woo.addKeys(otherSite);
    const { storeId } = await service().saveWooKeys(owner, { url: woo.siteUrl(site), ...keys });
    expect(await processStoreJob(workerDeps(), scopeOf(c), storeId)).toBe('failed');
    expect(String((await storeRow(storeId))?.status_error)).toMatch(/refused the keys/);
    // A handover for an unknown handshake is refused.
    expect(
      (
        await service().acceptWooKeys({
          user_id: 'A'.repeat(43),
          consumer_key: keys.consumerKey,
          consumer_secret: keys.consumerSecret,
          key_permissions: 'read_write',
        })
      ).status,
    ).toBe(404);
  });
});

describe('store data and people', () => {
  it('redacts an erased contact’s store orders for good and keeps companies apart', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const site = `erase-${Date.now().toString(36)}`;
    woo.addSite(site);
    const keys = woo.addKeys(site);
    woo.upsertOrder(site, {
      id: 51,
      total: '10.00',
      billing: {
        first_name: 'Meera',
        last_name: '',
        email: 'meera@example.com',
        phone: '+919833333333',
      },
    });
    const { storeId } = await service().saveWooKeys(owner, { url: woo.siteUrl(site), ...keys });
    await drain(c, storeId);
    const contacts = createContactsService({ db: fx.dbs.app, clock: systemClock });
    const contact = await contacts.createContact(owner, {
      displayName: 'Meera',
      phone: '+919833333333',
    });
    expect((await orderRows(storeId))[0]).toMatchObject({ customer_phone: '+919833333333' });

    await contacts.eraseContact(owner, { contactId: contact.id, suppress: true });
    const [erased] = await orderRows(storeId);
    expect(erased).toMatchObject({
      customer_name: null,
      customer_phone: null,
      customer_email: null,
    });
    expect(erased?.redacted_at).not.toBeNull();
    // Read again from the store (it still has the details): they stay empty, and a new order from
    // the same number is kept without them (the number is suppressed as erased).
    woo.upsertOrder(site, { id: 51, status: 'completed' });
    woo.upsertOrder(site, {
      id: 52,
      total: '20.00',
      billing: {
        first_name: 'Meera',
        last_name: '',
        email: 'meera@example.com',
        phone: '+919833333333',
      },
    });
    await fx.query('UPDATE app.commerce_stores SET next_sync_at = now() WHERE id = $1', [storeId]);
    await drain(c, storeId);
    const after = await orderRows(storeId);
    expect(after).toHaveLength(2);
    for (const order of after)
      expect(order).toMatchObject({ customer_phone: null, customer_email: null });

    // Another company sees nothing of this store.
    const other = await fx.company();
    const otherOwner = await fx.ctx(other, other.owner);
    expect(await service().stores(otherOwner)).toEqual([]);
    await expectAppError(service().store(otherOwner, storeId), 'not_found');
    await expectAppError(service().storeOrder(otherOwner, after[0]?.id as string), 'not_found');
    expect((await service().storeOrders(otherOwner, { storeId })).orders).toEqual([]);
  });

  it('refuses late approvals, deletes a handshake nobody approved, and sweeps work due', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const shop = newShop();
    shopify.addShop(shop);
    const { url } = await service().startShopifyConnect(owner, { shop });
    // The merchant approves in Shopify, but the callback arrives after the handshake expired.
    const redirect = await fetch(url, { redirect: 'manual' });
    const query = new URL(redirect.headers.get('location') ?? '').searchParams;
    const [row] = await fx.query<{ id: string }>(
      'SELECT id FROM app.commerce_stores WHERE tenant_id = $1 AND shop_domain = $2',
      [c.tenant.id, shop],
    );
    const id = row?.id as string;
    await fx.query(
      "UPDATE app.commerce_stores SET connect_expires_at = now() - interval '2 hours' WHERE id = $1",
      [id],
    );
    expect(await service().shopifyCallback(query)).toEqual({ ok: false, reason: 'unknown_state' });
    // WooCommerce's key handover after its handshake expired is refused, so it deletes the keys.
    const site = `late-${Date.now().toString(36)}`;
    woo.addSite(site);
    const late = await service().startWooConnect(owner, { url: woo.siteUrl(site) });
    await fx.query(
      "UPDATE app.commerce_stores SET connect_expires_at = now() - interval '1 minute' WHERE id = $1",
      [late.storeId],
    );
    expect((await fetch(late.url, { redirect: 'manual' })).status).toBe(401);
    expect(woo.sites.get(site)?.keys.size).toBe(0);
    expect(await storeRow(late.storeId)).toMatchObject({ state: 'authorizing' });

    expect((await findDueStoreWork(fx.dbs.app, 500)).map((d) => d.storeId)).toContain(id);
    expect(await processStoreJob(workerDeps(), scopeOf(c), id)).toBe('expired');
    expect(await storeRow(id)).toBeUndefined();
  });

  it('keeps at most the product limit per store and says the copy is incomplete', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const site = `cap-${Date.now().toString(36)}`;
    woo.addSite(site);
    const keys = woo.addKeys(site);
    const { storeId } = await service().saveWooKeys(owner, { url: woo.siteUrl(site), ...keys });
    await fx.query(
      `INSERT INTO app.commerce_store_products
         (id, tenant_id, store_id, external_id, title, status, variants, remote_updated_at, synced_at)
       SELECT gen_random_uuid(), $1, $2, g::text, 'P' || g, 'publish', 1, now() - interval '1 day', now()
         FROM generate_series(1, $3::int) AS g`,
      [c.tenant.id, storeId, STORE_LIMITS.productsPerStore],
    );
    const product = (externalId: string, title: string) => ({
      externalId,
      title,
      status: 'publish',
      sku: null,
      url: null,
      currency: null,
      priceMinMinor: null,
      priceMaxMinor: null,
      inventory: null,
      variants: 1,
      remoteUpdatedAt: new Date(),
    });
    await fx.dbs.app.run(scopeOf(c), (tx) =>
      saveStoreProducts(
        tx,
        { id: storeId, tenantId: c.tenant.id },
        [product('1', 'Updated'), product('99999999', 'One too many')],
        new Date(),
      ),
    );
    const [counts] = await fx.query<{ n: number; updated: number }>(
      "SELECT count(*)::int AS n, count(*) FILTER (WHERE title = 'Updated')::int AS updated FROM app.commerce_store_products WHERE store_id = $1",
      [storeId],
    );
    expect(counts).toEqual({ n: STORE_LIMITS.productsPerStore, updated: 1 });
    expect(await storeRow(storeId)).toMatchObject({ products_truncated: true });
  });
});
