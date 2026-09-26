/** Formats timestamps in the company's time zone (server and client safe). */
export function formatDateTime(iso: string | null, timeZone: string, locale = 'en-IN'): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

/** Short form for lists: time for today, date otherwise. */
export function formatShort(
  iso: string | null,
  timeZone: string,
  now = new Date(),
  locale = 'en-IN',
): string {
  if (!iso) return '';
  const date = new Date(iso);
  const day = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(d);
  return day(date) === day(now)
    ? new Intl.DateTimeFormat(locale, { timeZone, timeStyle: 'short' }).format(date)
    : new Intl.DateTimeFormat(locale, { timeZone, day: 'numeric', month: 'short' }).format(date);
}

/** A moment for timers: the time if it is today in the company's time zone, else day and time. */
export function formatWhen(
  iso: string | null,
  timeZone: string,
  now = new Date(),
  locale = 'en-IN',
): string {
  if (!iso) return '';
  const date = new Date(iso);
  const day = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(d);
  return day(date) === day(now)
    ? new Intl.DateTimeFormat(locale, { timeZone, timeStyle: 'short' }).format(date)
    : new Intl.DateTimeFormat(locale, {
        timeZone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      }).format(date);
}
