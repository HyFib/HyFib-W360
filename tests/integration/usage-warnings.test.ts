import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemClock, uuidv7, type Clock } from '@w360/core';
import { authorizedTenantScope } from '@w360/db';
import {
  admitApiRequest,
  announceApiQuota,
  announceRunLimit,
  authenticateApiToken,
  consumeAutomationRun,
  createApiKeysService,
  createPlanAdminService,
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
import { createUser } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Warnings before a monthly limit (P5-01, ADR-062) against real PostgreSQL: one email when the
 * month's automation runs or API requests reach 80% of the limit, never below it, never for a limit
 * so small that 80% is the limit, never once the limit is reached (the used-up notice comes
 * instead). Neither a warning nor a used-up notice goes out for a counter of an earlier period, and
 * a counter whose limit changed after the sweep listed it is left for a later sweep.
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
