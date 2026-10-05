import { expect, test } from './fixtures';
import { razorpayConfigured } from './razorpay-checkout';
import {
  expectNoHorizontalOverflow,
  makePlatformOwner,
  platformConfigured,
  signUpAndVerify,
  turnOnTwoFactor,
  uniqueEmail,
} from './support';

const PASSWORD = 'correct horse battery staple 42';

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

test('a platform owner sells API request packs, staff set one, and the company chooses more under Add-ons, raising its monthly API limit (ADR-110)', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const email = uniqueEmail('apipacks');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `apipacks-${suffix}`;
  const companyName = `API Packs Co ${suffix}`;
  const planName = `Api ${suffix}`;
  await signUpAndVerify(page, { name: 'Asha Packer', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: companyName })).toBeVisible();

  await turnOnTwoFactor(page, PASSWORD);
  await makePlatformOwner(email);

  try {
    // A platform owner sets the tax on plan prices and publishes a version selling packs of 500
    // more API requests a month at ₹300 each, on top of 1,000.
    await page.goto('/platform/plans');
    await page.getByLabel('Tax on plan prices (%)').fill('18');
    await page.getByLabel('Reason', { exact: true }).fill('GST on plan prices, ticket 9110');
    await page.getByRole('button', { name: 'Save tax' }).click();
    await expect(page.getByText('New subscriptions add this tax')).toBeVisible();
    await page.getByRole('link', { name: 'New plan' }).click();
    await page.getByLabel('Code', { exact: true }).fill(`api-${suffix}`);
    await page.getByLabel('Name shown to companies').fill(planName);
    await page.getByLabel('Price (₹)').fill('999');
    await page.getByLabel('Seats included').fill('3');
    await page.getByLabel('Numbers included').fill('1');
    // Packs need a monthly limit: the form says so first.
    await page.getByLabel('API request pack (requests)').fill('500');
    await page.getByLabel('API request pack (₹)').fill('300');
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page.locator('#plan-apiRequestPackSize-error')).toHaveText(
      'API request packs need a monthly API request limit above 0',
    );
    await page.getByLabel('API requests a month').fill('1000');
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page.getByRole('heading', { name: planName })).toBeVisible();
    await expect(page.getByText('500 requests for ₹300.00')).toBeVisible();
    await page.getByRole('button', { name: 'Publish' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('published', { exact: true }).first()).toBeVisible();

    // Staff put the company on a trial of it with one pack.
    await page.goto(`/platform?q=${slug}`);
    await page.getByRole('link', { name: companyName }).click();
    await expect(page).toHaveURL(/\/platform\/tenants\/[0-9a-f-]+$/);
    await page.getByLabel('The company gets').selectOption('trialing');
    await page
      .getByLabel('Plan', { exact: true })
      .selectOption({ label: `${planName} (api-${suffix} v1)` });
    await page.getByLabel('Trial ends on').fill(dayFromNow(20));
    await page.getByLabel('API request packs').fill('1');
    await page
      .getByLabel('Reason (emailed to the billing managers, and shown in the company’s audit log)')
      .fill('Trial agreed on the sales call');
    await page.getByRole('button', { name: 'Save plan' }).click();
    await expect(page.getByText('The company’s plan was changed.')).toBeVisible();

    // Billing shows the pack and the limit with it: 1,000 + 500 requests a month.
    await page.goto(`/c/${slug}/billing`);
    await expect(page.getByText('1 · 500 requests for ₹300.00')).toBeVisible();
    await expect(page.getByRole('row', { name: /API requests this month/ })).toContainText(
      '0 of 1,500',
    );
    await expect(
      page.getByText(
        ': choose extra seats, WhatsApp numbers, automation run packs or API request packs for your plan, and pay for them with it.',
      ),
    ).toBeVisible();

    // The company chooses a second pack: ₹999 + 2 × ₹300 = ₹1,599, plus ₹287.82 tax.
    await page.getByRole('link', { name: 'Add-ons', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Add-ons', exact: true })).toBeVisible();
    const packs = page.getByLabel('API request packs');
    await expect(packs).toHaveValue('1');
    await expect(
      page.getByText(
        '500 public API requests a month in each pack, ₹300.00 each per month, on top of the 1,000 your plan includes. Up to 10,000.',
      ),
    ).toBeVisible();
    await packs.fill('2');
    await expect(
      page.getByText(
        'With these add-ons you would pay ₹1,886.82 per month for your plan, with 18% tax.',
      ),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole('button', { name: 'Save add-ons' }).click();
    await expect(
      page.getByText('Your add-ons are saved. You would pay ₹1,886.82 per month for your plan.'),
    ).toBeVisible();

    // The limit rises at once, and paying for the plan charges the packs with it.
    await page.goto(`/c/${slug}/billing`);
    await expect(page.getByText('2 · 500 requests for ₹300.00')).toBeVisible();
    await expect(page.getByRole('row', { name: /API requests this month/ })).toContainText(
      '0 of 2,000',
    );
    const paying = page.getByRole('region', { name: 'Paying for your plan' });
    await expect(paying.getByRole('row', { name: /API request packs/ })).toContainText('₹600.00');
    await expect(paying.getByRole('row', { name: /Total/ })).toContainText('₹1,886.82');
    await expectNoHorizontalOverflow(page);
  } finally {
    // The tax is platform-wide: leave it as the other tests expect (not set).
    await page.goto('/platform/plans');
    await page.getByLabel('Tax on plan prices (%)').fill('');
    await page.getByLabel('Reason', { exact: true }).fill('End of the API request packs test');
    await page.getByRole('button', { name: 'Save tax' }).click();
    await expect(page.getByText('Companies cannot start paying for plans')).toBeVisible();
  }
});
