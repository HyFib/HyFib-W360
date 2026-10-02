import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7, type RazorpayConfig } from '@w360/core';
import { authorizedTenantScope, planSubscriptions, sql } from '@w360/db';
import {
  RazorpayClient,
  admitApiRequest,
  authenticateApiToken,
  createApiKeysService,
  createPlanAddOnsService,
  createPlanAdminService,
  createPlanSubscriptionService,
  createPlansService,
  dayOf,
  sweepPlanStates,
  usagePeriod,
  type ApiContext,
  type BillingNoticeDeps,
  type PlatformActor,
} from '@w360/domain';
import { createUser } from './helpers';
import { startRazorpayStandIn, type RazorpayStandIn } from '../support/razorpay-stand-in';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Packs of extra API requests (P5-01/P5-08, ADR-110) against real PostgreSQL and the test-only
 * Razorpay stand-in: platform owners sell them with a monthly API request limit above 0, staff and
 * companies set them, the company's limit is the version's plus its packs for every request, the
 * warning and the used-up notice, a subscription records and charges them, and no limit with packs
 * passes 2,000,000,000 (run packs included), so no company's plan state can stop the sweep's
 * lookups. Changes of plan carrying packs are tested with the other changes (plan-changes.test.ts).
 */
const RZP_KEY_ID = 'rzp_test_StandIn00000110';
const RZP_KEY_SECRET = randomBytes(16).toString('hex');
const DAY_MS = 86_400_000;

let fx: WhatsAppFixture;
let rzp: RazorpayStandIn;
let razorpay: RazorpayClient;
let owner: PlatformActor;

function razorpayConfig(): RazorpayConfig {
  return {
    keyId: RZP_KEY_ID,
    keySecret: RZP_KEY_SECRET,
    webhookSecrets: ['unused-in-these-tests'],
    recurringCardsEnabled: false,
    subscriptionsEnabled: true,
    apiBaseUrl: rzp.baseUrl,
    mode: 'test',
  };
}
const notices = (): BillingNoticeDeps => ({
  outbox: { keyring: fx.keyring, jobs: fx.jobs(), signer: fx.signer },
  appBaseUrl: 'http://localhost:3000',
});
const admin = () =>
  createPlanAdminService({ platformDb: fx.dbs.platform, clock: systemClock, razorpay });
const plans = () => createPlansService({ db: fx.dbs.app, clock: systemClock });
const keys = () => createApiKeysService({ db: fx.dbs.app, clock: systemClock });
const addOns = () =>
  createPlanAddOnsService({ db: fx.dbs.app, clock: systemClock, subscriptionsEnabled: true });
const subscriptions = () =>
  createPlanSubscriptionService({
    db: fx.dbs.app,
    clock: systemClock,
    razorpay,
    razorpayConfig: razorpayConfig(),
    notices: notices(),
  });
const admit = (ctx: ApiContext, now = new Date()) => admitApiRequest(fx.dbs.app, ctx, now);
const day = (offset: number) => dayOf(new Date(Date.now() + offset * DAY_MS), 'Asia/Kolkata');

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  rzp = await startRazorpayStandIn({ keyId: RZP_KEY_ID, keySecret: RZP_KEY_SECRET });
  razorpay = new RazorpayClient({
    baseUrl: rzp.baseUrl,
    keyId: RZP_KEY_ID,
    keySecret: RZP_KEY_SECRET,
    timeoutMs: 2_000,
  });
  const user = await createUser(fx.dbs, { name: 'Packs Plan Owner', twoFactor: true });
  await fx.dbs.ownerPool.query('INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, $2)', [
    user.id,
    'platform_owner',
  ]);
  owner = { userId: user.id, role: 'platform_owner', correlationId: uuidv7() };
  await admin().setPlanTax(owner, { tax: '18', reason: 'GST on plan prices, ticket 9110' });
});

afterAll(async () => {
  await rzp.close();
  await fx.close();
});

async function adminQuery<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await fx.dbs.adminPool.query<T>(text, params)).rows;
}

async function expectAppError(promise: Promise<unknown>, code: string, message?: RegExp) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, 'expected a refusal').not.toBeNull();
  expect(isAppError(error) ? error.code : error).toBe(code);
  if (message && isAppError(error)) expect(error.message).toMatch(message);
}

/** The database refused the statement; the message is found along the error's causes. */
async function refusedByDatabase(promise: Promise<unknown>, message: RegExp) {
  let current: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(current, 'expected a refusal').not.toBeNull();
  const messages: string[] = [];
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    messages.push(current.message);
    current = current.cause;
  }
  expect(messages.join(' | ')).toMatch(message);
}

let codes = 0;
/** A published monthly version: no add-ons, no API request limit, unless the terms say otherwise. */
async function publishedPlan(terms: Record<string, string | string[]> = {}): Promise<string> {
  codes += 1;
  const { id } = await admin().createPlan(owner, {
    code: `packs-${Date.now().toString(36)}-${codes}`,
    name: 'Packs',
    price: '999',
    intervalMonths: '1',
    trialDays: '14',
    graceDays: '7',
    seatsIncluded: '10',
    numbersIncluded: '5',
    modules: [],
    ...terms,
  });
  await admin().publishPlan(owner, id);
  return id;
}

/** A staff change of the company's plan from its platform page (ADR-051). */
async function staffSet(c: Company, change: Record<string, string>) {
  const view = await admin().tenantPlan(owner, c.tenant.id);
  await admin().setTenantPlan(owner, {
    tenantId: c.tenant.id,
    version: view.state.version,
    reason: 'Invoice INV-9110 paid by bank transfer',
    ...change,
  });
}

/** A paid period of the version from today, with these add-ons. */
const paidPeriod = (planId: string, addOnsSet: Record<string, string> = {}) => ({
  status: 'active',
  planId,
  periodStart: day(0),
  periodEnd: day(30),
  ...addOnsSet,
});

/** A key of the company made by its owner, and the context requests with it get. */
async function apiKey(c: Company): Promise<ApiContext> {
  const created = await keys().create(await fx.ctx(c, c.owner), {
    name: 'Packs test',
    scopes: ['contacts.read'],
    expiresInDays: 0,
  });
  const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
  if (!ctx) throw new Error('a new key does not authenticate');
  return ctx;
}

async function limits(tenantId: string) {
  const [row] = await adminQuery<{ api_requests: number | null; automation_runs: number | null }>(
    'SELECT api_requests, automation_runs FROM app.tenant_entitlements($1)',
    [tenantId],
  );
  return row!;
}

async function planState(tenantId: string) {
  const [row] = await adminQuery<{
    plan_id: string | null;
    status: string;
    run_packs: number;
    api_request_packs: number;
    usage_anchor: Date;
  }>('SELECT * FROM app.tenant_plans WHERE tenant_id = $1', [tenantId]);
  return row!;
}

/** Sets the company's count of a metric for this usage period (as requests would have). */
async function setUsed(tenantId: string, metric: string, used: number) {
  const { start } = usagePeriod((await planState(tenantId)).usage_anchor, new Date());
  await adminQuery(
    `INSERT INTO app.usage_counters (id, tenant_id, metric, period_start, used)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, metric, period_start) DO UPDATE SET used = EXCLUDED.used`,
    [uuidv7(), tenantId, metric, start, used],
  );
}

const lookup = async (fn: string, tenantId: string) =>
  (await adminQuery<{ tenant_id: string }>(`SELECT tenant_id FROM ${fn}(100000)`)).filter(
    (r) => r.tenant_id === tenantId,
  ).length;

describe('API request packs (ADR-110)', () => {
  it('are sold only with a monthly API request limit above 0, with a size and a price, and never change once published', async () => {
    const terms = (more: Record<string, string>) => ({
      code: `packs-form-${Date.now().toString(36)}-${(codes += 1)}`,
      name: 'Packs form',
      price: '999',
      intervalMonths: '1',
      trialDays: '0',
      graceDays: '7',
      seatsIncluded: '10',
      numbersIncluded: '5',
      modules: [],
      ...more,
    });
    await expectAppError(
      admin().createPlan(
        owner,
        terms({ apiRequestsMonthly: '1000', apiRequestPackSize: '500', apiRequestPackPrice: '' }),
      ),
      'validation_failed',
      /both the size and the price of an API request pack/,
    );
    for (const limit of ['', '0']) {
      await expectAppError(
        admin().createPlan(
          owner,
          terms({
            apiRequestsMonthly: limit,
            apiRequestPackSize: '500',
            apiRequestPackPrice: '300',
          }),
        ),
        'validation_failed',
        /monthly API request limit above 0/,
      );
    }
    await expectAppError(
      admin().createPlan(
        owner,
        terms({
          apiRequestsMonthly: '1000',
          apiRequestPackSize: '100000001',
          apiRequestPackPrice: '300',
        }),
      ),
      'validation_failed',
      /up to 100,000,000/,
    );

    // The table refuses the same whatever writes it, a pack without any limit (NULL) included.
    const insert = (limit: number | null, size: number | null, price: number | null) =>
      fx.dbs.platform.run(owner.userId, (tx) =>
        tx.execute(
          sql`insert into ops.plans (id, code, version, name, price_minor, interval_months,
                seats_included, numbers_included, created_by_user_id, api_requests_monthly,
                api_request_pack_size, api_request_pack_price_minor)
              values (${uuidv7()}::uuid, ${`packs-sql-${(codes += 1)}`}, 1, 'Packs SQL', 99900, 1,
                      10, 5, ${owner.userId}, ${limit}::integer, ${size}::integer,
                      ${price}::bigint)`,
        ),
      );
    await refusedByDatabase(insert(null, 500, 30_000), /plans_api_request_pack_limit_check/);
    await refusedByDatabase(insert(0, 500, 30_000), /plans_api_request_pack_limit_check/);
    await refusedByDatabase(insert(1000, 500, null), /plans_api_request_pack_pair_check/);
    await refusedByDatabase(insert(1000, null, 30_000), /plans_api_request_pack_pair_check/);
    await refusedByDatabase(insert(1000, 100_000_001, 30_000), /api_request_pack_size_check/);

    const id = await publishedPlan({
      apiRequestsMonthly: '1000',
      apiRequestPackSize: '500',
      apiRequestPackPrice: '300',
    });
    expect((await admin().getPlan(owner, id)).plan).toMatchObject({
      apiRequestPackSize: 500,
      apiRequestPackPriceMinor: 30_000,
    });
    // A new version starts from the old one's packs.
    const copy = await admin().createVersion(owner, id);
    expect((await admin().getPlan(owner, copy.id)).plan).toMatchObject({
      status: 'draft',
      apiRequestPackSize: 500,
      apiRequestPackPriceMinor: 30_000,
    });
    // A published version keeps them.
    for (const change of [
      sql`api_request_pack_size = 600`,
      sql`api_request_pack_price_minor = 1`,
      sql`api_request_pack_size = null, api_request_pack_price_minor = null`,
    ]) {
      await refusedByDatabase(
        fx.dbs.platform.run(owner.userId, (tx) =>
          tx.execute(sql`update ops.plans set ${change} where id = ${id}::uuid`),
        ),
        /published plan version cannot change/,
      );
    }
  });

  it('raise the monthly API request limit by the packs staff set, for every request, the plan card and the platform page', async () => {
    const c = await fx.company();
    const key = await apiKey(c);
    const planId = await publishedPlan({
      apiRequestsMonthly: '3',
      apiRequestPackSize: '2',
      apiRequestPackPrice: '100',
    });
    await staffSet(c, paidPeriod(planId, { apiRequestPacks: '2' }));
    expect((await planState(c.tenant.id)).api_request_packs).toBe(2);
    // 3 + 2 × 2 requests a month.
    expect((await limits(c.tenant.id)).api_requests).toBe(7);
    expect((await plans().usage(await fx.ctx(c, c.owner))).limits.apiRequests).toBe(7);
    expect((await plans().overview(await fx.ctx(c, c.owner))).addOns.apiRequestPacks).toBe(2);
    expect((await admin().tenantPlan(owner, c.tenant.id)).limits.apiRequests).toBe(7);
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 9 }, () => admit(key, now)));
    expect(results.filter((r) => r.ok)).toHaveLength(7);
    expect(results.find((r) => !r.ok)).toMatchObject({
      reason: 'quota_exceeded',
      message: expect.stringContaining('allows 7 API requests a month'),
    });

    // Fewer packs lower the limit at once; complimentary access clears them.
    await staffSet(c, paidPeriod(planId, { apiRequestPacks: '0' }));
    expect((await limits(c.tenant.id)).api_requests).toBe(3);
    await staffSet(c, paidPeriod(planId, { apiRequestPacks: '1' }));
    await staffSet(c, { status: 'complimentary', planId: '' });
    expect(await planState(c.tenant.id)).toMatchObject({ plan_id: null, api_request_packs: 0 });
    // The staff change is audited with the packs, for the company and on the platform.
    const [audit] = await adminQuery<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'platform.tenant_plan_changed'
          AND metadata ->> 'apiRequestPacks' = '1'`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ planId, apiRequestPacks: 1 });
  });

  it('stay within what the version sells, and keep every limit with packs within 2,000,000,000, automation run packs included', async () => {
    const c = await fx.company();
    const none = await publishedPlan({ apiRequestsMonthly: '1000' });
    await expectAppError(
      staffSet(c, paidPeriod(none, { apiRequestPacks: '1' })),
      'validation_failed',
      /does not sell API request packs/,
    );
    const big = await publishedPlan({
      apiRequestsMonthly: '1000000000',
      apiRequestPackSize: '100000000',
      apiRequestPackPrice: '1',
      automationRunsMonthly: '100000000',
      runPackSize: '10000000',
      runPackPrice: '1',
      modules: ['automations'],
    });
    await expectAppError(
      staffSet(c, paidPeriod(big, { apiRequestPacks: '11' })),
      'validation_failed',
      /sells at most 10 API request packs/,
    );
    await expectAppError(
      staffSet(c, paidPeriod(big, { runPacks: '191' })),
      'validation_failed',
      /sells at most 190 automation run packs/,
    );
    await staffSet(c, paidPeriod(big, { apiRequestPacks: '10', runPacks: '190' }));
    expect(await limits(c.tenant.id)).toEqual({
      api_requests: 2_000_000_000,
      automation_runs: 2_000_000_000,
    });

    // The plan state's guard refuses more whatever writes it.
    const set = (change: ReturnType<typeof sql>) =>
      fx.dbs.platform.run(owner.userId, (tx) =>
        tx.execute(
          sql`update app.tenant_plans set ${change} where tenant_id = ${c.tenant.id}::uuid`,
        ),
      );
    await refusedByDatabase(
      set(sql`api_request_packs = 11`),
      /does not sell that many API request packs/,
    );
    await refusedByDatabase(
      set(sql`run_packs = 191`),
      /does not sell that many automation run packs/,
    );
    // The most packs of either kind are refused in the guard's own words: its sums never pass the
    // integer range.
    await refusedByDatabase(
      set(sql`api_request_packs = 10000`),
      /does not sell that many API request packs/,
    );
    await refusedByDatabase(
      set(sql`run_packs = 10000`),
      /does not sell that many automation run packs/,
    );
    await staffSet(c, paidPeriod(none));
    await refusedByDatabase(set(sql`api_request_packs = 1`), /does not sell API request packs/);
    // No packs without a plan.
    await refusedByDatabase(
      fx.dbs.platform.run(owner.userId, (tx) =>
        tx.execute(
          sql`update app.tenant_plans set plan_id = null, status = 'complimentary', api_request_packs = 1
               where tenant_id = ${c.tenant.id}::uuid`,
        ),
      ),
      /tenant_plans_api_request_packs_plan_check/,
    );
  });

  it('count in the warning and the used-up notice, and no company’s plan state can stop the lookups for every company', async () => {
    const c = await fx.company();
    const planId = await publishedPlan({
      apiRequestsMonthly: '10',
      apiRequestPackSize: '10',
      apiRequestPackPrice: '100',
    });
    await staffSet(c, paidPeriod(planId, { apiRequestPacks: '1' }));
    // The version's 10 are used, the 20 with the pack are not: no warning (80% is 16), no notice.
    await setUsed(c.tenant.id, 'api_requests', 10);
    expect(await lookup('ops.usage_warnings_due', c.tenant.id)).toBe(0);
    expect(await lookup('ops.api_quota_reached', c.tenant.id)).toBe(0);
    await setUsed(c.tenant.id, 'api_requests', 16);
    expect(await lookup('ops.usage_warnings_due', c.tenant.id)).toBe(1);
    expect(await lookup('ops.api_quota_reached', c.tenant.id)).toBe(0);
    await setUsed(c.tenant.id, 'api_requests', 20);
    expect(await lookup('ops.usage_warnings_due', c.tenant.id)).toBe(0);
    expect(await lookup('ops.api_quota_reached', c.tenant.id)).toBe(1);

    // A plan state written before migration 0088 could hold packs beyond the integer range: here
    // made by skipping the guard. Its own entitlements fail loudly, and the lookups for every
    // company go on.
    const legacy = await fx.company();
    const huge = await publishedPlan({
      apiRequestsMonthly: '1000000000',
      apiRequestPackSize: '100000000',
      apiRequestPackPrice: '1',
      automationRunsMonthly: '100000000',
      runPackSize: '10000000',
      runPackPrice: '1',
      modules: ['automations'],
    });
    await staffSet(legacy, paidPeriod(huge));
    const client = await fx.dbs.adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(
        'UPDATE app.tenant_plans SET run_packs = 10000, api_request_packs = 10000 WHERE tenant_id = $1',
        [legacy.tenant.id],
      );
      await client.query('COMMIT');
      await setUsed(legacy.tenant.id, 'api_requests', 5);
      await setUsed(legacy.tenant.id, 'automation_runs', 5);
      await expect(
        adminQuery('SELECT * FROM app.tenant_entitlements($1)', [legacy.tenant.id]),
      ).rejects.toThrow(/out of range/);
      for (const fn of [
        'ops.usage_warnings_due',
        'ops.api_quota_reached',
        'ops.usage_limits_reached',
      ]) {
        expect(await lookup(fn, legacy.tenant.id), fn).toBe(0);
      }
      expect(await lookup('ops.api_quota_reached', c.tenant.id)).toBe(1);
    } finally {
      // The legacy company's counts and packs go, so later sweeps in this run see a sound state.
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      await adminQuery('DELETE FROM app.usage_counters WHERE tenant_id = $1', [legacy.tenant.id]);
      await adminQuery(
        'UPDATE app.tenant_plans SET run_packs = 0, api_request_packs = 0 WHERE tenant_id = $1',
        [legacy.tenant.id],
      );
    }

    // The sweep notifies the company at its limit with the pack, once.
    const result = await sweepPlanStates({
      db: fx.dbs.app,
      clock: systemClock,
      notices: notices(),
    });
    expect(result.failed ?? []).toEqual([]);
    const [counter] = await adminQuery<{ notified_at: Date | null }>(
      `SELECT notified_at FROM app.usage_counters WHERE tenant_id = $1 AND metric = 'api_requests'`,
      [c.tenant.id],
    );
    expect(counter?.notified_at).toBeInstanceOf(Date);
  });

  it('are chosen by the company under Billing → Add-ons and paid for with its plan, and every subscription records the packs the company has', async () => {
    const c = await fx.company();
    const planId = await publishedPlan({
      seatPrice: '100',
      apiRequestsMonthly: '1000',
      apiRequestPackSize: '500',
      apiRequestPackPrice: '300',
    });
    await staffSet(c, { status: 'trialing', planId, trialEndsOn: day(10) });
    const ctx = await fx.ctx(c, c.owner);
    expect((await addOns().addOns(ctx)).options.map((o) => o.kind)).toEqual([
      'seats',
      'apiRequestPacks',
    ]);
    expect((await addOns().addOns(ctx)).plan).toMatchObject({ apiRequestPackPriceMinor: 30_000 });
    expect((await addOns().addOns(ctx)).options.find((o) => o.kind === 'apiRequestPacks')).toEqual({
      kind: 'apiRequestPacks',
      quantity: 0,
      min: 0,
      max: 10_000,
      unitPriceMinor: 30_000,
      unitSize: 500,
      included: 1000,
      used: null,
    });
    // ₹999 + 2 × ₹300 = ₹1,599, plus 18% (₹287.82).
    expect(
      await addOns().choose(ctx, {
        extraSeats: '0',
        extraNumbers: '0',
        runPacks: '0',
        apiRequestPacks: '2',
      }),
    ).toEqual({
      changed: true,
      quote: expect.objectContaining({
        apiRequestPacksMinor: 60_000,
        subtotalMinor: 159_900,
        taxMinor: 28_782,
        totalMinor: 188_682,
      }),
    });
    expect((await planState(c.tenant.id)).api_request_packs).toBe(2);
    expect((await limits(c.tenant.id)).api_requests).toBe(2000);
    const [chosen] = await adminQuery<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'billing.add_ons_chosen' ORDER BY occurred_at DESC LIMIT 1`,
      [c.tenant.id],
    );
    expect(chosen?.metadata).toMatchObject({
      previous: { apiRequestPacks: 0 },
      apiRequestPacks: 2,
    });

    // A web server of the previous release sets three quantities: the packs stay.
    const scope = authorizedTenantScope(c.tenant.id, c.owner.id);
    const old = await fx.dbs.app.run(scope, (tx) =>
      tx.execute<{ result: string }>(sql`select * from app.choose_add_ons(1, 0, 0)`),
    );
    expect(old.rows[0]?.result).toBe('chosen');
    expect(await planState(c.tenant.id)).toMatchObject({ api_request_packs: 2 });
    // The four-quantity function refuses packs the version does not sell.
    const bare = await fx.company();
    await staffSet(bare, {
      status: 'trialing',
      planId: await publishedPlan({ apiRequestsMonthly: '1000' }),
      trialEndsOn: day(10),
    });
    await refusedByDatabase(
      fx.dbs.app.run(authorizedTenantScope(bare.tenant.id, bare.owner.id), (tx) =>
        tx.execute(sql`select * from app.choose_add_ons(0, 0, 0, 1)`),
      ),
      /does not sell API request packs/,
    );

    // Paying for the plan charges the packs with it.
    const start = await subscriptions().start(ctx);
    const [row] = await adminQuery<{
      api_request_packs: number;
      extra_seats: number;
      subtotal_minor: string;
      amount_minor: string;
      provider_plan_id: string;
    }>('SELECT * FROM app.plan_subscriptions WHERE id = $1', [start.subscriptionId]);
    // ₹999 + 1 × ₹100 + 2 × ₹300 = ₹1,699, plus 18% (₹305.82).
    expect(row).toMatchObject({
      api_request_packs: 2,
      extra_seats: 1,
      subtotal_minor: '169900',
      amount_minor: '200482',
    });
    expect(rzp.state.plans.get(row!.provider_plan_id)?.amount).toBe(200_482);

    // A subscription that pays for other packs than the company has (as a server of the previous
    // release would record one, without them) or for another plan is refused.
    const other = await fx.company();
    await staffSet(other, { status: 'trialing', planId, trialEndsOn: day(10) });
    await addOns().choose(await fx.ctx(other, other.owner), {
      extraSeats: '0',
      extraNumbers: '0',
      runPacks: '0',
      apiRequestPacks: '1',
    });
    const record = (values: Partial<typeof planSubscriptions.$inferInsert>) =>
      fx.dbs.app.run(authorizedTenantScope(other.tenant.id, null), (tx) =>
        tx.insert(planSubscriptions).values({
          id: uuidv7(),
          tenantId: other.tenant.id,
          planId,
          intervalMonths: 1,
          extraSeats: 0,
          extraNumbers: 0,
          runPacks: 0,
          subtotalMinor: 129_900,
          taxBp: 1800,
          taxMinor: 23_382,
          amountMinor: 153_282,
          totalCount: 60,
          authorizeBy: new Date(Date.now() + 3600_000),
          createdByUserId: other.owner.id,
          ...values,
        }),
      );
    await refusedByDatabase(
      record({ apiRequestPacks: 0, subtotalMinor: 99_900, taxMinor: 17_982, amountMinor: 117_882 }),
      /pays for the plan and add-ons the company has now/,
    );
    await refusedByDatabase(
      record({ apiRequestPacks: 1, planId: await publishedPlan({ apiRequestsMonthly: '5' }) }),
      /pays for the plan and add-ons the company has now/,
    );
    await record({ apiRequestPacks: 1 });
  });
});
