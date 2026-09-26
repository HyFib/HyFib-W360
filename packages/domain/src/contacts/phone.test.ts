import { describe, expect, it } from 'vitest';
import { normalizePhone, phoneFromWaId, waRecipientFromPhone } from './phone';

describe('normalizePhone', () => {
  it('accepts international numbers written with + or 00 and common separators', () => {
    for (const input of [
      '+91 98765 43210',
      '+91-98765-43210',
      '(+91) 98765.43210',
      '0091 9876543210',
    ]) {
      expect(normalizePhone(input, { kind: 'explicit' })).toEqual({
        ok: true,
        e164: '+919876543210',
      });
    }
  });

  it('never guesses the country of a bare number in manual entry', () => {
    const result = normalizePhone('9876543210', { kind: 'explicit' });
    expect(result.ok).toBe(false);
  });

  it('reads bare digits as international or national only when told to', () => {
    expect(normalizePhone('919876543210', { kind: 'international' })).toEqual({
      ok: true,
      e164: '+919876543210',
    });
    expect(normalizePhone('09876543210', { kind: 'national', callingCode: '91' })).toEqual({
      ok: true,
      e164: '+919876543210',
    });
    // An explicit prefix wins over the national reading.
    expect(normalizePhone('+44 20 7946 0958', { kind: 'national', callingCode: '91' })).toEqual({
      ok: true,
      e164: '+442079460958',
    });
  });

  it('rejects malformed numbers', () => {
    for (const input of [
      '',
      '+0123456789',
      '+12',
      '+1234567890123456',
      'call me',
      '+91 98765 4321x',
      '12+34',
    ]) {
      expect(normalizePhone(input, { kind: 'international' }).ok).toBe(false);
    }
    expect(normalizePhone('98765', { kind: 'national', callingCode: '0' }).ok).toBe(false);
  });
});

describe('WhatsApp id mapping', () => {
  it('maps only E.164-shaped WhatsApp ids to phone numbers', () => {
    expect(phoneFromWaId('919876543210')).toBe('+919876543210');
    expect(phoneFromWaId('0123456789')).toBeNull();
    expect(phoneFromWaId('1234567890123456789')).toBeNull();
    expect(phoneFromWaId(undefined)).toBeNull();
  });

  it('formats the Cloud API recipient without the plus sign', () => {
    expect(waRecipientFromPhone('+919876543210')).toBe('919876543210');
    expect(() => waRecipientFromPhone('919876543210')).toThrow();
  });
});
