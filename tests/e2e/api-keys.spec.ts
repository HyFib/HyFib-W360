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
