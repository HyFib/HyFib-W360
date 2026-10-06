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
import { expectNoHorizontalOverflow, openFromNav, signUpAndVerify, uniqueEmail } from './support';

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
  // The banner says "sending" until Meta has accepted the question; the page's live updates then
  // show the wait. (No reloads here: reloading while a live refresh is in flight makes WebKit
  // cancel it, and Next.js answers with a navigation that interrupts the reload.)
  await expect(banner).toContainText('waiting for the customer’s reply', { timeout: 30_000 });

  // The customer types the button's title: the automation hands the conversation to people.
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, customer, 'Yes'));
  await expect(banner).toHaveCount(0, { timeout: 30_000 });

  // The run log shows each step.
  await openFromNav(page, 'Automations');
  await page.getByRole('link', { name: 'All runs' }).click();
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
  // The list updates live when the worker starts the run.
  await expect(secondItem).toContainText('Automation', { timeout: 30_000 });
  await secondItem.click();
  await expect(page.getByText(/is handling this conversation/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Take over' }).click();
  await expect(page.getByText(/is handling this conversation/)).toBeHidden({ timeout: 20_000 });
  await openFromNav(page, 'Inbox');
  await expect(page).toHaveURL(new RegExp(`/c/${slug}/inbox$`));
  await expect(page.getByText(/Assigned to Bina Bot/).first()).toBeVisible();

  // Reports count both runs.
  await openFromNav(page, 'Reports');
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

test('an automation tags the conversation it answers, and the inbox shows the tag (ADR-222)', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('bottags');
  const slug = `bottags-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Tia Triage', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Triage Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  await page.getByRole('link', { name: 'Automations' }).first().click();
  await page.getByLabel('Name', { exact: true }).fill('Refund triage');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Refund triage' })).toBeVisible();

  // A greeting, then a step that tags the conversation.
  await page.getByLabel('Start when').selectOption('keyword');
  await page.getByLabel('Keywords').fill('refund');
  await page.locator('#step-welcome-text').fill('We are looking into your refund.');
  await page.getByLabel('Add a step').selectOption('update_conversation');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.locator('#step-update-conversation-1-tag').fill('Refund');
  await page.locator('#step-welcome-next').selectOption('update-conversation-1');
  await expect(page.getByText(/to fix before publishing/)).toBeHidden();

  // The simulator says what the step would do, and changes nothing.
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByText('Tag “refund” added to the conversation.')).toBeVisible();

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published.')).toBeVisible();

  // A customer asks about a refund: the run answers, then tags the conversation.
  const customer = randomWaId();
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, customer, 'refund please'),
  );
  await page.goto(`/c/${slug}/inbox`);
  const item = page.getByRole('link', { name: /Priya Customer/ });
  await expect(item).toContainText('refund', { timeout: 30_000 });
  await page.goto(`/c/${slug}/inbox?view=all&status=open&tag=refund`);
  await expect(item).toHaveCount(1);
});

test('an automation creates a CRM task and a deal about the customer (ADR-244, ADR-245)', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('bottask');
  const slug = `bottask-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Tomas Tasks', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Task Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // A Sales pipeline (INR) for the deal.
  await page.goto(`/c/${slug}/settings/pipelines`);
  await page.getByLabel('Name', { exact: true }).fill('Sales');
  await page.getByRole('button', { name: 'Create pipeline' }).click();
  await expect(page.getByText('Pipeline created.')).toBeVisible();

  await page.getByRole('link', { name: 'Automations' }).first().click();
  await page.getByLabel('Name', { exact: true }).fill('Callbacks');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Callbacks' })).toBeVisible();

  // A greeting, then a step that creates a callback task for the owner, due in 4 hours.
  await page.getByLabel('Start when').selectOption('keyword');
  await page.getByLabel('Keywords').fill('call me');
  await page.locator('#step-welcome-text').fill('We will call you back.');
  await page.getByLabel('Add a step').selectOption('create_task');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.locator('#step-create-task-1-title').fill('Call {{name}} back');
  await page.locator('#step-create-task-1-assignee').selectOption({ label: 'Tomas Tasks' });
  await page.locator('#step-create-task-1-due').fill('4');
  await page.locator('#step-welcome-next').selectOption('create-task-1');
  // Then a deal in the pipeline's first stage, worth ₹2,500.50, owned by the owner.
  await page.getByLabel('Add a step').selectOption('create_deal');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.locator('#step-create-deal-1-title').fill('Kettles for {{name}}');
  await expect(page.locator('#step-create-deal-1-stage')).toHaveValue(/.+/);
  await page.locator('#step-create-deal-1-value').fill('2,500.50');
  await page.locator('#step-create-deal-1-owner').selectOption({ label: 'Tomas Tasks' });
  await page.locator('#step-create-task-1-next').selectOption('create-deal-1');
  await expect(page.getByText(/to fix before publishing/)).toBeHidden();

  // The simulator says what the steps would do, and creates nothing.
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(
    page.getByText('CRM task “Call Asha back” created for Tomas Tasks, due in 4 hours.'),
  ).toBeVisible();
  await expect(
    page.getByText(
      'CRM deal “Kettles for Asha” created in Sales (New), worth ₹2,500.50, owned by Tomas Tasks, unless the contact already has an open deal there.',
    ),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published.')).toBeVisible();

  // A customer asks for a call: the run answers, then the owner has a task about the customer.
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, randomWaId(), 'please call me'),
  );
  const task = page.getByRole('listitem').filter({ hasText: 'Call Priya Customer back' });
  await expect(async () => {
    await page.goto(`/c/${slug}/crm/tasks`);
    await expect(task).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(task.getByRole('link', { name: /Priya Customer/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // The deal is on the board (the run's next step), and its page says an automation created it.
  const deal = page.getByRole('link', { name: 'Kettles for Priya Customer' });
  await expect(async () => {
    await page.goto(`/c/${slug}/crm`);
    await expect(deal).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await deal.click();
  await expect(
    page.getByRole('heading', { name: 'Kettles for Priya Customer', level: 1 }),
  ).toBeVisible();
  await expect(page.getByText('Sales · ₹2,500.50')).toBeVisible();
  await expect(page.getByText(/by an automation · owner Tomas Tasks/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
