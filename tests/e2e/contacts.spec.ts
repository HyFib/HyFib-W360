import { expect, test } from './fixtures';
import { expectNoHorizontalOverflow, signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

test('an owner adds a contact, records consent and tags, imports a CSV and exports it safely', async ({
  page,
}) => {
  const email = uniqueEmail('contacts');
  const slug = `ct-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Cora Contacts', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Contact Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));

  await page.getByRole('link', { name: 'Contacts' }).first().click();
  await expect(page.getByRole('heading', { name: 'Contacts', level: 1 })).toBeVisible();
  await expect(page.getByText('No contacts yet')).toBeVisible();

  // Manual entry never guesses the country of a bare number.
  await page.getByRole('link', { name: 'Add contact' }).click();
  await page.getByLabel('Name').fill('Asha Rao');
  await page.getByLabel('Phone number').fill('98765 43210');
  await page.getByRole('button', { name: 'Add contact' }).click();
  await expect(page.getByText(/Include the country code/)).toBeVisible();
  await page.getByLabel('Phone number').fill('+91 98765 43210');
  await page.getByRole('button', { name: 'Add contact' }).click();
  await expect(page.getByRole('heading', { name: 'Asha Rao', level: 1 })).toBeVisible();
  await expect(page.getByText('Marketing: not recorded')).toBeVisible();

  await page.getByLabel('Add tags').fill('vip, pune');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Tags' })).toContainText('vip');

  await page.getByLabel('How and when did they tell you?').fill('Agreed at the store counter');
  await page.getByRole('button', { name: 'Record consent' }).click();
  await expect(page.getByText('Consent recorded.')).toBeVisible();
  await expect(page.getByText('Marketing: opted in').first()).toBeVisible();
  await expect(page.getByRole('cell', { name: /Agreed at the store counter/ })).toBeVisible();

  // CSV import with a formula-shaped name and one bad row.
  await page.goto(`/c/${slug}/contacts/import`);
  await page.getByLabel('CSV file').setInputFiles({
    name: 'customers.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'phone,name,tags\r\n+919811100001,Bina,gold\r\n+919811100002,"=HYPERLINK(""http://evil.test"")",\r\nnot-a-number,Chitra,\r\n',
    ),
  });
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('3 data rows. First rows:')).toBeVisible();
  await page.getByRole('button', { name: 'Import 3 rows' }).click();
  await expect(page.getByText('Import finished')).toBeVisible();
  await expect(
    page.getByText(/2 created, 0 updated, 0 left unchanged, 1 rows with errors/),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: /Not imported: Phone numbers can contain only digits/ }),
  ).toBeVisible();

  // The contact list (a wide table) scrolls inside its card, not the page.
  await page.goto(`/c/${slug}/contacts`);
  await expect(page.getByRole('cell', { name: 'Bina' })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Export neutralises the formula so a spreadsheet shows it as text.
  const response = await page.request.get(`/c/${slug}/contacts/export`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/csv');
  const csv = await response.text();
  expect(csv).toContain(`"'=HYPERLINK(""http://evil.test"")"`);
  expect(csv).toContain('+919876543210,Asha Rao');

  // Consent keywords are company settings.
  await page.goto(`/c/${slug}/settings/messaging`);
  await page.getByLabel('Stop all messages').fill('stop, band karo');
  await page.getByRole('button', { name: 'Save consent settings' }).click();
  await expect(page.getByText('Consent settings saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Stop all messages')).toHaveValue('STOP, BAND KARO');
});
