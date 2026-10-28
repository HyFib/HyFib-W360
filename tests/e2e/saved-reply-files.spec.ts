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

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');

/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('a saved reply with a photo is attached in the conversation, reviewed and sent through WhatsApp (ADR-411)', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail('saved-files');
  const slug = `savedfile-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Sam Saved', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Saved Files Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // Settings → Saved replies: a reply, then its photo.
  await page.goto(`/c/${slug}/settings/saved-replies`);
  await page.getByLabel('Shortcut').fill('prices');
  await page.getByLabel('Title').fill('Price list');
  await page.getByLabel('Reply', { exact: true }).fill('Hi {{name}}, here are our prices.');
  await page.getByRole('button', { name: 'Add saved reply' }).click();
  await expect(page.getByText('Saved reply added.')).toBeVisible();
  const edit = page.locator('details', { hasText: 'Edit /prices' });
  await edit.getByText('Edit /prices').click();
  const picker = edit.getByLabel('Attach a file');
  await expect(picker).toBeEnabled();
  await picker.setInputFiles({ name: 'prices.png', mimeType: 'image/png', buffer: PNG });
  await edit.getByRole('button', { name: /Save file/ }).click();
  await expect(edit.getByText('File saved.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'prices.png' })).toBeVisible();
  // The photo makes the text its caption: the editor now holds it to 1,024 characters.
  await expect(edit.getByLabel('Reply', { exact: true })).toHaveAttribute('maxlength', '1024');

  // A customer writes, which opens the window.
  const waId = randomWaId();
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, waId, 'Can I see your prices?'),
  );
  await page.goto(`/c/${slug}/inbox`);
  const conversation = page.getByRole('link', { name: /Priya Customer/ });
  await expect(conversation).toBeVisible({ timeout: 20_000 });
  await conversation.click();

  // Inserting the reply attaches its photo, with the text as the caption; nothing is sent yet.
  const saved = page.getByLabel('Insert a saved reply');
  await expect(saved).toBeEnabled();
  // A caption the member already wrote in Send a file is never discarded: nothing is inserted.
  const caption = page.getByLabel(/^Caption/);
  await caption.fill('My own caption');
  await saved.selectOption({ label: '/prices · Price list (with a photo)' });
  await expect(
    page.getByText(/already holds a file or a caption, so “Price list” was not/),
  ).toBeVisible();
  await expect(caption).toHaveValue('My own caption');
  await expect(page.getByTestId('inserted-file')).toHaveCount(0);
  await caption.fill('');
  await saved.selectOption({ label: '/prices · Price list (with a photo)' });
  const inserted = page.getByTestId('inserted-file');
  await expect(inserted).toContainText('from the saved reply “Price list”: prices.png');
  await expect(inserted.getByRole('img', { name: 'Preview of prices.png' })).toBeVisible();
  await expect(page.getByLabel(/^Caption/)).toHaveValue('Hi Priya Customer, here are our prices.');
  await expect(page.getByLabel('Reply', { exact: true })).toHaveValue('');
  await expect(page.getByText(/Review them before sending/)).toBeVisible();
  const uploadsBefore = (await standInRequests(request)).filter(
    (r) => r.path === `/v26.0/${phoneNumberId}/media`,
  );
  expect(uploadsBefore).toHaveLength(0);

  // The member reviews and sends it; it goes as a photo with its caption, and shows in the thread.
  await page.getByRole('button', { name: 'Send file' }).click();
  await expect(page.getByText('File sent.')).toBeVisible();
  await expect(page.getByTestId('inserted-file')).toHaveCount(0);
  const thread = page.getByRole('list', { name: /^Messages with/ });
  await expect(thread.getByText('Hi Priya Customer, here are our prices.')).toBeVisible();
  await expect(thread.getByText('Sent to WhatsApp')).toBeVisible({ timeout: 20_000 });
  const requests = await standInRequests(request);
  const uploads = requests.filter((r) => r.path === `/v26.0/${phoneNumberId}/media`);
  expect(uploads).toHaveLength(1);
  expect(uploads[0]?.body).toMatchObject({
    messaging_product: 'whatsapp',
    file: { filename: 'prices.png', type: 'image/png' },
  });
  const send = requests
    .filter(
      (r) =>
        r.path === `/v26.0/${phoneNumberId}/messages` &&
        (r.body as { to?: string } | null)?.to === waId,
    )
    .pop();
  expect(send?.body).toMatchObject({
    type: 'image',
    image: {
      id: expect.any(String) as unknown as string,
      caption: 'Hi Priya Customer, here are our prices.',
    },
  });
});
