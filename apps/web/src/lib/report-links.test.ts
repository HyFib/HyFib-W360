import { describe, expect, it } from 'vitest';
import { reportExportHref, reportHref, reportPeriodParams } from './report-links';

const week = { preset: 'last_7_days' as const, from: '2026-10-10', to: '2026-10-16' };
const custom = { preset: 'custom' as const, from: '2026-09-01', to: '2026-09-30' };

describe('Reports links with the deals section’s filter (ADR-396)', () => {
  it('carry a preset alone, and custom days with their dates', () => {
    expect(reportPeriodParams(week)).toEqual({ preset: 'last_7_days' });
    expect(reportPeriodParams(custom)).toEqual({
      preset: 'custom',
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });

  it('keep the filter on the page, encoded, and drop it for “Show all deals”', () => {
    expect(reportHref('acme', week, 'tier:Gold')).toBe(
      '/c/acme/reports?preset=last_7_days&field=tier%3AGold',
    );
    expect(reportHref('acme', custom, 'tier:')).toBe(
      '/c/acme/reports?preset=custom&from=2026-09-01&to=2026-09-30&field=tier%3A',
    );
    // An option is the company's own text: written as one parameter, whatever it holds.
    const href = reportHref('acme', week, 'tier:Silver & Gold: plus #1');
    expect(new URL(href, 'https://app.example.test').searchParams.get('field')).toBe(
      'tier:Silver & Gold: plus #1',
    );
    expect(reportHref('acme', week, null)).toBe('/c/acme/reports?preset=last_7_days');
    expect(reportHref('acme', custom, null)).toBe(
      '/c/acme/reports?preset=custom&from=2026-09-01&to=2026-09-30',
    );
  });

  it('export each section for the exact days shown, the deals section with its filter only', () => {
    expect(reportExportHref('acme', 'deals', week, 'signed:yes')).toBe(
      '/c/acme/reports/export/deals?preset=custom&from=2026-10-10&to=2026-10-16&field=signed%3Ayes',
    );
    expect(reportExportHref('acme', 'deals', week, null)).toBe(
      '/c/acme/reports/export/deals?preset=custom&from=2026-10-10&to=2026-10-16',
    );
    for (const section of ['messaging', 'costs', 'inbox', 'csat', 'automations', 'agents']) {
      expect(reportExportHref('acme', section, custom, 'signed:yes')).toBe(
        `/c/acme/reports/export/${section}?preset=custom&from=2026-09-01&to=2026-09-30`,
      );
    }
  });
});
