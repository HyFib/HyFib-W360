import { describe, expect, it } from 'vitest';
import { apiFieldFilterValue, apiFieldValue, coerceFieldValue } from './fields';

describe('custom field values through the public API (ADR-112)', () => {
  const text = { label: 'City', type: 'text' as const, options: null };
  const number = { label: 'Orders', type: 'number' as const, options: null };
  const date = { label: 'Birthday', type: 'date' as const, options: null };
  const yesNo = { label: 'VIP', type: 'boolean' as const, options: null };
  const value = (field: Parameters<typeof apiFieldValue>[0], raw: unknown) => {
    const result = apiFieldValue(field, raw);
    return result.ok ? result.value : `refused: ${result.message}`;
  };

  it('take each type as JSON writes it, as members type them', () => {
    expect(value(text, '  Chennai  ')).toBe('Chennai');
    expect(value(text, 'x'.repeat(500))).toBe('x'.repeat(500));
    expect(value(number, 3)).toBe(3);
    expect(value(number, -12.5)).toBe(-12.5);
    expect(value(number, 123456789012345.5)).toBe(123456789012345.5);
    expect(value(number, 0.123456)).toBe(0.123456);
    expect(value(date, '2026-02-28')).toBe('2026-02-28');
    expect(value(yesNo, true)).toBe(true);
    expect(value(yesNo, false)).toBe(false);
  });

  it('clear a value for null, or an empty string for text and dates', () => {
    for (const field of [text, number, date, yesNo]) expect(value(field, null)).toBeNull();
    expect(value(text, '   ')).toBeNull();
    expect(value(date, '')).toBeNull();
  });

  it('refuse another type or a bad value, naming the field', () => {
    expect(value(text, 42)).toBe('refused: City takes text.');
    expect(value(text, true)).toBe('refused: City takes text.');
    expect(value(text, 'x'.repeat(501))).toBe('refused: City is longer than 500 characters.');
    expect(value(number, '3')).toBe('refused: Orders takes a number.');
    expect(value(number, Number.NaN)).toBe('refused: Orders takes a number.');
    expect(value(number, Number.POSITIVE_INFINITY)).toBe('refused: Orders takes a number.');
    for (const big of [1e21, 1234567890123456, 0.1234567, 1e-7])
      expect(value(number, big)).toBe(
        'refused: Orders takes a number with at most 15 digits before the point and 6 after.',
      );
    expect(value(date, '2026-02-30')).toBe(
      'refused: Birthday must be a date written as YYYY-MM-DD.',
    );
    expect(value(date, '28/02/2026')).toBe(
      'refused: Birthday must be a date written as YYYY-MM-DD.',
    );
    expect(value(date, 20260228)).toBe('refused: Birthday takes a date written as YYYY-MM-DD.');
    expect(value(yesNo, 'yes')).toBe('refused: VIP takes true or false.');
    expect(value(yesNo, 1)).toBe('refused: VIP takes true or false.');
    for (const field of [text, number, date, yesNo]) {
      expect(value(field, ['a'])).toMatch(/^refused: /);
      expect(value(field, { a: 1 })).toMatch(/^refused: /);
      expect(value(field, undefined)).toMatch(/^refused: /);
    }
  });

  it('keep the app’s own reading of typed values', () => {
    expect(coerceFieldValue(number, '12.5')).toEqual({ ok: true, value: 12.5 });
    expect(coerceFieldValue(number, '1e3')).toEqual({
      ok: false,
      message: 'Orders must be a number.',
    });
    expect(coerceFieldValue(yesNo, 'Yes')).toEqual({ ok: true, value: true });
  });
});

describe('custom field values a contact list is filtered by (ADR-113)', () => {
  const text = { label: 'City', type: 'text' as const, options: null };
  const number = { label: 'Orders', type: 'number' as const, options: null };
  const date = { label: 'Birthday', type: 'date' as const, options: null };
  const yesNo = { label: 'VIP', type: 'boolean' as const, options: null };
  const value = (field: Parameters<typeof apiFieldFilterValue>[0], raw: string) => {
    const result = apiFieldFilterValue(field, raw);
    return result.ok ? result.value : `refused: ${result.message}`;
  };

  it('read each type from the query string as members type it', () => {
    expect(value(text, '  Pune ')).toBe('Pune');
    expect(value(text, 'true')).toBe('true');
    expect(value(number, '3')).toBe(3);
    expect(value(number, '-2.5')).toBe(-2.5);
    expect(value(date, '1990-04-01')).toBe('1990-04-01');
    expect(value(yesNo, 'true')).toBe(true);
    expect(value(yesNo, 'false')).toBe(false);
  });

  it('refuse an empty value, another type or a bad value, naming the field', () => {
    for (const field of [text, number, date]) {
      expect(value(field, '  ')).toBe(`refused: Give a value of ${field.label} to find.`);
    }
    expect(value(text, 'x'.repeat(501))).toBe('refused: City is longer than 500 characters.');
    expect(value(number, 'three')).toBe('refused: Orders must be a number.');
    expect(value(number, '1e3')).toBe('refused: Orders must be a number.');
    expect(value(date, '1990-02-30')).toBe(
      'refused: Birthday must be a date written as YYYY-MM-DD.',
    );
    for (const raw of ['yes', 'TRUE', '1', '']) {
      expect(value(yesNo, raw)).toBe('refused: VIP takes true or false.');
    }
  });
});
