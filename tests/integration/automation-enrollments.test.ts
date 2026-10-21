import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7 } from '@w360/core';
import { QUEUES, type JobEnvelope, type QueueName } from '@w360/contracts';
import { authorizedTenantScope, contactTags, conversations, sql, type Tx } from '@w360/db';
import {
  RUN_BUDGETS,
  advanceAutomationRun,
  authorizeJob,
  contactForPhone,
  createContactMergeService,
  createTemplatesService,
  deferEnrollment,
  processTemplateSubmit,
  resignalEnrollment,
  syncTemplates,
  type TemplateDefinition,
  createAutomationEnrollmentService,
  createAutomationService,
  createConsentService,
  createContactsService,
  createPlanAdminService,
  createSegmentsService,
  createWebhooksService,
  dayOf,
  endEnrollmentForRemovedMember,
  maskPhoneNumber,
  processEnrollmentBatch,
  type AutomationTrigger,
  type EnqueueOptions,
  type JobQueue,
  type PlatformActor,
  type TenantContext,
} from '@w360/domain';
import { acceptInvitation, createUser, invite } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Members' enrolments of contacts or a segment in an automation started by a member or through the
 * API (ADR-401) against real PostgreSQL and pg-boss: the snapshot, batches of at most 50 starts in
 * one transaction with each contact's start steps in a savepoint, refused contacts with their
 * reasons, the plan's runs, resumption after a crash mid-batch without a second run, a duplicate
 * job, stop, the member's authority, isolation between companies, the tables' row security and
 * grants, the run's record of its enrolment, and its contacts listed with their outcomes (ADR-408).
 */
let fx: WhatsAppFixture;
beforeAll(async () => {
  fx = await startWhatsAppFixture();
});
afterAll(async () => {
  await fx?.close();
});

const enrollmentDeps = (jobs: JobQueue = fx.jobs()) => ({
  db: fx.dbs.app,
  clock: systemClock,
  jobs,
  signer: fx.signer,
});
const enrollments = () => createAutomationEnrollmentService(enrollmentDeps());
const automationService = () =>
  createAutomationService({
    db: fx.dbs.app,
    clock: systemClock,
    jobs: fx.jobs(),
    signer: fx.signer,
  });

const apiTrigger: AutomationTrigger = { type: 'api', inputs: ['campaign'] };
/** Tags the contact and ends: no message, so nothing needs the service window. */
const tagFlow = {
  version: 1,
  start: 'tag',
  nodes: [
    {
      id: 'tag',
      type: 'update_contact',
      action: { kind: 'add_tag', tag: 'enrolled' },
      next: 'done',
    },
    { id: 'done', type: 'end' },
  ],
};

async function publish(owner: TenantContext, c: Company, name: string) {
  const svc = automationService();
  const { id } = await svc.createAutomation(owner, { name });
  const saved = await svc.updateAutomation(owner, {
    id,
    expectedVersion: 0,
    name,
    description: null,
    channelAccountId: c.channelAccountId,
    trigger: apiTrigger,
    graph: tagFlow,
  });
  expect(saved.issues.filter((i) => i.level === 'error')).toEqual([]);
  await svc.publishAutomation(owner, { id, expectedVersion: saved.version, note: null });
  return id;
}

let phoneCounter = 0;
/** Contacts of the company with numbers of their own, tagged. */
async function contactsOf(c: Company, count: number, tag: string): Promise<string[]> {
  const ids: string[] = [];
  await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), async (tx: Tx) => {
    for (let i = 0; i < count; i += 1) {
      phoneCounter += 1;
      const id = await contactForPhone(tx, c.tenant.id, {
        phoneE164: `+91970${String(phoneCounter).padStart(7, '0')}`,
        displayName: `Contact ${phoneCounter}`,
        source: 'manual',
      });
      await tx
        .insert(contactTags)
        .values({ id: uuidv7(), tenantId: c.tenant.id, contactId: id, tag });
      ids.push(id);
    }
  });
  return ids;
}

const phoneOf = async (contactId: string) =>
  (
    await fx.query<{ phone_e164: string }>('SELECT phone_e164 FROM app.contacts WHERE id = $1', [
      contactId,
    ])
  )[0]!.phone_e164;

const byTag = (tag: string) => ({ kind: 'contacts' as const, filter: { tag } });

async function enrol(
  owner: TenantContext,
  automationId: string,
  audience: unknown,
  expectedCount: number,
) {
  return enrollments().startEnrollment(owner, {
    automationId,
    audience,
    inputs: { campaign: 'Diwali' },
    expectedCount,
  });
}

/**
 * Makes a running enrolment's paced next batch due now, as the wait for its job's start leaves it
 * (the pacing itself is tested on its own below).
 */
const dueNow = (id: string) =>
  fx.query(
    `UPDATE app.automation_enrollments SET next_batch_at = now()
      WHERE id = $1 AND status = 'running' AND next_batch_at > now()`,
    [id],
  );

/** Runs the enrolment's batches the way the worker does, each once it is due, until it ends. */
async function drain(c: Company, enrollmentId: string, jobs: JobQueue = fx.jobs()) {
  const outcomes: string[] = [];
  for (let i = 0; i < 300; i += 1) {
    await dueNow(enrollmentId);
    const result = await processEnrollmentBatch(
      enrollmentDeps(jobs),
      authorizedTenantScope(c.tenant.id, c.owner.id),
      enrollmentId,
    );
    outcomes.push(result.outcome);
    if (result.outcome !== 'batch') return outcomes;
  }
  throw new Error('the enrolment did not end');
}

const enrollmentRow = async (id: string) =>
  (
    await fx.query<{
      status: string;
      end_reason: string | null;
      total: number;
      started_count: number;
      refused_count: number;
      cancelled_count: number;
      cursor_position: number;
      inputs: Record<string, string>;
      stopped_by_membership_id: string | null;
    }>(
      `SELECT status, end_reason, total, started_count, refused_count, cancelled_count,
              cursor_position, inputs, stopped_by_membership_id
         FROM app.automation_enrollments WHERE id = $1`,
      [id],
    )
  )[0]!;

const outcomesOf = async (id: string) =>
  fx.query<{ contact_id: string; outcome: string; reason: string | null; run_id: string | null }>(
    `SELECT contact_id, outcome, reason, run_id FROM app.automation_enrollment_contacts
      WHERE enrollment_id = $1 ORDER BY position`,
    [id],
  );

const runsOf = async (enrollmentId: string) =>
  fx.query<{
    id: string;
    contact_id: string;
    trigger_type: string;
    api_key_id: string | null;
    mode: string;
    variables: Record<string, string>;
  }>(
    `SELECT id, contact_id, trigger_type, api_key_id, mode, variables FROM app.automation_runs
      WHERE enrollment_id = $1 ORDER BY started_at, id`,
    [enrollmentId],
  );

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { code: error.code, message: error.publicMessage };
  }
  throw new Error('expected a refusal');
}

let planCodes = 0;
/** Puts the company on a published plan with the given terms (P5-01), as platform staff would. */
async function onPlan(c: Company, overrides: Record<string, unknown>) {
  const staff = await createUser(fx.dbs, { twoFactor: true });
  await fx.dbs.ownerPool.query(
    `INSERT INTO ops.platform_admins (user_id, role) VALUES ($1, 'platform_owner')`,
    [staff.id],
  );
  const actor: PlatformActor = {
    userId: staff.id,
    role: 'platform_owner',
    correlationId: uuidv7(),
  };
  const plans = createPlanAdminService({ platformDb: fx.dbs.platform, clock: systemClock });
  planCodes += 1;
  const { id } = await plans.createPlan(actor, {
    code: `enrol-${Date.now().toString(36)}-${planCodes}`,
    name: 'Enrolment plan',
    price: '999',
    intervalMonths: '1',
    trialDays: '0',
    graceDays: '7',
    seatsIncluded: '10',
    numbersIncluded: '5',
    modules: ['automations'],
    ...overrides,
  });
  await plans.publishPlan(actor, id);
  const view = await plans.tenantPlan(actor, c.tenant.id);
  await plans.setTenantPlan(actor, {
    tenantId: c.tenant.id,
    version: view.state.version,
    status: 'active',
    planId: id,
    periodStart: dayOf(new Date(), 'Asia/Kolkata'),
    periodEnd: dayOf(new Date(Date.now() + 30 * 86_400_000), 'Asia/Kolkata'),
    reason: 'Plan for the enrolment tests',
  });
}

/** A job queue that fails the nth signal of a run, as a worker that dies mid-batch would. */
function crashingQueue(failAt: number): JobQueue {
  const real = fx.jobs();
  let runs = 0;
  return {
    async enqueue(
      tx: Tx | null,
      queue: QueueName,
      envelope: JobEnvelope,
      options?: EnqueueOptions,
    ) {
      if (queue === QUEUES.automationRun.name) {
        runs += 1;
        if (runs === failAt) throw new Error('the worker died');
      }
      return real.enqueue(tx, queue, envelope, options);
    },
    enqueueMany: (tx, queue, jobs) => real.enqueueMany(tx, queue, jobs),
    raisePriority: (tx, queue, key, priority) => real.raisePriority(tx, queue, key, priority),
  };
}

describe('enrolling contacts in an automation (ADR-401)', () => {
  it('snapshots the contacts the filters match, starts each as a live api run naming the enrolment, in batches of 50', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Diwali follow-up');
    const ids = await contactsOf(c, 55, 'diwali');
    await contactsOf(c, 2, 'other');

    const preview = await enrollments().previewEnrollment(owner, {
      automationId,
      audience: byTag('diwali'),
    });
    expect(preview).toMatchObject({ count: 55, segmentName: null });
    expect(preview.automation).toMatchObject({ id: automationId, inputs: ['campaign'] });

    const started = await enrol(owner, automationId, byTag('diwali'), 55);
    expect(started.total).toBe(55);
    // The first batch's job, signed with the member, keyed by the position it starts after.
    const [job] = await fx.query<{
      singleton_key: string;
      data: { actorUserId: string; ref: string };
    }>(`SELECT singleton_key, data FROM pgboss.job WHERE name = $1 AND data->>'ref' = $2`, [
      QUEUES.automationEnroll.name,
      started.id,
    ]);
    expect(job).toMatchObject({
      singleton_key: `${started.id}:0`,
      data: { actorUserId: c.owner.id, ref: started.id },
    });
    // Contacts added after the start are not enrolled: the snapshot was taken.
    await contactsOf(c, 1, 'diwali');

    expect(await drain(c, started.id)).toEqual(['batch', 'finished']);
    expect(await enrollmentRow(started.id)).toMatchObject({
      status: 'completed',
      end_reason: null,
      total: 55,
      started_count: 55,
      refused_count: 0,
      cancelled_count: 0,
      cursor_position: 55,
      inputs: {},
    });
    const runs = await runsOf(started.id);
    expect(runs).toHaveLength(55);
    expect(new Set(runs.map((r) => r.contact_id))).toEqual(new Set(ids));
    for (const run of runs) {
      expect(run).toMatchObject({
        trigger_type: 'api',
        api_key_id: null,
        mode: 'live',
        variables: { 'input.campaign': 'Diwali' },
      });
    }
    const outcomes = await outcomesOf(started.id);
    expect(outcomes.every((o) => o.outcome === 'started' && o.run_id !== null)).toBe(true);
    // The run page names the member's enrolment; the runs list marks it.
    const detail = await automationService().getRun(owner, runs[0]!.id);
    expect(detail).toMatchObject({
      enrollmentId: started.id,
      apiKeyName: null,
      enrolledByName: 'Owner',
    });
    // The run goes on as any live run: it tags the contact and completes.
    const advanced = await advanceAutomationRun(
      {
        db: fx.dbs.app,
        jobs: fx.jobs(),
        signer: fx.signer,
        clock: systemClock,
        keyring: fx.keyring,
      },
      authorizedTenantScope(c.tenant.id, null),
      runs[0]!.id,
      null,
    );
    expect(advanced.outcome).toBe('ended');
    const [ended] = await fx.query<{ status: string }>(
      'SELECT status FROM app.automation_runs WHERE id = $1',
      [runs[0]!.id],
    );
    expect(ended).toEqual({ status: 'completed' });
    // Audited once for the enrolment, without the inputs or the search; not once per run.
    const audit = await fx.query<{
      action: string;
      actor_type: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, actor_type, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 ORDER BY occurred_at, id`,
      [c.tenant.id, started.id],
    );
    expect(audit.map((a) => [a.action, a.actor_type])).toEqual([
      ['automation.enrollment_started', 'user'],
      ['automation.enrollment_ended', 'system'],
    ]);
    expect(JSON.stringify(audit)).not.toContain('Diwali');
    expect(
      await fx.query(
        `SELECT 1 FROM app.audit_events WHERE tenant_id = $1 AND action = 'automation.run_started'`,
        [c.tenant.id],
      ),
    ).toHaveLength(0);
    // Listed on the automation's page.
    expect((await enrollments().listEnrollments(owner, automationId)).map((e) => e.id)).toEqual([
      started.id,
    ]);
  });

  it('enrols a saved segment’s members and sends the usual run event to webhooks, with no key', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Segment flow');
    const ids = await contactsOf(c, 3, 'vip');
    const { id: segmentId } = await createSegmentsService({
      db: fx.dbs.app,
      clock: systemClock,
    }).createSegment(
      owner,
      {
        name: 'VIPs',
        definition: { match: 'all', conditions: [{ type: 'tag', op: 'has', tag: 'vip' }] },
      },
      {},
    );
    await createWebhooksService({
      db: fx.dbs.app,
      clock: systemClock,
      keyring: fx.keyring,
      egressPolicy: { allowLoopbackForTests: true },
    }).create(owner, {
      url: 'http://hooks.receiver.test:9/enrolments',
      eventTypes: ['automation.run_started'],
      contactParts: null,
      automationIds: null,
      campaignStatuses: null,
      orderStatuses: null,
      conversationStatuses: null,
      runEndStatuses: null,
      channelIds: null,
      runTriggers: null,
      contactFieldKeys: null,
      campaignIds: null,
    });
    const audience = { kind: 'segment', segmentId };
    expect(await enrollments().previewEnrollment(owner, { automationId, audience })).toMatchObject({
      count: 3,
      segmentName: 'VIPs',
    });
    const started = await enrol(owner, automationId, audience, 3);
    expect(await drain(c, started.id)).toEqual(['finished']);
    const runs = await runsOf(started.id);
    expect(new Set(runs.map((r) => r.contact_id))).toEqual(new Set(ids));
    const events = await fx.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM app.webhook_events WHERE tenant_id = $1 AND type = 'automation.run_started'`,
      [c.tenant.id],
    );
    expect(events.map((e) => e.detail.runId).sort()).toEqual(runs.map((r) => r.id).sort());
    expect(events.every((e) => (e.detail.apiKeyId ?? null) === null)).toBe(true);
    const detail = await enrollments().getEnrollment(owner, started.id);
    expect(detail).toMatchObject({
      source: 'segment',
      segmentName: 'VIPs',
      started: 3,
      pending: 0,
    });
  });

  it('refuses each contact a start step refuses, records the reason, and starts the others', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Refusals');
    const [suppressed, optedOut, erased, assigned, busy, limited, fine] = await contactsOf(
      c,
      7,
      'mixed',
    );
    const consent = createConsentService({ db: fx.dbs.app, clock: systemClock });
    await consent.addSuppression(owner, { phone: await phoneOf(suppressed!), reason: 'manual' });
    await consent.recordConsent(owner, {
      contactId: optedOut!,
      purpose: 'utility',
      action: 'opt_out',
    });
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: erased!,
      suppress: false,
    });
    // A conversation a member holds, and one with ten runs in the last hour.
    const conversationFor = async (contactId: string, assignedMembershipId: string | null) => {
      const id = uuidv7();
      await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), (tx: Tx) =>
        tx.insert(conversations).values({
          id,
          tenantId: c.tenant.id,
          channelAccountId: c.channelAccountId,
          contactId,
          status: 'open',
          assignedMembershipId,
        }),
      );
      return id;
    };
    await conversationFor(assigned!, owner.membership.id);
    const limitedConversation = await conversationFor(limited!, null);
    const [version] = await fx.query<{ id: string }>(
      'SELECT active_version_id AS id FROM app.automations WHERE id = $1',
      [automationId],
    );
    for (let i = 0; i < RUN_BUDGETS.maxRunsPerConversationPerHour; i += 1) {
      await fx.query(
        `INSERT INTO app.automation_runs (id, tenant_id, automation_id, version_id, conversation_id,
           contact_id, channel_account_id, mode, trigger_type, status, started_at, ended_at, end_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'live', 'keyword', 'completed', now() - interval '5 minutes',
                 now() - interval '4 minutes', 'end_node')`,
        [
          uuidv7(),
          c.tenant.id,
          automationId,
          version!.id,
          limitedConversation,
          limited,
          c.channelAccountId,
        ],
      );
    }
    // Another automation's run handles the busy contact's conversation: an enrolment of it alone.
    await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), (tx: Tx) =>
      tx
        .insert(contactTags)
        .values({ id: uuidv7(), tenantId: c.tenant.id, contactId: busy!, tag: 'first' }),
    );
    const first = await enrol(owner, automationId, byTag('first'), 1);
    expect(await drain(c, first.id)).toEqual(['finished']);

    const started = await enrol(owner, automationId, byTag('mixed'), 6);
    expect(await drain(c, started.id)).toEqual(['finished']);
    const outcomes = await outcomesOf(started.id);
    const reasonOf = (id: string) => {
      const o = outcomes.find((x) => x.contact_id === id);
      return o ? (o.outcome === 'refused' ? o.reason : o.outcome) : 'not enrolled';
    };
    // The erased contact no longer matches the filters (erased contacts never do).
    expect({
      suppressed: reasonOf(suppressed!),
      optedOut: reasonOf(optedOut!),
      erased: reasonOf(erased!),
      assigned: reasonOf(assigned!),
      busy: reasonOf(busy!),
      limited: reasonOf(limited!),
      fine: reasonOf(fine!),
    }).toEqual({
      suppressed: 'suppressed',
      optedOut: 'opted_out',
      erased: 'not enrolled',
      assigned: 'conversation_assigned',
      busy: 'automation_busy',
      limited: 'automation_limit',
      fine: 'started',
    });
    // A refused start rolled back alone: no conversation was left for the suppressed contact.
    expect(
      await fx.query('SELECT 1 FROM app.conversations WHERE contact_id = $1', [suppressed]),
    ).toHaveLength(0);
    expect(await enrollmentRow(started.id)).toMatchObject({
      status: 'completed',
      started_count: 1,
      refused_count: 5,
    });
    const detail = await enrollments().getEnrollment(owner, started.id);
    expect(detail.refusals.map((r) => [r.reason, r.count]).sort()).toEqual(
      [
        ['automation_busy', 1],
        ['automation_limit', 1],
        ['conversation_assigned', 1],
        ['opted_out', 1],
        ['suppressed', 1],
      ].sort(),
    );

    // A contact erased after the snapshot is refused as erased.
    const [late] = await contactsOf(c, 1, 'late');
    const lateEnrolment = await enrol(owner, automationId, byTag('late'), 1);
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: late!,
      suppress: false,
    });
    await drain(c, lateEnrolment.id);
    expect((await outcomesOf(lateEnrolment.id))[0]).toMatchObject({
      outcome: 'refused',
      reason: 'contact_erased',
    });
  });

  it('refuses the contacts beyond the plan’s runs left this month, and ends when the plan has no automations', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Quota');
    await contactsOf(c, 3, 'quota');
    await onPlan(c, { automationRunsMonthly: '2' });
    const member = await fx.ctx(c, c.owner);
    const started = await enrol(member, automationId, byTag('quota'), 3);
    expect(await drain(c, started.id)).toEqual(['finished']);
    expect((await outcomesOf(started.id)).map((o) => o.reason ?? o.outcome)).toEqual([
      'started',
      'started',
      'automation_quota',
    ]);

    await contactsOf(c, 2, 'noplan');
    await onPlan(c, { modules: ['automations'], automationRunsMonthly: '100' });
    const again = await enrol(await fx.ctx(c, c.owner), automationId, byTag('noplan'), 2);
    await onPlan(c, { modules: [] });
    expect(await drain(c, again.id)).toEqual(['finished']);
    expect(await enrollmentRow(again.id)).toMatchObject({
      status: 'stopped',
      end_reason: 'not_in_plan',
      started_count: 0,
      cancelled_count: 2,
      inputs: {},
    });
  });

  it('resumes after a crash mid-batch without a second run for any contact, and a duplicate job starts nothing', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Crash');
    const ids = await contactsOf(c, 60, 'crash');
    const started = await enrol(owner, automationId, byTag('crash'), 60);
    // The worker dies at the 30th start of the first batch: the batch's transaction rolls back.
    await expect(
      processEnrollmentBatch(
        enrollmentDeps(crashingQueue(30)),
        authorizedTenantScope(c.tenant.id, c.owner.id),
        started.id,
      ),
    ).rejects.toThrow('the worker died');
    expect(await runsOf(started.id)).toHaveLength(0);
    expect(await enrollmentRow(started.id)).toMatchObject({ started_count: 0, cursor_position: 0 });
    // The retry starts the first batch again, once.
    const first = await processEnrollmentBatch(
      enrollmentDeps(),
      authorizedTenantScope(c.tenant.id, c.owner.id),
      started.id,
    );
    expect(first).toEqual({
      outcome: 'batch',
      started: 50,
      refused: 0,
      nextBatchAt: expect.any(Date),
    });
    // Two jobs for the next batch at once, once it is due (a duplicate signal): the row lock makes
    // them take turns, and the second finds nothing left.
    await dueNow(started.id);
    const both = await Promise.all(
      [0, 1].map(() =>
        processEnrollmentBatch(
          enrollmentDeps(),
          authorizedTenantScope(c.tenant.id, c.owner.id),
          started.id,
        ),
      ),
    );
    expect(both.map((r) => r.outcome).sort()).toEqual(['ended', 'finished']);
    const runs = await runsOf(started.id);
    expect(runs).toHaveLength(60);
    expect(new Set(runs.map((r) => r.contact_id)).size).toBe(60);
    expect(new Set(runs.map((r) => r.contact_id))).toEqual(new Set(ids));
    expect(await enrollmentRow(started.id)).toMatchObject({
      status: 'completed',
      started_count: 60,
      cursor_position: 60,
    });
    // An enrolment of the same contacts later refuses each as busy (their runs still run): the
    // enrolment never starts a second run for a contact.
    const again = await enrol(owner, automationId, byTag('crash'), 60);
    await drain(c, again.id);
    expect(await enrollmentRow(again.id)).toMatchObject({ started_count: 0, refused_count: 60 });
  });

  it('stops: contacts not handled are not started, runs already started go on; one running enrolment per automation', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Stop');
    await contactsOf(c, 70, 'stop');
    const started = await enrol(owner, automationId, byTag('stop'), 70);
    // A second enrolment of the automation waits for the first.
    expect(await refusalOf(enrol(owner, automationId, byTag('stop'), 70))).toEqual({
      code: 'conflict',
      message:
        'Contacts are being enrolled in this automation already. Wait until that enrolment ends, or stop it.',
    });
    expect(
      await processEnrollmentBatch(
        enrollmentDeps(),
        authorizedTenantScope(c.tenant.id, c.owner.id),
        started.id,
      ),
    ).toMatchObject({ outcome: 'batch', started: 50 });
    expect(await enrollments().stopEnrollment(owner, { id: started.id })).toEqual({
      cancelled: 20,
    });
    expect(await enrollmentRow(started.id)).toMatchObject({
      status: 'stopped',
      end_reason: 'stopped_by_member',
      started_count: 50,
      cancelled_count: 20,
      inputs: {},
      stopped_by_membership_id: owner.membership.id,
    });
    // The next batch's job finds the enrolment ended and starts nothing.
    expect(
      await processEnrollmentBatch(
        enrollmentDeps(),
        authorizedTenantScope(c.tenant.id, c.owner.id),
        started.id,
      ),
    ).toEqual({ outcome: 'ended' });
    expect(await runsOf(started.id)).toHaveLength(50);
    const [active] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.automation_runs
        WHERE enrollment_id = $1 AND status IN ('running', 'waiting')`,
      [started.id],
    );
    expect(active!.n).toBe(50);
    expect(await refusalOf(enrollments().stopEnrollment(owner, { id: started.id }))).toMatchObject({
      code: 'conflict',
    });
    const audit = await fx.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM app.audit_events WHERE subject_id = $1 ORDER BY occurred_at, id`,
      [started.id],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'automation.enrollment_started',
      'automation.enrollment_stopped',
    ]);
    // Once it stopped, another enrolment may start.
    await contactsOf(c, 1, 'after');
    await expect(enrol(owner, automationId, byTag('after'), 1)).resolves.toMatchObject({
      total: 1,
    });
  });

  it('refuses members who may not publish, counts that changed, paused automations and inputs it does not take', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const marketer = await fx.ctx(c, c.marketer);
    const automationId = await publish(owner, c, 'Who may');
    await contactsOf(c, 2, 'may');
    expect((await refusalOf(enrol(marketer, automationId, byTag('may'), 2))).code).toBe(
      'forbidden',
    );
    expect((await refusalOf(enrol(owner, automationId, byTag('may'), 3))).code).toBe('conflict');
    expect(
      await refusalOf(
        enrollments().startEnrollment(owner, {
          automationId,
          audience: byTag('may'),
          inputs: {},
          expectedCount: 2,
        }),
      ),
    ).toEqual({ code: 'validation_failed', message: 'Give the input “campaign” a value.' });
    const [row] = await fx.query<{ version: number }>(
      'SELECT version FROM app.automations WHERE id = $1',
      [automationId],
    );
    await automationService().setAutomationStatus(owner, {
      id: automationId,
      expectedVersion: row!.version,
      status: 'paused',
    });
    expect(await refusalOf(enrol(owner, automationId, byTag('may'), 2))).toEqual({
      code: 'precondition_failed',
      message: 'This automation is paused.',
    });
    expect(await enrollments().enrollableAutomations(owner)).toEqual([]);
    expect(
      await fx.query('SELECT 1 FROM app.automation_enrollments WHERE automation_id = $1', [
        automationId,
      ]),
    ).toHaveLength(0);
  });

  it('ends an enrolment when the automation is paused, or its member left or lost the permission, mid-way', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Mid-way');
    await contactsOf(c, 60, 'midway');
    const started = await enrol(owner, automationId, byTag('midway'), 60);
    await processEnrollmentBatch(
      enrollmentDeps(),
      authorizedTenantScope(c.tenant.id, c.owner.id),
      started.id,
    );
    const [row] = await fx.query<{ version: number }>(
      'SELECT version FROM app.automations WHERE id = $1',
      [automationId],
    );
    const paused = await automationService().setAutomationStatus(owner, {
      id: automationId,
      expectedVersion: row!.version,
      status: 'paused',
    });
    expect(await drain(c, started.id)).toEqual(['finished']);
    expect(await enrollmentRow(started.id)).toMatchObject({
      status: 'stopped',
      end_reason: 'automation_paused',
      started_count: 50,
      cancelled_count: 10,
    });
    await automationService().setAutomationStatus(owner, {
      id: automationId,
      expectedVersion: paused.version,
      status: 'active',
    });

    // An administrator enrols contacts, then loses the right to publish automations.
    const adminUser = await createUser(fx.dbs, { name: 'Admin' });
    const { token } = await invite(fx.dbs, c.tenant, c.owner, adminUser.email, ['admin']);
    await acceptInvitation(fx.dbs, adminUser, token);
    const admin = await fx.ctx(c, adminUser);
    await contactsOf(c, 2, 'demoted');
    const demoted = await enrol(admin, automationId, byTag('demoted'), 2);
    await fx.query(
      `UPDATE app.memberships SET roles = '{marketer}' WHERE tenant_id = $1 AND user_id = $2`,
      [c.tenant.id, adminUser.id],
    );
    expect(await drain(c, demoted.id)).toEqual(['finished']);
    expect(await enrollmentRow(demoted.id)).toMatchObject({
      status: 'stopped',
      end_reason: 'member_removed',
      started_count: 0,
      cancelled_count: 2,
    });
    // The worker's clean-up when the job's member is no longer active.
    await contactsOf(c, 1, 'left');
    const left = await enrol(owner, automationId, byTag('left'), 1);
    expect(
      await endEnrollmentForRemovedMember(
        { db: fx.dbs.app, clock: systemClock },
        authorizedTenantScope(c.tenant.id, null),
        left.id,
      ),
    ).toBe(true);
    expect(await enrollmentRow(left.id)).toMatchObject({
      status: 'stopped',
      end_reason: 'member_removed',
    });
  });

  it('never enrols another company’s contacts, segment or automation, nor shows or stops its enrolments', async () => {
    const a = await fx.company();
    const b = await fx.company();
    const ownerA = await fx.ctx(a, a.owner);
    const ownerB = await fx.ctx(b, b.owner);
    const automationA = await publish(ownerA, a, 'A flow');
    const automationB = await publish(ownerB, b, 'B flow');
    const contactsA = await contactsOf(a, 2, 'shared-tag');
    await contactsOf(b, 3, 'shared-tag');
    const { id: segmentB } = await createSegmentsService({
      db: fx.dbs.app,
      clock: systemClock,
    }).createSegment(
      ownerB,
      {
        name: 'B segment',
        definition: { match: 'all', conditions: [{ type: 'tag', op: 'has', tag: 'shared-tag' }] },
      },
      {},
    );
    // B's automation and segment are not found for A.
    expect((await refusalOf(enrol(ownerA, automationB, byTag('shared-tag'), 2))).code).toBe(
      'not_found',
    );
    expect(
      (await refusalOf(enrol(ownerA, automationA, { kind: 'segment', segmentId: segmentB }, 3)))
        .code,
    ).toBe('not_found');
    // The same filter matches A's contacts only.
    const started = await enrol(ownerA, automationA, byTag('shared-tag'), 2);
    expect(new Set((await outcomesOf(started.id)).map((o) => o.contact_id))).toEqual(
      new Set(contactsA),
    );
    // B's scope sees nothing of A's enrolment, and its job in B's scope finds nothing.
    expect((await refusalOf(enrollments().getEnrollment(ownerB, started.id))).code).toBe(
      'not_found',
    );
    expect((await refusalOf(enrollments().stopEnrollment(ownerB, { id: started.id }))).code).toBe(
      'not_found',
    );
    expect(await enrollments().listEnrollments(ownerB, automationA)).toEqual([]);
    expect(
      await processEnrollmentBatch(
        enrollmentDeps(),
        authorizedTenantScope(b.tenant.id, b.owner.id),
        started.id,
      ),
    ).toEqual({ outcome: 'missing' });
    expect(await enrollmentRow(started.id)).toMatchObject({ status: 'running', started_count: 0 });
    // Row security: the runtime role in B's scope reads none of A's rows and writes none into A.
    await fx.dbs.app.run(authorizedTenantScope(b.tenant.id, b.owner.id), async (tx: Tx) => {
      const rows = await tx.execute(
        sql`select id from app.automation_enrollments where id = ${started.id}::uuid
            union all select id from app.automation_enrollment_contacts where enrollment_id = ${started.id}::uuid`,
      );
      expect(rows.rows).toEqual([]);
    });
    await expect(
      fx.dbs.app.run(authorizedTenantScope(b.tenant.id, b.owner.id), (tx: Tx) =>
        tx.execute(
          sql`insert into app.automation_enrollment_contacts (id, tenant_id, enrollment_id, position, contact_id)
              values (${uuidv7()}::uuid, ${a.tenant.id}::uuid, ${started.id}::uuid, 99, ${contactsA[0]!}::uuid)`,
        ),
      ),
    ).rejects.toThrow();
    expect(await drain(a, started.id)).toEqual(['finished']);
  });

  it('keeps the tables under forced row security with least-privilege grants, and the run’s enrolment fixed', async () => {
    const privileges = await fx.query<{ t: string; p: string; ok: boolean }>(
      `SELECT t, p, has_table_privilege('w360_app', t, p) AS ok
         FROM unnest(ARRAY['app.automation_enrollments', 'app.automation_enrollment_contacts']) t,
              unnest(ARRAY['SELECT', 'INSERT', 'DELETE', 'TRUNCATE']) p ORDER BY t, p`,
    );
    expect(privileges.map((r) => `${r.t} ${r.p} ${r.ok}`)).toEqual([
      'app.automation_enrollment_contacts DELETE false',
      'app.automation_enrollment_contacts INSERT true',
      'app.automation_enrollment_contacts SELECT true',
      'app.automation_enrollment_contacts TRUNCATE false',
      'app.automation_enrollments DELETE false',
      'app.automation_enrollments INSERT true',
      'app.automation_enrollments SELECT true',
      'app.automation_enrollments TRUNCATE false',
    ]);
    const columns = await fx.query<{ c: string; ok: boolean }>(
      `SELECT c, has_column_privilege('w360_app', 'app.automation_enrollments', c, 'UPDATE') AS ok
         FROM unnest(ARRAY['status', 'cursor_position', 'next_batch_at', 'inputs', 'automation_id', 'source',
                           'segment_id', 'total', 'created_by_membership_id', 'tenant_id']) c`,
    );
    expect(Object.fromEntries(columns.map((r) => [r.c, r.ok]))).toEqual({
      status: true,
      cursor_position: true,
      next_batch_at: true,
      inputs: true,
      automation_id: false,
      source: false,
      segment_id: false,
      total: false,
      created_by_membership_id: false,
      tenant_id: false,
    });
    const contactColumns = await fx.query<{ c: string; ok: boolean }>(
      `SELECT c, has_column_privilege('w360_app', 'app.automation_enrollment_contacts', c, 'UPDATE') AS ok
         FROM unnest(ARRAY['outcome', 'reason', 'run_id', 'processed_at', 'contact_id', 'position',
                           'enrollment_id']) c`,
    );
    expect(Object.fromEntries(contactColumns.map((r) => [r.c, r.ok]))).toEqual({
      outcome: true,
      reason: true,
      run_id: true,
      processed_at: true,
      contact_id: false,
      position: false,
      enrollment_id: false,
    });
    const security = await fx.query<{ relname: string; rls: boolean; forced: boolean }>(
      `SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class
        WHERE oid IN ('app.automation_enrollments'::regclass, 'app.automation_enrollment_contacts'::regclass)
        ORDER BY relname`,
    );
    expect(security).toEqual([
      { relname: 'automation_enrollment_contacts', rls: true, forced: true },
      { relname: 'automation_enrollments', rls: true, forced: true },
    ]);
    // Deleted with the company, as the definer role, before the rows they name.
    const steps = await fx.query<{ t: string; ordinal: number }>(
      `SELECT t::text AS t, s.ordinal FROM ops.tenant_deletion_steps s, unnest(s.tables) t
        WHERE t::text IN ('app.automation_enrollment_contacts', 'app.automation_enrollments',
                          'app.automation_runs', 'app.segments', 'app.automations') ORDER BY s.ordinal`,
    );
    expect(steps.map((s) => s.t)).toEqual([
      'app.automation_enrollment_contacts',
      'app.automation_runs',
      'app.automation_enrollments',
      'app.segments',
      'app.automations',
    ]);
    const definer = await fx.query<{ ok: boolean }>(
      `SELECT has_table_privilege('w360_definer', 'app.automation_enrollments', 'DELETE')
              AND has_table_privilege('w360_definer', 'app.automation_enrollment_contacts', 'DELETE') AS ok`,
    );
    expect(definer[0]!.ok).toBe(true);

    // A run of an api automation names its key or its enrolment, exactly one; and it stays fixed.
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Fixed');
    await contactsOf(c, 1, 'fixed');
    const started = await enrol(owner, automationId, byTag('fixed'), 1);
    await drain(c, started.id);
    const [run] = await runsOf(started.id);
    await expect(
      fx.dbs.adminPool.query('UPDATE app.automation_runs SET enrollment_id = NULL WHERE id = $1', [
        run!.id,
      ]),
    ).rejects.toThrow(/what started an automation run is fixed/);
    const client = await fx.dbs.adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('w360.allow_retention_purge', 'on', true)`);
      await expect(
        client.query('UPDATE app.automation_runs SET enrollment_id = NULL WHERE id = $1', [
          run!.id,
        ]),
      ).rejects.toThrow(/automation_runs_api_key/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const [check] = await fx.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'app.automation_runs'::regclass AND conname = 'automation_runs_api_key'`,
    );
    expect(check!.definition).toContain('num_nonnulls(api_key_id, enrollment_id)');
  });
});

let templateCounter = 0;
/** A template created, submitted and approved through the Graph stand-in, then synced. */
async function approvedTemplate(c: Company, definition: TemplateDefinition) {
  templateCounter += 1;
  const name = `enrol_tpl_${templateCounter}_${Date.now().toString(36)}`;
  const owner = await fx.ctx(c, c.owner);
  const templateDeps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock };
  const templates = createTemplatesService(templateDeps);
  const { id } = await templates.createDraft(owner, {
    whatsappAccountId: c.whatsappAccountId,
    name,
    language: 'en',
    definition,
  });
  await templates.submitTemplate(owner, id);
  const graphDeps = { ...templateDeps, keyring: fx.keyring, graph: fx.graph };
  const scope = authorizedTenantScope(c.tenant.id, null);
  expect(await processTemplateSubmit(graphDeps, scope, id)).toBe('done');
  const t = fx.standIn.state.templates.get(c.wabaId)?.find((x) => x.name === name);
  if (!t) throw new Error('template not at the stand-in');
  t.status = 'APPROVED';
  await syncTemplates(graphDeps, scope, c.whatsappAccountId);
  return id;
}

const festiveSale: TemplateDefinition = {
  category: 'MARKETING',
  header: { type: 'none' },
  body: { text: 'Hello {{1}}, our festive sale starts today.', examples: ['Asha'] },
  footer: null,
  buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions' }],
};

/**
 * The enrolments of these companies that the sweep's definer function lists. Other companies'
 * running enrolments are made not due inside a transaction that is rolled back, so the function's
 * limit and order cannot hide these companies' enrolments behind other tests'.
 */
async function dueAmong(companies: Company[]) {
  const client = await fx.dbs.adminPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE app.automation_enrollments SET next_batch_at = now()
        WHERE status = 'running' AND NOT (tenant_id = ANY($1::uuid[]))`,
      [companies.map((c) => c.tenant.id)],
    );
    const { rows } = await client.query<{
      tenant_id: string;
      enrollment_id: string;
      actor_user_id: string;
      cursor_position: number;
    }>('SELECT * FROM ops.automation_enrollments_due(100)');
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      enrollmentId: r.enrollment_id,
      actorUserId: r.actor_user_id,
      cursorPosition: r.cursor_position,
    }));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** Makes an enrolment's next batch 11 minutes overdue, as a lost or failed job leaves it. */
const overdue = (id: string) =>
  fx.query(
    `UPDATE app.automation_enrollments SET next_batch_at = now() - interval '11 minutes'
      WHERE id = $1`,
    [id],
  );

/** The waiting or running jobs of an enrolment's batch, by its key. */
const batchJobs = async (key: string) =>
  fx.query<{ state: string; delayed: boolean }>(
    `SELECT state, start_after > created_on + interval '2 seconds' AS delayed FROM pgboss.job
      WHERE name = $1 AND singleton_key = $2 AND state IN ('created', 'retry', 'active')`,
    [QUEUES.automationEnroll.name, key],
  );

/** Seconds between a waiting batch job's start and its enrolment's next batch time. */
const batchGap = async (key: string) => {
  const [row] = await fx.query<{ gap: number }>(
    `SELECT abs(extract(epoch FROM j.start_after - e.next_batch_at))::float AS gap
       FROM pgboss.job j
       JOIN app.automation_enrollments e ON e.id::text = split_part(j.singleton_key, ':', 1)
      WHERE j.name = $1 AND j.singleton_key = $2 AND j.state = 'created'`,
    [QUEUES.automationEnroll.name, key],
  );
  return row?.gap;
};

describe('enrolments after review: the sweep, pacing, consent, the job’s authorisation, merges (ADR-401)', () => {
  it('paces the next batch by the number’s send rate, and a job that comes early does nothing', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Paced');
    await contactsOf(c, 55, 'paced');
    const started = await enrol(owner, automationId, byTag('paced'), 55);
    const paced = { ...enrollmentDeps(), sendRatePerSecond: 20 };
    const scope = authorizedTenantScope(c.tenant.id, c.owner.id);
    expect(await processEnrollmentBatch(paced, scope, started.id)).toMatchObject({
      outcome: 'batch',
      started: 50,
    });
    // 50 runs at 20 a second: the next batch's job may start 2.5 seconds later, not before.
    expect(await batchJobs(`${started.id}:50`)).toEqual([{ state: 'created', delayed: true }]);
    const [row] = await fx.query<{ seconds: number }>(
      `SELECT extract(epoch FROM next_batch_at - updated_at)::float AS seconds
         FROM app.automation_enrollments WHERE id = $1`,
      [started.id],
    );
    expect(row!.seconds).toBeGreaterThan(2);
    expect(row!.seconds).toBeLessThan(3);
    // Both by the database's clock: the job starts when the batch is due, not before or long after.
    expect(await batchGap(`${started.id}:50`)).toBeLessThan(0.001);
    // Another job before then (a second chain) starts nothing and changes nothing.
    expect(await processEnrollmentBatch(paced, scope, started.id)).toMatchObject({
      outcome: 'not_due',
    });
    expect(await runsOf(started.id)).toHaveLength(50);
    expect(await enrollmentRow(started.id)).toMatchObject({
      started_count: 50,
      cursor_position: 50,
    });
    // Deferred while the company was suspended: its next batch is due at the deferred time, so the
    // sweep's job and the deferred one cannot both run before it.
    // Five minutes after the database's now, and its job queued for the same time.
    expect(
      await deferEnrollment(
        enrollmentDeps(),
        authorizedTenantScope(c.tenant.id, null),
        started.id,
        300,
      ),
    ).toBe(true);
    const [deferred] = await fx.query<{ seconds: number; gap: number }>(
      `SELECT extract(epoch FROM e.next_batch_at - now())::float AS seconds,
              abs(extract(epoch FROM j.start_after - e.next_batch_at))::float AS gap
         FROM app.automation_enrollments e
         JOIN pgboss.job j ON j.name = $2 AND j.singleton_key LIKE e.id::text || ':50:deferred:%'
        WHERE e.id = $1`,
      [started.id, QUEUES.automationEnroll.name],
    );
    expect(deferred!.seconds).toBeGreaterThan(290);
    expect(deferred!.seconds).toBeLessThanOrEqual(300);
    expect(deferred!.gap).toBeLessThan(0.001);
    expect(await processEnrollmentBatch(paced, scope, started.id)).toMatchObject({
      outcome: 'not_due',
    });
    expect(await dueAmong([c])).toEqual([]);
  });

  it('paces by the database’s clock on workers whose clocks run an hour ahead or behind', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Skewed');
    await contactsOf(c, 105, 'skewed');
    const started = await enrol(owner, automationId, byTag('skewed'), 105);
    const scope = authorizedTenantScope(c.tenant.id, c.owner.id);
    const worker = (minutesOff: number) => ({
      ...enrollmentDeps(),
      sendRatePerSecond: 20,
      clock: { now: () => new Date(Date.now() + minutesOff * 60_000) },
    });
    // Due by the database as soon as it starts, on a worker an hour ahead.
    expect(await processEnrollmentBatch(worker(60), scope, started.id)).toMatchObject({
      outcome: 'batch',
      started: 50,
    });
    // From the batch's own database time (its update's `updated_at`), not the worker's.
    const [row] = await fx.query<{ seconds: number }>(
      `SELECT extract(epoch FROM next_batch_at - updated_at)::float AS seconds
         FROM app.automation_enrollments WHERE id = $1`,
      [started.id],
    );
    expect(row!.seconds).toBeGreaterThan(2);
    expect(row!.seconds).toBeLessThanOrEqual(2.5);
    expect(await batchGap(`${started.id}:50`)).toBeLessThan(0.001);
    // Paced on a worker an hour behind too: its job before then starts nothing.
    expect(await processEnrollmentBatch(worker(-60), scope, started.id)).toMatchObject({
      outcome: 'not_due',
    });
    expect(await runsOf(started.id)).toHaveLength(50);
  });

  it('signals an enrolment whose next batch is 10 minutes overdue again, and the signal starts nobody twice', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Stalled');
    const ids = await contactsOf(c, 60, 'stalled');
    const started = await enrol(owner, automationId, byTag('stalled'), 60);
    const scope = authorizedTenantScope(c.tenant.id, c.owner.id);
    await processEnrollmentBatch(enrollmentDeps(), scope, started.id);
    // Not due yet: the next batch is paced, not overdue.
    expect(await dueAmong([c])).toEqual([]);
    // Its job ran out of retries: the next batch is now 11 minutes overdue.
    await fx.query(
      `UPDATE pgboss.job SET state = 'failed' WHERE name = $1 AND singleton_key = $2`,
      [QUEUES.automationEnroll.name, `${started.id}:50`],
    );
    await overdue(started.id);
    expect((await enrollments().getEnrollment(owner, started.id)).stalledSince).toBeInstanceOf(
      Date,
    );
    const [due] = await dueAmong([c]);
    expect(due).toEqual({
      tenantId: c.tenant.id,
      enrollmentId: started.id,
      actorUserId: c.owner.id,
      cursorPosition: 50,
    });
    // The sweep signals it under its batch's own key, counts the signal and makes it due now; a
    // second sweep finds it no longer overdue.
    expect(await resignalEnrollment(enrollmentDeps(), due!)).toBe('signalled');
    expect(await resignalEnrollment(enrollmentDeps(), due!)).toBe('skipped');
    expect(await batchJobs(`${started.id}:50`)).toEqual([{ state: 'created', delayed: false }]);
    const [counted] = await fx.query<{ resignal_count: number }>(
      'SELECT resignal_count FROM app.automation_enrollments WHERE id = $1',
      [started.id],
    );
    expect(counted!.resignal_count).toBe(1);
    // Still shown as without progress until a batch is handled.
    expect((await enrollments().getEnrollment(owner, started.id)).stalledSince).toBeInstanceOf(
      Date,
    );
    // The signalled job and two duplicates at once: one batch runs, the others find nothing.
    const all = await Promise.all(
      [0, 1, 2].map(() => processEnrollmentBatch(enrollmentDeps(), scope, started.id)),
    );
    expect(all.map((r) => r.outcome).sort()).toEqual(['ended', 'ended', 'finished']);
    const runs = await runsOf(started.id);
    expect(runs).toHaveLength(60);
    expect(new Set(runs.map((r) => r.contact_id))).toEqual(new Set(ids));
    expect((await enrollments().getEnrollment(owner, started.id)).stalledSince).toBeNull();
    expect(await dueAmong([c])).toEqual([]);
    // The due list is a definer function only the runtime role may call.
    const [grants] = await fx.query<{
      app: boolean;
      platform: boolean;
      pub: boolean;
      definer: boolean;
    }>(
      `SELECT has_function_privilege('w360_app', 'ops.automation_enrollments_due(integer)', 'EXECUTE') AS app,
              has_function_privilege('w360_platform', 'ops.automation_enrollments_due(integer)', 'EXECUTE') AS platform,
              has_function_privilege('public', 'ops.automation_enrollments_due(integer)', 'EXECUTE') AS pub,
              (SELECT prosecdef FROM pg_proc WHERE oid = 'ops.automation_enrollments_due(integer)'::regprocedure) AS definer`,
    );
    expect(grants).toEqual({ app: true, platform: false, pub: false, definer: true });
  });

  it('leaves a suspended company’s enrolments out of the due list, and shows no stall while suspended', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Suspended');
    await contactsOf(c, 1, 'suspended');
    const held = await enrol(owner, automationId, byTag('suspended'), 1);
    await overdue(held.id);
    expect((await dueAmong([c])).map((d) => d.enrollmentId)).toEqual([held.id]);
    await fx.dbs.adminPool.query(`UPDATE app.tenants SET status = 'suspended' WHERE id = $1`, [
      c.tenant.id,
    ]);
    try {
      expect(await dueAmong([c])).toEqual([]);
      const suspended = await fx.ctx(c, c.owner);
      expect((await enrollments().getEnrollment(suspended, held.id)).stalledSince).toBeNull();
    } finally {
      await fx.dbs.adminPool.query(`UPDATE app.tenants SET status = 'active' WHERE id = $1`, [
        c.tenant.id,
      ]);
    }
    expect((await enrollments().getEnrollment(owner, held.id)).stalledSince).toBeInstanceOf(Date);
    await drain(c, held.id);
  });

  it('ends an enrolment as failed after three signals without progress, its started runs untouched', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Always failing');
    await contactsOf(c, 60, 'failing');
    const started = await enrol(owner, automationId, byTag('failing'), 60);
    await processEnrollmentBatch(
      enrollmentDeps(),
      authorizedTenantScope(c.tenant.id, c.owner.id),
      started.id,
    );
    // Each of its next batch's jobs fails all its retries: the sweep signals it three times.
    for (let i = 1; i <= 3; i += 1) {
      await overdue(started.id);
      const [due] = await dueAmong([c]);
      expect(await resignalEnrollment(enrollmentDeps(), due!)).toBe('signalled');
    }
    await overdue(started.id);
    const [due] = await dueAmong([c]);
    expect(await resignalEnrollment(enrollmentDeps(), due!)).toBe('failed');
    expect(await enrollmentRow(started.id)).toMatchObject({
      status: 'failed',
      end_reason: 'stalled',
      started_count: 50,
      cancelled_count: 10,
      inputs: {},
    });
    const detail = await enrollments().getEnrollment(owner, started.id);
    expect(detail).toMatchObject({ status: 'failed', endReason: 'stalled', stalledSince: null });
    const [active] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.automation_runs
        WHERE enrollment_id = $1 AND status IN ('running', 'waiting')`,
      [started.id],
    );
    expect(active!.n).toBe(50);
    expect(
      await fx.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM app.audit_events
          WHERE subject_id = $1 AND action = 'automation.enrollment_ended'`,
        [started.id],
      ),
    ).toEqual([{ metadata: expect.objectContaining({ status: 'failed', reason: 'stalled' }) }]);
    // A batch that ever handles a contact starts the count again.
    await contactsOf(c, 60, 'recovering');
    const recovering = await enrol(owner, automationId, byTag('recovering'), 60);
    await overdue(recovering.id);
    const [first] = await dueAmong([c]);
    expect(await resignalEnrollment(enrollmentDeps(), first!)).toBe('signalled');
    await processEnrollmentBatch(
      enrollmentDeps(),
      authorizedTenantScope(c.tenant.id, c.owner.id),
      recovering.id,
    );
    const [reset] = await fx.query<{ resignal_count: number }>(
      'SELECT resignal_count FROM app.automation_enrollments WHERE id = $1',
      [recovering.id],
    );
    expect(reset!.resignal_count).toBe(0);
  });

  it('checks marketing consent when each run of a marketing automation starts', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const template = await approvedTemplate(c, festiveSale);
    const svc = automationService();
    const { id: automationId } = await svc.createAutomation(owner, { name: 'Festive sale' });
    const saved = await svc.updateAutomation(owner, {
      id: automationId,
      expectedVersion: 0,
      name: 'Festive sale',
      description: null,
      channelAccountId: c.channelAccountId,
      trigger: apiTrigger,
      graph: {
        version: 1,
        start: 'sale',
        nodes: [
          {
            id: 'sale',
            type: 'send_template',
            templateId: template,
            header: [],
            body: ['{{input.campaign}}'],
            next: null,
          },
        ],
      },
    });
    expect(saved.issues.filter((i) => i.level === 'error')).toEqual([]);
    await svc.publishAutomation(owner, {
      id: automationId,
      expectedVersion: saved.version,
      note: null,
    });
    const [optedIn, unknown, optedOut] = await contactsOf(c, 3, 'promo');
    const consent = createConsentService({ db: fx.dbs.app, clock: systemClock });
    await consent.recordConsent(owner, {
      contactId: optedIn!,
      purpose: 'marketing',
      action: 'opt_in',
      note: 'At the counter',
    });
    await consent.recordConsent(owner, {
      contactId: optedOut!,
      purpose: 'marketing',
      action: 'opt_out',
    });
    const started = await enrol(owner, automationId, byTag('promo'), 3);
    await drain(c, started.id);
    const outcomes = await outcomesOf(started.id);
    const of = (id: string) => outcomes.find((o) => o.contact_id === id);
    // The company requires a marketing opt-in (the default): only the contact who gave one starts.
    expect([of(optedIn!)?.outcome, of(unknown!)?.reason, of(optedOut!)?.reason]).toEqual([
      'started',
      'no_marketing_opt_in',
      'opted_out',
    ]);
  });

  it('runs the worker’s authorisation of the job: deferred while suspended, ended when its member left', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Authorised');
    await contactsOf(c, 2, 'authorised');
    const adminUser = await createUser(fx.dbs, { name: 'Admin' });
    const { token } = await invite(fx.dbs, c.tenant, c.owner, adminUser.email, ['admin']);
    await acceptInvitation(fx.dbs, adminUser, token);
    const started = await enrol(await fx.ctx(c, adminUser), automationId, byTag('authorised'), 2);
    const [job] = await fx.query<{ data: unknown }>(
      `SELECT data FROM pgboss.job WHERE name = $1 AND singleton_key = $2`,
      [QUEUES.automationEnroll.name, `${started.id}:0`],
    );
    const options = {
      expectedKind: 'automation.enroll',
      requireActiveTenant: true,
      requireActiveActor: true,
    };
    const authorised = await authorizeJob(
      { db: fx.dbs.app, signer: fx.signer },
      job!.data,
      options,
    );
    expect(authorised).toMatchObject({
      outcome: 'authorized',
      envelope: { ref: started.id, actorUserId: adminUser.id },
    });
    await fx.dbs.adminPool.query(`UPDATE app.tenants SET status = 'suspended' WHERE id = $1`, [
      c.tenant.id,
    ]);
    try {
      expect(
        await authorizeJob({ db: fx.dbs.app, signer: fx.signer }, job!.data, options),
      ).toMatchObject({
        outcome: 'deferred',
      });
    } finally {
      await fx.dbs.adminPool.query(`UPDATE app.tenants SET status = 'active' WHERE id = $1`, [
        c.tenant.id,
      ]);
    }
    expect(await runsOf(started.id)).toHaveLength(0);
    // Another kind of job, or a tampered one, is refused.
    expect(
      await authorizeJob({ db: fx.dbs.app, signer: fx.signer }, job!.data, {
        ...options,
        expectedKind: 'automation.run',
      }),
    ).toMatchObject({ outcome: 'rejected', reason: 'unexpected_kind' });
    // The member leaves: the job is refused with a scope for the clean-up, which ends the enrolment.
    await fx.query(
      `UPDATE app.memberships SET status = 'removed' WHERE tenant_id = $1 AND user_id = $2`,
      [c.tenant.id, adminUser.id],
    );
    const removed = await authorizeJob({ db: fx.dbs.app, signer: fx.signer }, job!.data, options);
    expect(removed).toMatchObject({ outcome: 'rejected', reason: 'actor_not_member' });
    if (removed.outcome !== 'rejected' || !('cleanupScope' in removed))
      throw new Error('no clean-up');
    expect(
      await endEnrollmentForRemovedMember(
        { db: fx.dbs.app, clock: systemClock },
        removed.cleanupScope,
        removed.envelope.ref,
      ),
    ).toBe(true);
    expect(await enrollmentRow(started.id)).toMatchObject({
      status: 'stopped',
      end_reason: 'member_removed',
      cancelled_count: 2,
      inputs: {},
    });
    expect(await runsOf(started.id)).toHaveLength(0);
  });

  it('refuses a contact merged away after the snapshot as gone, and one without a number', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Merged');
    const [kept] = await contactsOf(c, 1, 'kept');
    const phoneless: string[] = [];
    await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), async (tx: Tx) => {
      for (const name of ['Duplicate', 'No number']) {
        const id = await contactForPhone(tx, c.tenant.id, {
          phoneE164: null,
          displayName: name,
          source: 'manual',
        });
        await tx
          .insert(contactTags)
          .values({ id: uuidv7(), tenantId: c.tenant.id, contactId: id, tag: 'merging' });
        phoneless.push(id);
      }
    });
    const started = await enrol(owner, automationId, byTag('merging'), 2);
    // The duplicate is merged into the contact with the number: app.merge_contacts deletes it.
    await createContactMergeService({ db: fx.dbs.app, clock: systemClock }).mergeContacts(owner, {
      keepContactId: kept!,
      mergeContactId: phoneless[0]!,
    });
    const before = await fx.query<{ contact_id: string | null }>(
      `SELECT contact_id FROM app.automation_enrollment_contacts WHERE enrollment_id = $1 ORDER BY position`,
      [started.id],
    );
    expect(before.map((r) => r.contact_id).filter((x) => x === null)).toHaveLength(1);
    await drain(c, started.id);
    expect((await outcomesOf(started.id)).map((o) => o.reason).sort()).toEqual([
      'contact_gone',
      'no_number',
    ]);
    expect(await runsOf(started.id)).toHaveLength(0);
  });

  it('validates the run’s check and foreign key (0312) and indexes the runs by their enrolment', async () => {
    const constraints = await fx.query<{ conname: string; validated: boolean }>(
      `SELECT conname, convalidated AS validated FROM pg_constraint
        WHERE conrelid = 'app.automation_runs'::regclass
          AND conname IN ('automation_runs_api_key', 'automation_runs_enrollment_fk') ORDER BY conname`,
    );
    expect(constraints).toEqual([
      { conname: 'automation_runs_api_key', validated: true },
      { conname: 'automation_runs_enrollment_fk', validated: true },
    ]);
    const [index] = await fx.query<{ definition: string }>(
      `SELECT pg_get_indexdef('app.automation_runs_enrollment_idx'::regclass) AS definition`,
    );
    expect(index!.definition).toContain(
      '(tenant_id, enrollment_id) WHERE (enrollment_id IS NOT NULL)',
    );
    // The foreign key's check, as PostgreSQL runs it, can use the partial index.
    const client = await fx.dbs.adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query(
        `PREPARE ri_probe(uuid, uuid) AS SELECT 1 FROM ONLY app.automation_runs x
          WHERE tenant_id = $1 AND enrollment_id = $2 FOR KEY SHARE OF x`,
      );
      await client.query(`SET LOCAL plan_cache_mode = force_generic_plan`);
      const plan = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN EXECUTE ri_probe('${uuidv7()}', '${uuidv7()}')`,
      );
      expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(
        'automation_runs_enrollment_idx',
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('an enrolment’s contacts with their outcomes (ADR-408)', () => {
  const list = (ctx: TenantContext, automationId: string, id: string, input: unknown = {}) =>
    enrollments().listEnrolledContacts(ctx, automationId, id, input);
  async function codeOf(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      if (isAppError(error)) return error.code;
      throw error;
    }
    throw new Error('expected a refusal');
  }

  it('lists each contact in position order with its outcome, reason, run and time, by outcome', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Listed');
    const [first, second, suppressed, erased] = await contactsOf(c, 4, 'listed');
    await createConsentService({ db: fx.dbs.app, clock: systemClock }).addSuppression(owner, {
      phone: await phoneOf(suppressed!),
      reason: 'manual',
    });
    const started = await enrol(owner, automationId, byTag('listed'), 4);
    // Erased after the snapshot: refused as erased, and listed as an erased contact.
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: erased!,
      suppress: false,
    });
    // Before any batch, every contact waits.
    const waiting = await list(owner, automationId, started.id);
    expect(waiting.items.map((i) => [i.position, i.outcome, i.processedAt])).toEqual([
      [1, 'pending', null],
      [2, 'pending', null],
      [3, 'pending', null],
      [4, 'pending', null],
    ]);
    expect(await drain(c, started.id)).toEqual(['finished']);

    const stored = await outcomesOf(started.id);
    const page = await list(owner, automationId, started.id);
    expect(page.nextCursor).toBeNull();
    expect(
      page.items.map((i) => [
        i.position,
        i.contactId,
        i.contact,
        i.outcome,
        i.reason,
        i.runId,
        i.processedAt instanceof Date,
      ]),
    ).toEqual([
      [1, first, 'active', 'started', null, stored[0]!.run_id, true],
      [2, second, 'active', 'started', null, stored[1]!.run_id, true],
      [3, suppressed, 'active', 'refused', 'suppressed', null, true],
      [4, null, 'erased', 'refused', 'contact_erased', null, true],
    ]);
    expect(stored[0]!.run_id).not.toBeNull();
    expect(page.items[0]).toMatchObject({ name: expect.stringMatching(/^Contact /) });
    expect(page.items[0]!.phone).toBe(await phoneOf(first!));
    expect(page.items[3]).toMatchObject({ name: null, phone: null, reasonLabel: 'Erased' });
    expect(page.items[2]!.reasonLabel).toBe('On the suppression list');

    // By outcome: exactly the contacts the enrolment's counts count.
    const positions = async (outcome: string) =>
      (await list(owner, automationId, started.id, { outcome })).items.map((i) => i.position);
    expect(await positions('started')).toEqual([1, 2]);
    expect(await positions('refused')).toEqual([3, 4]);
    expect(await positions('pending')).toEqual([]);
    expect(await positions('cancelled')).toEqual([]);
    expect(await enrollments().getEnrollment(owner, started.id)).toMatchObject({
      started: 2,
      refused: 2,
    });
  });

  it('pages 50 contacts at a time, and filtered pages never skip or repeat one', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Paged');
    const ids = await contactsOf(c, 53, 'paged');
    const started = await enrol(owner, automationId, byTag('paged'), 53);
    const first = await list(owner, automationId, started.id);
    expect(first.items.map((i) => i.position)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(first.items.map((i) => i.contactId)).toEqual(ids.slice(0, 50));
    expect(first.nextCursor).toBe('50');
    const second = await list(owner, automationId, started.id, { cursor: first.nextCursor });
    expect(second.items.map((i) => i.position)).toEqual([51, 52, 53]);
    expect(second.nextCursor).toBeNull();
    // The first batch handles 50; the 3 after it still wait, on one page of their own.
    await dueNow(started.id);
    await processEnrollmentBatch(
      enrollmentDeps(),
      authorizedTenantScope(c.tenant.id, c.owner.id),
      started.id,
    );
    const pending = await list(owner, automationId, started.id, { outcome: 'pending' });
    expect(pending).toMatchObject({ nextCursor: null });
    expect(pending.items.map((i) => i.position)).toEqual([51, 52, 53]);
    // Exactly 50 started: one full page and no next one.
    const startedPage = await list(owner, automationId, started.id, { outcome: 'started' });
    expect(startedPage.items.map((i) => i.position)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    expect(startedPage.nextCursor).toBeNull();
    // After the 2nd pending contact, only the 3rd.
    expect(
      (await list(owner, automationId, started.id, { outcome: 'pending', cursor: '52' })).items.map(
        (i) => i.position,
      ),
    ).toEqual([53]);
    // Stopping cancels the waiting contacts, listed as not started.
    await enrollments().stopEnrollment(owner, { id: started.id });
    expect(
      (await list(owner, automationId, started.id, { outcome: 'cancelled' })).items.map(
        (i) => i.position,
      ),
    ).toEqual([51, 52, 53]);
  });

  it('needs contacts.read beside automations.read, masks numbers as elsewhere, and finds no other automation’s or company’s enrolment', async () => {
    const a = await fx.company();
    const b = await fx.company();
    const ownerA = await fx.ctx(a, a.owner);
    const ownerB = await fx.ctx(b, b.owner);
    const automationA = await publish(ownerA, a, 'A list');
    const otherA = await publish(ownerA, a, 'A other');
    const automationB = await publish(ownerB, b, 'B list');
    const [contactA] = await contactsOf(a, 1, 'seen');
    await contactsOf(b, 1, 'seen');
    const enrolledA = await enrol(ownerA, automationA, byTag('seen'), 1);
    const enrolledB = await enrol(ownerB, automationB, byTag('seen'), 1);

    // An analyst sees the enrolment, but not its contacts (no contacts.read).
    const analystUser = await createUser(fx.dbs, { name: 'Analyst' });
    const analystInvite = await invite(fx.dbs, a.tenant, a.owner, analystUser.email, ['analyst']);
    await acceptInvitation(fx.dbs, analystUser, analystInvite.token);
    const analyst = await fx.ctx(a, analystUser);
    expect(await enrollments().getEnrollment(analyst, enrolledA.id)).toMatchObject({ total: 1 });
    expect(await codeOf(list(analyst, automationA, enrolledA.id))).toBe('forbidden');

    // A marketer whose role the company masks sees the number masked, as on the Contacts page.
    const marketerUser = await createUser(fx.dbs, { name: 'Marketer' });
    const marketerInvite = await invite(fx.dbs, a.tenant, a.owner, marketerUser.email, [
      'marketer',
    ]);
    await acceptInvitation(fx.dbs, marketerUser, marketerInvite.token);
    await fx.query(`UPDATE app.tenants SET masked_number_roles = '{marketer}' WHERE id = $1`, [
      a.tenant.id,
    ]);
    const marketer = await fx.ctx(a, marketerUser);
    const [shown] = (await list(marketer, automationA, enrolledA.id)).items;
    expect(shown).toMatchObject({
      contactId: contactA,
      phone: maskPhoneNumber(await phoneOf(contactA!)),
    });

    // Another company's enrolment, and this company's under another automation, are not found.
    expect(await codeOf(list(ownerA, automationB, enrolledB.id))).toBe('not_found');
    expect(await codeOf(list(ownerA, automationA, enrolledB.id))).toBe('not_found');
    expect(await codeOf(list(ownerA, otherA, enrolledA.id))).toBe('not_found');
    expect((await list(ownerB, automationB, enrolledB.id)).items).toHaveLength(1);
    await drain(a, enrolledA.id);
    await drain(b, enrolledB.id);
  });

  it('is served by 0311’s unique key on (tenant_id, enrollment_id, position), with or without an outcome', async () => {
    const client = await fx.dbs.adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      for (const outcome of ['', `AND outcome = 'refused'`]) {
        const plan = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT position FROM app.automation_enrollment_contacts
            WHERE tenant_id = '${uuidv7()}' AND enrollment_id = '${uuidv7()}' ${outcome}
              AND position > 50 ORDER BY position LIMIT 51`,
        );
        expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(
          'automation_enrollment_contacts_position_uq',
        );
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
