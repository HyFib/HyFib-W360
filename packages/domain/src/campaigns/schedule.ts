/**
 * Wall-clock scheduling in IANA time zones, using the time zone data that ships with Node (ICU).
 *
 * Daylight-saving rules (documented in docs/ARCHITECTURE.md §6B):
 * - a wall-clock time that does not exist (the clocks jump forward over it) is moved forward by the
 *   length of the jump, so 02:30 on a night that skips 02:00–03:00 becomes 03:30;
 * - a wall-clock time that happens twice (the clocks fall back) means its first occurrence.
 * The adjustment is recorded with the campaign and shown to the member.
 *
 * Pure functions: no database or clock access (callers pass instants).
 */

export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export type ScheduleAdjustment = 'gap_shifted' | 'ambiguous_earlier';

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::00)?$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/;

/** Parses 'YYYY-MM-DDTHH:MM' (or with a space, optionally ':00' seconds); null when invalid. */
export function parseLocalDateTime(value: string): LocalDateTime | null {
  const m = LOCAL_RE.exec(value.trim());
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return null;
  // Rejects 31 April and 29 February outside leap years.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day, hour, minute };
}

/** Minutes after midnight for 'HH:MM' (or 'HH:MM:00'); null when invalid. */
export function parseTimeOfDay(value: string): number | null {
  const m = TIME_RE.exec(value.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function formatTimeOfDay(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatLocalDateTime(local: LocalDateTime): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(local.year, 4)}-${p(local.month)}-${p(local.day)}T${p(local.hour)}:${p(local.minute)}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True for a time zone name Node's ICU data knows (for example 'Asia/Kolkata' or 'UTC'). */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts extends LocalDateTime {
  second: number;
}

/** The wall-clock reading in `timeZone` at `instant` (ms since the epoch). */
export function zonedParts(instant: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function wallClockAsUtc(p: LocalDateTime & { second?: number }): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second ?? 0);
}

/** UTC offset of `timeZone` at `instant`, in milliseconds (east of Greenwich is positive). */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  const wholeSecond = Math.floor(instant / 1000) * 1000;
  return wallClockAsUtc(zonedParts(wholeSecond, timeZone)) - wholeSecond;
}

const DAY_MS = 86_400_000;

/**
 * The instant at which the clocks in `timeZone` show `local`, applying the daylight-saving rules
 * above. Assumes at most one offset change within a day of `local`, which holds for real zones.
 */
export function resolveLocalTime(
  local: LocalDateTime,
  timeZone: string,
): { instant: Date; adjustment: ScheduleAdjustment | null } {
  const asUtc = wallClockAsUtc(local);
  const before = zoneOffsetMs(asUtc - DAY_MS, timeZone);
  const after = zoneOffsetMs(asUtc + DAY_MS, timeZone);
  const candidates = [...new Set([asUtc - before, asUtc - after])].filter(
    (instant) => zoneOffsetMs(instant, timeZone) === asUtc - instant,
  );
  if (candidates.length === 0) {
    // In a gap: read the time with the offset in force before the jump, which lands after it.
    return { instant: new Date(asUtc - before), adjustment: 'gap_shifted' };
  }
  if (candidates.length > 1) {
    return { instant: new Date(Math.min(...candidates)), adjustment: 'ambiguous_earlier' };
  }
  return { instant: new Date(candidates[0] as number), adjustment: null };
}

function addDays(local: LocalDateTime, days: number): LocalDateTime {
  const d = new Date(Date.UTC(local.year, local.month - 1, local.day + days));
  return { ...local, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Daily sending window in `timeZone` from `start` to `end` minutes after midnight (end before
 * start wraps past midnight). Returns whether `instant` is inside it and, if not, when it opens.
 */
export function sendingWindow(
  instant: number,
  timeZone: string,
  start: number,
  end: number,
): { open: true } | { open: false; opensAt: Date } {
  const now = zonedParts(instant, timeZone);
  const minute = now.hour * 60 + now.minute;
  const inside = start < end ? minute >= start && minute < end : minute >= start || minute < end;
  if (inside) return { open: true };
  const today: LocalDateTime = {
    year: now.year,
    month: now.month,
    day: now.day,
    hour: Math.floor(start / 60),
    minute: start % 60,
  };
  // Closed and before today's start: it opens today; otherwise tomorrow.
  const opensToday = minute < start;
  const target = opensToday ? today : addDays(today, 1);
  let opensAt = resolveLocalTime(target, timeZone).instant;
  // A start time moved by a daylight-saving jump can land at or before `instant`; use the next day.
  if (opensAt.getTime() <= instant)
    opensAt = resolveLocalTime(addDays(target, 1), timeZone).instant;
  return { open: false, opensAt };
}

/** Formats an instant as a wall-clock reading in `timeZone`, for messages and the UI. */
export function describeInstant(instant: Date, timeZone: string): string {
  const p = zonedParts(instant.getTime(), timeZone);
  return `${formatLocalDateTime(p)} (${timeZone})`;
}
