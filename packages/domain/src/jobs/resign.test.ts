import { describe, expect, it } from 'vitest';
import type { Database } from '@w360/db';
import { JobSigner } from './envelope';
import {
  MALFORMED_KEY_ID,
  RESIGN_SKIP_LIMIT,
  jobSigningOverview,
  newResignState,
  parseJobSigningKeyCounts,
  resignQueuedJobs,
} from './resign';

/** A database that fails the test if the sweep looks anything up. */
const noLookups = {
  run: () => {
    throw new Error('no lookup expected');
  },
} as unknown as Database;

const OLD = 'o'.repeat(40);
const NEW = 'n'.repeat(40);
const clock = { now: () => new Date('2026-10-03T12:00:00Z') };

describe('signing queued jobs again (ADR-135)', () => {
  it('looks nothing up without a previous key, even with a next one', async () => {
    for (const signer of [new JobSigner(NEW), new JobSigner(OLD, { next: NEW })]) {
      const result = await resignQueuedJobs({ db: noLookups, signer, clock }, newResignState());
      expect(result).toEqual({ resigned: 0, changed: 0, unverifiable: [], stopped: false });
    }
  });

  it('looks nothing up within the hour after a lookup found nothing', async () => {
    const state = { ...newResignState(), idleUntil: clock.now().getTime() + 1 };
    const result = await resignQueuedJobs(
      { db: noLookups, signer: new JobSigner(NEW, { previous: OLD }), clock },
      state,
    );
    expect(result).toEqual({ resigned: 0, changed: 0, unverifiable: [], stopped: false });
  });

  it('stops once too many jobs did not verify', async () => {
    const state = newResignState();
    for (let i = 0; i < RESIGN_SKIP_LIMIT; i += 1) state.skip.add(`crm.reminder:${i}`);
    const result = await resignQueuedJobs(
      { db: noLookups, signer: new JobSigner(NEW, { previous: OLD }), clock },
      state,
    );
    expect(result.stopped).toBe(true);
  });
});

describe('the console view of job signing (ADR-135)', () => {
  const step2 = new JobSigner(NEW, { previous: OLD });
  const other = new JobSigner('x'.repeat(40)).keyId;

  it('lists the configured keys first, even with no job, then key ids found only in jobs', () => {
    const o = jobSigningOverview(step2, [
      { keyId: other, state: 'created', jobs: 2 },
      { keyId: null, state: 'retry', jobs: 3 },
      { keyId: step2.previousKeyId, state: 'created', jobs: 4 },
      { keyId: step2.previousKeyId, state: 'failed', jobs: 1 },
      { keyId: step2.previousKeyId, state: 'active', jobs: 5 },
      { keyId: step2.keyId, state: 'retry', jobs: 7 },
      { keyId: step2.keyId, state: 'created', jobs: 6 },
    ]);
    expect(o.keys).toEqual([
      { keyId: step2.keyId, role: 'signing', queued: 13, active: 0, failed: 0 },
      { keyId: step2.previousKeyId, role: 'previous', queued: 4, active: 5, failed: 1 },
      { keyId: null, role: 'none', queued: 3, active: 0, failed: 0 },
      { keyId: other, role: 'not_configured', queued: 2, active: 0, failed: 0 },
    ]);
    // What the previous key or no key signed is signed again; another key's jobs are refused.
    expect(o.toResign).toBe(4 + 5 + 1 + 3);
    expect(o.unverifiable).toBe(2);
    expect([o.keyId, o.nextKeyId, o.previousKeyId]).toEqual([
      step2.keyId,
      null,
      step2.previousKeyId,
    ]);
  });

  it('counts nothing to sign again without a previous key, and shows the next key', () => {
    const step1 = new JobSigner(OLD, { next: NEW });
    const o = jobSigningOverview(step1, [{ keyId: null, state: 'created', jobs: 3 }]);
    expect(o.toResign).toBe(0);
    expect(o.unverifiable).toBe(0);
    expect(o.keys.map((k) => [k.keyId, k.role])).toEqual([
      [step1.keyId, 'signing'],
      [step1.nextKeyId, 'next'],
      [null, 'none'],
    ]);
    const quiet = jobSigningOverview(new JobSigner(NEW), []);
    expect(quiet.keys).toEqual([
      { keyId: new JobSigner(NEW).keyId, role: 'signing', queued: 0, active: 0, failed: 0 },
    ]);
  });

  it('reads counts, dropping other states and naming key ids in another form', () => {
    expect(
      parseJobSigningKeyCounts([
        { key_id: 'abcdef0123456789', state: 'created', jobs: '12' },
        { key_id: null, state: 'failed', jobs: 1 },
        { key_id: '<script>', state: 'retry', jobs: '2' },
        { key_id: 'abcdef0123456789', state: 'completed', jobs: '9' },
      ]),
    ).toEqual([
      { keyId: 'abcdef0123456789', state: 'created', jobs: 12 },
      { keyId: null, state: 'failed', jobs: 1 },
      { keyId: MALFORMED_KEY_ID, state: 'retry', jobs: 2 },
    ]);
  });
});
