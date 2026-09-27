import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  connectTestChannel,
  inboundMessage,
  messagingConfigured,
  randomWaId,
  sendSignedWebhook,
  standInRequests,
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

test('an automation is built, simulated, published, runs on WhatsApp and hands over to people', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('bot');
  const slug = `bot-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Bina Bot', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Bot Bazaar');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // Create a draft from the navigation.
  await page.getByRole('link', { name: 'Automations' }).first().click();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Menu bot');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Menu bot' })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Trigger: a keyword. Steps: a greeting, a question with buttons, a hand-off.
  await page.getByLabel('Start when').selectOption('keyword');
  await page.getByLabel('Keywords').fill('menu');
  await page.locator('#step-welcome-text').fill('Hi {{name}}, welcome!');
  await page.getByLabel('Add a step').selectOption('ask_buttons');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.locator('#step-ask-buttons-1-body').fill('Do you want to talk to our team?');
  await page.getByLabel('Add a step').selectOption('handoff');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.locator('#step-welcome-next').selectOption('ask-buttons-1');
  await page.locator('#step-ask-buttons-1-button-0-next').selectOption('handoff-1');
  await expect(page.getByText(/to fix before publishing/)).toBeHidden();
  const diagram = page.getByRole('img', { name: /Diagram of 3 steps/ });
  await expect(diagram).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Try it in the simulator before saving: nothing is sent.
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByText('Hi Asha, welcome!')).toBeVisible();
  await expect(page.getByText('Do you want to talk to our team?').last()).toBeVisible();
  await page.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(page.getByText('Handed to people (routed like a new conversation).')).toBeVisible();

  // Save, then publish version 1 with a note.
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel('What changed (optional)').fill('First version');
  await dialog.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published.')).toBeVisible();
  await expect(page.getByText(/Version 1 is live/)).toBeVisible();
  await expect(page.getByText('First version')).toBeVisible();

  // A customer says "menu": the worker runs the automation and sends through WhatsApp.
  const customer = randomWaId();
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, customer, 'menu please'));
  await expect
    .poll(
      async () =>
        (await standInRequests(request)).filter(
          (r) =>
            (r.body as { to?: string; type?: string })?.to === customer &&
            (r.body as { type?: string }).type === 'interactive',
        ).length,
      { timeout: 30_000 },
    )
    .toBe(1);
  await page.goto(`/c/${slug}/inbox`);
  const item = page.getByRole('link', { name: /Priya Customer/ });
  await expect(item).toContainText('Automation');
  await item.click();
  const thread = page.getByRole('list', { name: /^Messages with/ });
  await expect(thread.getByText('Hi Priya Customer, welcome!')).toBeVisible();
  await expect(thread.getByText('Do you want to talk to our team?')).toBeVisible();
  const banner = page.getByText(/is handling this conversation/);
  // The banner says "sending" until Meta has accepted the question, then shows the wait.
  await expect
    .poll(
      async () => {
        await page.reload();
        return banner.textContent();
      },
      { timeout: 30_000 },
    )
    .toContain('waiting for the customer’s reply');

  // The customer types the button's title: the automation hands the conversation to people.
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, customer, 'Yes'));
  await expect
    .poll(
      async () => {
        await page.reload();
        return banner.count();
      },
      { timeout: 30_000 },
    )
    .toBe(0);

  // The run log shows each step.
  await page.goto(`/c/${slug}/automations/runs`);
  await expect(page.getByText('Handed off').first()).toBeVisible();
  await page.getByRole('table').getByRole('link').first().click();
  await expect(page.getByRole('heading', { name: 'Run of Menu bot' })).toBeVisible();
  const steps = page.getByRole('table');
  await expect(steps).toContainText('Asked the customer');
  await expect(steps).toContainText('Got an answer → Yes');
  await expect(steps).toContainText('Handed off');
  // The owner can see the conversation, so captured answers are shown (this flow saved none).
  await expect(page.getByRole('heading', { name: 'Saved answers' })).toBeVisible();
  await expect(page.getByText('None.')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Another customer; a member takes the conversation over from the automation.
  const second = randomWaId();
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, second, 'Show the MENU'));
  await page.goto(`/c/${slug}/inbox`);
  const secondItem = page.getByRole('link', { name: /Priya Customer/ }).first();
  await expect
    .poll(
      async () => {
        await page.reload();
        return page.getByText('Automation', { exact: true }).count();
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  await secondItem.click();
  await expect(page.getByText(/is handling this conversation/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Take over' }).click();
  await expect(page.getByText(/is handling this conversation/)).toBeHidden({ timeout: 20_000 });
  await page.goto(`/c/${slug}/inbox`);
  await expect(page.getByText(/Assigned to Bina Bot/).first()).toBeVisible();

  // Reports count both runs.
  await page.goto(`/c/${slug}/reports`);
  await expect(stat(page, 'Automation runs')).toContainText('2');
  await expect(stat(page, 'Handed off')).toContainText('1 run');
  await expect(stat(page, 'Taken over')).toContainText('1 run');
  await expectNoHorizontalOverflow(page);

  // Pausing stops new runs.
  await page.goto(`/c/${slug}/automations`);
  await page.getByRole('link', { name: 'Menu bot' }).click();
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText(/Paused: no new runs start/)).toBeVisible();
});
