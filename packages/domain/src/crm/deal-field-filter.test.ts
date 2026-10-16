import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { isAppError } from '@w360/core';
import {
  DEAL_FIELD_FILTER_MAX_LENGTH,
  dealFieldFilterAudit,
  dealFieldFilterParam,
  dealFieldFilterProblemMessage,
  dealFieldFilterRefusal,
  dealFieldFilterView,
  filterableDealFields,
  parseDealFieldFilterParam,
  requireDealFieldFilter,
  resolveDealFieldFilter,
  type DealFieldFilterProblem,
  type FilterableFieldShape,
} from './deal-field-filter';
import { dealFieldCondition } from './deals';

const fields: FilterableFieldShape[] = [
  { key: 'region', label: 'Region', type: 'text', options: null },
  { key: 'tier', label: 'Tier', type: 'choice', options: ['Gold', 'Silver: plus', 'Bronze'] },
  { key: 'signed', label: 'Signed', type: 'boolean', options: null },
  { key: 'seats', label: 'Seats', type: 'number', options: null },
];

describe('deal field filter in the address (ADR-391)', () => {
  it('reads <key>:<option>, splitting at the first colon, and <key>: as "not set"', () => {
    expect(parseDealFieldFilterParam('tier:Gold')).toEqual({ key: 'tier', value: 'Gold' });
    expect(parseDealFieldFilterParam('tier:Silver: plus')).toEqual({
      key: 'tier',
      value: 'Silver: plus',
    });
    expect(parseDealFieldFilterParam('tier: Gold ')).toEqual({ key: 'tier', value: 'Gold' });
    expect(parseDealFieldFilterParam('tier:')).toEqual({ key: 'tier', value: null });
    expect(parseDealFieldFilterParam('a:x')).toEqual({ key: 'a', value: 'x' });
  });

  it('takes nothing malformed: no colon, a bad key, a blank option, empty or overlong text', () => {
    for (const raw of [
      null,
      undefined,
      '',
      'tier',
      ':Gold',
      'Tier:Gold',
      '1tier:Gold',
      'ti-er:Gold',
      `${'a'.repeat(41)}:Gold`,
      'tier:   ',
    ]) {
      expect(parseDealFieldFilterParam(raw), String(raw)).toBeNull();
    }
    const longest = `${'a'.repeat(40)}:${'b'.repeat(DEAL_FIELD_FILTER_MAX_LENGTH - 41)}`;
    expect(longest).toHaveLength(DEAL_FIELD_FILTER_MAX_LENGTH);
    expect(parseDealFieldFilterParam(longest)).not.toBeNull();
    expect(parseDealFieldFilterParam(`${longest}b`)).toBeNull();
  });

  it('writes the text it reads', () => {
    expect(dealFieldFilterParam('tier', 'Silver: plus')).toBe('tier:Silver: plus');
    expect(dealFieldFilterParam('tier', null)).toBe('tier:');
    expect(parseDealFieldFilterParam(dealFieldFilterParam('tier', 'Silver: plus'))).toEqual({
      key: 'tier',
      value: 'Silver: plus',
    });
  });

  it('offers the choice and yes/no fields only, in order, each with "Not set" last', () => {
    expect(filterableDealFields(fields)).toEqual([
      {
        key: 'tier',
        label: 'Tier',
        type: 'choice',
        choices: [
          { param: 'tier:Gold', label: 'Gold' },
          { param: 'tier:Silver: plus', label: 'Silver: plus' },
          { param: 'tier:Bronze', label: 'Bronze' },
          { param: 'tier:', label: 'Not set' },
        ],
      },
      {
        key: 'signed',
        label: 'Signed',
        type: 'boolean',
        choices: [
          { param: 'signed:yes', label: 'Yes' },
          { param: 'signed:no', label: 'No' },
          { param: 'signed:', label: 'Not set' },
        ],
      },
    ]);
    expect(filterableDealFields([fields[0]!, fields[3]!])).toEqual([]);
  });

  it('resolves an option, any case, to the option as written, which deals store', () => {
    expect(resolveDealFieldFilter(fields, { key: 'tier', value: 'gOLD' })).toEqual({
      ok: true,
      filter: {
        key: 'tier',
        label: 'Tier',
        type: 'choice',
        stored: 'Gold',
        param: 'tier:Gold',
        valueLabel: 'Gold',
      },
    });
    expect(resolveDealFieldFilter(fields, { key: 'tier', value: null })).toEqual({
      ok: true,
      filter: {
        key: 'tier',
        label: 'Tier',
        type: 'choice',
        stored: null,
        param: 'tier:',
        valueLabel: 'Not set',
      },
    });
  });

  it('resolves yes and no to booleans for a yes/no field', () => {
    const yes = resolveDealFieldFilter(fields, { key: 'signed', value: 'YES' });
    expect(yes).toMatchObject({
      ok: true,
      filter: { stored: true, param: 'signed:yes', valueLabel: 'Yes' },
    });
    const no = resolveDealFieldFilter(fields, { key: 'signed', value: 'no' });
    expect(no).toMatchObject({
      ok: true,
      filter: { stored: false, param: 'signed:no', valueLabel: 'No' },
    });
    expect(resolveDealFieldFilter(fields, { key: 'signed', value: null })).toMatchObject({
      ok: true,
      filter: { stored: null, param: 'signed:', valueLabel: 'Not set' },
    });
    expect(resolveDealFieldFilter(fields, { key: 'signed', value: 'true' })).toEqual({
      ok: false,
      problem: 'no_option',
    });
  });

  it('names what does not resolve: malformed, no such field, another type, no such option', () => {
    expect(resolveDealFieldFilter(fields, null)).toEqual({ ok: false, problem: 'malformed' });
    expect(resolveDealFieldFilter(fields, { key: 'plan', value: 'Gold' })).toEqual({
      ok: false,
      problem: 'no_field',
    });
    expect(resolveDealFieldFilter(fields, { key: 'region', value: 'North' })).toEqual({
      ok: false,
      problem: 'not_filterable',
    });
    expect(resolveDealFieldFilter(fields, { key: 'seats', value: null })).toEqual({
      ok: false,
      problem: 'not_filterable',
    });
    expect(resolveDealFieldFilter(fields, { key: 'tier', value: 'Platinum' })).toEqual({
      ok: false,
      problem: 'no_option',
    });
    // Another company's fields resolve nothing here: only the fields given are looked at.
    expect(resolveDealFieldFilter([], { key: 'tier', value: 'Gold' })).toEqual({
      ok: false,
      problem: 'no_field',
    });
    expect(dealFieldFilterProblemMessage('no_field')).toBe('This deal field no longer exists.');
    expect(dealFieldFilterProblemMessage('no_option')).toMatch(/not one of the deal field’s/);
    expect(dealFieldFilterProblemMessage('not_filterable')).toMatch(/choice or yes\/no/);
    expect(dealFieldFilterProblemMessage('malformed')).toMatch(/not valid/);
  });

  it('audits the key and the kind of match, never the option', () => {
    const audit = (key: string, value: string | null) => {
      const resolved = resolveDealFieldFilter(fields, { key, value });
      if (!resolved.ok) throw new Error(resolved.problem);
      return dealFieldFilterAudit(resolved.filter);
    };
    expect(audit('tier', 'Gold')).toEqual({ key: 'tier', match: 'option' });
    expect(audit('tier', null)).toEqual({ key: 'tier', match: 'not_set' });
    expect(audit('signed', 'yes')).toEqual({ key: 'signed', match: 'yes' });
    expect(audit('signed', 'no')).toEqual({ key: 'signed', match: 'no' });
    expect(audit('signed', null)).toEqual({ key: 'signed', match: 'not_set' });
    expect(JSON.stringify(audit('tier', 'Gold'))).not.toContain('Gold');
  });
});

describe('the board query’s field condition (ADR-391)', () => {
  const rendered = (key: string, value: string | null) => {
    const resolved = resolveDealFieldFilter(fields, { key, value });
    if (!resolved.ok) throw new Error(resolved.problem);
    const condition = dealFieldCondition(resolved.filter);
    if (!condition) throw new Error('no condition');
    const { sql, params } = new PgDialect().sqlToQuery(condition);
    return { sql, params };
  };

  it('adds nothing without a filter', () => {
    expect(dealFieldCondition(null)).toBeUndefined();
  });

  it('compares the stored JSON value exactly: the option as written, or a boolean', () => {
    expect(rendered('tier', 'gold')).toEqual({
      sql: '("app"."crm_deals"."attributes" -> $1::text) = $2::jsonb',
      params: ['tier', '"Gold"'],
    });
    expect(rendered('signed', 'yes')).toEqual({
      sql: '("app"."crm_deals"."attributes" -> $1::text) = $2::jsonb',
      params: ['signed', 'true'],
    });
    expect(rendered('signed', 'no').params).toEqual(['signed', 'false']);
  });

  it('takes deals without the key for "not set"', () => {
    expect(rendered('tier', null)).toEqual({
      sql: 'not ("app"."crm_deals"."attributes" ? $1::text)',
      params: ['tier'],
    });
  });
});

describe('the lenient and the strict readings (ADR-394)', () => {
  it('ignores and reports what does not resolve, for the board and the won and lost lists', () => {
    const offered = filterableDealFields(fields);
    for (const raw of [null, undefined, '']) {
      expect(dealFieldFilterView(fields, raw), String(raw)).toEqual({
        fields: offered,
        applied: null,
        ignored: false,
      });
    }
    const gold = dealFieldFilterView(fields, 'tier:gOLD');
    expect(gold.ignored).toBe(false);
    expect(gold.fields).toEqual(offered);
    expect(gold.applied).toMatchObject({ key: 'tier', stored: 'Gold', param: 'tier:Gold' });
    expect(dealFieldFilterView(fields, 'signed:').applied).toMatchObject({ stored: null });
    for (const raw of ['tier', 'tier:Platinum', 'region:North', 'plan:Gold', ' ', 'Tier:Gold']) {
      expect(dealFieldFilterView(fields, raw), raw).toEqual({
        fields: offered,
        applied: null,
        ignored: true,
      });
    }
  });

  it('refuses what does not resolve, naming field, in the caller’s words', () => {
    const refusal = (raw: string, message?: (problem: DealFieldFilterProblem) => string) => {
      try {
        requireDealFieldFilter(fields, raw, message);
      } catch (error) {
        if (!isAppError(error)) throw error;
        return [error.code, error.publicMessage, error.issues];
      }
      throw new Error('expected a refusal');
    };
    expect(requireDealFieldFilter(fields, 'signed:No')).toMatchObject({
      key: 'signed',
      stored: false,
      param: 'signed:no',
    });
    expect(requireDealFieldFilter(fields, 'tier:')).toMatchObject({ key: 'tier', stored: null });
    expect(refusal('tier:Platinum')).toEqual([
      'validation_failed',
      'This option is not one of the deal field’s options.',
      [{ path: 'field', message: 'This option is not one of the deal field’s options.' }],
    ]);
    for (const [raw, problem] of [
      ['', 'malformed'],
      ['tier', 'malformed'],
      ['plan:Gold', 'no_field'],
      ['seats:', 'not_filterable'],
      ['signed:true', 'no_option'],
    ] as const) {
      expect(refusal(raw)[1], raw).toBe(dealFieldFilterProblemMessage(problem));
      expect(
        refusal(raw, (p) => `api ${p}`),
        raw,
      ).toEqual([
        'validation_failed',
        `api ${problem}`,
        [{ path: 'field', message: `api ${problem}` }],
      ]);
    }
    expect(dealFieldFilterRefusal('no_field').issues).toEqual([
      { path: 'field', message: 'This deal field no longer exists.' },
    ]);
  });
});
