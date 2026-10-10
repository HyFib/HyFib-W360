import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL, Tx } from '@w360/db';
import {
  FAILURE_COMPANIES_SHOWN,
  FAILURE_REASONS_SHOWN,
  failureCompanyYear,
  failureReasonYearMonths,
  failureReasons,
  failureReasonsByMonth,
  readFailureCompanyYear,
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
  /** The 13 months of the year before 10 October 2026, as read with it. */
  const monthsBefore10Oct = failureReasonYearMonths('2026-10-10');

  it('reads the counted days’ reasons, how many days are counted, their months and today, in that order', async () => {
    const { tx, statements } = answering([
      {
        rows: [
          { reason_code: 'window_closed', failed_sends: '6', codes: '1' },
          { reason_code: '', failed_sends: 2, codes: 1 },
        ],
      },
      { rows: [{ days: '361' }] },
      {
        rows: [
          { month: '2025-10', reason_code: 'window_closed', failed_sends: '1' },
          { month: '2026-03', reason_code: 'window_closed', failed_sends: 5 },
          { month: '2026-10', reason_code: '', failed_sends: '2' },
        ],
      },
      { rows: [{ today: '2026-10-10' }] },
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
      months: monthsBefore10Oct,
      byMonth: [
        [1, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      ],
    });
    expect(statements).toEqual([
      {
        sql: 'select reason_code, failed_sends, codes from ops.platform_ops_failure_reason_year($1::uuid) order by reason_code is null, failed_sends desc, reason_code',
        params: ['tenant-1'],
      },
      { sql: 'select ops.platform_ops_failure_reason_days() as days', params: [] },
      {
        sql: "select to_char(month, 'YYYY-MM') as month, reason_code, failed_sends from ops.platform_ops_failure_reason_months($1::uuid)",
        params: ['tenant-1'],
      },
      {
        sql: "select to_char((now() at time zone 'UTC')::date, 'YYYY-MM-DD') as today",
        params: [],
      },
    ]);
  });

  it('reads the platform’s, nothing failed and every day counted, or none', async () => {
    const all = answering([
      { rows: [] },
      { rows: [{ days: 365 }] },
      { rows: [] },
      { rows: [{ today: '2026-10-10' }] },
    ]);
    expect(await readFailureReasonYear(all.tx as unknown as Tx, null)).toEqual({
      reasons: { reasons: [], failed: 0 },
      uncounted: 0,
      months: monthsBefore10Oct,
      byMonth: [],
    });
    expect(all.statements[0]?.params).toEqual([null]);
    expect(all.statements[2]?.params).toEqual([null]);
    const none = answering([
      { rows: [] },
      { rows: [{ days: 0 }] },
      { rows: [] },
      { rows: [{ today: '2026-10-10' }] },
    ]);
    expect((await readFailureReasonYear(none.tx as unknown as Tx, null)).uncounted).toBe(365);
  });

  it('fails when the days counted or today are not answered', async () => {
    const { tx } = answering([{ rows: [] }, { rows: [] }]);
    await expect(readFailureReasonYear(tx as unknown as Tx, null)).rejects.toThrow(
      'ops.platform_ops_failure_reason_days answered no row',
    );
    const noDay = answering([{ rows: [] }, { rows: [{ days: 365 }] }, { rows: [] }, { rows: [] }]);
    await expect(readFailureReasonYear(noDay.tx as unknown as Tx, null)).rejects.toThrow(
      'The database answered no day for today',
    );
  });
});

describe('failed sends by reason month by month (ADR-360)', () => {
  it('spans the calendar months of the 365 days before today, the first and last in part', () => {
    const months = failureReasonYearMonths('2026-10-10');
    expect(months.map((m) => m.month)).toEqual([
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
    ]);
    // 10 to 31 October last year, then whole months, then 1 to 9 October.
    expect(months[0]).toEqual({ month: '2025-10', days: 22, partial: true });
    expect(months[1]).toEqual({ month: '2025-11', days: 30, partial: false });
    expect(months[4]).toEqual({ month: '2026-02', days: 28, partial: false });
    expect(months.at(-1)).toEqual({ month: '2026-10', days: 9, partial: true });
    expect(months.reduce((total, m) => total + m.days, 0)).toBe(365);
  });

  it('spans twelve whole months when the year starts on a 1st, and counts a leap day', () => {
    const months = failureReasonYearMonths('2026-11-01');
    expect(months).toHaveLength(12);
    expect(months[0]).toEqual({ month: '2025-11', days: 30, partial: false });
    expect(months.at(-1)).toEqual({ month: '2026-10', days: 31, partial: false });
    expect(months.every((m) => !m.partial)).toBe(true);
    // A year holding 29 February starts a day later in the month.
    const leap = failureReasonYearMonths('2028-03-01');
    expect(leap[0]).toEqual({ month: '2027-03', days: 30, partial: true });
    expect(leap.at(-1)).toEqual({ month: '2028-02', days: 29, partial: false });
    expect(leap.reduce((total, m) => total + m.days, 0)).toBe(365);
    expect(() => failureReasonYearMonths('10 Oct')).toThrow('Not a day: 10 Oct');
  });

  it('places each row in its reason’s month, the rest together, 0 elsewhere, and refuses a code or a month the year does not list', () => {
    const months = failureReasonYearMonths('2026-10-10');
    const reasons = [
      { code: '131049', failed: 4, codes: 1, share: 0.4 },
      { code: '', failed: 3, codes: 1, share: 0.3 },
      { code: null, failed: 3, codes: 2, share: 0.3 },
    ];
    expect(
      failureReasonsByMonth(reasons, months, [
        { month: '2025-10', code: '131049', failed: 1 },
        { month: '2026-10', code: '131049', failed: 2 },
        // Rows of one code and month add up.
        { month: '2026-10', code: '131049', failed: 1 },
        { month: '2026-01', code: '', failed: 3 },
        { month: '2026-01', code: null, failed: 3 },
      ]),
    ).toEqual([
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
      [0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ]);
    expect(failureReasonsByMonth([], months, [])).toEqual([]);
    expect(() =>
      failureReasonsByMonth(reasons, months, [{ month: '2026-01', code: '131026', failed: 1 }]),
    ).toThrow("The year's failed sends by month name a code the year does not list");
    expect(() =>
      failureReasonsByMonth(reasons, months, [{ month: '2025-09', code: '131049', failed: 1 }]),
    ).toThrow("The year's failed sends by month name a month the year does not list");
  });
});

describe('failed sends by company month by month (ADR-362, ADR-364)', () => {
  const months = failureReasonYearMonths('2026-10-10');
  /** A month row of the company in `place`, as read: its failed sends and its sends (ADR-364). */
  const row = (place: number, month: string, failed: number, sent: number, rest = false) => ({
    place,
    tenantId: rest ? null : `tenant-${place}`,
    name: rest ? null : `Company ${place}`,
    slug: rest ? null : `company-${place}`,
    companies: rest ? 3 : 1,
    month,
    failed,
    sent,
  });

  it('lists the companies in the order of their places, each with its year, share, sends and months, the rest last', () => {
    expect(FAILURE_COMPANIES_SHOWN).toBe(8);
    // The function orders its rows by month, then place: each company is listed once, in place. A
    // month a company sent in without a failed send has a row too (ADR-364).
    const year = failureCompanyYear(
      [
        row(2, '2025-10', 1, 50),
        row(9, '2025-10', 2, 40, true),
        row(1, '2026-01', 0, 80),
        row(1, '2026-03', 5, 100),
        row(2, '2026-03', 2, 50),
        row(1, '2026-10', 1, 20),
        row(9, '2026-10', 1, 10, true),
      ],
      '2026-10-10',
      4,
    );
    expect(year.companies).toEqual([
      {
        place: 1,
        tenantId: 'tenant-1',
        name: 'Company 1',
        slug: 'company-1',
        companies: 1,
        failed: 6,
        share: 0.5,
        sent: 200,
        failedShare: 0.03,
      },
      {
        place: 2,
        tenantId: 'tenant-2',
        name: 'Company 2',
        slug: 'company-2',
        companies: 1,
        failed: 3,
        share: 0.25,
        sent: 100,
        failedShare: 0.03,
      },
      {
        place: 9,
        tenantId: null,
        name: null,
        slug: null,
        companies: 3,
        failed: 3,
        share: 0.25,
        sent: 50,
        failedShare: 0.06,
      },
    ]);
    expect(year.failed).toBe(12);
    expect(year.uncounted).toBe(4);
    expect(year.months).toEqual(months);
    expect(year.byMonth).toEqual([
      [0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0],
      [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    ]);
    expect(year.sentByMonth).toEqual([
      [0, 0, 0, 80, 0, 100, 0, 0, 0, 0, 0, 0, 20],
      [50, 0, 0, 0, 0, 50, 0, 0, 0, 0, 0, 0, 0],
      [40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10],
    ]);
    // Nothing failed: no company, every month's count nowhere.
    expect(failureCompanyYear([], '2026-10-10', 0)).toEqual({
      companies: [],
      failed: 0,
      uncounted: 0,
      months,
      byMonth: [],
      sentByMonth: [],
    });
  });

  it('gives a company no share of its sends when it has none, or fewer than its failed sends (ADR-364)', () => {
    // A company being deleted loses its sends before its failed sends by code.
    const year = failureCompanyYear(
      [row(1, '2026-03', 5, 0), row(2, '2026-03', 3, 2), row(3, '2026-03', 1, 4)],
      '2026-10-10',
      0,
    );
    expect(year.companies.map((c) => [c.sent, c.failedShare])).toEqual([
      [0, null],
      [2, null],
      [4, 0.25],
    ]);
  });

  it('adds the rows of one company and month, and refuses a month the year does not list or a place two companies share', () => {
    const added = failureCompanyYear(
      [row(1, '2026-03', 2, 10), row(1, '2026-03', 3, 30)],
      '2026-10-10',
      0,
    );
    expect(added.byMonth).toEqual([[0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0]]);
    expect(added.sentByMonth).toEqual([[0, 0, 0, 0, 0, 40, 0, 0, 0, 0, 0, 0, 0]]);
    expect(added.companies[0]).toMatchObject({ failed: 5, sent: 40, failedShare: 0.125 });
    expect(() => failureCompanyYear([row(1, '2025-09', 2, 4)], '2026-10-10', 0)).toThrow(
      "The year's failed sends by company name a month the year does not list",
    );
    expect(() =>
      failureCompanyYear(
        [row(1, '2026-03', 2, 4), { ...row(1, '2026-04', 1, 4), tenantId: 'tenant-2' }],
        '2026-10-10',
        0,
      ),
    ).toThrow("The year's failed sends by company give place 1 to two companies");
    // The rest is one row a month at one place, whichever of its companies have rows in a month.
    expect(() =>
      failureCompanyYear(
        [row(9, '2026-03', 2, 4, true), row(10, '2026-04', 1, 4, true)],
        '2026-10-10',
        0,
      ),
    ).toThrow("The year's failed sends by company give the rest two places");
  });

  it('reads the companies’ months, how many days are counted and today, in that order', async () => {
    const { tx, statements } = answering([
      {
        rows: [
          {
            place: '1',
            tenant_id: 'tenant-1',
            tenant_name: 'Acme',
            tenant_slug: 'acme',
            companies: '1',
            month: '2026-03',
            failed_sends: '4',
            sends: '160',
          },
          {
            place: 9,
            tenant_id: null,
            tenant_name: null,
            tenant_slug: null,
            companies: 2,
            month: '2026-10',
            failed_sends: 4,
            sends: 40,
          },
        ],
      },
      { rows: [{ days: '364' }] },
      { rows: [{ today: '2026-10-10' }] },
    ]);
    expect(await readFailureCompanyYear(tx as unknown as Tx)).toEqual({
      companies: [
        {
          place: 1,
          tenantId: 'tenant-1',
          name: 'Acme',
          slug: 'acme',
          companies: 1,
          failed: 4,
          share: 0.5,
          sent: 160,
          failedShare: 0.025,
        },
        {
          place: 9,
          tenantId: null,
          name: null,
          slug: null,
          companies: 2,
          failed: 4,
          share: 0.5,
          sent: 40,
          failedShare: 0.1,
        },
      ],
      failed: 8,
      uncounted: 1,
      months,
      byMonth: [
        [0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4],
      ],
      sentByMonth: [
        [0, 0, 0, 0, 0, 160, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40],
      ],
    });
    expect(statements).toEqual([
      {
        sql: "select place, tenant_id, tenant_name, tenant_slug, companies, to_char(month, 'YYYY-MM') as month, failed_sends, sends from ops.platform_ops_failure_company_months()",
        params: [],
      },
      { sql: 'select ops.platform_ops_failure_reason_days() as days', params: [] },
      {
        sql: "select to_char((now() at time zone 'UTC')::date, 'YYYY-MM-DD') as today",
        params: [],
      },
    ]);
    // Without the days counted or today, the read fails.
    await expect(
      readFailureCompanyYear(answering([{ rows: [] }, { rows: [] }]).tx as unknown as Tx),
    ).rejects.toThrow('ops.platform_ops_failure_reason_days answered no row');
    await expect(
      readFailureCompanyYear(
        answering([{ rows: [] }, { rows: [{ days: 365 }] }, { rows: [] }]).tx as unknown as Tx,
      ),
    ).rejects.toThrow('The database answered no day for today');
  });
});
