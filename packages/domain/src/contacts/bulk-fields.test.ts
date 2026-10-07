import { describe, expect, it } from 'vitest';
import { bulkFieldSummary, type BulkFieldResult } from './bulk-fields';
import { BULK_TAG_LIMIT } from './bulk-tags';
import { bulkFieldSchema } from './service';

const result = (overrides: Partial<BulkFieldResult>): BulkFieldResult => ({
  key: 'city',
  label: 'City',
  value: 'Pune',
  matched: 1,
  changed: 1,
  unchanged: 0,
  ...overrides,
});

describe('bulk field edits (ADR-238)', () => {
  it('say what setting a value did, with those that already had it', () => {
    expect(bulkFieldSummary(result({}))).toBe('Set “City” to “Pune” on 1 contact.');
    expect(bulkFieldSummary(result({ matched: 1_203, changed: 1_200, unchanged: 3 }))).toBe(
      'Set “City” to “Pune” on 1,200 contacts. 3 contacts already had this value.',
    );
    expect(bulkFieldSummary(result({ changed: 0, unchanged: 1 }))).toBe(
      'Set “City” to “Pune” on 0 contacts. 1 contact already had this value.',
    );
  });

  it('show yes or no, numbers as stored, and cut a long value short whole characters at a time', () => {
    expect(bulkFieldSummary(result({ label: 'Wholesale', value: true }))).toBe(
      'Set “Wholesale” to “yes” on 1 contact.',
    );
    expect(bulkFieldSummary(result({ label: 'Wholesale', value: false }))).toBe(
      'Set “Wholesale” to “no” on 1 contact.',
    );
    expect(bulkFieldSummary(result({ label: 'Orders', value: 12.5 }))).toBe(
      'Set “Orders” to “12.5” on 1 contact.',
    );
    const sixty = 'a'.repeat(59) + '😀';
    expect(bulkFieldSummary(result({ value: sixty }))).toBe(
      `Set “City” to “${sixty}” on 1 contact.`,
    );
    expect(bulkFieldSummary(result({ value: `${sixty}b` }))).toBe(
      `Set “City” to “${sixty}…” on 1 contact.`,
    );
  });

  it('say what clearing did, with those that had no value', () => {
    expect(bulkFieldSummary(result({ value: null, matched: 5, changed: 3, unchanged: 2 }))).toBe(
      'Cleared “City” on 3 contacts. 2 contacts had no value.',
    );
    expect(bulkFieldSummary(result({ value: null }))).toBe('Cleared “City” on 1 contact.');
  });

  it('take the filters, the field, the value and the count shown, at most 10,000', () => {
    const edit = { filter: { tag: 'pune' }, key: 'city', value: '', expectedCount: 1 };
    expect(bulkFieldSchema.parse(edit)).toEqual({
      ...edit,
      filter: { tag: 'pune', consent: 'any' },
    });
    for (const wrong of [
      { ...edit, expectedCount: 0 },
      { ...edit, expectedCount: BULK_TAG_LIMIT + 1 },
      { ...edit, key: 'k'.repeat(41) },
      { ...edit, value: 'v'.repeat(1001) },
      { ...edit, value: 5 },
      { ...edit, filter: { consent: 'everyone' } },
    ]) {
      expect(bulkFieldSchema.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    }
  });
});
