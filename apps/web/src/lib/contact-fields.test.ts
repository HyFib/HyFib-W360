import { describe, expect, it } from 'vitest';
import { changedAttributes, choiceOptions } from './contact-fields';

const plain = (options: string[]) => options.map((option) => ({ option, stale: false }));

describe('a choice field’s select on the contact page (ADR-407)', () => {
  it('lists the options in order', () => {
    expect(choiceOptions(['Gold', 'Silver'], '')).toEqual(plain(['Gold', 'Silver']));
    expect(choiceOptions(['Gold', 'Silver'], 'Silver')).toEqual(plain(['Gold', 'Silver']));
    expect(choiceOptions(null, '')).toEqual([]);
  });

  it('keeps a value the options no longer hold, first and marked stale, so the select shows it', () => {
    expect(choiceOptions(['Gold', 'Silver'], 'Bronze')).toEqual([
      { option: 'Bronze', stale: true },
      ...plain(['Gold', 'Silver']),
    ]);
    expect(choiceOptions(['Gold'], 'gold')).toEqual([
      { option: 'gold', stale: true },
      ...plain(['Gold']),
    ]);
  });
});

describe('the values a contact’s form sends (ADR-407)', () => {
  it('sends only the values the member changed, an emptied one as empty', () => {
    const initial = { tier: 'Bronze', city: 'Pune', vip: '' };
    expect(changedAttributes(initial, initial)).toEqual({});
    expect(changedAttributes(initial, { ...initial, city: 'Delhi' })).toEqual({ city: 'Delhi' });
    expect(changedAttributes(initial, { ...initial, tier: '' })).toEqual({ tier: '' });
    expect(changedAttributes(initial, { ...initial, vip: 'yes' })).toEqual({ vip: 'yes' });
    // A field added since the page was read, and given a value, is sent.
    expect(changedAttributes(initial, { ...initial, plan: 'Pro' })).toEqual({ plan: 'Pro' });
    expect(changedAttributes(initial, { ...initial, plan: '' })).toEqual({});
  });
});
