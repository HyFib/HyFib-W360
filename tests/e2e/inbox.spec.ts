import { readFile } from 'node:fs/promises';
import { expect, test } from './fixtures';
import {
  E2E_CHANNEL_TOKEN,
  connectTestChannel,
  inboundMessage,
  inboundMessages,
  messagingConfigured,
  newMediaId,
  randomWaId,
  sendSignedWebhook,
  setStandInMedia,
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

  // The owner downloads the conversation's transcript (ADR-212): both messages, oldest first.
  const downloading = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download transcript' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^conversation-[0-9a-f]{8}-\d{4}-\d{2}-\d{2}\.txt$/);
  const transcript = (await readFile(await download.path())).toString('utf8');
  expect(transcript).toContain(`Conversation with Priya Customer · +${waId}`);
  expect(transcript).toContain('Company: Inbox Traders');
  expect(transcript).toMatch(
    /\] Priya Customer: Is the blue kurta available\?\n\[[^\]]+\] Ira Inbox: Yes, in all sizes\.\n$/,
  );
});

test('a long message cut mid-emoji and a large contact card arrive in one webhook (ADR-131)', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('inbox-large');
  const slug = `large-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Lata Large', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Large Messages Co');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // Before ADR-131 the text's clip left half of the emoji, which jsonb refused, and the whole
  // receipt failed with the contact card in it. A message larger than any may be is kept without
  // its content.
  const waId = randomWaId();
  const wide = '𝒳'.repeat(2048); // 4,096 code units, 8 KB as UTF-8
  await sendSignedWebhook(
    request,
    inboundMessages(wabaId, phoneNumberId, waId, [
      { type: 'text', text: { body: `${'x'.repeat(4095)}😀 and the rest of a long message` } },
      {
        type: 'contacts',
        contacts: Array.from({ length: 25 }, (_, i) => ({
          name: { formatted_name: `Shared contact ${i}` },
          addresses: [{ street: 'y'.repeat(4_000), city: 'Pune' }],
        })),
      },
      {
        type: 'system',
        system: {
          type: wide,
          body: wide,
          user_id: wide,
          parent_user_id: wide,
          previous_user_id: wide,
          previous_parent_user_id: wide,
          wa_id: wide,
          new_wa_id: wide,
        },
      },
    ]),
  );
  await page.getByRole('link', { name: 'Inbox' }).click();
  const conversation = page.getByRole('link', { name: /Priya Customer/ });
  await expect(conversation).toBeVisible({ timeout: 20_000 });
  await conversation.click();
  const thread = page.getByRole('list', { name: /^Messages with/ });
  await expect(thread.getByText('x'.repeat(4095), { exact: true })).toBeVisible();
  await expect(thread.getByText('Shared a contact card')).toBeVisible();
  await expect(thread.getByText(/^\d+ contacts were too large to keep$/)).toBeVisible();
  await expect(thread.getByText('This message was too large to keep.')).toBeVisible();
});

/** A 1×1 PNG. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

test('a photo and a document the customer sends open from the conversation (ADR-216)', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('inbox-files');
  const slug = `files-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Faiz Files', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('File Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // WhatsApp keeps the files; the webhook names them.
  const photoId = newMediaId();
  const pdfId = newMediaId();
  const pdf = Buffer.from('%PDF-1.4 price list');
  await setStandInMedia(request, { id: photoId, mimeType: 'image/png', bytes: PIXEL });
  await setStandInMedia(request, { id: pdfId, mimeType: 'application/pdf', bytes: pdf });
  await sendSignedWebhook(
    request,
    inboundMessages(wabaId, phoneNumberId, randomWaId(), [
      { type: 'image', image: { id: photoId, mime_type: 'image/png', caption: 'The blue kurta' } },
      {
        type: 'document',
        document: { id: pdfId, mime_type: 'application/pdf', filename: 'Price list.pdf' },
      },
    ]),
  );
  await page.getByRole('link', { name: 'Inbox' }).click();
  const conversation = page.getByRole('link', { name: /Priya Customer/ });
  await expect(conversation).toBeVisible({ timeout: 20_000 });
  await conversation.click();
  const thread = page.getByRole('list', { name: /^Messages with/ });

  // The photo is fetched from WhatsApp through HyFib as the page shows it.
  const photo = thread.getByRole('img', { name: 'The blue kurta' });
  await expect(photo).toBeVisible();
  await expect
    .poll(() => photo.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0)))
    .toBe(1);
  // The document downloads under the name it came with.
  const downloading = page.waitForEvent('download');
  await thread.getByRole('link', { name: 'Download Price list.pdf' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Price list.pdf');
  expect((await readFile(await download.path())).equals(pdf)).toBe(true);

  // Both came from WhatsApp with the company's token.
  const fetched = (await standInRequests(request)).filter(
    (r) => r.path === `/__media/${photoId}` || r.path === `/__media/${pdfId}`,
  );
  expect(new Set(fetched.map((r) => r.path))).toEqual(
    new Set([`/__media/${photoId}`, `/__media/${pdfId}`]),
  );
  expect(fetched.every((r) => r.authorization === `Bearer ${E2E_CHANNEL_TOKEN}`)).toBe(true);
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
