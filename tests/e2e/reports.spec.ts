import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  connectTestChannel,
  inboundMessage,
  messagingConfigured,
  randomWaId,
  sendSignedWebhook,
} from './messaging-support';
import { expectNoHorizontalOverflow, signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');

/** The value box of a report statistic, found by its label. */
function stat(page: Page, label: string) {
  return page
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('..');
}

test('reports show response times against the target, member activity and a CSV export', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail('reports');
  const slug = `rep-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Rita Reports', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Report Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // A 30-minute first-response target.
  await page.goto(`/c/${slug}/settings/messaging`);
  await page.getByLabel('Set a first-response target').check();
  await page.getByLabel('Target (minutes)').fill('30');
  await page.getByRole('button', { name: 'Save response target' }).click();
  await expect(page.getByText('Response target saved.')).toBeVisible();

  // Two customers write; the owner answers one of them.
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, randomWaId(), 'Do you deliver to Pune?'),
  );
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, randomWaId(), 'What are your opening hours?'),
  );
  await page.goto(`/c/${slug}/inbox`);
  await expect(page.getByRole('link', { name: /Priya Customer/ })).toHaveCount(2, {
    timeout: 30_000,
  });
  await page
    .getByRole('link', { name: /Priya Customer/ })
    .first()
    .click();
  await page.getByLabel('Reply').fill('Yes, we do.');
  await page.getByRole('button', { name: 'Send' }).click();
  const thread = page.getByRole('list', { name: /^Messages with/ });
  await expect(thread.getByText('Yes, we do.')).toBeVisible();
  // Leave only once the reply was handed to WhatsApp and the thread refreshed, so no refresh of
  // this page is still in flight when the next one is opened.
  await expect(thread.getByText('Sent to WhatsApp')).toBeVisible({ timeout: 20_000 });

  // Reports is in the navigation now that the module is available.
  await expect(page.getByRole('link', { name: 'Reports' }).first()).toBeAttached();
  await page.goto(`/c/${slug}/reports`);
  await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();
  await expect(stat(page, 'Customer messages')).toContainText('2');
  await expect(stat(page, 'Waiting for a reply')).toContainText('1');
  await expect(stat(page, 'Turns')).toContainText('1 answered');
  await expect(stat(page, 'Answered within target')).toContainText('100%');
  await expect(stat(page, 'Answered within target')).toContainText('1 of 1 within 30 min');
  await expect(page.getByRole('row', { name: /Rita Reports/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Not available yet' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(page.getByText('No billing currency chosen').first()).toBeVisible();

  // Owners can export each section; the file is formula-safe CSV.
  const href = await page
    .getByRole('link', { name: 'Export CSV (Messaging outcomes)' })
    .getAttribute('href');
  expect(href).toMatch(new RegExp(`^/c/${slug}/reports/export/messaging\\?preset=custom&from=`));
  const csv = await page.request.get(href!);
  expect(csv.status()).toBe(200);
  expect(csv.headers()['content-disposition']).toMatch(/attachment; filename="messaging-/);
  expect(await csv.text()).toMatch(/^\uFEFFday,time_zone,customer_messages,messages_sent/);

  // A period longer than 92 days falls back to the last 7 days with an explanation.
  await page.goto(`/c/${slug}/reports?preset=custom&from=2025-01-01&to=2025-12-31`);
  await expect(page.getByText('Showing the last 7 days instead')).toBeVisible();
  await expect(page.getByText(/at most 92 days/)).toBeVisible();
});
