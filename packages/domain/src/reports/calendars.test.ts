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
    const latest = (key: string) =>
      Math.max(...METRIC_DEFINITIONS.filter((d) => d.key === key).map((d) => d.version));
    expect(latest('inbox.overdue')).toBe(4);
    expect(latest('inbox.first_response_business_time')).toBe(3);
    expect(latest('inbox.within_target')).toBe(5);
    const sql = readFileSync(
      fileURLToPath(
        new URL('../../../db/migrations/0303_team_business_hours.sql', import.meta.url),
      ),
      'utf8',
    );
    for (const [key, version] of [
      ['inbox.overdue', 4],
      ['inbox.first_response_business_time', 3],
      ['inbox.within_target', 5],
    ] as const) {
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
  });
});
