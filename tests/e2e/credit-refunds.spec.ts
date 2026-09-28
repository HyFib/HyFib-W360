import { createHmac } from 'node:crypto';
import { expect, test } from './fixtures';
import { razorpayConfigured, routeFakeCheckout } from './razorpay-checkout';
import {
  expectNoHorizontalOverflow,
  makePlatformOwner,
  platformConfigured,
  signUpAndVerify,
  turnOnTwoFactor,
  uniqueEmail,
  waitForEmail,
} from './support';

const PASSWORD = 'correct horse battery staple 42';
const REASON = 'Customer asked for part of the credit back, ticket 7731';
const standInUrl = `http://127.0.0.1:${process.env.E2E_RAZORPAY_PORT ?? '0'}`;

test.skip(
  !razorpayConfigured,
  'Razorpay test configuration (stand-in, key and webhook secrets) not provided',
);
test.skip(!platformConfigured, 'needs DATABASE_URL_MIGRATE and E2E_DATABASE_URL_AUTH');

/** TEST-ONLY: tells the Razorpay stand-in which status new refunds get. */
async function refundsStartAs(status: 'pending' | 'processed') {
  const res = await fetch(`${standInUrl}/__stand-in/refund-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  expect(res.status).toBe(200);
}

test('a platform owner refunds unused credit; the worker sends it and the company follows it to the end', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  await routeFakeCheckout(page);
  const email = uniqueEmail('refund');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `refund-${suffix}`;
  const companyName = `Refund Traders ${suffix}`;
  await signUpAndVerify(page, { name: 'Rhea Refund', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  await page.goto(`/c/${slug}/billing`);
  await page.getByLabel('Amount (₹)').fill('2500');
  await page.getByRole('button', { name: 'Add credit' }).click();
  await expect(page.getByText('Payment received. Your credit is updated.')).toBeVisible();

  // The same person is platform staff here too (a fixture step), with two-factor on.
  await turnOnTwoFactor(page, PASSWORD);
  await makePlatformOwner(email);

  await refundsStartAs('pending');
  try {
    await page.goto(`/platform?q=${slug}`);
    await page.getByRole('link', { name: companyName }).click();
    await expect(page.getByRole('heading', { name: 'Service credit' })).toBeVisible();
    const form = page.getByRole('form', { name: 'Refund service credit' });
    await expect(form.getByLabel('Amount in rupees')).toHaveValue('2500.00');
    await form.getByLabel('Amount in rupees').fill('500');
    await form.getByLabel(/^Reason/).fill(REASON);
    await expect(form.getByRole('button', { name: 'Refund credit' })).toBeDisabled();
    await form.getByLabel(/^The money goes back/).check();
    await form.getByRole('button', { name: 'Refund credit' }).click();
    await expect(page.getByText(/^Refund requested\. The credit is reserved now/)).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // The minute sweep hands the request to the worker, which asks Razorpay for the refund.
    const request_ = page.getByRole('row').filter({ hasText: REASON });
    await expect(async () => {
      await page.reload();
      await expect(request_).toContainText('With Razorpay', { timeout: 1_000 });
    }).toPass({ timeout: 150_000 });
    await expect(request_).toContainText('₹500.00');
    await expect(request_).toContainText('by Rhea Refund');
    const refundId = (await request_.locator('code').textContent())?.trim() ?? '';
    expect(refundId).toMatch(/^rfnd_/);

    // The company: the refund is on its way and the credit is set aside meanwhile.
    const mail = await waitForEmail(email, 'HyFib is refunding service credit');
    expect(mail).toContain('₹500.00');
    expect(mail).toContain('5–7 working days');
    await page.goto(`/c/${slug}/billing`);
    await expect(page.getByText('A refund is in progress')).toBeVisible();
    await expect(
      page.getByText(/HyFib is refunding ₹500\.00 of your service credit/),
    ).toBeVisible();
    const available = page
      .getByText('Available', { exact: true })
      .locator('xpath=following-sibling::dd');
    await expect(available).toHaveText('₹2,000.00');
    const reserved = page
      .getByText('Reserved for running services and refunds', { exact: true })
      .locator('xpath=following-sibling::dd');
    await expect(reserved).toHaveText('₹500.00');
    await expect(page.getByText('Refund of ₹500.00 in progress')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Reserved for a refund' })).toBeVisible();
    await expect(page.getByText(REASON)).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page.getByRole('link', { name: 'Receipt for ₹2,500.00' }).click();
    const started = page.getByRole('row').filter({ hasText: 'In progress' });
    await expect(started).toContainText('₹500.00');

    // Razorpay completes it and says so: the refund is recorded once and the reservation released.
    const finished = await fetch(`${standInUrl}/__stand-in/finish-refund`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: refundId, status: 'processed' }),
    });
    expect(finished.status).toBe(200);
    const refund = (await finished.json()) as { payment_id: string };
    const body = JSON.stringify({
      entity: 'event',
      event: 'refund.processed',
      contains: ['refund'],
      payload: {
        refund: {
          entity: { id: refundId, entity: 'refund', payment_id: refund.payment_id, amount: 50_000 },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    });
    const delivered = await request.post('/api/webhooks/razorpay', {
      data: body,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-event-id': `evt_e2e_refund_${suffix}`,
        'x-razorpay-signature': createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET ?? '')
          .update(body)
          .digest('hex'),
      },
    });
    expect(delivered.status()).toBe(200);
    await page.goto(`/c/${slug}/billing`);
    await expect(async () => {
      await page.reload();
      await expect(page.getByText('₹500.00 refunded')).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByText('Partly refunded')).toBeVisible();
    await expect(page.getByText('A refund is in progress')).toHaveCount(0);
    await expect(available).toHaveText('₹2,000.00');
    await expect(
      page
        .getByText('Reserved for running services', { exact: true })
        .locator('xpath=following-sibling::dd'),
    ).toHaveText('₹0.00');
    await expect(page.getByRole('cell', { name: 'Refund reservation released' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Refund to card' })).toBeVisible();

    // Staff see it completed.
    await page.goto(`/platform?q=${slug}`);
    await page.getByRole('link', { name: companyName }).click();
    await expect(request_).toContainText('Refunded');
    await expect(request_).toContainText(refundId);
  } finally {
    await refundsStartAs('processed');
  }
});
