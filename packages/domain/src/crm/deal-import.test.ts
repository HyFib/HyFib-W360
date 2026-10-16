import { describe, expect, it } from 'vitest';
import {
  DEAL_IMPORT_LIMITS,
  dealImportSchema,
  importedPhones,
  phoneMode,
  planDealRows,
  type DealImportLookups,
} from './deal-import';

const at = new Date('2026-10-13T09:00:00Z');
const lookups: DealImportLookups = {
  currency: 'INR',
  stages: [
    { id: 'stage-new', name: 'New' },
    { id: 'stage-won', name: 'Proposal sent' },
  ],
  contactsByPhone: new Map([
    ['+919876543210', 'contact-asha'],
    ['+919812345678', 'contact-ravi'],
  ]),
  ownersByEmail: new Map([['meera@example.test', 'member-meera']]),
  fields: [
    { id: 'f1', key: 'seats', label: 'Seats', type: 'number', options: null, createdAt: at },
    { id: 'f2', key: 'signed', label: 'Signed', type: 'boolean', options: null, createdAt: at },
  ],
};
// phone, title, stage, value, owner, close, seats, signed
const mapping = {
  phone: 0,
  title: 1,
  stage: 2,
  value: 3,
  owner: 4,
  expectedCloseOn: 5,
  fields: { seats: 6, signed: 7 },
};
const international = phoneMode({ phoneFormat: 'international' });

describe('deal import (ADR-374)', () => {
  it('takes a pipeline, a phone format and columns for a phone number and a title at least', () => {
    expect(DEAL_IMPORT_LIMITS.maxRows).toBe(1000);
    const parsed = dealImportSchema.parse({
      fileName: 'deals.csv',
      pipelineId: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01',
      phoneFormat: 'international',
      mapping: { phone: 0, title: 1 },
    });
    expect(parsed.mapping).toEqual({
      phone: 0,
      title: 1,
      stage: null,
      value: null,
      owner: null,
      expectedCloseOn: null,
      fields: {},
    });
    for (const bad of [
      { mapping: { phone: 0 } },
      { mapping: { title: 1 } },
      { mapping: { phone: -1, title: 1 } },
      { mapping: { phone: 0, title: 1, fields: { Seats: 2 } } },
      { pipelineId: 'sales' },
      { phoneFormat: 'local' },
    ]) {
      const input = {
        fileName: 'deals.csv',
        pipelineId: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01',
        phoneFormat: 'international',
        mapping: { phone: 0, title: 1 },
        ...bad,
      };
      expect(dealImportSchema.safeParse(input).success, JSON.stringify(bad)).toBe(false);
    }
    expect(phoneMode({ phoneFormat: 'national', callingCode: '91' })).toEqual({
      kind: 'national',
      callingCode: '91',
    });
  });

  it('plans a deal for each valid row: its contact, stage, exact value, owner, date and fields', () => {
    const { deals, messages } = planDealRows(
      [
        [
          '+91 98765 43210',
          ' Annual plan ',
          'proposal SENT',
          '25,000.50',
          'Meera@Example.test',
          '2026-12-31',
          '12',
          'yes',
        ],
        ['919812345678', 'Renewal', '', '', '', '', '', ''],
      ],
      mapping,
      international,
      lookups,
    );
    expect(messages).toEqual([]);
    expect(deals).toEqual([
      {
        line: 2,
        contactId: 'contact-asha',
        stageId: 'stage-won',
        title: 'Annual plan',
        valueMinor: 2_500_050,
        ownerMembershipId: 'member-meera',
        expectedCloseOn: '2026-12-31',
        attributes: { seats: 12, signed: true },
      },
      // Without a stage, the pipeline's first; nothing else set.
      {
        line: 3,
        contactId: 'contact-ravi',
        stageId: 'stage-new',
        title: 'Renewal',
        valueMinor: null,
        ownerMembershipId: null,
        expectedCloseOn: null,
        attributes: {},
      },
    ]);
    // National numbers for a calling code find the same contact.
    expect(
      planDealRows(
        [['09876543210', 'Plan', '', '', '', '', '', '']],
        mapping,
        phoneMode({ phoneFormat: 'national', callingCode: '91' }),
        lookups,
      ).deals[0]?.contactId,
    ).toBe('contact-asha');
  });

  it('skips each row with a problem, naming its row and the problem, and keeps the others', () => {
    const row = (overrides: Record<number, string>) => {
      const base = ['+919876543210', 'Plan', '', '', '', '', '', ''];
      for (const [i, v] of Object.entries(overrides)) base[Number(i)] = v;
      return base;
    };
    const { deals, messages } = planDealRows(
      [
        row({ 0: 'abc' }),
        row({ 0: '+919999999999' }),
        row({ 1: '' }),
        row({ 1: 'x'.repeat(121) }),
        row({ 2: 'Lost' }),
        row({ 3: '12.345' }),
        row({ 3: 'ten' }),
        row({ 4: 'someone@example.test' }),
        row({ 5: '2026-02-30' }),
        row({ 6: 'many' }),
        row({ 7: 'maybe' }),
        row({}),
      ],
      mapping,
      international,
      lookups,
    );
    expect(deals.map((d) => d.line)).toEqual([13]);
    expect(messages.map((m) => [m.row, m.level, m.message])).toEqual([
      [2, 'error', expect.stringMatching(/./)],
      [3, 'error', 'No contact has this phone number. Add or import the contact first.'],
      [4, 'error', 'Title is missing.'],
      [5, 'error', 'Title is longer than 120 characters.'],
      [6, 'error', 'The pipeline has no stage named “Lost”.'],
      [7, 'error', 'Value must be an amount in INR with at most 2 decimals.'],
      [8, 'error', 'Value must be an amount in INR with at most 2 decimals.'],
      [9, 'error', 'Owner must be the email of an active member who can use the CRM.'],
      [10, 'error', 'Expected close date must be a date written as YYYY-MM-DD.'],
      [11, 'error', 'Seats must be a number.'],
      [12, 'error', 'Signed must be yes or no.'],
    ]);
    // A whole-number currency says so; a pipeline without stages takes no row.
    expect(
      planDealRows([row({ 3: '10.5' })], mapping, international, { ...lookups, currency: 'JPY' })
        .messages[0]?.message,
    ).toBe('Value must be an amount in JPY as a whole number.');
    expect(
      planDealRows([row({})], mapping, international, { ...lookups, stages: [] }).messages[0]
        ?.message,
    ).toBe('The pipeline has no active stage.');
  });

  it('takes one of a choice field’s options whatever its case, stored as the option is written (ADR-385)', () => {
    const withTier: DealImportLookups = {
      ...lookups,
      fields: [
        ...lookups.fields,
        {
          id: 'f3',
          key: 'tier',
          label: 'Tier',
          type: 'choice',
          options: ['Gold', '=Silver'],
          createdAt: at,
        },
      ],
    };
    const tierMapping = { ...mapping, fields: { ...mapping.fields, tier: 8 } };
    const row = (tier: string) => ['+919876543210', 'Plan', '', '', '', '', '', '', tier];
    const { deals, messages } = planDealRows(
      [row(' gOLD '), row("'=silver"), row(''), row('Platinum')],
      tierMapping,
      international,
      withTier,
    );
    expect(deals.map((d) => [d.line, d.attributes])).toEqual([
      [2, { tier: 'Gold' }],
      [3, { tier: '=Silver' }],
      [4, {}],
    ]);
    expect(messages.map((m) => [m.row, m.message])).toEqual([
      [5, 'Tier must be one of its options.'],
    ]);
  });

  it('reads cells as exported: formula guards removed, and finds each valid number once', () => {
    const { deals } = planDealRows(
      [['+919876543210', "'=Plan", '', '', '', '', '', '']],
      mapping,
      international,
      lookups,
    );
    expect(deals[0]?.title).toBe('=Plan');
    expect(
      importedPhones(
        [['+919876543210'], ['919876543210'], ['nope'], ['+919812345678']],
        mapping,
        international,
      ).sort(),
    ).toEqual(['+919812345678', '+919876543210']);
  });
});
