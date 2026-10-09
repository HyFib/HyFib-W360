import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { Keyring, isAppError, uuidv7, type Clock, type RazorpayConfig } from '@w360/core';
import { authorizedTenantScope, sql, systemScope } from '@w360/db';
import {
  JobSigner,
  PgBossJobQueue,
  RazorpayClient,
  addDays,
  alertPostBody,
  alertSettlementReconFindings,
  alertUnsettledPayments,
  applyRefundById,
  createBillingService,
  createPlanAdminService,
  createPlatformReconciliationService,
  findDueSettlementRecons,
  indiaDate,
  outboxAad,
  resolveTenantContext,
  runSettlementRecon,
  syncPlanSubscription,
  type BillingNoticeDeps,
  type BillingProviderDeps,
  type PlatformActor,
  type SettlementReconItemView,
  type TenantContext,
} from '@w360/domain';
import { connectTestDatabases, createTenant, createUser, type TestDatabases } from './helpers';
import {
  startRazorpayStandIn,
  type RazorpayStandIn,
  type StandInReconItem,
} from '../support/razorpay-stand-in';

/**
 * Daily settlement reconciliation (P5-05, ADR-059) against real PostgreSQL and the test-only
 * Razorpay stand-in: the daily schedule, matching every kind of settled transaction against HyFib's
 * records (companies found only through HyFib's own mappings), recording what HyFib missed through
 * the usual paths exactly once, flagging what does not match, running a day again, paging,
 * Razorpay failures, attempts that lost their claim, staff access and the unsettled-payments check.
 */
const KEY_ID = 'rzp_test_StandIn00000005';
const KEY_SECRET = randomBytes(16).toString('hex');
const REASON = 'Daily check, ticket 2041';

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
    webhookSecrets: [randomBytes(16).toString('hex')],
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
const recon = () => createPlatformReconciliationService({ platformDb: dbs.platform });
const deps = (): BillingProviderDeps => ({ db: dbs.app, razorpay, clock, notices: notices() });

async function adminQuery<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await dbs.adminPool.query<T>(text, params)).rows;
}

interface Company {
  tenantId: string;
  name: string;
  ctx: TenantContext;
}

async function company(label: string): Promise<Company> {
  const user = await createUser(dbs, { name: `${label} Owner` });
  const tenant = await createTenant(dbs, user);
  const name = `Company ${tenant.slug}`;
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
  return { tenantId: tenant.id, name, ctx };
}

async function platformActor(role: PlatformActor['role'], name: string): Promise<PlatformActor> {
  const user = await createUser(dbs, { name, twoFactor: true });
  await dbs.ownerPool.query('INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, $2)', [
    user.id,
    role,
  ]);
  return { userId: user.id, role, correlationId: uuidv7() };
}

/** A top-up with its Razorpay order, not paid yet. */
async function openTopup(c: Company, amountMinor: number) {
  const topup = await billing().startTopup(c.ctx, { amountMinor });
  return { topupId: topup.topupId, orderId: topup.orderId };
}

/** A paid top-up through the real path: order, Checkout payment, confirmation fetch. */
async function paidTopup(c: Company, amountMinor: number) {
  const topup = await openTopup(c, amountMinor);
  const payment = standIn.pay(topup.orderId);
  await billing().confirmTopupCheckout(c.ctx, {
    topupId: topup.topupId,
    paymentId: payment.id,
    signature: createHmac('sha256', KEY_SECRET)
      .update(`${topup.orderId}|${payment.id}`)
      .digest('hex'),
  });
  return { ...topup, payment };
}

/** A refund made in the Razorpay Dashboard: HyFib hears nothing about it. */
async function dashboardRefund(paymentId: string, amount: number) {
  const refund = await razorpay.createRefund(paymentId, {
    amount,
    idempotencyKey: `dash_${randomBytes(6).toString('hex')}`,
  });
  if (!refund.ok) throw new Error(`stand-in refused the refund: ${refund.description}`);
  return refund.data;
}

async function available(c: Company) {
  return (await billing().overview(c.ctx)).wallet.availableMinor;
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

let rawSeq = 0;
/** A settlement report item as Razorpay documents it (R-111), with notes a customer could fill. */
function raw(overrides: StandInReconItem): StandInReconItem {
  rawSeq += 1;
  return {
    entity_id: `pay_Raw${String(rawSeq).padStart(10, '0')}`,
    type: 'payment',
    debit: 0,
    credit: 9_800,
    amount: 10_000,
    currency: 'INR',
    fee: 200,
    tax: 30,
    on_hold: false,
    settled: true,
    created_at: 1_790_000_000,
    settled_at: 1_790_100_000,
    settlement_id: 'setl_Extra0000001',
    posted_at: null,
    credit_type: 'default',
    description: 'Customer note from jane@example.com',
    notes: { email: 'jane@example.com', phone: '+919999999999' },
    payment_id: null,
    settlement_utr: 'UTREXTRA00001',
    order_id: null,
    order_receipt: 'jane@example.com',
    method: 'upi',
    card_network: 'Visa',
    card_issuer: 'HDFC',
    card_type: 'credit',
    dispute_id: null,
    ...overrides,
  };
}

/** A day (India time) relative to today. */
const day = (offset: number) => addDays(indiaDate(new Date()), offset);

async function runDay(date: string, options?: { pageSize?: number; maxPages?: number }) {
  const { runId } = await recon().requestDay(owner, { date, reason: REASON });
  return { runId, result: await runSettlementRecon(deps(), runId, options) };
}

async function itemsOf(date: string): Promise<Map<string, SettlementReconItemView>> {
  const detail = await recon().run(owner, date);
  if (!detail) throw new Error(`no run for ${date}`);
  return new Map(detail.items.map((i) => [i.entityId, i]));
}

async function runRow(runId: string) {
  const [row] = await adminQuery<{
    status: string;
    attempts: number;
    next_attempt_at: Date;
    last_error: string | null;
    item_count: number;
    matched_count: number;
    recorded_count: number;
    attention_count: number;
    credit_minor: string;
    debit_minor: string;
    fee_minor: string;
    tax_minor: string;
    settlement_count: number;
    removed_count: number;
  }>('SELECT * FROM ops.settlement_recon_runs WHERE id = $1', [runId]);
  return row!;
}

const reconCalls = () =>
  standIn.state.calls.filter((c) => c.path === '/v1/settlements/recon/combined');

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return { code: error.code, message: error.publicMessage };
    throw error;
  }
  throw new Error('expected the call to be refused');
}

/** The PostgreSQL message behind a failed statement. */
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
  owner = await platformActor('platform_owner', 'Recon Platform Owner');
  operator = await platformActor('platform_operator', 'Recon Platform Operator');
});

afterAll(async () => {
  await standIn.close();
  await boss.stop({ graceful: false });
  await dbs.close();
});

describe('the daily schedule', () => {
  it('owes the previous day in India, fills a week of gaps after the first run, and never backfills before it', async () => {
    // At 10:00 India time twenty days ago: only the day before, since nothing was reconciled yet.
    const first = new Date(`${day(-20)}T04:30:00Z`);
    const due = await findDueSettlementRecons(dbs.app, first);
    expect(due.map((d) => d.date)).toEqual([day(-21)]);
    // Three days later the gap since the first run is filled; the first day is still due.
    const later = await findDueSettlementRecons(dbs.app, new Date(`${day(-17)}T04:30:00Z`));
    expect(later.map((d) => d.date)).toEqual([day(-21), day(-20), day(-19), day(-18)]);
    const created = await adminQuery<{ d: string }>(
      `SELECT settlement_date::text AS d FROM ops.settlement_recon_runs
        WHERE settlement_date < $1::date ORDER BY 1`,
      [day(-21)],
    );
    expect(created).toEqual([]);
    // Asking again adds nothing, and a day that is not over is refused by the database.
    await findDueSettlementRecons(dbs.app, new Date(`${day(-17)}T04:30:00Z`));
    const [count] = await adminQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM ops.settlement_recon_runs
        WHERE settlement_date BETWEEN $1::date AND $2::date`,
      [day(-21), day(-18)],
    );
    expect(count!.n).toBe(4);
    expect(
      await databaseRefusal(
        dbs.app.run(systemScope, (tx) =>
          tx.execute(sql`select * from ops.settlement_recon_due(${day(0)}::date, 10)`),
        ),
      ),
    ).toMatch(/only a day that is over/);
  });
});

describe('matching a settled day', () => {
  const D1 = day(-40);
  let a: Company;
  let b: Company;
  const f: Record<string, string> = {};
  const expected = { credit: 0, debit: 0, fee: 0, tax: 0 };
  let balanceBefore = 0;

  it('records what HyFib missed through the usual paths, once, and matches the rest', async () => {
    a = await company('Recon Alpha Traders');
    b = await company('Recon Beta Stores');
    // Credited normally, then refunded twice in the Dashboard: one refund recorded, one missed.
    const t1 = await paidTopup(a, 50_000);
    const missedRefund = await dashboardRefund(t1.payment.id, 10_000);
    const recordedRefund = await dashboardRefund(t1.payment.id, 5_000);
    expect(await applyRefundById(deps(), t1.payment.id, recordedRefund.id)).toBe('recorded');
    // Paid at Razorpay, but HyFib never heard: the checkout was abandoned before confirmation.
    const t2 = await openTopup(a, 30_000);
    const missedPayment = standIn.pay(t2.orderId);
    // Another company's payment, matched to that company.
    const t7 = await paidTopup(b, 40_000);
    Object.assign(f, {
      t1: t1.topupId,
      t2: t2.topupId,
      t7: t7.topupId,
      p1: t1.payment.id,
      p2: missedPayment.id,
      p7: t7.payment.id,
      missedRefund: missedRefund.id,
      recordedRefund: recordedRefund.id,
    });
    // A card mandate's authorisation payment and its refund.
    const [customer] = await adminQuery<{ id: string }>(
      `INSERT INTO app.billing_customers (id, tenant_id, provider_customer_id, email, contact)
       VALUES ($1, $2, 'cust_ReconAlpha01', 'billing@alpha.test', '+919000000001') RETURNING id`,
      [uuidv7(), a.tenantId],
    );
    await adminQuery(
      `INSERT INTO app.payment_mandates (id, tenant_id, billing_customer_id, authorization_order_id,
          authorization_payment_id, authorization_refund_id, provider_token_id, status,
          max_amount_minor)
       VALUES ($1, $2, $3, 'order_ReconMandate01', 'pay_ReconMandate01', 'rfnd_ReconMandate01',
               'token_ReconMandate01', 'active', 100000)`,
      [uuidv7(), a.tenantId, customer!.id],
    );
    balanceBefore = await available(a);
    const emailsBefore = (await billingEmails(a.tenantId)).length;

    const items = standIn.settle(D1, {
      paymentIds: [t1.payment.id, missedPayment.id, t7.payment.id],
      refundIds: [missedRefund.id, recordedRefund.id],
      extra: [
        raw({ entity_id: 'pay_ReconMandate01', amount: 100, credit: 98, fee: 2, tax: 0 }),
        raw({
          entity_id: 'rfnd_ReconMandate01',
          type: 'refund',
          amount: 100,
          debit: 100,
          credit: 0,
          fee: 0,
          tax: 0,
          payment_id: 'pay_ReconMandate01',
        }),
      ],
    });
    for (const item of items) {
      expected.credit += Number(item.credit);
      expected.debit += Number(item.debit);
      expected.fee += Number(item.fee);
      expected.tax += Number(item.tax);
    }
    const { runId, result } = await runDay(D1);
    expect(result).toMatchObject({ outcome: 'completed', date: D1, items: 7, recorded: 2 });

    const byId = await itemsOf(D1);
    expect(byId.get(f.p1!)).toMatchObject({
      status: 'matched',
      reason: null,
      tenantId: a.tenantId,
      companyName: a.name,
      topupId: f.t1,
      hyfibAmountMinor: 50_000,
    });
    expect(byId.get(f.p2!)).toMatchObject({
      status: 'recorded',
      reason: 'credited',
      tenantId: a.tenantId,
      topupId: f.t2,
    });
    expect(byId.get(f.missedRefund!)).toMatchObject({
      status: 'recorded',
      reason: 'refund_recorded',
      tenantId: a.tenantId,
      topupId: f.t1,
    });
    expect(byId.get(f.recordedRefund!)).toMatchObject({
      status: 'matched',
      reason: null,
      topupId: f.t1,
      hyfibAmountMinor: 5_000,
    });
    expect(byId.get(f.p7!)).toMatchObject({
      status: 'matched',
      tenantId: b.tenantId,
      companyName: b.name,
      topupId: f.t7,
    });
    expect(byId.get('pay_ReconMandate01')).toMatchObject({
      status: 'matched',
      reason: 'mandate_authorization',
      tenantId: a.tenantId,
      topupId: null,
    });
    expect(byId.get('rfnd_ReconMandate01')).toMatchObject({
      status: 'matched',
      reason: 'mandate_authorization',
    });

    // The missed payment is credited and the missed refund taken, once each, through the usual paths.
    expect(await available(a)).toBe(balanceBefore + 30_000 - 10_000);
    const [credited] = await adminQuery<{ status: string; provider_payment_id: string }>(
      'SELECT status, provider_payment_id FROM app.topups WHERE id = $1',
      [f.t2],
    );
    expect(credited).toEqual({ status: 'paid', provider_payment_id: f.p2 });
    const ledger = await adminQuery<{ key: string }>(
      `SELECT idempotency_key AS key FROM app.ledger_transactions
        WHERE tenant_id = $1 AND idempotency_key IN ($2, $3)`,
      [a.tenantId, `topup:${f.t2}`, `refund:${f.missedRefund}`],
    );
    expect(ledger).toHaveLength(2);
    const emails = await billingEmails(a.tenantId);
    expect(emails.slice(emailsBefore).map((e) => e.subject)).toEqual([
      'Payment received: service credit added',
    ]);
    const audit = await adminQuery<{ actor_type: string }>(
      `SELECT actor_type FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'billing.topup_credited' AND subject_id = $2`,
      [a.tenantId, f.t2],
    );
    expect(audit).toEqual([{ actor_type: 'provider' }]);

    const run = await runRow(runId);
    expect(run).toMatchObject({
      status: 'completed',
      attempts: 1,
      last_error: null,
      item_count: 7,
      matched_count: 5,
      recorded_count: 2,
      attention_count: 0,
      removed_count: 0,
      settlement_count: 2,
    });
    expect(Number(run.credit_minor)).toBe(expected.credit);
    expect(Number(run.debit_minor)).toBe(expected.debit);
    expect(Number(run.fee_minor)).toBe(expected.fee);
    expect(Number(run.tax_minor)).toBe(expected.tax);
    // Notes, descriptions, receipts and card fields are never stored.
    const stored = await adminQuery<{ row: string }>(
      `SELECT row_to_json(i)::text AS row FROM ops.settlement_recon_items i WHERE i.run_id = $1`,
      [runId],
    );
    for (const { row } of stored) {
      expect(row).not.toMatch(/jane@example|9999999999|Visa|HDFC|Customer note/);
    }
  });

  it('flags what does not match or is not HyFib’s, and changes nothing for it', async () => {
    const D = day(-39);
    const t3 = await paidTopup(a, 20_000);
    const t6 = await paidTopup(a, 10_000);
    const fullRefund = await dashboardRefund(t6.payment.id, 10_000);
    expect(await applyRefundById(deps(), t6.payment.id, fullRefund.id)).toBe('recorded');
    // Razorpay reports one more processed refund of the fully refunded payment.
    standIn.state.refunds.set('rfnd_ReconExtra0001', {
      id: 'rfnd_ReconExtra0001',
      paymentId: t6.payment.id,
      amount: 1_000,
      status: 'processed',
      idempotencyKey: null,
    });
    // A second payment on an order another payment already paid, and its refund.
    const second = standIn.pay(t3.orderId);
    const secondRefund = await dashboardRefund(second.id, 5_000);
    // A payment on a top-up's order that Razorpay reports refunded (never credited).
    const t4 = await openTopup(a, 15_000);
    const refundedPayment = standIn.pay(t4.orderId);
    standIn.setPaymentStatus(refundedPayment.id, 'refunded');
    // A refund Razorpay has not processed yet.
    standIn.state.refundStatusOnCreate = 'pending';
    const pendingRefund = await dashboardRefund(t3.payment.id, 2_000);
    standIn.state.refundStatusOnCreate = 'processed';
    const t5 = await openTopup(a, 12_000);
    // A credited payment with a dispute, and a payment HyFib missed with a dispute.
    const t10 = await paidTopup(a, 10_000);
    const t11 = await openTopup(b, 11_000);
    const disputedMissed = standIn.pay(t11.orderId);
    const balance = await available(a);
    const balanceB = await available(b);

    standIn.settle(D, {
      paymentIds: [second.id, refundedPayment.id],
      refundIds: [fullRefund.id, secondRefund.id, pendingRefund.id, 'rfnd_ReconExtra0001'],
      extra: [
        // HyFib's payment, but not HyFib's amount.
        raw({ entity_id: t3.payment.id, order_id: t3.orderId, amount: 25_000 }),
        // A payment on a top-up's order that Razorpay cannot return.
        raw({ entity_id: 'pay_ReconGone000001', order_id: t5.orderId }),
        // A refund of HyFib's payment that Razorpay cannot return.
        raw({
          entity_id: 'rfnd_ReconGone00001',
          type: 'refund',
          debit: 500,
          credit: 0,
          amount: 500,
          fee: 0,
          tax: 0,
          payment_id: t3.payment.id,
        }),
        // Another payment on a card mandate's authorisation order.
        raw({ entity_id: 'pay_ReconMandate02', order_id: 'order_ReconMandate01', amount: 100 }),
        raw({ entity_id: 'pay_ReconOther00001', order_id: 'order_ReconOther01' }),
        raw({
          entity_id: 'rfnd_ReconOther0001',
          type: 'refund',
          debit: 1_000,
          credit: 0,
          amount: 1_000,
          fee: 0,
          tax: 0,
          payment_id: 'pay_ReconOther00002',
        }),
        raw({ entity_id: 'trf_ReconTransfer01', type: 'transfer', debit: 1_000, credit: 0 }),
        raw({ entity_id: 'adj_ReconAdjust0001', type: 'adjustment', credit: 1_012 }),
        raw({ entity_id: 'pay_ReconDisputed01', dispute_id: 'disp_ReconDispute01' }),
        raw({
          entity_id: t10.payment.id,
          order_id: t10.orderId,
          dispute_id: 'disp_ReconDispute02',
        }),
        raw({
          entity_id: disputedMissed.id,
          order_id: t11.orderId,
          amount: 11_000,
          dispute_id: 'disp_ReconDispute03',
        }),
        raw({ entity_id: 'pay_ReconDollars001', currency: 'USD' }),
        raw({ entity_id: 'rev_ReconReversal01', type: 'reversal' }),
        raw({ entity_id: undefined }),
      ],
    });
    const { runId, result } = await runDay(D);
    expect(result).toMatchObject({ outcome: 'completed', items: 20, recorded: 0 });
    const byId = await itemsOf(D);
    const reason = (entityId: string) => {
      const item = byId.get(entityId);
      return item ? `${item.status}:${item.reason ?? ''}` : 'missing';
    };
    expect(reason(fullRefund.id)).toBe('matched:');
    expect(reason(second.id)).toBe('mismatch:second_payment');
    expect(byId.get(second.id)).toMatchObject({ tenantId: a.tenantId, topupId: t3.topupId });
    expect(reason(secondRefund.id)).toBe('matched:uncredited_payment_refund');
    expect(reason(refundedPayment.id)).toBe('mismatch:not_captured');
    expect(reason(pendingRefund.id)).toBe('mismatch:refund_not_processed');
    expect(reason('rfnd_ReconExtra0001')).toBe('mismatch:refund_exceeds_payment');
    expect(reason(t3.payment.id)).toBe('mismatch:amount_differs');
    expect(byId.get(t3.payment.id)).toMatchObject({
      amountMinor: 25_000,
      hyfibAmountMinor: 20_000,
    });
    expect(reason('pay_ReconGone000001')).toBe('mismatch:payment_unavailable');
    expect(reason('rfnd_ReconGone00001')).toBe('mismatch:refund_unavailable');
    expect(reason('pay_ReconMandate02')).toBe('mismatch:mandate_payment');
    expect(reason('pay_ReconOther00001')).toBe('not_hyfib:unknown_payment');
    expect(byId.get('pay_ReconOther00001')).toMatchObject({ tenantId: null, companyName: null });
    expect(reason('rfnd_ReconOther0001')).toBe('not_hyfib:unknown_refund');
    expect(reason('trf_ReconTransfer01')).toBe('not_hyfib:transfer');
    expect(reason('adj_ReconAdjust0001')).toBe('review:adjustment');
    // A dispute on what HyFib matched or recorded is for a person; one on a transaction already
    // waiting for a person keeps that transaction's own reason.
    expect(reason(t10.payment.id)).toBe('review:dispute');
    expect(byId.get(t10.payment.id)).toMatchObject({
      tenantId: a.tenantId,
      topupId: t10.topupId,
      disputeId: 'disp_ReconDispute02',
    });
    expect(reason(disputedMissed.id)).toBe('review:dispute');
    expect(byId.get(disputedMissed.id)).toMatchObject({
      tenantId: b.tenantId,
      topupId: t11.topupId,
    });
    expect(reason('pay_ReconDisputed01')).toBe('not_hyfib:unknown_payment');
    expect(byId.get('pay_ReconDisputed01')?.disputeId).toBe('disp_ReconDispute01');
    expect(reason('pay_ReconDollars001')).toBe('review:currency');
    expect(reason('rev_ReconReversal01')).toBe('review:unknown_type');
    expect(byId.get('rev_ReconReversal01')).toMatchObject({
      type: 'other',
      providerType: 'reversal',
    });
    const unreadable = [...byId.values()].find((i) => i.reason === 'unreadable');
    expect(unreadable).toMatchObject({ type: 'other', status: 'review', amountMinor: 0 });
    expect(unreadable?.entityId).toMatch(/^unreadable:\d+$/);

    // Nothing was credited or taken for any of them, except the missed payment with a dispute: it
    // was credited as its webhook would have been, and waits for a person.
    expect(await available(a)).toBe(balance);
    expect(await available(b)).toBe(balanceB + 11_000);
    const [t4Row] = await adminQuery<{ status: string }>(
      'SELECT status FROM app.topups WHERE id = $1',
      [t4.topupId],
    );
    expect(t4Row!.status).toBe('awaiting_payment');
    const run = await runRow(runId);
    expect(run).toMatchObject({ matched_count: 2, recorded_count: 0, attention_count: 18 });
    // Staff see what needs a person first.
    const detail = await recon().run(owner, D);
    const firstMatched = detail!.items.findIndex((i) => i.status === 'matched');
    expect(detail!.items.slice(0, firstMatched).every((i) => i.status !== 'matched')).toBe(true);
    expect(detail!.run.openCount).toBe(18);
  });

  it('runs a day again without recording anything twice, keeping what an earlier attempt recorded and people’s resolutions', async () => {
    const before = await available(a);
    const emails = (await billingEmails(a.tenantId)).length;
    // A platform owner resolves one item, and Razorpay's report for the day loses one item.
    standIn.settle(D1, {
      paymentIds: [],
      refundIds: [],
      extra: [raw({ entity_id: 'pay_ReconLater0001' })],
    });
    const first = await runDay(D1);
    expect(first.result.outcome).toBe('completed');
    const later = (await itemsOf(D1)).get('pay_ReconLater0001');
    expect(later?.status).toBe('not_hyfib');
    await recon().resolveItem(owner, {
      itemId: later!.id,
      note: 'Payment for the old website, checked with finance',
    });
    const reported = standIn.state.settlements.get(D1)!;
    standIn.state.settlements.set(
      D1,
      reported.filter((i) => i.entity_id !== 'pay_ReconMandate01'),
    );
    standIn.state.settlements.get(D1)!.push(raw({ entity_id: 'pay_ReconLater0002' }));

    const again = await runDay(D1);
    expect(again.result).toMatchObject({ outcome: 'completed', recorded: 0 });
    const byId = await itemsOf(D1);
    expect(byId.get(f.p2!)).toMatchObject({ status: 'recorded', reason: 'credited' });
    expect(byId.get(f.missedRefund!)).toMatchObject({
      status: 'recorded',
      reason: 'refund_recorded',
    });
    expect(byId.get('pay_ReconLater0001')).toMatchObject({
      status: 'not_hyfib',
      resolutionNote: 'Payment for the old website, checked with finance',
      resolvedByName: 'Recon Platform Owner',
    });
    expect(byId.has('pay_ReconMandate01')).toBe(false);
    expect(byId.get('pay_ReconLater0002')?.status).toBe('not_hyfib');
    expect(await runRow(again.runId)).toMatchObject({
      status: 'completed',
      attempts: 1,
      recorded_count: 2,
      removed_count: 1,
      item_count: 8,
    });
    // No second credit, refund or email.
    expect(await available(a)).toBe(before);
    expect((await billingEmails(a.tenantId)).length).toBe(emails);
    const [ledger] = await adminQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.ledger_transactions
        WHERE tenant_id = $1 AND idempotency_key IN ($2, $3)`,
      [a.tenantId, `topup:${f.t2}`, `refund:${f.missedRefund}`],
    );
    expect(ledger!.n).toBe(2);
    const audit = await adminQuery<{ action: string; reason: string }>(
      `SELECT action, reason FROM ops.platform_audit_events
        WHERE actor_user_id = $1 AND action LIKE 'platform.settlement_%' ORDER BY occurred_at`,
      [owner.userId],
    );
    expect(
      audit.filter((e) => e.action === 'platform.settlement_recon_requested').length,
    ).toBeGreaterThanOrEqual(4);
    expect(audit).toContainEqual({
      action: 'platform.settlement_item_resolved',
      reason: 'Payment for the old website, checked with finance',
    });
  });
});

describe('reading the report', () => {
  it('reads every page, and fails a day larger than it reads', async () => {
    const D = day(-60);
    standIn.settle(D, {
      paymentIds: [],
      refundIds: [],
      extra: [1, 2, 3, 4, 5].map((n) => raw({ entity_id: `pay_ReconPage0000${n}` })),
    });
    const callsBefore = reconCalls().length;
    const paged = await runDay(D, { pageSize: 2 });
    expect(paged.result).toMatchObject({ outcome: 'completed', items: 5 });
    expect(
      reconCalls()
        .slice(callsBefore)
        .map((c) => [c.query.year, c.query.month, c.query.day, c.query.count, c.query.skip]),
    ).toEqual([
      [D.slice(0, 4), D.slice(5, 7), D.slice(8, 10), '2', '0'],
      [D.slice(0, 4), D.slice(5, 7), D.slice(8, 10), '2', '2'],
      [D.slice(0, 4), D.slice(5, 7), D.slice(8, 10), '2', '4'],
    ]);
    // A last page that is exactly full needs one more request to see the end.
    const E = day(-61);
    standIn.settle(E, {
      paymentIds: [],
      refundIds: [],
      extra: [1, 2, 3, 4].map((n) => raw({ entity_id: `pay_ReconEven0000${n}` })),
    });
    expect((await runDay(E, { pageSize: 2 })).result).toMatchObject({
      outcome: 'completed',
      items: 4,
    });
    const big = await runDay(D, { pageSize: 2, maxPages: 2 });
    expect(big.result.outcome).toBe('failed');
    expect(await runRow(big.runId)).toMatchObject({
      status: 'failed',
      last_error: 'The day has more than 4 transactions, more than HyFib reads in one run.',
    });
  });

  it('tries again after a failure that may pass, fails on a refusal, and gives up after six attempts', async () => {
    const D = day(-62);
    standIn.settle(D, { paymentIds: [], refundIds: [], extra: [raw({})] });
    standIn.state.queues.recon.push({ kind: 'error', status: 503, description: 'Busy' });
    const busy = await runDay(D);
    expect(busy.result.outcome).toBe('deferred');
    let run = await runRow(busy.runId);
    expect(run.status).toBe('pending');
    expect(run.last_error).toBe('Razorpay could not answer (HTTP 503, SERVER_ERROR): Busy');
    const wait = (new Date(run.next_attempt_at).getTime() - Date.now()) / 60_000;
    expect(wait).toBeGreaterThan(4);
    expect(wait).toBeLessThan(6);
    // Not due yet: nobody claims it, and the schedule does not hand it out.
    expect(await runSettlementRecon(deps(), busy.runId)).toEqual({ outcome: 'not_claimable' });
    const due = await findDueSettlementRecons(dbs.app, new Date(`${day(-61)}T04:30:00Z`));
    expect(due.map((d) => d.runId)).not.toContain(busy.runId);
    // A dropped connection is retried too (the read is safe to repeat).
    await adminQuery('UPDATE ops.settlement_recon_runs SET next_attempt_at = now() WHERE id = $1', [
      busy.runId,
    ]);
    standIn.state.queues.recon.push({ kind: 'drop' });
    expect((await runSettlementRecon(deps(), busy.runId)).outcome).toBe('deferred');
    run = await runRow(busy.runId);
    expect(run).toMatchObject({ status: 'pending', attempts: 2 });
    expect(run.last_error).toMatch(/^No usable answer from Razorpay/);
    const second = (new Date(run.next_attempt_at).getTime() - Date.now()) / 60_000;
    expect(second).toBeGreaterThan(14);
    // Refused keys fail the run until a platform owner runs it again.
    await adminQuery('UPDATE ops.settlement_recon_runs SET next_attempt_at = now() WHERE id = $1', [
      busy.runId,
    ]);
    standIn.state.queues.recon.push({
      kind: 'error',
      status: 401,
      description: 'The api key provided is invalid',
    });
    expect((await runSettlementRecon(deps(), busy.runId)).outcome).toBe('failed');
    run = await runRow(busy.runId);
    expect(run.status).toBe('failed');
    expect(run.last_error).toBe(
      "Razorpay refused HyFib's API keys (HTTP 401): The api key provided is invalid",
    );
    expect(await runSettlementRecon(deps(), busy.runId)).toEqual({ outcome: 'not_claimable' });
    // A request Razorpay refuses fails at once too.
    const again = await recon().requestDay(owner, { date: D, reason: REASON });
    standIn.state.queues.recon.push({
      kind: 'error',
      status: 400,
      description: 'The month is not a valid month.',
    });
    expect((await runSettlementRecon(deps(), again.runId)).outcome).toBe('failed');
    // The sixth attempt is the last.
    await recon().requestDay(owner, { date: D, reason: REASON });
    await adminQuery('UPDATE ops.settlement_recon_runs SET attempts = 5 WHERE id = $1', [
      again.runId,
    ]);
    standIn.state.queues.recon.push({ kind: 'error', status: 500 });
    expect((await runSettlementRecon(deps(), again.runId)).outcome).toBe('failed');
    expect(await runRow(again.runId)).toMatchObject({ status: 'failed', attempts: 6 });
    // Run again, it completes.
    await recon().requestDay(owner, { date: D, reason: REASON });
    expect((await runSettlementRecon(deps(), again.runId)).outcome).toBe('completed');
    // A sixth attempt whose worker stopped is not tried a seventh time: the schedule fails the run.
    await adminQuery(
      `UPDATE ops.settlement_recon_runs
          SET status = 'running', attempts = 6, lease_until = now() - interval '1 second'
        WHERE id = $1`,
      [again.runId],
    );
    expect(await runSettlementRecon(deps(), again.runId)).toEqual({ outcome: 'not_claimable' });
    await findDueSettlementRecons(dbs.app, new Date(`${day(-61)}T04:30:00Z`));
    expect(await runRow(again.runId)).toMatchObject({
      status: 'failed',
      attempts: 6,
      last_error: 'The worker stopped before the attempt finished.',
    });
  });

  it('tries again when Razorpay cannot answer while a missed payment is recorded, keeping what it recorded', async () => {
    const c = await company('Recon Gamma Retail');
    const t8 = await openTopup(c, 22_000);
    const t8b = await openTopup(c, 13_000);
    const payment = standIn.pay(t8.orderId);
    const later = standIn.pay(t8b.orderId);
    const D = day(-63);
    standIn.settle(D, { paymentIds: [payment.id, later.id], refundIds: [] });
    const balance = await available(c);
    // The first missed payment is recorded; Razorpay cannot answer for the second.
    standIn.state.queues.fetch.push(
      { kind: 'ok' },
      { kind: 'error', status: 502, description: 'Bad gateway' },
    );
    const first = await runDay(D);
    expect(first.result.outcome).toBe('deferred');
    expect((await runRow(first.runId)).last_error).toMatch(
      new RegExp(
        `^Razorpay could not answer while recording ${later.id}: payment fetch: retryable`,
      ),
    );
    expect(await available(c)).toBe(balance + 22_000);
    await adminQuery('UPDATE ops.settlement_recon_runs SET next_attempt_at = now() WHERE id = $1', [
      first.runId,
    ]);
    expect(await runSettlementRecon(deps(), first.runId)).toMatchObject({
      outcome: 'completed',
      recorded: 1,
    });
    // The next attempt finds the first payment credited, and still shows that the check recorded it.
    const byId = await itemsOf(D);
    expect(byId.get(payment.id)).toMatchObject({ status: 'recorded', reason: 'credited' });
    expect(byId.get(later.id)).toMatchObject({ status: 'recorded', reason: 'credited' });
    expect(await runRow(first.runId)).toMatchObject({ recorded_count: 2, attempts: 2 });
    expect(await available(c)).toBe(balance + 22_000 + 13_000);
  });

  it('stops writing once another attempt holds the run', async () => {
    const D = day(-64);
    standIn.settle(D, { paymentIds: [], refundIds: [], extra: [raw({})] });
    const { runId } = await recon().requestDay(owner, { date: D, reason: REASON });
    standIn.state.queues.recon.push({
      kind: 'before',
      run: async () => {
        // The attempt's lease runs out while it waits for Razorpay, and another attempt claims.
        await adminQuery(
          `UPDATE ops.settlement_recon_runs SET lease_until = now() - interval '1 second' WHERE id = $1`,
          [runId],
        );
        await dbs.app.run(systemScope, (tx) =>
          tx.execute(sql`select * from ops.settlement_recon_claim(${runId}::uuid, 900)`),
        );
      },
    });
    expect(await runSettlementRecon(deps(), runId)).toEqual({ outcome: 'superseded', date: D });
    expect(await runRow(runId)).toMatchObject({ status: 'running', attempts: 2, item_count: 0 });
    const [items] = await adminQuery<{ n: number }>(
      'SELECT count(*)::int AS n FROM ops.settlement_recon_items WHERE run_id = $1',
      [runId],
    );
    expect(items!.n).toBe(0);
    // The stale attempt's writes are refused by the database.
    expect(
      await databaseRefusal(
        dbs.app.run(systemScope, (tx) =>
          tx.execute(sql`select ops.settlement_recon_complete(${runId}::uuid, 1)`),
        ),
      ),
    ).toMatch(/no longer current/);
    const [late] = await dbs.app.run(
      systemScope,
      async (tx) =>
        (
          await tx.execute<{ deferred: string | null; failed: boolean }>(
            sql`select ops.settlement_recon_defer(${runId}::uuid, 1, 'late') as deferred,
                       ops.settlement_recon_fail(${runId}::uuid, 1, 'late') as failed`,
          )
        ).rows,
    );
    expect(late).toEqual({ deferred: null, failed: false });
    expect(await runRow(runId)).toMatchObject({ status: 'running', last_error: null });
    // A run already held is not claimed again, and a platform owner cannot restart it meanwhile.
    expect(await runSettlementRecon(deps(), runId)).toEqual({ outcome: 'not_claimable' });
    expect(await refusal(recon().requestDay(owner, { date: D, reason: REASON }))).toEqual({
      code: 'conflict',
      message: 'This day is being reconciled now; wait for it to finish.',
    });
    await adminQuery(
      `UPDATE ops.settlement_recon_runs SET lease_until = now() - interval '1 second' WHERE id = $1`,
      [runId],
    );
    expect((await runSettlementRecon(deps(), runId)).outcome).toBe('completed');
    expect(await runRow(runId)).toMatchObject({ status: 'completed', attempts: 3, item_count: 1 });
  });
});

describe('platform staff', () => {
  it('lets operators read, platform owners run days and resolve with a note, and no runtime role touch the tables', async () => {
    const D = day(-70);
    standIn.settle(D, {
      paymentIds: [],
      refundIds: [],
      extra: [raw({ entity_id: 'pay_ReconStaff00001' })],
    });
    await runDay(D);
    const runs = await recon().runs(operator);
    expect(runs.find((r) => r.date === D)).toMatchObject({
      status: 'completed',
      itemCount: 1,
      attentionCount: 1,
      openCount: 1,
      requestedByName: 'Recon Platform Owner',
    });
    const item = (await recon().run(operator, D))!.items[0]!;
    expect(await refusal(recon().requestDay(operator, { date: D, reason: REASON }))).toMatchObject({
      code: 'forbidden',
    });
    expect(
      await refusal(
        recon().resolveItem(operator, { itemId: item.id, note: 'Checked with finance' }),
      ),
    ).toMatchObject({ code: 'forbidden' });
    // The database refuses operators too.
    expect(
      await databaseRefusal(
        dbs.platform.run(operator.userId, (tx) =>
          tx.execute(sql`select ops.platform_request_settlement_recon(${D}::date, ${REASON}, 'c')`),
        ),
      ),
    ).toBe('Only a platform owner can run a reconciliation.');
    expect(
      await databaseRefusal(
        dbs.platform.run(operator.userId, (tx) =>
          tx.execute(
            sql`select ops.platform_resolve_settlement_item(${item.id}::uuid, 'Checked with finance', 'c')`,
          ),
        ),
      ),
    ).toBe('Only a platform owner can resolve a reconciliation item.');
    // Someone who is not platform staff reads nothing.
    const stranger = await createUser(dbs, { name: 'Recon Stranger', twoFactor: true });
    expect(
      await databaseRefusal(
        dbs.platform.run(stranger.id, (tx) =>
          tx.execute(sql`select ops.platform_settlement_recon_runs(10)`),
        ),
      ),
    ).toBe('platform administrator required');

    expect(await refusal(recon().requestDay(owner, { date: D, reason: 'short' }))).toMatchObject({
      code: 'validation_failed',
    });
    // The database checks the reason and the note too.
    expect(
      await databaseRefusal(
        dbs.platform.run(owner.userId, (tx) =>
          tx.execute(sql`select ops.platform_request_settlement_recon(${D}::date, 'short', 'c')`),
        ),
      ),
    ).toBe('Give a reason of at least 10 characters.');
    expect(
      await databaseRefusal(
        dbs.platform.run(owner.userId, (tx) =>
          tx.execute(
            sql`select ops.platform_resolve_settlement_item(${item.id}::uuid, 'short', 'c')`,
          ),
        ),
      ),
    ).toBe('Write a note of at least 10 characters.');
    expect(await refusal(recon().requestDay(owner, { date: day(0), reason: REASON }))).toEqual({
      code: 'precondition_failed',
      message: 'Choose a day that is over (India time).',
    });
    expect(await refusal(recon().requestDay(owner, { date: day(-400), reason: REASON }))).toEqual({
      code: 'precondition_failed',
      message: 'Choose a day within the last year.',
    });
    expect(
      await refusal(recon().resolveItem(owner, { itemId: item.id, note: 'short' })),
    ).toMatchObject({
      code: 'validation_failed',
    });
    await recon().resolveItem(owner, { itemId: item.id, note: 'Checked with finance, not ours' });
    expect(
      await refusal(
        recon().resolveItem(owner, { itemId: item.id, note: 'Checked with finance again' }),
      ),
    ).toEqual({ code: 'conflict', message: 'This item is already resolved.' });
    const [audit] = await adminQuery<{ reason: string; metadata: Record<string, unknown> }>(
      `SELECT reason, metadata FROM ops.platform_audit_events
        WHERE action = 'platform.settlement_item_resolved' AND metadata->>'itemId' = $1`,
      [item.id],
    );
    expect(audit).toEqual({
      reason: 'Checked with finance, not ours',
      metadata: {
        itemId: item.id,
        settlementDate: D,
        type: 'payment',
        entityId: 'pay_ReconStaff00001',
        status: 'not_hyfib',
        reason: 'unknown_payment',
        amountMinor: 10_000,
        tenantId: null,
      },
    });
    expect((await recon().runs(owner)).find((r) => r.date === D)?.openCount).toBe(0);
    // A matched item needs no resolution.
    const matchedItem = [...(await itemsOf(day(-40))).values()].find((i) => i.status === 'matched');
    expect(
      await refusal(
        recon().resolveItem(owner, { itemId: matchedItem!.id, note: 'Nothing to do here' }),
      ),
    ).toEqual({
      code: 'precondition_failed',
      message: 'Only an item that needs a person can be resolved.',
    });

    // Neither runtime role can read or write the tables; each reaches only its own functions.
    for (const pool of [dbs.appPool, dbs.platformPool]) {
      await expect(pool.query('SELECT * FROM ops.settlement_recon_items')).rejects.toThrow(
        /permission denied/,
      );
      await expect(pool.query('SELECT * FROM ops.settlement_recon_runs')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        pool.query(`UPDATE ops.settlement_recon_items SET status = 'matched'`),
      ).rejects.toThrow(/permission denied/);
    }
    await expect(
      dbs.appPool.query('SELECT ops.platform_settlement_recon_runs(10)'),
    ).rejects.toThrow(/permission denied for function/);
    await expect(
      dbs.platformPool.query(`SELECT * FROM ops.settlement_recon_due('2020-01-01', 1)`),
    ).rejects.toThrow(/permission denied for function/);
    await expect(
      dbs.platformPool.query(
        `SELECT ops.settlement_recon_record_items('${uuidv7()}', 1, '[]'::jsonb)`,
      ),
    ).rejects.toThrow(/permission denied for function/);
  });
});

describe('payments not seen in a settlement', () => {
  it('lists a paid top-up 7 days after its payment when every day was reconciled, until a settlement shows it', async () => {
    const c = await company('Recon Delta Foods');
    const t9 = await paidTopup(c, 60_000);
    // A payment refunded in full may never be settled: it is not listed.
    const t12 = await paidTopup(c, 30_000);
    const refund = await dashboardRefund(t12.payment.id, 30_000);
    expect(await applyRefundById(deps(), t12.payment.id, refund.id)).toBe('recorded');
    const D0 = day(-300);
    // Paid at noon India time on D0.
    await adminQuery(
      `UPDATE app.topups SET paid_at = ($2::date + time '06:30') AT TIME ZONE 'UTC'
        WHERE id = ANY ($1::uuid[])`,
      [[t9.topupId, t12.topupId], D0],
    );
    for (let offset = 0; offset < 7; offset += 1) {
      expect((await runDay(addDays(D0, offset))).result.outcome).toBe('completed');
    }
    // Seven completed days are not enough: the eighth, 7 days after the payment, is needed.
    expect((await recon().unsettled(owner)).topups.map((t) => t.id)).not.toContain(t9.topupId);
    expect((await runDay(addDays(D0, 7))).result.outcome).toBe('completed');
    const report = await recon().unsettled(operator);
    expect(report.topups.map((t) => t.id)).not.toContain(t12.topupId);
    expect(report.topups.find((t) => t.id === t9.topupId)).toMatchObject({
      tenantId: c.tenantId,
      companyName: c.name,
      amountMinor: 60_000,
      status: 'paid',
      paymentId: t9.payment.id,
      kind: 'manual',
    });
    // The report counts the days without a completed run before the latest one.
    const completed = new Set(
      (
        await adminQuery<{ d: string }>(
          `SELECT settlement_date::text AS d FROM ops.settlement_recon_runs WHERE status = 'completed'`,
        )
      ).map((r) => r.d),
    );
    const sorted = [...completed].sort();
    const latest = sorted[sorted.length - 1]!;
    expect(report.latestDay).toBe(latest);
    let missing = 0;
    for (let d = [addDays(latest, -29), sorted[0]!].sort()[1]!; d <= latest; d = addDays(d, 1)) {
      if (!completed.has(d)) missing += 1;
    }
    expect(report.daysWithoutRun).toBe(missing);
    // Settled on the next day: no longer listed.
    standIn.settle(addDays(D0, 8), { paymentIds: [t9.payment.id], refundIds: [] });
    expect((await runDay(addDays(D0, 8))).result.outcome).toBe('completed');
    expect((await recon().unsettled(owner)).topups.map((t) => t.id)).not.toContain(t9.topupId);
  });
});

describe('plan subscription payments (ADR-063)', () => {
  it('matches recorded plan payments, records a missed one by syncing its subscription, and records a missed refund of one (ADR-103)', async () => {
    const D = day(-50);
    const c = await company('Recon Epsilon Plans');
    const plans = createPlanAdminService({ platformDb: dbs.platform, clock });
    const { id: planId } = await plans.createPlan(owner, {
      code: `recon-sub-${Date.now().toString(36)}`,
      name: 'Recon Plan',
      price: '1180',
      intervalMonths: '1',
      trialDays: '0',
      graceDays: '0',
      seatsIncluded: '3',
      numbersIncluded: '1',
      modules: [],
    });
    await plans.publishPlan(owner, planId);
    // The company's subscription at Razorpay, paid in Checkout, and HyFib's record of it.
    const rzpPlan = await razorpay.createPlan({
      period: 'monthly',
      amount: 118_000,
      currency: 'INR',
      name: 'HyFib Recon Plan plan',
    });
    if (!rzpPlan.ok) throw new Error('plan');
    const rzpSub = await razorpay.createSubscription({
      planId: rzpPlan.data.id,
      totalCount: 60,
      expireBy: Math.floor(Date.now() / 1000) + 3600,
      customerNotify: true,
    });
    if (!rzpSub.ok) throw new Error('subscription');
    const first = standIn.authorizeSubscription(rzpSub.data.id);
    const subscriptionId = uuidv7();
    // A subscription pays for the plan the company is on (0088's guard), so the company is put on it.
    await adminQuery(
      `UPDATE app.tenant_plans SET plan_id = $1, status = 'trialing',
         trial_ends_at = now() + interval '14 days' WHERE tenant_id = $2`,
      [planId, c.tenantId],
    );
    await adminQuery(
      `INSERT INTO app.plan_subscriptions (id, tenant_id, plan_id, status, interval_months, extra_seats,
         extra_numbers, run_packs, subtotal_minor, tax_bp, tax_minor, amount_minor, total_count,
         provider_plan_id, provider_subscription_id, authorize_by, created_by_user_id)
       VALUES ($1, $2, $3, 'created', 1, 0, 0, 0, 100000, 1800, 18000, 118000, 60, $4, $5,
               now() + interval '1 hour', $6)`,
      [subscriptionId, c.tenantId, planId, rzpPlan.data.id, rzpSub.data.id, c.ctx.user.id],
    );
    const scope = authorizedTenantScope(c.tenantId, null);
    await syncPlanSubscription(deps(), scope, subscriptionId);
    // The renewal Razorpay charged, whose events HyFib never received.
    const renewal = standIn.chargeSubscription(rzpSub.data.id);
    const planPaymentCount = async () =>
      (
        await adminQuery<{ n: number }>(
          'SELECT count(*)::int AS n FROM app.plan_payments WHERE subscription_id = $1',
          [subscriptionId],
        )
      )[0]!.n;
    expect(await planPaymentCount()).toBe(1);
    // Another integration's subscription on the same account.
    const otherPlan = await razorpay.createPlan({
      period: 'monthly',
      amount: 20_000,
      currency: 'INR',
      name: 'Not HyFib',
    });
    if (!otherPlan.ok) throw new Error('plan');
    const otherSub = await razorpay.createSubscription({
      planId: otherPlan.data.id,
      totalCount: 12,
      expireBy: Math.floor(Date.now() / 1000) + 3600,
      customerNotify: true,
    });
    if (!otherSub.ok) throw new Error('subscription');
    const foreign = standIn.authorizeSubscription(otherSub.data.id);
    // A refund of the first plan payment, made in the Dashboard.
    const refund = await dashboardRefund(first.payment.id, 5_000);

    standIn.settle(D, {
      paymentIds: [first.payment.id, renewal.payment.id, foreign.payment.id],
      refundIds: [refund.id],
    });
    const { result } = await runDay(D);
    expect(result).toMatchObject({ outcome: 'completed', items: 4, recorded: 2 });
    const byId = await itemsOf(D);
    expect(byId.get(first.payment.id)).toMatchObject({
      status: 'matched',
      reason: 'plan_payment',
      tenantId: c.tenantId,
      topupId: null,
      hyfibAmountMinor: 118_000,
    });
    expect(byId.get(renewal.payment.id)).toMatchObject({
      status: 'recorded',
      reason: 'plan_payment_recorded',
      tenantId: c.tenantId,
      hyfibAmountMinor: 118_000,
    });
    expect(byId.get(foreign.payment.id)).toMatchObject({
      status: 'not_hyfib',
      reason: 'unknown_payment',
      tenantId: null,
    });
    // The Dashboard refund of a plan payment is fetched and recorded, as its webhook would have.
    expect(byId.get(refund.id)).toMatchObject({
      status: 'recorded',
      reason: 'refund_recorded',
      tenantId: c.tenantId,
    });
    const planRefunds = async () =>
      adminQuery<{ origin: string; status: string; amount_minor: number }>(
        `SELECT origin, status, amount_minor::int AS amount_minor FROM app.plan_payment_refunds
          WHERE provider_refund_id = $1`,
        [refund.id],
      );
    expect(await planRefunds()).toEqual([
      { origin: 'razorpay', status: 'processed', amount_minor: 5_000 },
    ]);
    expect(await planPaymentCount()).toBe(2);

    // The day again: the missed payment and refund are now matched, nothing is recorded twice.
    const again = await runDay(D);
    expect(again.result).toMatchObject({ outcome: 'completed', items: 4 });
    expect((await itemsOf(D)).get(renewal.payment.id)).toMatchObject({
      status: 'recorded',
      reason: 'plan_payment_recorded',
    });
    expect(await planPaymentCount()).toBe(2);
    expect(await planRefunds()).toHaveLength(1);
    // The report showing the recorded refund for another amount: the difference waits for a person.
    const refundItem = standIn.state.settlements.get(D)!.find((i) => i.entity_id === refund.id)!;
    refundItem.amount = 4_000;
    await runDay(D);
    expect((await itemsOf(D)).get(refund.id)).toMatchObject({
      status: 'mismatch',
      reason: 'amount_differs',
      tenantId: c.tenantId,
      hyfibAmountMinor: 5_000,
    });
    expect(await planRefunds()).toHaveLength(1);

    // A later renewal the report shows for another amount than Razorpay's payment: it is recorded
    // from the payment, and the difference waits for a person.
    const D2 = day(-51);
    const later = standIn.chargeSubscription(rzpSub.data.id);
    standIn.settle(D2, { paymentIds: [later.payment.id], refundIds: [] });
    const reported = standIn.state.settlements
      .get(D2)!
      .find((item) => item.entity_id === later.payment.id)!;
    reported.amount = 117_000;
    const third = await runDay(D2);
    expect(third.result).toMatchObject({ outcome: 'completed', items: 1 });
    expect((await itemsOf(D2)).get(later.payment.id)).toMatchObject({
      status: 'mismatch',
      reason: 'amount_differs',
      tenantId: c.tenantId,
      hyfibAmountMinor: 118_000,
    });
    expect(await planPaymentCount()).toBe(3);
  });
});

describe('alerts for platform owners (ADR-066, ADR-071)', () => {
  const CLOSING =
    'Platform owners resolve each transaction with a note, or run a failed day again, on Platform → Reconciliation.';
  const alertSweep = () =>
    alertSettlementReconFindings({
      db: dbs.app,
      outbox: notices().outbox,
      appBaseUrl: 'http://localhost:3000',
    });
  const label = (date: string) =>
    new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' }).format(
      new Date(`${date}T00:00:00Z`),
    );
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
  const emailOf = async (userId: string) =>
    (
      await adminQuery<{ email: string }>('SELECT email FROM auth.users WHERE id = $1', [userId])
    )[0]!.email;

  /** Platform notices queued since `since`, with their recipients. */
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
      payload: JSON.parse(keyring.decryptString(r.payload_ciphertext, outboxAad(r.id))) as {
        kind: string;
        subject: string;
        lines: string[];
        url: string;
        actionLabel: string;
      },
    }));
  }

  it('emails every platform owner once when a day waits for a person or fails, never for clean or retrying days', async () => {
    // Whatever earlier tests left due is emailed first, so this test sees only its own days.
    await alertSweep();
    const since = await dbNow();
    const owners = await ownerEmails();
    const operatorEmail = await emailOf(operator.userId);
    expect(owners).toContain(await emailOf(owner.userId));
    expect(owners).not.toContain(operatorEmail);

    const waiting = day(-71);
    const clean = day(-72);
    const retrying = day(-73);
    const refused = day(-74);
    standIn.settle(waiting, { paymentIds: [], refundIds: [], extra: [raw({})] });
    const c = await company('Recon Alerts Clean');
    const t = await paidTopup(c, 10_000);
    standIn.settle(clean, { paymentIds: [t.payment.id], refundIds: [] });
    standIn.settle(retrying, { paymentIds: [], refundIds: [], extra: [raw({})] });
    standIn.settle(refused, { paymentIds: [], refundIds: [], extra: [raw({})] });
    expect((await runDay(waiting)).result.outcome).toBe('completed');
    expect((await runDay(clean)).result.outcome).toBe('completed');
    standIn.state.queues.recon.push({ kind: 'error', status: 503, description: 'Busy' });
    const retry = await runDay(retrying);
    expect(retry.result.outcome).toBe('deferred');
    standIn.state.queues.recon.push({
      kind: 'error',
      status: 401,
      description: 'The api key provided is invalid',
    });
    const refusal = await runDay(refused);
    expect(refusal.result.outcome).toBe('failed');

    expect(await alertSweep()).toEqual({
      alerted: 2,
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
        payload: {
          kind: 'platform.notice',
          subject: 'Settlement reconciliation needs a person for 2 days',
          lines: [
            `${label(refused)}: the check failed and waits for a platform owner to run the day again. The last error: Razorpay refused HyFib's API keys (HTTP 401): The api key provided is invalid`,
            `${label(waiting)}: 1 transaction waits for a person (1 is not HyFib’s).`,
            CLOSING,
          ],
          url: 'http://localhost:3000/platform/reconciliation',
          actionLabel: 'Open reconciliation',
        },
      });
    }

    // Once: nothing more for the same attempts, however often the sweep runs.
    expect(await alertSweep()).toEqual({ alerted: 0, unsent: 0, recipients: 0, posted: false });
    expect(await platformNotices(since)).toHaveLength(owners.length);

    // The retrying day fails for good on its sixth attempt, and that is emailed.
    await adminQuery(
      'UPDATE ops.settlement_recon_runs SET attempts = 5, next_attempt_at = now() WHERE id = $1',
      [retry.runId],
    );
    standIn.state.queues.recon.push({ kind: 'error', status: 500 });
    expect((await runSettlementRecon(deps(), retry.runId)).outcome).toBe('failed');
    const since2 = await dbNow();
    expect(await alertSweep()).toMatchObject({ alerted: 1 });
    const failedNotice = (await platformNotices(since2))[0]!.payload;
    expect(failedNotice.subject).toBe(`Settlement reconciliation for ${label(retrying)} failed`);
    expect(failedNotice.url).toBe(`http://localhost:3000/platform/reconciliation/${retrying}`);
    expect(failedNotice.lines[0]).toMatch(/^.*: the check failed .* The last error: Razorpay /);

    // Running a failed day again starts a new attempt, and its outcome is emailed again.
    const since3 = await dbNow();
    expect((await runDay(refused)).result.outcome).toBe('completed');
    expect(await alertSweep()).toMatchObject({ alerted: 1 });
    expect((await platformNotices(since3)).map((n) => n.payload.subject)).toEqual(
      owners.map(() => `Settlement reconciliation for ${label(refused)} needs a person`),
    );
    // Running it again with the same transaction still open emails that attempt too.
    expect((await runDay(refused)).result.outcome).toBe('completed');
    expect(await alertSweep()).toMatchObject({ alerted: 1 });
  });

  it('skips a day whose transactions were resolved first, emails once when sweeps overlap, and waits for a platform owner', async () => {
    await alertSweep();
    const owners = await ownerEmails();
    const resolved = day(-75);
    const overlap = day(-76);
    standIn.settle(resolved, { paymentIds: [], refundIds: [], extra: [raw({})] });
    standIn.settle(overlap, { paymentIds: [], refundIds: [], extra: [raw({})] });
    expect((await runDay(resolved)).result.outcome).toBe('completed');
    expect((await runDay(overlap)).result.outcome).toBe('completed');
    // Resolved before any sweep saw it: nothing is waiting, so nothing is emailed.
    const [item] = [...(await itemsOf(resolved)).values()];
    await recon().resolveItem(owner, {
      itemId: item!.id,
      note: 'Payment for the old website, checked with finance',
    });

    // The mark refuses on its own too: an attempt with nothing open, a run still retrying, and an
    // attempt that is not the run's current one.
    const mark = async (runId: string, attempt: number) =>
      (
        await dbs.appPool.query(
          'SELECT * FROM ops.settlement_recon_mark_alerted($1::uuid, $2::int)',
          [runId, attempt],
        )
      ).rows;
    const runOf = async (date: string) =>
      (
        await adminQuery<{ id: string; attempt_seq: number }>(
          'SELECT id, attempt_seq FROM ops.settlement_recon_runs WHERE settlement_date = $1',
          [date],
        )
      )[0]!;
    const resolvedRun = await runOf(resolved);
    expect(await mark(resolvedRun.id, resolvedRun.attempt_seq)).toEqual([]);
    const overlapRun = await runOf(overlap);
    expect(await mark(overlapRun.id, overlapRun.attempt_seq - 1)).toEqual([]);
    const pending = day(-78);
    standIn.settle(pending, { paymentIds: [], refundIds: [], extra: [raw({})] });
    standIn.state.queues.recon.push({ kind: 'error', status: 503, description: 'Busy' });
    expect((await runDay(pending)).result.outcome).toBe('deferred');
    const pendingRun = await runOf(pending);
    expect(await mark(pendingRun.id, pendingRun.attempt_seq)).toEqual([]);

    const since = await dbNow();
    const [first, second] = await Promise.all([alertSweep(), alertSweep()]);
    expect(first.alerted + second.alerted).toBe(1);
    const sent = await platformNotices(since);
    expect(sent.map((n) => n.to).sort()).toEqual(owners);
    expect(new Set(sent.map((n) => n.payload.subject))).toEqual(
      new Set([`Settlement reconciliation for ${label(overlap)} needs a person`]),
    );

    // With no platform owner, a day that needs a person stays due until there is one.
    const nobody = day(-77);
    standIn.settle(nobody, { paymentIds: [], refundIds: [], extra: [raw({})] });
    expect((await runDay(nobody)).result.outcome).toBe('completed');
    const demoted = await adminQuery<{ user_id: string }>(
      `UPDATE ops.platform_admins SET role = 'platform_operator' WHERE role = 'platform_owner'
       RETURNING user_id`,
    );
    try {
      expect(await alertSweep()).toEqual({ alerted: 0, unsent: 1, recipients: 0, posted: false });
    } finally {
      await adminQuery(
        `UPDATE ops.platform_admins SET role = 'platform_owner' WHERE user_id = ANY($1::text[])`,
        [demoted.map((r) => r.user_id)],
      );
    }
    const since2 = await dbNow();
    expect(await alertSweep()).toEqual({
      alerted: 1,
      unsent: 0,
      recipients: owners.length,
      posted: false,
    });
    expect((await platformNotices(since2)).map((n) => n.payload.subject)).toEqual(
      owners.map(() => `Settlement reconciliation for ${label(nobody)} needs a person`),
    );
  });

  const unsettledSweep = () =>
    alertUnsettledPayments({
      db: dbs.app,
      outbox: notices().outbox,
      appBaseUrl: 'http://localhost:3000',
    });
  /** Moves top-ups' payment to `time` UTC on `date`, noon in India by default (a fixture step). */
  const setPaidAt = (topupIds: string[], date: string, time = '06:30') =>
    adminQuery(
      `UPDATE app.topups SET paid_at = ($2::date + $3::time) AT TIME ZONE 'UTC'
        WHERE id = ANY ($1::uuid[])`,
      [topupIds, date, time],
    );
  const reconcile = async (from: string, days: number) => {
    for (let offset = 0; offset < days; offset += 1) {
      expect((await runDay(addDays(from, offset))).result.outcome).toBe('completed');
    }
  };
  const alertedPayments = async () =>
    new Set(
      (
        await adminQuery<{ payment_id: string }>(
          'SELECT payment_id FROM ops.settlement_unsettled_alerts',
        )
      ).map((r) => r.payment_id),
    );

  it('emails every platform owner once about each paid top-up no settlement showed, and the list says when (ADR-071)', async () => {
    // Whatever earlier tests left on the list is emailed first, so this test sees only its own.
    await unsettledSweep();
    const owners = await ownerEmails();
    const c = await company('Recon Unsettled Alerts');
    const D0 = day(-250);
    const a = await paidTopup(c, 11_000);
    const b = await paidTopup(c, 12_000);
    const later = await paidTopup(c, 13_000);
    const settled = await paidTopup(c, 14_000);
    // Refunded in part, it still waits for a settlement (one refunded in full may never have one).
    const partly = await paidTopup(c, 15_000);
    const refund = await dashboardRefund(partly.payment.id, 5_000);
    expect(await applyRefundById(deps(), partly.payment.id, refund.id)).toBe('recorded');
    // Paid at 20:00 UTC the day before: 01:30 on D0 in India, where Razorpay counts its days.
    const lateEvening = await paidTopup(c, 16_000);
    await setPaidAt([a.topupId, b.topupId, settled.topupId, partly.topupId], D0);
    await setPaidAt([lateEvening.topupId], addDays(D0, -1), '20:00');
    await setPaidAt([later.topupId], addDays(D0, 2));
    // Settled two days after its payment, as usual: never on the list.
    standIn.settle(addDays(D0, 2), { paymentIds: [settled.payment.id], refundIds: [] });
    await reconcile(D0, 7);
    // Until the day 7 days after the payments is reconciled, nothing is due.
    expect(await unsettledSweep()).toEqual({ alerted: 0, unsent: 0, recipients: 0, posted: false });
    await reconcile(addDays(D0, 7), 1);

    const since = await dbNow();
    expect(await unsettledSweep()).toEqual({
      alerted: 4,
      unsent: 0,
      recipients: owners.length,
      posted: false,
    });
    const sent = await platformNotices(since);
    expect(sent.map((n) => n.to).sort()).toEqual(owners);
    for (const n of sent) {
      expect(n.tenantId).toBeNull();
      expect(n.payload).toMatchObject({
        kind: 'platform.notice',
        subject: '4 paid top-ups were not settled within 7 days',
        url: 'http://localhost:3000/platform/reconciliation',
        actionLabel: 'Open reconciliation',
      });
      expect(n.payload.lines[0]).toContain(`paid on ${label(D0)} (India time)`);
      const text = JSON.stringify(n.payload);
      for (const kept of [a.payment.id, b.payment.id, c.name, a.topupId]) {
        expect(text).not.toContain(kept);
      }
    }
    const alerted = await alertedPayments();
    expect(
      [a, b, partly, lateEvening, later, settled].map((t) => alerted.has(t.payment.id)),
    ).toEqual([true, true, true, true, false, false]);
    // The list says when owners were emailed, and every payment it lists has been emailed.
    const report = await recon().unsettled(owner, 500);
    expect(report.topups.find((t) => t.id === a.topupId)?.alertedAt).toBeInstanceOf(Date);
    expect(report.topups.find((t) => t.id === partly.topupId)?.status).toBe('partially_refunded');
    expect(report.topups.map((t) => t.id)).not.toContain(settled.topupId);
    for (const t of report.topups) expect(alerted.has(t.paymentId), t.paymentId).toBe(true);
    // Nothing more however often the sweep runs.
    const since2 = await dbNow();
    expect(await unsettledSweep()).toEqual({ alerted: 0, unsent: 0, recipients: 0, posted: false });
    expect(await platformNotices(since2)).toEqual([]);

    // The later payment is due once the 7 days after it are reconciled: emailed on its own.
    await reconcile(addDays(D0, 8), 2);
    const since3 = await dbNow();
    expect(await unsettledSweep()).toMatchObject({ alerted: 1 });
    expect(
      (await platformNotices(since3)).map((n) => [n.payload.subject, n.payload.lines[0]]),
    ).toEqual(
      owners.map(() => [
        'A paid top-up was not settled within 7 days',
        expect.stringContaining(`paid on ${label(addDays(D0, 2))} (India time)`),
      ]),
    );
  });

  it('records a payment once when sweeps overlap, checks each again when marking, and waits for a platform owner (ADR-071)', async () => {
    await unsettledSweep();
    const owners = await ownerEmails();
    const c = await company('Recon Unsettled Overlap');
    const D1 = day(-230);
    const overlap = await paidTopup(c, 21_000);
    await setPaidAt([overlap.topupId], D1);
    await reconcile(D1, 8);
    const since = await dbNow();
    const [first, second] = await Promise.all([unsettledSweep(), unsettledSweep()]);
    expect(first.alerted + second.alerted).toBe(1);
    expect((await platformNotices(since)).map((n) => n.to).sort()).toEqual(owners);

    // The mark checks each payment again: one settled after it was listed is not recorded, and
    // neither is an unknown payment or one recorded already.
    const D2 = day(-215);
    const settledLate = await paidTopup(c, 22_000);
    await setPaidAt([settledLate.topupId], D2);
    await reconcile(D2, 8);
    const due = (
      await dbs.appPool.query<{ payment_id: string }>(
        'SELECT payment_id FROM ops.settlement_unsettled_alerts_due(500)',
      )
    ).rows.map((r) => r.payment_id);
    expect(due).toContain(settledLate.payment.id);
    expect(due).not.toContain(overlap.payment.id);
    standIn.settle(addDays(D2, 8), { paymentIds: [settledLate.payment.id], refundIds: [] });
    await reconcile(addDays(D2, 8), 1);
    const mark = async (ids: string[]) =>
      (
        await dbs.appPool.query('SELECT * FROM ops.settlement_mark_unsettled_alerted($1::text[])', [
          ids,
        ])
      ).rows;
    expect(await mark([settledLate.payment.id, 'pay_Unknown00000000', overlap.payment.id])).toEqual(
      [],
    );
    expect((await alertedPayments()).has(settledLate.payment.id)).toBe(false);

    // With no platform owner, a payment stays due until there is one.
    const D3 = day(-200);
    const waiting = await paidTopup(c, 23_000);
    await setPaidAt([waiting.topupId], D3);
    await reconcile(D3, 8);
    const demoted = await adminQuery<{ user_id: string }>(
      `UPDATE ops.platform_admins SET role = 'platform_operator' WHERE role = 'platform_owner'
       RETURNING user_id`,
    );
    try {
      expect(await unsettledSweep()).toEqual({
        alerted: 0,
        unsent: 1,
        recipients: 0,
        posted: false,
      });
    } finally {
      await adminQuery(
        `UPDATE ops.platform_admins SET role = 'platform_owner' WHERE user_id = ANY($1::text[])`,
        [demoted.map((r) => r.user_id)],
      );
    }
    expect((await alertedPayments()).has(waiting.payment.id)).toBe(false);
    expect(await unsettledSweep()).toEqual({
      alerted: 1,
      unsent: 0,
      recipients: owners.length,
      posted: false,
    });
    expect((await alertedPayments()).has(waiting.payment.id)).toBe(true);

    // Neither runtime role reads or writes the alerts, or runs the shared definition itself.
    for (const pool of [dbs.appPool, dbs.platformPool]) {
      await expect(pool.query('SELECT * FROM ops.settlement_unsettled_alerts')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        pool.query(
          `INSERT INTO ops.settlement_unsettled_alerts (payment_id) VALUES ('pay_Forged0000000')`,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(pool.query('SELECT * FROM ops.settlement_unsettled_topups()')).rejects.toThrow(
        /permission denied for function/,
      );
    }
    await expect(
      dbs.platformPool.query('SELECT * FROM ops.settlement_unsettled_alerts_due(1)'),
    ).rejects.toThrow(/permission denied for function/);
  });

  it('posts these alerts to a chat channel that gets them, the reconciliation’s without its error (ADR-340)', async () => {
    // Whatever earlier tests left due goes out first, so this test sees only its own alerts.
    await alertSweep();
    await unsettledSweep();
    // A channel getting the owners' alerts (its address is never opened here: nothing is sent).
    const channelId = uuidv7();
    await adminQuery(
      `INSERT INTO ops.platform_alert_channel (id, url_ciphertext, host, kinds)
       VALUES ($1, 'v1:unused', 'chat.example.test',
               ARRAY['failures', 'reconciliation', 'unsettled'])`,
      [channelId],
    );
    const postsOf = (kind: string) =>
      adminQuery<{ body: string }>(
        'SELECT body FROM ops.platform_alert_posts WHERE kind = $1 ORDER BY created_at, id',
        [kind],
      );
    try {
      const refused = day(-80);
      standIn.settle(refused, { paymentIds: [], refundIds: [], extra: [raw({})] });
      standIn.state.queues.recon.push({
        kind: 'error',
        status: 401,
        description: 'The api key provided is invalid',
      });
      expect((await runDay(refused)).result.outcome).toBe('failed');
      const since = await dbNow();
      expect(await alertSweep()).toMatchObject({ alerted: 1, posted: true });
      // The email names the error; the post leaves it out.
      const [notice] = await platformNotices(since);
      expect(notice?.payload.lines[0]).toContain('The last error: Razorpay refused');
      expect((await postsOf('reconciliation')).map((p) => p.body.split('\n'))).toEqual([
        [
          `Settlement reconciliation for ${label(refused)} failed`,
          `${label(refused)}: the check failed and waits for a platform owner to run the day again.`,
          CLOSING,
          `Open reconciliation: http://localhost:3000/platform/reconciliation/${refused}`,
        ],
      ]);

      // Not among the alerts the channel gets, an alert is emailed only.
      await adminQuery(`UPDATE ops.platform_alert_channel SET kinds = ARRAY['unsettled']`);
      expect((await runDay(refused)).result.outcome).toBe('completed');
      expect(await alertSweep()).toMatchObject({ alerted: 1, posted: false });
      expect(await postsOf('reconciliation')).toHaveLength(1);

      const c = await company('Recon Channel Posts');
      const D0 = day(-185);
      const unsettled = await paidTopup(c, 17_000);
      await setPaidAt([unsettled.topupId], D0);
      await reconcile(D0, 8);
      const since2 = await dbNow();
      expect(await unsettledSweep()).toMatchObject({ alerted: 1, posted: true });
      const [email] = await platformNotices(since2);
      expect(await postsOf('unsettled')).toEqual([
        { body: alertPostBody(email!.payload as Parameters<typeof alertPostBody>[0]) },
      ]);
      expect((await postsOf('unsettled'))[0]?.body).not.toContain(unsettled.payment.id);
    } finally {
      await adminQuery(
        `DELETE FROM ops.platform_alert_posts WHERE kind IN ('reconciliation', 'unsettled')`,
      );
      await adminQuery('DELETE FROM ops.platform_alert_channel WHERE id = $1', [channelId]);
    }
  });
});
