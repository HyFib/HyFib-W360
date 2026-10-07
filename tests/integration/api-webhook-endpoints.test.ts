import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, sha256Hex, systemClock, uuidv7, type Clock } from '@w360/core';
import { DEFAULT_EGRESS_POLICY, createEgressClient } from '@w360/core/egress';
import { authorizedTenantScope, sql } from '@w360/db';
import {
  authenticateApiToken,
  createApiKeysService,
  createApiWebhookEndpoints,
  createAutomationService,
  createCrmService,
  createWebhooksService,
  outboxAad,
  processWebhookDeliveries,
  WebhookOAuthTokenCache,
  verifyWebhookSignature,
  webhookOAuthSecretAad,
  type ApiContext,
  type ApiKeysService,
  type ApiScope,
} from '@w360/domain';
import { acceptInvitation, createUser, failOnLog, invite } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Webhook endpoints managed through the public API (ADR-081) against real PostgreSQL, the egress
 * client and a local receiver (reached through the loopback allowance that exists for tests only):
 * endpoints added once per Idempotency-Key with the secret in the first answer only, owners and
 * administrators emailed, keys limited to the endpoints keys added, changes, rotations and
 * deletion, refusals, and the database's creator check.
 */
let fx: WhatsAppFixture;
let keys: ApiKeysService;
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
  keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
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

afterAll(async () => {
  receiver?.closeAllConnections();
  receiver?.close();
  await fx?.close();
});

const HOST = 'hooks.receiver.test';
const APP_BASE_URL = 'https://app.w360.test';
const at = (date: Date): Clock => ({ now: () => date });
const idem = (key: string, request: string) => ({ key, requestHash: sha256Hex(request) });
const receiverUrl = (path = `/ok/${randomBytes(6).toString('hex')}`) =>
  `http://${HOST}:${port}${path}`;

/** The endpoints API as the web app builds it (loopback allowed, as in local and test only). */
const api = (clock: Clock = systemClock, allowLoopbackForTests = true) =>
  createApiWebhookEndpoints({
    db: fx.dbs.app,
    clock,
    keyring: fx.keyring,
    jobs: fx.jobs(),
    signer: fx.signer,
    egressPolicy: { allowLoopbackForTests },
    appBaseUrl: APP_BASE_URL,
  });

const settings = () =>
  createWebhooksService({
    db: fx.dbs.app,
    clock: systemClock,
    keyring: fx.keyring,
    egressPolicy: { allowLoopbackForTests: true },
  });

/** Delivers the company's due deliveries to the local receiver, as the worker does. */
async function deliverDue(c: Company) {
  const jobs = fx.jobs();
  await processWebhookDeliveries(
    {
      db: fx.dbs.app,
      clock: systemClock,
      keyring: fx.keyring,
      egress: createEgressClient(
        { ...DEFAULT_EGRESS_POLICY, allowLoopbackForTests: true, timeoutMs: 1_000 },
        { resolve: async () => [{ address: '127.0.0.1', family: 4 }] },
      ),
      timeoutMs: 1_000,
      jobs,
      signer: fx.signer,
      notices: {
        outbox: { keyring: fx.keyring, jobs, signer: fx.signer },
        appBaseUrl: APP_BASE_URL,
      },
      logger: failOnLog,
      oauthTokens: new WebhookOAuthTokenCache(),
    },
    authorizedTenantScope(c.tenant.id, null),
  );
}

/** Verifies a received request's signature at its own timestamp. */
function signedWith(request: Received, secret: string): boolean {
  const header = String(request.headers['w360-signature'] ?? '');
  const t = Number(/^t=(\d+)/.exec(header)?.[1] ?? 0);
  return verifyWebhookSignature({ header, secret, body: request.body, nowSeconds: t });
}

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

/** A key of the company created by its owner, and the context a request with it gets. */
async function apiKey(c: Company, scopes: ApiScope[], name = 'Connector') {
  const owner = await fx.ctx(c, c.owner);
  const created = await keys.create(owner, { name, scopes, expiresInDays: 0 });
  const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
  if (!ctx) throw new Error('a new key does not authenticate');
  const keyPrefix = created.token.split('_').slice(0, 2).join('_');
  return { id: created.id, token: created.token, keyPrefix, ctx };
}

async function member(c: Company, role: string) {
  const user = await createUser(fx.dbs, { name: `Endpoints ${role}` });
  const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, [role]);
  await acceptInvitation(fx.dbs, user, token);
  return user;
}

/** The company's notices queued in the outbox, oldest first. */
async function companyNotices(tenantId: string) {
  const { rows } = await fx.dbs.adminPool.query<{
    id: string;
    to_address: string;
    payload_ciphertext: string;
  }>(
    `SELECT id, to_address, payload_ciphertext FROM ops.email_outbox
      WHERE tenant_id = $1 AND kind = 'tenant.notice' ORDER BY id`,
    [tenantId],
  );
  return rows.map((r) => ({
    to: r.to_address,
    ...(JSON.parse(fx.keyring.decryptString(r.payload_ciphertext, outboxAad(r.id))) as {
      subject: string;
      lines: string[];
      url: string;
      actionLabel: string;
    }),
  }));
}

/** An automation of the company replying to its name, published unless it stays a draft. */
async function automationOf(c: Company, name: string, publish = true) {
  const owner = await fx.ctx(c, c.owner);
  const svc = createAutomationService({
    db: fx.dbs.app,
    clock: systemClock,
    jobs: fx.jobs(),
    signer: fx.signer,
  });
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
  if (publish) {
    await svc.publishAutomation(owner, { id, expectedVersion: saved.version, note: null });
  }
  return id;
}

type EndpointBody = { data: Record<string, unknown> & { id: string; secret: string | null } };

async function addThroughApi(ctx: ApiContext, key: string, body: Record<string, unknown>) {
  const res = await api().create(ctx, body, idem(key, JSON.stringify(body)));
  return { ...res, body: res.body as EndpointBody };
}

describe('webhook endpoints through the API (ADR-081)', () => {
  it('add an endpoint once per Idempotency-Key, with its secret in the first answer only, the key recorded and audited, and owners and administrators emailed', async () => {
    const c = await fx.company();
    const admin = await member(c, 'admin');
    await member(c, 'agent');
    const key = await apiKey(c, ['webhooks.manage'], 'Zap connector');
    const path = `/ok/${randomBytes(6).toString('hex')}`;
    const body = {
      url: `${receiverUrl(path)}#fragment`,
      events: ['contact.created', 'message.received', 'contact.created'],
      description: '  CRM sync  ',
    };
    const created = await addThroughApi(key.ctx, 'ep-1', body);
    expect(created.status).toBe(201);
    expect(created.replayed).toBe(false);
    const { secret, ...endpoint } = created.body.data;
    expect(secret).toMatch(/^whsec_/);
    expect(endpoint).toEqual({
      id: expect.any(String),
      url: receiverUrl(path),
      description: 'CRM sync',
      events: ['message.received', 'contact.created'],
      status: 'active',
      disabledReason: null,
      failingSince: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      secretVersion: 1,
      previousSecretExpiresAt: null,
      headers: [],
      messageStatuses: null,
      messageSenders: null,
      contactParts: null,
      contactFieldKeys: null,
      automationIds: null,
      campaignStatuses: null,
      orderStatuses: null,
      templateStatuses: null,
      conversationStatuses: null,
      runEndStatuses: null,
      runTriggers: null,
      consentChanges: null,
      contactSources: null,
      messageTypes: null,
      runEndReasons: null,
      channelIds: null,
      teamIds: null,
      templateIds: null,
      campaignIds: null,
      pipelineIds: null,
      assigneeIds: null,
      oauth: null,
      apiKeyId: key.id,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    // A retry answers the same endpoint without the secret, which was never stored for replays.
    const replay = await addThroughApi(key.ctx, 'ep-1', body);
    expect(replay.replayed).toBe(true);
    expect(replay.body.data).toEqual({ ...endpoint, secret: null });
    const kept = await fx.query<{ response: unknown }>(
      `SELECT response FROM app.api_idempotency_keys WHERE tenant_id = $1 AND api_key_id = $2`,
      [c.tenant.id, key.id],
    );
    expect(kept).toHaveLength(1);
    expect(JSON.stringify(kept[0]?.response)).not.toContain('whsec_');
    expect(await api().list(key.ctx)).toEqual({ data: [endpoint] });
    expect(await api().get(key.ctx, endpoint.id)).toEqual(endpoint);

    const [row] = await fx.query<{
      created_by_user_id: string | null;
      created_by_api_key_id: string | null;
    }>(
      `SELECT created_by_user_id, created_by_api_key_id FROM app.webhook_endpoints WHERE id = $1`,
      [endpoint.id],
    );
    expect(row).toEqual({ created_by_user_id: null, created_by_api_key_id: key.id });
    const audit = await fx.query<{ actor_type: string; actor_id: string; metadata: unknown }>(
      `SELECT actor_type, actor_id, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id],
    );
    expect(audit).toEqual([
      {
        actor_type: 'api_key',
        actor_id: key.id,
        metadata: {
          host: HOST,
          eventTypes: ['message.received', 'contact.created'],
          source: 'api',
        },
      },
    ]);

    // Owners and administrators hear of it once (not agents): the key, the host and the events,
    // never the path, which can carry the receiver's own token.
    const notices = await companyNotices(c.tenant.id);
    expect(notices.map((n) => n.to).sort()).toEqual([admin.email, c.owner.email].sort());
    for (const notice of notices) {
      expect(notice.subject).toBe('Webhook endpoint added through the API');
      expect(notice.lines[0]).toMatch(
        new RegExp(
          `^The API key “Zap connector” \\(${key.keyPrefix}_…\\) added a webhook endpoint at ${HOST.replace(/\./g, '\\.')} on .+\\. It receives: Message received, Contact added\\.$`,
        ),
      );
      expect(notice.url).toBe(`${APP_BASE_URL}/c/${c.tenant.slug}/settings/webhooks`);
      expect(JSON.stringify(notice)).not.toContain(path);
    }

    // Settings show which key added it, and deliveries are signed with the secret it was given.
    const owner = await fx.ctx(c, c.owner);
    const listed = (await settings().list(owner)).find((e) => e.id === endpoint.id);
    expect(listed?.createdByKey).toEqual({ name: 'Zap connector', keyPrefix: key.keyPrefix });
    expect(listed?.createdBy).toBeNull();
    await settings().sendTest(owner, { endpointId: endpoint.id });
    await deliverDue(c);
    const delivered = received.filter((r) => r.path === path);
    expect(delivered).toHaveLength(1);
    expect(signedWith(delivered[0]!, secret!)).toBe(true);
  });

  it('let keys see and manage only the endpoints keys added, whichever key of the company added them', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const byMember = await settings().create(owner, {
      url: receiverUrl(),
      eventTypes: ['message.status'],
    });
    const first = await apiKey(c, ['webhooks.manage'], 'First');
    const second = await apiKey(c, ['webhooks.manage'], 'Second');
    const added = await addThroughApi(first.ctx, 'mine-1', {
      url: receiverUrl(),
      events: ['contact.updated'],
    });
    const id = added.body.data.id;

    // Another key of the company manages it; the member's endpoint is not found by either.
    expect((await api().list(second.ctx)).data.map((e) => e.id)).toEqual([id]);
    for (const k of [first, second]) {
      await expectAppError(api().get(k.ctx, byMember.id), 'not_found');
      await expectAppError(api().update(k.ctx, byMember.id, { enabled: false }), 'not_found');
      await expectAppError(
        api().rotateSecret(k.ctx, byMember.id, idem(`r-${k.id}`, 'r')),
        'not_found',
      );
      await expectAppError(api().remove(k.ctx, byMember.id), 'not_found');
    }
    expect(
      (await api().update(second.ctx, id, { description: 'Kept by the second key' })).description,
    ).toBe('Kept by the second key');

    // Another company's key sees nothing of either.
    const other = await fx.company();
    const stranger = await apiKey(other, ['webhooks.manage']);
    expect(await api().list(stranger.ctx)).toEqual({ data: [] });
    await expectAppError(api().get(stranger.ctx, id), 'not_found');
    await expectAppError(api().remove(stranger.ctx, id), 'not_found');

    // The member's endpoint is untouched.
    const [memberRow] = await fx.query<{ state: string; secret_version: number }>(
      `SELECT state, secret_version FROM app.webhook_endpoints WHERE id = $1`,
      [byMember.id],
    );
    expect(memberRow).toEqual({ state: 'active', secret_version: 1 });
  });

  it('change the events, description and state, rotate the secret (the old one signs too for 24 hours) and delete', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const key = await apiKey(c, ['webhooks.manage']);
    const path = `/ok/${randomBytes(6).toString('hex')}`;
    const added = await addThroughApi(key.ctx, 'change-1', {
      url: receiverUrl(path),
      events: ['message.received'],
      description: 'First',
    });
    const id = added.body.data.id;
    const oldSecret = added.body.data.secret!;

    const changed = await api().update(key.ctx, id, {
      events: ['automation.run_ended', 'message.status'],
      description: '',
    });
    expect(changed.events).toEqual(['message.status', 'automation.run_ended']);
    expect(changed.description).toBeNull();

    // Turned off, the waiting delivery fails; turned on, the endpoint is active again.
    const { deliveryId } = await settings().sendTest(owner, { endpointId: id });
    const off = await api().update(key.ctx, id, { enabled: false });
    expect(off).toMatchObject({ status: 'disabled', disabledReason: 'manual' });
    const [failed] = await fx.query<{ state: string }>(
      `SELECT state FROM app.webhook_deliveries WHERE id = $1`,
      [deliveryId],
    );
    expect(failed?.state).toBe('failed');
    expect(await api().update(key.ctx, id, { enabled: false })).toEqual(off);
    expect(await api().update(key.ctx, id, { enabled: true })).toMatchObject({
      status: 'active',
      disabledReason: null,
    });

    // A rotation, once per key: the new secret once, the old one also signs for 24 hours.
    const now = new Date();
    const rotated = await api(at(now)).rotateSecret(key.ctx, id, idem('rot-1', 'rot'));
    const rotatedData = (rotated.body as EndpointBody).data;
    expect(rotatedData.secret).toMatch(/^whsec_/);
    expect(rotatedData.secret).not.toBe(oldSecret);
    expect(rotatedData).toMatchObject({
      secretVersion: 2,
      previousSecretExpiresAt: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
    });
    const again = await api(at(now)).rotateSecret(key.ctx, id, idem('rot-1', 'rot'));
    expect(again.replayed).toBe(true);
    expect((again.body as EndpointBody).data).toEqual({ ...rotatedData, secret: null });
    expect((await api().get(key.ctx, id)).secretVersion).toBe(2);
    await settings().sendTest(owner, { endpointId: id });
    await deliverDue(c);
    const delivered = received.filter((r) => r.path === path);
    expect(delivered).toHaveLength(1);
    expect(signedWith(delivered[0]!, rotatedData.secret!)).toBe(true);
    expect(signedWith(delivered[0]!, oldSecret)).toBe(true);

    expect(
      await fx.query(`SELECT 1 FROM app.webhook_deliveries WHERE endpoint_id = $1`, [id]),
    ).not.toHaveLength(0);
    await api().remove(key.ctx, id);
    await expectAppError(api().get(key.ctx, id), 'not_found');
    expect(
      await fx.query(`SELECT 1 FROM app.webhook_deliveries WHERE endpoint_id = $1`, [id]),
    ).toHaveLength(0);
    const actions = await fx.query<{ action: string; actor_type: string }>(
      `SELECT action, actor_type FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 ORDER BY occurred_at, id`,
      [c.tenant.id, id],
    );
    expect(actions).toEqual(
      [
        'webhook.endpoint_created',
        'webhook.endpoint_updated',
        'webhook.endpoint_disabled',
        'webhook.endpoint_enabled',
        'webhook.secret_rotated',
        'webhook.endpoint_deleted',
      ].map((action) => ({ action, actor_type: 'api_key' })),
    );
    // Only the endpoint's addition was announced.
    expect((await companyNotices(c.tenant.id)).length).toBe(1);
  });

  it('set, replace and remove the headers sent with each delivery, shown and audited by name only (ADR-118)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const key = await apiKey(c, ['webhooks.manage']);
    const path = `/ok/${randomBytes(6).toString('hex')}`;
    const token = randomBytes(16).toString('hex');
    const body = {
      url: receiverUrl(path),
      events: ['contact.created'],
      headers: [
        { name: 'Authorization', value: `Bearer ${token}` },
        { name: 'X-Tenant', value: 'acme' },
      ],
    };
    const created = await addThroughApi(key.ctx, 'headers-1', body);
    expect(created.status).toBe(201);
    const { secret, ...endpoint } = created.body.data;
    expect(endpoint.headers).toEqual([{ name: 'Authorization' }, { name: 'X-Tenant' }]);
    expect((await addThroughApi(key.ctx, 'headers-1', body)).body.data.headers).toEqual(
      endpoint.headers,
    );
    expect(await api().get(key.ctx, endpoint.id)).toEqual(endpoint);
    const audits = async () =>
      fx.query<{ action: string; metadata: Record<string, unknown> }>(
        `SELECT action, metadata FROM app.audit_events
          WHERE tenant_id = $1 AND subject_id = $2 ORDER BY occurred_at, id`,
        [c.tenant.id, endpoint.id],
      );
    expect(await audits()).toEqual([
      {
        action: 'webhook.endpoint_created',
        metadata: {
          host: HOST,
          eventTypes: ['contact.created'],
          headers: ['Authorization', 'X-Tenant'],
          source: 'api',
        },
      },
    ]);
    // Neither the answers, the kept replay, the audit nor the owners' notice holds a value.
    const kept = await fx.query(
      `SELECT response FROM app.api_idempotency_keys WHERE tenant_id = $1 AND api_key_id = $2`,
      [c.tenant.id, key.id],
    );
    expect(
      JSON.stringify([
        created.body,
        kept,
        await api().list(key.ctx),
        await audits(),
        await companyNotices(c.tenant.id),
      ]),
    ).not.toMatch(new RegExp(`${token}|acme`));

    // Delivered with them, beside HyFib's signature.
    const delivered = async () => {
      await settings().sendTest(owner, { endpointId: endpoint.id });
      await deliverDue(c);
      const request = received.filter((r) => r.path === path).at(-1)!;
      expect(signedWith(request, secret!)).toBe(true);
      return request.headers;
    };
    expect(await delivered()).toMatchObject({
      authorization: `Bearer ${token}`,
      'x-tenant': 'acme',
    });

    // A change that leaves them out keeps them; given, they replace all of them; [] removes them.
    expect(await api().update(key.ctx, endpoint.id, { description: 'CRM' })).toMatchObject({
      description: 'CRM',
      headers: [{ name: 'Authorization' }, { name: 'X-Tenant' }],
    });
    expect(
      await api().update(key.ctx, endpoint.id, {
        headers: [{ name: 'X-Signature-Key', value: 'second' }],
      }),
    ).toMatchObject({ description: 'CRM', headers: [{ name: 'X-Signature-Key' }] });
    const replaced = await delivered();
    expect(replaced['x-signature-key']).toBe('second');
    expect(replaced.authorization).toBeUndefined();
    expect(replaced['x-tenant']).toBeUndefined();
    expect(await api().update(key.ctx, endpoint.id, { headers: [] })).toMatchObject({
      headers: [],
    });
    const [row] = await fx.query<{ header_names: string[]; headers_ciphertext: string | null }>(
      `SELECT header_names, headers_ciphertext FROM app.webhook_endpoints WHERE id = $1`,
      [endpoint.id],
    );
    expect(row).toEqual({ header_names: [], headers_ciphertext: null });
    expect((await delivered())['x-signature-key']).toBeUndefined();
    expect((await audits()).slice(1)).toEqual([
      {
        action: 'webhook.endpoint_updated',
        metadata: { host: HOST, eventTypes: ['contact.created'], source: 'api' },
      },
      {
        action: 'webhook.endpoint_updated',
        metadata: {
          host: HOST,
          eventTypes: ['contact.created'],
          headers: ['X-Signature-Key'],
          source: 'api',
        },
      },
      {
        action: 'webhook.endpoint_updated',
        metadata: { host: HOST, eventTypes: ['contact.created'], headers: [], source: 'api' },
      },
    ]);

    // Headers HyFib sets, and bad ones, are refused with the field's path, changing nothing.
    const issue = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    for (const [headers, path, message] of [
      [[{ name: 'W360-Signature', value: 'x' }], 'headers.0.name', /HyFib sets this header/],
      [[{ name: 'X-Key', value: 'line\nbreak' }], 'headers.0.value', /printable ASCII/],
      [
        [
          { name: 'X-Key', value: 'a' },
          { name: 'X-KEY', value: 'b' },
        ],
        'headers',
        /Give each header once/,
      ],
      [[{ name: 'X-Key' }], 'headers.0.value', /./],
    ] as const) {
      for (const refused of [
        issue(api().update(key.ctx, endpoint.id, { headers })),
        issue(
          api().create(
            key.ctx,
            { url: receiverUrl(), events: ['contact.created'], headers },
            idem(`bad-${randomBytes(4).toString('hex')}`, 'x'),
          ),
        ),
      ]) {
        const found = await refused;
        expect(found?.path).toBe(path);
        expect(found?.message).toMatch(message);
      }
    }
    expect((await api().list(key.ctx)).data).toHaveLength(1);
    expect((await api().get(key.ctx, endpoint.id)).headers).toEqual([]);
  });

  it('set, change and remove the OAuth client an endpoint gets tokens as, without ever answering its secret (ADR-173)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const SECRET = `oauth-${randomBytes(12).toString('hex')}`;
    const tokenUrl = `http://${HOST}:${port}/token/${randomBytes(6).toString('hex')}`;
    const body = {
      url: receiverUrl(),
      events: ['contact.created'],
      oauth: { tokenUrl, clientId: 'crm-client', clientSecret: SECRET, scope: 'hooks.write' },
    };
    const created = await addThroughApi(key.ctx, 'oauth-1', body);
    expect(created.status).toBe(201);
    const { secret: _signing, ...endpoint } = created.body.data;
    expect(endpoint.oauth).toEqual({ tokenUrl, clientId: 'crm-client', scope: 'hooks.write' });
    expect((await addThroughApi(key.ctx, 'oauth-1', body)).body.data.oauth).toEqual(endpoint.oauth);
    expect(await api().get(key.ctx, endpoint.id)).toEqual(endpoint);
    const audits = async () =>
      (
        await fx.query<{ metadata: Record<string, unknown> }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND subject_id = $2 ORDER BY occurred_at, id`,
          [c.tenant.id, endpoint.id],
        )
      ).map((row) => row.metadata);
    expect(await audits()).toEqual([
      { host: HOST, eventTypes: ['contact.created'], oauthTokenHost: HOST, source: 'api' },
    ]);

    // The same token URL keeps the secret; another needs it again, since the secret goes there.
    expect(
      await api().update(key.ctx, endpoint.id, {
        oauth: { tokenUrl, clientId: 'renamed-client' },
      }),
    ).toMatchObject({ oauth: { tokenUrl, clientId: 'renamed-client', scope: null } });
    const [row] = await fx.query<{ oauth_client_secret_ciphertext: string }>(
      'SELECT oauth_client_secret_ciphertext FROM app.webhook_endpoints WHERE id = $1',
      [endpoint.id],
    );
    expect(
      fx.keyring.decryptString(
        row!.oauth_client_secret_ciphertext,
        webhookOAuthSecretAad(c.tenant.id, endpoint.id),
      ),
    ).toBe(SECRET);
    const issue = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    expect(
      await issue(
        api().update(key.ctx, endpoint.id, {
          oauth: { tokenUrl: `http://elsewhere.test:${port}/token`, clientId: 'renamed-client' },
        }),
      ),
    ).toMatchObject({ path: 'oauth.clientSecret', message: expect.stringMatching(/again/) });
    expect(
      await issue(
        api().update(key.ctx, endpoint.id, {
          headers: [{ name: 'Authorization', value: 'Bearer fixed' }],
        }),
      ),
    ).toMatchObject({ path: 'headers.0.name' });
    expect(
      await issue(
        api().create(
          key.ctx,
          { ...body, oauth: { ...body.oauth, tokenUrl: 'ftp://auth.example.com/token' } },
          idem('oauth-bad-url', 'x'),
        ),
      ),
    ).toMatchObject({ path: 'oauth.tokenUrl' });
    expect(
      await issue(
        api().create(
          key.ctx,
          { ...body, oauth: { tokenUrl, clientId: 'no-secret' } },
          idem('oauth-no-secret', 'y'),
        ),
      ),
    ).toMatchObject({ path: 'oauth.clientSecret' });

    // null removes it.
    expect(await api().update(key.ctx, endpoint.id, { oauth: null })).toMatchObject({
      oauth: null,
    });
    expect((await audits()).slice(1)).toEqual([
      {
        host: HOST,
        eventTypes: ['contact.created'],
        oauthTokenHost: HOST,
        oauthSecretReplaced: false,
        source: 'api',
      },
      { host: HOST, eventTypes: ['contact.created'], oauthRemoved: true, source: 'api' },
    ]);
    // Neither the answers, the kept replay, the audit nor the owners' notice holds the secret.
    const kept = await fx.query(
      `SELECT response FROM app.api_idempotency_keys WHERE tenant_id = $1 AND api_key_id = $2`,
      [c.tenant.id, key.id],
    );
    expect(
      JSON.stringify([
        created.body,
        kept,
        await api().list(key.ctx),
        await audits(),
        await companyNotices(c.tenant.id),
      ]),
    ).not.toContain(SECRET);
    expect((await api().list(key.ctx)).data).toHaveLength(1);
  });

  it('choose the message statuses an endpoint receives, kept by changes that leave them out and cleared with the event (ADR-119)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    expect(
      await issueOf(
        api().create(
          key.ctx,
          { url: receiverUrl(), events: ['contact.created'], messageStatuses: ['failed'] },
          idem('statuses-bad', 'x'),
        ),
      ),
    ).toMatchObject({ path: 'messageStatuses' });

    const created = await addThroughApi(key.ctx, 'statuses-1', {
      url: receiverUrl(),
      events: ['message.status'],
      messageStatuses: ['failed', 'delivered', 'failed'],
    });
    const id = created.body.data.id;
    expect(created.body.data.messageStatuses).toEqual(['delivered', 'failed']);
    expect((await api().get(key.ctx, id)).messageStatuses).toEqual(['delivered', 'failed']);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ messageStatuses: ['delivered', 'failed'] });

    expect(await api().update(key.ctx, id, { description: 'Failures' })).toMatchObject({
      messageStatuses: ['delivered', 'failed'],
    });
    expect(await api().update(key.ctx, id, { messageStatuses: ['read'] })).toMatchObject({
      messageStatuses: ['read'],
    });
    const updates = await fx.query<{ metadata: { messageStatuses?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.messageStatuses)).toEqual([
      ['delivered', 'failed'],
      ['read'],
    ]);
    expect(
      await api().update(key.ctx, id, { events: ['message.status', 'contact.created'] }),
    ).toMatchObject({ messageStatuses: ['read'] });
    expect(await api().update(key.ctx, id, { events: ['contact.created'] })).toMatchObject({
      events: ['contact.created'],
      messageStatuses: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { messageStatuses: ['failed'] }))).toMatchObject(
      { path: 'messageStatuses' },
    );
    expect(
      await api().update(key.ctx, id, { events: ['message.status'], messageStatuses: ['failed'] }),
    ).toMatchObject({ messageStatuses: ['failed'] });
    expect(await api().update(key.ctx, id, { messageStatuses: null })).toMatchObject({
      messageStatuses: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { messageStatuses: [] }))).toMatchObject({
      path: 'messageStatuses',
    });
  });

  it('choose the contact parts an endpoint receives as contact.updated, kept by changes that leave them out and cleared with the event (ADR-123)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Parts need the event, at least one, and each from the list (an unknown one named by place).
    const refusals = [
      [['contact.created', 'contact.erased'], ['email'], 'contactParts'],
      [['contact.updated'], [], 'contactParts'],
      [['contact.updated'], ['email', 'fields.plan'], 'contactParts.1'],
    ] as const;
    for (const [index, [events, contactParts, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, contactParts },
            idem(`parts-bad-${index}`, JSON.stringify(contactParts)),
          ),
        ),
        JSON.stringify(contactParts),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'parts-1', {
      url: receiverUrl(),
      events: ['contact.updated', 'contact.erased'],
      contactParts: ['tags', 'email', 'tags'],
    });
    const id = created.body.data.id;
    expect(created.body.data.contactParts).toEqual(['email', 'tags']);
    expect((await api().get(key.ctx, id)).contactParts).toEqual(['email', 'tags']);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ contactParts: ['email', 'tags'] });

    expect(await api().update(key.ctx, id, { description: 'Emails and tags' })).toMatchObject({
      contactParts: ['email', 'tags'],
    });
    expect(await api().update(key.ctx, id, { contactParts: ['fields'] })).toMatchObject({
      contactParts: ['fields'],
    });
    const updates = await fx.query<{ metadata: { contactParts?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.contactParts)).toEqual([['email', 'tags'], ['fields']]);
    expect(await api().update(key.ctx, id, { events: ['contact.updated'] })).toMatchObject({
      contactParts: ['fields'],
    });
    expect(await api().update(key.ctx, id, { events: ['contact.erased'] })).toMatchObject({
      events: ['contact.erased'],
      contactParts: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { contactParts: ['name'] }))).toMatchObject({
      path: 'contactParts',
    });
    expect(
      await api().update(key.ctx, id, { events: ['contact.updated'], contactParts: ['name'] }),
    ).toMatchObject({ contactParts: ['name'] });
    expect(await api().update(key.ctx, id, { contactParts: null })).toMatchObject({
      contactParts: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { contactParts: [] }))).toMatchObject({
      path: 'contactParts',
    });
  });

  it('choose the campaign statuses an endpoint receives, kept by changes that leave them out and cleared with the event (ADR-146)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Statuses need the event, at least one, and each from the list (an unknown one by place).
    const refusals = [
      [['message.status'], ['paused'], 'campaignStatuses'],
      [['campaign.status_changed'], [], 'campaignStatuses'],
      [['campaign.status_changed'], ['paused', 'sending'], 'campaignStatuses.1'],
    ] as const;
    for (const [index, [events, campaignStatuses, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, campaignStatuses },
            idem(`campaign-statuses-bad-${index}`, JSON.stringify(campaignStatuses)),
          ),
        ),
        JSON.stringify(campaignStatuses),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'campaign-statuses-1', {
      url: receiverUrl(),
      events: ['campaign.status_changed', 'message.status'],
      campaignStatuses: ['completed', 'paused', 'completed'],
    });
    const id = created.body.data.id;
    expect(created.body.data.campaignStatuses).toEqual(['paused', 'completed']);
    expect((await api().get(key.ctx, id)).campaignStatuses).toEqual(['paused', 'completed']);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ campaignStatuses: ['paused', 'completed'] });

    expect(await api().update(key.ctx, id, { description: 'Outcomes' })).toMatchObject({
      campaignStatuses: ['paused', 'completed'],
    });
    expect(await api().update(key.ctx, id, { campaignStatuses: ['canceled'] })).toMatchObject({
      campaignStatuses: ['canceled'],
    });
    const updates = await fx.query<{ metadata: { campaignStatuses?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.campaignStatuses)).toEqual([
      ['paused', 'completed'],
      ['canceled'],
    ]);
    expect(await api().update(key.ctx, id, { events: ['message.status'] })).toMatchObject({
      events: ['message.status'],
      campaignStatuses: null,
    });
    expect(
      await issueOf(api().update(key.ctx, id, { campaignStatuses: ['paused'] })),
    ).toMatchObject({ path: 'campaignStatuses' });
    expect(
      await api().update(key.ctx, id, {
        events: ['campaign.status_changed'],
        campaignStatuses: ['running'],
      }),
    ).toMatchObject({ campaignStatuses: ['running'] });
    expect(await api().update(key.ctx, id, { campaignStatuses: null })).toMatchObject({
      campaignStatuses: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { campaignStatuses: [] }))).toMatchObject({
      path: 'campaignStatuses',
    });
  });

  it('choose the order statuses an endpoint receives, kept by changes that leave them out and cleared with the event (ADR-147)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Statuses need the event, at least one, and each from the list (received or an unknown one by
    // place).
    const refusals = [
      [['order.received'], ['paid'], 'orderStatuses'],
      [['order.status_changed'], [], 'orderStatuses'],
      [['order.status_changed'], ['paid', 'received'], 'orderStatuses.1'],
      [['order.status_changed'], ['canceled'], 'orderStatuses.0'],
    ] as const;
    for (const [index, [events, orderStatuses, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, orderStatuses },
            idem(`order-statuses-bad-${index}`, JSON.stringify(orderStatuses)),
          ),
        ),
        JSON.stringify(orderStatuses),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'order-statuses-1', {
      url: receiverUrl(),
      events: ['order.status_changed', 'message.status'],
      orderStatuses: ['cancelled', 'paid', 'cancelled'],
    });
    const id = created.body.data.id;
    expect(created.body.data.orderStatuses).toEqual(['paid', 'cancelled']);
    expect((await api().get(key.ctx, id)).orderStatuses).toEqual(['paid', 'cancelled']);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ orderStatuses: ['paid', 'cancelled'] });

    expect(await api().update(key.ctx, id, { description: 'Outcomes' })).toMatchObject({
      orderStatuses: ['paid', 'cancelled'],
    });
    expect(await api().update(key.ctx, id, { orderStatuses: ['fulfilled'] })).toMatchObject({
      orderStatuses: ['fulfilled'],
    });
    const updates = await fx.query<{ metadata: { orderStatuses?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.orderStatuses)).toEqual([
      ['paid', 'cancelled'],
      ['fulfilled'],
    ]);
    expect(await api().update(key.ctx, id, { events: ['message.status'] })).toMatchObject({
      events: ['message.status'],
      orderStatuses: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { orderStatuses: ['paid'] }))).toMatchObject({
      path: 'orderStatuses',
    });
    expect(
      await api().update(key.ctx, id, {
        events: ['order.status_changed'],
        orderStatuses: ['awaiting_payment'],
      }),
    ).toMatchObject({ orderStatuses: ['awaiting_payment'] });
    expect(await api().update(key.ctx, id, { orderStatuses: null })).toMatchObject({
      orderStatuses: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { orderStatuses: [] }))).toMatchObject({
      path: 'orderStatuses',
    });
  });

  it('choose the template statuses an endpoint receives, kept by changes that leave them out and cleared with the event (ADR-148)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Statuses need the event, at least one, and each from the list (one of HyFib's own steps or
    // an unknown one by place).
    const refusals = [
      [['message.status'], ['rejected'], 'templateStatuses'],
      [['template.status_changed'], [], 'templateStatuses'],
      [['template.status_changed'], ['rejected', 'submit_failed'], 'templateStatuses.1'],
      [['template.status_changed'], ['delete_failed'], 'templateStatuses.0'],
    ] as const;
    for (const [index, [events, templateStatuses, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, templateStatuses },
            idem(`template-statuses-bad-${index}`, JSON.stringify(templateStatuses)),
          ),
        ),
        JSON.stringify(templateStatuses),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'template-statuses-1', {
      url: receiverUrl(),
      events: ['template.status_changed', 'message.status'],
      templateStatuses: ['paused', 'rejected', 'paused'],
    });
    const id = created.body.data.id;
    expect(created.body.data.templateStatuses).toEqual(['rejected', 'paused']);
    expect((await api().get(key.ctx, id)).templateStatuses).toEqual(['rejected', 'paused']);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ templateStatuses: ['rejected', 'paused'] });

    expect(await api().update(key.ctx, id, { description: 'Reviews' })).toMatchObject({
      templateStatuses: ['rejected', 'paused'],
    });
    expect(await api().update(key.ctx, id, { templateStatuses: ['disabled'] })).toMatchObject({
      templateStatuses: ['disabled'],
    });
    const updates = await fx.query<{ metadata: { templateStatuses?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.templateStatuses)).toEqual([
      ['rejected', 'paused'],
      ['disabled'],
    ]);
    expect(await api().update(key.ctx, id, { events: ['message.status'] })).toMatchObject({
      events: ['message.status'],
      templateStatuses: null,
    });
    expect(
      await issueOf(api().update(key.ctx, id, { templateStatuses: ['rejected'] })),
    ).toMatchObject({ path: 'templateStatuses' });
    expect(
      await api().update(key.ctx, id, {
        events: ['template.status_changed'],
        templateStatuses: ['limit_exceeded'],
      }),
    ).toMatchObject({ templateStatuses: ['limit_exceeded'] });
    expect(await api().update(key.ctx, id, { templateStatuses: null })).toMatchObject({
      templateStatuses: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { templateStatuses: [] }))).toMatchObject({
      path: 'templateStatuses',
    });
  });

  it('choose the conversation statuses an endpoint receives, kept by changes that leave them out and cleared with the event (ADR-149)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Statuses need the event, at least one, and each from the list (pending or an unknown one by
    // place).
    const refusals = [
      [['conversation.team_changed'], ['resolved'], 'conversationStatuses'],
      [['conversation.status_changed'], [], 'conversationStatuses'],
      [['conversation.status_changed'], ['resolved', 'pending'], 'conversationStatuses.1'],
      [['conversation.status_changed'], ['closed'], 'conversationStatuses.0'],
    ] as const;
    for (const [index, [events, conversationStatuses, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, conversationStatuses },
            idem(`conversation-statuses-bad-${index}`, JSON.stringify(conversationStatuses)),
          ),
        ),
        JSON.stringify(conversationStatuses),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'conversation-statuses-1', {
      url: receiverUrl(),
      events: ['conversation.status_changed', 'message.status'],
      conversationStatuses: ['resolved', 'open'],
    });
    const id = created.body.data.id;
    expect(created.body.data.conversationStatuses).toEqual(['open', 'resolved']);
    expect((await api().get(key.ctx, id)).conversationStatuses).toEqual(['open', 'resolved']);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ conversationStatuses: ['open', 'resolved'] });

    expect(await api().update(key.ctx, id, { description: 'Conversations' })).toMatchObject({
      conversationStatuses: ['open', 'resolved'],
    });
    expect(await api().update(key.ctx, id, { conversationStatuses: ['resolved'] })).toMatchObject({
      conversationStatuses: ['resolved'],
    });
    const updates = await fx.query<{ metadata: { conversationStatuses?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.conversationStatuses)).toEqual([
      ['open', 'resolved'],
      ['resolved'],
    ]);
    expect(await api().update(key.ctx, id, { events: ['message.status'] })).toMatchObject({
      events: ['message.status'],
      conversationStatuses: null,
    });
    expect(
      await issueOf(api().update(key.ctx, id, { conversationStatuses: ['resolved'] })),
    ).toMatchObject({ path: 'conversationStatuses' });
    expect(
      await api().update(key.ctx, id, {
        events: ['conversation.status_changed'],
        conversationStatuses: ['open'],
      }),
    ).toMatchObject({ conversationStatuses: ['open'] });
    expect(await api().update(key.ctx, id, { conversationStatuses: null })).toMatchObject({
      conversationStatuses: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { conversationStatuses: [] }))).toMatchObject({
      path: 'conversationStatuses',
    });
  });

  it('choose how the runs an endpoint receives ended, kept by changes that leave them out and cleared with the event (ADR-151)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // The statuses need the event, at least one, and each from the list (a status a run has while
    // it goes on, or an unknown one, by place).
    const refusals = [
      [['automation.run_started'], ['failed'], 'runEndStatuses'],
      [['automation.run_ended'], [], 'runEndStatuses'],
      [['automation.run_ended'], ['failed', 'running'], 'runEndStatuses.1'],
      [['automation.run_ended'], ['crashed'], 'runEndStatuses.0'],
    ] as const;
    for (const [index, [events, runEndStatuses, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, runEndStatuses },
            idem(`run-end-statuses-bad-${index}`, JSON.stringify(runEndStatuses)),
          ),
        ),
        JSON.stringify(runEndStatuses),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'run-end-statuses-1', {
      url: receiverUrl(),
      events: ['automation.run_ended', 'message.status'],
      runEndStatuses: ['failed', 'taken_over'],
    });
    const id = created.body.data.id;
    expect(created.body.data.runEndStatuses).toEqual(['taken_over', 'failed']);
    expect((await api().get(key.ctx, id)).runEndStatuses).toEqual(['taken_over', 'failed']);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ runEndStatuses: ['taken_over', 'failed'] });

    expect(await api().update(key.ctx, id, { description: 'Run ends' })).toMatchObject({
      runEndStatuses: ['taken_over', 'failed'],
    });
    expect(await api().update(key.ctx, id, { runEndStatuses: ['failed'] })).toMatchObject({
      runEndStatuses: ['failed'],
    });
    const updates = await fx.query<{ metadata: { runEndStatuses?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.runEndStatuses)).toEqual([
      ['taken_over', 'failed'],
      ['failed'],
    ]);
    expect(await api().update(key.ctx, id, { events: ['message.status'] })).toMatchObject({
      events: ['message.status'],
      runEndStatuses: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { runEndStatuses: ['failed'] }))).toMatchObject({
      path: 'runEndStatuses',
    });
    expect(
      await api().update(key.ctx, id, {
        events: ['automation.run_ended'],
        runEndStatuses: ['stopped'],
      }),
    ).toMatchObject({ runEndStatuses: ['stopped'] });
    expect(await api().update(key.ctx, id, { runEndStatuses: null })).toMatchObject({
      runEndStatuses: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { runEndStatuses: [] }))).toMatchObject({
      path: 'runEndStatuses',
    });
  });

  it('choose the automations whose runs an endpoint receives, kept by changes that leave them out and cleared with the events (ADR-145)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const greeter = await automationOf(c, 'Greeter');
    const farewell = await automationOf(c, 'Farewell');
    const draft = await automationOf(c, 'Draft', false);
    const elsewhere = await automationOf(await fx.company(), 'Elsewhere');
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    const runs = ['automation.run_started', 'automation.run_ended'];
    // Automations need a run event, at least one, each an id of the company's published
    // automations (named by place).
    const refusals = [
      [['consent.changed'], [greeter], 'automationIds'],
      [runs, [], 'automationIds'],
      [runs, [greeter, 'greeter'], 'automationIds.1'],
      [runs, [greeter, draft], 'automationIds.1'],
      [['automation.run_ended'], [elsewhere], 'automationIds.0'],
    ] as const;
    for (const [index, [events, automationIds, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, automationIds },
            idem(`automations-bad-${index}`, JSON.stringify(automationIds)),
          ),
        ),
        JSON.stringify(automationIds),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'automations-1', {
      url: receiverUrl(),
      events: runs,
      automationIds: [greeter, farewell, greeter],
    });
    const id = created.body.data.id;
    expect(created.body.data.automationIds).toEqual([greeter, farewell]);
    expect((await api().get(key.ctx, id)).automationIds).toEqual([greeter, farewell]);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ automationIds: [greeter, farewell] });
    // Settings names them.
    const owner = await fx.ctx(c, c.owner);
    expect((await settings().list(owner)).find((e) => e.id === id)?.automations).toEqual([
      { id: greeter, name: 'Greeter', archived: false },
      { id: farewell, name: 'Farewell', archived: false },
    ]);

    expect(await api().update(key.ctx, id, { description: 'Greetings' })).toMatchObject({
      automationIds: [greeter, farewell],
    });
    expect(await api().update(key.ctx, id, { automationIds: [farewell] })).toMatchObject({
      automationIds: [farewell],
    });
    const updates = await fx.query<{ metadata: { automationIds?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.automationIds)).toEqual([[greeter, farewell], [farewell]]);
    expect(await api().update(key.ctx, id, { events: ['automation.run_ended'] })).toMatchObject({
      automationIds: [farewell],
    });
    expect(await api().update(key.ctx, id, { events: ['consent.changed'] })).toMatchObject({
      events: ['consent.changed'],
      automationIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { automationIds: [greeter] }))).toMatchObject({
      path: 'automationIds',
    });
    expect(
      await api().update(key.ctx, id, {
        events: ['automation.run_started'],
        automationIds: [greeter],
      }),
    ).toMatchObject({ automationIds: [greeter] });
    // A list given again is checked again, changing nothing when it is refused.
    expect(await issueOf(api().update(key.ctx, id, { automationIds: [draft] }))).toMatchObject({
      path: 'automationIds.0',
    });
    expect((await api().get(key.ctx, id)).automationIds).toEqual([greeter]);
    expect(await api().update(key.ctx, id, { automationIds: null })).toMatchObject({
      automationIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { automationIds: [] }))).toMatchObject({
      path: 'automationIds',
    });
  });

  it('choose who sent the messages whose statuses an endpoint receives, kept by changes that leave them out and cleared with the event (ADR-172)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // The senders need message.status, at least one, and each from the list (a contact, or an
    // unknown sender, by place).
    const refusals = [
      [['message.received'], ['api'], 'messageSenders'],
      [['message.status'], [], 'messageSenders'],
      [['message.status'], ['api', 'contact'], 'messageSenders.1'],
      [['message.status'], ['member'], 'messageSenders.0'],
    ] as const;
    for (const [index, [events, messageSenders, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, messageSenders },
            idem(`message-senders-bad-${index}`, JSON.stringify(messageSenders)),
          ),
        ),
        JSON.stringify(messageSenders),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'message-senders-1', {
      url: receiverUrl(),
      events: ['message.status', 'message.received'],
      messageSenders: ['api', 'bot'],
    });
    const id = created.body.data.id;
    expect(created.body.data.messageSenders).toEqual(['bot', 'api']);
    expect((await api().get(key.ctx, id)).messageSenders).toEqual(['bot', 'api']);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ messageSenders: ['bot', 'api'] });

    expect(await api().update(key.ctx, id, { description: 'API statuses' })).toMatchObject({
      messageSenders: ['bot', 'api'],
    });
    expect(await api().update(key.ctx, id, { messageSenders: ['api'] })).toMatchObject({
      messageSenders: ['api'],
    });
    const updates = await fx.query<{ metadata: { messageSenders?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.messageSenders)).toEqual([['bot', 'api'], ['api']]);
    expect(await api().update(key.ctx, id, { events: ['message.received'] })).toMatchObject({
      events: ['message.received'],
      messageSenders: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { messageSenders: ['api'] }))).toMatchObject({
      path: 'messageSenders',
    });
    expect(
      await api().update(key.ctx, id, { events: ['message.status'], messageSenders: ['system'] }),
    ).toMatchObject({ messageSenders: ['system'] });
    expect(await api().update(key.ctx, id, { messageSenders: null })).toMatchObject({
      messageSenders: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { messageSenders: [] }))).toMatchObject({
      path: 'messageSenders',
    });
  });

  it('choose the custom fields whose changes an endpoint receives, kept by changes that leave them out, a deleted one included, and cleared with the parts (ADR-184)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const fieldOf = async (company: Company, fieldKey: string, label: string) => {
      await fx.query(
        `INSERT INTO app.contact_fields (id, tenant_id, key, label, type) VALUES ($1, $2, $3, $4, 'text')`,
        [uuidv7(), company.tenant.id, fieldKey, label],
      );
      return fieldKey;
    };
    const city = await fieldOf(c, 'city', 'City');
    const tier = await fieldOf(c, 'tier', 'Tier');
    await fieldOf(await fx.company(), 'zone', 'Zone');
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Fields need contact.updated for every part or for fields, at least one, each a key of the
    // company's fields (named by place).
    const refusals = [
      [{ events: ['contact.created'], contactFieldKeys: [city] }, 'contactFieldKeys'],
      [
        { events: ['contact.updated'], contactParts: ['email'], contactFieldKeys: [city] },
        'contactFieldKeys',
      ],
      [{ events: ['contact.updated'], contactFieldKeys: [] }, 'contactFieldKeys'],
      [{ events: ['contact.updated'], contactFieldKeys: [city, 'City'] }, 'contactFieldKeys.1'],
      [{ events: ['contact.updated'], contactFieldKeys: [city, 'zone'] }, 'contactFieldKeys.1'],
    ] as const;
    for (const [index, [fields, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), ...fields },
            idem(`fields-bad-${index}`, JSON.stringify(fields)),
          ),
        ),
        JSON.stringify(fields),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'fields-1', {
      url: receiverUrl(),
      events: ['contact.updated'],
      contactFieldKeys: [tier, city, tier],
    });
    const id = created.body.data.id;
    expect(created.body.data.contactFieldKeys).toEqual([tier, city]);
    expect((await api().get(key.ctx, id)).contactFieldKeys).toEqual([tier, city]);
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { contactFieldKeys?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND subject_id = $2 AND action = $3 ORDER BY occurred_at, id`,
          [c.tenant.id, id, action],
        )
      ).map((a) => a.metadata.contactFieldKeys);
    expect(await audits('webhook.endpoint_created')).toEqual([[tier, city]]);
    // A field deleted since stays, and Settings says so; once off the list it is refused.
    await fx.query('DELETE FROM app.contact_fields WHERE tenant_id = $1 AND key = $2', [
      c.tenant.id,
      tier,
    ]);
    const owner = await fx.ctx(c, c.owner);
    expect((await settings().list(owner)).find((e) => e.id === id)?.contactFields).toEqual([
      { key: tier, label: null },
      { key: city, label: 'City' },
    ]);
    expect(await api().update(key.ctx, id, { description: 'Field sync' })).toMatchObject({
      contactFieldKeys: [tier, city],
    });
    expect(await api().update(key.ctx, id, { contactFieldKeys: [city] })).toMatchObject({
      contactFieldKeys: [city],
    });
    expect(
      await issueOf(api().update(key.ctx, id, { contactFieldKeys: [city, tier] })),
    ).toMatchObject({ path: 'contactFieldKeys.1' });
    expect(await audits('webhook.endpoint_updated')).toEqual([[tier, city], [city]]);
    // Parts with fields keep the list; parts without clear it, and fields given with them are
    // refused.
    expect(await api().update(key.ctx, id, { contactParts: ['name', 'fields'] })).toMatchObject({
      contactFieldKeys: [city],
    });
    expect(await api().update(key.ctx, id, { contactParts: ['name'] })).toMatchObject({
      contactParts: ['name'],
      contactFieldKeys: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { contactFieldKeys: [city] }))).toMatchObject({
      path: 'contactFieldKeys',
    });
    expect(
      await api().update(key.ctx, id, { contactParts: null, contactFieldKeys: [city] }),
    ).toMatchObject({ contactParts: null, contactFieldKeys: [city] });
    expect(await api().update(key.ctx, id, { contactFieldKeys: null })).toMatchObject({
      contactFieldKeys: null,
    });
  });

  it('choose what started the runs whose events an endpoint receives, kept by changes that leave them out and cleared with the events (ADR-183)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // What started the runs needs a run event, at least one, and each from the list (a test run,
    // which sends nothing, or an unknown trigger, by place).
    const refusals = [
      [['message.received'], ['api'], 'runTriggers'],
      [['automation.run_started'], [], 'runTriggers'],
      [['automation.run_started'], ['api', 'test'], 'runTriggers.1'],
      [['automation.run_ended'], ['webhook'], 'runTriggers.0'],
    ] as const;
    for (const [index, [events, runTriggers, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, runTriggers },
            idem(`run-triggers-bad-${index}`, JSON.stringify(runTriggers)),
          ),
        ),
        JSON.stringify(runTriggers),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'run-triggers-1', {
      url: receiverUrl(),
      events: ['automation.run_started', 'automation.run_ended'],
      runTriggers: ['api', 'store_event'],
    });
    const id = created.body.data.id;
    expect(created.body.data.runTriggers).toEqual(['store_event', 'api']);
    expect((await api().get(key.ctx, id)).runTriggers).toEqual(['store_event', 'api']);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ runTriggers: ['store_event', 'api'] });

    expect(await api().update(key.ctx, id, { description: 'Our own runs' })).toMatchObject({
      runTriggers: ['store_event', 'api'],
    });
    expect(await api().update(key.ctx, id, { runTriggers: ['api'] })).toMatchObject({
      runTriggers: ['api'],
    });
    const updates = await fx.query<{ metadata: { runTriggers?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.runTriggers)).toEqual([['store_event', 'api'], ['api']]);
    // Either run event keeps the list; neither clears it.
    expect(await api().update(key.ctx, id, { events: ['automation.run_ended'] })).toMatchObject({
      runTriggers: ['api'],
    });
    expect(await api().update(key.ctx, id, { events: ['message.received'] })).toMatchObject({
      events: ['message.received'],
      runTriggers: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { runTriggers: ['api'] }))).toMatchObject({
      path: 'runTriggers',
    });
    expect(
      await api().update(key.ctx, id, {
        events: ['automation.run_started'],
        runTriggers: ['keyword'],
      }),
    ).toMatchObject({ runTriggers: ['keyword'] });
    expect(await api().update(key.ctx, id, { runTriggers: null })).toMatchObject({
      runTriggers: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { runTriggers: [] }))).toMatchObject({
      path: 'runTriggers',
    });
  });

  it('choose the consent changes an endpoint receives, kept by changes that leave them out and cleared with the event (ADR-189)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // The changes need consent.changed, at least one, and each from the list, by place.
    const refusals = [
      [['contact.updated'], ['marketing_opt_out'], 'consentChanges'],
      [['consent.changed'], [], 'consentChanges'],
      [['consent.changed'], ['marketing_opt_out', 'opt_in'], 'consentChanges.1'],
      [['consent.changed'], ['marketing'], 'consentChanges.0'],
    ] as const;
    for (const [index, [events, consentChanges, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, consentChanges },
            idem(`consent-changes-bad-${index}`, JSON.stringify(consentChanges)),
          ),
        ),
        JSON.stringify(consentChanges),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'consent-changes-1', {
      url: receiverUrl(),
      events: ['consent.changed', 'contact.created'],
      consentChanges: ['utility_opt_out', 'marketing_opt_out'],
    });
    const id = created.body.data.id;
    expect(created.body.data.consentChanges).toEqual(['marketing_opt_out', 'utility_opt_out']);
    expect((await api().get(key.ctx, id)).consentChanges).toEqual([
      'marketing_opt_out',
      'utility_opt_out',
    ]);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({
      consentChanges: ['marketing_opt_out', 'utility_opt_out'],
    });

    expect(await api().update(key.ctx, id, { description: 'Mailing list' })).toMatchObject({
      consentChanges: ['marketing_opt_out', 'utility_opt_out'],
    });
    expect(
      await api().update(key.ctx, id, { consentChanges: ['marketing_opt_out'] }),
    ).toMatchObject({ consentChanges: ['marketing_opt_out'] });
    const updates = await fx.query<{ metadata: { consentChanges?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.consentChanges)).toEqual([
      ['marketing_opt_out', 'utility_opt_out'],
      ['marketing_opt_out'],
    ]);
    // Dropping the event clears the list.
    expect(await api().update(key.ctx, id, { events: ['contact.created'] })).toMatchObject({
      events: ['contact.created'],
      consentChanges: null,
    });
    expect(
      await issueOf(api().update(key.ctx, id, { consentChanges: ['utility_opt_in'] })),
    ).toMatchObject({ path: 'consentChanges' });
    expect(
      await api().update(key.ctx, id, {
        events: ['consent.changed'],
        consentChanges: ['utility_opt_in'],
      }),
    ).toMatchObject({ consentChanges: ['utility_opt_in'] });
    expect(await api().update(key.ctx, id, { consentChanges: null })).toMatchObject({
      consentChanges: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { consentChanges: [] }))).toMatchObject({
      path: 'consentChanges',
    });
  });

  it('choose where the added contacts an endpoint receives came from, kept by changes that leave them out and cleared with the event (ADR-190)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // The sources need contact.created, at least one, and each from the list, by place.
    const refusals = [
      [['contact.updated'], ['whatsapp'], 'contactSources'],
      [['contact.created'], [], 'contactSources'],
      [['contact.created'], ['whatsapp', 'agent'], 'contactSources.1'],
      [['contact.created'], ['flow'], 'contactSources.0'],
    ] as const;
    for (const [index, [events, contactSources, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, contactSources },
            idem(`contact-sources-bad-${index}`, JSON.stringify(contactSources)),
          ),
        ),
        JSON.stringify(contactSources),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    // An integration that adds contacts itself leaves out `api`.
    const created = await addThroughApi(key.ctx, 'contact-sources-1', {
      url: receiverUrl(),
      events: ['contact.created', 'contact.updated'],
      contactSources: ['store', 'whatsapp', 'manual', 'import'],
    });
    const id = created.body.data.id;
    expect(created.body.data.contactSources).toEqual(['whatsapp', 'manual', 'import', 'store']);
    expect((await api().get(key.ctx, id)).contactSources).toEqual([
      'whatsapp',
      'manual',
      'import',
      'store',
    ]);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({
      contactSources: ['whatsapp', 'manual', 'import', 'store'],
    });

    expect(await api().update(key.ctx, id, { description: 'CRM sync' })).toMatchObject({
      contactSources: ['whatsapp', 'manual', 'import', 'store'],
    });
    expect(await api().update(key.ctx, id, { contactSources: ['whatsapp'] })).toMatchObject({
      contactSources: ['whatsapp'],
    });
    const updates = await fx.query<{ metadata: { contactSources?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.contactSources)).toEqual([
      ['whatsapp', 'manual', 'import', 'store'],
      ['whatsapp'],
    ]);
    // Dropping the event clears the list.
    expect(await api().update(key.ctx, id, { events: ['contact.updated'] })).toMatchObject({
      events: ['contact.updated'],
      contactSources: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { contactSources: ['import'] }))).toMatchObject({
      path: 'contactSources',
    });
    expect(
      await api().update(key.ctx, id, { events: ['contact.created'], contactSources: ['import'] }),
    ).toMatchObject({ contactSources: ['import'] });
    expect(await api().update(key.ctx, id, { contactSources: null })).toMatchObject({
      contactSources: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { contactSources: [] }))).toMatchObject({
      path: 'contactSources',
    });
  });

  it('choose the types of the received messages an endpoint receives, kept by changes that leave them out and cleared with the event (ADR-191)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // The types need message.received, at least one, and each from the list, by place.
    const refusals = [
      [['message.status'], ['text'], 'messageTypes'],
      [['message.received'], [], 'messageTypes'],
      [['message.received'], ['text', 'template'], 'messageTypes.1'],
      [['message.received'], ['button_reply'], 'messageTypes.0'],
    ] as const;
    for (const [index, [events, messageTypes, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, messageTypes },
            idem(`message-types-bad-${index}`, JSON.stringify(messageTypes)),
          ),
        ),
        JSON.stringify(messageTypes),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'message-types-1', {
      url: receiverUrl(),
      events: ['message.received', 'message.status'],
      messageTypes: ['interactive', 'text', 'button'],
    });
    const id = created.body.data.id;
    expect(created.body.data.messageTypes).toEqual(['text', 'interactive', 'button']);
    expect((await api().get(key.ctx, id)).messageTypes).toEqual(['text', 'interactive', 'button']);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ messageTypes: ['text', 'interactive', 'button'] });

    expect(await api().update(key.ctx, id, { description: 'Chatbot' })).toMatchObject({
      messageTypes: ['text', 'interactive', 'button'],
    });
    expect(await api().update(key.ctx, id, { messageTypes: ['order'] })).toMatchObject({
      messageTypes: ['order'],
    });
    const updates = await fx.query<{ metadata: { messageTypes?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.messageTypes)).toEqual([
      ['text', 'interactive', 'button'],
      ['order'],
    ]);
    // Dropping the event clears the list.
    expect(await api().update(key.ctx, id, { events: ['message.status'] })).toMatchObject({
      events: ['message.status'],
      messageTypes: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { messageTypes: ['text'] }))).toMatchObject({
      path: 'messageTypes',
    });
    expect(
      await api().update(key.ctx, id, { events: ['message.received'], messageTypes: ['text'] }),
    ).toMatchObject({ messageTypes: ['text'] });
    expect(await api().update(key.ctx, id, { messageTypes: null })).toMatchObject({
      messageTypes: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { messageTypes: [] }))).toMatchObject({
      path: 'messageTypes',
    });
  });

  it('choose why the runs an endpoint receives ended, of the ends it receives, kept by changes that leave them out (less those of ends dropped) and cleared with the event (ADR-192)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // The reasons need automation.run_ended, at least one, each from the list (by place) and of an
    // end the endpoint receives.
    const refusals = [
      [['automation.run_started'], null, ['expired'], 'runEndReasons'],
      [['automation.run_ended'], null, [], 'runEndReasons'],
      [['automation.run_ended'], null, ['expired', 'failed'], 'runEndReasons.1'],
      [['automation.run_ended'], null, ['budget'], 'runEndReasons.0'],
      [['automation.run_ended'], ['completed'], ['send_failed'], 'runEndReasons'],
    ] as const;
    for (const [index, [events, runEndStatuses, runEndReasons, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, runEndStatuses, runEndReasons },
            idem(`run-end-reasons-bad-${index}`, JSON.stringify(runEndReasons)),
          ),
        ),
        JSON.stringify(runEndReasons),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'run-end-reasons-1', {
      url: receiverUrl(),
      events: ['automation.run_started', 'automation.run_ended'],
      runEndStatuses: ['completed', 'failed'],
      runEndReasons: ['send_failed', 'no_next', 'send_blocked'],
    });
    const id = created.body.data.id;
    expect(created.body.data.runEndReasons).toEqual(['no_next', 'send_blocked', 'send_failed']);
    expect((await api().get(key.ctx, id)).runEndReasons).toEqual([
      'no_next',
      'send_blocked',
      'send_failed',
    ]);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({
      runEndReasons: ['no_next', 'send_blocked', 'send_failed'],
    });

    expect(await api().update(key.ctx, id, { description: 'Alerts' })).toMatchObject({
      runEndReasons: ['no_next', 'send_blocked', 'send_failed'],
    });
    // Dropping an end drops its reasons from the list.
    expect(await api().update(key.ctx, id, { runEndStatuses: ['failed'] })).toMatchObject({
      runEndStatuses: ['failed'],
      runEndReasons: ['send_blocked', 'send_failed'],
    });
    expect(await api().update(key.ctx, id, { runEndReasons: ['expired'] })).toMatchObject({
      runEndReasons: ['expired'],
    });
    const updates = await fx.query<{ metadata: { runEndReasons?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.runEndReasons)).toEqual([
      ['no_next', 'send_blocked', 'send_failed'],
      ['send_blocked', 'send_failed'],
      ['expired'],
    ]);
    // A reason of an end it no longer receives is refused against the ends it keeps…
    expect(await issueOf(api().update(key.ctx, id, { runEndReasons: ['end_node'] }))).toMatchObject(
      { path: 'runEndReasons' },
    );
    // …or against the ends given with it.
    expect(
      await issueOf(
        api().update(key.ctx, id, { runEndStatuses: ['stopped'], runEndReasons: ['expired'] }),
      ),
    ).toMatchObject({ path: 'runEndReasons' });
    // The ends changing so that none of its reasons is left takes every reason.
    expect(await api().update(key.ctx, id, { runEndStatuses: ['completed'] })).toMatchObject({
      runEndStatuses: ['completed'],
      runEndReasons: null,
    });
    // Dropping the event clears the list.
    expect(
      await api().update(key.ctx, id, {
        runEndStatuses: null,
        runEndReasons: ['end_node', 'handoff_node'],
      }),
    ).toMatchObject({ runEndStatuses: null, runEndReasons: ['end_node', 'handoff_node'] });
    expect(await api().update(key.ctx, id, { events: ['automation.run_started'] })).toMatchObject({
      events: ['automation.run_started'],
      runEndReasons: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { runEndReasons: ['expired'] }))).toMatchObject({
      path: 'runEndReasons',
    });
    expect(
      await api().update(key.ctx, id, {
        events: ['automation.run_ended'],
        runEndReasons: ['expired'],
      }),
    ).toMatchObject({ runEndReasons: ['expired'] });
    expect(await api().update(key.ctx, id, { runEndReasons: null })).toMatchObject({
      runEndReasons: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { runEndReasons: [] }))).toMatchObject({
      path: 'runEndReasons',
    });
  });

  it('choose the WhatsApp numbers whose events an endpoint receives, kept by changes that leave them out and cleared with the events (ADR-170)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const main = c.channelAccountId;
    const outlet = (await fx.addNumber(c, { phone: '+91 90000 54321', name: 'Outlet' }))
      .channelAccountId;
    const elsewhere = (await fx.company()).channelAccountId;
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Numbers need an event that happens on one, at least one, each an id of the company's
    // numbers (named by place).
    const refusals = [
      [['consent.changed', 'contact.created', 'template.status_changed'], [main], 'channelIds'],
      [['message.received'], [], 'channelIds'],
      [['message.received'], [main, 'outlet'], 'channelIds.1'],
      [['order.received'], [main, elsewhere], 'channelIds.1'],
      [['campaign.status_changed'], [uuidv7()], 'channelIds.0'],
    ] as const;
    for (const [index, [events, channelIds, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, channelIds },
            idem(`numbers-bad-${index}`, JSON.stringify(channelIds)),
          ),
        ),
        JSON.stringify(channelIds),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'numbers-1', {
      url: receiverUrl(),
      events: ['message.received', 'contact.created'],
      channelIds: [outlet, main.toUpperCase(), outlet],
    });
    const id = created.body.data.id;
    expect(created.body.data.channelIds).toEqual([outlet, main]);
    expect((await api().get(key.ctx, id)).channelIds).toEqual([outlet, main]);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ channelIds: [outlet, main] });
    // Settings names them.
    const owner = await fx.ctx(c, c.owner);
    expect((await settings().list(owner)).find((e) => e.id === id)?.channels).toEqual([
      { id: outlet, label: '+91 90000 54321 · Outlet', status: 'active' },
      { id: main, label: '+91 90000 00000', status: 'active' },
    ]);

    expect(await api().update(key.ctx, id, { description: 'Outlet' })).toMatchObject({
      channelIds: [outlet, main],
    });
    expect(await api().update(key.ctx, id, { channelIds: [outlet] })).toMatchObject({
      channelIds: [outlet],
    });
    const updates = await fx.query<{ metadata: { channelIds?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.channelIds)).toEqual([[outlet, main], [outlet]]);
    // Any event of a number keeps the list; events of none clear it.
    expect(
      await api().update(key.ctx, id, { events: ['conversation.team_changed'] }),
    ).toMatchObject({ channelIds: [outlet] });
    expect(await api().update(key.ctx, id, { events: ['contact.created'] })).toMatchObject({
      events: ['contact.created'],
      channelIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { channelIds: [main] }))).toMatchObject({
      path: 'channelIds',
    });
    expect(
      await api().update(key.ctx, id, { events: ['automation.run_ended'], channelIds: [main] }),
    ).toMatchObject({ channelIds: [main] });
    // A list given again is checked again, changing nothing when it is refused.
    expect(await issueOf(api().update(key.ctx, id, { channelIds: [elsewhere] }))).toMatchObject({
      path: 'channelIds.0',
    });
    expect((await api().get(key.ctx, id)).channelIds).toEqual([main]);
    expect(await api().update(key.ctx, id, { channelIds: null })).toMatchObject({
      channelIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { channelIds: [] }))).toMatchObject({
      path: 'channelIds',
    });
  });

  it("choose the teams whose conversations' events an endpoint receives, kept by changes that leave them out, a deleted one included, and cleared with the events (ADR-174)", async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const teamOf = async (company: Company, name: string) => {
      const id = uuidv7();
      await fx.query('INSERT INTO app.teams (id, tenant_id, name) VALUES ($1, $2, $3)', [
        id,
        company.tenant.id,
        name,
      ]);
      return id;
    };
    const support = await teamOf(c, 'Support');
    const sales = await teamOf(c, 'Sales');
    const elsewhere = await teamOf(await fx.company(), 'Support');
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Teams need an event of a conversation, at least one, each an id of the company's teams
    // (named by place).
    const refusals = [
      [['order.received', 'automation.run_started'], [support], 'teamIds'],
      [['message.received'], [], 'teamIds'],
      [['message.received'], [support, 'sales'], 'teamIds.1'],
      [['message.status'], [support, elsewhere], 'teamIds.1'],
      [['conversation.team_changed'], [uuidv7()], 'teamIds.0'],
    ] as const;
    for (const [index, [events, teamIds, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, teamIds },
            idem(`teams-bad-${index}`, JSON.stringify(teamIds)),
          ),
        ),
        JSON.stringify(teamIds),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'teams-1', {
      url: receiverUrl(),
      events: ['message.received', 'contact.created'],
      teamIds: [sales, support.toUpperCase(), sales],
    });
    const id = created.body.data.id;
    expect(created.body.data.teamIds).toEqual([sales, support]);
    expect((await api().get(key.ctx, id)).teamIds).toEqual([sales, support]);
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { teamIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND subject_id = $2 AND action = $3 ORDER BY occurred_at, id`,
          [c.tenant.id, id, action],
        )
      ).map((a) => a.metadata.teamIds);
    expect(await audits('webhook.endpoint_created')).toEqual([[sales, support]]);
    // Settings names them; a deleted one is named by its absence, and may stay on the list.
    const owner = await fx.ctx(c, c.owner);
    await fx.query('DELETE FROM app.teams WHERE id = $1', [sales]);
    expect((await settings().list(owner)).find((e) => e.id === id)?.teams).toEqual([
      { id: sales, name: null },
      { id: support, name: 'Support' },
    ]);
    expect(await api().update(key.ctx, id, { description: 'Support desk' })).toMatchObject({
      teamIds: [sales, support],
    });
    expect(await api().update(key.ctx, id, { teamIds: [support, sales] })).toMatchObject({
      teamIds: [support, sales],
    });
    expect(await api().update(key.ctx, id, { teamIds: [support] })).toMatchObject({
      teamIds: [support],
    });
    // Once off the list, a deleted team is refused like any unknown one.
    expect(await issueOf(api().update(key.ctx, id, { teamIds: [support, sales] }))).toMatchObject({
      path: 'teamIds.1',
    });
    expect(await audits('webhook.endpoint_updated')).toEqual([
      [sales, support],
      [support, sales],
      [support],
    ]);
    // Any event of a conversation keeps the list; events of none clear it.
    expect(
      await api().update(key.ctx, id, { events: ['conversation.assignment_changed'] }),
    ).toMatchObject({ teamIds: [support] });
    expect(await api().update(key.ctx, id, { events: ['contact.created'] })).toMatchObject({
      events: ['contact.created'],
      teamIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { teamIds: [support] }))).toMatchObject({
      path: 'teamIds',
    });
    expect(
      await api().update(key.ctx, id, { events: ['message.status'], teamIds: [support] }),
    ).toMatchObject({ teamIds: [support] });
    expect(await api().update(key.ctx, id, { teamIds: null })).toMatchObject({ teamIds: null });
    expect(await issueOf(api().update(key.ctx, id, { teamIds: [] }))).toMatchObject({
      path: 'teamIds',
    });
  });

  it("choose the templates whose messages' statuses and changes an endpoint receives, kept by changes that leave them out and cleared with the events (ADR-175)", async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const templateOf = async (company: Company, name: string, language: string) => {
      const id = uuidv7();
      await fx.query(
        `INSERT INTO app.message_templates (id, tenant_id, whatsapp_account_id, name, language,
           category, components, status)
         VALUES ($1, $2, $3, $4, $5, 'UTILITY', '[]'::jsonb, 'approved')`,
        [id, company.tenant.id, company.whatsappAccountId, name, language],
      );
      return id;
    };
    const orders = await templateOf(c, 'order_update', 'en_US');
    const otp = await templateOf(c, 'login_code', 'en');
    const elsewhere = await templateOf(await fx.company(), 'order_update', 'en_US');
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Templates need message.status or template.status_changed, at least one, each an id of the
    // company's templates (named by place).
    const refusals = [
      [['message.received', 'campaign.status_changed'], [orders], 'templateIds'],
      [['message.status'], [], 'templateIds'],
      [['message.status'], [orders, 'login_code'], 'templateIds.1'],
      [['template.status_changed'], [orders, elsewhere], 'templateIds.1'],
      [['message.status'], [uuidv7()], 'templateIds.0'],
    ] as const;
    for (const [index, [events, templateIds, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, templateIds },
            idem(`templates-bad-${index}`, JSON.stringify(templateIds)),
          ),
        ),
        JSON.stringify(templateIds),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'templates-1', {
      url: receiverUrl(),
      events: ['message.status', 'contact.created'],
      templateIds: [otp, orders.toUpperCase(), otp],
    });
    const id = created.body.data.id;
    expect(created.body.data.templateIds).toEqual([otp, orders]);
    expect((await api().get(key.ctx, id)).templateIds).toEqual([otp, orders]);
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { templateIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND subject_id = $2 AND action = $3 ORDER BY occurred_at, id`,
          [c.tenant.id, id, action],
        )
      ).map((a) => a.metadata.templateIds);
    expect(await audits('webhook.endpoint_created')).toEqual([[otp, orders]]);
    // Settings names them by name and language.
    const owner = await fx.ctx(c, c.owner);
    expect((await settings().list(owner)).find((e) => e.id === id)?.templates).toEqual([
      { id: otp, name: 'login_code', language: 'en' },
      { id: orders, name: 'order_update', language: 'en_US' },
    ]);
    expect(await api().update(key.ctx, id, { description: 'Order updates' })).toMatchObject({
      templateIds: [otp, orders],
    });
    expect(await api().update(key.ctx, id, { templateIds: [orders] })).toMatchObject({
      templateIds: [orders],
    });
    expect(await audits('webhook.endpoint_updated')).toEqual([[otp, orders], [orders]]);
    // Either event of a template keeps the list; events of neither clear it.
    expect(await api().update(key.ctx, id, { events: ['template.status_changed'] })).toMatchObject({
      templateIds: [orders],
    });
    expect(await api().update(key.ctx, id, { events: ['contact.created'] })).toMatchObject({
      events: ['contact.created'],
      templateIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { templateIds: [orders] }))).toMatchObject({
      path: 'templateIds',
    });
    expect(
      await api().update(key.ctx, id, { events: ['message.status'], templateIds: [otp] }),
    ).toMatchObject({ templateIds: [otp] });
    // A list given again is checked again, changing nothing when it is refused.
    expect(await issueOf(api().update(key.ctx, id, { templateIds: [elsewhere] }))).toMatchObject({
      path: 'templateIds.0',
    });
    expect((await api().get(key.ctx, id)).templateIds).toEqual([otp]);
    expect(await api().update(key.ctx, id, { templateIds: null })).toMatchObject({
      templateIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { templateIds: [] }))).toMatchObject({
      path: 'templateIds',
    });
  });

  it("choose the campaigns whose messages' statuses and changes an endpoint receives, kept by changes that leave them out and cleared with the events (ADR-185)", async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const campaignOf = async (company: Company, name: string) => {
      const id = uuidv7();
      await fx.query(
        `INSERT INTO app.campaigns (id, tenant_id, name, timezone)
         VALUES ($1, $2, $3, 'Asia/Kolkata')`,
        [id, company.tenant.id, name],
      );
      return id;
    };
    const autumn = await campaignOf(c, 'Autumn launch');
    const diwali = await campaignOf(c, 'Diwali offer');
    const elsewhere = await campaignOf(await fx.company(), 'Autumn launch');
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Campaigns need message.status or campaign.status_changed, at least one, each an id of the
    // company's campaigns (named by place).
    const refusals = [
      [['message.received', 'template.status_changed'], [autumn], 'campaignIds'],
      [['message.status'], [], 'campaignIds'],
      [['message.status'], [autumn, 'diwali_offer'], 'campaignIds.1'],
      [['campaign.status_changed'], [autumn, elsewhere], 'campaignIds.1'],
      [['message.status'], [uuidv7()], 'campaignIds.0'],
    ] as const;
    for (const [index, [events, campaignIds, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, campaignIds },
            idem(`campaigns-bad-${index}`, JSON.stringify(campaignIds)),
          ),
        ),
        JSON.stringify(campaignIds),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'campaigns-1', {
      url: receiverUrl(),
      events: ['message.status', 'contact.created'],
      campaignIds: [diwali, autumn.toUpperCase(), diwali],
    });
    const id = created.body.data.id;
    expect(created.body.data.campaignIds).toEqual([diwali, autumn]);
    expect((await api().get(key.ctx, id)).campaignIds).toEqual([diwali, autumn]);
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { campaignIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND subject_id = $2 AND action = $3 ORDER BY occurred_at, id`,
          [c.tenant.id, id, action],
        )
      ).map((a) => a.metadata.campaignIds);
    expect(await audits('webhook.endpoint_created')).toEqual([[diwali, autumn]]);
    // Settings names them by name and status.
    const owner = await fx.ctx(c, c.owner);
    expect((await settings().list(owner)).find((e) => e.id === id)?.campaigns).toEqual([
      { id: diwali, name: 'Diwali offer', status: 'draft' },
      { id: autumn, name: 'Autumn launch', status: 'draft' },
    ]);
    expect(await api().update(key.ctx, id, { description: 'Campaign reports' })).toMatchObject({
      campaignIds: [diwali, autumn],
    });
    expect(await api().update(key.ctx, id, { campaignIds: [autumn] })).toMatchObject({
      campaignIds: [autumn],
    });
    expect(await audits('webhook.endpoint_updated')).toEqual([[diwali, autumn], [autumn]]);
    // Either event of a campaign keeps the list; events of neither clear it.
    expect(await api().update(key.ctx, id, { events: ['campaign.status_changed'] })).toMatchObject({
      campaignIds: [autumn],
    });
    expect(await api().update(key.ctx, id, { events: ['contact.created'] })).toMatchObject({
      events: ['contact.created'],
      campaignIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { campaignIds: [autumn] }))).toMatchObject({
      path: 'campaignIds',
    });
    expect(
      await api().update(key.ctx, id, { events: ['message.status'], campaignIds: [diwali] }),
    ).toMatchObject({ campaignIds: [diwali] });
    // A list given again is checked again, changing nothing when it is refused.
    expect(await issueOf(api().update(key.ctx, id, { campaignIds: [elsewhere] }))).toMatchObject({
      path: 'campaignIds.0',
    });
    expect((await api().get(key.ctx, id)).campaignIds).toEqual([diwali]);
    expect(await api().update(key.ctx, id, { campaignIds: null })).toMatchObject({
      campaignIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { campaignIds: [] }))).toMatchObject({
      path: 'campaignIds',
    });
  });

  it("choose the pipelines whose deals' events an endpoint receives, archived ones too, kept by changes that leave them out and cleared with the events (ADR-263)", async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const crm = createCrmService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
    });
    const pipelineOf = async (company: Company, name: string) => {
      const owner = await fx.ctx(company, company.owner);
      return (await crm.createPipeline(owner, { name, currency: 'INR', stages: ['New'] })).id;
    };
    const sales = await pipelineOf(c, 'Sales');
    const renewals = await pipelineOf(c, 'Renewals');
    const elsewhere = await pipelineOf(await fx.company(), 'Sales');
    const owner = await fx.ctx(c, c.owner);
    const [listed] = (await crm.listPipelines(owner)).filter((p) => p.id === renewals);
    await crm.archivePipeline(owner, { id: renewals, expectedVersion: listed!.version });
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Pipelines need a deal event, at least one, each an id of the company's pipelines (named by
    // place).
    const refusals = [
      [['task.created', 'task.status_changed'], [sales], 'pipelineIds'],
      [['deal.created'], [], 'pipelineIds'],
      [['deal.created'], [sales, 'Renewals'], 'pipelineIds.1'],
      [['deal.stage_changed'], [sales, elsewhere], 'pipelineIds.1'],
      [['deal.status_changed'], [uuidv7()], 'pipelineIds.0'],
    ] as const;
    for (const [index, [events, pipelineIds, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, pipelineIds },
            idem(`pipelines-bad-${index}`, JSON.stringify(pipelineIds)),
          ),
        ),
        JSON.stringify(pipelineIds),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'pipelines-1', {
      url: receiverUrl(),
      events: ['deal.created', 'contact.created'],
      pipelineIds: [renewals, sales.toUpperCase(), renewals],
    });
    const id = created.body.data.id;
    expect(created.body.data.pipelineIds).toEqual([renewals, sales]);
    expect((await api().get(key.ctx, id)).pipelineIds).toEqual([renewals, sales]);
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { pipelineIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND subject_id = $2 AND action = $3 ORDER BY occurred_at, id`,
          [c.tenant.id, id, action],
        )
      ).map((a) => a.metadata.pipelineIds);
    expect(await audits('webhook.endpoint_created')).toEqual([[renewals, sales]]);
    // Settings names them, the archived one as archived.
    expect((await settings().list(owner)).find((e) => e.id === id)?.pipelines).toEqual([
      { id: renewals, name: 'Renewals', archived: true },
      { id: sales, name: 'Sales', archived: false },
    ]);
    expect(await api().update(key.ctx, id, { description: 'Deals sync' })).toMatchObject({
      pipelineIds: [renewals, sales],
    });
    expect(await api().update(key.ctx, id, { pipelineIds: [sales] })).toMatchObject({
      pipelineIds: [sales],
    });
    expect(await audits('webhook.endpoint_updated')).toEqual([[renewals, sales], [sales]]);
    // Any deal event keeps the list; events without one clear it.
    expect(await api().update(key.ctx, id, { events: ['deal.status_changed'] })).toMatchObject({
      pipelineIds: [sales],
    });
    expect(await api().update(key.ctx, id, { events: ['task.created'] })).toMatchObject({
      events: ['task.created'],
      pipelineIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { pipelineIds: [sales] }))).toMatchObject({
      path: 'pipelineIds',
    });
    expect(
      await api().update(key.ctx, id, { events: ['deal.stage_changed'], pipelineIds: [renewals] }),
    ).toMatchObject({ pipelineIds: [renewals] });
    // A list given again is checked again, changing nothing when it is refused.
    expect(await issueOf(api().update(key.ctx, id, { pipelineIds: [elsewhere] }))).toMatchObject({
      path: 'pipelineIds.0',
    });
    expect((await api().get(key.ctx, id)).pipelineIds).toEqual([renewals]);
    expect(await api().update(key.ctx, id, { pipelineIds: null })).toMatchObject({
      pipelineIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { pipelineIds: [] }))).toMatchObject({
      path: 'pipelineIds',
    });
  });

  it("choose the members whose assigned conversations' events an endpoint receives, kept by changes that leave them out, one who stopped taking conversations included, and cleared with the events (ADR-181)", async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const owner = await fx.ctx(c, c.owner);
    const agent = (await fx.ctx(c, c.agent)).membership.id;
    const ownerId = owner.membership.id;
    const marketer = (await fx.ctx(c, c.marketer)).membership.id;
    const other = await fx.company();
    const elsewhere = (await fx.ctx(other, other.agent)).membership.id;
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Members need an event of a conversation, at least one, each a member of the company who
    // takes conversations, as GET /members lists them (named by place).
    const refusals = [
      [['order.received', 'automation.run_started'], [agent], 'assigneeIds'],
      [['message.received'], [], 'assigneeIds'],
      [['message.received'], [agent, 'agent'], 'assigneeIds.1'],
      [['message.status'], [agent, marketer], 'assigneeIds.1'],
      [['message.status'], [agent, elsewhere], 'assigneeIds.1'],
      [['conversation.assignment_changed'], [uuidv7()], 'assigneeIds.0'],
    ] as const;
    for (const [index, [events, assigneeIds, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, assigneeIds },
            idem(`assignees-bad-${index}`, JSON.stringify(assigneeIds)),
          ),
        ),
        JSON.stringify(assigneeIds),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'assignees-1', {
      url: receiverUrl(),
      events: ['message.received', 'contact.created'],
      assigneeIds: [agent, ownerId.toUpperCase(), agent],
    });
    const id = created.body.data.id;
    expect(created.body.data.assigneeIds).toEqual([agent, ownerId]);
    expect((await api().get(key.ctx, id)).assigneeIds).toEqual([agent, ownerId]);
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { assigneeIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND subject_id = $2 AND action = $3 ORDER BY occurred_at, id`,
          [c.tenant.id, id, action],
        )
      ).map((a) => a.metadata.assigneeIds);
    expect(await audits('webhook.endpoint_created')).toEqual([[agent, ownerId]]);
    // A member who stops taking conversations stays on the list, and settings says so.
    await fx.query(`UPDATE app.memberships SET status = 'suspended' WHERE id = $1`, [agent]);
    expect((await settings().list(owner)).find((e) => e.id === id)?.assignees).toEqual([
      { id: agent, name: 'Agent', assignable: false },
      { id: ownerId, name: 'Owner', assignable: true },
    ]);
    expect(await api().update(key.ctx, id, { description: 'Agent desk' })).toMatchObject({
      assigneeIds: [agent, ownerId],
    });
    expect(await api().update(key.ctx, id, { assigneeIds: [ownerId, agent] })).toMatchObject({
      assigneeIds: [ownerId, agent],
    });
    expect(await api().update(key.ctx, id, { assigneeIds: [ownerId] })).toMatchObject({
      assigneeIds: [ownerId],
    });
    // Once off the list, they are refused like any member who takes no conversations.
    expect(
      await issueOf(api().update(key.ctx, id, { assigneeIds: [ownerId, agent] })),
    ).toMatchObject({ path: 'assigneeIds.1' });
    expect(await audits('webhook.endpoint_updated')).toEqual([
      [agent, ownerId],
      [ownerId, agent],
      [ownerId],
    ]);
    // Any event of a conversation keeps the list; events of none clear it.
    expect(
      await api().update(key.ctx, id, { events: ['conversation.team_changed'] }),
    ).toMatchObject({ assigneeIds: [ownerId] });
    expect(await api().update(key.ctx, id, { events: ['contact.created'] })).toMatchObject({
      events: ['contact.created'],
      assigneeIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { assigneeIds: [ownerId] }))).toMatchObject({
      path: 'assigneeIds',
    });
    expect(
      await api().update(key.ctx, id, { events: ['message.status'], assigneeIds: [ownerId] }),
    ).toMatchObject({ assigneeIds: [ownerId] });
    expect(await api().update(key.ctx, id, { assigneeIds: null })).toMatchObject({
      assigneeIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { assigneeIds: [] }))).toMatchObject({
      path: 'assigneeIds',
    });
  });

  it('refuse keys without the scope, suspended and restricted companies, bad input, addresses the egress guard refuses and an eleventh endpoint, changing nothing', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const reader = await apiKey(c, ['contacts.read']);
    const valid = { url: receiverUrl(), events: ['message.received'] };
    await expectAppError(api().list(reader.ctx), 'forbidden', /webhooks\.manage/);
    await expectAppError(
      api().create(reader.ctx, valid, idem('no-scope', 'x')),
      'forbidden',
      /webhooks\.manage/,
    );

    for (const [body, message] of [
      [{ ...valid, events: [] }, /at least one event/],
      [{ ...valid, events: ['message.deleted'] }, /from the list/],
      [{ events: ['message.received'] }, /URL/],
      [{ ...valid, secret: 'mine' }, /./],
      [{ ...valid, description: 'x'.repeat(201) }, /under 200/],
    ] as const) {
      await expectAppError(
        api().create(key.ctx, body, idem(`bad-${JSON.stringify(body)}`, JSON.stringify(body))),
        'validation_failed',
        message,
      );
    }
    // The egress guard's rules for an address where loopback is not allowed (production): https
    // only, no credentials, port 443 or from 1024 (private and local addresses are refused when a
    // delivery connects, as for members' endpoints).
    for (const url of [
      'http://hooks.example.com/w360',
      'https://user:secret@hooks.example.com/w360',
      'https://hooks.example.com:25/w360',
      'not a url',
    ]) {
      await expectAppError(
        api(systemClock, false).create(key.ctx, { ...valid, url }, idem(`guard-${url}`, url)),
        'validation_failed',
      );
    }

    const added = await addThroughApi(key.ctx, 'limit-0', valid);
    const id = added.body.data.id;
    // The address cannot change, and a change must name something.
    await expectAppError(api().update(key.ctx, id, { url: receiverUrl() }), 'validation_failed');
    await expectAppError(api().update(key.ctx, id, {}), 'validation_failed', /Give the events/);
    await expectAppError(api().get(key.ctx, 'not-a-uuid'), 'not_found');

    // Ten endpoints in all, members' included.
    const owner = await fx.ctx(c, c.owner);
    for (let i = 1; i < 9; i += 1) {
      await addThroughApi(key.ctx, `limit-${i}`, { ...valid, url: receiverUrl() });
    }
    await settings().create(owner, { url: receiverUrl(), eventTypes: ['message.status'] });
    await expectAppError(
      addThroughApi(key.ctx, 'limit-11', { ...valid, url: receiverUrl() }),
      'precondition_failed',
      /10 webhook endpoints/,
    );
    const [count] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.webhook_endpoints WHERE tenant_id = $1`,
      [c.tenant.id],
    );
    expect(count?.n).toBe(10);
    expect(await companyNotices(c.tenant.id)).toHaveLength(9);

    // Suspended or restricted: the scope writes, so nothing is read or changed.
    for (const status of ['suspended', 'restricted'] as const) {
      await fx.query(`UPDATE app.tenants SET status = $2 WHERE id = $1`, [c.tenant.id, status]);
      const blocked = await authenticateApiToken(fx.dbs.app, key.token, 'r');
      if (!blocked) throw new Error('the key no longer authenticates');
      await expectAppError(api().list(blocked), 'tenant_suspended');
      await expectAppError(api().remove(blocked, id), 'tenant_suspended');
    }
    await fx.query(`UPDATE app.tenants SET status = 'active' WHERE id = $1`, [c.tenant.id]);
    expect((await api().get(key.ctx, id)).status).toBe('active');
  });

  it('keep exactly one creator on every endpoint, a key of the company, fixed once written', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const added = await addThroughApi(key.ctx, 'creator-1', {
      url: receiverUrl(),
      events: ['message.received'],
    });
    const id = added.body.data.id;
    // Both, or neither: the check refuses (as the owner of the tables, beyond row security).
    await expect(
      fx.dbs.adminPool.query(
        `UPDATE app.webhook_endpoints SET created_by_user_id = $2 WHERE id = $1`,
        [id, c.owner.id],
      ),
    ).rejects.toThrow(/webhook_endpoints_creator/);
    await expect(
      fx.dbs.adminPool.query(
        `UPDATE app.webhook_endpoints SET created_by_api_key_id = NULL WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/webhook_endpoints_creator/);
    // The key must be one of the company's own.
    const other = await fx.company();
    const stranger = await apiKey(other, ['webhooks.manage']);
    await expect(
      fx.dbs.adminPool.query(
        `UPDATE app.webhook_endpoints SET created_by_api_key_id = $2 WHERE id = $1`,
        [id, stranger.id],
      ),
    ).rejects.toThrow(/webhook_endpoints_api_key_fk/);
    // The runtime role cannot change who created an endpoint.
    await expect(
      fx.dbs.app.run(authorizedTenantScope(c.tenant.id, null), (tx) =>
        tx.execute(
          sql`UPDATE app.webhook_endpoints SET created_by_api_key_id = NULL WHERE id = ${id}`,
        ),
      ),
    ).rejects.toThrow();
  });
});

describe('deliveries, test events and replays through the API (ADR-083)', () => {
  type DeliveryBody = { data: Record<string, unknown> & { id: string; eventId: string } };
  const pingsAt = (path: string) =>
    received
      .filter((r) => r.path === path)
      .map((r) => ({ request: r, body: JSON.parse(r.body) as { id: string; type: string } }));

  it('send a test event once per key, page the deliveries and replay a finished one, audited as the key', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage'], 'Zap connector');
    const path = `/ok/${randomBytes(6).toString('hex')}`;
    const created = await addThroughApi(key.ctx, 'ep-1', {
      url: receiverUrl(path),
      events: ['message.received'],
    });
    const { id, secret } = created.body.data;
    if (!secret) throw new Error('no secret');

    // A test event, once per Idempotency-Key, answered with its delivery.
    const first = await api().sendTest(key.ctx, id, idem('t-1', 't-1'));
    expect(first.status).toBe(201);
    const queued = (first.body as DeliveryBody).data;
    expect(queued).toEqual({
      id: expect.any(String),
      endpointId: id,
      eventId: expect.any(String),
      eventType: 'ping',
      status: 'pending',
      attempts: 0,
      nextAttemptAt: expect.any(String),
      lastAttemptAt: null,
      lastStatusCode: null,
      lastError: null,
      lastDurationMs: null,
      deliveredAt: null,
      replayOf: null,
      createdAt: expect.any(String),
    });
    expect(await api().sendTest(key.ctx, id, idem('t-1', 't-1'))).toEqual({
      ...first,
      replayed: true,
    });
    expect(await api().getDelivery(key.ctx, queued.id)).toEqual(queued);

    // Delivered to the receiver, signed with the endpoint's secret.
    await deliverDue(c);
    const pings = pingsAt(path);
    expect(pings.map((p) => [p.body.type, p.body.id])).toEqual([['ping', queued.eventId]]);
    expect(signedWith(pings[0]!.request, secret)).toBe(true);
    expect(await api().getDelivery(key.ctx, queued.id)).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      nextAttemptAt: null,
      lastStatusCode: 204,
      lastError: null,
      deliveredAt: expect.any(String),
    });

    // A second test; the deliveries newest first, a page at a time and by state.
    const second = (await api().sendTest(key.ctx, id, idem('t-2', 't-2'))).body as DeliveryBody;
    await deliverDue(c);
    const all = await api().deliveries(key.ctx, id, {});
    expect(all.data.map((d) => d.id)).toEqual([second.data.id, queued.id]);
    expect(all.nextCursor).toBeNull();
    const page1 = await api().deliveries(key.ctx, id, { limit: '1' });
    expect(page1.data.map((d) => d.id)).toEqual([second.data.id]);
    const page2 = await api().deliveries(key.ctx, id, {
      limit: '1',
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.data.map((d) => d.id)).toEqual([queued.id]);
    expect(page2.nextCursor).toBeNull();
    expect((await api().deliveries(key.ctx, id, { status: 'succeeded' })).data).toHaveLength(2);
    expect((await api().deliveries(key.ctx, id, { status: 'failed' })).data).toEqual([]);

    // A replay of the first delivery: its event again, as a new delivery, once per key.
    const replay = await api().replay(key.ctx, queued.id, idem('r-1', 'r-1'));
    expect(replay.status).toBe(201);
    const replayed = (replay.body as DeliveryBody).data;
    expect(replayed).toMatchObject({
      endpointId: id,
      eventId: queued.eventId,
      eventType: 'ping',
      status: 'pending',
      replayOf: queued.id,
    });
    expect(replayed.id).not.toBe(queued.id);
    expect(await api().replay(key.ctx, queued.id, idem('r-1', 'r-1'))).toEqual({
      ...replay,
      replayed: true,
    });
    await deliverDue(c);
    expect(pingsAt(path).map((p) => p.body.id)).toEqual([
      queued.eventId,
      second.data.eventId,
      queued.eventId,
    ]);
    const audit = await fx.query<{ action: string; actor_type: string; metadata: unknown }>(
      `SELECT action, actor_type, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.delivery_replayed'`,
      [c.tenant.id],
    );
    expect(audit).toEqual([
      {
        action: 'webhook.delivery_replayed',
        actor_type: 'api_key',
        metadata: {
          host: HOST,
          deliveryId: queued.id,
          newDeliveryId: replayed.id,
          source: 'api',
        },
      },
    ]);
  });

  it('reach only deliveries to endpoints keys added, and refuse what cannot be sent or replayed', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const theirs = await apiKey(other, ['webhooks.manage']);
    const created = await addThroughApi(key.ctx, 'ep-1', {
      url: receiverUrl(),
      events: ['message.received'],
    });
    const { id } = created.body.data;
    const pending = (await api().sendTest(key.ctx, id, idem('t-1', 't-1'))).body as DeliveryBody;

    // A member's endpoint and its test delivery are not found through the API.
    const owner = await fx.ctx(c, c.owner);
    const members = await settings().create(owner, {
      url: receiverUrl(),
      eventTypes: ['message.received'],
    });
    const { deliveryId: membersDelivery } = await settings().sendTest(owner, {
      endpointId: members.id,
    });
    await expectAppError(api().deliveries(key.ctx, members.id, {}), 'not_found', /endpoint/);
    await expectAppError(
      api().sendTest(key.ctx, members.id, idem('t-2', 't-2')),
      'not_found',
      /endpoint/,
    );
    await expectAppError(api().getDelivery(key.ctx, membersDelivery), 'not_found', /Delivery/);
    await expectAppError(
      api().replay(key.ctx, membersDelivery, idem('r-1', 'r-1')),
      'not_found',
      /Delivery/,
    );
    // Nor are they for another company's key, or for unknown and malformed ids.
    await expectAppError(api().deliveries(theirs.ctx, id, {}), 'not_found');
    await expectAppError(api().getDelivery(theirs.ctx, pending.data.id), 'not_found');
    await expectAppError(
      api().replay(theirs.ctx, pending.data.id, idem('r-2', 'r-2')),
      'not_found',
    );
    await expectAppError(
      api().sendTest(theirs.ctx, id, idem('t-3', 't-3')),
      'not_found',
      /endpoint/,
    );
    await expectAppError(api().getDelivery(key.ctx, uuidv7()), 'not_found');
    await expectAppError(api().getDelivery(key.ctx, 'not-a-uuid'), 'not_found');
    await expectAppError(api().deliveries(key.ctx, id, { status: 'lost' }), 'validation_failed');

    // A delivery still waiting cannot be replayed; an endpoint that is off takes no test or replay.
    await expectAppError(
      api().replay(key.ctx, pending.data.id, idem('r-3', 'r-3')),
      'conflict',
      /still being attempted/,
    );
    await deliverDue(c);
    await api().update(key.ctx, id, { enabled: false });
    await expectAppError(
      api().sendTest(key.ctx, id, idem('t-4', 't-4')),
      'precondition_failed',
      /Turn the endpoint on/,
    );
    await expectAppError(
      api().replay(key.ctx, pending.data.id, idem('r-4', 'r-4')),
      'precondition_failed',
      /Turn the endpoint on/,
    );
    // A key without the scope, and a suspended company.
    const reader = await apiKey(c, ['contacts.read']);
    await expectAppError(api().deliveries(reader.ctx, id, {}), 'forbidden');
    await fx.query(`UPDATE app.tenants SET status = 'suspended' WHERE id = $1`, [c.tenant.id]);
    const blocked = await authenticateApiToken(fx.dbs.app, key.token, 'r');
    if (!blocked) throw new Error('the key no longer authenticates');
    await expectAppError(api().deliveries(blocked, id, {}), 'tenant_suspended');
    await expectAppError(
      api().replay(blocked, pending.data.id, idem('r-5', 'r-5')),
      'tenant_suspended',
    );
    await fx.query(`UPDATE app.tenants SET status = 'active' WHERE id = $1`, [c.tenant.id]);

    // Refusals stored nothing: the one test delivery, and the member's.
    const [counts] = await fx.query<{ deliveries: number; kept: number }>(
      `SELECT (SELECT count(*)::int FROM app.webhook_deliveries WHERE tenant_id = $1) AS deliveries,
              (SELECT count(*)::int FROM app.api_idempotency_keys WHERE api_key_id = $2) AS kept`,
      [c.tenant.id, key.id],
    );
    expect(counts).toEqual({ deliveries: 2, kept: 2 });
  });
});

/** Events whose deliveries to the endpoint failed for good, written straight to the tables. */
async function failedDeliveries(c: Company, endpointId: string, count: number) {
  const rows = Array.from({ length: count }, () => ({ eventId: uuidv7(), deliveryId: uuidv7() }));
  for (const r of rows) {
    await fx.query(
      `INSERT INTO app.webhook_events (id, tenant_id, type, detail)
       VALUES ($1, $2, 'message.received', '{}')`,
      [r.eventId, c.tenant.id],
    );
    await fx.query(
      `INSERT INTO app.webhook_deliveries (id, tenant_id, endpoint_id, event_id, state, attempts,
                                           last_error, last_status_code)
       VALUES ($1, $2, $3, $4, 'failed', 8, 'invalid_status', 500)`,
      [r.deliveryId, c.tenant.id, endpointId, r.eventId],
    );
  }
  return rows;
}

describe('replaying failed deliveries through the API (ADR-095)', () => {
  it("replay an endpoint's failed deliveries once per Idempotency-Key, audited as the key, and refuse what cannot be replayed", async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage'], 'Zap connector');
    const created = await addThroughApi(key.ctx, 'ep-1', {
      url: receiverUrl(),
      events: ['message.received'],
    });
    const { id } = created.body.data;
    const rows = await failedDeliveries(c, id, 2);
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const replays = () =>
      fx.query<{ event_id: string; replay_of: string; state: string }>(
        `SELECT event_id, replay_of, state FROM app.webhook_deliveries
          WHERE endpoint_id = $1 AND replay_of IS NOT NULL ORDER BY event_id`,
        [id],
      );

    // Both events again, once per Idempotency-Key.
    const first = await api().replayFailed(key.ctx, id, { since }, idem('rf-1', since));
    expect(first).toMatchObject({ status: 200, body: { data: { queued: 2, more: false } } });
    expect(await api().replayFailed(key.ctx, id, { since }, idem('rf-1', since))).toEqual({
      ...first,
      replayed: true,
    });
    const byEvent = [...rows].sort((a, b) => a.eventId.localeCompare(b.eventId));
    expect(await replays()).toEqual(
      byEvent.map((r) => ({ event_id: r.eventId, replay_of: r.deliveryId, state: 'pending' })),
    );
    // Another request while those wait queues nothing.
    expect((await api().replayFailed(key.ctx, id, { since }, idem('rf-2', since))).body).toEqual({
      data: { queued: 0, more: false },
    });
    const audit = await fx.query<{ action: string; actor_type: string; metadata: unknown }>(
      `SELECT action, actor_type, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.deliveries_replayed' ORDER BY occurred_at, id`,
      [c.tenant.id],
    );
    expect(audit).toEqual([
      {
        action: 'webhook.deliveries_replayed',
        actor_type: 'api_key',
        metadata: { host: HOST, since, queued: 2, more: false, source: 'api' },
      },
      {
        action: 'webhook.deliveries_replayed',
        actor_type: 'api_key',
        metadata: { host: HOST, since, queued: 0, more: false, source: 'api' },
      },
    ]);

    // Refused: a time still to come, a time that is not one, other fields, a key without the
    // scope, an endpoint a member added and an endpoint that is off.
    const future = new Date(Date.now() + 60_000).toISOString();
    const later = await expectAppError(
      api().replayFailed(key.ctx, id, { since: future }, idem('rf-3', future)),
      'validation_failed',
      /in the past/,
    );
    expect(isAppError(later) && later.issues).toEqual([
      { path: 'since', message: 'Give a time in the past.' },
    ]);
    await expectAppError(
      api().replayFailed(key.ctx, id, { since: 'yesterday' }, idem('rf-4', 'yesterday')),
      'validation_failed',
    );
    await expectAppError(
      api().replayFailed(key.ctx, id, { since, until: since }, idem('rf-5', 'until')),
      'validation_failed',
    );
    const reader = await apiKey(c, ['contacts.read']);
    await expectAppError(
      api().replayFailed(reader.ctx, id, { since }, idem('rf-6', since)),
      'forbidden',
    );
    const owner = await fx.ctx(c, c.owner);
    const members = await settings().create(owner, {
      url: receiverUrl(),
      eventTypes: ['message.received'],
    });
    await failedDeliveries(c, members.id, 1);
    await expectAppError(
      api().replayFailed(key.ctx, members.id, { since }, idem('rf-7', since)),
      'not_found',
    );
    // Only the events given (ADR-156): two more failed messages, left out for another event.
    await failedDeliveries(c, id, 2);
    const contacts = { since, events: ['contact.created'] };
    expect(
      (await api().replayFailed(key.ctx, id, contacts, idem('rf-9', JSON.stringify(contacts))))
        .body,
    ).toEqual({ data: { queued: 0, more: false } });
    const received = { since, events: ['message.received'] };
    expect(
      (await api().replayFailed(key.ctx, id, received, idem('rf-10', JSON.stringify(received))))
        .body,
    ).toEqual({ data: { queued: 2, more: false } });
    const [named] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.deliveries_replayed'
        ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [c.tenant.id],
    );
    expect(named?.metadata).toEqual({
      host: HOST,
      since,
      events: ['message.received'],
      queued: 2,
      more: false,
      source: 'api',
    });
    await expectAppError(
      api().replayFailed(key.ctx, id, { since, events: ['nope'] }, idem('rf-11', 'nope')),
      'validation_failed',
    );
    // Only the failures given (ADR-159): two more failed messages whose code says there was no valid
    // answer, which says more than the 500 an earlier attempt left, so server errors leave them out.
    await failedDeliveries(c, id, 2);
    const servers = { since, failures: ['server_error'] };
    expect(
      (await api().replayFailed(key.ctx, id, servers, idem('rf-12', JSON.stringify(servers)))).body,
    ).toEqual({ data: { queued: 0, more: false } });
    const unanswered = {
      since,
      events: ['message.received'],
      failures: ['no_answer', 'server_error'],
    };
    expect(
      (await api().replayFailed(key.ctx, id, unanswered, idem('rf-13', JSON.stringify(unanswered))))
        .body,
    ).toEqual({ data: { queued: 2, more: false } });
    const [kinds] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.deliveries_replayed'
        ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [c.tenant.id],
    );
    expect(kinds?.metadata).toEqual({
      host: HOST,
      since,
      events: ['message.received'],
      failures: ['server_error', 'no_answer'],
      queued: 2,
      more: false,
      source: 'api',
    });
    await expectAppError(
      api().replayFailed(key.ctx, id, { since, failures: ['timeouts'] }, idem('rf-14', 'timeouts')),
      'validation_failed',
    );
    await settings().setEnabled(owner, { endpointId: id, enabled: false });
    await expectAppError(
      api().replayFailed(key.ctx, id, { since }, idem('rf-8', since)),
      'precondition_failed',
    );
    // No refusal queued anything.
    expect(await replays()).toHaveLength(6);
    expect(
      await fx.query(
        'SELECT 1 FROM app.webhook_deliveries WHERE endpoint_id = $1 AND replay_of IS NOT NULL',
        [members.id],
      ),
    ).toEqual([]);
  });

  it('replay the failed deliveries of every endpoint the key added that is on, once per Idempotency-Key, audited once per endpoint (ADR-160)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage'], 'Zap connector');
    const add = async (name: string) =>
      (await addThroughApi(key.ctx, name, { url: receiverUrl(), events: ['message.received'] }))
        .body.data.id;
    const first = await add('all-1');
    const second = await add('all-2');
    const off = await add('all-3');
    const owner = await fx.ctx(c, c.owner);
    // An endpoint a member added is never the key's to replay.
    const members = await settings().create(owner, {
      url: receiverUrl(),
      eventTypes: ['message.received'],
    });
    await failedDeliveries(c, first, 2);
    await failedDeliveries(c, second, 1);
    await failedDeliveries(c, off, 1);
    await failedDeliveries(c, members.id, 1);
    await settings().setEnabled(owner, { endpointId: off, enabled: false });
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const replayedAt = (endpointId: string) =>
      fx.query<{ event_id: string }>(
        'SELECT event_id FROM app.webhook_deliveries WHERE endpoint_id = $1 AND replay_of IS NOT NULL',
        [endpointId],
      );

    const answer = await api().replayAllFailed(key.ctx, { since }, idem('ra-1', since));
    expect(answer).toEqual({
      status: 200,
      replayed: false,
      body: {
        data: {
          queued: 3,
          more: false,
          endpoints: [
            { id: first, queued: 2, more: false },
            { id: second, queued: 1, more: false },
          ],
        },
      },
    });
    // The same key answers the same and queues nothing more.
    expect(await api().replayAllFailed(key.ctx, { since }, idem('ra-1', since))).toEqual({
      ...answer,
      replayed: true,
    });
    expect(await replayedAt(first)).toHaveLength(2);
    expect(await replayedAt(second)).toHaveLength(1);
    expect(await replayedAt(off)).toEqual([]);
    expect(await replayedAt(members.id)).toEqual([]);
    const audit = await fx.query<{ subject_id: string; actor_type: string; metadata: unknown }>(
      `SELECT subject_id, actor_type, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'webhook.deliveries_replayed' ORDER BY occurred_at, id`,
      [c.tenant.id],
    );
    expect(audit).toEqual(
      [
        [first, 2],
        [second, 1],
      ].map(([subject, queued]) => ({
        subject_id: subject,
        actor_type: 'api_key',
        metadata: { host: HOST, since, queued, more: false, allEndpoints: true, source: 'api' },
      })),
    );

    // Of the events and failures given, as an endpoint's own replay takes them: another failed
    // message whose code says there was no valid answer is left out of server errors.
    await failedDeliveries(c, second, 1);
    const servers = { since, events: ['message.received'], failures: ['server_error'] };
    expect(
      (await api().replayAllFailed(key.ctx, servers, idem('ra-2', JSON.stringify(servers)))).body,
    ).toEqual({
      data: {
        queued: 0,
        more: false,
        endpoints: [
          { id: first, queued: 0, more: false },
          { id: second, queued: 0, more: false },
        ],
      },
    });
    const unanswered = { since, failures: ['no_answer'] };
    expect(
      (await api().replayAllFailed(key.ctx, unanswered, idem('ra-3', JSON.stringify(unanswered))))
        .body,
    ).toEqual({
      data: {
        queued: 1,
        more: false,
        endpoints: [
          { id: first, queued: 0, more: false },
          { id: second, queued: 1, more: false },
        ],
      },
    });

    // Refused: a time still to come, a kind not in the list, a key without the scope, and none of
    // the key's endpoints on.
    const future = new Date(Date.now() + 60_000).toISOString();
    await expectAppError(
      api().replayAllFailed(key.ctx, { since: future }, idem('ra-4', future)),
      'validation_failed',
      /in the past/,
    );
    await expectAppError(
      api().replayAllFailed(key.ctx, { since, failures: ['timeouts'] }, idem('ra-5', 'timeouts')),
      'validation_failed',
    );
    const reader = await apiKey(c, ['contacts.read']);
    await expectAppError(
      api().replayAllFailed(reader.ctx, { since }, idem('ra-6', since)),
      'forbidden',
    );
    for (const id of [first, second]) {
      await settings().setEnabled(owner, { endpointId: id, enabled: false });
    }
    await expectAppError(
      api().replayAllFailed(key.ctx, { since }, idem('ra-7', since)),
      'precondition_failed',
    );
    expect(await replayedAt(members.id)).toEqual([]);
    expect(await replayedAt(off)).toEqual([]);
  });
});
