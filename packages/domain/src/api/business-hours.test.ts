import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { API_SCOPES, type Database } from '@w360/db';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import { checkDayRanges, type BusinessCalendar } from '../inbox/business-hours';
import {
  apiCreateClosedDay,
  apiCreateClosedDaySchema,
  apiDeleteClosedDay,
  apiGetBusinessHours,
  apiListClosedDays,
  apiScheduleIntervals,
  apiUpdateBusinessHours,
  apiUpdateBusinessHoursSchema,
  businessHoursStatus,
  closedDaySpan,
  sameIntervals,
  toApiDays,
} from './business-hours';
import type { ApiContext } from './context';
import { API_SCOPE_INFO, API_SCOPE_KEYS } from './model';
import {
  API_ROUTES,
  apiBusinessHoursSchema,
  apiClosedDaySchema,
  buildOpenApiDocument,
} from './openapi';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const DAY_ID = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
// A Wednesday, 15:30 in Kolkata.
const NOW = new Date('2026-10-07T10:00:00Z');

const ctx = (scopes: string[], status = 'active') =>
  ({
    tenant: { id: TENANT, status },
    key: { id: 'k', scopes: new Set(scopes) },
    planScopes: null,
  }) as unknown as ApiContext;

/** A database that fails the test if anything is read or written. */
const untouched = {
  run: () => {
    throw new Error('used the database');
  },
} as unknown as Database;
const deps = { db: untouched, clock: { now: () => NOW } };

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

/** The code, message and paths of a refusal. */
async function refusal(promise: Promise<unknown> | (() => unknown)) {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    if (!isAppError(error)) throw error;
    return [error.code, error.publicMessage, (error.issues ?? []).map((i) => i.path)];
  }
  throw new Error('expected a refusal');
}

const weekdays = (ranges: { opens: string; closes: string }[]) => [
  ranges,
  ranges,
  ranges,
  ranges,
  ranges,
  [],
  [],
];
const nineToSix = [{ opens: '09:00', closes: '18:00' }];

/** Weekdays 09:00 to 18:00 in Kolkata, closed on Thursday 8 October 2026. */
const calendar: BusinessCalendar = {
  timezone: 'Asia/Kolkata',
  intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: 540, closes: 1080 })),
  closedDays: new Set(['2026-10-08']),
};

describe('business hours through the API (ADR-290)', () => {
  it('reads with business_hours.read and writes with business_hours.manage, the scopes the database accepts', () => {
    for (const scope of ['business_hours.read', 'business_hours.manage'] as const) {
      expect(API_SCOPES).toContain(scope);
    }
    // After availability.write and before webhooks.manage, in the order the database's checks list them.
    expect(API_SCOPE_KEYS.slice(API_SCOPE_KEYS.indexOf('availability.write'))).toEqual([
      'availability.write',
      'business_hours.read',
      'business_hours.manage',
      'webhooks.manage',
    ]);
    expect(API_SCOPE_INFO['business_hours.read']).toMatchObject({
      label: 'Read business hours',
      permission: 'tenant.read',
      writes: false,
    });
    expect(API_SCOPE_INFO['business_hours.manage']).toMatchObject({
      label: 'Manage business hours',
      permission: 'tenant.settings.manage',
      writes: true,
    });
    expect(API_SCOPE_INFO['business_hours.read'].description).toContain(
      'whether it is open now and when it next opens or closes, and its closed days',
    );
    for (const words of [
      'turn them on or off, and add and remove closed days',
      'as owners and administrators do in Settings → Inbox',
      'recorded in the audit log as done by the key',
      "Reply-due timers and automations' off-hours branches follow them.",
    ]) {
      expect(API_SCOPE_INFO['business_hours.manage'].description).toContain(words);
    }
    for (const role of ['owner', 'admin'] as const) {
      expect(ROLE_PERMISSIONS[role].has('tenant.read')).toBe(true);
      expect(ROLE_PERMISSIONS[role].has('tenant.settings.manage')).toBe(true);
    }
  });

  it('takes the whole week as Settings checks it, Monday first', async () => {
    const week = apiUpdateBusinessHoursSchema.parse({
      enabled: true,
      days: [
        [
          { opens: '14:00', closes: '18:00' },
          { opens: '09:00', closes: '13:00' },
        ],
        [],
        [],
        [],
        [],
        [{ opens: '10:00', closes: '24:00' }],
        [],
      ],
    });
    expect(apiScheduleIntervals(week)).toEqual([
      { weekday: 1, opens: 540, closes: 780 },
      { weekday: 1, opens: 840, closes: 1080 },
      { weekday: 6, opens: 600, closes: 1440 },
    ]);
    for (const [days, path, message] of [
      [
        weekdays([
          { opens: '09:00', closes: '13:00' },
          { opens: '12:00', closes: '18:00' },
        ]),
        'days.0',
        'Time ranges on the same day must not overlap.',
      ],
      [
        [[], [{ opens: '18:00', closes: '09:00' }], [], [], [], [], []],
        'days.1',
        'A range must end after it starts; use 24:00 for midnight.',
      ],
      [
        [[], [], [{ opens: '24:00', closes: '24:00' }], [], [], [], []],
        'days.2',
        'A range must start before midnight.',
      ],
      [
        [[], [], [], [{ opens: '09:00', closes: '09:00' }], [], [], []],
        'days.3',
        'A range must end after it starts; use 24:00 for midnight.',
      ],
    ] as const) {
      expect(
        await refusal(() =>
          apiScheduleIntervals(apiUpdateBusinessHoursSchema.parse({ enabled: true, days })),
        ),
      ).toEqual(['validation_failed', message, [path]]);
    }
    expect(
      await refusal(() =>
        apiScheduleIntervals(
          apiUpdateBusinessHoursSchema.parse({ enabled: true, days: weekdays([]) }),
        ),
      ),
    ).toEqual([
      'validation_failed',
      'Add at least one opening time before turning business hours on.',
      [],
    ]);
    expect(
      apiScheduleIntervals(
        apiUpdateBusinessHoursSchema.parse({ enabled: false, days: weekdays([]) }),
      ),
    ).toEqual([]);
    for (const input of [
      { enabled: true, days: weekdays(nineToSix).slice(1) },
      {
        enabled: true,
        days: [Array.from({ length: 5 }, () => nineToSix[0]), [], [], [], [], [], []],
      },
      { enabled: true, days: weekdays([{ opens: '9am', closes: '18:00' }]) },
      { enabled: true, days: weekdays([{ opens: '09:00', closes: '24:30' }]) },
      {
        enabled: true,
        days: [[{ opens: '09:00', closes: '18:00', label: 'Day' }], [], [], [], [], [], []],
      },
      { days: weekdays(nineToSix) },
      { enabled: true, days: weekdays(nineToSix), timezone: 'UTC' },
    ]) {
      expect(apiUpdateBusinessHoursSchema.safeParse(input).success, JSON.stringify(input)).toBe(
        false,
      );
    }
  });

  it('checks a day as Settings does: at most four ranges, in order', () => {
    const five = [0, 1, 2, 3, 4].map((h) => ({ opens: h * 120, closes: h * 120 + 60 }));
    expect(checkDayRanges(five)).toEqual({
      ok: false,
      message: 'Use at most 4 time ranges a day.',
    });
    expect(checkDayRanges(five.slice(0, 4).reverse())).toEqual({
      ok: true,
      ranges: five.slice(0, 4),
    });
  });

  it('gives the week and compares weeks as stored, whatever their order', () => {
    const intervals = [
      { weekday: 6, opens: 600, closes: 1440 },
      { weekday: 1, opens: 840, closes: 1080 },
      { weekday: 1, opens: 540, closes: 780 },
    ];
    expect(toApiDays(intervals)).toEqual([
      [
        { opens: '09:00', closes: '13:00' },
        { opens: '14:00', closes: '18:00' },
      ],
      [],
      [],
      [],
      [],
      [{ opens: '10:00', closes: '24:00' }],
      [],
    ]);
    expect(sameIntervals(intervals, [...intervals].reverse())).toBe(true);
    for (const other of [
      intervals.slice(1),
      [...intervals, { weekday: 7, opens: 0, closes: 60 }],
      [{ ...intervals[0]!, weekday: 7 }, ...intervals.slice(1)],
      [{ ...intervals[0]!, opens: 630 }, ...intervals.slice(1)],
      [{ ...intervals[0]!, closes: 1380 }, ...intervals.slice(1)],
    ]) {
      expect(sameIntervals(intervals, other), JSON.stringify(other)).toBe(false);
    }
  });

  it('says whether the company is open now, and when it next opens or closes', () => {
    expect(businessHoursStatus(true, calendar, NOW)).toEqual({
      open: true,
      opensAt: null,
      closesAt: new Date('2026-10-07T12:30:00Z'),
    });
    // After 18:00, with Thursday closed: Friday at 09:00.
    expect(businessHoursStatus(true, calendar, new Date('2026-10-07T13:00:00Z'))).toEqual({
      open: false,
      opensAt: new Date('2026-10-09T03:30:00Z'),
      closesAt: null,
    });
    // Off or empty hours count as always open.
    expect(businessHoursStatus(false, calendar, new Date('2026-10-07T13:00:00Z'))).toEqual({
      open: true,
      opensAt: null,
      closesAt: null,
    });
    // Open all the time: no closing within the next 14 days.
    const always: BusinessCalendar = {
      timezone: 'Asia/Kolkata',
      intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, opens: 0, closes: 1440 })),
      closedDays: new Set(),
    };
    expect(businessHoursStatus(true, always, NOW)).toEqual({
      open: true,
      opensAt: null,
      closesAt: null,
    });
  });

  it('reads closed days a year at a time, from today by default', async () => {
    expect(closedDaySpan({}, '2026-10-07')).toEqual({ from: '2026-10-07', to: '2027-10-07' });
    expect(closedDaySpan({ from: '2028-01-01' }, '2026-10-07')).toEqual({
      from: '2028-01-01',
      to: '2028-12-31',
    });
    expect(closedDaySpan({ from: '2026-10-07', to: '2026-10-07' }, '2026-10-07')).toEqual({
      from: '2026-10-07',
      to: '2026-10-07',
    });
    for (const query of [
      { from: '2026-10-07', to: '2026-10-06' },
      { from: '2026-01-01', to: '2027-01-02' },
      { to: '2020-01-01' },
    ]) {
      expect(await refusal(() => closedDaySpan(query, '2026-10-07'))).toEqual([
        'validation_failed',
        'Give `to` on or after `from`, at most 365 days later.',
        ['to'],
      ]);
    }
    expect(
      apiCreateClosedDaySchema.safeParse({ day: '2026-12-25', name: 'Christmas' }).success,
    ).toBe(true);
    for (const input of [
      { day: '2026-02-30', name: 'No such day' },
      { day: '2026-12-25', name: ' ' },
      { day: '2026-12-25', name: 'Christmas', id: DAY_ID },
    ]) {
      expect(apiCreateClosedDaySchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('refuses before touching anything: the scopes, a suspended company, an unknown id, a bad body', async () => {
    const none = ctx(['conversations.read', 'tasks.read']);
    const missingRead = [
      'forbidden',
      'This API key does not have the business_hours.read scope.',
      [],
    ];
    expect(await refusal(apiGetBusinessHours(deps, none))).toEqual(missingRead);
    expect(await refusal(apiListClosedDays(deps, none, {}))).toEqual(missingRead);
    const reader = ctx(['business_hours.read']);
    const missingManage = [
      'forbidden',
      'This API key does not have the business_hours.manage scope.',
      [],
    ];
    for (const write of [
      () => apiUpdateBusinessHours(deps, reader, { enabled: false, days: weekdays([]) }),
      () => apiCreateClosedDay(deps, reader, { day: '2026-12-25', name: 'Christmas' }, null),
      () => apiDeleteClosedDay(deps, reader, DAY_ID),
    ]) {
      expect(await refusal(write())).toEqual(missingManage);
    }
    for (const status of ['suspended', 'restricted']) {
      const manager = ctx(['business_hours.manage'], status);
      for (const write of [
        () => apiUpdateBusinessHours(deps, manager, { enabled: false, days: weekdays([]) }),
        () => apiCreateClosedDay(deps, manager, { day: '2026-12-25', name: 'Christmas' }, null),
        () => apiDeleteClosedDay(deps, manager, DAY_ID),
      ]) {
        expect((await refusal(write()))[0]).toBe('tenant_suspended');
      }
    }
    const manager = ctx(['business_hours.manage']);
    expect(await refusal(apiDeleteClosedDay(deps, manager, 'christmas'))).toEqual([
      'not_found',
      'Closed day not found.',
      [],
    ]);
    expect((await refusal(apiUpdateBusinessHours(deps, manager, { enabled: true })))[2]).toEqual([
      'days',
    ]);
    expect((await refusal(apiListClosedDays(deps, manager, { from: '2026-13-01' })))[2]).toEqual([
      'from',
    ]);
    const [, , badDay] = await refusal(
      apiCreateClosedDay(deps, manager, { day: 'tomorrow', name: 'X' }, null),
    );
    expect(new Set(badDay as string[])).toEqual(new Set(['day']));
  });

  it('reads with either scope in one read-only snapshot, while the company is suspended too', async () => {
    for (const scopes of [['business_hours.read'], ['business_hours.manage']]) {
      for (const status of ['active', 'suspended']) {
        const { db, runs } = reached();
        const key = ctx(scopes, status);
        await expect(apiGetBusinessHours({ db, clock: deps.clock }, key)).rejects.toThrow(
          'reached the database',
        );
        await expect(apiListClosedDays({ db, clock: deps.clock }, key, {})).rejects.toThrow(
          'reached the database',
        );
        expect(runs).toEqual([
          { isolationLevel: 'repeatable read', accessMode: 'read only' },
          { isolationLevel: 'repeatable read', accessMode: 'read only' },
        ]);
      }
    }
  });

  it('is described: the scopes, the week, the status, closed days and retries', () => {
    for (const route of [
      ['get', '/business-hours'],
      ['put', '/business-hours'],
      ['get', '/business-hours/closed-days'],
      ['post', '/business-hours/closed-days'],
      ['delete', '/business-hours/closed-days/{id}'],
    ]) {
      expect(API_ROUTES).toContainEqual(route);
    }
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, { operationId: string; description: string }>>;
    };
    const op = (path: string, method: string) => doc.paths[path]?.[method];
    expect(op('/business-hours', 'get')?.operationId).toBe('getBusinessHours');
    for (const words of [
      'Scope: `business_hours.read` or `business_hours.manage`.',
      'whether it is open now (within its hours and not on a closed day)',
      'the company counts as always open',
    ]) {
      expect(op('/business-hours', 'get')?.description).toContain(words);
    }
    expect(op('/business-hours', 'put')?.operationId).toBe('updateBusinessHours');
    for (const words of [
      'Scope: `business_hours.manage`.',
      '`days` replaces the whole week, Monday first',
      'up to 4 ranges that do not overlap (422 naming `days.<n>` otherwise)',
      '(422 without an opening time)',
      'so a retry needs no `Idempotency-Key`',
    ]) {
      expect(op('/business-hours', 'put')?.description).toContain(words);
    }
    expect(op('/business-hours/closed-days', 'get')?.operationId).toBe('listClosedDays');
    expect(op('/business-hours/closed-days', 'get')?.description).toContain(
      'a year at most; from today in the company’s time zone by default',
    );
    expect(op('/business-hours/closed-days', 'post')?.operationId).toBe('createClosedDay');
    expect(op('/business-hours/closed-days', 'post')?.description).toContain(
      '409 when the day is already marked closed',
    );
    expect(op('/business-hours/closed-days/{id}', 'delete')?.operationId).toBe('deleteClosedDay');
    expect(
      apiBusinessHoursSchema.safeParse({
        enabled: true,
        timeZone: 'Asia/Kolkata',
        days: toApiDays(calendar.intervals),
        open: true,
        opensAt: null,
        closesAt: '2026-10-07T12:30:00.000Z',
        asOf: NOW.toISOString(),
      }).success,
    ).toBe(true);
    expect(
      apiClosedDaySchema.safeParse({ id: DAY_ID, day: '2026-12-25', name: 'Christmas' }).success,
    ).toBe(true);
  });
});
