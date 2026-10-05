import { randomBytes, randomInt } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, sha256Hex, systemClock, uuidv7, type Clock } from '@w360/core';
import { DEFAULT_EGRESS_POLICY, createEgressClient } from '@w360/core/egress';
import {
  authorizedTenantScope,
  contacts,
  eq,
  sql,
  webhookDeliveries,
  webhookEvents,
  type Tx,
} from '@w360/db';
import {
  advanceAutomationRun,
  apiGetCampaign,
  apiStartAutomationRun,
  apiUpdateConversation,
  authenticateApiToken,
  automationRunEndedPayloadSchema,
  automationRunStartedPayloadSchema,
  campaignStatusChangedPayloadSchema,
  contactCreatedPayloadSchema,
  contactErasedPayloadSchema,
  contactUpdatedPayloadSchema,
  conversationAssignmentPayloadSchema,
  conversationStatusPayloadSchema,
  conversationTeamPayloadSchema,
  createApiKeysService,
  createAutomationService,
  createCampaignsService,
  createCommerceService,
  createConsentService,
  createContactsService,
  createInboxService,
  createTeamsService,
  createTemplatesService,
  createWebhooksService,
  messageReceivedPayloadSchema,
  orderReceivedPayloadSchema,
  orderStatusChangedPayloadSchema,
  processCommerceSync,
  processPaymentAccountCheck,
  processPaymentLink,
  processSendIntent,
  processTemplateSubmit,
  processWebhookDeliveries,
  WebhookOAuthTokenCache,
  runCampaignTick,
  syncTemplates,
  WEBHOOK_EVENT_KEYS,
  type AutomationTrigger,
  type CatalogSyncDeps,
  type TemplateDefinition,
  type TenantContext,
  type WebhookContactPart,
  type WebhookEventType,
} from '@w360/domain';
import { startRazorpayStandIn, type RazorpayStandIn } from '../support/razorpay-stand-in';
import { failOnLog } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Webhook events for conversations and contacts (ADR-074), automation runs (ADR-078), WhatsApp
 * orders (ADR-085) and campaigns (ADR-087) against real PostgreSQL and a local receiver: capture by
 * the triggers from every kind of change, one contact event per contact and transaction (savepoints
 * included), erasure sending only `contact.erased`, the start and end of live runs (not test runs),
 * orders and campaigns and every status change whoever makes it (members, Razorpay through the
 * worker, the campaign runner), delivery to the endpoints that take each type, payloads built when
 * delivered, and the capture function's limits for the company role.
 */
let fx: WhatsAppFixture;
let receiver: Server;
let port = 0;
const received: { path: string; body: string }[] = [];

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  receiver = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      received.push({ path: req.url ?? '', body });
      res.writeHead(204);
      res.end();
    });
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  port = (receiver.address() as AddressInfo).port;
});

afterAll(async () => {
  receiver?.closeAllConnections();
  receiver?.close();
  await fx?.close();
});

const HOST = 'hooks.receiver.test';
const waId = () => `91${randomInt(7_000_000_000, 9_999_999_999)}`;

const webhooks = () =>
  createWebhooksService({
    db: fx.dbs.app,
    clock: systemClock,
    keyring: fx.keyring,
    egressPolicy: { allowLoopbackForTests: true },
  });
const inbox = () => createInboxService({ db: fx.dbs.app, clock: systemClock });
const contactsService = () => createContactsService({ db: fx.dbs.app, clock: systemClock });

/**
 * An endpoint of the company taking `eventTypes` (and only the contact parts given, ADR-123, the
 * runs of the automations given, ADR-145, the campaign statuses given, ADR-146, the order statuses
 * given, ADR-147, the conversation statuses given, ADR-149, the ends of runs given, ADR-151, and the
 * events of the numbers given, ADR-170), on a path of the receiver of its own.
 */
async function addEndpoint(
  c: Company,
  eventTypes: WebhookEventType[],
  contactParts: WebhookContactPart[] | null = null,
  automationIds: string[] | null = null,
  campaignStatuses: string[] | null = null,
  orderStatuses: string[] | null = null,
  conversationStatuses: string[] | null = null,
  runEndStatuses: string[] | null = null,
  channelIds: string[] | null = null,
) {
  const path = `/ok/${randomBytes(6).toString('hex')}`;
  const owner = await fx.ctx(c, c.owner);
  const created = await webhooks().create(owner, {
    url: `http://${HOST}:${port}${path}`,
    eventTypes,
    contactParts,
    automationIds,
    campaignStatuses,
    orderStatuses,
    conversationStatuses,
    runEndStatuses,
    channelIds,
  });
  return { ...created, path };
}

/** An endpoint of the company taking `eventTypes` from the numbers given only (ADR-170). */
const addNumberEndpoint = (c: Company, eventTypes: WebhookEventType[], channelIds: string[]) =>
  addEndpoint(c, eventTypes, null, null, null, null, null, null, channelIds);

/**
 * The bodies the receiver got on a path, as [type, the id of what changed, the number it happened
 * on] (ADR-170), sorted. `subject` names the part of the payload that changed.
 */
const numbersAt = (path: string, subject: 'conversation' | 'run' | 'order' | 'campaign') =>
  bodiesAt(path)
    .map((b) => [
      b.type,
      (b.data[subject] as { id: string }).id,
      (b.data.channel as { id: string } | null)?.id ?? null,
    ])
    .sort();

/** Delivers what is due for the company through the egress client, names resolving locally. */
async function deliverDue(c: Company) {
  const jobs = fx.jobs();
  await processWebhookDeliveries(
    {
      db: fx.dbs.app,
      clock: systemClock,
      keyring: fx.keyring,
      egress: createEgressClient(
        { ...DEFAULT_EGRESS_POLICY, allowLoopbackForTests: true, timeoutMs: 2_000 },
        { resolve: async () => [{ address: '127.0.0.1', family: 4 }] },
      ),
      timeoutMs: 2_000,
      jobs,
      signer: fx.signer,
      notices: {
        outbox: { keyring: fx.keyring, jobs, signer: fx.signer },
        appBaseUrl: 'https://app.w360.test',
      },
      logger: failOnLog,
      oauthTokens: new WebhookOAuthTokenCache(),
    },
    authorizedTenantScope(c.tenant.id, null),
  );
}

/** The bodies the receiver got on a path, parsed, in the order they arrived. */
const bodiesAt = (path: string) =>
  received
    .filter((r) => r.path === path)
    .map((r) => JSON.parse(r.body) as { id: string; type: string; data: Record<string, unknown> });

interface EventRow extends Record<string, unknown> {
  id: string;
  type: string;
  status: string | null;
  detail: Record<string, unknown>;
  conversation_id: string | null;
  contact_id: string | null;
  contact_changes: string[] | null;
  deliveries: number;
}

/** The company's captured events of the given types, oldest first, with their delivery counts. */
const eventsOf = (
  c: Company,
  prefix: 'conversation.' | 'contact.' | 'automation.' | 'order.' | 'campaign.',
) =>
  fx.query<EventRow>(
    `SELECT e.id, e.type, e.status, e.detail, e.conversation_id, e.contact_id, e.contact_changes,
            (SELECT count(*)::int FROM app.webhook_deliveries d
              WHERE d.tenant_id = e.tenant_id AND d.event_id = e.id) AS deliveries
       FROM app.webhook_events e
      WHERE e.tenant_id = $1 AND e.type LIKE $2 ORDER BY e.created_at, e.id`,
    [c.tenant.id, `${prefix}%`],
  );

/** An inbound text message through the Meta webhook pipeline; its conversation and contact. */
async function inbound(c: Company, from: string, text: string) {
  await fx.deliver(fx.messagesBody(c, { messages: [{ waId: from, text }] }));
  const [row] = await fx.query<{ conversation_id: string; contact_id: string }>(
    `SELECT m.conversation_id, cv.contact_id
       FROM app.messages m JOIN app.conversations cv ON cv.id = m.conversation_id
      WHERE m.tenant_id = $1 AND m.direction = 'inbound' ORDER BY m.created_at DESC LIMIT 1`,
    [c.tenant.id],
  );
  if (!row) throw new Error('inbound message not stored');
  return row;
}

const versionOf = async (conversationId: string) =>
  (
    await fx.query<{ version: number }>('SELECT version FROM app.conversations WHERE id = $1', [
      conversationId,
    ])
  )[0]!.version;

const membershipOf = async (c: Company, userId: string) =>
  (
    await fx.query<{ id: string }>(
      'SELECT id FROM app.memberships WHERE tenant_id = $1 AND user_id = $2',
      [c.tenant.id, userId],
    )
  )[0]!.id;

async function setStatus(c: Company, conversationId: string, status: 'open' | 'resolved') {
  const owner = await fx.ctx(c, c.owner);
  await inbox().setStatus(owner, {
    conversationId,
    status,
    expectedVersion: await versionOf(conversationId),
  });
}

async function assign(c: Company, conversationId: string, membershipId: string | null) {
  const owner = await fx.ctx(c, c.owner);
  await inbox().assign(owner, {
    conversationId,
    membershipId,
    expectedVersion: await versionOf(conversationId),
  });
}

/** A text[] literal for a statement, null elements included (drizzle spreads JS arrays). */
const textArray = (values: readonly (string | null)[] | null) =>
  values === null ? null : `{${values.map((v) => (v === null ? 'NULL' : `"${v}"`)).join(',')}}`;

async function expectRefusedBy(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
      messages.push(isAppError(current) ? current.publicMessage : current.message);
      current = current.cause;
    }
    expect(messages.join(' | ')).toMatch(pattern);
    return;
  }
  throw new Error('expected the statement to be refused');
}

describe('conversation events', () => {
  it('sends each status change with the status before it, from a member and from the contact writing again', async () => {
    const c = await fx.company();
    const endpoint = await addEndpoint(c, ['conversation.status_changed']);
    const from = waId();
    const { conversation_id: conversationId, contact_id: contactId } = await inbound(
      c,
      from,
      'Where is my order?',
    );
    // A new conversation or a message read sends nothing, and the contact the message added is
    // not captured: no endpoint takes contact events.
    await inbox().markRead(await fx.ctx(c, c.owner), conversationId);
    expect(await eventsOf(c, 'conversation.')).toEqual([]);
    expect(await eventsOf(c, 'contact.')).toEqual([]);

    await setStatus(c, conversationId, 'resolved');
    await inbound(c, from, 'One more question');
    const events = await eventsOf(c, 'conversation.');
    expect(events.map((e) => [e.type, e.status, e.detail, e.deliveries])).toEqual([
      ['conversation.status_changed', 'resolved', { previousStatus: 'open' }, 1],
      ['conversation.status_changed', 'open', { previousStatus: 'resolved' }, 1],
    ]);
    expect(events.every((e) => e.conversation_id === conversationId)).toBe(true);
    expect(events.every((e) => e.contact_id === contactId)).toBe(true);

    await deliverDue(c);
    const bodies = bodiesAt(endpoint.path);
    expect(bodies.map((b) => b.id)).toEqual(events.map((e) => e.id));
    for (const body of bodies) {
      expect(conversationStatusPayloadSchema.safeParse(body).success).toBe(true);
    }
    // The change is as captured; the rest is the conversation now (open again, nobody assigned).
    expect(bodies[0]).toMatchObject({
      type: 'conversation.status_changed',
      data: {
        conversation: {
          id: conversationId,
          status: 'resolved',
          previousStatus: 'open',
          assigned: false,
          assigneeId: null,
          teamId: null,
          resolvedAt: null,
        },
        contact: { id: contactId, phone: `+${from}`, name: 'Priya Customer' },
        channel: { id: c.channelAccountId },
      },
    });
    expect(bodies[1]).toMatchObject({
      data: { conversation: { status: 'open', previousStatus: 'resolved' } },
    });
  });

  it('sends an endpoint only the statuses it takes, another every change, and records no change nobody takes (ADR-149)', async () => {
    const c = await fx.company();
    // Resolutions only, with the contact's messages: a reopening is not even recorded.
    const resolutions = await addEndpoint(
      c,
      ['conversation.status_changed', 'message.received'],
      null,
      null,
      null,
      null,
      ['resolved'],
    );
    const from = waId();
    const { conversation_id: conversationId } = await inbound(c, from, 'Where is my order?');
    await setStatus(c, conversationId, 'resolved');
    await inbound(c, from, 'One more question');
    expect((await eventsOf(c, 'conversation.')).map((e) => [e.status, e.deliveries])).toEqual([
      ['resolved', 1],
    ]);

    // Then an endpoint taking every change: a reopening is recorded for it alone.
    const every = await addEndpoint(c, ['conversation.status_changed']);
    await setStatus(c, conversationId, 'resolved');
    await inbound(c, from, 'And another');
    expect((await eventsOf(c, 'conversation.')).map((e) => [e.status, e.deliveries])).toEqual([
      ['resolved', 1],
      ['resolved', 2],
      ['open', 1],
    ]);

    await deliverDue(c);
    const statusesAt = (path: string) =>
      bodiesAt(path)
        .filter((b) => b.type === 'conversation.status_changed')
        .map((b) => (b.data.conversation as { status: string }).status)
        .sort();
    expect(statusesAt(resolutions.path)).toEqual(['resolved', 'resolved']);
    // Its other events are not filtered: each of the contact's three messages.
    expect(bodiesAt(resolutions.path).filter((b) => b.type === 'message.received')).toHaveLength(3);
    expect(statusesAt(every.path)).toEqual(['open', 'resolved']);
  });

  it('sends every change of the member, naming the member before and after (ADR-094)', async () => {
    const c = await fx.company();
    const endpoint = await addEndpoint(c, ['conversation.assignment_changed']);
    const { conversation_id: conversationId } = await inbound(c, waId(), 'Hello');
    const agent = await membershipOf(c, c.agent.id);
    const owner = await membershipOf(c, c.owner.id);

    await assign(c, conversationId, agent);
    await assign(c, conversationId, owner);
    await setStatus(c, conversationId, 'resolved');
    await assign(c, conversationId, null);
    const events = await eventsOf(c, 'conversation.');
    expect(events.map((e) => [e.type, e.detail, e.deliveries])).toEqual([
      [
        'conversation.assignment_changed',
        { assigned: true, assigneeId: agent, previousAssigneeId: null },
        1,
      ],
      [
        'conversation.assignment_changed',
        { assigned: true, assigneeId: owner, previousAssigneeId: agent },
        1,
      ],
      [
        'conversation.assignment_changed',
        { assigned: false, assigneeId: null, previousAssigneeId: owner },
        1,
      ],
    ]);

    await deliverDue(c);
    const bodies = bodiesAt(endpoint.path);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(conversationAssignmentPayloadSchema.safeParse(body).success).toBe(true);
    }
    // The change is as captured; the status and team are the conversation's now.
    const shown = { id: conversationId, status: 'resolved', teamId: null };
    expect(bodies.map((b) => b.data.conversation)).toEqual([
      { ...shown, assigned: true, assigneeId: agent, previousAssigneeId: null },
      { ...shown, assigned: true, assigneeId: owner, previousAssigneeId: agent },
      { ...shown, assigned: false, assigneeId: null, previousAssigneeId: owner },
    ]);
  });

  it('sends every change of the team: routing, a member, an API key and the team being deleted (ADR-094)', async () => {
    const c = await fx.company();
    const endpoint = await addEndpoint(c, [
      'conversation.team_changed',
      'conversation.assignment_changed',
    ]);
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const teams = createTeamsService({ db: fx.dbs.app, clock: systemClock });
    // New conversations on the number go to Support, which gives them out in turn.
    const { teamId: support } = await teams.createTeam(owner, {
      name: 'Support',
      assignment: 'round_robin',
      memberIds: [agent.membership.id],
      channelIds: [c.channelAccountId],
    });
    const { teamId: sales } = await teams.createTeam(owner, { name: 'Sales' });
    const { teamId: returns } = await teams.createTeam(owner, { name: 'Returns' });
    await teams.setAvailability(agent, { available: true });

    // Routing places the new conversation in the team and gives it the agent in one change: one
    // event of each type.
    const { conversation_id: conversationId, contact_id: contactId } = await inbound(
      c,
      waId(),
      'Hello',
    );
    // A member moves it, then a key does, then its team is deleted.
    await inbox().setTeam(owner, {
      conversationId,
      teamId: sales,
      expectedVersion: await versionOf(conversationId),
    });
    const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'Router', scopes: ['conversations.write'], expiresInDays: 0 },
    );
    const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    if (!key) throw new Error('a new key does not authenticate');
    await apiUpdateConversation({ db: fx.dbs.app, clock: systemClock }, key, conversationId, {
      teamId: returns,
    });
    await teams.deleteTeam(owner, returns);

    const events = await eventsOf(c, 'conversation.');
    const teamEvents = events.filter((e) => e.type === 'conversation.team_changed');
    expect(teamEvents.map((e) => [e.detail, e.deliveries])).toEqual([
      [{ teamId: support, previousTeamId: null }, 1],
      [{ teamId: sales, previousTeamId: support }, 1],
      [{ teamId: returns, previousTeamId: sales }, 1],
      [{ teamId: null, previousTeamId: returns }, 1],
    ]);
    expect(teamEvents.every((e) => e.contact_id === contactId)).toBe(true);
    expect(
      events.filter((e) => e.type === 'conversation.assignment_changed').map((e) => e.detail),
    ).toEqual([{ assigned: true, assigneeId: agent.membership.id, previousAssigneeId: null }]);

    await deliverDue(c);
    const bodies = bodiesAt(endpoint.path).filter((b) => b.type === 'conversation.team_changed');
    expect(bodies.map((b) => b.id)).toEqual(teamEvents.map((e) => e.id));
    for (const body of bodies) {
      expect(conversationTeamPayloadSchema.safeParse(body).success).toBe(true);
    }
    // The change is as captured; the status and member are the conversation's now.
    const shown = { id: conversationId, status: 'open', assigneeId: agent.membership.id };
    expect(bodies.map((b) => b.data.conversation)).toEqual([
      { ...shown, teamId: support, previousTeamId: null },
      { ...shown, teamId: sales, previousTeamId: support },
      { ...shown, teamId: returns, previousTeamId: sales },
      { ...shown, teamId: null, previousTeamId: returns },
    ]);
    expect(bodies[0]).toMatchObject({
      data: { contact: { id: contactId }, channel: { id: c.channelAccountId } },
    });
  });

  it('keeps the order of two changes in one transaction, and gives the member and team as delivered (ADR-094)', async () => {
    const c = await fx.company();
    const endpoint = await addEndpoint(c, [
      'conversation.assignment_changed',
      'conversation.status_changed',
    ]);
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const teams = createTeamsService({ db: fx.dbs.app, clock: systemClock });
    const { teamId: support } = await teams.createTeam(owner, {
      name: 'Support',
      assignment: 'round_robin',
      memberIds: [agent.membership.id],
    });
    await teams.setAvailability(agent, { available: true });
    const { conversation_id: conversationId } = await inbound(c, waId(), 'Hello');
    await assign(c, conversationId, owner.membership.id);

    // One request takes the conversation from the owner and moves it to the team, whose routing
    // gives it to the agent: two changes of the member in one transaction.
    const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'Router', scopes: ['conversations.write'], expiresInDays: 0 },
    );
    const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    if (!key) throw new Error('a new key does not authenticate');
    expect(
      await apiUpdateConversation({ db: fx.dbs.app, clock: systemClock }, key, conversationId, {
        teamId: support,
        assigneeId: null,
      }),
    ).toMatchObject({ assigneeId: agent.membership.id, teamId: support });

    const rows = await fx.query<{ id: string; detail: Record<string, unknown> }>(
      `SELECT id, detail FROM app.webhook_events
        WHERE tenant_id = $1 AND conversation_id = $2 AND type = 'conversation.assignment_changed'
        ORDER BY occurred_at`,
      [c.tenant.id, conversationId],
    );
    expect(rows.map((r) => r.detail)).toEqual([
      { assigned: true, assigneeId: owner.membership.id, previousAssigneeId: null },
      { assigned: false, assigneeId: null, previousAssigneeId: owner.membership.id },
      { assigned: true, assigneeId: agent.membership.id, previousAssigneeId: null },
    ]);
    // Two transactions captured the three events, each at its own time.
    expect(
      await fx.query(
        `SELECT count(DISTINCT created_at)::int AS transactions,
                count(DISTINCT occurred_at)::int AS times
           FROM app.webhook_events
          WHERE tenant_id = $1 AND conversation_id = $2
            AND type = 'conversation.assignment_changed'`,
        [c.tenant.id, conversationId],
      ),
    ).toEqual([{ transactions: 2, times: 3 }]);

    // The key resolves it: the status event gives the member and team it has.
    await apiUpdateConversation({ db: fx.dbs.app, clock: systemClock }, key, conversationId, {
      status: 'resolved',
    });

    // Delivered with that time: the later change never has the earlier createdAt.
    await deliverDue(c);
    const bodies = bodiesAt(endpoint.path);
    const assignments = bodies.filter((b) => b.type === 'conversation.assignment_changed');
    const createdAt = new Map(
      assignments.map((b) => [b.id, (b as { createdAt?: string }).createdAt]),
    );
    expect(createdAt.size).toBe(3);
    const inOrder = rows.map((r) => createdAt.get(r.id) ?? '');
    expect([...inOrder].sort()).toEqual(inOrder);
    // The member changes are as captured; the team is the conversation's now.
    expect(
      assignments.map((b) => (b.data.conversation as { teamId: string | null }).teamId),
    ).toEqual([support, support, support]);
    const statuses = bodies.filter((b) => b.type === 'conversation.status_changed');
    expect(statuses).toHaveLength(1);
    expect(conversationStatusPayloadSchema.safeParse(statuses[0]).success).toBe(true);
    expect(statuses[0]!.data.conversation).toMatchObject({
      status: 'resolved',
      previousStatus: 'open',
      assigned: true,
      assigneeId: agent.membership.id,
      teamId: support,
    });
  });
});

describe('conversation events on chosen numbers (ADR-170)', () => {
  it('sends an endpoint that names numbers only the changes of conversations on them, and the events stay as they were stored', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const outlet = await fx.addNumber(c, { phone: '+91 90000 54321' });
    const types: WebhookEventType[] = [
      'conversation.status_changed',
      'conversation.assignment_changed',
      'conversation.team_changed',
    ];
    const onMain = await addNumberEndpoint(c, types, [c.channelAccountId]);
    const onOutlet = await addNumberEndpoint(c, types, [outlet.channelAccountId]);
    const { teamId: sales } = await createTeamsService({
      db: fx.dbs.app,
      clock: systemClock,
    }).createTeam(owner, { name: 'Sales' });
    const agents = await membershipOf(c, c.agent.id);
    // A conversation on the first number resolved, given to a member and moved to a team: one
    // event of each, for the first number's endpoint.
    const { conversation_id: main } = await inbound(c, waId(), 'Hello');
    await setStatus(c, main, 'resolved');
    await assign(c, main, agents);
    await inbox().setTeam(owner, {
      conversationId: main,
      teamId: sales,
      expectedVersion: await versionOf(main),
    });
    // One on the outlet resolved, for the outlet's.
    const { conversation_id: shop } = await inbound(outlet, waId(), 'Hi');
    await setStatus(c, shop, 'resolved');
    const events = await eventsOf(c, 'conversation.');
    expect(events.map((e) => [e.type, e.conversation_id, e.detail, e.deliveries])).toEqual([
      ['conversation.status_changed', main, { previousStatus: 'open' }, 1],
      [
        'conversation.assignment_changed',
        main,
        { assigned: true, assigneeId: agents, previousAssigneeId: null },
        1,
      ],
      ['conversation.team_changed', main, { teamId: sales, previousTeamId: null }, 1],
      ['conversation.status_changed', shop, { previousStatus: 'open' }, 1],
    ]);

    await deliverDue(c);
    expect(numbersAt(onMain.path, 'conversation')).toEqual(
      [
        ['conversation.status_changed', main, c.channelAccountId],
        ['conversation.assignment_changed', main, c.channelAccountId],
        ['conversation.team_changed', main, c.channelAccountId],
      ].sort(),
    );
    expect(numbersAt(onOutlet.path, 'conversation')).toEqual([
      ['conversation.status_changed', shop, outlet.channelAccountId],
    ]);
  });
});

describe('contact events', () => {
  it('sends one contact.created for a contact added with its tags, only to the endpoints that take it', async () => {
    const c = await fx.company();
    const creations = await addEndpoint(c, ['contact.created']);
    const updates = await addEndpoint(c, ['contact.updated']);
    const owner = await fx.ctx(c, c.owner);
    const { id: contactId } = await contactsService().createContact(owner, {
      displayName: 'Anil Kumar',
      phone: '+919811100011',
      email: 'anil@example.test',
      tags: ['vip', 'lead'],
    });
    const events = await eventsOf(c, 'contact.');
    expect(events.map((e) => [e.type, e.contact_id, e.deliveries])).toEqual([
      ['contact.created', contactId, 1],
    ]);

    await deliverDue(c);
    expect(bodiesAt(updates.path)).toEqual([]);
    const [body] = bodiesAt(creations.path);
    expect(contactCreatedPayloadSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      id: events[0]!.id,
      type: 'contact.created',
      data: {
        contact: {
          id: contactId,
          name: 'Anil Kumar',
          phone: '+919811100011',
          email: 'anil@example.test',
          tags: ['lead', 'vip'],
          consent: { marketing: null, utility: null },
          source: 'manual',
          erased: false,
        },
      },
    });
    // Only updates say what changed (ADR-121).
    expect(body!.data).not.toHaveProperty('changes');
  });

  it('sends one contact.updated per save of the name, number, email, tags or custom field values, and nothing for an unchanged save or a field renamed or deleted', async () => {
    const c = await fx.company();
    const endpoint = await addEndpoint(c, ['contact.updated']);
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    const city = await service.createField(owner, { label: 'City', key: 'city', type: 'text' });
    // A field whose value never changes, so it is never named.
    await service.createField(owner, { label: 'Plan', key: 'plan', type: 'text' });
    const { id: contactId } = await service.createContact(owner, {
      displayName: 'Bina',
      phone: '+919811100012',
    });
    // Added: captured as created (no endpoint takes it, so it has no delivery).
    expect((await eventsOf(c, 'contact.')).map((e) => [e.type, e.deliveries])).toEqual([
      ['contact.created', 0],
    ]);

    // Each field on its own, then all three in one save, then two tags added and one removed.
    const changes = [
      { displayName: 'Bina R' },
      { displayName: 'Bina R', email: 'b@example.test' },
      { displayName: 'Bina R', phone: '+919811100014' },
      { displayName: 'Bina Rao', email: 'bina@example.test', phone: '+919811100013' },
    ];
    const counts: number[] = [];
    const updatesSoFar = async () =>
      (await eventsOf(c, 'contact.')).filter((e) => e.type === 'contact.updated').length;
    for (const change of changes) {
      await service.updateContact(owner, contactId, change);
      counts.push(await updatesSoFar());
    }
    await service.addTags(owner, contactId, ['gold', 'north']);
    counts.push(await updatesSoFar());
    await service.removeTag(owner, contactId, 'gold');
    counts.push(await updatesSoFar());
    // A custom field's value is part of the contact (ADR-112); a save that changes nothing sends
    // nothing.
    await service.updateContact(owner, contactId, {
      displayName: 'Bina Rao',
      attributes: { city: 'Pune' },
    });
    counts.push(await updatesSoFar());
    await service.updateContact(owner, contactId, {
      displayName: 'Bina Rao',
      attributes: { city: 'Pune' },
    });
    counts.push(await updatesSoFar());
    // Renaming the field changes no value, and deleting it removes its value from every contact at
    // once, without an event for each.
    await service.renameField(owner, city.id, 'Town');
    await service.deleteField(owner, city.id);
    counts.push(await updatesSoFar());
    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 7, 7]);
    const events = await eventsOf(c, 'contact.');
    expect(events.map((e) => [e.type, e.deliveries])).toEqual([
      ['contact.created', 0],
      ...Array.from({ length: 7 }, () => ['contact.updated', 1]),
    ]);
    // Each update names what its save changed, sorted (ADR-121); a name saved unchanged is not
    // named, and the created event names nothing.
    expect(events.map((e) => e.contact_changes)).toEqual([
      null,
      ['name'],
      ['email'],
      ['phone'],
      ['email', 'name', 'phone'],
      ['tags'],
      ['tags'],
      ['fields.city'],
    ]);

    await deliverDue(c);
    const bodies = bodiesAt(endpoint.path);
    expect(bodies).toHaveLength(7);
    const changesOf = new Map(events.map((e) => [e.id, e.contact_changes]));
    for (const body of bodies) {
      expect(contactUpdatedPayloadSchema.safeParse(body).success).toBe(true);
      expect(body.data.changes).toEqual(changesOf.get(body.id));
      // Built when delivered: every body shows the contact as it is now.
      expect(body.data.contact).toMatchObject({
        name: 'Bina Rao',
        phone: '+919811100013',
        email: 'bina@example.test',
        tags: ['north'],
        erased: false,
      });
      // The deleted field's value is gone.
      expect((body.data.contact as { fields: unknown }).fields).toEqual({});
    }
  });

  it('sends contact.created when a customer first writes, and nothing when they write again', async () => {
    const c = await fx.company();
    const endpoint = await addEndpoint(c, ['contact.created', 'contact.updated']);
    const from = waId();
    const { contact_id: contactId } = await inbound(c, from, 'Hi');
    await inbound(c, from, 'Hi again');
    const events = await eventsOf(c, 'contact.');
    expect(events.map((e) => [e.type, e.contact_id])).toEqual([['contact.created', contactId]]);
    await deliverDue(c);
    expect(bodiesAt(endpoint.path).map((b) => b.data.contact)).toMatchObject([
      { id: contactId, phone: `+${from}`, name: 'Priya Customer', source: 'whatsapp' },
    ]);
  });

  it('sends one contact.created per contact an import adds, and one contact.updated per contact it changes', async () => {
    const c = await fx.company();
    await addEndpoint(c, ['contact.created', 'contact.updated']);
    const marketer = await fx.ctx(c, c.marketer);
    const service = contactsService();
    await service.createContact(await fx.ctx(c, c.owner), {
      displayName: 'Chitra',
      phone: '+919811100021',
    });
    const csv = [
      'Phone,Name,Email,Tags',
      '98111 00021,Chitra S,chitra@example.test,gold',
      '98111 00022,Dev,,silver;north',
      '98111 00023,Esha,esha@example.test,',
    ].join('\r\n');
    const result = await service.importContacts(marketer, {
      text: csv,
      fileName: 'customers.csv',
      mapping: { phone: 0, name: 1, email: 2, tags: 3, fields: {} },
      phoneFormat: 'national',
      callingCode: '91',
      updateExisting: true,
      tags: ['import-1'],
      consent: { mode: 'none' },
    });
    expect(result).toMatchObject({ created: 2, updated: 1 });
    // Chitra was added before the import (created), then changed by it (updated); Dev and Esha
    // were added by it, with their tags, one event each.
    const byPhone = new Map<string, string[]>();
    for (const e of await eventsOf(c, 'contact.')) {
      const [row] = await fx.query<{ phone: string }>(
        'SELECT phone_e164 AS phone FROM app.contacts WHERE id = $1',
        [e.contact_id],
      );
      byPhone.set(row!.phone, [...(byPhone.get(row!.phone) ?? []), e.type]);
    }
    expect(Object.fromEntries(byPhone)).toEqual({
      '+919811100021': ['contact.created', 'contact.updated'],
      '+919811100022': ['contact.created'],
      '+919811100023': ['contact.created'],
    });
    // Its name and email in one statement, its tags in others: one event naming all three.
    const updated = (await eventsOf(c, 'contact.')).filter((e) => e.type === 'contact.updated');
    expect(updated.map((e) => e.contact_changes)).toEqual([['email', 'name', 'tags']]);
  });

  it('erasing sends only contact.erased, without personal data, even for a contact changed in the same transaction', async () => {
    const c = await fx.company();
    const all = await addEndpoint(c, ['contact.created', 'contact.updated', 'contact.erased']);
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    const { id: contactId } = await service.createContact(owner, {
      displayName: 'Farah',
      phone: '+919811100031',
      email: 'farah@example.test',
      tags: ['vip'],
    });
    await service.updateContact(owner, contactId, { displayName: 'Farah Khan' });
    const before = (await eventsOf(c, 'contact.')).map((e) => e.type);
    expect(before).toEqual(['contact.created', 'contact.updated']);

    // Erasure removes the tags first (a change of the contact), then erases it: only the erasure
    // is captured in that transaction.
    await service.eraseContact(owner, { contactId, suppress: false });
    const events = await eventsOf(c, 'contact.');
    expect(events.map((e) => [e.type, e.deliveries])).toEqual([
      ['contact.created', 1],
      ['contact.updated', 1],
      ['contact.erased', 1],
    ]);

    // Built when delivered: the events captured before the erasure carry no personal data either.
    await deliverDue(c);
    const bodies = bodiesAt(all.path);
    expect(bodies.map((b) => b.type)).toEqual([
      'contact.created',
      'contact.updated',
      'contact.erased',
    ]);
    expect(contactErasedPayloadSchema.safeParse(bodies[2]).success).toBe(true);
    // What the update changed is kept, names only; the created and erased events name nothing.
    expect(bodies.map((b) => b.data.changes)).toEqual([undefined, ['name'], undefined]);
    for (const body of bodies) {
      expect(body.data.contact).toMatchObject({
        id: contactId,
        name: null,
        phone: null,
        email: null,
        tags: [],
        consent: { marketing: null, utility: null },
        source: 'manual',
        erased: true,
      });
      expect(JSON.stringify(body)).not.toMatch(/Farah|farah|9811100031|vip/);
    }
  });

  it('an endpoint that takes only updates hears nothing of an erasure', async () => {
    const c = await fx.company();
    await addEndpoint(c, ['contact.updated']);
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    const { id: contactId } = await service.createContact(owner, {
      phone: '+919811100041',
      tags: ['gold', 'north'],
    });
    await service.eraseContact(owner, { contactId, suppress: true });
    expect((await eventsOf(c, 'contact.')).map((e) => [e.type, e.deliveries])).toEqual([
      ['contact.created', 0],
    ]);
  });

  it('keeps one event per contact and transaction across savepoints; a rolled-back savepoint leaves none behind', async () => {
    const c = await fx.company();
    await addEndpoint(c, ['contact.updated']);
    const owner = await fx.ctx(c, c.owner);
    const { id: contactId } = await contactsService().createContact(owner, {
      phone: '+919811100051',
    });
    const scope = authorizedTenantScope(c.tenant.id, c.owner.id);
    const rename = (name: string) =>
      sql`update app.contacts set display_name = ${name} where id = ${contactId}::uuid`;
    const addTag = (tag: string) =>
      sql`insert into app.contact_tags (id, tenant_id, contact_id, tag)
        values (gen_random_uuid(), ${c.tenant.id}::uuid, ${contactId}::uuid, ${tag})`;
    const rolledBack = (tx: Tx, statement: ReturnType<typeof sql>) =>
      tx
        .transaction(async (sp) => {
          await sp.execute(statement);
          throw new Error('roll the savepoint back');
        })
        .catch((error: unknown) => {
          if (!(error instanceof Error) || error.message !== 'roll the savepoint back') throw error;
        });
    await fx.dbs.app.run(scope, async (tx) => {
      // A change in a savepoint that rolls back: its event goes with it.
      await rolledBack(tx, rename('Rolled back'));
      // The next change captures the event; the ones after it, in savepoints or not, add none,
      // and add what they changed to it (ADR-121), unless their savepoint rolls back.
      await tx.execute(rename('Gita'));
      await tx.transaction(async (sp) => {
        await sp.execute(sql`update app.contacts set email = 'gita@example.test'
          where id = ${contactId}::uuid`);
      });
      await rolledBack(tx, addTag('silver'));
      await tx.execute(sql`update app.contacts set phone_e164 = '+919811100052'
        where id = ${contactId}::uuid`);
    });
    const [row] = await fx.dbs.app.run(scope, (tx) =>
      tx.select({ name: contacts.displayName }).from(contacts).where(eq(contacts.id, contactId)),
    );
    expect(row?.name).toBe('Gita');
    expect(
      (await eventsOf(c, 'contact.')).map((e) => [e.type, e.deliveries, e.contact_changes]),
    ).toEqual([
      ['contact.created', 0, null],
      ['contact.updated', 1, ['email', 'name', 'phone']],
    ]);
    // A tag in a transaction of its own is its own change.
    await fx.dbs.app.run(scope, (tx) => tx.execute(addTag('gold')));
    expect((await eventsOf(c, 'contact.')).map((e) => e.contact_changes)).toEqual([
      null,
      ['email', 'name', 'phone'],
      ['tags'],
    ]);
  });

  it('the capture function takes contact events only, what changed for updates only, and the company role cannot use it to delete events', async () => {
    const c = await fx.company();
    await addEndpoint(c, ['contact.created', 'contact.erased']);
    const owner = await fx.ctx(c, c.owner);
    const { id: contactId } = await contactsService().createContact(owner, {
      phone: '+919811100061',
    });
    const scope = authorizedTenantScope(c.tenant.id, c.owner.id);
    const capture = (type: string, changes: string[] | null) =>
      fx.dbs.app.run(scope, (tx) =>
        tx.execute(
          sql`select app.capture_contact_webhook_event(${c.tenant.id}::uuid, ${contactId}::uuid,
            ${type}, ${textArray(changes)}::text[])`,
        ),
      );
    await expectRefusedBy(capture('message.status', null), /not a contact event/);
    await expectRefusedBy(capture('message.status', ['name']), /not a contact event/);
    const onlyUpdates = /only contact\.updated names what changed, and it always does/;
    await expectRefusedBy(capture('contact.updated', null), onlyUpdates);
    await expectRefusedBy(capture('contact.updated', []), onlyUpdates);
    await expectRefusedBy(capture('contact.created', ['name']), onlyUpdates);
    await expectRefusedBy(capture('contact.erased', ['name']), onlyUpdates);
    await expectRefusedBy(
      capture('contact.erased', null),
      /permission denied for table webhook_events/,
    );
    expect((await eventsOf(c, 'contact.')).map((e) => e.type)).toEqual(['contact.created']);
  });

  it('only the transaction that captured an update adds to what it changed, and nothing else changes stored events (ADR-121)', async () => {
    const c = await fx.company();
    const other = await fx.company();
    await addEndpoint(c, ['contact.updated']);
    await addEndpoint(other, ['contact.updated']);
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    const { id: contactId } = await service.createContact(owner, { phone: '+919811100071' });
    await service.updateContact(owner, contactId, { displayName: 'Hari' });
    const otherOwner = await fx.ctx(other, other.owner);
    const { id: otherContact } = await service.createContact(otherOwner, {
      phone: '+919811100072',
    });
    await service.updateContact(otherOwner, otherContact, { displayName: 'Indu' });
    const [event] = (await eventsOf(c, 'contact.')).filter((e) => e.type === 'contact.updated');
    const [otherEvent] = (await eventsOf(other, 'contact.')).filter(
      (e) => e.type === 'contact.updated',
    );
    expect([event?.contact_changes, otherEvent?.contact_changes]).toEqual([['name'], ['name']]);

    // Its own events of a later transaction, or another company's, stay as captured.
    const scope = authorizedTenantScope(c.tenant.id, c.owner.id);
    for (const [tenant, id] of [
      [c.tenant.id, event!.id],
      [other.tenant.id, otherEvent!.id],
    ] as const) {
      await fx.dbs.app.run(scope, (tx) =>
        tx.execute(sql`select app.add_contact_webhook_changes(${tenant}::uuid, ${id}::uuid,
          array['email'])`),
      );
    }
    // The company role reads and adds events, and changes none of them.
    await expectRefusedBy(
      fx.dbs.app.run(scope, (tx) =>
        tx.execute(sql`update app.webhook_events set contact_changes = array['email']
          where id = ${event!.id}::uuid`),
      ),
      /permission denied for table webhook_events/,
    );
    expect((await eventsOf(c, 'contact.')).map((e) => e.contact_changes)).toEqual([null, ['name']]);
    expect((await eventsOf(other, 'contact.')).map((e) => e.contact_changes)).toEqual([
      null,
      ['name'],
    ]);

    // Even the event its own transaction captured is changed only when named with its company.
    const otherScope = authorizedTenantScope(other.tenant.id, other.owner.id);
    const inOneTransaction = await fx.dbs.app.run(otherScope, async (tx) => {
      await tx.execute(sql`update app.contacts set display_name = 'Indu Rao'
        where id = ${otherContact}::uuid`);
      const captured = await tx.execute<{ id: string }>(sql`select id from app.webhook_events
        where contact_id = ${otherContact}::uuid and captured_xact = pg_current_xact_id()`);
      const id = captured.rows[0]!.id;
      await tx.execute(sql`select app.add_contact_webhook_changes(${c.tenant.id}::uuid, ${id}::uuid,
        array['email'])`);
      const stored = await tx.execute<{ contact_changes: string[] }>(sql`select contact_changes
        from app.webhook_events where id = ${id}::uuid`);
      return stored.rows.map((r) => r.contact_changes);
    });
    expect(inOneTransaction).toEqual([['name']]);
  });

  it('stores only the parts a contact has, on updates only (ADR-121)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { id: contactId } = await contactsService().createContact(owner, {
      phone: '+919811100081',
    });
    const scope = authorizedTenantScope(c.tenant.id, c.owner.id);
    const store = (type: string, changes: (string | null)[] | null) =>
      fx.dbs.app.run(scope, (tx) =>
        tx.execute(sql`insert into app.webhook_events (id, tenant_id, type, contact_id, contact_changes)
          values (gen_random_uuid(), ${c.tenant.id}::uuid, ${type}, ${contactId}::uuid,
            ${textArray(changes)}::text[])`),
      );
    await store('contact.updated', ['email', 'fields.city', 'name', 'phone', 'tags']);
    await store('contact.updated', null);
    await store('contact.created', null);
    const check = /webhook_events_contact_changes_check/;
    for (const changes of [
      [],
      ['nickname'],
      ['fields.City'],
      ['fields.'],
      ['name', 'fields'],
      ['name', null],
    ]) {
      await expectRefusedBy(store('contact.updated', changes), check);
    }
    await expectRefusedBy(store('contact.created', ['name']), check);
    await expectRefusedBy(store('contact.erased', ['name']), check);
    await expectRefusedBy(
      fx.dbs.app.run(scope, (tx) =>
        tx.execute(sql`insert into app.webhook_events (id, tenant_id, type, contact_id, contact_changes)
          values (gen_random_uuid(), ${c.tenant.id}::uuid, 'contact.updated', ${contactId}::uuid,
            array[array['name'], array['email']])`),
      ),
      check,
    );
  });
});

describe('contact part filters (ADR-123)', () => {
  /** Each contact.updated of the company, oldest first: what it changed, and who it is queued for. */
  const updatesOf = async (c: Company, names: Map<string, string>) =>
    (
      await fx.query<{ changes: string[] | null; endpoints: string[] }>(
        `SELECT e.contact_changes AS changes,
                coalesce((SELECT array_agg(d.endpoint_id::text) FROM app.webhook_deliveries d
                           WHERE d.tenant_id = e.tenant_id AND d.event_id = e.id), '{}') AS endpoints
           FROM app.webhook_events e
          WHERE e.tenant_id = $1 AND e.type = 'contact.updated' ORDER BY e.created_at, e.id`,
        [c.tenant.id],
      )
    ).map((e) => [e.changes, e.endpoints.map((id) => names.get(id) ?? id).sort()]);

  it('queue a change for the endpoints that take one of its parts, a later change in the transaction for those it newly concerns, and none from a rolled-back savepoint', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    await service.createField(owner, { label: 'City', key: 'city', type: 'text' });
    const every = await addEndpoint(c, ['contact.updated']);
    const emails = await addEndpoint(c, ['contact.updated'], ['email']);
    const tagsAndFields = await addEndpoint(
      c,
      ['contact.updated', 'contact.erased'],
      ['tags', 'fields'],
    );
    // Neither an endpoint taking only added contacts nor one turned off is queued an update.
    const createdOnly = await addEndpoint(c, ['contact.created']);
    const off = await addEndpoint(c, ['contact.updated']);
    await webhooks().setEnabled(owner, { endpointId: off.id, enabled: false });
    const names = new Map([
      [every.id, 'every'],
      [emails.id, 'emails'],
      [tagsAndFields.id, 'tagsAndFields'],
      [createdOnly.id, 'createdOnly'],
      [off.id, 'off'],
    ]);
    expect(
      (await webhooks().list(owner)).map((e) => [names.get(e.id), e.contactParts]).sort(),
    ).toEqual([
      ['createdOnly', null],
      ['emails', ['email']],
      ['every', null],
      ['off', null],
      ['tagsAndFields', ['tags', 'fields']],
    ]);
    const { id: contactId } = await service.createContact(owner, {
      displayName: 'Dev',
      phone: '+919811100061',
    });

    // One part at a time.
    await service.updateContact(owner, contactId, { displayName: 'Dev K' });
    await service.updateContact(owner, contactId, {
      displayName: 'Dev K',
      email: 'dev@example.test',
    });
    await service.addTags(owner, contactId, ['gold']);
    await service.updateContact(owner, contactId, {
      displayName: 'Dev K',
      attributes: { city: 'Pune' },
    });
    const scope = authorizedTenantScope(c.tenant.id, c.owner.id);
    const rename = (name: string) =>
      sql`update app.contacts set display_name = ${name} where id = ${contactId}::uuid`;
    const setEmail = (email: string) =>
      sql`update app.contacts set email = ${email} where id = ${contactId}::uuid`;
    const addTag = (tag: string) =>
      sql`insert into app.contact_tags (id, tenant_id, contact_id, tag)
        values (gen_random_uuid(), ${c.tenant.id}::uuid, ${contactId}::uuid, ${tag})`;
    // A name, then a tag, in one transaction: the tag reaches the endpoint that takes tags.
    await fx.dbs.app.run(scope, async (tx) => {
      await tx.execute(rename('Dev Kumar'));
      await tx.execute(addTag('silver'));
    });
    // An email, then a tag in a savepoint that rolls back: the tag's delivery goes with it.
    await fx.dbs.app.run(scope, async (tx) => {
      await tx.execute(setEmail('devk@example.test'));
      await tx
        .transaction(async (sp) => {
          await sp.execute(addTag('bronze'));
          throw new Error('roll the savepoint back');
        })
        .catch((error: unknown) => {
          if (!(error instanceof Error) || error.message !== 'roll the savepoint back') throw error;
        });
    });
    // A tag, an email and another tag in one transaction: each endpoint is queued once.
    await fx.dbs.app.run(scope, async (tx) => {
      await tx.execute(addTag('platinum'));
      await tx.execute(setEmail('dk@example.test'));
      await tx.execute(addTag('steel'));
    });

    expect(await updatesOf(c, names)).toEqual([
      [['name'], ['every']],
      [['email'], ['emails', 'every']],
      [['tags'], ['every', 'tagsAndFields']],
      [['fields.city'], ['every', 'tagsAndFields']],
      [
        ['name', 'tags'],
        ['every', 'tagsAndFields'],
      ],
      [['email'], ['emails', 'every']],
      [
        ['email', 'tags'],
        ['emails', 'every', 'tagsAndFields'],
      ],
    ]);

    // Each endpoint gets the same event, naming every part that changed.
    await deliverDue(c);
    const changesAt = (path: string) =>
      bodiesAt(path)
        .filter((b) => b.type === 'contact.updated')
        .map((b) => JSON.stringify(b.data.changes))
        .sort();
    expect(changesAt(every.path)).toHaveLength(7);
    expect(changesAt(emails.path)).toEqual(['["email","tags"]', '["email"]', '["email"]']);
    expect(changesAt(tagsAndFields.path)).toEqual([
      '["email","tags"]',
      '["fields.city"]',
      '["name","tags"]',
      '["tags"]',
    ]);
  });

  it('an erasure still sends only contact.erased to an endpoint that takes tag changes', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    const tags = await addEndpoint(c, ['contact.updated', 'contact.erased'], ['tags']);
    // Another company's endpoint takes every change; the definer role erasing sees every company's
    // endpoints, and none of them may be queued anything.
    const other = await fx.company();
    await addEndpoint(other, ['contact.updated']);
    const { id: contactId } = await service.createContact(owner, {
      phone: '+919811100071',
      tags: ['gold', 'silver'],
    });
    await service.addTags(owner, contactId, ['bronze']);
    expect(await updatesOf(c, new Map([[tags.id, 'tags']]))).toEqual([[['tags'], ['tags']]]);
    // Erasing removes the three tags, as the definer role (the first queues the endpoint, the
    // others add nothing more), then drops the transaction's update with its delivery.
    await service.eraseContact(owner, { contactId, suppress: false });
    expect((await eventsOf(c, 'contact.')).map((e) => [e.type, e.deliveries])).toEqual([
      ['contact.created', 0],
      ['contact.updated', 1],
      ['contact.erased', 1],
    ]);
    await deliverDue(c);
    expect(bodiesAt(tags.path).map((b) => b.type)).toEqual(
      expect.arrayContaining(['contact.updated', 'contact.erased']),
    );
    expect(bodiesAt(tags.path)).toHaveLength(2);
    expect(await eventsOf(other, 'contact.')).toEqual([]);
  });
});

describe('contact tag changes (ADR-182)', () => {
  /** The company's contact events, oldest first: type, what changed and the tags it listed. */
  const tagsOf = async (c: Company) =>
    (
      await fx.query<{
        id: string;
        type: string;
        changes: string[] | null;
        added: string[] | null;
        removed: string[] | null;
      }>(
        `SELECT id, type, contact_changes AS changes, tags_added AS added, tags_removed AS removed
           FROM app.webhook_events
          WHERE tenant_id = $1 AND type LIKE 'contact.%' ORDER BY created_at, id`,
        [c.tenant.id],
      )
    ).map((e) => ({ ...e, row: [e.type, e.changes, e.added, e.removed] }));

  it('keep the tags each change added and removed, sorted and net within its transaction, empty for a change of no tag, and none for a contact added with its tags', async () => {
    const c = await fx.company();
    const endpoint = await addEndpoint(c, ['contact.created', 'contact.updated']);
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    // Added with a tag: one contact.created, which lists no tags.
    const { id: contactId } = await service.createContact(owner, {
      displayName: 'Hema',
      phone: '+919811100091',
      tags: ['trial'],
    });
    await service.addTags(owner, contactId, ['vip', 'north']);
    await service.removeTag(owner, contactId, 'trial');
    await service.updateContact(owner, contactId, { displayName: 'Hema K' });
    const scope = authorizedTenantScope(c.tenant.id, c.owner.id);
    const addTag = (tag: string) =>
      sql`insert into app.contact_tags (id, tenant_id, contact_id, tag)
        values (gen_random_uuid(), ${c.tenant.id}::uuid, ${contactId}::uuid, ${tag})`;
    const removeTag = (tag: string) =>
      sql`delete from app.contact_tags where contact_id = ${contactId}::uuid and tag = ${tag}`;
    // One transaction: a tag added and removed again, one removed and added back, one removed and
    // one added. Only the last two are listed.
    await fx.dbs.app.run(scope, async (tx) => {
      await tx.execute(addTag('gold'));
      await tx.execute(removeTag('gold'));
      await tx.execute(removeTag('vip'));
      await tx.execute(addTag('vip'));
      await tx.execute(removeTag('north'));
      await tx.execute(addTag('south'));
    });
    // A change of tags that undoes itself is still a change of tags, with both lists empty.
    await fx.dbs.app.run(scope, async (tx) => {
      await tx.execute(addTag('gold'));
      await tx.execute(removeTag('gold'));
    });
    const events = await tagsOf(c);
    expect(events.map((e) => e.row)).toEqual([
      ['contact.created', null, null, null],
      ['contact.updated', ['tags'], ['north', 'vip'], []],
      ['contact.updated', ['tags'], [], ['trial']],
      ['contact.updated', ['name'], [], []],
      ['contact.updated', ['tags'], ['south'], ['north']],
      ['contact.updated', ['tags'], [], []],
    ]);

    // Each update is delivered with its lists; the created event has none.
    await deliverDue(c);
    const bodies = bodiesAt(endpoint.path);
    expect(bodies).toHaveLength(6);
    const byId = new Map(events.map((e) => [e.id, e]));
    for (const body of bodies) {
      const event = byId.get(body.id)!;
      if (body.type === 'contact.created') {
        expect(Object.keys(body.data)).toEqual(['contact']);
        continue;
      }
      expect(contactUpdatedPayloadSchema.safeParse(body).success).toBe(true);
      expect([body.data.changes, body.data.tagsAdded, body.data.tagsRemoved]).toEqual([
        event.changes,
        event.added,
        event.removed,
      ]);
      expect(body.data.contact).toMatchObject({ tags: ['south', 'vip'], erased: false });
    }
  });

  it('erasing a contact clears the tags its events listed and sends none, and nothing else changes the lists', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const endpoint = await addEndpoint(c, ['contact.updated', 'contact.erased']);
    await addEndpoint(other, ['contact.updated']);
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    const { id: contactId } = await service.createContact(owner, { phone: '+919811100093' });
    await service.addTags(owner, contactId, ['diabetic', 'vip']);
    await service.removeTag(owner, contactId, 'vip');
    // Another company's contact, tagged too.
    const otherOwner = await fx.ctx(other, other.owner);
    const { id: otherContact } = await service.createContact(otherOwner, {
      phone: '+919811100094',
    });
    await service.addTags(otherOwner, otherContact, ['vip']);
    const listsOf = async (company: Company) =>
      (await tagsOf(company)).filter((e) => e.type === 'contact.updated').map((e) => e.row);

    // The company role cannot write the lists, and the function that notes a tag changes only an
    // event its own transaction captured.
    const scope = authorizedTenantScope(c.tenant.id, c.owner.id);
    const [first] = (await tagsOf(c)).filter((e) => e.type === 'contact.updated');
    await expectRefusedBy(
      fx.dbs.app.run(scope, (tx) =>
        tx.execute(sql`update app.webhook_events set tags_added = '{}'
          where id = ${first!.id}::uuid`),
      ),
      /permission denied for table webhook_events/,
    );
    await fx.dbs.app.run(scope, (tx) =>
      tx.execute(sql`select app.note_contact_webhook_tag(${c.tenant.id}::uuid, ${contactId}::uuid,
        'gold', true)`),
    );
    expect(await listsOf(c)).toEqual([
      ['contact.updated', ['tags'], ['diabetic', 'vip'], []],
      ['contact.updated', ['tags'], [], ['vip']],
    ]);

    // Erased: the lists are cleared from every event of the contact; the other company's stay.
    await service.eraseContact(owner, { contactId, suppress: false });
    expect(await listsOf(c)).toEqual([
      ['contact.updated', ['tags'], null, null],
      ['contact.updated', ['tags'], null, null],
    ]);
    expect(await listsOf(other)).toEqual([['contact.updated', ['tags'], ['vip'], []]]);

    // Delivered after the erasure, the updates say what changed and name no tag.
    await deliverDue(c);
    const bodies = bodiesAt(endpoint.path);
    expect(bodies.map((b) => b.type).sort()).toEqual([
      'contact.erased',
      'contact.updated',
      'contact.updated',
    ]);
    for (const body of bodies.filter((b) => b.type === 'contact.updated')) {
      expect(body.data).toMatchObject({ changes: ['tags'], tagsAdded: null, tagsRemoved: null });
      expect(JSON.stringify(body)).not.toMatch(/diabetic|vip/);
    }
  });

  it('stores tag lists on updates only, both or neither, without a null entry or a tag in both', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { id: contactId } = await contactsService().createContact(owner, {
      phone: '+919811100095',
    });
    const scope = authorizedTenantScope(c.tenant.id, c.owner.id);
    const store = (
      type: string,
      added: readonly (string | null)[] | null,
      removed: readonly (string | null)[] | null,
    ) =>
      fx.dbs.app.run(scope, (tx) =>
        tx.execute(sql`insert into app.webhook_events
            (id, tenant_id, type, contact_id, contact_changes, tags_added, tags_removed)
          values (gen_random_uuid(), ${c.tenant.id}::uuid, ${type}, ${contactId}::uuid,
            ${type === 'contact.updated' ? '{tags}' : null}::text[], ${textArray(added)}::text[],
            ${textArray(removed)}::text[])`),
      );
    await store('contact.updated', ['repeat', 'vip'], ['trial']);
    await store('contact.updated', [], []);
    await store('contact.updated', null, null);
    await store('contact.created', null, null);
    const check = /webhook_events_tag_changes_check/;
    for (const [added, removed] of [
      [['vip'], null],
      [null, []],
      [['vip', null], []],
      [[], [null]],
      [['vip'], ['trial', 'vip']],
    ] as const) {
      await expectRefusedBy(store('contact.updated', added, removed), check);
    }
    await expectRefusedBy(store('contact.created', [], []), check);
    await expectRefusedBy(store('contact.erased', ['vip'], []), check);
    await expectRefusedBy(
      fx.dbs.app.run(scope, (tx) =>
        tx.execute(sql`insert into app.webhook_events
            (id, tenant_id, type, contact_id, contact_changes, tags_added, tags_removed)
          values (gen_random_uuid(), ${c.tenant.id}::uuid, 'contact.updated', ${contactId}::uuid,
            '{tags}', array[array['a'], array['b']], '{}')`),
      ),
      check,
    );
  });
});

describe('message events (ADR-082)', () => {
  it('name the message a customer quotes or reacts to, when it is in the conversation', async () => {
    const c = await fx.company();
    const endpoint = await addEndpoint(c, ['message.received']);
    const from = waId();
    const asked = `wamid.in.${uuidv7()}`;
    const deliverInbound = (m: Record<string, unknown>) =>
      fx.deliver(fx.messagesBody(c, { messages: [{ waId: from, ...m }] }));
    await deliverInbound({ id: asked, text: 'Is the blue one in stock?' });
    await deliverInbound({ text: 'The large size.', contextId: asked });
    await deliverInbound({
      type: 'reaction',
      extra: { reaction: { message_id: asked, emoji: '👍' } },
    });
    await deliverInbound({ text: 'About something else.', contextId: 'wamid.not.stored' });
    // Another customer's quote of the first customer's message names nothing.
    await fx.deliver(
      fx.messagesBody(c, { messages: [{ waId: waId(), text: 'Me too.', contextId: asked }] }),
    );
    await deliverDue(c);
    const [askedRow] = await fx.query<{ id: string }>(
      'SELECT id FROM app.messages WHERE tenant_id = $1 AND external_message_id = $2',
      [c.tenant.id, asked],
    );
    const bodies = bodiesAt(endpoint.path).map((b) => messageReceivedPayloadSchema.parse(b));
    expect(
      bodies
        .map((b) => [b.data.message.text, b.data.message.replyTo])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ).toEqual([
      ['👍', askedRow!.id],
      ['About something else.', null],
      ['Is the blue one in stock?', null],
      ['Me too.', null],
      ['The large size.', askedRow!.id],
    ]);
  });
});

describe('automation run events (ADR-078)', () => {
  const automationService = () =>
    createAutomationService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
    });

  const keyword = (word: string): AutomationTrigger => ({
    type: 'keyword',
    keywords: [word],
    match: 'contains',
    hours: 'any',
    cooldownMinutes: 0,
  });
  const sayGraph = (text: string) => ({
    version: 1,
    start: 'say',
    nodes: [{ id: 'say', type: 'send_text', text, next: null }],
  });

  /** A published automation of the company. */
  async function publishAutomation(
    owner: TenantContext,
    name: string,
    trigger: AutomationTrigger,
    graph: unknown,
    channelAccountId: string | null = null,
  ) {
    const svc = automationService();
    const { id } = await svc.createAutomation(owner, { name });
    const saved = await svc.updateAutomation(owner, {
      id,
      expectedVersion: 0,
      name,
      description: null,
      channelAccountId,
      trigger,
      graph,
    });
    expect(saved.issues).toEqual([]);
    await svc.publishAutomation(owner, { id, expectedVersion: saved.version, note: null });
    return id;
  }

  const runsIn = (conversationId: string) =>
    fx.query<{
      id: string;
      status: string;
      end_reason: string | null;
      started_at: Date;
      ended_at: Date | null;
    }>(
      `SELECT id, status, end_reason, started_at, ended_at FROM app.automation_runs
        WHERE conversation_id = $1 ORDER BY started_at, id`,
      [conversationId],
    );

  /** Hands every queued send of the company to the Graph stand-in; how many there were. */
  async function sendQueued(c: Company) {
    const intents = await fx.query<{ id: string; actor_user_id: string | null }>(
      `SELECT id, actor_user_id FROM app.send_intents WHERE tenant_id = $1 AND state = 'queued'
        ORDER BY created_at`,
      [c.tenant.id],
    );
    for (const intent of intents) {
      await processSendIntent(
        {
          db: fx.dbs.app,
          keyring: fx.keyring,
          graph: fx.graph,
          clock: systemClock,
          rate: { capacity: 1000, refillPerSecond: 1000 },
          jobs: fx.jobs(),
          signer: fx.signer,
        },
        authorizedTenantScope(c.tenant.id, intent.actor_user_id),
        intent.id,
      );
    }
    return intents.length;
  }

  /** Advances a run the way the worker does, sending what it queues, until it waits or ends. */
  async function driveRun(c: Company, runId: string, clock: Clock = systemClock) {
    for (let i = 0; i < 20; i += 1) {
      const result = await advanceAutomationRun(
        { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock, keyring: fx.keyring },
        authorizedTenantScope(c.tenant.id, null),
        runId,
        null,
      );
      const sent = await sendQueued(c);
      if (sent === 0 && result.outcome !== 'sending' && result.outcome !== 'yielded') {
        return result.outcome;
      }
    }
    throw new Error('the run did not settle');
  }

  /** A utility template created, submitted and approved through the Graph stand-in, then synced. */
  async function approvedTemplate(c: Company, definition: TemplateDefinition) {
    const name = `run_events_${randomBytes(4).toString('hex')}`;
    const owner = await fx.ctx(c, c.owner);
    const templateDeps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock };
    const { id } = await createTemplatesService(templateDeps).createDraft(owner, {
      whatsappAccountId: c.whatsappAccountId,
      name,
      language: 'en',
      definition,
    });
    await createTemplatesService(templateDeps).submitTemplate(owner, id);
    const graphDeps = { ...templateDeps, keyring: fx.keyring, graph: fx.graph };
    const scope = authorizedTenantScope(c.tenant.id, null);
    expect(await processTemplateSubmit(graphDeps, scope, id)).toBe('done');
    const template = fx.standIn.state.templates.get(c.wabaId)?.find((t) => t.name === name);
    if (!template) throw new Error('template not at the stand-in');
    template.status = 'APPROVED';
    await syncTemplates(graphDeps, scope, c.whatsappAccountId);
    return id;
  }

  const personOf = async (contactId: string) =>
    (
      await fx.query<{ phone_e164: string | null; display_name: string | null }>(
        'SELECT phone_e164, display_name FROM app.contacts WHERE id = $1',
        [contactId],
      )
    )[0]!;

  it('sends the start and the end of a live run to the endpoints that take them, and nothing for a member’s test run', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const both = await addEndpoint(c, ['automation.run_started', 'automation.run_ended']);
    const endsOnly = await addEndpoint(c, ['automation.run_ended']);
    const messagesOnly = await addEndpoint(c, ['message.received']);
    const automationId = await publishAutomation(
      owner,
      'Brochure',
      keyword('brochure'),
      sayGraph('Here is our brochure.'),
    );
    const from = waId();
    const { conversation_id: conversationId, contact_id: contactId } = await inbound(
      c,
      from,
      'brochure please',
    );
    const [run] = await runsIn(conversationId);
    if (!run) throw new Error('no run started');
    // Captured when the run starts, in the transaction that stores the message.
    expect(
      (await eventsOf(c, 'automation.')).map((e) => [
        e.type,
        e.status,
        e.detail,
        e.conversation_id,
        e.contact_id,
        e.deliveries,
      ]),
    ).toEqual([
      [
        'automation.run_started',
        'running',
        { runId: run.id, automationId },
        conversationId,
        contactId,
        1,
      ],
    ]);
    expect(await driveRun(c, run.id)).toBe('ended');
    const [ended] = await runsIn(conversationId);
    expect(ended).toMatchObject({ status: 'completed', end_reason: 'no_next' });
    expect(
      (await eventsOf(c, 'automation.')).map((e) => [e.type, e.status, e.detail, e.deliveries]),
    ).toEqual([
      ['automation.run_started', 'running', { runId: run.id, automationId }, 1],
      [
        'automation.run_ended',
        'completed',
        { runId: run.id, automationId, endReason: 'no_next' },
        2,
      ],
    ]);

    await deliverDue(c);
    const bodies = bodiesAt(both.path);
    expect(bodies.map((b) => b.type).sort()).toEqual([
      'automation.run_ended',
      'automation.run_started',
    ]);
    const started = automationRunStartedPayloadSchema.parse(
      bodies.find((b) => b.type === 'automation.run_started'),
    );
    const finished = automationRunEndedPayloadSchema.parse(
      bodies.find((b) => b.type === 'automation.run_ended'),
    );
    const person = await personOf(contactId);
    expect(person.phone_e164).toBe(`+${from}`);
    expect(started.data).toEqual({
      run: {
        id: run.id,
        automationId,
        automationName: 'Brochure',
        trigger: 'keyword',
        apiKeyId: null,
        status: 'running',
        endReason: null,
        startedAt: run.started_at.toISOString(),
        endedAt: null,
      },
      conversation: { id: conversationId },
      contact: { id: contactId, phone: person.phone_e164, name: person.display_name },
      channel: { id: c.channelAccountId, phone: '+91 90000 00000' },
    });
    expect(finished.data).toEqual({
      ...started.data,
      run: {
        ...started.data.run,
        status: 'completed',
        endReason: 'no_next',
        endedAt: ended!.ended_at!.toISOString(),
      },
    });
    expect(bodiesAt(endsOnly.path).map((b) => b.type)).toEqual(['automation.run_ended']);
    expect(bodiesAt(messagesOnly.path).map((b) => b.type)).toEqual(['message.received']);

    // A member's test run of a draft, in the same conversation, sends nothing.
    const svc = automationService();
    const { id: draftId } = await svc.createAutomation(owner, { name: 'Draft' });
    const draft = await svc.updateAutomation(owner, {
      id: draftId,
      expectedVersion: 0,
      name: 'Draft',
      description: null,
      channelAccountId: null,
      trigger: keyword('draft'),
      graph: sayGraph('Testing.'),
    });
    const { runId: testRunId } = await svc.startTestRun(owner, {
      id: draftId,
      expectedVersion: draft.version,
      conversationId,
    });
    expect(await driveRun(c, testRunId)).toBe('ended');
    expect((await runsIn(conversationId)).find((r) => r.id === testRunId)).toMatchObject({
      status: 'completed',
    });
    expect((await eventsOf(c, 'automation.')).map((e) => e.type)).toEqual([
      'automation.run_started',
      'automation.run_ended',
    ]);
  });

  it('sends an endpoint that names automations only their runs, others every run, and captures no run event nobody takes (ADR-145)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const greeter = await publishAutomation(
      owner,
      'Greeter',
      keyword('hello'),
      sayGraph('Hello there.'),
    );
    const farewell = await publishAutomation(
      owner,
      'Farewell',
      keyword('bye'),
      sayGraph('Goodbye for now.'),
    );
    // Greeter's runs and every message; the end of every run; Farewell's starts only.
    const greeterOnly = await addEndpoint(
      c,
      ['message.received', 'automation.run_started', 'automation.run_ended'],
      null,
      [greeter],
    );
    const everyEnd = await addEndpoint(c, ['automation.run_ended']);
    const farewellStarts = await addEndpoint(c, ['automation.run_started'], null, [farewell]);
    const runOf = async (text: string) => {
      const { conversation_id: conversationId } = await inbound(c, waId(), text);
      const [run] = await runsIn(conversationId);
      if (!run) throw new Error(`no run started by “${text}”`);
      expect(await driveRun(c, run.id)).toBe('ended');
      return run.id;
    };
    const hello = await runOf('hello');
    const bye = await runOf('bye');
    expect(
      (await eventsOf(c, 'automation.')).map((e) => [e.type, e.detail.runId, e.deliveries]),
    ).toEqual([
      ['automation.run_started', hello, 1],
      ['automation.run_ended', hello, 2],
      ['automation.run_started', bye, 1],
      ['automation.run_ended', bye, 1],
    ]);

    await deliverDue(c);
    const runsAt = (path: string) =>
      bodiesAt(path)
        .filter((b) => b.type.startsWith('automation.'))
        .map((b) => {
          const { run } = (
            b.type === 'automation.run_started'
              ? automationRunStartedPayloadSchema
              : automationRunEndedPayloadSchema
          ).parse(b).data;
          return [b.type, run.id, run.automationName];
        })
        .sort();
    expect(runsAt(greeterOnly.path)).toEqual(
      [
        ['automation.run_ended', hello, 'Greeter'],
        ['automation.run_started', hello, 'Greeter'],
      ].sort(),
    );
    expect(runsAt(everyEnd.path)).toEqual(
      [
        ['automation.run_ended', hello, 'Greeter'],
        ['automation.run_ended', bye, 'Farewell'],
      ].sort(),
    );
    expect(runsAt(farewellStarts.path)).toEqual([['automation.run_started', bye, 'Farewell']]);

    // With those two endpoints turned off, no endpoint takes Farewell's runs: nothing of the next
    // one is captured. The endpoint's other events are not filtered: it hears every customer.
    await webhooks().setEnabled(owner, { endpointId: everyEnd.id, enabled: false });
    await webhooks().setEnabled(owner, { endpointId: farewellStarts.id, enabled: false });
    expect(await runOf('bye again')).not.toBe(bye);
    expect((await eventsOf(c, 'automation.')).map((e) => e.detail.runId)).toEqual([
      hello,
      hello,
      bye,
      bye,
    ]);
    await deliverDue(c);
    expect(bodiesAt(greeterOnly.path).filter((b) => b.type === 'message.received')).toHaveLength(3);
    expect(runsAt(greeterOnly.path)).toHaveLength(2);
  });

  it('sends an endpoint that names numbers only the runs on them (ADR-170)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const outlet = await fx.addNumber(c, { phone: '+91 90000 54321' });
    // An automation for every number.
    await publishAutomation(owner, 'Greeter', keyword('hello'), sayGraph('Hello there.'));
    const runs: WebhookEventType[] = ['automation.run_started', 'automation.run_ended'];
    const onMain = await addNumberEndpoint(c, runs, [c.channelAccountId]);
    const onOutlet = await addNumberEndpoint(c, runs, [outlet.channelAccountId]);
    const runOn = async (at: Company) => {
      const { conversation_id: conversationId } = await inbound(at, waId(), 'hello');
      const [run] = await runsIn(conversationId);
      if (!run) throw new Error('no run started');
      expect(await driveRun(c, run.id)).toBe('ended');
      return run.id;
    };
    const main = await runOn(c);
    const shop = await runOn(outlet);
    expect(
      (await eventsOf(c, 'automation.')).map((e) => [e.type, e.detail.runId, e.deliveries]),
    ).toEqual([
      ['automation.run_started', main, 1],
      ['automation.run_ended', main, 1],
      ['automation.run_started', shop, 1],
      ['automation.run_ended', shop, 1],
    ]);

    await deliverDue(c);
    expect(numbersAt(onMain.path, 'run')).toEqual([
      ['automation.run_ended', main, c.channelAccountId],
      ['automation.run_started', main, c.channelAccountId],
    ]);
    expect(numbersAt(onOutlet.path, 'run')).toEqual([
      ['automation.run_ended', shop, outlet.channelAccountId],
      ['automation.run_started', shop, outlet.channelAccountId],
    ]);
  });

  it('sends an endpoint that names how runs ended only those ends, others every end, and captures no end nobody takes (ADR-151)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const brochure = await publishAutomation(
      owner,
      'Brochure',
      keyword('brochure'),
      sayGraph('Here it is.'),
    );
    await publishAutomation(owner, 'Greeter', keyword('hello'), sayGraph('Hello there.'));
    // Every start and the failures; every end; Brochure's completions only.
    const failures = await addEndpoint(
      c,
      ['automation.run_started', 'automation.run_ended'],
      null,
      null,
      null,
      null,
      null,
      ['failed'],
    );
    const everyEnd = await addEndpoint(c, ['automation.run_ended']);
    const brochureCompleted = await addEndpoint(
      c,
      ['automation.run_ended'],
      null,
      [brochure],
      null,
      null,
      null,
      ['completed'],
    );
    const runOf = async (text: string, clock: Clock = systemClock) => {
      const { conversation_id: conversationId } = await inbound(c, waId(), text);
      const [run] = await runsIn(conversationId);
      if (!run) throw new Error(`no run started by “${text}”`);
      expect(await driveRun(c, run.id, clock)).toBe('ended');
      return run.id;
    };
    const completed = await runOf('brochure');
    // A day later the customer's window has closed: the text cannot be sent and the run fails.
    const failed = await runOf('brochure', { now: () => new Date(Date.now() + 25 * 3600_000) });
    const greeted = await runOf('hello');
    expect(
      (await eventsOf(c, 'automation.')).map((e) => [e.type, e.detail.runId, e.deliveries]),
    ).toEqual([
      ['automation.run_started', completed, 1],
      ['automation.run_ended', completed, 2],
      ['automation.run_started', failed, 1],
      ['automation.run_ended', failed, 2],
      ['automation.run_started', greeted, 1],
      ['automation.run_ended', greeted, 1],
    ]);

    await deliverDue(c);
    const runsAt = (path: string) =>
      bodiesAt(path)
        .filter((b) => b.type.startsWith('automation.'))
        .map((b) => {
          const { run } = (
            b.type === 'automation.run_started'
              ? automationRunStartedPayloadSchema
              : automationRunEndedPayloadSchema
          ).parse(b).data;
          return [b.type, run.id, run.status];
        })
        .sort();
    expect(runsAt(failures.path)).toEqual(
      [
        ['automation.run_started', completed, 'running'],
        ['automation.run_started', failed, 'running'],
        ['automation.run_started', greeted, 'running'],
        ['automation.run_ended', failed, 'failed'],
      ].sort(),
    );
    expect(runsAt(everyEnd.path)).toEqual(
      [
        ['automation.run_ended', completed, 'completed'],
        ['automation.run_ended', failed, 'failed'],
        ['automation.run_ended', greeted, 'completed'],
      ].sort(),
    );
    // Both of its filters apply: Greeter's completion is not Brochure's.
    expect(runsAt(brochureCompleted.path)).toEqual([
      ['automation.run_ended', completed, 'completed'],
    ]);

    // With the other two endpoints turned off, no endpoint takes a completion: the next run's start
    // is captured, its end is not.
    await webhooks().setEnabled(owner, { endpointId: everyEnd.id, enabled: false });
    await webhooks().setEnabled(owner, { endpointId: brochureCompleted.id, enabled: false });
    const later = await runOf('brochure');
    expect(
      (await eventsOf(c, 'automation.'))
        .filter((e) => e.detail.runId === later)
        .map((e) => [e.type, e.deliveries]),
    ).toEqual([['automation.run_started', 1]]);
  });

  it('names the key that started a run through the API', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const hook = await addEndpoint(c, ['automation.run_started', 'automation.run_ended']);
    const templateId = await approvedTemplate(c, {
      category: 'UTILITY',
      header: { type: 'none' },
      body: { text: 'Hi {{1}}, your order {{2}} has shipped.', examples: ['Asha', 'A-1001'] },
      footer: null,
      buttons: [],
    });
    const automationId = await publishAutomation(
      owner,
      'Shipping update',
      { type: 'api', inputs: ['first_name', 'order'] },
      {
        version: 1,
        start: 'shipped',
        nodes: [
          {
            id: 'shipped',
            type: 'send_template',
            templateId,
            header: [],
            body: ['{{input.first_name}}', '{{input.order}}'],
            next: null,
          },
        ],
      },
      c.channelAccountId,
    );
    const key = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(owner, {
      name: 'Store',
      scopes: ['automations.start'],
      expiresInDays: 0,
    });
    const ctx = await authenticateApiToken(fx.dbs.app, key.token, uuidv7());
    if (!ctx) throw new Error('a new key does not authenticate');
    const answer = await apiStartAutomationRun(
      { db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer },
      ctx,
      automationId,
      { to: '+91 98111 00071', inputs: { first_name: 'Asha', order: 'A-1001' } },
      { key: 'ship-1', requestHash: sha256Hex('ship-1') },
    );
    const runId = (answer.body.data as { id: string }).id;
    expect(await driveRun(c, runId)).toBe('ended');

    await deliverDue(c);
    const bodies = bodiesAt(hook.path);
    expect(bodies).toHaveLength(2);
    const started = automationRunStartedPayloadSchema.parse(
      bodies.find((b) => b.type === 'automation.run_started'),
    );
    const finished = automationRunEndedPayloadSchema.parse(
      bodies.find((b) => b.type === 'automation.run_ended'),
    );
    for (const body of [started, finished]) {
      expect(body.data.run).toMatchObject({
        id: runId,
        automationId,
        automationName: 'Shipping update',
        trigger: 'api',
        apiKeyId: key.id,
      });
      expect(body.data.contact.phone).toBe('+919811100071');
      expect(body.data.channel.id).toBe(c.channelAccountId);
    }
    expect(finished.data.run).toMatchObject({ status: 'completed', endReason: 'no_next' });
  });

  it('reports a run that fails, with its reason', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const hook = await addEndpoint(c, ['automation.run_ended']);
    await publishAutomation(owner, 'Brochure', keyword('brochure'), sayGraph('Here it is.'));
    const { conversation_id: conversationId } = await inbound(c, waId(), 'brochure');
    const [run] = await runsIn(conversationId);
    if (!run) throw new Error('no run started');
    // A day later the customer's window has closed: the text cannot be sent and the run fails.
    const dayLater: Clock = { now: () => new Date(Date.now() + 25 * 3600_000) };
    expect(await driveRun(c, run.id, dayLater)).toBe('ended');
    expect((await runsIn(conversationId))[0]).toMatchObject({
      status: 'failed',
      end_reason: 'send_blocked',
    });

    await deliverDue(c);
    const [body, ...more] = bodiesAt(hook.path);
    expect(more).toEqual([]);
    expect(automationRunEndedPayloadSchema.parse(body).data.run).toMatchObject({
      id: run.id,
      trigger: 'keyword',
      status: 'failed',
      endReason: 'send_blocked',
    });
  });

  it('sends the end of a run stopped by erasure, without personal data', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const hook = await addEndpoint(c, ['automation.run_started', 'automation.run_ended']);
    await publishAutomation(owner, 'Order number', keyword('order'), {
      version: 1,
      start: 'ask',
      nodes: [
        {
          id: 'ask',
          type: 'ask_text',
          text: 'What is your order number?',
          saveAs: 'order_no',
          format: 'number',
          retryText: null,
          retries: 0,
          invalidNext: null,
          timeoutMinutes: 30,
          timeoutNext: null,
          next: null,
        },
      ],
    });
    const from = waId();
    const { conversation_id: conversationId, contact_id: contactId } = await inbound(
      c,
      from,
      'where is my order',
    );
    const [run] = await runsIn(conversationId);
    if (!run) throw new Error('no run started');
    await driveRun(c, run.id);
    expect((await runsIn(conversationId))[0]).toMatchObject({ status: 'waiting' });

    // Erasure stops the run inside its definer function; the event is captured all the same.
    await contactsService().eraseContact(owner, { contactId, suppress: false });
    expect((await runsIn(conversationId))[0]).toMatchObject({
      status: 'stopped',
      end_reason: 'contact_erased',
    });
    expect((await eventsOf(c, 'automation.')).map((e) => [e.type, e.status, e.deliveries])).toEqual(
      [
        ['automation.run_started', 'running', 1],
        ['automation.run_ended', 'stopped', 1],
      ],
    );

    await deliverDue(c);
    const bodies = bodiesAt(hook.path);
    expect(bodies).toHaveLength(2);
    const finished = automationRunEndedPayloadSchema.parse(
      bodies.find((b) => b.type === 'automation.run_ended'),
    );
    expect(finished.data.run).toMatchObject({
      id: run.id,
      status: 'stopped',
      endReason: 'contact_erased',
    });
    // Both bodies are built when delivered, after the erasure.
    for (const body of bodies) {
      expect(body.data.contact).toEqual({ id: contactId, phone: null, name: null });
      expect(JSON.stringify(body)).not.toContain(from.slice(2));
    }
  });

  it('captures nothing for a company without an endpoint that takes run events, and fails a delivery whose run is gone', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await addEndpoint(c, ['message.received', 'conversation.status_changed', 'contact.updated']);
    await publishAutomation(owner, 'Hello', keyword('hello'), sayGraph('Hi there.'));
    const { conversation_id: conversationId } = await inbound(c, waId(), 'hello');
    const [run] = await runsIn(conversationId);
    if (!run) throw new Error('no run started');
    expect(await driveRun(c, run.id)).toBe('ended');
    expect(await eventsOf(c, 'automation.')).toEqual([]);

    // An event whose run no longer exists (retention) fails without an attempt.
    const hook = await addEndpoint(c, ['automation.run_ended']);
    const eventId = uuidv7();
    await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, null), async (tx) => {
      await tx.insert(webhookEvents).values({
        id: eventId,
        tenantId: c.tenant.id,
        type: 'automation.run_ended',
        conversationId,
        status: 'completed',
        detail: { runId: uuidv7(), automationId: uuidv7(), endReason: 'no_next' },
      });
      await tx.insert(webhookDeliveries).values({
        id: uuidv7(),
        tenantId: c.tenant.id,
        endpointId: hook.id,
        eventId,
      });
    });
    await deliverDue(c);
    expect(
      await fx.query(
        'SELECT state, attempts, last_error FROM app.webhook_deliveries WHERE endpoint_id = $1',
        [hook.id],
      ),
    ).toEqual([{ state: 'failed', attempts: 0, last_error: 'event_gone' }]);
    expect(bodiesAt(hook.path)).toEqual([]);
  });
});

describe('order events (ADR-085)', () => {
  let rzp: RazorpayStandIn;
  let merchants = 0;
  beforeAll(async () => {
    rzp = await startRazorpayStandIn({ keyId: 'rzp_test_platform0085', keySecret: 'platform' });
  });
  afterAll(async () => {
    await rzp?.close();
  });

  const commerce = () =>
    createCommerceService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
      keyring: fx.keyring,
      appBaseUrl: 'https://app.w360.test',
      allowLiveKeys: false,
    });
  const commerceWorker = (): CatalogSyncDeps => ({
    db: fx.dbs.app,
    keyring: fx.keyring,
    graph: fx.graph,
    clock: systemClock,
    razorpayBaseUrl: rzp.baseUrl,
    jobs: fx.jobs(),
    signer: fx.signer,
  });
  const scopeOf = (c: Company) => authorizedTenantScope(c.tenant.id, null);

  /** A catalog read from Meta with products sku-1 and sku-2 (Product 001, Product 002). */
  async function syncedCatalog(c: Company, catalogId: string) {
    fx.standIn.state.catalogs.set(c.wabaId, [
      { id: catalogId, name: 'Main catalog', product_count: 2 },
    ]);
    fx.standIn.state.catalogProducts.set(
      catalogId,
      [1, 2].map((n) => ({
        id: String(850_000 + n),
        retailer_id: `sku-${n}`,
        name: `Product 00${n}`,
        price: `₹${n * 10}.00`,
        currency: 'INR',
        availability: 'in stock',
        review_status: 'approved',
      })),
    );
    await commerce().requestSync(await fx.ctx(c, c.owner), {
      whatsappAccountId: c.whatsappAccountId,
    });
    expect(await processCommerceSync(commerceWorker(), scopeOf(c), c.whatsappAccountId)).toBe(
      'done',
    );
  }

  /** A cart the customer sends from the catalog through the Meta webhook pipeline; its order. */
  async function sendCart(
    c: Company,
    from: string,
    catalogId: string,
    items: { retailerId: string; quantity: number; price: number }[],
    text = '',
  ) {
    await fx.deliver(
      fx.messagesBody(c, {
        messages: [
          {
            waId: from,
            type: 'order',
            extra: {
              order: {
                catalog_id: catalogId,
                text,
                product_items: items.map((i) => ({
                  product_retailer_id: i.retailerId,
                  quantity: i.quantity,
                  item_price: i.price,
                  currency: 'INR',
                })),
              },
            },
          },
        ],
      }),
    );
    const [order] = await fx.query<{
      id: string;
      reference: string;
      message_id: string;
      conversation_id: string;
      contact_id: string;
      version: number;
    }>(
      `SELECT o.id, o.reference, o.message_id, o.conversation_id, o.contact_id, o.version
         FROM app.commerce_orders o
         JOIN app.contact_identities i ON i.tenant_id = o.tenant_id AND i.contact_id = o.contact_id
        WHERE o.tenant_id = $1 AND i.wa_id = $2 ORDER BY o.created_at DESC LIMIT 1`,
      [c.tenant.id, from],
    );
    if (!order) throw new Error('order not recorded');
    return order;
  }

  const orderVersion = async (orderId: string) =>
    (
      await fx.query<{ version: number }>('SELECT version FROM app.commerce_orders WHERE id = $1', [
        orderId,
      ])
    )[0]!.version;

  async function setOrderStatus(
    ctx: TenantContext,
    orderId: string,
    status: 'confirmed' | 'fulfilled' | 'cancelled',
  ) {
    await commerce().setOrderStatus(ctx, {
      id: orderId,
      expectedVersion: await orderVersion(orderId),
      status,
    });
  }

  it('sends each order with its cart and every status change with the status before it, from members and from Razorpay', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await syncedCatalog(c, '5558501');
    const orders = await addEndpoint(c, ['order.received', 'order.status_changed']);
    const changes = await addEndpoint(c, ['order.status_changed']);
    const messagesOnly = await addEndpoint(c, ['message.received']);

    // The customer sends a cart: an item HyFib has not read from Meta, then one from the catalog.
    const from = waId();
    const order = await sendCart(
      c,
      from,
      '5558501',
      [
        { retailerId: 'sku-9', quantity: 1, price: 250 },
        { retailerId: 'sku-1', quantity: 2, price: 19.99 },
      ],
      'Please gift wrap',
    );

    // A member confirms it and asks for payment; Razorpay reports the link paid; it is fulfilled.
    await setOrderStatus(agent, order.id, 'confirmed');
    const keyId = `rzp_test_orderevents${String((merchants += 1)).padStart(2, '0')}`;
    rzp.addMerchant(keyId, 'order-events-secret');
    await commerce().savePaymentAccount(owner, {
      keyId,
      keySecret: 'order-events-secret',
      webhookSecret: 'order-events-hook',
    });
    const [account] = await fx.query<{ id: string }>(
      'SELECT id FROM app.commerce_payment_accounts WHERE tenant_id = $1',
      [c.tenant.id],
    );
    expect(await processPaymentAccountCheck(commerceWorker(), scopeOf(c), account!.id)).toBe(
      'done',
    );
    const { linkId } = await commerce().requestPayment(agent, {
      id: order.id,
      expectedVersion: await orderVersion(order.id),
    });
    expect(await processPaymentLink(commerceWorker(), scopeOf(c), linkId)).toBe('done');
    const [link] = await fx.query<{ provider_link_id: string }>(
      'SELECT provider_link_id FROM app.commerce_payment_links WHERE id = $1',
      [linkId],
    );
    rzp.payLink(link!.provider_link_id);
    expect(await processPaymentLink(commerceWorker(), scopeOf(c), linkId)).toBe('done');
    await setOrderStatus(agent, order.id, 'fulfilled');

    // One event per change, each to the endpoints that take its type.
    const events = await eventsOf(c, 'order.');
    expect(events.map((e) => [e.type, e.status, e.detail, e.deliveries])).toEqual([
      ['order.received', 'received', { orderId: order.id }, 1],
      ['order.status_changed', 'confirmed', { orderId: order.id, previousStatus: 'received' }, 2],
      [
        'order.status_changed',
        'awaiting_payment',
        { orderId: order.id, previousStatus: 'confirmed' },
        2,
      ],
      [
        'order.status_changed',
        'paid',
        { orderId: order.id, previousStatus: 'awaiting_payment' },
        2,
      ],
      ['order.status_changed', 'fulfilled', { orderId: order.id, previousStatus: 'paid' }, 2],
    ]);
    expect(events.every((e) => e.conversation_id === order.conversation_id)).toBe(true);
    expect(events.every((e) => e.contact_id === order.contact_id)).toBe(true);

    await deliverDue(c);
    const bodies = bodiesAt(orders.path);
    expect(bodies.map((b) => b.id)).toEqual(events.map((e) => e.id));
    expect(orderReceivedPayloadSchema.safeParse(bodies[0]).success).toBe(true);
    for (const body of bodies.slice(1)) {
      expect(orderStatusChangedPayloadSchema.safeParse(body).success).toBe(true);
    }
    // The cart in the customer's order, with the names HyFib knew; the rest as the order is now.
    const [paid] = await fx.query<{ paid_at: Date; received_at: Date }>(
      'SELECT paid_at, received_at FROM app.commerce_orders WHERE id = $1',
      [order.id],
    );
    expect(bodies[0]).toMatchObject({
      type: 'order.received',
      data: {
        order: {
          id: order.id,
          reference: order.reference,
          status: 'received',
          previousStatus: null,
          messageId: order.message_id,
          catalogId: '5558501',
          currency: 'INR',
          subtotalMinor: 28_998,
          itemCount: 2,
          droppedItems: 0,
          customerNote: 'Please gift wrap',
          receivedAt: paid!.received_at.toISOString(),
          paidAt: paid!.paid_at.toISOString(),
        },
        conversation: { id: order.conversation_id },
        contact: { id: order.contact_id, phone: `+${from}`, name: 'Priya Customer' },
        channel: { id: c.channelAccountId },
      },
    });
    expect((bodies[0]!.data.order as { items: unknown }).items).toEqual([
      { retailerId: 'sku-9', name: null, quantity: 1, unitPriceMinor: 25_000, currency: 'INR' },
      {
        retailerId: 'sku-1',
        name: 'Product 001',
        quantity: 2,
        unitPriceMinor: 1_999,
        currency: 'INR',
      },
    ]);
    expect(
      bodies.slice(1).map((b) => {
        const { status, previousStatus } = b.data.order as Record<string, unknown>;
        return [status, previousStatus];
      }),
    ).toEqual([
      ['confirmed', 'received'],
      ['awaiting_payment', 'confirmed'],
      ['paid', 'awaiting_payment'],
      ['fulfilled', 'paid'],
    ]);
    // An endpoint for status changes hears only those; one for messages hears the order message
    // and nothing of the order.
    expect(bodiesAt(changes.path).map((b) => b.id)).toEqual(events.slice(1).map((e) => e.id));
    const messageBodies = bodiesAt(messagesOnly.path);
    expect(messageBodies.map((b) => [b.type, (b.data.message as { id: string }).id])).toEqual([
      ['message.received', order.message_id],
    ]);
    expect(messageBodies[0]!.data.message).toMatchObject({ type: 'order' });
  });

  it('sends an endpoint that names statuses only those, another every status, and captures no change nobody takes (ADR-147)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await syncedCatalog(c, '5558511');
    const outcomes = await addEndpoint(
      c,
      ['order.received', 'order.status_changed'],
      null,
      null,
      null,
      ['cancelled', 'fulfilled'],
    );
    const every = await addEndpoint(c, ['order.status_changed']);
    expect((await webhooks().list(owner)).map((e) => [e.id, e.orderStatuses]).sort()).toEqual(
      [
        [outcomes.id, ['fulfilled', 'cancelled']],
        [every.id, null],
      ].sort(),
    );

    // An order a member confirms and fulfils.
    const first = await sendCart(c, waId(), '5558511', [
      { retailerId: 'sku-1', quantity: 1, price: 10 },
    ]);
    await setOrderStatus(agent, first.id, 'confirmed');
    await setOrderStatus(agent, first.id, 'fulfilled');
    const changesOf = async (orderId: string) =>
      (await eventsOf(c, 'order.'))
        .filter((e) => e.detail.orderId === orderId)
        .map((e) => [e.type, e.status, e.deliveries]);
    expect(await changesOf(first.id)).toEqual([
      ['order.received', 'received', 1],
      ['order.status_changed', 'confirmed', 1],
      ['order.status_changed', 'fulfilled', 2],
    ]);

    await deliverDue(c);

    // With the endpoint taking every status turned off, a second order's confirmation is captured
    // for nobody and its cancellation for the first endpoint.
    await webhooks().setEnabled(owner, { endpointId: every.id, enabled: false });
    const second = await sendCart(c, waId(), '5558511', [
      { retailerId: 'sku-2', quantity: 2, price: 20 },
    ]);
    await setOrderStatus(agent, second.id, 'confirmed');
    await setOrderStatus(agent, second.id, 'cancelled');
    expect(await changesOf(second.id)).toEqual([
      ['order.received', 'received', 1],
      ['order.status_changed', 'cancelled', 1],
    ]);

    await deliverDue(c);
    const ordersAt = (path: string) =>
      bodiesAt(path)
        .map((b) => {
          const { order } = b.data as { order: { id: string; status: string } };
          return [b.type, order.id, order.status];
        })
        .sort();
    // Its other order event is not filtered: order.received (status received) reached it.
    expect(ordersAt(outcomes.path)).toEqual(
      [
        ['order.received', first.id, 'received'],
        ['order.status_changed', first.id, 'fulfilled'],
        ['order.received', second.id, 'received'],
        ['order.status_changed', second.id, 'cancelled'],
      ].sort(),
    );
    expect(ordersAt(every.path)).toEqual(
      [
        ['order.status_changed', first.id, 'confirmed'],
        ['order.status_changed', first.id, 'fulfilled'],
      ].sort(),
    );
  });

  it('sends an endpoint that names numbers only the orders sent to them (ADR-170)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const outlet = await fx.addNumber(c, { phone: '+91 90000 54321' });
    await syncedCatalog(c, '5558570');
    const orders: WebhookEventType[] = ['order.received', 'order.status_changed'];
    const onMain = await addNumberEndpoint(c, orders, [c.channelAccountId]);
    const onOutlet = await addNumberEndpoint(c, orders, [outlet.channelAccountId]);
    // A cart sent to the first number, then confirmed, and one sent to the outlet.
    const main = await sendCart(c, waId(), '5558570', [
      { retailerId: 'sku-1', quantity: 1, price: 10 },
    ]);
    await setOrderStatus(owner, main.id, 'confirmed');
    const shop = await sendCart(outlet, waId(), '5558570', [
      { retailerId: 'sku-2', quantity: 2, price: 20 },
    ]);
    expect(
      (await eventsOf(c, 'order.')).map((e) => [e.type, e.detail.orderId, e.deliveries]),
    ).toEqual([
      ['order.received', main.id, 1],
      ['order.status_changed', main.id, 1],
      ['order.received', shop.id, 1],
    ]);

    await deliverDue(c);
    expect(numbersAt(onMain.path, 'order')).toEqual([
      ['order.received', main.id, c.channelAccountId],
      ['order.status_changed', main.id, c.channelAccountId],
    ]);
    expect(numbersAt(onOutlet.path, 'order')).toEqual([
      ['order.received', shop.id, outlet.channelAccountId],
    ]);
  });

  it('sends an erased contact’s orders without their number, name or note, captures nothing without an endpoint for orders, and fails a delivery whose order is gone', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    // No endpoint takes order events: an order and its change capture nothing.
    await addEndpoint(c, ['message.received', 'conversation.status_changed', 'contact.updated']);
    const quiet = await sendCart(c, waId(), '5558502', [
      { retailerId: 'sku-1', quantity: 1, price: 10 },
    ]);
    await setOrderStatus(owner, quiet.id, 'cancelled');
    expect(await eventsOf(c, 'order.')).toEqual([]);

    const hook = await addEndpoint(c, ['order.received', 'order.status_changed']);
    const from = waId();
    const order = await sendCart(
      c,
      from,
      '5558502',
      [{ retailerId: 'sku-1', quantity: 3, price: 10 }],
      'Ring 98450 12345 at the gate',
    );
    await setOrderStatus(owner, order.id, 'confirmed');
    // Erasure clears the note without changing the order's status: it captures nothing more.
    await contactsService().eraseContact(owner, { contactId: order.contact_id, suppress: false });
    expect((await eventsOf(c, 'order.')).map((e) => [e.type, e.status, e.deliveries])).toEqual([
      ['order.received', 'received', 1],
      ['order.status_changed', 'confirmed', 1],
    ]);

    // Both bodies are built when delivered, after the erasure; the order and its amounts stay.
    await deliverDue(c);
    const bodies = bodiesAt(hook.path);
    expect(bodies.map((b) => b.type)).toEqual(['order.received', 'order.status_changed']);
    for (const body of bodies) {
      expect(body.data.contact).toEqual({ id: order.contact_id, phone: null, name: null });
      expect(body.data.order).toMatchObject({
        id: order.id,
        customerNote: null,
        subtotalMinor: 3_000,
        items: [
          { retailerId: 'sku-1', name: null, quantity: 3, unitPriceMinor: 1_000, currency: 'INR' },
        ],
      });
      expect(JSON.stringify(body)).not.toContain(from.slice(2));
      expect(JSON.stringify(body)).not.toContain('98450');
    }

    // An event whose order no longer exists fails without an attempt.
    const gone = await addEndpoint(c, ['order.status_changed']);
    const eventId = uuidv7();
    await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, null), async (tx) => {
      await tx.insert(webhookEvents).values({
        id: eventId,
        tenantId: c.tenant.id,
        type: 'order.status_changed',
        conversationId: order.conversation_id,
        status: 'fulfilled',
        detail: { orderId: uuidv7(), previousStatus: 'confirmed' },
      });
      await tx.insert(webhookDeliveries).values({
        id: uuidv7(),
        tenantId: c.tenant.id,
        endpointId: gone.id,
        eventId,
      });
    });
    await deliverDue(c);
    expect(
      await fx.query(
        'SELECT state, attempts, last_error FROM app.webhook_deliveries WHERE endpoint_id = $1',
        [gone.id],
      ),
    ).toEqual([{ state: 'failed', attempts: 0, last_error: 'event_gone' }]);
    expect(bodiesAt(gone.path)).toEqual([]);

    // An endpoint can take every event type, orders included.
    const everything = await addEndpoint(c, [...WEBHOOK_EVENT_KEYS]);
    expect(
      await fx.query('SELECT event_types FROM app.webhook_endpoints WHERE id = $1', [
        everything.id,
      ]),
    ).toEqual([{ event_types: [...WEBHOOK_EVENT_KEYS] }]);
  });
});

describe('campaign events (ADR-087)', () => {
  class TestClock implements Clock {
    private offset = 0;
    now() {
      return new Date(Date.now() + this.offset);
    }
    advance(ms: number) {
      this.offset += ms;
    }
  }

  const promo: TemplateDefinition = {
    category: 'MARKETING',
    header: { type: 'none' },
    body: { text: 'Hello {{1}}, our festive sale starts today.', examples: ['Asha'] },
    footer: null,
    buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions' }],
  };

  /**
   * A company ready to send campaigns: an approved marketing template, contacts tagged vip who
   * opted in to marketing, the campaigns service on a clock the test moves, and the runner.
   */
  async function campaignCompany(contactCount: number) {
    const c = await fx.company();
    const clock = new TestClock();
    const deps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock };
    const owner = await fx.ctx(c, c.owner);
    const templateName = `festive_${randomBytes(4).toString('hex')}`;
    const templates = createTemplatesService({ ...deps, clock: systemClock });
    const { id: templateId } = await templates.createDraft(owner, {
      whatsappAccountId: c.whatsappAccountId,
      name: templateName,
      language: 'en',
      definition: promo,
    });
    await templates.submitTemplate(owner, templateId);
    const graphDeps = { ...deps, clock: systemClock, keyring: fx.keyring, graph: fx.graph };
    const scope = authorizedTenantScope(c.tenant.id, null);
    expect(await processTemplateSubmit(graphDeps, scope, templateId)).toBe('done');
    const template = fx.standIn.state.templates.get(c.wabaId)?.find((t) => t.name === templateName);
    if (!template) throw new Error('template not at the stand-in');
    template.status = 'APPROVED';
    await syncTemplates(graphDeps, scope, c.whatsappAccountId);

    const consent = createConsentService({ db: fx.dbs.app, clock: systemClock });
    for (let i = 0; i < contactCount; i += 1) {
      const { id } = await contactsService().createContact(owner, {
        phone: `+${waId()}`,
        displayName: `Shopper ${i}`,
        tags: ['vip'],
      });
      await consent.recordConsent(owner, {
        contactId: id,
        purpose: 'marketing',
        action: 'opt_in',
        note: 'Signed up at the store',
      });
    }
    const campaigns = createCampaignsService(deps);
    return {
      c,
      clock,
      campaigns,
      templateId,
      templateName,
      /** A draft sending the template to the vip contacts, now unless a time is given. */
      async draft(ctx: TenantContext, name: string, schedule: Record<string, unknown> = {}) {
        const { id } = await campaigns.createDraft(ctx, { name }, {});
        await campaigns.updateDraft(
          ctx,
          id,
          {
            expectedVersion: 0,
            name,
            channelAccountId: c.channelAccountId,
            templateId,
            variables: { header: [], body: [{ source: 'name', fallback: 'there' }] },
            audience: {
              kind: 'conditions',
              definition: { match: 'all', conditions: [{ type: 'tag', op: 'has', tag: 'vip' }] },
            },
            schedule: { kind: 'now', timezone: 'Asia/Kolkata', ...schedule },
            window: null,
            ratePerMinute: null,
            maxMessages: null,
            budget: null,
            stopAfterHours: 24,
          },
          {},
        );
        return id;
      },
      tick(campaignId: string) {
        return runCampaignTick(
          { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock, sendRatePerSecond: 100 },
          scope,
          campaignId,
        );
      },
      /** Hands the campaign's queued sends to the Graph stand-in; their outcomes. */
      async dispatch(campaignId: string) {
        const intents = await fx.query<{ id: string }>(
          `SELECT s.id FROM app.send_intents s JOIN app.messages m ON m.id = s.message_id
            WHERE m.campaign_id = $1 AND s.state = 'queued' ORDER BY s.id`,
          [campaignId],
        );
        const outcomes: string[] = [];
        for (const intent of intents) {
          const result = await processSendIntent(
            { ...graphDeps, rate: { capacity: 1000, refillPerSecond: 1000 } },
            scope,
            intent.id,
          );
          outcomes.push(result.outcome);
        }
        return outcomes;
      },
    };
  }

  /**
   * The campaign's captured events in the order they were captured, each as [status, previous
   * status, pause reason, completion reason, deliveries].
   */
  const changesOf = async (campaignId: string) =>
    (
      await fx.query<{
        status: string;
        previous: string;
        pause_reason: string | null;
        completion_reason: string | null;
        deliveries: number;
      }>(
        `SELECT e.status, e.detail->>'previousStatus' AS previous,
                e.detail->>'pauseReason' AS pause_reason,
                e.detail->>'completionReason' AS completion_reason,
                (SELECT count(*)::int FROM app.webhook_deliveries d
                  WHERE d.tenant_id = e.tenant_id AND d.event_id = e.id) AS deliveries
           FROM app.webhook_events e
          WHERE e.type = 'campaign.status_changed' AND e.detail->>'campaignId' = $1
          ORDER BY e.occurred_at, e.id`,
        [campaignId],
      )
    ).map((e) => [e.status, e.previous, e.pause_reason, e.completion_reason, e.deliveries]);

  it('sends each status change with the status before it and why it paused or completed, from members and from the runner', async () => {
    const s = await campaignCompany(2);
    const { c } = s;
    const owner = await fx.ctx(c, c.owner);
    const marketer = await fx.ctx(c, c.marketer);
    const hook = await addEndpoint(c, ['campaign.status_changed']);
    const other = await addEndpoint(c, ['message.status', 'order.status_changed']);
    await s.campaigns.updateSettings(
      owner,
      { approvalRequired: true, cap: null, costCurrency: null },
      {},
    );

    // Creating and editing a draft changes no status: nothing is captured.
    const id = await s.draft(marketer, 'Festive sale');
    expect(await eventsOf(c, 'campaign.')).toEqual([]);

    // Submitted, rejected, submitted again and approved by members.
    await s.campaigns.submitCampaign(marketer, id, { expectedVersion: 1 }, {});
    await s.campaigns.rejectCampaign(owner, id, { note: 'Add the store address' }, {});
    const view = await s.campaigns.getCampaign(owner, id);
    await s.campaigns.submitCampaign(marketer, id, { expectedVersion: view.campaign.version }, {});
    await s.campaigns.approveCampaign(owner, id, { note: 'Looks good' }, {});
    // The runner starts it; a member pauses it (its unsent messages go back) and another resumes.
    expect(await s.tick(id)).toMatchObject({ outcome: 'progress', queued: 2 });
    expect(await s.campaigns.pauseCampaign(marketer, id, {})).toEqual({ released: 2 });
    await s.campaigns.resumeCampaign(owner, id, {});
    expect(await s.tick(id)).toMatchObject({ queued: 2 });
    expect(await s.dispatch(id)).toEqual(['accepted', 'accepted']);
    // With every recipient processed, the runner completes it.
    s.clock.advance(11_000);
    expect(await s.tick(id)).toMatchObject({ outcome: 'completed' });

    // Each change captured once, only for the endpoint that takes campaign events.
    expect(await changesOf(id)).toEqual([
      ['pending_approval', 'draft', null, null, 1],
      ['draft', 'pending_approval', null, null, 1],
      ['pending_approval', 'draft', null, null, 1],
      ['scheduled', 'pending_approval', null, null, 1],
      ['running', 'scheduled', null, null, 1],
      ['paused', 'running', 'manual', null, 1],
      ['running', 'paused', null, null, 1],
      ['completed', 'running', null, 'all_processed', 1],
    ]);

    // Delivered signed as the campaign is now, with each change and its reason as captured.
    await deliverDue(c);
    const bodies = bodiesAt(hook.path);
    expect(bodies.map((b) => b.type)).toEqual(Array(8).fill('campaign.status_changed'));
    for (const body of bodies) {
      expect(campaignStatusChangedPayloadSchema.safeParse(body).success).toBe(true);
    }
    const [row] = await fx.query<{
      scheduled_at: Date;
      started_at: Date;
      completed_at: Date;
    }>('SELECT scheduled_at, started_at, completed_at FROM app.campaigns WHERE id = $1', [id]);
    const now = {
      id,
      name: 'Festive sale',
      templateId: s.templateId,
      templateName: s.templateName,
      scheduledAt: row!.scheduled_at.toISOString(),
      startedAt: row!.started_at.toISOString(),
      completedAt: row!.completed_at.toISOString(),
      canceledAt: null,
      audienceCount: 2,
      queuedCount: 2,
      skippedCount: 0,
      // Counted when delivered (ADR-150): both messages accepted by WhatsApp, not yet sent.
      results: {
        audience: 2,
        pending: 0,
        skipped: 0,
        canceled: 0,
        queued: 2,
        inProgress: 2,
        sent: 0,
        delivered: 0,
        read: 0,
        failed: 0,
        unknown: 0,
        messagesCanceled: 0,
        replied: 0,
        optedOut: 0,
        skipReasons: [],
        failureCodes: [],
      },
    };
    const channel = { id: c.channelAccountId, phone: '+91 90000 00000' };
    expect(bodies[5]!.data).toEqual({
      campaign: {
        ...now,
        status: 'paused',
        previousStatus: 'running',
        pauseReason: 'manual',
        completionReason: null,
      },
      channel,
    });
    expect(bodies[7]!.data).toEqual({
      campaign: {
        ...now,
        status: 'completed',
        previousStatus: 'running',
        pauseReason: null,
        completionReason: 'all_processed',
      },
      channel,
    });
    // The other endpoint heard of the campaign's messages, not of the campaign.
    expect(bodiesAt(other.path).some((b) => b.type === 'campaign.status_changed')).toBe(false);
  });

  it('carries the campaign’s results as GET /campaigns/{id} counts them when each event is delivered, and none while it is a draft (ADR-150)', async () => {
    const s = await campaignCompany(3);
    const { c } = s;
    const owner = await fx.ctx(c, c.owner);
    const marketer = await fx.ctx(c, c.marketer);
    const hook = await addEndpoint(c, ['campaign.status_changed']);
    await s.campaigns.updateSettings(
      owner,
      { approvalRequired: true, cap: null, costCurrency: null },
      {},
    );
    /** Each delivered body's status and results, from the `from`th on, sorted by status. */
    const delivered = (from = 0) =>
      bodiesAt(hook.path)
        .slice(from)
        .map((b) => {
          const campaign = b.data.campaign as { status: string; results: unknown };
          return [campaign.status, campaign.results] as const;
        })
        .sort((a, b) => a[0].localeCompare(b[0]));
    const counts = {
      audience: 3,
      pending: 0,
      skipped: 0,
      canceled: 0,
      queued: 3,
      inProgress: 0,
      sent: 0,
      delivered: 0,
      read: 0,
      failed: 0,
      unknown: 0,
      messagesCanceled: 0,
      replied: 0,
      optedOut: 0,
      skipReasons: [],
      failureCodes: [],
    };

    // Submitted and rejected, both delivered while it is a draft again: a draft has no results.
    const id = await s.draft(marketer, 'Festive sale');
    await s.campaigns.submitCampaign(marketer, id, { expectedVersion: 1 }, {});
    await s.campaigns.rejectCampaign(owner, id, { note: 'Add the store address' }, {});
    await deliverDue(c);
    expect(delivered()).toEqual([
      ['draft', null],
      ['pending_approval', null],
    ]);

    // Submitted again, approved and started: delivered while its messages are on their way, each
    // change, whatever its status, carries the results counted then.
    const view = await s.campaigns.getCampaign(owner, id);
    await s.campaigns.submitCampaign(marketer, id, { expectedVersion: view.campaign.version }, {});
    await s.campaigns.approveCampaign(owner, id, { note: 'Looks good' }, {});
    expect(await s.tick(id)).toMatchObject({ outcome: 'progress', queued: 3 });
    expect(await s.dispatch(id)).toEqual(['accepted', 'accepted', 'accepted']);
    await deliverDue(c);
    const onTheirWay = { ...counts, inProgress: 3 };
    expect(delivered(2)).toEqual([
      ['pending_approval', onTheirWay],
      ['running', onTheirWay],
      ['scheduled', onTheirWay],
    ]);

    // Meta delivers one message, the second is read and the third fails; the runner completes it.
    const sent = await fx.query<{ external_message_id: string; phone: string }>(
      `SELECT m.external_message_id, ct.phone_e164 AS phone FROM app.messages m
         JOIN app.conversations cv ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
         JOIN app.contacts ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contact_id
        WHERE m.campaign_id = $1 ORDER BY ct.display_name`,
      [id],
    );
    const now = String(Math.floor(Date.now() / 1000));
    const status = (i: number, value: string, extra: Record<string, unknown> = {}) => ({
      id: sent[i]!.external_message_id,
      status: value,
      timestamp: now,
      recipient_id: sent[i]!.phone.slice(1),
      ...extra,
    });
    await fx.deliver(
      fx.messagesBody(c, {
        statuses: [
          status(0, 'delivered'),
          status(1, 'read'),
          status(2, 'failed', {
            errors: [{ code: 131049, title: 'Not delivered to maintain healthy engagement.' }],
          }),
        ],
      }),
    );
    s.clock.advance(11_000);
    expect(await s.tick(id)).toMatchObject({ outcome: 'completed' });
    await deliverDue(c);
    const finished = {
      ...counts,
      sent: 2,
      delivered: 2,
      read: 1,
      failed: 1,
      failureCodes: [{ code: '131049', count: 1 }],
    };
    expect(delivered(5)).toEqual([['completed', finished]]);
    // As GET /campaigns/{id} counts them.
    const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'Campaign results', scopes: ['campaigns.read'], expiresInDays: 0 },
    );
    const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    if (!key) throw new Error('a new key does not authenticate');
    expect((await apiGetCampaign({ db: fx.dbs.app }, key, id)).results).toEqual(finished);

    // A replay counts again: the start, delivered while its messages were on their way, now says
    // how they went.
    const [start] = await fx.query<{ id: string }>(
      `SELECT d.id FROM app.webhook_deliveries d
         JOIN app.webhook_events e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
        WHERE e.type = 'campaign.status_changed' AND e.status = 'running'
          AND e.detail->>'campaignId' = $1`,
      [id],
    );
    await webhooks().replay(owner, { deliveryId: start!.id });
    await deliverDue(c);
    expect(delivered(6)).toEqual([['running', finished]]);
    for (const body of bodiesAt(hook.path)) {
      expect(campaignStatusChangedPayloadSchema.safeParse(body).success).toBe(true);
    }
  });

  it('sends an endpoint that names statuses only those, another every status, and captures no change nobody takes (ADR-146)', async () => {
    const s = await campaignCompany(1);
    const { c } = s;
    const owner = await fx.ctx(c, c.owner);
    const outcomes = await addEndpoint(
      c,
      ['campaign.status_changed', 'message.status'],
      null,
      null,
      ['canceled', 'completed', 'paused'],
    );
    const every = await addEndpoint(c, ['campaign.status_changed']);
    expect((await webhooks().list(owner)).map((e) => [e.id, e.campaignStatuses]).sort()).toEqual(
      [
        [outcomes.id, ['paused', 'completed', 'canceled']],
        [every.id, null],
      ].sort(),
    );

    // A campaign that starts, is paused and resumed by members, and completes.
    const id = await s.draft(owner, 'Weekend sale');
    await s.campaigns.submitCampaign(owner, id, { expectedVersion: 1 }, {});
    expect(await s.tick(id)).toMatchObject({ outcome: 'progress', queued: 1 });
    await s.campaigns.pauseCampaign(owner, id, {});
    await s.campaigns.resumeCampaign(owner, id, {});
    expect(await s.tick(id)).toMatchObject({ queued: 1 });
    expect(await s.dispatch(id)).toEqual(['accepted']);
    s.clock.advance(11_000);
    expect(await s.tick(id)).toMatchObject({ outcome: 'completed' });
    expect(await changesOf(id)).toEqual([
      ['scheduled', 'draft', null, null, 1],
      ['running', 'scheduled', null, null, 1],
      ['paused', 'running', 'manual', null, 2],
      ['running', 'paused', null, null, 1],
      ['completed', 'running', null, 'all_processed', 2],
    ]);

    // With the endpoint taking every status turned off, a campaign scheduled for tomorrow is
    // captured for nobody until it is cancelled.
    await webhooks().setEnabled(owner, { endpointId: every.id, enabled: false });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const later = await s.draft(owner, 'Tomorrow', { kind: 'later', local: `${tomorrow}T09:00` });
    await s.campaigns.submitCampaign(owner, later, { expectedVersion: 1 }, {});
    expect(await changesOf(later)).toEqual([]);
    await s.campaigns.cancelCampaign(owner, later, {});
    expect(await changesOf(later)).toEqual([['canceled', 'scheduled', null, null, 1]]);

    await deliverDue(c);
    const statusesAt = (path: string) =>
      bodiesAt(path)
        .filter((b) => b.type === 'campaign.status_changed')
        .map((b) => {
          const { campaign } = campaignStatusChangedPayloadSchema.parse(b).data;
          return [campaign.id, campaign.status];
        })
        .sort();
    expect(statusesAt(outcomes.path)).toEqual(
      [
        [id, 'paused'],
        [id, 'completed'],
        [later, 'canceled'],
      ].sort(),
    );
    // Its other events are not filtered: the campaign's message reached it as message.status,
    // accepted included (a status no campaign has: `canceled`, which the pause gave the queued
    // message, is a campaign status too).
    expect(
      bodiesAt(outcomes.path)
        .filter((b) => b.type === 'message.status')
        .map((b) => (b.data.message as { status: string }).status)
        .sort(),
    ).toEqual(['accepted', 'canceled']);
    expect(statusesAt(every.path)).toEqual([]);
  });

  it('sends an endpoint that names numbers only the campaigns that send from them; a campaign without a number is on none (ADR-170)', async () => {
    const s = await campaignCompany(0);
    const { c } = s;
    const owner = await fx.ctx(c, c.owner);
    const outlet = await fx.addNumber(c, { phone: '+91 90000 54321' });
    const types: WebhookEventType[] = ['campaign.status_changed'];
    const onMain = await addNumberEndpoint(c, types, [c.channelAccountId]);
    const onOutlet = await addNumberEndpoint(c, types, [outlet.channelAccountId]);
    const every = await addEndpoint(c, types);
    // A draft sending from the first number, cancelled, and one without a number yet, cancelled.
    const fromMain = await s.draft(owner, 'Festive sale');
    await s.campaigns.cancelCampaign(owner, fromMain, {});
    const { id: unnumbered } = await s.campaigns.createDraft(owner, { name: 'Undecided' }, {});
    await s.campaigns.cancelCampaign(owner, unnumbered, {});
    expect(await changesOf(fromMain)).toEqual([['canceled', 'draft', null, null, 2]]);
    expect(await changesOf(unnumbered)).toEqual([['canceled', 'draft', null, null, 1]]);

    await deliverDue(c);
    expect(numbersAt(onMain.path, 'campaign')).toEqual([
      ['campaign.status_changed', fromMain, c.channelAccountId],
    ]);
    expect(numbersAt(onOutlet.path, 'campaign')).toEqual([]);
    expect(numbersAt(every.path, 'campaign')).toEqual(
      [
        ['campaign.status_changed', fromMain, c.channelAccountId],
        ['campaign.status_changed', unnumbered, null],
      ].sort(),
    );
  });

  it('sends pauses by the runner and cancellations, captures nothing without an endpoint for campaigns, and fails a delivery whose campaign is gone', async () => {
    const s = await campaignCompany(1);
    const { c } = s;
    const owner = await fx.ctx(c, c.owner);
    const marketer = await fx.ctx(c, c.marketer);

    // No endpoint takes campaign events: a campaign that starts captures nothing.
    await addEndpoint(c, ['message.received', 'order.status_changed']);
    const quiet = await s.draft(owner, 'Quiet');
    await s.campaigns.submitCampaign(owner, quiet, { expectedVersion: 1 }, {});
    expect(await s.tick(quiet)).toMatchObject({ outcome: 'progress' });
    expect(await eventsOf(c, 'campaign.')).toEqual([]);

    const hook = await addEndpoint(c, ['campaign.status_changed']);
    // The runner pauses a campaign whose member lost the permission to send it.
    const paused = await s.draft(marketer, 'Launcher loses access');
    await s.campaigns.submitCampaign(marketer, paused, { expectedVersion: 1 }, {});
    await fx.query(
      `UPDATE app.memberships SET roles = '{analyst}' WHERE tenant_id = $1 AND user_id = $2`,
      [c.tenant.id, c.marketer.id],
    );
    expect(await s.tick(paused)).toMatchObject({
      outcome: 'paused',
      pauseReason: 'launcher_not_permitted',
    });
    // A member cancels a campaign scheduled for later, before it starts.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const later = await s.draft(owner, 'Tomorrow', { kind: 'later', local: `${tomorrow}T09:00` });
    await s.campaigns.submitCampaign(owner, later, { expectedVersion: 1 }, {});
    await s.campaigns.cancelCampaign(owner, later, {});
    // The runner starts it before it checks the member, as the campaign's history shows; each
    // change is stamped when it is captured, so the two made in one transaction keep their order.
    // Cancelled while paused: the pause's reason stays with the pause.
    await s.campaigns.cancelCampaign(owner, paused, {});
    expect(await changesOf(paused)).toEqual([
      ['scheduled', 'draft', null, null, 1],
      ['running', 'scheduled', null, null, 1],
      ['paused', 'running', 'launcher_not_permitted', null, 1],
      ['canceled', 'paused', null, null, 1],
    ]);
    expect(
      await fx.query(
        `SELECT count(DISTINCT occurred_at)::int AS times FROM app.webhook_events
          WHERE detail->>'campaignId' = $1`,
        [paused],
      ),
    ).toEqual([{ times: 4 }]);
    expect(await changesOf(later)).toEqual([
      ['scheduled', 'draft', null, null, 1],
      ['canceled', 'scheduled', null, null, 1],
    ]);
    await deliverDue(c);
    const canceled = bodiesAt(hook.path).find(
      (b) => (b.data.campaign as { status: string }).status === 'canceled',
    );
    expect(canceled?.data.campaign).toMatchObject({
      id: later,
      name: 'Tomorrow',
      previousStatus: 'scheduled',
      startedAt: null,
      canceledAt: expect.any(String),
    });

    // An event whose campaign no longer exists fails without an attempt.
    const gone = await addEndpoint(c, ['campaign.status_changed']);
    const eventId = uuidv7();
    await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, null), async (tx) => {
      await tx.insert(webhookEvents).values({
        id: eventId,
        tenantId: c.tenant.id,
        type: 'campaign.status_changed',
        status: 'completed',
        detail: { campaignId: uuidv7(), previousStatus: 'running' },
      });
      await tx.insert(webhookDeliveries).values({
        id: uuidv7(),
        tenantId: c.tenant.id,
        endpointId: gone.id,
        eventId,
      });
    });
    await deliverDue(c);
    expect(
      await fx.query(
        'SELECT state, attempts, last_error FROM app.webhook_deliveries WHERE endpoint_id = $1',
        [gone.id],
      ),
    ).toEqual([{ state: 'failed', attempts: 0, last_error: 'event_gone' }]);
    expect(bodiesAt(gone.path)).toEqual([]);

    // An endpoint can take every event type, campaigns included.
    const everything = await addEndpoint(c, [...WEBHOOK_EVENT_KEYS]);
    expect(
      await fx.query('SELECT event_types FROM app.webhook_endpoints WHERE id = $1', [
        everything.id,
      ]),
    ).toEqual([{ event_types: [...WEBHOOK_EVENT_KEYS] }]);
  });
});
