import { expect, test } from './fixtures';
import {
  expectNoHorizontalOverflow,
  makePlatformOwner,
  platformConfigured as configured,
  signUpAndVerify,
  turnOnTwoFactor,
  uniqueEmail,
} from './support';

const PASSWORD = 'correct horse battery staple 42';

test('a plan allows two API requests a month: the third is refused until the next period', async ({
  page,
  request,
}) => {
  test.skip(!configured, 'needs DATABASE_URL_MIGRATE and E2E_DATABASE_URL_AUTH');
  test.setTimeout(120_000);
  const email = uniqueEmail('quota');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `quota-${suffix}`;
  const companyName = `Quota Co ${suffix}`;
  await signUpAndVerify(page, { name: 'Qasim Quota', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: companyName })).toBeVisible();

  // A key that reads contacts, made while the company is on complimentary access.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await expect(page.getByText('your plan has no monthly limit')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('CRM sync');
  await page.getByRole('checkbox', { name: /Read contacts/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();

  // Staff publish a plan with two API requests a month and put the company on it.
  await turnOnTwoFactor(page, PASSWORD);
  await makePlatformOwner(email);
  await page.goto('/platform/plans');
  await page.getByRole('link', { name: 'New plan' }).click();
  await page.getByLabel('Code', { exact: true }).fill(`api-${suffix}`);
  await page.getByLabel('Name shown to companies').fill('Developer');
  await page.getByLabel('Price (₹)').fill('499');
  await page.getByLabel('Seats included').fill('2');
  await page.getByLabel('Numbers included').fill('1');
  await page.getByLabel('API requests a month').fill('2');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: /Developer/ })).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('published', { exact: true }).first()).toBeVisible();
  await expect(
    page
      .locator('dt')
      .filter({ hasText: /^API requests a month$/ })
      .locator('..'),
  ).toContainText('2');
  await page.goto(`/platform?q=${slug}`);
  await page.getByRole('link', { name: companyName }).click();
  await page.getByLabel('The company gets').selectOption('active');
  await page
    .getByLabel('Plan', { exact: true })
    .selectOption({ label: `Developer (api-${suffix} v1)` });
  await page
    .getByLabel('Reason (shown in the company’s audit log)')
    .fill('Invoice INV-2026-0099 paid by bank transfer');
  await page.getByRole('button', { name: 'Save plan' }).click();
  await expect(page.getByText('The company’s plan was changed.')).toBeVisible();

  // Two requests pass; the third is refused with the reason and when to retry.
  const auth = { Authorization: `Bearer ${token}` };
  for (let i = 0; i < 2; i += 1) {
    const ok = await request.get('/api/v1/contacts', { headers: auth });
    expect(ok.status()).toBe(200);
  }
  const refused = await request.get('/api/v1/contacts', { headers: auth });
  expect(refused.status()).toBe(429);
  expect(Number(refused.headers()['retry-after'])).toBeGreaterThan(0);
  const body = (await refused.json()) as { error: { code: string; reason: string } };
  expect(body.error).toMatchObject({ code: 'rate_limited', reason: 'quota_exceeded' });

  // The company sees the month's use on the API keys page and its plan.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await expect(page.getByText(/2 of 2\s*API requests/)).toBeVisible();
  await page.goto(`/c/${slug}/billing`);
  await expect(page.getByRole('row', { name: /API requests this month/ })).toContainText('2 of 2');
  await expectNoHorizontalOverflow(page);
});
