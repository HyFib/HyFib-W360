import { describe, expect, it } from 'vitest';
import { DEAL_CSV_COLUMNS, dealCsvLine, type DealCsvRow } from './deals-csv';
import { DEAL_EXPORT_BATCH, dealExportSchema } from './deals';

const row: DealCsvRow = {
  id: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01',
  title: 'Annual plan',
  pipelineName: 'Sales',
  stageName: 'Proposal',
  status: 'lost',
  currency: 'INR',
  valueMinor: 2_500_050,
  ownerName: 'Meera Iyer',
  contactName: 'Asha Rao',
  contactPhone: '+919876543210',
  contactErased: false,
  expectedCloseOn: '2026-11-30',
  createdAt: new Date('2026-10-01T09:30:00Z'),
  stageEnteredAt: new Date('2026-10-02T10:00:00Z'),
  closedAt: new Date('2026-10-05T12:15:00Z'),
  lostReason: 'Chose a cheaper plan',
  openTasks: 2,
};
const cells = (line: string) => line.replace(/\r\n$/, '').split(',');

describe('deals as CSV (ADR-239)', () => {
  it('writes one line per deal in the order of the columns, values exact', () => {
    const line = dealCsvLine(row);
    expect(line.endsWith('\r\n')).toBe(true);
    expect(cells(line)).toEqual([
      row.id,
      'Annual plan',
      'Sales',
      'Proposal',
      'lost',
      'INR',
      '25000.50',
      'Meera Iyer',
      'Asha Rao',
      '+919876543210',
      '2026-11-30',
      '2026-10-01T09:30:00.000Z',
      '2026-10-02T10:00:00.000Z',
      '2026-10-05T12:15:00.000Z',
      'Chose a cheaper plan',
      '2',
    ]);
    expect(DEAL_CSV_COLUMNS).toHaveLength(cells(line).length);
    // An open deal without a value, an owner, a close date or a reason leaves them empty; a
    // currency without minor units is written whole.
    expect(
      cells(
        dealCsvLine({
          ...row,
          status: 'open',
          valueMinor: null,
          ownerName: null,
          expectedCloseOn: null,
          closedAt: null,
          lostReason: null,
          openTasks: 0,
        }),
      ),
    ).toEqual([
      row.id,
      'Annual plan',
      'Sales',
      'Proposal',
      'open',
      'INR',
      '',
      '',
      'Asha Rao',
      '+919876543210',
      '',
      '2026-10-01T09:30:00.000Z',
      '2026-10-02T10:00:00.000Z',
      '',
      '',
      '0',
    ]);
    expect(cells(dealCsvLine({ ...row, currency: 'JPY', valueMinor: 1500 }))[6]).toBe('1500');
  });

  it('never writes an erased contact’s name or number', () => {
    const erased = cells(dealCsvLine({ ...row, contactErased: true }));
    expect([erased[8], erased[9]]).toEqual(['Erased contact', '']);
  });

  it('neutralises formulas and quotes what a CSV needs quoted', () => {
    const line = dealCsvLine({
      ...row,
      title: '=HYPERLINK("http://x")',
      lostReason: '+cmd',
      contactName: 'Rao, Asha',
    });
    expect(line).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(line).toContain(`'+cmd`);
    expect(line).toContain('"Rao, Asha"');
  });

  it('takes a status, a pipeline and an owner, each optional', () => {
    expect(DEAL_EXPORT_BATCH).toBe(500);
    expect(dealExportSchema.parse({})).toEqual({ owner: 'all' });
    const pipelineId = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
    expect(dealExportSchema.parse({ status: 'won', pipelineId, owner: 'mine' })).toEqual({
      status: 'won',
      pipelineId,
      owner: 'mine',
    });
    for (const wrong of [
      { status: 'closed' },
      { pipelineId: 'sales' },
      { owner: 'everyone' },
      { status: null },
    ]) {
      expect(dealExportSchema.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    }
  });
});
