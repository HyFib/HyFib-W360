import { describe, expect, it } from 'vitest';
import { formatClosedDay, upcomingClosedDays, withPendingClosedDay } from './closed-days';

describe('closed days in Settings → Teams (ADR-392)', () => {
  it('are written with fixed English month abbreviations, the same on the server and in browsers', () => {
    expect(formatClosedDay('2030-01-01')).toBe('1 Jan 2030');
    expect(formatClosedDay('2026-12-25')).toBe('25 Dec 2026');
    expect(formatClosedDay('2026-05-09')).toBe('9 May 2026');
    expect(formatClosedDay('2026-13-01')).toBe('2026-13-01');
    expect(formatClosedDay('2026-00-01')).toBe('2026-00-01');
    expect(formatClosedDay('soon')).toBe('soon');
  });

  it('start a team’s own list from the company’s days from today on', () => {
    expect(
      upcomingClosedDays(
        ['2026-12-25', '2025-01-26', '2026-10-16', '2026-10-15', '2026-12-25'],
        '2026-10-16',
      ),
    ).toEqual(['2026-10-16', '2026-12-25']);
    expect(upcomingClosedDays([], '2026-10-16')).toEqual([]);
  });

  it('keep a date picked but not yet added when the team is saved', () => {
    expect(withPendingClosedDay(['2026-12-25'], '2026-11-08')).toEqual([
      '2026-11-08',
      '2026-12-25',
    ]);
    expect(withPendingClosedDay(['2026-12-25'], '2026-12-25')).toEqual(['2026-12-25']);
    expect(withPendingClosedDay(['2026-12-25'], '')).toEqual(['2026-12-25']);
    expect(withPendingClosedDay(['2026-12-25'], '2026-1-8')).toEqual(['2026-12-25']);
  });
});
