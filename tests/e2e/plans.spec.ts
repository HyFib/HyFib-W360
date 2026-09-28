import pg from 'pg';
import { expect, test } from './fixtures';
import { expectNoHorizontalOverflow, signUpAndVerify, totp, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

const configured = Boolean(process.env.DATABASE_URL_MIGRATE && process.env.E2E_DATABASE_URL_AUTH);

/** Makes the user a platform owner (a fixture step: staff are added by operators, not in the UI). */
async function makePlatformOwner(email: string) {
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
  const owner = new pg.Client({ connectionString: process.env.DATABASE_URL_MIGRATE });
  await owner.connect();
  try {
    await owner.query(
      `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_owner')`,
      [userId],
    );
  } finally {
    await owner.end();
  }
}

test('staff publish a plan and put a company on it; the company sees its plan, limits and restriction', async ({
  page,
}) => {
  test.skip(!configured, 'needs DATABASE_URL_MIGRATE and E2E_DATABASE_URL_AUTH');
  const email = uniqueEmail('plans');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `plans-${suffix}`;
  const companyName = `Plan Co ${suffix}`;
  await signUpAndVerify(page, { name: 'Priya Staff', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: companyName })).toBeVisible();

  // Platform staff need two-factor authentication.
  await page.goto('/account');
  await page.getByLabel('Current password').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Set up two-factor' }).click();
  const secret = (await page.locator('code').first().textContent())?.trim() ?? '';
  await page.getByLabel('Code from your app').fill(totp(secret));
  await page.getByRole('button', { name: 'Turn on two-factor' }).click();
  await expect(page.getByText('Backup codes', { exact: true })).toBeVisible();
  await makePlatformOwner(email);

  // A plan with one seat and only the CRM module.
  await page.goto('/platform/plans');
  await page.getByRole('link', { name: 'New plan' }).click();
  await page.getByLabel('Code', { exact: true }).fill(`starter-${suffix}`);
  await page.getByLabel('Name shown to companies').fill('Starter');
  await page.getByLabel('Price (₹)').fill('1999');
  await page.getByLabel('Seats included').fill('1');
  await page.getByLabel('Numbers included').fill('1');
  await page.getByLabel('Teams', { exact: true }).fill('1');
  await page.getByLabel('CRM', { exact: true }).check();
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: /Starter/ })).toBeVisible();
  await expect(page.getByText('draft', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('published', { exact: true }).first()).toBeVisible();

  // The company goes on it for a paid period.
  await page.goto(`/platform?q=${slug}`);
  await page.getByRole('link', { name: companyName }).click();
  await page.getByLabel('The company gets').selectOption('active');
  await page
    .getByLabel('Plan', { exact: true })
    .selectOption({ label: `Starter (starter-${suffix} v1)` });
  await page
    .getByLabel('Reason (shown in the company’s audit log)')
    .fill('Invoice INV-2026-0042 paid by bank transfer');
  await page.getByRole('button', { name: 'Save plan' }).click();
  await expect(page.getByText('The company’s plan was changed.')).toBeVisible();

  // The company's view: the plan, its usage and what it leaves out.
  await page.goto(`/c/${slug}/billing`);
  await expect(page.getByText('Starter plan')).toBeVisible();
  await expect(page.getByText('Active', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('1 of 1').first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.goto(`/c/${slug}/settings/members`);
  await expect(page.getByText("Your plan's one seat is in use")).toBeVisible();
  await page.goto(`/c/${slug}/automations`);
  await expect(page.getByText('Your plan does not include Automations')).toBeVisible();
  // Without automations.write the form to create one is not offered.
  await expect(page.getByRole('heading', { name: 'New automation' })).toHaveCount(0);
  await page.goto(`/c/${slug}/settings/modules`);
  await expect(page.getByText('Not included (read only)').first()).toBeVisible();

  // Staff end the plan: the company is restricted until it is on a plan again.
  await page.goto(`/platform?q=${slug}`);
  await page.getByRole('link', { name: companyName }).click();
  await page.getByLabel('The company gets').selectOption('canceled');
  await page
    .getByLabel('Reason (shown in the company’s audit log)')
    .fill('Customer asked to stop at the end of the month');
  await page.getByRole('button', { name: 'End the plan' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'End the plan' }).click();
  await expect(page.getByText('The company’s plan was changed.')).toBeVisible();
  await page.goto(`/c/${slug}`);
  await expect(page.getByText("This company's plan has ended")).toBeVisible();
});
