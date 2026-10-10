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
  standInRequests,
  statusUpdate,
} from './messaging-support';
import {
  expectNoHorizontalOverflow,
  openFromNav,
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
/** Paths the receiver answers with 500, as a receiver that is down. */
const down = new Set<string>();
/** Paths the receiver answers as an OAuth authorization server, with the token it gives (ADR-173). */
const tokenPaths = new Map<string, string>();

test.beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body });
      const token = tokenPaths.get(req.url ?? '');
      if (token) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 3600 }));
        return;
      }
      res.writeHead(down.has(req.url ?? '') ? 500 : 204);
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
  await expect(page.getByRole('link', { name: 'API reference', exact: true })).toHaveAttribute(
    'href',
    '/developers#webhook-events',
  );
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
      // Nothing was left out of it (ADR-132).
      message: {
        type: 'text',
        text: 'Is my parcel out?',
        contentTooLarge: false,
        contactsLeftOut: 0,
      },
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

test('a receiver that was down gets its failed events again with one replay from settings (ADR-095)', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const email = uniqueEmail('hookdown');
  const slug = `hookdown-${Date.now().toString(36)}`;
  const path = `/hooks/${slug}`;
  const forUs = () => received.filter((r) => r.path === path);
  await signUpAndVerify(page, { name: 'Dev Down', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Down Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${path}`);
  await page.getByRole('checkbox', { name: /Message received/ }).check();
  // Template statuses too: none changes in this test, so none of their deliveries can fail.
  await page.getByRole('checkbox', { name: /Template status/ }).check();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();

  // The receiver is down while two customers write: both first attempts fail.
  down.add(path);
  for (const text of ['Where is my order?', 'Can I change my address?']) {
    await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, randomWaId(), text));
  }
  await expect(async () => expect(forUs()).toHaveLength(2)).toPass({ timeout: 30_000 });
  const failedIds = forUs().map((r) => String(r.headers['w360-event-id']));

  // Turned off (what is waiting fails) and on again once the receiver is back.
  await page.getByRole('button', { name: `Turn off ${HOST}` }).click();
  await page.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(page.getByText('Off', { exact: true })).toBeVisible();
  down.delete(path);
  await page.getByRole('button', { name: `Turn on ${HOST}` }).click();
  await expect(page.getByText('On', { exact: true })).toBeVisible();

  // One replay from the endpoint's page sends both events again, with the same event ids.
  await page.getByRole('link', { name: `Deliveries and settings for ${HOST}` }).click();
  const deliveries = page.getByRole('list', { name: 'Deliveries' }).getByRole('listitem');
  await expect(deliveries.filter({ hasText: 'Failed' })).toHaveCount(2);
  const replayForm = page.getByRole('form', { name: 'Replay failed deliveries' });
  await replayForm.getByLabel('Failed deliveries from').selectOption({ label: 'the last hour' });
  // Of one event (ADR-156): no template event failed, so nothing comes back; then the messages.
  const replayEvents = replayForm.getByLabel('Events', { exact: true });
  await expect(replayEvents.getByRole('option')).toHaveText([
    'Every event',
    'Message received (message.received)',
    'Template status (template.status_changed)',
  ]);
  await replayEvents.selectOption({ label: 'Template status (template.status_changed)' });
  await replayForm.getByRole('button', { name: 'Replay failed deliveries' }).click();
  await expect(page.getByText('No failed deliveries to replay from that period.')).toBeVisible();
  expect(forUs()).toHaveLength(2);
  // By how they failed (ADR-159): the first attempts were answered 500, but turning the endpoint off
  // ended the deliveries without another attempt, which says more, so they are not server errors.
  // Reloaded first, so the answer above cannot stand for the next one.
  await page.reload();
  await replayForm.getByLabel('Failed deliveries from').selectOption({ label: 'the last hour' });
  await replayEvents.selectOption({ label: 'Message received (message.received)' });
  const replayFailures = replayForm.getByLabel('Failures', { exact: true });
  await expect(replayFailures.getByRole('option')).toHaveText([
    'Every failure',
    'Server errors (HTTP 5xx)',
    'Refused (HTTP 4xx)',
    'Other answers (HTTP 1xx or 3xx)',
    'No valid answer (timeouts, connection errors, no access token)',
    'Not attempted (endpoint off, request not prepared)',
  ]);
  await replayFailures.selectOption({ label: 'Server errors (HTTP 5xx)' });
  await replayForm.getByRole('button', { name: 'Replay failed deliveries' }).click();
  await expect(page.getByText('No failed deliveries to replay from that period.')).toBeVisible();
  expect(forUs()).toHaveLength(2);
  await replayFailures.selectOption({
    label: 'Not attempted (endpoint off, request not prepared)',
  });
  await replayForm.getByRole('button', { name: 'Replay failed deliveries' }).click();
  await expect(page.getByText('Replaying 2 deliveries.')).toBeVisible();
  await expect(async () => expect(forUs()).toHaveLength(4)).toPass({ timeout: 30_000 });
  expect(
    forUs()
      .slice(2)
      .map((r) => String(r.headers['w360-event-id']))
      .sort(),
  ).toEqual([...failedIds].sort());
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Replay', { exact: true })).toHaveCount(2, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await expect(deliveries.filter({ hasText: 'Delivered' })).toHaveCount(2);
  await expectNoHorizontalOverflow(page);

  // Delivered now, nothing is left to replay.
  await page.getByRole('button', { name: 'Replay failed deliveries' }).click();
  await expect(page.getByText('No failed deliveries to replay from that period.')).toBeVisible();
  expect(forUs()).toHaveLength(4);

  // Every endpoint at once (ADR-160): the receiver is down again while a third customer writes,
  // the endpoint is turned off and on, and one replay from the Webhooks page sends the message.
  down.add(path);
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, randomWaId(), 'Has it shipped yet?'),
  );
  await expect(async () => expect(forUs()).toHaveLength(5)).toPass({ timeout: 30_000 });
  const thirdId = String(forUs()[4]!.headers['w360-event-id']);
  await page.goto(`/c/${slug}/settings/webhooks`);
  const replayAll = page.getByRole('form', { name: 'Replay every endpoint’s failed deliveries' });
  await page.getByRole('button', { name: `Turn off ${HOST}` }).click();
  await page.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(page.getByText('Off', { exact: true })).toBeVisible();
  // With no endpoint on, there is nothing to replay to.
  await expect(replayAll).toHaveCount(0);
  down.delete(path);
  await page.getByRole('button', { name: `Turn on ${HOST}` }).click();
  await expect(page.getByText('On', { exact: true })).toBeVisible();
  await replayAll.getByLabel('Failed deliveries from').selectOption({ label: 'the last hour' });
  await expect(replayAll.getByLabel('Events', { exact: true }).getByRole('option')).toHaveText([
    'Every event',
    'Message received (message.received)',
    'Template status (template.status_changed)',
  ]);
  await replayAll
    .getByRole('button', { name: 'Replay every endpoint’s failed deliveries' })
    .click();
  const host = new URL(`http://${HOST}:${port}${path}`).hostname;
  await expect(page.getByText(`Replaying 1 delivery: 1 to ${host}.`)).toBeVisible();
  await expect(async () => expect(forUs()).toHaveLength(6)).toPass({ timeout: 30_000 });
  expect(String(forUs()[5]!.headers['w360-event-id'])).toBe(thirdId);
  await expectNoHorizontalOverflow(page);
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

test('an endpoint sends its own headers with every delivery: set in settings and shown by name only, replaced on its page, and given and removed by an API key (ADR-118)', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('hdrhooks');
  const slug = `hdrhooks-${Date.now().toString(36)}`;
  const path = `/hooks/${slug}/headers`;
  const forUs = () => received.filter((r) => r.path === path);
  const token = `Bearer e2e-${randomUUID()}`;
  await signUpAndVerify(page, { name: 'Hema Headers', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Header Works');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));

  // Settings → Webhooks: an endpoint with two headers its receiver asks for.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${path}`);
  await page.getByRole('checkbox', { name: /Consent changed/ }).check();
  await page.getByRole('button', { name: 'Add a header' }).click();
  await page.getByLabel('Header 1 name').fill('Authorization');
  await page.getByLabel('Header 1 value').fill(token);
  await page.getByRole('button', { name: 'Add a header' }).click();
  await page.getByLabel('Header 2 name').fill('X-Api-Key');
  await page.getByLabel('Header 2 value').fill('key-e2e-1');
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  const secretField = page.getByLabel('Signing secret');
  await expect(secretField).toBeVisible();
  const secret = await secretField.inputValue();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();

  // Their names are shown; their values never reach the browser again.
  await page.reload();
  await expect(
    page.getByText('Headers sent: Authorization, X-Api-Key (values hidden)'),
  ).toBeVisible();
  expect(await page.content()).not.toContain(token.slice(7));

  // A test event carries them beside HyFib's own headers.
  await page.getByRole('button', { name: `Send test event to ${HOST}` }).click();
  await expect(async () => expect(forUs()).toHaveLength(1)).toPass({ timeout: 30_000 });
  expect(forUs()[0]!.headers).toMatchObject({
    authorization: token,
    'x-api-key': 'key-e2e-1',
    'user-agent': 'HyFib-W360-Webhooks/1',
  });
  expect(signatureValid(forUs()[0]!.headers, forUs()[0]!.body, secret)).toBe(true);

  // On the endpoint's page: a header HyFib sets is refused; replacing gives each header again.
  await page.getByRole('link', { name: `Deliveries and settings for ${HOST}` }).click();
  await expect(page.getByText('Sent now: Authorization, X-Api-Key.')).toBeVisible();
  expect(await page.content()).not.toContain(token.slice(7));
  await page.getByRole('checkbox', { name: /Replace the headers/ }).check();
  await page.getByRole('button', { name: 'Add a header' }).click();
  await page.getByLabel('Header 1 name').fill('W360-Signature');
  await page.getByLabel('Header 1 value').fill('t=1,v1=forged');
  await page.getByRole('button', { name: 'Save endpoint' }).click();
  await expect(page.getByText('HyFib sets this header itself.')).toBeVisible();
  await page.getByLabel('Header 1 name').fill('Authorization');
  await page.getByLabel('Header 1 value').fill('Bearer replaced-e2e');
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Save endpoint' }).click();
  await expect(page.getByText('Endpoint saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Sent now: Authorization.')).toBeVisible();
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByRole('button', { name: `Send test event to ${HOST}` }).click();
  await expect(async () => expect(forUs()).toHaveLength(2)).toPass({ timeout: 30_000 });
  expect(forUs()[1]!.headers.authorization).toBe('Bearer replaced-e2e');
  expect(forUs()[1]!.headers['x-api-key']).toBeUndefined();

  // An API key gives its own endpoint a header, sees only its name, and removes it.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Gateway connector');
  await page.getByRole('checkbox', { name: /Manage webhook endpoints/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const apiToken = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const auth = { Authorization: `Bearer ${apiToken}` };
  const apiPath = `/hooks/${slug}/api-headers`;
  const viaApi = () => received.filter((r) => r.path === apiPath);
  const created = await request.post('/api/v1/webhook-endpoints', {
    headers: { ...auth, 'Idempotency-Key': randomUUID() },
    data: {
      url: `http://${HOST}:${port}${apiPath}`,
      events: ['message.received'],
      headers: [{ name: 'X-Gateway-Token', value: 'gateway-e2e-1' }],
    },
  });
  expect(created.status()).toBe(201);
  const endpoint = ((await created.json()) as { data: { id: string; headers: { name: string }[] } })
    .data;
  expect(endpoint.headers).toEqual([{ name: 'X-Gateway-Token' }]);
  expect(JSON.stringify(endpoint)).not.toContain('gateway-e2e-1');
  const sendTest = () =>
    request.post(`/api/v1/webhook-endpoints/${endpoint.id}/test`, {
      headers: { ...auth, 'Idempotency-Key': randomUUID() },
    });
  expect((await sendTest()).status()).toBe(201);
  await expect(async () => expect(viaApi()).toHaveLength(1)).toPass({ timeout: 30_000 });
  expect(viaApi()[0]!.headers['x-gateway-token']).toBe('gateway-e2e-1');

  const refused = await request.patch(`/api/v1/webhook-endpoints/${endpoint.id}`, {
    headers: auth,
    data: { headers: [{ name: 'Content-Type', value: 'text/plain' }] },
  });
  expect(refused.status()).toBe(422);
  expect(((await refused.json()) as { error: { issues: unknown } }).error.issues).toEqual([
    { path: 'headers.0.name', message: 'HyFib sets this header itself.' },
  ]);
  const removed = await request.patch(`/api/v1/webhook-endpoints/${endpoint.id}`, {
    headers: auth,
    data: { headers: [] },
  });
  expect(((await removed.json()) as { data: { headers: unknown } }).data.headers).toEqual([]);
  expect((await sendTest()).status()).toBe(201);
  await expect(async () => expect(viaApi()).toHaveLength(2)).toPass({ timeout: 30_000 });
  expect(viaApi()[1]!.headers['x-gateway-token']).toBeUndefined();
});

test('an endpoint gets OAuth access tokens as its client and sends them as a bearer token: set in settings with the secret never shown again, changed on its page to send it in the request body, removed, and given by an API key (ADR-173, ADR-357)', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('oauthhooks');
  const slug = `oauthhooks-${Date.now().toString(36)}`;
  const path = `/hooks/${slug}/oauth`;
  const forUs = () => received.filter((r) => r.path === path);
  const firstTokenPath = `/hooks/${slug}/token-1`;
  const secondTokenPath = `/hooks/${slug}/token-2`;
  const asked = (tokenPath: string) => received.filter((r) => r.path === tokenPath);
  const clientSecret = `e2e-${randomUUID()}`;
  tokenPaths.set(firstTokenPath, `tok1-${randomUUID()}`);
  tokenPaths.set(secondTokenPath, `tok2-${randomUUID()}`);
  await signUpAndVerify(page, { name: 'Omar OAuth', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('OAuth Works');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));

  // Settings → Webhooks: an endpoint whose receiver wants a token from its authorization server.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${path}`);
  await page.getByRole('checkbox', { name: /Consent changed/ }).check();
  await page.getByRole('checkbox', { name: 'Get an OAuth access token for each delivery' }).check();
  await page
    .getByLabel('Token URL', { exact: true })
    .fill(`http://${HOST}:${port}${firstTokenPath}`);
  await page.getByLabel('Client ID', { exact: true }).fill('e2e-client');
  await page.getByLabel('Client secret', { exact: true }).fill(clientSecret);
  await page.getByLabel('Scope', { exact: true }).fill('hooks.write');
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  const secretField = page.getByLabel('Signing secret');
  await expect(secretField).toBeVisible();
  const secret = await secretField.inputValue();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();

  // The client is shown by its token URL's host; the secret never reaches the browser again.
  await page.reload();
  await expect(
    page.getByText(`OAuth access tokens from ${HOST}, as client e2e-client, scope hooks.write`),
  ).toBeVisible();
  expect(await page.content()).not.toContain(clientSecret);

  // A test event: the worker asks for a token as the client, then sends it as a bearer token.
  await page.getByRole('button', { name: `Send test event to ${HOST}` }).click();
  await expect(async () => expect(forUs()).toHaveLength(1)).toPass({ timeout: 30_000 });
  expect(asked(firstTokenPath)).toHaveLength(1);
  expect(asked(firstTokenPath)[0]!.headers.authorization).toBe(
    `Basic ${Buffer.from(`e2e-client:${clientSecret}`).toString('base64')}`,
  );
  expect(asked(firstTokenPath)[0]!.body).toBe('grant_type=client_credentials&scope=hooks.write');
  expect(forUs()[0]!.headers.authorization).toBe(`Bearer ${tokenPaths.get(firstTokenPath)}`);
  expect(signatureValid(forUs()[0]!.headers, forUs()[0]!.body, secret)).toBe(true);

  // On the endpoint's page: another token URL needs the secret again, since it is sent there. Its
  // server takes the client ID and secret in the request body (ADR-357).
  await page.getByRole('link', { name: `Deliveries and settings for ${HOST}` }).click();
  await expect(page.getByText(/OAuth access tokens from .*, as client e2e-client/)).toBeVisible();
  expect(await page.content()).not.toContain(clientSecret);
  await page.getByRole('radio', { name: 'Change the OAuth client' }).check();
  await page
    .getByLabel('Token URL', { exact: true })
    .fill(`http://${HOST}:${port}${secondTokenPath}`);
  await expect(page.getByLabel('How the client authenticates', { exact: true })).toHaveValue(
    'client_secret_basic',
  );
  await page
    .getByLabel('How the client authenticates', { exact: true })
    .selectOption('client_secret_post');
  await page.getByRole('button', { name: 'Save endpoint' }).click();
  await expect(
    page.getByText('Enter the client secret again: it is sent to the token URL, which changed.'),
  ).toBeVisible();
  await page.getByLabel('Client secret', { exact: true }).fill(`${clientSecret}-2`);
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Save endpoint' }).click();
  await expect(page.getByText('Endpoint saved.')).toBeVisible();
  await page.goto(`/c/${slug}/settings/webhooks`);
  await expect(
    page.getByText(
      `OAuth access tokens from ${HOST}, as client e2e-client, scope hooks.write, its ID and secret sent in the request body`,
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: `Send test event to ${HOST}` }).click();
  await expect(async () => expect(forUs()).toHaveLength(2)).toPass({ timeout: 30_000 });
  expect(asked(secondTokenPath)).toHaveLength(1);
  expect(asked(secondTokenPath)[0]!.headers.authorization).toBeUndefined();
  expect(asked(secondTokenPath)[0]!.body).toBe(
    `grant_type=client_credentials&scope=hooks.write&client_id=e2e-client&client_secret=${clientSecret}-2`,
  );
  expect(forUs()[1]!.headers.authorization).toBe(`Bearer ${tokenPaths.get(secondTokenPath)}`);

  // Removed: deliveries go without a token.
  await page.getByRole('link', { name: `Deliveries and settings for ${HOST}` }).click();
  await page.getByRole('radio', { name: /Remove the OAuth client/ }).check();
  await page.getByRole('button', { name: 'Save endpoint' }).click();
  await expect(page.getByText('Endpoint saved.')).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('checkbox', { name: 'Get an OAuth access token for each delivery' }),
  ).not.toBeChecked();
  await page.goto(`/c/${slug}/settings/webhooks`);
  await expect(page.getByText(/OAuth access tokens from/)).toHaveCount(0);
  await page.getByRole('button', { name: `Send test event to ${HOST}` }).click();
  await expect(async () => expect(forUs()).toHaveLength(3)).toPass({ timeout: 30_000 });
  expect(forUs()[2]!.headers.authorization).toBeUndefined();

  // An API key gives its own endpoint a client, answered without the secret.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('OAuth connector');
  await page.getByRole('checkbox', { name: /Manage webhook endpoints/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const apiToken = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const auth = { Authorization: `Bearer ${apiToken}` };
  const apiPath = `/hooks/${slug}/api-oauth`;
  const apiTokenPath = `/hooks/${slug}/api-token`;
  tokenPaths.set(apiTokenPath, `tok3-${randomUUID()}`);
  const created = await request.post('/api/v1/webhook-endpoints', {
    headers: { ...auth, 'Idempotency-Key': randomUUID() },
    data: {
      url: `http://${HOST}:${port}${apiPath}`,
      events: ['message.received'],
      oauth: {
        tokenUrl: `http://${HOST}:${port}${apiTokenPath}`,
        clientId: 'api-client',
        clientSecret: `${clientSecret}-api`,
      },
    },
  });
  expect(created.status()).toBe(201);
  const endpoint = ((await created.json()) as { data: { id: string; oauth: unknown } }).data;
  expect(endpoint.oauth).toEqual({
    tokenUrl: `http://${HOST}:${port}${apiTokenPath}`,
    clientId: 'api-client',
    scope: null,
    clientAuthentication: 'client_secret_basic',
  });
  expect(JSON.stringify(endpoint)).not.toContain(clientSecret);
  const testEvent = await request.post(`/api/v1/webhook-endpoints/${endpoint.id}/test`, {
    headers: { ...auth, 'Idempotency-Key': randomUUID() },
  });
  expect(testEvent.status()).toBe(201);
  const viaApi = () => received.filter((r) => r.path === apiPath);
  await expect(async () => expect(viaApi()).toHaveLength(1)).toPass({ timeout: 30_000 });
  expect(viaApi()[0]!.headers.authorization).toBe(`Bearer ${tokenPaths.get(apiTokenPath)}`);
});

test('an endpoint receives only the message statuses it takes: chosen in settings and on its page, and by an API key (ADR-119)', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('stathooks');
  const slug = `stathooks-${Date.now().toString(36)}`;
  const path = `/hooks/${slug}/statuses`;
  const apiPath = `/hooks/${slug}/api-statuses`;
  const forUs = () => received.filter((r) => r.path === path);
  const viaApi = () => received.filter((r) => r.path === apiPath);
  await signUpAndVerify(page, { name: 'Sara Status', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Status Works');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // Settings → Webhooks: message statuses, failures only.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${path}`);
  await page.getByRole('checkbox', { name: /Message status/ }).check();
  const status = (label: string, value: string) =>
    page.getByRole('checkbox', { name: `${label} (${value})`, exact: true });
  const allButFailed = [
    ['Accepted by WhatsApp', 'accepted'],
    ['Sent', 'sent'],
    ['Delivered', 'delivered'],
    ['Read', 'read'],
    ['Played', 'played'],
    ['Canceled', 'canceled'],
    ['Outcome unknown', 'unknown_outcome'],
  ] as const;
  for (const [label, value] of allButFailed) await status(label, value).uncheck();
  await expect(status('Failed', 'failed')).toBeChecked();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();
  await page.reload();
  await expect(page.getByText('Message statuses sent: Failed', { exact: true })).toBeVisible();

  // On the endpoint's page, delivered statuses too.
  await page.getByRole('link', { name: `Deliveries and settings for ${HOST}` }).click();
  await expect(page.getByRole('heading', { name: `Deliveries to ${HOST}` })).toBeVisible();
  const endpointPage = page.url();
  await expect(status('Failed', 'failed')).toBeChecked();
  await expect(status('Delivered', 'delivered')).not.toBeChecked();
  await status('Delivered', 'delivered').check();
  // …only for the messages the API sends (ADR-172).
  const notTheApi = [
    ['Members', 'agent'],
    ['Automations', 'bot'],
    ['Campaigns', 'campaign'],
    ['HyFib (store order updates and satisfaction surveys)', 'system'],
  ] as const;
  for (const [label, value] of notTheApi) await status(label, value).uncheck();
  await expect(status('The API', 'api')).toBeChecked();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Save endpoint' }).click();
  await expect(page.getByText('Endpoint saved.')).toBeVisible();
  await page.goto(`/c/${slug}/settings/webhooks`);
  await expect(
    page.getByText('Message statuses sent: Delivered, Failed', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Statuses of messages sent by: The API', { exact: true }),
  ).toBeVisible();

  // An API key adds an endpoint for read statuses only; statuses need the message.status event.
  await page.goto(`/c/${slug}/settings/api-keys`);
  await page.getByLabel('Name', { exact: true }).fill('Status connector');
  await page.getByRole('checkbox', { name: /Manage webhook endpoints/ }).check();
  await page.getByRole('checkbox', { name: /Reply with text/ }).check();
  await page.getByRole('button', { name: 'Create API key' }).click();
  const token = await page.getByLabel('API key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I have stored the key' }).click();
  const auth = { Authorization: `Bearer ${token}` };
  const addEndpoint = (events: string[]) =>
    request.post('/api/v1/webhook-endpoints', {
      headers: { ...auth, 'Idempotency-Key': randomUUID() },
      data: { url: `http://${HOST}:${port}${apiPath}`, events, messageStatuses: ['read'] },
    });
  const refused = await addEndpoint(['message.received']);
  expect(refused.status()).toBe(422);
  expect(((await refused.json()) as { error: { issues: unknown } }).error.issues).toEqual([
    {
      path: 'messageStatuses',
      message: 'Choose message statuses only for an endpoint that receives Message status.',
    },
  ]);
  const added = await addEndpoint(['message.status']);
  expect(added.status()).toBe(201);
  const endpoint = (
    (await added.json()) as { data: { id: string; messageStatuses: string[] | null } }
  ).data;
  expect(endpoint.messageStatuses).toEqual(['read']);

  // A customer writes; the key replies, and WhatsApp reports the reply sent, delivered and read.
  const waId = randomWaId();
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, waId, 'Has it shipped?'));
  await page.goto(`/c/${slug}/inbox`);
  await expect(page.getByRole('link', { name: /Priya Customer/ })).toBeVisible({ timeout: 20_000 });
  const sent = await request.post('/api/v1/messages', {
    headers: { ...auth, 'Idempotency-Key': randomUUID() },
    data: { type: 'text', to: `+${waId}`, text: 'It ships today.' },
  });
  expect(sent.status()).toBe(201);
  const replyId = ((await sent.json()) as { data: { id: string } }).data.id;
  const reached = (next: string) =>
    expect(async () => {
      const res = await request.get(`/api/v1/messages/${replyId}`, { headers: auth });
      expect(((await res.json()) as { data: { status: string } }).data.status).toBe(next);
    }).toPass({ timeout: 30_000 });
  await reached('accepted');
  const wamid = (await standInRequests(request))
    .filter(
      (r) =>
        r.path === `/v26.0/${phoneNumberId}/messages` &&
        (r.body as { to?: string } | null)?.to === waId,
    )
    .pop()?.wamid;
  expect(wamid).toBeTruthy();
  // One at a time: statuses only move forward, so a late delivered would never be applied.
  for (const next of ['sent', 'delivered', 'read'] as const) {
    await sendSignedWebhook(request, statusUpdate(wabaId, phoneNumberId, wamid!, next, waId));
    await reached(next);
  }

  // Each endpoint has one delivery, for its status; nothing was queued for accepted or sent.
  await expect(async () => expect(forUs()).toHaveLength(1)).toPass({ timeout: 30_000 });
  expect(JSON.parse(forUs()[0]!.body)).toMatchObject({
    type: 'message.status',
    data: { message: { id: replyId, status: 'delivered', sentBy: 'api' } },
  });
  await expect(async () => expect(viaApi()).toHaveLength(1)).toPass({ timeout: 30_000 });
  expect(JSON.parse(viaApi()[0]!.body)).toMatchObject({
    type: 'message.status',
    data: { message: { id: replyId, status: 'read' } },
  });
  const history = await request.get(`/api/v1/webhook-endpoints/${endpoint.id}/deliveries`, {
    headers: auth,
  });
  expect(
    ((await history.json()) as { data: { eventType: string; status: string }[] }).data.map((d) => [
      d.eventType,
      d.status,
    ]),
  ).toEqual([['message.status', 'succeeded']]);
  // The reply's statuses refresh the live inbox, so the endpoint's page is loaded again if a
  // refresh interrupts the load (see openFromNav).
  const deliveries = page.getByRole('list', { name: 'Deliveries' }).getByRole('listitem');
  await expect(async () => {
    await page.goto(endpointPage);
    await expect(deliveries).toHaveCount(1, { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await expect(deliveries.filter({ hasText: 'message.status' })).toHaveCount(1);

  // Settings show what the key chose; the key then takes every status again.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await expect(page.getByText('Message statuses sent: Read', { exact: true })).toBeVisible();
  const every = await request.patch(`/api/v1/webhook-endpoints/${endpoint.id}`, {
    headers: auth,
    data: { messageStatuses: null },
  });
  expect(every.status()).toBe(200);
  expect(
    ((await every.json()) as { data: { messageStatuses: unknown } }).data.messageStatuses,
  ).toBe(null);
  await page.reload();
  await expect(page.getByText('Message statuses sent: Read', { exact: true })).toHaveCount(0);
  await expect(
    page.getByText('Message statuses sent: Delivered, Failed', { exact: true }),
  ).toBeVisible();

  // Every status and sender ticked in settings takes every status of every message.
  await page.goto(endpointPage);
  await expect(status('The API', 'api')).toBeChecked();
  await expect(status('Members', 'agent')).not.toBeChecked();
  for (const [label, value] of allButFailed) await status(label, value).check();
  for (const [label, value] of notTheApi) await status(label, value).check();
  await page.getByRole('button', { name: 'Save endpoint' }).click();
  await expect(page.getByText('Endpoint saved.')).toBeVisible();
  await page.goto(`/c/${slug}/settings/webhooks`);
  await expect(page.getByText(`http://${HOST}:${port}${path}`)).toBeVisible();
  await expect(page.getByText(/^Message statuses sent:/)).toHaveCount(0);
  await expect(page.getByText(/^Statuses of messages sent by:/)).toHaveCount(0);
});

test('an endpoint receives only the contact changes it takes: chosen in settings and on its page (ADR-123)', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('parthooks');
  const slug = `parthooks-${Date.now().toString(36)}`;
  const emailsPath = `/hooks/${slug}/emails`;
  const everyPath = `/hooks/${slug}/every`;
  const updatesAt = (path: string) =>
    received
      .filter((r) => r.path === path && r.headers['w360-event-type'] === 'contact.updated')
      .map((r) => (JSON.parse(r.body) as { data: { changes: string[] | null } }).data.changes);
  await signUpAndVerify(page, { name: 'Pia Parts', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Part Works');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // Settings → Webhooks: contact changes, emails only; then an endpoint taking every change.
  const part = (label: string, value: string) =>
    page.getByRole('checkbox', { name: `${label} (${value})`, exact: true });
  const allButEmail = [
    ['Name', 'name'],
    ['Number', 'phone'],
    ['Tags', 'tags'],
    ['Custom field values', 'fields'],
  ] as const;
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${emailsPath}`);
  await page.getByRole('checkbox', { name: /Contact changed/ }).check();
  for (const [label, value] of allButEmail) await part(label, value).uncheck();
  await expect(part('Email', 'email')).toBeChecked();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${everyPath}`);
  await page.getByRole('checkbox', { name: /Contact changed/ }).check();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();
  await page.reload();
  const endpoints = page.getByRole('list', { name: 'Endpoints' }).getByRole('listitem');
  const emailsItem = endpoints.filter({ hasText: emailsPath });
  await expect(emailsItem.getByText('Contact changes sent: Email', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Contact changes sent:/)).toHaveCount(1);

  // A customer writes; a member tags the contact, then changes its email.
  const waId = randomWaId();
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, waId, 'Hello'));
  await page.goto(`/c/${slug}/inbox`);
  await expect(page.getByRole('link', { name: /Priya Customer/ })).toBeVisible({ timeout: 20_000 });
  await openFromNav(page, 'Contacts');
  await expect(page).toHaveURL(new RegExp(`/c/${slug}/contacts$`));
  await page.getByRole('link', { name: 'Priya Customer' }).click();
  await expect(page.getByRole('heading', { name: 'Priya Customer', level: 1 })).toBeVisible();
  await page.getByLabel('Add tags').fill('vip');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(async () => expect(updatesAt(everyPath)).toHaveLength(1)).toPass({
    timeout: 30_000,
  });
  await page.getByLabel('Email (optional)').fill('priya@example.test');
  await page.getByRole('button', { name: 'Save contact' }).click();
  await expect(async () => expect(updatesAt(everyPath)).toHaveLength(2)).toPass({
    timeout: 30_000,
  });
  await expect(async () => expect(updatesAt(emailsPath)).toHaveLength(1)).toPass({
    timeout: 30_000,
  });
  expect(updatesAt(everyPath)).toEqual([['tags'], ['email']]);
  expect(updatesAt(emailsPath)).toEqual([['email']]);

  // Deliveries are queued when a change is saved: the emails endpoint has none for the tag.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await emailsItem.getByRole('link', { name: `Deliveries and settings for ${HOST}` }).click();
  await expect(page.getByRole('heading', { name: `Deliveries to ${HOST}` })).toBeVisible();
  const deliveries = page.getByRole('list', { name: 'Deliveries' }).getByRole('listitem');
  await expect(deliveries).toHaveCount(1);
  await expect(deliveries.filter({ hasText: 'contact.updated' })).toHaveCount(1);

  // On its page, tags too; then every part, which takes every change (none listed).
  await expect(part('Email', 'email')).toBeChecked();
  await expect(part('Tags', 'tags')).not.toBeChecked();
  await part('Tags', 'tags').check();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Save endpoint' }).click();
  await expect(page.getByText('Endpoint saved.')).toBeVisible();
  const endpointPage = page.url();
  await page.goto(`/c/${slug}/settings/webhooks`);
  await expect(
    emailsItem.getByText('Contact changes sent: Email, Tags', { exact: true }),
  ).toBeVisible();
  await page.goto(endpointPage);
  for (const [label, value] of allButEmail) await part(label, value).check();
  await page.getByRole('button', { name: 'Save endpoint' }).click();
  await expect(page.getByText('Endpoint saved.')).toBeVisible();
  await page.goto(`/c/${slug}/settings/webhooks`);
  await expect(emailsItem).toBeVisible();
  await expect(page.getByText(/^Contact changes sent:/)).toHaveCount(0);
});
