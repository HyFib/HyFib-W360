import { createHmac, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './fixtures';
import { expectNoHorizontalOverflow, signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';
/** Resolves to 127.0.0.1 on the test machine; see webhooks.spec.ts. */
const HOST = process.env.E2E_HTTP_HOST ?? '';

test.skip(
  !HOST || process.env.W360_EGRESS_ALLOW_LOOPBACK !== 'true',
  'Webhook receiver not provided (E2E_HTTP_HOST resolving to 127.0.0.1, W360_EGRESS_ALLOW_LOOPBACK)',
);

let receiver: Server;
let port = 0;
const received: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];

test.beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body });
      res.writeHead(204);
      res.end();
    });
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  port = (receiver.address() as AddressInfo).port;
});

test.afterAll(() => {
  receiver?.close();
});

function signatureValid(headers: IncomingHttpHeaders, body: string, secret: string): boolean {
  const header = String(headers['w360-signature'] ?? '');
  const t = /^t=(\d+)/.exec(header)?.[1];
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'));
  return header
    .split(',')
    .filter((part) => part.startsWith('v1='))
    .some((part) => {
      const given = Buffer.from(part.slice(3));
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}

interface ApiContactBody {
  id: string;
  name: string | null;
  phone: string | null;
  tags: string[];
  fields: Record<string, string | number | boolean>;
}

test('a key sets and changes a contact’s custom fields, the contact page shows them, and every change reaches an endpoint with the fields (ADR-112)', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('apifields');
  const slug = `apifields-${Date.now().toString(36)}`;
  const path = `/fields/${slug}`;
  await signUpAndVerify(page, { name: 'Farah Fields', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Field Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));

  // Two custom fields.
  await page.goto(`/c/${slug}/settings/messaging`);
  await page.getByLabel('New field').fill('City');
  await page.getByRole('button', { name: 'Add field' }).click();
  await expect(page.getByRole('cell', { name: 'city', exact: true })).toBeVisible();
  await page.getByLabel('New field').fill('Orders');
  await page.getByLabel('Type', { exact: true }).selectOption('number');
  await page.getByRole('button', { name: 'Add field' }).click();
  await expect(page.getByRole('cell', { name: 'orders', exact: true })).toBeVisible();

  // An endpoint for contact changes.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${path}`);
  await page.getByRole('checkbox', { name: /Contact changed/ }).check();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  const secretField = page.getByLabel('Signing secret');
  await expect(secretField).toBeVisible();
  const secret = await secretField.inputValue();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();
  // And one for the changes of the Orders field only (ADR-184).
  const ordersPath = `${path}/orders`;
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${ordersPath}`);
  await page.getByRole('checkbox', { name: /Contact changed/ }).check();
  await page.getByRole('radio', { name: /Only the changes of the fields ticked/ }).check();
  await page.getByRole('checkbox', { name: 'Orders (orders)', exact: true }).check();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  await expect(page.getByLabel('Signing secret')).toBeVisible();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();
  await page.reload();
  await expect(
    page.getByText('Custom fields whose changes are sent: Orders (orders)'),
  ).toBeVisible();

  // A key that reads and changes contacts.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('CRM sync');
  await page.getByRole('checkbox', { name: /Read contacts/ }).check();
  await page
    .getByRole('checkbox', { name: /Create and change contacts and record consent/ })
    .check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const tokenField = page.getByLabel('API key', { exact: true });
  await expect(tokenField).toBeVisible();
  const token = await tokenField.inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const auth = { Authorization: `Bearer ${token}` };

  // The key reads the fields' keys and types, then adds a contact with a value.
  const fields = await request.get('/api/v1/contact-fields', { headers: auth });
  expect(fields.status()).toBe(200);
  expect(
    ((await fields.json()) as { data: { key: string; label: string; type: string }[] }).data.map(
      (f) => [f.key, f.label, f.type],
    ),
  ).toEqual([
    ['city', 'City', 'text'],
    ['orders', 'Orders', 'number'],
  ]);
  const phone = `+9197${String(Date.now()).slice(-8)}`;
  const created = await request.post('/api/v1/contacts', {
    headers: auth,
    data: { phone, name: 'Gita', fields: { city: 'Pune' } },
  });
  expect(created.status()).toBe(201);
  const contact = ((await created.json()) as { data: ApiContactBody }).data;
  expect(contact.fields).toEqual({ city: 'Pune' });

  // A value of another type is refused by name; a number and a tag are saved together.
  const refused = await request.patch(`/api/v1/contacts/${contact.id}`, {
    headers: auth,
    data: { fields: { orders: 'three' } },
  });
  expect(refused.status()).toBe(422);
  expect(((await refused.json()) as { error: { issues: unknown } }).error.issues).toEqual([
    { path: 'fields.orders', message: 'Orders takes a number.' },
  ]);
  const changed = await request.patch(`/api/v1/contacts/${contact.id}`, {
    headers: auth,
    data: { fields: { orders: 3 }, addTags: ['VIP'] },
  });
  expect(changed.status()).toBe(200);
  expect(((await changed.json()) as { data: ApiContactBody }).data).toMatchObject({
    fields: { city: 'Pune', orders: 3 },
    tags: ['vip'],
  });

  // The key finds the contact by a field value and a tag (ADR-113).
  const found = await request.get(
    `/api/v1/contacts?${new URLSearchParams({ 'fields[orders]': '3', tag: 'VIP' }).toString()}`,
    { headers: auth },
  );
  expect(found.status()).toBe(200);
  expect(((await found.json()) as { data: ApiContactBody[] }).data.map((c) => c.id)).toEqual([
    contact.id,
  ]);
  const unknown = await request.get('/api/v1/contacts?fields%5Bnope%5D=1', { headers: auth });
  expect(unknown.status()).toBe(422);

  // The contact page shows the values; a member changes the city.
  await page.goto(`/c/${slug}/contacts/${contact.id}`);
  await expect(page.getByLabel('City', { exact: true })).toHaveValue('Pune');
  await expect(page.getByLabel('Orders', { exact: true })).toHaveValue('3');
  await expect(page.getByRole('list', { name: 'Tags' })).toContainText('vip');
  await expectNoHorizontalOverflow(page);
  await page.getByLabel('City', { exact: true }).fill('Delhi');
  await page.getByRole('button', { name: 'Save contact' }).click();
  await expect(page.getByText('Contact saved.')).toBeVisible();

  // Both changes reach the endpoint, signed. A payload is built when it is delivered, so the
  // last one carries the member's city.
  const forUs = () =>
    received
      .filter((r) => r.path === path)
      .map((r) => ({
        ...r,
        json: JSON.parse(r.body) as { type: string; data: { contact: ApiContactBody } },
      }));
  await expect(async () => expect(forUs()).toHaveLength(2)).toPass({ timeout: 60_000 });
  for (const r of forUs()) {
    expect(signatureValid(r.headers, r.body, secret)).toBe(true);
    expect(r.json.type).toBe('contact.updated');
    expect(r.json.data.contact.id).toBe(contact.id);
  }
  expect(forUs().at(-1)?.json.data.contact.fields).toEqual({ city: 'Delhi', orders: 3 });
  // The Orders endpoint hears the key's change of orders (and the tag saved with it), not the
  // member's change of the city.
  const forOrders = () =>
    received
      .filter((r) => r.path === ordersPath)
      .map((r) => JSON.parse(r.body) as { type: string; data: { changes: string[] } });
  await expect(async () => expect(forOrders()).toHaveLength(1)).toPass({ timeout: 60_000 });
  expect(forOrders()[0]).toMatchObject({
    type: 'contact.updated',
    data: { changes: ['fields.orders', 'tags'] },
  });

  // The key reads the member's change.
  const read = await request.get(`/api/v1/contacts/${contact.id}`, { headers: auth });
  expect(((await read.json()) as { data: ApiContactBody }).data.fields).toEqual({
    city: 'Delhi',
    orders: 3,
  });
});

test('a key changes several contacts in one call, all of them or none, a number included but never swapped, and the contact pages show it (ADR-122, ADR-188)', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('apibulk');
  const slug = `apibulk-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Bela Bulk', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Bulk Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));

  await page.goto(`/c/${slug}/settings/messaging`);
  await page.getByLabel('New field').fill('Plan');
  await page.getByRole('button', { name: 'Add field' }).click();
  await expect(page.getByRole('cell', { name: 'plan', exact: true })).toBeVisible();

  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Webinar sync');
  await page.getByRole('checkbox', { name: /Read contacts/ }).check();
  await page
    .getByRole('checkbox', { name: /Create and change contacts and record consent/ })
    .check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const tokenField = page.getByLabel('API key', { exact: true });
  await expect(tokenField).toBeVisible();
  const token = await tokenField.inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const auth = { Authorization: `Bearer ${token}` };

  const add = async (name: string, suffix: string) => {
    const created = await request.post('/api/v1/contacts', {
      headers: auth,
      data: { phone: `+9196${String(Date.now()).slice(-7)}${suffix}`, name },
    });
    expect(created.status()).toBe(201);
    return ((await created.json()) as { data: ApiContactBody }).data;
  };
  const asha = await add('Asha', '1');
  const bina = await add('Bina', '2');

  // One bad change refuses the call by its place, and neither contact changes.
  const refused = await request.post('/api/v1/contacts/update-many', {
    headers: auth,
    data: {
      contacts: [
        { id: asha.id, name: 'Asha Rao' },
        { id: bina.id, fields: { plan: 3 } },
      ],
    },
  });
  expect(refused.status()).toBe(422);
  expect(((await refused.json()) as { error: { issues: unknown } }).error.issues).toEqual([
    { path: 'contacts.1.fields.plan', message: 'Plan takes text.' },
  ]);
  const read = async (id: string) =>
    (
      (await (await request.get(`/api/v1/contacts/${id}`, { headers: auth })).json()) as {
        data: ApiContactBody;
      }
    ).data;
  expect((await read(asha.id)).name).toBe('Asha');

  // Both changed in one call, answered in the order given.
  const changed = await request.post('/api/v1/contacts/update-many', {
    headers: auth,
    data: {
      contacts: [
        { id: bina.id, fields: { plan: 'gold' }, addTags: ['Webinar'] },
        { id: asha.id, name: 'Asha Rao', addTags: ['webinar'] },
      ],
    },
  });
  expect(changed.status()).toBe(200);
  const data = ((await changed.json()) as { data: ApiContactBody[] }).data;
  expect(data.map((c) => [c.id, c.name, c.tags, c.fields])).toEqual([
    [bina.id, 'Bina', ['webinar'], { plan: 'gold' }],
    [asha.id, 'Asha Rao', ['webinar'], {}],
  ]);

  // Such a call fixes typed numbers too (ADR-188), but never swaps two contacts' numbers.
  const swapped = await request.post('/api/v1/contacts/update-many', {
    headers: auth,
    data: {
      contacts: [
        { id: asha.id, phone: bina.phone },
        { id: bina.id, phone: asha.phone },
      ],
    },
  });
  expect(swapped.status()).toBe(409);
  expect(((await swapped.json()) as { error: { issues: unknown } }).error.issues).toEqual([
    { path: 'contacts.0.phone', message: 'Another contact already has this phone number.' },
  ]);
  expect((await read(asha.id)).phone).toBe(asha.phone);
  const fixedPhone = `+9197${String(Date.now()).slice(-7)}3`;
  const fixed = await request.post('/api/v1/contacts/update-many', {
    headers: auth,
    data: { contacts: [{ id: bina.id, phone: fixedPhone }] },
  });
  expect(fixed.status()).toBe(200);
  expect(((await fixed.json()) as { data: ApiContactBody[] }).data.map((c) => c.phone)).toEqual([
    fixedPhone,
  ]);

  // The contact pages show the changes.
  await page.goto(`/c/${slug}/contacts/${asha.id}`);
  await expect(page.getByRole('heading', { name: 'Asha Rao', level: 1 })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Tags' })).toContainText('webinar');
  await page.goto(`/c/${slug}/contacts/${bina.id}`);
  await expect(page.getByText(fixedPhone, { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel('Plan', { exact: true })).toHaveValue('gold');
  await expect(page.getByRole('list', { name: 'Tags' })).toContainText('webinar');
  await expectNoHorizontalOverflow(page);
});
