import { describe, expect, it } from 'vitest';
import type { CostReport } from '../reports/service';
import {
  chargesByCategory,
  compareRateCards,
  formatRateChange,
  priceKey,
  type RateCardView,
} from './usage';

function card(prices: [string, Parameters<typeof priceKey>[1], number][]): RateCardView {
  return {
    id: 'card',
    currency: 'AED',
    effectiveFrom: new Date('2026-07-01T00:00:00Z'),
    sourceUrl: 'https://developers.facebook.com/docs/whatsapp/pricing',
    notes: null,
    markets: [...new Set(prices.map(([market]) => market))].sort(),
    prices: new Map(
      prices.map(([market, category, micros]) => [priceKey(market, category), micros]),
    ),
  };
}

function report(lines: CostReport['lines']): CostReport {
  return {
    currency: 'AED',
    cards: [],
    delivered: 0,
    billable: 0,
    free: 0,
    notReported: 0,
    priced: 0,
    totalMicros: lines.reduce((sum, l) => sum + l.micros, 0),
    lines,
    unpriced: { noCurrency: 0, noRateCard: 0, otherCategory: 0, marketUnknown: 0, noPrice: 0 },
  };
}

describe('comparing rate cards', () => {
  it('lists every price the next card changes, adds or no longer lists, market by market', () => {
    const current = card([
      ['India', 'marketing', 785_000],
      ['India', 'utility', 115_000],
      ['India', 'authentication', 115_000],
      ['Singapore', 'marketing', 4_620_000],
    ]);
    const next = card([
      ['India', 'marketing', 865_000],
      ['India', 'utility', 115_000],
      ['India', 'service', 42_000],
      ['United Arab Emirates', 'marketing', 1_400_000],
    ]);
    expect(compareRateCards(current, next)).toEqual([
      { market: 'India', category: 'marketing', currentMicros: 785_000, nextMicros: 865_000 },
      { market: 'India', category: 'authentication', currentMicros: 115_000, nextMicros: null },
      { market: 'India', category: 'service', currentMicros: null, nextMicros: 42_000 },
      { market: 'Singapore', category: 'marketing', currentMicros: 4_620_000, nextMicros: null },
      {
        market: 'United Arab Emirates',
        category: 'marketing',
        currentMicros: null,
        nextMicros: 1_400_000,
      },
    ]);
  });

  it('finds nothing to show when the prices stay the same, and treats a zero price as a price', () => {
    const prices: [string, 'utility' | 'service', number][] = [
      ['India', 'utility', 115_000],
      ['India', 'service', 0],
    ];
    expect(compareRateCards(card(prices), card(prices))).toEqual([]);
    expect(compareRateCards(card([['India', 'service', 0]]), card([]))).toEqual([
      { market: 'India', category: 'service', currentMicros: 0, nextMicros: null },
    ]);
  });
});

describe('describing a price change', () => {
  const change = (currentMicros: number | null, nextMicros: number | null) =>
    formatRateChange({ market: 'India', category: 'marketing', currentMicros, nextMicros }, 'AUD');

  it('gives the difference with its percentage, a minus sign for a lower price, and no percentage from zero', () => {
    expect(change(785_000, 865_000)).toBe('+0.08 AUD (+10.2%)');
    expect(change(115_000, 100_000)).toBe('−0.015 AUD (−13.0%)');
    expect(change(0, 42_000)).toBe('+0.042 AUD');
    expect(change(42_000, 0)).toBe('−0.042 AUD (−100.0%)');
  });

  it('names a price the next card adds or no longer lists', () => {
    expect(change(null, 42_000)).toBe('New price');
    expect(change(115_000, null)).toBe('No longer priced');
    expect(change(0, null)).toBe('No longer priced');
  });
});

describe('charges by category', () => {
  it('adds up the markets of each category, most expensive first, ties in category order', () => {
    expect(
      chargesByCategory(
        report([
          { category: 'utility', market: 'India', count: 10, micros: 1_150_000 },
          { category: 'marketing', market: 'India', count: 2, micros: 1_000_000 },
          { category: 'utility', market: 'Singapore', count: 1, micros: 420_000 },
          // A tie: listed service first, shown in category order.
          { category: 'service', market: 'India', count: 3, micros: 345_000 },
          { category: 'authentication', market: 'India', count: 3, micros: 345_000 },
        ]),
      ),
    ).toEqual([
      { category: 'utility', count: 11, micros: 1_570_000 },
      { category: 'marketing', count: 2, micros: 1_000_000 },
      { category: 'authentication', count: 3, micros: 345_000 },
      { category: 'service', count: 3, micros: 345_000 },
    ]);
    expect(chargesByCategory(report([]))).toEqual([]);
  });
});
