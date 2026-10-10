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
  apiCreateDeal,
  apiCreateNote,
  apiCreateTask,
  apiGetCampaign,
  apiGetDeal,
  apiGetTask,
  apiStartAutomationRun,
  apiStopAutomationRun,
  apiUpdateConversation,
  apiUpdateDeal,
  apiRequestOrderPayment,
  apiUpdateOrder,
  apiUpdateTask,
  authenticateApiToken,
  automationRunEndedPayloadSchema,
  automationRunStartedPayloadSchema,
  automationRunStepPayloadSchema,
  campaignStatusChangedPayloadSchema,
  campaignRecipientSkippedPayloadSchema,
  contactCreatedPayloadSchema,
  contactErasedPayloadSchema,
  contactMergedPayloadSchema,
  contactUpdatedPayloadSchema,
  conversationAssignmentPayloadSchema,
  conversationStatusPayloadSchema,
  conversationTeamPayloadSchema,
  createApiKeysService,
  createAutomationService,
  createCampaignsService,
  createCommerceService,
  createConsentService,
  createContactMergeService,
  createContactsService,
  createCrmService,
  createCsatService,
  createInboxService,
  createTeamsService,
  createTemplatesService,
  createWebhooksService,
  dealCreatedPayloadSchema,
  dealOwnerChangedPayloadSchema,
  dealUpdatedPayloadSchema,
  dealStageChangedPayloadSchema,
  dealStatusChangedPayloadSchema,
  messageReceivedPayloadSchema,
  messageStatusPayloadSchema,
  noteCreatedPayloadSchema,
  orderReceivedPayloadSchema,
  orderStatusChangedPayloadSchema,
  paymentLinkStatusChangedPayloadSchema,
  satisfactionSurveyAnsweredPayloadSchema,
  processCommerceSync,
  processPaymentAccountCheck,
  processPaymentLink,
  processSendIntent,
  processTemplateSubmit,
  processWebhookDeliveries,
  WEBHOOK_EXACT_TIME_RE,
  WebhookOAuthTokenCache,
  runCampaignTick,
  syncTemplates,
  taskAssigneeChangedPayloadSchema,
  taskCreatedPayloadSchema,
  taskStatusChangedPayloadSchema,
  taskUpdatedPayloadSchema,
  WEBHOOK_EVENT_KEYS,
  type AutomationTrigger,
  type CatalogSyncDeps,
  type TemplateDefinition,
  type TenantContext,
  type WebhookContactPart,
  type WebhookCrmChangeMaker,
  type WebhookEventType,
} from '@w360/domain';
import { startRazorpayStandIn, type RazorpayStandIn } from '../support/razorpay-stand-in';
import { failOnLog } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Webhook events for conversations and contacts (ADR-074), automation runs (ADR-078), WhatsApp
 * orders (ADR-085), campaigns (ADR-087) and CRM deals (ADR-256) against real PostgreSQL and a local
 * receiver: capture by the triggers from every kind of change, one contact event per contact and
 * transaction (savepoints included), erasure sending only `contact.erased`, the start and end of
 * live runs (not test runs), orders, campaigns and deals and every change of their status whoever
 * makes it (members, Razorpay through the worker, the campaign runner, automations, API keys),
 * delivery to the endpoints that take each type, payloads built when delivered, and the capture
 * function's limits for the company role.
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
  runTriggers: string[] | null = null,
  contactFieldKeys: string[] | null = null,
  campaignIds: string[] | null = null,
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
    runTriggers,
    contactFieldKeys,
    campaignIds,
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
    .map(
      (r) =>
        JSON.parse(r.body) as {
          id: string;
          type: string;
          createdAt: string;
          data: Record<string, unknown>;
        },
    );

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
  prefix: 'conversation.' | 'contact.' | 'automation.' | 'order.' | 'payment_link.' | 'campaign.',
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

/**
 * A customer who writes by WhatsApp user id only (no number) to the company's number `c`; the
 * contact HyFib adds for them, which has no number.
 */
async function writesByUserId(c: Company) {
  const user = `IN.${randomBytes(8).toString('hex')}`;
  const body = fx.messagesBody(c, { messages: [{ text: 'Hello' }] }) as {
    entry: {
      changes: { value: { messages: { from?: string }[]; contacts: { user_id?: string }[] } }[];
    }[];
  };
  const value = body.entry[0]!.changes[0]!.value;
  value.messages[0]!.from = user;
  value.contacts[0]!.user_id = user;
  await fx.deliver(body);
  const [row] = await fx.query<{ contact_id: string }>(
    'SELECT contact_id FROM app.contact_identities WHERE tenant_id = $1 AND bsuid = $2',
    [c.tenant.id, user],
  );
  if (!row) throw new Error('no contact for the user id');
  return row.contact_id;
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
    // To the microsecond (ADR-330): each change's own time as stored, so the three differ and sort
    // as text in the order they were captured; createdAt is the same moment cut to the millisecond.
    const exact = new Map(
      assignments.map((b) => [b.id, (b as { createdAtExact?: string }).createdAtExact ?? '']),
    );
    const stored = await fx.query<{ id: string; at: string }>(
      `SELECT id, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
         FROM app.webhook_events
        WHERE tenant_id = $1 AND conversation_id = $2 AND type = 'conversation.assignment_changed'
        ORDER BY occurred_at`,
      [c.tenant.id, conversationId],
    );
    expect(stored.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(stored.map((r) => exact.get(r.id))).toEqual(stored.map((r) => r.at));
    expect(new Set(exact.values()).size).toBe(3);
    const exactInOrder = rows.map((r) => exact.get(r.id) ?? '');
    expect([...exactInOrder].sort()).toEqual(exactInOrder);
    for (const [id, at] of exact) {
      expect(at).toMatch(WEBHOOK_EXACT_TIME_RE);
      expect(createdAt.get(id)).toBe(`${at.slice(0, 23)}Z`);
    }
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

  it('sends contact.merged with the contact kept as it is when delivered, and nothing more of a merged contact (ADR-225)', async () => {
    const c = await fx.company();
    const all = await addEndpoint(c, ['contact.created', 'contact.updated', 'contact.merged']);
    const mergesOnly = await addEndpoint(c, ['contact.merged']);
    const updatesOnly = await addEndpoint(c, ['contact.updated']);
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    const merges = createContactMergeService({ db: fx.dbs.app, clock: systemClock });
    const { id: kept } = await service.createContact(owner, {
      displayName: 'Gita',
      phone: '+919811100051',
    });
    // The contacts merged into it have no number: customers who wrote by WhatsApp user id, each to
    // a number of the company of its own (members add contacts with a number, and two contacts with
    // conversations on one number are never merged).
    const first = await writesByUserId(c);
    const last = await writesByUserId(await fx.addNumber(c));
    await service.addTags(owner, last, ['store']);
    await deliverDue(c);
    expect(
      bodiesAt(all.path)
        .map((b) => b.type)
        .sort(),
    ).toEqual(['contact.created', 'contact.created', 'contact.created', 'contact.updated']);
    // A change of the first contact, not yet delivered when it is merged.
    await service.updateContact(owner, first, {
      displayName: 'Gita Rao',
      email: 'gita@example.test',
    });

    // The first into the last, then the last into the kept contact, before any delivery.
    await merges.mergeContacts(owner, { keepContactId: last, mergeContactId: first });
    await merges.mergeContacts(owner, { keepContactId: kept, mergeContactId: last });
    // One event per merge, naming the contact kept then and the merged one; each merge changed the
    // contact it kept, which is still captured as contact.updated.
    const events = await eventsOf(c, 'contact.');
    expect(
      events
        .filter((e) => e.type !== 'contact.created')
        .map((e) => [e.type, e.contact_id, e.detail.mergedContactId ?? null, e.deliveries])
        .sort(),
    ).toEqual(
      [
        ['contact.merged', kept, last, 2],
        ['contact.merged', last, first, 2],
        ['contact.updated', first, null, 2],
        ['contact.updated', kept, null, 2],
        // The tag added before (delivered), then the merge.
        ['contact.updated', last, null, 2],
        ['contact.updated', last, null, 2],
      ].sort(),
    );

    await deliverDue(c);
    // Each merge is delivered with the contact the merged one belongs to now: the kept contact,
    // through the later merge too. The changes of the contacts that are gone are not sent.
    const sent = bodiesAt(all.path).slice(4);
    expect(
      sent
        .map((b) => [b.type, (b.data.contact as { id: string }).id, b.data.mergedContactId ?? null])
        .sort(),
    ).toEqual(
      [
        ['contact.merged', kept, first],
        ['contact.merged', kept, last],
        ['contact.updated', kept, null],
      ].sort(),
    );
    for (const body of sent.filter((b) => b.type === 'contact.merged')) {
      expect(contactMergedPayloadSchema.safeParse(body).success).toBe(true);
      expect(body.data.contact).toMatchObject({
        id: kept,
        name: 'Gita',
        email: 'gita@example.test',
        tags: ['store'],
        erased: false,
      });
    }
    expect(sent.find((b) => b.type === 'contact.updated')!.data).toMatchObject({
      changes: ['email', 'tags'],
      tagsAdded: ['store'],
      tagsRemoved: [],
    });
    expect(
      bodiesAt(mergesOnly.path)
        .map((b) => [b.type, b.data.mergedContactId])
        .sort(),
    ).toEqual(
      [
        ['contact.merged', first],
        ['contact.merged', last],
      ].sort(),
    );
    expect(bodiesAt(updatesOnly.path).map((b) => (b.data.contact as { id: string }).id)).toEqual([
      last,
      kept,
    ]);
    expect(
      await fx.query<{ contact_id: string; last_error: string }>(
        `SELECT e.contact_id, d.last_error FROM app.webhook_deliveries d
           JOIN app.webhook_events e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
          WHERE d.endpoint_id = $1 AND d.state = 'failed' ORDER BY e.contact_id`,
        [all.id],
      ),
    ).toEqual(
      [
        { contact_id: first, last_error: 'event_gone' },
        { contact_id: last, last_error: 'event_gone' },
      ].sort((a, b) => (a.contact_id < b.contact_id ? -1 : 1)),
    );
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

describe('custom field filters (ADR-184)', () => {
  it('queue a field change only for the endpoints whose fields hold its key, other parts by the parts alone, and a later change in the transaction for those it newly concerns', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    await service.createField(owner, { label: 'City', key: 'city', type: 'text' });
    await service.createField(owner, { label: 'Tier', key: 'tier', type: 'text' });
    /** An endpoint for contact.updated with the parts and fields given. */
    const add = (parts: WebhookContactPart[] | null, fields: string[] | null) =>
      addEndpoint(c, ['contact.updated'], parts, null, null, null, null, null, null, null, fields);
    const tierOnly = await add(['fields'], ['tier']);
    const everyPartButTier = await add(null, ['tier']);
    const every = await add(null, null);
    const names = new Map([
      [tierOnly.id, 'tierOnly'],
      [everyPartButTier.id, 'everyPartButTier'],
      [every.id, 'every'],
    ]);
    const { id: contactId } = await service.createContact(owner, {
      displayName: 'Esha',
      phone: '+919811100101',
    });
    const save = (change: Record<string, unknown>) =>
      service.updateContact(owner, contactId, { displayName: 'Esha', ...change });
    // The city alone, the tier alone, the email alone, then the city and the email in one save.
    await save({ attributes: { city: 'Pune' } });
    await save({ attributes: { city: 'Pune', tier: 'gold' } });
    await save({ attributes: { city: 'Pune', tier: 'gold' }, email: 'esha@example.test' });
    await save({ attributes: { city: 'Delhi', tier: 'gold' }, email: 'esha@example.org' });
    // The city, then the tier, in one transaction: the tier's endpoints are queued with it.
    const scope = authorizedTenantScope(c.tenant.id, c.owner.id);
    await fx.dbs.app.run(scope, async (tx) => {
      await tx.execute(sql`update app.contacts set attributes = attributes || '{"city": "Agra"}'
        where id = ${contactId}::uuid`);
      await tx.execute(sql`update app.contacts set attributes = attributes || '{"tier": "silver"}'
        where id = ${contactId}::uuid`);
    });
    const updates = await fx.query<{ changes: string[]; endpoints: string[] }>(
      `SELECT e.contact_changes AS changes,
              coalesce((SELECT array_agg(d.endpoint_id::text) FROM app.webhook_deliveries d
                         WHERE d.tenant_id = e.tenant_id AND d.event_id = e.id), '{}') AS endpoints
         FROM app.webhook_events e
        WHERE e.tenant_id = $1 AND e.type = 'contact.updated' ORDER BY e.created_at, e.id`,
      [c.tenant.id],
    );
    expect(
      updates.map((u) => [u.changes, u.endpoints.map((id) => names.get(id) ?? id).sort()]),
    ).toEqual([
      [['fields.city'], ['every']],
      [['fields.tier'], ['every', 'everyPartButTier', 'tierOnly']],
      [['email'], ['every', 'everyPartButTier']],
      [
        ['email', 'fields.city'],
        ['every', 'everyPartButTier'],
      ],
      [
        ['fields.city', 'fields.tier'],
        ['every', 'everyPartButTier', 'tierOnly'],
      ],
    ]);
    // Each delivery still names every part that changed.
    await deliverDue(c);
    const changesAt = (path: string) =>
      bodiesAt(path)
        .map((b) => (b.data.changes as string[]).join('+'))
        .sort();
    expect(changesAt(tierOnly.path)).toEqual(['fields.city+fields.tier', 'fields.tier']);
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

describe('contact event tag filters (ADR-316)', () => {
  /** An endpoint of the company taking these contact events, narrowed by these lists. */
  const add = async (
    c: Company,
    eventTypes: WebhookEventType[],
    lists: Record<string, unknown>,
  ) => {
    const path = `/ok/${randomBytes(6).toString('hex')}`;
    const owner = await fx.ctx(c, c.owner);
    const created = await webhooks().create(owner, {
      url: `http://${HOST}:${port}${path}`,
      eventTypes,
      ...lists,
    });
    return { ...created, path };
  };
  /** What an endpoint was sent, sorted: each event's type and contact, and an update's changes. */
  const sentTo = (path: string) =>
    bodiesAt(path)
      .map((b) => [
        b.type,
        (b.data.contact as { id: string }).id,
        (b.data.changes as string[] | undefined) ?? null,
      ])
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  const sorted = (rows: unknown[][]) =>
    [...rows].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));

  it('sends an endpoint that names tags the changes of contacts that have one of them, and the changes adding or removing one', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    const vips = await add(c, ['contact.updated'], { contactEventTags: ['vip', 'gold member'] });
    const vipNames = await add(c, ['contact.updated'], {
      contactEventTags: ['vip'],
      contactParts: ['name'],
    });
    const every = await add(c, ['contact.updated'], {});
    const { id: hema } = await service.createContact(owner, {
      displayName: 'Hema',
      phone: '+919811100161',
    });
    const { id: ravi } = await service.createContact(owner, {
      displayName: 'Ravi',
      phone: '+919811100162',
    });
    // Tagged vip: a change adding a listed tag, sent to the endpoint taking every part.
    await service.addTags(owner, hema, ['vip']);
    // A change of a vip: sent, by its part too.
    await service.updateContact(owner, hema, { displayName: 'Hema K' });
    // Changes of a contact without a listed tag, one adding a tag no endpoint names.
    await service.updateContact(owner, ravi, { displayName: 'Ravi S' });
    await service.addTags(owner, ravi, ['north']);
    // The change removing vip is sent; the next one, of a contact no longer vip, is not.
    await service.removeTag(owner, hema, 'vip');
    await service.updateContact(owner, hema, { displayName: 'Hema R' });
    // A tag as contacts carry it: "Gold Member" is the endpoint's "gold member".
    await service.addTags(owner, ravi, ['Gold   Member']);

    expect(
      (await eventsOf(c, 'contact.')).map((e) => [
        e.type,
        e.contact_id,
        e.contact_changes,
        e.deliveries,
      ]),
    ).toEqual([
      ['contact.created', hema, null, 0],
      ['contact.created', ravi, null, 0],
      ['contact.updated', hema, ['tags'], 2],
      ['contact.updated', hema, ['name'], 3],
      ['contact.updated', ravi, ['name'], 1],
      ['contact.updated', ravi, ['tags'], 1],
      ['contact.updated', hema, ['tags'], 2],
      ['contact.updated', hema, ['name'], 1],
      ['contact.updated', ravi, ['tags'], 2],
    ]);
    await deliverDue(c);
    expect(sentTo(vips.path)).toEqual(
      sorted([
        ['contact.updated', hema, ['tags']],
        ['contact.updated', hema, ['name']],
        ['contact.updated', hema, ['tags']],
        ['contact.updated', ravi, ['tags']],
      ]),
    );
    expect(sentTo(vipNames.path)).toEqual([['contact.updated', hema, ['name']]]);
    expect(sentTo(every.path)).toHaveLength(7);
    // The removal says which tag it removed.
    expect(
      bodiesAt(vips.path)
        .filter((b) => (b.data.tagsRemoved as string[]).length > 0)
        .map((b) => [b.data.tagsAdded, b.data.tagsRemoved]),
    ).toEqual([[[], ['vip']]]);

    // In one transaction, a listed tag added and removed again is a change that named it.
    const scope = authorizedTenantScope(c.tenant.id, c.owner.id);
    await fx.dbs.app.run(scope, async (tx) => {
      await tx.execute(sql`insert into app.contact_tags (id, tenant_id, contact_id, tag)
        values (gen_random_uuid(), ${c.tenant.id}::uuid, ${hema}::uuid, 'vip')`);
      await tx.execute(sql`delete from app.contact_tags
        where tenant_id = ${c.tenant.id}::uuid and contact_id = ${hema}::uuid and tag = 'vip'`);
    });
    expect((await eventsOf(c, 'contact.')).at(-1)).toMatchObject({
      type: 'contact.updated',
      contact_id: hema,
      deliveries: 2,
    });
  });

  it('sends a change that passes the parts and the tags whatever the order of the writes in its transaction', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    const vipNames = await add(c, ['contact.updated'], {
      contactEventTags: ['vip'],
      contactParts: ['name'],
    });
    const { id: hema } = await service.createContact(owner, {
      displayName: 'Hema',
      phone: '+919811100168',
    });
    const { id: ravi } = await service.createContact(owner, {
      displayName: 'Ravi',
      phone: '+919811100169',
      tags: ['vip'],
    });
    const scope = authorizedTenantScope(c.tenant.id, c.owner.id);
    const rename = (contactId: string, name: string) =>
      sql`update app.contacts set display_name = ${name}
        where tenant_id = ${c.tenant.id}::uuid and id = ${contactId}::uuid`;
    const tagVip = (contactId: string) =>
      sql`insert into app.contact_tags (id, tenant_id, contact_id, tag)
        values (gen_random_uuid(), ${c.tenant.id}::uuid, ${contactId}::uuid, 'vip')`;
    const untagVip = (contactId: string) =>
      sql`delete from app.contact_tags
        where tenant_id = ${c.tenant.id}::uuid and contact_id = ${contactId}::uuid and tag = 'vip'`;
    // Renamed, then tagged vip, in one transaction, as the API writes a contact's change.
    await fx.dbs.app.run(scope, async (tx) => {
      await tx.execute(rename(hema, 'Hema K'));
      await tx.execute(tagVip(hema));
    });
    // Untagged, then renamed, in one transaction: a change that removed vip.
    await fx.dbs.app.run(scope, async (tx) => {
      await tx.execute(untagVip(ravi));
      await tx.execute(rename(ravi, 'Ravi S'));
    });
    // A change of tags alone is not a change of the name.
    await service.addTags(owner, ravi, ['vip']);
    expect(
      (await eventsOf(c, 'contact.')).map((e) => [
        e.type,
        e.contact_id,
        e.contact_changes,
        e.deliveries,
      ]),
    ).toEqual([
      ['contact.created', hema, null, 0],
      ['contact.created', ravi, null, 0],
      ['contact.updated', hema, ['name', 'tags'], 1],
      ['contact.updated', ravi, ['name', 'tags'], 1],
      ['contact.updated', ravi, ['tags'], 0],
    ]);
    await deliverDue(c);
    expect(sentTo(vipNames.path)).toEqual(
      sorted([
        ['contact.updated', hema, ['name', 'tags']],
        ['contact.updated', ravi, ['name', 'tags']],
      ]),
    );
  });

  it('sends a contact added with a listed tag as contact.created, by its source too, and one tagged later as contact.updated', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    const vipsAdded = await add(c, ['contact.created'], { contactEventTags: ['vip'] });
    const apiVipsAdded = await add(c, ['contact.created'], {
      contactEventTags: ['vip'],
      contactSources: ['api'],
    });
    const vipsBoth = await add(c, ['contact.created', 'contact.updated'], {
      contactEventTags: ['vip'],
    });
    const everyAdded = await add(c, ['contact.created'], {});
    // Added with vip by a member, in one transaction.
    const { id: hema } = await service.createContact(owner, {
      displayName: 'Hema',
      phone: '+919811100163',
      tags: ['vip'],
    });
    // Added with vip from the API, in one transaction.
    const api = uuidv7();
    await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), async (tx) => {
      await tx.execute(sql`insert into app.contacts (id, tenant_id, phone_e164, source)
        values (${api}::uuid, ${c.tenant.id}::uuid, '+919811100164', 'api')`);
      await tx.execute(sql`insert into app.contact_tags (id, tenant_id, contact_id, tag)
        values (gen_random_uuid(), ${c.tenant.id}::uuid, ${api}::uuid, 'vip')`);
    });
    // Added without tags and tagged later: the tagging is a change.
    const { id: ravi } = await service.createContact(owner, {
      displayName: 'Ravi',
      phone: '+919811100165',
    });
    await service.addTags(owner, ravi, ['vip']);

    expect(
      (await eventsOf(c, 'contact.')).map((e) => [e.type, e.contact_id, e.deliveries]),
    ).toEqual([
      ['contact.created', hema, 3],
      ['contact.created', api, 4],
      ['contact.created', ravi, 1],
      ['contact.updated', ravi, 1],
    ]);
    await deliverDue(c);
    expect(sentTo(vipsAdded.path)).toEqual(
      sorted([
        ['contact.created', hema, null],
        ['contact.created', api, null],
      ]),
    );
    expect(sentTo(apiVipsAdded.path)).toEqual([['contact.created', api, null]]);
    expect(sentTo(vipsBoth.path)).toEqual(
      sorted([
        ['contact.created', hema, null],
        ['contact.created', api, null],
        ['contact.updated', ravi, ['tags']],
      ]),
    );
    expect(sentTo(everyAdded.path)).toHaveLength(3);
  });

  it('matches tags as the definer role merging and erasing contacts: the tag a merge gives the kept contact is sent, and an erasure is sent as itself', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    const vips = await add(c, ['contact.updated', 'contact.erased'], {
      contactEventTags: ['vip'],
    });
    const { id: kept } = await service.createContact(owner, {
      displayName: 'Gita',
      phone: '+919811100166',
    });
    const merged = await writesByUserId(c);
    await service.addTags(owner, merged, ['vip']);
    await deliverDue(c);
    expect(sentTo(vips.path)).toEqual([['contact.updated', merged, ['tags']]]);

    // The merge moves the tag to the kept contact as the definer role; the merged contact is gone,
    // so its last change is not sent.
    await createContactMergeService({ db: fx.dbs.app, clock: systemClock }).mergeContacts(owner, {
      keepContactId: kept,
      mergeContactId: merged,
    });
    await deliverDue(c);
    const afterMerge = bodiesAt(vips.path).slice(1);
    expect(afterMerge.map((b) => [b.type, (b.data.contact as { id: string }).id])).toEqual([
      ['contact.updated', kept],
    ]);
    expect(afterMerge[0]!.data.tagsAdded).toEqual(['vip']);

    // Erasing the kept contact removes its tags as the definer role: no change is sent, and the
    // erasure is, contact.erased being narrowed by no tag.
    await service.eraseContact(owner, { contactId: kept, suppress: false });
    const { id: plain } = await service.createContact(owner, { phone: '+919811100167' });
    await service.eraseContact(owner, { contactId: plain, suppress: false });
    await deliverDue(c);
    expect(
      bodiesAt(vips.path)
        .slice(2)
        .map((b) => [b.type, (b.data.contact as { id: string }).id])
        .sort(),
    ).toEqual(
      [
        ['contact.erased', kept],
        ['contact.erased', plain],
      ].sort(),
    );
  });
});

describe('contact event field value filters (ADR-332)', () => {
  /** An endpoint of the company taking these contact events, narrowed by these lists. */
  const add = async (
    c: Company,
    eventTypes: WebhookEventType[],
    lists: Record<string, unknown>,
  ) => {
    const path = `/ok/${randomBytes(6).toString('hex')}`;
    const owner = await fx.ctx(c, c.owner);
    const created = await webhooks().create(owner, {
      url: `http://${HOST}:${port}${path}`,
      eventTypes,
      ...lists,
    });
    return { ...created, path };
  };
  /** What an endpoint was sent, sorted: each event's type and contact, and an update's changes. */
  const sentTo = (path: string) =>
    bodiesAt(path)
      .map((b) => [
        b.type,
        (b.data.contact as { id: string }).id,
        (b.data.changes as string[] | undefined) ?? null,
      ])
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  const sorted = (rows: unknown[][]) =>
    [...rows].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  /** The company's fields this describe block names. */
  const addFields = async (c: Company) => {
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    await service.createField(owner, { label: 'Tier', key: 'tier', type: 'text' });
    await service.createField(owner, { label: 'Score', key: 'score', type: 'number' });
    await service.createField(owner, { label: 'VIP', key: 'vip', type: 'boolean' });
  };

  it('sends an endpoint that names values the changes of contacts that have one of them, and every change of those fields', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    await addFields(c);
    // Text is compared whatever its case: "gold" is the contact's "Gold".
    const gold = await add(c, ['contact.updated'], {
      contactEventFieldValues: [{ key: 'tier', value: 'gold' }],
    });
    const goldNames = await add(c, ['contact.updated'], {
      contactEventFieldValues: [{ key: 'tier', value: 'GOLD' }],
      contactParts: ['name'],
    });
    const scored = await add(c, ['contact.updated'], {
      contactEventFieldValues: [
        { key: 'score', value: 5 },
        { key: 'vip', value: true },
      ],
    });
    const every = await add(c, ['contact.updated'], {});
    const { id: hema } = await service.createContact(owner, {
      displayName: 'Hema',
      phone: '+919811100261',
      attributes: { tier: 'Gold' },
    });
    const { id: ravi } = await service.createContact(owner, {
      displayName: 'Ravi',
      phone: '+919811100262',
    });
    // A change of a contact with a listed value: sent, by its part too.
    await service.updateContact(owner, hema, { displayName: 'Hema K' });
    // A change of a contact without one.
    await service.updateContact(owner, ravi, { displayName: 'Ravi S' });
    // A number given as members type it: 5 is the endpoint's 5.
    await service.updateContact(owner, ravi, {
      displayName: 'Ravi S',
      attributes: { score: '5.0' },
    });
    // Out of gold: a change of the listed field, sent to the endpoint taking every part.
    await service.updateContact(owner, hema, {
      displayName: 'Hema K',
      attributes: { tier: 'silver' },
    });
    // The next change of a contact no longer gold is not.
    await service.updateContact(owner, hema, { displayName: 'Hema R' });
    // A change of a listed field between two values not listed is sent too.
    await service.updateContact(owner, ravi, {
      displayName: 'Ravi S',
      attributes: { tier: 'bronze' },
    });
    // Yes/no as true and false.
    await service.updateContact(owner, ravi, { displayName: 'Ravi S', attributes: { vip: 'yes' } });

    expect(
      (await eventsOf(c, 'contact.')).map((e) => [
        e.type,
        e.contact_id,
        e.contact_changes,
        e.deliveries,
      ]),
    ).toEqual([
      ['contact.created', hema, null, 0],
      ['contact.created', ravi, null, 0],
      ['contact.updated', hema, ['name'], 3],
      ['contact.updated', ravi, ['name'], 1],
      ['contact.updated', ravi, ['fields.score'], 2],
      ['contact.updated', hema, ['fields.tier'], 2],
      ['contact.updated', hema, ['name'], 1],
      ['contact.updated', ravi, ['fields.tier'], 3],
      ['contact.updated', ravi, ['fields.vip'], 2],
    ]);
    await deliverDue(c);
    expect(sentTo(gold.path)).toEqual(
      sorted([
        ['contact.updated', hema, ['name']],
        ['contact.updated', hema, ['fields.tier']],
        ['contact.updated', ravi, ['fields.tier']],
      ]),
    );
    expect(sentTo(goldNames.path)).toEqual([['contact.updated', hema, ['name']]]);
    expect(sentTo(scored.path)).toEqual(
      sorted([
        ['contact.updated', ravi, ['fields.score']],
        ['contact.updated', ravi, ['fields.tier']],
        ['contact.updated', ravi, ['fields.vip']],
      ]),
    );
    expect(sentTo(every.path)).toHaveLength(7);
  });

  it('matches the values whatever the order of a transaction’s writes, into the values and out of them', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    await addFields(c);
    const goldNames = await add(c, ['contact.updated'], {
      contactEventFieldValues: [{ key: 'tier', value: 'gold' }],
      contactParts: ['name'],
    });
    const { id: hema } = await service.createContact(owner, {
      displayName: 'Hema',
      phone: '+919811100263',
      attributes: { tier: 'silver' },
    });
    const scope = authorizedTenantScope(c.tenant.id, c.owner.id);
    const rename = (name: string) =>
      sql`update app.contacts set display_name = ${name}
           where tenant_id = ${c.tenant.id}::uuid and id = ${hema}::uuid`;
    const setTier = (tier: string) =>
      sql`update app.contacts set attributes = attributes || jsonb_build_object('tier', ${tier}::text)
           where tenant_id = ${c.tenant.id}::uuid and id = ${hema}::uuid`;
    // Renamed, then gold: the name passes the parts once the contact is gold.
    await fx.dbs.app.run(scope, async (tx) => {
      await tx.execute(rename('Hema K'));
      await tx.execute(setTier('gold'));
    });
    // Out of gold, then renamed: the name passes the parts, the tier the values.
    await fx.dbs.app.run(scope, async (tx) => {
      await tx.execute(setTier('silver'));
      await tx.execute(rename('Hema R'));
    });
    // Out of gold without a change of a part the endpoint takes: not sent.
    await fx.dbs.app.run(scope, async (tx) => {
      await tx.execute(setTier('gold'));
    });
    await fx.dbs.app.run(scope, async (tx) => {
      await tx.execute(setTier('bronze'));
    });
    // Both writes in one statement.
    await fx.dbs.app.run(scope, async (tx) => {
      await tx.execute(sql`update app.contacts
          set display_name = 'Hema S', attributes = attributes || '{"tier": "Gold"}'::jsonb
        where tenant_id = ${c.tenant.id}::uuid and id = ${hema}::uuid`);
    });
    expect(
      (await eventsOf(c, 'contact.')).map((e) => [e.type, e.contact_changes, e.deliveries]),
    ).toEqual([
      ['contact.created', null, 0],
      ['contact.updated', ['fields.tier', 'name'], 1],
      ['contact.updated', ['fields.tier', 'name'], 1],
      ['contact.updated', ['fields.tier'], 0],
      ['contact.updated', ['fields.tier'], 0],
      ['contact.updated', ['fields.tier', 'name'], 1],
    ]);
    await deliverDue(c);
    expect(sentTo(goldNames.path)).toHaveLength(3);
  });

  it('sends a contact added with a listed value as contact.created, by its source and tags too, and one given it later as contact.updated', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    await addFields(c);
    const goldAdded = await add(c, ['contact.created'], {
      contactEventFieldValues: [{ key: 'tier', value: 'gold' }],
    });
    const apiGoldAdded = await add(c, ['contact.created'], {
      contactEventFieldValues: [{ key: 'tier', value: 'gold' }],
      contactSources: ['api'],
    });
    const vipGoldAdded = await add(c, ['contact.created'], {
      contactEventFieldValues: [{ key: 'tier', value: 'gold' }],
      contactEventTags: ['vip'],
    });
    const goldBoth = await add(c, ['contact.created', 'contact.updated'], {
      contactEventFieldValues: [{ key: 'tier', value: 'gold' }],
    });
    const everyAdded = await add(c, ['contact.created'], {});
    // Added gold by a member, in one statement.
    const { id: hema } = await service.createContact(owner, {
      displayName: 'Hema',
      phone: '+919811100264',
      attributes: { tier: 'gold' },
    });
    // Added from the API, then given gold and tagged vip in the same transaction.
    const api = uuidv7();
    await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), async (tx) => {
      await tx.execute(sql`insert into app.contacts (id, tenant_id, phone_e164, source)
        values (${api}::uuid, ${c.tenant.id}::uuid, '+919811100265', 'api')`);
      await tx.execute(sql`update app.contacts set attributes = '{"tier": "gold"}'::jsonb
        where tenant_id = ${c.tenant.id}::uuid and id = ${api}::uuid`);
      await tx.execute(sql`insert into app.contact_tags (id, tenant_id, contact_id, tag)
        values (gen_random_uuid(), ${c.tenant.id}::uuid, ${api}::uuid, 'vip')`);
    });
    // Added without values and given gold later: the change is a contact.updated.
    const { id: ravi } = await service.createContact(owner, {
      displayName: 'Ravi',
      phone: '+919811100266',
    });
    await service.updateContact(owner, ravi, { displayName: 'Ravi', attributes: { tier: 'gold' } });

    expect(
      (await eventsOf(c, 'contact.')).map((e) => [e.type, e.contact_id, e.deliveries]),
    ).toEqual([
      ['contact.created', hema, 3],
      ['contact.created', api, 5],
      ['contact.created', ravi, 1],
      ['contact.updated', ravi, 1],
    ]);
    await deliverDue(c);
    expect(sentTo(goldAdded.path)).toEqual(
      sorted([
        ['contact.created', hema, null],
        ['contact.created', api, null],
      ]),
    );
    expect(sentTo(apiGoldAdded.path)).toEqual([['contact.created', api, null]]);
    expect(sentTo(vipGoldAdded.path)).toEqual([['contact.created', api, null]]);
    expect(sentTo(goldBoth.path)).toEqual(
      sorted([
        ['contact.created', hema, null],
        ['contact.created', api, null],
        ['contact.updated', ravi, ['fields.tier']],
      ]),
    );
    expect(sentTo(everyAdded.path)).toHaveLength(3);
  });

  it('matches values as the definer role merging contacts, and an erasure is sent as itself', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    await addFields(c);
    const gold = await add(c, ['contact.updated', 'contact.erased'], {
      contactEventFieldValues: [{ key: 'tier', value: 'gold' }],
    });
    const { id: kept } = await service.createContact(owner, {
      displayName: 'Gita',
      phone: '+919811100267',
    });
    const merged = await writesByUserId(c);
    await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), async (tx) => {
      await tx.execute(sql`update app.contacts set attributes = '{"tier": "gold"}'::jsonb
        where tenant_id = ${c.tenant.id}::uuid and id = ${merged}::uuid`);
    });
    await deliverDue(c);
    expect(sentTo(gold.path)).toEqual([['contact.updated', merged, ['fields.tier']]]);

    // The merge gives the kept contact the merged one's tier as the definer role.
    await createContactMergeService({ db: fx.dbs.app, clock: systemClock }).mergeContacts(owner, {
      keepContactId: kept,
      mergeContactId: merged,
    });
    await deliverDue(c);
    const afterMerge = bodiesAt(gold.path).slice(1);
    expect(afterMerge.map((b) => [b.type, (b.data.contact as { id: string }).id])).toEqual([
      ['contact.updated', kept],
    ]);
    expect(afterMerge[0]!.data.changes).toContain('fields.tier');

    // Erasing it is sent, contact.erased being narrowed by no value.
    await service.eraseContact(owner, { contactId: kept, suppress: false });
    await deliverDue(c);
    expect(
      bodiesAt(gold.path)
        .slice(2)
        .map((b) => [b.type, (b.data.contact as { id: string }).id]),
    ).toEqual([['contact.erased', kept]]);
  });
});
describe('contact event field words and ranges (ADR-335)', () => {
  const add = async (
    c: Company,
    eventTypes: WebhookEventType[],
    lists: Record<string, unknown>,
  ) => {
    const path = `/ok/${randomBytes(6).toString('hex')}`;
    const owner = await fx.ctx(c, c.owner);
    const created = await webhooks().create(owner, {
      url: `http://${HOST}:${port}${path}`,
      eventTypes,
      ...lists,
    });
    return { ...created, path };
  };
  const sentTo = (path: string) =>
    bodiesAt(path)
      .map((b) => [
        b.type,
        (b.data.contact as { id: string }).id,
        (b.data.changes as string[] | undefined) ?? null,
      ])
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  const sorted = (rows: unknown[][]) =>
    [...rows].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));

  it('sends an endpoint the changes of contacts whose text contains its word or whose number or date is in its range, and every change of those fields', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    await service.createField(owner, { label: 'City', key: 'city', type: 'text' });
    await service.createField(owner, { label: 'Score', key: 'score', type: 'number' });
    await service.createField(owner, { label: 'Renewal', key: 'renewal', type: 'date' });
    // A word compared whatever its case: "CHEN" is in the contact's "Chennai".
    const word = await add(c, ['contact.updated'], {
      contactEventFieldValues: [{ key: 'city', contains: 'CHEN' }],
    });
    const high = await add(c, ['contact.updated'], {
      contactEventFieldValues: [{ key: 'score', atLeast: 10 }],
    });
    const band = await add(c, ['contact.updated'], {
      contactEventFieldValues: [{ key: 'score', atLeast: 1, atMost: 5 }],
    });
    const october = await add(c, ['contact.updated'], {
      contactEventFieldValues: [{ key: 'renewal', atLeast: '2026-10-01', atMost: '2026-10-31' }],
    });
    const untilMidNovember = await add(c, ['contact.updated'], {
      contactEventFieldValues: [{ key: 'renewal', atMost: '2026-11-15' }],
    });
    const mixed = await add(c, ['contact.updated'], {
      contactEventFieldValues: [
        { key: 'city', value: 'Madurai' },
        { key: 'score', atMost: 0 },
      ],
    });
    const addedHigh = await add(c, ['contact.created'], {
      contactEventFieldValues: [{ key: 'score', atLeast: 10 }],
    });
    const { id: asha } = await service.createContact(owner, {
      displayName: 'Asha',
      phone: '+919811100271',
      attributes: { city: 'Chennai', score: '12', renewal: '2026-10-15' },
    });
    const { id: bala } = await service.createContact(owner, {
      displayName: 'Bala',
      phone: '+919811100272',
      attributes: { city: 'Coimbatore', score: '3', renewal: '2026-12-01' },
    });
    // Asha: Chennai, 12, renewing on 15 October.
    await service.updateContact(owner, asha, { displayName: 'Asha K' });
    // Bala: Coimbatore, 3, renewing on 1 December.
    await service.updateContact(owner, bala, { displayName: 'Bala S' });
    // Bala's score changes to 10: the range's start is in it, and the field is listed.
    await service.updateContact(owner, bala, {
      displayName: 'Bala S',
      attributes: { score: '10' },
    });
    // Asha moves to Madurai: out of the word, into the mixed list's value.
    await service.updateContact(owner, asha, {
      displayName: 'Asha K',
      attributes: { city: 'Madurai' },
    });

    await deliverDue(c);
    expect(sentTo(word.path)).toEqual(
      sorted([
        ['contact.updated', asha, ['name']],
        ['contact.updated', asha, ['fields.city']],
      ]),
    );
    expect(sentTo(high.path)).toEqual(
      sorted([
        ['contact.updated', asha, ['name']],
        ['contact.updated', bala, ['fields.score']],
        ['contact.updated', asha, ['fields.city']],
      ]),
    );
    expect(sentTo(band.path)).toEqual(
      sorted([
        ['contact.updated', bala, ['name']],
        ['contact.updated', bala, ['fields.score']],
      ]),
    );
    expect(sentTo(october.path)).toEqual(
      sorted([
        ['contact.updated', asha, ['name']],
        ['contact.updated', asha, ['fields.city']],
      ]),
    );
    expect(sentTo(untilMidNovember.path)).toEqual(
      sorted([
        ['contact.updated', asha, ['name']],
        ['contact.updated', asha, ['fields.city']],
      ]),
    );
    expect(sentTo(mixed.path)).toEqual(
      sorted([
        ['contact.updated', bala, ['fields.score']],
        ['contact.updated', asha, ['fields.city']],
      ]),
    );
    // Added with a score of 12, Asha is sent as added; Bala, at 3, is not.
    expect(sentTo(addedHigh.path)).toEqual([['contact.created', asha, null]]);
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

  it('sends an endpoint that names why runs ended only those runs of the ends it names reasons of, the runs of its other ends all, and captures no end nobody takes (ADR-192)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await publishAutomation(owner, 'Brochure', keyword('brochure'), sayGraph('Here it is.'));
    await publishAutomation(owner, 'Farewell', keyword('farewell'), {
      version: 1,
      start: 'say',
      nodes: [
        { id: 'say', type: 'send_text', text: 'Goodbye.', next: 'bye' },
        { id: 'bye', type: 'end' },
      ],
    });
    const endpointFor = async (runEndStatuses: string[] | null, runEndReasons: string[]) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes: ['automation.run_ended'],
        runEndStatuses,
        runEndReasons,
      });
      return { ...created, path };
    };
    // Every end; completions at an End step and every other end; failures to send only; and
    // completions with nothing next, failures for age only.
    const everyEnd = await addEndpoint(c, ['automation.run_ended']);
    const atEndSteps = await endpointFor(null, ['end_node']);
    const blocked = await endpointFor(['failed'], ['send_blocked']);
    const nothingNextOrOld = await endpointFor(['completed', 'failed'], ['no_next', 'expired']);
    const runOf = async (text: string, clock: Clock = systemClock) => {
      const { conversation_id: conversationId } = await inbound(c, waId(), text);
      const [run] = await runsIn(conversationId);
      if (!run) throw new Error(`no run started by “${text}”`);
      expect(await driveRun(c, run.id, clock)).toBe('ended');
      return run.id;
    };
    const nothingNext = await runOf('brochure');
    const atEnd = await runOf('farewell');
    // A day later the customer's window has closed: the text cannot be sent and the run fails.
    const failed = await runOf('brochure', { now: () => new Date(Date.now() + 25 * 3600_000) });
    expect(
      (await eventsOf(c, 'automation.')).map((e) => [
        e.detail.runId,
        e.status,
        e.detail.endReason,
        e.deliveries,
      ]),
    ).toEqual([
      [nothingNext, 'completed', 'no_next', 2],
      [atEnd, 'completed', 'end_node', 2],
      [failed, 'failed', 'send_blocked', 3],
    ]);

    await deliverDue(c);
    const endsAt = (path: string) =>
      bodiesAt(path)
        .map((b) => {
          const { run } = automationRunEndedPayloadSchema.parse(b).data;
          return [run.id, run.status, run.endReason];
        })
        .sort();
    expect(endsAt(everyEnd.path)).toEqual(
      [
        [nothingNext, 'completed', 'no_next'],
        [atEnd, 'completed', 'end_node'],
        [failed, 'failed', 'send_blocked'],
      ].sort(),
    );
    // A failure is an end the list names no reason of: it is sent with the End steps.
    expect(endsAt(atEndSteps.path)).toEqual(
      [
        [atEnd, 'completed', 'end_node'],
        [failed, 'failed', 'send_blocked'],
      ].sort(),
    );
    expect(endsAt(blocked.path)).toEqual([[failed, 'failed', 'send_blocked']]);
    expect(endsAt(nothingNextOrOld.path)).toEqual([[nothingNext, 'completed', 'no_next']]);

    // With every end and the End steps turned off, no endpoint takes a completion at an End step:
    // the next one is not captured.
    await webhooks().setEnabled(owner, { endpointId: everyEnd.id, enabled: false });
    await webhooks().setEnabled(owner, { endpointId: atEndSteps.id, enabled: false });
    const later = await runOf('farewell');
    expect((await eventsOf(c, 'automation.')).filter((e) => e.detail.runId === later)).toEqual([]);
  });

  it('sends an endpoint that names what started the runs only those runs, others every run, and captures no run event nobody takes (ADR-183)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await publishAutomation(owner, 'Brochure', keyword('brochure'), sayGraph('Here it is.'));
    await publishAutomation(
      owner,
      'Welcome',
      { type: 'conversation_started', hours: 'any', cooldownMinutes: 0 },
      sayGraph('Welcome!'),
    );
    // Both events of keyword runs only; the start of every run.
    const keywords = await addEndpoint(
      c,
      ['automation.run_started', 'automation.run_ended'],
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      ['keyword'],
    );
    const everyStart = await addEndpoint(c, ['automation.run_started']);
    const runOf = async (text: string) => {
      const { conversation_id: conversationId } = await inbound(c, waId(), text);
      const [run] = await runsIn(conversationId);
      if (!run) throw new Error(`no run started by “${text}”`);
      expect(await driveRun(c, run.id)).toBe('ended');
      return run.id;
    };
    // A keyword in a new conversation starts Brochure; a greeting starts Welcome.
    const brochure = await runOf('Send the brochure');
    const welcome = await runOf('Good morning');
    // Welcome's end is taken by no endpoint, so it is not captured; what started a run is not
    // stored with its events.
    const events = await eventsOf(c, 'automation.');
    expect(events.map((e) => [e.type, e.detail.runId, e.deliveries])).toEqual([
      ['automation.run_started', brochure, 2],
      ['automation.run_ended', brochure, 1],
      ['automation.run_started', welcome, 1],
    ]);
    for (const event of events) expect(event.detail).not.toHaveProperty('runTrigger');

    await deliverDue(c);
    const runsAt = (path: string) =>
      bodiesAt(path)
        .map((b) => {
          const { run } = (
            b.type === 'automation.run_started'
              ? automationRunStartedPayloadSchema
              : automationRunEndedPayloadSchema
          ).parse(b).data;
          return [b.type, run.id, run.trigger];
        })
        .sort();
    expect(runsAt(keywords.path)).toEqual(
      [
        ['automation.run_ended', brochure, 'keyword'],
        ['automation.run_started', brochure, 'keyword'],
      ].sort(),
    );
    expect(runsAt(everyStart.path)).toEqual(
      [
        ['automation.run_started', brochure, 'keyword'],
        ['automation.run_started', welcome, 'conversation_started'],
      ].sort(),
    );
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

  it('sends an endpoint that names API keys the runs they started, across rotations either way, and no run started otherwise (ADR-319)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const templateId = await approvedTemplate(c, {
      category: 'UTILITY',
      header: { type: 'none' },
      body: { text: 'Hi {{1}}, your order {{2}} has shipped.', examples: ['Asha', 'A-1001'] },
      footer: null,
      buttons: [],
    });
    // The runs wait an hour before they send, so they can be stopped meanwhile.
    const automationId = await publishAutomation(
      owner,
      'Shipping update',
      { type: 'api', inputs: ['first_name', 'order'] },
      {
        version: 1,
        start: 'pause',
        nodes: [
          { id: 'pause', type: 'wait', minutes: 60, next: 'shipped' },
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
    const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
    const keyCtx = async (token: string) => {
      const ctx = await authenticateApiToken(fx.dbs.app, token, uuidv7());
      if (!ctx) throw new Error('a key does not authenticate');
      return ctx;
    };
    const first = await keys.create(owner, {
      name: 'Store',
      scopes: ['automations.start'],
      expiresInDays: 0,
    });
    const crm = await keys.create(owner, {
      name: 'CRM',
      scopes: ['automations.start'],
      expiresInDays: 0,
    });
    const add = async (runApiKeyIds: string[] | null) =>
      (
        await webhooks().create(owner, {
          url: `http://${HOST}:${port}/ok/${randomBytes(6).toString('hex')}`,
          eventTypes: ['automation.run_started', 'automation.run_ended'],
          runApiKeyIds,
        })
      ).id;
    const every = await add(null);
    const byFirst = await add([first.id]);
    const byCrm = await add([crm.id]);
    // The store's key is rotated twice; the older keys keep working for a day. An endpoint names
    // the latest.
    const second = await keys.rotate(owner, { keyId: first.id, overlapHours: 24 });
    const latest = await keys.rotate(owner, { keyId: second.id, overlapHours: 24 });
    const byLatest = await add([latest.id]);
    const deps = { db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer };
    let n = 0;
    const start = async (token: string) => {
      n += 1;
      const answer = await apiStartAutomationRun(
        deps,
        await keyCtx(token),
        automationId,
        { to: `+91 98111 0${1200 + n}`, inputs: { first_name: 'Asha', order: `A-${n}` } },
        { key: `run-keys-${n}`, requestHash: sha256Hex(`run-keys-${n}`) },
      );
      const runId = (answer.body.data as { id: string }).id;
      expect(await driveRun(c, runId)).toBe('waiting');
      return runId;
    };
    const byFirstKey = await start(first.token);
    const byLatestKey = await start(latest.token);
    const byCrmKey = await start(crm.token);
    // A run a keyword started belongs to no key.
    await publishAutomation(owner, 'Brochure', keyword('brochure'), sayGraph('Here it is.'));
    const [byKeyword] = await runsIn((await inbound(c, waId(), 'brochure')).conversation_id);
    if (!byKeyword) throw new Error('no run started');
    // A key stops two runs as the runtime role; erasure stops the third inside its definer
    // function, which reads the keys too.
    await apiStopAutomationRun(deps, await keyCtx(crm.token), byCrmKey);
    await apiStopAutomationRun(deps, await keyCtx(latest.token), byLatestKey);
    const [run] = await fx.query<{ contact_id: string }>(
      'SELECT contact_id FROM app.automation_runs WHERE id = $1',
      [byFirstKey],
    );
    if (!run) throw new Error('no run');
    await contactsService().eraseContact(owner, { contactId: run.contact_id, suppress: false });
    expect(
      (
        await fx.query<{ status: string; end_reason: string }>(
          'SELECT status, end_reason FROM app.automation_runs WHERE id = $1',
          [byFirstKey],
        )
      )[0],
    ).toEqual({ status: 'stopped', end_reason: 'contact_erased' });

    const sent = await fx.query<{
      type: string;
      run: string;
      endpoint: string;
      detail: Record<string, unknown>;
    }>(
      `SELECT e.type, e.detail ->> 'runId' AS run, d.endpoint_id AS endpoint, e.detail
         FROM app.webhook_deliveries d
         JOIN app.webhook_events e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
        WHERE d.tenant_id = $1 AND e.type LIKE 'automation.%'`,
      [c.tenant.id],
    );
    const endpointName = new Map([
      [every, 'every run'],
      [byFirst, 'first key'],
      [byCrm, 'crm key'],
      [byLatest, 'latest key'],
    ]);
    const runName = new Map([
      [byFirstKey, 'first'],
      [byLatestKey, 'latest'],
      [byCrmKey, 'crm'],
      [byKeyword.id, 'keyword'],
    ]);
    const sorted = (rows: unknown[][]) =>
      [...rows].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    expect(
      sorted(sent.map((s) => [s.type, runName.get(s.run), endpointName.get(s.endpoint)])),
    ).toEqual(
      sorted([
        // The first key's run reaches the list naming the key it was rotated into, twice over…
        ['automation.run_started', 'first', 'every run'],
        ['automation.run_started', 'first', 'first key'],
        ['automation.run_started', 'first', 'latest key'],
        ['automation.run_ended', 'first', 'every run'],
        ['automation.run_ended', 'first', 'first key'],
        ['automation.run_ended', 'first', 'latest key'],
        // …and the latest key's the list naming the key it replaced, twice over.
        ['automation.run_started', 'latest', 'every run'],
        ['automation.run_started', 'latest', 'first key'],
        ['automation.run_started', 'latest', 'latest key'],
        ['automation.run_ended', 'latest', 'every run'],
        ['automation.run_ended', 'latest', 'first key'],
        ['automation.run_ended', 'latest', 'latest key'],
        ['automation.run_started', 'crm', 'every run'],
        ['automation.run_started', 'crm', 'crm key'],
        ['automation.run_ended', 'crm', 'every run'],
        ['automation.run_ended', 'crm', 'crm key'],
        ['automation.run_started', 'keyword', 'every run'],
      ]),
    );
    // The key travels for the filter only: the payload reads it from the run.
    expect(sent.filter((s) => 'apiKeyId' in s.detail)).toEqual([]);
  });

  /** The steps a run's log holds, in their order. */
  const stepsOf = (runId: string) =>
    fx.query<{
      id: string;
      seq: number;
      node_type: string | null;
      outcome: string;
      message_id: string | null;
      detail: string | null;
    }>(
      `SELECT id, seq, node_type, outcome, message_id, detail FROM app.automation_run_steps
        WHERE run_id = $1 ORDER BY seq`,
      [runId],
    );

  it('sends each step of a live run to the endpoints that take steps, never its detail or branch, and nothing for a member’s test run (ADR-326)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const steps = await addEndpoint(c, ['automation.run_step']);
    const runsOnly = await addEndpoint(c, ['automation.run_started', 'automation.run_ended']);
    const automationId = await publishAutomation(
      owner,
      'Brochure',
      keyword('brochure'),
      sayGraph('Here is our brochure.'),
    );
    const { conversation_id: conversationId, contact_id: contactId } = await inbound(
      c,
      waId(),
      'brochure please',
    );
    const [run] = await runsIn(conversationId);
    if (!run) throw new Error('no run started');
    expect(await driveRun(c, run.id)).toBe('ended');
    // The log starts with the run's start, outside a node, and holds the message it sent.
    const logged = await stepsOf(run.id);
    expect(logged[0]).toMatchObject({ seq: 0, node_type: null, outcome: 'started' });
    const said = logged.find((step) => step.outcome === 'sent');
    expect(said).toMatchObject({ node_type: 'send_text' });
    expect(said?.message_id).toEqual(expect.any(String));
    // One event for each step, its outcome as the status, delivered to the endpoint taking steps
    // only; the run's number and what started it travel for the filters only.
    const stepEvents = (await eventsOf(c, 'automation.')).filter(
      (e) => e.type === 'automation.run_step',
    );
    const byStep = (rows: unknown[][]) =>
      [...rows].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    expect(
      byStep(
        stepEvents.map((e) => [e.detail, e.status, e.conversation_id, e.contact_id, e.deliveries]),
      ),
    ).toEqual(
      byStep(
        logged.map((step) => [
          { stepId: step.id, runId: run.id, automationId },
          step.outcome,
          conversationId,
          contactId,
          1,
        ]),
      ),
    );

    await deliverDue(c);
    const raw = bodiesAt(steps.path);
    expect(raw.map((b) => b.type)).toEqual(logged.map(() => 'automation.run_step'));
    // The body has no field for a step's detail or branch.
    for (const body of raw) {
      expect(Object.keys(body.data)).toEqual(['run', 'step', 'conversation', 'contact', 'channel']);
      expect(Object.keys(body.data.step as object)).toEqual([
        'number',
        'nodeType',
        'outcome',
        'messageId',
      ]);
    }
    const person = await personOf(contactId);
    const bodies = raw
      .map((b) => automationRunStepPayloadSchema.parse(b))
      .sort((x, y) => x.data.step.number - y.data.step.number);
    expect(bodies.map((b) => b.data.step)).toEqual(
      logged.map((step) => ({
        number: step.seq,
        nodeType: step.node_type,
        outcome: step.outcome,
        messageId: step.message_id,
      })),
    );
    for (const body of bodies) {
      expect(body.data).toMatchObject({
        run: {
          id: run.id,
          automationId,
          automationName: 'Brochure',
          trigger: 'keyword',
          apiKeyId: null,
          startedAt: run.started_at.toISOString(),
        },
        conversation: { id: conversationId },
        contact: { id: contactId, phone: person.phone_e164, name: person.display_name },
        channel: { id: c.channelAccountId, phone: '+91 90000 00000' },
      });
    }
    expect(
      bodiesAt(runsOnly.path)
        .map((b) => b.type)
        .sort(),
    ).toEqual(['automation.run_ended', 'automation.run_started']);

    // A member's test run of a draft, in the same conversation, records steps but sends none.
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
    expect((await stepsOf(testRunId)).length).toBeGreaterThan(1);
    expect(
      (await eventsOf(c, 'automation.')).filter((e) => e.type === 'automation.run_step'),
    ).toHaveLength(logged.length);
  });

  it('sends an endpoint that names automations, numbers, what started the runs or API keys only those runs’ steps (ADR-326)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const outlet = await fx.addNumber(c, { phone: '+91 90000 54321' });
    const templateId = await approvedTemplate(c, {
      category: 'UTILITY',
      header: { type: 'none' },
      body: { text: 'Hi {{1}}, your order {{2}} has shipped.', examples: ['Asha', 'A-1001'] },
      footer: null,
      buttons: [],
    });
    // Two keyword automations for every number, and one the API starts on the main number.
    const greeter = await publishAutomation(
      owner,
      'Greeter',
      keyword('hello'),
      sayGraph('Hello there.'),
    );
    await publishAutomation(owner, 'Farewell', keyword('bye'), sayGraph('Goodbye for now.'));
    const shipping = await publishAutomation(
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
    const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
    const store = await keys.create(owner, {
      name: 'Store',
      scopes: ['automations.start'],
      expiresInDays: 0,
    });
    const crm = await keys.create(owner, {
      name: 'CRM',
      scopes: ['automations.start'],
      expiresInDays: 0,
    });
    // Each endpoint takes the steps only, and names one filter of the run events.
    const add = async (filters: Record<string, string[]>) =>
      (
        await webhooks().create(owner, {
          url: `http://${HOST}:${port}/ok/${randomBytes(6).toString('hex')}`,
          eventTypes: ['automation.run_step'],
          ...filters,
        })
      ).id;
    const endpoints = new Map([
      [await add({}), 'every run'],
      [await add({ automationIds: [greeter] }), 'greeter'],
      [await add({ channelIds: [outlet.channelAccountId] }), 'outlet'],
      [await add({ runTriggers: ['api'] }), 'api'],
      [await add({ runApiKeyIds: [store.id] }), 'store key'],
      [await add({ runApiKeyIds: [crm.id] }), 'crm key'],
    ]);
    const keywordRun = async (at: Company, text: string) => {
      const [run] = await runsIn((await inbound(at, waId(), text)).conversation_id);
      if (!run) throw new Error(`no run started by “${text}”`);
      expect(await driveRun(c, run.id)).toBe('ended');
      return run.id;
    };
    const runs = new Map([
      [await keywordRun(c, 'hello'), 'hello on main'],
      [await keywordRun(c, 'bye'), 'bye on main'],
      [await keywordRun(outlet, 'hello'), 'hello on outlet'],
    ]);
    const ctx = await authenticateApiToken(fx.dbs.app, store.token, uuidv7());
    if (!ctx) throw new Error('a new key does not authenticate');
    const answer = await apiStartAutomationRun(
      { db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer },
      ctx,
      shipping,
      { to: '+91 98111 00072', inputs: { first_name: 'Asha', order: 'A-1002' } },
      { key: 'ship-steps', requestHash: sha256Hex('ship-steps') },
    );
    const apiRun = (answer.body.data as { id: string }).id;
    expect(await driveRun(c, apiRun)).toBe('ended');
    runs.set(apiRun, 'api');

    const sent = await fx.query<{
      run: string;
      endpoint: string;
      steps: number;
    }>(
      `SELECT e.detail ->> 'runId' AS run, d.endpoint_id AS endpoint, count(*)::int AS steps
         FROM app.webhook_deliveries d
         JOIN app.webhook_events e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
        WHERE d.tenant_id = $1 AND e.type = 'automation.run_step'
        GROUP BY 1, 2`,
      [c.tenant.id],
    );
    const counts = new Map<string, number>();
    for (const [runId, name] of runs) counts.set(name, (await stepsOf(runId)).length);
    const sorted = (rows: unknown[][]) =>
      [...rows].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    const each = (name: string, endpoint: string) => [name, endpoint, counts.get(name)];
    // Every step of a run reaches the endpoints whose filters the run passes, and no other.
    expect(sorted(sent.map((s) => [runs.get(s.run), endpoints.get(s.endpoint), s.steps]))).toEqual(
      sorted([
        each('hello on main', 'every run'),
        each('hello on main', 'greeter'),
        each('bye on main', 'every run'),
        each('hello on outlet', 'every run'),
        each('hello on outlet', 'greeter'),
        each('hello on outlet', 'outlet'),
        each('api', 'every run'),
        each('api', 'api'),
        each('api', 'store key'),
      ]),
    );
    // The run's key, number and what started it travel for the filters only.
    const stored = await fx.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM app.webhook_events WHERE tenant_id = $1 AND type = 'automation.run_step'`,
      [c.tenant.id],
    );
    for (const { detail } of stored) {
      expect(Object.keys(detail).sort()).toEqual(['automationId', 'runId', 'stepId']);
    }

    // The API run's steps name the key that started it.
    await deliverDue(c);
    const apiSteps = received
      .map((r) => JSON.parse(r.body) as { type: string; data: { run?: { id?: string } } })
      .filter((b) => b.type === 'automation.run_step' && b.data.run?.id === apiRun)
      .map((b) => automationRunStepPayloadSchema.parse(b));
    expect(apiSteps).toHaveLength(3 * (counts.get('api') ?? 0));
    for (const body of apiSteps) {
      expect(body.data.run).toMatchObject({
        automationName: 'Shipping update',
        trigger: 'api',
        apiKeyId: store.id,
      });
    }
    expect(apiSteps.map((b) => b.data.step.nodeType)).toContain('send_template');
  });

  it('sends an endpoint that names step outcomes only the steps with them, and captures no step nobody takes (ADR-327)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await publishAutomation(owner, 'Brochure', keyword('brochure'), sayGraph('Here it is.'));
    const add = async (runStepOutcomes: string[] | null) =>
      (
        await webhooks().create(owner, {
          url: `http://${HOST}:${port}/ok/${randomBytes(6).toString('hex')}`,
          eventTypes: ['automation.run_step'],
          runStepOutcomes,
        })
      ).id;
    const lists = new Map<string, string[] | null>([
      ['every step', null],
      ['failures', ['failed']],
      ['sends', ['sent']],
      ['starts and failures', ['started', 'failed']],
    ]);
    const endpoints = new Map<string, string>();
    for (const [name, list] of lists) endpoints.set(await add(list), name);
    const run = async (clock: Clock = systemClock) => {
      const [started] = await runsIn((await inbound(c, waId(), 'brochure')).conversation_id);
      if (!started) throw new Error('no run started');
      expect(await driveRun(c, started.id, clock)).toBe('ended');
      return started.id;
    };
    const sent = await run();
    // A day later the customer's window has closed: the text cannot be sent and the run fails.
    const failed = await run({ now: () => new Date(Date.now() + 25 * 3600_000) });
    const runs = new Map([
      [sent, 'sent'],
      [failed, 'failed'],
    ]);
    const logged = new Map<string, string[]>();
    for (const [runId, name] of runs) {
      logged.set(
        name,
        (await stepsOf(runId)).map((step) => step.outcome),
      );
    }
    expect(logged.get('sent')).toContain('sent');
    expect(logged.get('failed')).toContain('failed');

    const delivered = await fx.query<{ run: string; endpoint: string; outcome: string }>(
      `SELECT e.detail ->> 'runId' AS run, d.endpoint_id AS endpoint, e.status AS outcome
         FROM app.webhook_deliveries d
         JOIN app.webhook_events e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
        WHERE d.tenant_id = $1 AND e.type = 'automation.run_step'`,
      [c.tenant.id],
    );
    const sorted = (rows: unknown[][]) =>
      [...rows].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    // Each step reaches the endpoints whose list is null or holds its outcome, and no other.
    const expected: unknown[][] = [];
    for (const [runName, outcomes] of logged) {
      for (const outcome of outcomes) {
        for (const [endpoint, list] of lists) {
          if (!list || list.includes(outcome)) expected.push([runName, endpoint, outcome]);
        }
      }
    }
    expect(
      sorted(delivered.map((d) => [runs.get(d.run), endpoints.get(d.endpoint), d.outcome])),
    ).toEqual(sorted(expected));

    // With the endpoint for every step and the one for starts turned off, a run's start is taken by
    // no endpoint and is not recorded; its message still is.
    const idOf = (name: string) => [...endpoints].find(([, n]) => n === name)?.[0] ?? '';
    await webhooks().setEnabled(owner, { endpointId: idOf('every step'), enabled: false });
    await webhooks().setEnabled(owner, { endpointId: idOf('starts and failures'), enabled: false });
    const quiet = await run();
    const recorded = await fx.query<{ status: string }>(
      `SELECT status FROM app.webhook_events
        WHERE tenant_id = $1 AND type = 'automation.run_step' AND detail ->> 'runId' = $2`,
      [c.tenant.id, quiet],
    );
    expect(recorded.map((r) => r.status)).toEqual(['sent']);
  });

  it('sends an endpoint that names kinds of step only the steps of those nodes, the steps outside a node only to a list naming them, and with outcomes chosen too only the steps passing both (ADR-328)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await publishAutomation(owner, 'Brochure', keyword('brochure'), sayGraph('Here it is.'));
    const add = async (filters: {
      runStepNodeTypes: string[] | null;
      runStepOutcomes?: string[];
    }) =>
      (
        await webhooks().create(owner, {
          url: `http://${HOST}:${port}/ok/${randomBytes(6).toString('hex')}`,
          eventTypes: ['automation.run_step'],
          ...filters,
        })
      ).id;
    // Every kind of node but the steps outside one: what null takes, less the runs' starts.
    const everyNode = [
      'send_text',
      'ask_buttons',
      'ask_text',
      'send_template',
      'ask_template',
      'send_flow',
      'condition',
      'update_contact',
      'update_conversation',
      'http_request',
      'create_task',
      'create_deal',
      'move_deal',
      'close_deal',
      'wait',
      'handoff',
      'end',
    ];
    const lists = new Map<string, { nodes: string[] | null; outcomes: string[] | null }>([
      ['every step', { nodes: null, outcomes: null }],
      ['messages', { nodes: ['send_text'], outcomes: null }],
      ['conditions', { nodes: ['condition'], outcomes: null }],
      ['failed messages', { nodes: ['send_text'], outcomes: ['failed'] }],
      ['outside a node', { nodes: ['outside_node'], outcomes: null }],
      ['every node', { nodes: everyNode, outcomes: null }],
    ]);
    const endpoints = new Map<string, string>();
    for (const [name, list] of lists) {
      endpoints.set(
        await add({
          runStepNodeTypes: list.nodes,
          ...(list.outcomes ? { runStepOutcomes: list.outcomes } : {}),
        }),
        name,
      );
    }
    const run = async (clock: Clock = systemClock) => {
      const [started] = await runsIn((await inbound(c, waId(), 'brochure')).conversation_id);
      if (!started) throw new Error('no run started');
      expect(await driveRun(c, started.id, clock)).toBe('ended');
      return started.id;
    };
    const sent = await run();
    // A day later the customer's window has closed: the text cannot be sent and the run fails.
    const failed = await run({ now: () => new Date(Date.now() + 25 * 3600_000) });
    const runs = new Map([
      [sent, 'sent'],
      [failed, 'failed'],
    ]);
    const logged = new Map<string, { node: string | null; outcome: string }[]>();
    for (const [runId, name] of runs) {
      logged.set(
        name,
        (await stepsOf(runId)).map((step) => ({ node: step.node_type, outcome: step.outcome })),
      );
    }
    // Each run starts outside a node, then runs its message node: sent, or failed.
    expect(logged.get('sent')).toEqual(
      expect.arrayContaining([
        { node: null, outcome: 'started' },
        { node: 'send_text', outcome: 'sent' },
      ]),
    );
    expect(logged.get('failed')).toEqual(
      expect.arrayContaining([
        { node: null, outcome: 'started' },
        { node: 'send_text', outcome: 'failed' },
      ]),
    );

    const delivered = await fx.query<{ run: string; endpoint: string; outcome: string }>(
      `SELECT e.detail ->> 'runId' AS run, d.endpoint_id AS endpoint, e.status AS outcome
         FROM app.webhook_deliveries d
         JOIN app.webhook_events e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
        WHERE d.tenant_id = $1 AND e.type = 'automation.run_step'`,
      [c.tenant.id],
    );
    const sorted = (rows: unknown[][]) =>
      [...rows].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    // A step reaches the endpoints whose kinds are null or hold its node (outside_node for a step
    // outside a node) and whose outcomes are null or hold its outcome.
    const expected: unknown[][] = [];
    for (const [runName, steps] of logged) {
      for (const step of steps) {
        for (const [endpoint, list] of lists) {
          const node = !list.nodes || list.nodes.includes(step.node ?? 'outside_node');
          const outcome = !list.outcomes || list.outcomes.includes(step.outcome);
          if (node && outcome) expected.push([runName, endpoint, step.outcome]);
        }
      }
    }
    expect(
      sorted(delivered.map((d) => [runs.get(d.run), endpoints.get(d.endpoint), d.outcome])),
    ).toEqual(sorted(expected));
    // The kind travels for the filter only: the payload reads it from the step.
    const stored = await fx.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM app.webhook_events WHERE tenant_id = $1 AND type = 'automation.run_step'`,
      [c.tenant.id],
    );
    for (const { detail } of stored) {
      expect(Object.keys(detail).sort()).toEqual(['automationId', 'runId', 'stepId']);
    }
    // Delivered, a step gives its kind of node, null for the run's start.
    await deliverDue(c);
    const bodies = received
      .map((r) => JSON.parse(r.body) as { type: string; data: { run?: { id?: string } } })
      .filter((b) => b.type === 'automation.run_step' && runs.has(b.data.run?.id ?? ''))
      .map((b) => automationRunStepPayloadSchema.parse(b));
    expect(bodies).toHaveLength(expected.length);
    expect(
      sorted(
        bodies.map((b) => [runs.get(b.data.run.id), b.data.step.nodeType, b.data.step.outcome]),
      ),
    ).toEqual(
      sorted(
        delivered.map((d) => {
          const step = logged.get(runs.get(d.run) ?? '')?.find((s) => s.outcome === d.outcome);
          return [runs.get(d.run), step?.node ?? null, d.outcome];
        }),
      ),
    );
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

    // One event per change, each to the endpoints that take its type, naming who made the change
    // (ADR-270): the member, then Razorpay's payment through the link, then the member again.
    const events = await eventsOf(c, 'order.');
    const change = (previousStatus: string, changedBy: string) => ({
      orderId: order.id,
      previousStatus,
      changedBy,
      apiKeyId: null,
    });
    expect(events.map((e) => [e.type, e.status, e.detail, e.deliveries])).toEqual([
      ['order.received', 'received', { orderId: order.id }, 1],
      ['order.status_changed', 'confirmed', change('received', 'member'), 2],
      ['order.status_changed', 'awaiting_payment', change('confirmed', 'member'), 2],
      ['order.status_changed', 'paid', change('awaiting_payment', 'payment_link'), 2],
      ['order.status_changed', 'fulfilled', change('paid', 'member'), 2],
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
        const { status, previousStatus, changedBy, apiKeyId } = b.data.order as Record<
          string,
          unknown
        >;
        return [status, previousStatus, changedBy, apiKeyId];
      }),
    ).toEqual([
      ['confirmed', 'received', 'member', null],
      ['awaiting_payment', 'confirmed', 'member', null],
      ['paid', 'awaiting_payment', 'payment_link', null],
      ['fulfilled', 'paid', 'member', null],
    ]);
    expect(bodies[0]!.data.order).toMatchObject({ changedBy: null, apiKeyId: null });
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

  it('sends each Payment Link status the worker writes, with the link as the API reads it, to the endpoints of its order’s number (ADR-285)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const outlet = await fx.addNumber(c, { phone: '+91 90000 54322' });
    await syncedCatalog(c, '5558580');
    const links = await addEndpoint(c, ['payment_link.status_changed']);
    const onOutlet = await addNumberEndpoint(
      c,
      ['payment_link.status_changed'],
      [outlet.channelAccountId],
    );
    const ordersOnly = await addEndpoint(c, ['order.status_changed']);

    // The company's Razorpay account, checked.
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

    // A member asks for payment of a ₹30 cart: the worker creates the link and sends it in the
    // chat; the customer pays.
    const order = await sendCart(c, waId(), '5558580', [
      { retailerId: 'sku-1', quantity: 3, price: 10 },
    ]);
    const { linkId } = await commerce().requestPayment(agent, {
      id: order.id,
      expectedVersion: await orderVersion(order.id),
    });
    expect(await processPaymentLink(commerceWorker(), scopeOf(c), linkId)).toBe('done');
    const [created] = await fx.query<{
      provider_link_id: string;
      message_id: string;
      short_url: string;
      reference: string;
    }>(
      'SELECT provider_link_id, message_id, short_url, reference FROM app.commerce_payment_links WHERE id = $1',
      [linkId],
    );
    rzp.payLink(created!.provider_link_id);
    expect(await processPaymentLink(commerceWorker(), scopeOf(c), linkId)).toBe('done');

    // A second cart's link is cancelled at the member's request.
    const second = await sendCart(c, waId(), '5558580', [
      { retailerId: 'sku-2', quantity: 1, price: 20 },
    ]);
    const { linkId: cancelledId } = await commerce().requestPayment(agent, {
      id: second.id,
      expectedVersion: await orderVersion(second.id),
    });
    expect(await processPaymentLink(commerceWorker(), scopeOf(c), cancelledId)).toBe('done');
    await commerce().cancelPaymentLink(agent, { orderId: second.id });
    expect(await processPaymentLink(commerceWorker(), scopeOf(c), cancelledId)).toBe('done');

    // One event per status the worker wrote, on the order's conversation and contact: asking for
    // payment and asking to cancel send none of their own.
    const events = await eventsOf(c, 'payment_link.');
    const change = (paymentLinkId: string, orderId: string, previousStatus: string) => ({
      paymentLinkId,
      orderId,
      previousStatus,
    });
    expect(events.map((e) => [e.status, e.detail, e.deliveries])).toEqual([
      ['created', change(linkId, order.id, 'creating'), 1],
      ['paid', change(linkId, order.id, 'created'), 1],
      ['created', change(cancelledId, second.id, 'creating'), 1],
      ['cancelled', change(cancelledId, second.id, 'created'), 1],
    ]);
    expect(events.map((e) => [e.conversation_id, e.contact_id])).toEqual([
      [order.conversation_id, order.contact_id],
      [order.conversation_id, order.contact_id],
      [second.conversation_id, second.contact_id],
      [second.conversation_id, second.contact_id],
    ]);

    await deliverDue(c);
    const bodies = bodiesAt(links.path);
    expect(bodies.map((b) => b.id)).toEqual(events.map((e) => e.id));
    for (const body of bodies) {
      expect(paymentLinkStatusChangedPayloadSchema.safeParse(body).success).toBe(true);
    }
    // The status and the one before it as captured; the rest as the link is when delivered.
    expect(
      bodies.map((b) => {
        const link = b.data.paymentLink as Record<string, unknown>;
        return [link.id, link.status, link.previousStatus, link.cancelRequestedAt !== null];
      }),
    ).toEqual([
      [linkId, 'created', 'creating', false],
      [linkId, 'paid', 'created', false],
      [cancelledId, 'created', 'creating', true],
      [cancelledId, 'cancelled', 'created', true],
    ]);
    expect(bodies[0]!.data).toMatchObject({
      paymentLink: {
        orderId: order.id,
        amountMinor: 3000,
        amountPaidMinor: 3000,
        currency: 'INR',
        paidAt: expect.any(String),
        messageId: created!.message_id,
        notSentReason: null,
        error: null,
        requestedBy: 'member',
        requestedByApiKeyId: null,
      },
      order: { id: order.id, reference: order.reference, status: 'paid' },
      conversation: { id: order.conversation_id },
      contact: { id: order.contact_id },
      channel: { id: c.channelAccountId },
    });
    expect(bodies[2]!.data.order).toEqual({
      id: second.id,
      reference: second.reference,
      status: 'confirmed',
    });
    // Never the link's address or Razorpay's ids.
    const sent = JSON.stringify(bodies);
    for (const hidden of [created!.short_url, created!.provider_link_id, created!.reference]) {
      expect(sent).not.toContain(hidden);
    }
    // The outlet's endpoint hears none of the first number's links, and an endpoint for orders
    // hears their statuses only.
    expect(bodiesAt(onOutlet.path)).toEqual([]);
    expect(new Set(bodiesAt(ordersOnly.path).map((b) => b.type))).toEqual(
      new Set(['order.status_changed']),
    );
  });

  it('sends an endpoint that names Payment Link statuses only the links that reached one of them (ADR-308)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await syncedCatalog(c, '5558590');
    /** An endpoint of the company taking the links' events with these statuses. */
    const add = async (paymentLinkStatuses: string[] | null) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes: ['payment_link.status_changed'],
        paymentLinkStatuses,
      });
      return path;
    };
    const paidOnly = await add(['paid']);
    const endings = await add(['expired', 'cancelled', 'failed']);
    const everyStatus = await add(null);

    // The company's Razorpay account, checked.
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

    // A link created and paid, and another created and then cancelled.
    const order = await sendCart(c, waId(), '5558590', [
      { retailerId: 'sku-1', quantity: 1, price: 10 },
    ]);
    const { linkId } = await commerce().requestPayment(agent, {
      id: order.id,
      expectedVersion: await orderVersion(order.id),
    });
    expect(await processPaymentLink(commerceWorker(), scopeOf(c), linkId)).toBe('done');
    const [created] = await fx.query<{ provider_link_id: string }>(
      'SELECT provider_link_id FROM app.commerce_payment_links WHERE id = $1',
      [linkId],
    );
    rzp.payLink(created!.provider_link_id);
    expect(await processPaymentLink(commerceWorker(), scopeOf(c), linkId)).toBe('done');
    const second = await sendCart(c, waId(), '5558590', [
      { retailerId: 'sku-2', quantity: 1, price: 20 },
    ]);
    const { linkId: cancelledId } = await commerce().requestPayment(agent, {
      id: second.id,
      expectedVersion: await orderVersion(second.id),
    });
    expect(await processPaymentLink(commerceWorker(), scopeOf(c), cancelledId)).toBe('done');
    await commerce().cancelPaymentLink(agent, { orderId: second.id });
    expect(await processPaymentLink(commerceWorker(), scopeOf(c), cancelledId)).toBe('done');

    // Each status captured once, with a delivery to each endpoint whose list holds it.
    const events = await eventsOf(c, 'payment_link.');
    expect(events.map((e) => [e.status, e.deliveries])).toEqual([
      ['created', 1],
      ['paid', 2],
      ['created', 1],
      ['cancelled', 2],
    ]);
    await deliverDue(c);
    const statusesAt = (path: string) =>
      bodiesAt(path)
        .map((b) => (b.data.paymentLink as { status: string }).status)
        .sort();
    expect(statusesAt(paidOnly)).toEqual(['paid']);
    expect(statusesAt(endings)).toEqual(['cancelled']);
    expect(statusesAt(everyStatus)).toEqual(['cancelled', 'created', 'created', 'paid']);
  });

  it('sends an endpoint that names who made the order changes only theirs, and every change that recorded no maker (ADR-322)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await syncedCatalog(c, '5558591');
    const add = async (orderChangeMakers: string[] | null) =>
      (
        await webhooks().create(owner, {
          url: `http://${HOST}:${port}/ok/${randomBytes(6).toString('hex')}`,
          eventTypes: ['order.received', 'order.status_changed'],
          orderChangeMakers,
        })
      ).id;
    const every = await add(null);
    const members = await add(['member']);
    const notKeys = await add(['member', 'payment_link']);
    const keysOnly = await add(['api']);
    const payments = await add(['payment_link']);
    const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'Order system', scopes: ['orders.write'], expiresInDays: 0 },
    );
    const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    if (!key) throw new Error('the key does not authenticate');
    const apiDeps = { db: fx.dbs.app, clock: systemClock };

    // The first order is confirmed by a member and fulfilled through the API.
    const first = await sendCart(c, waId(), '5558591', [
      { retailerId: 'sku-1', quantity: 1, price: 10 },
    ]);
    await setOrderStatus(owner, first.id, 'confirmed');
    await apiUpdateOrder(apiDeps, key, first.id, { status: 'fulfilled' });
    // The second is confirmed through the API, paid through its Payment Link (as the worker records
    // it), then changed without recording a maker.
    const second = await sendCart(c, waId(), '5558591', [
      { retailerId: 'sku-2', quantity: 1, price: 20 },
    ]);
    await apiUpdateOrder(apiDeps, key, second.id, { status: 'confirmed' });
    await fx.query(
      `UPDATE app.commerce_orders
          SET status = 'paid', status_changed_by = 'payment_link',
              status_changed_by_api_key_id = NULL,
              status_changed_xact = pg_catalog.pg_current_xact_id()
        WHERE id = $1`,
      [second.id],
    );
    await fx.query(`UPDATE app.commerce_orders SET status = 'fulfilled' WHERE id = $1`, [
      second.id,
    ]);

    const sent = await fx.query<{
      type: string;
      order: string;
      status: string;
      maker: string | null;
      endpoint: string;
    }>(
      `SELECT e.type, e.detail ->> 'orderId' AS order, e.status, e.detail ->> 'changedBy' AS maker,
              d.endpoint_id AS endpoint
         FROM app.webhook_deliveries d
         JOIN app.webhook_events e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
        WHERE d.tenant_id = $1`,
      [c.tenant.id],
    );
    const endpointName = new Map([
      [every, 'every change'],
      [members, 'members'],
      [notKeys, 'members and payments'],
      [keysOnly, 'keys'],
      [payments, 'payments'],
    ]);
    const orderName = new Map([
      [first.id, 'first'],
      [second.id, 'second'],
    ]);
    const sorted = (rows: unknown[][]) =>
      [...rows].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    const all = ['every change', 'members', 'members and payments', 'keys', 'payments'];
    const to = (type: string, order: string, status: string, maker: string | null, at: string[]) =>
      at.map((endpoint) => [type, order, status, maker, endpoint]);
    expect(
      sorted(
        sent.map((s) => [
          s.type,
          orderName.get(s.order),
          s.status,
          s.maker,
          endpointName.get(s.endpoint),
        ]),
      ),
    ).toEqual(
      sorted([
        // A new order reaches every endpoint: it has no maker to choose.
        ...to('order.received', 'first', 'received', null, all),
        ...to('order.received', 'second', 'received', null, all),
        ...to('order.status_changed', 'first', 'confirmed', 'member', [
          'every change',
          'members',
          'members and payments',
        ]),
        ...to('order.status_changed', 'first', 'fulfilled', 'api', ['every change', 'keys']),
        ...to('order.status_changed', 'second', 'confirmed', 'api', ['every change', 'keys']),
        ...to('order.status_changed', 'second', 'paid', 'payment_link', [
          'every change',
          'members and payments',
          'payments',
        ]),
        // A change that recorded no maker reaches every endpoint, whoever is listed.
        ...to('order.status_changed', 'second', 'fulfilled', null, all),
      ]),
    );
  });

  it('leaves out of an endpoint the order changes the keys it names made, across a rotation either way, and sends every other change (ADR-323)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await syncedCatalog(c, '5558592');
    const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
    const shop = await keys.create(owner, {
      name: 'Shop',
      scopes: ['orders.write'],
      expiresInDays: 0,
    });
    const erp = await keys.create(owner, {
      name: 'ERP',
      scopes: ['orders.write'],
      expiresInDays: 0,
    });
    const add = async (orderExcludedApiKeyIds: string[] | null) =>
      (
        await webhooks().create(owner, {
          url: `http://${HOST}:${port}/ok/${randomBytes(6).toString('hex')}`,
          eventTypes: ['order.received', 'order.status_changed'],
          orderExcludedApiKeyIds,
        })
      ).id;
    const every = await add(null);
    const notShop = await add([shop.id]);
    const notErp = await add([erp.id]);
    // The shop's key is rotated: the old key works for a day more. An endpoint names the new one.
    const shop2 = await keys.rotate(owner, { keyId: shop.id, overlapHours: 24 });
    const notShop2 = await add([shop2.id]);
    const keyCtx = async (token: string) => {
      const ctx = await authenticateApiToken(fx.dbs.app, token, uuidv7());
      if (!ctx) throw new Error('a key does not authenticate');
      return ctx;
    };
    const apiDeps = { db: fx.dbs.app, clock: systemClock };

    // A member confirms the first order and the old key fulfils it.
    const first = await sendCart(c, waId(), '5558592', [
      { retailerId: 'sku-1', quantity: 1, price: 10 },
    ]);
    await setOrderStatus(owner, first.id, 'confirmed');
    await apiUpdateOrder(apiDeps, await keyCtx(shop.token), first.id, { status: 'fulfilled' });
    // The new key confirms the second and the ERP's key cancels it.
    const second = await sendCart(c, waId(), '5558592', [
      { retailerId: 'sku-2', quantity: 1, price: 20 },
    ]);
    await apiUpdateOrder(apiDeps, await keyCtx(shop2.token), second.id, { status: 'confirmed' });
    await apiUpdateOrder(apiDeps, await keyCtx(erp.token), second.id, { status: 'cancelled' });
    // The third is confirmed by a change that records no maker.
    const third = await sendCart(c, waId(), '5558592', [
      { retailerId: 'sku-1', quantity: 2, price: 10 },
    ]);
    await fx.query(`UPDATE app.commerce_orders SET status = 'confirmed' WHERE id = $1`, [third.id]);

    const sent = await fx.query<{ type: string; order: string; status: string; endpoint: string }>(
      `SELECT e.type, e.detail ->> 'orderId' AS order, e.status, d.endpoint_id AS endpoint
         FROM app.webhook_deliveries d
         JOIN app.webhook_events e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
        WHERE d.tenant_id = $1`,
      [c.tenant.id],
    );
    const endpointName = new Map([
      [every, 'every change'],
      [notShop, 'not the old key'],
      [notErp, 'not the ERP key'],
      [notShop2, 'not the new key'],
    ]);
    const orderName = new Map([
      [first.id, 'first'],
      [second.id, 'second'],
      [third.id, 'third'],
    ]);
    const sorted = (rows: unknown[][]) =>
      [...rows].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    const all = ['every change', 'not the old key', 'not the ERP key', 'not the new key'];
    const to = (type: string, order: string, status: string, endpoints: string[]) =>
      endpoints.map((endpoint) => [type, order, status, endpoint]);
    expect(
      sorted(
        sent.map((s) => [s.type, orderName.get(s.order), s.status, endpointName.get(s.endpoint)]),
      ),
    ).toEqual(
      sorted([
        // New orders, and a member's change, reach every endpoint.
        ...to('order.received', 'first', 'received', all),
        ...to('order.received', 'second', 'received', all),
        ...to('order.received', 'third', 'received', all),
        ...to('order.status_changed', 'first', 'confirmed', all),
        // The old key's change is left out by the lists naming it and the key it was rotated into…
        ...to('order.status_changed', 'first', 'fulfilled', ['every change', 'not the ERP key']),
        // …and the new key's by the lists naming it and the key it replaced.
        ...to('order.status_changed', 'second', 'confirmed', ['every change', 'not the ERP key']),
        ...to('order.status_changed', 'second', 'cancelled', [
          'every change',
          'not the old key',
          'not the new key',
        ]),
        // A change that recorded no maker is left out by no list.
        ...to('order.status_changed', 'third', 'confirmed', all),
      ]),
    );
  });

  it('sends an endpoint that names API keys only the changes of the Payment Links they asked for, across a rotation either way (ADR-324)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await syncedCatalog(c, '5558593');
    const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
    const shop = await keys.create(owner, {
      name: 'Shop',
      scopes: ['orders.request_payment'],
      expiresInDays: 0,
    });
    const billing = await keys.create(owner, {
      name: 'Billing',
      scopes: ['orders.request_payment'],
      expiresInDays: 0,
    });
    const add = async (paymentLinkApiKeyIds: string[] | null) =>
      (
        await webhooks().create(owner, {
          url: `http://${HOST}:${port}/ok/${randomBytes(6).toString('hex')}`,
          eventTypes: ['payment_link.status_changed'],
          paymentLinkApiKeyIds,
        })
      ).id;
    const every = await add(null);
    const byShop = await add([shop.id]);
    const byBilling = await add([billing.id]);

    // The company's Razorpay account, checked.
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
    const keyCtx = async (token: string) => {
      const ctx = await authenticateApiToken(fx.dbs.app, token, uuidv7());
      if (!ctx) throw new Error('a key does not authenticate');
      return ctx;
    };
    const apiDeps = { db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer };
    const linkOf = async (orderId: string) =>
      (
        await fx.query<{ id: string }>(
          'SELECT id FROM app.commerce_payment_links WHERE order_id = $1',
          [orderId],
        )
      )[0]!.id;

    // A member asks for the first order's payment and the shop's key for the second's. The shop's
    // key is then rotated, an endpoint names the new one, the new key asks for the third's and the
    // billing key for the fourth's.
    const first = await sendCart(c, waId(), '5558593', [
      { retailerId: 'sku-1', quantity: 1, price: 10 },
    ]);
    const { linkId: membersLink } = await commerce().requestPayment(agent, {
      id: first.id,
      expectedVersion: await orderVersion(first.id),
    });
    const second = await sendCart(c, waId(), '5558593', [
      { retailerId: 'sku-2', quantity: 1, price: 20 },
    ]);
    await apiRequestOrderPayment(apiDeps, await keyCtx(shop.token), second.id, null);
    const shopsLink = await linkOf(second.id);
    const shop2 = await keys.rotate(owner, { keyId: shop.id, overlapHours: 24 });
    const byShop2 = await add([shop2.id]);
    const third = await sendCart(c, waId(), '5558593', [
      { retailerId: 'sku-1', quantity: 2, price: 10 },
    ]);
    await apiRequestOrderPayment(apiDeps, await keyCtx(shop2.token), third.id, null);
    const newKeysLink = await linkOf(third.id);
    const fourth = await sendCart(c, waId(), '5558593', [
      { retailerId: 'sku-2', quantity: 2, price: 20 },
    ]);
    await apiRequestOrderPayment(apiDeps, await keyCtx(billing.token), fourth.id, null);
    const billingsLink = await linkOf(fourth.id);
    for (const link of [membersLink, shopsLink, newKeysLink, billingsLink]) {
      expect(await processPaymentLink(commerceWorker(), scopeOf(c), link)).toBe('done');
    }

    // Each link created once, delivered to the endpoints whose list holds the key that asked for
    // it or a key it was rotated from or into; a member's link to every-link endpoints only. The
    // key is not stored with the event.
    const sent = await fx.query<{
      link: string;
      endpoint: string;
      detail: Record<string, unknown>;
    }>(
      `SELECT e.detail ->> 'paymentLinkId' AS link, d.endpoint_id AS endpoint, e.detail
         FROM app.webhook_deliveries d
         JOIN app.webhook_events e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
        WHERE d.tenant_id = $1 AND e.type = 'payment_link.status_changed'`,
      [c.tenant.id],
    );
    expect(sent.every((s) => !('apiKeyId' in s.detail))).toBe(true);
    const endpointName = new Map([
      [every, 'every link'],
      [byShop, 'the old key'],
      [byBilling, 'the billing key'],
      [byShop2, 'the new key'],
    ]);
    const linkName = new Map([
      [membersLink, "the member's link"],
      [shopsLink, "the shop's link"],
      [newKeysLink, "the new key's link"],
      [billingsLink, "the billing key's link"],
    ]);
    const sorted = (rows: unknown[][]) =>
      [...rows].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    expect(sorted(sent.map((s) => [linkName.get(s.link), endpointName.get(s.endpoint)]))).toEqual(
      sorted([
        ["the member's link", 'every link'],
        // The old key's link reaches the list naming the key it was rotated into…
        ["the shop's link", 'every link'],
        ["the shop's link", 'the old key'],
        ["the shop's link", 'the new key'],
        // …and the new key's the list naming the key it replaced.
        ["the new key's link", 'every link'],
        ["the new key's link", 'the old key'],
        ["the new key's link", 'the new key'],
        ["the billing key's link", 'every link'],
        ["the billing key's link", 'the billing key'],
      ]),
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
    const deps = {
      db: fx.dbs.app,
      jobs: fx.jobs(),
      signer: fx.signer,
      clock,
      notices: fx.notices(),
    };
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
          {
            db: fx.dbs.app,
            jobs: fx.jobs(),
            signer: fx.signer,
            clock,
            sendRatePerSecond: 100,
            notices: fx.notices(),
          },
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

  it("sends an endpoint that names campaigns only their messages' statuses and their changes, and names the campaign in each message status (ADR-185)", async () => {
    const s = await campaignCompany(1);
    const { c } = s;
    const owner = await fx.ctx(c, c.owner);
    const weekend = await s.draft(owner, 'Weekend sale');
    const monday = await s.draft(owner, 'Monday sale');
    const types: WebhookEventType[] = ['campaign.status_changed', 'message.status'];
    const chosen = await addEndpoint(
      c,
      types,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      [weekend],
    );
    const every = await addEndpoint(c, types);
    expect((await webhooks().list(owner)).find((e) => e.id === chosen.id)?.campaigns).toEqual([
      { id: weekend, name: 'Weekend sale', status: 'draft' },
    ]);

    // The weekend sale reaches its one contact; the Monday sale is cancelled before it starts.
    await s.campaigns.submitCampaign(owner, weekend, { expectedVersion: 1 }, {});
    expect(await s.tick(weekend)).toMatchObject({ outcome: 'progress', queued: 1 });
    expect(await s.dispatch(weekend)).toEqual(['accepted']);
    await s.campaigns.cancelCampaign(owner, monday, {});
    expect(await changesOf(weekend)).toEqual([
      ['scheduled', 'draft', null, null, 2],
      ['running', 'scheduled', null, null, 2],
    ]);
    expect(await changesOf(monday)).toEqual([['canceled', 'draft', null, null, 1]]);

    await deliverDue(c);
    const campaignsAt = (path: string) =>
      bodiesAt(path)
        .map((b) =>
          b.type === 'message.status'
            ? [b.type, messageStatusPayloadSchema.parse(b).data.message.campaignId]
            : [b.type, campaignStatusChangedPayloadSchema.parse(b).data.campaign.id],
        )
        .sort();
    // The runner's message names its campaign; the accepted status reached both endpoints.
    expect(campaignsAt(chosen.path)).toEqual([
      ['campaign.status_changed', weekend],
      ['campaign.status_changed', weekend],
      ['message.status', weekend],
    ]);
    expect(campaignsAt(every.path)).toEqual(
      [
        ['campaign.status_changed', weekend],
        ['campaign.status_changed', weekend],
        ['campaign.status_changed', monday],
        ['message.status', weekend],
      ].sort(),
    );
    const [status] = bodiesAt(chosen.path)
      .filter((b) => b.type === 'message.status')
      .map((b) => messageStatusPayloadSchema.parse(b).data.message);
    expect(status).toMatchObject({ status: 'accepted', sentBy: 'campaign', campaignId: weekend });
  });

  it('sends each recipient a campaign skips once: those skipped when the audience was taken when it starts, the others as it skips them, narrowed by campaign and number (ADR-358)', async () => {
    const s = await campaignCompany(3);
    const { c } = s;
    const owner = await fx.ctx(c, c.owner);
    // Two more contacts in the audience: one without marketing opt-in, one without a number.
    const { id: unconsented } = await contactsService().createContact(owner, {
      phone: `+${waId()}`,
      displayName: 'No consent',
      tags: ['vip'],
    });
    // The service takes no contact without a number; an import can leave one (no phone, no
    // WhatsApp identity).
    const [added] = await fx.query<{ id: string }>(
      `WITH added AS (
         INSERT INTO app.contacts (id, tenant_id, display_name, source)
         VALUES (gen_random_uuid(), $1, 'No number', 'import') RETURNING id)
       INSERT INTO app.contact_tags (id, tenant_id, contact_id, tag)
       SELECT gen_random_uuid(), $1, id, 'vip' FROM added RETURNING contact_id AS id`,
      [c.tenant.id],
    );
    const numberless = added!.id;
    const outlet = await fx.addNumber(c, { phone: '+91 90000 54322' });
    const types: WebhookEventType[] = ['campaign.recipient_skipped'];
    const every = await addEndpoint(c, types);
    const onMain = await addNumberEndpoint(c, types, [c.channelAccountId]);
    const onOutlet = await addNumberEndpoint(c, types, [outlet.channelAccountId]);
    const other = await s.draft(owner, 'Another sale');
    const forOther = await addEndpoint(
      c,
      types,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      [other],
    );
    const statusOnly = await addEndpoint(c, ['campaign.status_changed']);
    /** The skipped recipients captured, as [reason, contact, detail, deliveries], in order. */
    const skips = async () =>
      (
        await fx.query<{
          status: string;
          contact_id: string;
          detail: Record<string, unknown>;
          deliveries: number;
        }>(
          `SELECT e.status, e.contact_id, e.detail,
                  (SELECT count(*)::int FROM app.webhook_deliveries d
                    WHERE d.tenant_id = e.tenant_id AND d.event_id = e.id) AS deliveries
             FROM app.webhook_events e
            WHERE e.tenant_id = $1 AND e.type = 'campaign.recipient_skipped'
            ORDER BY e.occurred_at, e.id`,
          [c.tenant.id],
        )
      ).map((e) => [e.status, e.contact_id, e.detail, e.deliveries]);
    const recipientOf = async (contactId: string) => {
      const [row] = await fx.query<{ id: string }>(
        'SELECT id FROM app.campaign_recipients WHERE campaign_id = $1 AND contact_id = $2',
        [id, contactId],
      );
      if (!row) throw new Error('recipient missing');
      return row.id;
    };

    // Submitted: the audience is taken, two of its contacts skipped, and nothing is sent yet.
    const id = await s.draft(owner, 'Festive sale');
    await s.campaigns.submitCampaign(owner, id, { expectedVersion: 1 }, {});
    expect(
      await fx.query(
        `SELECT state, skip_reason FROM app.campaign_recipients
          WHERE campaign_id = $1 AND state = 'skipped' ORDER BY skip_reason`,
        [id],
      ),
    ).toEqual([
      { state: 'skipped', skip_reason: 'no_marketing_opt_in' },
      { state: 'skipped', skip_reason: 'no_phone' },
    ]);
    expect(await skips()).toEqual([]);
    // A contact opts out before the campaign reaches them.
    const shoppers = await fx.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM app.contacts
        WHERE tenant_id = $1 AND display_name LIKE 'Shopper %' ORDER BY display_name`,
      [c.tenant.id],
    );
    const optedOut = shoppers[2]!.id;
    await createConsentService({ db: fx.dbs.app, clock: systemClock }).recordConsent(owner, {
      contactId: optedOut,
      purpose: 'marketing',
      action: 'opt_out',
      note: 'Asked by phone',
    });

    // The runner starts it: the two skipped when it was submitted are captured then, after the
    // change to running, and the one it skips now as it skips them.
    expect(await s.tick(id)).toMatchObject({ outcome: 'progress', queued: 2, skipped: 1 });
    const started = await skips();
    expect(started.map(([reason]) => reason)).toEqual([
      expect.stringMatching(/^(no_marketing_opt_in|no_phone)$/),
      expect.stringMatching(/^(no_marketing_opt_in|no_phone)$/),
      'opted_out',
    ]);
    expect(new Set(started.slice(0, 2).map(([reason]) => reason)).size).toBe(2);
    const contactFor = {
      no_marketing_opt_in: unconsented,
      no_phone: numberless,
      opted_out: optedOut,
    };
    for (const [reason, contact, detail, deliveries] of started) {
      expect(contact, String(reason)).toBe(contactFor[reason as keyof typeof contactFor]);
      // Only the recipient is kept: its campaign and number served the filters.
      expect(detail, String(reason)).toEqual({ recipientId: await recipientOf(contact as string) });
      // Every endpoint taking the event, and the one naming the campaign's number.
      expect(deliveries, String(reason)).toBe(2);
    }
    // Compared in the database, to the microsecond: a JavaScript date keeps milliseconds only.
    const [order] = await fx.query<{ after: boolean }>(
      `SELECT (SELECT min(occurred_at) FROM app.webhook_events
                WHERE tenant_id = $1 AND type = 'campaign.recipient_skipped')
            > (SELECT occurred_at FROM app.webhook_events
                WHERE tenant_id = $1 AND type = 'campaign.status_changed' AND status = 'running')
              AS after`,
      [c.tenant.id],
    );
    expect(order).toEqual({ after: true });

    // Paused (its unsent messages go back) and resumed: resuming captures nothing again. Its
    // sending period then ends with the two recipients still waiting: both are skipped at once.
    expect(await s.campaigns.pauseCampaign(owner, id, {})).toEqual({ released: 2 });
    await s.campaigns.resumeCampaign(owner, id, {});
    expect(await skips()).toHaveLength(3);
    s.clock.advance(25 * 3_600_000);
    expect(await s.tick(id)).toMatchObject({ outcome: 'completed' });
    const ended = (await skips()).slice(3);
    expect(
      ended.map(([reason, contact, , deliveries]) => [reason, contact, deliveries]).sort(),
    ).toEqual(
      [
        ['expired', shoppers[0]!.id, 2],
        ['expired', shoppers[1]!.id, 2],
      ].sort(),
    );
    expect(await skips()).toHaveLength(5);

    // Delivered as the campaign and the contacts are now, with each reason as captured.
    await deliverDue(c);
    const bodies = bodiesAt(every.path);
    expect(bodies.map((b) => b.type)).toEqual(Array(5).fill('campaign.recipient_skipped'));
    for (const b of bodies) {
      expect(campaignRecipientSkippedPayloadSchema.safeParse(b).success, JSON.stringify(b)).toBe(
        true,
      );
    }
    const campaign = {
      id,
      name: 'Festive sale',
      status: 'completed',
      templateId: s.templateId,
      templateName: s.templateName,
    };
    const channel = { id: c.channelAccountId, phone: '+91 90000 00000' };
    const bodyFor = (contactId: string) =>
      bodies.find((b) => (b.data.contact as { id: string }).id === contactId)?.data;
    expect(bodyFor(optedOut)).toEqual({
      recipient: { id: await recipientOf(optedOut), skipReason: 'opted_out' },
      campaign,
      contact: { id: optedOut, phone: expect.stringMatching(/^\+/), name: 'Shopper 2' },
      channel,
    });
    expect(bodyFor(numberless)).toEqual({
      recipient: { id: await recipientOf(numberless), skipReason: 'no_phone' },
      campaign,
      contact: { id: numberless, phone: null, name: 'No number' },
      channel,
    });
    expect(bodyFor(shoppers[0]!.id)).toMatchObject({
      recipient: { skipReason: 'expired' },
      contact: { name: 'Shopper 0' },
    });
    // The number's endpoint got them all; the other number's, the other campaign's and the one
    // taking campaign changes only got none.
    expect(numbersAt(onMain.path, 'campaign')).toEqual(
      Array.from({ length: 5 }, () => ['campaign.recipient_skipped', id, c.channelAccountId]),
    );
    expect(bodiesAt(onOutlet.path)).toEqual([]);
    expect(bodiesAt(forOther.path)).toEqual([]);
    expect(bodiesAt(statusOnly.path).every((b) => b.type === 'campaign.status_changed')).toBe(true);

    // A recipient that is gone (a contact merge removes one when both contacts were in the
    // audience) can no longer be described: a delivery not yet made ends as event_gone.
    const late = await addEndpoint(c, types);
    await fx.query(
      `UPDATE app.campaign_recipients SET state = 'pending', skip_reason = NULL
        WHERE campaign_id = $1 AND contact_id = $2`,
      [id, shoppers[0]!.id],
    );
    await fx.query(
      `UPDATE app.campaign_recipients SET state = 'skipped', skip_reason = 'expired'
        WHERE campaign_id = $1 AND contact_id = $2`,
      [id, shoppers[0]!.id],
    );
    const gone = await recipientOf(shoppers[0]!.id);
    await fx.query('DELETE FROM app.campaign_recipients WHERE id = $1', [gone]);
    await deliverDue(c);
    expect(bodiesAt(late.path)).toEqual([]);
    expect(
      await fx.query(
        `SELECT d.state, d.last_error FROM app.webhook_deliveries d
          WHERE d.endpoint_id = $1`,
        [late.id],
      ),
    ).toEqual([{ state: 'failed', last_error: 'event_gone' }]);
  });

  it('captures the skips of a large audience together within the statement timeout: 10,000 when the campaign starts, the rest when its sending period ends (ADR-358)', async () => {
    const s = await campaignCompany(0);
    const { c } = s;
    const owner = await fx.ctx(c, c.owner);
    const hook = await addEndpoint(c, ['campaign.recipient_skipped']);
    // 13,000 contacts in the audience: the first 3,000 opted in to marketing, the other 10,000
    // skipped when the audience is taken (no marketing opt-in).
    await fx.query(
      `WITH added AS (
         INSERT INTO app.contacts (id, tenant_id, display_name, phone_e164, source)
         SELECT gen_random_uuid(), $1, 'Load ' || g, '+9171' || lpad(g::text, 8, '0'), 'import'
           FROM generate_series(1, 13000) AS g
         RETURNING id)
       INSERT INTO app.contact_tags (id, tenant_id, contact_id, tag)
       SELECT gen_random_uuid(), $1, id, 'vip' FROM added`,
      [c.tenant.id],
    );
    await fx.query(
      `INSERT INTO app.consent_events (id, tenant_id, contact_id, purpose, action, source, actor_type, occurred_at)
       SELECT gen_random_uuid(), tenant_id, id, 'marketing', 'opt_in', 'import', 'system', now()
         FROM app.contacts WHERE tenant_id = $1 AND substring(display_name FROM 6)::int <= 3000`,
      [c.tenant.id],
    );
    // Statistics as autovacuum leaves them after a bulk import, as the 10,000-recipient campaign
    // test does: the test is about the capture, not the audience count's plan.
    await fx.query(
      'ANALYZE app.contacts, app.contact_tags, app.consent_events, app.contact_consents',
    );
    const id = await s.draft(owner, 'Mostly skipped');
    expect(await s.campaigns.submitCampaign(owner, id, { expectedVersion: 1 }, {})).toMatchObject({
      audience: 13_000,
      pending: 3_000,
    });
    /** The skipped recipients captured, by reason, and the deliveries made for them. */
    const captured = async () => {
      const [row] = await fx.query<{ by_reason: Record<string, number>; deliveries: number }>(
        `SELECT (SELECT jsonb_object_agg(status, n) FROM (
                   SELECT status, count(*)::int AS n FROM app.webhook_events
                    WHERE tenant_id = $1 AND type = 'campaign.recipient_skipped'
                    GROUP BY status) x) AS by_reason,
                (SELECT count(*)::int FROM app.webhook_deliveries WHERE endpoint_id = $2)
                  AS deliveries`,
        [c.tenant.id, hook.id],
      );
      return row;
    };

    // The start captures the 10,000 in one statement, under the pool's 15-second statement timeout.
    let t = Date.now();
    const first = await s.tick(id);
    const startMs = Date.now() - t;
    expect(first).toMatchObject({ outcome: 'progress', skipped: 0 });
    expect(await captured()).toEqual({
      by_reason: { no_marketing_opt_in: 10_000 },
      deliveries: 10_000,
    });
    // The send worker would take the sends just queued: here they are accepted directly, as the
    // 10,000-recipient campaign test does, so none is left for the sweep of stale sends, which
    // reads every company's (ops.stale_send_intents) and which other tests read.
    await fx.query(
      `UPDATE app.send_intents SET state = 'accepted' WHERE state = 'queued'
         AND message_id IN (SELECT id FROM app.messages WHERE campaign_id = $1)`,
      [id],
    );

    // The sending period ends with the rest still waiting: skipped together, captured together.
    s.clock.advance(25 * 3_600_000);
    t = Date.now();
    expect(await s.tick(id)).toMatchObject({ outcome: 'completed' });
    const endMs = Date.now() - t;
    const waiting = 3_000 - (first as { queued: number }).queued;
    expect(await captured()).toEqual({
      by_reason: { no_marketing_opt_in: 10_000, expired: waiting },
      deliveries: 10_000 + waiting,
    });
    console.info(
      `campaign skips: start ${startMs} ms (10,000 captured), end ${endMs} ms (${waiting} captured)`,
    );
  }, 180_000);

  it('sends an endpoint that names skip reasons only the skips of those reasons, with its other events and lists as before, and writes no skip that no endpoint takes (ADR-359)', async () => {
    const s = await campaignCompany(3);
    const { c } = s;
    const owner = await fx.ctx(c, c.owner);
    // Two more contacts in the audience: one without marketing opt-in, one without a number.
    const { id: unconsented } = await contactsService().createContact(owner, {
      phone: `+${waId()}`,
      displayName: 'No consent',
      tags: ['vip'],
    });
    const [added] = await fx.query<{ id: string }>(
      `WITH added AS (
         INSERT INTO app.contacts (id, tenant_id, display_name, source)
         VALUES (gen_random_uuid(), $1, 'No number', 'import') RETURNING id)
       INSERT INTO app.contact_tags (id, tenant_id, contact_id, tag)
       SELECT gen_random_uuid(), $1, id, 'vip' FROM added RETURNING contact_id AS id`,
      [c.tenant.id],
    );
    const numberless = added!.id;
    /**
     * An endpoint taking the skipped recipients of the reasons given only, and the other events and
     * lists given.
     */
    const addReasonEndpoint = async (
      campaignSkipReasons: string[] | null,
      more: Record<string, unknown> = {},
      eventTypes: WebhookEventType[] = ['campaign.recipient_skipped'],
    ) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes,
        campaignSkipReasons,
        ...more,
      });
      return { ...created, path };
    };
    const phoneOrExpired = await addReasonEndpoint(['no_phone', 'expired']);
    const optedOutOnly = await addReasonEndpoint(['opted_out']);
    // The campaign's status changes come whatever the reasons named.
    const statusAndOptedOut = await addReasonEndpoint(['opted_out'], {}, [
      'campaign.recipient_skipped',
      'campaign.status_changed',
    ]);
    // A reason on the list is not enough: the campaign and number lists still have to hold it.
    const other = await s.draft(owner, 'Another sale');
    const outlet = await fx.addNumber(c, { phone: '+91 90000 54323' });
    const otherCampaign = await addReasonEndpoint(['expired'], { campaignIds: [other] });
    const otherNumber = await addReasonEndpoint(['expired'], {
      channelIds: [outlet.channelAccountId],
    });
    /** The skipped recipients captured, oldest first: reason, contact and deliveries. */
    const captured = () =>
      fx.query<{ reason: string; contact: string; deliveries: number }>(
        `SELECT e.status AS reason, e.contact_id AS contact,
                (SELECT count(*)::int FROM app.webhook_deliveries d
                  WHERE d.tenant_id = e.tenant_id AND d.event_id = e.id) AS deliveries
           FROM app.webhook_events e
          WHERE e.tenant_id = $1 AND e.type = 'campaign.recipient_skipped'
          ORDER BY e.occurred_at, e.id`,
        [c.tenant.id],
      );

    const id = await s.draft(owner, 'Festive sale');
    expect(await s.campaigns.submitCampaign(owner, id, { expectedVersion: 1 }, {})).toMatchObject({
      audience: 5,
      pending: 3,
    });
    // A contact opts out before the campaign reaches them.
    const shoppers = await fx.query<{ id: string }>(
      `SELECT id FROM app.contacts
        WHERE tenant_id = $1 AND display_name LIKE 'Shopper %' ORDER BY display_name`,
      [c.tenant.id],
    );
    const optedOut = shoppers[2]!.id;
    await createConsentService({ db: fx.dbs.app, clock: systemClock }).recordConsent(owner, {
      contactId: optedOut,
      purpose: 'marketing',
      action: 'opt_out',
      note: 'Asked by phone',
    });

    // The start: of the two skipped when the audience was taken, the one without a number goes to
    // the endpoint naming no_phone, and the one without opt-in, which no endpoint takes, is not
    // written; the opt-out the runner skips goes to the two endpoints naming opted_out.
    expect(await s.tick(id)).toMatchObject({ outcome: 'progress', queued: 2, skipped: 1 });
    expect(await captured()).toEqual([
      { reason: 'no_phone', contact: numberless, deliveries: 1 },
      { reason: 'opted_out', contact: optedOut, deliveries: 2 },
    ]);
    expect(
      await fx.query(
        `SELECT state, skip_reason FROM app.campaign_recipients
          WHERE campaign_id = $1 AND contact_id = $2`,
        [id, unconsented],
      ),
    ).toEqual([{ state: 'skipped', skip_reason: 'no_marketing_opt_in' }]);

    // An endpoint taking every reason, and one whose cart reminder reasons (another event's list,
    // naming no_phone) narrow nothing here; then the sending period ends with the two still waiting
    // (paused, which sends their messages back, and resumed): both expired skips go to those two
    // and to the endpoint naming expired, never to those naming opted_out, another campaign or
    // another number.
    const every = await addReasonEndpoint(null);
    const cartReasons = await addReasonEndpoint(null, { cartReminderSkipReasons: ['no_phone'] }, [
      'campaign.recipient_skipped',
      'store_checkout.reminder_skipped',
    ]);
    expect(await s.campaigns.pauseCampaign(owner, id, {})).toEqual({ released: 2 });
    await s.campaigns.resumeCampaign(owner, id, {});
    s.clock.advance(25 * 3_600_000);
    expect(await s.tick(id)).toMatchObject({ outcome: 'completed' });
    expect((await captured()).slice(2)).toEqual(
      expect.arrayContaining([
        { reason: 'expired', contact: shoppers[0]!.id, deliveries: 3 },
        { reason: 'expired', contact: shoppers[1]!.id, deliveries: 3 },
      ]),
    );
    expect(await captured()).toHaveLength(4);

    await deliverDue(c);
    const reasonsAt = (path: string) =>
      bodiesAt(path)
        .filter((b) => b.type === 'campaign.recipient_skipped')
        .map((b) => (b.data.recipient as { skipReason: string }).skipReason)
        .sort();
    expect(reasonsAt(phoneOrExpired.path)).toEqual(['expired', 'expired', 'no_phone']);
    expect(reasonsAt(optedOutOnly.path)).toEqual(['opted_out']);
    expect(reasonsAt(statusAndOptedOut.path)).toEqual(['opted_out']);
    expect(reasonsAt(every.path)).toEqual(['expired', 'expired']);
    expect(reasonsAt(cartReasons.path)).toEqual(['expired', 'expired']);
    expect(bodiesAt(otherCampaign.path)).toEqual([]);
    expect(bodiesAt(otherNumber.path)).toEqual([]);
    // Every change of the campaign's status went to the endpoint naming opted_out.
    const [changes] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.webhook_events
        WHERE tenant_id = $1 AND type = 'campaign.status_changed' AND detail->>'campaignId' = $2`,
      [c.tenant.id, id],
    );
    expect(changes!.n).toBeGreaterThan(0);
    expect(
      bodiesAt(statusAndOptedOut.path).filter((b) => b.type === 'campaign.status_changed'),
    ).toHaveLength(changes!.n);
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

describe('deal events (ADR-256)', () => {
  const crm = () =>
    createCrmService({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });
  const DEAL_EVENTS: WebhookEventType[] = [
    'deal.created',
    'deal.stage_changed',
    'deal.status_changed',
  ];
  const payloadSchemas = {
    'deal.created': dealCreatedPayloadSchema,
    'deal.stage_changed': dealStageChangedPayloadSchema,
    'deal.status_changed': dealStatusChangedPayloadSchema,
  } as const;

  /** A company with the pipelines Sales (New, Qualified, Proposal) and Renewals (Due, Signed), INR. */
  async function crmCompany() {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const svc = crm();
    const { id: salesId } = await svc.createPipeline(owner, {
      name: 'Sales',
      currency: 'INR',
      stages: ['New', 'Qualified', 'Proposal'],
    });
    const { id: renewalsId } = await svc.createPipeline(owner, {
      name: 'Renewals',
      currency: 'INR',
      stages: ['Due', 'Signed'],
    });
    const pipelines = await svc.listPipelines(owner);
    const stagesOf = (id: string) => pipelines.find((p) => p.id === id)!.stages.map((s) => s.id);
    return {
      c,
      owner,
      salesId,
      renewalsId,
      sales: stagesOf(salesId),
      renewals: stagesOf(renewalsId),
    };
  }

  /** A contact a member adds, with a number; its id and number. */
  async function newContact(owner: TenantContext, name: string) {
    const phone = `+${waId()}`;
    const { id } = await contactsService().createContact(owner, { displayName: name, phone });
    return { id, phone };
  }

  /**
   * The company's deal events in the order they were captured (one change can capture two, in one
   * transaction), with their delivery counts.
   */
  const dealEventsOf = (c: Company) =>
    fx.query<EventRow & { occurred_at: Date }>(
      `SELECT e.id, e.type, e.status, e.detail, e.conversation_id, e.contact_id, e.occurred_at,
              (SELECT count(*)::int FROM app.webhook_deliveries d
                WHERE d.tenant_id = e.tenant_id AND d.event_id = e.id) AS deliveries
         FROM app.webhook_events e
        WHERE e.tenant_id = $1 AND e.type LIKE 'deal.%' ORDER BY e.occurred_at, e.id`,
      [c.tenant.id],
    );

  /** The bodies the receiver got on a path, by event id: deliveries are sent concurrently. */
  const bodiesById = (path: string) => new Map(bodiesAt(path).map((b) => [b.id, b]));

  const dealIn = (body: { data: Record<string, unknown> } | undefined) =>
    body?.data.deal as Record<string, unknown>;

  it('sends each deal added and every move, close and reopening, with what was before it, from members, an automation and an API key', async () => {
    const s = await crmCompany();
    const { c, owner } = s;
    const agent = await fx.ctx(c, c.agent);
    const hook = await addEndpoint(c, DEAL_EVENTS);
    const closes = await addEndpoint(c, ['deal.status_changed']);
    const contactsOnly = await addEndpoint(c, ['contact.created']);
    const svc = crm();
    const jaya = await newContact(owner, 'Jaya');

    // A member adds a deal, moves it in its pipeline and to the other one, and loses it.
    const { id: dealId } = await svc.createDeal(agent, {
      contactId: jaya.id,
      pipelineId: s.salesId,
      stageId: s.sales[0],
      title: 'Annual plan',
      value: '2,500.50',
      ownerMembershipId: agent.membership.id,
      expectedCloseOn: '2026-12-31',
    });
    await svc.moveDeal(agent, { id: dealId, expectedVersion: 1, stageId: s.sales[1] });
    await svc.moveDeal(agent, {
      id: dealId,
      expectedVersion: 2,
      stageId: s.renewals[0],
      pipelineId: s.renewalsId,
    });
    await svc.closeDeal(agent, {
      id: dealId,
      expectedVersion: 3,
      outcome: 'lost',
      lostReason: 'Budget cut',
    });
    // Delivered now, the loss gives the reason and the rest of the deal as they are now.
    await deliverDue(c);
    const lost = [...bodiesById(hook.path).values()].find((b) => b.type === 'deal.status_changed');
    expect(dealIn(lost)).toEqual({
      id: dealId,
      title: 'Annual plan',
      pipelineId: s.renewalsId,
      stageId: s.renewals[0],
      status: 'lost',
      previousStageId: null,
      previousPipelineId: null,
      previousStatus: 'open',
      previousOwnerId: null,
      valueMinor: 250_050,
      currency: 'INR',
      ownerId: agent.membership.id,
      expectedCloseOn: '2026-12-31',
      lostReason: 'Budget cut',
      createdBy: 'member',
      createdAt: expect.any(String),
      changedBy: 'member',
      apiKeyId: null,
    });
    expect(lost?.data.contact).toEqual({ id: jaya.id, phone: jaya.phone, name: 'Jaya' });
    expect(lost?.data.conversation).toBeNull();

    // Its stage is removed while it is lost; reopened, it goes to the first stage left: reopened,
    // then moved. Edits of its details change neither its stage nor its status.
    const [renewals] = (await svc.listPipelines(owner)).filter((p) => p.id === s.renewalsId);
    await svc.updatePipeline(owner, {
      id: s.renewalsId,
      expectedVersion: renewals!.version,
      name: 'Renewals',
      stages: [{ id: s.renewals[1]!, name: 'Signed' }],
    });
    await svc.reopenDeal(agent, { id: dealId, expectedVersion: 4 });
    await svc.updateDeal(agent, {
      id: dealId,
      expectedVersion: 5,
      title: 'Annual plan, renewed',
      value: '3,000',
      ownerMembershipId: null,
      expectedCloseOn: null,
    });

    // An API key adds a deal, then moves and wins it in one request: moved, then won. A change of
    // its title alone sends nothing.
    const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'Web shop', scopes: ['deals.write'], expiresInDays: 0 },
    );
    const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    if (!key) throw new Error('a new key does not authenticate');
    const apiDeps = { db: fx.dbs.app, clock: systemClock };
    const response = await apiCreateDeal(
      apiDeps,
      key,
      { contactId: jaya.id, pipelineId: s.salesId, title: 'Web order', valueMinor: 99_900 },
      null,
    );
    const apiDealId = (response.body as { data: { id: string } }).data.id;
    await apiUpdateDeal(apiDeps, key, apiDealId, { stageId: s.sales[2], status: 'won' });
    await apiUpdateDeal(apiDeps, key, apiDealId, { title: 'Web order 1001' });

    // An automation adds a deal for the customer who writes, moves it and wins it, a step at a time.
    const automations = createAutomationService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
    });
    const { id: automationId } = await automations.createAutomation(owner, { name: 'Leads' });
    const saved = await automations.updateAutomation(owner, {
      id: automationId,
      expectedVersion: 0,
      name: 'Leads',
      description: null,
      channelAccountId: null,
      trigger: {
        type: 'keyword',
        keywords: ['price'],
        match: 'contains',
        hours: 'any',
        cooldownMinutes: 0,
      },
      graph: {
        version: 1,
        start: 'deal',
        nodes: [
          {
            id: 'deal',
            type: 'create_deal',
            title: 'Kettles for {{name}}',
            pipelineId: s.salesId,
            stageId: s.sales[0],
            value: null,
            ownerMembershipId: null,
            next: 'move',
          },
          {
            id: 'move',
            type: 'move_deal',
            pipelineId: s.salesId,
            stageId: s.sales[1],
            next: 'win',
          },
          {
            id: 'win',
            type: 'close_deal',
            pipelineId: s.salesId,
            outcome: 'won',
            lostReason: null,
            next: null,
          },
        ],
      },
    });
    expect(saved.issues).toEqual([]);
    await automations.publishAutomation(owner, {
      id: automationId,
      expectedVersion: saved.version,
      note: null,
    });
    const from = waId();
    const { conversation_id: conversationId, contact_id: customerId } = await inbound(
      c,
      from,
      'what is the price?',
    );
    const [run] = await fx.query<{ id: string }>(
      'SELECT id FROM app.automation_runs WHERE conversation_id = $1',
      [conversationId],
    );
    const advanced = await advanceAutomationRun(
      {
        db: fx.dbs.app,
        jobs: fx.jobs(),
        signer: fx.signer,
        clock: systemClock,
        keyring: fx.keyring,
      },
      authorizedTenantScope(c.tenant.id, null),
      run!.id,
      null,
    );
    expect(advanced.outcome).toBe('ended');
    const [byRun] = await fx.query<{ id: string }>(
      'SELECT id FROM app.crm_deals WHERE tenant_id = $1 AND created_by_automation_id = $2',
      [c.tenant.id, automationId],
    );
    const runDealId = byRun!.id;

    // One event per step, in the order the steps happened, each to the endpoints that take it, with
    // who made each change (ADR-277): additions name their creator in the payload, not here.
    const events = await dealEventsOf(c);
    const sales = { pipelineId: s.salesId };
    const renewal = { pipelineId: s.renewalsId };
    const byMember = { changedBy: 'member', apiKeyId: null };
    const byKey = { changedBy: 'api', apiKeyId: key.key.id };
    const byAutomation = { changedBy: 'automation', apiKeyId: null };
    expect(events.map((e) => [e.type, e.status, e.detail, e.deliveries])).toEqual([
      ['deal.created', 'open', { dealId, stageId: s.sales[0], ...sales }, 1],
      [
        'deal.stage_changed',
        'open',
        {
          dealId,
          stageId: s.sales[1],
          ...sales,
          previousStageId: s.sales[0],
          previousPipelineId: null,
          ...byMember,
        },
        1,
      ],
      [
        'deal.stage_changed',
        'open',
        {
          dealId,
          stageId: s.renewals[0],
          ...renewal,
          previousStageId: s.sales[1],
          previousPipelineId: s.salesId,
          ...byMember,
        },
        1,
      ],
      [
        'deal.status_changed',
        'lost',
        { dealId, stageId: s.renewals[0], ...renewal, previousStatus: 'open', ...byMember },
        2,
      ],
      // Reopened in the stage that was removed, then moved to the first stage left.
      [
        'deal.status_changed',
        'open',
        { dealId, stageId: s.renewals[0], ...renewal, previousStatus: 'lost', ...byMember },
        2,
      ],
      [
        'deal.stage_changed',
        'open',
        {
          dealId,
          stageId: s.renewals[1],
          ...renewal,
          previousStageId: s.renewals[0],
          previousPipelineId: null,
          ...byMember,
        },
        1,
      ],
      ['deal.created', 'open', { dealId: apiDealId, stageId: s.sales[0], ...sales }, 1],
      // Moved while it was open, then won.
      [
        'deal.stage_changed',
        'open',
        {
          dealId: apiDealId,
          stageId: s.sales[2],
          ...sales,
          previousStageId: s.sales[0],
          previousPipelineId: null,
          ...byKey,
        },
        1,
      ],
      [
        'deal.status_changed',
        'won',
        { dealId: apiDealId, stageId: s.sales[2], ...sales, previousStatus: 'open', ...byKey },
        2,
      ],
      ['deal.created', 'open', { dealId: runDealId, stageId: s.sales[0], ...sales }, 1],
      [
        'deal.stage_changed',
        'open',
        {
          dealId: runDealId,
          stageId: s.sales[1],
          ...sales,
          previousStageId: s.sales[0],
          previousPipelineId: null,
          ...byAutomation,
        },
        1,
      ],
      [
        'deal.status_changed',
        'won',
        {
          dealId: runDealId,
          stageId: s.sales[1],
          ...sales,
          previousStatus: 'open',
          ...byAutomation,
        },
        2,
      ],
    ]);
    expect(events.map((e) => e.contact_id)).toEqual([
      ...Array<string>(9).fill(jaya.id),
      customerId,
      customerId,
      customerId,
    ]);
    expect(events.every((e) => e.conversation_id === null)).toBe(true);

    await deliverDue(c);
    const bodies = bodiesById(hook.path);
    expect([...bodies.keys()].sort()).toEqual(events.map((e) => e.id).sort());
    const delivered = events.map((e) => bodies.get(e.id)!);
    for (const body of delivered) {
      const schema = payloadSchemas[body.type as keyof typeof payloadSchemas];
      expect(schema.safeParse(body).success).toBe(true);
    }
    // Each event is stamped when it was captured, the two of one change too (in microseconds; a
    // body gives milliseconds).
    expect(delivered.map((b) => b.createdAt)).toEqual(
      events.map((e) => e.occurred_at.toISOString()),
    );
    expect(
      await fx.query(
        `SELECT count(DISTINCT occurred_at)::int AS times FROM app.webhook_events
          WHERE tenant_id = $1 AND type LIKE 'deal.%'`,
        [c.tenant.id],
      ),
    ).toEqual([{ times: 12 }]);
    // The stage, pipeline and status as each step left them, and those before them.
    expect(
      delivered.map((b) => {
        const d = dealIn(b);
        return [
          b.type,
          d.id,
          d.stageId,
          d.status,
          d.previousStageId,
          d.previousPipelineId,
          d.previousStatus,
          d.createdBy,
        ];
      }),
    ).toEqual([
      ['deal.created', dealId, s.sales[0], 'open', null, null, null, 'member'],
      ['deal.stage_changed', dealId, s.sales[1], 'open', s.sales[0], null, null, 'member'],
      ['deal.stage_changed', dealId, s.renewals[0], 'open', s.sales[1], s.salesId, null, 'member'],
      ['deal.status_changed', dealId, s.renewals[0], 'lost', null, null, 'open', 'member'],
      ['deal.status_changed', dealId, s.renewals[0], 'open', null, null, 'lost', 'member'],
      ['deal.stage_changed', dealId, s.renewals[1], 'open', s.renewals[0], null, null, 'member'],
      ['deal.created', apiDealId, s.sales[0], 'open', null, null, null, 'api'],
      ['deal.stage_changed', apiDealId, s.sales[2], 'open', s.sales[0], null, null, 'api'],
      ['deal.status_changed', apiDealId, s.sales[2], 'won', null, null, 'open', 'api'],
      ['deal.created', runDealId, s.sales[0], 'open', null, null, null, 'automation'],
      ['deal.stage_changed', runDealId, s.sales[1], 'open', s.sales[0], null, null, 'automation'],
      ['deal.status_changed', runDealId, s.sales[1], 'won', null, null, 'open', 'automation'],
    ]);
    // The rest as the deal is when delivered: renamed and reopened, it has no reason any more.
    const [jayaDeal] = await fx.query<{ created_at: Date }>(
      'SELECT created_at FROM app.crm_deals WHERE id = $1',
      [dealId],
    );
    for (const body of delivered.slice(4, 6)) {
      expect(dealIn(body)).toMatchObject({
        title: 'Annual plan, renewed',
        valueMinor: 300_000,
        currency: 'INR',
        ownerId: null,
        expectedCloseOn: null,
        lostReason: null,
        createdAt: jayaDeal!.created_at.toISOString(),
      });
    }
    expect(dealIn(delivered[8])).toMatchObject({ title: 'Web order 1001', valueMinor: 99_900 });
    expect(delivered[8]!.data.conversation).toBeNull();
    // The automation's deal names the conversation it was added from and its customer.
    for (const body of delivered.slice(9)) {
      expect(dealIn(body)).toMatchObject({ title: 'Kettles for Priya Customer', valueMinor: null });
      expect(body.data.conversation).toEqual({ id: conversationId });
      expect(body.data.contact).toEqual({
        id: customerId,
        phone: `+${from}`,
        name: 'Priya Customer',
      });
    }
    // An endpoint for status changes hears only those; one for contacts hears no deal.
    expect([...bodiesById(closes.path).keys()].sort()).toEqual(
      events
        .filter((e) => e.type === 'deal.status_changed')
        .map((e) => e.id)
        .sort(),
    );
    expect(bodiesAt(contactsOnly.path).map((b) => b.type)).toEqual([
      'contact.created',
      'contact.created',
    ]);

    // The API reads who added each deal as deal.created says it (ADR-282).
    const reading = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'Deal sync', scopes: ['deals.read'], expiresInDays: 0 },
    );
    const reader = await authenticateApiToken(fx.dbs.app, reading.token, uuidv7());
    if (!reader) throw new Error('a new key does not authenticate');
    const creators: [string, string | null][] = [];
    for (const id of [dealId, apiDealId, runDealId]) {
      const { createdBy, createdByApiKeyId } = await apiGetDeal(apiDeps, reader, id);
      creators.push([createdBy, createdByApiKeyId]);
    }
    expect(creators).toEqual([
      ['member', null],
      ['api', key.key.id],
      ['automation', null],
    ]);
  });

  it('sends nothing without an endpoint for deals or for an erasure or a merge, sends an erased contact’s deal as erasure left it, and fails a delivery whose deal is gone', async () => {
    const s = await crmCompany();
    const { c, owner } = s;
    const svc = crm();
    // No endpoint takes deal events: a deal and its changes capture nothing.
    await addEndpoint(c, ['contact.created', 'order.status_changed']);
    const quiet = await newContact(owner, 'Quiet');
    const { id: quietDeal } = await svc.createDeal(owner, {
      contactId: quiet.id,
      pipelineId: s.salesId,
      stageId: s.sales[0],
      title: 'Quiet deal',
    });
    await svc.moveDeal(owner, { id: quietDeal, expectedVersion: 1, stageId: s.sales[1] });
    await svc.closeDeal(owner, { id: quietDeal, expectedVersion: 2, outcome: 'won' });
    expect(await dealEventsOf(c)).toEqual([]);

    // An endpoint that names numbers still receives deal events: they happen on no number.
    const hook = await addNumberEndpoint(
      c,
      ['deal.created', 'deal.status_changed', 'message.received'],
      [c.channelAccountId],
    );
    // A customer who wrote by WhatsApp user id gets a deal, lost with a reason; the contact is
    // merged into one a member added, which is then erased.
    const merged = await writesByUserId(c);
    const { id: dealId } = await svc.createDeal(owner, {
      contactId: merged,
      pipelineId: s.salesId,
      stageId: s.sales[0],
      title: 'Asha’s order',
      value: '1,000',
    });
    await svc.closeDeal(owner, {
      id: dealId,
      expectedVersion: 1,
      outcome: 'lost',
      lostReason: 'Ring 98450 12345 after Diwali',
    });
    const kept = await newContact(owner, 'Asha');
    await createContactMergeService({ db: fx.dbs.app, clock: systemClock }).mergeContacts(owner, {
      keepContactId: kept.id,
      mergeContactId: merged,
    });
    await contactsService().eraseContact(owner, { contactId: kept.id, suppress: false });
    // The merge moved the deal and the erasure blanked its text, neither changing its stage or
    // status: nothing more is captured.
    expect(
      (await dealEventsOf(c)).map((e) => [e.type, e.status, e.contact_id, e.deliveries]),
    ).toEqual([
      ['deal.created', 'open', merged, 1],
      ['deal.status_changed', 'lost', merged, 1],
    ]);

    // Both are built when delivered: the deal of the contact it was merged into, as erasure left it.
    await deliverDue(c);
    const bodies = bodiesAt(hook.path)
      .filter((b) => b.type.startsWith('deal.'))
      .sort((a, b) => a.type.localeCompare(b.type));
    expect(bodies.map((b) => b.type)).toEqual(['deal.created', 'deal.status_changed']);
    for (const body of bodies) {
      expect(body.data.contact).toEqual({ id: kept.id, phone: null, name: null });
      expect(dealIn(body)).toMatchObject({
        id: dealId,
        title: 'Deal (contact erased)',
        lostReason: null,
        valueMinor: 100_000,
      });
      expect(body.data).not.toHaveProperty('channel');
      expect(JSON.stringify(body)).not.toContain(kept.phone.slice(3));
      expect(JSON.stringify(body)).not.toContain('98450');
    }

    // An event whose deal no longer exists fails without an attempt.
    const gone = await addEndpoint(c, ['deal.stage_changed']);
    const eventId = uuidv7();
    await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, null), async (tx) => {
      await tx.insert(webhookEvents).values({
        id: eventId,
        tenantId: c.tenant.id,
        type: 'deal.stage_changed',
        contactId: kept.id,
        status: 'open',
        detail: {
          dealId: uuidv7(),
          stageId: s.sales[1],
          pipelineId: s.salesId,
          previousStageId: s.sales[0],
          previousPipelineId: null,
        },
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

    // An endpoint can take every event type, deals included.
    const everything = await addEndpoint(c, [...WEBHOOK_EVENT_KEYS]);
    expect(
      await fx.query('SELECT event_types FROM app.webhook_endpoints WHERE id = $1', [
        everything.id,
      ]),
    ).toEqual([{ event_types: [...WEBHOOK_EVENT_KEYS] }]);
  });

  it("sends an endpoint that names pipelines only their deals' events, a move between pipelines to the endpoints of both, and other events whatever it names (ADR-263)", async () => {
    const s = await crmCompany();
    const { c, owner } = s;
    const svc = crm();
    /** An endpoint of the company taking `eventTypes` of the pipelines given only. */
    const add = async (eventTypes: WebhookEventType[], pipelineIds: string[] | null) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes,
        pipelineIds,
      });
      return { ...created, path };
    };
    const salesOnly = await add([...DEAL_EVENTS, 'task.created', 'contact.created'], [s.salesId]);
    const renewalsOnly = await add(DEAL_EVENTS, [s.renewalsId]);
    const every = await add(DEAL_EVENTS, null);
    const jaya = await newContact(owner, 'Jaya');

    // A renewal is added, moved in Renewals and won: Renewals' alone.
    const { id: renewal } = await svc.createDeal(owner, {
      contactId: jaya.id,
      pipelineId: s.renewalsId,
      stageId: s.renewals[0],
      title: 'Renewal 2027',
    });
    await svc.moveDeal(owner, { id: renewal, expectedVersion: 1, stageId: s.renewals[1] });
    await svc.closeDeal(owner, { id: renewal, expectedVersion: 2, outcome: 'won' });
    // A sale is added in Sales, moved to Renewals (the move is both pipelines') and lost there.
    const { id: sale } = await svc.createDeal(owner, {
      contactId: jaya.id,
      pipelineId: s.salesId,
      stageId: s.sales[0],
      title: 'Annual plan',
    });
    await svc.moveDeal(owner, {
      id: sale,
      expectedVersion: 1,
      stageId: s.renewals[0],
      pipelineId: s.renewalsId,
    });
    await svc.closeDeal(owner, { id: sale, expectedVersion: 2, outcome: 'lost' });
    // A task about the renewal and a contact added are no pipeline's: the Sales endpoint gets them.
    await svc.createTask(owner, {
      title: 'Send the renewal invoice',
      assigneeMembershipId: owner.membership.id,
      dealId: renewal,
    });
    await newContact(owner, 'Ravi');

    // Each deal event is captured once, with a delivery to each endpoint its pipelines reach.
    expect(
      (await dealEventsOf(c)).map((e) => [
        e.type,
        e.detail.dealId,
        e.detail.pipelineId,
        e.detail.previousPipelineId ?? null,
        e.deliveries,
      ]),
    ).toEqual([
      ['deal.created', renewal, s.renewalsId, null, 2],
      ['deal.stage_changed', renewal, s.renewalsId, null, 2],
      ['deal.status_changed', renewal, s.renewalsId, null, 2],
      ['deal.created', sale, s.salesId, null, 2],
      ['deal.stage_changed', sale, s.renewalsId, s.salesId, 3],
      ['deal.status_changed', sale, s.renewalsId, null, 2],
    ]);
    await deliverDue(c);
    /** The deal events an endpoint received: type, deal, its pipeline and the one a move left. */
    const dealsAt = (path: string) =>
      bodiesAt(path)
        .filter((b) => b.type.startsWith('deal.'))
        .map((b) => {
          const deal = dealIn(b);
          return [b.type, deal.id, deal.pipelineId, deal.previousPipelineId].join(' ');
        })
        .sort();
    const line = (type: string, deal: string, pipeline: string, left: string | null) =>
      [type, deal, pipeline, left].join(' ');
    expect(dealsAt(salesOnly.path)).toEqual(
      [
        line('deal.created', sale, s.salesId, null),
        line('deal.stage_changed', sale, s.renewalsId, s.salesId),
      ].sort(),
    );
    expect(dealsAt(renewalsOnly.path)).toEqual(
      [
        line('deal.created', renewal, s.renewalsId, null),
        line('deal.stage_changed', renewal, s.renewalsId, null),
        line('deal.status_changed', renewal, s.renewalsId, null),
        line('deal.stage_changed', sale, s.renewalsId, s.salesId),
        line('deal.status_changed', sale, s.renewalsId, null),
      ].sort(),
    );
    expect(dealsAt(every.path)).toHaveLength(6);
    expect(
      bodiesAt(salesOnly.path)
        .map((b) => b.type)
        .filter((type) => !type.startsWith('deal.'))
        .sort(),
    ).toEqual(['contact.created', 'contact.created', 'task.created']);

    // With the other endpoints off, a renewal's events reach no endpoint and are not captured.
    for (const endpoint of [renewalsOnly, every]) {
      await webhooks().setEnabled(owner, { endpointId: endpoint.id, enabled: false });
    }
    await svc.createDeal(owner, {
      contactId: jaya.id,
      pipelineId: s.renewalsId,
      stageId: s.renewals[0],
      title: 'Renewal 2028',
    });
    expect(await dealEventsOf(c)).toHaveLength(6);
    // A list holding both pipelines takes both, as every pipeline's would.
    await webhooks().update(owner, {
      endpointId: salesOnly.id,
      url: `http://${HOST}:${port}${salesOnly.path}`,
      eventTypes: DEAL_EVENTS,
      pipelineIds: [s.salesId, s.renewalsId],
    });
    await svc.createDeal(owner, {
      contactId: jaya.id,
      pipelineId: s.renewalsId,
      stageId: s.renewals[0],
      title: 'Renewal 2029',
    });
    expect((await dealEventsOf(c)).map((e) => e.deliveries).slice(6)).toEqual([1]);
  });

  it("sends an endpoint that names stages only their deals' events, a move to the endpoints of the stage it left as well, and with pipelines too only what passes both (ADR-264)", async () => {
    const s = await crmCompany();
    const { c, owner } = s;
    const svc = crm();
    const [, qualified, proposal] = s.sales;
    const [due] = s.renewals;
    /** An endpoint of the company taking the deal events of the stages and pipelines given. */
    const add = async (stageIds: string[] | null, pipelineIds: string[] | null) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes: [...DEAL_EVENTS, 'contact.created'],
        stageIds,
        pipelineIds,
      });
      return { ...created, path };
    };
    const proposals = await add([proposal!], null);
    const proposalsToRenewals = await add([proposal!], [s.renewalsId]);
    const jaya = await newContact(owner, 'Jaya');

    // A sale moves New → Qualified → Proposal, then to Renewals' Due, where it is lost.
    const { id: sale } = await svc.createDeal(owner, {
      contactId: jaya.id,
      pipelineId: s.salesId,
      stageId: s.sales[0],
      title: 'Annual plan',
    });
    await svc.moveDeal(owner, { id: sale, expectedVersion: 1, stageId: qualified });
    await svc.moveDeal(owner, { id: sale, expectedVersion: 2, stageId: proposal });
    await svc.moveDeal(owner, {
      id: sale,
      expectedVersion: 3,
      stageId: due,
      pipelineId: s.renewalsId,
    });
    await svc.closeDeal(owner, { id: sale, expectedVersion: 4, outcome: 'lost' });
    // Another is added straight in Proposal and won there.
    const { id: quick } = await svc.createDeal(owner, {
      contactId: jaya.id,
      pipelineId: s.salesId,
      stageId: proposal,
      title: 'Quick order',
    });
    await svc.closeDeal(owner, { id: quick, expectedVersion: 1, outcome: 'won' });

    // Only what reaches an endpoint is captured: nothing for New → Qualified or the loss in Due.
    expect(
      (await dealEventsOf(c)).map((e) => [
        e.type,
        e.detail.dealId,
        e.detail.stageId,
        e.detail.previousStageId ?? null,
        e.deliveries,
      ]),
    ).toEqual([
      ['deal.stage_changed', sale, proposal, qualified, 1],
      ['deal.stage_changed', sale, due, proposal, 2],
      ['deal.created', quick, proposal, null, 1],
      ['deal.status_changed', quick, proposal, null, 1],
    ]);
    await deliverDue(c);
    /** The deal events an endpoint received: type, deal, its stage and the stage it left. */
    const dealsAt = (path: string) =>
      bodiesAt(path)
        .filter((b) => b.type.startsWith('deal.'))
        .map((b) => {
          const deal = dealIn(b);
          return [b.type, deal.id, deal.stageId, deal.previousStageId].join(' ');
        })
        .sort();
    const line = (type: string, deal: string, stage: string, left: string | null) =>
      [type, deal, stage, left].join(' ');
    expect(dealsAt(proposals.path)).toEqual(
      [
        line('deal.stage_changed', sale, proposal!, qualified!),
        line('deal.stage_changed', sale, due!, proposal!),
        line('deal.created', quick, proposal!, null),
        line('deal.status_changed', quick, proposal!, null),
      ].sort(),
    );
    // Proposal's stage and Renewals' pipeline: only the move from one to the other passes both.
    expect(dealsAt(proposalsToRenewals.path)).toEqual([
      line('deal.stage_changed', sale, due!, proposal!),
    ]);
    // Contact events are not narrowed by stages.
    expect(bodiesAt(proposals.path).filter((b) => b.type === 'contact.created')).toHaveLength(1);
  });

  it('sends an endpoint that names deal owners only the events of the deals they own when the events happen, and with stages too only what passes both (ADR-265)', async () => {
    const s = await crmCompany();
    const { c, owner } = s;
    const agent = await fx.ctx(c, c.agent);
    const svc = crm();
    const proposal = s.sales[2]!;
    /** An endpoint of the company taking the deal events of the owners and stages given. */
    const add = async (ownerIds: string[] | null, stageIds: string[] | null) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes: [...DEAL_EVENTS, 'contact.created'],
        ownerIds,
        stageIds,
      });
      return { ...created, path };
    };
    const agents = await add([agent.membership.id], null);
    const agentsProposals = await add([agent.membership.id], [proposal]);
    const jaya = await newContact(owner, 'Jaya');

    // The agent's deal is added in New and moved to Proposal; then it is given to the owner (these
    // endpoints do not take deal.owner_changed, ADR-269), and won: the owner's by then.
    const { id: theirs } = await svc.createDeal(owner, {
      contactId: jaya.id,
      pipelineId: s.salesId,
      stageId: s.sales[0],
      title: 'Annual plan',
      ownerMembershipId: agent.membership.id,
    });
    await svc.moveDeal(owner, { id: theirs, expectedVersion: 1, stageId: proposal });
    await svc.updateDeal(owner, {
      id: theirs,
      expectedVersion: 2,
      title: 'Annual plan',
      value: '',
      ownerMembershipId: owner.membership.id,
      expectedCloseOn: null,
    });
    await svc.closeDeal(owner, { id: theirs, expectedVersion: 3, outcome: 'won' });
    // A deal of nobody's and one of the owner's are not the agent's.
    for (const ownerMembershipId of [null, owner.membership.id]) {
      await svc.createDeal(owner, {
        contactId: jaya.id,
        pipelineId: s.salesId,
        stageId: proposal,
        title: 'Walk-in order',
        ownerMembershipId,
      });
    }

    // Only the agent's two events are captured: the addition for one endpoint, the move for both.
    expect(
      (await dealEventsOf(c)).map((e) => [e.type, e.detail.dealId, e.detail.stageId, e.deliveries]),
    ).toEqual([
      ['deal.created', theirs, s.sales[0], 1],
      ['deal.stage_changed', theirs, proposal, 2],
    ]);
    await deliverDue(c);
    const typesAt = (path: string) =>
      bodiesAt(path)
        .filter((b) => b.type.startsWith('deal.'))
        .map((b) => b.type)
        .sort();
    expect(typesAt(agents.path)).toEqual(['deal.created', 'deal.stage_changed']);
    expect(typesAt(agentsProposals.path)).toEqual(['deal.stage_changed']);
    // The payload gives the owner when it is delivered: the owner, since the deal was given away.
    for (const body of bodiesAt(agents.path).filter((b) => b.type.startsWith('deal.'))) {
      expect(dealIn(body).ownerId).toBe(owner.membership.id);
    }
    // Contact events are not narrowed by owners.
    expect(bodiesAt(agents.path).filter((b) => b.type === 'contact.created')).toHaveLength(1);
  });

  it('sends a change of owner with both owners, to the endpoints of either owner and of the deal’s pipeline, in its place among one request’s steps (ADR-269)', async () => {
    const s = await crmCompany();
    const { c, owner } = s;
    const agent = await fx.ctx(c, c.agent);
    const svc = crm();
    /** An endpoint of the company taking the events given, with the filters given. */
    const add = async (eventTypes: WebhookEventType[], filters: Record<string, unknown>) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes,
        ...filters,
      });
      return { ...created, path };
    };
    const everyone = await add(['deal.owner_changed', 'deal.status_changed'], {});
    const agents = await add(['deal.owner_changed'], { ownerIds: [agent.membership.id] });
    await add(['deal.owner_changed'], { pipelineIds: [s.renewalsId] });
    const jaya = await newContact(owner, 'Jaya');

    // The agent's deal in Sales is given to the owner, left without one, and given back; a change
    // of its title alone sends nothing, and no endpoint takes its addition.
    const { id: dealId } = await svc.createDeal(owner, {
      contactId: jaya.id,
      pipelineId: s.salesId,
      stageId: s.sales[0],
      title: 'Annual plan',
      ownerMembershipId: agent.membership.id,
    });
    const change = (version: number, title: string, ownerMembershipId: string | null) =>
      svc.updateDeal(owner, {
        id: dealId,
        expectedVersion: version,
        title,
        value: '',
        ownerMembershipId,
        expectedCloseOn: null,
      });
    await change(1, 'Annual plan', owner.membership.id);
    await change(2, 'Annual plan', null);
    await change(3, 'Annual plan', agent.membership.id);
    await change(4, 'Annual plan 2027', agent.membership.id);
    const owners = (e: EventRow) => [e.detail.ownerId ?? null, e.detail.previousOwnerId ?? null];
    // The agent's endpoint hears the deal leave the agent and come back; the Renewals one nothing.
    expect((await dealEventsOf(c)).map((e) => [e.type, ...owners(e), e.deliveries])).toEqual([
      ['deal.owner_changed', owner.membership.id, agent.membership.id, 2],
      ['deal.owner_changed', null, owner.membership.id, 1],
      ['deal.owner_changed', agent.membership.id, null, 2],
    ]);

    // A key gives the deal to the owner and wins it in one request: given, then won.
    const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'CRM sync', scopes: ['deals.write'], expiresInDays: 0 },
    );
    const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    if (!key) throw new Error('a new key does not authenticate');
    await apiUpdateDeal({ db: fx.dbs.app, clock: systemClock }, key, dealId, {
      ownerId: owner.membership.id,
      status: 'won',
    });
    const events = await dealEventsOf(c);
    expect(events.slice(3).map((e) => [e.type, e.status, ...owners(e), e.deliveries])).toEqual([
      ['deal.owner_changed', 'open', owner.membership.id, agent.membership.id, 2],
      ['deal.status_changed', 'won', null, null, 1],
    ]);

    // Delivered, each gives both owners as the change left them, whoever owns the deal by then.
    await deliverDue(c);
    const bodies = bodiesById(everyone.path);
    expect(bodies.size).toBe(5);
    for (const event of events.filter((e) => e.type === 'deal.owner_changed')) {
      const deal = dealIn(bodies.get(event.id));
      expect([deal?.ownerId, deal?.previousOwnerId], event.id).toEqual(owners(event));
      expect(dealOwnerChangedPayloadSchema.safeParse(bodies.get(event.id)).success).toBe(true);
    }
    const won = dealIn(bodies.get(events[4]!.id));
    expect([won?.status, won?.previousStatus, won?.previousOwnerId]).toEqual(['won', 'open', null]);
    expect(bodiesAt(agents.path).map((b) => b.type)).toEqual([
      'deal.owner_changed',
      'deal.owner_changed',
      'deal.owner_changed',
    ]);
  });

  it('sends a change of details naming what changed, to the endpoints of the deal’s pipeline and owner, in its place among one request’s steps, and for erasure’s retitling (ADR-275)', async () => {
    const s = await crmCompany();
    const { c, owner } = s;
    const agent = await fx.ctx(c, c.agent);
    const svc = crm();
    /** An endpoint of the company taking the events given, with the filters given. */
    const add = async (eventTypes: WebhookEventType[], filters: Record<string, unknown>) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes,
        ...filters,
      });
      return { ...created, path };
    };
    const everyone = await add(['deal.updated', 'deal.owner_changed', 'deal.status_changed'], {});
    const agents = await add(['deal.updated'], { ownerIds: [agent.membership.id] });
    const renewals = await add(['deal.updated'], { pipelineIds: [s.renewalsId] });
    const jaya = await newContact(owner, 'Jaya');

    // The agent's deal in Sales: its title alone, then its value and date, then nothing (the same
    // details again, which keeps the version), then its title with its owner; no endpoint takes its
    // addition.
    const { id: dealId } = await svc.createDeal(owner, {
      contactId: jaya.id,
      pipelineId: s.salesId,
      stageId: s.sales[0],
      title: 'Annual plan',
      ownerMembershipId: agent.membership.id,
    });
    const change = (
      version: number,
      title: string,
      value: string,
      expectedCloseOn: string | null,
      ownerMembershipId: string | null,
    ) =>
      svc.updateDeal(owner, {
        id: dealId,
        expectedVersion: version,
        title,
        value,
        ownerMembershipId,
        expectedCloseOn,
      });
    await change(1, 'Annual plan 2027', '', null, agent.membership.id);
    await change(2, 'Annual plan 2027', '1,200', '2026-12-31', agent.membership.id);
    await change(3, 'Annual plan 2027', '1,200', '2026-12-31', agent.membership.id);
    await change(3, 'Annual plan, renewed', '1,200', '2026-12-31', owner.membership.id);
    const changesOf = (e: EventRow) => (e.detail.changes as string[] | undefined) ?? null;
    // Captured with what changed; the agent's endpoint hears the changes made while the deal was
    // the agent's, the one made with the change of owner included: its details change before its
    // owner among the request's steps (Codex review of PR #39). Renewals hears none.
    expect((await dealEventsOf(c)).map((e) => [e.type, changesOf(e), e.deliveries])).toEqual([
      ['deal.updated', ['title'], 2],
      ['deal.updated', ['valueMinor', 'expectedCloseOn'], 2],
      ['deal.updated', ['title'], 2],
      ['deal.owner_changed', null, 1],
    ]);

    // A key clears the value and wins the deal in one request: details changed, then won.
    const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'CRM sync', scopes: ['deals.write'], expiresInDays: 0 },
    );
    const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    if (!key) throw new Error('a new key does not authenticate');
    await apiUpdateDeal({ db: fx.dbs.app, clock: systemClock }, key, dealId, {
      valueMinor: null,
      status: 'won',
    });
    const events = await dealEventsOf(c);
    expect(events.slice(4).map((e) => [e.type, e.status, changesOf(e), e.deliveries])).toEqual([
      ['deal.updated', 'open', ['valueMinor'], 1],
      ['deal.status_changed', 'won', null, 1],
    ]);

    // Erasing the contact retitles the deal, as the definer role, for an endpoint naming owners
    // too: the agent's deal, given back to the agent first, reaches the agent's endpoint.
    await apiUpdateDeal({ db: fx.dbs.app, clock: systemClock }, key, dealId, {
      ownerId: agent.membership.id,
    });
    await contactsService().eraseContact(owner, { contactId: jaya.id, suppress: false });
    const erased = (await dealEventsOf(c)).slice(7);
    expect(erased.map((e) => [e.type, e.status, changesOf(e), e.deliveries])).toEqual([
      ['deal.updated', 'won', ['title'], 2],
    ]);

    // Delivered, each names what changed and gives the deal as it is then: erased.
    await deliverDue(c);
    const bodies = bodiesById(everyone.path);
    expect(bodies.size).toBe(8);
    for (const event of [...events, ...erased].filter((e) => e.type === 'deal.updated')) {
      const body = bodies.get(event.id);
      expect(dealUpdatedPayloadSchema.safeParse(body).success, event.id).toBe(true);
      expect((body?.data as { changes?: unknown }).changes, event.id).toEqual(changesOf(event));
      expect(dealIn(body)).toMatchObject({ title: 'Deal (contact erased)', valueMinor: null });
    }
    expect(bodiesAt(agents.path).map((b) => b.type)).toEqual(Array<string>(4).fill('deal.updated'));
    expect(bodiesAt(renewals.path)).toEqual([]);
  });

  it('names who made each change: a member, the automation or the key, nobody for a change that did not record it, as erasure’s, and keeps a changer to its own transaction (ADR-277)', async () => {
    const s = await crmCompany();
    const { c, owner } = s;
    const hook = await addEndpoint(c, ['deal.updated', 'deal.stage_changed']);
    const svc = crm();
    const jaya = await newContact(owner, 'Jaya');
    const { id: dealId } = await svc.createDeal(owner, {
      contactId: jaya.id,
      pipelineId: s.salesId,
      stageId: s.sales[0],
      title: 'Annual plan',
      ownerMembershipId: null,
    });
    const changerOf = async () =>
      (
        await fx.query<{ by: string | null; key: string | null }>(
          'SELECT changed_by AS by, changed_by_api_key_id AS key FROM app.crm_deals WHERE id = $1',
          [dealId],
        )
      )[0];
    const set = (assignments: string) =>
      fx.query(`UPDATE app.crm_deals SET ${assignments} WHERE id = $1`, [dealId]);

    // A member moves it and a key retitles it, each recorded with its change.
    await svc.moveDeal(owner, { id: dealId, expectedVersion: 1, stageId: s.sales[1] });
    expect(await changerOf()).toEqual({ by: 'member', key: null });
    const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'CRM sync', scopes: ['deals.write'], expiresInDays: 0 },
    );
    const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    if (!key) throw new Error('a new key does not authenticate');
    await apiUpdateDeal({ db: fx.dbs.app, clock: systemClock }, key, dealId, {
      title: 'Annual plan 2027',
    });
    expect(await changerOf()).toEqual({ by: 'api', key: key.key.id });

    // A change that does not record its maker (a server from before this release) names nobody:
    // the key's record is an earlier transaction's. Recorded by another transaction, a changer is
    // cleared too; recorded by its own, it stays; a write of nothing the events report leaves it.
    await set(`title = 'Annual plan, renewed'`);
    expect(await changerOf()).toEqual({ by: null, key: null });
    await set(`value_minor = 100000, changed_by = 'member', changed_xact = '1'::xid8`);
    expect(await changerOf()).toEqual({ by: null, key: null });
    await set(
      `expected_close_on = '2026-12-31', changed_by = 'automation',
       changed_xact = pg_catalog.pg_current_xact_id()`,
    );
    expect(await changerOf()).toEqual({ by: 'automation', key: null });
    await set('stage_entered_at = now()');
    expect(await changerOf()).toEqual({ by: 'automation', key: null });

    // Erasure retitles it and records nobody.
    await contactsService().eraseContact(owner, { contactId: jaya.id, suppress: false });
    expect(await changerOf()).toEqual({ by: null, key: null });

    // Each event, and its payload when delivered, names the maker of its change as captured.
    const events = await dealEventsOf(c);
    const makers = [
      ['member', null],
      ['api', key.key.id],
      [null, null],
      [null, null],
      ['automation', null],
      [null, null],
    ];
    expect(events.map((e) => [e.type, e.detail.changedBy, e.detail.apiKeyId])).toEqual([
      ['deal.stage_changed', ...makers[0]!],
      ...makers.slice(1).map((m) => ['deal.updated', ...m]),
    ]);
    await deliverDue(c);
    const bodies = bodiesById(hook.path);
    expect(
      events.map((e) => [dealIn(bodies.get(e.id)).changedBy, dealIn(bodies.get(e.id)).apiKeyId]),
    ).toEqual(makers);

    // The database keeps the changer to a member, an automation or a key of the deal's company,
    // named only for a key's change, and the runtime role records it.
    for (const bad of [
      `changed_by = 'api', changed_by_api_key_id = NULL`,
      `changed_by = 'member', changed_by_api_key_id = '${key.key.id}'`,
      `changed_by = NULL, changed_by_api_key_id = '${key.key.id}'`,
      `changed_by = 'payment_link', changed_by_api_key_id = NULL`,
    ]) {
      await expect(set(bad), bad).rejects.toThrow(/crm_deals_changed_by"/);
    }
    const other = await fx.company();
    await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      await fx.ctx(other, other.owner),
      { name: 'Elsewhere', scopes: ['deals.write'], expiresInDays: 0 },
    );
    const [theirKey] = await fx.query<{ id: string }>(
      'SELECT id FROM app.api_keys WHERE tenant_id = $1 AND name = $2',
      [other.tenant.id, 'Elsewhere'],
    );
    await expect(
      set(`changed_by = 'api', changed_by_api_key_id = '${theirKey!.id}'`),
    ).rejects.toThrow(/crm_deals_changed_by_api_key_fk/);
    await set(`changed_by = 'api', changed_by_api_key_id = '${key.key.id}'`);
    expect(await changerOf()).toEqual({ by: 'api', key: key.key.id });
    const grants = await fx.query<{ t: string; c: string; can: boolean }>(
      `SELECT t, c, has_column_privilege('w360_app', t, c, 'UPDATE') AS can
         FROM unnest(ARRAY['app.crm_deals', 'app.crm_tasks']) AS t,
              unnest(ARRAY['changed_by', 'changed_by_api_key_id', 'changed_xact']) AS c`,
    );
    expect(grants.map((g) => [g.t, g.c, g.can]).sort()).toEqual(
      ['app.crm_deals', 'app.crm_tasks']
        .flatMap((table) =>
          ['changed_by', 'changed_by_api_key_id', 'changed_xact'].map((column) => [
            table,
            column,
            true,
          ]),
        )
        .sort(),
    );
  });

  it('sends an endpoint that names deal statuses only the closes and reopenings that reached one of them (ADR-309)', async () => {
    const s = await crmCompany();
    const { c, owner } = s;
    /** An endpoint of the company taking deals' status changes with these statuses. */
    const add = async (dealStatuses: string[] | null) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes: ['deal.status_changed'],
        dealStatuses,
      });
      return path;
    };
    const wins = await add(['won']);
    const setbacks = await add(['open', 'lost']);
    const everyStatus = await add(null);
    const svc = crm();
    const jaya = await newContact(owner, 'Jaya');

    // A deal won, reopened, then lost.
    const { id: dealId } = await svc.createDeal(owner, {
      contactId: jaya.id,
      pipelineId: s.salesId,
      stageId: s.sales[0],
      title: 'Annual plan',
      value: '1,000',
      ownerMembershipId: owner.membership.id,
      expectedCloseOn: null,
    });
    await svc.closeDeal(owner, { id: dealId, expectedVersion: 1, outcome: 'won' });
    await svc.reopenDeal(owner, { id: dealId, expectedVersion: 2 });
    await svc.closeDeal(owner, {
      id: dealId,
      expectedVersion: 3,
      outcome: 'lost',
      lostReason: 'Budget cut',
    });

    // Each change captured once, with a delivery to each endpoint whose list holds the status
    // reached; the addition, which no endpoint takes, is not recorded.
    const events = await dealEventsOf(c);
    expect(events.map((e) => [e.type, e.status, e.deliveries])).toEqual([
      ['deal.status_changed', 'won', 2],
      ['deal.status_changed', 'open', 2],
      ['deal.status_changed', 'lost', 2],
    ]);
    await deliverDue(c);
    const statusesAt = (path: string) =>
      bodiesAt(path)
        .map((b) => dealIn(b).status as string)
        .sort();
    expect(statusesAt(wins)).toEqual(['won']);
    expect(statusesAt(setbacks)).toEqual(['lost', 'open']);
    expect(statusesAt(everyStatus)).toEqual(['lost', 'open', 'won']);
  });

  it('sends an endpoint that names deal details only the changes that changed one of them, each naming every detail it changed (ADR-310)', async () => {
    const s = await crmCompany();
    const { c, owner } = s;
    /** An endpoint of the company taking deals' detail changes for these details. */
    const add = async (dealDetails: string[] | null) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes: ['deal.updated'],
        dealDetails,
      });
      return path;
    };
    const forecast = await add(['valueMinor', 'expectedCloseOn']);
    const titles = await add(['title']);
    const everyChange = await add(null);
    const svc = crm();
    const jaya = await newContact(owner, 'Jaya');
    const { id: dealId } = await svc.createDeal(owner, {
      contactId: jaya.id,
      pipelineId: s.salesId,
      stageId: s.sales[0],
      title: 'Annual plan',
      value: '1,000',
      ownerMembershipId: owner.membership.id,
      expectedCloseOn: null,
    });
    const edit = (
      expectedVersion: number,
      title: string,
      value: string,
      expectedCloseOn: string | null,
    ) =>
      svc.updateDeal(owner, {
        id: dealId,
        expectedVersion,
        title,
        value,
        ownerMembershipId: owner.membership.id,
        expectedCloseOn,
      });

    // The deal is retitled, given another value, then retitled with a close date.
    await edit(1, 'Annual plan 2027', '1,000', null);
    await edit(2, 'Annual plan 2027', '1,500', null);
    await edit(3, 'Annual plan 2027, renewed', '1,500', '2027-03-31');

    // Each change captured once, with a delivery to each endpoint whose list holds a detail it
    // changed.
    const events = await dealEventsOf(c);
    expect(events.map((e) => [e.type, e.detail.changes, e.deliveries])).toEqual([
      ['deal.updated', ['title'], 2],
      ['deal.updated', ['valueMinor'], 2],
      ['deal.updated', ['title', 'expectedCloseOn'], 3],
    ]);
    await deliverDue(c);
    const changesAt = (path: string) =>
      bodiesAt(path)
        .map((b) => (b.data.changes as string[]).join('+'))
        .sort();
    expect(changesAt(forecast)).toEqual(['title+expectedCloseOn', 'valueMinor']);
    expect(changesAt(titles)).toEqual(['title', 'title+expectedCloseOn']);
    expect(changesAt(everyChange)).toEqual(['title', 'title+expectedCloseOn', 'valueMinor']);
  });
});

describe('change-maker filters for deal, task and note events (ADR-306)', () => {
  const crm = () =>
    createCrmService({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });

  it('sends an endpoint that names who made the changes only the deal, task and note events of their changes, each addition by whoever added it and each note by whoever wrote it, and every change whose maker was not recorded', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const svc = crm();
    const { id: salesId } = await svc.createPipeline(owner, {
      name: 'Sales',
      currency: 'INR',
      stages: ['New', 'Qualified'],
    });
    const [sales] = (await svc.listPipelines(owner)).filter((p) => p.id === salesId);
    const [fresh, qualified] = sales!.stages.map((st) => st.id);
    const eventTypes: WebhookEventType[] = [
      'deal.created',
      'deal.updated',
      'deal.stage_changed',
      'task.created',
      'note.created',
    ];
    /** An endpoint of the company taking the CRM events of the changes the makers made. */
    const add = async (crmChangeMakers: WebhookCrmChangeMaker[] | null) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes,
        crmChangeMakers,
      });
      return { ...created, path };
    };
    const people = await add(['member', 'automation']);
    const keys = await add(['api']);
    const everyone = await add(null);
    const phone = `+${waId()}`;
    const { id: jaya } = await contactsService().createContact(owner, {
      displayName: 'Jaya',
      phone,
    });
    const issued = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'CRM sync', scopes: ['deals.write', 'tasks.write', 'notes.write'], expiresInDays: 0 },
    );
    const key = await authenticateApiToken(fx.dbs.app, issued.token, uuidv7());
    if (!key) throw new Error('a new key does not authenticate');
    const apiDeps = { db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer };

    // A member adds a deal and the key another; the member moves the key's and the key retitles
    // the member's.
    const { id: membersDeal } = await svc.createDeal(owner, {
      contactId: jaya,
      pipelineId: salesId,
      stageId: fresh,
      title: 'Annual plan',
      ownerMembershipId: null,
    });
    const response = await apiCreateDeal(
      apiDeps,
      key,
      { contactId: jaya, pipelineId: salesId, title: 'Web order' },
      null,
    );
    const keysDeal = (response.body as { data: { id: string } }).data.id;
    await svc.moveDeal(owner, { id: keysDeal, expectedVersion: 1, stageId: qualified });
    await apiUpdateDeal(apiDeps, key, membersDeal, { title: 'Annual plan 2027' });
    // An automation's run changes the value, recording itself as runs do (no key: the key's
    // retitle was recorded before), and a change that records no maker retitles the key's deal.
    const set = (id: string, assignments: string) =>
      fx.query(`UPDATE app.crm_deals SET ${assignments} WHERE id = $1`, [id]);
    await set(
      membersDeal,
      `value_minor = 100000, changed_by = 'automation', changed_by_api_key_id = NULL,
       changed_xact = pg_catalog.pg_current_xact_id()`,
    );
    await set(keysDeal, `title = 'Web order 1001'`);
    // The key adds a task and a member another; the member writes a note and the key another.
    const taskResponse = await apiCreateTask(
      apiDeps,
      key,
      { title: 'Confirm the delivery', assigneeId: owner.membership.id, contactId: jaya },
      null,
    );
    const keysTask = (taskResponse.body as { data: { id: string } }).data.id;
    const { id: membersTask } = await svc.createTask(owner, {
      title: 'Send the quote',
      assigneeMembershipId: owner.membership.id,
      dealId: membersDeal,
    });
    const membersNote = await svc.addNote(owner, { dealId: membersDeal, body: 'Wants a discount' });
    const noteResponse = await apiCreateNote(
      apiDeps,
      key,
      { body: 'Synced from the shop', dealId: keysDeal },
      null,
    );
    const keysNote = (noteResponse.body as { data: { id: string } }).data.id;

    // Each event is captured once, with a delivery to each endpoint its maker reaches; a change
    // that recorded no maker reaches all three.
    const captured = await fx.query<{ type: string; subject: string; deliveries: number }>(
      `SELECT e.type, coalesce(e.detail ->> 'dealId', e.detail ->> 'taskId', e.detail ->> 'noteId')
              AS subject,
              (SELECT count(*)::int FROM app.webhook_deliveries d
                WHERE d.tenant_id = e.tenant_id AND d.event_id = e.id) AS deliveries
         FROM app.webhook_events e
        WHERE e.tenant_id = $1 ORDER BY e.occurred_at, e.id`,
      [c.tenant.id],
    );
    expect(captured.map((e) => [e.type, e.subject, e.deliveries])).toEqual([
      ['deal.created', membersDeal, 2],
      ['deal.created', keysDeal, 2],
      ['deal.stage_changed', keysDeal, 2],
      ['deal.updated', membersDeal, 2],
      ['deal.updated', membersDeal, 2],
      ['deal.updated', keysDeal, 3],
      ['task.created', keysTask, 2],
      ['task.created', membersTask, 2],
      ['note.created', membersNote.id, 2],
      ['note.created', keysNote, 2],
    ]);
    await deliverDue(c);
    // Each payload names its maker as the endpoint chose it.
    const madeBy = (path: string) =>
      bodiesAt(path)
        .map((b) => {
          const data = b.data as {
            deal?: { changedBy: string | null };
            task?: { changedBy: string | null };
            note?: { writtenBy: string };
          };
          return [
            b.type,
            data.deal?.changedBy ?? data.task?.changedBy ?? data.note?.writtenBy ?? null,
          ];
        })
        .sort();
    expect(madeBy(people.path)).toEqual(
      [
        ['deal.created', 'member'],
        ['deal.stage_changed', 'member'],
        ['deal.updated', 'automation'],
        ['deal.updated', null],
        ['task.created', 'member'],
        ['note.created', 'member'],
      ].sort(),
    );
    expect(madeBy(keys.path)).toEqual(
      [
        ['deal.created', 'api'],
        ['deal.updated', 'api'],
        ['deal.updated', null],
        ['task.created', 'api'],
        ['note.created', 'api'],
      ].sort(),
    );
    expect(madeBy(everyone.path)).toHaveLength(10);
  });
});

describe('API keys left out of deal, task and note events (ADR-321)', () => {
  const crm = () =>
    createCrmService({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });

  it('leaves out of an endpoint the changes the keys it names made, across a rotation either way, and sends every other change', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const svc = crm();
    const { id: salesId } = await svc.createPipeline(owner, {
      name: 'Sales',
      currency: 'INR',
      stages: ['New', 'Qualified'],
    });
    const [sales] = (await svc.listPipelines(owner)).filter((p) => p.id === salesId);
    const [fresh] = sales!.stages.map((st) => st.id);
    const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
    const shop = await keys.create(owner, {
      name: 'Shop',
      scopes: ['deals.write', 'tasks.write', 'notes.write'],
      expiresInDays: 0,
    });
    const sync = await keys.create(owner, {
      name: 'Sync',
      scopes: ['deals.write', 'notes.write'],
      expiresInDays: 0,
    });
    const add = async (crmExcludedApiKeyIds: string[] | null) =>
      (
        await webhooks().create(owner, {
          url: `http://${HOST}:${port}/ok/${randomBytes(6).toString('hex')}`,
          eventTypes: ['deal.created', 'deal.updated', 'task.created', 'note.created'],
          crmExcludedApiKeyIds,
        })
      ).id;
    const every = await add(null);
    const notShop = await add([shop.id]);
    const notSync = await add([sync.id]);
    // The shop's key is rotated: the old key works for a day more. An endpoint names the new one.
    const shop2 = await keys.rotate(owner, { keyId: shop.id, overlapHours: 24 });
    const notShop2 = await add([shop2.id]);
    const keyCtx = async (token: string) => {
      const ctx = await authenticateApiToken(fx.dbs.app, token, uuidv7());
      if (!ctx) throw new Error('a key does not authenticate');
      return ctx;
    };
    const apiDeps = { db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer };
    const { id: jaya } = await contactsService().createContact(owner, {
      displayName: 'Jaya',
      phone: `+${waId()}`,
    });

    // A member adds a deal; the old key adds another; the new key retitles the member's.
    const { id: membersDeal } = await svc.createDeal(owner, {
      contactId: jaya,
      pipelineId: salesId,
      stageId: fresh,
      title: 'Annual plan',
      ownerMembershipId: null,
    });
    const created = await apiCreateDeal(
      apiDeps,
      await keyCtx(shop.token),
      { contactId: jaya, pipelineId: salesId, title: 'Web order' },
      null,
    );
    const shopsDeal = (created.body as { data: { id: string } }).data.id;
    await apiUpdateDeal(apiDeps, await keyCtx(shop2.token), membersDeal, {
      title: 'Annual plan 2027',
    });
    // The new key adds a task, the sync's key writes a note, and a change that records no maker
    // retitles the shop's deal.
    const taskResponse = await apiCreateTask(
      apiDeps,
      await keyCtx(shop2.token),
      { title: 'Confirm the delivery', assigneeId: owner.membership.id, contactId: jaya },
      null,
    );
    const shopsTask = (taskResponse.body as { data: { id: string } }).data.id;
    const noteResponse = await apiCreateNote(
      apiDeps,
      await keyCtx(sync.token),
      { body: 'Synced from the shop', dealId: membersDeal },
      null,
    );
    const syncsNote = (noteResponse.body as { data: { id: string } }).data.id;
    await fx.query(`UPDATE app.crm_deals SET title = 'Web order 1001' WHERE id = $1`, [shopsDeal]);

    const sent = await fx.query<{ type: string; subject: string; endpoint: string }>(
      `SELECT e.type, coalesce(e.detail ->> 'dealId', e.detail ->> 'taskId', e.detail ->> 'noteId')
              AS subject, d.endpoint_id AS endpoint
         FROM app.webhook_deliveries d
         JOIN app.webhook_events e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
        WHERE d.tenant_id = $1`,
      [c.tenant.id],
    );
    const endpointName = new Map([
      [every, 'every change'],
      [notShop, 'not the old key'],
      [notSync, 'not the sync key'],
      [notShop2, 'not the new key'],
    ]);
    const subjectName = new Map([
      [membersDeal, "the member's deal"],
      [shopsDeal, "the shop's deal"],
      [shopsTask, "the shop's task"],
      [syncsNote, "the sync's note"],
    ]);
    const sorted = (rows: unknown[][]) =>
      [...rows].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    const all = ['every change', 'not the old key', 'not the sync key', 'not the new key'];
    const to = (type: string, subject: string, endpoints: string[]) =>
      endpoints.map((endpoint) => [type, subject, endpoint]);
    expect(
      sorted(sent.map((s) => [s.type, subjectName.get(s.subject), endpointName.get(s.endpoint)])),
    ).toEqual(
      sorted([
        // A member's change reaches every endpoint.
        ...to('deal.created', "the member's deal", all),
        // The old key's change is left out by the lists naming it and the key it was rotated into…
        ...to('deal.created', "the shop's deal", ['every change', 'not the sync key']),
        // …and the new key's by the lists naming it and the key it replaced.
        ...to('deal.updated', "the member's deal", ['every change', 'not the sync key']),
        ...to('task.created', "the shop's task", ['every change', 'not the sync key']),
        ...to('note.created', "the sync's note", [
          'every change',
          'not the old key',
          'not the new key',
        ]),
        // A change that recorded no maker is left out by no list.
        ...to('deal.updated', "the shop's deal", all),
      ]),
    );
  });
});

describe('task events (ADR-261)', () => {
  const crm = () =>
    createCrmService({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });
  const TASK_EVENTS: WebhookEventType[] = ['task.created', 'task.status_changed'];
  const payloadSchemas = {
    'task.created': taskCreatedPayloadSchema,
    'task.status_changed': taskStatusChangedPayloadSchema,
  } as const;

  /** A contact a member adds, with a number; its id and number. */
  async function newContact(owner: TenantContext, name: string) {
    const phone = `+${waId()}`;
    const { id } = await contactsService().createContact(owner, { displayName: name, phone });
    return { id, phone };
  }

  /** The company's task events in the order they were captured, with their delivery counts. */
  const taskEventsOf = (c: Company) =>
    fx.query<EventRow & { occurred_at: Date }>(
      `SELECT e.id, e.type, e.status, e.detail, e.conversation_id, e.contact_id, e.occurred_at,
              (SELECT count(*)::int FROM app.webhook_deliveries d
                WHERE d.tenant_id = e.tenant_id AND d.event_id = e.id) AS deliveries
         FROM app.webhook_events e
        WHERE e.tenant_id = $1 AND e.type LIKE 'task.%' ORDER BY e.occurred_at, e.id`,
      [c.tenant.id],
    );

  /** The bodies the receiver got on a path, by event id: deliveries are sent concurrently. */
  const bodiesById = (path: string) => new Map(bodiesAt(path).map((b) => [b.id, b]));

  const taskIn = (body: { data: Record<string, unknown> } | undefined) =>
    body?.data.task as Record<string, unknown>;

  it('sends each task added and every completion, cancellation and reopening, from members, an automation and an API key', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const hook = await addEndpoint(c, TASK_EVENTS);
    const closes = await addEndpoint(c, ['task.status_changed']);
    const contactsOnly = await addEndpoint(c, ['contact.created']);
    const svc = crm();
    const jaya = await newContact(owner, 'Jaya');

    // A member adds a task about Jaya, completes, reopens and cancels it; an edit of its details
    // and reminder sends nothing. Another member adds a task about nobody.
    const { id: taskId } = await svc.createTask(agent, {
      title: 'Call Jaya',
      assigneeMembershipId: agent.membership.id,
      contactId: jaya.id,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await svc.completeTask(agent, { id: taskId, expectedVersion: 1 });
    await svc.reopenTask(agent, { id: taskId, expectedVersion: 2 });
    await svc.updateTask(agent, {
      id: taskId,
      expectedVersion: 3,
      title: 'Call Jaya back',
      notes: 'Ring 98450 12345 after Diwali',
      dueAt: null,
      remindAt: new Date(Date.now() + 3_600_000).toISOString(),
      assigneeMembershipId: owner.membership.id,
    });
    await svc.cancelTask(agent, { id: taskId, expectedVersion: 4 });
    const { id: soloId } = await svc.createTask(owner, {
      title: 'Order brochures',
      assigneeMembershipId: owner.membership.id,
    });

    // An API key adds a task about Jaya and completes it; a retry changes nothing.
    const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'Order system', scopes: ['tasks.write'], expiresInDays: 0 },
    );
    const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    if (!key) throw new Error('a new key does not authenticate');
    const apiDeps = { db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer };
    const response = await apiCreateTask(
      apiDeps,
      key,
      { title: 'Confirm the delivery', assigneeId: agent.membership.id, contactId: jaya.id },
      null,
    );
    const apiTaskId = (response.body as { data: { id: string } }).data.id;
    await apiUpdateTask(apiDeps, key, apiTaskId, { status: 'done' });
    await apiUpdateTask(apiDeps, key, apiTaskId, { status: 'done' });

    // An automation adds a task for the customer who writes.
    const automations = createAutomationService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
    });
    const { id: automationId } = await automations.createAutomation(owner, { name: 'Leads' });
    const saved = await automations.updateAutomation(owner, {
      id: automationId,
      expectedVersion: 0,
      name: 'Leads',
      description: null,
      channelAccountId: null,
      trigger: {
        type: 'keyword',
        keywords: ['price'],
        match: 'contains',
        hours: 'any',
        cooldownMinutes: 0,
      },
      graph: {
        version: 1,
        start: 'task',
        nodes: [
          {
            id: 'task',
            type: 'create_task',
            title: 'Quote for {{name}}',
            assigneeMembershipId: agent.membership.id,
            dueInHours: 4,
            next: null,
          },
        ],
      },
    });
    expect(saved.issues).toEqual([]);
    await automations.publishAutomation(owner, {
      id: automationId,
      expectedVersion: saved.version,
      note: null,
    });
    const from = waId();
    const { conversation_id: conversationId, contact_id: customerId } = await inbound(
      c,
      from,
      'what is the price?',
    );
    const [run] = await fx.query<{ id: string }>(
      'SELECT id FROM app.automation_runs WHERE conversation_id = $1',
      [conversationId],
    );
    const advanced = await advanceAutomationRun(
      {
        db: fx.dbs.app,
        jobs: fx.jobs(),
        signer: fx.signer,
        clock: systemClock,
        keyring: fx.keyring,
      },
      authorizedTenantScope(c.tenant.id, null),
      run!.id,
      null,
    );
    expect(advanced.outcome).toBe('ended');
    const [byRun] = await fx.query<{ id: string }>(
      'SELECT id FROM app.crm_tasks WHERE tenant_id = $1 AND created_by_automation_id = $2',
      [c.tenant.id, automationId],
    );
    const runTaskId = byRun!.id;

    // One event per addition and status change, in order, each to the endpoints that take it, with
    // who made each change (ADR-277).
    const events = await taskEventsOf(c);
    const byMember = { changedBy: 'member', apiKeyId: null };
    const byKey = { changedBy: 'api', apiKeyId: key.key.id };
    expect(events.map((e) => [e.type, e.status, e.detail, e.contact_id, e.deliveries])).toEqual([
      ['task.created', 'open', { taskId }, jaya.id, 1],
      ['task.status_changed', 'done', { taskId, previousStatus: 'open', ...byMember }, jaya.id, 2],
      ['task.status_changed', 'open', { taskId, previousStatus: 'done', ...byMember }, jaya.id, 2],
      [
        'task.status_changed',
        'cancelled',
        { taskId, previousStatus: 'open', ...byMember },
        jaya.id,
        2,
      ],
      ['task.created', 'open', { taskId: soloId }, null, 1],
      ['task.created', 'open', { taskId: apiTaskId }, jaya.id, 1],
      [
        'task.status_changed',
        'done',
        { taskId: apiTaskId, previousStatus: 'open', ...byKey },
        jaya.id,
        2,
      ],
      ['task.created', 'open', { taskId: runTaskId }, customerId, 1],
    ]);
    expect(events.every((e) => e.conversation_id === null)).toBe(true);

    // Built when delivered: the status and the one before it as captured, the rest as it is now,
    // never the notes.
    await deliverDue(c);
    const bodies = bodiesById(hook.path);
    expect([...bodies.keys()].sort()).toEqual(events.map((e) => e.id).sort());
    const delivered = events.map((e) => bodies.get(e.id)!);
    for (const body of delivered) {
      const schema = payloadSchemas[body.type as keyof typeof payloadSchemas];
      expect(schema.safeParse(body).success).toBe(true);
      expect(JSON.stringify(body)).not.toContain('98450');
    }
    expect(delivered.map((b) => b.createdAt)).toEqual(
      events.map((e) => e.occurred_at.toISOString()),
    );
    expect(
      delivered.map((b) => {
        const t = taskIn(b);
        return [b.type, t.id, t.status, t.previousStatus, t.createdBy];
      }),
    ).toEqual([
      ['task.created', taskId, 'open', null, 'member'],
      ['task.status_changed', taskId, 'done', 'open', 'member'],
      ['task.status_changed', taskId, 'open', 'done', 'member'],
      ['task.status_changed', taskId, 'cancelled', 'open', 'member'],
      ['task.created', soloId, 'open', null, 'member'],
      ['task.created', apiTaskId, 'open', null, 'api'],
      ['task.status_changed', apiTaskId, 'done', 'open', 'api'],
      ['task.created', runTaskId, 'open', null, 'automation'],
    ]);
    // Who made each: an addition's maker is the task's creator, a change's as captured (ADR-277).
    expect(delivered.map((b) => [taskIn(b).changedBy, taskIn(b).apiKeyId])).toEqual([
      ['member', null],
      ['member', null],
      ['member', null],
      ['member', null],
      ['member', null],
      ['api', key.key.id],
      ['api', key.key.id],
      ['automation', null],
    ]);
    const [jayaTask] = await fx.query<{ created_at: Date }>(
      'SELECT created_at FROM app.crm_tasks WHERE id = $1',
      [taskId],
    );
    for (const body of delivered.slice(0, 4)) {
      expect(taskIn(body)).toMatchObject({
        title: 'Call Jaya back',
        dueAt: null,
        assigneeId: owner.membership.id,
        dealId: null,
        createdAt: jayaTask!.created_at.toISOString(),
      });
      expect(body.data.contact).toEqual({ id: jaya.id, phone: jaya.phone, name: 'Jaya' });
    }
    expect(delivered[4]!.data.contact).toBeNull();
    // The automation's task is due four hours after its step ran, about its customer.
    expect(taskIn(delivered[7])).toMatchObject({
      title: 'Quote for Priya Customer',
      assigneeId: agent.membership.id,
      dueAt: expect.any(String),
    });
    expect(delivered[7]!.data.contact).toEqual({
      id: customerId,
      phone: `+${from}`,
      name: 'Priya Customer',
    });
    // An endpoint for status changes hears only those; one for contacts hears no task.
    expect([...bodiesById(closes.path).keys()].sort()).toEqual(
      events
        .filter((e) => e.type === 'task.status_changed')
        .map((e) => e.id)
        .sort(),
    );
    expect(bodiesAt(contactsOnly.path).map((b) => b.type)).toEqual([
      'contact.created',
      'contact.created',
    ]);

    // The API reads who added each task as task.created says it (ADR-282).
    const reading = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'Task sync', scopes: ['tasks.read'], expiresInDays: 0 },
    );
    const reader = await authenticateApiToken(fx.dbs.app, reading.token, uuidv7());
    if (!reader) throw new Error('a new key does not authenticate');
    const creators: [string, string | null][] = [];
    for (const id of [taskId, soloId, apiTaskId, runTaskId]) {
      const { createdBy, createdByApiKeyId } = await apiGetTask(apiDeps, reader, id);
      creators.push([createdBy, createdByApiKeyId]);
    }
    expect(creators).toEqual([
      ['member', null],
      ['member', null],
      ['api', key.key.id],
      ['automation', null],
    ]);
  });

  it('sends nothing without an endpoint for tasks or for a merge or an erasure, names the contact a merge gave, and fails a delivery whose task erasure deleted', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const svc = crm();
    // No endpoint takes task events: a task and its changes capture nothing.
    await addEndpoint(c, ['contact.created', 'deal.created']);
    const quiet = await newContact(owner, 'Quiet');
    const { id: quietTask } = await svc.createTask(owner, {
      title: 'Quiet task',
      assigneeMembershipId: owner.membership.id,
      contactId: quiet.id,
    });
    await svc.completeTask(owner, { id: quietTask, expectedVersion: 1 });
    expect(await taskEventsOf(c)).toEqual([]);

    // An endpoint that names numbers still receives task events: they happen on no number.
    const hook = await addNumberEndpoint(
      c,
      ['task.created', 'task.status_changed', 'message.received'],
      [c.channelAccountId],
    );
    // A customer who wrote by WhatsApp user id gets a task; merged into a contact a member added,
    // the task moves with it and the merge captures nothing.
    const merged = await writesByUserId(c);
    const { id: movedTask } = await svc.createTask(owner, {
      title: 'Send the catalogue',
      assigneeMembershipId: owner.membership.id,
      contactId: merged,
    });
    const kept = await newContact(owner, 'Asha');
    await createContactMergeService({ db: fx.dbs.app, clock: systemClock }).mergeContacts(owner, {
      keepContactId: kept.id,
      mergeContactId: merged,
    });
    expect((await taskEventsOf(c)).map((e) => [e.type, e.contact_id, e.deliveries])).toEqual([
      ['task.created', merged, 1],
    ]);
    // Delivered after the merge, it names the contact the task belongs to now.
    await deliverDue(c);
    const [added] = bodiesAt(hook.path).filter((b) => b.type.startsWith('task.'));
    expect(taskIn(added)).toMatchObject({ id: movedTask, title: 'Send the catalogue' });
    expect(added!.data.contact).toEqual({ id: kept.id, phone: kept.phone, name: 'Asha' });

    // Completed, then erased before its delivery: erasure deletes the task, captures nothing, and
    // the completion fails without an attempt.
    await svc.completeTask(owner, { id: movedTask, expectedVersion: 1 });
    await contactsService().eraseContact(owner, { contactId: kept.id, suppress: false });
    const events = await taskEventsOf(c);
    expect(events.map((e) => [e.type, e.status])).toEqual([
      ['task.created', 'open'],
      ['task.status_changed', 'done'],
    ]);
    await deliverDue(c);
    expect(
      await fx.query(
        'SELECT state, attempts, last_error FROM app.webhook_deliveries WHERE event_id = $1',
        [events[1]!.id],
      ),
    ).toEqual([{ state: 'failed', attempts: 0, last_error: 'event_gone' }]);
    expect(bodiesAt(hook.path).filter((b) => b.type === 'task.status_changed')).toEqual([]);

    // An endpoint can take every event type, tasks included.
    const everything = await addEndpoint(c, [...WEBHOOK_EVENT_KEYS]);
    expect(
      await fx.query('SELECT event_types FROM app.webhook_endpoints WHERE id = $1', [
        everything.id,
      ]),
    ).toEqual([{ event_types: [...WEBHOOK_EVENT_KEYS] }]);
  });

  it('sends an endpoint that names task assignees only the events of the tasks assigned to them when the events happen (ADR-266)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const svc = crm();
    /** An endpoint of the company taking the task events of the assignees given. */
    const add = async (taskAssigneeIds: string[] | null) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes: [...TASK_EVENTS, 'contact.created'],
        taskAssigneeIds,
      });
      return { ...created, path };
    };
    const agents = await add([agent.membership.id]);
    const everyone = await add(null);
    const jaya = await newContact(owner, 'Jaya');

    // The agent's task is added; then it is given to the owner, a change neither endpoint takes, and
    // completed: the owner's by then. The owner's own task is not the agent's either.
    const { id: theirs } = await svc.createTask(owner, {
      title: 'Call Jaya',
      assigneeMembershipId: agent.membership.id,
      contactId: jaya.id,
    });
    await svc.updateTask(owner, {
      id: theirs,
      expectedVersion: 1,
      title: 'Call Jaya',
      notes: null,
      dueAt: null,
      remindAt: null,
      assigneeMembershipId: owner.membership.id,
    });
    await svc.completeTask(owner, { id: theirs, expectedVersion: 2 });
    const { id: ownTask } = await svc.createTask(owner, {
      title: 'Order brochures',
      assigneeMembershipId: owner.membership.id,
    });

    // The addition is captured for both endpoints; the rest for the one taking every task only.
    expect(
      (await taskEventsOf(c)).map((e) => [e.type, e.detail.taskId, e.status, e.deliveries]),
    ).toEqual([
      ['task.created', theirs, 'open', 2],
      ['task.status_changed', theirs, 'done', 1],
      ['task.created', ownTask, 'open', 1],
    ]);
    await deliverDue(c);
    const tasksAt = (path: string) =>
      bodiesAt(path)
        .filter((b) => b.type.startsWith('task.'))
        .map((b) => [b.type, taskIn(b).id])
        .sort();
    expect(tasksAt(agents.path)).toEqual([['task.created', theirs]]);
    expect(tasksAt(everyone.path)).toEqual(
      [
        ['task.created', theirs],
        ['task.status_changed', theirs],
        ['task.created', ownTask],
      ].sort(),
    );
    // The payload gives the assignee when it is delivered: the owner, since the task was given away.
    const [added] = bodiesAt(agents.path).filter((b) => b.type === 'task.created');
    expect(taskIn(added).assigneeId).toBe(owner.membership.id);
    // Contact events are not narrowed by assignees.
    expect(bodiesAt(agents.path).filter((b) => b.type === 'contact.created')).toHaveLength(1);
  });

  it("sends an endpoint that names pipelines of tasks' deals only the events of the tasks about deals in them when the events happen, and with assignees too only those passing both (ADR-303)", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const svc = crm();
    const pipeline = async (name: string, stages: string[]) =>
      (await svc.createPipeline(owner, { name, currency: 'INR', stages })).id;
    const salesId = await pipeline('Sales', ['New', 'Won']);
    const renewalsId = await pipeline('Renewals', ['Due', 'Signed']);
    const firstStage = async (pipelineId: string) =>
      (await svc.listPipelines(owner)).find((p) => p.id === pipelineId)!.stages[0]!.id;
    /** An endpoint of the company taking the task events of the tasks of the pipelines' deals. */
    const add = async (
      eventTypes: WebhookEventType[],
      taskPipelineIds: string[] | null,
      taskAssigneeIds: string[] | null = null,
    ) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes,
        taskPipelineIds,
        taskAssigneeIds,
      });
      return { ...created, path };
    };
    const salesTasks = await add([...TASK_EVENTS, 'deal.created'], [salesId]);
    const renewalsTasks = await add(TASK_EVENTS, [renewalsId]);
    const agentsRenewals = await add(TASK_EVENTS, [renewalsId], [agent.membership.id]);
    const everyTask = await add(TASK_EVENTS, null);
    const jaya = await newContact(owner, 'Jaya');
    const { id: sale } = await svc.createDeal(owner, {
      contactId: jaya.id,
      pipelineId: salesId,
      stageId: await firstStage(salesId),
      title: 'Annual plan',
    });
    const { id: renewal } = await svc.createDeal(owner, {
      contactId: jaya.id,
      pipelineId: renewalsId,
      stageId: await firstStage(renewalsId),
      title: 'Renewal 2027',
    });

    // A task about each deal, one about Jaya alone and one about nobody, the owner's; the agent's
    // about the renewal. The sale then moves to Renewals and its task is completed: Renewals' now.
    const addTask = async (title: string, about: Record<string, string>, assignee = owner) =>
      (
        await svc.createTask(owner, {
          title,
          assigneeMembershipId: assignee.membership.id,
          ...about,
        })
      ).id;
    const quote = await addTask('Send the quote', { dealId: sale });
    const invoice = await addTask('Send the renewal invoice', { dealId: renewal });
    const call = await addTask('Call Jaya', { contactId: jaya.id });
    const brochures = await addTask('Order brochures', {});
    const visit = await addTask('Visit for the renewal', { dealId: renewal }, agent);
    await svc.moveDeal(owner, {
      id: sale,
      expectedVersion: 1,
      stageId: await firstStage(renewalsId),
      pipelineId: renewalsId,
    });
    await svc.completeTask(owner, { id: quote, expectedVersion: 1 });

    // Each task event is captured once, with a delivery to each endpoint its deal's pipeline (and
    // assignee, where one is named) reaches; a task about no deal reaches only the endpoint taking
    // every task.
    expect((await taskEventsOf(c)).map((e) => [e.type, e.detail.taskId, e.deliveries])).toEqual([
      ['task.created', quote, 2],
      ['task.created', invoice, 2],
      ['task.created', call, 1],
      ['task.created', brochures, 1],
      ['task.created', visit, 3],
      ['task.status_changed', quote, 2],
    ]);
    await deliverDue(c);
    const tasksAt = (path: string) =>
      bodiesAt(path)
        .filter((b) => b.type.startsWith('task.'))
        .map((b) => [b.type, taskIn(b).id])
        .sort();
    expect(tasksAt(salesTasks.path)).toEqual([['task.created', quote]]);
    expect(tasksAt(renewalsTasks.path)).toEqual(
      [
        ['task.created', invoice],
        ['task.created', visit],
        ['task.status_changed', quote],
      ].sort(),
    );
    expect(tasksAt(agentsRenewals.path)).toEqual([['task.created', visit]]);
    expect(tasksAt(everyTask.path)).toHaveLength(6);
    // The payload gives the task's deal.
    const [quoteAdded] = bodiesAt(salesTasks.path).filter((b) => b.type === 'task.created');
    expect(taskIn(quoteAdded).dealId).toBe(sale);
    // Deal events are not narrowed by the pipelines of tasks' deals.
    expect(bodiesAt(salesTasks.path).filter((b) => b.type === 'deal.created')).toHaveLength(2);
  });

  it("sends an endpoint that names stages or owners of tasks' deals only the events of the tasks about deals in those stages or owned by those members when the events happen, and with both only those passing both (ADR-304)", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const svc = crm();
    const { id: salesId } = await svc.createPipeline(owner, {
      name: 'Sales',
      currency: 'INR',
      stages: ['New', 'Proposal'],
    });
    const [sales] = (await svc.listPipelines(owner)).filter((p) => p.id === salesId);
    const stage = (name: string) => sales!.stages.find((st) => st.name === name)!.id;
    const [fresh, proposal] = [stage('New'), stage('Proposal')];
    /** An endpoint of the company taking the events of the tasks of the stages' and owners' deals. */
    const add = async (
      eventTypes: WebhookEventType[],
      taskStageIds: string[] | null,
      taskDealOwnerIds: string[] | null,
    ) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes,
        taskStageIds,
        taskDealOwnerIds,
      });
      return { ...created, path };
    };
    const proposals = await add([...TASK_EVENTS, 'deal.created'], [proposal], null);
    const agentsDeals = await add(TASK_EVENTS, null, [agent.membership.id]);
    const agentsProposals = await add(TASK_EVENTS, [proposal], [agent.membership.id]);
    const everyTask = await add(TASK_EVENTS, null, null);
    const jaya = await newContact(owner, 'Jaya');
    // The agent's deal is new; the other is a proposal nobody owns.
    const { id: big } = await svc.createDeal(owner, {
      contactId: jaya.id,
      pipelineId: salesId,
      stageId: fresh,
      title: 'Annual plan',
      ownerMembershipId: agent.membership.id,
    });
    const { id: small } = await svc.createDeal(owner, {
      contactId: jaya.id,
      pipelineId: salesId,
      stageId: proposal,
      title: 'Starter plan',
    });
    const addTask = async (title: string, about: Record<string, string>) =>
      (
        await svc.createTask(owner, {
          title,
          assigneeMembershipId: owner.membership.id,
          ...about,
        })
      ).id;
    const call = await addTask('Call about the annual plan', { dealId: big });
    const quote = await addTask('Send the starter quote', { dealId: small });
    const brochures = await addTask('Order brochures', {});
    // The agent's deal becomes a proposal, and the other deal is given to the agent; then both
    // tasks are completed: each in Proposal and the agent's by then.
    await svc.moveDeal(owner, { id: big, expectedVersion: 1, stageId: proposal });
    await svc.updateDeal(owner, {
      id: small,
      expectedVersion: 1,
      title: 'Starter plan',
      value: '',
      ownerMembershipId: agent.membership.id,
      expectedCloseOn: null,
    });
    await svc.completeTask(owner, { id: call, expectedVersion: 1 });
    await svc.completeTask(owner, { id: quote, expectedVersion: 1 });

    // Each task event is captured once, with a delivery to each endpoint its deal's stage and owner
    // reach; a task about no deal, or of a deal without an owner, reaches no list of owners.
    expect((await taskEventsOf(c)).map((e) => [e.type, e.detail.taskId, e.deliveries])).toEqual([
      ['task.created', call, 2],
      ['task.created', quote, 2],
      ['task.created', brochures, 1],
      ['task.status_changed', call, 4],
      ['task.status_changed', quote, 4],
    ]);
    await deliverDue(c);
    const tasksAt = (path: string) =>
      bodiesAt(path)
        .filter((b) => b.type.startsWith('task.'))
        .map((b) => [b.type, taskIn(b).id])
        .sort();
    expect(tasksAt(proposals.path)).toEqual(
      [
        ['task.created', quote],
        ['task.status_changed', call],
        ['task.status_changed', quote],
      ].sort(),
    );
    expect(tasksAt(agentsDeals.path)).toEqual(
      [
        ['task.created', call],
        ['task.status_changed', call],
        ['task.status_changed', quote],
      ].sort(),
    );
    expect(tasksAt(agentsProposals.path)).toEqual(
      [
        ['task.status_changed', call],
        ['task.status_changed', quote],
      ].sort(),
    );
    expect(tasksAt(everyTask.path)).toHaveLength(5);
    // Deal events are not narrowed by the stages or owners of tasks' deals.
    expect(bodiesAt(proposals.path).filter((b) => b.type === 'deal.created')).toHaveLength(2);
  });

  it('sends a change of assignee with both assignees, to the endpoints of either assignee, in its place among one request’s steps (ADR-274)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const svc = crm();
    /** An endpoint of the company taking the events given, with the filters given. */
    const add = async (eventTypes: WebhookEventType[], filters: Record<string, unknown>) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes,
        ...filters,
      });
      return { ...created, path };
    };
    const everyone = await add(['task.assignee_changed', 'task.status_changed'], {});
    const agents = await add(['task.assignee_changed'], { taskAssigneeIds: [agent.membership.id] });
    // An endpoint without the new event hears none of its changes, whoever the task goes to.
    const owners = await add(TASK_EVENTS, { taskAssigneeIds: [owner.membership.id] });
    const jaya = await newContact(owner, 'Jaya');

    // The agent's task is given to the owner and back by members' edits; an edit of its title alone
    // sends nothing, and no endpoint takes its addition for the agent.
    const { id: taskId } = await svc.createTask(owner, {
      title: 'Call Jaya',
      assigneeMembershipId: agent.membership.id,
      contactId: jaya.id,
    });
    const edit = (version: number, title: string, assigneeMembershipId: string) =>
      svc.updateTask(owner, {
        id: taskId,
        expectedVersion: version,
        title,
        notes: null,
        dueAt: null,
        remindAt: null,
        assigneeMembershipId,
      });
    await edit(1, 'Call Jaya', owner.membership.id);
    await edit(2, 'Call Jaya', agent.membership.id);
    await edit(3, 'Call Jaya today', agent.membership.id);
    const assignees = (e: EventRow) => [
      e.detail.assigneeId ?? null,
      e.detail.previousAssigneeId ?? null,
    ];
    // The agent's endpoint hears the task leave the agent and come back.
    expect((await taskEventsOf(c)).map((e) => [e.type, ...assignees(e), e.deliveries])).toEqual([
      ['task.assignee_changed', owner.membership.id, agent.membership.id, 2],
      ['task.assignee_changed', agent.membership.id, owner.membership.id, 2],
    ]);

    // A key gives the task to the owner and completes it in one request: given, then completed;
    // then it reopens the task and gives it back in another: reopened, then given.
    const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'Task sync', scopes: ['tasks.write'], expiresInDays: 0 },
    );
    const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    if (!key) throw new Error('a new key does not authenticate');
    const apiDeps = { db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer };
    await apiUpdateTask(apiDeps, key, taskId, { assigneeId: owner.membership.id, status: 'done' });
    await apiUpdateTask(apiDeps, key, taskId, { status: 'open', assigneeId: agent.membership.id });
    const events = await taskEventsOf(c);
    expect(events.slice(2).map((e) => [e.type, e.status, ...assignees(e), e.deliveries])).toEqual([
      ['task.assignee_changed', 'open', owner.membership.id, agent.membership.id, 2],
      // The owner's endpoint takes the completion: the task is the owner's when it happens.
      ['task.status_changed', 'done', null, null, 2],
      // And the reopening, which comes before the task is given back among the request's steps
      // (Codex review of PR #39).
      ['task.status_changed', 'open', null, null, 2],
      ['task.assignee_changed', 'open', agent.membership.id, owner.membership.id, 2],
    ]);

    // Delivered, each change gives both assignees as it left them, whoever has the task by then.
    await deliverDue(c);
    const bodies = bodiesById(everyone.path);
    expect(bodies.size).toBe(6);
    for (const event of events.filter((e) => e.type === 'task.assignee_changed')) {
      const task = taskIn(bodies.get(event.id));
      expect([task?.assigneeId, task?.previousAssigneeId], event.id).toEqual(assignees(event));
      expect(taskAssigneeChangedPayloadSchema.safeParse(bodies.get(event.id)).success).toBe(true);
    }
    const done = taskIn(bodies.get(events[3]!.id));
    expect([done?.status, done?.previousStatus, done?.previousAssigneeId]).toEqual([
      'done',
      'open',
      null,
    ]);
    expect(done?.assigneeId).toBe(agent.membership.id);
    expect(bodiesAt(agents.path).map((b) => b.type)).toEqual(
      Array<string>(4).fill('task.assignee_changed'),
    );
    expect(
      bodiesAt(owners.path)
        .map((b) => [b.type, taskIn(b).status])
        .sort(),
    ).toEqual([
      ['task.status_changed', 'done'],
      ['task.status_changed', 'open'],
    ]);
  });

  it('sends a change of details naming what changed, to the endpoints of the task’s assignee, in its place among one request’s steps (ADR-276)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const svc = crm();
    /** An endpoint of the company taking the events given, with the filters given. */
    const add = async (eventTypes: WebhookEventType[], filters: Record<string, unknown>) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes,
        ...filters,
      });
      return { ...created, path };
    };
    const everyone = await add(
      ['task.updated', 'task.assignee_changed', 'task.status_changed'],
      {},
    );
    const agents = await add(['task.updated'], { taskAssigneeIds: [agent.membership.id] });
    // An endpoint without the new event hears none of the edits.
    const others = await add(TASK_EVENTS, {});
    const jaya = await newContact(owner, 'Jaya');

    // Members edit the agent's task: its title and due time, then its notes, then its reminder;
    // an edit that changes nothing sends nothing; then its title with its assignee.
    const due = new Date(Date.now() + 86_400_000).toISOString();
    const remind = new Date(Date.now() + 3_600_000).toISOString();
    const { id: taskId } = await svc.createTask(owner, {
      title: 'Call Jaya',
      assigneeMembershipId: agent.membership.id,
      contactId: jaya.id,
    });
    const edit = (
      expectedVersion: number,
      title: string,
      notes: string | null,
      dueAt: string | null,
      remindAt: string | null,
      assigneeMembershipId: string,
    ) =>
      svc.updateTask(owner, {
        id: taskId,
        expectedVersion,
        title,
        notes,
        dueAt,
        remindAt,
        assigneeMembershipId,
      });
    const notes = 'Ask about the renewal';
    await edit(1, 'Call Jaya today', null, due, null, agent.membership.id);
    await edit(2, 'Call Jaya today', notes, due, null, agent.membership.id);
    await edit(3, 'Call Jaya today', notes, due, remind, agent.membership.id);
    await edit(4, 'Call Jaya today', notes, due, remind, agent.membership.id);
    await edit(5, 'Call Jaya now', notes, due, remind, owner.membership.id);
    const changesOf = (e: EventRow) => (e.detail.changes as string[] | undefined) ?? null;
    expect(
      (await taskEventsOf(c)).map((e) => [e.type, e.status, changesOf(e), e.deliveries]),
    ).toEqual([
      ['task.created', 'open', null, 1],
      ['task.updated', 'open', ['title', 'dueAt'], 2],
      ['task.updated', 'open', ['notes'], 2],
      ['task.updated', 'open', ['remindAt'], 2],
      // The details change before the assignee among the edit's steps: the task is still the
      // agent's, so the agent's endpoint takes the change of title (Codex review of PR #39).
      ['task.updated', 'open', ['title'], 2],
      ['task.assignee_changed', 'open', null, 1],
    ]);

    // A key clears the due time and completes the task in one request: the change, with status
    // open, then the completion; then it reopens the task, retitles it and gives it back to the
    // agent in another: reopened, details changed, given.
    const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'Task sync', scopes: ['tasks.write'], expiresInDays: 0 },
    );
    const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    if (!key) throw new Error('a new key does not authenticate');
    const apiDeps = { db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer };
    await apiUpdateTask(apiDeps, key, taskId, { dueAt: null, status: 'done' });
    await apiUpdateTask(apiDeps, key, taskId, {
      status: 'open',
      title: 'Call Jaya again',
      assigneeId: agent.membership.id,
    });
    const events = await taskEventsOf(c);
    expect(events.slice(6).map((e) => [e.type, e.status, changesOf(e), e.deliveries])).toEqual([
      ['task.updated', 'open', ['dueAt'], 1],
      ['task.status_changed', 'done', null, 2],
      ['task.status_changed', 'open', null, 2],
      // Still the owner's when its details change: given back to the agent after.
      ['task.updated', 'open', ['title'], 1],
      ['task.assignee_changed', 'open', null, 1],
    ]);

    // Delivered, each change names what it changed and gives the task as it is then, without its
    // notes or reminder.
    await deliverDue(c);
    const bodies = bodiesById(everyone.path);
    expect(bodies.size).toBe(10);
    for (const event of events.filter((e) => e.type === 'task.updated')) {
      const body = bodies.get(event.id);
      expect(body?.data.changes, event.id).toEqual(changesOf(event));
      expect(taskUpdatedPayloadSchema.safeParse(body).success, event.id).toBe(true);
      expect(taskIn(body)).toMatchObject({
        id: taskId,
        title: 'Call Jaya again',
        status: 'open',
        previousStatus: null,
        dueAt: null,
        assigneeId: agent.membership.id,
        previousAssigneeId: null,
      });
      expect(Object.keys(taskIn(body))).not.toContain('notes');
      expect(Object.keys(taskIn(body))).not.toContain('remindAt');
      expect(body?.data.contact).toEqual({ id: jaya.id, phone: jaya.phone, name: 'Jaya' });
    }
    // The agent's endpoint hears the changes made while the task was the agent's, in any order.
    const byText = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b));
    expect(
      bodiesAt(agents.path)
        .map((b) => [b.type, b.data.changes])
        .sort(byText),
    ).toEqual(
      [
        ['task.updated', ['title', 'dueAt']],
        ['task.updated', ['notes']],
        ['task.updated', ['remindAt']],
        ['task.updated', ['title']],
      ].sort(byText),
    );
    expect(
      bodiesAt(others.path)
        .map((b) => b.type)
        .sort(),
    ).toEqual(['task.created', 'task.status_changed', 'task.status_changed']);
  });

  it('names who made each change of a task, the member or the key, and nobody for a change that did not record it (ADR-277)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const svc = crm();
    const hook = await addEndpoint(c, [
      'task.updated',
      'task.assignee_changed',
      'task.status_changed',
    ]);
    const jaya = await newContact(owner, 'Jaya');
    const { id: taskId } = await svc.createTask(owner, {
      title: 'Call Jaya',
      assigneeMembershipId: owner.membership.id,
      contactId: jaya.id,
    });
    const set = (assignments: string) =>
      fx.query(`UPDATE app.crm_tasks SET ${assignments} WHERE id = $1`, [taskId]);

    // A member completes it; a key reopens and retitles it in one request; a write of nothing the
    // events report keeps the key; a change that does not record its maker names nobody.
    await svc.completeTask(owner, { id: taskId, expectedVersion: 1 });
    const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'Task sync', scopes: ['tasks.write'], expiresInDays: 0 },
    );
    const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    if (!key) throw new Error('a new key does not authenticate');
    const apiDeps = { db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer };
    await apiUpdateTask(apiDeps, key, taskId, { status: 'open', title: 'Call Jaya again' });
    await set(`reminder_state = 'none'`);
    expect(
      await fx.query('SELECT changed_by, changed_by_api_key_id FROM app.crm_tasks WHERE id = $1', [
        taskId,
      ]),
    ).toEqual([{ changed_by: 'api', changed_by_api_key_id: key.key.id }]);
    await set(`notes = 'Ask about the renewal'`);

    const events = await taskEventsOf(c);
    const makers = [
      ['task.status_changed', 'member', null],
      ['task.status_changed', 'api', key.key.id],
      ['task.updated', 'api', key.key.id],
      ['task.updated', null, null],
    ];
    expect(events.map((e) => [e.type, e.detail.changedBy, e.detail.apiKeyId])).toEqual(makers);
    await deliverDue(c);
    const bodies = bodiesById(hook.path);
    expect(
      events.map((e) => {
        const task = taskIn(bodies.get(e.id));
        return [bodies.get(e.id)?.type, task.changedBy, task.apiKeyId];
      }),
    ).toEqual(makers);

    // The database keeps a task's changer as a deal's.
    for (const bad of [
      `changed_by = 'api', changed_by_api_key_id = NULL`,
      `changed_by = 'automation', changed_by_api_key_id = '${key.key.id}'`,
      `changed_by = 'erasure', changed_by_api_key_id = NULL`,
    ]) {
      await expect(set(bad), bad).rejects.toThrow(/crm_tasks_changed_by"/);
    }
    await expect(set(`changed_by = 'api', changed_by_api_key_id = '${uuidv7()}'`)).rejects.toThrow(
      /crm_tasks_changed_by_api_key_fk/,
    );
  });

  it('sends an endpoint that names task statuses only the completions, cancellations and reopenings that reached one of them (ADR-309)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    /** An endpoint of the company taking tasks' status changes with these statuses. */
    const add = async (taskStatuses: string[] | null) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes: ['task.status_changed'],
        taskStatuses,
      });
      return path;
    };
    const completions = await add(['done']);
    const undone = await add(['open', 'cancelled']);
    const everyStatus = await add(null);
    const svc = crm();

    // A task about nobody completed, reopened, then cancelled.
    const { id: taskId } = await svc.createTask(owner, {
      title: 'Order brochures',
      assigneeMembershipId: owner.membership.id,
    });
    await svc.completeTask(owner, { id: taskId, expectedVersion: 1 });
    await svc.reopenTask(owner, { id: taskId, expectedVersion: 2 });
    await svc.cancelTask(owner, { id: taskId, expectedVersion: 3 });

    // Each change captured once, with a delivery to each endpoint whose list holds the status
    // reached; the addition, which no endpoint takes, is not recorded.
    const events = await taskEventsOf(c);
    expect(events.map((e) => [e.type, e.status, e.deliveries])).toEqual([
      ['task.status_changed', 'done', 2],
      ['task.status_changed', 'open', 2],
      ['task.status_changed', 'cancelled', 2],
    ]);
    await deliverDue(c);
    const statusesAt = (path: string) =>
      bodiesAt(path)
        .map((b) => taskIn(b).status as string)
        .sort();
    expect(statusesAt(completions)).toEqual(['done']);
    expect(statusesAt(undone)).toEqual(['cancelled', 'open']);
    expect(statusesAt(everyStatus)).toEqual(['cancelled', 'done', 'open']);
  });

  it('sends an endpoint that names task details only the changes that changed one of them, each naming every detail it changed (ADR-310)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    /** An endpoint of the company taking tasks' detail changes for these details. */
    const add = async (taskDetails: string[] | null) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes: ['task.updated'],
        taskDetails,
      });
      return path;
    };
    const schedule = await add(['dueAt', 'remindAt']);
    const writing = await add(['title', 'notes']);
    const everyChange = await add(null);
    const svc = crm();
    const { id: taskId } = await svc.createTask(owner, {
      title: 'Order brochures',
      assigneeMembershipId: owner.membership.id,
    });
    const due = new Date(Date.now() + 86_400_000).toISOString();
    const remind = new Date(Date.now() + 3_600_000).toISOString();
    const edit = (
      expectedVersion: number,
      fields: {
        title: string;
        notes: string | null;
        dueAt: string | null;
        remindAt: string | null;
      },
    ) =>
      svc.updateTask(owner, {
        id: taskId,
        expectedVersion,
        assigneeMembershipId: owner.membership.id,
        ...fields,
      });

    // Its notes are written, it is given a due time, then retitled with a reminder.
    const notes = 'Ask for the 2027 prices';
    await edit(1, { title: 'Order brochures', notes, dueAt: null, remindAt: null });
    await edit(2, { title: 'Order brochures', notes, dueAt: due, remindAt: null });
    await edit(3, { title: 'Order 500 brochures', notes, dueAt: due, remindAt: remind });

    // Each change captured once, with a delivery to each endpoint whose list holds a detail it
    // changed.
    const events = await taskEventsOf(c);
    expect(events.map((e) => [e.type, e.detail.changes, e.deliveries])).toEqual([
      ['task.updated', ['notes'], 2],
      ['task.updated', ['dueAt'], 2],
      ['task.updated', ['title', 'remindAt'], 3],
    ]);
    await deliverDue(c);
    const changesAt = (path: string) =>
      bodiesAt(path)
        .map((b) => (b.data.changes as string[]).join('+'))
        .sort();
    expect(changesAt(schedule)).toEqual(['dueAt', 'title+remindAt']);
    expect(changesAt(writing)).toEqual(['notes', 'title+remindAt']);
    expect(changesAt(everyChange)).toEqual(['dueAt', 'notes', 'title+remindAt']);
  });
});

describe('note events (ADR-280)', () => {
  const crm = () =>
    createCrmService({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });

  /** A contact a member adds, with a number; its id and number. */
  async function newContact(owner: TenantContext, name: string) {
    const phone = `+${waId()}`;
    const { id } = await contactsService().createContact(owner, { displayName: name, phone });
    return { id, phone };
  }

  /** The company's note events in the order they were captured, with their delivery counts. */
  const noteEventsOf = (c: Company) =>
    fx.query<EventRow & { occurred_at: Date }>(
      `SELECT e.id, e.type, e.status, e.detail, e.conversation_id, e.contact_id, e.occurred_at,
              (SELECT count(*)::int FROM app.webhook_deliveries d
                WHERE d.tenant_id = e.tenant_id AND d.event_id = e.id) AS deliveries
         FROM app.webhook_events e
        WHERE e.tenant_id = $1 AND e.type = 'note.created' ORDER BY e.occurred_at, e.id`,
      [c.tenant.id],
    );

  it('sends each note members and keys add, without its text, to the endpoints that take it', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const svc = crm();
    const asha = await newContact(owner, 'Asha');
    const { id: pipelineId } = await svc.createPipeline(owner, {
      name: 'Sales',
      currency: 'INR',
      stages: ['New'],
    });
    const [pipeline] = (await svc.listPipelines(owner)).filter((p) => p.id === pipelineId);
    const { id: dealId } = await svc.createDeal(owner, {
      contactId: asha.id,
      pipelineId,
      stageId: pipeline!.stages[0]!.id,
      title: 'Annual plan',
    });

    // While no endpoint takes the event, a note captures nothing.
    await svc.addNote(owner, { contactId: asha.id, body: 'Before any endpoint' });
    expect(await noteEventsOf(c)).toEqual([]);

    const hook = await addEndpoint(c, ['note.created']);
    const tasksOnly = await addEndpoint(c, ['task.created']);

    // A member's note on the contact and one on the deal, then a key's on the deal.
    const onContact = await svc.addNote(owner, {
      contactId: asha.id,
      body: 'Ring 98450 12345 after Diwali',
    });
    const onDeal = await svc.addNote(owner, { dealId, body: 'Wants a discount' });
    const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      { name: 'Call centre', scopes: ['notes.write'], expiresInDays: 0 },
    );
    const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    if (!key) throw new Error('a new key does not authenticate');
    const response = await apiCreateNote(
      { db: fx.dbs.app, clock: systemClock },
      key,
      { body: 'Sent the quote', dealId },
      null,
    );
    const byKey = (response.body as { data: { id: string } }).data.id;

    // One event per note, in order, for the endpoint taking it only, naming the note and its
    // contact.
    const events = await noteEventsOf(c);
    expect(
      events.map((e) => [e.status, e.detail, e.conversation_id, e.contact_id, e.deliveries]),
    ).toEqual([
      [null, { noteId: onContact.id }, null, asha.id, 1],
      [null, { noteId: onDeal.id }, null, asha.id, 1],
      [null, { noteId: byKey }, null, asha.id, 1],
    ]);

    // Built when delivered: the deal, who wrote each (a key by its id, a member never by name) and
    // the contact; never the text.
    await deliverDue(c);
    const bodies = new Map(bodiesAt(hook.path).map((b) => [b.id, b]));
    expect([...bodies.keys()].sort()).toEqual(events.map((e) => e.id).sort());
    const delivered = events.map((e) => bodies.get(e.id)!);
    for (const body of delivered) {
      expect(noteCreatedPayloadSchema.safeParse(body).success).toBe(true);
      const sent = JSON.stringify(body);
      for (const hidden of ['98450', 'discount', 'quote', owner.membership.id]) {
        expect(sent).not.toContain(hidden);
      }
      expect(body.data.contact).toEqual({ id: asha.id, phone: asha.phone, name: 'Asha' });
    }
    expect(delivered.map((b) => b.createdAt)).toEqual(
      events.map((e) => e.occurred_at.toISOString()),
    );
    const note = { createdAt: expect.any(String) };
    expect(delivered.map((b) => b.data.note)).toEqual([
      { id: onContact.id, dealId: null, writtenBy: 'member', apiKeyId: null, ...note },
      { id: onDeal.id, dealId, writtenBy: 'member', apiKeyId: null, ...note },
      { id: byKey, dealId, writtenBy: 'api', apiKeyId: key.key.id, ...note },
    ]);
    expect(bodiesAt(tasksOnly.path)).toEqual([]);
  });

  it("sends an endpoint that names pipelines, stages or owners of notes' deals only the notes about deals in them or owned by them when each note is added, and with more than one only those passing them all (ADR-305)", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const svc = crm();
    const { id: salesId } = await svc.createPipeline(owner, {
      name: 'Sales',
      currency: 'INR',
      stages: ['New', 'Proposal'],
    });
    const { id: supportId } = await svc.createPipeline(owner, {
      name: 'Support',
      currency: 'INR',
      stages: ['Open'],
    });
    const pipelines = await svc.listPipelines(owner);
    const stageOf = (pipelineId: string, name: string) =>
      pipelines.find((p) => p.id === pipelineId)!.stages.find((st) => st.name === name)!.id;
    const [fresh, proposal, open] = [
      stageOf(salesId, 'New'),
      stageOf(salesId, 'Proposal'),
      stageOf(supportId, 'Open'),
    ];
    /** An endpoint of the company taking the notes of the lists' deals. */
    const add = async (
      eventTypes: WebhookEventType[],
      notePipelineIds: string[] | null,
      noteStageIds: string[] | null,
      noteDealOwnerIds: string[] | null,
    ) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes,
        notePipelineIds,
        noteStageIds,
        noteDealOwnerIds,
      });
      return { ...created, path };
    };
    const salesNotes = await add(['note.created', 'deal.created'], [salesId], null, null);
    const proposalNotes = await add(['note.created'], null, [proposal], null);
    const agentsNotes = await add(['note.created'], null, null, [agent.membership.id]);
    const agentsSalesProposals = await add(
      ['note.created'],
      [salesId],
      [proposal],
      [agent.membership.id],
    );
    const everyNote = await add(['note.created'], null, null, null);
    const jaya = await newContact(owner, 'Jaya');
    // A new sales deal of the agent's, and a support deal nobody owns.
    const { id: big } = await svc.createDeal(owner, {
      contactId: jaya.id,
      pipelineId: salesId,
      stageId: fresh,
      title: 'Annual plan',
      ownerMembershipId: agent.membership.id,
    });
    const { id: ticket } = await svc.createDeal(owner, {
      contactId: jaya.id,
      pipelineId: supportId,
      stageId: open,
      title: 'Login help',
    });
    const first = await svc.addNote(owner, { dealId: big, body: 'Asked for a call' });
    const onSupport = await svc.addNote(owner, { dealId: ticket, body: 'Cannot sign in' });
    const onContact = await svc.addNote(owner, { contactId: jaya.id, body: 'Prefers mornings' });
    // The agent's deal becomes a proposal and the support deal is given to the agent: the notes
    // added after go by the new stage and owner.
    await svc.moveDeal(owner, { id: big, expectedVersion: 1, stageId: proposal });
    await svc.updateDeal(owner, {
      id: ticket,
      expectedVersion: 1,
      title: 'Login help',
      value: '',
      ownerMembershipId: agent.membership.id,
      expectedCloseOn: null,
    });
    const later = await svc.addNote(owner, { dealId: big, body: 'Sent the proposal' });
    const given = await svc.addNote(owner, { dealId: ticket, body: 'Called back' });

    // Each note is captured once, with a delivery to each endpoint its deal's pipeline, stage and
    // owner reach when it is added; a note about the contact alone reaches no list.
    expect((await noteEventsOf(c)).map((e) => [e.detail.noteId, e.deliveries])).toEqual([
      [first.id, 3],
      [onSupport.id, 1],
      [onContact.id, 1],
      [later.id, 5],
      [given.id, 2],
    ]);
    await deliverDue(c);
    const notesAt = (path: string) =>
      bodiesAt(path)
        .filter((b) => b.type === 'note.created')
        .map((b) => (b.data.note as { id: string }).id)
        .sort();
    expect(notesAt(salesNotes.path)).toEqual([first.id, later.id].sort());
    expect(notesAt(proposalNotes.path)).toEqual([later.id]);
    expect(notesAt(agentsNotes.path)).toEqual([first.id, later.id, given.id].sort());
    expect(notesAt(agentsSalesProposals.path)).toEqual([later.id]);
    expect(notesAt(everyNote.path)).toHaveLength(5);
    // Deal events are not narrowed by the pipelines of notes' deals.
    expect(bodiesAt(salesNotes.path).filter((b) => b.type === 'deal.created')).toHaveLength(2);
  });

  it('gives a moved note with the contact kept, and sends nothing for a note erasure deleted', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const svc = crm();
    const hook = await addEndpoint(c, ['note.created']);

    // A customer who wrote by WhatsApp user id gets a note, and is merged into a contact a member
    // added: the merge moves the note without adding one, so nothing more is captured.
    const merged = await writesByUserId(c);
    const moved = await svc.addNote(owner, { contactId: merged, body: 'Wrote from a new phone' });
    const kept = await newContact(owner, 'Asha');
    await createContactMergeService({ db: fx.dbs.app, clock: systemClock }).mergeContacts(owner, {
      keepContactId: kept.id,
      mergeContactId: merged,
    });
    expect((await noteEventsOf(c)).map((e) => [e.detail, e.contact_id])).toEqual([
      [{ noteId: moved.id }, merged],
    ]);
    await deliverDue(c);
    expect(bodiesAt(hook.path).map((b) => b.data)).toEqual([
      {
        note: {
          id: moved.id,
          dealId: null,
          writtenBy: 'member',
          apiKeyId: null,
          createdAt: expect.any(String),
        },
        contact: { id: kept.id, phone: kept.phone, name: 'Asha' },
      },
    ]);

    // A note whose contact is erased before its event is delivered is gone: the delivery fails
    // without an attempt and nothing is sent.
    const ravi = await newContact(owner, 'Ravi');
    await svc.addNote(owner, { contactId: ravi.id, body: 'Lives at 12 Park Street' });
    await contactsService().eraseContact(owner, { contactId: ravi.id, suppress: false });
    await deliverDue(c);
    expect(
      await fx.query(
        `SELECT d.state, d.attempts, d.last_error FROM app.webhook_deliveries d
           JOIN app.webhook_events e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
          WHERE e.tenant_id = $1 AND e.contact_id = $2`,
        [c.tenant.id, ravi.id],
      ),
    ).toEqual([{ state: 'failed', attempts: 0, last_error: 'event_gone' }]);
    expect(bodiesAt(hook.path)).toHaveLength(1);
  });
});

describe('satisfaction survey events (ADR-293)', () => {
  /** The company's survey answer events in the order they were captured, with their delivery counts. */
  const surveyEventsOf = (c: Company) =>
    fx.query<EventRow & { occurred_at: Date }>(
      `SELECT e.id, e.type, e.status, e.detail, e.conversation_id, e.contact_id, e.contact_changes,
              e.occurred_at,
              (SELECT count(*)::int FROM app.webhook_deliveries d
                WHERE d.tenant_id = e.tenant_id AND d.event_id = e.id) AS deliveries
         FROM app.webhook_events e
        WHERE e.tenant_id = $1 AND e.type = 'satisfaction_survey.answered'
        ORDER BY e.occurred_at, e.id`,
      [c.tenant.id],
    );

  /** A customer's tap on a survey button, quoting the survey message as WhatsApp does. */
  const tap = (c: Company, from: string, buttonId: string, contextId: string) =>
    fx.deliver(
      fx.messagesBody(c, {
        messages: [
          {
            waId: from,
            type: 'interactive',
            extra: {
              interactive: { type: 'button_reply', button_reply: { id: buttonId, title: 'Great' } },
              context: { from: '919000000000', id: contextId },
            },
          },
        ],
      }),
    );

  it('sends a survey’s first answer once, as the API reads the survey, to the endpoints that take it on its number', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await createCsatService({ db: fx.dbs.app, clock: systemClock }).updateCsatSettings(owner, {
      enabled: true,
      question: 'How did we do today?',
      labels: ['Great', 'Okay', 'Poor'],
    });
    const inboxWithSends = createInboxService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
    });
    const resolve = async (conversationId: string) =>
      inboxWithSends.setStatus(owner, {
        conversationId,
        status: 'resolved',
        expectedVersion: await versionOf(conversationId),
      });
    const outlet = await fx.addNumber(c, { phone: '+91 90000 54323' });
    const hook = await addEndpoint(c, ['satisfaction_survey.answered']);
    const onMain = await addNumberEndpoint(
      c,
      ['satisfaction_survey.answered'],
      [c.channelAccountId],
    );
    const onOutlet = await addNumberEndpoint(
      c,
      ['satisfaction_survey.answered'],
      [outlet.channelAccountId],
    );
    const conversationsOnly = await addEndpoint(c, ['conversation.status_changed']);

    // Resolved inside the window: asked; sending it captures nothing.
    const phone = waId();
    const { conversation_id: conversationId, contact_id: contactId } = await inbound(
      c,
      phone,
      'Where is my parcel?',
    );
    await resolve(conversationId);
    const [survey] = await fx.query<{ id: string; message_id: string }>(
      `SELECT id, message_id FROM app.csat_surveys WHERE conversation_id = $1`,
      [conversationId],
    );
    const [intent] = await fx.query<{ id: string }>(
      `SELECT id FROM app.send_intents WHERE message_id = $1`,
      [survey!.message_id],
    );
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
      authorizedTenantScope(c.tenant.id, c.owner.id),
      intent!.id,
    );
    const sent = fx.standIn.state.requests.filter((r) => r.path.endsWith('/messages')).at(-1)!;
    expect(await surveyEventsOf(c)).toEqual([]);

    // The first tap answers it: one event, for the endpoints taking it on its number. A second tap
    // changes nothing and captures nothing.
    await tap(c, phone, `w360csat:${survey!.id}:3`, sent.wamid!);
    await tap(c, phone, `w360csat:${survey!.id}:1`, sent.wamid!);
    const events = await surveyEventsOf(c);
    expect(
      events.map((e) => [e.status, e.detail, e.conversation_id, e.contact_id, e.deliveries]),
    ).toEqual([[null, { surveyId: survey!.id }, conversationId, contactId, 2]]);

    // Skipped (outside the 24-hour window): no answer, no event.
    const late = await inbound(c, waId(), 'Thanks');
    await fx.query(
      `UPDATE app.conversations SET last_inbound_at = now() - interval '25 hours' WHERE id = $1`,
      [late.conversation_id],
    );
    await resolve(late.conversation_id);
    expect(await surveyEventsOf(c)).toHaveLength(1);

    // Built when delivered: the survey as GET /satisfaction-surveys reads it, its conversation,
    // contact and number.
    await deliverDue(c);
    const [answer] = await fx.query<{ id: string }>(
      `SELECT response_message_id AS id FROM app.csat_surveys WHERE id = $1`,
      [survey!.id],
    );
    for (const path of [hook.path, onMain.path]) {
      const [body] = bodiesAt(path);
      expect(satisfactionSurveyAnsweredPayloadSchema.safeParse(body).success).toBe(true);
      expect(body).toMatchObject({
        id: events[0]!.id,
        type: 'satisfaction_survey.answered',
        createdAt: events[0]!.occurred_at.toISOString(),
        data: {
          survey: {
            id: survey!.id,
            conversationId,
            status: 'answered',
            skipReason: null,
            messageId: survey!.message_id,
            score: 3,
            answerMessageId: answer!.id,
            assigneeId: null,
            resolvedById: owner.membership.id,
          },
          conversation: { id: conversationId },
          contact: { id: contactId, phone: `+${phone}` },
          channel: { id: c.channelAccountId },
        },
      });
    }
    expect(bodiesAt(onOutlet.path)).toEqual([]);
    const others = bodiesAt(conversationsOnly.path).map((b) => b.type);
    expect(others.length).toBeGreaterThan(0);
    expect(new Set(others)).toEqual(new Set(['conversation.status_changed']));
  });

  it('sends an endpoint that names scores only the answers that recorded one of them (ADR-307)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await createCsatService({ db: fx.dbs.app, clock: systemClock }).updateCsatSettings(owner, {
      enabled: true,
      question: 'How did we do today?',
      labels: ['Great', 'Okay', 'Poor'],
    });
    const inboxWithSends = createInboxService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
    });
    /** An endpoint of the company taking the answers with these scores. */
    const add = async (surveyScores: (1 | 2 | 3)[] | null) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes: ['satisfaction_survey.answered'],
        surveyScores,
      });
      return { ...created, path };
    };
    const unhappy = await add([1]);
    const happy = await add([3, 2]);
    const everyAnswer = await add(null);
    /** A customer writes, a member resolves, the survey goes out and the customer taps a score. */
    const answer = async (score: 1 | 2 | 3) => {
      const phone = waId();
      const { conversation_id: conversationId } = await inbound(c, phone, 'Where is my parcel?');
      await inboxWithSends.setStatus(owner, {
        conversationId,
        status: 'resolved',
        expectedVersion: await versionOf(conversationId),
      });
      const [survey] = await fx.query<{ id: string; message_id: string }>(
        `SELECT id, message_id FROM app.csat_surveys WHERE conversation_id = $1`,
        [conversationId],
      );
      const [intent] = await fx.query<{ id: string }>(
        `SELECT id FROM app.send_intents WHERE message_id = $1`,
        [survey!.message_id],
      );
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
        authorizedTenantScope(c.tenant.id, c.owner.id),
        intent!.id,
      );
      const sent = fx.standIn.state.requests.filter((r) => r.path.endsWith('/messages')).at(-1)!;
      await tap(c, phone, `w360csat:${survey!.id}:${score}`, sent.wamid!);
      return survey!.id;
    };
    const great = await answer(3);
    const okay = await answer(2);
    const poor = await answer(1);

    // Each answer is captured once, with a delivery to each endpoint whose list holds its score.
    expect((await surveyEventsOf(c)).map((e) => [e.detail.surveyId, e.deliveries])).toEqual([
      [great, 2],
      [okay, 2],
      [poor, 2],
    ]);
    await deliverDue(c);
    const scoresAt = (path: string) =>
      bodiesAt(path)
        .map((b) => (b.data.survey as { score: number }).score)
        .sort();
    expect(scoresAt(unhappy.path)).toEqual([1]);
    expect(scoresAt(happy.path)).toEqual([2, 3]);
    expect(scoresAt(everyAnswer.path)).toEqual([1, 2, 3]);
  });

  it('sends an endpoint that names members or teams only the answers credited to them or of their conversations, and captures none nobody takes (ADR-311)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = (await fx.ctx(c, c.agent)).membership.id;
    const ownerId = owner.membership.id;
    await createCsatService({ db: fx.dbs.app, clock: systemClock }).updateCsatSettings(owner, {
      enabled: true,
      question: 'How did we do today?',
      labels: ['Great', 'Okay', 'Poor'],
    });
    const inboxWithSends = createInboxService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
    });
    const teamOf = async (name: string) => {
      const id = uuidv7();
      await fx.query('INSERT INTO app.teams (id, tenant_id, name) VALUES ($1, $2, $3)', [
        id,
        c.tenant.id,
        name,
      ]);
      return id;
    };
    const support = await teamOf('Support');
    const sales = await teamOf('Sales');
    /** An endpoint of the company taking the answers these lists name. */
    const add = async (lists: Record<string, unknown>) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes: ['satisfaction_survey.answered'],
        ...lists,
      });
      return { ...created, path };
    };
    const agents = await add({ surveyAssigneeIds: [agent] });
    const supportDesk = await add({ surveyTeamIds: [support] });
    const happySupport = await add({
      surveyScores: [3],
      surveyAssigneeIds: [agent, ownerId],
      surveyTeamIds: [support],
    });
    const everyAnswer = await add({});
    const place = (conversationId: string, assignee: string | null, team: string | null) =>
      fx.query(
        'UPDATE app.conversations SET assigned_membership_id = $2, team_id = $3 WHERE id = $1',
        [conversationId, assignee, team],
      );
    /**
     * A customer writes, the conversation is assigned and put in a team, a member resolves it, the
     * survey goes out, the conversation may be moved, and the customer taps a score.
     */
    const answer = async (
      score: 1 | 2 | 3,
      resolvedWith: [string | null, string | null],
      answeredWith?: [string | null, string | null],
    ) => {
      const phone = waId();
      const { conversation_id: conversationId } = await inbound(c, phone, 'Where is my parcel?');
      await place(conversationId, ...resolvedWith);
      await inboxWithSends.setStatus(owner, {
        conversationId,
        status: 'resolved',
        expectedVersion: await versionOf(conversationId),
      });
      const [survey] = await fx.query<{ id: string; message_id: string }>(
        `SELECT id, message_id FROM app.csat_surveys WHERE conversation_id = $1`,
        [conversationId],
      );
      const [intent] = await fx.query<{ id: string }>(
        `SELECT id FROM app.send_intents WHERE message_id = $1`,
        [survey!.message_id],
      );
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
        authorizedTenantScope(c.tenant.id, c.owner.id),
        intent!.id,
      );
      const sent = fx.standIn.state.requests.filter((r) => r.path.endsWith('/messages')).at(-1)!;
      if (answeredWith) await place(conversationId, ...answeredWith);
      await tap(c, phone, `w360csat:${survey!.id}:${score}`, sent.wamid!);
      return survey!.id;
    };
    const agentSupport = await answer(3, [agent, support]);
    const agentSales = await answer(1, [agent, sales]);
    const ownerSupport = await answer(3, [ownerId, support]);
    const nobody = await answer(3, [null, null]);
    // Credited to the member it was assigned to when resolved, and of the team it is in when the
    // customer answers: reassigned and moved to Sales after the survey went out.
    const moved = await answer(3, [agent, support], [ownerId, sales]);

    // Each answer is captured once, with a delivery to each endpoint whose lists all hold it.
    expect((await surveyEventsOf(c)).map((e) => [e.detail.surveyId, e.deliveries])).toEqual([
      [agentSupport, 4],
      [agentSales, 2],
      [ownerSupport, 3],
      [nobody, 1],
      [moved, 2],
    ]);
    await deliverDue(c);
    const surveysAt = (path: string) =>
      bodiesAt(path).map((b) => (b.data.survey as { id: string; assigneeId: string | null }).id);
    expect(surveysAt(agents.path).sort()).toEqual([agentSupport, agentSales, moved].sort());
    expect(surveysAt(supportDesk.path).sort()).toEqual([agentSupport, ownerSupport].sort());
    expect(surveysAt(happySupport.path).sort()).toEqual([agentSupport, ownerSupport].sort());
    expect(surveysAt(everyAnswer.path)).toHaveLength(5);
    const movedBody = bodiesAt(agents.path).find(
      (b) => (b.data.survey as { id: string }).id === moved,
    );
    expect(movedBody?.data.survey).toMatchObject({ assigneeId: agent });

    // With the endpoint taking every answer and the members' list off, an answer no list holds is
    // not captured at all.
    await webhooks().setEnabled(owner, { endpointId: everyAnswer.id, enabled: false });
    await webhooks().setEnabled(owner, { endpointId: agents.id, enabled: false });
    await answer(1, [ownerId, sales]);
    expect(await surveyEventsOf(c)).toHaveLength(5);
  });

  it('sends an endpoint that names contact or conversation tags only the answers of contacts or conversations that have one of them when the customer answers, and captures none nobody takes (ADR-312)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await createCsatService({ db: fx.dbs.app, clock: systemClock }).updateCsatSettings(owner, {
      enabled: true,
      question: 'How did we do today?',
      labels: ['Great', 'Okay', 'Poor'],
    });
    const inboxWithSends = createInboxService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
    });
    /** An endpoint of the company taking the answers these lists name. */
    const add = async (lists: Record<string, unknown>) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes: ['satisfaction_survey.answered'],
        ...lists,
      });
      return { ...created, path };
    };
    const vips = await add({ surveyContactTags: ['vip'] });
    const refunds = await add({ surveyConversationTags: ['refund', 'delivery delay'] });
    const unhappyVipRefunds = await add({
      surveyScores: [1],
      surveyContactTags: ['vip'],
      surveyConversationTags: ['refund'],
    });
    const everyAnswer = await add({});
    const tagContact = (contactId: string, tag: string) =>
      fx.query(
        'INSERT INTO app.contact_tags (id, tenant_id, contact_id, tag) VALUES ($1, $2, $3, $4)',
        [uuidv7(), c.tenant.id, contactId, tag],
      );
    const untagContact = (contactId: string, tag: string) =>
      fx.query(
        'DELETE FROM app.contact_tags WHERE tenant_id = $1 AND contact_id = $2 AND tag = $3',
        [c.tenant.id, contactId, tag],
      );
    const tagConversation = (conversationId: string, tag: string) =>
      fx.query(
        'INSERT INTO app.conversation_tags (id, tenant_id, conversation_id, tag) VALUES ($1, $2, $3, $4)',
        [uuidv7(), c.tenant.id, conversationId, tag],
      );
    type Tags = { contact?: string[]; conversation?: string[]; untag?: string[] };
    /**
     * A customer writes, the contact and conversation are tagged, a member resolves it, the survey
     * goes out, tags change, and the customer taps a score.
     */
    const answer = async (score: 1 | 2 | 3, before: Tags, later: Tags = {}) => {
      const phone = waId();
      const { conversation_id: conversationId, contact_id: contactId } = await inbound(
        c,
        phone,
        'Where is my parcel?',
      );
      for (const tag of before.contact ?? []) await tagContact(contactId, tag);
      for (const tag of before.conversation ?? []) await tagConversation(conversationId, tag);
      await inboxWithSends.setStatus(owner, {
        conversationId,
        status: 'resolved',
        expectedVersion: await versionOf(conversationId),
      });
      const [survey] = await fx.query<{ id: string; message_id: string }>(
        `SELECT id, message_id FROM app.csat_surveys WHERE conversation_id = $1`,
        [conversationId],
      );
      const [intent] = await fx.query<{ id: string }>(
        `SELECT id FROM app.send_intents WHERE message_id = $1`,
        [survey!.message_id],
      );
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
        authorizedTenantScope(c.tenant.id, c.owner.id),
        intent!.id,
      );
      const sent = fx.standIn.state.requests.filter((r) => r.path.endsWith('/messages')).at(-1)!;
      for (const tag of later.contact ?? []) await tagContact(contactId, tag);
      for (const tag of later.conversation ?? []) await tagConversation(conversationId, tag);
      for (const tag of later.untag ?? []) await untagContact(contactId, tag);
      await tap(c, phone, `w360csat:${survey!.id}:${score}`, sent.wamid!);
      return survey!.id;
    };
    const unhappyVipRefund = await answer(1, { contact: ['vip'], conversation: ['refund'] });
    const happyVip = await answer(3, { contact: ['vip'] });
    const unhappyDelay = await answer(1, { conversation: ['delivery delay'] });
    const untagged = await answer(1, {});
    // Tags count as the contact and conversation have them when the customer answers: added after
    // the survey went out, or removed by then.
    const taggedLater = await answer(1, {}, { contact: ['vip'], conversation: ['refund'] });
    const untaggedLater = await answer(1, { contact: ['vip'] }, { untag: ['vip'] });

    // Each answer is captured once, with a delivery to each endpoint whose lists all hold it.
    expect((await surveyEventsOf(c)).map((e) => [e.detail.surveyId, e.deliveries])).toEqual([
      [unhappyVipRefund, 4],
      [happyVip, 2],
      [unhappyDelay, 2],
      [untagged, 1],
      [taggedLater, 4],
      [untaggedLater, 1],
    ]);
    await deliverDue(c);
    const surveysAt = (path: string) =>
      bodiesAt(path)
        .map((b) => (b.data.survey as { id: string }).id)
        .sort();
    expect(surveysAt(vips.path)).toEqual([unhappyVipRefund, happyVip, taggedLater].sort());
    expect(surveysAt(refunds.path)).toEqual([unhappyVipRefund, unhappyDelay, taggedLater].sort());
    expect(surveysAt(unhappyVipRefunds.path)).toEqual([unhappyVipRefund, taggedLater].sort());
    expect(surveysAt(everyAnswer.path)).toHaveLength(6);

    // With the endpoints taking every answer and every vip's off, an answer no list holds is not
    // captured at all.
    await webhooks().setEnabled(owner, { endpointId: everyAnswer.id, enabled: false });
    await webhooks().setEnabled(owner, { endpointId: vips.id, enabled: false });
    await answer(3, { contact: ['vip'] });
    expect(await surveyEventsOf(c)).toHaveLength(6);
  });
});
