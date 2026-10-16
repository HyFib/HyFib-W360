/** Display helpers for reports (server and client safe): the Reports page and report emails. */

/** A duration in seconds as "45 s", "12 min", "3 h 5 min" or "2 d 4 h". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} d ${restHours} h` : `${days} d`;
}

/** A calendar day ('YYYY-MM-DD', already in the company's time zone) as "Sat 26 Sep". */
export function formatDay(day: string, locale = 'en-IN'): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** A calendar month ('YYYY-MM', already in the company's time zone) as "October 2026". */
export function formatMonth(month: string, locale = 'en-IN'): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** A calendar day with the year, for period headings. */
export function formatDayLong(day: string, locale = 'en-IN'): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

export function formatCount(n: number, locale = 'en-IN'): string {
  return new Intl.NumberFormat(locale).format(n);
}

/** A share as "62.5%" (one decimal), or "—" when there is nothing to divide by. */
export function formatPercent(numerator: number, denominator: number): string {
  if (denominator === 0) return '—';
  return `${Math.round((numerator / denominator) * 1000) / 10}%`;
}
