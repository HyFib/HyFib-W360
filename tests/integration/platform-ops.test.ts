import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { PgBoss } from 'pg-boss';
import { isAppError, uuidv7 } from '@w360/core';
import { sql } from '@w360/db';
import {
  createPlatformOpsService,
  deadLetterJob,
  pgBossQueueInspector,
  purgeDeadLetters,
  recordDeadLetters,
  type PlatformActor,
} from '@w360/domain';
import { createUser } from './helpers';
import {
  nextExternalId,
  startWhatsAppFixture,
  type Company,
  type WhatsAppFixture,
} from './whatsapp-fixture';

/**
 * The platform operations console (P5-10, ADR-054): content-free facts through definer functions
 * that only platform administrators can run, dead letters the worker may only insert, and the two
 * audited repairs.
 */
let fx: WhatsAppFixture;
let company: Company;
let staff: PlatformActor;

const SECRET_TOKEN = 'tok_do_not_show_me';
const MESSAGE_TEXT = 'Is my parcel out yet?';

const ops = () =>
  createPlatformOpsService({
    platformDb: fx.dbs.platform,
    queues: pgBossQueueInspector(fx.boss),
    clock: { now: () => new Date() },
  });

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    if (isAppError(error)) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function platformStaff(): Promise<PlatformActor> {
  const user = await createUser(fx.dbs, { twoFactor: true });
  await fx.dbs.ownerPool.query(
    `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_operator')`,
    [user.id],
  );
  return { userId: user.id, role: 'platform_operator', correlationId: uuidv7() };
}

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  staff = await platformStaff();
  company = await fx.company();
  const t = company.tenant.id;
  // A failing webhook endpoint whose URL carries a token: only its host may leave the database.
  await fx.query(
    `INSERT INTO app.webhook_endpoints (id, tenant_id, url, event_types, secret_ciphertext,
       created_by_user_id, failing_since, last_failure_at)
     VALUES ($1, $2, $3, ARRAY['message.received'], 'sealed', $4, now() - interval '2 hours', now())`,
    [uuidv7(), t, `https://Hooks.Example.com/w360?token=${SECRET_TOKEN}`, company.owner.id],
  );
  // An inbound message (captured for the endpoint) and a conversation to hang outbound ones on.
  await fx.deliver(
    fx.messagesBody(company, { messages: [{ waId: '919876500001', text: MESSAGE_TEXT }] }),
  );
  const [conversation] = await fx.query<{ id: string; contact_id: string }>(
    `SELECT id, contact_id FROM app.conversations WHERE tenant_id = $1`,
    [t],
  );
  const templateId = uuidv7();
  await fx.query(
    `INSERT INTO app.message_templates (id, tenant_id, whatsapp_account_id, name, language, category,
       components, status)
     VALUES ($1, $2, $3, 'spring_sale', 'en', 'MARKETING', '[]'::jsonb, 'approved')`,
    [templateId, t, company.whatsappAccountId],
  );
  const outbound = (sender: string, status: string, code: string | null, template: string | null) =>
    fx.query(
      `INSERT INTO app.messages (id, tenant_id, conversation_id, channel_account_id, direction, type,
         status, sender_type, error_code, template_id)
       VALUES ($1, $2, $3, $4, 'outbound', $5, $6, $7, $8, $9)`,
      [
        uuidv7(),
        t,
        conversation!.id,
        company.channelAccountId,
        template ? 'template' : 'text',
        status,
        sender,
        code,
        template,
      ],
    );
  await outbound('agent', 'delivered', null, null);
  await outbound('campaign', 'delivered', null, templateId);
  await outbound('campaign', 'read', null, templateId);
  await outbound('campaign', 'failed', '131050', templateId);
  await outbound('api', 'failed', '131049', templateId);
  // Opt-outs from marketing: by keyword (counted) and by import (not the contact's own act).
  for (const source of ['keyword', 'import']) {
    await fx.query(
      `INSERT INTO app.consent_events (id, tenant_id, contact_id, purpose, action, source, actor_type,
         occurred_at)
       VALUES ($1, $2, $3, 'marketing', 'opt_out', $4, 'contact', now())`,
      [uuidv7(), t, conversation!.contact_id, source],
    );
  }
  await fx.query(
    `INSERT INTO app.suppressions (id, tenant_id, phone_e164, reason) VALUES ($1, $2, '+919876500002', 'complaint')`,
    [uuidv7(), t],
  );
  // The number was rated YELLOW at its last check; a second number needs reconnecting.
  await fx.query(
    `UPDATE app.channel_accounts SET quality_rating = 'YELLOW', health_checked_at = now() WHERE id = $1`,
    [company.channelAccountId],
  );
  await fx.query(
    `INSERT INTO app.channel_accounts (id, tenant_id, whatsapp_account_id, phone_number_id,
       display_phone_number, status, onboarding_error)
     VALUES ($1, $2, $3, $4, '+91 90000 11111', 'needs_reconnect', 'Meta rejected the stored token.')`,
    [uuidv7(), t, company.whatsappAccountId, String(Date.now()).slice(-12)],
  );
  // Embedded Signup: one failed, one abandoned (expired while started), one completed.
  const session = (status: string, reason: string | null, expires: string) =>
    fx.query(
      `INSERT INTO app.channel_onboarding_sessions (id, tenant_id, state_hash, created_by_user_id,
         auth_session_id, status, failure_reason, expires_at)
       VALUES ($1, $2, $3, $4, 'sess_x', $5, $6, now() + $7::interval)`,
      [uuidv7(), t, randomBytes(32).toString('hex'), company.owner.id, status, reason, expires],
    );
  await session('failed', 'Meta did not return a WhatsApp Business Account.', '1 hour');
  await session('started', null, '-5 minutes');
  await session('completed', null, '-5 minutes');
});

afterAll(async () => {
  await fx?.close();
});

describe('who can read the operations facts', () => {
  it('refuses a platform user who is not an administrator, and the runtime role entirely', async () => {
    const outsider = await createUser(fx.dbs, { twoFactor: true });
    const service = ops();
    const actor: PlatformActor = {
      userId: outsider.id,
      role: 'platform_operator',
      correlationId: uuidv7(),
    };
    await expectCode(service.overview(actor), 'forbidden');
    await expectCode(service.signals(actor), 'forbidden');
    await expectCode(service.onboarding(actor), 'forbidden');
    // Each function refuses on its own, not only the first one a page happens to call.
    for (const query of [
      sql`select * from ops.platform_ops_health(null)`,
      sql`select * from ops.platform_ops_activity(now() - interval '1 day', null)`,
      sql`select * from ops.platform_ops_signup_sessions(now() - interval '1 day', 10)`,
      sql`select * from ops.platform_ops_integration_failures(10)`,
      sql`select ops.platform_retry_webhook_receipt(${uuidv7()}::uuid, 'Retrying after the outage', 'c')`,
    ]) {
      await expectCode(
        fx.dbs.platform.run(outsider.id, (tx) => tx.execute(query)),
        'forbidden',
      );
    }
    for (const fn of [
      `ops.platform_ops_health(null)`,
      `ops.platform_ops_activity(now() - interval '1 day', null)`,
      `ops.platform_ops_integration_failures(10)`,
    ]) {
      await expect(fx.dbs.appPool.query(`SELECT * FROM ${fn}`)).rejects.toThrow(
        /permission denied/,
      );
    }
    await expect(fx.dbs.appPool.query(`SELECT count(*) FROM ops.dead_letters`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('reads activity only for a window that has started and is at most 93 days long', async () => {
    const activity = (since: string) =>
      fx.dbs.platform.run(staff.userId, (tx) =>
        tx.execute(sql`select * from ops.platform_ops_activity(${since}::timestamptz, null)`),
      );
    const day = 24 * 60 * 60 * 1000;
    await activity(new Date(Date.now() - 92 * day).toISOString());
    await expectCode(
      activity(new Date(Date.now() - 94 * day).toISOString()),
      'precondition_failed',
    );
    await expectCode(activity(new Date(Date.now() + day).toISOString()), 'precondition_failed');
  });
});

describe('company health and signals', () => {
  it("counts a company's numbers, sending, endpoints and quality without its content", async () => {
    const result = await ops().companyHealth(staff, company.tenant.id);
    expect(result).not.toBeNull();
    const facts = result!.health.facts;
    expect(facts).toMatchObject({
      numbersTotal: 2,
      numbersActive: 1,
      numbersReconnect: 1,
      qualityRating: 'YELLOW',
      outbound24h: 5,
      failed24h: 2,
      inbound24h: 1,
      endpointsFailing: 1,
    });
    expect(result!.health.issues.map((i) => i.key).sort()).toEqual([
      'number_attention',
      'quality_yellow',
      'webhook_endpoints',
    ]);
    expect(result!.activity).toMatchObject({
      outbound: 5,
      outboundBySender: { agent: 1, bot: 0, campaign: 3, api: 1, system: 0 },
      failed: 2,
      inbound: 1,
      marketingSent: 4,
      marketingDelivered: 2,
      error131049: 1,
      error131050: 1,
      marketingOptOuts: 1,
      complaints: 1,
      webhookDeliveries: 1,
    });
    expect(JSON.stringify(result)).not.toContain(MESSAGE_TEXT);
    expect(await ops().companyHealth(staff, uuidv7())).toBeNull();
    expect(await ops().companyHealth(staff, 'not-a-uuid')).toBeNull();
  });

  it('lists the company among those needing attention and flags its low quality', async () => {
    const overview = await ops().overview(staff);
    const entry = overview.attention.find((c) => c.facts.tenantId === company.tenant.id);
    expect(entry?.level).toBe('warning');
    const signals = await ops().signals(staff);
    const row = signals.rows.find((r) => r.activity.tenantId === company.tenant.id);
    expect(row?.flags.map((f) => f.key)).toEqual(['quality']);
    const usage = await ops().usage(staff, 30);
    expect(usage.rows.find((r) => r.tenantId === company.tenant.id)?.outbound).toBe(5);
    expect(usage.totals.outbound).toBeGreaterThanOrEqual(5);
    expect((await ops().usage(staff, 12345)).days).toBe(30);
    expect(JSON.stringify([overview, signals, usage])).not.toContain(MESSAGE_TEXT);
  });
});

describe('onboarding and integration failures', () => {
  it('shows failed and abandoned signups but not completed ones', async () => {
    const onboarding = await ops().onboarding(staff);
    const mine = onboarding.sessions.filter((s) => s.tenantId === company.tenant.id);
    expect(mine.map((s) => s.outcome).sort()).toEqual(['abandoned', 'failed']);
    expect(mine.find((s) => s.outcome === 'failed')?.failureReason).toBe(
      'Meta did not return a WhatsApp Business Account.',
    );
    expect(mine.every((s) => s.hasActiveNumber)).toBe(true);
  });

  it('labels a failing endpoint by its host only and names the number to reconnect', async () => {
    const { failures } = await ops().integrations(staff);
    const mine = failures.filter((f) => f.tenantId === company.tenant.id);
    expect(mine.find((f) => f.source === 'webhook_endpoint')).toMatchObject({
      label: 'hooks.example.com',
      state: 'failing',
    });
    expect(mine.find((f) => f.source === 'whatsapp_number')).toMatchObject({
      label: '+91 90000 11111',
      state: 'needs_reconnect',
      error: 'Meta rejected the stored token.',
    });
    expect(JSON.stringify(failures)).not.toContain(SECRET_TOKEN);
  });
});

describe('webhook receipt repairs', () => {
  async function receipt(status: string, attempts: number, body: string | null, age = '1 hour') {
    const id = uuidv7();
    await fx.query(
      `INSERT INTO ops.webhook_receipts (id, provider, received_at, body_sha256, body_ciphertext,
         body_size, status, attempts, last_error)
       VALUES ($1, 'meta_whatsapp', now() - $6::interval, $2, $3, 10, $4, $5, 'boom')`,
      [id, randomBytes(32).toString('hex'), body, status, attempts, age],
    );
    return id;
  }

  it('sends an exhausted receipt back to processing and audits it', async () => {
    const id = await receipt('failed', 12, 'sealed-body');
    const listed = (await ops().integrations(staff)).receipts.find((r) => r.id === id);
    expect(listed).toMatchObject({ problem: 'exhausted', retryable: true });
    await expectCode(
      ops().retryReceipt(staff, { receiptId: id, reason: 'short' }),
      'validation_failed',
    );
    const result = await ops().retryReceipt(staff, {
      receiptId: id,
      reason: 'Fixed the parser bug in 1.4.2',
    });
    expect(result.previousStatus).toBe('failed');
    const [row] = await fx.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM ops.webhook_receipts WHERE id = $1`,
      [id],
    );
    expect(row).toEqual({ status: 'pending', attempts: 0 });
    const audit = await fx.query<{ actor_user_id: string; reason: string; metadata: unknown }>(
      `SELECT actor_user_id, reason, metadata FROM ops.platform_audit_events
        WHERE action = 'platform.webhook_receipt_retried' AND metadata->>'receiptId' = $1`,
      [id],
    );
    expect(audit).toEqual([
      {
        actor_user_id: staff.userId,
        reason: 'Fixed the parser bug in 1.4.2',
        metadata: {
          receiptId: id,
          provider: 'meta_whatsapp',
          previousStatus: 'failed',
          attempts: 12,
        },
      },
    ]);
  });

  it('refuses a processed receipt, an erased body, an unknown receipt and a non-administrator', async () => {
    const reason = 'Retrying after the outage';
    // Bodies are erased after 7 days: an older receipt is listed without a retry.
    const old = await receipt('failed', 12, null, '8 days');
    expect((await ops().integrations(staff)).receipts.find((r) => r.id === old)).toMatchObject({
      problem: 'exhausted',
      retryable: false,
    });
    await expectCode(
      ops().retryReceipt(staff, { receiptId: await receipt('processed', 1, 'sealed'), reason }),
      'precondition_failed',
    );
    await expectCode(
      ops().retryReceipt(staff, { receiptId: await receipt('failed', 12, null), reason }),
      'precondition_failed',
    );
    await expectCode(ops().retryReceipt(staff, { receiptId: uuidv7(), reason }), 'not_found');
    const outsider = await createUser(fx.dbs, { twoFactor: true });
    await expectCode(
      ops().retryReceipt(
        { userId: outsider.id, role: 'platform_operator', correlationId: uuidv7() },
        { receiptId: await receipt('failed', 12, 'sealed'), reason },
      ),
      'forbidden',
    );
  });

  it('quarantines an event from an unknown account; staff resolve it once, audited', async () => {
    const stranger = { ...company, wabaId: nextExternalId(), phoneNumberId: nextExternalId() };
    const { receiptId } = await fx.deliver(
      fx.messagesBody(stranger, { messages: [{ waId: '919876500003', text: MESSAGE_TEXT }] }),
    );
    const { quarantine } = await ops().integrations(staff);
    const entry = quarantine.find((q) => q.receiptId === receiptId);
    expect(entry).toMatchObject({ reason: 'unknown_asset', retryable: true });
    expect(entry?.externalIds).toEqual(
      expect.arrayContaining([{ key: 'waba', value: stranger.wabaId }]),
    );
    expect(JSON.stringify(quarantine)).not.toContain(MESSAGE_TEXT);
    await ops().resolveQuarantine(staff, {
      quarantineId: entry!.id,
      resolution: 'Not ours: a Meta test account, confirmed with Meta support.',
    });
    await expectCode(
      ops().resolveQuarantine(staff, {
        quarantineId: entry!.id,
        resolution: 'Resolved twice here',
      }),
      'not_found',
    );
    const audit = await fx.query<{ reason: string }>(
      `SELECT reason FROM ops.platform_audit_events
        WHERE action = 'platform.webhook_quarantine_resolved' AND metadata->>'quarantineId' = $1`,
      [entry!.id],
    );
    expect(audit).toEqual([
      { reason: 'Not ours: a Meta test account, confirmed with Meta support.' },
    ]);
  });
});

describe('dead letters and queues', () => {
  it('records a job pg-boss dead-lettered, attributing it only through its verified signature', async () => {
    // A queue of this test's own, created with the migration role like every queue.
    const owner = new PgBoss({
      connectionString: inject('dbUrls').owner,
      schema: 'pgboss',
      migrate: false,
      createSchema: false,
      supervise: false,
      schedule: false,
      max: 1,
    });
    owner.on('error', () => undefined);
    await owner.start();
    const queue = `it.ops-dlq-${randomBytes(3).toString('hex')}`;
    await owner.createQueue(queue, { retryLimit: 0, deadLetter: 'dead-letter' });
    await owner.stop({ graceful: false, close: true });

    const envelope = fx.signer.sign({
      kind: 'commerce.store',
      tenantId: company.tenant.id,
      actorUserId: null,
      ref: 'store-ref-1',
    });
    const jobId = await fx.boss.send(queue, envelope);
    const [fetched] = await fx.boss.fetch(queue);
    expect(fetched?.id).toBe(jobId);
    // What a handler's thrown error looks like once pg-boss has serialised it.
    await fx.boss.fail(queue, jobId!, {
      name: 'AppError',
      code: 'provider_rejected',
      message: `Refused for ${MESSAGE_TEXT}`,
    });
    const letters = (
      await fx.boss.fetch('dead-letter', { batchSize: 20, includeMetadata: true })
    ).filter((job) => job.sourceName === queue);
    expect(letters).toHaveLength(1);
    const recorded = await recordDeadLetters(
      { db: fx.dbs.app, signer: fx.signer },
      letters.map(deadLetterJob),
    );
    expect(recorded).toBe(1);
    // Recording the same batch again (a retried recording) adds nothing.
    expect(
      await recordDeadLetters({ db: fx.dbs.app, signer: fx.signer }, letters.map(deadLetterJob)),
    ).toBe(0);
    await fx.boss.complete(
      'dead-letter',
      letters.map((job) => job.id),
    );

    const { queues, deadLetters } = await ops().queues(staff);
    const mine = deadLetters.filter((d) => d.sourceQueue === queue);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      sourceJobId: jobId,
      kind: 'commerce.store',
      tenantId: company.tenant.id,
      tenantName: `Company ${company.tenant.slug}`,
      ref: 'store-ref-1',
      verified: true,
      retries: 0,
      errorName: 'AppError',
      errorCode: 'provider_rejected',
    });
    expect(JSON.stringify(deadLetters)).not.toContain(MESSAGE_TEXT);
    // A queue this release does not declare still shows, with its dead letters and no policy.
    expect(queues.find((q) => q.name === queue)).toMatchObject({
      policy: null,
      deadLetters: { last24h: 1, last7d: 1 },
    });
    const store = queues.find((q) => q.name === 'commerce.store');
    expect(store?.policy).toEqual({ retryLimit: 5, hasDeadLetter: true });
    expect(typeof store?.counts?.ready).toBe('number');
    const health = await ops().companyHealth(staff, company.tenant.id);
    expect(health?.health.facts.deadLetters7d).toBe(1);
  });

  it('purges dead letters 30 days after their job failed, and only those', async () => {
    const old = uuidv7();
    const recent = uuidv7();
    for (const [id, age] of [
      [old, '31 days'],
      [recent, '29 days'],
    ] as const) {
      await fx.query(
        `INSERT INTO ops.dead_letters (id, source_queue, verified, failed_at)
         VALUES ($1, 'it.purge', false, now() - $2::interval)`,
        [id, age],
      );
    }
    expect(await purgeDeadLetters(fx.dbs.app)).toBeGreaterThanOrEqual(1);
    const left = await fx.query<{ id: string }>(
      `SELECT id FROM ops.dead_letters WHERE source_queue = 'it.purge'`,
    );
    expect(left.map((r) => r.id)).toEqual([recent]);
  });
});
