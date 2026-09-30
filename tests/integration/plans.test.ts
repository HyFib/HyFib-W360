import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isAppError, systemClock, uuidv7, type Clock } from '@w360/core';
import { authorizedTenantScope, channelAccounts, sql, systemScope } from '@w360/db';
import {
  announceRunLimit,
  assertCan,
  assertNumberAvailable,
  consumeAutomationRun,
  createAutomationService,
  createCommerceService,
  createCrmService,
  createOnboardingService,
  createPlanAdminService,
  createPlansService,
  createPlatformService,
  createTeamsService,
  createTenancyService,
  dayOf,
  notifyStaffPlanChanges,
  outboxAad,
  resolveTenantContext,
  sweepPlanStates,
  type AutomationTrigger,
  type BillingNoticeDeps,
  type PlatformActor,
  type TenantContext,
} from '@w360/domain';
import { acceptInvitation, createTenant, createUser, invite, type TestUser } from './helpers';
import {
  APP_ID,
  APP_SECRET,
  nextExternalId,
  startWhatsAppFixture,
  type WhatsAppFixture,
} from './whatsapp-fixture';

/**
 * Plans and entitlements (P5-01, ADR-051) against real PostgreSQL: the catalog's immutability and
 * who may change it, the plan state every company gets, staff assignment with audit, the sweep
 * that moves plans on with time and restricts lapsed companies, limits at the moment things are
 * added (including races), the monthly automation run quota, modules, and company isolation.
 */
let fx: WhatsAppFixture;
beforeAll(async () => {
  fx = await startWhatsAppFixture();
});
afterAll(async () => {
  // Suites that run later create companies: leave no default trial behind.
  await fx?.dbs.adminPool.query(`UPDATE ops.plan_settings SET default_trial_plan_id = NULL`);
  await fx?.close();
});

const DAY_MS = 86_400_000;
const waId = () => `91${randomInt(7_000_000_000, 9_999_999_999)}`;
const ALL_MODULES = ['automations', 'flows', 'crm', 'commerce'];

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

const admin = () => createPlanAdminService({ platformDb: fx.dbs.platform, clock: systemClock });
const plansService = () => createPlansService({ db: fx.dbs.app, clock: systemClock });
const platform = () =>
  createPlatformService({ db: fx.dbs.app, platformDb: fx.dbs.platform, clock: systemClock });
const notices = (): BillingNoticeDeps => ({
  outbox: { keyring: fx.keyring, jobs: fx.jobs(), signer: fx.signer },
  appBaseUrl: 'http://localhost:3000',
});
const sweep = (clock: Clock = systemClock) =>
  sweepPlanStates({ db: fx.dbs.app, clock, notices: notices() });
const tenancy = () =>
  createTenancyService({
    db: fx.dbs.app,
    clock: systemClock,
    keyring: fx.keyring,
    jobs: fx.jobs(),
    signer: fx.signer,
    appBaseUrl: 'http://localhost:3000',
    invitationTtlHours: 24,
  });
const automations = () =>
  createAutomationService({
    db: fx.dbs.app,
    clock: systemClock,
    jobs: fx.jobs(),
    signer: fx.signer,
  });

async function staff(role: PlatformActor['role']): Promise<PlatformActor> {
  const user = await createUser(fx.dbs, { twoFactor: true });
  await fx.dbs.ownerPool.query(`INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, $2)`, [
    user.id,
    role,
  ]);
  return { userId: user.id, role, correlationId: uuidv7() };
}

let codes = 0;
const planCode = () => `it-${Date.now().toString(36)}-${(codes += 1)}`;

const terms = {
  name: 'Growth',
  price: '2999',
  intervalMonths: '1',
  trialDays: '14',
  graceDays: '7',
  seatsIncluded: '3',
  numbersIncluded: '1',
  modules: ALL_MODULES,
};

async function publishedPlan(owner: PlatformActor, overrides: Record<string, unknown> = {}) {
  const { id } = await admin().createPlan(owner, { code: planCode(), ...terms, ...overrides });
  await admin().publishPlan(owner, id);
  return id;
}

/** A day in the fixture companies' time zone, `offset` days from today. */
const day = (offset: number) => dayOf(new Date(Date.now() + offset * DAY_MS), 'Asia/Kolkata');

async function putOnPlan(actor: PlatformActor, tenantId: string, input: Record<string, unknown>) {
  const view = await admin().tenantPlan(actor, tenantId);
  await admin().setTenantPlan(actor, {
    tenantId,
    version: view.state.version,
    reason: 'Invoice INV-1001 paid by bank transfer',
    ...input,
  });
}

const activePlan = (
  actor: PlatformActor,
  tenantId: string,
  planId: string,
  extra: Record<string, unknown> = {},
) =>
  putOnPlan(actor, tenantId, {
    status: 'active',
    planId,
    periodStart: day(0),
    periodEnd: day(30),
    ...extra,
  });

async function ctxOf(tenantSlug: string, user: TestUser): Promise<TenantContext> {
  return resolveTenantContext(
    { db: fx.dbs.app, clock: systemClock, mfaGracePeriodHours: 72 },
    {
      userId: user.id,
      sessionId: `sess_${user.id}`,
      sessionCreatedAt: new Date(),
      tenantSlug,
      correlationId: uuidv7(),
    },
  );
}

async function planRow(tenantId: string) {
  const { rows } = await fx.dbs.adminPool.query<{
    status: string;
    plan_id: string | null;
    trial_ends_at: Date | null;
    period_end: Date | null;
    grace_ends_at: Date | null;
    version: number;
  }>(
    `SELECT status, plan_id, trial_ends_at, period_end, grace_ends_at, version
       FROM app.tenant_plans WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0]!;
}

async function companyStatus(tenantId: string) {
  const { rows } = await fx.dbs.adminPool.query<{ status: string; status_reason: string | null }>(
    `SELECT status, status_reason FROM app.tenants WHERE id = $1`,
    [tenantId],
  );
  return rows[0]!;
}

async function billingNotices(tenantId: string) {
  const { rows } = await fx.dbs.adminPool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ops.email_outbox WHERE tenant_id = $1 AND kind = 'billing.notice'`,
    [tenantId],
  );
  return rows[0]!.n;
}

/** A company with only its owner (the fixture's companies have three members). */
async function bareCompany() {
  const owner = await createUser(fx.dbs, { name: 'Solo Owner' });
  const tenant = await createTenant(fx.dbs, owner);
  return { owner, tenant };
}

const keyword = (...keywords: string[]): AutomationTrigger => ({
  type: 'keyword',
  keywords,
  match: 'contains',
  hours: 'any',
  cooldownMinutes: 0,
});
const hello = {
  version: 1,
  start: 'hi',
  nodes: [{ id: 'hi', type: 'send_text', text: 'Hello from the bot', next: null }],
};

async function draftAutomation(owner: TenantContext, name: string, trigger = keyword('hello')) {
  const svc = automations();
  const { id } = await svc.createAutomation(owner, { name });
  const saved = await svc.updateAutomation(owner, {
    id,
    expectedVersion: 0,
    name,
    description: null,
    channelAccountId: null,
    trigger,
    graph: hello,
  });
  return { id, version: saved.version };
}

async function liveAutomation(owner: TenantContext, name: string, trigger = keyword('hello')) {
  const { id, version } = await draftAutomation(owner, name, trigger);
  const published = await automations().publishAutomation(owner, {
    id,
    expectedVersion: version,
    note: null,
  });
  return { id, version: published.version };
}

async function liveRuns(tenantId: string) {
  const { rows } = await fx.dbs.adminPool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.automation_runs WHERE tenant_id = $1 AND mode = 'live'`,
    [tenantId],
  );
  return rows[0]!.n;
}

describe('plan catalog', () => {
  it('keeps published versions immutable, and only platform owners change the catalog', async () => {
    const owner = await staff('platform_owner');
    const operator = await staff('platform_operator');
    const code = planCode();
    await expectAppError(
      admin().createPlan(operator, { code, ...terms }),
      'forbidden',
      /Only platform owners/,
    );
    // The form's checks mirror the database's.
    await expectAppError(
      admin().createPlan(owner, { code, ...terms, seatsMax: '5' }),
      'validation_failed',
      /price for extra seats/,
    );
    await expectAppError(
      admin().createPlan(owner, { code, ...terms, runPackSize: '1000', runPackPrice: '99' }),
      'validation_failed',
      /monthly automation run limit/,
    );
    await expectAppError(
      admin().createPlan(owner, { code: 'Not a code!', ...terms }),
      'validation_failed',
      /lowercase letters/,
    );
    await expectAppError(
      admin().createPlan(owner, { code, ...terms, price: '29.999' }),
      'validation_failed',
      /price in rupees/,
    );
    const { id } = await admin().createPlan(owner, {
      code,
      ...terms,
      price: '2,999.50',
      seatPrice: '499',
      seatsMax: '10',
      teamsMax: '',
      automationRunsMonthly: '5000',
      runPackSize: '1000',
      runPackPrice: '299',
    });
    expect((await admin().getPlan(owner, id)).plan).toMatchObject({
      code,
      version: 1,
      status: 'draft',
      priceMinor: 299_950,
      seatPriceMinor: 49_900,
      seatsMax: 10,
      teamsMax: null,
      automationRunsMonthly: 5000,
      runPackSize: 1000,
      runPackPriceMinor: 29_900,
      modules: ALL_MODULES,
    });
    await expectAppError(admin().createPlan(owner, { code, ...terms }), 'conflict', /exists/);

    // Drafts change freely; companies never see them and cannot be put on them.
    await admin().updateDraft(owner, id, { ...terms, name: 'Growth 2026', modules: ['crm'] });
    const c = await fx.company();
    const seen = () =>
      fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), async (tx) => {
        const res = await tx.execute(sql`select id from ops.plans where id = ${id}::uuid`);
        return res.rows.length;
      });
    expect(await seen()).toBe(0);
    await expectAppError(
      activePlan(owner, c.tenant.id, id),
      'precondition_failed',
      /published plan version/,
    );

    await admin().publishPlan(owner, id);
    expect(await seen()).toBe(1);
    await expectAppError(admin().publishPlan(owner, id), 'conflict');
    await expectAppError(admin().updateDraft(owner, id, terms), 'conflict', /new version/);
    // Not even the platform role can change a published version's terms, and nothing deletes it.
    await expectAppError(
      fx.dbs.platform.run(owner.userId, (tx) =>
        tx.execute(sql`update ops.plans set price_minor = 1 where id = ${id}::uuid`),
      ),
      'forbidden',
      /cannot change/,
    );
    await expect(
      fx.dbs.adminPool.query(`DELETE FROM ops.plans WHERE id = $1`, [id]),
    ).rejects.toThrow();

    // A change is a new version with the same terms to start from; one draft at a time.
    const v2 = await admin().createVersion(owner, id);
    expect((await admin().getPlan(owner, v2.id)).plan).toMatchObject({
      code,
      version: 2,
      status: 'draft',
      name: 'Growth 2026',
      modules: ['crm'],
    });
    await expectAppError(admin().createVersion(owner, id), 'conflict', /still a draft/);
    await expectAppError(admin().createVersion(operator, id), 'forbidden');

    // Retiring keeps the version for the companies on it; it can no longer be assigned.
    await activePlan(operator, c.tenant.id, id);
    await expectAppError(admin().retirePlan(owner, id, { reason: 'short' }), 'validation_failed');
    await admin().retirePlan(owner, id, { reason: 'Replaced by version 2 from October' });
    expect((await admin().getPlan(owner, id)).plan.status).toBe('retired');
    const other = await fx.company();
    await expectAppError(
      activePlan(operator, other.tenant.id, id),
      'precondition_failed',
      /published plan version/,
    );
    // The company on it keeps it, and staff can still extend its period on it.
    await activePlan(operator, c.tenant.id, id, { periodEnd: day(60) });
    expect((await planRow(c.tenant.id)).plan_id).toBe(id);

    const audit = await fx.dbs.adminPool.query<{ action: string }>(
      `SELECT action FROM ops.platform_audit_events
        WHERE actor_user_id = $1 ORDER BY occurred_at, id`,
      [owner.userId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'platform.plan_created',
      'platform.plan_updated',
      'platform.plan_published',
      'platform.plan_version_created',
      'platform.plan_retired',
    ]);
  });

  it('starts new companies on the default trial, or complimentary without one', async () => {
    const owner = await staff('platform_owner');
    const noTrial = await publishedPlan(owner, { trialDays: '0' });
    await expectAppError(
      admin().setDefaultTrial(owner, { planId: noTrial }),
      'precondition_failed',
      /trial days/,
    );
    await expectAppError(
      admin().setDefaultTrial(await staff('platform_operator'), { planId: null }),
      'forbidden',
    );

    // Without a default trial: complimentary, no limits, every module.
    const before = await bareCompany();
    expect(await planRow(before.tenant.id)).toMatchObject({
      status: 'complimentary',
      plan_id: null,
    });
    const free = await ctxOf(before.tenant.slug, before.owner);
    expect(free.plan).toMatchObject({
      status: 'complimentary',
      limits: {
        seats: null,
        numbers: null,
        teams: null,
        liveAutomations: null,
        automationRuns: null,
      },
    });
    expect([...free.plan.modules]).toEqual(ALL_MODULES);

    const trial = await publishedPlan(owner, {
      trialDays: '10',
      seatsIncluded: '2',
      modules: ['crm'],
    });
    await admin().setDefaultTrial(owner, { planId: trial });
    try {
      await expectAppError(
        admin().retirePlan(owner, trial, { reason: 'Trying to retire the default trial' }),
        'precondition_failed',
        /default trial/,
      );
      const after = await bareCompany();
      const row = await planRow(after.tenant.id);
      expect(row).toMatchObject({ status: 'trialing', plan_id: trial });
      const days = (row.trial_ends_at!.getTime() - Date.now()) / DAY_MS;
      expect(days).toBeGreaterThan(9.9);
      expect(days).toBeLessThan(10.1);
      const ctx = await ctxOf(after.tenant.slug, after.owner);
      expect(ctx.plan.limits.seats).toBe(2);
      expect([...ctx.plan.modules]).toEqual(['crm']);
      expect(ctx.permissions.has('automations.write')).toBe(false);
      expect(ctx.permissions.has('crm.write')).toBe(true);
    } finally {
      await admin().setDefaultTrial(owner, { planId: '' });
    }
    expect((await planRow((await bareCompany()).tenant.id)).status).toBe('complimentary');
  });
});

describe('company plan state', () => {
  it('records staff changes in both audit logs, refuses stale forms and checks add-ons', async () => {
    const operator = await staff('platform_operator');
    const owner = await staff('platform_owner');
    const planId = await publishedPlan(owner, { seatPrice: '499', seatsMax: '5' });
    const c = await fx.company();
    const view = await admin().tenantPlan(operator, c.tenant.id);
    expect(view.state.status).toBe('complimentary');
    expect(view.usage).toMatchObject({ members: 3, invitations: 0, numbers: 1, teams: 0 });

    await activePlan(operator, c.tenant.id, planId, { extraSeats: '2' });
    const changed = await admin().tenantPlan(operator, c.tenant.id);
    expect(changed.state).toMatchObject({ status: 'active', planId, extraSeats: 2 });
    expect(changed.limits.seats).toBe(5);
    // The form was built from the previous state: refused, nothing overwritten.
    await expectAppError(
      admin().setTenantPlan(operator, {
        tenantId: c.tenant.id,
        version: view.state.version,
        status: 'complimentary',
        reason: 'Stale form from another tab',
      }),
      'conflict',
      /changed while you were editing/,
    );
    await expectAppError(
      activePlan(operator, c.tenant.id, planId, { extraSeats: '3' }),
      'validation_failed',
      /at most 5 seats/,
    );
    await expectAppError(
      activePlan(operator, c.tenant.id, planId, { extraNumbers: '1' }),
      'validation_failed',
      /does not sell extra WhatsApp numbers/,
    );
    await expectAppError(
      activePlan(operator, c.tenant.id, planId, { periodStart: day(5), periodEnd: day(2) }),
      'validation_failed',
      /end after it starts/,
    );
    await expectAppError(
      putOnPlan(operator, c.tenant.id, { status: 'trialing', planId, trialEndsOn: day(0) }),
      'validation_failed',
      /after today/,
    );

    const { rows } = await fx.dbs.adminPool.query<{
      action: string;
      actor_type: string;
      metadata: { reason: string; status: string; extraSeats: number };
    }>(
      `SELECT action, actor_type, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'platform.tenant_plan_changed'`,
      [c.tenant.id],
    );
    expect(rows).toEqual([
      {
        action: 'platform.tenant_plan_changed',
        actor_type: 'platform_admin',
        metadata: expect.objectContaining({
          reason: 'Invoice INV-1001 paid by bank transfer',
          status: 'active',
          planId,
          extraSeats: 2,
        }),
      },
    ]);
    const platformRows = await fx.dbs.adminPool.query<{ reason: string }>(
      `SELECT reason FROM ops.platform_audit_events
        WHERE action = 'platform.tenant_plan_changed' AND target_tenant_id = $1`,
      [c.tenant.id],
    );
    expect(platformRows.rows).toEqual([{ reason: 'Invoice INV-1001 paid by bank transfer' }]);

    // The company sees its plan with the price (billing.read), and agents do not.
    const overview = await plansService().overview(await fx.ctx(c, c.owner));
    expect(overview).toMatchObject({
      status: 'active',
      plan: { priceMinor: 299_900, seatPriceMinor: 49_900 },
      addOns: { extraSeats: 2, extraNumbers: 0, runPacks: 0 },
      usage: { limits: { seats: 5, numbers: 1 }, seats: { members: 3, invitations: 0 } },
    });
    await expectAppError(plansService().overview(await fx.ctx(c, c.agent)), 'forbidden');
    expect((await plansService().usage(await fx.ctx(c, c.agent))).limits.seats).toBe(5);

    // Complimentary again: no plan, add-ons cleared.
    await putOnPlan(operator, c.tenant.id, { status: 'complimentary', extraSeats: '4' });
    expect((await admin().tenantPlan(operator, c.tenant.id)).state).toMatchObject({
      status: 'complimentary',
      planId: null,
      extraSeats: 0,
    });
    await expect(
      fx.dbs.adminPool.query(`DELETE FROM app.tenant_plans WHERE tenant_id = $1`, [c.tenant.id]),
    ).rejects.toThrow();
  });

  it('restricts a company whose plan ends and lifts it with a new plan; suspension wins', async () => {
    const operator = await staff('platform_operator');
    const owner = await staff('platform_owner');
    const planId = await publishedPlan(owner);
    const c = await fx.company();
    await expectAppError(
      putOnPlan(operator, c.tenant.id, { status: 'canceled' }),
      'precondition_failed',
      /no plan to end/,
    );
    await activePlan(operator, c.tenant.id, planId);
    await putOnPlan(operator, c.tenant.id, { status: 'canceled' });
    expect(await companyStatus(c.tenant.id)).toEqual({
      status: 'restricted',
      status_reason: 'The plan was canceled.',
    });
    // Like suspension: reading, exporting, members and billing stay; sending does not.
    const ctx = await fx.ctx(c, c.owner);
    expect(ctx.tenant.status).toBe('restricted');
    expect(ctx.permissions.has('contacts.export')).toBe(true);
    expect(ctx.permissions.has('billing.manage')).toBe(true);
    expect(ctx.permissions.has('campaigns.send')).toBe(false);
    expect(() => assertCan(ctx, 'inbox.reply')).toThrow(/plan has ended/);

    // Only a plan change lifts the restriction; staff may still suspend it.
    await expectAppError(
      platform().setTenantStatus(operator, {
        tenantId: c.tenant.id,
        status: 'active',
        reason: 'Customer asked to reactivate',
      }),
      'precondition_failed',
      /Change the company's plan/,
    );
    await platform().setTenantStatus(operator, {
      tenantId: c.tenant.id,
      status: 'suspended',
      reason: 'Chargeback investigation #4411',
    });
    // A new plan while suspended leaves it suspended; reactivating then makes it active.
    await activePlan(operator, c.tenant.id, planId);
    expect((await companyStatus(c.tenant.id)).status).toBe('suspended');
    await putOnPlan(operator, c.tenant.id, { status: 'canceled' });
    await platform().setTenantStatus(operator, {
      tenantId: c.tenant.id,
      status: 'active',
      reason: 'Investigation closed, no fraud',
    });
    // The plan had ended meanwhile: reactivation restricts rather than activates.
    expect(await companyStatus(c.tenant.id)).toEqual({
      status: 'restricted',
      status_reason: 'The plan was canceled.',
    });
    await putOnPlan(operator, c.tenant.id, {
      status: 'trialing',
      planId,
      trialEndsOn: day(7),
    });
    expect(await companyStatus(c.tenant.id)).toEqual({ status: 'active', status_reason: null });
    expect((await fx.ctx(c, c.owner)).permissions.has('inbox.reply')).toBe(true);
  });
});

describe('plan sweep', () => {
  it('ends trials, moves paid periods through grace, restricts, and emails billing managers once', async () => {
    const owner = await staff('platform_owner');
    const operator = await staff('platform_operator');
    const planId = await publishedPlan(owner, { graceDays: '3' });
    const noGrace = await publishedPlan(owner, { graceDays: '0' });
    const trial = await fx.company();
    const paid = await fx.company();
    const abrupt = await fx.company();
    await putOnPlan(operator, trial.tenant.id, { status: 'trialing', planId, trialEndsOn: day(2) });
    await activePlan(operator, paid.tenant.id, planId, { periodEnd: day(10) });
    await activePlan(operator, abrupt.tenant.id, noGrace, { periodEnd: day(10) });
    const noticesBefore = await Promise.all(
      [trial, paid, abrupt].map((c) => billingNotices(c.tenant.id)),
    );

    // Nothing is due yet.
    await sweep();
    expect((await planRow(trial.tenant.id)).status).toBe('trialing');

    // Time passes (the database's clock decides): the trial and both periods have ended.
    await fx.dbs.adminPool.query(
      `UPDATE app.tenant_plans SET trial_ends_at = now() - interval '1 minute' WHERE tenant_id = $1`,
      [trial.tenant.id],
    );
    await fx.dbs.adminPool.query(
      `UPDATE app.tenant_plans SET period_start = now() - interval '31 days',
              period_end = now() - interval '1 hour' WHERE tenant_id = ANY($1)`,
      [[paid.tenant.id, abrupt.tenant.id]],
    );
    const result = await sweep();
    expect(result.failed).toEqual([]);
    expect(result.transitioned).toBeGreaterThanOrEqual(3);

    expect(await planRow(trial.tenant.id)).toMatchObject({ status: 'expired' });
    expect((await companyStatus(trial.tenant.id)).status).toBe('restricted');
    const pastDue = await planRow(paid.tenant.id);
    expect(pastDue.status).toBe('past_due');
    const grace = (pastDue.grace_ends_at!.getTime() - pastDue.period_end!.getTime()) / DAY_MS;
    expect(grace).toBeCloseTo(3, 5);
    // Grace: everything keeps working.
    expect((await companyStatus(paid.tenant.id)).status).toBe('active');
    expect((await fx.ctx(paid, paid.owner)).plan.status).toBe('past_due');
    expect(await planRow(abrupt.tenant.id)).toMatchObject({ status: 'expired' });
    expect((await companyStatus(abrupt.tenant.id)).status).toBe('restricted');

    // Each change is in the company's audit log, attributed to the system, and each lapse was
    // emailed to the billing managers (the fixture companies have one: the owner).
    const audit = await fx.dbs.adminPool.query<{ action: string; actor_type: string }>(
      `SELECT action, actor_type FROM app.audit_events
        WHERE tenant_id = $1 AND subject_type = 'tenant_plan' AND actor_type = 'system'`,
      [trial.tenant.id],
    );
    expect(audit.rows).toEqual([{ action: 'plan.expired', actor_type: 'system' }]);
    const noticesAfter = await Promise.all(
      [trial, paid, abrupt].map((c) => billingNotices(c.tenant.id)),
    );
    expect(noticesAfter.map((n, i) => n - noticesBefore[i]!)).toEqual([1, 1, 1]);

    // A second sweep finds nothing new; the grace period then ends.
    await sweep();
    expect(await billingNotices(paid.tenant.id)).toBe(noticesAfter[1]);
    await fx.dbs.adminPool.query(
      `UPDATE app.tenant_plans SET grace_ends_at = now() - interval '1 minute' WHERE tenant_id = $1`,
      [paid.tenant.id],
    );
    await sweep();
    expect(await planRow(paid.tenant.id)).toMatchObject({ status: 'expired' });
    expect((await companyStatus(paid.tenant.id)).status).toBe('restricted');
    expect(await billingNotices(paid.tenant.id)).toBe(noticesAfter[1]! + 1);

    // Two sweeps that listed the same company: the second finds nothing left to do.
    const again = await fx.dbs.app.run(authorizedTenantScope(trial.tenant.id, null), (tx) =>
      tx.execute(sql`select * from app.apply_plan_transition(${trial.tenant.id}::uuid)`),
    );
    expect(again.rows).toEqual([]);

    // The transition function runs only in the company's own scope.
    await expectAppError(
      fx.dbs.app.run(authorizedTenantScope(trial.tenant.id, null), (tx) =>
        tx.execute(sql`select * from app.apply_plan_transition(${paid.tenant.id}::uuid)`),
      ),
      'forbidden',
    );
  });
});

describe('limits', () => {
  it('counts waiting invitations as seats, at invitation, acceptance and restore, under races', async () => {
    const owner = await staff('platform_owner');
    const operator = await staff('platform_operator');
    const { owner: boss, tenant } = await bareCompany();
    const svc = tenancy();
    // Invitations sent while complimentary: two waiting.
    const first = await createUser(fx.dbs);
    const second = await createUser(fx.dbs);
    const a = await invite(fx.dbs, tenant, boss, first.email, ['agent']);
    const b = await invite(fx.dbs, tenant, boss, second.email, ['agent']);

    // Now two seats: the owner and one more. Both invitations still exist, but only one fits.
    const planId = await publishedPlan(owner, { seatsIncluded: '2' });
    await activePlan(operator, tenant.id, planId);
    const results = await Promise.allSettled([
      acceptInvitation(fx.dbs, first, a.token),
      acceptInvitation(fx.dbs, second, b.token),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(refused.reason)).toMatch(/Every seat of this company's plan is taken/);

    // The refused invitation still waits, and holds a seat, until it is revoked or expires.
    const ctx = await ctxOf(tenant.slug, boss);
    expect((await plansService().usage(ctx)).seats).toEqual({ members: 2, invitations: 1 });
    await expectAppError(
      svc.createInvitation(ctx, { email: 'third@example.test', roles: ['agent'] }),
      'precondition_failed',
      /allows 2 seats, and all are in use/,
    );
    // Suspending a member frees a seat and revoking the invitation another; a new invitation then
    // holds one, so the suspended member cannot be restored while it waits.
    const joinedFirst = results[0]!.status === 'fulfilled';
    const joined = joinedFirst ? first : second;
    const leftover = joinedFirst ? b : a;
    const [membership] = (
      await fx.dbs.adminPool.query<{ id: string }>(
        `SELECT id FROM app.memberships WHERE tenant_id = $1 AND user_id = $2`,
        [tenant.id, joined.id],
      )
    ).rows;
    await svc.setMemberStatus(ctx, { membershipId: membership!.id, status: 'suspended' });
    await svc.revokeInvitation(ctx, { invitationId: leftover.invitationId });
    await svc.createInvitation(ctx, { email: 'third@example.test', roles: ['agent'] });
    await expectAppError(
      svc.setMemberStatus(ctx, { membershipId: membership!.id, status: 'active' }),
      'precondition_failed',
      /allows 2 seats/,
    );
    expect((await plansService().usage(ctx)).seats).toEqual({ members: 1, invitations: 1 });

    // Concurrent invitations: exactly the free seats are taken.
    await putOnPlan(operator, tenant.id, {
      status: 'active',
      planId: await publishedPlan(owner, { seatsIncluded: '5' }),
      periodStart: day(0),
      periodEnd: day(30),
    });
    const rush = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        svc.createInvitation(ctx, { email: `rush${i}@example.test`, roles: ['agent'] }),
      ),
    );
    // Owner + one waiting invitation + three new = 5.
    expect(rush.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect((await plansService().usage(ctx)).seats).toEqual({ members: 1, invitations: 4 });
  });

  it('limits teams and live automations where they are added, and a lower limit removes nothing', async () => {
    const owner = await staff('platform_owner');
    const operator = await staff('platform_operator');
    const c = await fx.company();
    const planId = await publishedPlan(owner, { teamsMax: '1', liveAutomationsMax: '1' });
    await activePlan(operator, c.tenant.id, planId);
    const ctx = await fx.ctx(c, c.owner);
    const teams = createTeamsService({ db: fx.dbs.app, clock: systemClock });
    const team = { assignment: 'manual', memberIds: [], channelIds: [] };
    await teams.createTeam(ctx, { name: 'Sales', ...team });
    await expectAppError(
      teams.createTeam(ctx, { name: 'Support', ...team }),
      'precondition_failed',
      /allows 1 team, and all are in use/,
    );

    const first = await liveAutomation(ctx, 'Greeting');
    const second = await draftAutomation(ctx, 'Second');
    await expectAppError(
      automations().publishAutomation(ctx, {
        id: second.id,
        expectedVersion: second.version,
        note: null,
      }),
      'precondition_failed',
      /allows 1 live automation/,
    );
    // A new version of the live one is not another live automation.
    const detail = await automations().getAutomation(ctx, first.id);
    await automations().updateAutomation(ctx, {
      id: first.id,
      expectedVersion: detail.version,
      name: 'Greeting',
      description: null,
      channelAccountId: null,
      trigger: keyword('hello', 'good morning'),
      graph: hello,
    });
    const edited = await automations().getAutomation(ctx, first.id);
    await automations().publishAutomation(ctx, {
      id: first.id,
      expectedVersion: edited.version,
      note: null,
    });
    // Pausing frees the slot; turning the first on again is then refused.
    const current = await automations().getAutomation(ctx, first.id);
    await automations().setAutomationStatus(ctx, {
      id: first.id,
      expectedVersion: current.version,
      status: 'paused',
    });
    await automations().publishAutomation(ctx, {
      id: second.id,
      expectedVersion: second.version,
      note: null,
    });
    const paused = await automations().getAutomation(ctx, first.id);
    await expectAppError(
      automations().setAutomationStatus(ctx, {
        id: first.id,
        expectedVersion: paused.version,
        status: 'active',
      }),
      'precondition_failed',
      /allows 1 live automation/,
    );

    // Down to no teams and no live automations: what exists stays.
    await activePlan(
      operator,
      c.tenant.id,
      await publishedPlan(owner, { teamsMax: '0', liveAutomationsMax: '0' }),
    );
    const usage = await plansService().usage(await fx.ctx(c, c.owner));
    expect(usage).toMatchObject({
      teams: 1,
      liveAutomations: 1,
      limits: { teams: 0, liveAutomations: 0 },
    });
  });

  it('counts connected WhatsApp numbers, not disconnected ones, against the plan', async () => {
    const owner = await staff('platform_owner');
    const operator = await staff('platform_operator');
    const c = await fx.company();
    const planId = await publishedPlan(owner, { numberPrice: '999' });
    await activePlan(operator, c.tenant.id, planId);
    const check = () =>
      fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), (tx) =>
        assertNumberAvailable(tx, c.tenant.id),
      );
    await expectAppError(check(), 'precondition_failed', /allows 1 WhatsApp number/);
    await fx.dbs.adminPool.query(
      `UPDATE app.channel_accounts SET status = 'disconnected' WHERE id = $1`,
      [c.channelAccountId],
    );
    await check();
    await fx.dbs.adminPool.query(
      `UPDATE app.channel_accounts SET status = 'active' WHERE id = $1`,
      [c.channelAccountId],
    );
    await activePlan(operator, c.tenant.id, planId, { extraNumbers: '1' });
    await check();
    const staffView = await admin().tenantPlan(operator, c.tenant.id);
    expect(staffView.usage.numbers).toBe(1);
    expect(staffView.limits.numbers).toBe(2);
  });

  it('takes a slot again when the setup of a failed number is retried', async () => {
    const owner = await staff('platform_owner');
    const operator = await staff('platform_operator');
    const c = await fx.company();
    await activePlan(operator, c.tenant.id, await publishedPlan(owner));
    const failedId = uuidv7();
    await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), (tx) =>
      tx.insert(channelAccounts).values({
        id: failedId,
        tenantId: c.tenant.id,
        whatsappAccountId: c.whatsappAccountId,
        phoneNumberId: nextExternalId(),
        status: 'failed',
        displayPhoneNumber: '+91 90000 00009',
      }),
    );
    const onboarding = createOnboardingService({
      db: fx.dbs.app,
      keyring: fx.keyring,
      jobs: fx.jobs(),
      signer: fx.signer,
      clock: systemClock,
      graph: fx.graph,
      meta: {
        appId: APP_ID,
        appSecret: APP_SECRET,
        webhookSecrets: [APP_SECRET],
        graphApiVersion: 'v26.0',
        graphBaseUrl: fx.standIn.baseUrl,
        webhookVerifyToken: 'verify',
        embeddedSignupConfigId: '777',
      },
    });
    const ctx = await fx.ctx(c, c.owner);
    const status = async () =>
      (
        await fx.query<{ status: string }>(
          'SELECT status FROM app.channel_accounts WHERE id = $1',
          [failedId],
        )
      )[0]!.status;
    // The plan's one number is the connected one.
    await expectAppError(
      onboarding.retrySetup(ctx, failedId),
      'precondition_failed',
      /allows 1 WhatsApp number/,
    );
    expect(await status()).toBe('failed');
    await fx.dbs.adminPool.query(
      `UPDATE app.channel_accounts SET status = 'disconnected' WHERE id = $1`,
      [c.channelAccountId],
    );
    await onboarding.retrySetup(ctx, failedId);
    expect(await status()).toBe('onboarding');
    // Retrying a number that is already being set up takes no second slot.
    await onboarding.retrySetup(ctx, failedId);
  });
});

describe('automation runs', () => {
  it('starts at most the month’s runs from customer messages, and run packs add more', async () => {
    const owner = await staff('platform_owner');
    const operator = await staff('platform_operator');
    const c = await fx.company();
    const planId = await publishedPlan(owner, {
      automationRunsMonthly: '2',
      runPackSize: '1',
      runPackPrice: '99',
    });
    await activePlan(operator, c.tenant.id, planId);
    const ctx = await fx.ctx(c, c.owner);
    await liveAutomation(ctx, 'Greeting');
    const hi = (from: string) =>
      fx.deliver(fx.messagesBody(c, { messages: [{ waId: from, text: 'hello there' }] }));

    await hi(waId());
    await hi(waId());
    expect(await liveRuns(c.tenant.id)).toBe(2);
    // The third customer gets no bot: the month's runs are used up.
    await hi(waId());
    expect(await liveRuns(c.tenant.id)).toBe(2);
    const usage = await plansService().usage(await fx.ctx(c, c.owner));
    expect(usage.automationRuns.used).toBe(2);
    expect(usage.limits.automationRuns).toBe(2);

    // The billing managers hear about it once, also when two sweeps listed the counter.
    const before = await billingNotices(c.tenant.id);
    expect((await sweep()).announced).toBeGreaterThanOrEqual(1);
    expect(await billingNotices(c.tenant.id)).toBe(before + 1);
    await sweep();
    const [counter] = await fx.query<{ id: string }>(
      `SELECT id FROM app.usage_counters WHERE tenant_id = $1`,
      [c.tenant.id],
    );
    expect(
      await announceRunLimit(
        { db: fx.dbs.app, clock: systemClock, notices: notices() },
        c.tenant.id,
        counter!.id,
      ),
    ).toBe(false);
    expect(await billingNotices(c.tenant.id)).toBe(before + 1);

    // A run pack raises the limit within the same month.
    await activePlan(operator, c.tenant.id, planId, { runPacks: '1' });
    await hi(waId());
    expect(await liveRuns(c.tenant.id)).toBe(3);
    const unanswered = waId();
    await hi(unanswered);
    expect(await liveRuns(c.tenant.id)).toBe(3);

    // Test runs are never counted (here in the conversation no live run took).
    const [automation] = await automations().listAutomations(ctx, {});
    const detail = await automations().getAutomation(ctx, automation!.id);
    const [conv] = await fx.query<{ id: string }>(
      `SELECT cv.id FROM app.conversations cv
         JOIN app.contact_identities i ON i.tenant_id = cv.tenant_id AND i.contact_id = cv.contact_id
        WHERE cv.tenant_id = $1 AND i.wa_id = $2`,
      [c.tenant.id, unanswered],
    );
    await automations().startTestRun(await fx.ctx(c, c.owner), {
      id: detail.id,
      expectedVersion: detail.version,
      conversationId: conv!.id,
    });
    expect((await plansService().usage(await fx.ctx(c, c.owner))).automationRuns.used).toBe(3);
  });

  it('never counts more runs than the limit, however many start at once', async () => {
    const owner = await staff('platform_owner');
    const operator = await staff('platform_operator');
    const { tenant } = await bareCompany();
    await activePlan(
      operator,
      tenant.id,
      await publishedPlan(owner, { automationRunsMonthly: '5' }),
    );
    const now = new Date();
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () =>
        fx.dbs.app.run(authorizedTenantScope(tenant.id, null), (tx) =>
          consumeAutomationRun(tx, tenant.id, now),
        ),
      ),
    );
    expect(outcomes.filter((o) => o.ok)).toHaveLength(5);
    expect(outcomes.filter((o) => !o.ok)).toEqual(
      Array.from({ length: 7 }, () => ({ ok: false, reason: 'automation_quota' })),
    );
    // The next month starts from zero.
    const nextMonth = new Date(now.getTime() + 32 * DAY_MS);
    const next = await fx.dbs.app.run(authorizedTenantScope(tenant.id, null), (tx) =>
      consumeAutomationRun(tx, tenant.id, nextMonth),
    );
    expect(next).toEqual({ ok: true });
  });
});

describe('modules', () => {
  it('a plan without a module keeps reading and removes changing, sending and starting', async () => {
    const owner = await staff('platform_owner');
    const operator = await staff('platform_operator');
    const c = await fx.company();
    const ctx0 = await fx.ctx(c, c.owner);
    await liveAutomation(ctx0, 'Greeting');
    await activePlan(operator, c.tenant.id, await publishedPlan(owner, { modules: [] }));

    const ctx = await fx.ctx(c, c.owner);
    for (const permission of [
      'automations.write',
      'automations.publish',
      'flows.write',
      'flows.publish',
      'crm.write',
      'commerce.manage',
    ] as const) {
      expect(ctx.permissions.has(permission)).toBe(false);
      expect(ctx.rolePermissions.has(permission)).toBe(true);
    }
    for (const permission of [
      'automations.read',
      'flows.read',
      'crm.read',
      'commerce.read',
    ] as const)
      expect(ctx.permissions.has(permission)).toBe(true);
    expect(() => assertCan(ctx, 'crm.write')).toThrow(/does not include CRM/);

    // Services refuse with the plan's reason; reading still works.
    const crm = createCrmService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
    });
    await expectAppError(crm.createDeal(ctx, {}), 'forbidden', /does not include CRM/);
    expect(Array.isArray(await crm.listPipelines(ctx))).toBe(true);
    const commerce = createCommerceService({
      db: fx.dbs.app,
      clock: systemClock,
      jobs: fx.jobs(),
      signer: fx.signer,
      keyring: fx.keyring,
      appBaseUrl: 'http://localhost:3000',
      allowLiveKeys: false,
    });
    await expectAppError(
      commerce.sendProducts(ctx, {}),
      'forbidden',
      /does not include Commerce and stores/,
    );
    expect((await automations().listAutomations(ctx, {})).length).toBe(1);

    // The live automation no longer starts from customer messages.
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: waId(), text: 'hello' }] }));
    expect(await liveRuns(c.tenant.id)).toBe(0);
  });
});

describe('isolation', () => {
  it('shows a company only its own plan state and usage, and the platform helpers only to staff', async () => {
    const a = await fx.company();
    const b = await fx.company();
    for (const table of ['app.tenant_plans', 'app.usage_counters']) {
      const seen = await fx.dbs.app.run(authorizedTenantScope(a.tenant.id, a.owner.id), (tx) =>
        tx.execute<{ tenant_id: string }>(sql.raw(`select tenant_id from ${table}`)),
      );
      expect(seen.rows.every((r) => r.tenant_id === a.tenant.id)).toBe(true);
    }
    const entitlements = await fx.dbs.app.run(
      authorizedTenantScope(a.tenant.id, a.owner.id),
      (tx) => tx.execute(sql`select * from app.tenant_entitlements(${b.tenant.id}::uuid)`),
    );
    expect(entitlements.rows).toEqual([]);
    // Companies cannot write their own plan state or counters directly.
    await expectAppError(
      fx.dbs.app.run(authorizedTenantScope(a.tenant.id, a.owner.id), (tx) =>
        tx.execute(sql`update app.tenant_plans set status = 'complimentary'`),
      ),
      'forbidden',
    );
    await expectAppError(
      fx.dbs.app.run(authorizedTenantScope(a.tenant.id, a.owner.id), (tx) =>
        tx.execute(sql`select * from ops.platform_tenant_usage(${b.tenant.id}::uuid)`),
      ),
      'forbidden',
    );
    // A platform account that is not staff gets nothing from the usage helper.
    const outsider = await createUser(fx.dbs, { twoFactor: true });
    await expectAppError(
      fx.dbs.platform.run(outsider.id, (tx) =>
        tx.execute(sql`select * from ops.platform_tenant_usage(${b.tenant.id}::uuid)`),
      ),
      'forbidden',
      /platform administrator required/,
    );
  });
});

describe('plan change notices (ADR-100)', () => {
  const notify = () => notifyStaffPlanChanges({ db: fx.dbs.app, notices: notices() });
  /** The plan change emails queued for the company, decrypted, oldest first. */
  async function changeEmails(tenantId: string) {
    const { rows } = await fx.dbs.adminPool.query<{
      id: string;
      to_address: string;
      payload_ciphertext: string;
    }>(
      `SELECT id, to_address, payload_ciphertext FROM ops.email_outbox
        WHERE tenant_id = $1 AND kind = 'billing.notice' ORDER BY created_at, id`,
      [tenantId],
    );
    return rows
      .map((r) => ({
        to: r.to_address,
        ...(JSON.parse(fx.keyring.decryptString(r.payload_ciphertext, outboxAad(r.id))) as {
          subject: string;
          lines: string[];
          url: string;
        }),
      }))
      .filter((e) => e.subject === 'HyFib changed your plan');
  }
  const mark = async (tenantId: string) =>
    (
      await fx.dbs.adminPool.query<{ staff_notice_version: number | null; version: number }>(
        `SELECT staff_notice_version, version FROM app.tenant_plans WHERE tenant_id = $1`,
        [tenantId],
      )
    ).rows[0]!;
  /** A fixture company with a billing manager besides its owner, and an administrator. */
  async function companyWithBilling() {
    const c = await fx.company();
    const billing = await createUser(fx.dbs, { name: 'Billing Person' });
    const administrator = await createUser(fx.dbs, { name: 'Admin Person' });
    for (const [user, role] of [
      [billing, 'billing'],
      [administrator, 'admin'],
    ] as const) {
      const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, [role]);
      await acceptInvitation(fx.dbs, user, token);
    }
    return { ...c, billing };
  }

  it('tells the billing managers once about a plan staff set, with its period, add-ons and reason', async () => {
    const owner = await staff('platform_owner');
    const operator = await staff('platform_operator');
    const planId = await publishedPlan(owner, { seatPrice: '499', seatsMax: '10' });
    const c = await companyWithBilling();
    await activePlan(operator, c.tenant.id, planId, { extraSeats: 2 });
    const state = await mark(c.tenant.id);
    expect(state.staff_notice_version).toBe(state.version);

    expect(await notify()).toMatchObject({ failed: [] });
    const emails = await changeEmails(c.tenant.id);
    expect(emails.map((e) => e.to).sort()).toEqual([c.billing.email, c.owner.email].sort());
    const [email] = emails;
    expect(email!.lines[0]).toMatch(/^HyFib changed the plan of .+ on \d{1,2} \w+ \d{4}\.$/);
    expect(email!.lines[1]).toMatch(
      /^It is now on the Growth plan, for the paid period from \d{1,2} \w+ \d{4} to \d{1,2} \w+ \d{4}\.$/,
    );
    expect(email!.lines).toContain('It includes 2 extra seats on top of the plan.');
    expect(email!.lines).toContain("HyFib's reason: Invoice INV-1001 paid by bank transfer");
    expect(email!.url).toBe(`http://localhost:3000/c/${c.tenant.slug}/billing`);
    expect((await mark(c.tenant.id)).staff_notice_version).toBeNull();

    // Told once: the next sweep has nothing for the company.
    await notify();
    expect(await changeEmails(c.tenant.id)).toHaveLength(2);
  });

  it('tells two changes before the sweep once, the same plan again never, and a replaced change never', async () => {
    const owner = await staff('platform_owner');
    const operator = await staff('platform_operator');
    const planId = await publishedPlan(owner);
    const c = await fx.company();
    await putOnPlan(operator, c.tenant.id, { status: 'trialing', planId, trialEndsOn: day(5) });
    await activePlan(operator, c.tenant.id, planId);
    await notify();
    const emails = await changeEmails(c.tenant.id);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.lines[1]).toMatch(/^It is now on the Growth plan, for the paid period/);

    // The same plan again changes nothing, so nothing is told.
    await activePlan(operator, c.tenant.id, planId);
    expect((await mark(c.tenant.id)).staff_notice_version).toBeNull();

    // A trial staff set, which the plan sweep ends before the notice goes out: the sweep's own
    // email tells the company, and the replaced change is not told.
    await putOnPlan(operator, c.tenant.id, { status: 'trialing', planId, trialEndsOn: day(2) });
    await fx.dbs.adminPool.query(
      `UPDATE app.tenant_plans SET trial_ends_at = now() - interval '1 minute' WHERE tenant_id = $1`,
      [c.tenant.id],
    );
    expect((await sweep()).failed).toEqual([]);
    expect((await planRow(c.tenant.id)).status).toBe('expired');
    const replaced = await notify();
    expect(replaced.failed).toEqual([]);
    expect(replaced.superseded).toBeGreaterThanOrEqual(1);
    expect(await changeEmails(c.tenant.id)).toHaveLength(1);
    expect((await mark(c.tenant.id)).staff_notice_version).toBeNull();
  });

  it('leaves out companies being deleted, and two sweeps at once tell a change once', async () => {
    const owner = await staff('platform_owner');
    const planId = await publishedPlan(owner);
    const leaving = await fx.company();
    const staying = await fx.company();
    await activePlan(owner, leaving.tenant.id, planId);
    await activePlan(owner, staying.tenant.id, planId);
    await fx.dbs.adminPool.query(
      `UPDATE app.tenants SET status = 'pending_deletion' WHERE id = $1`,
      [leaving.tenant.id],
    );
    const due = async () =>
      (
        await fx.dbs.app.run(
          systemScope,
          (tx) =>
            tx.execute<{ tenant_id: string }>(
              sql`select tenant_id from ops.plan_change_notices_due(500)`,
            ),
          { accessMode: 'read only' },
        )
      ).rows.map((r) => r.tenant_id);
    expect(await due()).toContain(staying.tenant.id);
    expect(await due()).not.toContain(leaving.tenant.id);

    const [first, second] = await Promise.all([notify(), notify()]);
    expect([...first!.failed, ...second!.failed]).toEqual([]);
    expect(await changeEmails(staying.tenant.id)).toHaveLength(1);
    expect(await changeEmails(leaving.tenant.id)).toHaveLength(0);
    expect((await mark(leaving.tenant.id)).staff_notice_version).not.toBeNull();
  });

  it('locks the company before its plan state, so a staff change during a notice waits for it', async () => {
    const owner = await staff('platform_owner');
    const planId = await publishedPlan(owner);
    const c = await fx.company();
    await activePlan(owner, c.tenant.id, planId);
    // Another transaction holds the company row as a staff change does, before its plan state.
    const holder = await fx.dbs.adminPool.connect();
    let sending: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM app.tenants WHERE id = $1 FOR UPDATE', [c.tenant.id]);
      const [lock] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      sending = notify();
      await vi.waitFor(
        async () => {
          const [waiting] = await fx.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity a WHERE $1 = ANY (pg_blocking_pids(a.pid))',
            [lock!.pid],
          );
          if (waiting!.n < 1) throw new Error('the notice is not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
      // The waiting notice holds nothing on the plan state, which the staff change locks next.
      await holder.query('SELECT 1 FROM app.tenant_plans WHERE tenant_id = $1 FOR UPDATE NOWAIT', [
        c.tenant.id,
      ]);
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    expect(await sending).toMatchObject({ failed: [] });
    expect(await changeEmails(c.tenant.id)).toHaveLength(1);
  });

  it('is marked only by staff changes and taken only in the company’s own scope', async () => {
    const owner = await staff('platform_owner');
    const planId = await publishedPlan(owner);
    const a = await fx.company();
    const b = await fx.company();
    await activePlan(owner, a.tenant.id, planId);
    await activePlan(owner, b.tenant.id, planId);
    // The runtime role can neither set nor clear the mark.
    await expectAppError(
      fx.dbs.app.run(authorizedTenantScope(a.tenant.id, a.owner.id), (tx) =>
        tx.execute(sql`update app.tenant_plans set staff_notice_version = null`),
      ),
      'forbidden',
    );
    // Taking needs a company scope and takes only that company's notice.
    await expect(
      fx.dbs.app.run(systemScope, (tx) => tx.execute(sql`select app.take_plan_change_notice()`)),
    ).rejects.toThrow();
    const taken = await fx.dbs.app.run(authorizedTenantScope(a.tenant.id, null), (tx) =>
      tx.execute<{ due: boolean | null }>(sql`select app.take_plan_change_notice() as due`),
    );
    expect(taken.rows).toEqual([{ due: true }]);
    expect((await mark(a.tenant.id)).staff_notice_version).toBeNull();
    expect((await mark(b.tenant.id)).staff_notice_version).not.toBeNull();
    const again = await fx.dbs.app.run(authorizedTenantScope(a.tenant.id, null), (tx) =>
      tx.execute<{ due: boolean | null }>(sql`select app.take_plan_change_notice() as due`),
    );
    expect(again.rows).toEqual([{ due: null }]);
    // The table refuses a mark beyond the plan state's version.
    await expect(
      fx.dbs.adminPool.query(
        'UPDATE app.tenant_plans SET staff_notice_version = version + 1 WHERE tenant_id = $1',
        [b.tenant.id],
      ),
    ).rejects.toThrow(/tenant_plans_staff_notice_version_check/);
  });
});
