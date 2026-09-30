import { expect, test } from './fixtures';
import {
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
  await sections.getByRole('link', { name: 'Usage' }).click();
  const usage = page.getByRole('table', { name: 'Usage by company' });
  await expect(usage.getByRole('row').filter({ hasText: companyName })).toBeVisible();
  await page.getByRole('link', { name: '7 days' }).click();
  await expect(page.getByText('By company (7 days)')).toBeVisible();
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
