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
  WEBHOOK_LIMITS,
  WebhookOAuthTokenCache,
  verifyWebhookSignature,
  webhookAuditMetadataBytes,
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
      messageApiKeyIds: null,
      contactParts: null,
      contactFieldKeys: null,
      automationIds: null,
      campaignStatuses: null,
      orderStatuses: null,
      paymentLinkStatuses: null,
      runStepOutcomes: null,
      runStepNodeTypes: null,
      orderChangeMakers: null,
      orderExcludedApiKeyIds: null,
      paymentLinkApiKeyIds: null,
      dealStatuses: null,
      taskStatuses: null,
      dealDetails: null,
      taskDetails: null,
      templateStatuses: null,
      conversationStatuses: null,
      runEndStatuses: null,
      runTriggers: null,
      runApiKeyIds: null,
      consentChanges: null,
      contactSources: null,
      messageTypes: null,
      runEndReasons: null,
      channelIds: null,
      teamIds: null,
      templateIds: null,
      campaignIds: null,
      pipelineIds: null,
      stageIds: null,
      ownerIds: null,
      taskAssigneeIds: null,
      taskPipelineIds: null,
      taskStageIds: null,
      taskDealOwnerIds: null,
      notePipelineIds: null,
      noteStageIds: null,
      noteDealOwnerIds: null,
      crmChangeMakers: null,
      crmExcludedApiKeyIds: null,
      surveyScores: null,
      surveyAssigneeIds: null,
      surveyTeamIds: null,
      surveyContactTags: null,
      surveyConversationTags: null,
      contactEventTags: null,
      contactEventFieldValues: null,
      assigneeIds: null,
      contactTags: null,
      conversationTags: null,
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

  it('choose the kinds of node whose run steps an endpoint receives, kept by changes that leave them out and cleared with the event (ADR-328)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Kinds need the step event, at least one, and each from the list (a trigger by place).
    const refusals = [
      [['automation.run_started'], ['wait'], 'runStepNodeTypes'],
      [['automation.run_step'], [], 'runStepNodeTypes'],
      [['automation.run_step'], ['wait', 'keyword'], 'runStepNodeTypes.1'],
      [['automation.run_step'], ['Wait'], 'runStepNodeTypes.0'],
    ] as const;
    for (const [index, [events, runStepNodeTypes, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, runStepNodeTypes },
            idem(`step-kinds-bad-${index}`, JSON.stringify(runStepNodeTypes)),
          ),
        ),
        JSON.stringify(runStepNodeTypes),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'step-kinds-1', {
      url: receiverUrl(),
      events: ['automation.run_step', 'automation.run_started'],
      runStepNodeTypes: ['wait', 'http_request', 'wait'],
    });
    const id = created.body.data.id;
    expect(created.body.data.runStepNodeTypes).toEqual(['http_request', 'wait']);
    expect((await api().get(key.ctx, id)).runStepNodeTypes).toEqual(['http_request', 'wait']);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ runStepNodeTypes: ['http_request', 'wait'] });

    expect(await api().update(key.ctx, id, { description: 'Web requests' })).toMatchObject({
      runStepNodeTypes: ['http_request', 'wait'],
    });
    // A list alone is a change; outside_node, the steps outside a node, comes last.
    expect(
      await api().update(key.ctx, id, { runStepNodeTypes: ['outside_node', 'end'] }),
    ).toMatchObject({ runStepNodeTypes: ['end', 'outside_node'] });
    const updates = await fx.query<{ metadata: { runStepNodeTypes?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.runStepNodeTypes)).toEqual([
      ['http_request', 'wait'],
      ['end', 'outside_node'],
    ]);
    expect(await api().update(key.ctx, id, { events: ['automation.run_started'] })).toMatchObject({
      events: ['automation.run_started'],
      runStepNodeTypes: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { runStepNodeTypes: ['end'] }))).toMatchObject({
      path: 'runStepNodeTypes',
    });
    expect(
      await api().update(key.ctx, id, {
        events: ['automation.run_step'],
        runStepNodeTypes: ['create_deal'],
      }),
    ).toMatchObject({ runStepNodeTypes: ['create_deal'] });
    expect(await api().update(key.ctx, id, { runStepNodeTypes: null })).toMatchObject({
      runStepNodeTypes: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { runStepNodeTypes: [] }))).toMatchObject({
      path: 'runStepNodeTypes',
    });
  });

  it('choose the outcomes of the run steps an endpoint receives, kept by changes that leave them out and cleared with the event (ADR-327)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Outcomes need the step event, at least one, and each from the list (by place).
    const refusals = [
      [['automation.run_ended'], ['failed'], 'runStepOutcomes'],
      [['automation.run_step'], [], 'runStepOutcomes'],
      [['automation.run_step'], ['failed', 'running'], 'runStepOutcomes.1'],
      [['automation.run_step'], ['Sent'], 'runStepOutcomes.0'],
    ] as const;
    for (const [index, [events, runStepOutcomes, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, runStepOutcomes },
            idem(`step-outcomes-bad-${index}`, JSON.stringify(runStepOutcomes)),
          ),
        ),
        JSON.stringify(runStepOutcomes),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'step-outcomes-1', {
      url: receiverUrl(),
      events: ['automation.run_step', 'automation.run_ended'],
      runStepOutcomes: ['failed', 'sent', 'failed'],
    });
    const id = created.body.data.id;
    expect(created.body.data.runStepOutcomes).toEqual(['sent', 'failed']);
    expect((await api().get(key.ctx, id)).runStepOutcomes).toEqual(['sent', 'failed']);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ runStepOutcomes: ['sent', 'failed'] });

    expect(await api().update(key.ctx, id, { description: 'Run steps' })).toMatchObject({
      runStepOutcomes: ['sent', 'failed'],
    });
    // A list alone is a change.
    expect(await api().update(key.ctx, id, { runStepOutcomes: ['timed_out'] })).toMatchObject({
      runStepOutcomes: ['timed_out'],
    });
    const updates = await fx.query<{ metadata: { runStepOutcomes?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.runStepOutcomes)).toEqual([
      ['sent', 'failed'],
      ['timed_out'],
    ]);
    expect(await api().update(key.ctx, id, { events: ['automation.run_ended'] })).toMatchObject({
      events: ['automation.run_ended'],
      runStepOutcomes: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { runStepOutcomes: ['failed'] }))).toMatchObject(
      { path: 'runStepOutcomes' },
    );
    expect(
      await api().update(key.ctx, id, {
        events: ['automation.run_step'],
        runStepOutcomes: ['closed'],
      }),
    ).toMatchObject({ runStepOutcomes: ['closed'] });
    expect(await api().update(key.ctx, id, { runStepOutcomes: null })).toMatchObject({
      runStepOutcomes: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { runStepOutcomes: [] }))).toMatchObject({
      path: 'runStepOutcomes',
    });
  });

  it('choose the Payment Link statuses an endpoint receives, kept by changes that leave them out and cleared with the event (ADR-308)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Statuses need the event, at least one, and each from the list (creating or an unknown one by
    // place).
    const refusals = [
      [['order.status_changed'], ['paid'], 'paymentLinkStatuses'],
      [['payment_link.status_changed'], [], 'paymentLinkStatuses'],
      [['payment_link.status_changed'], ['paid', 'creating'], 'paymentLinkStatuses.1'],
      [['payment_link.status_changed'], ['canceled'], 'paymentLinkStatuses.0'],
    ] as const;
    for (const [index, [events, paymentLinkStatuses, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, paymentLinkStatuses },
            idem(`link-statuses-bad-${index}`, JSON.stringify(paymentLinkStatuses)),
          ),
        ),
        JSON.stringify(paymentLinkStatuses),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'link-statuses-1', {
      url: receiverUrl(),
      events: ['payment_link.status_changed', 'order.status_changed'],
      paymentLinkStatuses: ['failed', 'paid', 'failed'],
    });
    const id = created.body.data.id;
    expect(created.body.data.paymentLinkStatuses).toEqual(['paid', 'failed']);
    expect((await api().get(key.ctx, id)).paymentLinkStatuses).toEqual(['paid', 'failed']);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ paymentLinkStatuses: ['paid', 'failed'] });

    expect(await api().update(key.ctx, id, { description: 'Payments' })).toMatchObject({
      paymentLinkStatuses: ['paid', 'failed'],
    });
    expect(await api().update(key.ctx, id, { paymentLinkStatuses: ['expired'] })).toMatchObject({
      paymentLinkStatuses: ['expired'],
    });
    const updates = await fx.query<{ metadata: { paymentLinkStatuses?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.paymentLinkStatuses)).toEqual([
      ['paid', 'failed'],
      ['expired'],
    ]);
    expect(await api().update(key.ctx, id, { events: ['order.status_changed'] })).toMatchObject({
      events: ['order.status_changed'],
      paymentLinkStatuses: null,
    });
    expect(
      await issueOf(api().update(key.ctx, id, { paymentLinkStatuses: ['paid'] })),
    ).toMatchObject({ path: 'paymentLinkStatuses' });
    expect(
      await api().update(key.ctx, id, {
        events: ['payment_link.status_changed'],
        paymentLinkStatuses: ['partially_paid'],
      }),
    ).toMatchObject({ paymentLinkStatuses: ['partially_paid'] });
    expect(await api().update(key.ctx, id, { paymentLinkStatuses: null })).toMatchObject({
      paymentLinkStatuses: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { paymentLinkStatuses: [] }))).toMatchObject({
      path: 'paymentLinkStatuses',
    });
  });

  it('choose who made the order changes an endpoint receives, kept by changes that leave them out and cleared with the event (ADR-322)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Makers need the event, at least one, and each from the list (an unknown one by place).
    const refusals = [
      [['order.received', 'payment_link.status_changed'], ['member'], 'orderChangeMakers'],
      [['order.status_changed'], [], 'orderChangeMakers'],
      [['order.status_changed'], ['member', 'automation'], 'orderChangeMakers.1'],
    ] as const;
    for (const [index, [events, orderChangeMakers, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, orderChangeMakers },
            idem(`order-makers-bad-${index}`, JSON.stringify(orderChangeMakers)),
          ),
        ),
        JSON.stringify(orderChangeMakers),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'order-makers-1', {
      url: receiverUrl(),
      events: ['order.status_changed', 'order.received'],
      orderChangeMakers: ['payment_link', 'member', 'payment_link'],
    });
    const id = created.body.data.id;
    expect(created.body.data.orderChangeMakers).toEqual(['member', 'payment_link']);
    expect((await api().get(key.ctx, id)).orderChangeMakers).toEqual(['member', 'payment_link']);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ orderChangeMakers: ['member', 'payment_link'] });

    expect(await api().update(key.ctx, id, { description: 'Orders' })).toMatchObject({
      orderChangeMakers: ['member', 'payment_link'],
    });
    expect(await api().update(key.ctx, id, { orderChangeMakers: ['api'] })).toMatchObject({
      orderChangeMakers: ['api'],
    });
    const updates = await fx.query<{ metadata: { orderChangeMakers?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.orderChangeMakers)).toEqual([
      ['member', 'payment_link'],
      ['api'],
    ]);
    expect(await api().update(key.ctx, id, { events: ['order.received'] })).toMatchObject({
      events: ['order.received'],
      orderChangeMakers: null,
    });
    expect(
      await issueOf(api().update(key.ctx, id, { orderChangeMakers: ['member'] })),
    ).toMatchObject({ path: 'orderChangeMakers' });
    expect(
      await api().update(key.ctx, id, {
        events: ['order.status_changed'],
        orderChangeMakers: ['payment_link'],
      }),
    ).toMatchObject({ orderChangeMakers: ['payment_link'] });
    expect(await api().update(key.ctx, id, { orderChangeMakers: null })).toMatchObject({
      orderChangeMakers: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { orderChangeMakers: [] }))).toMatchObject({
      path: 'orderChangeMakers',
    });
  });

  it('choose the deal and task statuses an endpoint receives, kept by changes that leave them out and cleared with the event (ADR-309)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Statuses need their event, at least one, and each from the list (an unknown one by place).
    const refusals = [
      [['deal.created'], { dealStatuses: ['won'] }, 'dealStatuses'],
      [['task.status_changed'], { dealStatuses: ['won'] }, 'dealStatuses'],
      [['deal.status_changed'], { dealStatuses: [] }, 'dealStatuses'],
      [['deal.status_changed'], { dealStatuses: ['won', 'done'] }, 'dealStatuses.1'],
      [['task.created'], { taskStatuses: ['done'] }, 'taskStatuses'],
      [['deal.status_changed'], { taskStatuses: ['done'] }, 'taskStatuses'],
      [['task.status_changed'], { taskStatuses: [] }, 'taskStatuses'],
      [['task.status_changed'], { taskStatuses: ['completed'] }, 'taskStatuses.0'],
    ] as const;
    for (const [index, [events, lists, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, ...lists },
            idem(`crm-statuses-bad-${index}`, JSON.stringify(lists)),
          ),
        ),
        JSON.stringify(lists),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'crm-statuses-1', {
      url: receiverUrl(),
      events: ['deal.status_changed', 'task.status_changed', 'message.status'],
      dealStatuses: ['lost', 'won', 'lost'],
      taskStatuses: ['cancelled', 'open'],
    });
    const id = created.body.data.id;
    expect(created.body.data).toMatchObject({
      dealStatuses: ['won', 'lost'],
      taskStatuses: ['open', 'cancelled'],
    });
    expect(await api().get(key.ctx, id)).toMatchObject({
      dealStatuses: ['won', 'lost'],
      taskStatuses: ['open', 'cancelled'],
    });
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({
      dealStatuses: ['won', 'lost'],
      taskStatuses: ['open', 'cancelled'],
    });

    expect(await api().update(key.ctx, id, { description: 'Outcomes' })).toMatchObject({
      dealStatuses: ['won', 'lost'],
      taskStatuses: ['open', 'cancelled'],
    });
    expect(await api().update(key.ctx, id, { dealStatuses: ['won'] })).toMatchObject({
      dealStatuses: ['won'],
      taskStatuses: ['open', 'cancelled'],
    });
    const updates = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => [u.metadata.dealStatuses, u.metadata.taskStatuses])).toEqual([
      [
        ['won', 'lost'],
        ['open', 'cancelled'],
      ],
      [['won'], ['open', 'cancelled']],
    ]);
    // Dropping the tasks' status changes clears their list only.
    expect(
      await api().update(key.ctx, id, { events: ['deal.status_changed', 'message.status'] }),
    ).toMatchObject({ dealStatuses: ['won'], taskStatuses: null });
    expect(await issueOf(api().update(key.ctx, id, { taskStatuses: ['done'] }))).toMatchObject({
      path: 'taskStatuses',
    });
    expect(await api().update(key.ctx, id, { dealStatuses: null })).toMatchObject({
      dealStatuses: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { dealStatuses: [] }))).toMatchObject({
      path: 'dealStatuses',
    });
  });

  it('choose the deal and task details whose changes an endpoint receives, kept by changes that leave them out and cleared with the event (ADR-310)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Details need their event, at least one, and each from the list (an unknown one by place).
    const refusals = [
      [['deal.created'], { dealDetails: ['title'] }, 'dealDetails'],
      [['task.updated'], { dealDetails: ['title'] }, 'dealDetails'],
      [['deal.updated'], { dealDetails: [] }, 'dealDetails'],
      [['deal.updated'], { dealDetails: ['title', 'notes'] }, 'dealDetails.1'],
      [['task.created'], { taskDetails: ['notes'] }, 'taskDetails'],
      [['deal.updated'], { taskDetails: ['notes'] }, 'taskDetails'],
      [['task.updated'], { taskDetails: [] }, 'taskDetails'],
      [['task.updated'], { taskDetails: ['valueMinor'] }, 'taskDetails.0'],
    ] as const;
    for (const [index, [events, lists, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, ...lists },
            idem(`crm-details-bad-${index}`, JSON.stringify(lists)),
          ),
        ),
        JSON.stringify(lists),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'crm-details-1', {
      url: receiverUrl(),
      events: ['deal.updated', 'task.updated', 'message.status'],
      dealDetails: ['expectedCloseOn', 'valueMinor', 'expectedCloseOn'],
      taskDetails: ['remindAt', 'dueAt'],
    });
    const id = created.body.data.id;
    const chosen = {
      dealDetails: ['valueMinor', 'expectedCloseOn'],
      taskDetails: ['dueAt', 'remindAt'],
    };
    expect(created.body.data).toMatchObject(chosen);
    expect(await api().get(key.ctx, id)).toMatchObject(chosen);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject(chosen);

    expect(await api().update(key.ctx, id, { description: 'Forecast' })).toMatchObject(chosen);
    expect(await api().update(key.ctx, id, { dealDetails: ['valueMinor'] })).toMatchObject({
      dealDetails: ['valueMinor'],
      taskDetails: ['dueAt', 'remindAt'],
    });
    const updates = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => [u.metadata.dealDetails, u.metadata.taskDetails])).toEqual([
      [
        ['valueMinor', 'expectedCloseOn'],
        ['dueAt', 'remindAt'],
      ],
      [['valueMinor'], ['dueAt', 'remindAt']],
    ]);
    // Dropping the tasks' detail changes clears their list only.
    expect(
      await api().update(key.ctx, id, { events: ['deal.updated', 'message.status'] }),
    ).toMatchObject({ dealDetails: ['valueMinor'], taskDetails: null });
    expect(await issueOf(api().update(key.ctx, id, { taskDetails: ['notes'] }))).toMatchObject({
      path: 'taskDetails',
    });
    expect(await api().update(key.ctx, id, { dealDetails: null })).toMatchObject({
      dealDetails: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { dealDetails: [] }))).toMatchObject({
      path: 'dealDetails',
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

  it('choose the API keys whose runs an endpoint receives, kept by changes that leave them out and cleared with the events (ADR-319)', async () => {
    const c = await fx.company();
    // The key adding the endpoint starts runs too; another key only starts them; one cannot.
    const key = await apiKey(c, ['webhooks.manage', 'automations.start'], 'Store');
    const crm = await apiKey(c, ['automations.start'], 'CRM');
    const reader = await apiKey(c, ['contacts.read'], 'Reader');
    const elsewhere = await apiKey(await fx.company(), ['automations.start'], 'Elsewhere');
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    const runs = ['automation.run_started', 'automation.run_ended'];
    // Keys need a run event, at least one, each an id of the company's keys that can start
    // automations (named by place).
    const refusals = [
      [['consent.changed'], [key.id], 'runApiKeyIds'],
      [runs, [], 'runApiKeyIds'],
      [runs, [key.id, key.keyPrefix], 'runApiKeyIds.1'],
      [runs, [key.id, reader.id], 'runApiKeyIds.1'],
      [['automation.run_ended'], [elsewhere.id], 'runApiKeyIds.0'],
    ] as const;
    for (const [index, [events, runApiKeyIds, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, runApiKeyIds },
            idem(`run-keys-bad-${index}`, JSON.stringify(runApiKeyIds)),
          ),
        ),
        JSON.stringify(runApiKeyIds),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'run-keys-1', {
      url: receiverUrl(),
      events: runs,
      runApiKeyIds: [key.id, crm.id, key.id.toUpperCase()],
    });
    const id = created.body.data.id;
    // The key finds its own id as the endpoint's.
    expect(created.body.data.apiKeyId).toBe(key.id);
    expect(created.body.data.runApiKeyIds).toEqual([key.id, crm.id]);
    expect((await api().get(key.ctx, id)).runApiKeyIds).toEqual([key.id, crm.id]);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ runApiKeyIds: [key.id, crm.id] });
    // Settings names them, with whether they still work.
    const owner = await fx.ctx(c, c.owner);
    await keys.revoke(owner, { keyId: crm.id });
    expect((await settings().list(owner)).find((e) => e.id === id)?.runApiKeys).toEqual([
      { id: key.id, name: 'Store', keyPrefix: key.keyPrefix, state: 'active' },
      { id: crm.id, name: 'CRM', keyPrefix: crm.keyPrefix, state: 'revoked' },
    ]);

    expect(await api().update(key.ctx, id, { description: 'Runs' })).toMatchObject({
      runApiKeyIds: [key.id, crm.id],
    });
    // A revoked key stays allowed: the runs it started still end.
    expect(await api().update(key.ctx, id, { runApiKeyIds: [crm.id] })).toMatchObject({
      runApiKeyIds: [crm.id],
    });
    const updates = await fx.query<{ metadata: { runApiKeyIds?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.runApiKeyIds)).toEqual([[key.id, crm.id], [crm.id]]);
    expect(await api().update(key.ctx, id, { events: ['automation.run_ended'] })).toMatchObject({
      runApiKeyIds: [crm.id],
    });
    expect(await api().update(key.ctx, id, { events: ['consent.changed'] })).toMatchObject({
      events: ['consent.changed'],
      runApiKeyIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { runApiKeyIds: [key.id] }))).toMatchObject({
      path: 'runApiKeyIds',
    });
    expect(
      await api().update(key.ctx, id, {
        events: ['automation.run_started'],
        runApiKeyIds: [key.id],
      }),
    ).toMatchObject({ runApiKeyIds: [key.id] });
    // A list given again is checked again, changing nothing when it is refused.
    expect(await issueOf(api().update(key.ctx, id, { runApiKeyIds: [reader.id] }))).toMatchObject({
      path: 'runApiKeyIds.0',
    });
    expect((await api().get(key.ctx, id)).runApiKeyIds).toEqual([key.id]);
    expect(await api().update(key.ctx, id, { runApiKeyIds: null })).toMatchObject({
      runApiKeyIds: null,
    });
  });

  it('choose the API keys whose sent messages’ statuses an endpoint receives, kept by changes that leave them out and cleared with the event (ADR-320)', async () => {
    const c = await fx.company();
    // The key adding the endpoint sends messages too; another key only replies; one cannot send.
    const key = await apiKey(c, ['webhooks.manage', 'messages.send'], 'Shop');
    const desk = await apiKey(c, ['messages.reply'], 'Helpdesk');
    const runner = await apiKey(c, ['automations.start'], 'Runner');
    const elsewhere = await apiKey(await fx.company(), ['messages.send'], 'Elsewhere');
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Keys need message.status, at least one, each an id of the company's keys that can send
    // messages (named by place).
    const refusals = [
      [['message.received'], [key.id], 'messageApiKeyIds'],
      [['message.status'], [], 'messageApiKeyIds'],
      [['message.status'], [key.id, key.keyPrefix], 'messageApiKeyIds.1'],
      [['message.status'], [key.id, runner.id], 'messageApiKeyIds.1'],
      [['message.status'], [elsewhere.id], 'messageApiKeyIds.0'],
    ] as const;
    for (const [index, [events, messageApiKeyIds, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, messageApiKeyIds },
            idem(`message-keys-bad-${index}`, JSON.stringify(messageApiKeyIds)),
          ),
        ),
        JSON.stringify(messageApiKeyIds),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'message-keys-1', {
      url: receiverUrl(),
      events: ['message.status'],
      messageApiKeyIds: [key.id, desk.id, key.id.toUpperCase()],
    });
    const id = created.body.data.id;
    expect(created.body.data.messageApiKeyIds).toEqual([key.id, desk.id]);
    expect((await api().get(key.ctx, id)).messageApiKeyIds).toEqual([key.id, desk.id]);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ messageApiKeyIds: [key.id, desk.id] });
    // Settings names them, with whether they still work.
    const owner = await fx.ctx(c, c.owner);
    await keys.revoke(owner, { keyId: desk.id });
    expect((await settings().list(owner)).find((e) => e.id === id)?.messageApiKeys).toEqual([
      { id: key.id, name: 'Shop', keyPrefix: key.keyPrefix, state: 'active' },
      { id: desk.id, name: 'Helpdesk', keyPrefix: desk.keyPrefix, state: 'revoked' },
    ]);

    expect(await api().update(key.ctx, id, { description: 'Statuses' })).toMatchObject({
      messageApiKeyIds: [key.id, desk.id],
    });
    // A revoked key stays allowed: the messages it sent still change status.
    expect(await api().update(key.ctx, id, { messageApiKeyIds: [desk.id] })).toMatchObject({
      messageApiKeyIds: [desk.id],
    });
    const updates = await fx.query<{ metadata: { messageApiKeyIds?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.messageApiKeyIds)).toEqual([[key.id, desk.id], [desk.id]]);
    expect(await api().update(key.ctx, id, { events: ['message.received'] })).toMatchObject({
      events: ['message.received'],
      messageApiKeyIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { messageApiKeyIds: [key.id] }))).toMatchObject({
      path: 'messageApiKeyIds',
    });
    expect(
      await api().update(key.ctx, id, { events: ['message.status'], messageApiKeyIds: [key.id] }),
    ).toMatchObject({ messageApiKeyIds: [key.id] });
    // A list given again is checked again, changing nothing when it is refused.
    expect(
      await issueOf(api().update(key.ctx, id, { messageApiKeyIds: [runner.id] })),
    ).toMatchObject({ path: 'messageApiKeyIds.0' });
    expect((await api().get(key.ctx, id)).messageApiKeyIds).toEqual([key.id]);
    expect(await api().update(key.ctx, id, { messageApiKeyIds: null })).toMatchObject({
      messageApiKeyIds: null,
    });
  });

  it('choose the API keys whose deal, task and note changes an endpoint leaves out, kept by changes that leave them out and cleared with the events (ADR-321)', async () => {
    const c = await fx.company();
    // The key adding the endpoint changes deals too; another key changes tasks; one only reads.
    const key = await apiKey(c, ['webhooks.manage', 'deals.write'], 'Shop');
    const tasks = await apiKey(c, ['tasks.write'], 'Tasks');
    const reader = await apiKey(c, ['deals.read'], 'Reader');
    const elsewhere = await apiKey(await fx.company(), ['deals.write'], 'Elsewhere');
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Keys need a deal, task or note event, at least one, each an id of the company's keys that can
    // change them (named by place).
    const refusals = [
      [['contact.updated'], [key.id], 'crmExcludedApiKeyIds'],
      [['deal.updated'], [], 'crmExcludedApiKeyIds'],
      [['deal.updated'], [key.id, key.keyPrefix], 'crmExcludedApiKeyIds.1'],
      [['task.created'], [key.id, reader.id], 'crmExcludedApiKeyIds.1'],
      [['note.created'], [elsewhere.id], 'crmExcludedApiKeyIds.0'],
    ] as const;
    for (const [index, [events, crmExcludedApiKeyIds, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, crmExcludedApiKeyIds },
            idem(`crm-keys-bad-${index}`, JSON.stringify(crmExcludedApiKeyIds)),
          ),
        ),
        JSON.stringify(crmExcludedApiKeyIds),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    // The key leaves its own changes out, as the endpoint's apiKeyId names it.
    const created = await addThroughApi(key.ctx, 'crm-keys-1', {
      url: receiverUrl(),
      events: ['deal.created', 'deal.updated'],
      crmExcludedApiKeyIds: [key.id, tasks.id, key.id.toUpperCase()],
    });
    const id = created.body.data.id;
    expect(created.body.data.apiKeyId).toBe(key.id);
    expect(created.body.data.crmExcludedApiKeyIds).toEqual([key.id, tasks.id]);
    expect((await api().get(key.ctx, id)).crmExcludedApiKeyIds).toEqual([key.id, tasks.id]);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ crmExcludedApiKeyIds: [key.id, tasks.id] });
    // Settings names them, with whether they still work.
    const owner = await fx.ctx(c, c.owner);
    await keys.revoke(owner, { keyId: tasks.id });
    expect((await settings().list(owner)).find((e) => e.id === id)?.crmExcludedApiKeys).toEqual([
      { id: key.id, name: 'Shop', keyPrefix: key.keyPrefix, state: 'active' },
      { id: tasks.id, name: 'Tasks', keyPrefix: tasks.keyPrefix, state: 'revoked' },
    ]);

    expect(await api().update(key.ctx, id, { description: 'CRM sync' })).toMatchObject({
      crmExcludedApiKeyIds: [key.id, tasks.id],
    });
    expect(await api().update(key.ctx, id, { crmExcludedApiKeyIds: [key.id] })).toMatchObject({
      crmExcludedApiKeyIds: [key.id],
    });
    const updates = await fx.query<{ metadata: { crmExcludedApiKeyIds?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.crmExcludedApiKeyIds)).toEqual([
      [key.id, tasks.id],
      [key.id],
    ]);
    expect(await api().update(key.ctx, id, { events: ['contact.updated'] })).toMatchObject({
      events: ['contact.updated'],
      crmExcludedApiKeyIds: null,
    });
    expect(
      await issueOf(api().update(key.ctx, id, { crmExcludedApiKeyIds: [key.id] })),
    ).toMatchObject({ path: 'crmExcludedApiKeyIds' });
    expect(
      await api().update(key.ctx, id, { events: ['task.created'], crmExcludedApiKeyIds: [key.id] }),
    ).toMatchObject({ crmExcludedApiKeyIds: [key.id] });
    // A list given again is checked again, changing nothing when it is refused.
    expect(
      await issueOf(api().update(key.ctx, id, { crmExcludedApiKeyIds: [reader.id] })),
    ).toMatchObject({ path: 'crmExcludedApiKeyIds.0' });
    expect((await api().get(key.ctx, id)).crmExcludedApiKeyIds).toEqual([key.id]);
    expect(await api().update(key.ctx, id, { crmExcludedApiKeyIds: null })).toMatchObject({
      crmExcludedApiKeyIds: null,
    });
  });

  it('choose the API keys whose order changes an endpoint leaves out, kept by changes that leave them out and cleared with the event (ADR-323)', async () => {
    const c = await fx.company();
    // The key adding the endpoint moves orders too; another asks for payments; one only reads.
    const key = await apiKey(c, ['webhooks.manage', 'orders.write'], 'Shop');
    const payments = await apiKey(c, ['orders.request_payment'], 'Payments');
    const reader = await apiKey(c, ['orders.read'], 'Reader');
    const elsewhere = await apiKey(await fx.company(), ['orders.write'], 'Elsewhere');
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Keys need order.status_changed, at least one, each an id of the company's keys that can
    // change orders (named by place).
    const refusals = [
      [['order.received'], [key.id], 'orderExcludedApiKeyIds'],
      [['order.status_changed'], [], 'orderExcludedApiKeyIds'],
      [['order.status_changed'], [key.id, key.keyPrefix], 'orderExcludedApiKeyIds.1'],
      [['order.status_changed'], [key.id, reader.id], 'orderExcludedApiKeyIds.1'],
      [['order.status_changed'], [elsewhere.id], 'orderExcludedApiKeyIds.0'],
    ] as const;
    for (const [index, [events, orderExcludedApiKeyIds, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, orderExcludedApiKeyIds },
            idem(`order-keys-bad-${index}`, JSON.stringify(orderExcludedApiKeyIds)),
          ),
        ),
        JSON.stringify(orderExcludedApiKeyIds),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    // The key leaves its own changes out, as the endpoint's apiKeyId names it.
    const created = await addThroughApi(key.ctx, 'order-keys-1', {
      url: receiverUrl(),
      events: ['order.status_changed', 'order.received'],
      orderExcludedApiKeyIds: [key.id, payments.id, key.id.toUpperCase()],
    });
    const id = created.body.data.id;
    expect(created.body.data.apiKeyId).toBe(key.id);
    expect(created.body.data.orderExcludedApiKeyIds).toEqual([key.id, payments.id]);
    expect((await api().get(key.ctx, id)).orderExcludedApiKeyIds).toEqual([key.id, payments.id]);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ orderExcludedApiKeyIds: [key.id, payments.id] });
    // Settings names them, with whether they still work.
    const owner = await fx.ctx(c, c.owner);
    await keys.revoke(owner, { keyId: payments.id });
    expect((await settings().list(owner)).find((e) => e.id === id)?.orderExcludedApiKeys).toEqual([
      { id: key.id, name: 'Shop', keyPrefix: key.keyPrefix, state: 'active' },
      { id: payments.id, name: 'Payments', keyPrefix: payments.keyPrefix, state: 'revoked' },
    ]);

    expect(await api().update(key.ctx, id, { description: 'Order sync' })).toMatchObject({
      orderExcludedApiKeyIds: [key.id, payments.id],
    });
    expect(await api().update(key.ctx, id, { orderExcludedApiKeyIds: [key.id] })).toMatchObject({
      orderExcludedApiKeyIds: [key.id],
    });
    const updates = await fx.query<{ metadata: { orderExcludedApiKeyIds?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.orderExcludedApiKeyIds)).toEqual([
      [key.id, payments.id],
      [key.id],
    ]);
    expect(await api().update(key.ctx, id, { events: ['order.received'] })).toMatchObject({
      events: ['order.received'],
      orderExcludedApiKeyIds: null,
    });
    expect(
      await issueOf(api().update(key.ctx, id, { orderExcludedApiKeyIds: [key.id] })),
    ).toMatchObject({ path: 'orderExcludedApiKeyIds' });
    expect(
      await api().update(key.ctx, id, {
        events: ['order.status_changed'],
        orderExcludedApiKeyIds: [key.id],
      }),
    ).toMatchObject({ orderExcludedApiKeyIds: [key.id] });
    // A list given again is checked again, changing nothing when it is refused.
    expect(
      await issueOf(api().update(key.ctx, id, { orderExcludedApiKeyIds: [reader.id] })),
    ).toMatchObject({ path: 'orderExcludedApiKeyIds.0' });
    expect((await api().get(key.ctx, id)).orderExcludedApiKeyIds).toEqual([key.id]);
    expect(await api().update(key.ctx, id, { orderExcludedApiKeyIds: null })).toMatchObject({
      orderExcludedApiKeyIds: null,
    });
  });

  it('choose the API keys whose Payment Links’ changes an endpoint receives, kept by changes that leave them out and cleared with the event (ADR-324)', async () => {
    const c = await fx.company();
    // The key adding the endpoint asks for payments too; another one does; one only moves orders.
    const key = await apiKey(c, ['webhooks.manage', 'orders.request_payment'], 'Shop');
    const billing = await apiKey(c, ['orders.request_payment'], 'Billing');
    const mover = await apiKey(c, ['orders.write'], 'Mover');
    const elsewhere = await apiKey(await fx.company(), ['orders.request_payment'], 'Elsewhere');
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // Keys need payment_link.status_changed, at least one, each an id of the company's keys that
    // ask customers to pay (named by place).
    const refusals = [
      [['order.status_changed'], [key.id], 'paymentLinkApiKeyIds'],
      [['payment_link.status_changed'], [], 'paymentLinkApiKeyIds'],
      [['payment_link.status_changed'], [key.id, key.keyPrefix], 'paymentLinkApiKeyIds.1'],
      [['payment_link.status_changed'], [key.id, mover.id], 'paymentLinkApiKeyIds.1'],
      [['payment_link.status_changed'], [elsewhere.id], 'paymentLinkApiKeyIds.0'],
    ] as const;
    for (const [index, [events, paymentLinkApiKeyIds, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, paymentLinkApiKeyIds },
            idem(`link-keys-bad-${index}`, JSON.stringify(paymentLinkApiKeyIds)),
          ),
        ),
        JSON.stringify(paymentLinkApiKeyIds),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    // The key takes its own links' changes, as the endpoint's apiKeyId names it.
    const created = await addThroughApi(key.ctx, 'link-keys-1', {
      url: receiverUrl(),
      events: ['payment_link.status_changed', 'order.status_changed'],
      paymentLinkApiKeyIds: [key.id, billing.id, key.id.toUpperCase()],
    });
    const id = created.body.data.id;
    expect(created.body.data.apiKeyId).toBe(key.id);
    expect(created.body.data.paymentLinkApiKeyIds).toEqual([key.id, billing.id]);
    expect((await api().get(key.ctx, id)).paymentLinkApiKeyIds).toEqual([key.id, billing.id]);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ paymentLinkApiKeyIds: [key.id, billing.id] });
    // Settings names them, with whether they still work.
    const owner = await fx.ctx(c, c.owner);
    await keys.revoke(owner, { keyId: billing.id });
    expect((await settings().list(owner)).find((e) => e.id === id)?.paymentLinkApiKeys).toEqual([
      { id: key.id, name: 'Shop', keyPrefix: key.keyPrefix, state: 'active' },
      { id: billing.id, name: 'Billing', keyPrefix: billing.keyPrefix, state: 'revoked' },
    ]);

    expect(await api().update(key.ctx, id, { description: 'Payments' })).toMatchObject({
      paymentLinkApiKeyIds: [key.id, billing.id],
    });
    expect(await api().update(key.ctx, id, { paymentLinkApiKeyIds: [key.id] })).toMatchObject({
      paymentLinkApiKeyIds: [key.id],
    });
    const updates = await fx.query<{ metadata: { paymentLinkApiKeyIds?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.paymentLinkApiKeyIds)).toEqual([
      [key.id, billing.id],
      [key.id],
    ]);
    expect(await api().update(key.ctx, id, { events: ['order.status_changed'] })).toMatchObject({
      events: ['order.status_changed'],
      paymentLinkApiKeyIds: null,
    });
    expect(
      await issueOf(api().update(key.ctx, id, { paymentLinkApiKeyIds: [key.id] })),
    ).toMatchObject({ path: 'paymentLinkApiKeyIds' });
    expect(
      await api().update(key.ctx, id, {
        events: ['payment_link.status_changed'],
        paymentLinkApiKeyIds: [key.id],
      }),
    ).toMatchObject({ paymentLinkApiKeyIds: [key.id] });
    // A list given again is checked again, changing nothing when it is refused.
    expect(
      await issueOf(api().update(key.ctx, id, { paymentLinkApiKeyIds: [mover.id] })),
    ).toMatchObject({ path: 'paymentLinkApiKeyIds.0' });
    expect((await api().get(key.ctx, id)).paymentLinkApiKeyIds).toEqual([key.id]);
    expect(await api().update(key.ctx, id, { paymentLinkApiKeyIds: null })).toMatchObject({
      paymentLinkApiKeyIds: null,
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

  it('choose who made the changes whose deal, task and note events an endpoint receives, kept by changes that leave them out and cleared with the events (ADR-306)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // The makers need a deal, task or note event, at least one, and each from the list (by place).
    const refusals = [
      [['contact.updated'], ['api'], 'crmChangeMakers'],
      [['deal.created'], [], 'crmChangeMakers'],
      [['task.created'], ['api', 'contact'], 'crmChangeMakers.1'],
      [['note.created'], ['agent'], 'crmChangeMakers.0'],
    ] as const;
    for (const [index, [events, crmChangeMakers, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, crmChangeMakers },
            idem(`crm-makers-bad-${index}`, JSON.stringify(crmChangeMakers)),
          ),
        ),
        JSON.stringify(crmChangeMakers),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'crm-makers-1', {
      url: receiverUrl(),
      events: ['deal.updated', 'note.created', 'message.received'],
      crmChangeMakers: ['api', 'member'],
    });
    const id = created.body.data.id;
    expect(created.body.data.crmChangeMakers).toEqual(['member', 'api']);
    expect((await api().get(key.ctx, id)).crmChangeMakers).toEqual(['member', 'api']);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ crmChangeMakers: ['member', 'api'] });

    expect(await api().update(key.ctx, id, { description: 'Not my own changes' })).toMatchObject({
      crmChangeMakers: ['member', 'api'],
    });
    expect(
      await api().update(key.ctx, id, { crmChangeMakers: ['member', 'automation'] }),
    ).toMatchObject({ crmChangeMakers: ['member', 'automation'] });
    const updates = await fx.query<{ metadata: { crmChangeMakers?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.crmChangeMakers)).toEqual([
      ['member', 'api'],
      ['member', 'automation'],
    ]);
    // A note event keeps the list; events without a deal, task or note event clear it.
    expect(await api().update(key.ctx, id, { events: ['note.created'] })).toMatchObject({
      crmChangeMakers: ['member', 'automation'],
    });
    expect(await api().update(key.ctx, id, { events: ['message.received'] })).toMatchObject({
      events: ['message.received'],
      crmChangeMakers: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { crmChangeMakers: ['api'] }))).toMatchObject({
      path: 'crmChangeMakers',
    });
    expect(
      await api().update(key.ctx, id, { events: ['task.updated'], crmChangeMakers: ['api'] }),
    ).toMatchObject({ crmChangeMakers: ['api'] });
    expect(await api().update(key.ctx, id, { crmChangeMakers: null })).toMatchObject({
      crmChangeMakers: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { crmChangeMakers: [] }))).toMatchObject({
      path: 'crmChangeMakers',
    });
  });

  it('choose the scores of the satisfaction survey answers an endpoint receives, kept by changes that leave them out and cleared with the event (ADR-307)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // The scores need the event, at least one, and each from the list (by place).
    const refusals = [
      [['conversation.status_changed'], [1], 'surveyScores'],
      [['satisfaction_survey.answered'], [], 'surveyScores'],
      [['satisfaction_survey.answered'], [1, 4], 'surveyScores.1'],
      [['satisfaction_survey.answered'], ['3'], 'surveyScores.0'],
    ] as const;
    for (const [index, [events, surveyScores, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, surveyScores },
            idem(`survey-scores-bad-${index}`, JSON.stringify(surveyScores)),
          ),
        ),
        JSON.stringify(surveyScores),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'survey-scores-1', {
      url: receiverUrl(),
      events: ['satisfaction_survey.answered', 'message.received'],
      surveyScores: [1, 2],
    });
    const id = created.body.data.id;
    expect(created.body.data.surveyScores).toEqual([2, 1]);
    expect((await api().get(key.ctx, id)).surveyScores).toEqual([2, 1]);
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_created'`,
      [c.tenant.id, id],
    );
    expect(audit?.metadata).toMatchObject({ surveyScores: [2, 1] });

    expect(await api().update(key.ctx, id, { description: 'Unhappy customers' })).toMatchObject({
      surveyScores: [2, 1],
    });
    expect(await api().update(key.ctx, id, { surveyScores: [1] })).toMatchObject({
      surveyScores: [1],
    });
    const updates = await fx.query<{ metadata: { surveyScores?: unknown } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 AND action = 'webhook.endpoint_updated'
        ORDER BY occurred_at`,
      [c.tenant.id, id],
    );
    expect(updates.map((u) => u.metadata.surveyScores)).toEqual([[2, 1], [1]]);
    expect(await api().update(key.ctx, id, { events: ['message.received'] })).toMatchObject({
      events: ['message.received'],
      surveyScores: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { surveyScores: [1] }))).toMatchObject({
      path: 'surveyScores',
    });
    expect(
      await api().update(key.ctx, id, {
        events: ['satisfaction_survey.answered'],
        surveyScores: [3],
      }),
    ).toMatchObject({ surveyScores: [3] });
    expect(await api().update(key.ctx, id, { surveyScores: null })).toMatchObject({
      surveyScores: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { surveyScores: [] }))).toMatchObject({
      path: 'surveyScores',
    });
  });

  it('choose the members credited with the satisfaction survey answers an endpoint receives and the teams of their conversations, kept by changes that leave them out, a member who stopped and a deleted team included, and cleared with the event (ADR-311)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const owner = await fx.ctx(c, c.owner);
    const agent = (await fx.ctx(c, c.agent)).membership.id;
    const ownerId = owner.membership.id;
    const marketer = (await fx.ctx(c, c.marketer)).membership.id;
    const other = await fx.company();
    const elsewhere = (await fx.ctx(other, other.agent)).membership.id;
    const teamOf = async (company: Company, name: string) => {
      const teamId = uuidv7();
      await fx.query('INSERT INTO app.teams (id, tenant_id, name) VALUES ($1, $2, $3)', [
        teamId,
        company.tenant.id,
        name,
      ]);
      return teamId;
    };
    const support = await teamOf(c, 'Support');
    const sales = await teamOf(c, 'Sales');
    const otherTeam = await teamOf(other, 'Support');
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // The lists need the event, at least one id, members who take conversations as GET /members
    // lists them and the company's teams (named by place).
    const refusals = [
      [['conversation.status_changed'], { surveyAssigneeIds: [agent] }, 'surveyAssigneeIds'],
      [['conversation.status_changed'], { surveyTeamIds: [support] }, 'surveyTeamIds'],
      [['satisfaction_survey.answered'], { surveyAssigneeIds: [] }, 'surveyAssigneeIds'],
      [
        ['satisfaction_survey.answered'],
        { surveyTeamIds: [support, 'support'] },
        'surveyTeamIds.1',
      ],
      [
        ['satisfaction_survey.answered'],
        { surveyAssigneeIds: [agent, marketer] },
        'surveyAssigneeIds.1',
      ],
      [['satisfaction_survey.answered'], { surveyAssigneeIds: [elsewhere] }, 'surveyAssigneeIds.0'],
      [
        ['satisfaction_survey.answered'],
        { surveyTeamIds: [support, otherTeam] },
        'surveyTeamIds.1',
      ],
    ] as const;
    for (const [index, [events, lists, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, ...lists },
            idem(`survey-lists-bad-${index}`, JSON.stringify(lists)),
          ),
        ),
        JSON.stringify(lists),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'survey-lists-1', {
      url: receiverUrl(),
      events: ['satisfaction_survey.answered', 'message.received'],
      surveyAssigneeIds: [agent, ownerId.toUpperCase(), agent],
      surveyTeamIds: [sales, support],
    });
    const id = created.body.data.id;
    expect(created.body.data).toMatchObject({
      surveyAssigneeIds: [agent, ownerId],
      surveyTeamIds: [sales, support],
      assigneeIds: null,
      teamIds: null,
    });
    expect(await api().get(key.ctx, id)).toMatchObject({
      surveyAssigneeIds: [agent, ownerId],
      surveyTeamIds: [sales, support],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { surveyAssigneeIds?: unknown; surveyTeamIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND subject_id = $2 AND action = $3 ORDER BY occurred_at, id`,
          [c.tenant.id, id, action],
        )
      ).map((a) => [a.metadata.surveyAssigneeIds, a.metadata.surveyTeamIds]);
    expect(await audits('webhook.endpoint_created')).toEqual([
      [
        [agent, ownerId],
        [sales, support],
      ],
    ]);
    // A member who stops taking conversations and a deleted team stay, and settings says so.
    await fx.query(`UPDATE app.memberships SET status = 'suspended' WHERE id = $1`, [agent]);
    await fx.query('DELETE FROM app.teams WHERE id = $1', [sales]);
    const shown = (await settings().list(owner)).find((e) => e.id === id);
    expect([shown?.surveyAssignees, shown?.surveyTeams]).toEqual([
      [
        { id: agent, name: 'Agent', assignable: false },
        { id: ownerId, name: 'Owner', assignable: true },
      ],
      [
        { id: sales, name: null },
        { id: support, name: 'Support' },
      ],
    ]);
    expect(await api().update(key.ctx, id, { description: 'Support leads' })).toMatchObject({
      surveyAssigneeIds: [agent, ownerId],
      surveyTeamIds: [sales, support],
    });
    expect(
      await api().update(key.ctx, id, {
        surveyAssigneeIds: [ownerId, agent],
        surveyTeamIds: [support, sales],
      }),
    ).toMatchObject({ surveyAssigneeIds: [ownerId, agent], surveyTeamIds: [support, sales] });
    expect(
      await api().update(key.ctx, id, { surveyAssigneeIds: [ownerId], surveyTeamIds: [support] }),
    ).toMatchObject({ surveyAssigneeIds: [ownerId], surveyTeamIds: [support] });
    // Once off the lists, they are refused like any other.
    expect(
      await issueOf(api().update(key.ctx, id, { surveyAssigneeIds: [ownerId, agent] })),
    ).toMatchObject({ path: 'surveyAssigneeIds.1' });
    expect(
      await issueOf(api().update(key.ctx, id, { surveyTeamIds: [support, sales] })),
    ).toMatchObject({ path: 'surveyTeamIds.1' });
    expect(await audits('webhook.endpoint_updated')).toEqual([
      [
        [agent, ownerId],
        [sales, support],
      ],
      [
        [ownerId, agent],
        [support, sales],
      ],
      [[ownerId], [support]],
    ]);
    // Conversations' events alone clear the lists, and then refuse them.
    expect(await api().update(key.ctx, id, { events: ['message.received'] })).toMatchObject({
      events: ['message.received'],
      surveyAssigneeIds: null,
      surveyTeamIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { surveyTeamIds: [support] }))).toMatchObject({
      path: 'surveyTeamIds',
    });
    expect(
      await api().update(key.ctx, id, {
        events: ['satisfaction_survey.answered'],
        surveyTeamIds: [support],
      }),
    ).toMatchObject({ surveyAssigneeIds: null, surveyTeamIds: [support] });
    expect(await api().update(key.ctx, id, { surveyTeamIds: null })).toMatchObject({
      surveyTeamIds: null,
    });
  });

  it('choose the contact and conversation tags of the satisfaction survey answers an endpoint receives, as contacts and conversations carry them, kept by changes that leave them out and cleared with the event (ADR-312)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // The lists need the event, at least one tag, and tags as they are written (named by place).
    const refusals = [
      [['conversation.status_changed'], { surveyContactTags: ['vip'] }, 'surveyContactTags'],
      [
        ['conversation.status_changed'],
        { surveyConversationTags: ['refund'] },
        'surveyConversationTags',
      ],
      [['satisfaction_survey.answered'], { surveyContactTags: [] }, 'surveyContactTags'],
      [
        ['satisfaction_survey.answered'],
        { surveyConversationTags: ['refund', 'a,b'] },
        'surveyConversationTags.1',
      ],
      [['satisfaction_survey.answered'], { surveyContactTags: ['vip', 42] }, 'surveyContactTags.1'],
    ] as const;
    for (const [index, [events, lists, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, ...lists },
            idem(`survey-tags-bad-${index}`, JSON.stringify(lists)),
          ),
        ),
        JSON.stringify(lists),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'survey-tags-1', {
      url: receiverUrl(),
      events: ['satisfaction_survey.answered', 'message.received'],
      surveyContactTags: ['VIP', 'Gold   Member', 'vip'],
      surveyConversationTags: ['Refund'],
    });
    const id = created.body.data.id;
    expect(created.body.data).toMatchObject({
      surveyContactTags: ['vip', 'gold member'],
      surveyConversationTags: ['refund'],
      contactTags: null,
      conversationTags: null,
    });
    expect(await api().get(key.ctx, id)).toMatchObject({
      surveyContactTags: ['vip', 'gold member'],
      surveyConversationTags: ['refund'],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{
          metadata: { surveyContactTags?: unknown; surveyConversationTags?: unknown };
        }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND subject_id = $2 AND action = $3 ORDER BY occurred_at, id`,
          [c.tenant.id, id, action],
        )
      ).map((a) => [a.metadata.surveyContactTags, a.metadata.surveyConversationTags]);
    expect(await audits('webhook.endpoint_created')).toEqual([
      [['vip', 'gold member'], ['refund']],
    ]);
    expect(await api().update(key.ctx, id, { description: 'VIP desk' })).toMatchObject({
      surveyContactTags: ['vip', 'gold member'],
      surveyConversationTags: ['refund'],
    });
    expect(
      await api().update(key.ctx, id, { surveyConversationTags: ['Delivery Delay', 'refund'] }),
    ).toMatchObject({
      surveyContactTags: ['vip', 'gold member'],
      surveyConversationTags: ['delivery delay', 'refund'],
    });
    expect(await audits('webhook.endpoint_updated')).toEqual([
      [['vip', 'gold member'], ['refund']],
      [
        ['vip', 'gold member'],
        ['delivery delay', 'refund'],
      ],
    ]);
    // Conversations' events alone clear the lists, and then refuse them.
    expect(await api().update(key.ctx, id, { events: ['message.received'] })).toMatchObject({
      events: ['message.received'],
      surveyContactTags: null,
      surveyConversationTags: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { surveyContactTags: ['vip'] }))).toMatchObject({
      path: 'surveyContactTags',
    });
    expect(
      await api().update(key.ctx, id, {
        events: ['satisfaction_survey.answered'],
        surveyConversationTags: ['refund'],
      }),
    ).toMatchObject({ surveyContactTags: null, surveyConversationTags: ['refund'] });
    expect(await api().update(key.ctx, id, { surveyConversationTags: null })).toMatchObject({
      surveyConversationTags: null,
    });
  });

  it('choose the tags of the added and changed contacts an endpoint receives, as contacts carry them, kept by changes that leave them out and cleared with both events (ADR-316)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // The list needs one of the events, at least one tag, and tags as they are written.
    const refusals = [
      [['contact.erased', 'contact.merged'], { contactEventTags: ['vip'] }, 'contactEventTags'],
      [['contact.updated'], { contactEventTags: [] }, 'contactEventTags'],
      [['contact.updated'], { contactEventTags: ['vip', 'a,b'] }, 'contactEventTags.1'],
      [['contact.created'], { contactEventTags: ['vip', 42] }, 'contactEventTags.1'],
    ] as const;
    for (const [index, [events, lists, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, ...lists },
            idem(`contact-event-tags-bad-${index}`, JSON.stringify(lists)),
          ),
        ),
        JSON.stringify(lists),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'contact-event-tags-1', {
      url: receiverUrl(),
      events: ['contact.created', 'contact.updated'],
      contactEventTags: ['VIP', 'Gold   Member', 'vip'],
    });
    const id = created.body.data.id;
    expect(created.body.data).toMatchObject({
      contactEventTags: ['vip', 'gold member'],
      contactTags: null,
      surveyContactTags: null,
    });
    expect(await api().get(key.ctx, id)).toMatchObject({
      contactEventTags: ['vip', 'gold member'],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { contactEventTags?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND subject_id = $2 AND action = $3 ORDER BY occurred_at, id`,
          [c.tenant.id, id, action],
        )
      ).map((a) => a.metadata.contactEventTags);
    expect(await audits('webhook.endpoint_created')).toEqual([['vip', 'gold member']]);
    expect(await api().update(key.ctx, id, { description: 'VIP sync' })).toMatchObject({
      contactEventTags: ['vip', 'gold member'],
    });
    // A list alone is a change.
    expect(await api().update(key.ctx, id, { contactEventTags: ['Wholesale'] })).toMatchObject({
      contactEventTags: ['wholesale'],
    });
    // Either event keeps it.
    expect(await api().update(key.ctx, id, { events: ['contact.updated'] })).toMatchObject({
      events: ['contact.updated'],
      contactEventTags: ['wholesale'],
    });
    expect(await audits('webhook.endpoint_updated')).toEqual([
      ['vip', 'gold member'],
      ['wholesale'],
      ['wholesale'],
    ]);
    // Neither event clears it, and then refuses it.
    expect(await api().update(key.ctx, id, { events: ['contact.erased'] })).toMatchObject({
      events: ['contact.erased'],
      contactEventTags: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { contactEventTags: ['vip'] }))).toMatchObject({
      path: 'contactEventTags',
    });
    expect(
      await api().update(key.ctx, id, { events: ['contact.created'], contactEventTags: ['vip'] }),
    ).toMatchObject({ contactEventTags: ['vip'] });
    expect(await api().update(key.ctx, id, { contactEventTags: null })).toMatchObject({
      contactEventTags: null,
    });
  });

  it('choose words of text fields and ranges of number and date fields, read by the fields’ types, through the API (ADR-335)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const fieldOf = (fieldKey: string, label: string, type: string) =>
      fx.query(
        `INSERT INTO app.contact_fields (id, tenant_id, key, label, type) VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), c.tenant.id, fieldKey, label, type],
      );
    await fieldOf('city', 'City', 'text');
    await fieldOf('score', 'Score', 'number');
    await fieldOf('renewal', 'Renewal', 'date');
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    const refusals = [
      [[{ key: 'score', contains: '5' }], 'contactEventFieldValues.0.contains'],
      [[{ key: 'city', atMost: 'z' }], 'contactEventFieldValues.0'],
      [[{ key: 'score', atLeast: 2, atMost: 1 }], 'contactEventFieldValues.0'],
      [[{ key: 'renewal', atLeast: 20261001 }], 'contactEventFieldValues.0.atLeast'],
      [[{ key: 'score', value: 1, atMost: 2 }], 'contactEventFieldValues.0'],
      [[{ key: 'score' }], 'contactEventFieldValues.0'],
    ] as const;
    for (const [index, [conditions, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            {
              url: receiverUrl(),
              events: ['contact.updated'],
              contactEventFieldValues: conditions,
            },
            idem(`contact-event-field-ranges-bad-${index}`, JSON.stringify(conditions)),
          ),
        ),
        JSON.stringify(conditions),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'contact-event-field-ranges-1', {
      url: receiverUrl(),
      events: ['contact.updated'],
      contactEventFieldValues: [
        { key: 'city', contains: ' Chen ' },
        { key: 'score', atLeast: 10 },
        { key: 'renewal', atLeast: '2026-10-01', atMost: '2026-10-31' },
      ],
    });
    const stored = [
      { key: 'city', contains: 'Chen' },
      { key: 'score', atLeast: 10 },
      { key: 'renewal', atLeast: '2026-10-01', atMost: '2026-10-31' },
    ];
    expect(created.body.data).toMatchObject({ contactEventFieldValues: stored });
    expect(await api().get(key.ctx, created.body.data.id)).toMatchObject({
      contactEventFieldValues: stored,
    });
    expect(
      await api().update(key.ctx, created.body.data.id, {
        contactEventFieldValues: [{ key: 'score', atMost: 0 }],
      }),
    ).toMatchObject({ contactEventFieldValues: [{ key: 'score', atMost: 0 }] });
  });

  it('add and change an endpoint whose lists would not fit its audit entry, the entry naming the largest by count (ADR-336)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    // Five lists of 50 tags of 112 bytes each, as in the Settings test: about 29,000 bytes.
    const tags = (list: number) =>
      Array.from({ length: 50 }, (_, i) => `${'க'.repeat(36)}${list}${String(i).padStart(3, '0')}`);
    const lists = {
      contactTags: tags(1),
      conversationTags: tags(2),
      contactEventTags: tags(3),
      surveyContactTags: tags(4),
      surveyConversationTags: tags(5),
    };
    const created = await addThroughApi(key.ctx, 'audit-lists-1', {
      url: receiverUrl(),
      events: ['message.received', 'contact.updated', 'satisfaction_survey.answered'],
      ...lists,
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject(lists);
    expect(
      await api().update(key.ctx, created.body.data.id, { description: 'Tamil tags' }),
    ).toMatchObject({ description: 'Tamil tags', ...lists });
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
    ]);
    for (const audit of audits) {
      expect(audit.bytes).toBeLessThanOrEqual(webhookAuditMetadataBytes(audit.metadata));
      expect(audit.bytes).toBeLessThanOrEqual(8192);
      expect(audit.metadata).toMatchObject({
        source: 'api',
        listCounts: {
          contactEventTags: 50,
          contactTags: 50,
          conversationTags: 50,
          surveyContactTags: 50,
        },
        surveyConversationTags: lists.surveyConversationTags,
      });
      expect(audit.metadata).not.toHaveProperty('contactTags');
    }
    // Without its source the entry is within the count the services keep it to.
    const [first] = audits;
    const { source: _source, ...withoutSource } = first?.metadata ?? {};
    expect(webhookAuditMetadataBytes(withoutSource)).toBeLessThanOrEqual(
      WEBHOOK_LIMITS.auditMetadataBytes,
    );
  });

  it('choose the field values of the added and changed contacts an endpoint receives, read by the fields’ types, kept by changes that leave them out and cleared with both events (ADR-332)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const fieldOf = (company: Company, fieldKey: string, label: string, type: string) =>
      fx.query(
        `INSERT INTO app.contact_fields (id, tenant_id, key, label, type) VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), company.tenant.id, fieldKey, label, type],
      );
    await fieldOf(c, 'tier', 'Tier', 'text');
    await fieldOf(c, 'score', 'Score', 'number');
    await fieldOf(await fx.company(), 'zone', 'Zone', 'text');
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // The list needs one of the events, at least one value, the company's fields and their types.
    const gold = [{ key: 'tier', value: 'gold' }];
    const refusals = [
      [
        ['contact.erased', 'contact.merged'],
        { contactEventFieldValues: gold },
        'contactEventFieldValues',
      ],
      [['contact.updated'], { contactEventFieldValues: [] }, 'contactEventFieldValues'],
      [
        ['contact.updated'],
        { contactEventFieldValues: [...gold, { key: 'zone', value: 'north' }] },
        'contactEventFieldValues.1.key',
      ],
      [
        ['contact.created'],
        { contactEventFieldValues: [{ key: 'score', value: 'five' }] },
        'contactEventFieldValues.0.value',
      ],
      [
        ['contact.created'],
        { contactEventFieldValues: [{ key: 'tier', value: null }] },
        'contactEventFieldValues.0.value',
      ],
    ] as const;
    for (const [index, [events, lists, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, ...lists },
            idem(`contact-event-field-values-bad-${index}`, JSON.stringify(lists)),
          ),
        ),
        JSON.stringify(lists),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'contact-event-field-values-1', {
      url: receiverUrl(),
      events: ['contact.created', 'contact.updated'],
      contactEventFieldValues: [
        { key: 'tier', value: 'Gold ' },
        { key: 'tier', value: 'GOLD' },
        { key: 'score', value: 5 },
      ],
    });
    const id = created.body.data.id;
    const stored = [
      { key: 'tier', value: 'Gold' },
      { key: 'score', value: 5 },
    ];
    expect(created.body.data).toMatchObject({
      contactEventFieldValues: stored,
      contactEventTags: null,
    });
    expect(await api().get(key.ctx, id)).toMatchObject({ contactEventFieldValues: stored });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { contactEventFieldValues?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND subject_id = $2 AND action = $3 ORDER BY occurred_at, id`,
          [c.tenant.id, id, action],
        )
      ).map((a) => a.metadata.contactEventFieldValues);
    expect(await audits('webhook.endpoint_created')).toEqual([stored]);
    expect(await api().update(key.ctx, id, { description: 'Gold sync' })).toMatchObject({
      contactEventFieldValues: stored,
    });
    // A list alone is a change.
    expect(
      await api().update(key.ctx, id, { contactEventFieldValues: [{ key: 'score', value: 7 }] }),
    ).toMatchObject({ contactEventFieldValues: [{ key: 'score', value: 7 }] });
    // Either event keeps it.
    expect(await api().update(key.ctx, id, { events: ['contact.updated'] })).toMatchObject({
      events: ['contact.updated'],
      contactEventFieldValues: [{ key: 'score', value: 7 }],
    });
    expect(await audits('webhook.endpoint_updated')).toEqual([
      stored,
      [{ key: 'score', value: 7 }],
      [{ key: 'score', value: 7 }],
    ]);
    // Neither event clears it, and then refuses it.
    expect(await api().update(key.ctx, id, { events: ['contact.erased'] })).toMatchObject({
      events: ['contact.erased'],
      contactEventFieldValues: null,
    });
    expect(
      await issueOf(api().update(key.ctx, id, { contactEventFieldValues: gold })),
    ).toMatchObject({ path: 'contactEventFieldValues' });
    expect(
      await api().update(key.ctx, id, {
        events: ['contact.created'],
        contactEventFieldValues: gold,
      }),
    ).toMatchObject({ contactEventFieldValues: gold });
    expect(await api().update(key.ctx, id, { contactEventFieldValues: null })).toMatchObject({
      contactEventFieldValues: null,
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

  it("choose the stages whose deals' events an endpoint receives, removed ones too, kept by changes that leave them out and cleared with the events (ADR-264)", async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const crm = createCrmService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
    });
    const stagesOf = async (company: Company) => {
      const owner = await fx.ctx(company, company.owner);
      const { id } = await crm.createPipeline(owner, {
        name: 'Sales',
        currency: 'INR',
        stages: ['New', 'Proposal', 'Lost'],
      });
      const [pipeline] = (await crm.listPipelines(owner)).filter((p) => p.id === id);
      return { owner, id, pipeline: pipeline!, stages: pipeline!.stages.map((st) => st.id) };
    };
    const sales = await stagesOf(c);
    const [fresh, proposal, lost] = sales.stages as [string, string, string];
    const elsewhere = (await stagesOf(await fx.company())).stages[0]!;
    // Lost is removed: it stays, archived.
    await crm.updatePipeline(sales.owner, {
      id: sales.id,
      expectedVersion: sales.pipeline.version,
      name: 'Sales',
      stages: [
        { id: fresh, name: 'New' },
        { id: proposal, name: 'Proposal' },
      ],
    });
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    const refusals = [
      [['task.created'], [proposal], 'stageIds'],
      [['deal.created'], [], 'stageIds'],
      [['deal.created'], [proposal, 'Proposal'], 'stageIds.1'],
      [['deal.stage_changed'], [proposal, elsewhere], 'stageIds.1'],
      [['deal.status_changed'], [uuidv7()], 'stageIds.0'],
    ] as const;
    for (const [index, [events, stageIds, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, stageIds },
            idem(`stages-bad-${index}`, JSON.stringify(stageIds)),
          ),
        ),
        JSON.stringify(stageIds),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'stages-1', {
      url: receiverUrl(),
      events: ['deal.stage_changed', 'contact.created'],
      stageIds: [lost, proposal.toUpperCase(), lost],
    });
    const id = created.body.data.id;
    expect(created.body.data.stageIds).toEqual([lost, proposal]);
    expect((await api().get(key.ctx, id)).stageIds).toEqual([lost, proposal]);
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { stageIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND subject_id = $2 AND action = $3 ORDER BY occurred_at, id`,
          [c.tenant.id, id, action],
        )
      ).map((a) => a.metadata.stageIds);
    expect(await audits('webhook.endpoint_created')).toEqual([[lost, proposal]]);
    // Settings names them with their pipeline, the removed one as removed.
    expect((await settings().list(sales.owner)).find((e) => e.id === id)?.stages).toEqual([
      { id: lost, name: 'Lost', pipelineName: 'Sales', removed: true, pipelineArchived: false },
      {
        id: proposal,
        name: 'Proposal',
        pipelineName: 'Sales',
        removed: false,
        pipelineArchived: false,
      },
    ]);
    expect(await api().update(key.ctx, id, { description: 'Proposals' })).toMatchObject({
      stageIds: [lost, proposal],
    });
    expect(await api().update(key.ctx, id, { stageIds: [proposal] })).toMatchObject({
      stageIds: [proposal],
    });
    expect(await audits('webhook.endpoint_updated')).toEqual([[lost, proposal], [proposal]]);
    // Any deal event keeps the list; events without one clear it.
    expect(await api().update(key.ctx, id, { events: ['deal.created'] })).toMatchObject({
      stageIds: [proposal],
    });
    expect(await api().update(key.ctx, id, { events: ['contact.created'] })).toMatchObject({
      events: ['contact.created'],
      stageIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { stageIds: [proposal] }))).toMatchObject({
      path: 'stageIds',
    });
    expect(
      await api().update(key.ctx, id, { events: ['deal.status_changed'], stageIds: [fresh] }),
    ).toMatchObject({ stageIds: [fresh] });
    // A list given again is checked again, changing nothing when it is refused.
    expect(await issueOf(api().update(key.ctx, id, { stageIds: [elsewhere] }))).toMatchObject({
      path: 'stageIds.0',
    });
    expect((await api().get(key.ctx, id)).stageIds).toEqual([fresh]);
    expect(await api().update(key.ctx, id, { stageIds: null })).toMatchObject({ stageIds: null });
    expect(await issueOf(api().update(key.ctx, id, { stageIds: [] }))).toMatchObject({
      path: 'stageIds',
    });
  });

  it("choose the members whose deals' events an endpoint receives, kept by changes that leave them out, a member who left included, and cleared with the events (ADR-265)", async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const owner = await fx.ctx(c, c.owner);
    const ownerId = owner.membership.id;
    const agent = (await fx.ctx(c, c.agent)).membership.id;
    const marketer = (await fx.ctx(c, c.marketer)).membership.id;
    const other = await fx.company();
    const elsewhere = (await fx.ctx(other, other.agent)).membership.id;
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    const refusals = [
      [['task.created'], [agent], 'ownerIds'],
      [['deal.created'], [], 'ownerIds'],
      [['deal.created'], [agent, 'agent@example.com'], 'ownerIds.1'],
      [['deal.stage_changed'], [agent, marketer], 'ownerIds.1'],
      [['deal.status_changed'], [elsewhere], 'ownerIds.0'],
    ] as const;
    for (const [index, [events, ownerIds, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, ownerIds },
            idem(`owners-bad-${index}`, JSON.stringify(ownerIds)),
          ),
        ),
        JSON.stringify(ownerIds),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'owners-1', {
      url: receiverUrl(),
      events: ['deal.created', 'contact.created'],
      ownerIds: [agent, ownerId.toUpperCase(), agent],
    });
    const id = created.body.data.id;
    expect(created.body.data.ownerIds).toEqual([agent, ownerId]);
    expect((await api().get(key.ctx, id)).ownerIds).toEqual([agent, ownerId]);
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { ownerIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND subject_id = $2 AND action = $3 ORDER BY occurred_at, id`,
          [c.tenant.id, id, action],
        )
      ).map((a) => a.metadata.ownerIds);
    expect(await audits('webhook.endpoint_created')).toEqual([[agent, ownerId]]);
    // The agent leaves the company: kept, and Settings says they no longer use the CRM.
    await fx.query(`UPDATE app.memberships SET status = 'removed' WHERE id = $1`, [agent]);
    expect((await settings().list(owner)).find((e) => e.id === id)?.owners).toEqual([
      { id: agent, name: 'Agent', active: false },
      { id: ownerId, name: 'Owner', active: true },
    ]);
    expect(await api().update(key.ctx, id, { description: 'Deals of two' })).toMatchObject({
      ownerIds: [agent, ownerId],
    });
    // Given again, a list keeps a member it held; one it adds must own deals now.
    expect(await api().update(key.ctx, id, { ownerIds: [agent, ownerId] })).toMatchObject({
      ownerIds: [agent, ownerId],
    });
    expect(
      await issueOf(api().update(key.ctx, id, { ownerIds: [ownerId, marketer] })),
    ).toMatchObject({ path: 'ownerIds.1' });
    expect(await api().update(key.ctx, id, { ownerIds: [ownerId] })).toMatchObject({
      ownerIds: [ownerId],
    });
    expect(await audits('webhook.endpoint_updated')).toEqual([
      [agent, ownerId],
      [agent, ownerId],
      [ownerId],
    ]);
    // Any deal event keeps the list; events without one clear it.
    expect(await api().update(key.ctx, id, { events: ['deal.stage_changed'] })).toMatchObject({
      ownerIds: [ownerId],
    });
    expect(await api().update(key.ctx, id, { events: ['contact.created'] })).toMatchObject({
      events: ['contact.created'],
      ownerIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { ownerIds: [ownerId] }))).toMatchObject({
      path: 'ownerIds',
    });
    expect(
      await api().update(key.ctx, id, { events: ['deal.created'], ownerIds: [ownerId] }),
    ).toMatchObject({ ownerIds: [ownerId] });
    expect(await api().update(key.ctx, id, { ownerIds: null })).toMatchObject({ ownerIds: null });
    expect(await issueOf(api().update(key.ctx, id, { ownerIds: [] }))).toMatchObject({
      path: 'ownerIds',
    });
  });

  it("choose the members whose tasks' events an endpoint receives, kept by changes that leave them out, a member who left included, and cleared with the events (ADR-266)", async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const owner = await fx.ctx(c, c.owner);
    const ownerId = owner.membership.id;
    const agent = (await fx.ctx(c, c.agent)).membership.id;
    const marketer = (await fx.ctx(c, c.marketer)).membership.id;
    const other = await fx.company();
    const elsewhere = (await fx.ctx(other, other.agent)).membership.id;
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    const refusals = [
      [['deal.created'], [agent], 'taskAssigneeIds'],
      [['task.created'], [], 'taskAssigneeIds'],
      [['task.created'], [agent, 'agent@example.com'], 'taskAssigneeIds.1'],
      [['task.status_changed'], [agent, marketer], 'taskAssigneeIds.1'],
      [['task.created'], [elsewhere], 'taskAssigneeIds.0'],
    ] as const;
    for (const [index, [events, taskAssigneeIds, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, taskAssigneeIds },
            idem(`task-assignees-bad-${index}`, JSON.stringify(taskAssigneeIds)),
          ),
        ),
        JSON.stringify(taskAssigneeIds),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'task-assignees-1', {
      url: receiverUrl(),
      events: ['task.created', 'contact.created'],
      taskAssigneeIds: [agent, ownerId.toUpperCase(), agent],
    });
    const id = created.body.data.id;
    expect(created.body.data.taskAssigneeIds).toEqual([agent, ownerId]);
    expect(created.body.data.ownerIds).toBeNull();
    expect((await api().get(key.ctx, id)).taskAssigneeIds).toEqual([agent, ownerId]);
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { taskAssigneeIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND subject_id = $2 AND action = $3 ORDER BY occurred_at, id`,
          [c.tenant.id, id, action],
        )
      ).map((a) => a.metadata.taskAssigneeIds);
    expect(await audits('webhook.endpoint_created')).toEqual([[agent, ownerId]]);
    // The agent leaves the company: kept, and Settings says they no longer use the CRM.
    await fx.query(`UPDATE app.memberships SET status = 'removed' WHERE id = $1`, [agent]);
    expect((await settings().list(owner)).find((e) => e.id === id)?.taskAssignees).toEqual([
      { id: agent, name: 'Agent', active: false },
      { id: ownerId, name: 'Owner', active: true },
    ]);
    expect(await api().update(key.ctx, id, { description: 'Tasks of two' })).toMatchObject({
      taskAssigneeIds: [agent, ownerId],
    });
    // Given again, a list keeps a member it held; one it adds must be able to be assigned tasks.
    expect(await api().update(key.ctx, id, { taskAssigneeIds: [agent, ownerId] })).toMatchObject({
      taskAssigneeIds: [agent, ownerId],
    });
    expect(
      await issueOf(api().update(key.ctx, id, { taskAssigneeIds: [ownerId, marketer] })),
    ).toMatchObject({ path: 'taskAssigneeIds.1' });
    expect(await api().update(key.ctx, id, { taskAssigneeIds: [ownerId] })).toMatchObject({
      taskAssigneeIds: [ownerId],
    });
    expect(await audits('webhook.endpoint_updated')).toEqual([
      [agent, ownerId],
      [agent, ownerId],
      [ownerId],
    ]);
    // Either task event keeps the list; events without one clear it.
    expect(await api().update(key.ctx, id, { events: ['task.status_changed'] })).toMatchObject({
      taskAssigneeIds: [ownerId],
    });
    expect(await api().update(key.ctx, id, { events: ['contact.created'] })).toMatchObject({
      events: ['contact.created'],
      taskAssigneeIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { taskAssigneeIds: [ownerId] }))).toMatchObject({
      path: 'taskAssigneeIds',
    });
    expect(
      await api().update(key.ctx, id, { events: ['task.created'], taskAssigneeIds: [ownerId] }),
    ).toMatchObject({ taskAssigneeIds: [ownerId] });
    expect(await api().update(key.ctx, id, { taskAssigneeIds: null })).toMatchObject({
      taskAssigneeIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { taskAssigneeIds: [] }))).toMatchObject({
      path: 'taskAssigneeIds',
    });
  });

  it("choose the pipelines whose deals' tasks' events an endpoint receives, archived ones too, apart from the deals' pipelines, kept by changes that leave them out and cleared with the events (ADR-303)", async () => {
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
    // The pipelines of tasks' deals need a task event (deal events take pipelineIds), at least
    // one, each an id of the company's pipelines (named by place).
    const refusals = [
      [['deal.created', 'deal.status_changed'], [sales], 'taskPipelineIds'],
      [['task.created'], [], 'taskPipelineIds'],
      [['task.created'], [sales, 'Renewals'], 'taskPipelineIds.1'],
      [['task.updated'], [sales, elsewhere], 'taskPipelineIds.1'],
      [['task.status_changed'], [uuidv7()], 'taskPipelineIds.0'],
    ] as const;
    for (const [index, [events, taskPipelineIds, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, taskPipelineIds },
            idem(`task-pipelines-bad-${index}`, JSON.stringify(taskPipelineIds)),
          ),
        ),
        JSON.stringify(taskPipelineIds),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'task-pipelines-1', {
      url: receiverUrl(),
      events: ['task.created', 'deal.created'],
      pipelineIds: [sales],
      taskPipelineIds: [renewals, sales.toUpperCase(), renewals],
    });
    const id = created.body.data.id;
    expect(created.body.data.taskPipelineIds).toEqual([renewals, sales]);
    expect(created.body.data.pipelineIds).toEqual([sales]);
    expect((await api().get(key.ctx, id)).taskPipelineIds).toEqual([renewals, sales]);
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { taskPipelineIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND subject_id = $2 AND action = $3 ORDER BY occurred_at, id`,
          [c.tenant.id, id, action],
        )
      ).map((a) => a.metadata.taskPipelineIds);
    expect(await audits('webhook.endpoint_created')).toEqual([[renewals, sales]]);
    // Settings names them, the archived one as archived.
    expect((await settings().list(owner)).find((e) => e.id === id)?.taskPipelines).toEqual([
      { id: renewals, name: 'Renewals', archived: true },
      { id: sales, name: 'Sales', archived: false },
    ]);
    expect(await api().update(key.ctx, id, { description: 'Tasks sync' })).toMatchObject({
      taskPipelineIds: [renewals, sales],
      pipelineIds: [sales],
    });
    expect(await api().update(key.ctx, id, { taskPipelineIds: [sales] })).toMatchObject({
      taskPipelineIds: [sales],
      pipelineIds: [sales],
    });
    expect(await audits('webhook.endpoint_updated')).toEqual([[renewals, sales], [sales]]);
    // Any task event keeps the list; events without one clear it.
    expect(await api().update(key.ctx, id, { events: ['task.assignee_changed'] })).toMatchObject({
      taskPipelineIds: [sales],
      pipelineIds: null,
    });
    expect(await api().update(key.ctx, id, { events: ['deal.created'] })).toMatchObject({
      events: ['deal.created'],
      taskPipelineIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { taskPipelineIds: [sales] }))).toMatchObject({
      path: 'taskPipelineIds',
    });
    expect(
      await api().update(key.ctx, id, { events: ['task.updated'], taskPipelineIds: [renewals] }),
    ).toMatchObject({ taskPipelineIds: [renewals] });
    // A list given again is checked again, changing nothing when it is refused.
    expect(
      await issueOf(api().update(key.ctx, id, { taskPipelineIds: [elsewhere] })),
    ).toMatchObject({ path: 'taskPipelineIds.0' });
    expect((await api().get(key.ctx, id)).taskPipelineIds).toEqual([renewals]);
    expect(await api().update(key.ctx, id, { taskPipelineIds: null })).toMatchObject({
      taskPipelineIds: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { taskPipelineIds: [] }))).toMatchObject({
      path: 'taskPipelineIds',
    });
  });

  it("choose the stages and owners of the deals whose tasks' events an endpoint receives, removed stages and members who left too, kept by changes that leave them out and cleared with the events (ADR-304)", async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const owner = await fx.ctx(c, c.owner);
    const ownerId = owner.membership.id;
    const agent = (await fx.ctx(c, c.agent)).membership.id;
    const marketer = (await fx.ctx(c, c.marketer)).membership.id;
    const other = await fx.company();
    const elsewhereMember = (await fx.ctx(other, other.agent)).membership.id;
    const crm = createCrmService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
    });
    const stagesOf = async (company: Company) => {
      const companyOwner = await fx.ctx(company, company.owner);
      const { id } = await crm.createPipeline(companyOwner, {
        name: 'Sales',
        currency: 'INR',
        stages: ['New', 'Proposal', 'Lost'],
      });
      const [sales] = (await crm.listPipelines(companyOwner)).filter((p) => p.id === id);
      const stage = (name: string) => sales!.stages.find((st) => st.name === name)!.id;
      return { fresh: stage('New'), proposal: stage('Proposal'), lost: stage('Lost') };
    };
    const { fresh, proposal, lost } = await stagesOf(c);
    const elsewhereStage = (await stagesOf(other)).proposal;
    // Lost is removed from the pipeline: a list may still name it.
    const [sales] = (await crm.listPipelines(owner)).filter((p) =>
      p.stages.some((st) => st.id === lost),
    );
    await crm.updatePipeline(owner, {
      id: sales!.id,
      expectedVersion: sales!.version,
      name: 'Sales',
      stages: sales!.stages.slice(0, 2).map((st) => ({ id: st.id, name: st.name })),
    });
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // They need a task event (deal events take stageIds and ownerIds), at least one, each the
    // company's stage, or a member of it who can own deals (named by place).
    const refusals = [
      ['taskStageIds', ['deal.created'], [proposal], 'taskStageIds'],
      ['taskStageIds', ['task.created'], [], 'taskStageIds'],
      ['taskStageIds', ['task.created'], [proposal, 'Proposal'], 'taskStageIds.1'],
      ['taskStageIds', ['task.updated'], [proposal, elsewhereStage], 'taskStageIds.1'],
      ['taskDealOwnerIds', ['deal.created'], [agent], 'taskDealOwnerIds'],
      ['taskDealOwnerIds', ['task.created'], [], 'taskDealOwnerIds'],
      ['taskDealOwnerIds', ['task.created'], [agent, 'agent@example.com'], 'taskDealOwnerIds.1'],
      ['taskDealOwnerIds', ['task.status_changed'], [agent, marketer], 'taskDealOwnerIds.1'],
      ['taskDealOwnerIds', ['task.created'], [elsewhereMember], 'taskDealOwnerIds.0'],
    ] as const;
    for (const [index, [field, events, ids, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, [field]: ids },
            idem(`task-deal-bad-${index}`, JSON.stringify(ids)),
          ),
        ),
        `${field} ${JSON.stringify(ids)}`,
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'task-deals-1', {
      url: receiverUrl(),
      events: ['task.created', 'deal.created'],
      stageIds: [fresh],
      ownerIds: [ownerId],
      taskStageIds: [lost, proposal.toUpperCase(), lost],
      taskDealOwnerIds: [agent, ownerId.toUpperCase(), agent],
    });
    const id = created.body.data.id;
    expect(created.body.data).toMatchObject({
      stageIds: [fresh],
      ownerIds: [ownerId],
      taskStageIds: [lost, proposal],
      taskDealOwnerIds: [agent, ownerId],
    });
    expect(await api().get(key.ctx, id)).toMatchObject({
      taskStageIds: [lost, proposal],
      taskDealOwnerIds: [agent, ownerId],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { taskStageIds?: unknown; taskDealOwnerIds?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND subject_id = $2 AND action = $3 ORDER BY occurred_at, id`,
          [c.tenant.id, id, action],
        )
      ).map((a) => [a.metadata.taskStageIds ?? null, a.metadata.taskDealOwnerIds ?? null]);
    expect(await audits('webhook.endpoint_created')).toEqual([
      [
        [lost, proposal],
        [agent, ownerId],
      ],
    ]);
    // Settings names them: the removed stage as removed, and the agent, gone, as no longer using
    // the CRM, still on the list.
    await fx.query(`UPDATE app.memberships SET status = 'removed' WHERE id = $1`, [agent]);
    const shown = (await settings().list(owner)).find((e) => e.id === id);
    expect(shown?.taskStages?.map((st) => [st.id, st.removed])).toEqual([
      [lost, true],
      [proposal, false],
    ]);
    expect(shown?.taskDealOwners).toEqual([
      { id: agent, name: 'Agent', active: false },
      { id: ownerId, name: 'Owner', active: true },
    ]);
    expect(await api().update(key.ctx, id, { description: 'Tasks of deals' })).toMatchObject({
      taskStageIds: [lost, proposal],
      taskDealOwnerIds: [agent, ownerId],
    });
    // Given again, a list keeps a member it held; one it adds must be able to own deals.
    expect(
      await api().update(key.ctx, id, {
        taskStageIds: [proposal],
        taskDealOwnerIds: [agent, ownerId],
      }),
    ).toMatchObject({ taskStageIds: [proposal], taskDealOwnerIds: [agent, ownerId] });
    expect(
      await issueOf(api().update(key.ctx, id, { taskDealOwnerIds: [ownerId, marketer] })),
    ).toMatchObject({ path: 'taskDealOwnerIds.1' });
    expect(
      await issueOf(api().update(key.ctx, id, { taskStageIds: [elsewhereStage] })),
    ).toMatchObject({ path: 'taskStageIds.0' });
    expect(await api().update(key.ctx, id, { taskDealOwnerIds: [ownerId] })).toMatchObject({
      taskStageIds: [proposal],
      taskDealOwnerIds: [ownerId],
    });
    expect(await audits('webhook.endpoint_updated')).toEqual([
      [
        [lost, proposal],
        [agent, ownerId],
      ],
      [[proposal], [agent, ownerId]],
      [[proposal], [ownerId]],
    ]);
    // Any task event keeps the lists; events without one clear them.
    expect(await api().update(key.ctx, id, { events: ['task.status_changed'] })).toMatchObject({
      taskStageIds: [proposal],
      taskDealOwnerIds: [ownerId],
      stageIds: null,
      ownerIds: null,
    });
    expect(await api().update(key.ctx, id, { events: ['deal.created'] })).toMatchObject({
      events: ['deal.created'],
      taskStageIds: null,
      taskDealOwnerIds: null,
    });
    for (const field of ['taskStageIds', 'taskDealOwnerIds'] as const) {
      expect(
        await issueOf(
          api().update(key.ctx, id, { [field]: [field === 'taskStageIds' ? fresh : ownerId] }),
        ),
        field,
      ).toMatchObject({ path: field });
    }
    expect(
      await api().update(key.ctx, id, {
        events: ['task.updated'],
        taskStageIds: [fresh],
        taskDealOwnerIds: [ownerId],
      }),
    ).toMatchObject({ taskStageIds: [fresh], taskDealOwnerIds: [ownerId] });
    expect(
      await api().update(key.ctx, id, { taskStageIds: null, taskDealOwnerIds: null }),
    ).toMatchObject({ taskStageIds: null, taskDealOwnerIds: null });
    expect(await issueOf(api().update(key.ctx, id, { taskStageIds: [] }))).toMatchObject({
      path: 'taskStageIds',
    });
  });

  it("choose the pipelines, stages and owners of the deals whose notes' events an endpoint receives, a member who left too, kept by changes that leave them out and cleared with the event (ADR-305)", async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const owner = await fx.ctx(c, c.owner);
    const ownerId = owner.membership.id;
    const agent = (await fx.ctx(c, c.agent)).membership.id;
    const marketer = (await fx.ctx(c, c.marketer)).membership.id;
    const other = await fx.company();
    const crm = createCrmService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
    });
    const salesOf = async (company: Company) => {
      const companyOwner = await fx.ctx(company, company.owner);
      const { id } = await crm.createPipeline(companyOwner, {
        name: 'Sales',
        currency: 'INR',
        stages: ['New', 'Proposal'],
      });
      const [sales] = (await crm.listPipelines(companyOwner)).filter((p) => p.id === id);
      return { pipeline: id, proposal: sales!.stages.find((st) => st.name === 'Proposal')!.id };
    };
    const { pipeline: sales, proposal } = await salesOf(c);
    const theirs = await salesOf(other);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    // They need note.created (deal and task events take lists of their own), at least one, each the
    // company's pipeline or stage, or a member of it who can own deals (named by place).
    const refusals = [
      ['notePipelineIds', ['deal.created', 'task.created'], [sales], 'notePipelineIds'],
      ['notePipelineIds', ['note.created'], [], 'notePipelineIds'],
      ['notePipelineIds', ['note.created'], [sales, theirs.pipeline], 'notePipelineIds.1'],
      ['noteStageIds', ['task.created'], [proposal], 'noteStageIds'],
      ['noteStageIds', ['note.created'], [proposal, 'Proposal'], 'noteStageIds.1'],
      ['noteStageIds', ['note.created'], [theirs.proposal], 'noteStageIds.0'],
      ['noteDealOwnerIds', ['deal.created'], [agent], 'noteDealOwnerIds'],
      ['noteDealOwnerIds', ['note.created'], [agent, marketer], 'noteDealOwnerIds.1'],
    ] as const;
    for (const [index, [field, events, ids, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, [field]: ids },
            idem(`note-deal-bad-${index}`, JSON.stringify(ids)),
          ),
        ),
        `${field} ${JSON.stringify(ids)}`,
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'note-deals-1', {
      url: receiverUrl(),
      events: ['note.created', 'deal.created'],
      pipelineIds: [sales],
      notePipelineIds: [sales.toUpperCase(), sales],
      noteStageIds: [proposal],
      noteDealOwnerIds: [agent, ownerId.toUpperCase(), agent],
    });
    const id = created.body.data.id;
    expect(created.body.data).toMatchObject({
      pipelineIds: [sales],
      taskPipelineIds: null,
      notePipelineIds: [sales],
      noteStageIds: [proposal],
      noteDealOwnerIds: [agent, ownerId],
    });
    expect(await api().get(key.ctx, id)).toMatchObject({
      notePipelineIds: [sales],
      noteStageIds: [proposal],
      noteDealOwnerIds: [agent, ownerId],
    });
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: Record<string, unknown> }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND subject_id = $2 AND action = $3 ORDER BY occurred_at, id`,
          [c.tenant.id, id, action],
        )
      ).map((a) => [
        a.metadata.notePipelineIds ?? null,
        a.metadata.noteStageIds ?? null,
        a.metadata.noteDealOwnerIds ?? null,
      ]);
    expect(await audits('webhook.endpoint_created')).toEqual([
      [[sales], [proposal], [agent, ownerId]],
    ]);
    // Settings names them, and the agent, gone, as no longer using the CRM, still on the list.
    await fx.query(`UPDATE app.memberships SET status = 'removed' WHERE id = $1`, [agent]);
    const shown = (await settings().list(owner)).find((e) => e.id === id);
    expect([
      shown?.notePipelines,
      shown?.noteStages?.map((st) => st.id),
      shown?.noteDealOwners,
    ]).toEqual([
      [{ id: sales, name: 'Sales', archived: false }],
      [proposal],
      [
        { id: agent, name: 'Agent', active: false },
        { id: ownerId, name: 'Owner', active: true },
      ],
    ]);
    expect(await api().update(key.ctx, id, { description: 'Notes of deals' })).toMatchObject({
      notePipelineIds: [sales],
      noteStageIds: [proposal],
      noteDealOwnerIds: [agent, ownerId],
    });
    // Given again, a list keeps a member it held; one it adds must be able to own deals.
    expect(
      await api().update(key.ctx, id, { noteStageIds: null, noteDealOwnerIds: [agent, ownerId] }),
    ).toMatchObject({ noteStageIds: null, noteDealOwnerIds: [agent, ownerId] });
    expect(
      await issueOf(api().update(key.ctx, id, { noteDealOwnerIds: [ownerId, marketer] })),
    ).toMatchObject({ path: 'noteDealOwnerIds.1' });
    expect(
      await issueOf(api().update(key.ctx, id, { notePipelineIds: [theirs.pipeline] })),
    ).toMatchObject({ path: 'notePipelineIds.0' });
    expect(
      await issueOf(api().update(key.ctx, id, { noteStageIds: [theirs.proposal] })),
    ).toMatchObject({ path: 'noteStageIds.0' });
    expect(await api().update(key.ctx, id, { noteDealOwnerIds: [ownerId] })).toMatchObject({
      notePipelineIds: [sales],
      noteStageIds: null,
      noteDealOwnerIds: [ownerId],
    });
    expect(await audits('webhook.endpoint_updated')).toEqual([
      [[sales], [proposal], [agent, ownerId]],
      [[sales], null, [agent, ownerId]],
      [[sales], null, [ownerId]],
    ]);
    // note.created keeps the lists; events without it clear them.
    expect(await api().update(key.ctx, id, { events: ['note.created'] })).toMatchObject({
      notePipelineIds: [sales],
      noteDealOwnerIds: [ownerId],
      pipelineIds: null,
    });
    expect(await api().update(key.ctx, id, { events: ['deal.created'] })).toMatchObject({
      events: ['deal.created'],
      notePipelineIds: null,
      noteStageIds: null,
      noteDealOwnerIds: null,
    });
    for (const [field, value] of [
      ['notePipelineIds', sales],
      ['noteStageIds', proposal],
      ['noteDealOwnerIds', ownerId],
    ] as const) {
      expect(await issueOf(api().update(key.ctx, id, { [field]: [value] })), field).toMatchObject({
        path: field,
      });
    }
    expect(
      await api().update(key.ctx, id, {
        events: ['note.created'],
        notePipelineIds: [sales],
        noteStageIds: [proposal],
        noteDealOwnerIds: [ownerId],
      }),
    ).toMatchObject({
      notePipelineIds: [sales],
      noteStageIds: [proposal],
      noteDealOwnerIds: [ownerId],
    });
    expect(
      await api().update(key.ctx, id, {
        notePipelineIds: null,
        noteStageIds: null,
        noteDealOwnerIds: null,
      }),
    ).toMatchObject({ notePipelineIds: null, noteStageIds: null, noteDealOwnerIds: null });
    expect(await issueOf(api().update(key.ctx, id, { notePipelineIds: [] }))).toMatchObject({
      path: 'notePipelineIds',
    });
  });

  it("choose the contact tags whose conversations' events an endpoint receives, as contacts carry them, kept by changes that leave them out and cleared with the events (ADR-267)", async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    const refusals = [
      [['deal.created'], ['vip'], 'contactTags'],
      [['message.received'], [], 'contactTags'],
      [['message.received'], ['vip', 'a,b'], 'contactTags.1'],
      [['message.status'], ['vip', ' '], 'contactTags.1'],
    ] as const;
    for (const [index, [events, contactTags, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, contactTags },
            idem(`contact-tags-bad-${index}`, JSON.stringify(contactTags)),
          ),
        ),
        JSON.stringify(contactTags),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'contact-tags-1', {
      url: receiverUrl(),
      events: ['message.received', 'contact.created'],
      contactTags: ['VIP', 'vip ', 'Gold  Member'],
    });
    const id = created.body.data.id;
    expect(created.body.data.contactTags).toEqual(['vip', 'gold member']);
    expect((await api().get(key.ctx, id)).contactTags).toEqual(['vip', 'gold member']);
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { contactTags?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND subject_id = $2 AND action = $3 ORDER BY occurred_at, id`,
          [c.tenant.id, id, action],
        )
      ).map((a) => a.metadata.contactTags);
    expect(await audits('webhook.endpoint_created')).toEqual([['vip', 'gold member']]);
    expect(await api().update(key.ctx, id, { description: 'Priority desk' })).toMatchObject({
      contactTags: ['vip', 'gold member'],
    });
    expect(await api().update(key.ctx, id, { contactTags: ['Wholesale'] })).toMatchObject({
      contactTags: ['wholesale'],
    });
    expect(await audits('webhook.endpoint_updated')).toEqual([
      ['vip', 'gold member'],
      ['wholesale'],
    ]);
    // Any event of a conversation keeps the list; events without one clear it.
    expect(
      await api().update(key.ctx, id, { events: ['conversation.team_changed'] }),
    ).toMatchObject({ contactTags: ['wholesale'] });
    expect(await api().update(key.ctx, id, { events: ['contact.created'] })).toMatchObject({
      events: ['contact.created'],
      contactTags: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { contactTags: ['vip'] }))).toMatchObject({
      path: 'contactTags',
    });
    expect(
      await api().update(key.ctx, id, { events: ['message.status'], contactTags: ['vip'] }),
    ).toMatchObject({ contactTags: ['vip'] });
    expect(await api().update(key.ctx, id, { contactTags: null })).toMatchObject({
      contactTags: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { contactTags: [] }))).toMatchObject({
      path: 'contactTags',
    });
  });

  it('choose the conversation tags whose events an endpoint receives, as conversations carry them, kept by changes that leave them out and cleared with the events (ADR-273)', async () => {
    const c = await fx.company();
    const key = await apiKey(c, ['webhooks.manage']);
    const issueOf = async (promise: Promise<unknown>) => {
      const error = await expectAppError(promise, 'validation_failed');
      return isAppError(error) ? error.issues?.[0] : undefined;
    };
    const refusals = [
      [['deal.created'], ['refund'], 'conversationTags'],
      [['message.received'], [], 'conversationTags'],
      [['message.received'], ['refund', 'a,b'], 'conversationTags.1'],
      [['message.status'], ['refund', ' '], 'conversationTags.1'],
    ] as const;
    for (const [index, [events, conversationTags, path]] of refusals.entries()) {
      expect(
        await issueOf(
          api().create(
            key.ctx,
            { url: receiverUrl(), events, conversationTags },
            idem(`conversation-tags-bad-${index}`, JSON.stringify(conversationTags)),
          ),
        ),
        JSON.stringify(conversationTags),
      ).toMatchObject({ path });
    }
    expect((await api().list(key.ctx)).data).toEqual([]);

    const created = await addThroughApi(key.ctx, 'conv-tags-1', {
      url: receiverUrl(),
      events: ['message.received', 'contact.created'],
      conversationTags: ['Refund', 'refund ', 'Delivery  Delay'],
      contactTags: ['vip'],
    });
    const id = created.body.data.id;
    expect(created.body.data).toMatchObject({
      conversationTags: ['refund', 'delivery delay'],
      contactTags: ['vip'],
    });
    expect((await api().get(key.ctx, id)).conversationTags).toEqual(['refund', 'delivery delay']);
    const audits = async (action: string) =>
      (
        await fx.query<{ metadata: { conversationTags?: unknown } }>(
          `SELECT metadata FROM app.audit_events
            WHERE tenant_id = $1 AND subject_id = $2 AND action = $3 ORDER BY occurred_at, id`,
          [c.tenant.id, id, action],
        )
      ).map((a) => a.metadata.conversationTags);
    expect(await audits('webhook.endpoint_created')).toEqual([['refund', 'delivery delay']]);
    expect(await api().update(key.ctx, id, { description: 'Refunds desk' })).toMatchObject({
      conversationTags: ['refund', 'delivery delay'],
    });
    expect(await api().update(key.ctx, id, { conversationTags: ['Urgent'] })).toMatchObject({
      conversationTags: ['urgent'],
      contactTags: ['vip'],
    });
    expect(await audits('webhook.endpoint_updated')).toEqual([
      ['refund', 'delivery delay'],
      ['urgent'],
    ]);
    // Any event of a conversation keeps the list; events without one clear it.
    expect(
      await api().update(key.ctx, id, { events: ['conversation.team_changed'] }),
    ).toMatchObject({ conversationTags: ['urgent'] });
    expect(await api().update(key.ctx, id, { events: ['contact.created'] })).toMatchObject({
      events: ['contact.created'],
      conversationTags: null,
      contactTags: null,
    });
    expect(
      await issueOf(api().update(key.ctx, id, { conversationTags: ['refund'] })),
    ).toMatchObject({ path: 'conversationTags' });
    expect(
      await api().update(key.ctx, id, { events: ['message.status'], conversationTags: ['refund'] }),
    ).toMatchObject({ conversationTags: ['refund'] });
    expect(await api().update(key.ctx, id, { conversationTags: null })).toMatchObject({
      conversationTags: null,
    });
    expect(await issueOf(api().update(key.ctx, id, { conversationTags: [] }))).toMatchObject({
      path: 'conversationTags',
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
