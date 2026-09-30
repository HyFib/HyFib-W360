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
  createPlatformBillingService,
  createRefundRequestsService,
  notifyRefundRequestDeclines,
  outboxAad,
  refundRequestsAnnouncement,
  resolveTenantContext,
  type BillingNoticeDeps,
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
 * Refunds of unused service credit asked for by companies (P5-05, ADR-073) against real PostgreSQL
 * and the test-only Razorpay stand-in: who may ask and what, the daily limit under concurrency,
 * withdrawing, a platform owner's decision (approving starts the staff refund of ADR-058 with every
 * check run again; declining needs a note), the emails to platform owners and billing managers
 * (once each, also under concurrency), the platform lists on exact keyset pages, and what the
 * company's database role can and cannot do.
 */
const KEY_ID = 'rzp_test_StandIn00000046';
const KEY_SECRET = randomBytes(16).toString('hex');
const REASON = 'We are moving to another provider and will not use this credit.';
const NOTE = 'Refunds are for unused credit only; see the terms, ticket 4410.';
const APP_BASE = 'http://localhost:3000';

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
  return { outbox: { keyring, jobs: new PgBossJobQueue(boss), signer }, appBaseUrl: APP_BASE };
}
const billing = () =>
  createBillingService({
    db: dbs.app,
    clock,
    razorpay,
    razorpayConfig: config(),
    notices: notices(),
  });
const requests = () => createRefundRequestsService({ db: dbs.app, clock });
const staff = () => createPlatformBillingService({ platformDb: dbs.platform });
const announce = () =>
  announceRefundRequests({ db: dbs.app, outbox: notices().outbox, appBaseUrl: APP_BASE });
const tellDeclines = () => notifyRefundRequestDeclines({ db: dbs.app, notices: notices() });

async function adminQuery<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await dbs.adminPool.query<T>(text, params)).rows;
}

interface Company {
  tenant: TestTenant;
  tenantId: string;
  scope: TenantScope;
  owner: TestUser;
  ctx: TenantContext;
}

/** A member's context as a browser session that started `minutesAgo` minutes ago. */
function signedIn(tenant: TestTenant, user: TestUser, minutesAgo: number | null = 0) {
  return resolveTenantContext(
    { db: dbs.app, clock, mfaGracePeriodHours: 72 },
    {
      userId: user.id,
      sessionId: `sess_${user.id}`,
      sessionCreatedAt: minutesAgo === null ? null : new Date(Date.now() - minutesAgo * 60_000),
      tenantSlug: tenant.slug,
      correlationId: uuidv7(),
    },
  );
}

async function company(): Promise<Company> {
  const user = await createUser(dbs, { name: 'Refund Request Owner' });
  const tenant = await createTenant(dbs, user);
  return {
    tenant,
    tenantId: tenant.id,
    scope: authorizedTenantScope(tenant.id, null),
    owner: user,
    ctx: await signedIn(tenant, user),
  };
}

async function member(c: Company, role: string, name: string): Promise<TestUser> {
  const user = await createUser(dbs, { name });
  const { token } = await invite(dbs, c.tenant, c.owner, user.email, [role]);
  await acceptInvitation(dbs, user, token);
  return user;
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
  return { topupId: topup.topupId };
}

const ask = (c: Company, topupId: string, amount: string, ctx: TenantContext = c.ctx) =>
  requests().ask(ctx, { topupId, amount, reason: REASON });

const decide = (
  actor: PlatformActor,
  requestId: string,
  decision: 'approve' | 'decline',
  note?: string,
) => staff().decideRefundRequest(actor, { requestId, decision, note });

/** Holds credit for a running service, as a send does: spent credit is not refunded. */
async function holdForService(c: Company, amountMinor: number) {
  await dbs.app.run(c.scope, (tx) =>
    tx.execute(
      sql`select app.billing_hold(${`svc:${uuidv7()}`}, ${amountMinor}::bigint, 'service', 'svc-1',
            now() + interval '1 day')`,
    ),
  );
}

async function wallet(c: Company) {
  const { wallet } = await billing().overview(c.ctx);
  return { availableMinor: wallet.availableMinor, heldMinor: wallet.heldMinor };
}

async function requestRow(id: string) {
  const [row] = await adminQuery<{
    status: string;
    amount_minor: number;
    topup_id: string;
    reason: string;
    requested_by_user_id: string;
    withdrawn_at: Date | null;
    decided_by_user_id: string | null;
    decided_at: Date | null;
    decision_note: string | null;
    credit_refund_id: string | null;
    announced_at: Date | null;
    decline_notified_at: Date | null;
  }>(
    `SELECT status, amount_minor::int AS amount_minor, topup_id, reason, requested_by_user_id,
            withdrawn_at, decided_by_user_id, decided_at, decision_note, credit_refund_id,
            announced_at, decline_notified_at
       FROM app.credit_refund_requests WHERE id = $1`,
    [id],
  );
  return row!;
}

async function refundsOf(tenantId: string) {
  return adminQuery<{ id: string; amount_minor: number; reason: string; status: string }>(
    `SELECT id, amount_minor::int AS amount_minor, reason, status FROM app.credit_refunds
      WHERE tenant_id = $1 ORDER BY requested_at`,
    [tenantId],
  );
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

/** The company's billing emails with a subject, decrypted. */
async function billingEmails(tenantId: string, subject: string) {
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
    .filter((e) => e.subject === subject);
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
  owner = await platformActor('platform_owner', 'Refund Deciding Owner');
  operator = await platformActor('platform_operator', 'Refund Reading Operator');
});

afterAll(async () => {
  await standIn.close();
  await boss.stop({ graceful: false });
  await dbs.close();
});

describe('asking for a refund', () => {
  it('lets a billing manager ask for part of a payment with a reason: nothing is held, it is audited and shown to the company and platform staff', async () => {
    const c = await company();
    const { topupId } = await paidTopup(c, 50_000);
    const billingUser = await member(c, 'billing', 'Billing Person');
    const manager = await signedIn(c.tenant, billingUser);
    expect(await requests().forTopup(manager, topupId)).toEqual({
      requests: [],
      askable: { maxMinor: 50_000, reason: null },
    });

    const { requestId } = await requests().ask(manager, {
      topupId,
      amount: ' 200.50 ',
      reason: `  ${REASON}  `,
    });
    expect(await wallet(c)).toEqual({ availableMinor: 50_000, heldMinor: 0 });
    expect(await requestRow(requestId)).toEqual({
      status: 'open',
      amount_minor: 20_050,
      topup_id: topupId,
      reason: REASON,
      requested_by_user_id: billingUser.id,
      withdrawn_at: null,
      decided_by_user_id: null,
      decided_at: null,
      decision_note: null,
      credit_refund_id: null,
      announced_at: null,
      decline_notified_at: null,
    });
    expect(await companyAudit(c.tenantId, 'billing.credit_refund_requested')).toEqual([
      {
        subject_id: requestId,
        actor_type: 'user',
        actor_id: billingUser.id,
        metadata: { topupId, amountMinor: 20_050 },
      },
    ]);
    expect(await refundsOf(c.tenantId)).toEqual([]);

    // The receipt shows it, and says why nothing more can be asked for now.
    const view = await requests().forTopup(c.ctx, topupId);
    expect(view.requests).toEqual([
      expect.objectContaining({
        id: requestId,
        topupId,
        amountMinor: 20_050,
        reason: REASON,
        status: 'open',
        requestedByName: 'Billing Person',
        withdrawnAt: null,
        decidedAt: null,
        decisionNote: null,
        refund: null,
      }),
    ]);
    expect(view.askable).toEqual({
      maxMinor: null,
      reason: 'You asked for a refund of this payment; HyFib has not decided yet.',
    });
    expect((await requests().list(c.ctx)).map((r) => r.id)).toEqual([requestId]);

    // Platform staff see it with the payment and the company's unused credit now.
    for (const actor of [owner, operator]) {
      const page = await staff().refundRequests(actor, { status: 'open' });
      expect(page.items).toContainEqual(
        expect.objectContaining({
          id: requestId,
          tenantId: c.tenantId,
          companyName: `Company ${c.tenant.slug}`,
          companySlug: c.tenant.slug,
          companyStatus: 'active',
          topupId,
          topupAmountMinor: 50_000,
          topupRefundedMinor: 0,
          availableMinor: 50_000,
          refundInProgress: false,
          amountMinor: 20_050,
          reason: REASON,
          status: 'open',
          requestedByName: 'Billing Person',
          decidedAt: null,
          decidedByName: null,
          decisionNote: null,
          creditRefundId: null,
          creditRefundStatus: null,
        }),
      );
      expect(page.items.find((r) => r.id === requestId)!.topupPaidAt).toBeInstanceOf(Date);
    }
  });

  it('needs billing.manage and a sign-in within the last 15 minutes', async () => {
    const c = await company();
    const { topupId } = await paidTopup(c, 20_000);
    const input = { topupId, amount: '10', reason: REASON };
    const agent = await signedIn(c.tenant, await member(c, 'agent', 'Agent Person'));
    const admin = await signedIn(c.tenant, await member(c, 'admin', 'Admin Person'));
    expect(await refused(requests().ask(agent, input))).toBe('forbidden');
    expect(await refused(requests().forTopup(agent, topupId))).toBe('forbidden');
    expect(await refused(requests().list(agent))).toBe('forbidden');
    // Administrators read billing but do not manage it.
    expect(await refused(requests().ask(admin, input))).toBe('forbidden');
    expect((await requests().forTopup(admin, topupId)).askable.maxMinor).toBe(20_000);

    const stale = await signedIn(c.tenant, c.owner, RECENT_SIGN_IN_MINUTES + 5);
    const unknown = await signedIn(c.tenant, c.owner, null);
    expect(await refused(requests().ask(stale, input))).toBe('step_up_required');
    expect(await refused(requests().ask(unknown, input))).toBe('step_up_required');
    expect(
      await adminQuery('SELECT id FROM app.credit_refund_requests WHERE tenant_id = $1', [
        c.tenantId,
      ]),
    ).toEqual([]);

    // Withdrawing needs no fresh sign-in, but it needs billing.manage.
    const { requestId } = await ask(c, topupId, '10');
    expect(await refused(requests().withdraw(agent, requestId))).toBe('forbidden');
    expect(await refused(requests().withdraw(admin, requestId))).toBe('forbidden');
    await requests().withdraw(stale, requestId);
    expect((await requestRow(requestId)).status).toBe('withdrawn');
  });

  it('refuses bad input, more than is left of the payment or unused, a running refund and payments that are not the company’s or not paid', async () => {
    const c = await company();
    const { topupId } = await paidTopup(c, 30_000);
    for (const [amount, reason] of [
      ['10', 'too short'],
      ['10', 'x'.repeat(1001)],
      ['', REASON],
      ['0', REASON],
      ['ten', REASON],
      ['1.005', REASON],
      ['-5', REASON],
      ['300.01', REASON],
    ] as const) {
      expect(
        await refused(requests().ask(c.ctx, { topupId, amount, reason })),
        `${amount} ${reason.length}`,
      ).toBe('validation_failed');
    }
    expect((await refusal(ask(c, topupId, '300.01'))).message).toBe(
      'At most ₹300.00 is left of this payment.',
    );
    expect(
      await refused(requests().ask(c.ctx, { topupId: 'not-a-uuid', amount: '1', reason: REASON })),
    ).toBe('validation_failed');

    // Spent credit is not refunded: ₹250 held for a running service leaves ₹50 unused.
    await holdForService(c, 25_000);
    expect(await refusal(ask(c, topupId, '50.01'))).toEqual({
      code: 'validation_failed',
      message: 'You have ₹50.00 of unused credit: HyFib refunds only credit you have not spent.',
    });
    expect((await requests().forTopup(c.ctx, topupId)).askable).toEqual({
      maxMinor: 5_000,
      reason: null,
    });

    // Not while a refund of the payment is in progress.
    await staff().requestRefund(owner, {
      tenantId: c.tenantId,
      topupId,
      amount: '10',
      reason: 'Duplicate payment, ticket 1201',
    });
    expect(await refusal(ask(c, topupId, '10'))).toEqual({
      code: 'conflict',
      message: 'A refund of this payment is already in progress.',
    });
    expect((await requests().forTopup(c.ctx, topupId)).askable).toEqual({
      maxMinor: null,
      reason: 'A refund of this payment is in progress.',
    });

    // Only a paid top-up of this company.
    const unpaid = await billing().startTopup(c.ctx, { amountMinor: 10_000 });
    expect(await refused(ask(c, unpaid.topupId, '10'))).toBe('precondition_failed');
    expect((await requests().forTopup(c.ctx, unpaid.topupId)).askable).toEqual({
      maxMinor: null,
      reason: 'Nothing is left of this payment to refund.',
    });
    expect(await refused(ask(c, uuidv7(), '10'))).toBe('not_found');
    expect(await refused(requests().forTopup(c.ctx, uuidv7()))).toBe('not_found');
    expect(await refused(requests().forTopup(c.ctx, 'not-a-uuid'))).toBe('not_found');
    const other = await company();
    const { topupId: otherTopup } = await paidTopup(other, 10_000);
    expect(await refused(ask(c, otherTopup, '10'))).toBe('not_found');
    expect(await refused(requests().forTopup(c.ctx, otherTopup))).toBe('not_found');
    expect(
      await adminQuery('SELECT id FROM app.credit_refund_requests WHERE tenant_id = ANY($1)', [
        [c.tenantId, other.tenantId],
      ]),
    ).toEqual([]);
  });

  it('keeps one open request per payment, also when two arrive at once', async () => {
    const c = await company();
    const { topupId } = await paidTopup(c, 20_000);
    const results = await Promise.allSettled([ask(c, topupId, '10'), ask(c, topupId, '20')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [rejected] = results.filter((r) => r.status === 'rejected');
    expect(await refusal(Promise.reject((rejected as PromiseRejectedResult).reason))).toEqual({
      code: 'conflict',
      message:
        'You already asked for a refund of this payment. Withdraw that request to ask again.',
    });
    const rows = await adminQuery<{ status: string }>(
      'SELECT status FROM app.credit_refund_requests WHERE tenant_id = $1',
      [c.tenantId],
    );
    expect(rows).toEqual([{ status: 'open' }]);
  });

  it(`allows ${REFUND_REQUEST_LIMITS.perDay} requests a day per company, counted under a lock`, async () => {
    const c = await company();
    const topups: string[] = [];
    for (let i = 0; i < REFUND_REQUEST_LIMITS.perDay + 2; i += 1) {
      topups.push((await paidTopup(c, 10_000)).topupId);
    }
    const results = await Promise.allSettled(topups.map((id) => ask(c, id, '1')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
      REFUND_REQUEST_LIMITS.perDay,
    );
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect(await refused(Promise.reject((r as PromiseRejectedResult).reason))).toBe(
        'rate_limited',
      );
    }
    // Withdrawn requests still count, so withdrawing does not open the limit again.
    const [first] = await requests().list(c.ctx);
    await requests().withdraw(c.ctx, first!.id);
    expect(await refused(ask(c, first!.topupId, '1'))).toBe('rate_limited');
    // A request older than a day no longer counts.
    await adminQuery(
      `UPDATE app.credit_refund_requests SET requested_at = now() - interval '25 hours'
        WHERE id = $1`,
      [first!.id],
    );
    await ask(c, first!.topupId, '1');
  });

  it('is refused once the company asked for its deletion; staff can still decline an open request, approving is refused', async () => {
    const c = await company();
    const { topupId } = await paidTopup(c, 20_000);
    const { requestId } = await ask(c, topupId, '50');
    await dbs.app.run(authorizedTenantScope(c.tenantId, c.owner.id), (tx) =>
      tx.execute(sql`select * from app.request_tenant_deletion(${c.tenant.slug})`),
    );
    const waiting = await signedIn(c.tenant, c.owner);
    expect(waiting.tenant.status).toBe('pending_deletion');
    expect(await refusal(ask(c, topupId, '10', waiting))).toEqual({
      code: 'precondition_failed',
      message: 'The company is being deleted, so it can no longer ask for refunds.',
    });
    expect((await requests().forTopup(waiting, topupId)).askable).toEqual({
      maxMinor: null,
      reason: 'The company is being deleted, so it can no longer ask for refunds.',
    });
    const page = await staff().refundRequests(owner, { status: 'open' });
    expect(page.items.find((r) => r.id === requestId)?.companyStatus).toBe('pending_deletion');
    expect(await refusal(decide(owner, requestId, 'approve'))).toEqual({
      code: 'precondition_failed',
      message: 'The company is being deleted: refund the payment in the Razorpay Dashboard.',
    });
    expect((await requestRow(requestId)).status).toBe('open');
    expect(await refundsOf(c.tenantId)).toEqual([]);
    await decide(owner, requestId, 'decline', NOTE);
    expect((await requestRow(requestId)).status).toBe('declined');
  });

  it('reads the company’s status under a lock, so a deletion asked for meanwhile refuses the request', async () => {
    const c = await company();
    const { topupId } = await paidTopup(c, 20_000);
    // The context was read before the deletion, as a page's is before its form is sent.
    expect(c.ctx.tenant.status).toBe('active');
    const deleting = await dbs.adminPool.connect();
    let asked: Promise<{ code: string; message: string }> | undefined;
    try {
      await deleting.query('BEGIN');
      await deleting.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
        [c.tenantId, c.owner.id],
      );
      await deleting.query('SELECT * FROM app.request_tenant_deletion($1)', [c.tenant.slug]);
      const [holder] = (await deleting.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows;
      asked = refusal(ask(c, topupId, '10'));
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
    expect(
      await adminQuery('SELECT id FROM app.credit_refund_requests WHERE tenant_id = $1', [
        c.tenantId,
      ]),
    ).toEqual([]);
  });
});

describe('withdrawing', () => {
  it('withdraws an open request once, audited, and the company can ask again', async () => {
    const c = await company();
    const { topupId } = await paidTopup(c, 20_000);
    const { requestId } = await ask(c, topupId, '50');
    await requests().withdraw(c.ctx, requestId);
    const row = await requestRow(requestId);
    expect(row.status).toBe('withdrawn');
    expect(row.withdrawn_at).toBeInstanceOf(Date);
    expect(await companyAudit(c.tenantId, 'billing.credit_refund_request_withdrawn')).toEqual([
      { subject_id: requestId, actor_type: 'user', actor_id: c.owner.id, metadata: { topupId } },
    ]);
    expect(await refusal(requests().withdraw(c.ctx, requestId))).toEqual({
      code: 'conflict',
      message: 'This request was already decided or withdrawn.',
    });
    expect(await refused(requests().withdraw(c.ctx, uuidv7()))).toBe('not_found');
    expect(await refused(requests().withdraw(c.ctx, 'not-a-uuid'))).toBe('not_found');
    // A withdrawn request cannot be decided.
    expect(await refused(decide(owner, requestId, 'approve'))).toBe('conflict');

    const again = await ask(c, topupId, '60');
    expect((await requests().forTopup(c.ctx, topupId)).requests.map((r) => r.status)).toEqual([
      'open',
      'withdrawn',
    ]);
    // Another company cannot see or withdraw it.
    const other = await company();
    expect(await refused(requests().withdraw(other.ctx, again.requestId))).toBe('not_found');
    expect(await requests().list(other.ctx)).toEqual([]);
    expect((await requestRow(again.requestId)).status).toBe('open');
  });
});

describe('deciding', () => {
  it('approving starts the staff refund for the amount asked, linked and audited; the company sees it', async () => {
    const c = await company();
    const { topupId } = await paidTopup(c, 50_000);
    const { requestId } = await ask(c, topupId, '200');
    const { refundId } = await decide(owner, requestId, 'approve', 'Approved, ticket 88 on file.');
    expect(refundId).toEqual(expect.any(String));

    const row = await requestRow(requestId);
    expect(row).toMatchObject({
      status: 'approved',
      decided_by_user_id: owner.userId,
      decision_note: 'Approved, ticket 88 on file.',
      credit_refund_id: refundId,
    });
    expect(row.decided_at).toBeInstanceOf(Date);
    // The staff refund of ADR-058: the credit is reserved at once and the reason names the company's.
    expect(await refundsOf(c.tenantId)).toEqual([
      {
        id: refundId,
        amount_minor: 20_000,
        reason: `Asked for by the company: ${REASON}`,
        status: 'requested',
      },
    ]);
    expect(await wallet(c)).toEqual({ availableMinor: 30_000, heldMinor: 20_000 });
    expect(await platformAudit(c.tenantId, 'platform.credit_refund_request_approved')).toEqual([
      {
        actor_user_id: owner.userId,
        reason: 'Approved, ticket 88 on file.',
        result: 'success',
        correlation_id: owner.correlationId,
        metadata: { requestId, topupId, amountMinor: 20_000, refundId },
      },
    ]);
    expect(await platformAudit(c.tenantId, 'platform.credit_refund_requested')).toHaveLength(1);

    // The company sees the decision and the refund, but not who decided.
    const view = await requests().forTopup(c.ctx, topupId);
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
    const decided = await staff().refundRequests(operator, { status: 'decided' });
    expect(decided.items).toContainEqual(
      expect.objectContaining({
        id: requestId,
        status: 'approved',
        decidedByName: 'Refund Deciding Owner',
        creditRefundId: refundId,
        creditRefundStatus: 'requested',
      }),
    );
    expect((await staff().refundRequests(operator, { status: 'open' })).items).not.toContainEqual(
      expect.objectContaining({ id: requestId }),
    );
    const refunds = await staff().creditRefunds(operator);
    expect(refunds.items).toContainEqual(
      expect.objectContaining({
        id: refundId,
        tenantId: c.tenantId,
        companyName: `Company ${c.tenant.slug}`,
        companySlug: c.tenant.slug,
        topupId,
        amountMinor: 20_000,
        status: 'requested',
        reason: `Asked for by the company: ${REASON}`,
        requestedByName: 'Refund Deciding Owner',
        submittedAt: null,
        processedAt: null,
        failedAt: null,
        lastError: null,
        requestId,
      }),
    );

    // Decided once.
    expect(await refusal(decide(owner, requestId, 'decline', NOTE))).toEqual({
      code: 'conflict',
      message: 'This request was already decided or withdrawn.',
    });
    expect(await refused(decide(owner, uuidv7(), 'approve'))).toBe('not_found');
  });

  it('approving checks everything again: a request that no longer fits is refused with the reason and stays open', async () => {
    const c = await company();
    const spent = await paidTopup(c, 30_000);
    const { requestId: tooMuch } = await ask(c, spent.topupId, '300');
    // Credit spent after the request: ₹250 held leaves ₹50.
    await holdForService(c, 25_000);
    expect(await refusal(decide(owner, tooMuch, 'approve'))).toEqual({
      code: 'insufficient_funds',
      message: 'The company has less unused credit than the refund.',
    });
    expect((await requestRow(tooMuch)).status).toBe('open');

    // A refund started from the company's page after the request.
    const second = await paidTopup(c, 20_000);
    const { requestId: running } = await ask(c, second.topupId, '10');
    await staff().requestRefund(owner, {
      tenantId: c.tenantId,
      topupId: second.topupId,
      amount: '5',
      reason: 'Duplicate payment, ticket 1202',
    });
    const page = await staff().refundRequests(owner, { status: 'open' });
    expect(page.items.find((r) => r.id === running)).toMatchObject({ refundInProgress: true });
    expect(await refusal(decide(owner, running, 'approve'))).toEqual({
      code: 'conflict',
      message: 'A refund of this top-up is already in progress.',
    });
    expect((await requestRow(running)).status).toBe('open');
    expect(await refundsOf(c.tenantId)).toHaveLength(1);
    expect(await platformAudit(c.tenantId, 'platform.credit_refund_request_approved')).toEqual([]);

    // Both can still be declined with a note.
    await decide(owner, tooMuch, 'decline', NOTE);
    await decide(owner, running, 'decline', NOTE);
    expect((await requestRow(tooMuch)).status).toBe('declined');
  });

  it('declining needs a note the company reads, and is audited', async () => {
    const c = await company();
    const { topupId } = await paidTopup(c, 20_000);
    const { requestId } = await ask(c, topupId, '100');
    expect(await refused(decide(owner, requestId, 'decline'))).toBe('validation_failed');
    expect(await refused(decide(owner, requestId, 'decline', 'too short'))).toBe(
      'validation_failed',
    );
    expect(await refused(decide(owner, requestId, 'approve', 'short'))).toBe('validation_failed');
    expect(await refused(decide(owner, requestId, 'decline', 'x'.repeat(1001)))).toBe(
      'validation_failed',
    );
    // The function checks the note by itself too.
    for (const note of [null, '   ', 'too short']) {
      const direct = sql`select ops.platform_decide_credit_refund_request(${requestId}::uuid, false,
        ${note}::text, 'direct')`;
      expect(await refused(dbs.platform.run(owner.userId, (tx) => tx.execute(direct)))).toBe(
        'precondition_failed',
      );
    }
    const direct = sql`select ops.platform_decide_credit_refund_request(${requestId}::uuid, null,
      ${NOTE}::text, 'direct')`;
    expect(await refused(dbs.platform.run(owner.userId, (tx) => tx.execute(direct)))).toBe(
      'precondition_failed',
    );
    expect((await requestRow(requestId)).status).toBe('open');

    expect(await decide(owner, requestId, 'decline', `  ${NOTE}  `)).toEqual({ refundId: null });
    expect(await requestRow(requestId)).toMatchObject({
      status: 'declined',
      decided_by_user_id: owner.userId,
      decision_note: NOTE,
      credit_refund_id: null,
      decline_notified_at: null,
    });
    expect(await wallet(c)).toEqual({ availableMinor: 20_000, heldMinor: 0 });
    expect(await platformAudit(c.tenantId, 'platform.credit_refund_request_declined')).toEqual([
      {
        actor_user_id: owner.userId,
        reason: NOTE,
        result: 'success',
        correlation_id: owner.correlationId,
        metadata: { requestId, topupId, amountMinor: 10_000, refundId: null },
      },
    ]);
    const view = await requests().forTopup(c.ctx, topupId);
    expect(view.requests[0]).toMatchObject({
      status: 'declined',
      decisionNote: NOTE,
      refund: null,
    });
    // The company can ask again.
    expect(view.askable).toEqual({ maxMinor: 20_000, reason: null });
  });

  it('is for platform owners only, checked by the database as well as the service', async () => {
    const c = await company();
    const { topupId } = await paidTopup(c, 20_000);
    const { requestId } = await ask(c, topupId, '100');
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
    expect(await refused(staff().refundRequests(claimed))).toBe('forbidden');
    expect(await refused(staff().creditRefunds(claimed))).toBe('forbidden');
    // The decision function checks the owner itself, for a decline too (an approval would also be
    // refused by the staff refund's own check, later).
    const direct = sql`select ops.platform_decide_credit_refund_request(${requestId}::uuid, true,
      null::text, 'direct')`;
    const declineDirect = sql`select ops.platform_decide_credit_refund_request(${requestId}::uuid,
      false, ${NOTE}::text, 'direct')`;
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
      sql`select * from ops.platform_credit_refund_requests(null, null, null, 10)`,
      sql`select * from ops.platform_credit_refunds(null, null, 10)`,
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
            sql`select * from ops.platform_credit_refund_requests('withdrawn', null, null, 10)`,
          ),
        ),
      ),
    ).toBe('precondition_failed');
    expect((await requestRow(requestId)).status).toBe('open');
    expect(await refundsOf(c.tenantId)).toEqual([]);
  });
});

describe('what the company’s database role can do', () => {
  it('reads its requests without who decided, asks only for open requests, and only withdraws them', async () => {
    const c = await company();
    const { topupId } = await paidTopup(c, 20_000);
    const { requestId } = await ask(c, topupId, '100');
    const run = (statement: ReturnType<typeof sql>) =>
      dbs.app.run(authorizedTenantScope(c.tenantId, c.owner.id), (tx) => tx.execute(statement));

    for (const column of ['decided_by_user_id', 'announced_at', 'decline_notified_at']) {
      expect(
        await databaseRefusal(run(sql`select ${sql.raw(column)} from app.credit_refund_requests`)),
        column,
      ).toMatch(/permission denied/);
    }
    // No decided request, and no decision or notice columns, through the company role.
    expect(
      await databaseRefusal(
        run(sql`insert into app.credit_refund_requests (id, tenant_id, topup_id, amount_minor, reason,
                  requested_by_user_id, status)
                values (${uuidv7()}::uuid, ${c.tenantId}::uuid, ${topupId}::uuid, 100, ${REASON},
                  ${c.owner.id}, 'approved')`),
      ),
    ).toMatch(/permission denied/);
    for (const assignment of [
      sql`decision_note = ${NOTE}`,
      sql`decided_at = now()`,
      sql`credit_refund_id = null`,
      sql`announced_at = now()`,
      sql`amount_minor = 1`,
    ]) {
      expect(
        await databaseRefusal(
          run(
            sql`update app.credit_refund_requests set ${assignment} where id = ${requestId}::uuid`,
          ),
        ),
      ).toMatch(/permission denied/);
    }
    expect(
      await databaseRefusal(
        run(
          sql`update app.credit_refund_requests set status = 'approved' where id = ${requestId}::uuid`,
        ),
      ),
    ).toMatch(/row-level security/);
    await requests().withdraw(c.ctx, requestId);
    // A withdrawn request is not reopened.
    const reopened = await run(
      sql`update app.credit_refund_requests set status = 'open', withdrawn_at = null
           where id = ${requestId}::uuid`,
    );
    expect(reopened.rowCount).toBe(0);
    expect((await requestRow(requestId)).status).toBe('withdrawn');
  });

  it('sees only its own requests, even with another company’s id', async () => {
    const a = await company();
    const b = await company();
    const { topupId } = await paidTopup(a, 20_000);
    const { requestId } = await ask(a, topupId, '100');
    const seen = await dbs.app.run(b.scope, (tx) =>
      tx.execute(sql`select id from app.credit_refund_requests where id = ${requestId}::uuid`),
    );
    expect(seen.rows).toEqual([]);
    const moved = await dbs.app.run(b.scope, (tx) =>
      tx.execute(
        sql`update app.credit_refund_requests set status = 'withdrawn', withdrawn_at = now()
             where id = ${requestId}::uuid`,
      ),
    );
    expect(moved.rowCount).toBe(0);
    expect(
      await databaseRefusal(
        dbs.app.run(b.scope, (tx) =>
          tx.execute(sql`insert into app.credit_refund_requests (id, tenant_id, topup_id, amount_minor,
                           reason, requested_by_user_id)
                         values (${uuidv7()}::uuid, ${a.tenantId}::uuid, ${topupId}::uuid, 100,
                           ${REASON}, ${b.owner.id})`),
        ),
      ),
    ).toMatch(/row-level security/);
    expect((await requestRow(requestId)).status).toBe('open');
  });
});

describe('emails', () => {
  it('tells every platform owner once about new requests, a count only; nothing is marked while there is no owner', async () => {
    // Whatever earlier tests left unannounced is announced first.
    await announce();
    const since = await dbNow();
    const owners = await ownerEmails();
    expect(owners.length).toBeGreaterThan(0);
    const c = await company();
    const first = await paidTopup(c, 20_000);
    const second = await paidTopup(c, 20_000);
    const r1 = await ask(c, first.topupId, '50');
    const r2 = await ask(c, second.topupId, '60');

    expect(await announce()).toEqual({ announced: 2, unsent: 0, recipients: owners.length });
    const sent = await platformNotices(since);
    expect(sent.map((n) => n.to).sort()).toEqual(owners);
    for (const notice of sent) {
      expect(notice).toEqual({
        to: notice.to,
        tenantId: null,
        payload: { kind: 'platform.notice', ...refundRequestsAnnouncement(2, APP_BASE) },
      });
      // No company, amount or reason.
      const text = JSON.stringify(notice.payload);
      expect(text).not.toContain(c.tenant.slug);
      expect(text).not.toContain(REASON);
      expect(text).not.toContain('₹');
    }
    expect((await requestRow(r1.requestId)).announced_at).toBeInstanceOf(Date);
    expect((await requestRow(r2.requestId)).announced_at).toBeInstanceOf(Date);

    // Once, however often the sweep runs.
    expect(await announce()).toEqual({ announced: 0, unsent: 0, recipients: 0 });
    expect(await platformNotices(since)).toHaveLength(owners.length);

    // A request withdrawn before the sweep is not announced.
    await requests().withdraw(c.ctx, r1.requestId);
    const third = await paidTopup(c, 20_000);
    const r3 = await ask(c, third.topupId, '70');
    await requests().withdraw(c.ctx, r3.requestId);
    expect(await announce()).toEqual({ announced: 0, unsent: 0, recipients: 0 });
    expect((await requestRow(r3.requestId)).announced_at).toBeNull();

    // Two sweeps at once announce a request once.
    const r4 = await ask(c, third.topupId, '80');
    const since2 = await dbNow();
    const [x, y] = await Promise.all([announce(), announce()]);
    expect(x.announced + y.announced).toBe(1);
    expect((await platformNotices(since2)).map((n) => n.to).sort()).toEqual(owners);

    // With no platform owner, a request stays due until there is one.
    await requests().withdraw(c.ctx, r4.requestId);
    const r5 = await ask(c, first.topupId, '90');
    const demoted = await adminQuery<{ user_id: string }>(
      `UPDATE ops.platform_admins SET role = 'platform_operator' WHERE role = 'platform_owner'
       RETURNING user_id`,
    );
    try {
      expect(await announce()).toEqual({ announced: 0, unsent: 1, recipients: 0 });
    } finally {
      await adminQuery(
        `UPDATE ops.platform_admins SET role = 'platform_owner' WHERE user_id = ANY($1::text[])`,
        [demoted.map((r) => r.user_id)],
      );
    }
    expect((await requestRow(r5.requestId)).announced_at).toBeNull();
    const since3 = await dbNow();
    expect(await announce()).toEqual({ announced: 1, unsent: 0, recipients: owners.length });
    expect((await platformNotices(since3)).map((n) => n.payload)).toEqual(
      owners.map(() => ({ kind: 'platform.notice', ...refundRequestsAnnouncement(1, APP_BASE) })),
    );
  });

  it('tells the billing managers once when a request is declined, with the note', async () => {
    await tellDeclines();
    const c = await company();
    const billingUser = await member(c, 'billing', 'Billing Person');
    await member(c, 'agent', 'Agent Person');
    const { topupId } = await paidTopup(c, 20_000);
    const { requestId } = await ask(c, topupId, '100');
    // Approved and open requests are not this email's.
    const other = await paidTopup(c, 20_000);
    const { requestId: approved } = await ask(c, other.topupId, '10');
    await decide(owner, approved, 'approve');
    await decide(owner, requestId, 'decline', NOTE);

    expect(await tellDeclines()).toEqual({ notified: 1, failed: [] });
    const told = await billingEmails(c.tenantId, 'HyFib declined your refund request');
    expect(told.map((e) => e.to).sort()).toEqual([c.owner.email, billingUser.email].sort());
    for (const email of told) {
      expect(email).toMatchObject({
        lines: [
          'HyFib declined your request to refund ₹100.00 of unused service credit.',
          `HyFib's note: ${NOTE}`,
          'The credit stays in your wallet. You can ask again from the payment’s receipt.',
        ],
        url: `${APP_BASE}/c/${c.tenant.slug}/billing/receipts/${topupId}`,
      });
    }
    expect((await requestRow(requestId)).decline_notified_at).toBeInstanceOf(Date);
    expect(await tellDeclines()).toEqual({ notified: 0, failed: [] });
    expect(await billingEmails(c.tenantId, 'HyFib declined your refund request')).toHaveLength(2);

    // Two sweeps at once tell a decline once.
    const { requestId: again } = await ask(c, topupId, '50');
    await decide(owner, again, 'decline', NOTE);
    const [x, y] = await Promise.all([tellDeclines(), tellDeclines()]);
    expect(x.notified + y.notified).toBe(1);
    expect(x.failed.concat(y.failed)).toEqual([]);
    expect(await billingEmails(c.tenantId, 'HyFib declined your refund request')).toHaveLength(4);

    // The mark is taken in the company's own scope: another company's scope marks nothing.
    const { requestId: third } = await ask(c, topupId, '40');
    await decide(owner, third, 'decline', NOTE);
    const stranger = await company();
    const marked = await dbs.app.run(stranger.scope, (tx) =>
      tx.execute<{ marked: boolean }>(
        sql`select app.credit_refund_request_mark_decline_notified(${third}::uuid) as marked`,
      ),
    );
    expect(marked.rows[0]!.marked).toBe(false);
    expect((await requestRow(third)).decline_notified_at).toBeNull();
    expect(await tellDeclines()).toEqual({ notified: 1, failed: [] });

    // A note as long as a decline allows (1,000 characters) is told in full, over several lines:
    // a billing notice's line holds at most 500.
    const long = 'Refunds are for unused credit only; see the terms and ticket 4410. '
      .repeat(15)
      .slice(0, 1000)
      .trimEnd();
    expect(long.length).toBeGreaterThan(990);
    const { requestId: fourth } = await ask(c, topupId, '30');
    await decide(owner, fourth, 'decline', long);
    expect(await tellDeclines()).toEqual({ notified: 1, failed: [] });
    const all = await billingEmails(c.tenantId, 'HyFib declined your refund request');
    expect(all).toHaveLength(8);
    for (const email of all.slice(-2)) {
      expect(email.lines[0]).toBe(
        'HyFib declined your request to refund ₹30.00 of unused service credit.',
      );
      expect(email.lines.at(-1)).toBe(
        'The credit stays in your wallet. You can ask again from the payment’s receipt.',
      );
      const note = email.lines.slice(1, -1);
      expect(note.length).toBeGreaterThan(2);
      expect(note.every((line) => line.length <= 500)).toBe(true);
      expect(note.join(' ')).toBe(`HyFib's note: ${long}`);
    }
  });
});

describe('platform lists', () => {
  it('pages requests and refunds newest first on the exact time and id, also when times are equal', async () => {
    const c = await company();
    const { topupId } = await paidTopup(c, 20_000);
    // More than a page of withdrawn requests at one microsecond, later than anything else here.
    const ids: string[] = [];
    for (let i = 0; i < PLATFORM_REFUNDS_PAGE + 3; i += 1) ids.push(uuidv7());
    await adminQuery(
      `INSERT INTO app.credit_refund_requests (id, tenant_id, topup_id, amount_minor, reason, status,
         requested_by_user_id, requested_at, withdrawn_at)
       SELECT id, $2, $3, 100, $4, 'withdrawn', $5, '2100-01-01 00:00:00.123456+00',
              '2100-01-01 00:00:01+00'
         FROM unnest($1::uuid[]) AS id`,
      [ids, c.tenantId, topupId, REASON, c.owner.id],
    );
    const first = await staff().refundRequests(operator, { status: 'all' });
    expect(first.items).toHaveLength(PLATFORM_REFUNDS_PAGE);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await staff().refundRequests(operator, {
      status: 'all',
      cursor: first.nextCursor!,
    });
    const seen = [...first.items, ...second.items]
      .filter((r) => r.tenantId === c.tenantId)
      .map((r) => r.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([...ids].sort().reverse());
    expect(
      (await staff().refundRequests(operator, { status: 'open' })).items.some(
        (r) => r.tenantId === c.tenantId,
      ),
    ).toBe(false);
    expect(await refused(staff().refundRequests(operator, { cursor: 'bm90LWEtY3Vyc29y' }))).toBe(
      'validation_failed',
    );
    expect(await refused(staff().refundRequests(operator, { status: 'withdrawn' }))).toBe(
      'validation_failed',
    );

    // Refunds: two at one microsecond, read one at a time through the function.
    const a = await staff().requestRefund(owner, {
      tenantId: c.tenantId,
      topupId,
      amount: '1',
      reason: 'Duplicate payment, ticket 1203',
    });
    const other = await paidTopup(c, 10_000);
    const b = await staff().requestRefund(owner, {
      tenantId: c.tenantId,
      topupId: other.topupId,
      amount: '1',
      reason: 'Duplicate payment, ticket 1204',
    });
    await adminQuery(
      `UPDATE app.credit_refunds SET requested_at = '2100-01-01 00:00:00.654321+00'
        WHERE id = ANY($1::uuid[])`,
      [[a.refundId, b.refundId]],
    );
    const pageOne = await dbs.platform.run(operator.userId, (tx) =>
      tx.execute<{ id: string; cursor_at: string }>(
        sql`select id, cursor_at from ops.platform_credit_refunds(null, null, 1)`,
      ),
    );
    const top = pageOne.rows[0]!;
    expect(top.cursor_at).toBe('2100-01-01T00:00:00.654321Z');
    const pageTwo = await dbs.platform.run(operator.userId, (tx) =>
      tx.execute<{ id: string }>(
        sql`select id from ops.platform_credit_refunds(${top.cursor_at}::timestamptz,
              ${top.id}::uuid, 1)`,
      ),
    );
    expect([top.id, pageTwo.rows[0]!.id]).toEqual([a.refundId, b.refundId].sort().reverse());
    const listed = await staff().creditRefunds(operator);
    expect(listed.items.slice(0, 2).map((r) => r.id)).toEqual(
      [a.refundId, b.refundId].sort().reverse(),
    );
    expect(listed.items[0]!.requestId).toBeNull();
  });
});
