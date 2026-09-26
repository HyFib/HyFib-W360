/**
 * Consent keywords. A keyword matches when it is the whole inbound message, ignoring letter case,
 * repeated spaces and punctuation or emoji around it ("Stop!", " stop. " and "STOP" all match
 * STOP; "please stop sending" does not). Opt-out keywords are checked before opt-in keywords.
 */
export const DEFAULT_OPT_OUT_KEYWORDS = ['STOP', 'UNSUBSCRIBE', 'STOP ALL', 'OPT OUT'] as const;
export const DEFAULT_MARKETING_OPT_OUT_KEYWORDS = ['STOP PROMOTIONS'] as const;
export const DEFAULT_OPT_IN_KEYWORDS = ['START', 'SUBSCRIBE'] as const;

export const MAX_KEYWORDS_PER_LIST = 20;
export const MAX_KEYWORD_LENGTH = 30;
/** Messages longer than this are never treated as keywords. */
const MAX_MATCH_LENGTH = 60;

export interface KeywordSettings {
  optOutKeywords: readonly string[];
  marketingOptOutKeywords: readonly string[];
  optInKeywords: readonly string[];
}

export type KeywordAction = 'opt_out_all' | 'opt_out_marketing' | 'opt_in';

export interface KeywordMatch {
  action: KeywordAction;
  keyword: string;
}

export function normalizeKeyword(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .toLocaleUpperCase('en-US');
}

export function matchConsentKeyword(
  text: string | null | undefined,
  settings: KeywordSettings,
): KeywordMatch | null {
  if (!text || text.length > MAX_MATCH_LENGTH) return null;
  const candidate = normalizeKeyword(text);
  if (!candidate) return null;
  const lists: [KeywordAction, readonly string[]][] = [
    ['opt_out_all', settings.optOutKeywords],
    ['opt_out_marketing', settings.marketingOptOutKeywords],
    ['opt_in', settings.optInKeywords],
  ];
  for (const [action, list] of lists) {
    const keyword = list.find((k) => normalizeKeyword(k) === candidate);
    if (keyword) return { action, keyword: normalizeKeyword(keyword) };
  }
  return null;
}

export type KeywordListResult = { ok: true; keywords: string[] } | { ok: false; message: string };

/** Parses a comma- or newline-separated keyword list entered by a member. */
export function parseKeywordList(input: string, label: string): KeywordListResult {
  const keywords: string[] = [];
  for (const part of input.split(/[,\n]/)) {
    const keyword = normalizeKeyword(part);
    if (!keyword) continue;
    if (keyword.length > MAX_KEYWORD_LENGTH) {
      return {
        ok: false,
        message: `${label}: keywords are limited to ${MAX_KEYWORD_LENGTH} characters.`,
      };
    }
    if (!/^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*$/u.test(keyword)) {
      return { ok: false, message: `${label}: use only letters, digits and spaces in keywords.` };
    }
    if (!keywords.includes(keyword)) keywords.push(keyword);
  }
  if (keywords.length > MAX_KEYWORDS_PER_LIST) {
    return { ok: false, message: `${label}: at most ${MAX_KEYWORDS_PER_LIST} keywords.` };
  }
  return { ok: true, keywords };
}

/** A keyword may appear in only one list, otherwise its meaning would be ambiguous. */
export function findKeywordConflict(settings: KeywordSettings): string | null {
  const seen = new Map<string, string>();
  const lists: [string, readonly string[]][] = [
    ['opt-out', settings.optOutKeywords],
    ['marketing opt-out', settings.marketingOptOutKeywords],
    ['opt-in', settings.optInKeywords],
  ];
  for (const [name, list] of lists) {
    for (const k of list) {
      const key = normalizeKeyword(k);
      const other = seen.get(key);
      if (other && other !== name) return `"${key}" is in both the ${other} and ${name} lists.`;
      seen.set(key, name);
    }
  }
  return null;
}
