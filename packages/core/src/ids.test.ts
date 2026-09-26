import { describe, expect, it } from 'vitest';
import { isUuid, randomToken, sha256Hex, uuidv7 } from './ids';

describe('ids', () => {
  it('generates valid, time-ordered UUIDv7 values', () => {
    const ids = Array.from({ length: 1000 }, () => uuidv7());
    for (const id of ids) {
      expect(isUuid(id)).toBe(true);
      expect(id[14]).toBe('7');
    }
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('produces 256-bit url-safe tokens and stable hashes', () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
