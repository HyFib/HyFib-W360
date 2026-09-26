import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keyring, constantTimeEqual, hmacSha256Hex } from './crypto';

const k1 = randomBytes(32);
const k2 = randomBytes(32);

describe('Keyring', () => {
  it('round-trips with AAD and records the key id', () => {
    const ring = new Keyring({ primaryKeyId: 'k1', keys: { k1 } });
    const ct = ring.encrypt('secret-token', 'tenant:a|cred:1');
    expect(Keyring.keyIdOf(ct)).toBe('k1');
    expect(ring.decryptString(ct, 'tenant:a|cred:1')).toBe('secret-token');
  });

  it('rejects ciphertext moved to a different owner (AAD mismatch)', () => {
    const ring = new Keyring({ primaryKeyId: 'k1', keys: { k1 } });
    const ct = ring.encrypt('secret-token', 'tenant:a|cred:1');
    expect(() => ring.decrypt(ct, 'tenant:b|cred:1')).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const ring = new Keyring({ primaryKeyId: 'k1', keys: { k1 } });
    const parts = ring.encrypt('secret-token', 'aad').split(':');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => ring.decrypt(parts.join(':'), 'aad')).toThrow();
  });

  it('supports rotation: old ciphertexts decrypt after the primary key changes', () => {
    const old = new Keyring({ primaryKeyId: 'k1', keys: { k1 } });
    const ct = old.encrypt('v', 'aad');
    const rotated = new Keyring({ primaryKeyId: 'k2', keys: { k1, k2 } });
    expect(rotated.decryptString(ct, 'aad')).toBe('v');
    expect(rotated.needsRotation(ct)).toBe(true);
    expect(rotated.needsRotation(rotated.encrypt('v', 'aad'))).toBe(false);
  });

  it('parses environment specs and validates key length', () => {
    const ring = Keyring.fromEnv(`k1:${k1.toString('base64')}, k2:${k2.toString('base64')}`, 'k2');
    expect(ring.currentKeyId).toBe('k2');
    expect(() => Keyring.fromEnv(`k1:${randomBytes(16).toString('base64')}`, 'k1')).toThrow(
      /32 bytes/,
    );
    expect(() => Keyring.fromEnv(`k1:${k1.toString('base64')}`, 'missing')).toThrow(
      /not configured/,
    );
  });
});

describe('HMAC helpers', () => {
  it('computes RFC-style HMAC-SHA256 hex digests', () => {
    // RFC 4231 test case 2
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('compares in constant time without throwing on length mismatch', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('AppError brand', () => {
  it('is recognised even when the class identity differs (duplicated bundles)', async () => {
    const { AppError, isAppError } = await import('./errors');
    const err = new AppError('conflict', 'x');
    const clone = Object.assign(Object.create(Error.prototype) as Error, err);
    Object.defineProperty(clone, Symbol.for('w360.app-error'), { value: true });
    expect(isAppError(err)).toBe(true);
    expect(isAppError(clone)).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});
