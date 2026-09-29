import { describe, expect, it } from 'vitest';
import type { RazorpayReconItem } from './razorpay';
import {
  addDays,
  classifyReconItem,
  indexReconFacts,
  indiaDate,
  reconItemType,
  reconcileThrough,
  withDispute,
  type ReconFact,
} from './settlement-recon';

describe('settlement days', () => {
  it('uses India’s calendar day', () => {
    // 18:29 UTC is 23:59 in India; 18:30 UTC is already the next day there.
    expect(indiaDate(new Date('2026-09-27T18:29:00Z'))).toBe('2026-09-27');
    expect(indiaDate(new Date('2026-09-27T18:30:00Z'))).toBe('2026-09-28');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('owes the previous day from 06:00 India time, and the day before until then', () => {
    // 05:59 in India on 28 September.
    expect(reconcileThrough(new Date('2026-09-28T00:29:00Z'))).toBe('2026-09-26');
    // 06:00 in India on 28 September.
    expect(reconcileThrough(new Date('2026-09-28T00:30:00Z'))).toBe('2026-09-27');
    // 23:59 in India on 28 September.
    expect(reconcileThrough(new Date('2026-09-28T18:29:00Z'))).toBe('2026-09-27');
  });
});

function item(overrides: Partial<RazorpayReconItem>): RazorpayReconItem {
  return {
    entityId: 'pay_A',
    type: 'payment',
    amount: 50_000,
    debit: 0,
    credit: 49_000,
    fee: 1_000,
    tax: 152,
    currency: 'INR',
    onHold: false,
    settled: true,
    settlementId: 'setl_A',
    settlementUtr: 'UTR1',
    createdAt: 1_790_000_000,
    settledAt: 1_790_100_000,
    paymentId: null,
    orderId: 'order_A',
    disputeId: null,
    method: 'card',
    ...overrides,
  };
}

const fact = (kind: ReconFact['kind'], providerId: string, extra: Partial<ReconFact> = {}) =>
  ({
    kind,
    providerId,
    tenantId: 'tenant-1',
    subjectId: `${kind}-subject`,
    amountMinor: 50_000,
    currency: 'INR',
    status: 'paid',
    paymentId: null,
    ...extra,
  }) satisfies ReconFact;

const facts = indexReconFacts([
  fact('topup_payment', 'pay_A'),
  fact('topup_order', 'order_A', { paymentId: 'pay_A' }),
  fact('topup_order', 'order_B', { subjectId: 'topup-b', amountMinor: 30_000, paymentId: null }),
  fact('mandate_payment', 'pay_M', { subjectId: 'mandate-1', amountMinor: null }),
  fact('mandate_order', 'order_M', { subjectId: 'mandate-1', amountMinor: null }),
  fact('mandate_refund', 'rfnd_M', { subjectId: 'mandate-1', amountMinor: null }),
  fact('refund', 'rfnd_A', { subjectId: 'topup_payment-subject', amountMinor: 5_000 }),
  fact('plan_payment', 'pay_P', { subjectId: 'subscription-1', amountMinor: 117_882 }),
]);

const outcome = (i: RazorpayReconItem) => {
  const found = classifyReconItem(i, facts);
  return `${found.status}:${found.reason ?? ''}:${found.apply ?? ''}`;
};

describe('matching a settled transaction', () => {
  it('matches payments by payment id, then by order, then mandates', () => {
    expect(classifyReconItem(item({}), facts)).toEqual({
      status: 'matched',
      reason: null,
      tenantId: 'tenant-1',
      topupId: 'topup_payment-subject',
      hyfibAmountMinor: 50_000,
      apply: null,
    });
    expect(outcome(item({ amount: 60_000 }))).toBe('mismatch:amount_differs:');
    expect(outcome(item({ entityId: 'pay_M', orderId: 'order_M' }))).toBe(
      'matched:mandate_authorization:',
    );
    // A payment on a top-up's order that did not credit it is fetched and applied.
    expect(classifyReconItem(item({ entityId: 'pay_B', orderId: 'order_B' }), facts)).toEqual({
      status: 'mismatch',
      reason: 'payment_unavailable',
      tenantId: 'tenant-1',
      topupId: 'topup-b',
      hyfibAmountMinor: 30_000,
      apply: 'payment',
    });
    expect(outcome(item({ entityId: 'pay_M2', orderId: 'order_M' }))).toBe(
      'mismatch:mandate_payment:',
    );
    // A payment on no order of HyFib's may be a plan subscription's charge (an invoice's order, or
    // none): it is looked up as one before it counts as not HyFib's.
    expect(outcome(item({ entityId: 'pay_X', orderId: 'order_X' }))).toBe(
      'not_hyfib:unknown_payment:plan_payment',
    );
    expect(outcome(item({ entityId: 'pay_X', orderId: null }))).toBe(
      'not_hyfib:unknown_payment:plan_payment',
    );
  });

  it('matches plan subscription payments by payment id (ADR-063)', () => {
    expect(
      classifyReconItem(item({ entityId: 'pay_P', orderId: 'order_inv', amount: 117_882 }), facts),
    ).toEqual({
      status: 'matched',
      reason: 'plan_payment',
      tenantId: 'tenant-1',
      topupId: null,
      hyfibAmountMinor: 117_882,
      apply: null,
    });
    expect(outcome(item({ entityId: 'pay_P', amount: 117_881 }))).toBe('mismatch:amount_differs:');
    // A dispute on a plan payment is for a person, as on any other matched payment.
    expect(outcome(item({ entityId: 'pay_P', amount: 117_882, disputeId: 'disp_P' }))).toBe(
      'review:dispute:',
    );
  });

  it('matches refunds by refund id, then by the refunded payment and its order', () => {
    const refund = (overrides: Partial<RazorpayReconItem>) =>
      item({
        type: 'refund',
        amount: 5_000,
        debit: 5_000,
        credit: 0,
        fee: 0,
        tax: 0,
        ...overrides,
      });
    expect(classifyReconItem(refund({ entityId: 'rfnd_A', paymentId: 'pay_A' }), facts)).toEqual({
      status: 'matched',
      reason: null,
      tenantId: 'tenant-1',
      topupId: 'topup_payment-subject',
      hyfibAmountMinor: 5_000,
      apply: null,
    });
    expect(outcome(refund({ entityId: 'rfnd_A', paymentId: 'pay_A', amount: 6_000 }))).toBe(
      'mismatch:amount_differs:',
    );
    expect(outcome(refund({ entityId: 'rfnd_M', paymentId: 'pay_M' }))).toBe(
      'matched:mandate_authorization:',
    );
    expect(outcome(refund({ entityId: 'rfnd_M2', paymentId: 'pay_M' }))).toBe(
      'matched:mandate_authorization:',
    );
    expect(outcome(refund({ entityId: 'rfnd_B', paymentId: 'pay_A' }))).toBe(
      'mismatch:refund_unavailable:refund',
    );
    expect(outcome(refund({ entityId: 'rfnd_C', paymentId: 'pay_C', orderId: 'order_B' }))).toBe(
      'matched:uncredited_payment_refund:',
    );
    expect(outcome(refund({ entityId: 'rfnd_X', paymentId: 'pay_X', orderId: 'order_X' }))).toBe(
      'not_hyfib:unknown_refund:',
    );
    // HyFib does not refund plan payments: a refund of one was made outside it, for a person.
    expect(outcome(refund({ entityId: 'rfnd_P', paymentId: 'pay_P', orderId: 'order_inv' }))).toBe(
      'review:plan_payment_refund:',
    );
  });

  it('leaves transfers, adjustments, unknown types, disputes and other currencies to a person', () => {
    expect(outcome(item({ type: 'transfer', entityId: 'trf_A' }))).toBe('not_hyfib:transfer:');
    expect(outcome(item({ type: 'adjustment', entityId: 'adj_A' }))).toBe('review:adjustment:');
    expect(outcome(item({ type: 'reversal', entityId: 'rev_A' }))).toBe('review:unknown_type:');
    // A dispute or a foreign currency is for a person even when the payment matched.
    expect(outcome(item({ disputeId: 'disp_A' }))).toBe('review:dispute:');
    expect(outcome(item({ currency: 'USD' }))).toBe('review:currency:');
    expect(outcome(item({ currency: null }))).toBe('review:currency:');
    // Nothing is applied in another currency; a missed payment with a dispute is still applied,
    // as its webhook would have been.
    expect(outcome(item({ entityId: 'pay_B', orderId: 'order_B', currency: 'USD' }))).toBe(
      'review:currency:',
    );
    expect(outcome(item({ entityId: 'pay_B', orderId: 'order_B', disputeId: 'disp_B' }))).toBe(
      'mismatch:payment_unavailable:payment',
    );
    // A mismatch keeps its own reason when it also has a dispute.
    expect(outcome(item({ amount: 1, disputeId: 'disp_C' }))).toBe('mismatch:amount_differs:');
  });

  it('decides a dispute again once a missed transaction was applied', () => {
    const disputed = item({ entityId: 'pay_B', orderId: 'order_B', disputeId: 'disp_B' });
    const base = {
      tenantId: 'tenant-1',
      topupId: 'topup-b',
      hyfibAmountMinor: 30_000,
      apply: null,
    } as const;
    // Credited by the check, and still for a person: a later run finds it matched and disputed.
    expect(
      withDispute(disputed, { ...base, status: 'recorded', reason: 'credited' }),
    ).toMatchObject({ status: 'review', reason: 'dispute', topupId: 'topup-b' });
    expect(withDispute(disputed, { ...base, status: 'matched', reason: null })).toMatchObject({
      status: 'review',
      reason: 'dispute',
    });
    expect(
      withDispute(disputed, { ...base, status: 'mismatch', reason: 'second_payment' }),
    ).toMatchObject({ status: 'mismatch', reason: 'second_payment' });
    expect(
      withDispute(item({ disputeId: null }), { ...base, status: 'matched', reason: null }),
    ).toMatchObject({ status: 'matched' });
  });

  it('keeps the four documented types and calls anything else other', () => {
    expect(['payment', 'refund', 'transfer', 'adjustment', 'reversal'].map(reconItemType)).toEqual([
      'payment',
      'refund',
      'transfer',
      'adjustment',
      'other',
    ]);
  });
});
