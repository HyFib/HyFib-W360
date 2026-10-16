import { z } from 'zod';
import { AppError, notFound } from '@w360/core';
import { and, asc, businessHolidays, eq, gte, lte, tenants, type Tx } from '@w360/db';
import { recordSystemAudit } from '../audit';
import { localDateAfter } from '../crm/time';
import {
  MAX_RANGES_PER_DAY,
  businessStatusAt,
  checkDayRanges,
  closedDayError,
  formatMinutes,
  holidaySchema,
  loadBusinessCalendar,
  openPeriods,
  parseTime,
  sameIntervals,
  scheduleIntervals,
  writeAddClosedDay,
  writeBusinessHours,
  writeRemoveClosedDay,
  type BusinessCalendar,
  type BusinessInterval,
} from '../inbox/business-hours';
import type { OutboundDeps } from '../messaging/outbound';
import { parseInput } from '../validation';
import { apiActor, assertAnyScope, assertScope, type ApiContext } from './context';
import {
  claimIdempotencyKey,
  storeIdempotentResponse,
  type ApiResponse,
  type IdempotencyInput,
} from './idempotency';

/**
 * Business hours through the public API (ADR-290): the weekly schedule, whether the company is open
 * now, and its closed days, read with `business_hours.read` or `business_hours.manage` and set with
 * the latter, through the writes Settings → Inbox uses, audited as the key.
 */

/** How far ahead a closing time is looked for: a schedule open longer than this gives none. */
export const CLOSES_AT_SEARCH_DAYS = 14;
/** The most days one read of closed days covers. */
export const CLOSED_DAYS_MAX_SPAN = 366;

/** An opening time range as the API gives and takes it. */
export interface ApiTimeRange {
  /** HH:MM in the company's time zone. */
  opens: string;
  /** HH:MM, after `opens`; 24:00 is midnight at the end of the day. */
  closes: string;
}

/** The company's business hours, as `GET /business-hours` gives them. */
export interface ApiBusinessHours {
  /** Whether business hours are turned on; while off, the company counts as always open. */
  enabled: boolean;
  timeZone: string;
  /** Seven days, Monday first, each with its opening ranges in order (none: closed all day). */
  days: ApiTimeRange[][];
  /** Whether the company is open now: within its hours and not on a closed day, or always while they are off or empty. */
  open: boolean;
  /** While closed: when it next opens (null when not within a year). */
  opensAt: string | null;
  /** While open by its hours: when this opening ends (null when not within the next 14 days, or while hours are off). */
  closesAt: string | null;
  asOf: string;
}

export interface ApiClosedDay {
  id: string;
  /** YYYY-MM-DD in the company's time zone. */
  day: string;
  name: string;
}

const timeSchema = z
  .string()
  .max(5)
  .refine(
    (text) => parseTime(text) !== null,
    'Write times as HH:MM, like 09:00; 24:00 is midnight.',
  )
  .describe('HH:MM in the company’s time zone; 24:00 closes at midnight.');

/** What `PUT /business-hours` takes: the whole week, and whether the hours are on. */
export const apiUpdateBusinessHoursSchema = z
  .object({
    enabled: z
      .boolean()
      .describe(
        'Turn business hours on (they need an opening time) or off (the company counts as always open).',
      ),
    days: z
      .array(
        z
          .array(z.object({ opens: timeSchema, closes: timeSchema }).strict())
          .max(MAX_RANGES_PER_DAY, `Use at most ${MAX_RANGES_PER_DAY} time ranges a day.`),
      )
      .length(7, 'Give seven days, Monday first.')
      .describe(
        `Seven days, Monday first, each with up to ${MAX_RANGES_PER_DAY} opening ranges that do not overlap; an empty list closes the day. Replaces the week.`,
      ),
  })
  .strict();

/** What `POST /business-hours/closed-days` takes. */
export const apiCreateClosedDaySchema = holidaySchema.strict();

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Give a date as YYYY-MM-DD.')
  .refine((v) => {
    const [y, m, d] = v.split('-').map(Number) as [number, number, number];
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }, 'Give a real date.');

/** What `GET /business-hours/closed-days` takes: a span of days, a year at most. */
export const apiClosedDayListQuerySchema = z
  .object({
    from: dateSchema
      .optional()
      .describe('The first day, YYYY-MM-DD; today in the company’s time zone by default.'),
    to: dateSchema
      .optional()
      .describe(
        `The last day, YYYY-MM-DD; ${CLOSED_DAYS_MAX_SPAN - 1} days after \`from\` by default.`,
      ),
  })
  .strict();

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The week as the API gives it, from stored intervals. */
export function toApiDays(intervals: readonly BusinessInterval[]): ApiTimeRange[][] {
  return Array.from({ length: 7 }, (_, i) =>
    intervals
      .filter((iv) => iv.weekday === i + 1)
      .sort((a, b) => a.opens - b.opens)
      .map((iv) => ({ opens: formatMinutes(iv.opens), closes: formatMinutes(iv.closes) })),
  );
}

/**
 * The week a request gives as intervals, each day checked as Settings checks it (422 naming
 * `days.<n>`), refusing hours turned on without an opening time.
 */
export function apiScheduleIntervals(
  data: z.output<typeof apiUpdateBusinessHoursSchema>,
): BusinessInterval[] {
  const days = data.days.map((ranges, i) => {
    const checked = checkDayRanges(
      ranges.map((r) => ({ opens: parseTime(r.opens) ?? 0, closes: parseTime(r.closes) ?? 0 })),
    );
    if (!checked.ok) {
      throw new AppError('validation_failed', checked.message, {
        issues: [{ path: `days.${i}`, message: checked.message }],
      });
    }
    return checked.ranges;
  });
  return scheduleIntervals(data.enabled, days);
}

/** Whether two weeks hold the same intervals (shared with team schedules, ADR-389). */
export { sameIntervals } from '../inbox/business-hours';

/**
 * Whether the company is open at `now`, and when it next opens or this opening ends. Hours that are
 * off or empty count as always open, as automations' off-hours branch takes them.
 */
export function businessHoursStatus(
  enabled: boolean,
  calendar: BusinessCalendar,
  now: Date,
): { open: boolean; opensAt: Date | null; closesAt: Date | null } {
  if (!enabled) return { open: true, opensAt: null, closesAt: null };
  const status = businessStatusAt(calendar, now);
  if (!status.open) return { open: false, opensAt: status.opensAt, closesAt: null };
  const until = new Date(now.getTime() + CLOSES_AT_SEARCH_DAYS * 86_400_000);
  const [current] = openPeriods(calendar, now, until);
  return {
    open: true,
    opensAt: null,
    closesAt: current && current.end.getTime() < until.getTime() ? current.end : null,
  };
}

/**
 * The span of closed days a request asks for: from `from` (today by default) to `to` (a year on by
 * default), a year at most.
 */
export function closedDaySpan(
  query: { from?: string | undefined; to?: string | undefined },
  today: string,
): { from: string; to: string } {
  const from = query.from ?? today;
  const to =
    query.to ?? localDateAfter(new Date(`${from}T12:00:00Z`), 'UTC', CLOSED_DAYS_MAX_SPAN - 1);
  const span = daysBetween(from, to);
  if (span < 0 || span >= CLOSED_DAYS_MAX_SPAN) {
    const message = `Give \`to\` on or after \`from\`, at most ${CLOSED_DAYS_MAX_SPAN - 1} days later.`;
    throw new AppError('validation_failed', message, { issues: [{ path: 'to', message }] });
  }
  return { from, to };
}

async function companyTimeZone(tx: Tx, tenantId: string): Promise<string> {
  const [company] = await tx
    .select({ timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!company) throw notFound('Company');
  return company.timezone;
}

/** The business hours and whether the company is open at `now`, read in the caller's transaction. */
async function readApiBusinessHours(
  tx: Tx,
  tenantId: string,
  now: Date,
): Promise<ApiBusinessHours> {
  const timeZone = await companyTimeZone(tx, tenantId);
  const { enabled, turnedOn, calendar } = await loadBusinessCalendar(tx, tenantId, timeZone);
  const status = businessHoursStatus(enabled, calendar, now);
  return {
    enabled: turnedOn,
    timeZone,
    days: toApiDays(calendar.intervals),
    open: status.open,
    opensAt: status.opensAt ? status.opensAt.toISOString() : null,
    closesAt: status.closesAt ? status.closesAt.toISOString() : null,
    asOf: now.toISOString(),
  };
}

/** The company's business hours and whether it is open now. Reading works while it is suspended. */
export async function apiGetBusinessHours(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
): Promise<ApiBusinessHours> {
  assertAnyScope(ctx, ['business_hours.read', 'business_hours.manage']);
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, (tx) => readApiBusinessHours(tx, ctx.tenant.id, now), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
}

/**
 * Sets the week and turns business hours on or off, as owners and administrators save them in
 * Settings → Inbox, and answers them as `GET /business-hours` gives them. A week and switch the
 * company already has are answered as they are, with no audit entry, so a retry needs no key.
 */
export async function apiUpdateBusinessHours(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  input: unknown,
): Promise<ApiBusinessHours> {
  assertScope(ctx, 'business_hours.manage');
  const data = parseInput(apiUpdateBusinessHoursSchema, input);
  const intervals = apiScheduleIntervals(data);
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, async (tx) => {
    const timeZone = await companyTimeZone(tx, ctx.tenant.id);
    const current = await loadBusinessCalendar(tx, ctx.tenant.id, timeZone);
    if (
      current.turnedOn !== data.enabled ||
      !sameIntervals(current.calendar.intervals, intervals)
    ) {
      await writeBusinessHours(tx, ctx.tenant.id, data.enabled, intervals, null, now);
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action: 'inbox.business_hours_updated',
          subjectType: 'tenant',
          subjectId: ctx.tenant.id,
          correlationId: ctx.requestId,
          metadata: { enabled: data.enabled, intervals: intervals.length, source: 'api' },
        },
        apiActor(ctx),
      );
    }
    return readApiBusinessHours(tx, ctx.tenant.id, now);
  });
}

/**
 * The company's closed days from `from` to `to` (a year at most), in order. Reading works while it
 * is suspended.
 */
export async function apiListClosedDays(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiClosedDay[]; from: string; to: string }> {
  assertAnyScope(ctx, ['business_hours.read', 'business_hours.manage']);
  const q = parseInput(apiClosedDayListQuerySchema, query);
  const now = deps.clock.now();
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const timeZone = await companyTimeZone(tx, ctx.tenant.id);
      const { from, to } = closedDaySpan(q, localDateAfter(now, timeZone, 0));
      const data = await tx
        .select({ id: businessHolidays.id, day: businessHolidays.day, name: businessHolidays.name })
        .from(businessHolidays)
        .where(
          and(
            eq(businessHolidays.tenantId, ctx.tenant.id),
            gte(businessHolidays.day, from),
            lte(businessHolidays.day, to),
          ),
        )
        .orderBy(asc(businessHolidays.day));
      return { data, from, to };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/**
 * Marks a day closed as owners and administrators do in Settings → Inbox (409 when it already is).
 * Once per `Idempotency-Key` when one is given.
 */
export async function apiCreateClosedDay(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput | null,
): Promise<ApiResponse> {
  assertScope(ctx, 'business_hours.manage');
  const data = parseInput(apiCreateClosedDaySchema, input);
  const now = deps.clock.now();
  try {
    return await deps.db.run(ctx.scope, async (tx) => {
      // Claimed in the day's transaction, so a refused day leaves the key unused.
      let claimed: string | null = null;
      if (idempotency) {
        const claim = await claimIdempotencyKey(tx, ctx, idempotency, now);
        if ('replay' in claim) return claim.replay;
        claimed = claim.claimed;
      }
      const id = await writeAddClosedDay(tx, ctx.tenant.id, data);
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action: 'inbox.closed_day_added',
          subjectType: 'business_holiday',
          subjectId: id,
          correlationId: ctx.requestId,
          metadata: { day: data.day, source: 'api' },
        },
        apiActor(ctx),
      );
      const response = { status: 201, body: { data: { id, day: data.day, name: data.name } } };
      if (claimed) await storeIdempotentResponse(tx, ctx, claimed, response);
      return { ...response, replayed: false };
    });
  } catch (error) {
    throw closedDayError(error);
  }
}

/** Opens a closed day again, as Settings does. A day already open again answers 404. */
export async function apiDeleteClosedDay(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  id: string,
): Promise<{ id: string; deleted: true; day: string }> {
  assertScope(ctx, 'business_hours.manage');
  if (!z.uuid().safeParse(id).success) throw notFound('Closed day');
  return deps.db.run(ctx.scope, async (tx) => {
    const deleted = await writeRemoveClosedDay(tx, ctx.tenant.id, id);
    if (!deleted) throw notFound('Closed day');
    await recordSystemAudit(
      tx,
      ctx.tenant.id,
      {
        action: 'inbox.closed_day_removed',
        subjectType: 'business_holiday',
        subjectId: id,
        correlationId: ctx.requestId,
        metadata: { day: deleted.day, source: 'api' },
      },
      apiActor(ctx),
    );
    return { id, deleted: true, day: deleted.day };
  });
}
