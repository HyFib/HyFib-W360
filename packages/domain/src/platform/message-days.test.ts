import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database, SQL, Tx } from '@w360/db';
import {
  MESSAGE_DAYS_JOB_KEY,
  MESSAGE_DAYS_KEPT,
  MESSAGE_DAYS_PER_RUN,
  countMessageDays,
  keptMessageDays,
  messageYear,
  type KeptMessageDay,
} from './message-days';

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

const day = (date: string, counted: boolean, outbound = 0, failed = 0, inbound = 0) =>
  ({ day: date, outbound, failed, inbound, counted }) satisfies KeptMessageDay;

describe('the year of messages a day (ADR-341)', () => {
  it('keeps a year, counted a few days a run by one job at a time', () => {
    expect(MESSAGE_DAYS_KEPT).toBe(365);
    expect(MESSAGE_DAYS_PER_RUN).toBe(3);
    expect(MESSAGE_DAYS_JOB_KEY).toBe('message-days');
  });

  it('draws every day when all are counted, without the flag', () => {
    expect(
      messageYear([day('2026-10-06', true, 2, 1, 3), day('2026-10-07', true, 0, 0, 1)]),
    ).toEqual({
      days: [
        { day: '2026-10-06', outbound: 2, failed: 1, inbound: 3 },
        { day: '2026-10-07', outbound: 0, failed: 0, inbound: 1 },
      ],
      uncounted: 0,
    });
  });

  it('leaves out the latest days not counted yet, and every day before a gap', () => {
    const year = messageYear([
      day('2026-10-02', true, 5),
      day('2026-10-03', false),
      day('2026-10-04', true, 1),
      day('2026-10-05', true, 2),
      day('2026-10-06', false),
      day('2026-10-07', false),
    ]);
    expect(year).toEqual({
      days: [
        { day: '2026-10-04', outbound: 1, failed: 0, inbound: 0 },
        { day: '2026-10-05', outbound: 2, failed: 0, inbound: 0 },
      ],
      uncounted: 3,
    });
  });

  it('draws nothing while no day is counted', () => {
    expect(messageYear([day('2026-10-06', false), day('2026-10-07', false)])).toEqual({
      days: [],
      uncounted: 2,
    });
    expect(messageYear([])).toEqual({ days: [], uncounted: 0 });
  });

  it('reads the kept days through the definer function, as numbers and a flag', async () => {
    const { tx, statements } = answering([
      {
        rows: [
          { day: '2026-10-07', outbound: '4', failed: 1, inbound: '2', counted: true },
          { day: '2026-10-08', outbound: 0, failed: 0, inbound: 0, counted: false },
        ],
      },
    ]);
    expect(await keptMessageDays(tx as unknown as Tx, 365, 'tenant-1')).toEqual([
      { day: '2026-10-07', outbound: 4, failed: 1, inbound: 2, counted: true },
      { day: '2026-10-08', outbound: 0, failed: 0, inbound: 0, counted: false },
    ]);
    expect(statements).toEqual([
      {
        sql: "select to_char(utc_day, 'YYYY-MM-DD') as day, outbound, failed, inbound, counted from ops.platform_ops_message_days($1::int, $2::uuid) order by utc_day",
        params: [365, 'tenant-1'],
      },
    ]);
  });

  it('deletes the counts kept past their time first, then counts the days due one a transaction, a few a run unless told, until none is due', async () => {
    const one = { rows: [{ counted: 1 }] };
    const { tx, statements } = answering([
      { rows: [{ purged: 0 }] },
      one,
      one,
      one,
      // Asked for more, it counts more, and stops at the first call that finds no day due.
      { rows: [{ purged: '2' }] },
      one,
      one,
      one,
      one,
      { rows: [{ counted: '0' }] },
    ]);
    let transactions = 0;
    const db = {
      run: async (_scope: unknown, fn: (t: typeof tx) => Promise<unknown>) => {
        transactions += 1;
        return fn(tx);
      },
    } as unknown as Database;
    expect(await countMessageDays({ db })).toEqual({ purged: 0, counted: 3 });
    expect(await countMessageDays({ db }, 31)).toEqual({ purged: 2, counted: 4 });
    expect(transactions).toBe(10);
    const purge = { sql: 'select ops.purge_platform_message_days() as purged', params: [] };
    const count = { sql: 'select ops.count_platform_message_days(1) as counted', params: [] };
    expect(statements).toEqual([
      purge,
      count,
      count,
      count,
      purge,
      count,
      count,
      count,
      count,
      count,
    ]);
  });
});
