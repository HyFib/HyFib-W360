import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { isAppError } from '@w360/core';
import type { SQL } from '@w360/db';
import type { PlatformDatabase } from '@w360/db/platform';
import { DEAD_LETTERS_CSV_COLUMNS } from './ops-model';
import { createPlatformOpsService } from './ops';
import type { PlatformActor } from './service';

const ACTOR: PlatformActor = {
  userId: 'user-ops-1',
  role: 'platform_operator',
  correlationId: 'corr-1',
};
const LETTER = '0190a5b2-0000-7000-8000-000000000001';

/** The ops service over a platform database that records what each call asked it to run. */
function opsWith() {
  const runs: { userId: string; statements: { sql: string; params: unknown[] }[] }[] = [];
  const platformDb = {
    run: async (userId: string, fn: (tx: unknown) => Promise<unknown>) => {
      const statements: { sql: string; params: unknown[] }[] = [];
      runs.push({ userId, statements });
      return fn({
        execute: async (query: SQL) => {
          const { sql, params } = new PgDialect().sqlToQuery(query);
          statements.push({ sql, params });
          return { rows: [] };
        },
      });
    },
  } as unknown as PlatformDatabase;
  const ops = createPlatformOpsService({
    platformDb,
    queues: { snapshot: async () => ({ queues: [] }) } as never,
    clock: { now: () => new Date() },
    keyring: { currentKeyId: 'k1', keyIds: ['k1'] },
    jobSigning: { keyId: 'j1', nextKeyId: null, previousKeyId: null },
  });
  return { ops, runs };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return [error.code, (error.issues ?? []).map((i) => i.path)];
  }
  throw new Error('expected a refusal');
}

describe('acknowledging dead letters (ADR-169)', () => {
  it('refuses a dead letter id that is not a UUID and a note out of bounds before any query', async () => {
    const { ops, runs } = opsWith();
    const note = 'Template fixed upstream; no retry needed.';
    expect(await refusal(ops.acknowledgeDeadLetter(ACTOR, { deadLetterId: 'x', note }))).toEqual([
      'validation_failed',
      ['deadLetterId'],
    ]);
    for (const bad of ['Too short', '      Too short      ', 'x'.repeat(501), '', 42]) {
      expect(
        await refusal(ops.acknowledgeDeadLetter(ACTOR, { deadLetterId: LETTER, note: bad })),
        JSON.stringify(bad),
      ).toEqual(['validation_failed', ['note']]);
    }
    expect(await refusal(ops.acknowledgeDeadLetter(ACTOR, { deadLetterId: LETTER }))).toEqual([
      'validation_failed',
      ['note'],
    ]);
    expect(runs).toEqual([]);
  });

  it('asks the definer function as the administrator, with the trimmed note and the request’s correlation id', async () => {
    const { ops, runs } = opsWith();
    await ops.acknowledgeDeadLetter(ACTOR, {
      deadLetterId: LETTER,
      note: '  Template fixed upstream; no retry needed.  ',
    });
    expect(runs).toEqual([
      {
        userId: 'user-ops-1',
        statements: [
          {
            sql: 'select ops.platform_acknowledge_dead_letter($1::uuid, $2, $3)',
            params: [LETTER, 'Template fixed upstream; no retry needed.', 'corr-1'],
          },
        ],
      },
    ]);
  });

  it('exports when a dead letter was acknowledged as the last column, never who or the note', () => {
    expect(DEAD_LETTERS_CSV_COLUMNS.at(-1)).toBe('Acknowledged (UTC)');
    expect(DEAD_LETTERS_CSV_COLUMNS.join(',')).not.toMatch(/by|note|acknowledgement/i);
  });
});
