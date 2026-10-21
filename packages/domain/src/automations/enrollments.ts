import { z } from 'zod';
import { QUEUES } from '@w360/contracts';
import { AppError, isAppError, notFound, uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  automationEnrollmentContacts,
  automationEnrollments,
  automations,
  automationVersions,
  channelAccounts,
  contacts,
  desc,
  eq,
  gt,
  inArray,
  isUniqueViolation,
  memberships,
  segments,
  sql,
  users,
  type AutomationEnrollmentEndReason,
  type AutomationEnrollmentSource,
  type AutomationEnrollmentStatus,
  type Database,
  type SQL,
  type TemplateCategory,
  authorizedTenantScope,
  systemScope,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { recordAudit, recordSystemAudit, type RequestMeta } from '../audit';
import { assertCan, can, type TenantContext } from '../authz/context';
import { permissionsForRoles, type Permission } from '../authz/permissions';
import {
  assertCanUseDefinition,
  parseSegmentDefinition,
  segmentWhere,
} from '../campaigns/segments';
import { loadFieldTypes } from '../campaigns/segments';
import { contactFilterConditions } from '../contacts/service';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { parseInput } from '../validation';
import { triggerSchema } from './graph';
import {
  ENROLLMENT_LIMITS,
  assertEnrollableCount,
  enrollmentBatchDelayMs,
  enrollmentBatchDue,
  enrollmentEndForRefusal,
  enrollmentEndStatus,
  enrollmentSweepAction,
  enrollmentJobKey,
  enrollmentStalled,
  enrollmentPreviewSchema,
  runEnrollmentBatch,
  startEnrollmentSchema,
  stopEnrollmentSchema,
  summariseRefusals,
  type EnrollmentAudience,
  type EnrolleeOutcome,
} from './enrollment-model';
import {
  activeStartChannel,
  automationSendsMarketing,
  loadStartableAutomation,
  startInputVariables,
  startRunForContact,
  type StartableAutomation,
} from './starts';

/**
 * Members enrol contacts or a segment in an automation started by a member or through the API
 * (ADR-401). A member who may publish automations chooses the contacts the contacts page's filters
 * match, or a saved segment, gives the trigger's inputs once (validated as the API validates them)
 * and confirms the count; the enrolment snapshots those contacts and a signed `automation.enroll`
 * job starts their runs in batches of at most 50 per transaction, each contact through the API's
 * start steps (automations/starts) in a savepoint of its own. A refused contact records its reason
 * and the others go on. The batch's outcomes, counts and position commit with its runs, so a
 * retried or restarted job never starts a second run for a contact the enrolment handled. Stopping
 * cancels the contacts not handled yet; runs already started go on.
 */

/** `META_SEND_RATE_PER_SECOND`'s default, for callers that do not give the configured rate. */
const DEFAULT_SEND_RATE_PER_SECOND = 20;

export interface EnrollmentDeps {
  db: Database;
  clock: Clock;
  jobs: JobQueue;
  signer: JobSigner;
  /**
   * The per-number send rate (`META_SEND_RATE_PER_SECOND`) that paces batches; the web tier, which
   * only queues the first batch, need not give it.
   */
  sendRatePerSecond?: number;
}

/** An automation members can enrol contacts in: published, active, started by a member or the API. */
export interface EnrollableAutomation {
  id: string;
  name: string;
  inputs: string[];
  phoneNumber: string | null;
}

export interface EnrollmentPreview {
  automation: EnrollableAutomation;
  /** How many contacts would be enrolled now, counted up to one more than the limit. */
  count: number;
  /** The segment's name, for an enrolment of a segment. */
  segmentName: string | null;
}

export interface EnrollmentSummary {
  id: string;
  automationId: string;
  source: AutomationEnrollmentSource;
  segmentName: string | null;
  status: AutomationEnrollmentStatus;
  endReason: AutomationEnrollmentEndReason | null;
  total: number;
  started: number;
  refused: number;
  cancelled: number;
  createdByName: string | null;
  createdAt: Date;
  endedAt: Date | null;
}

export interface EnrollmentDetail extends EnrollmentSummary {
  automationName: string;
  stoppedByName: string | null;
  /** Contacts not handled yet. */
  pending: number;
  /** Refusals by reason, most frequent first. */
  refusals: { reason: string; label: string; count: number }[];
  /**
   * When a running enrolment last handled a contact, if it has stalled (its next batch 10 minutes
   * overdue, or the sweep has signalled it again since its last batch), while the company is
   * active; otherwise null.
   */
  stalledSince: Date | null;
}

/** The permissions of a member as their roles give them now, or null when they are not active. */
async function memberPermissions(
  tx: Tx,
  tenantId: string,
  membershipId: string,
): Promise<Set<Permission> | null> {
  const [member] = await tx
    .select({ roles: memberships.roles })
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.id, membershipId),
        eq(memberships.status, 'active'),
      ),
    );
  return member ? permissionsForRoles(member.roles) : null;
}

/** Signals the enrolment job for the batch after `position` (the job only wakes the row). */
export async function signalEnrollment(
  deps: Pick<EnrollmentDeps, 'jobs' | 'signer'>,
  tx: Tx | null,
  input: { tenantId: string; enrollmentId: string; actorUserId: string; key: string; at?: Date },
): Promise<void> {
  await deps.jobs.enqueue(
    tx,
    QUEUES.automationEnroll.name,
    deps.signer.sign({
      kind: 'automation.enroll',
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      ref: input.enrollmentId,
    }),
    { singletonKey: input.key, ...(input.at ? { startAfter: input.at } : {}) },
  );
}

type EnrollmentRow = typeof automationEnrollments.$inferSelect;

/**
 * Ends a locked running enrolment: completed when every contact was handled, otherwise stopped with
 * its reason. Contacts not handled are cancelled and the inputs cleared (each run keeps its own).
 */
async function endEnrollment(
  tx: Tx,
  enrollment: EnrollmentRow,
  end: { reason: AutomationEnrollmentEndReason | null; stoppedByMembershipId?: string; now: Date },
): Promise<{ cancelled: number }> {
  const cancelled = await tx
    .update(automationEnrollmentContacts)
    .set({ outcome: 'cancelled', processedAt: end.now })
    .where(
      and(
        eq(automationEnrollmentContacts.tenantId, enrollment.tenantId),
        eq(automationEnrollmentContacts.enrollmentId, enrollment.id),
        eq(automationEnrollmentContacts.outcome, 'pending'),
      ),
    )
    .returning({ id: automationEnrollmentContacts.id });
  await tx
    .update(automationEnrollments)
    .set({
      status: enrollmentEndStatus(end.reason),
      endReason: end.reason,
      cancelledCount: sql`${automationEnrollments.cancelledCount} + ${cancelled.length}`,
      inputs: {},
      nextBatchAt: null,
      stoppedByMembershipId: end.stoppedByMembershipId ?? null,
      endedAt: end.now,
    })
    .where(
      and(
        eq(automationEnrollments.tenantId, enrollment.tenantId),
        eq(automationEnrollments.id, enrollment.id),
      ),
    );
  return { cancelled: cancelled.length };
}

/** The enrolment's end, audited for the company (the job ends it, not a member's request). */
async function endEnrollmentAsJob(
  tx: Tx,
  enrollment: EnrollmentRow,
  reason: AutomationEnrollmentEndReason | null,
  now: Date,
  counts: { started: number; refused: number },
): Promise<void> {
  const { cancelled } = await endEnrollment(tx, enrollment, { reason, now });
  await recordSystemAudit(tx, enrollment.tenantId, {
    action: 'automation.enrollment_ended',
    subjectType: 'automation_enrollment',
    subjectId: enrollment.id,
    metadata: {
      automationId: enrollment.automationId,
      status: enrollmentEndStatus(reason),
      reason,
      started: counts.started,
      refused: counts.refused,
      cancelled: enrollment.cancelledCount + cancelled,
    },
  });
}

export type EnrollmentBatchOutcome =
  /** The enrolment does not exist in the company (another company's id finds nothing). */
  | { outcome: 'missing' }
  /** It had ended: nothing to do. */
  | { outcome: 'ended' }
  /** A batch was handled and the next one signalled. */
  | { outcome: 'batch'; started: number; refused: number; nextBatchAt: Date }
  /** Its next batch is not due yet: the job queued for that time (or the sweep) carries on. */
  | { outcome: 'not_due'; nextBatchAt: Date }
  /** The last batch was handled (or the enrolment could not go on). */
  | {
      outcome: 'finished';
      status: 'completed' | 'stopped' | 'failed';
      reason: AutomationEnrollmentEndReason | null;
      started: number;
      refused: number;
    };

/**
 * Handles the enrolment's next batch in one transaction, under its row lock: re-checks the member
 * who started it (still active, may still publish automations, and send campaigns when it sends
 * marketing templates), the automation's checks of a start (published, active, its number, the
 * inputs its live version takes), then starts up to 50 pending contacts in order, each in a
 * savepoint, records each outcome, the counts and the position, and signals the next batch in the
 * same transaction, or ends the enrolment. A failure rolls back the whole batch, runs included, and
 * the job's retry starts it again from the same position.
 */
export async function processEnrollmentBatch(
  deps: EnrollmentDeps,
  scope: TenantScope,
  enrollmentId: string,
): Promise<EnrollmentBatchOutcome> {
  if (!z.uuid().safeParse(enrollmentId).success) return { outcome: 'missing' };
  return deps.db.run(scope, async (tx) => {
    const tenantId = scope.tenantId;
    const [enrollment] = await tx
      .select()
      .from(automationEnrollments)
      .where(
        and(
          eq(automationEnrollments.tenantId, tenantId),
          eq(automationEnrollments.id, enrollmentId),
        ),
      )
      .for('update');
    if (!enrollment) return { outcome: 'missing' };
    if (enrollment.status !== 'running') return { outcome: 'ended' };
    const now = deps.clock.now();
    // Paced per enrolment: a job that arrives before the next batch is due does nothing, so a second
    // chain of jobs collapses into the one queued for that time instead of doubling the pace.
    if (enrollment.nextBatchAt && !enrollmentBatchDue(enrollment.nextBatchAt, now)) {
      return { outcome: 'not_due', nextBatchAt: enrollment.nextBatchAt };
    }
    const counts = { started: enrollment.startedCount, refused: enrollment.refusedCount };
    const finish = async (
      reason: AutomationEnrollmentEndReason | null,
      batch = { started: 0, refused: 0 },
    ): Promise<EnrollmentBatchOutcome> => {
      await endEnrollmentAsJob(tx, enrollment, reason, now, {
        started: counts.started + batch.started,
        refused: counts.refused + batch.refused,
      });
      return {
        outcome: 'finished',
        status: enrollmentEndStatus(reason),
        reason,
        ...batch,
      };
    };

    // The member's authority, as the campaign runner re-checks its launcher's.
    const permissions = await memberPermissions(tx, tenantId, enrollment.createdByMembershipId);
    if (!permissions?.has('automations.publish')) return finish('member_removed');

    let automation: StartableAutomation;
    let channelId: string;
    try {
      automation = await loadStartableAutomation(tx, tenantId, enrollment.automationId);
      channelId = await activeStartChannel(tx, tenantId, automation);
    } catch (error) {
      const end = enrollmentEndForRefusal(error);
      if (!end) throw error;
      return finish(end);
    }
    let variables: Record<string, string>;
    try {
      variables = startInputVariables(automation, enrollment.inputs, 'inputs');
    } catch (error) {
      // A version published since takes other inputs than the ones the member gave.
      if (!isAppError(error) || error.code !== 'validation_failed') throw error;
      return finish('inputs_changed');
    }
    const marketing = await automationSendsMarketing(tx, tenantId, automation);
    if (marketing && !permissions.has('campaigns.send')) return finish('marketing_not_allowed');
    const consent: TemplateCategory[] = marketing ? ['UTILITY', 'MARKETING'] : ['UTILITY'];

    const pending = await tx
      .select({
        id: automationEnrollmentContacts.id,
        position: automationEnrollmentContacts.position,
        contactId: automationEnrollmentContacts.contactId,
      })
      .from(automationEnrollmentContacts)
      .where(
        and(
          eq(automationEnrollmentContacts.tenantId, tenantId),
          eq(automationEnrollmentContacts.enrollmentId, enrollment.id),
          eq(automationEnrollmentContacts.outcome, 'pending'),
          gt(automationEnrollmentContacts.position, enrollment.cursorPosition),
        ),
      )
      .orderBy(asc(automationEnrollmentContacts.position))
      .limit(ENROLLMENT_LIMITS.batch + 1);
    const contactIds = pending.flatMap((p) => (p.contactId ? [p.contactId] : []));
    const found = new Map(
      (contactIds.length > 0
        ? await tx
            .select({ id: contacts.id, phone: contacts.phoneE164, erasedAt: contacts.erasedAt })
            .from(contacts)
            .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, contactIds)))
        : []
      ).map((c) => [c.id, c]),
    );

    const result = await runEnrollmentBatch(pending, async (enrollee) => {
      const contact = enrollee.contactId ? found.get(enrollee.contactId) : undefined;
      if (!contact) return { outcome: 'refused', reason: 'contact_gone' };
      // An erased contact has no number either: the start's erasure check names it.
      if (!contact.phone && !contact.erasedAt) return { outcome: 'refused', reason: 'no_number' };
      const run = await tx.transaction((sp) =>
        startRunForContact(deps, sp, {
          tenantId,
          automation,
          channelId,
          contact: { id: contact.id, phone: contact.phone },
          variables,
          consent,
          starter: { kind: 'enrollment', enrollmentId: enrollment.id },
          now,
        }),
      );
      return { outcome: 'started', runId: run.id };
    });

    const batch = await recordOutcomes(tx, tenantId, result.outcomes, now);
    const last = result.outcomes.at(-1);
    // Paced: the next batch starts no sooner than the runs this one started take at the number's
    // send rate (the rate campaigns use when they have none of their own).
    const nextBatchAt = new Date(
      now.getTime() +
        enrollmentBatchDelayMs(
          batch.started,
          deps.sendRatePerSecond ?? DEFAULT_SEND_RATE_PER_SECOND,
        ),
    );
    await tx
      .update(automationEnrollments)
      .set({
        startedCount: sql`${automationEnrollments.startedCount} + ${batch.started}`,
        refusedCount: sql`${automationEnrollments.refusedCount} + ${batch.refused}`,
        cursorPosition: last ? last.position : enrollment.cursorPosition,
        nextBatchAt,
        // A batch was handled: the sweep's count of signals without progress starts again.
        resignalCount: 0,
      })
      .where(
        and(
          eq(automationEnrollments.tenantId, tenantId),
          eq(automationEnrollments.id, enrollment.id),
        ),
      );
    if (result.end) return finish(result.end, batch);
    const more = pending.length > result.outcomes.length;
    if (!more) return finish(null, batch);
    await signalEnrollment(deps, tx, {
      tenantId,
      enrollmentId: enrollment.id,
      actorUserId: enrollment.createdByUserId,
      key: enrollmentJobKey(enrollment.id, last?.position ?? enrollment.cursorPosition),
      ...(nextBatchAt > now ? { at: nextBatchAt } : {}),
    });
    return { outcome: 'batch', ...batch, nextBatchAt };
  });
}

/** Records a batch's outcomes in one statement; returns how many started and were refused. */
async function recordOutcomes(
  tx: Tx,
  tenantId: string,
  outcomes: readonly EnrolleeOutcome[],
  now: Date,
): Promise<{ started: number; refused: number }> {
  if (outcomes.length === 0) return { started: 0, refused: 0 };
  const ids = outcomes.map((o) => o.id);
  const kinds = outcomes.map((o) => o.outcome);
  const reasons = outcomes.map((o) => (o.outcome === 'refused' ? o.reason : null));
  const runs = outcomes.map((o) => (o.outcome === 'started' ? o.runId : null));
  const updated = await tx.execute<{ outcome: string }>(sql`
    update app.automation_enrollment_contacts c
       set outcome = o.outcome, reason = o.reason, run_id = o.run_id,
           processed_at = ${now.toISOString()}::timestamptz
      from unnest(${sql.param(ids)}::uuid[], ${sql.param(kinds)}::text[],
                  ${sql.param(reasons)}::text[], ${sql.param(runs)}::uuid[])
           as o(id, outcome, reason, run_id)
     where c.tenant_id = ${tenantId}::uuid and c.id = o.id and c.outcome = 'pending'
     returning c.outcome`);
  // Counted from the rows the statement changed, so the counts never exceed the outcomes recorded.
  const started = updated.rows.filter((r) => r.outcome === 'started').length;
  return { started, refused: updated.rows.filter((r) => r.outcome === 'refused').length };
}

/**
 * Ends a running enrolment whose member left the company (the job's actor is no longer an active
 * member, so the job is refused and only this cleanup runs, in the company's scope).
 */
export async function endEnrollmentForRemovedMember(
  deps: Pick<EnrollmentDeps, 'db' | 'clock'>,
  scope: TenantScope,
  enrollmentId: string,
): Promise<boolean> {
  if (!z.uuid().safeParse(enrollmentId).success) return false;
  return deps.db.run(scope, async (tx) => {
    const [enrollment] = await tx
      .select()
      .from(automationEnrollments)
      .where(
        and(
          eq(automationEnrollments.tenantId, scope.tenantId),
          eq(automationEnrollments.id, enrollmentId),
        ),
      )
      .for('update');
    if (enrollment?.status !== 'running') return false;
    await endEnrollmentAsJob(tx, enrollment, 'member_removed', deps.clock.now(), {
      started: enrollment.startedCount,
      refused: enrollment.refusedCount,
    });
    return true;
  });
}

export function createAutomationEnrollmentService(deps: EnrollmentDeps) {
  const { db, clock } = deps;

  /** Who may enrol: members who may publish automations and read contacts (and segments). */
  function assertMayEnrol(ctx: TenantContext, audience?: EnrollmentAudience) {
    assertCan(ctx, 'automations.publish');
    assertCan(ctx, 'contacts.read');
    if (audience?.kind === 'segment') assertCan(ctx, 'campaigns.read');
  }

  /** The automation's name and inputs, and the number it sends from. */
  async function describe(
    tx: Tx,
    tenantId: string,
    automation: StartableAutomation,
  ): Promise<EnrollableAutomation> {
    const [row] = await tx
      .select({ name: automations.name, phoneNumber: channelAccounts.displayPhoneNumber })
      .from(automations)
      .leftJoin(
        channelAccounts,
        and(
          eq(channelAccounts.tenantId, automations.tenantId),
          eq(channelAccounts.id, sql`${automation.channelAccountId}::uuid`),
        ),
      )
      .where(and(eq(automations.tenantId, tenantId), eq(automations.id, automation.id)));
    return {
      id: automation.id,
      name: row?.name ?? '',
      inputs: [...automation.inputs],
      phoneNumber: row?.phoneNumber ?? null,
    };
  }

  /** The WHERE conditions over app.contacts for whom the enrolment takes, and the segment's name. */
  async function audienceWhere(
    tx: Tx,
    ctx: TenantContext,
    audience: EnrollmentAudience,
  ): Promise<{ where: SQL; segmentName: string | null }> {
    if (audience.kind === 'contacts') {
      return {
        where: sql.join(contactFilterConditions(ctx, audience.filter), sql` and `),
        segmentName: null,
      };
    }
    const [segment] = await tx
      .select({
        name: segments.name,
        definition: segments.definition,
        archivedAt: segments.archivedAt,
      })
      .from(segments)
      .where(and(eq(segments.tenantId, ctx.tenant.id), eq(segments.id, audience.segmentId)));
    if (!segment || segment.archivedAt) throw notFound('Segment');
    const definition = await parseSegmentDefinition(tx, ctx.tenant.id, segment.definition);
    assertCanUseDefinition(ctx, definition);
    return {
      where: segmentWhere(
        ctx.tenant.id,
        definition,
        ctx.tenant.timezone,
        await loadFieldTypes(tx, ctx.tenant.id),
      ),
      segmentName: segment.name,
    };
  }

  /** The contacts the audience matches now, in id order, at most one more than the limit. */
  async function matching(tx: Tx, where: SQL): Promise<string[]> {
    const rows = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(where)
      .orderBy(asc(contacts.id))
      .limit(ENROLLMENT_LIMITS.contacts + 1);
    return rows.map((r) => r.id);
  }

  /** Refuses an automation that sends marketing templates to a member who may not send campaigns. */
  async function assertMayStartMarketing(
    tx: Tx,
    ctx: TenantContext,
    automation: StartableAutomation,
  ) {
    if (!(await automationSendsMarketing(tx, ctx.tenant.id, automation))) return;
    if (!can(ctx, 'campaigns.send')) {
      throw new AppError(
        'forbidden',
        'This automation sends marketing templates: enrolling contacts in it needs permission to send campaigns.',
      );
    }
  }

  return {
    /** Published, active automations started by a member or through the API, by name. */
    async enrollableAutomations(ctx: TenantContext): Promise<EnrollableAutomation[]> {
      assertMayEnrol(ctx);
      return db.run(
        ctx.scope,
        async (tx) => {
          const rows = await tx
            .select({
              id: automations.id,
              name: automations.name,
              trigger: automationVersions.trigger,
              phoneNumber: channelAccounts.displayPhoneNumber,
            })
            .from(automations)
            .innerJoin(
              automationVersions,
              and(
                eq(automationVersions.tenantId, automations.tenantId),
                eq(automationVersions.id, automations.activeVersionId),
              ),
            )
            .leftJoin(
              channelAccounts,
              and(
                eq(channelAccounts.tenantId, automationVersions.tenantId),
                eq(channelAccounts.id, automationVersions.channelAccountId),
              ),
            )
            .where(
              and(
                eq(automations.tenantId, ctx.tenant.id),
                eq(automations.status, 'active'),
                sql`${automationVersions.trigger} ->> 'type' = 'api'`,
              ),
            )
            .orderBy(asc(automations.name), asc(automations.id));
          return rows.map((r) => {
            const trigger = triggerSchema.safeParse(r.trigger);
            return {
              id: r.id,
              name: r.name,
              inputs: trigger.success && trigger.data.type === 'api' ? trigger.data.inputs : [],
              phoneNumber: r.phoneNumber,
            };
          });
        },
        { accessMode: 'read only' },
      );
    },

    /**
     * What an enrolment would do now: the automation (checked as a start checks it) and how many
     * contacts the audience matches, counted up to one more than the limit. Changes nothing.
     */
    async previewEnrollment(ctx: TenantContext, input: unknown): Promise<EnrollmentPreview> {
      const data = parseInput(enrollmentPreviewSchema, input);
      assertMayEnrol(ctx, data.audience);
      // Not read only: the automation's checks take its row lock for share, as a start does.
      return db.run(ctx.scope, async (tx) => {
        const automation = await loadStartableAutomation(tx, ctx.tenant.id, data.automationId);
        await activeStartChannel(tx, ctx.tenant.id, automation);
        const { where, segmentName } = await audienceWhere(tx, ctx, data.audience);
        const count = (await matching(tx, where)).length;
        return { automation: await describe(tx, ctx.tenant.id, automation), count, segmentName };
      });
    },

    /**
     * Starts an enrolment: the automation's checks of a start, the inputs as the API validates them,
     * the marketing permission, then the snapshot of the contacts the audience matches (refused when
     * there are none, more than the limit, or not as many as the member was shown), one row each in
     * contact id order, and the first batch's job, signed with the member. Audited without the
     * inputs or the search text. At most one enrolment of an automation runs at a time.
     */
    async startEnrollment(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<{ id: string; total: number }> {
      const data = parseInput(startEnrollmentSchema, input);
      assertMayEnrol(ctx, data.audience);
      const id = uuidv7();
      try {
        return await db.run(ctx.scope, async (tx) => {
          const automation = await loadStartableAutomation(tx, ctx.tenant.id, data.automationId);
          startInputVariables(automation, data.inputs, 'inputs');
          await assertMayStartMarketing(tx, ctx, automation);
          await activeStartChannel(tx, ctx.tenant.id, automation);
          const { where } = await audienceWhere(tx, ctx, data.audience);
          const ids = await matching(tx, where);
          assertEnrollableCount(ids.length, data.expectedCount);
          // Only the declared inputs, as texts (startInputVariables refused anything else).
          const inputs = Object.fromEntries(
            automation.inputs.map((name) => [name, String(data.inputs[name])]),
          );
          await tx.insert(automationEnrollments).values({
            id,
            tenantId: ctx.tenant.id,
            automationId: automation.id,
            source: data.audience.kind,
            segmentId: data.audience.kind === 'segment' ? data.audience.segmentId : null,
            inputs,
            total: ids.length,
            nextBatchAt: clock.now(),
            createdByMembershipId: ctx.membership.id,
            createdByUserId: ctx.user.id,
          });
          await tx.execute(sql`
            insert into app.automation_enrollment_contacts (id, tenant_id, enrollment_id, position, contact_id)
            select t.id, ${ctx.tenant.id}::uuid, ${id}::uuid, t.position::int, t.contact_id
              from unnest(${sql.param(ids.map(() => uuidv7()))}::uuid[], ${sql.param(ids)}::uuid[])
                   with ordinality as t(id, contact_id, position)`);
          await recordAudit(
            tx,
            ctx,
            {
              action: 'automation.enrollment_started',
              subjectType: 'automation_enrollment',
              subjectId: id,
              metadata: {
                automationId: automation.id,
                source: data.audience.kind,
                ...(data.audience.kind === 'segment'
                  ? { segmentId: data.audience.segmentId }
                  : {
                      filter: {
                        q: Boolean(data.audience.filter.q),
                        tag: data.audience.filter.tag ?? null,
                        consent: data.audience.filter.consent,
                      },
                    }),
                contacts: ids.length,
              },
            },
            meta,
          );
          await signalEnrollment(deps, tx, {
            tenantId: ctx.tenant.id,
            enrollmentId: id,
            actorUserId: ctx.user.id,
            key: enrollmentJobKey(id, 0),
          });
          return { id, total: ids.length };
        });
      } catch (error) {
        if (isUniqueViolation(error, 'automation_enrollments_running_uq')) {
          throw new AppError(
            'conflict',
            'Contacts are being enrolled in this automation already. Wait until that enrolment ends, or stop it.',
          );
        }
        throw error;
      }
    },

    /** An automation's enrolments, newest first (at most 50). */
    async listEnrollments(ctx: TenantContext, automationId: string): Promise<EnrollmentSummary[]> {
      assertCan(ctx, 'automations.read');
      if (!z.uuid().safeParse(automationId).success) return [];
      return db.run(
        ctx.scope,
        async (tx) => {
          const rows = await tx
            .select({
              e: automationEnrollments,
              segmentName: segments.name,
              createdByName: users.name,
            })
            .from(automationEnrollments)
            .leftJoin(
              segments,
              and(
                eq(segments.tenantId, automationEnrollments.tenantId),
                eq(segments.id, automationEnrollments.segmentId),
              ),
            )
            .leftJoin(
              memberships,
              and(
                eq(memberships.tenantId, automationEnrollments.tenantId),
                eq(memberships.id, automationEnrollments.createdByMembershipId),
              ),
            )
            .leftJoin(users, eq(users.id, memberships.userId))
            .where(
              and(
                eq(automationEnrollments.tenantId, ctx.tenant.id),
                eq(automationEnrollments.automationId, automationId),
              ),
            )
            .orderBy(desc(automationEnrollments.createdAt), desc(automationEnrollments.id))
            .limit(50);
          return rows.map((r) => toSummary(r.e, r.segmentName, r.createdByName));
        },
        { accessMode: 'read only' },
      );
    },

    /** One enrolment with its progress and its refusals by reason. */
    async getEnrollment(ctx: TenantContext, id: string): Promise<EnrollmentDetail> {
      assertCan(ctx, 'automations.read');
      if (!z.uuid().safeParse(id).success) throw notFound('Enrolment');
      return db.run(
        ctx.scope,
        async (tx) => {
          const [r] = await tx
            .select({
              e: automationEnrollments,
              automationName: automations.name,
              segmentName: segments.name,
            })
            .from(automationEnrollments)
            .innerJoin(
              automations,
              and(
                eq(automations.tenantId, automationEnrollments.tenantId),
                eq(automations.id, automationEnrollments.automationId),
              ),
            )
            .leftJoin(
              segments,
              and(
                eq(segments.tenantId, automationEnrollments.tenantId),
                eq(segments.id, automationEnrollments.segmentId),
              ),
            )
            .where(
              and(
                eq(automationEnrollments.tenantId, ctx.tenant.id),
                eq(automationEnrollments.id, id),
              ),
            );
          if (!r) throw notFound('Enrolment');
          const memberIds = [r.e.createdByMembershipId, r.e.stoppedByMembershipId].filter(
            (x): x is string => x !== null,
          );
          const names = await tx
            .select({ id: memberships.id, name: users.name })
            .from(memberships)
            .innerJoin(users, eq(users.id, memberships.userId))
            .where(
              and(eq(memberships.tenantId, ctx.tenant.id), inArray(memberships.id, memberIds)),
            );
          const nameOf = (m: string | null) => names.find((n) => n.id === m)?.name ?? null;
          const reasons = await tx
            .select({
              reason: automationEnrollmentContacts.reason,
              count: sql<number>`count(*)::int`,
            })
            .from(automationEnrollmentContacts)
            .where(
              and(
                eq(automationEnrollmentContacts.tenantId, ctx.tenant.id),
                eq(automationEnrollmentContacts.enrollmentId, id),
                eq(automationEnrollmentContacts.outcome, 'refused'),
              ),
            )
            .groupBy(automationEnrollmentContacts.reason);
          const summary = toSummary(r.e, r.segmentName, nameOf(r.e.createdByMembershipId));
          // When it last handled a contact (its start when it has handled none).
          const [lastProgress] = await tx
            .select({ at: sql<Date | null>`max(${automationEnrollmentContacts.processedAt})` })
            .from(automationEnrollmentContacts)
            .where(
              and(
                eq(automationEnrollmentContacts.tenantId, ctx.tenant.id),
                eq(automationEnrollmentContacts.enrollmentId, id),
              ),
            );
          return {
            ...summary,
            automationName: r.automationName,
            stoppedByName: nameOf(r.e.stoppedByMembershipId),
            pending: summary.total - summary.started - summary.refused - summary.cancelled,
            refusals: summariseRefusals(
              reasons.map((x) => ({ reason: x.reason ?? '', count: x.count })),
            ),
            // Not while the company is suspended: no run starts then, and that is not a stall.
            stalledSince:
              r.e.status === 'running' &&
              ctx.tenant.status === 'active' &&
              (r.e.resignalCount > 0 || enrollmentStalled(r.e.nextBatchAt, clock.now()))
                ? (lastProgress?.at ?? r.e.createdAt)
                : null,
          };
        },
        { accessMode: 'read only' },
      );
    },

    /**
     * Stops a running enrolment: the contacts not handled yet are cancelled and no further run
     * starts; runs already started go on (each can be stopped from its page). Waits for a batch in
     * progress (the enrolment's row lock), so nothing starts after the stop. Audited.
     */
    async stopEnrollment(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<{ cancelled: number }> {
      assertCan(ctx, 'automations.publish');
      const data = parseInput(stopEnrollmentSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const [enrollment] = await tx
          .select()
          .from(automationEnrollments)
          .where(
            and(
              eq(automationEnrollments.tenantId, ctx.tenant.id),
              eq(automationEnrollments.id, data.id),
            ),
          )
          .for('update');
        if (!enrollment) throw notFound('Enrolment');
        if (enrollment.status !== 'running') {
          throw new AppError('conflict', 'This enrolment has already ended.');
        }
        const { cancelled } = await endEnrollment(tx, enrollment, {
          reason: 'stopped_by_member',
          stoppedByMembershipId: ctx.membership.id,
          now: clock.now(),
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'automation.enrollment_stopped',
            subjectType: 'automation_enrollment',
            subjectId: enrollment.id,
            metadata: {
              automationId: enrollment.automationId,
              started: enrollment.startedCount,
              refused: enrollment.refusedCount,
              cancelled,
            },
          },
          meta,
        );
        return { cancelled };
      });
    },
  };
}

export type AutomationEnrollmentService = ReturnType<typeof createAutomationEnrollmentService>;

function toSummary(
  e: EnrollmentRow,
  segmentName: string | null,
  createdByName: string | null,
): EnrollmentSummary {
  return {
    id: e.id,
    automationId: e.automationId,
    source: e.source,
    segmentName,
    status: e.status,
    endReason: e.endReason,
    total: e.total,
    started: e.startedCount,
    refused: e.refusedCount,
    cancelled: e.cancelledCount,
    createdByName,
    createdAt: e.createdAt,
    endedAt: e.endedAt,
  };
}

/** A running enrolment whose next batch is more than 10 minutes overdue (the minute sweep). */
export interface DueEnrollment {
  tenantId: string;
  enrollmentId: string;
  actorUserId: string;
  cursorPosition: number;
}

/**
 * Running enrolments of active companies whose next batch is more than 10 minutes overdue, from the
 * narrow definer function `ops.automation_enrollments_due` (the company comes from the database,
 * never from a payload).
 */
export async function findDueEnrollments(db: Database, limit = 100): Promise<DueEnrollment[]> {
  const res = await db.run(
    systemScope,
    (tx) =>
      tx.execute<{
        tenant_id: string;
        enrollment_id: string;
        actor_user_id: string;
        cursor_position: number;
      }>(
        sql`select tenant_id, enrollment_id, actor_user_id, cursor_position
              from ops.automation_enrollments_due(${limit})`,
      ),
    { accessMode: 'read only' },
  );
  return res.rows.map((r) => ({
    tenantId: r.tenant_id,
    enrollmentId: r.enrollment_id,
    actorUserId: r.actor_user_id,
    cursorPosition: r.cursor_position,
  }));
}

/** What the sweep did with one overdue enrolment. */
export type EnrollmentSweepOutcome = 'signalled' | 'failed' | 'skipped';

/**
 * One overdue enrolment, in its company's scope (the company comes from the due list) and under its
 * row lock: when it is still running and overdue at the same position, either signal it again under
 * its batch's own key (a job still waiting or retrying collapses with it, one out of retries is
 * replaced), counting the signal and making it due now, or, after 3 signals with no batch handled,
 * end it as failed (`stalled`): its pending contacts are cancelled, started runs go on, and the end
 * is audited once. A batch starts only contacts after the stored position, so a signal never starts
 * a contact twice.
 */
export async function resignalEnrollment(
  deps: Pick<EnrollmentDeps, 'db' | 'jobs' | 'signer' | 'clock'>,
  due: DueEnrollment,
): Promise<EnrollmentSweepOutcome> {
  const scope = authorizedTenantScope(due.tenantId, null);
  return deps.db.run(scope, async (tx) => {
    const [enrollment] = await tx
      .select()
      .from(automationEnrollments)
      .where(
        and(
          eq(automationEnrollments.tenantId, due.tenantId),
          eq(automationEnrollments.id, due.enrollmentId),
        ),
      )
      .for('update');
    const now = deps.clock.now();
    if (
      enrollment?.status !== 'running' ||
      enrollment.cursorPosition !== due.cursorPosition ||
      !enrollmentStalled(enrollment.nextBatchAt, now)
    ) {
      return 'skipped';
    }
    if (enrollmentSweepAction(enrollment.resignalCount) === 'fail') {
      await endEnrollmentAsJob(tx, enrollment, 'stalled', now, {
        started: enrollment.startedCount,
        refused: enrollment.refusedCount,
      });
      return 'failed';
    }
    await tx
      .update(automationEnrollments)
      .set({ resignalCount: enrollment.resignalCount + 1, nextBatchAt: now })
      .where(
        and(
          eq(automationEnrollments.tenantId, due.tenantId),
          eq(automationEnrollments.id, enrollment.id),
        ),
      );
    await signalEnrollment(deps, tx, {
      tenantId: due.tenantId,
      enrollmentId: enrollment.id,
      actorUserId: enrollment.createdByUserId,
      key: enrollmentJobKey(enrollment.id, enrollment.cursorPosition),
    });
    return 'signalled';
  });
}

export interface EnrollmentSweepResult {
  signalled: number;
  failed: number;
  skipped: number;
  /** Enrolments whose handling raised an error (the others were handled). */
  errors: { tenantId: string; enrollmentId: string; error: unknown }[];
}

/**
 * The minute sweep's part (ADR-401): each overdue enrolment of the due list handled on its own, so
 * one's failure holds up neither the others nor the rest of the sweep; errors are returned for the
 * worker to log.
 */
export async function signalDueEnrollments(
  deps: Pick<EnrollmentDeps, 'db' | 'jobs' | 'signer' | 'clock'>,
  limit = 100,
): Promise<EnrollmentSweepResult> {
  const result: EnrollmentSweepResult = { signalled: 0, failed: 0, skipped: 0, errors: [] };
  for (const due of await findDueEnrollments(deps.db, limit)) {
    try {
      result[await resignalEnrollment(deps, due)] += 1;
    } catch (error) {
      result.errors.push({ tenantId: due.tenantId, enrollmentId: due.enrollmentId, error });
    }
  }
  return result;
}

/**
 * Defers a running enrolment of a suspended company (the worker's job was deferred): its next batch
 * is due at `at`, when the job queued here looks again, so the sweep does not start a second chain
 * meanwhile. Returns whether it was running.
 */
export async function deferEnrollment(
  deps: Pick<EnrollmentDeps, 'db' | 'jobs' | 'signer'>,
  scope: TenantScope,
  enrollmentId: string,
  at: Date,
): Promise<boolean> {
  if (!z.uuid().safeParse(enrollmentId).success) return false;
  return deps.db.run(scope, async (tx) => {
    const [enrollment] = await tx
      .select()
      .from(automationEnrollments)
      .where(
        and(
          eq(automationEnrollments.tenantId, scope.tenantId),
          eq(automationEnrollments.id, enrollmentId),
        ),
      )
      .for('update');
    if (enrollment?.status !== 'running') return false;
    await tx
      .update(automationEnrollments)
      .set({ nextBatchAt: at })
      .where(
        and(
          eq(automationEnrollments.tenantId, scope.tenantId),
          eq(automationEnrollments.id, enrollment.id),
        ),
      );
    await signalEnrollment(deps, tx, {
      tenantId: scope.tenantId,
      enrollmentId: enrollment.id,
      actorUserId: enrollment.createdByUserId,
      key: `${enrollmentJobKey(enrollment.id, enrollment.cursorPosition)}:deferred:${at.getTime()}`,
      at,
    });
    return true;
  });
}
