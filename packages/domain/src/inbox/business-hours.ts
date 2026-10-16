import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  businessHolidays,
  businessHours,
  eq,
  inArray,
  isUniqueViolation,
  messagingSettings,
  slowReplyMessages,
  overdueReplyNotices,
  sql,
  teamBusinessHours,
  type Database,
  type Tx,
} from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
import { recordAudit, type RequestMeta } from '../audit';
import { resolveLocalTime, zonedParts } from '../campaigns/schedule';
import { DEFAULT_MESSAGING_SETTINGS } from '../consent/service';
import { parseInput } from '../validation';

/**
 * Business hours: weekly opening intervals and closed days in the company's time zone. The pure
 * functions below turn them into real instants (applying daylight-saving changes through
 * resolveLocalTime: a local time skipped by a change moves to the first real instant after it, a
 * repeated one uses its first occurrence) and do the arithmetic reply-due timers and reports need.
 */
export interface BusinessInterval {
  /** ISO weekday, 1 = Monday. */
  weekday: number;
  /** Minutes after local midnight. */
  opens: number;
  /** Minutes after local midnight, up to 1440 (midnight at the end of the day). */
  closes: number;
}

export interface BusinessCalendar {
  timezone: string;
  intervals: readonly BusinessInterval[];
  /** Closed days, YYYY-MM-DD in the company's time zone. */
  closedDays: ReadonlySet<string>;
}

export interface OpenPeriod {
  start: Date;
  end: Date;
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** How far ahead a due time is searched for; a calendar open less often than this never falls due. */
export const MAX_BUSINESS_SEARCH_DAYS = 366;

interface LocalDay {
  year: number;
  month: number;
  day: number;
}

function addLocalDays(d: LocalDay, days: number): LocalDay {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

function localDayKey(d: LocalDay): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.year, 4)}-${p(d.month)}-${p(d.day)}`;
}

function isoWeekday(d: LocalDay): number {
  const dow = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
  return ((dow + 6) % 7) + 1;
}

function localInstant(d: LocalDay, minutes: number, timezone: string): Date {
  const day = minutes >= 1440 ? addLocalDays(d, 1) : d;
  const m = minutes >= 1440 ? 0 : minutes;
  return resolveLocalTime(
    { year: day.year, month: day.month, day: day.day, hour: Math.floor(m / 60), minute: m % 60 },
    timezone,
  ).instant;
}

/** The periods the business is open between `from` and `to`, in order and merged. */
export function openPeriods(calendar: BusinessCalendar, from: Date, to: Date): OpenPeriod[] {
  if (to.getTime() <= from.getTime() || calendar.intervals.length === 0) return [];
  const first = zonedParts(from.getTime(), calendar.timezone);
  const last = zonedParts(to.getTime(), calendar.timezone);
  let day: LocalDay = addLocalDays({ year: first.year, month: first.month, day: first.day }, -1);
  const lastKey = localDayKey({ year: last.year, month: last.month, day: last.day });
  const byWeekday = new Map<number, BusinessInterval[]>();
  for (const interval of calendar.intervals) {
    const list = byWeekday.get(interval.weekday) ?? [];
    list.push(interval);
    byWeekday.set(interval.weekday, list);
  }
  const periods: OpenPeriod[] = [];
  for (;;) {
    const key = localDayKey(day);
    if (!calendar.closedDays.has(key)) {
      for (const interval of byWeekday.get(isoWeekday(day)) ?? []) {
        const start = localInstant(day, interval.opens, calendar.timezone);
        const end = localInstant(day, interval.closes, calendar.timezone);
        const s = Math.max(start.getTime(), from.getTime());
        const e = Math.min(end.getTime(), to.getTime());
        if (e > s) periods.push({ start: new Date(s), end: new Date(e) });
      }
    }
    if (key >= lastKey) break;
    day = addLocalDays(day, 1);
  }
  periods.sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: OpenPeriod[] = [];
  for (const p of periods) {
    const prev = merged[merged.length - 1];
    if (prev && p.start.getTime() <= prev.end.getTime()) {
      if (p.end.getTime() > prev.end.getTime()) prev.end = p.end;
    } else merged.push({ ...p });
  }
  return merged;
}

/** Milliseconds of business time between `from` and `to`. */
export function businessMsBetween(calendar: BusinessCalendar, from: Date, to: Date): number {
  return openPeriods(calendar, from, to).reduce(
    (sum, p) => sum + (p.end.getTime() - p.start.getTime()),
    0,
  );
}

/**
 * The instant at which `minutes` of business time have passed since `start`, or null when the
 * calendar is not open for that long within MAX_BUSINESS_SEARCH_DAYS.
 */
export function addBusinessMinutes(
  calendar: BusinessCalendar,
  start: Date,
  minutes: number,
): Date | null {
  let remaining = minutes * MINUTE_MS;
  let cursor = start;
  const limit = start.getTime() + MAX_BUSINESS_SEARCH_DAYS * DAY_MS;
  while (cursor.getTime() < limit) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + 14 * DAY_MS, limit));
    for (const p of openPeriods(calendar, cursor, chunkEnd)) {
      const length = p.end.getTime() - p.start.getTime();
      if (length >= remaining) return new Date(p.start.getTime() + remaining);
      remaining -= length;
    }
    cursor = chunkEnd;
  }
  return null;
}

/** Whether the business is open at `at`, and if not, when it next opens (null: not within a year). */
export function businessStatusAt(
  calendar: BusinessCalendar,
  at: Date,
): { open: true } | { open: false; opensAt: Date | null } {
  let cursor = at;
  const limit = at.getTime() + MAX_BUSINESS_SEARCH_DAYS * DAY_MS;
  while (cursor.getTime() < limit) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + 14 * DAY_MS, limit));
    // Periods are clipped to the search range, so one covering `at` starts exactly at `at`.
    const [first] = openPeriods(calendar, cursor, chunkEnd);
    if (first) {
      return first.start.getTime() <= at.getTime()
        ? { open: true }
        : { open: false, opensAt: first.start };
    }
    cursor = chunkEnd;
  }
  return { open: false, opensAt: null };
}

// Schedule input -----------------------------------------------------------------------------------

const TIME_RE = /^([01]?\d|2[0-4]):([0-5]\d)$/;
export const MAX_RANGES_PER_DAY = 4;
export const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** Minutes after midnight of a time written as HH:MM (24:00 for midnight at the end), or null. */
export function parseTime(text: string): number | null {
  const m = TIME_RE.exec(text.trim());
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes > 1440 ? null : minutes;
}

/**
 * Checks one day's ranges as Settings and the API (ADR-290) take them: at most
 * MAX_RANGES_PER_DAY, each ending after it starts, and none overlapping. Answers them in order.
 */
export function checkDayRanges(
  input: readonly { opens: number; closes: number }[],
): { ok: true; ranges: { opens: number; closes: number }[] } | { ok: false; message: string } {
  if (input.length > MAX_RANGES_PER_DAY)
    return { ok: false, message: `Use at most ${MAX_RANGES_PER_DAY} time ranges a day.` };
  if (input.some((r) => r.opens >= 1440)) {
    return { ok: false, message: 'A range must start before midnight.' };
  }
  if (input.some((r) => r.closes <= r.opens)) {
    return { ok: false, message: 'A range must end after it starts; use 24:00 for midnight.' };
  }
  const ranges = [...input].sort((x, y) => x.opens - y.opens);
  for (let i = 1; i < ranges.length; i += 1) {
    if ((ranges[i] as { opens: number }).opens < (ranges[i - 1] as { closes: number }).closes)
      return { ok: false, message: 'Time ranges on the same day must not overlap.' };
  }
  return { ok: true, ranges };
}

/**
 * Parses one day's opening times, written as comma-separated ranges such as "09:00-13:00,
 * 14:00-18:00" (an empty value means closed; "24:00" closes at midnight).
 */
export function parseDayRanges(
  text: string,
): { ok: true; ranges: { opens: number; closes: number }[] } | { ok: false; message: string } {
  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > MAX_RANGES_PER_DAY)
    return { ok: false, message: `Use at most ${MAX_RANGES_PER_DAY} time ranges a day.` };
  const ranges: { opens: number; closes: number }[] = [];
  for (const part of parts) {
    const [a, b, extra] = part.split(/\s*[-–—]\s*/);
    const opens = a === undefined ? null : parseTime(a);
    const closes = b === undefined ? null : parseTime(b);
    if (extra !== undefined || opens === null || closes === null || opens >= 1440) {
      return { ok: false, message: `Write times as ranges like 09:00-17:30 (got “${part}”).` };
    }
    if (closes <= opens) {
      return {
        ok: false,
        message: `A range must end after it starts; use 24:00 for midnight (got “${part}”).`,
      };
    }
    ranges.push({ opens, closes });
  }
  return checkDayRanges(ranges);
}

/**
 * The weekly intervals of seven days' checked ranges, Monday first (Settings, and keys since
 * ADR-290). Business hours are not turned on without an opening time.
 */
export function scheduleIntervals(
  enabled: boolean,
  days: readonly (readonly { opens: number; closes: number }[])[],
): BusinessInterval[] {
  const intervals: BusinessInterval[] = [];
  days.forEach((ranges, i) => {
    for (const r of ranges) intervals.push({ weekday: i + 1, opens: r.opens, closes: r.closes });
  });
  if (enabled && intervals.length === 0) {
    throw new AppError(
      'validation_failed',
      'Add at least one opening time before turning business hours on.',
    );
  }
  return intervals;
}

export function formatMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** A week's intervals as seven days of editable text, Monday first ("" = closed). */
export function intervalsToDayTexts(intervals: readonly BusinessInterval[]): string[] {
  return WEEKDAY_NAMES.map((_, i) =>
    intervals
      .filter((iv) => iv.weekday === i + 1)
      .sort((a, b) => a.opens - b.opens)
      .map((iv) => `${formatMinutes(iv.opens)}-${formatMinutes(iv.closes)}`)
      .join(', '),
  );
}

/** Whether two weeks hold the same intervals, whatever their order. */
export function sameIntervals(
  a: readonly BusinessInterval[],
  b: readonly BusinessInterval[],
): boolean {
  const key = (iv: BusinessInterval) => `${iv.weekday}:${iv.opens}:${iv.closes}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((k, i) => k === right[i]);
}

// Business hours per team (ADR-389) -----------------------------------------------------------------

export const TEAM_HOURS_EMPTY_MESSAGE =
  'Add at least one opening time for the team, or let it use the company’s business hours.';

/**
 * A team's own weekly schedule as Settings → Teams and the API take it: seven days of text, Monday
 * first, each checked as the company's schedule is (`parseDayRanges`), with at least one opening
 * time (a team that never opens would never be due a reply). Null: the team uses the company's
 * schedule. Issues name the day (`<n>`, under the caller's field).
 */
export const teamHoursSchema = z
  .array(z.string().max(200, 'Use at most 200 characters a day.'))
  .length(7, 'Give seven days, Monday first.')
  .nullable()
  .transform((days, ctx): BusinessInterval[] | null => {
    if (days === null) return null;
    const intervals: BusinessInterval[] = [];
    for (const [i, text] of days.entries()) {
      const parsed = parseDayRanges(text);
      if (!parsed.ok) {
        ctx.addIssue({
          code: 'custom',
          path: [i],
          message: `${WEEKDAY_NAMES[i] ?? 'Day'}: ${parsed.message}`,
        });
        return z.NEVER;
      }
      for (const r of parsed.ranges) intervals.push({ weekday: i + 1, ...r });
    }
    if (intervals.length === 0) {
      ctx.addIssue({ code: 'custom', message: TEAM_HOURS_EMPTY_MESSAGE });
      return z.NEVER;
    }
    return intervals;
  });

/**
 * The calendars business time is counted by: the company's while its business hours are on, and
 * the teams with their own weekly schedule (ADR-389), each with the company's closed days and time
 * zone. While business hours are off (or have no opening time) business time is not used anywhere,
 * so `company` is null and `teams` is empty: a team's schedule applies only while the company's
 * hours are on.
 */
export interface BusinessCalendars {
  company: BusinessCalendar | null;
  teams: ReadonlyMap<string, BusinessCalendar>;
}

/** The calendar of a conversation in team `teamId` (or none): its team's own, else the company's. */
export function calendarFor(
  calendars: BusinessCalendars,
  teamId: string | null,
): BusinessCalendar | null {
  if (!calendars.company) return null;
  return (teamId === null ? undefined : calendars.teams.get(teamId)) ?? calendars.company;
}

/** The calendars of a company's business hours and its teams' own weekly schedules. */
export function businessCalendars(
  company: BusinessCalendar | null,
  teamIntervals: ReadonlyMap<string, readonly BusinessInterval[]>,
): BusinessCalendars {
  if (!company) return { company: null, teams: new Map() };
  const teams = new Map<string, BusinessCalendar>();
  for (const [teamId, intervals] of teamIntervals) {
    if (intervals.length > 0) teams.set(teamId, { ...company, intervals: [...intervals] });
  }
  return { company, teams };
}

const timeToMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

export const businessHoursSchema = z.object({
  enabled: z.boolean(),
  /** Seven entries, Monday first; each is a day's ranges as text ("" = closed). */
  days: z.array(z.string().max(200)).length(7),
});

export const holidaySchema = z.object({
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.')
    .refine((v) => {
      const [y, m, d] = v.split('-').map(Number) as [number, number, number];
      const t = new Date(Date.UTC(y, m - 1, d));
      return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
    }, 'Enter a real date.'),
  name: z.string().trim().min(1, 'Name the closed day.').max(80, 'Use at most 80 characters.'),
});

export interface BusinessHoursView {
  enabled: boolean;
  timezone: string;
  /** Monday first; each day's ranges as text for editing. */
  days: string[];
  holidays: { id: string; day: string; name: string }[];
}

/**
 * Loads a company's calendar; `enabled` is false when business hours are off or have no opening
 * time, and `turnedOn` is the switch itself.
 */
export async function loadBusinessCalendar(
  tx: Tx,
  tenantId: string,
  timezone: string,
): Promise<{ enabled: boolean; turnedOn: boolean; calendar: BusinessCalendar }> {
  const [settings] = await tx
    .select({ enabled: messagingSettings.businessHoursEnabled })
    .from(messagingSettings)
    .where(eq(messagingSettings.tenantId, tenantId));
  const rows = await tx
    .select({
      weekday: businessHours.weekday,
      opensAt: businessHours.opensAt,
      closesAt: businessHours.closesAt,
    })
    .from(businessHours)
    .where(eq(businessHours.tenantId, tenantId))
    .orderBy(asc(businessHours.weekday), asc(businessHours.opensAt));
  const closed = await tx
    .select({ day: businessHolidays.day })
    .from(businessHolidays)
    .where(eq(businessHolidays.tenantId, tenantId));
  return {
    enabled: settings?.enabled === true && rows.length > 0,
    turnedOn: settings?.enabled === true,
    calendar: {
      timezone,
      intervals: rows.map((r) => ({
        weekday: r.weekday,
        opens: timeToMinutes(r.opensAt),
        closes: timeToMinutes(r.closesAt),
      })),
      closedDays: new Set(closed.map((c) => c.day)),
    },
  };
}

/**
 * The weekly schedules of the company's teams that have their own (ADR-389), by team id, each in
 * order; with `teamIds`, of those teams only. One query for every team.
 */
export async function loadTeamSchedules(
  tx: Tx,
  tenantId: string,
  teamIds?: readonly string[],
): Promise<Map<string, BusinessInterval[]>> {
  if (teamIds && teamIds.length === 0) return new Map();
  const rows = await tx
    .select({
      teamId: teamBusinessHours.teamId,
      weekday: teamBusinessHours.weekday,
      opensAt: teamBusinessHours.opensAt,
      closesAt: teamBusinessHours.closesAt,
    })
    .from(teamBusinessHours)
    .where(
      and(
        eq(teamBusinessHours.tenantId, tenantId),
        teamIds ? inArray(teamBusinessHours.teamId, [...teamIds]) : undefined,
      ),
    )
    .orderBy(
      asc(teamBusinessHours.teamId),
      asc(teamBusinessHours.weekday),
      asc(teamBusinessHours.opensAt),
    );
  const schedules = new Map<string, BusinessInterval[]>();
  for (const r of rows) {
    const list = schedules.get(r.teamId) ?? [];
    list.push({
      weekday: r.weekday,
      opens: timeToMinutes(r.opensAt),
      closes: timeToMinutes(r.closesAt),
    });
    schedules.set(r.teamId, list);
  }
  return schedules;
}

/**
 * The company's calendar and, while its business hours are on, its teams' own (ADR-389): loaded
 * once per request or sweep, so a list, a sweep or a report never reads calendars per conversation.
 */
export async function loadBusinessCalendars(
  tx: Tx,
  tenantId: string,
  timezone: string,
): Promise<BusinessCalendars> {
  const { enabled, calendar } = await loadBusinessCalendar(tx, tenantId, timezone);
  if (!enabled) return { company: null, teams: new Map() };
  return businessCalendars(calendar, await loadTeamSchedules(tx, tenantId));
}

/**
 * Replaces a team's own weekly schedule (Settings → Teams, and keys), or removes it with null so
 * the team uses the company's. The caller audits it with the team's change and plans waiting
 * replies again (`replanWaitingTurns`) when it changed.
 */
export async function writeTeamBusinessHours(
  tx: Tx,
  tenantId: string,
  teamId: string,
  intervals: readonly BusinessInterval[] | null,
): Promise<void> {
  await tx
    .delete(teamBusinessHours)
    .where(and(eq(teamBusinessHours.tenantId, tenantId), eq(teamBusinessHours.teamId, teamId)));
  if (intervals && intervals.length > 0) {
    await tx.insert(teamBusinessHours).values(
      intervals.map((iv) => ({
        id: uuidv7(),
        tenantId,
        teamId,
        weekday: iv.weekday,
        opensAt: formatMinutes(iv.opens),
        closesAt: formatMinutes(iv.closes),
      })),
    );
  }
}

/**
 * Replaces the company's weekly schedule and turns business hours on or off (Settings, and keys
 * since ADR-290). `updatedByUserId` is the member's, or null for a key. The caller audits it.
 */
export async function writeBusinessHours(
  tx: Tx,
  tenantId: string,
  enabled: boolean,
  intervals: readonly BusinessInterval[],
  updatedByUserId: string | null,
  now: Date,
): Promise<void> {
  await tx
    .insert(messagingSettings)
    .values({
      tenantId,
      optOutKeywords: [...DEFAULT_MESSAGING_SETTINGS.optOutKeywords],
      marketingOptOutKeywords: [...DEFAULT_MESSAGING_SETTINGS.marketingOptOutKeywords],
      optInKeywords: [...DEFAULT_MESSAGING_SETTINGS.optInKeywords],
      requireMarketingOptIn: DEFAULT_MESSAGING_SETTINGS.requireMarketingOptIn,
      businessHoursEnabled: enabled,
      updatedByUserId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: messagingSettings.tenantId,
      set: { businessHoursEnabled: enabled, updatedByUserId, updatedAt: now },
    });
  await tx.delete(businessHours).where(eq(businessHours.tenantId, tenantId));
  if (intervals.length) {
    await tx.insert(businessHours).values(
      intervals.map((iv) => ({
        id: uuidv7(),
        tenantId,
        weekday: iv.weekday,
        opensAt: formatMinutes(iv.opens),
        closesAt: formatMinutes(iv.closes),
      })),
    );
  }
  await replanWaitingTurns(tx, tenantId);
}

/**
 * Has the next sweep look again at every automatic reply that waits for the company's business
 * hours (ADR-384): a changed calendar or delay can make it due earlier or later than the time it
 * was put off to, so it is planned again from the current settings (the database's time, as the
 * sweep's due times).
 */
export async function replanWaitingSlowReplies(tx: Tx, tenantId: string): Promise<void> {
  await tx
    .update(slowReplyMessages)
    .set({ dueAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(slowReplyMessages.tenantId, tenantId), eq(slowReplyMessages.state, 'waiting')));
}

/**
 * Has the next sweeps look again at every reply that waits for a calendar: the automatic replies
 * (ADR-384) and the overdue-reply notices (ADR-230) put off to a time an old calendar or target
 * gave. Used when the company's schedule or closed days, or a team's own schedule or target,
 * change (ADR-389); a conversation that changes team has its own waiting rows planned again by a
 * database trigger (migration 0303).
 */
export async function replanWaitingTurns(tx: Tx, tenantId: string): Promise<void> {
  await replanWaitingSlowReplies(tx, tenantId);
  await tx
    .update(overdueReplyNotices)
    .set({ dueAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(eq(overdueReplyNotices.tenantId, tenantId), eq(overdueReplyNotices.state, 'waiting')),
    );
}

/** A day already marked closed, as a conflict; any other error as it is. */
export function closedDayError(error: unknown): unknown {
  return isUniqueViolation(error, 'business_holidays_day_uq')
    ? new AppError('conflict', 'That day is already marked closed.')
    : error;
}

/**
 * Marks a day closed (Settings, and keys since ADR-290), answering its id. The caller audits it and
 * maps a day already closed with `closedDayError`.
 */
export async function writeAddClosedDay(
  tx: Tx,
  tenantId: string,
  data: { day: string; name: string },
): Promise<string> {
  const id = uuidv7();
  await tx.insert(businessHolidays).values({ id, tenantId, day: data.day, name: data.name });
  await replanWaitingTurns(tx, tenantId);
  return id;
}

/** Opens a closed day again (Settings, and keys since ADR-290); null when there is no such day. */
export async function writeRemoveClosedDay(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<{ day: string; name: string } | null> {
  const [deleted] = await tx
    .delete(businessHolidays)
    .where(and(eq(businessHolidays.tenantId, tenantId), eq(businessHolidays.id, id)))
    .returning({ day: businessHolidays.day, name: businessHolidays.name });
  if (deleted) await replanWaitingTurns(tx, tenantId);
  return deleted ?? null;
}

export function createBusinessHoursService(deps: { db: Database; clock: Clock }) {
  const { db, clock } = deps;

  return {
    async getBusinessHours(ctx: TenantContext): Promise<BusinessHoursView> {
      assertCan(ctx, 'tenant.read');
      return db.run(
        ctx.scope,
        async (tx) => {
          const { enabled, calendar } = await loadBusinessCalendar(
            tx,
            ctx.tenant.id,
            ctx.tenant.timezone,
          );
          const [settings] = await tx
            .select({ enabled: messagingSettings.businessHoursEnabled })
            .from(messagingSettings)
            .where(eq(messagingSettings.tenantId, ctx.tenant.id));
          const holidays = await tx
            .select({
              id: businessHolidays.id,
              day: businessHolidays.day,
              name: businessHolidays.name,
            })
            .from(businessHolidays)
            .where(eq(businessHolidays.tenantId, ctx.tenant.id))
            .orderBy(asc(businessHolidays.day));
          const days = intervalsToDayTexts(calendar.intervals);
          return {
            enabled: enabled || settings?.enabled === true,
            timezone: ctx.tenant.timezone,
            days,
            holidays,
          };
        },
        { accessMode: 'read only' },
      );
    },

    /** Replaces the weekly schedule and turns business hours on or off. */
    async updateBusinessHours(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      const data = parseInput(businessHoursSchema, input);
      const days = data.days.map((text, i) => {
        const parsed = parseDayRanges(text);
        if (!parsed.ok) {
          throw new AppError('validation_failed', `${WEEKDAY_NAMES[i]}: ${parsed.message}`, {
            issues: [{ path: `days.${i}`, message: parsed.message }],
          });
        }
        return parsed.ranges;
      });
      const intervals = scheduleIntervals(data.enabled, days);
      await db.run(ctx.scope, async (tx) => {
        await writeBusinessHours(
          tx,
          ctx.tenant.id,
          data.enabled,
          intervals,
          ctx.user.id,
          clock.now(),
        );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'inbox.business_hours_updated',
            subjectType: 'tenant',
            subjectId: ctx.tenant.id,
            metadata: { enabled: data.enabled, intervals: intervals.length },
          },
          meta,
        );
      });
    },

    async addHoliday(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      const data = parseInput(holidaySchema, input);
      try {
        await db.run(ctx.scope, async (tx) => {
          const id = await writeAddClosedDay(tx, ctx.tenant.id, data);
          await recordAudit(
            tx,
            ctx,
            {
              action: 'inbox.closed_day_added',
              subjectType: 'business_holiday',
              subjectId: id,
              metadata: { day: data.day },
            },
            meta,
          );
        });
      } catch (error) {
        throw closedDayError(error);
      }
    },

    async removeHoliday(ctx: TenantContext, holidayId: string, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      if (!z.uuid().safeParse(holidayId).success) throw notFound('Closed day');
      await db.run(ctx.scope, async (tx) => {
        const deleted = await writeRemoveClosedDay(tx, ctx.tenant.id, holidayId);
        if (!deleted) throw notFound('Closed day');
        await recordAudit(
          tx,
          ctx,
          {
            action: 'inbox.closed_day_removed',
            subjectType: 'business_holiday',
            subjectId: holidayId,
            metadata: { day: deleted.day },
          },
          meta,
        );
      });
    },
  };
}

export type BusinessHoursService = ReturnType<typeof createBusinessHoursService>;
