import { describe, expect, it } from 'vitest';
import { endOfLocalDay } from './time';

describe('endOfLocalDay', () => {
  it('returns the next local midnight', () => {
    // 2026-09-27 14:00 in Kolkata (UTC+05:30) ends at 2026-09-28 00:00 local.
    expect(endOfLocalDay(new Date('2026-09-27T08:30:00Z'), 'Asia/Kolkata').toISOString()).toBe(
      '2026-09-27T18:30:00.000Z',
    );
    // Just after local midnight belongs to the new day.
    expect(endOfLocalDay(new Date('2026-09-27T18:30:00Z'), 'Asia/Kolkata').toISOString()).toBe(
      '2026-09-28T18:30:00.000Z',
    );
  });

  it('follows daylight saving changes', () => {
    // New York moves from EDT (UTC-4) to EST (UTC-5) on 2026-11-01: that day has 25 hours.
    expect(endOfLocalDay(new Date('2026-11-01T12:00:00Z'), 'America/New_York').toISOString()).toBe(
      '2026-11-02T05:00:00.000Z',
    );
    // And from EST to EDT on 2026-03-08: that day has 23 hours.
    expect(endOfLocalDay(new Date('2026-03-08T12:00:00Z'), 'America/New_York').toISOString()).toBe(
      '2026-03-09T04:00:00.000Z',
    );
  });

  it('crosses month and year ends', () => {
    expect(endOfLocalDay(new Date('2026-12-31T20:00:00Z'), 'UTC').toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    expect(endOfLocalDay(new Date('2028-02-28T10:00:00Z'), 'UTC').toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });
});
