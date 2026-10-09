import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';
import {
  E2E_CHANNEL_TOKEN,
  connectTestChannel,
  inboundMessage,
  inboundMessages,
  listReply,
  messagingConfigured,
  newMediaId,
  randomWaId,
  reactionMessage,
  sendSignedWebhook,
  setStandInMedia,
  standInRequests,
  templateButtonReply,
} from './messaging-support';
import { expectNoHorizontalOverflow, openFromNav, signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';
const standIn = `http://127.0.0.1:${process.env.E2E_GRAPH_PORT}`;

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');

test('an API key created in settings sends an approved template once, and stops working when revoked', async ({
  page,
  request,
}) => {
  // Several sends wait for WhatsApp after the templates' review: more than the default minute.
  test.setTimeout(180_000);
  const email = uniqueEmail('api');
  const slug = `api-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Arun Api', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Api Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // An approved utility template with two variables.
  await page.goto(`/c/${slug}/templates/new`);
  await page.getByLabel('Name').fill('shipping_update');
  await page.getByLabel('Language code').fill('en');
  await page.getByLabel('Body').fill('Hi {{1}}, your order {{2}} has shipped.');
  await page.getByLabel('{{1}}').fill('Asha');
  await page.getByLabel('{{2}}').fill('A-1001');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('heading', { name: 'shipping_update', level: 1 })).toBeVisible();
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
    data: { wabaId, name: 'shipping_update', status: 'APPROVED' },
  });
  expect(approved.status()).toBe(200);
  // A template made in WhatsApp Manager with a photo header, which the editor cannot create: sent
  // only through the API, which gives the photo's link (ADR-201).
  const madeElsewhere = await request.post(`${standIn}/__stand-in/template`, {
    data: {
      wabaId,
      template: {
        name: 'delivery_photo',
        language: 'en',
        status: 'APPROVED',
        category: 'UTILITY',
        components: [
          {
            type: 'HEADER',
            format: 'IMAGE',
            example: { header_handle: ['4::aW1hZ2UvanBlZw==:ARZ'] },
          },
          {
            type: 'BODY',
            text: 'Your parcel {{1}} was delivered.',
            example: { body_text: [['A-1001']] },
          },
        ],
      },
    },
  });
  expect(madeElsewhere.status()).toBe(200);
  await page.goto(`/c/${slug}/templates`);
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Refresh from Meta' }).click();
  await expect(page.getByText(/Refresh requested/)).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 30_000 });

  // A key with four scopes; its token is shown once.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await expect(page.getByText('No API keys yet.')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Order system');
  await page.getByRole('checkbox', { name: /Read templates/ }).check();
  await page
    .getByRole('checkbox', { name: /Create and change contacts and record consent/ })
    .check();
  await page.getByRole('checkbox', { name: /Send utility templates/ }).check();
  await page.getByRole('checkbox', { name: /Read WhatsApp numbers/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const tokenField = page.getByLabel('API key', { exact: true });
  await expect(tokenField).toBeVisible();
  const token = await tokenField.inputValue();
  expect(token).toMatch(/^w360_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/);
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  await expect(tokenField).toHaveCount(0);
  await expect(page.getByText(`${token.slice(0, 17)}_…`)).toBeVisible();
  await page.reload();
  await expect(page.getByText(token)).toHaveCount(0);

  const auth = { Authorization: `Bearer ${token}` };

  // The OpenAPI document needs no key; everything else does.
  const doc = await request.get('/api/v1/openapi.json');
  expect(doc.status()).toBe(200);
  expect(doc.headers()['cache-control']).toBe('public, max-age=300');
  expect((await doc.json()).paths['/messages'].post.operationId).toBe('sendMessage');
  const anonymous = await request.get('/api/v1/templates');
  expect(anonymous.status()).toBe(401);
  expect(anonymous.headers()['www-authenticate']).toBe('Bearer');
  expect((await anonymous.json()).error.code).toBe('unauthenticated');

  const templates = await request.get('/api/v1/templates', { headers: auth });
  expect(templates.status()).toBe(200);
  expect(templates.headers()['cache-control']).toBe('private, no-store');
  expect(templates.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  const listed = (
    (await templates.json()) as {
      data: {
        id: string;
        name: string;
        variables: { header: number; body: number; buttons: number };
        headerMedia: string | null;
      }[];
    }
  ).data;
  const template = listed.find((t) => t.name === 'shipping_update');
  expect(template?.variables).toEqual({ header: 0, body: 2, buttons: 0 });
  expect(template?.headerMedia).toBeNull();
  const photoTemplate = listed.find((t) => t.name === 'delivery_photo');
  expect(photoTemplate).toMatchObject({ variables: { header: 0, body: 1 }, headerMedia: 'image' });

  // Without contacts.read the key cannot list contacts.
  const forbidden = await request.get('/api/v1/contacts', { headers: auth });
  expect(forbidden.status()).toBe(403);
  expect((await forbidden.json()).error.code).toBe('forbidden');

  const waId = randomWaId();
  const contact = await request.post('/api/v1/contacts', {
    headers: auth,
    data: { phone: `+${waId}`, name: 'Asha' },
  });
  expect(contact.status()).toBe(201);
  expect((await contact.json()).data).toMatchObject({ phone: `+${waId}`, source: 'api' });

  const message = {
    to: `+${waId}`,
    templateId: template!.id,
    variables: { body: ['Asha', 'A-1001'] },
  };
  const withoutKey = await request.post('/api/v1/messages', { headers: auth, data: message });
  expect(withoutKey.status()).toBe(400);
  const idempotencyKey = randomUUID();
  const send = () =>
    request.post('/api/v1/messages', {
      headers: { ...auth, 'Idempotency-Key': idempotencyKey },
      data: message,
    });
  const first = await send();
  expect(first.status()).toBe(201);
  const queued = (await first.json()).data as { id: string; status: string; channelId: string };
  expect(queued.status).toBe('queued');
  // It is sent from the company's only number, as GET /channels lists it (ADR-171).
  const numbers = await request.get('/api/v1/channels', { headers: auth });
  expect(numbers.status()).toBe(200);
  expect(((await numbers.json()) as { data: unknown[] }).data).toEqual([
    {
      id: queued.channelId,
      phone: '+91 90000 12345',
      name: 'E2E Traders',
      status: 'active',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    },
  ]);
  const retry = await send();
  expect(retry.status()).toBe(201);
  expect(retry.headers()['idempotent-replayed']).toBe('true');
  expect((await retry.json()).data.id).toBe(queued.id);

  // The worker sends it to WhatsApp once; its status is readable through the API.
  await expect(async () => {
    const status = await request.get(`/api/v1/messages/${queued.id}`, { headers: auth });
    expect((await status.json()).data.status).toBe('accepted');
  }).toPass({ timeout: 30_000 });
  const sent = (await standInRequests(request)).filter(
    (r) => r.path === `/v26.0/${phoneNumberId}/messages` && (r.body as { to?: string }).to === waId,
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]?.body).toMatchObject({
    type: 'template',
    template: {
      name: 'shipping_update',
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Asha' },
            { type: 'text', text: 'A-1001' },
          ],
        },
      ],
    },
  });

  // The template to several numbers in one call (ADR-163): a number whose contact opted out is
  // answered in its place and the others are sent, once per key.
  const optedOutWaId = randomWaId();
  const optedOut = await request.post('/api/v1/contacts', {
    headers: auth,
    data: { phone: `+${optedOutWaId}` },
  });
  expect(optedOut.status()).toBe(201);
  const optedOutId = ((await optedOut.json()) as { data: { id: string } }).data.id;
  const optOut = await request.post(`/api/v1/contacts/${optedOutId}/consent`, {
    headers: auth,
    data: {
      purpose: 'utility',
      action: 'opt_out',
      evidence: 'Asked us by email to stop order updates',
    },
  });
  expect(optOut.status()).toBe(200);
  const manyWaIds = [randomWaId(), randomWaId()];
  const manyKey = randomUUID();
  const sendMany = () =>
    request.post('/api/v1/messages/send-many', {
      headers: { ...auth, 'Idempotency-Key': manyKey },
      data: {
        templateId: template!.id,
        messages: [
          { to: `+${manyWaIds[0]}`, variables: { body: ['Ravi', 'A-1002'] } },
          { to: `+${optedOutWaId}`, variables: { body: ['Mina', 'A-1003'] } },
          { to: `+${manyWaIds[1]}`, variables: { body: ['Dev', 'A-1004'] } },
        ],
      },
    });
  type TemplateSend = {
    to: string;
    message: { id: string; status: string } | null;
    error: { code: string } | null;
  };
  const many = await sendMany();
  expect(many.status()).toBe(200);
  const answers = ((await many.json()) as { data: TemplateSend[] }).data;
  expect(answers.map((a) => [a.to, a.message?.status ?? null, a.error?.code ?? null])).toEqual([
    [`+${manyWaIds[0]}`, 'queued', null],
    [`+${optedOutWaId}`, null, 'precondition_failed'],
    [`+${manyWaIds[1]}`, 'queued', null],
  ]);
  const manyRetry = await sendMany();
  expect(manyRetry.status()).toBe(200);
  expect(manyRetry.headers()['idempotent-replayed']).toBe('true');
  expect(((await manyRetry.json()) as { data: TemplateSend[] }).data).toEqual(answers);
  for (const id of [answers[0]?.message?.id, answers[2]?.message?.id]) {
    await expect(async () => {
      const status = await request.get(`/api/v1/messages/${id}`, { headers: auth });
      expect((await status.json()).data.status).toBe('accepted');
    }).toPass({ timeout: 30_000 });
  }
  const sentMany = (await standInRequests(request))
    .filter((r) => r.path === `/v26.0/${phoneNumberId}/messages`)
    .map((r) => (r.body as { to?: string }).to)
    .filter((to) => to === optedOutWaId || manyWaIds.includes(to ?? ''));
  expect(sentMany.sort()).toEqual([...manyWaIds].sort());

  // The template with a photo header (ADR-201): refused without the photo, by its place; sent with
  // its link, which WhatsApp receives as the header's parameter and the inbox shows.
  const photoWaId = randomWaId();
  const kiran = await request.post('/api/v1/contacts', {
    headers: auth,
    data: { phone: `+${photoWaId}`, name: 'Kiran Photo' },
  });
  expect(kiran.status()).toBe(201);
  const photoLink = 'https://cdn.example.com/deliveries/a-1001.jpg';
  const sendPhoto = (data: Record<string, unknown>) =>
    request.post('/api/v1/messages', {
      headers: { ...auth, 'Idempotency-Key': randomUUID() },
      data: { to: `+${photoWaId}`, templateId: photoTemplate!.id, ...data },
    });
  const withoutPhoto = await sendPhoto({ variables: { body: ['A-1001'] } });
  expect(withoutPhoto.status()).toBe(422);
  expect((await withoutPhoto.json()).error.issues).toEqual([
    {
      path: 'headerMedia',
      message: 'This template has a photo header: give the link to its file.',
    },
  ]);
  const photoSent = await sendPhoto({
    variables: { body: ['A-1001'] },
    headerMedia: { link: photoLink },
  });
  expect(photoSent.status()).toBe(201);
  const photoMessage = (await photoSent.json()).data as { id: string };
  await expect(async () => {
    const status = await request.get(`/api/v1/messages/${photoMessage.id}`, { headers: auth });
    expect((await status.json()).data.status).toBe('accepted');
  }).toPass({ timeout: 30_000 });
  const toKiran = (await standInRequests(request)).filter(
    (r) =>
      r.path === `/v26.0/${phoneNumberId}/messages` && (r.body as { to?: string }).to === photoWaId,
  );
  expect(toKiran.map((r) => r.body)).toEqual([
    expect.objectContaining({
      type: 'template',
      template: expect.objectContaining({
        name: 'delivery_photo',
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { link: photoLink } }] },
          { type: 'body', parameters: [{ type: 'text', text: 'A-1001' }] },
        ],
      }),
    }),
  ]);
  // A template sent through the API leaves its conversation resolved.
  await page.goto(`/c/${slug}/inbox?status=resolved`);
  await page.getByRole('link', { name: /Kiran Photo/ }).click();
  const photoBubble = page
    .getByRole('list', { name: /^Messages with/ })
    .getByRole('listitem')
    .filter({ hasText: 'Your parcel A-1001 was delivered.' });
  await expect(photoBubble.getByRole('link', { name: photoLink })).toBeVisible({
    timeout: 20_000,
  });
  await expect(photoBubble).toContainText('Photo');
  await page.goto(`/c/${slug}/settings/api-keys`);

  // Revoked in settings: the next request is refused.
  await page.getByRole('button', { name: 'Revoke Order system' }).click();
  await page.getByRole('button', { name: 'Revoke key' }).click();
  await expect(page.getByText('Revoked', { exact: true }).first()).toBeVisible();
  const afterRevoke = await request.get('/api/v1/templates', { headers: auth });
  expect(afterRevoke.status()).toBe(401);
});

test('a key answers a customer who wrote, reads the conversation and resolves it, and the inbox shows what came through the API', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('apireply');
  const slug = `apireply-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Rhea Reply', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Reply Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Helpdesk');
  await page.getByRole('checkbox', { name: /Reply with text/ }).check();
  await page.getByRole('checkbox', { name: /Read conversations/ }).check();
  await page.getByRole('checkbox', { name: /Resolve, reopen, assign and add notes/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const auth = { Authorization: `Bearer ${token}` };
  const post = (data: Record<string, unknown>) =>
    request.post('/api/v1/messages', {
      headers: { ...auth, 'Idempotency-Key': randomUUID() },
      data,
    });

  // The customer writes, and the worker brings the message into the inbox.
  const waId = randomWaId();
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, waId, 'Where is my order A-1001?'),
  );
  await page.goto(`/c/${slug}/inbox`);
  const conversation = page.getByRole('link', { name: /Priya Customer/ });
  await expect(conversation).toBeVisible({ timeout: 20_000 });

  // The integration replies with text; a number that never wrote is refused, and so are templates.
  const reply = { type: 'text', to: `+${waId}`, text: 'Order A-1001 ships today.' };
  const sent = await post(reply);
  expect(sent.status()).toBe(201);
  const queued = (await sent.json()).data as {
    id: string;
    type: string;
    status: string;
    contactId: string;
  };
  expect(queued).toMatchObject({ type: 'text', status: 'queued' });
  const stranger = await post({ ...reply, to: `+${randomWaId()}` });
  expect(stranger.status()).toBe(412);
  expect((await stranger.json()).error.reason).toBe('window_closed');
  const template = await post({ to: `+${waId}`, templateId: randomUUID() });
  expect(template.status()).toBe(403);

  // The worker sends it to WhatsApp once.
  await expect(async () => {
    const status = await request.get(`/api/v1/messages/${queued.id}`, { headers: auth });
    expect((await status.json()).data).toMatchObject({ type: 'text', status: 'accepted' });
  }).toPass({ timeout: 30_000 });
  const toCustomer = (await standInRequests(request)).filter(
    (r) =>
      r.path === `/v26.0/${phoneNumberId}/messages` &&
      (r.body as { to?: string } | null)?.to === waId,
  );
  expect(toCustomer.map((r) => r.body)).toEqual([
    expect.objectContaining({
      type: 'text',
      text: { body: 'Order A-1001 ships today.', preview_url: false },
    }),
  ]);

  // The key reads the conversation and its messages, newest first, one page at a time.
  const listed = await request.get('/api/v1/conversations?status=open', { headers: auth });
  expect(listed.status()).toBe(200);
  const conversations = (await listed.json()) as {
    data: { id: string; status: string; channelId: string; serviceWindowEndsAt: string | null }[];
    nextCursor: string | null;
  };
  expect(conversations.data).toHaveLength(1);
  expect(conversations.nextCursor).toBeNull();
  const [open] = conversations.data;
  expect(open).toMatchObject({ status: 'open', assigned: false, contactId: queued.contactId });
  expect(Date.parse(open!.serviceWindowEndsAt ?? '')).toBeGreaterThan(Date.now());
  const one = await request.get(`/api/v1/conversations/${open!.id}`, { headers: auth });
  expect((await one.json()).data).toEqual(open);
  const newest = await request.get(`/api/v1/conversations/${open!.id}/messages?limit=1`, {
    headers: auth,
  });
  const firstPage = (await newest.json()) as {
    data: Record<string, unknown>[];
    nextCursor: string | null;
  };
  expect(firstPage.data).toEqual([
    expect.objectContaining({
      id: queued.id,
      direction: 'outbound',
      type: 'text',
      text: 'Order A-1001 ships today.',
      sentBy: 'api',
      status: 'accepted',
      contentTooLarge: false,
      contactsLeftOut: 0,
    }),
  ]);
  const older = await request.get(
    `/api/v1/conversations/${open!.id}/messages?limit=1&cursor=${firstPage.nextCursor}`,
    { headers: auth },
  );
  const olderPage = (await older.json()) as { data: Record<string, unknown>[] };
  expect(olderPage.data).toEqual([
    expect.objectContaining({
      direction: 'inbound',
      type: 'text',
      text: 'Where is my order A-1001?',
      sentBy: null,
      status: 'received',
      // Nothing was left out of it (ADR-132).
      contentTooLarge: false,
      contactsLeftOut: 0,
    }),
  ]);
  const resolved = await request.get('/api/v1/conversations?status=resolved', { headers: auth });
  expect((await resolved.json()).data).toEqual([]);

  // The feed across every conversation (ADR-088) holds the same messages, newest first, each with
  // the contact and the number.
  const withThread = (m: Record<string, unknown> | undefined) => ({
    ...m,
    contactId: queued.contactId,
    channelId: open!.channelId,
  });
  const feed = await request.get('/api/v1/messages?limit=1', { headers: auth });
  expect(feed.status()).toBe(200);
  const feedPage = (await feed.json()) as {
    data: Record<string, unknown>[];
    nextCursor: string | null;
  };
  expect(feedPage.data).toEqual([withThread(firstPage.data[0])]);
  const feedOlder = await request.get(`/api/v1/messages?limit=1&cursor=${feedPage.nextCursor}`, {
    headers: auth,
  });
  const feedOlderPage = (await feedOlder.json()) as {
    data: Record<string, unknown>[];
    nextCursor: string | null;
  };
  expect(feedOlderPage.data).toEqual([withThread(olderPage.data[0])]);
  expect(feedOlderPage.nextCursor).toBeNull();
  const inboundOnly = await request.get('/api/v1/messages?direction=inbound', { headers: auth });
  expect((await inboundOnly.json()).data).toEqual([withThread(olderPage.data[0])]);

  // Members see the reply in the conversation, marked with the key that sent it.
  await conversation.click();
  const thread = page.getByRole('list', { name: /^Messages with/ });
  await expect(thread.getByText('Order A-1001 ships today.')).toBeVisible({ timeout: 20_000 });
  await expect(thread.getByText('· API (Helpdesk)')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // The integration resolves the conversation and reopens it; the inbox shows each change.
  const setStatus = (status: string) =>
    request.patch(`/api/v1/conversations/${open!.id}`, { headers: auth, data: { status } });
  const doc = await (await request.get('/api/v1/openapi.json')).json();
  expect(doc.paths['/conversations/{id}'].patch.operationId).toBe('updateConversation');
  expect(doc.paths['/messages'].get.operationId).toBe('listMessages');
  const resolvedNow = await setStatus('resolved');
  expect(resolvedNow.status()).toBe(200);
  const resolvedBody = (await resolvedNow.json()).data as Record<string, unknown>;
  expect(resolvedBody).toMatchObject({ id: open!.id, status: 'resolved', unreadCount: 0 });
  // Asking again changes nothing; a status the inbox does not set is refused.
  const again = await setStatus('resolved');
  expect((await again.json()).data).toEqual(resolvedBody);
  expect((await setStatus('pending')).status()).toBe(422);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible();
  const reopened = await setStatus('open');
  expect((await reopened.json()).data).toMatchObject({ status: 'open', resolvedAt: null });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Resolve' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reopen' })).toHaveCount(0);

  // The integration adds an internal note (ADR-084): the team reads it, named as the key's, and
  // WhatsApp never receives it.
  const noteText = 'Ticket #4521 opened in the helpdesk.';
  const noted = await request.post(`/api/v1/conversations/${open!.id}/notes`, {
    headers: { ...auth, 'Idempotency-Key': randomUUID() },
    data: { text: noteText },
  });
  expect(noted.status()).toBe(201);
  expect((await noted.json()).data).toMatchObject({ conversationId: open!.id, text: noteText });
  await page.reload();
  const note = page.getByRole('listitem').filter({ hasText: noteText });
  await expect(note.getByText(/^API \(Helpdesk\) ·/)).toBeVisible();

  // A member adds a note in the inbox, and the key reads both, newest first (ADR-089): the
  // member's without saying which member, its own with its key.
  const noteForm = page.locator('form').filter({ has: page.getByLabel('Internal note') });
  await noteForm.getByLabel('Internal note').fill('Called the courier.');
  await noteForm.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('Called the courier.', { exact: true })).toBeVisible();
  const notes = await request.get(`/api/v1/conversations/${open!.id}/notes`, { headers: auth });
  expect(notes.status()).toBe(200);
  expect(await notes.json()).toEqual({
    data: [
      {
        id: expect.any(String),
        conversationId: open!.id,
        text: 'Called the courier.',
        writtenBy: 'agent',
        apiKeyId: null,
        createdAt: expect.any(String),
      },
      (await noted.json()).data,
    ],
    nextCursor: null,
  });
  const sentToCustomer = (await standInRequests(request)).filter(
    (r) =>
      r.path === `/v26.0/${phoneNumberId}/messages` &&
      (r.body as { to?: string } | null)?.to === waId,
  );
  expect(sentToCustomer).toHaveLength(1);

  // The customer shares a colleague's contact card (ADR-196): the key reads its contacts as
  // WhatsApp gave them, and the inbox shows the person's name and number.
  await sendSignedWebhook(
    request,
    inboundMessages(wabaId, phoneNumberId, waId, [
      {
        type: 'contacts',
        contacts: [
          {
            name: { formatted_name: 'Lucía Gómez', first_name: 'Lucía', last_name: 'Gómez' },
            org: { company: 'Gómez Logistics' },
            phones: [{ phone: '+91 98765 43210', wa_id: '919876543210', type: 'MOBILE' }],
          },
        ],
      },
    ]),
  );
  await expect(async () => {
    const newestCard = await request.get(`/api/v1/conversations/${open!.id}/messages?limit=1`, {
      headers: auth,
    });
    expect((await newestCard.json()).data).toEqual([
      expect.objectContaining({
        direction: 'inbound',
        type: 'contacts',
        text: null,
        contactsLeftOut: 0,
        contacts: [
          {
            name: {
              formattedName: 'Lucía Gómez',
              firstName: 'Lucía',
              lastName: 'Gómez',
              middleName: null,
              prefix: null,
              suffix: null,
            },
            phones: [{ phone: '+91 98765 43210', waId: '919876543210', type: 'MOBILE' }],
            emails: [],
            urls: [],
            addresses: [],
            org: { company: 'Gómez Logistics', department: null, title: null },
            birthday: null,
          },
        ],
      }),
    ]);
  }).toPass({ timeout: 20_000 });
  await page.reload();
  const card = thread.getByRole('listitem').filter({ hasText: 'Shared a contact card' });
  await expect(card).toContainText('Lucía Gómez');
  await expect(card).toContainText('+91 98765 43210');
});

test('a key assigns a conversation to a member and moves it to a team, and the inbox shows both', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('apiassign');
  const slug = `apiassign-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Asha Assign', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Assign Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // Settings → Teams: a team that assigns by hand, with the owner.
  await page.goto(`/c/${slug}/settings/teams`);
  const form = page.locator('form', { has: page.getByRole('button', { name: 'Create team' }) });
  await form.getByLabel('Team name').fill('Returns');
  await form.getByLabel('Asha Assign').check();
  await form.getByRole('button', { name: 'Create team' }).click();
  await expect(page.getByText('Team created.')).toBeVisible();

  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Router');
  await page.getByRole('checkbox', { name: /Read conversations/ }).check();
  await page.getByRole('checkbox', { name: /Resolve, reopen, assign and add notes/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const auth = { Authorization: `Bearer ${token}` };

  const waId = randomWaId();
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, waId, 'I want to return my order.'),
  );
  await page.goto(`/c/${slug}/inbox`);
  const item = page.getByRole('link', { name: /Priya Customer/ });
  await expect(item).toContainText('Unassigned', { timeout: 20_000 });

  // The key reads the members and teams, and finds the conversation nobody has.
  const members = await (await request.get('/api/v1/members', { headers: auth })).json();
  expect(members).toEqual({
    data: [
      {
        id: expect.any(String),
        name: 'Asha Assign',
        available: false,
        teamIds: [expect.any(String)],
      },
    ],
    nextCursor: null,
  });
  const teams = await (await request.get('/api/v1/teams', { headers: auth })).json();
  expect(teams).toEqual({
    data: [{ id: members.data[0].teamIds[0], name: 'Returns', assignment: 'manual' }],
    nextCursor: null,
  });
  const waiting = await (
    await request.get('/api/v1/conversations?assigneeId=none&status=open', { headers: auth })
  ).json();
  expect(waiting.data).toHaveLength(1);
  const [open] = waiting.data as { id: string }[];
  const memberId = members.data[0].id as string;
  const teamId = teams.data[0].id as string;

  // The key gives the conversation to the owner in the team; the inbox shows both.
  const change = (data: Record<string, unknown>) =>
    request.patch(`/api/v1/conversations/${open!.id}`, { headers: auth, data });
  const assigned = await change({ teamId, assigneeId: memberId });
  expect(assigned.status()).toBe(200);
  expect((await assigned.json()).data).toMatchObject({
    id: open!.id,
    assigned: true,
    assigneeId: memberId,
    teamId,
  });
  await page.reload();
  await expect(item).toContainText('Assigned to Asha Assign');
  await expect(item).toContainText('Returns');
  await item.click();
  // The conversation's controls, not the CRM task form or the list's filter beside them.
  const assigneeControl = page
    .getByLabel('Assigned to', { exact: true })
    .filter({ has: page.getByRole('option', { name: 'Unassigned', exact: true }) });
  await expect(assigneeControl).toHaveValue(memberId);
  const teamControl = page
    .getByLabel('Team', { exact: true })
    .and(page.locator('select:not([name="team"])'));
  await expect(teamControl).toHaveValue(teamId);
  await expectNoHorizontalOverflow(page);

  // Someone who cannot be given conversations is refused, naming the field; unassigning shows.
  const refused = await change({ assigneeId: randomUUID() });
  expect(refused.status()).toBe(422);
  expect((await refused.json()).error.issues).toEqual([
    { path: 'assigneeId', message: expect.any(String) },
  ]);
  const unassigned = await change({ assigneeId: null });
  expect((await unassigned.json()).data).toMatchObject({
    assigned: false,
    assigneeId: null,
    teamId,
  });
  await page.reload();
  await expect(assigneeControl).toHaveValue('');
  const doc = await (await request.get('/api/v1/openapi.json')).json();
  expect(doc.paths['/members'].get.operationId).toBe('listMembers');
  expect(doc.paths['/teams'].get.operationId).toBe('listTeams');
});

test('a key assigns and resolves several conversations in one call, all of them or none, and the inbox shows them (ADR-120)', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('apibulk');
  const slug = `apibulk-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Bina Bulk', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Bulk Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Helpdesk sync');
  await page.getByRole('checkbox', { name: /Read conversations/ }).check();
  await page.getByRole('checkbox', { name: /Resolve, reopen, assign and add notes/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const auth = { Authorization: `Bearer ${token}` };

  // Three customers write; nobody has their conversations yet.
  for (const text of ['Where is my parcel?', 'Can I change my size?', 'Is the shop open?']) {
    await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, randomWaId(), text));
  }
  await page.goto(`/c/${slug}/inbox`);
  const items = page.getByRole('link', { name: /Priya Customer/ });
  await expect(items).toHaveCount(3, { timeout: 20_000 });
  const waiting = await (
    await request.get('/api/v1/conversations?assigneeId=none&status=open', { headers: auth })
  ).json();
  const ids = (waiting.data as { id: string }[]).map((v) => v.id);
  expect(ids).toHaveLength(3);
  const memberId = (await (await request.get('/api/v1/members', { headers: auth })).json()).data[0]
    .id as string;
  const updateMany = (data: Record<string, unknown>) =>
    request.post('/api/v1/conversations/update-many', { headers: auth, data });

  // One id that is no conversation of the company refuses the whole call, naming it.
  const refused = await updateMany({
    conversationIds: [ids[0], ids[1], randomUUID()],
    assigneeId: memberId,
  });
  expect(refused.status()).toBe(422);
  expect((await refused.json()).error.issues).toEqual([
    { path: 'conversationIds.2', message: expect.any(String) },
  ]);
  const stillWaiting = await (
    await request.get('/api/v1/conversations?assigneeId=none&status=open', { headers: auth })
  ).json();
  expect(stillWaiting.data).toHaveLength(3);

  // All three given to the owner at once, answered in the order given; the inbox shows them.
  const reversed = [...ids].reverse();
  const assigned = await updateMany({ conversationIds: reversed, assigneeId: memberId });
  expect(assigned.status()).toBe(200);
  expect(
    ((await assigned.json()).data as { id: string; assigneeId: string | null }[]).map((v) => [
      v.id,
      v.assigneeId,
    ]),
  ).toEqual(reversed.map((id) => [id, memberId]));
  await page.reload();
  for (let i = 0; i < 3; i++) await expect(items.nth(i)).toContainText('Assigned to Bina Bulk');
  await expectNoHorizontalOverflow(page);

  // Then resolved together.
  const resolved = await updateMany({ conversationIds: ids, status: 'resolved' });
  expect(((await resolved.json()).data as { status: string }[]).map((v) => v.status)).toEqual([
    'resolved',
    'resolved',
    'resolved',
  ]);
  const open = await (
    await request.get('/api/v1/conversations?status=open', { headers: auth })
  ).json();
  expect(open.data).toEqual([]);

  // Reopened and unassigned by a filter, two at a time; the second page is the last (ADR-166).
  const updateMatching = (data: Record<string, unknown>) =>
    request.post('/api/v1/conversations/update-matching', { headers: auth, data });
  const unfiltered = await updateMatching({ filter: {}, change: { status: 'resolved' } });
  expect(unfiltered.status()).toBe(422);
  expect((await unfiltered.json()).error.issues).toEqual([
    { path: 'filter', message: expect.any(String) },
  ]);
  const owners = {
    filter: { status: 'resolved', assigneeId: memberId },
    change: { status: 'open', assigneeId: null },
    limit: 2,
  };
  const firstPage = await updateMatching(owners);
  expect(firstPage.status()).toBe(200);
  const first = (await firstPage.json()) as {
    data: { id: string; status: string; assigneeId: string | null }[];
    nextCursor: string | null;
  };
  expect(first.data.map((v) => [v.status, v.assigneeId])).toEqual([
    ['open', null],
    ['open', null],
  ]);
  expect(first.nextCursor).toEqual(expect.any(String));
  const second = (await (await updateMatching({ ...owners, cursor: first.nextCursor })).json()) as {
    data: { id: string }[];
    nextCursor: string | null;
  };
  expect(second.nextCursor).toBeNull();
  expect([...first.data, ...second.data].map((v) => v.id).sort()).toEqual([...ids].sort());
  const waitingAgain = await (
    await request.get('/api/v1/conversations?assigneeId=none&status=open', { headers: auth })
  ).json();
  expect(waitingAgain.data).toHaveLength(3);
  await page.reload();
  await expect(items).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(items.nth(i)).not.toContainText('Assigned to');

  const doc = await (await request.get('/api/v1/openapi.json')).json();
  expect(doc.paths['/conversations/update-many'].post.operationId).toBe('updateManyConversations');
  expect(doc.paths['/conversations/update-matching'].post.operationId).toBe(
    'updateMatchingConversations',
  );
});

test('a key tags conversations and lists them by tag, and the inbox shows the tags (ADR-221)', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('apitags');
  const slug = `apitags-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Tanu Tags', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Tag Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Helpdesk tags');
  await page.getByRole('checkbox', { name: /Read conversations/ }).check();
  await page.getByRole('checkbox', { name: /Resolve, reopen, assign and add notes/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const auth = { Authorization: `Bearer ${token}` };

  for (const text of ['My refund is late', 'Do you ship abroad?']) {
    await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, randomWaId(), text));
  }
  await page.goto(`/c/${slug}/inbox`);
  const items = page.getByRole('link', { name: /Priya Customer/ });
  await expect(items).toHaveCount(2, { timeout: 20_000 });
  const listed = (await (await request.get('/api/v1/conversations', { headers: auth })).json())
    .data as { id: string; tags: string[] }[];
  expect(listed.map((c) => c.tags)).toEqual([[], []]);
  const [newest, oldest] = listed.map((c) => c.id) as [string, string];

  // Written as members write tags; never added and removed at once.
  const patch = (id: string, data: Record<string, unknown>) =>
    request.patch(`/api/v1/conversations/${id}`, { headers: auth, data });
  const tagged = await patch(oldest, { addTags: ['Refund', 'VIP', 'refund'] });
  expect(tagged.status()).toBe(200);
  expect((await tagged.json()).data.tags).toEqual(['refund', 'vip']);
  const both = await patch(oldest, { addTags: ['vip'], removeTags: ['VIP'] });
  expect(both.status()).toBe(422);
  expect((await both.json()).error.issues).toEqual([
    { path: 'removeTags', message: 'The tag vip cannot be both added and removed.' },
  ]);

  // Both tagged in one call, then listed by a tag.
  const many = await request.post('/api/v1/conversations/update-many', {
    headers: auth,
    data: { conversationIds: [newest, oldest], addTags: ['follow up'] },
  });
  expect(((await many.json()).data as { tags: string[] }[]).map((c) => c.tags)).toEqual([
    ['follow up'],
    ['follow up', 'refund', 'vip'],
  ]);
  const vip = (await (await request.get('/api/v1/conversations?tag=VIP', { headers: auth })).json())
    .data as { id: string }[];
  expect(vip.map((c) => c.id)).toEqual([oldest]);
  const badTag = await request.get('/api/v1/conversations?tag=a%2Cb', { headers: auth });
  expect(badTag.status()).toBe(422);

  // The tag taken off every conversation that has it, by a filter.
  const matching = await request.post('/api/v1/conversations/update-matching', {
    headers: auth,
    data: { filter: { tag: 'follow up' }, change: { removeTags: ['follow up'] } },
  });
  expect(matching.status()).toBe(200);
  expect(((await matching.json()).data as { tags: string[] }[]).map((c) => c.tags)).toEqual([
    [],
    ['refund', 'vip'],
  ]);

  // The inbox shows the tags the key put on, and filters by them. The key's changes refresh the
  // live inbox, so the list is loaded again if a refresh interrupts the load (see openFromNav).
  await expect(async () => {
    await page.goto(`/c/${slug}/inbox?view=all&status=open&tag=vip`);
    await expect(items).toHaveCount(1, { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await expect(items.first()).toContainText('refund');
  await expect(items.first()).toContainText('vip');

  const doc = await (await request.get('/api/v1/openapi.json')).json();
  expect(doc.components.schemas.Conversation.required).toContain('tags');
  expect(JSON.stringify(doc)).not.toMatch(/ADR-\d/);
});

test('a key sends reply buttons and a list to a customer who wrote: the inbox shows them, and a picked row comes back through the API', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('apilist');
  const slug = `apilist-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Lata List', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Sunrise Clinic');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  await page.goto(`/c/${slug}/settings/api-keys`);
  await expect(
    page.getByText(/replies \(text, buttons, lists, products\s+and reactions/),
  ).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Booking');
  await page
    .getByRole('checkbox', {
      name: /Reply with text, media and other messages/,
    })
    .check();
  await page.getByRole('checkbox', { name: /Read conversations/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const auth = { Authorization: `Bearer ${token}` };
  const post = (data: Record<string, unknown>) =>
    request.post('/api/v1/messages', {
      headers: { ...auth, 'Idempotency-Key': randomUUID() },
      data,
    });

  const waId = randomWaId();
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, waId, 'Can I move my appointment?'),
  );
  await page.goto(`/c/${slug}/inbox`);
  const conversation = page.getByRole('link', { name: /Priya Customer/ });
  await expect(conversation).toBeVisible({ timeout: 20_000 });

  // The booking system answers with buttons, then with a list of times.
  const buttons = await post({
    type: 'buttons',
    to: `+${waId}`,
    body: 'Your appointment is tomorrow at 10:00. Keep it?',
    buttons: [
      { id: 'appt-9:keep', title: 'Keep it' },
      { id: 'appt-9:move', title: 'Move it' },
    ],
  });
  expect(buttons.status()).toBe(201);
  const list = await post({
    type: 'list',
    to: `+${waId}`,
    header: 'New time',
    body: 'Pick a time that suits you.',
    button: 'See times',
    sections: [
      {
        title: 'Tomorrow',
        rows: [
          { id: 'slot-11', title: '11:00', description: 'Dr Rao' },
          { id: 'slot-15', title: '15:00', description: 'Dr Iyer' },
        ],
      },
    ],
  });
  expect(list.status()).toBe(201);
  const listId = ((await list.json()).data as { id: string; type: string }).id;
  // HyFib's own ids are refused.
  const reserved = await post({
    type: 'buttons',
    to: `+${waId}`,
    body: 'How did we do?',
    buttons: [{ id: 'w360csat:x', title: 'Great' }],
  });
  expect(reserved.status()).toBe(422);

  // The worker sends both, in either order; the Graph stand-in checks them against Meta's limits.
  let sent: Awaited<ReturnType<typeof standInRequests>> = [];
  await expect(async () => {
    sent = (await standInRequests(request)).filter(
      (r) =>
        r.path === `/v26.0/${phoneNumberId}/messages` && (r.body as { to?: string }).to === waId,
    );
    expect(sent).toHaveLength(2);
  }).toPass({ timeout: 30_000 });
  const kind = (r: (typeof sent)[number]) =>
    (r.body as { interactive: { type: string } }).interactive;
  expect(sent.map((r) => kind(r).type).sort()).toEqual(['button', 'list']);
  const sentList = sent.find((r) => kind(r).type === 'list');
  expect(kind(sentList!)).toEqual({
    type: 'list',
    header: { type: 'text', text: 'New time' },
    body: { text: 'Pick a time that suits you.' },
    action: {
      button: 'See times',
      sections: [
        {
          title: 'Tomorrow',
          rows: [
            { id: 'slot-11', title: '11:00', description: 'Dr Rao' },
            { id: 'slot-15', title: '15:00', description: 'Dr Iyer' },
          ],
        },
      ],
    },
  });
  await expect(async () => {
    const status = await request.get(`/api/v1/messages/${listId}`, { headers: auth });
    expect((await status.json()).data).toMatchObject({ type: 'interactive', status: 'accepted' });
  }).toPass({ timeout: 30_000 });

  // Members see what the key sent.
  await page.reload();
  await page.getByRole('link', { name: /Priya Customer/ }).click();
  await expect(page.getByText('Buttons: Keep it · Move it')).toBeVisible();
  await expect(page.getByText('List: See times')).toBeVisible();
  await expect(page.getByText('11:00 · Dr Rao')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // The customer picks 15:00: the key reads the tap with the row's id, kind and description.
  await sendSignedWebhook(
    request,
    listReply(
      wabaId,
      phoneNumberId,
      waId,
      { id: 'slot-15', title: '15:00', description: 'Dr Iyer' },
      String(sentList?.wamid),
    ),
  );
  const listed = await request.get('/api/v1/conversations', { headers: auth });
  const [open] = ((await listed.json()) as { data: { id: string }[] }).data;
  await expect(async () => {
    const newest = await request.get(`/api/v1/conversations/${open!.id}/messages?limit=1`, {
      headers: auth,
    });
    expect((await newest.json()).data).toEqual([
      expect.objectContaining({
        direction: 'inbound',
        type: 'interactive',
        text: '15:00',
        reply: { id: 'slot-15', title: '15:00', type: 'list', description: 'Dr Iyer' },
      }),
    ]);
  }).toPass({ timeout: 20_000 });
});

test('a key quotes a customer’s message and reacts to it: the inbox shows both, and the customer’s reaction names the reply', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('apiquote');
  const slug = `apiquote-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Quinn Quote', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Harbour Dental');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Front desk');
  await page
    .getByRole('checkbox', {
      name: /Reply with text, media and other messages/,
    })
    .check();
  await page.getByRole('checkbox', { name: /Read conversations/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const auth = { Authorization: `Bearer ${token}` };
  const post = (data: Record<string, unknown>) =>
    request.post('/api/v1/messages', {
      headers: { ...auth, 'Idempotency-Key': randomUUID() },
      data,
    });

  const waId = randomWaId();
  const questionWamid = `wamid.e2e.${randomUUID()}`;
  const question = inboundMessage(
    wabaId,
    phoneNumberId,
    waId,
    'Can I come on Thursday instead?',
    new Date(),
    questionWamid,
  );
  await sendSignedWebhook(request, question);

  // The key finds the question in the conversation.
  let conversationId = '';
  let asked = '';
  await expect(async () => {
    const listed = await request.get('/api/v1/conversations', { headers: auth });
    const [conversation] = ((await listed.json()) as { data: { id: string }[] }).data;
    conversationId = conversation!.id;
    const messages = await request.get(`/api/v1/conversations/${conversationId}/messages`, {
      headers: auth,
    });
    const [newest] = ((await messages.json()) as { data: { id: string; text: string }[] }).data;
    expect(newest?.text).toBe('Can I come on Thursday instead?');
    asked = newest!.id;
  }).toPass({ timeout: 20_000 });

  // The front desk answers quoting it and reacts to it; a word is not an emoji.
  const quoted = await post({
    type: 'text',
    to: `+${waId}`,
    text: 'Thursday at 11:00 works.',
    replyTo: asked,
  });
  expect(quoted.status()).toBe(201);
  const quotedId = ((await quoted.json()).data as { id: string }).id;
  const reacted = await post({ type: 'reaction', to: `+${waId}`, replyTo: asked, emoji: '👍' });
  expect(reacted.status()).toBe(201);
  expect((await reacted.json()).data).toMatchObject({ type: 'reaction', status: 'queued' });
  const word = await post({ type: 'reaction', to: `+${waId}`, replyTo: asked, emoji: 'ok' });
  expect(word.status()).toBe(422);
  // And it sends the clinic's leaflet from a link, with a caption (ADR-194); a plain http link is
  // refused.
  const leafletLink = 'https://cdn.example.com/harbour-dental/leaflet.pdf';
  const leaflet = await post({
    type: 'document',
    to: `+${waId}`,
    link: leafletLink,
    caption: 'Before your visit',
  });
  expect(leaflet.status()).toBe(201);
  expect((await leaflet.json()).data).toMatchObject({ type: 'document', status: 'queued' });
  const insecure = await post({
    type: 'image',
    to: `+${waId}`,
    link: 'http://cdn.example.com/harbour-dental/map.png',
  });
  expect(insecure.status()).toBe(422);
  // And where the clinic is (ADR-195); a latitude past the pole is refused.
  const where = await post({
    type: 'location',
    to: `+${waId}`,
    latitude: 18.5204,
    longitude: 73.8567,
    name: 'Harbour Dental Clinic',
    address: '12 Harbour Road, Pune',
  });
  expect(where.status()).toBe(201);
  expect((await where.json()).data).toMatchObject({ type: 'location', status: 'queued' });
  const pole = await post({ type: 'location', to: `+${waId}`, latitude: 91, longitude: 0 });
  expect(pole.status()).toBe(422);
  // And the dentist's contact card (ADR-197); a card with only a formatted name is refused.
  const rao = {
    name: { formattedName: 'Dr Meera Rao', firstName: 'Meera', lastName: 'Rao', prefix: 'Dr' },
    phones: [{ phone: '+91 98200 12345', type: 'WORK' }],
  };
  const shared = await post({ type: 'contacts', to: `+${waId}`, contacts: [rao] });
  expect(shared.status()).toBe(201);
  expect((await shared.json()).data).toMatchObject({ type: 'contacts', status: 'queued' });
  const bare = await post({
    type: 'contacts',
    to: `+${waId}`,
    contacts: [{ name: { formattedName: 'Dr Meera Rao' } }],
  });
  expect(bare.status()).toBe(422);
  // And a thank-you sticker from a link (ADR-198); a caption on it is refused.
  const stickerLink = 'https://cdn.example.com/harbour-dental/thanks.webp';
  const sticker = await post({ type: 'sticker', to: `+${waId}`, link: stickerLink });
  expect(sticker.status()).toBe(201);
  const captioned = await post({
    type: 'sticker',
    to: `+${waId}`,
    link: stickerLink,
    caption: 'Thanks!',
  });
  expect(captioned.status()).toBe(422);

  // The worker sends all six, in any order, as Meta's spec describes them.
  let sent: Awaited<ReturnType<typeof standInRequests>> = [];
  await expect(async () => {
    sent = (await standInRequests(request)).filter(
      (r) =>
        r.path === `/v26.0/${phoneNumberId}/messages` && (r.body as { to?: string }).to === waId,
    );
    expect(sent).toHaveLength(6);
  }).toPass({ timeout: 30_000 });
  const ofType = (type: string) => sent.find((r) => (r.body as { type: string }).type === type);
  expect(ofType('document')?.body).toMatchObject({
    document: { link: leafletLink, caption: 'Before your visit' },
  });
  expect(ofType('sticker')?.body).toMatchObject({ sticker: { link: stickerLink } });
  expect(ofType('contacts')?.body).toMatchObject({
    contacts: [
      {
        name: {
          formatted_name: 'Dr Meera Rao',
          first_name: 'Meera',
          last_name: 'Rao',
          prefix: 'Dr',
        },
        phones: [{ phone: '+91 98200 12345', type: 'WORK' }],
      },
    ],
  });
  expect(ofType('location')?.body).toMatchObject({
    location: {
      latitude: '18.5204',
      longitude: '73.8567',
      name: 'Harbour Dental Clinic',
      address: '12 Harbour Road, Pune',
    },
  });
  expect(ofType('text')?.body).toMatchObject({
    context: { message_id: questionWamid },
    text: { body: 'Thursday at 11:00 works.' },
  });
  expect(ofType('reaction')?.body).toMatchObject({
    reaction: { message_id: questionWamid, emoji: '👍' },
  });

  // Members see the quote above the reply, and what the reaction is for.
  await page.goto(`/c/${slug}/inbox`);
  await page.getByRole('link', { name: /Priya Customer/ }).click();
  const thread = page.getByRole('list', { name: /Messages with/ }).getByRole('listitem');
  const reply = thread.filter({ hasText: 'Thursday at 11:00 works.' });
  await expect(reply.getByText('Can I come on Thursday instead?')).toBeVisible();
  await expect(thread.filter({ hasText: 'Reacted 👍' })).toContainText(
    'to “Can I come on Thursday instead?”',
  );
  // The leaflet shows its caption and the link it was sent from.
  const sentLeaflet = thread.filter({ hasText: 'Before your visit' });
  await expect(sentLeaflet.getByRole('link', { name: leafletLink })).toHaveAttribute(
    'href',
    leafletLink,
  );
  await expect(sentLeaflet).not.toContainText('Media download is not available yet.');
  // The location shows the place, its address and its coordinates.
  const sentPlace = thread.filter({ hasText: '12 Harbour Road, Pune' });
  await expect(sentPlace).toContainText('Location · Harbour Dental Clinic');
  await expect(sentPlace).toContainText('18.5204, 73.8567');
  // The sticker shows the link it was sent from.
  await expect(thread.getByRole('link', { name: stickerLink })).toHaveAttribute(
    'href',
    stickerLink,
  );
  // The contact card shows the dentist's name and number.
  const sentCard = thread.filter({ hasText: 'Shared a contact card' });
  await expect(sentCard).toContainText('Dr Meera Rao');
  await expect(sentCard).toContainText('+91 98200 12345');
  await expectNoHorizontalOverflow(page);

  // The customer reacts to the reply: the key reads which message the reaction is for.
  await sendSignedWebhook(
    request,
    reactionMessage(wabaId, phoneNumberId, waId, '🙏', String(ofType('text')?.wamid)),
  );
  await expect(async () => {
    const newest = await request.get(`/api/v1/conversations/${conversationId}/messages?limit=1`, {
      headers: auth,
    });
    expect((await newest.json()).data).toEqual([
      expect.objectContaining({
        direction: 'inbound',
        type: 'reaction',
        text: '🙏',
        replyTo: quotedId,
      }),
    ]);
  }).toPass({ timeout: 20_000 });
  // The conversation refreshes itself, so it is left through the navigation and opened again, not
  // reloaded (see openFromNav; `page.reload` was aborted here in Firefox on 2e85734).
  await openFromNav(page, 'Inbox');
  await expect(page).toHaveURL(new RegExp(`/c/${slug}/inbox$`));
  await page.getByRole('link', { name: /Priya Customer/ }).click({ timeout: 20_000 });
  await expect(thread.filter({ hasText: 'Reacted 🙏' })).toContainText(
    'to “Thursday at 11:00 works.”',
  );
});

test('a key starts an automation made to start through the API: its template goes to a contact who never wrote, and the tap continues it', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const email = uniqueEmail('apiflow');
  const slug = `apiflow-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Dev Clinic', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Cora Clinic');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // An approved utility template with two variables and two quick replies.
  await page.goto(`/c/${slug}/templates/new`);
  await page.getByLabel('Name').fill('appointment_reminder');
  await page.getByLabel('Language code').fill('en');
  await page.getByLabel('Category').selectOption('UTILITY');
  await page.getByLabel('Body').fill('Hi {{1}}, your appointment is at {{2}}.');
  await page.getByLabel('{{1}}').fill('Asha');
  await page.getByLabel('{{2}}').fill('5 pm');
  for (const [i, text] of ['Confirm', 'Reschedule'].entries()) {
    await page.getByRole('button', { name: 'Add quick reply' }).click();
    await page.getByLabel('Quick reply text').nth(i).fill(text);
  }
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('heading', { name: 'appointment_reminder', level: 1 })).toBeVisible();
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
    data: { wabaId, name: 'appointment_reminder', status: 'APPROVED' },
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

  // The automation: started through the API with two inputs, from the company's number. It asks
  // with the template first (only templates reach a contact who has not written) and thanks the
  // contact who taps "Confirm".
  await openFromNav(page, 'Automations');
  await page.getByLabel('Name', { exact: true }).fill('Appointment reminder');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Appointment reminder' })).toBeVisible();
  const automationId = page.url().split('/').at(-1) ?? '';
  expect(automationId).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByLabel('Start when').selectOption('api');
  await page.getByLabel('Inputs').fill('patient, appointment_time');
  await expect(
    page.getByText(
      'An automation started through the API sends from one WhatsApp number: choose it.',
    ),
  ).toBeVisible();
  await page.getByLabel('WhatsApp number').selectOption({ index: 1 });
  await page.getByLabel('Add a step').selectOption('ask_template');
  await page.getByRole('button', { name: 'Add step' }).click();
  await expect(page.locator('#step-ask-template-1-template')).toHaveValue(/[0-9a-f-]{36}/);
  await page.locator('#step-ask-template-1-body-0').fill('{{input.patient}}');
  await page.locator('#step-ask-template-1-body-1').fill('{{input.appointment_time}}');
  await page.getByLabel('First step', { exact: true }).selectOption('ask-template-1');
  await page.getByRole('button', { name: 'Delete step welcome' }).click();
  await page.getByLabel('Add a step').selectOption('send_text');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page
    .locator('#step-send-text-1-text')
    .fill('Thanks {{input.patient}}, see you at {{input.appointment_time}}.');
  await page.locator('#step-ask-template-1-button-0').selectOption('send-text-1');
  await expect(page.getByText(/to fix before publishing/)).toBeHidden();
  await expectNoHorizontalOverflow(page);
  // The simulator gives each input a sample value and offers the template's quick replies.
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(
    page.getByText('Hi sample patient, your appointment is at sample appointment_time.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(
    page.getByText('Thanks sample patient, see you at sample appointment_time.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/Version 1 is live/)).toBeVisible();
  await expect(page.getByText('Start through the API', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Automation id')).toHaveValue(automationId);

  // A key with the "Start automations" scope.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Booking system');
  await page.getByRole('checkbox', { name: /Start automations/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const auth = { Authorization: `Bearer ${token}` };

  const listed = await request.get('/api/v1/automations', { headers: auth });
  expect(listed.status()).toBe(200);
  expect((await listed.json()).data).toEqual([
    expect.objectContaining({
      id: automationId,
      name: 'Appointment reminder',
      status: 'active',
      inputs: ['patient', 'appointment_time'],
    }),
  ]);

  // The booking system starts it for a number that never wrote, once per Idempotency-Key.
  const waId = randomWaId();
  const idempotencyKey = randomUUID();
  const start = (inputs: Record<string, string>, key = idempotencyKey) =>
    request.post(`/api/v1/automations/${automationId}/runs`, {
      headers: { ...auth, 'Idempotency-Key': key },
      data: { to: `+${waId}`, inputs },
    });
  const missing = await start({ patient: 'Asha' }, randomUUID());
  expect(missing.status()).toBe(422);
  const first = await start({ patient: 'Asha', appointment_time: '5 pm today' });
  expect(first.status()).toBe(201);
  const run = (await first.json()).data as { id: string; status: string };
  expect(run.status).toBe('running');
  const retry = await start({ patient: 'Asha', appointment_time: '5 pm today' });
  expect(retry.headers()['idempotent-replayed']).toBe('true');
  expect((await retry.json()).data.id).toBe(run.id);
  // Another start for the same contact while the run works is refused.
  const busy = await start({ patient: 'Asha', appointment_time: '6 pm' }, randomUUID());
  expect(busy.status()).toBe(409);
  expect((await busy.json()).error.reason).toBe('automation_busy');

  // The worker sends the template with the inputs and a payload per quick reply.
  let sent: { wamid?: string; body: unknown } | undefined;
  await expect(async () => {
    sent = (await standInRequests(request)).find(
      (r) =>
        r.path === `/v26.0/${phoneNumberId}/messages` && (r.body as { to?: string }).to === waId,
    );
    expect(sent?.wamid).toBeTruthy();
  }).toPass({ timeout: 60_000 });
  const template = (sent?.body as { template: { name: string; components: unknown[] } }).template;
  expect(template.name).toBe('appointment_reminder');
  expect(template.components).toContainEqual({
    type: 'body',
    parameters: [
      { type: 'text', text: 'Asha' },
      { type: 'text', text: '5 pm today' },
    ],
  });
  const buttons = template.components.filter((c) => (c as { type: string }).type === 'button') as {
    parameters: { payload: string }[];
  }[];
  const confirm = buttons[0]?.parameters[0]?.payload ?? '';
  expect(confirm).toBe(`w360bot:${run.id}:ask-template-1:1:0`);

  // The contact taps "Confirm": the automation thanks them, and the run completes.
  await sendSignedWebhook(
    request,
    templateButtonReply(
      wabaId,
      phoneNumberId,
      waId,
      { payload: confirm, text: 'Confirm' },
      String(sent?.wamid),
    ),
  );
  await expect
    .poll(
      async () =>
        (await standInRequests(request))
          .filter((r) => (r.body as { to?: string } | null | undefined)?.to === waId)
          .map((r) => (r.body as { text?: { body?: string } }).text?.body ?? null)
          .filter(Boolean),
      { timeout: 60_000 },
    )
    .toEqual(['Thanks Asha, see you at 5 pm today.']);
  await expect(async () => {
    const read = await request.get(`/api/v1/automation-runs/${run.id}`, { headers: auth });
    expect((await read.json()).data).toMatchObject({ status: 'completed', endReason: 'no_next' });
  }).toPass({ timeout: 30_000 });

  // The run page names the key that started it and lists the inputs with the answers.
  await page.goto(`/c/${slug}/automations/runs/${run.id}`);
  await expect(page.getByRole('heading', { name: 'Run of Appointment reminder' })).toBeVisible();
  await expect(page.getByText(/by the API key “Booking system”/)).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Got an answer → Confirm');
  await expect(page.getByText('input.appointment_time', { exact: true })).toBeVisible();
  await expect(page.getByText('5 pm today', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // The booking system stops another run it started while its template waits for an answer
  // (ADR-079); a retry answers the same, and the run page says how it ended.
  const second = randomWaId();
  const started = await request.post(`/api/v1/automations/${automationId}/runs`, {
    headers: { ...auth, 'Idempotency-Key': randomUUID() },
    data: { to: `+${second}`, inputs: { patient: 'Ravi', appointment_time: '6 pm' } },
  });
  expect(started.status()).toBe(201);
  const other = (await started.json()).data as { id: string };
  await expect(async () => {
    const read = await request.get(`/api/v1/automation-runs/${other.id}`, { headers: auth });
    expect((await read.json()).data.status).toBe('waiting');
  }).toPass({ timeout: 60_000 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stopped = await request.post(`/api/v1/automation-runs/${other.id}/stop`, {
      headers: auth,
    });
    expect(stopped.status()).toBe(200);
    expect((await stopped.json()).data).toMatchObject({
      id: other.id,
      status: 'stopped',
      endReason: 'stopped_by_api',
    });
  }
  await page.goto(`/c/${slug}/automations/runs/${other.id}`);
  await expect(
    page.getByRole('paragraph').filter({ hasText: 'Stopped through the API.' }),
  ).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Stopped through the API.');

  // It starts the automation for two more contacts in one call (ADR-161), once per
  // Idempotency-Key; in a later call a contact a run already handles is answered in its place
  // while the other starts, and each run sends the template with its own inputs.
  const [third, fourth, fifth] = [randomWaId(), randomWaId(), randomWaId()];
  const startMany = (patients: [string, string][], key: string) =>
    request.post(`/api/v1/automations/${automationId}/runs/start-many`, {
      headers: { ...auth, 'Idempotency-Key': key },
      data: {
        runs: patients.map(([to, patient]) => ({
          to: `+${to}`,
          inputs: { patient, appointment_time: '7 pm' },
        })),
      },
    });
  const startedRun = expect.objectContaining({ automationId, status: 'running' });
  const manyKey = randomUUID();
  const firstMany: [string, string][] = [
    [third, 'Meera'],
    [fourth, 'Kiran'],
  ];
  const many = await startMany(firstMany, manyKey);
  expect(many.status()).toBe(200);
  type RunStart = { to: string; run: { id: string } | null; error: unknown };
  const manyStarts = (await many.json()).data as RunStart[];
  expect(manyStarts).toEqual([
    { to: `+${third}`, run: startedRun, error: null },
    { to: `+${fourth}`, run: startedRun, error: null },
  ]);
  const manyRetry = await startMany(firstMany, manyKey);
  expect(manyRetry.headers()['idempotent-replayed']).toBe('true');
  expect((await manyRetry.json()).data).toEqual(manyStarts);
  const later = await startMany(
    [
      [fourth, 'Kiran'],
      [fifth, 'Farah'],
    ],
    randomUUID(),
  );
  expect(later.status()).toBe(200);
  const laterStarts = (await later.json()).data as RunStart[];
  expect(laterStarts).toEqual([
    {
      to: `+${fourth}`,
      run: null,
      error: expect.objectContaining({ code: 'conflict', reason: 'automation_busy' }),
    },
    { to: `+${fifth}`, run: startedRun, error: null },
  ]);
  await expect
    .poll(
      async () =>
        (await standInRequests(request))
          .filter((r) => r.path === `/v26.0/${phoneNumberId}/messages`)
          .map(
            (r) =>
              r.body as {
                to?: string;
                template?: { components: { type: string; parameters?: { text?: string }[] }[] };
              } | null,
          )
          .filter((b) => [third, fourth, fifth].includes(b?.to ?? ''))
          .map((b) => {
            const body = b?.template?.components.find((c) => c.type === 'body');
            return `${b?.to}: ${body?.parameters?.[0]?.text}`;
          })
          .sort(),
      { timeout: 60_000 },
    )
    .toEqual([`${third}: Meera`, `${fourth}: Kiran`, `${fifth}: Farah`].sort());

  // It stops the runs it started for Meera and Farah in one call (ADR-162); a retry answers the
  // same.
  const stopIds = [manyStarts[0]?.run?.id ?? '', laterStarts[1]?.run?.id ?? ''];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stoppedMany = await request.post('/api/v1/automation-runs/stop-many', {
      headers: auth,
      data: { runIds: stopIds },
    });
    expect(stoppedMany.status()).toBe(200);
    expect((await stoppedMany.json()).data).toEqual(
      stopIds.map((id) =>
        expect.objectContaining({ id, status: 'stopped', endReason: 'stopped_by_api' }),
      ),
    );
  }
});

test('a key downloads the document a customer sent, as WhatsApp gave it (ADR-217)', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('apifiles');
  const slug = `apifiles-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Fara Files', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('File Readers');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Document reader');
  await page.getByRole('checkbox', { name: /Read conversations/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const auth = { Authorization: `Bearer ${token}` };

  // The customer sends a document; WhatsApp keeps the file.
  const fileId = newMediaId();
  const invoice = Buffer.from('%PDF-1.4 invoice 2026-10');
  await setStandInMedia(request, { id: fileId, mimeType: 'application/pdf', bytes: invoice });
  await sendSignedWebhook(
    request,
    inboundMessages(wabaId, phoneNumberId, randomWaId(), [
      {
        type: 'document',
        document: { id: fileId, mime_type: 'application/pdf', filename: 'Invoice October.pdf' },
      },
    ]),
  );
  let messageId = '';
  await expect(async () => {
    const listed = await request.get('/api/v1/conversations', { headers: auth });
    const [conversation] = ((await listed.json()) as { data: { id: string }[] }).data;
    expect(conversation).toBeDefined();
    const thread = await request.get(`/api/v1/conversations/${conversation!.id}/messages`, {
      headers: auth,
    });
    const [message] = ((await thread.json()) as { data: Record<string, unknown>[] }).data;
    expect(message).toMatchObject({
      direction: 'inbound',
      type: 'document',
      mimeType: 'application/pdf',
    });
    messageId = message!.id as string;
  }).toPass({ timeout: 30_000 });

  // The file itself, with its type and name.
  const file = await request.get(`/api/v1/messages/${messageId}/media`, { headers: auth });
  expect(file.status()).toBe(200);
  expect(file.headers()['content-type']).toBe('application/pdf');
  expect(file.headers()['content-disposition']).toBe(
    `attachment; filename="Invoice October.pdf"; filename*=UTF-8''Invoice%20October.pdf`,
  );
  expect(file.headers()['x-content-type-options']).toBe('nosniff');
  expect((await file.body()).equals(invoice)).toBe(true);
  // Without a key, and for a message without a file, the API answers in JSON.
  expect((await request.get(`/api/v1/messages/${messageId}/media`)).status()).toBe(401);
  const missing = await request.get(`/api/v1/messages/${randomUUID()}/media`, { headers: auth });
  expect(missing.status()).toBe(404);
  expect((await missing.json()).error.code).toBe('not_found');
});

test('a key uploads a price list once and sends it by id to a customer who wrote (ADR-219)', async ({
  page,
  request,
}) => {
  const email = uniqueEmail('apiupload');
  const slug = `apiupload-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Uma Uploads', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Upload Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Price lists');
  await page.getByRole('checkbox', { name: /Reply with text/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const auth = { Authorization: `Bearer ${token}` };

  const waId = randomWaId();
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, waId, 'What are your prices?'),
  );
  await page.goto(`/c/${slug}/inbox`);
  await expect(page.getByRole('link', { name: /Priya Customer/ })).toBeVisible({
    timeout: 20_000,
  });

  // The upload: once, for the company's number.
  const prices = Buffer.from('%PDF-1.4 prices for Uma');
  const uploaded = await request.post('/api/v1/media', {
    headers: auth,
    multipart: { file: { name: 'Prices.pdf', mimeType: 'application/pdf', buffer: prices } },
  });
  expect(uploaded.status()).toBe(201);
  const media = (await uploaded.json()).data as { id: string; type: string; fileName: string };
  expect(media).toMatchObject({ type: 'document', fileName: 'Prices.pdf' });

  // The send names it, and WhatsApp gets the media's id with the document's name.
  const sent = await request.post('/api/v1/messages', {
    headers: { ...auth, 'Idempotency-Key': randomUUID() },
    data: { type: 'document', to: `+${waId}`, mediaId: media.id, caption: 'Our prices' },
  });
  expect(sent.status()).toBe(201);
  const queued = (await sent.json()).data as { id: string };
  await expect(async () => {
    const status = await request.get(`/api/v1/messages/${queued.id}`, { headers: auth });
    expect((await status.json()).data).toMatchObject({ type: 'document', status: 'accepted' });
  }).toPass({ timeout: 30_000 });
  const requests = await standInRequests(request);
  expect(
    requests.filter((r) => r.path === `/v26.0/${phoneNumberId}/media`).map((r) => r.authorization),
  ).toEqual([`Bearer ${E2E_CHANNEL_TOKEN}`]);
  const send = requests
    .filter(
      (r) =>
        r.path === `/v26.0/${phoneNumberId}/messages` &&
        (r.body as { to?: string } | null)?.to === waId,
    )
    .pop();
  expect(send?.body).toMatchObject({
    type: 'document',
    document: { caption: 'Our prices', filename: 'Prices.pdf' },
  });

  // The inbox shows the document the key sent, which members open.
  await page.getByRole('link', { name: /Priya Customer/ }).click();
  const thread = page.getByRole('list', { name: /^Messages with/ });
  await expect(thread.getByRole('link', { name: 'Download Prices.pdf' })).toBeVisible();
});
