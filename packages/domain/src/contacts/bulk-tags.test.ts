import { describe, expect, it } from 'vitest';
import { BULK_TAG_LIMIT, bulkTagSummary, type BulkTagResult } from './bulk-tags';
import { bulkTagSchema } from './service';

const result = (overrides: Partial<BulkTagResult>): BulkTagResult => ({
  action: 'add',
  tag: 'vip',
  matched: 1,
  changed: 1,
  unchanged: 0,
  atLimit: 0,
  ...overrides,
});

describe('bulk tag edits (ADR-213)', () => {
  it('say what an addition did, with those that had the tag or have the most tags', () => {
    expect(bulkTagSummary(result({}))).toBe('Added “vip” to 1 contact.');
    expect(
      bulkTagSummary(result({ matched: 1_203, changed: 1_200, unchanged: 1, atLimit: 2 })),
    ).toBe(
      'Added “vip” to 1,200 contacts. 1 contact already had it. 2 contacts already have 50 tags, the most a contact can have, so they were left as they were.',
    );
    expect(bulkTagSummary(result({ matched: 3, changed: 0, unchanged: 2, atLimit: 1 }))).toBe(
      'Added “vip” to 0 contacts. 2 contacts already had it. 1 contact already has 50 tags, the most a contact can have, so it was left as it was.',
    );
  });

  it('say what a removal did, with those that did not have the tag', () => {
    expect(bulkTagSummary(result({ action: 'remove', matched: 5, changed: 3, unchanged: 2 }))).toBe(
      'Removed “vip” from 3 contacts. 2 contacts did not have it.',
    );
    expect(bulkTagSummary(result({ action: 'remove', changed: 0, unchanged: 1 }))).toBe(
      'Removed “vip” from 0 contacts. 1 contact did not have it.',
    );
  });

  it('take the filters, the tag, add or remove, and the count shown, at most 10,000', () => {
    expect(BULK_TAG_LIMIT).toBe(10_000);
    const edit = { filter: { tag: 'pune' }, tag: 'vip', action: 'add', expectedCount: 1 };
    expect(bulkTagSchema.parse(edit)).toEqual({ ...edit, filter: { tag: 'pune', consent: 'any' } });
    for (const wrong of [
      { ...edit, expectedCount: 0 },
      { ...edit, expectedCount: BULK_TAG_LIMIT + 1 },
      { ...edit, action: 'replace' },
      { ...edit, filter: { consent: 'everyone' } },
    ]) {
      expect(bulkTagSchema.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    }
  });
});
