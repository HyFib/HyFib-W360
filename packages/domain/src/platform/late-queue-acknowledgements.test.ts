import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { isAppError } from '@w360/core';
import type { SQL } from '@w360/db';
import type { PlatformDatabase } from '@w360/db/platform';
import { QUEUES_CSV_COLUMNS } from './ops-model';
import { createPlatformOpsService } from './ops';
import type { PlatformActor } from './service';

const ACTOR: PlatformActor = {
  userId: 'user-ops-1',
  role: 'platform_operator',
  correlationId: 'corr-1',
};
const LATE_SINCE = '2026-10-05T06:00:00.123Z';
const NOTE = 'Shopify is rate limiting us; waiting it out.';

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

describe('acknowledging late queues (ADR-177)', () => {
  it('refuses a queue name, a time and a note out of bounds before any query', async () => {
    const { ops, runs } = opsWith();
    for (const queue of ['', 'Commerce.Store', 'commerce store', `q${'x'.repeat(100)}`, 42]) {
      expect(
        await refusal(
          ops.acknowledgeLateQueue(ACTOR, { queue, lateSince: LATE_SINCE, note: NOTE }),
        ),
        JSON.stringify(queue),
      ).toEqual(['validation_failed', ['queue']]);
    }
    for (const lateSince of ['', 'yesterday', '2026-10-05 06:00', '2026-10-05T06:00:00', null]) {
      expect(
        await refusal(
          ops.acknowledgeLateQueue(ACTOR, { queue: 'commerce.store', lateSince, note: NOTE }),
        ),
        JSON.stringify(lateSince),
      ).toEqual(['validation_failed', ['lateSince']]);
    }
    for (const note of ['Too short', '      Too short      ', 'x'.repeat(501), '', 42]) {
      expect(
        await refusal(
          ops.acknowledgeLateQueue(ACTOR, { queue: 'commerce.store', lateSince: LATE_SINCE, note }),
        ),
        JSON.stringify(note),
      ).toEqual(['validation_failed', ['note']]);
    }
    expect(runs).toEqual([]);
  });

  it('asks the definer function as the administrator, with the time the page showed, the trimmed note and the request’s correlation id', async () => {
    const { ops, runs } = opsWith();
    await ops.acknowledgeLateQueue(ACTOR, {
      queue: 'commerce.store',
      lateSince: LATE_SINCE,
      note: `  ${NOTE}  `,
    });
    expect(runs).toEqual([
      {
        userId: 'user-ops-1',
        statements: [
          {
            sql: 'select ops.platform_acknowledge_late_queue($1, $2::timestamptz, $3, $4)',
            params: ['commerce.store', LATE_SINCE, NOTE, 'corr-1'],
          },
        ],
      },
    ]);
  });

  it('exports when a late queue was acknowledged, never who or the note', () => {
    expect(QUEUES_CSV_COLUMNS.filter((c) => /acknowledg|note|administrator/i.test(c))).toEqual([
      'Acknowledged (UTC)',
    ]);
  });
});
