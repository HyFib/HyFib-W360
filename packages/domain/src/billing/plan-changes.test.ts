import { describe, expect, it } from 'vitest';
import {
  PLAN_CHANGE_UNAVAILABLE_TEXT,
  addOnsKeepingCapacity,
  planChangeAddOns,
  planChangeFromPeriodEndUnavailable,
  planChangeSchema,
} from './plan-changes';

const NOW = new Date('2026-10-02T10:00:00Z');
const HOUR_MS = 3_600_000;

/** A company that can change its plan: active, paid by an active subscription, a month to go. */
const facts = {
  companyStatus: 'active',
  planStatus: 'active' as const,
  periodEnd: new Date(NOW.getTime() + 30 * 24 * HOUR_MS),
  paying: { status: 'active' as const },
  subscriptionsEnabled: true,
  taxBp: 1800,
  now: NOW,
};

/** A version with 3 seats included, extra seats at ₹100 up to 10, 1 number, run packs of 500. */
const growth = {
  seatsIncluded: 3,
  seatPriceMinor: 10_000,
  seatsMax: 10,
  numbersIncluded: 1,
  numberPriceMinor: null,
  numbersMax: null,
  runPackSize: 500,
  runPackPriceMinor: 20_000,
  automationRunsMonthly: 1000,
};

describe('changing the plan from the end of the paid period (ADR-109)', () => {
  it('is open to a company paying by a subscription that ends or keeps charging, at least 48 hours before the period ends', () => {
    expect(planChangeFromPeriodEndUnavailable(facts)).toBeNull();
    for (const status of ['cancelled', 'completed', 'expired'] as const) {
      expect(
        planChangeFromPeriodEndUnavailable({ ...facts, paying: { status } }),
        status,
      ).toBeNull();
    }
    const exactly = new Date(NOW.getTime() + 48 * HOUR_MS);
    expect(planChangeFromPeriodEndUnavailable({ ...facts, periodEnd: exactly })).toBeNull();
    expect(
      planChangeFromPeriodEndUnavailable({ ...facts, periodEnd: new Date(exactly.getTime() - 1) }),
    ).toBe('too_late');
  });

  it('says why not, company first, then paying for plans, the paid period, the subscription and the time', () => {
    expect(
      planChangeFromPeriodEndUnavailable({ ...facts, companyStatus: 'pending_deletion' }),
    ).toBe('deleting');
    expect(planChangeFromPeriodEndUnavailable({ ...facts, companyStatus: 'deleted' })).toBe(
      'deleting',
    );
    expect(planChangeFromPeriodEndUnavailable({ ...facts, companyStatus: 'suspended' })).toBe(
      'suspended',
    );
    expect(planChangeFromPeriodEndUnavailable({ ...facts, subscriptionsEnabled: false })).toBe(
      'not_offered',
    );
    expect(planChangeFromPeriodEndUnavailable({ ...facts, taxBp: null })).toBe('not_offered');
    for (const planStatus of [
      'trialing',
      'past_due',
      'expired',
      'canceled',
      'complimentary',
    ] as const) {
      expect(planChangeFromPeriodEndUnavailable({ ...facts, planStatus }), planStatus).toBe(
        'not_paying',
      );
    }
    // A period HyFib staff set has no subscription that paid it.
    expect(planChangeFromPeriodEndUnavailable({ ...facts, paying: null })).toBe('not_paying');
    expect(planChangeFromPeriodEndUnavailable({ ...facts, periodEnd: null })).toBe('not_paying');
    for (const status of ['pending', 'halted', 'paused'] as const) {
      expect(planChangeFromPeriodEndUnavailable({ ...facts, paying: { status } }), status).toBe(
        'not_charging',
      );
    }
    // The company comes first: a deleting company with a failing charge is deleting.
    expect(
      planChangeFromPeriodEndUnavailable({
        ...facts,
        companyStatus: 'pending_deletion',
        paying: { status: 'halted' },
        periodEnd: NOW,
      }),
    ).toBe('deleting');
    expect(Object.keys(PLAN_CHANGE_UNAVAILABLE_TEXT).sort()).toEqual(
      ['deleting', 'not_charging', 'not_offered', 'not_paying', 'suspended', 'too_late'].sort(),
    );
  });

  it('bounds each add-on the version sells by what it sells and what the company uses, starting from what it asks for', () => {
    const options = planChangeAddOns(
      growth,
      { extraSeats: 20, extraNumbers: 4, runPacks: 2 },
      { seats: 5, numbers: 1 },
    );
    // Seats: 2 more than included are in use, at most 7 more are sold; numbers are not sold.
    expect(options).toEqual([
      {
        kind: 'seats',
        quantity: 7,
        min: 2,
        max: 7,
        unitPriceMinor: 10_000,
        unitSize: 1,
        included: 3,
        used: 5,
      },
      {
        kind: 'runPacks',
        quantity: 2,
        min: 0,
        max: 10_000,
        unitPriceMinor: 20_000,
        unitSize: 500,
        included: 1000,
        used: null,
      },
    ]);
    // Too few asked for: raised to what the company needs.
    expect(
      planChangeAddOns(
        growth,
        { extraSeats: 0, extraNumbers: 0, runPacks: 0 },
        { seats: 5, numbers: 1 },
      )[0],
    ).toMatchObject({
      quantity: 2,
    });
    // More in use than the version can ever hold: min above max.
    expect(
      planChangeAddOns(
        growth,
        { extraSeats: 0, extraNumbers: 0, runPacks: 0 },
        { seats: 12, numbers: 1 },
      )[0],
    ).toMatchObject({
      min: 9,
      max: 7,
    });
    // Without a maximum, numbers go up to 100 in all.
    expect(
      planChangeAddOns(
        { ...growth, numberPriceMinor: 5000 },
        { extraSeats: 0, extraNumbers: 200, runPacks: 0 },
        { seats: 1, numbers: 1 },
      ).find((o) => o.kind === 'numbers'),
    ).toMatchObject({ quantity: 99, max: 99, min: 0 });
  });

  it('starts another version from the capacity the company has now', () => {
    const current = {
      seatsIncluded: 3,
      numbersIncluded: 1,
      automationRunsMonthly: 1000,
      runPackSize: 500,
    };
    const pro = {
      seatsIncluded: 5,
      numbersIncluded: 2,
      automationRunsMonthly: 1200,
      runPackSize: 300,
    };
    // 3 + 4 seats, 1 + 2 numbers, 1000 + 3 × 500 runs: Pro needs 2 seats, 1 number, ⌈1300 / 300⌉ packs.
    expect(
      addOnsKeepingCapacity(current, { extraSeats: 4, extraNumbers: 2, runPacks: 3 }, pro),
    ).toEqual({
      extraSeats: 2,
      extraNumbers: 1,
      runPacks: 5,
    });
    // More included than the company has: no add-ons.
    expect(
      addOnsKeepingCapacity(current, { extraSeats: 1, extraNumbers: 0, runPacks: 0 }, pro),
    ).toEqual({
      extraSeats: 0,
      extraNumbers: 0,
      runPacks: 0,
    });
    // No monthly runs limit on either side: no packs.
    expect(
      addOnsKeepingCapacity(
        { ...current, automationRunsMonthly: null },
        { extraSeats: 0, extraNumbers: 0, runPacks: 2 },
        pro,
      ).runPacks,
    ).toBe(0);
    expect(
      addOnsKeepingCapacity(
        current,
        { extraSeats: 0, extraNumbers: 0, runPacks: 2 },
        { ...pro, runPackSize: null },
      ).runPacks,
    ).toBe(0);
    expect(
      addOnsKeepingCapacity(null, { extraSeats: 3, extraNumbers: 3, runPacks: 3 }, pro),
    ).toEqual({
      extraSeats: 0,
      extraNumbers: 0,
      runPacks: 0,
    });
  });

  it('reads the form: a version id and whole numbers, empty for none', () => {
    const planId = '0190a5b2-0000-7000-8000-000000000001';
    expect(
      planChangeSchema.parse({ planId, extraSeats: ' 2 ', extraNumbers: '', runPacks: '0' }),
    ).toEqual({ planId, extraSeats: 2, extraNumbers: 0, runPacks: 0 });
    for (const bad of ['two', '-1', '1.5', '10001']) {
      expect(
        planChangeSchema.safeParse({ planId, extraSeats: bad, extraNumbers: '0', runPacks: '0' })
          .success,
        bad,
      ).toBe(false);
    }
    expect(
      planChangeSchema.safeParse({ planId, extraSeats: '0', extraNumbers: '101', runPacks: '0' })
        .success,
    ).toBe(false);
    expect(
      planChangeSchema.safeParse({
        planId: 'nope',
        extraSeats: '0',
        extraNumbers: '0',
        runPacks: '0',
      }).success,
    ).toBe(false);
  });
});
