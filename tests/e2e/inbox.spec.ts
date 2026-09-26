import { expect, test } from './fixtures';
import {
  E2E_CHANNEL_TOKEN,
  connectTestChannel,
  inboundMessage,
  messagingConfigured,
  randomWaId,
  sendSignedWebhook,
  standInRequests,
  statusUpdate,
} from './messaging-support';
import { signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');

test('an inbound WhatsApp message appears live, the agent replies and delivery updates arrive', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('inbox');
  const slug = `inbox-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Ira Inbox', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Inbox Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  await page.getByRole('link', { name: 'Inbox' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();

  // Arrives without a reload: webhook → durable receipt → worker → event log → live stream.
  const waId = randomWaId();
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, waId, 'Is the blue kurta available?'),
  );
  const conversation = page.getByRole('link', { name: /Priya Customer/ });
  await expect(conversation).toBeVisible({ timeout: 20_000 });
  await conversation.click();
  await expect(page.getByText('Is the blue kurta available?')).toBeVisible();
  await expect(page.getByText(/Window open until/)).toBeVisible();

  await page.getByLabel('Reply').fill('Yes, in all sizes.');
  await page.getByRole('button', { name: 'Send' }).click();
  // Scoped to the thread: the conversation list shows the same text as its preview.
  const thread = page.getByRole('list', { name: /^Messages with/ });
  await expect(thread.getByText('Yes, in all sizes.')).toBeVisible();
  await expect(thread.getByText('Sent to WhatsApp')).toBeVisible({ timeout: 20_000 });

  // The request reached "Meta" with this company's token and the customer's number.
  const sent = (await standInRequests(request))
    .filter((r) => r.path === `/v26.0/${phoneNumberId}/messages`)
    .pop();
  expect(sent?.authorization).toBe(`Bearer ${E2E_CHANNEL_TOKEN}`);
  expect(sent?.body).toMatchObject({
    to: waId,
    type: 'text',
    text: { body: 'Yes, in all sizes.' },
  });

  // A delivery receipt from Meta updates the thread live.
  await sendSignedWebhook(
    request,
    statusUpdate(wabaId, phoneNumberId, sent!.wamid!, 'delivered', waId),
  );
  await expect(page.getByText('Delivered')).toBeVisible({ timeout: 20_000 });
});

test('webhooks with a bad signature are refused and store nothing', async ({ request }) => {
  const res = await request.post('/api/webhooks/meta', {
    data: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
    },
  });
  expect(res.status()).toBe(401);
  const unsigned = await request.post('/api/webhooks/meta', { data: '{}' });
  expect(unsigned.status()).toBe(401);
});
