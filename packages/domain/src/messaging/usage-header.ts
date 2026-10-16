/**
 * Meta's `x-business-use-case-usage` response header (research M-027, M-200, ADR-399). Its value is
 * JSON text: an object keyed by business object id (for WhatsApp, the WhatsApp Business Account's
 * id), each holding a list of entries `{type, call_count, total_cputime, total_time,
 * estimated_time_to_regain_access}` with types `whatsapp_business_management` and `whatsapp`.
 * Meta's rate-limiting page describes the three counters as whole-number percentages of the
 * allowance over a rolling hour, and `estimated_time_to_regain_access` as minutes until calls are no
 * longer throttled (M-200).
 *
 * The parse is lenient and bounded: a missing, oversized or malformed header, or an entry of the
 * wrong shape, gives nothing rather than an error, and never changes how a call is classified. Only
 * what pacing needs is kept: per business id, the `whatsapp_business_management` entry's three
 * percentages and its minutes to regain access. The raw header is never logged.
 */
export const BUSINESS_USE_CASE_USAGE_HEADER = 'x-business-use-case-usage';

/** Longest header value read: Meta's page says one header holds at most 32 objects (M-200). */
export const MAX_USAGE_HEADER_CHARS = 16_384;
/** Business ids and entries per id read from one header; more are ignored. */
export const MAX_USAGE_BUSINESS_IDS = 32;
export const MAX_USAGE_ENTRIES_PER_ID = 16;
/** Percentages are kept within 0 to 100: throttling starts at 100 (M-200). */
export const MAX_USAGE_PERCENT = 100;
/**
 * The longest pause a header can set, in minutes. A larger value is read as this many minutes, so a
 * wrong or hostile header cannot stop an account's management work for longer than a day (T352).
 */
export const MAX_REGAIN_ACCESS_MINUTES = 1_440;

const MANAGEMENT_TYPE = 'whatsapp_business_management';
const BUSINESS_ID = /^[0-9]{1,32}$/;
const NUMBER_TEXT = /^[0-9]{1,12}(\.[0-9]{1,12})?$/;

/** A WhatsApp account's management usage, as one response reported it. */
export interface ManagementUsage {
  /** Percentages (0–100) of the rolling hour's allowance. */
  callCount: number;
  totalCputime: number;
  totalTime: number;
  /** Minutes until management calls are no longer throttled (0: not throttled). */
  regainAccessMinutes: number;
}

/** Management usage by business id (WhatsApp Business Account id). */
export type BusinessUseCaseUsage = ReadonlyMap<string, ManagementUsage>;

/**
 * A non-negative finite number, or numeric text, rounded up to a whole number and capped; anything
 * else (negative, NaN, Infinity, another type) is null.
 */
function wholeNumber(value: unknown, max: number): number | null {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && NUMBER_TEXT.test(value)) n = Number(value);
  else return null;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.ceil(n), max);
}

/** The management entry an item describes, or null for another type or the wrong shape. */
function managementEntry(item: unknown): ManagementUsage | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
  const e = item as Record<string, unknown>;
  if (e.type !== MANAGEMENT_TYPE) return null;
  const callCount = wholeNumber(e.call_count, MAX_USAGE_PERCENT);
  const totalCputime = wholeNumber(e.total_cputime, MAX_USAGE_PERCENT);
  const totalTime = wholeNumber(e.total_time, MAX_USAGE_PERCENT);
  const regain = wholeNumber(e.estimated_time_to_regain_access, MAX_REGAIN_ACCESS_MINUTES);
  if (callCount === null && totalCputime === null && totalTime === null && regain === null) {
    return null;
  }
  // A counter Meta did not give, or gave unreadably, is not taken as usage.
  return {
    callCount: callCount ?? 0,
    totalCputime: totalCputime ?? 0,
    totalTime: totalTime ?? 0,
    regainAccessMinutes: regain ?? 0,
  };
}

/** Two readings of one account in one header: the higher of each value. */
function higher(a: ManagementUsage, b: ManagementUsage): ManagementUsage {
  return {
    callCount: Math.max(a.callCount, b.callCount),
    totalCputime: Math.max(a.totalCputime, b.totalCputime),
    totalTime: Math.max(a.totalTime, b.totalTime),
    regainAccessMinutes: Math.max(a.regainAccessMinutes, b.regainAccessMinutes),
  };
}

/**
 * The management usage a header value reports, by business id, or null when it reports none that
 * can be read. Never throws.
 */
export function parseBusinessUseCaseUsage(
  raw: string | null | undefined,
): BusinessUseCaseUsage | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_USAGE_HEADER_CHARS) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const usage = new Map<string, ManagementUsage>();
  let ids = 0;
  for (const [id, entries] of Object.entries(parsed as Record<string, unknown>)) {
    if (ids >= MAX_USAGE_BUSINESS_IDS) break;
    ids += 1;
    if (!BUSINESS_ID.test(id) || !Array.isArray(entries)) continue;
    for (const item of entries.slice(0, MAX_USAGE_ENTRIES_PER_ID)) {
      const entry = managementEntry(item);
      if (!entry) continue;
      const seen = usage.get(id);
      usage.set(id, seen ? higher(seen, entry) : entry);
    }
  }
  return usage.size > 0 ? usage : null;
}

/** The highest of a reading's three percentages. */
export function highestUsagePercent(usage: ManagementUsage): number {
  return Math.max(usage.callCount, usage.totalCputime, usage.totalTime);
}
