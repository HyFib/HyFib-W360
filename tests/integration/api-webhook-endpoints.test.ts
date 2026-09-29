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
  createWebhooksService,
  outboxAad,
  processWebhookDeliveries,
  verifyWebhookSignature,
  type ApiContext,
  type ApiKeysService,
  type ApiScope,
} from '@w360/domain';
import { acceptInvitation, createUser, invite } from './helpers';
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
