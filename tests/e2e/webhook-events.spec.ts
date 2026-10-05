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

test("an endpoint for one team receives only its conversations' events: messages once a conversation joins the team, and the change of team when it leaves (ADR-174)", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('hookteams');
  const slug = `hookteams-${Date.now().toString(36)}`;
  const path = `/team-filter/${slug}`;
  const forUs = () =>
    received
      .filter((r) => r.path === path)
      .map((r) => ({ ...r, json: JSON.parse(r.body) as EventBody }));
  await signUpAndVerify(page, { name: 'Tia Teams', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Team Filter Traders');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // Two teams that assign by hand.
  await page.goto(`/c/${slug}/settings/teams`);
  for (const name of ['Returns', 'Billing']) {
    const form = page.locator('form', { has: page.getByRole('button', { name: 'Create team' }) });
    await form.getByLabel('Team name').fill(name);
    await form.getByRole('button', { name: 'Create team' }).click();
    await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible();
  }

  // An endpoint for the messages and team changes of the Returns team's conversations.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${path}`);
  await page.getByRole('checkbox', { name: /Message received/ }).check();
  await page.getByRole('checkbox', { name: /Conversation team/ }).check();
  await page
    .getByRole('radio', { name: /Only the events of the conversations of the teams ticked/ })
    .check();
  await page.getByRole('checkbox', { name: 'Returns', exact: true }).check();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  const secretField = page.getByLabel('Signing secret');
  await expect(secretField).toBeVisible();
  const secret = await secretField.inputValue();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();
  await page.reload();
  await expect(page.getByText('Teams whose conversations’ events are sent: Returns')).toBeVisible();

  // A customer writes: the conversation is in no team, so nothing is sent.
  const waId = randomWaId();
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, waId, 'Wrong size'));
  await page.goto(`/c/${slug}/inbox`);
  const item = page.getByRole('link', { name: /Priya Customer/ });
  await expect(item).toContainText('Unassigned', { timeout: 30_000 });
  await item.click();
  await expect(page.getByText('Wrong size')).toBeVisible();
  const teamControl = page
    .getByLabel('Team', { exact: true })
    .and(page.locator('select:not([name="team"])'));

  // Into Returns: the change is sent, then the customer's next message.
  const [returnsId] = await teamControl.selectOption({ label: 'Returns' });
  await expect(async () => expect(forUs()).toHaveLength(1)).toPass({ timeout: 30_000 });
  expect(signatureValid(forUs()[0]!.headers, forUs()[0]!.body, secret)).toBe(true);
  expect(forUs()[0]!.json).toMatchObject({
    type: 'conversation.team_changed',
    data: { conversation: { teamId: returnsId, previousTeamId: null } },
  });
  await expect(teamControl).toHaveValue(returnsId!);
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, waId, 'Any news?'));
  await expect(async () => expect(forUs()).toHaveLength(2)).toPass({ timeout: 30_000 });
  expect(forUs()[1]!.json.type).toBe('message.received');
  expect(forUs()[1]!.body).toContain('Any news?');

  // Into Billing: the change is sent to the team it left; the next message is not.
  const [billingId] = await teamControl.selectOption({ label: 'Billing' });
  await expect(async () => expect(forUs()).toHaveLength(3)).toPass({ timeout: 30_000 });
  expect(forUs()[2]!.json).toMatchObject({
    type: 'conversation.team_changed',
    data: { conversation: { teamId: billingId, previousTeamId: returnsId } },
  });
  await expect(teamControl).toHaveValue(billingId!);
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, waId, 'For billing'));
  await expect(page.getByText('For billing')).toBeVisible({ timeout: 30_000 });
  // Back into Returns: its change arrives after anything captured before it would have.
  await teamControl.selectOption({ label: 'Returns' });
  await expect(async () => expect(forUs()).toHaveLength(4)).toPass({ timeout: 30_000 });
  expect(forUs().map((r) => r.json.type)).toEqual([
    'conversation.team_changed',
    'message.received',
    'conversation.team_changed',
    'conversation.team_changed',
  ]);
  expect(forUs().some((r) => r.body.includes('For billing'))).toBe(false);
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

test('automation run events reach an endpoint: a live run starts and ends, a member’s test run sends nothing, an endpoint can take chosen automations only, and another only the ends it chooses', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
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

  // A second endpoint takes the ends of every automation's runs but their completions (ADR-151).
  const endsPath = `${path}/ends`;
  const forEnds = () => received.filter((r) => r.path === endsPath);
  const endBox = (name: string) => page.getByRole('checkbox', { name, exact: true });
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${endsPath}`);
  await page.getByRole('checkbox', { name: /Automation ended/ }).check();
  await endBox('Completed (completed)').uncheck();
  await expect(endBox('Failed (failed)')).toBeChecked();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  await expect(page.getByLabel('Signing secret')).toBeVisible();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();
  // The form starts afresh: the event ticked again takes every end.
  await page.getByRole('checkbox', { name: /Automation ended/ }).check();
  await expect(endBox('Completed (completed)')).toBeChecked();
  await page.reload();
  // Only the second endpoint names how runs ended, as an automation's runs name them.
  await expect(page.getByText(/^Automation ends sent:/)).toHaveText([
    'Automation ends sent: Handed off, Taken over, Stopped, Failed',
  ]);
  await page
    .getByRole('list', { name: 'Endpoints' })
    .getByRole('listitem')
    .filter({ hasText: 'Automation ends sent:' })
    .getByRole('link', { name: /Deliveries and settings/ })
    .click();
  await expect(page.getByRole('heading', { name: /^Deliveries to/ })).toBeVisible();
  const endsUrl = page.url();
  await expect(endBox('Completed (completed)')).not.toBeChecked();
  await expect(endBox('Handed off (handed_off)')).toBeChecked();
  await expect(endBox('Failed (failed)')).toBeChecked();

  // A fifth customer writes "bye": Farewell's run starts and completes, and the first endpoint
  // hears both. The completion is captured for no other endpoint: the second has no delivery.
  const fifth = randomWaId();
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, fifth, 'bye'));
  await expect(async () => expect(forUs()).toHaveLength(8)).toPass({ timeout: 30_000 });
  expect(
    forUs()
      .slice(6)
      .map((e) => [e.json.type, e.json.data.run.status, e.json.data.contact.phone])
      .sort(),
  ).toEqual([
    ['automation.run_ended', 'completed', `+${fifth}`],
    ['automation.run_started', 'running', `+${fifth}`],
  ]);
  await page.goto(endsUrl);
  await expect(page.getByText('No deliveries yet.')).toBeVisible();
  expect(forEnds()).toEqual([]);

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

test('order events reach an endpoint: a customer sends a cart, and a member confirms and fulfils the order; an endpoint can take chosen statuses only', async ({
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

  // A second endpoint takes only fulfilments (ADR-147).
  const fulfilledPath = `${path}/fulfilled`;
  const forFulfilled = () =>
    received
      .filter((r) => r.path === fulfilledPath)
      .map((r) => JSON.parse(r.body) as OrderEventBody);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${fulfilledPath}`);
  await page.getByRole('checkbox', { name: /Order status/ }).check();
  const statusBox = (name: string) => page.getByRole('checkbox', { name, exact: true });
  for (const name of [
    'Confirmed (confirmed)',
    'Waiting for payment (awaiting_payment)',
    'Paid (paid)',
    'Fulfilled (fulfilled)',
    'Cancelled (cancelled)',
  ]) {
    await statusBox(name).uncheck();
  }
  await statusBox('Fulfilled (fulfilled)').check();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  await expect(page.getByLabel('Signing secret')).toBeVisible();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();
  // The form starts afresh: the event ticked again takes every status.
  await page.getByRole('checkbox', { name: /Order status/ }).check();
  await expect(statusBox('Confirmed (confirmed)')).toBeChecked();
  await page.reload();
  // Only the second endpoint names statuses: every status ticked keeps none.
  await expect(page.getByText(/^Order statuses sent:/)).toHaveText([
    'Order statuses sent: Fulfilled',
  ]);
  // The endpoint's own page shows the statuses it takes.
  await page
    .getByRole('list', { name: 'Endpoints' })
    .getByRole('listitem')
    .filter({ hasText: 'Order statuses sent: Fulfilled' })
    .getByRole('link', { name: /Deliveries and settings/ })
    .click();
  await expect(page.getByRole('heading', { name: /^Deliveries to/ })).toBeVisible();
  await expect(statusBox('Fulfilled (fulfilled)')).toBeChecked();
  await expect(statusBox('Confirmed (confirmed)')).not.toBeChecked();

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
  // The endpoint taking fulfilments only received the fulfilment.
  await expect(async () => expect(forFulfilled()).toHaveLength(1)).toPass({ timeout: 30_000 });
  expect(forFulfilled().map((e) => [e.type, e.data.order.id, e.data.order.status])).toEqual([
    ['order.status_changed', orderId, 'fulfilled'],
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

test('campaign events reach an endpoint: a member starts a campaign, and the runner starts and completes it; an endpoint can take chosen statuses only', async ({
  page,
  request,
}) => {
  test.setTimeout(210_000);
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

  // A second endpoint takes only completions (ADR-146).
  const completedPath = `${path}/completed`;
  const forCompleted = () =>
    received
      .filter((r) => r.path === completedPath)
      .map((r) => JSON.parse(r.body) as CampaignEventBody);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${completedPath}`);
  await page.getByRole('checkbox', { name: /Campaign status/ }).check();
  const statusBox = (name: string) => page.getByRole('checkbox', { name, exact: true });
  for (const name of [
    'Draft (draft)',
    'Waiting for approval (pending_approval)',
    'Scheduled (scheduled)',
    'Sending (running)',
    'Paused (paused)',
    'Completed (completed)',
    'Cancelled (canceled)',
  ]) {
    await statusBox(name).uncheck();
  }
  await statusBox('Completed (completed)').check();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  await expect(page.getByLabel('Signing secret')).toBeVisible();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();
  // The form starts afresh: the event ticked again takes every status.
  await page.getByRole('checkbox', { name: /Campaign status/ }).check();
  await expect(statusBox('Draft (draft)')).toBeChecked();
  await page.reload();
  // Only the second endpoint names statuses: every status ticked keeps none.
  await expect(page.getByText(/^Campaign statuses sent:/)).toHaveText([
    'Campaign statuses sent: Completed',
  ]);
  // The endpoint's own page shows the statuses it takes.
  await page
    .getByRole('list', { name: 'Endpoints' })
    .getByRole('listitem')
    .filter({ hasText: 'Campaign statuses sent: Completed' })
    .getByRole('link', { name: /Deliveries and settings/ })
    .click();
  await expect(page.getByRole('heading', { name: /^Deliveries to/ })).toBeVisible();
  await expect(statusBox('Completed (completed)')).toBeChecked();
  await expect(statusBox('Draft (draft)')).not.toBeChecked();

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
      // Its results as GET /campaigns/{id} counts them when each event is delivered (ADR-150); how
      // far WhatsApp got with the message by then is not fixed, so only the settled counts are.
      results: {
        audience: 1,
        pending: 0,
        skipped: 0,
        canceled: 0,
        queued: 1,
        failed: 0,
        unknown: 0,
        skipReasons: [],
        failureCodes: [],
      },
    },
    channel: { id: expect.any(String) },
  });
  // Every change was delivered once the campaign had left its draft, so each carries results.
  for (const event of forUs()) expect(event.json.data.campaign.results).not.toBeNull();
  // The second endpoint heard only of the completion.
  await expect(async () => expect(forCompleted()).toHaveLength(1)).toPass({ timeout: 30_000 });
  expect(forCompleted().map((e) => [e.data.campaign.id, e.data.campaign.status])).toEqual([
    [campaignId, 'completed'],
  ]);
  await page.reload();
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible();
});

/** A delivered template event, as far as this test reads it. */
interface TemplateEventBody {
  type: string;
  createdAt: string;
  data: {
    template: {
      id: string;
      name: string | null;
      language: string | null;
      category: string | null;
      status: string;
      reason: string | null;
    };
  };
}

test('template events reach an endpoint: a member submits a template and Meta reviews and approves it; an endpoint can take chosen statuses only', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const standIn = `http://127.0.0.1:${process.env.E2E_GRAPH_PORT}`;
  const email = uniqueEmail('hooktpl');
  const slug = `hooktpl-${Date.now().toString(36)}`;
  const path = `/templates/${slug}`;
  const forUs = () =>
    received
      .filter((r) => r.path === path)
      .map((r) => ({ ...r, json: JSON.parse(r.body) as TemplateEventBody }))
      // Deliveries are not ordered; the status reported last has the latest createdAt.
      .sort((a, b) => a.json.createdAt.localeCompare(b.json.createdAt));
  await signUpAndVerify(page, { name: 'Tara Templates', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Template Hooks');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId } = await connectTestChannel({ ownerEmail: email, slug });

  // An endpoint for template events.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${path}`);
  await page.getByRole('checkbox', { name: /Template status/ }).check();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  const secretField = page.getByLabel('Signing secret');
  await expect(secretField).toBeVisible();
  const secret = await secretField.inputValue();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();

  // A second endpoint takes only approvals (ADR-148).
  const approvedPath = `${path}/approved`;
  const forApproved = () =>
    received
      .filter((r) => r.path === approvedPath)
      .map((r) => JSON.parse(r.body) as TemplateEventBody);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${approvedPath}`);
  await page.getByRole('checkbox', { name: /Template status/ }).check();
  const statusBox = (name: string) => page.getByRole('checkbox', { name, exact: true });
  for (const name of [
    'In review (pending)',
    'Approved (approved)',
    'Rejected (rejected)',
    'Paused by Meta (paused)',
    'Disabled by Meta (disabled)',
    'In appeal (in_appeal)',
    'Flagged (flagged)',
    'Archived (archived)',
    'Deleted (deleted)',
    'Limit exceeded (limit_exceeded)',
    'Locked (locked)',
  ]) {
    await statusBox(name).uncheck();
  }
  await statusBox('Approved (approved)').check();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  await expect(page.getByLabel('Signing secret')).toBeVisible();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();
  // The form starts afresh: the event ticked again takes every status.
  await page.getByRole('checkbox', { name: /Template status/ }).check();
  await expect(statusBox('In review (pending)')).toBeChecked();
  await page.reload();
  // Only the second endpoint names statuses: every status ticked keeps none.
  await expect(page.getByText(/^Template statuses sent:/)).toHaveText([
    'Template statuses sent: Approved',
  ]);
  // The endpoint's own page shows the statuses it takes.
  await page
    .getByRole('list', { name: 'Endpoints' })
    .getByRole('listitem')
    .filter({ hasText: 'Template statuses sent: Approved' })
    .getByRole('link', { name: /Deliveries and settings/ })
    .click();
  await expect(page.getByRole('heading', { name: /^Deliveries to/ })).toBeVisible();
  await expect(statusBox('Approved (approved)')).toBeChecked();
  await expect(statusBox('In review (pending)')).not.toBeChecked();

  // A member submits a template: HyFib's own steps send nothing, Meta's review does.
  await page.goto(`/c/${slug}/templates/new`);
  await page.getByLabel('Name').fill('order_ready');
  await page.getByLabel('Language code').fill('en');
  await page.getByLabel('Category').selectOption('UTILITY');
  await page.getByLabel('Body').fill('Hello {{1}}, your order is ready.');
  await page.getByLabel('{{1}}').fill('Asha');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('heading', { name: 'order_ready', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Submit to Meta' }).click();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByRole('button', { name: /^Submit/ })).toHaveCount(0);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('In review', { exact: true }).first()).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 30_000 });
  await expect(async () => expect(forUs()).toHaveLength(1)).toPass({ timeout: 30_000 });

  // Meta approves; a refresh reads it.
  const approved = await request.post(`${standIn}/__stand-in/template-status`, {
    data: { wabaId, name: 'order_ready', status: 'APPROVED' },
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

  await expect(async () => expect(forUs()).toHaveLength(2)).toPass({ timeout: 30_000 });
  for (const event of forUs()) {
    expect(signatureValid(event.headers, event.body, secret)).toBe(true);
    expect(event.headers['w360-event-type']).toBe('template.status_changed');
  }
  const templateId = forUs()[0]!.json.data.template.id;
  expect(forUs().map((e) => [e.json.data.template.id, e.json.data.template.status])).toEqual([
    [templateId, 'pending'],
    [templateId, 'approved'],
  ]);
  expect(forUs()[1]!.json.data.template).toEqual({
    id: templateId,
    name: 'order_ready',
    language: 'en',
    category: 'utility',
    status: 'approved',
    reason: null,
  });
  // The second endpoint heard only of the approval.
  await expect(async () => expect(forApproved()).toHaveLength(1)).toPass({ timeout: 30_000 });
  expect(forApproved().map((e) => [e.data.template.id, e.data.template.status])).toEqual([
    [templateId, 'approved'],
  ]);
});

test('an endpoint can take the changes of chosen templates only, and changed to every template hears them all (ADR-175)', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const standIn = `http://127.0.0.1:${process.env.E2E_GRAPH_PORT}`;
  const email = uniqueEmail('hooktplpick');
  const slug = `hooktplpick-${Date.now().toString(36)}`;
  const path = `/template-filter/${slug}`;
  const forUs = () =>
    received
      .filter((r) => r.path === path)
      .map((r) => ({ ...r, json: JSON.parse(r.body) as TemplateEventBody }))
      // Deliveries are not ordered; the status reported last has the latest createdAt.
      .sort((a, b) => a.json.createdAt.localeCompare(b.json.createdAt));
  await signUpAndVerify(page, { name: 'Tomas Templates', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Template Filter Hooks');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId } = await connectTestChannel({ ownerEmail: email, slug });

  // Two drafts.
  const drafts = new Map<string, string>();
  for (const name of ['order_late', 'order_ready']) {
    await page.goto(`/c/${slug}/templates/new`);
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Language code').fill('en');
    await page.getByLabel('Category').selectOption('UTILITY');
    await page.getByLabel('Body').fill('Hello {{1}}, about your order.');
    await page.getByLabel('{{1}}').fill('Asha');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    drafts.set(name, page.url());
  }

  // An endpoint for order_ready's changes only.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${path}`);
  await page.getByRole('checkbox', { name: /Template status/ }).check();
  await expect(
    page.getByRole('radio', { name: /Every message’s statuses and every template’s changes/ }),
  ).toBeChecked();
  await page.getByRole('radio', { name: /Only those of the templates ticked/ }).check();
  const readyBox = page.getByRole('checkbox', { name: 'order_ready (en)', exact: true });
  const lateBox = page.getByRole('checkbox', { name: 'order_late (en)', exact: true });
  await readyBox.check();
  await expect(lateBox).not.toBeChecked();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  const secretField = page.getByLabel('Signing secret');
  await expect(secretField).toBeVisible();
  const secret = await secretField.inputValue();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();
  await page.reload();
  await expect(
    page.getByText('Templates whose statuses and changes are sent: order_ready (en)'),
  ).toBeVisible();

  // Both are submitted, order_late first: only order_ready's review is sent.
  for (const name of ['order_late', 'order_ready']) {
    await page.goto(drafts.get(name)!);
    await page.getByRole('button', { name: 'Submit to Meta' }).click();
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByRole('button', { name: /^Submit/ })).toHaveCount(0);
  }
  await expect(async () => expect(forUs()).toHaveLength(1)).toPass({ timeout: 30_000 });
  expect(signatureValid(forUs()[0]!.headers, forUs()[0]!.body, secret)).toBe(true);
  expect(forUs()[0]!.json.data.template).toMatchObject({ name: 'order_ready', status: 'pending' });

  // Meta approves both, order_late first; a refresh reads them.
  for (const name of ['order_late', 'order_ready']) {
    const approved = await request.post(`${standIn}/__stand-in/template-status`, {
      data: { wabaId, name, status: 'APPROVED' },
    });
    expect(approved.status()).toBe(200);
  }
  const statusOf = (name: string) =>
    page.getByRole('row').filter({ hasText: name }).getByText('Approved', { exact: true });
  await page.goto(`/c/${slug}/templates`);
  await page.getByRole('button', { name: 'Refresh from Meta' }).click();
  await expect(page.getByText(/Refresh requested/)).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(statusOf('order_late')).toBeVisible({ timeout: 1_000 });
    await expect(statusOf('order_ready')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await expect(async () => expect(forUs()).toHaveLength(2)).toPass({ timeout: 30_000 });
  expect(forUs().map((e) => [e.json.data.template.name, e.json.data.template.status])).toEqual([
    ['order_ready', 'pending'],
    ['order_ready', 'approved'],
  ]);
  // Both approvals are shown, so both were captured or passed over: the endpoint's deliveries
  // hold order_ready's alone.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByRole('link', { name: /Deliveries and settings/ }).click();
  await expect(page.getByRole('heading', { name: /^Deliveries to/ })).toBeVisible();
  const deliveries = page.getByRole('list', { name: 'Deliveries' }).getByRole('listitem');
  await expect(deliveries).toHaveCount(2);
  await expect(deliveries.filter({ hasText: 'template.status_changed' })).toHaveCount(2);

  // The endpoint's settings show the template it takes; changed to every template, it hears
  // order_late's next change too.
  await expect(
    page.getByRole('radio', { name: /Only those of the templates ticked/ }),
  ).toBeChecked();
  await expect(readyBox).toBeChecked();
  await expect(lateBox).not.toBeChecked();
  await page
    .getByRole('radio', { name: /Every message’s statuses and every template’s changes/ })
    .check();
  await page.getByRole('button', { name: 'Save endpoint' }).click();
  await expect(page.getByText('Endpoint saved.')).toBeVisible();
  const paused = await request.post(`${standIn}/__stand-in/template-status`, {
    data: { wabaId, name: 'order_late', status: 'PAUSED' },
  });
  expect(paused.status()).toBe(200);
  await page.goto(`/c/${slug}/templates`);
  await page.getByRole('button', { name: 'Refresh from Meta' }).click();
  await expect(page.getByText(/Refresh requested/)).toBeVisible();
  await expect(async () => expect(forUs()).toHaveLength(3)).toPass({ timeout: 30_000 });
  expect(forUs()[2]!.json.data.template).toMatchObject({ name: 'order_late', status: 'paused' });
  await page.goto(`/c/${slug}/settings/webhooks`);
  await expect(page.getByText(/^Templates whose statuses and changes are sent:/)).toHaveCount(0);
});

/** A delivered conversation status event, as far as this test reads it. */
interface ConversationEventBody {
  type: string;
  createdAt: string;
  data: { conversation: { id: string; status: string; previousStatus: string } };
}

test('conversation status events reach an endpoint: a member resolves and the customer writes again; an endpoint can take chosen statuses only', async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const email = uniqueEmail('hookcst');
  const slug = `hookcst-${Date.now().toString(36)}`;
  const path = `/conversations/${slug}`;
  const forUs = () =>
    received
      .filter((r) => r.path === path)
      .map((r) => ({ ...r, json: JSON.parse(r.body) as ConversationEventBody }))
      // Deliveries are not ordered; the change captured last has the latest createdAt.
      .sort((a, b) => a.json.createdAt.localeCompare(b.json.createdAt));
  await signUpAndVerify(page, { name: 'Cora Conversations', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Conversation Hooks');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const { wabaId, phoneNumberId } = await connectTestChannel({ ownerEmail: email, slug });

  // An endpoint for conversation status changes.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${path}`);
  await page.getByRole('checkbox', { name: /Conversation status/ }).check();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  const secretField = page.getByLabel('Signing secret');
  await expect(secretField).toBeVisible();
  const secret = await secretField.inputValue();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();

  // A second endpoint takes only resolutions (ADR-149).
  const resolvedPath = `${path}/resolved`;
  const forResolved = () =>
    received
      .filter((r) => r.path === resolvedPath)
      .map((r) => JSON.parse(r.body) as ConversationEventBody);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${resolvedPath}`);
  await page.getByRole('checkbox', { name: /Conversation status/ }).check();
  const statusBox = (name: string) => page.getByRole('checkbox', { name, exact: true });
  await statusBox('Open (open)').uncheck();
  await expect(statusBox('Resolved (resolved)')).toBeChecked();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  await expect(page.getByLabel('Signing secret')).toBeVisible();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();
  // The form starts afresh: the event ticked again takes every status.
  await page.getByRole('checkbox', { name: /Conversation status/ }).check();
  await expect(statusBox('Open (open)')).toBeChecked();
  await page.reload();
  // Only the second endpoint names statuses: every status ticked keeps none.
  await expect(page.getByText(/^Conversation statuses sent:/)).toHaveText([
    'Conversation statuses sent: Resolved',
  ]);
  // The endpoint's own page shows the statuses it takes.
  await page
    .getByRole('list', { name: 'Endpoints' })
    .getByRole('listitem')
    .filter({ hasText: 'Conversation statuses sent: Resolved' })
    .getByRole('link', { name: /Deliveries and settings/ })
    .click();
  await expect(page.getByRole('heading', { name: /^Deliveries to/ })).toBeVisible();
  await expect(statusBox('Resolved (resolved)')).toBeChecked();
  await expect(statusBox('Open (open)')).not.toBeChecked();

  // A customer writes: a new conversation is no change of status. A member resolves it.
  const waId = randomWaId();
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, waId, 'Hello there'));
  await page.goto(`/c/${slug}/inbox`);
  await page.getByRole('link', { name: /Priya Customer/ }).click();
  await expect(page.getByText('Hello there')).toBeVisible();
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(async () => expect(forUs()).toHaveLength(1)).toPass({ timeout: 30_000 });
  // The customer writes again, which opens the conversation again.
  await sendSignedWebhook(request, inboundMessage(wabaId, phoneNumberId, waId, 'One more thing'));
  await expect(async () => expect(forUs()).toHaveLength(2)).toPass({ timeout: 30_000 });
  for (const event of forUs()) {
    expect(signatureValid(event.headers, event.body, secret)).toBe(true);
    expect(event.headers['w360-event-type']).toBe('conversation.status_changed');
  }
  const conversationId = forUs()[0]!.json.data.conversation.id;
  expect(
    forUs().map((e) => [
      e.json.data.conversation.id,
      e.json.data.conversation.status,
      e.json.data.conversation.previousStatus,
    ]),
  ).toEqual([
    [conversationId, 'resolved', 'open'],
    [conversationId, 'open', 'resolved'],
  ]);
  // The second endpoint heard only of the resolution.
  await expect(async () => expect(forResolved()).toHaveLength(1)).toPass({ timeout: 30_000 });
  expect(forResolved().map((e) => [e.data.conversation.id, e.data.conversation.status])).toEqual([
    [conversationId, 'resolved'],
  ]);
});

/** A message event body, as far as the number test reads it. */
interface NumberEventBody {
  type: string;
  data: { message: { text: string | null }; channel: { id: string; phone: string | null } };
}

test('an endpoint can take the events of chosen WhatsApp numbers only, and changed to every number hears them all (ADR-170)', async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const email = uniqueEmail('hooknum');
  const slug = `hooknum-${Date.now().toString(36)}`;
  const path = `/numbers/${slug}`;
  const forUs = () =>
    received.filter((r) => r.path === path).map((r) => JSON.parse(r.body) as NumberEventBody);
  await signUpAndVerify(page, { name: 'Nina Numbers', email, password: PASSWORD });
  await page.getByLabel('Company name').fill('Number Hooks');
  await page.getByLabel('Company address').fill(slug);
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  const main = await connectTestChannel({ ownerEmail: email, slug });
  const outlet = await connectTestChannel({
    ownerEmail: email,
    slug,
    displayPhoneNumber: '+91 90000 54321',
    verifiedName: 'E2E Outlet',
  });

  // An endpoint for the outlet's messages only.
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByLabel('Endpoint URL').fill(`http://${HOST}:${port}${path}`);
  await page.getByRole('checkbox', { name: /Message received/ }).check();
  await expect(page.getByRole('radio', { name: /Every number’s events/ })).toBeChecked();
  await page.getByRole('radio', { name: /Only the events of the numbers ticked/ }).check();
  const mainBox = page.getByRole('checkbox', { name: '+91 90000 12345 · E2E Traders' });
  const outletBox = page.getByRole('checkbox', { name: '+91 90000 54321 · E2E Outlet' });
  await outletBox.check();
  await expect(mainBox).not.toBeChecked();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  await expect(page.getByLabel('Signing secret')).toBeVisible();
  await page.getByRole('button', { name: 'I have stored the secret' }).click();
  await page.reload();
  await expect(
    page.getByText('Numbers whose events are sent: +91 90000 54321 · E2E Outlet'),
  ).toBeVisible();

  // A customer writes to each number: only the message to the outlet is sent.
  const waId = randomWaId();
  await sendSignedWebhook(
    request,
    inboundMessage(main.wabaId, main.phoneNumberId, waId, 'Hello main shop'),
  );
  await sendSignedWebhook(
    request,
    inboundMessage(outlet.wabaId, outlet.phoneNumberId, waId, 'Hello outlet'),
  );
  await expect(async () => expect(forUs()).toHaveLength(1)).toPass({ timeout: 30_000 });
  expect(forUs().map((e) => [e.type, e.data.message.text, e.data.channel.phone])).toEqual([
    ['message.received', 'Hello outlet', '+91 90000 54321'],
  ]);
  // Both messages are in the inbox, so both were captured or passed over: the endpoint's
  // deliveries hold the outlet's alone.
  await page.goto(`/c/${slug}/inbox`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Hello main shop')).toBeVisible({ timeout: 1_000 });
    await expect(page.getByText('Hello outlet')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await page.goto(`/c/${slug}/settings/webhooks`);
  await page.getByRole('link', { name: /Deliveries and settings/ }).click();
  await expect(page.getByRole('heading', { name: /^Deliveries to/ })).toBeVisible();
  const deliveries = page.getByRole('list', { name: 'Deliveries' }).getByRole('listitem');
  await expect(deliveries).toHaveCount(1);
  await expect(deliveries.filter({ hasText: 'message.received' })).toHaveCount(1);

  // The endpoint's settings show the number it takes; changed to every number, it hears both.
  await expect(
    page.getByRole('radio', { name: /Only the events of the numbers ticked/ }),
  ).toBeChecked();
  await expect(outletBox).toBeChecked();
  await expect(mainBox).not.toBeChecked();
  await page.getByRole('radio', { name: /Every number’s events/ }).check();
  await page.getByRole('button', { name: 'Save endpoint' }).click();
  await expect(page.getByText('Endpoint saved.')).toBeVisible();
  await sendSignedWebhook(
    request,
    inboundMessage(main.wabaId, main.phoneNumberId, waId, 'Main shop again'),
  );
  await expect(async () => expect(forUs()).toHaveLength(2)).toPass({ timeout: 30_000 });
  expect(forUs()[1]!.data.channel.phone).toBe('+91 90000 12345');
  await page.goto(`/c/${slug}/settings/webhooks`);
  await expect(page.getByText(/^Numbers whose events are sent:/)).toHaveCount(0);
});
