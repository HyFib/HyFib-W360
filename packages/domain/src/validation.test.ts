import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isAppError } from '@w360/core';
import {
  NUL_CHARACTER_MESSAGE,
  decodeKeysetCursor,
  encodeKeysetCursor,
  nulCharacterPathIn,
  parseInput,
} from './validation';

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

describe('parseInput and the NUL character (ADR-130)', () => {
  const schema = z.object({
    name: z.string().trim().max(200),
    tags: z.array(z.string()).default([]),
    fields: z.record(z.string(), z.string()).default({}),
  });

  it('refuses what the schema keeps when it holds the character, naming where', () => {
    for (const [input, path] of [
      [{ name: 'Pri\u0000ya' }, 'name'],
      [{ name: 'Priya', tags: ['vip', 'ne\u0000w'] }, 'tags.1'],
      [{ name: 'Priya', fields: { city: 'Pu\u0000ne' } }, 'fields.city'],
      [{ name: 'Priya', fields: { ['ci\u0000ty']: 'Pune' } }, 'fields.ci\\u0000ty'],
    ] as const) {
      let refused: unknown;
      try {
        parseInput(schema, input);
      } catch (error) {
        refused = error;
      }
      expect(isAppError(refused)).toBe(true);
      expect(refused).toMatchObject({
        code: 'validation_failed',
        message: NUL_CHARACTER_MESSAGE,
        issues: [{ path, message: NUL_CHARACTER_MESSAGE }],
      });
    }
  });

  it('keeps everything else, and ignores what the schema drops', () => {
    expect(parseInput(schema, { name: ' Priya ', ignored: 'x\u0000' })).toEqual({
      name: 'Priya',
      tags: [],
      fields: {},
    });
    // Other control characters are kept, as the API keeps them.
    expect(parseInput(schema, { name: 'a\u0001b' }).name).toBe('a\u0001b');
    // Schema errors come first.
    expect(() => parseInput(schema, { name: 'x'.repeat(201) + '\u0000' })).toThrow(/200/);
  });

  it('walks any nesting without recursion, and names the value itself with an empty path', () => {
    expect(nulCharacterPathIn('a\u0000')).toBe('');
    expect(nulCharacterPathIn(new Date(0))).toBeNull();
    expect(nulCharacterPathIn({ a: [{}, { b: null, c: 3, d: ['x', 'y\u0000'] }] })).toBe('a.1.d.1');
    let deep: unknown = 'z\u0000';
    for (let i = 0; i < 50_000; i += 1) deep = { n: deep };
    expect(nulCharacterPathIn(deep)?.split('.')).toHaveLength(50_000);
  });
});
