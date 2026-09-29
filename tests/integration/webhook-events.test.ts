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
} from '@w360/db';
import {
  advanceAutomationRun,
  apiStartAutomationRun,
  authenticateApiToken,
  automationRunEndedPayloadSchema,
  automationRunStartedPayloadSchema,
  contactCreatedPayloadSchema,
  contactErasedPayloadSchema,
  contactUpdatedPayloadSchema,
  conversationAssignmentPayloadSchema,
  conversationStatusPayloadSchema,
  createApiKeysService,
  createAutomationService,
  createContactsService,
  createInboxService,
  createTemplatesService,
  createWebhooksService,
  messageReceivedPayloadSchema,
  processSendIntent,
  processTemplateSubmit,
  processWebhookDeliveries,
  syncTemplates,
  type AutomationTrigger,
  type TemplateDefinition,
  type TenantContext,
  type WebhookEventType,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Webhook events for conversations and contacts (ADR-074) and automation runs (ADR-078) against
 * real PostgreSQL and a local receiver: capture by the triggers from every kind of change, one
 * contact event per contact and transaction (savepoints included), erasure sending only
 * `contact.erased`, the start and end of live runs (not test runs), delivery to the endpoints that
 * take each type, payloads built when delivered, and the capture function's limits for the company
 * role.
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

/** An endpoint of the company taking `eventTypes`, on a path of the receiver of its own. */
async function addEndpoint(c: Company, eventTypes: WebhookEventType[]) {
  const path = `/ok/${randomBytes(6).toString('hex')}`;
  const owner = await fx.ctx(c, c.owner);
  const created = await webhooks().create(owner, {
    url: `http://${HOST}:${port}${path}`,
    eventTypes,
  });
  return { ...created, path };
}

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
  deliveries: number;
}

/** The company's captured events of the given types, oldest first, with their delivery counts. */
const eventsOf = (c: Company, prefix: 'conversation.' | 'contact.' | 'automation.') =>
  fx.query<EventRow>(
    `SELECT e.id, e.type, e.status, e.detail, e.conversation_id, e.contact_id,
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

  it('sends assignment changes when a member is assigned or unassigned, not moves between members', async () => {
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
      ['conversation.assignment_changed', { assigned: true }, 1],
      ['conversation.assignment_changed', { assigned: false }, 1],
    ]);

    await deliverDue(c);
    const bodies = bodiesAt(endpoint.path);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(conversationAssignmentPayloadSchema.safeParse(body).success).toBe(true);
    }
    expect(bodies.map((b) => b.data.conversation)).toEqual([
      { id: conversationId, status: 'resolved', assigned: true },
      { id: conversationId, status: 'resolved', assigned: false },
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
  });

  it('sends one contact.updated per save of the name, number, email or tags, and nothing for custom fields or an unchanged save', async () => {
    const c = await fx.company();
    const endpoint = await addEndpoint(c, ['contact.updated']);
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    await service.createField(owner, { label: 'City', key: 'city', type: 'text' });
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
    // A custom field and a save that changes nothing send nothing.
    await service.updateContact(owner, contactId, {
      displayName: 'Bina Rao',
      attributes: { city: 'Pune' },
    });
    await service.updateContact(owner, contactId, { displayName: 'Bina Rao' });
    counts.push(await updatesSoFar());
    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 6]);
    const events = await eventsOf(c, 'contact.');
    expect(events.map((e) => [e.type, e.deliveries])).toEqual([
      ['contact.created', 0],
      ...Array.from({ length: 6 }, () => ['contact.updated', 1]),
    ]);

    await deliverDue(c);
    const bodies = bodiesAt(endpoint.path);
    expect(bodies).toHaveLength(6);
    for (const body of bodies) {
      expect(contactUpdatedPayloadSchema.safeParse(body).success).toBe(true);
      // Built when delivered: every body shows the contact as it is now.
      expect(body.data.contact).toMatchObject({
        name: 'Bina Rao',
        phone: '+919811100013',
        email: 'bina@example.test',
        tags: ['north'],
        erased: false,
      });
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
    await fx.dbs.app.run(scope, async (tx) => {
      // A change in a savepoint that rolls back: its event goes with it.
      await tx
        .transaction(async (sp) => {
          await sp.execute(rename('Rolled back'));
          throw new Error('roll the savepoint back');
        })
        .catch((error: unknown) => {
          if (!(error instanceof Error) || error.message !== 'roll the savepoint back') throw error;
        });
      // The next change captures the event; the ones after it, in savepoints or not, add none.
      await tx.execute(rename('Gita'));
      await tx.transaction(async (sp) => {
        await sp.execute(sql`update app.contacts set email = 'gita@example.test'
          where id = ${contactId}::uuid`);
      });
      await tx.execute(sql`insert into app.contact_tags (id, tenant_id, contact_id, tag)
        values (gen_random_uuid(), ${c.tenant.id}::uuid, ${contactId}::uuid, 'gold')`);
    });
    const [row] = await fx.dbs.app.run(scope, (tx) =>
      tx.select({ name: contacts.displayName }).from(contacts).where(eq(contacts.id, contactId)),
    );
    expect(row?.name).toBe('Gita');
    expect((await eventsOf(c, 'contact.')).map((e) => [e.type, e.deliveries])).toEqual([
      ['contact.created', 0],
      ['contact.updated', 1],
    ]);
  });

  it('the capture function takes contact events only, and the company role cannot use it to delete events', async () => {
    const c = await fx.company();
    await addEndpoint(c, ['contact.created', 'contact.erased']);
    const owner = await fx.ctx(c, c.owner);
    const { id: contactId } = await contactsService().createContact(owner, {
      phone: '+919811100061',
    });
    const scope = authorizedTenantScope(c.tenant.id, c.owner.id);
    const capture = (type: string) =>
      fx.dbs.app.run(scope, (tx) =>
        tx.execute(
          sql`select app.capture_contact_webhook_event(${c.tenant.id}::uuid, ${contactId}::uuid, ${type})`,
        ),
      );
    await expectRefusedBy(capture('message.status'), /not a contact event/);
    await expectRefusedBy(capture('contact.erased'), /permission denied for table webhook_events/);
    expect((await eventsOf(c, 'contact.')).map((e) => e.type)).toEqual(['contact.created']);
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
