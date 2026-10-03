import { describe, expect, it } from 'vitest';
import { NUL, NUL_REPLACEMENT, parseExternalJson } from './text';

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
