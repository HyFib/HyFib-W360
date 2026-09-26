import { describe, expect, it } from 'vitest';
import { displayMoney, formatMinorUnits, multiplyByDecimal, parseMajorUnits } from './money';

describe('money', () => {
  it('parses and formats minor units exactly', () => {
    expect(parseMajorUnits('1234.5', 'INR')).toBe(123450n);
    expect(parseMajorUnits('0.01', 'INR')).toBe(1n);
    expect(parseMajorUnits('-2', 'INR')).toBe(-200n);
    expect(formatMinorUnits(123450n, 'INR')).toBe('1234.50');
    expect(formatMinorUnits(-5n, 'INR')).toBe('-0.05');
  });

  it('rejects ambiguous input', () => {
    expect(() => parseMajorUnits('1.234', 'INR')).toThrow();
    expect(() => parseMajorUnits('1e3', 'INR')).toThrow();
    expect(() => parseMajorUnits('', 'INR')).toThrow();
  });

  it('displays INR with Indian digit grouping', () => {
    expect(displayMoney(123456789n, 'INR')).toBe('₹12,34,567.89');
    expect(displayMoney(100000n, 'USD')).toBe('$1,000.00');
  });

  it('multiplies by decimal rates with half-up rounding', () => {
    expect(multiplyByDecimal(10000n, '0.8631')).toBe(8631n);
    expect(multiplyByDecimal(1n, '0.5')).toBe(1n);
    expect(multiplyByDecimal(1n, '0.49')).toBe(0n);
    expect(multiplyByDecimal(-3n, '0.5')).toBe(-2n);
  });
});
