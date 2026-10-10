import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

/**
 * Clicks a "Download CSV" link and returns the file's suggested name and its text. A tab with several
 * lists names each link after its list (ADR-158).
 */
async function downloadCsv(
  page: Page,
  name = 'Download CSV',
): Promise<{ name: string; text: string }> {
  const downloading = page.waitForEvent('download');
  await page.getByRole('link', { name, exact: true }).click();
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
  // Each of the tab's lists as CSV (ADR-158), the new company among those without a number.
  const signups = await downloadCsv(page, 'Download CSV: Signups that failed or were abandoned');
  expect(signups.name).toMatch(/^hyfib-signups-30-days-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(signups.text).toContain(
    'Company,Address,Outcome,Reason,Started (UTC),Active number now\r\n',
  );
  const setups = await downloadCsv(page, 'Download CSV: Number setups that failed or are stuck');
  expect(setups.name).toMatch(/^hyfib-number-setups-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(setups.text).toContain('Company,Address,Number,State,Step,Error,Since (UTC)\r\n');
  const newCompanies = await downloadCsv(
    page,
    'Download CSV: New companies without an active number',
  );
  expect(newCompanies.name).toMatch(/^hyfib-new-companies-30-days-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(newCompanies.text).toContain(
    'Company,Address,Status,Created (UTC),Number being set up\r\n',
  );
  expect(newCompanies.text).toMatch(
    new RegExp(
      `\\r\\n${companyName},ops-${suffix},active,\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2},No\\r\\n`,
    ),
  );

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
  // The tab's lists as CSV (ADR-158): the quarantined event with the account's id, never the
  // message.
  const quarantineCsv = await downloadCsv(page, 'Download CSV: Quarantined webhook events');
  expect(quarantineCsv.name).toMatch(/^hyfib-quarantine-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(quarantineCsv.text).toContain(
    'Quarantined (UTC),Receipt,From,Reason,Provider ids,Staff emailed (UTC),Receipt can be retried,Acknowledged (UTC)\r\n',
  );
  expect(quarantineCsv.text).toMatch(
    new RegExp(`,Meta \\(WhatsApp\\),Unknown account or number,[^,]*waba: ${wabaId}[^,]*,`),
  );
  expect(quarantineCsv.text).not.toContain('Hello?');
  for (const [list, file, header] of [
    [
      'Current failures',
      'failures',
      'Company,Address,What,Label,State,Error,Since (UTC),Acknowledged (UTC)',
    ],
    [
      'Meta and Razorpay webhook receipts',
      'receipts',
      'Received (UTC),Receipt,From,Problem,Attempts,Last error,Staff emailed (UTC),Retry,Acknowledged (UTC)',
    ],
    ['Email delivery (7 days)', 'emails-7-days', 'Kind,Failed,Waiting'],
  ] as const) {
    const csv = await downloadCsv(page, `Download CSV: ${list}`);
    expect(csv.name).toMatch(new RegExp(`^hyfib-${file}-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
    expect(csv.text.startsWith(`\uFEFF${header}\r\n`)).toBe(true);
  }
  await row.getByText('Retry', { exact: true }).click();
  await row.getByLabel('Reason (the fix made)').fill('Checked the account mapping: retrying once');
  await row.getByRole('button', { name: 'Retry receipt' }).click();
  // Back to processing: the receipt is no longer quarantined, so it cannot be retried again here.
  await expect(row.getByText('Retry', { exact: true })).toHaveCount(0);
  // Before resolving it, the administrator notes what they found (ADR-199): the row shows the note,
  // and a later one would replace it.
  await row.getByText('Acknowledge', { exact: true }).click();
  await row
    .getByLabel('Note (what was found or done)')
    .fill('A Meta test account: asked Meta to confirm.');
  await row.getByRole('button', { name: 'Acknowledge entry' }).click();
  await expect(row).toContainText('A Meta test account: asked Meta to confirm.');
  await expect(row.getByText('Replace the note', { exact: true })).toBeVisible();
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
  // Both lists as CSV (ADR-158): every queue with its policy and counts, and the dead letters.
  const queuesCsv = await downloadCsv(page, 'Download CSV: Job queues');
  expect(queuesCsv.name).toMatch(/^hyfib-queues-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(queuesCsv.text).toContain(
    'Queue,Declared by this release,Retries,Dead-lettered after its retries,Wait limit (minutes),In the database,',
  );
  expect(queuesCsv.text).toMatch(/\r\ncommerce\.store,Yes,5,Yes,60,Yes,\d+,\d+,\d+,\d+,/);
  // When a late queue was acknowledged is a column of its own (ADR-177), never who or the note.
  expect(queuesCsv.text).toContain('Staff emailed (UTC),Acknowledged (UTC),Waits checked (UTC)');
  // A queue that never retries still dead-letters its failures, and the outbox sweep, which
  // retries once, has no dead letter (packages/contracts/src/jobs.ts).
  expect(queuesCsv.text).toMatch(/\r\nbilling\.auto-recharge,Yes,0,Yes,15,Yes,\d+,/);
  expect(queuesCsv.text).toMatch(/\r\nops\.outbox-sweep,Yes,1,No,15,Yes,\d+,/);
  const deadLetters = await downloadCsv(page, 'Download CSV: Recent dead letters');
  expect(deadLetters.name).toMatch(/^hyfib-dead-letters-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(deadLetters.text).toContain(
    'Failed (UTC),Dead letter,Queue,Signature verified,Company,Address,Reference,Error,',
  );
  await sections.getByRole('link', { name: 'Signals' }).click();
  await expect(page.getByText('Sending signals (7 days)')).toBeVisible();
  // The tab as CSV (ADR-155): the new company has sent nothing, so it is not listed.
  const signals = await downloadCsv(page);
  expect(signals.name).toMatch(/^hyfib-signals-7-days-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(signals.text).toContain('Company,Address,Status,Sent,Failed,Marketing delivered,');
  expect(signals.text).not.toContain(companyName);
  await sections.getByRole('link', { name: 'Usage' }).click();
  // The tabs change on the client: wait for the Usage tab itself before reading its pages, since
  // the Signals tab shows companies a page too.
  await expect(page).toHaveURL(/\/platform\/ops\/usage$/);
  const usage = page.getByRole('table', { name: 'Usage by company' });
  await expect(usage).toBeVisible();
  const usageRow = usage.getByRole('row').filter({ hasText: companyName });
  // 100 companies a page, busiest first (ADR-331): follow the pages until the new company shows.
  await expect(page.getByText(/^Companies 1–[\d,]+ of [\d,]+$/)).toBeVisible();
  const pager = page.getByRole('navigation', { name: 'Pages of companies' });
  for (let next = 2; (await usageRow.count()) === 0; next += 1) {
    const nextPage = pager.getByRole('link', { name: 'Next page' });
    await expect(nextPage, 'the new company is on one of the pages').toBeVisible();
    await nextPage.click();
    await expect(page).toHaveURL(new RegExp(`[?&]page=${next}(&|$)`));
    await expect(pager).toContainText(`Page ${next} of`);
  }
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
  // A company without messages says so where its days would be drawn (ADR-334).
  await expect(
    page.getByText('The company sent and received no message in these 30 days.'),
  ).toBeVisible();
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
  // Platform administrators are shared by every run, so this one's name is its own; the
  // Administrator list marks the reader (ADR-325).
  const staff = `Anil Staff ${suffix}`;
  await signUpAndVerify(page, { name: staff, email, password: PASSWORD });
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
  await expect(row).not.toContainText(`By ${staff}`);

  await row.getByText('Acknowledge', { exact: true }).click();
  await row
    .getByLabel('Note (what was done or found)')
    .fill('Called the owner: they will reconnect the number today.');
  await row.getByRole('button', { name: 'Acknowledge failure' }).click();
  await expect(row).toContainText(`By ${staff}`);
  await expect(row).toContainText('Called the owner: they will reconnect the number today.');
  await expect(row.getByText('Replace the note', { exact: true })).toBeVisible();
  // Unassigned (ADR-318): listed there until someone takes it.
  const views = page.getByRole('navigation', { name: 'Failures shown' });
  await views.getByRole('link', { name: 'Unassigned' }).click();
  await expect(page).toHaveURL(/\/platform\/ops\/integrations\?failures=unassigned$/);
  await expect(row).toContainText('Failed');
  await views.getByRole('link', { name: 'All failures' }).click();
  await expect(page).toHaveURL(/\/platform\/ops\/integrations$/);
  // Assigned to an administrator, here the one who took it (ADR-313).
  await expect(row).not.toContainText(`To ${staff}`);
  await row.getByText('Assign', { exact: true }).click();
  await row.getByLabel('Administrator').selectOption({ label: `${staff} (you)` });
  await row.getByRole('button', { name: 'Assign failure' }).click();
  await expect(row).toContainText(`To ${staff}`);
  await expect(row.getByText('Reassign', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  // Assigned to me (ADR-315): this failure, the only one assigned to them.
  await expect(views.getByRole('link', { name: 'All failures' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await views.getByRole('link', { name: 'Assigned to me' }).click();
  await expect(page).toHaveURL(/\/platform\/ops\/integrations\?failures=mine$/);
  await expect(views.getByRole('link', { name: 'Assigned to me' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const assigned = page.getByRole('table', { name: 'Current failures' }).getByRole('row');
  // The header and the one failure.
  await expect(assigned).toHaveCount(2);
  await expect(assigned.filter({ hasText: companyName })).toContainText(`To ${staff}`);
  await expectNoHorizontalOverflow(page);
  // No longer unassigned.
  await views.getByRole('link', { name: 'Unassigned' }).click();
  await expect(page).toHaveURL(/\/platform\/ops\/integrations\?failures=unassigned$/);
  await expect(row).toHaveCount(0);
  await views.getByRole('link', { name: 'All failures' }).click();
  await expect(page).toHaveURL(/\/platform\/ops\/integrations$/);
  await expect(row).toContainText(`To ${staff}`);
  // The list as CSV (ADR-158): when the failure was acknowledged, but neither by whom nor the note,
  // and no assignment.
  const failures = await downloadCsv(page, 'Download CSV: Current failures');
  expect(failures.name).toMatch(/^hyfib-failures-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(failures.text).toMatch(
    new RegExp(
      `\\r\\n${companyName},${slug},WhatsApp number,[^,]*,Failed,` +
        `E2E: Meta refused the number's registration\\.,` +
        '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2},\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}\\r\\n',
    ),
  );
  expect(failures.text).not.toContain('Called the owner');
  expect(failures.text).not.toContain('Anil Staff');

  // In the platform audit log.
  await page.goto('/platform');
  await expect(page.getByText('platform.integration_failure_acknowledged').first()).toBeVisible();
  await expect(page.getByText('platform.integration_failure_assigned').first()).toBeVisible();
});

/** A UTC day, YYYY-MM-DD, as the chart names it: 9 Oct. */
function chartDay(day: string): string {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const [, month, date] = day.split('-').map(Number);
  return `${date} ${months[month! - 1]}`;
}

test('staff read the platform’s messages a day on the Usage tab (ADR-333)', async ({
  page,
  request,
}) => {
  test.skip(!platformConfigured, 'needs DATABASE_URL_MIGRATE and E2E_DATABASE_URL_AUTH');
  test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');
  test.setTimeout(150_000);
  const email = uniqueEmail('daily');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `daily-${suffix}`;
  const companyName = `Daily Co ${suffix}`;
  await signUpAndVerify(page, { name: 'Dana Staff', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: companyName })).toBeVisible();
  await turnOnTwoFactor(page, PASSWORD);
  await makePlatformOwner(email);
  // A customer writes to the company's number, so the platform has a message today whatever ran
  // before this test.
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, randomWaId(), 'Is the shop open today?'),
  );

  const chart = page.getByRole('slider', {
    name: 'Messages sent and received each UTC day, 7 days',
  });
  const before = new Date();
  await page.goto('/platform/ops/usage?days=7');
  await expect(page.getByText('Messages a day', { exact: true })).toBeVisible();
  // The worker stores the message after the webhook is answered; the page shows what was there
  // when it rendered.
  await expect(async () => {
    await page.reload();
    await expect(chart).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByRole('list', { name: 'Lines' }).getByRole('listitem')).toHaveText([
    'Sent',
    'Received',
  ]);

  // The table gives every day: each UTC day from the window's start to today (the server's, read
  // between the two times).
  await page.getByText('Table of the days', { exact: true }).click();
  // The pointer off the charts: left on the summary, it would rest on a chart once focusing the
  // chart scrolls the page, and WebKit then moves that chart's day to the one under it.
  await page.mouse.move(0, 0);
  const table = page.getByRole('table', { name: 'Messages a day' });
  await expect(table.getByRole('columnheader')).toHaveText([
    'Day (UTC)',
    'Sent',
    'Cancelled',
    'Failed',
    'Received',
    'Share failed',
    'Delivered',
    'Read',
  ]);
  const rows = table.getByRole('row').filter({ has: page.getByRole('cell') });
  const days = (await rows.locator('td:first-child').allTextContents()).map((d) => d.trim());
  const after = new Date();
  expect(days.length).toBeGreaterThanOrEqual(8);
  for (let i = 1; i < days.length; i += 1) {
    const next = new Date(Date.parse(`${days[i - 1]}T00:00:00Z`) + 24 * 60 * 60 * 1000);
    expect(days[i], `after ${days[i - 1]}`).toBe(next.toISOString().slice(0, 10));
  }
  expect([before, after].map((d) => d.toISOString().slice(0, 10))).toContain(days.at(-1));

  // The chart is a slider over the days, its value the last day's numbers until another is chosen;
  // focused, it shows that day's tooltip, and the arrow keys, Home and End move along the days.
  const describes = (day: string) =>
    new RegExp(`^${chartDay(day)}: [\\d,]+ sent, [\\d,]+ received, [\\d,]+ failed$`);
  const tooltip = (day: string) => chart.getByText(`${chartDay(day)} (UTC)`, { exact: true });
  await expect(chart).toHaveAttribute('aria-valuetext', describes(days.at(-1)!));
  await expect(tooltip(days.at(-1)!)).toHaveCount(0);
  await chart.focus();
  await expect(tooltip(days.at(-1)!)).toBeVisible();
  await page.keyboard.press('Home');
  await expect(chart).toHaveAttribute('aria-valuenow', '0');
  await expect(chart).toHaveAttribute('aria-valuetext', describes(days[0]!));
  await expect(tooltip(days[0]!)).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(chart).toHaveAttribute('aria-valuetext', describes(days[1]!));
  await page.keyboard.press('End');
  await expect(chart).toHaveAttribute('aria-valuenow', String(days.length - 1));
  await expect(chart).toHaveAttribute('aria-valuetext', describes(days.at(-1)!));
  // The tooltip stays inside the page, on a phone as on a desktop; Escape puts it away.
  await expect(tooltip(days.at(-1)!)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.keyboard.press('Escape');
  await expect(tooltip(days.at(-1)!)).toHaveCount(0);

  // Under it, the share of each day's sends that failed (ADR-344), of those not cancelled before they
  // left (ADR-346): drawn when a company sent a message in the window that was not cancelled, as
  // the table's Sent and Cancelled columns say (earlier tests may or may not have), else a note;
  // its value names the last day's share of those sent, or none sent.
  const sent = (await rows.locator('td:nth-child(2)').allTextContents()).map((n) => Number(n));
  const cancelled = (await rows.locator('td:nth-child(3)').allTextContents()).map((n) => Number(n));
  const shared = sent.map((n, i) => n - (cancelled[i] ?? 0));
  // Every send cancelled: neither chart, and a note saying so in place of each.
  const allCancelled = page.getByText(
    'Every send of these days was cancelled before it left: none has a share.',
    { exact: true },
  );
  const failedChart = page.getByRole('slider', {
    name: 'Share of the messages sent that failed each UTC day, 7 days',
  });
  const noneSent = page.getByText('No company sent a message in these days, so none failed.', {
    exact: true,
  });
  // The pointer off the charts first: left on the table's summary, it rests on this chart once
  // focusing the chart above has scrolled the page, and WebKit then names the day under it.
  await page.mouse.move(0, 0);
  if (shared.some((n) => n > 0)) {
    await expect(noneSent).toHaveCount(0);
    await expect(failedChart).toHaveAttribute(
      'aria-valuetext',
      sent.at(-1) === 0
        ? `${chartDay(days.at(-1)!)}: none sent`
        : shared.at(-1) === 0
          ? new RegExp(`^${chartDay(days.at(-1)!)}: all [\\d,]+ sent were cancelled$`)
          : new RegExp(
              `^${chartDay(days.at(-1)!)}: [<>]?[\\d.]+% of [\\d,]+ sends not cancelled failed \\([\\d,]+\\)$`,
            ),
    );
  } else {
    await expect(sent.some((n) => n > 0) ? allCancelled.first() : noneSent).toBeVisible();
    await expect(failedChart).toHaveCount(0);
  }
  // And the shares delivered and read (ADR-346), the live days' always counted: its value names the
  // last day's shares of those sent and not cancelled, or none sent.
  const deliveryChart = page.getByRole('slider', {
    name: 'Share of the messages sent that were delivered and read each UTC day, 7 days',
  });
  const noneDelivered = page.getByText(
    'No company sent a message in these days, so none was delivered.',
    { exact: true },
  );
  if (shared.some((n) => n > 0)) {
    await expect(noneDelivered).toHaveCount(0);
    await expect(
      page.getByRole('list', { name: 'Delivered and read, legend' }).getByRole('listitem'),
    ).toHaveText(['Delivered', 'Read']);
    await expect(deliveryChart).toHaveAttribute(
      'aria-valuetext',
      sent.at(-1) === 0
        ? `${chartDay(days.at(-1)!)}: none sent`
        : shared.at(-1) === 0
          ? new RegExp(`^${chartDay(days.at(-1)!)}: all [\\d,]+ sent were cancelled$`)
          : new RegExp(
              `^${chartDay(days.at(-1)!)}: [<>]?[\\d.]+% of [\\d,]+ sends not cancelled delivered \\([\\d,]+\\), [<>]?[\\d.]+% read \\([\\d,]+\\)$`,
            ),
    );
  } else {
    await expect(sent.some((n) => n > 0) ? allCancelled.first() : noneDelivered).toBeVisible();
    await expect(deliveryChart).toHaveCount(0);
  }

  // The window's failed sends by reason (ADR-347): a table whose sends add up to the days' failed
  // ones, read in the same snapshot, or a note when none failed.
  const failedByDay = (await rows.locator('td:nth-child(4)').allTextContents()).map((n) =>
    Number(n),
  );
  const reasons = page.getByRole('table', { name: 'Failed sends by reason, 7 days' });
  if (failedByDay.some((n) => n > 0)) {
    await expect(reasons.getByRole('columnheader')).toHaveText([
      'Reason',
      'Code',
      'Failed',
      'Share of the failed',
    ]);
    const failedByReason = (await reasons.locator('tbody td:nth-child(3)').allTextContents()).map(
      (n) => Number(n.replaceAll(',', '')),
    );
    expect(failedByReason.length).toBeLessThanOrEqual(9);
    expect(failedByReason.reduce((total, n) => total + n, 0)).toBe(
      failedByDay.reduce((total, n) => total + n, 0),
    );
  } else {
    await expect(
      page.getByText("No company's send failed in these days.", { exact: true }),
    ).toBeVisible();
    await expect(reasons).toHaveCount(0);
  }

  // On a phone narrower than this project's, the chart and the open table stay inside the page:
  // the table scrolls in its own box rather than widening the card.
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 360, height: viewport?.height ?? 800 });
  for (const part of [chart, page.locator('details').filter({ has: table })]) {
    const box = await part.boundingBox();
    expect(box, 'shown').not.toBeNull();
    expect(box!.x + box!.width, 'inside the page').toBeLessThanOrEqual(360);
  }
  if (viewport) await page.setViewportSize(viewport);

  // The other windows draw their own days.
  await page.getByRole('link', { name: '30 days' }).click();
  await expect(
    page.getByRole('slider', { name: 'Messages sent and received each UTC day, 30 days' }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // The last 12 months (ADR-341), from the days the worker counts once they end: drawn, or none
  // counted yet, or none of those counted with a message.
  await expect(page.getByText('The last 12 months', { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole('slider', { name: 'Messages sent and received each UTC day, the last 12 months' })
      .or(page.getByText('No day is counted yet', { exact: true }))
      .or(
        page.getByText('No company sent or received a message in the days counted.', {
          exact: true,
        }),
      ),
  ).toBeVisible();

  // The company's own days on its platform page (ADR-334): the customer's one message, and none of
  // the other companies'.
  await page.goto(`/platform?q=${slug}`);
  await page.getByRole('link', { name: companyName }).click();
  await expect(page.getByRole('heading', { name: 'Health' })).toBeVisible();
  const companyChart = page.getByRole('slider', {
    name: "This company's messages sent and received each UTC day, 30 days",
  });
  await expect(async () => {
    await page.reload();
    await expect(companyChart).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByText('Table of the days', { exact: true }).click();
  const companyDays = page.getByRole('table', { name: 'Messages a day' });
  await expect(companyDays).toBeVisible();
  const received = await companyDays.locator('tbody td:nth-child(5)').allTextContents();
  expect(received.length).toBeGreaterThanOrEqual(31);
  expect(received.reduce((total, n) => total + Number(n), 0)).toBe(1);
  // It sent nothing, so no share failed (ADR-344): the note in place of the chart, and the table's
  // last column says so for every day.
  await expect(
    page.getByText('The company sent no message in these 30 days, so none failed.', {
      exact: true,
    }),
  ).toBeVisible();
  const shares = await companyDays.locator('tbody td:nth-child(6)').allTextContents();
  expect(new Set(shares.map((share) => share.trim()))).toEqual(new Set(['None sent']));
  // Nor any cancelled, delivered or read (ADR-346): the note in place of their chart, none
  // cancelled, and the delivered and read columns saying none was sent, as the failed share does.
  await expect(
    page.getByText('The company sent no message in these 30 days, so none was delivered.', {
      exact: true,
    }),
  ).toBeVisible();
  const cancelledCounts = await companyDays.locator('tbody td:nth-child(3)').allTextContents();
  expect(new Set(cancelledCounts.map((count) => count.trim()))).toEqual(new Set(['0']));
  for (const column of [7, 8]) {
    const counts = await companyDays.locator(`tbody td:nth-child(${column})`).allTextContents();
    expect(new Set(counts.map((count) => count.trim()))).toEqual(new Set(['None sent']));
  }
  // Nor any by reason (ADR-347): the note in place of the table.
  await expect(
    page.getByText("None of the company's sends failed in these 30 days.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('table', { name: "This company's failed sends by reason, 30 days" }),
  ).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  // Its last 12 months (ADR-342), from the days the worker counts once they end: drawn, or none
  // counted yet, or none of those counted with a message.
  await expect(page.getByRole('heading', { name: 'The last 12 months' })).toBeVisible();
  await expect(
    page
      .getByRole('slider', {
        name: "This company's messages sent and received each UTC day, the last 12 months",
      })
      .or(page.getByText('No day is counted yet', { exact: true }))
      .or(
        page.getByText('The company sent and received no message in the days counted.', {
          exact: true,
        }),
      ),
  ).toBeVisible();
  // As on the Usage tab, the chart and the open table stay inside a page 360 pixels wide.
  const shown = page.viewportSize();
  await page.setViewportSize({ width: 360, height: shown?.height ?? 800 });
  for (const part of [companyChart, page.locator('details').filter({ has: companyDays })]) {
    const box = await part.boundingBox();
    expect(box, 'shown').not.toBeNull();
    expect(box!.x + box!.width, 'inside the page').toBeLessThanOrEqual(360);
  }
  if (shown) await page.setViewportSize(shown);
});

/**
 * Records a send that failed with a code, as the sender leaves one it refused (runtime role, the
 * company's scope), on the conversation a customer's first message opened; none until the worker has
 * stored that message.
 */
async function failSend(tenantId: string, phoneNumberId: string, code: string, title: string) {
  const app = new pg.Client({ connectionString: process.env.DATABASE_URL_APP });
  await app.connect();
  try {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const failed = await app.query(
      // 35: the failed rank (STATUS_RANK in packages/domain messaging/status.ts).
      `INSERT INTO app.messages (id, tenant_id, conversation_id, channel_account_id, direction,
         type, status, status_rank, sender_type, error_code, error_title)
       SELECT $1, c.tenant_id, c.id, c.channel_account_id, 'outbound', 'text', 'failed', 35,
              'agent', $2, $3
         FROM app.conversations c
         JOIN app.channel_accounts a
           ON a.tenant_id = c.tenant_id AND a.id = c.channel_account_id AND a.phone_number_id = $4
        WHERE c.tenant_id = $5
        LIMIT 1`,
      [randomUUID(), code, title, phoneNumberId, tenantId],
    );
    expect(failed.rowCount).toBe(1);
    await app.query('COMMIT');
  } finally {
    await app.end();
  }
}

test('staff read the failed sends by reason on the Usage tab and a company’s page (ADR-347)', async ({
  page,
  request,
}) => {
  test.skip(!platformConfigured, 'needs DATABASE_URL_MIGRATE and E2E_DATABASE_URL_AUTH');
  test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');
  test.setTimeout(150_000);
  const email = uniqueEmail('reasons');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const slug = `reasons-${suffix}`;
  const companyName = `Reasons Co ${suffix}`;
  await signUpAndVerify(page, { name: 'Rhea Staff', email, password: PASSWORD });
  await page.getByLabel('Company name').fill(companyName);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: companyName })).toBeVisible();
  await turnOnTwoFactor(page, PASSWORD);
  await makePlatformOwner(email);
  // A customer writes; a reply is then recorded as the sender records one it refused once the
  // window had closed.
  const { tenantId, wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, randomWaId(), 'Is my order on its way?'),
  );
  await expect(async () => {
    await failSend(
      tenantId,
      phoneNumberId,
      'window_closed',
      'The 24-hour customer service window closed before the message could be sent.',
    );
  }).toPass({ timeout: 30_000 });

  // The company's page lists its one failed send: the code's meaning, the code, 1 and all of them.
  await page.goto(`/platform?q=${slug}`);
  await page.getByRole('link', { name: companyName }).click();
  const reasons = page.getByRole('table', {
    name: "This company's failed sends by reason, 30 days",
  });
  await expect(reasons).toBeVisible();
  await expect(reasons.getByRole('columnheader')).toHaveText([
    'Reason',
    'Code',
    'Failed',
    'Share of the failed',
  ]);
  await expect(reasons.locator('tbody tr')).toHaveCount(1);
  await expect(reasons.locator('tbody td')).toHaveText([
    'The 24-hour customer service window closed before the message could be sent.',
    'window_closed',
    '1',
    '100%',
  ]);
  // Its year's failed sends by reason (ADR-350), from the counts the worker keeps once each day
  // has ended: today's failure is not among them, unless the day ended since.
  await expect(
    page
      .getByRole('table', { name: "This company's failed sends by reason, the last 12 months" })
      .or(
        page.getByText("None of the company's sends failed in the days counted.", { exact: true }),
      )
      .or(page.getByText(/^None counted yet: the worker counts/)),
  ).toBeVisible();
  // On a phone narrower than this project's, the table scrolls in its own box, not the page.
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 360, height: viewport?.height ?? 800 });
  await expect(reasons).toBeVisible();
  await expectNoHorizontalOverflow(page);
  if (viewport) await page.setViewportSize(viewport);

  // The Usage tab lists the code among every company's failed sends.
  await page.goto('/platform/ops/usage?days=7');
  const platformReasons = page.getByRole('table', { name: 'Failed sends by reason, 7 days' });
  await expect(platformReasons).toBeVisible();
  await expect(
    platformReasons.getByRole('cell', { name: 'window_closed', exact: true }),
  ).toHaveCount(1);
  // And the year's (ADR-350): a table of the days counted, none failed in them, or none counted.
  await expect(
    page
      .getByRole('table', { name: 'Failed sends by reason, the last 12 months' })
      .or(page.getByText("No company's send failed in the days counted.", { exact: true }))
      .or(page.getByText('None counted yet', { exact: true })),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

/**
 * Removes the chat channel a failed run of the test below left, failing the posts still waiting as
 * removing it on the page does, so that none goes to the next channel set (owner role: a fixture
 * step).
 */
async function removeChatChannel(host: string) {
  const owner = new pg.Client({ connectionString: process.env.DATABASE_URL_MIGRATE });
  await owner.connect();
  try {
    await owner.query(
      `WITH gone AS (DELETE FROM ops.platform_alert_channel WHERE host = $1 RETURNING 1)
       UPDATE ops.platform_alert_posts
          SET failed_at = now(), last_status = NULL, last_error = 'no_channel', lease_until = NULL
        WHERE sent_at IS NULL AND failed_at IS NULL AND EXISTS (SELECT 1 FROM gone)`,
      [host],
    );
  } finally {
    await owner.end();
  }
}

test('an owner posts the operations alerts to a chat channel and sends it a test post (ADR-338)', async ({
  page,
}) => {
  // A host name that resolves to 127.0.0.1 on the test machine (CI adds it to /etc/hosts); the web
  // and worker must allow loopback egress, which only APP_ENV=local|test permits.
  const host = (process.env.E2E_HTTP_HOST ?? '').toLowerCase();
  test.skip(!platformConfigured, 'needs DATABASE_URL_MIGRATE and E2E_DATABASE_URL_AUTH');
  test.skip(
    !host || process.env.W360_EGRESS_ALLOW_LOOPBACK !== 'true',
    'Chat receiver not provided (E2E_HTTP_HOST resolving to 127.0.0.1, W360_EGRESS_ALLOW_LOOPBACK)',
  );
  test.setTimeout(120_000);
  const received: { path: string; type: string; body: string }[] = [];
  const receiver = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      received.push({ path: req.url ?? '', type: req.headers['content-type'] ?? '', body });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  let passed = false;
  try {
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    // The address's secret part, which no page may show.
    const token = `hook${Math.random().toString(36).slice(2, 12)}`;
    const path = `/services/e2e/${token}`;
    const email = uniqueEmail('alerts');
    const companyName = `Alerts Co ${suffix}`;
    await signUpAndVerify(page, { name: 'Alma Staff', email, password: PASSWORD });
    await page.getByLabel('Company name').fill(companyName);
    await page.getByLabel('Company address').fill(`alerts-${suffix}`);
    await page.getByRole('button', { name: 'Create company' }).click();
    await expect(page.getByRole('heading', { name: companyName })).toBeVisible();
    await turnOnTwoFactor(page, PASSWORD);
    await makePlatformOwner(email);

    await page.goto('/platform/ops/alerts');
    await expect(page.getByRole('link', { name: 'Alerts', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // Another test's channel may be left behind if it failed: start from none.
    const remove = page.getByRole('button', { name: 'Remove the channel' });
    if (await remove.isVisible()) {
      await remove.click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    }
    await expect(page.getByText('No chat channel is set', { exact: true })).toBeVisible();

    const port = (receiver.address() as AddressInfo).port;
    await page
      .getByLabel('The channel’s incoming webhook address')
      .fill(`http://${host}:${port}${path}`);
    await page.getByRole('button', { name: 'Set the channel' }).click();
    await expect(page.getByText(`Alerts are posted to ${host} from now on.`)).toBeVisible();
    // The page names the host, never the address, which holds the channel's secret.
    await expect(page.getByText(host, { exact: true })).toBeVisible();
    await expect(page.getByText(token)).toHaveCount(0);
    await expect(page.getByLabel('Replace the channel’s address')).toHaveValue('');

    // A new channel gets the operations alerts, not the owners' (refund requests among them,
    // ADR-345); an owner adds a financial one (ADR-340).
    const kinds = page.getByRole('group', { name: 'Alerts posted' });
    await expect(kinds.getByLabel('Failures')).toBeChecked();
    await expect(kinds.getByLabel('Refund requests (platform owners’ alert)')).not.toBeChecked();
    await expect(kinds.getByLabel('Reconciliation findings')).not.toBeChecked();
    await kinds.getByLabel('Reconciliation findings').check();
    await page.getByRole('button', { name: 'Save the alerts posted' }).click();
    await expect(
      page.getByText(
        'Saved: the alerts ticked are posted from now on, and posts waiting of the others are not sent.',
      ),
    ).toBeVisible();
    await expect(
      page.getByText('Failures, Late queues, Failing integrations, Reconciliation findings', {
        exact: true,
      }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Send a test post' }).click();
    await expect(page.getByText(/^Test post queued/)).toBeVisible();
    // The alerts other tests cause while the channel is set are posted too: only the test post is
    // counted.
    const tests = () =>
      received.filter(
        (r) =>
          r.path === path &&
          (JSON.parse(r.body) as { text: string }).text.startsWith(
            'HyFib W360: a test post from the operations console\n',
          ),
      );
    await expect.poll(() => tests().length, { timeout: 30_000 }).toBe(1);
    expect(tests()[0]!.type).toBe('application/json');
    // Posts are kept 7 days and listed newest first: run together, as locally, the projects share
    // one database, and earlier projects' test posts are below this one (CI gives each project its
    // own, ADR-343).
    const testRow = page
      .getByRole('table', { name: 'Latest posts' })
      .getByRole('row')
      .filter({ hasText: 'Test post' })
      .first();
    await expect(async () => {
      await page.reload();
      await expect(testRow).toContainText('Sent', { timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await expect(testRow).toContainText('HTTP 200');
    await expectNoHorizontalOverflow(page);

    await page.getByRole('button', { name: 'Remove the channel' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Chat channel removed: alerts are emailed only.')).toBeVisible();
    await expect(page.getByText('No chat channel is set', { exact: true })).toBeVisible();
    passed = true;
  } finally {
    receiver.closeAllConnections();
    receiver.close();
    // A failed run leaves no channel behind for the specs after it. Its own failure is the one
    // reported: a failure here is then logged with it.
    await removeChatChannel(host).catch((error: unknown) => {
      if (passed) throw error;
      console.error('The chat channel could not be removed after the failure:', error);
    });
  }
});
