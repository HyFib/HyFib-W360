import pg from 'pg';
import { expect, test } from './fixtures';
import {
  expectNoHorizontalOverflow,
  signUpAndVerify,
  uniqueEmail,
  waitForEmailContaining,
} from './support';

const PASSWORD = 'correct horse battery staple 42';
const configured = Boolean(process.env.DATABASE_URL_MIGRATE && process.env.DATABASE_URL_APP);

/**
 * A fixture step: the key's expiry comes within `days` days, as if it had been created long ago
 * (keys are created for at least 30 days, and an expiry can only come sooner). The owner role finds
 * the key's company as the definer role; the runtime role changes the key in that company's scope.
 */
async function bringExpiryForward(keyPrefix: string, days: number) {
  const owner = new pg.Client({ connectionString: process.env.DATABASE_URL_MIGRATE });
  await owner.connect();
  let tenantId: string;
  try {
    await owner.query('BEGIN');
    await owner.query('SET LOCAL ROLE w360_definer');
    const found = await owner.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM app.api_keys WHERE key_prefix = $1',
      [keyPrefix],
    );
    await owner.query('COMMIT');
    tenantId = found.rows[0]!.tenant_id;
  } finally {
    await owner.end();
  }
  const app = new pg.Client({ connectionString: process.env.DATABASE_URL_APP });
  await app.connect();
  try {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const moved = await app.query(
      `UPDATE app.api_keys SET expires_at = now() + $2 * interval '1 day' WHERE key_prefix = $1`,
      [keyPrefix, days],
    );
    expect(moved.rowCount).toBe(1);
    await app.query('COMMIT');
  } finally {
    await app.end();
  }
}

test('a key that expires within 7 days is marked in settings, and its owner is emailed once', async ({
  page,
}) => {
  test.skip(!configured, 'needs DATABASE_URL_MIGRATE and DATABASE_URL_APP');
  test.setTimeout(180_000);
  const email = uniqueEmail('keys');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `keys-${suffix}`;
  const companyName = `Keys Co ${suffix}`;
  await signUpAndVerify(page, { name: 'Kavya Keys', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: companyName })).toBeVisible();

  await page.goto(`/c/${slug}/settings/api-keys`);
  await expect(
    page.getByText('Owners and administrators are emailed 7 days before a key expires'),
  ).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Orders sync');
  await page.getByRole('checkbox', { name: /Read contacts/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const keyPrefix = token.slice(0, 'w360_'.length + 12);
  const item = page.getByRole('listitem').filter({ hasText: `${keyPrefix}_…` });
  await expect(item).toBeVisible();
  await expect(item.getByText('Expires soon')).toHaveCount(0);

  await bringExpiryForward(keyPrefix, 3);
  await page.reload();
  await expect(item.getByText('Expires soon')).toBeVisible();

  // The worker's minute sweep emails the owner (ADR-067).
  const text = await waitForEmailContaining(
    email,
    'API key “Orders sync” expires on',
    `The API key “Orders sync” (${keyPrefix}_…) expires on`,
    90_000,
  );
  expect(text).toContain('It was created by Kavya Keys on');
  expect(text).toContain('and has not been used.');
  expect(text).toContain('rotate the key in Settings → API keys');
  expect(text).toContain(`/c/${slug}/settings/api-keys`);
  expect(text).not.toContain(token);

  await page.reload();
  await expect(item.getByText('Expiry reminder emailed')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('a burst beyond a key’s rate limit is refused with 429 and Retry-After, and the key works again a moment later', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail('burst');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `burst-${suffix}`;
  const companyName = `Burst Co ${suffix}`;
  await signUpAndVerify(page, { name: 'Bala Burst', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: companyName })).toBeVisible();
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Busy sync');
  await page.getByRole('checkbox', { name: /Read contacts/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();

  // 120 requests at once: a key allows bursts of 50 and 10 more a second (ADR-052).
  const auth = { Authorization: `Bearer ${token}` };
  const responses = await Promise.all(
    Array.from({ length: 120 }, () => request.get('/api/v1/contacts', { headers: auth })),
  );
  const statuses = responses.map((r) => r.status());
  expect(statuses.filter((s) => s !== 200 && s !== 429)).toEqual([]);
  expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(50);
  const refused = responses.filter((r) => r.status() === 429);
  expect(refused.length).toBeGreaterThan(0);
  expect(refused[0]!.headers()['retry-after']).toBe('1');
  const body = (await refused[0]!.json()) as { error: { code: string }; requestId: string };
  expect(body.error.code).toBe('rate_limited');
  expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);

  // The key's bucket refills: after the wait it asked for, the key works again.
  await expect
    .poll(async () => (await request.get('/api/v1/contacts', { headers: auth })).status(), {
      timeout: 10_000,
      intervals: [1_000],
    })
    .toBe(200);
});

test('a key limited to listed addresses refuses requests from other addresses until its addresses are changed', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('nets');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `nets-${suffix}`;
  const companyName = `Nets Co ${suffix}`;
  await signUpAndVerify(page, { name: 'Neha Nets', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: companyName })).toBeVisible();

  // A key that accepts requests from one network only (ADR-076).
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Office sync');
  await page.getByRole('checkbox', { name: /Read contacts/ }).check();
  await page.getByLabel('Allowed addresses (optional)').fill('198.51.100.0/24');
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  await expect(page.getByText('198.51.100.0/24', { exact: true })).toBeVisible();

  // The client's address comes from X-Forwarded-For (no proxy is trusted in this setup).
  const from = (address?: string) =>
    request.get('/api/v1/contacts', {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(address ? { 'X-Forwarded-For': address } : {}),
      },
    });
  const outside = await from('203.0.113.5');
  expect(outside.status()).toBe(403);
  const refusal = (await outside.json()) as {
    error: { code: string; reason: string; message: string };
  };
  expect(refusal.error).toMatchObject({ code: 'forbidden', reason: 'ip_not_allowed' });
  expect(refusal.error.message).toContain('203.0.113.5');
  expect((await from('198.51.100.20')).status()).toBe(200);
  // Without the header, the address is the connection's, which is not listed either.
  expect((await from()).status()).toBe(403);
  // Refusals count as failed authentication for the address (bursts of 20): a client that keeps
  // trying from elsewhere is slowed like one with a wrong key.
  const burst = await Promise.all(Array.from({ length: 25 }, () => from('192.0.2.77')));
  const statuses = burst.map((r) => r.status());
  expect(statuses.filter((s) => s !== 403 && s !== 429)).toEqual([]);
  expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(5);

  // The owner adds the other office's addresses; the next request is accepted.
  await page.getByRole('button', { name: 'Addresses for Office sync' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel('Allowed addresses (optional)').fill('198.51.100.0/24\n203.0.113.5');
  await dialog.getByRole('button', { name: 'Save addresses' }).click();
  await expect(page.getByText('198.51.100.0/24, 203.0.113.5', { exact: true })).toBeVisible();
  expect((await from('203.0.113.5')).status()).toBe(200);
  await expectNoHorizontalOverflow(page);
});

test('a key with its own monthly limit is refused once it is used up, and its owner emailed, until the limit is raised', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('keylimit');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `keylimit-${suffix}`;
  const companyName = `Key Limit Co ${suffix}`;
  await signUpAndVerify(page, { name: 'Kiran Limit', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: companyName })).toBeVisible();

  // A partner's key allowed three requests a month of its own (ADR-097); the company's plan has
  // no monthly limit.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Partner feed');
  await page.getByRole('checkbox', { name: /Read contacts/ }).check();
  await page.getByLabel('Monthly request limit (optional)').fill('3');
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  await expect(
    page.getByText(/Requests this period:\s*0 of 3\s*\(its own monthly limit\)/),
  ).toBeVisible();

  const call = () =>
    request.get('/api/v1/contacts', { headers: { Authorization: `Bearer ${token}` } });
  for (let i = 0; i < 3; i += 1) expect((await call()).status()).toBe(200);
  const refused = await call();
  expect(refused.status()).toBe(429);
  expect(Number(refused.headers()['retry-after'])).toBeGreaterThan(0);
  const body = (await refused.json()) as {
    error: { code: string; reason: string; message: string };
  };
  expect(body.error).toMatchObject({ code: 'rate_limited', reason: 'key_quota_exceeded' });
  expect(body.error.message).toContain('This API key allows 3 requests a month');

  // The worker's minute sweep emails the owner that the key used its month (ADR-098).
  const mail = await waitForEmailContaining(
    email,
    'API key “Partner feed” has used all 3 of its requests this month',
    'The API refuses its requests (429, reason key_quota_exceeded)',
    90_000,
  );
  expect(mail).toContain(`/c/${slug}/settings/api-keys`);
  expect(mail).not.toContain(token);

  // The page shows the key used up; the refused request is not counted for the company.
  await page.reload();
  await expect(page.getByText(/Requests this period:\s*3 of 3/)).toBeVisible();
  await expect(page.getByText('Monthly limit reached', { exact: true })).toBeVisible();
  await expect(page.getByText('Limit reached emailed')).toBeVisible();
  await expect(
    page.getByText(/:\s*3\s*API requests; your plan has no monthly limit\./),
  ).toBeVisible();

  // The owner raises the key's limit; the next request is accepted at once.
  await page.getByRole('button', { name: 'Limit for Partner feed' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel('Monthly request limit (optional)').fill('5');
  await dialog.getByRole('button', { name: 'Save limit' }).click();
  await expect(
    page.getByText(/Requests this period:\s*3 of 5\s*\(its own monthly limit\)/),
  ).toBeVisible();
  await expect(page.getByText('Monthly limit reached', { exact: true })).toHaveCount(0);
  expect((await call()).status()).toBe(200);

  // Emptied, only the plan limits the key.
  await page.getByRole('button', { name: 'Limit for Partner feed' }).click();
  await page.getByRole('alertdialog').getByLabel('Monthly request limit (optional)').fill('');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Save limit' }).click();
  await expect(page.getByText(/\(no limit of its own\)/)).toBeVisible();
  expect((await call()).status()).toBe(200);
  await page.reload();
  await expect(page.getByText(/Requests this period:\s*5\s*\(no limit of its own\)/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
