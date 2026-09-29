import pg from 'pg';
import { expect, test } from './fixtures';
import { razorpayConfigured, routeFakeCheckout } from './razorpay-checkout';
import {
  expectNoHorizontalOverflow,
  makePlatformOwner,
  platformConfigured,
  signUpAndVerify,
  turnOnTwoFactor,
  uniqueEmail,
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

/** A day as HyFib's emails write it. */
function dayLabel(day: string): string {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  );
}

/**
 * A fixture step: the top-up paid with `paymentId` becomes one paid long ago that no settlement
 * showed. Its payment moves to noon (India time) 8 days before the earliest day with a run, and that
 * day and the 7 after it become reconciled days with nothing in them, as the daily schedule leaves
 * them. In a database kept between runs each run's day is earlier than the last, so its payment
 * comes first on the page (oldest payment first). Returns the payment's day.
 */
async function payLongAgo(paymentId: string): Promise<string> {
  const owner = new pg.Client({ connectionString: process.env.DATABASE_URL_MIGRATE });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query('SET LOCAL ROLE w360_definer');
    const found = await owner.query<{ day: string }>(
      `SELECT (coalesce(min(settlement_date), (now() AT TIME ZONE 'Asia/Kolkata')::date) - 8)::text
                AS day
         FROM ops.settlement_recon_runs`,
    );
    const day = found.rows[0]!.day;
    const moved = await owner.query(
      `UPDATE app.topups SET paid_at = ($2::date + time '12:00') AT TIME ZONE 'Asia/Kolkata'
        WHERE provider_payment_id = $1 AND status = 'paid'`,
      [paymentId, day],
    );
    expect(moved.rowCount).toBe(1);
    await owner.query(
      `INSERT INTO ops.settlement_recon_runs
         (id, settlement_date, status, attempts, attempt_seq, next_attempt_at, started_at, completed_at)
       SELECT gen_random_uuid(), $1::date + n, 'completed', 1, 1, now(), now(), now()
         FROM generate_series(0, 7) AS n`,
      [day],
    );
    await owner.query('COMMIT');
    return day;
  } finally {
    await owner.end();
  }
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
  test.setTimeout(420_000);
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

  // A second top-up, which HyFib hears of as usual, becomes one paid long ago whose payment no
  // settlement showed (a fixture step): the worker's minute billing sweep emails platform owners
  // about it (ADR-071) while the day is reconciled.
  let unsettledId = '';
  await routeFakeCheckout(page, {
    onPaid: (id) => {
      unsettledId = id;
    },
  });
  await page.goto(`/c/${slug}/billing`);
  await page.getByLabel('Amount (₹)').fill('500');
  await page.getByRole('button', { name: 'Add credit' }).click();
  await expect(page.getByText('Payment received. Your credit is updated.')).toBeVisible();
  const unsettledDay = await payLongAgo(unsettledId);

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

  // Platform owners were emailed about the unsettled payment, which the page lists with its company
  // and amount, and when they were emailed. The email names its day, never the payment.
  const unsettledAlert = await waitForEmailContaining(
    email,
    'not settled within 7 days',
    dayLabel(unsettledDay),
    150_000,
  );
  expect(unsettledAlert).toContain('/platform/reconciliation');
  expect(unsettledAlert).not.toContain(unsettledId);
  expect(unsettledAlert).not.toContain(companyName);
  await page.reload();
  const unsettled = page.getByRole('row').filter({ hasText: unsettledId });
  await expect(unsettled).toContainText(companyName);
  await expect(unsettled).toContainText('₹500.00');
  await expect(unsettled).not.toContainText('Not yet');
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
  // Platform owners are emailed about the day by the worker's minute billing sweep (ADR-066): by
  // the sweep after the check finished (up to a minute later), one email per platform owner in the
  // database through the email queue (about two a second). A database kept between runs keeps
  // every earlier run's owners (73 once locally: 37 seconds of emails).
  const alert = await waitForEmailContaining(
    email,
    'Settlement reconciliation',
    `${dayLabel(day)}: 1 transaction waits for a person (1 is not HyFib’s).`,
    150_000,
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

  // The company has its credit (with the second top-up's) and the usual email with the receipt.
  await waitForEmailContaining(email, 'Payment received: service credit added', '₹1,200.00');
  await page.goto(`/c/${slug}/billing`);
  await expect(available).toHaveText('₹1,700.00');
});
