import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7 } from '@w360/core';
import { createEgressClient, DEFAULT_EGRESS_POLICY } from '@w360/core/egress';
import { authorizedTenantScope, sql, systemScope } from '@w360/db';
import {
  EXPORT_EXCLUDED_TABLES,
  EXPORT_FORMAT,
  EXPORT_TABLES,
  EXPORT_VERSION,
  MEMBER_ACCOUNT_COLUMNS,
  RazorpayClient,
  authorizeJob,
  createApiKeysService,
  createBillingService,
  createCompanyDeletionService,
  createContactsService,
  createGrowthService,
  createPlatformBillingService,
  createPlatformService,
  createStoreService,
  findDueTenantDeletions,
  outboxAad,
  processCreditRefund,
  processStoreJob,
  queueTextMessage,
  runTenantDeletion,
  writeCompanyExport,
  type DeletionRunDeps,
  type PlatformActor,
  type StoreWorkerDeps,
  type TenantContext,
} from '@w360/domain';
import { startRazorpayStandIn, type RazorpayStandIn } from '../support/razorpay-stand-in';
import { startShopifyStandIn, type ShopifyStandIn } from '../support/shopify-stand-in';
import { acceptInvitation, createTenant, createUser, invite, type TestUser } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Company export and deletion (P5-11, ADR-055) against real PostgreSQL and the test-only Graph,
 * Shopify and Razorpay stand-ins: the deletion order and coverage checked against the catalog,
 * the export's classification of every table and column, the export itself, requesting and
 * cancelling, the worker's runs (provider clean-up once, resumable batches, the tombstone and the
 * records kept), and the public lookups of a company waiting for deletion.
 */
const APP_BASE = 'http://127.0.0.1:3999';
const SHOPIFY_ID = 'w360clientid0002';
const SHOPIFY_SECRET = 'shopify-client-secret-'.padEnd(40, 'y');
const RZP_KEY_ID = 'rzp_test_StandIn00000002';
const RZP_KEY_SECRET = randomBytes(16).toString('hex');

/** Company tables that deletion keeps on purpose (ADR-055): billing, plan history, evidence. */
const KEPT = [
  'app.auto_recharge_attempts',
  'app.billing_customers',
  'app.credit_refunds',
  'app.ledger_accounts',
  'app.ledger_entries',
  'app.ledger_transactions',
  'app.payment_mandates',
  'app.tenant_plans',
  'app.topups',
  'app.wallet_holds',
  'app.wallets',
  'ops.security_events',
  'ops.settlement_recon_items',
  'ops.support_access_grants',
  'ops.tenant_deletions',
];

/** Columns that hold credentials, secrets or tokens: never in an export. */
const SECRET_COLUMNS = [
  'app.api_keys.token_hash',
  'app.automation_http_calls.request_ciphertext',
  'app.channel_accounts.registration_pin_ciphertext',
  'app.commerce_payment_accounts.key_secret_ciphertext',
  'app.commerce_payment_accounts.webhook_secret_ciphertext',
  'app.commerce_stores.access_code_ciphertext',
  'app.commerce_stores.connect_token_hash',
  'app.commerce_stores.credentials_ciphertext',
  'app.commerce_stores.webhook_secret_ciphertext',
  'app.flow_sends.token',
  'app.http_secrets.value_ciphertext',
  'app.invitations.token_hash',
  'app.webhook_endpoints.secret_ciphertext',
  'app.webhook_endpoints.previous_secret_ciphertext',
  'app.whatsapp_accounts.credential_ciphertext',
];

let fx: WhatsAppFixture;
let shopify: ShopifyStandIn;
let rzp: RazorpayStandIn;
let razorpay: RazorpayClient;
let staff: PlatformActor;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  shopify = await startShopifyStandIn({ clientId: SHOPIFY_ID, clientSecret: SHOPIFY_SECRET });
  rzp = await startRazorpayStandIn({ keyId: RZP_KEY_ID, keySecret: RZP_KEY_SECRET });
  razorpay = new RazorpayClient({
    baseUrl: rzp.baseUrl,
    keyId: RZP_KEY_ID,
    keySecret: RZP_KEY_SECRET,
    timeoutMs: 2_000,
  });
  const user = await createUser(fx.dbs, { twoFactor: true });
  await fx.dbs.ownerPool.query(
    `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_operator')`,
    [user.id],
  );
  staff = { userId: user.id, role: 'platform_operator', correlationId: uuidv7() };
});
afterAll(async () => {
  await rzp?.close();
  await shopify?.close();
  await fx?.close();
});

const outbox = () => ({ keyring: fx.keyring, jobs: fx.jobs(), signer: fx.signer });
const serviceDeps = () => ({
  ...outbox(),
  db: fx.dbs.app,
  clock: systemClock,
  appBaseUrl: APP_BASE,
});
const deletions = () => createCompanyDeletionService(serviceDeps());
const shopifyConfig = () => ({
  clientId: SHOPIFY_ID,
  clientSecret: SHOPIFY_SECRET,
  secrets: [SHOPIFY_SECRET],
  apiVersion: '2026-07',
  testBaseUrl: shopify.baseUrl,
});
const storeWorkerDeps = (): StoreWorkerDeps => ({
  ...outbox(),
  db: fx.dbs.app,
  clock: systemClock,
  egress: createEgressClient({
    ...DEFAULT_EGRESS_POLICY,
    allowLoopbackForTests: true,
    maxResponseBytes: 4 << 20,
  }),
  shopify: shopifyConfig(),
  appBaseUrl: APP_BASE,
});
const runDeps = (overrides: Partial<DeletionRunDeps> = {}): DeletionRunDeps => ({
  ...outbox(),
  db: fx.dbs.app,
  clock: systemClock,
  graph: fx.graph,
  razorpay,
  stores: storeWorkerDeps(),
  ...overrides,
});
const platform = () =>
  createPlatformService({ db: fx.dbs.app, platformDb: fx.dbs.platform, clock: systemClock });

async function expectAppError(promise: Promise<unknown>, code: string, message?: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe(code);
      if (message) expect(error.publicMessage).toMatch(message);
    }
    return;
  }
  throw new Error(`expected ${code}`);
}

async function member(c: Company, role: string, name = `A ${role}`): Promise<TestUser> {
  const user = await createUser(fx.dbs, { name });
  const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, [role]);
  await acceptInvitation(fx.dbs, user, token);
  return user;
}

const base32 = (length: number) =>
  Array.from({ length }, () => 'abcdefghijklmnopqrstuvwxyz234567'[randomInt(32)]).join('');
const waId = () => `91${randomInt(7_000_000_000, 9_999_999_999)}`;

/** Every table with a tenant_id column, schema-qualified, sorted. */
async function companyTables(): Promise<string[]> {
  const rows = await fx.query<{ t: string }>(
    `SELECT c.oid::regclass::text AS t
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname IN ('app', 'ops', 'auth')
        AND EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      ORDER BY 1`,
  );
  return rows.map((r) => r.t);
}

async function stepTables(): Promise<string[]> {
  const rows = await fx.query<{ t: string }>(
    `SELECT t::text AS t FROM ops.tenant_deletion_steps s, unnest(s.tables) t ORDER BY s.ordinal`,
  );
  return rows.map((r) => r.t);
}

async function rowCounts(tenantId: string, tables: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const [row] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
      [tenantId],
    );
    counts[table] = row!.n;
  }
  return counts;
}

async function tenantRow(tenantId: string) {
  const [row] = await fx.query<{
    status: string;
    name: string;
    slug: string;
    status_reason: string;
  }>('SELECT status, name, slug, status_reason FROM app.tenants WHERE id = $1', [tenantId]);
  return row!;
}

async function deletionRow(tenantId: string) {
  const [row] = await fx.query<Record<string, unknown>>(
    'SELECT * FROM ops.tenant_deletions WHERE tenant_id = $1 ORDER BY requested_at DESC LIMIT 1',
    [tenantId],
  );
  return row;
}

/** Moves the company's open deletion into the past, as if the 14 days had gone by. */
async function makeDue(tenantId: string) {
  await fx.query(
    `UPDATE ops.tenant_deletions SET due_at = now() - interval '1 minute'
      WHERE tenant_id = $1 AND cancelled_at IS NULL AND completed_at IS NULL`,
    [tenantId],
  );
}

/** Emails queued with a dedupe key or for a company, decrypted. */
async function emails(where: { tenantId?: string; dedupePrefix?: string }) {
  const rows = await fx.query<{
    id: string;
    tenant_id: string | null;
    to_address: string;
    kind: string;
    dedupe_key: string | null;
    payload_ciphertext: string;
  }>(
    `SELECT id, tenant_id, to_address, kind, dedupe_key, payload_ciphertext FROM ops.email_outbox
      WHERE ($1::uuid IS NULL OR tenant_id = $1) AND ($2::text IS NULL OR dedupe_key LIKE $2 || '%')
      ORDER BY created_at, id`,
    [where.tenantId ?? null, where.dedupePrefix ?? null],
  );
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    to: r.to_address,
    kind: r.kind,
    dedupeKey: r.dedupe_key,
    payload: JSON.parse(fx.keyring.decryptString(r.payload_ciphertext, outboxAad(r.id))) as {
      kind: string;
      subject?: string;
      lines?: string[];
    },
  }));
}

async function auditActions(tenantId: string): Promise<string[]> {
  const rows = await fx.query<{ action: string }>(
    'SELECT action FROM app.audit_events WHERE tenant_id = $1 ORDER BY occurred_at, id',
    [tenantId],
  );
  return rows.map((r) => r.action);
}

async function exportText(ctx: TenantContext): Promise<string> {
  let text = '';
  await writeCompanyExport(serviceDeps(), ctx, async (chunk) => {
    text += chunk;
  });
  return text;
}

/** A company with conversations, a sent reply, an API key and a chat link. */
async function busyCompany() {
  const c = await fx.company();
  const owner = await fx.ctx(c, c.owner);
  const agent = await fx.ctx(c, c.agent);
  const customer = waId();
  await fx.deliver(
    fx.messagesBody(c, { messages: [{ waId: customer, text: 'Where is my order?' }] }),
  );
  await fx.deliver(fx.messagesBody(c, { messages: [{ waId: waId(), text: 'Hello there' }] }));
  const [conv] = await fx.query<{ id: string }>(
    `SELECT cv.id FROM app.conversations cv JOIN app.contacts ct
        ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contact_id
      WHERE cv.tenant_id = $1 AND ct.phone_e164 = $2`,
    [c.tenant.id, `+${customer}`],
  );
  await queueTextMessage(
    { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock },
    agent,
    { conversationId: conv!.id, text: 'It ships today', clientKey: `ck_${uuidv7()}` },
  );
  const apiKey = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(owner, {
    name: 'Order system',
    scopes: ['contacts.read'],
    expiresInDays: 30,
  });
  await createGrowthService({ db: fx.dbs.app, clock: systemClock }).createLink(owner, {
    name: 'Instagram bio',
    channelAccountId: c.channelAccountId,
    message: 'Hello from Instagram',
    includeRef: true,
  });
  return { c, owner, agent, customer, apiKey };
}

/** Connects a Shopify store through the stand-in's signed handshake and reads it once. */
async function connectShopify(c: Company, owner: TenantContext) {
  const shop = `deletion-${Date.now().toString(36)}-${randomInt(1000)}.myshopify.com`;
  shopify.addShop(shop, { name: 'Tea House', currency: 'INR' });
  const stores = createStoreService({
    ...outbox(),
    db: fx.dbs.app,
    clock: systemClock,
    appBaseUrl: APP_BASE,
    shopify: shopifyConfig(),
    allowHttpStores: true,
  });
  const { url } = await stores.startShopifyConnect(owner, { shop, callingCode: '91' });
  const redirect = await fetch(url, { redirect: 'manual' });
  const callback = new URL(redirect.headers.get('location') ?? '');
  const checked = await stores.shopifyCallback(callback.searchParams);
  if (!checked.ok) throw new Error(`callback refused: ${checked.reason}`);
  const { storeId } = await stores.acceptShopifyApproval(owner, checked);
  for (let i = 0; i < 40; i += 1) {
    const outcome = await processStoreJob(
      storeWorkerDeps(),
      authorizedTenantScope(c.tenant.id, null),
      storeId,
    );
    if (outcome !== 'continuing' && outcome !== 'connected') break;
  }
  const [store] = await fx.query<{ state: string }>(
    'SELECT state FROM app.commerce_stores WHERE id = $1',
    [storeId],
  );
  expect(store!.state).toBe('connected');
  expect(shopify.shops.get(shop)!.installed).toBe(true);
  return { shop, storeId };
}

const billingService = () =>
  createBillingService({
    db: fx.dbs.app,
    clock: systemClock,
    razorpay,
    razorpayConfig: {
      keyId: RZP_KEY_ID,
      keySecret: RZP_KEY_SECRET,
      webhookSecrets: [randomBytes(16).toString('hex')],
      recurringCardsEnabled: true,
      apiBaseUrl: rzp.baseUrl,
      mode: 'test',
    },
    notices: { outbox: outbox(), appBaseUrl: APP_BASE },
  });

/** Registers HyFib's card mandate through the Razorpay stand-in (₹1 authorisation). */
async function addCardMandate(owner: TenantContext) {
  const billing = billingService();
  const setup = await billing.startMandateSetup(owner, {
    maxAmountMinor: 1_500_000,
    email: 'billing@example.test',
    contact: '+91 90000 00001',
  });
  const payment = rzp.pay(setup.orderId);
  const signature = createHmac('sha256', RZP_KEY_SECRET)
    .update(`${setup.orderId}|${payment.id}`)
    .digest('hex');
  await billing.confirmMandateCheckout(owner, {
    mandateId: setup.mandateId,
    paymentId: payment.id,
    signature,
  });
  const [mandate] = await fx.query<{ status: string; provider_token_id: string }>(
    'SELECT status, provider_token_id FROM app.payment_mandates WHERE id = $1',
    [setup.mandateId],
  );
  expect(mandate!.status).toBe('active');
  return { mandateId: setup.mandateId, tokenId: mandate!.provider_token_id };
}

describe('what a deletion deletes', () => {
  it('deletes every company table except the records kept on purpose, each once', async () => {
    const steps = await stepTables();
    expect(new Set(steps).size).toBe(steps.length);
    expect([...steps, ...KEPT].sort()).toEqual(await companyTables());
  });

  it('deletes children before their parents and keeps nothing that points at deleted rows', async () => {
    const keys = await fx.query<{
      name: string;
      child: string;
      parent: string;
      child_step: number | null;
      parent_step: number | null;
      child_mode: string | null;
    }>(
      `WITH steps AS (SELECT s.ordinal, s.mode, unnest(s.tables) AS t FROM ops.tenant_deletion_steps s)
       SELECT c.conname AS name, c.conrelid::regclass::text AS child,
              c.confrelid::regclass::text AS parent, cs.ordinal AS child_step,
              ps.ordinal AS parent_step, cs.mode AS child_mode
         FROM pg_constraint c
         LEFT JOIN steps cs ON cs.t = c.conrelid
         LEFT JOIN steps ps ON ps.t = c.confrelid
        WHERE c.contype = 'f' AND (cs.t IS NOT NULL OR ps.t IS NOT NULL)`,
    );
    const wrong = keys.filter((k) => {
      if (k.parent_step === null) return false; // the parent is kept, or not a company table
      if (k.child_step === null) return true; // a kept row would point at a deleted one
      if (k.child_step === k.parent_step) return k.child_mode !== 'whole';
      return k.child_step > k.parent_step;
    });
    expect(wrong).toEqual([]);
    expect(
      keys.filter((k) => k.child_step !== null && k.parent_step !== null).length,
    ).toBeGreaterThan(100);
  });

  it('lets the deletion functions read and delete only the rows of the company being deleted', async () => {
    const missing = await fx.query<{ t: string }>(
      `SELECT t::text AS t FROM ops.tenant_deletion_steps s, unnest(s.tables) t
        WHERE (SELECT count(*) FROM pg_policy p
                WHERE p.polrelid = t AND p.polname IN ('tenant_deletion_read', 'tenant_deletion_delete')
                  AND p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'w360_definer')]
                  AND pg_get_expr(p.polqual, p.polrelid) LIKE '%deleting_tenant_id()%') <> 2`,
    );
    expect(missing).toEqual([]);
    // The functions refuse a company that is not being deleted, and one whose run has not started.
    const active = await fx.company();
    const pending = await fx.company();
    await deletions().request(await fx.ctx(pending, pending.owner), {
      confirm: pending.tenant.slug,
    });
    for (const tenantId of [active.tenant.id, pending.tenant.id]) {
      await expect(
        fx.dbs.app.run(systemScope, (tx) =>
          tx.execute(sql`select * from ops.delete_tenant_data(${tenantId}::uuid, 100)`),
        ),
      ).rejects.toThrow(/No started deletion/);
      await expect(
        fx.dbs.app.run(systemScope, (tx) =>
          tx.execute(sql`select ops.finish_tenant_deletion(${tenantId}::uuid)`),
        ),
      ).rejects.toThrow(/not being deleted|No started deletion/);
    }
    await expect(
      fx.dbs.app.run(systemScope, (tx) =>
        tx.execute(sql`select * from ops.start_tenant_deletion(${pending.tenant.id}::uuid)`),
      ),
    ).rejects.toThrow(/not due yet/);
    expect(await rowCounts(active.tenant.id, ['app.memberships'])).toEqual({
      'app.memberships': 3,
    });
  });
});

describe('what an export contains', () => {
  it('classifies every company table and column and never exports a secret', async () => {
    const exported = EXPORT_TABLES.map((spec) => spec.table);
    expect(new Set(exported).size).toBe(exported.length);
    expect([...exported, ...Object.keys(EXPORT_EXCLUDED_TABLES)].sort()).toEqual(
      await companyTables(),
    );
    for (const spec of EXPORT_TABLES) {
      const [schema, name] = spec.table.split('.');
      const columns = await fx.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 AND column_name <> 'tenant_id'`,
        [schema, name],
      );
      const classified = [...spec.columns, ...Object.keys(spec.omitted ?? {})];
      expect(new Set(classified).size, spec.table).toBe(classified.length);
      expect(classified.sort(), spec.table).toEqual(columns.map((c) => c.column_name).sort());
      expect(spec.columns, spec.table).not.toContain('tenant_id');
      for (const column of spec.columns) {
        expect(SECRET_COLUMNS, `${spec.table}.${column}`).not.toContain(`${spec.table}.${column}`);
        expect(column, `${spec.table}.${column}`).not.toMatch(
          /ciphertext|token_hash|password|access_code|registration_pin|^token$|^secret$/,
        );
      }
      // The runtime role (which runs the export) can read every exported column, through a policy.
      const unreadable = await fx.query<{ c: string }>(
        `SELECT c FROM unnest($2::text[]) AS c
          WHERE NOT has_column_privilege('w360_app', $1::regclass, c, 'SELECT')`,
        [spec.table, spec.columns],
      );
      expect(unreadable, spec.table).toEqual([]);
      const [policy] = await fx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_policies
          WHERE schemaname = $1 AND tablename = $2 AND cmd IN ('SELECT', 'ALL')
            AND 'w360_app' = ANY (roles)`,
        [schema, name],
      );
      expect(policy!.n, spec.table).toBeGreaterThan(0);
    }
    for (const secret of SECRET_COLUMNS) {
      const table = secret.split('.').slice(0, 2).join('.');
      const column = secret.split('.')[2]!;
      const spec = EXPORT_TABLES.find((s) => s.table === table);
      expect(spec?.omitted?.[column], secret).toBeTruthy();
    }
  });

  it('streams the whole company as JSON Lines, from one moment, without secrets or other companies', async () => {
    const { c, owner, customer, apiKey } = await busyCompany();
    const admin = await member(c, 'admin', 'Admin Person');
    const other = await busyCompany();
    const text = await exportText(owner);
    expect(text.endsWith('\n')).toBe(true);
    const lines = text
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const header = lines[0]!;
    expect(header).toMatchObject({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      company: { id: c.tenant.id, slug: c.tenant.slug, timezone: 'Asia/Kolkata' },
      tables: EXPORT_TABLES.map((s) => s.table),
    });
    const end = lines.at(-1)!;
    expect(end.end).toBe(true);
    const rows = lines.slice(1, -1) as { table: string; row: Record<string, unknown> }[];
    // Counts match the lines, and each row has exactly the spec's columns.
    const counted: Record<string, number> = {};
    for (const { table, row } of rows) {
      counted[table] = (counted[table] ?? 0) + 1;
      const spec = EXPORT_TABLES.find((s) => s.table === table)!;
      const expected =
        table === 'app.memberships' ? [...spec.columns, ...MEMBER_ACCOUNT_COLUMNS] : spec.columns;
      expect(Object.keys(row).sort(), table).toEqual([...expected].sort());
    }
    const counts = end.counts as Record<string, number>;
    expect(Object.keys(counts).sort()).toEqual(EXPORT_TABLES.map((s) => s.table).sort());
    for (const [table, n] of Object.entries(counts)) expect(counted[table] ?? 0, table).toBe(n);

    const of = (table: string) => rows.filter((r) => r.table === table).map((r) => r.row);
    expect(
      of('app.memberships')
        .map((m) => m.user_email)
        .sort(),
    ).toEqual([c.owner.email, c.agent.email, c.marketer.email, admin.email].sort());
    expect(of('app.contacts').map((ct) => ct.phone_e164)).toContain(`+${customer}`);
    expect(of('app.messages').length).toBeGreaterThanOrEqual(3);
    expect(of('app.api_keys')).toHaveLength(1);
    expect(of('app.chat_links')).toHaveLength(1);
    expect(of('app.whatsapp_accounts')[0]).toMatchObject({ waba_id: c.wabaId });

    // Nothing of the other company, no tenant ids as fields, and no credentials.
    expect(text).not.toContain(other.c.tenant.id);
    expect(text).not.toContain(other.customer);
    expect(text).not.toContain('"tenant_id"');
    expect(text).not.toContain(c.token);
    expect(text).not.toContain(apiKey.token);
    const [hash] = await fx.query<{ token_hash: string }>(
      'SELECT token_hash FROM app.api_keys WHERE id = $1',
      [apiKey.id],
    );
    expect(text).not.toContain(hash!.token_hash);
    const [credential] = await fx.query<{ credential_ciphertext: string }>(
      'SELECT credential_ciphertext FROM app.whatsapp_accounts WHERE id = $1',
      [c.whatsappAccountId],
    );
    expect(text).not.toContain(credential!.credential_ciphertext);

    // Audited, and every owner and administrator is told.
    expect(await auditActions(c.tenant.id)).toContain('tenant.exported');
    const told = (await emails({ tenantId: c.tenant.id })).filter(
      (e) => e.payload.subject === 'Company data exported',
    );
    expect(told.map((e) => e.to).sort()).toEqual([c.owner.email, admin.email].sort());
    expect(told[0]!.payload.lines?.[0]).toMatch(/started downloading a full export/);
  });

  it('is for owners only, one at a time, and still available while the company waits for deletion', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const adminUser = await member(c, 'admin');
    await expectAppError(exportText(await fx.ctx(c, adminUser)), 'forbidden');
    await expectAppError(exportText(await fx.ctx(c, c.agent)), 'forbidden');

    // A second export while one runs is refused.
    const client = await fx.dbs.adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `company-export:${c.tenant.id}`,
      ]);
      await expectAppError(exportText(owner), 'conflict', /already running/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(await exportText(owner)).toContain('"end":true');

    await deletions().request(owner, { confirm: c.tenant.slug });
    const waiting = await fx.ctx(c, c.owner);
    expect(waiting.tenant.status).toBe('pending_deletion');
    const text = await exportText(waiting);
    expect(text).toContain(`"slug":"${c.tenant.slug}"`);
    expect(text.trimEnd().split('\n').at(-1)).toMatch(/^\{"end":true/);
  });
});

describe('asking for a deletion', () => {
  it('needs an owner typing the company address, suspends the company and tells owners and administrators', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const adminUser = await member(c, 'admin', 'Admin Person');
    const admin = await fx.ctx(c, adminUser);

    await expectAppError(deletions().request(admin, { confirm: c.tenant.slug }), 'forbidden');
    await expectAppError(deletions().cancel(admin), 'forbidden');
    // Even through the database function, only an owner can ask.
    await expect(
      fx.dbs.app.run(authorizedTenantScope(c.tenant.id, adminUser.id), (tx) =>
        tx.execute(sql`select * from app.request_tenant_deletion(${c.tenant.slug})`),
      ),
    ).rejects.toThrow(/Only an owner/);
    await expectAppError(
      deletions().request(owner, { confirm: 'not-the-slug' }),
      'precondition_failed',
      /company address exactly/,
    );
    await expectAppError(deletions().request(owner, { confirm: '' }), 'validation_failed');
    expect(await deletions().status(owner)).toBeNull();

    const before = Date.now();
    const { deletionId, dueAt } = await deletions().request(owner, {
      confirm: `  ${c.tenant.slug} `,
    });
    const days = (dueAt.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(13.99);
    expect(days).toBeLessThan(14.01);
    expect(await tenantRow(c.tenant.id)).toMatchObject({ status: 'pending_deletion' });
    expect(await deletionRow(c.tenant.id)).toMatchObject({
      id: deletionId,
      requested_by_user_id: c.owner.id,
      previous_status: 'active',
      started_at: null,
      cancelled_at: null,
    });
    expect(await auditActions(c.tenant.id)).toContain('tenant.deletion_requested');
    const told = await emails({ dedupePrefix: `tenant-deletion:${deletionId}:requested:` });
    expect(told.map((e) => e.to).sort()).toEqual([c.owner.email, adminUser.email].sort());
    expect(told[0]!.payload.subject).toBe('Company deletion scheduled');

    // The company now works as if suspended: reading and exporting only.
    const waiting = await fx.ctx(c, c.owner);
    expect(await deletions().status(waiting)).toMatchObject({
      id: deletionId,
      started: false,
      requestedByName: c.owner.name,
    });
    await expectAppError(
      createContactsService({ db: fx.dbs.app, clock: systemClock }).createContact(waiting, {
        phone: '+919812300001',
      }),
      'tenant_suspended',
      /being deleted/,
    );
    await expectAppError(
      deletions().request(waiting, { confirm: c.tenant.slug }),
      'precondition_failed',
      /already being deleted/,
    );
    expect(await findDueTenantDeletions(fx.dbs.app, 100)).not.toContain(c.tenant.id);
    await makeDue(c.tenant.id);
    expect(await findDueTenantDeletions(fx.dbs.app, 100)).toContain(c.tenant.id);
  });

  it('can be cancelled until it starts, bringing back the company’s own status', async () => {
    // An active company becomes active again.
    const a = await fx.company();
    const ownerA = await fx.ctx(a, a.owner);
    await deletions().request(ownerA, { confirm: a.tenant.slug });
    expect(await deletions().cancel(await fx.ctx(a, a.owner))).toEqual({ status: 'active' });
    expect(await tenantRow(a.tenant.id)).toMatchObject({ status: 'active', status_reason: null });
    expect(await deletionRow(a.tenant.id)).toMatchObject({ cancelled_by_user_id: a.owner.id });
    expect(await auditActions(a.tenant.id)).toContain('tenant.deletion_cancelled');
    expect((await emails({ tenantId: a.tenant.id })).map((e) => e.payload.subject)).toContain(
      'Company deletion cancelled',
    );
    await expectAppError(deletions().cancel(await fx.ctx(a, a.owner)), 'precondition_failed');
    expect(await deletions().status(await fx.ctx(a, a.owner))).toBeNull();
    // It can be asked for again later.
    await deletions().request(await fx.ctx(a, a.owner), { confirm: a.tenant.slug });
    expect(await tenantRow(a.tenant.id)).toMatchObject({ status: 'pending_deletion' });

    // A company HyFib suspended stays suspended, with HyFib's reason.
    const s = await fx.company();
    await fx.query(
      `UPDATE app.tenants SET status = 'suspended', status_reason = 'Unpaid invoices from last year.'
        WHERE id = $1`,
      [s.tenant.id],
    );
    await deletions().request(await fx.ctx(s, s.owner), { confirm: s.tenant.slug });
    expect(await deletions().cancel(await fx.ctx(s, s.owner))).toEqual({ status: 'suspended' });
    expect(await tenantRow(s.tenant.id)).toMatchObject({
      status: 'suspended',
      status_reason: 'Unpaid invoices from last year.',
    });

    // A company whose plan ended while it waited is restricted.
    const r = await fx.company();
    await deletions().request(await fx.ctx(r, r.owner), { confirm: r.tenant.slug });
    const planId = uuidv7();
    await fx.query(
      `INSERT INTO ops.plans (id, code, version, name, price_minor, interval_months,
         seats_included, numbers_included, created_by_user_id, status, published_at,
         published_by_user_id)
       VALUES ($1, $2, 1, 'Lapsed plan', 0, 1, 5, 1, $3, 'published', now(), $3)`,
      [planId, `lapsed-${randomInt(1_000_000)}`, staff.userId],
    );
    await fx.query(
      `UPDATE app.tenant_plans SET status = 'expired', plan_id = $2 WHERE tenant_id = $1`,
      [r.tenant.id, planId],
    );
    expect(await deletions().cancel(await fx.ctx(r, r.owner))).toEqual({ status: 'restricted' });
    expect(await tenantRow(r.tenant.id)).toMatchObject({ status: 'restricted' });

    // Once the worker has started, it can no longer be cancelled.
    const started = await fx.company();
    await deletions().request(await fx.ctx(started, started.owner), {
      confirm: started.tenant.slug,
    });
    await makeDue(started.tenant.id);
    await fx.dbs.app.run(systemScope, (tx) =>
      tx.execute(sql`select * from ops.start_tenant_deletion(${started.tenant.id}::uuid)`),
    );
    const waiting = await fx.ctx(started, started.owner);
    expect(await deletions().status(waiting)).toMatchObject({ started: true });
    await expectAppError(deletions().cancel(waiting), 'precondition_failed', /can no longer/);
    expect(await tenantRow(started.tenant.id)).toMatchObject({ status: 'pending_deletion' });
  });
});

describe('running a deletion', () => {
  it('does nothing before the deletion is due, or after it was cancelled', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    expect(await runTenantDeletion(runDeps(), c.tenant.id)).toEqual({ outcome: 'not_due' });
    await deletions().request(owner, { confirm: c.tenant.slug });
    expect(await runTenantDeletion(runDeps(), c.tenant.id)).toEqual({ outcome: 'not_due' });
    expect(await deletionRow(c.tenant.id)).toMatchObject({ started_at: null, attempts: 0 });
    await deletions().cancel(await fx.ctx(c, c.owner));
    await makeDue(c.tenant.id);
    expect(await runTenantDeletion(runDeps(), c.tenant.id)).toEqual({ outcome: 'not_due' });
    expect(await tenantRow(c.tenant.id)).toMatchObject({ status: 'active' });
    expect(fx.standIn.state.requests.filter((r) => r.path.includes(c.wabaId))).toEqual([]);
  });

  it('waits for a refund of service credit in progress, and no refund starts once deletion is asked for', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const billing = billingService();
    const topup = await billing.startTopup(owner, { amountMinor: 50_000 });
    const payment = rzp.pay(topup.orderId);
    await billing.confirmTopupCheckout(owner, {
      topupId: topup.topupId,
      paymentId: payment.id,
      signature: createHmac('sha256', RZP_KEY_SECRET)
        .update(`${topup.orderId}|${payment.id}`)
        .digest('hex'),
    });
    const platformOwner = await createUser(fx.dbs, { twoFactor: true });
    await fx.dbs.ownerPool.query(
      `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_owner')`,
      [platformOwner.id],
    );
    const actor: PlatformActor = {
      userId: platformOwner.id,
      role: 'platform_owner',
      correlationId: uuidv7(),
    };
    const refunds = createPlatformBillingService({ platformDb: fx.dbs.platform });
    const ask = {
      tenantId: c.tenant.id,
      topupId: topup.topupId,
      reason: 'Leaving HyFib, ticket 4471',
    };
    const { refundId } = await refunds.requestRefund(actor, { ...ask, amount: '100' });
    const scope = authorizedTenantScope(c.tenant.id, null);
    const refundDeps = {
      db: fx.dbs.app,
      razorpay,
      clock: systemClock,
      notices: { outbox: outbox(), appBaseUrl: APP_BASE },
    };
    rzp.state.refundStatusOnCreate = 'pending';
    try {
      expect(await processCreditRefund(refundDeps, scope, refundId)).toBe('submitted');
    } finally {
      rzp.state.refundStatusOnCreate = 'processed';
    }

    await deletions().request(owner, { confirm: c.tenant.slug });
    await makeDue(c.tenant.id);
    await expectAppError(
      refunds.requestRefund(actor, { ...ask, amount: '50' }),
      'precondition_failed',
      /being deleted/,
    );
    expect(await runTenantDeletion(runDeps(), c.tenant.id)).toEqual({
      outcome: 'waiting_for_refund',
    });
    expect(await deletionRow(c.tenant.id)).toMatchObject({ started_at: null, attempts: 0 });
    expect(await tenantRow(c.tenant.id)).toMatchObject({ status: 'pending_deletion' });

    // Razorpay completes the refund; the deletion then runs and keeps the refund record.
    const refund = [...rzp.state.refunds.values()].find(
      (r) => r.idempotencyKey === `crf_${refundId}`,
    );
    rzp.setRefundStatus(refund!.id, 'processed');
    expect(await processCreditRefund(refundDeps, scope, refundId)).toBe('processed');
    expect((await runTenantDeletion(runDeps(), c.tenant.id)).outcome).toBe('finished');
    const [kept] = await fx.query<{ status: string; amount_minor: number }>(
      'SELECT status, amount_minor::int AS amount_minor FROM app.credit_refunds WHERE id = $1',
      [refundId],
    );
    expect(kept).toEqual({ status: 'processed', amount_minor: 10_000 });
    expect(await tenantRow(c.tenant.id)).toMatchObject({ status: 'deleted' });
    await expectAppError(
      refunds.requestRefund(actor, { ...ask, amount: '50' }),
      'precondition_failed',
      /being deleted/,
    );
  });

  it('removes HyFib from the providers, deletes every company row, keeps the records and leaves a tombstone', async () => {
    const { c, owner } = await busyCompany();
    const adminUser = await member(c, 'admin', 'Admin Person');
    const { shop } = await connectShopify(c, owner);
    const { tokenId } = await addCardMandate(owner);
    const other = await busyCompany();
    const tables = await companyTables();
    const otherBefore = await rowCounts(other.c.tenant.id, tables);

    const { deletionId } = await deletions().request(owner, { confirm: c.tenant.slug });
    await makeDue(c.tenant.id);
    const before = await rowCounts(c.tenant.id, tables);
    expect(before['app.messages']).toBeGreaterThanOrEqual(3);
    expect(before['app.commerce_stores']).toBe(1);
    expect(before['app.payment_mandates']).toBe(1);

    const result = await runTenantDeletion(runDeps(), c.tenant.id);
    expect(result.outcome).toBe('finished');
    if (result.outcome !== 'finished') return;
    expect(result.cleanup).toEqual([
      {
        kind: 'whatsapp_account',
        label: `WhatsApp account Main account (${c.wabaId})`,
        outcome: 'done',
      },
      { kind: 'shopify_store', label: shop, outcome: 'done' },
      { kind: 'card_mandate', label: 'Card Visa •••• 1111', outcome: 'done' },
    ]);

    // Every deletable row is gone; the kept records are all still there.
    const after = await rowCounts(c.tenant.id, tables);
    for (const table of await stepTables()) expect(after[table], table).toBe(0);
    for (const table of KEPT) expect(after[table], table).toBe(before[table]);
    expect(before['app.tenant_plans']).toBe(1);
    expect(before['app.billing_customers']).toBe(1);
    const [mandate] = await fx.query<{ status: string }>(
      'SELECT status FROM app.payment_mandates WHERE tenant_id = $1',
      [c.tenant.id],
    );
    expect(mandate!.status).toBe('cancelled');
    // The company row is a tombstone and its address is free again.
    const tombstone = await tenantRow(c.tenant.id);
    expect(tombstone).toMatchObject({
      status: 'deleted',
      name: 'Deleted company',
      slug: `deleted-${c.tenant.id.replace(/-/g, '')}`,
    });
    expect(await deletionRow(c.tenant.id)).toMatchObject({
      id: deletionId,
      attempts: 1,
      rows_deleted: String(result.rowsDeleted),
      provider_cleanup: result.cleanup,
    });
    expect(result.rowsDeleted).toBeGreaterThan(20);

    // Providers were each called once: Meta stops sending events, Shopify uninstalls, the card
    // token is deleted.
    const unsubscribed = fx.standIn.state.requests.filter(
      (r) => r.method === 'DELETE' && r.path === `/v26.0/${c.wabaId}/subscribed_apps`,
    );
    expect(unsubscribed).toHaveLength(1);
    expect(unsubscribed[0]!.authorization).toBe(`Bearer ${c.token}`);
    expect(shopify.shops.get(shop)!.installed).toBe(false);
    expect(rzp.state.tokens.get(tokenId)!.deleted).toBe(true);

    // Owners and administrators at the start get the final email (not about the company's rows).
    const told = await emails({ dedupePrefix: `tenant-deletion:${deletionId}:finished:` });
    expect(told.map((e) => e.to).sort()).toEqual([c.owner.email, adminUser.email].sort());
    expect(told.every((e) => e.tenantId === null && e.payload.subject === 'Company deleted')).toBe(
      true,
    );

    // The other company is untouched.
    expect(await rowCounts(other.c.tenant.id, tables)).toEqual(otherBefore);

    // Afterwards: nothing more to run, jobs for it are refused, members lose it, the address can
    // be taken, and its number's events are no longer routed to it.
    expect(await runTenantDeletion(runDeps(), c.tenant.id)).toEqual({ outcome: 'not_due' });
    const auth = await authorizeJob(
      { db: fx.dbs.app, signer: fx.signer },
      fx.signer.sign({
        kind: 'tenant.delete',
        tenantId: c.tenant.id,
        actorUserId: null,
        ref: c.tenant.id,
      }),
      { expectedKind: 'tenant.delete', requireActiveTenant: false, requireActiveActor: false },
    );
    expect(auth).toMatchObject({ outcome: 'rejected', reason: 'tenant_missing' });
    await expect(fx.ctx(c, c.owner)).rejects.toSatisfy(isAppError);
    const reuser = await createUser(fx.dbs);
    const reused = await createTenant(fx.dbs, reuser, c.tenant.slug);
    expect(reused.slug).toBe(c.tenant.slug);
    const { receiptId } = await fx.deliver(
      fx.messagesBody(c, { messages: [{ waId: waId(), text: 'Anyone there?' }] }),
    );
    const [quarantined] = await fx.query<{ reason: string }>(
      'SELECT reason FROM ops.webhook_quarantine WHERE receipt_id = $1',
      [receiptId],
    );
    expect(quarantined!.reason).toBe('unknown_asset');
    expect(await rowCounts(c.tenant.id, ['app.contacts', 'app.messages'])).toEqual({
      'app.contacts': 0,
      'app.messages': 0,
    });

    // Staff see the deletion's record on the company page.
    expect(await platform().tenantDeletion(staff, c.tenant.id)).toMatchObject({
      id: deletionId,
      rowsDeleted: result.rowsDeleted,
      attempts: 1,
      cancelledAt: null,
    });
  });

  it('resumes an interrupted run without visiting the providers again', async () => {
    const { c, owner } = await busyCompany();
    const { deletionId } = await deletions().request(owner, { confirm: c.tenant.slug });
    await makeDue(c.tenant.id);
    const first = await runTenantDeletion(runDeps(), c.tenant.id, { batchSize: 1, budgetMs: 1 });
    expect(first.outcome).toBe('continue');
    expect(await tenantRow(c.tenant.id)).toMatchObject({ status: 'pending_deletion' });
    const started = await deletionRow(c.tenant.id);
    expect(started!.started_at).not.toBeNull();
    expect(started!.provider_cleanup_at).not.toBeNull();
    // Once started, new events are no longer routed to the company.
    const { receiptId } = await fx.deliver(
      fx.messagesBody(c, { messages: [{ waId: waId(), text: 'Still open?' }] }),
    );
    const [quarantined] = await fx.query<{ reason: string }>(
      'SELECT reason FROM ops.webhook_quarantine WHERE receipt_id = $1',
      [receiptId],
    );
    expect(quarantined!.reason).toBe('unknown_asset');

    const second = await runTenantDeletion(runDeps(), c.tenant.id, { batchSize: 3 });
    expect(second.outcome).toBe('finished');
    expect(
      fx.standIn.state.requests.filter(
        (r) => r.method === 'DELETE' && r.path === `/v26.0/${c.wabaId}/subscribed_apps`,
      ),
    ).toHaveLength(1);
    expect(await deletionRow(c.tenant.id)).toMatchObject({ id: deletionId, attempts: 2 });
    expect(await tenantRow(c.tenant.id)).toMatchObject({ status: 'deleted' });
    const after = await rowCounts(c.tenant.id, await stepTables());
    expect(Object.values(after).every((n) => n === 0)).toBe(true);
    // The final email is sent once, however many runs it took.
    expect(await emails({ dedupePrefix: `tenant-deletion:${deletionId}:finished:` })).toHaveLength(
      1,
    );
  });

  it('records what it could not remove at a provider and still deletes, telling the owners', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    // Meta no longer accepts the account's token.
    fx.standIn.state.tokens.get(c.token)!.valid = false;
    const { deletionId } = await deletions().request(owner, { confirm: c.tenant.slug });
    await makeDue(c.tenant.id);
    const result = await runTenantDeletion(runDeps({ razorpay: null }), c.tenant.id);
    expect(result.outcome).toBe('finished');
    if (result.outcome !== 'finished') return;
    expect(result.cleanup).toHaveLength(1);
    expect(result.cleanup[0]).toMatchObject({ kind: 'whatsapp_account', outcome: 'failed' });
    expect(result.cleanup[0]!.code).toMatch(/^meta_[a-z0-9_]+$/);
    expect(await tenantRow(c.tenant.id)).toMatchObject({ status: 'deleted' });
    const [told] = await emails({ dedupePrefix: `tenant-deletion:${deletionId}:finished:` });
    expect(told!.payload.lines?.join(' ')).toMatch(
      new RegExp(`could not remove itself from: WhatsApp account Main account \\(${c.wabaId}\\)`),
    );
  });

  it('refuses outcomes that are not the known providers, outcomes and codes', async () => {
    const c = await fx.company();
    await deletions().request(await fx.ctx(c, c.owner), { confirm: c.tenant.slug });
    await makeDue(c.tenant.id);
    await fx.dbs.app.run(systemScope, (tx) =>
      tx.execute(sql`select * from ops.start_tenant_deletion(${c.tenant.id}::uuid)`),
    );
    // A deletion is not finished while any of the company's rows remain.
    const finished = await fx.dbs.app.run(systemScope, (tx) =>
      tx.execute<{ done: boolean }>(
        sql`select ops.finish_tenant_deletion(${c.tenant.id}::uuid) as done`,
      ),
    );
    expect(finished.rows[0]!.done).toBe(false);
    expect(await tenantRow(c.tenant.id)).toMatchObject({ status: 'pending_deletion' });
    expect(await deletionRow(c.tenant.id)).toMatchObject({ completed_at: null });
    for (const items of [
      [{ kind: 'email', label: 'x', outcome: 'done' }],
      [{ kind: 'shopify_store', label: 'x', outcome: 'maybe' }],
      [{ kind: 'shopify_store', label: 'x', outcome: 'failed', code: 'Bad Code' }],
      [{ kind: 'shopify_store', label: 'x', outcome: 'done', token: 'secret' }],
      [{ kind: 'shopify_store', label: '', outcome: 'done' }],
    ]) {
      await expect(
        fx.dbs.app.run(systemScope, (tx) =>
          tx.execute(
            sql`select ops.record_tenant_deletion_cleanup(${c.tenant.id}::uuid, ${JSON.stringify(items)}::jsonb)`,
          ),
        ),
      ).rejects.toThrow(/invalid provider cleanup outcomes/);
    }
    const ok = JSON.stringify([{ kind: 'shopify_store', label: 'shop', outcome: 'done' }]);
    await fx.dbs.app.run(systemScope, (tx) =>
      tx.execute(
        sql`select ops.record_tenant_deletion_cleanup(${c.tenant.id}::uuid, ${ok}::jsonb)`,
      ),
    );
    // Only once per deletion.
    await expect(
      fx.dbs.app.run(systemScope, (tx) =>
        tx.execute(
          sql`select ops.record_tenant_deletion_cleanup(${c.tenant.id}::uuid, ${ok}::jsonb)`,
        ),
      ),
    ).rejects.toThrow(/No started deletion waiting/);
  });
});

describe('public entry points while a company waits for deletion', () => {
  it('keeps chat links, widgets, Flow endpoints and store and payment webhooks working', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const growth = createGrowthService({ db: fx.dbs.app, clock: systemClock });
    const { id: linkId } = await growth.createLink(owner, {
      name: 'Bio',
      channelAccountId: c.channelAccountId,
      message: 'Hi',
      includeRef: false,
    });
    const { link } = await growth.getLink(owner, linkId);
    await growth.createWidget(owner, {
      linkId,
      label: 'Chat',
      greeting: '',
      side: 'right',
      color: '#1f7a4d',
      enabled: true,
    });
    const [widget] = await fx.query<{ public_id: string }>(
      'SELECT public_id FROM app.chat_widgets WHERE tenant_id = $1',
      [c.tenant.id],
    );
    const flowId = base32(16);
    const paymentId = base32(16);
    const wooId = base32(16);
    const shop = `waiting-${Date.now().toString(36)}.myshopify.com`;
    await fx.query(
      `INSERT INTO app.flows (id, tenant_id, whatsapp_account_id, public_id, name, categories,
         flow_json, json_version, first_screen, created_by_membership_id)
       VALUES (gen_random_uuid(), $1, $2, $3, 'Survey', ARRAY['SURVEY'], '{}', '7.2', 'START', $4)`,
      [c.tenant.id, c.whatsappAccountId, flowId, c.tenant.ownerMembershipId],
    );
    await fx.query(
      `INSERT INTO app.commerce_payment_accounts (id, tenant_id, key_id, key_secret_ciphertext,
         webhook_secret_ciphertext, webhook_public_id, updated_by_membership_id)
       VALUES (gen_random_uuid(), $1, 'rzp_test_Company000001', 'x', 'x', $2, $3)`,
      [c.tenant.id, paymentId, c.tenant.ownerMembershipId],
    );
    await fx.query(
      `INSERT INTO app.commerce_stores (id, tenant_id, platform, store_url, webhook_public_id,
         webhook_secret_ciphertext, created_by_membership_id)
       VALUES (gen_random_uuid(), $1, 'woocommerce', 'https://shop.example.test', $2, 'x', $3)`,
      [c.tenant.id, wooId, c.tenant.ownerMembershipId],
    );
    await fx.query(
      `INSERT INTO app.commerce_stores (id, tenant_id, platform, store_url, shop_domain,
         created_by_membership_id)
       VALUES (gen_random_uuid(), $1, 'shopify', $2, $3, $4)`,
      [c.tenant.id, `https://${shop}`, shop, c.tenant.ownerMembershipId],
    );
    await deletions().request(owner, { confirm: c.tenant.slug });
    const lookups = await fx.dbs.app.run(systemScope, async (tx) => ({
      link: (await tx.execute(sql`select * from ops.follow_chat_link(${link.slug})`)).rows,
      widget: (await tx.execute(sql`select * from ops.chat_widget_config(${widget!.public_id})`))
        .rows,
      flow: (await tx.execute(sql`select * from ops.flow_endpoint_target(${flowId})`)).rows,
      payment: (
        await tx.execute(sql`select * from ops.commerce_payment_webhook_target(${paymentId})`)
      ).rows,
      shop: (await tx.execute(sql`select * from ops.commerce_store_by_shop(${shop})`)).rows,
      woo: (await tx.execute(sql`select * from ops.commerce_store_by_webhook(${wooId})`)).rows,
    }));
    expect(lookups.link).toHaveLength(1);
    expect(lookups.widget).toHaveLength(1);
    expect(lookups.flow).toEqual([expect.objectContaining({ tenant_status: 'pending_deletion' })]);
    expect(lookups.payment).toEqual([expect.objectContaining({ tenant_id: c.tenant.id })]);
    expect(lookups.shop).toEqual([expect.objectContaining({ tenant_id: c.tenant.id })]);
    expect(lookups.woo).toEqual([expect.objectContaining({ tenant_id: c.tenant.id })]);
  });
});
