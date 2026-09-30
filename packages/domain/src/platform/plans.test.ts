import { describe, expect, it } from 'vitest';
import type { PlatformDatabase } from '@w360/db/platform';
import { createPlanAdminService, refundablePlanPayments, type PlatformPlanPayment } from './plans';
import type { PlatformActor } from './service';

function payment(overrides: Partial<PlatformPlanPayment>): PlatformPlanPayment {
  return {
    id: 'payment-1',
    providerPaymentId: 'pay_1',
    providerInvoiceId: 'inv_1',
    amountMinor: 141_482,
    periodStart: new Date('2026-09-01T00:00:00Z'),
    periodEnd: new Date('2026-10-01T00:00:00Z'),
    paidAt: new Date('2026-09-01T00:00:00Z'),
    refundedMinor: 0,
    openRefundMinor: null,
    ...overrides,
  };
}

describe('refunds of plan payments on the platform page (ADR-103)', () => {
  it('offers what Razorpay has not refunded of a payment, with no refund of it in progress', () => {
    expect(
      refundablePlanPayments([
        payment({ id: 'whole' }),
        payment({ id: 'part', refundedMinor: 50_000 }),
        payment({ id: 'all', refundedMinor: 141_482 }),
        payment({ id: 'open', openRefundMinor: 100 }),
      ]).map((p) => [p.id, p.maxMinor]),
    ).toEqual([
      ['whole', 141_482],
      ['part', 91_482],
    ]);
  });

  it('refuses operators and bad amounts before the database', async () => {
    const platformDb = {
      run: () => {
        throw new Error('the database is not reached');
      },
    } as unknown as PlatformDatabase;
    const service = createPlanAdminService({
      platformDb,
      clock: { now: () => new Date() },
      razorpay: null,
    });
    const input = {
      tenantId: '01900000-0000-7000-8000-000000000001',
      planPaymentId: '01900000-0000-7000-8000-000000000002',
      amount: '100',
      reason: 'Charged twice by mistake, ticket 1',
    };
    const operator: PlatformActor = {
      userId: 'operator',
      role: 'platform_operator',
      correlationId: 'c',
    };
    const owner: PlatformActor = { ...operator, userId: 'owner', role: 'platform_owner' };
    await expect(service.requestPlanPaymentRefund(operator, input)).rejects.toMatchObject({
      code: 'forbidden',
    });
    for (const amount of ['', 'abc', '0', '0.001', '-1']) {
      await expect(
        service.requestPlanPaymentRefund(owner, { ...input, amount }),
        amount,
      ).rejects.toMatchObject({ code: 'validation_failed' });
    }
    await expect(
      service.requestPlanPaymentRefund(owner, { ...input, reason: 'too short' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
