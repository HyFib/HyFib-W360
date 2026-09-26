import { describe, expect, it } from 'vitest';
import {
  addBusinessMinutes,
  businessMsBetween,
  businessStatusAt,
  openPeriods,
  parseDayRanges,
  type BusinessCalendar,
  type BusinessInterval,
} from './business-hours';
import { matchesKeyword, nextInRotation, normalizeRoutingText } from './routing';
import { replyTimer } from './sla';

const H = 3_600_000;
const weekdays = (opens: number, closes: number): BusinessInterval[] =>
  [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens, closes }));

function calendar(
  timezone: string,
  intervals: BusinessInterval[],
  closedDays: string[] = [],
): BusinessCalendar {
  return { timezone, intervals, closedDays: new Set(closedDays) };
}

describe('business hours', () => {
  // Asia/Kolkata has no daylight saving: UTC+05:30 all year. 2026-09-21 is a Monday.
  const kolkata = calendar('Asia/Kolkata', weekdays(9 * 60, 17 * 60));

  it('adds business minutes across closing time, weekends and closed days', () => {
    // Monday 16:30 local + 60 business minutes = Tuesday 09:30 local.
    expect(addBusinessMinutes(kolkata, new Date('2026-09-21T11:00:00Z'), 60)?.toISOString()).toBe(
      '2026-09-22T04:00:00.000Z',
    );
    // Friday 16:30 + 60 = Monday 09:30.
    expect(addBusinessMinutes(kolkata, new Date('2026-09-25T11:00:00Z'), 60)?.toISOString()).toBe(
      '2026-09-28T04:00:00.000Z',
    );
    // Monday 07:00, before opening: the clock starts at 09:00.
    expect(addBusinessMinutes(kolkata, new Date('2026-09-21T01:30:00Z'), 30)?.toISOString()).toBe(
      '2026-09-21T04:00:00.000Z',
    );
    // Tuesday is a closed day: Monday 16:30 + 60 = Wednesday 09:30.
    const holiday = calendar('Asia/Kolkata', weekdays(9 * 60, 17 * 60), ['2026-09-22']);
    expect(addBusinessMinutes(holiday, new Date('2026-09-21T11:00:00Z'), 60)?.toISOString()).toBe(
      '2026-09-23T04:00:00.000Z',
    );
    // Inside opening hours it is plain addition.
    expect(addBusinessMinutes(kolkata, new Date('2026-09-21T05:00:00Z'), 45)?.toISOString()).toBe(
      '2026-09-21T05:45:00.000Z',
    );
  });

  it('measures business time between two instants', () => {
    // Friday 16:00 to Monday 10:00 local: 1 hour on Friday and 1 hour on Monday.
    expect(
      businessMsBetween(
        kolkata,
        new Date('2026-09-25T10:30:00Z'),
        new Date('2026-09-28T04:30:00Z'),
      ),
    ).toBe(2 * H);
    expect(
      businessMsBetween(
        kolkata,
        new Date('2026-09-26T05:00:00Z'),
        new Date('2026-09-26T09:00:00Z'),
      ),
    ).toBe(0);
  });

  it('counts 23- and 25-hour days when clocks change', () => {
    const allDay = calendar(
      'America/New_York',
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, opens: 0, closes: 1440 })),
    );
    // 2026-03-08: clocks go forward at 02:00 (EST -05:00 to EDT -04:00).
    expect(
      businessMsBetween(allDay, new Date('2026-03-08T05:00:00Z'), new Date('2026-03-09T04:00:00Z')),
    ).toBe(23 * H);
    // 2026-11-01: clocks go back at 02:00 (EDT to EST).
    expect(
      businessMsBetween(allDay, new Date('2026-11-01T04:00:00Z'), new Date('2026-11-02T05:00:00Z')),
    ).toBe(25 * H);
    // An interval across the skipped hour (01:00-03:00 local) lasts one real hour.
    const sunday = calendar('America/New_York', [{ weekday: 7, opens: 60, closes: 180 }]);
    const periods = openPeriods(
      sunday,
      new Date('2026-03-08T00:00:00Z'),
      new Date('2026-03-09T00:00:00Z'),
    );
    expect(periods.map((p) => [p.start.toISOString(), p.end.toISOString()])).toEqual([
      ['2026-03-08T06:00:00.000Z', '2026-03-08T07:00:00.000Z'],
    ]);
  });

  it('knows whether the business is open and when it opens next', () => {
    expect(businessStatusAt(kolkata, new Date('2026-09-21T05:00:00Z'))).toEqual({ open: true });
    // Opening time is open; closing time is closed.
    expect(businessStatusAt(kolkata, new Date('2026-09-21T03:30:00Z'))).toEqual({ open: true });
    expect(businessStatusAt(kolkata, new Date('2026-09-21T11:30:00Z'))).toEqual({
      open: false,
      opensAt: new Date('2026-09-22T03:30:00Z'),
    });
    expect(businessStatusAt(calendar('Asia/Kolkata', []), new Date())).toEqual({
      open: false,
      opensAt: null,
    });
    expect(addBusinessMinutes(calendar('Asia/Kolkata', []), new Date(), 5)).toBeNull();
  });

  it('pauses reply timers outside business hours', () => {
    const target = { minutes: 30, calendar: kolkata };
    // Turn started Monday 16:50 local; at 18:00 local the reply is due Tuesday 09:20 and paused.
    const timer = replyTimer(
      target,
      new Date('2026-09-21T11:20:00Z'),
      new Date('2026-09-21T12:30:00Z'),
    );
    expect(timer.dueAt?.toISOString()).toBe('2026-09-22T03:50:00.000Z');
    expect(timer.overdue).toBe(false);
    expect(timer.pausedUntil?.toISOString()).toBe('2026-09-22T03:30:00.000Z');
    // Without business hours the target is absolute time.
    const absolute = replyTimer(
      { minutes: 30, calendar: null },
      new Date('2026-09-21T11:20:00Z'),
      new Date('2026-09-21T12:30:00Z'),
    );
    expect(absolute.dueAt?.toISOString()).toBe('2026-09-21T11:50:00.000Z');
    expect(absolute.overdue).toBe(true);
    expect(absolute.pausedUntil).toBeNull();
    expect(replyTimer({ minutes: null, calendar: null }, new Date(), new Date()).dueAt).toBeNull();
  });

  it('parses opening times written as ranges', () => {
    expect(parseDayRanges('09:00-13:00, 14:00 – 18:30')).toEqual({
      ok: true,
      ranges: [
        { opens: 540, closes: 780 },
        { opens: 840, closes: 1110 },
      ],
    });
    expect(parseDayRanges('')).toEqual({ ok: true, ranges: [] });
    expect(parseDayRanges('22:00-24:00')).toEqual({
      ok: true,
      ranges: [{ opens: 1320, closes: 1440 }],
    });
    expect(parseDayRanges('09:00-12:00, 11:00-13:00')).toMatchObject({
      ok: false,
      message: /overlap/,
    });
    expect(parseDayRanges('18:00-09:00')).toMatchObject({
      ok: false,
      message: /end after it starts/,
    });
    expect(parseDayRanges('9am-5pm')).toMatchObject({ ok: false, message: /09:00-17:30/ });
    expect(parseDayRanges('24:00-24:00')).toMatchObject({ ok: false });
    expect(parseDayRanges('1:00-2:00,3:00-4:00,5:00-6:00,7:00-8:00,9:00-10:00')).toMatchObject({
      ok: false,
      message: /at most 4/,
    });
  });
});

describe('routing helpers', () => {
  it('matches keywords as whole words, ignoring case and punctuation', () => {
    expect(normalizeRoutingText('  Refund,  PLEASE!! ')).toBe('refund please');
    expect(matchesKeyword('I want a REFUND.', 'refund')).toBe(true);
    expect(matchesKeyword('Refunded already', 'refund')).toBe(false);
    expect(matchesKeyword('where is my order status?', 'order status')).toBe(true);
    expect(matchesKeyword('ऑर्डर कहाँ है', 'ऑर्डर')).toBe(true);
    expect(matchesKeyword('anything', '  ')).toBe(false);
  });

  it('rotates to the next eligible member after the last one', () => {
    const order = ['a', 'b', 'c', 'd'];
    expect(nextInRotation(order, new Set(['a', 'b', 'c', 'd']), null)).toBe('a');
    expect(nextInRotation(order, new Set(['a', 'b', 'c', 'd']), 'b')).toBe('c');
    expect(nextInRotation(order, new Set(['a', 'b', 'c', 'd']), 'd')).toBe('a');
    // Unavailable or full members are skipped; the position is kept.
    expect(nextInRotation(order, new Set(['a', 'd']), 'b')).toBe('d');
    // The last member left the team: start from the beginning.
    expect(nextInRotation(order, new Set(['b', 'c']), 'x')).toBe('b');
    expect(nextInRotation(order, new Set(), 'a')).toBeNull();
    expect(nextInRotation([], new Set(['a']), null)).toBeNull();
  });
});
