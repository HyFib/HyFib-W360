import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './fixtures';
import {
  connectTestChannel,
  inboundMessage,
  messagingConfigured,
  randomWaId,
  sendSignedWebhook,
} from './messaging-support';
import {
  expectNoHorizontalOverflow,
  signUpAndVerify,
  uniqueEmail,
  waitForEmailContaining,
} from './support';

const PASSWORD = 'correct horse battery staple 42';
/**
 * A host name that resolves to 127.0.0.1 on the test machine (CI adds it to /etc/hosts); the web
 * and worker must allow loopback egress, which only APP_ENV=local|test permits.
 */
const HOST = process.env.E2E_HTTP_HOST ?? '';

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');
test.skip(
  !HOST || process.env.W360_EGRESS_ALLOW_LOOPBACK !== 'true',
  'Webhook receiver not provided (E2E_HTTP_HOST resolving to 127.0.0.1, W360_EGRESS_ALLOW_LOOPBACK)',
);

/** The company's receiver. */
let receiver: Server;
let port = 0;
const received: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];

test.beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body });
      res.writeHead(204);
      res.end();
    });
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  port = (receiver.address() as AddressInfo).port;
});

test.afterAll(() => {
  receiver?.close();
});

/** Checks `W360-Signature` as a receiver would: HMAC-SHA256 of "<t>.<body>" with the secret. */
function signatureValid(headers: IncomingHttpHeaders, body: string, secret: string): boolean {
  const header = String(headers['w360-signature'] ?? '');
  const t = /^t=(\d+)/.exec(header)?.[1];
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'));
  return header
    .split(',')
    .filter((part) => part.startsWith('v1='))
    .some((part) => {
      const given = Buffer.from(part.slice(3));
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}

test('an endpoint added in settings receives signed events, replays and a rotated secret', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('hooks');
  const slug = `hooks-${Date.now().toString(36)}`;
  const path = `/hooks/${slug}`;
  const forUs = () => received.filter((r) => r.path === path);
  await signUpAndVerify(page, { name: 'Hari Hooks', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Hook Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // Settings → Webhooks: an endpoint for received messages and consent; its secret is shown once.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await expect(page.getByText('No endpoints yet.')).toBeVisible();
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${path}`);
  await page.getByLabel('Description').fill('Order system');
  await page.getByRole('checkbox', { name: /Message received/ }).check();
  await page.getByRole('checkbox', { name: /Consent changed/ }).check();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  const secretField = page.getByLabel('Signing secret');
  await expect(secretField).toBeVisible();
  const secret = await secretField.inputValue();
  expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'I have stored the secret' }).click();
  await expect(secretField).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(secret)).toHaveCount(0);
  await expect(page.getByText(`http://${HOST}:${port}${path}`)).toBeVisible();
  await expect(page.getByText('On', { exact: true })).toBeVisible();

  // A test event arrives signed with that secret.
  await page.getByRole('button', { name: `Send test event to ${HOST}` }).click();
  await expect(page.getByText('Test event queued.', { exact: false })).toBeVisible();
  await expect(async () => expect(forUs()).toHaveLength(1)).toPass({ timeout: 30_000 });
  const ping = forUs()[0]!;
  expect(ping.headers['w360-event-type']).toBe('ping');
  expect(ping.headers['user-agent']).toBe('HyFib-W360-Webhooks/1');
  expect(signatureValid(ping.headers, ping.body, secret)).toBe(true);
  expect(signatureValid(ping.headers, ping.body, `${secret}x`)).toBe(false);
  expect(JSON.parse(ping.body)).toMatchObject({ type: 'ping', id: ping.headers['w360-event-id'] });

  // A customer's message arrives through Meta's webhook and is posted to the endpoint.
  const waId = randomWaId();
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, waId, 'Is my parcel out?'),
  );
  await expect(async () => expect(forUs()).toHaveLength(2)).toPass({ timeout: 30_000 });
  const message = forUs()[1]!;
  expect(signatureValid(message.headers, message.body, secret)).toBe(true);
  expect(JSON.parse(message.body)).toMatchObject({
    type: 'message.received',
    data: {
      message: { type: 'text', text: 'Is my parcel out?' },
      contact: { phone: `+${waId}`, name: 'Priya Customer' },
    },
  });

  // The delivery history, and a replay of the test event with the same event id.
  await page.getByRole('link', { name: `Deliveries and settings for ${HOST}` }).click();
  await expect(page.getByRole('heading', { name: `Deliveries to ${HOST}` })).toBeVisible();
  const deliveries = page.getByRole('list', { name: 'Deliveries' }).getByRole('listitem');
  await expect(deliveries).toHaveCount(2);
  await expect(deliveries.filter({ hasText: 'Delivered' })).toHaveCount(2);
  await expect(deliveries.filter({ hasText: 'message.received' })).toHaveCount(1);
  await expectNoHorizontalOverflow(page);
  await page
    .getByRole('button', { name: `Replay ping ${String(ping.headers['w360-event-id'])}` })
    .click();
  await expect(async () => expect(forUs()).toHaveLength(3)).toPass({ timeout: 30_000 });
  const replay = forUs()[2]!;
  expect(replay.headers['w360-event-id']).toBe(ping.headers['w360-event-id']);
  expect(replay.headers['w360-delivery-id']).not.toBe(ping.headers['w360-delivery-id']);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Replay', { exact: true })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Show failed deliveries only' }).click();
  await expect(page.getByText('No failed deliveries.')).toBeVisible();

  // Rotating: for 24 hours requests carry signatures with the new and the previous secret.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByRole('button', { name: `Rotate secret of ${HOST}` }).click();
  await page.getByRole('button', { name: 'Rotate secret', exact: true }).click();
  await expect(secretField).toBeVisible();
  const rotated = await secretField.inputValue();
  expect(rotated).not.toBe(secret);
  await page.getByRole('button', { name: 'I have stored the secret' }).click();
  await page.getByRole('button', { name: `Send test event to ${HOST}` }).click();
  await expect(async () => expect(forUs()).toHaveLength(4)).toPass({ timeout: 30_000 });
  const afterRotation = forUs()[3]!;
  expect(String(afterRotation.headers['w360-signature']).match(/v1=/g)).toHaveLength(2);
  expect(signatureValid(afterRotation.headers, afterRotation.body, rotated)).toBe(true);
  expect(signatureValid(afterRotation.headers, afterRotation.body, secret)).toBe(true);

  // Turned off, nothing is sent; turned on again; deleted.
  await page.getByRole('button', { name: `Turn off ${HOST}` }).click();
  await page.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(page.getByText('Off', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Send test event to ${HOST}` })).toHaveCount(0);
  await page.getByRole('button', { name: `Turn on ${HOST}` }).click();
  await expect(page.getByText('On', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Delete ${HOST}` }).click();
  await page.getByRole('button', { name: 'Delete endpoint' }).click();
  await expect(page.getByText('No endpoints yet.')).toBeVisible();
  expect(forUs()).toHaveLength(4);
});

test('an API key adds its own endpoint over HTTP: owners are emailed, settings name the key, events arrive signed with its secret, and the key turns it off and deletes it (ADR-081)', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('apihooks');
  const slug = `apihooks-${Date.now().toString(36)}`;
  const path = `/hooks/${slug}/crm-token-1234`;
  const forUs = () => received.filter((r) => r.path === path);
  await signUpAndVerify(page, { name: 'Asha Api', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Hook Clinic');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));

  // An owner creates a key that manages webhook endpoints.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('CRM connector');
  await page.getByRole('checkbox', { name: /Manage webhook endpoints/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const auth = { Authorization: `Bearer ${token}` };

  // The key adds an endpoint once per Idempotency-Key; its secret is in the first answer only.
  const idempotencyKey = randomUUID();
  const body = {
    url: `http://${HOST}:${port}${path}`,
    events: ['message.received', 'contact.created'],
    description: 'CRM sync',
  };
  const created = await request.post('/api/v1/webhook-endpoints', {
    headers: { ...auth, 'Idempotency-Key': idempotencyKey },
    data: body,
  });
  expect(created.status()).toBe(201);
  const { data } = (await created.json()) as { data: { id: string; secret: string | null } };
  expect(data.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
  const retry = await request.post('/api/v1/webhook-endpoints', {
    headers: { ...auth, 'Idempotency-Key': idempotencyKey },
    data: body,
  });
  expect(retry.status()).toBe(201);
  expect(retry.headers()['idempotent-replayed']).toBe('true');
  expect(((await retry.json()) as { data: { id: string; secret: null } }).data).toMatchObject({
    id: data.id,
    secret: null,
  });
  const listed = await request.get('/api/v1/webhook-endpoints', { headers: auth });
  expect(((await listed.json()) as { data: { id: string }[] }).data.map((e) => e.id)).toEqual([
    data.id,
  ]);

  // The owner is emailed about it (the host, never the address's path).
  const notice = await waitForEmailContaining(
    email,
    'Webhook endpoint added through the API',
    'CRM connector',
  );
  expect(notice).toContain(`added a webhook endpoint at ${HOST}`);
  expect(notice).toContain('It receives: Message received, Contact added.');
  expect(notice).not.toContain('crm-token-1234');

  // Settings name the key, and a test event arrives signed with the secret the key was given.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await expect(page.getByText(`http://${HOST}:${port}${path}`)).toBeVisible();
  await expect(page.getByText(/by the API key “CRM connector” \(w360_[a-z0-9]+_…\)/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: `Send test event to ${HOST}` }).click();
  await expect(async () => expect(forUs()).toHaveLength(1)).toPass({ timeout: 30_000 });
  expect(signatureValid(forUs()[0]!.headers, forUs()[0]!.body, data.secret!)).toBe(true);

  // The key turns the endpoint off, then deletes it.
  const off = await request.patch(`/api/v1/webhook-endpoints/${data.id}`, {
    headers: auth,
    data: { enabled: false },
  });
  expect(((await off.json()) as { data: { status: string } }).data.status).toBe('disabled');
  await page.reload();
  await expect(page.getByText('Off', { exact: true })).toBeVisible();
  const deleted = await request.delete(`/api/v1/webhook-endpoints/${data.id}`, { headers: auth });
  expect(deleted.status()).toBe(200);
  await page.reload();
  await expect(page.getByText('No endpoints yet.')).toBeVisible();
  expect(forUs()).toHaveLength(1);
});

test('an API key sends its endpoint a test event, follows the delivery, replays it and reads the history, which settings show too (ADR-083)', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('apideliv');
  const slug = `apideliv-${Date.now().toString(36)}`;
  const path = `/hooks/${slug}/deliveries`;
  const forUs = () => received.filter((r) => r.path === path);
  await signUpAndVerify(page, { name: 'Ravi Replay', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Replay Clinic');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));

  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Helpdesk connector');
  await page.getByRole('checkbox', { name: /Manage webhook endpoints/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const auth = { Authorization: `Bearer ${token}` };
  const created = await request.post('/api/v1/webhook-endpoints', {
    headers: { ...auth, 'Idempotency-Key': randomUUID() },
    data: { url: `http://${HOST}:${port}${path}`, events: ['message.received'] },
  });
  const endpoint = ((await created.json()) as { data: { id: string; secret: string } }).data;

  // A test event, answered with its delivery, which the key follows until it succeeds.
  const sent = await request.post(`/api/v1/webhook-endpoints/${endpoint.id}/test`, {
    headers: { ...auth, 'Idempotency-Key': randomUUID() },
  });
  expect(sent.status()).toBe(201);
  const test1 = ((await sent.json()) as { data: { id: string; eventId: string } }).data;
  expect(test1).toMatchObject({ eventType: 'ping', status: 'pending', replayOf: null });
  await expect(async () => {
    const res = await request.get(`/api/v1/webhook-deliveries/${test1.id}`, { headers: auth });
    expect((await res.json()).data).toMatchObject({ status: 'succeeded', lastStatusCode: 204 });
  }).toPass({ timeout: 30_000 });
  expect(forUs()).toHaveLength(1);
  expect(signatureValid(forUs()[0]!.headers, forUs()[0]!.body, endpoint.secret)).toBe(true);
  expect(JSON.parse(forUs()[0]!.body)).toMatchObject({ id: test1.eventId, type: 'ping' });

  // A replay delivers the same event again, as a new delivery.
  const replayed = await request.post(`/api/v1/webhook-deliveries/${test1.id}/replay`, {
    headers: { ...auth, 'Idempotency-Key': randomUUID() },
  });
  expect(replayed.status()).toBe(201);
  const replay = ((await replayed.json()) as { data: { id: string } }).data;
  expect(replay).toMatchObject({ replayOf: test1.id, eventId: test1.eventId });
  await expect(async () => expect(forUs()).toHaveLength(2)).toPass({ timeout: 30_000 });
  expect(JSON.parse(forUs()[1]!.body)).toMatchObject({ id: test1.eventId, type: 'ping' });

  // The history, newest first, through the API and in settings (the replay marked).
  await expect(async () => {
    const list = await request.get(`/api/v1/webhook-endpoints/${endpoint.id}/deliveries`, {
      headers: auth,
    });
    const rows = ((await list.json()) as { data: { id: string; status: string }[] }).data;
    expect(rows.map((d) => [d.id, d.status])).toEqual([
      [replay.id, 'succeeded'],
      [test1.id, 'succeeded'],
    ]);
  }).toPass({ timeout: 30_000 });
  await page.goto(`/c/${slug}/settings/webhooks/${endpoint.id}`);
  const history = page.getByRole('list', { name: 'Deliveries' }).getByRole('listitem');
  await expect(history).toHaveCount(2);
  await expect(history.first().getByText('Replay', { exact: true })).toBeVisible();
  await expect(history.last().getByText('Replay', { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});
