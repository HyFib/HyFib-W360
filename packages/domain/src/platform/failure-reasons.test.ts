import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL, Tx } from '@w360/db';
import {
  FAILURE_REASONS_SHOWN,
  failureReasons,
  readFailureReasonYear,
  readFailureReasons,
} from './failure-reasons';

const query = (q: SQL) => {
  const built = new PgDialect().sqlToQuery(q);
  return { sql: built.sql.replace(/\s+/g, ' ').trim(), params: built.params };
};

/** A transaction that records each statement and answers it in turn. */
function answering(answers: { rows: unknown[] }[]) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const tx = {
    execute: async (q: SQL) => {
      statements.push(query(q));
      const next = answers.shift();
      if (!next) throw new Error(`unexpected statement: ${query(q).sql}`);
      return next;
    },
  };
  return { tx, statements };
}

describe('failed sends by reason (ADR-347)', () => {
  it('lists eight codes one by one, the rest together', () => {
    expect(FAILURE_REASONS_SHOWN).toBe(8);
  });

  it('gives each code its share of all the failed sends, the rest too, in the order listed', () => {
    expect(
      failureReasons([
        { code: '131049', failed: 5, codes: 1 },
        { code: '', failed: 2, codes: 1 },
        { code: 'window_closed', failed: 2, codes: 1 },
        { code: null, failed: 1, codes: 3 },
      ]),
    ).toEqual({
      reasons: [
        { code: '131049', failed: 5, codes: 1, share: 0.5 },
        { code: '', failed: 2, codes: 1, share: 0.2 },
        { code: 'window_closed', failed: 2, codes: 1, share: 0.2 },
        { code: null, failed: 1, codes: 3, share: 0.1 },
      ],
      failed: 10,
    });
  });

  it('lists nothing when no send failed', () => {
    expect(failureReasons([])).toEqual({ reasons: [], failed: 0 });
  });

  it('reads the reasons through the definer function, as numbers, the rest last', async () => {
    const since = new Date('2026-09-10T02:00:00.000Z');
    const { tx, statements } = answering([
      {
        rows: [
          { reason_code: '131026', failed_sends: '3', codes: 1 },
          { reason_code: null, failed_sends: 1, codes: '2' },
        ],
      },
    ]);
    expect(await readFailureReasons(tx as unknown as Tx, since, 'tenant-1')).toEqual({
      reasons: [
        { code: '131026', failed: 3, codes: 1, share: 0.75 },
        { code: null, failed: 1, codes: 2, share: 0.25 },
      ],
      failed: 4,
    });
    expect(statements).toEqual([
      {
        sql: 'select reason_code, failed_sends, codes from ops.platform_ops_failure_reasons($1::timestamptz, $2::uuid) order by reason_code is null, failed_sends desc, reason_code',
        params: ['2026-09-10T02:00:00.000Z', 'tenant-1'],
      },
    ]);
  });
});

describe('failed sends by reason over the year (ADR-350)', () => {
  it('reads the counted days’ reasons and how many days are counted, in that order', async () => {
    const { tx, statements } = answering([
      {
        rows: [
          { reason_code: 'window_closed', failed_sends: '6', codes: '1' },
          { reason_code: '', failed_sends: 2, codes: 1 },
        ],
      },
      { rows: [{ days: '361' }] },
    ]);
    expect(await readFailureReasonYear(tx as unknown as Tx, 'tenant-1')).toEqual({
      reasons: {
        reasons: [
          { code: 'window_closed', failed: 6, codes: 1, share: 0.75 },
          { code: '', failed: 2, codes: 1, share: 0.25 },
        ],
        failed: 8,
      },
      uncounted: 4,
    });
    expect(statements).toEqual([
      {
        sql: 'select reason_code, failed_sends, codes from ops.platform_ops_failure_reason_year($1::uuid) order by reason_code is null, failed_sends desc, reason_code',
        params: ['tenant-1'],
      },
      { sql: 'select ops.platform_ops_failure_reason_days() as days', params: [] },
    ]);
  });

  it('reads the platform’s, nothing failed and every day counted, or none', async () => {
    const all = answering([{ rows: [] }, { rows: [{ days: 365 }] }]);
    expect(await readFailureReasonYear(all.tx as unknown as Tx, null)).toEqual({
      reasons: { reasons: [], failed: 0 },
      uncounted: 0,
    });
    expect(all.statements[0]?.params).toEqual([null]);
    const none = answering([{ rows: [] }, { rows: [{ days: 0 }] }]);
    expect((await readFailureReasonYear(none.tx as unknown as Tx, null)).uncounted).toBe(365);
  });

  it('fails when the days counted are not answered', async () => {
    const { tx } = answering([{ rows: [] }, { rows: [] }]);
    await expect(readFailureReasonYear(tx as unknown as Tx, null)).rejects.toThrow(
      'ops.platform_ops_failure_reason_days answered no row',
    );
  });
});
