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

/** Keyword words shorter than this allow no typo (ADR-240): short words have too many neighbours. */
export const TYPO_MIN_LENGTH = 5;
/** Keyword words at least this long allow two typos; shorter ones from TYPO_MIN_LENGTH allow one. */
export const TYPO_TWO_LENGTH = 9;

const DIGIT = /\p{N}/u;

/**
 * How many typos a keyword word allows, counted in characters: none below five characters or in a
 * word with a digit (an order number is never near another), one up to eight, two from nine.
 */
export function typoAllowance(word: string): 0 | 1 | 2 {
  const length = Array.from(word).length;
  if (length < TYPO_MIN_LENGTH || DIGIT.test(word)) return 0;
  return length >= TYPO_TWO_LENGTH ? 2 : 1;
}

/**
 * Whether `a` becomes `b` with at most `max` edits, each a character inserted, deleted or replaced,
 * or two neighbouring characters swapped (optimal string alignment), counted in characters.
 */
export function withinEdits(a: string, b: string, max: number): boolean {
  const x = Array.from(a);
  const y = Array.from(b);
  if (Math.abs(x.length - y.length) > max) return false;
  let before: number[] = [];
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i += 1) {
    const row = [i];
    let least = i;
    for (let j = 1; j <= y.length; j += 1) {
      let d = Math.min(
        (previous[j] ?? Infinity) + 1,
        (row[j - 1] ?? Infinity) + 1,
        (previous[j - 1] ?? Infinity) + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
        d = Math.min(d, (before[j - 2] ?? Infinity) + 1);
      }
      row[j] = d;
      least = Math.min(least, d);
    }
    // Every later row costs at least this row's least: stop once it is beyond the allowance.
    if (least > max) return false;
    before = previous;
    previous = row;
  }
  return (previous[y.length] ?? Infinity) <= max;
}

/** Whether a word of the message is a keyword word, allowing its typos; the first letter must match. */
function nearWord(word: string, keyword: string): boolean {
  if (word === keyword) return true;
  const allowed = typoAllowance(keyword);
  if (allowed === 0 || DIGIT.test(word)) return false;
  if (Array.from(word)[0] !== Array.from(keyword)[0]) return false;
  return withinEdits(word, keyword, allowed);
}

const words = (text: string) => normalizeRoutingText(text).split(' ').filter(Boolean);

/** Whether the words of `keyword` appear in `text` one after the other, each allowing small typos. */
export function matchesKeywordWithTypos(text: string, keyword: string): boolean {
  const k = words(keyword);
  const t = words(text);
  if (k.length === 0) return false;
  for (let i = 0; i + k.length <= t.length; i += 1) {
    if (k.every((w, j) => nearWord(t[i + j] ?? '', w))) return true;
  }
  return false;
}

/** Whether `text` consists of exactly the words of `keyword`, each allowing small typos. */
export function equalsKeywordWithTypos(text: string, keyword: string): boolean {
  const k = words(keyword);
  const t = words(text);
  return k.length > 0 && k.length === t.length && k.every((w, j) => nearWord(t[j] ?? '', w));
}
