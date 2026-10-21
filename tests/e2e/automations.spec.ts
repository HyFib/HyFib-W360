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
  // The run's reply and tag refresh the live inbox, so the list filtered by the tag is loaded by
  // its address again if a refresh interrupts the load (see openFromNav).
  await expect(async () => {
    await page.goto(`/c/${slug}/inbox?view=all&status=open&tag=refund`);
    await expect(item).toHaveCount(1, { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
});

test('an automation creates a CRM task and a deal about the customer, moves the deal, sets its fields and branches on them (ADR-244, ADR-245, ADR-250, ADR-386, ADR-393)', async ({
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
  // Custom deal fields the automation sets (ADR-386): a choice and a number.
  await page.getByLabel('New deal field').fill('Tier');
  await page.locator('#deal-field-type').selectOption('choice');
  await page.locator('#deal-field-options').fill('Gold\nSilver');
  await page.getByRole('button', { name: 'Add deal field' }).click();
  await expect(page.getByRole('cell', { name: 'tier', exact: true })).toBeVisible();
  await page.getByLabel('New deal field').fill('Seats');
  await page.locator('#deal-field-type').selectOption('number');
  await page.getByRole('button', { name: 'Add deal field' }).click();
  await expect(page.getByRole('cell', { name: 'seats', exact: true })).toBeVisible();

  // The pipelines page has Name fields of its own: the link navigates on the client.
  await page.getByRole('link', { name: 'Automations' }).first().click();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Callbacks');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Callbacks' })).toBeVisible();

  // A greeting, then a step that creates a callback task for the owner, due in 4 hours.
  await page.getByLabel('Start when').selectOption('keyword');
  await page.getByLabel('Keywords').fill('call me');
  await page.locator('#step-welcome-text').fill('We will call you back.');
  await page.getByLabel('Add a step').selectOption('create_task');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.locator('#step-create-task-1-task').fill('Call {{name}} back');
  await page.locator('#step-create-task-1-assignee').selectOption({ label: 'Tomas Tasks' });
  await page.locator('#step-create-task-1-due').fill('4');
  await page.locator('#step-create-task-1-remind').check();
  await page.locator('#step-welcome-next').selectOption('create-task-1');
  // Then a deal in the pipeline's first stage, worth ₹2,500.50, owned by the owner.
  await page.getByLabel('Add a step').selectOption('create_deal');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.locator('#step-create-deal-1-deal').fill('Kettles for {{name}}');
  await expect(page.locator('#step-create-deal-1-stage')).toHaveValue(/.+/);
  await page.locator('#step-create-deal-1-value').fill('2,500.50');
  await page.locator('#step-create-deal-1-owner').selectOption({ label: 'Tomas Tasks' });
  await page.locator('#step-create-deal-1-close').fill('30');
  await page.locator('#step-create-task-1-next').selectOption('create-deal-1');
  // Then the deal moves on to Qualified (ADR-250).
  await page.getByLabel('Add a step').selectOption('move_deal');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.locator('#step-move-deal-1-stage').selectOption({ label: 'Qualified' });
  await page.locator('#step-create-deal-1-next').selectOption('move-deal-1');
  // Then the deal's fields are set (ADR-386): the tier chosen from its options, a number typed.
  await page.getByLabel('Add a step').selectOption('update_deal_fields');
  await page.getByRole('button', { name: 'Add step' }).click();
  await expect(page.locator('#step-update-deal-fields-1-field-0')).toHaveValue('tier');
  await expect(page.locator('#step-update-deal-fields-1-value-0 option')).toHaveText([
    'Clear the value',
    'Gold',
    'Silver',
  ]);
  await page.locator('#step-update-deal-fields-1-value-0').selectOption('Gold');
  await page.getByRole('button', { name: 'Add a field' }).click();
  await expect(page.locator('#step-update-deal-fields-1-field-1')).toHaveValue('seats');
  // A number that is not one is named before publishing.
  await page.locator('#step-update-deal-fields-1-value-1').fill('three');
  await expect(page.getByText('Seats must be a number.').first()).toBeVisible();
  await page.locator('#step-update-deal-fields-1-value-1').fill('3');
  await page.locator('#step-move-deal-1-next').selectOption('update-deal-fields-1');
  // Then a condition on the deal's tier (ADR-393): a Gold deal gets a welcome task.
  await page.getByLabel('Add a step').selectOption('condition');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.locator('#step-condition-1-rule-0-kind').selectOption('deal_field');
  // Each control is named after its rule; the comparisons and values follow the field's type.
  await expect(page.getByLabel('Pipeline of rule 1')).toHaveValue(/.+/);
  await expect(page.getByLabel('Deal field of rule 1')).toHaveValue('tier');
  await expect(page.locator('#step-condition-1-rule-0-op option')).toHaveText([
    'is',
    'is not',
    'has a value',
    'is empty',
  ]);
  await expect(page.getByLabel('Value of rule 1')).toHaveValue('Gold');
  await page.getByLabel('Deal field of rule 1').selectOption('seats');
  await expect(page.locator('#step-condition-1-rule-0-op option')).toHaveText([
    'is',
    'is not',
    'is more than',
    'is less than',
    'has a value',
    'is empty',
  ]);
  await page.getByLabel('Comparison of rule 1').selectOption('greater_than');
  await page.getByLabel('Value of rule 1').fill('two');
  await expect(page.getByText('Seats must be a number.').first()).toBeVisible();
  await page.getByLabel('Deal field of rule 1').selectOption('tier');
  await page.getByLabel('Value of rule 1').selectOption('Gold');
  await page.locator('#step-update-deal-fields-1-next').selectOption('condition-1');
  await page.getByLabel('Add a step').selectOption('create_task');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.locator('#step-create-task-2-task').fill('Welcome Gold customer {{name}}');
  await page.locator('#step-condition-1-then').selectOption('create-task-2');
  await expect(page.getByText(/to fix before publishing/)).toBeHidden();
  // The rule's controls stay inside the page (the mobile project runs this on a phone).
  await expectNoHorizontalOverflow(page);

  // The simulator says what the steps would do, and creates nothing.
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(
    page.getByText(
      'CRM task “Call Asha back” created for Tomas Tasks, due in 4 hours, with a reminder email when due.',
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      'CRM deal “Kettles for Asha” created in Sales (New), worth ₹2,500.50, owned by Tomas Tasks, expected to close in 30 days, unless the contact already has an open deal there.',
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      'The contact’s open deal in Sales moved to Qualified, if the contact has exactly one there.',
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      'On the contact’s open deal in Sales, if the contact has exactly one there: Tier set to Gold, Seats set to 3.',
    ),
  ).toBeVisible();
  // The simulated deal now has Gold, so the condition goes to “yes”.
  await expect(
    page.getByText(
      'CRM task “Welcome Gold customer Asha” created for Tomas Tasks, due in 24 hours.',
    ),
  ).toBeVisible();
  // Without an open deal the rule does not hold, and the simulator says why.
  await page.getByLabel('Open deals in each pipeline').selectOption('none');
  await page.getByRole('button', { name: 'Start again' }).click();
  await expect(
    page.getByText('A deal field rule is not true: the contact has no open deal in the pipeline.'),
  ).toBeVisible();
  await expect(page.getByText(/Welcome Gold customer Asha/)).toBeHidden();

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
  // Its reminder is set for the due time (ADR-246).
  await expect(task).toContainText('Reminder set');
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
  await expect(
    page.getByText(/by an automation · owner Tomas Tasks · expected to close \d{4}-\d{2}-\d{2}/),
  ).toBeVisible();
  // The step after it moved the deal on, as the automation (a step of its own, so it may land
  // just after the deal appears).
  await expect(async () => {
    await page.reload();
    const moved = page
      .getByRole('list', { name: 'Timeline' })
      .getByRole('listitem')
      .filter({ hasText: 'New → Qualified' });
    await expect(moved).toContainText('by an automation', { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  // The step after that set the deal's fields, as the automation (ADR-386).
  await expect(async () => {
    await page.reload();
    const edited = page
      .getByRole('list', { name: 'Timeline' })
      .getByRole('listitem')
      .filter({ hasText: 'Deal edited' });
    await expect(edited).toContainText('custom fields', { timeout: 2_000 });
    await expect(edited).toContainText('by an automation');
  }).toPass({ timeout: 30_000 });
  await expect(page.getByLabel('Tier', { exact: true })).toHaveValue('Gold');
  await expect(page.getByLabel('Seats', { exact: true })).toHaveValue('3');
  await expectNoHorizontalOverflow(page);
  // The condition after that read the Gold tier, so the welcome task followed (ADR-393).
  const welcome = page
    .getByRole('listitem')
    .filter({ hasText: 'Welcome Gold customer Priya Customer' });
  await expect(async () => {
    await page.goto(`/c/${slug}/crm/tasks`);
    await expect(welcome).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
});

test('a member enrols the contacts the Contacts page’s filters match in an automation and sees each start (ADR-401)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('enrol');
  const slug = `enrol-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Esha Enrol', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Enrol Emporium');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  await connectTestChannel({ ownerEmail: email, slug });

  // Two contacts tagged "festival", and one who is not.
  for (const [name, phone, tag] of [
    ['Asha Rao', '+91 98111 40001', 'festival'],
    ['Bina Das', '+91 98111 40002', 'festival'],
    ['Chitra Iyer', '+91 98111 40003', 'other'],
  ] as const) {
    await page.goto(`/c/${slug}/contacts/new`);
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Phone number').fill(phone);
    await page.getByRole('button', { name: 'Add contact' }).click();
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    await page.getByLabel('Add tags').fill(tag);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Tags' })).toContainText(tag);
  }

  // An automation started by a member or through the API, from the company's number: it tags the
  // contact, so nothing needs the service window.
  await openFromNav(page, 'Automations');
  await page.getByLabel('Name', { exact: true }).fill('Festival follow-up');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Festival follow-up' })).toBeVisible();
  await page.getByLabel('Start when').selectOption('api');
  await page.getByLabel('Inputs').fill('offer');
  await page.getByLabel('WhatsApp number').selectOption({ index: 1 });
  await page.getByLabel('Add a step').selectOption('update_contact');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.locator('#step-update-contact-1-tag').fill('followed-up');
  await page.getByLabel('First step', { exact: true }).selectOption('update-contact-1');
  await page.getByRole('button', { name: 'Delete step welcome' }).click();
  await expect(page.getByText(/to fix before publishing/)).toBeHidden();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/Version 1 is live/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Enrol contacts or a segment' })).toBeVisible();

  // From the Contacts page, filtered by the tag: the count, the input once, then the enrolment.
  await page.goto(`/c/${slug}/contacts?tag=festival`);
  await page
    .getByRole('link', { name: 'Enrol the contacts these filters match in an automation' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Enrol contacts in an automation' }),
  ).toBeVisible();
  await page.getByLabel('Automation', { exact: true }).selectOption({ index: 1 });
  await expect(page.getByLabel('Whom', { exact: true })).toContainText(
    'Contacts matching tag “festival”',
  );
  await page.getByRole('button', { name: 'Count contacts' }).click();
  await expect(page.getByText('2 contacts', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByLabel('Input “offer”').fill('Diwali');
  await page.getByRole('button', { name: 'Enrol 2 contacts' }).click();

  // The enrolment's page: the worker starts both runs; the page updates itself.
  await expect(
    page.getByRole('heading', { name: 'Enrolment in Festival follow-up' }),
  ).toBeVisible();
  await expect(page.getByText('Completed', { exact: true })).toBeVisible({ timeout: 60_000 });
  const started = page
    .locator('dt')
    .filter({ hasText: /^Started$/ })
    .locator('..');
  await expect(started).toContainText('2');
  await expect(page.getByText('Every contact was handled.', { exact: false })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // The automation's page lists the enrolment and marks its runs.
  await page.getByRole('link', { name: 'Open the automation' }).click();
  await expect(page.getByText('2 of 2 started')).toBeVisible();
  await expect(page.getByText('Enrolment', { exact: false }).first()).toBeVisible();
  await page.goto(`/c/${slug}/automations/runs`);
  await page.getByRole('table').getByRole('link').first().click();
  await expect(page.getByText(/by an enrolment by Esha Enrol/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the enrolment' })).toBeVisible();
});
