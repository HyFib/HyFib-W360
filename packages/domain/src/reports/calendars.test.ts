import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { businessCalendars, type BusinessCalendar } from '../inbox/business-hours';
import { METRIC_DEFINITIONS } from './definitions';
import { calendarPeriods } from './service';

// Asia/Kolkata (UTC+05:30). 2026-09-21 is a Monday.
const company: BusinessCalendar = {
  timezone: 'Asia/Kolkata',
  intervals: [{ weekday: 1, opens: 9 * 60, closes: 17 * 60 }],
  closedDays: new Set(['2026-09-28']),
};

describe('reports with business hours per team (ADR-389)', () => {
  it('hold each calendar’s opening periods apart: the company’s unnamed, a team’s by its id', () => {
    const calendars = businessCalendars(
      company,
      new Map([['team-night', [{ weekday: 1, opens: 18 * 60, closes: 24 * 60 }]]]),
    );
    const from = new Date('2026-09-20T18:30:00Z');
    const to = new Date('2026-09-29T18:30:00Z');
    expect(
      calendarPeriods(calendars, from, to).map((p) => [
        p.cal,
        p.start.toISOString(),
        p.end.toISOString(),
      ]),
    ).toEqual([
      // Monday 2026-09-28 is the company's closed day, for the team as well.
      ['', '2026-09-21T03:30:00.000Z', '2026-09-21T11:30:00.000Z'],
      ['team-night', '2026-09-21T12:30:00.000Z', '2026-09-21T18:30:00.000Z'],
    ]);
    // Business hours off: no business time at all, whatever the teams have.
    expect(
      calendarPeriods(businessCalendars(null, new Map([['team-night', []]])), from, to),
    ).toEqual([]);
  });

  it('give the measures that count business time new versions, kept equal to migration 0303', () => {
    expectDefinitionsIn('0303_team_business_hours.sql', [
      ['inbox.overdue', 4],
      ['inbox.first_response_business_time', 3],
      ['inbox.within_target', 5],
    ]);
  });
});

/** The definitions `versions` are in migration `file`, word for word, and name teams. */
function expectDefinitionsIn(file: string, versions: readonly (readonly [string, number])[]) {
  const sql = readFileSync(
    fileURLToPath(new URL(`../../../db/migrations/${file}`, import.meta.url)),
    'utf8',
  );
  for (const [key, version] of versions) {
    const d = METRIC_DEFINITIONS.find((m) => m.key === key && m.version === version);
    expect(d, key).toBeDefined();
    expect(sql).toContain(`('${key}', ${version}, '${d?.label}', '${d?.unit}',`);
    for (const text of [
      d?.description,
      d?.numerator,
      d?.denominator,
      d?.window,
      d?.timezoneRule,
      d?.missingData,
      d?.freshness,
    ]) {
      if (text) expect(sql, `${key} v${version}`).toContain(`'${text}'`);
    }
    // Business hours are named as the team's or the company's.
    expect(`${d?.window} ${d?.missingData}`).toContain('team');
  }
}

describe('reports with closed days per team (ADR-392)', () => {
  const night = [{ weekday: 1, opens: 18 * 60, closes: 24 * 60 }];
  const from = new Date('2026-09-20T18:30:00Z');
  const to = new Date('2026-09-29T18:30:00Z');
  const periods = (calendars: ReturnType<typeof businessCalendars>) =>
    calendarPeriods(calendars, from, to).map((p) => [
      p.cal,
      p.start.toISOString(),
      p.end.toISOString(),
    ]);

  it('give a team with its own closed days but the company’s week a calendar of its own', () => {
    // The returns team works on the company's closed day (Monday 2026-09-28) and closes on Monday
    // 2026-09-21 instead.
    expect(
      periods(businessCalendars(company, new Map(), new Map([['team-returns', ['2026-09-21']]]))),
    ).toEqual([
      ['', '2026-09-21T03:30:00.000Z', '2026-09-21T11:30:00.000Z'],
      ['team-returns', '2026-09-28T03:30:00.000Z', '2026-09-28T11:30:00.000Z'],
    ]);
    // An empty list of its own: open on every day of the company's week, the holiday included.
    expect(periods(businessCalendars(company, new Map(), new Map([['team-returns', []]])))).toEqual(
      [
        ['', '2026-09-21T03:30:00.000Z', '2026-09-21T11:30:00.000Z'],
        ['team-returns', '2026-09-21T03:30:00.000Z', '2026-09-21T11:30:00.000Z'],
        ['team-returns', '2026-09-28T03:30:00.000Z', '2026-09-28T11:30:00.000Z'],
      ],
    );
  });

  it('combine a team’s own week with its own closed days', () => {
    expect(
      periods(
        businessCalendars(
          company,
          new Map([['team-night', night]]),
          new Map([['team-night', ['2026-09-21']]]),
        ),
      ),
    ).toEqual([
      ['', '2026-09-21T03:30:00.000Z', '2026-09-21T11:30:00.000Z'],
      ['team-night', '2026-09-28T12:30:00.000Z', '2026-09-28T18:30:00.000Z'],
    ]);
    // Business hours off: none, whatever the teams' closed days.
    expect(
      periods(businessCalendars(null, new Map(), new Map([['team-night', ['2026-09-21']]]))),
    ).toEqual([]);
  });

  it('give the measures that count business time new versions, kept equal to migration 0307', () => {
    const latest = (key: string) =>
      Math.max(...METRIC_DEFINITIONS.filter((d) => d.key === key).map((d) => d.version));
    expect(latest('inbox.overdue')).toBe(5);
    expect(latest('inbox.first_response_business_time')).toBe(4);
    expect(latest('inbox.within_target')).toBe(6);
    expectDefinitionsIn('0307_team_closed_days.sql', [
      ['inbox.overdue', 5],
      ['inbox.first_response_business_time', 4],
      ['inbox.within_target', 6],
    ]);
    for (const [key, version] of [
      ['inbox.overdue', 5],
      ['inbox.first_response_business_time', 4],
      ['inbox.within_target', 6],
    ] as const) {
      const d = METRIC_DEFINITIONS.find((m) => m.key === key && m.version === version);
      // Closed days are named as the team's or the company's, never the company's alone.
      expect(`${d?.window} ${d?.missingData}`, key).toContain('closed days of the team');
      expect(d?.window, key).not.toContain('Closed days and the time zone are the company’s');
    }
  });
});
