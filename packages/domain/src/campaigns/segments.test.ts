import { describe, expect, it } from 'vitest';
import type { Tx } from '@w360/db';
import { validDate } from '../contacts/fields';
import {
  FIELD_COMPARISONS,
  NAME_COMPARISONS,
  checkSegmentDefinition,
  comparisonTakesValue,
  fieldComparisonsFor,
  fieldConditionProblem,
  segmentDefinitionSchema,
  type SegmentDefinition,
} from './segments';

/** Conditions without a campaign never read the database. */
const noTx = undefined as unknown as Tx;

describe('field conditions (segments and contact searches, ADR-117)', () => {
  it('offers each type of field its own comparisons, in segments’ order', () => {
    expect(fieldComparisonsFor('text')).toEqual([
      'is_set',
      'is_not_set',
      'equals',
      'not_equals',
      'contains',
    ]);
    expect(fieldComparisonsFor('number')).toEqual([
      'is_set',
      'is_not_set',
      'equals',
      'not_equals',
      'greater_than',
      'less_than',
    ]);
    expect(fieldComparisonsFor('date')).toEqual([
      'is_set',
      'is_not_set',
      'equals',
      'before',
      'after',
    ]);
    expect(fieldComparisonsFor('boolean')).toEqual(['is_set', 'is_not_set', 'is_true', 'is_false']);
    expect(FIELD_COMPARISONS.filter((op) => !comparisonTakesValue(op))).toEqual([
      'is_set',
      'is_not_set',
      'is_true',
      'is_false',
    ]);
  });

  it('names what keeps a condition from applying: the comparison, a missing value, a number or a date', () => {
    expect(fieldConditionProblem('text', 'greater_than', 'a')).toBe('comparison');
    expect(fieldConditionProblem('boolean', 'equals', 'true')).toBe('comparison');
    expect(fieldConditionProblem('date', 'not_equals', '2026-01-01')).toBe('comparison');
    expect(fieldConditionProblem('text', 'equals', undefined)).toBe('value_missing');
    expect(fieldConditionProblem('number', 'less_than', '')).toBe('value_missing');
    expect(fieldConditionProblem('number', 'greater_than', 'three')).toBe('not_number');
    expect(fieldConditionProblem('number', 'greater_than', '1234567890123456')).toBe('not_number');
    expect(fieldConditionProblem('number', 'greater_than', '1.1234567')).toBe('not_number');
    expect(fieldConditionProblem('date', 'before', '2026-02-30')).toBe('not_date');
    expect(fieldConditionProblem('date', 'after', '26-02-01')).toBe('not_date');
    // What applies.
    expect(fieldConditionProblem('number', 'greater_than', '-3.5')).toBeNull();
    expect(fieldConditionProblem('date', 'equals', '2024-02-29')).toBeNull();
    expect(fieldConditionProblem('text', 'contains', '50%')).toBeNull();
    expect(fieldConditionProblem('boolean', 'is_true', undefined)).toBeNull();
    expect(fieldConditionProblem('text', 'is_not_set', undefined)).toBeNull();
  });

  it('takes only dates that exist', () => {
    expect(['2024-02-29', '2026-12-31', '1990-04-01'].map(validDate)).toEqual([true, true, true]);
    expect(
      ['2026-02-29', '2026-02-30', '2026-13-01', '2026-1-01', ' 2026-01-01'].map(validDate),
    ).toEqual([false, false, false, false, false]);
  });

  it('refuses a segment whose creation day or date comparison does not exist, in members’ words', async () => {
    const fields = new Map([['birthday', 'date' as const]]);
    const check = (conditions: SegmentDefinition['conditions']) =>
      checkSegmentDefinition(noTx, 'tenant', { match: 'all', conditions }, fields);
    expect(await check([{ type: 'created', op: 'before', date: '2026-02-30' }])).toBe(
      'Enter a date written as YYYY-MM-DD.',
    );
    expect(
      await check([{ type: 'field', key: 'birthday', op: 'after', value: '1990-13-01' }]),
    ).toBe('Enter a date written as YYYY-MM-DD.');
    expect(await check([{ type: 'field', key: 'birthday', op: 'contains', value: '1990' }])).toBe(
      'That comparison does not apply to date fields.',
    );
    expect(await check([{ type: 'field', key: 'birthday', op: 'equals' }])).toBe(
      'Enter a value to compare with.',
    );
    expect(await check([{ type: 'field', key: 'missing', op: 'is_set' }])).toBe(
      'A condition uses a custom field that does not exist.',
    );
    expect(await check([{ type: 'created', op: 'after', date: '2024-02-29' }])).toBeNull();
  });
});

describe('name conditions (ADR-143)', () => {
  const check = (conditions: SegmentDefinition['conditions']) =>
    checkSegmentDefinition(noTx, 'tenant', { match: 'all', conditions }, new Map());

  it('compares a name as a text field’s value is compared', () => {
    expect([...NAME_COMPARISONS]).toEqual(fieldComparisonsFor('text'));
  });

  it('needs the name to compare with for equals, not_equals and contains, in members’ words', async () => {
    for (const op of ['equals', 'not_equals', 'contains'] as const) {
      expect(await check([{ type: 'name', op }])).toBe('Enter a name to compare with.');
      expect(await check([{ type: 'name', op, value: '' }])).toBe('Enter a name to compare with.');
      expect(await check([{ type: 'name', op, value: 'Asha' }])).toBeNull();
    }
    expect(await check([{ type: 'name', op: 'is_set' }])).toBeNull();
    expect(await check([{ type: 'name', op: 'is_not_set' }])).toBeNull();
  });

  it('reads a definition’s name conditions trimmed, up to 200 characters, with the comparisons that apply', () => {
    const parse = (condition: Record<string, unknown>) =>
      segmentDefinitionSchema.safeParse({ conditions: [condition] });
    expect(parse({ type: 'name', op: 'contains', value: '  Asha  ' }).data?.conditions).toEqual([
      { type: 'name', op: 'contains', value: 'Asha' },
    ]);
    expect(parse({ type: 'name', op: 'equals', value: ` ${'x'.repeat(200)} ` }).success).toBe(true);
    expect(parse({ type: 'name', op: 'equals', value: 'x'.repeat(201) }).success).toBe(false);
    expect(parse({ type: 'name', op: 'greater_than', value: 'a' }).success).toBe(false);
    expect(parse({ type: 'name', op: 'is_true' }).success).toBe(false);
  });
});
