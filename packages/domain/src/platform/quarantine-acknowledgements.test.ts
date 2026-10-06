import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { isAppError } from '@w360/core';
import type { SQL } from '@w360/db';
import type { PlatformDatabase } from '@w360/db/platform';
import { QUARANTINE_CSV_COLUMNS } from './ops-model';
import { createPlatformOpsService } from './ops';
import type { PlatformActor } from './service';

const ACTOR: PlatformActor = {
  userId: 'user-ops-1',
  role: 'platform_operator',
  correlationId: 'corr-1',
};
const ENTRY = '0190a5b2-0000-7000-8000-00000000000a';
const NOTE = 'Waiting on the company to reconnect the number.';

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

describe('acknowledging quarantine entries (ADR-199)', () => {
  it('refuses an entry id that is not a UUID and a note out of bounds before any query', async () => {
    const { ops, runs } = opsWith();
    expect(
      await refusal(ops.acknowledgeQuarantine(ACTOR, { quarantineId: 'x', note: NOTE })),
    ).toEqual(['validation_failed', ['quarantineId']]);
    for (const bad of ['Too short', '      Too short      ', 'x'.repeat(501), '', 42]) {
      expect(
        await refusal(ops.acknowledgeQuarantine(ACTOR, { quarantineId: ENTRY, note: bad })),
        JSON.stringify(bad),
      ).toEqual(['validation_failed', ['note']]);
    }
    expect(await refusal(ops.acknowledgeQuarantine(ACTOR, { quarantineId: ENTRY }))).toEqual([
      'validation_failed',
      ['note'],
    ]);
    expect(runs).toEqual([]);
  });

  it('asks the definer function as the administrator, with the trimmed note and the request’s correlation id', async () => {
    const { ops, runs } = opsWith();
    await ops.acknowledgeQuarantine(ACTOR, { quarantineId: ENTRY, note: `  ${NOTE}  ` });
    expect(runs).toEqual([
      {
        userId: 'user-ops-1',
        statements: [
          {
            sql: 'select ops.platform_acknowledge_quarantine_entry($1::uuid, $2, $3)',
            params: [ENTRY, NOTE, 'corr-1'],
          },
        ],
      },
    ]);
  });

  it('exports when an entry was acknowledged as the last column, never who or the note', () => {
    expect(QUARANTINE_CSV_COLUMNS.at(-1)).toBe('Acknowledged (UTC)');
    expect(QUARANTINE_CSV_COLUMNS.filter((c) => /acknowledg|note|administrator/i.test(c))).toEqual([
      'Acknowledged (UTC)',
    ]);
  });
});
