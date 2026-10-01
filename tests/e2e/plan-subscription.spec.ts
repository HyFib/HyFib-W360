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
const ASK_REASON = 'We moved to a smaller team this month and asked to cancel the seats.';
const NOTE = 'Declined for now: the seats were used this month, see ticket 5153.';
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
  test.setTimeout(600_000);
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
    await expectNoHorizontalOverflow(page);
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

    // The company is on a trial of it with two extra seats, ending within two days: paying is
    // charged at once (ADR-102).
    await page.goto(`/platform?q=${slug}`);
    await page.getByRole('link', { name: companyName }).click();
    await page.getByLabel('The company gets').selectOption('trialing');
    await page
      .getByLabel('Plan', { exact: true })
      .selectOption({ label: `Growth (grow-${suffix} v1)` });
    await page.getByLabel('Trial ends on').fill(dayFromNow(2));
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

    // A platform owner refunds part of the payment (ADR-103): the worker asks Razorpay, the company
    // is emailed, and its receipt shows the refund. The plan does not change.
    const refundForm = panel.getByRole('form', { name: 'Refund a plan payment' });
    await refundForm.getByLabel('Amount in rupees').fill('100');
    await refundForm.getByLabel(/^Reason/).fill('Goodwill for an outage, ticket 5151');
    await refundForm.getByRole('checkbox').check();
    await refundForm.getByRole('button', { name: 'Refund payment' }).click();
    // The refresh that follows may leave nothing to refund, so the confirmation can stand without
    // the form around it.
    await expect(panel.getByText(/^Refund requested\./)).toBeVisible();
    const refunding = await waitForEmailContaining(
      email,
      'HyFib is refunding a plan payment',
      'Your plan and its paid period do not change.',
      90_000,
    );
    expect(refunding).toMatch(/₹100\.00 of your plan payment inv_/);
    expect(refunding).not.toContain('ticket 5151');
    await page.reload();
    await expect(panel.getByRole('row', { name: /Goodwill for an outage/ })).toContainText(
      'Refunded',
    );
    // The payment's row (the refund form's choice names the amount refunded too).
    await expect(panel.getByText('₹100.00 refunded', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.goto(`/c/${slug}/billing`);
    await expect(paying.getByText('₹100.00 refunded', { exact: true })).toBeVisible();
    await expect(paying.getByText('Active', { exact: true })).toBeVisible();
    await paying.getByRole('link', { name: /^Receipt/ }).click();
    await expect(page.getByText('Partly refunded', { exact: true })).toBeVisible();
    await expect(page.getByText(/^Refunded on /)).toBeVisible();
    await expect(page.getByText('Started by HyFib', { exact: false })).toBeVisible();
    await expect(page.getByText('₹1,314.82 (INR)', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // The owner asks HyFib for a refund of more of it from the receipt (ADR-104).
    const ask = page.getByRole('form', { name: 'Ask for a refund' });
    await expect(ask.getByLabel('Amount in rupees')).toHaveValue('1314.82');
    await ask.getByLabel('Amount in rupees').fill('₹200');
    await ask.getByLabel(/^Why you want the refund/).fill(ASK_REASON);
    await ask.getByRole('button', { name: 'Ask for a refund' }).click();
    const firstAsk = page.getByRole('row').filter({ hasText: 'Waiting for HyFib' });
    await expect(firstAsk).toContainText('₹200.00');
    await expect(firstAsk).toContainText('by Priya Payer');
    await expect(
      page.getByText('You asked for a refund of this payment; HyFib has not decided yet.'),
    ).toBeVisible();
    await expect(ask).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    // Platform owners are emailed a count, naming no company, amount or reason.
    const announced = await waitForEmailContaining(
      email,
      'waiting for a decision',
      'plan payment',
      120_000,
    );
    expect(announced).toContain('/platform/refunds');
    expect(announced).not.toContain(companyName);
    expect(announced).not.toContain(ASK_REASON);
    expect(announced).not.toContain('₹');

    // A platform owner declines it with a note, from the plan payments' refunds.
    await page.goto('/platform/refunds');
    await page
      .getByRole('navigation', { name: 'Refunds of' })
      .getByRole('link', { name: 'Plan payments' })
      .click();
    const waiting = page
      .getByRole('row')
      .filter({ hasText: companyName })
      .filter({ hasText: 'Waiting for a decision' });
    await expect(waiting).toContainText(ASK_REASON);
    await expect(waiting).toContainText('₹200.00');
    await expect(waiting).toContainText('₹1,314.82 left of the payment');
    const decision = waiting.getByRole('form', { name: 'Decide the refund request' });
    await expect(decision.getByRole('button', { name: 'Decline' })).toBeDisabled();
    await decision.getByLabel(/^Note for the company/).fill(NOTE);
    await decision.getByRole('button', { name: 'Decline' }).click();
    await expect(waiting).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    // The receipt shows the note; the owner asks again, and a platform owner approves, which
    // refunds the amount as a refund from the company's platform page does.
    await page.goto(`/c/${slug}/billing`);
    await paying.getByRole('link', { name: /^Receipt/ }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Declined' })).toContainText(
      `HyFib’s note: ${NOTE}`,
    );
    await ask.getByLabel('Amount in rupees').fill('150');
    await ask.getByLabel(/^Why you want the refund/).fill(ASK_REASON);
    await ask.getByRole('button', { name: 'Ask for a refund' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Waiting for HyFib' })).toContainText(
      '₹150.00',
    );
    await page.goto('/platform/refunds?kind=plan');
    const second = page
      .getByRole('row')
      .filter({ hasText: companyName })
      .filter({ hasText: 'Waiting for a decision' });
    await expect(second).toContainText('₹150.00');
    const approve = second.getByRole('form', { name: 'Decide the refund request' });
    await approve.getByLabel(/^Approving refunds ₹150\.00/).check();
    await approve.getByRole('button', { name: 'Approve and refund' }).click();
    await expect(second).toHaveCount(0);
    const answered = page
      .getByRole('row')
      .filter({ hasText: companyName })
      .filter({ hasText: `Asked for by the company: ${ASK_REASON}` });
    await expect(answered).toContainText('₹150.00');
    await expectNoHorizontalOverflow(page);

    // The minute sweep emails the billing managers the note, and the worker refunds the approved
    // amount; the company is emailed, and the receipt shows both.
    const declined = await waitForEmailContaining(
      email,
      'HyFib declined your refund request',
      NOTE,
      120_000,
    );
    expect(declined).toMatch(/₹200\.00 of your plan payment inv_/);
    await waitForEmailContaining(
      email,
      'HyFib is refunding a plan payment',
      '₹150.00 of your plan payment',
      150_000,
    );
    await page.goto(`/c/${slug}/billing`);
    await paying.getByRole('link', { name: /^Receipt/ }).click();
    // The link navigates in the page: reloading before the receipt shows would reload Billing.
    await expect(page.getByRole('heading', { name: 'Plan payment receipt' })).toBeVisible();
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole('row').filter({ hasText: 'Approved' })).toContainText(
        'Refunded.',
        { timeout: 1_000 },
      );
    }).toPass({ timeout: 60_000 });
    await expect(page.getByText('₹1,164.82 (INR)', { exact: true })).toBeVisible();
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
      .getByLabel('Reason', { exact: true })
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

    // Staff put the company on a longer trial; paying for it now starts at the trial's end
    // (ADR-102): Checkout only authorises the card, and nothing is charged before then.
    await page.reload();
    await page.getByLabel('The company gets').selectOption('trialing');
    await page
      .getByLabel('Plan', { exact: true })
      .selectOption({ label: `Growth (grow-${suffix} v1)` });
    await page.getByLabel('Trial ends on').fill(dayFromNow(10));
    await page.getByLabel('Extra seats').fill('2');
    await page
      .getByLabel('Reason (emailed to the billing managers, and shown in the company’s audit log)')
      .fill('Longer trial agreed on the renewal call');
    await page.getByRole('button', { name: 'Save plan' }).click();
    await expect(page.getByText('The company’s plan was changed.')).toBeVisible();
    await page.goto(`/c/${slug}/billing`);
    await expect(paying.getByText(/when the trial ends, and ₹1,414\.82 every month/)).toBeVisible();
    await paying
      .getByRole('button', { name: /^Pay ₹1,414\.82 per month from \d{1,2} \w+ \d{4}$/ })
      .click();
    // The panel shows the new subscription (the cancelled one before it).
    await expect(paying.getByText('Authorised', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(
      paying.getByText(
        /Razorpay charges for the first period on \d{1,2} \w+ \d{4}, when the trial ends/,
      ),
    ).toBeVisible();
    await expect(
      page.getByText('Payments by subscription through Razorpay start when the trial ends.'),
    ).toBeVisible();
    await waitForEmail(email, 'Payments for your HyFib plan start when the trial ends');
    await expectNoHorizontalOverflow(page);

    // Staff see when the first charge is due.
    await page.goto(`/platform?q=${slug}`);
    await page.getByRole('link', { name: companyName }).click();
    await expect(
      page.getByRole('region', { name: 'Plan subscription' }).getByText(/, when the trial ends$/),
    ).toBeVisible();
    await expect(
      page.getByText('Paying by Razorpay subscription from the trial’s end'),
    ).toBeVisible();
    await page.goto(`/c/${slug}/billing`);

    // Cancelled before the trial ends: nothing was charged, and the trial goes on.
    await paying.getByRole('button', { name: 'Cancel subscription' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(
      confirm.getByText(/Nothing is charged, and the trial goes on until/),
    ).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel subscription' }).click();
    await expect(paying.getByRole('button', { name: 'Cancel subscription' })).toHaveCount(0);
    const stopped = await waitForEmailContaining(
      email,
      'Your HyFib plan subscription is cancelled',
      'Nothing was charged for it, and the trial goes on until',
      90_000,
    );
    expect(stopped).toMatch(/the trial goes on until \d{1,2} \w+ \d{4}\./);
  } finally {
    // The tax is platform-wide: leave it as the other tests expect (not set).
    await page.goto('/platform/plans');
    await page.getByLabel('Tax on plan prices (%)').fill('');
    await page.getByLabel('Reason', { exact: true }).fill('End of the plan payment test');
    await page.getByRole('button', { name: 'Save tax' }).click();
    await expect(page.getByText('Companies cannot start paying for plans')).toBeVisible();
  }
});
