import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../authz/permissions';
import {
  addOnsForPlan,
  MODULE_WRITE_PERMISSIONS,
  PLAN_BOUNDS,
  PLAN_MODULE_KEYS,
  moduleOfPermission,
  planGivesAccess,
  planPaymentQuote,
  planPaymentStart,
  PLAN_PAYMENT_TRIAL_LEAD_MS,
  usagePeriod,
  warningThreshold,
} from './model';

const at = (iso: string) => new Date(iso);

describe('usagePeriod', () => {
  it('starts monthly periods on the anchor day and keeps its time of day', () => {
    const anchor = at('2026-01-05T10:30:00.000Z');
    expect(usagePeriod(anchor, at('2026-01-05T10:30:00.000Z'))).toEqual({
      start: at('2026-01-05T10:30:00.000Z'),
      end: at('2026-02-05T10:30:00.000Z'),
    });
    expect(usagePeriod(anchor, at('2026-02-05T10:29:59.999Z'))).toEqual({
      start: at('2026-01-05T10:30:00.000Z'),
      end: at('2026-02-05T10:30:00.000Z'),
    });
    // The period changes exactly at the anchor instant, not at midnight.
    expect(usagePeriod(anchor, at('2026-02-05T10:30:00.000Z')).start).toEqual(
      at('2026-02-05T10:30:00.000Z'),
    );
    expect(usagePeriod(anchor, at('2027-03-20T00:00:00.000Z'))).toEqual({
      start: at('2027-03-05T10:30:00.000Z'),
      end: at('2027-04-05T10:30:00.000Z'),
    });
  });

  it('uses the last day of shorter months and returns to the anchor day after them', () => {
    const anchor = at('2026-01-31T00:00:00.000Z');
    expect(usagePeriod(anchor, at('2026-02-15T00:00:00.000Z'))).toEqual({
      start: at('2026-01-31T00:00:00.000Z'),
      end: at('2026-02-28T00:00:00.000Z'),
    });
    expect(usagePeriod(anchor, at('2026-03-01T00:00:00.000Z'))).toEqual({
      start: at('2026-02-28T00:00:00.000Z'),
      end: at('2026-03-31T00:00:00.000Z'),
    });
    expect(usagePeriod(anchor, at('2026-04-30T12:00:00.000Z'))).toEqual({
      start: at('2026-04-30T00:00:00.000Z'),
      end: at('2026-05-31T00:00:00.000Z'),
    });
    // Leap year.
    expect(usagePeriod(anchor, at('2028-02-29T12:00:00.000Z')).start).toEqual(
      at('2028-02-29T00:00:00.000Z'),
    );
  });

  it('periods are contiguous, and a moment before the anchor falls in the first one', () => {
    const anchor = at('2026-03-31T23:59:00.000Z');
    let previous = usagePeriod(anchor, anchor);
    for (let i = 0; i < 30; i += 1) {
      const next = usagePeriod(anchor, previous.end);
      expect(next.start).toEqual(previous.end);
      expect(next.end.getTime()).toBeGreaterThan(next.start.getTime());
      previous = next;
    }
    expect(usagePeriod(anchor, at('2026-03-01T00:00:00.000Z')).start).toEqual(anchor);
  });
});

describe('plan modules', () => {
  it('each module takes away only write permissions that exist, and reading stays', () => {
    const all = new Set<string>(PERMISSIONS);
    for (const module of PLAN_MODULE_KEYS) {
      for (const permission of MODULE_WRITE_PERMISSIONS[module]) {
        expect(all.has(permission)).toBe(true);
        expect(permission.endsWith('.read')).toBe(false);
        expect(moduleOfPermission(permission)).toBe(module);
      }
    }
    expect(moduleOfPermission('automations.read')).toBeNull();
    expect(moduleOfPermission('campaigns.send')).toBeNull();
    expect(moduleOfPermission('commerce.manage')).toBe('commerce');
  });

  it('only expired and canceled plans restrict a company', () => {
    expect(planGivesAccess('complimentary')).toBe(true);
    expect(planGivesAccess('trialing')).toBe(true);
    expect(planGivesAccess('active')).toBe(true);
    expect(planGivesAccess('past_due')).toBe(true);
    expect(planGivesAccess('expired')).toBe(false);
    expect(planGivesAccess('canceled')).toBe(false);
  });
});

describe('addOnsForPlan', () => {
  const kept = { extraSeats: '4', extraNumbers: '2', runPacks: '3' };
  it('keeps only the add-ons the chosen plan sells', () => {
    const plan = { sellsSeats: true, sellsNumbers: false, sellsRunPacks: true };
    expect(addOnsForPlan(plan, kept)).toEqual({
      extraSeats: '4',
      extraNumbers: '0',
      runPacks: '3',
    });
    expect(
      addOnsForPlan({ sellsSeats: false, sellsNumbers: false, sellsRunPacks: false }, kept),
    ).toEqual({ extraSeats: '0', extraNumbers: '0', runPacks: '0' });
    expect(addOnsForPlan(undefined, kept)).toEqual({
      extraSeats: '0',
      extraNumbers: '0',
      runPacks: '0',
    });
  });
});

describe('warningThreshold', () => {
  it('is 80% of a monthly limit rounded up, when that is still below the limit', () => {
    expect(warningThreshold(5)).toBe(4);
    expect(warningThreshold(7)).toBe(6);
    expect(warningThreshold(10)).toBe(8);
    expect(warningThreshold(11)).toBe(9);
    expect(warningThreshold(1_000)).toBe(800);
    expect(warningThreshold(1_000_000_000)).toBe(800_000_000);
  });

  it('gives no warning without a limit, for no allowance, or when 80% rounds up to the limit', () => {
    for (const limit of [null, 0, 1, 2, 3, 4]) expect(warningThreshold(limit)).toBeNull();
  });
});

describe('planPaymentQuote', () => {
  const prices = {
    priceMinor: 99_900,
    seatPriceMinor: 10_000,
    numberPriceMinor: 50_000,
    runPackPriceMinor: 25_000,
  };
  const none = { extraSeats: 0, extraNumbers: 0, runPacks: 0 };

  it('adds the add-ons at the version’s prices and the tax, rounded half up to the paisa', () => {
    expect(planPaymentQuote(prices, { extraSeats: 2, extraNumbers: 1, runPacks: 3 }, 1800)).toEqual(
      {
        ok: true,
        quote: {
          planMinor: 99_900,
          seatsMinor: 20_000,
          numbersMinor: 50_000,
          runPacksMinor: 75_000,
          subtotalMinor: 244_900,
          taxBp: 1800,
          taxMinor: 44_082,
          totalMinor: 288_982,
        },
      },
    );
    // 12.5% of ₹999.00 is ₹124.875: half a paisa rounds up.
    expect(planPaymentQuote(prices, none, 1250)).toMatchObject({
      quote: { taxMinor: 12_488, totalMinor: 112_388 },
    });
    // 0.01% of ₹49.99 is 0.4999 paise and rounds down; of ₹50.00, half a paisa rounds up.
    expect(planPaymentQuote({ ...prices, priceMinor: 4_999 }, none, 1)).toMatchObject({
      quote: { taxMinor: 0, totalMinor: 4_999 },
    });
    expect(planPaymentQuote({ ...prices, priceMinor: 5_000 }, none, 1)).toMatchObject({
      quote: { taxMinor: 1, totalMinor: 5_001 },
    });
    expect(planPaymentQuote(prices, none, 0)).toMatchObject({
      quote: { taxMinor: 0, totalMinor: 99_900 },
    });
  });

  it('is exact where floating point would not be, up to HyFib’s ceiling', () => {
    // 3 × 10¹³ paise with 17.99% tax: beyond what a double holds to the paisa.
    const big = planPaymentQuote(
      {
        priceMinor: 300_000_000_000,
        seatPriceMinor: null,
        numberPriceMinor: null,
        runPackPriceMinor: null,
      },
      none,
      1799,
    );
    expect(big).toEqual({
      ok: true,
      quote: expect.objectContaining({ taxMinor: 53_970_000_000, totalMinor: 353_970_000_000 }),
    });
    expect(
      planPaymentQuote(
        { ...prices, priceMinor: PLAN_BOUNDS.priceMinor, seatPriceMinor: PLAN_BOUNDS.priceMinor },
        { extraSeats: 10_000, extraNumbers: 0, runPacks: 0 },
        5000,
      ),
    ).toEqual({ ok: false, reason: 'too_large' });
    expect(
      planPaymentQuote({ ...prices, priceMinor: PLAN_BOUNDS.priceMinor }, none, 0),
    ).toMatchObject({
      ok: true,
    });
    expect(planPaymentQuote({ ...prices, priceMinor: PLAN_BOUNDS.priceMinor }, none, 1)).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('refuses add-ons the version does not sell and totals below ₹1', () => {
    const unsold = { ...prices, seatPriceMinor: null };
    expect(planPaymentQuote(unsold, { ...none, extraSeats: 1 }, 1800)).toEqual({
      ok: false,
      reason: 'add_on_not_sold',
    });
    expect(planPaymentQuote(unsold, none, 1800)).toMatchObject({ ok: true });
    expect(planPaymentQuote({ ...prices, priceMinor: 0 }, none, 1800)).toEqual({
      ok: false,
      reason: 'too_small',
    });
    expect(planPaymentQuote({ ...prices, priceMinor: 84 }, none, 1800)).toEqual({
      ok: false,
      reason: 'too_small',
    });
    expect(planPaymentQuote({ ...prices, priceMinor: 85 }, none, 1800)).toMatchObject({
      quote: { totalMinor: 100 },
    });
  });
});

describe('planPaymentStart (ADR-102)', () => {
  const now = at('2026-10-01T06:00:00Z');
  const trial = (trialEndsAt: Date | null) => ({ status: 'trialing' as const, trialEndsAt });

  it('pays a trial ending at least two days ahead from its end', () => {
    expect(PLAN_PAYMENT_TRIAL_LEAD_MS).toBe(48 * 3600_000);
    const exactly = new Date(now.getTime() + PLAN_PAYMENT_TRIAL_LEAD_MS);
    expect(planPaymentStart(trial(exactly), now)).toEqual(exactly);
    const later = at('2026-10-15T18:30:00Z');
    expect(planPaymentStart(trial(later), now)).toEqual(later);
  });

  it('charges at once for a trial ending sooner, and for anything but a trial', () => {
    expect(
      planPaymentStart(trial(new Date(now.getTime() + PLAN_PAYMENT_TRIAL_LEAD_MS - 1)), now),
    ).toBeNull();
    expect(planPaymentStart(trial(new Date(now.getTime() - 1)), now)).toBeNull();
    expect(planPaymentStart(trial(null), now)).toBeNull();
    const later = at('2026-10-15T18:30:00Z');
    for (const status of ['active', 'past_due', 'expired', 'canceled', 'complimentary'] as const) {
      expect(planPaymentStart({ status, trialEndsAt: later }, now)).toBeNull();
    }
  });
});
