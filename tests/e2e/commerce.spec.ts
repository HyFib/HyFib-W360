import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  connectTestChannel,
  inboundMessage,
  messagingConfigured,
  orderMessage,
  randomWaId,
  sendSignedWebhook,
  standInRequests,
} from './messaging-support';
import { expectNoHorizontalOverflow, openFromNav, signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';
const GRAPH = `http://127.0.0.1:${process.env.E2E_GRAPH_PORT ?? ''}`;
const RAZORPAY = `http://127.0.0.1:${process.env.E2E_RAZORPAY_PORT ?? ''}`;

test.skip(
  !messagingConfigured || !process.env.E2E_RAZORPAY_PORT,
  'Meta and Razorpay test configuration (stand-ins, app secret) not provided',
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

async function openTab(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Commerce sections' })
    .getByRole('link', { name })
    .click();
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

/** The first message the Graph stand-in accepted for `to` that matches `pick`. */
async function sentTo(
  request: APIRequestContext,
  to: string,
  pick: (body: Record<string, unknown>) => boolean,
) {
  let found: Record<string, unknown> | undefined;
  await expect
    .poll(
      async () => {
        const sent = (await standInRequests(request)).find((r) => {
          const body = (r.body ?? {}) as Record<string, unknown>;
          return Boolean(r.wamid) && body.to === to && pick(body);
        });
        found = sent?.body as Record<string, unknown> | undefined;
        return Boolean(found);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return found!;
}

/** A webhook signed as the company's Razorpay account signs it (HMAC-SHA256 of the raw body). */
async function paymentWebhook(
  request: APIRequestContext,
  path: string,
  secret: string,
  eventId: string,
  body: unknown,
) {
  const raw = JSON.stringify(body);
  return request.post(path, {
    data: raw,
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex'),
      'x-razorpay-event-id': eventId,
    },
  });
}

test('a catalog is read from Meta, products are sent in a chat and an order is paid through the company’s Razorpay account', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const { slug, wabaId, phoneNumberId } = await newCompany(page, 'shop', 'Sana Shop');
  const catalogId = String(randomInt(100_000_000, 999_999_999));
  const keyId = `rzp_test_${randomBytes(8).toString('hex')}`;
  const keySecret = randomBytes(18).toString('hex');
  const webhookSecret = randomBytes(18).toString('hex');

  // The company's catalog at Meta (Commerce Manager) and its own Razorpay account.
  const catalogRes = await request.post(`${GRAPH}/__stand-in/catalog`, {
    data: {
      wabaId,
      catalog: { id: catalogId, name: 'Tea house', product_count: 3 },
      products: [
        ['chai-1', 'Masala chai', '₹120.00'],
        ['chai-2', 'Ginger biscuits', '₹80.50'],
        ['chai-3', 'Clay cup', '₹45.00'],
      ].map(([retailerId, name, price], i) => ({
        id: String(700_000 + i),
        retailer_id: retailerId,
        name,
        price,
        currency: 'INR',
        availability: 'in stock',
        review_status: 'approved',
      })),
    },
  });
  expect(catalogRes.ok()).toBe(true);
  const merchantRes = await request.post(`${RAZORPAY}/__stand-in/merchant`, {
    data: { key_id: keyId, key_secret: keySecret },
  });
  expect(merchantRes.ok()).toBe(true);

  // Commerce → Catalogs: the owner asks HyFib to read the catalog from Meta.
  await openFromNav(page, 'Commerce');
  await expect(page.getByText('No orders yet')).toBeVisible();
  await openTab(page, 'Catalogs');
  await page.getByRole('button', { name: 'Read from Meta' }).click();
  await reloadUntil(page, () => page.getByText('3 of 3 at Meta'));
  await page.getByRole('link', { name: 'Tea house' }).click();
  await expect(page.getByRole('cell', { name: /Masala chai/ })).toBeVisible();
  await page.getByLabel('Search', { exact: true }).fill('biscuit');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('cell', { name: /Ginger biscuits/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /Masala chai/ })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  // A customer writes; a product is sent in the conversation while the service window is open.
  const customer = randomWaId();
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, customer, 'What tea do you have?'),
  );
  await openFromNav(page, 'Inbox');
  await page.getByRole('link', { name: /Priya Customer/ }).click({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Send products' })).toBeVisible();
  const conversationUrl = page.url();
  await page
    .getByLabel('Product', { exact: true })
    .selectOption({ label: 'Masala chai · ₹120.00' });
  await page.getByLabel('Message (optional)').fill('Our best seller');
  await page.getByRole('button', { name: 'Send product' }).click();
  await expect(page.getByText('Products sent.')).toBeVisible();
  const thread = page.getByRole('list', { name: /^Messages with/ });
  await expect(thread.getByText('Our best seller')).toBeVisible();
  const product = await sentTo(
    request,
    customer,
    (b) => (b.interactive as { type?: string } | undefined)?.type === 'product',
  );
  expect((product.interactive as { action: unknown }).action).toEqual({
    catalog_id: catalogId,
    product_retailer_id: 'chai-1',
  });
  // Several products at once: a product list with a heading.
  await page.getByLabel('Send', { exact: true }).selectOption({ label: 'Several products' });
  await page.getByLabel('Ginger biscuits · ₹80.50').check();
  await page.getByLabel('Clay cup · ₹45.00').check();
  await expect(page.getByText('Products (2 of at most 30)')).toBeVisible();
  await page.getByLabel('Heading', { exact: true }).fill('Tea time');
  await page.getByLabel('Message', { exact: true }).fill('Goes well with chai');
  await page.getByRole('button', { name: 'Send products' }).click();
  await expect(thread.getByText('Goes well with chai')).toBeVisible();
  const list = await sentTo(
    request,
    customer,
    (b) => (b.interactive as { type?: string } | undefined)?.type === 'product_list',
  );
  expect((list.interactive as { action: unknown }).action).toEqual({
    catalog_id: catalogId,
    sections: [
      { product_items: [{ product_retailer_id: 'chai-2' }, { product_retailer_id: 'chai-3' }] },
    ],
  });
  await expectNoHorizontalOverflow(page);

  // An integration sends a product through the API with a key created in settings (ADR-086).
  // The live inbox is left through the navigation, not a page load (see openFromNav).
  await openFromNav(page, 'Settings');
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'API keys' })
    .click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}/settings/api-keys$`));
  await page.getByLabel('Name', { exact: true }).fill('Shop');
  await page
    .getByRole('checkbox', { name: /Reply with text, buttons, lists, products and reactions/ })
    .check();
  await page.getByRole('checkbox', { name: /Read WhatsApp orders/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const viaApi = await request.post('/api/v1/messages', {
    headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() },
    data: { type: 'product', to: `+${customer}`, retailerId: 'chai-2', body: 'Fresh today' },
  });
  expect(viaApi.status()).toBe(201);
  const apiProduct = await sentTo(
    request,
    customer,
    (b) =>
      (b.interactive as { action?: { product_retailer_id?: unknown } } | undefined)?.action
        ?.product_retailer_id === 'chai-2',
  );
  expect((apiProduct.interactive as { action: unknown }).action).toEqual({
    catalog_id: catalogId,
    product_retailer_id: 'chai-2',
  });
  // The chat shows it with the key's name, as it shows the products members send.
  await page.goto(conversationUrl);
  await expect(thread.getByText('Fresh today')).toBeVisible();
  await expect(thread.getByText('· API (Shop)')).toBeVisible();

  // The customer sends a cart: the order appears in the chat with an exact total.
  await sendSignedWebhook(
    request,
    orderMessage(wabaId, phoneNumberId, customer, {
      catalogId,
      text: 'Please deliver after 6 pm',
      items: [
        { retailerId: 'chai-1', quantity: 2, price: 120 },
        { retailerId: 'chai-2', quantity: 1, price: 80.5 },
      ],
    }),
  );
  await expect(thread.getByText('3 items · ₹320.50')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('link', { name: /^[A-HJ-NP-Z2-9]{8}$/ }).click({ timeout: 20_000 });
  await expect(page.getByRole('cell', { name: /Masala chai/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: '₹320.50' })).toBeVisible();
  await expect(page.getByText('Please deliver after 6 pm')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm order' }).click();
  await expect(page.getByText('Confirmed', { exact: true }).first()).toBeVisible();
  const orderUrl = page.url();

  // Payment needs the company's own Razorpay keys, checked with Razorpay.
  await expect(
    page.getByText('Add your Razorpay account in Commerce → Payments first.'),
  ).toBeVisible();
  await openTab(page, 'Payments');
  await page.getByLabel('Key id').fill(keyId);
  await page.getByLabel('Key secret').fill(keySecret);
  await page.getByLabel('Webhook secret').fill(webhookSecret);
  await page.getByRole('button', { name: 'Save keys' }).click();
  await expect(page.getByText(/HyFib is checking the keys with Razorpay/)).toBeVisible();
  await reloadUntil(page, () => page.getByText('Working', { exact: true }));
  await expect(page.getByLabel('Key secret')).toHaveValue('');
  const webhookPath = new URL(await page.getByLabel('Webhook address').inputValue()).pathname;
  expect(webhookPath).toMatch(/^\/api\/webhooks\/razorpay-links\/[a-z2-7]{16}$/);
  await expectNoHorizontalOverflow(page);

  // Request payment: the link is created once and sent in the chat.
  await page.goto(orderUrl);
  await page.getByRole('button', { name: 'Request payment' }).click();
  await expect(page.getByText(/Create a Payment Link for ₹320.50/)).toBeVisible();
  await page.getByRole('button', { name: 'Yes, request payment' }).click();
  await expect(page.getByText(/Create a Payment Link for/)).toHaveCount(0);
  await reloadUntil(page, () => page.getByLabel('Payment Link', { exact: true }));
  const shortUrl = await page.getByLabel('Payment Link', { exact: true }).inputValue();
  const linkMessage = await sentTo(request, customer, (b) => b.type === 'text');
  expect((linkMessage.text as { body: string }).body).toMatch(
    new RegExp(
      `^Pay ₹320\\.50 for order [A-HJ-NP-Z2-9]{8}: ${shortUrl.replace(/[.?/]/g, '\\$&')}$`,
    ),
  );
  const linksRes = await request.get(`${RAZORPAY}/__stand-in/payment-links?key_id=${keyId}`);
  const { payment_links: links } = (await linksRes.json()) as {
    payment_links: { id: string; amount: number; reference_id: string }[];
  };
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({ amount: 32050 });

  // A forged notification is refused; a signed one only makes HyFib fetch the link, which is
  // still unpaid, so nothing changes.
  const early = await paymentWebhook(request, webhookPath, webhookSecret, `evt_${Date.now()}a`, {
    event: 'payment_link.paid',
    payload: { payment_link: { entity: { id: links[0]!.id, status: 'paid' } } },
  });
  expect(early.status()).toBe(200);
  const forged = await paymentWebhook(
    request,
    webhookPath,
    'not-the-secret',
    `evt_${Date.now()}b`,
    {
      event: 'payment_link.paid',
      payload: { payment_link: { entity: { id: links[0]!.id } } },
    },
  );
  expect(forged.status()).toBe(400);
  await page.reload();
  await expect(page.getByText('Waiting for payment').first()).toBeVisible();

  // The customer pays; Razorpay notifies HyFib, which fetches the link and records the payment.
  const paid = await request.post(`${RAZORPAY}/__stand-in/pay-link`, {
    data: { id: links[0]!.id },
  });
  expect(paid.ok()).toBe(true);
  const eventId = `evt_${Date.now()}c`;
  const notice = {
    event: 'payment_link.paid',
    payload: { payment_link: { entity: { id: links[0]!.id } } },
  };
  expect(
    (await paymentWebhook(request, webhookPath, webhookSecret, eventId, notice)).status(),
  ).toBe(200);
  // A redelivery of the same event is accepted and does nothing twice.
  expect(
    (await paymentWebhook(request, webhookPath, webhookSecret, eventId, notice)).status(),
  ).toBe(200);
  // A check that found the link busy is retried after 30 seconds.
  await reloadUntil(page, () => page.getByRole('button', { name: 'Mark fulfilled' }), 60_000);

  // An order system reads the paid order through the API with the same key (ADR-167): the cart,
  // the total in paise and when it was paid, never the Payment Link.
  const auth = { Authorization: `Bearer ${token}` };
  const paidOrders = await request.get('/api/v1/orders?status=paid', { headers: auth });
  expect(paidOrders.status()).toBe(200);
  const listed = (await paidOrders.json()) as {
    data: {
      id: string;
      status: string;
      subtotalMinor: number | null;
      customerNote: string | null;
      paidAt: string | null;
      items: { retailerId: string; quantity: number; unitPriceMinor: number | null }[];
    }[];
    nextCursor: string | null;
  };
  expect(listed.data).toHaveLength(1);
  const apiOrder = listed.data[0]!;
  expect(new URL(orderUrl).pathname.endsWith(`/commerce/orders/${apiOrder.id}`)).toBe(true);
  expect(apiOrder).toMatchObject({
    status: 'paid',
    subtotalMinor: 32050,
    customerNote: 'Please deliver after 6 pm',
    paidAt: expect.any(String),
  });
  expect(apiOrder.items.map((i) => [i.retailerId, i.quantity, i.unitPriceMinor])).toEqual([
    ['chai-1', 2, 12000],
    ['chai-2', 1, 8050],
  ]);
  expect(JSON.stringify(listed)).not.toContain(shortUrl);
  const one = await request.get(`/api/v1/orders/${apiOrder.id}`, { headers: auth });
  expect(((await one.json()) as { data: unknown }).data).toEqual(apiOrder);
  await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Mark fulfilled' }).click();
  await expect(page.getByText('Fulfilled', { exact: true }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // The order list shows it fulfilled.
  await openTab(page, 'Orders');
  await expect(page.getByRole('cell', { name: 'Fulfilled' })).toBeVisible();
});
