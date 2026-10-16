import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import {
  addDealItemSchema,
  dealItemsTotal,
  lineTotalMinor,
  MAX_DEAL_ITEMS,
  MAX_ITEM_QUANTITY,
  parseUnitPrice,
  removeDealItemSchema,
} from './deal-items';
import { MAX_DEAL_MINOR } from './money';

const ID = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';

describe('products on deals (ADR-375)', () => {
  it('total exactly in the deal’s currency, or not at all when an item is in another', () => {
    expect(lineTotalMinor({ quantity: 3, unitPriceMinor: 2_500_050 })).toBe(7_500_150n);
    const items = [
      { quantity: 3, unitPriceMinor: 1999, currency: 'INR' },
      { quantity: 1, unitPriceMinor: 1, currency: 'INR' },
    ];
    expect(dealItemsTotal(items, 'INR')).toEqual({ totalMinor: 5998, otherCurrency: false });
    expect(dealItemsTotal([], 'INR')).toEqual({ totalMinor: 0, otherCurrency: false });
    expect(dealItemsTotal(items, 'USD')).toEqual({ totalMinor: null, otherCurrency: true });
    // At most what a deal's value holds, summed without losing precision.
    const big = { quantity: 1, unitPriceMinor: MAX_DEAL_MINOR, currency: 'INR' };
    expect(dealItemsTotal([big], 'INR').totalMinor).toBe(MAX_DEAL_MINOR);
    expect(dealItemsTotal([big, { ...big, unitPriceMinor: 1 }], 'INR')).toEqual({
      totalMinor: null,
      otherCurrency: false,
    });
  });

  it('take a product, a whole quantity from 1 to 100,000 and a unit price, at the deal’s version', () => {
    expect(MAX_DEAL_ITEMS).toBe(50);
    expect(MAX_ITEM_QUANTITY).toBe(100_000);
    const base = { dealId: ID, expectedVersion: 2, productId: ID, unitPrice: '1,500.50' };
    expect(addDealItemSchema.parse({ ...base, quantity: '3' }).quantity).toBe(3);
    expect(addDealItemSchema.safeParse({ ...base, quantity: 100_000 }).success).toBe(true);
    for (const bad of [
      { quantity: 0 },
      { quantity: 1.5 },
      { quantity: 100_001 },
      { quantity: 'many' },
      { quantity: 1, unitPrice: ' ' },
      { quantity: 1, productId: 'soap' },
      { quantity: 1, expectedVersion: 0 },
    ]) {
      expect(addDealItemSchema.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
    expect(
      removeDealItemSchema.safeParse({ dealId: ID, expectedVersion: 1, itemId: ID }).success,
    ).toBe(true);
    expect(removeDealItemSchema.safeParse({ dealId: ID, expectedVersion: 1 }).success).toBe(false);
  });

  it('read unit prices exactly in the currency, refusing what it cannot hold', () => {
    expect(parseUnitPrice('1,500.50', 'INR')).toBe(150_050);
    expect(parseUnitPrice('0', 'INR')).toBe(0);
    expect(parseUnitPrice('1500', 'JPY')).toBe(1500);
    const refusal = (text: string, currency: string) => {
      try {
        parseUnitPrice(text, currency);
      } catch (error) {
        if (isAppError(error)) return [error.publicMessage, error.issues?.[0]?.path];
        throw error;
      }
      throw new Error('expected a refusal');
    };
    expect(refusal('1.505', 'INR')).toEqual([
      'Enter the unit price in INR with at most 2 decimals.',
      'unitPrice',
    ]);
    expect(refusal('10.5', 'JPY')[0]).toBe('Enter the unit price in JPY as a whole number.');
    expect(refusal('-1', 'INR')[0]).toMatch(/INR/);
    // At most what a deal's value holds: 10,000,000,000,000 rupees.
    expect(parseUnitPrice('10000000000000', 'INR')).toBe(MAX_DEAL_MINOR);
    expect(refusal('10000000000000.01', 'INR')[1]).toBe('unitPrice');
  });
});
