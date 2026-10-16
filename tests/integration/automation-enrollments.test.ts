import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7 } from '@w360/core';
import { QUEUES, type JobEnvelope, type QueueName } from '@w360/contracts';
import { authorizedTenantScope, contactTags, conversations, sql, type Tx } from '@w360/db';
import {
  RUN_BUDGETS,
  advanceAutomationRun,
  contactForPhone,
  createAutomationEnrollmentService,
  createAutomationService,
  createConsentService,
  createContactsService,
  createPlanAdminService,
  createSegmentsService,
  createWebhooksService,
  dayOf,
  endEnrollmentForRemovedMember,
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
 * grants, and the run's record of its enrolment.
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

/** Runs the enrolment's batches the way the worker does, until it ends. */
async function drain(c: Company, enrollmentId: string, jobs: JobQueue = fx.jobs()) {
  const outcomes: string[] = [];
  for (let i = 0; i < 300; i += 1) {
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
        WHERE tenant_id = $1 AND subject_id = $2 ORDER BY created_at`,
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
    expect(first).toEqual({ outcome: 'batch', started: 50, refused: 0 });
    // Two jobs for the next batch at once (a duplicate signal): the row lock makes them take turns,
    // and the second finds nothing left.
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
      `SELECT action, metadata FROM app.audit_events WHERE subject_id = $1 ORDER BY created_at`,
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
         FROM unnest(ARRAY['status', 'cursor_position', 'inputs', 'automation_id', 'source',
                           'segment_id', 'total', 'created_by_membership_id', 'tenant_id']) c`,
    );
    expect(Object.fromEntries(columns.map((r) => [r.c, r.ok]))).toEqual({
      status: true,
      cursor_position: true,
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
