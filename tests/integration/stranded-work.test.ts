import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7, type Clock, type MetaConfig } from '@w360/core';
import { authorizedTenantScope, sql, systemScope, type TenantScope } from '@w360/db';
import {
  createCommerceService,
  createOnboardingService,
  createPlatformOpsService,
  createTemplatesService,
  findStrandedWork,
  pgBossQueueInspector,
  processTemplateDelete,
  processTemplateSubmit,
  recordDeadLetters,
  settleDeadLetterWork,
  settleStrandedWork,
  syncTemplates,
  type PlatformActor,
  type StrandedWork,
  type TemplateDefinition,
} from '@w360/domain';
import { createTenant, createUser } from './helpers';
import {
  APP_ID,
  APP_SECRET,
  startWhatsAppFixture,
  type Company,
  type WhatsAppFixture,
} from './whatsapp-fixture';

/**
 * Work left in progress when its job ran out of retries (P5-10, ADR-111), against real PostgreSQL,
 * pg-boss and the Graph stand-in: the minute sweep ends a template deletion, a check of a company's
 * Razorpay keys and a number's setup in the company's own scope, marking the dead letter in the
 * same transaction; leaves a dead letter alone while a job for the same work waits or runs again;
 * settles only verified dead letters of these queues, of companies not being deleted, and never one
 * retried from the console, which in turn refuses a settled one; and the template sync keeps a
 * deletion that is still being tried.
 */
let fx: WhatsAppFixture;
let staff: PlatformActor;
/**
 * The dead letters this file makes. Failure alerts are platform-wide (ADR-091): they are marked as
 * told after the file, so that a later file's alert counts only its own.
 */
const made: string[] = [];
/** Jobs this file leaves waiting (no worker runs here), removed after the file. */
const queued: { queue: string; key: string }[] = [];
const REASON = 'Meta outage is over, ticket 4630';
const HOUR_MS = 3_600_000;

const deps = () => ({ db: fx.dbs.app, clock: systemClock });
const scopeOf = (c: Company): TenantScope => authorizedTenantScope(c.tenant.id, null);
const later = (ms: number): Clock => ({ now: () => new Date(Date.now() + ms) });
const workerDeps = (clock: Clock = systemClock) => ({
  db: fx.dbs.app,
  keyring: fx.keyring,
  graph: fx.graph,
  clock,
  jobs: fx.jobs(),
  signer: fx.signer,
});
const templates = () =>
  createTemplatesService({
    db: fx.dbs.app,
    jobs: fx.jobs(),
    signer: fx.signer,
    clock: systemClock,
  });
const commerce = () =>
  createCommerceService({
    db: fx.dbs.app,
    clock: systemClock,
    jobs: fx.jobs(),
    signer: fx.signer,
    keyring: fx.keyring,
    appBaseUrl: 'https://app.example.test',
    allowLiveKeys: false,
  });
const onboarding = () => {
  const meta: MetaConfig = {
    appId: APP_ID,
    appSecret: APP_SECRET,
    webhookSecrets: [APP_SECRET],
    graphApiVersion: 'v26.0',
    graphBaseUrl: fx.standIn.baseUrl,
    webhookVerifyToken: 'verify',
    embeddedSignupConfigId: '777',
  };
  return createOnboardingService({
    db: fx.dbs.app,
    keyring: fx.keyring,
    jobs: fx.jobs(),
    signer: fx.signer,
    clock: systemClock,
    graph: fx.graph,
    meta,
  });
};
const ops = () =>
  createPlatformOpsService({
    platformDb: fx.dbs.platform,
    queues: pgBossQueueInspector(fx.boss),
    clock: systemClock,
    keyring: fx.keyring,
  });

async function expectCode(promise: Promise<unknown>, code: string, message?: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe(code);
      if (message) expect(error.message).toMatch(message);
    }
    return;
  }
  throw new Error(`expected ${code}`);
}

const promo: TemplateDefinition = {
  category: 'MARKETING',
  header: { type: 'none' },
  body: { text: 'Hello {{1}}, our festive sale starts today.', examples: ['Asha'] },
  footer: null,
  buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions' }],
};

const template = async (id: string) =>
  (
    await fx.query<{ status: string; provider_status: string | null }>(
      `SELECT status, provider_status FROM app.message_templates WHERE id = $1`,
      [id],
    )
  )[0]!;

/** A template's latest status events, newest first, as its page lists them. */
const lastEvents = (id: string, n: number) =>
  fx.query<{ status: string; reason: string | null; source: string }>(
    `SELECT status, reason, source FROM app.template_status_events WHERE template_id = $1
      ORDER BY occurred_at DESC, id DESC LIMIT $2`,
    [id, n],
  );
const lastEvent = async (id: string) => (await lastEvents(id, 1))[0];

const letter = async (id: string) =>
  (
    await fx.query<{
      settled_at: Date | null;
      settled_ended: boolean | null;
      retried_at: Date | null;
    }>(`SELECT settled_at, settled_ended, retried_at FROM ops.dead_letters WHERE id = $1`, [id])
  )[0]!;

const audits = (tenantId: string, action: string) =>
  fx.query<{ subject_id: string; result: string; metadata: Record<string, unknown> }>(
    `SELECT subject_id, result, metadata FROM app.audit_events
      WHERE tenant_id = $1 AND action = $2 ORDER BY id`,
    [tenantId, action],
  );

/** A template Meta approved, through submission and a sync as in production. */
async function approvedTemplate(c: Company, name: string): Promise<string> {
  const owner = await fx.ctx(c, c.owner);
  const { id } = await templates().createDraft(owner, {
    whatsappAccountId: c.whatsappAccountId,
    name,
    language: 'en',
    definition: promo,
  });
  await templates().submitTemplate(owner, id);
  queued.push({ queue: 'template.submit', key: `${id}:%` });
  expect(await processTemplateSubmit(workerDeps(), scopeOf(c), id)).toBe('done');
  metaTemplate(c, name).status = 'APPROVED';
  await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId);
  expect((await template(id)).status).toBe('approved');
  return id;
}

const metaTemplate = (c: Company, name: string) =>
  fx.standIn.state.templates.get(c.wabaId)!.find((t) => t.name === name)!;

/** Asks for a template's deletion as a member does, which queues its job. */
async function askDeletion(c: Company, id: string) {
  await templates().deleteTemplate(await fx.ctx(c, c.marketer), id);
  queued.push({ queue: 'template.delete', key: `${id}:delete` });
  expect((await template(id)).status).toBe('pending_deletion');
}

/**
 * Ends the waiting job under a singleton key as pg-boss does after its last retry, and records its
 * dead letter from the job's own signed envelope, as the worker does.
 */
async function deadLetter(queue: string, keyLike: string, retries = 10): Promise<string> {
  const [job] = await fx.query<{ id: string; data: unknown; created_on: Date }>(
    `UPDATE pgboss.job SET state = 'failed', completed_on = now()
      WHERE name = $1 AND singleton_key LIKE $2 AND state IN ('created', 'retry', 'active')
      RETURNING id, data, created_on`,
    [queue, keyLike],
  );
  if (!job) throw new Error(`no waiting ${queue} job under ${keyLike}`);
  const id = uuidv7();
  const recorded = await recordDeadLetters({ db: fx.dbs.app, signer: fx.signer }, [
    {
      id,
      data: job.data,
      output: { name: 'GraphError', code: 'provider_unavailable' },
      sourceName: queue,
      sourceId: job.id,
      sourceCreatedOn: job.created_on,
      sourceRetryCount: retries,
      createdOn: new Date(),
    },
  ]);
  expect(recorded).toBe(1);
  made.push(id);
  return id;
}

/** A dead letter row as the worker records it, for the checks that need no pg-boss job. */
async function insertLetter(values: {
  queue: string;
  kind: string | null;
  tenantId: string | null;
  ref: string | null;
}): Promise<string> {
  const id = uuidv7();
  const verified = values.kind !== null;
  await fx.query(
    `INSERT INTO ops.dead_letters (id, source_queue, source_job_id, kind, tenant_id, ref, verified,
       retries, failed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 10, now())`,
    [id, values.queue, uuidv7(), values.kind, values.tenantId, values.ref, verified],
  );
  made.push(id);
  return id;
}

/** The sweep's lookup, narrowed to one dead letter. */
async function listed(deadLetterId: string): Promise<StrandedWork | undefined> {
  return (await findStrandedWork(fx.dbs.app, 500)).find((w) => w.deadLetterId === deadLetterId);
}

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  const user = await createUser(fx.dbs, { name: 'Stranded Work Staff', twoFactor: true });
  await fx.dbs.ownerPool.query(
    `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_operator')`,
    [user.id],
  );
  staff = { userId: user.id, role: 'platform_operator', correlationId: uuidv7() };
});

afterAll(async () => {
  await fx.query(
    `UPDATE ops.dead_letters SET alerted_at = now() WHERE alerted_at IS NULL AND id = ANY($1::uuid[])`,
    [made],
  );
  for (const { queue, key } of queued) {
    await fx.query(
      `DELETE FROM pgboss.job WHERE name = $1 AND singleton_key LIKE $2
        AND state IN ('created', 'retry', 'active')`,
      [queue, key],
    );
  }
  await fx.close();
});

describe('template deletions whose job ran out of retries (ADR-111)', () => {
  it("go back to Meta's last status with a delete_failed event, an audit entry and a sync request; the company can delete it again", async () => {
    const c = await fx.company();
    const id = await approvedTemplate(c, 'stranded_delete');
    await askDeletion(c, id);
    // Meta pauses the template while its deletion is tried: the sync keeps the deletion and
    // records Meta's status for when it ends.
    metaTemplate(c, 'stranded_delete').status = 'PAUSED';
    await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId);
    expect(await template(id)).toEqual({ status: 'pending_deletion', provider_status: 'PAUSED' });
    expect((await lastEvent(id))?.status).toBe('pending_deletion');

    const deadLetterId = await deadLetter('template.delete', `${id}:delete`);
    await fx.query(
      `UPDATE app.whatsapp_accounts SET templates_sync_requested_at = NULL WHERE id = $1`,
      [c.whatsappAccountId],
    );
    const work = await listed(deadLetterId);
    expect(work).toEqual({
      deadLetterId,
      queue: 'template.delete',
      tenantId: c.tenant.id,
      ref: id,
    });
    expect(await settleDeadLetterWork(deps(), work!)).toBe('ended');

    expect(await template(id)).toEqual({ status: 'paused', provider_status: 'PAUSED' });
    // A "Deletion failed" event, then one for the status it went back to, at the same time and
    // listed in that order on the template's page.
    const back = [
      { status: 'paused', reason: 'Back to the status Meta last reported.', source: 'delete' },
      {
        status: 'delete_failed',
        reason: 'Meta could not be reached to delete it after repeated attempts. Delete it again.',
        source: 'delete',
      },
    ];
    expect(await lastEvents(id, 2)).toEqual(back);
    const page = await templates().getTemplate(await fx.ctx(c, c.owner), id);
    expect(
      page.history
        .slice(0, 2)
        .map((h) => ({ status: h.status, reason: h.reason, source: h.source })),
    ).toEqual(back);
    expect(await audits(c.tenant.id, 'template.delete_failed')).toEqual([
      { subject_id: id, result: 'failure', metadata: { kind: 'retries_exhausted' } },
    ]);
    const [account] = await fx.query<{ requested: Date | null }>(
      `SELECT templates_sync_requested_at AS requested FROM app.whatsapp_accounts WHERE id = $1`,
      [c.whatsappAccountId],
    );
    expect(account?.requested).toBeInstanceOf(Date);
    expect(await letter(deadLetterId)).toEqual({
      settled_at: expect.any(Date),
      settled_ended: true,
      retried_at: null,
    });

    // Settled once: not listed again, and settling it again changes nothing.
    expect(await listed(deadLetterId)).toBeUndefined();
    expect(await settleDeadLetterWork(deps(), work!)).toBe('skipped');
    expect(await audits(c.tenant.id, 'template.delete_failed')).toHaveLength(1);

    // The company deletes it again, and this time Meta deletes it.
    await askDeletion(c, id);
    expect(await processTemplateDelete(workerDeps(), scopeOf(c), id)).toBe('done');
    expect((await template(id)).status).toBe('deleted');
  });

  it('are left alone while a job for the same deletion waits or runs, and find nothing left once the sync gave the template back', async () => {
    const c = await fx.company();
    const id = await approvedTemplate(c, 'kept_delete');
    await askDeletion(c, id);
    const deadLetterId = await deadLetter('template.delete', `${id}:delete`);
    // A job for the same deletion waits again, under the same singleton key.
    const again = await fx.boss.send(
      'template.delete',
      fx.signer.sign({
        kind: 'template.delete',
        tenantId: c.tenant.id,
        actorUserId: null,
        ref: id,
      }),
      { singletonKey: `${id}:delete` },
    );
    expect(again).toBeTruthy();
    expect(await listed(deadLetterId)).toBeUndefined();
    // Even from a lookup made before it was queued: the mark refuses and the work is untouched.
    const work: StrandedWork = {
      deadLetterId,
      queue: 'template.delete',
      tenantId: c.tenant.id,
      ref: id,
    };
    expect(await settleDeadLetterWork(deps(), work)).toBe('skipped');
    expect((await template(id)).status).toBe('pending_deletion');
    expect((await letter(deadLetterId)).settled_at).toBeNull();
    await fx.query(`UPDATE pgboss.job SET state = 'active', started_on = now() WHERE id = $1`, [
      again,
    ]);
    expect(await settleDeadLetterWork(deps(), work)).toBe('skipped');
    expect((await template(id)).status).toBe('pending_deletion');

    // Meta still lists it: the sync keeps the deletion while it can still be tried…
    await syncTemplates(workerDeps(later(7 * HOUR_MS)), scopeOf(c), c.whatsappAccountId);
    expect((await template(id)).status).toBe('pending_deletion');
    // …but not 8 hours after it was asked for (a job that ended before ADR-111).
    await syncTemplates(workerDeps(later(9 * HOUR_MS)), scopeOf(c), c.whatsappAccountId);
    expect((await template(id)).status).toBe('approved');
    expect(await lastEvent(id)).toEqual({
      status: 'approved',
      reason: 'Meta still lists it, so the deletion did not go through.',
      source: 'sync',
    });

    // That job dies too: nothing is left to end, and the dead letter says so.
    await fx.query(`UPDATE pgboss.job SET state = 'failed', completed_on = now() WHERE id = $1`, [
      again,
    ]);
    expect(await listed(deadLetterId)).toEqual(work);
    expect(await settleDeadLetterWork(deps(), work)).toBe('nothing_left');
    expect(await letter(deadLetterId)).toEqual({
      settled_at: expect.any(Date),
      settled_ended: false,
      retried_at: null,
    });
    expect((await template(id)).status).toBe('approved');
    expect(await audits(c.tenant.id, 'template.delete_failed')).toEqual([]);
  });

  it('are left to the sync when Meta itself reports the template as being deleted, and the sync applies a deletion Meta reports at once', async () => {
    const c = await fx.company();
    const beingDeleted = await approvedTemplate(c, 'meta_deleting');
    const gone = await approvedTemplate(c, 'meta_deleted');
    await askDeletion(c, beingDeleted);
    await askDeletion(c, gone);
    metaTemplate(c, 'meta_deleting').status = 'PENDING_DELETION';
    metaTemplate(c, 'meta_deleted').status = 'DELETED';
    await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId);
    expect(await template(gone)).toEqual({ status: 'deleted', provider_status: 'DELETED' });
    expect(await template(beingDeleted)).toEqual({
      status: 'pending_deletion',
      provider_status: 'PENDING_DELETION',
    });
    const deadLetterId = await deadLetter('template.delete', `${beingDeleted}:delete`);
    expect(await settleDeadLetterWork(deps(), (await listed(deadLetterId))!)).toBe('nothing_left');
    expect(await template(beingDeleted)).toEqual({
      status: 'pending_deletion',
      provider_status: 'PENDING_DELETION',
    });
    expect(await audits(c.tenant.id, 'template.delete_failed')).toEqual([]);
  });

  it("refused by Meta are not kept by the sync, which takes Meta's status as before", async () => {
    const c = await fx.company();
    const id = await approvedTemplate(c, 'refused_delete');
    await askDeletion(c, id);
    fx.standIn.state.templateDeleteError = {
      status: 400,
      code: 100,
      message: 'Template cannot be deleted',
    };
    try {
      expect(await processTemplateDelete(workerDeps(), scopeOf(c), id)).toBe('done');
    } finally {
      fx.standIn.state.templateDeleteError = null;
    }
    expect((await template(id)).status).toBe('pending_deletion');
    expect((await lastEvent(id))?.status).toBe('delete_failed');
    await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId);
    expect(await template(id)).toEqual({ status: 'approved', provider_status: 'APPROVED' });
    expect(await lastEvent(id)).toEqual({
      status: 'approved',
      reason: 'Meta still lists it, so the deletion did not go through.',
      source: 'sync',
    });
  });
});

describe('checks of Razorpay keys whose job ran out of retries (ADR-111)', () => {
  const account = async (c: Company) =>
    (
      await fx.query<{
        id: string;
        status: string;
        status_error: string | null;
        checked_at: Date | null;
      }>(
        `SELECT id, status, status_error, checked_at FROM app.commerce_payment_accounts
          WHERE tenant_id = $1`,
        [c.tenant.id],
      )
    )[0]!;

  it('fail keys still being checked, but wait for the check of keys saved again', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const keys = {
      keyId: 'rzp_test_strandedkeys01',
      keySecret: 'stranded-secret-1',
      webhookSecret: 'stranded-hook-1',
    };
    await commerce().savePaymentAccount(owner, keys);
    const { id: accountId, status } = await account(c);
    expect(status).toBe('checking');
    queued.push({ queue: 'commerce.account', key: `${accountId}:%` });
    const first = await deadLetter('commerce.account', `${accountId}:%`, 8);

    // The keys are saved again: their own check waits, under a key of its own.
    await commerce().savePaymentAccount(owner, { ...keys, keySecret: 'stranded-secret-2' });
    expect(await listed(first)).toBeUndefined();
    const work: StrandedWork = {
      deadLetterId: first,
      queue: 'commerce.account',
      tenantId: c.tenant.id,
      ref: accountId,
    };
    expect(await settleDeadLetterWork(deps(), work)).toBe('skipped');
    expect(await account(c)).toMatchObject({ status: 'checking', status_error: null });

    // That check runs out of retries too. The sweep ends the check once, for the older dead
    // letter, and finds nothing left for the newer one, nor for a dead letter whose reference
    // names no account.
    const second = await deadLetter('commerce.account', `${accountId}:%`, 8);
    const noAccount = await insertLetter({
      queue: 'commerce.account',
      kind: 'commerce.account',
      tenantId: c.tenant.id,
      ref: uuidv7(),
    });
    // Files run one at a time and this file settles every dead letter it makes, so these three
    // are all the sweep finds.
    expect(await settleStrandedWork(deps(), 500)).toEqual({
      ended: 1,
      nothingLeft: 2,
      skipped: 0,
      failed: [],
    });
    expect(await letter(noAccount)).toMatchObject({ settled_ended: false });
    expect(await letter(first)).toEqual({
      settled_at: expect.any(Date),
      settled_ended: true,
      retried_at: null,
    });
    expect(await letter(second)).toEqual({
      settled_at: expect.any(Date),
      settled_ended: false,
      retried_at: null,
    });
    expect(await account(c)).toMatchObject({
      status: 'failed',
      status_error:
        'Razorpay could not be reached to check the keys after repeated attempts. Save them again to check them.',
      checked_at: expect.any(Date),
    });

    // Saving the keys again checks them again.
    await commerce().savePaymentAccount(owner, keys);
    expect(await account(c)).toMatchObject({ status: 'checking', status_error: null });
  });
});

describe('number setups whose job ran out of retries (ADR-111)', () => {
  const channel = async (c: Company) =>
    (
      await fx.query<{
        status: string;
        onboarding_step: string | null;
        onboarding_error: string | null;
      }>(
        `SELECT status, onboarding_step, onboarding_error FROM app.channel_accounts WHERE id = $1`,
        [c.channelAccountId],
      )
    )[0]!;
  const channelEvents = async (c: Company) =>
    (
      await fx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.tenant_events
          WHERE tenant_id = $1 AND type = 'channel.updated'
            AND payload->>'channelAccountId' = $2`,
        [c.tenant.id, c.channelAccountId],
      )
    )[0]!.n;

  it('fail with the step they stopped at, once no setup retried meanwhile waits or runs', async () => {
    const c = await fx.company();
    await fx.query(
      `UPDATE app.channel_accounts SET status = 'onboarding', onboarding_step = 'register_number'
        WHERE id = $1`,
      [c.channelAccountId],
    );
    const owner = await fx.ctx(c, c.owner);
    queued.push({ queue: 'channel.onboard', key: c.channelAccountId });
    await onboarding().retrySetup(owner, c.channelAccountId);
    const first = await deadLetter('channel.onboard', c.channelAccountId, 8);

    // The company retries the setup meanwhile: its job waits under the same key.
    await onboarding().retrySetup(owner, c.channelAccountId);
    expect(await listed(first)).toBeUndefined();
    const work: StrandedWork = {
      deadLetterId: first,
      queue: 'channel.onboard',
      tenantId: c.tenant.id,
      ref: c.channelAccountId,
    };
    expect(await settleDeadLetterWork(deps(), work)).toBe('skipped');
    expect((await channel(c)).status).toBe('onboarding');

    const second = await deadLetter('channel.onboard', c.channelAccountId, 8);
    const before = await channelEvents(c);
    expect(await settleDeadLetterWork(deps(), (await listed(first))!)).toBe('ended');
    expect(await settleDeadLetterWork(deps(), (await listed(second))!)).toBe('nothing_left');
    expect(await channel(c)).toEqual({
      status: 'failed',
      onboarding_step: 'register_number',
      onboarding_error:
        'Setup stopped at register_number: Meta could not be reached after repeated attempts. Retry setup.',
    });
    expect(await audits(c.tenant.id, 'channel.setup_failed')).toEqual([
      {
        subject_id: c.channelAccountId,
        result: 'failure',
        metadata: { step: 'register_number', code: null, kind: 'retries_exhausted' },
      },
    ]);
    expect(await channelEvents(c)).toBe(before + 1);
    expect(await letter(second)).toMatchObject({ settled_ended: false });

    // The company retries the failed number's setup.
    await onboarding().retrySetup(owner, c.channelAccountId);
    expect(await channel(c)).toMatchObject({ status: 'onboarding', onboarding_error: null });
  });
});

describe('which dead letters are settled (ADR-111)', () => {
  const mark = (scope: TenantScope, id: string, ended: boolean | null) =>
    fx.dbs.app.run(scope, (tx) =>
      tx.execute(sql`select ops.settle_dead_letter(${id}::uuid, ${ended}::boolean) as settled`),
    );

  it('only verified ones of the three queues naming their own queue, of companies not being deleted, each in its own company scope', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const deleting = await createTenant(fx.dbs, await createUser(fx.dbs));
    await fx.query(`UPDATE app.tenants SET status = 'pending_deletion' WHERE id = $1`, [
      deleting.id,
    ]);
    const ref = uuidv7();
    const unverified = await insertLetter({
      queue: 'template.delete',
      kind: null,
      tenantId: null,
      ref: null,
    });
    const otherQueue = await insertLetter({
      queue: 'email.send',
      kind: 'email.send',
      tenantId: c.tenant.id,
      ref,
    });
    const otherKind = await insertLetter({
      queue: 'template.delete',
      kind: 'template.submit',
      tenantId: c.tenant.id,
      ref,
    });
    const ofDeleting = await insertLetter({
      queue: 'template.delete',
      kind: 'template.delete',
      tenantId: deleting.id,
      ref,
    });
    for (const id of [unverified, otherQueue, otherKind, ofDeleting]) {
      expect(await listed(id), id).toBeUndefined();
    }
    await expectCode(mark(scopeOf(c), unverified, true), 'not_found');
    await expectCode(
      mark(scopeOf(c), otherQueue, true),
      'precondition_failed',
      /not settled by the sweep/,
    );
    await expectCode(
      mark(scopeOf(c), otherKind, true),
      'precondition_failed',
      /not settled by the sweep/,
    );

    // A dead letter is marked only in its own company's scope, and only with an answer.
    const own = await insertLetter({
      queue: 'template.delete',
      kind: 'template.delete',
      tenantId: c.tenant.id,
      ref: uuidv7(),
    });
    await expectCode(mark(scopeOf(other), own, true), 'not_found');
    await expectCode(
      fx.dbs.app.run(systemScope, (tx) =>
        tx.execute(sql`select ops.settle_dead_letter(${own}::uuid, true)`),
      ),
      'forbidden',
    );
    await expectCode(mark(scopeOf(c), own, null), 'forbidden');
    expect((await letter(own)).settled_at).toBeNull();
    // Its template is gone, so nothing is left to end.
    expect(await settleDeadLetterWork(deps(), (await listed(own))!)).toBe('nothing_left');
    expect(await letter(own)).toMatchObject({ settled_ended: false });

    // A reference that is not a record id names nothing of the company's.
    const odd = await insertLetter({
      queue: 'commerce.account',
      kind: 'commerce.account',
      tenantId: c.tenant.id,
      ref: 'not-a-record-id',
    });
    expect(await settleDeadLetterWork(deps(), (await listed(odd))!)).toBe('nothing_left');
    expect(await letter(odd)).toMatchObject({ settled_at: expect.any(Date), settled_ended: false });

    // The table keeps the marks honest: a settled time comes with its answer, and only a verified
    // dead letter of the three queues is settled.
    await expect(
      fx.query(`UPDATE ops.dead_letters SET settled_at = now() WHERE id = $1`, [ofDeleting]),
    ).rejects.toThrow(/dead_letters_settled_pair/);
    for (const id of [unverified, otherQueue]) {
      await expect(
        fx.query(
          `UPDATE ops.dead_letters SET settled_at = now(), settled_ended = false WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/dead_letters_settled_queue/);
    }
    // Neither the runtime role nor platform staff can mark one directly.
    for (const pool of [fx.dbs.appPool, fx.dbs.platformPool]) {
      await expect(
        pool.query(
          `UPDATE ops.dead_letters SET settled_at = now(), settled_ended = true WHERE id = $1`,
          [ofDeleting],
        ),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('never one retried from the console, which in turn refuses one whose work was ended and says so', async () => {
    const c = await fx.company();
    const id = await approvedTemplate(c, 'console_delete');
    await askDeletion(c, id);
    const settled = await deadLetter('template.delete', `${id}:delete`);
    expect(await settleDeadLetterWork(deps(), (await listed(settled))!)).toBe('ended');
    await expectCode(
      ops().retryDeadLetter(staff, { deadLetterId: settled, reason: REASON }),
      'precondition_failed',
      /ended for its company, which can start it again/,
    );
    const view = (await ops().queues(staff)).deadLetters.find((d) => d.id === settled);
    expect(view).toMatchObject({
      settledAt: expect.any(Date),
      settledEnded: true,
      retryBlock: 'settled',
      retryable: false,
    });

    // Retried from the console before the sweep: its job does the work, and the sweep leaves it.
    await askDeletion(c, id);
    const retried = await deadLetter('template.delete', `${id}:delete`);
    expect(await ops().retryDeadLetter(staff, { deadLetterId: retried, reason: REASON })).toEqual({
      queue: 'template.delete',
    });
    expect(await listed(retried)).toBeUndefined();
    expect(
      await settleDeadLetterWork(deps(), {
        deadLetterId: retried,
        queue: 'template.delete',
        tenantId: c.tenant.id,
        ref: id,
      }),
    ).toBe('skipped');
    expect(await letter(retried)).toMatchObject({ settled_at: null, retried_at: expect.any(Date) });
    expect((await template(id)).status).toBe('pending_deletion');
    // Its job fails again (and has a dead letter of its own): the retried one stays unsettled.
    await fx.query(
      `UPDATE pgboss.job SET state = 'failed', completed_on = now()
        WHERE name = 'template.delete' AND singleton_key = $1 AND state = 'retry'`,
      [`${id}:delete`],
    );
    expect(await listed(retried)).toBeUndefined();
    expect(
      await settleDeadLetterWork(deps(), {
        deadLetterId: retried,
        queue: 'template.delete',
        tenantId: c.tenant.id,
        ref: id,
      }),
    ).toBe('skipped');
    expect(await letter(retried)).toMatchObject({ settled_at: null });
    expect((await template(id)).status).toBe('pending_deletion');
    // The two marks exclude each other.
    await expect(
      fx.query(
        `UPDATE ops.dead_letters SET settled_at = now(), settled_ended = true WHERE id = $1`,
        [retried],
      ),
    ).rejects.toThrow(/dead_letters_retried_or_settled/);
  });
});
