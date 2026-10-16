import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database, SQL, Tx } from '@w360/db';
import type { TenantContext } from '../authz/context';
import { resolveDealFieldFilter, type FilterableFieldShape } from '../crm/deal-field-filter';
import { resolvePeriod } from './period';
import { createReportsService, dealReport, readReportDealFilter } from './service';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const PIPELINE = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
const STAGE = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03';
const NOW = new Date('2026-10-07T10:00:00Z');
const period = resolvePeriod({ preset: 'last_7_days' }, 'Asia/Kolkata', NOW);
const start = period.start.toISOString();
const end = period.end.toISOString();

const fields: FilterableFieldShape[] = [
  { key: 'tier', label: 'Tier', type: 'choice', options: ['Gold', 'Silver'] },
  { key: 'signed', label: 'Signed', type: 'boolean', options: null },
];
const filter = (key: string, value: string | null) => {
  const resolved = resolveDealFieldFilter(fields, { key, value });
  if (!resolved.ok) throw new Error(resolved.problem);
  return resolved.filter;
};

/**
 * A transaction that records each statement, with its whitespace collapsed, and answers the rows
 * given for it in order (none by default).
 */
function recording(answers: unknown[][] = []) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const tx = {
    execute: async (query: SQL) => {
      const { sql, params } = new PgDialect().sqlToQuery(query);
      statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rows: answers[statements.length - 1] ?? [] };
    },
  } as unknown as Tx;
  return { tx, statements };
}

describe('the deals section of Reports filtered by a deal field (ADR-396)', () => {
  it('reads every deal without a filter, as before', async () => {
    const { tx, statements } = recording();
    const report = await dealReport(tx, TENANT, period, NOW);
    expect(statements).toHaveLength(4);
    for (const statement of statements) expect(statement.sql).not.toContain('attributes');
    const [closed, median, open, forecast] = statements;
    expect(closed?.params).toEqual(['Asia/Kolkata', TENANT, start, end]);
    expect(median?.params).toEqual([TENANT, start, end]);
    expect(open?.sql).toContain("and d.status = 'open' where p.tenant_id = $1 and");
    expect(open?.params).toEqual([TENANT]);
    expect(forecast?.params).toEqual([TENANT]);
    expect(report.field).toBeNull();
  });

  it('counts only the deals with the option in each of its four queries', async () => {
    const gold = filter('tier', 'gold');
    const { tx, statements } = recording();
    const report = await dealReport(tx, TENANT, period, NOW, gold);
    expect(report.field).toBe(gold);
    const [closed, median, open, forecast] = statements;
    // Closed deals per currency and day (and so the win rate), in the period.
    expect(closed?.sql).toContain(
      'and d.closed_at < $4::timestamptz and (d.attributes -> $5::text) = $6::jsonb group by 1, 2',
    );
    expect(closed?.params).toEqual(['Asia/Kolkata', TENANT, start, end, 'tier', '"Gold"']);
    // The time to win, of the deals won in the period.
    expect(median?.sql).toContain(
      "d.status = 'won' and d.closed_at >= $2::timestamptz and d.closed_at < $3::timestamptz and (d.attributes -> $4::text) = $5::jsonb",
    );
    expect(median?.params).toEqual([TENANT, start, end, 'tier', '"Gold"']);
    // Open deals by stage: in the join, so a stage without such deals is still listed, with none.
    expect(open?.sql).toContain(
      "left join app.crm_deals d on d.tenant_id = s.tenant_id and d.stage_id = s.id and d.status = 'open' and (d.attributes -> $1::text) = $2::jsonb where p.tenant_id = $3 and p.archived_at is null",
    );
    expect(open?.params).toEqual(['tier', '"Gold"', TENANT]);
    // The forecast, of the company's pipelines.
    expect(forecast?.sql).toContain(
      "where d.tenant_id = $1 and d.status = 'open' and (d.attributes -> $2::text) = $3::jsonb group by s.pipeline_id",
    );
    expect(forecast?.params).toEqual([TENANT, 'tier', '"Gold"']);
  });

  it('counts the deals without a value for "Not set", and a yes/no field by its boolean', async () => {
    const unset = recording();
    await dealReport(unset.tx, TENANT, period, NOW, filter('tier', null));
    const [closed, median, open, forecast] = unset.statements;
    expect(closed?.sql).toContain('and not (d.attributes ? $5::text) group by 1, 2');
    expect(closed?.params).toEqual(['Asia/Kolkata', TENANT, start, end, 'tier']);
    expect(median?.sql).toMatch(/and not \(d\.attributes \? \$4::text\)$/);
    expect(open?.sql).toContain(
      "and d.status = 'open' and not (d.attributes ? $1::text) where p.tenant_id = $2",
    );
    expect(forecast?.sql).toContain(
      "and d.status = 'open' and not (d.attributes ? $2::text) group by",
    );
    const no = recording();
    await dealReport(no.tx, TENANT, period, NOW, filter('signed', 'No'));
    expect(no.statements.map((s) => s.params.filter((p) => p !== TENANT).slice(-2))).toEqual([
      ['signed', 'false'],
      ['signed', 'false'],
      ['signed', 'false'],
      ['signed', 'false'],
    ]);
    for (const statement of no.statements) {
      expect(statement.sql).toMatch(/\(d\.attributes -> \$\d+::text\) = \$\d+::jsonb/);
    }
  });

  it('computes the figures from what the filtered queries answer, as without a filter', async () => {
    const gold = filter('tier', 'Gold');
    const { tx } = recording([
      [
        {
          day: '2026-10-07',
          currency: 'INR',
          won: 1,
          won_value: '90000',
          lost: 1,
          lost_value: '10000',
        },
      ],
      [{ median: 3600 }],
      [
        {
          pipeline_id: PIPELINE,
          pipeline_name: 'Sales',
          currency: 'INR',
          stage_id: STAGE,
          stage_name: 'New',
          win_percent: 10,
          deals: 1,
          value: '100000',
        },
      ],
      [
        {
          pipeline_id: PIPELINE,
          stage_id: STAGE,
          win_percent: 10,
          close_month: '2026-10',
          deals: 1,
          value: '100000',
        },
      ],
    ]);
    const report = await dealReport(tx, TENANT, period, NOW, gold);
    expect(report).toMatchObject({
      won: [{ currency: 'INR', deals: 1, valueMinor: 90_000 }],
      lost: [{ currency: 'INR', deals: 1, valueMinor: 10_000 }],
      winRate: { numerator: 1, denominator: 2 },
      medianSecondsToWin: 3600,
      days: [
        {
          day: '2026-10-07',
          currency: 'INR',
          won: 1,
          wonValueMinor: 90_000,
          lost: 1,
          lostValueMinor: 10_000,
        },
      ],
      field: gold,
    });
    expect(report.pipelines[0]?.stages).toEqual([
      { id: STAGE, name: 'New', deals: 1, valueMinor: 100_000 },
    ]);
    expect(report.pipelines[0]?.forecast.buckets[0]).toEqual({
      bucket: 'this_month',
      deals: 1,
      valueMinor: 100_000,
      weightedMinor: 10_000,
    });
  });
});

describe('the page’s filter, read in the report’s transaction (ADR-396)', () => {
  const ctx = (permissions: string[]) =>
    ({ tenant: { id: TENANT }, permissions: new Set(permissions) }) as unknown as TenantContext;
  /** A transaction that answers the company's deal fields and counts how often they are read. */
  function fieldsTx() {
    let reads = 0;
    const tx = {
      select: () => {
        reads += 1;
        return {
          from: () => ({ where: () => ({ orderBy: () => Promise.resolve([...fields]) }) }),
        };
      },
    } as unknown as Tx;
    return { tx, reads: () => reads };
  }

  it('reads the company’s fields and resolves the filter for members who may see the CRM', async () => {
    const { tx, reads } = fieldsTx();
    expect(
      await readReportDealFilter(tx, ctx(['reports.read', 'crm.read']), 'tier:gold'),
    ).toMatchObject({
      applied: { key: 'tier', stored: 'Gold', param: 'tier:Gold' },
      ignored: false,
      permitted: true,
    });
    expect(reads()).toBe(1);
    const stale = await readReportDealFilter(tx, ctx(['reports.read', 'crm.read']), 'tier:Lead');
    expect(stale).toMatchObject({ applied: null, ignored: true, permitted: true });
    expect(stale.fields.map((f) => f.key)).toEqual(['tier', 'signed']);
  });

  it('reads no field for others and applies nothing, whatever the address holds', async () => {
    const { tx, reads } = fieldsTx();
    for (const raw of ['tier:Gold', 'plan:Gold']) {
      expect(await readReportDealFilter(tx, ctx(['reports.read']), raw), raw).toEqual({
        fields: [],
        applied: null,
        ignored: true,
        permitted: false,
      });
    }
    expect(await readReportDealFilter(tx, ctx(['reports.read']), null)).toMatchObject({
      ignored: false,
      permitted: false,
    });
    expect(reads()).toBe(0);
  });

  it('ignores and reports a NUL character in the key or the value, never refusing the page', async () => {
    const NUL = '\u0000';
    const withNul = [`ti${NUL}er:Gold`, `tier${NUL}:Gold`, `tier:Go${NUL}ld`, `tier:${NUL}`, NUL];
    for (const raw of withNul) {
      expect(
        await readReportDealFilter(fieldsTx().tx, ctx(['reports.read', 'crm.read']), raw),
        JSON.stringify(raw),
      ).toMatchObject({ applied: null, ignored: true, permitted: true });
      expect(
        await readReportDealFilter(fieldsTx().tx, ctx(['reports.read']), raw),
        JSON.stringify(raw),
      ).toMatchObject({ applied: null, ignored: true, permitted: false });
    }
    // The page's reading takes such text past validation into the report's snapshot: the fields
    // are read, then the report's own queries start, instead of a refusal the page would take for
    // a bad period.
    for (const field of withNul) {
      let selects = 0;
      const tx = {
        select: () => {
          selects += 1;
          if (selects > 1) throw new Error('reached the report');
          return {
            from: () => ({ where: () => ({ orderBy: () => Promise.resolve([...fields]) }) }),
          };
        },
      } as unknown as Tx;
      const db = {
        run: (_scope: unknown, fn: (tx: Tx) => unknown) => fn(tx),
      } as unknown as Database;
      await expect(
        createReportsService({ db, clock: { now: () => NOW } }).getReport(
          {
            ...ctx(['reports.read', 'crm.read']),
            tenant: { id: TENANT, timezone: 'Asia/Kolkata' },
            scope: {},
          } as unknown as TenantContext,
          { preset: 'last_7_days', field },
        ),
        JSON.stringify(field),
      ).rejects.toThrow('reached the report');
      expect(selects).toBe(2);
    }
  });
});
