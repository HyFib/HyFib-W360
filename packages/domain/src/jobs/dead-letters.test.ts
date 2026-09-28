import { describe, expect, it } from 'vitest';
import { deadLetterError, deadLetterRow, type DeadLetterJob } from './dead-letters';
import { JobSigner } from './envelope';

const signer = new JobSigner('k'.repeat(40));
const other = new JobSigner('o'.repeat(40));
const TENANT = '0192a1b2-0000-7000-8000-000000000001';

function job(overrides: Partial<DeadLetterJob> = {}): DeadLetterJob {
  return {
    id: '0192a1b2-0000-7000-8000-00000000000a',
    data: signer.sign({
      kind: 'commerce.store',
      tenantId: TENANT,
      actorUserId: null,
      ref: 'store-1',
    }),
    output: {
      name: 'AppError',
      code: 'provider_rejected',
      message: 'Shopify said no to +919000000000',
    },
    sourceName: 'commerce.store',
    sourceId: '0192a1b2-0000-7000-8000-00000000000b',
    sourceCreatedOn: new Date('2026-09-28T08:00:00Z'),
    sourceRetryCount: 5,
    createdOn: new Date('2026-09-28T08:15:00Z'),
    ...overrides,
  };
}

describe('dead-letter errors', () => {
  it("keeps only the error's name and code, never its message, stack or details", () => {
    expect(
      deadLetterError({
        name: 'DatabaseError',
        code: '23505',
        message: 'duplicate key value violates unique constraint',
        detail: 'Key (phone_e164)=(+919000000000) already exists.',
        stack: 'at …',
      }),
    ).toEqual({ name: 'DatabaseError', code: '23505' });
    expect(deadLetterError({ name: 'RetryableJobError', message: 'store unreachable' })).toEqual({
      name: 'RetryableJobError',
      code: null,
    });
  });

  it('names pg-boss timeouts, refuses odd values and accepts numeric codes', () => {
    expect(deadLetterError({ value: { message: 'job timed out' } })).toEqual({
      name: 'Timeout',
      code: 'job_timed_out',
    });
    expect(deadLetterError({ value: { message: 'job heartbeat timeout' } })).toEqual({
      name: 'Timeout',
      code: 'heartbeat_timeout',
    });
    expect(deadLetterError({ value: { message: 'something else' } })).toEqual({
      name: null,
      code: null,
    });
    expect(deadLetterError({ name: 'Error: +91 900', code: 'has space' })).toEqual({
      name: null,
      code: null,
    });
    expect(deadLetterError({ name: 'Error', code: 131026 })).toEqual({
      name: 'Error',
      code: '131026',
    });
    expect(deadLetterError('boom')).toEqual({ name: null, code: null });
    expect(deadLetterError(null)).toEqual({ name: null, code: null });
  });
});

describe('dead-letter rows', () => {
  it('attributes a job to its company only when its signature verifies', () => {
    expect(deadLetterRow(signer, job())).toMatchObject({
      id: job().id,
      sourceQueue: 'commerce.store',
      sourceJobId: job().sourceId,
      kind: 'commerce.store',
      tenantId: TENANT,
      ref: 'store-1',
      verified: true,
      retries: 5,
      errorName: 'AppError',
      errorCode: 'provider_rejected',
      failedAt: job().createdOn,
    });
    const forged = deadLetterRow(
      signer,
      job({
        data: other.sign({ kind: 'commerce.store', tenantId: TENANT, actorUserId: null, ref: 'x' }),
      }),
    );
    expect(forged).toMatchObject({ verified: false, kind: null, tenantId: null, ref: null });
    expect(deadLetterRow(signer, job({ data: { kind: 'junk' } })).verified).toBe(false);
  });

  it('keeps malformed metadata out of the row', () => {
    const row = deadLetterRow(
      signer,
      job({ sourceName: 'Not A Queue!', sourceId: 'not-a-uuid', sourceRetryCount: -1 }),
    );
    expect(row).toMatchObject({ sourceQueue: 'unknown', sourceJobId: null, retries: null });
    expect(deadLetterRow(signer, job({ sourceName: null })).sourceQueue).toBe('unknown');
  });
});
