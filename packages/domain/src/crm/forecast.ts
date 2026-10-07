import { zonedParts } from '../campaigns/schedule';

/**
 * The CRM board's weighted figures (ADR-242): each stage's open deal value times its chance of
 * winning, for the whole pipeline and for the deals expected to close by the end of the month.
 * Stages without a chance are left out of both and counted, so the board can say so.
 */
export interface StageTotals {
  /** Open deals in the stage. */
  count: number;
  /** Their value, in the pipeline currency's minor unit (deals without a value count 0). */
  valueMinor: number;
  /** The value of those expected to close by the end of the month (company time). */
  monthValueMinor: number;
  winPercent: number | null;
}

export interface Forecast {
  /** Whether any stage has a chance: without one there is nothing to weigh. */
  hasChances: boolean;
  weightedMinor: number;
  weightedMonthMinor: number;
  /** Stages holding open deals without a chance, which the figures leave out. */
  stagesWithoutChance: number;
}

/** A value times a chance, rounded to the minor unit. */
export function weigh(valueMinor: number, winPercent: number): number {
  return Math.round((valueMinor * winPercent) / 100);
}

/** The pipeline's weighted figures from its stages' totals. */
export function forecast(stages: readonly StageTotals[]): Forecast {
  let weightedMinor = 0;
  let weightedMonthMinor = 0;
  let stagesWithoutChance = 0;
  let hasChances = false;
  for (const stage of stages) {
    if (stage.winPercent === null) {
      if (stage.count > 0) stagesWithoutChance += 1;
      continue;
    }
    hasChances = true;
    weightedMinor += weigh(stage.valueMinor, stage.winPercent);
    weightedMonthMinor += weigh(stage.monthValueMinor, stage.winPercent);
  }
  return { hasChances, weightedMinor, weightedMonthMinor, stagesWithoutChance };
}

/**
 * The months the report's forecast names (ADR-252): the month containing `at` in `timeZone` and
 * the next two, as YYYY-MM.
 */
export function forecastMonths(at: Date, timeZone: string): [string, string, string] {
  const today = zonedParts(at.getTime(), timeZone);
  const month = (offset: number) => {
    // Calendar arithmetic in UTC, which has no daylight saving.
    const first = new Date(Date.UTC(today.year, today.month - 1 + offset, 1));
    return `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  return [month(0), month(1), month(2)];
}

/** Where the report counts an open deal by its expected close date (ADR-252). */
export const CLOSE_BUCKETS = [
  'this_month',
  'next_month',
  'month_after',
  'later',
  'undated',
] as const;
export type CloseBucket = (typeof CLOSE_BUCKETS)[number];

/**
 * The bucket of a deal expected to close in `month` (YYYY-MM, or null without a date). A date
 * already past counts in this month, as on the board (ADR-242).
 */
export function closeBucket(
  month: string | null,
  months: readonly [string, string, string],
): CloseBucket {
  if (month === null) return 'undated';
  if (month <= months[0]) return 'this_month';
  if (month === months[1]) return 'next_month';
  if (month === months[2]) return 'month_after';
  return 'later';
}

/** Open deals of one stage expected to close in one month (or without a date). */
export interface ForecastGroup {
  stageId: string;
  winPercent: number | null;
  closeMonth: string | null;
  deals: number;
  valueMinor: number;
}

export interface ForecastBucket {
  bucket: CloseBucket;
  deals: number;
  valueMinor: number;
  /** Each stage's value in the bucket times its chance; stages without a chance add nothing. */
  weightedMinor: number;
}

export interface MonthForecast {
  months: [string, string, string];
  buckets: ForecastBucket[];
  /** Whether any of the deals is in a stage with a chance: without one there is nothing to weigh. */
  hasChances: boolean;
  /** Deals counted in the buckets but left out of the weighted value: their stage has no chance. */
  dealsWithoutChance: number;
}

/**
 * A pipeline's open deals by expected close month (ADR-252). Each stage's value in a bucket is
 * weighed once, as the board weighs a stage's total, so this month's weighted value is the board's.
 */
export function forecastByMonth(
  groups: readonly ForecastGroup[],
  months: [string, string, string],
): MonthForecast {
  const perStage = new Map<
    string,
    { bucket: CloseBucket; winPercent: number | null; deals: number; valueMinor: number }
  >();
  for (const g of groups) {
    const bucket = closeBucket(g.closeMonth, months);
    const key = `${g.stageId}:${bucket}`;
    const entry = perStage.get(key) ?? {
      bucket,
      winPercent: g.winPercent,
      deals: 0,
      valueMinor: 0,
    };
    entry.deals += g.deals;
    entry.valueMinor += g.valueMinor;
    perStage.set(key, entry);
  }
  const buckets = CLOSE_BUCKETS.map((bucket): ForecastBucket => ({
    bucket,
    deals: 0,
    valueMinor: 0,
    weightedMinor: 0,
  }));
  let hasChances = false;
  let dealsWithoutChance = 0;
  for (const entry of perStage.values()) {
    const total = buckets[CLOSE_BUCKETS.indexOf(entry.bucket)] as ForecastBucket;
    total.deals += entry.deals;
    total.valueMinor += entry.valueMinor;
    if (entry.winPercent === null) {
      dealsWithoutChance += entry.deals;
      continue;
    }
    hasChances = true;
    total.weightedMinor += weigh(entry.valueMinor, entry.winPercent);
  }
  return { months, buckets, hasChances, dealsWithoutChance };
}
