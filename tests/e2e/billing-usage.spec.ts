import pg from 'pg';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  connectTestChannel,
  inboundMessage,
  messagingConfigured,
  randomWaId,
  sendSignedWebhook,
  standInRequests,
  statusUpdate,
} from './messaging-support';
import {
  expectNoHorizontalOverflow,
  openFromNav,
  signUpAndVerify,
  uniqueEmail,
  waitForEmail,
} from './support';

const PASSWORD = 'correct horse battery staple 42';

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');
test.skip(
  !process.env.DATABASE_URL_PLATFORM || !process.env.E2E_DATABASE_URL_AUTH,
  'needs DATABASE_URL_PLATFORM and E2E_DATABASE_URL_AUTH for the rate card fixture',
);

/**
 * Rate cards are shared by every company in the database, and the browser projects share one
 * database when they run together, as `pnpm test:e2e` runs them locally (CI gives each its own,
 * ADR-343): each project uses its own currency, which no other spec uses.
 */
const CURRENCIES: Record<string, string> = {
  chromium: 'AUD',
  firefox: 'CAD',
  webkit: 'CHF',
  'mobile-chromium': 'NZD',
};

/**
 * Meta's rates as platform staff enter them (a fixture step through the platform role, whose
 * policies let staff write rate cards): one card in force since yesterday and one taking effect in
 * two days. Cards an earlier run left for the currency are withdrawn first, so the run sees only
 * its own.
 */
async function publishRates(currency: string, email: string) {
  const auth = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL_AUTH });
  await auth.connect();
  let userId: string;
  try {
    const res = await auth.query<{ id: string }>('SELECT id FROM auth.users WHERE email = $1', [
      email.toLowerCase(),
    ]);
    userId = res.rows[0]!.id;
  } finally {
    await auth.end();
  }
  const platform = new pg.Client({ connectionString: process.env.DATABASE_URL_PLATFORM });
  await platform.connect();
  try {
    await platform.query(
      `UPDATE ops.rate_cards SET status = 'withdrawn' WHERE currency = $1 AND status = 'published'`,
      [currency],
    );
    const cards: [string, [string, number][]][] = [
      [
        '1 day',
        [
          ['marketing', 785_000],
          ['utility', 115_000],
          ['authentication', 115_000],
        ],
      ],
      [
        '-2 days',
        [
          ['marketing', 865_000],
          ['utility', 115_000],
          ['service', 42_000],
        ],
      ],
    ];
    for (const [ago, prices] of cards) {
      const res = await platform.query<{ id: string }>(
        `INSERT INTO ops.rate_cards (id, currency, effective_from, source_url, created_by_user_id)
         VALUES (gen_random_uuid(), $1, now() - $2::interval, 'https://example.test/meta-rates', $3)
         RETURNING id`,
        [currency, ago, userId],
      );
      const id = res.rows[0]!.id;
      await platform.query(
        `INSERT INTO ops.rate_card_prefixes (rate_card_id, prefix, market) VALUES ($1, '91', 'India')`,
        [id],
      );
      for (const [category, micros] of prices) {
        await platform.query(
          `INSERT INTO ops.rate_card_prices (rate_card_id, market, category, price_micros)
           VALUES ($1, 'India', $2, $3)`,
          [id, category, micros],
        );
      }
      await platform.query(`UPDATE ops.rate_cards SET status = 'published' WHERE id = $1`, [id]);
    }
  } finally {
    await platform.end();
  }
}

/** The value box of a statistic, found by its label. */
function stat(page: Page, label: string) {
  return page
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('..');
}

test('a company sees Meta’s rates in force, what changes next, and this month’s estimate', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const currency = CURRENCIES[test.info().project.name] ?? 'SEK';
  const email = uniqueEmail('usage');
  const slug = `use-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Uma Usage', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Usage Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });
  await publishRates(currency, email);

  // The owner chooses the currency Meta bills the company in.
  await page.goto(`/c/${slug}/settings/messaging`);
  await page.getByLabel('Currency Meta bills you in').selectOption(currency);
  await page.getByRole('button', { name: 'Save campaign settings' }).click();
  await expect(page.getByText('Campaign settings saved.')).toBeVisible();

  // A customer writes; the reply is delivered and Meta reports it free (a service reply).
  const waId = randomWaId();
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, waId, 'Is the blue kurta in stock?'),
  );
  await page.goto(`/c/${slug}/inbox`);
  const conversation = page.getByRole('link', { name: /Priya Customer/ });
  await expect(conversation).toBeVisible({ timeout: 20_000 });
  await conversation.click();
  await page.getByLabel('Reply').fill('Yes, in all sizes.');
  // Exact: the conversation also has a “Send file” button.
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const thread = page.getByRole('list', { name: /^Messages with/ });
  await expect(thread.getByText('Sent to WhatsApp')).toBeVisible({ timeout: 20_000 });
  const sent = (await standInRequests(request))
    .filter((r) => r.path === `/v26.0/${phoneNumberId}/messages`)
    .pop();
  await sendSignedWebhook(
    request,
    statusUpdate(wabaId, phoneNumberId, sent!.wamid!, 'delivered', waId, {
      billable: false,
      pricing_model: 'PMP',
      type: 'free_customer_service',
      category: 'service',
    }),
  );
  await expect(thread.getByText('Delivered')).toBeVisible({ timeout: 20_000 });

  // Billing links to Usage and rates (the live conversation is left through the navigation, see
  // openFromNav).
  await openFromNav(page, 'Billing');
  await page.getByRole('link', { name: 'Usage and rates' }).click();
  await expect(page.getByRole('heading', { name: 'Usage and rates', level: 1 })).toBeVisible();
  await expect(page.getByText(`Meta’s ${currency} rates change on`)).toBeVisible();
  await expect(page.getByText('3 prices change; see what changes below.')).toBeVisible();

  const inForce = page.getByRole('table', { name: `Meta’s ${currency} rates in force` });
  await expect(inForce.getByRole('row', { name: /India/ })).toContainText(`0.785 ${currency}`);
  // Service has no price on the card in force: shown as not priced, never as zero.
  await expect(inForce.getByRole('row', { name: /India/ })).toContainText('not priced');
  const changes = page.getByRole('table', { name: /^Prices that change on/ });
  await expect(changes.getByRole('row', { name: /Marketing/ })).toContainText(
    `0.785 ${currency}0.865 ${currency}+0.08 ${currency} (+10.2%)`,
  );
  await expect(changes.getByRole('row', { name: /Service/ })).toContainText('New price');
  await expect(changes.getByRole('row', { name: /Authentication/ })).toContainText(
    'No longer priced',
  );

  await expect(stat(page, 'Delivered messages')).toContainText('1');
  await expect(stat(page, 'Free \\(reported by Meta\\)')).toContainText('1');
  await expect(stat(page, 'Estimated Meta charges')).toContainText('0.00');
  await expect(stat(page, 'Estimated Meta charges')).toContainText(
    '0 priced of 0 billable delivered messages',
  );
  await expectNoHorizontalOverflow(page);

  // The worker's minute billing sweep emails the owner about the card taking effect in two days
  // (ADR-065), linking to this page.
  const mail = await waitForEmail(email, `Meta's WhatsApp rates for ${currency} change on`, 90_000);
  expect(mail).toContain(`Meta's rate card for ${currency} changes at`);
  expect(mail).toContain(
    'Compared with the card before it, the new card changes 1 price, adds 1 price and no longer lists 1 price.',
  );
  expect(mail).toContain(`• India, marketing: 0.785 ${currency} to 0.865 ${currency} (+10.2%)`);
  expect(mail).toContain(`• India, authentication: no longer priced (was 0.115 ${currency})`);
  expect(mail).toContain(`• India, service: new price 0.042 ${currency}`);
  expect(mail).toContain(`/c/${slug}/billing/usage`);
});
