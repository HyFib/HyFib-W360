import { csvLine } from '../contacts/csv';
import { minorToInput } from '../crm/money';

/**
 * WhatsApp orders as CSV (ADR-235): one line per order, formula-safe (`csvLine`), times in UTC
 * (ISO 8601), amounts exact in the currency's major unit. A contact that was erased is named as
 * such, with neither number nor note.
 */
export const ORDER_CSV_COLUMNS = [
  'order_id',
  'reference',
  'received_at',
  'status',
  'status_changed_at',
  'paid_at',
  'customer_name',
  'customer_phone',
  'items',
  'item_count',
  'unreadable_items',
  'currency',
  'subtotal',
  'customer_note',
] as const;

export interface OrderCsvRow {
  id: string;
  reference: string;
  receivedAt: Date;
  status: string;
  statusChangedAt: Date;
  paidAt: Date | null;
  contactName: string | null;
  contactPhone: string | null;
  contactErased: boolean;
  /** The items as "2 × Blue kurta; 1 × sku-9", in cart order. */
  items: string | null;
  itemCount: number;
  droppedItems: number;
  /** Null when the items disagree on currency. */
  currency: string | null;
  /** Null when a price could not be read or currencies differ. */
  subtotalMinor: number | null;
  customerNote: string | null;
}

/** One order's CSV line; `showNumber` gives the number as the member may see it (ADR-226). */
export function orderCsvLine(
  row: OrderCsvRow,
  showNumber: (phone: string | null) => string | null,
): string {
  return csvLine([
    row.id,
    row.reference,
    row.receivedAt.toISOString(),
    row.status,
    row.statusChangedAt.toISOString(),
    row.paidAt?.toISOString() ?? '',
    row.contactErased ? 'Erased contact' : row.contactName,
    row.contactErased ? '' : showNumber(row.contactPhone),
    row.items,
    row.itemCount,
    row.droppedItems,
    row.currency,
    row.subtotalMinor !== null && row.currency ? minorToInput(row.subtotalMinor, row.currency) : '',
    row.contactErased ? '' : row.customerNote,
  ]);
}
