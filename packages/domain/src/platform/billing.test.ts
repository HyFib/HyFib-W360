import { describe, expect, it } from 'vitest';
import {
  refundableTopups,
  type PlatformCompanyBilling,
  type PlatformCompanyTopup,
} from './billing';

function topup(overrides: Partial<PlatformCompanyTopup>): PlatformCompanyTopup {
  return {
    id: 'topup-1',
    receipt: 'tu_1',
    kind: 'manual',
    amountMinor: 50_000,
    refundedMinor: 0,
    status: 'paid',
    paymentMethod: 'card',
    paidAt: new Date('2026-09-01T10:00:00Z'),
    createdAt: new Date('2026-09-01T09:59:00Z'),
    unrefundedMinor: 50_000,
    openRefund: null,
    ...overrides,
  };
}

function billing(availableMinor: number | null, topups: PlatformCompanyTopup[]) {
  const value: PlatformCompanyBilling = {
    availableMinor,
    reservedMinor: availableMinor === null ? null : 0,
    topups,
    refunds: [],
  };
  return value;
}

describe('refundableTopups', () => {
  it('offers paid and partly refunded top-ups, up to what is left of each payment', () => {
    const paid = topup({ id: 'a' });
    const partly = topup({
      id: 'b',
      status: 'partially_refunded',
      refundedMinor: 30_000,
      unrefundedMinor: 20_000,
    });
    expect(
      refundableTopups(billing(100_000, [paid, partly])).map((t) => [t.id, t.maxMinor]),
    ).toEqual([
      ['a', 50_000],
      ['b', 20_000],
    ]);
  });

  it('never offers more than the unused credit, and nothing when there is none', () => {
    const paid = topup({ id: 'a' });
    expect(refundableTopups(billing(12_345, [paid]))[0]?.maxMinor).toBe(12_345);
    expect(refundableTopups(billing(0, [paid]))).toEqual([]);
    expect(refundableTopups(billing(-500, [paid]))).toEqual([]);
    expect(refundableTopups(billing(null, [paid]))).toEqual([]);
  });

  it('leaves out refunded top-ups, ones with nothing left and ones with a refund in progress', () => {
    const topups = [
      topup({ id: 'refunded', status: 'refunded', refundedMinor: 50_000, unrefundedMinor: 0 }),
      topup({ id: 'empty', status: 'partially_refunded', unrefundedMinor: 0 }),
      topup({
        id: 'open',
        openRefund: { id: 'r1', amountMinor: 1_000, status: 'submitted' },
      }),
      topup({ id: 'ok' }),
    ];
    expect(refundableTopups(billing(100_000, topups)).map((t) => t.id)).toEqual(['ok']);
  });
});
