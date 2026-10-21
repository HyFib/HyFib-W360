import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, sha256Hex, systemClock, uuidv7 } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import { authorizedTenantScope, contactTags, type ApiScope, type Tx } from '@w360/db';
import {
  apiGetEnrollment,
  apiListEnrollments,
  apiStartEnrollment,
  apiStopEnrollment,
  authenticateApiToken,
  authorizeJob,
  contactForPhone,
  createApiKeysService,
  createAutomationEnrollmentService,
  createAutomationService,
  createSegmentsService,
  processEnrollmentBatch,
  type ApiContext,
  type ApiKeysService,
  type AutomationTrigger,
  type TenantContext,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Enrolling contacts in an automation through the public API (ADR-403) against real PostgreSQL and
 * pg-boss: a key's enrolment runs its batches as a member's does (ADR-401), acting for the company;
 * another company's automation, segment and enrolment are not found; missing scopes are refused; a
 * key revoked mid-way ends the enrolment at its next batch; an Idempotency-Key replays the answer;
 * a key stops any running enrolment; members see keys' enrolments and keys members'; the table's
 * starter check, foreign keys and grants (migration 0315).
 */
let fx: WhatsAppFixture;
let keys: ApiKeysService;
beforeAll(async () => {
  fx = await startWhatsAppFixture();
  keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
});
afterAll(async () => {
  await fx?.close();
});

const deps = () => ({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });
const idem = (key: string, request: unknown) => ({
  key,
  requestHash: sha256Hex(JSON.stringify(request)),
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
  const svc = createAutomationService(deps());
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
        phoneE164: `+91971${String(phoneCounter).padStart(7, '0')}`,
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

/** A key of the company created by its owner, and the context a request with it gets. */
async function apiKey(c: Company, scopes: ApiScope[], name = 'Booking system') {
  const owner = await fx.ctx(c, c.owner);
  const created = await keys.create(owner, { name, scopes, expiresInDays: 0 });
  const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
  if (!ctx) throw new Error('a new key does not authenticate');
  return { id: created.id, ctx };
}

const ENROLLER: ApiScope[] = ['automations.start', 'contacts.read', 'campaigns.read'];
const byTag = (tag: string) => ({
  contacts: { conditions: [{ type: 'tag', op: 'has', tag }] },
  inputs: { campaign: 'Diwali' },
});

async function enrolThroughApi(
  ctx: ApiContext,
  automationId: string,
  body: unknown,
  key = uuidv7(),
) {
  const res = await apiStartEnrollment(deps(), ctx, automationId, body, idem(key, body));
  return { ...res, data: (res.body as { data: { id: string; total: number } }).data };
}

/** Makes a running enrolment's paced next batch due now, as the wait for its job leaves it. */
const dueNow = (id: string) =>
  fx.query(
    `UPDATE app.automation_enrollments SET next_batch_at = now()
      WHERE id = $1 AND status = 'running' AND next_batch_at > now()`,
    [id],
  );

/** Runs the enrolment's batches the way the worker does (acting for the company), until it ends. */
async function drain(c: Company, enrollmentId: string) {
  const outcomes: string[] = [];
  for (let i = 0; i < 300; i += 1) {
    await dueNow(enrollmentId);
    const result = await processEnrollmentBatch(
      deps(),
      authorizedTenantScope(c.tenant.id, null),
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
      cancelled_count: number;
      created_by_membership_id: string | null;
      created_by_user_id: string | null;
      created_by_api_key_id: string | null;
      stopped_by_api_key_id: string | null;
      inputs: Record<string, string>;
    }>(
      `SELECT status, end_reason, total, started_count, cancelled_count, created_by_membership_id,
              created_by_user_id, created_by_api_key_id, stopped_by_api_key_id, inputs
         FROM app.automation_enrollments WHERE id = $1`,
      [id],
    )
  )[0]!;

const runsOf = (enrollmentId: string) =>
  fx.query<{ id: string; api_key_id: string | null; trigger_type: string }>(
    `SELECT id, api_key_id, trigger_type FROM app.automation_runs WHERE enrollment_id = $1`,
    [enrollmentId],
  );

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { code: error.code, reason: error.details?.apiReason, message: error.publicMessage };
  }
  throw new Error('expected a refusal');
}

describe('enrolling contacts through the public API (ADR-403)', () => {
  it('runs a key’s enrolment in batches acting for the company, and shows it to members and keys', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'API follow-up');
    await contactsOf(c, 55, 'festival');
    await contactsOf(c, 2, 'other');
    const { id: keyId, ctx } = await apiKey(c, ENROLLER);

    const started = await enrolThroughApi(ctx, automationId, byTag('festival'));
    expect(started.status).toBe(201);
    expect(started.data).toMatchObject({
      total: 55,
      status: 'running',
      startedBy: 'api',
      apiKeyId: keyId,
      pending: 55,
    });
    expect(await enrollmentRow(started.data.id)).toMatchObject({
      created_by_membership_id: null,
      created_by_user_id: null,
      created_by_api_key_id: keyId,
      inputs: { campaign: 'Diwali' },
    });
    // The first job is signed with no user and is authorised for the company (no member to check).
    const [job] = await fx.query<{ data: unknown }>(
      `SELECT data FROM pgboss.job WHERE name = $1 AND singleton_key = $2`,
      [QUEUES.automationEnroll.name, `${started.data.id}:0`],
    );
    const auth = await authorizeJob({ db: fx.dbs.app, signer: fx.signer }, job!.data, {
      expectedKind: 'automation.enroll',
      requireActiveTenant: true,
      requireActiveActor: true,
    });
    expect(auth).toMatchObject({
      outcome: 'authorized',
      envelope: { actorUserId: null, ref: started.data.id },
    });

    expect(await drain(c, started.data.id)).toEqual(['batch', 'finished']);
    expect(await enrollmentRow(started.data.id)).toMatchObject({
      status: 'completed',
      started_count: 55,
      inputs: {},
    });
    const runs = await runsOf(started.data.id);
    expect(runs).toHaveLength(55);
    // Runs name the enrolment, which names the key; never the key itself (ADR-403).
    expect(runs.every((r) => r.trigger_type === 'api' && r.api_key_id === null)).toBe(true);

    // Through the API: the list, newest first, on keyset pages; and the enrolment's progress.
    const memberStarted = await createAutomationEnrollmentService(deps()).startEnrollment(owner, {
      automationId,
      audience: { kind: 'contacts', filter: { tag: 'other' } },
      inputs: { campaign: 'Holi' },
      expectedCount: 2,
    });
    const reader = (await apiKey(c, ['automations.start'], 'Reader')).ctx;
    const first = await apiListEnrollments(deps(), reader, automationId, { limit: '1' });
    expect(first.data.map((e) => [e.id, e.startedBy])).toEqual([[memberStarted.id, 'member']]);
    expect(first.data[0]?.apiKeyId).toBeNull();
    const second = await apiListEnrollments(deps(), reader, automationId, {
      limit: '1',
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.data.map((e) => [e.id, e.startedBy])).toEqual([[started.data.id, 'api']]);
    expect(second.nextCursor).toBeNull();
    expect(await apiGetEnrollment(deps(), reader, automationId, started.data.id)).toMatchObject({
      status: 'completed',
      started: 55,
      pending: 0,
      refusals: [],
      stalledSince: null,
    });

    // Members' pages name the key.
    const detail = await createAutomationEnrollmentService(deps()).getEnrollment(
      owner,
      started.data.id,
    );
    expect(detail).toMatchObject({ startedBy: 'api', createdByKeyName: 'Booking system' });
    const run = await createAutomationService(deps()).getRun(owner, runs[0]!.id);
    expect(run).toMatchObject({ enrolledByKeyName: 'Booking system', enrolledByName: null });
    await drain(c, memberStarted.id);
  });

  it('enrols a segment’s members, and replays the answer for the same Idempotency-Key', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Segment flow');
    await contactsOf(c, 3, 'vip');
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
    const { ctx } = await apiKey(c, ENROLLER);
    const body = { segmentId, inputs: { campaign: 'Diwali' } };
    const first = await apiStartEnrollment(deps(), ctx, automationId, body, idem('seg-1', body));
    expect(first).toMatchObject({ status: 201, replayed: false });
    const again = await apiStartEnrollment(deps(), ctx, automationId, body, idem('seg-1', body));
    expect(again).toMatchObject({ status: 201, replayed: true, body: first.body });
    const id = (first.body as { data: { id: string } }).data.id;
    expect(
      await fx.query(`SELECT id FROM app.automation_enrollments WHERE automation_id = $1`, [
        automationId,
      ]),
    ).toHaveLength(1);
    expect(await enrollmentRow(id)).toMatchObject({ total: 3 });
    // The same key with another request is refused.
    const other = { ...body, inputs: { campaign: 'Holi' } };
    expect(
      await refusalOf(apiStartEnrollment(deps(), ctx, automationId, other, idem('seg-1', other))),
    ).toMatchObject({ code: 'validation_failed', reason: 'idempotency_key_reused' });
    // A second enrolment while one runs: 409 naming it, enrolling nothing.
    expect(
      await refusalOf(
        enrolThroughApi(ctx, automationId, { contacts: {}, inputs: { campaign: 'x' } }),
      ),
    ).toMatchObject({
      code: 'conflict',
      reason: 'enrollment_running',
      message: expect.stringContaining(id),
    });
    expect(await drain(c, id)).toEqual(['finished']);
  });

  it('refuses missing scopes and never finds another company’s automation, segment or enrolment', async () => {
    const a = await fx.company();
    const b = await fx.company();
    const ownerA = await fx.ctx(a, a.owner);
    const ownerB = await fx.ctx(b, b.owner);
    const automationA = await publish(ownerA, a, 'A flow');
    const automationB = await publish(ownerB, b, 'B flow');
    await contactsOf(a, 2, 'shared');
    await contactsOf(b, 2, 'shared');
    const { id: segmentB } = await createSegmentsService({
      db: fx.dbs.app,
      clock: systemClock,
    }).createSegment(
      ownerB,
      {
        name: 'B segment',
        definition: { match: 'all', conditions: [{ type: 'tag', op: 'has', tag: 'shared' }] },
      },
      {},
    );
    const keyA = (await apiKey(a, ENROLLER)).ctx;
    const keyB = (await apiKey(b, ENROLLER)).ctx;

    // Scopes.
    const noContacts = (await apiKey(a, ['automations.start'], 'Starter')).ctx;
    expect(
      await refusalOf(enrolThroughApi(noContacts, automationA, byTag('shared'))),
    ).toMatchObject({
      code: 'forbidden',
    });
    const noSegments = (await apiKey(a, ['automations.start', 'contacts.read'], 'No segments')).ctx;
    expect(
      await refusalOf(
        enrolThroughApi(noSegments, automationA, {
          segmentId: segmentB,
          inputs: { campaign: 'x' },
        }),
      ),
    ).toMatchObject({ code: 'forbidden' });
    const reader = (await apiKey(a, ['contacts.read'], 'Reader')).ctx;
    expect(await refusalOf(apiListEnrollments(deps(), reader, automationA, {}))).toMatchObject({
      code: 'forbidden',
    });

    // Another company's automation, segment and enrolment.
    expect(await refusalOf(enrolThroughApi(keyA, automationB, byTag('shared')))).toMatchObject({
      code: 'not_found',
    });
    expect(
      await refusalOf(
        enrolThroughApi(keyA, automationA, { segmentId: segmentB, inputs: { campaign: 'x' } }),
      ),
    ).toMatchObject({ code: 'not_found' });
    const startedB = await enrolThroughApi(keyB, automationB, byTag('shared'));
    expect(await refusalOf(apiListEnrollments(deps(), keyA, automationB, {}))).toMatchObject({
      code: 'not_found',
    });
    expect(
      await refusalOf(apiGetEnrollment(deps(), keyA, automationB, startedB.data.id)),
    ).toMatchObject({ code: 'not_found' });
    // Its id under A's own automation is not found either.
    expect(
      await refusalOf(apiGetEnrollment(deps(), keyA, automationA, startedB.data.id)),
    ).toMatchObject({ code: 'not_found' });
    expect(
      await refusalOf(apiStopEnrollment(deps(), keyA, automationA, startedB.data.id)),
    ).toMatchObject({ code: 'not_found' });
    expect(await enrollmentRow(startedB.data.id)).toMatchObject({ status: 'running' });
    // A's key enrols only A's contacts.
    const startedA = await enrolThroughApi(keyA, automationA, byTag('shared'));
    expect(startedA.data.total).toBe(2);
    await drain(a, startedA.data.id);
    await drain(b, startedB.data.id);
  });

  it('ends a key’s enrolment at its next batch once the key is revoked', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Revoked');
    await contactsOf(c, 60, 'revoke');
    const { id: keyId, ctx } = await apiKey(c, ENROLLER);
    const started = await enrolThroughApi(ctx, automationId, byTag('revoke'));
    const first = await processEnrollmentBatch(
      deps(),
      authorizedTenantScope(c.tenant.id, null),
      started.data.id,
    );
    expect(first).toMatchObject({ outcome: 'batch', started: 50 });
    await keys.revoke(owner, { keyId });
    await dueNow(started.data.id);
    const next = await processEnrollmentBatch(
      deps(),
      authorizedTenantScope(c.tenant.id, null),
      started.data.id,
    );
    expect(next).toMatchObject({
      outcome: 'finished',
      status: 'stopped',
      reason: 'api_key_revoked',
    });
    expect(await enrollmentRow(started.data.id)).toMatchObject({
      status: 'stopped',
      end_reason: 'api_key_revoked',
      started_count: 50,
      cancelled_count: 10,
      inputs: {},
    });
    expect(await runsOf(started.data.id)).toHaveLength(50);
    const [ended] = await fx.query<{ actor_type: string; metadata: { reason: string } }>(
      `SELECT actor_type, metadata FROM app.audit_events
        WHERE subject_id = $1 AND action = 'automation.enrollment_ended' ORDER BY occurred_at, id`,
      [started.data.id],
    );
    expect(ended).toMatchObject({ actor_type: 'system', metadata: { reason: 'api_key_revoked' } });
  });

  it('stops a running enrolment as the key, a member’s included; an ended one answers 409', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Stopped');
    await contactsOf(c, 3, 'stop');
    const member = await createAutomationEnrollmentService(deps()).startEnrollment(owner, {
      automationId,
      audience: { kind: 'contacts', filter: { tag: 'stop' } },
      inputs: { campaign: 'Diwali' },
      expectedCount: 3,
    });
    const { id: keyId, ctx } = await apiKey(c, ['automations.start'], 'Stopper');
    const stopped = await apiStopEnrollment(deps(), ctx, automationId, member.id);
    expect(stopped).toMatchObject({
      status: 'stopped',
      endReason: 'stopped_by_api',
      startedBy: 'member',
      stoppedBy: 'api',
      stoppedByApiKeyId: keyId,
      cancelled: 3,
      pending: 0,
    });
    expect(await enrollmentRow(member.id)).toMatchObject({
      stopped_by_api_key_id: keyId,
      inputs: {},
    });
    expect(await runsOf(member.id)).toHaveLength(0);
    // A batch after the stop starts nobody.
    expect(
      await processEnrollmentBatch(deps(), authorizedTenantScope(c.tenant.id, null), member.id),
    ).toEqual({ outcome: 'ended' });
    expect(await refusalOf(apiStopEnrollment(deps(), ctx, automationId, member.id))).toMatchObject({
      code: 'conflict',
      reason: 'enrollment_ended',
    });
    const [audit] = await fx.query<{ actor_type: string; actor_id: string }>(
      `SELECT actor_type, actor_id FROM app.audit_events
        WHERE subject_id = $1 AND action = 'automation.enrollment_stopped'`,
      [member.id],
    );
    expect(audit).toEqual({ actor_type: 'api_key', actor_id: keyId });
    // The member's page names the key that stopped it.
    expect(
      await createAutomationEnrollmentService(deps()).getEnrollment(owner, member.id),
    ).toMatchObject({ stoppedByName: null, stoppedByKeyName: 'Stopper' });
  });

  it('keeps exactly one starter per enrolment, with the new columns’ foreign keys and grants (0315)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const automationId = await publish(owner, c, 'Checked');
    await contactsOf(c, 1, 'checked');
    const { id: keyId, ctx } = await apiKey(c, ENROLLER);
    const started = await enrolThroughApi(ctx, automationId, byTag('checked'));
    // Naming a member too, or neither, is refused.
    await expect(
      fx.dbs.adminPool.query(
        `UPDATE app.automation_enrollments
            SET created_by_membership_id = $2, created_by_user_id = $3 WHERE id = $1`,
        [started.data.id, owner.membership.id, c.owner.id],
      ),
    ).rejects.toThrow(/automation_enrollments_starter/);
    await expect(
      fx.dbs.adminPool.query(
        `UPDATE app.automation_enrollments SET created_by_api_key_id = NULL WHERE id = $1`,
        [started.data.id],
      ),
    ).rejects.toThrow(/automation_enrollments_starter/);
    // Another company's key cannot be named.
    const other = await fx.company();
    const { id: otherKey } = await apiKey(other, ENROLLER);
    await expect(
      fx.dbs.adminPool.query(
        `UPDATE app.automation_enrollments SET created_by_api_key_id = $2 WHERE id = $1`,
        [started.data.id, otherKey],
      ),
    ).rejects.toThrow(/automation_enrollments_created_by_key_fk/);
    // A stop by a key names it, and only with its reason.
    await expect(
      fx.dbs.adminPool.query(
        `UPDATE app.automation_enrollments SET stopped_by_api_key_id = $2 WHERE id = $1`,
        [started.data.id, keyId],
      ),
    ).rejects.toThrow(/automation_enrollments_stopped_by/);
    const columns = await fx.query<{ c: string; ok: boolean }>(
      `SELECT c, has_column_privilege('w360_app', 'app.automation_enrollments', c, 'UPDATE') AS ok
         FROM unnest(ARRAY['created_by_api_key_id', 'stopped_by_api_key_id']) c`,
    );
    expect(Object.fromEntries(columns.map((r) => [r.c, r.ok]))).toEqual({
      created_by_api_key_id: false,
      stopped_by_api_key_id: true,
    });
    await drain(c, started.data.id);
  });
});
