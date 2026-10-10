import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database, SQL, Tx } from '@w360/db';
import {
  MESSAGE_DAYS_JOB_KEY,
  MESSAGE_DAYS_KEPT,
  MESSAGE_DAYS_PER_RUN,
  countMessageDays,
  deletionStarted,
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

const day = (
  date: string,
  counted: boolean,
  outbound = 0,
  failed = 0,
  inbound = 0,
  delivered: number | null = null,
  read: number | null = null,
  canceled: number | null = delivered === null ? null : 0,
) =>
  ({
    day: date,
    outbound,
    failed,
    inbound,
    counted,
    canceled,
    delivered,
    read,
  }) satisfies KeptMessageDay;

describe('the year of messages a day (ADR-341)', () => {
  it('keeps a year, counted a few days a run by one job at a time', () => {
    expect(MESSAGE_DAYS_KEPT).toBe(365);
    expect(MESSAGE_DAYS_PER_RUN).toBe(3);
    expect(MESSAGE_DAYS_JOB_KEY).toBe('message-days');
  });

  it('draws every day when all are counted, without the flag', () => {
    expect(
      messageYear([day('2026-10-06', true, 2, 1, 3), day('2026-10-07', true, 5, 0, 1, 3, 2, 1)]),
    ).toEqual({
      days: [
        // Counted before the deliveries and cancellations were (ADR-346): none yet.
        {
          day: '2026-10-06',
          outbound: 2,
          failed: 1,
          inbound: 3,
          canceled: null,
          delivered: null,
          read: null,
        },
        {
          day: '2026-10-07',
          outbound: 5,
          failed: 0,
          inbound: 1,
          canceled: 1,
          delivered: 3,
          read: 2,
        },
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
        {
          day: '2026-10-04',
          outbound: 1,
          failed: 0,
          inbound: 0,
          canceled: null,
          delivered: null,
          read: null,
        },
        {
          day: '2026-10-05',
          outbound: 2,
          failed: 0,
          inbound: 0,
          canceled: null,
          delivered: null,
          read: null,
        },
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
          {
            day: '2026-10-07',
            outbound: '4',
            failed: 1,
            inbound: '2',
            counted: true,
            canceled: '1',
            delivered: '3',
            read: 0,
          },
          // Counted before the deliveries and cancellations were (ADR-346), and not counted at all.
          {
            day: '2026-10-08',
            outbound: 2,
            failed: 0,
            inbound: 0,
            counted: true,
            canceled: null,
            delivered: null,
            read: null,
          },
          {
            day: '2026-10-09',
            outbound: 0,
            failed: 0,
            inbound: 0,
            counted: false,
            canceled: null,
            delivered: null,
            read: null,
          },
        ],
      },
    ]);
    expect(await keptMessageDays(tx as unknown as Tx, 365, 'tenant-1')).toEqual([
      {
        day: '2026-10-07',
        outbound: 4,
        failed: 1,
        inbound: 2,
        counted: true,
        canceled: 1,
        delivered: 3,
        read: 0,
      },
      {
        day: '2026-10-08',
        outbound: 2,
        failed: 0,
        inbound: 0,
        counted: true,
        canceled: null,
        delivered: null,
        read: null,
      },
      {
        day: '2026-10-09',
        outbound: 0,
        failed: 0,
        inbound: 0,
        counted: false,
        canceled: null,
        delivered: null,
        read: null,
      },
    ]);
    expect(statements).toEqual([
      {
        sql: "select to_char(utc_day, 'YYYY-MM-DD') as day, outbound, failed, inbound, counted, canceled, delivered, read from ops.platform_ops_message_days($1::int, $2::uuid) order by utc_day",
        params: [365, 'tenant-1'],
      },
    ]);
  });

  it('reads whether a company’s deletion has started, which no cancellation undoes', async () => {
    const { tx, statements } = answering([
      { rows: [{ started: true }] },
      { rows: [{ started: false }] },
      { rows: [] },
    ]);
    expect(await deletionStarted(tx as unknown as Tx, 'tenant-1')).toBe(true);
    expect(await deletionStarted(tx as unknown as Tx, 'tenant-2')).toBe(false);
    expect(await deletionStarted(tx as unknown as Tx, 'tenant-3')).toBe(false);
    expect(statements[0]).toEqual({
      sql: 'select exists ( select 1 from ops.tenant_deletions d where d.tenant_id = $1::uuid and d.started_at is not null ) as started',
      params: ['tenant-1'],
    });
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
