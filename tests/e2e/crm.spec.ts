import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  connectTestChannel,
  inboundMessage,
  messagingConfigured,
  randomWaId,
  sendSignedWebhook,
} from './messaging-support';
import { expectNoHorizontalOverflow, signUpAndVerify, uniqueEmail, waitForEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

/** Companies created in these tests keep the onboarding default time zone (UTC+05:30, no DST). */
const KOLKATA_OFFSET_MS = 5.5 * 3_600_000;

/** A form's datetime-local value: the wall-clock time in Asia/Kolkata at `ms`. */
function kolkataLocal(ms: number): string {
  return new Date(ms + KOLKATA_OFFSET_MS).toISOString().slice(0, 16);
}

/** The value box of a report statistic, found by its label. */
function stat(page: Page, label: string) {
  return page
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('..');
}

async function createCompany(page: Page, prefix: string, name: string) {
  const email = uniqueEmail(prefix);
  const slug = `${prefix}-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name, email, password: PASSWORD });
  await page.getByLabel('Company name').fill(`${name} Traders`);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  return { email, slug };
}

/** Settings → Pipelines: a rupee pipeline with the suggested four stages. */
async function createPipeline(page: Page, slug: string) {
  await page.goto(`/c/${slug}/settings/pipelines`);
  await expect(page.getByText('No pipelines yet.')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Sales');
  await expect(page.getByLabel('Currency')).toHaveValue('INR');
  await page.getByRole('button', { name: 'Create pipeline' }).click();
  await expect(page.getByText('Pipeline created.')).toBeVisible();
  await expect(page.getByText('2. Qualified')).toBeVisible();
}

test('a deal moves through a pipeline with tasks, an emailed reminder, notes and reports', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email, slug } = await createCompany(page, 'crm', 'Chandra');

  // Before a pipeline exists, the board points owners to Settings → Pipelines.
  await page.getByRole('link', { name: 'CRM' }).first().click();
  await expect(page.getByRole('heading', { name: 'No pipeline yet' })).toBeVisible();
  await createPipeline(page, slug);
  await expectNoHorizontalOverflow(page);

  // A contact, and a deal added from the contact's page.
  await page.goto(`/c/${slug}/contacts/new`);
  await page.getByLabel('Name').fill('Asha Rao');
  await page.getByLabel('Phone number').fill('+91 98765 43210');
  await page.getByRole('button', { name: 'Add contact' }).click();
  await expect(page.getByRole('heading', { name: 'Asha Rao', level: 1 })).toBeVisible();
  await page.getByText('New deal', { exact: true }).click();
  await page.getByLabel('Deal title').fill('Annual plan');
  await page.getByLabel('Value (INR)').fill('25,000.50');
  await page.getByRole('button', { name: 'Create deal' }).click();
  await expect(page.getByRole('heading', { name: 'Annual plan', level: 1 })).toBeVisible();
  await expect(page.getByText('Sales · ₹25,000.50')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Move it to the next stage: the timeline records the change.
  await page.getByLabel('Stage of Annual plan').selectOption({ label: 'Qualified' });
  const timeline = page.getByRole('list', { name: 'Timeline' });
  await expect(timeline.getByText('New → Qualified')).toBeVisible();

  // Edit the value: the form reloads with the saved deal and keeps saying so.
  await page.getByLabel('Value (INR)').fill('26000');
  await page.getByRole('button', { name: 'Save deal' }).click();
  await expect(page.getByText('Deal saved.')).toBeVisible();
  await expect(page.getByText('Sales · ₹26,000.00')).toBeVisible();
  await expect(page.getByLabel('Value (INR)')).toHaveValue('26000.00');
  await expect(timeline.getByText(/₹25,000.50 → ₹26,000.00/)).toBeVisible();
  await expect(page.getByText('Deal saved.')).toBeVisible();

  // A task with a reminder at the current minute (up to a minute back is accepted), so the
  // worker emails it straight away rather than after a wait.
  const now = Date.now();
  const minute = Math.floor(now / 60_000) * 60_000;
  const remindAt = now - minute > 40_000 ? minute + 60_000 : minute;
  await page.getByText('New task', { exact: true }).click();
  await page.getByLabel('Task', { exact: true }).fill('Send the proposal');
  await page.getByLabel('Due', { exact: true }).fill(kolkataLocal(now + 24 * 3_600_000));
  await page.getByLabel('Email a reminder at').fill(kolkataLocal(remindAt));
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByText('Task added.')).toBeVisible();
  await expect(timeline.getByText('Send the proposal')).toBeVisible();
  const reminder = await waitForEmail(email, 'Reminder: Send the proposal', 90_000);
  expect(reminder).toContain('A reminder about your task in Chandra Traders: Send the proposal');

  // The tasks page lists it with its reminder, and it is marked done there.
  await page.goto(`/c/${slug}/crm/tasks`);
  const task = page.getByRole('listitem').filter({ hasText: 'Send the proposal' });
  await expect(task).toContainText('Reminder emailed');
  await expect(task.getByRole('link', { name: 'Deal: Annual plan' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Mark “Send the proposal” done' }).click();
  await expect(page.getByText('No open tasks.')).toBeVisible();
  await page.getByRole('link', { name: 'Closed', exact: true }).click();
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: 'Send the proposal' })
      .getByText('Done', { exact: true }),
  ).toBeVisible();

  // Back on the deal: a note, then the deal is won.
  await page.getByRole('link', { name: 'Deal: Annual plan' }).click();
  await expect(page.getByRole('heading', { name: 'Annual plan', level: 1 })).toBeVisible();
  await expect(timeline.getByText('Task done')).toBeVisible();
  await page.getByLabel('Add a CRM note').fill('Signed after the demo call.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(timeline.getByText('Signed after the demo call.')).toBeVisible();
  await page.getByRole('button', { name: 'Mark won' }).click();
  await expect(page.getByText('Won', { exact: true }).first()).toBeVisible();
  await expect(timeline.getByText('Deal won')).toBeVisible();

  // The board has no open deals; the won view lists it.
  await page.goto(`/c/${slug}/crm`);
  await expect(page.getByRole('heading', { name: 'New', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Annual plan' })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await page.getByRole('link', { name: 'Won', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Annual plan' })).toBeVisible();

  // The contact's timeline shows the deal's history too.
  await page.getByRole('link', { name: 'Contacts' }).first().click();
  await page.getByRole('link', { name: 'Asha Rao' }).click();
  await expect(page.getByRole('list', { name: 'Timeline' }).getByText('Deal won')).toBeVisible();

  // Reports count the win in the pipeline's currency.
  await page.goto(`/c/${slug}/reports`);
  await expect(stat(page, 'Deals won')).toContainText('1');
  await expect(stat(page, 'Deals won')).toContainText('₹26,000.00');
  await expect(stat(page, 'Win rate')).toContainText('100%');
  await expectNoHorizontalOverflow(page);
});

test.describe('from the inbox', () => {
  test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');

  test('a deal is added next to a conversation and links back to it', async ({ page, request }) => {
    test.setTimeout(120_000);
    const { email, slug } = await createCompany(page, 'crmi', 'Isha');
    const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });
    await createPipeline(page, slug);

    await sendSignedWebhook(
      request,
      inboundMessage(wabaId, phoneNumberId, randomWaId(), 'Can I get a quote for 20 units?'),
    );
    await page.goto(`/c/${slug}/inbox`);
    await page.getByRole('link', { name: /Priya Customer/ }).click({ timeout: 30_000 });
    const thread = page.getByRole('list', { name: /^Messages with/ });
    await expect(thread.getByText('Can I get a quote for 20 units?')).toBeVisible();

    await page.getByText('New deal', { exact: true }).click();
    await page.getByLabel('Deal title').fill('20 units');
    await page.getByLabel('Value (INR)').fill('12000');
    await page.getByRole('button', { name: 'Create deal' }).click();
    await expect(page.getByRole('heading', { name: '20 units', level: 1 })).toBeVisible();
    await page.getByRole('link', { name: 'Open the conversation' }).click();
    await expect(thread.getByText('Can I get a quote for 20 units?')).toBeVisible();
    // The conversation's CRM card lists the deal (its timeline links it too).
    await expect(page.getByRole('link', { name: '20 units' }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
