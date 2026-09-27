import { describe, expect, it } from 'vitest';
import {
  MAX_DEAL_MINOR,
  currencyDigits,
  formatMinor,
  isCurrency,
  minorToInput,
  parseAmountToMinor,
} from './money';

describe('deal amounts', () => {
  it('knows ISO 4217 currencies and their minor units', () => {
    expect(isCurrency('INR')).toBe(true);
    expect(isCurrency('USD')).toBe(true);
    expect(isCurrency('inr')).toBe(false);
    expect(isCurrency('RUPEES')).toBe(false);
    expect(isCurrency('ZZZ')).toBe(false);
    expect(currencyDigits('INR')).toBe(2);
    expect(currencyDigits('JPY')).toBe(0);
    expect(currencyDigits('BHD')).toBe(3);
  });

  it('parses typed amounts into minor units exactly', () => {
    expect(parseAmountToMinor('2,500.50', 'INR')).toBe(250050);
    expect(parseAmountToMinor(' 2500.5 ', 'INR')).toBe(250050);
    expect(parseAmountToMinor('0.1', 'INR')).toBe(10);
    // 0.1 + 0.2 is not 0.3 in floating point; the parser never uses floats.
    expect(parseAmountToMinor('0.30', 'INR')).toBe(30);
    expect(parseAmountToMinor('1200', 'JPY')).toBe(1200);
    expect(parseAmountToMinor('1.234', 'BHD')).toBe(1234);
    expect(parseAmountToMinor('10000000000000', 'INR')).toBe(MAX_DEAL_MINOR);
  });

  it('rejects negative, malformed, over-precise and oversized amounts', () => {
    expect(parseAmountToMinor('2500.505', 'INR')).toBeNull();
    expect(parseAmountToMinor('1200.5', 'JPY')).toBeNull();
    expect(parseAmountToMinor('-5', 'INR')).toBeNull();
    expect(parseAmountToMinor('abc', 'INR')).toBeNull();
    expect(parseAmountToMinor('1e5', 'INR')).toBeNull();
    expect(parseAmountToMinor('', 'INR')).toBeNull();
    expect(parseAmountToMinor('10000000000000.01', 'INR')).toBeNull();
  });

  it('writes minor units back for forms and for display', () => {
    expect(minorToInput(250050, 'INR')).toBe('2500.50');
    expect(minorToInput(5, 'INR')).toBe('0.05');
    expect(minorToInput(1200, 'JPY')).toBe('1200');
    expect(minorToInput(1234, 'BHD')).toBe('1.234');
    expect(parseAmountToMinor(minorToInput(987654321, 'INR'), 'INR')).toBe(987654321);
    expect(formatMinor(250050, 'INR')).toBe('₹2,500.50');
    expect(formatMinor(1200, 'JPY', 'en-US')).toBe('¥1,200');
    expect(formatMinor(MAX_DEAL_MINOR - 1, 'INR', 'en-US')).toBe('₹9,999,999,999,999.99');
  });
});
