import { createHmac, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './fixtures';
import {
  connectTestChannel,
  inboundMessage,
  messagingConfigured,
  orderMessage,
  randomWaId,
  sendSignedWebhook,
  standInRequests,
} from './messaging-support';
import { openFromNav, signUpAndVerify, uniqueEmail } from './support';

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

test('conversation and contact events reach an endpoint: a customer writes, a member resolves, tags, renames and erases', async ({
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

  // A member tags the contact: one change. The resolved conversation refreshes itself, so it is
  // left through the navigation, not a page load (see openFromNav; `page.goto` was interrupted
  // here in WebKit on 6a3b0da).
  await openFromNav(page, 'Contacts');
  await expect(page).toHaveURL(new RegExp(`/c/${slug}/contacts$`));
  await page.getByRole('link', { name: 'Priya Customer' }).click();
  await expect(page.getByRole('heading', { name: 'Priya Customer', level: 1 })).toBeVisible();
  await page.getByLabel('Add tags').fill('vip, repeat');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(async () => expect(forUs()).toHaveLength(3)).toPass({ timeout: 30_000 });
  expect(forUs()[2]!.json).toMatchObject({
    type: 'contact.updated',
    data: { contact: { id: contactId, tags: ['repeat', 'vip'], erased: false }, changes: ['tags'] },
  });

  // A member changes the name and the email in one save: one change, naming both (ADR-121).
  await page.getByLabel('Name', { exact: true }).fill('Priya Sharma');
  await page.getByLabel('Email (optional)').fill('priya@example.test');
  await page.getByRole('button', { name: 'Save contact' }).click();
  await expect(async () => expect(forUs()).toHaveLength(4)).toPass({ timeout: 30_000 });
  expect(forUs()[3]!.json).toMatchObject({
    type: 'contact.updated',
    data: {
      contact: { id: contactId, name: 'Priya Sharma', email: 'priya@example.test' },
      changes: ['email', 'name'],
    },
  });
  await expect(page.getByRole('heading', { name: 'Priya Sharma', level: 1 })).toBeVisible();

  // Erasing sends one event, without personal data (the tags it removes send nothing).
  await page.getByRole('button', { name: 'Erase contact' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Erase contact' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}/contacts$`));
  await expect(async () => expect(forUs()).toHaveLength(5)).toPass({ timeout: 30_000 });
  const erased = forUs()[4]!;
  expect(signatureValid(erased.headers, erased.body, secret)).toBe(true);
  expect(erased.json).toMatchObject({
    type: 'contact.erased',
    data: {
      contact: { id: contactId, name: null, phone: null, email: null, tags: [], erased: true },
    },
  });
  expect(erased.body).not.toContain(waId);
  expect(erased.body).not.toContain('Priya');
  expect(erased.body).not.toContain('priya@');
  // Nothing else arrives for these changes.
  await page.goto(`/c/${slug}/settings/webhooks`);
  expect(forUs()).toHaveLength(5);
});

test('conversation team and assignment events name the team and the member: a member moves and assigns a conversation, and deleting the team sends its change', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('hookteam');
  const slug = `hookteam-${Date.now().toString(36)}`;
  const path = `/teams/${slug}`;
  const forUs = () =>
    received
      .filter((r) => r.path === path)
      .map((r) => ({ ...r, json: JSON.parse(r.body) as EventBody }));
  await signUpAndVerify(page, { name: 'Mira Moves', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Move Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // A team that assigns by hand (moving a conversation into it gives nobody the conversation).
  await page.goto(`/c/${slug}/settings/teams`);
  const form = page.locator('form', { has: page.getByRole('button', { name: 'Create team' }) });
  await form.getByLabel('Team name').fill('Returns');
  await form.getByLabel('Mira Moves').check();
  await form.getByRole('button', { name: 'Create team' }).click();
  await expect(page.getByText('Team created.')).toBeVisible();

  // An endpoint for the conversation's team and member.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${path}`);
  await page.getByRole('checkbox', { name: /Conversation assignment/ }).check();
  await page.getByRole('checkbox', { name: /Conversation team/ }).check();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  const secretField = page.getByLabel('Signing secret');
  await expect(secretField).toBeVisible();
  const secret = await secretField.inputValue();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();

  // A customer writes: the conversation has no team and no member yet, so nothing is sent.
  const waId = randomWaId();
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, waId, 'Wrong size'));
  await page.goto(`/c/${slug}/inbox`);
  const item = page.getByRole('link', { name: /Priya Customer/ });
  await expect(item).toContainText('Unassigned', { timeout: 30_000 });
  await item.click();
  await expect(page.getByText('Wrong size')).toBeVisible();
  // The conversation's controls, not the list's team filter or the CRM task form beside them.
  const teamControl = page
    .getByLabel('Team', { exact: true })
    .and(page.locator('select:not([name="team"])'));
  const assigneeControl = page
    .getByLabel('Assigned to', { exact: true })
    .filter({ has: page.getByRole('option', { name: 'Unassigned', exact: true }) });

  // Into the team: one event naming it, and the team before (none).
  const [teamId] = await teamControl.selectOption({ label: 'Returns' });
  await expect(async () => expect(forUs()).toHaveLength(1)).toPass({ timeout: 30_000 });
  const moved = forUs()[0]!;
  expect(signatureValid(moved.headers, moved.body, secret)).toBe(true);
  expect(moved.headers['w360-event-type']).toBe('conversation.team_changed');
  expect(moved.json).toMatchObject({
    type: 'conversation.team_changed',
    data: {
      conversation: { status: 'open', teamId, previousTeamId: null, assigneeId: null },
      contact: { phone: `+${waId}` },
    },
  });

  // Assigned to the member: one event naming them, and the member before (none). The team control
  // shows the move once the action's refresh arrives, with the version the next change needs.
  await expect(teamControl).toHaveValue(teamId!);
  const [memberId] = await assigneeControl.selectOption({ label: 'Mira Moves (you)' });
  await expect(async () => expect(forUs()).toHaveLength(2)).toPass({ timeout: 30_000 });
  const assigned = forUs()[1]!;
  expect(signatureValid(assigned.headers, assigned.body, secret)).toBe(true);
  expect(assigned.json).toMatchObject({
    type: 'conversation.assignment_changed',
    data: {
      conversation: { assigned: true, assigneeId: memberId, previousAssigneeId: null, teamId },
    },
  });

  // Deleting the team takes the conversation out of it: one event, and the member stays. The live
  // inbox is left through the navigation, not a page load (see openFromNav).
  await openFromNav(page, 'Settings');
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Teams' })
    .click();
  await page.locator('summary', { hasText: 'Edit Returns' }).click();
  await page.getByRole('button', { name: 'Delete… team Returns' }).click();
  await page.getByRole('button', { name: 'Delete team' }).click();
  await expect(page.getByRole('heading', { name: /Returns/ })).toHaveCount(0);
  await expect(async () => expect(forUs()).toHaveLength(3)).toPass({ timeout: 30_000 });
  const left = forUs()[2]!;
  expect(signatureValid(left.headers, left.body, secret)).toBe(true);
  expect(left.json).toMatchObject({
    type: 'conversation.team_changed',
    data: {
      conversation: { teamId: null, previousTeamId: teamId, assigneeId: memberId },
    },
  });
  // Nothing else arrives for these changes.
  await openFromNav(page, 'Inbox');
  await expect(item).toContainText('Assigned to Mira Moves');
  expect(forUs()).toHaveLength(3);
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

test('automation run events reach an endpoint: a live run starts and ends, a member’s test run sends nothing, and an endpoint can take chosen automations only', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
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

  // A second automation says goodbye to a customer who writes "bye" (ADR-145)…
  await page.goto(`/c/${slug}/automations`);
  await page.getByLabel('Name', { exact: true }).fill('Farewell');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Farewell' })).toBeVisible();
  const farewellUrl = page.url();
  await page.getByLabel('Start when').selectOption('keyword');
  await page.getByLabel('Keywords').fill('bye');
  await page.locator('#step-welcome-text').fill('Goodbye {{name}}, talk soon!');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published.')).toBeVisible();

  // …and the endpoint is changed to take only its runs.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByRole('link', { name: /Deliveries and settings/ }).click();
  await expect(page.getByRole('heading', { name: /^Deliveries to/ })).toBeVisible();
  const deliveriesUrl = page.url();
  await page.getByRole('radio', { name: /Only the runs of the automations ticked/ }).check();
  await page.getByRole('checkbox', { name: 'Farewell', exact: true }).check();
  await page.getByRole('button', { name: 'Save endpoint' }).click();
  await expect(page.getByText('Endpoint saved.')).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('radio', { name: /Only the runs of the automations ticked/ }),
  ).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Farewell', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Greeter', exact: true })).not.toBeChecked();
  await page.goto(`/c/${slug}/settings/webhooks`);
  await expect(page.getByText('Automation runs sent: Farewell')).toBeVisible();

  // A third customer writes "hello": Greeter's run starts and ends with nothing captured for the
  // endpoint (capture is part of the run's own changes), so its deliveries stay at four.
  const third = randomWaId();
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, third, 'hello'));
  const liveRuns = page
    .locator('li')
    .filter({ hasText: 'Completed' })
    .filter({ hasText: 'Keyword' });
  await expect(async () => {
    await page.goto(automationUrl);
    await expect(liveRuns).toHaveCount(3, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await page.goto(deliveriesUrl);
  await expect(page.getByRole('list', { name: 'Deliveries' }).getByRole('listitem')).toHaveCount(4);
  expect(forUs()).toHaveLength(4);

  // A fourth customer writes "bye": Farewell's start and end arrive.
  const fourth = randomWaId();
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, fourth, 'bye'));
  await expect(async () => expect(forUs()).toHaveLength(6)).toPass({ timeout: 30_000 });
  expect(
    forUs()
      .slice(4)
      .map((e) => [e.json.type, e.json.data.run.automationName, e.json.data.contact.phone])
      .sort(),
  ).toEqual([
    ['automation.run_ended', 'Farewell', `+${fourth}`],
    ['automation.run_started', 'Farewell', `+${fourth}`],
  ]);

  // Both automations are archived: Greeter, not chosen, is no longer offered; Farewell, chosen,
  // stays listed and ticked, marked archived.
  for (const url of [automationUrl, farewellUrl]) {
    await page.goto(url);
    await page.getByRole('button', { name: 'Archive' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByText('Archived.')).toBeVisible();
  }
  await page.goto(deliveriesUrl);
  await expect(
    page.getByRole('checkbox', { name: 'Farewell (archived)', exact: true }),
  ).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /^Greeter/ })).toHaveCount(0);
  await page.goto(`/c/${slug}/settings/webhooks`);
  await expect(page.getByText('Automation runs sent: Farewell (archived)')).toBeVisible();
});

/** An order event body, as far as this test reads it. */
interface OrderEventBody {
  type: string;
  data: {
    order: {
      id: string;
      reference: string;
      status: string;
      previousStatus: string | null;
    } & Record<string, unknown>;
    contact: { phone: string | null } & Record<string, unknown>;
  };
}

test('order events reach an endpoint: a customer sends a cart, and a member confirms and fulfils the order', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('hookord');
  const slug = `hookord-${Date.now().toString(36)}`;
  const path = `/orders/${slug}`;
  const forUs = () =>
    received
      .filter((r) => r.path === path)
      .map((r) => ({ ...r, json: JSON.parse(r.body) as OrderEventBody }));
  await signUpAndVerify(page, { name: 'Omar Orders', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Order Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // An endpoint for the two order events.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${path}`);
  await page.getByRole('checkbox', { name: /Order received/ }).check();
  await page.getByRole('checkbox', { name: /Order status/ }).check();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  const secretField = page.getByLabel('Signing secret');
  await expect(secretField).toBeVisible();
  const secret = await secretField.inputValue();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();

  // A customer sends a cart from the company's WhatsApp catalog.
  const customer = randomWaId();
  await sendSignedWebhook(
    request,
    orderMessage(wabaId, phoneNumberId, customer, {
      catalogId: '5558503',
      text: 'Please deliver after 6 pm',
      items: [
        { retailerId: 'chai-1', quantity: 2, price: 120 },
        { retailerId: 'chai-2', quantity: 1, price: 80.5 },
      ],
    }),
  );
  await expect(async () => expect(forUs()).toHaveLength(1)).toPass({ timeout: 30_000 });
  const cart = forUs()[0]!;
  expect(signatureValid(cart.headers, cart.body, secret)).toBe(true);
  expect(cart.headers['w360-event-type']).toBe('order.received');
  expect(cart.json.data).toMatchObject({
    order: {
      status: 'received',
      previousStatus: null,
      catalogId: '5558503',
      currency: 'INR',
      subtotalMinor: 32_050,
      itemCount: 2,
      droppedItems: 0,
      customerNote: 'Please deliver after 6 pm',
      items: [
        { retailerId: 'chai-1', quantity: 2, unitPriceMinor: 12_000, currency: 'INR' },
        { retailerId: 'chai-2', quantity: 1, unitPriceMinor: 8_050, currency: 'INR' },
      ],
      paidAt: null,
    },
    contact: { phone: `+${customer}`, name: 'Priya Customer' },
  });
  const { id: orderId, reference } = cart.json.data.order;

  // A member opens the order from the chat, confirms it, then marks it fulfilled.
  await page.goto(`/c/${slug}/inbox`);
  await page.getByRole('link', { name: /Priya Customer/ }).click();
  await page.getByRole('link', { name: reference, exact: true }).click();
  await page.getByRole('button', { name: 'Confirm order' }).click();
  await expect(page.getByText('Confirmed', { exact: true }).first()).toBeVisible();
  await expect(async () => expect(forUs()).toHaveLength(2)).toPass({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Mark fulfilled' }).click();
  await expect(page.getByText('Fulfilled', { exact: true }).first()).toBeVisible();
  await expect(async () => expect(forUs()).toHaveLength(3)).toPass({ timeout: 30_000 });
  for (const event of forUs()) {
    expect(signatureValid(event.headers, event.body, secret)).toBe(true);
    expect(event.headers['w360-event-type']).toBe(event.json.type);
  }
  expect(
    forUs()
      .slice(1)
      .map((e) => [
        e.json.type,
        e.json.data.order.id,
        e.json.data.order.status,
        e.json.data.order.previousStatus,
      ]),
  ).toEqual([
    ['order.status_changed', orderId, 'confirmed', 'received'],
    ['order.status_changed', orderId, 'fulfilled', 'confirmed'],
  ]);
});

/** A delivered campaign event, as far as this test reads it. */
interface CampaignEventBody {
  type: string;
  createdAt: string;
  data: {
    campaign: {
      id: string;
      status: string;
      previousStatus: string;
      completionReason: string | null;
    } & Record<string, unknown>;
    channel: { id: string } | null;
  };
}

test('campaign events reach an endpoint: a member starts a campaign, and the runner starts and completes it', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const standIn = `http://127.0.0.1:${process.env.E2E_GRAPH_PORT}`;
  const email = uniqueEmail('hookcmp');
  const slug = `hookcmp-${Date.now().toString(36)}`;
  const path = `/campaigns/${slug}`;
  const forUs = () =>
    received
      .filter((r) => r.path === path)
      .map((r) => ({ ...r, json: JSON.parse(r.body) as CampaignEventBody }))
      // Deliveries are not ordered; the change captured last has the latest createdAt.
      .sort((a, b) => a.json.createdAt.localeCompare(b.json.createdAt));
  await signUpAndVerify(page, { name: 'Cara Campaigns', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Campaign Hooks');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId } = await connectTestChannel({ ownerEmail: email, slug });

  // An endpoint for campaign events.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${path}`);
  await page.getByRole('checkbox', { name: /Campaign status/ }).check();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  const secretField = page.getByLabel('Signing secret');
  await expect(secretField).toBeVisible();
  const secret = await secretField.inputValue();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();

  // An approved marketing template and a tagged contact who opted in.
  await page.goto(`/c/${slug}/templates/new`);
  await page.getByLabel('Name').fill('autumn_sale');
  await page.getByLabel('Language code').fill('en');
  await page.getByLabel('Category').selectOption('MARKETING');
  await page.getByLabel('Body').fill('Hello {{1}}, our autumn sale starts today.');
  await page.getByLabel('{{1}}').fill('Asha');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('heading', { name: 'autumn_sale', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Submit to Meta' }).click();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByRole('button', { name: /^Submit/ })).toHaveCount(0);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('In review', { exact: true }).first()).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 30_000 });
  const approved = await request.post(`${standIn}/__stand-in/template-status`, {
    data: { wabaId, name: 'autumn_sale', status: 'APPROVED' },
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
  await page.goto(`/c/${slug}/contacts/new`);
  await page.getByLabel('Name').fill('Asha Rao');
  await page.getByLabel('Phone number').fill(`+${randomWaId()}`);
  await page.getByRole('button', { name: 'Add contact' }).click();
  await expect(page.getByRole('heading', { name: 'Asha Rao', level: 1 })).toBeVisible();
  await page.getByLabel('Add tags').fill('vip');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Tags' })).toContainText('vip');
  await page.getByLabel('How and when did they tell you?').fill('Signed up at the counter');
  await page.getByRole('button', { name: 'Record consent' }).click();
  await expect(page.getByText('Consent recorded.')).toBeVisible();

  // Editing the draft sends nothing; starting it does.
  await page.goto(`/c/${slug}/campaigns`);
  await page.getByRole('link', { name: 'New campaign' }).click();
  await page.getByLabel('Campaign name').fill('Autumn launch');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'Autumn launch', level: 1 })).toBeVisible();
  await page.getByLabel('Send from').selectOption({ index: 1 });
  await page.getByLabel('Template').selectOption({ label: 'autumn_sale (en, marketing)' });
  await page.getByLabel('Body variable {{1}}').selectOption('name');
  await page.getByLabel('Tag', { exact: true }).fill('vip');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved. The review below is updated.')).toBeVisible();
  expect(forUs()).toEqual([]);
  await page.getByRole('button', { name: 'Start campaign' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Start campaign' }).click();

  // Scheduled by the member, started by the runner, completed on its next tick.
  await expect(async () => expect(forUs()).toHaveLength(3)).toPass({ timeout: 60_000 });
  for (const event of forUs()) {
    expect(signatureValid(event.headers, event.body, secret)).toBe(true);
    expect(event.headers['w360-event-type']).toBe('campaign.status_changed');
  }
  const campaignId = forUs()[0]!.json.data.campaign.id;
  expect(
    forUs().map((e) => [
      e.json.data.campaign.id,
      e.json.data.campaign.status,
      e.json.data.campaign.previousStatus,
      e.json.data.campaign.completionReason,
    ]),
  ).toEqual([
    [campaignId, 'scheduled', 'draft', null],
    [campaignId, 'running', 'scheduled', null],
    [campaignId, 'completed', 'running', 'all_processed'],
  ]);
  expect(forUs()[2]!.json.data).toMatchObject({
    campaign: {
      name: 'Autumn launch',
      templateName: 'autumn_sale',
      pauseReason: null,
      audienceCount: 1,
      queuedCount: 1,
      skippedCount: 0,
      completedAt: expect.any(String),
    },
    channel: { id: expect.any(String) },
  });
  await page.reload();
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible();
});
