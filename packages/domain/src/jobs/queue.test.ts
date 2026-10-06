import { describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';
import type { JobEnvelope } from '@w360/contracts';
import {
  PgBossJobQueue,
  RAISE_WAITING_JOB_PRIORITY_SQL,
  RecordingJobQueue,
  pgBossErrorContext,
} from './queue';

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

describe('raising the priority of a waiting job (ADR-178)', () => {
  it('raises the waiting job of the queue and key only, and only when its priority is lower', async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const boss = {
      getDb: () => ({
        executeSql: async (text: string, values: unknown[] = []) => {
          calls.push({ text, values });
          return { rows: [{ id: 'job-1' }] };
        },
      }),
    } as unknown as PgBoss;
    expect(await new PgBossJobQueue(boss).raisePriority(null, 'template.sync', 'sync:a', 10)).toBe(
      1,
    );
    expect(calls).toEqual([
      { text: RAISE_WAITING_JOB_PRIORITY_SQL, values: ['template.sync', 'sync:a', 10] },
    ]);
    for (const clause of [
      'UPDATE pgboss.job SET priority = $3',
      'WHERE name = $1 AND singleton_key = $2',
      // Created or due a retry: a running job is left alone.
      "state < 'active'",
      // Never lowered.
      'priority < $3',
    ]) {
      expect(RAISE_WAITING_JOB_PRIORITY_SQL).toContain(clause);
    }
  });

  it('are kept by the recording queue of service tests, never lowered', async () => {
    const recording = new RecordingJobQueue();
    const envelope = {} as JobEnvelope;
    await recording.enqueue(null, 'template.sync', envelope, { singletonKey: 'sync:a' });
    await recording.enqueue(null, 'template.sync', envelope, { singletonKey: 'sync:b' });
    expect(await recording.raisePriority(null, 'template.sync', 'sync:a', 10)).toBe(1);
    expect(await recording.raisePriority(null, 'template.sync', 'sync:a', 5)).toBe(0);
    expect(await recording.raisePriority(null, 'template.submit', 'sync:b', 10)).toBe(0);
    expect(recording.jobs.map((j) => j.options.priority)).toEqual([10, undefined]);
  });
});
