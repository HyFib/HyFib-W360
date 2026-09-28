import { describe, expect, it } from 'vitest';
import { refundCheckDelayMs } from './credit-refunds';
import { ledgerLineLabel } from './history';

const MINUTE = 60_000;

describe('refundCheckDelayMs', () => {
  const submitted = new Date('2026-09-28T10:00:00Z');
  const after = (minutes: number) => new Date(submitted.getTime() + minutes * MINUTE);

  it('checks every 15 minutes in the first hour, hourly in the first day, then every 6 hours', () => {
    expect(refundCheckDelayMs(submitted, after(0))).toBe(15 * MINUTE);
    expect(refundCheckDelayMs(submitted, after(59))).toBe(15 * MINUTE);
    expect(refundCheckDelayMs(submitted, after(60))).toBe(60 * MINUTE);
    expect(refundCheckDelayMs(submitted, after(24 * 60 - 1))).toBe(60 * MINUTE);
    expect(refundCheckDelayMs(submitted, after(24 * 60))).toBe(6 * 60 * MINUTE);
    expect(refundCheckDelayMs(submitted, after(10 * 24 * 60))).toBe(6 * 60 * MINUTE);
  });
});

describe('ledgerLineLabel', () => {
  it('names the hold of a staff refund and its release, and keeps the other labels', () => {
    expect(ledgerLineLabel('hold', 'credit_refund')).toBe('Reserved for a refund');
    expect(ledgerLineLabel('hold_release', 'credit_refund')).toBe('Refund reservation released');
    expect(ledgerLineLabel('hold', 'campaign')).toBe('Reserved for a service');
    expect(ledgerLineLabel('hold_release', null)).toBe('Reservation released');
    expect(ledgerLineLabel('refund', 'topup')).toBe('Refund to card');
  });
});
