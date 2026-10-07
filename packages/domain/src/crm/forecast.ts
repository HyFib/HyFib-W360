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
