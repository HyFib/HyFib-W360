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
  waitForEmailContaining,
} from './support';

const PASSWORD = 'correct horse battery staple 42';
const standInUrl = `http://127.0.0.1:${process.env.E2E_RAZORPAY_PORT ?? '0'}`;

test.skip(
  !razorpayConfigured,
  'Razorpay test configuration (stand-in, key and webhook secrets) not provided',
);
test.skip(!platformConfigured, 'needs DATABASE_URL_MIGRATE and E2E_DATABASE_URL_AUTH');
// An action that cannot happen fails here with its locator, instead of holding the test until its
// own (long) timeout.
test.use({ actionTimeout: 30_000 });

/** A day in YYYY-MM-DD, `days` from now (UTC). */
const dayFromNow = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

test('a company pays for its plan by subscription, a renewal counts from Razorpay, and it cancels at the end of the period', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail('plansub');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `plansub-${suffix}`;
  const companyName = `Plan Pay Co ${suffix}`;
  await signUpAndVerify(page, { name: 'Priya Payer', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: companyName })).toBeVisible();

  await turnOnTwoFactor(page, PASSWORD);
  await makePlatformOwner(email);
  try {
    // A platform owner sets the tax on plan prices and publishes a plan with extra seats.
    await page.goto('/platform/plans');
    await page.getByLabel('Tax on plan prices (%)').fill('18');
    await page.getByLabel('Reason', { exact: true }).fill('GST on plan prices, ticket 9001');
    await page.getByRole('button', { name: 'Save tax' }).click();
    await expect(page.getByText('New subscriptions add this tax')).toBeVisible();
    await page.getByRole('link', { name: 'New plan' }).click();
    await page.getByLabel('Code', { exact: true }).fill(`grow-${suffix}`);
    await page.getByLabel('Name shown to companies').fill('Growth');
    await page.getByLabel('Price (₹)').fill('999');
    await page.getByLabel('Seats included').fill('3');
    await page.getByLabel('Extra seat (₹ each)').fill('100');
    await page.getByLabel('Numbers included').fill('1');
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page.getByRole('heading', { name: /Growth/ })).toBeVisible();
    await page.getByRole('button', { name: 'Publish' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('published', { exact: true }).first()).toBeVisible();

    // The company is on a trial of it with two extra seats.
    await page.goto(`/platform?q=${slug}`);
    await page.getByRole('link', { name: companyName }).click();
    await page.getByLabel('The company gets').selectOption('trialing');
    await page
      .getByLabel('Plan', { exact: true })
      .selectOption({ label: `Growth (grow-${suffix} v1)` });
    await page.getByLabel('Trial ends on').fill(dayFromNow(10));
    await page.getByLabel('Extra seats').fill('2');
    await page
      .getByLabel('Reason (emailed to the billing managers, and shown in the company’s audit log)')
      .fill('Trial agreed on the sales call');
    await page.getByRole('button', { name: 'Save plan' }).click();
    await expect(page.getByText('The company’s plan was changed.')).toBeVisible();

    // The owner pays: ₹999 + 2 × ₹100 = ₹1,199.00, plus 18% = ₹1,414.82 a month.
    await routeFakeCheckout(page);
    await page.goto(`/c/${slug}/billing`);
    const paying = page.getByRole('region', { name: 'Paying for your plan' });
    await expect(paying.getByRole('row', { name: /Tax \(18%\)/ })).toContainText('₹215.82');
    await expect(paying.getByRole('row', { name: /Total/ })).toContainText('₹1,414.82');
    await expectNoHorizontalOverflow(page);
    await paying.getByRole('button', { name: 'Pay ₹1,414.82 per month' }).click();
    await expect(paying.getByText('Subscription: ₹1,414.82 per month')).toBeVisible({
      timeout: 30_000,
    });
    await expect(paying.getByText('Active', { exact: true })).toBeVisible();
    await expect(page.getByText('Paid by subscription through Razorpay.')).toBeVisible();
    await expect(paying.getByRole('cell', { name: '₹1,414.82' })).toHaveCount(1);
    await waitForEmail(email, 'Payment received for your HyFib plan');

    // The payment's receipt: the plan, the billing period and the tax, and not a tax invoice.
    await paying.getByRole('link', { name: /^Receipt/ }).click();
    await expect(page.getByRole('heading', { name: 'Plan payment receipt' })).toBeVisible();
    await expect(page.getByText(/It is not a tax invoice\./)).toBeVisible();
    await expect(page.getByText(`Growth (grow-${suffix} v1), per month`)).toBeVisible();
    await expect(page.getByText('With 2 extra seats')).toBeVisible();
    await expect(page.getByText('₹215.82', { exact: true })).toBeVisible();
    await expect(page.getByText('₹1,414.82 (INR)', { exact: true })).toBeVisible();
    await expect(page.getByText(/^inv_/).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Staff see the subscription; plan changes wait for it.
    await page.goto(`/platform?q=${slug}`);
    await page.getByRole('link', { name: companyName }).click();
    const panel = page.getByRole('region', { name: 'Plan subscription' });
    await expect(panel.getByText('₹1,414.82 per month (tax 18%)')).toBeVisible();
    await expect(page.getByText('Paid by Razorpay subscription', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save plan' })).toHaveCount(0);
    const subscriptionId = (await panel.locator('dd.font-mono').first().innerText()).trim();
    expect(subscriptionId).toMatch(/^sub_/);
    await expectNoHorizontalOverflow(page);

    // Razorpay charges the next month; its event carries only ids, and HyFib fetches the rest.
    const charged = await fetch(`${standInUrl}/__stand-in/charge-subscription`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription_id: subscriptionId }),
    });
    expect(charged.status).toBe(200);
    const { payment_id: renewalPaymentId } = (await charged.json()) as { payment_id: string };
    const body = JSON.stringify({
      entity: 'event',
      event: 'subscription.charged',
      contains: ['subscription', 'payment'],
      payload: {
        subscription: { entity: { id: subscriptionId, entity: 'subscription', notes: [] } },
        payment: { entity: { id: renewalPaymentId, entity: 'payment' } },
      },
      created_at: Math.floor(Date.now() / 1000),
    });
    const delivered = await request.post('/api/webhooks/razorpay', {
      data: body,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-event-id': `evt_e2e_sub_${suffix}`,
        'x-razorpay-signature': createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET ?? '')
          .update(body)
          .digest('hex'),
      },
    });
    expect(delivered.status()).toBe(200);
    await page.goto(`/c/${slug}/billing`);
    await expect(async () => {
      await page.reload();
      await expect(paying.getByRole('cell', { name: '₹1,414.82' })).toHaveCount(2, {
        timeout: 1_000,
      });
    }).toPass({ timeout: 60_000 });

    // The owner cancels: nothing more is charged, and the plan ends with the paid period.
    await paying.getByRole('button', { name: 'Cancel subscription' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Cancel subscription' })
      .click();
    await expect(paying.getByText('Nothing more is charged. The plan ends on')).toBeVisible();
    await expect(paying.getByRole('button', { name: 'Cancel subscription' })).toHaveCount(0);
    await waitForEmail(email, 'Your HyFib plan subscription is cancelled');
    await expectNoHorizontalOverflow(page);

    // A platform owner then cancels it at once; the worker tells the billing managers why, and
    // that the paid period stands (ADR-101).
    await page.goto(`/platform?q=${slug}`);
    await page.getByRole('link', { name: companyName }).click();
    await page
      .getByRole('region', { name: 'Plan subscription' })
      .getByLabel('Reason')
      .fill('Customer asked by phone to stop now, ticket 9002');
    await page.getByRole('button', { name: 'Cancel subscription now' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Cancel subscription' })
      .click();
    await expect(page.getByRole('button', { name: 'Cancel subscription now' })).toHaveCount(0);
    const told = await waitForEmailContaining(
      email,
      'HyFib cancelled your plan subscription',
      "HyFib's reason: Customer asked by phone to stop now, ticket 9002",
      90_000,
    );
    expect(told).toContain('so nothing more is charged.');
    expect(told).toMatch(/The period it paid runs until \d{1,2} \w+ \d{4}; the plan then ends/);
  } finally {
    // The tax is platform-wide: leave it as the other tests expect (not set).
    await page.goto('/platform/plans');
    await page.getByLabel('Tax on plan prices (%)').fill('');
    await page.getByLabel('Reason', { exact: true }).fill('End of the plan payment test');
    await page.getByRole('button', { name: 'Save tax' }).click();
    await expect(page.getByText('Companies cannot start paying for plans')).toBeVisible();
  }
});
