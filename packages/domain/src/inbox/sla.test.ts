import { describe, expect, it } from 'vitest';
import {
  businessCalendars,
  calendarFor,
  intervalsToDayTexts,
  sameIntervals,
  teamHoursSchema,
  TEAM_HOURS_EMPTY_MESSAGE,
  type BusinessCalendar,
  type BusinessInterval,
} from './business-hours';
import { sameTeamHours, teamHoursAudit } from './teams';
import {
  calendarsOf,
  hasAnyTarget,
  replyDueAt,
  replyTimer,
  targetFor,
  teamsWithOwnClock,
  type ReplyTargets,
} from './sla';

const RETURNS = 'team-returns';

describe('reply targets per team (ADR-377)', () => {
  it('hold a conversation to its team’s own target, else the company’s', () => {
    const targets: ReplyTargets = {
      companyMinutes: 30,
      teamMinutes: new Map([[RETURNS, 10]]),
      calendar: null,
      teamCalendars: new Map(),
    };
    expect(targetFor(targets, RETURNS)).toEqual({ minutes: 10, calendar: null });
    expect(targetFor(targets, 'team-sales')).toEqual({ minutes: 30, calendar: null });
    expect(targetFor(targets, null)).toEqual({ minutes: 30, calendar: null });
    const start = new Date('2026-10-16T10:00:00Z');
    expect(replyDueAt(targetFor(targets, RETURNS), start)).toEqual(
      new Date('2026-10-16T10:10:00Z'),
    );
    expect(replyDueAt(targetFor(targets, null), start)).toEqual(new Date('2026-10-16T10:30:00Z'));
  });

  it('give a team’s conversations a target even when the company has none', () => {
    const targets: ReplyTargets = {
      companyMinutes: null,
      teamMinutes: new Map([[RETURNS, 45]]),
      calendar: null,
      teamCalendars: new Map(),
    };
    expect(hasAnyTarget(targets)).toBe(true);
    expect(targetFor(targets, RETURNS).minutes).toBe(45);
    expect(targetFor(targets, null).minutes).toBeNull();
    expect(replyDueAt(targetFor(targets, 'team-sales'), new Date())).toBeNull();
    const none = { teamMinutes: new Map(), calendar: null, teamCalendars: new Map() };
    expect(hasAnyTarget({ ...none, companyMinutes: null })).toBe(false);
    expect(hasAnyTarget({ ...none, companyMinutes: 5 })).toBe(true);
  });
});

const days = (weekdays: number[], opens: number, closes: number): BusinessInterval[] =>
  weekdays.map((weekday) => ({ weekday, opens, closes }));
const NIGHT = 'team-night';

describe('business hours per team (ADR-389)', () => {
  // Asia/Kolkata (UTC+05:30, no daylight saving). 2026-09-21 is a Monday.
  const company: BusinessCalendar = {
    timezone: 'Asia/Kolkata',
    intervals: days([1, 2, 3, 4, 5], 9 * 60, 17 * 60),
    closedDays: new Set(['2026-09-23']),
  };
  const night = days([1, 2, 3, 4, 5, 6, 7], 18 * 60, 24 * 60);

  it('give a conversation its team’s own calendar, else the company’s, with the company’s closed days and time zone', () => {
    const calendars = businessCalendars(company, new Map([[NIGHT, night]]));
    const teamCal = calendarFor(calendars, NIGHT);
    expect(teamCal).toEqual({ ...company, intervals: night });
    expect(teamCal?.closedDays).toBe(company.closedDays);
    expect(teamCal?.timezone).toBe('Asia/Kolkata');
    expect(calendarFor(calendars, 'team-sales')).toBe(company);
    expect(calendarFor(calendars, null)).toBe(company);
    // A team with an empty schedule has none of its own.
    expect(businessCalendars(company, new Map([[NIGHT, []]])).teams.size).toBe(0);
  });

  it('apply only while the company’s business hours are on: otherwise absolute time everywhere', () => {
    const off = businessCalendars(null, new Map([[NIGHT, night]]));
    expect(off.teams.size).toBe(0);
    expect(calendarFor(off, NIGHT)).toBeNull();
    expect(calendarFor(off, null)).toBeNull();
    // Even given a team's calendar, none applies without the company's.
    const night0: BusinessCalendar = { ...company, intervals: night };
    expect(calendarFor({ company: null, teams: new Map([[NIGHT, night0]]) }, NIGHT)).toBeNull();
    const targets: ReplyTargets = {
      companyMinutes: 30,
      teamMinutes: new Map(),
      calendar: null,
      teamCalendars: new Map(),
    };
    expect(replyDueAt(targetFor(targets, NIGHT), new Date('2026-09-21T13:00:00Z'))).toEqual(
      new Date('2026-09-21T13:30:00Z'),
    );
  });

  it('count a team’s target in its own hours and the company’s target in the company’s', () => {
    const calendars = businessCalendars(company, new Map([[NIGHT, night]]));
    const targets: ReplyTargets = {
      companyMinutes: 30,
      teamMinutes: new Map([[NIGHT, 20]]),
      calendar: calendars.company,
      teamCalendars: calendars.teams,
    };
    expect(calendarsOf(targets)).toEqual(calendars);
    // Monday 16:50 local (11:20Z). The company's conversations are due Tuesday 09:20 local; the
    // night team's opens at 18:00 local and is due at 18:20 local the same day.
    const start = new Date('2026-09-21T11:20:00Z');
    expect(replyDueAt(targetFor(targets, null), start)?.toISOString()).toBe(
      '2026-09-22T03:50:00.000Z',
    );
    expect(replyDueAt(targetFor(targets, NIGHT), start)?.toISOString()).toBe(
      '2026-09-21T12:50:00.000Z',
    );
    // A team with its own hours but no target of its own: the company's target in its hours.
    const hoursOnly: ReplyTargets = { ...targets, teamMinutes: new Map() };
    expect(replyDueAt(targetFor(hoursOnly, NIGHT), start)?.toISOString()).toBe(
      '2026-09-21T13:00:00.000Z',
    );
    // Wednesday is the company's closed day for every team: Tuesday 23:50 local + 20 minutes of
    // the night team's hours is Thursday 18:10 local.
    expect(
      replyDueAt(targetFor(targets, NIGHT), new Date('2026-09-22T18:20:00Z'))?.toISOString(),
    ).toBe('2026-09-24T12:40:00.000Z');
    // The timer pauses by the team's hours: at 17:30 local the company's is paused until Tuesday
    // 09:00 and the night team's until 18:00 the same day.
    const now = new Date('2026-09-21T12:00:00Z');
    expect(replyTimer(targetFor(targets, null), start, now).pausedUntil?.toISOString()).toBe(
      '2026-09-22T03:30:00.000Z',
    );
    expect(replyTimer(targetFor(targets, NIGHT), start, now).pausedUntil?.toISOString()).toBe(
      '2026-09-21T12:30:00.000Z',
    );
  });

  it('count across a daylight-saving change in the company’s time zone', () => {
    // America/New_York: 2026-11-01 (a Sunday) has 25 hours; clocks go back at 02:00.
    const ny: BusinessCalendar = {
      timezone: 'America/New_York',
      intervals: days([1, 2, 3, 4, 5], 9 * 60, 17 * 60),
      closedDays: new Set(),
    };
    const weekend = days([7], 0, 4 * 60);
    const calendars = businessCalendars(ny, new Map([[NIGHT, weekend]]));
    const targets: ReplyTargets = {
      companyMinutes: 270,
      teamMinutes: new Map(),
      calendar: calendars.company,
      teamCalendars: calendars.teams,
    };
    // From Sunday 00:00 local (04:00Z, still EDT), the team's 00:00-04:00 local lasts five real
    // hours that day, so four and a half business hours end at 03:30 EST (08:30Z) the same day.
    const start = new Date('2026-11-01T04:00:00Z');
    expect(replyDueAt(targetFor(targets, NIGHT), start)?.toISOString()).toBe(
      '2026-11-01T08:30:00.000Z',
    );
    // The company's conversations wait for Monday 09:00 EST (14:00Z): due at 13:30 EST.
    expect(replyDueAt(targetFor(targets, null), start)?.toISOString()).toBe(
      '2026-11-02T18:30:00.000Z',
    );
  });

  it('rank a team apart when it has its own target or hours', () => {
    const calendars = businessCalendars(company, new Map([[NIGHT, night]]));
    const targets: ReplyTargets = {
      companyMinutes: 30,
      teamMinutes: new Map([['team-returns', 10]]),
      calendar: calendars.company,
      teamCalendars: calendars.teams,
    };
    expect(teamsWithOwnClock(targets).sort()).toEqual(['team-night', 'team-returns']);
    expect(teamsWithOwnClock({ ...targets, teamMinutes: new Map([[NIGHT, 5]]) })).toEqual([NIGHT]);
  });

  it('take a week of text as the company’s schedule is taken, at least one opening time', () => {
    const week = ['09:00-13:00, 14:00-18:00', '', '', '', '22:00-24:00', '', ''];
    const parsed = teamHoursSchema.parse(week);
    expect(parsed).toEqual([
      { weekday: 1, opens: 540, closes: 780 },
      { weekday: 1, opens: 840, closes: 1080 },
      { weekday: 5, opens: 1320, closes: 1440 },
    ]);
    expect(intervalsToDayTexts(parsed ?? [])).toEqual(week);
    expect(teamHoursSchema.parse(null)).toBeNull();
    const refused = (input: unknown) => {
      const result = teamHoursSchema.safeParse(input);
      return result.success ? null : result.error.issues.map((i) => [i.path.join('.'), i.message]);
    };
    expect(refused(['', '', '', '', '', '', ''])).toEqual([['', TEAM_HOURS_EMPTY_MESSAGE]]);
    expect(refused(['', '', '18:00-09:00', '', '', '', ''])).toEqual([
      [
        '2',
        'Wednesday: A range must end after it starts; use 24:00 for midnight (got “18:00-09:00”).',
      ],
    ]);
    expect(refused(['09:00-12:00, 11:00-13:00', '', '', '', '', '', ''])).toEqual([
      ['0', 'Monday: Time ranges on the same day must not overlap.'],
    ]);
    expect(refused(['09:00-10:00', '', '', '', '', '', '', ''])?.[0]?.[1]).toBe(
      'Give seven days, Monday first.',
    );
    expect(refused(['x'.repeat(201), '', '', '', '', '', ''])?.[0]?.[1]).toBe(
      'Use at most 200 characters a day.',
    );
  });

  it('compare and audit a team’s hours', () => {
    const a = days([1, 2], 540, 1020);
    expect(sameIntervals(a, [...a].reverse())).toBe(true);
    expect(sameTeamHours(a, [...a].reverse())).toBe(true);
    expect(sameTeamHours(null, null)).toBe(true);
    expect(sameTeamHours(a, null)).toBe(false);
    expect(sameTeamHours(null, a)).toBe(false);
    expect(sameTeamHours(a, days([1], 540, 1020))).toBe(false);
    expect(sameTeamHours(a, days([1, 2], 540, 1080))).toBe(false);
    expect(teamHoursAudit(a)).toEqual({ ownBusinessHours: true, businessHoursRanges: 2 });
    expect(teamHoursAudit(null)).toEqual({ ownBusinessHours: false, businessHoursRanges: 0 });
  });
});
