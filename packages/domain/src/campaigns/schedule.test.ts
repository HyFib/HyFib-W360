import { describe, expect, it } from 'vitest';
import {
  isValidTimeZone,
  parseLocalDateTime,
  parseTimeOfDay,
  resolveLocalTime,
  sendingWindow,
  zonedParts,
} from './schedule';

const at = (iso: string) => new Date(iso).getTime();

describe('parseLocalDateTime', () => {
  it('accepts datetime-local values and rejects impossible dates', () => {
    expect(parseLocalDateTime('2026-10-02T09:30')).toEqual({
      year: 2026,
      month: 10,
      day: 2,
      hour: 9,
      minute: 30,
    });
    expect(parseLocalDateTime('2026-10-02 09:30:00')).not.toBeNull();
    expect(parseLocalDateTime('2026-02-29T09:30')).toBeNull();
    expect(parseLocalDateTime('2026-04-31T09:30')).toBeNull();
    expect(parseLocalDateTime('2026-10-02T24:00')).toBeNull();
    expect(parseLocalDateTime('tomorrow')).toBeNull();
  });

  it('parses times of day', () => {
    expect(parseTimeOfDay('09:00')).toBe(540);
    expect(parseTimeOfDay('21:30:00')).toBe(1290);
    expect(parseTimeOfDay('25:00')).toBeNull();
  });
});

describe('resolveLocalTime', () => {
  it('resolves a time zone without daylight saving', () => {
    const r = resolveLocalTime(parseLocalDateTime('2026-10-02T09:30')!, 'Asia/Kolkata');
    expect(r.instant.toISOString()).toBe('2026-10-02T04:00:00.000Z');
    expect(r.adjustment).toBeNull();
  });

  it('moves a time inside the spring-forward gap forward by the jump', () => {
    // New York skips 02:00–03:00 on 2026-03-08; 02:30 EST would be 07:30Z, shown as 03:30 EDT.
    const r = resolveLocalTime(parseLocalDateTime('2026-03-08T02:30')!, 'America/New_York');
    expect(r.adjustment).toBe('gap_shifted');
    expect(r.instant.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(zonedParts(r.instant.getTime(), 'America/New_York')).toMatchObject({
      hour: 3,
      minute: 30,
    });
  });

  it('uses the first occurrence of a time repeated when clocks fall back', () => {
    // New York repeats 01:00–02:00 on 2026-11-01: 01:30 EDT (05:30Z) and 01:30 EST (06:30Z).
    const r = resolveLocalTime(parseLocalDateTime('2026-11-01T01:30')!, 'America/New_York');
    expect(r.adjustment).toBe('ambiguous_earlier');
    expect(r.instant.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('handles European transitions', () => {
    const gap = resolveLocalTime(parseLocalDateTime('2026-03-29T01:30')!, 'Europe/London');
    expect(gap.adjustment).toBe('gap_shifted');
    expect(gap.instant.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    const overlap = resolveLocalTime(parseLocalDateTime('2026-10-25T01:30')!, 'Europe/London');
    expect(overlap.adjustment).toBe('ambiguous_earlier');
    expect(overlap.instant.toISOString()).toBe('2026-10-25T00:30:00.000Z');
    const summer = resolveLocalTime(parseLocalDateTime('2026-07-01T09:00')!, 'Europe/London');
    expect(summer.instant.toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(summer.adjustment).toBeNull();
  });

  it('knows valid zones', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('sendingWindow', () => {
  const nine = 9 * 60;
  const six = 18 * 60;

  it('is open inside the window and says when it opens otherwise', () => {
    expect(sendingWindow(at('2026-10-02T06:00:00Z'), 'Asia/Kolkata', nine, six)).toEqual({
      open: true,
    });
    // 07:00 local, before the window: opens at 09:00 local the same day.
    const early = sendingWindow(at('2026-10-02T01:30:00Z'), 'Asia/Kolkata', nine, six);
    expect(early).toEqual({ open: false, opensAt: new Date('2026-10-02T03:30:00Z') });
    // 20:00 local, after the window: opens at 09:00 local the next day.
    const late = sendingWindow(at('2026-10-02T14:30:00Z'), 'Asia/Kolkata', nine, six);
    expect(late).toEqual({ open: false, opensAt: new Date('2026-10-03T03:30:00Z') });
  });

  it('supports windows that wrap past midnight', () => {
    const night = sendingWindow(at('2026-10-02T17:00:00Z'), 'UTC', 22 * 60, 6 * 60);
    expect(night).toEqual({ open: false, opensAt: new Date('2026-10-02T22:00:00Z') });
    expect(sendingWindow(at('2026-10-02T23:00:00Z'), 'UTC', 22 * 60, 6 * 60)).toEqual({
      open: true,
    });
    expect(sendingWindow(at('2026-10-03T05:59:00Z'), 'UTC', 22 * 60, 6 * 60)).toEqual({
      open: true,
    });
  });

  it('opens at the shifted time when the start falls into a daylight-saving gap', () => {
    // A window starting 02:30 on the New York spring-forward night opens at 03:30 EDT.
    const w = sendingWindow(at('2026-03-08T05:00:00Z'), 'America/New_York', 150, 600);
    expect(w).toEqual({ open: false, opensAt: new Date('2026-03-08T07:30:00Z') });
  });
});
