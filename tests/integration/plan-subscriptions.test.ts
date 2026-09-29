import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { Keyring, isAppError, uuidv7, type Clock, type RazorpayConfig } from '@w360/core';
import { authorizedTenantScope, sql } from '@w360/db';
import {
  JobSigner,
  PgBossJobQueue,
  RazorpayClient,
  cancelPlanSubscriptionForDeletion,
  createPlanAdminService,
  createPlanSubscriptionService,
  dayOf,
  outboxAad,
  processRazorpayReceipt,
  resolveTenantContext,
  storeWebhookReceipt,
  sweepPlanStates,
  sweepPlanSubscriptions,
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
  type TestUser,
} from './helpers';
import { startRazorpayStandIn, type RazorpayStandIn } from '../support/razorpay-stand-in';

/**
 * Paying for plans with Razorpay Subscriptions (P5-07, ADR-063) against real PostgreSQL and the
 * test-only Razorpay stand-in: the price with add-ons and tax, the write-ahead record before
 * Razorpay's plan and subscription, Checkout's signed response only prompting a fetch, the plan made
 * active for exactly the cycle Razorpay reports paid, renewals and failed charges from events that
 * carry nothing trusted, cancelling (by the company at the end of the period, by platform owners at
 * once), staff plan changes waiting for the subscription, the sweep, deletion and isolation.
 */
const KEY_ID = 'rzp_test_StandIn00000007';
const KEY_SECRET = randomBytes(16).toString('hex');
const TAX_REASON = 'GST on plan prices, ticket 9001';

let dbs: TestDatabases;
let boss: PgBoss;
let standIn: RazorpayStandIn;
let razorpay: RazorpayClient;
let owner: PlatformActor;
let operator: PlatformActor;
const signer = new JobSigner(randomBytes(32).toString('hex'));
const keyring = new Keyring({ primaryKeyId: 'test', keys: { test: randomBytes(32) } });
let offsetMs = 0;
const clock: Clock = { now: () => new Date(Date.now() + offsetMs) };
const DAY_MS = 86_400_000;

function config(overrides: Partial<RazorpayConfig> = {}): RazorpayConfig {
  return {
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    webhookSecrets: ['unused-in-these-tests'],
    recurringCardsEnabled: false,
    subscriptionsEnabled: true,
    apiBaseUrl: standIn.baseUrl,
    mode: 'test',
    ...overrides,
  };
}
function notices(): BillingNoticeDeps {
  return {
    outbox: { keyring, jobs: new PgBossJobQueue(boss), signer },
    appBaseUrl: 'http://localhost:3000',
  };
}
const service = (overrides: Partial<RazorpayConfig> = {}) =>
  createPlanSubscriptionService({
    db: dbs.app,
    clock,
    razorpay,
    razorpayConfig: config(overrides),
    notices: notices(),
  });
const provider = (): BillingProviderDeps => ({ db: dbs.app, razorpay, clock, notices: notices() });
const admin = () => createPlanAdminService({ platformDb: dbs.platform, clock, razorpay });

async function adminQuery<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await dbs.adminPool.query<T>(text, params)).rows;
}

async function platformActor(role: PlatformActor['role']): Promise<PlatformActor> {
  const user = await createUser(dbs, { name: `Platform ${role}`, twoFactor: true });
  await dbs.ownerPool.query('INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, $2)', [
    user.id,
    role,
  ]);
  return { userId: user.id, role, correlationId: uuidv7() };
}

/** A member's context, signed in `signedInAgoMs` before the test clock's now. */
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

interface Company {
  tenantId: string;
  slug: string;
  owner: TestUser;
  ctx: TenantContext;
  planId: string;
}

let codes = 0;
/** A published monthly plan: ₹999 with extra seats at ₹100 (and 7 grace days). */
async function plan(): Promise<string> {
  codes += 1;
  const { id } = await admin().createPlan(owner, {
    code: `subs-${Date.now().toString(36)}-${codes}`,
    name: 'Growth',
    price: '999',
    intervalMonths: '1',
    trialDays: '14',
    graceDays: '7',
    seatsIncluded: '3',
    seatPrice: '100',
    numbersIncluded: '1',
    modules: [],
  });
  await admin().publishPlan(owner, id);
  return id;
}

const day = (offset: number) => dayOf(new Date(Date.now() + offset * DAY_MS), 'Asia/Kolkata');

/** A company on a trial of a fresh plan version, with two extra seats. */
async function trialing(): Promise<Company> {
  const planId = await plan();
  const user = await createUser(dbs, { name: 'Billing Owner' });
  const tenant = await createTenant(dbs, user);
  const view = await admin().tenantPlan(owner, tenant.id);
  await admin().setTenantPlan(owner, {
    tenantId: tenant.id,
    version: view.state.version,
    reason: 'Trial agreed on the sales call',
    status: 'trialing',
    planId,
    trialEndsOn: day(10),
    extraSeats: '2',
  });
  return {
    tenantId: tenant.id,
    slug: tenant.slug,
    owner: user,
    ctx: await contextFor(user, tenant.slug),
    planId,
  };
}

function sign(paymentId: string, subscriptionId: string, secret = KEY_SECRET) {
  return createHmac('sha256', secret).update(`${paymentId}|${subscriptionId}`).digest('hex');
}

/** Starts paying, pays in Checkout and confirms: the company's plan is then active. */
async function subscribed(c: Company, beforeConfirm?: (subscriptionId: string) => void) {
  const start = await service().start(c.ctx);
  const { response } = standIn.authorizeSubscription(start.providerSubscriptionId);
  beforeConfirm?.(start.providerSubscriptionId);
  const confirmed = await service().confirmCheckout(c.ctx, {
    subscriptionId: start.subscriptionId,
    paymentId: response.razorpay_payment_id,
    signature: response.razorpay_signature,
  });
  return { start, response, confirmed };
}

/** The stand-in's invoices of a subscription. */
const invoicesOf = (providerSubscriptionId: string) =>
  [...standIn.state.invoices.values()].filter((i) => i.subscriptionId === providerSubscriptionId);

/** Moves the stand-in subscription's current cycle and its invoices back by `days`. */
function shiftCycle(providerSubscriptionId: string, days: number) {
  const sub = standIn.state.subscriptions.get(providerSubscriptionId)!;
  const by = days * 86_400;
  sub.currentStart = (sub.currentStart ?? 0) - by;
  sub.currentEnd = (sub.currentEnd ?? 0) - by;
  sub.chargeAt = sub.currentEnd;
  for (const invoice of standIn.state.invoices.values()) {
    if (invoice.subscriptionId !== providerSubscriptionId) continue;
    invoice.billingStart = (invoice.billingStart ?? 0) - by;
    invoice.billingEnd = (invoice.billingEnd ?? 0) - by;
  }
}

async function subscriptionRow(id: string) {
  const [row] = await adminQuery<{
    status: string;
    amount_minor: string;
    subtotal_minor: string;
    tax_minor: string;
    tax_bp: number;
    total_count: number;
    provider_plan_id: string | null;
    provider_subscription_id: string | null;
    authorize_by: Date;
    current_start: Date | null;
    current_end: Date | null;
    paid_count: number;
    cancel_at_period_end: boolean;
    cancelled_by_user_id: string | null;
    ended_at: Date | null;
    failure_reason: string | null;
  }>('SELECT * FROM app.plan_subscriptions WHERE id = $1', [id]);
  return row!;
}

async function planState(tenantId: string) {
  const [row] = await adminQuery<{
    status: string;
    period_start: Date | null;
    period_end: Date | null;
    grace_ends_at: Date | null;
    trial_ends_at: Date | null;
    subscription_id: string | null;
    usage_anchor: Date;
    note: string | null;
  }>('SELECT * FROM app.tenant_plans WHERE tenant_id = $1', [tenantId]);
  return row!;
}

async function planPayments(tenantId: string) {
  return adminQuery<{
    provider_payment_id: string;
    provider_invoice_id: string;
    amount_minor: string;
    period_start: Date;
    period_end: Date;
    method: string | null;
  }>('SELECT * FROM app.plan_payments WHERE tenant_id = $1 ORDER BY paid_at, created_at', [
    tenantId,
  ]);
}

async function billingEmails(tenantId: string) {
  const rows = await adminQuery<{ id: string; to_address: string; payload_ciphertext: string }>(
    `SELECT id, to_address, payload_ciphertext FROM ops.email_outbox
      WHERE tenant_id = $1 AND kind = 'billing.notice' ORDER BY id`,
    [tenantId],
  );
  return rows.map((r) => ({
    to: r.to_address,
    ...(JSON.parse(keyring.decryptString(r.payload_ciphertext, outboxAad(r.id))) as {
      subject: string;
      lines: string[];
    }),
  }));
}
const subjects = async (tenantId: string) => (await billingEmails(tenantId)).map((e) => e.subject);

async function audits(tenantId: string, action: string) {
  return adminQuery<{
    actor_type: string;
    actor_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    'SELECT actor_type, actor_id, metadata FROM app.audit_events WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id',
    [tenantId, action],
  );
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected the call to be refused');
}

let eventSeq = 0;
/** A signed webhook as Razorpay would send it, stored and processed like the worker does. */
async function deliver(event: string, payload: Record<string, unknown>) {
  eventSeq += 1;
  const body = Buffer.from(
    JSON.stringify({
      entity: 'event',
      account_id: 'acc_StandIn',
      event,
      contains: Object.keys(payload),
      payload,
      created_at: Math.floor(Date.now() / 1000) + eventSeq,
    }),
  );
  const stored = await storeWebhookReceipt(
    { db: dbs.app, keyring, jobs: new PgBossJobQueue(boss), signer },
    {
      provider: 'razorpay',
      rawBody: body,
      eventId: `evt_s${eventSeq}_${randomBytes(4).toString('hex')}`,
    },
  );
  const outcome = await processRazorpayReceipt({ ...provider(), keyring }, stored.receiptId);
  const [receipt] = await adminQuery<{ summary: Record<string, unknown> }>(
    'SELECT summary FROM ops.webhook_receipts WHERE id = $1',
    [stored.receiptId],
  );
  return { outcome, summary: receipt?.summary ?? {} };
}

/** An event payload naming the subscription, with fields a forger might try (never trusted). */
function subscriptionEvent(providerSubscriptionId: string, paymentId?: string) {
  return {
    subscription: {
      entity: {
        id: providerSubscriptionId,
        status: 'active',
        current_start: 1_000_000_000,
        current_end: 4_000_000_000,
        paid_count: 99,
        notes: [],
      },
    },
    ...(paymentId ? { payment: { entity: { id: paymentId, amount: 1, status: 'captured' } } } : {}),
  };
}

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
  operator = await platformActor('platform_operator');
  await admin().setPlanTax(owner, { tax: '18', reason: TAX_REASON });
});

afterAll(async () => {
  await standIn.close();
  await boss.stop({ graceful: false });
  await dbs.close();
});

describe('what a company pays', () => {
  it('the plan version’s price with add-ons plus the tax, offered only when the plan can be paid for here', async () => {
    offsetMs = 0;
    const c = await trialing();
    // ₹999 + 2 × ₹100 = ₹1,199.00, plus 18% (₹215.82) = ₹1,414.82.
    expect((await service().overview(c.ctx)).offer).toEqual({
      available: true,
      intervalMonths: 1,
      quote: {
        planMinor: 99_900,
        seatsMinor: 20_000,
        numbersMinor: 0,
        runPacksMinor: 0,
        subtotalMinor: 119_900,
        taxBp: 1800,
        taxMinor: 21_582,
        totalMinor: 141_482,
      },
    });
    expect((await service({ subscriptionsEnabled: false }).overview(c.ctx)).offer).toEqual({
      available: false,
      reason: 'not_offered',
    });

    // Only platform owners set the tax; until it is set, nothing is offered.
    expect(
      (await refusal(admin().setPlanTax(operator, { tax: '5', reason: TAX_REASON }))).code,
    ).toBe('forbidden');
    expect((await refusal(admin().setPlanTax(owner, { tax: '51', reason: TAX_REASON }))).code).toBe(
      'validation_failed',
    );
    await admin().setPlanTax(owner, { tax: '', reason: TAX_REASON });
    expect((await service().overview(c.ctx)).offer).toEqual({ available: false, reason: 'no_tax' });
    expect((await admin().listPlans(owner)).planTaxBp).toBeNull();
    await admin().setPlanTax(owner, { tax: '12.5', reason: TAX_REASON });
    const quote = (await service().overview(c.ctx)).offer;
    // 12.5% of ₹1,199.00 is ₹149.875, rounded half up to ₹149.88.
    expect(quote).toMatchObject({ quote: { taxBp: 1250, taxMinor: 14_988, totalMinor: 134_888 } });
    await admin().setPlanTax(owner, { tax: '18', reason: TAX_REASON });
    const taxAudits = await adminQuery<{ metadata: Record<string, unknown>; reason: string }>(
      `SELECT metadata, reason FROM ops.platform_audit_events
        WHERE action = 'platform.plan_tax_set' AND actor_user_id = $1 ORDER BY occurred_at, id`,
      [owner.userId],
    );
    expect(taxAudits.slice(-2).map((a) => a.metadata)).toEqual([
      { taxBp: 1250, previousTaxBp: null },
      { taxBp: 1800, previousTaxBp: 1250 },
    ]);

    // Complimentary access and a paid period staff set are not paid for here.
    const view = await admin().tenantPlan(owner, c.tenantId);
    await admin().setTenantPlan(owner, {
      tenantId: c.tenantId,
      version: view.state.version,
      reason: 'Invoice INV-9002 paid by transfer',
      status: 'active',
      planId: c.planId,
      periodStart: day(0),
      periodEnd: day(30),
      extraSeats: '2',
    });
    expect((await service().overview(c.ctx)).offer).toEqual({
      available: false,
      reason: 'paid_period',
    });
    const again = await admin().tenantPlan(owner, c.tenantId);
    await admin().setTenantPlan(owner, {
      tenantId: c.tenantId,
      version: again.state.version,
      reason: 'Partner account, no charge',
      status: 'complimentary',
    });
    expect((await service().overview(c.ctx)).offer).toEqual({
      available: false,
      reason: 'complimentary',
    });
    expect((await refusal(service().start(c.ctx))).code).toBe('precondition_failed');
  });
});

describe('what a company pays, continued', () => {
  it('nothing is offered on a retired version, to a company being deleted, or with paying switched off', async () => {
    offsetMs = 0;
    const retired = await trialing();
    await admin().retirePlan(owner, retired.planId, { reason: 'Replaced by a new version' });
    expect((await service().overview(retired.ctx)).offer).toEqual({
      available: false,
      reason: 'plan_not_published',
    });
    expect((await refusal(service().start(retired.ctx))).code).toBe('precondition_failed');

    const deleting = await trialing();
    await adminQuery(`UPDATE app.tenants SET status = 'pending_deletion' WHERE id = $1`, [
      deleting.tenantId,
    ]);
    expect((await service().overview(deleting.ctx)).offer).toEqual({
      available: false,
      reason: 'deleting',
    });
    expect((await refusal(service().start(deleting.ctx))).code).toBe('precondition_failed');

    const off = await trialing();
    const calls = standIn.state.calls.length;
    expect((await refusal(service({ subscriptionsEnabled: false }).start(off.ctx))).code).toBe(
      'unsupported',
    );
    expect(standIn.state.calls).toHaveLength(calls);
    expect(
      await adminQuery('SELECT 1 FROM app.plan_subscriptions WHERE tenant_id = ANY ($1)', [
        [retired.tenantId, deleting.tenantId, off.tenantId],
      ]),
    ).toEqual([]);
  });
});

describe('starting to pay', () => {
  it('records the subscription first, then creates Razorpay’s plan and subscription; the paid cycle makes the plan active', async () => {
    offsetMs = 0;
    const c = await trialing();
    let seenWhileCreating: string | undefined;
    standIn.state.queues.createPlan.push({
      kind: 'before',
      run: async () => {
        const [row] = await adminQuery<{ status: string }>(
          'SELECT status FROM app.plan_subscriptions WHERE tenant_id = $1',
          [c.tenantId],
        );
        seenWhileCreating = row?.status;
      },
    });
    const before = standIn.state.calls.length;
    const start = await service().start(c.ctx);
    expect(seenWhileCreating).toBe('creating');
    expect(start).toMatchObject({
      keyId: KEY_ID,
      amountMinor: 141_482,
      intervalMonths: 1,
      planName: 'Growth',
      prefill: { name: 'Billing Owner', email: c.owner.email },
    });
    expect(start.providerSubscriptionId).toMatch(/^sub_/);
    const calls = standIn.state.calls.slice(before);
    const planCall = calls.find((call) => call.path === '/v1/plans');
    const subCall = calls.find((call) => call.path === '/v1/subscriptions');
    expect(planCall?.body).toEqual({
      period: 'monthly',
      interval: 1,
      item: { name: 'HyFib Growth plan', amount: 141_482, currency: 'INR' },
      notes: { purpose: 'plan_subscription', subscription: start.subscriptionId },
    });
    const row = await subscriptionRow(start.subscriptionId);
    expect(row).toMatchObject({
      status: 'created',
      subtotal_minor: '119900',
      tax_bp: 1800,
      tax_minor: '21582',
      amount_minor: '141482',
      total_count: 60,
      provider_subscription_id: start.providerSubscriptionId,
    });
    expect(subCall?.body).toEqual({
      plan_id: row.provider_plan_id,
      total_count: 60,
      quantity: 1,
      expire_by: Math.floor(row.authorize_by.getTime() / 1000),
      customer_notify: true,
      notes: { purpose: 'plan_subscription', subscription: start.subscriptionId },
    });
    expect(row.authorize_by.getTime() - Date.now()).toBeGreaterThan(55 * 60_000);
    expect(row.authorize_by.getTime() - Date.now()).toBeLessThanOrEqual(3600_000);
    expect(await audits(c.tenantId, 'billing.plan_subscription_started')).toHaveLength(1);
    expect((await service().overview(c.ctx)).subscription).toMatchObject({
      status: 'created',
      checkoutOpen: true,
    });

    const { response } = standIn.authorizeSubscription(start.providerSubscriptionId);
    expect(
      await service().confirmCheckout(c.ctx, {
        subscriptionId: start.subscriptionId,
        paymentId: response.razorpay_payment_id,
        signature: response.razorpay_signature,
      }),
    ).toEqual({ status: 'active' });
    const sub = standIn.state.subscriptions.get(start.providerSubscriptionId)!;
    const state = await planState(c.tenantId);
    expect(state).toMatchObject({
      status: 'active',
      trial_ends_at: null,
      grace_ends_at: null,
      subscription_id: start.subscriptionId,
      note: 'Paid by subscription through Razorpay.',
    });
    expect(state.period_start?.getTime()).toBe(sub.currentStart! * 1000);
    expect(state.period_end?.getTime()).toBe(sub.currentEnd! * 1000);
    // A new paid period restarts the monthly usage period (ADR-051).
    expect(state.usage_anchor.getTime()).toBe(sub.currentStart! * 1000);
    const payments = await planPayments(c.tenantId);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      provider_payment_id: response.razorpay_payment_id,
      amount_minor: '141482',
      method: 'card',
    });
    expect(await audits(c.tenantId, 'plan.subscription_period')).toMatchObject([
      { actor_type: 'system', metadata: { previous_status: 'trialing' } },
    ]);
    const emails = await billingEmails(c.tenantId);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({
      to: c.owner.email,
      subject: 'Payment received for your HyFib plan',
    });
    expect(emails[0]!.lines[0]).toContain('₹1,414.82');
    const overview = await service().overview(c.ctx);
    expect(overview.offer).toEqual({ available: false, reason: 'subscribed' });
    expect(overview.subscription).toMatchObject({ status: 'active', checkoutOpen: false });
    expect(overview.payments).toHaveLength(1);

    // The same response again changes nothing.
    expect(
      await service().confirmCheckout(c.ctx, {
        subscriptionId: start.subscriptionId,
        paymentId: response.razorpay_payment_id,
        signature: response.razorpay_signature,
      }),
    ).toEqual({ status: 'active' });
    expect(await planPayments(c.tenantId)).toHaveLength(1);
    expect(await billingEmails(c.tenantId)).toHaveLength(1);
  });

  it('Checkout’s response proves nothing on its own: forged or borrowed signatures are refused, an unpaid one waits', async () => {
    offsetMs = 0;
    const c = await trialing();
    const start = await service().start(c.ctx);
    const other = await trialing();
    const otherStart = await service().start(other.ctx);
    const paymentId = 'pay_NotPaid0001';
    const attempt = (signature: string, subscriptionId = start.subscriptionId) =>
      service().confirmCheckout(c.ctx, { subscriptionId, paymentId, signature });
    expect((await refusal(attempt(sign(paymentId, start.providerSubscriptionId, 'x')))).code).toBe(
      'validation_failed',
    );
    // A signature for another company's subscription does not fit this one.
    expect((await refusal(attempt(sign(paymentId, otherStart.providerSubscriptionId)))).code).toBe(
      'validation_failed',
    );
    // Nor can this company confirm the other company's subscription.
    expect(
      (
        await refusal(
          attempt(sign(paymentId, otherStart.providerSubscriptionId), otherStart.subscriptionId),
        )
      ).code,
    ).toBe('not_found');
    // A correct signature with nothing paid at Razorpay leaves the trial as it was.
    expect(await attempt(sign(paymentId, start.providerSubscriptionId))).toEqual({
      status: 'processing',
    });
    expect((await planState(c.tenantId)).status).toBe('trialing');
    expect(await planPayments(c.tenantId)).toEqual([]);
    expect((await service().overview(other.ctx)).subscription?.id).toBe(otherStart.subscriptionId);
  });

  it('needs billing.manage and a recent sign-in; an open Checkout is reused, one whose window closed is replaced', async () => {
    offsetMs = 0;
    const c = await trialing();
    const agent = await createUser(dbs, { name: 'Agent' });
    const { token } = await invite(
      dbs,
      { id: c.tenantId, slug: c.slug, ownerMembershipId: '' },
      c.owner,
      agent.email,
      ['agent'],
    );
    await acceptInvitation(dbs, agent, token);
    expect((await refusal(service().start(await contextFor(agent, c.slug)))).code).toBe(
      'forbidden',
    );
    // Administrators read billing but do not manage it.
    const administrator = await createUser(dbs, { name: 'Administrator' });
    const invited = await invite(
      dbs,
      { id: c.tenantId, slug: c.slug, ownerMembershipId: '' },
      c.owner,
      administrator.email,
      ['admin'],
    );
    await acceptInvitation(dbs, administrator, invited.token);
    const adminCtx = await contextFor(administrator, c.slug);
    expect((await service().overview(adminCtx)).offer).toMatchObject({ available: true });
    expect((await refusal(service().start(adminCtx))).code).toBe('forbidden');
    expect((await refusal(service().cancel(adminCtx))).code).toBe('forbidden');
    expect(
      (await refusal(service().start(await contextFor(c.owner, c.slug, 20 * 60_000)))).code,
    ).toBe('step_up_required');

    const created = () => standIn.state.calls.filter((call) => call.path === '/v1/subscriptions');
    const first = await service().start(c.ctx);
    const count = created().length;
    const reopened = await service().start(c.ctx);
    expect(reopened.subscriptionId).toBe(first.subscriptionId);
    expect(reopened.providerSubscriptionId).toBe(first.providerSubscriptionId);
    expect(created()).toHaveLength(count);

    // After its window closed the unpaid subscription is cancelled at Razorpay and replaced.
    offsetMs = 61 * 60_000;
    const replaced = await service().start(await contextFor(c.owner, c.slug));
    expect(replaced.subscriptionId).not.toBe(first.subscriptionId);
    expect(standIn.state.subscriptions.get(first.providerSubscriptionId)?.status).toBe('cancelled');
    expect((await subscriptionRow(first.subscriptionId)).status).toBe('cancelled');
    expect((await subscriptionRow(replaced.subscriptionId)).status).toBe('created');
    offsetMs = 0;
  });

  it('a Razorpay failure while starting fails HyFib’s record; nothing payable is left behind', async () => {
    offsetMs = 0;
    const c = await trialing();
    standIn.state.queues.createPlan.push({ kind: 'error', status: 500 });
    expect((await refusal(service().start(c.ctx))).code).toBe('provider_unavailable');
    const [failed] = await adminQuery<{ id: string; status: string; failure_reason: string }>(
      'SELECT id, status, failure_reason FROM app.plan_subscriptions WHERE tenant_id = $1',
      [c.tenantId],
    );
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed!.failure_reason).toMatch(/^Razorpay did not create the plan/);

    // Razorpay created the subscription but the answer was lost: no one learns its id, and its
    // authorisation window closes within the hour.
    standIn.state.queues.createSubscription.push({ kind: 'process_then_drop' });
    const before = standIn.state.subscriptions.size;
    expect((await refusal(service().start(c.ctx))).code).toBe('provider_unavailable');
    expect(standIn.state.subscriptions.size).toBe(before + 1);
    const lost = [...standIn.state.subscriptions.values()].at(-1)!;
    expect(lost.expireBy! - Date.now() / 1000).toBeLessThanOrEqual(3600);
    const statuses = await adminQuery<{ status: string; provider_subscription_id: string | null }>(
      'SELECT status, provider_subscription_id FROM app.plan_subscriptions WHERE tenant_id = $1 ORDER BY created_at',
      [c.tenantId],
    );
    expect(statuses).toEqual([
      { status: 'failed', provider_subscription_id: null },
      { status: 'failed', provider_subscription_id: null },
    ]);
    // Starting again works.
    const start = await service().start(c.ctx);
    expect((await subscriptionRow(start.subscriptionId)).status).toBe('created');

    // Razorpay answering with a plan for another amount, or a subscription for another plan: the
    // start fails and nothing is left to pay.
    const d = await trialing();
    const created = () => standIn.state.calls.filter((call) => call.path === '/v1/subscriptions');
    const subscriptionsBefore = created().length;
    standIn.state.queues.createPlan.push({
      kind: 'alter',
      alter: (answer) => {
        const item = answer.item as Record<string, unknown>;
        return { ...answer, item: { ...item, amount: Number(item.amount) + 100 } };
      },
    });
    expect((await refusal(service().start(d.ctx))).code).toBe('provider_unavailable');
    expect(created()).toHaveLength(subscriptionsBefore);
    standIn.state.queues.createSubscription.push({
      kind: 'alter',
      alter: (answer) => ({ ...answer, plan_id: 'plan_AnotherPlan0001' }),
    });
    expect((await refusal(service().start(d.ctx))).code).toBe('provider_unavailable');
    expect(
      await adminQuery(
        'SELECT status, failure_reason FROM app.plan_subscriptions WHERE tenant_id = $1 ORDER BY created_at',
        [d.tenantId],
      ),
    ).toEqual([
      { status: 'failed', failure_reason: 'Razorpay created a plan for another amount.' },
      { status: 'failed', failure_reason: 'Razorpay created a subscription for another plan.' },
    ]);
  });
});

describe('following Razorpay', () => {
  it('a renewal counts once, from Razorpay’s state, however often its events arrive', async () => {
    offsetMs = 0;
    const c = await trialing();
    const { start } = await subscribed(c);
    const firstCycle = { ...standIn.state.subscriptions.get(start.providerSubscriptionId)! };
    const renewal = standIn.chargeSubscription(start.providerSubscriptionId);
    const event = subscriptionEvent(start.providerSubscriptionId, renewal.payment.id);
    const first = await deliver('subscription.charged', event);
    expect(first).toMatchObject({
      outcome: 'processed',
      summary: { result: 'subscription_active' },
    });
    const sub = standIn.state.subscriptions.get(start.providerSubscriptionId)!;
    const state = await planState(c.tenantId);
    expect(state.period_start?.getTime()).toBe(sub.currentStart! * 1000);
    expect(state.period_end?.getTime()).toBe(sub.currentEnd! * 1000);
    expect(await planPayments(c.tenantId)).toHaveLength(2);
    expect((await subscriptionRow(start.subscriptionId)).paid_count).toBe(2);
    expect(await subjects(c.tenantId)).toEqual([
      'Payment received for your HyFib plan',
      'Payment received for your HyFib plan',
    ]);
    // Redelivered, and the payment's own event: nothing more.
    await deliver('subscription.charged', event);
    expect(
      await deliver('payment.captured', { payment: { entity: { id: renewal.payment.id } } }),
    ).toMatchObject({ outcome: 'processed', summary: { result: 'subscription_synced' } });
    expect(await planPayments(c.tenantId)).toHaveLength(2);
    expect(await billingEmails(c.tenantId)).toHaveLength(2);
    expect(await audits(c.tenantId, 'plan.subscription_period')).toHaveLength(2);

    // An older answer (as Razorpay stood before the renewal) changes nothing.
    const renewed = await subscriptionRow(start.subscriptionId);
    const latest = { ...sub };
    Object.assign(sub, {
      paidCount: firstCycle.paidCount,
      currentStart: firstCycle.currentStart,
      currentEnd: firstCycle.currentEnd,
      chargeAt: firstCycle.chargeAt,
    });
    await deliver('subscription.updated', subscriptionEvent(start.providerSubscriptionId));
    expect(await subscriptionRow(start.subscriptionId)).toMatchObject({
      paid_count: 2,
      current_start: renewed.current_start,
      current_end: renewed.current_end,
    });
    expect((await planState(c.tenantId)).period_end?.getTime()).toBe(state.period_end?.getTime());
    Object.assign(sub, latest);
  });

  it('a subscription HyFib ended while Razorpay was being asked stays ended', async () => {
    offsetMs = 0;
    const c = await trialing();
    const { start } = await subscribed(c);
    const periodEnd = (await planState(c.tenantId)).period_end;
    const renewal = standIn.chargeSubscription(start.providerSubscriptionId);
    // A platform owner's cancel is saved while the renewal's event is being handled.
    standIn.state.queues.subscriptionFetch.push({
      kind: 'before',
      run: async () => {
        await adminQuery(
          `UPDATE app.plan_subscriptions
              SET status = 'cancelled', ended_at = now(), cancel_requested_at = now()
            WHERE id = $1`,
          [start.subscriptionId],
        );
      },
    });
    await deliver(
      'subscription.charged',
      subscriptionEvent(start.providerSubscriptionId, renewal.payment.id),
    );
    expect((await subscriptionRow(start.subscriptionId)).status).toBe('cancelled');
    expect((await planState(c.tenantId)).period_end?.getTime()).toBe(periodEnd?.getTime());
  });

  it('a failed charge: billing managers hear once, the period runs into grace days, a later charge pays again', async () => {
    offsetMs = 0;
    const c = await trialing();
    // The paid cycle ended yesterday.
    const { start } = await subscribed(c, (id) => shiftCycle(id, 31));
    const paidEnd = (await planState(c.tenantId)).period_end!;
    expect(paidEnd.getTime()).toBeLessThan(Date.now());

    const failed = standIn.chargeSubscription(start.providerSubscriptionId, { status: 'failed' });
    const event = subscriptionEvent(start.providerSubscriptionId, failed.payment.id);
    await deliver('subscription.pending', event);
    await deliver('subscription.pending', event);
    expect((await subscriptionRow(start.subscriptionId)).status).toBe('pending');
    expect(await subjects(c.tenantId)).toEqual([
      'Payment received for your HyFib plan',
      'A payment for your HyFib plan failed',
    ]);
    expect(await planPayments(c.tenantId)).toHaveLength(1);

    // The sweep syncs first, then the paid period ends into the version's 7 grace days.
    const swept = await sweepPlanStates(sweepDeps());
    expect(swept.failed.filter((f) => f.tenantId === c.tenantId)).toEqual([]);
    const pastDue = await planState(c.tenantId);
    expect(pastDue.status).toBe('past_due');
    expect(pastDue.grace_ends_at?.getTime()).toBe(paidEnd.getTime() + 7 * DAY_MS);
    // Razorpay may still charge the subscription, so another one cannot be started.
    expect(await refusal(service().start(c.ctx))).toMatchObject({
      code: 'conflict',
      message: 'Your company already pays for its plan by subscription.',
    });
    const [ended] = (await billingEmails(c.tenantId)).slice(-1);
    expect(ended).toMatchObject({ subject: 'The paid period of your HyFib plan has ended' });
    expect(ended!.lines[0]).toContain('Razorpay has not charged for the next one yet');

    // The payer changes the card and Razorpay's retry goes through.
    const retry = standIn.chargeSubscription(start.providerSubscriptionId);
    await deliver(
      'subscription.charged',
      subscriptionEvent(start.providerSubscriptionId, retry.payment.id),
    );
    const active = await planState(c.tenantId);
    expect(active).toMatchObject({ status: 'active', grace_ends_at: null });
    expect(active.period_start?.getTime()).toBe(paidEnd.getTime());
    expect(await planPayments(c.tenantId)).toHaveLength(2);

    // Retries exhausted later: the stop is announced once.
    standIn.chargeSubscription(start.providerSubscriptionId, { status: 'failed' });
    standIn.setSubscriptionStatus(start.providerSubscriptionId, 'halted');
    await deliver('subscription.halted', subscriptionEvent(start.providerSubscriptionId));
    await deliver('subscription.halted', subscriptionEvent(start.providerSubscriptionId));
    const all = await subjects(c.tenantId);
    expect(all.filter((s) => s === 'Payments for your HyFib plan have stopped')).toHaveLength(1);
    expect((await subscriptionRow(start.subscriptionId)).status).toBe('halted');
  });

  it('Razorpay reporting a new cycle without a paid invoice for it does not extend the plan', async () => {
    offsetMs = 0;
    const c = await trialing();
    const { start } = await subscribed(c);
    const before = await planState(c.tenantId);
    const sub = standIn.state.subscriptions.get(start.providerSubscriptionId)!;
    const cycle = sub.currentEnd! - sub.currentStart!;
    sub.currentStart = sub.currentEnd;
    sub.currentEnd = sub.currentEnd! + cycle;
    sub.paidCount += 1; // claims a paid cycle HyFib cannot find an invoice for
    await deliver('subscription.charged', subscriptionEvent(start.providerSubscriptionId));
    const after = await planState(c.tenantId);
    expect(after.period_end?.getTime()).toBe(before.period_end?.getTime());
    expect(await planPayments(c.tenantId)).toHaveLength(1);
  });

  it('invoice periods aligned to days still find the paid cycle by their middle', async () => {
    offsetMs = 0;
    const c = await trialing();
    const { start } = await subscribed(c, (id) => {
      // Midnight in India (18:30 UTC) on the days the cycle starts and ends.
      const toIndiaMidnight = (s: number) => Math.floor((s + 19_800) / 86_400) * 86_400 - 19_800;
      for (const invoice of standIn.state.invoices.values()) {
        if (invoice.subscriptionId !== id) continue;
        invoice.billingStart = toIndiaMidnight(invoice.billingStart!);
        invoice.billingEnd = toIndiaMidnight(invoice.billingEnd!);
      }
    });
    const state = await planState(c.tenantId);
    const sub = standIn.state.subscriptions.get(start.providerSubscriptionId)!;
    expect(state).toMatchObject({ status: 'active', subscription_id: start.subscriptionId });
    expect(state.period_end?.getTime()).toBe(sub.currentEnd! * 1000);
  });

  it('events, payments and invoices HyFib does not know are never applied', async () => {
    offsetMs = 0;
    // A subscription another integration created on the same Razorpay account.
    const foreignPlan = await razorpay.createPlan({
      period: 'monthly',
      amount: 50_000,
      currency: 'INR',
      name: 'Another product',
    });
    if (!foreignPlan.ok) throw new Error('plan');
    const foreign = await razorpay.createSubscription({
      planId: foreignPlan.data.id,
      totalCount: 12,
      expireBy: Math.floor(Date.now() / 1000) + 3600,
      customerNotify: true,
    });
    if (!foreign.ok) throw new Error('subscription');
    const paid = standIn.authorizeSubscription(foreign.data.id);
    expect(
      await deliver('subscription.activated', subscriptionEvent(foreign.data.id)),
    ).toMatchObject({ outcome: 'quarantined' });
    expect(
      await deliver('payment.captured', { payment: { entity: { id: paid.payment.id } } }),
    ).toMatchObject({ outcome: 'quarantined' });
    expect(
      await adminQuery(
        `SELECT 1 FROM ops.webhook_quarantine q JOIN ops.webhook_receipts r ON r.id = q.receipt_id
          WHERE q.external_ids->>'subscriptionId' = $1`,
        [foreign.data.id],
      ),
    ).toHaveLength(1);

    // An invoice of our subscription for another amount is not a plan payment.
    const c = await trialing();
    const start = await service().start(c.ctx);
    standIn.authorizeSubscription(start.providerSubscriptionId);
    for (const invoice of standIn.state.invoices.values()) {
      if (invoice.subscriptionId === start.providerSubscriptionId) invoice.amountPaid += 1;
    }
    await deliver('subscription.activated', subscriptionEvent(start.providerSubscriptionId));
    expect(await planPayments(c.tenantId)).toEqual([]);
    expect((await planState(c.tenantId)).status).toBe('trialing');

    // Nor an invoice that is not paid, an invoice of another subscription, or a payment Razorpay
    // does not report captured for exactly the amount, whatever the rest of the answer says.
    const distortions: ((providerSubscriptionId: string) => void)[] = [
      (id) => invoicesOf(id).forEach((invoice) => (invoice.status = 'issued')),
      () =>
        standIn.state.queues.subscriptionFetch.push(
          { kind: 'ok' },
          {
            kind: 'alter',
            alter: (list) => ({
              ...list,
              items: (list.items as Record<string, unknown>[]).map((invoice) => ({
                ...invoice,
                subscription_id: foreign.data.id,
              })),
            }),
          },
        ),
      (id) =>
        invoicesOf(id).forEach((invoice) =>
          standIn.setPaymentStatus(invoice.paymentId!, 'authorized'),
        ),
      (id) =>
        invoicesOf(id).forEach((invoice) => {
          standIn.state.payments.get(invoice.paymentId!)!.amount += 1;
        }),
    ];
    for (const distort of distortions) {
      const d = await trialing();
      const s = await service().start(d.ctx);
      standIn.authorizeSubscription(s.providerSubscriptionId);
      distort(s.providerSubscriptionId);
      await deliver('subscription.activated', subscriptionEvent(s.providerSubscriptionId));
      expect(await planPayments(d.tenantId)).toEqual([]);
      expect((await planState(d.tenantId)).status).toBe('trialing');
    }
  });
});

describe('the paid period in the database', () => {
  it('is applied only in the company’s own scope, for an active subscription with the plan’s add-ons', async () => {
    offsetMs = 0;
    const c = await trialing();
    const { start } = await subscribed(c);
    const other = await trialing();
    const apply = (scopeTenantId: string) =>
      dbs.app.run(authorizedTenantScope(scopeTenantId, null), async (tx) => {
        const res = await tx.execute<{ result: string }>(
          sql`select app.apply_plan_subscription_period(${c.tenantId}::uuid, ${start.subscriptionId}::uuid) as result`,
        );
        return res.rows[0]?.result;
      });
    expect(await apply(c.tenantId)).toBe('unchanged');
    await expect(apply(other.tenantId)).rejects.toThrow(/own scope/);
    await adminQuery(`UPDATE app.plan_subscriptions SET status = 'pending' WHERE id = $1`, [
      start.subscriptionId,
    ]);
    expect(await apply(c.tenantId)).toBe('not_paid');
    await adminQuery(`UPDATE app.plan_subscriptions SET status = 'active' WHERE id = $1`, [
      start.subscriptionId,
    ]);
    // Other add-ons than the subscription pays for: never applied.
    await adminQuery('UPDATE app.tenant_plans SET extra_seats = 3 WHERE tenant_id = $1', [
      c.tenantId,
    ]);
    expect(await apply(c.tenantId)).toBe('mismatch');
  });
});

describe('cancelling', () => {
  it('by the company: nothing more is charged, the plan ends as canceled at the end of the paid period, and it can pay again', async () => {
    offsetMs = 0;
    const c = await trialing();
    const { start } = await subscribed(c, (id) => shiftCycle(id, 31));
    expect(
      (await refusal(service().cancel(await contextFor(c.owner, c.slug, 20 * 60_000)))).code,
    ).toBe('step_up_required');
    const cancelled = await service().cancel(c.ctx);
    expect(cancelled.atPeriodEnd).toBe(true);
    expect(standIn.state.subscriptions.get(start.providerSubscriptionId)).toMatchObject({
      status: 'active',
      cancelAtCycleEnd: true,
    });
    expect(await subscriptionRow(start.subscriptionId)).toMatchObject({
      status: 'active',
      cancel_at_period_end: true,
      cancelled_by_user_id: c.owner.id,
    });
    expect((await subjects(c.tenantId)).at(-1)).toBe('Your HyFib plan subscription is cancelled');
    expect(await audits(c.tenantId, 'billing.plan_subscription_cancelled')).toMatchObject([
      { actor_type: 'user', actor_id: c.owner.id, metadata: { atPeriodEnd: true } },
    ]);
    // Asking again changes nothing.
    expect((await service().cancel(c.ctx)).atPeriodEnd).toBe(true);

    // The period (ended yesterday) moves on: canceled, without grace days.
    await sweepPlanStates(sweepDeps());
    expect(await planState(c.tenantId)).toMatchObject({
      status: 'canceled',
      grace_ends_at: null,
      note: 'The subscription was cancelled.',
    });
    expect((await subjects(c.tenantId)).at(-1)).toBe('Your HyFib plan has ended');

    // Razorpay ends the subscription; its event (or the sweep) records it; paying again works.
    standIn.endSubscriptionCycle(start.providerSubscriptionId);
    await deliver('subscription.cancelled', subscriptionEvent(start.providerSubscriptionId));
    expect((await subscriptionRow(start.subscriptionId)).status).toBe('cancelled');
    expect((await service().overview(c.ctx)).offer).toMatchObject({ available: true });
    const again = await service().start(c.ctx);
    expect(again.subscriptionId).not.toBe(start.subscriptionId);
  });

  it('by staff: plan changes wait for the subscription; platform owners cancel it at once, the paid period stands', async () => {
    offsetMs = 0;
    const c = await trialing();
    const { start } = await subscribed(c);
    const view = await admin().tenantPlan(owner, c.tenantId);
    expect(view.subscription).toMatchObject({
      id: start.subscriptionId,
      status: 'active',
      live: true,
    });
    expect(view.payments).toHaveLength(1);
    const change = {
      tenantId: c.tenantId,
      version: view.state.version,
      reason: 'Moving the company to a larger plan',
      status: 'active',
      planId: c.planId,
      periodStart: day(0),
      periodEnd: day(60),
    };
    expect(await refusal(admin().setTenantPlan(owner, change))).toMatchObject({
      code: 'precondition_failed',
      message:
        'The company pays for its plan by Razorpay subscription. Cancel the subscription first.',
    });
    const reason = 'Customer asked by phone, ticket 881';
    expect(
      (await refusal(admin().cancelTenantSubscription(operator, { tenantId: c.tenantId, reason })))
        .code,
    ).toBe('forbidden');
    expect(
      (
        await refusal(
          admin().cancelTenantSubscription(owner, { tenantId: c.tenantId, reason: 'no' }),
        )
      ).code,
    ).toBe('validation_failed');
    await admin().cancelTenantSubscription(owner, { tenantId: c.tenantId, reason });
    expect(standIn.state.subscriptions.get(start.providerSubscriptionId)?.status).toBe('cancelled');
    expect(await subscriptionRow(start.subscriptionId)).toMatchObject({
      status: 'cancelled',
      cancelled_by_user_id: owner.userId,
    });
    expect((await planState(c.tenantId)).status).toBe('active');
    expect(
      await adminQuery(
        `SELECT reason FROM ops.platform_audit_events
          WHERE action = 'platform.plan_subscription_cancelled' AND target_tenant_id = $1`,
        [c.tenantId],
      ),
    ).toEqual([{ reason }]);
    expect(await audits(c.tenantId, 'platform.plan_subscription_cancelled')).toHaveLength(1);

    // Now staff can change the plan; the new period is not the subscription's.
    await admin().setTenantPlan(owner, change);
    expect(await planState(c.tenantId)).toMatchObject({ status: 'active', subscription_id: null });
  });

  it('deleting the company cancels its subscription at Razorpay', async () => {
    offsetMs = 0;
    const c = await trialing();
    const { start } = await subscribed(c);
    const scope = authorizedTenantScope(c.tenantId, null);
    expect(
      await cancelPlanSubscriptionForDeletion({ db: dbs.app, clock, razorpay }, scope),
    ).toEqual({
      label: 'Plan subscription at Razorpay',
      outcome: 'done',
    });
    expect(standIn.state.subscriptions.get(start.providerSubscriptionId)?.status).toBe('cancelled');
    expect((await subscriptionRow(start.subscriptionId)).status).toBe('cancelled');
    expect(await audits(c.tenantId, 'billing.plan_subscription_cancelled')).toMatchObject([
      { actor_type: 'system', metadata: { reason: 'company_deleted' } },
    ]);
    // Nothing left to cancel.
    expect(
      await cancelPlanSubscriptionForDeletion({ db: dbs.app, clock, razorpay }, scope),
    ).toBeNull();
  });
});

describe('the sweep', () => {
  it('fails a subscription never created at Razorpay and cancels an unpaid one whose window closed', async () => {
    offsetMs = 0;
    const stuck = await trialing();
    const stuckId = uuidv7();
    await adminQuery(
      `INSERT INTO app.plan_subscriptions (id, tenant_id, plan_id, interval_months, extra_seats,
         extra_numbers, run_packs, subtotal_minor, tax_bp, tax_minor, amount_minor, total_count,
         authorize_by, created_by_user_id, created_at)
       VALUES ($1, $2, $3, 1, 2, 0, 0, 119900, 1800, 21582, 141482, 60, now() + interval '50 minutes',
               $4, now() - interval '11 minutes')`,
      [stuckId, stuck.tenantId, stuck.planId, stuck.owner.id],
    );
    const unpaid = await trialing();
    const start = await service().start(unpaid.ctx);
    await adminQuery(
      `UPDATE app.plan_subscriptions SET authorize_by = now() - interval '1 minute' WHERE id = $1`,
      [start.subscriptionId],
    );
    const result = await sweepPlanSubscriptions(provider());
    expect(result.failed).toEqual([]);
    expect(await subscriptionRow(stuckId)).toMatchObject({
      status: 'failed',
      failure_reason: 'The payment could not be started.',
    });
    expect(standIn.state.subscriptions.get(start.providerSubscriptionId)?.status).toBe('cancelled');
    expect((await subscriptionRow(start.subscriptionId)).status).toBe('cancelled');
    // Both companies can start again.
    expect((await service().overview(stuck.ctx)).offer).toMatchObject({ available: true });
    expect((await service().overview(unpaid.ctx)).offer).toMatchObject({ available: true });
  });

  it('syncs before a paid period ends, so a renewal whose events were missed keeps the plan paid', async () => {
    offsetMs = 0;
    const c = await trialing();
    // The paid cycle ended yesterday; Razorpay charged the next one and its events never arrived.
    const { start } = await subscribed(c, (id) => shiftCycle(id, 31));
    standIn.chargeSubscription(start.providerSubscriptionId);
    const swept = await sweepPlanStates(sweepDeps());
    expect(swept.failed.filter((f) => f.tenantId === c.tenantId)).toEqual([]);
    const sub = standIn.state.subscriptions.get(start.providerSubscriptionId)!;
    const state = await planState(c.tenantId);
    expect(state).toMatchObject({ status: 'active', grace_ends_at: null });
    expect(state.period_end?.getTime()).toBe(sub.currentEnd! * 1000);
    expect(await planPayments(c.tenantId)).toHaveLength(2);
  });

  it('leaves deleted companies out', async () => {
    offsetMs = 0;
    const c = await trialing();
    const start = await service().start(c.ctx);
    await adminQuery(
      `UPDATE app.plan_subscriptions SET authorize_by = now() - interval '1 minute' WHERE id = $1`,
      [start.subscriptionId],
    );
    await adminQuery(
      `UPDATE app.tenants SET status = 'deleted', name = 'Deleted company', slug = 'deleted-' || id
        WHERE id = $1`,
      [c.tenantId],
    );
    const listed = await adminQuery<{ subscription_id: string }>(
      'SELECT subscription_id FROM ops.plan_subscriptions_due(1000)',
    );
    expect(listed.map((r) => r.subscription_id)).not.toContain(start.subscriptionId);
    await sweepPlanSubscriptions(provider());
    expect((await subscriptionRow(start.subscriptionId)).status).toBe('created');
  });

  it('checks a subscription again after its cycle ended, so a missed event still counts', async () => {
    offsetMs = 0;
    const c = await trialing();
    const { start } = await subscribed(c);
    // Razorpay charged the next cycle; its events never arrived.
    standIn.chargeSubscription(start.providerSubscriptionId);
    await adminQuery(
      `UPDATE app.plan_subscriptions
          SET current_start = now() - interval '31 days', current_end = now() - interval '1 minute',
              synced_at = now() - interval '2 hours'
        WHERE id = $1`,
      [start.subscriptionId],
    );
    await sweepPlanSubscriptions(provider());
    expect(await planPayments(c.tenantId)).toHaveLength(2);
    const sub = standIn.state.subscriptions.get(start.providerSubscriptionId)!;
    expect((await planState(c.tenantId)).period_end?.getTime()).toBe(sub.currentEnd! * 1000);
  });
});
