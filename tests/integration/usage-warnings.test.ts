import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isAppError, systemClock, uuidv7, type Clock } from '@w360/core';
import { authorizedTenantScope } from '@w360/db';
import {
  admitApiRequest,
  announceApiQuota,
  announceRunLimit,
  authenticateApiToken,
  consumeAutomationRun,
  createApiKeysService,
  createPlanAdminService,
  createPlansService,
  dayOf,
  outboxAad,
  sweepPlanStates,
  usagePeriod,
  warnBeforeLimit,
  type ApiContext,
  type BillingNoticeDeps,
  type PlanSweepDeps,
  type PlatformActor,
} from '@w360/domain';
import { acceptInvitation, createUser, invite, type TestUser } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Warnings before a monthly limit (P5-01, ADR-062) against real PostgreSQL: one email when the
 * month's automation runs or API requests reach 80% of the limit, never below it, never for a limit
 * so small that 80% is the limit, never once the limit is reached (the used-up notice comes
 * instead). Neither a warning nor a used-up notice goes out for a counter of an earlier period, and
 * a counter whose limit changed after the sweep listed it is left for a later sweep. Since ADR-144
 * the share is the company's own, chosen by a member who manages billing.
 */
let fx: WhatsAppFixture;
beforeAll(async () => {
  fx = await startWhatsAppFixture();
});
afterAll(async () => {
  await fx.close();
});

const DAY_MS = 86_400_000;
const admin = () => createPlanAdminService({ platformDb: fx.dbs.platform, clock: systemClock });
const notices = (): BillingNoticeDeps => ({
  outbox: { keyring: fx.keyring, jobs: fx.jobs(), signer: fx.signer },
  appBaseUrl: 'http://localhost:3000',
});
const deps = (clock: Clock = systemClock): PlanSweepDeps => ({
  db: fx.dbs.app,
  clock,
  notices: notices(),
});
const sweep = (clock: Clock = systemClock) => sweepPlanStates(deps(clock));

async function platformOwner(): Promise<PlatformActor> {
  const user = await createUser(fx.dbs, { twoFactor: true });
  await fx.dbs.ownerPool.query(`INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, $2)`, [
    user.id,
    'platform_owner',
  ]);
  return { userId: user.id, role: 'platform_owner', correlationId: uuidv7() };
}

let codes = 0;
/** A company on a paid period (from today) of a plan with the given monthly limits. */
async function onPlan(
  owner: PlatformActor,
  limits: {
    automationRunsMonthly?: string;
    apiRequestsMonthly?: string;
    runPackSize?: string;
    runPackPrice?: string;
    modules?: string[];
  },
  addOns: { runPacks?: string } = {},
): Promise<Company> {
  codes += 1;
  const { id } = await admin().createPlan(owner, {
    code: `warn-${Date.now().toString(36)}-${codes}`,
    name: 'Pro',
    price: '999',
    intervalMonths: '1',
    trialDays: '0',
    graceDays: '7',
    seatsIncluded: '10',
    numbersIncluded: '5',
    modules: ['automations'],
    ...limits,
  });
  await admin().publishPlan(owner, id);
  const c = await fx.company();
  const view = await admin().tenantPlan(owner, c.tenant.id);
  const day = (offset: number) => dayOf(new Date(Date.now() + offset * DAY_MS), 'Asia/Kolkata');
  await admin().setTenantPlan(owner, {
    tenantId: c.tenant.id,
    version: view.state.version,
    reason: 'Invoice INV-7002 paid by bank transfer',
    status: 'active',
    planId: id,
    periodStart: day(0),
    periodEnd: day(30),
    ...addOns,
  });
  return c;
}

async function runs(c: Company, n: number) {
  for (let i = 0; i < n; i += 1) {
    const result = await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, null), (tx) =>
      consumeAutomationRun(tx, c.tenant.id, new Date()),
    );
    expect(result).toEqual({ ok: true });
  }
}

async function apiKey(c: Company): Promise<ApiContext> {
  const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
  const created = await keys.create(await fx.ctx(c, c.owner), {
    name: 'Warnings',
    scopes: ['contacts.read'],
    expiresInDays: 0,
  });
  const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
  if (!ctx) throw new Error('a new key does not authenticate');
  return ctx;
}

async function requests(ctx: ApiContext, n: number) {
  for (let i = 0; i < n; i += 1)
    expect(await admitApiRequest(fx.dbs.app, ctx, new Date())).toMatchObject({ ok: true });
}

/** How many of the company's counters `ops.usage_warnings_due` lists for a warning. */
async function warningsDue(tenantId: string) {
  const { rows } = await fx.dbs.adminPool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ops.usage_warnings_due(100000) WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0]!.n;
}

/** The subjects and first lines of the company's billing notices, oldest first. */
async function billingNotices(tenantId: string) {
  const { rows } = await fx.dbs.adminPool.query<{ id: string; payload_ciphertext: string }>(
    `SELECT id, payload_ciphertext FROM ops.email_outbox
      WHERE tenant_id = $1 AND kind = 'billing.notice' ORDER BY id`,
    [tenantId],
  );
  return rows.map((r) => {
    const payload = JSON.parse(fx.keyring.decryptString(r.payload_ciphertext, outboxAad(r.id))) as {
      subject: string;
      lines: string[];
    };
    return [payload.subject, payload.lines[0]];
  });
}

describe('warnings before a monthly limit', () => {
  it('warns once at 80% of the month’s automation runs and API requests, never below, never at the limit', async () => {
    const owner = await platformOwner();
    const c = await onPlan(owner, { automationRunsMonthly: '10', apiRequestsMonthly: '5' });
    const key = await apiKey(c);

    await runs(c, 7);
    await requests(key, 3);
    expect(await warningsDue(c.tenant.id)).toBe(0);
    await sweep();
    expect(await billingNotices(c.tenant.id)).toEqual([]);

    await runs(c, 1);
    await requests(key, 1);
    expect(await warningsDue(c.tenant.id)).toBe(2);
    await sweep();
    await sweep();
    expect(await warningsDue(c.tenant.id)).toBe(0);
    const warned = [
      [
        "This month's automation runs are nearly used up",
        'Your company has used 8 of the 10 automation runs of the Pro plan for this month.',
      ],
      [
        "This month's API requests are nearly used up",
        'Your company has used 4 of the 5 API requests of the Pro plan for this month.',
      ],
    ];
    expect((await billingNotices(c.tenant.id)).sort()).toEqual([...warned].sort());

    // At the limit the used-up notice follows, once, and no second warning.
    await requests(key, 1);
    await sweep();
    await sweep();
    const notices = await billingNotices(c.tenant.id);
    expect(notices).toHaveLength(3);
    expect(notices).toContainEqual([
      "This month's API requests are used up",
      'Your company used all 5 API requests of the Pro plan for this month.',
    ]);
  });

  it('does not warn when 80% is the limit itself, or when the month jumps to the limit between sweeps', async () => {
    const owner = await platformOwner();
    const small = await onPlan(owner, { apiRequestsMonthly: '4' });
    const smallKey = await apiKey(small);
    await requests(smallKey, 3);
    await sweep();
    expect(await billingNotices(small.tenant.id)).toEqual([]);
    await requests(smallKey, 1);
    expect(await warningsDue(small.tenant.id)).toBe(0);
    await sweep();
    expect((await billingNotices(small.tenant.id)).map(([subject]) => subject)).toEqual([
      "This month's API requests are used up",
    ]);

    const jump = await onPlan(owner, { automationRunsMonthly: '10' });
    await runs(jump, 10);
    expect(await warningsDue(jump.tenant.id)).toBe(0);
    // As when a sweep listed the counter at 9 and it reached the limit before the warning went out.
    const { rows } = await fx.dbs.adminPool.query<{ id: string }>(
      `SELECT id FROM app.usage_counters WHERE tenant_id = $1`,
      [jump.tenant.id],
    );
    expect(await warnBeforeLimit(deps(), jump.tenant.id, rows[0]!.id)).toBe(false);
    await sweep();
    await sweep();
    expect((await billingNotices(jump.tenant.id)).map(([subject]) => subject)).toEqual([
      "This month's automation runs are used up",
    ]);
  });

  it('counts run packs in the automation run limit', async () => {
    const owner = await platformOwner();
    const c = await onPlan(
      owner,
      { automationRunsMonthly: '10', runPackSize: '10', runPackPrice: '99' },
      { runPacks: '1' },
    );
    await runs(c, 15);
    expect(await warningsDue(c.tenant.id)).toBe(0);
    await runs(c, 1);
    expect(await warningsDue(c.tenant.id)).toBe(1);
    await sweep();
    expect(await billingNotices(c.tenant.id)).toEqual([
      [
        "This month's automation runs are nearly used up",
        'Your company has used 16 of the 20 automation runs of the Pro plan for this month.',
      ],
    ]);
  });

  it('does not warn a company that is not active', async () => {
    const owner = await platformOwner();
    const c = await onPlan(owner, { apiRequestsMonthly: '10' });
    await requests(await apiKey(c), 8);
    await fx.dbs.adminPool.query(`UPDATE app.tenants SET status = 'suspended' WHERE id = $1`, [
      c.tenant.id,
    ]);
    expect(await warningsDue(c.tenant.id)).toBe(0);
    await sweep();
    expect(await billingNotices(c.tenant.id)).toEqual([]);
    await fx.dbs.adminPool.query(`UPDATE app.tenants SET status = 'active' WHERE id = $1`, [
      c.tenant.id,
    ]);
    expect(await warningsDue(c.tenant.id)).toBe(1);
  });

  it('marks counters of an earlier period done without a warning or a used-up notice', async () => {
    const owner = await platformOwner();
    const c = await onPlan(owner, { automationRunsMonthly: '10', apiRequestsMonthly: '10' });
    // Counters left from before the current paid period began, as after staff start a new one: one
    // in the warning range, one at the limit.
    const { rows } = await fx.dbs.adminPool.query<{ usage_anchor: Date }>(
      `SELECT usage_anchor FROM app.tenant_plans WHERE tenant_id = $1`,
      [c.tenant.id],
    );
    const anchor = rows[0]!.usage_anchor;
    expect(usagePeriod(anchor, new Date()).start).toEqual(anchor);
    const earlier = new Date(anchor.getTime() - 20 * DAY_MS);
    await fx.dbs.adminPool.query(
      `INSERT INTO app.usage_counters (id, tenant_id, metric, period_start, used)
       VALUES ($1, $3, 'api_requests', $4, 9), ($2, $3, 'automation_runs', $4, 10)`,
      [uuidv7(), uuidv7(), c.tenant.id, earlier],
    );
    await sweep();
    await sweep();
    expect(await billingNotices(c.tenant.id)).toEqual([]);
    const marked = await fx.dbs.adminPool.query<{
      metric: string;
      warned: boolean;
      notified: boolean;
    }>(
      `SELECT metric, warned_at IS NOT NULL AS warned, notified_at IS NOT NULL AS notified
         FROM app.usage_counters WHERE tenant_id = $1 ORDER BY metric`,
      [c.tenant.id],
    );
    expect(marked.rows).toEqual([
      { metric: 'api_requests', warned: true, notified: false },
      { metric: 'automation_runs', warned: false, notified: true },
    ]);
  });

  it('leaves a counter whose limit changed after the sweep listed it for a later sweep', async () => {
    const owner = await platformOwner();
    const c = await onPlan(owner, { automationRunsMonthly: '10', apiRequestsMonthly: '10' });
    const key = await apiKey(c);
    await runs(c, 7);
    await requests(key, 7);
    const counters = await fx.dbs.adminPool.query<{ id: string; metric: string }>(
      `SELECT id, metric FROM app.usage_counters WHERE tenant_id = $1`,
      [c.tenant.id],
    );
    const id = (metric: string) => counters.rows.find((r) => r.metric === metric)!.id;
    const marks = async () =>
      (
        await fx.dbs.adminPool.query<{ warned: boolean; notified: boolean }>(
          `SELECT bool_or(warned_at IS NOT NULL) AS warned, bool_or(notified_at IS NOT NULL) AS notified
             FROM app.usage_counters WHERE tenant_id = $1`,
          [c.tenant.id],
        )
      ).rows[0];

    // As when a sweep listed the counters under a lower limit: below 80% and the limit now.
    expect(await warnBeforeLimit(deps(), c.tenant.id, id('api_requests'))).toBe(false);
    expect(await warnBeforeLimit(deps(), c.tenant.id, id('automation_runs'))).toBe(false);
    expect(await announceApiQuota(deps(), c.tenant.id, id('api_requests'))).toBe(false);
    expect(await announceRunLimit(deps(), c.tenant.id, id('automation_runs'))).toBe(false);
    expect(await marks()).toEqual({ warned: false, notified: false });
    expect(await billingNotices(c.tenant.id)).toEqual([]);

    // At 80% the warnings go out, once each.
    await runs(c, 1);
    await requests(key, 1);
    expect(await warnBeforeLimit(deps(), c.tenant.id, id('api_requests'))).toBe(true);
    expect(await warnBeforeLimit(deps(), c.tenant.id, id('automation_runs'))).toBe(true);
    expect(await warnBeforeLimit(deps(), c.tenant.id, id('api_requests'))).toBe(false);
    await sweep();
    expect(await billingNotices(c.tenant.id)).toHaveLength(2);
  });

  it('sends one warning when two sweeps take the same counter at once', async () => {
    const owner = await platformOwner();
    const c = await onPlan(owner, { apiRequestsMonthly: '10' });
    await requests(await apiKey(c), 8);
    const { rows } = await fx.dbs.adminPool.query<{ id: string }>(
      `SELECT id FROM app.usage_counters WHERE tenant_id = $1`,
      [c.tenant.id],
    );
    const counterId = rows[0]!.id;
    // Another transaction holds the counter, so both calls wait for it and then go on together.
    const holder = await fx.dbs.adminPool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM app.usage_counters WHERE id = $1 FOR UPDATE', [counterId]);
    const both = Promise.allSettled([
      warnBeforeLimit(deps(), c.tenant.id, counterId),
      warnBeforeLimit(deps(), c.tenant.id, counterId),
    ]);
    try {
      await vi.waitFor(
        async () => {
          const waiting = await fx.dbs.adminPool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
          );
          if (waiting.rows[0]!.n < 2) throw new Error('both calls are not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    const outcomes = (await both).map((r) => (r.status === 'fulfilled' ? r.value : r.reason));
    expect(outcomes.sort()).toEqual([false, true]);
    expect(await billingNotices(c.tenant.id)).toHaveLength(1);
  });
});

describe('notices in the app (ADR-140)', () => {
  const plans = (clock: Clock = systemClock) => createPlansService({ db: fx.dbs.app, clock });

  async function member(c: Company, role: string): Promise<TestUser> {
    const user = await createUser(fx.dbs, { name: `A ${role}` });
    const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, [role]);
    await acceptInvitation(fx.dbs, user, token);
    return user;
  }

  /**
   * The notices a member sees, as `metric:state:used/limit`, ending `:ask-billing` for one that asks
   * the member to ask a member who manages billing (a member who does not read billing).
   */
  async function seen(c: Company, user: TestUser, clock?: Clock) {
    const notices = await plans(clock).limitNotices(await fx.ctx(c, user));
    return notices.map(
      (n) => `${n.metric}:${n.state}:${n.used}/${n.limit}${n.forBilling ? '' : ':ask-billing'}`,
    );
  }

  /** Sets a counter of the company's current usage period, or of the one before it. */
  async function counter(c: Company, metric: string, used: number, earlier = false) {
    const { rows } = await fx.dbs.adminPool.query<{ usage_anchor: Date }>(
      `SELECT usage_anchor FROM app.tenant_plans WHERE tenant_id = $1`,
      [c.tenant.id],
    );
    const { start } = usagePeriod(rows[0]!.usage_anchor, new Date());
    const periodStart = earlier ? new Date(start.getTime() - 20 * DAY_MS) : start;
    await fx.dbs.adminPool.query(
      `INSERT INTO app.usage_counters (id, tenant_id, metric, period_start, used)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, metric, period_start) DO UPDATE SET used = EXCLUDED.used`,
      [uuidv7(), c.tenant.id, metric, periodStart, used],
    );
  }

  it('shows each member the notices that concern them: nearly from 80%, used up at the limit', async () => {
    const owner = await platformOwner();
    const c = await onPlan(owner, { automationRunsMonthly: '10', apiRequestsMonthly: '5' });
    const billing = await member(c, 'billing');
    const admin = await member(c, 'admin');
    const key = await apiKey(c);
    await runs(c, 7);
    await requests(key, 3);
    for (const user of [c.owner, admin, billing, c.marketer, c.agent]) {
      expect(await seen(c, user)).toEqual([]);
    }

    // 80%: the members who read billing (an owner, an administrator, a billing manager) are told.
    await runs(c, 1);
    await requests(key, 1);
    const nearly = ['automation_runs:nearly:8/10', 'api_requests:nearly:4/5'];
    expect(await seen(c, c.owner)).toEqual(nearly);
    expect(await seen(c, admin)).toEqual(nearly);
    expect(await seen(c, billing)).toEqual(nearly);
    expect(await seen(c, c.marketer)).toEqual([]);
    expect(await seen(c, c.agent)).toEqual([]);

    // At the limits: a marketer, who reads automations, is told of the runs too, and asked to ask
    // a member who manages billing; agents of neither.
    await runs(c, 2);
    await requests(key, 1);
    const usedUp = ['automation_runs:used_up:10/10', 'api_requests:used_up:5/5'];
    expect(await seen(c, c.owner)).toEqual(usedUp);
    expect(await seen(c, admin)).toEqual(usedUp);
    expect(await seen(c, billing)).toEqual(usedUp);
    expect(await seen(c, c.marketer)).toEqual(['automation_runs:used_up:10/10:ask-billing']);
    expect(await seen(c, c.agent)).toEqual([]);

    // Until the usage period ends, as the plan's usage gives it.
    const ctx = await fx.ctx(c, c.owner);
    const [first] = await plans().limitNotices(ctx);
    expect(first!.periodEnd).toEqual((await plans().usage(ctx)).automationRuns.periodEnd);
  });

  it('counts packs in the limit and reads only the current usage period', async () => {
    const owner = await platformOwner();
    const c = await onPlan(
      owner,
      { automationRunsMonthly: '10', runPackSize: '10', runPackPrice: '99' },
      { runPacks: '1' },
    );
    await runs(c, 15);
    expect(await seen(c, c.owner)).toEqual([]);
    await runs(c, 1);
    expect(await seen(c, c.owner)).toEqual(['automation_runs:nearly:16/20']);
    // In the next usage period this period's runs count for nothing.
    const later: Clock = { now: () => new Date(Date.now() + 40 * DAY_MS) };
    expect(await seen(c, c.owner, later)).toEqual([]);

    // Nor do an earlier period's requests, though they reached the limit then.
    const d = await onPlan(owner, { apiRequestsMonthly: '10' });
    await counter(d, 'api_requests', 10, true);
    expect(await seen(d, d.owner)).toEqual([]);
    await counter(d, 'api_requests', 9);
    expect(await seen(d, d.owner)).toEqual(['api_requests:nearly:9/10']);
  });

  it('says nothing while the company is not active, without limits, or of runs its plan leaves out', async () => {
    const owner = await platformOwner();
    const c = await onPlan(owner, { automationRunsMonthly: '10', apiRequestsMonthly: '5' });
    await runs(c, 10);
    expect(await seen(c, c.owner)).toEqual(['automation_runs:used_up:10/10']);
    for (const status of ['suspended', 'restricted']) {
      await fx.dbs.adminPool.query(`UPDATE app.tenants SET status = $2 WHERE id = $1`, [
        c.tenant.id,
        status,
      ]);
      expect(await seen(c, c.owner)).toEqual([]);
    }

    // Complimentary access has no limits, however much is counted.
    const free = await fx.company();
    await counter(free, 'automation_runs', 100_000);
    await counter(free, 'api_requests', 100_000);
    expect(await seen(free, free.owner)).toEqual([]);

    // A plan without automations: its run limit is not told of, even reached; its API limit is.
    const noAutomations = await onPlan(owner, {
      modules: [],
      automationRunsMonthly: '10',
      apiRequestsMonthly: '5',
    });
    await counter(noAutomations, 'automation_runs', 10);
    await counter(noAutomations, 'api_requests', 5);
    expect(await seen(noAutomations, noAutomations.owner)).toEqual(['api_requests:used_up:5/5']);
  });
});

describe('usage warning thresholds chosen per company (ADR-144)', () => {
  const plans = () => createPlansService({ db: fx.dbs.app, clock: systemClock });

  async function member(c: Company, role: string): Promise<TestUser> {
    const user = await createUser(fx.dbs, { name: `A ${role}` });
    const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, [role]);
    await acceptInvitation(fx.dbs, user, token);
    return user;
  }

  const choose = async (c: Company, user: TestUser, percent: unknown) =>
    plans().setUsageWarningPercent(await fx.ctx(c, user), { percent }, {});

  /** The lines of the company's last billing notice. */
  async function lastLines(tenantId: string) {
    const { rows } = await fx.dbs.adminPool.query<{ id: string; payload_ciphertext: string }>(
      `SELECT id, payload_ciphertext FROM ops.email_outbox
        WHERE tenant_id = $1 AND kind = 'billing.notice' ORDER BY id DESC LIMIT 1`,
      [tenantId],
    );
    const row = rows[0]!;
    return (
      JSON.parse(fx.keyring.decryptString(row.payload_ciphertext, outboxAad(row.id))) as {
        lines: string[];
      }
    ).lines;
  }

  const audits = (tenantId: string) =>
    fx.query<{ actor_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_id, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'billing.usage_warning_changed' ORDER BY occurred_at, id`,
      [tenantId],
    );

  it('warns at the share a member who manages billing chose, from the list to the email, the notices and the plan', async () => {
    const owner = await platformOwner();
    const c = await onPlan(owner, { automationRunsMonthly: '20', apiRequestsMonthly: '20' });
    const ctx = await fx.ctx(c, c.owner);
    expect((await plans().overview(ctx)).usageWarningPercent).toBe(80);
    expect(await choose(c, c.owner, 50)).toEqual({ percent: 50, changed: true });
    expect((await plans().overview(ctx)).usageWarningPercent).toBe(50);

    // Half of 20 is 10: nothing at 9, the warning at 10, in the sweep's list and the email.
    await runs(c, 9);
    expect(await warningsDue(c.tenant.id)).toBe(0);
    await sweep();
    expect(await billingNotices(c.tenant.id)).toEqual([]);
    expect(await plans().limitNotices(ctx)).toEqual([]);
    await runs(c, 1);
    expect(await warningsDue(c.tenant.id)).toBe(1);
    await sweep();
    expect(await billingNotices(c.tenant.id)).toEqual([
      [
        "This month's automation runs are nearly used up",
        'Your company has used 10 of the 20 automation runs of the Pro plan for this month.',
      ],
    ]);
    expect((await lastLines(c.tenant.id)).at(-1)).toBe(
      'This warning comes at 50% of a monthly limit; a member who manages billing can change that under Billing → Usage warnings.',
    );
    expect((await plans().limitNotices(ctx)).map((n) => [n.metric, n.state, n.used])).toEqual([
      ['automation_runs', 'nearly', 10],
    ]);

    // Raised to 95%: the runs, already warned, are not warned again; the requests warn at 19.
    expect(await choose(c, c.owner, '95')).toEqual({ percent: 95, changed: true });
    const key = await apiKey(c);
    await requests(key, 18);
    await runs(c, 9);
    expect(await warningsDue(c.tenant.id)).toBe(0);
    expect((await plans().limitNotices(ctx)).map((n) => [n.metric, n.state])).toEqual([
      ['automation_runs', 'nearly'],
    ]);
    await requests(key, 1);
    expect(await warningsDue(c.tenant.id)).toBe(1);
    await sweep();
    await sweep();
    expect((await billingNotices(c.tenant.id)).map(([subject]) => subject)).toEqual([
      "This month's automation runs are nearly used up",
      "This month's API requests are nearly used up",
    ]);
    expect(await audits(c.tenant.id)).toEqual([
      { actor_id: c.owner.id, metadata: { from: 80, to: 50 } },
      { actor_id: c.owner.id, metadata: { from: 50, to: 95 } },
    ]);
  });

  it('warns at the next sweep when the share is lowered below what was already used', async () => {
    const owner = await platformOwner();
    const c = await onPlan(owner, { apiRequestsMonthly: '20' });
    await requests(await apiKey(c), 12);
    expect(await warningsDue(c.tenant.id)).toBe(0);
    await sweep();
    expect(await billingNotices(c.tenant.id)).toEqual([]);
    await choose(c, c.owner, 60);
    expect(await warningsDue(c.tenant.id)).toBe(1);
    await sweep();
    expect(await billingNotices(c.tenant.id)).toEqual([
      [
        "This month's API requests are nearly used up",
        'Your company has used 12 of the 20 API requests of the Pro plan for this month.',
      ],
    ]);
    // The sweep's check uses the share when it sends: one raised after the list was read waits.
    const d = await onPlan(owner, { apiRequestsMonthly: '20' });
    await requests(await apiKey(d), 16);
    const { rows } = await fx.dbs.adminPool.query<{ id: string }>(
      `SELECT id FROM app.usage_counters WHERE tenant_id = $1`,
      [d.tenant.id],
    );
    expect(await warningsDue(d.tenant.id)).toBe(1);
    await choose(d, d.owner, 85);
    expect(await warnBeforeLimit(deps(), d.tenant.id, rows[0]!.id)).toBe(false);
    expect(await warningsDue(d.tenant.id)).toBe(0);
    await choose(d, d.owner, 80);
    expect(await warnBeforeLimit(deps(), d.tenant.id, rows[0]!.id)).toBe(true);
  });

  it('rounds the share of a limit up, in the sweep and the notices alike', async () => {
    const owner = await platformOwner();
    const c = await onPlan(owner, { apiRequestsMonthly: '7' });
    const ctx = await fx.ctx(c, c.owner);
    await choose(c, c.owner, 50);
    const key = await apiKey(c);
    // Half of 7 is 3.5: nothing at 3, the warning at 4.
    await requests(key, 3);
    expect(await warningsDue(c.tenant.id)).toBe(0);
    expect(await plans().limitNotices(ctx)).toEqual([]);
    await requests(key, 1);
    expect(await warningsDue(c.tenant.id)).toBe(1);
    expect((await plans().limitNotices(ctx)).map((n) => [n.metric, n.state, n.used])).toEqual([
      ['api_requests', 'nearly', 4],
    ]);
  });

  it('is chosen only by members who manage billing, from 50% to 95% in steps of 5, for their company alone', async () => {
    const owner = await platformOwner();
    const c = await onPlan(owner, { apiRequestsMonthly: '20' });
    const other = await onPlan(owner, { apiRequestsMonthly: '20' });
    const billing = await member(c, 'billing');
    const admin = await member(c, 'admin');
    const refusal = async (user: TestUser, percent: unknown) => {
      try {
        await choose(c, user, percent);
      } catch (error) {
        if (isAppError(error)) return [error.code, error.publicMessage];
        throw error;
      }
      throw new Error('expected a refusal');
    };
    // Administrators read billing but do not manage it.
    expect((await refusal(admin, 70))[0]).toBe('forbidden');
    expect((await refusal(c.marketer, 70))[0]).toBe('forbidden');
    for (const percent of [45, 100, 82, 0, 'seventy', 70.5]) {
      expect(await refusal(billing, percent)).toEqual([
        'validation_failed',
        'Choose a share from 50% to 95%, in steps of 5.',
      ]);
    }
    expect(await choose(c, billing, 70)).toEqual({ percent: 70, changed: true });
    // The same share again changes and audits nothing.
    expect(await choose(c, billing, 70)).toEqual({ percent: 70, changed: false });
    expect(await audits(c.tenant.id)).toEqual([
      { actor_id: billing.id, metadata: { from: 80, to: 70 } },
    ]);
    const [{ percent }] = (await fx.query<{ percent: number }>(
      `SELECT usage_warning_percent AS percent FROM app.tenants WHERE id = $1`,
      [other.tenant.id],
    )) as [{ percent: number }];
    expect(percent).toBe(80);
    // The database refuses a share outside the list too.
    for (const bad of [45, 82, 100]) {
      await expect(
        fx.dbs.adminPool.query(`UPDATE app.tenants SET usage_warning_percent = $2 WHERE id = $1`, [
          c.tenant.id,
          bad,
        ]),
      ).rejects.toThrow(/tenants_usage_warning_percent/);
    }
    // The runtime role may change this column of the company's row, not others such as its status.
    const grants = await fx.query<{ column: string; can: boolean }>(
      `SELECT c AS column, has_column_privilege('w360_app', 'app.tenants', c, 'UPDATE') AS can
         FROM unnest(ARRAY['usage_warning_percent', 'status']) AS c`,
    );
    expect(grants).toEqual([
      { column: 'usage_warning_percent', can: true },
      { column: 'status', can: false },
    ]);
  });
});
