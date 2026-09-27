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
