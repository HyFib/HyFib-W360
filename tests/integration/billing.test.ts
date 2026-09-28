import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { Keyring, isAppError, uuidv7, type Clock, type RazorpayConfig } from '@w360/core';
import { authorizedTenantScope, sql, type TenantScope } from '@w360/db';
import {
  JobSigner,
  PgBossJobQueue,
  RazorpayClient,
  advanceAutoRechargeAttempt,
  beginAutoRecharge,
  createBillingService,
  findBillingReconciliationDue,
  holdServiceCredit,
  processRazorpayReceipt,
  reconcileTopup,
  releaseExpiredHolds,
  releaseServiceCredit,
  resolveTenantContext,
  settleServiceCredit,
  storeWebhookReceipt,
  verifyCheckoutSignature,
  verifyRazorpayWebhookSignature,
  type BillingNoticeDeps,
  type BillingProviderDeps,
  type TenantContext,
} from '@w360/domain';
import { connectTestDatabases, createTenant, createUser, type TestDatabases } from './helpers';
import {
  startRazorpayStandIn,
  type RazorpayStandIn,
  type StandInPayment,
} from '../support/razorpay-stand-in';

/**
 * Financial core against real PostgreSQL (section 8A): the append-only double-entry ledger,
 * exactly-once crediting of verified captured payments, webhook duplication and reordering, holds,
 * refunds, disputes, and the auto-recharge state machine including unknown provider outcomes.
 * Razorpay is represented by a local test-only stand-in (tests/support/razorpay-stand-in.ts).
 */
const KEY_ID = 'rzp_test_StandIn00000001';
const KEY_SECRET = randomBytes(16).toString('hex');
const WEBHOOK_SECRET = randomBytes(16).toString('hex');
const OLD_WEBHOOK_SECRET = randomBytes(16).toString('hex');

let dbs: TestDatabases;
let boss: PgBoss;
let standIn: RazorpayStandIn;
let razorpay: RazorpayClient;
const signer = new JobSigner(randomBytes(32).toString('hex'));
const keyring = new Keyring({ primaryKeyId: 'test', keys: { test: randomBytes(32) } });
let offsetMs = 0;
const clock: Clock = { now: () => new Date(Date.now() + offsetMs) };

function config(overrides: Partial<RazorpayConfig> = {}): RazorpayConfig {
  return {
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    webhookSecrets: [WEBHOOK_SECRET, OLD_WEBHOOK_SECRET],
    recurringCardsEnabled: true,
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
function providerDeps(): BillingProviderDeps {
  return { db: dbs.app, razorpay, clock, notices: notices() };
}
function billing(overrides: Partial<RazorpayConfig> = {}) {
  return createBillingService({
    db: dbs.app,
    clock,
    razorpay,
    razorpayConfig: config(overrides),
    notices: notices(),
  });
}
const checkoutSignature = (orderId: string, paymentId: string) =>
  createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

async function adminQuery<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await dbs.adminPool.query<T>(text, params)).rows;
}

interface Company {
  tenantId: string;
  scope: TenantScope;
  ctx: TenantContext;
}

async function company(): Promise<Company> {
  const owner = await createUser(dbs, { name: 'Billing Owner' });
  const tenant = await createTenant(dbs, owner);
  const ctx = await resolveTenantContext(
    { db: dbs.app, clock, mfaGracePeriodHours: 72 },
    {
      userId: owner.id,
      sessionId: `sess_${owner.id}`,
      tenantSlug: tenant.slug,
      correlationId: uuidv7(),
    },
  );
  return { tenantId: tenant.id, scope: authorizedTenantScope(tenant.id, null), ctx };
}

async function balances(tenantId: string) {
  const rows = await adminQuery<{ code: string; balance_minor: string }>(
    'SELECT code, balance_minor FROM app.ledger_accounts WHERE tenant_id = $1',
    [tenantId],
  );
  const get = (code: string) => Number(rows.find((r) => r.code === code)?.balance_minor ?? 0);
  return {
    available: get('wallet_available'),
    held: get('wallet_held'),
    clearing: get('payment_clearing'),
    revenue: get('service_revenue'),
  };
}

/** Every posting balances, every balance equals its entries, and the trial balance is zero. */
async function expectLedgerConsistent(tenantId: string) {
  const unbalanced = await adminQuery(
    `SELECT t.id FROM app.ledger_transactions t
       LEFT JOIN app.ledger_entries e ON e.tenant_id = t.tenant_id AND e.transaction_id = t.id
      WHERE t.tenant_id = $1
      GROUP BY t.id
     HAVING count(e.id) < 2
         OR coalesce(sum(CASE WHEN e.direction = 'debit' THEN e.amount_minor ELSE -e.amount_minor END), 0) <> 0`,
    [tenantId],
  );
  expect(unbalanced).toEqual([]);
  const drift = await adminQuery(
    `SELECT a.code FROM app.ledger_accounts a
       LEFT JOIN app.ledger_entries e ON e.tenant_id = a.tenant_id AND e.account_id = a.id
      WHERE a.tenant_id = $1
      GROUP BY a.id
     HAVING a.balance_minor <>
            coalesce(sum(CASE WHEN e.direction = a.normal_side THEN e.amount_minor ELSE -e.amount_minor END), 0)`,
    [tenantId],
  );
  expect(drift).toEqual([]);
  const [trial] = await adminQuery<{ debits: string; credits: string }>(
    `SELECT coalesce(sum(balance_minor) FILTER (WHERE normal_side = 'debit'), 0) AS debits,
            coalesce(sum(balance_minor) FILTER (WHERE normal_side = 'credit'), 0) AS credits
       FROM app.ledger_accounts WHERE tenant_id = $1`,
    [tenantId],
  );
  expect(Number(trial!.debits)).toBe(Number(trial!.credits));
}

async function creditCount(tenantId: string) {
  const [row] = await adminQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.ledger_transactions WHERE tenant_id = $1 AND kind = 'topup_credit'`,
    [tenantId],
  );
  return row!.n;
}

let eventSeq = 0;
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
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  expect(verifyRazorpayWebhookSignature(body, signature, config().webhookSecrets)).toBe(true);
  const stored = await storeWebhookReceipt(
    { db: dbs.app, keyring, jobs: new PgBossJobQueue(boss), signer },
    {
      provider: 'razorpay',
      rawBody: body,
      eventId: `evt_${eventSeq}_${randomBytes(4).toString('hex')}`,
    },
  );
  const outcome = await processRazorpayReceipt({ ...providerDeps(), keyring }, stored.receiptId);
  return { ...stored, outcome };
}
const paymentEvent = (event: string, p: StandInPayment) =>
  deliver(event, {
    payment: {
      entity: {
        id: p.id,
        entity: 'payment',
        order_id: p.orderId,
        amount: p.amount,
        status: p.status,
      },
    },
  });

async function startTopup(c: Company, amountMinor = 50_000) {
  return billing().startTopup(c.ctx, { amountMinor });
}

async function topupRow(topupId: string) {
  const [row] = await adminQuery<{
    status: string;
    refunded_minor: string;
    provider_order_id: string;
  }>('SELECT status, refunded_minor, provider_order_id FROM app.topups WHERE id = $1', [topupId]);
  return row!;
}

beforeAll(async () => {
  dbs = connectTestDatabases({ appPoolMax: 12 });
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
});

beforeEach(() => {
  offsetMs = 0;
  standIn.state.queues = {
    createOrder: [],
    recurring: [],
    refund: [],
    fetch: [],
    createPaymentLink: [],
    paymentLinks: [],
  };
});

afterAll(async () => {
  await standIn.close();
  await boss.stop({ graceful: false });
  await dbs.close();
});

describe('ledger integrity', () => {
  it('runtime roles cannot write ledger rows or balances, or call the posting primitive', async () => {
    const c = await company();
    await startTopup(c);
    const [account] = await adminQuery<{ id: string; wallet_id: string }>(
      `SELECT id, wallet_id FROM app.ledger_accounts WHERE tenant_id = $1 AND code = 'wallet_available'`,
      [c.tenantId],
    );
    const inScope = (text: string) => dbs.app.run(c.scope, (tx) => tx.execute(sql.raw(text)));
    await expect(
      inScope(
        `UPDATE app.ledger_accounts SET balance_minor = 99999999 WHERE id = '${account!.id}'`,
      ),
    ).rejects.toThrow(/permission denied|not permitted/i);
    await expect(
      inScope(
        `INSERT INTO app.ledger_transactions (id, tenant_id, wallet_id, kind, idempotency_key, actor_type)
         VALUES (gen_random_uuid(), '${c.tenantId}', '${account!.wallet_id}', 'topup_credit', 'forged', 'user')`,
      ),
    ).rejects.toThrow(/permission denied|not permitted/i);
    await expect(
      inScope(
        `SELECT app.ledger_post('${c.tenantId}', '${account!.wallet_id}', 'topup_credit', 'forged', null, null,
                                null, 'user', null, '[]'::jsonb)`,
      ),
    ).rejects.toThrow(/permission denied|not permitted/i);
    await expect(
      inScope(`UPDATE app.topups SET status = 'paid' WHERE tenant_id = '${c.tenantId}'`),
    ).rejects.toThrow(/permission denied|not permitted|row-level security/i);
    expect(await balances(c.tenantId)).toMatchObject({ available: 0 });
  });

  it('an unbalanced posting is rejected at commit and postings are append-only', async () => {
    const c = await company();
    await startTopup(c);
    const [account] = await adminQuery<{ id: string; wallet_id: string }>(
      `SELECT id, wallet_id FROM app.ledger_accounts WHERE tenant_id = $1 AND code = 'wallet_available'`,
      [c.tenantId],
    );
    const client = await dbs.adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE w360_definer');
      const txId = uuidv7();
      await client.query(
        `INSERT INTO app.ledger_transactions (id, tenant_id, wallet_id, kind, idempotency_key, actor_type)
         VALUES ($1, $2, $3, 'topup_credit', 'unbalanced-test', 'system')`,
        [txId, c.tenantId, account!.wallet_id],
      );
      await client.query(
        `INSERT INTO app.ledger_entries (tenant_id, transaction_id, account_id, direction, amount_minor)
         VALUES ($1, $2, $3, 'credit', 500)`,
        [c.tenantId, txId, account!.id],
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/unbalanced/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect(await balances(c.tenantId)).toMatchObject({ available: 0 });

    // Fund the wallet through the real path, then try to rewrite history as the definer role.
    const topup = await startTopup(c, 20_000);
    const paid = standIn.pay(topup.orderId);
    await billing().confirmTopupCheckout(c.ctx, {
      topupId: topup.topupId,
      paymentId: paid.id,
      signature: checkoutSignature(topup.orderId, paid.id),
    });
    const append = await dbs.adminPool.connect();
    try {
      await append.query('BEGIN');
      await append.query('SET LOCAL ROLE w360_definer');
      await expect(
        append.query(`UPDATE app.ledger_entries SET amount_minor = 1 WHERE tenant_id = $1`, [
          c.tenantId,
        ]),
      ).rejects.toThrow();
    } finally {
      await append.query('ROLLBACK').catch(() => undefined);
      append.release();
    }
    expect((await balances(c.tenantId)).available).toBe(20_000);
    await expectLedgerConsistent(c.tenantId);
  });
});

describe('manual top-ups', () => {
  it('credits a captured payment exactly once across checkout, duplicate and reordered webhooks', async () => {
    const c = await company();
    const topup = await startTopup(c, 75_000);
    expect(topup.keyId).toBe(KEY_ID);
    expect((await topupRow(topup.topupId)).status).toBe('awaiting_payment');
    expect((await balances(c.tenantId)).available).toBe(0);

    const payment = standIn.pay(topup.orderId);
    // Webhooks and the browser confirmation race; order.paid arrives before payment.authorized.
    const results = await Promise.all([
      billing().confirmTopupCheckout(c.ctx, {
        topupId: topup.topupId,
        paymentId: payment.id,
        signature: checkoutSignature(topup.orderId, payment.id),
      }),
      paymentEvent('payment.captured', payment),
      paymentEvent('order.paid', payment),
      paymentEvent('payment.captured', payment),
    ]);
    expect(results[0]).toEqual({ status: 'credited' });
    await paymentEvent('payment.authorized', payment);

    expect((await balances(c.tenantId)).available).toBe(75_000);
    expect(await creditCount(c.tenantId)).toBe(1);
    expect((await topupRow(topup.topupId)).status).toBe('paid');
    const audits = await adminQuery(
      `SELECT action FROM app.audit_events WHERE tenant_id = $1 AND action = 'billing.topup_credited'`,
      [c.tenantId],
    );
    expect(audits).toHaveLength(1);
    await expectLedgerConsistent(c.tenantId);
  });

  it('authorisation alone, a pending payment or a checkout redirect never creates credit', async () => {
    const c = await company();
    const topup = await startTopup(c, 30_000);
    const authorized = standIn.pay(topup.orderId, { status: 'authorized' });
    expect(
      await billing().confirmTopupCheckout(c.ctx, {
        topupId: topup.topupId,
        paymentId: authorized.id,
        signature: checkoutSignature(topup.orderId, authorized.id),
      }),
    ).toEqual({ status: 'processing' });
    expect((await paymentEvent('payment.authorized', authorized)).outcome).toBe('processed');
    expect((await balances(c.tenantId)).available).toBe(0);

    // A forged or mismatched redirect is refused before any provider call.
    await expect(
      billing().confirmTopupCheckout(c.ctx, {
        topupId: topup.topupId,
        paymentId: authorized.id,
        signature: 'f'.repeat(64),
      }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === 'validation_failed');
    const other = await startTopup(c, 30_000);
    await expect(
      billing().confirmTopupCheckout(c.ctx, {
        topupId: topup.topupId,
        paymentId: authorized.id,
        // Signed for another order: the order id always comes from our database.
        signature: checkoutSignature(other.orderId, authorized.id),
      }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === 'validation_failed');
    expect((await balances(c.tenantId)).available).toBe(0);

    // Capture completes later; the webhook credits once.
    standIn.setPaymentStatus(authorized.id, 'captured');
    await paymentEvent('payment.captured', authorized);
    expect((await balances(c.tenantId)).available).toBe(30_000);
    expect(await creditCount(c.tenantId)).toBe(1);
    await expectLedgerConsistent(c.tenantId);
  });

  it('a failed payment followed by a late capture credits the top-up (R-009, R-020)', async () => {
    const c = await company();
    const topup = await startTopup(c, 40_000);
    const payment = standIn.pay(topup.orderId, {
      status: 'failed',
      errorDescription: 'Bank timeout',
    });
    await paymentEvent('payment.failed', payment);
    expect((await topupRow(topup.topupId)).status).toBe('failed');
    expect((await balances(c.tenantId)).available).toBe(0);
    standIn.setPaymentStatus(payment.id, 'captured');
    await paymentEvent('payment.captured', payment);
    expect((await topupRow(topup.topupId)).status).toBe('paid');
    expect((await balances(c.tenantId)).available).toBe(40_000);
    await expectLedgerConsistent(c.tenantId);
  });

  it('delayed success after the browser gave up is credited by reconciliation', async () => {
    const c = await company();
    const topup = await startTopup(c, 25_000);
    const payment = standIn.pay(topup.orderId);
    // The confirmation call cannot reach Razorpay: the user sees "processing", nothing is credited.
    standIn.state.queues.fetch.push({ kind: 'error', status: 503 });
    expect(
      await billing().confirmTopupCheckout(c.ctx, {
        topupId: topup.topupId,
        paymentId: payment.id,
        signature: checkoutSignature(topup.orderId, payment.id),
      }),
    ).toEqual({ status: 'processing' });
    expect((await balances(c.tenantId)).available).toBe(0);
    // No webhook arrives; the reconciliation backstop finds the captured payment.
    expect(await reconcileTopup(providerDeps(), c.scope, topup.topupId)).toBe('credited');
    expect(await reconcileTopup(providerDeps(), c.scope, topup.topupId)).toBe('skipped');
    expect((await balances(c.tenantId)).available).toBe(25_000);
    await expectLedgerConsistent(c.tenantId);
  });

  it('abandoned top-ups expire without credit, and unknown orders are quarantined', async () => {
    const c = await company();
    const topup = await startTopup(c, 25_000);
    expect(await reconcileTopup(providerDeps(), c.scope, topup.topupId)).toBe('waiting');
    offsetMs += 25 * 3600_000;
    try {
      expect(await reconcileTopup(providerDeps(), c.scope, topup.topupId)).toBe('expired');
    } finally {
      offsetMs -= 25 * 3600_000;
    }
    expect((await topupRow(topup.topupId)).status).toBe('expired');

    // A payment for an order we never created is attributed to no one.
    const stray = await razorpay.createOrder({
      amount: 10_000,
      currency: 'INR',
      receipt: 'stray-1',
    });
    expect(stray.ok).toBe(true);
    const payment = standIn.pay(stray.ok ? stray.data.id : '');
    expect((await paymentEvent('payment.captured', payment)).outcome).toBe('quarantined');
    expect((await balances(c.tenantId)).available).toBe(0);
  });

  it('refuses top-ups when card payments are not configured and validates amounts', async () => {
    const c = await company();
    const unconfigured = createBillingService({
      db: dbs.app,
      clock,
      razorpay: null,
      razorpayConfig: null,
      notices: notices(),
    });
    await expect(unconfigured.startTopup(c.ctx, { amountMinor: 50_000 })).rejects.toSatisfy(
      (e: unknown) => isAppError(e) && e.code === 'provider_unavailable',
    );
    await expect(billing().startTopup(c.ctx, { amountMinor: 99 })).rejects.toSatisfy(
      (e: unknown) => isAppError(e) && e.code === 'validation_failed',
    );
    await expect(billing().startTopup(c.ctx, { amountMinor: 10_000.5 })).rejects.toSatisfy(
      (e: unknown) => isAppError(e) && e.code === 'validation_failed',
    );
  });
});

describe('holds, refunds and disputes', () => {
  async function funded(amountMinor: number) {
    const c = await company();
    const topup = await startTopup(c, amountMinor);
    const payment = standIn.pay(topup.orderId);
    await paymentEvent('payment.captured', payment);
    expect((await balances(c.tenantId)).available).toBe(amountMinor);
    return { c, topup, payment };
  }

  it('concurrent spends on the last funds never overdraw the wallet', async () => {
    const { c } = await funded(10_000);
    const expiresAt = new Date(Date.now() + 3600_000);
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        holdServiceCredit(dbs.app, c.scope, {
          idempotencyKey: `spend-${i}`,
          amountMinor: 3_000,
          referenceType: 'test_service',
          referenceId: `job-${i}`,
          expiresAt,
        }),
      ),
    );
    const ok = attempts.filter((a) => a.status === 'fulfilled');
    const refused = attempts.filter(
      (a) =>
        a.status === 'rejected' && isAppError(a.reason) && a.reason.code === 'insufficient_funds',
    );
    expect(ok).toHaveLength(3);
    expect(refused).toHaveLength(3);
    expect(await balances(c.tenantId)).toMatchObject({ available: 1_000, held: 9_000 });
    await expectLedgerConsistent(c.tenantId);
  });

  it('holds settle at the verified amount, release the rest, and are idempotent', async () => {
    const { c } = await funded(50_000);
    const expiresAt = new Date(Date.now() + 3600_000);
    const hold = await holdServiceCredit(dbs.app, c.scope, {
      idempotencyKey: 'svc-1',
      amountMinor: 20_000,
      referenceType: 'test_service',
      referenceId: 'svc-1',
      expiresAt,
    });
    const again = await holdServiceCredit(dbs.app, c.scope, {
      idempotencyKey: 'svc-1',
      amountMinor: 20_000,
      referenceType: 'test_service',
      referenceId: 'svc-1',
      expiresAt,
    });
    expect(again).toBe(hold);
    expect(await balances(c.tenantId)).toMatchObject({ available: 30_000, held: 20_000 });
    await settleServiceCredit(dbs.app, c.scope, hold, 12_500);
    await settleServiceCredit(dbs.app, c.scope, hold, 12_500);
    expect(await balances(c.tenantId)).toMatchObject({
      available: 37_500,
      held: 0,
      revenue: 12_500,
    });
    await expect(settleServiceCredit(dbs.app, c.scope, hold, 1_000)).rejects.toSatisfy(
      (e: unknown) => isAppError(e) && e.code === 'conflict',
    );

    const second = await holdServiceCredit(dbs.app, c.scope, {
      idempotencyKey: 'svc-2',
      amountMinor: 5_000,
      referenceType: 'test_service',
      referenceId: 'svc-2',
      expiresAt,
    });
    await releaseServiceCredit(dbs.app, c.scope, second);
    await releaseServiceCredit(dbs.app, c.scope, second);
    expect(await balances(c.tenantId)).toMatchObject({ available: 37_500, held: 0 });

    // An expired hold is released by the sweeper.
    const third = await holdServiceCredit(dbs.app, c.scope, {
      idempotencyKey: 'svc-3',
      amountMinor: 7_500,
      referenceType: 'test_service',
      referenceId: 'svc-3',
      expiresAt,
    });
    await dbs.adminPool.query(
      `UPDATE app.wallet_holds SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [third],
    );
    expect(await releaseExpiredHolds(dbs.app)).toBeGreaterThanOrEqual(1);
    expect(await balances(c.tenantId)).toMatchObject({ available: 37_500, held: 0 });
    await expectLedgerConsistent(c.tenantId);
  });

  it('refunds reduce credit once each, even when they race with usage', async () => {
    const { c, topup, payment } = await funded(50_000);
    const hold = await holdServiceCredit(dbs.app, c.scope, {
      idempotencyKey: 'use-1',
      amountMinor: 20_000,
      referenceType: 'test_service',
      referenceId: 'use-1',
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await settleServiceCredit(dbs.app, c.scope, hold, 20_000);
    const partial = await razorpay.createRefund(payment.id, {
      amount: 10_000,
      idempotencyKey: `test-refund-${randomBytes(4).toString('hex')}`,
    });
    expect(partial.ok).toBe(true);
    const refundId = partial.ok ? partial.data.id : '';
    const refundEvent = () =>
      deliver('refund.processed', {
        refund: {
          entity: { id: refundId, entity: 'refund', payment_id: payment.id, amount: 10_000 },
        },
      });
    await refundEvent();
    await refundEvent();
    expect(await balances(c.tenantId)).toMatchObject({ available: 20_000 });
    expect(await topupRow(topup.topupId)).toMatchObject({ status: 'partially_refunded' });

    // Refunding the rest after the credit was spent leaves a negative balance (money owed).
    const rest = await razorpay.createRefund(payment.id, {
      amount: 40_000,
      idempotencyKey: `test-refund-${randomBytes(4).toString('hex')}`,
    });
    const restId = rest.ok ? rest.data.id : '';
    await deliver('refund.processed', {
      refund: { entity: { id: restId, entity: 'refund', payment_id: payment.id, amount: 40_000 } },
    });
    expect(await balances(c.tenantId)).toMatchObject({ available: -20_000 });
    expect(await topupRow(topup.topupId)).toMatchObject({ status: 'refunded' });
    await expect(
      holdServiceCredit(dbs.app, c.scope, {
        idempotencyKey: 'use-2',
        amountMinor: 1,
        referenceType: 'test_service',
        referenceId: 'use-2',
        expiresAt: new Date(Date.now() + 3600_000),
      }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === 'insufficient_funds');
    await expectLedgerConsistent(c.tenantId);
  });

  it('a refund event that arrives before the capture is retried until the credit exists', async () => {
    const c = await company();
    const topup = await startTopup(c, 30_000);
    const payment = standIn.pay(topup.orderId);
    const refund = await razorpay.createRefund(payment.id, {
      amount: 5_000,
      idempotencyKey: `early-refund-${randomBytes(4).toString('hex')}`,
    });
    const refundId = refund.ok ? refund.data.id : '';
    eventSeq += 1;
    const body = Buffer.from(
      JSON.stringify({
        event: 'refund.processed',
        payload: { refund: { entity: { id: refundId, payment_id: payment.id, amount: 5_000 } } },
        created_at: eventSeq,
      }),
    );
    const stored = await storeWebhookReceipt(
      { db: dbs.app, keyring, jobs: new PgBossJobQueue(boss), signer },
      { provider: 'razorpay', rawBody: body, eventId: `evt_early_${eventSeq}` },
    );
    await expect(
      processRazorpayReceipt({ ...providerDeps(), keyring }, stored.receiptId),
    ).rejects.toThrow();
    await paymentEvent('payment.captured', payment);
    expect(await processRazorpayReceipt({ ...providerDeps(), keyring }, stored.receiptId)).toBe(
      'processed',
    );
    expect(await balances(c.tenantId)).toMatchObject({ available: 25_000 });
    await expectLedgerConsistent(c.tenantId);
  });

  it('a chargeback lost after the credit was spent withdraws it once', async () => {
    const { c, payment } = await funded(30_000);
    const hold = await holdServiceCredit(dbs.app, c.scope, {
      idempotencyKey: 'cb-use',
      amountMinor: 30_000,
      referenceType: 'test_service',
      referenceId: 'cb-use',
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await settleServiceCredit(dbs.app, c.scope, hold, 30_000);
    const dispute = standIn.addDispute(payment.id, 30_000, 'lost');
    const lost = () =>
      deliver('payment.dispute.lost', {
        dispute: { entity: { id: dispute.id, payment_id: payment.id } },
      });
    await lost();
    await lost();
    expect(await balances(c.tenantId)).toMatchObject({ available: -30_000, revenue: 30_000 });
    await expectLedgerConsistent(c.tenantId);
  });
});

describe('card mandate and auto-recharge', () => {
  const SETTINGS = {
    enabled: true,
    thresholdMinor: 50_000,
    amountMinor: 100_000,
    dailyCapMinor: 200_000,
    monthlyCapMinor: 500_000,
  };

  async function withMandate(maxAmountMinor = 1_500_000) {
    const c = await company();
    const svc = billing();
    const setup = await svc.startMandateSetup(c.ctx, {
      maxAmountMinor,
      email: 'billing@example.test',
      contact: '+91 90000 00001',
    });
    const order = standIn.state.orders.get(setup.orderId)!;
    expect(order.amount).toBe(100);
    expect(order.token).toMatchObject({ max_amount: maxAmountMinor, frequency: 'as_presented' });
    const auth = standIn.pay(setup.orderId);
    expect(
      await svc.confirmMandateCheckout(c.ctx, {
        mandateId: setup.mandateId,
        paymentId: auth.id,
        signature: checkoutSignature(setup.orderId, auth.id),
      }),
    ).toEqual({ status: 'active' });
    return { c, mandateId: setup.mandateId, auth };
  }

  async function attemptRow(attemptId: string) {
    const [row] = await adminQuery<{
      status: string;
      unknown_step: string | null;
      topup_id: string;
      next_check_at: Date;
    }>(
      'SELECT status, unknown_step, topup_id, next_check_at FROM app.auto_recharge_attempts WHERE id = $1',
      [attemptId],
    );
    return row!;
  }
  async function orderOf(attemptId: string) {
    const attempt = await attemptRow(attemptId);
    return (await topupRow(attempt.topup_id)).provider_order_id;
  }
  const advance = (c: Company, attemptId: string) =>
    advanceAutoRechargeAttempt(providerDeps(), c.scope, attemptId);
  function later(minutes: number) {
    offsetMs += minutes * 60_000;
  }

  it('registers a mandate with safe card metadata only and refunds the ₹1 authorisation', async () => {
    const { c, mandateId, auth } = await withMandate();
    const [mandate] = await adminQuery<Record<string, unknown>>(
      'SELECT * FROM app.payment_mandates WHERE id = $1',
      [mandateId],
    );
    expect(mandate).toMatchObject({
      status: 'active',
      card_network: 'Visa',
      card_last4: '1111',
      card_expiry_month: 12,
      card_expiry_year: 2031,
      authorization_payment_id: auth.id,
    });
    expect(String(mandate!.authorization_refund_id)).toMatch(/^rfnd_/);
    const columns = await adminQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name IN ('payment_mandates', 'billing_customers')`,
    );
    for (const { column_name } of columns) {
      expect(column_name).not.toMatch(/pan|cvv|card_number|number$/i);
    }
    // The authorisation charge never became service credit.
    expect((await balances(c.tenantId)).available).toBe(0);
    const refunds = [...standIn.state.refunds.values()].filter((r) => r.paymentId === auth.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.idempotencyKey).toBe(`mauth_${mandateId}`);
  });

  it('many low-balance triggers start exactly one attempt; a pending debit never creates credit', async () => {
    const { c } = await withMandate();
    await billing().updateAutoRecharge(c.ctx, SETTINGS);
    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => beginAutoRecharge(dbs.app, c.scope)),
    );
    const scheduled = decisions.filter((d) => d.outcome === 'scheduled');
    expect(scheduled).toHaveLength(1);
    expect(decisions.filter((d) => d.outcome === 'attempt_in_flight')).toHaveLength(9);
    const attemptId = scheduled[0]!.attemptId!;

    const result = await advance(c, attemptId);
    expect(result.outcome).toBe('payment_requested');
    const orderId = await orderOf(attemptId);
    const payments = [...standIn.state.payments.values()].filter((p) => p.orderId === orderId);
    expect(payments).toHaveLength(1);
    expect(payments[0]!.status).toBe('created');
    expect((await balances(c.tenantId)).available).toBe(0);
    expect(standIn.state.orders.get(orderId)!.paymentCapture).toBe(true);

    // The bank debits 36-72 h later (R-042); the webhook credits it exactly once.
    standIn.setPaymentStatus(payments[0]!.id, 'captured');
    await paymentEvent('payment.captured', standIn.state.payments.get(payments[0]!.id)!);
    await paymentEvent('payment.captured', standIn.state.payments.get(payments[0]!.id)!);
    expect((await attemptRow(attemptId)).status).toBe('succeeded');
    expect((await balances(c.tenantId)).available).toBe(100_000);
    const notices = await adminQuery(
      `SELECT id FROM ops.email_outbox WHERE tenant_id = $1 AND kind = 'billing.notice'`,
      [c.tenantId],
    );
    expect(notices.length).toBeGreaterThanOrEqual(1);
    await expectLedgerConsistent(c.tenantId);
  });

  it('caps count succeeded and in-flight attempts', async () => {
    const { c } = await withMandate();
    await billing().updateAutoRecharge(c.ctx, {
      ...SETTINGS,
      thresholdMinor: 10_000_000,
      dailyCapMinor: 150_000,
      monthlyCapMinor: 150_000,
    });
    const first = await beginAutoRecharge(dbs.app, c.scope);
    expect(first.outcome).toBe('scheduled');
    expect((await beginAutoRecharge(dbs.app, c.scope)).outcome).toBe('attempt_in_flight');
    await advance(c, first.attemptId!);
    const orderId = await orderOf(first.attemptId!);
    const payment = [...standIn.state.payments.values()].find((p) => p.orderId === orderId)!;
    standIn.setPaymentStatus(payment.id, 'captured');
    later(7 * 60);
    try {
      expect((await advance(c, first.attemptId!)).outcome).toBe('succeeded');
    } finally {
      later(-7 * 60);
    }
    // 100,000 succeeded + 100,000 new > 150,000 daily cap.
    expect((await beginAutoRecharge(dbs.app, c.scope)).outcome).toBe('daily_cap_reached');
    await expectLedgerConsistent(c.tenantId);
  });

  it('an order creation whose response was lost is reconciled by receipt before any retry', async () => {
    const { c } = await withMandate();
    await billing().updateAutoRecharge(c.ctx, SETTINGS);
    const { attemptId } = await beginAutoRecharge(dbs.app, c.scope);
    standIn.state.queues.createOrder.push({ kind: 'process_then_drop' });
    expect((await advance(c, attemptId!)).outcome).toBe('unknown');
    expect(await attemptRow(attemptId!)).toMatchObject({
      status: 'unknown',
      unknown_step: 'create_order',
    });
    // Not retried blindly: nothing happens until the reconciliation delay has passed.
    expect((await advance(c, attemptId!)).outcome).toBe('not_due');
    later(6);
    try {
      expect((await advance(c, attemptId!)).outcome).toBe('payment_requested');
    } finally {
      later(-6);
    }
    const receipt = `ar_${attemptId}`;
    const orders = [...standIn.state.orders.values()].filter((o) => o.receipt === receipt);
    expect(orders).toHaveLength(1);
    expect(await orderOf(attemptId!)).toBe(orders[0]!.id);
  });

  it('an order creation that never reached Razorpay is retried once reconciliation finds nothing', async () => {
    const { c } = await withMandate();
    await billing().updateAutoRecharge(c.ctx, SETTINGS);
    const { attemptId } = await beginAutoRecharge(dbs.app, c.scope);
    standIn.state.queues.createOrder.push({ kind: 'drop' });
    expect((await advance(c, attemptId!)).outcome).toBe('unknown');
    later(6);
    try {
      expect((await advance(c, attemptId!)).outcome).toBe('payment_requested');
    } finally {
      later(-6);
    }
    const orders = [...standIn.state.orders.values()].filter(
      (o) => o.receipt === `ar_${attemptId}`,
    );
    expect(orders).toHaveLength(1);
  });

  it('a debit request whose response was lost is followed, never sent twice', async () => {
    const { c } = await withMandate();
    await billing().updateAutoRecharge(c.ctx, SETTINGS);
    const { attemptId } = await beginAutoRecharge(dbs.app, c.scope);
    standIn.state.queues.recurring.push({ kind: 'process_then_drop' });
    expect((await advance(c, attemptId!)).outcome).toBe('unknown');
    expect(await attemptRow(attemptId!)).toMatchObject({ unknown_step: 'request_payment' });
    later(16);
    try {
      const result = await advance(c, attemptId!);
      expect(['payment_requested', 'waiting']).toContain(result.outcome);
    } finally {
      later(-16);
    }
    expect((await attemptRow(attemptId!)).status).toBe('payment_requested');
    const orderId = await orderOf(attemptId!);
    const recurringCalls = standIn.state.calls.filter(
      (call) =>
        call.path === '/v1/payments/create/recurring' &&
        (call.body as { order_id?: string })?.order_id === orderId,
    );
    expect(recurringCalls).toHaveLength(1);
    expect([...standIn.state.payments.values()].filter((p) => p.orderId === orderId)).toHaveLength(
      1,
    );
  });

  it('a debit request that never arrived is asked again after reconciliation finds no payment', async () => {
    const { c } = await withMandate();
    await billing().updateAutoRecharge(c.ctx, SETTINGS);
    const { attemptId } = await beginAutoRecharge(dbs.app, c.scope);
    standIn.state.queues.recurring.push({ kind: 'drop' });
    expect((await advance(c, attemptId!)).outcome).toBe('unknown');
    later(16);
    try {
      expect((await advance(c, attemptId!)).outcome).toBe('payment_requested');
    } finally {
      later(-16);
    }
    const orderId = await orderOf(attemptId!);
    expect([...standIn.state.payments.values()].filter((p) => p.orderId === orderId)).toHaveLength(
      1,
    );
  });

  it('rate limits are retried later; declines fail the attempt, notify, and start a cooldown', async () => {
    const { c } = await withMandate();
    await billing().updateAutoRecharge(c.ctx, SETTINGS);
    const { attemptId } = await beginAutoRecharge(dbs.app, c.scope);
    standIn.state.queues.createOrder.push({
      kind: 'error',
      status: 429,
      description: 'Too many requests',
    });
    expect((await advance(c, attemptId!)).outcome).toBe('retry_later');
    expect((await attemptRow(attemptId!)).status).toBe('scheduled');
    later(6);
    try {
      standIn.state.queues.recurring.push({
        kind: 'error',
        status: 400,
        description: 'Card does not support recurring payments.',
      });
      expect((await advance(c, attemptId!)).outcome).toBe('failed');
    } finally {
      later(-6);
    }
    const attempt = await attemptRow(attemptId!);
    expect(attempt.status).toBe('failed');
    expect((await topupRow(attempt.topup_id)).status).toBe('failed');
    expect((await beginAutoRecharge(dbs.app, c.scope)).outcome).toBe('recent_failure');
    const failures = await adminQuery(
      `SELECT action FROM app.audit_events WHERE tenant_id = $1 AND action = 'billing.auto_recharge_failed'`,
      [c.tenantId],
    );
    expect(failures).toHaveLength(1);
    expect((await balances(c.tenantId)).available).toBe(0);
  });

  it('a debit declined by the bank fails the attempt, and a late capture still credits it', async () => {
    const { c } = await withMandate();
    await billing().updateAutoRecharge(c.ctx, SETTINGS);
    const { attemptId } = await beginAutoRecharge(dbs.app, c.scope);
    await advance(c, attemptId!);
    const orderId = await orderOf(attemptId!);
    const payment = [...standIn.state.payments.values()].find((p) => p.orderId === orderId)!;
    standIn.setPaymentStatus(payment.id, 'failed', 'Insufficient funds');
    await paymentEvent('payment.failed', standIn.state.payments.get(payment.id)!);
    // The webhook nudges the attempt to check now; the attempt then fails with audit and notice.
    const nudged = await attemptRow(attemptId!);
    expect(nudged.status).toBe('payment_requested');
    expect(nudged.next_check_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await advance(c, attemptId!)).outcome).toBe('failed');
    expect((await attemptRow(attemptId!)).status).toBe('failed');
    standIn.setPaymentStatus(payment.id, 'captured');
    await paymentEvent('payment.captured', standIn.state.payments.get(payment.id)!);
    expect((await attemptRow(attemptId!)).status).toBe('succeeded');
    expect((await balances(c.tenantId)).available).toBe(100_000);
    await expectLedgerConsistent(c.tenantId);
  });

  it('three consecutive failures turn auto-recharge off', async () => {
    const { c } = await withMandate();
    await billing().updateAutoRecharge(c.ctx, SETTINGS);
    for (let i = 0; i < 3; i += 1) {
      const { attemptId, outcome } = await beginAutoRecharge(dbs.app, c.scope);
      expect(outcome).toBe('scheduled');
      standIn.state.queues.recurring.push({ kind: 'error', status: 400, description: 'Declined' });
      expect((await advance(c, attemptId!)).outcome).toBe('failed');
      // Skip the 24-hour cooldown between attempts.
      await dbs.adminPool.query(
        `UPDATE app.auto_recharge_attempts SET resolved_at = now() - interval '25 hours', created_at = created_at - interval '1 second' * $2 WHERE id = $1`,
        [attemptId, 3 - i],
      );
    }
    const [settings] = await adminQuery<{ enabled: boolean }>(
      'SELECT enabled FROM app.auto_recharge_settings WHERE tenant_id = $1',
      [c.tenantId],
    );
    expect(settings!.enabled).toBe(false);
    expect((await beginAutoRecharge(dbs.app, c.scope)).outcome).toBe('disabled');
  });

  it('turning auto-recharge off during a pending charge stops it before any debit request', async () => {
    const { c } = await withMandate();
    await billing().updateAutoRecharge(c.ctx, SETTINGS);
    const { attemptId } = await beginAutoRecharge(dbs.app, c.scope);
    // The order is created, then the debit request is held back by a rate limit.
    standIn.state.queues.recurring.push({ kind: 'error', status: 429 });
    expect((await advance(c, attemptId!)).outcome).toBe('retry_later');
    expect((await attemptRow(attemptId!)).status).toBe('order_created');
    await billing().updateAutoRecharge(c.ctx, { ...SETTINGS, enabled: false });
    expect((await attemptRow(attemptId!)).status).toBe('canceled');
    later(10);
    try {
      expect((await advance(c, attemptId!)).outcome).toBe('finished');
    } finally {
      later(-10);
    }
    const orderId = await orderOf(attemptId!);
    expect([...standIn.state.payments.values()].filter((p) => p.orderId === orderId)).toHaveLength(
      0,
    );
  });

  it('a revoked mandate disables auto-recharge and cancels attempts that have not debited', async () => {
    const { c, mandateId } = await withMandate();
    await billing().updateAutoRecharge(c.ctx, SETTINGS);
    const { attemptId } = await beginAutoRecharge(dbs.app, c.scope);
    const [mandate] = await adminQuery<{ provider_token_id: string }>(
      'SELECT provider_token_id FROM app.payment_mandates WHERE id = $1',
      [mandateId],
    );
    const token = standIn.state.tokens.get(mandate!.provider_token_id)!;
    token.status = 'cancelled';
    await deliver('token.cancelled', {
      token: { entity: { id: token.id, entity: 'token', customer_id: token.customerId } },
    });
    expect((await attemptRow(attemptId!)).status).toBe('canceled');
    const [settings] = await adminQuery<{ enabled: boolean }>(
      'SELECT enabled FROM app.auto_recharge_settings WHERE tenant_id = $1',
      [c.tenantId],
    );
    expect(settings!.enabled).toBe(false);
    expect((await beginAutoRecharge(dbs.app, c.scope)).outcome).toBe('disabled');
  });

  it('removing the card deletes the token at Razorpay and stops auto-recharge', async () => {
    const { c, mandateId } = await withMandate();
    await billing().updateAutoRecharge(c.ctx, SETTINGS);
    await billing().cancelMandate(c.ctx, { mandateId });
    const [mandate] = await adminQuery<{ status: string; provider_token_id: string }>(
      'SELECT status, provider_token_id FROM app.payment_mandates WHERE id = $1',
      [mandateId],
    );
    expect(mandate!.status).toBe('cancelled');
    expect(standIn.state.tokens.get(mandate!.provider_token_id)!.deleted).toBe(true);
    await expect(billing().updateAutoRecharge(c.ctx, SETTINGS)).rejects.toSatisfy(
      (e: unknown) => isAppError(e) && e.code === 'precondition_failed',
    );
  });

  it('an attempt left unknown by a crash is found by the sweep and reconciled after restart', async () => {
    const { c } = await withMandate();
    await billing().updateAutoRecharge(c.ctx, SETTINGS);
    const { attemptId } = await beginAutoRecharge(dbs.app, c.scope);
    // Simulate a worker that wrote the intent and died before calling Razorpay.
    await dbs.adminPool.query(
      `UPDATE app.auto_recharge_attempts SET status = 'unknown', unknown_step = 'create_order',
              next_check_at = now() - interval '1 minute' WHERE id = $1`,
      [attemptId],
    );
    const due = await findBillingReconciliationDue(dbs.app, 1000);
    expect(due).toContainEqual({ tenantId: c.tenantId, kind: 'attempt', id: attemptId });
    expect((await advance(c, attemptId!)).outcome).toBe('payment_requested');
    const orders = [...standIn.state.orders.values()].filter(
      (o) => o.receipt === `ar_${attemptId}`,
    );
    expect(orders).toHaveLength(1);
  });

  it('auto-recharge requires Razorpay card mandates to be enabled for the platform', async () => {
    const c = await company();
    await expect(
      billing({ recurringCardsEnabled: false }).startMandateSetup(c.ctx, {
        maxAmountMinor: 100_000,
        email: 'billing@example.test',
        contact: '+919000000002',
      }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === 'unsupported');
    await expect(
      billing().startMandateSetup(c.ctx, {
        maxAmountMinor: 1_600_000,
        email: 'billing@example.test',
        contact: '+919000000002',
      }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === 'validation_failed');
  });
});

describe('cross-company isolation', () => {
  it('one company cannot read or move another company’s credit', async () => {
    const a = await company();
    const b = await company();
    const topup = await startTopup(a, 60_000);
    const payment = standIn.pay(topup.orderId);
    await paymentEvent('payment.captured', payment);
    expect((await balances(a.tenantId)).available).toBe(60_000);

    const overviewB = await billing().overview(b.ctx);
    expect(overviewB.wallet).toEqual({ availableMinor: 0, heldMinor: 0 });
    expect(overviewB.topups).toEqual([]);
    const visible = await dbs.app.run(b.scope, (tx) =>
      tx.execute(
        sql`select count(*)::int as n from app.topups where tenant_id = ${a.tenantId}::uuid`,
      ),
    );
    expect(visible.rows[0]).toEqual({ n: 0 });
    // B cannot credit, refund or confirm A's top-up even with A's ids.
    await expect(
      dbs.app.run(b.scope, (tx) =>
        tx.execute(
          sql`select app.billing_credit_topup(${topup.topupId}::uuid, ${topup.orderId}, ${payment.id}, 60000, 'INR', 'x')`,
        ),
      ),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === 'not_found');
    await expect(
      billing().confirmTopupCheckout(b.ctx, {
        topupId: topup.topupId,
        paymentId: payment.id,
        signature: checkoutSignature(topup.orderId, payment.id),
      }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === 'not_found');
    expect((await balances(a.tenantId)).available).toBe(60_000);
    expect(
      verifyCheckoutSignature(
        topup.orderId,
        payment.id,
        checkoutSignature(topup.orderId, payment.id),
        KEY_SECRET,
      ),
    ).toBe(true);
  });
});

describe('abandoned card setups', () => {
  it('a setup completed after it was replaced is deleted at Razorpay, not activated', async () => {
    const c = await company();
    const svc = billing();
    const input = {
      maxAmountMinor: 100_000,
      email: 'billing@example.test',
      contact: '+919000000003',
    };
    const first = await svc.startMandateSetup(c.ctx, input);
    const second = await svc.startMandateSetup(c.ctx, input);
    const [old] = await adminQuery<{ status: string }>(
      'SELECT status FROM app.payment_mandates WHERE id = $1',
      [first.mandateId],
    );
    expect(old!.status).toBe('cancelled');
    // The customer finishes the first (abandoned) checkout in another tab.
    const late = standIn.pay(first.orderId);
    await paymentEvent('payment.captured', late);
    const [still] = await adminQuery<{ status: string }>(
      'SELECT status FROM app.payment_mandates WHERE id = $1',
      [first.mandateId],
    );
    expect(still!.status).toBe('cancelled');
    expect(standIn.state.tokens.get(late.tokenId!)!.deleted).toBe(true);
    // The current setup still completes normally.
    const auth = standIn.pay(second.orderId);
    expect(
      await svc.confirmMandateCheckout(c.ctx, {
        mandateId: second.mandateId,
        paymentId: auth.id,
        signature: checkoutSignature(second.orderId, auth.id),
      }),
    ).toEqual({ status: 'active' });
  });
});
