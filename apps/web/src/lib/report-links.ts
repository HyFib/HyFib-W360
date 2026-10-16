import type { ReportPeriod } from '@w360/domain';

type Period = Pick<ReportPeriod, 'preset' | 'from' | 'to'>;

/** The address parameters of a report's period: its preset, and its days when they are custom. */
export function reportPeriodParams(period: Period): Record<string, string> {
  return period.preset === 'custom'
    ? { preset: 'custom', from: period.from, to: period.to }
    : { preset: period.preset };
}

/**
 * The Reports page for a period, with the deals section's filter by a choice or yes/no field
 * (ADR-396) when one is given: the filter as the page resolved it, never the address's own text.
 */
export function reportHref(slug: string, period: Period, field: string | null): string {
  const params = new URLSearchParams(reportPeriodParams(period));
  if (field) params.set('field', field);
  return `/c/${slug}/reports?${params.toString()}`;
}

/**
 * A section's CSV export: the period's exact days, so the file holds what the page shows even when
 * it is downloaded later, and for the deals section only the filter it follows (ADR-396); no other
 * section is filtered, and the export refuses a filter with one.
 */
export function reportExportHref(
  slug: string,
  section: string,
  period: Period,
  field: string | null,
): string {
  const params = new URLSearchParams({ preset: 'custom', from: period.from, to: period.to });
  if (section === 'deals' && field) params.set('field', field);
  return `/c/${slug}/reports/export/${section}?${params.toString()}`;
}
