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
import { openFromNav, signUpAndVerify, uniqueEmail } from './support';

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
  // Exact: the conversation also has a “Send file” button.
  await page.getByRole('button', { name: 'Send', exact: true }).click();
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

test('a voice note is passed on in the parts a player asks for, as Safari’s does (ADR-382)', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('inbox-ranges');
  const slug = `ranges-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Rhea Ranges', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Range Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  const voiceId = newMediaId();
  const voice = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  await setStandInMedia(request, { id: voiceId, mimeType: 'audio/ogg', bytes: voice });
  await sendSignedWebhook(
    request,
    inboundMessages(wabaId, phoneNumberId, randomWaId(), [
      { type: 'audio', audio: { id: voiceId, mime_type: 'audio/ogg; codecs=opus', voice: true } },
    ]),
  );
  await page.getByRole('link', { name: 'Inbox' }).click();
  const conversation = page.getByRole('link', { name: /Priya Customer/ });
  await expect(conversation).toBeVisible({ timeout: 20_000 });
  await conversation.click();
  const thread = page.getByRole('list', { name: /^Messages with/ });
  await expect(thread.getByText('Voice message')).toBeVisible();
  const src = await thread.locator('audio').getAttribute('src');
  expect(src).toMatch(new RegExp(`^/c/${slug}/inbox/[0-9a-f-]+/media/[0-9a-f-]+$`));
  const fetchPart = (range?: string) =>
    page.request.get(src!, range ? { headers: { Range: range } } : {});

  // A player's first question: the first two bytes, and how long the file is.
  const probe = await fetchPart('bytes=0-1');
  expect(probe.status()).toBe(206);
  expect(probe.headers()).toMatchObject({
    'content-type': 'audio/ogg',
    'content-range': 'bytes 0-1/1000',
    'content-length': '2',
    'accept-ranges': 'bytes',
    // As the browser gets them: kept by no browser, and nothing in the file runs.
    'cache-control': 'private, no-store',
    'content-security-policy': "default-src 'none'; sandbox",
    'x-content-type-options': 'nosniff',
  });
  expect((await probe.body()).equals(voice.subarray(0, 2))).toBe(true);
  // From the middle to the end, and the last bytes.
  const rest = await fetchPart('bytes=600-');
  expect(rest.status()).toBe(206);
  expect(rest.headers()['content-range']).toBe('bytes 600-999/1000');
  expect((await rest.body()).equals(voice.subarray(600))).toBe(true);
  const last = await fetchPart('bytes=-10');
  expect(last.headers()['content-range']).toBe('bytes 990-999/1000');
  expect((await last.body()).equals(voice.subarray(990))).toBe(true);
  // Past the end there is no part; the whole file says that parts can be asked for.
  const past = await fetchPart('bytes=1000-');
  expect(past.status()).toBe(416);
  expect(past.headers()).toMatchObject({
    'content-range': 'bytes */1000',
    'content-security-policy': "default-src 'none'; sandbox",
  });
  const whole = await fetchPart();
  expect(whole.status()).toBe(200);
  expect(whole.headers()).toMatchObject({
    'accept-ranges': 'bytes',
    'content-security-policy': "default-src 'none'; sandbox",
  });
  expect((await whole.body()).equals(voice)).toBe(true);
});

test('a member sends a document from the conversation, uploaded to WhatsApp and sent by its id (ADR-218)', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('inbox-send-file');
  const slug = `sendfile-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Sana Sends', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Sending Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // The customer writes, which opens the window for replies.
  const waId = randomWaId();
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, waId, 'Can you send the price list?'),
  );
  await page.getByRole('link', { name: 'Inbox' }).click();
  const conversation = page.getByRole('link', { name: /Priya Customer/ });
  await expect(conversation).toBeVisible({ timeout: 20_000 });
  await conversation.click();

  const pdf = Buffer.from('%PDF-1.4 price list for Sana');
  const picker = page.getByLabel('File', { exact: true });
  // The form takes the file once React has hydrated it.
  await expect(picker).toBeEnabled();
  await picker.setInputFiles({ name: 'Price list.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.getByLabel(/^Caption/).fill('Our prices for October');
  await page.getByRole('button', { name: 'Send file' }).click();
  await expect(page.getByText('File sent.')).toBeVisible();

  // The thread shows the file the member sent, and the worker hands it to WhatsApp by its id.
  const thread = page.getByRole('list', { name: /^Messages with/ });
  await expect(thread.getByText('Our prices for October')).toBeVisible();
  await expect(thread.getByText('Sent to WhatsApp')).toBeVisible({ timeout: 20_000 });
  const requests = await standInRequests(request);
  const upload = requests.filter((r) => r.path === `/v26.0/${phoneNumberId}/media`);
  expect(upload).toHaveLength(1);
  expect(upload[0]!.authorization).toBe(`Bearer ${E2E_CHANNEL_TOKEN}`);
  const send = requests
    .filter(
      (r) =>
        r.path === `/v26.0/${phoneNumberId}/messages` &&
        (r.body as { to?: string } | null)?.to === waId,
    )
    .pop();
  expect(send?.body).toMatchObject({
    type: 'document',
    document: {
      id: expect.any(String) as unknown as string,
      caption: 'Our prices for October',
      filename: 'Price list.pdf',
    },
  });

  // The member opens what they sent, as WhatsApp keeps it.
  const downloading = page.waitForEvent('download');
  await thread.getByRole('link', { name: 'Download Price list.pdf' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Price list.pdf');
  expect((await readFile(await download.path())).equals(pdf)).toBe(true);
});

test('a member tags a conversation and lists the inbox by its tags (ADR-220)', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('inbox-tags');
  const slug = `tags-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Tara Tags', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Tagging Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, randomWaId(), 'My refund has not arrived'),
  );
  await page.getByRole('link', { name: 'Inbox' }).click();
  const conversation = page.getByRole('link', { name: /Priya Customer/ });
  await expect(conversation).toBeVisible({ timeout: 20_000 });
  await conversation.click();

  // Tags are written in lower case, once each.
  const tags = page.getByRole('list', { name: 'Conversation tags' });
  await page.getByLabel('Add tags to this conversation').fill('Refund, VIP, refund');
  await page.getByRole('button', { name: 'Add tags' }).click();
  await expect(tags.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Remove tag refund' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove tag vip' })).toBeVisible();

  // The list shows them, and its filter offers the tags in use and lists the conversations with
  // the one chosen. Each change refreshes the conversation, so it is left through the navigation,
  // not a page load (see openFromNav).
  await openFromNav(page, 'Inbox');
  await expect(page).toHaveURL(new RegExp(`/c/${slug}/inbox$`));
  await expect(conversation).toContainText('refund');
  await expect(conversation).toContainText('vip');
  await page.getByLabel('Tag', { exact: true }).selectOption('vip');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page).toHaveURL(/[?&]tag=vip/);
  await expect(conversation).toBeVisible();

  // Once the tag is removed, the conversation leaves the list filtered by it. The filter no
  // longer offers the tag, so the list is loaded by its address, again if a refresh interrupts.
  await conversation.click();
  await page.getByRole('button', { name: 'Remove tag vip' }).click();
  await expect(tags.getByRole('listitem')).toHaveCount(1);
  await expect(async () => {
    await page.goto(`/c/${slug}/inbox?view=all&status=open&tag=vip`);
    await expect(page.getByText('No conversations here')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByLabel('Tag', { exact: true }).selectOption('refund');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page).toHaveURL(/[?&]tag=refund/);
  await expect(conversation).toBeVisible();
});

test('with read receipts on, opening a conversation marks the message read and writing shows a typing indicator (ADR-223)', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('inbox-read');
  const slug = `read-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Rita Reads', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Reading Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // Off until the company turns it on.
  await page.goto(`/c/${slug}/settings/inbox`);
  const setting = page.getByLabel(/Show customers when their messages are read/);
  await expect(setting).not.toBeChecked();
  await setting.check();
  await page.getByRole('button', { name: 'Save read receipt settings' }).click();
  await expect(page.getByText('Read receipt settings saved.')).toBeVisible();

  const wamid = `wamid.e2e.read.${Date.now()}`;
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, randomWaId(), 'Is anyone there?', new Date(), wamid),
  );
  const reads = async () =>
    (await standInRequests(request)).filter(
      (r) =>
        r.path === `/v26.0/${phoneNumberId}/messages` &&
        (r.body as { message_id?: string } | null)?.message_id === wamid,
    );

  // Opening the conversation marks the customer's message read in WhatsApp.
  await page.goto(`/c/${slug}/inbox`);
  const conversation = page.getByRole('link', { name: /Priya Customer/ });
  await expect(conversation).toBeVisible({ timeout: 20_000 });
  await conversation.click();
  await expect
    .poll(async () => (await reads()).map((r) => r.body), { timeout: 30_000 })
    .toEqual([{ messaging_product: 'whatsapp', status: 'read', message_id: wamid }]);

  // Writing a reply shows the customer a typing indicator.
  const reply = page.getByLabel('Reply');
  await expect(reply).toBeEnabled();
  await reply.fill('Let me check that for you');
  await expect
    .poll(
      async () =>
        (await reads()).filter(
          (r) => (r.body as { typing_indicator?: unknown }).typing_indicator !== undefined,
        ).length,
      { timeout: 30_000 },
    )
    .toBe(1);
  const typing = (await reads()).find(
    (r) => (r.body as { typing_indicator?: unknown }).typing_indicator !== undefined,
  );
  expect(typing?.authorization).toBe(`Bearer ${E2E_CHANNEL_TOKEN}`);
  expect(typing?.body).toEqual({
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: wamid,
    typing_indicator: { type: 'text' },
  });
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
