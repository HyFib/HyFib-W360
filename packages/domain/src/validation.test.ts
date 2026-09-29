import { describe, expect, it } from 'vitest';
import { decodeKeysetCursor, encodeKeysetCursor } from './validation';

const ID = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';

describe('keyset cursors', () => {
  it('carry the timestamp to the microsecond, as PostgreSQL keeps it', () => {
    const cursor = encodeKeysetCursor('2026-09-29T08:15:30.123456Z', ID);
    expect(decodeKeysetCursor(cursor)).toEqual({ at: '2026-09-29T08:15:30.123456Z', id: ID });
  });

  it('still read cursors made with milliseconds or whole seconds', () => {
    for (const at of ['2026-09-29T08:15:30.123Z', '2026-09-29T08:15:30Z']) {
      expect(decodeKeysetCursor(Buffer.from(`${at}|${ID}`).toString('base64url'))).toEqual({
        at,
        id: ID,
      });
    }
    expect(decodeKeysetCursor(undefined)).toBeNull();
    expect(decodeKeysetCursor('')).toBeNull();
  });

  it('refuse anything else, so no text reaches the query but a valid time and id', () => {
    const bad = [
      '2026-09-29 08:15:30.123456+00',
      '2026-09-29T08:15:30.1234567Z',
      '2026-13-29T08:15:30.123456Z',
      "2026-09-29T08:15:30Z'::timestamptz; --",
      // Dates JavaScript moves on and PostgreSQL refuses.
      '2026-02-30T08:15:30Z',
      '2026-09-29T24:00:00Z',
      '0000-01-01T00:00:00Z',
    ];
    for (const at of bad) {
      expect(() => decodeKeysetCursor(Buffer.from(`${at}|${ID}`).toString('base64url'))).toThrow(
        'Invalid cursor.',
      );
    }
    for (const id of ['not-an-id', '-'.repeat(36), ID.toUpperCase()]) {
      expect(() =>
        decodeKeysetCursor(Buffer.from(`2026-09-29T08:15:30Z|${id}`).toString('base64url')),
      ).toThrow('Invalid cursor.');
    }
    expect(() => decodeKeysetCursor('not-a-cursor')).toThrow('Invalid cursor.');
  });
});
