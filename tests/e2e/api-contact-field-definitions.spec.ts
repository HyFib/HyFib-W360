import { expect, test } from './fixtures';
import { signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

interface FieldBody {
  key: string;
  label: string;
  type: string;
}

test('a key adds, renames and deletes a custom field, and members see each change (ADR-115)', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail('apifielddefs');
  const slug = `apifielddefs-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Indira Fields', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Field Makers');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));

  // A key that defines fields, and reads and adds contacts.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Field sync');
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

  // The key adds a field: members see it in Settings.
  const added = await request.post('/api/v1/contact-fields', {
    headers: auth,
    data: { label: 'Loyalty tier', type: 'text' },
  });
  expect(added.status()).toBe(201);
  expect(((await added.json()) as { data: FieldBody }).data).toMatchObject({
    key: 'loyalty_tier',
    label: 'Loyalty tier',
    type: 'text',
  });
  await page.goto(`/c/${slug}/settings/messaging`);
  await expect(page.getByRole('cell', { name: 'loyalty_tier', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Loyalty tier', exact: true })).toBeVisible();

  // A contact gets a value for it; the contact page shows it under the label.
  const created = await request.post('/api/v1/contacts', {
    headers: auth,
    data: {
      phone: `+91973${String(Date.now()).slice(-7)}`,
      name: 'Hari',
      fields: { loyalty_tier: 'Gold' },
    },
  });
  expect(created.status()).toBe(201);
  const contactId = ((await created.json()) as { data: { id: string } }).data.id;
  await page.goto(`/c/${slug}/contacts/${contactId}`);
  await expect(page.getByLabel('Loyalty tier', { exact: true })).toHaveValue('Gold');

  // The key renames it: the value stays, under the new label.
  const renamed = await request.patch('/api/v1/contact-fields/loyalty_tier', {
    headers: auth,
    data: { label: 'Tier' },
  });
  expect(renamed.status()).toBe(200);
  expect(((await renamed.json()) as { data: FieldBody }).data).toMatchObject({
    key: 'loyalty_tier',
    label: 'Tier',
  });
  await page.reload();
  await expect(page.getByLabel('Tier', { exact: true })).toHaveValue('Gold');

  // The key deletes it, and every contact's value with it.
  const deleted = await request.delete('/api/v1/contact-fields/loyalty_tier', { headers: auth });
  expect(deleted.status()).toBe(200);
  expect(await deleted.json()).toEqual({ data: { key: 'loyalty_tier', deleted: true } });
  const read = await request.get(`/api/v1/contacts/${contactId}`, { headers: auth });
  expect(
    ((await read.json()) as { data: { fields: Record<string, unknown> } }).data.fields,
  ).toEqual({});
  await page.goto(`/c/${slug}/settings/messaging`);
  await expect(page.getByText('No custom fields yet.')).toBeVisible();
  expect(
    (await request.delete('/api/v1/contact-fields/loyalty_tier', { headers: auth })).status(),
  ).toBe(404);
});
