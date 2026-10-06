import { csvLine } from '../contacts/csv';
import { minorToInput } from './money';

/**
 * Deals as CSV (ADR-239): one line per deal, formula-safe (`csvLine`), times in UTC (ISO 8601),
 * values exact in the pipeline currency's major unit. A contact that was erased is named as such,
 * without a number.
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
] as const;

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
  ]);
}
