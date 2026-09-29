import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7, type Clock } from '@w360/core';
import {
  API_NOT_IN_PLAN,
  admitApiRequest,
  authenticateApiToken,
  createApiKeysService,
  createPlanAdminService,
  createPlansService,
  dayOf,
  sweepPlanStates,
  type ApiContext,
  type BillingNoticeDeps,
  type PlatformActor,
} from '@w360/domain';
import { createUser } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * API access and monthly API requests by plan (P5-08, ADR-061) against real PostgreSQL: requests
 * counted for the month with and without a limit, never beyond the limit however many arrive at
 * once, refused once the month's are used (with Retry-After until the next period), counted again
 * from the next period, a plan change taking effect at once, a plan without the API refusing every
 * request and new or rotated keys, one notice per period, published versions unchangeable, and
 * companies counted apart.
 */
let fx: WhatsAppFixture;
beforeAll(async () => {
  fx = await startWhatsAppFixture();
});
afterAll(async () => {
  await fx.close();
});

const DAY_MS = 86_400_000;
const at = (date: Date): Clock => ({ now: () => date });
const keys = () => createApiKeysService({ db: fx.dbs.app, clock: systemClock });
const admin = () => createPlanAdminService({ platformDb: fx.dbs.platform, clock: systemClock });
const plans = (clock: Clock = systemClock) => createPlansService({ db: fx.dbs.app, clock });
const notices = (): BillingNoticeDeps => ({
  outbox: { keyring: fx.keyring, jobs: fx.jobs(), signer: fx.signer },
  appBaseUrl: 'http://localhost:3000',
});
const admit = (ctx: ApiContext, now = new Date()) => admitApiRequest(fx.dbs.app, ctx, now);

async function expectAppError(promise: Promise<unknown>, code: string, message?: string) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe(code);
      if (message) expect(error.publicMessage).toBe(message);
      return error;
    }
  }
  throw new Error(`expected ${code}`);
}

async function platformOwner(): Promise<PlatformActor> {
  const user = await createUser(fx.dbs, { twoFactor: true });
  await fx.dbs.ownerPool.query(`INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, $2)`, [
    user.id,
    'platform_owner',
  ]);
  return { userId: user.id, role: 'platform_owner', correlationId: uuidv7() };
}

let codes = 0;
async function publishedPlan(owner: PlatformActor, apiRequestsMonthly: string) {
  codes += 1;
  const { id } = await admin().createPlan(owner, {
    code: `api-${Date.now().toString(36)}-${codes}`,
    name: 'API plan',
    price: '999',
    intervalMonths: '1',
    trialDays: '0',
    graceDays: '7',
    seatsIncluded: '10',
    numbersIncluded: '5',
    apiRequestsMonthly,
    modules: [],
  });
  await admin().publishPlan(owner, id);
  return id;
}

/** Puts the company on a paid period of the plan from today (the same period every time). */
async function activePlan(owner: PlatformActor, c: Company, planId: string) {
  const view = await admin().tenantPlan(owner, c.tenant.id);
  const day = (offset: number) => dayOf(new Date(Date.now() + offset * DAY_MS), 'Asia/Kolkata');
  await admin().setTenantPlan(owner, {
    tenantId: c.tenant.id,
    version: view.state.version,
    reason: 'Invoice INV-7001 paid by bank transfer',
    status: 'active',
    planId,
    periodStart: day(0),
    periodEnd: day(30),
  });
}

/** A key of the company made by its owner, and the context requests with it get. */
async function apiKey(c: Company): Promise<{ id: string; token: string; ctx: ApiContext }> {
  const owner = await fx.ctx(c, c.owner);
  const created = await keys().create(owner, {
    name: 'Quota test',
    scopes: ['contacts.read'],
    expiresInDays: 0,
  });
  const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
  if (!ctx) throw new Error('a new key does not authenticate');
  return { id: created.id, token: created.token, ctx };
}

async function usage(c: Company, clock: Clock = systemClock) {
  return plans(clock).usage(await fx.ctx(c, c.owner));
}

async function billingNotices(tenantId: string): Promise<number> {
  const { rows } = await fx.dbs.adminPool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ops.email_outbox WHERE tenant_id = $1 AND kind = 'billing.notice'`,
    [tenantId],
  );
  return rows[0]!.n;
}

describe('monthly API requests by plan', () => {
  it('counts requests without a limit, and never admits more than the limit, even all at once', async () => {
    const owner = await platformOwner();
    const free = await fx.company();
    const { ctx: freeKey } = await apiKey(free);
    expect((await usage(free)).limits.apiRequests).toBeNull();
    for (let i = 0; i < 3; i += 1) expect(await admit(freeKey)).toEqual({ ok: true });
    expect((await usage(free)).apiRequests.used).toBe(3);

    const limited = await fx.company();
    const { ctx } = await apiKey(limited);
    await activePlan(owner, limited, await publishedPlan(owner, '5'));
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 12 }, () => admit(ctx, now)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    const { periodEnd } = (await usage(limited)).apiRequests;
    const refusal = {
      ok: false,
      status: 429,
      code: 'rate_limited',
      reason: 'quota_exceeded',
      message: `Your company's plan allows 5 API requests a month, and all are used. Requests are accepted again from ${periodEnd.toISOString()}.`,
      retryAfterSeconds: Math.ceil((periodEnd.getTime() - now.getTime()) / 1000),
    };
    expect(results.filter((r) => !r.ok)).toEqual(Array.from({ length: 7 }, () => refusal));
    const after = await usage(limited);
    expect([after.apiRequests.used, after.limits.apiRequests]).toEqual([5, 5]);
    // Refused requests are not counted, and the other companies' counts are their own.
    expect(await admit(ctx, now)).toEqual(refusal);
    expect((await usage(limited)).apiRequests.used).toBe(5);
    expect((await usage(free)).apiRequests.used).toBe(3);

    // The next period counts from zero again.
    const next = at(periodEnd);
    expect(await admit(ctx, periodEnd)).toEqual({ ok: true });
    expect((await usage(limited, next)).apiRequests).toMatchObject({
      used: 1,
      periodStart: periodEnd,
    });
    expect((await usage(limited)).apiRequests.used).toBe(5);
  });

  it('applies a plan change at once within the period, and emails the billing managers once', async () => {
    const owner = await platformOwner();
    const c = await fx.company();
    const { ctx } = await apiKey(c);
    await activePlan(owner, c, await publishedPlan(owner, '2'));
    expect(await admit(ctx)).toEqual({ ok: true });
    expect(await admit(ctx)).toEqual({ ok: true });
    expect(await admit(ctx)).toMatchObject({ ok: false, reason: 'quota_exceeded' });

    // The limit is reached: one notice, however often the sweep runs.
    const before = await billingNotices(c.tenant.id);
    const sweep = () => sweepPlanStates({ db: fx.dbs.app, clock: systemClock, notices: notices() });
    await sweep();
    await sweep();
    expect(await billingNotices(c.tenant.id)).toBe(before + 1);
    const { rows } = await fx.dbs.adminPool.query<{ notified: boolean }>(
      `SELECT notified_at IS NOT NULL AS notified FROM app.usage_counters
        WHERE tenant_id = $1 AND metric = 'api_requests'`,
      [c.tenant.id],
    );
    expect(rows).toEqual([{ notified: true }]);

    // A larger plan in the same period: the month's count carries on under the new limit.
    await activePlan(owner, c, await publishedPlan(owner, '4'));
    expect(await admit(ctx)).toEqual({ ok: true });
    expect(await admit(ctx)).toEqual({ ok: true });
    expect(await admit(ctx)).toMatchObject({ ok: false, reason: 'quota_exceeded' });
    expect((await usage(c)).apiRequests.used).toBe(4);
    // A plan without a monthly limit lets every request through, still counted.
    await activePlan(owner, c, await publishedPlan(owner, ''));
    expect(await admit(ctx)).toEqual({ ok: true });
    expect((await usage(c)).apiRequests.used).toBe(5);
  });

  it('refuses every request and new or rotated keys when the plan leaves the API out', async () => {
    const owner = await platformOwner();
    const c = await fx.company();
    const { id: keyId, token, ctx } = await apiKey(c);
    await activePlan(owner, c, await publishedPlan(owner, '0'));

    expect(await admit(ctx)).toEqual({
      ok: false,
      status: 403,
      code: 'forbidden',
      reason: 'not_in_plan',
      message: API_NOT_IN_PLAN,
      retryAfterSeconds: null,
    });
    const counted = await fx.dbs.adminPool.query(
      `SELECT 1 FROM app.usage_counters WHERE tenant_id = $1 AND metric = 'api_requests'`,
      [c.tenant.id],
    );
    expect(counted.rowCount).toBe(0);
    expect((await usage(c)).limits.apiRequests).toBe(0);

    const companyOwner = await fx.ctx(c, c.owner);
    const refused = await expectAppError(
      keys().create(companyOwner, { name: 'Another', scopes: ['contacts.read'], expiresInDays: 0 }),
      'forbidden',
      API_NOT_IN_PLAN,
    );
    expect(isAppError(refused) && refused.details).toEqual({ apiReason: 'not_in_plan' });
    await expectAppError(
      keys().rotate(companyOwner, { keyId, overlapHours: 0 }),
      'forbidden',
      API_NOT_IN_PLAN,
    );
    // The existing key can still be revoked.
    await keys().revoke(companyOwner, { keyId });
    expect(await authenticateApiToken(fx.dbs.app, token, uuidv7())).toBeNull();

    // Back on a plan with the API, new keys work again.
    await activePlan(owner, c, await publishedPlan(owner, '10'));
    const { ctx: again } = await apiKey(c);
    expect(await admit(again)).toEqual({ ok: true });
  });

  it('keeps the monthly API requests of a published version, and carries them into its next version', async () => {
    const owner = await platformOwner();
    const id = await publishedPlan(owner, '250');
    await expect(
      fx.dbs.adminPool.query(`UPDATE ops.plans SET api_requests_monthly = 10 WHERE id = $1`, [id]),
    ).rejects.toThrow(/A published plan version cannot change/);
    // Retiring is the one change a published version allows, and it cannot carry another.
    await expect(
      fx.dbs.adminPool.query(
        `UPDATE ops.plans SET status = 'retired', retired_at = now(), retired_by_user_id = $2,
                api_requests_monthly = 10
          WHERE id = $1`,
        [id, owner.userId],
      ),
    ).rejects.toThrow(/A published plan version cannot change/);
    expect((await admin().getPlan(owner, id)).plan.apiRequestsMonthly).toBe(250);

    const { id: draft } = await admin().createVersion(owner, id);
    expect((await admin().getPlan(owner, draft)).plan.apiRequestsMonthly).toBe(250);
    await admin().updateDraft(owner, draft, {
      name: 'API plan',
      price: '999',
      intervalMonths: '1',
      trialDays: '0',
      graceDays: '7',
      seatsIncluded: '10',
      numbersIncluded: '5',
      apiRequestsMonthly: '0',
      modules: [],
    });
    expect((await admin().getPlan(owner, draft)).plan.apiRequestsMonthly).toBe(0);
    await expectAppError(
      admin().updateDraft(owner, draft, {
        name: 'API plan',
        price: '999',
        intervalMonths: '1',
        trialDays: '0',
        graceDays: '7',
        seatsIncluded: '10',
        numbersIncluded: '5',
        apiRequestsMonthly: '1000000001',
        modules: [],
      }),
      'validation_failed',
    );
  });
});
