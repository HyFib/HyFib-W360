import { expect, test } from './fixtures';
import {
  connectTestChannel,
  inboundMessage,
  messagingConfigured,
  randomWaId,
  sendSignedWebhook,
  standInRequests,
} from './messaging-support';
import { signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';
const standIn = `http://127.0.0.1:${process.env.E2E_GRAPH_PORT}`;

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');

test('a template is drafted, submitted, approved at Meta and sent after the service window closed', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('templates');
  const slug = `tpl-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Tara Templates', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Template Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  await page.getByRole('link', { name: 'Templates' }).first().click();
  await page.getByRole('link', { name: 'New template' }).click();
  await page.getByLabel('Name').fill('order_update');
  await page.getByLabel('Language code').fill('en');
  await page.getByLabel('Body').fill('Hi {{1}}, your order is on its way.');
  await page.getByLabel('{{1}}').fill('Asha');
  await expect(page.getByLabel('Template preview')).toContainText(
    'Hi Asha, your order is on its way.',
  );
  // A website button whose link ends with a value given when sending, with its example (ADR-228).
  await page.getByRole('button', { name: 'Add website button' }).click();
  await page.getByLabel('Website button text').fill('Track order');
  await page.getByLabel('Address (https://)').fill('https://shop.example/track/{{1}}');
  await expect(page.getByText('Website button: give an example of the link’s end.')).toBeVisible();
  await page.getByLabel('Example for the link’s {{1}} (Meta reviews it)').fill('A-1001');
  await expect(page.getByText('Website button: give an example of the link’s end.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('heading', { name: 'order_update', level: 1 })).toBeVisible();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  // The draft can still be edited before submission.
  await page.getByLabel('Footer (optional)').fill('Reply STOP to opt out');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Footer (optional)')).toHaveValue('Reply STOP to opt out');
  await expect(page.getByLabel('Example for the link’s {{1}} (Meta reviews it)')).toHaveValue(
    'A-1001',
  );

  await page.getByRole('button', { name: 'Submit to Meta' }).click();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  // Submitted: the page the action returned has no draft buttons. Reloading earlier could cancel
  // the submission's request.
  await expect(page.getByRole('button', { name: /^Submit/ })).toHaveCount(0);
  // The worker sends the create request; Meta answers PENDING.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('In review', { exact: true }).first()).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 30_000 });

  // Meta approves; a refresh reads the listing (the source of truth).
  const approved = await request.post(`${standIn}/__stand-in/template-status`, {
    data: { wabaId, name: 'order_update', status: 'APPROVED' },
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

  // A customer who wrote 25 hours ago: free-form replies are closed, templates are offered.
  const waId = randomWaId();
  const old = inboundMessage(
    wabaId,
    phoneNumberId,
    waId,
    'Where is my order?',
    new Date(Date.now() - 25 * 3600_000),
  );
  await sendSignedWebhook(request, old);
  await page.goto(`/c/${slug}/inbox`);
  const conversation = page.getByRole('link', { name: /Priya Customer/ });
  await expect(conversation).toBeVisible({ timeout: 20_000 });
  await conversation.click();
  await expect(page.getByText('Window closed')).toBeVisible();
  await page.getByLabel('Template').selectOption({ label: 'order_update (en, utility)' });
  await page.getByLabel('Body variable {{1}}').fill('Priya');
  await page.getByLabel('End of the “Track order” link').fill('A-2002');
  await expect(page.getByLabel('Message preview')).toContainText(
    'Hi Priya, your order is on its way.',
  );
  await expect(page.getByLabel('Message preview')).toContainText(
    'https://shop.example/track/A-2002',
  );
  await page.getByRole('button', { name: 'Send template' }).click();
  await expect(page.getByText(/Template queued/)).toBeVisible();
  // The conversation updates live; reloading it could cancel a live refresh (see openFromNav).
  await expect(page.getByText('Sent to WhatsApp')).toBeVisible({ timeout: 30_000 });
  // The conversation shows the link as sent.
  await expect(page.getByRole('link', { name: 'https://shop.example/track/A-2002' })).toBeVisible();
  const sent = (await standInRequests(request))
    .filter((r) => r.path === `/v26.0/${phoneNumberId}/messages`)
    .pop();
  expect(sent?.body).toMatchObject({
    to: waId,
    type: 'template',
    template: {
      name: 'order_update',
      language: { policy: 'deterministic', code: 'en' },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: 'Priya' }] },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: 'A-2002' }],
        },
      ],
    },
  });
});

test('a template drafted from a starter keeps its copy and the company’s opt-out keyword', async ({
  page,
}) => {
  const email = uniqueEmail('starters');
  const slug = `tps-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Sana Starters', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Starter Supplies');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  await connectTestChannel({ ownerEmail: email, slug });

  await page.goto(`/c/${slug}/templates/new`);
  await page
    .getByRole('navigation', { name: 'Marketing starters' })
    .getByRole('link', { name: 'Seasonal offer' })
    .click();
  await expect(page.getByText('Started from “Seasonal offer”')).toBeVisible();
  // The company's marketing opt-out keyword (the default) becomes the starter's button (ADR-232).
  await expect(
    page.getByText('The STOP PROMOTIONS button lets customers stop offers'),
  ).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveValue('seasonal_offer');
  await expect(page.getByLabel('Category')).toHaveValue('MARKETING');
  const preview = page.getByLabel('Template preview');
  await expect(preview).toContainText('Our sale is on');
  await expect(preview).toContainText(
    'Hi Asha, our Diwali sale runs until 20 October, with up to 30% off selected items.',
  );
  await expect(preview).toContainText('STOP PROMOTIONS');
  await expect(page.getByLabel('Quick reply text')).toHaveValue('STOP PROMOTIONS');
  // The member changes what they like before saving.
  await page.getByLabel('Name').fill('festive_offer');
  await page.getByLabel('Language code').fill('en');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('heading', { name: 'festive_offer', level: 1 })).toBeVisible();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Body')).toHaveValue(
    'Hi {{1}}, our {{2}} sale runs until {{3}}, with {{4}} off selected items. Reply to this message to ask about anything you like.',
  );

  // A utility starter takes no opt-out button; a blank template starts empty again.
  await page.goto(`/c/${slug}/templates/new?starter=appointment_reminder`);
  await expect(page.getByLabel('Name')).toHaveValue('appointment_reminder');
  await expect(page.getByLabel('Quick reply text')).toHaveCount(2);
  await expect(page.getByLabel('Template preview')).not.toContainText('STOP PROMOTIONS');
  await page.getByRole('link', { name: 'A blank template' }).click();
  await expect(page.getByLabel('Name')).toHaveValue('');
  await expect(page.getByLabel('Body')).toHaveValue('');
});
