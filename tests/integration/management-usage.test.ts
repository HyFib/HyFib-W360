import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7, type Clock } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import { authorizedTenantScope } from '@w360/db';
import {
  MANAGEMENT_RESUME_MARGIN_MS,
  checkWhatsAppAccess,
  createOnboardingService,
  createTemplatesService,
  deferPausedJob,
  giveUpCommerceSync,
  giveUpFlowSync,
  pausedJobKey,
  processCommerceSync,
  processFlowSync,
  processTemplateDelete,
  STARTER_FLOW_JSON,
  createCommerceService,
  createFlowsService,
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

const workerDeps = (clock: Clock = systemClock) => ({
  db: fx.dbs.app,
  keyring: fx.keyring,
  graph: fx.graph,
  clock,
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

/**
 * What the sweep's due lists give for these companies only. Other test files' rows are made not
 * due inside a transaction that is rolled back (as `dueAmong` in whatsapp-access.test.ts does), so
 * neither a list's limit nor the run order can hide these companies' rows, and a row missing from
 * a list is missing because the list leaves it out.
 */
async function dueFor(companies: Company[]) {
  const client = await fx.dbs.adminPool.connect();
  try {
    await client.query('BEGIN');
    const others = [companies.map((c) => c.tenant.id)];
    await client.query(
      `UPDATE app.whatsapp_accounts SET templates_synced_at = now(),
              templates_sync_requested_at = NULL, token_checked_at = now(),
              token_check_attempted_at = now(), token_check_requested_at = NULL
        WHERE NOT (tenant_id = ANY($1::uuid[]))`,
      others,
    );
    await client.query(
      `UPDATE app.flows SET sync_state = 'failed'
        WHERE sync_state IN ('queued', 'running') AND NOT (tenant_id = ANY($1::uuid[]))`,
      others,
    );
    await client.query(
      `UPDATE app.commerce_syncs SET state = 'idle', finished_at = now()
        WHERE NOT (tenant_id = ANY($1::uuid[]))`,
      others,
    );
    const ids = async (text: string) =>
      (await client.query<{ id: string }>(text)).rows.map((r) => r.id);
    return {
      templateSyncs: await ids('SELECT whatsapp_account_id AS id FROM ops.template_sync_due(500)'),
      accessChecks: await ids(
        'SELECT whatsapp_account_id AS id FROM ops.whatsapp_access_checks_due(500)',
      ),
      flows: await ids(`SELECT ref AS id FROM ops.flow_work_due(500) WHERE kind = 'sync'`),
      reads: await ids(`SELECT ref AS id FROM ops.commerce_work_due(500) WHERE kind = 'sync'`),
    };
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

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
    // Node's HTTP client refuses a response whose headers reach 16 KiB before the parser sees them
    // (as before ADR-399), so the long value here stays well under it.
    for (const value of ['{oops', '[]', '{"1":"x"}', 'x'.repeat(4_000)]) {
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
    expect((await dueFor([c])).templateSyncs).toContain(c.whatsappAccountId);
    await pause(c, 5);
    // Asked again (the reading came from the sync); the pause keeps it out of both lists.
    await fx.query(
      `UPDATE app.whatsapp_accounts SET templates_sync_requested_at = now(), token_checked_at = NULL
        WHERE id = $1`,
      [c.whatsappAccountId],
    );
    let due = await dueFor([c]);
    expect(due.templateSyncs).not.toContain(c.whatsappAccountId);
    expect(due.accessChecks).not.toContain(c.whatsappAccountId);
    // The pause ends: both lists have it again.
    await fx.query(
      `UPDATE app.whatsapp_accounts SET management_paused_until = now() - interval '1 second'
        WHERE id = $1`,
      [c.whatsappAccountId],
    );
    due = await dueFor([c]);
    expect(due.templateSyncs).toContain(c.whatsappAccountId);
    expect(due.accessChecks).toContain(c.whatsappAccountId);
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

    // What the worker does with it: the job again, signed as before, for just after the pause,
    // keyed by the deferring job's id (a retry of that job queues nothing more).
    const deferringJobId = uuidv7();
    const defer = () =>
      deferPausedJob(
        { jobs: fx.jobs(), signer: fx.signer, clock: systemClock },
        QUEUES.templateSubmit.name,
        { kind: 'template.submit', tenantId: c.tenant.id, actorUserId: c.owner.id, ref: id },
        until,
        deferringJobId,
      );
    const resumeAt = await defer();
    const due = until.getTime() + MANAGEMENT_RESUME_MARGIN_MS;
    // Whole seconds from now: within a second of 30 seconds after the pause.
    expect(Math.abs(resumeAt!.getTime() - due)).toBeLessThan(1_000);
    expect(await defer()).toBeNull();
    const jobs = await fx.query<{ start_after: Date; data: { ref: string; tenantId: string } }>(
      `SELECT start_after, data FROM pgboss.job WHERE name = $1 AND singleton_key = $2`,
      [QUEUES.templateSubmit.name, pausedJobKey(deferringJobId)],
    );
    expect(jobs).toHaveLength(1);
    // pg-boss adds the delay to the database's now (same machine here: a few seconds at most).
    expect(Math.abs(jobs[0]!.start_after.getTime() - due)).toBeLessThan(5_000);
    expect(jobs[0]!.data).toMatchObject({ ref: id, tenantId: c.tenant.id });
    // The row says when its deferred job runs, so the sync's window counts from then.
    const [deferred] = await fx.query<{ management_deferred_until: Date }>(
      'SELECT management_deferred_until FROM app.message_templates WHERE id = $1',
      [id],
    );
    expect(deferred!.management_deferred_until.getTime()).toBe(due);
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

const at = (time: Date): Clock => ({ now: () => new Date(time) });
const plus = (time: Date, ms: number) => new Date(time.getTime() + ms);
const flowsService = () =>
  createFlowsService({
    db: fx.dbs.app,
    clock: systemClock,
    jobs: fx.jobs(),
    signer: fx.signer,
    appBaseUrl: 'https://app.example.test',
    allowInsecureHttp: true,
  });
const flowDeps = (clock: Clock = systemClock) => ({
  ...workerDeps(clock),
  appBaseUrl: 'https://app.example.test',
});
const commerceService = () =>
  createCommerceService({
    db: fx.dbs.app,
    clock: systemClock,
    jobs: fx.jobs(),
    signer: fx.signer,
    keyring: fx.keyring,
    appBaseUrl: 'https://app.example.test',
    allowLiveKeys: false,
  });
const commerceDeps = (clock: Clock = systemClock) => ({
  ...workerDeps(clock),
  razorpayBaseUrl: 'https://razorpay.invalid',
  jobs: fx.jobs(),
  signer: fx.signer,
});
const ROW_DRAFT = {
  category: 'UTILITY' as const,
  header: { type: 'none' as const },
  body: { text: 'Your parcel {{1}} is out for delivery.', examples: ['P-1'] },
  footer: null,
  buttons: [],
};

async function templateState(id: string) {
  const [row] = await fx.query<{ status: string; submit_error: string | null }>(
    'SELECT status, submit_error FROM app.message_templates WHERE id = $1',
    [id],
  );
  return row!;
}

describe('time deferred for a pause does not count against a request', () => {
  it('keeps a submission deferred past the 10-minute window submitting, and submits it after the pause', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { id } = await templates.createDraft(owner, {
      whatsappAccountId: c.whatsappAccountId,
      name: 'paced_long_submit',
      language: 'en',
      definition: ROW_DRAFT,
    });
    await templates.submitTemplate(owner, id);
    const until = await pause(c, 15);
    expect(await processTemplateSubmit(workerDeps(), scopeOf(c), id)).toEqual({ paused: until });
    // The pause has ended; a sync runs before the deferred submission, more than 10 minutes after
    // the template was submitted. Meta has no record of it, which is right: it was never sent.
    expect(
      await syncTemplates(workerDeps(at(plus(until, 10_000))), scopeOf(c), c.whatsappAccountId),
    ).toBe('done');
    expect(await templateState(id)).toEqual({ status: 'submitting', submit_error: null });
    // The deferred job runs and submits it.
    expect(await processTemplateSubmit(workerDeps(at(plus(until, 31_000))), scopeOf(c), id)).toBe(
      'done',
    );
    expect((await templateState(id)).status).toBe('pending');
  });

  it('keeps a deletion deferred past the 8-hour keep pending, and deletes it after the pause', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { id } = await templates.createDraft(owner, {
      whatsappAccountId: c.whatsappAccountId,
      name: 'paced_long_delete',
      language: 'en',
      definition: ROW_DRAFT,
    });
    await templates.submitTemplate(owner, id);
    expect(await processTemplateSubmit(workerDeps(), scopeOf(c), id)).toBe('done');
    const t = fx.standIn.state.templates
      .get(c.wabaId)!
      .find((x) => x.name === 'paced_long_delete')!;
    t.status = 'APPROVED';
    expect(await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
    await templates.deleteTemplate(owner, id);
    const until = await pause(c, 9 * 60);
    expect(await processTemplateDelete(workerDeps(), scopeOf(c), id)).toEqual({ paused: until });
    // Nine hours on, Meta still lists it (the request was never sent): the deletion stays pending.
    expect(
      await syncTemplates(workerDeps(at(plus(until, 10_000))), scopeOf(c), c.whatsappAccountId),
    ).toBe('done');
    expect((await templateState(id)).status).toBe('pending_deletion');
    expect(await processTemplateDelete(workerDeps(at(plus(until, 31_000))), scopeOf(c), id)).toBe(
      'done',
    );
    expect((await templateState(id)).status).toBe('deleted');
  });

  it('gives up on a flow operation or catalog read only 30 minutes after its deferred job ran', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { id: flowId } = await flowsService().create(owner, {
      whatsappAccountId: c.whatsappAccountId,
      name: 'Paced survey',
      categories: ['SURVEY'],
      json: STARTER_FLOW_JSON,
    });
    const { id: otherFlow } = await flowsService().create(await fx.ctx(other, other.owner), {
      whatsappAccountId: other.whatsappAccountId,
      name: 'Unpaced survey',
      categories: ['SURVEY'],
      json: STARTER_FLOW_JSON,
    });
    await commerceService().requestSync(owner, { whatsappAccountId: c.whatsappAccountId });
    const until = await pause(c, 40);
    expect(await processFlowSync(flowDeps(), scopeOf(c), flowId)).toEqual({ paused: until });
    expect(await processCommerceSync(commerceDeps(), scopeOf(c), c.whatsappAccountId)).toEqual({
      paused: until,
    });
    // Both requests look lost to the sweep (asked more than 2 and 5 minutes ago).
    await fx.query(
      `UPDATE app.flows SET sync_requested_at = now() - interval '10 minutes' WHERE id = ANY($1)`,
      [[flowId, otherFlow]],
    );
    await fx.query(
      `UPDATE app.commerce_syncs SET requested_at = now() - interval '10 minutes'
        WHERE whatsapp_account_id = $1`,
      [c.whatsappAccountId],
    );
    // The paused account's work is not listed; the other company's flow is.
    const due = await dueFor([c, other]);
    expect(due.flows).toContain(otherFlow);
    expect(due.flows).not.toContain(flowId);
    expect(due.reads).not.toContain(c.whatsappAccountId);
    // A minute after the pause, 41 minutes after the requests: neither is given up.
    const after = at(plus(until, 60_000));
    await giveUpFlowSync({ db: fx.dbs.app, clock: after }, scopeOf(c), flowId);
    await giveUpCommerceSync({ db: fx.dbs.app, clock: after }, scopeOf(c), c.whatsappAccountId);
    const [flow] = await fx.query<{ sync_state: string }>(
      'SELECT sync_state FROM app.flows WHERE id = $1',
      [flowId],
    );
    expect(flow!.sync_state).not.toBe('failed');
    const [read] = await fx.query<{ state: string }>(
      'SELECT state FROM app.commerce_syncs WHERE whatsapp_account_id = $1',
      [c.whatsappAccountId],
    );
    expect(read!.state).not.toBe('failed');
    // 30 minutes after the deferred jobs were due, the existing give-up applies.
    const late = at(plus(until, 31 * 60_000 + 30_000));
    await giveUpFlowSync({ db: fx.dbs.app, clock: late }, scopeOf(c), flowId);
    await giveUpCommerceSync({ db: fx.dbs.app, clock: late }, scopeOf(c), c.whatsappAccountId);
    expect(
      (
        await fx.query<{ sync_state: string }>('SELECT sync_state FROM app.flows WHERE id = $1', [
          flowId,
        ])
      )[0]!.sync_state,
    ).toBe('failed');
    const [lateRead] = await fx.query<{ state: string }>(
      'SELECT state FROM app.commerce_syncs WHERE whatsapp_account_id = $1',
      [c.whatsappAccountId],
    );
    expect(lateRead!.state).toBe('failed');
  });

  it('hides deferred work from the due lists until its job runs, and a newer request clears it', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { id: flowId } = await flowsService().create(owner, {
      whatsappAccountId: c.whatsappAccountId,
      name: 'Deferred survey',
      categories: ['SURVEY'],
      json: STARTER_FLOW_JSON,
    });
    await commerceService().requestSync(owner, { whatsappAccountId: c.whatsappAccountId });
    await pause(c, 20);
    expect(await processFlowSync(flowDeps(), scopeOf(c), flowId)).toMatchObject({
      paused: expect.any(Date),
    });
    expect(
      await processCommerceSync(commerceDeps(), scopeOf(c), c.whatsappAccountId),
    ).toMatchObject({ paused: expect.any(Date) });
    // Meta ends the pause early (the account is no longer paused); the deferred jobs are still due
    // in about 20 minutes, and both requests look lost to the sweep.
    await fx.query(
      `UPDATE app.whatsapp_accounts SET management_paused_until = NULL WHERE id = $1`,
      [c.whatsappAccountId],
    );
    await fx.query(
      `UPDATE app.flows SET sync_requested_at = now() - interval '10 minutes' WHERE id = $1`,
      [flowId],
    );
    await fx.query(
      `UPDATE app.commerce_syncs SET requested_at = now() - interval '10 minutes'
        WHERE whatsapp_account_id = $1`,
      [c.whatsappAccountId],
    );
    const listed = () => dueFor([c]);
    let due = await listed();
    expect(due.flows).not.toContain(flowId);
    expect(due.reads).not.toContain(c.whatsappAccountId);

    // Once the deferred jobs were due, the sweep lists them again.
    await fx.query(
      `UPDATE app.flows SET management_deferred_until = now() - interval '1 second' WHERE id = $1`,
      [flowId],
    );
    await fx.query(
      `UPDATE app.commerce_syncs SET management_deferred_until = now() - interval '1 second'
        WHERE whatsapp_account_id = $1`,
      [c.whatsappAccountId],
    );
    due = await listed();
    expect(due.flows).toContain(flowId);
    expect(due.reads).toContain(c.whatsappAccountId);

    // A newer request clears the deferral it would otherwise wait behind: the pause ends early,
    // the operation and the read fail, and the member asks again while the old deferral time is
    // still ahead.
    await fx.query(
      `UPDATE app.flows SET management_deferred_until = now() + interval '20 minutes',
              sync_state = 'failed' WHERE id = $1`,
      [flowId],
    );
    await fx.query(
      `UPDATE app.commerce_syncs SET management_deferred_until = now() + interval '20 minutes',
              state = 'failed' WHERE whatsapp_account_id = $1`,
      [c.whatsappAccountId],
    );
    const [failed] = await fx.query<{ version: number }>(
      'SELECT version FROM app.flows WHERE id = $1',
      [flowId],
    );
    await flowsService().retry(owner, { id: flowId, expectedVersion: failed!.version });
    await commerceService().requestSync(owner, { whatsappAccountId: c.whatsappAccountId });
    const [flowRow] = await fx.query<{ management_deferred_until: Date | null }>(
      'SELECT management_deferred_until FROM app.flows WHERE id = $1',
      [flowId],
    );
    const [readRow] = await fx.query<{ management_deferred_until: Date | null }>(
      'SELECT management_deferred_until FROM app.commerce_syncs WHERE whatsapp_account_id = $1',
      [c.whatsappAccountId],
    );
    expect(flowRow!.management_deferred_until).toBeNull();
    expect(readRow!.management_deferred_until).toBeNull();
    // Should their jobs be lost, the sweep lists them as soon as they look lost, not in 20 minutes.
    await fx.query(
      `UPDATE app.flows SET sync_requested_at = now() - interval '10 minutes' WHERE id = $1`,
      [flowId],
    );
    await fx.query(
      `UPDATE app.commerce_syncs SET requested_at = now() - interval '10 minutes'
        WHERE whatsapp_account_id = $1`,
      [c.whatsappAccountId],
    );
    due = await listed();
    expect(due.flows).toContain(flowId);
    expect(due.reads).toContain(c.whatsappAccountId);
  });
});

describe('a refusal whose own response pauses the account', () => {
  const RATE_LIMITED = { status: 400, code: 80007, message: 'Rate limit hit' };
  const pausing = (c: Company) =>
    usageHeaderValue({ [c.wabaId]: { callCount: 100, regainMinutes: 5 } });

  it('defers a submission and a deletion instead of spending a retry or recording a failure', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { id } = await templates.createDraft(owner, {
      whatsappAccountId: c.whatsappAccountId,
      name: 'paced_refused_submit',
      language: 'en',
      definition: ROW_DRAFT,
    });
    await templates.submitTemplate(owner, id);
    fx.standIn.state.templateCreateQueue.push({ kind: 'error', ...RATE_LIMITED });
    fx.standIn.state.usageHeader = pausing(c);
    const submitted = await processTemplateSubmit(workerDeps(), scopeOf(c), id);
    fx.standIn.state.usageHeader = null;
    expect(submitted).toEqual({ paused: (await usageRow(c)).management_paused_until });
    expect(await templateState(id)).toEqual({ status: 'submitting', submit_error: null });

    // A deletion refused for now, with the pause: no delete_failed, still pending.
    const d = await fx.company();
    const dOwner = await fx.ctx(d, d.owner);
    const { id: tid } = await templates.createDraft(dOwner, {
      whatsappAccountId: d.whatsappAccountId,
      name: 'paced_refused_delete',
      language: 'en',
      definition: ROW_DRAFT,
    });
    await templates.submitTemplate(dOwner, tid);
    expect(await processTemplateSubmit(workerDeps(), scopeOf(d), tid)).toBe('done');
    await templates.deleteTemplate(dOwner, tid);
    fx.standIn.state.templateDeleteError = RATE_LIMITED;
    fx.standIn.state.usageHeader = pausing(d);
    try {
      expect(await processTemplateDelete(workerDeps(), scopeOf(d), tid)).toEqual({
        paused: (await usageRow(d)).management_paused_until,
      });
    } finally {
      fx.standIn.state.templateDeleteError = null;
      fx.standIn.state.usageHeader = null;
    }
    expect((await templateState(tid)).status).toBe('pending_deletion');
    const failures = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.template_status_events
        WHERE template_id = $1 AND status = 'delete_failed'`,
      [tid],
    );
    expect(failures[0]!.n).toBe(0);
    // The deferral is live work for the dead-letter sweep (0089, recreated in 0310).
    await deferPausedJob(
      { jobs: fx.jobs(), signer: fx.signer, clock: systemClock },
      QUEUES.templateDelete.name,
      { kind: 'template.delete', tenantId: d.tenant.id, actorUserId: null, ref: tid },
      (await usageRow(d)).management_paused_until!,
      uuidv7(),
    );
    const [live] = await fx.query<{ live: boolean }>(
      `SELECT ops.dead_letter_work_live('template.delete', $1) AS live`,
      [tid],
    );
    expect(live!.live).toBe(true);
  });

  it('defers a catalog read and a setup step instead of retrying them, and stops a flow operation', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const { id: flowId } = await flowsService().create(owner, {
      whatsappAccountId: c.whatsappAccountId,
      name: 'Refused survey',
      categories: ['SURVEY'],
      json: STARTER_FLOW_JSON,
    });
    // The operation's first call (looking for a flow an earlier attempt made) pauses the account,
    // so the create is not sent and the operation waits, not failed.
    fx.standIn.state.usageHeader = pausing(c);
    const flowOutcome = await processFlowSync(flowDeps(), scopeOf(c), flowId);
    fx.standIn.state.usageHeader = null;
    expect(flowOutcome).toEqual({ paused: (await usageRow(c)).management_paused_until });
    const [flow] = await fx.query<{ sync_state: string; sync_error: string | null }>(
      'SELECT sync_state, sync_error FROM app.flows WHERE id = $1',
      [flowId],
    );
    expect(flow).toEqual({ sync_state: 'running', sync_error: null });

    const k = await fx.company();
    await commerceService().requestSync(await fx.ctx(k, k.owner), {
      whatsappAccountId: k.whatsappAccountId,
    });
    fx.standIn.state.catalogError = RATE_LIMITED;
    fx.standIn.state.usageHeader = pausing(k);
    try {
      expect(await processCommerceSync(commerceDeps(), scopeOf(k), k.whatsappAccountId)).toEqual({
        paused: (await usageRow(k)).management_paused_until,
      });
    } finally {
      fx.standIn.state.catalogError = null;
      fx.standIn.state.usageHeader = null;
    }

    const n = await fx.company();
    // Subscribing is refused for now with the pause: the step stays, nothing fails.
    await fx.query(
      `UPDATE app.channel_accounts SET status = 'onboarding', onboarding_step = 'subscribe_app'
        WHERE id = $1`,
      [n.channelAccountId],
    );
    fx.standIn.state.subscribeErrors.set(n.wabaId, RATE_LIMITED);
    fx.standIn.state.usageHeader = pausing(n);
    try {
      expect(
        await processChannelOnboarding(
          { db: fx.dbs.app, keyring: fx.keyring, graph: fx.graph, clock: systemClock },
          scopeOf(n),
          n.channelAccountId,
        ),
      ).toEqual({ paused: (await usageRow(n)).management_paused_until });
    } finally {
      fx.standIn.state.subscribeErrors.delete(n.wabaId);
      fx.standIn.state.usageHeader = null;
    }
    const [channel] = await fx.query<{ status: string; onboarding_step: string }>(
      'SELECT status, onboarding_step FROM app.channel_accounts WHERE id = $1',
      [n.channelAccountId],
    );
    expect(channel).toEqual({ status: 'onboarding', onboarding_step: 'subscribe_app' });
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

    // Deferral times: written by the application on all three tables, read by the definer's due
    // lists on flows and catalog reads only.
    const deferredGrantees = async (type: string) =>
      (
        await fx.query<{ grantee: string; table_name: string }>(
          `SELECT grantee, table_name FROM information_schema.column_privileges
            WHERE table_schema = 'app' AND column_name = 'management_deferred_until'
              AND privilege_type = $1 AND grantee IN ('w360_app', 'w360_definer', 'w360_platform')
            ORDER BY grantee, table_name`,
          [type],
        )
      ).map((r) => `${r.grantee} ${r.table_name}`);
    expect(await deferredGrantees('UPDATE')).toEqual([
      'w360_app commerce_syncs',
      'w360_app flows',
      'w360_app message_templates',
    ]);
    // w360_app reads these tables through its table-level SELECT; the definer only these two.
    expect((await deferredGrantees('SELECT')).filter((g) => g.startsWith('w360_definer '))).toEqual(
      ['w360_definer commerce_syncs', 'w360_definer flows'],
    );
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
