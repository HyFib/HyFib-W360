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

/**
 * Settings → Pipelines: a rupee pipeline with the suggested four stages, optionally with a chance of
 * winning on the second (ADR-242).
 */
async function createPipeline(
  page: Page,
  slug: string,
  options: { qualifiedChance?: string } = {},
) {
  await page.goto(`/c/${slug}/settings/pipelines`);
  await expect(page.getByText('No pipelines yet.')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Sales');
  await expect(page.getByLabel('Currency')).toHaveValue('INR');
  if (options.qualifiedChance) {
    await page.getByLabel('Stage 2 chance of winning, in percent').fill(options.qualifiedChance);
  }
  await page.getByRole('button', { name: 'Create pipeline' }).click();
  await expect(page.getByText('Pipeline created.')).toBeVisible();
  await expect(page.getByText('2. Qualified')).toBeVisible();
}

test('deals are imported from a CSV file into a pipeline, rows with errors listed (ADR-374)', async ({
  page,
}) => {
  const { slug } = await createCompany(page, 'crmimport', 'Ishaan');
  await createPipeline(page, slug);
  await page.goto(`/c/${slug}/contacts/new`);
  await page.getByLabel('Name').fill('Nisha Rao');
  await page.getByLabel('Phone number').fill('+91 98765 43211');
  await page.getByRole('button', { name: 'Add contact' }).click();
  await expect(page.getByRole('heading', { name: 'Nisha Rao', level: 1 })).toBeVisible();

  await page.goto(`/c/${slug}/crm`);
  await page.getByRole('link', { name: 'Import CSV' }).click();
  await expect(page.getByRole('heading', { name: 'Import deals' })).toBeVisible();
  await page.getByLabel('CSV file').setInputFiles({
    name: 'deals.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'Phone,Title,Stage,Value\n+919876543211,Imported plan,Qualified,1500\n+919876543211,Lost one,Lost,\n',
    ),
  });
  await page.getByRole('button', { name: 'Preview' }).click();
  // The columns are suggested from their names.
  await expect(page.getByLabel("Contact's phone number")).toHaveValue('0');
  await expect(page.getByLabel('Deal title')).toHaveValue('1');
  await expect(page.getByLabel('Stage', { exact: true })).toHaveValue('2');
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Import 2 rows' }).click();
  await expect(page.getByText('1 deals added, 1 rows with errors (of 2).')).toBeVisible();
  await expect(
    page.getByText('Not imported: The pipeline has no stage named “Lost”.'),
  ).toBeVisible();

  // The deal is on the board, in its stage, with its value.
  await page.goto(`/c/${slug}/crm`);
  await expect(page.getByRole('link', { name: 'Imported plan' })).toBeVisible();
  await expect(page.getByLabel('Stage of Imported plan').locator('option:checked')).toHaveText(
    'Qualified',
  );
  await expect(page.getByText('Nisha Rao · ₹1,500.00')).toBeVisible();
});

test('custom deal field values are given when a deal is created (ADR-379)', async ({ page }) => {
  const { slug } = await createCompany(page, 'crmfields', 'Farah');
  await createPipeline(page, slug);
  // A text field and a yes/no field, defined in Settings → Pipelines (ADR-373).
  await page.getByLabel('New deal field').fill('Region');
  await page.locator('#deal-field-type').selectOption('text');
  await page.getByRole('button', { name: 'Add deal field' }).click();
  await expect(page.getByRole('cell', { name: 'region', exact: true })).toBeVisible();
  await page.getByLabel('New deal field').fill('Signed');
  await page.locator('#deal-field-type').selectOption('boolean');
  await page.getByRole('button', { name: 'Add deal field' }).click();
  await expect(page.getByRole('cell', { name: 'signed', exact: true })).toBeVisible();

  await page.goto(`/c/${slug}/contacts/new`);
  await page.getByLabel('Name').fill('Farah Khan');
  await page.getByLabel('Phone number').fill('+91 98765 43212');
  await page.getByRole('button', { name: 'Add contact' }).click();
  await expect(page.getByRole('heading', { name: 'Farah Khan', level: 1 })).toBeVisible();
  await page.getByText('New deal', { exact: true }).click();
  await page.getByLabel('Deal title').fill('Regional plan');
  await page.getByLabel('Region', { exact: true }).fill('South');
  // Signed is left “Not set”: the deal gets no value for it.
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Create deal' }).click();
  await expect(page.getByRole('heading', { name: 'Regional plan', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Region', { exact: true })).toHaveValue('South');
  await expect(page.getByLabel('Signed', { exact: true })).toHaveValue('');
});

test('a deal moves through a pipeline with tasks, an emailed reminder, notes and reports', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const { email, slug } = await createCompany(page, 'crm', 'Chandra');

  // Before a pipeline exists, the board points owners to Settings → Pipelines.
  await page.getByRole('link', { name: 'CRM' }).first().click();
  await expect(page.getByRole('heading', { name: 'No pipeline yet' })).toBeVisible();
  await createPipeline(page, slug, { qualifiedChance: '50' });
  await expect(page.getByText('2. Qualified · 50%')).toBeVisible();
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

  // Custom deal fields (ADR-373): defined in Settings → Pipelines, filled in on the deal.
  const fieldsUrl = page.url();
  await page.goto(`/c/${slug}/settings/pipelines`);
  await page.getByLabel('New deal field').fill('Seats');
  await page.locator('#deal-field-type').selectOption('number');
  await page.getByRole('button', { name: 'Add deal field' }).click();
  await expect(page.getByRole('cell', { name: 'seats', exact: true })).toBeVisible();
  await page.getByLabel('New deal field').fill('Signed');
  await page.locator('#deal-field-type').selectOption('boolean');
  await page.getByRole('button', { name: 'Add deal field' }).click();
  await expect(page.getByRole('cell', { name: 'signed', exact: true })).toBeVisible();
  await page.goto(fieldsUrl);
  await page.getByLabel('Seats', { exact: true }).fill('many');
  await page.getByRole('button', { name: 'Save deal' }).click();
  await expect(page.getByText('Seats must be a number.')).toBeVisible();
  await page.getByLabel('Seats', { exact: true }).fill('25');
  await page.getByLabel('Signed', { exact: true }).selectOption('true');
  await page.getByRole('button', { name: 'Save deal' }).click();
  await expect(page.getByText('Deal saved.')).toBeVisible();
  await expect(page.getByLabel('Seats', { exact: true })).toHaveValue('25');
  await expect(page.getByLabel('Signed', { exact: true })).toHaveValue('true');
  await expect(timeline.getByText('custom fields')).toBeVisible();

  // The board weighs it by its stage's chance of winning (ADR-242).
  const editedUrl = page.url();
  await page.goto(`/c/${slug}/crm`);
  await expect(page.getByText('50% chance · weighted ₹13,000.00')).toBeVisible();
  await expect(page.getByText('Weighted pipeline')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  // Reports forecast it by its expected close date, here none, weighed the same way (ADR-252).
  await page.goto(`/c/${slug}/reports`);
  await expect(page.getByRole('heading', { name: 'Weighted forecast: Sales' })).toBeVisible();
  const undated = page.getByRole('row').filter({ hasText: 'No expected date' });
  await expect(undated).toContainText('₹26,000.00');
  await expect(undated).toContainText('₹13,000.00');
  await expectNoHorizontalOverflow(page);
  await page.goto(editedUrl);

  // A second rupee pipeline takes the deal with its value (ADR-234).
  const dealUrl = page.url();
  await page.goto(`/c/${slug}/settings/pipelines`);
  const newPipeline = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Create pipeline' }) });
  await newPipeline.getByLabel('Name', { exact: true }).fill('Renewals');
  await newPipeline.getByRole('button', { name: 'Create pipeline' }).click();
  await expect(page.getByText('Pipeline created.')).toBeVisible();
  await page.goto(dealUrl);
  await page.getByText('Move to another pipeline').click();
  await page.getByLabel('Pipeline', { exact: true }).selectOption({ label: 'Renewals (INR)' });
  await page.getByLabel('Stage in that pipeline').selectOption({ label: 'New' });
  await page.getByRole('button', { name: 'Move deal' }).click();
  await expect(page.getByText('Renewals · ₹26,000.00')).toBeVisible();
  await expect(timeline.getByText('Qualified → New (another pipeline)')).toBeVisible();

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

  // A key that reads deals finds the won deal and its pipelines through the API (ADR-253): the
  // value in paise, the pipeline it moved to and the stage it was won in, by id.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Deal sync');
  await page.getByRole('checkbox', { name: /Read CRM deals/ }).check();
  await page.getByRole('checkbox', { name: /Create and change CRM deals/ }).check();
  await page.getByRole('checkbox', { name: /Read CRM tasks/ }).check();
  await page.getByRole('checkbox', { name: /Create and change CRM tasks/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const tokenField = page.getByLabel('API key', { exact: true });
  await expect(tokenField).toBeVisible();
  const auth = { Authorization: `Bearer ${await tokenField.inputValue()}` };
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const pipelinesRes = await request.get('/api/v1/pipelines', { headers: auth });
  expect(pipelinesRes.status()).toBe(200);
  const pipelines = (
    (await pipelinesRes.json()) as {
      data: {
        id: string;
        name: string;
        stages: { id: string; name: string; winPercent: number | null }[];
      }[];
    }
  ).data;
  expect(pipelines.map((p) => p.name)).toEqual(['Sales', 'Renewals']);
  expect(pipelines[0]!.stages.find((s) => s.name === 'Qualified')?.winPercent).toBe(50);
  const wonRes = await request.get('/api/v1/deals?status=won', { headers: auth });
  expect(wonRes.status()).toBe(200);
  const won = (
    (await wonRes.json()) as {
      data: { id: string; title: string; pipelineId: string; stageId: string; contactId: string }[];
      nextCursor: string | null;
    }
  ).data;
  expect(won).toHaveLength(1);
  expect(won[0]).toMatchObject({
    title: 'Annual plan',
    status: 'won',
    valueMinor: 2_600_000,
    currency: 'INR',
    pipelineId: pipelines[1]!.id,
    stageId: pipelines[1]!.stages.find((s) => s.name === 'New')!.id,
    closedAt: expect.any(String),
  });
  const one = await request.get(`/api/v1/deals/${won[0]!.id}`, { headers: auth });
  expect(((await one.json()) as { data: unknown }).data).toEqual(won[0]);

  // The same key reads the deal's task (ADR-258): done, its reminder emailed, about the deal and
  // its contact by id.
  const tasksRes = await request.get(`/api/v1/tasks?dealId=${won[0]!.id}`, { headers: auth });
  expect(tasksRes.status()).toBe(200);
  const dealTasks = ((await tasksRes.json()) as { data: { assigneeId: string }[] }).data;
  expect(dealTasks).toEqual([
    expect.objectContaining({
      title: 'Send the proposal',
      status: 'done',
      reminderState: 'sent',
      remindedAt: expect.any(String),
      dealId: won[0]!.id,
      contactId: won[0]!.contactId,
      completedAt: expect.any(String),
    }),
  ]);

  // It adds a follow-up task to the deal for the same member (ADR-259), which the deal's timeline
  // shows as added through the API.
  const followUpRes = await request.post('/api/v1/tasks', {
    headers: { ...auth, 'Idempotency-Key': `crm-task-e2e-${Date.now()}` },
    data: { title: 'Ask for a review', assigneeId: dealTasks[0]!.assigneeId, dealId: won[0]!.id },
  });
  expect(followUpRes.status()).toBe(201);
  const followUp = ((await followUpRes.json()) as { data: { id: string; version: number } }).data;
  expect(followUp).toMatchObject({
    title: 'Ask for a review',
    status: 'open',
    dealId: won[0]!.id,
    contactId: won[0]!.contactId,
  });
  // Then it marks the task done (ADR-260), from the version it read.
  const doneRes = await request.patch(`/api/v1/tasks/${followUp.id}`, {
    headers: auth,
    data: { status: 'done', expectedVersion: followUp.version },
  });
  expect(doneRes.status()).toBe(200);
  expect(((await doneRes.json()) as { data: unknown }).data).toMatchObject({
    status: 'done',
    version: followUp.version + 1,
  });
  await page.goto(`/c/${slug}/crm/deals/${won[0]!.id}`);
  await expect(page.getByRole('heading', { name: 'Annual plan', level: 1 })).toBeVisible();
  const entries = page
    .getByRole('list', { name: 'Timeline' })
    .getByRole('listitem')
    .filter({ hasText: 'Ask for a review' });
  await expect(entries.filter({ hasText: 'Task added' })).toContainText('through the API');
  await expect(entries.filter({ hasText: 'Task done' })).toContainText('through the API');

  // The key also creates a deal for the customer (ADR-254), in the pipeline's first stage, then
  // changes it as members do (ADR-255): a new value and the next stage. Its page says it came
  // through the API.
  const createdRes = await request.post('/api/v1/deals', {
    headers: { ...auth, 'Idempotency-Key': `crm-e2e-${Date.now()}` },
    data: {
      contactId: won[0]!.contactId,
      pipelineId: pipelines[0]!.id,
      title: 'Second order',
      valueMinor: 120_000,
    },
  });
  expect(createdRes.status()).toBe(201);
  const created = (
    (await createdRes.json()) as { data: { id: string; stageId: string; version: number } }
  ).data;
  expect(created.stageId).toBe(pipelines[0]!.stages[0]!.id);
  const qualified = pipelines[0]!.stages.find((s) => s.name === 'Qualified')!.id;
  const changedRes = await request.patch(`/api/v1/deals/${created.id}`, {
    headers: auth,
    data: { stageId: qualified, valueMinor: 150_000, expectedVersion: created.version },
  });
  expect(changedRes.status()).toBe(200);
  expect(
    ((await changedRes.json()) as { data: { stageId: string; version: number } }).data,
  ).toMatchObject({ stageId: qualified, version: created.version + 1 });
  await page.goto(`/c/${slug}/crm/deals/${created.id}`);
  await expect(page.getByRole('heading', { name: 'Second order', level: 1 })).toBeVisible();
  await expect(page.getByText('Sales · ₹1,500.00')).toBeVisible();
  await expect(page.getByLabel('Stage of Second order')).toHaveValue(qualified);
  await expect(page.getByText(/through the API/).first()).toBeVisible();
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
