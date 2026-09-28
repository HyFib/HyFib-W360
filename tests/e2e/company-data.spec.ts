import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  expectNoHorizontalOverflow,
  platformConfigured,
  signUpAndVerify,
  uniqueEmail,
  waitForEmail,
} from './support';

const PASSWORD = 'correct horse battery staple 42';

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
