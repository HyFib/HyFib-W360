import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { isAppError } from '@w360/core';
import type { Database, SQL, Tx } from '@w360/db';
import { forecastByMonth, readForecastGroups } from '../crm/forecast';
import type { ApiContext } from './context';
import { API_SCOPE_INFO } from './model';
import { API_ROUTES, buildOpenApiDocument } from './openapi';
import {
  apiGetPipelineForecast,
  apiPipelineForecastSchema,
  toApiPipelineForecast,
} from './pipeline-forecast';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const PIPELINE = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
const NEW = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03';
const QUALIFIED = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f04';
const MONTHS: [string, string, string] = ['2026-10', '2026-11', '2026-12'];
const NOW = new Date('2026-10-07T10:00:00Z');

const ctx = (scopes: string[], status = 'active') =>
  ({
    tenant: { id: TENANT, status },
    key: { id: 'k', scopes: new Set(scopes) },
    planScopes: null,
  }) as unknown as ApiContext;

/** A database that records the options of the transaction it was asked for, then stops it. */
function reached() {
  const runs: unknown[] = [];
  const db = {
    run: (_scope: unknown, _fn: unknown, options?: unknown) => {
      runs.push(options);
      throw new Error('reached the database');
    },
  } as unknown as Database;
  return { db, runs };
}

/** The code and message of a refusal. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return [error.code, error.publicMessage];
  }
  throw new Error('expected a refusal');
}

/** A transaction that answers `rows` to any statement and records what it was asked. */
function recording(rows: unknown[]) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const tx = {
    execute: async (query: SQL) => {
      const { sql, params } = new PgDialect().sqlToQuery(query);
      statements.push({ sql: sql.replace(/\s+/g, ' '), params });
      return { rows };
    },
  } as unknown as Tx;
  return { tx, statements };
}

const groups = [
  { stageId: NEW, winPercent: 10, closeMonth: '2020-01', deals: 1, valueMinor: 100_000 },
  { stageId: QUALIFIED, winPercent: 50, closeMonth: '2026-10', deals: 1, valueMinor: 50_000 },
  { stageId: QUALIFIED, winPercent: 50, closeMonth: '2026-11', deals: 2, valueMinor: 30_001 },
  { stageId: NEW, winPercent: null, closeMonth: null, deals: 3, valueMinor: 7 },
];

describe('a pipeline’s weighted forecast through the API (ADR-288)', () => {
  it('gives the Reports forecast with the pipeline, its currency, the company’s months and when', () => {
    const forecast = forecastByMonth(groups, MONTHS, [10, 50, null]);
    expect(
      toApiPipelineForecast({ id: PIPELINE, currency: 'INR' }, 'Asia/Kolkata', NOW, forecast),
    ).toEqual({
      pipelineId: PIPELINE,
      currency: 'INR',
      timeZone: 'Asia/Kolkata',
      months: MONTHS,
      asOf: '2026-10-07T10:00:00.000Z',
      hasChances: true,
      buckets: [
        { bucket: 'this_month', deals: 2, valueMinor: 150_000, weightedMinor: 10_000 + 25_000 },
        { bucket: 'next_month', deals: 2, valueMinor: 30_001, weightedMinor: 15_001 },
        { bucket: 'month_after', deals: 0, valueMinor: 0, weightedMinor: 0 },
        { bucket: 'later', deals: 0, valueMinor: 0, weightedMinor: 0 },
        { bucket: 'undated', deals: 3, valueMinor: 7, weightedMinor: 0 },
      ],
      dealsWithoutChance: 3,
    });
  });

  it('gives no weighted values when no stage has a chance, and zeros when one without deals has', () => {
    const none = toApiPipelineForecast(
      { id: PIPELINE, currency: 'USD' },
      'UTC',
      NOW,
      forecastByMonth(
        groups.map((g) => ({ ...g, winPercent: null })),
        MONTHS,
        [null, null],
      ),
    );
    expect(none.hasChances).toBe(false);
    expect(none.buckets.map((b) => b.weightedMinor)).toEqual([null, null, null, null, null]);
    expect(none.buckets.map((b) => b.valueMinor)).toEqual([150_000, 30_001, 0, 0, 7]);
    expect(none.dealsWithoutChance).toBe(7);
    const unused = toApiPipelineForecast(
      { id: PIPELINE, currency: 'USD' },
      'UTC',
      NOW,
      forecastByMonth(
        groups.map((g) => ({ ...g, winPercent: null })),
        MONTHS,
        [null, 70],
      ),
    );
    expect(unused.hasChances).toBe(true);
    expect(unused.buckets.map((b) => b.weightedMinor)).toEqual([0, 0, 0, 0, 0]);
  });

  it('reads the deals Reports reads, for one pipeline when it is named', async () => {
    const row = {
      pipeline_id: PIPELINE,
      stage_id: QUALIFIED,
      win_percent: 50,
      close_month: '2026-11',
      deals: 2,
      value: '30001',
    };
    const one = recording([row]);
    expect(await readForecastGroups(one.tx, TENANT, PIPELINE)).toEqual([
      {
        pipelineId: PIPELINE,
        stageId: QUALIFIED,
        winPercent: 50,
        closeMonth: '2026-11',
        deals: 2,
        valueMinor: 30_001,
      },
    ]);
    const [named] = one.statements;
    expect(named?.sql).toContain(
      "where d.tenant_id = $1 and d.status = 'open' and s.pipeline_id = $2",
    );
    expect(named?.params).toEqual([TENANT, PIPELINE]);
    // Active stages of active pipelines only, as Reports reads them.
    expect(named?.sql).toContain('s.archived_at is null');
    expect(named?.sql).toContain('p.archived_at is null');
    const all = recording([]);
    await readForecastGroups(all.tx, TENANT);
    expect(all.statements[0]?.sql).not.toContain('pipeline_id = $');
    expect(all.statements[0]?.params).toEqual([TENANT]);
  });

  it('needs deals.read and a pipeline id, and reads in one read-only snapshot, suspended or not', async () => {
    const clock = { now: () => NOW };
    const missing = ['forbidden', 'This API key does not have the deals.read scope.'];
    const untouched = reached();
    expect(
      await refusal(
        apiGetPipelineForecast(
          { db: untouched.db, clock },
          ctx(['deals.write', 'pipelines.manage']),
          PIPELINE,
        ),
      ),
    ).toEqual(missing);
    expect(
      await refusal(apiGetPipelineForecast({ db: untouched.db, clock }, ctx(['deals.read']), 'x')),
    ).toEqual(['not_found', 'Pipeline not found.']);
    expect(untouched.runs).toEqual([]);
    for (const status of ['active', 'suspended']) {
      const { db, runs } = reached();
      await expect(
        apiGetPipelineForecast({ db, clock }, ctx(['deals.read'], status), PIPELINE),
      ).rejects.toThrow('reached the database');
      expect(runs).toEqual([{ isolationLevel: 'repeatable read', accessMode: 'read only' }]);
    }
    expect(API_SCOPE_INFO['deals.read'].description).toContain(
      "read each pipeline's weighted forecast as Reports shows it",
    );
  });

  it('is described: the scope, the buckets, the chances and the snapshot', () => {
    expect(API_ROUTES).toContainEqual(['get', '/pipelines/{id}/forecast']);
    const doc = buildOpenApiDocument('https://app.example.com') as unknown as {
      paths: Record<string, Record<string, { operationId: string; description: string }>>;
    };
    const operation = doc.paths['/pipelines/{id}/forecast']?.get;
    expect(operation?.operationId).toBe('getPipelineForecast');
    for (const words of [
      'Scope: `deals.read`.',
      'in the company’s time zone',
      'dates already past included, as on the board',
      'This month’s weighted value is the board’s.',
      'counted but not weighed (`dealsWithoutChance`)',
      'a pipeline without any chance has no weighted values',
      'an archived pipeline holds no open deals, so its buckets are empty',
      'reason not_in_plan',
    ]) {
      expect(operation?.description).toContain(words);
    }
    const given = toApiPipelineForecast(
      { id: PIPELINE, currency: 'INR' },
      'Asia/Kolkata',
      NOW,
      forecastByMonth(groups, MONTHS, [10, 50]),
    );
    expect(apiPipelineForecastSchema.safeParse(given).success).toBe(true);
    expect(
      apiPipelineForecastSchema.safeParse({
        ...given,
        buckets: given.buckets.map((b) => ({ ...b, weightedMinor: null })),
      }).success,
    ).toBe(true);
  });
});
