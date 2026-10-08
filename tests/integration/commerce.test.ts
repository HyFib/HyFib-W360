import { createHmac, randomInt } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, sha256Hex, systemClock, uuidv7, type Clock } from '@w360/core';
import { authorizedTenantScope, sql } from '@w360/db';
import {
  ORDER_CSV_COLUMNS,
  apiCancelOrderPayment,
  apiListOrderPaymentLinks,
  apiRequestOrderPayment,
  authenticateApiToken,
  createApiKeysService,
  createCommerceService,
  createContactsService,
  createPlanAdminService,
  createWebhooksService,
  dayOf,
  findDueCommerceWork,
  giveUpCommerceSync,
  handlePaymentWebhook,
  processCommerceSync,
  processPaymentAccountCheck,
  processPaymentLink,
  processSendIntent,
  queueDailyCommerceSync,
  type ApiOrder,
  type ApiScope,
  type CatalogSyncDeps,
  type PlatformActor,
  type TenantContext,
} from '@w360/domain';
import { startRazorpayStandIn, type RazorpayStandIn } from '../support/razorpay-stand-in';
import { acceptInvitation, createUser, invite, type TestUser } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Commerce against real PostgreSQL and the test-only Graph and Razorpay stand-ins: catalogs read from
 * Meta, product messages, orders from the cart with exact amounts, Payment Links written ahead and
 * created once in the company's own Razorpay account (including a lost create response), payments
 * recorded only from links fetched from Razorpay (a webhook body is never trusted), cancellation,
 * expiry, erasure and isolation.
 */

let fx: WhatsAppFixture;
let rzp: RazorpayStandIn;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  rzp = await startRazorpayStandIn({
    keyId: 'rzp_test_platform0001',
    keySecret: 'platform-secret',
  });
});
afterAll(async () => {
  await rzp?.close();
  await fx?.close();
});
// A test that stops early must not leave Meta refusing catalog reads for the next one.
afterEach(() => {
  if (fx) fx.standIn.state.catalogError = null;
  if (rzp) rzp.state.omitShortUrl = false;
});

const APP_BASE = 'https://app.example.test';
const rate = { capacity: 1000, refillPerSecond: 1000 };
const waId = () => `91${randomInt(7_000_000_000, 9_999_999_999)}`;
const later = (ms: number): Clock => ({ now: () => new Date(Date.now() + ms) });

const service = (clock: Clock = systemClock, allowLiveKeys = false) =>
  createCommerceService({
    db: fx.dbs.app,
    clock,
    jobs: fx.jobs(),
    signer: fx.signer,
    keyring: fx.keyring,
    appBaseUrl: APP_BASE,
    allowLiveKeys,
  });
const workerDeps = (clock: Clock = systemClock): CatalogSyncDeps => ({
  db: fx.dbs.app,
  keyring: fx.keyring,
  graph: fx.graph,
  clock,
  razorpayBaseUrl: rzp.baseUrl,
  jobs: fx.jobs(),
  signer: fx.signer,
});
const scopeOf = (c: Company) => authorizedTenantScope(c.tenant.id, null);
const webhookDeps = () => ({
  db: fx.dbs.app,
  keyring: fx.keyring,
  clock: systemClock,
  jobs: fx.jobs(),
  signer: fx.signer,
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
    return error;
  }
  throw new Error(`expected ${code}`);
}

async function member(c: Company, role: string): Promise<TestUser> {
  const user = await createUser(fx.dbs, { name: `A ${role}` });
  const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, [role]);
  await acceptInvitation(fx.dbs, user, token);
  return user;
}

/** A catalog connected to the company's WABA at the stand-in, with products sku-1 … sku-n. */
function connectCatalog(c: Company, catalogId: string, count: number) {
  fx.standIn.state.catalogs.set(c.wabaId, [
    { id: catalogId, name: 'Main catalog', product_count: count },
  ]);
  fx.standIn.state.catalogProducts.set(
    catalogId,
    Array.from({ length: count }, (_, i) => ({
      id: String(900_000 + i),
      retailer_id: `sku-${i + 1}`,
      name: `Product ${String(i + 1).padStart(3, '0')}`,
      price: `₹${(i + 1) * 10}.00`,
      currency: 'INR',
      availability: 'in stock',
      review_status: 'approved',
    })),
  );
}

async function syncedCatalog(c: Company, owner: TenantContext, catalogId: string, count: number) {
  connectCatalog(c, catalogId, count);
  await service().requestSync(owner, { whatsappAccountId: c.whatsappAccountId });
  expect(await processCommerceSync(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
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

function orderMessage(
  c: Company,
  from: string,
  catalogId: string,
  items: { retailerId: string; quantity: number; price: number; currency?: string }[],
  text = '',
  id?: string,
) {
  return fx.messagesBody(c, {
    messages: [
      {
        ...(id ? { id } : {}),
        waId: from,
        type: 'order',
        extra: {
          order: {
            catalog_id: catalogId,
            text,
            product_items: items.map((i) => ({
              product_retailer_id: i.retailerId,
              quantity: i.quantity,
              item_price: i.price,
              currency: i.currency ?? 'INR',
            })),
          },
        },
      },
    ],
  });
}

async function orderOf(messageConversation: string) {
  const [row] = await fx.query<Record<string, unknown>>(
    `SELECT * FROM app.commerce_orders WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [messageConversation],
  );
  return row!;
}

async function sendQueued(c: Company, conversationId: string) {
  const intents = await fx.query<{ id: string; actor_user_id: string | null }>(
    `SELECT s.id, s.actor_user_id FROM app.send_intents s
       JOIN app.messages m ON m.tenant_id = s.tenant_id AND m.id = s.message_id
      WHERE m.conversation_id = $1 AND s.state = 'queued' ORDER BY s.created_at`,
    [conversationId],
  );
  const outcomes = [];
  for (const intent of intents) {
    const result = await processSendIntent(
      {
        db: fx.dbs.app,
        keyring: fx.keyring,
        graph: fx.graph,
        clock: systemClock,
        rate,
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

let merchantCounter = 0;
/** A verified Razorpay account of the company (keys known to the Razorpay stand-in). */
async function paymentAccount(c: Company, owner: TenantContext) {
  merchantCounter += 1;
  const keyId = `rzp_test_merchant${String(merchantCounter).padStart(4, '0')}`;
  const keySecret = `merchant-secret-${merchantCounter}`;
  const webhookSecret = `webhook-secret-${merchantCounter}`;
  rzp.addMerchant(keyId, keySecret);
  await service().savePaymentAccount(owner, { keyId, keySecret, webhookSecret });
  const [account] = await fx.query<{ id: string; webhook_public_id: string }>(
    `SELECT id, webhook_public_id FROM app.commerce_payment_accounts WHERE tenant_id = $1`,
    [c.tenant.id],
  );
  expect(await processPaymentAccountCheck(workerDeps(), scopeOf(c), account!.id)).toBe('done');
  return { keyId, keySecret, webhookSecret, publicId: account!.webhook_public_id };
}

/** A key of the company with these scopes, as a request authenticates it. */
async function apiKeyOf(company: Company, scopes: ApiScope[]) {
  const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
    await fx.ctx(company, company.owner),
    { name: `Shop ${scopes.join(' ')}`, scopes, expiresInDays: 0 },
  );
  const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
  if (!key) throw new Error('a new key does not authenticate');
  return key;
}

let planCodes = 0;
/** Puts the company on a new published plan with these modules, as platform owners do. */
async function onPlan(c: Company, modules: string[]) {
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
  planCodes += 1;
  const { id } = await plans.createPlan(actor, {
    code: `shop-pay-${Date.now().toString(36)}-${planCodes}`,
    name: 'Shop plan',
    price: '999',
    intervalMonths: '1',
    trialDays: '0',
    graceDays: '7',
    seatsIncluded: '10',
    numbersIncluded: '5',
    modules,
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
    reason: 'Plan for the API payment request tests',
  });
}

function signedEvent(secret: string, event: string, linkId: string) {
  const rawBody = Buffer.from(
    JSON.stringify({
      entity: 'event',
      event,
      contains: ['payment_link'],
      // The body claims whatever it likes; HyFib only uses the link id to know what to fetch.
      payload: { payment_link: { entity: { id: linkId, status: 'paid', amount_paid: 999_999 } } },
    }),
  );
  return { rawBody, signature: createHmac('sha256', secret).update(rawBody).digest('hex') };
}

async function linkRow(orderId: string) {
  const [row] = await fx.query<Record<string, unknown>>(
    `SELECT * FROM app.commerce_payment_links WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [orderId],
  );
  return row!;
}

describe('catalogs', () => {
  it('reads catalogs and products from Meta, pages through them and reports refusals', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const svc = service();
    await expectAppError(
      svc.requestSync(agent, { whatsappAccountId: c.whatsappAccountId }),
      'forbidden',
    );
    // 150 products: two pages of the products edge.
    await syncedCatalog(c, owner, '5550001', 150);
    const [overview] = await svc.catalogs(owner);
    expect(overview).toMatchObject({
      id: c.whatsappAccountId,
      sync: { state: 'idle', error: null },
      catalogs: [
        {
          metaCatalogId: '5550001',
          name: 'Main catalog',
          productCount: 150,
          listed: 150,
          truncated: false,
        },
      ],
    });
    const catalogId = overview!.catalogs[0]!.id;
    // Search by name or retailer id: "Product 010" to "Product 019".
    const page = await svc.products(owner, catalogId, { q: 'product 01' });
    expect(page.products.map((p) => p.retailerId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `sku-${10 + i}`),
    );
    expect(page.products.every((p) => p.priceText?.startsWith('₹'))).toBe(true);
    const all = await svc.products(owner, catalogId, { page: 2 });
    expect(all.products).toHaveLength(50);
    expect(all.hasMore).toBe(false);

    // A product Meta no longer lists is marked removed, and comes back when it is listed again.
    fx.standIn.state.catalogProducts.set(
      '5550001',
      fx.standIn.state.catalogProducts.get('5550001')!.slice(1),
    );
    await svc.requestSync(owner, { whatsappAccountId: c.whatsappAccountId });
    expect(await processCommerceSync(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
    const [removed] = await fx.query<{ removed_at: Date | null }>(
      `SELECT removed_at FROM app.commerce_products WHERE tenant_id = $1 AND retailer_id = 'sku-1'`,
      [c.tenant.id],
    );
    expect(removed!.removed_at).not.toBeNull();

    // A missing permission is reported in plain words; a catalog that is no longer connected is marked.
    fx.standIn.state.catalogError = { status: 403, code: 10, message: '(#10) Permission denied' };
    await svc.requestSync(owner, { whatsappAccountId: c.whatsappAccountId });
    expect(await processCommerceSync(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
    expect((await svc.catalogs(owner))[0]!.sync).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/catalog_management/),
    });
    fx.standIn.state.catalogError = null;
    fx.standIn.state.catalogs.set(c.wabaId, []);
    await svc.requestSync(owner, { whatsappAccountId: c.whatsappAccountId });
    expect(await processCommerceSync(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
    expect((await svc.catalogs(owner))[0]!.catalogs[0]!.disconnectedAt).not.toBeNull();

    // A read left waiting fails after 30 minutes; an idle read is queued again after a day.
    await svc.requestSync(owner, { whatsappAccountId: c.whatsappAccountId });
    await giveUpCommerceSync(
      { db: fx.dbs.app, clock: later(31 * 60_000) },
      scopeOf(c),
      c.whatsappAccountId,
    );
    expect((await svc.catalogs(owner))[0]!.sync.state).toBe('failed');
    await svc.requestSync(owner, { whatsappAccountId: c.whatsappAccountId });
    expect(await processCommerceSync(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
    expect(
      await queueDailyCommerceSync(
        { db: fx.dbs.app, clock: later(25 * 3_600_000) },
        scopeOf(c),
        c.whatsappAccountId,
      ),
    ).toBe(true);
    expect(
      await queueDailyCommerceSync(
        { db: fx.dbs.app, clock: systemClock },
        scopeOf(c),
        c.whatsappAccountId,
      ),
    ).toBe(false);
  });
});

describe('product messages', () => {
  it('sends single, multi-product and catalog messages in the service window', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await syncedCatalog(c, owner, '5550002', 40);
    const svc = service();
    const priya = waId();
    await fx.deliver(
      fx.messagesBody(c, { messages: [{ waId: priya, text: 'What do you sell?' }] }),
    );
    const conv = await conversationOf(c, priya);
    const products = await svc.sendableProducts(agent, conv.id);
    expect(products).toHaveLength(40);
    const byRetailer = new Map(products.map((p) => [p.retailerId, p.id]));

    const single = await svc.sendProducts(agent, {
      conversationId: conv.id,
      clientKey: 'products-single-01',
      message: {
        kind: 'product',
        productId: byRetailer.get('sku-3'),
        body: 'Our best seller',
        footer: '',
      },
    });
    const [intent] = await fx.query<{ request: Record<string, unknown> }>(
      `SELECT request FROM app.send_intents WHERE message_id = $1`,
      [single.messageId],
    );
    expect(intent!.request).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: priya,
      type: 'interactive',
      interactive: {
        type: 'product',
        body: { text: 'Our best seller' },
        action: { catalog_id: '5550002', product_retailer_id: 'sku-3' },
      },
    });
    // The same submit sends nothing twice.
    expect(
      (
        await svc.sendProducts(agent, {
          conversationId: conv.id,
          clientKey: 'products-single-01',
          message: { kind: 'product', productId: byRetailer.get('sku-3'), body: '', footer: '' },
        })
      ).duplicate,
    ).toBe(true);
    await svc.sendProducts(agent, {
      conversationId: conv.id,
      clientKey: 'products-list-001',
      message: {
        kind: 'product_list',
        header: 'Summer picks',
        body: 'Tap to see them',
        footer: 'Free delivery',
        sections: [
          { title: 'Shirts', productIds: [byRetailer.get('sku-1'), byRetailer.get('sku-2')] },
          { title: 'Hats', productIds: [byRetailer.get('sku-4')] },
        ],
      },
    });
    await svc.sendProducts(agent, {
      conversationId: conv.id,
      clientKey: 'products-catalog-1',
      message: {
        kind: 'catalog',
        thumbnailProductId: byRetailer.get('sku-5'),
        body: 'Browse our catalog',
        footer: '',
      },
    });
    // The Graph stand-in checks every message against its catalog (research M-169).
    expect(await sendQueued(c, conv.id)).toEqual(['accepted', 'accepted', 'accepted']);

    // Refusals: too many products, a product of another company, a closed window, no reply permission.
    await expectAppError(
      svc.sendProducts(agent, {
        conversationId: conv.id,
        clientKey: 'products-too-many',
        message: {
          kind: 'product_list',
          header: 'All',
          body: 'Everything',
          footer: '',
          sections: [
            { title: 'A', productIds: products.slice(0, 20).map((p) => p.id) },
            { title: 'B', productIds: products.slice(20, 31).map((p) => p.id) },
          ],
        },
      }),
      'validation_failed',
      /at most 30 products/,
    );
    const other = await fx.company();
    await syncedCatalog(other, await fx.ctx(other, other.owner), '5550003', 2);
    const [foreign] = await fx.query<{ id: string }>(
      `SELECT id FROM app.commerce_products WHERE tenant_id = $1 LIMIT 1`,
      [other.tenant.id],
    );
    await expectAppError(
      svc.sendProducts(agent, {
        conversationId: conv.id,
        clientKey: 'products-foreign-1',
        message: { kind: 'product', productId: foreign!.id, body: '', footer: '' },
      }),
      'validation_failed',
      /catalog of this WhatsApp number/,
    );
    await expectAppError(
      service(later(25 * 3_600_000)).sendProducts(agent, {
        conversationId: conv.id,
        clientKey: 'products-late-0001',
        message: { kind: 'product', productId: byRetailer.get('sku-3'), body: '', footer: '' },
      }),
      'precondition_failed',
      /window has closed/,
    );
    const analyst = await fx.ctx(c, await member(c, 'analyst'));
    await expectAppError(
      svc.sendProducts(analyst, {
        conversationId: conv.id,
        clientKey: 'products-analyst-1',
        message: { kind: 'product', productId: byRetailer.get('sku-3'), body: '', footer: '' },
      }),
      'forbidden',
    );
  });
});

describe('orders', () => {
  it('records carts with exact amounts, product names and statuses members can change', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await syncedCatalog(c, owner, '5550004', 5);
    const svc = service();
    const asha = waId();
    const body = orderMessage(c, asha, '5550004', [
      { retailerId: 'sku-1', quantity: 2, price: 19.99 },
      { retailerId: 'sku-2', quantity: 1, price: 250 },
      { retailerId: 'unknown-sku', quantity: 1, price: 0.1 },
    ]);
    await fx.deliver(body);
    // A redelivered webhook records nothing twice.
    await fx.deliver(body);
    const conv = await conversationOf(c, asha);
    const order = await orderOf(conv.id);
    expect(order).toMatchObject({
      currency: 'INR',
      subtotal_minor: '29008',
      item_count: 3,
      status: 'received',
    });
    const count = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.commerce_orders WHERE conversation_id = $1`,
      [conv.id],
    );
    expect(count[0]!.n).toBe(1);
    const detail = await svc.order(owner, order.id as string);
    expect(detail.items).toEqual([
      {
        position: 1,
        retailerId: 'sku-1',
        name: 'Product 001',
        quantity: 2,
        unitPriceMinor: 1999,
        currency: 'INR',
      },
      {
        position: 2,
        retailerId: 'sku-2',
        name: 'Product 002',
        quantity: 1,
        unitPriceMinor: 25000,
        currency: 'INR',
      },
      {
        position: 3,
        retailerId: 'unknown-sku',
        name: null,
        quantity: 1,
        unitPriceMinor: 10,
        currency: 'INR',
      },
    ]);
    const [message] = await fx.query<{ preview: string }>(
      `SELECT last_message_preview AS preview FROM app.conversations WHERE id = $1`,
      [conv.id],
    );
    expect(message!.preview).toBe('[Order] 4 items · ₹290.08');

    // Prices that do not fit the currency, or items in different currencies, leave the total unknown.
    const ravi = waId();
    await fx.deliver(
      orderMessage(c, ravi, '5550004', [{ retailerId: 'sku-1', quantity: 1, price: 19.999 }]),
    );
    expect(await orderOf((await conversationOf(c, ravi)).id)).toMatchObject({
      subtotal_minor: null,
      currency: 'INR',
    });
    const meera = waId();
    await fx.deliver(
      orderMessage(c, meera, '5550004', [
        { retailerId: 'sku-1', quantity: 1, price: 10 },
        { retailerId: 'sku-2', quantity: 1, price: 10, currency: 'USD' },
      ]),
    );
    expect(await orderOf((await conversationOf(c, meera)).id)).toMatchObject({
      subtotal_minor: null,
      currency: null,
    });
    // Payment needs the company's own Razorpay account, and a total HyFib could work out.
    await expectAppError(
      svc.requestPayment(agent, { id: order.id, expectedVersion: order.version as number }),
      'precondition_failed',
      /Add your Razorpay account/,
    );
    const unknownTotal = await orderOf((await conversationOf(c, ravi)).id);
    await expectAppError(
      svc.requestPayment(agent, {
        id: unknownTotal.id,
        expectedVersion: unknownTotal.version as number,
      }),
      'precondition_failed',
      /total could not be worked out/,
    );

    // Statuses: members move orders along; payment statuses are not theirs to set.
    let version = order.version as number;
    ({ version } = await svc.setOrderStatus(agent, {
      id: order.id,
      expectedVersion: version,
      status: 'confirmed',
    }));
    await expectAppError(
      svc.setOrderStatus(agent, {
        id: order.id,
        expectedVersion: version - 1,
        status: 'fulfilled',
      }),
      'conflict',
      /Someone else changed/,
    );
    await expectAppError(
      svc.setOrderStatus(agent, { id: order.id, expectedVersion: version, status: 'paid' }),
      'validation_failed',
    );
    ({ version } = await svc.setOrderStatus(agent, {
      id: order.id,
      expectedVersion: version,
      status: 'fulfilled',
    }));
    await expectAppError(
      svc.setOrderStatus(agent, { id: order.id, expectedVersion: version, status: 'cancelled' }),
      'conflict',
      /cannot move/,
    );

    // Members see orders of conversations they can see.
    const other = await member(c, 'agent');
    const otherCtx = await fx.ctx(c, other);
    await fx.query(`UPDATE app.conversations SET assigned_membership_id = $1 WHERE id = $2`, [
      owner.membership.id,
      conv.id,
    ]);
    expect((await svc.orders(otherCtx)).orders.map((o) => o.id)).not.toContain(order.id);
    await expectAppError(svc.order(otherCtx, order.id as string), 'not_found');
    expect((await svc.orders(owner)).orders.map((o) => o.id)).toContain(order.id);
    const audit = await fx.query<{ action: string }>(
      `SELECT action FROM app.audit_events WHERE tenant_id = $1 AND action LIKE 'commerce.order%' ORDER BY occurred_at, id`,
      [c.tenant.id],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'commerce.order_status_changed',
      'commerce.order_status_changed',
    ]);

    // A cart with an item HyFib could not read has no total, so it is never charged short.
    const kiran = waId();
    await fx.deliver(
      orderMessage(c, kiran, '5550004', [
        { retailerId: 'sku-1', quantity: 1, price: 10 },
        { retailerId: '', quantity: 1, price: 500 },
      ]),
    );
    const partial = await orderOf((await conversationOf(c, kiran)).id);
    expect(partial).toMatchObject({ dropped_items: 1, subtotal_minor: null, item_count: 1 });
    await expectAppError(
      svc.requestPayment(agent, { id: partial.id, expectedVersion: partial.version as number }),
      'precondition_failed',
      /could not read every item/,
    );
    expect((await svc.order(agent, partial.id as string)).payment).toMatchObject({
      payable: false,
      why: expect.stringMatching(/could not read every item/),
    });
    // Totals above HyFib's cap on one Payment Link are refused before anything is written.
    const tara = waId();
    await fx.deliver(
      orderMessage(c, tara, '5550004', [{ retailerId: 'sku-2', quantity: 1, price: 600_000_000 }]),
    );
    const large = await orderOf((await conversationOf(c, tara)).id);
    expect(large.subtotal_minor).toBe('60000000000');
    await expectAppError(
      svc.requestPayment(agent, { id: large.id, expectedVersion: large.version as number }),
      'precondition_failed',
      /at most ₹50,00,00,000/,
    );
    expect((await svc.order(agent, large.id as string)).payment.why).toMatch(/at most/);
  });

  it('pages through orders received in the same second without skipping any', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await syncedCatalog(c, owner, '5550006', 2);
    const buyer = waId();
    for (let i = 0; i < 53; i += 1) {
      await fx.deliver(
        orderMessage(c, buyer, '5550006', [{ retailerId: 'sku-1', quantity: 1, price: 10 }]),
      );
    }
    // Meta's timestamps have second precision: many orders can share one.
    await fx.query(
      `UPDATE app.commerce_orders SET received_at = '2026-09-01T10:00:00Z' WHERE tenant_id = $1`,
      [c.tenant.id],
    );
    const svc = service();
    const first = await svc.orders(owner);
    expect(first.orders).toHaveLength(50);
    expect(first.older).not.toBeNull();
    const second = await svc.orders(owner, { before: first.older as string });
    expect(second.orders).toHaveLength(3);
    expect(second.older).toBeNull();
    const ids = [...first.orders, ...second.orders].map((o) => o.id);
    expect(new Set(ids).size).toBe(53);
    // A cursor that is not one of ours is ignored rather than trusted.
    expect((await svc.orders(owner, { before: 'not-a-cursor' })).orders).toHaveLength(50);
  });

  it('exports the orders a member can see as CSV, audited, erased contacts blanked (ADR-235)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await syncedCatalog(c, owner, '5550007', 3);
    const svc = service();
    const asha = waId();
    await fx.deliver(
      orderMessage(
        c,
        asha,
        '5550007',
        [
          { retailerId: 'sku-1', quantity: 2, price: 19.99 },
          { retailerId: 'unknown-sku', quantity: 1, price: 0.1 },
        ],
        'Ring the bell',
      ),
    );
    const conv = await conversationOf(c, asha);
    const order = await orderOf(conv.id);
    const read = async (ctx: TenantContext, input: unknown = {}) => {
      let out = '';
      for await (const chunk of svc.exportOrders(ctx, input, { ipAddress: '203.0.113.9' })) {
        out += chunk;
      }
      return out
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n');
    };

    const lines = await read(owner);
    expect(lines[0]).toBe(ORDER_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`${order.id},${order.reference},`);
    expect(lines[1]).toContain(',received,');
    // Two items (as the orders list counts them), none unreadable.
    expect(lines[1]).toContain(
      `,+${asha},2 × Product 001; 1 × unknown-sku,2,0,INR,40.08,Ring the bell`,
    );
    // The list's status filter applies; an unknown status is refused.
    expect(await read(owner, { status: 'confirmed' })).toEqual([ORDER_CSV_COLUMNS.join(',')]);
    await expectAppError(read(owner, { status: 'shipped' }), 'validation_failed');
    // Agents see orders but do not export contacts.
    await expectAppError(read(agent), 'forbidden');
    const audits = await fx.query<{ metadata: { status: string | null } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'commerce.orders_exported' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(audits.map((a) => a.metadata.status)).toEqual([null, 'confirmed']);

    // An erased contact's orders stay, without the customer's name, number or note.
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: conv.contact_id,
      suppress: false,
    });
    const after = await read(owner);
    expect(after[1]).toContain(',Erased contact,,2 × Product 001; 1 × unknown-sku,2,0,INR,40.08,');
    expect(after[1]).not.toContain('Ring the bell');
    expect(after[1]).not.toContain(asha);

    // Another company's export holds none of these orders.
    const other = await fx.company();
    expect(await read(await fx.ctx(other, other.owner))).toEqual([ORDER_CSV_COLUMNS.join(',')]);
  });
});

describe('payment links', () => {
  it('creates one link per request, records payment only from Razorpay, and handles cancel and expiry', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await syncedCatalog(c, owner, '5550005', 3);
    const svc = service();

    // The company's keys: test keys only outside production, checked against Razorpay.
    await expectAppError(
      svc.savePaymentAccount(owner, {
        keyId: 'rzp_live_ABCDEFGH1234',
        keySecret: 'secret-secret',
        webhookSecret: 'hook-secret-1',
      }),
      'validation_failed',
      /production/,
    );
    await expectAppError(
      svc.savePaymentAccount(agent, {
        keyId: 'rzp_test_ABCDEFGH1234',
        keySecret: 'x'.repeat(10),
        webhookSecret: 'y'.repeat(10),
      }),
      'forbidden',
    );
    await svc.savePaymentAccount(owner, {
      keyId: 'rzp_test_UNKNOWNKEY01',
      keySecret: 'not-registered',
      webhookSecret: 'hook-secret-1',
    });
    const [pending] = await fx.query<{ id: string; key_secret_ciphertext: string }>(
      `SELECT id, key_secret_ciphertext FROM app.commerce_payment_accounts WHERE tenant_id = $1`,
      [c.tenant.id],
    );
    expect(pending!.key_secret_ciphertext).not.toContain('not-registered');
    expect(await processPaymentAccountCheck(workerDeps(), scopeOf(c), pending!.id)).toBe('done');
    expect((await svc.paymentAccount(owner)).account).toMatchObject({
      status: 'failed',
      statusError: 'Razorpay rejected the key id or secret.',
      mode: 'test',
    });
    const account = await paymentAccount(c, owner);
    const view = await svc.paymentAccount(owner);
    expect(view.account).toMatchObject({
      status: 'verified',
      keyId: account.keyId,
      webhookUrl: `${APP_BASE}/api/webhooks/razorpay-links/${account.publicId}`,
    });
    expect(JSON.stringify(view)).not.toContain(account.keySecret);
    expect((await svc.paymentAccount(agent)).account).toMatchObject({
      keyId: null,
      webhookUrl: null,
    });

    // An order to pay: ₹289.98.
    const asha = waId();
    await fx.deliver(
      orderMessage(c, asha, '5550005', [
        { retailerId: 'sku-1', quantity: 2, price: 19.99 },
        { retailerId: 'sku-2', quantity: 1, price: 250 },
      ]),
    );
    const conv = await conversationOf(c, asha);
    let order = await orderOf(conv.id);
    const { version } = await svc.requestPayment(agent, {
      id: order.id,
      expectedVersion: order.version,
    });
    await expectAppError(
      svc.requestPayment(agent, { id: order.id, expectedVersion: version }),
      'conflict',
      /received or confirmed/,
    );
    let link = await linkRow(order.id as string);
    expect(link).toMatchObject({ status: 'creating', amount_minor: '28998', currency: 'INR' });
    // Each status records who changed it (ADR-270): here the member who asked for payment.
    expect(await orderOf(conv.id)).toMatchObject({
      status: 'awaiting_payment',
      status_changed_by: 'member',
      status_changed_by_api_key_id: null,
    });

    // The create response is lost: the next attempt finds the link by its reference instead of
    // creating a second one (research R-106, R-107).
    rzp.state.queues.createPaymentLink.push({ kind: 'process_then_drop' });
    expect(await processPaymentLink(workerDeps(), scopeOf(c), link.id as string)).toBe('retry');
    await fx.query(`UPDATE app.commerce_payment_links SET lease_until = NULL WHERE id = $1`, [
      link.id,
    ]);
    expect(await processPaymentLink(workerDeps(), scopeOf(c), link.id as string)).toBe('done');
    const atRazorpay = [...rzp.state.paymentLinks.values()].filter(
      (l) => l.referenceId === link.reference,
    );
    expect(atRazorpay).toHaveLength(1);
    // The retry looked the link up instead of sending the create request again.
    const creates = rzp.state.calls.filter(
      (call) =>
        call.method === 'POST' &&
        call.path === '/v1/payment_links' &&
        (call.body as { reference_id?: unknown } | undefined)?.reference_id === link.reference,
    );
    expect(creates).toHaveLength(1);
    expect(atRazorpay[0]).toMatchObject({
      amount: 28998,
      currency: 'INR',
      notify: { sms: false, email: false },
    });
    link = await linkRow(order.id as string);
    expect(link).toMatchObject({
      status: 'created',
      provider_link_id: atRazorpay[0]!.id,
      short_url: atRazorpay[0]!.shortUrl,
    });
    // The link goes to the customer in the chat.
    const [sent] = await fx.query<{ content: { text: string } }>(
      `SELECT content FROM app.messages WHERE id = $1`,
      [link.message_id],
    );
    expect(sent!.content.text).toBe(
      `Pay ₹289.98 for order ${order.reference as string}: ${atRazorpay[0]!.shortUrl}`,
    );
    expect(await sendQueued(c, conv.id)).toEqual(['accepted']);
    // A check while another job holds the link's lease is tried again later, not dropped.
    await fx.query(
      `UPDATE app.commerce_payment_links SET lease_until = now() + interval '1 minute' WHERE id = $1`,
      [link.id],
    );
    expect(await processPaymentLink(workerDeps(), scopeOf(c), link.id as string)).toBe('retry');
    await fx.query(`UPDATE app.commerce_payment_links SET lease_until = NULL WHERE id = $1`, [
      link.id,
    ]);

    // A signed webhook claiming payment only makes HyFib ask Razorpay, which says it is not paid.
    const deps = webhookDeps();
    const claim = signedEvent(
      account.webhookSecret,
      'payment_link.paid',
      link.provider_link_id as string,
    );
    expect(
      await handlePaymentWebhook(deps, {
        publicId: account.publicId,
        rawBody: claim.rawBody,
        signature: claim.signature,
        eventId: 'evt_claim_0001',
      }),
    ).toMatchObject({ status: 200, log: { outcome: 'check_signalled' } });
    expect(await processPaymentLink(workerDeps(), scopeOf(c), link.id as string)).toBe('done');
    expect((await orderOf(conv.id)).status).toBe('awaiting_payment');
    // Wrong signatures, other companies' secrets and repeated events do nothing.
    expect(
      await handlePaymentWebhook(deps, {
        publicId: account.publicId,
        rawBody: claim.rawBody,
        signature: 'f'.repeat(64),
        eventId: 'evt_forged_001',
      }),
    ).toMatchObject({ status: 400, log: { outcome: 'bad_signature' } });
    expect(
      await handlePaymentWebhook(deps, {
        publicId: account.publicId,
        rawBody: claim.rawBody,
        signature: claim.signature,
        eventId: 'evt_claim_0001',
      }),
    ).toMatchObject({ status: 200, log: { outcome: 'duplicate' } });
    expect(
      await handlePaymentWebhook(deps, {
        publicId: 'aaaaaaaaaaaaaaaa',
        rawBody: claim.rawBody,
        signature: claim.signature,
        eventId: 'evt_other_0001',
      }),
    ).toMatchObject({ status: 404 });

    // An event name holding the NUL character is recorded with U+FFFD in its place (ADR-130): its
    // insert failed before (22021), and Razorpay retried it for days.
    const odd = signedEvent(
      account.webhookSecret,
      'payment_link.pa\u0000id',
      link.provider_link_id as string,
    );
    expect(
      await handlePaymentWebhook(deps, {
        publicId: account.publicId,
        rawBody: odd.rawBody,
        signature: odd.signature,
        eventId: 'evt_nul_000001',
      }),
    ).toMatchObject({ status: 200, log: { outcome: 'ignored' } });
    const [recorded] = await fx.query<{ event: string }>(
      `SELECT event FROM app.commerce_payment_events WHERE tenant_id = $1 AND event_id = $2`,
      [c.tenant.id, 'evt_nul_000001'],
    );
    expect(recorded?.event).toBe('payment_link.pa\uFFFDid');

    // The customer pays: Razorpay's link is paid, and only then is the order.
    rzp.payLink(link.provider_link_id as string);
    const paidEvent = signedEvent(
      account.webhookSecret,
      'payment_link.paid',
      link.provider_link_id as string,
    );
    await handlePaymentWebhook(deps, {
      publicId: account.publicId,
      rawBody: paidEvent.rawBody,
      signature: paidEvent.signature,
      eventId: 'evt_paid_00001',
    });
    expect(await processPaymentLink(workerDeps(), scopeOf(c), link.id as string)).toBe('done');
    order = await orderOf(conv.id);
    expect(order.status).toBe('paid');
    expect(order.paid_at).not.toBeNull();
    expect(order.status_changed_by).toBe('payment_link');
    expect(await linkRow(order.id as string)).toMatchObject({
      status: 'paid',
      amount_paid_minor: '28998',
    });
    // A paid link is final: later jobs for it do nothing.
    expect(await processPaymentLink(workerDeps(), scopeOf(c), link.id as string)).toBe('skipped');
    await svc.setOrderStatus(agent, {
      id: order.id,
      expectedVersion: order.version,
      status: 'fulfilled',
    });

    // A second order: its link is cancelled on request and the order waits no more.
    const ravi = waId();
    await fx.deliver(
      orderMessage(c, ravi, '5550005', [{ retailerId: 'sku-3', quantity: 1, price: 99 }]),
    );
    const convRavi = await conversationOf(c, ravi);
    let second = await orderOf(convRavi.id);
    await svc.requestPayment(agent, { id: second.id, expectedVersion: second.version });
    let secondLink = await linkRow(second.id as string);
    expect(await processPaymentLink(workerDeps(), scopeOf(c), secondLink.id as string)).toBe(
      'done',
    );
    await svc.cancelPaymentLink(agent, { orderId: second.id });
    secondLink = await linkRow(second.id as string);
    expect(await processPaymentLink(workerDeps(), scopeOf(c), secondLink.id as string)).toBe(
      'done',
    );
    expect(await linkRow(second.id as string)).toMatchObject({ status: 'cancelled' });
    expect(rzp.state.paymentLinks.get(secondLink.provider_link_id as string)!.status).toBe(
      'cancelled',
    );
    second = await orderOf(convRavi.id);
    expect(second.status).toBe('confirmed');
    expect(second.status_changed_by).toBe('payment_link');

    // A cancellation that loses the race with the payment records the payment.
    await svc.requestPayment(agent, { id: second.id, expectedVersion: second.version });
    let third = await linkRow(second.id as string);
    expect(await processPaymentLink(workerDeps(), scopeOf(c), third.id as string)).toBe('done');
    third = await linkRow(second.id as string);
    rzp.payLink(third.provider_link_id as string);
    await svc.cancelPaymentLink(agent, { orderId: second.id });
    expect(await processPaymentLink(workerDeps(), scopeOf(c), third.id as string)).toBe('done');
    expect((await orderOf(convRavi.id)).status).toBe('paid');

    // An expired link frees its order; the sweep finds links due for a check.
    const meera = waId();
    await fx.deliver(
      orderMessage(c, meera, '5550005', [{ retailerId: 'sku-1', quantity: 1, price: 10 }]),
    );
    const convMeera = await conversationOf(c, meera);
    const fourth = await orderOf(convMeera.id);
    await svc.requestPayment(agent, { id: fourth.id, expectedVersion: fourth.version });
    const fourthLink = await linkRow(fourth.id as string);
    const due = await findDueCommerceWork(fx.dbs.app, 500);
    expect(due).toContainEqual({ tenantId: c.tenant.id, kind: 'link', ref: fourthLink.id });
    // The customer service window closed before the link existed: it is created but not sent, and
    // the reason stays on the link after later checks.
    await fx.query(
      `UPDATE app.conversations SET last_inbound_at = now() - interval '25 hours' WHERE id = $1`,
      [convMeera.id],
    );
    expect(await processPaymentLink(workerDeps(), scopeOf(c), fourthLink.id as string)).toBe(
      'done',
    );
    const created = await linkRow(fourth.id as string);
    expect(created).toMatchObject({
      status: 'created',
      message_id: null,
      send_error: expect.stringMatching(/window had closed/),
    });
    rzp.setLinkStatus(created.provider_link_id as string, 'expired');
    expect(await processPaymentLink(workerDeps(), scopeOf(c), created.id as string)).toBe('done');
    expect(await linkRow(fourth.id as string)).toMatchObject({
      status: 'expired',
      error: null,
      send_error: expect.stringMatching(/window had closed/),
    });
    expect(await orderOf(convMeera.id)).toMatchObject({
      status: 'confirmed',
      status_changed_by: 'payment_link',
    });

    // Keys revoked at Razorpay: a new link fails with a clear message and the account shows it.
    rzp.state.merchants.set(account.keyId, 'rotated-elsewhere');
    const refreshed = await orderOf(convMeera.id);
    await svc.requestPayment(agent, { id: refreshed.id, expectedVersion: refreshed.version });
    const revoked = await linkRow(refreshed.id as string);
    expect(await processPaymentLink(workerDeps(), scopeOf(c), revoked.id as string)).toBe('done');
    expect(await linkRow(refreshed.id as string)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/rejected the company’s key id or secret/),
    });
    expect((await orderOf(convMeera.id)).status).toBe('confirmed');
    expect((await svc.paymentAccount(owner)).account!.status).toBe('failed');
    // Until the keys are checked successfully again, payment cannot be requested.
    const afterRevoked = await orderOf(convMeera.id);
    await expectAppError(
      svc.requestPayment(agent, {
        id: afterRevoked.id,
        expectedVersion: afterRevoked.version as number,
      }),
      'precondition_failed',
      /not been checked successfully/,
    );
    const audit = await fx.query<{ action: string }>(
      `SELECT action FROM app.audit_events WHERE tenant_id = $1 AND action LIKE 'commerce.pay%' ORDER BY occurred_at, id`,
      [c.tenant.id],
    );
    expect(audit.map((a) => a.action)).toContain('commerce.payment_account_saved');
    expect(audit.map((a) => a.action)).toContain('commerce.payment_requested');
  });

  it('asks for payment and cancels links through the API as members do, as the key (ADR-283)', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await syncedCatalog(c, owner, '5550015', 2);
    const svc = service();
    const payer = await apiKeyOf(c, ['orders.read', 'orders.request_payment']);
    const apiDeps = { db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer };
    const ask = (
      orderId: string,
      idempotency: { key: string; requestHash: string } | null = null,
    ) => apiRequestOrderPayment(apiDeps, payer, orderId, idempotency);

    // A cart of ₹30.00, received, before the company has added its Razorpay account: refused, and
    // the Idempotency-Key stays unused.
    const asha = waId();
    await fx.deliver(
      orderMessage(c, asha, '5550015', [{ retailerId: 'sku-1', quantity: 3, price: 10 }]),
    );
    const conv = await conversationOf(c, asha);
    const order = await orderOf(conv.id);
    const orderId = order.id as string;
    const retry = {
      key: 'pay-order-1',
      requestHash: sha256Hex(`POST /api/v1/orders/${orderId}/request-payment\n`),
    };
    await expectAppError(ask(orderId, retry), 'precondition_failed', /Add your Razorpay account/);
    expect((await orderOf(conv.id)).status).toBe('received');
    await paymentAccount(c, owner);

    // A key that only moves orders on never asks for payment.
    const mover = await apiKeyOf(c, ['orders.write']);
    await expectAppError(
      apiRequestOrderPayment(apiDeps, mover, orderId, null),
      'forbidden',
      /orders\.request_payment/,
    );

    // An endpoint leaving out the key's order changes is not sent the change its request makes;
    // one taking every change is (ADR-323).
    const orderHooks = createWebhooksService({
      db: fx.dbs.app,
      clock: systemClock,
      keyring: fx.keyring,
      egressPolicy: { allowLoopbackForTests: true },
    });
    const everyOrderChange = await orderHooks.create(owner, {
      url: 'https://hooks.receiver.test/orders',
      eventTypes: ['order.status_changed'],
    });
    const notThePayer = await orderHooks.create(owner, {
      url: 'https://hooks.receiver.test/orders-elsewhere',
      eventTypes: ['order.status_changed'],
      orderExcludedApiKeyIds: [payer.key.id],
    });

    // Asked for as the key: the order waits for payment, recorded as the key's change; a retry
    // with the same Idempotency-Key answers the first, and asking again without one is refused.
    const first = await ask(orderId, retry);
    expect([first.status, first.replayed]).toEqual([200, false]);
    expect((first.body as { data: ApiOrder }).data).toMatchObject({
      id: orderId,
      status: 'awaiting_payment',
      statusChangedBy: 'api',
      statusChangedByApiKeyId: payer.key.id,
      subtotalMinor: 3000,
    });
    const orderChangesTo = (endpointId: string) =>
      fx.query<{ status: string; changed_by: string | null }>(
        `SELECT e.status, e.detail ->> 'changedBy' AS changed_by FROM app.webhook_deliveries d
           JOIN app.webhook_events e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
          WHERE d.endpoint_id = $1 AND e.type = 'order.status_changed'`,
        [endpointId],
      );
    expect(await orderChangesTo(everyOrderChange.id)).toEqual([
      { status: 'awaiting_payment', changed_by: 'api' },
    ]);
    expect(await orderChangesTo(notThePayer.id)).toEqual([]);
    const again = await ask(orderId, retry);
    expect([again.replayed, again.body]).toEqual([true, first.body]);
    await expectAppError(
      ask(orderId),
      'conflict',
      /received or confirmed orders\. This order's status is awaiting_payment\.$/,
    );
    let link = await linkRow(orderId);
    expect(link).toMatchObject({
      status: 'creating',
      amount_minor: '3000',
      currency: 'INR',
      created_by_membership_id: null,
      created_by_api_key_id: payer.key.id,
    });
    expect(
      await fx.query('SELECT id FROM app.commerce_payment_links WHERE order_id = $1', [orderId]),
    ).toHaveLength(1);
    const audits = async (action: string) =>
      fx.query<{ actor_type: string; actor_id: string; metadata: Record<string, unknown> }>(
        `SELECT actor_type, actor_id, metadata FROM app.audit_events
          WHERE action = $1 AND subject_id = $2 ORDER BY occurred_at, id`,
        [action, orderId],
      );
    expect(await audits('commerce.payment_requested')).toEqual([
      {
        actor_type: 'api_key',
        actor_id: payer.key.id,
        metadata: {
          reference: order.reference,
          amountMinor: 3000,
          currency: 'INR',
          source: 'api',
        },
      },
    ]);

    // An endpoint naming the key takes the statuses of the messages sent as the key, the Payment
    // Link among them, though the key cannot send messages itself; one naming another key does not
    // (ADR-320).
    const webhooks = createWebhooksService({
      db: fx.dbs.app,
      clock: systemClock,
      keyring: fx.keyring,
      egressPolicy: { allowLoopbackForTests: true },
    });
    const sender = await apiKeyOf(c, ['messages.send']);
    expect((await webhooks.messageApiKeyChoices(owner)).map((k) => k.id).sort()).toEqual(
      [payer.key.id, sender.key.id].sort(),
    );
    const byPayer = await webhooks.create(owner, {
      url: 'https://hooks.receiver.test/payments',
      eventTypes: ['message.status'],
      messageApiKeyIds: [payer.key.id],
    });
    const bySender = await webhooks.create(owner, {
      url: 'https://hooks.receiver.test/sends',
      eventTypes: ['message.status'],
      messageApiKeyIds: [sender.key.id],
    });

    // The worker creates it once at Razorpay and sends it in the chat, as the key; the order page
    // says a key asked.
    expect(await processPaymentLink(workerDeps(), scopeOf(c), link.id as string)).toBe('done');
    link = await linkRow(orderId);
    expect(link.status).toBe('created');
    const [sent] = await fx.query<{
      sender_type: string;
      sender_membership_id: string | null;
      api_key_id: string | null;
      content: { text: string };
    }>(
      'SELECT sender_type, sender_membership_id, api_key_id, content FROM app.messages WHERE id = $1',
      [link.message_id],
    );
    expect(sent).toMatchObject({
      sender_type: 'api',
      sender_membership_id: null,
      api_key_id: payer.key.id,
    });
    expect(sent!.content.text).toBe(
      `Pay ₹30.00 for order ${order.reference as string}: ${link.short_url as string}`,
    );
    expect(await sendQueued(c, conv.id)).toEqual(['accepted']);
    const statusesTo = (endpointId: string) =>
      fx.query<{ message_id: string; status: string }>(
        `SELECT e.message_id, e.status FROM app.webhook_deliveries d
           JOIN app.webhook_events e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
          WHERE d.endpoint_id = $1 AND e.type = 'message.status'`,
        [endpointId],
      );
    expect(await statusesTo(byPayer.id)).toEqual([
      { message_id: link.message_id, status: 'accepted' },
    ]);
    expect(await statusesTo(bySender.id)).toEqual([]);
    const shown = await svc.order(owner, orderId);
    expect(shown.links.map((l) => [l.status, l.throughApi])).toEqual([['created', true]]);

    // Cancelled as the key: the order waits until Razorpay reports the link cancelled; asking
    // again meanwhile changes nothing, and once it has ended there is no link to cancel.
    const cancelling = await apiCancelOrderPayment(apiDeps, payer, orderId);
    expect(cancelling.status).toBe('awaiting_payment');
    expect((await linkRow(orderId)).cancel_requested_at).not.toBeNull();
    expect((await apiCancelOrderPayment(apiDeps, payer, orderId)).status).toBe('awaiting_payment');
    expect(await audits('commerce.payment_link_cancel_requested')).toEqual([
      {
        actor_type: 'api_key',
        actor_id: payer.key.id,
        metadata: { reference: order.reference, source: 'api' },
      },
    ]);
    expect(await processPaymentLink(workerDeps(), scopeOf(c), link.id as string)).toBe('done');
    expect(await linkRow(orderId)).toMatchObject({ status: 'cancelled' });
    expect(rzp.state.paymentLinks.get(link.provider_link_id as string)!.status).toBe('cancelled');
    expect(await orderOf(conv.id)).toMatchObject({
      status: 'confirmed',
      status_changed_by: 'payment_link',
    });
    await expectAppError(
      apiCancelOrderPayment(apiDeps, payer, orderId),
      'conflict',
      /no open Payment Link\. This order's status is confirmed\.$/,
    );

    // Asked for again, now confirmed, and paid: only Razorpay's report marks the order paid, and
    // a paid order is not asked for.
    expect((await ask(orderId)).status).toBe(200);
    const second = await linkRow(orderId);
    expect(second.id).not.toBe(link.id);
    expect(await processPaymentLink(workerDeps(), scopeOf(c), second.id as string)).toBe('done');
    rzp.payLink((await linkRow(orderId)).provider_link_id as string);
    expect(await processPaymentLink(workerDeps(), scopeOf(c), second.id as string)).toBe('done');
    expect(await orderOf(conv.id)).toMatchObject({
      status: 'paid',
      status_changed_by: 'payment_link',
    });
    await expectAppError(ask(orderId), 'conflict', /This order's status is paid\.$/);

    // Another company's key finds neither the order nor its link; an unknown id is not found.
    const theirs = await apiKeyOf(other, ['orders.request_payment']);
    await expectAppError(apiRequestOrderPayment(apiDeps, theirs, orderId, null), 'not_found');
    await expectAppError(apiCancelOrderPayment(apiDeps, theirs, orderId), 'not_found');
    await expectAppError(ask(uuidv7()), 'not_found');

    // A plan without Commerce asks for no payment.
    const ravi = waId();
    await fx.deliver(
      orderMessage(c, ravi, '5550015', [{ retailerId: 'sku-2', quantity: 1, price: 20 }]),
    );
    const convRavi = await conversationOf(c, ravi);
    const ravisOrder = (await orderOf(convRavi.id)).id as string;
    await onPlan(c, []);
    const refused = await expectAppError(ask(ravisOrder), 'forbidden', /does not include Commerce/);
    expect(isAppError(refused) && refused.details).toEqual({ apiReason: 'not_in_plan' });
    expect((await orderOf(convRavi.id)).status).toBe('received');
    await onPlan(c, ['commerce']);
    expect((await ask(ravisOrder)).status).toBe(200);
  });

  it('reads an order’s Payment Links through the API as the order page lists them (ADR-284)', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await syncedCatalog(c, owner, '5550016', 1);
    await paymentAccount(c, owner);
    const svc = service();
    const reader = await apiKeyOf(c, ['orders.read']);
    const payer = await apiKeyOf(c, ['orders.request_payment']);
    const apiDeps = { db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer };
    const links = (orderId: string, query: Record<string, string | null> = {}) =>
      apiListOrderPaymentLinks(apiDeps, reader, orderId, query);

    // An order of ₹20.00 with no link yet.
    const asha = waId();
    await fx.deliver(
      orderMessage(c, asha, '5550016', [{ retailerId: 'sku-1', quantity: 2, price: 10 }]),
    );
    const conv = await conversationOf(c, asha);
    const order = await orderOf(conv.id);
    const orderId = order.id as string;
    expect(await links(orderId)).toEqual({ data: [], nextCursor: null });

    // A member asks: the link is sent in the chat, then cancelled at the member's request.
    await svc.requestPayment(agent, { id: orderId, expectedVersion: order.version as number });
    const first = await linkRow(orderId);
    expect(await processPaymentLink(workerDeps(), scopeOf(c), first.id as string)).toBe('done');
    const sent = await linkRow(orderId);
    expect(sent.message_id).toEqual(expect.any(String));
    await svc.cancelPaymentLink(agent, { orderId });
    expect(await processPaymentLink(workerDeps(), scopeOf(c), first.id as string)).toBe('done');

    // A key asks again; Razorpay gives no address for the link, so it is not sent.
    rzp.state.omitShortUrl = true;
    expect((await apiRequestOrderPayment(apiDeps, payer, orderId, null)).status).toBe(200);
    const second = await linkRow(orderId);
    expect(await processPaymentLink(workerDeps(), scopeOf(c), second.id as string)).toBe('done');

    // Newest first, a page at a time: the key's unsent link, then the member's cancelled one.
    const page = await links(orderId, { limit: '1' });
    expect(page.data.map((l) => l.id)).toEqual([second.id]);
    expect(page.nextCursor).toEqual(expect.any(String));
    const rest = await links(orderId, { limit: '1', cursor: page.nextCursor });
    expect(rest.data.map((l) => l.id)).toEqual([first.id]);
    expect(rest.nextCursor).toBeNull();
    expect(page.data[0]).toMatchObject({
      orderId,
      status: 'created',
      amountMinor: 2000,
      amountPaidMinor: 0,
      currency: 'INR',
      paidAt: null,
      cancelRequestedAt: null,
      messageId: null,
      notSentReason: expect.stringMatching(/no https address/),
      error: null,
      requestedBy: 'api',
      requestedByApiKeyId: payer.key.id,
      checkedAt: expect.any(String),
    });
    expect(rest.data[0]).toMatchObject({
      status: 'cancelled',
      cancelRequestedAt: expect.any(String),
      messageId: sent.message_id,
      notSentReason: null,
      requestedBy: 'member',
      requestedByApiKeyId: null,
    });
    // Never the address or Razorpay's ids for the link.
    const read = JSON.stringify([...page.data, ...rest.data]);
    for (const hidden of [sent.short_url, sent.provider_link_id, sent.reference]) {
      expect(read).not.toContain(hidden as string);
    }

    // Another company's key finds no order; a key without orders.read reads none, and a plan
    // without Commerce none either.
    const theirs = await apiKeyOf(other, ['orders.read']);
    await expectAppError(apiListOrderPaymentLinks(apiDeps, theirs, orderId, {}), 'not_found');
    await expectAppError(
      apiListOrderPaymentLinks(apiDeps, payer, orderId, {}),
      'forbidden',
      /orders\.read/,
    );
    await onPlan(c, []);
    const refused = await expectAppError(links(orderId), 'forbidden', /does not include Commerce/);
    expect(isAppError(refused) && refused.details).toEqual({ apiReason: 'not_in_plan' });
  });

  it('keeps each key check with the keys it used, and explains a link without an address', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await syncedCatalog(c, owner, '5550007', 2);
    const svc = service();
    const [first, second, third] = [
      'rzp_test_RACEKEY00001',
      'rzp_test_RACEKEY00002',
      'rzp_test_RACEKEY00003',
    ];
    rzp.addMerchant(first!, 'race-secret-1');
    rzp.addMerchant(third!, 'race-secret-3');
    await svc.savePaymentAccount(owner, {
      keyId: first!,
      keySecret: 'race-secret-1',
      webhookSecret: 'race-hook-1',
    });
    const [row] = await fx.query<{ id: string }>(
      `SELECT id FROM app.commerce_payment_accounts WHERE tenant_id = $1`,
      [c.tenant.id],
    );
    // The keys are replaced while the first check is in flight: its (good) answer is not applied
    // to the new, unregistered keys, which get their own check.
    rzp.state.queues.paymentLinks.push({
      kind: 'before',
      run: async () => {
        await svc.savePaymentAccount(owner, {
          keyId: second!,
          keySecret: 'not-registered',
          webhookSecret: 'race-hook-2',
        });
      },
    });
    expect(await processPaymentAccountCheck(workerDeps(), scopeOf(c), row!.id)).toBe('done');
    expect((await svc.paymentAccount(owner)).account).toMatchObject({
      keyId: second,
      status: 'checking',
    });
    expect(await processPaymentAccountCheck(workerDeps(), scopeOf(c), row!.id)).toBe('done');
    expect((await svc.paymentAccount(owner)).account).toMatchObject({ status: 'failed' });

    // Working keys, then a link request whose keys are replaced while Razorpay rejects the old ones:
    // the rejection fails that link but does not mark the new keys failed.
    await svc.savePaymentAccount(owner, {
      keyId: third!,
      keySecret: 'race-secret-3',
      webhookSecret: 'race-hook-3',
    });
    expect(await processPaymentAccountCheck(workerDeps(), scopeOf(c), row!.id)).toBe('done');
    const buyer = waId();
    await fx.deliver(
      orderMessage(c, buyer, '5550007', [{ retailerId: 'sku-1', quantity: 1, price: 150 }]),
    );
    const conv = await conversationOf(c, buyer);
    let order = await orderOf(conv.id);
    await svc.requestPayment(agent, { id: order.id, expectedVersion: order.version as number });
    const rejected = await linkRow(order.id as string);
    rzp.state.queues.createPaymentLink.push(
      {
        kind: 'before',
        run: async () => {
          await svc.savePaymentAccount(owner, {
            keyId: third!,
            keySecret: 'race-secret-3',
            webhookSecret: 'race-hook-4',
          });
        },
      },
      { kind: 'error', status: 401, description: 'The api key provided is invalid' },
    );
    expect(await processPaymentLink(workerDeps(), scopeOf(c), rejected.id as string)).toBe('done');
    expect(await linkRow(order.id as string)).toMatchObject({ status: 'failed' });
    expect((await svc.paymentAccount(owner)).account).toMatchObject({ status: 'checking' });
    expect(await processPaymentAccountCheck(workerDeps(), scopeOf(c), row!.id)).toBe('done');
    expect((await svc.paymentAccount(owner)).account).toMatchObject({ status: 'verified' });

    // Razorpay answers without a usable address: the link is kept with the reason, not sent.
    order = await orderOf(conv.id);
    await svc.requestPayment(agent, { id: order.id, expectedVersion: order.version as number });
    const pending = await linkRow(order.id as string);
    rzp.state.omitShortUrl = true;
    expect(await processPaymentLink(workerDeps(), scopeOf(c), pending.id as string)).toBe('done');
    expect(await linkRow(order.id as string)).toMatchObject({
      status: 'created',
      short_url: null,
      message_id: null,
      send_error: expect.stringMatching(/no https address/),
    });
    const detail = await svc.order(agent, order.id as string);
    expect(detail.links[0]).toMatchObject({
      shortUrl: null,
      sendError: expect.stringMatching(/no https address/),
    });
    expect(detail.payment.canCancelLink).toBe(true);
  });

  it('erasure clears order notes and cancels open links; companies stay apart', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await syncedCatalog(c, owner, '5550006', 2);
    const account = await paymentAccount(c, owner);
    const svc = service();
    const asha = waId();
    await fx.deliver(
      orderMessage(
        c,
        asha,
        '5550006',
        [{ retailerId: 'sku-1', quantity: 1, price: 150 }],
        'Leave it at the door',
      ),
    );
    const conv = await conversationOf(c, asha);
    const order = await orderOf(conv.id);
    expect(order.customer_note).toBe('Leave it at the door');
    await svc.requestPayment(owner, { id: order.id, expectedVersion: order.version });
    const link = await linkRow(order.id as string);
    expect(await processPaymentLink(workerDeps(), scopeOf(c), link.id as string)).toBe('done');

    // Another company sees none of it, and its webhook secret opens nothing here.
    const other = await fx.company();
    const otherOwner = await fx.ctx(other, other.owner);
    const otherAccount = await paymentAccount(other, otherOwner);
    expect((await svc.orders(otherOwner)).orders).toEqual([]);
    await expectAppError(svc.order(otherOwner, order.id as string), 'not_found');
    const forged = signedEvent(
      otherAccount.webhookSecret,
      'payment_link.paid',
      (await linkRow(order.id as string)).provider_link_id as string,
    );
    expect(
      await handlePaymentWebhook(webhookDeps(), {
        publicId: account.publicId,
        rawBody: forged.rawBody,
        signature: forged.signature,
        eventId: 'evt_cross_0001',
      }),
    ).toMatchObject({ status: 400 });
    const leaked = await fx.dbs.app.run(authorizedTenantScope(other.tenant.id, null), (tx) =>
      tx.execute<{ n: number }>(
        sql`select (select count(*) from app.commerce_orders) + (select count(*) from app.commerce_payment_links where tenant_id = ${c.tenant.id}::uuid) as n`,
      ),
    );
    expect(Number(leaked.rows[0]!.n)).toBe(0);

    // Erasure: the order stays as a business record without the note; the open link is cancelled.
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: conv.contact_id,
      suppress: false,
    });
    const erased = await orderOf(conv.id);
    expect(erased).toMatchObject({ customer_note: null, subtotal_minor: '15000' });
    const pendingCancel = await linkRow(order.id as string);
    expect(pendingCancel.cancel_requested_at).not.toBeNull();
    expect(await processPaymentLink(workerDeps(), scopeOf(c), pendingCancel.id as string)).toBe(
      'done',
    );
    expect(await linkRow(order.id as string)).toMatchObject({ status: 'cancelled' });
  });
});
