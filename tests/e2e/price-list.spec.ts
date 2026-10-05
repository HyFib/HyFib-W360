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

// The price list needs paying for plans to be on (Razorpay subscriptions, against the stand-in).
test.skip(
  !razorpayConfigured,
  'Razorpay test configuration (stand-in, key and webhook secrets) not provided',
);
test.skip(!platformConfigured, 'needs DATABASE_URL_MIGRATE and E2E_DATABASE_URL_AUTH');
// An action that cannot happen fails here with its locator, instead of holding the test until its
// own (long) timeout.
test.use({ actionTimeout: 30_000 });

test('platform owners show the offered plans to visitors, who see their prices without signing in, and hide them again', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail('pricelist');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `pricelist-${suffix}`;
  const companyName = `Price List Co ${suffix}`;
  // Offered versions are platform-wide, so the name is this run's own.
  const launch = `Launch ${suffix}`;
  await signUpAndVerify(page, { name: 'Meera Pricer', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: companyName })).toBeVisible();

  await turnOnTwoFactor(page, PASSWORD);
  await makePlatformOwner(email);

  // A visitor who has not signed in.
  const visitor = await browser.newContext();
  const visit = await visitor.newPage();
  let planPage: string | null = null;
  try {
    // Hidden until a platform owner shows it.
    await visit.goto('/pricing');
    await expect(visit.getByRole('heading', { name: 'Page not found' })).toBeVisible();

    // A platform owner sets the tax, publishes and offers a version with a trial, and makes it
    // the default trial.
    await page.goto('/platform/plans');
    await expect(page.getByText(/^Hidden\. Once shown, anyone can see/)).toBeVisible();
    await page.getByLabel('Tax on plan prices (%)').fill('18');
    await page.getByLabel('Reason', { exact: true }).fill('GST on plan prices, ticket 9107');
    await page.getByRole('button', { name: 'Save tax' }).click();
    await expect(page.getByText('New subscriptions add this tax')).toBeVisible();
    await page.getByRole('link', { name: 'New plan' }).click();
    await page.getByLabel('Code', { exact: true }).fill(`launch-${suffix}`);
    await page.getByLabel('Name shown to companies').fill(launch);
    await page.getByLabel('Price (₹)').fill('999');
    await page.getByLabel('Trial days').fill('14');
    await page.getByLabel('Seats included').fill('2');
    await page.getByLabel('Extra seat (₹ each)').fill('100');
    await page.getByLabel('Numbers included').fill('1');
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page.getByRole('heading', { name: launch })).toBeVisible();
    await page.getByRole('button', { name: 'Publish' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('published', { exact: true }).first()).toBeVisible();
    planPage = new URL(page.url()).pathname;
    await page.getByRole('button', { name: 'Offer to companies' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Offer', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop offering' })).toBeVisible();
    await page.goto('/platform/plans');
    await page
      .getByLabel('New companies start')
      .selectOption({ label: `${launch} (launch-${suffix} v1) · 14-day trial` });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('New companies now start this trial.')).toBeVisible();

    // Nothing else keeps it from visitors: showing it puts the offered plans on /pricing.
    await page.reload();
    await expect(page.getByText('What keeps it from visitors:')).toHaveCount(0);
    await page.getByRole('button', { name: 'Show the price list' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Show', exact: true }).click();
    await expect(page.getByText(/^Shown: anyone can see the versions offered/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open the price list' })).toBeVisible();

    await visit.goto('/pricing');
    await expect(visit.getByRole('heading', { name: 'Plans and prices' })).toBeVisible();
    await expect(visit.getByText(/before tax; 18% tax is added\./)).toBeVisible();
    await expect(visit.getByText(/^New companies start with a 14-day trial/)).toBeVisible();
    await expect(visit.getByText(/Meta bills your company for them directly\./)).toBeVisible();
    const card = visit.getByRole('region', { name: launch });
    await expect(
      card.getByText('₹999.00 per month before tax · ₹1,178.82 per month with 18% tax'),
    ).toBeVisible();
    await expect(card.getByText('2 seats', { exact: true })).toBeVisible();
    await expect(card.getByText('1 WhatsApp number', { exact: true })).toBeVisible();
    await expect(
      card.getByText('Without Automations, WhatsApp Flows, CRM, Commerce and stores'),
    ).toBeVisible();
    await expect(
      card.getByText('Extra seats: ₹100.00 each per month', { exact: true }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(visit);
    await visit.getByRole('link', { name: 'Create an account' }).click();
    await expect(visit).toHaveURL(/\/sign-up$/);

    // Hidden again: /pricing is not found.
    await page.getByRole('button', { name: 'Hide the price list' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Hide', exact: true }).click();
    await expect(page.getByText(/^Hidden\. Once shown, anyone can see/)).toBeVisible();
    await visit.goto('/pricing');
    await expect(visit.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  } finally {
    await visitor.close();
    // The plan settings and offers are platform-wide: leave them as the other tests expect (no
    // default trial, no tax, the list hidden, the version not offered), the settings first, so that
    // a failure in a later step leaves the most important ones restored.
    await page.goto('/platform/plans');
    await page.getByLabel('New companies start').selectOption('');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('New companies now start complimentary.')).toBeVisible();
    await page.getByLabel('Tax on plan prices (%)').fill('');
    await page.getByLabel('Reason', { exact: true }).fill('End of the price list test');
    await page.getByRole('button', { name: 'Save tax' }).click();
    await expect(page.getByText('Companies cannot start paying for plans')).toBeVisible();
    const hide = page.getByRole('button', { name: 'Hide the price list' });
    if (await hide.isVisible()) {
      await hide.click();
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Hide', exact: true })
        .click();
      await expect(page.getByText(/^Hidden\. Once shown, anyone can see/)).toBeVisible();
    }
    if (planPage) {
      await page.goto(planPage);
      const stop = page.getByRole('button', { name: 'Stop offering' });
      if (await stop.isVisible()) {
        await stop.click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Stop offering' }).click();
        await expect(page.getByRole('button', { name: 'Offer to companies' })).toBeVisible();
      }
    }
  }
});
