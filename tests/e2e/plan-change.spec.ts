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
test.use({ actionTimeout: 30_000 });

/**
 * India's calendar day `offset` days from today, in YYYY-MM-DD: the company's days are India's
 * (Asia/Kolkata), which run ahead of UTC's from 18:30 UTC.
 */
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

test('a paying company changes its plan and add-ons from the end of the paid period, authorising the new subscription in Checkout', async ({
  page,
}) => {
  test.setTimeout(360_000);
  const email = uniqueEmail('planchange');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `planchange-${suffix}`;
  const companyName = `Plan Change Co ${suffix}`;
  const base = `Base ${suffix}`;
  const plus = `Plus ${suffix}`;
  await signUpAndVerify(page, { name: 'Chitra Changer', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: companyName })).toBeVisible();
  await turnOnTwoFactor(page, PASSWORD);
  await makePlatformOwner(email);

  /** Creates and publishes a monthly version; returns its platform page. */
  const publish = async (
    code: string,
    name: string,
    price: string,
    seats: string,
    seatPrice: string,
  ) => {
    await page.goto('/platform/plans');
    await page.getByRole('link', { name: 'New plan' }).click();
    await page.getByLabel('Code', { exact: true }).fill(code);
    await page.getByLabel('Name shown to companies').fill(name);
    await page.getByLabel('Price (₹)').fill(price);
    await page.getByLabel('Seats included').fill(seats);
    await page.getByLabel('Extra seat (₹ each)').fill(seatPrice);
    await page.getByLabel('Numbers included').fill('1');
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
    await page.getByRole('button', { name: 'Publish' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('published', { exact: true }).first()).toBeVisible();
    return new URL(page.url()).pathname;
  };
  let plusPage: string | null = null;

  try {
    await page.goto('/platform/plans');
    await page.getByLabel('Tax on plan prices (%)').fill('18');
    await page.getByLabel('Reason', { exact: true }).fill('GST on plan prices, ticket 9109');
    await page.getByRole('button', { name: 'Save tax' }).click();
    await expect(page.getByText('New subscriptions add this tax')).toBeVisible();
    await publish(`base-${suffix}`, base, '999', '3', '100');
    plusPage = await publish(`plus-${suffix}`, plus, '1999', '5', '150');
    await page.getByRole('button', { name: 'Offer to companies' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Offer', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop offering' })).toBeVisible();

    // The company is on a trial of Base with two extra seats, ending within two days: paying is
    // charged at once (ADR-102). It ends at the start of the day after tomorrow in the company's
    // time zone, 24 to 48 hours from now whatever the hour.
    await page.goto(`/platform?q=${slug}`);
    await page.getByRole('link', { name: companyName }).click();
    await expect(page).toHaveURL(/\/platform\/tenants\/[0-9a-f-]+$/);
    const companyPage = new URL(page.url()).pathname;
    await page.getByLabel('The company gets').selectOption('trialing');
    await page
      .getByLabel('Plan', { exact: true })
      .selectOption({ label: `${base} (base-${suffix} v1)` });
    await page.getByLabel('Trial ends on').fill(indiaDay(2));
    await page.getByLabel('Extra seats').fill('2');
    await page
      .getByLabel('Reason (emailed to the billing managers, and shown in the company’s audit log)')
      .fill('Trial agreed on the sales call');
    await page.getByRole('button', { name: 'Save plan' }).click();
    await expect(page.getByText('The company’s plan was changed.')).toBeVisible();

    // The owner pays for Base: ₹999 + 2 × ₹100, plus 18% = ₹1,414.82 a month.
    await routeFakeCheckout(page);
    await page.goto(`/c/${slug}/billing`);
    const paying = page.getByRole('region', { name: 'Paying for your plan' });
    await paying.getByRole('button', { name: 'Pay ₹1,414.82 per month' }).click();
    await expect(paying.getByText('Active', { exact: true })).toBeVisible({ timeout: 30_000 });

    // Billing points to Change plan; the page lists the offered plans and the company's own.
    await page.reload();
    await expect(
      page.getByText(
        /^Change plan: change your plan or add-ons from the end of the paid period, on .+\.$/,
      ),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Change plan', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Change plan', exact: true })).toBeVisible();
    await expect(
      page.getByText(/^A change takes effect when your paid period ends, on /),
    ).toBeVisible();
    await expect(
      page.getByText(`You pay for ${base} with 2 extra seats: ₹1,414.82 per month.`),
    ).toBeVisible();
    const baseCard = page.getByRole('region', { name: base });
    await expect(baseCard.getByText('Your plan', { exact: true })).toBeVisible();
    const plusCard = page.getByRole('region', { name: plus });
    await expect(plusCard.getByText('₹1,999.00 per month before tax and add-ons.')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await plusCard.getByRole('link', { name: `Choose ${plus}` }).click();

    // Plus includes 5 seats, as many as the company has now: the form starts with no extra seat.
    await expect(page.getByRole('heading', { name: `Change to ${plus}` })).toBeVisible();
    const seats = page.getByLabel('Extra seats');
    await expect(seats).toHaveValue('0');
    await seats.fill('1');
    await expect(
      page.getByText(/^From .+ you would pay ₹2,535\.82 per month for Plus .+, with 18% tax\.$/),
    ).toBeVisible();
    await expect(
      page.getByText(/^Your current subscription is cancelled at the end of the paid period, on /),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Confirming ends the current subscription with the period and opens Checkout for the new one,
    // which only authorises the payment method (its first charge is when the period ends).
    await page.getByRole('button', { name: /^Change from \d{1,2} \w+ \d{4}$/ }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('cannot be restarted');
    await dialog.getByRole('button', { name: /^Change from / }).click();
    await expect(
      page.getByText(
        /^Change scheduled\. From .+ your plan is Plus .+, and Razorpay charges ₹2,535\.82 for it then\.$/,
      ),
    ).toBeVisible({ timeout: 30_000 });
    await waitForEmail(email, 'Your HyFib plan changes at the end of the paid period');
    await waitForEmail(email, 'Your HyFib plan changes on ');

    // Billing shows the plan it becomes and the subscription that follows the current one.
    await page.goto(`/c/${slug}/billing`);
    await expect(page.getByText(new RegExp(`From .+, your plan is ${plus}\\.`))).toBeVisible();
    const next = page.getByRole('group', { name: 'Next subscription' });
    await expect(next).toContainText(`${plus} with 1 extra seat, ₹2,535.82 per month`);
    await expect(next.getByText('Authorised', { exact: true })).toBeVisible();
    await expect(paying.getByText('Ends with the paid period', { exact: true })).toBeVisible();
    await expect(paying.getByRole('button', { name: 'Cancel subscription' })).toHaveCount(0);
    await expect(next.getByRole('button', { name: 'Cancel the change' })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Staff see both subscriptions.
    await page.goto(companyPage);
    const panel = page.getByRole('region', { name: 'Plan subscription' });
    await expect(panel).toContainText(`${plus}, ₹2,535.82 per month (Authorised)`);
    await expect(panel.getByText('cancelled at its end', { exact: false })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  } finally {
    // Platform-wide settings: stop offering Plus and unset the tax, as the other tests expect.
    if (plusPage) {
      await page.goto(plusPage);
      const stop = page.getByRole('button', { name: 'Stop offering' });
      if (await stop.isVisible()) {
        await stop.click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Stop offering' }).click();
        await expect(page.getByRole('button', { name: 'Offer to companies' })).toBeVisible();
      }
    }
    await page.goto('/platform/plans');
    await page.getByLabel('Tax on plan prices (%)').fill('');
    await page.getByLabel('Reason', { exact: true }).fill('End of the plan change test');
    await page.getByRole('button', { name: 'Save tax' }).click();
    await expect(page.getByText('Companies cannot start paying for plans')).toBeVisible();
  }
});
