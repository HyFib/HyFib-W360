import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { dayOf, resolvePeriod } from './period';
import { microsToDecimal } from './service';

const H = 3_600_000;

function expectInvalid(fn: () => unknown, message: RegExp) {
  try {
    fn();
  } catch (error) {
    expect(isAppError(error) && error.code).toBe('validation_failed');
    expect(isAppError(error) && error.publicMessage).toMatch(message);
    return;
  }
  throw new Error('expected a validation error');
}

describe('report periods', () => {
  const now = new Date('2026-09-26T10:00:00Z');

  it('resolves presets to whole days in the company time zone', () => {
    const week = resolvePeriod({ preset: 'last_7_days' }, 'Asia/Kolkata', now);
    expect([week.from, week.to]).toEqual(['2026-09-20', '2026-09-26']);
    expect(week.start.toISOString()).toBe('2026-09-19T18:30:00.000Z');
    expect(week.end.toISOString()).toBe('2026-09-26T18:30:00.000Z');
    expect(week.days).toHaveLength(7);
    expect(week.inProgress).toBe(true);

    const month = resolvePeriod({ preset: 'this_month' }, 'Asia/Kolkata', now);
    expect([month.from, month.to]).toEqual(['2026-09-01', '2026-09-26']);
    const last = resolvePeriod({ preset: 'last_month' }, 'Asia/Kolkata', now);
    expect([last.from, last.to, last.inProgress]).toEqual(['2026-08-01', '2026-08-31', false]);
    const thirty = resolvePeriod({ preset: 'last_30_days' }, 'Asia/Kolkata', now);
    expect([thirty.from, thirty.to]).toEqual(['2026-08-28', '2026-09-26']);
    // Defaults to the last seven days.
    expect(resolvePeriod(undefined, 'Asia/Kolkata', now).preset).toBe('last_7_days');
  });

  it('uses the company’s date, not the server’s', () => {
    // 20:00 UTC on 30 September is already 1 October in Kolkata.
    const late = new Date('2026-09-30T20:00:00Z');
    const month = resolvePeriod({ preset: 'this_month' }, 'Asia/Kolkata', late);
    expect([month.from, month.to]).toEqual(['2026-10-01', '2026-10-01']);
    const last = resolvePeriod({ preset: 'last_month' }, 'Asia/Kolkata', late);
    expect([last.from, last.to]).toEqual(['2026-09-01', '2026-09-30']);
    expect(resolvePeriod({ preset: 'this_month' }, 'UTC', late).from).toBe('2026-09-01');
  });

  it('gives daylight-saving days their real length', () => {
    const at = new Date('2026-12-01T12:00:00Z');
    const spring = resolvePeriod(
      { preset: 'custom', from: '2026-03-08', to: '2026-03-08' },
      'America/New_York',
      at,
    );
    expect(spring.start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * H);
    const autumn = resolvePeriod(
      { preset: 'custom', from: '2026-11-01', to: '2026-11-01' },
      'America/New_York',
      at,
    );
    expect(autumn.start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(autumn.end.getTime() - autumn.start.getTime()).toBe(25 * H);
  });

  it('starts a day whose midnight is skipped at its first real instant', () => {
    // Chile moves its clocks forward at midnight at the start of September.
    const at = new Date('2026-12-01T12:00:00Z');
    const tz = 'America/Santiago';
    for (let day = 1; day <= 12; day += 1) {
      const d = `2026-09-${String(day).padStart(2, '0')}`;
      const p = resolvePeriod({ preset: 'custom', from: d, to: d }, tz, at);
      expect(dayOf(p.start, tz)).toBe(d);
      expect(dayOf(new Date(p.start.getTime() - 1), tz)).not.toBe(d);
      expect(dayOf(new Date(p.end.getTime() - 1), tz)).toBe(d);
      expect(dayOf(p.end, tz)).not.toBe(d);
    }
  });

  it('refuses invalid, reversed, future and overlong custom periods', () => {
    const tz = 'Asia/Kolkata';
    expectInvalid(() => resolvePeriod({ preset: 'custom' }, tz, now), /start and an end/);
    expectInvalid(
      () => resolvePeriod({ preset: 'custom', from: '2026-02-30', to: '2026-03-01' }, tz, now),
      /start and an end/,
    );
    expectInvalid(
      () => resolvePeriod({ preset: 'custom', from: '2026-09-10', to: '2026-09-01' }, tz, now),
      /must not be after/,
    );
    expectInvalid(
      () => resolvePeriod({ preset: 'custom', from: '2026-09-20', to: '2026-09-27' }, tz, now),
      /cannot end after today/,
    );
    expectInvalid(
      () => resolvePeriod({ preset: 'custom', from: '2026-06-01', to: '2026-09-26' }, tz, now),
      /at most 92 days/,
    );
    expectInvalid(() => resolvePeriod({ preset: 'yesterday' }, tz, now), /./);
    const max = resolvePeriod({ preset: 'custom', from: '2026-06-27', to: '2026-09-26' }, tz, now);
    expect(max.days).toHaveLength(92);
  });
});

describe('export amounts', () => {
  it('formats micros as exact decimals in the currency’s minor unit', () => {
    expect(microsToDecimal(150000, 'SGD')).toBe('0.15');
    expect(microsToDecimal(1_234_565_000, 'INR')).toBe('1234.57');
    expect(microsToDecimal(1_500_000, 'JPY')).toBe('2');
    expect(microsToDecimal(0, 'USD')).toBe('0.00');
    expect(microsToDecimal(1_234_500, 'KWD')).toBe('1.235');
  });
});
