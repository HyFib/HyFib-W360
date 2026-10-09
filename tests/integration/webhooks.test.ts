import { randomBytes, randomInt } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isAppError, jsonbSize, sha256Hex, systemClock, uuidv7, type Clock } from '@w360/core';
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
  createCrmService,
  createTemplatesService,
  createWebhooksService,
  dispatchDueWebhooks,
  findWebhookDispatchDue,
  inboundSummary,
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
  WebhookOAuthTokenCache,
  webhookOAuthSecretAad,
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
 * disabling with its notice, replays and test events, secret rotation, OAuth clients and their
 * tokens, the address guard, dispatch and retention, and isolation.
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
/** What the authorization server answers at each /token/ path, for OAuth clients (ADR-173). */
const tokenAnswers = new Map<string, { status: number; body: unknown }>();
/** The bearer token each /bearer/ endpoint takes (ADR-173). */
const acceptedTokens = new Map<string, string>();

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
      } else if (path.startsWith('/token/')) {
        const answer = tokenAnswers.get(path) ?? { status: 404, body: { error: 'not_found' } };
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      } else if (path.startsWith('/bearer/')) {
        const accepted = acceptedTokens.get(path);
        if (accepted && req.headers.authorization === `Bearer ${accepted}`) {
          res.writeHead(204);
        } else {
          res.writeHead(401, { 'www-authenticate': 'Bearer error="invalid_token"' });
        }
        res.end();
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

/** The worker's delivery dependencies; each run keeps OAuth tokens of its own unless given some. */
function deliveryDeps(
  clock: Clock = systemClock,
  client: EgressClient = egress(),
  logger: WebhookDeliveryLogger = failOnLog,
  oauthTokens: WebhookOAuthTokenCache = new WebhookOAuthTokenCache(),
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
    oauthTokens,
  };
}

const deliverDue = (
  c: Company,
  clock?: Clock,
  client?: EgressClient,
  logger?: WebhookDeliveryLogger,
  oauthTokens?: WebhookOAuthTokenCache,
) =>
  processWebhookDeliveries(
    deliveryDeps(clock, client, logger, oauthTokens),
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

describe('OAuth clients (ADR-173)', () => {
  const auditsOf = async (c: Company, action: string) =>
    (
      await fx.query<{ metadata: Record<string, unknown> }>(
        'SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id',
        [c.tenant.id, action],
      )
    ).map((row) => row.metadata);
  const SECRET = 's3cr:et/+';

  /** An endpoint on a /bearer/ path of its own, getting tokens from a /token/ path of its own. */
  async function addOAuthEndpoint(c: Company, scope: string | null = 'events.write read') {
    const id = randomBytes(6).toString('hex');
    const bearer = `/bearer/${id}`;
    const token = `/token/${id}`;
    const owner = await fx.ctx(c, c.owner);
    const created = await webhooks().create(owner, {
      url: `http://${HOST}:${port}${bearer}`,
      eventTypes: ['consent.changed'],
      oauth: {
        tokenUrl: `http://${HOST}:${port}${token}`,
        clientId: 'hyfib-test',
        clientSecret: SECRET,
        scope,
      },
    });
    return { ...created, owner, bearer, token, tokenUrl: `http://${HOST}:${port}${token}` };
  }
  const issue = (path: string, accessToken: string, expiresIn: unknown = 3600) =>
    tokenAnswers.set(path, {
      status: 200,
      body: { access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn },
    });
  const authorizations = (path: string) => requestsTo(path).map((r) => r.headers.authorization);

  it('get a token as the endpoint’s client, send it as a bearer token and keep it for the next deliveries', async () => {
    const c = await fx.company();
    const e = await addOAuthEndpoint(c);
    issue(e.token, 'tok-1');
    acceptedTokens.set(e.bearer, 'tok-1');
    const tokens = new WebhookOAuthTokenCache();
    const first = await webhooks().sendTest(e.owner, { endpointId: e.id });
    expect(await deliverDue(c, systemClock, egress(), failOnLog, tokens)).toMatchObject({
      attempted: 1,
      succeeded: 1,
    });
    // The token request of RFC 6749 section 4.4.2: the client in a Basic header, its identifier
    // and secret each form-encoded, and the grant and the scope in a form; nothing of the delivery.
    const [asked] = requestsTo(e.token);
    expect(asked?.headers.authorization).toBe(
      `Basic ${Buffer.from('hyfib-test:s3cr%3Aet%2F%2B').toString('base64')}`,
    );
    expect(asked?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(asked?.headers.accept).toBe('application/json');
    expect(asked?.headers['user-agent']).toBe(WEBHOOK_USER_AGENT);
    expect(Object.keys(asked?.headers ?? {}).filter((name) => name.startsWith('w360-'))).toEqual(
      [],
    );
    expect(asked?.body).toBe('grant_type=client_credentials&scope=events.write+read');
    const [delivered] = requestsTo(e.bearer);
    expect(delivered?.headers.authorization).toBe('Bearer tok-1');
    expect(delivered?.headers['w360-delivery-id']).toBe(first.deliveryId);
    expect(signedWith(delivered!, e.secret)).toBe(true);

    // The next deliveries, three sent together, use the token the process kept.
    for (let i = 0; i < 3; i += 1) await webhooks().sendTest(e.owner, { endpointId: e.id });
    expect(await deliverDue(c, systemClock, egress(), failOnLog, tokens)).toMatchObject({
      attempted: 3,
      succeeded: 3,
    });
    expect(requestsTo(e.token)).toHaveLength(1);
    // Another process keeps none yet: one request serves the deliveries it sends together.
    for (let i = 0; i < 3; i += 1) await webhooks().sendTest(e.owner, { endpointId: e.id });
    expect(await deliverDue(c)).toMatchObject({ attempted: 3, succeeded: 3 });
    expect(requestsTo(e.token)).toHaveLength(2);
    expect(authorizations(e.bearer)).toEqual(Array.from({ length: 7 }, () => 'Bearer tok-1'));
  });

  it('fail an attempt without calling the endpoint when no token comes, and ask again at the next one', async () => {
    const c = await fx.company();
    const e = await addOAuthEndpoint(c, null);
    acceptedTokens.set(e.bearer, 'tok-2');
    tokenAnswers.set(e.token, { status: 401, body: { error: 'invalid_client' } });
    const tokens = new WebhookOAuthTokenCache();
    const test = await webhooks().sendTest(e.owner, { endpointId: e.id });
    expect(await deliverDue(c, systemClock, egress(), failOnLog, tokens)).toMatchObject({
      attempted: 1,
      retrying: 1,
    });
    expect(requestsTo(e.token).map((r) => r.body)).toEqual(['grant_type=client_credentials']);
    expect(requestsTo(e.bearer)).toHaveLength(0);
    expect(await deliveriesOf(e.id)).toMatchObject([
      {
        id: test.deliveryId,
        state: 'pending',
        attempts: 1,
        last_status_code: null,
        last_error: 'oauth_token_refused_401',
      },
    ]);
    // A 200 without a bearer token is none either, and a failure is not kept.
    tokenAnswers.set(e.token, { status: 200, body: { access_token: 'tok-2', token_type: 'mac' } });
    expect(await deliverDue(c, later(61_000), egress(), failOnLog, tokens)).toMatchObject({
      attempted: 1,
      retrying: 1,
    });
    expect(await deliveriesOf(e.id)).toMatchObject([
      { attempts: 2, last_status_code: null, last_error: 'oauth_token_invalid' },
    ]);
    // Once the server gives one, the next attempt gets it and is delivered.
    issue(e.token, 'tok-2');
    expect(await deliverDue(c, later(362_000), egress(), failOnLog, tokens)).toMatchObject({
      attempted: 1,
      succeeded: 1,
    });
    expect(await deliveriesOf(e.id)).toMatchObject([
      { state: 'succeeded', attempts: 3, last_status_code: 204, last_error: null },
    ]);
    expect(requestsTo(e.token)).toHaveLength(3);
    expect(requestsTo(e.bearer).map((r) => r.headers['w360-delivery-attempt'])).toEqual(['3']);
  });

  it('replace a token the endpoint refuses at the next attempt', async () => {
    const c = await fx.company();
    const e = await addOAuthEndpoint(c);
    issue(e.token, 'tok-old');
    acceptedTokens.set(e.bearer, 'tok-old');
    const tokens = new WebhookOAuthTokenCache();
    await webhooks().sendTest(e.owner, { endpointId: e.id });
    expect(await deliverDue(c, systemClock, egress(), failOnLog, tokens)).toMatchObject({
      succeeded: 1,
    });
    // The receiver revoked it: the token kept is answered 401 and dropped, and the attempt fails.
    acceptedTokens.set(e.bearer, 'tok-new');
    issue(e.token, 'tok-new');
    const second = await webhooks().sendTest(e.owner, { endpointId: e.id });
    expect(await deliverDue(c, systemClock, egress(), failOnLog, tokens)).toMatchObject({
      attempted: 1,
      retrying: 1,
    });
    expect(requestsTo(e.token)).toHaveLength(1);
    expect((await deliveriesOf(e.id)).find((d) => d.id === second.deliveryId)).toMatchObject({
      state: 'pending',
      last_status_code: 401,
      last_error: null,
    });
    expect(await deliverDue(c, later(61_000), egress(), failOnLog, tokens)).toMatchObject({
      attempted: 1,
      succeeded: 1,
    });
    expect(requestsTo(e.token)).toHaveLength(2);
    expect(authorizations(e.bearer)).toEqual([
      'Bearer tok-old',
      'Bearer tok-old',
      'Bearer tok-new',
    ]);
  });

  it('hold the token URL to the address guard', async () => {
    const c = await fx.company();
    const e = await addOAuthEndpoint(c);
    issue(e.token, 'tok-3');
    await webhooks().sendTest(e.owner, { endpointId: e.id });
    expect(
      await deliverDue(c, systemClock, egress([{ address: '10.0.0.7', family: 4 }])),
    ).toMatchObject({
      attempted: 1,
      retrying: 1,
    });
    expect(await deliveriesOf(e.id)).toMatchObject([
      { attempts: 1, last_status_code: null, last_error: 'oauth_token_address_blocked' },
    ]);
    expect(requestsTo(e.token)).toHaveLength(0);
    expect(requestsTo(e.bearer)).toHaveLength(0);
  });

  it('keep the secret sealed, need it again for another token URL, refuse an Authorization header beside it, and are audited by host only', async () => {
    const c = await fx.company();
    const e = await addOAuthEndpoint(c);
    const columns = async () => {
      const [row] = await fx.query<{
        oauth_token_url: string | null;
        oauth_client_id: string | null;
        oauth_client_secret_ciphertext: string | null;
        oauth_scope: string | null;
      }>(
        `SELECT oauth_token_url, oauth_client_id, oauth_client_secret_ciphertext, oauth_scope
           FROM app.webhook_endpoints WHERE id = $1`,
        [e.id],
      );
      if (!row) throw new Error('endpoint missing');
      return row;
    };
    const stored = await columns();
    expect(stored).toMatchObject({
      oauth_token_url: e.tokenUrl,
      oauth_client_id: 'hyfib-test',
      oauth_scope: 'events.write read',
    });
    expect(stored.oauth_client_secret_ciphertext).not.toContain(SECRET);
    expect(
      fx.keyring.decryptString(
        stored.oauth_client_secret_ciphertext!,
        webhookOAuthSecretAad(c.tenant.id, e.id),
      ),
    ).toBe(SECRET);
    const [listed] = await webhooks().list(e.owner);
    expect(listed?.oauth).toEqual({
      tokenUrl: e.tokenUrl,
      clientId: 'hyfib-test',
      scope: 'events.write read',
    });
    expect(JSON.stringify(await webhooks().list(e.owner))).not.toContain(SECRET);
    expect(await auditsOf(c, 'webhook.endpoint_created')).toEqual([
      { host: HOST, eventTypes: ['consent.changed'], oauthTokenHost: HOST },
    ]);

    const change = (more: Record<string, unknown>) =>
      webhooks().update(e.owner, {
        endpointId: e.id,
        url: `http://${HOST}:${port}${e.bearer}`,
        description: '',
        eventTypes: ['consent.changed'],
        ...more,
      });
    // The same token URL keeps the secret; another needs it again, since the secret goes there.
    await change({ oauth: { tokenUrl: e.tokenUrl, clientId: 'renamed', scope: null } });
    expect(await columns()).toEqual({ ...stored, oauth_client_id: 'renamed', oauth_scope: null });
    expect((await auditsOf(c, 'webhook.endpoint_updated')).at(-1)).toEqual({
      host: HOST,
      eventTypes: ['consent.changed'],
      oauthTokenHost: HOST,
      oauthSecretReplaced: false,
    });
    await expectAppError(
      change({ oauth: { tokenUrl: `http://elsewhere.test:${port}/token/x`, clientId: 'renamed' } }),
      'validation_failed',
      /Enter the client secret again/,
    );
    // The endpoint cannot send an Authorization header of its own beside its client.
    await expectAppError(
      change({ headers: [{ name: 'Authorization', value: 'Bearer fixed' }] }),
      'validation_failed',
      /sends them as its Authorization header/,
    );
    expect(await columns()).toEqual({ ...stored, oauth_client_id: 'renamed', oauth_scope: null });
    expect((await webhooks().list(e.owner))[0]?.headerNames).toEqual([]);
    // Removed, the header may be given; then a client may not.
    await change({ oauth: null, headers: [{ name: 'Authorization', value: 'Bearer fixed' }] });
    expect(await columns()).toEqual({
      oauth_token_url: null,
      oauth_client_id: null,
      oauth_client_secret_ciphertext: null,
      oauth_scope: null,
    });
    expect((await auditsOf(c, 'webhook.endpoint_updated')).at(-1)).toEqual({
      host: HOST,
      eventTypes: ['consent.changed'],
      headers: ['Authorization'],
      oauthRemoved: true,
    });
    await expectAppError(
      change({ oauth: { tokenUrl: e.tokenUrl, clientId: 'again', clientSecret: 'x' } }),
      'validation_failed',
      /sends them as its Authorization header/,
    );
    const audits = await fx.query<{ metadata: unknown }>(
      'SELECT metadata FROM app.audit_events WHERE tenant_id = $1',
      [c.tenant.id],
    );
    expect(JSON.stringify(audits)).not.toContain('s3cr');
  });

  it('are kept by the database together or not at all, with the scope alone optional', async () => {
    const c = await fx.company();
    const e = await addOAuthEndpoint(c);
    for (const set of [
      'oauth_token_url = NULL',
      'oauth_client_id = NULL',
      'oauth_client_secret_ciphertext = NULL',
      "oauth_client_id = ''",
      `oauth_client_id = repeat('i', ${WEBHOOK_LIMITS.oauthClientIdLength + 1})`,
      `oauth_scope = repeat('s', ${WEBHOOK_LIMITS.oauthScopeLength + 1})`,
      "oauth_scope = ''",
      // A scope alone.
      'oauth_token_url = NULL, oauth_client_id = NULL, oauth_client_secret_ciphertext = NULL',
    ]) {
      await expect(
        fx.query(`UPDATE app.webhook_endpoints SET ${set} WHERE id = $1`, [e.id]),
        set,
      ).rejects.toThrow(/webhook_endpoints_oauth/);
    }
    await fx.query('UPDATE app.webhook_endpoints SET oauth_scope = NULL WHERE id = $1', [e.id]);
    await fx.query(
      `UPDATE app.webhook_endpoints SET oauth_token_url = NULL, oauth_client_id = NULL,
         oauth_client_secret_ciphertext = NULL WHERE id = $1`,
      [e.id],
    );
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

describe('Payment Link status filters (ADR-308)', () => {
  it('are refused without payment_link.status_changed, unknown, creating or empty, kept by a change that leaves them out and cleared with the event; the database keeps them to that event', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], paymentLinkStatuses: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, paymentLinkStatuses }),
        'validation_failed',
        message,
      );
    // An order's own change has no link status to choose.
    const needsTheEvent = /only for an endpoint that receives Payment Link status/;
    await refused(['order.status_changed'], ['paid'], needsTheEvent);
    await refused(['payment_link.status_changed'], [], /at least one Payment Link status/);
    await refused(['payment_link.status_changed'], ['creating'], /from the list/);
    await refused(['payment_link.status_changed'], ['canceled'], /from the list/);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['payment_link.status_changed', 'consent.changed'],
      paymentLinkStatuses: ['failed', 'paid', 'failed'],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ paymentLinkStatuses: ['paid', 'failed'] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['payment_link.status_changed', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.paymentLinkStatuses;
    expect(await current()).toEqual(['paid', 'failed']);
    await change({ description: 'kept' });
    expect(await current()).toEqual(['paid', 'failed']);
    await change({ paymentLinkStatuses: ['expired'] });
    expect(await current()).toEqual(['expired']);
    const updates = await fx.query<{ metadata: { paymentLinkStatuses?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.paymentLinkStatuses)).toEqual([
      ['paid', 'failed'],
      ['expired'],
    ]);
    await change({ paymentLinkStatuses: null });
    expect(await current()).toBeNull();
    await change({ paymentLinkStatuses: ['partially_paid'] });
    // The database refuses an empty list, more than six entries, an unknown status, creating or a
    // missing one from an endpoint taking the event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET payment_link_statuses = ${value} WHERE id = $1`, [
        created.id,
      ]);
    for (const bad of [
      `'{}'`,
      `'{${Array(7).fill('paid').join(',')}}'`,
      `'{paid,creating}'`,
      `'{paid,canceled}'`,
      `ARRAY['paid', NULL]::text[]`,
      `ARRAY[ARRAY['paid'], ARRAY['failed']]::text[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(
        /webhook_endpoints_payment_link_statuses/,
      );
    }
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['consent.changed'], paymentLinkStatuses: ['paid'] }),
      'validation_failed',
      needsTheEvent,
    );
    // …and any list for an endpoint that does not take it.
    await expect(setInDatabase(`'{paid}'`)).rejects.toThrow(
      /webhook_endpoints_payment_link_statuses/,
    );
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'payment_link_statuses',
                'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });
});

describe('who made the order changes (ADR-322)', () => {
  it('are refused without order.status_changed, unknown or empty, kept by a change that leaves them out and cleared with the event; the database keeps them to that event', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], orderChangeMakers: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, orderChangeMakers }),
        'validation_failed',
        message,
      );
    // A new order and a Payment Link's change have no maker to choose.
    const needsTheEvent = /only for an endpoint that receives Order status/;
    await refused(['order.received', 'payment_link.status_changed'], ['member'], needsTheEvent);
    await refused(['order.status_changed'], [], /at least one maker/);
    await refused(['order.status_changed'], ['automation'], /from the list/);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['order.status_changed', 'order.received'],
      orderChangeMakers: ['payment_link', 'member', 'payment_link'],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ orderChangeMakers: ['member', 'payment_link'] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['order.status_changed', 'order.received'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.orderChangeMakers;
    expect(await current()).toEqual(['member', 'payment_link']);
    await change({ description: 'kept' });
    expect(await current()).toEqual(['member', 'payment_link']);
    await change({ orderChangeMakers: ['api'] });
    expect(await current()).toEqual(['api']);
    const updates = await fx.query<{ metadata: { orderChangeMakers?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.orderChangeMakers)).toEqual([
      ['member', 'payment_link'],
      ['api'],
    ]);
    await change({ orderChangeMakers: null });
    expect(await current()).toBeNull();
    await change({ orderChangeMakers: ['member'] });
    // The database refuses an empty list, more than three entries, an unknown maker or a missing
    // one from an endpoint taking the event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET order_change_makers = ${value} WHERE id = $1`, [
        created.id,
      ]);
    for (const bad of [
      `'{}'`,
      `'{member,api,payment_link,member}'`,
      `'{member,automation}'`,
      `ARRAY['member', NULL]::text[]`,
      `ARRAY[ARRAY['member'], ARRAY['api']]::text[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(
        /webhook_endpoints_order_change_makers/,
      );
    }
    await change({ eventTypes: ['order.received'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['order.received'], orderChangeMakers: ['member'] }),
      'validation_failed',
      needsTheEvent,
    );
    // …and any list for an endpoint that does not take it.
    await expect(setInDatabase(`'{member}'`)).rejects.toThrow(
      /webhook_endpoints_order_change_makers/,
    );
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'order_change_makers',
                'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });
});

describe('API keys left out of order changes (ADR-323)', () => {
  it('are refused without order.status_changed, or naming keys that are not the company’s or cannot change orders, kept by a change that leaves them out and cleared with the event; the database keeps them to that event', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
    const fulfilment = await keys.create(owner, {
      name: 'Fulfilment',
      scopes: ['orders.write'],
      expiresInDays: 0,
    });
    const payments = await keys.create(owner, {
      name: 'Payments',
      scopes: ['orders.read', 'orders.request_payment'],
      expiresInDays: 30,
    });
    const reader = await keys.create(owner, {
      name: 'Reader',
      scopes: ['orders.read'],
      expiresInDays: 0,
    });
    const other = await fx.company();
    const theirs = await keys.create(await fx.ctx(other, other.owner), {
      name: 'Theirs',
      scopes: ['orders.write'],
      expiresInDays: 0,
    });
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], orderExcludedApiKeyIds: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, orderExcludedApiKeyIds }),
        'validation_failed',
        message,
      );
    const needsTheEvent = /only for an endpoint that receives Order status/;
    const notTheirs = /API keys of this company that can change orders/;
    await refused(
      ['order.received', 'payment_link.status_changed'],
      [fulfilment.id],
      needsTheEvent,
    );
    await refused(['order.status_changed'], [], /at least one API key/);
    await refused(['order.status_changed'], [fulfilment.keyPrefix], /from the list/);
    await refused(['order.status_changed'], [fulfilment.id, reader.id], notTheirs);
    await refused(['order.status_changed'], [theirs.id], notTheirs);
    expect(await webhooks().list(owner)).toEqual([]);
    // Settings offers the keys that can change orders and work, by name.
    expect(await webhooks().orderApiKeyChoices(owner)).toEqual([
      { id: fulfilment.id, name: 'Fulfilment', keyPrefix: fulfilment.keyPrefix },
      { id: payments.id, name: 'Payments', keyPrefix: payments.keyPrefix },
    ]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['order.status_changed', 'consent.changed'],
      orderExcludedApiKeyIds: [fulfilment.id, payments.id, fulfilment.id.toUpperCase()],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({
      orderExcludedApiKeyIds: [fulfilment.id, payments.id],
    });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['order.status_changed', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.orderExcludedApiKeys;
    const named = (key: { id: string; keyPrefix: string }, name: string, state: string) => ({
      id: key.id,
      name,
      keyPrefix: key.keyPrefix,
      state,
    });
    expect(await current()).toEqual([
      named(fulfilment, 'Fulfilment', 'active'),
      named(payments, 'Payments', 'active'),
    ]);
    await change({ description: 'kept' });
    expect((await current())?.map((k) => k.id)).toEqual([fulfilment.id, payments.id]);
    // A key revoked since stays named, and allowed.
    await keys.revoke(owner, { keyId: payments.id });
    expect(await current()).toEqual([
      named(fulfilment, 'Fulfilment', 'active'),
      named(payments, 'Payments', 'revoked'),
    ]);
    await change({ orderExcludedApiKeyIds: [payments.id] });
    const updates = await fx.query<{ metadata: { orderExcludedApiKeyIds?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.orderExcludedApiKeyIds)).toEqual([
      [fulfilment.id, payments.id],
      [payments.id],
    ]);
    await change({ orderExcludedApiKeyIds: null });
    expect(await current()).toBeNull();
    await change({ orderExcludedApiKeyIds: [fulfilment.id] });
    // The database refuses an empty list, more than 20 keys, a missing one or a list of lists from
    // an endpoint taking the event…
    const setInDatabase = (value: string) =>
      fx.query(
        `UPDATE app.webhook_endpoints SET order_excluded_api_key_ids = ${value} WHERE id = $1`,
        [created.id],
      );
    const many = Array.from({ length: 21 }, () => `'${uuidv7()}'`).join(', ');
    for (const bad of [
      `'{}'`,
      `ARRAY[${many}]::uuid[]`,
      `ARRAY['${fulfilment.id}', NULL]::uuid[]`,
      `ARRAY[ARRAY['${fulfilment.id}']]::uuid[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(
        /webhook_endpoints_order_excluded_api_key_ids/,
      );
    }
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['consent.changed'], orderExcludedApiKeyIds: [fulfilment.id] }),
      'validation_failed',
      needsTheEvent,
    );
    // …and any list from an endpoint not taking it.
    await expect(setInDatabase(`ARRAY['${fulfilment.id}']::uuid[]`)).rejects.toThrow(
      /webhook_endpoints_order_excluded_api_key_ids/,
    );
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints',
                'order_excluded_api_key_ids', 'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });
});

describe('API key filters of Payment Link events (ADR-324)', () => {
  it('are refused without payment_link.status_changed, or naming keys that are not the company’s or cannot ask customers to pay, kept by a change that leaves them out and cleared with the event; the database keeps them to that event', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
    const billing = await keys.create(owner, {
      name: 'Billing',
      scopes: ['orders.read', 'orders.request_payment'],
      expiresInDays: 30,
    });
    const payer = await keys.create(owner, {
      name: 'Payer',
      scopes: ['orders.request_payment'],
      expiresInDays: 0,
    });
    const mover = await keys.create(owner, {
      name: 'Mover',
      scopes: ['orders.write'],
      expiresInDays: 0,
    });
    const other = await fx.company();
    const theirs = await keys.create(await fx.ctx(other, other.owner), {
      name: 'Theirs',
      scopes: ['orders.request_payment'],
      expiresInDays: 0,
    });
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], paymentLinkApiKeyIds: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, paymentLinkApiKeyIds }),
        'validation_failed',
        message,
      );
    const needsTheEvent = /only for an endpoint that receives Payment Link status/;
    const notTheirs = /API keys of this company that can ask customers to pay/;
    await refused(['order.status_changed'], [payer.id], needsTheEvent);
    await refused(['payment_link.status_changed'], [], /at least one API key/);
    await refused(['payment_link.status_changed'], [payer.keyPrefix], /from the list/);
    // A key that moves orders on asks for no link.
    await refused(['payment_link.status_changed'], [payer.id, mover.id], notTheirs);
    await refused(['payment_link.status_changed'], [theirs.id], notTheirs);
    expect(await webhooks().list(owner)).toEqual([]);
    // Settings offers the keys that ask customers to pay and work, by name.
    expect(await webhooks().paymentLinkApiKeyChoices(owner)).toEqual([
      { id: billing.id, name: 'Billing', keyPrefix: billing.keyPrefix },
      { id: payer.id, name: 'Payer', keyPrefix: payer.keyPrefix },
    ]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['payment_link.status_changed', 'consent.changed'],
      paymentLinkApiKeyIds: [payer.id, billing.id, payer.id.toUpperCase()],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ paymentLinkApiKeyIds: [payer.id, billing.id] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['payment_link.status_changed', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.paymentLinkApiKeys;
    const named = (key: { id: string; keyPrefix: string }, name: string, state: string) => ({
      id: key.id,
      name,
      keyPrefix: key.keyPrefix,
      state,
    });
    expect(await current()).toEqual([
      named(payer, 'Payer', 'active'),
      named(billing, 'Billing', 'active'),
    ]);
    await change({ description: 'kept' });
    expect((await current())?.map((k) => k.id)).toEqual([payer.id, billing.id]);
    // A key revoked since stays named, and allowed: its links still change status.
    await keys.revoke(owner, { keyId: billing.id });
    expect(await current()).toEqual([
      named(payer, 'Payer', 'active'),
      named(billing, 'Billing', 'revoked'),
    ]);
    await change({ paymentLinkApiKeyIds: [billing.id] });
    const updates = await fx.query<{ metadata: { paymentLinkApiKeyIds?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.paymentLinkApiKeyIds)).toEqual([
      [payer.id, billing.id],
      [billing.id],
    ]);
    await change({ paymentLinkApiKeyIds: null });
    expect(await current()).toBeNull();
    await change({ paymentLinkApiKeyIds: [payer.id] });
    // The database refuses an empty list, more than 20 keys, a missing one or a list of lists from
    // an endpoint taking the event…
    const setInDatabase = (value: string) =>
      fx.query(
        `UPDATE app.webhook_endpoints SET payment_link_api_key_ids = ${value} WHERE id = $1`,
        [created.id],
      );
    const many = Array.from({ length: 21 }, () => `'${uuidv7()}'`).join(', ');
    for (const bad of [
      `'{}'`,
      `ARRAY[${many}]::uuid[]`,
      `ARRAY['${payer.id}', NULL]::uuid[]`,
      `ARRAY[ARRAY['${payer.id}']]::uuid[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(
        /webhook_endpoints_payment_link_api_key_ids/,
      );
    }
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['consent.changed'], paymentLinkApiKeyIds: [payer.id] }),
      'validation_failed',
      needsTheEvent,
    );
    // …and any list from an endpoint not taking it.
    await expect(setInDatabase(`ARRAY['${payer.id}']::uuid[]`)).rejects.toThrow(
      /webhook_endpoints_payment_link_api_key_ids/,
    );
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'payment_link_api_key_ids',
                'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });
});

describe('deal and task status filters (ADR-309)', () => {
  const kinds = [
    {
      field: 'dealStatuses',
      column: 'deal_statuses',
      event: 'deal.status_changed',
      other: 'deal.created',
      crossed: 'task.status_changed',
      label: /only for an endpoint that receives Deal won, lost or reopened/,
      unknown: 'closed',
      chosen: ['lost', 'won', 'lost'],
      kept: ['won', 'lost'],
      changed: ['open'],
      four: `'{won,lost,open,won}'`,
    },
    {
      field: 'taskStatuses',
      column: 'task_statuses',
      event: 'task.status_changed',
      other: 'task.created',
      crossed: 'deal.status_changed',
      label: /only for an endpoint that receives Task done, cancelled or reopened/,
      unknown: 'completed',
      chosen: ['cancelled', 'done', 'cancelled'],
      kept: ['done', 'cancelled'],
      changed: ['open'],
      four: `'{done,cancelled,open,done}'`,
    },
  ] as const;

  for (const kind of kinds) {
    it(`are refused without ${kind.event}, unknown or empty, kept by a change that leaves them out and cleared with the event; the database keeps them to that event (${kind.field})`, async () => {
      const c = await fx.company();
      const owner = await fx.ctx(c, c.owner);
      const url = 'https://hooks.example.com/in';
      const refused = (eventTypes: string[], list: unknown, message: RegExp) =>
        expectAppError(
          webhooks().create(owner, { url, eventTypes, [kind.field]: list }),
          'validation_failed',
          message,
        );
      // The other events of a deal or a task have no status to choose, nor does the other's
      // status change.
      await refused([kind.other], ['open'], kind.label);
      await refused([kind.crossed], ['open'], kind.label);
      await refused([kind.event], [], /at least one/);
      await refused([kind.event], [kind.unknown], /from the list/);
      expect(await webhooks().list(owner)).toEqual([]);

      const created = await webhooks().create(owner, {
        url,
        eventTypes: [kind.event, 'consent.changed'],
        [kind.field]: [...kind.chosen],
      });
      const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
        [c.tenant.id],
      );
      expect(audit?.metadata).toMatchObject({ [kind.field]: [...kind.kept] });
      const change = (fields: Record<string, unknown>) =>
        webhooks().update(owner, {
          endpointId: created.id,
          url,
          description: '',
          eventTypes: [kind.event, 'consent.changed'],
          ...fields,
        });
      const current = async () => {
        const endpoint = (await webhooks().list(owner)).find((e) => e.id === created.id);
        return endpoint?.[kind.field];
      };
      expect(await current()).toEqual([...kind.kept]);
      await change({ description: 'kept' });
      expect(await current()).toEqual([...kind.kept]);
      await change({ [kind.field]: [...kind.changed] });
      expect(await current()).toEqual([...kind.changed]);
      const updates = await fx.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM app.audit_events
          WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
        [c.tenant.id],
      );
      expect(updates.map((u) => u.metadata[kind.field])).toEqual([
        [...kind.kept],
        [...kind.changed],
      ]);
      await change({ [kind.field]: null });
      expect(await current()).toBeNull();
      await change({ [kind.field]: [...kind.kept] });
      // The database refuses an empty list, more than three entries, an unknown status or a
      // missing one from an endpoint taking the event…
      const setInDatabase = (value: string) =>
        fx.query(`UPDATE app.webhook_endpoints SET ${kind.column} = ${value} WHERE id = $1`, [
          created.id,
        ]);
      const check = new RegExp(`webhook_endpoints_${kind.column}`);
      for (const bad of [
        `'{}'`,
        kind.four,
        `'{open,${kind.unknown}}'`,
        `ARRAY['open', NULL]::text[]`,
        `ARRAY[ARRAY['open'], ARRAY['${kind.kept[0]}']]::text[]`,
      ]) {
        await expect(setInDatabase(bad), bad).rejects.toThrow(check);
      }
      await change({ eventTypes: ['consent.changed'] });
      expect(await current()).toBeNull();
      await expectAppError(
        change({ eventTypes: ['consent.changed'], [kind.field]: ['open'] }),
        'validation_failed',
        kind.label,
      );
      // …and any list for an endpoint that does not take it.
      await expect(setInDatabase(`'{open}'`)).rejects.toThrow(check);
      // The company role changes the list only through its column grant.
      const [grant] = await fx.query<{ can_update: boolean }>(
        `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', $1, 'UPDATE') AS can_update`,
        [kind.column],
      );
      expect(grant?.can_update).toBe(true);
    });
  }
});

describe('deal and task detail filters (ADR-310)', () => {
  const kinds = [
    {
      field: 'dealDetails',
      column: 'deal_details',
      event: 'deal.updated',
      other: 'deal.created',
      crossed: 'task.updated',
      label: /only for an endpoint that receives Deal details/,
      unknown: 'value',
      chosen: ['expectedCloseOn', 'title', 'expectedCloseOn'],
      kept: ['title', 'expectedCloseOn'],
      changed: ['valueMinor'],
      tooMany: `'{title,valueMinor,expectedCloseOn,title}'`,
    },
    {
      field: 'taskDetails',
      column: 'task_details',
      event: 'task.updated',
      other: 'task.created',
      crossed: 'deal.updated',
      label: /only for an endpoint that receives Task details/,
      unknown: 'due',
      chosen: ['remindAt', 'title', 'remindAt'],
      kept: ['title', 'remindAt'],
      changed: ['notes'],
      tooMany: `'{title,notes,dueAt,remindAt,title}'`,
    },
  ] as const;

  for (const kind of kinds) {
    it(`are refused without ${kind.event}, unknown or empty, kept by a change that leaves them out and cleared with the event; the database keeps them to that event (${kind.field})`, async () => {
      const c = await fx.company();
      const owner = await fx.ctx(c, c.owner);
      const url = 'https://hooks.example.com/in';
      const refused = (eventTypes: string[], list: unknown, message: RegExp) =>
        expectAppError(
          webhooks().create(owner, { url, eventTypes, [kind.field]: list }),
          'validation_failed',
          message,
        );
      // The other events of a deal or a task have no detail to choose, nor does the other's
      // change of details.
      await refused([kind.other], ['title'], kind.label);
      await refused([kind.crossed], ['title'], kind.label);
      await refused([kind.event], [], /at least one/);
      await refused([kind.event], [kind.unknown], /from the list/);
      expect(await webhooks().list(owner)).toEqual([]);

      const created = await webhooks().create(owner, {
        url,
        eventTypes: [kind.event, 'consent.changed'],
        [kind.field]: [...kind.chosen],
      });
      const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
        [c.tenant.id],
      );
      expect(audit?.metadata).toMatchObject({ [kind.field]: [...kind.kept] });
      const change = (fields: Record<string, unknown>) =>
        webhooks().update(owner, {
          endpointId: created.id,
          url,
          description: '',
          eventTypes: [kind.event, 'consent.changed'],
          ...fields,
        });
      const current = async () => {
        const endpoint = (await webhooks().list(owner)).find((e) => e.id === created.id);
        return endpoint?.[kind.field];
      };
      expect(await current()).toEqual([...kind.kept]);
      await change({ description: 'kept' });
      expect(await current()).toEqual([...kind.kept]);
      await change({ [kind.field]: [...kind.changed] });
      expect(await current()).toEqual([...kind.changed]);
      const updates = await fx.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM app.audit_events
          WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
        [c.tenant.id],
      );
      expect(updates.map((u) => u.metadata[kind.field])).toEqual([
        [...kind.kept],
        [...kind.changed],
      ]);
      await change({ [kind.field]: null });
      expect(await current()).toBeNull();
      await change({ [kind.field]: [...kind.kept] });
      // The database refuses an empty list, too many entries, an unknown detail or a missing one
      // from an endpoint taking the event…
      const setInDatabase = (value: string) =>
        fx.query(`UPDATE app.webhook_endpoints SET ${kind.column} = ${value} WHERE id = $1`, [
          created.id,
        ]);
      const check = new RegExp(`webhook_endpoints_${kind.column}`);
      for (const bad of [
        `'{}'`,
        kind.tooMany,
        `'{title,${kind.unknown}}'`,
        `ARRAY['title', NULL]::text[]`,
        `ARRAY[ARRAY['title'], ARRAY['${kind.kept[1]}']]::text[]`,
      ]) {
        await expect(setInDatabase(bad), bad).rejects.toThrow(check);
      }
      await change({ eventTypes: ['consent.changed'] });
      expect(await current()).toBeNull();
      await expectAppError(
        change({ eventTypes: ['consent.changed'], [kind.field]: ['title'] }),
        'validation_failed',
        kind.label,
      );
      // …and any list for an endpoint that does not take it.
      await expect(setInDatabase(`'{title}'`)).rejects.toThrow(check);
      // The company role changes the list only through its column grant.
      const [grant] = await fx.query<{ can_update: boolean }>(
        `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', $1, 'UPDATE') AS can_update`,
        [kind.column],
      );
      expect(grant?.can_update).toBe(true);
    });
  }
});

describe('run step kind of node filters (ADR-328)', () => {
  it('are refused without automation.run_step, unknown or empty, kept by a change that leaves them out and cleared with the event; the database keeps them to that event', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], runStepNodeTypes: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, runStepNodeTypes }),
        'validation_failed',
        message,
      );
    // A run's start and end have no kind of step to choose.
    const needsTheEvent = /only for an endpoint that receives Automation step/;
    await refused(['automation.run_started', 'automation.run_ended'], ['wait'], needsTheEvent);
    await refused(['automation.run_step'], [], /at least one kind of step/);
    await refused(['automation.run_step'], ['keyword'], /from the list/);
    await refused(['automation.run_step'], ['Wait'], /from the list/);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['automation.run_step', 'consent.changed'],
      runStepNodeTypes: ['wait', 'send_text', 'wait'],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ runStepNodeTypes: ['send_text', 'wait'] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['automation.run_step', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.runStepNodeTypes;
    expect(await current()).toEqual(['send_text', 'wait']);
    await change({ description: 'kept' });
    expect(await current()).toEqual(['send_text', 'wait']);
    await change({ runStepNodeTypes: ['http_request'] });
    expect(await current()).toEqual(['http_request']);
    const updates = await fx.query<{ metadata: { runStepNodeTypes?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.runStepNodeTypes)).toEqual([
      ['send_text', 'wait'],
      ['http_request'],
    ]);
    await change({ runStepNodeTypes: null });
    expect(await current()).toBeNull();
    await change({ runStepNodeTypes: ['end'] });
    // The database refuses an empty list, more than 18 entries, an unknown kind (a trigger
    // included), a missing one or a nested list from an endpoint taking the event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET run_step_node_types = ${value} WHERE id = $1`, [
        created.id,
      ]);
    for (const bad of [
      `'{}'`,
      `'{${Array(19).fill('wait').join(',')}}'`,
      `'{wait,keyword}'`,
      `'{wait,none}'`,
      `'{wait,Wait}'`,
      `ARRAY['wait', NULL]::text[]`,
      `ARRAY[ARRAY['wait'], ARRAY['end']]::text[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(
        /webhook_endpoints_run_step_node_types/,
      );
    }
    // Every kind at once, the steps outside a node among them, is a list the database takes.
    await setInDatabase(
      `ARRAY['send_text', 'ask_buttons', 'ask_text', 'send_template', 'ask_template', 'send_flow',
             'condition', 'update_contact', 'update_conversation', 'http_request', 'create_task',
             'create_deal', 'move_deal', 'close_deal', 'wait', 'handoff', 'end',
             'outside_node']::text[]`,
    );
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['consent.changed'], runStepNodeTypes: ['wait'] }),
      'validation_failed',
      needsTheEvent,
    );
    // …and any list for an endpoint that does not take it, a run's other events included.
    await expect(setInDatabase(`'{wait}'`)).rejects.toThrow(
      /webhook_endpoints_run_step_node_types/,
    );
    await change({ eventTypes: ['automation.run_started'] });
    await expect(setInDatabase(`'{wait}'`)).rejects.toThrow(
      /webhook_endpoints_run_step_node_types/,
    );
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'run_step_node_types',
                'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });
});

describe('run step outcome filters (ADR-327)', () => {
  it('are refused without automation.run_step, unknown or empty, kept by a change that leaves them out and cleared with the event; the database keeps them to that event', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], runStepOutcomes: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, runStepOutcomes }),
        'validation_failed',
        message,
      );
    // A run's start and end have no step outcome to choose.
    const needsTheEvent = /only for an endpoint that receives Automation step/;
    await refused(['automation.run_started', 'automation.run_ended'], ['failed'], needsTheEvent);
    await refused(['automation.run_step'], [], /at least one step outcome/);
    await refused(['automation.run_step'], ['running'], /from the list/);
    await refused(['automation.run_step'], ['Failed'], /from the list/);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['automation.run_step', 'consent.changed'],
      runStepOutcomes: ['failed', 'sent', 'failed'],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ runStepOutcomes: ['sent', 'failed'] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['automation.run_step', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.runStepOutcomes;
    expect(await current()).toEqual(['sent', 'failed']);
    await change({ description: 'kept' });
    expect(await current()).toEqual(['sent', 'failed']);
    await change({ runStepOutcomes: ['timed_out'] });
    expect(await current()).toEqual(['timed_out']);
    const updates = await fx.query<{ metadata: { runStepOutcomes?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.runStepOutcomes)).toEqual([
      ['sent', 'failed'],
      ['timed_out'],
    ]);
    await change({ runStepOutcomes: null });
    expect(await current()).toBeNull();
    await change({ runStepOutcomes: ['closed'] });
    // The database refuses an empty list, more than 21 entries, an unknown outcome, a missing one
    // or a nested list from an endpoint taking the event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET run_step_outcomes = ${value} WHERE id = $1`, [
        created.id,
      ]);
    for (const bad of [
      `'{}'`,
      `'{${Array(22).fill('sent').join(',')}}'`,
      `'{sent,running}'`,
      `'{sent,Failed}'`,
      `ARRAY['sent', NULL]::text[]`,
      `ARRAY[ARRAY['sent'], ARRAY['failed']]::text[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_run_step_outcomes/);
    }
    // Every outcome at once is a list the database takes.
    await setInDatabase(
      `ARRAY['started', 'sent', 'asked', 'answered', 'retried', 'timed_out', 'branched', 'updated',
             'waiting', 'resumed', 'handed_off', 'completed', 'failed', 'stopped', 'taken_over',
             'requested', 'responded', 'created', 'skipped', 'moved', 'closed']::text[]`,
    );
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['consent.changed'], runStepOutcomes: ['failed'] }),
      'validation_failed',
      needsTheEvent,
    );
    // …and any list for an endpoint that does not take it, a run's other events included.
    await expect(setInDatabase(`'{failed}'`)).rejects.toThrow(
      /webhook_endpoints_run_step_outcomes/,
    );
    await change({ eventTypes: ['automation.run_ended'] });
    await expect(setInDatabase(`'{failed}'`)).rejects.toThrow(
      /webhook_endpoints_run_step_outcomes/,
    );
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'run_step_outcomes',
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

describe('API key filters of message statuses (ADR-320)', () => {
  it('are refused without message.status, or naming keys that are not the company’s or cannot send messages, kept by a change that leaves them out and cleared with the event; the database keeps them to it', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
    const shop = await keys.create(owner, {
      name: 'Shop',
      scopes: ['messages.send'],
      expiresInDays: 0,
    });
    const desk = await keys.create(owner, {
      name: 'Helpdesk',
      scopes: ['contacts.read', 'messages.reply'],
      expiresInDays: 30,
    });
    const runner = await keys.create(owner, {
      name: 'Runner',
      scopes: ['automations.start'],
      expiresInDays: 0,
    });
    const other = await fx.company();
    const theirs = await keys.create(await fx.ctx(other, other.owner), {
      name: 'Theirs',
      scopes: ['messages.send'],
      expiresInDays: 0,
    });
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], messageApiKeyIds: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, messageApiKeyIds }),
        'validation_failed',
        message,
      );
    const needsTheEvent = /only for an endpoint that receives Message status/;
    const notTheirs = /API keys of this company that can send messages/;
    await refused(['message.received'], [shop.id], needsTheEvent);
    await refused(['message.status'], [], /at least one API key/);
    await refused(['message.status'], [shop.keyPrefix], /from the list/);
    await refused(['message.status'], [shop.id, runner.id], notTheirs);
    await refused(['message.status'], [theirs.id], notTheirs);
    expect(await webhooks().list(owner)).toEqual([]);
    // Settings offers the keys that can send messages and work, by name, and for runs the key that
    // can start them.
    expect(await webhooks().messageApiKeyChoices(owner)).toEqual([
      { id: desk.id, name: 'Helpdesk', keyPrefix: desk.keyPrefix },
      { id: shop.id, name: 'Shop', keyPrefix: shop.keyPrefix },
    ]);
    expect((await webhooks().runApiKeyChoices(owner)).map((k) => k.id)).toEqual([runner.id]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['message.status', 'message.received'],
      messageApiKeyIds: [shop.id, desk.id, shop.id.toUpperCase()],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ messageApiKeyIds: [shop.id, desk.id] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['message.status', 'message.received'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.messageApiKeys;
    const named = (key: { id: string; keyPrefix: string }, name: string, state: string) => ({
      id: key.id,
      name,
      keyPrefix: key.keyPrefix,
      state,
    });
    expect(await current()).toEqual([
      named(shop, 'Shop', 'active'),
      named(desk, 'Helpdesk', 'active'),
    ]);
    await change({ description: 'kept' });
    expect((await current())?.map((k) => k.id)).toEqual([shop.id, desk.id]);
    // A key revoked since stays named, and allowed: the messages it sent still change status.
    await keys.revoke(owner, { keyId: desk.id });
    expect(await current()).toEqual([
      named(shop, 'Shop', 'active'),
      named(desk, 'Helpdesk', 'revoked'),
    ]);
    await change({ messageApiKeyIds: [desk.id] });
    expect((await current())?.map((k) => k.id)).toEqual([desk.id]);
    const updates = await fx.query<{ metadata: { messageApiKeyIds?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.messageApiKeyIds)).toEqual([
      [shop.id, desk.id],
      [desk.id],
    ]);
    await change({ messageApiKeyIds: null });
    expect(await current()).toBeNull();
    await change({ messageApiKeyIds: [shop.id] });
    // Received messages alone do not keep the list.
    await change({ eventTypes: ['message.received'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['message.received'], messageApiKeyIds: [shop.id] }),
      'validation_failed',
      needsTheEvent,
    );
    // The database refuses an empty list, more than 20 keys, a missing one or a list of lists from
    // an endpoint taking message.status…
    await change({ eventTypes: ['message.status'], messageApiKeyIds: [shop.id] });
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET message_api_key_ids = ${value} WHERE id = $1`, [
        created.id,
      ]);
    const many = Array.from({ length: 21 }, () => `'${uuidv7()}'`).join(', ');
    for (const bad of [
      `'{}'`,
      `ARRAY[${many}]::uuid[]`,
      `ARRAY['${shop.id}', NULL]::uuid[]`,
      `ARRAY[ARRAY['${shop.id}']]::uuid[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(
        /webhook_endpoints_message_api_key_ids/,
      );
    }
    // …and any list from an endpoint taking received messages only.
    await change({ eventTypes: ['message.received'] });
    await expect(setInDatabase(`ARRAY['${shop.id}']::uuid[]`)).rejects.toThrow(
      /webhook_endpoints_message_api_key_ids/,
    );
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'message_api_key_ids',
                'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });

  it('sends an endpoint that names API keys the statuses of the messages they sent, across a rotation either way, and of no message sent otherwise', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const from = waId();
    const msg = await inbound(c, from, 'Hi');
    const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
    const desk = await keys.create(owner, {
      name: 'Helpdesk',
      scopes: ['messages.reply'],
      expiresInDays: 0,
    });
    const bot = await keys.create(owner, {
      name: 'Bot',
      scopes: ['messages.reply'],
      expiresInDays: 0,
    });
    const add = async (messageApiKeyIds: string[] | null) =>
      (
        await webhooks().create(owner, {
          url: `http://${HOST}:${port}/ok/${randomBytes(6).toString('hex')}`,
          eventTypes: ['message.status'],
          messageApiKeyIds,
        })
      ).id;
    const every = await add(null);
    const byDesk = await add([desk.id]);
    const byBot = await add([bot.id]);
    // The helpdesk's key is rotated: the old key works for a day more. An endpoint names the new
    // one.
    const rotated = await keys.rotate(owner, { keyId: desk.id, overlapHours: 24 });
    const byRotated = await add([rotated.id]);
    const deps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock };
    /** A text reply sent through the API with this token's key, accepted by the stand-in. */
    const reply = async (token: string, text: string) => {
      const key = await authenticateApiToken(fx.dbs.app, token, uuidv7());
      if (!key) throw new Error('a key does not authenticate');
      const sent = await apiSendMessage(
        deps,
        key,
        { type: 'text', to: `+${from}`, text },
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
      if (!intent) throw new Error('no send intent');
      const result = await processSendIntent(
        {
          ...deps,
          keyring: fx.keyring,
          graph: fx.graph,
          rate: { capacity: 100, refillPerSecond: 100 },
        },
        authorizedTenantScope(c.tenant.id, null),
        intent.id,
      );
      expect(result.outcome).toBe('accepted');
      return messageId;
    };
    const byOldKey = await reply(desk.token, 'From the old key.');
    const byNewKey = await reply(rotated.token, 'From the new key.');
    const byOtherKey = await reply(bot.token, 'From the bot.');
    // A member's reply belongs to no key.
    await sendReply(c, msg.conversation_id, 'A member replies.');
    const [memberReply] = await fx.query<{ id: string }>(
      `SELECT id FROM app.messages WHERE conversation_id = $1 AND sender_type = 'agent'`,
      [msg.conversation_id],
    );
    if (!memberReply) throw new Error('no member reply');

    const sent = await fx.query<{
      message: string;
      endpoint: string;
      detail: Record<string, unknown>;
    }>(
      `SELECT e.message_id AS message, d.endpoint_id AS endpoint, e.detail
         FROM app.webhook_deliveries d
         JOIN app.webhook_events e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
        WHERE d.tenant_id = $1 AND e.type = 'message.status'`,
      [c.tenant.id],
    );
    const endpointName = new Map([
      [every, 'every message'],
      [byDesk, 'old key'],
      [byBot, 'bot key'],
      [byRotated, 'new key'],
    ]);
    const messageName = new Map([
      [byOldKey, 'old key'],
      [byNewKey, 'new key'],
      [byOtherKey, 'bot'],
      [memberReply.id, 'member'],
    ]);
    const sorted = (rows: unknown[][]) =>
      [...rows].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    expect(
      sorted(sent.map((s) => [messageName.get(s.message), endpointName.get(s.endpoint)])),
    ).toEqual(
      sorted([
        // The old key's message reaches the list naming the key it was rotated into…
        ['old key', 'every message'],
        ['old key', 'old key'],
        ['old key', 'new key'],
        // …and the new key's the list naming the key it replaced.
        ['new key', 'every message'],
        ['new key', 'old key'],
        ['new key', 'new key'],
        ['bot', 'every message'],
        ['bot', 'bot key'],
        ['member', 'every message'],
      ]),
    );
    // The key travels for the filter only: the payload reads it from the message.
    expect(sent.filter((s) => 'apiKeyId' in s.detail)).toEqual([]);
  });
});

describe('API keys left out of deal, task and note events (ADR-321)', () => {
  it('are refused without a deal, task or note event, or naming keys that are not the company’s or cannot change them, kept by a change that leaves them out and cleared with the events; the database keeps them to those events', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
    const deals = await keys.create(owner, {
      name: 'Deals',
      scopes: ['deals.write'],
      expiresInDays: 0,
    });
    const notes = await keys.create(owner, {
      name: 'Notes',
      scopes: ['contacts.read', 'notes.write'],
      expiresInDays: 30,
    });
    const sender = await keys.create(owner, {
      name: 'Sender',
      scopes: ['messages.send'],
      expiresInDays: 0,
    });
    const other = await fx.company();
    const theirs = await keys.create(await fx.ctx(other, other.owner), {
      name: 'Theirs',
      scopes: ['deals.write'],
      expiresInDays: 0,
    });
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], crmExcludedApiKeyIds: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, crmExcludedApiKeyIds }),
        'validation_failed',
        message,
      );
    const needsTheEvents = /only for an endpoint that receives deal, task or note events/;
    const notTheirs = /API keys of this company that can change deals, tasks or notes/;
    await refused(['contact.updated', 'message.status'], [deals.id], needsTheEvents);
    await refused(['deal.updated'], [], /at least one API key/);
    await refused(['deal.updated'], [deals.keyPrefix], /from the list/);
    await refused(['task.created'], [deals.id, sender.id], notTheirs);
    await refused(['note.created'], [theirs.id], notTheirs);
    expect(await webhooks().list(owner)).toEqual([]);
    // Settings offers the keys that can change deals, tasks or notes and work, by name.
    expect(await webhooks().crmApiKeyChoices(owner)).toEqual([
      { id: deals.id, name: 'Deals', keyPrefix: deals.keyPrefix },
      { id: notes.id, name: 'Notes', keyPrefix: notes.keyPrefix },
    ]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['deal.updated', 'consent.changed'],
      crmExcludedApiKeyIds: [deals.id, notes.id, deals.id.toUpperCase()],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ crmExcludedApiKeyIds: [deals.id, notes.id] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['deal.updated', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.crmExcludedApiKeys;
    const named = (key: { id: string; keyPrefix: string }, name: string, state: string) => ({
      id: key.id,
      name,
      keyPrefix: key.keyPrefix,
      state,
    });
    expect(await current()).toEqual([
      named(deals, 'Deals', 'active'),
      named(notes, 'Notes', 'active'),
    ]);
    await change({ description: 'kept' });
    expect((await current())?.map((k) => k.id)).toEqual([deals.id, notes.id]);
    // A key revoked since stays named, and allowed.
    await keys.revoke(owner, { keyId: notes.id });
    expect(await current()).toEqual([
      named(deals, 'Deals', 'active'),
      named(notes, 'Notes', 'revoked'),
    ]);
    await change({ crmExcludedApiKeyIds: [notes.id] });
    const updates = await fx.query<{ metadata: { crmExcludedApiKeyIds?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.crmExcludedApiKeyIds)).toEqual([
      [deals.id, notes.id],
      [notes.id],
    ]);
    await change({ crmExcludedApiKeyIds: null });
    expect(await current()).toBeNull();
    await change({ crmExcludedApiKeyIds: [deals.id] });
    // Any deal, task or note event keeps the list.
    await change({ eventTypes: ['note.created'] });
    expect((await current())?.map((k) => k.id)).toEqual([deals.id]);
    // The database refuses an empty list, more than 20 keys, a missing one or a list of lists from
    // an endpoint taking such an event…
    const setInDatabase = (value: string) =>
      fx.query(
        `UPDATE app.webhook_endpoints SET crm_excluded_api_key_ids = ${value} WHERE id = $1`,
        [created.id],
      );
    const many = Array.from({ length: 21 }, () => `'${uuidv7()}'`).join(', ');
    for (const bad of [
      `'{}'`,
      `ARRAY[${many}]::uuid[]`,
      `ARRAY['${deals.id}', NULL]::uuid[]`,
      `ARRAY[ARRAY['${deals.id}']]::uuid[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(
        /webhook_endpoints_crm_excluded_api_key_ids/,
      );
    }
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['consent.changed'], crmExcludedApiKeyIds: [deals.id] }),
      'validation_failed',
      needsTheEvents,
    );
    // …and any list from an endpoint taking none.
    await expect(setInDatabase(`ARRAY['${deals.id}']::uuid[]`)).rejects.toThrow(
      /webhook_endpoints_crm_excluded_api_key_ids/,
    );
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'crm_excluded_api_key_ids',
                'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
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
      /only for an endpoint that receives Automation started, Automation ended or Automation step/,
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
      /only for an endpoint that receives Automation started, Automation ended or Automation step/,
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

describe('team filters (ADR-174)', () => {
  /** A team of the company, written as the teams settings write one. */
  async function teamOf(c: Company, name: string) {
    const id = uuidv7();
    await fx.query('INSERT INTO app.teams (id, tenant_id, name) VALUES ($1, $2, $3)', [
      id,
      c.tenant.id,
      name,
    ]);
    return id;
  }
  /** Moves a conversation to a team (or out of every team), as the inbox does. */
  const moveTo = (conversationId: string, teamId: string | null) =>
    fx.query('UPDATE app.conversations SET team_id = $2 WHERE id = $1', [conversationId, teamId]);

  it("are refused without an event of a conversation, empty, over 50 or naming another company's team; kept by a change that leaves them out, a deleted team included, and cleared with the events; the database keeps them to those events", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const support = await teamOf(c, 'Support');
    const sales = await teamOf(c, 'Sales');
    const elsewhere = await teamOf(await fx.company(), 'Support');
    const url = 'https://hooks.example.com/in';
    const refused = async (
      eventTypes: string[],
      teamIds: unknown,
      message: RegExp,
      path = 'teamIds',
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, teamIds }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(teamIds)).toBe(path);
    };
    const needsTheEvents = /only for an endpoint that receives message or conversation events/;
    await refused(
      ['consent.changed', 'order.received', 'automation.run_started', 'campaign.status_changed'],
      [support],
      needsTheEvents,
    );
    await refused(['message.received'], [], /at least one team/);
    await refused(['message.received'], ['support'], /from the list/, 'teamIds.0');
    await refused(
      ['message.received'],
      Array.from({ length: 51 }, () => uuidv7()),
      /at most 50/,
    );
    // Only the company's teams: not another company's or an unknown id.
    await refused(['message.status'], [support, elsewhere], /of this company/, 'teamIds.1');
    await refused(['conversation.team_changed'], [uuidv7()], /of this company/, 'teamIds.0');
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['message.received', 'consent.changed'],
      teamIds: [sales, support.toUpperCase(), sales],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { teamIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
          [c.tenant.id, action],
        )
      ).map((a) => a.metadata.teamIds);
    expect(await audits('webhook.endpoint_created')).toEqual([[sales, support]]);
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['message.received', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.teams;
    expect(await current()).toEqual([
      { id: sales, name: 'Sales' },
      { id: support, name: 'Support' },
    ]);
    await change({ description: 'kept' });
    expect((await current())?.map((t) => t.id)).toEqual([sales, support]);
    // A team deleted since it was chosen stays on the list, unnamed, and a list given again may
    // keep it; a deleted team the list did not hold is refused like any unknown one.
    await fx.query('DELETE FROM app.teams WHERE id = $1', [sales]);
    expect(await current()).toEqual([
      { id: sales, name: null },
      { id: support, name: 'Support' },
    ]);
    await change({ teamIds: [support, sales] });
    expect((await current())?.map((t) => t.id)).toEqual([support, sales]);
    const gone = await teamOf(c, 'Gone');
    await fx.query('DELETE FROM app.teams WHERE id = $1', [gone]);
    await expectAppError(
      change({ teamIds: [support, gone] }),
      'validation_failed',
      /of this company/,
    );
    expect(await audits('webhook.endpoint_updated')).toEqual([
      [sales, support],
      [support, sales],
    ]);
    await change({ teamIds: null });
    expect(await current()).toBeNull();
    await change({ teamIds: [support] });
    // Any event of a conversation keeps the list.
    await change({ eventTypes: ['conversation.status_changed', 'order.received'] });
    expect((await current())?.map((t) => t.id)).toEqual([support]);
    // The database refuses an empty list, more than 50 or a missing id from an endpoint taking
    // such an event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET team_ids = ${value} WHERE id = $1`, [created.id]);
    const many = `ARRAY[${Array.from({ length: 51 }, () => `'${uuidv7()}'`).join(',')}]::uuid[]`;
    for (const bad of [`'{}'`, many, `ARRAY['${support}', NULL]::uuid[]`]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_team_ids/);
    }
    await change({ eventTypes: ['order.received', 'consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['order.received'], teamIds: [support] }),
      'validation_failed',
      needsTheEvents,
    );
    // …and any list for an endpoint that takes none.
    await expect(setInDatabase(`ARRAY['${support}']::uuid[]`)).rejects.toThrow(
      /webhook_endpoints_team_ids/,
    );
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'team_ids', 'UPDATE')
                AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });

  it("offer the company's teams by name, to developers only", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const support = await teamOf(c, 'Support');
    const billing = await teamOf(c, 'Billing');
    await teamOf(await fx.company(), 'Elsewhere');
    expect(await webhooks().teamChoices(owner)).toEqual([
      { id: billing, name: 'Billing' },
      { id: support, name: 'Support' },
    ]);
    for (const user of [c.agent, c.marketer]) {
      await expectAppError(webhooks().teamChoices(await fx.ctx(c, user)), 'forbidden');
    }
  });

  it("send an endpoint that names teams only its conversations' events, a change of team to the team left and joined, events of no conversation to both, and capture none nobody takes", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const support = await teamOf(c, 'Support');
    const sales = await teamOf(c, 'Sales');
    const add = async (eventTypes: WebhookEventType[], teamIds: string[] | null) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes,
        teamIds,
      });
      return { ...created, path };
    };
    const supportOnly = await add(
      ['message.received', 'message.status', 'conversation.team_changed', 'consent.changed'],
      [support],
    );
    const from = waId();
    // A message in a conversation of no team: no endpoint takes it, so nothing is captured.
    const first = await inbound(c, from, 'Hello');
    expect(await eventsOf(c)).toEqual([]);
    // The conversation joins Support: the change and the next message are captured, stored as
    // events always were.
    await moveTo(first.conversation_id, support);
    await inbound(c, from, 'Still there?');
    await sendReply(c, first.conversation_id, 'Support here');
    expect((await eventsOf(c)).map((e) => [e.type, e.status, e.detail])).toEqual([
      ['conversation.team_changed', null, { teamId: support, previousTeamId: null }],
      ['message.received', null, { messageType: 'text' }],
      ['message.status', 'accepted', {}],
    ]);
    // It moves to Sales: the change reaches Support, which it left; its next message does not.
    await moveTo(first.conversation_id, sales);
    await inbound(c, from, 'Thanks, Sales');
    // A consent change belongs to no conversation: the endpoint takes it.
    await createConsentService({ db: fx.dbs.app, clock: systemClock }).recordConsent(owner, {
      contactId: first.contact_id,
      purpose: 'marketing',
      action: 'opt_in',
    });
    // An endpoint for every conversation's messages hears every team's, and those of no team.
    const everyTeam = await add(['message.received'], null);
    await inbound(c, from, 'Sales again');
    await moveTo(first.conversation_id, null);
    await inbound(c, from, 'Nobody now');
    const typesTo = async (endpointId: string) =>
      (await deliveriesOf(endpointId)).map((d) => [d.type, d.status]);
    expect(await typesTo(supportOnly.id)).toEqual([
      ['conversation.team_changed', null],
      ['message.received', null],
      ['message.status', 'accepted'],
      ['conversation.team_changed', null],
      ['consent.changed', null],
    ]);
    expect(await typesTo(everyTeam.id)).toEqual([
      ['message.received', null],
      ['message.received', null],
    ]);
    // Each delivery names its conversation; the team changes name the teams.
    expect(await deliverDue(c)).toMatchObject({ attempted: 7, succeeded: 7 });
    const changes = requestsTo(supportOnly.path)
      .map((r) => JSON.parse(r.body) as { type: string; data: Record<string, unknown> })
      .filter((b) => b.type === 'conversation.team_changed')
      .map((b) => b.data.conversation);
    expect(changes).toHaveLength(2);
    for (const body of requestsTo(supportOnly.path).map(
      (r) => JSON.parse(r.body) as { type: string; data: { conversation?: { id: string } } },
    )) {
      if (body.type !== 'consent.changed') {
        expect(body.data.conversation?.id, body.type).toBe(first.conversation_id);
      }
    }
  });
});

describe('template filters (ADR-175)', () => {
  /** A template of the company's WhatsApp account, written as the templates service keeps one. */
  async function templateOf(c: Company, name: string, language = 'en') {
    const id = uuidv7();
    await fx.query(
      `INSERT INTO app.message_templates (id, tenant_id, whatsapp_account_id, name, language,
         category, components, status)
       VALUES ($1, $2, $3, $4, $5, 'UTILITY', '[]'::jsonb, 'approved')`,
      [id, c.tenant.id, c.whatsappAccountId, `${name}_${randomBytes(3).toString('hex')}`, language],
    );
    const [row] = await fx.query<{ name: string }>(
      'SELECT name FROM app.message_templates WHERE id = $1',
      [id],
    );
    return { id, name: row!.name, language };
  }
  /** Meta's report of a template's status, recorded as a sync records it. */
  const reported = (c: Company, templateId: string, status: string) =>
    fx.query(
      `INSERT INTO app.template_status_events (id, tenant_id, template_id, status, source)
       VALUES ($1, $2, $3, $4, 'sync')`,
      [uuidv7(), c.tenant.id, templateId, status],
    );

  it("are refused without message.status or template.status_changed, empty, over 50 or naming another company's template; kept by a change that leaves them out and cleared with the events; the database keeps them to those events", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const orders = await templateOf(c, 'order_update', 'en_US');
    const otp = await templateOf(c, 'login_code');
    const elsewhere = await templateOf(await fx.company(), 'order_update');
    const url = 'https://hooks.example.com/in';
    const refused = async (
      eventTypes: string[],
      templateIds: unknown,
      message: RegExp,
      path = 'templateIds',
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, templateIds }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(templateIds)).toBe(path);
    };
    const needsTheEvents = /only for an endpoint that receives Message status or Template status/;
    await refused(['message.received', 'campaign.status_changed'], [orders.id], needsTheEvents);
    await refused(['message.status'], [], /at least one template/);
    await refused(['message.status'], ['order_update'], /from the list/, 'templateIds.0');
    await refused(
      ['message.status'],
      Array.from({ length: 51 }, () => uuidv7()),
      /at most 50/,
    );
    await refused(
      ['template.status_changed'],
      [orders.id, elsewhere.id],
      /of this company/,
      'templateIds.1',
    );
    await refused(['message.status'], [uuidv7()], /of this company/, 'templateIds.0');
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['message.status', 'consent.changed'],
      templateIds: [otp.id, orders.id.toUpperCase(), otp.id],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { templateIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
          [c.tenant.id, action],
        )
      ).map((a) => a.metadata.templateIds);
    expect(await audits('webhook.endpoint_created')).toEqual([[otp.id, orders.id]]);
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['message.status', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.templates;
    expect(await current()).toEqual([
      { id: otp.id, name: otp.name, language: 'en' },
      { id: orders.id, name: orders.name, language: 'en_US' },
    ]);
    await change({ description: 'kept' });
    expect((await current())?.map((t) => t.id)).toEqual([otp.id, orders.id]);
    await change({ templateIds: [orders.id] });
    expect(await audits('webhook.endpoint_updated')).toEqual([[otp.id, orders.id], [orders.id]]);
    // A list given again is checked again, changing nothing when it is refused.
    await expectAppError(
      change({ templateIds: [orders.id, elsewhere.id] }),
      'validation_failed',
      /of this company/,
    );
    expect((await current())?.map((t) => t.id)).toEqual([orders.id]);
    await change({ templateIds: null });
    expect(await current()).toBeNull();
    await change({ templateIds: [otp.id] });
    // Either event of a template keeps the list.
    await change({ eventTypes: ['template.status_changed', 'contact.created'] });
    expect((await current())?.map((t) => t.id)).toEqual([otp.id]);
    // The database refuses an empty list, more than 50 or a missing id from an endpoint taking
    // such an event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET template_ids = ${value} WHERE id = $1`, [
        created.id,
      ]);
    const many = `ARRAY[${Array.from({ length: 51 }, () => `'${uuidv7()}'`).join(',')}]::uuid[]`;
    for (const bad of [`'{}'`, many, `ARRAY['${otp.id}', NULL]::uuid[]`]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_template_ids/);
    }
    await change({ eventTypes: ['message.received', 'consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['message.received'], templateIds: [otp.id] }),
      'validation_failed',
      needsTheEvents,
    );
    // …and any list for an endpoint that takes neither.
    await expect(setInDatabase(`ARRAY['${otp.id}']::uuid[]`)).rejects.toThrow(
      /webhook_endpoints_template_ids/,
    );
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'template_ids', 'UPDATE')
                AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });

  it("offer the company's templates by name and language, whatever their status, to developers only", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const b = await templateOf(c, 'b_template');
    const a = await templateOf(c, 'a_template', 'hi');
    await fx.query(`UPDATE app.message_templates SET status = 'deleted' WHERE id = $1`, [a.id]);
    await templateOf(await fx.company(), 'a_template');
    expect(await webhooks().templateChoices(owner)).toEqual([
      { id: a.id, name: a.name, language: 'hi' },
      { id: b.id, name: b.name, language: 'en' },
    ]);
    for (const user of [c.agent, c.marketer]) {
      await expectAppError(webhooks().templateChoices(await fx.ctx(c, user)), 'forbidden');
    }
  });

  it("send an endpoint that names templates only their messages' statuses and their changes, another every template's, other events to both, and capture none nobody takes", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const orders = await templateOf(c, 'order_update');
    const promo = await templateOf(c, 'weekly_offer');
    const add = async (eventTypes: WebhookEventType[], templateIds: string[] | null) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes,
        templateIds,
      });
      return { ...created, path };
    };
    const ordersOnly = await add(
      ['message.status', 'template.status_changed', 'message.received'],
      [orders.id],
    );
    const from = waId();
    const first = await inbound(c, from, 'Where is my order?');
    // A member's reply has no template: its status is not captured.
    const reply = await sendReply(c, first.conversation_id, 'Let me check.');
    const typesOf = async () => (await eventsOf(c)).map((e) => [e.type, e.status]);
    expect(await typesOf()).toEqual([['message.received', null]]);
    /** A message of a template reaching a status, as a template send's status updates do. */
    const statusOf = async (messageId: string, templateId: string, status: string) => {
      await fx.query('UPDATE app.messages SET template_id = $2 WHERE id = $1', [
        messageId,
        templateId,
      ]);
      await fx.query('UPDATE app.messages SET status = $2 WHERE id = $1', [messageId, status]);
    };
    await statusOf(reply.messageId, orders.id, 'delivered');
    const second = await sendReply(c, first.conversation_id, 'Here is an offer.');
    await statusOf(second.messageId, promo.id, 'delivered');
    // Template changes: the order update's is captured, the offer's is not.
    await reported(c, orders.id, 'paused');
    await reported(c, promo.id, 'paused');
    expect(await typesOf()).toEqual([
      ['message.received', null],
      ['message.status', 'delivered'],
      ['template.status_changed', 'paused'],
    ]);
    // An endpoint for every template hears both from now on.
    const every = await add(['message.status', 'template.status_changed'], null);
    await reported(c, orders.id, 'approved');
    await reported(c, promo.id, 'approved');
    const typesTo = async (endpointId: string) =>
      (await deliveriesOf(endpointId)).map((d) => [d.type, d.status]);
    expect(await typesTo(ordersOnly.id)).toEqual([
      ['message.received', null],
      ['message.status', 'delivered'],
      ['template.status_changed', 'paused'],
      ['template.status_changed', 'approved'],
    ]);
    expect(await typesTo(every.id)).toEqual([
      ['template.status_changed', 'approved'],
      ['template.status_changed', 'approved'],
    ]);
    // Each delivery names the template.
    expect(await deliverDue(c)).toMatchObject({ attempted: 6, succeeded: 6 });
    const templatesAt = (path: string) =>
      requestsTo(path)
        .map((r) => JSON.parse(r.body) as { type: string; data: Record<string, unknown> })
        .filter((b) => b.type !== 'message.received')
        .map((b) =>
          b.type === 'message.status'
            ? (b.data.message as { templateId: string }).templateId
            : (b.data.template as { id: string }).id,
        )
        .sort();
    expect(templatesAt(ordersOnly.path)).toEqual([orders.id, orders.id, orders.id]);
    expect(templatesAt(every.path)).toEqual([orders.id, promo.id].sort());
  });
});

describe('assignee filters (ADR-181)', () => {
  /** Assigns a conversation to a member (or to nobody), as the inbox and routing do. */
  const assign = (conversationId: string, membershipId: string | null) =>
    fx.query('UPDATE app.conversations SET assigned_membership_id = $2 WHERE id = $1', [
      conversationId,
      membershipId,
    ]);
  const setMember = (membershipId: string, change: string) =>
    fx.query(`UPDATE app.memberships SET ${change} WHERE id = $1`, [membershipId]);

  it('are refused without an event of a conversation, empty, over 50 or naming a member who takes no conversations; kept by a change that leaves them out, a member who stopped included, and cleared with the events; the database keeps them to those events', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = (await fx.ctx(c, c.agent)).membership.id;
    const ownerId = owner.membership.id;
    // A marketer answers no conversations, and another company's member is not this one's.
    const marketer = (await fx.ctx(c, c.marketer)).membership.id;
    const other = await fx.company();
    const elsewhere = (await fx.ctx(other, other.agent)).membership.id;
    const url = 'https://hooks.example.com/in';
    const refused = async (
      eventTypes: string[],
      assigneeIds: unknown,
      message: RegExp,
      path = 'assigneeIds',
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, assigneeIds }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(assigneeIds)).toBe(path);
    };
    const needsTheEvents =
      /Choose members only for an endpoint that receives message or conversation events/;
    await refused(
      ['consent.changed', 'order.received', 'automation.run_started', 'template.status_changed'],
      [agent],
      needsTheEvents,
    );
    await refused(['message.received'], [], /at least one member/);
    await refused(['message.received'], ['agent'], /from the list/, 'assigneeIds.0');
    await refused(
      ['message.received'],
      Array.from({ length: 51 }, () => uuidv7()),
      /at most 50/,
    );
    const takesNone = /members of this company who take conversations/;
    await refused(['message.status'], [agent, marketer], takesNone, 'assigneeIds.1');
    await refused(['message.status'], [agent, elsewhere], takesNone, 'assigneeIds.1');
    await refused(['conversation.assignment_changed'], [uuidv7()], takesNone, 'assigneeIds.0');
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['message.received', 'consent.changed'],
      assigneeIds: [agent, ownerId.toUpperCase(), agent],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { assigneeIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
          [c.tenant.id, action],
        )
      ).map((a) => a.metadata.assigneeIds);
    expect(await audits('webhook.endpoint_created')).toEqual([[agent, ownerId]]);
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['message.received', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.assignees;
    expect(await current()).toEqual([
      { id: agent, name: 'Agent', assignable: true },
      { id: ownerId, name: 'Owner', assignable: true },
    ]);
    await change({ description: 'kept' });
    expect((await current())?.map((m) => m.id)).toEqual([agent, ownerId]);
    await change({ assigneeIds: [ownerId] });
    // A suspended member is refused when a list adds them, and accepted once reinstated.
    await setMember(agent, `status = 'suspended'`);
    await expectAppError(change({ assigneeIds: [ownerId, agent] }), 'validation_failed', takesNone);
    expect((await current())?.map((m) => m.id)).toEqual([ownerId]);
    await setMember(agent, `status = 'active'`);
    await change({ assigneeIds: [ownerId, agent] });
    // A member who stops taking conversations stays on the list, and a list given again may keep
    // them.
    await setMember(agent, `roles = '{marketer}'`);
    expect(await current()).toEqual([
      { id: ownerId, name: 'Owner', assignable: true },
      { id: agent, name: 'Agent', assignable: false },
    ]);
    await change({ assigneeIds: [agent, ownerId] });
    expect((await current())?.map((m) => m.id)).toEqual([agent, ownerId]);
    expect(await audits('webhook.endpoint_updated')).toEqual([
      [agent, ownerId],
      [ownerId],
      [ownerId, agent],
      [agent, ownerId],
    ]);
    await change({ assigneeIds: null });
    expect(await current()).toBeNull();
    await change({ assigneeIds: [ownerId] });
    // Any event of a conversation keeps the list.
    await change({ eventTypes: ['conversation.team_changed', 'order.received'] });
    expect((await current())?.map((m) => m.id)).toEqual([ownerId]);
    // The database refuses an empty list, more than 50 or a missing id from an endpoint taking
    // such an event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET assignee_ids = ${value} WHERE id = $1`, [
        created.id,
      ]);
    const many = `ARRAY[${Array.from({ length: 51 }, () => `'${uuidv7()}'`).join(',')}]::uuid[]`;
    for (const bad of [`'{}'`, many, `ARRAY['${ownerId}', NULL]::uuid[]`]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_assignee_ids/);
    }
    await change({ eventTypes: ['order.received', 'consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['order.received'], assigneeIds: [ownerId] }),
      'validation_failed',
      needsTheEvents,
    );
    // …and any list for an endpoint that takes none.
    await expect(setInDatabase(`ARRAY['${ownerId}']::uuid[]`)).rejects.toThrow(
      /webhook_endpoints_assignee_ids/,
    );
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'assignee_ids', 'UPDATE')
                AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });

  it('offer the members conversations can be assigned to, by name, to developers only', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = (await fx.ctx(c, c.agent)).membership.id;
    await fx.company();
    // Not the marketer, who answers no conversations, nor another company's members.
    expect(await webhooks().assigneeChoices(owner)).toEqual([
      { id: agent, name: 'Agent' },
      { id: owner.membership.id, name: 'Owner' },
    ]);
    // Developers only: refused before the agent is suspended, whose company no longer resolves then.
    for (const user of [c.agent, c.marketer]) {
      await expectAppError(webhooks().assigneeChoices(await fx.ctx(c, user)), 'forbidden');
    }
    await setMember(agent, `status = 'suspended'`);
    expect(await webhooks().assigneeChoices(owner)).toEqual([
      { id: owner.membership.id, name: 'Owner' },
    ]);
  });

  it("send an endpoint that names members only their conversations' events, a change of assignee to the member left and given, events of no conversation to both, and capture none nobody takes", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = (await fx.ctx(c, c.agent)).membership.id;
    const ownerId = owner.membership.id;
    const add = async (
      eventTypes: WebhookEventType[],
      assigneeIds: string[] | null,
      teamIds: string[] | null = null,
    ) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes,
        assigneeIds,
        teamIds,
      });
      return { ...created, path };
    };
    const agentOnly = await add(
      ['message.received', 'message.status', 'conversation.assignment_changed', 'consent.changed'],
      [agent],
    );
    const from = waId();
    // A message in an unassigned conversation: no endpoint takes it, so nothing is captured.
    const first = await inbound(c, from, 'Hello');
    expect(await eventsOf(c)).toEqual([]);
    // Assigned to the agent: the change and the next messages are captured, stored as events
    // always were.
    await assign(first.conversation_id, agent);
    await inbound(c, from, 'Still there?');
    await sendReply(c, first.conversation_id, 'Agent here');
    expect((await eventsOf(c)).map((e) => [e.type, e.status, e.detail])).toEqual([
      [
        'conversation.assignment_changed',
        null,
        { assigned: true, assigneeId: agent, previousAssigneeId: null },
      ],
      ['message.received', null, { messageType: 'text' }],
      ['message.status', 'accepted', {}],
    ]);
    // Given to the owner: the change reaches the agent, whom it left; the next message does not.
    await assign(first.conversation_id, ownerId);
    await inbound(c, from, 'Thanks, Owner');
    // A consent change belongs to no conversation: the endpoint takes it.
    await createConsentService({ db: fx.dbs.app, clock: systemClock }).recordConsent(owner, {
      contactId: first.contact_id,
      purpose: 'marketing',
      action: 'opt_in',
    });
    // An endpoint for every conversation's messages hears every member's and unassigned ones; one
    // that names a team as well hears only the members' conversations in that team.
    const everyone = await add(['message.received'], null);
    const team = uuidv7();
    await fx.query('INSERT INTO app.teams (id, tenant_id, name) VALUES ($1, $2, $3)', [
      team,
      c.tenant.id,
      'Support',
    ]);
    const ownerInTeam = await add(['message.received'], [ownerId], [team]);
    await inbound(c, from, 'Owner again');
    await fx.query('UPDATE app.conversations SET team_id = $2 WHERE id = $1', [
      first.conversation_id,
      team,
    ]);
    await inbound(c, from, 'In Support');
    // Unassigned: the change left the owner, whom no endpoint of those events names.
    await assign(first.conversation_id, null);
    await inbound(c, from, 'Nobody now');
    const typesTo = async (endpointId: string) =>
      (await deliveriesOf(endpointId)).map((d) => [d.type, d.status]);
    expect(await typesTo(agentOnly.id)).toEqual([
      ['conversation.assignment_changed', null],
      ['message.received', null],
      ['message.status', 'accepted'],
      ['conversation.assignment_changed', null],
      ['consent.changed', null],
    ]);
    expect(await typesTo(everyone.id)).toEqual([
      ['message.received', null],
      ['message.received', null],
      ['message.received', null],
    ]);
    expect(await typesTo(ownerInTeam.id)).toEqual([['message.received', null]]);
    // The assignment changes name the members, as GET /members lists them.
    expect(await deliverDue(c)).toMatchObject({ attempted: 9, succeeded: 9 });
    const bodies = (path: string) =>
      requestsTo(path).map(
        (r) => JSON.parse(r.body) as { type: string; data: Record<string, unknown> },
      );
    expect(
      bodies(agentOnly.path)
        .filter((b) => b.type === 'conversation.assignment_changed')
        .map((b) => b.data.conversation),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assigneeId: agent, previousAssigneeId: null }),
        expect.objectContaining({ assigneeId: ownerId, previousAssigneeId: agent }),
      ]),
    );
    expect(
      bodies(ownerInTeam.path).map((b) => (b.data.message as { text?: string } | undefined)?.text),
    ).toEqual(['In Support']);
  });
});

describe('run trigger filters (ADR-183)', () => {
  it('are refused without a run event, unknown or empty, kept by a change that leaves them out and cleared with the events; the database keeps them to those events', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], runTriggers: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, runTriggers }),
        'validation_failed',
        message,
      );
    const needsTheEvents =
      /only for an endpoint that receives Automation started, Automation ended or Automation step/;
    await refused(['message.received', 'order.received'], ['api'], needsTheEvents);
    await refused(['automation.run_started'], [], /at least one way a run starts/);
    // Members' test runs send no events, so `test` is not a choice.
    await refused(['automation.run_started'], ['test'], /from the list/);
    await refused(['automation.run_ended'], ['webhook'], /from the list/);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['automation.run_started', 'consent.changed'],
      runTriggers: ['api', 'keyword', 'api'],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ runTriggers: ['keyword', 'api'] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['automation.run_started', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.runTriggers;
    expect(await current()).toEqual(['keyword', 'api']);
    await change({ description: 'kept' });
    expect(await current()).toEqual(['keyword', 'api']);
    await change({ runTriggers: ['store_event'] });
    expect(await current()).toEqual(['store_event']);
    const updates = await fx.query<{ metadata: { runTriggers?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.runTriggers)).toEqual([
      ['keyword', 'api'],
      ['store_event'],
    ]);
    await change({ runTriggers: null });
    expect(await current()).toBeNull();
    await change({ runTriggers: ['conversation_started'] });
    // Either run event keeps the list.
    await change({ eventTypes: ['automation.run_ended'] });
    expect(await current()).toEqual(['conversation_started']);
    // The database refuses an empty list, more than five entries, `test`, an unknown trigger or a
    // missing one from an endpoint taking a run event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET run_triggers = ${value} WHERE id = $1`, [
        created.id,
      ]);
    for (const bad of [
      `'{}'`,
      `'{keyword,conversation_started,any_message,store_event,api,api}'`,
      `'{api,test}'`,
      `'{api,webhook}'`,
      `ARRAY['api', NULL]::text[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_run_triggers/);
    }
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['consent.changed'], runTriggers: ['api'] }),
      'validation_failed',
      needsTheEvents,
    );
    // …and any list for an endpoint that takes neither.
    await expect(setInDatabase(`'{api}'`)).rejects.toThrow(/webhook_endpoints_run_triggers/);
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'run_triggers', 'UPDATE')
                AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });
});

describe('API key filters of run events (ADR-319)', () => {
  it('are refused without a run event, or naming keys that are not the company’s or cannot start automations, kept by a change that leaves them out and cleared with the events; the database keeps them to those events', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
    const store = await keys.create(owner, {
      name: 'Store',
      scopes: ['automations.start'],
      expiresInDays: 0,
    });
    const crm = await keys.create(owner, {
      name: 'CRM',
      scopes: ['contacts.read', 'automations.start'],
      expiresInDays: 30,
    });
    const reader = await keys.create(owner, {
      name: 'Reader',
      scopes: ['contacts.read'],
      expiresInDays: 0,
    });
    const other = await fx.company();
    const theirs = await keys.create(await fx.ctx(other, other.owner), {
      name: 'Theirs',
      scopes: ['automations.start'],
      expiresInDays: 0,
    });
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], runApiKeyIds: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, runApiKeyIds }),
        'validation_failed',
        message,
      );
    const needsTheEvents =
      /only for an endpoint that receives Automation started, Automation ended or Automation step/;
    const notTheirs = /API keys of this company that can start automations/;
    await refused(['message.received', 'order.received'], [store.id], needsTheEvents);
    await refused(['automation.run_started'], [], /at least one API key/);
    await refused(['automation.run_started'], [store.keyPrefix], /from the list/);
    await refused(['automation.run_started'], [store.id, reader.id], notTheirs);
    await refused(['automation.run_ended'], [theirs.id], notTheirs);
    expect(await webhooks().list(owner)).toEqual([]);
    // Settings offers the keys that can start automations and work, by name.
    expect(await webhooks().runApiKeyChoices(owner)).toEqual([
      { id: crm.id, name: 'CRM', keyPrefix: crm.keyPrefix },
      { id: store.id, name: 'Store', keyPrefix: store.keyPrefix },
    ]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['automation.run_started', 'consent.changed'],
      runApiKeyIds: [store.id, crm.id, store.id.toUpperCase()],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ runApiKeyIds: [store.id, crm.id] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['automation.run_started', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.runApiKeys;
    const named = (key: { id: string; keyPrefix: string }, name: string, state: string) => ({
      id: key.id,
      name,
      keyPrefix: key.keyPrefix,
      state,
    });
    expect(await current()).toEqual([named(store, 'Store', 'active'), named(crm, 'CRM', 'active')]);
    await change({ description: 'kept' });
    expect((await current())?.map((k) => k.id)).toEqual([store.id, crm.id]);
    // A rotated key is offered no more: the key that replaced it is, under the same name. A key
    // revoked since stays named, and allowed: the runs it started still end.
    const rotated = await keys.rotate(owner, { keyId: store.id, overlapHours: 24 });
    await keys.revoke(owner, { keyId: crm.id });
    expect(await webhooks().runApiKeyChoices(owner)).toEqual([
      { id: rotated.id, name: 'Store', keyPrefix: rotated.keyPrefix },
    ]);
    expect(await current()).toEqual([
      named(store, 'Store', 'active'),
      named(crm, 'CRM', 'revoked'),
    ]);
    await change({ runApiKeyIds: [crm.id, rotated.id] });
    expect((await current())?.map((k) => k.id)).toEqual([crm.id, rotated.id]);
    const updates = await fx.query<{ metadata: { runApiKeyIds?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.runApiKeyIds)).toEqual([
      [store.id, crm.id],
      [crm.id, rotated.id],
    ]);
    await change({ runApiKeyIds: null });
    expect(await current()).toBeNull();
    await change({ runApiKeyIds: [store.id] });
    // Either run event keeps the list.
    await change({ eventTypes: ['automation.run_ended'] });
    expect((await current())?.map((k) => k.id)).toEqual([store.id]);
    // The database refuses an empty list, more than 20 keys, a missing one or a list of lists
    // from an endpoint taking a run event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET run_api_key_ids = ${value} WHERE id = $1`, [
        created.id,
      ]);
    const many = Array.from({ length: 21 }, () => `'${uuidv7()}'`).join(', ');
    for (const bad of [
      `'{}'`,
      `ARRAY[${many}]::uuid[]`,
      `ARRAY['${store.id}', NULL]::uuid[]`,
      `ARRAY[ARRAY['${store.id}']]::uuid[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_run_api_key_ids/);
    }
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['consent.changed'], runApiKeyIds: [store.id] }),
      'validation_failed',
      needsTheEvents,
    );
    // …and any list for an endpoint that takes neither.
    await expect(setInDatabase(`ARRAY['${store.id}']::uuid[]`)).rejects.toThrow(
      /webhook_endpoints_run_api_key_ids/,
    );
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'run_api_key_ids', 'UPDATE')
                AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });
});

describe('custom field filters (ADR-184)', () => {
  /** A custom field of the company, written as the contacts settings write one. */
  async function fieldOf(c: Company, key: string, label: string) {
    await fx.query(
      `INSERT INTO app.contact_fields (id, tenant_id, key, label, type) VALUES ($1, $2, $3, $4, 'text')`,
      [uuidv7(), c.tenant.id, key, label],
    );
    return key;
  }

  it("are refused without field changes, empty, over 50 or naming another company's field; kept by a change that leaves them out, a deleted field included, and cleared with the parts; the database keeps them to field changes", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const city = await fieldOf(c, 'city', 'City');
    const tier = await fieldOf(c, 'tier', 'Tier');
    await fieldOf(await fx.company(), 'zone', 'Zone');
    const url = 'https://hooks.example.com/in';
    const refused = async (
      fields: Record<string, unknown>,
      message: RegExp,
      path = 'contactFieldKeys',
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes: ['contact.updated'], ...fields }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(fields)).toBe(path);
    };
    const needsThePart =
      /only for an endpoint that receives Contact changed with custom field values/;
    await refused({ eventTypes: ['contact.created'], contactFieldKeys: [city] }, needsThePart);
    await refused({ contactParts: ['email', 'tags'], contactFieldKeys: [city] }, needsThePart);
    await refused({ contactFieldKeys: [] }, /at least one field/);
    await refused({ contactFieldKeys: ['City'] }, /from the list/, 'contactFieldKeys.0');
    await refused(
      { contactFieldKeys: Array.from({ length: 51 }, (_, i) => `f${i}`) },
      /at most 50/,
    );
    // Only the company's fields: not another company's or an unknown key.
    await refused({ contactFieldKeys: [city, 'zone'] }, /of this company/, 'contactFieldKeys.1');
    await refused({ contactFieldKeys: ['plan'] }, /of this company/, 'contactFieldKeys.0');
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['contact.updated', 'consent.changed'],
      contactParts: ['email', 'fields'],
      contactFieldKeys: [tier, city, tier],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { contactFieldKeys?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
          [c.tenant.id, action],
        )
      ).map((a) => a.metadata.contactFieldKeys);
    expect(await audits('webhook.endpoint_created')).toEqual([[tier, city]]);
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['contact.updated', 'consent.changed'],
        contactParts: ['email', 'fields'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.contactFields;
    expect(await current()).toEqual([
      { key: tier, label: 'Tier' },
      { key: city, label: 'City' },
    ]);
    await change({ description: 'kept' });
    expect((await current())?.map((f) => f.key)).toEqual([tier, city]);
    // A field deleted since it was chosen stays on the list, unlabelled, and a list given again may
    // keep it; a deleted field the list did not hold is refused like any unknown one.
    await fx.query('DELETE FROM app.contact_fields WHERE tenant_id = $1 AND key = $2', [
      c.tenant.id,
      tier,
    ]);
    expect(await current()).toEqual([
      { key: tier, label: null },
      { key: city, label: 'City' },
    ]);
    await change({ contactFieldKeys: [city, tier] });
    expect((await current())?.map((f) => f.key)).toEqual([city, tier]);
    await change({ contactFieldKeys: [city] });
    await expectAppError(
      change({ contactFieldKeys: [city, tier] }),
      'validation_failed',
      /of this company/,
    );
    expect(await audits('webhook.endpoint_updated')).toEqual([[tier, city], [city, tier], [city]]);
    // Every part takes field changes too; parts without fields clear the list, and fields given
    // with them are refused.
    await change({ contactParts: null });
    expect((await current())?.map((f) => f.key)).toEqual([city]);
    await change({ contactParts: ['name'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ contactParts: ['name'], contactFieldKeys: [city] }),
      'validation_failed',
      needsThePart,
    );
    await change({ contactFieldKeys: [city] });
    // The database refuses an empty list, more than 50, a malformed key or a missing one…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET contact_field_keys = ${value} WHERE id = $1`, [
        created.id,
      ]);
    const many = `ARRAY[${Array.from({ length: 51 }, (_, i) => `'f${i}'`).join(',')}]::text[]`;
    for (const bad of [
      `'{}'`,
      many,
      `'{City}'`,
      `'{fields.city}'`,
      `ARRAY['city', NULL]::text[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_contact_field_keys/);
    }
    // …and any list for an endpoint whose parts take no field changes, or without contact.updated.
    await expect(
      fx.query(`UPDATE app.webhook_endpoints SET contact_parts = '{name}' WHERE id = $1`, [
        created.id,
      ]),
    ).rejects.toThrow(/webhook_endpoints_contact_field_keys/);
    await change({ eventTypes: ['consent.changed'], contactParts: null });
    expect(await current()).toBeNull();
    await expect(setInDatabase(`'{city}'`)).rejects.toThrow(/webhook_endpoints_contact_field_keys/);
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'contact_field_keys',
                'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });

  it("offer the company's custom fields by label with their types, to developers only", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await fieldOf(c, 'tier', 'Tier');
    await fieldOf(c, 'city', 'City');
    await fieldOf(await fx.company(), 'zone', 'Zone');
    expect(await webhooks().contactFieldChoices(owner)).toEqual([
      { key: 'city', label: 'City', type: 'text' },
      { key: 'tier', label: 'Tier', type: 'text' },
    ]);
    for (const user of [c.agent, c.marketer]) {
      await expectAppError(webhooks().contactFieldChoices(await fx.ctx(c, user)), 'forbidden');
    }
  });
});

describe('campaign filters (ADR-185)', () => {
  /** A campaign of the company, written as the campaigns service keeps a draft. */
  async function campaignOf(c: Company, name: string, createdAt = new Date()) {
    const id = uuidv7();
    await fx.query(
      `INSERT INTO app.campaigns (id, tenant_id, name, timezone, created_at)
       VALUES ($1, $2, $3, 'Asia/Kolkata', $4)`,
      [id, c.tenant.id, name, createdAt],
    );
    return { id, name };
  }
  /** A draft cancelled, as members cancel one: its campaign.status_changed. */
  const cancel = (campaignId: string) =>
    fx.query(`UPDATE app.campaigns SET status = 'canceled', canceled_at = now() WHERE id = $1`, [
      campaignId,
    ]);

  it("are refused without message.status or campaign.status_changed, empty, over 50 or naming another company's campaign; kept by a change that leaves them out and cleared with the events; the database keeps them to those events", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const autumn = await campaignOf(c, 'Autumn launch');
    const diwali = await campaignOf(c, 'Diwali offer');
    const elsewhere = await campaignOf(await fx.company(), 'Autumn launch');
    const url = 'https://hooks.example.com/in';
    const refused = async (
      eventTypes: string[],
      campaignIds: unknown,
      message: RegExp,
      path = 'campaignIds',
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, campaignIds }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(campaignIds)).toBe(path);
    };
    const needsTheEvents = /only for an endpoint that receives Message status or Campaign status/;
    await refused(['message.received', 'template.status_changed'], [autumn.id], needsTheEvents);
    await refused(['message.status'], [], /at least one campaign/);
    await refused(['message.status'], ['autumn_launch'], /from the list/, 'campaignIds.0');
    await refused(
      ['message.status'],
      Array.from({ length: 51 }, () => uuidv7()),
      /at most 50/,
    );
    await refused(
      ['campaign.status_changed'],
      [autumn.id, elsewhere.id],
      /of this company/,
      'campaignIds.1',
    );
    await refused(['message.status'], [uuidv7()], /of this company/, 'campaignIds.0');
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['message.status', 'consent.changed'],
      campaignIds: [diwali.id, autumn.id.toUpperCase(), diwali.id],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { campaignIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
          [c.tenant.id, action],
        )
      ).map((a) => a.metadata.campaignIds);
    expect(await audits('webhook.endpoint_created')).toEqual([[diwali.id, autumn.id]]);
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['message.status', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.campaigns;
    // Named as they are now: the status a campaign has when the list is read.
    await cancel(diwali.id);
    expect(await current()).toEqual([
      { id: diwali.id, name: 'Diwali offer', status: 'canceled' },
      { id: autumn.id, name: 'Autumn launch', status: 'draft' },
    ]);
    await change({ description: 'kept' });
    expect((await current())?.map((x) => x.id)).toEqual([diwali.id, autumn.id]);
    await change({ campaignIds: [autumn.id] });
    expect(await audits('webhook.endpoint_updated')).toEqual([[diwali.id, autumn.id], [autumn.id]]);
    // A list given again is checked again, changing nothing when it is refused.
    await expectAppError(
      change({ campaignIds: [autumn.id, elsewhere.id] }),
      'validation_failed',
      /of this company/,
    );
    expect((await current())?.map((x) => x.id)).toEqual([autumn.id]);
    await change({ campaignIds: null });
    expect(await current()).toBeNull();
    await change({ campaignIds: [diwali.id] });
    // Either event of a campaign keeps the list.
    await change({ eventTypes: ['campaign.status_changed', 'contact.created'] });
    expect((await current())?.map((x) => x.id)).toEqual([diwali.id]);
    // The database refuses an empty list, more than 50, a missing id or a list of lists from an
    // endpoint taking such an event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET campaign_ids = ${value} WHERE id = $1`, [
        created.id,
      ]);
    const many = `ARRAY[${Array.from({ length: 51 }, () => `'${uuidv7()}'`).join(',')}]::uuid[]`;
    for (const bad of [
      `'{}'`,
      many,
      `ARRAY['${diwali.id}', NULL]::uuid[]`,
      `ARRAY[ARRAY['${diwali.id}'::uuid], ARRAY['${autumn.id}'::uuid]]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_campaign_ids/);
    }
    await change({ eventTypes: ['message.received', 'consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['message.received'], campaignIds: [diwali.id] }),
      'validation_failed',
      needsTheEvents,
    );
    // …and any list for an endpoint that takes neither.
    await expect(setInDatabase(`ARRAY['${diwali.id}']::uuid[]`)).rejects.toThrow(
      /webhook_endpoints_campaign_ids/,
    );
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'campaign_ids', 'UPDATE')
                AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });

  it("offer the company's newest campaigns, whatever their status, at most 200, saying whether there are more, to developers only", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const hour = 3_600_000;
    const older = await campaignOf(c, 'Older', new Date(Date.now() - 2 * hour));
    const newer = await campaignOf(c, 'Newer', new Date(Date.now() - hour));
    await cancel(older.id);
    await campaignOf(await fx.company(), 'Elsewhere');
    expect(await webhooks().campaignChoices(owner)).toEqual({
      campaigns: [
        { id: newer.id, name: 'Newer', status: 'draft' },
        { id: older.id, name: 'Older', status: 'canceled' },
      ],
      more: false,
    });
    // 199 more, newer still: the oldest drops out of the 200 offered.
    await fx.query(
      `INSERT INTO app.campaigns (id, tenant_id, name, timezone, created_at)
       SELECT gen_random_uuid(), $1, 'Weekly ' || n, 'Asia/Kolkata', now() - n * interval '1 second'
         FROM generate_series(1, 199) AS n`,
      [c.tenant.id],
    );
    const choices = await webhooks().campaignChoices(owner);
    expect(choices.campaigns).toHaveLength(200);
    expect(choices.more).toBe(true);
    expect(choices.campaigns[0]?.name).toBe('Weekly 1');
    expect(choices.campaigns.at(-1)?.id).toBe(newer.id);
    for (const user of [c.agent, c.marketer]) {
      await expectAppError(webhooks().campaignChoices(await fx.ctx(c, user)), 'forbidden');
    }
  });

  it("send an endpoint that names campaigns only their messages' statuses and their changes, another every campaign's, other events to both, and name the campaign in each message status", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const autumn = await campaignOf(c, 'Autumn launch');
    const diwali = await campaignOf(c, 'Diwali offer');
    const add = async (eventTypes: WebhookEventType[], campaignIds: string[] | null) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes,
        campaignIds,
      });
      return { ...created, path };
    };
    const autumnOnly = await add(
      ['message.status', 'campaign.status_changed', 'message.received'],
      [autumn.id],
    );
    const from = waId();
    const first = await inbound(c, from, 'Is the sale on?');
    // A member's reply belongs to no campaign: its status is not captured.
    const reply = await sendReply(c, first.conversation_id, 'Yes, until Sunday.');
    const typesOf = async () => (await eventsOf(c)).map((e) => [e.type, e.status]);
    expect(await typesOf()).toEqual([['message.received', null]]);
    /** A message of a campaign reaching a status, as a campaign send's status updates do. */
    const statusOf = async (messageId: string, campaignId: string, status: string) => {
      await fx.query('UPDATE app.messages SET campaign_id = $2 WHERE id = $1', [
        messageId,
        campaignId,
      ]);
      await fx.query('UPDATE app.messages SET status = $2 WHERE id = $1', [messageId, status]);
    };
    await statusOf(reply.messageId, autumn.id, 'delivered');
    const second = await sendReply(c, first.conversation_id, 'Here is the Diwali offer.');
    await statusOf(second.messageId, diwali.id, 'delivered');
    // Campaign changes: the autumn launch's is captured, the Diwali offer's is not.
    await cancel(autumn.id);
    await cancel(diwali.id);
    expect(await typesOf()).toEqual([
      ['message.received', null],
      ['message.status', 'delivered'],
      ['campaign.status_changed', 'canceled'],
    ]);
    // The message's campaign is not stored with its event; the campaign's change keeps its own.
    const stored = await eventsOf(c);
    expect(stored[1]?.detail).not.toHaveProperty('campaignId');
    expect(stored[2]?.detail).toMatchObject({ campaignId: autumn.id });
    // An endpoint for every campaign hears every message's statuses from now on.
    const every = await add(['message.status', 'campaign.status_changed'], null);
    const third = await sendReply(c, first.conversation_id, 'Anything else?');
    await fx.query(`UPDATE app.messages SET status = 'read' WHERE id = $1`, [third.messageId]);
    await fx.query(`UPDATE app.messages SET status = 'read' WHERE id = $1`, [second.messageId]);
    const typesTo = async (endpointId: string) =>
      (await deliveriesOf(endpointId)).map((d) => [d.type, d.status]);
    expect(await typesTo(autumnOnly.id)).toEqual([
      ['message.received', null],
      ['message.status', 'delivered'],
      ['campaign.status_changed', 'canceled'],
    ]);
    expect(await typesTo(every.id)).toEqual([
      ['message.status', 'accepted'],
      ['message.status', 'read'],
      ['message.status', 'read'],
    ]);
    // Each status names its message's campaign, or none.
    expect(await deliverDue(c)).toMatchObject({ attempted: 6, succeeded: 6 });
    const campaignsAt = (path: string) =>
      requestsTo(path)
        .map((r) => JSON.parse(r.body) as { type: string; data: Record<string, unknown> })
        .filter((b) => b.type !== 'message.received')
        .map((b) =>
          b.type === 'message.status'
            ? [b.type, messageStatusPayloadSchema.parse(b).data.message.campaignId]
            : [b.type, (b.data.campaign as { id: string }).id],
        )
        .sort();
    expect(campaignsAt(autumnOnly.path)).toEqual([
      ['campaign.status_changed', autumn.id],
      ['message.status', autumn.id],
    ]);
    expect(campaignsAt(every.path)).toEqual(
      [
        ['message.status', null],
        ['message.status', null],
        ['message.status', diwali.id],
      ].sort(),
    );
  });
});

describe('pipeline filters (ADR-263)', () => {
  const crm = () =>
    createCrmService({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });
  /** The company's pipelines Sales and Renewals in that board order, and Old leads archived. */
  async function pipelinesOf(c: Company) {
    const owner = await fx.ctx(c, c.owner);
    const svc = crm();
    const pipeline = async (name: string) =>
      (await svc.createPipeline(owner, { name, currency: 'INR', stages: ['New', 'Won'] })).id;
    const sales = await pipeline('Sales');
    const renewals = await pipeline('Renewals');
    const old = await pipeline('Old leads');
    const [current] = (await svc.listPipelines(owner)).filter((p) => p.id === old);
    await svc.archivePipeline(owner, { id: old, expectedVersion: current!.version });
    return { owner, sales, renewals, old };
  }

  it("are refused without a deal event, empty, over 50 or naming another company's pipeline; named in Settings, archived ones too; kept by a change that leaves them out and cleared with the events; the database keeps them to those events", async () => {
    const c = await fx.company();
    const { owner, sales, renewals, old } = await pipelinesOf(c);
    const elsewhere = (await pipelinesOf(await fx.company())).sales;
    const url = 'https://hooks.example.com/in';
    const refused = async (
      eventTypes: string[],
      pipelineIds: unknown,
      message: RegExp,
      path = 'pipelineIds',
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, pipelineIds }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(pipelineIds)).toBe(path);
    };
    const needsTheEvents =
      /only for an endpoint that receives Deal added, Deal details, Deal stage, Deal owner or Deal won, lost or reopened/;
    // Task events are no pipeline's, even those of a deal's tasks.
    await refused(['task.created', 'task.status_changed'], [sales], needsTheEvents);
    await refused(['deal.created'], [], /at least one pipeline/);
    await refused(['deal.created'], ['Sales'], /from the list/, 'pipelineIds.0');
    await refused(
      ['deal.created'],
      Array.from({ length: 51 }, () => uuidv7()),
      /at most 50/,
    );
    await refused(['deal.stage_changed'], [sales, elsewhere], /of this company/, 'pipelineIds.1');
    await refused(['deal.status_changed'], [uuidv7()], /of this company/, 'pipelineIds.0');
    expect(await webhooks().list(owner)).toEqual([]);

    // An archived pipeline can be named: pipelines are kept, and one may be restored.
    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['deal.created', 'contact.created'],
      pipelineIds: [renewals, sales.toUpperCase(), renewals, old],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { pipelineIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
          [c.tenant.id, action],
        )
      ).map((a) => a.metadata.pipelineIds);
    expect(await audits('webhook.endpoint_created')).toEqual([[renewals, sales, old]]);
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.pipelines;
    expect(await current()).toEqual([
      { id: renewals, name: 'Renewals', archived: false },
      { id: sales, name: 'Sales', archived: false },
      { id: old, name: 'Old leads', archived: true },
    ]);
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['deal.created', 'contact.created'],
        ...fields,
      });
    await change({ description: 'kept' });
    expect((await current())?.map((p) => p.id)).toEqual([renewals, sales, old]);
    await change({ pipelineIds: [sales] });
    expect(await audits('webhook.endpoint_updated')).toEqual([[renewals, sales, old], [sales]]);
    // A list given again is checked again, changing nothing when it is refused.
    await expectAppError(
      change({ pipelineIds: [sales, elsewhere] }),
      'validation_failed',
      /of this company/,
    );
    expect((await current())?.map((p) => p.id)).toEqual([sales]);
    await change({ pipelineIds: null });
    expect(await current()).toBeNull();
    await change({ pipelineIds: [renewals] });
    // Any deal event keeps the list.
    await change({ eventTypes: ['deal.status_changed', 'task.created'] });
    expect((await current())?.map((p) => p.id)).toEqual([renewals]);
    // The database refuses an empty list, more than 50, a missing id or a list of lists from an
    // endpoint taking a deal event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET pipeline_ids = ${value} WHERE id = $1`, [
        created.id,
      ]);
    const many = `ARRAY[${Array.from({ length: 51 }, () => `'${uuidv7()}'`).join(',')}]::uuid[]`;
    for (const bad of [
      `'{}'`,
      many,
      `ARRAY['${sales}', NULL]::uuid[]`,
      `ARRAY[ARRAY['${sales}'::uuid], ARRAY['${renewals}'::uuid]]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_pipeline_ids/);
    }
    await change({ eventTypes: ['task.created', 'task.status_changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['task.created'], pipelineIds: [sales] }),
      'validation_failed',
      needsTheEvents,
    );
    // …and any list for an endpoint that takes none.
    await expect(setInDatabase(`ARRAY['${sales}']::uuid[]`)).rejects.toThrow(
      /webhook_endpoints_pipeline_ids/,
    );
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'pipeline_ids', 'UPDATE')
                AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });

  it('offer the pipelines the company uses, in board order, to developers only', async () => {
    const c = await fx.company();
    const { owner, sales, renewals } = await pipelinesOf(c);
    await pipelinesOf(await fx.company());
    expect(await webhooks().pipelineChoices(owner)).toEqual([
      { id: sales, name: 'Sales' },
      { id: renewals, name: 'Renewals' },
    ]);
    for (const user of [c.agent, c.marketer]) {
      await expectAppError(webhooks().pipelineChoices(await fx.ctx(c, user)), 'forbidden');
    }
  });
});

describe('stage filters (ADR-264)', () => {
  const crm = () =>
    createCrmService({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });
  /**
   * The company's pipelines Sales (New, Proposal; Lost removed) and Renewals (Due, Signed) in that
   * board order, and Old leads (Open) archived; their stages' ids.
   */
  async function stagesOf(c: Company) {
    const owner = await fx.ctx(c, c.owner);
    const svc = crm();
    const pipeline = async (name: string, stages: string[]) =>
      (await svc.createPipeline(owner, { name, currency: 'INR', stages })).id;
    const salesId = await pipeline('Sales', ['New', 'Proposal', 'Lost']);
    const renewalsId = await pipeline('Renewals', ['Due', 'Signed']);
    const oldId = await pipeline('Old leads', ['Open']);
    const before = await svc.listPipelines(owner);
    const sales = before.find((p) => p.id === salesId)!;
    await svc.updatePipeline(owner, {
      id: salesId,
      expectedVersion: sales.version,
      name: 'Sales',
      stages: sales.stages.slice(0, 2).map((st) => ({ id: st.id, name: st.name })),
    });
    const old = before.find((p) => p.id === oldId)!;
    await svc.archivePipeline(owner, { id: oldId, expectedVersion: old.version });
    const after = await svc.listPipelines(owner, { includeArchived: true });
    const stage = (pipelineId: string, name: string) =>
      after.find((p) => p.id === pipelineId)!.stages.find((st) => st.name === name)!.id;
    return {
      owner,
      salesId,
      renewalsId,
      fresh: stage(salesId, 'New'),
      proposal: stage(salesId, 'Proposal'),
      lost: stage(salesId, 'Lost'),
      due: stage(renewalsId, 'Due'),
      signed: stage(renewalsId, 'Signed'),
      open: stage(oldId, 'Open'),
    };
  }

  it("are refused without a deal event, empty, over 50 or naming another company's stage; named in Settings with their pipelines, removed ones and those of archived pipelines too; kept by a change that leaves them out and cleared with the events; the database keeps them to those events", async () => {
    const c = await fx.company();
    const { owner, proposal, lost, signed, open } = await stagesOf(c);
    const elsewhere = (await stagesOf(await fx.company())).proposal;
    const url = 'https://hooks.example.com/in';
    const refused = async (
      eventTypes: string[],
      stageIds: unknown,
      message: RegExp,
      path = 'stageIds',
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, stageIds }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(stageIds)).toBe(path);
    };
    const needsTheEvents =
      /only for an endpoint that receives Deal added, Deal details, Deal stage, Deal owner or Deal won, lost or reopened/;
    await refused(['task.created', 'contact.created'], [proposal], needsTheEvents);
    await refused(['deal.created'], [], /at least one stage/);
    await refused(['deal.created'], ['Proposal'], /from the list/, 'stageIds.0');
    await refused(
      ['deal.created'],
      Array.from({ length: 51 }, () => uuidv7()),
      /at most 50/,
    );
    await refused(['deal.stage_changed'], [proposal, elsewhere], /of this company/, 'stageIds.1');
    await refused(['deal.status_changed'], [uuidv7()], /of this company/, 'stageIds.0');
    expect(await webhooks().list(owner)).toEqual([]);

    // A removed stage and one of an archived pipeline can be named: stages are kept.
    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['deal.stage_changed', 'contact.created'],
      stageIds: [signed, proposal.toUpperCase(), signed, lost, open],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { stageIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
          [c.tenant.id, action],
        )
      ).map((a) => a.metadata.stageIds);
    expect(await audits('webhook.endpoint_created')).toEqual([[signed, proposal, lost, open]]);
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.stages;
    const named = (
      id: string,
      name: string,
      pipelineName: string,
      removed = false,
      pipelineArchived = false,
    ) => ({ id, name, pipelineName, removed, pipelineArchived });
    expect(await current()).toEqual([
      named(signed, 'Signed', 'Renewals'),
      named(proposal, 'Proposal', 'Sales'),
      named(lost, 'Lost', 'Sales', true),
      named(open, 'Open', 'Old leads', false, true),
    ]);
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['deal.stage_changed', 'contact.created'],
        ...fields,
      });
    await change({ description: 'kept' });
    expect((await current())?.map((st) => st.id)).toEqual([signed, proposal, lost, open]);
    await change({ stageIds: [proposal] });
    expect(await audits('webhook.endpoint_updated')).toEqual([
      [signed, proposal, lost, open],
      [proposal],
    ]);
    // A list given again is checked again, changing nothing when it is refused.
    await expectAppError(
      change({ stageIds: [proposal, elsewhere] }),
      'validation_failed',
      /of this company/,
    );
    expect((await current())?.map((st) => st.id)).toEqual([proposal]);
    await change({ stageIds: null });
    expect(await current()).toBeNull();
    await change({ stageIds: [signed] });
    // Any deal event keeps the list.
    await change({ eventTypes: ['deal.created', 'task.created'] });
    expect((await current())?.map((st) => st.id)).toEqual([signed]);
    // The database refuses an empty list, more than 50, a missing id or a list of lists from an
    // endpoint taking a deal event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET stage_ids = ${value} WHERE id = $1`, [created.id]);
    const many = `ARRAY[${Array.from({ length: 51 }, () => `'${uuidv7()}'`).join(',')}]::uuid[]`;
    for (const bad of [
      `'{}'`,
      many,
      `ARRAY['${signed}', NULL]::uuid[]`,
      `ARRAY[ARRAY['${signed}'::uuid], ARRAY['${proposal}'::uuid]]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_stage_ids/);
    }
    await change({ eventTypes: ['task.created', 'task.status_changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['task.created'], stageIds: [signed] }),
      'validation_failed',
      needsTheEvents,
    );
    // …and any list for an endpoint that takes none.
    await expect(setInDatabase(`ARRAY['${signed}']::uuid[]`)).rejects.toThrow(
      /webhook_endpoints_stage_ids/,
    );
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'stage_ids', 'UPDATE')
                AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });

  it('offer the stages in use of the pipelines the company uses, in board order, to developers only', async () => {
    const c = await fx.company();
    const { owner, salesId, renewalsId, fresh, proposal, due, signed } = await stagesOf(c);
    await stagesOf(await fx.company());
    const choice = (id: string, name: string, pipelineId: string, pipelineName: string) => ({
      id,
      name,
      pipelineId,
      pipelineName,
    });
    expect(await webhooks().stageChoices(owner)).toEqual([
      choice(fresh, 'New', salesId, 'Sales'),
      choice(proposal, 'Proposal', salesId, 'Sales'),
      choice(due, 'Due', renewalsId, 'Renewals'),
      choice(signed, 'Signed', renewalsId, 'Renewals'),
    ]);
    for (const user of [c.agent, c.marketer]) {
      await expectAppError(webhooks().stageChoices(await fx.ctx(c, user)), 'forbidden');
    }
  });
});

describe('owner filters (ADR-265)', () => {
  const setMember = (membershipId: string, change: string) =>
    fx.query(`UPDATE app.memberships SET ${change} WHERE id = $1`, [membershipId]);

  it('are refused without a deal event, empty, over 50 or naming a member who cannot own deals; named in Settings, a member who left included; kept by a change that leaves them out and cleared with the events; the database keeps them to those events', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const ownerId = owner.membership.id;
    const agent = (await fx.ctx(c, c.agent)).membership.id;
    // A marketer cannot use the CRM, and another company's member is not this one's.
    const marketer = (await fx.ctx(c, c.marketer)).membership.id;
    const other = await fx.company();
    const elsewhere = (await fx.ctx(other, other.agent)).membership.id;
    const url = 'https://hooks.example.com/in';
    const refused = async (
      eventTypes: string[],
      ownerIds: unknown,
      message: RegExp,
      path = 'ownerIds',
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, ownerIds }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(ownerIds)).toBe(path);
    };
    const needsTheEvents =
      /only for an endpoint that receives Deal added, Deal details, Deal stage, Deal owner or Deal won, lost or reopened/;
    await refused(['task.created', 'message.received'], [agent], needsTheEvents);
    await refused(['deal.created'], [], /at least one member/);
    await refused(['deal.created'], ['agent@example.com'], /from the list/, 'ownerIds.0');
    await refused(
      ['deal.created'],
      Array.from({ length: 51 }, () => uuidv7()),
      /at most 50/,
    );
    const notOwners = /active members of this company who use the CRM/;
    await refused(['deal.stage_changed'], [agent, marketer], notOwners, 'ownerIds.1');
    await refused(['deal.status_changed'], [elsewhere], notOwners, 'ownerIds.0');
    await refused(['deal.created'], [uuidv7()], notOwners, 'ownerIds.0');
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['deal.created', 'contact.created'],
      ownerIds: [agent, ownerId.toUpperCase(), agent],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { ownerIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
          [c.tenant.id, action],
        )
      ).map((a) => a.metadata.ownerIds);
    expect(await audits('webhook.endpoint_created')).toEqual([[agent, ownerId]]);
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.owners;
    expect(await current()).toEqual([
      { id: agent, name: 'Agent', active: true },
      { id: ownerId, name: 'Owner', active: true },
    ]);
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['deal.created', 'contact.created'],
        ...fields,
      });
    // The agent is suspended: kept, named as no longer able to own deals, and kept by a change
    // that gives the list again; adding the marketer is refused.
    await setMember(agent, `status = 'suspended'`);
    expect(await current()).toEqual([
      { id: agent, name: 'Agent', active: false },
      { id: ownerId, name: 'Owner', active: true },
    ]);
    await change({ description: 'kept' });
    await change({ ownerIds: [agent, ownerId] });
    expect((await current())?.map((m) => m.id)).toEqual([agent, ownerId]);
    await expectAppError(change({ ownerIds: [agent, marketer] }), 'validation_failed', notOwners);
    await change({ ownerIds: [ownerId] });
    expect(await audits('webhook.endpoint_updated')).toEqual([
      [agent, ownerId],
      [agent, ownerId],
      [ownerId],
    ]);
    // Dropped, the suspended agent cannot be added back until they can own deals again.
    await expectAppError(change({ ownerIds: [agent] }), 'validation_failed', notOwners);
    await setMember(agent, `status = 'active'`);
    await change({ ownerIds: [agent] });
    await change({ ownerIds: null });
    expect(await current()).toBeNull();
    await change({ ownerIds: [ownerId] });
    // Any deal event keeps the list.
    await change({ eventTypes: ['deal.stage_changed', 'task.created'] });
    expect((await current())?.map((m) => m.id)).toEqual([ownerId]);
    // The database refuses an empty list, more than 50, a missing id or a list of lists from an
    // endpoint taking a deal event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET owner_ids = ${value} WHERE id = $1`, [created.id]);
    const many = `ARRAY[${Array.from({ length: 51 }, () => `'${uuidv7()}'`).join(',')}]::uuid[]`;
    for (const bad of [
      `'{}'`,
      many,
      `ARRAY['${ownerId}', NULL]::uuid[]`,
      `ARRAY[ARRAY['${ownerId}'::uuid], ARRAY['${agent}'::uuid]]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_owner_ids/);
    }
    await change({ eventTypes: ['task.created', 'task.status_changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['task.created'], ownerIds: [ownerId] }),
      'validation_failed',
      needsTheEvents,
    );
    // …and any list for an endpoint that takes none.
    await expect(setInDatabase(`ARRAY['${ownerId}']::uuid[]`)).rejects.toThrow(
      /webhook_endpoints_owner_ids/,
    );
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'owner_ids', 'UPDATE')
                AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });

  it('offer the members who can own deals, by name, to developers only', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = (await fx.ctx(c, c.agent)).membership.id;
    await fx.company();
    expect(await webhooks().ownerChoices(owner)).toEqual([
      { id: agent, name: 'Agent' },
      { id: owner.membership.id, name: 'Owner' },
    ]);
    // Developers only: refused before the agent is suspended, whose company no longer resolves then.
    for (const user of [c.agent, c.marketer]) {
      await expectAppError(webhooks().ownerChoices(await fx.ctx(c, user)), 'forbidden');
    }
    // A suspended member cannot own deals, so is not offered.
    await setMember(agent, `status = 'suspended'`);
    expect((await webhooks().ownerChoices(owner)).map((m) => m.id)).toEqual([owner.membership.id]);
  });
});

describe('task assignee filters (ADR-266)', () => {
  const setMember = (membershipId: string, change: string) =>
    fx.query(`UPDATE app.memberships SET ${change} WHERE id = $1`, [membershipId]);

  it('are refused without a task event, empty, over 50 or naming a member who cannot be assigned tasks; named in Settings, a member who left included; kept by a change that leaves them out and cleared with the events; the database keeps them to those events', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const ownerId = owner.membership.id;
    const agent = (await fx.ctx(c, c.agent)).membership.id;
    // A marketer cannot use the CRM, and another company's member is not this one's.
    const marketer = (await fx.ctx(c, c.marketer)).membership.id;
    const other = await fx.company();
    const elsewhere = (await fx.ctx(other, other.agent)).membership.id;
    const url = 'https://hooks.example.com/in';
    const refused = async (
      eventTypes: string[],
      taskAssigneeIds: unknown,
      message: RegExp,
      path = 'taskAssigneeIds',
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, taskAssigneeIds }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(taskAssigneeIds)).toBe(
        path,
      );
    };
    const needsTheEvents =
      /only for an endpoint that receives Task added, Task details, Task assignee or Task done, cancelled or reopened/;
    await refused(['deal.created', 'message.received'], [agent], needsTheEvents);
    await refused(['task.created'], [], /at least one member/);
    await refused(['task.created'], ['agent@example.com'], /from the list/, 'taskAssigneeIds.0');
    await refused(
      ['task.created'],
      Array.from({ length: 51 }, () => uuidv7()),
      /at most 50/,
    );
    const notAssignable = /active members of this company who use the CRM/;
    await refused(['task.status_changed'], [agent, marketer], notAssignable, 'taskAssigneeIds.1');
    await refused(['task.created'], [elsewhere], notAssignable, 'taskAssigneeIds.0');
    await refused(['task.created'], [uuidv7()], notAssignable, 'taskAssigneeIds.0');
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['task.created', 'deal.created'],
      taskAssigneeIds: [agent, ownerId.toUpperCase(), agent],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { taskAssigneeIds?: unknown; ownerIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
          [c.tenant.id, action],
        )
      ).map((a) => a.metadata.taskAssigneeIds);
    expect(await audits('webhook.endpoint_created')).toEqual([[agent, ownerId]]);
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.taskAssignees;
    expect(await current()).toEqual([
      { id: agent, name: 'Agent', active: true },
      { id: ownerId, name: 'Owner', active: true },
    ]);
    // Deal owners are a list of their own: none were chosen.
    expect((await webhooks().list(owner)).find((e) => e.id === created.id)?.owners).toBeNull();
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['task.created', 'deal.created'],
        ...fields,
      });
    // The agent is suspended: kept, named as no longer able to be assigned tasks, and kept by a
    // change that gives the list again; adding the marketer is refused.
    await setMember(agent, `status = 'suspended'`);
    expect(await current()).toEqual([
      { id: agent, name: 'Agent', active: false },
      { id: ownerId, name: 'Owner', active: true },
    ]);
    await change({ description: 'kept' });
    await change({ taskAssigneeIds: [agent, ownerId] });
    expect((await current())?.map((m) => m.id)).toEqual([agent, ownerId]);
    await expectAppError(
      change({ taskAssigneeIds: [agent, marketer] }),
      'validation_failed',
      notAssignable,
    );
    await change({ taskAssigneeIds: [ownerId] });
    expect(await audits('webhook.endpoint_updated')).toEqual([
      [agent, ownerId],
      [agent, ownerId],
      [ownerId],
    ]);
    // Dropped, the suspended agent cannot be added back until they can be assigned tasks again.
    await expectAppError(change({ taskAssigneeIds: [agent] }), 'validation_failed', notAssignable);
    await setMember(agent, `status = 'active'`);
    await change({ taskAssigneeIds: [agent] });
    await change({ taskAssigneeIds: null });
    expect(await current()).toBeNull();
    await change({ taskAssigneeIds: [ownerId] });
    // Either task event keeps the list.
    await change({ eventTypes: ['task.status_changed', 'contact.created'] });
    expect((await current())?.map((m) => m.id)).toEqual([ownerId]);
    // The database refuses an empty list, more than 50, a missing id or a list of lists from an
    // endpoint taking a task event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET task_assignee_ids = ${value} WHERE id = $1`, [
        created.id,
      ]);
    const many = `ARRAY[${Array.from({ length: 51 }, () => `'${uuidv7()}'`).join(',')}]::uuid[]`;
    for (const bad of [
      `'{}'`,
      many,
      `ARRAY['${ownerId}', NULL]::uuid[]`,
      `ARRAY[ARRAY['${ownerId}'::uuid], ARRAY['${agent}'::uuid]]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_task_assignee_ids/);
    }
    await change({ eventTypes: ['deal.created', 'deal.status_changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['deal.created'], taskAssigneeIds: [ownerId] }),
      'validation_failed',
      needsTheEvents,
    );
    // …and any list for an endpoint that takes none.
    await expect(setInDatabase(`ARRAY['${ownerId}']::uuid[]`)).rejects.toThrow(
      /webhook_endpoints_task_assignee_ids/,
    );
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'task_assignee_ids',
                                   'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });
});

describe('pipeline filters for task events (ADR-303)', () => {
  const crm = () =>
    createCrmService({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });
  /** The company's pipelines Sales and Renewals in that board order, and Old leads archived. */
  async function pipelinesOf(c: Company) {
    const owner = await fx.ctx(c, c.owner);
    const svc = crm();
    const pipeline = async (name: string) =>
      (await svc.createPipeline(owner, { name, currency: 'INR', stages: ['New', 'Won'] })).id;
    const sales = await pipeline('Sales');
    const renewals = await pipeline('Renewals');
    const old = await pipeline('Old leads');
    const [current] = (await svc.listPipelines(owner)).filter((p) => p.id === old);
    await svc.archivePipeline(owner, { id: old, expectedVersion: current!.version });
    return { owner, sales, renewals, old };
  }

  it("are refused without a task event, empty, over 50 or naming another company's pipeline; named in Settings apart from the deals' pipelines, archived ones too; kept by a change that leaves them out and cleared with the events; the database keeps them to those events", async () => {
    const c = await fx.company();
    const { owner, sales, renewals, old } = await pipelinesOf(c);
    const elsewhere = (await pipelinesOf(await fx.company())).sales;
    const url = 'https://hooks.example.com/in';
    const refused = async (
      eventTypes: string[],
      taskPipelineIds: unknown,
      message: RegExp,
      path = 'taskPipelineIds',
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, taskPipelineIds }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(taskPipelineIds)).toBe(
        path,
      );
    };
    const needsTheEvents =
      /only for an endpoint that receives Task added, Task details, Task assignee or Task done, cancelled or reopened/;
    // Deal events take pipelines of their own.
    await refused(['deal.created', 'deal.status_changed'], [sales], needsTheEvents);
    await refused(['task.created'], [], /at least one pipeline/);
    await refused(['task.created'], ['Sales'], /from the list/, 'taskPipelineIds.0');
    await refused(
      ['task.created'],
      Array.from({ length: 51 }, () => uuidv7()),
      /at most 50/,
    );
    await refused(['task.updated'], [sales, elsewhere], /of this company/, 'taskPipelineIds.1');
    await refused(['task.status_changed'], [uuidv7()], /of this company/, 'taskPipelineIds.0');
    expect(await webhooks().list(owner)).toEqual([]);

    // An archived pipeline can be named: pipelines are kept, and one may be restored.
    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['task.created', 'deal.created'],
      pipelineIds: [sales],
      taskPipelineIds: [renewals, sales.toUpperCase(), renewals, old],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { pipelineIds?: unknown; taskPipelineIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
          [c.tenant.id, action],
        )
      ).map((a) => [a.metadata.pipelineIds ?? null, a.metadata.taskPipelineIds ?? null]);
    expect(await audits('webhook.endpoint_created')).toEqual([[[sales], [renewals, sales, old]]]);
    const shown = async () => (await webhooks().list(owner)).find((e) => e.id === created.id);
    const current = async () => (await shown())?.taskPipelines;
    expect(await current()).toEqual([
      { id: renewals, name: 'Renewals', archived: false },
      { id: sales, name: 'Sales', archived: false },
      { id: old, name: 'Old leads', archived: true },
    ]);
    // The deals' pipelines are a list of their own.
    expect((await shown())?.pipelines).toEqual([{ id: sales, name: 'Sales', archived: false }]);
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['task.created', 'deal.created'],
        ...fields,
      });
    // Left out, the list is kept; another company's pipeline is refused; a list given replaces it.
    await change({ description: 'kept' });
    expect((await current())?.map((p) => p.id)).toEqual([renewals, sales, old]);
    await expectAppError(
      change({ taskPipelineIds: [renewals, elsewhere] }),
      'validation_failed',
      /of this company/,
    );
    await change({ taskPipelineIds: [sales] });
    expect(await audits('webhook.endpoint_updated')).toEqual([
      [[sales], [renewals, sales, old]],
      [[sales], [sales]],
    ]);
    await change({ taskPipelineIds: null });
    expect(await current()).toBeNull();
    expect((await shown())?.pipelines?.map((p) => p.id)).toEqual([sales]);
    await change({ taskPipelineIds: [renewals] });
    // Any task event keeps the list.
    await change({ eventTypes: ['task.assignee_changed', 'contact.created'] });
    expect((await current())?.map((p) => p.id)).toEqual([renewals]);
    // The database refuses an empty list, more than 50, a missing id or a list of lists from an
    // endpoint taking a task event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET task_pipeline_ids = ${value} WHERE id = $1`, [
        created.id,
      ]);
    const many = `ARRAY[${Array.from({ length: 51 }, () => `'${uuidv7()}'`).join(',')}]::uuid[]`;
    for (const bad of [
      `'{}'`,
      many,
      `ARRAY['${sales}', NULL]::uuid[]`,
      `ARRAY[ARRAY['${sales}'::uuid], ARRAY['${renewals}'::uuid]]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_task_pipeline_ids/);
    }
    await change({ eventTypes: ['deal.created', 'deal.status_changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['deal.created'], taskPipelineIds: [sales] }),
      'validation_failed',
      needsTheEvents,
    );
    // …and any list for an endpoint that takes none.
    await expect(setInDatabase(`ARRAY['${sales}']::uuid[]`)).rejects.toThrow(
      /webhook_endpoints_task_pipeline_ids/,
    );
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'task_pipeline_ids',
                                   'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });
});

describe('stage and owner filters for task events (ADR-304)', () => {
  const crm = () =>
    createCrmService({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });
  const setMember = (membershipId: string, change: string) =>
    fx.query(`UPDATE app.memberships SET ${change} WHERE id = $1`, [membershipId]);
  /** The company's pipeline Sales (New, Proposal; Lost removed) and its stages' ids. */
  async function stagesOf(c: Company) {
    const owner = await fx.ctx(c, c.owner);
    const svc = crm();
    const { id: salesId } = await svc.createPipeline(owner, {
      name: 'Sales',
      currency: 'INR',
      stages: ['New', 'Proposal', 'Lost'],
    });
    const [sales] = (await svc.listPipelines(owner)).filter((p) => p.id === salesId);
    await svc.updatePipeline(owner, {
      id: salesId,
      expectedVersion: sales!.version,
      name: 'Sales',
      stages: sales!.stages.slice(0, 2).map((st) => ({ id: st.id, name: st.name })),
    });
    const stage = (name: string) => sales!.stages.find((st) => st.name === name)!.id;
    return { owner, fresh: stage('New'), proposal: stage('Proposal'), lost: stage('Lost') };
  }
  const url = 'https://hooks.example.com/in';
  const needsTheEvents =
    /only for an endpoint that receives Task added, Task details, Task assignee or Task done, cancelled or reopened/;
  const audits = async (c: Company, action: string, field: 'taskStageIds' | 'taskDealOwnerIds') =>
    (
      await fx.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM app.audit_events
          WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
        [c.tenant.id, action],
      )
    ).map((a) => a.metadata[field] ?? null);

  it("take the stages of tasks' deals: refused without a task event, empty, over 50 or naming another company's stage; named in Settings apart from the deals' stages, removed ones too; kept by a change that leaves them out and cleared with the events; the database keeps them to those events", async () => {
    const c = await fx.company();
    const { owner, fresh, proposal, lost } = await stagesOf(c);
    const elsewhere = (await stagesOf(await fx.company())).proposal;
    const refused = async (
      eventTypes: string[],
      taskStageIds: unknown,
      message: RegExp,
      path = 'taskStageIds',
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, taskStageIds }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(taskStageIds)).toBe(path);
    };
    // Deal events take stages of their own.
    await refused(['deal.created', 'deal.stage_changed'], [proposal], needsTheEvents);
    await refused(['task.created'], [], /at least one stage/);
    await refused(['task.created'], ['Proposal'], /from the list/, 'taskStageIds.0');
    await refused(
      ['task.created'],
      Array.from({ length: 51 }, () => uuidv7()),
      /at most 50/,
    );
    await refused(['task.updated'], [proposal, elsewhere], /of this company/, 'taskStageIds.1');
    await refused(['task.status_changed'], [uuidv7()], /of this company/, 'taskStageIds.0');
    expect(await webhooks().list(owner)).toEqual([]);

    // A removed stage can be named: stages are kept.
    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['task.created', 'deal.created'],
      stageIds: [fresh],
      taskStageIds: [lost, proposal.toUpperCase(), lost],
    });
    expect(await audits(c, 'webhook.endpoint_created', 'taskStageIds')).toEqual([[lost, proposal]]);
    const shown = async () => (await webhooks().list(owner)).find((e) => e.id === created.id);
    const current = async () => (await shown())?.taskStages;
    const named = (id: string, name: string, removed = false) => ({
      id,
      name,
      pipelineName: 'Sales',
      removed,
      pipelineArchived: false,
    });
    expect(await current()).toEqual([named(lost, 'Lost', true), named(proposal, 'Proposal')]);
    // The deals' stages are a list of their own.
    expect((await shown())?.stages).toEqual([named(fresh, 'New')]);
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['task.created', 'deal.created'],
        ...fields,
      });
    await change({ description: 'kept' });
    expect((await current())?.map((st) => st.id)).toEqual([lost, proposal]);
    await expectAppError(
      change({ taskStageIds: [proposal, elsewhere] }),
      'validation_failed',
      /of this company/,
    );
    await change({ taskStageIds: [proposal] });
    expect(await audits(c, 'webhook.endpoint_updated', 'taskStageIds')).toEqual([
      [lost, proposal],
      [proposal],
    ]);
    await change({ taskStageIds: null });
    expect(await current()).toBeNull();
    expect((await shown())?.stages?.map((st) => st.id)).toEqual([fresh]);
    await change({ taskStageIds: [fresh] });
    // Any task event keeps the list.
    await change({ eventTypes: ['task.updated', 'contact.created'] });
    expect((await current())?.map((st) => st.id)).toEqual([fresh]);
    // The database refuses an empty list, more than 50, a missing id or a list of lists from an
    // endpoint taking a task event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET task_stage_ids = ${value} WHERE id = $1`, [
        created.id,
      ]);
    const many = `ARRAY[${Array.from({ length: 51 }, () => `'${uuidv7()}'`).join(',')}]::uuid[]`;
    for (const bad of [
      `'{}'`,
      many,
      `ARRAY['${fresh}', NULL]::uuid[]`,
      `ARRAY[ARRAY['${fresh}'::uuid], ARRAY['${proposal}'::uuid]]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_task_stage_ids/);
    }
    await change({ eventTypes: ['deal.created', 'deal.status_changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['deal.created'], taskStageIds: [fresh] }),
      'validation_failed',
      needsTheEvents,
    );
    // …and any list for an endpoint that takes none.
    await expect(setInDatabase(`ARRAY['${fresh}']::uuid[]`)).rejects.toThrow(
      /webhook_endpoints_task_stage_ids/,
    );
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'task_stage_ids',
                                   'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });

  it("take the owners of tasks' deals: refused without a task event, empty, over 50 or naming a member who cannot own deals; named in Settings apart from the deals' owners and the task assignees, a member who left included; kept by a change that leaves them out and cleared with the events; the database keeps them to those events", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const ownerId = owner.membership.id;
    const agent = (await fx.ctx(c, c.agent)).membership.id;
    // A marketer cannot use the CRM, and another company's member is not this one's.
    const marketer = (await fx.ctx(c, c.marketer)).membership.id;
    const other = await fx.company();
    const elsewhere = (await fx.ctx(other, other.agent)).membership.id;
    const refused = async (
      eventTypes: string[],
      taskDealOwnerIds: unknown,
      message: RegExp,
      path = 'taskDealOwnerIds',
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, taskDealOwnerIds }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(taskDealOwnerIds)).toBe(
        path,
      );
    };
    await refused(['deal.created', 'message.received'], [agent], needsTheEvents);
    await refused(['task.created'], [], /at least one member/);
    await refused(['task.created'], ['agent@example.com'], /from the list/, 'taskDealOwnerIds.0');
    await refused(
      ['task.created'],
      Array.from({ length: 51 }, () => uuidv7()),
      /at most 50/,
    );
    const notOwners = /active members of this company who use the CRM/;
    await refused(['task.status_changed'], [agent, marketer], notOwners, 'taskDealOwnerIds.1');
    await refused(['task.created'], [elsewhere], notOwners, 'taskDealOwnerIds.0');
    await refused(['task.created'], [uuidv7()], notOwners, 'taskDealOwnerIds.0');
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['task.created', 'deal.created'],
      taskAssigneeIds: [ownerId],
      taskDealOwnerIds: [agent, ownerId.toUpperCase(), agent],
    });
    expect(await audits(c, 'webhook.endpoint_created', 'taskDealOwnerIds')).toEqual([
      [agent, ownerId],
    ]);
    const shown = async () => (await webhooks().list(owner)).find((e) => e.id === created.id);
    const current = async () => (await shown())?.taskDealOwners;
    expect(await current()).toEqual([
      { id: agent, name: 'Agent', active: true },
      { id: ownerId, name: 'Owner', active: true },
    ]);
    // The deals' owners and the task assignees are lists of their own.
    expect((await shown())?.owners).toBeNull();
    expect((await shown())?.taskAssignees).toEqual([{ id: ownerId, name: 'Owner', active: true }]);
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['task.created', 'deal.created'],
        ...fields,
      });
    // The agent is suspended: kept, named as no longer able to own deals, and kept by a change that
    // gives the list again; adding the marketer is refused.
    await setMember(agent, `status = 'suspended'`);
    expect(await current()).toEqual([
      { id: agent, name: 'Agent', active: false },
      { id: ownerId, name: 'Owner', active: true },
    ]);
    await change({ description: 'kept' });
    await change({ taskDealOwnerIds: [agent, ownerId] });
    expect((await current())?.map((m) => m.id)).toEqual([agent, ownerId]);
    await expectAppError(
      change({ taskDealOwnerIds: [agent, marketer] }),
      'validation_failed',
      notOwners,
    );
    await change({ taskDealOwnerIds: [ownerId] });
    expect(await audits(c, 'webhook.endpoint_updated', 'taskDealOwnerIds')).toEqual([
      [agent, ownerId],
      [agent, ownerId],
      [ownerId],
    ]);
    // Dropped, the suspended agent cannot be added back until they can own deals again.
    await expectAppError(change({ taskDealOwnerIds: [agent] }), 'validation_failed', notOwners);
    await setMember(agent, `status = 'active'`);
    await change({ taskDealOwnerIds: [agent] });
    await change({ taskDealOwnerIds: null });
    expect(await current()).toBeNull();
    await change({ taskDealOwnerIds: [ownerId] });
    // Any task event keeps the list.
    await change({ eventTypes: ['task.assignee_changed', 'contact.created'] });
    expect((await current())?.map((m) => m.id)).toEqual([ownerId]);
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET task_deal_owner_ids = ${value} WHERE id = $1`, [
        created.id,
      ]);
    const many = `ARRAY[${Array.from({ length: 51 }, () => `'${uuidv7()}'`).join(',')}]::uuid[]`;
    for (const bad of [
      `'{}'`,
      many,
      `ARRAY['${ownerId}', NULL]::uuid[]`,
      `ARRAY[ARRAY['${ownerId}'::uuid], ARRAY['${agent}'::uuid]]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(
        /webhook_endpoints_task_deal_owner_ids/,
      );
    }
    await change({ eventTypes: ['deal.created', 'deal.status_changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['deal.created'], taskDealOwnerIds: [ownerId] }),
      'validation_failed',
      needsTheEvents,
    );
    await expect(setInDatabase(`ARRAY['${ownerId}']::uuid[]`)).rejects.toThrow(
      /webhook_endpoints_task_deal_owner_ids/,
    );
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'task_deal_owner_ids',
                                   'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });
});

describe('pipeline, stage and owner filters for note events (ADR-305)', () => {
  const crm = () =>
    createCrmService({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });
  /**
   * The company's pipelines Sales (New, Proposal; Lost removed) and Old leads, archived: their ids
   * and Sales' stages'.
   */
  async function crmOf(c: Company) {
    const owner = await fx.ctx(c, c.owner);
    const svc = crm();
    const { id: sales } = await svc.createPipeline(owner, {
      name: 'Sales',
      currency: 'INR',
      stages: ['New', 'Proposal', 'Lost'],
    });
    const { id: old } = await svc.createPipeline(owner, {
      name: 'Old leads',
      currency: 'INR',
      stages: ['New'],
    });
    const pipelines = await svc.listPipelines(owner);
    const salesNow = pipelines.find((p) => p.id === sales)!;
    await svc.updatePipeline(owner, {
      id: sales,
      expectedVersion: salesNow.version,
      name: 'Sales',
      stages: salesNow.stages.slice(0, 2).map((st) => ({ id: st.id, name: st.name })),
    });
    await svc.archivePipeline(owner, {
      id: old,
      expectedVersion: pipelines.find((p) => p.id === old)!.version,
    });
    const stage = (name: string) => salesNow.stages.find((st) => st.name === name)!.id;
    return {
      owner,
      sales,
      old,
      fresh: stage('New'),
      proposal: stage('Proposal'),
      lost: stage('Lost'),
    };
  }
  const url = 'https://hooks.example.com/in';
  const needsTheEvents = /only for an endpoint that receives Note added/;
  const notOwners = /active members of this company who use the CRM/;
  const columns = ['note_pipeline_ids', 'note_stage_ids', 'note_deal_owner_ids'] as const;

  it("take the pipelines, stages and owners of notes' deals: refused without note.created, empty, over 50 or naming another company's; named in Settings apart from the deals' and tasks' lists, an archived pipeline, a removed stage and a member who left too; kept by a change that leaves them out and cleared with the event; the database keeps them to it", async () => {
    const c = await fx.company();
    const { owner, sales, old, fresh, proposal, lost } = await crmOf(c);
    const ownerId = owner.membership.id;
    const agent = (await fx.ctx(c, c.agent)).membership.id;
    // A marketer cannot use the CRM, and another company's pipelines, stages and members are not
    // this one's.
    const marketer = (await fx.ctx(c, c.marketer)).membership.id;
    const other = await fx.company();
    const theirs = await crmOf(other);
    const elsewhere = (await fx.ctx(other, other.agent)).membership.id;
    const refused = async (
      eventTypes: string[],
      field: string,
      ids: unknown,
      message: RegExp,
      path = field,
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, [field]: ids }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, `${field} ${JSON.stringify(ids)}`).toBe(
        path,
      );
    };
    // Deal and task events take lists of their own.
    for (const [field, id, noun] of [
      ['notePipelineIds', sales, 'pipeline'],
      ['noteStageIds', proposal, 'stage'],
      ['noteDealOwnerIds', agent, 'member'],
    ] as const) {
      await refused(['deal.created', 'task.created'], field, [id], needsTheEvents);
      await refused(['note.created'], field, [], new RegExp(`at least one ${noun}`));
      await refused(['note.created'], field, ['Sales'], /from the list/, `${field}.0`);
      await refused(
        ['note.created'],
        field,
        Array.from({ length: 51 }, () => uuidv7()),
        /at most 50/,
      );
    }
    await refused(
      ['note.created'],
      'notePipelineIds',
      [sales, theirs.sales],
      /of this company/,
      'notePipelineIds.1',
    );
    await refused(
      ['note.created'],
      'noteStageIds',
      [proposal, theirs.proposal],
      /of this company/,
      'noteStageIds.1',
    );
    await refused(
      ['note.created'],
      'noteDealOwnerIds',
      [agent, marketer],
      notOwners,
      'noteDealOwnerIds.1',
    );
    await refused(
      ['note.created'],
      'noteDealOwnerIds',
      [elsewhere],
      notOwners,
      'noteDealOwnerIds.0',
    );
    expect(await webhooks().list(owner)).toEqual([]);

    // An archived pipeline and a removed stage can be named: both are kept.
    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['note.created', 'deal.created', 'task.created'],
      pipelineIds: [sales],
      taskStageIds: [fresh],
      notePipelineIds: [old, sales.toUpperCase(), old],
      noteStageIds: [lost, proposal],
      noteDealOwnerIds: [agent, ownerId],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: Record<string, unknown> }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
          [c.tenant.id, action],
        )
      ).map((a) => [
        a.metadata.notePipelineIds ?? null,
        a.metadata.noteStageIds ?? null,
        a.metadata.noteDealOwnerIds ?? null,
      ]);
    expect(await audits('webhook.endpoint_created')).toEqual([
      [
        [old, sales],
        [lost, proposal],
        [agent, ownerId],
      ],
    ]);
    const shown = async () => (await webhooks().list(owner)).find((e) => e.id === created.id);
    // The agent is suspended: kept, named as no longer able to own deals.
    await fx.query(`UPDATE app.memberships SET status = 'suspended' WHERE id = $1`, [agent]);
    const view = await shown();
    expect(view?.notePipelines).toEqual([
      { id: old, name: 'Old leads', archived: true },
      { id: sales, name: 'Sales', archived: false },
    ]);
    expect(view?.noteStages).toEqual([
      { id: lost, name: 'Lost', pipelineName: 'Sales', removed: true, pipelineArchived: false },
      {
        id: proposal,
        name: 'Proposal',
        pipelineName: 'Sales',
        removed: false,
        pipelineArchived: false,
      },
    ]);
    expect(view?.noteDealOwners).toEqual([
      { id: agent, name: 'Agent', active: false },
      { id: ownerId, name: 'Owner', active: true },
    ]);
    // The deals' and the tasks' lists are their own.
    expect([
      view?.pipelines,
      view?.stages,
      view?.owners,
      view?.taskPipelines,
      view?.taskStages?.map((st) => st.id),
      view?.taskDealOwners,
    ]).toEqual([[{ id: sales, name: 'Sales', archived: false }], null, null, null, [fresh], null]);
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['note.created', 'deal.created', 'task.created'],
        ...fields,
      });
    const lists = async () => {
      const e = await shown();
      return [
        e?.notePipelines?.map((p) => p.id) ?? null,
        e?.noteStages?.map((st) => st.id) ?? null,
        e?.noteDealOwners?.map((m) => m.id) ?? null,
      ];
    };
    // Left out, the lists are kept; given again, a list keeps the suspended agent it holds, but
    // cannot add a member who cannot use the CRM, nor another company's pipeline or stage.
    await change({ description: 'kept' });
    expect(await lists()).toEqual([
      [old, sales],
      [lost, proposal],
      [agent, ownerId],
    ]);
    await change({ noteDealOwnerIds: [agent, ownerId] });
    await expectAppError(
      change({ noteDealOwnerIds: [agent, marketer] }),
      'validation_failed',
      notOwners,
    );
    await expectAppError(
      change({ notePipelineIds: [theirs.sales] }),
      'validation_failed',
      /of this company/,
    );
    await expectAppError(
      change({ noteStageIds: [theirs.proposal] }),
      'validation_failed',
      /of this company/,
    );
    await change({ notePipelineIds: [sales], noteStageIds: null, noteDealOwnerIds: [ownerId] });
    expect(await lists()).toEqual([[sales], null, [ownerId]]);
    // Dropped, the suspended agent cannot be added back until they can own deals again.
    await expectAppError(change({ noteDealOwnerIds: [agent] }), 'validation_failed', notOwners);
    expect(await audits('webhook.endpoint_updated')).toEqual([
      [
        [old, sales],
        [lost, proposal],
        [agent, ownerId],
      ],
      [
        [old, sales],
        [lost, proposal],
        [agent, ownerId],
      ],
      [[sales], null, [ownerId]],
    ]);
    // The lists stay while the endpoint takes note.created, and go with it.
    await change({ eventTypes: ['note.created'], noteStageIds: [fresh] });
    expect(await lists()).toEqual([[sales], [fresh], [ownerId]]);
    await change({ eventTypes: ['deal.created', 'task.created'] });
    expect(await lists()).toEqual([null, null, null]);
    for (const [field, id] of [
      ['notePipelineIds', sales],
      ['noteStageIds', fresh],
      ['noteDealOwnerIds', ownerId],
    ] as const) {
      await expectAppError(
        change({ eventTypes: ['deal.created'], [field]: [id] }),
        'validation_failed',
        needsTheEvents,
      );
    }
    // The database refuses an empty list, more than 50, a missing id or a list of lists from an
    // endpoint taking note.created…
    await change({ eventTypes: ['note.created'] });
    const setInDatabase = (column: string, value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET ${column} = ${value} WHERE id = $1`, [created.id]);
    const many = `ARRAY[${Array.from({ length: 51 }, () => `'${uuidv7()}'`).join(',')}]::uuid[]`;
    for (const column of columns) {
      for (const bad of [
        `'{}'`,
        many,
        `ARRAY['${sales}', NULL]::uuid[]`,
        `ARRAY[ARRAY['${sales}'::uuid], ARRAY['${fresh}'::uuid]]`,
      ]) {
        await expect(setInDatabase(column, bad), `${column} ${bad}`).rejects.toThrow(
          new RegExp(`webhook_endpoints_${column}`),
        );
      }
      await setInDatabase(column, `ARRAY['${sales}']::uuid[]`);
      const [grant] = await fx.query<{ can_update: boolean }>(
        `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', $1, 'UPDATE')
                AS can_update`,
        [column],
      );
      expect(grant?.can_update, column).toBe(true);
    }
    // …and any list for an endpoint that does not take it.
    await change({ eventTypes: ['deal.created'] });
    expect(await lists()).toEqual([null, null, null]);
    for (const column of columns) {
      await expect(setInDatabase(column, `ARRAY['${sales}']::uuid[]`), column).rejects.toThrow(
        new RegExp(`webhook_endpoints_${column}`),
      );
    }
  });
});

describe('change-maker filters for deal, task and note events (ADR-306)', () => {
  it('are refused without a deal, task or note event, unknown or empty, kept by a change that leaves them out and cleared with the events; the database keeps them to those events', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], crmChangeMakers: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, crmChangeMakers }),
        'validation_failed',
        message,
      );
    // Contact and message events have no maker to choose; a contact makes no CRM change.
    const needsTheEvents = /only for an endpoint that receives deal, task or note events/;
    await refused(['contact.updated', 'message.status'], ['api'], needsTheEvents);
    await refused(['deal.created'], [], /at least one maker/);
    await refused(['task.created'], ['contact'], /from the list/);
    await refused(['note.created'], ['agent'], /from the list/);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['deal.updated', 'consent.changed'],
      crmChangeMakers: ['api', 'member', 'api'],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ crmChangeMakers: ['member', 'api'] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['deal.updated', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.crmChangeMakers;
    expect(await current()).toEqual(['member', 'api']);
    await change({ description: 'kept' });
    expect(await current()).toEqual(['member', 'api']);
    await change({ crmChangeMakers: ['automation'] });
    expect(await current()).toEqual(['automation']);
    const updates = await fx.query<{ metadata: { crmChangeMakers?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.crmChangeMakers)).toEqual([
      ['member', 'api'],
      ['automation'],
    ]);
    await change({ crmChangeMakers: null });
    expect(await current()).toBeNull();
    // Any deal, task or note event keeps the list.
    await change({ crmChangeMakers: ['member'] });
    for (const eventTypes of [['task.status_changed'], ['note.created'], ['deal.owner_changed']]) {
      await change({ eventTypes });
      expect(await current(), eventTypes[0]).toEqual(['member']);
    }
    // The database refuses an empty list, more than three entries, an unknown maker or a missing one
    // from an endpoint taking those events…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET crm_change_makers = ${value} WHERE id = $1`, [
        created.id,
      ]);
    for (const bad of [
      `'{}'`,
      `'{member,automation,api,api}'`,
      `'{api,contact}'`,
      `'{api,agent}'`,
      `ARRAY['api', NULL]::text[]`,
      `ARRAY[ARRAY['api'], ARRAY['member']]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_crm_change_makers/);
    }
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['consent.changed'], crmChangeMakers: ['api'] }),
      'validation_failed',
      needsTheEvents,
    );
    // …and any list for an endpoint that does not take them, contact events included.
    await change({ eventTypes: ['contact.updated'] });
    await expect(setInDatabase(`'{api}'`)).rejects.toThrow(/webhook_endpoints_crm_change_makers/);
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'crm_change_makers',
                'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });
});

describe('score filters for satisfaction survey answers (ADR-307)', () => {
  it('are refused without the event, unknown or empty, kept by a change that leaves them out and cleared with the event; the database keeps them to that event', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], surveyScores: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, surveyScores }),
        'validation_failed',
        message,
      );
    // A resolved conversation has no score to choose.
    const needsTheEvent = /only for an endpoint that receives Satisfaction survey answered/;
    await refused(['conversation.status_changed'], [1], needsTheEvent);
    await refused(['satisfaction_survey.answered'], [], /at least one score/);
    await refused(['satisfaction_survey.answered'], [4], /from the list/);
    await refused(['satisfaction_survey.answered'], ['3'], /from the list/);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['satisfaction_survey.answered', 'consent.changed'],
      surveyScores: [1, 2, 1],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ surveyScores: [2, 1] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['satisfaction_survey.answered', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.surveyScores;
    expect(await current()).toEqual([2, 1]);
    await change({ description: 'kept' });
    expect(await current()).toEqual([2, 1]);
    await change({ surveyScores: [1] });
    expect(await current()).toEqual([1]);
    const updates = await fx.query<{ metadata: { surveyScores?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.surveyScores)).toEqual([[2, 1], [1]]);
    await change({ surveyScores: null });
    expect(await current()).toBeNull();
    await change({ surveyScores: [3] });
    // The database refuses an empty list, more than three entries, an unknown score or a missing
    // one from an endpoint taking the event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET survey_scores = ${value} WHERE id = $1`, [
        created.id,
      ]);
    for (const bad of [
      `'{}'`,
      `'{1,2,3,3}'`,
      `'{0}'`,
      `'{3,4}'`,
      `ARRAY[3, NULL]::smallint[]`,
      `ARRAY[ARRAY[3], ARRAY[1]]::smallint[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_survey_scores/);
    }
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['consent.changed'], surveyScores: [1] }),
      'validation_failed',
      needsTheEvent,
    );
    // …and any list for an endpoint that does not take it.
    await change({ eventTypes: ['conversation.status_changed'] });
    await expect(setInDatabase(`'{1}'`)).rejects.toThrow(/webhook_endpoints_survey_scores/);
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'survey_scores',
                'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });
});

describe('survey member and team filters (ADR-311)', () => {
  /** A team of the company, written as the teams settings write one. */
  async function teamOf(c: Company, name: string) {
    const id = uuidv7();
    await fx.query('INSERT INTO app.teams (id, tenant_id, name) VALUES ($1, $2, $3)', [
      id,
      c.tenant.id,
      name,
    ]);
    return id;
  }

  it("are refused without satisfaction_survey.answered, empty, over 50, naming a member who takes no conversations or another company's team; kept by a change that leaves them out, a member who stopped and a deleted team included, and cleared with the event; the database keeps them to the event", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = (await fx.ctx(c, c.agent)).membership.id;
    const ownerId = owner.membership.id;
    // A marketer answers no conversations, and another company's member and team are not this
    // one's.
    const marketer = (await fx.ctx(c, c.marketer)).membership.id;
    const other = await fx.company();
    const elsewhere = (await fx.ctx(other, other.agent)).membership.id;
    const support = await teamOf(c, 'Support');
    const sales = await teamOf(c, 'Sales');
    const otherTeam = await teamOf(other, 'Support');
    const url = 'https://hooks.example.com/in';
    const refused = async (
      fields: Record<string, unknown>,
      message: RegExp,
      path: string,
      eventTypes = ['satisfaction_survey.answered'],
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, ...fields }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(fields)).toBe(path);
    };
    // Conversations' events take the conversations' lists, not the answers'.
    const conversationEvents = ['message.received', 'conversation.status_changed'];
    await refused(
      { surveyAssigneeIds: [agent] },
      /members credited with answers only for an endpoint that receives Satisfaction survey answered/,
      'surveyAssigneeIds',
      conversationEvents,
    );
    await refused(
      { surveyTeamIds: [support] },
      /teams of answered surveys only for an endpoint that receives Satisfaction survey answered/,
      'surveyTeamIds',
      conversationEvents,
    );
    await refused({ surveyAssigneeIds: [] }, /at least one member/, 'surveyAssigneeIds');
    await refused({ surveyTeamIds: [] }, /at least one team/, 'surveyTeamIds');
    await refused({ surveyAssigneeIds: ['agent'] }, /from the list/, 'surveyAssigneeIds.0');
    await refused(
      { surveyTeamIds: Array.from({ length: 51 }, () => uuidv7()) },
      /at most 50/,
      'surveyTeamIds',
    );
    const takesNone = /members of this company who take conversations/;
    await refused({ surveyAssigneeIds: [agent, marketer] }, takesNone, 'surveyAssigneeIds.1');
    await refused({ surveyAssigneeIds: [agent, elsewhere] }, takesNone, 'surveyAssigneeIds.1');
    await refused({ surveyTeamIds: [support, otherTeam] }, /of this company/, 'surveyTeamIds.1');
    await refused({ surveyTeamIds: [uuidv7()] }, /of this company/, 'surveyTeamIds.0');
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['satisfaction_survey.answered', 'consent.changed'],
      surveyAssigneeIds: [agent, ownerId.toUpperCase(), agent],
      surveyTeamIds: [sales, support],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { surveyAssigneeIds?: unknown; surveyTeamIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
          [c.tenant.id, action],
        )
      ).map((a) => [a.metadata.surveyAssigneeIds, a.metadata.surveyTeamIds]);
    expect(await audits('webhook.endpoint_created')).toEqual([
      [
        [agent, ownerId],
        [sales, support],
      ],
    ]);
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['satisfaction_survey.answered', 'consent.changed'],
        ...fields,
      });
    const current = async () => {
      const endpoint = (await webhooks().list(owner)).find((e) => e.id === created.id);
      return { members: endpoint?.surveyAssignees, teams: endpoint?.surveyTeams };
    };
    expect(await current()).toEqual({
      members: [
        { id: agent, name: 'Agent', assignable: true },
        { id: ownerId, name: 'Owner', assignable: true },
      ],
      teams: [
        { id: sales, name: 'Sales' },
        { id: support, name: 'Support' },
      ],
    });
    // The conversations' own lists are not set by them.
    const listed = (await webhooks().list(owner)).find((e) => e.id === created.id);
    expect([listed?.assignees, listed?.teams]).toEqual([null, null]);
    await change({ description: 'kept' });
    expect(await current()).toMatchObject({
      members: [{ id: agent }, { id: ownerId }],
      teams: [{ id: sales }, { id: support }],
    });
    // A member who stops taking conversations and a team deleted since stay on the lists, and lists
    // given again may keep them; one the lists did not hold is refused.
    await fx.query(`UPDATE app.memberships SET roles = '{marketer}' WHERE id = $1`, [agent]);
    await fx.query('DELETE FROM app.teams WHERE id = $1', [sales]);
    expect(await current()).toEqual({
      members: [
        { id: agent, name: 'Agent', assignable: false },
        { id: ownerId, name: 'Owner', assignable: true },
      ],
      teams: [
        { id: sales, name: null },
        { id: support, name: 'Support' },
      ],
    });
    await change({ surveyAssigneeIds: [ownerId, agent], surveyTeamIds: [support, sales] });
    expect(await current()).toMatchObject({
      members: [{ id: ownerId }, { id: agent }],
      teams: [{ id: support }, { id: sales }],
    });
    await expectAppError(
      change({ surveyAssigneeIds: [ownerId, marketer] }),
      'validation_failed',
      takesNone,
    );
    const gone = await teamOf(c, 'Gone');
    await fx.query('DELETE FROM app.teams WHERE id = $1', [gone]);
    await expectAppError(
      change({ surveyTeamIds: [support, gone] }),
      'validation_failed',
      /of this company/,
    );
    expect(await audits('webhook.endpoint_updated')).toEqual([
      [
        [agent, ownerId],
        [sales, support],
      ],
      [
        [ownerId, agent],
        [support, sales],
      ],
    ]);
    await change({ surveyAssigneeIds: null, surveyTeamIds: null });
    expect(await current()).toEqual({ members: null, teams: null });
    await change({ surveyAssigneeIds: [ownerId], surveyTeamIds: [support] });
    // The database refuses an empty list, more than 50, a missing id or a list of lists…
    const setInDatabase = (column: string, value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET ${column} = ${value} WHERE id = $1`, [created.id]);
    const many = `ARRAY[${Array.from({ length: 51 }, () => `'${uuidv7()}'`).join(',')}]::uuid[]`;
    for (const column of ['survey_assignee_ids', 'survey_team_ids']) {
      for (const bad of [
        `'{}'`,
        many,
        `ARRAY['${ownerId}', NULL]::uuid[]`,
        `ARRAY[['${ownerId}']]::uuid[]`,
      ]) {
        await expect(setInDatabase(column, bad), `${column} ${bad}`).rejects.toThrow(
          new RegExp(`webhook_endpoints_${column}`),
        );
      }
    }
    // …leaving the event clears both lists…
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toEqual({ members: null, teams: null });
    await expectAppError(
      change({ eventTypes: ['consent.changed'], surveyTeamIds: [support] }),
      'validation_failed',
      /teams of answered surveys only/,
    );
    // …and the database refuses either list for an endpoint that does not take the event.
    for (const column of ['survey_assignee_ids', 'survey_team_ids']) {
      await expect(setInDatabase(column, `ARRAY['${ownerId}']::uuid[]`)).rejects.toThrow(
        new RegExp(`webhook_endpoints_${column}`),
      );
    }
    // The company role changes the lists only through their column grants.
    for (const column of ['survey_assignee_ids', 'survey_team_ids']) {
      const [grant] = await fx.query<{ can_update: boolean }>(
        `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', $1, 'UPDATE')
                  AS can_update`,
        [column],
      );
      expect(grant?.can_update, column).toBe(true);
    }
  });
});

describe('survey tag filters (ADR-312)', () => {
  it('are refused without satisfaction_survey.answered, empty, over 50 or not as tags are written; kept as contacts and conversations carry them, kept by a change that leaves them out and cleared with the event; the database keeps them to the event and to tags as they are written', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = async (
      fields: Record<string, unknown>,
      message: RegExp,
      path: string,
      eventTypes = ['satisfaction_survey.answered'],
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, ...fields }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(fields)).toBe(path);
    };
    // Conversations' events take the conversations' tag lists, not the answers'.
    const conversationEvents = ['message.received', 'conversation.status_changed'];
    await refused(
      { surveyContactTags: ['vip'] },
      /contact tags of answered surveys only for an endpoint that receives Satisfaction survey answered/,
      'surveyContactTags',
      conversationEvents,
    );
    await refused(
      { surveyConversationTags: ['refund'] },
      /conversation tags of answered surveys only for an endpoint that receives Satisfaction survey answered/,
      'surveyConversationTags',
      conversationEvents,
    );
    await refused(
      { surveyContactTags: [] },
      /at least one tag, or take every answer/,
      'surveyContactTags',
    );
    await refused(
      { surveyConversationTags: ['refund', 'a,b'] },
      /commas/,
      'surveyConversationTags.1',
    );
    await refused(
      { surveyContactTags: Array.from({ length: 51 }, (_, i) => `tag ${i}`) },
      /at most 50/,
      'surveyContactTags',
    );
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['satisfaction_survey.answered', 'message.received'],
      surveyContactTags: ['VIP', ' vip', 'Gold   Member'],
      surveyConversationTags: ['Refund'],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{
          metadata: { surveyContactTags?: unknown; surveyConversationTags?: unknown };
        }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
          [c.tenant.id, action],
        )
      ).map((a) => [a.metadata.surveyContactTags, a.metadata.surveyConversationTags]);
    expect(await audits('webhook.endpoint_created')).toEqual([
      [['vip', 'gold member'], ['refund']],
    ]);
    const current = async () => {
      const endpoint = (await webhooks().list(owner)).find((e) => e.id === created.id);
      return {
        contact: endpoint?.surveyContactTags,
        conversation: endpoint?.surveyConversationTags,
      };
    };
    expect(await current()).toEqual({ contact: ['vip', 'gold member'], conversation: ['refund'] });
    // The conversations' own tag lists are not set by them.
    const listed = (await webhooks().list(owner)).find((e) => e.id === created.id);
    expect([listed?.contactTags, listed?.conversationTags]).toEqual([null, null]);
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['satisfaction_survey.answered', 'message.received'],
        ...fields,
      });
    await change({ description: 'kept' });
    expect(await current()).toEqual({ contact: ['vip', 'gold member'], conversation: ['refund'] });
    await change({ surveyContactTags: ['Gold'] });
    expect(await current()).toEqual({ contact: ['gold'], conversation: ['refund'] });
    await change({ surveyContactTags: null, surveyConversationTags: null });
    expect(await current()).toEqual({ contact: null, conversation: null });
    await change({ surveyContactTags: ['gold'], surveyConversationTags: ['refund'] });
    expect(await audits('webhook.endpoint_updated')).toEqual([
      [['vip', 'gold member'], ['refund']],
      [['gold'], ['refund']],
      [undefined, undefined],
      [['gold'], ['refund']],
    ]);
    // The database refuses an empty list, more than 50, a missing tag, a list of lists, and tags
    // not as they are written (capitals, a comma, spaces around, over 40 characters, a control
    // character, an empty tag)…
    const setInDatabase = (column: string, value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET ${column} = ${value} WHERE id = $1`, [created.id]);
    const many = `ARRAY[${Array.from({ length: 51 }, (_, i) => `'tag ${i}'`).join(',')}]`;
    for (const column of ['survey_contact_tags', 'survey_conversation_tags']) {
      for (const bad of [
        `'{}'::text[]`,
        many,
        `ARRAY['vip', NULL]`,
        `ARRAY[ARRAY['vip'], ARRAY['gold']]`,
        `ARRAY['VIP']`,
        `ARRAY['gold', 'a,b']`,
        `ARRAY[' vip']`,
        `ARRAY['vip ']`,
        `ARRAY['${'x'.repeat(41)}']`,
        `ARRAY[E'vi\\tp']`,
        `ARRAY['vip', '']`,
      ]) {
        await expect(setInDatabase(column, bad), `${column} ${bad}`).rejects.toThrow(
          new RegExp(`webhook_endpoints_${column}`),
        );
      }
      // Tags as they are written, spaces inside and 40 characters included, are kept.
      await setInDatabase(column, `ARRAY['gold member', '${'x'.repeat(40)}', 'vip']`);
    }
    expect(await current()).toEqual({
      contact: ['gold member', 'x'.repeat(40), 'vip'],
      conversation: ['gold member', 'x'.repeat(40), 'vip'],
    });
    // …leaving the event clears both lists…
    await change({ eventTypes: ['message.received'] });
    expect(await current()).toEqual({ contact: null, conversation: null });
    await expectAppError(
      change({ eventTypes: ['message.received'], surveyContactTags: ['vip'] }),
      'validation_failed',
      /contact tags of answered surveys only/,
    );
    // …and the database refuses either list for an endpoint that does not take the event.
    for (const column of ['survey_contact_tags', 'survey_conversation_tags']) {
      await expect(setInDatabase(column, `ARRAY['vip']`)).rejects.toThrow(
        new RegExp(`webhook_endpoints_${column}`),
      );
      const [grant] = await fx.query<{ can_update: boolean }>(
        `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', $1, 'UPDATE')
                  AS can_update`,
        [column],
      );
      expect(grant?.can_update, column).toBe(true);
    }
  });
});

describe('contact event tag filters (ADR-316)', () => {
  it('are refused without contact.created or contact.updated, empty, over 50 or not as tags are written; kept as contacts carry them, kept by a change that leaves them out and cleared with both events; the database keeps them to the events and to tags as they are written', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = async (
      fields: Record<string, unknown>,
      message: RegExp,
      path: string,
      eventTypes = ['contact.updated'],
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, ...fields }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(fields)).toBe(path);
    };
    // Erased and merged contacts, and conversations' events, take no such list.
    await refused(
      { contactEventTags: ['vip'] },
      /tags of added and changed contacts only for an endpoint that receives Contact added or Contact changed/,
      'contactEventTags',
      ['contact.erased', 'contact.merged', 'message.received'],
    );
    await refused(
      { contactEventTags: [] },
      /at least one tag, or take every contact/,
      'contactEventTags',
    );
    await refused({ contactEventTags: ['vip', 'a,b'] }, /commas/, 'contactEventTags.1');
    await refused(
      { contactEventTags: Array.from({ length: 51 }, (_, i) => `tag ${i}`) },
      /at most 50/,
      'contactEventTags',
    );
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['contact.created', 'contact.updated', 'contact.erased'],
      contactEventTags: ['VIP', ' vip', 'Gold   Member'],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { contactEventTags?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
          [c.tenant.id, action],
        )
      ).map((a) => a.metadata.contactEventTags);
    expect(await audits('webhook.endpoint_created')).toEqual([['vip', 'gold member']]);
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.contactEventTags;
    expect(await current()).toEqual(['vip', 'gold member']);
    // The other tag lists are not set by it.
    const listed = (await webhooks().list(owner)).find((e) => e.id === created.id);
    expect([listed?.contactTags, listed?.surveyContactTags]).toEqual([null, null]);
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['contact.created', 'contact.updated', 'contact.erased'],
        ...fields,
      });
    await change({ description: 'kept' });
    expect(await current()).toEqual(['vip', 'gold member']);
    await change({ contactEventTags: ['Gold'] });
    expect(await current()).toEqual(['gold']);
    // Either event keeps the list.
    await change({ eventTypes: ['contact.created'] });
    expect(await current()).toEqual(['gold']);
    await change({ eventTypes: ['contact.updated'], contactEventTags: ['vip'] });
    expect(await current()).toEqual(['vip']);
    await change({ eventTypes: ['contact.updated'], contactEventTags: null });
    expect(await current()).toBeNull();
    await change({ eventTypes: ['contact.updated'], contactEventTags: ['gold'] });
    expect(await audits('webhook.endpoint_updated')).toEqual([
      ['vip', 'gold member'],
      ['gold'],
      ['gold'],
      ['vip'],
      undefined,
      ['gold'],
    ]);
    // The database refuses an empty list, more than 50, a missing tag, a list of lists, and tags
    // not as they are written…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET contact_event_tags = ${value} WHERE id = $1`, [
        created.id,
      ]);
    const many = `ARRAY[${Array.from({ length: 51 }, (_, i) => `'tag ${i}'`).join(',')}]`;
    for (const bad of [
      `'{}'::text[]`,
      many,
      `ARRAY['vip', NULL]`,
      `ARRAY[ARRAY['vip'], ARRAY['gold']]`,
      `ARRAY['VIP']`,
      `ARRAY['gold', 'a,b']`,
      `ARRAY[' vip']`,
      `ARRAY['vip ']`,
      `ARRAY['${'x'.repeat(41)}']`,
      `ARRAY[E'vi\\tp']`,
      `ARRAY['vip', '']`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_contact_event_tags/);
    }
    // Tags as they are written, spaces inside and 40 characters included, are kept.
    await setInDatabase(`ARRAY['gold member', '${'x'.repeat(40)}', 'vip']`);
    expect(await current()).toEqual(['gold member', 'x'.repeat(40), 'vip']);
    // …leaving both events clears the list…
    await change({ eventTypes: ['contact.erased'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['contact.erased'], contactEventTags: ['vip'] }),
      'validation_failed',
      /tags of added and changed contacts only/,
    );
    // …and the database refuses it for an endpoint that takes neither.
    await expect(setInDatabase(`ARRAY['vip']`)).rejects.toThrow(
      /webhook_endpoints_contact_event_tags/,
    );
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'contact_event_tags',
                'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });
});

describe('contact event field value filters (ADR-332)', () => {
  it('are refused without contact.created or contact.updated, empty, over 50, of a field the company does not have or of another type; kept as the field reads them, kept by a change that leaves them out, a deleted field’s included, and cleared with both events; the database keeps them to the events and to pairs of a key and a value', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const fieldOf = (company: Company, key: string, label: string, type: string) =>
      fx.query(
        `INSERT INTO app.contact_fields (id, tenant_id, key, label, type) VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), company.tenant.id, key, label, type],
      );
    await fieldOf(c, 'tier', 'Tier', 'text');
    await fieldOf(c, 'score', 'Score', 'number');
    await fieldOf(c, 'vip', 'VIP', 'boolean');
    await fieldOf(c, 'joined', 'Joined', 'date');
    const url = 'https://hooks.example.com/in';
    const refused = async (
      fields: Record<string, unknown>,
      message: RegExp,
      path: string,
      eventTypes = ['contact.updated'],
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, ...fields }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(fields)).toBe(path);
    };
    const gold = [{ key: 'tier', value: 'gold' }];
    // Erased and merged contacts, and conversations' events, take no such list.
    await refused(
      { contactEventFieldValues: gold },
      /field values of added and changed contacts only for an endpoint that receives Contact added or Contact changed/,
      'contactEventFieldValues',
      ['contact.erased', 'contact.merged', 'message.received'],
    );
    await refused(
      { contactEventFieldValues: [] },
      /at least one value, or take every contact/,
      'contactEventFieldValues',
    );
    await refused(
      {
        contactEventFieldValues: Array.from({ length: 51 }, (_, i) => ({
          key: 'tier',
          value: `t${i}`,
        })),
      },
      /at most 50/,
      'contactEventFieldValues',
    );
    await refused(
      { contactEventFieldValues: [...gold, { key: 'city', value: 'Chennai' }] },
      /Choose fields of this company/,
      'contactEventFieldValues.1.key',
    );
    // Values past the list's 4,000 bytes (ADR-332) are refused before any write.
    await refused(
      {
        contactEventFieldValues: Array.from({ length: 50 }, (_, i) => ({
          key: 'tier',
          value: `${i}`.padEnd(500, 'x'),
        })),
      },
      /at most 4,000 bytes in all/,
      'contactEventFieldValues',
    );
    // Another company's field is not this company's.
    await fieldOf(await fx.company(), 'zone', 'Zone', 'text');
    await refused(
      { contactEventFieldValues: [{ key: 'zone', value: 'north' }] },
      /Choose fields of this company/,
      'contactEventFieldValues.0.key',
    );
    await refused(
      { contactEventFieldValues: [{ key: 'score', value: '5' }] },
      /Score takes a number/,
      'contactEventFieldValues.0.value',
    );
    await refused(
      { contactEventFieldValues: [{ key: 'tier', value: '  ' }] },
      /Give a value of Tier to match/,
      'contactEventFieldValues.0.value',
    );
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['contact.created', 'contact.updated', 'contact.erased'],
      contactEventFieldValues: [
        { key: 'tier', value: ' Gold ' },
        { key: 'tier', value: 'gold' },
        { key: 'score', value: 5 },
        { key: 'vip', value: true },
        { key: 'joined', value: '2026-01-31' },
      ],
    });
    const stored = [
      { key: 'tier', value: 'Gold' },
      { key: 'score', value: 5 },
      { key: 'vip', value: true },
      { key: 'joined', value: '2026-01-31' },
    ];
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { contactEventFieldValues?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
          [c.tenant.id, action],
        )
      ).map((a) => a.metadata.contactEventFieldValues);
    expect(await audits('webhook.endpoint_created')).toEqual([stored]);
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.contactEventFieldValues;
    expect(await current()).toEqual(stored);
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['contact.created', 'contact.updated', 'contact.erased'],
        ...fields,
      });
    await change({ description: 'kept' });
    expect(await current()).toEqual(stored);
    await change({ contactEventFieldValues: [{ key: 'tier', value: 'Silver' }] });
    expect(await current()).toEqual([{ key: 'tier', value: 'Silver' }]);
    // Either event keeps the list.
    await change({ eventTypes: ['contact.created'] });
    expect(await current()).toEqual([{ key: 'tier', value: 'Silver' }]);
    await change({ eventTypes: ['contact.updated'], contactEventFieldValues: null });
    expect(await current()).toBeNull();
    await change({
      eventTypes: ['contact.updated'],
      contactEventFieldValues: [
        { key: 'joined', value: '2026-01-31' },
        { key: 'vip', value: false },
      ],
    });
    // A deleted field's pair stays, and may be kept as it was, but not added again.
    await fx.query(`DELETE FROM app.contact_fields WHERE tenant_id = $1 AND key = 'joined'`, [
      c.tenant.id,
    ]);
    expect(await current()).toEqual([
      { key: 'joined', value: '2026-01-31' },
      { key: 'vip', value: false },
    ]);
    await change({
      eventTypes: ['contact.updated'],
      contactEventFieldValues: [
        { key: 'vip', value: false },
        { key: 'joined', value: '2026-01-31' },
      ],
    });
    expect(await current()).toEqual([
      { key: 'vip', value: false },
      { key: 'joined', value: '2026-01-31' },
    ]);
    await expectAppError(
      change({
        eventTypes: ['contact.updated'],
        contactEventFieldValues: [{ key: 'joined', value: '2026-02-01' }],
      }),
      'validation_failed',
      /Choose fields of this company/,
    );
    expect(await audits('webhook.endpoint_updated')).toEqual([
      stored,
      [{ key: 'tier', value: 'Silver' }],
      [{ key: 'tier', value: 'Silver' }],
      undefined,
      [
        { key: 'joined', value: '2026-01-31' },
        { key: 'vip', value: false },
      ],
      [
        { key: 'vip', value: false },
        { key: 'joined', value: '2026-01-31' },
      ],
    ]);
    // The database refuses a list that is not an array of 1 to 50 pairs of a field's key and
    // text of 1 to 500 characters without spaces around it, a number or a boolean…
    const setInDatabase = (value: string) =>
      fx.query(
        `UPDATE app.webhook_endpoints SET contact_event_field_values = $2::jsonb WHERE id = $1`,
        [created.id, value],
      );
    const pair = (value: unknown, key = 'tier') => JSON.stringify([{ key, value }]);
    for (const bad of [
      '{"tier": "gold"}',
      '"gold"',
      '[]',
      JSON.stringify(Array.from({ length: 51 }, (_, i) => ({ key: 'tier', value: `t${i}` }))),
      '["tier"]',
      '[{"key": "tier"}]',
      '[{"key": "tier", "value": "gold", "op": "eq"}]',
      pair('gold', 'Tier'),
      pair('gold', '1tier'),
      '[{"key": 5, "value": "gold"}]',
      pair(null),
      pair(['gold']),
      pair({ is: 'gold' }),
      pair(''),
      pair(' gold'),
      pair('gold\n'),
      pair('x'.repeat(501)),
      // More than 4,500 bytes as PostgreSQL writes the list out.
      JSON.stringify(
        Array.from({ length: 10 }, (_, i) => ({ key: 'tier', value: `${i}`.padEnd(450, 'x') })),
      ),
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(
        /webhook_endpoints_contact_event_field_values/,
      );
    }
    // Pairs of any field, text of 500 characters, numbers and booleans are kept.
    const kept = [
      { key: 'tier', value: 'x'.repeat(500) },
      { key: 'score', value: 2.5 },
      { key: 'vip', value: true },
      { key: 'city', value: 'São Paulo' },
    ];
    await setInDatabase(JSON.stringify(kept));
    expect(await current()).toEqual(kept);
    // …leaving both events clears the list…
    await change({ eventTypes: ['contact.erased'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['contact.erased'], contactEventFieldValues: gold }),
      'validation_failed',
      /field values of added and changed contacts only/,
    );
    // …and the database refuses it for an endpoint that takes neither.
    await expect(setInDatabase(JSON.stringify(gold))).rejects.toThrow(
      /webhook_endpoints_contact_event_field_values/,
    );
    const [grants] = await fx.query<{ app_updates: boolean; definer_reads_source: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints',
                'contact_event_field_values', 'UPDATE') AS app_updates,
              has_column_privilege('w360_definer', 'app.contacts', 'source', 'SELECT')
                AS definer_reads_source`,
    );
    expect(grants).toEqual({ app_updates: true, definer_reads_source: true });
  });

  it('save and audit a list of values up to the 4,000 bytes the list takes', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await fx.query(
      `INSERT INTO app.contact_fields (id, tenant_id, key, label, type) VALUES ($1, $2, 'tier', 'Tier', 'text')`,
      [uuidv7(), c.tenant.id],
    );
    // Eight values of 473 characters: 3,993 bytes as JSON, the most of its kind the list takes.
    const long = Array.from({ length: 8 }, (_, i) => ({
      key: 'tier',
      value: `${i}`.padEnd(473, 'x'),
    }));
    expect(new TextEncoder().encode(JSON.stringify(long)).length).toBe(3993);
    const url = 'https://hooks.example.com/in';
    const eventTypes = ['contact.created', 'contact.updated'];
    const created = await webhooks().create(owner, {
      url,
      eventTypes,
      contactEventFieldValues: long,
      contactEventTags: Array.from({ length: 50 }, (_, i) => `tag ${i}`.padEnd(40, 'x')),
    });
    await webhooks().update(owner, {
      endpointId: created.id,
      url,
      description: 'Long values',
      eventTypes,
    });
    const audits = await fx.query<{ action: string; values: unknown }>(
      `SELECT action, metadata -> 'contactEventFieldValues' AS values FROM app.audit_events
        WHERE tenant_id = $1 AND action LIKE 'webhook.endpoint_%' ORDER BY occurred_at, id`,
      [c.tenant.id],
    );
    expect(audits).toEqual([
      { action: 'webhook.endpoint_created', values: long },
      { action: 'webhook.endpoint_updated', values: long },
    ]);
    expect(
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.contactEventFieldValues,
    ).toEqual(long);
  });
});
describe('endpoint audit entries within an audit entry’s 8 KiB (ADR-336)', () => {
  it('save an endpoint whose lists would not fit its audit entry, the entry naming the largest by count and keeping the others', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    // Tags of 36 Tamil letters and four digits, 112 bytes each: five lists of 50 take about
    // 29,000 bytes, which an audit entry's 8 KiB refused, rolling the change back, before ADR-336.
    const tags = (list: number) =>
      Array.from({ length: 50 }, (_, i) => `${'க'.repeat(36)}${list}${String(i).padStart(3, '0')}`);
    const lists = {
      contactTags: tags(1),
      conversationTags: tags(2),
      contactEventTags: tags(3),
      surveyContactTags: tags(4),
      surveyConversationTags: tags(5),
    };
    const url = 'https://hooks.example.com/in';
    const eventTypes = ['message.received', 'contact.updated', 'satisfaction_survey.answered'];
    const created = await webhooks().create(owner, { url, eventTypes, ...lists });
    await webhooks().update(owner, {
      endpointId: created.id,
      url,
      description: 'Tamil tags',
      eventTypes,
    });
    // The endpoint keeps every list whole.
    expect((await webhooks().list(owner)).find((e) => e.id === created.id)).toMatchObject(lists);
    // A change of a list named by count changes its digest alone.
    const otherTags = tags(6);
    await webhooks().update(owner, {
      endpointId: created.id,
      url,
      eventTypes,
      contactTags: otherTags,
    });
    const audits = await fx.query<{
      action: string;
      metadata: Record<string, unknown>;
      bytes: number;
    }>(
      `SELECT action, metadata, pg_column_size(metadata::text::jsonb) AS bytes FROM app.audit_events
        WHERE tenant_id = $1 AND action LIKE 'webhook.endpoint_%' ORDER BY occurred_at, id`,
      [c.tenant.id],
    );
    expect(audits.map((a) => a.action)).toEqual([
      'webhook.endpoint_created',
      'webhook.endpoint_updated',
      'webhook.endpoint_updated',
    ]);
    const digest = (list: string[]) => sha256Hex(JSON.stringify(list)).slice(0, 16);
    const digests = {
      contactEventTags: digest(lists.contactEventTags),
      contactTags: digest(lists.contactTags),
      conversationTags: digest(lists.conversationTags),
      surveyContactTags: digest(lists.surveyContactTags),
    };
    for (const [index, audit] of audits.entries()) {
      // The count takes no fewer bytes than PostgreSQL does, uncompressed, and the entry fits.
      expect(audit.bytes).toBeLessThanOrEqual(jsonbSize(audit.metadata));
      expect(jsonbSize(audit.metadata)).toBeLessThanOrEqual(WEBHOOK_LIMITS.auditMetadataBytes);
      // Four lists as large named by count and digest, by name; the fifth whole, with the events
      // and the host.
      expect(audit.metadata).toMatchObject({
        host: 'hooks.example.com',
        listCounts: {
          contactEventTags: 50,
          contactTags: 50,
          conversationTags: 50,
          surveyContactTags: 50,
        },
        listDigests: index < 2 ? digests : { ...digests, contactTags: digest(otherTags) },
        surveyConversationTags: lists.surveyConversationTags,
      });
      expect(audit.metadata.eventTypes).toHaveLength(3);
      for (const counted of ['contactEventTags', 'contactTags', 'conversationTags']) {
        expect(audit.metadata).not.toHaveProperty(counted);
      }
    }
    expect(digest(otherTags)).not.toBe(digests.contactTags);
  });
});
describe('contact event field words and ranges (ADR-335)', () => {
  it('keep words of text fields and ranges of number and date fields as the fields read them, refuse them for other fields or out of order; the database keeps them to one shape a condition', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const fieldOf = (key: string, label: string, type: string) =>
      fx.query(
        `INSERT INTO app.contact_fields (id, tenant_id, key, label, type) VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), c.tenant.id, key, label, type],
      );
    await fieldOf('city', 'City', 'text');
    await fieldOf('score', 'Score', 'number');
    await fieldOf('renewal', 'Renewal', 'date');
    await fieldOf('vip', 'VIP', 'boolean');
    const url = 'https://hooks.example.com/in';
    const refused = async (contactEventFieldValues: unknown[], message: RegExp, path: string) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes: ['contact.updated'], contactEventFieldValues }),
        'validation_failed',
        message,
      );
      expect(
        isAppError(error) && error.issues?.[0]?.path,
        JSON.stringify(contactEventFieldValues),
      ).toBe(path);
    };
    await refused(
      [{ key: 'score', contains: '5' }],
      /Score is not a text field/,
      'contactEventFieldValues.0.contains',
    );
    await refused(
      [{ key: 'city', atLeast: 'a' }],
      /City takes no range/,
      'contactEventFieldValues.0',
    );
    await refused(
      [{ key: 'score', atLeast: 10, atMost: 9 }],
      /must start at or before its end/,
      'contactEventFieldValues.0',
    );
    await refused(
      [{ key: 'renewal', atLeast: '2026-02-30' }],
      /Renewal must be a date/,
      'contactEventFieldValues.0.atLeast',
    );
    await refused(
      [{ key: 'city', value: 'Chennai', contains: 'chen' }],
      /not more than one/,
      'contactEventFieldValues.0',
    );
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['contact.created', 'contact.updated'],
      contactEventFieldValues: [
        { key: 'city', value: 'Chennai' },
        { key: 'city', contains: ' Chen ' },
        { key: 'city', contains: 'CHEN' },
        { key: 'score', atLeast: 10 },
        { key: 'score', atLeast: 1, atMost: 5 },
        { key: 'renewal', atLeast: '2026-10-01', atMost: '2026-10-31' },
        { key: 'vip', value: true },
      ],
    });
    const stored = [
      { key: 'city', value: 'Chennai' },
      { key: 'city', contains: 'Chen' },
      { key: 'score', atLeast: 10 },
      { key: 'score', atLeast: 1, atMost: 5 },
      { key: 'renewal', atLeast: '2026-10-01', atMost: '2026-10-31' },
      { key: 'vip', value: true },
    ];
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.contactEventFieldValues;
    expect(await current()).toEqual(stored);
    const [audit] = await fx.query<{ metadata: { contactEventFieldValues?: unknown } }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata.contactEventFieldValues).toEqual(stored);
    // A word or range the endpoint holds stays as it was after its field is deleted.
    await fx.query(`DELETE FROM app.contact_fields WHERE tenant_id = $1 AND key = 'score'`, [
      c.tenant.id,
    ]);
    await webhooks().update(owner, {
      endpointId: created.id,
      url,
      description: 'kept',
      eventTypes: ['contact.updated'],
      contactEventFieldValues: [
        { key: 'score', atLeast: 1, atMost: 5 },
        { key: 'city', contains: 'chen' },
      ],
    });
    expect(await current()).toEqual([
      { key: 'score', atLeast: 1, atMost: 5 },
      { key: 'city', contains: 'chen' },
    ]);

    // The database refuses a condition that is not of one shape, or whose members are not of it…
    const setInDatabase = (value: string) =>
      fx.query(
        `UPDATE app.webhook_endpoints SET contact_event_field_values = $2::jsonb WHERE id = $1`,
        [created.id, value],
      );
    const one = (condition: Record<string, unknown>) =>
      JSON.stringify([{ key: 'score', ...condition }]);
    for (const bad of [
      one({}),
      one({ value: 5, atLeast: 1 }),
      one({ value: 'chen', contains: 'chen' }),
      one({ contains: 'chen', atMost: 5 }),
      one({ min: 5 }),
      one({ atLeast: 1, op: 'gte' }),
      one({ contains: 5 }),
      one({ contains: '' }),
      one({ contains: ' chen' }),
      one({ contains: ['chen'] }),
      one({ contains: 'x'.repeat(501) }),
      one({ atLeast: null }),
      one({ atLeast: true }),
      one({ atLeast: [1] }),
      one({ atMost: { at: 1 } }),
      one({ atLeast: '2026/10/01' }),
      one({ atMost: '1 October' }),
      one({ atLeast: 1, atMost: '2026-10-31' }),
      one({ atLeast: 5, atMost: 1 }),
      one({ atLeast: '2026-11-01', atMost: '2026-10-31' }),
      JSON.stringify([{ key: 'Score', atLeast: 1 }]),
      JSON.stringify([{ contains: 'chen' }]),
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(
        /webhook_endpoints_contact_event_field_values/,
      );
    }
    // …and keeps words, ranges with either end or both, equal ends, beside values.
    const kept = [
      { key: 'city', contains: 'x'.repeat(500) },
      { key: 'city', contains: 'São' },
      { key: 'score', atLeast: -2.5 },
      { key: 'score', atMost: 0 },
      { key: 'score', atLeast: 3, atMost: 3 },
      { key: 'renewal', atLeast: '2026-10-01' },
      { key: 'renewal', atLeast: '2026-10-01', atMost: '2026-10-01' },
      { key: 'vip', value: false },
    ];
    await setInDatabase(JSON.stringify(kept));
    expect(await current()).toEqual(kept);
  });
});

describe('contact tag filters (ADR-267)', () => {
  /** Puts a tag on a contact, or takes it off, as the contacts service writes tags. */
  const tag = (c: Company, contactId: string, name: string) =>
    fx.query(
      'INSERT INTO app.contact_tags (id, tenant_id, contact_id, tag) VALUES ($1, $2, $3, $4)',
      [uuidv7(), c.tenant.id, contactId, name],
    );
  const untag = (c: Company, contactId: string, name: string) =>
    fx.query('DELETE FROM app.contact_tags WHERE tenant_id = $1 AND contact_id = $2 AND tag = $3', [
      c.tenant.id,
      contactId,
      name,
    ]);

  it('are refused without an event of a conversation, empty, over 50 or not as tags are written; kept as contacts carry them, kept by a change that leaves them out and cleared with the events; the database keeps them to those events and to tags as contacts carry them', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = async (
      eventTypes: string[],
      contactTags: unknown,
      message: RegExp,
      path = 'contactTags',
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, contactTags }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(contactTags)).toBe(path);
    };
    const needsTheEvents = /only for an endpoint that receives message or conversation events/;
    await refused(['deal.created', 'contact.created'], ['vip'], needsTheEvents);
    await refused(['message.received'], [], /at least one tag/);
    await refused(['message.received'], ['vip', 'a,b'], /commas/, 'contactTags.1');
    await refused(
      ['message.received'],
      Array.from({ length: 51 }, (_, i) => `tag ${i}`),
      /at most 50/,
    );
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['message.received', 'deal.created'],
      contactTags: ['VIP', ' vip', 'Wholesale'],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { contactTags?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
          [c.tenant.id, action],
        )
      ).map((a) => a.metadata.contactTags);
    expect(await audits('webhook.endpoint_created')).toEqual([['vip', 'wholesale']]);
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.contactTags;
    expect(await current()).toEqual(['vip', 'wholesale']);
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['message.received', 'deal.created'],
        ...fields,
      });
    await change({ description: 'kept' });
    expect(await current()).toEqual(['vip', 'wholesale']);
    await change({ contactTags: ['Gold'] });
    expect(await current()).toEqual(['gold']);
    await change({ contactTags: null });
    expect(await current()).toBeNull();
    await change({ contactTags: ['gold'] });
    // Any event of a conversation keeps the list.
    await change({ eventTypes: ['conversation.status_changed', 'task.created'] });
    expect(await current()).toEqual(['gold']);
    expect(await audits('webhook.endpoint_updated')).toEqual([
      ['vip', 'wholesale'],
      ['gold'],
      undefined,
      ['gold'],
      ['gold'],
    ]);
    // The database refuses an empty list, more than 50, a missing tag, a list of lists, and tags
    // not as contacts carry them (capitals, a comma, spaces around, over 40 characters, a control
    // character, an empty tag), from an endpoint taking an event of a conversation…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET contact_tags = ${value} WHERE id = $1`, [
        created.id,
      ]);
    const many = `ARRAY[${Array.from({ length: 51 }, (_, i) => `'tag ${i}'`).join(',')}]`;
    for (const bad of [
      `'{}'::text[]`,
      many,
      `ARRAY['vip', NULL]`,
      `ARRAY[ARRAY['vip'], ARRAY['gold']]`,
      `ARRAY['VIP']`,
      `ARRAY['gold', 'a,b']`,
      `ARRAY[' vip']`,
      `ARRAY['vip ']`,
      `ARRAY['${'x'.repeat(41)}']`,
      `ARRAY[E'vi\\tp']`,
      `ARRAY['vip', '']`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_contact_tags/);
    }
    // Tags as contacts carry them, spaces inside and 40 characters included, are kept.
    await setInDatabase(`ARRAY['gold member', '${'x'.repeat(40)}', 'vip']`);
    expect(await current()).toEqual(['gold member', 'x'.repeat(40), 'vip']);
    await change({ eventTypes: ['deal.created'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['deal.created'], contactTags: ['vip'] }),
      'validation_failed',
      needsTheEvents,
    );
    // …and any list for an endpoint that takes none.
    await expect(setInDatabase(`ARRAY['vip']`)).rejects.toThrow(/webhook_endpoints_contact_tags/);
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'contact_tags', 'UPDATE')
                AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });

  it('send an endpoint that names contact tags only the events of the conversations whose contact has one of them when the events happen, events of no conversation all the same, and capture none nobody takes', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const add = async (eventTypes: WebhookEventType[], contactTags: string[] | null) => {
      const path = `/ok/${randomBytes(6).toString('hex')}`;
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}${path}`,
        eventTypes,
        contactTags,
      });
      return { ...created, path };
    };
    const vips = await add(
      ['message.received', 'message.status', 'conversation.status_changed', 'consent.changed'],
      ['vip', 'gold'],
    );
    const from = waId();
    // A message from a contact without tags: no endpoint takes it, so nothing is captured.
    const first = await inbound(c, from, 'Hello');
    expect(await eventsOf(c)).toEqual([]);
    // Tagged vip, the contact's next message, the reply's status and the conversation resolved are
    // captured.
    await tag(c, first.contact_id, 'vip');
    await inbound(c, from, 'Still there?');
    await sendReply(c, first.conversation_id, 'Here');
    await fx.query(`UPDATE app.conversations SET status = 'resolved' WHERE id = $1`, [
      first.conversation_id,
    ]);
    // Another contact, tagged wholesale only, is not.
    const otherFrom = waId();
    const other = await inbound(c, otherFrom, 'Wholesale order');
    await tag(c, other.contact_id, 'wholesale');
    await inbound(c, otherFrom, 'Ten boxes');
    // The tag taken off, the first contact's next message, which reopens the conversation, is not
    // captured either.
    await untag(c, first.contact_id, 'vip');
    await inbound(c, from, 'Bye');
    // A consent change belongs to no conversation: the endpoint takes it.
    await createConsentService({ db: fx.dbs.app, clock: systemClock }).recordConsent(owner, {
      contactId: first.contact_id,
      purpose: 'marketing',
      action: 'opt_in',
    });
    // An endpoint for every conversation's messages hears every contact's, tagged or not.
    const everyone = await add(['message.received'], null);
    await inbound(c, otherFrom, 'Again');
    await inbound(c, from, 'Me too');
    const typesTo = async (endpointId: string) =>
      (await deliveriesOf(endpointId)).map((d) => [d.type, d.status]);
    expect(await typesTo(vips.id)).toEqual([
      ['message.received', null],
      ['message.status', 'accepted'],
      ['conversation.status_changed', 'resolved'],
      ['consent.changed', null],
    ]);
    expect(await typesTo(everyone.id)).toEqual([
      ['message.received', null],
      ['message.received', null],
    ]);
    // Each delivery names the tagged contact's conversation.
    expect(await deliverDue(c)).toMatchObject({ attempted: 6, succeeded: 6 });
    for (const body of requestsTo(vips.path).map(
      (r) => JSON.parse(r.body) as { type: string; data: { conversation?: { id: string } } },
    )) {
      if (body.type !== 'consent.changed') {
        expect(body.data.conversation?.id, body.type).toBe(first.conversation_id);
      }
    }
  });
});

describe('conversation tag filters (ADR-273)', () => {
  /** Puts a tag on a conversation, or takes it off, as the inbox writes tags. */
  const tagConversation = (c: Company, conversationId: string, name: string) =>
    fx.query(
      'INSERT INTO app.conversation_tags (id, tenant_id, conversation_id, tag) VALUES ($1, $2, $3, $4)',
      [uuidv7(), c.tenant.id, conversationId, name],
    );
  const untagConversation = (c: Company, conversationId: string, name: string) =>
    fx.query(
      'DELETE FROM app.conversation_tags WHERE tenant_id = $1 AND conversation_id = $2 AND tag = $3',
      [c.tenant.id, conversationId, name],
    );
  const tagContact = (c: Company, contactId: string, name: string) =>
    fx.query(
      'INSERT INTO app.contact_tags (id, tenant_id, contact_id, tag) VALUES ($1, $2, $3, $4)',
      [uuidv7(), c.tenant.id, contactId, name],
    );
  /** An endpoint of the company on a path of its own, with the tag lists given. */
  const add = async (
    c: Company,
    eventTypes: WebhookEventType[],
    lists: { contactTags?: string[] | null; conversationTags?: string[] | null },
  ) => {
    const path = `/ok/${randomBytes(6).toString('hex')}`;
    const created = await webhooks().create(await fx.ctx(c, c.owner), {
      url: `http://${HOST}:${port}${path}`,
      eventTypes,
      ...lists,
    });
    return { ...created, path };
  };
  const typesTo = async (endpointId: string) =>
    (await deliveriesOf(endpointId)).map((d) => [d.type, d.status]);

  it('are refused without an event of a conversation, empty, over 50 or not as tags are written; kept as conversations carry them, kept by a change that leaves them out and cleared with the events; the database keeps them to those events and to tags as conversations carry them', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = async (
      eventTypes: string[],
      conversationTags: unknown,
      message: RegExp,
      path = 'conversationTags',
    ) => {
      const error = await expectAppError(
        webhooks().create(owner, { url, eventTypes, conversationTags }),
        'validation_failed',
        message,
      );
      expect(isAppError(error) && error.issues?.[0]?.path, JSON.stringify(conversationTags)).toBe(
        path,
      );
    };
    const needsTheEvents =
      /conversation tags only for an endpoint that receives message or conversation events/;
    await refused(['deal.created', 'contact.created'], ['refund'], needsTheEvents);
    await refused(['message.received'], [], /at least one tag/);
    await refused(['message.received'], ['refund', 'a,b'], /commas/, 'conversationTags.1');
    await refused(
      ['message.received'],
      Array.from({ length: 51 }, (_, i) => `tag ${i}`),
      /at most 50/,
    );
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['message.received', 'deal.created'],
      conversationTags: ['Refund', ' refund', 'Delivery   Delay'],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { conversationTags?: unknown; contactTags?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
          [c.tenant.id, action],
        )
      ).map((a) => a.metadata.conversationTags);
    expect(await audits('webhook.endpoint_created')).toEqual([['refund', 'delivery delay']]);
    const current = async () => (await webhooks().list(owner)).find((e) => e.id === created.id);
    expect(await current()).toMatchObject({
      conversationTags: ['refund', 'delivery delay'],
      contactTags: null,
    });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['message.received', 'deal.created'],
        ...fields,
      });
    await change({ description: 'kept' });
    expect((await current())?.conversationTags).toEqual(['refund', 'delivery delay']);
    // Contact tags and conversation tags are lists of their own.
    await change({ conversationTags: ['Urgent'], contactTags: ['vip'] });
    expect(await current()).toMatchObject({ conversationTags: ['urgent'], contactTags: ['vip'] });
    await change({ conversationTags: null });
    expect(await current()).toMatchObject({ conversationTags: null, contactTags: ['vip'] });
    await change({ conversationTags: ['urgent'] });
    // Any event of a conversation keeps the list.
    await change({ eventTypes: ['conversation.assignment_changed', 'task.created'] });
    expect((await current())?.conversationTags).toEqual(['urgent']);
    expect(await audits('webhook.endpoint_updated')).toEqual([
      ['refund', 'delivery delay'],
      ['urgent'],
      undefined,
      ['urgent'],
      ['urgent'],
    ]);
    // The database refuses an empty list, more than 50, a missing tag, a list of lists, and tags
    // not as conversations carry them (capitals, a comma, spaces around, over 40 characters, a
    // control character, an empty tag), from an endpoint taking an event of a conversation…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET conversation_tags = ${value} WHERE id = $1`, [
        created.id,
      ]);
    const many = `ARRAY[${Array.from({ length: 51 }, (_, i) => `'tag ${i}'`).join(',')}]`;
    for (const bad of [
      `'{}'::text[]`,
      many,
      `ARRAY['refund', NULL]`,
      `ARRAY[ARRAY['refund'], ARRAY['urgent']]`,
      `ARRAY['Refund']`,
      `ARRAY['urgent', 'a,b']`,
      `ARRAY[' refund']`,
      `ARRAY['refund ']`,
      `ARRAY['${'x'.repeat(41)}']`,
      `ARRAY[E're\\tfund']`,
      `ARRAY['refund', '']`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_conversation_tags/);
    }
    // Tags as conversations carry them, spaces inside and 40 characters included, are kept.
    await setInDatabase(`ARRAY['delivery delay', '${'x'.repeat(40)}', 'refund']`);
    expect((await current())?.conversationTags).toEqual([
      'delivery delay',
      'x'.repeat(40),
      'refund',
    ]);
    await change({ eventTypes: ['deal.created'] });
    expect(await current()).toMatchObject({ conversationTags: null, contactTags: null });
    await expectAppError(
      change({ eventTypes: ['deal.created'], conversationTags: ['refund'] }),
      'validation_failed',
      needsTheEvents,
    );
    // …and any list for an endpoint that takes none.
    await expect(setInDatabase(`ARRAY['refund']`)).rejects.toThrow(
      /webhook_endpoints_conversation_tags/,
    );
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'conversation_tags',
                                   'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });

  it('send an endpoint that names conversation tags only the events of the conversations that have one of them when the events happen, with contact tags too only those that pass both, events of no conversation all the same, and capture none nobody takes', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const refunds = await add(
      c,
      ['message.received', 'message.status', 'conversation.status_changed', 'consent.changed'],
      { conversationTags: ['refund', 'urgent'] },
    );
    const vipRefunds = await add(c, ['message.received'], {
      contactTags: ['vip'],
      conversationTags: ['refund'],
    });
    const from = waId();
    // A message in a conversation without tags: no endpoint takes it, so nothing is captured.
    const first = await inbound(c, from, 'Hello');
    expect(await eventsOf(c)).toEqual([]);
    // Tagged refund, the conversation's next message and the reply's status are captured for the
    // first endpoint; the second also needs the contact tagged vip, as the next message has it.
    await tagConversation(c, first.conversation_id, 'refund');
    await inbound(c, from, 'Still there?');
    await sendReply(c, first.conversation_id, 'Here');
    await tagContact(c, first.contact_id, 'vip');
    await inbound(c, from, 'Where is my refund?');
    await fx.query(`UPDATE app.conversations SET status = 'resolved' WHERE id = $1`, [
      first.conversation_id,
    ]);
    // Another conversation, tagged delivery, is not, though its contact is tagged vip.
    const otherFrom = waId();
    const other = await inbound(c, otherFrom, 'Where is my parcel?');
    await tagConversation(c, other.conversation_id, 'delivery');
    await tagContact(c, other.contact_id, 'vip');
    await inbound(c, otherFrom, 'Still waiting');
    // The tag taken off, the first conversation's next message, which reopens it, is not
    // captured either.
    await untagConversation(c, first.conversation_id, 'refund');
    await inbound(c, from, 'Bye');
    // A consent change belongs to no conversation: the endpoint takes it.
    await createConsentService({ db: fx.dbs.app, clock: systemClock }).recordConsent(owner, {
      contactId: first.contact_id,
      purpose: 'marketing',
      action: 'opt_in',
    });
    // An endpoint for every conversation's messages hears every conversation's, tagged or not.
    const everyone = await add(c, ['message.received'], {});
    await inbound(c, otherFrom, 'Again');
    await inbound(c, from, 'Me too');
    expect(await typesTo(refunds.id)).toEqual([
      ['message.received', null],
      ['message.status', 'accepted'],
      ['message.received', null],
      ['conversation.status_changed', 'resolved'],
      ['consent.changed', null],
    ]);
    expect(await typesTo(vipRefunds.id)).toEqual([['message.received', null]]);
    expect(await typesTo(everyone.id)).toEqual([
      ['message.received', null],
      ['message.received', null],
    ]);
    // Each delivery of a conversation's event names the tagged conversation.
    expect(await deliverDue(c)).toMatchObject({ attempted: 8, succeeded: 8 });
    for (const request of [...requestsTo(refunds.path), ...requestsTo(vipRefunds.path)]) {
      const body = JSON.parse(request.body) as {
        type: string;
        data: { conversation?: { id: string } };
      };
      if (body.type !== 'consent.changed') {
        expect(body.data.conversation?.id, body.type).toBe(first.conversation_id);
      }
    }
  });

  it("reach an endpoint from the definer role's changes too: erasure cancels a tagged conversation's unsent reply before it deletes the conversation's tags", async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const refunds = await add(c, ['message.status'], { conversationTags: ['refund'] });
    const urgent = await add(c, ['message.status'], { conversationTags: ['urgent'] });
    const first = await inbound(c, waId(), 'I want a refund');
    await tagConversation(c, first.conversation_id, 'refund');
    // A reply queued and not sent yet: erasure, which runs as the definer role, cancels it.
    const agent = await fx.ctx(c, c.agent);
    const { messageId } = await queueTextMessage(
      { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock },
      agent,
      {
        conversationId: first.conversation_id,
        text: 'Your refund is on its way',
        clientKey: `ck-${randomBytes(6).toString('hex')}`,
      },
    );
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: first.contact_id,
      suppress: false,
    });
    const [message] = await fx.query<{ status: string }>(
      'SELECT status FROM app.messages WHERE id = $1',
      [messageId],
    );
    expect(message?.status).toBe('canceled');
    expect(await typesTo(refunds.id)).toEqual([['message.status', 'canceled']]);
    expect(await deliveriesOf(urgent.id)).toEqual([]);
    // The conversation's tags were deleted afterwards, as erasure deletes them.
    expect(
      await fx.query('SELECT tag FROM app.conversation_tags WHERE conversation_id = $1', [
        first.conversation_id,
      ]),
    ).toEqual([]);
    const [grant] = await fx.query<{ can_select: boolean }>(
      `SELECT has_column_privilege('w360_definer', 'app.conversation_tags', 'tag', 'SELECT')
                AS can_select`,
    );
    expect(grant?.can_select).toBe(true);
  });
});

describe('consent change filters (ADR-189)', () => {
  it('are refused without consent.changed, unknown or empty, kept by a change that leaves them out and cleared with the event; the database keeps them to the event', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], consentChanges: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, consentChanges }),
        'validation_failed',
        message,
      );
    const needsTheEvent = /only for an endpoint that receives Consent changed/;
    await refused(['contact.created', 'contact.updated'], ['marketing_opt_out'], needsTheEvent);
    await refused(['consent.changed'], [], /at least one consent change/);
    await refused(['consent.changed'], ['opt_out'], /from the list/);
    await refused(['consent.changed'], ['marketing'], /from the list/);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['consent.changed', 'contact.created'],
      consentChanges: ['utility_opt_out', 'marketing_opt_out', 'utility_opt_out'],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({
      consentChanges: ['marketing_opt_out', 'utility_opt_out'],
    });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['consent.changed', 'contact.created'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.consentChanges;
    expect(await current()).toEqual(['marketing_opt_out', 'utility_opt_out']);
    await change({ description: 'kept' });
    expect(await current()).toEqual(['marketing_opt_out', 'utility_opt_out']);
    await change({ consentChanges: ['marketing_opt_in'] });
    expect(await current()).toEqual(['marketing_opt_in']);
    const updates = await fx.query<{ metadata: { consentChanges?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.consentChanges)).toEqual([
      ['marketing_opt_out', 'utility_opt_out'],
      ['marketing_opt_in'],
    ]);
    await change({ consentChanges: null });
    expect(await current()).toBeNull();
    await change({ consentChanges: ['utility_opt_in'] });
    // The database refuses an empty list, more than four entries, an unknown change or a missing
    // one from an endpoint taking the event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET consent_changes = ${value} WHERE id = $1`, [
        created.id,
      ]);
    for (const bad of [
      `'{}'`,
      `'{marketing_opt_in,marketing_opt_out,utility_opt_in,utility_opt_out,utility_opt_out}'`,
      `'{marketing_opt_in,opt_out}'`,
      `'{marketing}'`,
      `ARRAY['utility_opt_in', NULL]::text[]`,
      `ARRAY[['utility_opt_in']]::text[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_consent_changes/);
    }
    await change({ eventTypes: ['contact.created'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['contact.created'], consentChanges: ['utility_opt_in'] }),
      'validation_failed',
      needsTheEvent,
    );
    // …and any list for an endpoint that does not take it.
    await expect(setInDatabase(`'{utility_opt_in}'`)).rejects.toThrow(
      /webhook_endpoints_consent_changes/,
    );
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'consent_changes', 'UPDATE')
                AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });

  it('sends an endpoint that names consent changes only those, others every change, and captures none nobody takes (ADR-189)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const path = `/ok/${randomBytes(6).toString('hex')}`;
    const optOuts = await webhooks().create(owner, {
      url: `http://${HOST}:${port}${path}`,
      eventTypes: ['consent.changed'],
      consentChanges: ['marketing_opt_out', 'utility_opt_out'],
    });
    const consent = createConsentService({ db: fx.dbs.app, clock: systemClock });
    const { contact_id: contactId } = await inbound(c, waId(), 'Hello');
    const record = (purpose: 'marketing' | 'utility', action: 'opt_in' | 'opt_out') =>
      consent.recordConsent(owner, { contactId, purpose, action });
    // Only the opt-outs are taken, so the opt-in is not captured at all.
    await record('marketing', 'opt_in');
    await record('marketing', 'opt_out');
    expect((await eventsOf(c)).filter((e) => e.type === 'consent.changed')).toEqual([
      expect.objectContaining({
        detail: { purpose: 'marketing', action: 'opt_out', source: 'agent' },
      }),
    ]);
    // An endpoint taking every change gets the rest; the opt-out endpoint the utility opt-out.
    const every = await addEndpoint(c, 'ok', ['consent.changed']);
    await record('utility', 'opt_in');
    await record('utility', 'opt_out');
    const changes = (await eventsOf(c))
      .filter((e) => e.type === 'consent.changed')
      .map((e) => `${String(e.detail.purpose)}_${String(e.detail.action)}`);
    expect(changes).toEqual(['marketing_opt_out', 'utility_opt_in', 'utility_opt_out']);
    const takenBy = async (endpointId: string) =>
      (await deliveriesOf(endpointId)).map((d) => d.type);
    expect(await takenBy(optOuts.id)).toEqual(['consent.changed', 'consent.changed']);
    expect(await takenBy(every.id)).toEqual(['consent.changed', 'consent.changed']);

    await deliverDue(c);
    const sentTo = (to: string) =>
      requestsTo(to).map((r) => {
        const { purpose, action } = consentChangedPayloadSchema.parse(JSON.parse(r.body)).data;
        return `${purpose}_${action}`;
      });
    expect(sentTo(path).sort()).toEqual(['marketing_opt_out', 'utility_opt_out']);
    expect(sentTo(every.path).sort()).toEqual(['utility_opt_in', 'utility_opt_out']);
  });
});

describe('contact source filters (ADR-190)', () => {
  it('are refused without contact.created, unknown or empty, kept by a change that leaves them out and cleared with the event; the database keeps them to the event', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], contactSources: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, contactSources }),
        'validation_failed',
        message,
      );
    const needsTheEvent = /only for an endpoint that receives Contact added/;
    await refused(['contact.updated', 'contact.erased'], ['whatsapp'], needsTheEvent);
    await refused(['contact.created'], [], /at least one place contacts come from/);
    await refused(['contact.created'], ['agent'], /from the list/);
    await refused(['contact.created'], ['flow'], /from the list/);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['contact.created', 'contact.updated'],
      contactSources: ['store', 'whatsapp', 'store'],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ contactSources: ['whatsapp', 'store'] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['contact.created', 'contact.updated'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.contactSources;
    expect(await current()).toEqual(['whatsapp', 'store']);
    await change({ description: 'kept' });
    expect(await current()).toEqual(['whatsapp', 'store']);
    await change({ contactSources: ['api'] });
    expect(await current()).toEqual(['api']);
    const updates = await fx.query<{ metadata: { contactSources?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.contactSources)).toEqual([['whatsapp', 'store'], ['api']]);
    await change({ contactSources: null });
    expect(await current()).toBeNull();
    await change({ contactSources: ['import'] });
    // The database refuses an empty list, more than five entries, an unknown source or a missing
    // one from an endpoint taking the event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET contact_sources = ${value} WHERE id = $1`, [
        created.id,
      ]);
    for (const bad of [
      `'{}'`,
      `'{whatsapp,manual,import,api,store,store}'`,
      `'{whatsapp,agent}'`,
      `'{flow}'`,
      `ARRAY['import', NULL]::text[]`,
      `ARRAY[['import']]::text[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_contact_sources/);
    }
    await change({ eventTypes: ['contact.updated'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['contact.updated'], contactSources: ['import'] }),
      'validation_failed',
      needsTheEvent,
    );
    // …and any list for an endpoint that does not take it.
    await expect(setInDatabase(`'{import}'`)).rejects.toThrow(/webhook_endpoints_contact_sources/);
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'contact_sources', 'UPDATE')
                AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });

  it('sends an endpoint that names sources the added contacts from them only, others every contact, and narrows no other contact event (ADR-190)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const path = `/ok/${randomBytes(6).toString('hex')}`;
    const fromWhatsApp = await webhooks().create(owner, {
      url: `http://${HOST}:${port}${path}`,
      eventTypes: ['contact.created', 'contact.updated'],
      contactSources: ['whatsapp'],
    });
    const every = await addEndpoint(c, 'ok', ['contact.created']);
    const contacts = createContactsService({ db: fx.dbs.app, clock: systemClock });
    // A customer writes on WhatsApp; a member adds a contact in the app, tagged in the same
    // transaction, which folds into its added event as before.
    const { contact_id: wrote } = await inbound(c, waId(), 'Hello');
    const { id: added } = await contacts.createContact(owner, {
      phone: `+${waId()}`,
      displayName: 'Meena',
      tags: ['vip'],
    });
    const created = (await eventsOf(c)).filter((e) => e.type === 'contact.created');
    expect(created).toHaveLength(2);
    const takenBy = async (endpointId: string) =>
      (await deliveriesOf(endpointId)).map((d) => [d.type, d.event_id]);
    const [wroteEvent, addedEvent] = created.map((e) => e.id);
    expect(await takenBy(fromWhatsApp.id)).toEqual([['contact.created', wroteEvent]]);
    expect(await takenBy(every.id)).toEqual([
      ['contact.created', wroteEvent],
      ['contact.created', addedEvent],
    ]);
    // A later change of the member's contact is not narrowed by where it came from.
    await contacts.updateContact(owner, added, { displayName: 'Meena Rao' });
    const updates = (await deliveriesOf(fromWhatsApp.id)).filter(
      (d) => d.type === 'contact.updated',
    );
    expect(updates).toHaveLength(1);

    await deliverDue(c);
    const sourcesAt = (to: string) =>
      requestsTo(to)
        .map(
          (r) =>
            JSON.parse(r.body) as {
              type: string;
              data: { contact: { id: string; source: string } };
            },
        )
        .map((b) => [b.type, b.data.contact.id, b.data.contact.source]);
    expect(sourcesAt(path)).toEqual(
      expect.arrayContaining([
        ['contact.created', wrote, 'whatsapp'],
        ['contact.updated', added, 'manual'],
      ]),
    );
    expect(sourcesAt(path)).toHaveLength(2);
    expect(sourcesAt(every.path).sort()).toEqual(
      [
        ['contact.created', added, 'manual'],
        ['contact.created', wrote, 'whatsapp'],
      ].sort(),
    );
  });
});

describe('message type filters (ADR-191)', () => {
  it('are refused without message.received, unknown or empty, kept by a change that leaves them out and cleared with the event; the database keeps them to the event', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], messageTypes: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, messageTypes }),
        'validation_failed',
        message,
      );
    const needsTheEvent = /only for an endpoint that receives Message received/;
    await refused(['message.status'], ['text'], needsTheEvent);
    await refused(['message.received'], [], /at least one message type/);
    await refused(['message.received'], ['template'], /from the list/);
    await refused(['message.received'], ['list_reply'], /from the list/);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['message.received', 'message.status'],
      messageTypes: ['order', 'text', 'order'],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ messageTypes: ['text', 'order'] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['message.received', 'message.status'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.messageTypes;
    expect(await current()).toEqual(['text', 'order']);
    await change({ description: 'kept' });
    expect(await current()).toEqual(['text', 'order']);
    await change({ messageTypes: ['interactive', 'button'] });
    expect(await current()).toEqual(['interactive', 'button']);
    const updates = await fx.query<{ metadata: { messageTypes?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.messageTypes)).toEqual([
      ['text', 'order'],
      ['interactive', 'button'],
    ]);
    await change({ messageTypes: null });
    expect(await current()).toBeNull();
    await change({ messageTypes: ['location'] });
    // The database refuses an empty list, more than fourteen entries, a template, an unknown type
    // or a missing one from an endpoint taking the event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET message_types = ${value} WHERE id = $1`, [
        created.id,
      ]);
    for (const bad of [
      `'{}'`,
      `'{text,image,video,audio,document,sticker,location,contacts,interactive,button,reaction,order,system,unsupported,text}'`,
      `'{text,template}'`,
      `'{list_reply}'`,
      `ARRAY['text', NULL]::text[]`,
      `ARRAY[['text']]::text[]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_message_types/);
    }
    await change({ eventTypes: ['message.status'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['message.status'], messageTypes: ['text'] }),
      'validation_failed',
      needsTheEvent,
    );
    // …and any list for an endpoint that does not take it.
    await expect(setInDatabase(`'{text}'`)).rejects.toThrow(/webhook_endpoints_message_types/);
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'message_types', 'UPDATE')
                AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });

  it('sends an endpoint that names message types only those messages, others every message, and captures none nobody takes (ADR-191)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const path = `/ok/${randomBytes(6).toString('hex')}`;
    const replies = await webhooks().create(owner, {
      url: `http://${HOST}:${port}${path}`,
      eventTypes: ['message.received'],
      messageTypes: ['text', 'interactive'],
    });
    const from = waId();
    const send = (message: Record<string, unknown>) =>
      fx.deliver(fx.messagesBody(c, { messages: [{ waId: from, ...message }] }));
    // A location only an endpoint taking every message would take: none does yet, so it is not
    // captured at all.
    await send({
      type: 'location',
      extra: { location: { latitude: 12.97, longitude: 77.59, name: 'Home', address: 'MG Road' } },
    });
    expect((await eventsOf(c)).filter((e) => e.type === 'message.received')).toEqual([]);
    const every = await addEndpoint(c, 'ok', ['message.received']);
    await send({ text: 'Which size fits me?' });
    await send({
      type: 'interactive',
      extra: {
        interactive: {
          type: 'list_reply',
          list_reply: { id: 'size-m', title: 'Medium', description: 'Chest 40 in' },
        },
      },
    });
    await send({
      type: 'location',
      extra: { location: { latitude: 12.97, longitude: 77.59, name: 'Home', address: 'MG Road' } },
    });
    const received = (await eventsOf(c)).filter((e) => e.type === 'message.received');
    expect(received.map((e) => e.detail.messageType)).toEqual(['text', 'interactive', 'location']);
    const takenBy = async (endpointId: string) =>
      (await deliveriesOf(endpointId)).map((d) => d.event_id);
    const [text, tap, place] = received.map((e) => e.id);
    expect(await takenBy(replies.id)).toEqual([text, tap]);
    expect(await takenBy(every.id)).toEqual([text, tap, place]);

    await deliverDue(c);
    const typesAt = (to: string) =>
      requestsTo(to)
        .map((r) => messageReceivedPayloadSchema.parse(JSON.parse(r.body)).data.message.type)
        .sort();
    expect(typesAt(path)).toEqual(['interactive', 'text']);
    expect(typesAt(every.path)).toEqual(['interactive', 'location', 'text']);
  });
});

describe('words in received messages (ADR-337)', () => {
  it('are refused without message.received, empty, blank, too long or with control characters, kept once whatever their case, by a change that leaves them out and cleared with the event; the database keeps their shape and the event', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (eventTypes: string[], messageWords: unknown, message: RegExp) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, messageWords }),
        'validation_failed',
        message,
      );
    const needsTheEvent = /only for an endpoint that receives Message received/;
    await refused(['message.status'], ['refund'], needsTheEvent);
    await refused(['message.received'], [], /at least one word or phrase/);
    await refused(['message.received'], ['   '], /not blank/);
    await refused(['message.received'], ['x'.repeat(101)], /at most 100 characters/);
    await refused(['message.received'], ['two\nlines'], /control characters/);
    await refused(['message.received'], ['para\u2028graph'], /control characters/);
    await refused(
      ['message.received'],
      Array.from({ length: 51 }, (_, i) => `word ${i}`),
      /at most 50 words and phrases/,
    );
    await refused(['message.received'], [5], /as text/);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['message.received', 'message.status'],
      messageWords: ['  Refund ', 'cancel order', 'REFUND', 'பணம் திரும்ப'],
    });
    const words = ['Refund', 'cancel order', 'பணம் திரும்ப'];
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ messageWords: words });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['message.received', 'message.status'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.messageWords;
    expect(await current()).toEqual(words);
    await change({ description: 'kept' });
    expect(await current()).toEqual(words);
    await change({ messageWords: ['price', 'a, b'] });
    expect(await current()).toEqual(['price', 'a, b']);
    const updates = await fx.query<{ metadata: { messageWords?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.messageWords)).toEqual([words, ['price', 'a, b']]);
    await change({ messageWords: null });
    expect(await current()).toBeNull();
    await change({ messageWords: ['price'] });
    // The database refuses an empty list, more than fifty words, a missing word, a nested list, a
    // word with spaces around it, an empty word, one with a control character (the one the check
    // joins the words on among them, so one word cannot pass for two) or of more than 100
    // characters…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET message_words = ${value} WHERE id = $1`, [
        created.id,
      ]);
    for (const bad of [
      `'{}'`,
      `array_fill('word'::text, ARRAY[51])`,
      `ARRAY['price', NULL]::text[]`,
      `ARRAY[['price']]::text[]`,
      `ARRAY[' price']`,
      `ARRAY['price ']`,
      `ARRAY['']`,
      `ARRAY['two' || chr(10) || 'lines']`,
      `ARRAY['one' || chr(31) || 'two']`,
      `ARRAY[repeat('x', 101)]`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_message_words/);
    }
    // …and takes 100 characters, commas and other scripts, and the line separator, which only the
    // services refuse: PostgreSQL's patterns read only C0 and C1 controls as control characters.
    await setInDatabase(`ARRAY[repeat('x', 100), 'a, b', 'பணம்', 'para' || chr(8232) || 'graph']`);
    expect(await current()).toEqual(['x'.repeat(100), 'a, b', 'பணம்', 'para\u2028graph']);
    await change({ eventTypes: ['message.status'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['message.status'], messageWords: ['price'] }),
      'validation_failed',
      needsTheEvent,
    );
    // …and any list for an endpoint that does not take the event.
    await expect(setInDatabase(`ARRAY['price']`)).rejects.toThrow(
      /webhook_endpoints_message_words/,
    );
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'message_words', 'UPDATE')
                AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
  });

  it('read a received message’s text as the payload gives it', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['text', { text: 'Hello' }],
      ['text', { text: 5 }],
      ['text', {}],
      ['text', { text: 'Hi', tooLarge: true }],
      ['text', { text: 'Hi', tooLarge: 'true' }],
      ['image', { caption: 'A photo', mime_type: 'image/jpeg' }],
      ['video', { caption: 'A clip' }],
      ['audio', { mime_type: 'audio/ogg' }],
      ['document', { caption: ['not text'] }],
      ['sticker', { caption: 'A sticker' }],
      ['button', { text: 'Yes', payload: 'yes' }],
      ['interactive', { interactiveType: 'button_reply', reply: { id: 'a', title: 'Refund' } }],
      ['interactive', { reply: 'Refund' }],
      ['interactive', { reply: { title: 7 } }],
      ['interactive', {}],
      ['reaction', { emoji: '👍', messageId: 'wamid.x' }],
      ['location', { name: 'Home', address: 'MG Road' }],
      ['location', { address: 'MG Road' }],
      ['location', { name: '', address: 'MG Road' }],
      ['location', { name: 5, address: 'MG Road' }],
      ['contacts', { contacts: [] }],
      ['order', { text: 'An order' }],
      ['system', { text: 'A change' }],
      ['unsupported', { text: 'Unknown' }],
    ];
    for (const [type, content] of cases) {
      const [row] = await fx.query<{ text: string | null }>(
        `SELECT app.webhook_message_text($1, $2::jsonb) AS text`,
        [type, JSON.stringify(content)],
      );
      expect(row?.text, `${type} ${JSON.stringify(content)}`).toBe(
        inboundSummary(type, content).text,
      );
    }
  });

  it('sends an endpoint that names words only the messages whose text contains one, whatever its case, others every message, and captures none nobody takes', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const path = `/ok/${randomBytes(6).toString('hex')}`;
    const desk = await webhooks().create(owner, {
      url: `http://${HOST}:${port}${path}`,
      eventTypes: ['message.received'],
      messageWords: ['refund', 'Cancel order', '100%'],
    });
    const from = waId();
    const send = (message: Record<string, unknown>) =>
      fx.deliver(fx.messagesBody(c, { messages: [{ waId: from, ...message }] }));
    // A message no word matches, which only an endpoint taking every message would take: none does
    // yet, so it is not captured at all.
    await send({ text: 'Which size fits me?' });
    expect((await eventsOf(c)).filter((e) => e.type === 'message.received')).toEqual([]);
    const every = await addEndpoint(c, 'ok', ['message.received']);
    await send({ text: 'I want a REFUND please' });
    await send({ text: 'Which size fits me?' });
    await send({
      type: 'image',
      extra: {
        image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'Please cancel ORDER 42' },
      },
    });
    await send({
      type: 'interactive',
      extra: {
        interactive: { type: 'button_reply', button_reply: { id: 'refund', title: 'Refund' } },
      },
    });
    await send({ type: 'sticker', extra: { sticker: { id: 'media-2', mime_type: 'image/webp' } } });
    // A word is no pattern: "100%" is found as written, and "100 percent" does not pass for it.
    await send({ text: 'Is it 100% cotton?' });
    await send({ text: 'Is it 100 percent cotton?' });
    const received = (await eventsOf(c)).filter((e) => e.type === 'message.received');
    expect(received.map((e) => e.detail.messageType)).toEqual([
      'text',
      'text',
      'image',
      'interactive',
      'sticker',
      'text',
      'text',
    ]);
    const takenBy = async (endpointId: string) =>
      (await deliveriesOf(endpointId)).map((d) => d.event_id);
    const [refund, size, caption, tap, sticker, percent, words] = received.map((e) => e.id);
    expect(await takenBy(desk.id)).toEqual([refund, caption, tap, percent]);
    expect(await takenBy(every.id)).toEqual([refund, size, caption, tap, sticker, percent, words]);
    // The event keeps no text.
    expect(received.map((e) => Object.keys(e.detail).sort())).toEqual(
      received.map(() => ['messageType']),
    );

    await deliverDue(c);
    const textsAt = (to: string) =>
      requestsTo(to)
        .map((r) => messageReceivedPayloadSchema.parse(JSON.parse(r.body)).data.message.text)
        .sort();
    expect(textsAt(path)).toEqual(
      ['I want a REFUND please', 'Please cancel ORDER 42', 'Refund', 'Is it 100% cotton?'].sort(),
    );
    expect(textsAt(every.path)).toHaveLength(7);
  });
});

describe('run end reason filters (ADR-192)', () => {
  it('are refused without automation.run_ended, unknown, empty or of an end not taken, kept by a change that leaves them out (less those of ends dropped) and cleared with the event; the database keeps them to the event and the ends', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const url = 'https://hooks.example.com/in';
    const refused = (
      eventTypes: string[],
      runEndStatuses: unknown,
      runEndReasons: unknown,
      message: RegExp,
    ) =>
      expectAppError(
        webhooks().create(owner, { url, eventTypes, runEndStatuses, runEndReasons }),
        'validation_failed',
        message,
      );
    const needsTheEvent = /only for an endpoint that receives Automation ended/;
    const needsTheEnds = /only of the ends the endpoint receives/;
    await refused(['automation.run_started'], undefined, ['expired'], needsTheEvent);
    await refused(['automation.run_ended'], undefined, [], /at least one end reason/);
    await refused(['automation.run_ended'], undefined, ['failed'], /from the list/);
    await refused(['automation.run_ended'], undefined, ['budget'], /from the list/);
    // A reason of an end the endpoint does not take would never be sent.
    await refused(['automation.run_ended'], ['completed'], ['send_failed'], needsTheEnds);
    expect(await webhooks().list(owner)).toEqual([]);

    const created = await webhooks().create(owner, {
      url,
      eventTypes: ['automation.run_ended', 'consent.changed'],
      runEndStatuses: ['completed', 'failed'],
      runEndReasons: ['send_failed', 'end_node', 'send_failed'],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ runEndReasons: ['end_node', 'send_failed'] });
    const change = (fields: Record<string, unknown>) =>
      webhooks().update(owner, {
        endpointId: created.id,
        url,
        description: '',
        eventTypes: ['automation.run_ended', 'consent.changed'],
        ...fields,
      });
    const current = async () =>
      (await webhooks().list(owner)).find((e) => e.id === created.id)?.runEndReasons;
    expect(await current()).toEqual(['end_node', 'send_failed']);
    await change({ description: 'kept' });
    expect(await current()).toEqual(['end_node', 'send_failed']);
    await change({ runEndReasons: ['no_next', 'expired'] });
    expect(await current()).toEqual(['no_next', 'expired']);
    const updates = await fx.query<{ metadata: { runEndReasons?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_updated' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(updates.map((u) => u.metadata.runEndReasons)).toEqual([
      ['end_node', 'send_failed'],
      ['no_next', 'expired'],
    ]);
    // Dropping an end drops its reasons; none left takes every reason of the ends kept.
    await change({ runEndStatuses: ['completed'] });
    expect(await current()).toEqual(['no_next']);
    await change({ runEndStatuses: ['failed'] });
    expect(await current()).toBeNull();
    // Reasons given are checked against the ends given, or else the ends the endpoint keeps.
    await expectAppError(
      change({ runEndReasons: ['end_node'] }),
      'validation_failed',
      needsTheEnds,
    );
    await expectAppError(
      change({ runEndStatuses: ['stopped', 'failed'], runEndReasons: ['expired', 'end_node'] }),
      'validation_failed',
      needsTheEnds,
    );
    await change({ runEndStatuses: null, runEndReasons: ['end_node'] });
    expect(await current()).toEqual(['end_node']);
    await change({ runEndReasons: null });
    expect(await current()).toBeNull();
    await change({ runEndReasons: ['take_over'] });
    // The database refuses an empty list, more than twenty-one entries, a status, an unknown reason
    // or a missing one from an endpoint taking the event…
    const setInDatabase = (value: string) =>
      fx.query(`UPDATE app.webhook_endpoints SET ${value} WHERE id = $1`, [created.id]);
    for (const bad of [
      `run_end_reasons = '{}'`,
      `run_end_reasons = '{end_node,no_next,handoff_node,agent_replied,assigned,take_over,api_replied,stopped_by_member,conversation_resolved,opted_out,contact_erased,automation_archived,stopped_by_api,budget_steps,budget_loop,budget_messages,budget_http,expired,send_blocked,send_failed,error,error}'`,
      `run_end_reasons = '{take_over,failed}'`,
      `run_end_reasons = '{budget}'`,
      `run_end_reasons = ARRAY['take_over', NULL]::text[]`,
      `run_end_reasons = ARRAY[['take_over']]::text[]`,
      // …a reason of an end it does not take, however the ends or the reasons change…
      `run_end_statuses = '{completed,stopped}'`,
      `run_end_statuses = '{failed}', run_end_reasons = '{take_over}'`,
    ]) {
      await expect(setInDatabase(bad), bad).rejects.toThrow(/webhook_endpoints_run_end_reasons/);
    }
    await setInDatabase(`run_end_statuses = '{taken_over}'`);
    await change({ eventTypes: ['consent.changed'] });
    expect(await current()).toBeNull();
    await expectAppError(
      change({ eventTypes: ['consent.changed'], runEndReasons: ['expired'] }),
      'validation_failed',
      needsTheEvent,
    );
    // …and any list for an endpoint that does not take it, run starts included.
    await change({ eventTypes: ['automation.run_started'] });
    await expect(setInDatabase(`run_end_reasons = '{expired}'`)).rejects.toThrow(
      /webhook_endpoints_run_end_reasons/,
    );
    // The company role changes the list only through its column grant.
    const [grant] = await fx.query<{ can_update: boolean }>(
      `SELECT has_column_privilege('w360_app', 'app.webhook_endpoints', 'run_end_reasons',
                'UPDATE') AS can_update`,
    );
    expect(grant?.can_update).toBe(true);
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

  it('posts message.received with the contacts a card shares, and none once its sender is erased (ADR-196)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const e = await addEndpoint(c, 'ok', ['message.received']);
    // Meta's example of a received card (research M-193).
    const card = [
      {
        name: { first_name: 'Lucía', last_name: 'Gómez', formatted_name: 'Lucía Gómez' },
        org: { company: 'Google' },
        phones: [{ phone: '+1 (983) 555-2319', wa_id: '19835552319', type: 'MOBILE' }],
      },
    ];
    const from = waId();
    await fx.deliver(
      fx.messagesBody(c, {
        messages: [{ waId: from, type: 'contacts', extra: { contacts: card } }],
      }),
    );
    expect(await deliverDue(c)).toMatchObject({ attempted: 1, succeeded: 1 });
    const [sent] = requestsTo(e.path).map(
      (r) => messageReceivedPayloadSchema.parse(JSON.parse(r.body)).data.message,
    );
    expect(sent).toMatchObject({
      type: 'contacts',
      text: null,
      contactsLeftOut: 0,
      contacts: [
        {
          name: {
            formattedName: 'Lucía Gómez',
            firstName: 'Lucía',
            lastName: 'Gómez',
            middleName: null,
            prefix: null,
            suffix: null,
          },
          phones: [{ phone: '+1 (983) 555-2319', waId: '19835552319', type: 'MOBILE' }],
          emails: [],
          urls: [],
          addresses: [],
          org: { company: 'Google', department: null, title: null },
          birthday: null,
        },
      ],
    });
    // Another customer's card, delivered after they are erased: built when delivered, it shares
    // nobody.
    const erased = waId();
    await fx.deliver(
      fx.messagesBody(c, {
        messages: [{ waId: erased, type: 'contacts', extra: { contacts: card } }],
      }),
    );
    const [contact] = await fx.query<{ id: string }>(
      'SELECT id FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2',
      [c.tenant.id, `+${erased}`],
    );
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: contact!.id,
      suppress: false,
    });
    expect(await deliverDue(c)).toMatchObject({ attempted: 1, succeeded: 1 });
    const later = requestsTo(e.path)[1];
    expect(messageReceivedPayloadSchema.parse(JSON.parse(later!.body)).data.message).toMatchObject({
      type: 'contacts',
      contacts: null,
      contactsLeftOut: 0,
    });
    expect(later!.body).not.toContain('Lucía');
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
        campaignId: null,
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

  it('an OAuth client the keyring cannot open fails each delivery to its endpoint alone, until given again (ADR-173)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const add = async (secret: string) => {
      const id = randomBytes(6).toString('hex');
      const created = await webhooks().create(owner, {
        url: `http://${HOST}:${port}/bearer/${id}`,
        eventTypes: ['consent.changed'],
        oauth: {
          tokenUrl: `http://${HOST}:${port}/token/${id}`,
          clientId: 'hyfib-test',
          clientSecret: secret,
        },
      });
      tokenAnswers.set(`/token/${id}`, {
        status: 200,
        body: { access_token: `tok-${id}`, token_type: 'Bearer', expires_in: 3600 },
      });
      acceptedTokens.set(`/bearer/${id}`, `tok-${id}`);
      return { ...created, bearer: `/bearer/${id}`, token: `/token/${id}` };
    };
    const broken = await add('broken-secret');
    const fine = await add('fine-secret');
    // The broken endpoint holds the other endpoint's sealed secret (as after a botched restore):
    // bound to that endpoint, it does not open for this one.
    await fx.query(
      `UPDATE app.webhook_endpoints b
          SET oauth_client_secret_ciphertext = f.oauth_client_secret_ciphertext
         FROM app.webhook_endpoints f WHERE b.id = $1 AND f.id = $2`,
      [broken.id, fine.id],
    );
    const first = await webhooks().sendTest(owner, { endpointId: broken.id });
    await webhooks().sendTest(owner, { endpointId: fine.id });

    const log = capturedLog();
    expect(await deliverDue(c, systemClock, egress(), log.logger)).toMatchObject({
      attempted: 1,
      succeeded: 1,
      failed: 1,
    });
    expect(await deliveriesOf(broken.id)).toMatchObject([
      { id: first.deliveryId, state: 'failed', attempts: 0, last_error: 'payload_failed' },
    ]);
    expect(requestsTo(broken.token)).toHaveLength(0);
    expect(requestsTo(broken.bearer)).toHaveLength(0);
    expect(requestsTo(fine.bearer).map((r) => r.headers.authorization)).toEqual([
      `Bearer tok-${fine.token.slice('/token/'.length)}`,
    ]);
    expect(log.lines.map((line) => line.fields)).toEqual([
      {
        tenantId: c.tenant.id,
        deliveryId: first.deliveryId,
        endpointId: broken.id,
        eventType: 'ping',
        stage: 'oauth',
        errorClass: 'Error',
        errorCode: null,
      },
    ]);
    expect(JSON.stringify(log.lines)).not.toMatch(/secret|tok-/);

    // Given again, the secret is sealed for this endpoint, and a replay delivers.
    await webhooks().update(owner, {
      endpointId: broken.id,
      url: `http://${HOST}:${port}${broken.bearer}`,
      description: '',
      eventTypes: ['consent.changed'],
      oauth: {
        tokenUrl: `http://${HOST}:${port}${broken.token}`,
        clientId: 'hyfib-test',
        clientSecret: 'given-again',
      },
    });
    const replay = await webhooks().replay(owner, { deliveryId: first.deliveryId });
    expect(await deliverDue(c)).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(requestsTo(broken.bearer).map((r) => r.headers['w360-delivery-id'])).toEqual([
      replay.deliveryId,
    ]);
    expect(requestsTo(broken.token)[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from('hyfib-test:given-again').toString('base64')}`,
    );
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
