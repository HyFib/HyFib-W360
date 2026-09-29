import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { APIRequestContext, Page } from '@playwright/test';
import { whatsappFlowRequest } from '../support/flow-request';
import { expect, test } from './fixtures';
import {
  connectTestChannel,
  flowCompletion,
  inboundMessage,
  messagingConfigured,
  randomWaId,
  sendSignedWebhook,
  standInRequests,
} from './messaging-support';
import { expectNoHorizontalOverflow, openFromNav, signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';
/** A host name that resolves to 127.0.0.1 on the test machine (see web-requests.spec.ts). */
const HOST = process.env.E2E_HTTP_HOST ?? '';

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');

/** A flow that fetches data from the company's endpoint when its button is pressed. */
const BOOKING_JSON = JSON.stringify(
  {
    version: '7.1',
    data_api_version: '3.0',
    routing_model: { APPOINTMENT: [] },
    screens: [
      {
        id: 'APPOINTMENT',
        title: 'Book a visit',
        terminal: true,
        data: {},
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'DatePicker', name: 'date', label: 'Date', required: true },
            {
              type: 'Footer',
              label: 'Book',
              'on-click-action': { name: 'data_exchange', payload: { date: '${form.date}' } },
            },
          ],
        },
      },
    ],
  },
  null,
  2,
);

async function newCompany(page: Page, prefix: string, name: string) {
  const email = uniqueEmail(prefix);
  const slug = `${prefix}-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name, email, password: PASSWORD });
  await page.getByLabel('Company name').fill(`${name}'s Company`);
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const channel = await connectTestChannel({ ownerEmail: email, slug });
  return { slug, ...channel };
}

/** Reloads until the worker has done its part at Meta and the page shows `text`. */
async function reloadUntil(page: Page, text: string | RegExp) {
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(text).first()).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

/** The flow message WhatsApp received for `to`, once the worker has sent it. */
async function flowMessageTo(request: APIRequestContext, to: string) {
  type Sent = {
    wamid?: string;
    body: { to?: string; type?: string; interactive?: Record<string, unknown> };
  };
  let found: Sent | undefined;
  await expect
    .poll(
      async () => {
        found = ((await standInRequests(request)) as Sent[]).find(
          (r) => r.body?.to === to && r.body.interactive?.type === 'flow',
        );
        return Boolean(found?.wamid);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const sent = found!;
  const action = sent.body.interactive!.action as { parameters: Record<string, string> };
  const token = action.parameters.flow_token;
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return { wamid: sent.wamid!, parameters: action.parameters, token: token! };
}

test('a form is checked by Meta, published, sent in a chat and its answers saved on the contact', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const { wabaId, phoneNumberId } = await newCompany(page, 'flows', 'Farah Flows');

  // Flows → New flow: the starter form is checked while it is edited.
  await openFromNav(page, 'Flows');
  await expect(page.getByText('No flows yet')).toBeVisible();
  await page.getByRole('link', { name: 'New flow' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Lead form');
  await expect(
    page.getByText('Version 7.1 · screens: DETAILS · answers: email, full_name'),
  ).toBeVisible();
  const json = page.getByLabel('Flow JSON');
  const starter = await json.inputValue();
  await json.fill(starter.replace('"terminal": true', '"terminal": false'));
  await expect(page.getByText(/Mark at least one screen as terminal/)).toBeVisible();
  const create = page.getByRole('button', { name: 'Create and send to Meta' });
  await expect(create).toBeDisabled();
  await json.fill(starter);
  await create.click();

  // The worker creates the flow at Meta and uploads the JSON as written.
  await expect(page.getByRole('heading', { name: 'Lead form' })).toBeVisible();
  await reloadUntil(page, 'Draft at Meta');
  const created = (await standInRequests(request)).find(
    (r) => r.method === 'POST' && r.path.endsWith(`/${wabaId}/flows`),
  );
  expect((created?.body as { name?: string }).name).toMatch(/^Lead form \(w360 [a-z2-7]{8}\)$/);

  // The answers go to the contact's name and email.
  await page.getByLabel('Answer “full_name”').selectOption({ label: 'Save as the contact’s name' });
  await page.getByLabel('Answer “email”').selectOption({ label: 'Save as the contact’s email' });
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();

  // Publishing is final at Meta, so it is confirmed first.
  await page.reload();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText(/Publishing cannot be undone/)).toBeVisible();
  await page.getByRole('button', { name: 'Yes, publish' }).click();
  await reloadUntil(page, /^Published$/);
  await expect(page.getByRole('button', { name: 'Make a new draft from it' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Flow JSON' })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // A customer writes; the form is sent in the conversation while the service window is open.
  const customer = randomWaId();
  await sendSignedWebhook(
    request,
    inboundMessage(wabaId, phoneNumberId, customer, 'Please call me back'),
  );
  await openFromNav(page, 'Inbox');
  await page.getByRole('link', { name: /Priya Customer/ }).click({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Send a form' })).toBeVisible();
  await page.getByLabel('Form', { exact: true }).selectOption({ label: 'Lead form' });
  await page.getByLabel('Heading (optional)').fill('Callback');
  await page.getByRole('button', { name: 'Send form' }).click();
  await expect(page.getByText('Form sent.')).toBeVisible();
  const thread = page.getByRole('list', { name: /^Messages with/ });
  await expect(thread.getByText('Form: Lead form')).toBeVisible();

  // WhatsApp receives a flow message with a token only HyFib knows (research M-165).
  const sent = await flowMessageTo(request, customer);
  expect(sent.parameters).toMatchObject({
    flow_message_version: '3',
    mode: 'published',
    flow_cta: 'Open form',
    flow_action: 'navigate',
  });

  // The customer completes the form: the answers appear in the chat and update the contact.
  await sendSignedWebhook(
    request,
    flowCompletion(
      wabaId,
      phoneNumberId,
      customer,
      { flow_token: sent.token, full_name: 'Asha Rao', email: 'Asha@Example.com' },
      sent.wamid,
    ),
  );
  await expect(thread.getByText('Form submitted')).toBeVisible({ timeout: 20_000 });
  await expect(thread.getByText('Asha@Example.com')).toBeVisible();
  await expect(thread.getByText(sent.token)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Asha Rao' })).toBeVisible({ timeout: 20_000 });

  // The flow page lists the completed form and what was saved.
  await openFromNav(page, 'Flows');
  await page.getByRole('link', { name: 'Lead form' }).click();
  const completed = page.getByRole('table').last();
  await expect(completed).toContainText('Asha Rao');
  await expect(completed).toContainText('full_name: Asha Rao');
  await expect(completed).toContainText('the contact’s email: saved');
  await expect(page.getByText('1 · 1 · 1')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test.describe('the encrypted data endpoint', () => {
  test.skip(
    !HOST || process.env.W360_EGRESS_ALLOW_LOOPBACK !== 'true',
    'Endpoint target not provided (E2E_HTTP_HOST resolving to 127.0.0.1, W360_EGRESS_ALLOW_LOOPBACK)',
  );

  /** The company's own endpoint, which HyFib forwards decrypted requests to. */
  let target: Server;
  let port = 0;
  const received: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];

  test.beforeAll(async () => {
    target = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        received.push({ url: req.url ?? '', headers: req.headers, body });
        const parsed = JSON.parse(body) as { flow_token: string };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            screen: 'SUCCESS',
            data: { extension_message_response: { params: { flow_token: parsed.flow_token } } },
          }),
        );
      });
    });
    target.listen(0, '127.0.0.1');
    await once(target, 'listening');
    port = (target.address() as AddressInfo).port;
  });

  test.afterAll(() => {
    target?.close();
  });

  test('checks the signature, decrypts with the account key and forwards to the company', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const { slug, wabaId, phoneNumberId } = await newCompany(page, 'flowapi', 'Dev Endpoint');
    const secret = `e2e-forms-${Date.now().toString(36)}`;

    // The company's endpoint must be on an allowed domain; its token is sent to that domain only.
    await page.goto(`/c/${slug}/settings/web-requests`);
    await page.getByLabel('Domain', { exact: true }).fill(HOST);
    await page.getByRole('button', { name: 'Allow domain' }).click();
    await expect(page.getByText(`${HOST} is allowed.`)).toBeVisible();
    await page.getByLabel('Name', { exact: true }).fill('forms_key');
    await page.getByLabel('Value', { exact: true }).fill(secret);
    await page.getByRole('button', { name: 'Save secret' }).click();
    await expect(page.getByText('Secret “forms_key” saved.')).toBeVisible();

    // A flow that fetches data: HyFib generates the account's key and uploads it to the number.
    await page.goto(`/c/${slug}/flows/new`);
    await page.getByLabel('Name', { exact: true }).fill('Booking');
    await page.getByLabel('Flow JSON').fill(BOOKING_JSON);
    await expect(page.getByText(/fetches data from your endpoint/)).toBeVisible();
    await page.getByRole('button', { name: 'Create and send to Meta' }).click();
    await expect(page.getByRole('heading', { name: 'Booking' })).toBeVisible();
    await reloadUntil(page, 'Uploaded, signature valid');
    await reloadUntil(page, 'Draft at Meta');
    await page.getByLabel('Your endpoint address').fill(`http://${HOST}:${port}/whatsapp-flows`);
    await page.getByLabel('Secret sent as a bearer token (optional)').selectOption('forms_key');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // WhatsApp calls HyFib's address for this flow (registered at Meta as its endpoint_uri).
    const address = (await page
      .locator('code')
      .filter({ hasText: '/api/flows/endpoint/' })
      .textContent())!;
    const path = new URL(address).pathname;
    const created = (await standInRequests(request)).find(
      (r) => r.method === 'POST' && r.path.endsWith(`/${wabaId}/flows`),
    );
    expect((created?.body as { endpoint_uri?: string }).endpoint_uri).toBe(address);
    const upload = (await standInRequests(request)).find(
      (r) =>
        r.method === 'POST' && r.path.endsWith(`/${phoneNumberId}/whatsapp_business_encryption`),
    );
    const publicKey = (upload?.body as { business_public_key: string }).business_public_key;
    const appSecret = process.env.META_APP_SECRET!;
    const post = (req: ReturnType<typeof whatsappFlowRequest>, signature = req.signature) =>
      request.post(path, {
        data: req.rawBody,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      });

    // A health check is answered by HyFib, encrypted with the request's key.
    const ping = whatsappFlowRequest(publicKey, { version: '3.0', action: 'ping' }, appSecret);
    const pong = await post(ping);
    expect(pong.status()).toBe(200);
    expect(pong.headers()['cache-control']).toContain('no-store');
    expect(ping.open(await pong.text())).toEqual({ data: { status: 'active' } });
    // A request not signed with the app secret is refused (research M-167).
    expect((await post(ping, `sha256=${'0'.repeat(64)}`)).status()).toBe(432);
    // A token HyFib did not issue is refused with a message WhatsApp shows.
    const stranger = whatsappFlowRequest(
      publicKey,
      { version: '3.0', action: 'INIT', flow_token: 'x'.repeat(43) },
      appSecret,
    );
    const refused = await post(stranger);
    expect(refused.status()).toBe(427);
    expect(stranger.open(await refused.text())).toEqual({
      error_msg: 'This form is no longer available.',
    });

    // Members who edit flows can send the draft to test it; its token opens the endpoint.
    const customer = randomWaId();
    await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, customer, 'Book me in'));
    await openFromNav(page, 'Inbox');
    await page.getByRole('link', { name: /Priya Customer/ }).click({ timeout: 20_000 });
    await page
      .getByLabel('Form', { exact: true })
      .selectOption({ label: 'Booking (draft, for testing)' });
    await page.getByRole('button', { name: 'Send form' }).click();
    await expect(page.getByText('Form sent.')).toBeVisible();
    const sent = await flowMessageTo(request, customer);
    expect(sent.parameters.mode).toBe('draft');

    const exchange = whatsappFlowRequest(
      publicKey,
      {
        version: '3.0',
        action: 'data_exchange',
        screen: 'APPOINTMENT',
        data: { date: '2026-10-01' },
        flow_token: sent.token,
      },
      appSecret,
    );
    const answered = await post(exchange);
    expect(answered.status()).toBe(200);
    expect(exchange.open(await answered.text())).toEqual({
      screen: 'SUCCESS',
      data: { extension_message_response: { params: { flow_token: sent.token } } },
    });
    // The company received the decrypted request as JSON, with its token and the contact.
    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe('/whatsapp-flows');
    expect(received[0]!.headers.authorization).toBe(`Bearer ${secret}`);
    expect(JSON.parse(received[0]!.body)).toMatchObject({
      version: '3.0',
      action: 'data_exchange',
      screen: 'APPOINTMENT',
      data: { date: '2026-10-01' },
      flow_token: sent.token,
      flow: { name: 'Booking' },
      contact: { name: 'Priya Customer', phone: `+${customer}` },
    });
  });
});
