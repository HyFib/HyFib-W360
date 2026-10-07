import { describe, expect, it } from 'vitest';
import {
  closeBucket,
  forecast,
  forecastByMonth,
  forecastMonths,
  weigh,
  type ForecastGroup,
  type StageTotals,
} from './forecast';
import {
  createPipelineSchema,
  newStageSchema,
  updatePipelineSchema,
  winPercentSchema,
} from './pipelines';
import { monthEndIn } from './time';

const stage = (overrides: Partial<StageTotals>): StageTotals => ({
  count: 2,
  valueMinor: 100_000,
  monthValueMinor: 40_000,
  winPercent: 50,
  ...overrides,
});

describe('the weighted pipeline (ADR-242)', () => {
  it('weighs a value by a chance, to the minor unit', () => {
    expect(weigh(100_000, 25)).toBe(25_000);
    expect(weigh(1_005, 50)).toBe(503);
    expect(weigh(1_001, 50)).toBe(501);
    expect(weigh(999, 0)).toBe(0);
    expect(weigh(999, 100)).toBe(999);
  });

  it('adds the stages that have a chance and counts those with deals that have none', () => {
    expect(
      forecast([
        stage({}),
        stage({ valueMinor: 30_000, monthValueMinor: 30_000, winPercent: 10 }),
        stage({ winPercent: null }),
        stage({ count: 0, valueMinor: 0, monthValueMinor: 0, winPercent: null }),
      ]),
    ).toEqual({
      hasChances: true,
      weightedMinor: 50_000 + 3_000,
      weightedMonthMinor: 20_000 + 3_000,
      stagesWithoutChance: 1,
    });
    // A chance of 0% is a chance: the stage weighs nothing but is not left out.
    expect(forecast([stage({ winPercent: 0 })])).toEqual({
      hasChances: true,
      weightedMinor: 0,
      weightedMonthMinor: 0,
      stagesWithoutChance: 0,
    });
    expect(forecast([stage({ winPercent: null })])).toMatchObject({
      hasChances: false,
      stagesWithoutChance: 1,
    });
    expect(forecast([])).toMatchObject({ hasChances: false, weightedMinor: 0 });
  });

  it('ends the month in the company’s time', () => {
    expect(monthEndIn(new Date('2026-10-06T12:00:00Z'), 'Asia/Kolkata')).toBe('2026-10-31');
    // Already November in Kolkata, still October in UTC.
    expect(monthEndIn(new Date('2026-10-31T20:00:00Z'), 'Asia/Kolkata')).toBe('2026-11-30');
    expect(monthEndIn(new Date('2026-10-31T20:00:00Z'), 'UTC')).toBe('2026-10-31');
    expect(monthEndIn(new Date('2028-02-10T00:00:00Z'), 'UTC')).toBe('2028-02-29');
    expect(monthEndIn(new Date('2026-12-31T23:00:00Z'), 'UTC')).toBe('2026-12-31');
  });

  it('takes a chance per stage as a whole percentage, or none', () => {
    for (const ok of [0, 35, 100, null]) expect(winPercentSchema.safeParse(ok).success).toBe(true);
    for (const wrong of [-1, 101, 12.5, '40', Number.NaN]) {
      expect(winPercentSchema.safeParse(wrong).success, String(wrong)).toBe(false);
    }
    // A new pipeline's stages are names, or names with chances.
    expect(newStageSchema.parse(' New ')).toEqual({ name: 'New', winPercent: null });
    expect(newStageSchema.parse({ name: 'Proposal', winPercent: 60 })).toEqual({
      name: 'Proposal',
      winPercent: 60,
    });
    expect(newStageSchema.parse({ name: 'Proposal' })).toEqual({
      name: 'Proposal',
      winPercent: null,
    });
    expect(
      createPipelineSchema.safeParse({
        name: 'Sales',
        currency: 'INR',
        stages: [{ name: 'New', winPercent: 120 }],
      }).success,
    ).toBe(false);
    // An update without a stage's chance leaves it as it is.
    const update = updatePipelineSchema.parse({
      id: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01',
      expectedVersion: 1,
      name: 'Sales',
      stages: [
        { id: null, name: 'New' },
        { id: null, name: 'Won soon', winPercent: 90 },
        { id: null, name: 'Unsure', winPercent: null },
      ],
    });
    expect(update.stages.map((s) => s.winPercent)).toEqual([undefined, 90, null]);
  });
});

describe('the forecast by month in Reports (ADR-252)', () => {
  const months: [string, string, string] = ['2026-10', '2026-11', '2026-12'];

  it('names this month and the next two in the company’s time, across a year end', () => {
    expect(forecastMonths(new Date('2026-10-06T12:00:00Z'), 'Asia/Kolkata')).toEqual(months);
    // Already November in Kolkata, still October in UTC.
    expect(forecastMonths(new Date('2026-10-31T20:00:00Z'), 'Asia/Kolkata')).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
    ]);
    expect(forecastMonths(new Date('2026-10-31T20:00:00Z'), 'UTC')).toEqual(months);
  });

  it('counts a past date in this month, as the board does, and a date beyond the third month as later', () => {
    expect(closeBucket('2026-10', months)).toBe('this_month');
    expect(closeBucket('2026-03', months)).toBe('this_month');
    expect(closeBucket('2025-12', months)).toBe('this_month');
    expect(closeBucket('2026-11', months)).toBe('next_month');
    expect(closeBucket('2026-12', months)).toBe('month_after');
    expect(closeBucket('2027-01', months)).toBe('later');
    expect(closeBucket(null, months)).toBe('undated');
  });

  it('weighs each stage’s deals in a bucket once, and counts the deals of stages without a chance apart', () => {
    const group = (overrides: Partial<ForecastGroup>): ForecastGroup => ({
      stageId: 'qualified',
      winPercent: 50,
      closeMonth: '2026-10',
      deals: 1,
      valueMinor: 1_001,
      ...overrides,
    });
    const result = forecastByMonth(
      [
        // Overdue and this month in one stage: 1,001 + 1,001 weighed at 50% once (1,001), not 501 + 501.
        group({}),
        group({ closeMonth: '2026-09' }),
        group({ stageId: 'proposal', winPercent: 80, closeMonth: '2026-11', valueMinor: 10_000 }),
        group({ closeMonth: '2026-12', deals: 2, valueMinor: 0 }),
        group({ closeMonth: '2027-03', valueMinor: 5_000 }),
        group({ stageId: 'new', winPercent: null, closeMonth: null, deals: 3, valueMinor: 9_000 }),
        group({ closeMonth: null, valueMinor: 2_000 }),
      ],
      months,
      [50, 80, null],
    );
    expect(result).toEqual({
      months,
      buckets: [
        { bucket: 'this_month', deals: 2, valueMinor: 2_002, weightedMinor: 1_001 },
        { bucket: 'next_month', deals: 1, valueMinor: 10_000, weightedMinor: 8_000 },
        { bucket: 'month_after', deals: 2, valueMinor: 0, weightedMinor: 0 },
        { bucket: 'later', deals: 1, valueMinor: 5_000, weightedMinor: 2_500 },
        { bucket: 'undated', deals: 4, valueMinor: 11_000, weightedMinor: 1_000 },
      ],
      hasChances: true,
      dealsWithoutChance: 3,
    });
    // Only stages without a chance: nothing to weigh.
    expect(
      forecastByMonth(
        [group({ winPercent: null }), group({ stageId: 'new', winPercent: null })],
        months,
        [null, null],
      ),
    ).toMatchObject({ hasChances: false, dealsWithoutChance: 2 });
    expect(forecastByMonth([], months, []).buckets.map((b) => b.deals)).toEqual([0, 0, 0, 0, 0]);
  });

  it('weighs when any active stage has a chance, even one without open deals, as the board does', () => {
    // Found in review: the only stage with a chance holds no open deals.
    const unweighed: ForecastGroup = {
      stageId: 'new',
      winPercent: null,
      closeMonth: null,
      deals: 2,
      valueMinor: 4_000,
    };
    const result = forecastByMonth([unweighed], months, [null, 60]);
    expect(result).toMatchObject({ hasChances: true, dealsWithoutChance: 2 });
    expect(result.buckets.map((b) => b.weightedMinor)).toEqual([0, 0, 0, 0, 0]);
    expect(forecastByMonth([], months, [25]).hasChances).toBe(true);
    expect(forecastByMonth([unweighed], months, [null, null]).hasChances).toBe(false);
    // The board says the same of the same stages.
    expect(
      forecast([
        stage({ winPercent: null }),
        stage({ count: 0, valueMinor: 0, monthValueMinor: 0, winPercent: 60 }),
      ]).hasChances,
    ).toBe(true);
  });
});
