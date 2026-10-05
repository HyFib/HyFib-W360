import { randomBytes, randomInt } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isAppError, sha256Hex, systemClock, uuidv7, type Clock } from '@w360/core';
import {
  DEFAULT_EGRESS_POLICY,
  createEgressClient,
  type EgressClient,
  type ResolvedAddress,
} from '@w360/core/egress';
import {
  authorizedTenantScope,
  consentEvents,
  sql,
  webhookDeliveries,
  webhookEvents,
} from '@w360/db';
import {
  apiSendMessage,
  authenticateApiToken,
  consentChangedPayloadSchema,
  createApiKeysService,
  createAutomationService,
  createConsentService,
  createContactsService,
  createTemplatesService,
  createWebhooksService,
  dispatchDueWebhooks,
  findWebhookDispatchDue,
  messageReceivedPayloadSchema,
  messageStatusPayloadSchema,
  pingPayloadSchema,
  processSendIntent,
  processTemplateSubmit,
  processWebhookDeliveries,
  purgeWebhookData,
  queueTextMessage,
  syncTemplates,
  templateStatusPayloadSchema,
  verifyWebhookSignature,
  WEBHOOK_LIMITS,
  WEBHOOK_TEMPLATE_STATUSES,
  WEBHOOK_USER_AGENT,
  webhookHeadersAad,
  webhookSecretAad,
  type TenantContext,
  type WebhookDeliveryLogger,
  type WebhookEventType,
  type WebhookFailureKind,
} from '@w360/domain';
import { acceptInvitation, createUser, failOnLog, invite } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Outgoing webhooks (P5-09, ADR-053) against real PostgreSQL, the egress client and a local
 * receiver (reached through the loopback allowance that exists for tests only): endpoints and their
 * secrets, capture by the database triggers for every event type, signed at-least-once delivery,
 * the retry schedule, interrupted attempts, deliveries that cannot be prepared, automatic
 * disabling with its notice, replays and test events, secret rotation, the address guard, dispatch
 * and retention, and isolation.
 */
let fx: WhatsAppFixture;
let receiver: Server;
let port = 0;

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}
const received: Received[] = [];

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  receiver = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      const path = req.url ?? '';
      received.push({ path, headers: req.headers, body });
      if (path.startsWith('/ok')) {
        res.writeHead(204);
        res.end();
      } else if (path.startsWith('/fail')) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('broken');
      } else if (path.startsWith('/redirect')) {
        res.writeHead(302, { location: `/ok${path}` });
        res.end();
      } else if (path.startsWith('/hang')) {
        // Never answers: the egress deadline ends the attempt.
      } else {
        res.writeHead(404);
        res.end();
      }
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

const at = (date: Date): Clock => ({ now: () => date });
const later = (ms: number): Clock => ({ now: () => new Date(Date.now() + ms) });
const waId = () => `91${randomInt(7_000_000_000, 9_999_999_999)}`;
const HOST = 'hooks.receiver.test';
const APP_BASE_URL = 'https://app.w360.test';

/** The egress client used by the worker, with names resolving to the local receiver. */
const egress = (resolveTo: ResolvedAddress[] = [{ address: '127.0.0.1', family: 4 }]) =>
  createEgressClient(
    { ...DEFAULT_EGRESS_POLICY, allowLoopbackForTests: true, timeoutMs: 1_000 },
    { resolve: async () => resolveTo },
  );

function deliveryDeps(
  clock: Clock = systemClock,
  client: EgressClient = egress(),
  logger: WebhookDeliveryLogger = failOnLog,
) {
  const jobs = fx.jobs();
  return {
    db: fx.dbs.app,
    clock,
    keyring: fx.keyring,
    egress: client,
    timeoutMs: 1_000,
    jobs,
    signer: fx.signer,
    notices: { outbox: { keyring: fx.keyring, jobs, signer: fx.signer }, appBaseUrl: APP_BASE_URL },
    logger,
  };
}

const deliverDue = (
  c: Company,
  clock?: Clock,
  client?: EgressClient,
  logger?: WebhookDeliveryLogger,
) =>
  processWebhookDeliveries(
    deliveryDeps(clock, client, logger),
    authorizedTenantScope(c.tenant.id, null),
  );

const webhooks = (allowLoopbackForTests = true, clock: Clock = systemClock) =>
  createWebhooksService({
    db: fx.dbs.app,
    clock,
    keyring: fx.keyring,
    egressPolicy: { allowLoopbackForTests },
  });

async function expectAppError(promise: Promise<unknown>, code: string, message?: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe(code);
      if (message) expect(error.publicMessage).toMatch(message);
    }
    return error;
  }
  throw new Error(`expected ${code}`);
}

/** A statement the database refuses (privileges or row security), with PostgreSQL's reason. */
async function expectRefused(promise: Promise<unknown>, reason: RegExp) {
  const error = await expectAppError(promise, 'forbidden');
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    messages.push(current.message);
    current = current.cause;
  }
  expect(messages.join(' | ')).toMatch(reason);
}

/** An endpoint of the company on a path of the receiver unique to the caller. */
async function addEndpoint(
  c: Company,
  kind: 'ok' | 'fail' | 'hang' | 'redirect',
  eventTypes: WebhookEventType[],
) {
  const path = `/${kind}/${randomBytes(6).toString('hex')}`;
  const owner = await fx.ctx(c, c.owner);
  const created = await webhooks().create(owner, {
    url: `http://${HOST}:${port}${path}`,
    description: `${kind} receiver`,
    eventTypes,
  });
  return { ...created, path, owner };
}

const requestsTo = (path: string) => received.filter((r) => r.path === path);

/** Verifies a received request's signature at its own timestamp. */
function signedWith(request: Received, secret: string): boolean {
  const header = String(request.headers['w360-signature'] ?? '');
  const t = Number(/^t=(\d+)/.exec(header)?.[1] ?? 0);
  return verifyWebhookSignature({ header, secret, body: request.body, nowSeconds: t });
}

interface DeliveryRow extends Record<string, unknown> {
  id: string;
  event_id: string;
  type: string;
  status: string | null;
  state: string;
  attempts: number;
  next_attempt_at: Date;
  lease_until: Date | null;
  last_attempt_at: Date | null;
  last_status_code: number | null;
  last_error: string | null;
  delivered_at: Date | null;
  replay_of: string | null;
}

const deliveriesOf = (endpointId: string) =>
  fx.query<DeliveryRow>(
    `SELECT d.id, d.event_id, e.type, e.status, d.state, d.attempts, d.next_attempt_at,
            d.lease_until, d.last_attempt_at, d.last_status_code, d.last_error, d.delivered_at,
            d.replay_of
       FROM app.webhook_deliveries d JOIN app.webhook_events e ON e.id = d.event_id
      WHERE d.endpoint_id = $1 ORDER BY d.created_at, d.id`,
    [endpointId],
  );

const eventsOf = (c: Company) =>
  fx.query<{ id: string; type: string; status: string | null; detail: Record<string, unknown> }>(
    'SELECT id, type, status, detail FROM app.webhook_events WHERE tenant_id = $1 ORDER BY created_at, id',
    [c.tenant.id],
  );

async function endpointRow(endpointId: string) {
  const [row] = await fx.query<{
    state: string;
    disabled_reason: string | null;
    disabled_at: Date | null;
    failing_since: Date | null;
    last_success_at: Date | null;
    last_failure_at: Date | null;
    secret_ciphertext: string;
    secret_version: number;
    previous_secret_expires_at: Date | null;
  }>('SELECT * FROM app.webhook_endpoints WHERE id = $1', [endpointId]);
  if (!row) throw new Error('endpoint missing');
  return row;
}

/** An inbound text message from a contact, through the Meta webhook pipeline. */
async function inbound(c: Company, from: string, text: string) {
  await fx.deliver(fx.messagesBody(c, { messages: [{ waId: from, text }] }));
  const [row] = await fx.query<{ id: string; conversation_id: string; contact_id: string }>(
    `SELECT m.id, m.conversation_id, cv.contact_id
       FROM app.messages m JOIN app.conversations cv ON cv.id = m.conversation_id
      WHERE m.tenant_id = $1 AND m.direction = 'inbound' ORDER BY m.created_at DESC LIMIT 1`,
    [c.tenant.id],
  );
  if (!row) throw new Error('inbound message not stored');
  return row;
}

/** A text reply queued by the agent and accepted by the Graph stand-in. */
async function sendReply(c: Company, conversationId: string, text: string) {
  const agent = await fx.ctx(c, c.agent);
  const deps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock };
  const { messageId } = await queueTextMessage(deps, agent, {
    conversationId,
    text,
    clientKey: `ck-${randomBytes(6).toString('hex')}`,
  });
  const wamid = `wamid.out.${randomBytes(8).toString('hex')}`;
  fx.standIn.state.sendQueue.push({ kind: 'accept', wamid });
  const [intent] = await fx.query<{ id: string }>(
    'SELECT id FROM app.send_intents WHERE message_id = $1',
    [messageId],
  );
  const result = await processSendIntent(
    {
      ...deps,
      keyring: fx.keyring,
      graph: fx.graph,
      rate: { capacity: 100, refillPerSecond: 100 },
    },
    authorizedTenantScope(c.tenant.id, c.agent.id),
    intent!.id,
  );
  expect(result.outcome).toBe('accepted');
  return { messageId, wamid };
}

let templateCounter = 0;

/** A ping event and its delivery written straight to the tables, as a racing trigger would. */
async function captureDirectly(c: Company, endpointId: string, nextAttemptAt?: Date) {
  const eventId = uuidv7();
  const deliveryId = uuidv7();
  await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, null), async (tx) => {
    await tx.insert(webhookEvents).values({
      id: eventId,
      tenantId: c.tenant.id,
      type: 'ping',
      detail: {},
    });
    await tx.insert(webhookDeliveries).values({
      id: deliveryId,
      tenantId: c.tenant.id,
      endpointId,
      eventId,
      ...(nextAttemptAt ? { nextAttemptAt } : {}),
    });
  });
  return deliveryId;
}

/** An egress client that runs `during` while "the request is in flight", then answers `status`. */
function egressDuring(during: () => Promise<unknown>, status = 500): EgressClient {
  return {
    async request() {
      await during();
      return { status, headers: {}, body: Buffer.alloc(0), address: '127.0.0.1', durationMs: 3 };
    },
  };
}

describe('webhook endpoints', () => {
  it('are added with a secret shown once and stored encrypted, following the egress URL rules, up to the limit, by developers only', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const created = await webhooks().create(owner, {
      url: `http://${HOST}:${port}/ok/first?token=abc#fragment`,
      eventTypes: ['consent.changed', 'message.received'],
    });
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const row = await endpointRow(created.id);
    expect(row.secret_ciphertext).not.toContain(created.secret.slice(6));
    expect(
      fx.keyring.decryptString(row.secret_ciphertext, webhookSecretAad(c.tenant.id, created.id, 1)),
    ).toBe(created.secret);
    const [listed] = await webhooks().list(owner);
    // The fragment is dropped; the events keep the catalogue's order.
    expect(listed).toMatchObject({
      id: created.id,
      url: `http://${HOST}:${port}/ok/first?token=abc`,
      eventTypes: ['message.received', 'consent.changed'],
      state: 'active',
      secretVersion: 1,
      previousSecretExpiresAt: null,
    });
    expect(JSON.stringify(listed)).not.toContain('whsec_');
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toEqual({
      host: HOST,
      eventTypes: ['message.received', 'consent.changed'],
    });

    // The egress guard's URL rules, and the event list.
    const refused = async (
      url: string,
      eventTypes: unknown = ['consent.changed'],
      svc = webhooks(),
    ) => expectAppError(svc.create(owner, { url, eventTypes }), 'validation_failed');
    await refused('ftp://files.example.com/in');
    await refused('https://user:secret@hooks.example.com/in');
    // Privileged ports other than 443 (the test allowance lifts this rule, so production rules).
    await refused('https://hooks.example.com:25/in', ['consent.changed'], webhooks(false));
    await refused('not a url');
    // Within the input limit, but longer than it once normalised (each space becomes %20).
    await refused(`https://hooks.example.com/${' '.repeat(1_000)}x`);
    await refused(`http://${HOST}:${port}/ok`, ['consent.changed'], webhooks(false));
    await refused('https://hooks.example.com/in', []);
    await refused('https://hooks.example.com/in', ['ping']);
    await expectAppError(
      webhooks().create(await fx.ctx(c, c.agent), {
        url: 'https://hooks.example.com/in',
        eventTypes: ['consent.changed'],
      }),
      'forbidden',
    );

    // Twelve concurrent additions to a company with one endpoint: ten in all, never more.
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        webhooks().create(owner, {
          url: `https://hooks-${i}.example.com/in`,
          eventTypes: ['message.status'],
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(9);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(isAppError(r.reason) && r.reason.code).toBe('precondition_failed');
      }
    }
    expect(await webhooks().list(owner)).toHaveLength(10);
  });
});

describe('endpoint headers (ADR-118)', () => {
  async function headerColumns(endpointId: string) {
    const [row] = await fx.query<{ header_names: string[]; headers_ciphertext: string | null }>(
      'SELECT header_names, headers_ciphertext FROM app.webhook_endpoints WHERE id = $1',
      [endpointId],
    );
    if (!row) throw new Error('endpoint missing');
    return row;
  }

  const auditsOf = async (c: Company, action: string) =>
    (
      await fx.query<{ metadata: Record<string, unknown> }>(
        'SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id',
        [c.tenant.id, action],
      )
    ).map((row) => row.metadata);

  /** The request HyFib made for a delivery, with HyFib's own headers checked. */
  function requestFor(path: string, deliveryId: string, secret: string) {
    const matching = requestsTo(path).filter((r) => r.headers['w360-delivery-id'] === deliveryId);
    const request = matching.at(-1);
    if (!request) throw new Error(`no request for ${deliveryId}`);
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['user-agent']).toBe(WEBHOOK_USER_AGENT);
    expect(signedWith(request, secret)).toBe(true);
    return request;
  }

  it('are sent with every attempt, test event and replay beside HyFib’s own, kept sealed, and shown and audited by name only', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const token = randomBytes(16).toString('hex');
    const apiKey = randomBytes(12).toString('hex');
    const failing = `/fail/${randomBytes(6).toString('hex')}`;
    const created = await webhooks().create(owner, {
      url: `http://${HOST}:${port}${failing}`,
      eventTypes: ['consent.changed'],
      headers: [
        { name: 'Authorization', value: `Bearer ${token}` },
        { name: 'X-Api-Key', value: ` ${apiKey} ` },
      ],
    });

    // The names as written; the values only sealed, bound to the company and the endpoint.
    const columns = await headerColumns(created.id);
    expect(columns.header_names).toEqual(['Authorization', 'X-Api-Key']);
    expect(columns.headers_ciphertext).not.toMatch(new RegExp(`${token}|${apiKey}`));
    expect(
      JSON.parse(
        fx.keyring.decryptString(
          columns.headers_ciphertext!,
          webhookHeadersAad(c.tenant.id, created.id),
        ),
      ),
    ).toEqual([
      ['Authorization', `Bearer ${token}`],
      ['X-Api-Key', apiKey],
    ]);
    const [listed] = await webhooks().list(owner);
    expect(listed?.headerNames).toEqual(['Authorization', 'X-Api-Key']);
    expect(JSON.stringify(await webhooks().list(owner))).not.toMatch(
      new RegExp(`${token}|${apiKey}`),
    );
    expect(await auditsOf(c, 'webhook.endpoint_created')).toEqual([
      { host: HOST, eventTypes: ['consent.changed'], headers: ['Authorization', 'X-Api-Key'] },
    ]);

    // The first attempt of a test event, and its retry after the address changed (a change that
    // does not give headers keeps them), carry them.
    const test = await webhooks().sendTest(owner, { endpointId: created.id });
    expect(await deliverDue(c)).toMatchObject({ attempted: 1, retrying: 1 });
    const first = requestFor(failing, test.deliveryId, created.secret);
    expect(first.headers.authorization).toBe(`Bearer ${token}`);
    expect(first.headers['x-api-key']).toBe(apiKey);
    const ok = `/ok/${randomBytes(6).toString('hex')}`;
    await webhooks().update(owner, {
      endpointId: created.id,
      url: `http://${HOST}:${port}${ok}`,
      description: '',
      eventTypes: ['consent.changed'],
    });
    expect((await headerColumns(created.id)).header_names).toEqual(['Authorization', 'X-Api-Key']);
    expect(await deliverDue(c, later(61_000))).toMatchObject({ attempted: 1, succeeded: 1 });
    const retry = requestFor(ok, test.deliveryId, created.secret);
    expect(retry.headers['w360-delivery-attempt']).toBe('2');
    expect(retry.headers.authorization).toBe(`Bearer ${token}`);
    expect(retry.headers['x-api-key']).toBe(apiKey);

    // A replay carries them too.
    const replay = await webhooks().replay(owner, { deliveryId: test.deliveryId });
    expect(await deliverDue(c)).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(requestFor(ok, replay.deliveryId, created.secret).headers.authorization).toBe(
      `Bearer ${token}`,
    );
    expect((await auditsOf(c, 'webhook.endpoint_updated')).at(-1)).toEqual({
      host: HOST,
      eventTypes: ['consent.changed'],
    });

    // Given again, they replace all of them; an empty list removes them.
    await webhooks().update(owner, {
      endpointId: created.id,
      url: `http://${HOST}:${port}${ok}`,
      description: '',
      eventTypes: ['consent.changed'],
      headers: [{ name: 'authorization', value: 'Bearer second' }],
    });
    expect((await webhooks().list(owner))[0]?.headerNames).toEqual(['authorization']);
    expect((await auditsOf(c, 'webhook.endpoint_updated')).at(-1)).toEqual({
      host: HOST,
      eventTypes: ['consent.changed'],
      headers: ['authorization'],
    });
    const replaced = await webhooks().sendTest(owner, { endpointId: created.id });
    expect(await deliverDue(c)).toMatchObject({ attempted: 1, succeeded: 1 });
    const afterReplace = requestFor(ok, replaced.deliveryId, created.secret);
    expect(afterReplace.headers.authorization).toBe('Bearer second');
    expect(afterReplace.headers['x-api-key']).toBeUndefined();

    await webhooks().update(owner, {
      endpointId: created.id,
      url: `http://${HOST}:${port}${ok}`,
      description: '',
      eventTypes: ['consent.changed'],
      headers: [],
    });
    expect(await headerColumns(created.id)).toEqual({ header_names: [], headers_ciphertext: null });
    expect((await auditsOf(c, 'webhook.endpoint_updated')).at(-1)).toEqual({
      host: HOST,
      eventTypes: ['consent.changed'],
      headers: [],
    });
    const removed = await webhooks().sendTest(owner, { endpointId: created.id });
    expect(await deliverDue(c)).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(
      requestFor(ok, removed.deliveryId, created.secret).headers.authorization,
    ).toBeUndefined();
  });

  it('are refused when HyFib sets them, misnamed, empty, not printable ASCII, given twice or more than 5, changing nothing', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (headers: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes: ['consent.changed'], headers }),
        'validation_failed',
        message,
      );
    await refused([{ name: 'Content-Type', value: 'text/plain' }], /HyFib sets this header/);
    await refused([{ name: 'w360-signature', value: 't=1,v1=00' }], /HyFib sets this header/);
    await refused([{ name: 'Proxy-Authorization', value: 'Basic x' }], /HyFib sets this header/);
    await refused([{ name: 'X_Key', value: 'v' }], /letters, digits and -/);
    await refused([{ name: 'X-Key', value: ' ' }], /Enter the header’s value/);
    await refused([{ name: 'X-Key', value: 'a\r\nX-Injected: 1' }], /printable ASCII/);
    await refused([{ name: 'X-Key', value: 'x'.repeat(1_001) }], /limited to 1000 characters/);
    await refused(
      [
        { name: 'X-Key', value: 'a' },
        { name: 'x-key', value: 'b' },
      ],
      /Give each header once/,
    );
    await refused(
      Array.from({ length: 6 }, (_, i) => ({ name: `X-H${i}`, value: 'v' })),
      /at most 5 headers/,
    );
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['consent.changed'],
      headers: [{ name: 'Authorization', value: 'Bearer kept' }],
    });
    const before = await headerColumns(created.id);
    await expectAppError(
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: 'changed',
        eventTypes: ['consent.changed'],
        headers: [{ name: 'User-Agent', value: 'mine' }],
      }),
      'validation_failed',
      /HyFib sets this header/,
    );
    expect(await headerColumns(created.id)).toEqual(before);
    expect((await webhooks().list(owner))[0]?.description).toBeNull();
  });

  it('are kept by the database as names and sealed values together, at most 5', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['consent.changed']);
    await expect(
      fx.query(`UPDATE app.webhook_endpoints SET header_names = '{Authorization}' WHERE id = $1`, [
        e.id,
      ]),
    ).rejects.toThrow(/webhook_endpoints_headers/);
    await expect(
      fx.query(`UPDATE app.webhook_endpoints SET headers_ciphertext = 'x' WHERE id = $1`, [e.id]),
    ).rejects.toThrow(/webhook_endpoints_headers/);
    await expect(
      fx.query(
        `UPDATE app.webhook_endpoints SET header_names = '{a,b,c,d,e,f}', headers_ciphertext = 'x' WHERE id = $1`,
        [e.id],
      ),
    ).rejects.toThrow(/webhook_endpoints_headers/);
  });
});

describe('message status filters (ADR-119)', () => {
  const statusesOf = (path: string) =>
    requestsTo(path)
      .filter((r) => r.headers['w360-event-type'] === 'message.status')
      .map((r) => messageStatusPayloadSchema.parse(JSON.parse(r.body)).data.message.status);

  it('send an endpoint only the statuses it takes, another every status, and capture no event nobody takes', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const from = waId();
    const msg = await inbound(c, from, 'Hi');
    const add = async (messageStatuses: string[] | null, eventTypes = ['message.status']) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes,
        messageStatuses,
      });
      return { ...created, path };
    };
    const status = (wamid: string, value: string, extra: Record<string, unknown> = {}) =>
      fx.deliver(
        fx.messagesBody(c, {
          statuses: [
            {
              id: wamid,
              status: value,
              timestamp: String(Math.floor(Date.now() / 1000) + 5),
              recipient_id: from,
              ...extra,
            },
          ],
        }),
      );
    const messageStatusEvents = async () =>
      (await eventsOf(c)).filter((e) => e.type === 'message.status').map((e) => e.status);

    // Only failures: neither the acceptance nor the delivery of a reply is captured at all.
    const failures = await add(['failed'], ['message.status', 'message.received']);
    expect((await webhooks().list(owner))[0]?.messageStatuses).toEqual(['failed']);
    const [created] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(created?.metadata).toMatchObject({ messageStatuses: ['failed'] });
    const first = await sendReply(c, msg.conversation_id, 'It ships today.');
    await status(first.wamid, 'delivered');
    expect(await messageStatusEvents()).toEqual([]);
    const second = await sendReply(c, msg.conversation_id, 'And a second note.');
    await status(second.wamid, 'failed', {
      errors: [{ code: 131026, title: 'Message undeliverable' }],
    });
    expect(await messageStatusEvents()).toEqual(['failed']);
    // Its other events are not filtered: the customer's next message is captured for it.
    await inbound(c, from, 'Thanks');
    expect((await eventsOf(c)).map((e) => e.type)).toEqual(['message.status', 'message.received']);

    // Then an endpoint taking every status and one taking deliveries and reads.
    const everything = await add(null);
    const deliveries = await add(['read', 'delivered']);
    expect((await webhooks().list(owner)).map((e) => [e.id, e.messageStatuses])).toEqual(
      expect.arrayContaining([
        [everything.id, null],
        [deliveries.id, ['delivered', 'read']],
      ]),
    );
    const third = await sendReply(c, msg.conversation_id, 'A third note.');
    await status(third.wamid, 'delivered');
    expect(await messageStatusEvents()).toEqual(['failed', 'accepted', 'delivered']);

    expect(await deliverDue(c)).toMatchObject({ attempted: 5, succeeded: 5 });
    expect(
      requestsTo(failures.path)
        .map((r) => String(r.headers['w360-event-type']))
        .sort(),
    ).toEqual(['message.received', 'message.status']);
    expect(statusesOf(failures.path)).toEqual(['failed']);
    expect(statusesOf(everything.path).sort()).toEqual(['accepted', 'delivered']);
    expect(statusesOf(deliveries.path)).toEqual(['delivered']);
  });

  it('are refused without message.status, unknown or empty, kept by a change that leaves them out and cleared with the event; the database keeps them to that event', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], messageStatuses: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, messageStatuses }),
        'validation_failed',
        message,
      );
    await refused(
      ['consent.changed'],
      ['failed'],
      /only for an endpoint that receives Message status/,
    );
    await refused(['message.status'], [], /at least one message status/);
    await refused(['message.status'], ['queued'], /from the list/);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['message.status', 'consent.changed'],
      messageStatuses: ['failed', 'canceled'],
    });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['message.status', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.messageStatuses;
    await change({ description: 'kept' });
    expect(await current()).toEqual(['failed', 'canceled']);
    await change({ messageStatuses: ['read'] });
    expect(await current()).toEqual(['read']);
    const updates = await fx.query<{ metadata: { messageStatuses?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.messageStatuses)).toEqual([
      ['failed', 'canceled'],
      ['read'],
    ]);
    await change({ messageStatuses: null });
    expect(await current()).toBeNull();
    await change({ messageStatuses: ['failed'] });
    // The database refuses an empty list or an unknown status from an endpoint taking the event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET message_statuses = ${value} WHERE id = $1`, [
        created.id,
      ]);
    for (const bad of [`'{}'`, `'{failed,queued}'`]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_message_statuses/);
    }
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['consent.changed'], messageStatuses: ['failed'] }),
      'validation_failed',
      /only for an endpoint that receives Message status/,
    );
    // …and any list for an endpoint that does not take it.
    await expect(setInDatabase(`'{failed}'`)).rejects.toThrow(/webhook_endpoints_message_statuses/);
  });
});

describe('contact part filters (ADR-123)', () => {
  it('are refused without contact.updated, unknown or empty, kept by a change that leaves them out and cleared with the event; the database keeps them to that event', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], contactParts: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, contactParts }),
        'validation_failed',
        message,
      );
    await refused(
      ['contact.created', 'contact.erased'],
      ['email'],
      /only for an endpoint that receives Contact changed/,
    );
    await refused(['contact.updated'], [], /at least one contact part/);
    await refused(['contact.updated'], ['fields.plan'], /from the list/);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['contact.updated', 'contact.erased'],
      contactParts: ['tags', 'email'],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ contactParts: ['email', 'tags'] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['contact.updated', 'contact.erased'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.contactParts;
    expect(await current()).toEqual(['email', 'tags']);
    await change({ description: 'kept' });
    expect(await current()).toEqual(['email', 'tags']);
    await change({ contactParts: ['name'] });
    expect(await current()).toEqual(['name']);
    const updates = await fx.query<{ metadata: { contactParts?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.contactParts)).toEqual([['email', 'tags'], ['name']]);
    await change({ contactParts: null });
    expect(await current()).toBeNull();
    await change({ contactParts: ['fields'] });
    // The database refuses an empty list, an unknown part or a field key from an endpoint taking
    // the event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET contact_parts = ${value} WHERE id = $1`, [
        created.id,
      ]);
    for (const bad of [`'{}'`, `'{email,address}'`, `'{fields.plan}'`]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_contact_parts/);
    }
    await change({ eventTypes: ['contact.erased'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['contact.erased'], contactParts: ['email'] }),
      'validation_failed',
      /only for an endpoint that receives Contact changed/,
    );
    // …and any list for an endpoint that does not take it.
    await expect(setInDatabase(`'{email}'`)).rejects.toThrow(/webhook_endpoints_contact_parts/);
  });
});

describe('campaign status filters (ADR-146)', () => {
  it('are refused without campaign.status_changed, unknown or empty, kept by a change that leaves them out and cleared with the event; the database keeps them to that event', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], campaignStatuses: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, campaignStatuses }),
        'validation_failed',
        message,
      );
    await refused(
      ['message.status'],
      ['paused'],
      /only for an endpoint that receives Campaign status/,
    );
    await refused(['campaign.status_changed'], [], /at least one campaign status/);
    await refused(['campaign.status_changed'], ['sending'], /from the list/);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['campaign.status_changed', 'consent.changed'],
      campaignStatuses: ['completed', 'paused', 'completed'],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ campaignStatuses: ['paused', 'completed'] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['campaign.status_changed', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.campaignStatuses;
    expect(await current()).toEqual(['paused', 'completed']);
    await change({ description: 'kept' });
    expect(await current()).toEqual(['paused', 'completed']);
    await change({ campaignStatuses: ['canceled'] });
    expect(await current()).toEqual(['canceled']);
    const updates = await fx.query<{ metadata: { campaignStatuses?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.campaignStatuses)).toEqual([
      ['paused', 'completed'],
      ['canceled'],
    ]);
    await change({ campaignStatuses: null });
    expect(await current()).toBeNull();
    await change({ campaignStatuses: ['running'] });
    // The database refuses an empty list, more than seven entries, an unknown status or a missing
    // one from an endpoint taking the event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET campaign_statuses = ${value} WHERE id = $1`, [
        created.id,
      ]);
    for (const bad of [
      `'{}'`,
      `'{${Array(8).fill('paused').join(',')}}'`,
      `'{paused,sending}'`,
      `ARRAY['paused', NULL]::text[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_campaign_statuses/);
    }
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['consent.changed'], campaignStatuses: ['paused'] }),
      'validation_failed',
      /only for an endpoint that receives Campaign status/,
    );
    // …and any list for an endpoint that does not take it.
    await expect(setInDatabase(`'{paused}'`)).rejects.toThrow(
      /webhook_endpoints_campaign_statuses/,
    );
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'campaign_statuses',
                'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });
});

describe('order status filters (ADR-147)', () => {
  it('are refused without order.status_changed, unknown, received or empty, kept by a change that leaves them out and cleared with the event; the database keeps them to that event', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], orderStatuses: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, orderStatuses }),
        'validation_failed',
        message,
      );
    await refused(['order.received'], ['paid'], /only for an endpoint that receives Order status/);
    await refused(['order.status_changed'], [], /at least one order status/);
    await refused(['order.status_changed'], ['received'], /from the list/);
    await refused(['order.status_changed'], ['canceled'], /from the list/);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['order.status_changed', 'consent.changed'],
      orderStatuses: ['cancelled', 'paid', 'cancelled'],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ orderStatuses: ['paid', 'cancelled'] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['order.status_changed', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.orderStatuses;
    expect(await current()).toEqual(['paid', 'cancelled']);
    await change({ description: 'kept' });
    expect(await current()).toEqual(['paid', 'cancelled']);
    await change({ orderStatuses: ['fulfilled'] });
    expect(await current()).toEqual(['fulfilled']);
    const updates = await fx.query<{ metadata: { orderStatuses?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.orderStatuses)).toEqual([
      ['paid', 'cancelled'],
      ['fulfilled'],
    ]);
    await change({ orderStatuses: null });
    expect(await current()).toBeNull();
    await change({ orderStatuses: ['awaiting_payment'] });
    // The database refuses an empty list, more than five entries, an unknown status, received or a
    // missing one from an endpoint taking the event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET order_statuses = ${value} WHERE id = $1`, [
        created.id,
      ]);
    for (const bad of [
      `'{}'`,
      `'{${Array(6).fill('paid').join(',')}}'`,
      `'{paid,received}'`,
      `'{paid,canceled}'`,
      `ARRAY['paid', NULL]::text[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_order_statuses/);
    }
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['consent.changed'], orderStatuses: ['paid'] }),
      'validation_failed',
      /only for an endpoint that receives Order status/,
    );
    // …and any list for an endpoint that does not take it.
    await expect(setInDatabase(`'{paid}'`)).rejects.toThrow(/webhook_endpoints_order_statuses/);
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'order_statuses',
                'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });
});

describe('template status filters (ADR-148)', () => {
  /** A utility template HyFib submits and Meta's stand-in takes for review: `pending`. */
  async function submitted(c: Company, owner: TenantContext) {
    templateCounter += 1;
    const name = `wh_flt_${templateCounter}_${Date.now().toString(36)}`;
    const templateDeps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock };
    const templates = createTemplatesService(templateDeps);
    const { id } = await templates.createDraft(owner, {
      whatsappAccountId: c.whatsappAccountId,
      name,
      language: 'en',
      definition: {
        category: 'UTILITY',
        header: { type: 'none' },
        body: { text: 'Your order {{1}} is ready.', examples: ['A-1'] },
        footer: null,
        buttons: [],
      },
    });
    await templates.submitTemplate(owner, id);
    const graphDeps = { ...templateDeps, keyring: fx.keyring, graph: fx.graph };
    const scope = authorizedTenantScope(c.tenant.id, null);
    expect(await processTemplateSubmit(graphDeps, scope, id)).toBe('done');
    const atMeta = fx.standIn.state.templates.get(c.wabaId)?.find((x) => x.name === name);
    if (!atMeta) throw new Error('template not at the stand-in');
    /** Meta's review gives the template `status`, which the next sync reads. */
    const review = async (status: string) => {
      atMeta.status = status;
      await syncTemplates(graphDeps, scope, c.whatsappAccountId);
    };
    return { id, review };
  }

  const statusesOf = (path: string) =>
    requestsTo(path)
      .filter((r) => r.headers['w360-event-type'] === 'template.status_changed')
      .map((r) => templateStatusPayloadSchema.parse(JSON.parse(r.body)).data.template.status);

  it('send an endpoint only the statuses it takes, another every status, and capture no event nobody takes', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const add = async (
      templateStatuses: string[] | null,
      eventTypes: WebhookEventType[] = ['template.status_changed'],
    ) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes,
        templateStatuses,
      });
      return { ...created, path };
    };
    const templateEvents = async () =>
      (await eventsOf(c)).filter((e) => e.type === 'template.status_changed').map((e) => e.status);

    // Only approvals: Meta's review is not captured at all until it approves the template.
    const approvals = await add(['approved'], ['template.status_changed', 'message.received']);
    expect((await webhooks().list(owner))[0]?.templateStatuses).toEqual(['approved']);
    const [created] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(created?.metadata).toMatchObject({ templateStatuses: ['approved'] });
    const shipped = await submitted(c, owner);
    expect(await templateEvents()).toEqual([]);
    await shipped.review('APPROVED');
    expect(await templateEvents()).toEqual(['approved']);
    // Its other events are not filtered: a customer's message is captured for it.
    await inbound(c, waId(), 'Hello');
    expect((await eventsOf(c)).map((e) => e.type)).toEqual([
      'template.status_changed',
      'message.received',
    ]);

    // Then an endpoint taking every status and one taking rejections and pauses.
    const everything = await add(null);
    const problems = await add(['paused', 'rejected']);
    expect((await webhooks().list(owner)).map((e) => [e.id, e.templateStatuses])).toEqual(
      expect.arrayContaining([
        [everything.id, null],
        [problems.id, ['rejected', 'paused']],
      ]),
    );
    const refused = await submitted(c, owner);
    await refused.review('REJECTED');
    await shipped.review('PAUSED');
    expect(await templateEvents()).toEqual(['approved', 'pending', 'rejected', 'paused']);

    expect(await deliverDue(c)).toMatchObject({ attempted: 7, succeeded: 7 });
    expect(
      requestsTo(approvals.path)
        .map((r) => String(r.headers['w360-event-type']))
        .sort(),
    ).toEqual(['message.received', 'template.status_changed']);
    expect(statusesOf(approvals.path)).toEqual(['approved']);
    expect(statusesOf(everything.path).sort()).toEqual(['paused', 'pending', 'rejected']);
    expect(statusesOf(problems.path).sort()).toEqual(['paused', 'rejected']);
  });

  it('can name every status the capture trigger sends, and only those', async () => {
    const quoted = (definition: string | undefined) =>
      [...(definition ?? '').matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
    const [trigger] = await fx.query<{ definition: string }>(
      `SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
        WHERE tgname = 'template_status_events_webhook'`,
    );
    expect(quoted(trigger?.definition)).toEqual([...WEBHOOK_TEMPLATE_STATUSES]);
    const [check] = await fx.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'webhook_endpoints_template_statuses'`,
    );
    expect(quoted(check?.definition)).toEqual([...WEBHOOK_TEMPLATE_STATUSES]);
  });

  it("are refused without template.status_changed, unknown, one of HyFib's own steps or empty, kept by a change that leaves them out and cleared with the event; the database keeps them to that event", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], templateStatuses: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, templateStatuses }),
        'validation_failed',
        message,
      );
    await refused(
      ['message.status'],
      ['rejected'],
      /only for an endpoint that receives Template status/,
    );
    await refused(['template.status_changed'], [], /at least one template status/);
    await refused(['template.status_changed'], ['draft'], /from the list/);
    await refused(['template.status_changed'], ['pending_deletion'], /from the list/);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['template.status_changed', 'consent.changed'],
      templateStatuses: ['paused', 'rejected', 'paused'],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ templateStatuses: ['rejected', 'paused'] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['template.status_changed', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.templateStatuses;
    expect(await current()).toEqual(['rejected', 'paused']);
    await change({ description: 'kept' });
    expect(await current()).toEqual(['rejected', 'paused']);
    await change({ templateStatuses: ['disabled'] });
    expect(await current()).toEqual(['disabled']);
    const updates = await fx.query<{ metadata: { templateStatuses?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.templateStatuses)).toEqual([
      ['rejected', 'paused'],
      ['disabled'],
    ]);
    await change({ templateStatuses: null });
    expect(await current()).toBeNull();
    await change({ templateStatuses: ['locked'] });
    // The database refuses an empty list, more than eleven entries, an unknown status, one of
    // HyFib's own steps or a missing one from an endpoint taking the event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET template_statuses = ${value} WHERE id = $1`, [
        created.id,
      ]);
    for (const bad of [
      `'{}'`,
      `'{${Array(12).fill('approved').join(',')}}'`,
      `'{approved,draft}'`,
      `'{approved,pending_deletion}'`,
      `'{approved,unknown}'`,
      `ARRAY['approved', NULL]::text[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_template_statuses/);
    }
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['consent.changed'], templateStatuses: ['rejected'] }),
      'validation_failed',
      /only for an endpoint that receives Template status/,
    );
    // …and any list for an endpoint that does not take it.
    await expect(setInDatabase(`'{approved}'`)).rejects.toThrow(
      /webhook_endpoints_template_statuses/,
    );
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'template_statuses',
                'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });
});

describe('conversation status filters (ADR-149)', () => {
  it('are refused without conversation.status_changed, unknown, pending or empty, kept by a change that leaves them out and cleared with the event; the database keeps them to that event', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], conversationStatuses: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, conversationStatuses }),
        'validation_failed',
        message,
      );
    await refused(
      ['conversation.team_changed'],
      ['resolved'],
      /only for an endpoint that receives Conversation status/,
    );
    await refused(['conversation.status_changed'], [], /at least one conversation status/);
    await refused(['conversation.status_changed'], ['pending'], /from the list/);
    await refused(['conversation.status_changed'], ['closed'], /from the list/);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['conversation.status_changed', 'consent.changed'],
      conversationStatuses: ['resolved', 'open'],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ conversationStatuses: ['open', 'resolved'] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['conversation.status_changed', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.conversationStatuses;
    expect(await current()).toEqual(['open', 'resolved']);
    await change({ description: 'kept' });
    expect(await current()).toEqual(['open', 'resolved']);
    await change({ conversationStatuses: ['resolved'] });
    expect(await current()).toEqual(['resolved']);
    const updates = await fx.query<{ metadata: { conversationStatuses?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.conversationStatuses)).toEqual([
      ['open', 'resolved'],
      ['resolved'],
    ]);
    await change({ conversationStatuses: null });
    expect(await current()).toBeNull();
    await change({ conversationStatuses: ['open'] });
    // The database refuses an empty list, more than two entries, an unknown status, pending or a
    // missing one from an endpoint taking the event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET conversation_statuses = ${value} WHERE id = $1`, [
        created.id,
      ]);
    for (const bad of [
      `'{}'`,
      `'{open,resolved,open}'`,
      `'{open,pending}'`,
      `'{open,closed}'`,
      `ARRAY['open', NULL]::text[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(
        /webhook_endpoints_conversation_statuses/,
      );
    }
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['consent.changed'], conversationStatuses: ['resolved'] }),
      'validation_failed',
      /only for an endpoint that receives Conversation status/,
    );
    // …and any list for an endpoint that does not take it.
    await expect(setInDatabase(`'{resolved}'`)).rejects.toThrow(
      /webhook_endpoints_conversation_statuses/,
    );
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'conversation_statuses',
                'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });
});

describe('message sender filters (ADR-172)', () => {
  it('are refused without message.status, unknown or empty, kept by a change that leaves them out and cleared with the event; the database keeps them to that event', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], messageSenders: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, messageSenders }),
        'validation_failed',
        message,
      );
    // A received message has no sender to choose, and a contact sends no status.
    await refused(
      ['message.received'],
      ['api'],
      /only for an endpoint that receives Message status/,
    );
    await refused(['message.status'], [], /at least one sender/);
    await refused(['message.status'], ['contact'], /from the list/);
    await refused(['message.status'], ['member'], /from the list/);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['message.status', 'consent.changed'],
      messageSenders: ['api', 'campaign', 'api'],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ messageSenders: ['campaign', 'api'] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['message.status', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.messageSenders;
    expect(await current()).toEqual(['campaign', 'api']);
    await change({ description: 'kept' });
    expect(await current()).toEqual(['campaign', 'api']);
    await change({ messageSenders: ['api'] });
    expect(await current()).toEqual(['api']);
    const updates = await fx.query<{ metadata: { messageSenders?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.messageSenders)).toEqual([['campaign', 'api'], ['api']]);
    await change({ messageSenders: null });
    expect(await current()).toBeNull();
    await change({ messageSenders: ['system'] });
    // The database refuses an empty list, more than five entries, a contact, an unknown sender or a
    // missing one from an endpoint taking the event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET message_senders = ${value} WHERE id = $1`, [
        created.id,
      ]);
    for (const bad of [
      `'{}'`,
      `'{agent,bot,campaign,api,system,api}'`,
      `'{api,contact}'`,
      `'{api,member}'`,
      `ARRAY['api', NULL]::text[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_message_senders/);
    }
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['consent.changed'], messageSenders: ['api'] }),
      'validation_failed',
      /only for an endpoint that receives Message status/,
    );
    // …and any list for an endpoint that does not take it, received messages included.
    await change({ eventTypes: ['message.received'] });
    await expect(setInDatabase(`'{api}'`)).rejects.toThrow(/webhook_endpoints_message_senders/);
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'message_senders',
                'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });

  /** A text reply sent through the API by a key of the company and accepted by the stand-in. */
  async function apiReply(c: Company, to: string, text: string) {
    const owner = await fx.ctx(c, c.owner);
    const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
      owner,
      {
        name: `Helpdesk ${randomBytes(3).toString('hex')}`,
        scopes: ['messages.reply'],
        expiresInDays: 0,
      },
    );
    const key = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    if (!key) throw new Error('a new key does not authenticate');
    const deps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock };
    const sent = await apiSendMessage(
      deps,
      key,
      { type: 'text', to: `+${to}`, text },
      { key: `reply-${randomBytes(6).toString('hex')}`, requestHash: sha256Hex(text) },
    );
    expect(sent.status).toBe(201);
    const messageId = (sent.body as { data: { id: string } }).data.id;
    fx.standIn.state.sendQueue.push({
      kind: 'accept',
      wamid: `wamid.api.${randomBytes(8).toString('hex')}`,
    });
    const [intent] = await fx.query<{ id: string }>(
      'SELECT id FROM app.send_intents WHERE message_id = $1',
      [messageId],
    );
    const result = await processSendIntent(
      {
        ...deps,
        keyring: fx.keyring,
        graph: fx.graph,
        rate: { capacity: 100, refillPerSecond: 100 },
      },
      authorizedTenantScope(c.tenant.id, null),
      intent!.id,
    );
    expect(result.outcome).toBe('accepted');
    return messageId;
  }

  it('send an endpoint only the statuses of messages the senders it names sent, another every status, and capture none nobody takes', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const from = waId();
    const msg = await inbound(c, from, 'Hi');
    const add = async (messageSenders: string[] | null) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes: ['message.status', 'message.received'],
        messageSenders,
      });
      return { ...created, path };
    };
    const statusEvents = async () =>
      (await eventsOf(c))
        .filter((e) => e.type === 'message.status')
        .map((e) => [e.status, e.detail]);

    // Only the API's messages: a member's reply is accepted with nothing captured.
    const apiOnly = await add(['api']);
    expect((await webhooks().list(owner))[0]?.messageSenders).toEqual(['api']);
    await sendReply(c, msg.conversation_id, 'A member replies.');
    expect(await statusEvents()).toEqual([]);
    const fromApi = await apiReply(c, from, 'The API replies.');
    // Stored as events always were: who sent it is not kept with the event.
    expect(await statusEvents()).toEqual([['accepted', {}]]);
    // Its other events are not filtered: the customer's next message is captured for it.
    await inbound(c, from, 'Thanks');

    // An endpoint for every sender hears both from now on.
    const every = await add(null);
    await sendReply(c, msg.conversation_id, 'Another member reply.');
    await apiReply(c, from, 'Another API reply.');
    const typesTo = async (endpointId: string) =>
      (await deliveriesOf(endpointId)).map((d) => [d.type, d.status]);
    expect(await typesTo(apiOnly.id)).toEqual([
      ['message.status', 'accepted'],
      ['message.received', null],
      ['message.status', 'accepted'],
    ]);
    expect(await typesTo(every.id)).toEqual([
      ['message.status', 'accepted'],
      ['message.status', 'accepted'],
    ]);

    // Each status names who sent its message.
    expect(await deliverDue(c)).toMatchObject({ attempted: 5, succeeded: 5 });
    const sentByAt = (path: string) =>
      requestsTo(path)
        .filter((r) => r.headers['w360-event-type'] === 'message.status')
        .map((r) => {
          const { message } = messageStatusPayloadSchema.parse(JSON.parse(r.body)).data;
          return [message.sentBy, message.id === fromApi ? 'first API reply' : 'later'];
        })
        .sort();
    expect(sentByAt(apiOnly.path)).toEqual([
      ['api', 'first API reply'],
      ['api', 'later'],
    ]);
    expect(sentByAt(every.path)).toEqual([
      ['agent', 'later'],
      ['api', 'later'],
    ]);
  });
});

describe('run end filters (ADR-151)', () => {
  it('are refused without automation.run_ended, unknown, active or empty, kept by a change that leaves them out and cleared with the event; the database keeps them to that event', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], runEndStatuses: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, runEndStatuses }),
        'validation_failed',
        message,
      );
    // A run's start is not its end, and a run still going has not ended.
    await refused(
      ['automation.run_started'],
      ['failed'],
      /only for an endpoint that receives Automation ended/,
    );
    await refused(['automation.run_ended'], [], /at least one way a run ends/);
    await refused(['automation.run_ended'], ['running'], /from the list/);
    await refused(['automation.run_ended'], ['waiting'], /from the list/);
    await refused(['automation.run_ended'], ['crashed'], /from the list/);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['automation.run_ended', 'consent.changed'],
      runEndStatuses: ['failed', 'handed_off', 'failed'],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ runEndStatuses: ['handed_off', 'failed'] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['automation.run_ended', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.runEndStatuses;
    expect(await current()).toEqual(['handed_off', 'failed']);
    await change({ description: 'kept' });
    expect(await current()).toEqual(['handed_off', 'failed']);
    await change({ runEndStatuses: ['failed'] });
    expect(await current()).toEqual(['failed']);
    const updates = await fx.query<{ metadata: { runEndStatuses?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.runEndStatuses)).toEqual([
      ['handed_off', 'failed'],
      ['failed'],
    ]);
    await change({ runEndStatuses: null });
    expect(await current()).toBeNull();
    await change({ runEndStatuses: ['completed'] });
    // The database refuses an empty list, more than five entries, a status a run has while it goes
    // on, an unknown status or a missing one from an endpoint taking the event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET run_end_statuses = ${value} WHERE id = $1`, [
        created.id,
      ]);
    for (const bad of [
      `'{}'`,
      `'{completed,handed_off,taken_over,stopped,failed,failed}'`,
      `'{completed,running}'`,
      `'{completed,waiting}'`,
      `'{completed,crashed}'`,
      `ARRAY['completed', NULL]::text[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_run_end_statuses/);
    }
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['consent.changed'], runEndStatuses: ['failed'] }),
      'validation_failed',
      /only for an endpoint that receives Automation ended/,
    );
    // …and any list for an endpoint that does not take it, run starts included.
    await change({ eventTypes: ['automation.run_started'] });
    await expect(setInDatabase(`'{failed}'`)).rejects.toThrow(/webhook_endpoints_run_end_statuses/);
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'run_end_statuses',
                'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });
});

describe('automation filters (ADR-145)', () => {
  const automationService = () =>
    createAutomationService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
    });

  /** An automation of the company replying to its name, published unless it stays a draft. */
  async function automation(owner: TenantContext, name: string, draft = false) {
    const svc = automationService();
    const { id } = await svc.createAutomation(owner, { name });
    const saved = await svc.updateAutomation(owner, {
      id,
      expectedVersion: 0,
      name,
      description: null,
      channelAccountId: null,
      trigger: {
        type: 'keyword',
        keywords: [name.toLowerCase()],
        match: 'contains',
        hours: 'any',
        cooldownMinutes: 0,
      },
      graph: {
        version: 1,
        start: 'say',
        nodes: [{ id: 'say', type: 'send_text', text: `${name} here.`, next: null }],
      },
    });
    expect(saved.issues).toEqual([]);
    if (draft) return { id, version: saved.version };
    const published = await svc.publishAutomation(owner, {
      id,
      expectedVersion: saved.version,
      note: null,
    });
    return { id, version: published.version };
  }

  /** A member's test run of a draft in a new conversation: the draft gains a test version only. */
  async function tested(c: Company, owner: TenantContext, draft: { id: string; version: number }) {
    const { conversation_id: conversationId } = await inbound(c, waId(), 'Hi');
    await automationService().startTestRun(owner, {
      id: draft.id,
      expectedVersion: draft.version,
      conversationId,
    });
    const versions = await fx.query<{ kind: string }>(
      'SELECT kind FROM app.automation_versions WHERE automation_id = $1',
      [draft.id],
    );
    expect(versions.map((v) => v.kind)).toEqual(['test']);
  }

  it('are refused without an automation run event, empty, over 20 or naming an automation the company has not published; kept by a change that leaves them out and cleared with the events; the database keeps them to those events', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const greeter = await automation(owner, 'Greeter');
    const farewell = await automation(owner, 'Farewell');
    const draft = await automation(owner, 'Draft', true);
    await tested(c, owner, draft);
    const d = await fx.company();
    const elsewhere = await automation(await fx.ctx(d, d.owner), 'Elsewhere');
    const url = 'https://hooks.example.com/in';
    const runs = ['automation.run_started', 'automation.run_ended'];
    const refused = async (
      eventTypes: string[],
      automationIds: unknown,
      message: RegExp,
      path = 'automationIds',
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, automationIds }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(automationIds)).toBe(
        path,
      );
    };
    await refused(
      ['consent.changed'],
      [greeter.id],
      /only for an endpoint that receives Automation started or Automation ended/,
    );
    await refused(runs, [], /at least one automation/);
    await refused(runs, ['greeter'], /from the list/, 'automationIds.0');
    await refused(
      runs,
      Array.from({ length: 21 }, () => uuidv7()),
      /at most 20 automations/,
    );
    // Only the company's published automations: not a draft (even one tested), another company's or
    // an unknown id.
    await refused(runs, [greeter.id, draft.id], /that have been published/, 'automationIds.1');
    await refused(runs, [elsewhere.id], /that have been published/, 'automationIds.0');
    await refused(
      ['automation.run_ended'],
      [uuidv7()],
      /that have been published/,
      'automationIds.0',
    );
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: [...runs, 'consent.changed'],
      automationIds: [farewell.id, greeter.id.toUpperCase(), farewell.id],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ automationIds: [farewell.id, greeter.id] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: [...runs, 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.automations;
    expect(await current()).toEqual([
      { id: farewell.id, name: 'Farewell', archived: false },
      { id: greeter.id, name: 'Greeter', archived: false },
    ]);
    await change({ description: 'kept' });
    expect((await current())?.map((a) => a.id)).toEqual([farewell.id, greeter.id]);
    // An archived automation stays named, and stays allowed in a list given again.
    await automationService().archiveAutomation(owner, {
      id: greeter.id,
      expectedVersion: greeter.version,
    });
    expect(await current()).toEqual([
      { id: farewell.id, name: 'Farewell', archived: false },
      { id: greeter.id, name: 'Greeter', archived: true },
    ]);
    await change({ automationIds: [greeter.id] });
    expect(await current()).toEqual([{ id: greeter.id, name: 'Greeter', archived: true }]);
    const updates = await fx.query<{ metadata: { automationIds?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.automationIds)).toEqual([
      [farewell.id, greeter.id],
      [greeter.id],
    ]);
    // A list given again is checked again, changing nothing when it is refused.
    await expectAppError(
      change({ automationIds: [greeter.id, draft.id] }),
      'validation_failed',
      /that have been published/,
    );
    expect((await current())?.map((a) => a.id)).toEqual([greeter.id]);
    await change({ automationIds: null });
    expect(await current()).toBeNull();
    await change({ automationIds: [farewell.id] });
    // Either event keeps the list.
    await change({ eventTypes: ['automation.run_ended'] });
    expect((await current())?.map((a) => a.id)).toEqual([farewell.id]);
    // The database refuses an empty list, more than 20 or a missing id from an endpoint taking the
    // events…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET automation_ids = ${value} WHERE id = $1`, [
        created.id,
      ]);
    const many = `ARRAY[${Array.from({ length: 21 }, () => `'${uuidv7()}'`).join(',')}]::uuid[]`;
    for (const bad of [`'{}'`, many, `ARRAY['${farewell.id}', NULL]::uuid[]`]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_automation_ids/);
    }
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['consent.changed'], automationIds: [farewell.id] }),
      'validation_failed',
      /only for an endpoint that receives Automation started or Automation ended/,
    );
    // …and any list for an endpoint that takes neither.
    await expect(setInDatabase(`ARRAY['${farewell.id}']::uuid[]`)).rejects.toThrow(
      /webhook_endpoints_automation_ids/,
    );
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'automation_ids', 'UPDATE')
                AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });

  it('offer the company’s published automations by name, archived ones included, to developers only', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const zebra = await automation(owner, 'Zebra follow-up');
    const alpha = await automation(owner, 'Alpha welcome');
    const paused = await automation(owner, 'Order reminder');
    await tested(c, owner, await automation(owner, 'Never published', true));
    await automationService().archiveAutomation(owner, {
      id: zebra.id,
      expectedVersion: zebra.version,
    });
    await automationService().setAutomationStatus(owner, {
      id: paused.id,
      expectedVersion: paused.version,
      status: 'paused',
    });
    const d = await fx.company();
    await automation(await fx.ctx(d, d.owner), 'Alpha elsewhere');
    expect(await webhooks().automationChoices(owner)).toEqual([
      { id: alpha.id, name: 'Alpha welcome', status: 'active' },
      { id: paused.id, name: 'Order reminder', status: 'paused' },
      { id: zebra.id, name: 'Zebra follow-up', status: 'archived' },
    ]);
    for (const user of [c.agent, c.marketer]) {
      await expectAppError(webhooks().automationChoices(await fx.ctx(c, user)), 'forbidden');
    }
  });
});

describe('number filters (ADR-170)', () => {
  it('are refused without an event that happens on a number, empty, over 100 or naming a number of another company; kept by a change that leaves them out and cleared with the events; the database keeps them to those events', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const main = c.channelAccountId;
    const outlet = (await fx.addNumber(c, { phone: '+91 90000 54321', name: 'Outlet' }))
      .channelAccountId;
    const closed = (await fx.addNumber(c, { phone: '+91 90000 11111', status: 'disconnected' }))
      .channelAccountId;
    const elsewhere = (await fx.company()).channelAccountId;
    const url = 'https://hooks.example.com/in';
    const refused = async (
      eventTypes: string[],
      channelIds: unknown,
      message: RegExp,
      path = 'channelIds',
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, channelIds }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(channelIds)).toBe(path);
    };
    const needsTheEvents =
      /only for an endpoint that receives message, conversation, automation, order or campaign events/;
    await refused(
      ['consent.changed', 'contact.updated', 'template.status_changed'],
      [main],
      needsTheEvents,
    );
    await refused(['message.received'], [], /at least one number/);
    await refused(['message.received'], ['outlet'], /from the list/, 'channelIds.0');
    await refused(
      ['message.received'],
      Array.from({ length: 101 }, () => uuidv7()),
      /at most 100 numbers/,
    );
    // Only the company's numbers: not another company's or an unknown id.
    await refused(['order.received'], [main, elsewhere], /of this company/, 'channelIds.1');
    await refused(['campaign.status_changed'], [uuidv7()], /of this company/, 'channelIds.0');
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['message.received', 'consent.changed'],
      channelIds: [outlet, main.toUpperCase(), outlet],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ channelIds: [outlet, main] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['message.received', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.channels;
    expect(await current()).toEqual([
      { id: outlet, label: '+91 90000 54321 · Outlet', status: 'active' },
      { id: main, label: '+91 90000 00000', status: 'active' },
    ]);
    await change({ description: 'kept' });
    expect((await current())?.map((n) => n.id)).toEqual([outlet, main]);
    // A disconnected number can be chosen, and is named with its status.
    await change({ channelIds: [closed] });
    expect(await current()).toEqual([
      { id: closed, label: '+91 90000 11111', status: 'disconnected' },
    ]);
    const updates = await fx.query<{ metadata: { channelIds?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.channelIds)).toEqual([[outlet, main], [closed]]);
    // A list given again is checked again, changing nothing when it is refused.
    await expectAppError(
      change({ channelIds: [main, elsewhere] }),
      'validation_failed',
      /of this company/,
    );
    expect((await current())?.map((n) => n.id)).toEqual([closed]);
    await change({ channelIds: null });
    expect(await current()).toBeNull();
    await change({ channelIds: [main] });
    // Any event that happens on a number keeps the list.
    await change({ eventTypes: ['campaign.status_changed', 'contact.created'] });
    expect((await current())?.map((n) => n.id)).toEqual([main]);
    // The database refuses an empty list, more than 100 or a missing id from an endpoint taking
    // such an event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET channel_account_ids = ${value} WHERE id = $1`, [
        created.id,
      ]);
    const many = `ARRAY[${Array.from({ length: 101 }, () => `'${uuidv7()}'`).join(',')}]::uuid[]`;
    for (const bad of [`'{}'`, many, `ARRAY['${main}', NULL]::uuid[]`]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(
        /webhook_endpoints_channel_account_ids/,
      );
    }
    await change({ eventTypes: ['contact.created', 'consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['contact.created'], channelIds: [main] }),
      'validation_failed',
      needsTheEvents,
    );
    // …and any list for an endpoint that takes none.
    await expect(setInDatabase(`ARRAY['${main}']::uuid[]`)).rejects.toThrow(
      /webhook_endpoints_channel_account_ids/,
    );
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'channel_account_ids',
                'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });

  it('offer every number of the company in the order they were connected, whatever their status, to developers only', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const outlet = await fx.addNumber(c, { phone: '+91 90000 54321', name: 'Outlet' });
    const pending = await fx.addNumber(c, { phone: null, status: 'onboarding' });
    const d = await fx.company();
    await fx.addNumber(d, { phone: '+91 90000 99999' });
    expect(await webhooks().channelChoices(owner)).toEqual([
      { id: c.channelAccountId, label: '+91 90000 00000', status: 'active' },
      { id: outlet.channelAccountId, label: '+91 90000 54321 · Outlet', status: 'active' },
      {
        id: pending.channelAccountId,
        label: `Phone number ID ${pending.phoneNumberId}`,
        status: 'onboarding',
      },
    ]);
    for (const user of [c.agent, c.marketer]) {
      await expectAppError(webhooks().channelChoices(await fx.ctx(c, user)), 'forbidden');
    }
  });

  it('send an endpoint that names numbers only the message events on them, another every number’s, events of no number to both, and capture none nobody takes', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const outlet = await fx.addNumber(c, { phone: '+91 90000 54321', name: 'Outlet' });
    const add = async (eventTypes: WebhookEventType[], channelIds: string[] | null) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes,
        channelIds,
      });
      return { ...created, path };
    };
    // The outlet's messages and their statuses, and every consent change.
    const outletOnly = await add(
      ['message.received', 'message.status', 'consent.changed'],
      [outlet.channelAccountId],
    );
    const from = waId();
    // A message to the first number: no endpoint takes it, so nothing is captured.
    const main = await inbound(c, from, 'Hello main');
    expect(await eventsOf(c)).toEqual([]);
    // A message to the outlet is captured for it, stored as events always were.
    const shop = await inbound(outlet, from, 'Hello outlet');
    expect((await eventsOf(c)).map((e) => [e.type, e.detail])).toEqual([
      ['message.received', { messageType: 'text' }],
    ]);
    // A reply from the outlet is captured when WhatsApp accepts it; one from the first number is
    // not.
    await sendReply(c, main.conversation_id, 'Reply from main');
    await sendReply(c, shop.conversation_id, 'Reply from the outlet');
    expect((await eventsOf(c)).map((e) => [e.type, e.status, e.detail])).toEqual([
      ['message.received', null, { messageType: 'text' }],
      ['message.status', 'accepted', {}],
    ]);
    // A consent change happens on no number: the endpoint takes it.
    await createConsentService({ db: fx.dbs.app, clock: systemClock }).recordConsent(owner, {
      contactId: main.contact_id,
      purpose: 'marketing',
      action: 'opt_in',
    });
    // An endpoint for every number's messages hears both numbers.
    const everyNumber = await add(['message.received'], null);
    await inbound(c, from, 'Main again');
    await inbound(outlet, from, 'Outlet again');
    const typesTo = async (endpointId: string) =>
      (await deliveriesOf(endpointId)).map((d) => [d.type, d.status]);
    expect(await typesTo(outletOnly.id)).toEqual([
      ['message.received', null],
      ['message.status', 'accepted'],
      ['consent.changed', null],
      ['message.received', null],
    ]);
    expect(await typesTo(everyNumber.id)).toEqual([
      ['message.received', null],
      ['message.received', null],
    ]);
    // Each delivery names the number its event happened on.
    expect(await deliverDue(c)).toMatchObject({ attempted: 6, succeeded: 6 });
    const numbersAt = (path: string) =>
      requestsTo(path)
        .map((r) => JSON.parse(r.body) as { type: string; data: { channel?: { id: string } } })
        .filter((b) => b.data.channel)
        .map((b) => [b.type, b.data.channel?.id])
        .sort();
    expect(numbersAt(outletOnly.path)).toEqual([
      ['message.received', outlet.channelAccountId],
      ['message.received', outlet.channelAccountId],
      ['message.status', outlet.channelAccountId],
    ]);
    expect(numbersAt(everyNumber.path)).toEqual(
      [
        ['message.received', c.channelAccountId],
        ['message.received', outlet.channelAccountId],
      ].sort(),
    );
  });
});

describe('event capture', () => {
  it('records an event only for subscribed types, with one delivery per active subscribed endpoint, and none from a rolled-back change', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const from = waId();
    // No endpoint yet: nothing is recorded.
    const first = await inbound(c, from, 'Hello before any endpoint');
    expect(await eventsOf(c)).toHaveLength(0);

    const e1 = await addEndpoint(c, 'ok', ['message.received']);
    const e2 = await addEndpoint(c, 'ok', ['message.received', 'consent.changed']);
    const e3 = await addEndpoint(c, 'ok', ['consent.changed']);
    await webhooks().setEnabled(owner, { endpointId: e3.id, enabled: false });

    const second = await inbound(c, from, 'Is my order ready?');
    let events = await eventsOf(c);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'message.received', status: null });
    expect(events[0]?.detail).toEqual({ messageType: 'text' });
    expect((await deliveriesOf(e1.id)).map((d) => d.event_id)).toEqual([events[0]?.id]);
    expect((await deliveriesOf(e2.id)).map((d) => d.event_id)).toEqual([events[0]?.id]);
    expect(await deliveriesOf(e3.id)).toHaveLength(0);

    await createConsentService({ db: fx.dbs.app, clock: systemClock }).recordConsent(owner, {
      contactId: second.contact_id,
      purpose: 'marketing',
      action: 'opt_in',
    });
    events = await eventsOf(c);
    expect(events.map((e) => e.type)).toEqual(['message.received', 'consent.changed']);
    expect(events[1]?.detail).toEqual({ purpose: 'marketing', action: 'opt_in', source: 'agent' });
    expect(await deliveriesOf(e1.id)).toHaveLength(1);
    expect(await deliveriesOf(e2.id)).toHaveLength(2);
    expect(await deliveriesOf(e3.id)).toHaveLength(0);

    // A change that rolls back leaves no event and no delivery.
    await expect(
      fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), async (tx) => {
        await tx.insert(consentEvents).values({
          id: uuidv7(),
          tenantId: c.tenant.id,
          contactId: first.contact_id,
          purpose: 'utility',
          action: 'opt_out',
          source: 'agent',
          actorType: 'user',
          actorId: c.owner.id,
          occurredAt: new Date(),
        });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await eventsOf(c)).toHaveLength(2);
    expect(await deliveriesOf(e2.id)).toHaveLength(2);
  });
});

describe('delivery', () => {
  it('posts message.received saying what was left out of a message too large to keep and of a contact card (ADR-132)', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['message.received']);
    const from = waId();
    const wide = '𝒳'.repeat(2048); // 4,096 code units, 8 KB as UTF-8
    const system = Object.fromEntries(
      [
        'type',
        'body',
        'user_id',
        'parent_user_id',
        'previous_user_id',
        'previous_parent_user_id',
        'wa_id',
        'new_wa_id',
      ].map((key) => [key, wide]),
    );
    const card = Array.from({ length: 25 }, (_, i) => ({
      name: { formatted_name: `Contact ${i}` },
      addresses: [{ street: 'x'.repeat(4_000), city: 'Pune' }],
    }));
    await fx.deliver(
      fx.messagesBody(c, {
        messages: [
          { waId: from, type: 'system', extra: { system } },
          { waId: from, type: 'contacts', extra: { contacts: card } },
        ],
      }),
    );
    const [stored] = await fx.query<{ omitted: number }>(
      `SELECT (content->>'omittedContacts')::int AS omitted FROM app.messages
        WHERE tenant_id = $1 AND type = 'contacts'`,
      [c.tenant.id],
    );
    expect(stored!.omitted).toBeGreaterThan(0);
    expect(await deliverDue(c)).toMatchObject({ attempted: 2, succeeded: 2 });
    const messages = requestsTo(e.path).map(
      (r) => messageReceivedPayloadSchema.parse(JSON.parse(r.body)).data.message,
    );
    expect(
      messages.map((m) => [m.type, m.text, m.contentTooLarge, m.contactsLeftOut]).sort(),
    ).toEqual(
      [
        ['contacts', null, false, stored!.omitted],
        ['system', null, true, 0],
      ].sort(),
    );
  });

  it('posts message.received signed, with the contact and the text, once', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['message.received']);
    const from = waId();
    const msg = await inbound(c, from, 'Where is my order?');
    const run = await deliverDue(c);
    expect(run).toMatchObject({ attempted: 1, succeeded: 1, retrying: 0, failed: 0 });

    const [request] = requestsTo(e.path);
    expect(requestsTo(e.path)).toHaveLength(1);
    const [delivery] = await deliveriesOf(e.id);
    expect(request?.headers).toMatchObject({
      'content-type': 'application/json',
      'user-agent': 'HyFib-W360-Webhooks/1',
      'w360-event-type': 'message.received',
      'w360-event-id': delivery?.event_id,
      'w360-delivery-id': delivery?.id,
      'w360-delivery-attempt': '1',
    });
    expect(signedWith(request!, e.secret)).toBe(true);
    expect(signedWith(request!, 'whsec_wrong')).toBe(false);
    const body = messageReceivedPayloadSchema.parse(JSON.parse(request!.body));
    expect(body).toMatchObject({
      id: delivery?.event_id,
      type: 'message.received',
      data: {
        message: { id: msg.id, type: 'text', text: 'Where is my order?', reply: null },
        conversation: { id: msg.conversation_id },
        contact: { id: msg.contact_id, phone: `+${from}`, name: 'Priya Customer' },
        channel: { id: c.channelAccountId, phone: '+91 90000 00000' },
      },
    });
    expect(delivery).toMatchObject({
      state: 'succeeded',
      attempts: 1,
      last_status_code: 204,
      last_error: null,
      lease_until: null,
    });
    expect(delivery?.delivered_at).toBeInstanceOf(Date);
    const endpoint = await endpointRow(e.id);
    expect(endpoint.last_success_at).toBeInstanceOf(Date);
    expect(endpoint.failing_since).toBeNull();

    // Nothing is due any more: another run sends nothing.
    expect(await deliverDue(c)).toMatchObject({ attempted: 0, failed: 0 });
    expect(requestsTo(e.path)).toHaveLength(1);
  });

  it('posts message.status for each status a receiver can act on, with the error of a failure', async () => {
    const c = await fx.company();
    const from = waId();
    const msg = await inbound(c, from, 'Hi');
    const e = await addEndpoint(c, 'ok', ['message.status']);
    const sent = await sendReply(c, msg.conversation_id, 'It ships today.');
    const t = Math.floor(Date.now() / 1000);
    await fx.deliver(
      fx.messagesBody(c, {
        statuses: [
          { id: sent.wamid, status: 'delivered', timestamp: String(t + 2), recipient_id: from },
        ],
      }),
    );
    const failed = await sendReply(c, msg.conversation_id, 'And a second note.');
    await fx.deliver(
      fx.messagesBody(c, {
        statuses: [
          {
            id: failed.wamid,
            status: 'failed',
            timestamp: String(t + 3),
            recipient_id: from,
            errors: [{ code: 131026, title: 'Message undeliverable' }],
          },
        ],
      }),
    );
    // queued and sending are internal: only accepted, delivered and failed are events.
    const events = await eventsOf(c);
    expect(events.map((ev) => ev.status).sort()).toEqual([
      'accepted',
      'accepted',
      'delivered',
      'failed',
    ]);

    expect(await deliverDue(c)).toMatchObject({ attempted: 4, succeeded: 4 });
    const bodies = requestsTo(e.path).map((r) =>
      messageStatusPayloadSchema.parse(JSON.parse(r.body)),
    );
    expect(bodies).toHaveLength(4);
    const firstDelivered = bodies.find((b) => b.data.message.status === 'delivered');
    expect(firstDelivered?.data).toMatchObject({
      message: {
        id: sent.messageId,
        templateId: null,
        templateName: null,
        sentBy: 'agent',
        apiKeyId: null,
      },
      error: null,
      conversation: { id: msg.conversation_id },
      contact: { id: msg.contact_id, phone: `+${from}` },
      channel: { id: c.channelAccountId },
    });
    expect(bodies.find((b) => b.data.message.status === 'failed')?.data).toMatchObject({
      message: { id: failed.messageId },
      error: { code: '131026', title: 'Message undeliverable' },
    });
  });

  it('posts template.status_changed for statuses Meta reports', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['template.status_changed']);
    const owner = await fx.ctx(c, c.owner);
    templateCounter += 1;
    const name = `wh_tpl_${templateCounter}_${Date.now().toString(36)}`;
    const templateDeps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock };
    const templates = createTemplatesService(templateDeps);
    const { id } = await templates.createDraft(owner, {
      whatsappAccountId: c.whatsappAccountId,
      name,
      language: 'en',
      definition: {
        category: 'UTILITY',
        header: { type: 'none' },
        body: { text: 'Your order {{1}} has shipped.', examples: ['A-1'] },
        footer: null,
        buttons: [],
      },
    });
    await templates.submitTemplate(owner, id);
    const graphDeps = { ...templateDeps, keyring: fx.keyring, graph: fx.graph };
    const scope = authorizedTenantScope(c.tenant.id, null);
    expect(await processTemplateSubmit(graphDeps, scope, id)).toBe('done');
    const atMeta = fx.standIn.state.templates.get(c.wabaId)?.find((x) => x.name === name);
    if (!atMeta) throw new Error('template not at the stand-in');
    atMeta.status = 'APPROVED';
    await syncTemplates(graphDeps, scope, c.whatsappAccountId);

    await deliverDue(c);
    const bodies = requestsTo(e.path).map((r) =>
      templateStatusPayloadSchema.parse(JSON.parse(r.body)),
    );
    // HyFib's own submission steps are not events; Meta's pending and approved are.
    expect(bodies.map((b) => b.data.template.status).sort()).toEqual(['approved', 'pending']);
    expect(bodies.find((b) => b.data.template.status === 'approved')?.data.template).toEqual({
      id,
      name,
      language: 'en',
      category: 'utility',
      status: 'approved',
      reason: null,
    });
  });

  it('builds payloads when delivered: an erased contact is sent without their number, name or text', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const e = await addEndpoint(c, 'ok', ['message.received', 'consent.changed']);
    const from = waId();
    const msg = await inbound(c, from, 'Please delete my data');
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: msg.contact_id,
      suppress: false,
    });
    // Erasure ends consent with opt-outs, recorded by the definer function: events too.
    const events = await eventsOf(c);
    expect(
      events.filter((ev) => ev.type === 'consent.changed').map((ev) => ev.detail.source),
    ).toEqual(expect.arrayContaining(['erasure']));
    await deliverDue(c);
    const requests = requestsTo(e.path);
    expect(requests.length).toBe(events.length);
    for (const request of requests) {
      const body = JSON.parse(request.body) as { type: string; data: { contact: unknown } };
      expect(body.data.contact).toEqual({ id: msg.contact_id, phone: null, name: null });
      expect(request.body).not.toContain(from);
      expect(request.body).not.toContain('Priya');
      if (body.type === 'message.received') {
        expect(messageReceivedPayloadSchema.parse(body).data.message.text).toBeNull();
      } else {
        expect(consentChangedPayloadSchema.parse(body).data).toMatchObject({
          action: 'opt_out',
          source: 'erasure',
        });
      }
    }
  });

  it('fails a delivery whose message no longer exists, without an attempt', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['message.status']);
    const eventId = uuidv7();
    await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, null), async (tx) => {
      await tx.insert(webhookEvents).values({
        id: eventId,
        tenantId: c.tenant.id,
        type: 'message.status',
        messageId: uuidv7(),
        conversationId: uuidv7(),
        status: 'delivered',
        detail: {},
      });
      await tx.insert(webhookDeliveries).values({
        id: uuidv7(),
        tenantId: c.tenant.id,
        endpointId: e.id,
        eventId,
      });
    });
    expect(await deliverDue(c)).toMatchObject({ attempted: 0, failed: 1 });
    expect(await deliveriesOf(e.id)).toMatchObject([
      { state: 'failed', attempts: 0, last_error: 'event_gone' },
    ]);
    expect(requestsTo(e.path)).toHaveLength(0);
  });
});

describe('retries', () => {
  it('retries a failing endpoint at 1 min, 5 min, 30 min, 2 h, 6 h, 12 h and 24 h, then fails the delivery', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'fail', ['consent.changed']);
    const { deliveryId } = await webhooks().sendTest(e.owner, { endpointId: e.id });
    let now = new Date(Date.now() + 1_000);
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const run = await deliverDue(c, at(now));
      expect(run.attempted).toBe(1);
      const [row] = await deliveriesOf(e.id);
      expect(row).toMatchObject({ id: deliveryId, attempts: attempt, last_status_code: 500 });
      expect(row?.last_attempt_at?.getTime()).toBe(now.getTime());
      // Not due before its time.
      expect((await deliverDue(c, at(new Date(now.getTime() + 1_000)))).attempted).toBe(0);
      if (attempt < 8) {
        expect(row?.state).toBe('pending');
        waits.push((row!.next_attempt_at.getTime() - now.getTime()) / 1000);
        now = row!.next_attempt_at;
      } else {
        expect(row?.state).toBe('failed');
        expect(run.failed).toBe(1);
      }
    }
    expect(waits).toEqual([60, 300, 1_800, 7_200, 21_600, 43_200, 86_400]);
    const requests = requestsTo(e.path);
    expect(requests.map((r) => r.headers['w360-delivery-attempt'])).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
    ]);
    // One event, one delivery id and one event id across attempts.
    expect(new Set(requests.map((r) => r.headers['w360-event-id'])).size).toBe(1);
    expect(new Set(requests.map((r) => r.headers['w360-delivery-id']))).toEqual(
      new Set([deliveryId]),
    );
    expect(pingPayloadSchema.parse(JSON.parse(requests[0]!.body)).data.endpointId).toBe(e.id);
    // About 45 hours of failures: under the 72 hours that turn an endpoint off.
    const endpoint = await endpointRow(e.id);
    expect(endpoint.state).toBe('active');
    expect(endpoint.failing_since).toBeInstanceOf(Date);
  });

  it('uses an edited URL for the next attempt, and a success clears the failing state', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'fail', ['consent.changed']);
    const { deliveryId } = await webhooks().sendTest(e.owner, { endpointId: e.id });
    await deliverDue(c);
    expect((await endpointRow(e.id)).failing_since).toBeInstanceOf(Date);
    const fixed = `/ok/${randomBytes(6).toString('hex')}`;
    await webhooks().update(e.owner, {
      endpointId: e.id,
      url: `http://${HOST}:${port}${fixed}`,
      description: '',
      eventTypes: ['consent.changed'],
    });
    expect(await deliverDue(c, later(61_000))).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(requestsTo(fixed).map((r) => r.headers['w360-delivery-attempt'])).toEqual(['2']);
    expect(await deliveriesOf(e.id)).toMatchObject([{ id: deliveryId, state: 'succeeded' }]);
    const endpoint = await endpointRow(e.id);
    expect(endpoint.failing_since).toBeNull();
    expect(endpoint.last_success_at).toBeInstanceOf(Date);
    expect(endpoint.last_failure_at).toBeInstanceOf(Date);
  });

  it('counts timeouts and redirects as failed attempts and never follows a redirect', async () => {
    const c = await fx.company();
    const hang = await addEndpoint(c, 'hang', ['consent.changed']);
    const redirect = await addEndpoint(c, 'redirect', ['consent.changed']);
    await webhooks().sendTest(hang.owner, { endpointId: hang.id });
    await webhooks().sendTest(redirect.owner, { endpointId: redirect.id });
    expect(await deliverDue(c)).toMatchObject({ attempted: 2, retrying: 2 });
    expect(await deliveriesOf(hang.id)).toMatchObject([
      { state: 'pending', attempts: 1, last_status_code: null, last_error: 'timeout' },
    ]);
    expect(await deliveriesOf(redirect.id)).toMatchObject([
      { state: 'pending', attempts: 1, last_status_code: 302, last_error: null },
    ]);
    expect(requestsTo(`/ok${redirect.path}`)).toHaveLength(0);
  });

  it('attempts again a delivery whose worker was lost, and fails one with no attempt left', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['consent.changed']);
    const first = await webhooks().sendTest(e.owner, { endpointId: e.id });
    const second = await webhooks().sendTest(e.owner, { endpointId: e.id });
    // Both were claimed by a worker that died during the request: leases expired.
    await fx.query(
      `UPDATE app.webhook_deliveries SET state = 'delivering', attempts = 1,
              lease_until = now() - interval '1 second', last_attempt_at = now() - interval '1 minute'
        WHERE id = $1`,
      [first.deliveryId],
    );
    await fx.query(
      `UPDATE app.webhook_deliveries SET state = 'delivering', attempts = 8,
              lease_until = now() - interval '1 second' WHERE id = $1`,
      [second.deliveryId],
    );
    // A lease still running is left alone.
    const third = await webhooks().sendTest(e.owner, { endpointId: e.id });
    await fx.query(
      `UPDATE app.webhook_deliveries SET state = 'delivering', attempts = 1,
              lease_until = now() + interval '1 minute' WHERE id = $1`,
      [third.deliveryId],
    );
    expect(await deliverDue(c)).toMatchObject({ attempted: 1, succeeded: 1, failed: 1 });
    const rows = new Map((await deliveriesOf(e.id)).map((d) => [d.id, d]));
    expect(rows.get(first.deliveryId)).toMatchObject({ state: 'succeeded', attempts: 2 });
    expect(rows.get(second.deliveryId)).toMatchObject({
      state: 'failed',
      attempts: 8,
      last_error: 'interrupted',
      lease_until: null,
    });
    expect(rows.get(third.deliveryId)).toMatchObject({ state: 'delivering', attempts: 1 });
    expect(requestsTo(e.path).map((r) => r.headers['w360-delivery-attempt'])).toEqual(['2']);
  });
});

describe('outcomes that lost their delivery', () => {
  it('are dropped when a newer attempt owns the delivery or the endpoint was deleted', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['consent.changed']);
    const { deliveryId } = await webhooks().sendTest(e.owner, { endpointId: e.id });
    // While this attempt is in flight its lease expires and another worker claims attempt 2.
    const reclaimed = egressDuring(() =>
      fx.query(
        `UPDATE app.webhook_deliveries SET attempts = 2, lease_until = now() + interval '1 minute'
          WHERE id = $1`,
        [deliveryId],
      ),
    );
    expect(await deliverDue(c, systemClock, reclaimed)).toMatchObject({
      attempted: 1,
      succeeded: 0,
      retrying: 0,
      failed: 0,
    });
    expect(await deliveriesOf(e.id)).toMatchObject([
      { id: deliveryId, state: 'delivering', attempts: 2, last_status_code: null },
    ]);
    expect((await endpointRow(e.id)).last_failure_at).toBeNull();

    // The endpoint (and with it the delivery) is deleted during the request.
    const other = await addEndpoint(c, 'ok', ['consent.changed']);
    await webhooks().sendTest(other.owner, { endpointId: other.id });
    const deleted = egressDuring(() => webhooks().remove(other.owner, { endpointId: other.id }));
    expect(await deliverDue(c, systemClock, deleted)).toMatchObject({ attempted: 1, failed: 0 });
    expect(await deliveriesOf(other.id)).toHaveLength(0);
  });

  it('a failure after the endpoint was turned off ends the delivery instead of retrying it', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['consent.changed']);
    const { deliveryId } = await webhooks().sendTest(e.owner, { endpointId: e.id });
    const turnedOff = egressDuring(() =>
      webhooks().setEnabled(e.owner, { endpointId: e.id, enabled: false }),
    );
    expect(await deliverDue(c, systemClock, turnedOff)).toMatchObject({ attempted: 1, failed: 1 });
    expect(await deliveriesOf(e.id)).toMatchObject([
      { id: deliveryId, state: 'failed', attempts: 1, last_status_code: 500 },
    ]);
  });

  it('deliveries that end without an attempt do not hold up the others', async () => {
    const c = await fx.company();
    const off = await addEndpoint(c, 'ok', ['consent.changed']);
    const on = await addEndpoint(c, 'ok', ['consent.changed']);
    await webhooks().setEnabled(off.owner, { endpointId: off.id, enabled: false });
    // More than a batch of deliveries for the turned-off endpoint, due before the live one.
    const early = new Date(Date.now() - 60_000);
    for (let i = 0; i < 12; i += 1) await captureDirectly(c, off.id, early);
    const live = await webhooks().sendTest(on.owner, { endpointId: on.id });
    expect(await deliverDue(c)).toMatchObject({ attempted: 1, succeeded: 1, failed: 12 });
    expect(await deliveriesOf(on.id)).toMatchObject([{ id: live.deliveryId, state: 'succeeded' }]);
  });
});

describe('deliveries that cannot be prepared', () => {
  /** A consent.changed event and its delivery written straight to the tables, due a minute ago. */
  async function consentEventDirectly(c: Company, endpointId: string, source: string) {
    const eventId = uuidv7();
    const deliveryId = uuidv7();
    await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, null), async (tx) => {
      await tx.insert(webhookEvents).values({
        id: eventId,
        tenantId: c.tenant.id,
        type: 'consent.changed',
        contactId: uuidv7(),
        detail: { purpose: 'marketing', action: 'opt_out', source },
      });
      await tx.insert(webhookDeliveries).values({
        id: deliveryId,
        tenantId: c.tenant.id,
        endpointId,
        eventId,
        nextAttemptAt: new Date(Date.now() - 60_000),
      });
    });
    return { eventId, deliveryId };
  }

  /** A delivery job's logger that keeps what it is given. */
  function capturedLog() {
    const lines: { fields: Record<string, unknown>; message: string }[] = [];
    const logger: WebhookDeliveryLogger = {
      error: (fields, message) => void lines.push({ fields, message }),
    };
    return { lines, logger };
  }

  it('fail alone without an attempt: the batch is delivered, later runs go on, a replay sends it once fixed, and the log quotes nothing', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['consent.changed']);
    // First in the batch: an event whose time has no ISO form, standing in for any row the builder
    // cannot handle. Its payload would carry `source`.
    const content = 'Priya Sharma +919812345678';
    const bad = await consentEventDirectly(c, e.id, content);
    await fx.query(`UPDATE app.webhook_events SET occurred_at = 'infinity' WHERE id = $1`, [
      bad.eventId,
    ]);
    const good = await webhooks().sendTest(e.owner, { endpointId: e.id });

    const log = capturedLog();
    expect(await deliverDue(c, systemClock, egress(), log.logger)).toMatchObject({
      attempted: 1,
      succeeded: 1,
      retrying: 0,
      failed: 1,
    });
    const rows = new Map((await deliveriesOf(e.id)).map((d) => [d.id, d]));
    expect(rows.get(bad.deliveryId)).toMatchObject({
      state: 'failed',
      attempts: 0,
      last_attempt_at: null,
      lease_until: null,
      last_error: 'payload_failed',
    });
    expect(rows.get(good.deliveryId)).toMatchObject({ state: 'succeeded', attempts: 1 });
    const requests = requestsTo(e.path);
    expect(requests.map((r) => r.headers['w360-delivery-id'])).toEqual([good.deliveryId]);
    expect(signedWith(requests[0]!, e.secret)).toBe(true);
    // One line with ids and the error's class: not the payload, the event or the error's message.
    expect(log.lines).toEqual([
      {
        message: 'webhook delivery could not be prepared; failed as payload_failed',
        fields: {
          tenantId: c.tenant.id,
          deliveryId: bad.deliveryId,
          endpointId: e.id,
          eventType: 'consent.changed',
          stage: 'payload',
          errorClass: 'RangeError',
          errorCode: null,
        },
      },
    ]);
    expect(JSON.stringify(log.lines)).not.toMatch(/Priya|9812345678|opt_out|Invalid time value/);
    expect((await endpointRow(e.id)).last_failure_at).toBeNull();

    // Nothing is due, so the sweep does not wake the company for it; a later run delivers new
    // events and leaves it alone (`failOnLog` throws at a delivery that cannot be prepared).
    expect(await findWebhookDispatchDue(fx.dbs.app, 10_000)).not.toContain(c.tenant.id);
    const next = await webhooks().sendTest(e.owner, { endpointId: e.id });
    expect(await deliverDue(c, later(86_400_000))).toMatchObject({
      attempted: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(requestsTo(e.path).map((r) => r.headers['w360-delivery-id'])).toEqual([
      good.deliveryId,
      next.deliveryId,
    ]);

    // Once the cause is fixed, replaying failed deliveries sends it (unlike `event_gone`).
    await fx.query('UPDATE app.webhook_events SET occurred_at = now() WHERE id = $1', [
      bad.eventId,
    ]);
    expect(await webhooks().replayFailed(e.owner, { endpointId: e.id, period: '1h' })).toEqual({
      queued: 1,
      more: false,
    });
    expect(await deliverDue(c)).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    const replayed = requestsTo(e.path).at(-1)!;
    expect(replayed.headers['w360-event-id']).toBe(bad.eventId);
    expect(consentChangedPayloadSchema.parse(JSON.parse(replayed.body)).data.source).toBe(content);
  });

  it('a secret the keyring cannot open fails each delivery to its endpoint alone', async () => {
    const c = await fx.company();
    const broken = await addEndpoint(c, 'ok', ['consent.changed']);
    const fine = await addEndpoint(c, 'ok', ['consent.changed']);
    // The secret's version no longer matches what its ciphertext is bound to (as after a botched
    // restore), so opening it fails authentication.
    await fx.query('UPDATE app.webhook_endpoints SET secret_version = 2 WHERE id = $1', [
      broken.id,
    ]);
    const first = await webhooks().sendTest(broken.owner, { endpointId: broken.id });
    const second = await webhooks().sendTest(broken.owner, { endpointId: broken.id });
    const ok = await webhooks().sendTest(fine.owner, { endpointId: fine.id });

    const log = capturedLog();
    expect(await deliverDue(c, systemClock, egress(), log.logger)).toMatchObject({
      attempted: 1,
      succeeded: 1,
      failed: 2,
    });
    expect(await deliveriesOf(broken.id)).toMatchObject([
      { id: first.deliveryId, state: 'failed', attempts: 0, last_error: 'payload_failed' },
      { id: second.deliveryId, state: 'failed', attempts: 0, last_error: 'payload_failed' },
    ]);
    expect(requestsTo(broken.path)).toHaveLength(0);
    expect(await deliveriesOf(fine.id)).toMatchObject([{ id: ok.deliveryId, state: 'succeeded' }]);
    expect(log.lines.map((line) => line.fields)).toEqual(
      [first, second].map((d) => ({
        tenantId: c.tenant.id,
        deliveryId: d.deliveryId,
        endpointId: broken.id,
        eventType: 'ping',
        stage: 'signature',
        errorClass: 'Error',
        errorCode: null,
      })),
    );
    expect(JSON.stringify(log.lines)).not.toMatch(/authenticate|whsec_/);
  });

  it('headers the keyring cannot open fail each delivery to their endpoint alone, until given again (ADR-118)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const add = async (value: string) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes: ['consent.changed'],
        headers: [{ name: 'Authorization', value }],
      });
      return { ...created, path };
    };
    const broken = await add('Bearer broken-value');
    const fine = await add('Bearer fine-value');
    const other = await add('Bearer other-value');
    // The broken endpoint holds the other endpoint's sealed headers (as after a botched restore):
    // bound to that endpoint, they do not open for this one.
    await fx.query(
      `UPDATE app.webhook_endpoints b SET headers_ciphertext = f.headers_ciphertext
         FROM app.webhook_endpoints f WHERE b.id = $1 AND f.id = $2`,
      [broken.id, fine.id],
    );
    const first = await webhooks().sendTest(owner, { endpointId: broken.id });
    const second = await webhooks().sendTest(owner, { endpointId: broken.id });
    await webhooks().sendTest(owner, { endpointId: fine.id });
    await webhooks().sendTest(owner, { endpointId: other.id });

    const log = capturedLog();
    expect(await deliverDue(c, systemClock, egress(), log.logger)).toMatchObject({
      attempted: 2,
      succeeded: 2,
      failed: 2,
    });
    expect(await deliveriesOf(broken.id)).toMatchObject([
      { id: first.deliveryId, state: 'failed', attempts: 0, last_error: 'payload_failed' },
      { id: second.deliveryId, state: 'failed', attempts: 0, last_error: 'payload_failed' },
    ]);
    expect(requestsTo(broken.path)).toHaveLength(0);
    // Each endpoint of the batch is sent its own headers.
    expect(requestsTo(fine.path).map((r) => r.headers.authorization)).toEqual([
      'Bearer fine-value',
    ]);
    expect(requestsTo(other.path).map((r) => r.headers.authorization)).toEqual([
      'Bearer other-value',
    ]);
    expect(log.lines.map((line) => line.fields)).toEqual(
      [first, second].map((d) => ({
        tenantId: c.tenant.id,
        deliveryId: d.deliveryId,
        endpointId: broken.id,
        eventType: 'ping',
        stage: 'headers',
        errorClass: 'Error',
        errorCode: null,
      })),
    );
    expect(JSON.stringify(log.lines)).not.toMatch(/authenticate|Bearer|broken-value|fine-value/);

    // Given again, the headers are sealed for this endpoint, and a replay delivers.
    await webhooks().update(owner, {
      endpointId: broken.id,
      url: `http://${HOST}:${port}${broken.path}`,
      description: '',
      eventTypes: ['consent.changed'],
      headers: [{ name: 'Authorization', value: 'Bearer given-again' }],
    });
    const replay = await webhooks().replay(owner, { deliveryId: first.deliveryId });
    expect(await deliverDue(c)).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(
      requestsTo(broken.path).map((r) => [r.headers['w360-delivery-id'], r.headers.authorization]),
    ).toEqual([[replay.deliveryId, 'Bearer given-again']]);
  });

  it('a database error while building fails only its delivery: the claim goes on after its savepoint', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['consent.changed']);
    const consent = await consentEventDirectly(c, e.id, 'agent');
    const ping = await webhooks().sendTest(e.owner, { endpointId: e.id });
    // The consent payload reads the contact. With contacts locked, that read waits past the lock
    // timeout (5 seconds) and fails inside the claim's transaction.
    const log = capturedLog();
    const holder = await fx.dbs.adminPool.connect();
    let run: unknown;
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE app.contacts IN ACCESS EXCLUSIVE MODE');
      run = await deliverDue(c, systemClock, egress(), log.logger);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(run).toMatchObject({ attempted: 1, succeeded: 1, failed: 1 });
    expect(await deliveriesOf(e.id)).toMatchObject([
      { id: consent.deliveryId, state: 'failed', attempts: 0, last_error: 'payload_failed' },
      { id: ping.deliveryId, state: 'succeeded', attempts: 1 },
    ]);
    // The class and the SQLSTATE (lock_not_available), not the failed query or its parameters.
    expect(log.lines.map((line) => line.fields)).toEqual([
      {
        tenantId: c.tenant.id,
        deliveryId: consent.deliveryId,
        endpointId: e.id,
        eventType: 'consent.changed',
        stage: 'payload',
        errorClass: 'DrizzleQueryError',
        errorCode: '55P03',
      },
    ]);
  });

  it('count toward the job budget, though not as attempts: a backlog of them hands over to a successor', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['consent.changed']);
    // 205 due test events that cannot be built: more than a job's 200 deliveries.
    await fx.query(
      `WITH events AS (
         INSERT INTO app.webhook_events (id, tenant_id, type, occurred_at)
         SELECT gen_random_uuid(), $1, 'ping', 'infinity' FROM generate_series(1, 205)
         RETURNING id)
       INSERT INTO app.webhook_deliveries (id, tenant_id, endpoint_id, event_id)
       SELECT gen_random_uuid(), $1, $2, id FROM events`,
      [c.tenant.id, e.id],
    );
    const log = capturedLog();
    expect(await deliverDue(c, systemClock, egress(), log.logger)).toEqual({
      attempted: 0,
      succeeded: 0,
      retrying: 0,
      failed: 200,
      handedOver: true,
    });
    expect(log.lines).toHaveLength(200);
    const successors = await fx.query<{ data: { kind: string; tenantId: string } }>(
      `SELECT data FROM pgboss.job WHERE name = 'webhook.deliver' AND singleton_key = $1`,
      [c.tenant.id],
    );
    expect(successors.map((job) => job.data)).toMatchObject([
      { kind: 'webhook.deliver', tenantId: c.tenant.id },
    ]);
    // The successor's run ends the rest.
    expect(await deliverDue(c, systemClock, egress(), log.logger)).toEqual({
      attempted: 0,
      succeeded: 0,
      retrying: 0,
      failed: 5,
      handedOver: false,
    });
    expect(await findWebhookDispatchDue(fx.dbs.app, 10_000)).not.toContain(c.tenant.id);
  });
});

describe('endpoint health', () => {
  it('turns off an endpoint failing for 72 hours, fails its waiting deliveries and emails owners and administrators', async () => {
    const c = await fx.company();
    const admin = await createUser(fx.dbs, { name: 'Admin' });
    const { token } = await invite(fx.dbs, c.tenant, c.owner, admin.email, ['admin']);
    await acceptInvitation(fx.dbs, admin, token);
    const e = await addEndpoint(c, 'fail', ['consent.changed']);
    const due = await webhooks().sendTest(e.owner, { endpointId: e.id });
    const waiting = await webhooks().sendTest(e.owner, { endpointId: e.id });
    await fx.query(
      `UPDATE app.webhook_deliveries SET next_attempt_at = now() + interval '1 hour' WHERE id = $1`,
      [waiting.deliveryId],
    );
    await fx.query(
      `UPDATE app.webhook_endpoints SET failing_since = now() - interval '73 hours' WHERE id = $1`,
      [e.id],
    );
    expect(await deliverDue(c)).toMatchObject({ attempted: 1, failed: 1 });
    const endpoint = await endpointRow(e.id);
    expect(endpoint).toMatchObject({ state: 'disabled', disabled_reason: 'failing' });
    expect(endpoint.disabled_at).toBeInstanceOf(Date);
    const rows = new Map((await deliveriesOf(e.id)).map((d) => [d.id, d]));
    expect(rows.get(due.deliveryId)).toMatchObject({
      state: 'failed',
      attempts: 1,
      last_status_code: 500,
    });
    expect(rows.get(waiting.deliveryId)).toMatchObject({
      state: 'failed',
      attempts: 0,
      last_error: 'endpoint_disabled',
      last_attempt_at: null,
    });
    const emails = await fx.query<{ to_address: string; kind: string }>(
      `SELECT to_address, kind FROM ops.email_outbox WHERE tenant_id = $1 AND kind = 'webhook.endpoint_disabled'`,
      [c.tenant.id],
    );
    expect(emails.map((m) => m.to_address).sort()).toEqual([admin.email, c.owner.email].sort());
    const [audit] = await fx.query<{ actor_type: string; metadata: Record<string, unknown> }>(
      `SELECT actor_type, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_auto_disabled'`,
      [c.tenant.id],
    );
    expect(audit).toMatchObject({
      actor_type: 'system',
      metadata: { host: HOST, pendingDeliveriesFailed: 1 },
    });

    // Turned off: nothing more is sent or captured for it; turning it on starts health afresh.
    expect(await deliverDue(c, later(2 * 3_600_000))).toMatchObject({ attempted: 0 });
    await expectAppError(webhooks().sendTest(e.owner, { endpointId: e.id }), 'precondition_failed');
    await webhooks().setEnabled(e.owner, { endpointId: e.id, enabled: true });
    expect(await endpointRow(e.id)).toMatchObject({
      state: 'active',
      failing_since: null,
      disabled_reason: null,
    });
  });

  it('turning off fails waiting deliveries; replays and test events need the endpoint on', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['consent.changed']);
    const sent = await webhooks().sendTest(e.owner, { endpointId: e.id });
    await deliverDue(c);
    const waiting = await webhooks().sendTest(e.owner, { endpointId: e.id });
    await expectAppError(
      webhooks().replay(e.owner, { deliveryId: waiting.deliveryId }),
      'conflict',
    );
    await webhooks().setEnabled(e.owner, { endpointId: e.id, enabled: false });
    const afterOff = new Map((await deliveriesOf(e.id)).map((d) => [d.id, d]));
    expect(afterOff.get(waiting.deliveryId)).toMatchObject({
      state: 'failed',
      last_error: 'endpoint_disabled',
    });
    // Finished deliveries keep their outcome.
    expect(afterOff.get(sent.deliveryId)).toMatchObject({ state: 'succeeded', last_error: null });
    // A delivery captured while the endpoint was being turned off ends without a request.
    const raced = await captureDirectly(c, e.id);
    expect(await deliverDue(c)).toMatchObject({ attempted: 0, failed: 1 });
    expect((await deliveriesOf(e.id)).find((d) => d.id === raced)).toMatchObject({
      state: 'failed',
      attempts: 0,
      last_error: 'endpoint_disabled',
    });
    expect(requestsTo(e.path)).toHaveLength(1);
    await expectAppError(
      webhooks().replay(e.owner, { deliveryId: sent.deliveryId }),
      'precondition_failed',
    );

    await webhooks().setEnabled(e.owner, { endpointId: e.id, enabled: true });
    const replay = await webhooks().replay(e.owner, { deliveryId: sent.deliveryId });
    expect(await deliverDue(c)).toMatchObject({ attempted: 1, succeeded: 1 });
    const rows = await deliveriesOf(e.id);
    const original = rows.find((d) => d.id === sent.deliveryId);
    expect(rows.find((d) => d.id === replay.deliveryId)).toMatchObject({
      state: 'succeeded',
      replay_of: sent.deliveryId,
      event_id: original?.event_id,
    });
    const [first, again] = requestsTo(e.path);
    expect(again?.headers['w360-event-id']).toBe(first?.headers['w360-event-id']);
    expect(again?.headers['w360-delivery-id']).toBe(replay.deliveryId);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.delivery_replayed'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toEqual({
      deliveryId: sent.deliveryId,
      newDeliveryId: replay.deliveryId,
    });
  });

  it('deleting an endpoint deletes its deliveries', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['consent.changed']);
    await webhooks().sendTest(e.owner, { endpointId: e.id });
    await webhooks().remove(e.owner, { endpointId: e.id });
    expect(await deliveriesOf(e.id)).toHaveLength(0);
    expect(await webhooks().list(e.owner)).toHaveLength(0);
    await expectAppError(webhooks().sendTest(e.owner, { endpointId: e.id }), 'not_found');
  });
});

/** Events and deliveries to the endpoint that failed for good, written straight to the tables. */
async function failedDirectly(
  c: Company,
  endpointId: string,
  count: number,
  type: WebhookEventType = 'message.received',
) {
  const rows = Array.from({ length: count }, () => ({ eventId: uuidv7(), deliveryId: uuidv7() }));
  await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, null), async (tx) => {
    await tx.insert(webhookEvents).values(
      rows.map((r) => ({
        id: r.eventId,
        tenantId: c.tenant.id,
        type,
        detail: {},
      })),
    );
    await tx.insert(webhookDeliveries).values(
      rows.map((r) => ({
        id: r.deliveryId,
        tenantId: c.tenant.id,
        endpointId,
        eventId: r.eventId,
        state: 'failed' as const,
        attempts: WEBHOOK_LIMITS.attempts,
        lastError: 'invalid_status',
        lastStatusCode: 500,
      })),
    );
  });
  return rows;
}

/**
 * One event per outcome, each with one delivery to the endpoint that failed for good with that last
 * error and status, written straight to the tables (ADR-159).
 */
async function failedAs(
  c: Company,
  endpointId: string,
  outcomes: readonly { error: string | null; status: number | null }[],
  type: WebhookEventType = 'message.received',
) {
  const rows = outcomes.map((o) => ({ ...o, eventId: uuidv7(), deliveryId: uuidv7() }));
  await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, null), async (tx) => {
    await tx
      .insert(webhookEvents)
      .values(rows.map((r) => ({ id: r.eventId, tenantId: c.tenant.id, type, detail: {} })));
    await tx.insert(webhookDeliveries).values(
      rows.map((r) => ({
        id: r.deliveryId,
        tenantId: c.tenant.id,
        endpointId,
        eventId: r.eventId,
        state: 'failed' as const,
        attempts: WEBHOOK_LIMITS.attempts,
        lastError: r.error,
        lastStatusCode: r.status,
      })),
    );
  });
  return rows;
}

describe('replaying failed deliveries (ADR-095)', () => {
  it('replays only the events whose latest failed delivery failed in the ways chosen, and the audit entry names them (ADR-159)', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['message.received', 'consent.changed']);
    // An attempt leaves a status or a code; a code that ended a delivery without an attempt says more
    // than the status an earlier attempt left.
    const kinds: Record<WebhookFailureKind, { error: string | null; status: number | null }[]> = {
      server_error: [
        { error: null, status: 500 },
        { error: null, status: 599 },
      ],
      client_error: [
        { error: null, status: 400 },
        { error: null, status: 499 },
      ],
      other_answer: [
        { error: null, status: 302 },
        { error: null, status: 101 },
      ],
      no_answer: [
        { error: 'timeout', status: null },
        { error: 'invalid_status', status: null },
        { error: 'interrupted', status: 503 },
      ],
      not_attempted: [
        { error: 'endpoint_disabled', status: 500 },
        { error: 'payload_failed', status: null },
      ],
    };
    const events: Record<string, string[]> = {};
    for (const [kind, outcomes] of Object.entries(kinds)) {
      events[kind] = (await failedAs(c, e.id, outcomes)).map((r) => r.eventId);
    }
    // A refused consent event, left out when only messages are chosen.
    const [consent] = await failedAs(c, e.id, [{ error: null, status: 422 }], 'consent.changed');
    // An event whose earlier delivery was answered 500 and whose latest one got no answer counts as
    // no answer, and its replay names the latest.
    const [retried] = await failedAs(c, e.id, [{ error: null, status: 500 }]);
    await fx.query(
      `UPDATE app.webhook_deliveries SET created_at = now() - interval '10 minutes' WHERE id = $1`,
      [retried!.deliveryId],
    );
    const latestId = uuidv7();
    await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, null), async (tx) => {
      await tx.insert(webhookDeliveries).values({
        id: latestId,
        tenantId: c.tenant.id,
        endpointId: e.id,
        eventId: retried!.eventId,
        state: 'failed',
        attempts: WEBHOOK_LIMITS.attempts,
        lastError: 'connect_failed',
      });
    });
    const replays = async () =>
      new Map(
        (await deliveriesOf(e.id))
          .filter((d) => d.replay_of !== null)
          .map((d) => [d.event_id, d.replay_of] as const),
      );
    const replay = (input: Record<string, unknown>) =>
      webhooks().replayFailed(e.owner, { endpointId: e.id, period: '1h', ...input });

    expect(await replay({ events: ['message.received'], failures: ['client_error'] })).toEqual({
      queued: 2,
      more: false,
    });
    expect([...(await replays()).keys()].sort()).toEqual([...events.client_error!].sort());
    expect(await replay({ failures: ['server_error'] })).toEqual({ queued: 2, more: false });
    expect(await replay({ failures: ['other_answer'] })).toEqual({ queued: 2, more: false });
    expect(await replay({ failures: ['not_attempted'] })).toEqual({ queued: 2, more: false });
    expect(await replay({ failures: ['no_answer'] })).toEqual({ queued: 4, more: false });
    const replayed = await replays();
    for (const kind of Object.keys(kinds)) {
      for (const eventId of events[kind]!) expect(replayed.has(eventId), kind).toBe(true);
    }
    expect(replayed.get(retried!.eventId)).toBe(latestId);
    expect(replayed.has(consent!.eventId)).toBe(false);
    // Nothing of those kinds is left; the refused consent event is, for its own kind.
    expect(await replay({ failures: ['server_error', 'no_answer'] })).toEqual({
      queued: 0,
      more: false,
    });
    expect(await replay({ failures: ['client_error'] })).toEqual({ queued: 1, more: false });
    expect((await replays()).has(consent!.eventId)).toBe(true);
    const audits = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.deliveries_replayed' ORDER BY occurred_at, id`,
      [c.tenant.id],
    );
    expect(audits.map((a) => a.metadata)).toEqual([
      {
        host: HOST,
        since: expect.any(String),
        events: ['message.received'],
        failures: ['client_error'],
        queued: 2,
        more: false,
      },
      ...(['server_error', 'other_answer', 'not_attempted'] as const).map((kind) => ({
        host: HOST,
        since: expect.any(String),
        failures: [kind],
        queued: 2,
        more: false,
      })),
      { host: HOST, since: expect.any(String), failures: ['no_answer'], queued: 4, more: false },
      {
        host: HOST,
        since: expect.any(String),
        failures: ['server_error', 'no_answer'],
        queued: 0,
        more: false,
      },
      { host: HOST, since: expect.any(String), failures: ['client_error'], queued: 1, more: false },
    ]);
    // Kinds the list does not know, or none, are refused before anything is read.
    for (const failures of [['server_errors'], []]) {
      await expectAppError(replay({ failures }), 'validation_failed');
    }
  });

  it('replays every endpoint that is on, 500 at most across them in the order they were added, audited once per endpoint (ADR-160)', async () => {
    const c = await fx.company();
    const first = await addEndpoint(c, 'ok', ['message.received']);
    const second = await addEndpoint(c, 'ok', ['message.received', 'consent.changed']);
    const off = await addEndpoint(c, 'ok', ['message.received']);
    const owner = first.owner;
    const atFirst = await failedDirectly(c, first.id, WEBHOOK_LIMITS.replayBatch);
    const [message] = await failedDirectly(c, second.id, 1);
    const [consent] = await failedDirectly(c, second.id, 1, 'consent.changed');
    const [atOff] = await failedDirectly(c, off.id, 1);
    await webhooks().setEnabled(owner, { endpointId: off.id, enabled: false });
    const replaysAt = async (endpointId: string) =>
      (await deliveriesOf(endpointId)).filter((d) => d.replay_of !== null).map((d) => d.event_id);
    const firstUrl = `http://${HOST}:${port}${first.path}`;
    const secondUrl = `http://${HOST}:${port}${second.path}`;

    // The first endpoint takes the whole batch; the second, with failures of its own, queues
    // nothing this time and says it has more. The endpoint that is off is left out.
    expect(await webhooks().replayAllFailed(owner, { period: '1h' })).toEqual({
      queued: WEBHOOK_LIMITS.replayBatch,
      more: true,
      endpoints: [
        { id: first.id, url: firstUrl, queued: WEBHOOK_LIMITS.replayBatch, more: false },
        { id: second.id, url: secondUrl, queued: 0, more: true },
      ],
    });
    expect((await replaysAt(first.id)).sort()).toEqual(atFirst.map((r) => r.eventId).sort());
    expect(await replaysAt(second.id)).toEqual([]);
    // Of one event, then of one kind of failure: the first endpoint's events are waiting now.
    expect(
      await webhooks().replayAllFailed(owner, { period: '1h', events: ['consent.changed'] }),
    ).toEqual({
      queued: 1,
      more: false,
      endpoints: [
        { id: first.id, url: firstUrl, queued: 0, more: false },
        { id: second.id, url: secondUrl, queued: 1, more: false },
      ],
    });
    expect(await replaysAt(second.id)).toEqual([consent!.eventId]);
    expect(
      await webhooks().replayAllFailed(owner, { period: '1h', failures: ['server_error'] }),
    ).toEqual({
      queued: 0,
      more: false,
      endpoints: [
        { id: first.id, url: firstUrl, queued: 0, more: false },
        { id: second.id, url: secondUrl, queued: 0, more: false },
      ],
    });
    expect(
      await webhooks().replayAllFailed(owner, { period: '1h', failures: ['no_answer'] }),
    ).toEqual({
      queued: 1,
      more: false,
      endpoints: [
        { id: first.id, url: firstUrl, queued: 0, more: false },
        { id: second.id, url: secondUrl, queued: 1, more: false },
      ],
    });
    expect((await replaysAt(second.id)).sort()).toEqual(
      [consent!.eventId, message!.eventId].sort(),
    );
    expect(await replaysAt(off.id)).toEqual([]);
    expect((await deliveriesOf(off.id)).map((d) => d.event_id)).toEqual([atOff!.eventId]);

    // One entry per endpoint replayed and call, marked as a replay of every endpoint.
    const audits = await fx.query<{ subject_id: string; metadata: Record<string, unknown> }>(
      `SELECT subject_id, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.deliveries_replayed' ORDER BY occurred_at, id`,
      [c.tenant.id],
    );
    const entry = (queued: number, more: boolean, chosen: Record<string, unknown> = {}) => ({
      host: HOST,
      since: expect.any(String),
      ...chosen,
      queued,
      more,
      allEndpoints: true,
    });
    expect(audits.map((a) => a.subject_id)).toEqual(
      Array.from({ length: 4 }, () => [first.id, second.id]).flat(),
    );
    expect(audits.map((a) => a.metadata)).toEqual([
      entry(WEBHOOK_LIMITS.replayBatch, false),
      entry(0, true),
      entry(0, false, { events: ['consent.changed'] }),
      entry(1, false, { events: ['consent.changed'] }),
      entry(0, false, { failures: ['server_error'] }),
      entry(0, false, { failures: ['server_error'] }),
      entry(0, false, { failures: ['no_answer'] }),
      entry(1, false, { failures: ['no_answer'] }),
    ]);

    // Refused: to members without developer.manage, a period or a kind not in the list, and a
    // company with no endpoint on (another company's endpoints are never replayed).
    const agent = await fx.ctx(c, c.agent);
    await expectAppError(webhooks().replayAllFailed(agent, { period: '1h' }), 'forbidden');
    await expectAppError(webhooks().replayAllFailed(owner, { period: '2h' }), 'validation_failed');
    await expectAppError(
      webhooks().replayAllFailed(owner, { period: '1h', failures: ['timeouts'] }),
      'validation_failed',
    );
    const other = await fx.company();
    await expectAppError(
      webhooks().replayAllFailed(await fx.ctx(other, other.owner), { period: '1h' }),
      'precondition_failed',
    );
    for (const e of [first, second]) {
      await webhooks().setEnabled(owner, { endpointId: e.id, enabled: false });
    }
    await expectAppError(
      webhooks().replayAllFailed(owner, { period: '1h' }),
      'precondition_failed',
      /Turn an endpoint on/,
    );
    expect(await replaysAt(off.id)).toEqual([]);
  });

  it('waits for an endpoint’s own replay, locking every endpoint first, and queues each event once (ADR-160)', async () => {
    const c = await fx.company();
    const first = await addEndpoint(c, 'ok', ['message.received']);
    const second = await addEndpoint(c, 'ok', ['message.received']);
    const atFirst = await failedDirectly(c, first.id, 2);
    const atSecond = await failedDirectly(c, second.id, 5);
    // The second endpoint's own replay holds it and has queued its first two events again: a
    // replay of every endpoint waits for it, then finds those two waiting and queues the rest.
    const holder = await fx.dbs.adminPool.connect();
    let replaying: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM app.webhook_endpoints WHERE id = $1 FOR NO KEY UPDATE', [
        second.id,
      ]);
      for (const r of atSecond.slice(0, 2)) {
        await holder.query(
          `INSERT INTO app.webhook_deliveries (id, tenant_id, endpoint_id, event_id, replay_of)
           VALUES ($1, $2, $3, $4, $5)`,
          [uuidv7(), c.tenant.id, second.id, r.eventId, r.deliveryId],
        );
      }
      const [lock] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      replaying = webhooks().replayAllFailed(first.owner, { period: '1h' });
      await vi.waitFor(
        async () => {
          const [waiting] = await fx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND $1 = ANY (pg_blocking_pids(pid))`,
            [lock!.pid],
          );
          if (waiting!.n < 1) throw new Error('the replay is not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
      // Nothing is queued at the first endpoint while it waits: every endpoint is locked first.
      expect((await deliveriesOf(first.id)).filter((d) => d.replay_of !== null)).toEqual([]);
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    expect(await replaying).toEqual({
      queued: 5,
      more: false,
      endpoints: [
        { id: first.id, url: expect.any(String), queued: 2, more: false },
        { id: second.id, url: expect.any(String), queued: 3, more: false },
      ],
    });
    for (const [e, rows] of [
      [first, atFirst],
      [second, atSecond],
    ] as const) {
      const replays = (await deliveriesOf(e.id)).filter((d) => d.replay_of !== null);
      expect(replays.map((d) => d.event_id).sort()).toEqual(rows.map((r) => r.eventId).sort());
    }
  });

  it('replays only the failed deliveries of the events chosen, and the audit entry names them (ADR-156)', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['message.received', 'consent.changed']);
    const messages = await failedDirectly(c, e.id, 2);
    const consents = await failedDirectly(c, e.id, 1, 'consent.changed');
    const replayed = async () =>
      (await deliveriesOf(e.id))
        .filter((d) => d.replay_of !== null)
        .map((d) => d.event_id)
        .sort();
    expect(
      await webhooks().replayFailed(e.owner, {
        endpointId: e.id,
        period: '1h',
        events: ['consent.changed'],
      }),
    ).toEqual({ queued: 1, more: false });
    expect(await replayed()).toEqual(consents.map((r) => r.eventId));
    // An event none of whose deliveries failed queues nothing.
    expect(
      await webhooks().replayFailed(e.owner, {
        endpointId: e.id,
        period: '1h',
        events: ['contact.created'],
      }),
    ).toEqual({ queued: 0, more: false });
    // Every event: the messages' deliveries, the consent one being already queued.
    expect(await webhooks().replayFailed(e.owner, { endpointId: e.id, period: '1h' })).toEqual({
      queued: 2,
      more: false,
    });
    expect(await replayed()).toEqual([...messages, ...consents].map((r) => r.eventId).sort());
    const audits = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.deliveries_replayed' ORDER BY occurred_at, id`,
      [c.tenant.id],
    );
    expect(audits.map((a) => a.metadata)).toEqual([
      {
        host: HOST,
        since: expect.any(String),
        events: ['consent.changed'],
        queued: 1,
        more: false,
      },
      {
        host: HOST,
        since: expect.any(String),
        events: ['contact.created'],
        queued: 0,
        more: false,
      },
      { host: HOST, since: expect.any(String), queued: 2, more: false },
    ]);
    // Events the list does not know, or none, are refused before anything is read.
    for (const events of [['order.shipped'], []]) {
      await expectAppError(
        webhooks().replayFailed(e.owner, { endpointId: e.id, period: '1h', events }),
        'validation_failed',
      );
    }
  });

  it('replays every event whose deliveries all failed in the period, once each, leaving out test events, gone events and other endpoints', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'fail', ['message.received']);
    const other = await addEndpoint(c, 'fail', ['message.received']);
    for (const text of ['one', 'two', 'three']) await inbound(c, waId(), text);
    await webhooks().sendTest(e.owner, { endpointId: e.id });
    // Every attempt fails; turning the endpoints off then fails what is waiting.
    await deliverDue(c);
    await webhooks().setEnabled(e.owner, { endpointId: e.id, enabled: false });
    await webhooks().setEnabled(e.owner, { endpointId: other.id, enabled: false });
    const failed = await deliveriesOf(e.id);
    expect(failed.map((d) => [d.type, d.state, d.last_error])).toEqual([
      ['message.received', 'failed', 'endpoint_disabled'],
      ['message.received', 'failed', 'endpoint_disabled'],
      ['message.received', 'failed', 'endpoint_disabled'],
      ['ping', 'failed', 'endpoint_disabled'],
    ]);
    // The third message's delivery found it gone: replaying it would fail again at once.
    await fx.query(`UPDATE app.webhook_deliveries SET last_error = 'event_gone' WHERE id = $1`, [
      failed[2]!.id,
    ]);

    // The receiver is fixed and the endpoint turned on again.
    await expectAppError(
      webhooks().replayFailed(e.owner, { endpointId: e.id, period: '1h' }),
      'precondition_failed',
      /Turn the endpoint on/,
    );
    const fixed = `/ok/${randomBytes(6).toString('hex')}`;
    await webhooks().update(e.owner, {
      endpointId: e.id,
      url: `http://${HOST}:${port}${fixed}`,
      description: '',
      eventTypes: ['message.received'],
    });
    await webhooks().setEnabled(e.owner, { endpointId: e.id, enabled: true });
    expect(await webhooks().replayFailed(e.owner, { endpointId: e.id, period: '1h' })).toEqual({
      queued: 2,
      more: false,
    });
    // While those wait, another call queues nothing.
    expect(await webhooks().replayFailed(e.owner, { endpointId: e.id, period: '1h' })).toEqual({
      queued: 0,
      more: false,
    });
    const byEvent = <T extends { event_id: string }>(rows: T[]) =>
      [...rows].sort((a, b) => a.event_id.localeCompare(b.event_id));
    const queued = (await deliveriesOf(e.id)).filter((d) => d.replay_of !== null);
    expect(byEvent(queued).map((d) => [d.event_id, d.replay_of, d.state])).toEqual(
      byEvent(failed.slice(0, 2)).map((d) => [d.event_id, d.id, 'pending']),
    );

    // Delivered, with their events' ids; delivered events are then left out.
    expect(await deliverDue(c)).toMatchObject({ attempted: 2, succeeded: 2 });
    expect(requestsTo(fixed).map((r) => r.headers['w360-event-id'])).toEqual(
      expect.arrayContaining([failed[0]!.event_id, failed[1]!.event_id]),
    );
    expect(requestsTo(fixed)).toHaveLength(2);
    expect(await webhooks().replayFailed(e.owner, { endpointId: e.id, period: '30d' })).toEqual({
      queued: 0,
      more: false,
    });
    // The other endpoint's failures stay as they were.
    expect((await deliveriesOf(other.id)).map((d) => [d.state, d.replay_of, d.last_error])).toEqual(
      [
        ['failed', null, 'endpoint_disabled'],
        ['failed', null, 'endpoint_disabled'],
        ['failed', null, 'endpoint_disabled'],
      ],
    );
    const audits = await fx.query<{ subject_id: string; metadata: Record<string, unknown> }>(
      `SELECT subject_id, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.deliveries_replayed' ORDER BY occurred_at, id`,
      [c.tenant.id],
    );
    expect(audits).toEqual([
      {
        subject_id: e.id,
        metadata: { host: HOST, since: expect.any(String), queued: 2, more: false },
      },
      {
        subject_id: e.id,
        metadata: { host: HOST, since: expect.any(String), queued: 0, more: false },
      },
      {
        subject_id: e.id,
        metadata: { host: HOST, since: expect.any(String), queued: 0, more: false },
      },
    ]);
    const since = Date.parse(String(audits[0]!.metadata.since));
    expect(Math.abs(Date.now() - 3_600_000 - since)).toBeLessThan(60_000);
  });

  it('queues at most 500 per call, oldest first, from the deliveries queued in the period', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['message.received']);
    const rows = await failedDirectly(c, e.id, WEBHOOK_LIMITS.replayBatch + 1);
    const replayedEvents = async () =>
      (await deliveriesOf(e.id))
        .filter((d) => d.replay_of !== null)
        .map((d) => d.event_id)
        .sort();
    // Seen two hours later, they were queued before the last hour and within the last day.
    const inTwoHours = webhooks(true, later(2 * 3_600_000));
    expect(await inTwoHours.replayFailed(e.owner, { endpointId: e.id, period: '1h' })).toEqual({
      queued: 0,
      more: false,
    });
    expect(await inTwoHours.replayFailed(e.owner, { endpointId: e.id, period: '24h' })).toEqual({
      queued: WEBHOOK_LIMITS.replayBatch,
      more: true,
    });
    // The oldest 500 events (ids grow with time), each replaying its failed delivery.
    const oldest = rows.slice(0, WEBHOOK_LIMITS.replayBatch).map((r) => r.eventId);
    expect(await replayedEvents()).toEqual([...oldest].sort());
    const replays = (await deliveriesOf(e.id)).filter((d) => d.replay_of !== null);
    const failedOf = new Map(rows.map((r) => [r.eventId, r.deliveryId]));
    expect(replays.every((d) => d.replay_of === failedOf.get(d.event_id))).toBe(true);
    // The next call queues the one left, the newest.
    expect(await webhooks().replayFailed(e.owner, { endpointId: e.id, period: '1h' })).toEqual({
      queued: 1,
      more: false,
    });
    expect(await replayedEvents()).toEqual(rows.map((r) => r.eventId).sort());
  });

  it('needs developer.manage, stays in the company and waits for a call already replaying', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['message.received']);
    const rows = await failedDirectly(c, e.id, 5);
    const agent = await fx.ctx(c, c.agent);
    await expectAppError(
      webhooks().replayFailed(agent, { endpointId: e.id, period: '1h' }),
      'forbidden',
    );
    await expectAppError(
      webhooks().replayFailed(e.owner, { endpointId: e.id, period: '2h' }),
      'validation_failed',
    );
    const other = await fx.company();
    await expectAppError(
      webhooks().replayFailed(await fx.ctx(other, other.owner), { endpointId: e.id, period: '1h' }),
      'not_found',
    );
    expect((await deliveriesOf(e.id)).filter((d) => d.replay_of !== null)).toEqual([]);

    // Another call holds the endpoint and has queued the first two events again: this one waits
    // for it, then finds those two waiting and queues the other three. Without the lock both
    // would read the same failures and queue the first two twice.
    const holder = await fx.dbs.adminPool.connect();
    let replaying: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM app.webhook_endpoints WHERE id = $1 FOR NO KEY UPDATE', [
        e.id,
      ]);
      for (const r of rows.slice(0, 2)) {
        await holder.query(
          `INSERT INTO app.webhook_deliveries (id, tenant_id, endpoint_id, event_id, replay_of)
           VALUES ($1, $2, $3, $4, $5)`,
          [uuidv7(), c.tenant.id, e.id, r.eventId, r.deliveryId],
        );
      }
      const [lock] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      replaying = webhooks().replayFailed(e.owner, { endpointId: e.id, period: '1h' });
      await vi.waitFor(
        async () => {
          const [waiting] = await fx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND $1 = ANY (pg_blocking_pids(pid))`,
            [lock!.pid],
          );
          if (waiting!.n < 1) throw new Error('the replay is not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    expect(await replaying).toEqual({ queued: 3, more: false });
    const replays = (await deliveriesOf(e.id)).filter((d) => d.replay_of !== null);
    expect(replays.map((d) => d.event_id).sort()).toEqual(rows.map((r) => r.eventId).sort());
  });
});

describe('secret rotation', () => {
  it('signs with the new and the previous secret for 24 hours, then with the new one only', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['consent.changed']);
    const { secret } = await webhooks().rotateSecret(e.owner, { endpointId: e.id });
    expect(secret).not.toBe(e.secret);
    const row = await endpointRow(e.id);
    expect(row.secret_version).toBe(2);
    expect(row.previous_secret_expires_at!.getTime() - Date.now()).toBeGreaterThan(
      23.9 * 3_600_000,
    );

    await webhooks().sendTest(e.owner, { endpointId: e.id });
    await deliverDue(c);
    const [during] = requestsTo(e.path);
    expect(String(during?.headers['w360-signature']).match(/v1=/g)).toHaveLength(2);
    expect(signedWith(during!, secret)).toBe(true);
    expect(signedWith(during!, e.secret)).toBe(true);

    await webhooks().sendTest(e.owner, { endpointId: e.id });
    await deliverDue(c, later(25 * 3_600_000));
    const [, after] = requestsTo(e.path);
    expect(String(after?.headers['w360-signature']).match(/v1=/g)).toHaveLength(1);
    expect(signedWith(after!, secret)).toBe(true);
    expect(signedWith(after!, e.secret)).toBe(false);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.secret_rotated'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toEqual({ host: HOST, secretVersion: 2 });
  });
});

describe('the address guard', () => {
  it('refuses private, loopback and metadata addresses when delivering', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const strict = createEgressClient({ ...DEFAULT_EGRESS_POLICY, timeoutMs: 1_000 });
    const loopback = await webhooks(false).create(owner, {
      url: `https://127.0.0.1:${port}/ok/guard`,
      eventTypes: ['consent.changed'],
    });
    const metadata = await webhooks(false).create(owner, {
      url: 'https://169.254.169.254/latest/meta-data',
      eventTypes: ['consent.changed'],
    });
    await webhooks().sendTest(owner, { endpointId: loopback.id });
    await webhooks().sendTest(owner, { endpointId: metadata.id });
    expect(await deliverDue(c, systemClock, strict)).toMatchObject({ attempted: 2, retrying: 2 });
    for (const id of [loopback.id, metadata.id]) {
      expect(await deliveriesOf(id)).toMatchObject([
        { state: 'pending', last_status_code: null, last_error: 'address_blocked' },
      ]);
    }
    // A public name that resolves to a private address is refused too.
    const rebinding = await webhooks(false).create(owner, {
      url: 'https://hooks.rebind.test/in',
      eventTypes: ['consent.changed'],
    });
    await webhooks().sendTest(owner, { endpointId: rebinding.id });
    const privateAnswer = createEgressClient(
      { ...DEFAULT_EGRESS_POLICY, timeoutMs: 1_000 },
      { resolve: async () => [{ address: '10.0.0.7', family: 4 }] },
    );
    await deliverDue(c, systemClock, privateAnswer);
    expect(await deliveriesOf(rebinding.id)).toMatchObject([{ last_error: 'address_blocked' }]);
    expect(requestsTo('/ok/guard')).toHaveLength(0);
  });
});

describe('dispatch and retention', () => {
  it('finds companies with due deliveries in the database, skips suspended ones, and queues one job per company', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['consent.changed']);
    await webhooks().sendTest(e.owner, { endpointId: e.id });
    expect(await findWebhookDispatchDue(fx.dbs.app, 10_000)).toContain(c.tenant.id);
    await dispatchDueWebhooks({ db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer }, 10_000);
    await dispatchDueWebhooks({ db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer }, 10_000);
    const jobs = await fx.query<{ state: string; data: { tenantId: string; kind: string } }>(
      `SELECT state, data FROM pgboss.job WHERE name = 'webhook.deliver' AND singleton_key = $1`,
      [c.tenant.id],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toMatchObject({ kind: 'webhook.deliver', tenantId: c.tenant.id });

    await fx.query(`UPDATE app.tenants SET status = 'suspended' WHERE id = $1`, [c.tenant.id]);
    expect(await findWebhookDispatchDue(fx.dbs.app, 10_000)).not.toContain(c.tenant.id);
    await fx.query(`UPDATE app.tenants SET status = 'active' WHERE id = $1`, [c.tenant.id]);
    await deliverDue(c);
    expect(await findWebhookDispatchDue(fx.dbs.app, 10_000)).not.toContain(c.tenant.id);
  });

  it('deletes events and deliveries 30 days after they were created', async () => {
    const c = await fx.company();
    const e = await addEndpoint(c, 'ok', ['consent.changed']);
    const old = await webhooks().sendTest(e.owner, { endpointId: e.id });
    const recent = await webhooks().sendTest(e.owner, { endpointId: e.id });
    await fx.query(
      `UPDATE app.webhook_deliveries SET created_at = now() - interval '31 days' WHERE id = $1`,
      [old.deliveryId],
    );
    await fx.query(
      `UPDATE app.webhook_events SET created_at = now() - interval '31 days'
        WHERE id = (SELECT event_id FROM app.webhook_deliveries WHERE id = $1)`,
      [old.deliveryId],
    );
    expect(await purgeWebhookData(fx.dbs.app)).toBeGreaterThanOrEqual(2);
    expect((await deliveriesOf(e.id)).map((d) => d.id)).toEqual([recent.deliveryId]);
    expect(await eventsOf(c)).toHaveLength(1);
  });
});

describe('isolation', () => {
  it('keeps endpoints, deliveries and captured events inside their company', async () => {
    const a = await fx.company();
    const b = await fx.company();
    const ownerA = await fx.ctx(a, a.owner);
    const ownerB = await fx.ctx(b, b.owner);
    const e = await addEndpoint(a, 'ok', ['consent.changed']);
    const { deliveryId } = await webhooks().sendTest(ownerA, { endpointId: e.id });

    expect(await webhooks().list(ownerB)).toHaveLength(0);
    expect(await webhooks().deliveries(ownerB, { endpointId: e.id })).toHaveLength(0);
    await expectAppError(webhooks().replay(ownerB, { deliveryId }), 'not_found');
    await expectAppError(
      webhooks().setEnabled(ownerB, { endpointId: e.id, enabled: false }),
      'not_found',
    );
    await expectAppError(webhooks().rotateSecret(ownerB, { endpointId: e.id }), 'not_found');
    await expectAppError(webhooks().remove(ownerB, { endpointId: e.id }), 'not_found');
    await expectAppError(webhooks().sendTest(ownerB, { endpointId: e.id }), 'not_found');
    // B's job scope delivers nothing of A's.
    expect(await deliverDue(b)).toMatchObject({ attempted: 0, failed: 0 });
    expect(await deliveriesOf(e.id)).toMatchObject([{ id: deliveryId, state: 'pending' }]);

    const scopeA = authorizedTenantScope(a.tenant.id, a.owner.id);
    // Capturing for another company from A's scope finds no endpoint of B and records nothing.
    await addEndpoint(b, 'ok', ['consent.changed']);
    await fx.dbs.app.run(scopeA, async (tx) => {
      await tx.execute(
        sql`select app.capture_webhook_event(${b.tenant.id}::uuid, 'consent.changed', null, null, null, null, null, '{}'::jsonb, now())`,
      );
    });
    expect(await eventsOf(b)).toHaveLength(0);
    // Row security refuses writing another company's rows.
    await expectRefused(
      fx.dbs.app.run(scopeA, async (tx) => {
        await tx.insert(webhookEvents).values({
          id: uuidv7(),
          tenantId: b.tenant.id,
          type: 'ping',
          detail: {},
        });
      }),
      /row-level security/,
    );
    // Column grants: the runtime role cannot move an endpoint or rewrite history.
    await expectRefused(
      fx.dbs.app.run(scopeA, async (tx) => {
        await tx.execute(
          sql`update app.webhook_endpoints set created_by_user_id = ${b.owner.id} where id = ${e.id}::uuid`,
        );
      }),
      /permission denied/,
    );
    await expectRefused(
      fx.dbs.app.run(scopeA, async (tx) => {
        await tx.execute(
          sql`update app.webhook_deliveries set event_id = gen_random_uuid() where id = ${deliveryId}::uuid`,
        );
      }),
      /permission denied/,
    );
    await expectRefused(
      fx.dbs.app.run(scopeA, async (tx) => {
        await tx.execute(
          sql`update app.webhook_events set status = 'read' where tenant_id = ${a.tenant.id}::uuid`,
        );
      }),
      /permission denied/,
    );
    await expectRefused(
      fx.dbs.app.run(scopeA, async (tx) => {
        await tx.execute(sql`delete from app.webhook_deliveries where id = ${deliveryId}::uuid`);
      }),
      /permission denied/,
    );
  });
});
