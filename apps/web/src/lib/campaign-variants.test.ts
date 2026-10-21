import { describe, expect, it } from 'vitest';
import { canAddVariant, newVariantShare, shareLeftForA } from './campaign-variants';

describe("the editor's default variant shares (ADR-410)", () => {
  it('starts B at 50% and each later variant at half of what A keeps', () => {
    expect(newVariantShare([])).toBe(50);
    expect(newVariantShare([50])).toBe(25);
    expect(newVariantShare([50, 25])).toBe(10);
    expect(newVariantShare([30])).toBe(35);
    expect(newVariantShare([40, 30])).toBe(15);
  });

  it('never offers a variant that would leave it or A under 10%', () => {
    // Adding at the defaults until no more can be added: every set leaves A at least 10%.
    for (const start of [[], [10], [30], [50], [90], [40, 40], [20, 20, 20]]) {
      const shares = [...start];
      while (canAddVariant(shares)) {
        const next = newVariantShare(shares);
        expect(next).toBeGreaterThanOrEqual(10);
        expect(next % 5).toBe(0);
        shares.push(next);
        expect(shareLeftForA(shares), String(shares)).toBeGreaterThanOrEqual(10);
      }
      expect(shares.length).toBeLessThanOrEqual(4);
    }
    // B, C and D at their defaults (50, 25, 10) leave A 15%: no fifth variant at 10% is offered.
    expect(canAddVariant([50, 25, 10])).toBe(false);
    expect(canAddVariant([20, 20, 20])).toBe(true);
    expect(canAddVariant([20, 20, 20, 20])).toBe(false);
    expect(canAddVariant([80])).toBe(true);
    expect(canAddVariant([85])).toBe(false);
  });
});
