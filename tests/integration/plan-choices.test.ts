import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { Keyring, isAppError, uuidv7, type Clock, type RazorpayConfig } from '@w360/core';
import { authorizedTenantScope, sql } from '@w360/db';
import {
  JobSigner,
  PgBossJobQueue,
  RazorpayClient,
  createPlanAdminService,
  createPlanChoicesService,
  createPlanSubscriptionService,
  createTeamsService,
  dayOf,
  notifyStaffPlanChanges,
  resolveTenantContext,
  type BillingNoticeDeps,
  type PlatformActor,
  type TenantContext,
} from '@w360/domain';
import {
  acceptInvitation,
  connectTestDatabases,
  createTenant,
  createUser,
  invite,
  type TestDatabases,
  type TestTenant,
  type TestUser,
} from './helpers';
import { startRazorpayStandIn, type RazorpayStandIn } from '../support/razorpay-stand-in';

/**
 * Companies choosing the plan they pay for (P5-01/P5-07, ADR-105) against real PostgreSQL and the
 * test-only Razorpay stand-in: platform owners offer published versions; owners and billing managers
 * with a recent sign-in choose one on a trial or after the plan ended, and then pay for it; the
 * version must hold what the company has; `app.choose_plan` refuses everything else in SQL, under
 * the locks a subscription start, staff changes and additions take.
 */
const KEY_ID = 'rzp_test_StandIn00000082';
const KEY_SECRET = randomBytes(16).toString('hex');
const APP_BASE = 'http://localhost:3000';
const DAY_MS = 86_400_000;

let dbs: TestDatabases;
let boss: PgBoss;
let standIn: RazorpayStandIn;
let razorpay: RazorpayClient;
let owner: PlatformActor;
let operator: PlatformActor;
const signer = new JobSigner(randomBytes(32).toString('hex'));
const keyring = new Keyring({ primaryKeyId: 'test', keys: { test: randomBytes(32) } });
const clock: Clock = { now: () => new Date() };

function config(): RazorpayConfig {
  return {
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    webhookSecrets: ['unused-in-these-tests'],
    recurringCardsEnabled: false,
    subscriptionsEnabled: true,
    apiBaseUrl: standIn.baseUrl,
    mode: 'test',
  };
}
function notices(): BillingNoticeDeps {
  return { outbox: { keyring, jobs: new PgBossJobQueue(boss), signer }, appBaseUrl: APP_BASE };
}
const admin = () => createPlanAdminService({ platformDb: dbs.platform, clock, razorpay });
const choices = (subscriptionsEnabled = true) =>
  createPlanChoicesService({ db: dbs.app, clock, subscriptionsEnabled });
const subscriptions = () =>
  createPlanSubscriptionService({
    db: dbs.app,
    clock,
    razorpay,
    razorpayConfig: config(),
    notices: notices(),
  });
const teams = () => createTeamsService({ db: dbs.app, clock });

async function adminQuery<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await dbs.adminPool.query<T>(text, params)).rows;
}

async function platformActor(role: PlatformActor['role'], name: string): Promise<PlatformActor> {
  const user = await createUser(dbs, { name, twoFactor: true });
  await dbs.ownerPool.query('INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, $2)', [
    user.id,
    role,
  ]);
  return { userId: user.id, role, correlationId: uuidv7() };
}

/** A member's context as a browser session that started `minutesAgo` minutes ago. */
function signedIn(tenant: TestTenant, user: TestUser, minutesAgo: number | null = 0) {
  return resolveTenantContext(
    { db: dbs.app, clock, mfaGracePeriodHours: 72 },
    {
      userId: user.id,
      sessionId: `sess_${user.id}`,
      sessionCreatedAt: minutesAgo === null ? null : new Date(Date.now() - minutesAgo * 60_000),
      tenantSlug: tenant.slug,
      correlationId: uuidv7(),
    },
  );
}

let codes = 0;
interface Terms {
  name?: string;
  price?: string;
  seatsIncluded?: string;
  seatPrice?: string;
  numbersIncluded?: string;
  teamsMax?: string;
  modules?: string[];
}
/** A published plan version (not offered). */
async function publishedPlan(terms: Terms = {}): Promise<string> {
  codes += 1;
  const { id } = await admin().createPlan(owner, {
    code: `choice-${Date.now().toString(36)}-${codes}`,
    name: terms.name ?? 'Starter',
    price: terms.price ?? '999',
    intervalMonths: '1',
    trialDays: '14',
    graceDays: '7',
    seatsIncluded: terms.seatsIncluded ?? '3',
    seatPrice: terms.seatPrice ?? '100',
    numbersIncluded: terms.numbersIncluded ?? '1',
    teamsMax: terms.teamsMax ?? '',
    modules: terms.modules ?? [],
  });
  await admin().publishPlan(owner, id);
  return id;
}
/** A published version platform owners offer to companies. */
async function offeredPlan(terms: Terms = {}): Promise<string> {
  const id = await publishedPlan(terms);
  await admin().offerPlan(owner, id);
  return id;
}

interface Company {
  tenant: TestTenant;
  tenantId: string;
  owner: TestUser;
  ctx: TenantContext;
  starterId: string;
  trialEndsAt: Date;
}

/** A company on a staff-set trial of Starter, with one extra seat, ending in ten days. */
async function trialCompany(starterTerms: Terms = {}): Promise<Company> {
  const starterId = await publishedPlan(starterTerms);
  const user = await createUser(dbs, { name: 'Plan Choice Owner' });
  const tenant = await createTenant(dbs, user);
  const view = await admin().tenantPlan(owner, tenant.id);
  await admin().setTenantPlan(owner, {
    tenantId: tenant.id,
    version: view.state.version,
    reason: 'Trial agreed on the sales call',
    status: 'trialing',
    planId: starterId,
    trialEndsOn: dayOf(new Date(Date.now() + 10 * DAY_MS), 'Asia/Kolkata'),
    extraSeats: '1',
  });
  const [state] = await adminQuery<{ trial_ends_at: Date }>(
    'SELECT trial_ends_at FROM app.tenant_plans WHERE tenant_id = $1',
    [tenant.id],
  );
  return {
    tenant,
    tenantId: tenant.id,
    owner: user,
    ctx: await signedIn(tenant, user),
    starterId,
    trialEndsAt: state!.trial_ends_at,
  };
}

async function member(c: Company, role: string, name: string): Promise<TestUser> {
  const user = await createUser(dbs, { name });
  const { token } = await invite(dbs, c.tenant, c.owner, user.email, [role]);
  await acceptInvitation(dbs, user, token);
  return user;
}

async function stateOf(tenantId: string) {
  const [row] = await adminQuery<{
    id: string;
    plan_id: string | null;
    status: string;
    trial_ends_at: Date | null;
    extra_seats: number;
    usage_anchor: Date;
    note: string | null;
    changed_by_user_id: string | null;
    version: number;
  }>('SELECT * FROM app.tenant_plans WHERE tenant_id = $1', [tenantId]);
  return row!;
}

const audits = (tenantId: string, action: string) =>
  adminQuery<{ actor_type: string; actor_id: string; metadata: Record<string, unknown> }>(
    'SELECT actor_type, actor_id, metadata FROM app.audit_events WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id',
    [tenantId, action],
  );

async function refused(promise: Promise<unknown>, code: string, message?: RegExp) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, 'expected a refusal').not.toBeNull();
  expect(isAppError(error) ? error.code : error).toBe(code);
  if (message && isAppError(error)) expect(error.message).toMatch(message);
}

/** A second session holding a lock until released, to show who waits for it. */
async function hold(statement: string, params: unknown[] = []) {
  const client = await dbs.adminPool.connect();
  await client.query('BEGIN');
  await client.query(statement, params);
  return async () => {
    await client.query('ROLLBACK');
    client.release();
  };
}

/** Whether the promise is still waiting after a while (it is waiting for a lock). */
async function stillWaiting(promise: Promise<unknown>, ms = 400): Promise<boolean> {
  const marker = Symbol('waiting');
  const outcome = await Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise((resolve) => setTimeout(() => resolve(marker), ms)),
  ]);
  return outcome === marker;
}

beforeAll(async () => {
  dbs = connectTestDatabases({ appPoolMax: 10 });
  boss = new PgBoss({
    connectionString: inject('dbUrls').app,
    schema: 'pgboss',
    migrate: false,
    createSchema: false,
    supervise: false,
    schedule: false,
    max: 3,
  });
  boss.on('error', () => undefined);
  await boss.start();
  standIn = await startRazorpayStandIn({ keyId: KEY_ID, keySecret: KEY_SECRET });
  razorpay = new RazorpayClient({
    baseUrl: standIn.baseUrl,
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    timeoutMs: 2_000,
  });
  owner = await platformActor('platform_owner', 'Plan Offering Owner');
  operator = await platformActor('platform_operator', 'Plan Reading Operator');
  await admin().setPlanTax(owner, { tax: '18', reason: 'GST on plan prices, ticket 9002' });
});

afterAll(async () => {
  await standIn.close();
  await boss.stop({ graceful: false });
  await dbs.close();
});

describe('offering plan versions to companies', () => {
  it('lets platform owners offer a published version and stop offering it, in the platform audit log; drafts, retired versions and versions under ₹1 are never offered, and retiring stops the offer', async () => {
    codes += 1;
    const { id: draft } = await admin().createPlan(owner, {
      code: `offer-${Date.now().toString(36)}-${codes}`,
      name: 'Growth',
      price: '1999',
      intervalMonths: '1',
      trialDays: '0',
      graceDays: '7',
      seatsIncluded: '5',
      numbersIncluded: '1',
      modules: [],
    });
    await refused(admin().offerPlan(owner, draft), 'precondition_failed', /published/);
    await admin().publishPlan(owner, draft);
    await refused(admin().offerPlan(operator, draft), 'forbidden');

    await admin().offerPlan(owner, draft);
    await admin().offerPlan(owner, draft);
    const [offered] = await adminQuery<{ offered_at: Date | null; offered_by_user_id: string }>(
      'SELECT offered_at, offered_by_user_id FROM ops.plans WHERE id = $1',
      [draft],
    );
    expect(offered!.offered_at).not.toBeNull();
    expect(offered!.offered_by_user_id).toBe(owner.userId);
    const listed = await admin().listPlans(owner);
    expect(listed.plans.find((p) => p.id === draft)?.offeredAt).not.toBeNull();
    const platformAudits = (action: string) =>
      adminQuery<{ actor_user_id: string }>(
        `SELECT actor_user_id FROM ops.platform_audit_events WHERE action = $1 AND metadata->>'planId' = $2`,
        [action, draft],
      );
    // Offering twice records one offer.
    expect(await platformAudits('platform.plan_offered')).toEqual([
      { actor_user_id: owner.userId },
    ]);

    await refused(admin().withdrawPlanOffer(operator, draft), 'forbidden');
    await admin().withdrawPlanOffer(owner, draft);
    expect(
      (await adminQuery('SELECT 1 FROM ops.plans WHERE id = $1 AND offered_at IS NULL', [draft]))
        .length,
    ).toBe(1);
    expect(await platformAudits('platform.plan_offer_withdrawn')).toHaveLength(1);

    // Retiring an offered version stops the offer in the same update.
    await admin().offerPlan(owner, draft);
    await admin().retirePlan(owner, draft, { reason: 'Replaced by version 2 of Growth' });
    const [retired] = await adminQuery<{ status: string; offered_at: Date | null }>(
      'SELECT status, offered_at FROM ops.plans WHERE id = $1',
      [draft],
    );
    expect(retired).toEqual({ status: 'retired', offered_at: null });
    await refused(admin().offerPlan(owner, draft), 'precondition_failed', /published/);

    // A free version could never be paid for, so it is never offered.
    const free = await publishedPlan({ price: '0', seatPrice: '' });
    await refused(admin().offerPlan(owner, free), 'precondition_failed', /under ₹1/);
  });

  it('keeps the offer rules in the table and the guard, whatever the platform service does', async () => {
    const published = await publishedPlan();
    const free = await publishedPlan({ price: '0', seatPrice: '' });
    codes += 1;
    const { id: draft } = await admin().createPlan(owner, {
      code: `offer-sql-${Date.now().toString(36)}-${codes}`,
      name: 'Draft',
      price: '999',
      intervalMonths: '1',
      trialDays: '0',
      graceDays: '7',
      seatsIncluded: '1',
      numbersIncluded: '1',
      modules: [],
    });
    const asPlatform = (statement: ReturnType<typeof sql>) =>
      dbs.platform.run(owner.userId, (tx) => tx.execute(statement));
    const offer = (id: string) =>
      asPlatform(
        sql`UPDATE ops.plans SET offered_at = now(), offered_by_user_id = ${owner.userId} WHERE id = ${id}::uuid`,
      );
    // The constraint or the message of the PostgreSQL error under the query error.
    const failure = (promise: Promise<unknown>) =>
      promise.then(
        () => 'accepted',
        (e: unknown) => {
          let current: unknown = e;
          for (let depth = 0; depth < 5 && current; depth += 1) {
            const pgError = current as { code?: unknown; constraint?: string; message?: string };
            if (typeof pgError.code === 'string' && /^(23|W3)/.test(pgError.code)) {
              return pgError.constraint ?? pgError.message ?? '';
            }
            current = (current as { cause?: unknown }).cause;
          }
          return String(e);
        },
      );
    // Only the offer may change on a published version; its terms stay as published.
    await offer(published);
    expect(
      await failure(
        asPlatform(
          sql`UPDATE ops.plans SET name = 'Renamed', offered_at = NULL, offered_by_user_id = NULL WHERE id = ${published}::uuid`,
        ),
      ),
    ).toMatch(/cannot change/);
    expect(await failure(offer(draft))).toBe('plans_offer_published');
    expect(await failure(offer(free))).toBe('plans_offer_published');
    expect(
      await failure(
        asPlatform(sql`UPDATE ops.plans SET offered_at = now() WHERE id = ${draft}::uuid`),
      ),
    ).toBe('plans_offer_by');
    // Retiring without stopping the offer is refused.
    expect(
      await failure(
        asPlatform(
          sql`UPDATE ops.plans SET status = 'retired', retired_at = now(), retired_by_user_id = ${owner.userId} WHERE id = ${published}::uuid`,
        ),
      ),
    ).toBe('plans_offer_published');
    // The rebuilt guard still keeps a retired version retired and the default trial published,
    // whatever the platform service checks first.
    const retired = await publishedPlan({ name: 'Retired' });
    await admin().retirePlan(owner, retired, { reason: 'Replaced by version 2 of Retired' });
    expect(
      await failure(
        asPlatform(sql`UPDATE ops.plans SET status = 'published' WHERE id = ${retired}::uuid`),
      ),
    ).toMatch(/cannot change/);
    const trial = await publishedPlan({ name: 'Default trial' });
    await admin().setDefaultTrial(owner, { planId: trial });
    try {
      expect(
        await failure(
          asPlatform(
            sql`UPDATE ops.plans SET status = 'retired', retired_at = now(), retired_by_user_id = ${owner.userId} WHERE id = ${trial}::uuid`,
          ),
        ),
      ).toMatch(/default trial/);
    } finally {
      // Companies created later start on no default trial, as the other tests expect.
      await admin().setDefaultTrial(owner, { planId: '' });
    }
  });
});

describe('choosing a plan', () => {
  it('lets a billing manager on a trial see the offered versions with prices and fit and choose one: only the version changes, it is audited, and the company then pays for the chosen version', async () => {
    const c = await trialCompany();
    const growth = await offeredPlan({ name: 'Growth', price: '1999', seatsIncluded: '5' });
    const billingUser = await member(c, 'billing', 'Billing Person');
    const manager = await signedIn(c.tenant, billingUser);
    const before = await stateOf(c.tenantId);

    const offer = await choices().choices(manager);
    expect(offer.unavailable).toBeNull();
    expect(offer.status).toBe('trialing');
    expect(offer.currentPlan).toEqual({ id: c.starterId, name: 'Starter' });
    expect(offer.addOns).toEqual({ extraSeats: 1, extraNumbers: 0, runPacks: 0 });
    // The owner and the billing member hold two seats.
    expect(offer.holdings).toEqual({ seats: 2, numbers: 0, teams: 0, liveAutomations: 0 });
    const choice = offer.choices.find((p) => p.id === growth)!;
    expect(choice).toMatchObject({
      name: 'Growth',
      priceMinor: 199_900,
      seatsIncluded: 5,
      current: false,
      shortfalls: [],
    });
    // ₹1,999 and the extra seat at ₹100, plus 18% tax.
    expect(choice.quote).toEqual({
      ok: true,
      quote: expect.objectContaining({
        subtotalMinor: 209_900,
        taxMinor: 37_782,
        totalMinor: 247_682,
      }),
    });
    // Starter is not offered, so it is not listed.
    expect(offer.choices.some((p) => p.id === c.starterId)).toBe(false);

    expect(await choices().choose(manager, { planId: growth })).toEqual({
      changed: true,
      planName: 'Growth',
      quote: expect.objectContaining({ totalMinor: 247_682 }),
    });
    const after = await stateOf(c.tenantId);
    expect(after).toEqual({
      ...before,
      plan_id: growth,
      note: 'Chosen by the company.',
      changed_by_user_id: billingUser.id,
      changed_at: expect.any(Date),
      version: before.version + 1,
    });
    expect(await audits(c.tenantId, 'billing.plan_chosen')).toEqual([
      {
        actor_type: 'user',
        actor_id: billingUser.id,
        metadata: { previousPlanId: c.starterId, planId: growth, planStatus: 'trialing' },
      },
    ]);

    // The chosen version is the company's now; the same version again changes nothing.
    expect((await choices().choices(manager)).choices.find((p) => p.id === growth)).toMatchObject({
      current: true,
    });
    expect(await choices().choose(manager, { planId: growth })).toMatchObject({ changed: false });
    expect(await audits(c.tenantId, 'billing.plan_chosen')).toHaveLength(1);
    expect((await stateOf(c.tenantId)).version).toBe(before.version + 1);

    // Paying is for the chosen version, from the trial's end (ADR-102).
    const payment = await subscriptions().overview(manager);
    expect(payment.offer).toEqual({
      available: true,
      quote: expect.objectContaining({ totalMinor: 247_682 }),
      intervalMonths: 1,
      startsAt: c.trialEndsAt,
    });
    const started = await subscriptions().start(manager);
    const [subscription] = await adminQuery<{ plan_id: string; amount_minor: string }>(
      'SELECT plan_id, amount_minor FROM app.plan_subscriptions WHERE id = $1',
      [started.subscriptionId],
    );
    expect(subscription).toEqual({ plan_id: growth, amount_minor: '247682' });
    // A payment being started holds the choice until it is finished or its window closes.
    expect((await choices().choices(manager)).unavailable).toBe('payment_started');
    const other = await offeredPlan({ name: 'Scale', price: '2999' });
    await refused(
      choices().choose(manager, { planId: other }),
      'precondition_failed',
      /subscription that can still be charged/,
    );
    // So does every status in which Razorpay may still charge it, in SQL whatever the page shows.
    for (const status of ['authenticated', 'active', 'pending', 'halted', 'paused']) {
      await adminQuery('UPDATE app.plan_subscriptions SET status = $2 WHERE id = $1', [
        started.subscriptionId,
        status,
      ]);
      await refused(
        choices().choose(manager, { planId: other }),
        'precondition_failed',
        /subscription that can still be charged/,
      );
    }
    expect((await stateOf(c.tenantId)).plan_id).toBe(growth);
  });

  it('needs billing.manage and a sign-in within the last 15 minutes; the offer itself is read with billing.read', async () => {
    const c = await trialCompany();
    const growth = await offeredPlan({ name: 'Growth' });
    const admins = await signedIn(c.tenant, await member(c, 'admin', 'Admin Person'));
    const agent = await signedIn(c.tenant, await member(c, 'agent', 'Agent Person'));
    expect((await choices().choices(admins)).choices.some((p) => p.id === growth)).toBe(true);
    await refused(choices().choices(agent), 'forbidden');
    await refused(choices().choose(admins, { planId: growth }), 'forbidden');
    await refused(choices().choose(agent, { planId: growth }), 'forbidden');
    await refused(
      choices().choose(await signedIn(c.tenant, c.owner, 20), { planId: growth }),
      'step_up_required',
    );
    await refused(
      choices().choose(await signedIn(c.tenant, c.owner, null), { planId: growth }),
      'step_up_required',
    );
    await refused(choices().choose(c.ctx, { planId: 'not-a-plan' }), 'validation_failed');
    expect((await stateOf(c.tenantId)).plan_id).toBe(c.starterId);
    // Without Razorpay subscriptions, nothing can be chosen (it could not be paid for).
    expect((await choices(false).choices(c.ctx)).unavailable).toBe('not_offered');
    await refused(choices(false).choose(c.ctx, { planId: growth }), 'precondition_failed');
    expect((await stateOf(c.tenantId)).plan_id).toBe(c.starterId);
  });

  it('is refused in SQL for a version not offered, a paid period, complimentary access, a company suspended or being deleted, no tax on plan prices, and outside a member’s company scope', async () => {
    const c = await trialCompany();
    const growth = await offeredPlan({ name: 'Growth' });
    const notOffered = await publishedPlan({ name: 'Hidden' });
    await refused(
      choices().choose(c.ctx, { planId: notOffered }),
      'precondition_failed',
      /not offered/,
    );
    await refused(
      choices().choose(c.ctx, { planId: c.starterId }),
      'precondition_failed',
      /not offered/,
    );
    await refused(
      choices().choose(c.ctx, { planId: uuidv7() }),
      'precondition_failed',
      /not offered/,
    );
    const withdrawn = await offeredPlan({ name: 'Withdrawn' });
    await admin().withdrawPlanOffer(owner, withdrawn);
    await refused(
      choices().choose(c.ctx, { planId: withdrawn }),
      'precondition_failed',
      /not offered/,
    );
    // A version that does not sell the company's extra seat has no price for it, and the plan
    // state's own guard refuses it.
    const noExtras = await offeredPlan({ name: 'No extras', seatPrice: '' });
    expect(
      (await choices().choices(c.ctx)).choices.find((p) => p.id === noExtras)?.quote,
    ).toMatchObject({ ok: false });
    await refused(
      choices().choose(c.ctx, { planId: noExtras }),
      'precondition_failed',
      /does not sell that many extra seats/,
    );

    // No tax on plan prices: paying for plans is not set up, so nothing can be chosen.
    await adminQuery('UPDATE ops.plan_settings SET plan_tax_bp = NULL');
    try {
      expect((await choices().choices(c.ctx)).unavailable).toBe('not_offered');
      await refused(
        choices().choose(c.ctx, { planId: growth }),
        'precondition_failed',
        /not available/,
      );
    } finally {
      await adminQuery('UPDATE ops.plan_settings SET plan_tax_bp = 1800');
    }

    // The function needs a member in the company's own scope, whatever the web checks.
    await expect(
      dbs.app.run(authorizedTenantScope(c.tenantId, null), (tx) =>
        tx.execute(sql`select * from app.choose_plan(${growth}::uuid)`),
      ),
    ).rejects.toThrow(/chosen by a member/);
    await expect(
      dbs.app.run(authorizedTenantScope(c.tenantId, c.owner.id), (tx) =>
        tx.execute(sql`select * from app.choose_plan(${notOffered}::uuid)`),
      ),
    ).rejects.toThrow(/not offered/);

    // A company suspended by HyFib, or being deleted, keeps its plan.
    await adminQuery("UPDATE app.tenants SET status = 'suspended' WHERE id = $1", [c.tenantId]);
    const suspended = await signedIn(c.tenant, c.owner);
    expect((await choices().choices(suspended)).unavailable).toBe('suspended');
    await refused(
      choices().choose(suspended, { planId: growth }),
      'precondition_failed',
      /suspended/,
    );
    await adminQuery("UPDATE app.tenants SET status = 'pending_deletion' WHERE id = $1", [
      c.tenantId,
    ]);
    const deleting = await signedIn(c.tenant, c.owner);
    expect((await choices().choices(deleting)).unavailable).toBe('deleting');
    await refused(
      choices().choose(deleting, { planId: growth }),
      'precondition_failed',
      /being deleted/,
    );
    await adminQuery("UPDATE app.tenants SET status = 'active' WHERE id = $1", [c.tenantId]);

    // A paid period, or complimentary access, is not the company's to change here.
    const view = await admin().tenantPlan(owner, c.tenantId);
    await admin().setTenantPlan(owner, {
      tenantId: c.tenantId,
      version: view.state.version,
      reason: 'Invoice INV-2026-0099 paid by bank transfer',
      status: 'active',
      planId: c.starterId,
      periodStart: dayOf(new Date(), 'Asia/Kolkata'),
      periodEnd: dayOf(new Date(Date.now() + 30 * DAY_MS), 'Asia/Kolkata'),
      extraSeats: '0',
    });
    const paidCtx = await signedIn(c.tenant, c.owner);
    expect((await choices().choices(paidCtx)).unavailable).toBe('paid_period');
    await refused(
      choices().choose(paidCtx, { planId: growth }),
      'precondition_failed',
      /paid period/,
    );
    const view2 = await admin().tenantPlan(owner, c.tenantId);
    await admin().setTenantPlan(owner, {
      tenantId: c.tenantId,
      version: view2.state.version,
      reason: 'Partner programme, complimentary for a year',
      status: 'complimentary',
    });
    const free = await signedIn(c.tenant, c.owner);
    expect((await choices().choices(free)).unavailable).toBe('complimentary');
    await refused(
      choices().choose(free, { planId: growth }),
      'precondition_failed',
      /complimentary/,
    );
    expect((await stateOf(c.tenantId)).plan_id).toBeNull();
  });

  it('refuses a version that holds less than the company has: seats counted with waiting invitations, and teams; holding exactly the limit fits', async () => {
    const c = await trialCompany({ teamsMax: '' });
    // One seat, no teams: with its one extra seat, two seats in all.
    const solo = await offeredPlan({ name: 'Solo', seatsIncluded: '1', teamsMax: '0' });
    await member(c, 'billing', 'Second Member');
    await invite(dbs, c.tenant, c.owner, `third-${Date.now()}@example.test`, ['agent']);
    const choice = (await choices().choices(c.ctx)).choices.find((p) => p.id === solo)!;
    expect(choice.shortfalls).toEqual([{ kind: 'seats', limit: 2, used: 3 }]);
    await refused(
      choices().choose(c.ctx, { planId: solo }),
      'precondition_failed',
      /Solo holds less than your company has now: 2 seats, where your company uses 3 \(members and invitations still waiting\)/,
    );
    expect((await stateOf(c.tenantId)).plan_id).toBe(c.starterId);
    expect(await audits(c.tenantId, 'billing.plan_chosen')).toEqual([]);

    // Without the waiting invitation two seats are used, which fits; a team does not (none).
    await adminQuery(
      "UPDATE app.invitations SET status = 'revoked' WHERE tenant_id = $1 AND status = 'pending'",
      [c.tenantId],
    );
    const { teamId } = await teams().createTeam(c.ctx, { name: 'Front desk' });
    await refused(
      choices().choose(c.ctx, { planId: solo }),
      'precondition_failed',
      /Solo holds less than your company has now: 0 teams, where your company uses 1\./,
    );
    expect((await stateOf(c.tenantId)).plan_id).toBe(c.starterId);
    // Exactly two seats and no team fit.
    await teams().deleteTeam(c.ctx, teamId);
    expect(await choices().choose(c.ctx, { planId: solo })).toMatchObject({ changed: true });
    expect((await stateOf(c.tenantId)).plan_id).toBe(solo);
  });

  it('lets a company whose plan ended choose while restricted: it stays restricted until it pays for the chosen version, charged at once', async () => {
    const c = await trialCompany();
    const growth = await offeredPlan({ name: 'Growth', price: '1999' });
    const view = await admin().tenantPlan(owner, c.tenantId);
    await admin().setTenantPlan(owner, {
      tenantId: c.tenantId,
      version: view.state.version,
      reason: 'Trial ended early at the company’s request',
      status: 'canceled',
    });
    const ctx = await signedIn(c.tenant, c.owner);
    expect(ctx.tenant.status).toBe('restricted');
    expect((await choices().choices(ctx)).unavailable).toBeNull();
    const chosen = await choices().choose(ctx, { planId: growth });
    expect(chosen).toMatchObject({ changed: true });
    const after = await stateOf(c.tenantId);
    expect(after).toMatchObject({ plan_id: growth, status: 'canceled' });
    const [company] = await adminQuery<{ status: string }>(
      'SELECT status FROM app.tenants WHERE id = $1',
      [c.tenantId],
    );
    expect(company!.status).toBe('restricted');
    const payment = await subscriptions().overview(await signedIn(c.tenant, c.owner));
    expect(payment.offer).toMatchObject({
      available: true,
      quote: expect.objectContaining({ totalMinor: chosen.quote!.totalMinor }),
      startsAt: null,
    });
  });

  it('waits for a subscription start, a limit’s addition and a staff change, which therefore never interleave with a choice', async () => {
    const c = await trialCompany();
    const growth = await offeredPlan({ name: 'Growth' });
    const scale = await offeredPlan({ name: 'Scale', price: '2999' });
    const pro = await offeredPlan({ name: 'Pro', price: '3999' });

    // The lock a subscription start takes.
    let release = await hold(
      "SELECT pg_advisory_xact_lock(hashtextextended('w360:plan-subscriptions:' || $1::text, 0))",
      [c.tenantId],
    );
    let choosing = choices().choose(c.ctx, { planId: growth });
    expect(await stillWaiting(choosing)).toBe(true);
    await release();
    expect(await choosing).toMatchObject({ changed: true });

    // The lock an addition of a seat takes.
    release = await hold(
      "SELECT pg_advisory_xact_lock(hashtextextended('seats:' || $1::text, 0))",
      [c.tenantId],
    );
    choosing = choices().choose(c.ctx, { planId: scale });
    expect(await stillWaiting(choosing)).toBe(true);
    await release();
    expect(await choosing).toMatchObject({ changed: true });

    // A staff change holds the company row: the choice waits for it before it locks the plan state
    // (the order staff changes and the plan sweep take), so the two never deadlock.
    const staff = await dbs.adminPool.connect();
    let planStateFree: boolean | undefined;
    try {
      await staff.query('BEGIN');
      await staff.query('SELECT 1 FROM app.tenants WHERE id = $1 FOR UPDATE', [c.tenantId]);
      choosing = choices().choose(c.ctx, { planId: growth });
      expect(await stillWaiting(choosing)).toBe(true);
      planStateFree = await staff
        .query('SELECT 1 FROM app.tenant_plans WHERE tenant_id = $1 FOR UPDATE NOWAIT', [
          c.tenantId,
        ])
        .then(
          () => true,
          () => false,
        );
    } finally {
      await staff.query('ROLLBACK');
      staff.release();
    }
    expect(planStateFree).toBe(true);
    expect(await choosing).toMatchObject({ changed: true });

    // Two choices at once, both of another version: each is applied in turn, and each is audited.
    const [first, second] = await Promise.all([
      choices().choose(c.ctx, { planId: scale }),
      choices().choose(await signedIn(c.tenant, c.owner), { planId: pro }),
    ]);
    expect([first.changed, second.changed]).toEqual([true, true]);
    expect([scale, pro]).toContain((await stateOf(c.tenantId)).plan_id);
    expect(await audits(c.tenantId, 'billing.plan_chosen')).toHaveLength(5);

    // A staff change committed while the choice waits for the plan state is seen by it: the choice
    // reads the plan state under its lock, so neither change is lost.
    const version = (await stateOf(c.tenantId)).version;
    const staffChange = await dbs.adminPool.connect();
    try {
      await staffChange.query('BEGIN');
      await staffChange.query(
        "UPDATE app.tenant_plans SET note = 'Changed by staff meanwhile', version = version + 1 WHERE tenant_id = $1",
        [c.tenantId],
      );
      choosing = choices().choose(c.ctx, { planId: growth });
      expect(await stillWaiting(choosing)).toBe(true);
      await staffChange.query('COMMIT');
    } catch (error) {
      await staffChange.query('ROLLBACK');
      throw error;
    } finally {
      staffChange.release();
    }
    expect(await choosing).toMatchObject({ changed: true });
    expect(await stateOf(c.tenantId)).toMatchObject({ plan_id: growth, version: version + 2 });
    expect(await audits(c.tenantId, 'billing.plan_chosen')).toHaveLength(6);
  });

  it('does not tell a staff change made before the company chose, and leaves other companies’ plans alone; the company role cannot change its plan any other way', async () => {
    const c = await trialCompany();
    const other = await trialCompany();
    const growth = await offeredPlan({ name: 'Growth' });
    const staffPlan = await publishedPlan({ name: 'Staff pick' });
    // Both companies are on the same version, so a choice that reached past its own company shows.
    for (const company of [c, other]) {
      const view = await admin().tenantPlan(owner, company.tenantId);
      await admin().setTenantPlan(owner, {
        tenantId: company.tenantId,
        version: view.state.version,
        reason: 'Moved to the plan agreed on the call',
        status: 'trialing',
        planId: staffPlan,
        trialEndsOn: dayOf(new Date(Date.now() + 10 * DAY_MS), 'Asia/Kolkata'),
        extraSeats: '0',
      });
    }
    expect(
      await choices().choose(await signedIn(c.tenant, c.owner), { planId: growth }),
    ).toMatchObject({
      changed: true,
    });
    // Repeat the sweep until nothing is left, as the minute sweeps would.
    let superseded = 0;
    for (let round = 0; round < 20; round += 1) {
      const result = await notifyStaffPlanChanges({ db: dbs.app, notices: notices() });
      superseded += result.superseded;
      if (result.notified === 0 && result.superseded === 0) break;
    }
    expect(superseded).toBeGreaterThanOrEqual(1);
    const [marked] = await adminQuery<{ staff_notice_version: number | null }>(
      'SELECT staff_notice_version FROM app.tenant_plans WHERE tenant_id = $1',
      [c.tenantId],
    );
    expect(marked!.staff_notice_version).toBeNull();
    const told = await adminQuery(
      `SELECT 1 FROM ops.email_outbox WHERE tenant_id = $1 AND kind = 'billing.notice'`,
      [c.tenantId],
    );
    expect(told).toEqual([]);

    expect(await stateOf(other.tenantId)).toMatchObject({
      plan_id: staffPlan,
      note: 'Moved to the plan agreed on the call',
    });
    await expect(
      dbs.app.run(authorizedTenantScope(c.tenantId, c.owner.id), (tx) =>
        tx.execute(sql`update app.tenant_plans set plan_id = ${growth}::uuid`),
      ),
    ).rejects.toThrow(/not permitted/);
  });
});
