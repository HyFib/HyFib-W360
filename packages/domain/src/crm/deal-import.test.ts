import { describe, expect, it } from 'vitest';
import { parseCsv } from '../contacts/csv';
import {
  DEAL_IMPORT_LIMITS,
  dealImportCounts,
  dealImportSchema,
  importedDealIds,
  importedPhones,
  phoneMode,
  planDealRows,
  updateActivities,
  type DealImportLookups,
  type ExistingDeal,
} from './deal-import';
import { DEAL_CSV_COLUMNS, dealCsvLine } from './deals-csv';

const at = new Date('2026-10-13T09:00:00Z');
const lookups: DealImportLookups = {
  pipelineId: 'pipeline-sales',
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
  ownersByName: new Map([['meera iyer', 'member-meera']]),
  memberAliases: new Map([['member-meera', ['meera@example.test', 'meera iyer']]]),
  deals: new Map(),
  expectedVersions: null,
  fields: [
    { id: 'f1', key: 'seats', label: 'Seats', type: 'number', options: null, createdAt: at },
    { id: 'f2', key: 'signed', label: 'Signed', type: 'boolean', options: null, createdAt: at },
  ],
};
// phone, title, stage, value, owner, close, seats, signed
const mapping = {
  dealId: null,
  phone: 0,
  title: 1,
  stage: 2,
  value: 3,
  currency: null,
  owner: 4,
  expectedCloseOn: 5,
  status: null,
  lostReason: null,
  fields: { seats: 6, signed: 7 },
};
const international = phoneMode({ phoneFormat: 'international' });

describe('deal import (ADR-374)', () => {
  it('takes a pipeline, a phone format and columns for a phone number and a title at least', () => {
    expect(DEAL_IMPORT_LIMITS.maxRows).toBe(1000);
    // Room in a 1 MB server action body for the checked versions sent with the file (ADR-387).
    expect(DEAL_IMPORT_LIMITS.maxBytes).toBe(928_000);
    const parsed = dealImportSchema.parse({
      fileName: 'deals.csv',
      pipelineId: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01',
      phoneFormat: 'international',
      mapping: { phone: 0, title: 1 },
    });
    expect(parsed.mapping).toEqual({
      dealId: null,
      phone: 0,
      title: 1,
      stage: null,
      value: null,
      currency: null,
      owner: null,
      expectedCloseOn: null,
      status: null,
      lostReason: null,
      fields: {},
    });
    expect(parsed.expectedVersions).toEqual({});
    // A file that only changes deals needs their ids, and no phone number or title (ADR-387).
    expect(dealImportSchema.safeParse({ ...parsed, mapping: { dealId: 0 } }).success).toBe(true);
    for (const bad of [
      { mapping: { phone: 0 } },
      { mapping: { title: 1 } },
      { mapping: { dealId: -1 } },
      { mapping: { dealId: 0, status: 1.5 } },
      { expectedVersions: { 'not-a-deal': 1 } },
      { expectedVersions: { '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01': 0 } },
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
        close: null,
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
        close: null,
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
      [9, 'error', 'Owner must be the email or the name of an active member who can use the CRM.'],
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

const DEAL_A = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f0a';
const DEAL_B = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f0b';
const DEAL_C = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f0c';
const DEAL_D = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f0d';
const DEAL_E = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f0e';
const existing = (over: Partial<ExistingDeal> = {}): ExistingDeal => ({
  id: DEAL_A,
  pipelineId: 'pipeline-sales',
  stageId: 'stage-new',
  contactId: 'contact-asha',
  status: 'open',
  title: 'Annual plan',
  valueMinor: 2_500_050,
  ownerMembershipId: 'member-meera',
  expectedCloseOn: '2026-11-30',
  attributes: { seats: 12, signed: true },
  version: 3,
  contactErased: false,
  ...over,
});
const withDeals: DealImportLookups = {
  ...lookups,
  ownersByEmail: new Map([
    ['meera@example.test', 'member-meera'],
    ['dev@example.test', 'member-dev'],
  ]),
  ownersByName: new Map([
    ['meera iyer', 'member-meera'],
    ['dev patel', 'member-dev'],
    ['sam', null],
  ]),
  memberAliases: new Map([
    ['member-meera', ['meera@example.test', 'meera iyer']],
    ['member-dev', ['dev@example.test', 'dev patel']],
  ]),
  deals: new Map([
    [DEAL_A, existing()],
    [DEAL_C, existing({ id: DEAL_C, status: 'won' })],
    [DEAL_D, existing({ id: DEAL_D, pipelineId: 'pipeline-other' })],
    [DEAL_E, existing({ id: DEAL_E, contactErased: true })],
  ]),
};
// The columns of the deals export (ADR-239) with two custom fields, as it writes them.
const exportMapping = {
  dealId: 0,
  phone: 9,
  title: 1,
  stage: 3,
  value: 6,
  currency: 5,
  owner: 7,
  expectedCloseOn: 10,
  status: 4,
  lostReason: 14,
  fields: { seats: 18, signed: 19 },
};
const exported = parseCsv(
  [
    [...DEAL_CSV_COLUMNS, 'seats', 'signed'].join(',') + '\r\n',
    dealCsvLine({
      id: DEAL_A,
      title: 'Annual plan',
      pipelineName: 'Sales',
      stageName: 'New',
      status: 'open',
      currency: 'INR',
      valueMinor: 2_500_050,
      ownerName: 'Meera Iyer',
      contactName: 'Asha Rao',
      contactPhone: '+91 ••••• •3210',
      contactErased: false,
      expectedCloseOn: '2026-11-30',
      createdAt: at,
      stageEnteredAt: at,
      closedAt: null,
      lostReason: null,
      openTasks: 1,
      items: [{ name: 'Blue mug', quantity: 3, unitPriceMinor: 150_050, currency: 'INR' }],
      itemsTotalMinor: 450_150,
      fieldValues: ['12', 'true'],
    }),
  ].join(''),
  DEAL_IMPORT_LIMITS,
);
const exportedRow = exported.rows[0]!;
const edit = (cells: Record<number, string>) => exportedRow.map((v, i) => cells[i] ?? v);
const idOnly = (id: string, cells: Record<number, string> = {}) =>
  Array.from({ length: 20 }, (_, i) => cells[i] ?? (i === 0 ? id : ''));

describe('deal import that changes and closes deals (ADR-387)', () => {
  it('reads a deals export back unchanged: products ignored, value in major units, owner by name', () => {
    expect(exported.headers).toEqual([...DEAL_CSV_COLUMNS, 'seats', 'signed']);
    expect(exportedRow[16]).toBe('3 × Blue mug at 1500.50 INR');
    const plan = planDealRows([exportedRow], exportMapping, international, withDeals);
    expect(plan.messages).toEqual([]);
    expect(plan.deals).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.rows).toEqual([
      {
        row: 2,
        action: 'unchanged',
        close: null,
        dealId: DEAL_A,
        title: 'Annual plan',
        message: null,
      },
    ]);
    expect(plan.versions).toEqual({ [DEAL_A]: 3 });
    // Blank cells leave every value as it is.
    expect(planDealRows([idOnly(DEAL_A)], exportMapping, international, withDeals).rows).toEqual(
      plan.rows,
    );
    // A deal whose owner has left keeps them: the export names them, and that is no change.
    const formerOwner: DealImportLookups = {
      ...withDeals,
      memberAliases: new Map([
        ...withDeals.memberAliases,
        ['member-left', ['lena@example.test', 'lena old']],
      ]),
      deals: new Map([[DEAL_A, existing({ ownerMembershipId: 'member-left' })]]),
    };
    expect(
      planDealRows([edit({ 7: 'Lena Old' })], exportMapping, international, formerOwner).rows[0]
        ?.action,
    ).toBe('unchanged');
    expect(
      planDealRows([edit({ 7: 'lena@example.test' })], exportMapping, international, withDeals)
        .messages[0]?.message,
    ).toBe('Owner must be the email or the name of an active member who can use the CRM.');
  });

  it('changes the cells given, moves within the pipeline and closes, with the page’s entries', () => {
    const plan = planDealRows(
      [
        edit({
          1: 'Annual plan v2',
          3: 'proposal sent',
          4: 'Won',
          6: '30,000',
          7: 'Dev Patel',
          10: '2026-12-31',
          18: '',
          19: 'no',
        }),
      ],
      exportMapping,
      international,
      withDeals,
    );
    expect(plan.messages).toEqual([]);
    expect(plan.updates).toEqual([
      {
        line: 2,
        deal: existing(),
        stageId: 'stage-won',
        title: 'Annual plan v2',
        valueMinor: 3_000_000,
        ownerMembershipId: 'member-dev',
        expectedCloseOn: '2026-12-31',
        // A blank cell keeps the value; the others replace theirs.
        attributes: { seats: 12, signed: false },
        fields: ['title', 'value', 'expected_close_on', 'custom_fields'],
        close: { outcome: 'won', lostReason: null },
      },
    ]);
    expect(plan.rows).toEqual([
      {
        row: 2,
        action: 'update',
        close: 'won',
        dealId: DEAL_A,
        title: 'Annual plan v2',
        message: null,
      },
    ]);
    expect(updateActivities(plan.updates[0]!)).toEqual([
      {
        kind: 'stage_changed',
        data: { fromStageId: 'stage-new', toStageId: 'stage-won', imported: true },
      },
      {
        kind: 'deal_updated',
        data: {
          fields: ['title', 'value', 'expected_close_on', 'custom_fields'],
          valueFrom: 2_500_050,
          valueTo: 3_000_000,
          imported: true,
        },
      },
      {
        kind: 'owner_changed',
        data: { from: 'member-meera', to: 'member-dev', imported: true },
      },
      { kind: 'deal_won', data: { valueMinor: 3_000_000, imported: true } },
    ]);
    // One change alone writes its entry alone; a lost deal keeps its reason, its entry none.
    const lost = planDealRows(
      [idOnly(DEAL_A.toUpperCase(), { 4: 'lost', 14: 'Chose a cheaper plan' })],
      exportMapping,
      international,
      withDeals,
    ).updates[0]!;
    expect([lost.fields, lost.stageId, lost.close]).toEqual([
      [],
      'stage-new',
      { outcome: 'lost', lostReason: 'Chose a cheaper plan' },
    ]);
    expect(updateActivities(lost)).toEqual([{ kind: 'deal_lost', data: { imported: true } }]);
    const owner = planDealRows(
      [idOnly(DEAL_A, { 7: 'DEV@example.test' })],
      exportMapping,
      international,
      withDeals,
    ).updates[0]!;
    expect(updateActivities(owner)).toEqual([
      { kind: 'owner_changed', data: { from: 'member-meera', to: 'member-dev', imported: true } },
    ]);
    const moved = planDealRows(
      [idOnly(DEAL_A, { 3: 'Proposal sent' })],
      exportMapping,
      international,
      withDeals,
    ).updates[0]!;
    expect(updateActivities(moved).map((e) => e.kind)).toEqual(['stage_changed']);
    const retitled = planDealRows(
      [idOnly(DEAL_A, { 1: 'Renamed' })],
      exportMapping,
      international,
      withDeals,
    ).updates[0]!;
    expect(updateActivities(retitled)).toEqual([
      { kind: 'deal_updated', data: { fields: ['title'], imported: true } },
    ]);
  });

  it('skips each row naming a deal it may not change, naming its row and the problem', () => {
    const { updates, messages, rows } = planDealRows(
      [
        idOnly('nope'),
        idOnly(DEAL_B),
        idOnly(DEAL_C),
        idOnly(DEAL_D),
        idOnly(DEAL_E),
        idOnly(DEAL_A, { 3: 'Lost' }),
        idOnly(DEAL_A, { 5: 'usd' }),
        idOnly(DEAL_A, { 6: '1.234' }),
        idOnly(DEAL_A, { 7: 'nobody' }),
        idOnly(DEAL_A, { 4: 'pending' }),
        idOnly(DEAL_A, { 4: 'won', 14: 'Too dear' }),
        idOnly(DEAL_A, { 4: 'lost', 14: 'x'.repeat(201) }),
        idOnly(DEAL_A, { 1: 'x'.repeat(121) }),
        idOnly(DEAL_A, { 10: '2026-02-30' }),
        idOnly(DEAL_A, { 18: 'many' }),
        idOnly(DEAL_A.toUpperCase(), { 4: 'lost', 14: 'Too dear' }),
        idOnly(DEAL_A, { 1: 'Again' }),
      ],
      exportMapping,
      international,
      withDeals,
    );
    expect(messages.map((m) => [m.row, m.message])).toEqual([
      [2, 'Deal id must be the id of a deal, as the deals export writes it.'],
      [3, 'The company has no deal with this id.'],
      [4, 'This deal is won: reopen it on its page to change it.'],
      [5, 'This deal is in another pipeline: choose its pipeline to change it.'],
      [6, 'The contact was erased; this deal can no longer be edited.'],
      [7, 'The pipeline has no stage named “Lost”.'],
      [8, "The row's currency is USD; this pipeline uses INR."],
      [9, 'Value must be an amount in INR with at most 2 decimals.'],
      [10, 'Owner must be the email or the name of an active member who can use the CRM.'],
      [11, 'Status must be open, won or lost.'],
      [12, 'Only a lost deal takes a lost reason.'],
      [13, 'Lost reason is longer than 200 characters.'],
      [14, 'Title is longer than 120 characters.'],
      [15, 'Expected close date must be a date written as YYYY-MM-DD.'],
      [16, 'Seats must be a number.'],
      // A skipped row does not hold its deal; a planned one does.
      [18, 'Row 17 already changes this deal.'],
    ]);
    expect(updates.map((u) => [u.line, u.deal.id, u.close])).toEqual([
      [17, DEAL_A, { outcome: 'lost', lostReason: 'Too dear' }],
    ]);
    expect(rows.filter((r) => r.action === 'skip').map((r) => [r.dealId, r.title])).toEqual(
      Array.from({ length: 16 }, () => [null, null]),
    );
    expect(dealImportCounts(rows)).toEqual({
      created: 0,
      updated: 1,
      closed: 1,
      unchanged: 0,
      errorCount: 16,
    });
  });

  it('changes a deal only at the version the rows were checked against', () => {
    const plan = (expectedVersions: ReadonlyMap<string, number>) =>
      planDealRows([idOnly(DEAL_A, { 1: 'Renamed' })], exportMapping, international, {
        ...withDeals,
        expectedVersions,
      });
    expect(plan(new Map([[DEAL_A, 2]])).messages[0]?.message).toBe(
      'Someone changed this deal after the rows were checked. Check the rows again.',
    );
    expect(plan(new Map()).messages[0]?.message).toBe(
      'This deal was not among the rows checked. Check the rows again.',
    );
    expect(plan(new Map([[DEAL_A, 3]])).updates.map((u) => u.title)).toEqual(['Renamed']);
    // An unchanged row is checked too: the deal may have changed since.
    expect(
      planDealRows([idOnly(DEAL_A)], exportMapping, international, {
        ...withDeals,
        expectedVersions: new Map([[DEAL_A, 4]]),
      }).rows[0]?.action,
    ).toBe('skip');
  });

  it('adds deals closed as won or lost, with a reason for a lost one', () => {
    const closing = { ...mapping, status: 8, lostReason: 9 };
    const row = (phone: string, title: string, status: string, reason = '') => [
      phone,
      title,
      '',
      '5000',
      '',
      '',
      '',
      '',
      status,
      reason,
    ];
    const { deals, messages, rows } = planDealRows(
      [
        row('+919876543210', 'Won deal', 'WON'),
        row('+919812345678', 'Lost deal', 'lost', 'Too dear'),
        row('+919812345678', 'Open deal', 'open'),
        row('+919812345678', 'Odd deal', 'done'),
      ],
      closing,
      international,
      withDeals,
    );
    expect(deals.map((d) => [d.title, d.stageId, d.valueMinor, d.close])).toEqual([
      ['Won deal', 'stage-new', 500_000, { outcome: 'won', lostReason: null }],
      ['Lost deal', 'stage-new', 500_000, { outcome: 'lost', lostReason: 'Too dear' }],
      ['Open deal', 'stage-new', 500_000, null],
    ]);
    expect(messages.map((m) => [m.row, m.message])).toEqual([
      [5, 'Status must be open, won or lost.'],
    ]);
    expect(rows.map((r) => [r.action, r.close])).toEqual([
      ['create', 'won'],
      ['create', 'lost'],
      ['create', null],
      ['skip', null],
    ]);
    expect(dealImportCounts(rows)).toEqual({
      created: 3,
      updated: 0,
      closed: 2,
      unchanged: 0,
      errorCount: 1,
    });
  });

  it('finds owners by email or by a name one member has, and new deals by phone only', () => {
    const owner = (text: string) =>
      planDealRows(
        [['+919876543210', 'Plan', '', '', text, '', '', '']],
        mapping,
        international,
        withDeals,
      );
    expect(owner('dev patel').deals[0]?.ownerMembershipId).toBe('member-dev');
    expect(owner('Sam').messages[0]?.message).toBe(
      "More than one member is named “Sam”; give the owner's email.",
    );
    // A file of deal ids may add deals too, but only with a phone number column.
    expect(
      planDealRows([['', 'New one']], { ...exportMapping, phone: null }, international, withDeals)
        .messages[0]?.message,
    ).toBe('A new deal needs its contact’s phone number: choose the phone number column.');
    expect(
      importedDealIds([[DEAL_A.toUpperCase()], [DEAL_A], ['nope'], ['']], { dealId: 0 }),
    ).toEqual([DEAL_A]);
    expect(
      importedPhones(
        [
          [DEAL_A, '+919876543210'],
          ['', '+919812345678'],
        ],
        { dealId: 0, phone: 1 },
        international,
      ),
    ).toEqual(['+919812345678']);
    expect(importedPhones([['+919812345678']], { phone: null }, international)).toEqual([]);
  });
});
