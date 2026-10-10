import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { PgBoss } from 'pg-boss';
import { Keyring, isAppError, uuidv7, type Clock, type RazorpayConfig } from '@w360/core';
import { authorizedTenantScope, sql, type TenantScope } from '@w360/db';
import {
  JobSigner,
  PgBossJobQueue,
  PLATFORM_REFUNDS_PAGE,
  RECENT_SIGN_IN_MINUTES,
  REFUND_REQUEST_LIMITS,
  RazorpayClient,
  announceRefundRequests,
  createBillingService,
  createPlanAdminService,
  createPlanRefundRequestsService,
  createPlanSubscriptionService,
  createPlatformBillingService,
  createRefundRequestsService,
  dayOf,
  failPlanPaymentRefund,
  notifyRefundRequestDeclines,
  outboxAad,
  processPlanPaymentRefund,
  processRazorpayReceipt,
  refundRequestsAnnouncement,
  resolveTenantContext,
  storeWebhookReceipt,
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
 * Refunds of plan payments asked for by companies (P5-07, ADR-104) against real PostgreSQL and the
 * test-only Razorpay stand-in: who may ask and what, one daily limit with requests of service credit
 * (also under concurrency and the same lock), withdrawing, a platform owner's decision (approving
 * starts the staff refund of ADR-103 with every check run again; declining needs a note), the emails
 * to platform owners and billing managers (once each), the platform lists of requests and of every
 * refund of a plan payment on exact keyset pages, and what the company's database role can and
 * cannot do. A request never moves money or changes the plan.
 */
const KEY_ID = 'rzp_test_StandIn00000081';
const KEY_SECRET = randomBytes(16).toString('hex');
const REASON = 'We were charged for a month after we asked to cancel the plan.';
const NOTE = 'The charge was for the month you used; see the terms, ticket 4411.';
const APP_BASE = 'http://localhost:3000';
const DAY_MS = 86_400_000;

let dbs: TestDatabases;
let boss: PgBoss;
let standIn: RazorpayStandIn;
let razorpay: RazorpayClient;
let owner: PlatformActor;
let operator: PlatformActor;
const signer = new JobSigner(randomBytes(32).toString('hex'));
const keyring = new Keyring({ primaryKeyId: 'test', keys: { test: randomBytes(32) } });
const clock: Clock = { now: () => new Date() };

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
  return { outbox: { keyring, jobs: new PgBossJobQueue(boss), signer }, appBaseUrl: APP_BASE };
}
const subscriptions = () =>
  createPlanSubscriptionService({
    db: dbs.app,
    clock,
    razorpay,
    razorpayConfig: config(),
    notices: notices(),
  });
const billing = () =>
  createBillingService({
    db: dbs.app,
    clock,
    razorpay,
    razorpayConfig: config(),
    notices: notices(),
  });
const provider = (): BillingProviderDeps => ({ db: dbs.app, razorpay, clock, notices: notices() });
const admin = () => createPlanAdminService({ platformDb: dbs.platform, clock, razorpay });
const requests = () => createPlanRefundRequestsService({ db: dbs.app, clock });
const creditRequests = () => createRefundRequestsService({ db: dbs.app, clock });
const staff = () => createPlatformBillingService({ platformDb: dbs.platform });
const announce = () =>
  announceRefundRequests({ db: dbs.app, outbox: notices().outbox, appBaseUrl: APP_BASE });
const tellDeclines = () => notifyRefundRequestDeclines({ db: dbs.app, notices: notices() });

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

interface Paid {
  tenant: TestTenant;
  tenantId: string;
  slug: string;
  owner: TestUser;
  ctx: TenantContext;
  scope: TenantScope;
  /** HyFib's plan payment and Razorpay's payment and invoice (the receipt number) for it. */
  planPaymentId: string;
  paymentId: string;
  invoiceId: string;
}

/** A member's context as a browser session that started `minutesAgo` minutes ago. */
function signedIn(c: Pick<Paid, 'slug'>, user: TestUser, minutesAgo: number | null = 0) {
  return resolveTenantContext(
    { db: dbs.app, clock, mfaGracePeriodHours: 72 },
    {
      userId: user.id,
      sessionId: `sess_${user.id}`,
      sessionCreatedAt: minutesAgo === null ? null : new Date(Date.now() - minutesAgo * 60_000),
      tenantSlug: c.slug,
      correlationId: uuidv7(),
    },
  );
}

let codes = 0;
/**
 * A company that paid for its plan in Checkout: ₹999 with two extra seats at ₹100, plus 18% tax, is
 * ₹1,414.82 (ADR-063).
 */
async function paid(): Promise<Paid> {
  codes += 1;
  const { id: planId } = await admin().createPlan(owner, {
    code: `asks-${Date.now().toString(36)}-${codes}`,
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
  const user = await createUser(dbs, { name: 'Plan Refund Owner' });
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
  const ctx = await signedIn(tenant, user);
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
    tenant,
    tenantId: tenant.id,
    slug: tenant.slug,
    owner: user,
    ctx,
    scope: authorizedTenantScope(tenant.id, null),
    planPaymentId: payment!.id,
    paymentId: payment!.provider_payment_id,
    invoiceId: payment!.provider_invoice_id,
  };
}

async function member(c: Paid, role: string, name: string): Promise<TestUser> {
  const user = await createUser(dbs, { name });
  const { token } = await invite(dbs, c.tenant, c.owner, user.email, [role]);
  await acceptInvitation(dbs, user, token);
  return user;
}

const ask = (
  c: Paid,
  amount: string,
  ctx: TenantContext = c.ctx,
  planPaymentId: string = c.planPaymentId,
) => requests().ask(ctx, { planPaymentId, amount, reason: REASON });

const decide = (
  actor: PlatformActor,
  requestId: string,
  decision: 'approve' | 'decline',
  note?: string,
) => staff().decidePlanRefundRequest(actor, { requestId, decision, note });

/** A paid top-up of service credit through the real path: order, Checkout payment, confirmation. */
async function paidTopup(c: Paid, amountMinor: number) {
  const topup = await billing().startTopup(c.ctx, { amountMinor });
  const payment = standIn.pay(topup.orderId);
  await billing().confirmTopupCheckout(c.ctx, {
    topupId: topup.topupId,
    paymentId: payment.id,
    signature: createHmac('sha256', KEY_SECRET)
      .update(`${topup.orderId}|${payment.id}`)
      .digest('hex'),
  });
  return topup.topupId;
}

/** A request for a refund of unused service credit (ADR-073), which shares the daily limit. */
const askForCredit = (c: Paid, topupId: string, amount = '1') =>
  creditRequests().ask(c.ctx, { topupId, amount, reason: REASON });

/** A platform owner's refund of the plan payment (ADR-103), as from the company's page. */
const staffRefund = (c: Paid, amount: string, reason = 'Charged twice by mistake, ticket 5152') =>
  admin().requestPlanPaymentRefund(owner, {
    tenantId: c.tenantId,
    planPaymentId: c.planPaymentId,
    amount,
    reason,
  });

const step = (c: Paid, refundId: string) => processPlanPaymentRefund(provider(), c.scope, refundId);

async function requestRow(id: string) {
  const [row] = await adminQuery<{
    status: string;
    amount_minor: number;
    plan_payment_id: string;
    reason: string;
    requested_by_user_id: string;
    withdrawn_at: Date | null;
    decided_by_user_id: string | null;
    decided_at: Date | null;
    decision_note: string | null;
    plan_payment_refund_id: string | null;
    announced_at: Date | null;
    decline_notified_at: Date | null;
  }>(
    `SELECT status, amount_minor::int AS amount_minor, plan_payment_id, reason, requested_by_user_id,
            withdrawn_at, decided_by_user_id, decided_at, decision_note, plan_payment_refund_id,
            announced_at, decline_notified_at
       FROM app.plan_payment_refund_requests WHERE id = $1`,
    [id],
  );
  return row!;
}

const requestsOf = (tenantIds: string[]) =>
  adminQuery<{ id: string; status: string }>(
    `SELECT id, status FROM app.plan_payment_refund_requests WHERE tenant_id = ANY($1::uuid[])
      ORDER BY requested_at, id`,
    [tenantIds],
  );

async function refundRows(tenantId: string) {
  return adminQuery<{
    id: string;
    origin: string;
    status: string;
    amount_minor: number;
    reason: string | null;
    requested_by_user_id: string | null;
    provider_refund_id: string | null;
  }>(
    `SELECT id, origin, status, amount_minor::int AS amount_minor, reason, requested_by_user_id,
            provider_refund_id
       FROM app.plan_payment_refunds WHERE tenant_id = $1 ORDER BY requested_at, id`,
    [tenantId],
  );
}

const standInRefunds = (paymentId: string) =>
  [...standIn.state.refunds.values()].filter((r) => r.paymentId === paymentId);

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

async function companyAudit(tenantId: string, action: string) {
  return adminQuery<{
    subject_id: string;
    actor_type: string;
    actor_id: string;
    metadata: unknown;
  }>(
    `SELECT subject_id, actor_type, actor_id, metadata FROM app.audit_events
      WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at`,
    [tenantId, action],
  );
}

async function platformAudit(tenantId: string, action: string) {
  return adminQuery<{
    actor_user_id: string;
    reason: string | null;
    result: string;
    correlation_id: string;
    metadata: unknown;
  }>(
    `SELECT actor_user_id, reason, result, correlation_id, metadata FROM ops.platform_audit_events
      WHERE target_tenant_id = $1 AND action = $2 ORDER BY occurred_at`,
    [tenantId, action],
  );
}

const dbNow = async () => (await adminQuery<{ now: Date }>('SELECT now() AS now'))[0]!.now;

const ownerEmails = async () =>
  (
    await adminQuery<{ email: string }>(
      `SELECT u.email FROM ops.platform_admins a JOIN auth.users u ON u.id = a.user_id
        WHERE a.role = 'platform_owner'`,
    )
  )
    .map((r) => r.email)
    .sort();

/** Platform notices queued since `since`, decrypted. */
async function platformNotices(since: Date) {
  const rows = await adminQuery<{
    id: string;
    tenant_id: string | null;
    to_address: string;
    payload_ciphertext: string;
  }>(
    `SELECT id, tenant_id, to_address, payload_ciphertext FROM ops.email_outbox
      WHERE kind = 'platform.notice' AND created_at >= $1 ORDER BY id`,
    [since],
  );
  return rows.map((r) => ({
    to: r.to_address,
    tenantId: r.tenant_id,
    payload: JSON.parse(keyring.decryptString(r.payload_ciphertext, outboxAad(r.id))) as unknown,
  }));
}

/** The company's billing emails with a subject (all of them without one), decrypted. */
async function billingEmails(tenantId: string, subject?: string) {
  const rows = await adminQuery<{ id: string; to_address: string; payload_ciphertext: string }>(
    `SELECT id, to_address, payload_ciphertext FROM ops.email_outbox
      WHERE tenant_id = $1 AND kind = 'billing.notice' ORDER BY id`,
    [tenantId],
  );
  return rows
    .map((r) => ({
      to: r.to_address,
      ...(JSON.parse(keyring.decryptString(r.payload_ciphertext, outboxAad(r.id))) as {
        subject: string;
        lines: string[];
        url: string;
      }),
    }))
    .filter((e) => subject === undefined || e.subject === subject);
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return { code: error.code, message: error.publicMessage };
    throw error;
  }
  throw new Error('expected the call to be refused');
}

const refused = async (promise: Promise<unknown>) => (await refusal(promise)).code;

/** The PostgreSQL message behind a mapped error. */
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
      eventId: `evt_q${eventSeq}_${randomBytes(4).toString('hex')}`,
    },
  );
  await processRazorpayReceipt({ ...provider(), keyring }, stored.receiptId);
  const [receipt] = await adminQuery<{ summary: Record<string, unknown> }>(
    'SELECT summary FROM ops.webhook_receipts WHERE id = $1',
    [stored.receiptId],
  );
  return receipt?.summary ?? {};
}

/** A refund made in the Razorpay Dashboard, recorded from its webhook (ADR-103). */
async function refundAtRazorpay(paymentId: string, amount: number) {
  const refund = await razorpay.createRefund(paymentId, {
    amount,
    idempotencyKey: `dash_${randomBytes(6).toString('hex')}`,
  });
  if (!refund.ok) throw new Error(`stand-in refused the refund: ${refund.description}`);
  expect(
    await deliver('refund.processed', {
      refund: { entity: { id: refund.data.id, payment_id: paymentId, status: 'processed' } },
    }),
  ).toMatchObject({ result: 'recorded' });
  return refund.data;
}

beforeAll(async () => {
  dbs = connectTestDatabases({ appPoolMax: 10 });
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
  owner = await platformActor('platform_owner', 'Plan Refund Deciding Owner');
  operator = await platformActor('platform_operator', 'Plan Refund Reading Operator');
  await admin().setPlanTax(owner, { tax: '18', reason: 'GST on plan prices, ticket 9001' });
});

afterAll(async () => {
  await standIn.close();
  await boss.stop({ graceful: false });
  await dbs.close();
});

describe('asking for a refund of a plan payment', () => {
  it('lets a billing manager ask for part of a payment with a reason: nothing moves and the plan stays; it is audited and shown to the company and platform staff', async () => {
    const c = await paid();
    const before = await planStateOf(c.tenantId);
    const billingUser = await member(c, 'billing', 'Billing Person');
    const manager = await signedIn(c, billingUser);
    expect(await requests().forPlanPayment(manager, c.planPaymentId)).toEqual({
      requests: [],
      askable: { maxMinor: 141_482, reason: null },
    });

    const { requestId } = await requests().ask(manager, {
      planPaymentId: c.planPaymentId,
      amount: ' 500.50 ',
      reason: `  ${REASON}  `,
    });
    expect(await requestRow(requestId)).toEqual({
      status: 'open',
      amount_minor: 50_050,
      plan_payment_id: c.planPaymentId,
      reason: REASON,
      requested_by_user_id: billingUser.id,
      withdrawn_at: null,
      decided_by_user_id: null,
      decided_at: null,
      decision_note: null,
      plan_payment_refund_id: null,
      announced_at: null,
      decline_notified_at: null,
    });
    expect(await companyAudit(c.tenantId, 'billing.plan_payment_refund_requested')).toEqual([
      {
        subject_id: requestId,
        actor_type: 'user',
        actor_id: billingUser.id,
        metadata: { planPaymentId: c.planPaymentId, amountMinor: 50_050 },
      },
    ]);
    // Nothing is refunded or asked of Razorpay, and the plan is as it was.
    expect(await refundRows(c.tenantId)).toEqual([]);
    expect(standInRefunds(c.paymentId)).toEqual([]);
    expect(await planStateOf(c.tenantId)).toEqual(before);

    // The receipt shows it, and says why nothing more can be asked for now.
    const view = await requests().forPlanPayment(c.ctx, c.planPaymentId);
    expect(view.requests).toEqual([
      {
        id: requestId,
        planPaymentId: c.planPaymentId,
        amountMinor: 50_050,
        reason: REASON,
        status: 'open',
        requestedAt: expect.any(Date),
        requestedByName: 'Billing Person',
        withdrawnAt: null,
        decidedAt: null,
        decisionNote: null,
        refund: null,
      },
    ]);
    expect(view.askable).toEqual({
      maxMinor: null,
      reason: 'You asked for a refund of this payment; HyFib has not decided yet.',
    });

    // Platform staff see it with the payment, what Razorpay refunded of it and any refund running.
    for (const actor of [owner, operator]) {
      const page = await staff().planRefundRequests(actor, { status: 'open' });
      expect(page.items).toContainEqual({
        id: requestId,
        tenantId: c.tenantId,
        companyName: `Company ${c.slug}`,
        companySlug: c.slug,
        companyStatus: 'active',
        planPaymentId: c.planPaymentId,
        paymentReceipt: c.invoiceId,
        paymentAmountMinor: 141_482,
        paymentRefundedMinor: 0,
        paymentPaidAt: expect.any(Date),
        refundInProgress: false,
        amountMinor: 50_050,
        reason: REASON,
        status: 'open',
        requestedByName: 'Billing Person',
        requestedAt: expect.any(Date),
        decidedAt: null,
        decidedByName: null,
        decisionNote: null,
        planPaymentRefundId: null,
        planPaymentRefundStatus: null,
      });
    }
    // Requests of service credit are listed apart.
    expect(
      (await staff().refundRequests(owner, { status: 'open' })).items.some(
        (r) => r.id === requestId,
      ),
    ).toBe(false);
  });

  it('needs billing.manage and a sign-in within the last 15 minutes', async () => {
    const c = await paid();
    const input = { planPaymentId: c.planPaymentId, amount: '10', reason: REASON };
    const agent = await signedIn(c, await member(c, 'agent', 'Agent Person'));
    const administrator = await signedIn(c, await member(c, 'admin', 'Admin Person'));
    expect(await refused(requests().ask(agent, input))).toBe('forbidden');
    expect(await refused(requests().forPlanPayment(agent, c.planPaymentId))).toBe('forbidden');
    // Administrators read billing but do not manage it.
    expect(await refused(requests().ask(administrator, input))).toBe('forbidden');
    expect((await requests().forPlanPayment(administrator, c.planPaymentId)).askable.maxMinor).toBe(
      141_482,
    );

    const stale = await signedIn(c, c.owner, RECENT_SIGN_IN_MINUTES + 5);
    const unknown = await signedIn(c, c.owner, null);
    expect(await refused(requests().ask(stale, input))).toBe('step_up_required');
    expect(await refused(requests().ask(unknown, input))).toBe('step_up_required');
    expect(await requestsOf([c.tenantId])).toEqual([]);

    // Withdrawing needs no fresh sign-in, but it needs billing.manage.
    const { requestId } = await ask(c, '10');
    expect(await refused(requests().withdraw(agent, requestId))).toBe('forbidden');
    expect(await refused(requests().withdraw(administrator, requestId))).toBe('forbidden');
    await requests().withdraw(stale, requestId);
    expect((await requestRow(requestId)).status).toBe('withdrawn');
  });

  it('refuses bad input, more than Razorpay has not refunded, a running refund, a payment refunded in full and payments that are not the company’s', async () => {
    const c = await paid();
    for (const [amount, reason] of [
      ['10', 'too short'],
      ['10', 'x'.repeat(1001)],
      ['', REASON],
      ['0', REASON],
      ['ten', REASON],
      ['1.005', REASON],
      ['-5', REASON],
      ['1414.83', REASON],
    ] as const) {
      expect(
        await refused(requests().ask(c.ctx, { planPaymentId: c.planPaymentId, amount, reason })),
        `${amount} ${reason.length}`,
      ).toBe('validation_failed');
    }
    expect((await refusal(ask(c, '1414.83'))).message).toBe(
      'At most ₹1,414.82 is left of this payment.',
    );
    expect(
      await refused(
        requests().ask(c.ctx, { planPaymentId: 'not-a-uuid', amount: '1', reason: REASON }),
      ),
    ).toBe('validation_failed');

    // A refund that failed refunded nothing: all of the payment can still be asked for, and the
    // platform list shows nothing refunded.
    const { refundId: failed } = await staffRefund(c, '100');
    expect(await failPlanPaymentRefund(provider(), c.scope, failed, 'Refused by Razorpay')).toBe(
      'failed',
    );
    expect((await requests().forPlanPayment(c.ctx, c.planPaymentId)).askable).toEqual({
      maxMinor: 141_482,
      reason: null,
    });
    const { requestId: listed } = await ask(c, '1414.82');
    expect(
      (await staff().planRefundRequests(owner, { status: 'open' })).items.find(
        (r) => r.id === listed,
      ),
    ).toMatchObject({ paymentRefundedMinor: 0, refundInProgress: false });
    await requests().withdraw(c.ctx, listed);

    // A refund made at Razorpay lowers what can be asked for: ₹500 refunded leaves ₹914.82.
    await refundAtRazorpay(c.paymentId, 50_000);
    expect(await refusal(ask(c, '914.83'))).toEqual({
      code: 'validation_failed',
      message: 'At most ₹914.82 is left of this payment.',
    });
    expect((await requests().forPlanPayment(c.ctx, c.planPaymentId)).askable).toEqual({
      maxMinor: 91_482,
      reason: null,
    });

    // Not while a refund of the payment is in progress.
    const { refundId } = await staffRefund(c, '10');
    expect(await refusal(ask(c, '10'))).toEqual({
      code: 'conflict',
      message: 'A refund of this payment is already in progress.',
    });
    expect((await requests().forPlanPayment(c.ctx, c.planPaymentId)).askable).toEqual({
      maxMinor: null,
      reason: 'A refund of this payment is in progress.',
    });

    // Nothing once the payment is refunded in full.
    expect(await step(c, refundId)).toBe('processed');
    await refundAtRazorpay(c.paymentId, 90_482);
    expect(await refusal(ask(c, '1'))).toEqual({
      code: 'precondition_failed',
      message: 'This payment was refunded in full.',
    });
    expect((await requests().forPlanPayment(c.ctx, c.planPaymentId)).askable).toEqual({
      maxMinor: null,
      reason: 'This payment was refunded in full.',
    });

    // Only a plan payment of this company.
    expect(await refused(ask(c, '1', c.ctx, uuidv7()))).toBe('not_found');
    expect(await refused(requests().forPlanPayment(c.ctx, uuidv7()))).toBe('not_found');
    expect(await refused(requests().forPlanPayment(c.ctx, 'not-a-uuid'))).toBe('not_found');
    const other = await paid();
    expect(await refused(ask(c, '1', c.ctx, other.planPaymentId))).toBe('not_found');
    expect(await refused(requests().forPlanPayment(c.ctx, other.planPaymentId))).toBe('not_found');
    expect((await requestsOf([c.tenantId, other.tenantId])).map((r) => r.status)).toEqual([
      'withdrawn',
    ]);
  });

  it('keeps one open request per payment, also when two arrive at once', async () => {
    const c = await paid();
    const results = await Promise.allSettled([ask(c, '10'), ask(c, '20')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [rejected] = results.filter((r) => r.status === 'rejected');
    const alreadyAsked = {
      code: 'conflict',
      message:
        'You already asked for a refund of this payment. Withdraw that request to ask again.',
    };
    expect(await refusal(Promise.reject((rejected as PromiseRejectedResult).reason))).toEqual(
      alreadyAsked,
    );
    expect(await refusal(ask(c, '30'))).toEqual(alreadyAsked);
    expect((await requestsOf([c.tenantId])).map((r) => r.status)).toEqual(['open']);
  });

  it(`allows ${REFUND_REQUEST_LIMITS.perDay} refund requests a day per company, of plan payments and service credit together`, async () => {
    const c = await paid();
    const topups: string[] = [];
    for (let i = 0; i < 3; i += 1) topups.push(await paidTopup(c, 10_000));
    // Three requests of the plan payment (asked and withdrawn) and two of service credit.
    for (let i = 0; i < 3; i += 1) {
      const { requestId } = await ask(c, '1');
      await requests().withdraw(c.ctx, requestId);
    }
    await askForCredit(c, topups[0]!);
    await askForCredit(c, topups[1]!);
    expect(await refusal(ask(c, '1'))).toEqual({
      code: 'rate_limited',
      message: `A company can ask for ${REFUND_REQUEST_LIMITS.perDay} refunds a day. Try again tomorrow.`,
    });
    expect(await refused(askForCredit(c, topups[2]!))).toBe('rate_limited');

    // A request older than a day no longer counts, of either kind.
    await adminQuery(
      `UPDATE app.plan_payment_refund_requests SET requested_at = now() - interval '25 hours'
        WHERE id = (SELECT id FROM app.plan_payment_refund_requests WHERE tenant_id = $1
                     ORDER BY requested_at LIMIT 1)`,
      [c.tenantId],
    );
    await ask(c, '1');
    expect(await refused(askForCredit(c, topups[2]!))).toBe('rate_limited');
    await adminQuery(
      `UPDATE app.credit_refund_requests SET requested_at = now() - interval '25 hours'
        WHERE tenant_id = $1 AND topup_id = $2`,
      [c.tenantId, topups[0]],
    );
    await askForCredit(c, topups[2]!);
    expect(await refused(ask(c, '1'))).toBe('rate_limited');
  });

  it('counts both kinds under the lock requests of service credit take, so requests at once cannot pass the limit', async () => {
    const c = await paid();
    const topups: string[] = [];
    for (let i = 0; i < REFUND_REQUEST_LIMITS.perDay; i += 1) {
      topups.push(await paidTopup(c, 10_000));
    }
    const results = await Promise.allSettled([
      ask(c, '1'),
      ...topups.map((topupId) => askForCredit(c, topupId)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
      REFUND_REQUEST_LIMITS.perDay,
    );
    const [rejected] = results.filter((r) => r.status === 'rejected');
    expect(await refused(Promise.reject((rejected as PromiseRejectedResult).reason))).toBe(
      'rate_limited',
    );
    const [counted] = await adminQuery<{ n: number }>(
      `SELECT ((SELECT count(*) FROM app.plan_payment_refund_requests WHERE tenant_id = $1)
             + (SELECT count(*) FROM app.credit_refund_requests WHERE tenant_id = $1))::int AS n`,
      [c.tenantId],
    );
    expect(counted!.n).toBe(REFUND_REQUEST_LIMITS.perDay);

    // The same lock, by its key: a request waits while another session holds it.
    const other = await paid();
    const holder = await dbs.adminPool.connect();
    let asked: Promise<unknown> | undefined;
    try {
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
        `credit_refund_request:${other.tenantId}`,
      ]);
      const [held] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      asked = ask(other, '1');
      await vi.waitFor(
        async () => {
          const [waiting] = await adminQuery<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND $1 = ANY (pg_blocking_pids(pid))`,
            [held!.pid],
          );
          if (waiting!.n < 1) throw new Error('the request is not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
    }
    await asked;
    expect((await requestsOf([other.tenantId])).map((r) => r.status)).toEqual(['open']);
  });

  it('is refused once the company asked for its deletion; staff can still decline an open request, approving is refused', async () => {
    const c = await paid();
    const { requestId } = await ask(c, '50');
    await dbs.app.run(authorizedTenantScope(c.tenantId, c.owner.id), (tx) =>
      tx.execute(sql`select * from app.request_tenant_deletion(${c.slug})`),
    );
    const beingDeleted = {
      code: 'precondition_failed',
      message: 'The company is being deleted, so it can no longer ask for refunds.',
    };
    const waiting = await signedIn(c, c.owner);
    expect(waiting.tenant.status).toBe('pending_deletion');
    expect(await refusal(ask(c, '10', waiting))).toEqual(beingDeleted);
    // A context read before the deletion, as a page's is before its form is sent: the status now
    // is what counts (otherwise the open request would be the refusal).
    expect(c.ctx.tenant.status).toBe('active');
    expect(await refusal(ask(c, '10'))).toEqual(beingDeleted);
    expect((await requests().forPlanPayment(waiting, c.planPaymentId)).askable).toEqual({
      maxMinor: null,
      reason: 'The company is being deleted, so it can no longer ask for refunds.',
    });
    const page = await staff().planRefundRequests(owner, { status: 'open' });
    expect(page.items.find((r) => r.id === requestId)?.companyStatus).toBe('pending_deletion');
    expect(await refusal(decide(owner, requestId, 'approve'))).toEqual({
      code: 'precondition_failed',
      message: 'The company is being deleted: refund the payment in the Razorpay Dashboard.',
    });
    expect((await requestRow(requestId)).status).toBe('open');
    expect(await refundRows(c.tenantId)).toEqual([]);
    await decide(owner, requestId, 'decline', NOTE);
    expect((await requestRow(requestId)).status).toBe('declined');
  });

  it('reads the company’s status under a lock, so a deletion asked for meanwhile refuses the request', async () => {
    const c = await paid();
    const deleting = await dbs.adminPool.connect();
    let asked: Promise<{ code: string; message: string }> | undefined;
    try {
      await deleting.query('BEGIN');
      await deleting.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
        [c.tenantId, c.owner.id],
      );
      await deleting.query('SELECT * FROM app.request_tenant_deletion($1)', [c.slug]);
      const [holder] = (await deleting.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows;
      asked = refusal(ask(c, '10'));
      // The request waits for the deletion's transaction before it reads the status.
      await vi.waitFor(
        async () => {
          const [waiting] = await adminQuery<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND $1 = ANY (pg_blocking_pids(pid))`,
            [holder!.pid],
          );
          if (waiting!.n < 1) throw new Error('the request is not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
    } finally {
      await deleting.query('COMMIT');
      deleting.release();
    }
    expect(await asked).toEqual({
      code: 'precondition_failed',
      message: 'The company is being deleted, so it can no longer ask for refunds.',
    });
    expect(await requestsOf([c.tenantId])).toEqual([]);
  });
});

describe('withdrawing', () => {
  it('withdraws an open request once, audited, and the company can ask again', async () => {
    const c = await paid();
    const { requestId } = await ask(c, '50');
    await requests().withdraw(c.ctx, requestId);
    const row = await requestRow(requestId);
    expect(row.status).toBe('withdrawn');
    expect(row.withdrawn_at).toBeInstanceOf(Date);
    expect(await companyAudit(c.tenantId, 'billing.plan_payment_refund_request_withdrawn')).toEqual(
      [
        {
          subject_id: requestId,
          actor_type: 'user',
          actor_id: c.owner.id,
          metadata: { planPaymentId: c.planPaymentId },
        },
      ],
    );
    expect(await refusal(requests().withdraw(c.ctx, requestId))).toEqual({
      code: 'conflict',
      message: 'This request was already decided or withdrawn.',
    });
    expect(await refused(requests().withdraw(c.ctx, uuidv7()))).toBe('not_found');
    expect(await refused(requests().withdraw(c.ctx, 'not-a-uuid'))).toBe('not_found');
    // A withdrawn request cannot be decided.
    expect(await refusal(decide(owner, requestId, 'approve'))).toEqual({
      code: 'conflict',
      message: 'This request was already decided or withdrawn.',
    });

    const again = await ask(c, '60');
    expect(
      (await requests().forPlanPayment(c.ctx, c.planPaymentId)).requests.map((r) => r.status),
    ).toEqual(['open', 'withdrawn']);
    // Another company cannot withdraw it, and a request of service credit is not this one.
    const other = await paid();
    expect(await refused(requests().withdraw(other.ctx, again.requestId))).toBe('not_found');
    expect(await refused(creditRequests().withdraw(c.ctx, again.requestId))).toBe('not_found');
    expect((await requestRow(again.requestId)).status).toBe('open');
  });
});

describe('deciding', () => {
  it('approving starts the staff refund of ADR-103 for the amount asked, linked and audited; Razorpay refunds it and the plan does not change', async () => {
    const c = await paid();
    const before = await planStateOf(c.tenantId);
    const { requestId } = await ask(c, '500');
    const { refundId } = await decide(owner, requestId, 'approve', 'Approved, ticket 88 on file.');
    expect(refundId).toEqual(expect.any(String));

    const row = await requestRow(requestId);
    expect(row).toMatchObject({
      status: 'approved',
      decided_by_user_id: owner.userId,
      decision_note: 'Approved, ticket 88 on file.',
      plan_payment_refund_id: refundId,
    });
    expect(row.decided_at).toBeInstanceOf(Date);
    // The staff refund, with a reason that names the company's.
    expect(await refundRows(c.tenantId)).toEqual([
      {
        id: refundId,
        origin: 'staff',
        status: 'requested',
        amount_minor: 50_000,
        reason: `Asked for by the company: ${REASON}`,
        requested_by_user_id: owner.userId,
        provider_refund_id: null,
      },
    ]);
    expect(
      await platformAudit(c.tenantId, 'platform.plan_payment_refund_request_approved'),
    ).toEqual([
      {
        actor_user_id: owner.userId,
        reason: 'Approved, ticket 88 on file.',
        result: 'success',
        correlation_id: owner.correlationId,
        metadata: { requestId, planPaymentId: c.planPaymentId, amountMinor: 50_000, refundId },
      },
    ]);
    expect(await platformAudit(c.tenantId, 'platform.plan_payment_refund_requested')).toEqual([
      {
        actor_user_id: owner.userId,
        reason: `Asked for by the company: ${REASON}`,
        result: 'success',
        correlation_id: owner.correlationId,
        metadata: { refundId, planPaymentId: c.planPaymentId, amountMinor: 50_000 },
      },
    ]);

    // The company sees the decision and the refund, but not who decided.
    const view = await requests().forPlanPayment(c.ctx, c.planPaymentId);
    expect(view.requests).toEqual([
      expect.objectContaining({
        id: requestId,
        status: 'approved',
        decisionNote: 'Approved, ticket 88 on file.',
        refund: { id: refundId, status: 'requested' },
      }),
    ]);
    expect(view.requests[0]!.decidedAt).toBeInstanceOf(Date);
    expect(Object.keys(view.requests[0]!)).not.toContain('decidedByName');
    expect(view.askable).toEqual({
      maxMinor: null,
      reason: 'A refund of this payment is in progress.',
    });

    // Staff see who decided, and the refund in the list of every refund, linked to the request.
    const decided = await staff().planRefundRequests(operator, { status: 'decided' });
    expect(decided.items).toContainEqual(
      expect.objectContaining({
        id: requestId,
        status: 'approved',
        decidedByName: 'Plan Refund Deciding Owner',
        refundInProgress: true,
        planPaymentRefundId: refundId,
        planPaymentRefundStatus: 'requested',
      }),
    );
    expect(
      (await staff().planRefundRequests(operator, { status: 'open' })).items.some(
        (r) => r.id === requestId,
      ),
    ).toBe(false);
    expect((await staff().planPaymentRefunds(operator)).items).toContainEqual({
      id: refundId,
      tenantId: c.tenantId,
      companyName: `Company ${c.slug}`,
      companySlug: c.slug,
      planPaymentId: c.planPaymentId,
      paymentReceipt: c.invoiceId,
      origin: 'staff',
      amountMinor: 50_000,
      status: 'requested',
      reason: `Asked for by the company: ${REASON}`,
      requestedByName: 'Plan Refund Deciding Owner',
      requestedAt: expect.any(Date),
      submittedAt: null,
      processedAt: null,
      failedAt: null,
      lastError: null,
      requestId,
    });

    // The worker asks Razorpay with the refund's key and notes, as for any staff refund.
    expect(await step(c, refundId!)).toBe('processed');
    expect(standInRefunds(c.paymentId)).toMatchObject([
      {
        amount: 50_000,
        idempotencyKey: `ppr_${refundId}`,
        notes: { hyfib_plan_refund: refundId },
      },
    ]);
    const refunded = await requests().forPlanPayment(c.ctx, c.planPaymentId);
    expect(refunded.requests[0]!.refund).toEqual({ id: refundId, status: 'processed' });
    expect(refunded.askable).toEqual({ maxMinor: 91_482, reason: null });
    // The company's email about the refund keeps HyFib's reason to itself.
    const emails = await billingEmails(c.tenantId);
    expect(emails.filter((e) => /refund/i.test(e.subject))).toHaveLength(1);
    expect(JSON.stringify(emails)).not.toContain('Asked for by the company');
    expect(await planStateOf(c.tenantId)).toEqual(before);

    // Decided once.
    expect(await refusal(decide(owner, requestId, 'decline', NOTE))).toEqual({
      code: 'conflict',
      message: 'This request was already decided or withdrawn.',
    });
    expect(await refused(decide(owner, uuidv7(), 'approve'))).toBe('not_found');
  });

  it('approving checks everything again: a request that no longer fits is refused with the reason and stays open', async () => {
    const c = await paid();
    const { requestId } = await ask(c, '1000');
    // A refund started from the company's page after the request.
    const { refundId: running } = await staffRefund(c, '500');
    const open = await staff().planRefundRequests(owner, { status: 'open' });
    expect(open.items.find((r) => r.id === requestId)).toMatchObject({
      refundInProgress: true,
      paymentRefundedMinor: 0,
    });
    expect(await refusal(decide(owner, requestId, 'approve'))).toEqual({
      code: 'conflict',
      message: 'A refund of this payment is already in progress.',
    });
    expect((await requestRow(requestId)).status).toBe('open');

    // Razorpay refunds it: ₹914.82 is left, less than the ₹1,000 asked for.
    expect(await step(c, running)).toBe('processed');
    const later = await staff().planRefundRequests(owner, { status: 'open' });
    expect(later.items.find((r) => r.id === requestId)).toMatchObject({
      refundInProgress: false,
      paymentRefundedMinor: 50_000,
    });
    expect(await refusal(decide(owner, requestId, 'approve'))).toEqual({
      code: 'precondition_failed',
      message: 'The amount must be at least 1 paisa and at most what is left of the payment.',
    });
    expect((await requestRow(requestId)).status).toBe('open');
    expect(await refundRows(c.tenantId)).toHaveLength(1);
    expect(
      await platformAudit(c.tenantId, 'platform.plan_payment_refund_request_approved'),
    ).toEqual([]);

    // It can still be declined with a note.
    await decide(owner, requestId, 'decline', NOTE);
    expect((await requestRow(requestId)).status).toBe('declined');
  });

  it('declining needs a note the company reads, and is audited', async () => {
    const c = await paid();
    const { requestId } = await ask(c, '100');
    expect(await refused(decide(owner, requestId, 'decline'))).toBe('validation_failed');
    expect(await refused(decide(owner, requestId, 'decline', 'too short'))).toBe(
      'validation_failed',
    );
    expect(await refused(decide(owner, requestId, 'approve', 'short'))).toBe('validation_failed');
    expect(await refused(decide(owner, requestId, 'decline', 'x'.repeat(1001)))).toBe(
      'validation_failed',
    );
    // The function checks the note by itself too.
    for (const note of [null, '   ', 'too short', 'x'.repeat(1001)]) {
      const direct = sql`select ops.platform_decide_plan_payment_refund_request(${requestId}::uuid,
        false, ${note}::text, 'direct')`;
      expect(await refused(dbs.platform.run(owner.userId, (tx) => tx.execute(direct)))).toBe(
        'precondition_failed',
      );
    }
    const direct = sql`select ops.platform_decide_plan_payment_refund_request(${requestId}::uuid,
      null, ${NOTE}::text, 'direct')`;
    expect(await refused(dbs.platform.run(owner.userId, (tx) => tx.execute(direct)))).toBe(
      'precondition_failed',
    );
    expect((await requestRow(requestId)).status).toBe('open');

    expect(await decide(owner, requestId, 'decline', `  ${NOTE}  `)).toEqual({ refundId: null });
    expect(await requestRow(requestId)).toMatchObject({
      status: 'declined',
      decided_by_user_id: owner.userId,
      decision_note: NOTE,
      plan_payment_refund_id: null,
      decline_notified_at: null,
    });
    expect(await refundRows(c.tenantId)).toEqual([]);
    expect(
      await platformAudit(c.tenantId, 'platform.plan_payment_refund_request_declined'),
    ).toEqual([
      {
        actor_user_id: owner.userId,
        reason: NOTE,
        result: 'success',
        correlation_id: owner.correlationId,
        metadata: {
          requestId,
          planPaymentId: c.planPaymentId,
          amountMinor: 10_000,
          refundId: null,
        },
      },
    ]);
    const view = await requests().forPlanPayment(c.ctx, c.planPaymentId);
    expect(view.requests[0]).toMatchObject({
      status: 'declined',
      decisionNote: NOTE,
      refund: null,
    });
    // The company can ask again.
    expect(view.askable).toEqual({ maxMinor: 141_482, reason: null });
  });

  it('is for platform owners only, checked by the database as well as the service', async () => {
    const c = await paid();
    const { requestId } = await ask(c, '100');
    expect(await refusal(decide(operator, requestId, 'approve'))).toEqual({
      code: 'forbidden',
      message: 'Only a platform owner can decide a refund request.',
    });
    // A claimed role is not enough: the functions look the user up.
    const stranger = await createUser(dbs, { twoFactor: true });
    const claimed: PlatformActor = {
      userId: stranger.id,
      role: 'platform_owner',
      correlationId: uuidv7(),
    };
    expect(await refused(decide(claimed, requestId, 'approve'))).toBe('forbidden');
    expect(await refused(staff().planRefundRequests(claimed))).toBe('forbidden');
    expect(await refused(staff().planPaymentRefunds(claimed))).toBe('forbidden');
    // The decision function checks the owner itself, for a decline too.
    const direct = sql`select ops.platform_decide_plan_payment_refund_request(${requestId}::uuid,
      true, null::text, 'direct')`;
    const declineDirect = sql`select ops.platform_decide_plan_payment_refund_request(
      ${requestId}::uuid, false, ${NOTE}::text, 'direct')`;
    for (const statement of [direct, declineDirect]) {
      expect(
        await refusal(dbs.platform.run(operator.userId, (tx) => tx.execute(statement))),
      ).toEqual({
        code: 'forbidden',
        message: 'Only a platform owner can decide a refund request.',
      });
    }
    // The company role cannot call the decision or the lists.
    for (const statement of [
      direct,
      sql`select * from ops.platform_plan_payment_refund_requests(null, null, null, 10)`,
      sql`select * from ops.platform_plan_payment_refunds(null, null, 10)`,
    ]) {
      expect(await databaseRefusal(dbs.app.run(c.scope, (tx) => tx.execute(statement)))).toMatch(
        /permission denied for function/,
      );
    }
    // An unknown list filter is refused by the function.
    expect(
      await refused(
        dbs.platform.run(owner.userId, (tx) =>
          tx.execute(
            sql`select * from ops.platform_plan_payment_refund_requests('withdrawn', null, null, 10)`,
          ),
        ),
      ),
    ).toBe('precondition_failed');
    expect((await requestRow(requestId)).status).toBe('open');
    expect(await refundRows(c.tenantId)).toEqual([]);
  });
});

describe('what the company’s database role can do', () => {
  it('reads its requests without who decided, asks only for open requests, and only withdraws them', async () => {
    const c = await paid();
    const { requestId } = await ask(c, '100');
    const run = (statement: ReturnType<typeof sql>) =>
      dbs.app.run(authorizedTenantScope(c.tenantId, c.owner.id), (tx) => tx.execute(statement));

    for (const column of ['decided_by_user_id', 'announced_at', 'decline_notified_at']) {
      expect(
        await databaseRefusal(
          run(sql`select ${sql.raw(column)} from app.plan_payment_refund_requests`),
        ),
        column,
      ).toMatch(/permission denied/);
    }
    // No decided request, and no decision or notice columns, through the company role.
    expect(
      await databaseRefusal(
        run(sql`insert into app.plan_payment_refund_requests (id, tenant_id, plan_payment_id,
                  amount_minor, reason, requested_by_user_id, status)
                values (${uuidv7()}::uuid, ${c.tenantId}::uuid, ${c.planPaymentId}::uuid, 100,
                  ${REASON}, ${c.owner.id}, 'approved')`),
      ),
    ).toMatch(/permission denied/);
    for (const assignment of [
      sql`decision_note = ${NOTE}`,
      sql`decided_at = now()`,
      sql`decided_by_user_id = null`,
      sql`plan_payment_refund_id = null`,
      sql`announced_at = now()`,
      sql`decline_notified_at = now()`,
      sql`amount_minor = 1`,
      sql`plan_payment_id = plan_payment_id`,
      sql`reason = ${REASON}`,
    ]) {
      expect(
        await databaseRefusal(
          run(
            sql`update app.plan_payment_refund_requests set ${assignment}
                 where id = ${requestId}::uuid`,
          ),
        ),
      ).toMatch(/permission denied/);
    }
    expect(
      await databaseRefusal(
        run(
          sql`update app.plan_payment_refund_requests set status = 'approved'
               where id = ${requestId}::uuid`,
        ),
      ),
    ).toMatch(/row-level security/);
    expect(
      await databaseRefusal(
        run(sql`delete from app.plan_payment_refund_requests where id = ${requestId}::uuid`),
      ),
    ).toMatch(/permission denied/);
    await requests().withdraw(c.ctx, requestId);
    // A withdrawn request is not reopened.
    const reopened = await run(
      sql`update app.plan_payment_refund_requests set status = 'open', withdrawn_at = null
           where id = ${requestId}::uuid`,
    );
    expect(reopened.rowCount).toBe(0);
    expect((await requestRow(requestId)).status).toBe('withdrawn');
  });

  it('sees only its own requests, even with another company’s id', async () => {
    const a = await paid();
    const b = await paid();
    const { requestId } = await ask(a, '100');
    const seen = await dbs.app.run(b.scope, (tx) =>
      tx.execute(
        sql`select id from app.plan_payment_refund_requests where id = ${requestId}::uuid`,
      ),
    );
    expect(seen.rows).toEqual([]);
    const moved = await dbs.app.run(b.scope, (tx) =>
      tx.execute(
        sql`update app.plan_payment_refund_requests set status = 'withdrawn', withdrawn_at = now()
             where id = ${requestId}::uuid`,
      ),
    );
    expect(moved.rowCount).toBe(0);
    expect(
      await databaseRefusal(
        dbs.app.run(b.scope, (tx) =>
          tx.execute(sql`insert into app.plan_payment_refund_requests (id, tenant_id,
                           plan_payment_id, amount_minor, reason, requested_by_user_id)
                         values (${uuidv7()}::uuid, ${a.tenantId}::uuid, ${a.planPaymentId}::uuid,
                           100, ${REASON}, ${b.owner.id})`),
        ),
      ),
    ).toMatch(/row-level security/);
    // Its own request cannot name another company's payment either.
    expect(
      await databaseRefusal(
        dbs.app.run(b.scope, (tx) =>
          tx.execute(sql`insert into app.plan_payment_refund_requests (id, tenant_id,
                           plan_payment_id, amount_minor, reason, requested_by_user_id)
                         values (${uuidv7()}::uuid, ${b.tenantId}::uuid, ${a.planPaymentId}::uuid,
                           100, ${REASON}, ${b.owner.id})`),
        ),
      ),
    ).toMatch(/foreign key/);
    expect((await requestRow(requestId)).status).toBe('open');
  });
});

describe('emails', () => {
  it('tells every platform owner once about new requests of both kinds, counts only', async () => {
    // Whatever earlier tests left unannounced is announced first.
    await announce();
    const owners = await ownerEmails();
    expect(owners.length).toBeGreaterThan(0);
    const c = await paid();
    const topupId = await paidTopup(c, 20_000);

    // A request of a plan payment alone.
    const since = await dbNow();
    const first = await ask(c, '50');
    expect(await announce()).toEqual({
      announced: 1,
      unsent: 0,
      recipients: owners.length,
      posted: false,
    });
    const sent = await platformNotices(since);
    expect(sent.map((n) => n.to).sort()).toEqual(owners);
    for (const notice of sent) {
      expect(notice).toEqual({
        to: notice.to,
        tenantId: null,
        payload: { kind: 'platform.notice', ...refundRequestsAnnouncement(0, APP_BASE, 1) },
      });
      // No company, payment, amount or reason.
      const text = JSON.stringify(notice.payload);
      expect(text).not.toContain(c.slug);
      expect(text).not.toContain(c.invoiceId);
      expect(text).not.toContain(REASON);
      expect(text).not.toContain('₹');
    }
    expect((await requestRow(first.requestId)).announced_at).toBeInstanceOf(Date);
    // Once, however often the sweep runs.
    expect(await announce()).toEqual({ announced: 0, unsent: 0, recipients: 0, posted: false });
    expect(await platformNotices(since)).toHaveLength(owners.length);

    // Both kinds in one email.
    const other = await paid();
    const since2 = await dbNow();
    const second = await ask(other, '60');
    await askForCredit(c, topupId, '10');
    expect(await announce()).toEqual({
      announced: 2,
      unsent: 0,
      recipients: owners.length,
      posted: false,
    });
    expect((await platformNotices(since2)).map((n) => n.payload)).toEqual(
      owners.map(() => ({
        kind: 'platform.notice',
        ...refundRequestsAnnouncement(1, APP_BASE, 1),
      })),
    );
    expect((await requestRow(second.requestId)).announced_at).toBeInstanceOf(Date);

    // A request withdrawn before the sweep is not announced.
    await requests().withdraw(c.ctx, first.requestId);
    const third = await ask(c, '70');
    await requests().withdraw(c.ctx, third.requestId);
    expect(await announce()).toEqual({ announced: 0, unsent: 0, recipients: 0, posted: false });
    expect((await requestRow(third.requestId)).announced_at).toBeNull();

    // Two sweeps at once announce a request once.
    const fourth = await ask(c, '80');
    const since3 = await dbNow();
    const [x, y] = await Promise.all([announce(), announce()]);
    expect(x.announced + y.announced).toBe(1);
    expect((await platformNotices(since3)).map((n) => n.to).sort()).toEqual(owners);
    expect((await requestRow(fourth.requestId)).announced_at).toBeInstanceOf(Date);

    // With no platform owner, a request stays due until there is one.
    await requests().withdraw(other.ctx, second.requestId);
    const fifth = await ask(other, '90');
    const demoted = await adminQuery<{ user_id: string }>(
      `UPDATE ops.platform_admins SET role = 'platform_operator' WHERE role = 'platform_owner'
       RETURNING user_id`,
    );
    try {
      expect(await announce()).toEqual({ announced: 0, unsent: 1, recipients: 0, posted: false });
    } finally {
      await adminQuery(
        `UPDATE ops.platform_admins SET role = 'platform_owner' WHERE user_id = ANY($1::text[])`,
        [demoted.map((r) => r.user_id)],
      );
    }
    expect((await requestRow(fifth.requestId)).announced_at).toBeNull();
    const since4 = await dbNow();
    expect(await announce()).toEqual({
      announced: 1,
      unsent: 0,
      recipients: owners.length,
      posted: false,
    });
    expect((await platformNotices(since4)).map((n) => n.payload)).toEqual(
      owners.map(() => ({
        kind: 'platform.notice',
        ...refundRequestsAnnouncement(0, APP_BASE, 1),
      })),
    );
  });

  it('tells the billing managers once when a request is declined, with the note and the receipt', async () => {
    await tellDeclines();
    const c = await paid();
    const billingUser = await member(c, 'billing', 'Billing Person');
    await member(c, 'agent', 'Agent Person');
    const subject = 'HyFib declined your refund request';
    const { requestId } = await ask(c, '100');
    await decide(owner, requestId, 'decline', NOTE);
    // An approved request is not this email's.
    const { requestId: approved } = await ask(c, '10');
    const { refundId } = await decide(owner, approved, 'approve');
    expect(await step(c, refundId!)).toBe('processed');

    expect(await tellDeclines()).toEqual({ notified: 1, failed: [] });
    const told = await billingEmails(c.tenantId, subject);
    expect(told.map((e) => e.to).sort()).toEqual([c.owner.email, billingUser.email].sort());
    for (const email of told) {
      expect(email).toMatchObject({
        lines: [
          `HyFib declined your request to refund ₹100.00 of your plan payment ${c.invoiceId}.`,
          `HyFib's note: ${NOTE}`,
          'Your plan and its paid period do not change. You can ask again from the payment’s receipt.',
        ],
        url: `${APP_BASE}/c/${c.slug}/billing/plan-payments/${c.planPaymentId}`,
      });
    }
    expect((await requestRow(requestId)).decline_notified_at).toBeInstanceOf(Date);
    expect((await requestRow(approved)).decline_notified_at).toBeNull();
    expect(await tellDeclines()).toEqual({ notified: 0, failed: [] });
    expect(await billingEmails(c.tenantId, subject)).toHaveLength(2);

    // Two sweeps at once tell a decline once.
    const { requestId: again } = await ask(c, '50');
    await decide(owner, again, 'decline', NOTE);
    const [x, y] = await Promise.all([tellDeclines(), tellDeclines()]);
    expect(x.notified + y.notified).toBe(1);
    expect(x.failed.concat(y.failed)).toEqual([]);
    expect(await billingEmails(c.tenantId, subject)).toHaveLength(4);

    // The mark is taken in the company's own scope: another company's scope marks nothing.
    const { requestId: third } = await ask(c, '40');
    await decide(owner, third, 'decline', NOTE);
    const stranger = await paid();
    const marked = await dbs.app.run(stranger.scope, (tx) =>
      tx.execute<{ marked: boolean }>(
        sql`select app.plan_payment_refund_request_mark_decline_notified(${third}::uuid) as marked`,
      ),
    );
    expect(marked.rows[0]!.marked).toBe(false);
    expect((await requestRow(third)).decline_notified_at).toBeNull();
    // Nor does the mark for requests of service credit.
    const creditMarked = await dbs.app.run(c.scope, (tx) =>
      tx.execute<{ marked: boolean }>(
        sql`select app.credit_refund_request_mark_decline_notified(${third}::uuid) as marked`,
      ),
    );
    expect(creditMarked.rows[0]!.marked).toBe(false);
    expect(await tellDeclines()).toEqual({ notified: 1, failed: [] });

    // A note as long as a decline allows (1,000 characters) is told in full, over several lines:
    // a billing notice's line holds at most 500.
    const long = 'The charge was for the month you used; see the terms and ticket 4411. '
      .repeat(15)
      .slice(0, 1000)
      .trimEnd();
    expect(long.length).toBeGreaterThan(990);
    const { requestId: fourth } = await ask(c, '30');
    await decide(owner, fourth, 'decline', long);
    expect(await tellDeclines()).toEqual({ notified: 1, failed: [] });
    const all = await billingEmails(c.tenantId, subject);
    expect(all).toHaveLength(8);
    for (const email of all.slice(-2)) {
      expect(email.lines[0]).toBe(
        `HyFib declined your request to refund ₹30.00 of your plan payment ${c.invoiceId}.`,
      );
      expect(email.lines.at(-1)).toBe(
        'Your plan and its paid period do not change. You can ask again from the payment’s receipt.',
      );
      const note = email.lines.slice(1, -1);
      expect(note.length).toBeGreaterThan(2);
      expect(note.every((line) => line.length <= 500)).toBe(true);
      expect(note.join(' ')).toBe(`HyFib's note: ${long}`);
    }
  });
});

describe('platform lists', () => {
  it('pages requests and every refund of a plan payment newest first on the exact time and id, with refunds made at Razorpay', async () => {
    const c = await paid();
    // More than a page of withdrawn requests at one microsecond, later than anything else here.
    const ids: string[] = [];
    for (let i = 0; i < PLATFORM_REFUNDS_PAGE + 3; i += 1) ids.push(uuidv7());
    await adminQuery(
      `INSERT INTO app.plan_payment_refund_requests (id, tenant_id, plan_payment_id, amount_minor,
         reason, status, requested_by_user_id, requested_at, withdrawn_at)
       SELECT id, $2, $3, 100, $4, 'withdrawn', $5, '2100-01-01 00:00:00.123456+00',
              '2100-01-01 00:00:01+00'
         FROM unnest($1::uuid[]) AS id`,
      [ids, c.tenantId, c.planPaymentId, REASON, c.owner.id],
    );
    const first = await staff().planRefundRequests(operator, { status: 'all' });
    expect(first.items).toHaveLength(PLATFORM_REFUNDS_PAGE);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await staff().planRefundRequests(operator, {
      status: 'all',
      cursor: first.nextCursor!,
    });
    const seen = [...first.items, ...second.items]
      .filter((r) => r.tenantId === c.tenantId)
      .map((r) => r.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([...ids].sort().reverse());
    for (const status of ['open', 'decided'] as const) {
      expect(
        (await staff().planRefundRequests(operator, { status })).items.some(
          (r) => r.tenantId === c.tenantId,
        ),
        status,
      ).toBe(false);
    }
    expect(
      await refused(staff().planRefundRequests(operator, { cursor: 'bm90LWEtY3Vyc29y' })),
    ).toBe('validation_failed');
    expect(await refused(staff().planRefundRequests(operator, { status: 'withdrawn' }))).toBe(
      'validation_failed',
    );
    expect(
      await refused(staff().planPaymentRefunds(operator, { cursor: 'bm90LWEtY3Vyc29y' })),
    ).toBe('validation_failed');

    // Refunds: one HyFib started and one made at Razorpay, at one microsecond, read one at a time
    // through the function.
    const { refundId } = await staffRefund(c, '1', 'Duplicate payment, ticket 1203');
    expect(await step(c, refundId)).toBe('processed');
    const made = await refundAtRazorpay(c.paymentId, 200);
    const [madeRow] = await adminQuery<{ id: string }>(
      'SELECT id FROM app.plan_payment_refunds WHERE provider_refund_id = $1',
      [made.id],
    );
    await adminQuery(
      `UPDATE app.plan_payment_refunds SET requested_at = '2100-01-01 00:00:00.654321+00'
        WHERE id = ANY($1::uuid[])`,
      [[refundId, madeRow!.id]],
    );
    const pageOne = await dbs.platform.run(operator.userId, (tx) =>
      tx.execute<{ id: string; cursor_at: string }>(
        sql`select id, cursor_at from ops.platform_plan_payment_refunds(null, null, 1)`,
      ),
    );
    const top = pageOne.rows[0]!;
    expect(top.cursor_at).toBe('2100-01-01T00:00:00.654321Z');
    const pageTwo = await dbs.platform.run(operator.userId, (tx) =>
      tx.execute<{ id: string }>(
        sql`select id from ops.platform_plan_payment_refunds(${top.cursor_at}::timestamptz,
              ${top.id}::uuid, 1)`,
      ),
    );
    const newest = [refundId, madeRow!.id].sort().reverse();
    expect([top.id, pageTwo.rows[0]!.id]).toEqual(newest);
    const listed = await staff().planPaymentRefunds(operator);
    expect(listed.items.slice(0, 2).map((r) => r.id)).toEqual(newest);
    const shown = new Map(listed.items.map((r) => [r.id, r]));
    const common = {
      tenantId: c.tenantId,
      companyName: `Company ${c.slug}`,
      companySlug: c.slug,
      planPaymentId: c.planPaymentId,
      paymentReceipt: c.invoiceId,
      status: 'processed',
      requestedAt: expect.any(Date),
      processedAt: expect.any(Date),
      failedAt: null,
      lastError: null,
      requestId: null,
    };
    expect(shown.get(refundId)).toEqual({
      ...common,
      id: refundId,
      origin: 'staff',
      amountMinor: 100,
      reason: 'Duplicate payment, ticket 1203',
      requestedByName: 'Plan Refund Deciding Owner',
      submittedAt: expect.any(Date),
    });
    // Made at Razorpay: no reason and nobody in HyFib asked.
    expect(shown.get(madeRow!.id)).toEqual({
      ...common,
      id: madeRow!.id,
      origin: 'razorpay',
      amountMinor: 200,
      reason: null,
      requestedByName: null,
      submittedAt: null,
    });
  });
});
