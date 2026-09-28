import { createHmac } from 'node:crypto';
import { expect, test } from './fixtures';
import { razorpayConfigured, routeFakeCheckout } from './razorpay-checkout';
import { signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';
test.skip(
  !razorpayConfigured,
  'Razorpay test configuration (stand-in, key and webhook secrets) not provided',
);

test('an owner adds service credit by card and the balance updates once the payment is verified', async ({
  page,
}) => {
  await routeFakeCheckout(page);

  const email = uniqueEmail('billing');
  const slug = `bill-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Bina Billing', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Billing Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));

  await page.getByRole('link', { name: 'Billing' }).first().click();
  await expect(page.getByRole('heading', { name: 'Billing', level: 1 })).toBeVisible();
  await expect(page.getByText('Test mode', { exact: true })).toBeVisible();
  const available = page
    .getByText('Available', { exact: true })
    .locator('xpath=following-sibling::dd');
  await expect(available).toHaveText('₹0.00');

  await page.getByLabel('Amount (₹)').fill('1500');
  await page.getByRole('button', { name: 'Add credit' }).click();
  await expect(page.getByText('Payment received. Your credit is updated.')).toBeVisible();
  await expect(available).toHaveText('₹1,500.00');
  await expect(page.getByRole('cell', { name: 'Credit added' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '+₹1,500.00' })).toBeVisible();
});

test('the Razorpay webhook accepts only correctly signed deliveries', async ({ request }) => {
  const body = JSON.stringify({
    entity: 'event',
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_E2EUnknown0001', order_id: 'order_E2EUnknown01' } } },
    created_at: Math.floor(Date.now() / 1000),
  });
  const unsigned = await request.post('/api/webhooks/razorpay', {
    data: body,
    headers: { 'content-type': 'application/json' },
  });
  expect(unsigned.status()).toBe(401);
  const forged = await request.post('/api/webhooks/razorpay', {
    data: body,
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': createHmac('sha256', 'not-the-secret').update(body).digest('hex'),
    },
  });
  expect(forged.status()).toBe(401);
  const signed = await request.post('/api/webhooks/razorpay', {
    data: body,
    headers: {
      'content-type': 'application/json',
      'x-razorpay-event-id': `evt_e2e_${Date.now()}`,
      'x-razorpay-signature': createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET ?? '')
        .update(body)
        .digest('hex'),
    },
  });
  expect(signed.status()).toBe(200);
});
