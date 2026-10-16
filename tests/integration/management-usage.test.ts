import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isAppError, systemClock } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import { authorizedTenantScope } from '@w360/db';
import {
  MANAGEMENT_RESUME_MARGIN_MS,
  checkWhatsAppAccess,
  createOnboardingService,
  createTemplatesService,
  deferPausedJob,
  findAccessChecksDue,
  findTemplateSyncsDue,
  processChannelOnboarding,
  processTemplateSubmit,
  syncTemplates,
  type TemplatesService,
} from '@w360/domain';
import { usageHeaderValue } from '../support/graph-stand-in';
import { APP_ID, APP_SECRET, startWhatsAppFixture, type Company } from './whatsapp-fixture';
import type { WhatsAppFixture } from './whatsapp-fixture';

/**
 * Pacing WhatsApp management calls by Meta's `x-business-use-case-usage` header (ADR-399), against
 * real PostgreSQL and the test-only Graph stand-in, which sends the header when a test sets it: a
 * reading is stored for the account the call was made for and in its company only, a header
 * naming another WABA or a malformed one changes nothing, a paused account's background work asks
 * Graph nothing and is queued again for just after the pause, members' actions say Meta is
 * limiting management requests, and Channels shows the reading.
 */
let fx: WhatsAppFixture;
let templates: TemplatesService;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  templates = createTemplatesService({
    db: fx.dbs.app,
    jobs: fx.jobs(),
    signer: fx.signer,
    clock: systemClock,
  });
});

afterAll(async () => {
  await fx.close();
});

beforeEach(() => {
  fx.standIn.state.usageHeader = null;
});

const workerDeps = () => ({
  db: fx.dbs.app,
  keyring: fx.keyring,
  graph: fx.graph,
  clock: systemClock,
});
const scopeOf = (c: Company) => authorizedTenantScope(c.tenant.id, null);

async function usageRow(c: Company) {
  const [row] = await fx.query<{
    management_usage_read_at: Date | null;
    management_usage_percent: number | null;
    management_paused_until: Date | null;
  }>(
    `SELECT management_usage_read_at, management_usage_percent, management_paused_until
       FROM app.whatsapp_accounts WHERE id = $1`,
    [c.whatsappAccountId],
  );
  return row!;
}

/** Graph requests the stand-in received for the company's WABA or its number since `from`. */
const requestsFor = (c: Company, from: number) =>
  fx.standIn.state.requests
    .slice(from)
    .filter((r) => r.path.includes(c.wabaId) || r.path.includes(c.phoneNumberId));

async function pause(c: Company, minutes: number) {
  fx.standIn.state.usageHeader = usageHeaderValue({
    [c.wabaId]: { callCount: 100, regainMinutes: minutes },
  });
  expect(await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
  fx.standIn.state.usageHeader = null;
  const row = await usageRow(c);
  expect(row.management_paused_until).not.toBeNull();
  return row.management_paused_until!;
}

describe('readings', () => {
  it('stores the reading for the account the call was made for, in its company only', async () => {
    const a = await fx.company();
    const b = await fx.company();
    fx.standIn.state.usageHeader = usageHeaderValue({
      [a.wabaId]: { callCount: 12, totalCputime: 41, totalTime: 30 },
    });
    const before = Date.now();
    expect(await syncTemplates(workerDeps(), scopeOf(a), a.whatsappAccountId)).toBe('done');
    const row = await usageRow(a);
    expect(row.management_usage_percent).toBe(41);
    expect(row.management_usage_read_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.management_paused_until).toBeNull();
    expect(await usageRow(b)).toEqual({
      management_usage_read_at: null,
      management_usage_percent: null,
      management_paused_until: null,
    });
  });

  it('ignores a header naming another WABA, even one of another company', async () => {
    const a = await fx.company();
    const b = await fx.company();
    // B's call answered with a reading for A's WABA (and one for an unknown WABA).
    fx.standIn.state.usageHeader = usageHeaderValue({
      [a.wabaId]: { callCount: 100, regainMinutes: 30 },
      '999999999999999': { callCount: 100, regainMinutes: 30 },
    });
    expect(await syncTemplates(workerDeps(), scopeOf(b), b.whatsappAccountId)).toBe('done');
    for (const c of [a, b]) {
      expect((await usageRow(c)).management_usage_read_at).toBeNull();
    }
  });

  it('keeps a call working, and stores nothing, with a malformed header', async () => {
    const c = await fx.company();
    for (const value of ['{oops', '[]', '{"1":"x"}', 'x'.repeat(20_000)]) {
      fx.standIn.state.usageHeader = value;
      expect(await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
    }
    expect((await usageRow(c)).management_usage_read_at).toBeNull();
  });

  it('stores the reading a refused call carries, and the refusal is handled as before', async () => {
    const c = await fx.company();
    fx.standIn.state.subscribedAppsErrors.set(c.wabaId, {
      status: 400,
      code: 80007,
      message: 'Rate limit hit',
    });
    fx.standIn.state.usageHeader = usageHeaderValue({ [c.wabaId]: { totalTime: 88 } });
    const result = await checkWhatsAppAccess(
      {
        db: fx.dbs.app,
        keyring: fx.keyring,
        graph: fx.graph,
        clock: systemClock,
        meta: { appId: APP_ID, appSecret: APP_SECRET },
        notices: {
          outbox: { keyring: fx.keyring, jobs: fx.jobs(), signer: fx.signer },
          appBaseUrl: 'https://app.w360.test',
        },
      },
      scopeOf(c),
      c.whatsappAccountId,
    );
    fx.standIn.state.subscribedAppsErrors.delete(c.wabaId);
    expect(result).toMatchObject({ outcome: 'healthy', webhooks: { state: 'not_checked' } });
    expect((await usageRow(c)).management_usage_percent).toBe(88);
  });
});

describe('a paused account', () => {
  it('asks Graph nothing in its next sync once a response paused it', async () => {
    const c = await fx.company();
    const until = await pause(c, 5);
    expect(until.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);

    const from = fx.standIn.state.requests.length;
    expect(await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId)).toEqual({
      paused: until,
    });
    expect(requestsFor(c, from)).toEqual([]);
  });

  it('is left out of the sweep’s template syncs and access checks until the pause ends', async () => {
    const c = await fx.company();
    await templates.requestSync(await fx.ctx(c, c.owner), c.whatsappAccountId);
    expect((await findTemplateSyncsDue(fx.dbs.app, 500)).map((d) => d.whatsappAccountId)).toContain(
      c.whatsappAccountId,
    );
    await pause(c, 5);
    // Asked again (the reading came from the sync); the pause keeps it out of both lists.
    await fx.query(
      `UPDATE app.whatsapp_accounts SET templates_sync_requested_at = now(), token_checked_at = NULL
        WHERE id = $1`,
      [c.whatsappAccountId],
    );
    expect(
      (await findTemplateSyncsDue(fx.dbs.app, 500)).map((d) => d.whatsappAccountId),
    ).not.toContain(c.whatsappAccountId);
    expect(
      (await findAccessChecksDue(fx.dbs.app, 500)).map((d) => d.whatsappAccountId),
    ).not.toContain(c.whatsappAccountId);
    // The pause ends: both lists have it again.
    await fx.query(
      `UPDATE app.whatsapp_accounts SET management_paused_until = now() - interval '1 second'
        WHERE id = $1`,
      [c.whatsappAccountId],
    );
    expect((await findTemplateSyncsDue(fx.dbs.app, 500)).map((d) => d.whatsappAccountId)).toContain(
      c.whatsappAccountId,
    );
    expect((await findAccessChecksDue(fx.dbs.app, 500)).map((d) => d.whatsappAccountId)).toContain(
      c.whatsappAccountId,
    );
  });

  it('defers a queued submission without calling Graph and queues it for just after the pause', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { id } = await templates.createDraft(owner, {
      whatsappAccountId: c.whatsappAccountId,
      name: 'paced_submit',
      language: 'en',
      definition: {
        category: 'UTILITY',
        header: { type: 'none' },
        body: { text: 'Your order {{1}} has shipped.', examples: ['A-1'] },
        footer: null,
        buttons: [],
      },
    });
    await templates.submitTemplate(owner, id);
    // The pause starts after the submission was queued.
    const until = await pause(c, 3);
    const from = fx.standIn.state.requests.length;
    const outcome = await processTemplateSubmit(workerDeps(), scopeOf(c), id);
    expect(outcome).toEqual({ paused: until });
    expect(requestsFor(c, from)).toEqual([]);
    const [row] = await fx.query<{ status: string; submit_error: string | null }>(
      'SELECT status, submit_error FROM app.message_templates WHERE id = $1',
      [id],
    );
    expect(row).toEqual({ status: 'submitting', submit_error: null });

    // What the worker does with it: the job again, signed as before, for just after the pause.
    const resumeAt = await deferPausedJob(
      { jobs: fx.jobs(), signer: fx.signer },
      QUEUES.templateSubmit.name,
      { kind: 'template.submit', tenantId: c.tenant.id, actorUserId: c.owner.id, ref: id },
      until,
    );
    expect(resumeAt.getTime()).toBe(until.getTime() + MANAGEMENT_RESUME_MARGIN_MS);
    const jobs = await fx.query<{ start_after: Date; data: { ref: string; tenantId: string } }>(
      `SELECT start_after, data FROM pgboss.job WHERE name = $1 AND singleton_key = $2`,
      [QUEUES.templateSubmit.name, `paused:${id}:${resumeAt.getTime()}`],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.start_after.getTime()).toBe(resumeAt.getTime());
    expect(jobs[0]!.data).toMatchObject({ ref: id, tenantId: c.tenant.id });
  });

  it('tells a member Meta is limiting management requests, and queues nothing', async () => {
    const c = await fx.company();
    const until = await pause(c, 10);
    const owner = await fx.ctx(c, c.owner);
    const [{ n: queuedBefore }] = (await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND data->>'ref' = $2`,
      [QUEUES.templateSync.name, c.whatsappAccountId],
    )) as [{ n: number }];
    try {
      await templates.requestSync(owner, c.whatsappAccountId);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isAppError(error), String(error)).toBe(true);
      if (!isAppError(error)) return;
      expect(error.code).toBe('provider_unavailable');
      expect(error.publicMessage).toMatch(
        /^Meta is limiting management requests for this WhatsApp account until /,
      );
      expect(error.details).toEqual({ pausedUntil: until.toISOString() });
    }
    const [{ n: queuedAfter }] = (await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND data->>'ref' = $2`,
      [QUEUES.templateSync.name, c.whatsappAccountId],
    )) as [{ n: number }];
    expect(queuedAfter).toBe(queuedBefore);
  });

  it('shows the reading on Channels, and the pause while it lasts', async () => {
    const c = await fx.company();
    const until = await pause(c, 4);
    const service = createOnboardingService({
      db: fx.dbs.app,
      keyring: fx.keyring,
      jobs: fx.jobs(),
      signer: fx.signer,
      clock: systemClock,
      graph: fx.graph,
      meta: {
        appId: APP_ID,
        appSecret: APP_SECRET,
        webhookSecrets: [APP_SECRET],
        graphApiVersion: 'v26.0',
        graphBaseUrl: fx.standIn.baseUrl,
        webhookVerifyToken: 'verify',
        embeddedSignupConfigId: '777',
      },
    });
    const [channel] = await service.listChannels(await fx.ctx(c, c.owner));
    expect(channel?.managementUsage).toMatchObject({
      percent: 100,
      pausedUntil: until.toISOString(),
    });
  });
});

describe('number setup (with ADR-398’s second health read)', () => {
  it('makes no second, field-less health read once the first response pauses the account', async () => {
    const c = await fx.company();
    fx.standIn.state.numbers.set(c.phoneNumberId, {
      display_phone_number: '+91 98765 00000',
      verified_name: 'Paced Traders',
    });
    await fx.query(
      `UPDATE app.channel_accounts SET status = 'onboarding', onboarding_step = 'health_check'
        WHERE id = $1`,
      [c.channelAccountId],
    );
    const deps = { db: fx.dbs.app, keyring: fx.keyring, graph: fx.graph, clock: systemClock };
    // Meta refuses the limit field (which would ask for the read without it) and pauses the account.
    fx.standIn.state.messagingLimitError = { status: 400, code: 100, message: 'nonexisting field' };
    fx.standIn.state.usageHeader = usageHeaderValue({
      [c.wabaId]: { callCount: 100, regainMinutes: 6 },
    });
    try {
      const from = fx.standIn.state.requests.length;
      const outcome = await processChannelOnboarding(deps, scopeOf(c), c.channelAccountId);
      const until = (await usageRow(c)).management_paused_until;
      expect(until).not.toBeNull();
      expect(outcome).toEqual({ paused: until });
      // Only the first read, with the limit, reached Graph.
      const reads = requestsFor(c, from).filter((r) => r.path.endsWith(`/${c.phoneNumberId}`));
      expect(reads).toHaveLength(1);
      expect(reads[0]!.query.fields).toContain('whatsapp_business_manager_messaging_limit');
      const [channel] = await fx.query<{ status: string; onboarding_step: string }>(
        'SELECT status, onboarding_step FROM app.channel_accounts WHERE id = $1',
        [c.channelAccountId],
      );
      expect(channel).toEqual({ status: 'onboarding', onboarding_step: 'health_check' });

      // While paused, the deferred step asks nothing at all.
      const later = fx.standIn.state.requests.length;
      expect(await processChannelOnboarding(deps, scopeOf(c), c.channelAccountId)).toEqual({
        paused: until,
      });
      expect(requestsFor(c, later)).toEqual([]);
    } finally {
      fx.standIn.state.messagingLimitError = null;
    }
  });
});

describe('privileges (migration 0310)', () => {
  it('lets the application write readings, and the definer read only the pause', async () => {
    const privileges = async (grantee: string, type: string) =>
      (
        await fx.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.column_privileges
            WHERE grantee = $1 AND table_schema = 'app' AND table_name = 'whatsapp_accounts'
              AND privilege_type = $2 AND column_name LIKE 'management_%'
            ORDER BY column_name`,
          [grantee, type],
        )
      ).map((r) => r.column_name);
    expect(await privileges('w360_app', 'UPDATE')).toEqual([
      'management_paused_until',
      'management_usage_percent',
      'management_usage_read_at',
    ]);
    expect(await privileges('w360_definer', 'SELECT')).toEqual(['management_paused_until']);
    expect(await privileges('w360_definer', 'UPDATE')).toEqual([]);
    expect(await privileges('w360_platform', 'UPDATE')).toEqual([]);
  });

  it('keeps the due lists definer functions only the application may run', async () => {
    for (const fn of [
      'ops.template_sync_due(integer)',
      'ops.whatsapp_access_checks_due(integer)',
      'ops.flow_work_due(integer)',
      'ops.commerce_work_due(integer)',
    ]) {
      const [config] = await fx.query<{ owner: string; secdef: boolean; config: string[] }>(
        `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, p.proconfig AS config
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [fn],
      );
      expect(config, fn).toEqual({
        owner: 'w360_definer',
        secdef: true,
        config: ['search_path=pg_catalog, pg_temp'],
      });
      for (const [role, allowed] of [
        ['w360_app', true],
        ['w360_platform', false],
        ['public', false],
      ] as const) {
        const [row] = await fx.query<{ ok: boolean }>(
          `SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`,
          [role, fn],
        );
        expect(row!.ok, `${role} ${fn}`).toBe(allowed);
      }
    }
  });
});
