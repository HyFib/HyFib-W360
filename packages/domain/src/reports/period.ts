import { AppError } from '@w360/core';
import { z } from 'zod';
import { resolveLocalTime, zonedParts } from '../campaigns/schedule';
import { parseInput } from '../validation';

/**
 * Report periods are whole calendar days in the company's time zone. A period starts at local
 * midnight of its first day and ends at local midnight after its last day; when midnight does not
 * exist or happens twice because of a daylight-saving change, the day starts at its first real
 * instant (see campaigns/schedule). Pure functions: callers pass `now`.
 */
export const PERIOD_PRESETS = ['last_7_days', 'last_30_days', 'this_month', 'last_month'] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];
export const MAX_PERIOD_DAYS = 92;

export interface ReportPeriod {
  preset: PeriodPreset | 'custom';
  timezone: string;
  /** First day, YYYY-MM-DD. */
  from: string;
  /** Last day (inclusive), YYYY-MM-DD. */
  to: string;
  start: Date;
  /** Exclusive end. */
  end: Date;
  days: string[];
  /** True while the period has not ended yet (it includes today). */
  inProgress: boolean;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const periodInputSchema = z.object({
  preset: z.enum([...PERIOD_PRESETS, 'custom']).default('last_7_days'),
  from: z.string().regex(DAY_RE, 'Enter dates as YYYY-MM-DD.').optional(),
  to: z.string().regex(DAY_RE, 'Enter dates as YYYY-MM-DD.').optional(),
});
export type PeriodInput = z.input<typeof periodInputSchema>;

interface Day {
  year: number;
  month: number;
  day: number;
}

function parseDay(value: string): Day | null {
  if (!DAY_RE.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1) return null;
  if (probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function formatDay(d: Day): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.year, 4)}-${p(d.month)}-${p(d.day)}`;
}

function addDays(d: Day, days: number): Day {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

function dayNumber(d: Day): number {
  return Date.UTC(d.year, d.month - 1, d.day) / 86_400_000;
}

function midnight(d: Day, timezone: string): Date {
  return resolveLocalTime(
    { year: d.year, month: d.month, day: d.day, hour: 0, minute: 0 },
    timezone,
  ).instant;
}

/** The calendar day (company time zone) of `instant`, as YYYY-MM-DD. */
export function dayOf(instant: Date, timezone: string): string {
  const p = zonedParts(instant.getTime(), timezone);
  return formatDay({ year: p.year, month: p.month, day: p.day });
}

export function resolvePeriod(input: unknown, timezone: string, now: Date): ReportPeriod {
  const data = parseInput(periodInputSchema, input ?? {});
  const clock = zonedParts(now.getTime(), timezone);
  const today: Day = { year: clock.year, month: clock.month, day: clock.day };
  let first: Day;
  let last: Day;
  switch (data.preset) {
    case 'last_7_days':
      first = addDays(today, -6);
      last = today;
      break;
    case 'last_30_days':
      first = addDays(today, -29);
      last = today;
      break;
    case 'this_month':
      first = { ...today, day: 1 };
      last = today;
      break;
    case 'last_month': {
      last = addDays({ ...today, day: 1 }, -1);
      first = { ...last, day: 1 };
      break;
    }
    case 'custom': {
      const from = data.from ? parseDay(data.from) : null;
      const to = data.to ? parseDay(data.to) : null;
      if (!from || !to) throw new AppError('validation_failed', 'Choose a start and an end date.');
      if (dayNumber(from) > dayNumber(to))
        throw new AppError('validation_failed', 'The start date must not be after the end date.');
      if (dayNumber(to) > dayNumber(today))
        throw new AppError('validation_failed', 'The period cannot end after today.');
      first = from;
      last = to;
      break;
    }
  }
  const length = dayNumber(last) - dayNumber(first) + 1;
  if (length > MAX_PERIOD_DAYS) {
    throw new AppError(
      'validation_failed',
      `Choose a period of at most ${MAX_PERIOD_DAYS} days; export several periods for longer ranges.`,
    );
  }
  const days: string[] = [];
  for (let i = 0; i < length; i += 1) days.push(formatDay(addDays(first, i)));
  const end = midnight(addDays(last, 1), timezone);
  return {
    preset: data.preset,
    timezone,
    from: formatDay(first),
    to: formatDay(last),
    start: midnight(first, timezone),
    end,
    days,
    inProgress: end.getTime() > now.getTime(),
  };
}
