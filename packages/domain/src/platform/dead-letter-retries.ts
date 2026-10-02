import { ALL_QUEUES, QUEUES } from '@w360/contracts';

/**
 * Retrying a dead letter's job from the operations console (ADR-108). The definer function
 * `ops.platform_retry_dead_letter` checks all of this again in the retry's transaction; the console
 * offers the retry only when these facts allow it.
 */
export interface DeadLetterRetryFacts {
  sourceQueue: string;
  failedAt: Date;
  verified: boolean;
  sourceJobId: string | null;
  retriedAt: Date | null;
  tenantId: string | null;
  /** The job's company's status; null when the company is gone (or the job has none). */
  tenantStatus: string | null;
}

/** Why the console does not offer to retry a dead letter's job. */
export type DeadLetterRetryBlock =
  'retried' | 'unverified' | 'undeclared' | 'no_retries' | 'receipt' | 'expired' | 'company';

export const DEAD_LETTER_RETRY_BLOCK_TEXT: Record<DeadLetterRetryBlock, string> = {
  retried: 'Already retried',
  unverified: 'Its signature did not verify, so the worker would refuse it again',
  undeclared: 'Its queue is not declared by this release',
  no_retries: 'Its queue never retries its jobs',
  receipt: 'Retry its receipt on the Integrations page instead',
  expired: 'pg-boss no longer keeps the failed job',
  company: 'Its company is being deleted or is gone',
};

const HOUR_MS = 3_600_000;

/**
 * Queues whose jobs process a Meta or Razorpay receipt: the receipt retry (ADR-054) resets the
 * receipt's attempts and refuses one whose body was erased, so their jobs are not retried here.
 */
const RECEIPT_QUEUES: ReadonlySet<string> = new Set([
  QUEUES.webhookProcess.name,
  QUEUES.billingEventProcess.name,
]);

/**
 * Until when pg-boss keeps a dead letter's failed job, so that it can be retried: its queue's
 * deletion time after the failure (pg-boss deletes a failed job once its completion time plus the
 * queue's `deleteAfterSeconds` has passed). Null for a queue this release does not declare.
 */
export function deadLetterRetryableUntil(queue: string, failedAt: Date): Date | null {
  const definition = ALL_QUEUES.find((q) => q.name === queue);
  return definition ? new Date(failedAt.getTime() + definition.deleteAfterHours * HOUR_MS) : null;
}

/** What keeps the console from offering to send the job back to its queue now; null if nothing. */
export function deadLetterRetryBlock(
  facts: DeadLetterRetryFacts,
  now: Date,
): DeadLetterRetryBlock | null {
  if (facts.retriedAt !== null) return 'retried';
  if (!facts.verified || facts.sourceJobId === null) return 'unverified';
  const definition = ALL_QUEUES.find((q) => q.name === facts.sourceQueue);
  if (!definition) return 'undeclared';
  // billing.auto-recharge: its sweep repeats an attempt only after looking it up at Razorpay
  // (RUNBOOKS §9), so its job is never run again as it was.
  if (definition.retryLimit === 0) return 'no_retries';
  if (RECEIPT_QUEUES.has(definition.name)) return 'receipt';
  const until = deadLetterRetryableUntil(facts.sourceQueue, facts.failedAt);
  if (until === null || until <= now) return 'expired';
  if (
    facts.tenantId !== null &&
    (facts.tenantStatus === null ||
      facts.tenantStatus === 'pending_deletion' ||
      facts.tenantStatus === 'deleted')
  ) {
    return 'company';
  }
  return null;
}
