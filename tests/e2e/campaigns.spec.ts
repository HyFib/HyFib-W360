import { expect, test } from './fixtures';
import {
  connectTestChannel,
  messagingConfigured,
  sendSignedWebhook,
  standInRequests,
  statusUpdate,
} from './messaging-support';
import { signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';
const standIn = `http://127.0.0.1:${process.env.E2E_GRAPH_PORT}`;

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');

test('a campaign is drafted, reviewed, started by the worker and reported per recipient', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('campaigns');
  const slug = `cmp-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Cam Campaigns', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Campaign Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // An approved marketing template.
  await page.goto(`/c/${slug}/templates/new`);
  await page.getByLabel('Name').fill('spring_sale');
  await page.getByLabel('Language code').fill('en');
  await page.getByLabel('Category').selectOption('MARKETING');
  await page.getByLabel('Body').fill('Hello {{1}}, our spring sale starts today.');
  await page.getByLabel('{{1}}').fill('Asha');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('heading', { name: 'spring_sale', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Submit to Meta' }).click();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  // Submitted (no draft buttons) before reloading, which could cancel the submission's request.
  await expect(page.getByRole('button', { name: /^Submit/ })).toHaveCount(0);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('In review', { exact: true }).first()).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 30_000 });
  const approved = await request.post(`${standIn}/__stand-in/template-status`, {
    data: { wabaId, name: 'spring_sale', status: 'APPROVED' },
  });
  expect(approved.status()).toBe(200);
  await page.goto(`/c/${slug}/templates`);
  await page.getByRole('button', { name: 'Refresh from Meta' }).click();
  await expect(page.getByText(/Refresh requested/)).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 30_000 });

  // Two tagged contacts; only one has a marketing opt-in.
  for (const [name, phone, optIn] of [
    ['Asha Rao', '+91 98765 12345', true],
    ['Bina Shah', '+91 98765 12346', false],
  ] as const) {
    await page.goto(`/c/${slug}/contacts/new`);
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Phone number').fill(phone);
    await page.getByRole('button', { name: 'Add contact' }).click();
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    await page.getByLabel('Add tags').fill('vip');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Tags' })).toContainText('vip');
    if (optIn) {
      await page.getByLabel('How and when did they tell you?').fill('Signed up at the counter');
      await page.getByRole('button', { name: 'Record consent' }).click();
      await expect(page.getByText('Consent recorded.')).toBeVisible();
    }
  }

  // Draft → review → start.
  await page.goto(`/c/${slug}/campaigns`);
  await page.getByRole('link', { name: 'New campaign' }).click();
  await page.getByLabel('Campaign name').fill('Spring launch');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Spring launch', level: 1 })).toBeVisible();
  await page.getByLabel('Send from').selectOption({ index: 1 });
  await page.getByLabel('Template').selectOption({ label: 'spring_sale (en, marketing)' });
  await page.getByLabel('Body variable {{1}}').selectOption('name');
  await expect(page.getByLabel('Campaign message preview')).toContainText(
    'Hello [name, or “there”], our spring sale starts today.',
  );
  await page.getByLabel('Tag', { exact: true }).fill('vip');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved. The review below is updated.')).toBeVisible();
  await expect(page.getByText(/of 2 contacts in the audience can receive it now/)).toContainText(
    '1',
  );
  await expect(page.getByText('No marketing opt-in: 1')).toBeVisible();
  await page.getByRole('button', { name: 'Start campaign' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Start campaign' }).click();

  // The worker's runner queues the message and the send worker hands it to WhatsApp.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Handed to WhatsApp', { exact: true }).locator('..')).toContainText(
      '1',
      { timeout: 1_000 },
    );
  }).toPass({ timeout: 45_000 });
  let sent: { body: unknown; wamid?: string } | undefined;
  await expect(async () => {
    sent = (await standInRequests(request))
      .filter((r) => r.path === `/v26.0/${phoneNumberId}/messages`)
      .pop();
    expect(sent?.wamid).toBeTruthy();
  }).toPass({ timeout: 30_000 });
  expect(sent?.body).toMatchObject({
    to: '919876512345',
    type: 'template',
    template: {
      name: 'spring_sale',
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Asha Rao' }] }],
    },
  });

  // Meta reports delivery; the results count it with its denominator.
  await sendSignedWebhook(
    request,
    statusUpdate(wabaId, phoneNumberId, sent!.wamid!, 'delivered', '919876512345'),
  );
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('1 of 1 sent')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  // The runner completes the campaign on its next tick (about 10 seconds after queueing).
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 30_000 });

  // Per-recipient outcomes and a formula-safe export.
  await page.getByRole('link', { name: 'Recipients' }).click();
  await expect(page.getByText('Not sent: No marketing opt-in')).toBeVisible();
  await expect(page.getByRole('cell', { name: /Delivered/ })).toBeVisible();
  const campaignPath = new URL(page.url()).pathname.replace(/\/recipients$/, '');
  const csv = await page.request.get(`${campaignPath}/export`);
  expect(csv.status()).toBe(200);
  const text = await csv.text();
  expect(text).toContain('+919876512345,Asha Rao,queued,,delivered');
  expect(text).toContain('+919876512346,Bina Shah,skipped,no_marketing_opt_in');
});
