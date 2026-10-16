import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock, uuidv7, type MetaConfig } from '@w360/core';
import { authorizedTenantScope, channelAccounts, sql } from '@w360/db';
import {
  GraphClient,
  checkWhatsAppAccess,
  createOnboardingService,
  findAccessChecksDue,
  outboxAad,
  processChannelOnboarding,
  syncTemplates,
  type AccessCheckDeps,
} from '@w360/domain';
import { createUser } from './helpers';
import {
  APP_ID,
  APP_SECRET,
  nextExternalId,
  startWhatsAppFixture,
  type Company,
  type WhatsAppFixture,
} from './whatsapp-fixture';

/**
 * Checking each company's WhatsApp access before sends fail (ADR-137) against real PostgreSQL and
 * the test-only Graph stand-in: what Meta's debug_token answer does to the account and its numbers,
 * the emails, checks that could not be made, the sweep's due list, checks asked by refused template
 * syncs, races with a reconnection, the expiry reminder, reconnecting, the operations console, and
 * the check and restoration of each account's webhook subscription (ADR-138).
 */
let fx: WhatsAppFixture;
let staffId: string;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  const staff = await createUser(fx.dbs, { twoFactor: true });
  await fx.dbs.ownerPool.query(
    `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_operator')`,
    [staff.id],
  );
  staffId = staff.id;
});

afterAll(async () => {
  await fx.close();
});

const BASE_URL = 'https://app.w360.test';
/** A healthy access, and a subscription Meta lists (the stand-in's default). */
const HEALTHY = { outcome: 'healthy', webhooks: { state: 'subscribed' } };

function deps(overrides: Partial<AccessCheckDeps> = {}): AccessCheckDeps {
  return {
    db: fx.dbs.app,
    keyring: fx.keyring,
    graph: fx.graph,
    clock: systemClock,
    meta: { appId: APP_ID, appSecret: APP_SECRET },
    notices: {
      outbox: { keyring: fx.keyring, jobs: fx.jobs(), signer: fx.signer },
      appBaseUrl: BASE_URL,
    },
    ...overrides,
  };
}

const scopeOf = (c: Company) => authorizedTenantScope(c.tenant.id, null);
const check = (c: Company, overrides: Partial<AccessCheckDeps> = {}) =>
  checkWhatsAppAccess(deps(overrides), scopeOf(c), c.whatsappAccountId);

/** What debug_token says about the company's token from now on (as the business changes it). */
function setToken(
  c: Company,
  change: Partial<{
    valid: boolean;
    appId: string;
    scopes: string[];
    granular: { scope: string; target_ids?: string[] }[];
    expiresAt: number;
  }>,
) {
  const current = fx.standIn.state.tokens.get(c.token)!;
  fx.standIn.state.tokens.set(c.token, { ...current, ...change });
}

async function account(c: Company) {
  const [row] = await fx.query<{
    status: string;
    token_problem: string | null;
    token_problem_at: Date | null;
    token_checked_at: Date | null;
    token_check_attempted_at: Date | null;
    token_check_requested_at: Date | null;
    token_check_error: string | null;
    token_expires_at: Date | null;
    token_expiry_reminded_at: Date | null;
    granted_scopes: string[];
  }>(
    `SELECT status, token_problem, token_problem_at, token_checked_at, token_check_attempted_at,
            token_check_requested_at, token_check_error, token_expires_at, token_expiry_reminded_at,
            granted_scopes
       FROM app.whatsapp_accounts WHERE id = $1`,
    [c.whatsappAccountId],
  );
  return row!;
}

async function number(id: string) {
  const [row] = await fx.query<{
    status: string;
    onboarding_error: string | null;
    onboarding_step: string | null;
  }>('SELECT status, onboarding_error, onboarding_step FROM app.channel_accounts WHERE id = $1', [
    id,
  ]);
  return row!;
}

/** Another number of the company's account, in the given state. */
async function addNumber(
  c: Company,
  status: 'active' | 'onboarding' | 'failed' | 'disconnected' | 'needs_reconnect',
  extra: { step?: 'subscribe_app' | 'register_number' | 'health_check' | 'done' } = {},
) {
  const id = uuidv7();
  const phoneNumberId = nextExternalId();
  // Meta knows the number (its health can be read).
  fx.standIn.state.numbers.set(phoneNumberId, {
    display_phone_number: `+91 90000 ${phoneNumberId.slice(-5)}`,
    verified_name: 'Main account',
  });
  await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), async (tx) => {
    await tx.insert(channelAccounts).values({
      id,
      tenantId: c.tenant.id,
      whatsappAccountId: c.whatsappAccountId,
      phoneNumberId,
      status,
      displayPhoneNumber: `+91 90000 ${phoneNumberId.slice(-5)}`,
      ...(extra.step ? { onboardingStep: extra.step } : {}),
    });
    if (status !== 'disconnected') {
      await tx.execute(
        sql`select app.bind_provider_asset('meta_whatsapp', 'phone_number', ${phoneNumberId}, ${id}::uuid, ${c.wabaId})`,
      );
    }
  });
  return { id, phoneNumberId };
}

/** The company's notices queued in the outbox, oldest first. */
async function notices(tenantId: string) {
  const rows = await fx.query<{ id: string; to_address: string; payload_ciphertext: string }>(
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

/**
 * The accounts of these companies that the sweep's definer function lists. Other test files'
 * accounts are marked checked inside a transaction that is rolled back, so the function's limit
 * cannot hide these companies' accounts behind theirs.
 */
async function dueAmong(companies: Company[]): Promise<string[]> {
  const client = await fx.dbs.adminPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE app.whatsapp_accounts SET token_checked_at = now(), token_check_attempted_at = now(),
              token_check_requested_at = NULL
        WHERE NOT (tenant_id = ANY($1::uuid[]))`,
      [companies.map((c) => c.tenant.id)],
    );
    const { rows } = await client.query<{ whatsapp_account_id: string }>(
      'SELECT whatsapp_account_id FROM ops.whatsapp_access_checks_due(500)',
    );
    return rows.map((r) => r.whatsapp_account_id).sort();
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('a daily check of each connected account', () => {
  it('stores what Meta says about a healthy token and tells nobody', async () => {
    const c = await fx.company();
    const before = new Date();
    expect(await check(c)).toEqual(HEALTHY);
    const row = await account(c);
    expect(row.status).toBe('connected');
    expect(row.token_problem).toBeNull();
    expect(row.token_checked_at!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(row.token_check_attempted_at).toEqual(row.token_checked_at);
    expect(row.granted_scopes.sort()).toEqual([
      'whatsapp_business_management',
      'whatsapp_business_messaging',
    ]);
    expect(row.token_expires_at).toBeNull();
    expect(await notices(c.tenant.id)).toEqual([]);
    expect((await number(c.channelAccountId)).status).toBe('active');
    // The request carried HyFib's app access token and the company's token, as onboarding does.
    const request = fx.standIn.state.requests.findLast(
      (r) => r.path === '/v26.0/debug_token' && r.query.input_token === c.token,
    );
    expect(request?.query.access_token).toBe(`${APP_ID}|${APP_SECRET}`);
  });

  it('marks the account and its sending numbers for reconnecting, once, and emails the owners and administrators', async () => {
    const c = await fx.company();
    const settingUp = await addNumber(c, 'onboarding', { step: 'register_number' });
    const failed = await addNumber(c, 'failed');
    const disconnected = await addNumber(c, 'disconnected');
    setToken(c, { valid: false });
    const [cursor] = await fx.query<{ n: string }>(
      'SELECT coalesce(max(id), 0)::text AS n FROM app.tenant_events WHERE tenant_id = $1',
      [c.tenant.id],
    );
    expect(await check(c)).toEqual({ outcome: 'lost' });

    const row = await account(c);
    expect(row).toMatchObject({ status: 'needs_reconnect', token_problem: 'invalid' });
    expect(row.token_problem_at).toEqual(row.token_checked_at);
    for (const id of [c.channelAccountId, settingUp.id]) {
      expect(await number(id)).toMatchObject({
        status: 'needs_reconnect',
        onboarding_error:
          'Meta no longer accepts HyFib’s access to this number’s WhatsApp Business Account: Meta reports that the access token is no longer valid. Reconnect WhatsApp.',
      });
    }
    // Setup resumes from where it stopped once reconnected.
    expect((await number(settingUp.id)).onboarding_step).toBe('register_number');
    expect((await number(failed.id)).status).toBe('failed');
    expect((await number(disconnected.id)).status).toBe('disconnected');

    const [audit] = await fx.query<{
      action: string;
      result: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, result, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'whatsapp.access_lost'`,
      [c.tenant.id],
    );
    expect(audit).toEqual({
      action: 'whatsapp.access_lost',
      result: 'failure',
      metadata: { problem: 'invalid', missing: [], numbers: 2, code: 190 },
    });
    const events = await fx.query<{ type: string; payload: { channelAccountId: string } }>(
      `SELECT type, payload FROM app.tenant_events WHERE tenant_id = $1 AND id > $2 ORDER BY id`,
      [c.tenant.id, cursor!.n],
    );
    expect(events.map((e) => e.payload.channelAccountId).sort()).toEqual(
      [c.channelAccountId, settingUp.id].sort(),
    );
    expect(events.every((e) => e.type === 'channel.updated')).toBe(true);

    // The owner is emailed (owners and administrators are the members who can reconnect); the
    // agent and the marketer are not.
    const sent = await notices(c.tenant.id);
    expect(sent.map((n) => n.to)).toEqual([c.owner.email]);
    expect(sent[0]).toMatchObject({
      subject: 'Reconnect WhatsApp: Meta no longer accepts HyFib’s access to Main account',
      url: `${BASE_URL}/c/${c.tenant.slug}/settings/channels`,
      actionLabel: 'Open Channels',
    });
    expect(sent[0]!.lines[0]).toBe(
      'Meta no longer accepts HyFib’s access to Main account: Meta reports that the access token is no longer valid.',
    );
    expect(sent[0]!.lines[1]).toContain('+91 90000 00000');
    expect(sent[0]!.lines[1]).toContain(`+91 90000 ${settingUp.phoneNumberId.slice(-5)}`);
    // Nothing is told about the token itself.
    expect(JSON.stringify(sent)).not.toContain(c.token);

    // The account leaves the checks until it is reconnected: no second email.
    expect(await check(c)).toEqual({ outcome: 'skipped' });
    expect(await notices(c.tenant.id)).toHaveLength(1);
    expect(await dueAmong([c])).toEqual([]);
  });

  it('names a removed permission, another app and an account no longer shared', async () => {
    const lostWith = async (change: Parameters<typeof setToken>[1]) => {
      const c = await fx.company();
      setToken(c, change);
      expect(await check(c)).toEqual({ outcome: 'lost' });
      const issues = await createOnboardingService(onboardingDeps()).accessIssues(
        await fx.ctx(c, c.agent),
      );
      return { row: await account(c), issues, sent: await notices(c.tenant.id) };
    };

    const permission = await lostWith({ scopes: ['whatsapp_business_management'] });
    expect(permission.row.token_problem).toBe('missing_permission');
    // Meta's permissions are stored, so the reason names the missing one.
    expect(permission.row.granted_scopes).toEqual(['whatsapp_business_management']);
    expect(permission.issues).toEqual([
      expect.objectContaining({
        kind: 'reconnect',
        account: 'Main account',
        problem: 'missing_permission',
        reason: 'the permission to send messages (whatsapp_business_messaging) was removed',
      }),
    ]);
    expect(permission.sent[0]!.lines[0]).toContain(
      'the permission to send messages (whatsapp_business_messaging) was removed',
    );

    const otherApp = await lostWith({ appId: '999' });
    expect(otherApp.row.token_problem).toBe('other_app');
    // Another app's permissions are not HyFib's: they are not stored.
    expect(otherApp.row.granted_scopes).toEqual([]);

    const unshared = await lostWith({
      granular: [{ scope: 'whatsapp_business_management', target_ids: [nextExternalId()] }],
    });
    expect(unshared.row.token_problem).toBe('account_not_shared');
    expect(unshared.issues[0]!.reason).toBe(
      'Meta no longer lists the account among those shared with HyFib’s app',
    );
  });

  it('changes nothing for the company when the check cannot be made, and tries again after 30 minutes', async () => {
    const c = await fx.company();
    // HyFib's app access token refused (code 190 about the request, not the company's token).
    const refused = await check(c, { meta: { appId: APP_ID, appSecret: 'rotated-secret' } });
    expect(refused).toEqual({ outcome: 'not_checked', error: 'auth 190: OAuthException' });
    // Meta out of reach.
    const unreachable = new GraphClient({
      baseUrl: 'http://127.0.0.1:9',
      version: 'v26.0',
      timeoutMs: 1_000,
    });
    const noAnswer = await check(c, { graph: unreachable });
    expect(noAnswer.outcome).toBe('not_checked');
    const row = await account(c);
    expect(row.status).toBe('connected');
    expect(row.token_problem).toBeNull();
    expect(row.token_checked_at).toBeNull();
    expect(row.token_check_attempted_at).not.toBeNull();
    // The last attempt's error: its kind and title, never the token or the URL.
    expect(row.token_check_error).toBe(noAnswer.error);
    expect(row.token_check_error).toMatch(/^(retryable|unknown): /);
    expect((await number(c.channelAccountId)).status).toBe('active');
    expect(await notices(c.tenant.id)).toEqual([]);
    // Not due again until 30 minutes after the attempt.
    expect(await dueAmong([c])).toEqual([]);
    await fx.query(
      `UPDATE app.whatsapp_accounts SET token_check_attempted_at = now() - interval '31 minutes'
        WHERE id = $1`,
      [c.whatsappAccountId],
    );
    expect(await dueAmong([c])).toEqual([c.whatsappAccountId]);
  });

  it('records nothing when the account is reconnected or disconnected during the check', async () => {
    const c = await fx.company();
    const reconnected = Object.assign(Object.create(fx.graph) as GraphClient, {
      async debugToken(token: string, appId: string, appSecret: string) {
        const answer = await fx.graph.debugToken(token, appId, appSecret);
        // A reconnection stores another token while Meta answers about the old one.
        await fx.dbs.app.run(scopeOf(c), (tx) =>
          tx.execute(
            sql`update app.whatsapp_accounts set credential_ciphertext = ${fx.keyring.encrypt(
              `EAAG${randomBytes(12).toString('hex')}`,
              `tenant:${c.tenant.id}|whatsapp_account:${c.whatsappAccountId}`,
            )} where id = ${c.whatsappAccountId}`,
          ),
        );
        return answer;
      },
    });
    setToken(c, { valid: false });
    expect(await check(c, { graph: reconnected })).toEqual({ outcome: 'skipped' });
    expect(await account(c)).toMatchObject({
      status: 'connected',
      token_problem: null,
      token_check_attempted_at: null,
    });
    expect(await notices(c.tenant.id)).toEqual([]);

    // The same token sealed again under the primary key (ADR-134) is the same token.
    const resealed = await fx.company();
    const sealing = Object.assign(Object.create(fx.graph) as GraphClient, {
      async debugToken(token: string, appId: string, appSecret: string) {
        const answer = await fx.graph.debugToken(token, appId, appSecret);
        await fx.dbs.app.run(scopeOf(resealed), (tx) =>
          tx.execute(
            sql`update app.whatsapp_accounts set credential_ciphertext = ${fx.keyring.encrypt(
              token,
              `tenant:${resealed.tenant.id}|whatsapp_account:${resealed.whatsappAccountId}`,
            )} where id = ${resealed.whatsappAccountId}`,
          ),
        );
        return answer;
      },
    });
    expect(await check(resealed, { graph: sealing })).toEqual(HEALTHY);
  });

  it('reminds the owners once when Meta reports an expiry less than 7 days away', async () => {
    const c = await fx.company();
    const inThreeDays = Math.floor(Date.now() / 1000) + 3 * 86_400;
    setToken(c, { expiresAt: inThreeDays });
    expect(await check(c)).toEqual(HEALTHY);
    const row = await account(c);
    expect(row.token_expires_at?.getTime()).toBe(inThreeDays * 1000);
    expect(row.token_expiry_reminded_at).not.toBeNull();
    const sent = await notices(c.tenant.id);
    expect(sent.map((n) => n.to)).toEqual([c.owner.email]);
    expect(sent[0]!.subject).toMatch(/^HyFib’s access to Main account expires on /);
    expect(sent[0]!.lines[1]).toBe(
      'From then on +91 90000 00000 cannot send messages from HyFib until the account is reconnected.',
    );
    // The next check does not remind again.
    expect(await check(c)).toEqual(HEALTHY);
    expect(await notices(c.tenant.id)).toHaveLength(1);
    // The banner and Channels show it.
    const service = createOnboardingService(onboardingDeps());
    const ctx = await fx.ctx(c, c.agent);
    expect(await service.accessIssues(ctx)).toEqual([
      expect.objectContaining({ kind: 'expiring', reason: null, account: 'Main account' }),
    ]);
    expect((await service.listChannels(ctx))[0]).toMatchObject({
      accountStatus: 'connected',
      accessExpiresAt: new Date(inThreeDays * 1000).toISOString(),
      accessExpired: false,
      // And the permissions Meta listed at the check (ADR-381).
      grantedPermissions: [
        {
          scope: 'whatsapp_business_management',
          purpose: 'manage the account, its numbers and templates',
        },
        { scope: 'whatsapp_business_messaging', purpose: 'send messages' },
      ],
    });

    // Once the expiry has passed, the banner and Channels say so and the account is checked again
    // at once, without waiting for the daily check.
    await fx.query(
      `UPDATE app.whatsapp_accounts SET token_expires_at = now() - interval '1 minute',
              token_checked_at = now() - interval '2 hours',
              token_check_attempted_at = now() - interval '2 hours' WHERE id = $1`,
      [c.whatsappAccountId],
    );
    expect(await service.accessIssues(ctx)).toEqual([
      expect.objectContaining({ kind: 'expired', reason: null, account: 'Main account' }),
    ]);
    expect((await service.listChannels(ctx))[0]).toMatchObject({ accessExpired: true });
    expect(await dueAmong([c])).toEqual([c.whatsappAccountId]);
    // An expiry that had passed before the last check asks for no other one.
    await fx.query(
      `UPDATE app.whatsapp_accounts SET token_checked_at = now(), token_check_attempted_at = now()
        WHERE id = $1`,
      [c.whatsappAccountId],
    );
    expect(await dueAmong([c])).toEqual([]);
    // The check after the expiry finds the token refused.
    setToken(c, { valid: false });
    expect(await check(c)).toEqual({ outcome: 'lost' });
    expect(await service.accessIssues(ctx)).toEqual([
      expect.objectContaining({ kind: 'reconnect' }),
    ]);

    // An expiry further away is stored and not reminded.
    const later = await fx.company();
    setToken(later, { expiresAt: Math.floor(Date.now() / 1000) + 10 * 86_400 });
    expect(await check(later)).toEqual(HEALTHY);
    expect((await account(later)).token_expiry_reminded_at).toBeNull();
    expect(await notices(later.tenant.id)).toEqual([]);
  });
});

describe('the sweep’s list of accounts due a check', () => {
  it('lists connected accounts of active companies never checked, checked over a day ago or asked for', async () => {
    const never = await fx.company();
    const recent = await fx.company();
    const old = await fx.company();
    const asked = await fx.company();
    const reconnect = await fx.company();
    const suspended = await fx.company();
    const disconnected = await fx.company();
    for (const c of [recent, old, asked, reconnect, suspended, disconnected]) {
      expect((await check(c)).outcome).toBe('healthy');
    }
    await fx.query(
      `UPDATE app.whatsapp_accounts SET token_checked_at = now() - interval '25 hours',
              token_check_attempted_at = now() - interval '25 hours' WHERE id = $1`,
      [old.whatsappAccountId],
    );
    await fx.query(
      `UPDATE app.whatsapp_accounts SET token_check_requested_at = now() WHERE id = $1`,
      [asked.whatsappAccountId],
    );
    await fx.query(`UPDATE app.whatsapp_accounts SET status = 'needs_reconnect' WHERE id = $1`, [
      reconnect.whatsappAccountId,
    ]);
    await fx.query(
      `UPDATE app.whatsapp_accounts SET status = 'disconnected', credential_ciphertext = NULL WHERE id = $1`,
      [disconnected.whatsappAccountId],
    );
    await fx.query(
      // Never checked nor attempted: only their own state keeps these out.
      `UPDATE app.whatsapp_accounts SET token_checked_at = NULL, token_check_attempted_at = NULL
        WHERE id = ANY($1::uuid[])`,
      [[suspended.whatsappAccountId, reconnect.whatsappAccountId, disconnected.whatsappAccountId]],
    );
    await fx.query(`UPDATE app.tenants SET status = 'suspended' WHERE id = $1`, [
      suspended.tenant.id,
    ]);
    const all = [never, recent, old, asked, reconnect, suspended, disconnected];
    expect(await dueAmong(all)).toEqual(
      [never.whatsappAccountId, old.whatsappAccountId, asked.whatsappAccountId].sort(),
    );

    // The worker's lookup reads the same function: each pair names an account of that company.
    const due = await findAccessChecksDue(fx.dbs.app, 500);
    expect(due.length).toBeGreaterThan(0);
    const pairs = await fx.query<{ tenant_id: string; id: string }>(
      'SELECT tenant_id, id FROM app.whatsapp_accounts WHERE id = ANY($1::uuid[])',
      [due.map((d) => d.whatsappAccountId)],
    );
    const tenantOf = new Map(pairs.map((p) => [p.id, p.tenant_id]));
    for (const d of due) expect(tenantOf.get(d.whatsappAccountId)).toBe(d.tenantId);

    // A check asked during a check is answered by another one.
    await fx.query(
      `UPDATE app.whatsapp_accounts SET token_check_requested_at = token_checked_at WHERE id = $1`,
      [recent.whatsappAccountId],
    );
    expect(await dueAmong([recent])).toEqual([recent.whatsappAccountId]);
  });

  it('is asked for at once when Meta refuses the token for a template sync', async () => {
    const c = await fx.company();
    expect((await check(c)).outcome).toBe('healthy');
    setToken(c, { valid: false });
    const outcome = await syncTemplates(
      {
        db: fx.dbs.app,
        keyring: fx.keyring,
        graph: fx.graph,
        clock: systemClock,
      },
      scopeOf(c),
      c.whatsappAccountId,
    );
    expect(outcome).toBe('done');
    const row = await account(c);
    expect(row.status).toBe('connected');
    expect(row.token_check_requested_at!.getTime()).toBeGreaterThanOrEqual(
      row.token_checked_at!.getTime(),
    );
    expect(await dueAmong([c])).toEqual([c.whatsappAccountId]);
    // The asked check finds the loss.
    expect(await check(c)).toEqual({ outcome: 'lost' });
  });

  it('is executable by the application role only, and reads only what it needs', async () => {
    const can = async (role: string, fn: string) =>
      (
        await fx.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [
          role,
          fn,
        ])
      )[0]!.ok;
    expect(await can('w360_app', 'ops.whatsapp_access_checks_due(integer)')).toBe(true);
    for (const role of ['w360_platform', 'w360_auth', 'public']) {
      expect(await can(role, 'ops.whatsapp_access_checks_due(integer)')).toBe(false);
    }
    const [config] = await fx.query<{ owner: string; secdef: boolean; config: string[] }>(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, p.proconfig AS config
         FROM pg_proc p WHERE p.oid = 'ops.whatsapp_access_checks_due(integer)'::regprocedure`,
    );
    expect(config).toEqual({
      owner: 'w360_definer',
      secdef: true,
      config: ['search_path=pg_catalog, pg_temp'],
    });
    // The application role may update the new columns but still cannot read a token's ciphertext
    // through the definer's grants.
    const columns = await fx.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE grantee = 'w360_definer' AND table_schema = 'app' AND table_name = 'whatsapp_accounts'
          AND privilege_type = 'UPDATE'`,
    );
    expect(columns).toEqual([]);
  });
});

function metaConfig(): MetaConfig {
  return {
    appId: APP_ID,
    appSecret: APP_SECRET,
    webhookSecrets: [APP_SECRET],
    graphApiVersion: 'v26.0',
    graphBaseUrl: fx.standIn.baseUrl,
    webhookVerifyToken: 'verify',
    embeddedSignupConfigId: '777',
  };
}

function onboardingDeps() {
  return {
    db: fx.dbs.app,
    keyring: fx.keyring,
    jobs: fx.jobs(),
    signer: fx.signer,
    clock: systemClock,
    graph: fx.graph,
    meta: metaConfig(),
  };
}

describe('reconnecting', () => {
  it('stores the new token clean and brings back the account’s other numbers that Meta still lists', async () => {
    const c = await fx.company();
    const second = await addNumber(c, 'active', { step: 'done' });
    const gone = await addNumber(c, 'active', { step: 'done' });
    setToken(c, { valid: false });
    expect(await check(c)).toEqual({ outcome: 'lost' });
    // The app's webhook subscription had been found missing before (ADR-138).
    await fx.query(
      `UPDATE app.whatsapp_accounts SET webhooks_missing_since = now(),
              webhooks_check_error = 'permanent 200: OAuthException' WHERE id = $1`,
      [c.whatsappAccountId],
    );

    // Embedded Signup again with the same account: Meta lists the first two numbers only.
    const code = `code-${randomBytes(8).toString('hex')}`;
    const token = `EAAG${randomBytes(12).toString('hex')}`;
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 86_400;
    fx.standIn.state.codes.set(code, token);
    fx.standIn.state.tokens.set(token, {
      appId: APP_ID,
      valid: true,
      scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
      expiresAt,
    });
    fx.standIn.state.wabaNumbers.set(c.wabaId, [c.phoneNumberId, second.phoneNumberId]);
    const service = createOnboardingService(onboardingDeps());
    const ctx = await fx.ctx(c, c.owner);
    const started = await service.start(ctx);
    await service.complete(ctx, {
      state: started.state,
      code,
      wabaId: c.wabaId,
      phoneNumberId: c.phoneNumberId,
    });

    const row = await account(c);
    expect(row).toMatchObject({
      status: 'connected',
      token_problem: null,
      token_problem_at: null,
      token_check_error: null,
      token_check_requested_at: null,
      token_expiry_reminded_at: null,
    });
    expect(row.token_expires_at?.getTime()).toBe(expiresAt * 1000);
    const [subscription] = await fx.query<{ missing: Date | null; error: string | null }>(
      `SELECT webhooks_missing_since AS missing, webhooks_check_error AS error
         FROM app.whatsapp_accounts WHERE id = $1`,
      [c.whatsappAccountId],
    );
    expect(subscription).toEqual({ missing: null, error: null });
    expect(row.token_check_attempted_at).toEqual(row.token_checked_at);
    // The chosen number is set up again from the start; the other listed one only resumes.
    expect(await number(c.channelAccountId)).toMatchObject({
      status: 'onboarding',
      onboarding_step: 'subscribe_app',
    });
    expect(await number(second.id)).toEqual({
      status: 'onboarding',
      onboarding_step: 'done',
      onboarding_error: null,
    });
    expect((await number(gone.id)).status).toBe('needs_reconnect');
    const jobs = await fx.query<{ singleton_key: string }>(
      `SELECT singleton_key FROM pgboss.job WHERE name = 'channel.onboard' AND singleton_key = ANY($1)`,
      [[c.channelAccountId, second.id, gone.id]],
    );
    expect(jobs.map((j) => j.singleton_key).sort()).toEqual([c.channelAccountId, second.id].sort());
    const [audit] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'channel.connected'`,
      [c.tenant.id],
    );
    expect(audit!.metadata).toMatchObject({ reconnect: true, restoredNumbers: 1 });

    // The restored number has its health read with the new token, without registering again.
    const registers = () =>
      fx.standIn.state.requests.filter((r) => r.path === `/v26.0/${second.phoneNumberId}/register`)
        .length;
    const before = registers();
    expect(
      await processChannelOnboarding(
        { db: fx.dbs.app, keyring: fx.keyring, graph: fx.graph, clock: systemClock },
        scopeOf(c),
        second.id,
      ),
    ).toBe('active');
    expect(registers()).toBe(before);
    expect((await number(second.id)).status).toBe('active');
    // Nothing needs attention any more.
    expect(await service.accessIssues(ctx)).toEqual([]);
  });
});

describe('the operations console', () => {
  it('shows why an account needs reconnecting and lists accounts whose access could not be checked for a day', async () => {
    const lost = await fx.company();
    setToken(lost, { valid: false });
    expect(await check(lost)).toEqual({ outcome: 'lost' });
    const failing = await fx.company();
    expect(
      (await check(failing, { meta: { appId: APP_ID, appSecret: 'rotated-secret' } })).outcome,
    ).toBe('not_checked');
    await fx.query(
      `UPDATE app.whatsapp_accounts SET token_checked_at = now() - interval '27 hours'
        WHERE id = $1`,
      [failing.whatsappAccountId],
    );
    // A day without a successful check, but the last attempt succeeded: not listed.
    const quiet = await fx.company();
    await fx.query(
      `UPDATE app.whatsapp_accounts SET token_checked_at = now() - interval '27 hours',
              token_check_attempted_at = now() - interval '27 hours' WHERE id = $1`,
      [quiet.whatsappAccountId],
    );

    const rows = (
      await fx.dbs.platform.run(staffId, (tx) =>
        tx.execute<{ tenant_id: string; source: string; state: string; error: string | null }>(
          sql`select * from ops.platform_ops_integration_failures(1000)`,
        ),
      )
    ).rows;
    const of = (c: Company) =>
      rows
        .filter((r) => r.tenant_id === c.tenant.id)
        .map(({ source, state, error }) => ({ source, state, error }))
        .sort((a, b) => a.source.localeCompare(b.source));
    expect(of(lost)).toEqual([
      {
        source: 'whatsapp_account',
        state: 'needs_reconnect',
        error: 'Meta: the access token is no longer valid',
      },
      {
        source: 'whatsapp_number',
        state: 'needs_reconnect',
        error:
          'Meta no longer accepts HyFib’s access to this number’s WhatsApp Business Account: Meta reports that the access token is no longer valid. Reconnect WhatsApp.',
      },
    ]);
    expect(of(failing)).toEqual([
      { source: 'whatsapp_access_check', state: 'not_checked', error: 'auth 190: OAuthException' },
    ]);
    expect(of(quiet)).toEqual([]);
  });
});

describe('the account’s webhook subscription (ADR-138)', () => {
  async function webhooks(c: Company) {
    const [row] = await fx.query<{
      webhooks_checked_at: Date | null;
      webhooks_check_error: string | null;
      webhooks_missing_since: Date | null;
      webhooks_restored_at: Date | null;
      token_checked_at: Date | null;
    }>(
      `SELECT webhooks_checked_at, webhooks_check_error, webhooks_missing_since,
              webhooks_restored_at, token_checked_at
         FROM app.whatsapp_accounts WHERE id = $1`,
      [c.whatsappAccountId],
    );
    return row!;
  }
  const calls = (c: Company, method: string) =>
    fx.standIn.state.requests.filter(
      (r) => r.method === method && r.path === `/v26.0/${c.wabaId}/subscribed_apps`,
    );
  async function audits(c: Company, action: string) {
    return fx.query<{ result: string; metadata: Record<string, unknown> }>(
      `SELECT result, metadata FROM app.audit_events WHERE tenant_id = $1 AND action = $2`,
      [c.tenant.id, action],
    );
  }
  async function consoleRows(c: Company) {
    const rows = (
      await fx.dbs.platform.run(staffId, (tx) =>
        tx.execute<{ tenant_id: string; source: string; state: string; error: string | null }>(
          sql`select * from ops.platform_ops_integration_failures(1000)`,
        ),
      )
    ).rows;
    return rows
      .filter((r) => r.tenant_id === c.tenant.id && r.source === 'whatsapp_webhooks')
      .map(({ state, error }) => ({ state, error }));
  }
  /** As if the last attempt was more than 30 minutes ago. */
  async function laterThan30Minutes(c: Company) {
    await fx.query(
      `UPDATE app.whatsapp_accounts SET token_checked_at = now() - interval '31 minutes',
              token_check_attempted_at = now() - interval '31 minutes' WHERE id = $1`,
      [c.whatsappAccountId],
    );
  }

  it('confirms a subscription Meta lists, with the account’s token, and tells nobody', async () => {
    const c = await fx.company();
    expect(await check(c)).toEqual({ outcome: 'healthy', webhooks: { state: 'subscribed' } });
    const row = await webhooks(c);
    expect(row.webhooks_checked_at).toEqual(row.token_checked_at);
    expect(row).toMatchObject({
      webhooks_check_error: null,
      webhooks_missing_since: null,
      webhooks_restored_at: null,
    });
    const [listed] = calls(c, 'GET');
    expect(listed!.authorization).toBe(`Bearer ${c.token}`);
    expect(listed!.query).toEqual({});
    expect(calls(c, 'POST')).toEqual([]);
    expect(await notices(c.tenant.id)).toEqual([]);
    const ctx = await fx.ctx(c, c.agent);
    const service = createOnboardingService(onboardingDeps());
    expect((await service.listChannels(ctx))[0]).toMatchObject({
      webhooksCheckedAt: row.webhooks_checked_at!.toISOString(),
    });
    expect(await service.accessIssues(ctx)).toEqual([]);
  });

  it('subscribes HyFib’s app again at once when Meta no longer lists it, and tells the owners', async () => {
    const c = await fx.company();
    // Meta lists another app only.
    fx.standIn.state.unsubscribedWabas.add(c.wabaId);
    fx.standIn.state.otherSubscribedApps.set(c.wabaId, ['2345678901234567']);
    expect(await check(c)).toEqual({ outcome: 'healthy', webhooks: { state: 'restored' } });
    expect(fx.standIn.state.unsubscribedWabas.has(c.wabaId)).toBe(false);
    expect(calls(c, 'POST').map((r) => r.body)).toEqual([{}]);
    const row = await webhooks(c);
    expect(row.webhooks_restored_at).toEqual(row.token_checked_at);
    expect(row.webhooks_checked_at).toEqual(row.token_checked_at);
    expect(row).toMatchObject({ webhooks_check_error: null, webhooks_missing_since: null });
    expect(await audits(c, 'whatsapp.webhooks_restored')).toEqual([
      { result: 'success', metadata: { missingSince: null } },
    ]);
    const sent = await notices(c.tenant.id);
    expect(sent.map((n) => [n.to, n.subject])).toEqual([
      [c.owner.email, 'HyFib was not receiving WhatsApp updates for Main account'],
    ]);
    expect(sent[0]!.lines[1]).toBe(
      'Messages, delivery updates and template updates that Meta sent before then may not have reached HyFib, so some conversations may be missing from the inbox.',
    );
    expect(sent[0]!.url).toBe(`${BASE_URL}/c/${c.tenant.slug}/settings/channels`);
    // The next check finds it subscribed and tells nobody.
    await laterThan30Minutes(c);
    expect((await check(c)).webhooks).toEqual({ state: 'subscribed' });
    expect(await notices(c.tenant.id)).toHaveLength(1);
  });

  it('records when subscribing again fails, tells the company once, shows it and tries again every 30 minutes', async () => {
    const c = await fx.company();
    fx.standIn.state.unsubscribedWabas.add(c.wabaId);
    fx.standIn.state.subscribeErrors.set(c.wabaId, {
      status: 403,
      code: 200,
      message: "Your app doesn't have permission to subscribe to this WhatsApp Business Account",
    });
    const error = 'permanent 200: OAuthException';
    expect(await check(c)).toEqual({
      outcome: 'healthy',
      webhooks: { state: 'missing', error },
    });
    const first = await webhooks(c);
    expect(first.webhooks_missing_since).toEqual(first.token_checked_at);
    expect(first).toMatchObject({ webhooks_check_error: error, webhooks_checked_at: null });
    expect(await audits(c, 'whatsapp.webhooks_missing')).toEqual([
      { result: 'failure', metadata: { error } },
    ]);
    const sent = await notices(c.tenant.id);
    expect(sent.map((n) => n.subject)).toEqual([
      'WhatsApp messages for Main account are not reaching HyFib',
    ]);
    expect(sent[0]!.lines[1]).toBe(
      'Until it is subscribed again, messages customers send to +91 90000 00000 do not reach HyFib.',
    );
    // Every page of the company and the console show it.
    const service = createOnboardingService(onboardingDeps());
    const ctx = await fx.ctx(c, c.agent);
    expect(await service.accessIssues(ctx)).toEqual([
      expect.objectContaining({
        kind: 'webhooks',
        account: 'Main account',
        since: first.webhooks_missing_since!.toISOString(),
      }),
    ]);
    expect(await consoleRows(c)).toEqual([{ state: 'not_subscribed', error }]);
    // Listed once, even when the subscription has not been confirmed for over a day.
    await fx.query(
      `UPDATE app.whatsapp_accounts SET webhooks_checked_at = now() - interval '27 hours'
        WHERE id = $1`,
      [c.whatsappAccountId],
    );
    expect(await consoleRows(c)).toEqual([{ state: 'not_subscribed', error }]);

    // Tried again 30 minutes later, not before; a second failure tells nobody again.
    expect(await dueAmong([c])).toEqual([]);
    await laterThan30Minutes(c);
    expect(await dueAmong([c])).toEqual([c.whatsappAccountId]);
    expect((await check(c)).webhooks).toEqual({ state: 'missing', error });
    expect((await webhooks(c)).webhooks_missing_since).toEqual(first.webhooks_missing_since);
    expect(await notices(c.tenant.id)).toHaveLength(1);
    expect(await audits(c, 'whatsapp.webhooks_missing')).toHaveLength(1);

    // Once it can be subscribed again, the company hears that messages arrive again.
    fx.standIn.state.subscribeErrors.delete(c.wabaId);
    await laterThan30Minutes(c);
    expect((await check(c)).webhooks).toEqual({ state: 'restored' });
    expect(await webhooks(c)).toMatchObject({
      webhooks_check_error: null,
      webhooks_missing_since: null,
    });
    expect(await audits(c, 'whatsapp.webhooks_restored')).toEqual([
      {
        result: 'success',
        metadata: { missingSince: first.webhooks_missing_since!.toISOString() },
      },
    ]);
    const after = await notices(c.tenant.id);
    expect(after.map((n) => n.subject)).toEqual([
      'WhatsApp messages for Main account are not reaching HyFib',
      'WhatsApp messages for Main account reach HyFib again',
    ]);
    expect(after[1]!.lines[1]).toContain('(at least since ');
    expect(await service.accessIssues(ctx)).toEqual([]);
    expect(await consoleRows(c)).toEqual([]);
  });

  it('tells the company when the subscription is found again after it could not be restored', async () => {
    const c = await fx.company();
    fx.standIn.state.unsubscribedWabas.add(c.wabaId);
    fx.standIn.state.subscribeErrors.set(c.wabaId, { status: 403, code: 200, message: 'No' });
    expect((await check(c)).webhooks?.state).toBe('missing');
    // The business subscribes the app itself meanwhile.
    fx.standIn.state.subscribeErrors.delete(c.wabaId);
    fx.standIn.state.unsubscribedWabas.delete(c.wabaId);
    await laterThan30Minutes(c);
    expect((await check(c)).webhooks).toEqual({ state: 'subscribed' });
    expect(await webhooks(c)).toMatchObject({
      webhooks_missing_since: null,
      webhooks_check_error: null,
    });
    expect((await notices(c.tenant.id)).map((n) => n.subject)).toEqual([
      'WhatsApp messages for Main account are not reaching HyFib',
      'WhatsApp messages for Main account reach HyFib again',
    ]);
    expect(await audits(c, 'whatsapp.webhooks_restored')).toEqual([]);
  });

  it('changes nothing for the company when the subscribed apps cannot be listed', async () => {
    const c = await fx.company();
    fx.standIn.state.subscribedAppsErrors.set(c.wabaId, {
      status: 500,
      code: 2,
      message: 'An unexpected error occurred. Please retry your request',
    });
    const error = 'retryable 2: OAuthException';
    expect(await check(c)).toEqual({
      outcome: 'healthy',
      webhooks: { state: 'not_checked', error },
    });
    expect(await webhooks(c)).toMatchObject({
      webhooks_check_error: error,
      webhooks_missing_since: null,
      webhooks_checked_at: null,
    });
    expect(calls(c, 'POST')).toEqual([]);
    expect(await notices(c.tenant.id)).toEqual([]);
    const ctx = await fx.ctx(c, c.agent);
    expect(await createOnboardingService(onboardingDeps()).accessIssues(ctx)).toEqual([]);
    // Tried again after 30 minutes; staff see it once it has not been confirmed for 26 hours.
    expect(await dueAmong([c])).toEqual([]);
    await laterThan30Minutes(c);
    expect(await dueAmong([c])).toEqual([c.whatsappAccountId]);
    expect(await consoleRows(c)).toEqual([]);
    await fx.query(
      `UPDATE app.whatsapp_accounts SET webhooks_checked_at = now() - interval '27 hours'
        WHERE id = $1`,
      [c.whatsappAccountId],
    );
    expect(await consoleRows(c)).toEqual([{ state: 'not_checked', error }]);
    // A later confirmation clears the error.
    fx.standIn.state.subscribedAppsErrors.delete(c.wabaId);
    expect((await check(c)).webhooks).toEqual({ state: 'subscribed' });
    expect((await webhooks(c)).webhooks_check_error).toBeNull();
    expect(await consoleRows(c)).toEqual([]);
  });

  it('does not take a list with an app it cannot read for a missing subscription', async () => {
    const c = await fx.company();
    // Meta lists an app without its id, and not HyFib's: that app may be HyFib's.
    fx.standIn.state.unsubscribedWabas.add(c.wabaId);
    fx.standIn.state.unreadableSubscribedApps.add(c.wabaId);
    const error = 'unknown: incomplete_app_list';
    expect(await check(c)).toEqual({
      outcome: 'healthy',
      webhooks: { state: 'not_checked', error },
    });
    expect(calls(c, 'POST')).toEqual([]);
    expect(await webhooks(c)).toMatchObject({
      webhooks_check_error: error,
      webhooks_missing_since: null,
      webhooks_checked_at: null,
    });
    expect(await notices(c.tenant.id)).toEqual([]);
    // HyFib's app listed beside it is enough.
    fx.standIn.state.unsubscribedWabas.delete(c.wabaId);
    expect((await check(c)).webhooks).toEqual({ state: 'subscribed' });
    expect((await webhooks(c)).webhooks_check_error).toBeNull();
  });

  it('is not checked with a token Meta does not admit, or when the access could not be checked', async () => {
    const lost = await fx.company();
    setToken(lost, { valid: false });
    expect(await check(lost)).toEqual({ outcome: 'lost' });
    expect(calls(lost, 'GET')).toEqual([]);
    const unchecked = await fx.company();
    expect(
      (await check(unchecked, { meta: { appId: APP_ID, appSecret: 'rotated-secret' } })).outcome,
    ).toBe('not_checked');
    expect(calls(unchecked, 'GET')).toEqual([]);
    expect((await webhooks(unchecked)).webhooks_checked_at).toBeNull();
  });
});
