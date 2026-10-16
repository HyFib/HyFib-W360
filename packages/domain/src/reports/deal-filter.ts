import { AppError, validationFailed } from '@w360/core';
import {
  dealFieldFilterView,
  type DealFieldFilterView,
  type FilterableFieldShape,
  type ResolvedDealFieldFilter,
} from '../crm/deal-field-filter';

/**
 * Filtering the deals section of Reports by one choice or yes/no deal field (ADR-396), with the
 * board's machinery (ADR-391, ADR-394): the same `field=<key>:<option>` text, parsed, resolved
 * against the company's own fields and turned into the same condition. Every figure of the deals
 * section follows it (closed deals per currency and per day, the win rate, the time to win, the
 * open deals by stage and the weighted forecast); no other section does. Pure, so it is
 * unit-tested alone.
 *
 * The page reads it leniently, as the board does: a filter that does not resolve is ignored and
 * reported. The section's export and `GET /reports` read it strictly, as the CRM export and
 * `GET /deals` do: refused, never ignored, so neither is wider than asked.
 *
 * Reports need only `reports.read`, but the filter's choices name the company's deal fields and
 * options, which only those who may see the CRM see (`crm.read`, as on the board): others are
 * offered no field, and a filter in their address is neither read nor applied.
 */

/** The deals section's filter as the Reports page offers it (ADR-396). */
export interface ReportDealFilter extends DealFieldFilterView {
  /**
   * Whether the viewer may filter the deals by a deal field (`crm.read`). Without it no field is
   * offered and none applied, and a filter asked for is reported as not applied (`ignored`)
   * whether or not it names one of the company's fields, so nothing about them is revealed.
   */
  permitted: boolean;
}

/**
 * The page's reading: the company's fields for a viewer who may filter (`null` for one who may not,
 * whose fields are never read), and the filter as the address writes it.
 */
export function reportDealFilter(
  fields: readonly FilterableFieldShape[] | null,
  raw: string | null | undefined,
): ReportDealFilter {
  // Without fields, any filter asked for is ignored and an absent or empty one asks for nothing,
  // exactly as the board reads it.
  if (fields === null) return { ...dealFieldFilterView([], raw), permitted: false };
  return { ...dealFieldFilterView(fields, raw), permitted: true };
}

/** Why an export may not take a deal field filter at all, before anything is read. */
export const REPORT_DEAL_FILTER_SECTION_MESSAGE =
  'Only the deals section can be filtered by a deal field.';
export const REPORT_DEAL_FILTER_FORBIDDEN_MESSAGE =
  'Filtering deals by a deal field needs the permission to see the CRM.';

/**
 * Refuses a deal field filter an export cannot take (ADR-396): one sent with another section,
 * which it would not change, or by a viewer who may not see the CRM. Refused rather than ignored,
 * so a file never looks filtered when it is not.
 */
export function assertReportDealFilterAllowed(section: string, permitted: boolean): void {
  if (section !== 'deals') {
    throw validationFailed(REPORT_DEAL_FILTER_SECTION_MESSAGE, [
      { path: 'field', message: REPORT_DEAL_FILTER_SECTION_MESSAGE },
    ]);
  }
  if (!permitted) throw new AppError('forbidden', REPORT_DEAL_FILTER_FORBIDDEN_MESSAGE);
}

/**
 * A section export's file name. A filtered deals file names the field's key (a key is
 * `^[a-z][a-z0-9_]{0,39}$`, held by the database), never the option, which is the company's own
 * text and does not belong in a header.
 */
export function reportExportFilename(
  section: string,
  period: { from: string; to: string },
  filter: ResolvedDealFieldFilter | null,
): string {
  const filtered = filter ? `-filtered-by-${filter.key}` : '';
  return `${section}${filtered}-${period.from}-to-${period.to}.csv`;
}
