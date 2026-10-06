import { resolveLocalTime, zonedParts } from '../campaigns/schedule';

/**
 * The end of the local calendar day containing `at` in `timeZone`: the first instant of the next
 * local day. When that midnight falls in a daylight-saving gap, it is the first instant after it.
 */
export function endOfLocalDay(at: Date, timeZone: string): Date {
  const today = zonedParts(at.getTime(), timeZone);
  // Calendar arithmetic in UTC, which has no daylight saving, gives the next local date.
  const next = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  return resolveLocalTime(
    {
      year: next.getUTCFullYear(),
      month: next.getUTCMonth() + 1,
      day: next.getUTCDate(),
      hour: 0,
      minute: 0,
    },
    timeZone,
  ).instant;
}

/** The last day of the local calendar month containing `at` in `timeZone`, as YYYY-MM-DD. */
export function monthEndIn(at: Date, timeZone: string): string {
  const today = zonedParts(at.getTime(), timeZone);
  // Day 0 of the next month is the last day of this one (UTC has no daylight saving).
  const last = new Date(Date.UTC(today.year, today.month, 0)).getUTCDate();
  return `${today.year}-${String(today.month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}
