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

test('a company on a trial chooses its add-ons, cannot keep fewer seats than it uses, and pays for them with its plan from the trial’s end', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const email = uniqueEmail('addons');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `addons-${suffix}`;
  const companyName = `Add-ons Co ${suffix}`;
  const team = `Team ${suffix}`;
  await signUpAndVerify(page, { name: 'Ravi Adder', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: companyName })).toBeVisible();

  await turnOnTwoFactor(page, PASSWORD);
  await makePlatformOwner(email);

  try {
    // A platform owner sets the tax on plan prices and publishes a version selling every add-on.
    await page.goto('/platform/plans');
    await page.getByLabel('Tax on plan prices (%)').fill('18');
    await page.getByLabel('Reason', { exact: true }).fill('GST on plan prices, ticket 9106');
    await page.getByRole('button', { name: 'Save tax' }).click();
    await expect(page.getByText('New subscriptions add this tax')).toBeVisible();
    await page.getByRole('link', { name: 'New plan' }).click();
    await page.getByLabel('Code', { exact: true }).fill(`team-${suffix}`);
    await page.getByLabel('Name shown to companies').fill(team);
    await page.getByLabel('Price (₹)').fill('999');
    await page.getByLabel('Seats included').fill('2');
    await page.getByLabel('Extra seat (₹ each)').fill('100');
    await page.getByLabel('Numbers included').fill('1');
    await page.getByLabel('Extra number (₹ each)').fill('500');
    await page.getByLabel('Automation runs a month').fill('1000');
    await page.getByLabel('Run pack (runs)').fill('500');
    await page.getByLabel('Run pack (₹)').fill('250');
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page.getByRole('heading', { name: team })).toBeVisible();
    await page.getByRole('button', { name: 'Publish' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('published', { exact: true }).first()).toBeVisible();

    // The company is on a trial of it with one extra seat: three seats in all.
    await page.goto(`/platform?q=${slug}`);
    await page.getByRole('link', { name: companyName }).click();
    await expect(page).toHaveURL(/\/platform\/tenants\/[0-9a-f-]+$/);
    const companyPage = new URL(page.url()).pathname;
    await page.getByLabel('The company gets').selectOption('trialing');
    await page
      .getByLabel('Plan', { exact: true })
      .selectOption({ label: `${team} (team-${suffix} v1)` });
    await page.getByLabel('Trial ends on').fill(dayFromNow(20));
    await page.getByLabel('Extra seats').fill('1');
    await page
      .getByLabel('Reason (emailed to the billing managers, and shown in the company’s audit log)')
      .fill('Trial agreed on the sales call');
    await page.getByRole('button', { name: 'Save plan' }).click();
    await expect(page.getByText('The company’s plan was changed.')).toBeVisible();

    // Two invitations still waiting: with the owner, the company uses all three seats.
    await page.goto(`/c/${slug}/settings/members`);
    for (const who of ['first', 'second']) {
      const invitee = uniqueEmail(`addons-${who}`);
      await page.getByLabel('Email address').fill(invitee);
      await page.getByRole('button', { name: 'Send invitation' }).click();
      await expect(page.getByText(`Invitation sent to ${invitee}.`)).toBeVisible();
    }

    // Billing points to the add-ons.
    await page.goto(`/c/${slug}/billing`);
    await expect(page.getByText(`${team} plan`)).toBeVisible();
    await expect(
      page.getByText(
        ': choose extra seats, WhatsApp numbers, automation run packs or API request packs for your plan, and pay for them with it.',
      ),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Add-ons', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Add-ons', exact: true })).toBeVisible();
    await expect(
      page.getByText(
        /^During your trial, which ends on .+, the add-ons you choose apply at once\./,
      ),
    ).toBeVisible();
    // ₹999 and the extra seat at ₹100, plus 18% tax.
    await expect(
      page.getByText(
        '₹999.00 per month before tax and add-ons. You would pay ₹1,296.82 per month now, with 18% tax and your add-ons.',
      ),
    ).toBeVisible();
    const seats = page.getByLabel('Extra seats');
    await expect(seats).toHaveValue('1');
    await expect(page.getByLabel('Extra WhatsApp numbers')).toHaveValue('0');
    await expect(page.getByLabel('Automation run packs')).toHaveValue('0');
    await expect(
      page.getByText(
        '₹100.00 each per month. Your plan includes 2 seats, and your company uses 3 (members and invitations still waiting). Up to 10,000, and at least 1 for what it uses.',
      ),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // No extra seat would hold fewer seats than the company uses: the page says what it would cost,
    // and saving is refused.
    await seats.fill('0');
    await expect(
      page.getByText(
        'With these add-ons you would pay ₹1,178.82 per month for your plan, with 18% tax.',
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Save add-ons' }).click();
    await expect(
      page.getByText(
        'With these add-ons your plan holds 2 seats, where your company uses 3 (members and invitations still waiting). Free some first, or keep more add-ons.',
      ),
    ).toBeVisible();

    // Three extra seats, one extra number and two run packs: ₹2,299 and ₹413.82 tax.
    await seats.fill('3');
    await page.getByLabel('Extra WhatsApp numbers').fill('1');
    await page.getByLabel('Automation run packs').fill('2');
    await expect(
      page.getByText(
        'With these add-ons you would pay ₹2,712.82 per month for your plan, with 18% tax.',
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Save add-ons' }).click();
    await expect(
      page.getByText('Your add-ons are saved. You would pay ₹2,712.82 per month for your plan.'),
    ).toBeVisible();

    // Billing shows the add-ons on the same trial, and what paying for the plan costs with them.
    await page.goto(`/c/${slug}/billing`);
    await expect(page.getByText('3 · ₹100.00 each')).toBeVisible();
    await expect(page.getByText('Trial', { exact: true }).first()).toBeVisible();
    const paying = page.getByRole('region', { name: 'Paying for your plan' });
    await expect(paying.getByRole('row', { name: /Tax \(18%\)/ })).toContainText('₹413.82');
    await expect(paying.getByRole('row', { name: /Total/ })).toContainText('₹2,712.82');
    await expectNoHorizontalOverflow(page);

    // The change is in the company's audit log, and staff see it as the plan's last change.
    await page.goto(`/c/${slug}/settings/audit`);
    await expect(page.getByText('billing.add_ons_chosen', { exact: true })).toBeVisible();
    await page.goto(companyPage);
    await expect(page.getByText(/^Last change .+: Add-ons chosen by the company\.$/)).toBeVisible();

    // The owner pays from the trial's end (ADR-102); the add-ons cannot change until that payment
    // is cancelled.
    await routeFakeCheckout(page);
    await page.goto(`/c/${slug}/billing`);
    await paying
      .getByRole('button', { name: /^Pay ₹2,712\.82 per month from \d{1,2} \w+ \d{4}$/ })
      .click();
    await expect(paying.getByText('Authorised', { exact: true })).toBeVisible({ timeout: 30_000 });
    await waitForEmail(email, 'Payments for your HyFib plan start when the trial ends');
    await page.goto(`/c/${slug}/billing/add-ons`);
    await expect(page.getByText('You cannot change your add-ons now')).toBeVisible();
    await expect(
      page.getByText(/^Your company pays for its plan from the end of the trial\./),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save add-ons' })).toHaveCount(0);
    await expect(page.getByText('3 · ₹100.00 each per month')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  } finally {
    // The tax is platform-wide: leave it as the other tests expect (not set).
    await page.goto('/platform/plans');
    await page.getByLabel('Tax on plan prices (%)').fill('');
    await page.getByLabel('Reason', { exact: true }).fill('End of the add-ons test');
    await page.getByRole('button', { name: 'Save tax' }).click();
    await expect(page.getByText('Companies cannot start paying for plans')).toBeVisible();
  }
});
