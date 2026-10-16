import { csvLine } from '../contacts/csv';
import { minorToInput } from './money';

/**
 * Deals as CSV (ADR-239): one line per deal, formula-safe (`csvLine`), times in UTC (ISO 8601),
 * values exact in the pipeline currency's major unit. A contact that was erased is named as such,
 * without a number. The products on a deal (ADR-375) are one cell, a line each, with their total
 * (ADR-380). Custom deal fields (ADR-373) follow the fixed columns, one per field, headed by its key.
 */
export const DEAL_CSV_COLUMNS = [
  'deal_id',
  'title',
  'pipeline',
  'stage',
  'status',
  'currency',
  'value',
  'owner',
  'contact_name',
  'contact_phone',
  'expected_close_on',
  'created_at',
  'stage_entered_at',
  'closed_at',
  'lost_reason',
  'open_tasks',
  'products',
  'products_total',
] as const;

/** One product on a deal, as the CSV writes it. */
export interface DealCsvItem {
  name: string;
  quantity: number;
  unitPriceMinor: number;
  currency: string;
}

export interface DealCsvRow {
  id: string;
  title: string;
  pipelineName: string;
  stageName: string;
  status: string;
  currency: string;
  valueMinor: number | null;
  ownerName: string | null;
  contactName: string | null;
  /** The number as the member may see it (ADR-226). */
  contactPhone: string | null;
  contactErased: boolean;
  expectedCloseOn: string | null;
  createdAt: Date;
  stageEnteredAt: Date;
  closedAt: Date | null;
  lostReason: string | null;
  openTasks: number;
  /** The products on it (ADR-375), in the order they were added; none when omitted. */
  items?: readonly DealCsvItem[];
  /**
   * The products' total in the deal's currency (`dealItemsTotal`), or null: no products, one in
   * another currency, or more than a deal can be worth.
   */
  itemsTotalMinor?: number | null;
  /** Its custom field values (ADR-373), one cell per field in the header's order; empty without. */
  fieldValues?: readonly string[];
}

/** A deal's products as one cell: a line each, such as "3 × Blue mug at 1500.50 INR". */
export function dealItemsCell(items: readonly DealCsvItem[]): string {
  return items
    .map(
      (item) =>
        `${item.quantity} × ${item.name} at ${minorToInput(item.unitPriceMinor, item.currency)} ${item.currency}`,
    )
    .join('\n');
}

/** One deal's CSV line. */
export function dealCsvLine(row: DealCsvRow): string {
  return csvLine([
    row.id,
    row.title,
    row.pipelineName,
    row.stageName,
    row.status,
    row.currency,
    row.valueMinor !== null ? minorToInput(row.valueMinor, row.currency) : '',
    row.ownerName,
    row.contactErased ? 'Erased contact' : row.contactName,
    row.contactErased ? '' : row.contactPhone,
    row.expectedCloseOn,
    row.createdAt.toISOString(),
    row.stageEnteredAt.toISOString(),
    row.closedAt?.toISOString() ?? '',
    row.lostReason,
    row.openTasks,
    dealItemsCell(row.items ?? []),
    row.itemsTotalMinor === null || row.itemsTotalMinor === undefined
      ? ''
      : minorToInput(row.itemsTotalMinor, row.currency),
    ...(row.fieldValues ?? []),
  ]);
}
