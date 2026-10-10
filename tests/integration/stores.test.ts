import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7, type Clock } from '@w360/core';
import { createEgressClient, DEFAULT_EGRESS_POLICY } from '@w360/core/egress';
import { authorizedTenantScope } from '@w360/db';
import {
  advanceAutomationRun,
  applyAutomationRetention,
  botButtonId,
  codPayload,
  createAutomationService,
  createConsentService,
  createContactsService,
  createInboxService,
  createPlanAdminService,
  createSegmentsService,
  createStoreMessagesService,
  createStoreService,
  createTemplatesService,
  createWebhooksService,
  findDueStoreMessages,
  findDueStoreWork,
  handleShopifyWebhook,
  handleWooWebhook,
  processSendIntent,
  processStoreJob,
  processStoreMessage,
  processTemplateSubmit,
  processWebhookDeliveries,
  dayOf,
  saveStoreOrders,
  saveStoreProducts,
  STORE_LIMITS,
  storeOrderCodAnsweredPayloadSchema,
  storeOrderMessageSentPayloadSchema,
  storeOrderMessageSkippedPayloadSchema,
  storeCheckoutReminderSentPayloadSchema,
  storeCheckoutReminderSkippedPayloadSchema,
  syncTemplates,
  WebhookOAuthTokenCache,
  type StoreMessageEvent,
  type WebhookOrderMessageEvent,
  type WebhookOrderMessageSkipReason,
  type StoreVariables,
  type AutomationTrigger,
  type Permission,
  type PlatformActor,
  type StoreWorkerDeps,
  type TemplateDefinition,
  type TenantContext,
} from '@w360/domain';
import {
  startShopifyStandIn,
  type ShopifyStandIn,
  type StandInCheckout,
} from '../support/shopify-stand-in';
import { startWooStandIn, type WooStandIn } from '../support/woocommerce-stand-in';
import { acceptInvitation, createUser, failOnLog, invite, type TestUser } from './helpers';
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
/** What the company's own webhook endpoints received (ADR-348), by path, in the order it came. */
const hookBodies: { path: string; body: string }[] = [];

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
      } else if (url.pathname.startsWith('/hooks/')) {
        hookBodies.push({ path: url.pathname, body: body.toString('utf8') });
        status = 204;
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

/** A name for the company's webhook receiver, which deliveries resolve to this test's server. */
const HOOK_HOST = 'hooks.receiver.test';

/**
 * A webhook endpoint of the company taking `eventTypes`, only those of the numbers (ADR-348),
 * answers and stores (ADR-349), order messages (ADR-352) and skip reasons (ADR-354) given, on a path
 * of this test's server of its own.
 */
async function addHook(
  owner: TenantContext,
  eventTypes: (
    | 'store_order.cod_answered'
    | 'store_order.message_skipped'
    | 'store_order.message_sent'
    | 'store_checkout.reminder_skipped'
    | 'store_checkout.reminder_sent'
  )[],
  filters: {
    channelIds?: string[];
    codAnswers?: ('confirmed' | 'cancelled')[];
    storeIds?: string[];
    orderMessageEvents?: WebhookOrderMessageEvent[];
    orderMessageSkipReasons?: WebhookOrderMessageSkipReason[];
  } = {},
) {
  const path = `/hooks/${randomBytes(6).toString('hex')}`;
  const created = await createWebhooksService({
    db: fx.dbs.app,
    clock: systemClock,
    keyring: fx.keyring,
    egressPolicy: { allowLoopbackForTests: true },
  }).create(owner, {
    url: `http://${HOOK_HOST}:${new URL(appBase).port}${path}`,
    eventTypes,
    ...filters,
  });
  return { ...created, path };
}

/** Another store of the company, written directly: an endpoint can name it and hear nothing. */
async function anotherStore(c: Company) {
  const [row] = await fx.query<{ id: string }>(
    `INSERT INTO app.commerce_stores (id, tenant_id, platform, store_url, name, webhook_public_id,
       webhook_secret_ciphertext, created_by_membership_id)
     VALUES (gen_random_uuid(), $1, 'woocommerce', 'https://spices.example.test', 'Tara Spices',
             $2, 'x', $3)
     RETURNING id`,
    [
      c.tenant.id,
      Array.from(randomBytes(16), (b) => 'abcdefghijklmnopqrstuvwxyz234567'[b % 32]).join(''),
      c.tenant.ownerMembershipId,
    ],
  );
  if (!row) throw new Error('no store');
  return row;
}

/** Delivers the company's due webhooks through the egress client, the receiver's name local. */
async function deliverHooks(c: Company) {
  const jobs = fx.jobs();
  await processWebhookDeliveries(
    {
      db: fx.dbs.app,
      clock: systemClock,
      keyring: fx.keyring,
      egress: createEgressClient(
        { ...DEFAULT_EGRESS_POLICY, allowLoopbackForTests: true, timeoutMs: 2_000 },
        { resolve: async () => [{ address: '127.0.0.1', family: 4 }] },
      ),
      timeoutMs: 2_000,
      jobs,
      signer: fx.signer,
      notices: {
        outbox: { keyring: fx.keyring, jobs, signer: fx.signer },
        appBaseUrl: 'https://app.w360.test',
      },
      logger: failOnLog,
      oauthTokens: new WebhookOAuthTokenCache(),
    },
    scopeOf(c),
  );
}

/** The bodies the receiver got on a path, parsed, in the order they arrived. */
const hookBodiesAt = (path: string) =>
  hookBodies.filter((r) => r.path === path).map((r) => JSON.parse(r.body) as unknown);
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

    // A redaction naming an email that holds the NUL character finds nothing more to redact, as
    // for any unknown email (ADR-130); its lookup failed in the database before (22021).
    expect(
      await shopify.deliverCompliance('customers/redact', {
        shop_id: 1,
        shop_domain: shop,
        customer: { id: 3, email: 'nul\u0000@example.com' },
        orders_to_redact: [],
      }),
    ).toBe(200);

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

const storeMessages = (clock: Clock = systemClock, shopifyApiVersion = '2026-07') =>
  createStoreMessagesService({ db: fx.dbs.app, clock, shopifyApiVersion });
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
  buttons: [],
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
  it('fills the end of a tracking link from the shipment (ADR-229)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { shop, storeId } = await shopifyStoreForMessages(c, owner);
    await optIn(owner, storeId);
    const template = await approvedTemplate(c, owner, {
      category: 'UTILITY',
      header: { type: 'none' },
      body: { text: 'Hi {{1}}, order {{2}} has shipped.', examples: ['Asha', '#1001'] },
      footer: null,
      buttons: [
        {
          type: 'URL',
          text: 'Track parcel',
          url: 'https://tara.example/track/{{1}}',
          example: 'AWB1',
        },
      ],
    });
    const vars: StoreVariables = {
      header: [],
      body: [
        { source: 'order', field: 'customer_name', fallback: 'there' },
        { source: 'order', field: 'order_name' },
      ],
      buttons: [{ source: 'order', field: 'tracking_number' }],
    };
    // Without the link's end, or with fixed text a link cannot end with, the rule is refused.
    await expectAppError(
      saveRule(owner, c, storeId, 'order_shipped', {
        templateId: template.id,
        variables: { ...vars, buttons: [] },
      }),
      'validation_failed',
      /every template variable/,
    );
    await expectAppError(
      saveRule(owner, c, storeId, 'order_shipped', {
        templateId: template.id,
        variables: { ...vars, buttons: [{ source: 'static', value: 'two words' }] },
      }),
      'validation_failed',
      /Track parcel: The end of a link cannot contain spaces/,
    );
    await saveRule(owner, c, storeId, 'order_shipped', {
      templateId: template.id,
      variables: vars,
    });

    shopify.upsertOrder(shop, {
      id: '7101',
      name: '#2001',
      phone: '+919812372101',
      shippingAddress: { name: 'Asha K', phone: null },
    });
    await orderSignal(shop, '7101', 'orders/create');
    await drain(c, storeId);
    shopify.upsertOrder(shop, {
      id: '7101',
      displayFulfillmentStatus: 'FULFILLED',
      fulfillments: [
        {
          status: 'SUCCESS',
          displayStatus: 'IN_TRANSIT',
          createdAt: iso(),
          updatedAt: iso(),
          deliveredAt: null,
          trackingInfo: [
            { company: 'Delhivery', number: 'AWB777', url: 'https://track.example/AWB777' },
          ],
        },
      ],
    });
    await orderSignal(shop, '7101');
    await drain(c, storeId);
    expect(await runMessages(c, storeId)).toMatchObject([{ outcome: 'queued' }]);
    expect(await sendAll(c)).toEqual(['accepted']);
    expect(templatesTo('919812372101')[0]?.components).toContainEqual({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: 'AWB777' }],
    });
  });

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
    // The order system learns of each message that goes out (ADR-353): every one, the shipments
    // only, this store's from this number, and another store's or another number's only, which hear
    // nothing.
    const outlet = await fx.addNumber(c, { phone: '+91 90000 54330' });
    const otherStore = await anotherStore(c);
    const sends = await addHook(owner, ['store_order.message_sent']);
    const shipments = await addHook(owner, ['store_order.message_sent'], {
      orderMessageEvents: ['order_shipped'],
    });
    const thisStoreHere = await addHook(owner, ['store_order.message_sent'], {
      storeIds: [storeId],
      channelIds: [c.channelAccountId],
    });
    const thatStore = await addHook(owner, ['store_order.message_sent'], {
      storeIds: [otherStore.id],
    });
    const otherNumber = await addHook(owner, ['store_order.message_sent'], {
      channelIds: [outlet.channelAccountId],
    });

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

    // Each message that went out was captured once, as it was handed to the send queue, with its
    // event, its chat message, the conversation, the customer's contact and when the order's event
    // happened; the number and the store travel for the filters only (ADR-353).
    const sentRows = await messageRows(storeId);
    const sentEvents = await fx.query<{
      id: string;
      status: string;
      message_id: string | null;
      conversation_id: string | null;
      contact_id: string | null;
      detail: Record<string, unknown>;
      deliveries: number;
    }>(
      `SELECT e.id, e.status, e.message_id, e.conversation_id, e.contact_id, e.detail,
              (SELECT count(*)::int FROM app.webhook_deliveries d
                WHERE d.tenant_id = e.tenant_id AND d.event_id = e.id) AS deliveries
         FROM app.webhook_events e
        WHERE e.tenant_id = $1 AND e.type = 'store_order.message_sent'
        ORDER BY e.occurred_at, e.id`,
      [c.tenant.id],
    );
    const [thread] = await fx.query<{ conversation_id: string }>(
      'SELECT conversation_id FROM app.messages WHERE id = $1',
      [placedRow?.message_id],
    );
    const rowOf = (e: (typeof sentEvents)[number]) => {
      const row = sentRows.find((r) => r.id === e.detail.storeMessageId);
      if (!row) throw new Error('an event of no message');
      return row;
    };
    expect(
      sentEvents.map((e) => [
        rowOf(e).event,
        e.status,
        e.message_id,
        e.conversation_id,
        e.contact_id,
        e.detail,
        e.deliveries,
      ]),
    ).toEqual(
      sentRows.map((row) => [
        row.event,
        row.event,
        row.message_id,
        thread?.conversation_id,
        row.contact_id,
        { storeMessageId: row.id, automationRunId: null, occurredAt: expect.any(String) },
        row.event === 'order_shipped' ? 3 : 2,
      ]),
    );
    for (const e of sentEvents) {
      expect(new Date(String(e.detail.occurredAt)).getTime()).toBe(
        (rowOf(e).occurred_at as Date).getTime(),
      );
    }

    // Built when delivered: the message as captured; the order, the store, the contact and the
    // number as they are now.
    await deliverHooks(c);
    const [orderNow] = (await orderRows(storeId)).filter((o) => o.external_id === '5001');
    const [storeNow] = await fx.query<{ name: string | null; store_url: string }>(
      'SELECT name, store_url FROM app.commerce_stores WHERE id = $1',
      [storeId],
    );
    const [number] = await fx.query<{ display_phone_number: string | null }>(
      'SELECT display_phone_number FROM app.channel_accounts WHERE id = $1',
      [c.channelAccountId],
    );
    const sentBodies = hookBodiesAt(sends.path);
    expect(sentBodies).toHaveLength(4);
    for (const body of sentBodies) {
      expect(storeOrderMessageSentPayloadSchema.safeParse(body).success).toBe(true);
    }
    expect(sentBodies).toEqual(
      expect.arrayContaining(
        sentEvents.map((e) => {
          const row = rowOf(e);
          return expect.objectContaining({
            id: e.id,
            type: 'store_order.message_sent',
            data: {
              orderMessage: {
                event: row.event,
                occurredAt: (row.occurred_at as Date).toISOString(),
                messageId: row.message_id,
                automationRunId: null,
              },
              storeOrder: expect.objectContaining({
                id: orderNow?.id,
                externalId: '5001',
                name: '#1001',
                cancelledAt: (orderNow?.cancelled_at as Date).toISOString(),
              }),
              store: {
                id: storeId,
                platform: 'shopify',
                name: storeNow?.name,
                url: storeNow?.store_url,
              },
              conversation: { id: thread?.conversation_id },
              contact: { id: row.contact_id, phone: '+919812345678', name: 'Asha K' },
              channel: { id: c.channelAccountId, phone: number?.display_phone_number },
            },
          });
        }),
      ),
    );
    expect(hookBodiesAt(shipments.path)).toEqual([
      expect.objectContaining({
        id: sentEvents.find((e) => e.status === 'order_shipped')?.id,
        type: 'store_order.message_sent',
      }),
    ]);
    expect(hookBodiesAt(thisStoreHere.path)).toHaveLength(4);
    expect(hookBodiesAt(thatStore.path)).toEqual([]);
    expect(hookBodiesAt(otherNumber.path)).toEqual([]);
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
      buttons: [],
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
    // The company's order system takes the answers (ADR-348): on every number, on the number the
    // message went from, and on another number only, which hears nothing.
    const [sentFrom] = await fx.query<{ channel_account_id: string }>(
      'SELECT channel_account_id FROM app.messages WHERE id = $1',
      [codRow.message_id],
    );
    if (!sentFrom) throw new Error('no number');
    const outlet = await fx.addNumber(c, { phone: '+91 90000 54329' });
    const everyNumber = await addHook(owner, ['store_order.cod_answered']);
    const itsNumber = await addHook(owner, ['store_order.cod_answered'], {
      channelIds: [sentFrom.channel_account_id],
    });
    const otherNumber = await addHook(owner, ['store_order.cod_answered'], {
      channelIds: [outlet.channelAccountId],
    });
    // And by answer and store (ADR-349): the cancellations only, this store's answers, another
    // store's only, which hears nothing, and the confirmations from the message's number and either
    // store, which must pass all three lists.
    const otherStore = await anotherStore(c);
    const cancellations = await addHook(owner, ['store_order.cod_answered'], {
      codAnswers: ['cancelled'],
    });
    const thisStore = await addHook(owner, ['store_order.cod_answered'], { storeIds: [storeId] });
    const thatStore = await addHook(owner, ['store_order.cod_answered'], {
      storeIds: [otherStore.id],
    });
    const confirmationsHere = await addHook(owner, ['store_order.cod_answered'], {
      channelIds: [sentFrom.channel_account_id],
      codAnswers: ['confirmed'],
      storeIds: [otherStore.id, storeId],
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
    // A tap repeating the answer kept moves its time only (and sends no event, ADR-348).
    await tap('confirm', { at: now + 7 });
    expect(await answered()).toEqual({
      answer: 'confirmed',
      answered_at: new Date((now + 7) * 1000),
    });
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

    // The two taps that changed the answer, in the order they came: the cancellation at `now`, the
    // confirmation five seconds later, as WhatsApp dated them.
    const taps = (
      await fx.query<{ id: string }>(
        `SELECT id FROM app.messages WHERE conversation_id = $1 AND direction = 'inbound'
          ORDER BY created_at, id LIMIT 2`,
        [out.conversation_id],
      )
    ).map((t, i) => ({ id: t.id, answered: new Date((now + i * 5) * 1000) }));
    // One event per change of the answer kept (ADR-348): the first, cancelled, then confirmed. The
    // repeated confirmation, the late older tap, another customer's and a reply to another message
    // sent nothing. Each reaches the endpoints on every number and on its own, not the other
    // number's, and this store's but not the other store's (ADR-349); the cancellation reaches the
    // cancellations' and the confirmation the confirmations'.
    const events = await fx.query<{
      id: string;
      status: string;
      detail: Record<string, unknown>;
      conversation_id: string;
      contact_id: string;
      occurred_at: Date;
      deliveries: number;
    }>(
      `SELECT e.id, e.status, e.detail, e.conversation_id, e.contact_id, e.occurred_at,
              (SELECT count(*)::int FROM app.webhook_deliveries d
                WHERE d.tenant_id = e.tenant_id AND d.event_id = e.id) AS deliveries
         FROM app.webhook_events e
        WHERE e.tenant_id = $1 AND e.type = 'store_order.cod_answered'
        ORDER BY e.occurred_at, e.id`,
      [c.tenant.id],
    );
    const [contactRow] = await fx.query<{ id: string }>(
      'SELECT contact_id AS id FROM app.conversations WHERE id = $1',
      [out.conversation_id],
    );
    if (!contactRow) throw new Error('no conversation');
    expect(
      events.map((e) => [e.status, e.detail, e.conversation_id, e.contact_id, e.deliveries]),
    ).toEqual([
      [
        'cancelled',
        {
          storeMessageId: codRow.id,
          previousAnswer: null,
          answeredAt: expect.any(String),
          answerMessageId: taps[0]!.id,
        },
        out.conversation_id,
        contactRow.id,
        4,
      ],
      [
        'confirmed',
        {
          storeMessageId: codRow.id,
          previousAnswer: 'cancelled',
          answeredAt: expect.any(String),
          answerMessageId: taps[1]!.id,
        },
        out.conversation_id,
        contactRow.id,
        4,
      ],
    ]);
    // The tap's time as WhatsApp dated it, whole seconds.
    expect(events.map((e) => new Date(String(e.detail.answeredAt)).getTime())).toEqual(
      taps.map((t) => t.answered.getTime()),
    );

    // Built when delivered: the answers as captured (the repeated tap moved the kept answer's time
    // and message since, not the event's), the order and the store as they are now, the
    // conversation's contact and the number.
    await deliverHooks(c);
    const [store] = await fx.query<{ name: string | null; store_url: string }>(
      'SELECT name, store_url FROM app.commerce_stores WHERE id = $1',
      [storeId],
    );
    const [orderNow] = await fx.query<{ id: string; placed_at: Date }>(
      'SELECT id, placed_at FROM app.commerce_store_orders WHERE id = $1',
      [codRow.order_id],
    );
    const [people] = await fx.query<{ name: string | null; number: string | null }>(
      `SELECT ct.display_name AS name, ch.display_phone_number AS number
         FROM app.contacts ct, app.channel_accounts ch WHERE ct.id = $1 AND ch.id = $2`,
      [contactRow.id, sentFrom.channel_account_id],
    );
    for (const hook of [everyNumber, itsNumber, thisStore]) {
      const bodies = hookBodiesAt(hook.path);
      expect(bodies).toHaveLength(2);
      for (const body of bodies) {
        expect(storeOrderCodAnsweredPayloadSchema.safeParse(body).success).toBe(true);
      }
      expect(bodies).toEqual(
        expect.arrayContaining(
          events.map((e, i) =>
            expect.objectContaining({
              id: e.id,
              type: 'store_order.cod_answered',
              data: {
                confirmation: {
                  answer: e.status,
                  previousAnswer: i === 0 ? null : 'cancelled',
                  answeredAt: taps[i]!.answered.toISOString(),
                  messageId: codRow.message_id,
                  answerMessageId: taps[i]!.id,
                },
                storeOrder: {
                  id: orderNow!.id,
                  externalId: '5101',
                  name: '#2001',
                  status: 'open',
                  financialStatus: 'pending',
                  fulfillmentStatus: 'unfulfilled',
                  test: false,
                  currency: 'INR',
                  totalMinor: 149_900,
                  placedAt: orderNow!.placed_at.toISOString(),
                  cancelledAt: null,
                  deletedAt: null,
                },
                store: {
                  id: storeId,
                  platform: 'shopify',
                  name: store!.name,
                  url: store!.store_url,
                },
                conversation: { id: out.conversation_id },
                contact: { id: contactRow.id, phone: '+919812399999', name: people!.name },
                channel: { id: sentFrom.channel_account_id, phone: people!.number },
              },
            }),
          ),
        ),
      );
    }
    expect(hookBodiesAt(otherNumber.path)).toEqual([]);
    expect(hookBodiesAt(thatStore.path)).toEqual([]);
    expect(hookBodiesAt(cancellations.path)).toEqual([
      expect.objectContaining({ id: events[0]!.id, type: 'store_order.cod_answered' }),
    ]);
    expect(hookBodiesAt(confirmationsHere.path)).toEqual([
      expect.objectContaining({ id: events[1]!.id, type: 'store_order.cod_answered' }),
    ]);

    // Skipped order messages (ADR-351): an order paid on delivery records its order placed message
    // skipped, the confirmation replacing it, and a confirmation without a number HyFib can message
    // is skipped when due; each sends its event once. The answers' endpoints are done with: a
    // company keeps at most 10 endpoints.
    const hooks = createWebhooksService({
      db: fx.dbs.app,
      clock: systemClock,
      keyring: fx.keyring,
      egressPolicy: { allowLoopbackForTests: true },
    });
    for (const hook of [
      everyNumber,
      itsNumber,
      otherNumber,
      cancellations,
      thisStore,
      thatStore,
      confirmationsHere,
    ]) {
      await hooks.remove(owner, { endpointId: hook.id });
    }
    const skips = await addHook(owner, ['store_order.message_skipped']);
    // And by order message and store (ADR-352): the confirmations' skips only, this store's, the
    // other store's only, which hears nothing, and both messages of either store.
    const confirmationSkips = await addHook(owner, ['store_order.message_skipped'], {
      orderMessageEvents: ['cod_confirmation'],
    });
    const thisStoreSkips = await addHook(owner, ['store_order.message_skipped'], {
      storeIds: [storeId],
    });
    const thatStoreSkips = await addHook(owner, ['store_order.message_skipped'], {
      storeIds: [otherStore.id],
    });
    const eitherStoreSkips = await addHook(owner, ['store_order.message_skipped'], {
      orderMessageEvents: ['order_placed', 'cod_confirmation'],
      storeIds: [otherStore.id, storeId],
    });
    shopify.upsertOrder(shop, {
      id: '5102',
      name: '#2002',
      phone: null,
      shippingAddress: null,
      paymentGatewayNames: ['Cash on Delivery (COD)'],
      displayFinancialStatus: 'PENDING',
      total: { amount: '899.00', currencyCode: 'INR' },
    });
    await orderSignal(shop, '5102', 'orders/create');
    await drain(c, storeId);
    const unreachable = (await messageRows(storeId)).filter((r) => r.external_id === '5102');
    expect(unreachable.map((r) => [r.event, r.state, r.skip_reason])).toEqual([
      ['cod_confirmation', 'pending', null],
      ['order_placed', 'skipped', 'cash_on_delivery'],
    ]);
    const [unconfirmable, replaced] = unreachable;
    expect(await processStoreMessage(messageDeps(), scopeOf(c), unconfirmable!.id)).toEqual({
      outcome: 'skipped',
      reason: 'no_phone',
    });
    // No code skips a skipped message again; a write that does (here directly) captures nothing.
    await fx.query(
      `UPDATE app.commerce_store_messages SET state = 'skipped', skip_reason = 'rule_disabled'
        WHERE id = $1`,
      [replaced!.id],
    );
    const skippedEvents = await fx.query<{
      id: string;
      status: string;
      detail: Record<string, unknown>;
      deliveries: number;
    }>(
      `SELECT e.id, e.status, e.detail,
              (SELECT count(*)::int FROM app.webhook_deliveries d
                WHERE d.tenant_id = e.tenant_id AND d.event_id = e.id) AS deliveries
         FROM app.webhook_events e
        WHERE e.tenant_id = $1 AND e.type = 'store_order.message_skipped'
        ORDER BY e.occurred_at, e.id`,
      [c.tenant.id],
    );
    // The store travels for the filter only: the event keeps the message, its reason and time.
    expect(skippedEvents.map((e) => [e.status, e.detail, e.deliveries])).toEqual([
      [
        'order_placed',
        {
          storeMessageId: replaced!.id,
          skipReason: 'cash_on_delivery',
          occurredAt: expect.any(String),
        },
        3,
      ],
      [
        'cod_confirmation',
        {
          storeMessageId: unconfirmable!.id,
          skipReason: 'no_phone',
          occurredAt: expect.any(String),
        },
        4,
      ],
    ]);
    await deliverHooks(c);
    const skipBodies = hookBodiesAt(skips.path);
    expect(skipBodies).toHaveLength(2);
    expect(skipBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: skippedEvents[0]!.id,
          data: expect.objectContaining({
            orderMessage: expect.objectContaining({
              event: 'order_placed',
              skipReason: 'cash_on_delivery',
            }),
            storeOrder: expect.objectContaining({ externalId: '5102', name: '#2002' }),
          }),
        }),
        expect.objectContaining({
          id: skippedEvents[1]!.id,
          data: expect.objectContaining({
            orderMessage: expect.objectContaining({
              event: 'cod_confirmation',
              skipReason: 'no_phone',
            }),
            storeOrder: expect.objectContaining({ externalId: '5102', name: '#2002' }),
          }),
        }),
      ]),
    );
    expect(hookBodiesAt(confirmationSkips.path)).toEqual([
      expect.objectContaining({ id: skippedEvents[1]!.id, type: 'store_order.message_skipped' }),
    ]);
    for (const hook of [thisStoreSkips, eitherStoreSkips]) {
      expect(hookBodiesAt(hook.path)).toHaveLength(2);
    }
    expect(hookBodiesAt(thatStoreSkips.path)).toEqual([]);
  });

  it('sends nothing about the past, and skips test orders, late events and customers who cannot be messaged', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { shop, storeId } = await shopifyStoreForMessages(c, owner);
    const template = await approvedTemplate(c, owner, orderUpdate);
    await optIn(owner, storeId);
    const vars = update({ source: 'static', value: 'we received it' });
    await saveRule(owner, c, storeId, 'order_placed', { templateId: template.id, variables: vars });
    // The order system learns of each message skipped (ADR-351), and of each sent (ADR-353); a
    // call centre of the skips of customers who opted out or have no number only, and of every
    // message sent, which has no reason (ADR-354); another of the shipments' skips for no number
    // only, which must pass both lists and hears nothing (only orders placed go out here).
    const skips = await addHook(owner, ['store_order.message_skipped']);
    const answers = await addHook(owner, ['store_order.cod_answered']);
    const sends = await addHook(owner, ['store_order.message_sent']);
    const callCentre = await addHook(
      owner,
      ['store_order.message_skipped', 'store_order.message_sent'],
      { orderMessageSkipReasons: ['opted_out', 'no_phone'] },
    );
    const shipmentsWithoutNumber = await addHook(owner, ['store_order.message_skipped'], {
      orderMessageSkipReasons: ['no_phone'],
      orderMessageEvents: ['order_shipped'],
    });

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

    // Each message skipped, recorded so or by its checks, was captured once with its event, reason
    // and when the order's event happened, for the endpoint taking the event and, for the two
    // reasons it names, the call centre's; the one sent was not.
    const skipped = new Map((await messageRows(storeId)).map((r) => [r.id, r]));
    const events = await fx.query<{
      id: string;
      status: string;
      detail: Record<string, unknown>;
      conversation_id: string | null;
      contact_id: string | null;
      deliveries: number;
    }>(
      `SELECT e.id, e.status, e.detail, e.conversation_id, e.contact_id,
              (SELECT count(*)::int FROM app.webhook_deliveries d
                WHERE d.tenant_id = e.tenant_id AND d.event_id = e.id) AS deliveries
         FROM app.webhook_events e
        WHERE e.tenant_id = $1 AND e.type = 'store_order.message_skipped'
        ORDER BY e.occurred_at, e.id`,
      [c.tenant.id],
    );
    const messageOf = (e: (typeof events)[number]) => {
      const message = skipped.get(String(e.detail.storeMessageId));
      if (!message) throw new Error('an event of no message');
      return message;
    };
    expect(
      events.map((e) => [
        messageOf(e).external_id,
        e.status,
        e.detail.skipReason,
        e.conversation_id,
        e.contact_id,
        e.deliveries,
      ]),
    ).toEqual([
      ['6001', 'order_placed', 'test_order', null, null, 1],
      ['6002', 'order_placed', 'opted_out', null, null, 2],
      ['6003', 'order_placed', 'suppressed', null, null, 1],
      ['6004', 'order_placed', 'no_phone', null, null, 2],
      ['6005', 'order_placed', 'customer_erased', null, null, 1],
      ['6007', 'order_placed', 'too_late', null, null, 1],
    ]);
    for (const e of events) {
      expect(new Date(String(e.detail.occurredAt)).getTime()).toBe(
        (messageOf(e).occurred_at as Date).getTime(),
      );
    }

    // Built when delivered: the message as captured, the order and the store as they are now. A
    // message gone with its order by then can no longer be described.
    const lateOrder = messageOf(events[5]!).order_id as string;
    await fx.query('DELETE FROM app.commerce_store_orders WHERE id = $1', [lateOrder]);
    await deliverHooks(c);
    const [storeNow] = await fx.query<{ name: string | null; store_url: string }>(
      'SELECT name, store_url FROM app.commerce_stores WHERE id = $1',
      [storeId],
    );
    const orders = new Map((await orderRows(storeId)).map((o) => [String(o.id), o]));
    const bodies = hookBodiesAt(skips.path);
    expect(bodies).toHaveLength(5);
    for (const body of bodies) {
      expect(storeOrderMessageSkippedPayloadSchema.safeParse(body).success).toBe(true);
    }
    expect(bodies).toEqual(
      expect.arrayContaining(
        events.slice(0, 5).map((e) => {
          const message = messageOf(e);
          const order = orders.get(String(message.order_id));
          if (!order) throw new Error('an order gone');
          return expect.objectContaining({
            id: e.id,
            type: 'store_order.message_skipped',
            data: {
              orderMessage: {
                event: 'order_placed',
                skipReason: e.detail.skipReason,
                occurredAt: (message.occurred_at as Date).toISOString(),
              },
              storeOrder: expect.objectContaining({
                id: order.id,
                externalId: order.external_id,
                name: order.name,
                test: order.test,
                placedAt: (order.placed_at as Date).toISOString(),
                deletedAt: null,
              }),
              store: {
                id: storeId,
                platform: 'shopify',
                name: storeNow!.name,
                url: storeNow!.store_url,
              },
            },
          });
        }),
      ),
    );
    expect(
      await fx.query(
        'SELECT state, attempts, last_error FROM app.webhook_deliveries WHERE event_id = $1',
        [events[5]!.id],
      ),
    ).toEqual([{ state: 'failed', attempts: 0, last_error: 'event_gone' }]);
    expect(hookBodiesAt(answers.path)).toEqual([]);
    expect(hookBodiesAt(callCentre.path)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: events[1]!.id, type: 'store_order.message_skipped' }),
        expect.objectContaining({ id: events[3]!.id, type: 'store_order.message_skipped' }),
        expect.objectContaining({
          type: 'store_order.message_sent',
          data: expect.objectContaining({
            storeOrder: expect.objectContaining({ externalId: '6006' }),
          }),
        }),
      ]),
    );
    expect(hookBodiesAt(callCentre.path)).toHaveLength(3);
    expect(hookBodiesAt(shipmentsWithoutNumber.path)).toEqual([]);
    // The one message that went out, the test order's once the store allowed them, sent its own
    // event and no skipped one (ADR-353).
    expect(hookBodiesAt(sends.path)).toEqual([
      expect.objectContaining({
        type: 'store_order.message_sent',
        data: expect.objectContaining({
          orderMessage: expect.objectContaining({ event: 'order_placed', automationRunId: null }),
          storeOrder: expect.objectContaining({ externalId: '6006', test: true }),
        }),
      }),
    ]);
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
        buttons: [],
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
        variables: { header: [], body: [{ source: 'order', field: 'order_name' }], buttons: [] },
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

// Cart reminders (P4-06d) ----------------------------------------------------------------------------

const cartReminder: TemplateDefinition = {
  category: 'MARKETING',
  header: { type: 'none' },
  body: {
    text: 'Hi {{1}}, your cart is still waiting for you: {{2}}',
    examples: ['Asha', 'https://tara.example/checkouts/1/recover'],
  },
  footer: null,
  buttons: [],
};
const cartVars: StoreVariables = {
  header: [],
  body: [
    { source: 'checkout', field: 'customer_name', fallback: 'there' },
    { source: 'checkout', field: 'checkout_url' },
  ],
  buttons: [],
};
const MINUTE_MS = 60_000;

async function cartRows(storeId: string) {
  return fx.query<
    Record<string, unknown> & {
      id: string;
      event: string;
      state: string;
      skip_reason: string | null;
      external_id: string;
      occurred_at: Date;
      send_at: Date;
    }
  >(
    `SELECT sm.*, k.external_id FROM app.commerce_store_messages sm
       JOIN app.commerce_store_checkouts k ON k.id = sm.checkout_id
      WHERE sm.store_id = $1 ORDER BY k.external_id::bigint, sm.event`,
    [storeId],
  );
}

async function checkoutRows(storeId: string) {
  return fx.query<Record<string, unknown> & { external_id: string }>(
    'SELECT * FROM app.commerce_store_checkouts WHERE store_id = $1 ORDER BY external_id::bigint',
    [storeId],
  );
}

/** A checkout left in the store with one line, the number in its shipping address. */
function leave(
  shop: string,
  id: string,
  input: {
    phone?: string | null;
    name?: string;
    updatedAt?: string;
    createdAt?: string;
    completedAt?: string | null;
    customer?: StandInCheckout['customer'];
  } = {},
) {
  const updatedAt = input.updatedAt ?? iso(-MINUTE_MS);
  return shopify.upsertCheckout(shop, {
    id,
    createdAt: input.createdAt ?? updatedAt,
    updatedAt,
    completedAt: input.completedAt ?? null,
    total: { amount: '1499.00', currencyCode: 'INR' },
    lineItems: [{ title: 'Darjeeling tea', variantTitle: '250 g', quantity: 2 }],
    shippingAddress:
      input.phone === null ? null : { name: input.name ?? 'Asha K', phone: input.phone ?? null },
    customer: input.customer ?? null,
  });
}

/** A contact for the number with a member-recorded marketing opt-in. */
async function marketingOptIn(owner: TenantContext, phone: string, name = 'Asha K') {
  const contact = await createContactsService({ db: fx.dbs.app, clock: systemClock }).createContact(
    owner,
    { displayName: name, phone },
  );
  await createConsentService({ db: fx.dbs.app, clock: systemClock }).recordConsent(owner, {
    contactId: contact.id,
    purpose: 'marketing',
    action: 'opt_in',
  });
  return contact.id;
}

/** Handles the store's waiting cart reminders by checkout and reminder: [checkout, event, outcome]. */
async function runCart(c: Company, storeId: string, clock: Clock = systemClock) {
  const rows = await fx.query<{ id: string; external_id: string; event: string }>(
    `SELECT sm.id, k.external_id, sm.event FROM app.commerce_store_messages sm
       JOIN app.commerce_store_checkouts k ON k.id = sm.checkout_id
      WHERE sm.store_id = $1 AND sm.state = 'pending'
      ORDER BY k.external_id::bigint, sm.event`,
    [storeId],
  );
  const outcomes: [string, string, string][] = [];
  for (const row of rows) {
    const result = await processStoreMessage(messageDeps(clock), scopeOf(c), row.id);
    outcomes.push([
      row.external_id,
      row.event,
      result.outcome === 'skipped' ? `skipped: ${result.reason}` : result.outcome,
    ]);
  }
  return outcomes;
}

/** Makes the store's next checkout read due now and runs its jobs. */
async function readCheckouts(c: Company, storeId: string, clock: Clock = systemClock) {
  await fx.query(
    'UPDATE app.commerce_stores SET checkouts_read_at = now() WHERE id = $1 AND checkouts_read_at IS NOT NULL',
    [storeId],
  );
  return drain(c, storeId, clock);
}

async function cartRule(
  owner: TenantContext,
  c: Company,
  storeId: string,
  event: 'cart_reminder' | 'cart_second_reminder',
  input: {
    templateId: string;
    delayMinutes: number;
    enabled?: boolean;
    variables?: StoreVariables;
  },
) {
  return saveRule(owner, c, storeId, event, {
    templateId: input.templateId,
    variables: input.variables ?? cartVars,
    delayMinutes: input.delayMinutes,
    enabled: input.enabled,
  });
}

/** Walks a member through the approval for customer access (SH-042). */
async function allowCustomerAccess(owner: TenantContext, storeId: string) {
  const { url } = await service().startCustomerAccess(owner, storeId);
  const redirect = await fetch(url, { redirect: 'manual' });
  expect(redirect.status).toBe(302);
  const checked = await service().shopifyCallback(
    new URL(redirect.headers.get('location') ?? '').searchParams,
  );
  if (!checked.ok) throw new Error(`callback refused: ${checked.reason}`);
  return { url, checked };
}

describe('Cart reminders', () => {
  it('reminds a customer who left a checkout once, moves the reminder when they come back, and counts the recovery', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { shop, storeId } = await shopifyStoreForMessages(c, owner);
    const template = await approvedTemplate(c, owner, cartReminder);
    await optIn(owner, storeId);
    await marketingOptIn(owner, '+919877700001');
    await marketingOptIn(owner, '+919877700002', 'Ravi');
    await marketingOptIn(owner, '+919877700003', 'Mira');
    await marketingOptIn(owner, '+919877700004', 'Dev');
    // A checkout left before the rule was switched on is never read, let alone reminded, even one
    // left within the read's two-minute clock margin.
    leave(shop, '1', { phone: '+919877700001', updatedAt: iso(-86_400_000) });
    leave(shop, '7', { phone: '+919877700005', updatedAt: iso(-60_000) });

    // Utility templates are refused: cart reminders are marketing (M-176).
    const utility = await approvedTemplate(c, owner, orderUpdate);
    await expectAppError(
      cartRule(owner, c, storeId, 'cart_reminder', { templateId: utility.id, delayMinutes: 30 }),
      'validation_failed',
      /marketing template/,
    );
    await expectAppError(
      cartRule(owner, c, storeId, 'cart_reminder', { templateId: template.id, delayMinutes: 10 }),
      'validation_failed',
      /Wait between 30 minutes and 1 day/,
    );
    await expectAppError(
      saveRule(owner, c, storeId, 'cart_reminder', {
        templateId: template.id,
        variables: update({ source: 'static', value: 'x' }),
        delayMinutes: 30,
      }),
      'validation_failed',
      /values this message can fill/,
    );
    await cartRule(owner, c, storeId, 'cart_reminder', {
      templateId: template.id,
      delayMinutes: 30,
    });
    expect(await storeRow(storeId)).toMatchObject({
      checkouts_page: null,
      checkouts_error: null,
    });

    leave(shop, '2', { phone: '+919877700001', updatedAt: iso() });
    leave(shop, '3', { phone: '+919877700002', updatedAt: iso() });
    leave(shop, '4', { phone: '+919877700003', updatedAt: iso() });
    leave(shop, '5', { phone: '+919877700004', updatedAt: iso() });
    leave(shop, '6', { phone: null, updatedAt: iso() });
    await readCheckouts(c, storeId);
    expect((await checkoutRows(storeId)).map((k) => k.external_id)).toEqual([
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
    const first = await cartRows(storeId);
    // No number, no reminder.
    expect(first.map((r) => [r.external_id, r.event, r.state])).toEqual([
      ['2', 'cart_reminder', 'pending'],
      ['3', 'cart_reminder', 'pending'],
      ['4', 'cart_reminder', 'pending'],
      ['5', 'cart_reminder', 'pending'],
    ]);
    const due = (r: (typeof first)[number]) =>
      new Date(r.send_at).getTime() - new Date(r.occurred_at).getTime();
    expect(first.map(due)).toEqual([30, 30, 30, 30].map((m) => m * MINUTE_MS));
    expect(await storeRow(storeId)).toMatchObject({ checkouts_error: null });
    // The next read is 15 minutes away; "Read the store now" reads the checkouts at once too.
    const readAt = async () =>
      new Date((await storeRow(storeId))?.checkouts_read_at as Date).getTime();
    expect((await readAt()) - Date.now()).toBeGreaterThan(14 * MINUTE_MS);
    await service().requestStoreSync(owner, storeId);
    expect(await readAt()).toBeLessThanOrEqual(Date.now());
    await drain(c, storeId);
    expect((await readAt()) - Date.now()).toBeGreaterThan(14 * MINUTE_MS);
    expect((await checkoutRows(storeId)).map((k) => k.external_id)).toEqual([
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);

    // Not yet due.
    expect(await runCart(c, storeId)).toEqual([
      ['2', 'cart_reminder', 'not_due'],
      ['3', 'cart_reminder', 'not_due'],
      ['4', 'cart_reminder', 'not_due'],
      ['5', 'cart_reminder', 'not_due'],
    ]);
    // Ravi came back to checkout 3: its reminder counts from then.
    const moved = iso(5 * 1000);
    leave(shop, '3', { phone: '+919877700002', updatedAt: moved, createdAt: iso() });
    // Mira completed checkout 4; Dev placed an order with the same number.
    leave(shop, '4', { phone: '+919877700003', completedAt: iso(2000), updatedAt: iso(2000) });
    shopify.upsertOrder(shop, { id: '9005', phone: '+919877700004' });
    await orderSignal(shop, '9005', 'orders/create');
    // An order Asha placed a week before checkout 2 began does not stop its reminder.
    shopify.upsertOrder(shop, {
      id: '9002',
      phone: '+919877700001',
      createdAt: iso(-7 * 86_400_000),
      processedAt: iso(-7 * 86_400_000),
    });
    await orderSignal(shop, '9002', 'orders/create');
    await readCheckouts(c, storeId);
    expect((await orderRows(storeId)).map((o) => o.external_id)).toEqual(
      expect.arrayContaining(['9002', '9005']),
    );
    const three = (await cartRows(storeId)).find((r) => r.external_id === '3');
    expect(new Date(three?.occurred_at as Date).toISOString()).toBe(new Date(moved).toISOString());
    // Shopify's list can lag: an older copy of checkout 3 never replaces the newer one.
    shopify.upsertCheckout(shop, {
      id: '3',
      updatedAt: iso(-10 * MINUTE_MS),
      total: { amount: '1.00', currencyCode: 'INR' },
    });
    await fx.query(
      `UPDATE app.commerce_stores SET checkouts_cursor = now() - interval '1 hour' WHERE id = $1`,
      [storeId],
    );
    await readCheckouts(c, storeId);
    const kept = (await checkoutRows(storeId)).find((k) => k.external_id === '3');
    expect(String(kept?.total_minor)).toBe('149900');
    expect(new Date(kept?.remote_updated_at as Date).toISOString()).toBe(
      new Date(moved).toISOString(),
    );

    const afterDelay = later(31 * MINUTE_MS);
    expect(await runCart(c, storeId, afterDelay)).toEqual([
      ['2', 'cart_reminder', 'queued'],
      ['3', 'cart_reminder', 'queued'],
      ['4', 'cart_reminder', 'skipped: checkout_completed'],
      ['5', 'cart_reminder', 'skipped: order_placed'],
    ]);
    expect(await sendAll(c)).toEqual(['accepted', 'accepted']);
    const sent = templatesTo('919877700001');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe(template.name);
    expect(bodyTexts(sent[0])).toEqual(['Asha K', `https://${shop}/checkouts/2/recover?key=k2`]);
    const [chat] = await fx.query<{ sender_type: string; content: { store: unknown } }>(
      `SELECT m.sender_type, m.content FROM app.messages m
         JOIN app.commerce_store_messages sm ON sm.message_id = m.id
         JOIN app.commerce_store_checkouts k ON k.id = sm.checkout_id
        WHERE k.store_id = $1 AND k.external_id = '2'`,
      [storeId],
    );
    expect(chat).toMatchObject({ sender_type: 'system' });
    expect(chat?.content.store).toMatchObject({ event: 'cart_reminder', label: 'Cart reminder' });

    // Read again: nothing new and no second reminder. Asha coming back to the checkout after the
    // reminder was sent changes nothing about the reminder.
    const [sentTwo] = (await cartRows(storeId)).filter((r) => r.external_id === '2');
    leave(shop, '2', { phone: '+919877700001', updatedAt: iso(2000) });
    await readCheckouts(c, storeId);
    const twos = (await cartRows(storeId)).filter((r) => r.external_id === '2');
    expect(twos).toHaveLength(1);
    expect(twos[0]).toMatchObject({
      state: 'queued',
      occurred_at: sentTwo?.occurred_at,
      send_at: sentTwo?.send_at,
    });

    // Asha completes checkout 2 after the reminder: recovered, with its total. Ravi completed
    // checkout 3 a minute before his reminder went out (HyFib read it later): not counted.
    leave(shop, '2', { phone: '+919877700001', completedAt: iso(3000), updatedAt: iso(3000) });
    leave(shop, '3', { phone: '+919877700002', completedAt: iso(-60_000), updatedAt: iso(10_000) });
    await readCheckouts(c, storeId);
    const view = await storeMessages().storeMessages(owner, storeId);
    expect(view.cart).toEqual({
      sent: 2,
      recovered: 1,
      value: [{ currency: 'INR', totalMinor: 149_900 }],
    });
    expect(view.recent.find((m) => m.checkoutId !== null)).toMatchObject({
      label: 'Cart reminder',
      checkoutName: expect.stringMatching(/^#C/),
    });
    // A reminder WhatsApp reports failed is not counted as sent, nor its checkout as recovered.
    await fx.query(
      `UPDATE app.messages SET status = 'failed' WHERE id = (
         SELECT sm.message_id FROM app.commerce_store_messages sm
           JOIN app.commerce_store_checkouts k ON k.id = sm.checkout_id
          WHERE k.store_id = $1 AND k.external_id = '2')`,
      [storeId],
    );
    expect((await storeMessages().storeMessages(owner, storeId)).cart).toEqual({
      sent: 1,
      recovered: 0,
      value: [],
    });
  });

  it('sends the second reminder only after the first, to opted-in customers, within three days and the frequency cap', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { shop, storeId } = await shopifyStoreForMessages(c, owner);
    const template = await approvedTemplate(c, owner, cartReminder);
    await optIn(owner, storeId);
    await marketingOptIn(owner, '+919822200001');
    await addHook(owner, ['store_order.message_skipped', 'store_order.message_sent']);
    // The cart reminders' own events (ADR-355): every one of them, those of this store on its
    // number, those of another store, and the skipped ones whichever number an endpoint names.
    const bothReminders = [
      'store_checkout.reminder_skipped',
      'store_checkout.reminder_sent',
    ] satisfies Parameters<typeof addHook>[1];
    const outlet = await fx.addNumber(c, { phone: '+91 90000 54331' });
    const otherStore = await anotherStore(c);
    const reminders = await addHook(owner, bothReminders);
    const thisStoreHere = await addHook(owner, bothReminders, {
      storeIds: [storeId],
      channelIds: [c.channelAccountId],
    });
    const thatStore = await addHook(owner, bothReminders, { storeIds: [otherStore.id] });
    const otherNumber = await addHook(owner, bothReminders, {
      channelIds: [outlet.channelAccountId],
    });

    // The second reminder needs the first, and comes later.
    await expectAppError(
      cartRule(owner, c, storeId, 'cart_second_reminder', {
        templateId: template.id,
        delayMinutes: 120,
      }),
      'validation_failed',
      /first cart reminder on first/,
    );
    await cartRule(owner, c, storeId, 'cart_reminder', {
      templateId: template.id,
      delayMinutes: 60,
    });
    await expectAppError(
      cartRule(owner, c, storeId, 'cart_second_reminder', {
        templateId: template.id,
        delayMinutes: 60,
      }),
      'validation_failed',
      /later than the first/,
    );
    await cartRule(owner, c, storeId, 'cart_second_reminder', {
      templateId: template.id,
      delayMinutes: 180,
    });
    await expectAppError(
      cartRule(owner, c, storeId, 'cart_reminder', { templateId: template.id, delayMinutes: 240 }),
      'validation_failed',
      /before the second/,
    );

    leave(shop, '10', { phone: '+919822200001', updatedAt: iso() });
    // No marketing opt-in for this number.
    leave(shop, '11', { phone: '+919822200002', updatedAt: iso() });
    await readCheckouts(c, storeId);
    expect((await cartRows(storeId)).map((r) => [r.external_id, r.event, r.state])).toEqual([
      ['10', 'cart_reminder', 'pending'],
      ['10', 'cart_second_reminder', 'pending'],
      ['11', 'cart_reminder', 'pending'],
      ['11', 'cart_second_reminder', 'pending'],
    ]);
    const byKey = async (externalId: string, event: string) =>
      (await cartRows(storeId)).find((r) => r.external_id === externalId && r.event === event);
    const second10 = await byKey('10', 'cart_second_reminder');
    // The second reminder's time comes while the first still waits: it waits for the first.
    const early = await processStoreMessage(
      messageDeps(later(181 * MINUTE_MS)),
      scopeOf(c),
      second10?.id as string,
    );
    expect(early).toMatchObject({ outcome: 'rescheduled' });
    expect(await runCart(c, storeId, later(61 * MINUTE_MS))).toEqual([
      ['10', 'cart_reminder', 'queued'],
      ['10', 'cart_second_reminder', 'not_due'],
      ['11', 'cart_reminder', 'skipped: no_marketing_opt_in'],
      ['11', 'cart_second_reminder', 'not_due'],
    ]);
    const atSecond = later(200 * MINUTE_MS);
    expect(await runCart(c, storeId, atSecond)).toEqual([
      ['10', 'cart_second_reminder', 'queued'],
      ['11', 'cart_second_reminder', 'skipped: first_reminder_not_sent'],
    ]);
    expect(await sendAll(c)).toEqual(['accepted', 'accepted']);
    expect(templatesTo('919822200001')).toHaveLength(2);

    // The company's marketing frequency cap: one marketing message a week.
    await fx.query(
      `INSERT INTO app.messaging_settings
         (tenant_id, opt_out_keywords, marketing_opt_out_keywords, opt_in_keywords,
          marketing_cap_count, marketing_cap_days)
       VALUES ($1, ARRAY['stop'], ARRAY[]::text[], ARRAY['start'], 2, 7)
       ON CONFLICT (tenant_id) DO UPDATE SET marketing_cap_count = 2, marketing_cap_days = 7`,
      [c.tenant.id],
    );
    leave(shop, '12', { phone: '+919822200001', updatedAt: iso(1000), createdAt: iso(1000) });
    await readCheckouts(c, storeId);
    expect(await runCart(c, storeId, later(61 * MINUTE_MS))).toEqual([
      ['12', 'cart_reminder', 'skipped: frequency_capped'],
      ['12', 'cart_second_reminder', 'not_due'],
    ]);

    // Never more than three days after the checkout was left.
    await fx.query(
      `UPDATE app.commerce_store_message_rules SET enabled_at = now() - interval '5 days'
        WHERE store_id = $1`,
      [storeId],
    );
    await fx.query('UPDATE app.commerce_stores SET checkouts_cursor = $2 WHERE id = $1', [
      storeId,
      new Date(Date.now() - 4 * 86_400_000),
    ]);
    await marketingOptIn(owner, '+919822200003', 'Old');
    leave(shop, '13', { phone: '+919822200003', updatedAt: iso(-73 * 3_600_000) });
    await readCheckouts(c, storeId);
    const old = await byKey('13', 'cart_reminder');
    expect(await processStoreMessage(messageDeps(), scopeOf(c), old?.id as string)).toEqual({
      outcome: 'skipped',
      reason: 'cart_too_old',
    });

    // The template became a utility template at Meta after the rule was saved: not sent.
    await fx.query(`UPDATE app.message_templates SET category = 'UTILITY' WHERE id = $1`, [
      template.id,
    ]);
    leave(shop, '14', { phone: '+919822200003', updatedAt: iso(2000), createdAt: iso(2000) });
    await readCheckouts(c, storeId);
    const recategorised = await byKey('14', 'cart_reminder');
    expect(
      await processStoreMessage(
        messageDeps(later(61 * MINUTE_MS)),
        scopeOf(c),
        recategorised?.id as string,
      ),
    ).toEqual({ outcome: 'skipped', reason: 'not_marketing_template' });

    // Switching the first reminder off switches the second off too; checkouts stop being read.
    await cartRule(owner, c, storeId, 'cart_reminder', {
      templateId: template.id,
      delayMinutes: 60,
      enabled: false,
    });
    const view = await storeMessages().storeMessages(owner, storeId);
    expect(view.rules.filter((r) => r.event.startsWith('cart')).map((r) => r.enabled)).toEqual([
      false,
      false,
    ]);
    expect(await storeRow(storeId)).toMatchObject({ checkouts_read_at: null });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1
          AND action = 'commerce.store_message_rule_saved' ORDER BY occurred_at DESC LIMIT 1`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({
      event: 'cart_reminder',
      secondReminderSwitchedOff: true,
    });

    // Cart reminders are about checkouts, not orders: the five skipped and the two sent send no
    // order message event (ADR-351, ADR-353), but each one of its own (ADR-355).
    const reminded = await cartRows(storeId);
    expect(reminded.filter((r) => r.state === 'skipped')).toHaveLength(5);
    expect(reminded.filter((r) => r.state === 'queued')).toHaveLength(2);
    expect(
      await fx.query(
        `SELECT count(*)::int AS events FROM app.webhook_events
          WHERE tenant_id = $1
            AND type IN ('store_order.message_skipped', 'store_order.message_sent')`,
        [c.tenant.id],
      ),
    ).toEqual([{ events: 0 }]);
    // Each captured once with the reminder and when the checkout was left, a skipped one with its
    // reason and no number, a sent one with its message, conversation and contact; the store and
    // the number only steer the deliveries.
    const reminderEvents = await fx.query<{
      id: string;
      type: string;
      status: string;
      message_id: string | null;
      conversation_id: string | null;
      contact_id: string | null;
      detail: Record<string, unknown>;
      deliveries: number;
    }>(
      `SELECT e.id, e.type, e.status, e.message_id, e.conversation_id, e.contact_id, e.detail,
              (SELECT count(*)::int FROM app.webhook_deliveries d
                WHERE d.tenant_id = e.tenant_id AND d.event_id = e.id) AS deliveries
         FROM app.webhook_events e
        WHERE e.tenant_id = $1
          AND e.type IN ('store_checkout.reminder_skipped', 'store_checkout.reminder_sent')
        ORDER BY e.occurred_at, e.id`,
      [c.tenant.id],
    );
    const reminderOf = (e: (typeof reminderEvents)[number]) => {
      const row = reminded.find((r) => r.id === e.detail.storeMessageId);
      if (!row) throw new Error('an event of no reminder');
      return row;
    };
    expect(
      reminderEvents.map((e) => [
        reminderOf(e).external_id,
        e.type,
        e.status,
        e.detail.skipReason ?? null,
        e.deliveries,
      ]),
    ).toEqual([
      ['10', 'store_checkout.reminder_sent', 'cart_reminder', null, 2],
      ['11', 'store_checkout.reminder_skipped', 'cart_reminder', 'no_marketing_opt_in', 3],
      ['10', 'store_checkout.reminder_sent', 'cart_second_reminder', null, 2],
      [
        '11',
        'store_checkout.reminder_skipped',
        'cart_second_reminder',
        'first_reminder_not_sent',
        3,
      ],
      ['12', 'store_checkout.reminder_skipped', 'cart_reminder', 'frequency_capped', 3],
      ['13', 'store_checkout.reminder_skipped', 'cart_reminder', 'cart_too_old', 3],
      ['14', 'store_checkout.reminder_skipped', 'cart_reminder', 'not_marketing_template', 3],
    ]);
    for (const e of reminderEvents) {
      const row = reminderOf(e);
      expect(e.status).toBe(row.event);
      expect(new Date(String(e.detail.occurredAt)).getTime()).toBe(row.occurred_at.getTime());
      if (e.type === 'store_checkout.reminder_sent') {
        const [message] = await fx.query<{ conversation_id: string }>(
          'SELECT conversation_id FROM app.messages WHERE id = $1',
          [row.message_id],
        );
        expect([e.message_id, e.conversation_id, e.contact_id]).toEqual([
          row.message_id,
          message?.conversation_id,
          row.contact_id,
        ]);
        expect(Object.keys(e.detail).sort()).toEqual(['occurredAt', 'storeMessageId']);
      } else {
        expect([e.message_id, e.conversation_id, e.contact_id]).toEqual([null, null, null]);
        expect(Object.keys(e.detail).sort()).toEqual([
          'occurredAt',
          'skipReason',
          'storeMessageId',
        ]);
      }
    }

    // Built when delivered: the reminder as captured; the checkout, the store, the contact and the
    // number as they are now, never the customer's details from the store.
    await deliverHooks(c);
    const checkouts = new Map((await checkoutRows(storeId)).map((k) => [String(k.id), k]));
    const [storeNow] = await fx.query<{ name: string | null; store_url: string }>(
      'SELECT name, store_url FROM app.commerce_stores WHERE id = $1',
      [storeId],
    );
    const [number] = await fx.query<{ display_phone_number: string | null }>(
      'SELECT display_phone_number FROM app.channel_accounts WHERE id = $1',
      [c.channelAccountId],
    );
    const [customer] = await fx.query<{ id: string; phone_e164: string; display_name: string }>(
      `SELECT id, phone_e164, display_name FROM app.contacts
        WHERE tenant_id = $1 AND phone_e164 = '+919822200001'`,
      [c.tenant.id],
    );
    const bodies = hookBodiesAt(reminders.path);
    expect(bodies).toHaveLength(7);
    for (const body of bodies) {
      const parsed =
        (body as { type: string }).type === 'store_checkout.reminder_sent'
          ? storeCheckoutReminderSentPayloadSchema.safeParse(body)
          : storeCheckoutReminderSkippedPayloadSchema.safeParse(body);
      expect(parsed.success, JSON.stringify(body)).toBe(true);
    }
    expect(bodies).toEqual(
      expect.arrayContaining(
        reminderEvents.map((e) => {
          const row = reminderOf(e);
          const checkout = checkouts.get(String(row.checkout_id));
          if (!checkout) throw new Error('a checkout gone');
          const storeCheckout = {
            id: checkout.id,
            externalId: checkout.external_id,
            name: checkout.name,
            currency: checkout.currency,
            totalMinor: checkout.total_minor === null ? null : Number(checkout.total_minor),
            itemCount: checkout.item_count,
            startedAt: (checkout.remote_created_at as Date).toISOString(),
            completedAt: null,
          };
          const store = {
            id: storeId,
            platform: 'shopify',
            name: storeNow!.name,
            url: storeNow!.store_url,
          };
          return expect.objectContaining({
            id: e.id,
            type: e.type,
            data:
              e.type === 'store_checkout.reminder_sent'
                ? {
                    reminder: {
                      event: row.event,
                      occurredAt: row.occurred_at.toISOString(),
                      messageId: row.message_id,
                    },
                    storeCheckout,
                    store,
                    conversation: { id: e.conversation_id },
                    contact: {
                      id: customer!.id,
                      phone: customer!.phone_e164,
                      name: customer!.display_name,
                    },
                    channel: { id: c.channelAccountId, phone: number!.display_phone_number },
                  }
                : {
                    reminder: {
                      event: row.event,
                      skipReason: row.skip_reason,
                      occurredAt: row.occurred_at.toISOString(),
                    },
                    storeCheckout,
                    store,
                  },
          });
        }),
      ),
    );
    expect(hookBodiesAt(thisStoreHere.path)).toHaveLength(7);
    expect(hookBodiesAt(thatStore.path)).toEqual([]);
    expect(hookBodiesAt(otherNumber.path).map((body) => (body as { type: string }).type)).toEqual(
      Array(5).fill('store_checkout.reminder_skipped'),
    );
  });

  it('asks Shopify for customer access only when a manager allows it, and uses the consent the store records', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { shop, storeId } = await shopifyStoreForMessages(c, owner);
    const template = await approvedTemplate(c, owner, cartReminder);
    await optIn(owner, storeId);
    expect(await storeRow(storeId)).toMatchObject({ granted_scopes: 'read_orders,read_products' });
    await expectAppError(
      storeMessages().saveStoreConsent(owner, { storeId, useStoreConsent: true }),
      'validation_failed',
      /allow HyFib to read the store’s customers/,
    );
    // An API version without Shopify's WhatsApp consent refuses the setting too.
    await expectAppError(
      storeMessages(systemClock, '2025-10').saveStoreConsent(owner, {
        storeId,
        useStoreConsent: true,
      }),
      'validation_failed',
      /2026-07 or later/,
    );

    // Another manager cannot finish the owner's approval.
    const admin = await fx.ctx(c, await member(c, 'admin'));
    const pending = await allowCustomerAccess(owner, storeId);
    expect(new URL(pending.url).searchParams.get('scope')).toBe(
      'read_orders,read_products,read_customers',
    );
    await expectAppError(service().acceptShopifyApproval(admin, pending.checked), 'forbidden');
    const credentialsBefore = Number((await storeRow(storeId))?.credentials_version);
    await service().acceptShopifyApproval(owner, pending.checked);
    // The store keeps working with its old token until the worker exchanges the code.
    expect(await storeRow(storeId)).toMatchObject({
      state: 'connected',
      access_code_ciphertext: expect.any(String),
      connect_token_hash: null,
    });
    await drain(c, storeId);
    expect(await storeRow(storeId)).toMatchObject({
      state: 'connected',
      access_code_ciphertext: null,
      access_error: null,
      granted_scopes: 'read_orders,read_products,read_customers',
      credentials_version: credentialsBefore + 1,
    });
    await expectAppError(service().startCustomerAccess(owner, storeId), 'conflict', /already/);

    // Only members who may change contacts' consent can turn it on: not an agent, nor a member
    // who manages commerce without contacts.write (no built-in role today; checked all the same).
    await expectAppError(
      storeMessages().saveStoreConsent(await fx.ctx(c, await member(c, 'agent')), {
        storeId,
        useStoreConsent: true,
      }),
      'forbidden',
    );
    const withoutContacts = new Set([...owner.permissions].filter((p) => p !== 'contacts.write'));
    await expectAppError(
      storeMessages().saveStoreConsent(
        { ...owner, permissions: withoutContacts, rolePermissions: withoutContacts },
        { storeId, useStoreConsent: true },
      ),
      'forbidden',
    );
    await storeMessages().saveStoreConsent(owner, { storeId, useStoreConsent: true });
    await cartRule(owner, c, storeId, 'cart_reminder', {
      templateId: template.id,
      delayMinutes: 30,
    });

    const subscribedAt = iso(-3_600_000);
    leave(shop, '20', {
      phone: '+919833300009',
      name: 'Address Name',
      updatedAt: iso(),
      customer: {
        id: '7001',
        displayName: 'Nila C',
        phone: '+919833300001',
        consent: {
          state: 'SUBSCRIBED',
          optInLevel: 'SINGLE_OPT_IN',
          collectedFrom: 'SHOPIFY',
          updatedAt: subscribedAt,
        },
      },
    });
    // The consent Shopify records for the address's number says nothing: none is imported.
    leave(shop, '21', { phone: '+919833300002', updatedAt: iso() });
    // A number on the suppression list never becomes a contact, whatever Shopify records.
    await createConsentService({ db: fx.dbs.app, clock: systemClock }).addSuppression(owner, {
      phone: '+919833300005',
      reason: 'manual',
    });
    leave(shop, '24', {
      phone: null,
      updatedAt: iso(),
      customer: {
        id: '7005',
        displayName: 'Kept Out',
        phone: '+919833300005',
        consent: {
          state: 'SUBSCRIBED',
          optInLevel: 'SINGLE_OPT_IN',
          collectedFrom: 'SHOPIFY',
          updatedAt: subscribedAt,
        },
      },
    });
    await readCheckouts(c, storeId);
    await readCheckouts(c, storeId);
    expect(
      await fx.query('SELECT id FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2', [
        c.tenant.id,
        '+919833300005',
      ]),
    ).toEqual([]);
    const events = await fx.query<{
      action: string;
      source: string;
      actor_type: string;
      occurred_at: Date;
      evidence: Record<string, unknown>;
      phone: string;
    }>(
      `SELECT e.action, e.source, e.actor_type, e.occurred_at, e.evidence, ct.phone_e164 AS phone
         FROM app.consent_events e JOIN app.contacts ct ON ct.id = e.contact_id
        WHERE e.tenant_id = $1 AND e.source = 'store'`,
      [c.tenant.id],
    );
    // Recorded once, for the customer's own number, with Shopify's time and evidence.
    expect(events).toEqual([
      {
        action: 'opt_in',
        source: 'store',
        actor_type: 'provider',
        occurred_at: new Date(subscribedAt),
        evidence: expect.objectContaining({
          storeId,
          checkout: '20',
          state: 'SUBSCRIBED',
          optInLevel: 'SINGLE_OPT_IN',
          collectedFrom: 'SHOPIFY',
        }),
        phone: '+919833300001',
      },
    ]);
    expect(
      await fx.query(
        'SELECT source, display_name FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2',
        [c.tenant.id, '+919833300001'],
      ),
    ).toEqual([{ source: 'store', display_name: 'Nila C' }]);
    expect(await runCart(c, storeId, later(31 * MINUTE_MS))).toEqual([
      ['20', 'cart_reminder', 'queued'],
      ['21', 'cart_reminder', 'skipped: no_marketing_opt_in'],
      ['24', 'cart_reminder', 'skipped: suppressed'],
    ]);
    expect(await sendAll(c)).toEqual(['accepted']);
    expect(bodyTexts(templatesTo('919833300001')[0])?.[0]).toBe('Nila C');

    // A newer opt-out in HyFib wins over the store's older subscription; a newer store
    // unsubscription wins over an older opt-in.
    const consent = createConsentService({ db: fx.dbs.app, clock: systemClock });
    const [nila] = await fx.query<{ id: string }>(
      'SELECT id FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2',
      [c.tenant.id, '+919833300001'],
    );
    await consent.recordConsent(owner, {
      contactId: nila?.id,
      purpose: 'marketing',
      action: 'opt_out',
    });
    const zoya = await marketingOptIn(owner, '+919833300003', 'Zoya');
    leave(shop, '22', {
      phone: null,
      updatedAt: iso(2000),
      customer: {
        id: '7003',
        displayName: 'Zoya',
        phone: '+919833300003',
        consent: {
          state: 'UNSUBSCRIBED',
          optInLevel: null,
          collectedFrom: 'SHOPIFY',
          updatedAt: iso(60_000),
        },
      },
    });
    leave(shop, '20', {
      phone: '+919833300009',
      updatedAt: iso(3000),
      customer: {
        id: '7001',
        displayName: 'Nila C',
        phone: '+919833300001',
        consent: {
          state: 'SUBSCRIBED',
          optInLevel: 'SINGLE_OPT_IN',
          collectedFrom: 'SHOPIFY',
          updatedAt: subscribedAt,
        },
      },
    });
    await readCheckouts(c, storeId);
    const state = async (contactId: string) =>
      (
        await fx.query<{ status: string }>(
          `SELECT status FROM app.contact_consents WHERE contact_id = $1 AND purpose = 'marketing'`,
          [contactId],
        )
      )[0]?.status;
    expect(await state(nila?.id as string)).toBe('opted_out');
    expect(await state(zoya)).toBe('opted_out');

    // Shopify's customers/redact finds checkouts by the customer's id too, whatever number it gives.
    expect(
      await shopify.deliverCompliance('customers/redact', {
        shop_id: Number(shopify.shops.get(shop)?.id),
        shop_domain: shop,
        customer: { id: 7001, phone: '+919833300077' },
        orders_to_redact: [],
      }),
    ).toBe(200);
    expect((await checkoutRows(storeId)).find((k) => k.external_id === '20')).toMatchObject({
      customer_external_id: null,
      customer_phone: null,
      consent_state: null,
      redacted_at: expect.any(Date),
    });

    // Turned off during a read: consent read after that is not recorded, and later reads do not
    // ask Shopify for customers at all.
    const ira = (updatedAt: string) =>
      leave(shop, '23', {
        phone: '+919833300008',
        updatedAt,
        customer: {
          id: '7004',
          displayName: 'Ira',
          phone: '+919833300004',
          consent: {
            state: 'SUBSCRIBED',
            optInLevel: 'SINGLE_OPT_IN',
            collectedFrom: 'SHOPIFY',
            updatedAt: iso(-60_000),
          },
        },
      });
    ira(iso(4000));
    shopify.beforeAnswer = async (request) => {
      if (request.shop !== shop || request.operation !== 'W360CheckoutsWithCustomers') return;
      shopify.beforeAnswer = null;
      await storeMessages().saveStoreConsent(owner, { storeId, useStoreConsent: false });
    };
    try {
      await readCheckouts(c, storeId);
    } finally {
      shopify.beforeAnswer = null;
    }
    expect(
      await fx.query(
        `SELECT e.id FROM app.consent_events e JOIN app.contacts ct ON ct.id = e.contact_id
          WHERE e.tenant_id = $1 AND e.source = 'store' AND ct.phone_e164 = $2`,
        [c.tenant.id, '+919833300004'],
      ),
    ).toEqual([]);
    const callsBefore = shopify.calls.length;
    ira(iso(5000));
    await readCheckouts(c, storeId);
    expect(
      shopify.calls
        .slice(callsBefore)
        .map((k) => k.operation)
        .filter((o) => o?.startsWith('W360Checkouts')),
    ).toEqual(['W360Checkouts']);
    expect((await checkoutRows(storeId)).find((k) => k.external_id === '23')).toMatchObject({
      customer_phone: '+919833300008',
      consent_state: null,
    });

    // A refused request for more access keeps the store working with what it has.
    const other = await shopifyStoreForMessages(c, owner, 'Other Tea');
    shopify.grantScopes = ['read_orders', 'read_products'];
    try {
      const refused = await allowCustomerAccess(owner, other.storeId);
      await service().acceptShopifyApproval(owner, refused.checked);
      await drain(c, other.storeId);
    } finally {
      shopify.grantScopes = null;
    }
    expect(await storeRow(other.storeId)).toMatchObject({
      state: 'connected',
      access_code_ciphertext: null,
      granted_scopes: 'read_orders,read_products',
      access_error: expect.stringMatching(/did not grant access to customers/),
    });
    const audit = await fx.query<{ action: string }>(
      `SELECT action FROM app.audit_events WHERE tenant_id = $1
          AND action IN ('commerce.store_customer_access_requested',
            'commerce.store_customer_access_approved', 'commerce.store_access_updated',
            'commerce.store_consent_saved')
        ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'commerce.store_customer_access_requested',
      'commerce.store_customer_access_approved',
      'commerce.store_access_updated',
      'commerce.store_consent_saved',
      'commerce.store_consent_saved',
      'commerce.store_customer_access_requested',
      'commerce.store_customer_access_approved',
      'commerce.store_access_updated',
    ]);

    // Shopify grants customers but not the connector's own scopes. The new token replaced the old
    // one at Shopify (one current token per store, SH-007), so HyFib keeps it and the store has to
    // be connected again.
    const third = await shopifyStoreForMessages(c, owner, 'Third Tea');
    const thirdBefore = await storeRow(third.storeId);
    shopify.grantScopes = ['read_customers'];
    try {
      const partial = await allowCustomerAccess(owner, third.storeId);
      await service().acceptShopifyApproval(owner, partial.checked);
      await drain(c, third.storeId);
    } finally {
      shopify.grantScopes = null;
    }
    expect(await storeRow(third.storeId)).toMatchObject({
      state: 'failed',
      access_code_ciphertext: null,
      granted_scopes: 'read_customers',
      credentials_version: Number(thirdBefore?.credentials_version) + 1,
      status_error: expect.stringMatching(
        /did not grant read_orders and read_products.*Connect the store again/,
      ),
    });

    // The credentials change while Shopify answers the exchange (another writer, such as a
    // reconnect): the new token is not stored over them.
    const again = await allowCustomerAccess(owner, other.storeId);
    await service().acceptShopifyApproval(owner, again.checked);
    shopify.beforeAnswer = async (request) => {
      if (request.shop !== other.shop || request.grant !== 'authorization_code') return;
      shopify.beforeAnswer = null;
      await fx.query(
        'UPDATE app.commerce_stores SET credentials_version = credentials_version + 1 WHERE id = $1',
        [other.storeId],
      );
    };
    try {
      await drain(c, other.storeId);
    } finally {
      shopify.beforeAnswer = null;
    }
    expect(await storeRow(other.storeId)).toMatchObject({
      granted_scopes: 'read_orders,read_products',
    });
  });

  it('keeps the store working when checkouts cannot be read, erases customers for good, prunes old checkouts and keeps companies apart', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { shop, storeId } = await shopifyStoreForMessages(c, owner);
    const template = await approvedTemplate(c, owner, cartReminder);
    await optIn(owner, storeId);
    await cartRule(owner, c, storeId, 'cart_reminder', {
      templateId: template.id,
      delayMinutes: 30,
    });

    // Shopify refuses checkouts: the reason stays on the store, which keeps syncing orders.
    shopify.shops.get(shop)!.denyCheckouts = true;
    shopify.upsertOrder(shop, { id: '9100', phone: '+919844400000' });
    await orderSignal(shop, '9100', 'orders/create');
    await readCheckouts(c, storeId);
    const refused = await storeRow(storeId);
    expect(refused).toMatchObject({
      state: 'connected',
      checkouts_error: expect.stringMatching(/Reading checkouts/),
    });
    expect(new Date(refused?.checkouts_read_at as Date).getTime()).toBeGreaterThan(
      Date.now() + 10 * MINUTE_MS,
    );
    expect((await orderRows(storeId)).map((o) => o.external_id)).toContain('9100');
    shopify.shops.get(shop)!.denyCheckouts = false;

    await marketingOptIn(owner, '+919844400001', 'Gone');
    leave(shop, '30', { phone: '+919844400001', updatedAt: iso() });
    leave(shop, '31', { phone: '+919844400002', updatedAt: iso() });
    // A cursor from a while ago (the read covers it); afterwards the next read starts from when
    // this one started, less a margin for clocks.
    await fx.query(
      `UPDATE app.commerce_stores SET checkouts_cursor = now() - interval '1 hour' WHERE id = $1`,
      [storeId],
    );
    const startedAt = Date.now();
    await readCheckouts(c, storeId);
    const read = await storeRow(storeId);
    expect(read).toMatchObject({ checkouts_error: null, checkouts_page: null });
    const cursor = new Date(read?.checkouts_cursor as Date).getTime();
    expect(cursor).toBeLessThanOrEqual(startedAt - 119_000);
    expect(cursor).toBeGreaterThanOrEqual(startedAt - 125_000);
    expect(new Date(read?.checkouts_read_at as Date).getTime()).toBeGreaterThan(
      startedAt + 14 * MINUTE_MS,
    );

    // Erasing the contact redacts the checkout for good; its reminder is not sent.
    const [gone] = await fx.query<{ id: string }>(
      'SELECT id FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2',
      [c.tenant.id, '+919844400001'],
    );
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: gone?.id as string,
      suppress: false,
    });
    leave(shop, '30', { phone: '+919844400001', updatedAt: iso(1000) });
    await readCheckouts(c, storeId);
    expect((await checkoutRows(storeId)).find((k) => k.external_id === '30')).toMatchObject({
      customer_phone: null,
      customer_name: null,
      recovery_url: null,
      redacted_at: expect.any(Date),
    });
    // Shopify's customers/redact redacts by number too.
    expect(
      await shopify.deliverCompliance('customers/redact', {
        shop_id: Number(shopify.shops.get(shop)?.id),
        shop_domain: shop,
        customer: { id: 555, phone: '+919844400002' },
        orders_to_redact: [],
      }),
    ).toBe(200);
    expect((await checkoutRows(storeId)).find((k) => k.external_id === '31')).toMatchObject({
      customer_phone: null,
      redacted_at: expect.any(Date),
    });
    expect(await runCart(c, storeId, later(31 * MINUTE_MS))).toEqual([
      ['30', 'cart_reminder', 'skipped: customer_erased'],
      ['31', 'cart_reminder', 'skipped: customer_erased'],
    ]);

    // Checkouts are kept 30 days after their last update.
    const monthAgo = iso(-31 * 86_400_000);
    leave(shop, '30', { phone: '+919844400001', updatedAt: monthAgo });
    await fx.query(
      `UPDATE app.commerce_store_checkouts SET remote_updated_at = $2
        WHERE store_id = $1 AND external_id = '30'`,
      [storeId, monthAgo],
    );
    await readCheckouts(c, storeId);
    expect((await checkoutRows(storeId)).map((k) => k.external_id)).toEqual(['31']);

    // More checkouts than one run reads (ten pages of 50): the next run continues with Shopify's
    // page cursor, and the read's own cursor moves only when the read is complete.
    // (The cursor is a second ahead so the read's whole seconds leave out checkout 31.)
    await fx.query(
      `UPDATE app.commerce_stores SET checkouts_cursor = now() + interval '1 second',
         checkouts_read_at = now() WHERE id = $1`,
      [storeId],
    );
    for (let i = 0; i < 520; i += 1) {
      leave(shop, String(1000 + i), { phone: null, updatedAt: iso(3000) });
    }
    const many = async () =>
      (await checkoutRows(storeId)).filter((k) => Number(k.external_id) >= 1000).length;
    const cursorBefore = new Date((await storeRow(storeId))?.checkouts_cursor as Date).getTime();
    await processStoreJob(workerDeps(), scopeOf(c), storeId);
    const partway = await storeRow(storeId);
    expect(partway).toMatchObject({ checkouts_page: expect.any(String), checkouts_error: null });
    expect(new Date(partway?.checkouts_cursor as Date).getTime()).toBe(cursorBefore);
    expect(await many()).toBe(500);
    await drain(c, storeId);
    expect(await storeRow(storeId)).toMatchObject({ checkouts_page: null, checkouts_error: null });
    expect(await many()).toBe(520);

    // Withdrawing the opt-in switches every rule off: the next read stops reading checkouts.
    await optIn(owner, storeId, { optIn: false });
    const callsBefore = shopify.calls.length;
    await readCheckouts(c, storeId);
    expect(
      shopify.calls.slice(callsBefore).some((k) => k.operation?.startsWith('W360Checkouts')),
    ).toBe(false);
    expect(await storeRow(storeId)).toMatchObject({ checkouts_read_at: null });

    // Only a connected store can be given more access.
    const goneStore = await shopifyStoreForMessages(c, owner, 'Gone Tea');
    await shopify.uninstall(goneStore.shop);
    expect(await storeRow(goneStore.storeId)).toMatchObject({ state: 'uninstalled' });
    await expectAppError(
      service().startCustomerAccess(owner, goneStore.storeId),
      'conflict',
      /connected store/,
    );

    // WooCommerce has no carts; agents cannot change reminders; other companies see nothing.
    const site = `cart-${Date.now().toString(36)}`;
    woo.addSite(site);
    const keys = woo.addKeys(site);
    const { storeId: wooStore } = await service().saveWooKeys(owner, {
      url: woo.siteUrl(site),
      ...keys,
    });
    await drain(c, wooStore);
    await optIn(owner, wooStore);
    await expectAppError(
      cartRule(owner, c, wooStore, 'cart_reminder', { templateId: template.id, delayMinutes: 30 }),
      'validation_failed',
      /not available/,
    );
    const agent = await fx.ctx(c, await member(c, 'agent'));
    await expectAppError(
      cartRule(agent, c, storeId, 'cart_reminder', { templateId: template.id, delayMinutes: 45 }),
      'forbidden',
    );
    await expectAppError(service().startCustomerAccess(agent, storeId), 'forbidden');
    const otherCompany = await fx.company();
    const otherOwner = await fx.ctx(otherCompany, otherCompany.owner);
    await expectAppError(service().startCustomerAccess(otherOwner, storeId), 'not_found');
    await expectAppError(
      storeMessages().saveStoreConsent(otherOwner, { storeId, useStoreConsent: true }),
      'not_found',
    );
  });
});

// Store events in automations (P4-06e, ADR-050) --------------------------------------------------------

const automationService = (clock: Clock = systemClock) =>
  createAutomationService({ db: fx.dbs.app, clock, jobs: fx.jobs(), signer: fx.signer });
const runnerDeps = (clock: Clock = systemClock) => ({
  db: fx.dbs.app,
  jobs: fx.jobs(),
  signer: fx.signer,
  clock,
  keyring: fx.keyring,
});
const storeEvent: AutomationTrigger = { type: 'store_event' };
/** A context without some permissions (as a narrower role would have). */
const without = (ctx: TenantContext, ...removed: Permission[]): TenantContext => ({
  ...ctx,
  permissions: new Set([...ctx.permissions].filter((p) => !removed.includes(p))),
});

/** An order confirmation with two quick replies around a link button (positions 0 and 2). */
const orderConfirmed: TemplateDefinition = {
  category: 'UTILITY',
  header: { type: 'none' },
  body: {
    text: 'Hi {{1}}, thanks for order {{2}} from {{3}}. Need anything?',
    examples: ['Asha', '#1001', 'Tara Tea'],
  },
  footer: null,
  buttons: [
    { type: 'QUICK_REPLY', text: 'Track order' },
    { type: 'URL', text: 'Shop again', url: 'https://tara-tea.example/shop' },
    { type: 'QUICK_REPLY', text: 'Talk to us' },
  ],
};

/** Confirms the order with the template, then answers "Track order" or hands off. */
function orderFlow(templateId: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    start: 'confirm',
    nodes: [
      {
        id: 'confirm',
        type: 'ask_template',
        templateId,
        header: [],
        body: ['{{order.customer_name}}', '{{order.number}}', '{{order.store}}'],
        buttons: [
          { index: 0, title: 'Track order', next: 'track' },
          { index: 2, title: 'Talk to us', next: 'people' },
        ],
        saveAs: 'choice',
        replyNext: 'people',
        timeoutMinutes: 60,
        timeoutNext: 'bye',
        ...overrides,
      },
      {
        id: 'track',
        type: 'send_text',
        text: 'Order {{order.number}} ({{order.items}}): {{order.status_url}}',
        next: 'tag',
      },
      {
        id: 'tag',
        type: 'update_contact',
        action: { kind: 'add_tag', tag: 'Order tracked' },
        next: null,
      },
      { id: 'people', type: 'handoff', teamId: null },
      { id: 'bye', type: 'end' },
    ],
  };
}

async function publishAutomation(
  owner: TenantContext,
  name: string,
  trigger: AutomationTrigger,
  graph: unknown,
  channelAccountId: string | null = null,
) {
  const svc = automationService();
  const { id } = await svc.createAutomation(owner, { name });
  const saved = await svc.updateAutomation(owner, {
    id,
    expectedVersion: 0,
    name,
    description: null,
    channelAccountId,
    trigger,
    graph,
  });
  const published = await svc.publishAutomation(owner, {
    id,
    expectedVersion: saved.version,
    note: null,
  });
  return { id, version: published.version, issues: saved.issues };
}

async function automationRule(
  owner: TenantContext,
  c: Company,
  storeId: string,
  event: StoreMessageEvent,
  automationId: string | null,
  extra: Record<string, unknown> = {},
) {
  const view = await storeMessages().storeMessages(owner, storeId);
  const rule = view.rules.find((r) => r.event === event);
  return storeMessages().saveMessageRule(owner, {
    storeId,
    event,
    enabled: true,
    action: 'automation',
    automationId,
    channelAccountId: c.channelAccountId,
    templateId: null,
    variables: { header: [], body: [] },
    delayMinutes: 0,
    confirmButton: null,
    cancelButton: null,
    version: rule?.version ?? 0,
    ...extra,
  });
}

interface StoreRunRow extends Record<string, unknown> {
  id: string;
  status: string;
  end_reason: string | null;
  end_detail: string | null;
  trigger_type: string;
  store_event: string | null;
  store_order_id: string | null;
  conversation_id: string;
  variables: Record<string, string>;
  next_step_at: Date | null;
}

async function storeRun(runId: string) {
  const [row] = await fx.query<StoreRunRow>(
    `SELECT id, status, end_reason, end_detail, trigger_type, store_event, store_order_id,
            conversation_id, variables, next_step_at
       FROM app.automation_runs WHERE id = $1`,
    [runId],
  );
  if (!row) throw new Error('run not found');
  return row;
}

/**
 * Advances a run, handing each message it queues to the send worker (the stand-in accepts it), until
 * it waits with nothing in flight or ends (bounded). Returns the run's status.
 */
async function driveRun(c: Company, runId: string, clock: Clock = systemClock) {
  for (let i = 0; i < 20; i += 1) {
    const result = await advanceAutomationRun(runnerDeps(clock), scopeOf(c), runId, null);
    const sent = await sendAll(c);
    if (sent.length === 0 && result.outcome !== 'sending') return (await storeRun(runId)).status;
  }
  throw new Error('the run did not settle');
}

/** The customer's tap on a quick-reply button of a template message. */
function templateTap(
  c: Company,
  from: string,
  input: { payload: string; text: string; context: string },
) {
  return fx.deliver(
    fx.messagesBody(c, {
      messages: [
        {
          waId: from,
          type: 'button',
          extra: {
            button: { payload: input.payload, text: input.text },
            context: { from: '919000000000', id: input.context },
          },
        },
      ],
    }),
  );
}

/** A new Shopify order from `phone`, read into the copy (its store message waits). */
async function placeOrder(c: Company, shop: string, storeId: string, id: string, phone: string) {
  shopify.upsertOrder(shop, {
    id,
    name: `#${id}`,
    phone,
    shippingAddress: { name: 'Asha K', phone: null },
    total: { amount: '1499.00', currencyCode: 'INR' },
    lineItems: [
      {
        name: 'Assam tea',
        sku: 'A',
        quantity: 1,
        total: { amount: '999.00', currencyCode: 'INR' },
      },
      { name: 'Tea cups', sku: 'C', quantity: 2, total: { amount: '500.00', currencyCode: 'INR' } },
    ],
  });
  await orderSignal(shop, id, 'orders/create');
  await drain(c, storeId);
}

describe('Store events in automations', () => {
  it('starts the chosen automation for a new order, sends its template outside the service window and follows the customer’s tap', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { shop, storeId } = await shopifyStoreForMessages(c, owner);
    await optIn(owner, storeId);
    const template = await approvedTemplate(c, owner, orderConfirmed);
    // The order system learns of each order's message that went out (ADR-353).
    const sends = await addHook(owner, ['store_order.message_sent']);

    // Until the customer replies only templates reach them: a message first is refused.
    const svc = automationService();
    const draft = await svc.createAutomation(owner, { name: 'Too early' });
    const early = await svc.updateAutomation(owner, {
      id: draft.id,
      expectedVersion: 0,
      name: 'Too early',
      description: null,
      channelAccountId: null,
      trigger: storeEvent,
      graph: {
        version: 1,
        start: 'hi',
        nodes: [{ id: 'hi', type: 'send_text', text: 'Hi {{order.number}}', next: null }],
      },
    });
    expect(early.issues.map((i) => i.message)).toEqual([
      expect.stringContaining('only templates until the customer replies'),
    ]);
    await expectAppError(
      svc.publishAutomation(owner, { id: draft.id, expectedVersion: early.version, note: null }),
      'precondition_failed',
      /only templates until the customer replies/,
    );
    // Order fields exist only in automations started by order messages.
    const keywordDraft = await svc.createAutomation(owner, { name: 'Keyword' });
    const keywordSaved = await svc.updateAutomation(owner, {
      id: keywordDraft.id,
      expectedVersion: 0,
      name: 'Keyword',
      description: null,
      channelAccountId: null,
      trigger: {
        type: 'keyword',
        keywords: ['order'],
        match: 'contains',
        hours: 'any',
        cooldownMinutes: 0,
      },
      graph: {
        version: 1,
        start: 'hi',
        nodes: [{ id: 'hi', type: 'send_text', text: 'Your order {{order.number}}', next: null }],
      },
    });
    expect(keywordSaved.issues.map((i) => i.message)).toEqual([
      '{{order.number}} is an order field: order fields work only in automations started by a store’s order messages.',
    ]);

    const flow = await publishAutomation(
      owner,
      'Order follow-up',
      storeEvent,
      orderFlow(template.id),
    );
    expect(flow.issues).toEqual([]);
    // A rule can start it; the cash on delivery confirmation cannot start automations.
    await expectAppError(
      automationRule(owner, c, storeId, 'cod_confirmation', flow.id),
      'validation_failed',
      /cannot start an automation/,
    );
    await automationRule(owner, c, storeId, 'order_placed', flow.id);
    const view = await storeMessages().storeMessages(owner, storeId);
    expect(view.rules.find((r) => r.event === 'order_placed')).toMatchObject({
      action: 'automation',
      automationId: flow.id,
      automationName: 'Order follow-up',
      automationAllowed: true,
      problem: null,
    });
    expect(view.rules.find((r) => r.event === 'cod_confirmation')?.automationAllowed).toBe(false);
    expect(view.automations).toEqual([{ id: flow.id, name: 'Order follow-up', status: 'active' }]);

    await placeOrder(c, shop, storeId, '7001', '+919812370001');
    const [outcome] = await runMessages(c, storeId);
    expect(outcome).toMatchObject({ outcome: 'started' });
    const runId = (outcome as { runId: string }).runId;
    const [started] = await messageRows(storeId);
    expect(started).toMatchObject({
      event: 'order_placed',
      state: 'started',
      automation_run_id: runId,
      message_id: null,
    });
    expect(started?.contact_id).toBeTruthy();
    // A repeated job or the sweep starts nothing more.
    expect(await processStoreMessage(messageDeps(), scopeOf(c), started!.id)).toEqual({
      outcome: 'not_pending',
    });
    const [order] = await fx.query<{ id: string }>(
      `SELECT id FROM app.commerce_store_orders WHERE store_id = $1 AND external_id = '7001'`,
      [storeId],
    );
    let run = await storeRun(runId);
    expect(run).toMatchObject({
      status: 'running',
      trigger_type: 'store_event',
      store_event: 'order_placed',
      store_order_id: order?.id,
    });
    // The customer never wrote: the conversation starts resolved, out of the inbox.
    const [thread] = await fx.query<{ status: string; last_inbound_at: Date | null }>(
      'SELECT status, last_inbound_at FROM app.conversations WHERE id = $1',
      [run.conversation_id],
    );
    expect(thread).toEqual({ status: 'resolved', last_inbound_at: null });
    // The message that went out is the run: its event names the run and the run's conversation, and
    // no chat message (ADR-353).
    const startedEvents = await fx.query<{
      id: string;
      status: string;
      message_id: string | null;
      conversation_id: string | null;
      contact_id: string | null;
      detail: Record<string, unknown>;
    }>(
      `SELECT id, status, message_id, conversation_id, contact_id, detail FROM app.webhook_events
        WHERE tenant_id = $1 AND type = 'store_order.message_sent'`,
      [c.tenant.id],
    );
    expect(startedEvents).toEqual([
      {
        id: expect.any(String),
        status: 'order_placed',
        message_id: null,
        conversation_id: run.conversation_id,
        contact_id: started?.contact_id,
        detail: {
          storeMessageId: started?.id,
          automationRunId: runId,
          occurredAt: expect.any(String),
        },
      },
    ]);
    await deliverHooks(c);
    const [startedBody] = hookBodiesAt(sends.path);
    expect(storeOrderMessageSentPayloadSchema.safeParse(startedBody).success).toBe(true);
    expect(startedBody).toMatchObject({
      id: startedEvents[0]?.id,
      type: 'store_order.message_sent',
      data: {
        orderMessage: { event: 'order_placed', messageId: null, automationRunId: runId },
        storeOrder: { id: order?.id, externalId: '7001', name: '#7001' },
        store: { id: storeId, platform: 'shopify', name: 'Tara Tea' },
        conversation: { id: run.conversation_id },
        contact: { id: started?.contact_id, phone: '+919812370001', name: 'Asha K' },
        channel: { id: c.channelAccountId },
      },
    });

    // The template goes out with the order's values and a bot payload per quick reply.
    expect(await driveRun(c, runId)).toBe('waiting');
    const [sent] = templatesTo('919812370001');
    expect(sent?.name).toBe(template.name);
    expect(bodyTexts(sent)).toEqual(['Asha K', '#7001', 'Tara Tea']);
    expect(sent?.components.filter((x) => (x as { type: string }).type === 'button')).toEqual([
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '0',
        parameters: [{ type: 'payload', payload: botButtonId(runId, 'confirm', 1, 0) }],
      },
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '2',
        parameters: [{ type: 'payload', payload: botButtonId(runId, 'confirm', 1, 2) }],
      },
    ]);
    const [bot] = await fx.query<{
      id: string;
      type: string;
      sender_type: string;
      content: { automationRunId: string; rendered: { body: string } };
      external_message_id: string;
    }>(
      `SELECT id, type, sender_type, content, external_message_id FROM app.messages
        WHERE conversation_id = $1 ORDER BY created_at`,
      [run.conversation_id],
    );
    expect(bot).toMatchObject({ type: 'template', sender_type: 'bot' });
    expect(bot?.content.automationRunId).toBe(runId);
    expect(bot?.content.rendered.body).toBe(
      'Hi Asha K, thanks for order #7001 from Tara Tea. Need anything?',
    );
    run = await storeRun(runId);
    expect(run).toMatchObject({ status: 'waiting' });

    // The customer taps "Track order": the conversation opens and the run continues.
    await templateTap(c, '919812370001', {
      payload: botButtonId(runId, 'confirm', 1, 0),
      text: 'Track order',
      context: bot!.external_message_id,
    });
    expect(await driveRun(c, runId)).toBe('completed');
    run = await storeRun(runId);
    expect(run).toMatchObject({
      status: 'completed',
      end_reason: 'no_next',
      variables: { choice: 'Track order' },
    });
    const texts = fx.standIn.state.requests
      .filter(
        (r) => r.path.endsWith('/messages') && (r.body as { to?: string }).to === '919812370001',
      )
      .flatMap((r) =>
        (r.body as { text?: { body: string } }).text
          ? [(r.body as { text: { body: string } }).text.body]
          : [],
      );
    expect(texts).toEqual([
      `Order #7001 (Assam tea and 1 more): https://${shop}/orders/status/7001`,
    ]);
    const [opened] = await fx.query<{ status: string; assigned_membership_id: string | null }>(
      'SELECT status, assigned_membership_id FROM app.conversations WHERE id = $1',
      [run.conversation_id],
    );
    expect(opened?.status).toBe('open');
    expect(
      await fx.query('SELECT tag FROM app.contact_tags WHERE contact_id = $1', [
        started?.contact_id,
      ]),
    ).toEqual([{ tag: 'order tracked' }]);
    // A customer message never starts an automation that starts from order messages.
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: '919812370001', text: 'thanks!' }] }));
    expect(
      await fx.query(
        'SELECT count(*)::int AS n FROM app.automation_runs WHERE conversation_id = $1',
        [run.conversation_id],
      ),
    ).toEqual([{ n: 1 }]);

    // The report, the order page, the run and the automation show where it came from.
    const report = await storeMessages().storeMessages(owner, storeId);
    expect(report.counts.started).toBe(1);
    expect(report.recent[0]).toMatchObject({
      status: 'started',
      orderName: '#7001',
      automation: { automationName: 'Order follow-up', runStatus: 'completed', runId },
    });
    const onOrder = await storeMessages().orderMessages(owner, order!.id);
    expect(onOrder).toMatchObject([
      { status: 'started', automation: { runId, runStatus: 'completed' } },
    ]);
    const detail = await svc.getRun(owner, runId);
    expect(detail).toMatchObject({
      triggerType: 'store_event',
      storeEvent: 'order_placed',
      order: { id: order?.id, name: '#7001', storeName: 'Tara Tea' },
    });
    expect((await svc.getAutomation(owner, flow.id)).usedBy).toEqual([
      {
        storeId,
        storeName: 'Tara Tea',
        event: 'order_placed',
        label: 'Order placed',
        enabled: true,
      },
    ]);
    // Without automations.read the run is named, not linked; without commerce.read no order.
    const agent = await fx.ctx(c, await member(c, 'agent'));
    expect((await storeMessages().storeMessages(agent, storeId)).recent[0]?.automation).toEqual({
      automationName: 'Order follow-up',
      runStatus: 'completed',
      runId: null,
    });
    const analyst = await fx.ctx(c, await member(c, 'analyst'));
    expect((await svc.getRun(analyst, runId)).order).toBeNull();
    expect((await svc.getAutomation(analyst, flow.id)).usedBy).toBeNull();

    // A tap on a button of another visit of the step (a stale payload) is another reply, even
    // with a button's text: the run hands the conversation to people.
    await placeOrder(c, shop, storeId, '7002', '+919812370002');
    const [second] = await runMessages(c, storeId);
    const secondRun = (second as { runId: string }).runId;
    expect(await driveRun(c, secondRun)).toBe('waiting');
    const [secondBot] = await fx.query<{ external_message_id: string }>(
      `SELECT m.external_message_id FROM app.messages m
         JOIN app.automation_runs r ON r.conversation_id = m.conversation_id
        WHERE r.id = $1 AND m.sender_type = 'bot'`,
      [secondRun],
    );
    await templateTap(c, '919812370002', {
      payload: botButtonId(secondRun, 'confirm', 2, 0),
      text: 'Track order',
      context: secondBot!.external_message_id,
    });
    expect(await driveRun(c, secondRun)).toBe('handed_off');
    expect((await storeRun(secondRun)).variables).toEqual({});
  });

  it('skips an order when the automation, the conversation or the customer cannot take a run', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { shop, storeId } = await shopifyStoreForMessages(c, owner);
    await optIn(owner, storeId);
    const template = await approvedTemplate(c, owner, orderConfirmed);
    const flow = await publishAutomation(
      owner,
      'Order follow-up',
      storeEvent,
      orderFlow(template.id),
    );
    await automationRule(owner, c, storeId, 'order_placed', flow.id);
    // The order system learns of each order the automation could not take (ADR-351).
    await addHook(owner, ['store_order.message_skipped']);
    const svc = automationService();
    const skipOf = async (id: string, phone: string) => {
      await placeOrder(c, shop, storeId, id, phone);
      const outcomes = await runMessages(c, storeId);
      expect(outcomes).toHaveLength(1);
      return outcomes[0];
    };

    // Paused: nothing starts, and the page names the problem.
    const detail = await svc.getAutomation(owner, flow.id);
    await svc.setAutomationStatus(owner, {
      id: flow.id,
      expectedVersion: detail.version,
      status: 'paused',
    });
    expect(await skipOf('7101', '+919812371001')).toEqual({
      outcome: 'skipped',
      reason: 'automation_unavailable',
    });
    expect(
      (await storeMessages().storeMessages(owner, storeId)).rules.find(
        (r) => r.event === 'order_placed',
      )?.problem,
    ).toMatch(/paused or archived/);
    await svc.setAutomationStatus(owner, {
      id: flow.id,
      expectedVersion: detail.version + 1,
      status: 'active',
    });

    // A run already handles the conversation: the next order of that customer is skipped.
    expect(await skipOf('7102', '+919812371002')).toMatchObject({ outcome: 'started' });
    expect(await skipOf('7103', '+919812371002')).toEqual({
      outcome: 'skipped',
      reason: 'automation_busy',
    });

    // Assigned to a member: nothing starts in it.
    const [busy] = await fx.query<{ conversation_id: string; id: string }>(
      `SELECT conversation_id, id FROM app.automation_runs WHERE tenant_id = $1 AND status IN ('running', 'waiting')`,
      [c.tenant.id],
    );
    await svc.stopRun(owner, busy!.id);
    const [conv] = await fx.query<{ version: number }>(
      'SELECT version FROM app.conversations WHERE id = $1',
      [busy!.conversation_id],
    );
    await createInboxService({ db: fx.dbs.app, clock: systemClock }).assign(owner, {
      conversationId: busy!.conversation_id,
      membershipId: owner.membership.id,
      expectedVersion: conv!.version,
    });
    expect(await skipOf('7104', '+919812371002')).toEqual({
      outcome: 'skipped',
      reason: 'conversation_assigned',
    });

    // The customer's consent: suppressed numbers get no contact, opted-out contacts no run.
    const consent = createConsentService({ db: fx.dbs.app, clock: systemClock });
    await consent.addSuppression(owner, { phone: '+919812371005', reason: 'manual' });
    expect(await skipOf('7105', '+919812371005')).toEqual({
      outcome: 'skipped',
      reason: 'suppressed',
    });
    expect(
      await fx.query('SELECT 1 FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2', [
        c.tenant.id,
        '+919812371005',
      ]),
    ).toEqual([]);
    const optedOut = await createContactsService({
      db: fx.dbs.app,
      clock: systemClock,
    }).createContact(owner, { displayName: 'No', phone: '+919812371006' });
    await consent.recordConsent(owner, {
      contactId: optedOut.id,
      purpose: 'utility',
      action: 'opt_out',
    });
    expect(await skipOf('7106', '+919812371006')).toEqual({
      outcome: 'skipped',
      reason: 'opted_out',
    });

    // Too many runs in the conversation within the hour (bot-to-bot loops): a customer whose
    // conversation already had the hourly maximum.
    await placeOrder(c, shop, storeId, '7107', '+919812371007');
    const [fresh] = await runMessages(c, storeId);
    expect(fresh).toMatchObject({ outcome: 'started' });
    const freshRun = await storeRun((fresh as { runId: string }).runId);
    await svc.stopRun(owner, freshRun.id);
    for (let i = 0; i < 9; i += 1) {
      await fx.query(
        `INSERT INTO app.automation_runs (id, tenant_id, automation_id, version_id, conversation_id,
           contact_id, channel_account_id, mode, trigger_type, status, started_at, ended_at, end_reason)
         SELECT gen_random_uuid(), tenant_id, automation_id, version_id, conversation_id, contact_id,
                channel_account_id, 'live', 'keyword', 'completed', now() - interval '10 minutes',
                now() - interval '9 minutes', 'end_node'
           FROM app.automation_runs WHERE id = $1`,
        [freshRun.id],
      );
    }
    expect(await skipOf('7108', '+919812371007')).toEqual({
      outcome: 'skipped',
      reason: 'automation_limit',
    });

    // The rule's number is no longer active.
    await fx.query(`UPDATE app.channel_accounts SET status = 'needs_reconnect' WHERE id = $1`, [
      c.channelAccountId,
    ]);
    expect(await skipOf('7110', '+919812371010')).toEqual({
      outcome: 'skipped',
      reason: 'channel_unavailable',
    });
    await fx.query(`UPDATE app.channel_accounts SET status = 'active' WHERE id = $1`, [
      c.channelAccountId,
    ]);

    // A new live version that no longer starts from order messages.
    const current = await svc.getAutomation(owner, flow.id);
    const saved = await svc.updateAutomation(owner, {
      id: flow.id,
      expectedVersion: current.version,
      name: 'Order follow-up',
      description: null,
      channelAccountId: null,
      trigger: { type: 'any_message', hours: 'any', cooldownMinutes: 0 },
      graph: {
        version: 1,
        start: 'bye',
        nodes: [{ id: 'bye', type: 'end' }],
      },
    });
    await svc.publishAutomation(owner, { id: flow.id, expectedVersion: saved.version, note: null });
    expect(await skipOf('7109', '+919812371009')).toEqual({
      outcome: 'skipped',
      reason: 'automation_unavailable',
    });

    // Each skipped order sent its event with the reason, in order; the runs started sent none.
    expect(
      await fx.query(
        `SELECT o.external_id, e.status, e.detail ->> 'skipReason' AS reason
           FROM app.webhook_events e
           JOIN app.commerce_store_messages sm ON sm.id = (e.detail ->> 'storeMessageId')::uuid
           JOIN app.commerce_store_orders o ON o.id = sm.order_id
          WHERE e.tenant_id = $1 AND e.type = 'store_order.message_skipped'
          ORDER BY e.occurred_at, e.id`,
        [c.tenant.id],
      ),
    ).toEqual([
      { external_id: '7101', status: 'order_placed', reason: 'automation_unavailable' },
      { external_id: '7103', status: 'order_placed', reason: 'automation_busy' },
      { external_id: '7104', status: 'order_placed', reason: 'conversation_assigned' },
      { external_id: '7105', status: 'order_placed', reason: 'suppressed' },
      { external_id: '7106', status: 'order_placed', reason: 'opted_out' },
      { external_id: '7108', status: 'order_placed', reason: 'automation_limit' },
      { external_id: '7110', status: 'order_placed', reason: 'channel_unavailable' },
      { external_id: '7109', status: 'order_placed', reason: 'automation_unavailable' },
    ]);
  });

  it('checks each template again when its step runs, waits for the campaign lock, and stops once the conversation is resolved later', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { shop, storeId } = await shopifyStoreForMessages(c, owner);
    await optIn(owner, storeId);
    const confirmTemplate = await approvedTemplate(c, owner, orderConfirmed);
    const promo = await approvedTemplate(c, owner, {
      category: 'MARKETING',
      header: { type: 'none' },
      body: { text: 'Thanks {{1}}! Here is 10% off your next order.', examples: ['Asha'] },
      footer: null,
      buttons: [],
    });
    const svc = automationService();
    const startRun = async (id: string, phone: string) => {
      await placeOrder(c, shop, storeId, id, phone);
      const [started] = await runMessages(c, storeId);
      expect(started).toMatchObject({ outcome: 'started' });
      return (started as { runId: string }).runId;
    };
    const flow = await publishAutomation(
      owner,
      'Order follow-up',
      storeEvent,
      orderFlow(confirmTemplate.id),
    );
    await automationRule(owner, c, storeId, 'order_placed', flow.id);

    // The number is no longer active when the step runs.
    const inactive = await startRun('7209', '+919812372009');
    await fx.query(`UPDATE app.channel_accounts SET status = 'needs_reconnect' WHERE id = $1`, [
      c.channelAccountId,
    ]);
    expect(await driveRun(c, inactive)).toBe('failed');
    expect((await storeRun(inactive)).end_detail).toBe('channel_unavailable');
    await fx.query(`UPDATE app.channel_accounts SET status = 'active' WHERE id = $1`, [
      c.channelAccountId,
    ]);
    // The template's quick replies changed at Meta after the step was set up: nothing is sent.
    const changed = await startRun('7201', '+919812372001');
    await fx.query(
      `UPDATE app.message_templates SET components = (
         SELECT jsonb_agg(CASE WHEN x->>'type' = 'BUTTONS'
                               THEN jsonb_set(x, '{buttons,0,text}', '"Where is it?"') ELSE x END)
           FROM jsonb_array_elements(components) x)
        WHERE id = $1`,
      [confirmTemplate.id],
    );
    expect(await driveRun(c, changed)).toBe('failed');
    expect(await storeRun(changed)).toMatchObject({
      end_reason: 'send_blocked',
      end_detail: 'template_changed',
    });
    // It ended before the customer wrote: the conversation stays out of the inbox.
    const [quiet] = await fx.query<{ status: string; assigned_membership_id: string | null }>(
      'SELECT cv.status, cv.assigned_membership_id FROM app.conversations cv JOIN app.automation_runs r ON r.conversation_id = cv.id WHERE r.id = $1',
      [changed],
    );
    expect(quiet).toEqual({ status: 'resolved', assigned_membership_id: null });
    await fx.query(`UPDATE app.message_templates SET status = 'paused' WHERE id = $1`, [
      confirmTemplate.id,
    ]);
    const paused = await startRun('7202', '+919812372002');
    expect(await driveRun(c, paused)).toBe('failed');
    expect((await storeRun(paused)).end_detail).toBe('template_unavailable');

    // A marketing template: marketing opt-in, the campaign lock and the frequency cap.
    const current = await svc.getAutomation(owner, flow.id);
    const saved = await svc.updateAutomation(owner, {
      id: flow.id,
      expectedVersion: current.version,
      name: 'Order follow-up',
      description: null,
      channelAccountId: null,
      trigger: storeEvent,
      graph: {
        version: 1,
        start: 'promo',
        nodes: [
          {
            id: 'promo',
            type: 'send_template',
            templateId: promo.id,
            header: [],
            body: ['{{order.customer_name}}'],
            next: null,
          },
        ],
      },
    });
    // Publishing a marketing template needs the campaign sending permission.
    await expectAppError(
      svc.publishAutomation(without(owner, 'campaigns.send'), {
        id: flow.id,
        expectedVersion: saved.version,
        note: null,
      }),
      'forbidden',
      /marketing templates/,
    );
    await svc.publishAutomation(owner, { id: flow.id, expectedVersion: saved.version, note: null });

    const noOptIn = await startRun('7203', '+919812372003');
    expect(await driveRun(c, noOptIn)).toBe('failed');
    expect((await storeRun(noOptIn)).end_detail).toBe('no_marketing_opt_in');

    await marketingOptIn(owner, '+919812372004');
    const locked = await startRun('7204', '+919812372004');
    const client = await fx.dbs.adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `campaign-runner:${c.tenant.id}`,
      ]);
      // The runner holds the conversation's lock, so it never waits for the company lock: it
      // tries the step again shortly, with nothing sent.
      const before = Date.now();
      expect(await advanceAutomationRun(runnerDeps(), scopeOf(c), locked, null)).toEqual({
        outcome: 'not_due',
        steps: 0,
      });
      const waiting = await storeRun(locked);
      expect(waiting.status).toBe('running');
      expect(waiting.next_step_at!.getTime()).toBeGreaterThanOrEqual(before + 1_500);
      expect(
        await fx.query('SELECT 1 FROM app.messages WHERE conversation_id = $1', [
          waiting.conversation_id,
        ]),
      ).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(await driveRun(c, locked, later(3_000))).toBe('completed');
    expect(bodyTexts(templatesTo('919812372004')[0])).toEqual(['Asha K']);

    // The company's cap: one marketing template per contact per week.
    await fx.query(
      `INSERT INTO app.messaging_settings
         (tenant_id, opt_out_keywords, marketing_opt_out_keywords, opt_in_keywords,
          marketing_cap_count, marketing_cap_days)
       VALUES ($1, ARRAY['stop'], ARRAY[]::text[], ARRAY['start'], 1, 7)
       ON CONFLICT (tenant_id) DO UPDATE SET marketing_cap_count = 1, marketing_cap_days = 7`,
      [c.tenant.id],
    );
    const capped = await startRun('7205', '+919812372004');
    expect(await driveRun(c, capped)).toBe('failed');
    expect((await storeRun(capped)).end_detail).toBe('frequency_capped');

    // The template gained a variable at Meta after the step was set up: nothing is sent.
    await marketingOptIn(owner, '+919812372008');
    await fx.query(
      `UPDATE app.message_templates SET components = (
         SELECT jsonb_agg(CASE WHEN x->>'type' = 'BODY'
                               THEN jsonb_set(x, '{text}', '"Thanks {{1}}! {{2}} off your next order."')
                               ELSE x END)
           FROM jsonb_array_elements(components) x)
        WHERE id = $1`,
      [promo.id],
    );
    const moreVariables = await startRun('7208', '+919812372008');
    expect(await driveRun(c, moreVariables)).toBe('failed');
    expect((await storeRun(moreVariables)).end_detail).toBe('template_changed');

    // A conversation resolved after the run started stops the run.
    await fx.query(`UPDATE app.message_templates SET status = 'approved' WHERE id = $1`, [
      confirmTemplate.id,
    ]);
    const latest = await svc.getAutomation(owner, flow.id);
    const back = await svc.updateAutomation(owner, {
      id: flow.id,
      expectedVersion: latest.version,
      name: 'Order follow-up',
      description: null,
      channelAccountId: null,
      trigger: storeEvent,
      graph: orderFlow(confirmTemplate.id, {
        buttons: [
          { index: 0, title: 'Where is it?', next: 'track' },
          { index: 2, title: 'Talk to us', next: 'people' },
        ],
      }),
    });
    await svc.publishAutomation(owner, { id: flow.id, expectedVersion: back.version, note: null });
    const closedLater = await startRun('7206', '+919812372006');
    const startedRun = await storeRun(closedLater);
    await fx.query(
      `UPDATE app.conversations SET resolved_at = now() + interval '1 minute' WHERE id = $1`,
      [startedRun.conversation_id],
    );
    expect(await driveRun(c, closedLater)).toBe('stopped');
    expect(await storeRun(closedLater)).toMatchObject({ end_reason: 'conversation_resolved' });

    // An order deleted before the step runs leaves its placeholders empty: nothing is sent.
    const gone = await startRun('7207', '+919812372007');
    await fx.query(
      `UPDATE app.commerce_store_orders SET deleted_at = now() WHERE store_id = $1 AND external_id = '7207'`,
      [storeId],
    );
    expect(await driveRun(c, gone)).toBe('failed');
    expect(await storeRun(gone)).toMatchObject({
      end_reason: 'error',
      end_detail: 'missing_variable',
    });
  });

  it('checks the automation a rule starts, tests with a chosen order, clears references with the order and the run, and keeps companies apart', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { shop, storeId } = await shopifyStoreForMessages(c, owner);
    await optIn(owner, storeId);
    const template = await approvedTemplate(c, owner, orderConfirmed);
    const svc = automationService();

    // Only an active automation whose live version starts from order messages can be chosen.
    const keyword = await publishAutomation(
      owner,
      'Keyword bot',
      { type: 'keyword', keywords: ['hi'], match: 'contains', hours: 'any', cooldownMinutes: 0 },
      { version: 1, start: 'bye', nodes: [{ id: 'bye', type: 'end' }] },
    );
    await expectAppError(
      automationRule(owner, c, storeId, 'order_placed', keyword.id),
      'validation_failed',
      /does not start from order messages/,
    );
    const flow = await publishAutomation(
      owner,
      'Order follow-up',
      storeEvent,
      orderFlow(template.id),
    );
    const detail = await svc.getAutomation(owner, flow.id);
    await svc.setAutomationStatus(owner, {
      id: flow.id,
      expectedVersion: detail.version,
      status: 'paused',
    });
    await expectAppError(
      automationRule(owner, c, storeId, 'order_placed', flow.id),
      'validation_failed',
      /keep it active/,
    );
    // Switched off, a paused automation can be kept on the rule.
    await automationRule(owner, c, storeId, 'order_placed', flow.id, { enabled: false });
    await svc.setAutomationStatus(owner, {
      id: flow.id,
      expectedVersion: detail.version + 1,
      status: 'active',
    });
    // Switched off, a rule may name a draft that was never published; deleting the draft clears
    // the reference. A rule that sends its template keeps no automation.
    const shippedRule = () =>
      fx.query(
        `SELECT action, automation_id FROM app.commerce_store_message_rules
          WHERE store_id = $1 AND event = 'order_shipped'`,
        [storeId],
      );
    const { id: draftId } = await svc.createAutomation(owner, { name: 'Shipping draft' });
    await automationRule(owner, c, storeId, 'order_shipped', draftId, { enabled: false });
    expect(await shippedRule()).toEqual([{ action: 'automation', automation_id: draftId }]);
    await svc.deleteAutomation(owner, { id: draftId, expectedVersion: 0 });
    expect(await shippedRule()).toEqual([{ action: 'automation', automation_id: null }]);
    await automationRule(owner, c, storeId, 'order_shipped', flow.id, {
      enabled: false,
      action: 'template',
    });
    expect(await shippedRule()).toEqual([{ action: 'template', automation_id: null }]);
    // Choosing an automation needs to see automations; a marketing template in it, to send them.
    await expectAppError(
      automationRule(without(owner, 'automations.read'), c, storeId, 'order_placed', flow.id),
      'forbidden',
      /see automations/,
    );
    await fx.query(`UPDATE app.message_templates SET category = 'MARKETING' WHERE id = $1`, [
      template.id,
    ]);
    await expectAppError(
      automationRule(without(owner, 'campaigns.send'), c, storeId, 'order_placed', flow.id),
      'forbidden',
      /marketing templates/,
    );
    await fx.query(`UPDATE app.message_templates SET category = 'UTILITY' WHERE id = $1`, [
      template.id,
    ]);
    await automationRule(owner, c, storeId, 'order_placed', flow.id);

    // Another company's automation cannot be chosen, and its pages show nothing of this one.
    const other = await fx.company();
    const otherOwner = await fx.ctx(other, other.owner);
    const otherStore = await shopifyStoreForMessages(other, otherOwner, 'Other Tea');
    await optIn(otherOwner, otherStore.storeId);
    await expectAppError(
      automationRule(otherOwner, other, otherStore.storeId, 'order_placed', flow.id, {
        enabled: false,
      }),
      'validation_failed',
      /Choose an automation/,
    );
    expect(
      (await storeMessages().storeMessages(otherOwner, otherStore.storeId)).automations,
    ).toEqual([]);

    // A test run with a chosen order, on the tester's own conversation (inside its window).
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: '919812373000', text: 'test' }] }));
    const [testConv] = await fx.query<{ id: string }>(
      `SELECT cv.id FROM app.conversations cv
         JOIN app.contact_identities i ON i.tenant_id = cv.tenant_id AND i.contact_id = cv.contact_id
        WHERE cv.tenant_id = $1 AND i.wa_id = '919812373000'`,
      [c.tenant.id],
    );
    await placeOrder(c, shop, storeId, '7301', '+919812373001');
    const [order] = await fx.query<{ id: string }>(
      `SELECT id FROM app.commerce_store_orders WHERE store_id = $1 AND external_id = '7301'`,
      [storeId],
    );
    expect(await svc.testOrderOptions(owner)).toEqual(
      expect.arrayContaining([{ id: order!.id, label: '#7301 · Tara Tea' }]),
    );
    const current = await svc.getAutomation(owner, flow.id);
    await expectAppError(
      svc.startTestRun(owner, {
        id: flow.id,
        expectedVersion: current.version,
        conversationId: testConv!.id,
      }),
      'validation_failed',
      /Choose an order/,
    );
    await fx.query(`UPDATE app.message_templates SET category = 'MARKETING' WHERE id = $1`, [
      template.id,
    ]);
    await expectAppError(
      svc.startTestRun(without(owner, 'campaigns.send'), {
        id: flow.id,
        expectedVersion: current.version,
        conversationId: testConv!.id,
        storeOrderId: order!.id,
      }),
      'forbidden',
      /marketing templates/,
    );
    await fx.query(`UPDATE app.message_templates SET category = 'UTILITY' WHERE id = $1`, [
      template.id,
    ]);
    // The steps send the order's customer details, which only members who see store orders may.
    expect(await svc.testOrderOptions(without(owner, 'contacts.read'))).toEqual([]);
    await expectAppError(
      svc.startTestRun(without(owner, 'contacts.read'), {
        id: flow.id,
        expectedVersion: current.version,
        conversationId: testConv!.id,
        storeOrderId: order!.id,
      }),
      'forbidden',
    );
    const { runId: testRun } = await svc.startTestRun(owner, {
      id: flow.id,
      expectedVersion: current.version,
      conversationId: testConv!.id,
      storeOrderId: order!.id,
    });
    expect(await driveRun(c, testRun)).toBe('waiting');
    expect(
      await fx.query(
        'SELECT mode, trigger_type, store_order_id, store_event FROM app.automation_runs WHERE id = $1',
        [testRun],
      ),
    ).toEqual([
      { mode: 'test', trigger_type: 'test', store_order_id: order!.id, store_event: null },
    ]);
    expect(bodyTexts(templatesTo('919812373000')[0])).toEqual(['Asha K', '#7301', 'Tara Tea']);

    // The order's own run: retention deletes it later, and the store message keeps its state.
    const [started] = await runMessages(c, storeId);
    const runId = (started as { runId: string }).runId;
    await svc.stopRun(owner, runId);
    const client = await fx.dbs.adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('w360.allow_retention_purge', 'on', true)`);
      await client.query(
        `UPDATE app.automation_runs SET started_at = started_at - interval '200 days',
                ended_at = ended_at - interval '200 days' WHERE id = $1`,
        [runId],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await applyAutomationRetention(fx.dbs.app);
    expect(await fx.query('SELECT 1 FROM app.automation_runs WHERE id = $1', [runId])).toEqual([]);
    expect(
      await fx.query(
        `SELECT state, automation_run_id FROM app.commerce_store_messages WHERE order_id = $1`,
        [order!.id],
      ),
    ).toEqual([{ state: 'started', automation_run_id: null }]);

    // Removing the store deletes its orders; the test run stays, without its order.
    await service().removeStore(owner, storeId);
    await drain(c, storeId);
    expect(await storeRow(storeId)).toBeUndefined();
    expect(
      await fx.query('SELECT status, store_order_id FROM app.automation_runs WHERE id = $1', [
        testRun,
      ]),
    ).toEqual([{ status: 'waiting', store_order_id: null }]);
  });

  it('follows up with a template once the service window has closed, in an automation a keyword starts', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const template = await approvedTemplate(c, owner, {
      category: 'UTILITY',
      header: { type: 'none' },
      body: { text: 'Hi {{1}}, your plan is ready. Reply to see it.', examples: ['Asha'] },
      footer: null,
      buttons: [],
    });
    // A drip follow-up: an answer now, and a template a day later (templates need no window).
    const flow = await publishAutomation(
      owner,
      'Plan follow-up',
      { type: 'keyword', keywords: ['plan'], match: 'contains', hours: 'any', cooldownMinutes: 0 },
      {
        version: 1,
        start: 'hello',
        nodes: [
          { id: 'hello', type: 'send_text', text: 'Your plan comes tomorrow.', next: 'day' },
          { id: 'day', type: 'wait', minutes: 1440, next: 'plan' },
          {
            id: 'plan',
            type: 'send_template',
            templateId: template.id,
            header: [],
            body: ['{{name}}'],
            next: null,
          },
        ],
      },
    );
    expect(flow.issues).toEqual([]);
    await fx.deliver(
      fx.messagesBody(c, { messages: [{ waId: '919812374000', text: 'my plan please' }] }),
    );
    const [run] = await fx.query<{ id: string }>(
      'SELECT id FROM app.automation_runs WHERE tenant_id = $1 AND automation_id = $2',
      [c.tenant.id, flow.id],
    );
    expect(await driveRun(c, run!.id)).toBe('waiting');
    // Only the text went out (the stand-in records every message to the number).
    expect(templatesTo('919812374000').filter(Boolean)).toEqual([]);

    // 25 hours later the customer has not written again: the window is closed, the template goes.
    expect(await driveRun(c, run!.id, later(25 * 3600_000))).toBe('completed');
    const sent = templatesTo('919812374000').filter(Boolean);
    expect(sent.map((t) => t.name)).toEqual([template.name]);
    expect(bodyTexts(sent[0])).toEqual(['Priya Customer']);
    expect(
      await fx.query<{ sender_type: string; type: string }>(
        `SELECT sender_type, type FROM app.messages
          WHERE tenant_id = $1 AND conversation_id = (
            SELECT conversation_id FROM app.automation_runs WHERE id = $2)
            AND direction = 'outbound' ORDER BY created_at, id`,
        [c.tenant.id, run!.id],
      ),
    ).toEqual([
      { sender_type: 'bot', type: 'text' },
      { sender_type: 'bot', type: 'template' },
    ]);
  });
});

let planCodes = 0;

/** Puts the company on a published plan with the given terms (P5-01), as platform staff would. */
async function onPlan(c: Company, overrides: Record<string, unknown>) {
  const staff = await createUser(fx.dbs, { twoFactor: true });
  await fx.dbs.ownerPool.query(
    `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_owner')`,
    [staff.id],
  );
  const actor: PlatformActor = {
    userId: staff.id,
    role: 'platform_owner',
    correlationId: uuidv7(),
  };
  const plans = createPlanAdminService({ platformDb: fx.dbs.platform, clock: systemClock });
  const { id } = await plans.createPlan(actor, {
    code: `st-${Date.now().toString(36)}-${(planCodes += 1)}`,
    name: 'Store plan',
    price: '999',
    intervalMonths: '1',
    trialDays: '0',
    graceDays: '7',
    seatsIncluded: '10',
    numbersIncluded: '5',
    modules: ['automations', 'flows', 'crm', 'commerce'],
    ...overrides,
  });
  await plans.publishPlan(actor, id);
  const view = await plans.tenantPlan(actor, c.tenant.id);
  await plans.setTenantPlan(actor, {
    tenantId: c.tenant.id,
    version: view.state.version,
    status: 'active',
    planId: id,
    periodStart: dayOf(new Date(), 'Asia/Kolkata'),
    periodEnd: dayOf(new Date(Date.now() + 30 * 86_400_000), 'Asia/Kolkata'),
    reason: 'Plan for the store tests',
  });
}

describe('Plans and store work', () => {
  it('skips order messages when the plan leaves out commerce, and the store keeps syncing', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { shop, storeId } = await shopifyStoreForMessages(c, owner);
    const template = await approvedTemplate(c, owner, orderUpdate);
    await optIn(owner, storeId);
    await saveRule(owner, c, storeId, 'order_placed', {
      templateId: template.id,
      variables: update({ source: 'static', value: 'we received it' }),
    });
    await onPlan(c, { modules: ['automations'] });
    await placeOrder(c, shop, storeId, '9501', '+919812379501');
    expect((await orderRows(storeId)).map((o) => o.external_id)).toContain('9501');
    expect(await runMessages(c, storeId)).toEqual([{ outcome: 'skipped', reason: 'not_in_plan' }]);
    expect(templatesTo('919812379501')).toEqual([]);
  });

  it('starts store-event automations only within the month’s runs and with automations in the plan', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { shop, storeId } = await shopifyStoreForMessages(c, owner);
    await optIn(owner, storeId);
    const template = await approvedTemplate(c, owner, orderConfirmed);
    const flow = await publishAutomation(
      owner,
      'Order follow-up',
      storeEvent,
      orderFlow(template.id),
    );
    await automationRule(owner, c, storeId, 'order_placed', flow.id);
    await onPlan(c, { automationRunsMonthly: '1' });

    await placeOrder(c, shop, storeId, '9601', '+919812379601');
    expect(await runMessages(c, storeId)).toEqual([
      expect.objectContaining({ outcome: 'started' }),
    ]);
    await placeOrder(c, shop, storeId, '9602', '+919812379602');
    expect(await runMessages(c, storeId)).toEqual([
      { outcome: 'skipped', reason: 'automation_quota' },
    ]);
    await onPlan(c, { modules: ['commerce'] });
    await placeOrder(c, shop, storeId, '9603', '+919812379603');
    expect(await runMessages(c, storeId)).toEqual([{ outcome: 'skipped', reason: 'not_in_plan' }]);
  });
});
