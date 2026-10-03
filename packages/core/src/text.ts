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
