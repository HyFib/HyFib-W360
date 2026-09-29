import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { Keyring, isAppError, uuidv7, type Clock, type RazorpayConfig } from '@w360/core';
import { authorizedTenantScope, sql, type TenantScope } from '@w360/db';
import {
  JobSigner,
  PgBossJobQueue,
  RazorpayClient,
  createBillingHistoryService,
  createBillingService,
  createPlatformBillingService,
  failCreditRefund,
  findDueCreditRefunds,
  formatMonth,
  monthOf,
  outboxAad,
  processCreditRefund,
  processRazorpayReceipt,
  resolveTenantContext,
  storeWebhookReceipt,
  type BillingNoticeDeps,
  type CreditRefundDeps,
  type PlatformActor,
  type TenantContext,
} from '@w360/domain';
import { connectTestDatabases, createTenant, createUser, type TestDatabases } from './helpers';
import { startRazorpayStandIn, type RazorpayStandIn } from '../support/razorpay-stand-in';

/**
 * Refunds of unused service credit started by platform owners (P5-05, ADR-058) against real
 * PostgreSQL and the test-only Razorpay stand-in: who may ask and what can be refunded, the hold
 * placed at once, the worker's call with its idempotency key (lost responses, busy and refused
 * calls), recording from the webhook or the worker's own check (including a webhook that arrives
 * before the refund id is stored), failed refunds giving the credit back, emails, audit, statement
 * labels and company isolation.
 */
const KEY_ID = 'rzp_test_StandIn00000004';
const KEY_SECRET = randomBytes(16).toString('hex');
const WEBHOOK_SECRET = randomBytes(16).toString('hex');
const REASON = 'Duplicate payment, ticket 1201';

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
    webhookSecrets: [WEBHOOK_SECRET],
    recurringCardsEnabled: true,
    subscriptionsEnabled: false,
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
const billing = () =>
  createBillingService({
    db: dbs.app,
    clock,
    razorpay,
    razorpayConfig: config(),
    notices: notices(),
  });
const history = () => createBillingHistoryService({ db: dbs.app, clock });
const staff = () => createPlatformBillingService({ platformDb: dbs.platform });
const refundDeps = (): CreditRefundDeps => ({ db: dbs.app, razorpay, clock, notices: notices() });

async function adminQuery<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await dbs.adminPool.query<T>(text, params)).rows;
}

interface Company {
  tenantId: string;
  scope: TenantScope;
  ctx: TenantContext;
}

async function company(): Promise<Company> {
  const user = await createUser(dbs, { name: 'Refund Company Owner' });
  const tenant = await createTenant(dbs, user);
  const ctx = await resolveTenantContext(
    { db: dbs.app, clock, mfaGracePeriodHours: 72 },
    {
      userId: user.id,
      sessionId: `sess_${user.id}`,
      sessionCreatedAt: clock.now(),
      tenantSlug: tenant.slug,
      correlationId: uuidv7(),
    },
  );
  return { tenantId: tenant.id, scope: authorizedTenantScope(tenant.id, null), ctx };
}

async function platformActor(role: PlatformActor['role'], name: string): Promise<PlatformActor> {
  const user = await createUser(dbs, { name, twoFactor: true });
  await dbs.ownerPool.query('INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, $2)', [
    user.id,
    role,
  ]);
  return { userId: user.id, role, correlationId: uuidv7() };
}

/** A paid top-up through the real path: order, Checkout payment, confirmation fetch. */
async function paidTopup(c: Company, amountMinor: number) {
  const topup = await billing().startTopup(c.ctx, { amountMinor });
  const payment = standIn.pay(topup.orderId);
  await billing().confirmTopupCheckout(c.ctx, {
    topupId: topup.topupId,
    paymentId: payment.id,
    signature: createHmac('sha256', KEY_SECRET)
      .update(`${topup.orderId}|${payment.id}`)
      .digest('hex'),
  });
  return { topupId: topup.topupId, payment };
}

async function ask(c: Company, topupId: string, amount: string) {
  return staff().requestRefund(owner, { tenantId: c.tenantId, topupId, amount, reason: REASON });
}

const step = (c: Company, refundId: string) => processCreditRefund(refundDeps(), c.scope, refundId);

let eventSeq = 0;
/** Delivers a Razorpay webhook event and returns what processing it did. */
async function deliver(event: string, refund: { id: string; paymentId: string; amount: number }) {
  eventSeq += 1;
  const body = Buffer.from(
    JSON.stringify({
      entity: 'event',
      account_id: 'acc_StandIn',
      event,
      contains: ['refund'],
      payload: {
        refund: {
          entity: {
            id: refund.id,
            entity: 'refund',
            payment_id: refund.paymentId,
            amount: refund.amount,
          },
        },
      },
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
  const outcome = await processRazorpayReceipt(
    { db: dbs.app, razorpay, clock, notices: notices(), keyring },
    stored.receiptId,
  );
  expect(outcome).toBe('processed');
  const [row] = await adminQuery<{ summary: { result: string } }>(
    'SELECT summary FROM ops.webhook_receipts WHERE id = $1',
    [stored.receiptId],
  );
  return row!.summary.result;
}

async function wallet(c: Company) {
  const { wallet } = await billing().overview(c.ctx);
  return { availableMinor: wallet.availableMinor, heldMinor: wallet.heldMinor };
}

async function refundRow(refundId: string) {
  const [row] = await adminQuery<{
    status: string;
    amount_minor: number;
    topup_id: string;
    hold_id: string;
    reason: string;
    requested_by_user_id: string;
    provider_refund_id: string | null;
    attempts: number;
    next_attempt_at: Date;
    last_error: string | null;
    submitted_at: Date | null;
    processed_at: Date | null;
    failed_at: Date | null;
  }>(
    `SELECT status, amount_minor::int AS amount_minor, topup_id, hold_id, reason, requested_by_user_id,
            provider_refund_id, attempts, next_attempt_at, last_error, submitted_at, processed_at, failed_at
       FROM app.credit_refunds WHERE id = $1`,
    [refundId],
  );
  return row!;
}

async function holdOf(refundId: string) {
  const [row] = await adminQuery<{ status: string; amount_minor: number }>(
    `SELECT h.status, h.amount_minor::int AS amount_minor
       FROM app.wallet_holds h JOIN app.credit_refunds r ON r.tenant_id = h.tenant_id AND r.hold_id = h.id
      WHERE r.id = $1`,
    [refundId],
  );
  return row!;
}

async function topupRow(topupId: string) {
  const [row] = await adminQuery<{ status: string; refunded_minor: number }>(
    'SELECT status, refunded_minor::int AS refunded_minor FROM app.topups WHERE id = $1',
    [topupId],
  );
  return row!;
}

/** The refund calls HyFib made for a payment. */
const refundCalls = (paymentId: string) =>
  standIn.state.calls.filter(
    (call) => call.method === 'POST' && call.path === `/v1/payments/${paymentId}/refund`,
  );

const refundsWithKey = (refundId: string) =>
  [...standIn.state.refunds.values()].filter((r) => r.idempotencyKey === `crf_${refundId}`);

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

async function companyAudit(tenantId: string, action: string) {
  return adminQuery<{ subject_id: string; actor_type: string; metadata: Record<string, unknown> }>(
    'SELECT subject_id, actor_type, metadata FROM app.audit_events WHERE tenant_id = $1 AND action = $2',
    [tenantId, action],
  );
}

async function statementLabels(c: Company) {
  const statement = await history().statement(c.ctx, {
    month: formatMonth(monthOf(new Date(), c.ctx.tenant.timezone)),
  });
  return statement.lines.map((l) => ({
    label: l.label,
    available: l.availableChangeMinor,
    reserved: l.reservedChangeMinor,
    receipt: l.receiptNumber,
  }));
}

async function refused(promise: Promise<unknown>): Promise<string> {
  return (await refusal(promise)).code;
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

/** The PostgreSQL message behind a mapped error ("Operation not permitted." hides the reason). */
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

function minutesFromNow(at: Date): number {
  return (new Date(at).getTime() - Date.now()) / 60_000;
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
  owner = await platformActor('platform_owner', 'Platform Owner');
  operator = await platformActor('platform_operator', 'Platform Operator');
});

afterAll(async () => {
  await standIn.close();
  await boss.stop({ graceful: false });
  await dbs.close();
});

describe('asking for a refund', () => {
  it('sets the credit aside at once, audits the reason, and shows the request to staff and the company', async () => {
    const c = await company();
    const { topupId, payment } = await paidTopup(c, 50_000);
    const { refundId } = await ask(c, topupId, '200');

    expect(await wallet(c)).toEqual({ availableMinor: 30_000, heldMinor: 20_000 });
    const row = await refundRow(refundId);
    expect(row).toMatchObject({
      status: 'requested',
      amount_minor: 20_000,
      topup_id: topupId,
      reason: REASON,
      requested_by_user_id: owner.userId,
      provider_refund_id: null,
      attempts: 0,
    });
    expect(await holdOf(refundId)).toEqual({ status: 'held', amount_minor: 20_000 });
    const [hold] = await adminQuery<{ reference_type: string; reference_id: string; days: number }>(
      `SELECT reference_type, reference_id, extract(epoch FROM expires_at - created_at) / 86400 AS days
         FROM app.wallet_holds WHERE id = $1`,
      [row.hold_id],
    );
    expect(hold).toMatchObject({ reference_type: 'credit_refund', reference_id: refundId });
    expect(Number(hold!.days)).toBeCloseTo(90, 1);
    expect(
      await adminQuery(
        `SELECT kind, description, actor_type, actor_id FROM app.ledger_transactions
          WHERE tenant_id = $1 AND reference_type = 'credit_refund' AND reference_id = $2`,
        [c.tenantId, refundId],
      ),
    ).toEqual([
      {
        kind: 'hold',
        description: 'Reserved for a refund',
        actor_type: 'user',
        actor_id: owner.userId,
      },
    ]);
    expect(
      await adminQuery(
        `SELECT actor_user_id, reason, result, correlation_id, metadata FROM ops.platform_audit_events
          WHERE action = 'platform.credit_refund_requested' AND target_tenant_id = $1`,
        [c.tenantId],
      ),
    ).toEqual([
      {
        actor_user_id: owner.userId,
        reason: REASON,
        result: 'success',
        correlation_id: owner.correlationId,
        metadata: { refundId, topupId, amountMinor: 20_000 },
      },
    ]);

    // Operators see it too (read only); the reason and who asked are for staff.
    for (const actor of [owner, operator]) {
      const view = await staff().companyBilling(actor, c.tenantId);
      expect(view).toMatchObject({ availableMinor: 30_000, reservedMinor: 20_000 });
      expect(view.topups).toEqual([
        expect.objectContaining({
          id: topupId,
          amountMinor: 50_000,
          unrefundedMinor: 50_000,
          status: 'paid',
          paymentMethod: 'card',
          openRefund: { id: refundId, amountMinor: 20_000, status: 'requested' },
        }),
      ]);
      expect(view.refunds).toEqual([
        expect.objectContaining({
          id: refundId,
          topupId,
          status: 'requested',
          reason: REASON,
          requestedByName: 'Platform Owner',
        }),
      ]);
    }
    const overview = await billing().overview(c.ctx);
    expect(overview.refunds).toEqual([
      expect.objectContaining({ id: refundId, topupId, amountMinor: 20_000, status: 'requested' }),
    ]);
    expect(overview.transactions[0]).toMatchObject({
      kind: 'hold',
      referenceType: 'credit_refund',
      availableEffectMinor: -20_000,
    });
    expect((await history().receipt(c.ctx, topupId)).refundRequests).toEqual([
      expect.objectContaining({ id: refundId, amountMinor: 20_000, status: 'requested' }),
    ]);
    // The worker sends it: nothing reached Razorpay yet, and the request is due now.
    expect(refundCalls(payment.id)).toEqual([]);
    expect(await findDueCreditRefunds(dbs.app, 500)).toContainEqual({
      tenantId: c.tenantId,
      refundId,
    });
  });

  it('is for platform owners only, checked by the database as well as the service', async () => {
    const c = await company();
    const { topupId } = await paidTopup(c, 10_000);
    const input = { tenantId: c.tenantId, topupId, amount: '10', reason: REASON };
    expect(await refused(staff().requestRefund(operator, input))).toBe('forbidden');
    // A claimed role is not enough: the function looks the user up.
    const stranger = await createUser(dbs, { twoFactor: true });
    const claimed: PlatformActor = {
      userId: stranger.id,
      role: 'platform_owner',
      correlationId: uuidv7(),
    };
    expect(await refused(staff().requestRefund(claimed, input))).toBe('forbidden');
    expect(await refused(staff().companyBilling(claimed, c.tenantId))).toBe('forbidden');
    const direct = sql`select ops.platform_request_credit_refund(${c.tenantId}::uuid, ${topupId}::uuid,
      1000::bigint, ${REASON}, 'direct')`;
    expect(await refused(dbs.platform.run(operator.userId, (tx) => tx.execute(direct)))).toBe(
      'forbidden',
    );
    // The company role cannot call either function.
    expect(await databaseRefusal(dbs.app.run(c.scope, (tx) => tx.execute(direct)))).toMatch(
      /permission denied for function/,
    );
    expect(
      await databaseRefusal(
        dbs.app.run(c.scope, (tx) =>
          tx.execute(sql`select ops.platform_company_billing(${c.tenantId}::uuid)`),
        ),
      ),
    ).toMatch(/permission denied for function/);
    expect(await wallet(c)).toEqual({ availableMinor: 10_000, heldMinor: 0 });
    expect(
      await adminQuery('SELECT id FROM app.credit_refunds WHERE tenant_id = $1', [c.tenantId]),
    ).toEqual([]);
  });

  it('refuses a short reason, a bad amount, more than the payment or the unused credit, an unpaid payment and a second open refund', async () => {
    const c = await company();
    const { topupId } = await paidTopup(c, 30_000);
    const input = (amount: string, reason = REASON) => ({
      tenantId: c.tenantId,
      topupId,
      amount,
      reason,
    });
    for (const [amount, reason] of [
      ['10', 'too short'],
      ['0', REASON],
      ['ten', REASON],
      ['1.005', REASON],
      ['-5', REASON],
    ] as const) {
      expect(await refused(staff().requestRefund(owner, input(amount, reason))), amount).toBe(
        'validation_failed',
      );
    }
    expect(await refused(staff().requestRefund(owner, input('300.01')))).toBe(
      'precondition_failed',
    );
    // The function checks the reason and the amount by itself too.
    for (const [amount, reason] of [
      [1_000, 'short'],
      [0, REASON],
      [30_001, REASON],
    ] as const) {
      const direct = sql`select ops.platform_request_credit_refund(${c.tenantId}::uuid, ${topupId}::uuid,
        ${amount}::bigint, ${reason}, 'direct')`;
      expect(await refused(dbs.platform.run(owner.userId, (tx) => tx.execute(direct)))).toBe(
        'precondition_failed',
      );
    }

    // Spent credit is not refunded: ₹250 held for a running service leaves ₹50 unused.
    await dbs.app.run(c.scope, (tx) =>
      tx.execute(
        sql`select app.billing_hold(${`svc:${uuidv7()}`}, 25000::bigint, 'service', 'svc-1',
              now() + interval '1 day')`,
      ),
    );
    expect(await refused(ask(c, topupId, '50.01'))).toBe('insufficient_funds');
    const { refundId } = await ask(c, topupId, '50');
    expect(await wallet(c)).toEqual({ availableMinor: 0, heldMinor: 30_000 });
    expect(await refused(ask(c, topupId, '0.01'))).toBe('conflict');

    // Only a paid top-up of this company.
    const unpaid = await billing().startTopup(c.ctx, { amountMinor: 10_000 });
    expect(await refused(ask(c, unpaid.topupId, '10'))).toBe('precondition_failed');
    expect(await refused(ask(c, uuidv7(), '10'))).toBe('not_found');
    const other = await company();
    const { topupId: otherTopup } = await paidTopup(other, 10_000);
    expect(await refused(ask(c, otherTopup, '10'))).toBe('not_found');
    expect(
      await refused(
        staff().requestRefund(owner, {
          tenantId: uuidv7(),
          topupId,
          amount: '10',
          reason: REASON,
        }),
      ),
    ).toBe('not_found');
    expect((await refundRow(refundId)).status).toBe('requested');
  });
});

describe('sending the refund to Razorpay', () => {
  it('asks once with an idempotency key, emails the billing managers, and records the refund from the webhook', async () => {
    const c = await company();
    const { topupId, payment } = await paidTopup(c, 50_000);
    const { refundId } = await ask(c, topupId, '200');
    standIn.state.refundStatusOnCreate = 'pending';
    try {
      expect(await step(c, refundId)).toBe('submitted');
    } finally {
      standIn.state.refundStatusOnCreate = 'processed';
    }
    const calls = refundCalls(payment.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      headers: { 'x-refund-idempotency': `crf_${refundId}` },
      body: { amount: 20_000, speed: 'normal', notes: { hyfib_refund: refundId } },
    });
    const submitted = await refundRow(refundId);
    expect(submitted).toMatchObject({ status: 'submitted', attempts: 1, last_error: null });
    expect(submitted.provider_refund_id).toMatch(/^rfnd_/);
    expect(minutesFromNow(submitted.next_attempt_at)).toBeGreaterThan(14);
    expect(await findDueCreditRefunds(dbs.app, 500)).not.toContainEqual({
      tenantId: c.tenantId,
      refundId,
    });
    expect(await companyAudit(c.tenantId, 'billing.credit_refund_submitted')).toEqual([
      {
        subject_id: refundId,
        actor_type: 'provider',
        metadata: { amountMinor: 20_000, providerRefundId: submitted.provider_refund_id },
      },
    ]);
    const email = (await billingEmails(c.tenantId)).at(-1)!;
    expect(email.subject).toBe('HyFib is refunding service credit');
    expect(email.lines.join(' ')).toContain('₹200.00');
    expect(email.lines.join(' ')).toContain('5–7 working days');
    expect(email.url).toContain(`/billing/receipts/${topupId}`);
    expect(await wallet(c)).toEqual({ availableMinor: 30_000, heldMinor: 20_000 });

    // Razorpay processes it: the webhook records the refund and releases the hold together.
    const providerRefundId = submitted.provider_refund_id!;
    standIn.setRefundStatus(providerRefundId, 'processed');
    const refund = { id: providerRefundId, paymentId: payment.id, amount: 20_000 };
    expect(await deliver('refund.processed', refund)).toBe('recorded');
    expect(await refundRow(refundId)).toMatchObject({
      status: 'processed',
      provider_refund_id: providerRefundId,
      processed_at: expect.any(Date),
    });
    expect(await holdOf(refundId)).toEqual({ status: 'released', amount_minor: 20_000 });
    expect(await wallet(c)).toEqual({ availableMinor: 30_000, heldMinor: 0 });
    expect(await topupRow(topupId)).toEqual({
      status: 'partially_refunded',
      refunded_minor: 20_000,
    });
    const receipt = (await history().receipt(c.ctx, topupId)).receiptNumber;
    expect((await statementLabels(c)).slice(-3)).toEqual([
      { label: 'Reserved for a refund', available: -20_000, reserved: 20_000, receipt },
      { label: 'Refund reservation released', available: 20_000, reserved: -20_000, receipt },
      { label: 'Refund to card', available: -20_000, reserved: 0, receipt },
    ]);
    expect((await history().receipt(c.ctx, topupId)).refundRequests).toEqual([]);
    expect((await billing().overview(c.ctx)).refunds).toEqual([]);

    // Duplicates change nothing: the same webhook, the worker, another delivery.
    expect(await deliver('refund.processed', refund)).toBe('already_recorded');
    expect(await step(c, refundId)).toBe('done');
    expect(refundCalls(payment.id)).toHaveLength(1);
    expect(await wallet(c)).toEqual({ availableMinor: 30_000, heldMinor: 0 });
  });

  it('records a refund Razorpay processes at once, and one the worker finds processed when it checks', async () => {
    const c = await company();
    const { topupId } = await paidTopup(c, 50_000);
    const { refundId } = await ask(c, topupId, '500');
    expect(await step(c, refundId)).toBe('processed');
    expect(await refundRow(refundId)).toMatchObject({ status: 'processed' });
    expect(await wallet(c)).toEqual({ availableMinor: 0, heldMinor: 0 });
    expect(await topupRow(topupId)).toEqual({ status: 'refunded', refunded_minor: 50_000 });
    expect((await billingEmails(c.tenantId)).at(-1)!.subject).toBe(
      'HyFib is refunding service credit',
    );
    // Nothing is left to refund: the payment's status says so before any amount is looked at.
    expect(await refusal(ask(c, topupId, '1'))).toEqual({
      code: 'precondition_failed',
      message: 'Only a paid top-up that is not fully refunded can be refunded.',
    });

    const d = await company();
    const { topupId: dTopup, payment } = await paidTopup(d, 40_000);
    const { refundId: dRefund } = await ask(d, dTopup, '100');
    standIn.state.refundStatusOnCreate = 'pending';
    try {
      expect(await step(d, dRefund)).toBe('submitted');
    } finally {
      standIn.state.refundStatusOnCreate = 'processed';
    }
    await adminQuery(
      `UPDATE app.credit_refunds SET submitted_at = now() - interval '2 hours' WHERE id = $1`,
      [dRefund],
    );
    expect(await step(d, dRefund)).toBe('pending');
    const pending = await refundRow(dRefund);
    expect(pending.status).toBe('submitted');
    // Older than an hour: the next check is an hour away.
    expect(minutesFromNow(pending.next_attempt_at)).toBeGreaterThan(59);
    standIn.setRefundStatus(pending.provider_refund_id!, 'processed');
    expect(await step(d, dRefund)).toBe('processed');
    expect(await wallet(d)).toEqual({ availableMinor: 30_000, heldMinor: 0 });
    expect(
      await deliver('refund.processed', {
        id: pending.provider_refund_id!,
        paymentId: payment.id,
        amount: 10_000,
      }),
    ).toBe('already_recorded');
    expect(await wallet(d)).toEqual({ availableMinor: 30_000, heldMinor: 0 });
  });

  it('never makes a second refund when a response is lost or Razorpay is busy', async () => {
    const c = await company();
    const { topupId, payment } = await paidTopup(c, 50_000);
    const { refundId } = await ask(c, topupId, '150');

    standIn.state.queues.refund.push({ kind: 'process_then_drop' });
    expect(await step(c, refundId)).toBe('retry');
    const lost = await refundRow(refundId);
    expect(lost).toMatchObject({ status: 'requested', attempts: 1, provider_refund_id: null });
    expect(minutesFromNow(lost.next_attempt_at)).toBeGreaterThan(0.9);
    expect(minutesFromNow(lost.next_attempt_at)).toBeLessThan(1.1);
    expect(refundsWithKey(refundId)).toHaveLength(1);

    standIn.state.queues.refund.push({
      kind: 'error',
      status: 409,
      code: 'BAD_REQUEST_ERROR',
      description: 'A request with this idempotency key is being processed',
    });
    expect(await step(c, refundId)).toBe('retry');
    expect(minutesFromNow((await refundRow(refundId)).next_attempt_at)).toBeGreaterThan(4.9);
    standIn.state.queues.refund.push({ kind: 'error', status: 503 });
    expect(await step(c, refundId)).toBe('retry');
    expect(await refundRow(refundId)).toMatchObject({ status: 'requested', attempts: 3 });
    expect(await wallet(c)).toEqual({ availableMinor: 35_000, heldMinor: 15_000 });

    // The same key returns the refund Razorpay made on the first call.
    expect(await step(c, refundId)).toBe('processed');
    expect(refundCalls(payment.id)).toHaveLength(4);
    expect(
      new Set(refundCalls(payment.id).map((call) => call.headers['x-refund-idempotency'])),
    ).toEqual(new Set([`crf_${refundId}`]));
    expect(refundsWithKey(refundId)).toHaveLength(1);
    expect(await refundRow(refundId)).toMatchObject({
      status: 'processed',
      provider_refund_id: refundsWithKey(refundId)[0]!.id,
    });
    expect(await wallet(c)).toEqual({ availableMinor: 35_000, heldMinor: 0 });
    expect(await topupRow(topupId)).toEqual({
      status: 'partially_refunded',
      refunded_minor: 15_000,
    });
    // What is left of the payment bounds the next refund.
    expect(await refused(ask(c, topupId, '350.01'))).toBe('precondition_failed');
  });

  it('completes the request from a webhook that arrives before the worker stored the refund id', async () => {
    const c = await company();
    const { topupId, payment } = await paidTopup(c, 50_000);
    const { refundId } = await ask(c, topupId, '120');
    standIn.state.queues.refund.push({ kind: 'process_then_drop' });
    expect(await step(c, refundId)).toBe('retry');
    const [made] = refundsWithKey(refundId);
    expect(
      await deliver('refund.processed', { id: made!.id, paymentId: payment.id, amount: 12_000 }),
    ).toBe('recorded');
    expect(await refundRow(refundId)).toMatchObject({
      status: 'processed',
      provider_refund_id: made!.id,
    });
    expect(await wallet(c)).toEqual({ availableMinor: 38_000, heldMinor: 0 });
    expect(await step(c, refundId)).toBe('done');
    expect(refundCalls(payment.id)).toHaveLength(1);
  });

  it('gives the credit back when Razorpay refuses the refund', async () => {
    const c = await company();
    const { topupId, payment } = await paidTopup(c, 50_000);
    const { refundId } = await ask(c, topupId, '200');
    standIn.state.queues.refund.push({
      kind: 'error',
      status: 400,
      code: 'BAD_REQUEST_ERROR',
      description: 'Refunds are not enabled for this account',
    });
    expect(await step(c, refundId)).toBe('failed');
    expect(await refundRow(refundId)).toMatchObject({
      status: 'failed',
      provider_refund_id: null,
      last_error: 'BAD_REQUEST_ERROR: Refunds are not enabled for this account',
      failed_at: expect.any(Date),
    });
    expect(await holdOf(refundId)).toEqual({ status: 'released', amount_minor: 20_000 });
    expect(await wallet(c)).toEqual({ availableMinor: 50_000, heldMinor: 0 });
    expect(await topupRow(topupId)).toEqual({ status: 'paid', refunded_minor: 0 });
    const email = (await billingEmails(c.tenantId)).at(-1)!;
    expect(email.subject).toBe('A refund could not be completed');
    expect(email.lines.join(' ')).toContain('back in your available service credit');
    expect(await companyAudit(c.tenantId, 'billing.credit_refund_failed')).toEqual([
      {
        subject_id: refundId,
        actor_type: 'provider',
        metadata: { error: 'BAD_REQUEST_ERROR: Refunds are not enabled for this account' },
      },
    ]);
    expect((await history().receipt(c.ctx, topupId)).refundRequests).toEqual([
      expect.objectContaining({ id: refundId, status: 'failed', failedAt: expect.any(Date) }),
    ]);
    const labels = (await statementLabels(c)).slice(-2).map((l) => l.label);
    expect(labels).toEqual(['Reserved for a refund', 'Refund reservation released']);
    expect(await step(c, refundId)).toBe('done');
    expect(refundCalls(payment.id)).toHaveLength(1);

    // A new refund of the same payment can be asked for.
    const again = await ask(c, topupId, '200');
    expect(await step(c, again.refundId)).toBe('processed');
    expect(await wallet(c)).toEqual({ availableMinor: 30_000, heldMinor: 0 });
  });

  it('gives the credit back when Razorpay fails the refund later, from the webhook or the worker’s check', async () => {
    const c = await company();
    const { topupId, payment } = await paidTopup(c, 50_000);
    const { refundId } = await ask(c, topupId, '200');
    standIn.state.refundStatusOnCreate = 'pending';
    try {
      expect(await step(c, refundId)).toBe('submitted');
    } finally {
      standIn.state.refundStatusOnCreate = 'processed';
    }
    const providerRefundId = (await refundRow(refundId)).provider_refund_id!;
    const refund = { id: providerRefundId, paymentId: payment.id, amount: 20_000 };
    // The event is only a signal: Razorpay still reports the refund as pending.
    expect(await deliver('refund.failed', refund)).toBe('refund_not_failed');
    expect(await refundRow(refundId)).toMatchObject({ status: 'submitted' });
    expect(await wallet(c)).toEqual({ availableMinor: 30_000, heldMinor: 20_000 });
    standIn.setRefundStatus(providerRefundId, 'failed');
    expect(await deliver('refund.failed', refund)).toBe('credit_refund_failed');
    expect(await refundRow(refundId)).toMatchObject({
      status: 'failed',
      last_error: 'failed: Razorpay failed the refund',
    });
    expect(await wallet(c)).toEqual({ availableMinor: 50_000, heldMinor: 0 });
    expect(await deliver('refund.failed', refund)).toBe('already_settled');
    expect(await deliver('refund.processed', refund)).toBe('refund_pending');
    expect(
      (await billingEmails(c.tenantId)).filter(
        (e) => e.subject === 'A refund could not be completed',
      ),
    ).toHaveLength(1);

    // The worker's check finds a failed refund by itself.
    const second = await ask(c, topupId, '100');
    standIn.state.refundStatusOnCreate = 'pending';
    try {
      expect(await step(c, second.refundId)).toBe('submitted');
    } finally {
      standIn.state.refundStatusOnCreate = 'processed';
    }
    standIn.setRefundStatus((await refundRow(second.refundId)).provider_refund_id!, 'failed');
    expect(await step(c, second.refundId)).toBe('failed');
    expect(await wallet(c)).toEqual({ availableMinor: 50_000, heldMinor: 0 });

    // A failed refund HyFib did not ask for (a Dashboard refund) changes nothing.
    const dashboard = await razorpay.createRefund(payment.id, {
      amount: 5_000,
      idempotencyKey: `dashboard_${randomBytes(6).toString('hex')}`,
    });
    expect(dashboard.ok).toBe(true);
    if (!dashboard.ok) return;
    standIn.setRefundStatus(dashboard.data.id, 'failed');
    expect(
      await deliver('refund.failed', {
        id: dashboard.data.id,
        paymentId: payment.id,
        amount: 5_000,
      }),
    ).toBe('refund_failed_not_requested');
    expect(await wallet(c)).toEqual({ availableMinor: 50_000, heldMinor: 0 });
  });

  it('never fails a request that was processed', async () => {
    const c = await company();
    const { topupId } = await paidTopup(c, 50_000);
    const { refundId } = await ask(c, topupId, '200');
    expect(await step(c, refundId)).toBe('processed');
    expect(await failCreditRefund(refundDeps(), c.scope, refundId, 'late failure')).toBe('done');
    expect(await refundRow(refundId)).toMatchObject({ status: 'processed', last_error: null });
    expect(await wallet(c)).toEqual({ availableMinor: 30_000, heldMinor: 0 });
  });
});

describe('company isolation', () => {
  it('lets the company read its refunds without the reason, and never settle them itself', async () => {
    const c = await company();
    const { topupId } = await paidTopup(c, 50_000);
    const { refundId } = await ask(c, topupId, '200');
    const rows = await dbs.app.run(c.scope, (tx) =>
      tx.execute<{ id: string; status: string }>(
        sql`select id, status from app.credit_refunds where id = ${refundId}::uuid`,
      ),
    );
    expect(rows.rows).toEqual([{ id: refundId, status: 'requested' }]);
    const refusedStatement = (statement: ReturnType<typeof sql>) =>
      databaseRefusal(dbs.app.run(c.scope, (tx) => tx.execute(statement)));
    expect(
      await refusedStatement(
        sql`select reason from app.credit_refunds where id = ${refundId}::uuid`,
      ),
    ).toMatch(/permission denied/);
    expect(
      await refusedStatement(
        sql`select requested_by_user_id from app.credit_refunds where id = ${refundId}::uuid`,
      ),
    ).toMatch(/permission denied/);
    // Processed and failed are reachable only through the functions that also settle the hold.
    for (const status of ['processed', 'failed']) {
      expect(
        await refusedStatement(
          sql`update app.credit_refunds set status = ${status} where id = ${refundId}::uuid`,
        ),
      ).toMatch(/row-level security/);
    }
    expect(
      await refusedStatement(
        sql`update app.credit_refunds set amount_minor = 1 where id = ${refundId}::uuid`,
      ),
    ).toMatch(/permission denied/);
    expect(
      await refusedStatement(sql`delete from app.credit_refunds where id = ${refundId}::uuid`),
    ).toMatch(/permission denied/);
    expect(await refundRow(refundId)).toMatchObject({ status: 'requested', amount_minor: 20_000 });

    // Another company sees nothing and cannot act on it.
    const other = await company();
    const seen = await dbs.app.run(other.scope, (tx) =>
      tx.execute(sql`select id from app.credit_refunds where id = ${refundId}::uuid`),
    );
    expect(seen.rows).toEqual([]);
    expect(await step(other, refundId)).toBe('not_found');
    expect(await refused(failCreditRefund(refundDeps(), other.scope, refundId, 'forged'))).toBe(
      'not_found',
    );
    expect(await refundRow(refundId)).toMatchObject({ status: 'requested' });
    expect(await wallet(c)).toEqual({ availableMinor: 30_000, heldMinor: 20_000 });
  });
});
