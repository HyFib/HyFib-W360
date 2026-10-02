import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { Keyring, isAppError, uuidv7, type Clock, type RazorpayConfig } from '@w360/core';
import { authorizedTenantScope, sql } from '@w360/db';
import {
  JobSigner,
  PgBossJobQueue,
  RazorpayClient,
  createPlanAddOnsService,
  createPlanAdminService,
  createPlanSubscriptionService,
  dayOf,
  notifyStaffPlanChanges,
  resolveTenantContext,
  usagePeriod,
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
 * Companies choosing their add-ons (P5-01/P5-07, ADR-106) against real PostgreSQL and the test-only
 * Razorpay stand-in: owners and billing managers with a recent sign-in set the extra seats, extra
 * WhatsApp numbers and automation run packs of their plan version on a trial or after the plan
 * ended, then pay for them with the plan; a decrease cannot leave less than the company uses;
 * `app.choose_add_ons` refuses everything else in SQL, under the locks a subscription start, staff
 * changes and additions take.
 */
const KEY_ID = 'rzp_test_StandIn00000084';
const KEY_SECRET = randomBytes(16).toString('hex');
const APP_BASE = 'http://localhost:3000';
const DAY_MS = 86_400_000;

let dbs: TestDatabases;
let boss: PgBoss;
let standIn: RazorpayStandIn;
let razorpay: RazorpayClient;
let owner: PlatformActor;
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
const addOns = (subscriptionsEnabled = true) =>
  createPlanAddOnsService({ db: dbs.app, clock, subscriptionsEnabled });
const subscriptions = () =>
  createPlanSubscriptionService({
    db: dbs.app,
    clock,
    razorpay,
    razorpayConfig: config(),
    notices: notices(),
  });

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
  seatsMax?: string;
  numbersIncluded?: string;
  numberPrice?: string;
  numbersMax?: string;
  runPackSize?: string;
  runPackPrice?: string;
}
/** A published plan version selling every add-on unless the terms say otherwise. */
async function publishedPlan(terms: Terms = {}): Promise<string> {
  codes += 1;
  const { id } = await admin().createPlan(owner, {
    code: `add-ons-${Date.now().toString(36)}-${codes}`,
    name: terms.name ?? 'Starter',
    price: terms.price ?? '999',
    intervalMonths: '1',
    trialDays: '14',
    graceDays: '7',
    seatsIncluded: terms.seatsIncluded ?? '3',
    seatPrice: terms.seatPrice ?? '100',
    seatsMax: terms.seatsMax ?? '',
    numbersIncluded: terms.numbersIncluded ?? '1',
    numberPrice: terms.numberPrice ?? '500',
    numbersMax: terms.numbersMax ?? '',
    automationRunsMonthly: '1000',
    runPackSize: terms.runPackSize ?? '500',
    runPackPrice: terms.runPackPrice ?? '250',
    modules: [],
  });
  await admin().publishPlan(owner, id);
  return id;
}

interface Company {
  tenant: TestTenant;
  tenantId: string;
  owner: TestUser;
  ctx: TenantContext;
  planId: string;
}

/** A company on a staff-set trial of a version (not offered), with `extraSeats` extra seats. */
async function trialCompany(terms: Terms = {}, extraSeats = '1'): Promise<Company> {
  const planId = await publishedPlan(terms);
  const user = await createUser(dbs, { name: 'Add-ons Owner' });
  const tenant = await createTenant(dbs, user);
  await staffSet(tenant.id, {
    reason: 'Trial agreed on the sales call',
    status: 'trialing',
    planId,
    trialEndsOn: dayOf(new Date(Date.now() + 10 * DAY_MS), 'Asia/Kolkata'),
    extraSeats,
  });
  return { tenant, tenantId: tenant.id, owner: user, ctx: await signedIn(tenant, user), planId };
}

/** A staff change of the company's plan from its platform page (ADR-051). */
async function staffSet(tenantId: string, change: Record<string, string>) {
  const view = await admin().tenantPlan(owner, tenantId);
  await admin().setTenantPlan(owner, { tenantId, version: view.state.version, ...change });
}

async function member(c: Company, role: string, name: string): Promise<TestUser> {
  const user = await createUser(dbs, { name });
  const { token } = await invite(dbs, c.tenant, c.owner, user.email, [role]);
  await acceptInvitation(dbs, user, token);
  return user;
}

/** Connected WhatsApp numbers (they count against the plan's numbers). */
async function connectNumbers(tenantId: string, count: number) {
  const accountId = uuidv7();
  await adminQuery(
    `INSERT INTO app.whatsapp_accounts (id, tenant_id, waba_id) VALUES ($1, $2, $3)`,
    [accountId, tenantId, String(Date.now()).slice(-12)],
  );
  for (let i = 0; i < count; i += 1) {
    await adminQuery(
      `INSERT INTO app.channel_accounts (id, tenant_id, whatsapp_account_id, phone_number_id, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [uuidv7(), tenantId, accountId, `${Date.now()}${i}`.slice(-15)],
    );
  }
}

async function stateOf(tenantId: string) {
  const [row] = await adminQuery<{
    id: string;
    plan_id: string | null;
    status: string;
    extra_seats: number;
    extra_numbers: number;
    run_packs: number;
    usage_anchor: Date;
    note: string | null;
    changed_by_user_id: string | null;
    version: number;
  }>('SELECT * FROM app.tenant_plans WHERE tenant_id = $1', [tenantId]);
  return row!;
}

async function limitsOf(tenantId: string) {
  const [row] = await adminQuery<{ seats: number; numbers: number; automation_runs: number }>(
    'SELECT seats, numbers, automation_runs FROM app.tenant_entitlements($1)',
    [tenantId],
  );
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

const quantities = (
  extraSeats: number,
  extraNumbers: number,
  runPacks: number,
  apiRequestPacks = 0,
) => ({
  extraSeats: String(extraSeats),
  extraNumbers: String(extraNumbers),
  runPacks: String(runPacks),
  apiRequestPacks: String(apiRequestPacks),
});

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
  owner = await platformActor('platform_owner', 'Add-ons Plan Owner');
  await admin().setPlanTax(owner, { tax: '18', reason: 'GST on plan prices, ticket 9003' });
});

afterAll(async () => {
  await standIn.close();
  await boss.stop({ graceful: false });
  await dbs.close();
});

describe('choosing add-ons', () => {
  it('lets a billing manager on a trial see what its version sells and choose add-ons: only the quantities change, at once, audited, and the company then pays for them with its plan', async () => {
    const c = await trialCompany();
    const billingUser = await member(c, 'billing', 'Billing Person');
    const manager = await signedIn(c.tenant, billingUser);
    const before = await stateOf(c.tenantId);

    const view = await addOns().addOns(manager);
    expect(view.unavailable).toBeNull();
    expect(view.status).toBe('trialing');
    expect(view.plan).toEqual({
      id: c.planId,
      name: 'Starter',
      intervalMonths: 1,
      priceMinor: 99_900,
      seatPriceMinor: 10_000,
      numberPriceMinor: 50_000,
      runPackPriceMinor: 25_000,
      apiRequestPackPriceMinor: null,
    });
    // The owner and the billing member hold two of the three seats included.
    expect(view.options).toEqual([
      {
        kind: 'seats',
        quantity: 1,
        min: 0,
        max: 10_000,
        unitPriceMinor: 10_000,
        unitSize: 1,
        included: 3,
        used: 2,
      },
      {
        kind: 'numbers',
        quantity: 0,
        min: 0,
        max: 99,
        unitPriceMinor: 50_000,
        unitSize: 1,
        included: 1,
        used: 0,
      },
      {
        kind: 'runPacks',
        quantity: 0,
        min: 0,
        max: 10_000,
        unitPriceMinor: 25_000,
        unitSize: 500,
        included: 1000,
        used: null,
      },
    ]);
    // ₹999 and the extra seat at ₹100, plus 18% tax.
    expect(view.taxBp).toBe(1800);
    expect(view.quote).toEqual({
      ok: true,
      quote: expect.objectContaining({ subtotalMinor: 109_900, totalMinor: 129_682 }),
    });

    // ₹999, 4 seats at ₹100, 2 numbers at ₹500 and 3 run packs at ₹250: ₹3,149 and ₹566.82 tax.
    expect(await addOns().choose(manager, quantities(4, 2, 3))).toEqual({
      changed: true,
      quote: expect.objectContaining({
        subtotalMinor: 314_900,
        taxMinor: 56_682,
        totalMinor: 371_582,
      }),
    });
    expect(await stateOf(c.tenantId)).toEqual({
      ...before,
      extra_seats: 4,
      extra_numbers: 2,
      run_packs: 3,
      note: 'Add-ons chosen by the company.',
      changed_by_user_id: billingUser.id,
      changed_at: expect.any(Date),
      version: before.version + 1,
    });
    // The limits change at once: 3 + 4 seats, 1 + 2 numbers, 1,000 + 3 × 500 runs a month.
    expect(await limitsOf(c.tenantId)).toEqual({ seats: 7, numbers: 3, automation_runs: 2500 });
    expect(await audits(c.tenantId, 'billing.add_ons_chosen')).toEqual([
      {
        actor_type: 'user',
        actor_id: billingUser.id,
        metadata: {
          planId: c.planId,
          planStatus: 'trialing',
          previous: { extraSeats: 1, extraNumbers: 0, runPacks: 0, apiRequestPacks: 0 },
          extraSeats: 4,
          extraNumbers: 2,
          runPacks: 3,
          apiRequestPacks: 0,
        },
      },
    ]);

    // The same quantities again change nothing.
    expect(await addOns().choose(manager, quantities(4, 2, 3))).toMatchObject({ changed: false });
    expect(await audits(c.tenantId, 'billing.add_ons_chosen')).toHaveLength(1);
    expect((await stateOf(c.tenantId)).version).toBe(before.version + 1);

    // Paying is for the version with these add-ons, from the trial's end (ADR-102).
    const payment = await subscriptions().overview(manager);
    expect(payment.offer).toMatchObject({
      available: true,
      quote: expect.objectContaining({ totalMinor: 371_582 }),
    });
    const started = await subscriptions().start(manager);
    const [subscription] = await adminQuery<{
      amount_minor: string;
      extra_seats: number;
      extra_numbers: number;
      run_packs: number;
    }>(
      'SELECT amount_minor, extra_seats, extra_numbers, run_packs FROM app.plan_subscriptions WHERE id = $1',
      [started.subscriptionId],
    );
    expect(subscription).toEqual({
      amount_minor: '371582',
      extra_seats: 4,
      extra_numbers: 2,
      run_packs: 3,
    });
    // A payment being started holds the add-ons until it is finished or its window closes, and so
    // does every status in which Razorpay may still charge it, in SQL whatever the page shows.
    expect((await addOns().addOns(manager)).unavailable).toBe('payment_started');
    await refused(
      addOns().choose(manager, quantities(5, 2, 3)),
      'precondition_failed',
      /subscription that can still be charged/,
    );
    for (const status of ['authenticated', 'active', 'pending', 'halted', 'paused']) {
      await adminQuery('UPDATE app.plan_subscriptions SET status = $2 WHERE id = $1', [
        started.subscriptionId,
        status,
      ]);
      await refused(
        addOns().choose(manager, quantities(5, 2, 3)),
        'precondition_failed',
        /subscription that can still be charged/,
      );
    }
    expect((await stateOf(c.tenantId)).extra_seats).toBe(4);
  });

  it('needs billing.manage and a sign-in within the last 15 minutes, takes whole numbers only, and is read with billing.read', async () => {
    const c = await trialCompany();
    const admins = await signedIn(c.tenant, await member(c, 'admin', 'Admin Person'));
    const agent = await signedIn(c.tenant, await member(c, 'agent', 'Agent Person'));
    expect((await addOns().addOns(admins)).options).toHaveLength(3);
    await refused(addOns().addOns(agent), 'forbidden');
    await refused(addOns().choose(admins, quantities(2, 0, 0)), 'forbidden');
    await refused(addOns().choose(agent, quantities(2, 0, 0)), 'forbidden');
    await refused(
      addOns().choose(await signedIn(c.tenant, c.owner, 20), quantities(2, 0, 0)),
      'step_up_required',
    );
    await refused(
      addOns().choose(await signedIn(c.tenant, c.owner, null), quantities(2, 0, 0)),
      'step_up_required',
    );
    for (const wrong of [
      { extraSeats: '-1', extraNumbers: '0', runPacks: '0', apiRequestPacks: '0' },
      { extraSeats: '1.5', extraNumbers: '0', runPacks: '0', apiRequestPacks: '0' },
      { extraSeats: '1e3', extraNumbers: '0', runPacks: '0', apiRequestPacks: '0' },
      { extraSeats: 'two', extraNumbers: '0', runPacks: '0', apiRequestPacks: '0' },
      { extraSeats: '10001', extraNumbers: '0', runPacks: '0', apiRequestPacks: '0' },
      { extraSeats: '0', extraNumbers: '101', runPacks: '0', apiRequestPacks: '0' },
      { extraSeats: '0', extraNumbers: '0', runPacks: '10001', apiRequestPacks: '0' },
      { extraSeats: '0', extraNumbers: '0', runPacks: '0', apiRequestPacks: '10001' },
      { extraSeats: '0', extraNumbers: '0', runPacks: '0', apiRequestPacks: '-1' },
      // Every quantity is sent: a missing one is refused rather than taken as none.
      { extraSeats: '0', extraNumbers: '0', runPacks: '0' },
    ]) {
      await refused(addOns().choose(c.ctx, wrong), 'validation_failed');
    }
    expect((await stateOf(c.tenantId)).extra_seats).toBe(1);
    // An empty field means none.
    expect(
      await addOns().choose(c.ctx, {
        extraSeats: '2',
        extraNumbers: '',
        runPacks: ' ',
        apiRequestPacks: '',
      }),
    ).toMatchObject({ changed: true });
    expect(await stateOf(c.tenantId)).toMatchObject({
      extra_seats: 2,
      extra_numbers: 0,
      run_packs: 0,
    });
    // Without Razorpay subscriptions, nothing can be chosen (it could not be paid for).
    expect((await addOns(false).addOns(c.ctx)).unavailable).toBe('not_offered');
    await refused(addOns(false).choose(c.ctx, quantities(3, 0, 0)), 'precondition_failed');
    expect((await stateOf(c.tenantId)).extra_seats).toBe(2);
  });

  it('keeps add-ons to what the version sells, within its maximums, and refuses a total that cannot be paid', async () => {
    const limited = await trialCompany(
      { seatsMax: '5', numbersMax: '3', runPackSize: '', runPackPrice: '' },
      '0',
    );
    expect((await addOns().addOns(limited.ctx)).options).toEqual([
      expect.objectContaining({ kind: 'seats', max: 2 }),
      expect.objectContaining({ kind: 'numbers', max: 2 }),
    ]);
    await refused(
      addOns().choose(limited.ctx, quantities(3, 0, 0)),
      'precondition_failed',
      /does not sell that many extra seats/,
    );
    await refused(
      addOns().choose(limited.ctx, quantities(0, 3, 0)),
      'precondition_failed',
      /does not sell that many extra WhatsApp numbers/,
    );
    await refused(
      addOns().choose(limited.ctx, quantities(0, 0, 1)),
      'precondition_failed',
      /does not sell automation run packs/,
    );
    expect(await addOns().choose(limited.ctx, quantities(2, 2, 0))).toMatchObject({
      changed: true,
    });

    const noNumbers = await trialCompany({ numberPrice: '' }, '0');
    expect((await addOns().addOns(noNumbers.ctx)).options.map((o) => o.kind)).toEqual([
      'seats',
      'runPacks',
    ]);
    await refused(
      addOns().choose(noNumbers.ctx, quantities(0, 1, 0)),
      'precondition_failed',
      /does not sell that many extra WhatsApp numbers/,
    );

    // ₹7,000,000,000 with one extra seat at ₹500,000,000 can be paid; with ten, the total and its
    // tax are more than one plan payment can be.
    const dear = await trialCompany({ price: '7000000000', seatPrice: '500000000' }, '0');
    expect(await addOns().choose(dear.ctx, quantities(1, 0, 0))).toMatchObject({ changed: true });
    await refused(
      addOns().choose(dear.ctx, quantities(10, 0, 0)),
      'precondition_failed',
      /^With these add-ons your plan costs more than can be paid here\./,
    );
    expect((await stateOf(dear.tenantId)).extra_seats).toBe(1);
    expect(await audits(dear.tenantId, 'billing.add_ons_chosen')).toHaveLength(1);
  });

  it('is refused in SQL for a retired version, a paid period, complimentary access, a company suspended or being deleted, no tax on plan prices, and outside a member’s company scope', async () => {
    const c = await trialCompany();

    // No tax on plan prices: paying for plans is not set up, so nothing can be chosen.
    await adminQuery('UPDATE ops.plan_settings SET plan_tax_bp = NULL');
    try {
      expect((await addOns().addOns(c.ctx)).unavailable).toBe('not_offered');
      await refused(
        addOns().choose(c.ctx, quantities(2, 0, 0)),
        'precondition_failed',
        /not available/,
      );
    } finally {
      await adminQuery('UPDATE ops.plan_settings SET plan_tax_bp = 1800');
    }

    // The function needs a member in the company's own scope, whatever the web checks.
    await expect(
      dbs.app.run(authorizedTenantScope(c.tenantId, null), (tx) =>
        tx.execute(sql`select * from app.choose_add_ons(2, 0, 0)`),
      ),
    ).rejects.toThrow(/chosen by a member/);

    // A company suspended by HyFib, or being deleted, keeps its add-ons.
    await adminQuery("UPDATE app.tenants SET status = 'suspended' WHERE id = $1", [c.tenantId]);
    const suspended = await signedIn(c.tenant, c.owner);
    expect((await addOns().addOns(suspended)).unavailable).toBe('suspended');
    await refused(
      addOns().choose(suspended, quantities(2, 0, 0)),
      'precondition_failed',
      /suspended/,
    );
    await adminQuery("UPDATE app.tenants SET status = 'pending_deletion' WHERE id = $1", [
      c.tenantId,
    ]);
    const deleting = await signedIn(c.tenant, c.owner);
    expect((await addOns().addOns(deleting)).unavailable).toBe('deleting');
    await refused(
      addOns().choose(deleting, quantities(2, 0, 0)),
      'precondition_failed',
      /being deleted/,
    );
    await adminQuery("UPDATE app.tenants SET status = 'active' WHERE id = $1", [c.tenantId]);

    // A retired version cannot be paid for, so its add-ons stay as staff left them.
    await admin().retirePlan(owner, c.planId, { reason: 'Replaced by version 2 of Starter' });
    const retired = await signedIn(c.tenant, c.owner);
    expect((await addOns().addOns(retired)).unavailable).toBe('plan_retired');
    await refused(
      addOns().choose(retired, quantities(2, 0, 0)),
      'precondition_failed',
      /no longer offered/,
    );
    expect((await stateOf(c.tenantId)).extra_seats).toBe(1);

    // A paid period, or complimentary access, is not the company's to change here.
    const current = await publishedPlan({ name: 'Current' });
    await staffSet(c.tenantId, {
      reason: 'Invoice INV-2026-0100 paid by bank transfer',
      status: 'active',
      planId: current,
      periodStart: dayOf(new Date(), 'Asia/Kolkata'),
      periodEnd: dayOf(new Date(Date.now() + 30 * DAY_MS), 'Asia/Kolkata'),
      extraSeats: '0',
    });
    const paid = await signedIn(c.tenant, c.owner);
    expect((await addOns().addOns(paid)).unavailable).toBe('paid_period');
    await refused(addOns().choose(paid, quantities(2, 0, 0)), 'precondition_failed', /paid period/);
    await staffSet(c.tenantId, {
      reason: 'Partner programme, complimentary for a year',
      status: 'complimentary',
    });
    const free = await signedIn(c.tenant, c.owner);
    const freeView = await addOns().addOns(free);
    expect(freeView).toMatchObject({ unavailable: 'complimentary', plan: null, options: [] });
    await refused(
      addOns().choose(free, quantities(2, 0, 0)),
      'precondition_failed',
      /complimentary/,
    );
    expect(await stateOf(c.tenantId)).toMatchObject({ plan_id: null, extra_seats: 0 });
  });

  it('refuses a decrease below the seats and WhatsApp numbers in use, but not an increase, and not fewer run packs than the month used', async () => {
    // One seat included and three extra; the owner, a member and a waiting invitation use three.
    const c = await trialCompany({ seatsIncluded: '1' }, '3');
    await member(c, 'billing', 'Second Member');
    await invite(dbs, c.tenant, c.owner, `third-${Date.now()}@example.test`, ['agent']);
    expect((await addOns().addOns(c.ctx)).options[0]).toMatchObject({
      kind: 'seats',
      quantity: 3,
      min: 2,
      used: 3,
    });
    await refused(
      addOns().choose(c.ctx, quantities(1, 0, 0)),
      'precondition_failed',
      /^With these add-ons your plan holds 2 seats, where your company uses 3 \(members and invitations still waiting\)\. Free some first/,
    );
    expect((await stateOf(c.tenantId)).extra_seats).toBe(3);
    expect(await audits(c.tenantId, 'billing.add_ons_chosen')).toEqual([]);
    // Exactly what the company uses fits.
    expect(await addOns().choose(c.ctx, quantities(2, 0, 0))).toMatchObject({ changed: true });

    // Staff leave the company over its limit; an increase is allowed even when it stays over.
    await staffSet(c.tenantId, {
      reason: 'Seats removed while the contract is reviewed',
      status: 'trialing',
      planId: c.planId,
      trialEndsOn: dayOf(new Date(Date.now() + 10 * DAY_MS), 'Asia/Kolkata'),
      extraSeats: '0',
    });
    expect((await addOns().addOns(c.ctx)).options[0]).toMatchObject({ quantity: 0, min: 0 });
    expect(await addOns().choose(c.ctx, quantities(1, 0, 0))).toMatchObject({ changed: true });
    expect((await stateOf(c.tenantId)).extra_seats).toBe(1);

    // Two connected numbers with one included and two extra: one extra fits, none does not.
    expect(await addOns().choose(c.ctx, quantities(1, 2, 0))).toMatchObject({ changed: true });
    await connectNumbers(c.tenantId, 2);
    await refused(
      addOns().choose(c.ctx, quantities(1, 0, 0)),
      'precondition_failed',
      /^With these add-ons your plan holds 1 WhatsApp number, where your company uses 2\./,
    );
    expect(await addOns().choose(c.ctx, quantities(1, 1, 0))).toMatchObject({ changed: true });

    // Fewer run packs than the month already used refuse nothing: the used runs count against the
    // smaller allowance.
    expect(await addOns().choose(c.ctx, quantities(1, 1, 4))).toMatchObject({ changed: true });
    const { start } = usagePeriod((await stateOf(c.tenantId)).usage_anchor, new Date());
    await adminQuery(
      `INSERT INTO app.usage_counters (id, tenant_id, metric, period_start, used)
       VALUES ($1, $2, 'automation_runs', $3, 2500)`,
      [uuidv7(), c.tenantId, start],
    );
    expect(await addOns().choose(c.ctx, quantities(1, 1, 0))).toMatchObject({ changed: true });
    expect(await limitsOf(c.tenantId)).toMatchObject({ automation_runs: 1000 });
  });

  it('lets a company whose plan ended choose add-ons while restricted: it stays restricted until it pays, charged at once', async () => {
    const c = await trialCompany();
    await staffSet(c.tenantId, {
      reason: 'Trial ended early at the company’s request',
      status: 'canceled',
    });
    const ctx = await signedIn(c.tenant, c.owner);
    expect(ctx.tenant.status).toBe('restricted');
    expect((await addOns().addOns(ctx)).unavailable).toBeNull();
    const chosen = await addOns().choose(ctx, quantities(2, 1, 0));
    expect(chosen).toMatchObject({ changed: true });
    expect(await stateOf(c.tenantId)).toMatchObject({
      status: 'canceled',
      extra_seats: 2,
      extra_numbers: 1,
    });
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

  it('waits for a subscription start, a seat addition and a staff change, which therefore never interleave with a change of add-ons', async () => {
    const c = await trialCompany();

    // The lock a subscription start takes.
    let release = await hold(
      "SELECT pg_advisory_xact_lock(hashtextextended('w360:plan-subscriptions:' || $1::text, 0))",
      [c.tenantId],
    );
    let choosing = addOns().choose(c.ctx, quantities(2, 0, 0));
    // Released however the check ends, so a failure here never holds the lock for the tests after.
    try {
      expect(await stillWaiting(choosing)).toBe(true);
    } finally {
      await release();
    }
    expect(await choosing).toMatchObject({ changed: true });

    // The lock an addition of a seat takes.
    release = await hold(
      "SELECT pg_advisory_xact_lock(hashtextextended('seats:' || $1::text, 0))",
      [c.tenantId],
    );
    choosing = addOns().choose(c.ctx, quantities(3, 0, 0));
    try {
      expect(await stillWaiting(choosing)).toBe(true);
    } finally {
      await release();
    }
    expect(await choosing).toMatchObject({ changed: true });

    // A staff change holds the company row: the change of add-ons waits for it before it locks the
    // plan state (the order staff changes and the plan sweep take), so the two never deadlock.
    const staff = await dbs.adminPool.connect();
    let planStateFree: boolean | undefined;
    try {
      await staff.query('BEGIN');
      await staff.query('SELECT 1 FROM app.tenants WHERE id = $1 FOR UPDATE', [c.tenantId]);
      choosing = addOns().choose(c.ctx, quantities(4, 0, 0));
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

    // Two changes at once: each is applied in turn, and each is audited.
    const [first, second] = await Promise.all([
      addOns().choose(c.ctx, quantities(5, 0, 0)),
      addOns().choose(await signedIn(c.tenant, c.owner), quantities(6, 0, 0)),
    ]);
    expect([first.changed, second.changed]).toEqual([true, true]);
    expect([5, 6]).toContain((await stateOf(c.tenantId)).extra_seats);
    expect(await audits(c.tenantId, 'billing.add_ons_chosen')).toHaveLength(5);

    // A staff change committed while the change of add-ons waits for the plan state is seen by it:
    // the function reads the plan state under its lock, so neither change is lost.
    const version = (await stateOf(c.tenantId)).version;
    const staffChange = await dbs.adminPool.connect();
    try {
      await staffChange.query('BEGIN');
      await staffChange.query(
        "UPDATE app.tenant_plans SET note = 'Changed by staff meanwhile', version = version + 1 WHERE tenant_id = $1",
        [c.tenantId],
      );
      choosing = addOns().choose(c.ctx, quantities(7, 0, 0));
      expect(await stillWaiting(choosing)).toBe(true);
      await staffChange.query('COMMIT');
    } catch (error) {
      await staffChange.query('ROLLBACK');
      throw error;
    } finally {
      staffChange.release();
    }
    expect(await choosing).toMatchObject({ changed: true });
    expect(await stateOf(c.tenantId)).toMatchObject({ extra_seats: 7, version: version + 2 });
    expect(await audits(c.tenantId, 'billing.add_ons_chosen')).toHaveLength(6);
  });

  it('does not tell a staff change made before the company changed its add-ons, and leaves other companies’ add-ons alone; the company role cannot change them any other way', async () => {
    const shared = await publishedPlan({ name: 'Shared' });
    const companies: Company[] = [];
    // Both companies are on the same version, so a change that reached past its own company shows.
    for (const name of ['First', 'Second']) {
      const user = await createUser(dbs, { name: `${name} Owner` });
      const tenant = await createTenant(dbs, user);
      await staffSet(tenant.id, {
        reason: 'Moved to the plan agreed on the call',
        status: 'trialing',
        planId: shared,
        trialEndsOn: dayOf(new Date(Date.now() + 10 * DAY_MS), 'Asia/Kolkata'),
        extraSeats: '1',
      });
      companies.push({
        tenant,
        tenantId: tenant.id,
        owner: user,
        ctx: await signedIn(tenant, user),
        planId: shared,
      });
    }
    const [c, other] = companies as [Company, Company];
    expect(await addOns().choose(c.ctx, quantities(2, 0, 0))).toMatchObject({ changed: true });
    // Repeat the sweep until nothing is left, as the minute sweeps would.
    let superseded = 0;
    for (let round = 0; round < 20; round += 1) {
      const result = await notifyStaffPlanChanges({ db: dbs.app, notices: notices() });
      superseded += result.superseded;
      if (result.notified === 0 && result.superseded === 0) break;
    }
    expect(superseded).toBeGreaterThanOrEqual(1);
    const told = await adminQuery(
      `SELECT 1 FROM ops.email_outbox WHERE tenant_id = $1 AND kind = 'billing.notice'`,
      [c.tenantId],
    );
    expect(told).toEqual([]);

    expect(await stateOf(other.tenantId)).toMatchObject({
      extra_seats: 1,
      note: 'Moved to the plan agreed on the call',
    });
    await expect(
      dbs.app.run(authorizedTenantScope(c.tenantId, c.owner.id), (tx) =>
        tx.execute(sql`update app.tenant_plans set extra_seats = 9`),
      ),
    ).rejects.toThrow(/not permitted/);
  });
});
