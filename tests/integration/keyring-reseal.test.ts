import { randomBytes, randomInt } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Keyring, isAppError, systemClock, uuidv7, type Clock } from '@w360/core';
import { DEFAULT_EGRESS_POLICY, createEgressClient } from '@w360/core/egress';
import { authorizedTenantScope, sql, systemScope } from '@w360/db';
import {
  RESEAL_IDLE_MS,
  RESEAL_SKIP_LIMIT,
  advanceAutomationRun,
  createAutomationService,
  createPlatformOpsService,
  createWebRequestService,
  credentialAad,
  flowKeyAad,
  httpRequestAad,
  httpSecretAad,
  newResealState,
  outboxAad,
  paymentAccountAad,
  pgBossQueueInspector,
  processHttpCall,
  processMetaWebhookReceipt,
  receiptAad,
  registrationPinAad,
  resealStoredValues,
  resealValue,
  storeAccessCodeAad,
  storeCredentialsAad,
  storeWebhookReceipt,
  storeWebhookSecretAad,
  webhookHeadersAad,
  webhookSecretAad,
  type PlatformActor,
  type ResealState,
  type SealedValueKind,
  type TenantContext,
} from '@w360/domain';
import { createUser } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Re-encrypting stored secrets under the primary key (SEC-10, ADR-134) against real PostgreSQL: the
 * minute sweep's part finds every kind of value a configured key other than the primary sealed (ids
 * only, through a definer function) and seals each one again with the primary key in its company's
 * scope, after which a keyring without the old key opens all of them, through the services' own
 * code for an automation's HTTP call, its secret and a provider receipt. A row's time does not
 * change, a value replaced meanwhile is left as it is, a value that does not open is reported once,
 * a store's webhook secret changes only this way, and the operations console counts values by key.
 * Each test seals with key ids of its own: other files seal values in the same database.
 */
let fx: WhatsAppFixture;
let target: Server;
let port = 0;
let staff: PlatformActor;
const received: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];

const HOST = 'api.reseal.test';
const TOKEN = 'shop-token-71c2e9';

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  target = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { status: 'shipped' } }));
    });
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  port = (target.address() as AddressInfo).port;
  const user = await createUser(fx.dbs, { twoFactor: true });
  await fx.dbs.ownerPool.query(
    `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_operator')`,
    [user.id],
  );
  staff = { userId: user.id, role: 'platform_operator', correlationId: uuidv7() };
});

afterAll(async () => {
  target?.closeAllConnections();
  target?.close();
  await fx?.close();
});

/** An old and a new key with ids of the test's own, and the keyrings before, during and after. */
function rotation() {
  const tag = randomBytes(4).toString('hex');
  const ids = { old: `old${tag}`, new: `new${tag}` };
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  return {
    ids,
    before: new Keyring({ primaryKeyId: ids.old, keys: { [ids.old]: oldKey } }),
    during: new Keyring({ primaryKeyId: ids.new, keys: { [ids.old]: oldKey, [ids.new]: newKey } }),
    after: new Keyring({ primaryKeyId: ids.new, keys: { [ids.new]: newKey } }),
  };
}

const keyOf = (sealed: string | null) => sealed?.split(':')[1] ?? null;
const later = (ms: number): Clock => ({ now: () => new Date(Date.now() + ms) });
const waId = () => `91${randomInt(7_000_000_000, 9_999_999_999)}`;
const publicId = () =>
  Array.from({ length: 16 }, () => 'abcdefghijklmnopqrstuvwxyz234567'[randomInt(32)]).join('');

/** Sweeps until a lookup finds nothing (which sets the next lookup an hour later). */
async function sweepUntilDone(
  ring: Keyring,
  state: ResealState = newResealState(),
  clock: Clock = systemClock,
) {
  const totals = { resealed: 0, changed: 0, unopenable: 0, failed: 0 };
  for (let i = 0; i < 20; i += 1) {
    const r = await resealStoredValues({ db: fx.dbs.app, keyring: ring, clock }, state);
    totals.resealed += r.resealed;
    totals.changed += r.changed;
    totals.unopenable += r.unopenable.length;
    totals.failed += r.failed.length;
    if (r.failed.length > 0) throw toThrowable(r.failed[0]!.error);
    if (r.resealed + r.changed + r.unopenable.length === 0) return totals;
  }
  throw new Error('the sweep did not finish');
}

const toThrowable = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

async function membershipOf(c: Company) {
  const [m] = await fx.query<{ id: string }>(
    'SELECT id FROM app.memberships WHERE tenant_id = $1 AND user_id = $2',
    [c.tenant.id, c.owner.id],
  );
  return m!.id;
}

/** A sealed value written as its service writes it, and where to read it back. */
interface Seeded {
  kind: SealedValueKind;
  table: string;
  column: string;
  id: string;
  plain: string;
  aad: string;
}

/**
 * Seals one value of every kind but the HTTP call (an automation queues that one) for company `c`
 * with `ring`, through SQL as the services store them.
 */
async function sealEverything(c: Company, ring: Keyring): Promise<Seeded[]> {
  const t = c.tenant.id;
  const member = await membershipOf(c);
  const seeded: Seeded[] = [];
  const seal = (s: Omit<Seeded, 'aad'> & { aad: string }) => {
    seeded.push(s);
    return ring.encrypt(s.plain, s.aad);
  };
  await fx.query('UPDATE app.whatsapp_accounts SET credential_ciphertext = $1 WHERE id = $2', [
    seal({
      kind: 'whatsapp_token',
      table: 'app.whatsapp_accounts',
      column: 'credential_ciphertext',
      id: c.whatsappAccountId,
      plain: c.token,
      aad: credentialAad(t, c.whatsappAccountId),
    }),
    c.whatsappAccountId,
  ]);
  await fx.query('UPDATE app.channel_accounts SET registration_pin_ciphertext = $1 WHERE id = $2', [
    seal({
      kind: 'registration_pin',
      table: 'app.channel_accounts',
      column: 'registration_pin_ciphertext',
      id: c.channelAccountId,
      plain: '204816',
      aad: registrationPinAad(t, c.channelAccountId),
    }),
    c.channelAccountId,
  ]);
  const secretId = uuidv7();
  await fx.query(
    `INSERT INTO app.http_secrets (id, tenant_id, name, domain, value_ciphertext,
       created_by_membership_id, updated_by_membership_id)
     VALUES ($1, $2, 'crm_token', 'api.crm.test', $3, $4, $4)`,
    [
      secretId,
      t,
      seal({
        kind: 'http_secret',
        table: 'app.http_secrets',
        column: 'value_ciphertext',
        id: secretId,
        plain: 'crm-token-5d1f',
        aad: httpSecretAad(t, secretId),
      }),
      member,
    ],
  );
  const accountId = uuidv7();
  await fx.query(
    `INSERT INTO app.commerce_payment_accounts (id, tenant_id, key_id, key_secret_ciphertext,
       webhook_secret_ciphertext, webhook_public_id, updated_by_membership_id)
     VALUES ($1, $2, 'rzp_test_ResealKey01', $3, $4, $5, $6)`,
    [
      accountId,
      t,
      seal({
        kind: 'payment_key_secret',
        table: 'app.commerce_payment_accounts',
        column: 'key_secret_ciphertext',
        id: accountId,
        plain: 'rzp-key-secret-0b3c',
        aad: paymentAccountAad(t, accountId, 'key'),
      }),
      seal({
        kind: 'payment_webhook_secret',
        table: 'app.commerce_payment_accounts',
        column: 'webhook_secret_ciphertext',
        id: accountId,
        plain: 'rzp-webhook-secret-9e7a',
        aad: paymentAccountAad(t, accountId, 'webhook'),
      }),
      publicId(),
      member,
    ],
  );
  const flowKeyId = uuidv7();
  await fx.query(
    `INSERT INTO app.flow_keys (id, tenant_id, whatsapp_account_id, public_key_pem, fingerprint,
       private_key_ciphertext)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      flowKeyId,
      t,
      c.whatsappAccountId,
      `-----BEGIN PUBLIC KEY-----\n${'A'.repeat(220)}\n-----END PUBLIC KEY-----`,
      randomBytes(32).toString('hex'),
      seal({
        kind: 'flow_private_key',
        table: 'app.flow_keys',
        column: 'private_key_ciphertext',
        id: flowKeyId,
        plain: '-----BEGIN PRIVATE KEY-----\nreseal\n-----END PRIVATE KEY-----',
        aad: flowKeyAad(t, flowKeyId),
      }),
    ],
  );
  // A WooCommerce store has a webhook secret; only a Shopify store has an access code.
  const wooId = uuidv7();
  await fx.query(
    `INSERT INTO app.commerce_stores (id, tenant_id, platform, store_url, webhook_public_id,
       webhook_secret_ciphertext, credentials_ciphertext, created_by_membership_id)
     VALUES ($1, $2, 'woocommerce', 'https://shop.reseal.test', $3, $4, $5, $6)`,
    [
      wooId,
      t,
      publicId(),
      seal({
        kind: 'store_webhook_secret',
        table: 'app.commerce_stores',
        column: 'webhook_secret_ciphertext',
        id: wooId,
        plain: 'woo-webhook-secret-41aa',
        aad: storeWebhookSecretAad(t, wooId),
      }),
      seal({
        kind: 'store_credentials',
        table: 'app.commerce_stores',
        column: 'credentials_ciphertext',
        id: wooId,
        plain: '{"kind":"woocommerce","consumerKey":"ck_1","consumerSecret":"cs_1"}',
        aad: storeCredentialsAad(t, wooId),
      }),
      member,
    ],
  );
  const shopifyId = uuidv7();
  await fx.query(
    `INSERT INTO app.commerce_stores (id, tenant_id, platform, shop_domain, store_url,
       access_code_ciphertext, created_by_membership_id)
     VALUES ($1, $2, 'shopify', $3, 'https://reseal.myshopify.com', $4, $5)`,
    [
      shopifyId,
      t,
      `reseal-${randomBytes(4).toString('hex')}.myshopify.com`,
      seal({
        kind: 'store_access_code',
        table: 'app.commerce_stores',
        column: 'access_code_ciphertext',
        id: shopifyId,
        plain: 'shopify-access-code-77',
        aad: storeAccessCodeAad(t, shopifyId),
      }),
      member,
    ],
  );
  // An endpoint rotated once: its secret is version 2 and the one before was sealed as version 1.
  const endpointId = uuidv7();
  await fx.query(
    `INSERT INTO app.webhook_endpoints (id, tenant_id, url, event_types, secret_ciphertext,
       secret_version, previous_secret_ciphertext, previous_secret_expires_at, header_names,
       headers_ciphertext, created_by_user_id)
     VALUES ($1, $2, 'https://hooks.reseal.test/w360', ARRAY['message.received'], $3, 2, $4,
       now() + interval '1 day', ARRAY['X-Api-Key'], $5, $6)`,
    [
      endpointId,
      t,
      seal({
        kind: 'webhook_secret',
        table: 'app.webhook_endpoints',
        column: 'secret_ciphertext',
        id: endpointId,
        plain: 'whsec_current',
        aad: webhookSecretAad(t, endpointId, 2),
      }),
      seal({
        kind: 'webhook_previous_secret',
        table: 'app.webhook_endpoints',
        column: 'previous_secret_ciphertext',
        id: endpointId,
        plain: 'whsec_previous',
        aad: webhookSecretAad(t, endpointId, 1),
      }),
      seal({
        kind: 'webhook_headers',
        table: 'app.webhook_endpoints',
        column: 'headers_ciphertext',
        id: endpointId,
        plain: '[["X-Api-Key","key-123"]]',
        aad: webhookHeadersAad(t, endpointId),
      }),
      c.owner.id,
    ],
  );
  // Waits a day, so no other file's email run sends it.
  const emailId = uuidv7();
  await fx.query(
    `INSERT INTO ops.email_outbox (id, tenant_id, kind, to_address, payload_ciphertext,
       next_attempt_at)
     VALUES ($1, $2, 'reseal.test', 'owner@reseal.test', $3, now() + interval '1 day')`,
    [
      emailId,
      t,
      seal({
        kind: 'queued_email',
        table: 'ops.email_outbox',
        column: 'payload_ciphertext',
        id: emailId,
        plain: '{"subject":"Hello"}',
        aad: outboxAad(emailId),
      }),
    ],
  );
  return seeded;
}

/** One more HTTP secret of company `c`, sealed with `ring`. */
async function sealSecret(c: Company, ring: Keyring, plain = 'extra-secret'): Promise<Seeded> {
  const id = uuidv7();
  const aad = httpSecretAad(c.tenant.id, id);
  const member = await membershipOf(c);
  await fx.query(
    `INSERT INTO app.http_secrets (id, tenant_id, name, domain, value_ciphertext,
       created_by_membership_id, updated_by_membership_id)
     VALUES ($1, $2, $3, 'api.crm.test', $4, $5, $5)`,
    [id, c.tenant.id, `s_${randomBytes(6).toString('hex')}`, ring.encrypt(plain, aad), member],
  );
  return {
    kind: 'http_secret',
    table: 'app.http_secrets',
    column: 'value_ciphertext',
    id,
    plain,
    aad,
  };
}

async function storedValue(s: Pick<Seeded, 'table' | 'column' | 'id'>) {
  const [row] = await fx.query<{ sealed: string | null }>(
    `SELECT ${s.column} AS sealed FROM ${s.table} WHERE id = $1`,
    [s.id],
  );
  return row?.sealed ?? null;
}

async function rowTimes(c: Company) {
  return fx.query<{ tbl: string; id: string; updated_at: Date }>(
    `SELECT 'whatsapp_accounts' AS tbl, id, updated_at FROM app.whatsapp_accounts WHERE tenant_id = $1
     UNION ALL SELECT 'channel_accounts', id, updated_at FROM app.channel_accounts WHERE tenant_id = $1
     UNION ALL SELECT 'http_secrets', id, updated_at FROM app.http_secrets WHERE tenant_id = $1
     UNION ALL SELECT 'commerce_payment_accounts', id, updated_at FROM app.commerce_payment_accounts WHERE tenant_id = $1
     UNION ALL SELECT 'commerce_stores', id, updated_at FROM app.commerce_stores WHERE tenant_id = $1
     UNION ALL SELECT 'webhook_endpoints', id, updated_at FROM app.webhook_endpoints WHERE tenant_id = $1
     ORDER BY 1, 2`,
    [c.tenant.id],
  );
}

const automations = () =>
  createAutomationService({
    db: fx.dbs.app,
    clock: systemClock,
    jobs: fx.jobs(),
    signer: fx.signer,
    allowInsecureHttp: true,
  });

/**
 * An automation that calls the shop with its secret, and a customer whose run now waits for that
 * call: the HTTP secret and the queued request are sealed with `ring` by the services themselves.
 */
async function queuedHttpCall(c: Company, owner: TenantContext, ring: Keyring) {
  const web = createWebRequestService({ db: fx.dbs.app, clock: systemClock, keyring: ring });
  await web.addDomain(owner, { domain: HOST });
  const { id: secretId } = await web.saveSecret(owner, {
    name: 'shop_token',
    domain: HOST,
    value: TOKEN,
  });
  const svc = automations();
  const name = `Reseal ${randomInt(1e6)}`;
  const { id } = await svc.createAutomation(owner, { name });
  const saved = await svc.updateAutomation(owner, {
    id,
    expectedVersion: 0,
    name,
    description: null,
    channelAccountId: null,
    trigger: {
      type: 'keyword',
      keywords: ['order'],
      match: 'contains',
      hours: 'any',
      cooldownMinutes: 0,
    },
    graph: {
      version: 1,
      start: 'call',
      nodes: [
        {
          id: 'call',
          type: 'http_request',
          method: 'POST',
          url: `http://${HOST}:${port}/orders`,
          headers: [{ name: 'Authorization', value: 'Bearer {{secret.shop_token}}' }],
          body: '{"customer": "{{name}}"}',
          save: [{ path: 'data.status', saveAs: 'status' }],
          next: null,
          failureNext: null,
        },
      ],
    },
  });
  await svc.publishAutomation(owner, { id, expectedVersion: saved.version, note: null });
  const from = waId();
  await fx.deliver(fx.messagesBody(c, { messages: [{ waId: from, text: 'order' }] }));
  const [run] = await fx.query<{ id: string }>(
    `SELECT r.id FROM app.automation_runs r
       JOIN app.contact_identities i ON i.tenant_id = r.tenant_id AND i.contact_id = r.contact_id
      WHERE r.tenant_id = $1 AND i.wa_id = $2`,
    [c.tenant.id, from],
  );
  const advanced = await advanceAutomationRun(
    { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock, keyring: ring },
    authorizedTenantScope(c.tenant.id, null),
    run!.id,
    null,
  );
  expect(advanced.outcome).toBe('waiting');
  const [call] = await fx.query<{ id: string; state: string; request_ciphertext: string | null }>(
    'SELECT id, state, request_ciphertext FROM app.automation_http_calls WHERE run_id = $1',
    [run!.id],
  );
  expect(call).toMatchObject({ state: 'queued' });
  return { secretId, callId: call!.id, request: call!.request_ciphertext };
}

function httpDeps(ring: Keyring) {
  return {
    db: fx.dbs.app,
    clock: systemClock,
    keyring: ring,
    jobs: fx.jobs(),
    signer: fx.signer,
    egress: createEgressClient(
      { ...DEFAULT_EGRESS_POLICY, allowLoopbackForTests: true, timeoutMs: 2_000 },
      { resolve: async () => [{ address: '127.0.0.1', family: 4 }] },
    ),
    timeoutMs: 2_000,
  };
}

const ops = (ring: Keyring) =>
  createPlatformOpsService({
    platformDb: fx.dbs.platform,
    queues: pgBossQueueInspector(fx.boss),
    clock: systemClock,
    keyring: ring,
    jobSigning: fx.signer,
  });

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    if (isAppError(error)) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('re-encrypting under the primary key', () => {
  it('seals every kind of stored secret again with the primary key, so the old key can go', async () => {
    const r = rotation();
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const seeded = await sealEverything(c, r.before);
    const http = await queuedHttpCall(c, owner, r.before);
    seeded.push(
      {
        kind: 'http_secret',
        table: 'app.http_secrets',
        column: 'value_ciphertext',
        id: http.secretId,
        plain: TOKEN,
        aad: httpSecretAad(c.tenant.id, http.secretId),
      },
      {
        kind: 'http_request',
        table: 'app.automation_http_calls',
        column: 'request_ciphertext',
        id: http.callId,
        plain: r.before.decryptString(http.request!, httpRequestAad(c.tenant.id, http.callId)),
        aad: httpRequestAad(c.tenant.id, http.callId),
      },
    );
    // A provider's webhook for the company, stored as the webhook route stores it.
    const rawBody = Buffer.from(
      JSON.stringify(fx.messagesBody(c, { messages: [{ waId: waId(), text: 'After rotation' }] })),
    );
    const { receiptId } = await storeWebhookReceipt(
      { db: fx.dbs.app, keyring: r.before, jobs: fx.jobs(), signer: fx.signer },
      { provider: 'meta_whatsapp', rawBody },
    );
    seeded.push({
      kind: 'provider_receipt',
      table: 'ops.webhook_receipts',
      column: 'body_ciphertext',
      id: receiptId,
      plain: rawBody.toString('utf8'),
      aad: receiptAad(receiptId),
    });
    const kinds = new Set(seeded.map((s) => s.kind));
    expect(kinds.size).toBe(15);
    for (const s of seeded) expect(keyOf(await storedValue(s)), s.kind).toBe(r.ids.old);

    const console = await ops(r.during).keyring(staff);
    expect(console.keys.find((k) => k.keyId === r.ids.old)).toEqual({
      keyId: r.ids.old,
      state: 'configured',
      sealed: seeded.length,
    });
    expect(console.keys.find((k) => k.keyId === r.ids.new)).toEqual({
      keyId: r.ids.new,
      state: 'primary',
      sealed: expect.any(Number),
    });
    expect(console.unused).not.toContain(r.ids.old);

    const times = await rowTimes(c);
    const done = await sweepUntilDone(r.during);
    expect(done).toMatchObject({ resealed: seeded.length, unopenable: 0 });

    for (const s of seeded) {
      const sealed = await storedValue(s);
      expect(keyOf(sealed), s.kind).toBe(r.ids.new);
      // A keyring without the old key opens it with the associated data its service uses.
      expect(r.after.decryptString(sealed!, s.aad), s.kind).toBe(s.plain);
    }
    // A re-encryption changes no value, so no row's time moved.
    expect(await rowTimes(c)).toEqual(times);

    const after = await ops(r.during).keyring(staff);
    expect(after.keys.find((k) => k.keyId === r.ids.old)).toEqual({
      keyId: r.ids.old,
      state: 'configured',
      sealed: 0,
    });
    expect(after.unused).toContain(r.ids.old);

    // The services open the re-encrypted values without the old key: the waiting call is made with
    // its secret, and the provider's webhook is processed.
    const before = received.length;
    expect(
      await processHttpCall(
        httpDeps(r.after),
        authorizedTenantScope(c.tenant.id, null),
        http.callId,
      ),
    ).toBe('succeeded');
    expect(received.length).toBe(before + 1);
    expect(received.at(-1)!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(received.at(-1)!.body)).toEqual({ customer: 'Priya Customer' });
    expect(
      await processMetaWebhookReceipt(
        {
          db: fx.dbs.app,
          keyring: r.after,
          clock: systemClock,
          jobs: fx.jobs(),
          signer: fx.signer,
        },
        receiptId,
      ),
    ).toBe('processed');
    const [message] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.messages m
        WHERE m.tenant_id = $1 AND m.content->>'text' = 'After rotation'`,
      [c.tenant.id],
    );
    expect(message!.n).toBe(1);
  });

  it('leaves a value a member replaced meanwhile as it is (compare and set)', async () => {
    const r = rotation();
    const c = await fx.company();
    const seeded = await sealSecret(c, r.before);
    const replacement = r.before.encrypt('replaced-by-member', seeded.aad);
    const holder = await fx.dbs.adminPool.connect();
    let outcome: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('UPDATE app.http_secrets SET value_ciphertext = $1 WHERE id = $2', [
        replacement,
        seeded.id,
      ]);
      const [lock] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      outcome = resealValue(
        { db: fx.dbs.app, keyring: r.during },
        { kind: 'http_secret', tenantId: c.tenant.id, id: seeded.id },
      );
      await vi.waitFor(
        async () => {
          const [waiting] = await fx.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity a WHERE $1 = ANY (pg_blocking_pids(a.pid))',
            [lock!.pid],
          );
          if (waiting!.n < 1) throw new Error('the re-encryption is not waiting');
        },
        { timeout: 4_000, interval: 20 },
      );
      await holder.query('COMMIT');
    } catch (error) {
      await holder.query('ROLLBACK');
      throw error;
    } finally {
      holder.release();
    }
    expect(await outcome).toEqual({ outcome: 'changed' });
    expect(await storedValue(seeded)).toBe(replacement);
    // The next sweep re-encrypts the member's value.
    await sweepUntilDone(r.during);
    expect(r.after.decryptString((await storedValue(seeded))!, seeded.aad)).toBe(
      'replaced-by-member',
    );
  });

  it('touches nothing of another company: a value is read and written in its own company only', async () => {
    const r = rotation();
    const a = await fx.company();
    const b = await fx.company();
    const secret = await sealSecret(a, r.before);
    expect(
      await resealValue(
        { db: fx.dbs.app, keyring: r.during },
        { kind: 'http_secret', tenantId: b.tenant.id, id: secret.id },
      ),
    ).toEqual({ outcome: 'changed' });
    expect(keyOf(await storedValue(secret))).toBe(r.ids.old);
    expect(
      await resealValue(
        { db: fx.dbs.app, keyring: r.during },
        { kind: 'http_secret', tenantId: a.tenant.id, id: secret.id },
      ),
    ).toEqual({ outcome: 'resealed' });
    const resealed = await storedValue(secret);
    expect(keyOf(resealed)).toBe(r.ids.new);
    // A value the primary key sealed already is left as it is.
    expect(
      await resealValue(
        { db: fx.dbs.app, keyring: r.during },
        { kind: 'http_secret', tenantId: a.tenant.id, id: secret.id },
      ),
    ).toEqual({ outcome: 'changed' });
    expect(await storedValue(secret)).toBe(resealed);
  });

  it("changes a store's webhook secret only by re-encrypting it, in the company in scope", async () => {
    const r = rotation();
    const a = await fx.company();
    const b = await fx.company();
    const woo = (await sealEverything(a, r.before)).find((s) => s.kind === 'store_webhook_secret')!;
    const old = (await storedValue(woo))!;
    const next = r.during.encrypt(woo.plain, woo.aad);
    const swap = (tenantId: string | null, oldValue: string, newValue: string) =>
      fx.dbs.app.run(tenantId ? authorizedTenantScope(tenantId, null) : systemScope, async (tx) => {
        const res = await tx.execute<{ swapped: boolean }>(
          sql`select app.reseal_store_webhook_secret(${woo.id}::uuid, ${oldValue}, ${newValue}) as swapped`,
        );
        return res.rows[0]!.swapped;
      });
    // The runtime role cannot write it directly.
    await expectCode(
      fx.dbs.app.run(authorizedTenantScope(a.tenant.id, null), (tx) =>
        tx.execute(
          sql`update app.commerce_stores set webhook_secret_ciphertext = ${next} where id = ${woo.id}`,
        ),
      ),
      'forbidden',
    );
    await expectCode(swap(null, old, next), 'forbidden');
    await expectCode(swap(a.tenant.id, old, 'not-sealed'), 'precondition_failed');
    await expectCode(swap(a.tenant.id, old, old), 'precondition_failed');
    expect(await swap(a.tenant.id, next, r.during.encrypt(woo.plain, woo.aad))).toBe(false);
    expect(await swap(b.tenant.id, old, next)).toBe(false);
    expect(await storedValue(woo)).toBe(old);
    expect(await swap(a.tenant.id, old, next)).toBe(true);
    expect(await storedValue(woo)).toBe(next);
  });

  it('reports a value that does not open once, leaves it as it is and stops after too many', async () => {
    const r = rotation();
    const c = await fx.company();
    const seeded = await sealEverything(c, r.before);
    const secret = seeded.find((s) => s.kind === 'http_secret')!;
    // Sealed with the old key, but for another row: its associated data does not match.
    const misplaced = r.before.encrypt('misplaced', httpSecretAad(c.tenant.id, uuidv7()));
    await fx.query('UPDATE app.http_secrets SET value_ciphertext = $1 WHERE id = $2', [
      misplaced,
      secret.id,
    ]);
    const state = newResealState();
    const first = await resealStoredValues(
      { db: fx.dbs.app, keyring: r.during, clock: systemClock },
      state,
    );
    expect(first.unopenable).toEqual([
      { kind: 'http_secret', tenantId: c.tenant.id, id: secret.id, reason: expect.any(String) },
    ]);
    expect(first.unopenable[0]!.reason).not.toContain('misplaced');
    expect(first.resealed).toBe(seeded.length - 1);
    expect(state.skip).toEqual(new Set([`http_secret:${secret.id}`]));
    const second = await resealStoredValues(
      { db: fx.dbs.app, keyring: r.during, clock: systemClock },
      state,
    );
    expect(second).toMatchObject({ resealed: 0, changed: 0, unopenable: [], stopped: false });
    expect(await storedValue(secret)).toBe(misplaced);

    // A worker that could not open RESEAL_SKIP_LIMIT values stops re-encrypting.
    const another = await sealSecret(c, r.before);
    const full: ResealState = {
      skip: new Set(Array.from({ length: RESEAL_SKIP_LIMIT }, (_, i) => `http_secret:${i}`)),
      idleUntil: 0,
    };
    const stopped = await resealStoredValues(
      { db: fx.dbs.app, keyring: r.during, clock: systemClock },
      full,
    );
    expect(stopped).toMatchObject({ resealed: 0, stopped: true });
    expect(keyOf(await storedValue(another))).toBe(r.ids.old);
  });

  it('does nothing while one key is configured, and waits an hour after finding nothing', async () => {
    const r = rotation();
    const c = await fx.company();
    const secret = await sealSecret(c, r.before);
    const alone = await resealStoredValues(
      { db: fx.dbs.app, keyring: r.before, clock: systemClock },
      newResealState(),
    );
    expect(alone).toMatchObject({ resealed: 0, changed: 0, unopenable: [], failed: [] });
    expect(keyOf(await storedValue(secret))).toBe(r.ids.old);

    const now = Date.now();
    const clock: Clock = { now: () => new Date(now) };
    const state = newResealState();
    await sweepUntilDone(r.during, state, clock);
    // The lookup that found nothing set the next one an hour later.
    expect(state.idleUntil).toBe(now + RESEAL_IDLE_MS);
    // A value an older server sealed meanwhile waits for that hour.
    const late = await sealSecret(c, r.before);
    const early = await resealStoredValues(
      { db: fx.dbs.app, keyring: r.during, clock: later(RESEAL_IDLE_MS / 2) },
      state,
    );
    expect(early.resealed).toBe(0);
    expect(keyOf(await storedValue(late))).toBe(r.ids.old);
    const due = await resealStoredValues(
      { db: fx.dbs.app, keyring: r.during, clock: later(RESEAL_IDLE_MS + 60_000) },
      state,
    );
    expect(due.resealed).toBeGreaterThan(0);
    expect(keyOf(await storedValue(late))).toBe(r.ids.new);
  });

  it('counts values by key for platform administrators only, and runs for the right roles', async () => {
    const r = rotation();
    const c = await fx.company();
    const seeded = await sealEverything(c, r.before);
    // A value sealed with a key that is no longer configured is counted, never looked up.
    const goneTag = randomBytes(4).toString('hex');
    const gone = new Keyring({
      primaryKeyId: `gone${goneTag}`,
      keys: { [`gone${goneTag}`]: randomBytes(32) },
    });
    const secret = seeded.find((s) => s.kind === 'http_secret')!;
    await fx.query('UPDATE app.http_secrets SET value_ciphertext = $1 WHERE id = $2', [
      gone.encrypt('gone', secret.aad),
      secret.id,
    ]);
    const overview = await ops(r.during).keyring(staff);
    expect(overview.primaryKeyId).toBe(r.ids.new);
    expect(overview.keys.find((k) => k.keyId === `gone${goneTag}`)).toEqual({
      keyId: `gone${goneTag}`,
      state: 'not_configured',
      sealed: 1,
    });
    expect(overview.keys.find((k) => k.keyId === r.ids.old)?.sealed).toBe(seeded.length - 1);
    expect(overview.kinds.find((k) => k.kind === 'http_secret')?.other).toBeGreaterThan(0);
    await sweepUntilDone(r.during);
    expect(keyOf(await storedValue(secret))).toBe(`gone${goneTag}`);

    const outsider = await createUser(fx.dbs, { twoFactor: true });
    await expectCode(
      ops(r.during).keyring({
        userId: outsider.id,
        role: 'platform_operator',
        correlationId: uuidv7(),
      }),
      'forbidden',
    );
    const can = async (role: string, fn: string) =>
      (
        await fx.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [
          role,
          fn,
        ])
      )[0]!.ok;
    const lookup = 'ops.sealed_values_to_reseal(text[],text[],integer)';
    const swap = 'app.reseal_store_webhook_secret(uuid,text,text)';
    const counts = 'ops.sealed_value_counts()';
    const keys = 'ops.sealed_value_keys()';
    for (const [role, fns] of [
      ['w360_app', [lookup, swap]],
      ['w360_platform', [counts]],
      ['w360_auth', []],
    ] as const) {
      for (const fn of [lookup, swap, counts, keys]) {
        expect(await can(role, fn), `${role} ${fn}`).toBe((fns as readonly string[]).includes(fn));
      }
    }
  });
});
