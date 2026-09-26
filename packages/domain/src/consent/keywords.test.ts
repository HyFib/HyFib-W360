import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MARKETING_OPT_OUT_KEYWORDS,
  DEFAULT_OPT_IN_KEYWORDS,
  DEFAULT_OPT_OUT_KEYWORDS,
  findKeywordConflict,
  matchConsentKeyword,
  normalizeKeyword,
  parseKeywordList,
} from './keywords';
import { providerConsentInstant } from './service';

const defaults = {
  optOutKeywords: DEFAULT_OPT_OUT_KEYWORDS,
  marketingOptOutKeywords: DEFAULT_MARKETING_OPT_OUT_KEYWORDS,
  optInKeywords: DEFAULT_OPT_IN_KEYWORDS,
};

describe('consent keywords', () => {
  it('matches whole messages regardless of case, spacing and surrounding punctuation', () => {
    for (const text of ['STOP', 'stop', ' Stop! ', 'stop.', '🛑 stop 🛑', 'Stop   all']) {
      expect(matchConsentKeyword(text, defaults)?.action).toBe('opt_out_all');
    }
    expect(matchConsentKeyword('Stop promotions', defaults)).toEqual({
      action: 'opt_out_marketing',
      keyword: 'STOP PROMOTIONS',
    });
    expect(matchConsentKeyword('start', defaults)?.action).toBe('opt_in');
  });

  it('does not match keywords inside longer messages', () => {
    for (const text of ['please stop', 'stop sending me offers', 'STOPPED', 'startup', '', null]) {
      expect(matchConsentKeyword(text, defaults)).toBeNull();
    }
    expect(matchConsentKeyword(`STOP${' '.repeat(80)}`, defaults)).toBeNull();
  });

  it('normalises and validates keyword lists entered by members', () => {
    expect(parseKeywordList('stop, Unsubscribe\n  opt   out ,stop', 'Opt-out')).toEqual({
      ok: true,
      keywords: ['STOP', 'UNSUBSCRIBE', 'OPT OUT'],
    });
    expect(parseKeywordList('st-op', 'Opt-out').ok).toBe(false);
    expect(parseKeywordList('x'.repeat(31), 'Opt-out').ok).toBe(false);
    expect(parseKeywordList(Array.from({ length: 21 }, (_, i) => `K${i}`).join(','), 'X').ok).toBe(
      false,
    );
    expect(normalizeKeyword('  ¡Alto!  ')).toBe('ALTO');
  });

  it('rejects a keyword that appears in two lists', () => {
    expect(findKeywordConflict(defaults)).toBeNull();
    expect(findKeywordConflict({ ...defaults, optInKeywords: ['START', 'stop'] })).toMatch(/STOP/);
  });
});

describe('provider consent timing', () => {
  it('places opt-outs at the end and opt-ins at the start of a whole-second provider time', () => {
    const second = new Date('2026-09-26T10:00:05.000Z');
    expect(providerConsentInstant(second, 'opt_out').toISOString()).toBe(
      '2026-09-26T10:00:05.999Z',
    );
    expect(providerConsentInstant(second, 'opt_in').toISOString()).toBe('2026-09-26T10:00:05.000Z');
  });
});
