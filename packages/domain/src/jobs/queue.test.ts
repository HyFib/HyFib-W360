import { describe, expect, it } from 'vitest';
import { pgBossErrorContext } from './queue';

describe('pgBossErrorContext', () => {
  it("keeps the queue and worker pg-boss copies into a worker's error, and nothing else", () => {
    // pg-boss emits `{ ...error, message, stack, queue, worker }` for a worker's failed fetch.
    const copy = {
      severity: 'ERROR',
      code: '23505',
      message: 'duplicate key value violates unique constraint "job_pkey"',
      detail: 'Key (id)=(Priya) already exists.',
      queue: 'messaging.send',
      worker: '0d6c1f3e-2a4b-4c5d-8e9f-0a1b2c3d4e5f',
    };
    expect(pgBossErrorContext(copy)).toEqual({
      queue: 'messaging.send',
      worker: '0d6c1f3e-2a4b-4c5d-8e9f-0a1b2c3d4e5f',
    });
    expect(pgBossErrorContext(new Error('pool ended'))).toEqual({});
    expect(pgBossErrorContext({ queue: 5, worker: { id: 'w' } })).toEqual({});
    expect(pgBossErrorContext('text')).toEqual({});
    expect(pgBossErrorContext(null)).toEqual({});
  });
});
