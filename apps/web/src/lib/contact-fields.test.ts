import { describe, expect, it } from 'vitest';
import { choiceOptions } from './contact-fields';

describe('a choice field’s select on the contact page (ADR-407)', () => {
  it('lists the options in order', () => {
    expect(choiceOptions(['Gold', 'Silver'], '')).toEqual(['Gold', 'Silver']);
    expect(choiceOptions(['Gold', 'Silver'], 'Silver')).toEqual(['Gold', 'Silver']);
    expect(choiceOptions(null, '')).toEqual([]);
  });

  it('keeps a value the options no longer hold, first, so the select still shows it', () => {
    expect(choiceOptions(['Gold', 'Silver'], 'Bronze')).toEqual(['Bronze', 'Gold', 'Silver']);
    expect(choiceOptions(['Gold'], 'gold')).toEqual(['gold', 'Gold']);
  });
});
