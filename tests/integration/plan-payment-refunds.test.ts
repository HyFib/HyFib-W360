import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { Keyring, isAppError, uuidv7, type Clock, type RazorpayConfig } from '@w360/core';
import { authorizedTenantScope, sql } from '@w360/db';
import {
  JobSigner,
  PgBossJobQueue,
  RazorpayClient,
  createPlanAdminService,
  createPlanSubscriptionService,
  dayOf,
  failPlanPaymentRefund,
  findDuePlanPaymentRefunds,
  outboxAad,
  processPlanPaymentRefund,
  processRazorpayReceipt,
  resolveTenantContext,
  storeWebhookReceipt,
  type BillingNoticeDeps,
  type BillingProviderDeps,
  type PlatformActor,
  type TenantContext,
} from '@w360/domain';
import {
  connectTestDatabases,
  createTenant,
  createUser,
  type TestDatabases,
  type TestUser,
} from './helpers';
import { startRazorpayStandIn, type RazorpayStandIn } from '../support/razorpay-stand-in';

/**
 * Refunds of plan payments (P5-07, ADR-103) against real PostgreSQL and the test-only Razorpay
 * stand-in: platform owners' requests and their refusals, the worker's steps with the request's
 * idempotency key and notes, refunds made at Razorpay recorded from its webhooks, a lost response
 * recognised by its notes, failures, the cap on what is refunded, what the company and staff read,
 * and the roles' grants. A refund never changes the plan or the subscription.
 */
const KEY_ID = 'rzp_test_StandIn00000011';
const KEY_SECRET = randomBytes(16).toString('hex');
const REASON = 'Charged after the company asked to cancel, ticket 4242';

let dbs: TestDatabases;
let boss: PgBoss;
let standIn: RazorpayStandIn;
let razorpay: RazorpayClient;
let owner: PlatformActor;
let operator: PlatformActor;
const signer = new JobSigner(randomBytes(32).toString('hex'));
const keyring = new Keyring({ primaryKeyId: 'test', keys: { test: randomBytes(32) } });
const clock: Clock = { now: () => new Date() };
const DAY_MS = 86_400_000;

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
const subscriptions = () =>
  createPlanSubscriptionService({
    db: dbs.app,
    clock,
    razorpay,
    razorpayConfig: config(),
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

async function contextFor(user: TestUser, slug: string) {
  return resolveTenantContext(
    { db: dbs.app, clock, mfaGracePeriodHours: 72 },
    {
      userId: user.id,
      sessionId: `sess_${user.id}`,
      sessionCreatedAt: new Date(),
      tenantSlug: slug,
      correlationId: uuidv7(),
    },
  );
}

interface Paid {
  tenantId: string;
  slug: string;
  ctx: TenantContext;
  scope: ReturnType<typeof authorizedTenantScope>;
  /** HyFib's plan payment and Razorpay's payment and invoice for it. */
  planPaymentId: string;
  paymentId: string;
  invoiceId: string;
}

let codes = 0;
/**
 * A company that paid for its plan in Checkout: ₹999 with two extra seats at ₹100, plus 18% tax, is
 * ₹1,414.82 (ADR-063).
 */
async function paid(): Promise<Paid> {
  codes += 1;
  const { id: planId } = await admin().createPlan(owner, {
    code: `refund-${Date.now().toString(36)}-${codes}`,
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
  await admin().publishPlan(owner, planId);
  const user = await createUser(dbs, { name: 'Billing Owner' });
  const tenant = await createTenant(dbs, user);
  const view = await admin().tenantPlan(owner, tenant.id);
  await admin().setTenantPlan(owner, {
    tenantId: tenant.id,
    version: view.state.version,
    reason: 'Trial agreed on the sales call',
    status: 'trialing',
    planId,
    trialEndsOn: dayOf(new Date(Date.now() + 2 * DAY_MS), 'Asia/Kolkata'),
    extraSeats: '2',
  });
  const ctx = await contextFor(user, tenant.slug);
  const start = await subscriptions().start(ctx);
  const { response } = standIn.authorizeSubscription(start.providerSubscriptionId);
  await subscriptions().confirmCheckout(ctx, {
    subscriptionId: start.subscriptionId,
    paymentId: response.razorpay_payment_id,
    signature: createHmac('sha256', KEY_SECRET)
      .update(`${response.razorpay_payment_id}|${start.providerSubscriptionId}`)
      .digest('hex'),
  });
  const [payment] = await adminQuery<{
    id: string;
    provider_payment_id: string;
    provider_invoice_id: string;
    amount_minor: string;
  }>('SELECT * FROM app.plan_payments WHERE tenant_id = $1', [tenant.id]);
  expect(Number(payment!.amount_minor)).toBe(141_482);
  return {
    tenantId: tenant.id,
    slug: tenant.slug,
    ctx,
    scope: authorizedTenantScope(tenant.id, null),
    planPaymentId: payment!.id,
    paymentId: payment!.provider_payment_id,
    invoiceId: payment!.provider_invoice_id,
  };
}

const ask = (c: Paid, amount: string, reason = REASON) =>
  admin().requestPlanPaymentRefund(owner, {
    tenantId: c.tenantId,
    planPaymentId: c.planPaymentId,
    amount,
    reason,
  });

const step = (c: Paid, refundId: string) => processPlanPaymentRefund(provider(), c.scope, refundId);

/** Makes a request due again now, as the minute sweep would find it later. */
const dueNow = (refundId: string) =>
  adminQuery('UPDATE app.plan_payment_refunds SET next_attempt_at = now() WHERE id = $1', [
    refundId,
  ]);

async function refundRows(tenantId: string) {
  return adminQuery<{
    id: string;
    origin: string;
    status: string;
    amount_minor: number;
    reason: string | null;
    requested_by_user_id: string | null;
    provider_refund_id: string | null;
    attempts: number;
    last_error: string | null;
    processed_at: Date | null;
    failed_at: Date | null;
  }>(
    `SELECT id, origin, status, amount_minor::int AS amount_minor, reason, requested_by_user_id,
            provider_refund_id, attempts, last_error, processed_at, failed_at
       FROM app.plan_payment_refunds WHERE tenant_id = $1 ORDER BY requested_at, id`,
    [tenantId],
  );
}

const standInRefunds = (paymentId: string) =>
  [...standIn.state.refunds.values()].filter((r) => r.paymentId === paymentId);

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
        url: string;
      },
  );
}
/** The emails about refunds (the payment itself was emailed too). */
const refundEmails = async (tenantId: string) =>
  (await billingEmails(tenantId)).filter((e) => /refund/i.test(e.subject));

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

/** The database's own refusal (permission, row security, a check) of a statement. */
async function databaseRefusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    let current: unknown = error;
    while (current instanceof Error) {
      if (
        'code' in current &&
        typeof current.code === 'string' &&
        /^[0-9A-Z]{5}$/.test(current.code)
      ) {
        return current.message;
      }
      current = current.cause;
    }
    throw error;
  }
  throw new Error('expected the statement to be refused');
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
      eventId: `evt_r${eventSeq}_${randomBytes(4).toString('hex')}`,
    },
  );
  await processRazorpayReceipt({ ...provider(), keyring }, stored.receiptId);
  const [receipt] = await adminQuery<{ summary: Record<string, unknown> }>(
    'SELECT summary FROM ops.webhook_receipts WHERE id = $1',
    [stored.receiptId],
  );
  return receipt?.summary ?? {};
}

/**
 * A refund event naming the refund and its payment, with fields a forger might try (an amount, a
 * status, notes naming another request): only the ids are read, and the refund is fetched.
 */
const refundEvent = (paymentId: string, refundId: string, status: string) => ({
  refund: {
    entity: {
      id: refundId,
      payment_id: paymentId,
      amount: 1,
      status,
      notes: { hyfib_plan_refund: uuidv7() },
    },
  },
});

/** A refund made in the Razorpay Dashboard: HyFib is not told until its webhook or the report. */
async function dashboardRefund(paymentId: string, amount: number) {
  const refund = await razorpay.createRefund(paymentId, {
    amount,
    idempotencyKey: `dash_${randomBytes(6).toString('hex')}`,
  });
  if (!refund.ok) throw new Error(`stand-in refused the refund: ${refund.description}`);
  return refund.data;
}

async function planStateOf(tenantId: string) {
  const [row] = await adminQuery<{
    status: string;
    period_start: Date | null;
    period_end: Date | null;
    subscription_id: string | null;
  }>(
    'SELECT status, period_start, period_end, subscription_id FROM app.tenant_plans WHERE tenant_id = $1',
    [tenantId],
  );
  const [subscription] = await adminQuery<{ status: string; cancel_at_period_end: boolean }>(
    'SELECT status, cancel_at_period_end FROM app.plan_subscriptions WHERE tenant_id = $1',
    [tenantId],
  );
  return { ...row!, subscription: subscription! };
}

beforeAll(async () => {
  dbs = connectTestDatabases({ appPoolMax: 6 });
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
  await admin().setPlanTax(owner, { tax: '18', reason: 'GST on plan prices, ticket 9001' });
});

afterAll(async () => {
  await standIn.close();
  await boss.stop({ graceful: false });
  await dbs.close();
});

describe('refunds of plan payments started by platform owners (ADR-103)', () => {
  it('asks Razorpay once with the request’s key and notes, tells the company, and leaves the plan as it is', async () => {
    const c = await paid();
    const before = await planStateOf(c.tenantId);
    const { refundId } = await ask(c, '500');
    expect(await refundRows(c.tenantId)).toMatchObject([
      {
        id: refundId,
        origin: 'staff',
        status: 'requested',
        amount_minor: 50_000,
        reason: REASON,
        requested_by_user_id: owner.userId,
        provider_refund_id: null,
      },
    ]);
    const [requested] = await adminQuery<{
      actor_user_id: string;
      reason: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT actor_user_id, reason, metadata FROM ops.platform_audit_events
        WHERE action = 'platform.plan_payment_refund_requested' AND target_tenant_id = $1`,
      [c.tenantId],
    );
    expect(requested).toEqual({
      actor_user_id: owner.userId,
      reason: REASON,
      metadata: { refundId, planPaymentId: c.planPaymentId, amountMinor: 50_000 },
    });
    expect(await findDuePlanPaymentRefunds(dbs.app, 500)).toContainEqual({
      tenantId: c.tenantId,
      refundId,
    });
    // A second refund of the payment waits for this one.
    expect(await refusal(ask(c, '100'))).toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/already in progress/),
    });

    // Razorpay accepts it as a normal refund, which it processes later.
    standIn.state.refundStatusOnCreate = 'pending';
    try {
      expect(await step(c, refundId)).toBe('submitted');
    } finally {
      standIn.state.refundStatusOnCreate = 'processed';
    }
    const [atRazorpay] = standInRefunds(c.paymentId);
    expect(atRazorpay).toMatchObject({
      amount: 50_000,
      status: 'pending',
      idempotencyKey: `ppr_${refundId}`,
      notes: { hyfib_plan_refund: refundId },
    });
    expect(await refundRows(c.tenantId)).toMatchObject([
      { status: 'submitted', provider_refund_id: atRazorpay!.id, attempts: 1 },
    ]);
    expect(await audits(c.tenantId, 'billing.plan_payment_refund_submitted')).toEqual([
      {
        actor_type: 'provider',
        actor_id: 'razorpay',
        metadata: {
          planPaymentId: c.planPaymentId,
          amountMinor: 50_000,
          providerRefundId: atRazorpay!.id,
        },
      },
    ]);
    const [told] = await refundEmails(c.tenantId);
    expect(told!.subject).toBe('HyFib is refunding a plan payment');
    expect(told!.lines[0]).toContain(`₹500.00 of your plan payment ${c.invoiceId}`);
    expect(told!.lines[0]).toMatch(/5–7 working days/);
    expect(told!.lines[1]).toBe('Your plan and its paid period do not change.');
    expect(told!.url).toBe(
      `http://localhost:3000/c/${c.slug}/billing/plan-payments/${c.planPaymentId}`,
    );
    // The reason and who asked stay with HyFib.
    expect(JSON.stringify(told)).not.toContain('ticket 4242');

    // Not due again until its first check, 15 minutes later; staff see it in progress.
    expect(await findDuePlanPaymentRefunds(dbs.app, 500)).not.toContainEqual({
      tenantId: c.tenantId,
      refundId,
    });
    expect((await admin().tenantPlan(owner, c.tenantId)).payments[0]).toMatchObject({
      refundedMinor: 0,
      openRefundMinor: 50_000,
    });

    // Checked while Razorpay processes it: nothing changes, and it is not asked for twice.
    await dueNow(refundId);
    expect(await step(c, refundId)).toBe('pending');
    expect(standInRefunds(c.paymentId)).toHaveLength(1);
    const overview = await subscriptions().overview(c.ctx);
    expect(overview.payments[0]).toMatchObject({ refundedMinor: 0, openRefundMinor: 50_000 });
    expect((await subscriptions().receipt(c.ctx, c.planPaymentId)).refunds).toMatchObject([
      { amountMinor: 50_000, status: 'submitted', origin: 'staff', processedAt: null },
    ]);

    // Razorpay completes it: recorded once, and the plan and subscription are as they were.
    standIn.setRefundStatus(atRazorpay!.id, 'processed');
    await dueNow(refundId);
    expect(await step(c, refundId)).toBe('processed');
    expect(await step(c, refundId)).toBe('done');
    expect(await refundRows(c.tenantId)).toMatchObject([
      { status: 'processed', processed_at: expect.any(Date) },
    ]);
    expect(await audits(c.tenantId, 'billing.plan_payment_refund_processed')).toEqual([
      {
        actor_type: 'provider',
        actor_id: 'razorpay',
        metadata: {
          planPaymentId: c.planPaymentId,
          origin: 'staff',
          amountMinor: 50_000,
          providerRefundId: atRazorpay!.id,
        },
      },
    ]);
    expect((await subscriptions().overview(c.ctx)).payments[0]).toMatchObject({
      refundedMinor: 50_000,
      openRefundMinor: null,
    });
    const receipt = await subscriptions().receipt(c.ctx, c.planPaymentId);
    expect(receipt).toMatchObject({ amountMinor: 141_482, refundedMinor: 50_000 });
    expect(await planStateOf(c.tenantId)).toEqual(before);

    // What is left can be refunded, and not a paisa more.
    expect(await refusal(ask(c, '914.83'))).toMatchObject({
      code: 'precondition_failed',
      message: expect.stringMatching(/at most what is left/),
    });
    const { refundId: rest } = await ask(c, '914.82');
    expect(await step(c, rest)).toBe('processed');
    expect((await subscriptions().receipt(c.ctx, c.planPaymentId)).refundedMinor).toBe(141_482);
    expect(await refusal(ask(c, '0.01'))).toMatchObject({ code: 'precondition_failed' });
    expect(await refundEmails(c.tenantId)).toHaveLength(2);
    expect(await planStateOf(c.tenantId)).toEqual(before);

    // Platform staff see both, with the reason and who asked.
    const view = await admin().tenantPlan(owner, c.tenantId);
    expect(view.payments[0]).toMatchObject({ refundedMinor: 141_482, openRefundMinor: null });
    expect(view.refunds).toHaveLength(2);
    expect(view.refunds.every((r) => r.reason === REASON && r.requestedByName !== null)).toBe(true);
  });

  it('refuses operators, short reasons, bad amounts, another company’s payment and a company being deleted', async () => {
    const c = await paid();
    const other = await paid();
    expect(
      await refusal(
        admin().requestPlanPaymentRefund(operator, {
          tenantId: c.tenantId,
          planPaymentId: c.planPaymentId,
          amount: '100',
          reason: REASON,
        }),
      ),
    ).toMatchObject({ code: 'forbidden' });
    // The function checks the role itself, whoever calls it.
    const direct = (actor: PlatformActor, reason: string, amount = 10_000) =>
      dbs.platform.run(actor.userId, (tx) =>
        tx.execute(
          sql`select ops.platform_request_plan_payment_refund(${c.tenantId}::uuid,
                ${c.planPaymentId}::uuid, ${amount}::bigint, ${reason}, 'test')`,
        ),
      );
    expect(await refusal(direct(operator, REASON))).toMatchObject({ code: 'forbidden' });
    expect(await refusal(direct(owner, 'too short'))).toMatchObject({
      code: 'precondition_failed',
    });
    expect(await refusal(direct(owner, REASON, 0))).toMatchObject({ code: 'precondition_failed' });
    expect(await refusal(ask(c, '100', 'short'))).toMatchObject({ code: 'validation_failed' });
    for (const amount of ['abc', '0', '-5', '1.234']) {
      expect(await refusal(ask(c, amount)), amount).toMatchObject({ code: 'validation_failed' });
    }
    expect(await refusal(ask(c, '1414.83'))).toMatchObject({ code: 'precondition_failed' });
    // Another company's payment is not found under this company, and an unknown company neither.
    expect(
      await refusal(
        admin().requestPlanPaymentRefund(owner, {
          tenantId: other.tenantId,
          planPaymentId: c.planPaymentId,
          amount: '100',
          reason: REASON,
        }),
      ),
    ).toMatchObject({ code: 'not_found' });
    expect(
      await refusal(
        admin().requestPlanPaymentRefund(owner, {
          tenantId: uuidv7(),
          planPaymentId: c.planPaymentId,
          amount: '100',
          reason: REASON,
        }),
      ),
    ).toMatchObject({ code: 'not_found' });
    // A company being deleted is refunded in the Dashboard instead.
    await adminQuery(`UPDATE app.tenants SET status = 'pending_deletion' WHERE id = $1`, [
      c.tenantId,
    ]);
    expect(await refusal(ask(c, '100'))).toMatchObject({
      code: 'precondition_failed',
      message: expect.stringMatching(/being deleted/),
    });
    await adminQuery(`UPDATE app.tenants SET status = 'active' WHERE id = $1`, [c.tenantId]);
    expect(await refundRows(c.tenantId)).toEqual([]);
    expect(await refundRows(other.tenantId)).toEqual([]);
    // Nobody else reaches the request function, and platform staff never record a refund.
    const can = async (role: string, fn: string) =>
      (
        await adminQuery<{ ok: boolean }>(
          `SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`,
          [role, fn],
        )
      )[0]!.ok;
    const request = 'ops.platform_request_plan_payment_refund(uuid,uuid,bigint,text,text)';
    const record = 'app.record_plan_payment_refund(text,text,bigint,uuid)';
    expect(await can('w360_platform', request)).toBe(true);
    expect(await can('w360_app', request)).toBe(false);
    expect(await can('w360_app', record)).toBe(true);
    expect(await can('w360_platform', record)).toBe(false);
    expect(await can('w360_app', 'ops.plan_payment_refunds_due(integer)')).toBe(true);
    expect(await can('w360_platform', 'ops.plan_payment_refunds_due(integer)')).toBe(false);
  });

  it('records refunds made at Razorpay from their webhook once, and fails only HyFib’s own when Razorpay fails one', async () => {
    const c = await paid();
    // A refund made in the Dashboard: the event carries a forged amount and notes, the refund
    // fetched from Razorpay is recorded.
    const dashboard = await dashboardRefund(c.paymentId, 20_000);
    expect(
      await deliver('refund.processed', refundEvent(c.paymentId, dashboard.id, 'processed')),
    ).toMatchObject({ result: 'recorded' });
    expect(await refundRows(c.tenantId)).toMatchObject([
      {
        origin: 'razorpay',
        status: 'processed',
        amount_minor: 20_000,
        reason: null,
        requested_by_user_id: null,
        provider_refund_id: dashboard.id,
      },
    ]);
    expect(
      await deliver('refund.processed', refundEvent(c.paymentId, dashboard.id, 'processed')),
    ).toMatchObject({ result: 'already_recorded' });
    expect(await refundRows(c.tenantId)).toHaveLength(1);
    expect(await audits(c.tenantId, 'billing.plan_payment_refund_processed')).toMatchObject([
      { metadata: { origin: 'razorpay', amountMinor: 20_000, providerRefundId: dashboard.id } },
    ]);
    expect(await refundEmails(c.tenantId)).toEqual([]);
    expect((await subscriptions().receipt(c.ctx, c.planPaymentId)).refunds).toMatchObject([
      { amountMinor: 20_000, status: 'processed', origin: 'razorpay' },
    ]);
    // What a platform owner can refund now counts it.
    expect(await refusal(ask(c, '1214.83'))).toMatchObject({ code: 'precondition_failed' });

    // HyFib's own refund, which Razorpay then fails.
    const { refundId } = await ask(c, '100');
    standIn.state.refundStatusOnCreate = 'pending';
    try {
      expect(await step(c, refundId)).toBe('submitted');
    } finally {
      standIn.state.refundStatusOnCreate = 'processed';
    }
    const ours = standInRefunds(c.paymentId).find((r) => r.idempotencyKey === `ppr_${refundId}`)!;
    standIn.setRefundStatus(ours.id, 'failed');
    expect(
      await deliver('refund.failed', refundEvent(c.paymentId, ours.id, 'failed')),
    ).toMatchObject({ result: 'plan_refund_failed' });
    expect((await refundRows(c.tenantId))[1]).toMatchObject({
      id: refundId,
      status: 'failed',
      last_error: 'failed: Razorpay failed the refund',
      failed_at: expect.any(Date),
    });
    expect(await audits(c.tenantId, 'billing.plan_payment_refund_failed')).toHaveLength(1);
    const emails = await refundEmails(c.tenantId);
    expect(emails.map((e) => e.subject)).toEqual([
      'HyFib is refunding a plan payment',
      'A refund could not be completed',
    ]);
    expect(emails[1]!.lines[0]).toContain(`₹100.00 of your plan payment ${c.invoiceId}`);
    // Told once: the failure again changes nothing.
    expect(
      await deliver('refund.failed', refundEvent(c.paymentId, ours.id, 'failed')),
    ).toMatchObject({ result: 'already_settled' });
    expect(await refundEmails(c.tenantId)).toHaveLength(2);
    // The failed refund is not shown on the receipt, and another can be asked for.
    expect((await subscriptions().receipt(c.ctx, c.planPaymentId)).refunds).toHaveLength(1);
    const { refundId: again } = await ask(c, '100');
    expect(await step(c, again)).toBe('processed');

    // A failed refund nobody asked for through HyFib changes nothing.
    standIn.state.refundStatusOnCreate = 'pending';
    const failedDashboard = await dashboardRefund(c.paymentId, 5_000).finally(() => {
      standIn.state.refundStatusOnCreate = 'processed';
    });
    standIn.setRefundStatus(failedDashboard.id, 'failed');
    expect(
      await deliver('refund.failed', refundEvent(c.paymentId, failedDashboard.id, 'failed')),
    ).toMatchObject({ result: 'refund_failed_not_requested' });
    expect(await refundRows(c.tenantId)).toHaveLength(3);
  });

  it('recognises a refund whose response was lost by its notes, and never asks Razorpay twice', async () => {
    const c = await paid();
    // The refund is made, then the connection drops: HyFib does not know its id.
    const { refundId } = await ask(c, '300');
    standIn.state.queues.refund.push({ kind: 'process_then_drop' });
    expect(await step(c, refundId)).toBe('retry');
    expect(await refundRows(c.tenantId)).toMatchObject([
      { status: 'requested', provider_refund_id: null, attempts: 1 },
    ]);
    const [made] = standInRefunds(c.paymentId);
    expect(made).toMatchObject({ status: 'processed', notes: { hyfib_plan_refund: refundId } });
    // Its webhook comes first: the notes name the request, which it completes.
    expect(
      await deliver('refund.processed', refundEvent(c.paymentId, made!.id, 'processed')),
    ).toMatchObject({ result: 'recorded' });
    expect(await refundRows(c.tenantId)).toMatchObject([
      { id: refundId, origin: 'staff', status: 'processed', provider_refund_id: made!.id },
    ]);
    await dueNow(refundId);
    expect(await step(c, refundId)).toBe('done');
    expect(standInRefunds(c.paymentId)).toHaveLength(1);

    // Without the webhook, the next try sends the same key and gets the same refund back.
    const { refundId: second } = await ask(c, '200');
    standIn.state.queues.refund.push({ kind: 'process_then_drop' });
    expect(await step(c, second)).toBe('retry');
    await dueNow(second);
    expect(await step(c, second)).toBe('processed');
    expect(standInRefunds(c.paymentId)).toHaveLength(2);
    expect(await refundRows(c.tenantId)).toMatchObject([
      { status: 'processed' },
      { id: second, status: 'processed', attempts: 2 },
    ]);
    expect(await audits(c.tenantId, 'billing.plan_payment_refund_processed')).toHaveLength(2);

    // 409: a call with this key is still being processed (R-086), so the request waits.
    const { refundId: third } = await ask(c, '50');
    standIn.state.queues.refund.push({
      kind: 'error',
      status: 409,
      code: 'BAD_REQUEST_ERROR',
      description: 'A request with this idempotency key is being processed',
    });
    expect(await step(c, third)).toBe('retry');
    expect((await refundRows(c.tenantId))[2]).toMatchObject({
      id: third,
      status: 'requested',
      provider_refund_id: null,
    });
    // A refund whose notes name the request but for another amount is not the request's: it is
    // recorded as made at Razorpay, and the request goes on.
    const other = await razorpay.createRefund(c.paymentId, {
      amount: 700,
      idempotencyKey: `dash_${randomBytes(6).toString('hex')}`,
      notes: { hyfib_plan_refund: third },
    });
    if (!other.ok) throw new Error('stand-in refused the refund');
    expect(
      await deliver('refund.processed', refundEvent(c.paymentId, other.data.id, 'processed')),
    ).toMatchObject({ result: 'recorded' });
    const rows = await refundRows(c.tenantId);
    expect(rows[2]).toMatchObject({ id: third, status: 'requested', provider_refund_id: null });
    expect(rows[3]).toMatchObject({
      origin: 'razorpay',
      amount_minor: 700,
      provider_refund_id: other.data.id,
    });
    await dueNow(third);
    expect(await step(c, third)).toBe('processed');
    expect((await refundRows(c.tenantId))[2]).toMatchObject({ id: third, status: 'processed' });
  });

  it('never records more than the payment, and fails a refund Razorpay refuses', async () => {
    const c = await paid();
    // Recording is capped whoever reports the refund.
    expect(
      await refusal(
        dbs.app.run(c.scope, (tx) =>
          tx.execute(
            sql`select app.record_plan_payment_refund(${c.paymentId}, 'rfnd_TooMuch0000001',
                  141483::bigint, null::uuid)`,
          ),
        ),
      ),
    ).toMatchObject({ code: 'precondition_failed' });
    expect(await refundRows(c.tenantId)).toEqual([]);
    // A refund made in the Dashboard that HyFib has not heard of yet leaves nothing at Razorpay:
    // Razorpay refuses HyFib's refund, which fails and is emailed.
    const all = await dashboardRefund(c.paymentId, 141_482);
    const { refundId } = await ask(c, '100');
    expect(await step(c, refundId)).toBe('failed');
    expect(await refundRows(c.tenantId)).toMatchObject([
      {
        status: 'failed',
        last_error: 'BAD_REQUEST_ERROR: The payment has been fully refunded already',
      },
    ]);
    expect((await refundEmails(c.tenantId)).map((e) => e.subject)).toEqual([
      'A refund could not be completed',
    ]);
    expect(await step(c, refundId)).toBe('done');
    // A failure after the refund was recorded changes nothing.
    expect(await failPlanPaymentRefund(provider(), c.scope, refundId, 'late')).toBe('done');
    // The Dashboard refund is then recorded in full.
    expect(
      await deliver('refund.processed', refundEvent(c.paymentId, all.id, 'processed')),
    ).toMatchObject({ result: 'recorded' });
    expect((await subscriptions().receipt(c.ctx, c.planPaymentId)).refundedMinor).toBe(141_482);
    // Another company's scope cannot record a refund of this payment.
    const other = await paid();
    expect(
      await refusal(
        dbs.app.run(other.scope, (tx) =>
          tx.execute(
            sql`select app.record_plan_payment_refund(${c.paymentId}, 'rfnd_OtherCompany01',
                  100::bigint, null::uuid)`,
          ),
        ),
      ),
    ).toMatchObject({ code: 'not_found' });
    expect(await refundRows(other.tenantId)).toEqual([]);
  });
});

describe('what each role may do with refunds of plan payments', () => {
  it('lets the company read its refunds without the reason, never mark one processed, and hides them from others', async () => {
    const c = await paid();
    const { refundId } = await ask(c, '250');
    const statement = (s: ReturnType<typeof sql>) =>
      databaseRefusal(dbs.app.run(c.scope, (tx) => tx.execute(s)));
    const rows = await dbs.app.run(c.scope, (tx) =>
      tx.execute<{ id: string; status: string }>(
        sql`select id, status from app.plan_payment_refunds where id = ${refundId}::uuid`,
      ),
    );
    expect(rows.rows).toEqual([{ id: refundId, status: 'requested' }]);
    for (const column of ['reason', 'requested_by_user_id']) {
      expect(
        await statement(
          sql`select ${sql.raw(column)} from app.plan_payment_refunds where id = ${refundId}::uuid`,
        ),
      ).toMatch(/permission denied/);
    }
    // Processed only through the definer function; amounts and origins never.
    expect(
      await statement(
        sql`update app.plan_payment_refunds set status = 'processed' where id = ${refundId}::uuid`,
      ),
    ).toMatch(/row-level security/);
    for (const change of ['amount_minor = 1', `origin = 'razorpay'`, 'processed_at = now()']) {
      expect(
        await statement(
          sql`update app.plan_payment_refunds set ${sql.raw(change)} where id = ${refundId}::uuid`,
        ),
        change,
      ).toMatch(/permission denied/);
    }
    expect(
      await statement(sql`delete from app.plan_payment_refunds where id = ${refundId}::uuid`),
    ).toMatch(/permission denied/);
    expect(
      await statement(
        sql`insert into app.plan_payment_refunds (id, tenant_id, plan_payment_id, origin, amount_minor,
              status, provider_refund_id, processed_at)
            values (${uuidv7()}::uuid, ${c.tenantId}::uuid, ${c.planPaymentId}::uuid, 'razorpay', 100,
              'processed', 'rfnd_Forged00000001', now())`,
      ),
    ).toMatch(/permission denied/);
    // The worker may fail an open request, and cannot touch it afterwards.
    await dbs.app.run(c.scope, (tx) =>
      tx.execute(
        sql`update app.plan_payment_refunds set status = 'failed', failed_at = now()
             where id = ${refundId}::uuid`,
      ),
    );
    const reopened = await dbs.app.run(c.scope, (tx) =>
      tx.execute(
        sql`update app.plan_payment_refunds set status = 'requested' where id = ${refundId}::uuid`,
      ),
    );
    expect(reopened.rowCount).toBe(0);
    expect(await refundRows(c.tenantId)).toMatchObject([
      { status: 'failed', amount_minor: 25_000 },
    ]);

    // Another company sees nothing and cannot act on it.
    const other = await paid();
    const seen = await dbs.app.run(other.scope, (tx) =>
      tx.execute(sql`select id from app.plan_payment_refunds where id = ${refundId}::uuid`),
    );
    expect(seen.rows).toEqual([]);
    expect(await step(other, refundId)).toBe('not_found');
    expect(await failPlanPaymentRefund(provider(), other.scope, refundId, 'forged')).toBe('done');
    // Nobody deletes a refund, not even the table's owner.
    expect(
      await databaseRefusal(
        dbs.adminPool.query('DELETE FROM app.plan_payment_refunds WHERE id = $1', [refundId]),
      ),
    ).toMatch(/append-only/);
  });

  it('keeps each origin’s fields and a processed refund’s id and time', async () => {
    const c = await paid();
    const insert = (values: string) =>
      databaseRefusal(
        dbs.adminPool.query(
          `INSERT INTO app.plan_payment_refunds (id, tenant_id, plan_payment_id, origin, amount_minor,
             status, reason, requested_by_user_id, provider_refund_id, processed_at)
           VALUES (gen_random_uuid(), $1, $2, ${values})`,
          [c.tenantId, c.planPaymentId],
        ),
      );
    // Made at Razorpay: processed, with no reason or requester.
    expect(
      await insert(
        `'razorpay', 100, 'processed', 'Some reason text', NULL, 'rfnd_Check0000000001', now()`,
      ),
    ).toMatch(/plan_payment_refunds_origin_fields/);
    expect(await insert(`'razorpay', 100, 'requested', NULL, NULL, NULL, NULL`)).toMatch(
      /plan_payment_refunds_origin_fields/,
    );
    // Asked for by staff: with a reason and who asked.
    expect(await insert(`'staff', 100, 'requested', NULL, NULL, NULL, NULL`)).toMatch(
      /plan_payment_refunds_origin_fields/,
    );
    // Processed means Razorpay's refund id and when.
    expect(await insert(`'razorpay', 100, 'processed', NULL, NULL, NULL, now()`)).toMatch(
      /plan_payment_refunds_has_refund/,
    );
    expect(
      await insert(`'razorpay', 100, 'processed', NULL, NULL, 'rfnd_Check0000000002', NULL`),
    ).toMatch(/plan_payment_refunds_processed_at/);
    expect(await refundRows(c.tenantId)).toEqual([]);
  });
});
