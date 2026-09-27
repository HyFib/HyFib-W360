import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, type Clock } from '@w360/core';
import { createEgressClient, DEFAULT_EGRESS_POLICY } from '@w360/core/egress';
import { authorizedTenantScope } from '@w360/db';
import {
  codPayload,
  createConsentService,
  createContactsService,
  createSegmentsService,
  createStoreMessagesService,
  createStoreService,
  createTemplatesService,
  findDueStoreMessages,
  findDueStoreWork,
  handleShopifyWebhook,
  handleWooWebhook,
  processSendIntent,
  processStoreJob,
  processStoreMessage,
  processTemplateSubmit,
  saveStoreOrders,
  saveStoreProducts,
  STORE_LIMITS,
  syncTemplates,
  type StoreMessageEvent,
  type StoreVariables,
  type StoreWorkerDeps,
  type TemplateDefinition,
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
            paymentNames: [],
            cashOnDelivery: false,
            shippedAt: null,
            deliveredAt: null,
            trackingCompany: null,
            trackingNumber: null,
            trackingUrl: null,
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

// Order messages (P4-06c) ---------------------------------------------------------------------------

const storeMessages = (clock: Clock = systemClock) =>
  createStoreMessagesService({ db: fx.dbs.app, clock });
const messageDeps = (clock: Clock = systemClock) => ({
  db: fx.dbs.app,
  clock,
  jobs: fx.jobs(),
  signer: fx.signer,
});
const sendRate = { capacity: 1000, refillPerSecond: 1000 };
let templateCounter = 0;

const orderUpdate: TemplateDefinition = {
  category: 'UTILITY',
  header: { type: 'none' },
  body: {
    text: 'Hi {{1}}, an update on your order {{2}}: {{3}}.',
    examples: ['Asha', '#1001', 'it is on its way'],
  },
  footer: null,
  buttons: [],
};
const codConfirm: TemplateDefinition = {
  category: 'UTILITY',
  header: { type: 'none' },
  body: {
    text: 'Please confirm your cash on delivery order {{1}} of {{2}}.',
    examples: ['#1001', '₹1,499.00'],
  },
  footer: null,
  buttons: [
    { type: 'QUICK_REPLY', text: 'Confirm order' },
    { type: 'QUICK_REPLY', text: 'Cancel order' },
  ],
};

/** A template created, submitted and approved through the Graph stand-in, then synced. */
async function approvedTemplate(c: Company, owner: TenantContext, definition: TemplateDefinition) {
  templateCounter += 1;
  const name = `order_msg_${templateCounter}_${Date.now().toString(36)}`;
  const deps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock };
  const templates = createTemplatesService(deps);
  const { id } = await templates.createDraft(owner, {
    whatsappAccountId: c.whatsappAccountId,
    name,
    language: 'en',
    definition,
  });
  await templates.submitTemplate(owner, id);
  const graphDeps = { ...deps, keyring: fx.keyring, graph: fx.graph };
  expect(await processTemplateSubmit(graphDeps, scopeOf(c), id)).toBe('done');
  const t = fx.standIn.state.templates.get(c.wabaId)?.find((x) => x.name === name);
  if (!t) throw new Error('template not at the stand-in');
  t.status = 'APPROVED';
  await syncTemplates(graphDeps, scopeOf(c), c.whatsappAccountId);
  return { id, name };
}

/** The template's three body variables: the customer, the order and something about the event. */
const update = (third: StoreVariables['body'][number]): StoreVariables => ({
  header: [],
  body: [
    { source: 'order', field: 'customer_name', fallback: 'there' },
    { source: 'order', field: 'order_name' },
    third,
  ],
});

async function saveRule(
  owner: TenantContext,
  c: Company,
  storeId: string,
  event: StoreMessageEvent,
  input: {
    templateId: string;
    variables: StoreVariables;
    enabled?: boolean;
    delayMinutes?: number;
    confirmButton?: number | null;
    cancelButton?: number | null;
  },
) {
  const view = await storeMessages().storeMessages(owner, storeId);
  const rule = view.rules.find((r) => r.event === event);
  return storeMessages().saveMessageRule(owner, {
    storeId,
    event,
    enabled: input.enabled ?? true,
    channelAccountId: c.channelAccountId,
    templateId: input.templateId,
    variables: input.variables,
    delayMinutes: input.delayMinutes ?? 0,
    confirmButton: input.confirmButton ?? null,
    cancelButton: input.cancelButton ?? null,
    version: rule?.version ?? 0,
  });
}

const optIn = (owner: TenantContext, storeId: string, extra: Record<string, unknown> = {}) =>
  storeMessages().saveMessageSettings(owner, {
    storeId,
    optIn: true,
    windowStart: '',
    windowEnd: '',
    testOrders: false,
    ...extra,
  });

async function messageRows(storeId: string) {
  return fx.query<Record<string, unknown> & { id: string; event: string; message_id: string }>(
    `SELECT sm.*, o.external_id FROM app.commerce_store_messages sm
       JOIN app.commerce_store_orders o ON o.id = sm.order_id
      WHERE sm.store_id = $1 ORDER BY sm.created_at, sm.event`,
    [storeId],
  );
}

/** Handles every waiting store message of the store, as its job would (bounded, in order). */
async function runMessages(c: Company, storeId: string, clock: Clock = systemClock) {
  const rows = await fx.query<{ id: string }>(
    `SELECT id FROM app.commerce_store_messages WHERE store_id = $1 AND state = 'pending'
      ORDER BY created_at`,
    [storeId],
  );
  const outcomes = [];
  for (const row of rows) {
    outcomes.push(await processStoreMessage(messageDeps(clock), scopeOf(c), row.id));
  }
  return outcomes;
}

/** Hands every queued send of the company to the Graph stand-in. */
async function sendAll(c: Company) {
  const intents = await fx.query<{ id: string; actor_user_id: string | null }>(
    `SELECT id, actor_user_id FROM app.send_intents WHERE tenant_id = $1 AND state = 'queued'
      ORDER BY created_at`,
    [c.tenant.id],
  );
  const outcomes = [];
  for (const intent of intents) {
    const result = await processSendIntent(
      {
        db: fx.dbs.app,
        keyring: fx.keyring,
        graph: fx.graph,
        clock: systemClock,
        rate: sendRate,
        jobs: fx.jobs(),
        signer: fx.signer,
      },
      authorizedTenantScope(c.tenant.id, intent.actor_user_id),
      intent.id,
    );
    outcomes.push(result.outcome);
  }
  return outcomes;
}

/** The template messages WhatsApp received for a number, oldest first. */
const templatesTo = (to: string) =>
  fx.standIn.state.requests
    .filter((r) => r.path.endsWith('/messages') && (r.body as { to?: string }).to === to)
    .map((r) => (r.body as { template: { name: string; components: unknown[] } }).template);

const bodyTexts = (template: { components: unknown[] } | undefined) =>
  (
    (template?.components ?? []).find((c) => (c as { type: string }).type === 'body') as
      { parameters: { text: string }[] } | undefined
  )?.parameters.map((p) => p.text);

/** A connected Shopify store whose customers' opt-in a manager confirmed. */
async function shopifyStoreForMessages(c: Company, owner: TenantContext, name = 'Tara Tea') {
  const shop = newShop();
  shopify.addShop(shop, { name, currency: 'INR' });
  const { storeId } = await connectShopify(c, owner, shop);
  expect(await drain(c, storeId)).toEqual(['connected', 'synced']);
  return { shop, storeId };
}

const orderSignal = (shop: string, id: string, topic = 'orders/updated') =>
  shopify.deliver(shop, topic, {
    id: Number(id),
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    updated_at: iso(),
  });

describe('Order messages', () => {
  it('sends the chosen templates when Shopify orders are placed, shipped, delivered and cancelled', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const shop = newShop();
    shopify.addShop(shop, { name: 'Tara Tea', currency: 'INR' });
    // An order from yesterday: the first read brings it, and nothing is ever sent about it.
    shopify.upsertOrder(shop, {
      id: '5000',
      phone: '+919812300000',
      createdAt: iso(-86_400_000),
      processedAt: iso(-86_400_000),
      updatedAt: iso(-86_400_000),
    });
    const template = await approvedTemplate(c, owner, orderUpdate);
    const { storeId } = await connectShopify(c, owner, shop);
    await drain(c, storeId);

    // No message can be switched on before a manager confirms the customers' opt-in (M-175).
    const placedVars = update({ source: 'static', value: 'we received it' });
    await expectAppError(
      saveRule(owner, c, storeId, 'order_placed', {
        templateId: template.id,
        variables: placedVars,
      }),
      'validation_failed',
      /agreed to receive/,
    );
    await optIn(owner, storeId);
    await saveRule(owner, c, storeId, 'order_placed', {
      templateId: template.id,
      variables: placedVars,
    });
    await fx.query('UPDATE app.commerce_stores SET next_sync_at = now() WHERE id = $1', [storeId]);
    await drain(c, storeId);
    expect(await messageRows(storeId)).toEqual([]);

    // A new order: the webhook makes HyFib read it, and the confirmation goes out.
    shopify.upsertOrder(shop, {
      id: '5001',
      name: '#1001',
      phone: '+919812345678',
      shippingAddress: { name: 'Asha K', phone: null },
      total: { amount: '1499.00', currencyCode: 'INR' },
      lineItems: [
        {
          name: 'Assam tea',
          sku: 'T',
          quantity: 3,
          total: { amount: '1499.00', currencyCode: 'INR' },
        },
      ],
    });
    expect((await orderSignal(shop, '5001', 'orders/create'))[0]?.status).toBe(200);
    await drain(c, storeId);
    const [placed] = await messageRows(storeId);
    expect(placed).toMatchObject({ event: 'order_placed', state: 'pending', external_id: '5001' });
    // Its job waits for its send time (the sweep would find it too).
    const jobs = await fx.query(
      `SELECT 1 FROM pgboss.job WHERE name = 'commerce.store-message' AND singleton_key LIKE $1`,
      [`store-message:${placed?.id}:%`],
    );
    expect(jobs).toHaveLength(1);
    expect(await runMessages(c, storeId)).toMatchObject([{ outcome: 'queued' }]);
    expect(await sendAll(c)).toEqual(['accepted']);
    expect(templatesTo('919812345678').map((t) => t.name)).toEqual([template.name]);
    expect(bodyTexts(templatesTo('919812345678')[0])).toEqual([
      'Asha K',
      '#1001',
      'we received it',
    ]);
    // In the chat it is an automatic message from the store, in a thread that stays resolved; the
    // customer became a contact from the order.
    const [placedRow] = await messageRows(storeId);
    const [chat] = await fx.query<{
      sender_type: string;
      content: { store: unknown };
      status: string;
    }>(
      `SELECT m.sender_type, m.content, cv.status FROM app.messages m
         JOIN app.conversations cv ON cv.id = m.conversation_id WHERE m.id = $1`,
      [placedRow?.message_id],
    );
    expect(chat).toMatchObject({ sender_type: 'system', status: 'resolved' });
    expect(chat?.content.store).toMatchObject({
      event: 'order_placed',
      orderName: '#1001',
      name: 'Tara Tea',
    });
    expect(
      await fx.query(
        `SELECT source, display_name FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2`,
        [c.tenant.id, '+919812345678'],
      ),
    ).toEqual([{ source: 'store', display_name: 'Asha K' }]);
    // Contacts made from store orders can be picked in segments.
    const segments = createSegmentsService({ db: fx.dbs.app, clock: systemClock });
    expect(
      (
        await segments.previewDefinition(owner, {
          match: 'all',
          conditions: [{ type: 'source', source: 'store' }],
        })
      ).sample.map((p) => p.phoneE164),
    ).toEqual(['+919812345678']);

    // Repeated deliveries and a full read again never send a second confirmation.
    await orderSignal(shop, '5001');
    await drain(c, storeId);
    await fx.query(
      `UPDATE app.commerce_stores SET next_sync_at = now(), orders_cursor = now() - interval '2 days'
        WHERE id = $1`,
      [storeId],
    );
    await drain(c, storeId);
    expect(await messageRows(storeId)).toHaveLength(1);

    // Shipped: the shipment's tracking fills the message.
    await saveRule(owner, c, storeId, 'order_shipped', {
      templateId: template.id,
      variables: update({ source: 'order', field: 'tracking_number' }),
    });
    shopify.upsertOrder(shop, {
      id: '5001',
      displayFulfillmentStatus: 'FULFILLED',
      fulfillments: [
        {
          status: 'SUCCESS',
          displayStatus: 'IN_TRANSIT',
          createdAt: iso(),
          updatedAt: iso(),
          deliveredAt: null,
          trackingInfo: [
            { company: 'Delhivery', number: 'AWB123', url: 'https://track.example/AWB123' },
          ],
        },
      ],
    });
    await orderSignal(shop, '5001');
    await drain(c, storeId);
    expect(await runMessages(c, storeId)).toMatchObject([{ outcome: 'queued' }]);
    expect(await sendAll(c)).toEqual(['accepted']);
    expect(bodyTexts(templatesTo('919812345678')[1])).toEqual(['Asha K', '#1001', 'AWB123']);
    expect((await orderRows(storeId)).find((o) => o.external_id === '5001')).toMatchObject({
      tracking_company: 'Delhivery',
      tracking_number: 'AWB123',
      tracking_url: 'https://track.example/AWB123',
    });

    // Delivered: the order itself does not change when the parcel arrives (SH-034), so no webhook
    // comes; HyFib reads orders in transit again once they were last read three hours ago.
    await saveRule(owner, c, storeId, 'order_delivered', {
      templateId: template.id,
      variables: update({ source: 'static', value: 'it was delivered' }),
    });
    const stored = shopify.shops.get(shop)?.orders.get('5001');
    const shipment = stored?.fulfillments[0];
    if (!stored || !shipment) throw new Error('no shipment');
    stored.fulfillments = [
      { ...shipment, displayStatus: 'DELIVERED', deliveredAt: iso(), updatedAt: iso() },
    ];
    await processStoreJob(workerDeps(), scopeOf(c), storeId);
    expect(await messageRows(storeId)).toHaveLength(2);
    const threeHours = later(3 * 3_600_000 + 60_000);
    await processStoreJob(workerDeps(threeHours), scopeOf(c), storeId);
    expect((await messageRows(storeId)).map((r) => [r.event, r.state])).toEqual([
      ['order_placed', 'queued'],
      ['order_shipped', 'queued'],
      ['order_delivered', 'pending'],
    ]);
    expect(await runMessages(c, storeId, threeHours)).toMatchObject([{ outcome: 'queued' }]);
    expect(await sendAll(c)).toEqual(['accepted']);
    expect(bodyTexts(templatesTo('919812345678')[2])?.[2]).toBe('it was delivered');

    // Cancelled (Shopify says when).
    await saveRule(owner, c, storeId, 'order_cancelled', {
      templateId: template.id,
      variables: update({ source: 'static', value: 'it was cancelled' }),
    });
    shopify.upsertOrder(shop, { id: '5001', cancelledAt: iso() });
    await orderSignal(shop, '5001');
    await drain(c, storeId);
    expect(await runMessages(c, storeId)).toMatchObject([{ outcome: 'queued' }]);
    expect(await sendAll(c)).toEqual(['accepted']);
    expect(templatesTo('919812345678')).toHaveLength(4);

    // The report and the order's own list.
    const view = await storeMessages().storeMessages(owner, storeId);
    expect(view.rules.filter((r) => r.enabled).map((r) => r.event)).toEqual([
      'order_placed',
      'order_shipped',
      'order_delivered',
      'order_cancelled',
    ]);
    expect(view.recent).toHaveLength(4);
    expect(view.counts.sent).toBe(4);
    const orderId = String(placedRow?.order_id);
    expect((await storeMessages().orderMessages(owner, orderId)).map((m) => m.event)).toEqual([
      'order_placed',
      'order_shipped',
      'order_delivered',
      'order_cancelled',
    ]);
  });

  it('asks cash on delivery customers to confirm, and records taps only from that message', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { shop, storeId } = await shopifyStoreForMessages(c, owner);
    const confirmation = await approvedTemplate(c, owner, orderUpdate);
    const cod = await approvedTemplate(c, owner, codConfirm);
    await optIn(owner, storeId);
    await saveRule(owner, c, storeId, 'order_placed', {
      templateId: confirmation.id,
      variables: update({ source: 'static', value: 'we received it' }),
    });
    const codVars: StoreVariables = {
      header: [],
      body: [
        { source: 'order', field: 'order_name' },
        { source: 'order', field: 'order_total' },
      ],
    };
    // The same button for both answers, or a template without two quick replies, is refused.
    await expectAppError(
      saveRule(owner, c, storeId, 'cod_confirmation', {
        templateId: cod.id,
        variables: codVars,
        confirmButton: 0,
        cancelButton: 0,
      }),
      'validation_failed',
      /quick reply/,
    );
    await expectAppError(
      saveRule(owner, c, storeId, 'cod_confirmation', {
        templateId: confirmation.id,
        variables: update({ source: 'static', value: 'x' }),
        confirmButton: 0,
        cancelButton: 1,
      }),
      'validation_failed',
      /quick reply/,
    );
    await saveRule(owner, c, storeId, 'cod_confirmation', {
      templateId: cod.id,
      variables: codVars,
      confirmButton: 0,
      cancelButton: 1,
    });

    shopify.upsertOrder(shop, {
      id: '5101',
      name: '#2001',
      phone: '+919812399999',
      paymentGatewayNames: ['Cash on Delivery (COD)'],
      displayFinancialStatus: 'PENDING',
      total: { amount: '1499.00', currencyCode: 'INR' },
    });
    await orderSignal(shop, '5101', 'orders/create');
    await drain(c, storeId);
    // The plain confirmation gives way to the cash on delivery message.
    expect((await messageRows(storeId)).map((r) => [r.event, r.state, r.skip_reason])).toEqual([
      ['cod_confirmation', 'pending', null],
      ['order_placed', 'skipped', 'cash_on_delivery'],
    ]);
    expect(await runMessages(c, storeId)).toMatchObject([{ outcome: 'queued' }]);
    expect(await sendAll(c)).toEqual(['accepted']);
    const codRow = (await messageRows(storeId)).find((r) => r.event === 'cod_confirmation');
    if (!codRow) throw new Error('no cod message');
    const [sent] = templatesTo('919812399999');
    expect(sent?.name).toBe(cod.name);
    expect(sent?.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: '#2001' },
          { type: 'text', text: '₹1,499.00' },
        ],
      },
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '0',
        parameters: [{ type: 'payload', payload: codPayload(codRow.id, 'confirm') }],
      },
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '1',
        parameters: [{ type: 'payload', payload: codPayload(codRow.id, 'cancel') }],
      },
    ]);
    const [out] = await fx.query<{ external_message_id: string; conversation_id: string }>(
      'SELECT external_message_id, conversation_id FROM app.messages WHERE id = $1',
      [codRow.message_id],
    );
    if (!out) throw new Error('no chat message');

    // "Cancel order" is even one of the company's opt-out keywords: a tap is an answer, not one.
    await createConsentService({ db: fx.dbs.app, clock: systemClock }).updateSettings(owner, {
      optOutKeywords: 'STOP\nCancel order',
      marketingOptOutKeywords: '',
      optInKeywords: '',
      requireMarketingOptIn: false,
    });
    const now = Math.floor(Date.now() / 1000);
    const tap = (
      answer: 'confirm' | 'cancel',
      opts: { waId?: string; context?: string; at?: number; id?: string } = {},
    ) =>
      fx.deliver(
        fx.messagesBody(c, {
          messages: [
            {
              waId: opts.waId ?? '919812399999',
              type: 'button',
              timestamp: opts.at ?? now,
              extra: {
                button: {
                  payload: codPayload(opts.id ?? codRow.id, answer),
                  text: answer === 'confirm' ? 'Confirm order' : 'Cancel order',
                },
                context: { from: '919000000000', id: opts.context ?? out.external_message_id },
              },
            },
          ],
        }),
      );
    await tap('cancel');
    const answered = async () =>
      (
        await fx.query<{ answer: string | null; answered_at: Date | null }>(
          'SELECT answer, answered_at FROM app.commerce_store_messages WHERE id = $1',
          [codRow.id],
        )
      )[0];
    expect((await answered())?.answer).toBe('cancelled');
    // A cancellation reopens the conversation for the team; nobody was opted out.
    const thread = async () =>
      (
        await fx.query<{ status: string; unread_count: number }>(
          'SELECT status, unread_count FROM app.conversations WHERE id = $1',
          [out.conversation_id],
        )
      )[0];
    expect(await thread()).toMatchObject({ status: 'open', unread_count: 1 });
    expect(
      await fx.query(
        `SELECT 1 FROM app.contact_consents cc JOIN app.contacts ct ON ct.id = cc.contact_id
          WHERE ct.phone_e164 = '+919812399999' AND cc.status = 'opted_out'`,
      ),
    ).toEqual([]);

    // A later confirmation replaces it quietly; an older tap arriving late does not.
    await tap('confirm', { at: now + 5 });
    expect((await answered())?.answer).toBe('confirmed');
    expect((await thread())?.unread_count).toBe(1);
    await tap('cancel', { at: now - 60 });
    expect((await answered())?.answer).toBe('confirmed');

    // Another customer cannot answer it, nor can a tap that replies to another message.
    await tap('cancel', { waId: '919812300001', at: now + 10 });
    await tap('cancel', { context: 'wamid.someone-else', at: now + 11 });
    expect((await answered())?.answer).toBe('confirmed');

    expect(
      (await storeMessages().orderMessages(owner, String(codRow.order_id))).find(
        (m) => m.event === 'cod_confirmation',
      ),
    ).toMatchObject({ answer: 'confirmed' });
  });

  it('sends nothing about the past, and skips test orders, late events and customers who cannot be messaged', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { shop, storeId } = await shopifyStoreForMessages(c, owner);
    const template = await approvedTemplate(c, owner, orderUpdate);
    await optIn(owner, storeId);
    const vars = update({ source: 'static', value: 'we received it' });
    await saveRule(owner, c, storeId, 'order_placed', { templateId: template.id, variables: vars });

    const contacts = createContactsService({ db: fx.dbs.app, clock: systemClock });
    const consent = createConsentService({ db: fx.dbs.app, clock: systemClock });
    const optedOut = await contacts.createContact(owner, {
      displayName: 'No',
      phone: '+919811100001',
    });
    await consent.recordConsent(owner, {
      contactId: optedOut.id,
      purpose: 'utility',
      action: 'opt_out',
    });
    await consent.addSuppression(owner, { phone: '+919811100002', reason: 'manual' });
    const place = async (id: string, extra: Record<string, unknown> = {}) => {
      shopify.upsertOrder(shop, { id, name: `#${id}`, ...extra });
      await orderSignal(shop, id, 'orders/create');
    };
    await place('6001', { phone: '+919811100000', test: true });
    await place('6002', { phone: '+919811100001' });
    await place('6003', { phone: '+919811100002' });
    await place('6004', { phone: null, shippingAddress: null });
    await place('6005', {
      phone: '+919811100005',
      displayFulfillmentStatus: 'FULFILLED',
      fulfillments: [
        {
          status: 'SUCCESS',
          displayStatus: 'IN_TRANSIT',
          createdAt: iso(),
          updatedAt: iso(),
          deliveredAt: null,
          trackingInfo: [{ company: 'Delhivery', number: 'AWB605', url: 'https://t.example/605' }],
        },
      ],
    });
    await drain(c, storeId);
    expect(
      (await messageRows(storeId)).map((r) => [r.external_id, r.state, r.skip_reason]),
    ).toEqual([
      ['6001', 'skipped', 'test_order'],
      ['6002', 'pending', null],
      ['6003', 'pending', null],
      ['6004', 'pending', null],
      ['6005', 'pending', null],
    ]);

    // The customer's details go before the send (contact erasure also clears tracking).
    const erasable = await contacts.createContact(owner, {
      displayName: 'Gone',
      phone: '+919811100005',
    });
    await contacts.eraseContact(owner, { contactId: erasable.id, suppress: false });
    // The tracking goes with the customer, and a read from the store (which still has it, and the
    // number is not suppressed) keeps it out.
    await fx.query(
      `UPDATE app.commerce_stores SET next_sync_at = now(), orders_cursor = now() - interval '1 day'
        WHERE id = $1`,
      [storeId],
    );
    await drain(c, storeId);
    expect((await orderRows(storeId)).find((o) => o.external_id === '6005')).toMatchObject({
      customer_phone: null,
      tracking_company: 'Delhivery',
      tracking_number: null,
      tracking_url: null,
    });
    const outcomes = await runMessages(c, storeId);
    expect(outcomes).toEqual([
      { outcome: 'skipped', reason: 'opted_out' },
      { outcome: 'skipped', reason: 'suppressed' },
      { outcome: 'skipped', reason: 'no_phone' },
      { outcome: 'skipped', reason: 'customer_erased' },
    ]);
    // A suppressed number never becomes a contact.
    expect(
      await fx.query('SELECT 1 FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2', [
        c.tenant.id,
        '+919811100002',
      ]),
    ).toEqual([]);
    expect(await sendAll(c)).toEqual([]);

    // Test orders go out once the store allows them (to try the messages on a development store).
    await optIn(owner, storeId, { testOrders: true });
    await place('6006', { phone: '+919811100006', test: true });
    await drain(c, storeId);
    expect(await runMessages(c, storeId)).toMatchObject([{ outcome: 'queued' }]);

    // An event HyFib first sees two days late is recorded, not sent.
    await fx.query(
      `UPDATE app.commerce_store_message_rules SET enabled_at = now() - interval '5 days'
        WHERE store_id = $1`,
      [storeId],
    );
    await place('6007', {
      phone: '+919811100007',
      createdAt: iso(-49 * 3_600_000),
      processedAt: iso(-49 * 3_600_000),
    });
    await drain(c, storeId);
    expect((await messageRows(storeId)).find((r) => r.external_id === '6007')).toMatchObject({
      state: 'skipped',
      skip_reason: 'too_late',
    });
  });

  it('waits for the sending hours, and stops messages whose rule, template or number changed', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { shop, storeId } = await shopifyStoreForMessages(c, owner);
    const template = await approvedTemplate(c, owner, orderUpdate);
    // Sending hours that begin in an hour (company time, Asia/Kolkata by default).
    const kolkata = new Date(Date.now() + 5.5 * 3_600_000);
    const minute = kolkata.getUTCHours() * 60 + kolkata.getUTCMinutes();
    const hhmm = (m: number) =>
      `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    await optIn(owner, storeId, { windowStart: hhmm(minute + 60), windowEnd: hhmm(minute + 180) });
    const vars = update({ source: 'static', value: 'we received it' });
    await saveRule(owner, c, storeId, 'order_placed', { templateId: template.id, variables: vars });
    shopify.upsertOrder(shop, { id: '7001', phone: '+919822200001' });
    await orderSignal(shop, '7001', 'orders/create');
    await drain(c, storeId);
    const [waiting] = await messageRows(storeId);
    const opens = new Date(String(waiting?.send_at));
    expect(opens.getTime() - Date.now()).toBeGreaterThan(55 * 60_000);
    expect(opens.getTime() - Date.now()).toBeLessThan(62 * 60_000);
    expect(await runMessages(c, storeId)).toEqual([{ outcome: 'not_due' }]);
    const atOpening: Clock = { now: () => new Date(opens.getTime() + 1_000) };
    expect(await runMessages(c, storeId, atOpening)).toMatchObject([{ outcome: 'queued' }]);
    // The minute sweep finds due messages only.
    await optIn(owner, storeId);
    shopify.upsertOrder(shop, { id: '7002', phone: '+919822200002' });
    await orderSignal(shop, '7002', 'orders/create');
    await drain(c, storeId);
    const due = await findDueStoreMessages(fx.dbs.app, 1000);
    const pending = (await messageRows(storeId)).find((r) => r.external_id === '7002');
    expect(due.map((d) => d.storeMessageId)).toContain(pending?.id);
    expect(due.find((d) => d.storeMessageId === pending?.id)?.tenantId).toBe(c.tenant.id);

    // Switched off before the send.
    await saveRule(owner, c, storeId, 'order_placed', {
      templateId: template.id,
      variables: vars,
      enabled: false,
    });
    expect(await runMessages(c, storeId)).toEqual([
      { outcome: 'skipped', reason: 'rule_disabled' },
    ]);
    expect(
      (await findDueStoreMessages(fx.dbs.app, 1000)).map((d) => d.storeMessageId),
    ).not.toContain(pending?.id);

    // Switched off and on again: what happened in between is not messaged afterwards.
    shopify.upsertOrder(shop, { id: '7003', phone: '+919822200003' });
    await orderSignal(shop, '7003', 'orders/create');
    await drain(c, storeId);
    expect((await messageRows(storeId)).find((r) => r.external_id === '7003')).toBeUndefined();

    // The template stops being approved, or the number stops being active, before the send.
    await saveRule(owner, c, storeId, 'order_placed', { templateId: template.id, variables: vars });
    shopify.upsertOrder(shop, {
      id: '7004',
      phone: '+919822200004',
      createdAt: iso(),
      processedAt: iso(),
    });
    await orderSignal(shop, '7004', 'orders/create');
    shopify.upsertOrder(shop, {
      id: '7005',
      phone: '+919822200005',
      createdAt: iso(),
      processedAt: iso(),
    });
    await orderSignal(shop, '7005', 'orders/create');
    await drain(c, storeId);
    const byOrder = async (externalId: string) => {
      const row = (await messageRows(storeId)).find((r) => r.external_id === externalId);
      if (!row) throw new Error(`no message for ${externalId}`);
      return processStoreMessage(messageDeps(), scopeOf(c), row.id);
    };
    await fx.query("UPDATE app.message_templates SET status = 'paused' WHERE id = $1", [
      template.id,
    ]);
    expect(await byOrder('7004')).toEqual({
      outcome: 'skipped',
      reason: 'template_unavailable',
    });
    await fx.query("UPDATE app.message_templates SET status = 'approved' WHERE id = $1", [
      template.id,
    ]);
    await fx.query("UPDATE app.channel_accounts SET status = 'needs_reconnect' WHERE id = $1", [
      c.channelAccountId,
    ]);
    expect(await byOrder('7005')).toEqual({ outcome: 'skipped', reason: 'channel_unavailable' });
    // A rule cannot be switched on with a number that is not active.
    await expectAppError(
      saveRule(owner, c, storeId, 'order_shipped', { templateId: template.id, variables: vars }),
      'validation_failed',
      /not active/,
    );
    await fx.query("UPDATE app.channel_accounts SET status = 'active' WHERE id = $1", [
      c.channelAccountId,
    ]);

    // Withdrawing the opt-in confirmation switches every message off.
    await storeMessages().saveMessageSettings(owner, {
      storeId,
      optIn: false,
      windowStart: '',
      windowEnd: '',
      testOrders: false,
    });
    expect((await storeMessages().storeMessages(owner, storeId)).rules.some((r) => r.enabled)).toBe(
      false,
    );
  });

  it('checks everything again at send time, and keeps a rule’s start when it is edited', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { shop, storeId } = await shopifyStoreForMessages(c, owner);
    const template = await approvedTemplate(c, owner, orderUpdate);
    await optIn(owner, storeId);
    const vars = update({ source: 'static', value: 'we received it' });
    // Ten minutes' delay: the messages wait, and what changes meanwhile counts.
    const rule = (input: Partial<Parameters<typeof saveRule>[4]> = {}) =>
      saveRule(owner, c, storeId, 'order_placed', {
        templateId: template.id,
        variables: vars,
        delayMinutes: 10,
        ...input,
      });
    await rule();
    // The rule has been on for an hour and these orders came a minute ago, so switching it off
    // and on again later clearly comes after them.
    await fx.query(
      `UPDATE app.commerce_store_message_rules SET enabled_at = now() - interval '1 hour'
        WHERE store_id = $1`,
      [storeId],
    );
    const place = async (id: string, at = iso()) => {
      shopify.upsertOrder(shop, {
        id,
        name: `#${id}`,
        phone: `+9198233${id}`,
        createdAt: at,
        processedAt: at,
      });
      await orderSignal(shop, id, 'orders/create');
    };
    for (const id of ['8001', '8002', '8003', '8004', '8005', '8006']) {
      await place(id, iso(-60_000));
    }
    await drain(c, storeId);
    const tenMinutes = later(9 * 60_000 + 5_000);
    const byOrder = async (externalId: string, clock: Clock = tenMinutes) => {
      const row = (await messageRows(storeId)).find((r) => r.external_id === externalId);
      if (!row) throw new Error(`no message for ${externalId}`);
      return processStoreMessage(messageDeps(clock), scopeOf(c), row.id);
    };
    expect(await byOrder('8001', systemClock)).toEqual({ outcome: 'not_due' });

    // Editing the enabled rule keeps when it was switched on: waiting messages still go.
    await rule();
    expect(await byOrder('8001')).toMatchObject({ outcome: 'queued' });
    // The order was cancelled in the store before its confirmation went out.
    shopify.upsertOrder(shop, { id: '8002', cancelledAt: iso() });
    await orderSignal(shop, '8002');
    await drain(c, storeId);
    expect(await byOrder('8002')).toEqual({ outcome: 'skipped', reason: 'order_cancelled' });
    // A variable the order has no value for, without a fallback.
    await rule({ variables: update({ source: 'order', field: 'tracking_number' }) });
    expect(await byOrder('8003')).toEqual({ outcome: 'skipped', reason: 'missing_variable' });
    await rule();
    // The template's variables changed after the message was set up.
    const [saved] = await fx.query<{ components: unknown }>(
      'SELECT components FROM app.message_templates WHERE id = $1',
      [template.id],
    );
    await fx.query('UPDATE app.message_templates SET components = $2 WHERE id = $1', [
      template.id,
      JSON.stringify([{ type: 'BODY', text: 'Only {{1}}', example: { body_text: [['x']] } }]),
    ]);
    expect(await byOrder('8004')).toEqual({ outcome: 'skipped', reason: 'template_changed' });
    await fx.query('UPDATE app.message_templates SET components = $2 WHERE id = $1', [
      template.id,
      JSON.stringify(saved?.components),
    ]);
    // Sending hours set after the message was scheduled: it waits for them.
    const local = new Date(tenMinutes.now().getTime() + 5.5 * 3_600_000);
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    const hhmm = (m: number) =>
      `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    await optIn(owner, storeId, { windowStart: hhmm(minute + 60), windowEnd: hhmm(minute + 120) });
    const moved = await byOrder('8005');
    expect(moved.outcome).toBe('rescheduled');
    const opensIn =
      moved.outcome === 'rescheduled' ? moved.sendAt.getTime() - tenMinutes.now().getTime() : 0;
    expect(opensIn).toBeGreaterThan(55 * 60_000);
    expect(opensIn).toBeLessThan(61 * 60_000);
    await optIn(owner, storeId);
    // Switched off and on again: what was waiting from before is not sent.
    await rule({ enabled: false });
    await rule();
    expect(await byOrder('8006')).toEqual({ outcome: 'skipped', reason: 'rule_disabled' });

    // The opt-in confirmation withdrawn, or the store disconnected, before the send.
    await place('8007');
    await place('8008');
    await drain(c, storeId);
    await storeMessages().saveMessageSettings(owner, {
      storeId,
      optIn: false,
      windowStart: '',
      windowEnd: '',
      testOrders: false,
    });
    const afterDelay = later(10 * 60_000 + 5_000);
    expect(await byOrder('8007', afterDelay)).toEqual({ outcome: 'skipped', reason: 'no_opt_in' });
    await fx.query("UPDATE app.commerce_stores SET state = 'uninstalled' WHERE id = $1", [storeId]);
    expect(await byOrder('8008', afterDelay)).toEqual({
      outcome: 'skipped',
      reason: 'store_disconnected',
    });
    // Each message was handled once: a second job finds nothing waiting.
    expect(await byOrder('8001')).toEqual({ outcome: 'not_pending' });
  });

  it('messages WooCommerce orders on completion and cancellation, and reads cash on delivery by gateway', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const site = `msg-${Date.now().toString(36)}`;
    woo.addSite(site);
    const keys = woo.addKeys(site);
    woo.upsertOrder(site, {
      id: 60,
      status: 'processing',
      total: '10.00',
      billing: { first_name: 'Old', last_name: '', email: '', phone: '+919833300060' },
    });
    const { storeId } = await service().saveWooKeys(owner, { url: woo.siteUrl(site), ...keys });
    await drain(c, storeId);
    const template = await approvedTemplate(c, owner, orderUpdate);
    const cod = await approvedTemplate(c, owner, codConfirm);
    await optIn(owner, storeId);
    const vars = (text: string) => update({ source: 'static', value: text });
    // WooCommerce has no delivered status (WC-022).
    await expectAppError(
      saveRule(owner, c, storeId, 'order_delivered', {
        templateId: template.id,
        variables: vars('x'),
      }),
      'validation_failed',
      /not available/,
    );
    await saveRule(owner, c, storeId, 'order_shipped', {
      templateId: template.id,
      variables: vars('it is on its way'),
    });
    await saveRule(owner, c, storeId, 'order_cancelled', {
      templateId: template.id,
      variables: vars('it was cancelled'),
    });
    await saveRule(owner, c, storeId, 'cod_confirmation', {
      templateId: cod.id,
      variables: {
        header: [],
        body: [
          { source: 'order', field: 'order_name' },
          { source: 'order', field: 'order_total' },
        ],
      },
      confirmButton: 0,
      cancelButton: 1,
    });

    woo.upsertOrder(site, {
      id: 61,
      status: 'processing',
      total: '850.00',
      payment_method: 'cod',
      payment_method_title: 'Pay when it arrives',
      billing: { first_name: 'Ravi', last_name: 'S', email: '', phone: '+919833300061' },
    });
    expect((await woo.deliver(site, 'order.created', 61))[0]?.status).toBe(200);
    await drain(c, storeId);
    woo.upsertOrder(site, {
      id: 61,
      status: 'completed',
      date_completed_gmt: new Date().toISOString().replace(/\.\d{3}Z$/, ''),
    });
    await woo.deliver(site, 'order.updated', 61);
    await drain(c, storeId);
    woo.upsertOrder(site, { id: 60, status: 'cancelled' });
    await woo.deliver(site, 'order.updated', 60);
    await drain(c, storeId);
    expect((await messageRows(storeId)).map((r) => [r.external_id, r.event, r.state])).toEqual([
      ['61', 'cod_confirmation', 'pending'],
      ['61', 'order_shipped', 'pending'],
      ['60', 'order_cancelled', 'pending'],
    ]);
    expect(await runMessages(c, storeId)).toMatchObject([
      { outcome: 'queued' },
      { outcome: 'queued' },
      { outcome: 'queued' },
    ]);
    expect(await sendAll(c)).toEqual(['accepted', 'accepted', 'accepted']);
    expect(bodyTexts(templatesTo('919833300061')[0])).toEqual(['#61', '₹850.00']);
    expect(bodyTexts(templatesTo('919833300060')[0])).toEqual(['Old', '#60', 'it was cancelled']);

    // Completed, back to processing, completed again: still one shipped message.
    woo.upsertOrder(site, { id: 61, status: 'processing', date_completed_gmt: null });
    await woo.deliver(site, 'order.updated', 61);
    await drain(c, storeId);
    woo.upsertOrder(site, {
      id: 61,
      status: 'completed',
      date_completed_gmt: new Date().toISOString().replace(/\.\d{3}Z$/, ''),
    });
    await woo.deliver(site, 'order.updated', 61);
    await drain(c, storeId);
    expect(
      (await messageRows(storeId)).filter((r) => r.event === 'order_shipped').map((r) => r.state),
    ).toEqual(['queued']);
  });

  it('lets managers change order messages, others only read them, and keeps companies apart', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { storeId } = await shopifyStoreForMessages(c, owner);
    const template = await approvedTemplate(c, owner, orderUpdate);
    await optIn(owner, storeId);
    const vars = update({ source: 'static', value: 'x' });
    const agent = await fx.ctx(c, c.agent);
    const marketer = await fx.ctx(c, c.marketer);
    expect((await storeMessages().storeMessages(agent, storeId)).canManage).toBe(false);
    await expectAppError(
      saveRule(agent, c, storeId, 'order_placed', { templateId: template.id, variables: vars }),
      'forbidden',
    );
    await expectAppError(
      storeMessages().saveMessageSettings(marketer, {
        storeId,
        optIn: false,
        windowStart: '',
        windowEnd: '',
        testOrders: false,
      }),
      'forbidden',
    );
    // Every variable must be filled, and a stale form is refused.
    await expectAppError(
      saveRule(owner, c, storeId, 'order_placed', {
        templateId: template.id,
        variables: { header: [], body: [{ source: 'order', field: 'order_name' }] },
      }),
      'validation_failed',
      /every template variable/,
    );
    await saveRule(owner, c, storeId, 'order_placed', { templateId: template.id, variables: vars });
    await expectAppError(
      storeMessages().saveMessageRule(owner, {
        storeId,
        event: 'order_placed',
        enabled: false,
        channelAccountId: c.channelAccountId,
        templateId: template.id,
        variables: vars,
        delayMinutes: 0,
        confirmButton: null,
        cancelButton: null,
        version: 0,
      }),
      'conflict',
    );
    // Half a sending window is refused.
    await expectAppError(
      optIn(owner, storeId, { windowStart: '09:00' }),
      'validation_failed',
      /both times/,
    );
    const audit = await fx.query<{ action: string }>(
      `SELECT action FROM app.audit_events WHERE tenant_id = $1 AND action LIKE 'commerce.store_message%'
        ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'commerce.store_message_settings_saved',
      'commerce.store_message_rule_saved',
    ]);

    const other = await fx.company();
    const otherOwner = await fx.ctx(other, other.owner);
    await expectAppError(storeMessages().storeMessages(otherOwner, storeId), 'not_found');
    await expectAppError(
      storeMessages().saveMessageSettings(otherOwner, {
        storeId,
        optIn: true,
        windowStart: '',
        windowEnd: '',
        testOrders: false,
      }),
      'not_found',
    );
    await expectAppError(
      saveRule(otherOwner, other, storeId, 'order_placed', {
        templateId: template.id,
        variables: vars,
      }),
      'not_found',
    );
  });
});
