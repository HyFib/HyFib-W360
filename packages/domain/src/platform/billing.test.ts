import { describe, expect, it } from 'vitest';
import type { PlatformDatabase } from '@w360/db/platform';
import {
  createPlatformBillingService,
  refundableTopups,
  type PlatformCompanyBilling,
  type PlatformCompanyTopup,
} from './billing';
import type { PlatformActor } from './service';

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

describe('deciding a refund request (ADR-073)', () => {
  // The checks below happen before any query: a database that is reached fails the test.
  const unreachable: PlatformDatabase = {
    run: async () => {
      throw new Error('the database was reached');
    },
    close: async () => undefined,
  };
  const service = createPlatformBillingService({ platformDb: unreachable });
  const requestId = '01890000-0000-7000-8000-000000000001';
  const operator: PlatformActor = {
    userId: 'usr_operator',
    role: 'platform_operator',
    correlationId: 'corr-1',
  };
  const owner: PlatformActor = { ...operator, userId: 'usr_owner', role: 'platform_owner' };

  it('refuses platform operators before the database', async () => {
    await expect(
      service.decideRefundRequest(operator, { requestId, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      service.decideRefundRequest(operator, {
        requestId,
        decision: 'decline',
        note: 'x'.repeat(20),
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('needs a note of 10 to 1,000 characters to decline, and none shorter to approve', async () => {
    for (const note of [undefined, '', '   ', 'too short', 'x'.repeat(1001)]) {
      await expect(
        service.decideRefundRequest(owner, { requestId, decision: 'decline', note }),
        String(note),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    }
    await expect(
      service.decideRefundRequest(owner, { requestId, decision: 'approve', note: 'short' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      service.decideRefundRequest(owner, { requestId: 'not-a-uuid', decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      service.decideRefundRequest(owner, { requestId, decision: 'refund' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
