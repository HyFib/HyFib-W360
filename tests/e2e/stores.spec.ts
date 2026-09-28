import type { APIRequestContext, Page } from '@playwright/test';
import pg from 'pg';
import { expect, test } from './fixtures';
import {
  connectTestChannel,
  inboundMessage,
  messagingConfigured,
  randomWaId,
  sendSignedWebhook,
  standInRequests,
  templateButtonReply,
} from './messaging-support';
import { expectNoHorizontalOverflow, signUpAndVerify, uniqueEmail } from './support';

/**
 * Store connectors through the browser, against the TEST-ONLY Shopify and WooCommerce stand-ins
 * started by the global setup: the approval in the store's own admin (the stand-ins approve at
 * once), the first read by the worker, orders next to the customer's chat, webhooks that make HyFib
 * read again, removal, order messages and cart reminders.
 */
const PASSWORD = 'correct horse battery staple 42';
const SHOPIFY = `http://127.0.0.1:${process.env.E2E_SHOPIFY_PORT ?? ''}`;
const WOO = `http://127.0.0.1:${process.env.E2E_WOO_PORT ?? ''}`;
const GRAPH = `http://127.0.0.1:${process.env.E2E_GRAPH_PORT ?? ''}`;

test.skip(
  !messagingConfigured ||
    !process.env.E2E_SHOPIFY_PORT ||
    !process.env.E2E_WOO_PORT ||
    process.env.W360_EGRESS_ALLOW_LOOPBACK !== 'true',
  'Store stand-ins (E2E_SHOPIFY_PORT, E2E_WOO_PORT), loopback egress and Meta test configuration not provided',
);

async function newCompany(page: Page, prefix: string, name: string) {
  const email = uniqueEmail(prefix);
  const slug = `${prefix}-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name, email, password: PASSWORD });
  await page.getByLabel('Company name').fill(`${name}'s Company`);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const channel = await connectTestChannel({ ownerEmail: email, slug });
  return { slug, ...channel };
}

async function openFromNav(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name }).click();
}

async function openStores(page: Page) {
  await openFromNav(page, 'Commerce');
  await page
    .getByRole('navigation', { name: 'Commerce sections' })
    .getByRole('link', { name: 'Stores' })
    .click();
  await expect(page.getByRole('heading', { name: 'Your stores' })).toBeVisible();
}

/** Reloads until the worker has done its part and `locator()` is visible. */
async function reloadUntil(
  page: Page,
  locator: () => ReturnType<Page['getByText']>,
  timeout = 30_000,
) {
  await expect(async () => {
    await page.reload();
    await expect(locator().first()).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout });
}

/** Drives a stand-in through its TEST-ONLY control endpoint (it runs in the runner process). */
async function control(request: APIRequestContext, url: string, data: unknown) {
  const res = await request.post(url, { data });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as unknown;
}

test('a Shopify store is approved in Shopify, its orders are read and shown next to the customer’s chat', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const { wabaId, phoneNumberId } = await newCompany(page, 'shopify', 'Tara Tea');
  const shopName = `tara-${Date.now().toString(36)}`;
  const shop = `${shopName}.myshopify.com`;
  const customer = randomWaId();
  // The store already has an order from a customer who writes on WhatsApp later.
  await control(request, `${SHOPIFY}/__stand-in/order`, {
    shop,
    order: {
      id: '5001',
      name: '#1001',
      total: { amount: '1499.00', currencyCode: 'INR' },
      phone: `+${customer}`,
      email: 'priya@example.com',
      shippingAddress: { name: 'Priya Customer', phone: null },
      lineItems: [
        {
          name: 'Darjeeling tea',
          sku: 'DJ-1',
          quantity: 3,
          total: { amount: '1499.00', currencyCode: 'INR' },
        },
      ],
    },
  });

  // Commerce → Stores: the owner connects the store and approves HyFib in Shopify.
  await openStores(page);
  await expect(page.getByText('No store connected yet.')).toBeVisible();
  await page.getByLabel('Shopify store').fill(shop);
  await page.getByRole('button', { name: 'Connect with Shopify' }).click();
  await expect(page).toHaveURL(/\/commerce\/stores\/[0-9a-f-]{36}$/);
  await reloadUntil(page, () => page.getByText('Connected', { exact: true }));
  await expect(page.getByText(`Shopify · ${shop}`)).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // The first read (orders of the last 60 days, then products) follows the connection.
  await page.getByRole('link', { name: 'View orders' }).click();
  await expect(page).toHaveURL(/\/orders$/);
  await reloadUntil(page, () => page.getByRole('cell', { name: '₹1,499.00' }));
  await expect(page.getByText(`+${customer}`)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('link', { name: '#1001' }).click();
  await expect(page.getByRole('heading', { name: 'Order #1001' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Darjeeling tea' })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // The customer writes on WhatsApp: the store order shows next to the conversation.
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, customer, 'Where is my tea?'),
  );
  await openFromNav(page, 'Inbox');
  await page.getByRole('link', { name: /Priya Customer/ }).click({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Store orders' })).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(`#1001 · ${shopName}`) })).toBeVisible();
  await expect(page.getByText('Unfulfilled')).toBeVisible();

  // Shopify tells HyFib the order changed; HyFib reads the order from Shopify itself.
  await control(request, `${SHOPIFY}/__stand-in/order`, {
    shop,
    order: { id: '5001', displayFulfillmentStatus: 'FULFILLED' },
  });
  const deliveries = (await control(request, `${SHOPIFY}/__stand-in/deliver`, {
    shop,
    topic: 'orders/updated',
    payload: { id: 5001, admin_graphql_api_id: 'gid://shopify/Order/5001' },
  })) as { status: number }[];
  expect(deliveries.map((d) => d.status)).toEqual([200]);
  await reloadUntil(page, () => page.getByText('Fulfilled', { exact: true }));
  await expectNoHorizontalOverflow(page);

  // Removal: HyFib uninstalls itself from the shop and deletes what it read.
  await openStores(page);
  await page.getByRole('link', { name: shopName, exact: true }).click();
  await page.getByRole('button', { name: 'Remove store' }).click();
  await page.getByRole('button', { name: 'Yes, remove the store' }).click();
  await expect(page.getByText('Being removed', { exact: true })).toBeVisible();
  await openStores(page);
  await reloadUntil(page, () => page.getByText('No store connected yet.'));
  const state = (await control(request, `${SHOPIFY}/__stand-in/shop`, { shop })) as {
    installed: boolean;
  };
  expect(state.installed).toBe(false);
});

test('a WooCommerce store is connected with keys approved in WordPress, and its webhooks make HyFib read again', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  await newCompany(page, 'woo', 'Wren Woo');
  const site = `wren-${Date.now().toString(36)}`;
  await control(request, `${WOO}/__stand-in/order`, {
    site,
    order: {
      id: 41,
      number: '41',
      status: 'processing',
      total: '850.00',
      billing: {
        first_name: 'Ravi',
        last_name: 'S',
        email: 'ravi@example.com',
        phone: '+919900011122',
      },
      line_items: [{ id: 1, name: 'Mug', sku: 'MUG', quantity: 2, total: '850.00', price: 425 }],
    },
  });
  await control(request, `${WOO}/__stand-in/product`, {
    site,
    product: { id: 900, name: 'Stoneware mug', price: '425.00', sku: 'MUG' },
  });

  // WordPress asks the owner to approve Read/Write keys (the stand-in approves at once), hands the
  // keys to HyFib and sends the owner back to the store's page.
  await openStores(page);
  await page.getByRole('textbox', { name: 'WooCommerce site' }).fill(`${WOO}/${site}`);
  await page.getByRole('button', { name: 'Connect with WooCommerce' }).click();
  await expect(page).toHaveURL(/\/commerce\/stores\/[0-9a-f-]{36}\?/);
  await reloadUntil(page, () => page.getByText('Connected', { exact: true }));
  const storeUrl = page.url().replace(/\?.*$/, '');
  const siteState = (await control(request, `${WOO}/__stand-in/site`, { site })) as {
    keys: number;
  };
  expect(siteState.keys).toBe(1);

  await page.getByRole('link', { name: 'View orders' }).click();
  await expect(page).toHaveURL(/\/orders$/);
  await reloadUntil(page, () => page.getByRole('cell', { name: '₹850.00' }));
  await expect(page.getByText('Processing', { exact: true })).toBeVisible();

  // A signed webhook from the site: HyFib reads the order again from the store.
  await control(request, `${WOO}/__stand-in/order`, {
    site,
    order: { id: 41, status: 'completed' },
  });
  const deliveries = (await control(request, `${WOO}/__stand-in/deliver`, {
    site,
    topic: 'order.updated',
    id: 41,
  })) as { status: number }[];
  expect(deliveries.map((d) => d.status)).toEqual([200]);
  await reloadUntil(page, () => page.getByText('Completed', { exact: true }));
  await expectNoHorizontalOverflow(page);

  await page.goto(`${storeUrl}/products`);
  await expect(page.getByRole('cell', { name: /Stoneware mug/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

/** An approved template, created in the Templates pages and approved by the stand-in. */
async function approvedTemplate(
  page: Page,
  request: APIRequestContext,
  slug: string,
  wabaId: string,
  t: {
    name: string;
    category?: 'UTILITY' | 'MARKETING';
    body: string;
    examples: string[];
    quickReplies: string[];
  },
) {
  await page.goto(`/c/${slug}/templates/new`);
  await page.getByLabel('Name').fill(t.name);
  await page.getByLabel('Language code').fill('en');
  await page.getByLabel('Category').selectOption(t.category ?? 'UTILITY');
  await page.getByLabel('Body').fill(t.body);
  for (const [i, example] of t.examples.entries()) {
    await page.getByLabel(`{{${i + 1}}}`).fill(example);
  }
  for (const [i, text] of t.quickReplies.entries()) {
    await page.getByRole('button', { name: 'Add quick reply' }).click();
    await page.getByLabel('Quick reply text').nth(i).fill(text);
  }
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('heading', { name: t.name, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Submit to Meta' }).click();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await reloadUntil(page, () => page.getByText('In review', { exact: true }));
  await control(request, `${GRAPH}/__stand-in/template-status`, {
    wabaId,
    name: t.name,
    status: 'APPROVED',
  });
  await page.goto(`/c/${slug}/templates`);
  await page.getByRole('button', { name: 'Refresh from Meta' }).click();
  await reloadUntil(page, () => page.getByText('Approved', { exact: true }));
}

test('order messages are set up per store, sent for a new order, and the customer’s answer shows on the order', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const { slug, wabaId, phoneNumberId } = await newCompany(page, 'ordermsg', 'Olive Oils');
  await approvedTemplate(page, request, slug, wabaId, {
    name: 'cod_check',
    body: 'Please confirm your cash on delivery order {{1}} of {{2}}.',
    examples: ['#1001', '₹999.00'],
    quickReplies: ['Confirm order', 'Cancel order'],
  });
  const shopName = `olive-${Date.now().toString(36)}`;
  const shop = `${shopName}.myshopify.com`;
  await openStores(page);
  await page.getByLabel('Shopify store').fill(shop);
  await page.getByRole('button', { name: 'Connect with Shopify' }).click();
  await expect(page).toHaveURL(/\/commerce\/stores\/[0-9a-f-]{36}$/);
  await reloadUntil(page, () => page.getByText('Connected', { exact: true }));

  // The manager confirms the customers' opt-in and sets up the cash on delivery message.
  await page.getByRole('link', { name: 'Order messages' }).click();
  await expect(page.getByRole('heading', { name: 'Order messages' })).toBeVisible();
  const cod = page.getByRole('form', { name: 'Cash on delivery confirmation' });
  await cod.getByLabel('Send this message').check();
  await cod.getByLabel('Template').selectOption({ label: 'cod_check (en, utility)' });
  await cod.getByLabel('Variable {{2}}').selectOption('order_total');
  await cod.getByLabel('Button that confirms the order').selectOption({ label: 'Confirm order' });
  await cod.getByLabel('Button that cancels it').selectOption({ label: 'Cancel order' });
  await cod.getByRole('button', { name: 'Save' }).click();
  // Not before the customers' opt-in is confirmed.
  await expect(cod.getByText(/agreed to receive WhatsApp messages/)).toBeVisible();
  const settings = page.getByRole('form', { name: 'Message settings' });
  await settings.getByLabel(/customers agreed to receive order messages/).check();
  await settings.getByRole('button', { name: 'Save settings' }).click();
  await expect(settings.getByText('Settings saved.')).toBeVisible();
  await cod.getByRole('button', { name: 'Save' }).click();
  await expect(cod.getByText('Saved.')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // A new order paid on delivery: Shopify's webhook makes HyFib read it, and the message goes out.
  const customer = randomWaId();
  await control(request, `${SHOPIFY}/__stand-in/order`, {
    shop,
    order: {
      id: '7101',
      name: '#1101',
      phone: `+${customer}`,
      paymentGatewayNames: ['Cash on Delivery (COD)'],
      displayFinancialStatus: 'PENDING',
      total: { amount: '999.00', currencyCode: 'INR' },
      shippingAddress: { name: 'Meena Customer', phone: null },
    },
  });
  const deliveries = (await control(request, `${SHOPIFY}/__stand-in/deliver`, {
    shop,
    topic: 'orders/create',
    payload: { id: 7101, admin_graphql_api_id: 'gid://shopify/Order/7101' },
  })) as { status: number }[];
  expect(deliveries.map((d) => d.status)).toEqual([200]);
  let sent: { wamid?: string; body: unknown } | undefined;
  await expect(async () => {
    sent = (await standInRequests(request)).find(
      (r) => r.path.endsWith('/messages') && (r.body as { to?: string }).to === customer,
    );
    expect(sent?.wamid).toBeTruthy();
  }).toPass({ timeout: 45_000 });
  const template = (sent?.body as { template: { name: string; components: unknown[] } }).template;
  expect(template.name).toBe('cod_check');
  expect(template.components).toContainEqual({
    type: 'body',
    parameters: [
      { type: 'text', text: '#1101' },
      { type: 'text', text: '₹999.00' },
    ],
  });
  const buttons = template.components.filter((c) => (c as { type: string }).type === 'button') as {
    index: string;
    parameters: { payload: string }[];
  }[];
  expect(buttons.map((b) => b.index)).toEqual(['0', '1']);
  const cancel = buttons[1]?.parameters[0]?.payload ?? '';
  expect(cancel).toMatch(/^w360-cod:[0-9a-f-]{36}:cancel$/);

  // The report shows the message; the customer taps "Cancel order" and the order page says so.
  await reloadUntil(page, () => page.getByRole('link', { name: '#1101' }));
  await expect(page.getByText('Cash on delivery confirmation').last()).toBeVisible();
  await sendSignedWebhook(
    request,
    templateButtonReply(
      wabaId,
      phoneNumberId,
      customer,
      { payload: cancel, text: 'Cancel order' },
      String(sent?.wamid),
    ),
  );
  await page.getByRole('link', { name: '#1101' }).click();
  await expect(page.getByRole('heading', { name: 'Order #1101' })).toBeVisible();
  await reloadUntil(page, () => page.getByText('Customer asked to cancel'));
  await expect(page.getByText('Cash on delivery', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

/**
 * TEST-ONLY: brings the company's waiting store messages forward to now. A cart reminder waits at
 * least 30 minutes after the checkout was left, longer than an end-to-end test should wait; the
 * worker's minute sweep then sends the message like any other whose time has come.
 */
async function bringWaitingMessagesForward(tenantId: string) {
  const app = new pg.Client({ connectionString: process.env.DATABASE_URL_APP });
  await app.connect();
  try {
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const moved = await app.query(
      "UPDATE app.commerce_store_messages SET send_at = now() WHERE state = 'pending'",
    );
    await app.query('COMMIT');
    return moved.rowCount;
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  } finally {
    await app.end();
  }
}

/** "Read the store now" on the store's page (it also reads checkouts while a reminder is on). */
async function readStoreNow(page: Page, storeUrl: string) {
  await page.goto(storeUrl);
  await page.getByRole('button', { name: 'Read the store now' }).click();
  await expect(page.getByText('The store will be read in a moment.')).toBeVisible();
  await page.getByRole('link', { name: 'Order messages' }).click();
  await expect(page.getByRole('heading', { name: 'Cart reminders' })).toBeVisible();
}

test('cart reminders use the consent the store records and remind a customer who left a checkout', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const { slug, tenantId, wabaId } = await newCompany(page, 'cart', 'Cora Candles');
  await approvedTemplate(page, request, slug, wabaId, {
    name: 'cart_nudge',
    category: 'MARKETING',
    body: 'Hi {{1}}, you left {{2}} in your cart. Finish your order here: {{3}}',
    examples: ['Asha', 'Lavender candle', 'https://cora.example/checkouts/1/recover'],
    quickReplies: [],
  });
  const shopName = `cora-${Date.now().toString(36)}`;
  const shop = `${shopName}.myshopify.com`;
  await openStores(page);
  await page.getByLabel('Shopify store').fill(shop);
  await page.getByRole('button', { name: 'Connect with Shopify' }).click();
  await expect(page).toHaveURL(/\/commerce\/stores\/[0-9a-f-]{36}$/);
  await reloadUntil(page, () => page.getByText('Connected', { exact: true }));
  const storeUrl = page.url();

  // The manager confirms the customers' opt-in to messages from the store.
  await page.getByRole('link', { name: 'Order messages' }).click();
  await expect(page.getByRole('heading', { name: 'Cart reminders' })).toBeVisible();
  const settings = page.getByRole('form', { name: 'Message settings' });
  await settings.getByLabel(/customers agreed to receive order messages/).check();
  await settings.getByRole('button', { name: 'Save settings' }).click();
  await expect(settings.getByText('Settings saved.')).toBeVisible();

  // The store's consent records need customer access, which HyFib asks Shopify for only now: the
  // manager approves it in Shopify (the stand-in approves at once) and returns to the store's page.
  const consent = page.getByRole('form', { name: 'Store consent' });
  const useConsent = consent.getByLabel(/Use the WhatsApp marketing consent this store records/);
  await expect(page.getByText('Customer access in Shopify: not allowed')).toBeVisible();
  await expect(useConsent).toBeDisabled();
  await page.getByRole('button', { name: 'Allow customer access in Shopify' }).click();
  await expect(page).toHaveURL(storeUrl);
  await page.getByRole('link', { name: 'Order messages' }).click();
  await expect(page.getByRole('heading', { name: 'Cart reminders' })).toBeVisible();
  // The worker exchanges the approval for a token that can read customers.
  await reloadUntil(page, () => page.getByText('Customer access in Shopify: allowed'));
  await useConsent.check();
  await consent.getByRole('button', { name: 'Save consent setting' }).click();
  await expect(consent.getByText('Consent setting saved.')).toBeVisible();

  // The first cart reminder: the marketing template with the checkout's values, 30 minutes after
  // the checkout was left.
  const reminder = page.getByRole('form', { name: 'Cart reminder', exact: true });
  await reminder.getByLabel('Send this message').check();
  await reminder.getByLabel('Template').selectOption({ label: 'cart_nudge (en, marketing)' });
  await reminder.getByLabel('Variable {{1}}').selectOption('customer_name');
  await reminder.getByLabel('Variable {{2}}').selectOption('cart_items');
  await reminder.getByLabel('Variable {{3}}').selectOption('checkout_url');
  await reminder.getByLabel('Wait after the checkout was left (minutes)').fill('30');
  await reminder.getByRole('button', { name: 'Save' }).click();
  await expect(reminder.getByText('Saved.')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // A customer leaves a checkout; Shopify records that they subscribed to WhatsApp marketing.
  const customer = randomWaId();
  const subscribedAt = new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  await control(request, `${SHOPIFY}/__stand-in/checkout`, {
    shop,
    checkout: {
      id: '8101',
      name: '#C8101',
      total: { amount: '2499.00', currencyCode: 'INR' },
      lineItems: [
        { title: 'Lavender candle', variantTitle: 'Large', quantity: 2 },
        { title: 'Wick trimmer', variantTitle: null, quantity: 1 },
      ],
      shippingAddress: { name: 'Nila Customer', phone: null },
      customer: {
        id: '66001',
        displayName: 'Nila Customer',
        phone: `+${customer}`,
        consent: {
          state: 'SUBSCRIBED',
          optInLevel: 'SINGLE_OPT_IN',
          collectedFrom: 'SHOPIFY',
          updatedAt: subscribedAt,
        },
      },
    },
  });

  // HyFib reads the store's checkouts every 15 minutes; "Read the store now" reads them at once.
  // The reminder waits for its time.
  await readStoreNow(page, storeUrl);
  await reloadUntil(page, () => page.getByText('#C8101'), 45_000);
  const row = page.getByRole('row').filter({ hasText: '#C8101' });
  await expect(row).toContainText('Cart reminder');
  await expect(row).toContainText('Waiting');
  await expect(row).toContainText('Due ');

  // The shortest wait is 30 minutes, so the test brings the reminder forward; the worker sends it.
  expect(await bringWaitingMessagesForward(tenantId)).toBe(1);
  let sent: { wamid?: string; body: unknown } | undefined;
  await expect(async () => {
    sent = (await standInRequests(request)).find(
      (r) => r.path.endsWith('/messages') && (r.body as { to?: string }).to === customer,
    );
    expect(sent?.wamid).toBeTruthy();
  }).toPass({ timeout: 120_000 });
  const template = (sent?.body as { template: { name: string; components: unknown[] } }).template;
  expect(template.name).toBe('cart_nudge');
  expect(template.components).toEqual([
    {
      type: 'body',
      parameters: [
        { type: 'text', text: 'Nila Customer' },
        { type: 'text', text: 'Lavender candle (Large) and 1 more' },
        { type: 'text', text: `https://${shop}/checkouts/8101/recover?key=k8101` },
      ],
    },
  ]);
  await reloadUntil(page, () => row.getByText('Sent', { exact: true }));
  const report = page.getByLabel('Cart reminders in the last 30 days');
  await expect(report).toContainText('Reminders sent (30 days): 1');
  await expect(report).toContainText('Checkouts recovered: 0');
  const messagesUrl = page.url();

  // The customer's contact carries the opt-in the store recorded, with Shopify's time.
  await page.goto(`/c/${slug}/contacts`);
  await page.getByRole('link', { name: 'Nila Customer' }).click();
  await expect(page.getByRole('heading', { name: 'Nila Customer', level: 1 })).toBeVisible();
  await expect(page.getByText('Marketing: opted in').first()).toBeVisible();
  await expect(page.getByRole('cell', { name: /Recorded by the store/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.goto(messagesUrl);

  // The customer completes the checkout after the reminder: recovered, with the checkout's total.
  const completedAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 2000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  await control(request, `${SHOPIFY}/__stand-in/checkout`, {
    shop,
    checkout: { id: '8101', completedAt, updatedAt: completedAt },
  });
  await readStoreNow(page, storeUrl);
  await reloadUntil(page, () => report.getByText('Checkouts recovered: 1'), 45_000);
  await expect(report).toContainText('Recovered value: ₹2,499.00');
  await expectNoHorizontalOverflow(page);
});

test('a store’s order starts an automation that sends a template, waits for the customer’s tap and answers with the order’s details', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const { slug, wabaId, phoneNumberId } = await newCompany(page, 'storebot', 'Tara Tea');
  await approvedTemplate(page, request, slug, wabaId, {
    name: 'order_followup',
    body: 'Hi {{1}}, thanks for order {{2}}. Need anything?',
    examples: ['Asha', '#1001'],
    quickReplies: ['Track order', 'Talk to us'],
  });
  const shop = `tara-${Date.now().toString(36)}.myshopify.com`;
  await openStores(page);
  await page.getByLabel('Shopify store').fill(shop);
  await page.getByRole('button', { name: 'Connect with Shopify' }).click();
  await expect(page).toHaveURL(/\/commerce\/stores\/[0-9a-f-]{36}$/);
  await reloadUntil(page, () => page.getByText('Connected', { exact: true }));
  const storeUrl = page.url();
  await page.getByRole('link', { name: 'Order messages' }).click();
  const settings = page.getByRole('form', { name: 'Message settings' });
  await settings.getByLabel(/customers agreed to receive order messages/).check();
  await settings.getByRole('button', { name: 'Save settings' }).click();
  await expect(settings.getByText('Settings saved.')).toBeVisible();

  // The automation: started by order messages, it asks with the template first (only templates
  // reach a customer who has not written) and answers "Track order" with the order's details.
  await openFromNav(page, 'Automations');
  await page.getByLabel('Name', { exact: true }).fill('Order follow-up');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Order follow-up' })).toBeVisible();
  await page.getByLabel('Start when').selectOption('store_event');
  await expect(page.getByText(/only templates until the customer replies/).first()).toBeVisible();
  await page.getByLabel('Add a step').selectOption('ask_template');
  await page.getByRole('button', { name: 'Add step' }).click();
  await expect(page.locator('#step-ask-template-1-template')).toHaveValue(/[0-9a-f-]{36}/);
  await page.locator('#step-ask-template-1-body-0').fill('{{order.customer_name}}');
  await page.locator('#step-ask-template-1-body-1').fill('{{order.number}}');
  await page.getByLabel('First step', { exact: true }).selectOption('ask-template-1');
  await page.getByRole('button', { name: 'Delete step welcome' }).click();
  await page.getByLabel('Add a step').selectOption('send_text');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page
    .locator('#step-send-text-1-text')
    .fill('Order {{order.number}} ({{order.items}}): {{order.status_url}}');
  await page.locator('#step-ask-template-1-button-0').selectOption('send-text-1');
  await expect(page.getByText(/to fix before publishing/)).toBeHidden();
  await expectNoHorizontalOverflow(page);
  // The simulator reads a sample order and offers the template's quick replies.
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByText('Hi Asha, thanks for order #1001. Need anything?')).toBeVisible();
  await page.getByRole('button', { name: 'Track order', exact: true }).click();
  await expect(
    page.getByText('Order #1001 (Darjeeling tea and 2 more): https://shop.example/orders/1001'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/Version 1 is live/)).toBeVisible();
  await expect(page.getByText('No store rule starts it yet.')).toBeVisible();

  // The store's "Order placed" rule starts it.
  await page.goto(storeUrl);
  await page.getByRole('link', { name: 'Order messages' }).click();
  const placed = page.getByRole('form', { name: 'Order placed' });
  await placed.getByLabel('What happens').selectOption('automation');
  await placed.getByLabel('Automation', { exact: true }).selectOption({ label: 'Order follow-up' });
  await placed.getByLabel('Start the automation').check();
  await placed.getByRole('button', { name: 'Save' }).click();
  await expect(placed.getByText('Saved.')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // A new order: HyFib reads it, starts the automation, and the template goes out with the order's
  // values and a payload per quick reply, although the customer never wrote.
  const customer = randomWaId();
  await control(request, `${SHOPIFY}/__stand-in/order`, {
    shop,
    order: {
      id: '7201',
      name: '#1201',
      phone: `+${customer}`,
      total: { amount: '1499.00', currencyCode: 'INR' },
      shippingAddress: { name: 'Meena Customer', phone: null },
      lineItems: [
        {
          name: 'Assam tea',
          sku: 'A',
          quantity: 1,
          total: { amount: '1499.00', currencyCode: 'INR' },
        },
      ],
    },
  });
  await control(request, `${SHOPIFY}/__stand-in/deliver`, {
    shop,
    topic: 'orders/create',
    payload: { id: 7201, admin_graphql_api_id: 'gid://shopify/Order/7201' },
  });
  let sent: { wamid?: string; body: unknown } | undefined;
  await expect(async () => {
    sent = (await standInRequests(request)).find(
      (r) => r.path.endsWith('/messages') && (r.body as { to?: string }).to === customer,
    );
    expect(sent?.wamid).toBeTruthy();
  }).toPass({ timeout: 60_000 });
  const template = (sent?.body as { template: { name: string; components: unknown[] } }).template;
  expect(template.name).toBe('order_followup');
  expect(template.components).toContainEqual({
    type: 'body',
    parameters: [
      { type: 'text', text: 'Meena Customer' },
      { type: 'text', text: '#1201' },
    ],
  });
  const buttons = template.components.filter((c) => (c as { type: string }).type === 'button') as {
    index: string;
    parameters: { payload: string }[];
  }[];
  expect(buttons.map((b) => b.index)).toEqual(['0', '1']);
  const track = buttons[0]?.parameters[0]?.payload ?? '';
  expect(track).toMatch(/^w360bot:[0-9a-f-]{36}:ask-template-1:1:0$/);

  // The customer taps "Track order": the automation answers with the order's details.
  await sendSignedWebhook(
    request,
    templateButtonReply(
      wabaId,
      phoneNumberId,
      customer,
      { payload: track, text: 'Track order' },
      String(sent?.wamid),
    ),
  );
  await expect
    .poll(
      async () =>
        (await standInRequests(request))
          .filter((r) => (r.body as { to?: string } | null | undefined)?.to === customer)
          .map((r) => (r.body as { text?: { body?: string } }).text?.body ?? null)
          .filter(Boolean),
      { timeout: 60_000 },
    )
    .toEqual([`Order #1201 (Assam tea): https://${shop}/orders/status/7201`]);

  // The report shows the automation it started and its outcome; the run page names the order.
  const row = page.getByRole('row').filter({ hasText: '#1201' });
  await reloadUntil(page, () => row.getByText('Completed'), 45_000);
  await expect(row.getByText('Automation started', { exact: true })).toBeVisible();
  await row.getByRole('link', { name: 'Order follow-up' }).click();
  await expect(page.getByRole('heading', { name: 'Run of Order follow-up' })).toBeVisible();
  await expect(page.getByText('Started by a new order:')).toBeVisible();
  await expect(page.getByRole('link', { name: '#1201' })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Got an answer → Track order');
  await expectNoHorizontalOverflow(page);
});
