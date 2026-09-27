import type { APIRequestContext, Page } from '@playwright/test';
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
 * read again, and removal.
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

/** An approved utility template, created in the Templates pages and approved by the stand-in. */
async function approvedTemplate(
  page: Page,
  request: APIRequestContext,
  slug: string,
  wabaId: string,
  t: { name: string; body: string; examples: string[]; quickReplies: string[] },
) {
  await page.goto(`/c/${slug}/templates/new`);
  await page.getByLabel('Name').fill(t.name);
  await page.getByLabel('Language code').fill('en');
  await page.getByLabel('Category').selectOption('UTILITY');
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
