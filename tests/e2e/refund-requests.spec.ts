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
const REASON = 'We bought too much credit for the season and will not use it all.';
const NOTE = 'Declined for now: please ask for the part you will not use by March.';
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

test('a company asks for a refund of unused credit; a platform owner declines one and approves the next, and the worker emails both sides', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await routeFakeCheckout(page);
  const email = uniqueEmail('asks-refund');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `asks-refund-${suffix}`;
  const companyName = `Asking Traders ${suffix}`;
  await signUpAndVerify(page, { name: 'Asha Asks', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  await page.goto(`/c/${slug}/billing`);
  await page.getByLabel('Amount (₹)').fill('2500');
  await page.getByRole('button', { name: 'Add credit' }).click();
  await expect(page.getByText('Payment received. Your credit is updated.')).toBeVisible();

  // The same person is also a platform owner here (a fixture step), before asking, so the
  // announcement of the request reaches this address.
  await turnOnTwoFactor(page, PASSWORD);
  await makePlatformOwner(email);

  await refundsStartAs('pending');
  try {
    // The company asks from the payment's receipt.
    await page.goto(`/c/${slug}/billing`);
    await expect(
      page.getByText(/To ask HyFib for a refund of credit you have not spent/),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Receipt for ₹2,500.00' }).click();
    await expect(page.getByRole('heading', { name: 'Refund of unused credit' })).toBeVisible();
    const form = page.getByRole('form', { name: 'Ask for a refund' });
    await expect(form.getByLabel('Amount in rupees')).toHaveValue('2500.00');
    await form.getByLabel('Amount in rupees').fill('₹300');
    await expect(form.getByRole('button', { name: 'Ask for a refund' })).toBeDisabled();
    await form.getByLabel(/^Why you want the refund/).fill(REASON);
    await form.getByRole('button', { name: 'Ask for a refund' }).click();
    const firstAsk = page.getByRole('row').filter({ hasText: 'Waiting for HyFib' });
    await expect(firstAsk).toContainText('₹300.00');
    await expect(firstAsk).toContainText('by Asha Asks');
    await expect(
      page.getByText('You asked for a refund of this payment; HyFib has not decided yet.'),
    ).toBeVisible();
    await expect(form).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page.goto(`/c/${slug}/billing`);
    await expect(page.getByText('Refund of ₹300.00 asked for; waiting for HyFib')).toBeVisible();

    // Platform owners are emailed a count, with no company, amount or reason.
    const announced = await waitForEmail(email, 'waiting for a decision', 120_000);
    expect(announced).toContain('/platform/refunds');
    expect(announced).not.toContain(companyName);
    expect(announced).not.toContain(REASON);
    expect(announced).not.toContain('₹');

    // A platform owner declines it with a note.
    await page.goto('/platform');
    await page
      .getByRole('navigation', { name: 'Platform' })
      .getByRole('link', { name: 'Refunds' })
      .click();
    await expect(page.getByRole('heading', { name: 'Refunds', exact: true })).toBeVisible();
    const waiting = page
      .getByRole('row')
      .filter({ hasText: companyName })
      .filter({ hasText: 'Waiting for a decision' });
    await expect(waiting).toContainText(REASON);
    await expect(waiting).toContainText('₹300.00');
    await expect(waiting).toContainText('₹2,500.00 unused credit now');
    const decision = waiting.getByRole('form', { name: 'Decide the refund request' });
    await expect(decision.getByRole('button', { name: 'Decline' })).toBeDisabled();
    await expect(decision.getByRole('button', { name: 'Approve and refund' })).toBeDisabled();
    await decision.getByLabel(/^Note for the company/).fill(NOTE);
    await decision.getByRole('button', { name: 'Decline' }).click();
    await expect(waiting).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page
      .getByRole('navigation', { name: 'Requests to show' })
      .getByRole('link', { name: 'Decided' })
      .click();
    const declined = page.getByRole('row').filter({ hasText: companyName });
    await expect(declined).toContainText('Declined');
    await expect(declined).toContainText(`Note: ${NOTE}`);
    await expect(declined).toContainText('by Asha Asks');

    // The receipt shows the note, and the company asks again.
    await page.goto(`/c/${slug}/billing`);
    await page.getByRole('link', { name: 'Receipt for ₹2,500.00' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Declined' })).toContainText(
      `HyFib’s note: ${NOTE}`,
    );
    await form.getByLabel('Amount in rupees').fill('200');
    await form.getByLabel(/^Why you want the refund/).fill(REASON);
    await form.getByRole('button', { name: 'Ask for a refund' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Waiting for HyFib' })).toContainText(
      '₹200.00',
    );

    // A platform owner approves: the staff refund starts for the amount asked.
    await page.goto('/platform/refunds');
    const second = page
      .getByRole('row')
      .filter({ hasText: companyName })
      .filter({ hasText: 'Waiting for a decision' });
    await expect(second).toContainText('₹200.00');
    const approve = second.getByRole('form', { name: 'Decide the refund request' });
    await approve.getByLabel(/^Approving refunds ₹200\.00/).check();
    await approve.getByRole('button', { name: 'Approve and refund' }).click();
    await expect(second).toHaveCount(0);
    const refund = page
      .getByRole('row')
      .filter({ hasText: companyName })
      .filter({ hasText: 'Asked for by the company' });
    await expect(refund).toContainText('₹200.00');
    await expect(refund).toContainText(`Asked for by the company: ${REASON}`);

    // The minute sweep emails the billing managers the note, and hands the refund to the worker,
    // which asks Razorpay; the company is emailed.
    const told = await waitForEmail(email, 'HyFib declined your refund request', 120_000);
    expect(told).toContain('₹300.00');
    expect(told).toContain(NOTE);
    await expect(async () => {
      await page.reload();
      await expect(refund).toContainText('With Razorpay', { timeout: 1_000 });
    }).toPass({ timeout: 150_000 });
    const refunding = await waitForEmail(email, 'HyFib is refunding service credit', 60_000);
    expect(refunding).toContain('₹200.00');
    await page.goto(`/c/${slug}/billing`);
    await expect(page.getByText('Refund of ₹200.00 in progress')).toBeVisible();
    await page.getByRole('link', { name: 'Receipt for ₹2,500.00' }).click();
    const approved = page.getByRole('row').filter({ hasText: 'Approved' });
    await expect(approved).toContainText('₹200.00');
    await expect(approved).toContainText('The refund is on its way.');
    await expect(
      page.getByText('A refund of this payment is in progress.', { exact: true }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  } finally {
    await refundsStartAs('processed');
  }
});
