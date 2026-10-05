import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { isAppError } from '@w360/core';
import type { SQL } from '@w360/db';
import type { PlatformDatabase } from '@w360/db/platform';
import { RECEIPTS_CSV_COLUMNS } from './ops-model';
import { createPlatformOpsService } from './ops';
import type { PlatformActor } from './service';

const ACTOR: PlatformActor = {
  userId: 'user-ops-1',
  role: 'platform_operator',
  correlationId: 'corr-1',
};
const RECEIPT = '0190a5b2-0000-7000-8000-000000000009';
const NOTE = 'Razorpay sent a malformed body; ignoring it.';

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

describe('acknowledging webhook receipts (ADR-179)', () => {
  it('refuses a receipt id that is not a UUID and a note out of bounds before any query', async () => {
    const { ops, runs } = opsWith();
    expect(await refusal(ops.acknowledgeReceipt(ACTOR, { receiptId: 'x', note: NOTE }))).toEqual([
      'validation_failed',
      ['receiptId'],
    ]);
    for (const bad of ['Too short', '      Too short      ', 'x'.repeat(501), '', 42]) {
      expect(
        await refusal(ops.acknowledgeReceipt(ACTOR, { receiptId: RECEIPT, note: bad })),
        JSON.stringify(bad),
      ).toEqual(['validation_failed', ['note']]);
    }
    expect(await refusal(ops.acknowledgeReceipt(ACTOR, { receiptId: RECEIPT }))).toEqual([
      'validation_failed',
      ['note'],
    ]);
    expect(runs).toEqual([]);
  });

  it('asks the definer function as the administrator, with the trimmed note and the request’s correlation id', async () => {
    const { ops, runs } = opsWith();
    await ops.acknowledgeReceipt(ACTOR, { receiptId: RECEIPT, note: `  ${NOTE}  ` });
    expect(runs).toEqual([
      {
        userId: 'user-ops-1',
        statements: [
          {
            sql: 'select ops.platform_acknowledge_webhook_receipt($1::uuid, $2, $3)',
            params: [RECEIPT, NOTE, 'corr-1'],
          },
        ],
      },
    ]);
  });

  it('exports when a receipt was acknowledged as the last column, never who or the note', () => {
    expect(RECEIPTS_CSV_COLUMNS.at(-1)).toBe('Acknowledged (UTC)');
    expect(RECEIPTS_CSV_COLUMNS.filter((c) => /acknowledg|note|administrator/i.test(c))).toEqual([
      'Acknowledged (UTC)',
    ]);
  });
});
