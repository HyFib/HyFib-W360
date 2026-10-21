import { z } from 'zod';
import { AppError, isAppError, notFound, uuidv7 } from '@w360/core';
import {
  AUTOMATION_ENROLLMENT_OUTCOMES,
  and,
  automationEnrollments,
  automations,
  eq,
  sql,
  tenants,
  type AutomationEnrollmentEndReason,
  type AutomationEnrollmentOutcome,
  type AutomationEnrollmentSource,
  type AutomationEnrollmentStatus,
  type SQL,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { loadFieldTypes, segmentWhere } from '../campaigns/segments';
import { normalizeTag } from '../contacts/fields';
import { contactFilterConditionsFor, type contactFilterSchema } from '../contacts/service';
import {
  assertEnrollableCount,
  enrolledContactsCursorSchema,
  enrolledContactsPage,
  enrollmentKeyScopes,
  ENROLLMENT_LIMITS,
  toEnrolledContact,
  type EnrolledContact,
  type EnrolledContactState,
} from '../automations/enrollment-model';
import {
  ENROLLMENT_RUNNING_MESSAGE,
  assertEnrollmentOfAutomation,
  enrollmentRunningConflict,
  selectEnrolledContacts,
  loadEnrollmentSegment,
  matchingContactIds,
  readEnrollmentDetail,
  selectEnrollmentPage,
  snapshotEnrollment,
  stopRunningEnrollment,
  type EnrollmentDetail,
  type EnrollmentSummary,
} from '../automations/enrollments';
import { loadStartableAutomation, startInputVariables } from '../automations/starts';
import type { OutboundDeps } from '../messaging/outbound';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { sendingChannel } from './automations';
import {
  apiSearchConditionSchema,
  assertOrderConditionScope,
  type ApiSearchCondition,
} from './contact-search';
import { apiActor, assertAnyScope, assertScope, hasScope, type ApiContext } from './context';
import type { ApiResponse, IdempotencyInput } from './idempotency';
import { API_LIMITS } from './model';
import { idempotent } from './resources';

/**
 * Enrolling contacts in an automation through the public API (ADR-403). A key holding
 * `automations.start` and `contacts.read` enrols, in an automation started by a member or through
 * the API, the contacts a tag and marketing consent find (the Contacts page's filters, ADR-401,
 * written as `POST /contacts/search` writes those conditions) or, with `campaigns.read`, a saved
 * segment's members, with the trigger's inputs once for everyone. The enrolment is ADR-401's: the
 * same snapshot (at most 10,000 contacts), one running enrolment per automation, batches of 50 by
 * the signed `automation.enroll` job, each contact through the API's start steps. Its batches
 * re-check the key as a fresh request would. Keys read and stop every enrolment of the company,
 * members' included, and members see keys' enrolments on their pages.
 */

const inputsField = z
  .record(z.string(), z.string())
  .default({})
  .describe(
    'A text for each input the automation declares (`inputs` in GET /api/v1/automations), by name, the same for every contact.',
  );

/** The contacts a tag and marketing consent find, as `POST /contacts/search` writes them. */
const enrollmentContactsSchema = z
  .object({
    conditions: z
      .array(apiSearchConditionSchema)
      .max(2, 'Give at most a tag and a marketing consent condition.')
      .default([])
      .describe(
        'One or two conditions: at most one `tag` condition with op `has` and one `consent` condition for purpose `marketing`, as POST /contacts/search takes them: the filters of the Contacts page. None is refused (422): to enrol every contact, enrol a segment whose conditions take them all. Other conditions are refused (422): save a segment with them and enrol it.',
      ),
  })
  .strict();

const expectedCountField = z
  .number()
  .int()
  .min(1, 'No contact to enrol.')
  .max(ENROLLMENT_LIMITS.contacts, `At most ${ENROLLMENT_LIMITS.contacts} contacts.`)
  .optional()
  .describe(
    'Optional: how many contacts you expect, as a count you read before (GET /segments/{id} or POST /contacts/search). Given, an enrolment that would take another number is refused with 409, enrolling nobody, as a member’s enrolment is when the count changed.',
  );

/** `POST /automations/{id}/enrollments`: a segment's members, or the contacts conditions find. */
export const apiStartEnrollmentSchema = z.union([
  z
    .object({
      segmentId: z
        .uuid()
        .describe(
          "One of the company's saved segments that is not archived (GET /segments); needs `campaigns.read`.",
        ),
      inputs: inputsField,
      expectedCount: expectedCountField,
    })
    .strict(),
  z
    .object({
      contacts: enrollmentContactsSchema.describe(
        'The contacts the Contacts page’s tag and marketing consent filters find.',
      ),
      inputs: inputsField,
      expectedCount: expectedCountField,
    })
    .strict(),
]);

export const apiEnrollmentListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
  })
  .strict();

/** `GET /automations/{id}/enrollments/{enrollmentId}/contacts` (ADR-408). */
export const apiEnrolledContactQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: enrolledContactsCursorSchema
      .optional()
      .describe('`nextCursor` from the previous page.'),
    outcome: z
      .enum(AUTOMATION_ENROLLMENT_OUTCOMES)
      .optional()
      .describe(
        'Only the contacts with this outcome: pending (not handled yet), started, refused or cancelled (not started because the enrolment stopped).',
      ),
  })
  .strict();

type ContactFilter = z.infer<typeof contactFilterSchema>;

/** Conditions an enrolment takes beyond the Contacts page's filters are refused with this. */
export const ENROLLMENT_CONDITION_REFUSAL =
  'An enrolment takes one tag condition (op has) and one marketing consent condition at most, the filters of the Contacts page. For other conditions, save a segment with them and enrol the segment.';

const MARKETING_CONSENT: Record<
  'opted_in' | 'opted_out' | 'not_recorded',
  ContactFilter['consent']
> = {
  opted_in: 'marketing_opted_in',
  opted_out: 'marketing_opted_out',
  not_recorded: 'marketing_unknown',
};

const invalidCondition = (index: number | null, message: string) =>
  new AppError('validation_failed', message, {
    issues: [
      { path: index === null ? 'contacts.conditions' : `contacts.conditions.${index}`, message },
    ],
  });

/** An enrolment of contacts without a condition is refused with this (every contact, unconfirmed). */
export const ENROLLMENT_NO_CONDITION_REFUSAL =
  'Give at least one condition: a tag, or a marketing consent. To enrol every contact, enrol a segment whose conditions take them all.';

/**
 * The Contacts page's filter (ADR-401's `contactFilterSchema`) that conditions written as
 * `POST /contacts/search` writes them stand for: a `tag` `has` condition is its tag and a marketing
 * `consent` condition its consent, once each; anything else is refused naming its place, so a key
 * never gets a second filter language or a condition silently dropped. A tag the app would not keep
 * is refused too, never ignored (the page's filter ignores one, which would take every contact).
 */
export function enrollmentFilterOf(conditions: readonly ApiSearchCondition[]): ContactFilter {
  // No condition would take every contact, up to 10,000, with nothing to confirm (ADR-403 review).
  if (conditions.length === 0) throw invalidCondition(null, ENROLLMENT_NO_CONDITION_REFUSAL);
  const filter: ContactFilter = { consent: 'any' };
  conditions.forEach((condition, index) => {
    if (condition.type === 'tag' && condition.op === 'has' && filter.tag === undefined) {
      const tag = normalizeTag(condition.tag);
      if (!tag.ok) throw invalidCondition(index, tag.message);
      filter.tag = tag.tag;
      return;
    }
    if (
      condition.type === 'consent' &&
      condition.purpose === 'marketing' &&
      filter.consent === 'any'
    ) {
      filter.consent = MARKETING_CONSENT[condition.status];
      return;
    }
    throw invalidCondition(index, ENROLLMENT_CONDITION_REFUSAL);
  });
  return filter;
}

/** An enrolment as the API gives it: ids and counts, never members' names or the inputs. */
export interface ApiAutomationEnrollment {
  id: string;
  automationId: string;
  source: AutomationEnrollmentSource;
  segmentId: string | null;
  status: AutomationEnrollmentStatus;
  endReason: AutomationEnrollmentEndReason | null;
  total: number;
  started: number;
  refused: number;
  cancelled: number;
  pending: number;
  startedBy: 'member' | 'api';
  apiKeyId: string | null;
  stoppedBy: 'member' | 'api' | null;
  stoppedByApiKeyId: string | null;
  createdAt: string;
  endedAt: string | null;
}

/** One enrolment, with its refusals by reason and whether it has stalled. */
export interface ApiAutomationEnrollmentDetail extends ApiAutomationEnrollment {
  refusals: { reason: string; count: number }[];
  stalledSince: string | null;
}

/**
 * An enrolment as the API gives it; the segment's id only to a key that reads segments
 * (`campaigns.read`), null otherwise.
 */
export function toApiEnrollment(
  e: EnrollmentSummary,
  readsSegments: boolean,
): ApiAutomationEnrollment {
  return {
    id: e.id,
    automationId: e.automationId,
    source: e.source,
    segmentId: readsSegments ? e.segmentId : null,
    status: e.status,
    endReason: e.endReason,
    total: e.total,
    started: e.started,
    refused: e.refused,
    cancelled: e.cancelled,
    pending: e.total - e.started - e.refused - e.cancelled,
    startedBy: e.startedBy,
    apiKeyId: e.createdByApiKeyId,
    stoppedBy: e.stoppedBy,
    stoppedByApiKeyId: e.stoppedByApiKeyId,
    createdAt: e.createdAt.toISOString(),
    endedAt: e.endedAt?.toISOString() ?? null,
  };
}

export function toApiEnrollmentDetail(
  e: EnrollmentDetail,
  readsSegments: boolean,
): ApiAutomationEnrollmentDetail {
  return {
    ...toApiEnrollment(e, readsSegments),
    refusals: e.refusals.map((r) => ({ reason: r.reason, count: r.count })),
    stalledSince: e.stalledSince?.toISOString() ?? null,
  };
}

/**
 * Refuses a key that may not enrol this audience, before anything is read: `automations.start`
 * (refused while the company is suspended, as starts are) and `contacts.read`, and `campaigns.read`
 * for a segment (ADR-403). `messages.send_marketing` is checked once the automation is read.
 */
export function assertMayEnrolThroughApi(ctx: ApiContext, source: AutomationEnrollmentSource) {
  for (const scope of enrollmentKeyScopes(source)) assertScope(ctx, scope);
}

/** A running enrolment of the automation, refused by name before the unique index would. */
async function assertNoRunningEnrollment(tx: Tx, tenantId: string, automationId: string) {
  const [running] = await tx
    .select({ id: automationEnrollments.id })
    .from(automationEnrollments)
    .where(
      and(
        eq(automationEnrollments.tenantId, tenantId),
        eq(automationEnrollments.automationId, automationId),
        eq(automationEnrollments.status, 'running'),
      ),
    );
  if (running) {
    throw new AppError('conflict', `${ENROLLMENT_RUNNING_MESSAGE} Enrolment ${running.id} runs.`, {
      details: { apiReason: 'enrollment_running' },
    });
  }
}

/**
 * The WHERE over app.contacts of a segment's members, as the campaigns' audience and members'
 * enrolments take them: a segment with a problem is refused with 412 saying it (as reading its
 * contacts is), and conditions on conversations or store orders need the scopes that read them.
 */
async function segmentAudience(tx: Tx, ctx: ApiContext, segmentId: string): Promise<SQL> {
  let segment: Awaited<ReturnType<typeof loadEnrollmentSegment>>;
  try {
    segment = await loadEnrollmentSegment(tx, ctx.tenant.id, segmentId);
  } catch (error) {
    if (isAppError(error) && error.code === 'validation_failed') {
      throw new AppError(
        'precondition_failed',
        `${error.publicMessage} A member fixes the segment on the Segments page.`,
      );
    }
    throw error;
  }
  if (segment.definition.conditions.some((c) => c.type === 'last_message')) {
    assertScope(ctx, 'conversations.read');
  }
  assertOrderConditionScope(ctx, segment.definition.conditions);
  const [company] = await tx
    .select({ timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, ctx.tenant.id));
  if (!company) throw notFound('Company');
  return segmentWhere(
    ctx.tenant.id,
    segment.definition,
    company.timezone,
    await loadFieldTypes(tx, ctx.tenant.id),
  );
}

/**
 * Enrols a saved segment's members, or the contacts a tag and marketing consent find, in an
 * automation started by a member or through the API (ADR-403), with ADR-401's checks and snapshot:
 * the automation's checks of a start, the inputs as a start validates them, the marketing scope,
 * no enrolment of the automation running (409 `enrollment_running`, naming it), then 1 to 10,000
 * contacts snapshotted in contact id order and the first batch queued, acting for the company.
 * Audited as the key, without the inputs. One enrolment per `Idempotency-Key`. Answers 201 with it.
 */
export async function apiStartEnrollment(
  deps: OutboundDeps,
  ctx: ApiContext,
  automationId: string,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertScope(ctx, 'automations.start');
  if (!z.uuid().safeParse(automationId).success) throw notFound('Automation');
  const data = parseInput(apiStartEnrollmentSchema, input);
  // The scopes first, so a key that may not enrol is refused (403) before its conditions are read.
  assertMayEnrolThroughApi(ctx, 'segmentId' in data ? 'segment' : 'contacts');
  const audience =
    'segmentId' in data
      ? { kind: 'segment' as const, segmentId: data.segmentId }
      : { kind: 'contacts' as const, filter: enrollmentFilterOf(data.contacts.conditions) };
  const now = deps.clock.now();
  try {
    return await deps.db.run(ctx.scope, (tx) =>
      idempotent(tx, ctx, idempotency, now, async () => {
        const automation = await loadStartableAutomation(tx, ctx.tenant.id, automationId);
        startInputVariables(automation, data.inputs, 'inputs');
        // The marketing scope and the automation's active number, as a start checks them.
        await sendingChannel(tx, ctx, automation);
        await assertNoRunningEnrollment(tx, ctx.tenant.id, automation.id);
        const where =
          audience.kind === 'segment'
            ? await segmentAudience(tx, ctx, audience.segmentId)
            : sql.join(
                contactFilterConditionsFor(ctx.tenant.id, audience.filter, { seesNumbers: false }),
                sql` and `,
              );
        const ids = await matchingContactIds(tx, where);
        // Nobody, or more than the limit; and, when the key gave a count, another number (409), as
        // a member's enrolment checks the count the member was shown.
        assertEnrollableCount(
          ids.length,
          data.expectedCount ?? Math.min(ids.length, ENROLLMENT_LIMITS.contacts),
        );
        const id = uuidv7();
        await snapshotEnrollment(deps, tx, {
          id,
          tenantId: ctx.tenant.id,
          automationId: automation.id,
          audience,
          // Only the declared inputs (startInputVariables refused anything else).
          inputs: Object.fromEntries(
            automation.inputs.map((name) => [name, String(data.inputs[name])]),
          ),
          contactIds: ids,
          starter: { kind: 'key', apiKeyId: ctx.key.id },
        });
        await recordSystemAudit(
          tx,
          ctx.tenant.id,
          {
            action: 'automation.enrollment_started',
            subjectType: 'automation_enrollment',
            subjectId: id,
            metadata: {
              automationId: automation.id,
              source: audience.kind,
              ...(audience.kind === 'segment'
                ? { segmentId: audience.segmentId }
                : {
                    filter: {
                      q: false,
                      tag: audience.filter.tag ?? null,
                      consent: audience.filter.consent,
                    },
                  }),
              contacts: ids.length,
            },
            correlationId: ctx.requestId,
          },
          apiActor(ctx),
        );
        const detail = await readEnrollmentDetail(tx, ctx.tenant.id, id, true);
        return {
          status: 201,
          body: { data: toApiEnrollmentDetail(detail, hasScope(ctx, 'campaigns.read')) },
        };
      }),
    );
  } catch (error) {
    // Two starts at once: the partial unique index refuses the second.
    throw enrollmentRunningConflict(error) ?? error;
  }
}

/** The automation, any of the company's (archived included), or 404. */
async function assertAutomationExists(tx: Tx, tenantId: string, automationId: string) {
  const [row] = await tx
    .select({ id: automations.id })
    .from(automations)
    .where(and(eq(automations.tenantId, tenantId), eq(automations.id, automationId)));
  if (!row) throw notFound('Automation');
}

/** An automation's enrolments, members' and keys', newest first, on keyset pages (ADR-403). */
export async function apiListEnrollments(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  automationId: string,
  query: unknown,
): Promise<{ data: ApiAutomationEnrollment[]; nextCursor: string | null }> {
  assertAnyScope(ctx, ['automations.start']);
  if (!z.uuid().safeParse(automationId).success) throw notFound('Automation');
  const q = parseInput(apiEnrollmentListQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      await assertAutomationExists(tx, ctx.tenant.id, automationId);
      const rows = await selectEnrollmentPage(tx, ctx.tenant.id, automationId, {
        limit: q.limit + 1,
        before: cursor,
      });
      const shown = rows.slice(0, q.limit);
      const last = shown.at(-1);
      return {
        data: shown.map((e) => toApiEnrollment(e, hasScope(ctx, 'campaigns.read'))),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
}

/** One enrolment of the automation, a member's or a key's, with its progress (ADR-403). */
export async function apiGetEnrollment(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  automationId: string,
  enrollmentId: string,
): Promise<ApiAutomationEnrollmentDetail> {
  assertAnyScope(ctx, ['automations.start']);
  if (!z.uuid().safeParse(automationId).success || !z.uuid().safeParse(enrollmentId).success) {
    throw notFound('Enrolment');
  }
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const detail = await readEnrollmentDetail(
        tx,
        ctx.tenant.id,
        enrollmentId,
        ctx.tenant.status === 'active',
      );
      if (detail.automationId !== automationId) throw notFound('Enrolment');
      return toApiEnrollmentDetail(detail, hasScope(ctx, 'campaigns.read'));
    },
    { accessMode: 'read only' },
  );
}

/**
 * One enrolled contact as the API gives it (ADR-408): ids and the outcome, never a name or a number
 * (`GET /contacts/{id}` gives the contact), and no id for an erased contact, as the API lists no
 * erased contact.
 */
export interface ApiEnrolledContact {
  position: number;
  contactId: string | null;
  contact: EnrolledContactState;
  outcome: AutomationEnrollmentOutcome;
  reason: string | null;
  runId: string | null;
  processedAt: string | null;
}

export function toApiEnrolledContact(c: EnrolledContact): ApiEnrolledContact {
  return {
    position: c.position,
    contactId: c.contactId,
    contact: c.contact,
    outcome: c.outcome,
    reason: c.reason,
    runId: c.runId,
    processedAt: c.processedAt?.toISOString() ?? null,
  };
}

/**
 * An enrolment's contacts in position order with their outcomes, on keyset pages, of one outcome
 * when asked (ADR-408): the scope reading the enrolment needs (`automations.start`) and
 * `contacts.read`, as the list names contacts; both checked as reads (`assertAnyScope`), as
 * ADR-403's reads are, so also while the company is suspended. Another automation's or company's
 * enrolment is not found.
 */
export async function apiListEnrolledContacts(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  automationId: string,
  enrollmentId: string,
  query: unknown,
): Promise<{ data: ApiEnrolledContact[]; nextCursor: string | null }> {
  assertAnyScope(ctx, ['automations.start']);
  assertAnyScope(ctx, ['contacts.read']);
  if (!z.uuid().safeParse(automationId).success || !z.uuid().safeParse(enrollmentId).success) {
    throw notFound('Enrolment');
  }
  const q = parseInput(apiEnrolledContactQuerySchema, query);
  const rows = await deps.db.run(
    ctx.scope,
    async (tx) => {
      await assertEnrollmentOfAutomation(tx, ctx.tenant.id, automationId, enrollmentId);
      return selectEnrolledContacts(tx, ctx.tenant.id, enrollmentId, {
        ...(q.outcome ? { outcome: q.outcome } : {}),
        ...(q.cursor ? { after: q.cursor } : {}),
        limit: q.limit + 1,
      });
    },
    { accessMode: 'read only' },
  );
  const { shown, nextCursor } = enrolledContactsPage(rows, q.limit);
  // No number is shown: the mapping never asks for one.
  return {
    data: shown.map((r) => toApiEnrolledContact(toEnrolledContact(r, () => null))),
    nextCursor,
  };
}

/**
 * Stops a running enrolment of the automation, a member's or a key's, as a member's stop does
 * (ADR-401): under its row lock the contacts not handled are not started (`cancelled`), and runs
 * already started go on. It ends as `stopped` with `stopped_by_api`, naming the key; one that has
 * ended is refused (409 `enrollment_ended`). Audited as the key.
 */
export async function apiStopEnrollment(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  automationId: string,
  enrollmentId: string,
): Promise<ApiAutomationEnrollmentDetail> {
  assertScope(ctx, 'automations.start');
  if (!z.uuid().safeParse(automationId).success || !z.uuid().safeParse(enrollmentId).success) {
    throw notFound('Enrolment');
  }
  return deps.db.run(ctx.scope, async (tx) => {
    const { enrollment, cancelled } = await stopRunningEnrollment(
      tx,
      ctx.tenant.id,
      enrollmentId,
      { apiKeyId: ctx.key.id },
      deps.clock.now(),
      automationId,
    );
    await recordSystemAudit(
      tx,
      ctx.tenant.id,
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
        correlationId: ctx.requestId,
      },
      apiActor(ctx),
    );
    return toApiEnrollmentDetail(
      await readEnrollmentDetail(tx, ctx.tenant.id, enrollment.id, true),
      hasScope(ctx, 'campaigns.read'),
    );
  });
}
