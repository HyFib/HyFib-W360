/** The NUL character (U+0000), which PostgreSQL's text and jsonb cannot hold. */
export const NUL = '\u0000';

/** What a NUL character in outside JSON becomes: the Unicode replacement character (U+FFFD). */
export const NUL_REPLACEMENT = '�';

/** An escaped backslash, or the escape for the NUL character, as JSON text writes them. */
const NUL_ESCAPE = /\\(?:\\|u0000)/g;

/**
 * Parses JSON from a provider or another outside system with every NUL character in its strings
 * and keys replaced by U+FFFD (ADR-130): one such character would otherwise fail the whole
 * payload where it is stored. JSON text holds the character only as the escape `\u0000` (a raw one
 * is not valid JSON), so the escapes are replaced before parsing, reading an escaped backslash as
 * a pair so that `\\u0000` (a backslash, then "u0000") stays as it is. Throws as `JSON.parse` does.
 */
export function parseExternalJson(text: string): unknown {
  if (!text.includes('\\u0000')) return JSON.parse(text) as unknown;
  return JSON.parse(
    text.replace(NUL_ESCAPE, (escape) => (escape === '\\\\' ? escape : '\\ufffd')),
  ) as unknown;
}

/** A lone UTF-16 surrogate's escape as `JSON.stringify` writes it, or an escaped backslash. */
const LONE_SURROGATE_ESCAPE = /\\(?:\\|u[dD][89a-fA-F][0-9a-fA-F]{2})/g;

/**
 * Writes `value` as JSON PostgreSQL's jsonb stores (ADR-131): as `JSON.stringify` does, with each
 * lone UTF-16 surrogate (half of an emoji, cut by a clip or sent as an escape) written as U+FFFD, as
 * text columns store it. `JSON.stringify` writes such a half as the escape `\ud83d`, which jsonb
 * refuses (22P02), and a pair as the character itself, so an escape it leaves is always a half; an
 * escaped backslash is read as a pair. Throws a TypeError for a value JSON cannot hold (undefined, a
 * function), which `JSON.stringify` would turn into no text at all.
 */
export function jsonbText(value: unknown): string {
  const text = JSON.stringify(value) as string | undefined;
  if (text === undefined) throw new TypeError('jsonbText: the value has no JSON text');
  if (!text.includes('\\ud')) return text;
  return text.replace(LONE_SURROGATE_ESCAPE, (escape) => (escape === '\\\\' ? escape : '\\ufffd'));
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/**
 * Clips text to at most `max` UTF-16 code units without splitting a surrogate pair (ADR-131): a cut
 * between the two halves of an emoji leaves a lone half, which jsonb cannot store and text columns
 * store as U+FFFD.
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max);
}

/** Bytes `text` takes as UTF-8, a lone surrogate as U+FFFD (3 bytes), as Node and jsonbText write it. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (isHighSurrogate(code) && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * An upper bound of the bytes PostgreSQL's jsonb takes for `value` as a column's datum, as
 * `pg_column_size` counts them (ADR-131), for keeping content within a column's size check before
 * writing it: the datum's header; per array or object, its header, 4 bytes per element (8 per key
 * and value) and up to 3 bytes of alignment; text as UTF-8; a number at the widest numeric a double
 * gives (20 bytes) with its alignment; true, false and null in their entry alone. Values JSON drops
 * (undefined, functions) are skipped, as `JSON.stringify` skips them. Walked without recursion.
 */
export function jsonbSize(value: unknown): number {
  // A lone scalar is kept as a one-element array: its header and one entry.
  let size = 4 + (typeof value === 'object' && value !== null ? 0 : 8);
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const at = stack.pop();
    if (typeof at === 'string') size += utf8Length(at);
    else if (typeof at === 'number') size += Number.isFinite(at) ? 24 : 0;
    else if (typeof at === 'object' && at !== null) {
      const json = (at as { toJSON?: unknown }).toJSON;
      if (typeof json === 'function') {
        stack.push((json as () => unknown).call(at));
        continue;
      }
      if (Array.isArray(at)) {
        size += 7 + 4 * at.length;
        for (const item of at) stack.push(item);
      } else {
        for (const [key, item] of Object.entries(at)) {
          if (item === undefined || typeof item === 'function' || typeof item === 'symbol')
            continue;
          size += 8 + utf8Length(key);
          stack.push(item);
        }
        size += 7;
      }
    }
  }
  return size;
}
