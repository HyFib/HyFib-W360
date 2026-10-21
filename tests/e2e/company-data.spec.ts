import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
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
const STAFF_REASON = 'Your service ends under clause 9 of the terms, as agreed in ticket 5120.';
const CANCEL_REASON = 'The owners settled the account with HyFib support today.';

async function newCompany(page: Page, prefix: string) {
  const email = uniqueEmail(prefix);
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `${prefix}-${suffix}`;
  const name = `Data Co ${suffix}`;
  await signUpAndVerify(page, { name: 'Asha Owner', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(name);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  return { email, slug, name };
}

async function scheduleDeletion(page: Page, slug: string) {
  await page.getByLabel(`Type the company address (${slug}) to confirm`).fill(slug);
  await page.getByRole('button', { name: 'Delete the company' }).click();
  await expect(page.getByText('This company is being deleted')).toBeVisible();
}

test('an owner downloads the company export, schedules the deletion and cancels it', async ({
  page,
}) => {
  const { email, slug, name } = await newCompany(page, 'data');
  await page.goto(`/c/${slug}/settings`);
  await page.getByRole('link', { name: 'Company data' }).click();
  await expect(page.getByRole('heading', { name: "Export the company's data" })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // The export: one gzip-compressed JSON Lines file, ending with its end line.
  const downloading = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download the export' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(
    new RegExp(`^hyfib-w360-${slug}-\\d{4}-\\d{2}-\\d{2}\\.jsonl\\.gz$`),
  );
  const lines = gunzipSync(await readFile(await download.path()))
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(lines[0]).toMatchObject({
    format: 'hyfib-w360-company-export',
    version: 1,
    company: { slug, name },
  });
  expect(lines.at(-1)).toMatchObject({ end: true });
  const members = lines.filter((line) => line.table === 'app.memberships');
  expect(members).toHaveLength(1);
  expect(members[0]).toMatchObject({ row: { user_email: email.toLowerCase(), roles: ['owner'] } });
  expect(JSON.stringify(lines)).not.toContain('"tenant_id"');
  await waitForEmail(email, 'Company data exported');

  // Deleting needs the company address typed exactly.
  const button = page.getByRole('button', { name: 'Delete the company' });
  await expect(button).toBeDisabled();
  await page.getByLabel(`Type the company address (${slug}) to confirm`).fill(`${slug}x`);
  await expect(button).toBeDisabled();
  await scheduleDeletion(page, slug);
  await expect(page.getByText(/This company will be deleted on/)).toBeVisible();
  await expect(page.getByText(/as Asha Owner asked on/)).toBeVisible();
  await waitForEmail(email, 'Company deletion scheduled');
  await expectNoHorizontalOverflow(page);
  // Meanwhile the company works as if suspended; the export is still there.
  await expect(page.getByRole('link', { name: 'Download the export' })).toBeVisible();

  await page.getByRole('button', { name: 'Cancel the deletion' }).click();
  await expect(page.getByText('This company is being deleted')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete the company' })).toBeVisible();
  await waitForEmail(email, 'Company deletion cancelled');
});

test('an owner asks for a stored export, the worker prepares it, and the owner downloads it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { email, slug, name } = await newCompany(page, 'stored');
  await page.goto(`/c/${slug}/settings/data`);
  await expect(page.getByRole('heading', { name: 'Stored exports' })).toBeVisible();
  await page.getByRole('button', { name: 'Prepare a stored export' }).click();
  // Told when asked for, and again when the worker has prepared it; the email links to the page.
  await waitForEmail(email, 'Company data export requested');
  const readyText = await waitForEmail(email, 'Company data export ready', 90_000);
  expect(readyText).toContain(`/c/${slug}/settings/data`);
  expect(readyText).not.toContain('/settings/data/exports/');

  await page.reload();
  const item = page.getByTestId('stored-export').first();
  await expect(item).toContainText('Ready');
  await expect(item).toContainText('SHA-256');
  await expectNoHorizontalOverflow(page);
  const downloading = page.waitForEvent('download');
  await item.getByRole('link', { name: 'Download the stored export' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(
    new RegExp(`^hyfib-w360-${slug}-\\d{4}-\\d{2}-\\d{2}\\.jsonl\\.gz$`),
  );
  const file = await readFile(await download.path());
  const sha256 = createHash('sha256').update(file).digest('hex');
  await expect(item).toContainText(sha256);
  const lines = gunzipSync(file)
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(lines[0]).toMatchObject({ format: 'hyfib-w360-company-export', company: { slug, name } });
  expect(lines.at(-1)).toMatchObject({ end: true });
  await waitForEmail(email, 'Company data export downloaded');

  // Someone not signed in cannot fetch it by its address.
  const href = await item
    .getByRole('link', { name: 'Download the stored export' })
    .getAttribute('href');
  expect(href).toMatch(new RegExp(`^/c/${slug}/settings/data/exports/[0-9a-f-]{36}$`));
  const outsider = await page.context().browser()!.newContext();
  try {
    const response = await outsider.request.get(new URL(href!, page.url()).toString(), {
      maxRedirects: 0,
    });
    expect(response.status()).not.toBe(200);
  } finally {
    await outsider.close();
  }
});

test('when the deletion is due, the worker deletes the company and tells its owner', async ({
  page,
}) => {
  test.skip(!platformConfigured, 'needs DATABASE_URL_MIGRATE and E2E_DATABASE_URL_AUTH');
  test.setTimeout(240_000);
  const { email, slug } = await newCompany(page, 'gone');
  await page.goto(`/c/${slug}/settings/data`);
  await scheduleDeletion(page, slug);

  // A fixture step: the 14 days go by (only the definer role may change the register).
  const owner = new pg.Client({ connectionString: process.env.DATABASE_URL_MIGRATE });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query('SET LOCAL ROLE w360_definer');
    const moved = await owner.query(
      `UPDATE ops.tenant_deletions d SET due_at = now() - interval '1 minute'
         FROM app.tenants t
        WHERE t.id = d.tenant_id AND t.slug = $1 AND d.cancelled_at IS NULL
          AND d.completed_at IS NULL`,
      [slug],
    );
    expect(moved.rowCount).toBe(1);
    await owner.query('COMMIT');
  } finally {
    await owner.end();
  }

  // The minute sweep starts the run; the owner hears when it is finished.
  const text = await waitForEmail(email, 'Company deleted', 200_000);
  expect(text).toMatch(/was deleted at the request of its owners/);
  await page.goto(`/c/${slug}`);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});

test('a platform owner schedules the deletion with a reason the company reads; only staff cancel it', async ({
  page,
}) => {
  test.skip(!platformConfigured, 'needs DATABASE_URL_MIGRATE and E2E_DATABASE_URL_AUTH');
  test.setTimeout(300_000);
  const { email, slug, name } = await newCompany(page, 'staffdel');
  // The same person is platform staff here too (a fixture step), with two-factor on.
  await turnOnTwoFactor(page, PASSWORD);
  await makePlatformOwner(email);

  await page.goto(`/platform?q=${slug}`);
  await page.getByRole('link', { name }).click();
  const schedule = page.getByRole('form', { name: 'Schedule the company’s deletion' });
  await schedule.getByLabel(/^Reason/).fill(STAFF_REASON);
  const button = schedule.getByRole('button', { name: 'Schedule the deletion' });
  await expect(button).toBeDisabled();
  await schedule.getByLabel(`Type the company address (${slug}) to confirm`).fill(`${slug}x`);
  await expect(button).toBeDisabled();
  await schedule.getByLabel(`Type the company address (${slug}) to confirm`).fill(slug);
  await button.click();
  await expect(page.getByText(/^Scheduled by HyFib staff/)).toBeVisible();
  await expect(page.locator('p', { hasText: STAFF_REASON })).toBeVisible();
  await expect(schedule).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  // The worker's minute sweep emails the owners and administrators HyFib's reason.
  const scheduled = await waitForEmail(email, 'HyFib scheduled the company for deletion', 150_000);
  expect(scheduled).toContain(`HyFib's reason: ${STAFF_REASON}`);
  expect(scheduled).toContain('Only HyFib can cancel this deletion.');

  // The company reads the reason and has no way to cancel; the export stays.
  await page.goto(`/c/${slug}/settings/data`);
  await expect(page.getByText('This company is being deleted')).toBeVisible();
  // The banner on every page says who scheduled it and why, and that only HyFib can cancel.
  const banner = page.getByRole('alert').filter({ hasText: 'This company is being deleted' });
  await expect(banner).toContainText(/It will be deleted on .+: HyFib scheduled the deletion\./);
  await expect(banner).toContainText('Only HyFib can cancel the deletion.');
  await expect(banner).toContainText(STAFF_REASON);
  await expect(
    page.getByText(/^This company will be deleted on .+, as HyFib scheduled on /),
  ).toBeVisible();
  await expect(page.locator('p', { hasText: STAFF_REASON })).toBeVisible();
  await expect(
    page.getByText('Only HyFib can cancel this deletion. Contact HyFib support to discuss it.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel the deletion' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Download the export' })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // A platform owner cancels it, with a reason; the company is back as it was.
  await page.goto(`/platform?q=${slug}`);
  await page.getByRole('link', { name }).click();
  const cancel = page.getByRole('form', { name: 'Cancel HyFib’s deletion' });
  await cancel.getByLabel(/^Reason for cancelling/).fill(CANCEL_REASON);
  await cancel.getByRole('button', { name: 'Cancel the deletion' }).click();
  await expect(page.locator('p', { hasText: CANCEL_REASON })).toBeVisible();
  await expect(cancel).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'Schedule the company’s deletion' })).toBeVisible();
  const cancelled = await waitForEmail(email, 'Company deletion cancelled', 150_000);
  expect(cancelled).toContain(`HyFib's reason: ${CANCEL_REASON}`);
  expect(cancelled).toContain('It works as before.');
  await page.goto(`/c/${slug}/settings/data`);
  await expect(page.getByText('This company is being deleted')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete the company' })).toBeVisible();
});
