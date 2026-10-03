import { expect, test } from './fixtures';
import { signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

interface Page {
  data: { name: string | null }[];
  nextCursor: string | null;
}

test('a key finds contacts with segment conditions: comparisons, tags, all or any (ADR-117)', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail('apisearch');
  const slug = `apisearch-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Jaya Search', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Search Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));

  // A key that defines fields, adds contacts and reads them.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('CRM search');
  await page.getByRole('checkbox', { name: /Define contact fields/ }).check();
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

  // Two fields and three contacts.
  for (const field of [
    { label: 'Orders', type: 'number' },
    { label: 'City', type: 'text' },
  ]) {
    const added = await request.post('/api/v1/contact-fields', { headers: auth, data: field });
    expect(added.status()).toBe(201);
  }
  const stamp = String(Date.now()).slice(-6);
  for (const [n, contact] of [
    { name: 'Asha', fields: { orders: 2, city: 'Pune' }, tags: ['vip'] },
    { name: 'Bina', fields: { orders: 7, city: 'Pune' } },
    { name: 'Chitra', fields: { orders: 12, city: 'Delhi' }, tags: ['vip'] },
  ].entries()) {
    const created = await request.post('/api/v1/contacts', {
      headers: auth,
      data: { phone: `+91974${stamp}${n}`, ...contact },
    });
    expect(created.status()).toBe(201);
  }

  const search = async (body: Record<string, unknown>) => {
    const res = await request.post('/api/v1/contacts/search', { headers: auth, data: body });
    expect(res.status()).toBe(200);
    return (await res.json()) as Page;
  };
  // More than 5 orders and without the tag vip; then city Pune or the tag vip, newest first.
  const busy = await search({
    conditions: [
      { type: 'field', key: 'orders', op: 'greater_than', value: 5 },
      { type: 'tag', op: 'not_has', tag: 'VIP' },
    ],
  });
  expect([busy.data.map((c) => c.name), busy.nextCursor]).toEqual([['Bina'], null]);
  const any = await search({
    match: 'any',
    conditions: [
      { type: 'field', key: 'city', op: 'equals', value: 'pune' },
      { type: 'tag', op: 'has', tag: 'vip' },
    ],
  });
  expect(any.data.map((c) => c.name)).toEqual(['Chitra', 'Bina', 'Asha']);

  // A comparison the field's type does not take is refused, naming it.
  const refused = await request.post('/api/v1/contacts/search', {
    headers: auth,
    data: { conditions: [{ type: 'field', key: 'city', op: 'greater_than', value: 'a' }] },
  });
  expect(refused.status()).toBe(422);
  expect(((await refused.json()) as { error: { issues: unknown } }).error.issues).toEqual([
    {
      path: 'conditions.0.op',
      message:
        'greater_than does not apply to text fields: use is_set, is_not_set, equals, not_equals, contains.',
    },
  ]);
  // The search has its own route: reading it is not reading a contact.
  expect((await request.get('/api/v1/contacts/search', { headers: auth })).status()).toBe(405);
});
