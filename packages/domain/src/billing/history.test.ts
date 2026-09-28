import { describe, expect, it } from 'vitest';
import {
  addMonths,
  compareMonths,
  formatMonth,
  monthBounds,
  monthLabel,
  monthOf,
  parseMonth,
  paymentMethodLabel,
} from './history';

describe('statement months', () => {
  it('parses only real YYYY-MM months', () => {
    expect(parseMonth('2026-09')).toEqual({ year: 2026, month: 9 });
    expect(parseMonth('2026-12')).toEqual({ year: 2026, month: 12 });
    for (const bad of [
      '2026-13',
      '2026-00',
      '2026-9',
      '26-09',
      '2026-09-01',
      '1999-12',
      ' 2026-09',
    ]) {
      expect(parseMonth(bad)).toBeNull();
    }
  });

  it('formats, labels, orders and steps across years', () => {
    expect(formatMonth({ year: 2026, month: 3 })).toBe('2026-03');
    expect(monthLabel({ year: 2026, month: 9 })).toBe('September 2026');
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths({ year: 2026, month: 5 }, -17)).toEqual({ year: 2024, month: 12 });
    expect(compareMonths({ year: 2026, month: 1 }, { year: 2025, month: 12 })).toBeGreaterThan(0);
    expect(compareMonths({ year: 2026, month: 9 }, { year: 2026, month: 9 })).toBe(0);
  });

  it('puts an instant in the month of the company time zone', () => {
    const lateUtc = new Date('2026-09-30T20:00:00Z');
    expect(monthOf(lateUtc, 'UTC')).toEqual({ year: 2026, month: 9 });
    expect(monthOf(lateUtc, 'Asia/Kolkata')).toEqual({ year: 2026, month: 10 });
    expect(monthOf(new Date('2026-10-01T03:00:00Z'), 'America/New_York')).toEqual({
      year: 2026,
      month: 9,
    });
  });

  it('bounds a month from local midnight to local midnight', () => {
    expect(monthBounds({ year: 2026, month: 9 }, 'Asia/Kolkata')).toEqual({
      start: new Date('2026-08-31T18:30:00Z'),
      end: new Date('2026-09-30T18:30:00Z'),
    });
    // London moves to summer time during March: the month ends an hour earlier in UTC.
    expect(monthBounds({ year: 2026, month: 3 }, 'Europe/London')).toEqual({
      start: new Date('2026-03-01T00:00:00Z'),
      end: new Date('2026-03-31T23:00:00Z'),
    });
    expect(monthBounds({ year: 2026, month: 12 }, 'UTC').end).toEqual(
      new Date('2027-01-01T00:00:00Z'),
    );
  });

  it('starts at the first real instant when daylight saving removes or doubles midnight', () => {
    // Paraguay began summer time at midnight on 1 October 2023: 00:00 became 01:00.
    const gap = monthBounds({ year: 2023, month: 10 }, 'America/Asuncion');
    expect(gap.start).toEqual(new Date('2023-10-01T04:00:00Z'));
    expect(monthBounds({ year: 2023, month: 9 }, 'America/Asuncion').end).toEqual(gap.start);
    // Cuba ends summer time at 01:00 on 1 November 2026, back to 00:00: midnight happens twice
    // and the month starts at the first one.
    expect(monthBounds({ year: 2026, month: 11 }, 'America/Havana').start).toEqual(
      new Date('2026-11-01T04:00:00Z'),
    );
  });

  it('labels Razorpay payment methods and keeps unknown ones as reported', () => {
    expect(paymentMethodLabel('upi')).toBe('UPI');
    expect(paymentMethodLabel('netbanking')).toBe('Net banking');
    expect(paymentMethodLabel('card')).toBe('Card');
    expect(paymentMethodLabel('paylater')).toBe('paylater');
    expect(paymentMethodLabel(null)).toBeNull();
  });
});
