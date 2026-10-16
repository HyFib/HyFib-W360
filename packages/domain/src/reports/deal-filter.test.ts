import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import {
  dealFieldFilterView,
  filterableDealFields,
  type FilterableFieldShape,
} from '../crm/deal-field-filter';
import {
  REPORT_DEAL_FILTER_FORBIDDEN_MESSAGE,
  REPORT_DEAL_FILTER_SECTION_MESSAGE,
  assertReportDealFilterAllowed,
  reportDealFilter,
  reportExportFilename,
} from './deal-filter';
import { REPORT_SECTIONS } from './service';

const fields: FilterableFieldShape[] = [
  { key: 'region', label: 'Region', type: 'text', options: null },
  { key: 'tier', label: 'Tier', type: 'choice', options: ['Gold', 'Silver'] },
  { key: 'signed', label: 'Signed', type: 'boolean', options: null },
];

/** The code, message and issues of a refusal, or null when nothing was refused. */
function refusal(run: () => void) {
  try {
    run();
  } catch (error) {
    if (!isAppError(error)) throw error;
    return [error.code, error.publicMessage, error.issues];
  }
  return null;
}

describe('the Reports page’s deal field filter (ADR-396)', () => {
  it('reads the address as the board does for members who may see the CRM', () => {
    for (const raw of [null, undefined, '', 'tier:gOLD', 'signed:', 'tier:Platinum', 'region:x']) {
      expect(reportDealFilter(fields, raw), String(raw)).toEqual({
        ...dealFieldFilterView(fields, raw),
        permitted: true,
      });
    }
    expect(reportDealFilter(fields, 'tier:gOLD')).toMatchObject({
      fields: filterableDealFields(fields),
      applied: { key: 'tier', stored: 'Gold', param: 'tier:Gold', valueLabel: 'Gold' },
      ignored: false,
      permitted: true,
    });
    expect(reportDealFilter(fields, 'tier:Platinum')).toMatchObject({
      applied: null,
      ignored: true,
    });
  });

  it('offers, reads and applies nothing for others, saying only that a filter was not applied', () => {
    // A filter of the company's own and one it does not have read alike: nothing is revealed.
    for (const raw of ['tier:Gold', 'signed:yes', 'tier:', 'plan:Gold', 'tier', ' ']) {
      expect(reportDealFilter(null, raw), raw).toEqual({
        fields: [],
        applied: null,
        ignored: true,
        permitted: false,
      });
    }
    for (const raw of [null, undefined, '']) {
      expect(reportDealFilter(null, raw), String(raw)).toEqual({
        fields: [],
        applied: null,
        ignored: false,
        permitted: false,
      });
    }
  });
});

describe('a section export’s deal field filter (ADR-396)', () => {
  it('is taken by the deals section, from those who may see the CRM', () => {
    expect(refusal(() => assertReportDealFilterAllowed('deals', true))).toBeNull();
  });

  it('is refused with any other section, naming field, whoever asks', () => {
    for (const section of REPORT_SECTIONS.filter((s) => s !== 'deals')) {
      for (const permitted of [true, false]) {
        expect(refusal(() => assertReportDealFilterAllowed(section, permitted))).toEqual([
          'validation_failed',
          REPORT_DEAL_FILTER_SECTION_MESSAGE,
          [{ path: 'field', message: REPORT_DEAL_FILTER_SECTION_MESSAGE }],
        ]);
      }
    }
  });

  it('is refused without the permission to see the CRM', () => {
    expect(refusal(() => assertReportDealFilterAllowed('deals', false))).toEqual([
      'forbidden',
      REPORT_DEAL_FILTER_FORBIDDEN_MESSAGE,
      undefined,
    ]);
    expect(REPORT_DEAL_FILTER_FORBIDDEN_MESSAGE).toBe(
      'Filtering deals by a deal field needs the permission to see the CRM.',
    );
  });

  it('names the field’s key in the file name, never the option', () => {
    const period = { from: '2026-10-01', to: '2026-10-07' };
    expect(reportExportFilename('deals', period, null)).toBe('deals-2026-10-01-to-2026-10-07.csv');
    expect(reportExportFilename('messaging', period, null)).toBe(
      'messaging-2026-10-01-to-2026-10-07.csv',
    );
    const gold = reportDealFilter(fields, 'tier:Gold').applied;
    const unset = reportDealFilter(fields, 'signed:').applied;
    expect(reportExportFilename('deals', period, gold)).toBe(
      'deals-filtered-by-tier-2026-10-01-to-2026-10-07.csv',
    );
    expect(reportExportFilename('deals', period, unset)).toBe(
      'deals-filtered-by-signed-2026-10-01-to-2026-10-07.csv',
    );
    expect(reportExportFilename('deals', period, gold)).not.toContain('Gold');
  });
});
