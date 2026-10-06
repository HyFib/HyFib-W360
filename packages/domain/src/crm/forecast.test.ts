import { describe, expect, it } from 'vitest';
import { forecast, weigh, type StageTotals } from './forecast';
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
