/**
 * Closed days in Settings → Teams (ADR-392), shown the same way by the server page and the browser
 * editor: fixed English month abbreviations, never `Intl`, whose date text differs between engines
 * (and would make server and browser text differ at hydration).
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A closed day, YYYY-MM-DD, as "1 Jan 2030"; anything else as it is. */
export function formatClosedDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !month) return day;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

/**
 * The days a team's own list starts from: the company's closed days from `today` (YYYY-MM-DD in the
 * company's time zone) on, in order. Past days no longer matter to any timer.
 */
export function upcomingClosedDays(days: readonly string[], today: string): string[] {
  return [...new Set(days.filter((day) => day >= today))].sort();
}

/**
 * The list a team is saved with: its days, plus a valid date picked in "Add a closed day" and not
 * yet added, once each and in order.
 */
export function withPendingClosedDay(days: readonly string[], pending: string): string[] {
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(pending) ? [pending] : [];
  return [...new Set([...days, ...valid])].sort();
}
