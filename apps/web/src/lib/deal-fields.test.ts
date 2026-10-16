import { describe, expect, it } from 'vitest';
import { givenFieldValues } from './deal-fields';

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
