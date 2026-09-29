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
  outboxAad,
  processRazorpayReceipt,
  resolveTenantContext,
  storeWebhookReceipt,
  type BillingNoticeDeps,
  type Statement,
  type TenantContext,
} from '@w360/domain';
import {
  connectTestDatabases,
  createTenant,
  createUser,
  twoTenantFixture,
  type TestDatabases,
} from './helpers';
import { startRazorpayStandIn, type RazorpayStandIn } from '../support/razorpay-stand-in';

/**
 * Billing history against real PostgreSQL (ADR-057): monthly statements computed from the ledger
 * (opening balances, lines, totals and closing balances that reconcile across months, time zones
 * and pages), the statement CSV, payment receipts with the method Razorpay reported, receipt
 * emails, permissions and company isolation. Razorpay is the test-only stand-in; postings in past
 * months are fixture rows written by the test's admin connection.
 */
const KEY_ID = 'rzp_test_StandIn00000002';
const KEY_SECRET = randomBytes(16).toString('hex');
const WEBHOOK_SECRET = randomBytes(16).toString('hex');

let dbs: TestDatabases;
let boss: PgBoss;
let standIn: RazorpayStandIn;
let razorpay: RazorpayClient;
const signer = new JobSigner(randomBytes(32).toString('hex'));
const keyring = new Keyring({ primaryKeyId: 'test', keys: { test: randomBytes(32) } });
const systemClock: Clock = { now: () => new Date() };
/** "Now" for the fixture months: 15 October 2026, 11:30 in Kolkata. */
const FIXED_NOW = new Date('2026-10-15T06:00:00Z');
const fixedClock: Clock = { now: () => FIXED_NOW };

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
    clock: systemClock,
    razorpay,
    razorpayConfig: config(),
    notices: notices(),
  });
const history = (clock: Clock = systemClock) => createBillingHistoryService({ db: dbs.app, clock });

async function adminQuery<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await dbs.adminPool.query<T>(text, params)).rows;
}

interface Company {
  tenantId: string;
  slug: string;
  ownerId: string;
  scope: TenantScope;
  ctx: TenantContext;
}

/** Contexts use the real clock (a member signed in just now); only statements use FIXED_NOW. */
async function contextFor(userId: string, slug: string) {
  return resolveTenantContext(
    { db: dbs.app, clock: systemClock, mfaGracePeriodHours: 72 },
    {
      userId,
      sessionId: `sess_${userId}`,
      sessionCreatedAt: systemClock.now(),
      tenantSlug: slug,
      correlationId: uuidv7(),
    },
  );
}

async function company(): Promise<Company> {
  const owner = await createUser(dbs, { name: 'History Owner' });
  const tenant = await createTenant(dbs, owner);
  return {
    tenantId: tenant.id,
    slug: tenant.slug,
    ownerId: owner.id,
    scope: authorizedTenantScope(tenant.id, null),
    ctx: await contextFor(owner.id, tenant.slug),
  };
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

async function refused(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  throw new Error('expected the call to be refused');
}

/** A paid top-up through the real path: order, Checkout payment, confirmation fetch. */
async function paidTopup(c: Company, amountMinor: number, method = 'card') {
  const topup = await billing().startTopup(c.ctx, { amountMinor });
  const payment = standIn.pay(topup.orderId, { method });
  await billing().confirmTopupCheckout(c.ctx, {
    topupId: topup.topupId,
    paymentId: payment.id,
    signature: createHmac('sha256', KEY_SECRET)
      .update(`${topup.orderId}|${payment.id}`)
      .digest('hex'),
  });
  return { topupId: topup.topupId, orderId: topup.orderId, payment };
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
  const stored = await storeWebhookReceipt(
    { db: dbs.app, keyring, jobs: new PgBossJobQueue(boss), signer },
    {
      provider: 'razorpay',
      rawBody: body,
      eventId: `evt_h${eventSeq}_${randomBytes(4).toString('hex')}`,
    },
  );
  return processRazorpayReceipt(
    { db: dbs.app, razorpay, clock: systemClock, notices: notices(), keyring },
    stored.receiptId,
  );
}

async function billingEmails(tenantId: string) {
  const rows = await adminQuery<{ id: string; to_address: string; payload_ciphertext: string }>(
    `SELECT id, to_address, payload_ciphertext FROM ops.email_outbox
      WHERE tenant_id = $1 AND kind = 'billing.notice' ORDER BY id`,
    [tenantId],
  );
  return rows.map((r) => ({
    to: r.to_address,
    payload: JSON.parse(keyring.decryptString(r.payload_ciphertext, outboxAad(r.id))) as {
      subject: string;
      lines: string[];
      url: string;
    },
  }));
}

/** The company's wallet, created as the product does (first payment start). */
async function walletOf(c: Company, createdAt?: string): Promise<string> {
  const id = await dbs.app.run(c.scope, async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`select app.billing_ensure_wallet() as id`);
    return res.rows[0]!.id;
  });
  if (createdAt) {
    await adminQuery('UPDATE app.wallets SET created_at = $2 WHERE id = $1', [id, createdAt]);
  }
  return id;
}

type Line = [account: string, direction: 'debit' | 'credit', amountMinor: number];

/** A balanced posting at a chosen time (fixture only: product postings go through 0004's functions). */
async function posting(
  c: Company,
  walletId: string,
  at: string,
  kind: string,
  lines: Line[],
  reference: { type?: string; id?: string; actor?: string } = {},
): Promise<string> {
  const client = await dbs.adminPool.connect();
  const id = uuidv7();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO app.ledger_transactions (id, tenant_id, wallet_id, kind, idempotency_key, reference_type,
                                            reference_id, description, actor_type, actor_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'fixture', 'system', $8, $9)`,
      [
        id,
        c.tenantId,
        walletId,
        kind,
        `fixture:${id}`,
        reference.type ?? null,
        reference.id ?? null,
        reference.actor ?? null,
        at,
      ],
    );
    for (const [code, direction, amount] of lines) {
      await client.query(
        `INSERT INTO app.ledger_entries (tenant_id, transaction_id, account_id, direction, amount_minor, created_at)
         SELECT $1, $2, a.id, $4, $5, $6 FROM app.ledger_accounts a
          WHERE a.tenant_id = $1 AND a.wallet_id = $3 AND a.code = $7`,
        [c.tenantId, id, walletId, direction, amount, at, code],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return id;
}

const credit = (amount: number): Line[] => [
  ['payment_clearing', 'debit', amount],
  ['wallet_available', 'credit', amount],
];
const refund = (amount: number): Line[] => [
  ['wallet_available', 'debit', amount],
  ['payment_clearing', 'credit', amount],
];
const hold = (amount: number): Line[] => [
  ['wallet_available', 'debit', amount],
  ['wallet_held', 'credit', amount],
];
const settle = (held: number, charged: number): Line[] => [
  ['wallet_held', 'debit', held],
  ['service_revenue', 'credit', charged],
  ['wallet_available', 'credit', held - charged],
];
const release = (amount: number): Line[] => [
  ['wallet_held', 'debit', amount],
  ['wallet_available', 'credit', amount],
];

const total = (b: Statement['opening']) => b.availableMinor + b.reservedMinor;

function expectReconciles(s: Statement) {
  const t = s.totals;
  expect(total(s.closing)).toBe(
    total(s.opening) +
      t.creditAddedMinor -
      t.serviceChargesMinor -
      t.refundsMinor -
      t.chargebacksMinor,
  );
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
});

afterAll(async () => {
  await standIn.close();
  await boss.stop({ graceful: false });
  await dbs.close();
});

describe('payment receipts', () => {
  it('a paid top-up has a receipt with the method Razorpay reported, and its billing managers get it by email', async () => {
    const c = await company();
    const { topupId, orderId, payment } = await paidTopup(c, 50_000, 'upi');

    const receipt = await history().receipt(c.ctx, topupId);
    expect(receipt).toMatchObject({
      topupId,
      receiptNumber: `tu_${topupId}`,
      kind: 'manual',
      status: 'paid',
      amountMinor: 50_000,
      method: 'upi',
      methodLabel: 'UPI',
      card: null,
      providerPaymentId: payment.id,
      providerOrderId: orderId,
      refundedMinor: 0,
      adjustments: [],
    });
    expect(receipt.creditedAt.getTime()).toBe(receipt.confirmedAt.getTime());

    const emails = await billingEmails(c.tenantId);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.payload.subject).toBe('Payment received: service credit added');
    expect(emails[0]!.payload.url).toBe(
      `http://localhost:3000/c/${c.slug}/billing/receipts/${topupId}`,
    );
    expect(emails[0]!.payload.lines.join(' ')).toContain(`tu_${topupId}`);
    expect(emails[0]!.payload.lines.join(' ')).toContain('not a tax invoice');

    // The same payment seen again (a webhook after the confirmation) credits and emails nothing new.
    await deliver('payment.captured', {
      payment: {
        entity: {
          id: payment.id,
          entity: 'payment',
          order_id: orderId,
          amount: 50_000,
          status: 'captured',
        },
      },
    });
    expect(await billingEmails(c.tenantId)).toHaveLength(1);

    // A top-up credited before 0029 has no method; the next sighting of its payment records it.
    await adminQuery('UPDATE app.topups SET payment_method = NULL WHERE id = $1', [topupId]);
    expect((await history().receipt(c.ctx, topupId)).methodLabel).toBeNull();
    await deliver('payment.captured', {
      payment: {
        entity: {
          id: payment.id,
          entity: 'payment',
          order_id: orderId,
          amount: 50_000,
          status: 'captured',
        },
      },
    });
    expect((await history().receipt(c.ctx, topupId)).method).toBe('upi');

    // A partial refund appears on the receipt with its Razorpay id.
    const partial = await razorpay.createRefund(payment.id, {
      amount: 20_000,
      idempotencyKey: `history-refund-${randomBytes(4).toString('hex')}`,
    });
    expect(partial.ok).toBe(true);
    const refundId = partial.ok ? partial.data.id : '';
    await deliver('refund.processed', {
      refund: {
        entity: { id: refundId, entity: 'refund', payment_id: payment.id, amount: 20_000 },
      },
    });
    const refunded = await history().receipt(c.ctx, topupId);
    expect(refunded.status).toBe('partially_refunded');
    expect(refunded.refundedMinor).toBe(20_000);
    expect(refunded.adjustments).toEqual([
      expect.objectContaining({
        kind: 'refund',
        label: 'Refund to card',
        amountMinor: 20_000,
        reference: refundId,
      }),
    ]);
  });

  it('only a completed payment has a receipt', async () => {
    const c = await company();
    const started = await billing().startTopup(c.ctx, { amountMinor: 10_000 });
    expect(await refused(history().receipt(c.ctx, started.topupId))).toBe('not_found');
    expect(await refused(history().receipt(c.ctx, uuidv7()))).toBe('not_found');
    expect(await refused(history().receipt(c.ctx, 'not-a-uuid'))).toBe('not_found');
    expect(await billingEmails(c.tenantId)).toEqual([]);
  });

  it('runtime code cannot set a payment method except through the payment that credited the top-up', async () => {
    const c = await company();
    const other = await company();
    const { topupId, payment } = await paidTopup(c, 20_000, 'netbanking');
    const inScope = (scope: TenantScope, text: string) =>
      dbs.app.run(scope, (tx) => tx.execute(sql.raw(text)));

    expect(
      await databaseRefusal(
        inScope(c.scope, `UPDATE app.topups SET payment_method = 'card' WHERE id = '${topupId}'`),
      ),
    ).toMatch(/permission denied/);
    const [row] = await adminQuery<{ wallet_id: string }>(
      'SELECT wallet_id FROM app.topups WHERE id = $1',
      [topupId],
    );
    const forged = (method: string | null) =>
      inScope(
        c.scope,
        `INSERT INTO app.topups (id, tenant_id, wallet_id, kind, amount_minor, receipt, payment_method)
         VALUES ('${uuidv7()}', '${c.tenantId}', '${row!.wallet_id}', 'manual', 10000,
                 'tu_${randomBytes(4).toString('hex')}', ${method ? `'${method}'` : 'NULL'})`,
      );
    expect(await databaseRefusal(forged('card'))).toMatch(/row-level security/);
    await forged(null); // the same top-up without a method is an ordinary new top-up
    const record = (scope: TenantScope, paymentId: string, method: string) =>
      dbs.app.run(scope, async (tx) => {
        const res = await tx.execute<{ ok: boolean }>(
          sql`select app.billing_record_payment_method(${topupId}::uuid, ${paymentId}, ${method}) as ok`,
        );
        return res.rows[0]!.ok;
      });
    const stored = async () =>
      (
        await adminQuery<{ payment_method: string | null }>(
          'SELECT payment_method FROM app.topups WHERE id = $1',
          [topupId],
        )
      )[0]!.payment_method;
    // A method already recorded is never replaced.
    expect(await record(c.scope, payment.id, 'card')).toBe(false);
    expect(await stored()).toBe('netbanking');
    // Without a method yet: another payment id or another company changes nothing either.
    await adminQuery('UPDATE app.topups SET payment_method = NULL WHERE id = $1', [topupId]);
    expect(await record(c.scope, 'pay_SomeoneElse0001', 'card')).toBe(false);
    expect(await record(other.scope, payment.id, 'card')).toBe(false);
    expect(await stored()).toBeNull();
    await expect(record(c.scope, payment.id, 'Card; DROP')).rejects.toThrow(
      /invalid payment method/,
    );
    expect(await record(c.scope, payment.id, 'netbanking')).toBe(true);
    expect(await stored()).toBe('netbanking');
  });
});

describe('monthly statements', () => {
  /**
   * Fixture months for a Kolkata company, "now" 15 October 2026:
   *   July: credit 1,000; hold 200; settled 150 (50 back)           closes at 850
   *   August: refund 300; credit 500 at 23:59:59 on the 31st        closes at 1,050
   *   September: credit 200 at 00:00:00 on the 1st; chargeback 50;
   *              hold 70 still open                                  closes at 1,200 (70 reserved)
   *   October (to date): the hold released                          1,200
   */
  async function fixtureCompany() {
    const c = await company();
    const wallet = await walletOf(c, '2026-07-05T00:00:00Z');
    await posting(c, wallet, '2026-07-10T04:30:00Z', 'topup_credit', credit(100_000));
    await posting(c, wallet, '2026-07-20T04:30:00Z', 'hold', hold(20_000), {
      type: 'test_service',
      id: 'job-1',
    });
    await posting(c, wallet, '2026-07-21T04:30:00Z', 'hold_settle', settle(20_000, 15_000), {
      type: 'test_service',
      id: 'job-1',
    });
    await posting(c, wallet, '2026-08-05T04:30:00Z', 'refund', refund(30_000), {
      actor: 'rfnd_Fixture00000001',
    });
    await posting(c, wallet, '2026-08-31T18:29:59Z', 'topup_credit', credit(50_000));
    await posting(c, wallet, '2026-08-31T18:30:00Z', 'topup_credit', credit(20_000));
    await posting(c, wallet, '2026-09-10T04:30:00Z', 'dispute_loss', refund(5_000), {
      actor: 'disp_Fixture00000001',
    });
    await posting(c, wallet, '2026-09-29T04:30:00Z', 'hold', hold(7_000), {
      type: 'test_service',
      id: 'job-2',
    });
    await posting(c, wallet, '2026-10-02T04:30:00Z', 'hold_release', release(7_000), {
      type: 'test_service',
      id: 'job-2',
    });
    return c;
  }

  it('months carry their balances forward and every statement reconciles', async () => {
    const c = await fixtureCompany();
    const h = history(fixedClock);
    const months = await h.statementMonths(c.ctx);
    expect(months.map((m) => [m.month, m.lineCount, m.inProgress, total(m.closing)])).toEqual([
      ['2026-10', 1, true, 120_000],
      ['2026-09', 3, false, 120_000],
      ['2026-08', 2, false, 105_000],
      ['2026-07', 3, false, 85_000],
    ]);
    expect(months[1]!.closing).toEqual({ availableMinor: 113_000, reservedMinor: 7_000 });
    expect(months[3]).toMatchObject({
      label: 'July 2026',
      creditAddedMinor: 100_000,
      serviceChargesMinor: 15_000,
    });

    let previous: Statement | null = null;
    for (const month of ['2026-07', '2026-08', '2026-09', '2026-10']) {
      const s = await h.statement(c.ctx, { month });
      expectReconciles(s);
      if (previous) expect(s.opening).toEqual(previous.closing);
      else expect(s.opening).toEqual({ availableMinor: 0, reservedMinor: 0 });
      const summary = months.find((m) => m.month === month)!;
      expect(s.closing).toEqual(summary.closing);
      previous = s;
    }

    const august = await h.statement(c.ctx, { month: '2026-08' });
    expect(august).toMatchObject({
      label: 'August 2026',
      timezone: 'Asia/Kolkata',
      inProgress: false,
      opening: { availableMinor: 85_000, reservedMinor: 0 },
      closing: { availableMinor: 105_000, reservedMinor: 0 },
      totals: {
        creditAddedMinor: 50_000,
        serviceChargesMinor: 0,
        refundsMinor: 30_000,
        chargebacksMinor: 0,
      },
      lineCount: 2,
      page: 1,
      pageCount: 1,
    });
    expect(august.start).toEqual(new Date('2026-07-31T18:30:00Z'));
    expect(august.end).toEqual(new Date('2026-08-31T18:30:00Z'));
    expect(
      august.lines.map((l) => [
        l.kind,
        l.label,
        l.reference,
        l.availableChangeMinor,
        l.availableAfterMinor,
      ]),
    ).toEqual([
      ['refund', 'Refund to card', 'rfnd_Fixture00000001', -30_000, 55_000],
      ['topup_credit', 'Credit added', null, 50_000, 105_000],
    ]);

    const september = await h.statement(c.ctx, { month: '2026-09' });
    expect(
      september.lines.map((l) => [l.kind, l.reservedChangeMinor, l.reservedAfterMinor]),
    ).toEqual([
      ['topup_credit', 0, 0],
      ['dispute_loss', 0, 0],
      ['hold', 7_000, 7_000],
    ]);
    expect(september.lines[2]!.reference).toBe('test_service job-2');
    expect(september.totals.chargebacksMinor).toBe(5_000);

    const october = await h.statement(c.ctx, { month: '2026-10' });
    expect(october.inProgress).toBe(true);
    expect(october.closing).toEqual({ availableMinor: 120_000, reservedMinor: 0 });

    // Outside the months the wallet has existed: no statement.
    for (const month of ['2026-06', '2026-11', '2026-13', 'latest']) {
      expect(['not_found', 'validation_failed']).toContain(
        await refused(h.statement(c.ctx, { month })),
      );
    }
  });

  it('months follow the company time zone', async () => {
    const c = await fixtureCompany();
    await adminQuery(`UPDATE app.tenants SET timezone = 'UTC' WHERE id = $1`, [c.tenantId]);
    const utc = await contextFor(c.ownerId, c.slug);
    const august = await history(fixedClock).statement(utc, { month: '2026-08' });
    // 18:30 UTC on 31 August is already September in Kolkata, but still August in UTC.
    expect(august.timezone).toBe('UTC');
    expect(august.totals.creditAddedMinor).toBe(70_000);
    expect(august.closing.availableMinor).toBe(125_000);
    expect(
      (await history(fixedClock).statement(utc, { month: '2026-09' })).totals.creditAddedMinor,
    ).toBe(0);
  });

  it('long months are paged with balances carried across pages', async () => {
    const c = await company();
    const wallet = await walletOf(c, '2026-09-01T00:00:00Z');
    await posting(c, wallet, '2026-09-02T00:00:00Z', 'topup_credit', credit(1_000_000));
    // 204 small charges settled the same day, one second apart.
    const client = await dbs.adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `WITH tx AS (
           INSERT INTO app.ledger_transactions (id, tenant_id, wallet_id, kind, idempotency_key, reference_type,
                                                reference_id, description, actor_type, created_at)
           SELECT gen_random_uuid(), $1, $2, 'hold_settle', 'fixture:page:' || g, 'test_service', 'page-' || g,
                  'fixture', 'system', timestamptz '2026-09-03 00:00:00+00' + g * interval '1 second'
             FROM generate_series(1, 204) g
           RETURNING id, created_at
         ), accounts AS (
           SELECT code, id FROM app.ledger_accounts WHERE tenant_id = $1 AND wallet_id = $2
         )
         INSERT INTO app.ledger_entries (tenant_id, transaction_id, account_id, direction, amount_minor, created_at)
         SELECT $1, tx.id, a.id, d.direction, 100, tx.created_at
           FROM tx
          CROSS JOIN (VALUES ('wallet_available', 'debit'), ('service_revenue', 'credit')) AS d(code, direction)
           JOIN accounts a ON a.code = d.code`,
        [c.tenantId, wallet],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const h = history(fixedClock);
    const first = await h.statement(c.ctx, { month: '2026-09' });
    expect(first).toMatchObject({ lineCount: 205, page: 1, pageCount: 3 });
    expect(first.lines).toHaveLength(100);
    expect(first.totals.serviceChargesMinor).toBe(204 * 100);
    const second = await h.statement(c.ctx, { month: '2026-09', page: '2' });
    expect(second.lines).toHaveLength(100);
    // Line 101 is the 100th charge: 1,000,000 − 100 × 100.
    expect(second.lines[0]!.availableAfterMinor).toBe(1_000_000 - 100 * 100);
    const last = await h.statement(c.ctx, { month: '2026-09', page: 9 });
    expect(last.page).toBe(3);
    expect(last.lines).toHaveLength(5);
    expect(last.lines.at(-1)!.availableAfterMinor).toBe(last.closing.availableMinor);
    expect(last.closing.availableMinor).toBe(1_000_000 - 204 * 100);
    expectReconciles(last);
  });

  it('the CSV has exact amounts that stay numbers, an opening and a closing row, and is audited', async () => {
    const c = await fixtureCompany();
    const file = await history(fixedClock).statementCsv(c.ctx, { month: '2026-08' });
    expect(file.filename).toBe('statement-2026-08.csv');
    expect(file.body.startsWith('﻿')).toBe(true);
    const rows = file.body.slice(1).trimEnd().split('\r\n');
    expect(rows).toEqual([
      'Date (Asia/Kolkata),Activity,Reference,Receipt number,Available credit change (INR),Reserved credit change (INR),Available credit after (INR),Reserved credit after (INR)',
      '2026-08-01 00:00:00,Opening balance,,,,,850.00,0.00',
      '2026-08-05 10:00:00,Refund to card,rfnd_Fixture00000001,,-300.00,0.00,550.00,0.00',
      '2026-08-31 23:59:59,Credit added,,,500.00,0.00,1050.00,0.00',
      '2026-09-01 00:00:00,Closing balance,,,,,1050.00,0.00',
    ]);
    const audits = await adminQuery<{ subject_id: string; metadata: { lines: number } }>(
      `SELECT subject_id, metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'billing.statement_exported'`,
      [c.tenantId],
    );
    expect(audits).toEqual([
      expect.objectContaining({
        subject_id: '2026-08',
        metadata: expect.objectContaining({ lines: 2 }),
      }),
    ]);

    const current = await history(fixedClock).statementCsv(c.ctx, { month: '2026-10' });
    expect(current.body.trimEnd().split('\r\n').at(-1)).toBe(
      '2026-10-15 11:30:00,Balance so far (month to date),,,,,1200.00,0.00',
    );
  });

  it('this month shows the real postings with their receipts, matching the wallet balance', async () => {
    const c = await company();
    const { topupId, payment } = await paidTopup(c, 30_000);
    const h = history();
    const [month] = await h.statementMonths(c.ctx);
    expect(month).toMatchObject({ inProgress: true, lineCount: 1, creditAddedMinor: 30_000 });
    const statement = await h.statement(c.ctx, { month: month!.month });
    expect(statement.lines).toEqual([
      expect.objectContaining({
        kind: 'topup_credit',
        reference: payment.id,
        topupId,
        receiptNumber: `tu_${topupId}`,
        availableChangeMinor: 30_000,
        availableAfterMinor: 30_000,
      }),
    ]);
    const [account] = await adminQuery<{ balance_minor: string }>(
      `SELECT balance_minor FROM app.ledger_accounts WHERE tenant_id = $1 AND code = 'wallet_available'`,
      [c.tenantId],
    );
    expect(statement.closing.availableMinor).toBe(Number(account!.balance_minor));
  });
});

describe('access', () => {
  it('statements and receipts need billing.read and never show another company', async () => {
    const { ownerA, ownerB, agentA, tenantA, tenantB } = await twoTenantFixture(dbs);
    const a: Company = {
      tenantId: tenantA.id,
      slug: tenantA.slug,
      ownerId: ownerA.id,
      scope: authorizedTenantScope(tenantA.id, null),
      ctx: await contextFor(ownerA.id, tenantA.slug),
    };
    const { topupId } = await paidTopup(a, 10_000);
    const [month] = await history().statementMonths(a.ctx);

    const agent = await contextFor(agentA.id, tenantA.slug);
    expect(await refused(history().statementMonths(agent))).toBe('forbidden');
    expect(await refused(history().statement(agent, { month: month!.month }))).toBe('forbidden');
    expect(await refused(history().statementCsv(agent, { month: month!.month }))).toBe('forbidden');
    expect(await refused(history().receipt(agent, topupId))).toBe('forbidden');

    const b = await contextFor(ownerB.id, tenantB.slug);
    expect(await history().statementMonths(b)).toEqual([]);
    expect(await refused(history().statement(b, { month: month!.month }))).toBe('not_found');
    expect(await refused(history().receipt(b, topupId))).toBe('not_found');
  });
});
