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

test('platform owners offer plans; a company on a trial chooses one that holds what it has, and pays for it from the trial’s end', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const email = uniqueEmail('planchoice');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `planchoice-${suffix}`;
  const companyName = `Plan Choice Co ${suffix}`;
  // Offered versions are platform-wide, so the names are this run's own.
  const solo = `Solo ${suffix}`;
  const starter = `Starter ${suffix}`;
  const growth = `Growth ${suffix}`;
  await signUpAndVerify(page, { name: 'Asha Chooser', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: companyName })).toBeVisible();

  await turnOnTwoFactor(page, PASSWORD);
  await makePlatformOwner(email);

  /** Creates and publishes a version with extra seats at ₹100, and returns its page. */
  const publish = async (code: string, name: string, price: string, seats: string) => {
    await page.goto('/platform/plans');
    await page.getByRole('link', { name: 'New plan' }).click();
    await page.getByLabel('Code', { exact: true }).fill(code);
    await page.getByLabel('Name shown to companies').fill(name);
    await page.getByLabel('Price (₹)').fill(price);
    await page.getByLabel('Seats included').fill(seats);
    await page.getByLabel('Extra seat (₹ each)').fill('100');
    await page.getByLabel('Numbers included').fill('1');
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
    await page.getByRole('button', { name: 'Publish' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('published', { exact: true }).first()).toBeVisible();
    return new URL(page.url()).pathname;
  };
  /** Offers the version on `path` to companies (ADR-105). */
  const offer = async (path: string) => {
    await page.goto(path);
    await page.getByRole('button', { name: 'Offer to companies' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Offer', exact: true }).click();
    await expect(page.getByText('offered to companies', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop offering' })).toBeVisible();
  };
  /** Stops offering the version on `path`; companies on it keep it. */
  const withdraw = async (path: string) => {
    await page.goto(path);
    await page.getByRole('button', { name: 'Stop offering' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Stop offering' }).click();
    await expect(page.getByRole('button', { name: 'Offer to companies' })).toBeVisible();
    await expect(page.getByText('offered to companies', { exact: true })).toHaveCount(0);
  };

  try {
    // A platform owner sets the tax on plan prices, publishes three versions and offers two.
    await page.goto('/platform/plans');
    await page.getByLabel('Tax on plan prices (%)').fill('18');
    await page.getByLabel('Reason', { exact: true }).fill('GST on plan prices, ticket 9105');
    await page.getByRole('button', { name: 'Save tax' }).click();
    await expect(page.getByText('New subscriptions add this tax')).toBeVisible();
    const soloPage = await publish(`solo-${suffix}`, solo, '499', '1');
    await publish(`start-${suffix}`, starter, '999', '3');
    const growthPage = await publish(`grow-${suffix}`, growth, '1999', '5');
    await expect(
      page.getByText('Not offered. Once offered, companies without a paid period'),
    ).toBeVisible();
    await offer(soloPage);
    await offer(growthPage);
    await expectNoHorizontalOverflow(page);

    // The company is on a trial of the version that is not offered, with an extra seat.
    await page.goto(`/platform?q=${slug}`);
    await page.getByRole('link', { name: companyName }).click();
    await expect(page).toHaveURL(/\/platform\/tenants\/[0-9a-f-]+$/);
    const companyPage = new URL(page.url()).pathname;
    await page.getByLabel('The company gets').selectOption('trialing');
    await page
      .getByLabel('Plan', { exact: true })
      .selectOption({ label: `${starter} (start-${suffix} v1)` });
    await page.getByLabel('Trial ends on').fill(dayFromNow(20));
    await page.getByLabel('Extra seats').fill('1');
    await page
      .getByLabel('Reason (emailed to the billing managers, and shown in the company’s audit log)')
      .fill('Trial agreed on the sales call');
    await page.getByRole('button', { name: 'Save plan' }).click();
    await expect(page.getByText('The company’s plan was changed.')).toBeVisible();

    // Two invitations still waiting: with the owner, the company uses three seats.
    await page.goto(`/c/${slug}/settings/members`);
    for (const who of ['first', 'second']) {
      const invitee = uniqueEmail(`planchoice-${who}`);
      await page.getByLabel('Email address').fill(invitee);
      await page.getByRole('button', { name: 'Send invitation' }).click();
      await expect(page.getByText(`Invitation sent to ${invitee}.`)).toBeVisible();
    }

    // Billing points to the offered plans.
    await page.goto(`/c/${slug}/billing`);
    await expect(page.getByText(`${starter} plan`)).toBeVisible();
    await expect(
      page.getByText(/HyFib offers (another plan|\d+ other plans) you can choose and pay for/),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Choose a plan' }).click();
    await expect(page.getByRole('heading', { name: 'Choose a plan' })).toBeVisible();
    await expect(page.getByText(new RegExp(`You are on ${starter}\\.`))).toBeVisible();
    // The version that is not offered is not listed.
    await expect(page.getByRole('region', { name: starter, exact: true })).toHaveCount(0);

    // One seat and one extra hold less than the three in use: Solo cannot be chosen.
    const soloCard = page.getByRole('region', { name: solo, exact: true });
    await expect(
      soloCard.getByText(
        '₹499.00 per month before tax. You would pay ₹706.82 per month, with 18% tax and your add-ons.',
      ),
    ).toBeVisible();
    await expect(soloCard.getByText('Holds less than your company has now')).toBeVisible();
    await expect(
      soloCard.getByText(
        '2 seats, where your company uses 3 (members and invitations still waiting).',
      ),
    ).toBeVisible();
    await expect(soloCard.getByRole('button')).toHaveCount(0);

    // Growth holds it: ₹1,999 + ₹100 for the extra seat, plus 18% = ₹2,476.82 a month.
    const growthCard = page.getByRole('region', { name: growth, exact: true });
    await expect(
      growthCard.getByText(
        '₹1,999.00 per month before tax. You would pay ₹2,476.82 per month, with 18% tax and your add-ons.',
      ),
    ).toBeVisible();
    await expect(growthCard.getByText('6 seats (with your 1 extra)')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await growthCard.getByRole('button', { name: `Choose ${growth}` }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(
      confirm.getByText(/^Its limits and modules apply at once, until your trial ends on /),
    ).toBeVisible();
    await confirm.getByRole('button', { name: `Choose ${growth}` }).click();

    // Billing shows the chosen plan, on the same trial, and what paying for it costs.
    await expect(page).toHaveURL(new RegExp(`/c/${slug}/billing$`));
    await expect(page.getByText(`${growth} plan`)).toBeVisible();
    await expect(page.getByText('Trial', { exact: true }).first()).toBeVisible();
    const paying = page.getByRole('region', { name: 'Paying for your plan' });
    await expect(paying.getByRole('row', { name: /Tax \(18%\)/ })).toContainText('₹377.82');
    await expect(paying.getByRole('row', { name: /Total/ })).toContainText('₹2,476.82');
    await expectNoHorizontalOverflow(page);

    // The choice is in the company's audit log, and staff see it as the plan's last change.
    await page.goto(`/c/${slug}/settings/audit`);
    await expect(page.getByText('billing.plan_chosen', { exact: true })).toBeVisible();
    await page.goto(companyPage);
    await expect(page.getByText(/^Last change .+: Chosen by the company\.$/)).toBeVisible();

    // Growth is no longer offered: the company keeps it, and it is no longer listed.
    await withdraw(growthPage);
    await page.goto(`/c/${slug}/billing/plans`);
    await expect(page.getByText(new RegExp(`You are on ${growth}\\.`))).toBeVisible();
    await expect(page.getByRole('region', { name: growth, exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: solo, exact: true })).toBeVisible();

    // The owner pays for Growth from the trial's end (ADR-102); another plan cannot be chosen until
    // that payment is cancelled.
    await routeFakeCheckout(page);
    await page.goto(`/c/${slug}/billing`);
    await paying
      .getByRole('button', { name: /^Pay ₹2,476\.82 per month from \d{1,2} \w+ \d{4}$/ })
      .click();
    await expect(paying.getByText('Authorised', { exact: true })).toBeVisible({ timeout: 30_000 });
    await waitForEmail(email, 'Payments for your HyFib plan start when the trial ends');
    await page.goto(`/c/${slug}/billing/plans`);
    await expect(page.getByText('You cannot choose a plan now')).toBeVisible();
    await expect(
      page.getByText(/^Your company pays for its plan from the end of the trial\./),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /^Choose / })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    await withdraw(soloPage);
  } finally {
    // The tax is platform-wide: leave it as the other tests expect (not set).
    await page.goto('/platform/plans');
    await page.getByLabel('Tax on plan prices (%)').fill('');
    await page.getByLabel('Reason', { exact: true }).fill('End of the plan choice test');
    await page.getByRole('button', { name: 'Save tax' }).click();
    await expect(page.getByText('Companies cannot start paying for plans')).toBeVisible();
  }
});
