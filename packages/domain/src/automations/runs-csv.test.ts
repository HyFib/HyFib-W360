import { describe, expect, it } from 'vitest';
import { RUN_CSV_COLUMNS, runCsvLine, type RunCsvRow } from './runs-csv';

const row: RunCsvRow = {
  id: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01',
  automationName: 'Order status',
  versionNumber: 3,
  mode: 'live',
  status: 'completed',
  endReason: 'finished',
  triggerType: 'keyword',
  startedAt: new Date('2026-10-01T09:30:00Z'),
  endedAt: new Date('2026-10-01T09:31:15Z'),
  steps: 4,
  messages: 2,
};
const cells = (line: string) => line.replace(/\r\n$/, '').split(',');

describe('automation runs as CSV (ADR-237)', () => {
  it('writes one line per run in the order of the columns', () => {
    const line = runCsvLine(row);
    expect(line.endsWith('\r\n')).toBe(true);
    expect(cells(line)).toEqual([
      row.id,
      'Order status',
      '3',
      'live',
      'completed',
      'finished',
      'keyword',
      '2026-10-01T09:30:00.000Z',
      '2026-10-01T09:31:15.000Z',
      '4',
      '2',
    ]);
    expect(RUN_CSV_COLUMNS).toHaveLength(cells(line).length);
    // A run still going has no end; a run without a version or reason leaves them empty.
    expect(
      cells(runCsvLine({ ...row, endedAt: null, endReason: null, versionNumber: null })),
    ).toEqual([
      row.id,
      'Order status',
      '',
      'live',
      'completed',
      '',
      'keyword',
      '2026-10-01T09:30:00.000Z',
      '',
      '4',
      '2',
    ]);
  });

  it('neutralises an automation name written as a formula', () => {
    expect(runCsvLine({ ...row, automationName: '=cmd|"/c calc"!A1' })).toContain(
      `"'=cmd|""/c calc""!A1"`,
    );
    expect(runCsvLine({ ...row, automationName: 'Orders, returns' })).toContain(
      '"Orders, returns"',
    );
  });
});
