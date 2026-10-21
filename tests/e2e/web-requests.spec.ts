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
} from './messaging-support';
import { expectNoHorizontalOverflow, signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';
const SECRET = `e2e-shop-token-${Date.now().toString(36)}`;
/**
 * A host name that resolves to 127.0.0.1 on the test machine (CI adds it to /etc/hosts); the web
 * and worker must allow loopback egress, which only APP_ENV=local|test permits.
 */
const HOST = process.env.E2E_HTTP_HOST ?? '';

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');
test.skip(
  !HOST || process.env.W360_EGRESS_ALLOW_LOOPBACK !== 'true',
  'Web request target not provided (E2E_HTTP_HOST resolving to 127.0.0.1, W360_EGRESS_ALLOW_LOOPBACK)',
);

/** The company's own API, as the automation calls it. */
let target: Server;
let port = 0;
const received: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = [];

test.beforeAll(async () => {
  target = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req-e2e-1' });
      res.end(JSON.stringify({ data: { status: 'shipped' } }));
    });
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  port = (target.address() as AddressInfo).port;
});

test.afterAll(() => {
  target?.close();
});

test('an automation calls the company API with a stored secret and answers with the result', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('web');
  const slug = `web-${Date.now().toString(36)}`;
  await signUpAndVerify(page, { name: 'Wren Web', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Web Wares');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // Settings → Web requests: allow the API's domain and store its token for that domain only.
  await page.goto(`/c/${slug}/settings/web-requests`);
  await expect(page.getByRole('heading', { name: 'Allowed domains' })).toBeVisible();
  await expect(page.getByText('Allow a domain first')).toBeVisible();
  await page.getByLabel('Domain', { exact: true }).fill(HOST.toUpperCase());
  await page.getByRole('button', { name: 'Allow domain' }).click();
  await expect(page.getByText(`${HOST} is allowed.`)).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('shop_token');
  await expect(page.getByLabel('Send only to')).toHaveValue(HOST);
  await page.getByLabel('Value', { exact: true }).fill(SECRET);
  await page.getByRole('button', { name: 'Save secret' }).click();
  await expect(page.getByText('Secret “shop_token” saved.')).toBeVisible();
  await expect(page.getByLabel('Value', { exact: true })).toHaveValue('');
  await expect(page.getByText('sent only to')).toBeVisible();
  // The value is never sent back to a browser.
  expect(await page.content()).not.toContain(SECRET);
  await expectNoHorizontalOverflow(page);

  // An automation: acknowledge, call the API, tell the customer the result (or hand over).
  await page.goto(`/c/${slug}/automations`);
  await page.getByLabel('Name', { exact: true }).fill('Order lookup');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Order lookup' })).toBeVisible();
  await page.getByLabel('Start when').selectOption('keyword');
  await page.getByLabel('Keywords').fill('order');
  await page.locator('#step-welcome-text').fill('Checking your order, {{name}}.');
  await page.getByLabel('Add a step').selectOption('http_request');
  await page.getByRole('button', { name: 'Add step' }).click();
  const path = `/orders/${slug}`;
  const url = `http://${HOST}:${port}${path}`;
  const calledHere = () => received.filter((r) => r.url === path);
  await page.locator('#step-http-request-1-url').fill(url);
  // With a secret stored, the first header offered is its bearer token.
  await page.getByRole('button', { name: 'Add header' }).click();
  await expect(page.locator('#step-http-request-1-header-0-value')).toHaveValue(
    'Bearer {{secret.shop_token}}',
  );
  await page.locator('#step-http-request-1-body').fill('{"customer": "{{name}}"}');
  await page.getByRole('button', { name: 'Add value' }).click();
  await page.locator('#step-http-request-1-save-0-as').fill('status');
  // A header and the status code saved too (ADR-406); a cookie is refused, and says why.
  await page.getByRole('button', { name: 'Add value' }).click();
  await page.getByLabel('Value 2 from', { exact: true }).selectOption('header');
  const header = page.getByLabel('Value 2 header', { exact: true });
  await header.fill('Set-Cookie');
  await expect(
    page
      .getByText(
        'The Set-Cookie header can carry credentials or a session, so HyFib does not save it.',
      )
      .first(),
  ).toBeVisible();
  await header.fill('X-Request-Id');
  await page.locator('#step-http-request-1-save-1-as').fill('ref');
  await page.getByRole('button', { name: 'Add value' }).click();
  await page.getByLabel('Value 3 from', { exact: true }).selectOption('status');
  await expect(page.getByLabel('Value 3 path', { exact: true })).toHaveCount(0);
  await page.locator('#step-http-request-1-save-2-as').fill('code');
  await page.getByLabel('Add a step').selectOption('send_text');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page
    .locator('#step-send-text-1-text')
    .fill('Your order is {{answer.status}} ({{answer.code}}, {{answer.ref}}).');
  await page.getByLabel('Add a step').selectOption('handoff');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.locator('#step-welcome-next').selectOption('http-request-1');
  await page.locator('#step-http-request-1-next').selectOption('send-text-1');
  await page.locator('#step-http-request-1-failure').selectOption('handoff-1');
  await expect(page.getByText(/to fix before publishing/)).toBeHidden();
  await expect(page.getByRole('img', { name: /Diagram of 4 steps/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // The simulator shows the request it would make and lets the tester choose the result.
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByText('Checking your order, Asha.')).toBeVisible();
  await expect(page.getByText('Web request (not sent in the simulator)')).toBeVisible();
  await expect(page.getByText(`POST ${url}`)).toBeVisible();
  await expect(page.getByText('Authorization: Bearer {{secret.shop_token}}')).toBeVisible();
  await page.getByLabel('status (from data.status)').fill('packed');
  await page.getByLabel('ref (from the X-Request-Id header)').fill('sim-1');
  await page.getByLabel('code (from the status code)').fill('201');
  await page.getByRole('button', { name: 'Success', exact: true }).click();
  await expect(page.getByText('Your order is packed (201, sim-1).')).toBeVisible();
  expect(calledHere()).toHaveLength(0);

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published.')).toBeVisible();

  // A customer asks: the worker calls the API once, with the secret, and answers with the result.
  const customer = randomWaId();
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, customer, 'my order?'));
  const textsTo = async (to: string) =>
    (await standInRequests(request))
      // Other requests (template syncs, media) have no body.
      .map((r) => r.body as { to?: string; type?: string; text?: { body?: string } } | undefined)
      .filter((b) => b?.to === to && b.type === 'text')
      .map((b) => b?.text?.body);
  await expect
    .poll(() => textsTo(customer), { timeout: 60_000 })
    .toEqual(['Checking your order, Priya Customer.', 'Your order is shipped (200, req-e2e-1).']);
  const calls = calledHere();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.method).toBe('POST');
  expect(calls[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
  expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ customer: 'Priya Customer' });

  // The run page shows the call (host and path) and its outcome, never the secret.
  await page.goto(`/c/${slug}/automations/runs`);
  await page.getByRole('table').getByRole('link').first().click();
  await expect(page.getByRole('heading', { name: 'Run of Order lookup' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Web requests' })).toBeVisible();
  const callTable = page.getByRole('table').last();
  await expect(callTable).toContainText(`POST ${HOST}${path}`);
  await expect(callTable).toContainText('Succeeded');
  await expect(callTable).toContainText('the server answered with status 200');
  await expect(page.getByRole('table').first()).toContainText('Web request finished → success');
  expect(await page.content()).not.toContain(SECRET);
  await expectNoHorizontalOverflow(page);
});
