import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';
import {
  connectTestChannel,
  inboundMessage,
  messagingConfigured,
  randomWaId,
  sendSignedWebhook,
  standInRequests,
} from './messaging-support';
import { expectNoHorizontalOverflow, signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';
const standIn = `http://127.0.0.1:${process.env.E2E_GRAPH_PORT}`;

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');

test('an API key created in settings sends an approved template once, and stops working when revoked', async ({
  page,
  request,
}) => {
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

  // A key with three scopes; its token is shown once.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await expect(page.getByText('No API keys yet.')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Order system');
  await page.getByRole('checkbox', { name: /Read templates/ }).check();
  await page.getByRole('checkbox', { name: /Create contacts and record consent/ }).check();
  await page.getByRole('checkbox', { name: /Send utility templates/ }).check();
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
  const template = (
    (await templates.json()) as {
      data: { id: string; name: string; variables: { header: number; body: number } }[];
    }
  ).data.find((t) => t.name === 'shipping_update');
  expect(template?.variables).toEqual({ header: 0, body: 2 });

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
  const queued = (await first.json()).data as { id: string; status: string };
  expect(queued.status).toBe('queued');
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

  // Revoked in settings: the next request is refused.
  await page.getByRole('button', { name: 'Revoke Order system' }).click();
  await page.getByRole('button', { name: 'Revoke key' }).click();
  await expect(page.getByText('Revoked', { exact: true }).first()).toBeVisible();
  const afterRevoke = await request.get('/api/v1/templates', { headers: auth });
  expect(afterRevoke.status()).toBe(401);
});

test('a key with the reply scope answers a customer who wrote and reads the conversation, and the inbox shows the reply came through the API', async ({
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
    data: { id: string; status: string; serviceWindowEndsAt: string | null }[];
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
    }),
  ]);
  const older = await request.get(
    `/api/v1/conversations/${open!.id}/messages?limit=1&cursor=${firstPage.nextCursor}`,
    { headers: auth },
  );
  expect((await older.json()).data).toEqual([
    expect.objectContaining({
      direction: 'inbound',
      type: 'text',
      text: 'Where is my order A-1001?',
      sentBy: null,
      status: 'received',
    }),
  ]);
  const resolved = await request.get('/api/v1/conversations?status=resolved', { headers: auth });
  expect((await resolved.json()).data).toEqual([]);

  // Members see the reply in the conversation, marked with the key that sent it.
  await conversation.click();
  const thread = page.getByRole('list', { name: /^Messages with/ });
  await expect(thread.getByText('Order A-1001 ships today.')).toBeVisible({ timeout: 20_000 });
  await expect(thread.getByText('· API (Helpdesk)')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
