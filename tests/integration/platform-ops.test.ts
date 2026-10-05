import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inject } from 'vitest';
import { PgBoss } from 'pg-boss';
import { ALL_QUEUES, queueMaxWaitMinutes } from '@w360/contracts';
import { isAppError, uuidv7 } from '@w360/core';
import { sql, systemScope } from '@w360/db';
import {
  alertFailures,
  alertIntegrationFailures,
  alertLateQueues,
  checkQueueWaits,
  createPlatformOpsService,
  deadLetterJob,
  outboxAad,
  pgBossQueueInspector,
  purgeDeadLetters,
  queueWaitLimits,
  recordDeadLetters,
  deadLettersCsv,
  emailsCsv,
  failuresCsv,
  newCompaniesCsv,
  numberSetupsCsv,
  quarantineCsv,
  queuesCsv,
  receiptsCsv,
  signupsCsv,
  DEAD_LETTERS_CSV_COLUMNS,
  EMAILS_CSV_COLUMNS,
  FAILURES_CSV_COLUMNS,
  HEALTH_CSV_COLUMNS,
  NEW_COMPANIES_CSV_COLUMNS,
  NUMBER_SETUPS_CSV_COLUMNS,
  QUARANTINE_CSV_COLUMNS,
  QUEUES_CSV_COLUMNS,
  RECEIPTS_CSV_COLUMNS,
  SIGNALS_CSV_COLUMNS,
  SIGNUPS_CSV_COLUMNS,
  USAGE_CSV_COLUMNS,
  type OpsExportList,
  type PlatformActor,
} from '@w360/domain';
import { createTenant, createUser } from './helpers';
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
    keyring: fx.keyring,
    jobSigning: fx.signer,
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

  it("gives each company's latest API request count on the Usage tab, as its automation runs (ADR-153)", async () => {
    const quiet = await fx.company();
    const august = new Date('2026-08-01T00:00:00.000Z');
    const september = new Date('2026-09-01T00:00:00.000Z');
    const counter = (tenantId: string, metric: string, periodStart: Date, used: number) =>
      fx.query(
        `INSERT INTO app.usage_counters (id, tenant_id, metric, period_start, used)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), tenantId, metric, periodStart, used],
      );
    await counter(company.tenant.id, 'api_requests', august, 900);
    await counter(company.tenant.id, 'api_requests', september, 42);
    await counter(company.tenant.id, 'automation_runs', september, 7);
    // Another company's requests are its own.
    await counter(quiet.tenant.id, 'automation_runs', september, 3);
    const rows = (await ops().usage(staff, 30)).rows;
    const line = (tenantId: string) => {
      const r = rows.find((row) => row.tenantId === tenantId);
      return r && [r.apiRequests, r.apiPeriodStart?.toISOString() ?? null, r.automationRuns];
    };
    expect(line(company.tenant.id)).toEqual([42, september.toISOString(), 7]);
    expect(line(quiet.tenant.id)).toEqual([0, null, 3]);
  });

  it('compares each company with the window before, in one snapshot, for 7 and 30 days only (ADR-157)', async () => {
    const trend = await fx.company();
    await fx.deliver(
      fx.messagesBody(trend, { messages: [{ waId: '919876500009', text: 'Hello again' }] }),
    );
    const [conversation] = await fx.query<{ id: string }>(
      `SELECT id FROM app.conversations WHERE tenant_id = $1`,
      [trend.tenant.id],
    );
    // Three replies 10 days ago (in the 7 days before the last 7) and two now.
    for (const age of ['10 days', '10 days', '10 days', '0 days', '0 days']) {
      await fx.query(
        `INSERT INTO app.messages (id, tenant_id, conversation_id, channel_account_id, direction,
           type, status, sender_type, created_at)
         VALUES ($1, $2, $3, $4, 'outbound', 'text', 'delivered', 'agent', now() - $5::interval)`,
        [uuidv7(), trend.tenant.id, conversation!.id, trend.channelAccountId, age],
      );
    }
    const line = async (days: number) => {
      const usage = await ops().usage(staff, days);
      const r = usage.rows.find((row) => row.tenantId === trend.tenant.id);
      return { usage, r: r && [r.outbound, r.inbound, r.previous] };
    };
    const week = await line(7);
    expect(week.r).toEqual([2, 1, { outbound: 3, inbound: 0 }]);
    expect(week.usage.previous?.outbound).toBeGreaterThanOrEqual(3);
    // Over 30 days the replies of 10 days ago are in the window, and nothing came before.
    const month = await line(30);
    expect(month.r).toEqual([5, 1, { outbound: 0, inbound: 0 }]);
    const quarter = await line(90);
    expect(quarter.r).toEqual([5, 1, null]);
    expect(quarter.usage.previous).toBeNull();
    // The CSV's last two columns are the window before, empty for 90 days (exported by another
    // administrator, so the ADR-154 test's audit entries stay its own).
    const exporter = await platformStaff();
    const csvLine = async (days: number) =>
      (await ops().exportList(exporter, 'usage', days)).body
        .split('\r\n')
        .find((l) => l.includes(`,${trend.tenant.slug},`));
    expect(await csvLine(7)).toMatch(/,3,0$/);
    expect(await csvLine(90)).toMatch(/,,$/);
  });

  it('exports the Usage tab as CSV only after writing the export to the platform audit log (ADR-154)', async () => {
    const file = await ops().exportList(staff, 'usage', 7);
    expect(file.filename).toMatch(/^hyfib-usage-7-days-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = file.body.replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe(USAGE_CSV_COLUMNS.join(','));
    expect(lines.at(-1)).toBe('');
    const companies = lines.slice(1, -1);
    expect(companies.filter((l) => l.includes(`,${company.tenant.slug},`))).toHaveLength(1);
    expect(file.body).not.toContain(MESSAGE_TEXT);
    const audits = await fx.query<{ metadata: { days: number; companies: number } }>(
      `SELECT metadata FROM ops.platform_audit_events
        WHERE action = 'platform.ops_usage_exported' AND actor_user_id = $1`,
      [staff.userId],
    );
    expect(audits.map((a) => a.metadata)).toEqual([{ days: 7, companies: companies.length }]);
    // Someone who is not a platform administrator gets neither a file nor an entry.
    const outsider = await createUser(fx.dbs, { twoFactor: true });
    const actor: PlatformActor = {
      userId: outsider.id,
      role: 'platform_operator',
      correlationId: uuidv7(),
    };
    await expectCode(ops().exportList(actor, 'usage', 7), 'forbidden');
    const [refused] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ops.platform_audit_events WHERE actor_user_id = $1`,
      [outsider.id],
    );
    expect(refused?.n).toBe(0);
  });

  it("exports every company's health and the Signals tab, each with its audit entry (ADR-155)", async () => {
    const csvLines = (body: string) => body.replace(/^\uFEFF/, '').split('\r\n');
    const slug = company.tenant.slug;
    const health = await ops().exportList(staff, 'health', 30);
    expect(health.filename).toMatch(/^hyfib-health-\d{4}-\d{2}-\d{2}\.csv$/);
    const healthLines = csvLines(health.body);
    expect(healthLines[0]).toBe(HEALTH_CSV_COLUMNS.join(','));
    expect(healthLines.at(-1)).toBe('');
    // The company's facts as the console shows them: a warning, its issues in words, its numbers,
    // the YELLOW rating, the last day's sending and the failing endpoint.
    expect(healthLines.filter((l) => l.includes(`,${slug},`))).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Company ${slug},${slug},active,[a-z_]*,\\d{4}-\\d{2}-\\d{2},warning,` +
            '1 number to reconnect or set up again; A number is rated YELLOW; ' +
            '1 webhook endpoint failing or turned off for failing,2,1,1,0,YELLOW,' +
            '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2},0,5,2,1,\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2},1,0,0,0,0,0,0$',
        ),
      ),
    ]);
    const signals = await ops().exportList(staff, 'signals', 30);
    expect(signals.filename).toMatch(/^hyfib-signals-7-days-\d{4}-\d{2}-\d{2}\.csv$/);
    const signalLines = csvLines(signals.body);
    expect(signalLines[0]).toBe(SIGNALS_CSV_COLUMNS.join(','));
    expect(signalLines.filter((l) => l.includes(`,${slug},`))).toEqual([
      `Company ${slug},${slug},active,5,2,2,1,1,1,1,YELLOW,A number is rated YELLOW`,
    ]);
    expect(health.body + signals.body).not.toContain(MESSAGE_TEXT);
    expect(health.body + signals.body).not.toContain(SECRET_TOKEN);
    const audits = await fx.query<{ action: string; metadata: Record<string, number> }>(
      `SELECT action, metadata FROM ops.platform_audit_events
        WHERE action IN ('platform.ops_health_exported', 'platform.ops_signals_exported')
          AND actor_user_id = $1
        ORDER BY occurred_at, id`,
      [staff.userId],
    );
    expect(audits).toEqual([
      { action: 'platform.ops_health_exported', metadata: { companies: healthLines.length - 2 } },
      {
        action: 'platform.ops_signals_exported',
        metadata: { days: 7, companies: signalLines.length - 2 },
      },
    ]);
    // Someone who is not a platform administrator gets neither a file nor an entry.
    const outsider = await createUser(fx.dbs, { twoFactor: true });
    const actor: PlatformActor = {
      userId: outsider.id,
      role: 'platform_operator',
      correlationId: uuidv7(),
    };
    await expectCode(ops().exportList(actor, 'health', 30), 'forbidden');
    await expectCode(ops().exportList(actor, 'signals', 30), 'forbidden');
    const [refused] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ops.platform_audit_events WHERE actor_user_id = $1`,
      [outsider.id],
    );
    expect(refused?.n).toBe(0);
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
    expect(store?.policy).toEqual({ retryLimit: 5, hasDeadLetter: true, maxWaitMinutes: 60 });
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

describe('alerts for work that failed for good (ADR-091)', () => {
  const alert = () =>
    alertFailures({
      db: fx.dbs.app,
      outbox: { keyring: fx.keyring, jobs: fx.jobs(), signer: fx.signer },
      appBaseUrl: 'https://app.w360.test',
    });
  /** The next alert is allowed now, as if the last one went out over 15 minutes ago. */
  const allowNextAlert = () =>
    fx.query(`UPDATE ops.platform_alerts SET last_sent_at = now() - interval '16 minutes'`);
  async function staffOf(role: 'platform_owner' | 'platform_operator') {
    const user = await createUser(fx.dbs, { twoFactor: true });
    await fx.dbs.ownerPool.query(
      `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, $2)`,
      [user.id, role],
    );
    return user;
  }
  async function alertsTo(email: string) {
    const rows = await fx.query<{
      id: string;
      tenant_id: string | null;
      payload_ciphertext: string;
    }>(
      `SELECT id, tenant_id, payload_ciphertext FROM ops.email_outbox
        WHERE to_address = $1 AND kind = 'platform.notice' ORDER BY created_at, id`,
      [email],
    );
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      payload: JSON.parse(fx.keyring.decryptString(r.payload_ciphertext, outboxAad(r.id))) as {
        subject: string;
        lines: string[];
        url: string;
      },
    }));
  }
  async function deadLetter(queue: string, extra: { tenantId?: string; ref?: string } = {}) {
    const id = uuidv7();
    await fx.query(
      `INSERT INTO ops.dead_letters (id, source_queue, kind, tenant_id, ref, verified, error_code,
         failed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'provider_rejected', now())`,
      [
        id,
        queue,
        extra.tenantId ? 'commerce.store' : null,
        extra.tenantId ?? null,
        extra.ref ?? null,
        Boolean(extra.tenantId),
      ],
    );
    return id;
  }
  async function receipt(status: string, attempts: number, lease: string | null) {
    const id = uuidv7();
    await fx.query(
      `INSERT INTO ops.webhook_receipts (id, provider, body_sha256, body_ciphertext, body_size,
         status, attempts, lease_until, last_error)
       VALUES ($1, 'meta_whatsapp', $2, 'sealed-body', 10, $3, $4, now() + $5::interval, $6)`,
      [id, randomBytes(32).toString('hex'), status, attempts, lease, `boom ${SECRET_TOKEN}`],
    );
    return id;
  }
  const marks = async (table: string, column: string, ids: string[]) =>
    (
      await fx.query<{ id: string; at: Date | null }>(
        `SELECT id, ${column} AS at FROM ${table} WHERE id = ANY($1::uuid[])`,
        [ids],
      )
    ).reduce<Record<string, boolean>>((all, r) => ({ ...all, [r.id]: r.at !== null }), {});

  it('emails every platform administrator once about each item, with counts only', async () => {
    const owner = await staffOf('platform_owner');
    const operator = await staffOf('platform_operator');
    const queueA = `it.alert-a-${randomBytes(3).toString('hex')}`;
    const queueB = `it.alert-b-${randomBytes(3).toString('hex')}`;
    const letters = [
      await deadLetter(queueA, { tenantId: company.tenant.id, ref: 'store-ref-secret' }),
      await deadLetter(queueA),
      await deadLetter(queueB),
    ];
    // Used up: failed its 12th attempt; its worker stopped during the 12th and the lease ran out.
    const failed = await receipt('failed', 12, null);
    const stuck = await receipt('processing', 12, '-5 minutes');
    // Not used up: still processing its 12th attempt; failed an earlier one, to be retried.
    const working = await receipt('processing', 12, '5 minutes');
    const retrying = await receipt('failed', 5, null);
    const quarantineId = uuidv7();
    await fx.query(
      `INSERT INTO ops.webhook_quarantine (id, receipt_id, provider, reason, external_ids)
       VALUES ($1, $2, 'meta_whatsapp', 'asset_mismatch', '{"waba": "1234"}'::jsonb)`,
      [quarantineId, failed],
    );
    // Resolved before any alert: nothing to act on, so nobody is told.
    const resolvedId = uuidv7();
    await fx.query(
      `INSERT INTO ops.webhook_quarantine (id, receipt_id, provider, reason, external_ids, resolved_at,
         resolution)
       VALUES ($1, $2, 'meta_whatsapp', 'malformed', '{"waba": "5678"}'::jsonb, now(),
         'A Meta test event, nothing to do.')`,
      [resolvedId, retrying],
    );
    await allowNextAlert();
    const sent = await alert();
    // Items other test files left count too: at least these six.
    expect(sent.alerted).toBeGreaterThanOrEqual(6);
    expect(sent.recipients).toBeGreaterThanOrEqual(2);
    expect(await marks('ops.dead_letters', 'alerted_at', letters)).toEqual(
      Object.fromEntries(letters.map((id) => [id, true])),
    );
    expect(
      await marks('ops.webhook_receipts', 'exhausted_alerted_at', [
        failed,
        stuck,
        working,
        retrying,
      ]),
    ).toEqual({ [failed]: true, [stuck]: true, [working]: false, [retrying]: false });
    expect(await marks('ops.webhook_quarantine', 'alerted_at', [quarantineId, resolvedId])).toEqual(
      { [quarantineId]: true, [resolvedId]: false },
    );
    // The console shows when staff were emailed: the last alert, and each item it told.
    const [sentAt] = await fx.query<{ at: Date }>(
      `SELECT last_sent_at AS at FROM ops.platform_alerts WHERE kind = 'failures'`,
    );
    const listing = await ops().integrations(staff);
    expect(listing.lastFailureAlertAt).toEqual(sentAt!.at);
    expect(listing.quarantine.find((q) => q.id === quarantineId)?.alertedAt).toBeInstanceOf(Date);
    const { deadLetters: listedLetters } = await ops().queues(staff);
    expect(
      listedLetters.filter((d) => letters.includes(d.id)).map((d) => d.alertedAt instanceof Date),
    ).toEqual([true, true, true]);
    // One email to each administrator, both roles, about no company.
    for (const person of [owner, operator]) {
      const told = await alertsTo(person.email);
      expect(told).toHaveLength(1);
      expect(told[0]!.tenantId).toBeNull();
      const { subject, lines, url } = told[0]!.payload;
      expect(subject).toMatch(/^\d+ failures need a look$/);
      expect(url).toBe('https://app.w360.test/platform/ops');
      expect(lines.find((l) => l.includes('dead-letter queue'))).toMatch(
        new RegExp(`${queueA} 2.*${queueB} 1|${queueB} 1.*${queueA} 2`),
      );
      expect(lines.find((l) => l.includes('used all 12 processing attempts'))).toMatch(
        /Meta \(WhatsApp\) \d+/,
      );
      expect(lines.find((l) => l.includes('could not be matched'))).toContain(
        'Meta (WhatsApp), number not in the account it came with',
      );
      const text = JSON.stringify(told[0]!.payload);
      for (const secret of [
        company.tenant.id,
        company.tenant.slug,
        'store-ref-secret',
        SECRET_TOKEN,
        failed,
        '1234',
      ]) {
        expect(text).not.toContain(secret);
      }
    }
    // Told once: the next alert tells what is new since, and marks nothing it already told.
    const markTimes = async () =>
      fx.query<{ id: string; at: Date }>(
        `SELECT id, alerted_at AS at FROM ops.dead_letters WHERE id = ANY($1::uuid[])
         UNION ALL
         SELECT id, exhausted_alerted_at FROM ops.webhook_receipts WHERE id = ANY($2::uuid[])
         UNION ALL
         SELECT id, alerted_at FROM ops.webhook_quarantine WHERE id = $3
         ORDER BY id`,
        [letters, [failed, stuck], quarantineId],
      );
    const firstMarks = await markTimes();
    const queueC = `it.alert-new-${randomBytes(3).toString('hex')}`;
    await deadLetter(queueC);
    await allowNextAlert();
    await alert();
    expect(await markTimes()).toEqual(firstMarks);
    for (const person of [owner, operator]) {
      const told = await alertsTo(person.email);
      expect(told).toHaveLength(2);
      const second = JSON.stringify(told[1]!.payload);
      expect(second).toContain(`${queueC} 1`);
      expect(second).not.toContain(queueA);
      expect(second).not.toContain(queueB);
    }
  });

  it('sends at most one alert every 15 minutes, and two sweeps at once send one', async () => {
    const owner = await staffOf('platform_owner');
    await allowNextAlert();
    const first = await deadLetter(`it.alert-c-${randomBytes(3).toString('hex')}`);
    await Promise.all([alert(), alert()]);
    expect(await alertsTo(owner.email)).toHaveLength(1);
    expect(await marks('ops.dead_letters', 'alerted_at', [first])).toEqual({ [first]: true });
    // Too soon after that alert: a new dead letter waits, unmarked.
    const second = await deadLetter(`it.alert-d-${randomBytes(3).toString('hex')}`);
    expect((await alert()).alerted).toBe(0);
    expect(await marks('ops.dead_letters', 'alerted_at', [second])).toEqual({ [second]: false });
    expect(await alertsTo(owner.email)).toHaveLength(1);
    // Once 15 minutes have passed, it goes out in the next alert.
    await allowNextAlert();
    expect((await alert()).alerted).toBeGreaterThanOrEqual(1);
    expect(await marks('ops.dead_letters', 'alerted_at', [second])).toEqual({ [second]: true });
    const told = await alertsTo(owner.email);
    expect(told).toHaveLength(2);
    expect(told[1]!.payload.url).toBe('https://app.w360.test/platform/ops/queues');
  });

  it('tells each kind of failure even when it is the only one waiting', async () => {
    await allowNextAlert();
    await alert();
    const letter = await deadLetter(`it.alert-e-${randomBytes(3).toString('hex')}`);
    await allowNextAlert();
    await alert();
    expect(await marks('ops.dead_letters', 'alerted_at', [letter])).toEqual({ [letter]: true });
    const used = await receipt('failed', 12, null);
    await allowNextAlert();
    await alert();
    expect(await marks('ops.webhook_receipts', 'exhausted_alerted_at', [used])).toEqual({
      [used]: true,
    });
    const entry = uuidv7();
    await fx.query(
      `INSERT INTO ops.webhook_quarantine (id, receipt_id, provider, reason)
       VALUES ($1, $2, 'razorpay', 'unknown_asset')`,
      [entry, used],
    );
    await allowNextAlert();
    await alert();
    expect(await marks('ops.webhook_quarantine', 'alerted_at', [entry])).toEqual({ [entry]: true });
  });

  it('retries a stuck receipt, and re-arms the alert of a retried one', async () => {
    const stuck = await receipt('processing', 12, '-5 minutes');
    const listed = (await ops().integrations(staff)).receipts.find((r) => r.id === stuck);
    expect(listed).toMatchObject({ problem: 'exhausted', retryable: true, alertedAt: null });
    // Still processing its last attempt: neither listed as used up nor retryable.
    const working = await receipt('processing', 12, '5 minutes');
    expect(
      (await ops().integrations(staff)).receipts.find((r) => r.id === working),
    ).toBeUndefined();
    await expectCode(
      ops().retryReceipt(staff, { receiptId: working, reason: 'Retrying after the outage' }),
      'precondition_failed',
    );
    await allowNextAlert();
    await alert();
    expect(
      (await ops().integrations(staff)).receipts.find((r) => r.id === stuck)?.alertedAt,
    ).toBeInstanceOf(Date);
    const result = await ops().retryReceipt(staff, {
      receiptId: stuck,
      reason: 'The worker restarted mid-deploy',
    });
    expect(result.previousStatus).toBe('processing');
    const [row] = await fx.query<{
      status: string;
      attempts: number;
      exhausted_alerted_at: Date | null;
    }>(`SELECT status, attempts, exhausted_alerted_at FROM ops.webhook_receipts WHERE id = $1`, [
      stuck,
    ]);
    expect(row).toEqual({ status: 'pending', attempts: 0, exhausted_alerted_at: null });
    // It fails all its attempts again: staff hear of it again.
    await fx.query(
      `UPDATE ops.webhook_receipts SET status = 'failed', attempts = 12 WHERE id = $1`,
      [stuck],
    );
    await allowNextAlert();
    expect((await alert()).alerted).toBeGreaterThanOrEqual(1);
    expect(await marks('ops.webhook_receipts', 'exhausted_alerted_at', [stuck])).toEqual({
      [stuck]: true,
    });
  });

  it('keeps the alert functions to the worker and the rule to the worker and platform staff', async () => {
    for (const fn of [
      'ops.failure_alerts_due()',
      'ops.mark_failure_alert()',
      'ops.platform_failure_alert_recipients()',
    ]) {
      await expect(fx.dbs.platformPool.query(`SELECT * FROM ${fn}`)).rejects.toThrow(
        /permission denied for function/,
      );
    }
    // The rule matches the sweeper's limit (MAX_RECEIPT_ATTEMPTS).
    const rule = async (status: string, attempts: number, lease: string | null) =>
      (
        await fx.dbs.appPool.query<{ used: boolean }>(
          `SELECT ops.webhook_receipt_exhausted($1, $2, now() + $3::interval) AS used`,
          [status, attempts, lease],
        )
      ).rows[0]!.used;
    expect(await rule('failed', 12, null)).toBe(true);
    expect(await rule('failed', 11, null)).toBe(false);
    expect(await rule('processing', 12, '-1 minute')).toBe(true);
    expect(await rule('processing', 12, '1 minute')).toBe(false);
    expect(await rule('processing', 12, null)).toBe(false);
    expect(await rule('pending', 12, null)).toBe(false);
  });
});

describe('queue waits and late queues (ADR-096)', () => {
  const alert = () =>
    alertLateQueues({
      db: fx.dbs.app,
      outbox: { keyring: fx.keyring, jobs: fx.jobs(), signer: fx.signer },
      appBaseUrl: 'https://app.w360.test',
    });
  /** The next queue alert is allowed now, as if the last one went out over 15 minutes ago. */
  const allowNextAlert = () =>
    fx.query(
      `UPDATE ops.platform_alerts SET last_sent_at = now() - interval '16 minutes'
        WHERE kind = 'queues'`,
    );
  /** A queue of this test's own, which no worker takes jobs from, retried once a minute. */
  async function ownQueue() {
    const name = `it.wait-${randomBytes(4).toString('hex')}`;
    await fx.boss.createQueue(name, { retryLimit: 3, retryDelay: 60 });
    return name;
  }
  /** A job that became due `minutes` minutes ago and still waits. */
  async function dueJob(queue: string, minutes: number) {
    const id = await fx.boss.send(queue, { token: SECRET_TOKEN });
    await dueAgo(id!, minutes);
    return id!;
  }
  const dueAgo = (id: string, minutes: number) =>
    fx.query(
      `UPDATE pgboss.job SET start_after = now() - make_interval(mins => $2) WHERE id = $1`,
      [id, minutes],
    );
  const check = (...queues: string[]) =>
    checkQueueWaits(
      fx.dbs.app,
      queues.map((name) => ({ name, limitMinutes: 10 })),
    );
  async function waitsOf(queue: string) {
    const [row] = await fx.query<{
      waiting: number;
      oldest_waiting_since: Date | null;
      limit_minutes: number;
      checked_at: Date;
      late_since: Date | null;
      alerted_at: Date | null;
    }>(
      `SELECT waiting, oldest_waiting_since, limit_minutes, checked_at, late_since, alerted_at
         FROM ops.queue_waits WHERE queue = $1`,
      [queue],
    );
    return row;
  }
  async function administrator() {
    const user = await createUser(fx.dbs, { twoFactor: true });
    await fx.dbs.ownerPool.query(
      `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_owner')`,
      [user.id],
    );
    return user;
  }
  async function noticesTo(email: string) {
    const rows = await fx.query<{
      id: string;
      tenant_id: string | null;
      payload_ciphertext: string;
    }>(
      `SELECT id, tenant_id, payload_ciphertext FROM ops.email_outbox
        WHERE to_address = $1 AND kind = 'platform.notice' ORDER BY created_at, id`,
      [email],
    );
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      payload: JSON.parse(fx.keyring.decryptString(r.payload_ciphertext, outboxAad(r.id))) as {
        subject: string;
        lines: string[];
        url: string;
      },
    }));
  }

  it('records the jobs each queue would hand to a worker and since when the oldest waited, as pg-boss counts them ready', async () => {
    const queue = await ownQueue();
    const idle = await ownQueue();
    const recent = await ownQueue();
    // Waiting 3 minutes, within its limit of 10: on time.
    await dueJob(recent, 3);
    // Taken by a worker: active, not waiting.
    await fx.boss.send(queue, { n: 'active' });
    expect(await fx.boss.fetch(queue)).toHaveLength(1);
    // Done: not waiting.
    const done = await fx.boss.send(queue, { n: 'done' });
    expect((await fx.boss.fetch(queue))?.[0]?.id).toBe(done);
    await fx.boss.complete(queue, done!);
    // Failed once and due again: waiting, since its retry became due.
    const retried = await fx.boss.send(queue, { n: 'retried' });
    expect((await fx.boss.fetch(queue))?.[0]?.id).toBe(retried);
    await fx.boss.fail(queue, retried!);
    await dueAgo(retried!, 2);
    // Not due for another 10 minutes: deferred, not waiting.
    await fx.boss.send(queue, { n: 'later' }, { startAfter: 600 });
    // Due 12 and 3 minutes ago: waiting.
    const oldest = await dueJob(queue, 12);
    await dueJob(queue, 3);
    // Held by a job it depends on: it waits for that job, not for a worker.
    const held = await dueJob(queue, 30);
    await fx.query(`UPDATE pgboss.job SET blocked = true WHERE id = $1`, [held]);
    const states = await fx.query<{ state: string }>(
      `SELECT state FROM pgboss.job WHERE name = $1 ORDER BY state`,
      [queue],
    );
    expect(states.map((s) => s.state).sort()).toEqual(
      ['active', 'completed', 'created', 'created', 'created', 'created', 'retry'].sort(),
    );

    expect(await check(queue, idle, recent)).toEqual({ checked: 3, late: 1 });
    const [due] = await fx.query<{ start_after: Date }>(
      `SELECT start_after FROM pgboss.job WHERE id = $1`,
      [oldest],
    );
    const waits = await waitsOf(queue);
    expect(waits).toMatchObject({
      waiting: 3,
      oldest_waiting_since: due!.start_after,
      limit_minutes: 10,
      alerted_at: null,
    });
    // Late since this check: its oldest job has waited 12 minutes, over its limit of 10.
    expect(waits!.late_since).toEqual(waits!.checked_at);
    expect(Math.abs(waits!.checked_at.getTime() - Date.now())).toBeLessThan(60_000);
    expect(await waitsOf(idle)).toMatchObject({
      waiting: 0,
      oldest_waiting_since: null,
      late_since: null,
    });
    expect(await waitsOf(recent)).toMatchObject({ waiting: 1, late_since: null });
    // The job's payload never leaves pg-boss.
    expect(JSON.stringify(await waitsOf(queue))).not.toContain(SECRET_TOKEN);
  });

  it('emails every platform administrator once when a queue falls behind, and again only after it caught up and fell behind again', async () => {
    const admin = await administrator();
    const queue = await ownQueue();
    const job = await dueJob(queue, 11);
    await check(queue);
    await allowNextAlert();
    const sent = await alert();
    expect(sent.alerted).toBeGreaterThanOrEqual(1);
    expect(sent.recipients).toBeGreaterThanOrEqual(1);
    const [first, ...others] = await noticesTo(admin.email);
    expect(others).toEqual([]);
    expect(first!.tenantId).toBeNull();
    expect(first!.payload.url).toBe('https://app.w360.test/platform/ops/queues');
    expect(first!.payload.lines).toContain(
      `${queue}: 1 job waiting, the oldest for 11 minutes (its limit is 10 minutes).`,
    );
    expect(JSON.stringify(first)).not.toContain(SECRET_TOKEN);
    const told = await waitsOf(queue);
    expect(told!.alerted_at).toBeInstanceOf(Date);

    // Still late at the next checks: not told again.
    await check(queue);
    await allowNextAlert();
    await alert();
    expect(await waitsOf(queue)).toMatchObject({
      late_since: told!.late_since,
      alerted_at: told!.alerted_at,
    });
    // Catching up, but still over half its limit: still late, not told again.
    await dueAgo(job, 7);
    await check(queue);
    expect(await waitsOf(queue)).toMatchObject({
      late_since: told!.late_since,
      alerted_at: told!.alerted_at,
    });
    // Under half its limit: on time again, and its alert re-armed.
    await dueAgo(job, 4);
    expect(await check(queue)).toEqual({ checked: 1, late: 0 });
    expect(await waitsOf(queue)).toMatchObject({ late_since: null, alerted_at: null });
    // Falls behind again while the last alert went out less than 15 minutes ago: it waits.
    await fx.query(
      `UPDATE ops.platform_alerts SET last_sent_at = now() - interval '5 minutes'
        WHERE kind = 'queues'`,
    );
    await dueAgo(job, 12);
    await check(queue);
    expect(await alert()).toMatchObject({ alerted: 0 });
    expect((await waitsOf(queue))!.alerted_at).toBeNull();
    await allowNextAlert();
    expect((await alert()).alerted).toBeGreaterThanOrEqual(1);
    const notices = await noticesTo(admin.email);
    expect(notices).toHaveLength(2);
    expect(notices[1]!.payload.lines).toContain(
      `${queue}: 1 job waiting, the oldest for 12 minutes (its limit is 10 minutes).`,
    );
    // Taken by a worker: nothing waits, on time.
    expect((await fx.boss.fetch(queue))?.[0]?.id).toBe(job);
    expect(await check(queue)).toEqual({ checked: 1, late: 0 });
    expect(await waitsOf(queue)).toMatchObject({
      waiting: 0,
      oldest_waiting_since: null,
      late_since: null,
      alerted_at: null,
    });
  });

  it('tells only fresh checks, sends one alert when two sweeps race, and waits for a sweep already sending one', async () => {
    const admin = await administrator();
    const [a, b, stale] = [await ownQueue(), await ownQueue(), await ownQueue()];
    await dueJob(a, 20);
    await dueJob(b, 25);
    await dueJob(b, 15);
    await dueJob(stale, 30);
    await check(a, b, stale);
    // The worker stopped checking this one 6 minutes ago: not news to tell.
    await fx.query(
      `UPDATE ops.queue_waits SET checked_at = now() - interval '6 minutes' WHERE queue = $1`,
      [stale],
    );
    await allowNextAlert();
    const results = await Promise.all([alert(), alert()]);
    expect(results.filter((r) => r.alerted > 0)).toHaveLength(1);
    expect((await waitsOf(a))!.alerted_at).toBeInstanceOf(Date);
    expect((await waitsOf(b))!.alerted_at).toBeInstanceOf(Date);
    expect((await waitsOf(stale))!.alerted_at).toBeNull();
    const notices = await noticesTo(admin.email);
    expect(notices).toHaveLength(1);
    const { subject, lines } = notices[0]!.payload;
    expect(subject).toMatch(/^\d+ queues are falling behind$/);
    // The longest wait first.
    const named = lines.filter((l) => l.startsWith('it.wait-'));
    expect(
      named.indexOf(`${b}: 2 jobs waiting, the oldest for 25 minutes (its limit is 10 minutes).`),
    ).toBeLessThan(
      named.indexOf(`${a}: 1 job waiting, the oldest for 20 minutes (its limit is 10 minutes).`),
    );
    expect(named.some((l) => l.startsWith(stale))).toBe(false);
    // Right after that alert, a queue falling behind waits for the next one.
    const soon = await ownQueue();
    await dueJob(soon, 30);
    await check(soon);
    expect(await alert()).toMatchObject({ alerted: 0 });
    expect((await waitsOf(soon))!.alerted_at).toBeNull();

    // Another sweep holds the alert's row while it sends one: this sweep waits for it, then finds
    // that alert just gone and tells nothing until 15 minutes have passed.
    const next = await ownQueue();
    await dueJob(next, 40);
    await check(next);
    await allowNextAlert();
    const holder = await fx.dbs.adminPool.connect();
    let held: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM ops.platform_alerts WHERE kind = 'queues' FOR UPDATE`);
      await holder.query(
        `UPDATE ops.platform_alerts SET last_sent_at = now() WHERE kind = 'queues'`,
      );
      const [lock] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      held = alert();
      await vi.waitFor(
        async () => {
          const [waiting] = await fx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND $1 = ANY (pg_blocking_pids(pid))`,
            [lock!.pid],
          );
          if (waiting!.n < 1) throw new Error('the alert is not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    expect(await held).toMatchObject({ alerted: 0 });
    expect((await waitsOf(next))!.alerted_at).toBeNull();
    expect(await noticesTo(admin.email)).toHaveLength(1);
  });

  it('forgets queues no check has touched for 7 days', async () => {
    const [gone, kept] = [await ownQueue(), await ownQueue()];
    await check(gone, kept);
    await fx.query(
      `UPDATE ops.queue_waits SET checked_at = now() - interval '8 days' WHERE queue = $1`,
      [gone],
    );
    await fx.query(
      `UPDATE ops.queue_waits SET checked_at = now() - interval '6 days' WHERE queue = $1`,
      [kept],
    );
    await check(await ownQueue());
    expect(await waitsOf(gone)).toBeUndefined();
    expect(await waitsOf(kept)).toMatchObject({ waiting: 0 });
  });

  it('shows each declared queue’s wait, limit and lateness on the console, and says when the worker stopped checking', async () => {
    const limits = queueWaitLimits(ALL_QUEUES);
    expect(limits.find((l) => l.name === 'tenant.delete')?.limitMinutes).toBe(60);
    expect(limits.find((l) => l.name === 'message.send')?.limitMinutes).toBe(15);
    await checkQueueWaits(fx.dbs.app, limits);
    const fresh = await ops().queues(staff);
    expect(fresh.waitsFresh).toBe(true);
    expect(Math.abs(fresh.waitsCheckedAt!.getTime() - Date.now())).toBeLessThan(60_000);
    for (const definition of ALL_QUEUES) {
      const row = fresh.queues.find((q) => q.name === definition.name);
      expect(row?.policy?.maxWaitMinutes, definition.name).toBe(queueMaxWaitMinutes(definition));
      expect(row?.wait?.limitMinutes, definition.name).toBe(queueMaxWaitMinutes(definition));
    }
    // A declared queue whose oldest job had waited 30 minutes when the worker checked.
    await fx.dbs.app.run(systemScope, (tx) =>
      tx.execute(
        sql`select ops.record_queue_waits(${JSON.stringify([
          {
            queue: 'flow.keys',
            waiting: 4,
            oldest_waiting_since: new Date(Date.now() - 30 * 60_000).toISOString(),
            limit_minutes: 15,
          },
        ])}::jsonb)`,
      ),
    );
    const late = (await ops().queues(staff)).queues.find((q) => q.name === 'flow.keys')!.wait!;
    expect(late).toMatchObject({ waiting: 4, limitMinutes: 15, alertedAt: null });
    expect(late.lateSince).toBeInstanceOf(Date);
    expect(Math.round(late.oldestWaitMs! / 60_000)).toBe(30);
    const overview = await ops().overview(staff);
    expect(overview.lateQueues).toBeGreaterThanOrEqual(1);
    expect(overview.queueCheckFresh).toBe(true);
    // The worker has not checked for 10 minutes: the console says so.
    await fx.query(`UPDATE ops.queue_waits SET checked_at = checked_at - interval '10 minutes'`);
    expect((await ops().queues(staff)).waitsFresh).toBe(false);
    expect((await ops().overview(staff)).queueCheckFresh).toBe(false);
    // Back to what pg-boss holds.
    await checkQueueWaits(fx.dbs.app, limits);
    expect((await ops().queues(staff)).waitsFresh).toBe(true);
  });

  it('keeps the table to its two functions, the functions to the worker, and refuses what is not a check', async () => {
    const privilege = async (role: string, action: string) =>
      (
        await fx.query<{ ok: boolean }>(
          `SELECT has_table_privilege($1, 'ops.queue_waits', $2) AS ok`,
          [role, action],
        )
      )[0]!.ok;
    for (const role of ['w360_app', 'w360_platform']) {
      expect(await privilege(role, 'SELECT'), role).toBe(true);
      for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
        expect(await privilege(role, action), `${role} ${action}`).toBe(false);
      }
    }
    expect(await privilege('w360_auth', 'SELECT')).toBe(false);
    for (const fn of ["ops.record_queue_waits('[]'::jsonb)", 'ops.mark_queue_alert()']) {
      await expect(fx.dbs.platformPool.query(`SELECT * FROM ${fn}`)).rejects.toThrow(
        /permission denied for function/,
      );
    }
    await expect(
      fx.dbs.appPool.query(`SELECT ops.record_queue_waits('{"queue": "a"}'::jsonb)`),
    ).rejects.toThrow(/must be an array/);
    for (const bad of [
      { queue: 'Not A Queue!', waiting: 0, oldest_waiting_since: null, limit_minutes: 10 },
      { queue: 'it.bad', waiting: 1, oldest_waiting_since: null, limit_minutes: 10 },
      { queue: 'it.bad', waiting: 0, oldest_waiting_since: null, limit_minutes: 0 },
    ]) {
      await expect(
        fx.dbs.appPool.query(`SELECT ops.record_queue_waits($1::jsonb)`, [JSON.stringify([bad])]),
        JSON.stringify(bad),
      ).rejects.toThrow(/violates check constraint/);
    }
  });
});

describe('alerts for companies’ failing integrations (ADR-139)', () => {
  const alert = () =>
    alertIntegrationFailures({
      db: fx.dbs.app,
      outbox: { keyring: fx.keyring, jobs: fx.jobs(), signer: fx.signer },
      appBaseUrl: 'https://app.w360.test',
    });
  /** The next alert is allowed now, as if the last one went out over 15 minutes ago. */
  const allowNextAlert = () =>
    fx.query(
      `UPDATE ops.platform_alerts SET last_sent_at = now() - interval '16 minutes'
        WHERE kind = 'integrations'`,
    );
  async function platformOwner() {
    const user = await createUser(fx.dbs, { twoFactor: true });
    await fx.dbs.ownerPool.query(
      `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_owner')`,
      [user.id],
    );
    return user;
  }
  async function alertsTo(email: string) {
    const rows = await fx.query<{
      id: string;
      tenant_id: string | null;
      payload_ciphertext: string;
    }>(
      `SELECT id, tenant_id, payload_ciphertext FROM ops.email_outbox
        WHERE to_address = $1 AND kind = 'platform.notice' ORDER BY created_at, id`,
      [email],
    );
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      payload: JSON.parse(fx.keyring.decryptString(r.payload_ciphertext, outboxAad(r.id))) as {
        subject: string;
        lines: string[];
        url: string;
      },
    }));
  }
  /** The states staff were emailed about, by subject. */
  async function told(ids: string[]) {
    const rows = await fx.query<{ subject_id: string; state: string }>(
      `SELECT subject_id, state FROM ops.integration_alerts
        WHERE subject_id = ANY($1::uuid[]) ORDER BY subject_id, state`,
      [ids],
    );
    return rows.reduce<Record<string, string[]>>(
      (all, r) => ({ ...all, [r.subject_id]: [...(all[r.subject_id] ?? []), r.state] }),
      {},
    );
  }
  async function failingEndpoint() {
    const id = uuidv7();
    await fx.query(
      `INSERT INTO app.webhook_endpoints (id, tenant_id, url, event_types, secret_ciphertext,
         created_by_user_id, failing_since, last_failure_at)
       VALUES ($1, $2, 'https://alerts.example.com/hook', ARRAY['message.received'], 'sealed', $3,
         now() - interval '1 hour', now())`,
      [id, company.tenant.id, company.owner.id],
    );
    return id;
  }

  it('emails every platform administrator once about each failing integration, with counts only', async () => {
    const admin = await platformOwner();
    // The console lists the company's failing endpoint and the number that needs reconnecting.
    const listed = (await ops().integrations(staff)).failures.filter(
      (f) => f.tenantId === company.tenant.id,
    );
    const endpoint = listed.find((f) => f.source === 'webhook_endpoint' && f.state === 'failing');
    const number = listed.find((f) => f.source === 'whatsapp_number');
    expect(endpoint).toBeDefined();
    expect(number).toMatchObject({ state: 'needs_reconnect', label: '+91 90000 11111' });
    await allowNextAlert();
    const sent = await alert();
    // Failures other test files left count too: at least these two.
    expect(sent.alerted).toBeGreaterThanOrEqual(2);
    expect(sent.recipients).toBeGreaterThanOrEqual(1);
    // Every failure of the company that the console lists is told, by its state: one rule for both.
    expect(await told(listed.map((f) => f.subjectId))).toEqual(
      Object.fromEntries(listed.map((f) => [f.subjectId, [f.state]])),
    );
    const [sentAt] = await fx.query<{ at: Date }>(
      `SELECT last_sent_at AS at FROM ops.platform_alerts WHERE kind = 'integrations'`,
    );
    expect((await ops().integrations(staff)).lastIntegrationAlertAt).toEqual(sentAt!.at);
    const emails = await alertsTo(admin.email);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.tenantId).toBeNull();
    const { subject, lines, url } = emails[0]!.payload;
    expect(subject).toMatch(/^\d+ company integrations are failing$/);
    expect(url).toBe('https://app.w360.test/platform/ops/integrations');
    expect(lines[0]).toContain('Webhook endpoint, failing');
    expect(lines[0]).toContain('WhatsApp number, needs reconnecting');
    // Counts only: no company, label, host, error or id.
    const text = JSON.stringify(emails[0]!.payload).toLowerCase();
    for (const secret of [
      company.tenant.id,
      company.tenant.slug,
      SECRET_TOKEN,
      'hooks.example.com',
      '+91 90000 11111',
      'meta rejected the stored token',
      endpoint!.subjectId,
    ]) {
      expect(text).not.toContain(secret.toLowerCase());
    }

    // Told once: a new failure goes out in the next alert, and the earlier marks stay as they were.
    const marks = () =>
      fx.query<{ subject_id: string; alerted_at: Date }>(
        `SELECT subject_id, alerted_at FROM ops.integration_alerts
          WHERE subject_id = ANY($1::uuid[]) ORDER BY subject_id, state`,
        [[endpoint!.subjectId, number!.subjectId]],
      );
    const before = await marks();
    const fresh = await failingEndpoint();
    await allowNextAlert();
    expect((await alert()).alerted).toBeGreaterThanOrEqual(1);
    expect(await told([fresh])).toEqual({ [fresh]: ['failing'] });
    expect(await marks()).toEqual(before);
    const again = await alertsTo(admin.email);
    expect(again).toHaveLength(2);
    expect(again[1]!.payload.lines[0]).toContain('Webhook endpoint, failing');
  });

  it('sends at most one alert every 15 minutes, and two sweeps at once send one', async () => {
    const admin = await platformOwner();
    const first = await failingEndpoint();
    await allowNextAlert();
    await Promise.all([alert(), alert()]);
    expect(await alertsTo(admin.email)).toHaveLength(1);
    expect(await told([first])).toEqual({ [first]: ['failing'] });
    // Too soon after that alert: a new failure waits, not marked.
    const second = await failingEndpoint();
    expect((await alert()).alerted).toBe(0);
    expect(await told([second])).toEqual({});
    expect(await alertsTo(admin.email)).toHaveLength(1);
    // Once 15 minutes have passed, it goes out in the next alert.
    await allowNextAlert();
    expect((await alert()).alerted).toBeGreaterThanOrEqual(1);
    expect(await told([second])).toEqual({ [second]: ['failing'] });
    expect(await alertsTo(admin.email)).toHaveLength(2);
  });

  it('forgets a failure the console has not listed for an hour, so a later one is told again', async () => {
    const id = await failingEndpoint();
    const mark = async () =>
      (
        await fx.query<{ alerted_at: Date; listed_at: Date }>(
          `SELECT alerted_at, listed_at FROM ops.integration_alerts WHERE subject_id = $1`,
          [id],
        )
      )[0];
    const recover = () =>
      fx.query(`UPDATE app.webhook_endpoints SET failing_since = NULL WHERE id = $1`, [id]);
    const fail = () =>
      fx.query(`UPDATE app.webhook_endpoints SET failing_since = now() WHERE id = $1`, [id]);
    const unlistedForAnHour = () =>
      fx.query(
        `UPDATE ops.integration_alerts SET listed_at = now() - interval '61 minutes'
          WHERE subject_id = $1`,
        [id],
      );
    await allowNextAlert();
    await alert();
    const first = await mark();
    expect(first).toBeDefined();
    // It recovers and fails again within the hour: the same failure, not told again.
    await recover();
    await alert();
    expect(await mark()).toEqual(first);
    await fail();
    await allowNextAlert();
    await alert();
    expect((await mark())?.alerted_at).toEqual(first!.alerted_at);
    // Not listed for an hour: forgotten at the next check, and told again once it fails.
    await recover();
    await unlistedForAnHour();
    await alert();
    expect(await mark()).toBeUndefined();
    await fail();
    await allowNextAlert();
    await alert();
    const second = await mark();
    expect(second!.alerted_at.getTime()).toBeGreaterThan(first!.alerted_at.getTime());
    // Still listed: the check finds it before it forgets, however old its mark.
    await unlistedForAnHour();
    await alert();
    const kept = await mark();
    expect(kept!.alerted_at).toEqual(second!.alerted_at);
    expect(kept!.listed_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('tells a failure again when its state changes', async () => {
    const id = await failingEndpoint();
    await allowNextAlert();
    await alert();
    expect(await told([id])).toEqual({ [id]: ['failing'] });
    // Turned off for failing: a new state of the same integration.
    await fx.query(
      `UPDATE app.webhook_endpoints SET state = 'disabled', disabled_reason = 'failing',
         disabled_at = now() WHERE id = $1`,
      [id],
    );
    await allowNextAlert();
    await alert();
    expect(await told([id])).toEqual({ [id]: ['disabled', 'failing'] });
  });

  it('keeps the shared list and the marks to the definer functions, and the alert to the worker', async () => {
    for (const pool of [fx.dbs.appPool, fx.dbs.platformPool]) {
      await expect(pool.query(`SELECT * FROM ops.integration_failures()`)).rejects.toThrow(
        /permission denied for function/,
      );
      await expect(pool.query(`SELECT * FROM ops.integration_alerts`)).rejects.toThrow(
        /permission denied for table/,
      );
    }
    for (const fn of ['ops.integration_alerts_due()', 'ops.mark_integration_alert()']) {
      await expect(fx.dbs.platformPool.query(`SELECT * FROM ${fn}`)).rejects.toThrow(
        /permission denied for function/,
      );
    }
  });
});

describe('acknowledging companies’ failing integrations (ADR-141)', () => {
  async function failingEndpoint() {
    const id = uuidv7();
    await fx.query(
      `INSERT INTO app.webhook_endpoints (id, tenant_id, url, event_types, secret_ciphertext,
         created_by_user_id, failing_since, last_failure_at)
       VALUES ($1, $2, 'https://acks.example.com/hook', ARRAY['message.received'], 'sealed', $3,
         now() - interval '1 hour', now())`,
      [id, company.tenant.id, company.owner.id],
    );
    return id;
  }
  async function namedStaff(name: string): Promise<PlatformActor> {
    const user = await createUser(fx.dbs, { twoFactor: true, name });
    await fx.dbs.ownerPool.query(
      `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_operator')`,
      [user.id],
    );
    return { userId: user.id, role: 'platform_operator', correlationId: uuidv7() };
  }
  const listed = async (id: string) =>
    (await ops().integrations(staff)).failures.find((f) => f.subjectId === id);
  const acknowledge = (actor: PlatformActor, subjectId: string, note: string, state = 'failing') =>
    ops().acknowledgeFailure(actor, { source: 'webhook_endpoint', subjectId, state, note });
  /** The minute sweep's check (ADR-139), which keeps and forgets acknowledgements too. */
  const check = () =>
    fx.dbs.app.run(systemScope, (tx) => tx.execute(sql`select ops.integration_alerts_due()`));
  const stored = (id: string) =>
    fx.query<{ note: string; listed_at: Date }>(
      `SELECT note, listed_at FROM ops.integration_acknowledgements WHERE subject_id = $1`,
      [id],
    );

  it('records who took a listed failure and their note; another administrator replaces it; each is audited', async () => {
    const id = await failingEndpoint();
    expect((await listed(id))?.acknowledgement).toBeNull();
    const asha = await namedStaff('Asha Ops');
    await acknowledge(asha, id, '  Asked the company to fix their receiver.  ');
    const first = (await listed(id))!.acknowledgement!;
    expect(first).toMatchObject({
      byName: 'Asha Ops',
      note: 'Asked the company to fix their receiver.',
    });
    expect(Date.now() - first.at.getTime()).toBeLessThan(60_000);
    await fx.query(
      `UPDATE ops.integration_acknowledgements
          SET acknowledged_at = acknowledged_at - interval '1 hour' WHERE subject_id = $1`,
      [id],
    );

    const ravi = await namedStaff('Ravi Ops');
    await acknowledge(ravi, id, 'Their receiver is back; watching the retries.');
    const second = (await listed(id))!.acknowledgement!;
    expect(second).toMatchObject({
      byName: 'Ravi Ops',
      note: 'Their receiver is back; watching the retries.',
    });
    expect(Date.now() - second.at.getTime()).toBeLessThan(60_000);
    expect(await stored(id)).toHaveLength(1);

    const audited = await fx.query<{
      actor_user_id: string;
      reason: string;
      target_tenant_id: string;
      metadata: unknown;
      correlation_id: string;
    }>(
      `SELECT actor_user_id, reason, target_tenant_id, metadata, correlation_id
         FROM ops.platform_audit_events
        WHERE action = 'platform.integration_failure_acknowledged' AND metadata->>'subjectId' = $1
        ORDER BY occurred_at, id`,
      [id],
    );
    expect(audited.map((a) => [a.actor_user_id, a.reason, a.correlation_id])).toEqual([
      [asha.userId, 'Asked the company to fix their receiver.', asha.correlationId],
      [ravi.userId, 'Their receiver is back; watching the retries.', ravi.correlationId],
    ]);
    expect(audited[0]!.target_tenant_id).toBe(company.tenant.id);
    expect(audited[0]!.metadata).toEqual({
      source: 'webhook_endpoint',
      subjectId: id,
      state: 'failing',
    });
  });

  it('refuses a failure not listed in that state, a note out of bounds and anyone who is not an administrator', async () => {
    const id = await failingEndpoint();
    await expectCode(
      acknowledge(staff, id, 'Looking into it with the company.', 'disabled'),
      'not_found',
    );
    await expectCode(
      acknowledge(staff, uuidv7(), 'Looking into it with the company.'),
      'not_found',
    );
    await expectCode(acknowledge(staff, id, 'Too short'), 'validation_failed');
    await expectCode(acknowledge(staff, id, '      Too short      '), 'validation_failed');
    await expectCode(acknowledge(staff, id, 'x'.repeat(501)), 'validation_failed');
    // The function checks the note itself too, whatever calls it, and trims it.
    const direct = (subjectId: string, note: string) =>
      fx.dbs.platform.run(staff.userId, (tx) =>
        tx.execute(
          sql`select ops.platform_acknowledge_integration_failure('webhook_endpoint', ${subjectId}::uuid, 'failing', ${note}, 'c')`,
        ),
      );
    await expectCode(direct(id, '   short   '), 'precondition_failed');
    await expectCode(direct(id, 'x'.repeat(501)), 'precondition_failed');
    const other = await failingEndpoint();
    await direct(other, '   Noted straight in SQL.   ');
    expect((await stored(other)).map((a) => a.note)).toEqual(['Noted straight in SQL.']);
    const [audit] = await fx.query<{ reason: string }>(
      `SELECT reason FROM ops.platform_audit_events
        WHERE action = 'platform.integration_failure_acknowledged' AND metadata->>'subjectId' = $1`,
      [other],
    );
    expect(audit!.reason).toBe('Noted straight in SQL.');
    const outsider = await createUser(fx.dbs, { twoFactor: true });
    await expectCode(
      acknowledge(
        { userId: outsider.id, role: 'platform_operator', correlationId: uuidv7() },
        id,
        'Looking into it with the company.',
      ),
      'forbidden',
    );
    // Once it recovers, it can no longer be acknowledged.
    await fx.query(`UPDATE app.webhook_endpoints SET failing_since = NULL WHERE id = $1`, [id]);
    await expectCode(acknowledge(staff, id, 'Looking into it with the company.'), 'not_found');
    expect(await stored(id)).toEqual([]);
  });

  it('keeps an acknowledgement while the failure is listed and forgets it an hour after, so a later failure starts without one', async () => {
    const id = await failingEndpoint();
    await acknowledge(staff, id, 'Asked the company to fix their receiver.');
    const lastListed = (minutesAgo: number) =>
      fx.query(
        `UPDATE ops.integration_acknowledgements
            SET listed_at = now() - make_interval(mins => $2) WHERE subject_id = $1`,
        [id, minutesAgo],
      );
    // Still listed: the check finds it before it forgets, however old its mark.
    await lastListed(120);
    await check();
    expect(Date.now() - (await stored(id))[0]!.listed_at.getTime()).toBeLessThan(60_000);
    // Recovered: kept within the hour, forgotten after it.
    await fx.query(`UPDATE app.webhook_endpoints SET failing_since = NULL WHERE id = $1`, [id]);
    await lastListed(59);
    await check();
    expect(await stored(id)).toHaveLength(1);
    // Back within the hour: listed with its acknowledgement.
    await fx.query(`UPDATE app.webhook_endpoints SET failing_since = now() WHERE id = $1`, [id]);
    expect((await listed(id))?.acknowledgement?.note).toBe(
      'Asked the company to fix their receiver.',
    );
    await fx.query(`UPDATE app.webhook_endpoints SET failing_since = NULL WHERE id = $1`, [id]);
    await lastListed(61);
    await check();
    expect(await stored(id)).toEqual([]);
    // It fails again later: listed without an acknowledgement.
    await fx.query(`UPDATE app.webhook_endpoints SET failing_since = now() WHERE id = $1`, [id]);
    expect((await listed(id))?.acknowledgement).toBeNull();
  });

  it('still counts only the failures staff were not told of, as the check did before 0107', async () => {
    const id = await failingEndpoint();
    const due = async () => Number((await check()).rows[0]?.integration_alerts_due);
    const before = await due();
    expect(before).toBeGreaterThanOrEqual(1);
    // Told (ADR-139): no longer counted.
    await fx.query(
      `INSERT INTO ops.integration_alerts (source, subject_id, state, alerted_at, listed_at)
       VALUES ('webhook_endpoint', $1, 'failing', now(), now())`,
      [id],
    );
    expect(await due()).toBe(before - 1);
  });

  it('starts a new state of the same integration without an acknowledgement', async () => {
    const id = await failingEndpoint();
    await acknowledge(staff, id, 'Asked the company to fix their receiver.');
    await fx.query(
      `UPDATE app.webhook_endpoints SET state = 'disabled', disabled_reason = 'failing',
         disabled_at = now() WHERE id = $1`,
      [id],
    );
    expect(await listed(id)).toMatchObject({ state: 'disabled', acknowledgement: null });
    await acknowledge(
      staff,
      id,
      'Turned off: the company is moving to a new receiver.',
      'disabled',
    );
    expect((await listed(id))?.acknowledgement?.note).toBe(
      'Turned off: the company is moving to a new receiver.',
    );
    // The failing state is no longer listed: forgotten an hour after, as the integration's other
    // state is listed.
    await fx.query(
      `UPDATE ops.integration_acknowledgements SET listed_at = now() - interval '61 minutes'
        WHERE subject_id = $1 AND state = 'failing'`,
      [id],
    );
    await check();
    const states = await fx.query<{ state: string }>(
      `SELECT state FROM ops.integration_acknowledgements WHERE subject_id = $1`,
      [id],
    );
    expect(states.map((a) => a.state)).toEqual(['disabled']);
  });

  it('gives the console the times the definer functions return, not null or the epoch', async () => {
    // Found while building ADR-141: drizzle hands raw query results over as text, and the console
    // dropped every time it read from a definer function.
    const id = await failingEndpoint();
    const [endpoint] = await fx.query<{ failing_since: Date }>(
      `SELECT failing_since FROM app.webhook_endpoints WHERE id = $1`,
      [id],
    );
    expect((await listed(id))?.since).toEqual(endpoint!.failing_since);
    const [tenant] = await fx.query<{ created_at: Date }>(
      `SELECT created_at FROM app.tenants WHERE id = $1`,
      [company.tenant.id],
    );
    const health = await ops().companyHealth(staff, company.tenant.id);
    expect(health!.health.facts.createdAt).toEqual(tenant!.created_at);
    expect(health!.health.facts.qualityCheckedAt).toBeInstanceOf(Date);
  });

  it('keeps acknowledgements to the definer functions and the acknowledging to platform staff', async () => {
    for (const pool of [fx.dbs.appPool, fx.dbs.platformPool]) {
      await expect(pool.query(`SELECT * FROM ops.integration_acknowledgements`)).rejects.toThrow(
        /permission denied for table/,
      );
    }
    await expect(
      fx.dbs.appPool.query(
        `SELECT ops.platform_acknowledge_integration_failure('webhook_endpoint', gen_random_uuid(), 'failing', 'Looking into it.', 'c')`,
      ),
    ).rejects.toThrow(/permission denied for function/);
    const functions = await fx.query<{
      fn: string;
      owner: string;
      definer: boolean;
      config: unknown;
    }>(
      `SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(p.proowner) AS owner,
              p.prosecdef AS definer, p.proconfig AS config
         FROM pg_proc p
        WHERE p.oid IN (
          'ops.platform_acknowledge_integration_failure(text,uuid,text,text,text)'::regprocedure,
          'ops.platform_ops_integration_failures(integer)'::regprocedure,
          'ops.integration_alerts_due()'::regprocedure)
        ORDER BY 1`,
    );
    expect(functions).toEqual(
      [
        'ops.integration_alerts_due()',
        'ops.platform_acknowledge_integration_failure(text,uuid,text,text,text)',
        'ops.platform_ops_integration_failures(integer)',
      ].map((fn) => ({
        fn,
        owner: 'w360_definer',
        definer: true,
        config: ['search_path=pg_catalog, pg_temp'],
      })),
    );
  });
});

describe('acknowledging dead letters (ADR-169)', () => {
  /**
   * A dead letter already emailed about, so the alert tests of this file count only theirs. One
   * whose envelope did not verify keeps no kind, company or reference, as the worker records it
   * (0026's check).
   */
  async function letter(verified: boolean, tenantId: string | null = company.tenant.id) {
    const id = uuidv7();
    await fx.query(
      `INSERT INTO ops.dead_letters (id, source_queue, kind, tenant_id, ref, verified, error_code,
         failed_at, alerted_at)
       VALUES ($1, 'template.submit', $2, $3, $4, $5, 'provider_rejected', now(), now())`,
      [
        id,
        verified ? 'template.submit' : null,
        verified ? tenantId : null,
        verified ? 'tpl-ack' : null,
        verified,
      ],
    );
    return id;
  }
  async function namedStaff(name: string): Promise<PlatformActor> {
    const user = await createUser(fx.dbs, { twoFactor: true, name });
    await fx.dbs.ownerPool.query(
      `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_operator')`,
      [user.id],
    );
    return { userId: user.id, role: 'platform_operator', correlationId: uuidv7() };
  }
  const listed = async (id: string) =>
    (await ops().queues(staff)).deadLetters.find((d) => d.id === id);
  const acknowledge = (actor: PlatformActor, deadLetterId: string, note: string) =>
    ops().acknowledgeDeadLetter(actor, { deadLetterId, note });
  const audits = (id: string) =>
    fx.query<{
      actor_user_id: string;
      reason: string;
      target_tenant_id: string | null;
      metadata: unknown;
      correlation_id: string;
    }>(
      `SELECT actor_user_id, reason, target_tenant_id, metadata, correlation_id
         FROM ops.platform_audit_events
        WHERE action = 'platform.dead_letter_acknowledged' AND metadata->>'deadLetterId' = $1
        ORDER BY occurred_at, id`,
      [id],
    );

  it('records who looked at a dead letter and their note; another administrator replaces it; each is audited', async () => {
    const id = await letter(true);
    const before = (await listed(id))!;
    expect(before).toMatchObject({
      acknowledgedAt: null,
      acknowledgedByName: null,
      acknowledgement: null,
    });
    const asha = await namedStaff('Asha Ops');
    await acknowledge(asha, id, '  Template fixed upstream; no retry needed.  ');
    const first = (await listed(id))!;
    expect([first.acknowledgedByName, first.acknowledgement]).toEqual([
      'Asha Ops',
      'Template fixed upstream; no retry needed.',
    ]);
    expect(Date.now() - first.acknowledgedAt!.getTime()).toBeLessThan(60_000);
    // Acknowledging changes nothing about the job or whether it can be retried.
    expect([first.retriedAt, first.retryBlock]).toEqual([null, before.retryBlock]);

    const ravi = await namedStaff('Ravi Ops');
    await acknowledge(ravi, id, 'The company resubmitted it themselves.');
    expect(await listed(id)).toMatchObject({
      acknowledgedByName: 'Ravi Ops',
      acknowledgement: 'The company resubmitted it themselves.',
    });
    const audited = await audits(id);
    expect(audited.map((a) => [a.actor_user_id, a.reason, a.correlation_id])).toEqual([
      [asha.userId, 'Template fixed upstream; no retry needed.', asha.correlationId],
      [ravi.userId, 'The company resubmitted it themselves.', ravi.correlationId],
    ]);
    expect(audited[0]!.target_tenant_id).toBe(company.tenant.id);
    expect(audited[0]!.metadata).toEqual({ deadLetterId: id, queue: 'template.submit' });

    // The Queues tab's CSV gives when, never who or the note.
    const file = await ops().exportList(staff, 'dead-letters', 30);
    const line = file.body.split('\r\n').find((l) => l.includes(id))!;
    expect(line).toMatch(/,\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    for (const left of ['Ravi', 'Asha', 'resubmitted', 'upstream']) {
      expect(file.body).not.toContain(left);
    }
  });

  it('names a company in the audit only through a verified signature, and refuses unknown dead letters, bad notes and anyone who is not an administrator', async () => {
    // A job whose signature did not verify: its company id is not trusted, so none is named.
    const unverified = await letter(false);
    await acknowledge(staff, unverified, 'Forged or stale envelope; nothing to retry.');
    expect((await audits(unverified))[0]!.target_tenant_id).toBeNull();
    const platformJob = await letter(true, null);
    await acknowledge(staff, platformJob, 'Platform job; Meta was down for an hour.');
    expect((await audits(platformJob))[0]!.target_tenant_id).toBeNull();

    const id = await letter(true);
    await expectCode(acknowledge(staff, uuidv7(), 'Looking into this dead letter.'), 'not_found');
    await expectCode(acknowledge(staff, id, 'Too short'), 'validation_failed');
    await expectCode(acknowledge(staff, id, '      Too short      '), 'validation_failed');
    await expectCode(acknowledge(staff, id, 'x'.repeat(501)), 'validation_failed');
    await expectCode(
      acknowledge(staff, 'not-a-uuid', 'Looking into this dead letter.'),
      'validation_failed',
    );
    // The function checks the note itself too, whatever calls it, and trims it.
    const direct = (deadLetterId: string, note: string) =>
      fx.dbs.platform.run(staff.userId, (tx) =>
        tx.execute(
          sql`select ops.platform_acknowledge_dead_letter(${deadLetterId}::uuid, ${note}, 'c')`,
        ),
      );
    await expectCode(direct(id, '   short   '), 'precondition_failed');
    await expectCode(direct(id, 'x'.repeat(501)), 'precondition_failed');
    await expectCode(direct(uuidv7(), 'Looking into this dead letter.'), 'not_found');
    await direct(id, '   Noted straight in SQL.   ');
    expect((await listed(id))?.acknowledgement).toBe('Noted straight in SQL.');
    const outsider = await createUser(fx.dbs, { twoFactor: true });
    const asOutsider = {
      userId: outsider.id,
      role: 'platform_operator' as const,
      correlationId: uuidv7(),
    };
    await expectCode(acknowledge(asOutsider, id, 'Looking into this dead letter.'), 'forbidden');
    expect((await listed(id))?.acknowledgement).toBe('Noted straight in SQL.');
  });

  it('keeps the writing to the definer function and the acknowledging to platform staff', async () => {
    const id = await letter(true);
    // The console reads the columns; neither runtime role writes them.
    for (const pool of [fx.dbs.appPool, fx.dbs.platformPool]) {
      await expect(
        pool.query(
          `UPDATE ops.dead_letters SET acknowledged_at = now(), acknowledgement = 'Changed by hand here.' WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/permission denied for table/);
    }
    await expect(
      fx.dbs.appPool.query(
        `SELECT ops.platform_acknowledge_dead_letter($1::uuid, 'Looking into this dead letter.', 'c')`,
        [id],
      ),
    ).rejects.toThrow(/permission denied for function/);
    const [fn] = await fx.query<{ owner: string; definer: boolean; config: unknown }>(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config
         FROM pg_proc p
        WHERE p.oid = 'ops.platform_acknowledge_dead_letter(uuid,text,text)'::regprocedure`,
    );
    expect(fn).toEqual({
      owner: 'w360_definer',
      definer: true,
      config: ['search_path=pg_catalog, pg_temp'],
    });
    // A note, its author and its time go together, and a note keeps to its length.
    await expect(
      fx.query(`UPDATE ops.dead_letters SET acknowledged_at = now() WHERE id = $1`, [id]),
    ).rejects.toThrow(/dead_letters_acknowledged/);
    await expect(
      fx.query(
        `UPDATE ops.dead_letters SET acknowledged_at = now(), acknowledged_by_user_id = $2,
                acknowledgement = 'short' WHERE id = $1`,
        [id, staff.userId],
      ),
    ).rejects.toThrow(/dead_letters_acknowledged/);
  });
});

describe('exports of the onboarding, integrations and queues lists (ADR-158)', () => {
  const MINUTE = '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}';
  const csvLines = (body: string) => body.replace(/^\uFEFF/, '').split('\r\n');
  const exports = async (actor: PlatformActor) =>
    fx.query<{ action: string; metadata: Record<string, number> }>(
      `SELECT action, metadata FROM ops.platform_audit_events
        WHERE actor_user_id = $1 AND action LIKE 'platform.ops\\_%\\_exported'
        ORDER BY occurred_at, id`,
      [actor.userId],
    );

  it('exports the Onboarding tab’s three lists as the tab reads them, each with its entry', async () => {
    const exporter = await platformStaff();
    const acme = await fx.company();
    const slug = acme.tenant.slug;
    await fx.query(
      `INSERT INTO app.channel_onboarding_sessions (id, tenant_id, state_hash, created_by_user_id,
         auth_session_id, status, failure_reason, expires_at)
       VALUES ($1, $2, $3, $4, 'sess_x', 'failed', 'Meta refused the code, try again.',
         now() + interval '1 hour')`,
      [uuidv7(), acme.tenant.id, randomBytes(32).toString('hex'), acme.owner.id],
    );
    await fx.query(
      `INSERT INTO app.channel_accounts (id, tenant_id, whatsapp_account_id, phone_number_id,
         display_phone_number, status, onboarding_step, onboarding_error)
       VALUES ($1, $2, $3, $4, '+91 90000 22222', 'failed', 'register_number',
         'Meta refused the PIN.')`,
      [uuidv7(), acme.tenant.id, acme.whatsappAccountId, nextExternalId()],
    );
    // A company created without any number, and one whose only number is being set up.
    const bare = await createTenant(fx.dbs, await createUser(fx.dbs));
    const setting = await fx.company();
    await fx.query(`UPDATE app.channel_accounts SET status = 'onboarding' WHERE id = $1`, [
      setting.channelAccountId,
    ]);

    const tab = await ops().onboarding(exporter);
    const signups = await ops().exportList(exporter, 'signups', 30);
    expect(signups.filename).toMatch(/^hyfib-signups-30-days-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(signups.body).toBe(signupsCsv(tab.sessions));
    const signupLines = csvLines(signups.body);
    expect(signupLines[0]).toBe(SIGNUPS_CSV_COLUMNS.join(','));
    expect(signupLines.filter((l) => l.includes(`,${slug},`))).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Company ${slug},${slug},Failed,"Meta refused the code, try again\\.",${MINUTE},Yes$`,
        ),
      ),
    ]);

    const setups = await ops().exportList(exporter, 'number-setups', 30);
    expect(setups.filename).toMatch(/^hyfib-number-setups-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(setups.body).toBe(numberSetupsCsv(tab.numbers));
    const setupLines = csvLines(setups.body);
    expect(setupLines[0]).toBe(NUMBER_SETUPS_CSV_COLUMNS.join(','));
    expect(setupLines.filter((l) => l.includes(`,${slug},`))).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Company ${slug},${slug},'\\+91 90000 22222,Failed,Registering the number,` +
            `Meta refused the PIN\\.,${MINUTE}$`,
        ),
      ),
    ]);

    const fresh = await ops().exportList(exporter, 'new-companies', 30);
    expect(fresh.filename).toMatch(/^hyfib-new-companies-30-days-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(fresh.body).toBe(newCompaniesCsv(tab.stalled));
    const freshLines = csvLines(fresh.body);
    expect(freshLines[0]).toBe(NEW_COMPANIES_CSV_COLUMNS.join(','));
    expect(freshLines.filter((l) => l.includes(`,${bare.slug},`))).toEqual([
      expect.stringMatching(new RegExp(`^Company ${bare.slug},${bare.slug},active,${MINUTE},No$`)),
    ]);
    const settingSlug = setting.tenant.slug;
    expect(freshLines.filter((l) => l.includes(`,${settingSlug},`))).toEqual([
      expect.stringMatching(
        new RegExp(`^Company ${settingSlug},${settingSlug},active,${MINUTE},Yes$`),
      ),
    ]);
    // A company with an active number is not a new company without one.
    expect(freshLines.some((l) => l.includes(`,${slug},`))).toBe(false);
    expect(tab.stalled.some((c) => c.slug === slug)).toBe(false);

    expect(await exports(exporter)).toEqual([
      {
        action: 'platform.ops_signups_exported',
        metadata: { days: 30, rows: signupLines.length - 2 },
      },
      { action: 'platform.ops_number_setups_exported', metadata: { rows: setupLines.length - 2 } },
      {
        action: 'platform.ops_new_companies_exported',
        metadata: { days: 30, companies: freshLines.length - 2 },
      },
    ]);
  });

  it('exports the Integrations tab’s lists without who acknowledged a failure, its note or an address', async () => {
    const exporter = await platformStaff();
    const beta = await fx.company();
    const slug = beta.tenant.slug;
    // This test's own markers: other tests leave receipts whose last error names SECRET_TOKEN,
    // and the receipts list shows each receipt's last error, as the tab does.
    const urlToken = `tok_${randomBytes(8).toString('hex')}`;
    const messageText = `Export test message ${randomBytes(4).toString('hex')}`;
    const address = `nobody-${randomBytes(4).toString('hex')}@export.test`;
    const endpointId = uuidv7();
    await fx.query(
      `INSERT INTO app.webhook_endpoints (id, tenant_id, url, event_types, secret_ciphertext,
         created_by_user_id, failing_since, last_failure_at)
       VALUES ($1, $2, $3, ARRAY['message.received'], 'sealed', $4, now() - interval '5 minutes',
         now())`,
      [
        endpointId,
        beta.tenant.id,
        `https://${slug}.example.com/hook?token=${urlToken}`,
        beta.owner.id,
      ],
    );
    const note = 'Taken by the export test: the receiver is down until noon.';
    await ops().acknowledgeFailure(exporter, {
      source: 'webhook_endpoint',
      subjectId: endpointId,
      state: 'failing',
      note,
    });
    const receiptId = uuidv7();
    await fx.query(
      `INSERT INTO ops.webhook_receipts (id, provider, received_at, body_sha256, body_ciphertext,
         body_size, status, attempts, last_error)
       VALUES ($1, 'meta_whatsapp', now(), $2, 'sealed-body', 10, 'failed', 12, 'boom, twice')`,
      [receiptId, randomBytes(32).toString('hex')],
    );
    const stranger = { ...beta, wabaId: nextExternalId(), phoneNumberId: nextExternalId() };
    const { receiptId: quarantined } = await fx.deliver(
      fx.messagesBody(stranger, { messages: [{ waId: '919876500004', text: messageText }] }),
    );
    // A refused email: the console counts it by kind and never shows the address.
    await fx.query(
      `INSERT INTO ops.email_outbox (id, kind, to_address, status, attempts, last_error)
       VALUES ($1, 'it.export.refused', $2, 'failed', 5, $3)`,
      [uuidv7(), address, `refused ${address}`],
    );

    const tab = await ops().integrations(exporter);
    const failures = await ops().exportList(exporter, 'failures', 30);
    expect(failures.filename).toMatch(/^hyfib-failures-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(failures.body).toBe(failuresCsv(tab.failures));
    const failureLines = csvLines(failures.body);
    expect(failureLines[0]).toBe(FAILURES_CSV_COLUMNS.join(','));
    expect(failureLines.filter((l) => l.includes(`,${slug},`))).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Company ${slug},${slug},Webhook endpoint,${slug}\\.example\\.com,Failing,,${MINUTE},${MINUTE}$`,
        ),
      ),
    ]);
    expect(tab.failures.find((f) => f.subjectId === endpointId)?.acknowledgement?.note).toBe(note);
    expect(failures.body).not.toContain('receiver is down');

    const receipts = await ops().exportList(exporter, 'receipts', 30);
    expect(receipts.filename).toMatch(/^hyfib-receipts-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(receipts.body).toBe(receiptsCsv(tab.receipts));
    const receiptLines = csvLines(receipts.body);
    expect(receiptLines[0]).toBe(RECEIPTS_CSV_COLUMNS.join(','));
    expect(receiptLines.filter((l) => l.includes(`,${receiptId},`))).toEqual([
      expect.stringMatching(
        new RegExp(
          `^${MINUTE},${receiptId},Meta \\(WhatsApp\\),Failed all attempts,12,"boom, twice",,Can be retried$`,
        ),
      ),
    ]);

    const quarantine = await ops().exportList(exporter, 'quarantine', 30);
    expect(quarantine.filename).toMatch(/^hyfib-quarantine-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(quarantine.body).toBe(quarantineCsv(tab.quarantine));
    const quarantineLines = csvLines(quarantine.body);
    expect(quarantineLines[0]).toBe(QUARANTINE_CSV_COLUMNS.join(','));
    expect(quarantineLines.filter((l) => l.includes(`,${quarantined},`))).toEqual([
      expect.stringMatching(
        new RegExp(
          `^${MINUTE},${quarantined},Meta \\(WhatsApp\\),Unknown account or number,` +
            `waba: ${stranger.wabaId}; phoneNumberId: ${stranger.phoneNumberId},,Yes$`,
        ),
      ),
    ]);

    const emails = await ops().exportList(exporter, 'emails', 30);
    expect(emails.filename).toMatch(/^hyfib-emails-7-days-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(emails.body).toBe(emailsCsv(tab.emails));
    const emailLines = csvLines(emails.body);
    expect(emailLines[0]).toBe(EMAILS_CSV_COLUMNS.join(','));
    expect(emailLines).toContain('it.export.refused,1,0');

    // Endpoints are shown by their host: no URL's token, this test's or another's, is exported.
    expect(failures.body).not.toContain(SECRET_TOKEN);
    const everything = failures.body + receipts.body + quarantine.body + emails.body;
    for (const secret of [urlToken, messageText, address]) {
      expect(everything).not.toContain(secret);
    }
    expect(await exports(exporter)).toEqual([
      { action: 'platform.ops_failures_exported', metadata: { rows: failureLines.length - 2 } },
      { action: 'platform.ops_receipts_exported', metadata: { rows: receiptLines.length - 2 } },
      {
        action: 'platform.ops_quarantine_exported',
        metadata: { rows: quarantineLines.length - 2 },
      },
      {
        action: 'platform.ops_emails_exported',
        metadata: { days: 7, rows: emailLines.length - 2 },
      },
    ]);
  });

  it('exports the Queues tab’s lists as the tab reads them, never naming who retried a job', async () => {
    const exporter = await platformStaff();
    const gamma = await fx.company();
    const slug = gamma.tenant.slug;
    const letterId = uuidv7();
    await fx.query(
      `INSERT INTO ops.dead_letters (id, source_queue, source_job_id, kind, tenant_id, ref, verified,
         retries, error_name, error_code, failed_at)
       VALUES ($1, 'commerce.store', $2, 'commerce.store', $3, 'store-export', true, 5, 'AppError',
         'provider_rejected', now())`,
      [letterId, uuidv7(), gamma.tenant.id],
    );

    const tab = await ops().queues(exporter);
    const queues = await ops().exportList(exporter, 'queues', 30);
    expect(queues.filename).toMatch(/^hyfib-queues-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(queues.body).toBe(queuesCsv(tab.queues));
    const queueLines = csvLines(queues.body);
    expect(queueLines[0]).toBe(QUEUES_CSV_COLUMNS.join(','));
    // Every declared queue has its line, with its policy.
    expect(queueLines.length - 2).toBeGreaterThanOrEqual(ALL_QUEUES.length);
    const store = tab.queues.find((q) => q.name === 'commerce.store');
    expect(store?.deadLetters.last24h).toBeGreaterThanOrEqual(1);
    expect(queueLines.filter((l) => l.startsWith('commerce.store,'))).toEqual([
      expect.stringMatching(/^commerce\.store,Yes,5,Yes,60,Yes,\d+,\d+,\d+,\d+,/),
    ]);

    const letters = await ops().exportList(exporter, 'dead-letters', 30);
    expect(letters.filename).toMatch(/^hyfib-dead-letters-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(letters.body).toBe(deadLettersCsv(tab.deadLetters));
    const letterLines = csvLines(letters.body);
    expect(letterLines[0]).toBe(DEAD_LETTERS_CSV_COLUMNS.join(','));
    expect(letterLines.filter((l) => l.includes(`,${letterId},`))).toEqual([
      expect.stringMatching(
        new RegExp(
          `^${MINUTE},${letterId},commerce\\.store,Yes,Company ${slug},${slug},store-export,` +
            // Not acknowledged (ADR-169): the last column is empty.
            `AppError,provider_rejected,5,,,,Can be retried,${MINUTE},$`,
        ),
      ),
    ]);
    expect(await exports(exporter)).toEqual([
      { action: 'platform.ops_queues_exported', metadata: { rows: queueLines.length - 2 } },
      {
        action: 'platform.ops_dead_letters_exported',
        metadata: { rows: letterLines.length - 2 },
      },
    ]);
  });

  it('refuses every list to anyone who is not a platform administrator, writing nothing', async () => {
    const outsider = await createUser(fx.dbs, { twoFactor: true });
    const actor: PlatformActor = {
      userId: outsider.id,
      role: 'platform_operator',
      correlationId: uuidv7(),
    };
    const lists: OpsExportList[] = [
      'signups',
      'number-setups',
      'new-companies',
      'failures',
      'receipts',
      'quarantine',
      'emails',
      'queues',
      'dead-letters',
    ];
    for (const list of lists) {
      await expectCode(ops().exportList(actor, list, 30), 'forbidden');
    }
    const [refused] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ops.platform_audit_events WHERE actor_user_id = $1`,
      [outsider.id],
    );
    expect(refused?.n).toBe(0);
  });
});
