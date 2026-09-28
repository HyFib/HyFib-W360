import { readFile } from 'node:fs/promises';
import { expect, test } from './fixtures';
import { razorpayConfigured, routeFakeCheckout } from './razorpay-checkout';
import { expectNoHorizontalOverflow, signUpAndVerify, uniqueEmail, waitForEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

test.skip(
  !razorpayConfigured,
  'Razorpay test configuration (stand-in, key and webhook secrets) not provided',
);

test('a payment has a receipt, is emailed, and appears on the month statement and its CSV', async ({
  page,
}) => {
  await routeFakeCheckout(page);
  const email = uniqueEmail('history');
  const slug = `hist-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  await signUpAndVerify(page, { name: 'Hari History', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('History Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));

  await page.goto(`/c/${slug}/billing`);
  await page.getByLabel('Amount (₹)').fill('2500');
  await page.getByRole('button', { name: 'Add credit' }).click();
  await expect(page.getByText('Payment received. Your credit is updated.')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // The payment's receipt: a payment confirmation, not a tax invoice.
  await page.getByRole('link', { name: 'Receipt for ₹2,500.00' }).click();
  await expect(page.getByRole('heading', { name: 'Payment receipt', level: 1 })).toBeVisible();
  await expect(page.getByText('₹2,500.00 for HyFib W360 service credit')).toBeVisible();
  await expect(
    page.getByText(
      'This receipt confirms a payment for prepaid service credit. It is not a tax invoice.',
    ),
  ).toBeVisible();
  await expect(page.getByText('Card, through Razorpay')).toBeVisible();
  await expect(page.getByText(/^pay_/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeEnabled();
  await expectNoHorizontalOverflow(page);
  const receiptUrl = page.url();

  const mail = await waitForEmail(email, 'Payment received: service credit added');
  expect(mail).toContain('not a tax invoice');
  expect(mail).toContain(new URL(receiptUrl).pathname);

  // The month statement lists the credit with its receipt, and the CSV has it in exact rupees.
  await page.getByRole('link', { name: 'Monthly statements' }).click();
  await expect(page.getByRole('heading', { name: 'Statements', level: 1 })).toBeVisible();
  const current = page.getByRole('row').filter({ hasText: 'Month to date' });
  await expect(current).toContainText('₹2,500.00');
  await current.getByRole('link').first().click();
  await expect(page.getByRole('heading', { name: /^Statement for / })).toBeVisible();
  await expect(page.getByText('Month to date', { exact: true })).toBeVisible();
  const line = page.getByRole('row').filter({ hasText: 'Credit added' });
  await expect(line).toContainText('+₹2,500.00');
  await expect(line.getByRole('link', { name: /^Receipt/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const downloading = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download CSV' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^statement-\d{4}-\d{2}\.csv$/);
  const csv = await readFile(await download.path(), 'utf8');
  expect(csv).toContain(',Opening balance,,,,,0.00,0.00');
  expect(csv).toMatch(/,Credit added,pay_\w+,tu_[0-9a-f-]+,2500\.00,0\.00,2500\.00,0\.00\r\n/);
  expect(csv).toContain(',Balance so far (month to date),,,,,2500.00,0.00');
});
