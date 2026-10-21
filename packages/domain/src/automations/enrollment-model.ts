import { z } from 'zod';
import { AppError } from '@w360/core';
import {
  AUTOMATION_ENROLLMENT_OUTCOMES,
  type ApiScope,
  type AutomationEnrollmentEndReason,
  type AutomationEnrollmentOutcome,
  type AutomationEnrollmentSource,
} from '@w360/db';
import { contactFilterSchema } from '../contacts/service';
import { startRefusalOf, type StartRefusal } from './starts';

/**
 * Enrolments of contacts or a segment in an automation started by a member or through the API, by
 * members (ADR-401) or API keys (ADR-403): the bounds, what a member submits, the batch logic the
 * enrolment job runs and the re-check of the key that started one, kept apart from the database so
 * they are tested on their own.
 */

export const ENROLLMENT_LIMITS = {
  /**
   * Contacts one enrolment takes: the most a bulk edit of contacts takes (ADR-213). Larger
   * audiences are a campaign's work (up to 50,000, with pacing, a spending cap and approval); an
   * enrolment starts a run, and so a conversation and its plan's run, per contact.
   */
  contacts: 10_000,
  /**
   * Starts in one transaction: each keeps its savepoint's transaction id until the batch commits, and
   * PostgreSQL caches 64 per transaction (ADR-161's reason for 50).
   */
  batch: 50,
  /**
   * Minutes a running enrolment's next batch may be overdue before the minute sweep signals it
   * again (its job lost or out of retries) and its page says it has made no progress.
   */
  stallMinutes: 10,
  /**
   * Times the sweep signals an enrolment again without a batch handled in between before the next
   * sweep ends it as failed (`stalled`): a batch that fails every time does not loop for ever.
   */
  resignals: 3,
  /**
   * Slack when a job checks that its batch is due: pg-boss starts a delayed job at its time, but the
   * clocks of the worker and the database may differ by a little.
   */
  dueSlackMs: 1_000,
} as const;

/**
 * How long after a batch the next one may start: the runs it started, at the number's send rate
 * (`META_SEND_RATE_PER_SECOND`, the rate campaigns pace by when they have none of their own), so an
 * enrolment starts runs, and their first messages, no faster than the number sends.
 */
export function enrollmentBatchDelayMs(started: number, sendRatePerSecond: number): number {
  if (started <= 0) return 0;
  return Math.ceil((started * 1000) / Math.max(1, sendRatePerSecond));
}

/**
 * Whether a running enrolment's next batch is overdue by the stall bound or more, as the sweep's due
 * list counts it (`next_batch_at <= now() - 10 minutes`).
 */
export function enrollmentStalled(nextBatchAt: Date | null, now: Date): boolean {
  return (
    nextBatchAt !== null &&
    now.getTime() - nextBatchAt.getTime() >= ENROLLMENT_LIMITS.stallMinutes * 60_000
  );
}

/**
 * Whether a batch may run now: not before the time its enrolment's next batch is due, so a second
 * chain of jobs (a deferred one beside the sweep's, a retry after a lost completion) waits instead of
 * doubling the pace.
 */
export function enrollmentBatchDue(nextBatchAt: Date | null, now: Date): boolean {
  return (
    nextBatchAt === null || nextBatchAt.getTime() <= now.getTime() + ENROLLMENT_LIMITS.dueSlackMs
  );
}

/** What the sweep does with an overdue enrolment: signal it again, or end it as failed. */
export function enrollmentSweepAction(resignalCount: number): 'signal' | 'fail' {
  return resignalCount >= ENROLLMENT_LIMITS.resignals ? 'fail' : 'signal';
}

/** Whom an enrolment takes: the contacts the contacts page's filters match, or a saved segment. */
export const enrollmentAudienceSchema = z.discriminatedUnion('kind', [
  // The Contacts page's own filter schema, so a filter it adds is never silently ignored here.
  z.object({ kind: z.literal('contacts'), filter: contactFilterSchema }),
  z.object({ kind: z.literal('segment'), segmentId: z.uuid({ error: 'Choose a segment.' }) }),
]);
export type EnrollmentAudience = z.infer<typeof enrollmentAudienceSchema>;

/** Counting whom an enrolment would take, before the member confirms. */
export const enrollmentPreviewSchema = z.object({
  automationId: z.uuid({ error: 'Choose an automation.' }),
  audience: enrollmentAudienceSchema,
});

/** Starting an enrolment: the count the member was shown goes with it (as ADR-213's bulk edits). */
export const startEnrollmentSchema = enrollmentPreviewSchema.extend({
  inputs: z.record(z.string(), z.unknown()).default({}),
  expectedCount: z
    .number()
    .int()
    .min(1, 'No contact to enrol.')
    .max(ENROLLMENT_LIMITS.contacts, `At most ${ENROLLMENT_LIMITS.contacts} contacts.`),
});

/** Stopping an enrolment. */
export const stopEnrollmentSchema = z.object({ id: z.uuid() });

/**
 * Refuses an enrolment of `found` contacts (counted up to one more than the limit) when there are
 * none, more than the limit, or a number other than the one the member was shown.
 */
export function assertEnrollableCount(found: number, expected: number): void {
  const limit = ENROLLMENT_LIMITS.contacts;
  if (found === 0) throw new AppError('validation_failed', 'No contact matches: nobody to enrol.');
  if (found > limit) {
    throw new AppError(
      'validation_failed',
      `At most ${limit.toLocaleString('en-IN')} contacts can be enrolled at once. Narrow the filters or the segment, or send a campaign.`,
    );
  }
  if (found !== expected) {
    throw new AppError(
      'conflict',
      `These contacts now number ${found.toLocaleString('en-IN')}, not ${expected.toLocaleString('en-IN')}. Review them and try again.`,
    );
  }
}

/** Why a contact was not started: a start step's code, or the enrolment's own checks. */
export type EnrollmentRefusal =
  | Exclude<
      StartRefusal,
      'automation_unavailable' | 'automation_paused' | 'channel_unavailable' | 'not_in_plan'
    >
  /** The contact was merged into another after the snapshot. */
  | 'contact_gone'
  /** The contact has no phone number to start a conversation with. */
  | 'no_number';

/** How members read each refusal (enrolment pages). */
export const ENROLLMENT_REFUSAL_LABELS: Record<EnrollmentRefusal, string> = {
  contact_erased: 'Erased',
  suppressed: 'On the suppression list',
  opted_out: 'Opted out',
  no_marketing_opt_in: 'No marketing opt-in',
  conversation_assigned: 'Conversation assigned to a member',
  automation_busy: 'Another automation was handling the conversation',
  automation_limit: 'Hourly limit of runs in the conversation',
  automation_quota: 'No automation runs left in the plan this month',
  contact_gone: 'Merged into another contact',
  no_number: 'No phone number',
};

/** How members read why an enrolment stopped (enrolment pages). */
export const ENROLLMENT_END_REASON_LABELS: Record<AutomationEnrollmentEndReason, string> = {
  stopped_by_member: 'A member stopped it.',
  member_removed: 'The member who started it left the company or may no longer start automations.',
  automation_paused: 'The automation was paused.',
  automation_unavailable:
    'The automation was archived, or its live version no longer starts by a member.',
  channel_unavailable: 'The automation’s WhatsApp number is not active.',
  not_in_plan: 'The company’s plan does not include automations.',
  inputs_changed: 'The automation’s live version takes other inputs than the ones given.',
  marketing_not_allowed:
    'The automation sends marketing templates, which the member or API key that started it may no longer send.',
  stalled:
    'Its next batch kept failing: HyFib tried it again 3 times after it stopped making progress.',
  stopped_by_api: 'An API key stopped it.',
  api_key_revoked: 'The API key that started it was revoked.',
  api_key_expired:
    'The API key that started it expired (a rotated key expires when its overlap ends).',
  api_not_in_plan: 'The company’s plan no longer includes the API.',
  api_scope_missing:
    'The company’s plan no longer includes a scope the API key that started it needs to enrol contacts.',
};

/** The status an enrolment ends with for a reason (none: every contact was handled). */
export function enrollmentEndStatus(
  reason: AutomationEnrollmentEndReason | null,
): 'completed' | 'stopped' | 'failed' {
  if (reason === null) return 'completed';
  return reason === 'stalled' ? 'failed' : 'stopped';
}

/** A pending contact of a batch, in snapshot order. */
export interface PendingEnrollee {
  /** The enrolment contact row. */
  id: string;
  position: number;
}

/** What the start of one contact gave. */
export type EnrolleeStart =
  { outcome: 'started'; runId: string } | { outcome: 'refused'; reason: EnrollmentRefusal };

/** A contact a batch handled. */
export type EnrolleeOutcome = PendingEnrollee & EnrolleeStart;

export interface EnrollmentBatchResult {
  /** The contacts handled, in order: each started or refused. */
  outcomes: EnrolleeOutcome[];
  /** Set when a start showed the enrolment cannot go on (the plan has no automations). */
  end: AutomationEnrollmentEndReason | null;
}

/**
 * Runs one batch: the first `ENROLLMENT_LIMITS.batch` pending contacts, in order, each through
 * `start` (which the caller runs in a savepoint of its own). A refused start is recorded with its
 * code and the next contact goes on; a plan without automations ends the batch, the contact not
 * handled; any other error is thrown, so the job fails and its transaction rolls back every start
 * of the batch (the retry starts them again from the same position, never twice).
 */
export async function runEnrollmentBatch<T extends PendingEnrollee>(
  pending: readonly T[],
  start: (enrollee: T) => Promise<EnrolleeStart>,
): Promise<EnrollmentBatchResult> {
  const outcomes: EnrolleeOutcome[] = [];
  const batch = [...pending]
    .sort((a, b) => a.position - b.position)
    .slice(0, ENROLLMENT_LIMITS.batch);
  for (const enrollee of batch) {
    let result: EnrolleeStart;
    try {
      result = await start(enrollee);
    } catch (error) {
      const refusal = startRefusalOf(error);
      if (refusal === 'not_in_plan') return { outcomes, end: 'not_in_plan' };
      if (
        refusal === null ||
        refusal === 'automation_unavailable' ||
        refusal === 'automation_paused' ||
        refusal === 'channel_unavailable'
      ) {
        throw error;
      }
      result = { outcome: 'refused', reason: refusal };
    }
    outcomes.push({ id: enrollee.id, position: enrollee.position, ...result });
  }
  return { outcomes, end: null };
}

/**
 * The job key of the batch after `position`: pg-boss keeps at most one job per key, so a duplicate
 * signal for the same batch collapses, and the next batch's signal never collides with the job
 * that queued it.
 */
export const enrollmentJobKey = (enrollmentId: string, position: number): string =>
  `${enrollmentId}:${position}`;

/** The end reason of an automation check that refused a batch, or null for any other error. */
export function enrollmentEndForRefusal(error: unknown): AutomationEnrollmentEndReason | null {
  const refusal = startRefusalOf(error);
  switch (refusal) {
    case 'automation_unavailable':
    case 'automation_paused':
    case 'channel_unavailable':
    case 'not_in_plan':
      return refusal;
    default:
      return null;
  }
}

/** Refusals by reason, most frequent first (then by label), for an enrolment's summary. */
export function summariseRefusals(
  counts: readonly { reason: string; count: number }[],
): { reason: string; label: string; count: number }[] {
  return counts
    .filter((c) => c.count > 0)
    .map((c) => ({
      reason: c.reason,
      label: ENROLLMENT_REFUSAL_LABELS[c.reason as EnrollmentRefusal] ?? c.reason,
      count: c.count,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * The scopes a key needs to enrol contacts (ADR-403): to start automations and read contacts, and
 * to read segments for a segment's members (`messages.send_marketing` too when the automation sends
 * marketing templates, checked where that is known). Each batch checks them again.
 */
export function enrollmentKeyScopes(source: AutomationEnrollmentSource): ApiScope[] {
  return source === 'segment'
    ? ['automations.start', 'contacts.read', 'campaigns.read']
    : ['automations.start', 'contacts.read'];
}

/** The key that started an enrolment, as its batch reads it (the scopes never change, 0024). */
export interface EnrollmentKeyStanding {
  revokedAt: Date | null;
  expiresAt: Date | null;
  scopes: readonly string[];
}

/** What the company's plan gives the API now (ADR-061, ADR-092). */
export interface EnrollmentKeyPlan {
  /** The plan's monthly API requests: 0 leaves the API out; null has no limit. */
  apiRequests: number | null;
  /** The scopes the plan includes; null: every scope. */
  apiScopes: ReadonlySet<ApiScope> | null;
}

/**
 * Whether a key may still use a scope as a fresh request would: the key holds it and the plan
 * includes it (`hasScope`, ADR-092).
 */
export function enrollmentKeyMayUse(
  key: EnrollmentKeyStanding,
  plan: EnrollmentKeyPlan,
  scope: ApiScope,
): boolean {
  return key.scopes.includes(scope) && (plan.apiScopes === null || plan.apiScopes.has(scope));
}

/**
 * Why an enrolment a key started may not go on, checked once per batch as a fresh request with the
 * key would be (ADR-403), or null: the key is gone or revoked, it expired (by the database's now),
 * the plan no longer includes the API, or the key or the plan no longer gives a scope enrolling
 * needs. The monthly request count is not checked: batches are not requests (the POST counted
 * once). A suspended company's job is deferred before any batch runs, as for a member's enrolment.
 */
export function apiKeyEnrollmentEnd(input: {
  key: EnrollmentKeyStanding | null;
  plan: EnrollmentKeyPlan;
  source: AutomationEnrollmentSource;
  now: Date;
}): AutomationEnrollmentEndReason | null {
  const { key, plan, source, now } = input;
  if (!key || key.revokedAt) return 'api_key_revoked';
  if (key.expiresAt && key.expiresAt.getTime() <= now.getTime()) return 'api_key_expired';
  if (plan.apiRequests === 0) return 'api_not_in_plan';
  if (!enrollmentKeyScopes(source).every((scope) => enrollmentKeyMayUse(key, plan, scope))) {
    return 'api_scope_missing';
  }
  return null;
}

// An enrolment's contacts with their outcomes (ADR-408) ---------------------------------------

/** Contacts on one page of an enrolment's list in the app, as the app's other long lists. */
export const ENROLLED_CONTACTS_PAGE = 50;

/** How members read each contact's outcome (the enrolment page's counts use the same words). */
export const ENROLLED_OUTCOME_LABELS: Record<AutomationEnrollmentOutcome, string> = {
  pending: 'Waiting',
  started: 'Started',
  refused: 'Refused',
  cancelled: 'Not started',
};

const INVALID_CURSOR = 'Invalid cursor: give the nextCursor of the previous page.';

/**
 * The position after which a page of an enrolment's contacts starts: the last position of the page
 * before (`nextCursor`), 1 to the most contacts an enrolment takes. Positions never change, so a
 * page never skips or repeats a contact.
 */
export const enrolledContactsCursorSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,4}$/, { error: INVALID_CURSOR })
  .transform(Number)
  .refine((position) => position <= ENROLLMENT_LIMITS.contacts, { error: INVALID_CURSOR });

/** A page of an enrolment's contacts on members' pages: one outcome or all, after a cursor. */
export const enrolledContactsQuerySchema = z
  .object({
    outcome: z.enum(AUTOMATION_ENROLLMENT_OUTCOMES).optional(),
    cursor: enrolledContactsCursorSchema.optional(),
  })
  .strict();

/** One row of an enrolment's contacts as the database gives it, with the contact as it is now. */
export interface EnrolledContactRow {
  position: number;
  /** NULL once the contact was merged into another (the merge deletes it). */
  contactId: string | null;
  displayName: string | null;
  phoneE164: string | null;
  erasedAt: Date | null;
  outcome: AutomationEnrollmentOutcome;
  reason: string | null;
  runId: string | null;
  processedAt: Date | null;
}

/** What became of the contact since the snapshot. */
export type EnrolledContactState = 'active' | 'erased' | 'merged';

/** One enrolled contact as members' pages and the API read it. */
export interface EnrolledContact {
  position: number;
  /** The contact; null once it was erased or merged into another (nothing left to open). */
  contactId: string | null;
  contact: EnrolledContactState;
  /** The name and number as the viewer may see them; null for an erased or merged contact. */
  name: string | null;
  phone: string | null;
  outcome: AutomationEnrollmentOutcome;
  /** Why a start was refused (the refusal's code); null for any other outcome. */
  reason: string | null;
  /** The refusal as members read it, falling back to its code. */
  reasonLabel: string | null;
  /** The run started for the contact; null otherwise, or once retention deleted it. */
  runId: string | null;
  /** When the enrolment handled the contact; null while it waits. */
  processedAt: Date | null;
}

/**
 * Maps a row onto what members' pages and the API show. `shownNumber` gives the number as the
 * viewer may see it (ADR-226 masking). An erased contact shows neither name, number nor an id to
 * open; a contact merged away has no row left to name.
 */
export function toEnrolledContact(
  row: EnrolledContactRow,
  shownNumber: (phone: string | null) => string | null,
): EnrolledContact {
  const contact: EnrolledContactState =
    row.contactId === null ? 'merged' : row.erasedAt ? 'erased' : 'active';
  const active = contact === 'active';
  const refused = row.outcome === 'refused' ? row.reason : null;
  return {
    position: row.position,
    contactId: active ? row.contactId : null,
    contact,
    name: active ? row.displayName : null,
    phone: active ? shownNumber(row.phoneE164) : null,
    outcome: row.outcome,
    reason: refused,
    reasonLabel: refused
      ? (ENROLLMENT_REFUSAL_LABELS[refused as EnrollmentRefusal] ?? refused)
      : null,
    runId: row.outcome === 'started' ? row.runId : null,
    processedAt: row.processedAt,
  };
}

/** How members' pages name an enrolled contact. */
export function enrolledContactLabel(
  c: Pick<EnrolledContact, 'contact' | 'name' | 'phone'>,
): string {
  if (c.contact === 'erased') return 'Erased contact';
  if (c.contact === 'merged') return 'Merged into another contact';
  return c.name ?? c.phone ?? 'Unnamed contact';
}

/**
 * A page read with one row more than `limit`: the rows to show, and the next page's cursor (the
 * last position shown) when there is one.
 */
export function enrolledContactsPage<T extends { position: number }>(
  rows: readonly T[],
  limit: number,
): { shown: T[]; nextCursor: string | null } {
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return { shown, nextCursor: rows.length > limit && last ? String(last.position) : null };
}
