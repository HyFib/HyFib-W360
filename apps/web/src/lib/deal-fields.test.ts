import { describe, expect, it } from 'vitest';
import { givenFieldValues, optionLines } from './deal-fields';

describe('custom field values on a new deal (ADR-379)', () => {
  it('sends the fields given, as typed, and none left empty', () => {
    expect(
      givenFieldValues({
        region: ' South ',
        seats: '',
        signed: 'false',
        notes: '   ',
        closed: '0',
      }),
    ).toEqual({ region: ' South ', signed: 'false', closed: '0' });
    expect(givenFieldValues({})).toEqual({});
  });
});

describe('a choice field’s options typed one per line (ADR-385)', () => {
  it('keeps each line trimmed, in order, and leaves blank lines out', () => {
    expect(optionLines(' Gold \r\nSilver\n\n  \rBronze\n')).toEqual(['Gold', 'Silver', 'Bronze']);
    expect(optionLines('Two words here')).toEqual(['Two words here']);
    expect(optionLines('  \n')).toEqual([]);
  });
});
