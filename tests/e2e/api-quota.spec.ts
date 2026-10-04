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

test('a plan allows five API requests a month: nearly used up at four, the sixth is refused', async ({
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

  // Staff publish a plan with five API requests a month and put the company on it.
  await turnOnTwoFactor(page, PASSWORD);
  await makePlatformOwner(email);
  await page.goto('/platform/plans');
  await page.getByRole('link', { name: 'New plan' }).click();
  await page.getByLabel('Code', { exact: true }).fill(`api-${suffix}`);
  await page.getByLabel('Name shown to companies').fill('Developer');
  await page.getByLabel('Price (₹)').fill('499');
  await page.getByLabel('Seats included').fill('2');
  await page.getByLabel('Numbers included').fill('1');
  await page.getByLabel('API requests a month').fill('5');
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
  ).toContainText('5');
  await page.goto(`/platform?q=${slug}`);
  await page.getByRole('link', { name: companyName }).click();
  await page.getByLabel('The company gets').selectOption('active');
  await page
    .getByLabel('Plan', { exact: true })
    .selectOption({ label: `Developer (api-${suffix} v1)` });
  await page
    .getByLabel('Reason (emailed to the billing managers, and shown in the company’s audit log)')
    .fill('Invoice INV-2026-0099 paid by bank transfer');
  await page.getByRole('button', { name: 'Save plan' }).click();
  await expect(page.getByText('The company’s plan was changed.')).toBeVisible();

  // Four requests: 80% of the month's, so the plan card marks them nearly used up (ADR-062).
  const auth = { Authorization: `Bearer ${token}` };
  const call = () => request.get('/api/v1/contacts', { headers: auth });
  for (let i = 0; i < 4; i += 1) expect((await call()).status()).toBe(200);
  // Members who read billing see it on every page of the company (ADR-140), with a link to Billing.
  await page.goto(`/c/${slug}`);
  const nearly = page
    .getByRole('status')
    .filter({ hasText: "This month's API requests are nearly used up" });
  await expect(nearly).toContainText(
    'Your company has used 4 of its 5 API requests for this month.',
  );
  await expect(nearly.getByRole('link', { name: 'See the plan' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.goto(`/c/${slug}/billing`);
  await expect(page.getByRole('row', { name: /API requests this month/ })).toContainText(
    '4 of 5 (nearly used up)',
  );
  // Billing shows the notice without a link to itself.
  await expect(nearly).toBeVisible();
  await expect(nearly.getByRole('link', { name: 'See the plan' })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  // The fifth passes; the sixth is refused with the reason and when to retry.
  expect((await call()).status()).toBe(200);
  const refused = await call();
  expect(refused.status()).toBe(429);
  expect(Number(refused.headers()['retry-after'])).toBeGreaterThan(0);
  const body = (await refused.json()) as { error: { code: string; reason: string } };
  expect(body.error).toMatchObject({ code: 'rate_limited', reason: 'quota_exceeded' });

  // The company sees the month's use on the API keys page and its plan, and why requests fail.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await expect(page.getByText(/5 of 5\s*API requests/)).toBeVisible();
  await expect(
    page.getByRole('alert').filter({ hasText: "This month's API requests are used up" }),
  ).toContainText('The public API refuses requests (429, reason quota_exceeded) until');
  await page.goto(`/c/${slug}/billing`);
  await expect(page.getByRole('row', { name: /API requests this month/ })).toContainText('5 of 5');
  await expectNoHorizontalOverflow(page);
});

test('a plan without webhook management: its keys and requests follow the scopes it includes', async ({
  page,
  request,
}) => {
  test.skip(!configured, 'needs DATABASE_URL_MIGRATE and E2E_DATABASE_URL_AUTH');
  test.setTimeout(120_000);
  const email = uniqueEmail('scopes');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `scopes-${suffix}`;
  const companyName = `Scopes Co ${suffix}`;
  await signUpAndVerify(page, { name: 'Sana Scopes', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: companyName })).toBeVisible();

  // On complimentary access every scope is offered: a key that reads contacts and adds endpoints.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Order system');
  await page.getByRole('checkbox', { name: /Read contacts/ }).check();
  await page.getByRole('checkbox', { name: /Manage webhook endpoints/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();

  // Staff publish a plan that includes reading templates and contacts only.
  await turnOnTwoFactor(page, PASSWORD);
  await makePlatformOwner(email);
  await page.goto('/platform/plans');
  await page.getByRole('link', { name: 'New plan' }).click();
  await page.getByLabel('Code', { exact: true }).fill(`scopes-${suffix}`);
  await page.getByLabel('Name shown to companies').fill('Read only');
  await page.getByLabel('Price (₹)').fill('299');
  await page.getByLabel('Seats included').fill('2');
  await page.getByLabel('Numbers included').fill('1');
  await page.getByLabel('The plan includes').selectOption('chosen');
  await page.getByRole('checkbox', { name: 'Read contacts (contacts.read)' }).check();
  await page.getByRole('checkbox', { name: 'Read templates (templates.read)' }).check();
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: /Read only/ })).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('published', { exact: true }).first()).toBeVisible();
  await expect(
    page
      .locator('dt')
      .filter({ hasText: /^API scopes$/ })
      .locator('..'),
  ).toContainText('Read templates, Read contacts');
  await page.goto(`/platform?q=${slug}`);
  await page.getByRole('link', { name: companyName }).click();
  await page.getByLabel('The company gets').selectOption('active');
  await page
    .getByLabel('Plan', { exact: true })
    .selectOption({ label: `Read only (scopes-${suffix} v1)` });
  await page
    .getByLabel('Reason (emailed to the billing managers, and shown in the company’s audit log)')
    .fill('Invoice INV-2026-0142 paid by bank transfer');
  await page.getByRole('button', { name: 'Save plan' }).click();
  await expect(page.getByText('The company’s plan was changed.')).toBeVisible();

  // The same key: contacts are read, endpoints refused because the plan leaves the scope out.
  const auth = { Authorization: `Bearer ${token}` };
  expect((await request.get('/api/v1/contacts', { headers: auth })).status()).toBe(200);
  const refused = await request.get('/api/v1/webhook-endpoints', { headers: auth });
  expect(refused.status()).toBe(403);
  const body = (await refused.json()) as {
    error: { code: string; reason: string; message: string };
  };
  expect(body.error).toMatchObject({ code: 'forbidden', reason: 'not_in_plan' });
  expect(body.error.message).toContain('webhooks.manage');

  // The company sees what its plan includes, the key's scope it leaves out, and cannot grant it.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await expect(
    page.getByText('Your plan includes these scopes: Read templates, Read contacts.'),
  ).toBeVisible();
  await expect(page.getByText('Manage webhook endpoints: not in your plan')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Manage webhook endpoints/ })).toBeDisabled();
  await expect(page.getByText(/Your company’s plan does not include it\./).first()).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Read templates/ })).toBeEnabled();
  await expectNoHorizontalOverflow(page);
  await page.goto(`/c/${slug}/billing`);
  await expect(page.getByRole('row', { name: /API scopes/ })).toContainText(
    'Read templates, Read contacts',
  );
  await expectNoHorizontalOverflow(page);
});
