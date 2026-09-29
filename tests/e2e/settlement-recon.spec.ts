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

/** India's calendar day `offset` days from today (the settlement day HyFib asks for). */
function indiaDay(offset: number): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const day = new Date(`${today}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

/**
 * Each browser project reconciles its own day, and a retry another one: they share one database and
 * one stand-in, which keeps what an earlier attempt settled.
 */
const DAY_OFFSETS: Record<string, number> = {
  chromium: -5,
  'mobile-chromium': -6,
  firefox: -7,
  webkit: -8,
};
const PROJECTS = Object.keys(DAY_OFFSETS).length;

test('a platform owner reconciles a settled day: a payment HyFib missed is credited, and a payment that is not HyFib’s waits for a person', async ({
  page,
}) => {
  test.setTimeout(330_000);
  const { project, retry } = test.info();
  const offset = DAY_OFFSETS[project.name];
  if (offset === undefined) throw new Error(`No settlement day for the ${project.name} project`);
  const day = indiaDay(offset - PROJECTS * retry);
  let paymentId = '';
  // The customer pays and closes Checkout at once: HyFib never hears of the payment.
  await routeFakeCheckout(page, {
    closeAfterPaying: true,
    onPaid: (id) => {
      paymentId = id;
    },
  });
  const email = uniqueEmail('recon');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `recon-${suffix}`;
  const companyName = `Recon Traders ${suffix}`;
  const stranger = `pay_E2eStranger${suffix}`;
  await signUpAndVerify(page, { name: 'Ravi Recon', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  await page.goto(`/c/${slug}/billing`);
  await page.getByLabel('Amount (₹)').fill('1200');
  await page.getByRole('button', { name: 'Add credit' }).click();
  await expect.poll(() => paymentId, { timeout: 15_000 }).toMatch(/^pay_/);
  const available = page
    .getByText('Available', { exact: true })
    .locator('xpath=following-sibling::dd');
  await page.goto(`/c/${slug}/billing`);
  await expect(available).toHaveText('₹0.00');

  // Razorpay settles it days later, together with a payment of another integration.
  const settled = await fetch(`${standInUrl}/__stand-in/settle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      date: day,
      payment_ids: [paymentId],
      refund_ids: [],
      extra: [
        {
          entity_id: stranger,
          type: 'payment',
          debit: 0,
          credit: 49_000,
          amount: 50_000,
          currency: 'INR',
          fee: 1_000,
          tax: 152,
          on_hold: false,
          settled: true,
          created_at: Math.floor(Date.now() / 1000) - 5 * 86_400,
          settled_at: Math.floor(Date.now() / 1000) - 3 * 86_400,
          settlement_id: 'setl_E2eSettlement1',
          settlement_utr: 'UTRE2E0001',
          payment_id: null,
          order_id: `order_E2eStranger${suffix}`,
          method: 'upi',
          dispute_id: null,
        },
      ],
    }),
  });
  expect(settled.status).toBe(200);

  // The same person is platform staff here too (a fixture step), with two-factor on.
  await turnOnTwoFactor(page, PASSWORD);
  await makePlatformOwner(email);
  await page.goto('/platform');
  await page.getByRole('link', { name: 'Reconciliation' }).click();
  await expect(page.getByRole('heading', { name: 'Settlement reconciliation' })).toBeVisible();
  const form = page.getByRole('form', { name: 'Reconcile a day' });
  await form.getByLabel(/^Settlement day/).fill(day);
  await form.getByLabel(/^Reason/).fill('Checking a settled day, ticket 9001');
  await form.getByRole('button', { name: 'Reconcile this day' }).click();
  await expect(page.getByText(/^Queued: the worker reads/)).toBeVisible();

  // The minute billing sweep hands the day to the worker.
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: day }) });
  await expect(async () => {
    await page.reload();
    await expect(row).toContainText('Completed', { timeout: 1_000 });
  }).toPass({ timeout: 150_000 });
  await expectNoHorizontalOverflow(page);
  await row.getByRole('link', { name: day }).click();
  await expect(page.getByRole('heading', { name: `Settlements of ${day}` })).toBeVisible();

  // The payment HyFib missed was fetched from Razorpay and credited, as its webhook would have.
  const recorded = page.getByRole('row').filter({ hasText: paymentId });
  await expect(recorded).toContainText('Recorded by the check');
  await expect(recorded).toContainText('₹1,200.00');
  await expect(recorded.getByRole('link', { name: companyName })).toBeVisible();
  // The other payment waits for a person, who resolves it with a note.
  await expect(page.getByRole('heading', { name: 'Needs a person (1)' })).toBeVisible();
  const other = page.getByRole('row').filter({ hasText: stranger });
  await expect(other).toContainText('Not HyFib’s');
  // Platform owners are emailed about the day by the worker's minute billing sweep (ADR-066).
  const dayLabel = new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));
  const alert = await waitForEmailContaining(
    email,
    'Settlement reconciliation',
    `${dayLabel}: 1 transaction waits for a person (1 is not HyFib’s).`,
    90_000,
  );
  expect(alert).toContain('/platform/reconciliation');
  expect(alert).not.toContain(stranger);
  await other.getByText('Resolve', { exact: true }).click();
  const resolve = page.getByRole('form', { name: `Resolve ${stranger}` });
  await resolve
    .getByLabel('What was checked or done')
    .fill('Payment for the old website, checked with finance');
  await resolve.getByRole('button', { name: 'Mark resolved' }).click();
  await expect(page.getByRole('heading', { name: 'Needs a person (0)' })).toBeVisible();
  await expect(
    page.getByText(/Resolved by Ravi Recon on .*: Payment for the old website/),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // The company has its credit and the usual email with the receipt.
  const mail = await waitForEmail(email, 'Payment received: service credit added');
  expect(mail).toContain('₹1,200.00');
  await page.goto(`/c/${slug}/billing`);
  await expect(available).toHaveText('₹1,200.00');
});
