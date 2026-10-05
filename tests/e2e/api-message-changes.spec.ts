import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';
import {
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

interface Change {
  id: string;
  erased: boolean;
  message: { direction: string; text: string | null; status: string; sentBy: string | null } | null;
}

interface Page {
  data: Change[];
  nextCursor: string;
  hasMore: boolean;
}

test('a key follows messages as they change: a customer’s message, then a reply as it is sent and read (ADR-116)', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail('apimsgfeed');
  const slug = `apimsgfeed-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Mira Feed', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Feed Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Helpdesk sync');
  await page.getByRole('checkbox', { name: /Reply with text/ }).check();
  await page.getByRole('checkbox', { name: /Read conversations/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const auth = { Authorization: `Bearer ${token}` };
  const changes = async (cursor?: string): Promise<Page> => {
    const res = await request.get(
      `/api/v1/message-changes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      { headers: auth },
    );
    expect(res.status()).toBe(200);
    return (await res.json()) as Page;
  };

  // The customer writes: the feed, read from its start, holds the message.
  const waId = randomWaId();
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, waId, 'Is it in stock?'));
  let start: Page | undefined;
  await expect(async () => {
    start = await changes();
    expect(start.data.map((c) => c.message?.text)).toEqual(['Is it in stock?']);
  }).toPass({ timeout: 20_000 });
  expect(start!.hasMore).toBe(false);

  // The key replies; from the cursor, the feed holds the reply as the worker sends it.
  const sent = await request.post('/api/v1/messages', {
    headers: { ...auth, 'Idempotency-Key': randomUUID() },
    data: { type: 'text', to: `+${waId}`, text: 'Yes, in all sizes.' },
  });
  expect(sent.status()).toBe(201);
  const replyId = ((await sent.json()) as { data: { id: string } }).data.id;
  let accepted: Page | undefined;
  await expect(async () => {
    accepted = await changes(start!.nextCursor);
    expect(accepted.data.map((c) => [c.id, c.message?.status])).toEqual([[replyId, 'accepted']]);
  }).toPass({ timeout: 30_000 });
  expect(accepted!.data[0]!.message).toMatchObject({ direction: 'outbound', sentBy: 'api' });

  // WhatsApp reports it delivered, then read: from the last cursor, the reply once, as it is now.
  const wamid = (await standInRequests(request))
    .filter((r) => r.path === `/v26.0/${phoneNumberId}/messages`)
    .pop()?.wamid;
  expect(wamid).toBeTruthy();
  await sendSignedWebhook(request, statusUpdate(wabaId, phoneNumberId, wamid!, 'delivered', waId));
  await sendSignedWebhook(request, statusUpdate(wabaId, phoneNumberId, wamid!, 'read', waId));
  await expect(async () => {
    const read = await changes(accepted!.nextCursor);
    expect(read.data.map((c) => [c.id, c.message?.status])).toEqual([[replyId, 'read']]);
  }).toPass({ timeout: 20_000 });

  // From the start: each message once, the reply at its latest status.
  const all = await changes();
  expect(all.data.map((c) => [c.message?.text, c.message?.status])).toEqual([
    ['Is it in stock?', 'received'],
    ['Yes, in all sizes.', 'read'],
  ]);
  // A forged cursor is refused.
  const forged = await request.get('/api/v1/message-changes?cursor=not-a-cursor', {
    headers: auth,
  });
  expect(forged.status()).toBe(422);
});
