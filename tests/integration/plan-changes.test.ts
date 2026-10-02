import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { Keyring, isAppError, uuidv7, type Clock, type RazorpayConfig } from '@w360/core';
import { authorizedTenantScope, planSubscriptions, sql } from '@w360/db';
import {
  JobSigner,
  PLAN_CHANGE_UNAVAILABLE_TEXT,
  PgBossJobQueue,
  RazorpayClient,
  cancelPlanSubscriptionForDeletion,
  createPlanAdminService,
  createPlanChangeService,
  createPlanSubscriptionService,
  dayOf,
  outboxAad,
  processRazorpayReceipt,
  resolveTenantContext,
  storeWebhookReceipt,
  sweepPlanStates,
  syncPlanSubscriptionOfPlan,
  type BillingNoticeDeps,
  type BillingProviderDeps,
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
 * Paying companies change their plan or add-ons from the end of the paid period (ADR-109), against
 * real PostgreSQL and the test-only Razorpay stand-in: the current subscription cancelled at the end
 * of its cycle before a new one is recorded, the new one following it from the period's end and
 * authorised in Checkout, its first paid cycle putting the plan on the version and add-ons it was
 * bought for, the period due like a renewal meanwhile, replacing and cancelling a change, the
 * refusals, and what the database guarantees (one subscription that keeps charging, the follow
 * guard, never moving a period back, a retired version still applied).
 */
const KEY_ID = 'rzp_test_StandIn00000109';
const KEY_SECRET = randomBytes(16).toString('hex');
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

let dbs: TestDatabases;
let boss: PgBoss;
let standIn: RazorpayStandIn;
let razorpay: RazorpayClient;
let owner: PlatformActor;
const signer = new JobSigner(randomBytes(32).toString('hex'));
const keyring = new Keyring({ primaryKeyId: 'test', keys: { test: randomBytes(32) } });
const clock: Clock = { now: () => new Date() };
const offeredHere: string[] = [];

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
  return {
    outbox: { keyring, jobs: new PgBossJobQueue(boss), signer },
    appBaseUrl: 'http://localhost:3000',
  };
}
const service = () =>
  createPlanSubscriptionService({
    db: dbs.app,
    clock,
    razorpay,
    razorpayConfig: config(),
    notices: notices(),
  });
const changes = () => createPlanChangeService({ db: dbs.app, clock, subscriptionsEnabled: true });
const provider = (): BillingProviderDeps => ({ db: dbs.app, razorpay, clock, notices: notices() });
const admin = () => createPlanAdminService({ platformDb: dbs.platform, clock, razorpay });
const sweepDeps = () => ({
  db: dbs.app,
  clock,
  notices: notices(),
  planPayments: {
    offered: true,
    syncBeforeTransition: (scope: ReturnType<typeof authorizedTenantScope>) =>
      syncPlanSubscriptionOfPlan(provider(), scope),
  },
});

async function adminQuery<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await dbs.adminPool.query<T>(text, params)).rows;
}

async function platformActor(role: PlatformActor['role']): Promise<PlatformActor> {
  const user = await createUser(dbs, { name: `Plan Change ${role}`, twoFactor: true });
  await dbs.ownerPool.query('INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, $2)', [
    user.id,
    role,
  ]);
  return { userId: user.id, role, correlationId: uuidv7() };
}

async function contextFor(user: TestUser, slug: string, signedInAgoMs = 0) {
  return resolveTenantContext(
    { db: dbs.app, clock, mfaGracePeriodHours: 72 },
    {
      userId: user.id,
      sessionId: `sess_${user.id}`,
      sessionCreatedAt: new Date(clock.now().getTime() - signedInAgoMs),
      tenantSlug: slug,
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
  automationRunsMonthly?: string;
  runPackSize?: string;
  runPackPrice?: string;
}
/** A published monthly version; offered to companies unless `offer` is false. */
async function version(terms: Terms = {}, offer = true): Promise<string> {
  codes += 1;
  const { id } = await admin().createPlan(owner, {
    code: `change-${Date.now().toString(36)}-${codes}`,
    name: terms.name ?? 'Pro',
    price: terms.price ?? '1999',
    intervalMonths: '1',
    trialDays: '14',
    graceDays: '7',
    seatsIncluded: terms.seatsIncluded ?? '5',
    seatPrice: terms.seatPrice ?? '150',
    seatsMax: terms.seatsMax ?? '',
    numbersIncluded: terms.numbersIncluded ?? '1',
    numberPrice: terms.numberPrice ?? '',
    automationRunsMonthly: terms.automationRunsMonthly ?? '',
    runPackSize: terms.runPackSize ?? '',
    runPackPrice: terms.runPackPrice ?? '',
    modules: [],
  });
  await admin().publishPlan(owner, id);
  if (offer) {
    await admin().offerPlan(owner, id);
    offeredHere.push(id);
  }
  return id;
}

interface Company {
  tenant: TestTenant;
  tenantId: string;
  owner: TestUser;
  ctx: TenantContext;
  growthId: string;
}
interface Sub {
  subscriptionId: string;
  providerSubscriptionId: string;
}

/**
 * A company paying by subscription for Growth (₹999, 3 seats, extra seats at ₹100) with two extra
 * seats: its trial ended within two days, so Checkout charged the first month at once (ADR-102).
 */
async function paying(): Promise<{ c: Company; current: Sub }> {
  const growthId = await version(
    { name: 'Growth', price: '999', seatsIncluded: '3', seatPrice: '100' },
    false,
  );
  const user = await createUser(dbs, { name: 'Changing Owner' });
  const tenant = await createTenant(dbs, user);
  const view = await admin().tenantPlan(owner, tenant.id);
  await admin().setTenantPlan(owner, {
    tenantId: tenant.id,
    version: view.state.version,
    reason: 'Trial agreed on the sales call',
    status: 'trialing',
    planId: growthId,
    trialEndsOn: dayOf(new Date(Date.now() + DAY_MS), 'Asia/Kolkata'),
    extraSeats: '2',
  });
  const ctx = await contextFor(user, tenant.slug);
  const start = await service().start(ctx);
  const { response } = standIn.authorizeSubscription(start.providerSubscriptionId);
  const confirmed = await service().confirmCheckout(ctx, {
    subscriptionId: start.subscriptionId,
    paymentId: response.razorpay_payment_id,
    signature: response.razorpay_signature,
  });
  expect(confirmed.status).toBe('active');
  return {
    c: { tenant, tenantId: tenant.id, owner: user, ctx, growthId },
    current: {
      subscriptionId: start.subscriptionId,
      providerSubscriptionId: start.providerSubscriptionId,
    },
  };
}

/** Changes the plan and authorises the new subscription in Checkout. */
async function changedTo(
  c: Company,
  input: { planId: string; extraSeats?: string; extraNumbers?: string; runPacks?: string },
): Promise<Sub> {
  const checkout = await service().scheduleChange(c.ctx, {
    extraSeats: '0',
    extraNumbers: '0',
    runPacks: '0',
    ...input,
  });
  const { response } = standIn.authorizeSubscription(checkout.providerSubscriptionId);
  const confirmed = await service().confirmCheckout(c.ctx, {
    subscriptionId: checkout.subscriptionId,
    paymentId: response.razorpay_payment_id,
    signature: response.razorpay_signature,
  });
  expect(confirmed.status).toBe('scheduled');
  return {
    subscriptionId: checkout.subscriptionId,
    providerSubscriptionId: checkout.providerSubscriptionId,
  };
}

async function planState(tenantId: string) {
  const [row] = await adminQuery<{
    status: string;
    plan_id: string;
    extra_seats: number;
    extra_numbers: number;
    run_packs: number;
    period_start: Date;
    period_end: Date;
    grace_ends_at: Date | null;
    subscription_id: string | null;
    usage_anchor: Date;
    note: string | null;
  }>('SELECT * FROM app.tenant_plans WHERE tenant_id = $1', [tenantId]);
  return row!;
}

async function subscriptionRow(id: string) {
  const [row] = await adminQuery<{
    status: string;
    plan_id: string;
    extra_seats: number;
    amount_minor: string;
    subtotal_minor: string;
    tax_minor: string;
    starts_at: Date | null;
    follows_subscription_id: string | null;
    cancel_at_period_end: boolean;
    staff_cancel_notice_due: boolean;
    current_start: Date | null;
    current_end: Date | null;
  }>('SELECT * FROM app.plan_subscriptions WHERE id = $1', [id]);
  return row!;
}

async function billingEmails(tenantId: string) {
  const rows = await adminQuery<{ id: string; payload_ciphertext: string }>(
    `SELECT id, payload_ciphertext FROM ops.email_outbox
      WHERE tenant_id = $1 AND kind = 'billing.notice' ORDER BY id`,
    [tenantId],
  );
  return rows.map(
    (r) =>
      JSON.parse(keyring.decryptString(r.payload_ciphertext, outboxAad(r.id))) as {
        subject: string;
        lines: string[];
      },
  );
}

/** An ended copy of a subscription: another of the company's, which paid nothing now. */
async function expiredCopy(subscriptionId: string): Promise<string> {
  const id = uuidv7();
  const suffix = randomBytes(4).toString('hex');
  await adminQuery(
    `INSERT INTO app.plan_subscriptions (id, tenant_id, plan_id, status, interval_months,
       extra_seats, extra_numbers, run_packs, subtotal_minor, tax_bp, tax_minor, amount_minor,
       total_count, provider_plan_id, provider_subscription_id, authorize_by, created_by_user_id)
     SELECT $1, tenant_id, plan_id, 'expired', interval_months, extra_seats, extra_numbers,
            run_packs, subtotal_minor, tax_bp, tax_minor, amount_minor, total_count, $3, $4,
            authorize_by, created_by_user_id
       FROM app.plan_subscriptions WHERE id = $2`,
    [id, subscriptionId, `plan_Older${suffix}`, `sub_Older${suffix}`],
  );
  return id;
}

/** A plan payment for a subscription's current cycle, as the sync records one. */
async function paymentFor(subscriptionId: string) {
  await adminQuery(
    `INSERT INTO app.plan_payments (id, tenant_id, subscription_id, provider_payment_id,
       provider_invoice_id, amount_minor, currency, period_start, period_end, paid_at)
     SELECT $1, tenant_id, id, $2, $3, amount_minor, 'INR', current_start, current_end, current_start
       FROM app.plan_subscriptions WHERE id = $4`,
    [
      uuidv7(),
      `pay_made${randomBytes(4).toString('hex')}`,
      `inv_made${randomBytes(4).toString('hex')}`,
      subscriptionId,
    ],
  );
}

/** Runs app.apply_plan_subscription_period in the company's own scope. */
async function applyPeriod(tenantId: string, subscriptionId: string) {
  const res = await dbs.app.run(authorizedTenantScope(tenantId, null), (tx) =>
    tx.execute<{ result: string }>(
      sql`select app.apply_plan_subscription_period(${tenantId}::uuid, ${subscriptionId}::uuid) as result`,
    ),
  );
  return res.rows[0]?.result;
}

const audits = (tenantId: string, action: string) =>
  adminQuery<{ actor_type: string; metadata: Record<string, unknown> }>(
    'SELECT actor_type, metadata FROM app.audit_events WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id',
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

/** A statement the database refuses for lack of a privilege. */
async function deniedByDatabase(promise: Promise<unknown>) {
  let current: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  const messages: string[] = [];
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    messages.push(current.message);
    current = current.cause;
  }
  expect(messages.join(' | ')).toMatch(/permission denied/);
}

/** A day as the company's emails show it (companies here are in India's time zone). */
const shown = (at: Date) =>
  new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(at);

/**
 * Moves the paid period's end `hours` into the past, as if it had run out: the plan's period, the
 * current subscription's cycle, the start of the one that follows (and its creation, which comes
 * before it), and the stand-in's cycles, invoices and start to match. Plan payments are append-only,
 * so the current subscription's payment keeps the period it was recorded for.
 */
async function periodEnded(c: Company, current: Sub, next: Sub | null, hours: number) {
  const endedAt = new Date(Math.floor((Date.now() - hours * HOUR_MS) / 1000) * 1000);
  const before = (await planState(c.tenantId)).period_end;
  const by = (before.getTime() - endedAt.getTime()) / 1000;
  await adminQuery(
    `UPDATE app.tenant_plans
        SET period_start = period_start - make_interval(secs => $2), period_end = $3,
            usage_anchor = usage_anchor - make_interval(secs => $2)
      WHERE tenant_id = $1`,
    [c.tenantId, by, endedAt],
  );
  await adminQuery(
    `UPDATE app.plan_subscriptions
        SET current_start = current_start - make_interval(secs => $2), current_end = $3,
            created_at = created_at - make_interval(secs => $2)
      WHERE id = $1`,
    [current.subscriptionId, by, endedAt],
  );
  const sub = standIn.state.subscriptions.get(current.providerSubscriptionId)!;
  sub.currentStart = (sub.currentStart ?? 0) - by;
  sub.currentEnd = (sub.currentEnd ?? 0) - by;
  sub.chargeAt = sub.currentEnd;
  for (const invoice of standIn.state.invoices.values()) {
    if (invoice.subscriptionId !== current.providerSubscriptionId) continue;
    invoice.billingStart = (invoice.billingStart ?? 0) - by;
    invoice.billingEnd = (invoice.billingEnd ?? 0) - by;
  }
  if (next) {
    await adminQuery(
      `UPDATE app.plan_subscriptions
          SET created_at = $2::timestamptz - interval '3 days', starts_at = $2
        WHERE id = $1`,
      [next.subscriptionId, endedAt],
    );
    const following = standIn.state.subscriptions.get(next.providerSubscriptionId)!;
    following.startAt = endedAt.getTime() / 1000;
    following.chargeAt = following.startAt;
  }
  return endedAt;
}

let eventSeq = 0;
/** A signed subscription webhook, stored and processed like the worker does. */
async function deliver(event: string, providerSubscriptionId: string) {
  eventSeq += 1;
  const body = Buffer.from(
    JSON.stringify({
      entity: 'event',
      account_id: 'acc_StandIn',
      event,
      contains: ['subscription'],
      payload: { subscription: { entity: { id: providerSubscriptionId, status: 'active' } } },
      created_at: Math.floor(Date.now() / 1000) + eventSeq,
    }),
  );
  const stored = await storeWebhookReceipt(
    { db: dbs.app, keyring, jobs: new PgBossJobQueue(boss), signer },
    {
      provider: 'razorpay',
      rawBody: body,
      eventId: `evt_c${eventSeq}_${randomBytes(4).toString('hex')}`,
    },
  );
  return processRazorpayReceipt({ ...provider(), keyring }, stored.receiptId);
}

beforeAll(async () => {
  dbs = connectTestDatabases({ appPoolMax: 8 });
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
  owner = await platformActor('platform_owner');
  await admin().setPlanTax(owner, { tax: '18', reason: 'GST on plan prices, ticket 9109' });
});

afterAll(async () => {
  // Other files list what companies can choose: the versions offered here are offered no more.
  for (const id of offeredHere) {
    await admin()
      .withdrawPlanOffer(owner, id)
      .catch(() => undefined);
  }
  await standIn.close();
  await boss.stop({ graceful: false });
  await dbs.close();
});

describe('changing the plan from the end of the paid period', () => {
  it('ends the current subscription with its cycle, starts the new one at the period’s end once authorised, and puts the plan on the new version and add-ons with its first paid cycle', async () => {
    const { c, current } = await paying();
    const proId = await version();
    const before = await planState(c.tenantId);
    expect(before).toMatchObject({ status: 'active', plan_id: c.growthId, extra_seats: 2 });
    const periodEnd = before.period_end;

    // What the company can change to: offered versions and its own, from the period's end.
    const overview = await changes().overview(c.ctx);
    expect(overview.unavailable).toBeNull();
    expect(overview.periodEnd).toEqual(periodEnd);
    expect(overview.changeBy).toEqual(new Date(periodEnd.getTime() - 48 * HOUR_MS));
    // (₹999 + 2 × ₹100) plus 18%.
    expect(overview.current).toMatchObject({
      planId: c.growthId,
      extraSeats: 2,
      amountMinor: 141_482,
    });
    expect(overview.currentEnds).toBe(false);
    expect(overview.next).toBeNull();
    expect(overview.versions.map((v) => v.id)).toEqual(expect.arrayContaining([c.growthId, proId]));
    // The form keeps the capacity the company has: 5 seats, all included in Pro.
    const option = await changes().option(c.ctx, proId);
    expect(option?.options).toEqual([
      expect.objectContaining({ kind: 'seats', quantity: 0, min: 0, unitPriceMinor: 15_000 }),
    ]);
    expect(await changes().option(c.ctx, 'not-a-uuid')).toBeNull();

    const checkout = await service().scheduleChange(c.ctx, {
      planId: proId,
      extraSeats: '1',
      extraNumbers: '',
      runPacks: '0',
    });
    // The current subscription ends with its cycle, at Razorpay first.
    expect(standIn.state.subscriptions.get(current.providerSubscriptionId)?.cancelAtCycleEnd).toBe(
      true,
    );
    expect(await subscriptionRow(current.subscriptionId)).toMatchObject({
      status: 'active',
      cancel_at_period_end: true,
    });
    // The new one: Pro with one extra seat, (₹1,999 + ₹150) plus 18%, from the period's end.
    const next = await subscriptionRow(checkout.subscriptionId);
    expect(next).toMatchObject({
      status: 'created',
      plan_id: proId,
      extra_seats: 1,
      subtotal_minor: '214900',
      tax_minor: '38682',
      amount_minor: '253582',
      follows_subscription_id: current.subscriptionId,
    });
    expect(next.starts_at).toEqual(periodEnd);
    expect(checkout.amountMinor).toBe(253_582);
    expect(standIn.state.subscriptions.get(checkout.providerSubscriptionId)?.startAt).toBe(
      periodEnd.getTime() / 1000,
    );
    expect((await audits(c.tenantId, 'billing.plan_change_started'))[0]?.metadata).toMatchObject({
      previousPlanId: c.growthId,
      planId: proId,
      extraSeats: 1,
      amountMinor: 253_582,
      followsSubscriptionId: current.subscriptionId,
    });
    expect(
      (await audits(c.tenantId, 'billing.plan_subscription_cancelled')).at(-1)?.metadata,
    ).toMatchObject({ atPeriodEnd: true, reason: 'plan_change' });
    const emails = await billingEmails(c.tenantId);
    expect(emails.at(-1)).toMatchObject({
      subject: 'Your HyFib plan changes at the end of the paid period',
    });
    expect(emails.at(-1)?.lines[0]).toContain(`to the Pro plan from ${shown(periodEnd)}`);

    // Checkout again for the same change reopens it.
    const again = await service().scheduleChange(c.ctx, {
      planId: proId,
      extraSeats: '1',
      extraNumbers: '0',
      runPacks: '0',
    });
    expect(again.subscriptionId).toBe(checkout.subscriptionId);

    // Authorised in Checkout: nothing is charged, the plan stays as it is.
    const { response } = standIn.authorizeSubscription(checkout.providerSubscriptionId);
    expect(
      await service().confirmCheckout(c.ctx, {
        subscriptionId: checkout.subscriptionId,
        paymentId: response.razorpay_payment_id,
        signature: response.razorpay_signature,
      }),
    ).toEqual({ status: 'scheduled' });
    expect((await subscriptionRow(checkout.subscriptionId)).status).toBe('authenticated');
    expect(await planState(c.tenantId)).toMatchObject({ plan_id: c.growthId, extra_seats: 2 });
    const scheduledEmail = (await billingEmails(c.tenantId)).at(-1);
    expect(scheduledEmail?.subject).toBe(`Your HyFib plan changes on ${shown(periodEnd)}`);
    expect(scheduledEmail?.lines[0]).toContain('the Pro plan with 1 extra seat');
    expect(scheduledEmail?.lines[0]).toContain('₹2,535.82');

    const billing = await service().overview(c.ctx);
    expect(billing.subscription?.id).toBe(current.subscriptionId);
    expect(billing.next).toMatchObject({
      planName: 'Pro',
      subscription: { id: checkout.subscriptionId, status: 'authenticated' },
    });
    expect((await changes().overview(c.ctx)).next).toMatchObject({
      planName: 'Pro',
      status: 'authenticated',
      amountMinor: 253_582,
    });

    // The period ends: the current subscription ends at Razorpay, the new one is not charged yet.
    const next2: Sub = {
      subscriptionId: checkout.subscriptionId,
      providerSubscriptionId: checkout.providerSubscriptionId,
    };
    const endedAt = await periodEnded(c, current, next2, 2);
    standIn.endSubscriptionCycle(current.providerSubscriptionId);
    // Razorpay would not renew it: the stand-in refuses as Razorpay would.
    expect(() => standIn.chargeSubscription(current.providerSubscriptionId)).toThrow(
      /not charged again/,
    );
    const swept = await sweepPlanStates(sweepDeps(), 1000);
    expect(swept.failed.filter((f) => f.tenantId === c.tenantId)).toEqual([]);
    expect((await subscriptionRow(current.subscriptionId)).status).toBe('cancelled');
    // Due like a renewal, not canceled: past due within Growth's grace days.
    const due = await planState(c.tenantId);
    expect(due).toMatchObject({ status: 'past_due', plan_id: c.growthId });
    expect(due.grace_ends_at).toEqual(new Date(endedAt.getTime() + 7 * DAY_MS));

    // Razorpay charges the new subscription's first cycle; its event makes the plan Pro.
    standIn.chargeSubscription(checkout.providerSubscriptionId);
    await deliver('subscription.charged', checkout.providerSubscriptionId);
    const after = await planState(c.tenantId);
    expect(after).toMatchObject({
      status: 'active',
      plan_id: proId,
      extra_seats: 1,
      subscription_id: checkout.subscriptionId,
      grace_ends_at: null,
      note: 'Changed and paid by subscription through Razorpay.',
    });
    expect(after.period_start).toEqual(endedAt);
    expect(after.usage_anchor).toEqual(endedAt);
    expect((await audits(c.tenantId, 'plan.subscription_period')).at(-1)?.metadata).toMatchObject({
      plan_id: proId,
      previous_plan_id: c.growthId,
      previous_extra_seats: 2,
      extra_seats: 1,
      subscription_id: checkout.subscriptionId,
    });
    expect((await billingEmails(c.tenantId)).at(-1)?.lines[0]).toContain(
      'We received ₹2,535.82 for the Pro plan',
    );
    const paidView = await service().overview(c.ctx);
    expect(paidView.subscription?.id).toBe(checkout.subscriptionId);
    expect(paidView.next).toBeNull();
  });

  it('applies the new plan when the plan sweep finds both subscriptions moved on at Razorpay without any event', async () => {
    const { c, current } = await paying();
    // Scale sells extra WhatsApp numbers and run packs: the plan takes both from the new one.
    const scaleId = await version({
      name: 'Scale',
      numberPrice: '300',
      automationRunsMonthly: '1000',
      runPackSize: '500',
      runPackPrice: '200',
    });
    const next = await changedTo(c, { planId: scaleId, extraNumbers: '1', runPacks: '2' });
    expect(await subscriptionRow(next.subscriptionId)).toMatchObject({
      subtotal_minor: '269900',
      amount_minor: '318482',
    });
    const endedAt = await periodEnded(c, current, next, 1);
    standIn.endSubscriptionCycle(current.providerSubscriptionId);
    standIn.chargeSubscription(next.providerSubscriptionId);
    await sweepPlanStates(sweepDeps(), 1000);
    expect(await planState(c.tenantId)).toMatchObject({
      status: 'active',
      plan_id: scaleId,
      extra_seats: 0,
      extra_numbers: 1,
      run_packs: 2,
      subscription_id: next.subscriptionId,
      period_start: endedAt,
    });
    expect((await subscriptionRow(current.subscriptionId)).status).toBe('cancelled');
  });

  it('replaces a scheduled change with a new one, and lets a cancelled change leave the plan to end with the period', async () => {
    const { c, current } = await paying();
    const proId = await version();
    const first = await changedTo(c, { planId: proId });

    // Choosing again (here: back to Growth as it is) cancels the first new one at once, unpaid.
    const second = await changedTo(c, { planId: c.growthId, extraSeats: '2' });
    expect(standIn.state.subscriptions.get(first.providerSubscriptionId)?.status).toBe('cancelled');
    expect((await subscriptionRow(first.subscriptionId)).status).toBe('cancelled');
    expect(await subscriptionRow(second.subscriptionId)).toMatchObject({
      status: 'authenticated',
      plan_id: c.growthId,
      extra_seats: 2,
      follows_subscription_id: current.subscriptionId,
    });
    expect(
      (await audits(c.tenantId, 'billing.plan_subscription_cancelled')).at(-1)?.metadata,
    ).toMatchObject({ atPeriodEnd: false, reason: 'plan_change_replaced' });
    // The current subscription was cancelled at its cycle's end once, for the first change.
    expect(
      (await audits(c.tenantId, 'billing.plan_subscription_cancelled')).filter(
        (a) => a.metadata.reason === 'plan_change',
      ),
    ).toHaveLength(1);

    // Cancelling on Billing cancels the change, not the current subscription (already ending).
    const cancelled = await service().cancel(c.ctx);
    expect(cancelled.atPeriodEnd).toBe(false);
    expect((await subscriptionRow(second.subscriptionId)).status).toBe('cancelled');
    const email = (await billingEmails(c.tenantId)).at(-1);
    expect(email?.subject).toBe('Your HyFib plan change is cancelled');
    expect(email?.lines[0]).toBe(
      'Changing Owner cancelled the change to the Growth plan. Nothing was charged for it.',
    );
    expect(await service().cancel(c.ctx)).toMatchObject({ atPeriodEnd: true });

    // With nothing to follow it, the period ends the plan as canceled.
    await periodEnded(c, current, null, 1);
    standIn.endSubscriptionCycle(current.providerSubscriptionId);
    await sweepPlanStates(sweepDeps(), 1000);
    expect(await planState(c.tenantId)).toMatchObject({
      status: 'canceled',
      note: 'The subscription was cancelled.',
    });
  });

  it('refuses a change that the company cannot make now, before anything is cancelled', async () => {
    const { c, current } = await paying();
    const unoffered = await version({ name: 'Hidden' }, false);
    const small = await version({ name: 'Solo', seatsIncluded: '1', seatPrice: '' });
    const capped = await version({ name: 'Capped', seatsIncluded: '3', seatsMax: '4' });
    const proId = await version();
    const tooSoon = async (input: Record<string, string>, message: RegExp) =>
      refused(
        service().scheduleChange(c.ctx, {
          extraSeats: '0',
          extraNumbers: '0',
          runPacks: '0',
          ...input,
        }),
        'precondition_failed',
        message,
      );

    await tooSoon({ planId: c.growthId, extraSeats: '2' }, /That is the plan you pay for now/);
    await tooSoon({ planId: unoffered }, /cannot be chosen/);
    await tooSoon({ planId: proId, extraNumbers: '1' }, /does not sell extra WhatsApp numbers/);
    await tooSoon({ planId: capped, extraSeats: '2' }, /sells at most 1 extra seats/);
    // An invitation still waiting holds a seat, so Solo (1 seat, no extras) holds too little.
    const helper = await createUser(dbs, { name: 'Invited Helper' });
    await invite(dbs, c.tenant, c.owner, helper.email, ['agent']);
    await tooSoon({ planId: small }, /holds 1 seat, where your company uses 2/);
    await refused(
      service().scheduleChange(c.ctx, { planId: proId, extraSeats: 'two' }),
      'validation_failed',
    );
    // Owners and billing managers, with a recent sign-in.
    const stale = await contextFor(c.owner, c.tenant.slug, 20 * 60_000);
    await refused(service().scheduleChange(stale, { planId: proId }), 'step_up_required');
    const agent = await createUser(dbs, { name: 'Plan Agent' });
    const { token } = await invite(dbs, c.tenant, c.owner, agent.email, ['agent']);
    await acceptInvitation(dbs, agent, token);
    await refused(
      service().scheduleChange(await contextFor(agent, c.tenant.slug), { planId: proId }),
      'forbidden',
    );
    // Nothing changed at Razorpay or here.
    expect(standIn.state.subscriptions.get(current.providerSubscriptionId)?.cancelAtCycleEnd).toBe(
      false,
    );
    expect((await subscriptionRow(current.subscriptionId)).cancel_at_period_end).toBe(false);

    // Within 48 hours of the period's end it is too late.
    await adminQuery(
      `UPDATE app.tenant_plans SET period_end = now() + interval '47 hours' WHERE tenant_id = $1`,
      [c.tenantId],
    );
    expect((await changes().overview(c.ctx)).unavailable).toBe('too_late');
    await tooSoon({ planId: proId }, /ends within 48 hours/);
    expect(PLAN_CHANGE_UNAVAILABLE_TEXT.too_late).toMatch(/48 hours/);

    // A company on a trial does not pay by subscription: it chooses a plan instead (ADR-105).
    const trialUser = await createUser(dbs, { name: 'Trial Owner' });
    const trialTenant = await createTenant(dbs, trialUser);
    const trialCtx = await contextFor(trialUser, trialTenant.slug);
    expect((await changes().overview(trialCtx)).unavailable).toBe('not_paying');
    await refused(
      service().scheduleChange(trialCtx, {
        planId: proId,
        extraSeats: '0',
        extraNumbers: '0',
        runPacks: '0',
      }),
      'precondition_failed',
      /no period paid by subscription/,
    );
  });

  it('keeps only one subscription that keeps charging, and refuses a following subscription that does not start when the paid period ends, after the current one stops charging, at its plan’s price', async () => {
    const { c, current } = await paying();
    const proId = await version();
    const scope = authorizedTenantScope(c.tenantId, null);
    const state = await planState(c.tenantId);
    const insert = (values: Partial<typeof planSubscriptions.$inferInsert>) =>
      dbs.app.run(scope, (tx) =>
        tx.insert(planSubscriptions).values({
          id: uuidv7(),
          tenantId: c.tenantId,
          planId: proId,
          intervalMonths: 1,
          extraSeats: 0,
          extraNumbers: 0,
          runPacks: 0,
          subtotalMinor: 199_900,
          taxBp: 1800,
          taxMinor: 35_982,
          amountMinor: 235_882,
          totalCount: 60,
          authorizeBy: new Date(Date.now() + HOUR_MS),
          createdByUserId: c.owner.id,
          startsAt: state.period_end,
          followsSubscriptionId: current.subscriptionId,
          ...values,
        }),
      );
    const refusedInsert = (
      values: Partial<typeof planSubscriptions.$inferInsert>,
      message: RegExp,
    ) => expect(insert(values)).rejects.toThrow(message);

    // The current subscription still charges, so nothing may follow it.
    await refusedInsert({}, /follows the one that paid the plan, once that one charges no more/);
    await adminQuery(
      'UPDATE app.plan_subscriptions SET cancel_at_period_end = true, cancel_requested_at = now() WHERE id = $1',
      [current.subscriptionId],
    );
    await refusedInsert(
      { startsAt: new Date(state.period_end.getTime() - DAY_MS) },
      /starts when the paid period ends/,
    );
    await refusedInsert(
      { amountMinor: 100_000, subtotalMinor: 84_746, taxMinor: 15_254 },
      /costs what its plan charges/,
    );
    await refusedInsert({ planId: await version({ name: 'Unlisted' }, false) }, /cannot be chosen/);
    await refusedInsert(
      { extraNumbers: 1, subtotalMinor: 199_900, taxMinor: 35_982, amountMinor: 235_882 },
      /does not sell these add-ons/,
    );
    // Seats the version does not sell, or more than its maximum.
    const solo = await version({ name: 'Solo', seatsIncluded: '1', seatPrice: '' });
    await refusedInsert({ planId: solo, extraSeats: 1 }, /does not sell these add-ons/);
    const capped = await version({ name: 'Capped', seatsIncluded: '3', seatsMax: '4' });
    await refusedInsert(
      {
        planId: capped,
        extraSeats: 2,
        subtotalMinor: 229_900,
        taxMinor: 41_382,
        amountMinor: 271_282,
      },
      /does not sell these add-ons/,
    );
    // Each part of the price is checked on its own: the subtotal, the tax, the rate, the interval.
    await refusedInsert(
      { subtotalMinor: 199_800, amountMinor: 235_782 },
      /costs what its plan charges/,
    );
    await refusedInsert({ taxMinor: 35_983, amountMinor: 235_883 }, /costs what its plan charges/);
    await refusedInsert({ taxBp: 1700 }, /costs what its plan charges/);
    await refusedInsert({ intervalMonths: 3, totalCount: 20 }, /costs what its plan charges/);
    // A suspended company cannot change its plan.
    await adminQuery(`UPDATE app.tenants SET status = 'suspended' WHERE id = $1`, [c.tenantId]);
    await refusedInsert({}, /cannot change its plan now/);
    await adminQuery(`UPDATE app.tenants SET status = 'active' WHERE id = $1`, [c.tenantId]);
    // Only the subscription that paid the plan can be followed, not another of the company's.
    await refusedInsert(
      { followsSubscriptionId: await expiredCopy(current.subscriptionId) },
      /follows the one that paid the plan, once that one charges no more/,
    );
    // A version no longer published cannot be bought again, even the company's own.
    await admin().retirePlan(owner, c.growthId, { reason: 'Replaced by the 2027 price list' });
    await refusedInsert(
      {
        planId: c.growthId,
        extraSeats: 2,
        subtotalMinor: 119_900,
        taxMinor: 21_582,
        amountMinor: 141_482,
      },
      /cannot be chosen/,
    );
    // The right one goes in; a second one that would keep charging does not.
    await insert({});
    await refusedInsert({}, /same unique value already exists/);
    // Nobody changes afterwards which subscription it follows.
    const repoint = sql`update app.plan_subscriptions set follows_subscription_id = null
                         where follows_subscription_id = ${current.subscriptionId}::uuid`;
    await deniedByDatabase(dbs.app.run(scope, (tx) => tx.execute(repoint)));
    await deniedByDatabase(dbs.platform.run(owner.userId, (tx) => tx.execute(repoint)));

    // Within 48 hours of the period's end, nothing may follow.
    await adminQuery(
      `UPDATE app.plan_subscriptions SET status = 'failed' WHERE follows_subscription_id = $1`,
      [current.subscriptionId],
    );
    const soon = new Date(Date.now() + 47 * HOUR_MS);
    await adminQuery('UPDATE app.tenant_plans SET period_end = $2 WHERE tenant_id = $1', [
      c.tenantId,
      soon,
    ]);
    await adminQuery('UPDATE app.plan_subscriptions SET current_end = $2 WHERE id = $1', [
      current.subscriptionId,
      soon,
    ]);
    await refusedInsert({ startsAt: soon }, /at least 48 hours ahead/);

    // Behind the trigger, the table ties a following subscription to another of its own company's.
    expect(
      await adminQuery<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'app.plan_subscriptions'::regclass
            AND conname IN ('plan_subscriptions_follows_check', 'plan_subscriptions_follows_fk')
          ORDER BY conname`,
      ),
    ).toEqual([
      {
        conname: 'plan_subscriptions_follows_check',
        def: 'CHECK (((follows_subscription_id IS NULL) OR ((follows_subscription_id <> id) AND (starts_at IS NOT NULL))))',
      },
      {
        conname: 'plan_subscriptions_follows_fk',
        def: 'FOREIGN KEY (tenant_id, follows_subscription_id) REFERENCES app.plan_subscriptions(tenant_id, id)',
      },
    ]);
  });

  it('applies a version retired after the company bought it', async () => {
    const { c, current } = await paying();
    const proId = await version();
    const next = await changedTo(c, { planId: proId });
    // Platform owners retire Pro meanwhile: the company paid for it, so it gets it.
    await admin().retirePlan(owner, proId, { reason: 'Replaced by the 2027 price list' });
    await periodEnded(c, current, next, 1);
    standIn.endSubscriptionCycle(current.providerSubscriptionId);
    standIn.chargeSubscription(next.providerSubscriptionId);
    await deliver('subscription.charged', next.providerSubscriptionId);
    expect(await planState(c.tenantId)).toMatchObject({
      status: 'active',
      plan_id: proId,
      subscription_id: next.subscriptionId,
    });
  });

  it('never moves the plan back to a period an earlier subscription paid', async () => {
    // The company cancelled at the period's end, then chose to keep Growth as it is.
    const { c, current } = await paying();
    await service().cancel(c.ctx);
    const next = await changedTo(c, { planId: c.growthId, extraSeats: '2' });
    const endedAt = await periodEnded(c, current, next, 1);
    standIn.endSubscriptionCycle(current.providerSubscriptionId);
    standIn.chargeSubscription(next.providerSubscriptionId);
    await deliver('subscription.charged', next.providerSubscriptionId);
    const renewed = await planState(c.tenantId);
    expect(renewed).toMatchObject({
      status: 'active',
      plan_id: c.growthId,
      extra_seats: 2,
      subscription_id: next.subscriptionId,
      period_start: endedAt,
      note: 'Paid by subscription through Razorpay.',
    });

    // The earlier subscription, seen as active again with a payment for its cycle, changes nothing.
    await adminQuery(`UPDATE app.plan_subscriptions SET status = 'active' WHERE id = $1`, [
      current.subscriptionId,
    ]);
    await paymentFor(current.subscriptionId);
    expect(await applyPeriod(c.tenantId, current.subscriptionId)).toBe('stale');
    expect(await planState(c.tenantId)).toEqual(renewed);
    // Nor a renewal of it for the very cycle the following subscription paid: the plan would then
    // be paid by a subscription that ends.
    await adminQuery(
      'UPDATE app.plan_subscriptions SET current_start = $2, current_end = $3 WHERE id = $1',
      [current.subscriptionId, renewed.period_start, renewed.period_end],
    );
    await paymentFor(current.subscriptionId);
    expect(await applyPeriod(c.tenantId, current.subscriptionId)).toBe('stale');
    expect(await planState(c.tenantId)).toEqual(renewed);
    await adminQuery(`UPDATE app.plan_subscriptions SET status = 'cancelled' WHERE id = $1`, [
      current.subscriptionId,
    ]);
  });

  it('applies another version or other add-ons only from the subscription that follows the one that paid the plan', async () => {
    const { c, current } = await paying();
    const proId = await version();
    const next = await changedTo(c, { planId: proId });
    // Made to follow another subscription of the company than the one that paid the plan, then
    // charged for the cycle after the paid period.
    await adminQuery(
      'UPDATE app.plan_subscriptions SET follows_subscription_id = $2 WHERE id = $1',
      [next.subscriptionId, await expiredCopy(current.subscriptionId)],
    );
    const before = await planState(c.tenantId);
    const end = new Date(before.period_end.getTime() + 30 * DAY_MS);
    await adminQuery(
      `UPDATE app.plan_subscriptions
          SET status = 'active', current_start = $2, current_end = $3, paid_count = 1
        WHERE id = $1`,
      [next.subscriptionId, before.period_end, end],
    );
    await paymentFor(next.subscriptionId);
    expect(await applyPeriod(c.tenantId, next.subscriptionId)).toBe('mismatch');
    expect(await planState(c.tenantId)).toEqual(before);
  });

  it('lets a retired version in only as the plan of the paid subscription that follows the one that paid the plan, for the cycle it paid', async () => {
    const { c, current } = await paying();
    const proId = await version();
    const next = await changedTo(c, { planId: proId });
    await admin().retirePlan(owner, proId, { reason: 'Replaced by the 2027 price list' });
    const state = await planState(c.tenantId);
    const end = new Date(state.period_end.getTime() + 30 * DAY_MS);
    await adminQuery(
      'UPDATE app.plan_subscriptions SET current_start = $2, current_end = $3 WHERE id = $1',
      [next.subscriptionId, state.period_end, end],
    );
    const assign = (subscriptionId: string | null, periodEnd: Date) =>
      adminQuery(
        `UPDATE app.tenant_plans
            SET plan_id = $2, subscription_id = $3, period_start = $4, period_end = $5
          WHERE tenant_id = $1`,
        [c.tenantId, proId, subscriptionId, state.period_end, periodEnd],
      );
    const refusedAssign = (subscriptionId: string | null, periodEnd: Date) =>
      expect(assign(subscriptionId, periodEnd)).rejects.toThrow(
        /Only a published plan version can be assigned/,
      );
    // Not for another period than the cycle it paid, not without it, and not when the plan was
    // paid by another subscription than the one it follows.
    await refusedAssign(next.subscriptionId, new Date(end.getTime() + DAY_MS));
    await refusedAssign(null, end);
    await adminQuery('UPDATE app.tenant_plans SET subscription_id = NULL WHERE tenant_id = $1', [
      c.tenantId,
    ]);
    await refusedAssign(next.subscriptionId, end);
    await adminQuery('UPDATE app.tenant_plans SET subscription_id = $2 WHERE tenant_id = $1', [
      c.tenantId,
      current.subscriptionId,
    ]);
    // The subscription that follows, for the cycle it paid: the plan takes the retired version.
    await assign(next.subscriptionId, end);
    expect(await planState(c.tenantId)).toMatchObject({
      plan_id: proId,
      subscription_id: next.subscriptionId,
      period_end: end,
    });
  });

  it('ends the plan with the period unless an authorised subscription follows the one that paid it from the period’s end', async () => {
    // The payer left Checkout: the new subscription still waits for its authorisation.
    const left = await paying();
    const checkout = await service().scheduleChange(left.c.ctx, {
      planId: await version(),
      extraSeats: '0',
      extraNumbers: '0',
      runPacks: '0',
    });
    await periodEnded(left.c, left.current, checkout, 1);
    standIn.endSubscriptionCycle(left.current.providerSubscriptionId);
    await sweepPlanStates(sweepDeps(), 1000);
    expect((await subscriptionRow(checkout.subscriptionId)).status).toBe('created');
    expect(await planState(left.c.tenantId)).toMatchObject({
      status: 'canceled',
      plan_id: left.c.growthId,
      note: 'The subscription was cancelled.',
    });

    // Authorised, but made to start at another time, or to follow another subscription.
    for (const made of ['starts later', 'follows another'] as const) {
      const { c, current } = await paying();
      const next = await changedTo(c, { planId: await version() });
      await periodEnded(c, current, next, 1);
      await adminQuery(
        made === 'starts later'
          ? `UPDATE app.plan_subscriptions SET starts_at = starts_at + interval '1 day' WHERE id = $1`
          : 'UPDATE app.plan_subscriptions SET follows_subscription_id = $2 WHERE id = $1',
        made === 'starts later'
          ? [next.subscriptionId]
          : [next.subscriptionId, await expiredCopy(current.subscriptionId)],
      );
      standIn.endSubscriptionCycle(current.providerSubscriptionId);
      await sweepPlanStates(sweepDeps(), 1000);
      expect((await planState(c.tenantId)).status, made).toBe('canceled');
    }
  });
});

describe('staff and deletion', () => {
  it('cancels every subscription that may still charge, the one that follows included, and emails once', async () => {
    const { c, current } = await paying();
    const proId = await version();
    const next = await changedTo(c, { planId: proId });
    await admin().cancelTenantSubscription(owner, {
      tenantId: c.tenantId,
      reason: 'Company asked to stop paying, ticket 9110',
    });
    for (const sub of [current, next]) {
      expect(standIn.state.subscriptions.get(sub.providerSubscriptionId)?.status).toBe('cancelled');
      expect((await subscriptionRow(sub.subscriptionId)).status).toBe('cancelled');
    }
    expect((await subscriptionRow(current.subscriptionId)).staff_cancel_notice_due).toBe(true);
    expect((await subscriptionRow(next.subscriptionId)).staff_cancel_notice_due).toBe(false);
  });

  it('also cancels a subscription that came to follow the current one while staff were cancelling it', async () => {
    const { c, current } = await paying();
    const proId = await version();
    // The company changes its plan while the platform owner's cancel is on its way to Razorpay.
    let next: Sub | null = null;
    standIn.state.queues.cancelSubscription.push({
      kind: 'before',
      run: async () => {
        next = await changedTo(c, { planId: proId });
      },
    });
    await admin().cancelTenantSubscription(owner, {
      tenantId: c.tenantId,
      reason: 'Company asked to stop paying, ticket 9111',
    });
    const following = next as Sub | null;
    expect(following).not.toBeNull();
    for (const sub of [current, following!]) {
      expect(standIn.state.subscriptions.get(sub.providerSubscriptionId)?.status).toBe('cancelled');
      expect((await subscriptionRow(sub.subscriptionId)).status).toBe('cancelled');
    }
    expect((await subscriptionRow(current.subscriptionId)).staff_cancel_notice_due).toBe(true);
    expect((await subscriptionRow(following!.subscriptionId)).staff_cancel_notice_due).toBe(false);
  });

  it('cancels both at Razorpay when the company is deleted', async () => {
    const { c, current } = await paying();
    const proId = await version();
    const next = await changedTo(c, { planId: proId });
    const outcomes = await cancelPlanSubscriptionForDeletion(
      { db: dbs.app, clock, razorpay },
      authorizedTenantScope(c.tenantId, null),
    );
    expect(outcomes).toEqual([
      { label: 'Plan subscription at Razorpay', outcome: 'done' },
      { label: 'Next plan subscription at Razorpay', outcome: 'done' },
    ]);
    for (const sub of [current, next]) {
      expect(standIn.state.subscriptions.get(sub.providerSubscriptionId)?.status).toBe('cancelled');
    }
  });
});
