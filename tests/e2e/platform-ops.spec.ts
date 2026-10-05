import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import pg from 'pg';
import { expect, test } from './fixtures';
import {
  connectTestChannel,
  inboundMessage,
  messagingConfigured,
  randomWaId,
  sendSignedWebhook,
} from './messaging-support';
import {
  expectNoHorizontalOverflow,
  makePlatformOwner,
  platformConfigured,
  signUpAndVerify,
  turnOnTwoFactor,
  uniqueEmail,
} from './support';

const PASSWORD = 'correct horse battery staple 42';

/** A Meta-style numeric id no company has connected. */
const unknownId = () => `7${Date.now()}${Math.floor(Math.random() * 1e4)}`.slice(0, 16);

/** Clicks the page's "Download CSV" link and returns the file's suggested name and its text. */
async function downloadCsv(page: Page): Promise<{ name: string; text: string }> {
  const downloading = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download CSV' }).click();
  const download = await downloading;
  return {
    name: download.suggestedFilename(),
    text: await readFile(await download.path(), 'utf8'),
  };
}

test('staff read the operations console and repair a quarantined webhook event', async ({
  page,
  request,
}) => {
  test.skip(!platformConfigured, 'needs DATABASE_URL_MIGRATE and E2E_DATABASE_URL_AUTH');
  test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');
  test.setTimeout(210_000);
  const started = Date.now();
  const email = uniqueEmail('ops');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const companyName = `Ops Co ${suffix}`;
  await signUpAndVerify(page, { name: 'Omar Staff', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(`ops-${suffix}`);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: companyName })).toBeVisible();
  await turnOnTwoFactor(page, PASSWORD);
  await makePlatformOwner(email);

  // Two requests with one of the company's API keys: its plan counts them (ADR-061), and the
  // console's Usage tab shows the count (ADR-153).
  await page.goto(`/c/ops-${suffix}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Ops check');
  await page.getByRole('checkbox', { name: /Read contacts/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  for (const attempt of [1, 2]) {
    const listed = await request.get('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listed.status(), `request ${attempt}`).toBe(200);
  }

  // A signed event from a WhatsApp account no company connected: it is quarantined.
  const wabaId = unknownId();
  await sendSignedWebhook(request, inboundMessage(wabaId, unknownId(), randomWaId(), 'Hello?'));

  await page.goto('/platform');
  await page.getByRole('link', { name: 'Operations' }).click();
  await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible();
  const totals = page.getByRole('region', { name: 'Totals' });
  await expect(totals.getByText('Companies needing attention')).toBeVisible();
  await expect(totals.getByText('Webhook receipts needing attention')).toBeVisible();
  await expect(totals.getByText('Late queues')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  // Every company's health as CSV (ADR-155): the new company, healthy, with no number yet.
  const health = await downloadCsv(page);
  expect(health.name).toMatch(/^hyfib-health-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(health.text).toContain('Company,Address,Status,Plan status,Created,Health,Issues,');
  expect(health.text).toMatch(
    new RegExp(
      `\\r\\n${companyName},ops-${suffix},active,[a-z_]*,\\d{4}-\\d{2}-\\d{2},ok,,0,0,0,0,,,0,0,0,0,,0,0,0,0,0,0,0\\r\\n`,
    ),
  );

  // Onboarding: the new company has no WhatsApp number yet.
  const sections = page.getByRole('navigation', { name: 'Operations sections' });
  await sections.getByRole('link', { name: 'Onboarding' }).click();
  const stalled = page.getByRole('table', { name: 'New companies without an active number' });
  await expect(stalled.getByRole('row').filter({ hasText: companyName })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Integrations: the quarantined event names the unknown account; staff retry it, then resolve it.
  await sections.getByRole('link', { name: 'Integrations' }).click();
  await expect(page.getByRole('heading', { name: 'Current failures' })).toBeVisible();
  // Staff are emailed about what failed for good (ADR-091); the page says when the last alert went.
  await expect(
    page.getByText(/Platform administrators are emailed about each receipt that failed all/),
  ).toContainText(/the last email went out|none has gone out yet/);
  // And about each failing integration of a company, once (ADR-139).
  await expect(
    page.getByText(/Platform administrators are emailed about each failure once/),
  ).toContainText(/the last email went out|none has gone out yet/);
  const quarantine = page.getByRole('table', { name: 'Quarantined webhook events' });
  const row = quarantine.getByRole('row').filter({ hasText: wabaId });
  // The worker quarantines the receipt after the webhook is answered; the page shows what was
  // there when it rendered.
  await expect(async () => {
    await page.reload();
    await expect(row).toContainText('Unknown account or number', { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await expect(row).not.toContainText('Hello?');
  await row.getByText('Retry', { exact: true }).click();
  await row.getByLabel('Reason (the fix made)').fill('Checked the account mapping: retrying once');
  await row.getByRole('button', { name: 'Retry receipt' }).click();
  // Back to processing: the receipt is no longer quarantined, so it cannot be retried again here.
  await expect(row.getByText('Retry', { exact: true })).toHaveCount(0);
  await row.getByText('Resolve', { exact: true }).click();
  await row.getByLabel('Resolution').fill('Not a customer account: a Meta test account.');
  await row.getByRole('button', { name: 'Mark resolved' }).click();
  await expect(quarantine.getByRole('row').filter({ hasText: wabaId })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  // Queues, signals and usage.
  await sections.getByRole('link', { name: 'Queues' }).click();
  const queues = page.getByRole('table', { name: 'Job queues' });
  const queue = (name: string) =>
    queues.getByRole('row').filter({ has: page.getByText(name, { exact: true }) });
  await expect(queue('commerce.store')).toContainText('5 retries, then dead-lettered');
  await expect(queue('billing.auto-recharge')).toContainText('no retries');
  // The worker's minute sweep checks how long jobs wait (ADR-096): wait for a check made since this
  // test started (the description's time carries it to the second), so an earlier run's rows cannot
  // pass for it. Each queue then shows its oldest wait and its limit, and nothing warns that the
  // check has stopped.
  const lastCheck = page
    .getByText(/last checked \(/)
    .locator('time')
    .first();
  await expect(async () => {
    await page.reload();
    const at = await lastCheck.getAttribute('datetime', { timeout: 1_000 });
    expect(Date.parse(at ?? '')).toBeGreaterThan(started);
  }).toPass({ timeout: 90_000 });
  await expect(page.getByText('The worker is not checking the queues')).toHaveCount(0);
  await expect(queues.getByRole('columnheader', { name: 'Oldest wait' })).toBeVisible();
  await expect(queue('commerce.store')).toContainText('waits 60 min at most');
  await expect(queue('message.send')).toContainText('waits 15 min at most');
  await expectNoHorizontalOverflow(page);
  await sections.getByRole('link', { name: 'Signals' }).click();
  await expect(page.getByText('Sending signals (7 days)')).toBeVisible();
  // The tab as CSV (ADR-155): the new company has sent nothing, so it is not listed.
  const signals = await downloadCsv(page);
  expect(signals.name).toMatch(/^hyfib-signals-7-days-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(signals.text).toContain('Company,Address,Status,Sent,Failed,Marketing delivered,');
  expect(signals.text).not.toContain(companyName);
  await sections.getByRole('link', { name: 'Usage' }).click();
  const usage = page.getByRole('table', { name: 'Usage by company' });
  const usageRow = usage.getByRole('row').filter({ hasText: companyName });
  await expect(usageRow).toBeVisible();
  const usageColumns = await usage.getByRole('columnheader').allTextContents();
  const apiColumn = usageColumns.indexOf('API requests');
  expect(apiColumn).toBeGreaterThan(0);
  await expect(usageRow.getByRole('cell').nth(apiColumn)).toHaveText(
    /^2\s*from \d{4}-\d{2}-\d{2}$/,
  );
  // The same table as CSV (ADR-154): the company's line with its two API requests.
  const usageCsv = await downloadCsv(page);
  expect(usageCsv.name).toMatch(/^hyfib-usage-30-days-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(usageCsv.text).toContain('Company,Address,Status,Sent,');
  expect(usageCsv.text).toMatch(
    new RegExp(
      `\\r\\n${companyName},ops-${suffix},[a-z_]+,(?:\\d+,){10}(?:\\d{4}-\\d{2}-\\d{2})?,2,\\d{4}-\\d{2}-\\d{2},\\d+,\\d+,0,0\\r\\n`,
    ),
  );
  // Compared with the window before (ADR-157): 30 and 7 days are, 90 days are not.
  await expect(
    page.getByText('Under Sent and Received, the 30 days before and the change.'),
  ).toBeVisible();
  await page.getByRole('link', { name: '90 days' }).click();
  await expect(page.getByText('The 90 days before are not compared')).toBeVisible();
  await page.getByRole('link', { name: '7 days' }).click();
  await expect(page.getByText('By company (7 days)')).toBeVisible();
  await expect(
    page.getByText('Under Sent and Received, the 7 days before and the change.'),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Keys: the encryption keyring's key ids and how many stored values each sealed, never a key or a
  // value (ADR-134). One key is configured here, so there is nothing to re-encrypt.
  await sections.getByRole('link', { name: 'Keys' }).click();
  await expect(page.getByRole('heading', { name: 'Encryption keys' })).toBeVisible();
  await expect(page.getByText(/there is nothing to re-encrypt/)).toBeVisible();
  const keys = page.getByRole('table', { name: 'Encryption keys' });
  await expect(keys.getByRole('row').filter({ hasText: 'Primary' })).toHaveCount(1);
  // The webhook event above was stored sealed for its 7 days.
  const byKind = page.getByRole('table', { name: 'Sealed values by kind' });
  await expect(
    byKind.getByRole('row').filter({ hasText: 'Provider webhook bodies' }),
  ).toBeVisible();
  await expect(page.getByText('Values that cannot be opened')).toHaveCount(0);
  // Job signing (ADR-135): one signing key here, so no rotation and no job that will be refused.
  await expect(page.getByRole('heading', { name: 'Job signing keys' })).toBeVisible();
  await expect(page.getByText(/no rotation is in progress/)).toBeVisible();
  const signing = page.getByRole('table', { name: 'Job signing keys' });
  await expect(signing.getByRole('row').filter({ hasText: 'Signs new jobs' })).toHaveCount(1);
  await expect(page.getByText('Jobs that will be refused')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  // Both repairs are in the platform audit log; the company page shows its health.
  await page.goto('/platform');
  await expect(page.getByText('platform.webhook_receipt_retried').first()).toBeVisible();
  await expect(page.getByText('platform.webhook_quarantine_resolved').first()).toBeVisible();
  await page.goto(`/platform?q=ops-${suffix}`);
  await page.getByRole('link', { name: companyName }).click();
  await expect(page.getByRole('heading', { name: 'Health' })).toBeVisible();
  await expect(page.getByText('0 active of 0')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

/** Marks a company's number as failed, as a setup Meta refused leaves it (runtime role, its scope). */
async function failNumber(tenantId: string, phoneNumberId: string) {
  const app = new pg.Client({ connectionString: process.env.DATABASE_URL_APP });
  await app.connect();
  try {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const failed = await app.query(
      `UPDATE app.channel_accounts
          SET status = 'failed', onboarding_error = 'E2E: Meta refused the number''s registration.'
        WHERE phone_number_id = $1`,
      [phoneNumberId],
    );
    expect(failed.rowCount).toBe(1);
    await app.query('COMMIT');
  } finally {
    await app.end();
  }
}

test('staff acknowledge a company’s failing integration on the console, with a note (ADR-141)', async ({
  page,
}) => {
  test.skip(!platformConfigured, 'needs DATABASE_URL_MIGRATE and E2E_DATABASE_URL_AUTH');
  test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');
  test.setTimeout(150_000);
  const email = uniqueEmail('ack');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `ack-${suffix}`;
  const companyName = `Ack Co ${suffix}`;
  await signUpAndVerify(page, { name: 'Anil Staff', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: companyName })).toBeVisible();
  await turnOnTwoFactor(page, PASSWORD);
  await makePlatformOwner(email);

  // The company's number failed its setup: Operations → Integrations lists it.
  const { tenantId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });
  await failNumber(tenantId, phoneNumberId);
  await page.goto('/platform/ops/integrations');
  await expect(
    page.getByText(/acknowledges it with a note, so the others see who took it/),
  ).toBeVisible();
  const row = page
    .getByRole('table', { name: 'Current failures' })
    .getByRole('row')
    .filter({ hasText: companyName });
  await expect(row).toContainText('Failed');
  await expect(row).not.toContainText('By Anil Staff');

  await row.getByText('Acknowledge', { exact: true }).click();
  await row
    .getByLabel('Note (what was done or found)')
    .fill('Called the owner: they will reconnect the number today.');
  await row.getByRole('button', { name: 'Acknowledge failure' }).click();
  await expect(row).toContainText('By Anil Staff');
  await expect(row).toContainText('Called the owner: they will reconnect the number today.');
  await expect(row.getByText('Replace the note', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // In the platform audit log.
  await page.goto('/platform');
  await expect(page.getByText('platform.integration_failure_acknowledged').first()).toBeVisible();
});
