import { describe, expect, it } from 'vitest';
import { ALL_QUEUES, QUEUES } from '@w360/contracts';
import {
  DEAD_LETTER_RETRY_BLOCK_TEXT,
  deadLetterRetryBlock,
  deadLetterRetryableUntil,
  type DeadLetterRetryFacts,
} from './dead-letter-retries';

const FAILED = new Date('2026-10-01T10:00:00Z');
const HOUR_MS = 3_600_000;

/** A dead letter the console offers to retry: verified, with its job, not retried, its company active. */
const letter: DeadLetterRetryFacts = {
  sourceQueue: QUEUES.emailSend.name,
  failedAt: FAILED,
  verified: true,
  sourceJobId: '0190a5b2-0000-7000-8000-000000000001',
  retriedAt: null,
  tenantId: '0190a5b2-0000-7000-8000-000000000002',
  tenantStatus: 'active',
};

describe('retrying a dead letter (ADR-108)', () => {
  it('can retry until its queue deletes the failed job, and not for a queue this release does not declare', () => {
    // email.send keeps failed jobs 72 hours, tenant.delete a week.
    expect(deadLetterRetryableUntil(QUEUES.emailSend.name, FAILED)).toEqual(
      new Date(FAILED.getTime() + 72 * HOUR_MS),
    );
    expect(deadLetterRetryableUntil(QUEUES.tenantDelete.name, FAILED)).toEqual(
      new Date(FAILED.getTime() + 168 * HOUR_MS),
    );
    expect(deadLetterRetryableUntil('it.not-declared', FAILED)).toBeNull();

    const justBefore = new Date(FAILED.getTime() + 72 * HOUR_MS - 1);
    const atDeletion = new Date(FAILED.getTime() + 72 * HOUR_MS);
    expect(deadLetterRetryBlock(letter, justBefore)).toBeNull();
    expect(deadLetterRetryBlock(letter, atDeletion)).toBe('expired');
    expect(deadLetterRetryBlock({ ...letter, sourceQueue: 'it.not-declared' }, FAILED)).toBe(
      'undeclared',
    );
  });

  it('offers no retry of a job whose queue never retries its jobs', () => {
    // billing.auto-recharge looks an attempt up at Razorpay before repeating anything.
    expect(QUEUES.autoRecharge.retryLimit).toBe(0);
    expect(deadLetterRetryBlock({ ...letter, sourceQueue: QUEUES.autoRecharge.name }, FAILED)).toBe(
      'no_retries',
    );
    expect(ALL_QUEUES.filter((q) => q.retryLimit === 0).map((q) => q.name)).toEqual([
      QUEUES.autoRecharge.name,
    ]);
  });

  it('points to the receipt retry for jobs of the receipt queues', () => {
    for (const queue of [QUEUES.webhookProcess.name, QUEUES.billingEventProcess.name]) {
      expect(deadLetterRetryBlock({ ...letter, sourceQueue: queue }, FAILED), queue).toBe(
        'receipt',
      );
    }
    expect(DEAD_LETTER_RETRY_BLOCK_TEXT.receipt).toBe(
      'Retry its receipt on the Integrations page instead',
    );
  });

  it('offers no retry of a job already retried, or one whose signature did not verify or whose id is unknown', () => {
    const now = new Date(FAILED.getTime() + HOUR_MS);
    expect(deadLetterRetryBlock({ ...letter, retriedAt: now }, now)).toBe('retried');
    expect(
      deadLetterRetryBlock({ ...letter, verified: false, tenantId: null, tenantStatus: null }, now),
    ).toBe('unverified');
    expect(deadLetterRetryBlock({ ...letter, sourceJobId: null }, now)).toBe('unverified');
    // Retried comes first: the console shows who retried it instead.
    expect(
      deadLetterRetryBlock({ ...letter, retriedAt: now, sourceQueue: 'it.not-declared' }, now),
    ).toBe('retried');
  });

  it("offers no retry of a job whose company is being deleted or is gone, and retries a suspended company's or a platform job", () => {
    const now = new Date(FAILED.getTime() + HOUR_MS);
    for (const status of ['active', 'suspended']) {
      expect(deadLetterRetryBlock({ ...letter, tenantStatus: status }, now), status).toBeNull();
    }
    for (const status of ['pending_deletion', 'deleted', null]) {
      expect(deadLetterRetryBlock({ ...letter, tenantStatus: status }, now), String(status)).toBe(
        'company',
      );
    }
    expect(deadLetterRetryBlock({ ...letter, tenantId: null, tenantStatus: null }, now)).toBeNull();
  });

  it('says why in words', () => {
    expect(DEAD_LETTER_RETRY_BLOCK_TEXT.expired).toBe('pg-boss no longer keeps the failed job');
    expect(Object.keys(DEAD_LETTER_RETRY_BLOCK_TEXT).sort()).toEqual(
      ['company', 'expired', 'no_retries', 'receipt', 'retried', 'undeclared', 'unverified'].sort(),
    );
  });

  it('keeps every failed job it retries well inside the 14 days pg-boss keeps a waiting job', () => {
    // pg-boss deletes a waiting job 14 days after it was first due (its default retention, which
    // the migration runner does not change) and a failed one after its queue's deleteAfterSeconds.
    // A retry is offered only while the failed job is kept, so with a week at most a retried job
    // still has about a week before pg-boss would delete it unstarted.
    for (const queue of ALL_QUEUES.filter((q) => q.deadLetter)) {
      expect(queue.deleteAfterHours, queue.name).toBeLessThanOrEqual(7 * 24);
    }
  });
});
