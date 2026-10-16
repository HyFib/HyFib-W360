import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { DEAL_CSV_COLUMNS, dealCsvLine } from './deals-csv';
import {
  apiDealFieldValue,
  apiMergedDealAttributes,
  chosenOptionsMessage,
  coerceDealFieldValue,
  createDealFieldSchema,
  dealFieldOptionsSchema,
  MAX_DEAL_FIELD_OPTION_LENGTH,
  MAX_DEAL_FIELD_OPTIONS,
  removedChosenOptions,
  sameOptions,
  keptDealAttributes,
  MAX_DEAL_ATTRIBUTES_BYTES,
  MAX_DEAL_FIELDS,
  mergedDealAttributes,
  sameAttributes,
  shownDealAttributes,
  type DealFieldDefinition,
} from './deal-fields';

const at = new Date('2026-10-13T09:00:00Z');
const fields: DealFieldDefinition[] = [
  {
    id: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01',
    key: 'region',
    label: 'Region',
    type: 'text',
    options: null,
    createdAt: at,
  },
  {
    id: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02',
    key: 'seats',
    label: 'Seats',
    type: 'number',
    options: null,
    createdAt: at,
  },
  {
    id: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03',
    key: 'renewal',
    label: 'Renewal',
    type: 'date',
    options: null,
    createdAt: at,
  },
  {
    id: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f04',
    key: 'signed',
    label: 'Signed',
    type: 'boolean',
    options: null,
    createdAt: at,
  },
];

function refusal(run: () => unknown): { message: string; path: unknown } {
  try {
    run();
  } catch (error) {
    if (!isAppError(error)) throw error;
    expect(error.code).toBe('validation_failed');
    return { message: error.message, path: error.issues?.[0]?.path };
  }
  throw new Error('Expected a refusal');
}

describe('custom deal fields (ADR-373)', () => {
  it('define fields as contact fields are: a label, an optional key and one of four types', () => {
    expect(MAX_DEAL_FIELDS).toBe(50);
    expect(createDealFieldSchema.parse({ label: ' Region ', type: 'text' })).toEqual({
      label: 'Region',
      type: 'text',
    });
    for (const bad of [
      { label: '', type: 'text' },
      { label: 'x'.repeat(81), type: 'text' },
      { label: 'Region', type: 'select' },
      { label: 'Region', type: 'text', key: 'Region' },
      { label: 'Region', type: 'text', key: '1region' },
      { label: 'Region', type: 'text', key: `r${'a'.repeat(40)}` },
    ]) {
      expect(createDealFieldSchema.safeParse(bad).success).toBe(false);
    }
    expect(
      createDealFieldSchema.parse({ label: 'R', type: 'date', key: `r${'a'.repeat(39)}` }).key,
    ).toHaveLength(40);
  });

  it('merge values typed in a form over the current ones, checked against their types', () => {
    const current = { region: 'South', seats: 10, gone: 'kept nowhere' };
    expect(
      mergedDealAttributes(fields, current, {
        seats: ' 12.5 ',
        renewal: '2027-01-31',
        signed: 'Yes',
      }),
    ).toEqual({ region: 'South', seats: 12.5, renewal: '2027-01-31', signed: true });
    // Empty removes a value; "no" is false, not removed.
    expect(mergedDealAttributes(fields, current, { region: '  ', signed: 'no' })).toEqual({
      seats: 10,
      signed: false,
    });
    expect(refusal(() => mergedDealAttributes(fields, {}, { seats: 'many' }))).toEqual({
      message: 'Seats must be a number.',
      path: 'fields.seats',
    });
    expect(refusal(() => mergedDealAttributes(fields, {}, { renewal: '2027-02-30' })).path).toBe(
      'fields.renewal',
    );
    expect(refusal(() => mergedDealAttributes(fields, {}, { signed: 'maybe' })).message).toBe(
      'Signed must be yes or no.',
    );
    expect(refusal(() => mergedDealAttributes(fields, {}, { gone: 'x' }))).toEqual({
      message: 'This deal field no longer exists.',
      path: 'fields.gone',
    });
  });

  it('merge API values given as JSON of their types; null removes, a wrong type is refused', () => {
    const current = { region: 'South', signed: false, gone: 1 };
    expect(
      apiMergedDealAttributes(fields, current, { seats: 3, signed: true, region: null }),
    ).toEqual({ seats: 3, signed: true });
    expect(refusal(() => apiMergedDealAttributes(fields, {}, { seats: '3' }))).toEqual({
      message: 'Seats takes a number.',
      path: 'fields.seats',
    });
    expect(refusal(() => apiMergedDealAttributes(fields, {}, { signed: 'yes' })).message).toBe(
      'Signed takes true or false.',
    );
    expect(refusal(() => apiMergedDealAttributes(fields, {}, { nope: 1 }))).toEqual({
      message: 'The company has no deal field with this key (GET /deal-fields).',
      path: 'fields.nope',
    });
  });

  it('refuse values over 12 KiB in all, below the database bound, by name', () => {
    expect(MAX_DEAL_ATTRIBUTES_BYTES).toBe(12_288);
    const many: DealFieldDefinition[] = Array.from({ length: 30 }, (_, n) => ({
      id: `0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9${String(n).padStart(3, '0')}`,
      key: `note_${n}`,
      label: `Note ${n}`,
      type: 'text',
      options: null,
      createdAt: at,
    }));
    const given = (length: number) =>
      Object.fromEntries(many.map((field) => [field.key, 'x'.repeat(length)]));
    // 30 values of 350 characters fit; of 500, the most text takes, they do not.
    expect(Object.keys(mergedDealAttributes(many, {}, given(350)))).toHaveLength(30);
    expect(refusal(() => mergedDealAttributes(many, {}, given(500)))).toEqual({
      message: "A deal's custom field values are limited to 12 KiB in all.",
      path: 'fields',
    });
    expect(refusal(() => apiMergedDealAttributes(many, {}, given(500))).path).toBe('fields');
  });

  it('keep, compare and show only values of fields that still exist, in the fields order', () => {
    const attributes = { signed: true, gone: 'x', region: 'North' };
    expect(keptDealAttributes(fields, attributes)).toEqual({ signed: true, region: 'North' });
    expect(shownDealAttributes(fields, attributes)).toEqual([
      { key: 'region', label: 'Region', type: 'text', value: 'North' },
      { key: 'signed', label: 'Signed', type: 'boolean', value: true },
    ]);
    // "No" is a value too, shown as such.
    expect(shownDealAttributes(fields, { signed: false, seats: 0 })).toEqual([
      { key: 'seats', label: 'Seats', type: 'number', value: 0 },
      { key: 'signed', label: 'Signed', type: 'boolean', value: false },
    ]);
    expect(sameAttributes({ a: 1, b: 'x' }, { b: 'x', a: 1 })).toBe(true);
    expect(sameAttributes({ a: 1 }, { a: 1, b: 'x' })).toBe(false);
    expect(sameAttributes({ a: 1, b: 'x' }, { a: 1, c: 'x' })).toBe(false);
    expect(sameAttributes({ a: true }, { a: 'true' })).toBe(false);
  });

  it('write each field after the fixed CSV columns, empty where a deal has no value', () => {
    const line = dealCsvLine({
      id: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f09',
      title: 'Plan',
      pipelineName: 'Sales',
      stageName: 'New',
      status: 'open',
      currency: 'INR',
      valueMinor: null,
      ownerName: null,
      contactName: 'Asha',
      contactPhone: null,
      contactErased: false,
      expectedCloseOn: null,
      createdAt: at,
      stageEnteredAt: at,
      closedAt: null,
      lostReason: null,
      openTasks: 0,
      fieldValues: ['North', '', '=1+1'],
    });
    const cells = line.replace(/\r\n$/, '').split(',');
    expect(cells).toHaveLength(DEAL_CSV_COLUMNS.length + 3);
    // Formula-safe as every other cell.
    expect(cells.slice(DEAL_CSV_COLUMNS.length)).toEqual(['North', '', "'=1+1"]);
  });
});

describe('choice-type custom deal fields (ADR-385)', () => {
  const tier: DealFieldDefinition = {
    id: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f05',
    key: 'tier',
    label: 'Tier',
    type: 'choice',
    options: ['Gold', 'Silver', 'Bronze'],
    createdAt: at,
  };
  const withTier = [...fields, tier];
  const issue = (input: unknown) => {
    const result = createDealFieldSchema.safeParse(input);
    return result.success ? null : result.error.issues[0]?.message;
  };

  it('define a choice with 1 to 50 options, each trimmed, at most 80 characters, none twice', () => {
    expect([MAX_DEAL_FIELD_OPTIONS, MAX_DEAL_FIELD_OPTION_LENGTH]).toEqual([50, 80]);
    expect(
      createDealFieldSchema.parse({ label: 'Tier', type: 'choice', options: [' Gold ', 'Silver'] }),
    ).toEqual({ label: 'Tier', type: 'choice', options: ['Gold', 'Silver'] });
    // Kept in the order given, not sorted.
    expect(dealFieldOptionsSchema.parse(['b', 'a', 'C'])).toEqual(['b', 'a', 'C']);
    const fifty = Array.from({ length: 50 }, (_, n) => `Option ${n}`);
    expect(dealFieldOptionsSchema.parse(fifty)).toHaveLength(50);
    expect(dealFieldOptionsSchema.parse(['x'.repeat(80)])[0]).toHaveLength(80);
    expect(issue({ label: 'Tier', type: 'choice' })).toBe(
      'Give a choice field at least one option.',
    );
    expect(issue({ label: 'Tier', type: 'choice', options: [] })).toBe(
      'Give a choice field at least one option.',
    );
    expect(issue({ label: 'Tier', type: 'choice', options: [...fifty, 'One more'] })).toBe(
      'A choice field has at most 50 options.',
    );
    expect(issue({ label: 'Tier', type: 'choice', options: ['Gold', '  '] })).toBe(
      'Options cannot be empty.',
    );
    expect(issue({ label: 'Tier', type: 'choice', options: ['x'.repeat(81)] })).toBe(
      'Options are limited to 80 characters.',
    );
    expect(issue({ label: 'Tier', type: 'choice', options: ['Gold', 'Two\nlines'] })).toBe(
      'Options cannot hold line breaks or control characters.',
    );
    expect(issue({ label: 'Tier', type: 'choice', options: ['a\u0085b'] })).toBe(
      'Options cannot hold line breaks or control characters.',
    );
    const twice = createDealFieldSchema.safeParse({
      label: 'Tier',
      type: 'choice',
      options: ['Gold', 'Silver', ' gold'],
    });
    expect(twice.success ? null : twice.error.issues[0]).toMatchObject({
      message: '“gold” is listed twice.',
      path: ['options', 2],
    });
    // Other types take no options.
    expect(issue({ label: 'Region', type: 'text', options: ['North'] })).toBe(
      'Only choice fields have options.',
    );
  });

  it('take one of the options from forms and CSV files whatever the case, stored as written', () => {
    expect(coerceDealFieldValue(tier, ' silver ')).toEqual({ ok: true, value: 'Silver' });
    expect(coerceDealFieldValue(tier, 'Gold')).toEqual({ ok: true, value: 'Gold' });
    expect(coerceDealFieldValue(tier, '  ')).toEqual({ ok: true, value: null });
    expect(coerceDealFieldValue(tier, 'Platinum')).toEqual({
      ok: false,
      message: 'Tier must be one of its options.',
    });
    expect(coerceDealFieldValue(tier, 'Gol')).toMatchObject({ ok: false });
    // Other types keep the contact fields' rules.
    expect(coerceDealFieldValue(fields[3]!, 'yes')).toEqual({ ok: true, value: true });
    expect(mergedDealAttributes(withTier, { tier: 'Gold', seats: 2 }, { tier: 'BRONZE' })).toEqual({
      tier: 'Bronze',
      seats: 2,
    });
    expect(mergedDealAttributes(withTier, { tier: 'Gold' }, { tier: '' })).toEqual({});
    expect(refusal(() => mergedDealAttributes(withTier, {}, { tier: 'Tin' }))).toEqual({
      message: 'Tier must be one of its options.',
      path: 'fields.tier',
    });
  });

  it('take one of the options through the API exactly as written; null or empty removes it', () => {
    expect(apiDealFieldValue(tier, 'Silver')).toEqual({ ok: true, value: 'Silver' });
    expect(apiDealFieldValue(tier, null)).toEqual({ ok: true, value: null });
    expect(apiDealFieldValue(tier, '')).toEqual({ ok: true, value: null });
    const refused = {
      ok: false,
      message: 'Tier takes one of its options, written as GET /deal-fields lists them.',
    };
    for (const bad of ['silver', 'Platinum', 1, true, ['Gold']]) {
      expect(apiDealFieldValue(tier, bad)).toEqual(refused);
    }
    expect(apiDealFieldValue(fields[1]!, 3)).toEqual({ ok: true, value: 3 });
    expect(apiMergedDealAttributes(withTier, { tier: 'Gold' }, { tier: 'Bronze' })).toEqual({
      tier: 'Bronze',
    });
    expect(refusal(() => apiMergedDealAttributes(withTier, {}, { tier: 'gold' })).path).toBe(
      'fields.tier',
    );
  });

  it('change options only while every option deals have chosen stays as written', () => {
    expect(sameOptions(['Gold', 'Silver'], ['Gold', 'Silver'])).toBe(true);
    expect(sameOptions(['Gold', 'Silver'], ['Silver', 'Gold'])).toBe(false);
    expect(sameOptions(['Gold'], ['gold'])).toBe(false);
    expect(sameOptions(['Gold'], ['Gold', 'Silver'])).toBe(false);
    const current = ['Gold', 'Silver', 'Bronze'];
    // Added, reordered, an unused option removed: nothing chosen is lost.
    expect(removedChosenOptions(current, ['Bronze', 'Gold', 'Tin'], ['Gold', 'Bronze'])).toEqual(
      [],
    );
    // Removing or renaming (even its case) a chosen option names it, in the current order.
    expect(removedChosenOptions(current, ['gold'], ['Bronze', 'Gold', 'Silver'])).toEqual([
      'Gold',
      'Silver',
      'Bronze',
    ]);
    expect(removedChosenOptions(current, ['Gold', 'Bronze'], ['Silver'])).toEqual(['Silver']);
    expect(chosenOptionsMessage(['Silver'])).toBe(
      'Deals have “Silver” chosen, so it cannot be removed or renamed. Change those deals first.',
    );
    expect(chosenOptionsMessage(['Gold', 'Silver'])).toBe(
      'Deals have “Gold”, “Silver” chosen, so they cannot be removed or renamed. Change those deals first.',
    );
  });

  it('show and export a chosen option as written', () => {
    expect(shownDealAttributes(withTier, { tier: 'Silver', gone: 'x' })).toEqual([
      { key: 'tier', label: 'Tier', type: 'choice', value: 'Silver' },
    ]);
  });
});
