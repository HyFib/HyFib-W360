import { describe, expect, it } from 'vitest';
import { NUL, NUL_REPLACEMENT, clipText, jsonbSize, jsonbText, parseExternalJson } from './text';

describe('parseExternalJson', () => {
  it('replaces the NUL character in strings and keys, at any depth', () => {
    const text = JSON.stringify({
      text: `Priya${NUL} here`,
      [`ke${NUL}y`]: [`a${NUL}`, { deeper: `${NUL}${NUL}` }],
    });
    expect(text).toContain('\\u0000');
    expect(parseExternalJson(text)).toEqual({
      text: `Priya${NUL_REPLACEMENT} here`,
      [`ke${NUL_REPLACEMENT}y`]: [`a${NUL_REPLACEMENT}`, { deeper: '��' }],
    });
  });

  it('keeps a backslash followed by "u0000" as it is, however many backslashes come before', () => {
    // `\\u0000` is a backslash, then "u0000"; `\\\u0000` is a backslash, then the NUL character.
    expect(parseExternalJson('"\\\\u0000"')).toBe('\\u0000');
    expect(parseExternalJson('"\\\\\\u0000"')).toBe(`\\${NUL_REPLACEMENT}`);
    expect(parseExternalJson('"\\\\\\\\u0000"')).toBe('\\\\u0000');
    expect(parseExternalJson('{"a":"\\"\\u0000\\""}')).toEqual({ a: `"${NUL_REPLACEMENT}"` });
  });

  it('parses anything else exactly as JSON.parse does, and throws as it does', () => {
    for (const text of ['{"a":[1,"b",null,true],"c":{"d":"\\u00e9\\n"}}', '"x"', '12', 'null']) {
      expect(parseExternalJson(text)).toEqual(JSON.parse(text));
    }
    // Another escape that starts with \u000 is another character.
    expect(parseExternalJson('"\\u0001\\u000a"')).toBe('\u0001\n');
    expect(() => parseExternalJson('{"a":')).toThrow(SyntaxError);
    // A raw NUL character is not valid JSON, inside a string or out.
    expect(() => parseExternalJson(`"a${NUL}"`)).toThrow(SyntaxError);
  });
});

// Half of an emoji: 😀 is the pair 😀.
const HIGH = '\ud83d';
const LOW = '\ude00';

describe('jsonbText (ADR-131)', () => {
  it('writes each lone surrogate as U+FFFD, in strings and keys, and keeps pairs', () => {
    const text = jsonbText({
      a: `x${HIGH}`,
      [`k${LOW}`]: [`${LOW}${HIGH}`, '😀', `${HIGH}${LOW}`],
    });
    expect(text).not.toMatch(/\\ud[89a-f]/);
    expect(JSON.parse(text)).toEqual({
      a: 'x�',
      'k�': ['��', '😀', '😀'],
    });
  });

  it('keeps a backslash followed by "ud83d" as it is, and anything else as JSON.stringify writes it', () => {
    // `\\ud83d` is a backslash, then "ud83d"; `\\` and a half is a backslash, then U+FFFD.
    expect(jsonbText('\\ud83d')).toBe(JSON.stringify('\\ud83d'));
    expect(JSON.parse(jsonbText(`\\${HIGH}`))).toBe('\\�');
    for (const value of [{ a: [1, 'b', null, true], c: { d: 'é\n\u0001' } }, 'x', 12, null, []]) {
      expect(jsonbText(value)).toBe(JSON.stringify(value));
    }
    expect(() => jsonbText(undefined)).toThrow(TypeError);
  });
});

describe('clipText (ADR-131)', () => {
  it('clips to at most the length given without splitting a surrogate pair', () => {
    expect(clipText(`${'x'.repeat(4095)}😀`, 4096)).toBe('x'.repeat(4095));
    expect(clipText(`${'x'.repeat(4094)}😀`, 4096)).toBe(`${'x'.repeat(4094)}😀`);
    expect(clipText(`${'x'.repeat(4094)}😀y`, 4096)).toBe(`${'x'.repeat(4094)}😀`);
    expect(clipText('abc', 2)).toBe('ab');
    expect(clipText('abc', 3)).toBe('abc');
    expect(clipText('😀', 1)).toBe('');
    expect(clipText('abc', 0)).toBe('');
  });
});

describe('jsonbSize (ADR-131)', () => {
  it('counts text as UTF-8 bytes, a lone surrogate as U+FFFD', () => {
    // A lone scalar: header 4, a one-element array 4 + 4, then its bytes.
    expect(jsonbSize('')).toBe(12);
    expect(jsonbSize('abc')).toBe(15);
    expect(jsonbSize('é')).toBe(14);
    expect(jsonbSize('€')).toBe(15);
    expect(jsonbSize('😀')).toBe(16);
    expect(jsonbSize(HIGH)).toBe(15);
    expect(jsonbSize(true)).toBe(12);
    expect(jsonbSize(1)).toBe(36);
  });

  it('adds each container and entry, and skips what JSON drops', () => {
    expect(jsonbSize({})).toBe(11);
    expect(jsonbSize([])).toBe(11);
    expect(jsonbSize({ a: 'bc' })).toBe(11 + 8 + 1 + 2);
    expect(jsonbSize([null, 'ab'])).toBe(11 + 8 + 2);
    expect(jsonbSize({ a: { b: [1] } })).toBe(11 + 9 + 7 + 9 + 7 + 4 + 24);
    expect(jsonbSize({ a: undefined, b: () => 1, c: 'x' })).toBe(11 + 9 + 1);
    expect(jsonbSize({ at: new Date(0) })).toBe(11 + 10 + JSON.stringify(new Date(0)).length - 2);
  });

  it('walks any nesting without recursion', () => {
    let deep: unknown = 'z';
    for (let i = 0; i < 50_000; i += 1) deep = [deep];
    expect(jsonbSize(deep)).toBe(4 + 50_000 * 11 + 1);
  });
});
