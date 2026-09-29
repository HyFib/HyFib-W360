import { randomBytes, randomInt } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock } from '@w360/core';
import { DEFAULT_EGRESS_POLICY, createEgressClient } from '@w360/core/egress';
import { authorizedTenantScope, contacts, eq, sql } from '@w360/db';
import {
  contactCreatedPayloadSchema,
  contactErasedPayloadSchema,
  contactUpdatedPayloadSchema,
  conversationAssignmentPayloadSchema,
  conversationStatusPayloadSchema,
  createContactsService,
  createInboxService,
  createWebhooksService,
  processWebhookDeliveries,
  type WebhookEventType,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Webhook events for conversations and contacts (ADR-074) against real PostgreSQL and a local
 * receiver: capture by the triggers from every kind of change, one contact event per contact and
 * transaction (savepoints included), erasure sending only `contact.erased`, delivery to the
 * endpoints that take each type, payloads built when delivered, and the capture function's limits
 * for the company role.
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
const eventsOf = (c: Company, prefix: 'conversation.' | 'contact.') =>
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
