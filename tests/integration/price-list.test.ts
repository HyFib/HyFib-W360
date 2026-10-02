import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, uuidv7, type Clock } from '@w360/core';
import { sql, systemScope } from '@w360/db';
import { createPlanAdminService, createPriceListService, type PlatformActor } from '@w360/domain';
import { connectTestDatabases, createUser, type TestDatabases } from './helpers';

/**
 * The price list for visitors (P5-01/P5-07, ADR-107) against real PostgreSQL: platform owners show
 * or hide it, in the platform audit log; visitors see the versions offered to companies with their
 * prices only while it is shown and a visitor could follow it (paying for plans on, the tax set, a
 * default trial); the runtime role reads it in the system scope and reads nothing of the settings
 * but whether it is shown, the tax and the default trial.
 */
let dbs: TestDatabases;
let owner: PlatformActor;
let operator: PlatformActor;
const clock: Clock = { now: () => new Date() };

/** The platform-wide settings before this file, restored after it for the other files. */
let saved: {
  plan_tax_bp: number | null;
  default_trial_plan_id: string | null;
  price_list_shown_at: Date | null;
  price_list_shown_by_user_id: string | null;
};

const admin = () => createPlanAdminService({ platformDb: dbs.platform, clock });
const priceList = (subscriptionsEnabled = true) =>
  createPriceListService({ db: dbs.app, subscriptionsEnabled });

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

let codes = 0;
/** A published version; the terms are form text, as platform owners enter them. */
async function publishedPlan(terms: Record<string, unknown>): Promise<string> {
  codes += 1;
  const { id } = await admin().createPlan(owner, {
    code: `price-list-${Date.now().toString(36)}-${codes}`,
    intervalMonths: '1',
    trialDays: '0',
    graceDays: '7',
    seatsIncluded: '1',
    numbersIncluded: '1',
    modules: [],
    ...terms,
  });
  await admin().publishPlan(owner, id);
  return id;
}

async function offeredPlan(terms: Record<string, unknown>): Promise<string> {
  const id = await publishedPlan(terms);
  await admin().offerPlan(owner, id);
  return id;
}

/** Every message of a refused statement's error and its causes (the PostgreSQL error is the last). */
async function refusal(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
      messages.push(current.message);
      current = current.cause;
    }
    return messages.join(' | ');
  }
  throw new Error('The statement was not refused');
}

const shownEvents = async (action: string) =>
  (
    await adminQuery<{ count: number }>(
      `SELECT count(*)::int AS count FROM ops.platform_audit_events
        WHERE action = $1 AND actor_user_id = $2`,
      [action, owner.userId],
    )
  )[0]!.count;

beforeAll(async () => {
  dbs = connectTestDatabases();
  owner = await platformActor('platform_owner', 'Price List Owner');
  operator = await platformActor('platform_operator', 'Price List Operator');
  const [settings] = await adminQuery<typeof saved>(
    `SELECT plan_tax_bp, default_trial_plan_id, price_list_shown_at, price_list_shown_by_user_id
       FROM ops.plan_settings`,
  );
  if (!settings) throw new Error('The plan settings row is missing');
  saved = settings;
  await adminQuery(
    'UPDATE ops.plan_settings SET price_list_shown_at = NULL, price_list_shown_by_user_id = NULL',
  );
  await admin().setPlanTax(owner, { tax: '18', reason: 'GST on plan prices, ticket 9107' });
  const trial = await publishedPlan({ name: 'Price List Trial', price: '0', trialDays: '14' });
  await admin().setDefaultTrial(owner, { planId: trial });
});

afterAll(async () => {
  await adminQuery(
    `UPDATE ops.plan_settings
        SET plan_tax_bp = $1, default_trial_plan_id = $2, price_list_shown_at = $3,
            price_list_shown_by_user_id = $4`,
    [
      saved.plan_tax_bp,
      saved.default_trial_plan_id,
      saved.price_list_shown_at,
      saved.price_list_shown_by_user_id,
    ],
  );
  await dbs.close();
});

describe('the price list for visitors', () => {
  let cheap: string;
  let team: string;
  let notOffered: string;
  let retired: string;
  let dear: string;
  let draft: string;

  it('is hidden until a platform owner shows it, then lists the offered versions one plan payment can cover, cheapest first, with their prices and terms', async () => {
    team = await offeredPlan({
      name: 'Price List Team',
      description: 'For teams answering together.',
      price: '999',
      seatsIncluded: '2',
      seatPrice: '100',
      seatsMax: '10',
      numbersIncluded: '1',
      numberPrice: '500',
      liveAutomationsMax: '5',
      automationRunsMonthly: '1000',
      runPackSize: '500',
      runPackPrice: '250',
      apiRequestsMonthly: '2000',
      apiScopeChoice: 'chosen',
      apiScopes: ['contacts.read'],
      modules: ['crm', 'automations'],
    });
    // Named after Team, so that only the price puts it first.
    cheap = await offeredPlan({ name: 'Price List Value', price: '499' });
    notOffered = await publishedPlan({ name: 'Price List Hidden', price: '799' });
    retired = await offeredPlan({ name: 'Price List Old', price: '599' });
    await admin().retirePlan(owner, retired, { reason: 'Replaced by Value' });
    // ₹9,000,000,000 with 18% tax is more than one plan payment can be.
    dear = await offeredPlan({ name: 'Price List Dear', price: '9000000000' });
    codes += 1;
    ({ id: draft } = await admin().createPlan(owner, {
      code: `price-list-draft-${codes}`,
      name: 'Price List Draft',
      price: '299',
      intervalMonths: '1',
      trialDays: '0',
      graceDays: '7',
      seatsIncluded: '1',
      numbersIncluded: '1',
      modules: [],
    }));

    expect(await priceList().publicPriceList()).toBeNull();
    expect((await admin().listPlans(owner)).priceListShown).toBe(false);

    await admin().showPriceList(owner);
    const list = await priceList().publicPriceList();
    expect(list).not.toBeNull();
    expect(list!.taxBp).toBe(1800);
    expect(list!.trialDays).toBe(14);
    const mine = list!.plans.filter((p) =>
      [cheap, team, notOffered, retired, dear, draft].includes(p.id),
    );
    expect(mine.map((p) => p.id)).toEqual([cheap, team]);
    expect(mine[1]).toEqual({
      id: team,
      name: 'Price List Team',
      description: 'For teams answering together.',
      priceMinor: 99_900,
      totalMinor: 117_882,
      intervalMonths: 1,
      seatsIncluded: 2,
      numbersIncluded: 1,
      teamsMax: null,
      liveAutomationsMax: 5,
      automationRunsMonthly: 1000,
      apiRequestsMonthly: 2000,
      someApiScopes: true,
      modules: ['automations', 'crm'],
      seatPriceMinor: 10_000,
      seatsMax: 10,
      numberPriceMinor: 50_000,
      numbersMax: null,
      runPackSize: 500,
      runPackPriceMinor: 25_000,
    });
    expect(mine[0]).toMatchObject({ priceMinor: 49_900, totalMinor: 58_882, someApiScopes: false });
    // Every listed version is published and offered, whichever file made it.
    const listed = await adminQuery<{ ok: boolean }>(
      `SELECT bool_and(status = 'published' AND offered_at IS NOT NULL) AS ok
         FROM ops.plans WHERE id = ANY($1::uuid[])`,
      [list!.plans.map((p) => p.id)],
    );
    expect(listed[0]!.ok).toBe(true);

    expect((await admin().listPlans(owner)).priceListShown).toBe(true);
    const [settings] = await adminQuery<{ by: string; at: Date }>(
      'SELECT price_list_shown_by_user_id AS by, price_list_shown_at AS at FROM ops.plan_settings',
    );
    expect(settings!.by).toBe(owner.userId);
    expect(settings!.at).toBeInstanceOf(Date);
    expect(await shownEvents('platform.price_list_shown')).toBe(1);
  });

  it('shows nothing while paying for plans is off, no tax is set or there is no default trial', async () => {
    expect(await priceList(false).publicPriceList()).toBeNull();
    expect(await priceList().publicPriceList()).not.toBeNull();

    await admin().setPlanTax(owner, { tax: '', reason: 'Pausing plan payments' });
    expect(await priceList().publicPriceList()).toBeNull();
    await admin().setPlanTax(owner, { tax: '18', reason: 'Plan payments again' });
    expect((await priceList().publicPriceList())?.taxBp).toBe(1800);

    const [{ trial }] = (await adminQuery<{ trial: string }>(
      'SELECT default_trial_plan_id AS trial FROM ops.plan_settings',
    )) as [{ trial: string }];
    await admin().setDefaultTrial(owner, { planId: '' });
    expect(await priceList().publicPriceList()).toBeNull();
    await admin().setDefaultTrial(owner, { planId: trial });
    expect(await priceList().publicPriceList()).not.toBeNull();
  });

  it('lets only platform owners show or hide it; doing either twice changes nothing; hiding makes it not found again', async () => {
    for (const attempt of [
      () => admin().showPriceList(operator),
      () => admin().hidePriceList(operator),
    ]) {
      const error = await attempt().then(
        () => null,
        (e: unknown) => e,
      );
      expect(isAppError(error) && error.code).toBe('forbidden');
    }
    expect(await priceList().publicPriceList()).not.toBeNull();

    await admin().showPriceList(owner);
    expect(await shownEvents('platform.price_list_shown')).toBe(1);

    await admin().hidePriceList(owner);
    expect(await priceList().publicPriceList()).toBeNull();
    expect((await admin().listPlans(owner)).priceListShown).toBe(false);
    const [settings] = await adminQuery<{ by: string | null; at: Date | null }>(
      'SELECT price_list_shown_by_user_id AS by, price_list_shown_at AS at FROM ops.plan_settings',
    );
    expect(settings).toEqual({ by: null, at: null });
    expect(await shownEvents('platform.price_list_hidden')).toBe(1);
    await admin().hidePriceList(owner);
    expect(await shownEvents('platform.price_list_hidden')).toBe(1);
  });

  it('keeps the settings to the platform role: the runtime role reads whether the list is shown, the tax and the default trial, never who showed it, and changes none of it', async () => {
    await admin().showPriceList(owner);
    const attempt = (statement: ReturnType<typeof sql>) =>
      dbs.app.run(systemScope, (tx) => tx.execute(statement));
    const read = await attempt(
      sql`select price_list_shown_at, plan_tax_bp, default_trial_plan_id from ops.plan_settings`,
    );
    expect(read.rows).toHaveLength(1);
    expect(
      await refusal(attempt(sql`select price_list_shown_by_user_id from ops.plan_settings`)),
    ).toMatch(/permission denied/);
    expect(
      await refusal(attempt(sql`update ops.plan_settings set price_list_shown_at = null`)),
    ).toMatch(/permission denied/);
    expect(
      await refusal(
        attempt(
          sql`update ops.plan_settings set price_list_shown_at = now(), price_list_shown_by_user_id = ${owner.userId}`,
        ),
      ),
    ).toMatch(/permission denied/);
    // A shown list always names who showed it.
    expect(
      await refusal(
        dbs.adminPool.query('UPDATE ops.plan_settings SET price_list_shown_by_user_id = NULL'),
      ),
    ).toMatch(/violates check constraint "plan_settings_price_list_by"/);
    await admin().hidePriceList(owner);
  });
});
