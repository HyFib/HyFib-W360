import { createHmac, timingSafeEqual } from 'node:crypto';
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
import { signUpAndVerify, uniqueEmail } from './support';

const PASSWORD = 'correct horse battery staple 42';
/** Resolves to 127.0.0.1 on the test machine; see webhooks.spec.ts. */
const HOST = process.env.E2E_HTTP_HOST ?? '';

test.skip(!messagingConfigured, 'Meta test configuration (stand-in, app secret) not provided');
test.skip(
  !HOST || process.env.W360_EGRESS_ALLOW_LOOPBACK !== 'true',
  'Webhook receiver not provided (E2E_HTTP_HOST resolving to 127.0.0.1, W360_EGRESS_ALLOW_LOOPBACK)',
);

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

/** A delivered event body, as far as this test reads it. */
interface EventBody {
  type: string;
  data: { contact?: { id: string } } & Record<string, unknown>;
}

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

test('conversation and contact events reach an endpoint: a customer writes, a member resolves, tags and erases', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('hookev');
  const slug = `hookev-${Date.now().toString(36)}`;
  const path = `/events/${slug}`;
  const forUs = () =>
    received
      .filter((r) => r.path === path)
      .map((r) => ({ ...r, json: JSON.parse(r.body) as EventBody }));
  await signUpAndVerify(page, { name: 'Esha Events', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Event Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // An endpoint for conversation status and the three contact events.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${path}`);
  for (const name of [
    /Conversation status/,
    /Contact added/,
    /Contact changed/,
    /Contact erased/,
  ]) {
    await page.getByRole('checkbox', { name }).check();
  }
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  const secretField = page.getByLabel('Signing secret');
  await expect(secretField).toBeVisible();
  const secret = await secretField.inputValue();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();

  // A customer writes for the first time: the contact is added.
  const waId = randomWaId();
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, waId, 'Hello there'));
  await expect(async () => expect(forUs()).toHaveLength(1)).toPass({ timeout: 30_000 });
  const added = forUs()[0]!;
  expect(signatureValid(added.headers, added.body, secret)).toBe(true);
  expect(added.headers['w360-event-type']).toBe('contact.created');
  expect(added.json).toMatchObject({
    type: 'contact.created',
    data: {
      contact: { phone: `+${waId}`, name: 'Priya Customer', source: 'whatsapp', erased: false },
    },
  });
  const contactId = added.json.data.contact!.id;

  // A member resolves the conversation in the inbox.
  await page.goto(`/c/${slug}/inbox`);
  await page.getByRole('link', { name: /Priya Customer/ }).click();
  await expect(page.getByText('Hello there')).toBeVisible();
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(async () => expect(forUs()).toHaveLength(2)).toPass({ timeout: 30_000 });
  const resolved = forUs()[1]!;
  expect(signatureValid(resolved.headers, resolved.body, secret)).toBe(true);
  expect(resolved.json).toMatchObject({
    type: 'conversation.status_changed',
    data: {
      conversation: { status: 'resolved', previousStatus: 'open', assigned: false },
      contact: { id: contactId, phone: `+${waId}` },
    },
  });

  // A member tags the contact: one change.
  await page.goto(`/c/${slug}/contacts`);
  await page.getByRole('link', { name: 'Priya Customer' }).click();
  await expect(page.getByRole('heading', { name: 'Priya Customer', level: 1 })).toBeVisible();
  await page.getByLabel('Add tags').fill('vip, repeat');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(async () => expect(forUs()).toHaveLength(3)).toPass({ timeout: 30_000 });
  expect(forUs()[2]!.json).toMatchObject({
    type: 'contact.updated',
    data: { contact: { id: contactId, tags: ['repeat', 'vip'], erased: false } },
  });

  // Erasing sends one event, without personal data (the tags it removes send nothing).
  await page.getByRole('button', { name: 'Erase contact' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Erase contact' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}/contacts$`));
  await expect(async () => expect(forUs()).toHaveLength(4)).toPass({ timeout: 30_000 });
  const erased = forUs()[3]!;
  expect(signatureValid(erased.headers, erased.body, secret)).toBe(true);
  expect(erased.json).toMatchObject({
    type: 'contact.erased',
    data: {
      contact: { id: contactId, name: null, phone: null, email: null, tags: [], erased: true },
    },
  });
  expect(erased.body).not.toContain(waId);
  expect(erased.body).not.toContain('Priya');
  // Nothing else arrives for these changes.
  await page.goto(`/c/${slug}/settings/webhooks`);
  expect(forUs()).toHaveLength(4);
});

/** An automation run event body, as far as this test reads it. */
interface RunEventBody {
  type: string;
  data: {
    run: { id: string; trigger: string } & Record<string, unknown>;
    conversation: { id: string };
    contact: { phone: string | null } & Record<string, unknown>;
  };
}

test('automation run events reach an endpoint: a live run starts and ends, and a member’s test run sends nothing', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('hookrun');
  const slug = `hookrun-${Date.now().toString(36)}`;
  const path = `/runs/${slug}`;
  const forUs = () =>
    received
      .filter((r) => r.path === path)
      .map((r) => ({ ...r, json: JSON.parse(r.body) as RunEventBody }));
  await signUpAndVerify(page, { name: 'Ravi Runs', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Run Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // An endpoint for the two automation events.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${path}`);
  await page.getByRole('checkbox', { name: /Automation started/ }).check();
  await page.getByRole('checkbox', { name: /Automation ended/ }).check();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  const secretField = page.getByLabel('Signing secret');
  await expect(secretField).toBeVisible();
  const secret = await secretField.inputValue();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();

  // A published automation greets a customer who writes "hello".
  await page.goto(`/c/${slug}/automations`);
  await page.getByLabel('Name', { exact: true }).fill('Greeter');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Greeter' })).toBeVisible();
  const automationUrl = page.url();
  await page.getByLabel('Start when').selectOption('keyword');
  await page.getByLabel('Keywords').fill('hello');
  await page.locator('#step-welcome-text').fill('Hi {{name}}, thanks for writing!');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published.')).toBeVisible();

  // A customer writes "hello": the worker runs the automation, which greets them and ends.
  const first = randomWaId();
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, first, 'hello'));
  await expect(async () => expect(forUs()).toHaveLength(2)).toPass({ timeout: 30_000 });
  for (const event of forUs()) {
    expect(signatureValid(event.headers, event.body, secret)).toBe(true);
    expect(event.headers['w360-event-type']).toBe(event.json.type);
  }
  const started = forUs().find((e) => e.json.type === 'automation.run_started')!.json;
  const ended = forUs().find((e) => e.json.type === 'automation.run_ended')!.json;
  expect(started.data).toMatchObject({
    run: {
      automationName: 'Greeter',
      trigger: 'keyword',
      apiKeyId: null,
      status: 'running',
      endReason: null,
      endedAt: null,
    },
    contact: { phone: `+${first}`, name: 'Priya Customer' },
  });
  expect(ended.data).toMatchObject({
    run: { id: started.data.run.id, trigger: 'keyword', status: 'completed', endReason: 'no_next' },
    conversation: started.data.conversation,
  });

  // A member tests the draft in that conversation: the test greets the customer and ends.
  await page.goto(automationUrl);
  await page.getByRole('button', { name: 'Start test run' }).click();
  await expect(page.getByText('Test started.')).toBeVisible();
  await expect
    .poll(
      async () =>
        (await standInRequests(request)).filter(
          (r) =>
            (r.body as { to?: string; type?: string })?.to === first &&
            (r.body as { type?: string }).type === 'text',
        ).length,
      { timeout: 30_000 },
    )
    .toBe(2);
  const testRun = page.locator('li').filter({ hasText: /Test$/ });
  await expect(async () => {
    await page.goto(automationUrl);
    await expect(testRun).toContainText('Completed', { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });

  // It sent nothing: another customer's run brings only its own two events.
  const second = randomWaId();
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, second, 'hello'));
  await expect(async () => expect(forUs()).toHaveLength(4)).toPass({ timeout: 30_000 });
  expect(
    forUs()
      .slice(2)
      .map((e) => [e.json.type, e.json.data.run.trigger, e.json.data.contact.phone])
      .sort(),
  ).toEqual([
    ['automation.run_ended', 'keyword', `+${second}`],
    ['automation.run_started', 'keyword', `+${second}`],
  ]);
});
