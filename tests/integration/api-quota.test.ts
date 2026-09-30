import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7, type Clock } from '@w360/core';
import { authorizedTenantScope, sql } from '@w360/db';
import {
  API_NOT_IN_PLAN,
  API_SCOPE_KEYS,
  admitApiRequest,
  apiGetMessage,
  apiListContacts,
  apiListTemplates,
  authenticateApiRequest,
  authenticateApiToken,
  createApiKeysService,
  createApiWebhookEndpoints,
  createPlanAdminService,
  createPlansService,
  dayOf,
  sweepPlanStates,
  type ApiContext,
  type ApiScope,
  type BillingNoticeDeps,
  type PlatformActor,
  type TenantContext,
} from '@w360/domain';
import { createUser } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * API access and monthly API requests by plan (P5-08, ADR-061) against real PostgreSQL: requests
 * counted for the month with and without a limit, never beyond the limit however many arrive at
 * once, refused once the month's are used (with Retry-After until the next period), counted again
 * from the next period, a plan change taking effect at once, a plan without the API refusing every
 * request and new or rotated keys, one notice per period, published versions unchangeable, and
 * companies counted apart. Also the API scopes a plan includes (ADR-092), and each key's requests
 * counted apart under its own monthly limit (ADR-097).
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
    for (let i = 0; i < 3; i += 1) expect(await admit(freeKey)).toMatchObject({ ok: true });
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
    expect(await admit(ctx, periodEnd)).toMatchObject({ ok: true });
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
    expect(await admit(ctx)).toMatchObject({ ok: true });
    expect(await admit(ctx)).toMatchObject({ ok: true });
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
    expect(await admit(ctx)).toMatchObject({ ok: true });
    expect(await admit(ctx)).toMatchObject({ ok: true });
    expect(await admit(ctx)).toMatchObject({ ok: false, reason: 'quota_exceeded' });
    expect((await usage(c)).apiRequests.used).toBe(4);
    // A plan without a monthly limit lets every request through, still counted.
    await activePlan(owner, c, await publishedPlan(owner, ''));
    expect(await admit(ctx)).toMatchObject({ ok: true });
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
    // Nor for its key (ADR-097).
    const keyCounted = await fx.dbs.adminPool.query(
      `SELECT 1 FROM app.api_key_usage WHERE tenant_id = $1`,
      [c.tenant.id],
    );
    expect(keyCounted.rowCount).toBe(0);
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
    expect(await admit(again)).toMatchObject({ ok: true });
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

describe('API scopes by plan (ADR-092)', () => {
  const webhookApi = () =>
    createApiWebhookEndpoints({
      db: fx.dbs.app,
      clock: systemClock,
      keyring: fx.keyring,
      jobs: fx.jobs(),
      signer: fx.signer,
      egressPolicy: { allowLoopbackForTests: true },
      appBaseUrl: 'http://localhost:3000',
    });
  const notInPlan = (what: string) =>
    `Your company's plan does not include the ${what}. Ask HyFib to change the plan.`;

  /** A published version with every scope (null) or the scopes given. */
  async function scopedPlan(
    owner: PlatformActor,
    apiScopes: ApiScope[] | null,
    apiRequestsMonthly = '',
  ) {
    codes += 1;
    const { id } = await admin().createPlan(owner, {
      code: `scopes-${Date.now().toString(36)}-${codes}`,
      name: 'Scoped plan',
      price: '999',
      intervalMonths: '1',
      trialDays: '0',
      graceDays: '7',
      seatsIncluded: '10',
      numbersIncluded: '5',
      apiRequestsMonthly,
      apiScopeChoice: apiScopes === null ? 'all' : 'chosen',
      apiScopes: apiScopes ?? [],
      modules: [],
    });
    await admin().publishPlan(owner, id);
    return id;
  }

  async function keyWith(c: Company, scopes: ApiScope[]) {
    const owner = await fx.ctx(c, c.owner);
    return keys().create(owner, { name: 'Scoped key', scopes, expiresInDays: 0 });
  }

  /** A request with the token, admitted as the web app admits it: counted, under the plan. */
  async function admitted(token: string): Promise<ApiContext> {
    const auth = await authenticateApiRequest(fx.dbs.app, token, uuidv7(), null);
    if (!auth || !('authenticated' in auth)) throw new Error('the key does not authenticate');
    const admission = await admitApiRequest(fx.dbs.app, auth.authenticated, new Date());
    if (!admission.ok) throw new Error(admission.message);
    return admission.ctx;
  }

  it('holds each request to the scopes the plan includes, whatever its key has', async () => {
    const owner = await platformOwner();
    const c = await fx.company();
    const key = await keyWith(c, ['contacts.read', 'messages.send', 'webhooks.manage']);
    await activePlan(owner, c, await scopedPlan(owner, ['messages.send', 'contacts.read']));

    const ctx = await admitted(key.token);
    expect(ctx.planScopes && [...ctx.planScopes]).toEqual(['contacts.read', 'messages.send']);
    await expect(apiListContacts({ db: fx.dbs.app }, ctx, {})).resolves.toMatchObject({
      data: expect.any(Array),
    });
    const refused = await expectAppError(
      webhookApi().list(ctx),
      'forbidden',
      notInPlan('webhooks.manage scope'),
    );
    expect(refused.details).toEqual({ apiReason: 'not_in_plan' });
    // A scope the key does not have is refused as before, whatever the plan.
    await expectAppError(
      apiListTemplates({ db: fx.dbs.app }, ctx),
      'forbidden',
      'This API key does not have the templates.read scope.',
    );
    // A message's status needs any sending scope: messages.send is in the plan, so the lookup runs.
    await expectAppError(apiGetMessage({ db: fx.dbs.app }, ctx, uuidv7()), 'not_found');

    // A plan with no sending scope refuses the status too, naming the scope the key has.
    await activePlan(owner, c, await scopedPlan(owner, ['contacts.read']));
    const narrower = await admitted(key.token);
    const status = await expectAppError(
      apiGetMessage({ db: fx.dbs.app }, narrower, uuidv7()),
      'forbidden',
      notInPlan('messages.send scope'),
    );
    expect(status.details).toEqual({ apiReason: 'not_in_plan' });
    // The tests' contexts carry the plan too.
    const tested = await authenticateApiToken(fx.dbs.app, key.token, uuidv7());
    expect(tested?.planScopes && [...tested.planScopes]).toEqual(['contacts.read']);

    // Every scope again: the same key works, unchanged.
    await activePlan(owner, c, await scopedPlan(owner, null));
    const all = await admitted(key.token);
    expect(all.planScopes).toBeNull();
    await expect(webhookApi().list(all)).resolves.toEqual({ data: [] });
    await expectAppError(apiGetMessage({ db: fx.dbs.app }, all, uuidv7()), 'not_found');
  });

  it('refuses new keys a scope the plan leaves out, and keeps and rotates keys that have one', async () => {
    const owner = await platformOwner();
    const c = await fx.company();
    const old = await keyWith(c, ['contacts.read', 'webhooks.manage']);
    await activePlan(owner, c, await scopedPlan(owner, ['contacts.read', 'templates.read']));
    expect((await usage(c)).apiScopes).toEqual(['templates.read', 'contacts.read']);

    const companyOwner = await fx.ctx(c, c.owner);
    const refused = await expectAppError(
      keys().create(companyOwner, {
        name: 'Everything',
        scopes: ['webhooks.manage', 'contacts.read', 'messages.send'],
        expiresInDays: 0,
      }),
      'forbidden',
      notInPlan('messages.send and webhooks.manage scopes'),
    );
    expect(refused.details).toEqual({ apiReason: 'not_in_plan' });
    const reader = await keys().create(companyOwner, {
      name: 'Reader',
      scopes: ['templates.read', 'contacts.read'],
      expiresInDays: 0,
    });
    await expect(
      apiListTemplates({ db: fx.dbs.app }, await admitted(reader.token)),
    ).resolves.toMatchObject({ data: expect.any(Array) });

    // The key made before keeps its scopes, and rotating it keeps them: requests are refused the
    // one the plan leaves out.
    const rotated = await keys().rotate(companyOwner, { keyId: old.id, overlapHours: 0 });
    const listed = (await keys().list(companyOwner)).find((k) => k.id === rotated.id);
    expect(listed?.scopes).toEqual(['contacts.read', 'webhooks.manage']);
    const ctx = await admitted(rotated.token);
    await expectAppError(webhookApi().list(ctx), 'forbidden', notInPlan('webhooks.manage scope'));
    await expect(apiListContacts({ db: fx.dbs.app }, ctx, {})).resolves.toMatchObject({
      data: expect.any(Array),
    });
    // The platform's view of the company shows the plan's scopes.
    expect((await admin().tenantPlan(owner, c.tenant.id)).apiScopes).toEqual([
      'templates.read',
      'contacts.read',
    ]);
  });

  it("keeps a version's scopes coherent, unchangeable once published, and in its next version", async () => {
    const owner = await platformOwner();
    const fields = {
      name: 'Scoped plan',
      price: '999',
      intervalMonths: '1',
      trialDays: '0',
      graceDays: '7',
      seatsIncluded: '10',
      numbersIncluded: '5',
      apiRequestsMonthly: '',
      modules: [],
    };
    const none = await expectAppError(
      admin().createPlan(owner, {
        ...fields,
        code: `scopes-none-${Date.now().toString(36)}`,
        apiScopeChoice: 'chosen',
        apiScopes: [],
      }),
      'validation_failed',
    );
    expect(none.issues).toEqual([
      { path: 'apiScopes', message: 'Choose at least one API scope, or include every scope' },
    ]);
    // Kept in the list's order; a plan without the API keeps none.
    const id = await scopedPlan(owner, ['webhooks.manage', 'contacts.read']);
    expect((await admin().getPlan(owner, id)).plan.apiScopes).toEqual([
      'contacts.read',
      'webhooks.manage',
    ]);
    const noApi = await scopedPlan(owner, ['contacts.read'], '0');
    expect((await admin().getPlan(owner, noApi)).plan.apiScopes).toBeNull();
    // Versions made before choosing scopes existed include every scope.
    expect(
      (await admin().getPlan(owner, await publishedPlan(owner, ''))).plan.apiScopes,
    ).toBeNull();

    // Published: the scopes cannot change, not even while retiring.
    await expect(
      fx.dbs.adminPool.query(`UPDATE ops.plans SET api_scopes = NULL WHERE id = $1`, [id]),
    ).rejects.toThrow(/A published plan version cannot change/);
    await expect(
      fx.dbs.adminPool.query(
        `UPDATE ops.plans SET status = 'retired', retired_at = now(), retired_by_user_id = $2,
                api_scopes = ARRAY['contacts.read']
          WHERE id = $1`,
        [id, owner.userId],
      ),
    ).rejects.toThrow(/A published plan version cannot change/);

    // The next version starts from them, and platform staff may change them there.
    const { id: draft } = await admin().createVersion(owner, id);
    expect((await admin().getPlan(owner, draft)).plan.apiScopes).toEqual([
      'contacts.read',
      'webhooks.manage',
    ]);
    await admin().updateDraft(owner, draft, {
      ...fields,
      apiScopeChoice: 'chosen',
      apiScopes: ['templates.read'],
    });
    expect((await admin().getPlan(owner, draft)).plan.apiScopes).toEqual(['templates.read']);
    // The table refuses unknown scopes, an empty list and scopes without the API.
    for (const [scopes, monthly] of [
      [['contacts.delete'], null],
      [[], null],
      [['contacts.read'], 0],
    ] as const) {
      await expect(
        fx.dbs.adminPool.query(
          `UPDATE ops.plans SET api_scopes = $2::text[], api_requests_monthly = $3 WHERE id = $1`,
          [draft, scopes, monthly],
        ),
      ).rejects.toThrow(/plans_api_scopes/);
    }
    // The table's list of scopes is the API's.
    const { rows } = await fx.dbs.adminPool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'plans_api_scopes_check'`,
    );
    expect([...rows[0]!.def.matchAll(/'([a-z_.]+)'::text/g)].map((m) => m[1])).toEqual([
      ...API_SCOPE_KEYS,
    ]);
  });
});

describe('monthly request limits per key (ADR-097)', () => {
  /** A key of the company with its own monthly limit ('' for none), and its request context. */
  async function limitedKey(c: Company, monthlyRequestLimit: string) {
    const owner = await fx.ctx(c, c.owner);
    const created = await keys().create(owner, {
      name: 'Limited key',
      scopes: ['contacts.read'],
      expiresInDays: 0,
      monthlyRequestLimit,
    });
    const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
    if (!ctx) throw new Error('a new key does not authenticate');
    return { ...created, ctx };
  }

  /** Each key's requests this period and its own limit, as Settings → API keys lists them. */
  async function keyCounts(c: Company) {
    const list = await keys().list(await fx.ctx(c, c.owner));
    // One line per key, whatever periods it was counted in.
    expect(new Set(list.map((k) => k.id)).size).toBe(list.length);
    return Object.fromEntries(
      list.map((k) => [k.id, [k.requestsThisPeriod, k.monthlyRequestLimit] as const]),
    );
  }

  const keyRefusal = (limit: number, periodEnd: Date, now: Date) => ({
    ok: false,
    status: 429,
    code: 'rate_limited',
    reason: 'key_quota_exceeded',
    message: `This API key allows ${limit.toLocaleString('en-US')} requests a month, and all are used. Requests are accepted again from ${periodEnd.toISOString()}, or once the key's limit is raised in Settings → API keys.`,
    retryAfterSeconds: Math.ceil((periodEnd.getTime() - now.getTime()) / 1000),
  });

  it("counts each key's requests apart, and never admits more than a key's limit, even all at once", async () => {
    const c = await fx.company();
    const open = await limitedKey(c, '');
    const limited = await limitedKey(c, '3');
    expect(await admit(open.ctx)).toMatchObject({ ok: true });
    expect(await admit(open.ctx)).toMatchObject({ ok: true });
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 8 }, () => admit(limited.ctx, now)));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    const { periodEnd, used } = (await usage(c)).apiRequests;
    expect(results.filter((r) => !r.ok)).toEqual(
      Array.from({ length: 5 }, () => keyRefusal(3, periodEnd, now)),
    );
    // What the key refused is not counted for the company either.
    expect(used).toBe(5);
    expect(await keyCounts(c)).toEqual({ [open.id]: [2, null], [limited.id]: [3, 3] });

    // The key's next period, the company's, counts from zero; the list shows the current one.
    expect(await admit(limited.ctx, periodEnd)).toMatchObject({ ok: true });
    expect(await keyCounts(c)).toEqual({ [open.id]: [2, null], [limited.id]: [3, 3] });
    const rows = await fx.query<{ used: number }>(
      `SELECT used FROM app.api_key_usage WHERE tenant_id = $1 AND api_key_id = $2
        ORDER BY period_start`,
      [c.tenant.id, limited.id],
    );
    expect(rows).toEqual([{ used: 3 }, { used: 1 }]);
  });

  it('counts a request refused by its key or by its company for neither', async () => {
    const owner = await platformOwner();
    const c = await fx.company();
    const wide = await limitedKey(c, '5');
    const narrow = await limitedKey(c, '1');
    await activePlan(owner, c, await publishedPlan(owner, '2'));
    expect(await admit(narrow.ctx)).toMatchObject({ ok: true });
    expect(await admit(narrow.ctx)).toMatchObject({ ok: false, reason: 'key_quota_exceeded' });
    expect((await usage(c)).apiRequests.used).toBe(1);
    expect(await admit(wide.ctx)).toMatchObject({ ok: true });
    // The company's month is used up: its refusals leave the key's count as it was.
    expect(await admit(wide.ctx)).toMatchObject({ ok: false, reason: 'quota_exceeded' });
    expect(await admit(wide.ctx)).toMatchObject({ ok: false, reason: 'quota_exceeded' });
    expect((await usage(c)).apiRequests.used).toBe(2);
    expect(await keyCounts(c)).toEqual({ [wide.id]: [1, 5], [narrow.id]: [1, 1] });
    // With both used up, the key's refusal is the one given.
    expect(await admit(narrow.ctx)).toMatchObject({ ok: false, reason: 'key_quota_exceeded' });
  });

  it("admits exactly the company's limit across keys at once, each within its own", async () => {
    const owner = await platformOwner();
    const c = await fx.company();
    const a = await limitedKey(c, '4');
    const b = await limitedKey(c, '4');
    const open = await limitedKey(c, '');
    await activePlan(owner, c, await publishedPlan(owner, '10'));
    const now = new Date();
    const results = await Promise.all(
      [a, b, open].flatMap((k) =>
        Array.from({ length: 8 }, async () => [k.id, await admit(k.ctx, now)] as const),
      ),
    );
    const admitted = (id: string) => results.filter(([k, r]) => k === id && r.ok).length;
    expect(admitted(a.id)).toBeLessThanOrEqual(4);
    expect(admitted(b.id)).toBeLessThanOrEqual(4);
    expect(results.filter(([, r]) => r.ok)).toHaveLength(10);
    expect((await usage(c)).apiRequests.used).toBe(10);
    // Each key counted what was admitted: the company's refusals were taken back from its keys.
    expect(await keyCounts(c)).toEqual({
      [a.id]: [admitted(a.id), 4],
      [b.id]: [admitted(b.id), 4],
      [open.id]: [admitted(open.id), null],
    });
  });

  it("changes an active key's limit after a recent sign-in, audited, and carries it to the rotated key", async () => {
    const c = await fx.company();
    const other = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const key = await limitedKey(c, '2');
    const set = (ctx: TenantContext, monthlyRequestLimit: string, keyId = key.id) =>
      keys().setMonthlyLimit(ctx, { keyId, monthlyRequestLimit });
    const audit = async () =>
      (
        await fx.query<{ metadata: Record<string, unknown> }>(
          `SELECT metadata FROM app.audit_events
            WHERE action = 'api_key.limit_changed' AND subject_id = $1 ORDER BY occurred_at, id`,
          [key.id],
        )
      ).map((r) => r.metadata);

    expect(await admit(key.ctx)).toMatchObject({ ok: true });
    expect(await admit(key.ctx)).toMatchObject({ ok: true });
    expect(await admit(key.ctx)).toMatchObject({ ok: false, reason: 'key_quota_exceeded' });
    // A new limit applies at once, to the requests already counted this period.
    expect(await set(owner, '3')).toEqual({ monthlyRequestLimit: 3 });
    expect(await admit(key.ctx)).toMatchObject({ ok: true });
    expect(await admit(key.ctx)).toMatchObject({ ok: false, reason: 'key_quota_exceeded' });
    // The same limit again changes nothing and records nothing; emptied, only the plan limits it.
    expect(await set(owner, ' 3 ')).toEqual({ monthlyRequestLimit: 3 });
    expect(await set(owner, '')).toEqual({ monthlyRequestLimit: null });
    expect(await admit(key.ctx)).toMatchObject({ ok: true });
    expect(await set(owner, '1,000,000')).toEqual({ monthlyRequestLimit: 1_000_000 });
    expect(await audit()).toEqual([
      { keyPrefix: key.keyPrefix, from: 2, to: 3 },
      { keyPrefix: key.keyPrefix, from: 3, to: null },
      { keyPrefix: key.keyPrefix, from: null, to: 1_000_000 },
    ]);
    const [created] = await fx.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE action = 'api_key.created' AND subject_id = $1`,
      [key.id],
    );
    expect(created?.metadata).toMatchObject({ keyPrefix: key.keyPrefix, monthlyRequestLimit: 2 });

    // A stale sign-in, a member who does not manage keys, another company and bad input.
    const stale: TenantContext = { ...owner, signedInAt: new Date(Date.now() - 16 * 60_000) };
    await expectAppError(set(stale, '5'), 'step_up_required');
    await expectAppError(set(await fx.ctx(c, c.agent), '5'), 'forbidden');
    await expectAppError(set(await fx.ctx(other, other.owner), '5'), 'not_found');
    const invalid =
      "A key's monthly limit is a whole number of requests from 1 to 1,000,000,000, or empty for none.";
    for (const bad of ['0', '-1', '1.5', '1e3', 'ten', '1000000001']) {
      const error = await expectAppError(set(owner, bad), 'validation_failed');
      expect(isAppError(error) && error.issues).toEqual([
        { path: 'monthlyRequestLimit', message: invalid },
      ]);
    }
    await expectAppError(
      keys().create(owner, {
        name: 'Zero',
        scopes: ['contacts.read'],
        expiresInDays: 0,
        monthlyRequestLimit: '0',
      }),
      'validation_failed',
    );
    expect((await keyCounts(c))[key.id]).toEqual([4, 1_000_000]);

    // Rotation keeps the limit, and the new key's requests are counted from zero.
    await set(owner, '1');
    const rotated = await keys().rotate(owner, { keyId: key.id, overlapHours: 1 });
    const rotatedCtx = await authenticateApiToken(fx.dbs.app, rotated.token, uuidv7());
    if (!rotatedCtx) throw new Error('the rotated key does not authenticate');
    expect(await admit(rotatedCtx)).toMatchObject({ ok: true });
    expect(await admit(rotatedCtx)).toMatchObject({ ok: false, reason: 'key_quota_exceeded' });
    expect((await keyCounts(c))[rotated.id]).toEqual([1, 1]);
    // Only an active key's limit changes.
    await keys().revoke(owner, { keyId: rotated.id });
    await expectAppError(
      set(owner, '9', rotated.id),
      'conflict',
      'Only the limit of an active key can be changed.',
    );
  });

  it("keeps each key's counts to its company, and to what the runtime role may do", async () => {
    const c = await fx.company();
    const other = await fx.company();
    const key = await limitedKey(c, '');
    const otherKey = await limitedKey(other, '');
    expect(await admit(key.ctx)).toMatchObject({ ok: true });
    const inCompany = <T>(tenantId: string, query: ReturnType<typeof sql>) =>
      fx.dbs.app.run(authorizedTenantScope(tenantId, null), async (tx) => {
        const res = await tx.execute<T & Record<string, unknown>>(query);
        return res.rows;
      });
    /** The PostgreSQL message behind a mapped error ("Operation not permitted." hides it). */
    const refusal = async (promise: Promise<unknown>): Promise<string> => {
      try {
        await promise;
      } catch (error) {
        let current: unknown = error;
        while (current instanceof Error) {
          if (
            'code' in current &&
            typeof current.code === 'string' &&
            /^[0-9A-Z]{5}$/.test(current.code)
          )
            return current.message;
          current = current.cause;
        }
        throw error;
      }
      throw new Error('expected the statement to be refused');
    };
    expect(
      await inCompany<{ used: number }>(c.tenant.id, sql`select used from app.api_key_usage`),
    ).toEqual([{ used: 1 }]);
    expect(await inCompany(other.tenant.id, sql`select used from app.api_key_usage`)).toEqual([]);
    // Counts are added to, never moved to another key or period, nor deleted.
    for (const statement of [
      sql`update app.api_key_usage set api_key_id = api_key_id`,
      sql`update app.api_key_usage set period_start = now()`,
      sql`delete from app.api_key_usage`,
    ]) {
      expect(await refusal(inCompany(c.tenant.id, statement))).toMatch(/permission denied/);
    }
    // A count belongs to a key of the same company.
    await expect(
      fx.dbs.adminPool.query(
        `INSERT INTO app.api_key_usage (id, tenant_id, api_key_id, period_start, used)
         VALUES ($1, $2, $3, now(), 1)`,
        [uuidv7(), c.tenant.id, otherKey.id],
      ),
    ).rejects.toThrow(/api_key_usage_key_fk/);
    // The table refuses a limit outside 1 to a billion.
    for (const limit of [0, 1_000_000_001]) {
      await expect(
        fx.dbs.adminPool.query(`UPDATE app.api_keys SET monthly_request_limit = $2 WHERE id = $1`, [
          key.id,
          limit,
        ]),
      ).rejects.toThrow(/api_keys_monthly_request_limit_check/);
    }
  });
});
