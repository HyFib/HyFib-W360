import { z } from 'zod';
import { AppError } from '@w360/core';
import type { AutomationEnrollmentEndReason } from '@w360/db';
import { contactFilterSchema } from '../contacts/service';
import { startRefusalOf, type StartRefusal } from './starts';

/**
 * Members' enrolments of contacts or a segment in an automation started by a member or through the
 * API (ADR-401): the bounds, what a member submits, and the batch logic the enrolment job runs, kept
 * apart from the database so it is tested on its own.
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

/** Whether a running enrolment's next batch is overdue by more than the stall bound. */
export function enrollmentStalled(nextBatchAt: Date | null, now: Date): boolean {
  return (
    nextBatchAt !== null &&
    now.getTime() - nextBatchAt.getTime() > ENROLLMENT_LIMITS.stallMinutes * 60_000
  );
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
    'The automation sends marketing templates, which the member who started it may no longer send.',
};

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
