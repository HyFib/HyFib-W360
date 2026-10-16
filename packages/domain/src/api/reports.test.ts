import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { API_SCOPES, type Database, type Tx } from '@w360/db';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import { resolveDealFieldFilter } from '../crm/deal-field-filter';
import { METRIC_DEFINITIONS } from '../reports/definitions';
import type { Report } from '../reports/service';
import type { ApiContext } from './context';
import { apiDealFieldFilterMessage } from './deals';
import { API_SCOPE_INFO, API_SCOPE_KEYS } from './model';
import { API_ROUTES, buildOpenApiDocument } from './openapi';
import {
  API_REPORT_FIELD_FILTER_DESCRIPTION,
  apiGetReport,
  apiReportQuerySchema,
  apiReportSchema,
  toApiReport,
} from './reports';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const MEMBER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
const TEAM = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f0a';
const PIPELINE = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03';
const STAGE = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f04';
const CAMPAIGN = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f05';
const AUTOMATION = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f06';
const CARD = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f07';
/** 01:30 on 8 October in Kolkata, still 7 October in UTC. */
const NOW = new Date('2026-10-07T20:00:00.000Z');

const ctx = (scopes: string[], status = 'active') =>
  ({
    tenant: { id: TENANT, status },
    key: { id: 'key-1', scopes: new Set(scopes) },
    planScopes: null,
    requestId: 'req-1',
  }) as unknown as ApiContext;

/** A database that fails the test if anything is read or written. */
const untouched = {
  run: () => {
    throw new Error('used the database');
  },
} as unknown as Database;
const clock = { now: () => NOW };

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

/**
 * A database whose transaction answers the company's time zone, records how it was run, and stops
 * with `reached the report` when the report's own queries start.
 */
function company(timezone: string) {
  const runs: unknown[] = [];
  let reads = 0;
  const tx = {
    select: () => {
      reads += 1;
      if (reads > 1) throw new Error('reached the report');
      return { from: () => ({ where: () => Promise.resolve([{ timezone }]) }) };
    },
    execute: () => Promise.reject(new Error('reached the report')),
  } as unknown as Tx;
  const db = {
    run: (_scope: unknown, fn: (tx: Tx) => Promise<unknown>, options: unknown) => {
      runs.push(options);
      return fn(tx);
    },
  } as unknown as Database;
  return { db, runs };
}

const counts = {
  inbound: 7,
  outbound: 11,
  byMember: 3,
  byCampaign: 4,
  byOther: 4,
  canceled: 1,
  inProgress: 0,
  sent: 2,
  delivered: 5,
  read: 2,
  failed: 1,
  unknown: 0,
};
const outcomes = {
  started: 3,
  active: 1,
  completed: 1,
  handed_off: 1,
  taken_over: 0,
  stopped: 0,
  failed: 0,
};
const ratio = { numerator: 1, denominator: 2 };

const report: Report = {
  period: {
    preset: 'last_7_days',
    timezone: 'Asia/Kolkata',
    from: '2026-10-02',
    to: '2026-10-08',
    start: new Date('2026-10-01T18:30:00.000Z'),
    end: new Date('2026-10-08T18:30:00.000Z'),
    days: ['2026-10-02', '2026-10-08'],
    inProgress: true,
  },
  generatedAt: NOW,
  messaging: {
    totals: counts,
    rates: { sent: ratio, delivered: ratio, read: ratio, failure: ratio },
    days: [{ day: '2026-10-08', ...counts }],
    failureCodes: [{ code: '131026', count: 1 }],
  },
  costs: {
    currency: 'INR',
    cards: [{ id: CARD, effectiveFrom: new Date('2026-07-01T00:00:00.000Z') }],
    delivered: 5,
    billable: 4,
    free: 1,
    notReported: 0,
    priced: 3,
    totalMicros: 2_354_100,
    lines: [{ category: 'marketing', market: 'IN', count: 3, micros: 2_354_100 }],
    unpriced: { noCurrency: 0, noRateCard: 0, otherCategory: 1, marketUnknown: 0, noPrice: 0 },
  },
  inbox: {
    targetMinutes: 15,
    teamTargets: [{ teamId: TEAM, name: 'Returns', minutes: 30 }],
    teamBusinessHours: [{ teamId: TEAM, name: 'Returns' }],
    teamClosedDays: [{ teamId: TEAM, name: 'Returns' }],
    businessHours: false,
    now: {
      open: 4,
      unassigned: 1,
      waiting: 2,
      oldestWaitSeconds: 600,
      windowsClosing: 1,
      windowsClosed: 0,
      overTarget: 1,
      byAssignee: [
        { membershipId: MEMBER, name: 'Asha', waiting: 1, oldestWaitSeconds: 600 },
        { membershipId: null, name: null, waiting: 1, oldestWaitSeconds: 60 },
      ],
    },
    turns: {
      started: 5,
      answered: 3,
      resolvedWithoutReply: 1,
      waiting: 1,
      medianSeconds: 90,
      p90Seconds: 300,
      businessMedianSeconds: null,
      businessP90Seconds: null,
      buckets: { upTo5m: 2, upTo1h: 1, upTo24h: 0, over24h: 0 },
      withinTarget: ratio,
    },
    resolution: { resolved: 2, medianSeconds: 3600, p90Seconds: 7200 },
    days: [
      {
        day: '2026-10-08',
        started: 5,
        answered: 3,
        resolvedWithoutReply: 1,
        waiting: 1,
        medianSeconds: 90,
        businessMedianSeconds: null,
        casesResolved: 2,
        medianResolutionSeconds: 3600,
      },
    ],
  },
  csat: {
    enabled: true,
    surveys: 3,
    sent: 2,
    skipped: {
      window_closed: 1,
      opted_out: 0,
      suppressed: 0,
      contact_erased: 0,
      no_phone: 0,
      channel_inactive: 0,
      recently_surveyed: 0,
    },
    delivered: 2,
    answered: 1,
    ratings: { best: 1, middle: 0, worst: 0 },
    responseRate: ratio,
    score: { numerator: 1, denominator: 1 },
    days: [
      {
        day: '2026-10-08',
        surveys: 3,
        sent: 2,
        skipped: 1,
        delivered: 2,
        answered: 1,
        best: 1,
        middle: 0,
        worst: 0,
      },
    ],
  },
  automations: {
    totals: outcomes,
    shares: {
      completed: ratio,
      handed_off: ratio,
      taken_over: ratio,
      stopped: ratio,
      failed: ratio,
    },
    failures: [{ reason: 'window_closed', runs: 1 }],
    automations: [{ id: AUTOMATION, name: 'Welcome', ...outcomes }],
    days: [{ day: '2026-10-08', ...outcomes }],
  },
  deals: {
    won: [{ currency: 'INR', deals: 1, valueMinor: 500_000 }],
    lost: [],
    winRate: { numerator: 1, denominator: 1 },
    medianSecondsToWin: 86_400,
    pipelines: [
      {
        id: PIPELINE,
        name: 'Sales',
        currency: 'INR',
        stages: [{ id: STAGE, name: 'New', deals: 2, valueMinor: 100_000 }],
        forecast: {
          months: ['2026-10', '2026-11', '2026-12'],
          buckets: [
            { bucket: 'this_month', deals: 2, valueMinor: 100_000, weightedMinor: 0 },
            { bucket: 'next_month', deals: 0, valueMinor: 0, weightedMinor: 0 },
            { bucket: 'month_after', deals: 0, valueMinor: 0, weightedMinor: 0 },
            { bucket: 'later', deals: 0, valueMinor: 0, weightedMinor: 0 },
            { bucket: 'undated', deals: 0, valueMinor: 0, weightedMinor: 0 },
          ],
          hasChances: false,
          dealsWithoutChance: 2,
        },
      },
    ],
    days: [
      {
        day: '2026-10-08',
        currency: 'INR',
        won: 1,
        wonValueMinor: 500_000,
        lost: 0,
        lostValueMinor: 0,
      },
    ],
    field: null,
  },
  agents: [
    {
      membershipId: MEMBER,
      name: 'Asha',
      roles: ['admin'],
      status: 'active',
      replies: 3,
      templates: 1,
      turnsAnswered: 3,
      medianSeconds: 90,
      resolved: 2,
      csatAnswered: 1,
      csatBest: 1,
    },
  ],
  campaigns: {
    rows: [
      {
        id: CAMPAIGN,
        name: 'Diwali',
        status: 'completed',
        startedAt: new Date('2026-10-05T04:30:00.000Z'),
        currency: 'INR',
        audience: 4,
        skipped: 1,
        queued: 3,
        sent: 1,
        delivered: 2,
        read: 1,
        failed: 0,
        unknown: 0,
        replied: 1,
        optedOut: 0,
        estimateMicros: 2_354_100,
        estimateMissing: 0,
      },
    ],
    truncated: false,
  },
  definitions: METRIC_DEFINITIONS.slice(0, 2),
};

describe('reports through the API (ADR-297)', () => {
  it('need reports.read, a reading scope the database accepts, granted with the members’ reports.read', () => {
    expect(API_SCOPES).toContain('reports.read');
    expect(API_SCOPE_KEYS.indexOf('reports.read')).toBe(
      API_SCOPE_KEYS.indexOf('saved_replies.manage') + 1,
    );
    expect(API_SCOPE_INFO['reports.read']).toMatchObject({
      label: 'Read reports',
      permission: 'reports.read',
      writes: false,
    });
    for (const words of [
      'Read the numbers the Reports page shows for a period',
      "each member's activity",
      'never a message, contact or conversation',
    ]) {
      expect(API_SCOPE_INFO['reports.read'].description).toContain(words);
    }
    for (const role of ['owner', 'admin', 'marketer', 'analyst'] as const) {
      expect(ROLE_PERMISSIONS[role].has('reports.read')).toBe(true);
    }
    expect(ROLE_PERMISSIONS.agent.has('reports.read')).toBe(false);
  });

  it('refuse a key without the scope and a period they cannot read, before reading', async () => {
    expect(await refusal(apiGetReport({ db: untouched, clock }, ctx(['deals.read']), {}))).toEqual([
      'forbidden',
      'This API key does not have the reports.read scope.',
    ]);
    for (const query of [
      { preset: 'yesterday' },
      { preset: 'custom', from: '8 October' },
      { period: 'last_7_days' },
    ]) {
      expect(
        (await refusal(apiGetReport({ db: untouched, clock }, ctx(['reports.read']), query)))[0],
      ).toBe('validation_failed');
    }
    expect(apiReportQuerySchema.parse({})).toEqual({ preset: 'last_7_days' });
    expect(
      apiReportQuerySchema.parse({ preset: 'custom', from: '2026-10-01', to: '2026-10-08' }),
    ).toEqual({ preset: 'custom', from: '2026-10-01', to: '2026-10-08' });
  });

  it('cut the period in the company’s time zone, in one read-only snapshot, read while the company is suspended too', async () => {
    const today = { preset: 'custom', from: '2026-10-08', to: '2026-10-08' };
    // 8 October has begun in Kolkata: the report is read.
    const kolkata = company('Asia/Kolkata');
    await expect(
      apiGetReport({ db: kolkata.db, clock }, ctx(['reports.read'], 'suspended'), today),
    ).rejects.toThrow('reached the report');
    expect(kolkata.runs).toEqual([{ isolationLevel: 'repeatable read', accessMode: 'read only' }]);
    // It has not in UTC: the period would end after today.
    const utc = company('UTC');
    expect(
      await refusal(apiGetReport({ db: utc.db, clock }, ctx(['reports.read']), today)),
    ).toEqual(['validation_failed', 'The period cannot end after today.']);
    expect(
      await refusal(
        apiGetReport({ db: company('UTC').db, clock }, ctx(['reports.read']), {
          preset: 'custom',
          from: '2026-01-01',
          to: '2026-10-07',
        }),
      ),
    ).toEqual([
      'validation_failed',
      'Choose a period of at most 92 days; export several periods for longer ranges.',
    ]);
  });

  it('give the report with times as ISO strings, members by id and name, charges in millionths', () => {
    const api = toApiReport(report);
    expect(apiReportSchema.safeParse(api).success).toBe(true);
    expect(api.period).toEqual({
      preset: 'last_7_days',
      timeZone: 'Asia/Kolkata',
      from: '2026-10-02',
      to: '2026-10-08',
      start: '2026-10-01T18:30:00.000Z',
      end: '2026-10-08T18:30:00.000Z',
      days: ['2026-10-02', '2026-10-08'],
      inProgress: true,
    });
    expect(api.generatedAt).toBe('2026-10-07T20:00:00.000Z');
    expect(api.messaging).toEqual(report.messaging);
    expect(api.costs).toEqual({
      currency: 'INR',
      rateCards: [{ id: CARD, effectiveFrom: '2026-07-01T00:00:00.000Z' }],
      delivered: 5,
      billable: 4,
      free: 1,
      notReported: 0,
      priced: 3,
      estimatedMicros: 2_354_100,
      lines: [{ category: 'marketing', market: 'IN', messages: 3, estimatedMicros: 2_354_100 }],
      unpriced: report.costs.unpriced,
    });
    expect(api.inbox.now.byAssignee).toEqual([
      { memberId: MEMBER, name: 'Asha', waiting: 1, oldestWaitSeconds: 600 },
      { memberId: null, name: null, waiting: 1, oldestWaitSeconds: 60 },
    ]);
    // Teams with their own target, by id, name and minutes (ADR-377).
    expect(api.inbox.teamTargets).toEqual([{ teamId: TEAM, name: 'Returns', targetMinutes: 30 }]);
    // Teams with their own business hours, by id and name (ADR-389).
    expect(api.inbox.teamBusinessHours).toEqual([{ teamId: TEAM, name: 'Returns' }]);
    // Teams with their own closed days, by id and name (ADR-392).
    expect(api.inbox.teamClosedDays).toEqual([{ teamId: TEAM, name: 'Returns' }]);
    expect(api.inbox.turns).toEqual(report.inbox.turns);
    expect(api.inbox.days).toEqual(report.inbox.days);
    expect(api.csat).toEqual(report.csat);
    expect(api.automations).toEqual(report.automations);
    // Each pipeline's forecast as GET /pipelines/{id}/forecast gives it: no stage has a chance.
    expect(api.deals.pipelines[0]?.forecast).toMatchObject({
      pipelineId: PIPELINE,
      currency: 'INR',
      timeZone: 'Asia/Kolkata',
      asOf: '2026-10-07T20:00:00.000Z',
      hasChances: false,
      dealsWithoutChance: 2,
    });
    expect(api.deals.pipelines[0]?.forecast.buckets[0]).toEqual({
      bucket: 'this_month',
      deals: 2,
      valueMinor: 100_000,
      weightedMinor: null,
    });
    expect(api.deals.pipelines[0]?.stages).toEqual(report.deals.pipelines[0]?.stages);
    expect(api.deals.won).toEqual(report.deals.won);
    expect(api.deals.days).toEqual(report.deals.days);
    // No roles or membership status: names only, as GET /members gives them.
    expect(api.members).toEqual([
      {
        memberId: MEMBER,
        name: 'Asha',
        replies: 3,
        templates: 1,
        turnsAnswered: 3,
        medianSeconds: 90,
        resolved: 2,
        csatAnswered: 1,
        csatBest: 1,
      },
    ]);
    expect(api.campaigns.rows[0]).toMatchObject({
      id: CAMPAIGN,
      startedAt: '2026-10-05T04:30:00.000Z',
      estimatedMicros: 2_354_100,
      unpriced: 0,
    });
    expect(api.campaigns.truncated).toBe(false);
    // The definitions without the page's freshness wording.
    expect(api.definitions[0]).toEqual({
      key: METRIC_DEFINITIONS[0]?.key,
      version: METRIC_DEFINITIONS[0]?.version,
      label: METRIC_DEFINITIONS[0]?.label,
      unit: METRIC_DEFINITIONS[0]?.unit,
      description: METRIC_DEFINITIONS[0]?.description,
      numerator: METRIC_DEFINITIONS[0]?.numerator,
      denominator: METRIC_DEFINITIONS[0]?.denominator,
      window: METRIC_DEFINITIONS[0]?.window,
      timezoneRule: METRIC_DEFINITIONS[0]?.timezoneRule,
      missingData: METRIC_DEFINITIONS[0]?.missingData,
      available: METRIC_DEFINITIONS[0]?.available,
    });
  });

  it('are described: the scope, the sections, the period, the snapshot', () => {
    expect(API_ROUTES).toContainEqual(['get', '/reports']);
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<
        string,
        Record<string, { operationId: string; description: string; parameters: { name: string }[] }>
      >;
      components: { schemas: Record<string, { required?: string[] }> };
    };
    const get = doc.paths['/reports']?.get;
    expect(get?.operationId).toBe('getReport');
    for (const words of [
      'Scope: `reports.read`.',
      'The numbers the Reports page shows, for one period',
      'in the company’s time zone and in one snapshot',
      'Members are named by id and name only, as GET /members names them.',
      'at most 92 days and not after today (422 otherwise)',
      'Estimated charges are estimates from the published rates, never an invoice.',
    ]) {
      expect(get?.description).toContain(words);
    }
    expect(get?.parameters.map((p) => p.name)).toEqual(['preset', 'from', 'to', 'field']);
    expect(doc.components.schemas.Report?.required).toEqual([
      'period',
      'generatedAt',
      'messaging',
      'costs',
      'inbox',
      'csat',
      'automations',
      'deals',
      'members',
      'campaigns',
      'definitions',
    ]);
  });
});

describe('the deals section filtered by a deal field through the API (ADR-396)', () => {
  /** The code, message and issue paths of a refusal. */
  async function refused(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      if (!isAppError(error)) throw error;
      return [error.code, error.publicMessage, (error.issues ?? []).map((i) => i.path)];
    }
    throw new Error('expected a refusal');
  }

  /**
   * A company whose plan has `modules` and whose deal fields are `fields`: its transaction answers
   * the time zone, the entitlements and the fields, in that order, and stops with `reached the
   * report` when the report's own queries start.
   */
  function crmCompany(modules: string[]) {
    let selects = 0;
    let executes = 0;
    const fields = [
      { key: 'region', label: 'Region', type: 'text', options: null },
      { key: 'tier', label: 'Tier', type: 'choice', options: ['Gold', 'Silver'] },
      { key: 'signed', label: 'Signed', type: 'boolean', options: null },
    ];
    const tx = {
      select: () => {
        selects += 1;
        if (selects > 2) throw new Error('reached the report');
        const rows = selects === 1 ? [{ timezone: 'Asia/Kolkata' }] : fields;
        return {
          from: () => ({
            where: () =>
              Object.assign(Promise.resolve(rows), { orderBy: () => Promise.resolve(rows) }),
          }),
        };
      },
      execute: () => {
        executes += 1;
        if (executes > 1) return Promise.reject(new Error('reached the report'));
        return Promise.resolve({
          rows: [
            {
              plan_status: 'active',
              plan_id: null,
              seats: null,
              numbers: null,
              teams: null,
              live_automations: null,
              automation_runs: null,
              modules,
              usage_anchor: NOW.toISOString(),
              api_requests: null,
              api_scopes: null,
            },
          ],
        });
      },
    } as unknown as Tx;
    const db = {
      run: (_scope: unknown, fn: (tx: Tx) => Promise<unknown>) => fn(tx),
    } as unknown as Database;
    return { db, selects: () => selects };
  }

  const both = ctx(['reports.read', 'deals.read']);

  it('take `field` as GET /deals does, at most 200 characters, beside the period', () => {
    expect(apiReportQuerySchema.parse({ field: 'tier:Gold' })).toEqual({
      preset: 'last_7_days',
      field: 'tier:Gold',
    });
    expect(apiReportQuerySchema.parse({ preset: 'this_month', field: 'tier:' })).toEqual({
      preset: 'this_month',
      field: 'tier:',
    });
    expect(apiReportQuerySchema.parse({})).toEqual({ preset: 'last_7_days' });
    const tooLong = apiReportQuerySchema.safeParse({ field: `tier:${'x'.repeat(196)}` });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['field', apiDealFieldFilterMessage('malformed')],
    ]);
    expect(apiReportQuerySchema.safeParse({ field: `tier:${'x'.repeat(195)}` }).success).toBe(true);
  });

  it('need deals.read as well, checked before the text and before anything is read', async () => {
    for (const field of ['tier:Gold', '', 'tier']) {
      expect(
        await refused(apiGetReport({ db: untouched, clock }, ctx(['reports.read']), { field })),
        field,
      ).toEqual(['forbidden', 'This API key does not have the deals.read scope.', []]);
    }
    // Without `field`, reports.read alone reads the report, as before.
    await expect(
      apiGetReport({ db: company('Asia/Kolkata').db, clock }, ctx(['reports.read']), {}),
    ).rejects.toThrow('reached the report');
  });

  it('refuse a text written otherwise with 422 naming `field`, before anything is read', async () => {
    for (const field of ['', 'tier', 'Tier:Gold', 'tier: ', ':Gold', `tier:${'x'.repeat(200)}`]) {
      expect(await refused(apiGetReport({ db: untouched, clock }, both, { field })), field).toEqual(
        ['validation_failed', apiDealFieldFilterMessage('malformed'), ['field']],
      );
    }
  });

  it('need the CRM in the plan, then resolve the key against the company’s own fields, never ignoring one', async () => {
    const outside = crmCompany([]);
    const error = await apiGetReport({ db: outside.db, clock }, both, { field: 'tier:Gold' }).catch(
      (e: unknown) => e,
    );
    expect(isAppError(error) && [error.code, error.publicMessage, error.details]).toEqual([
      'forbidden',
      "Your company's plan does not include the CRM.",
      { apiReason: 'not_in_plan' },
    ]);
    // The fields were not read.
    expect(outside.selects()).toBe(1);
    for (const [field, problem] of [
      ['plan:Gold', 'no_field'],
      ['region:North', 'not_filterable'],
      ['tier:Platinum', 'no_option'],
      ['signed:maybe', 'no_option'],
    ] as const) {
      expect(
        await refused(apiGetReport({ db: crmCompany(['crm']).db, clock }, both, { field })),
        field,
      ).toEqual(['validation_failed', apiDealFieldFilterMessage(problem), ['field']]);
    }
    // One the fields resolve, in any case, reaches the report.
    for (const field of ['tier:gOLD', 'tier:', 'signed:YES']) {
      await expect(
        apiGetReport({ db: crmCompany(['crm']).db, clock }, both, { field }),
        field,
      ).rejects.toThrow('reached the report');
    }
  });

  it('say which filter the deals section follows, as resolved, and null without one', () => {
    const gold = resolveDealFieldFilter(
      [{ key: 'tier', label: 'Tier', type: 'choice', options: ['Gold'] }],
      { key: 'tier', value: 'gold' },
    );
    if (!gold.ok) throw new Error(gold.problem);
    const filtered = toApiReport({ ...report, deals: { ...report.deals, field: gold.filter } });
    expect(apiReportSchema.safeParse(filtered).success).toBe(true);
    expect(filtered.deals.field).toBe('tier:Gold');
    // The other figures are given as the report reads them.
    expect(filtered.deals.won).toEqual(report.deals.won);
    expect(toApiReport(report).deals.field).toBeNull();
    // A string, never the internal record of the filter.
    expect(apiReportSchema.shape.deals.shape.field.safeParse(gold.filter).success).toBe(false);
  });

  it('are described: the parameter, its forms, the scope, the refusals and the echo, without decision numbers', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<
        string,
        Record<
          string,
          {
            description: string;
            parameters: { name: string; description?: string; schema?: { maxLength?: number } }[];
          }
        >
      >;
      components: {
        schemas: Record<
          string,
          { properties?: Record<string, { required?: string[]; description?: string }> }
        >;
      };
    };
    const get = doc.paths['/reports']?.get;
    const field = get?.parameters.find((p) => p.name === 'field');
    expect(field?.description).toBe(API_REPORT_FIELD_FILTER_DESCRIPTION);
    expect(field?.schema?.maxLength).toBe(200);
    for (const words of [
      '`deals` section',
      'Every other section is unchanged.',
      '`<key>:<value>`',
      'GET /deal-fields',
      '`yes` or `no`',
      'nothing after the colon',
      '`deals.read` scope as well',
      'the CRM in the company’s plan',
      'refused with 422 naming `field`, never ignored',
      'so is an empty `field`',
    ]) {
      expect(API_REPORT_FIELD_FILTER_DESCRIPTION).toContain(words);
    }
    expect(get?.description).toContain('says so in `deals.field`');
    const deals = doc.components.schemas.Report?.properties?.deals;
    expect(deals?.required).toContain('field');
    expect(deals?.description).toContain('With `field`, every figure here counts only the deals');
    expect(JSON.stringify(get)).not.toMatch(/ADR-\d/);
    expect(JSON.stringify(doc.components.schemas.Report)).not.toMatch(/ADR-\d/);
  });
});
