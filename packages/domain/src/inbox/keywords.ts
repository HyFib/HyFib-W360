/**
 * Keyword matching shared by team routing and automation triggers. Pure functions without server
 * dependencies, so the automation builder can use them in the browser.
 */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;

/** Lower-cases text and reduces it to single-space separated words (letters, marks and digits). */
export function normalizeRoutingText(text: string): string {
  return (text.normalize('NFKC').toLowerCase().match(WORD) ?? []).join(' ');
}

/** Whether `keyword` (one or more words) appears in `text` as whole words. */
export function matchesKeyword(text: string, keyword: string): boolean {
  const k = normalizeRoutingText(keyword);
  return k.length > 0 && ` ${normalizeRoutingText(text)} `.includes(` ${k} `);
}

/** Whether `text` consists of exactly the words of `keyword` (ignoring case and punctuation). */
export function equalsKeyword(text: string, keyword: string): boolean {
  const k = normalizeRoutingText(keyword);
  return k.length > 0 && normalizeRoutingText(text) === k;
}
