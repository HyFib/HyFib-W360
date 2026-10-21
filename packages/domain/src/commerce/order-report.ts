import { ORDER_STATUSES, sql, type OrderStatus, type SQL, type Tx } from '@w360/db';
import { currencyDigits } from '../crm/money';
import type { ReportPeriod } from '../reports/period';

/**
 * WhatsApp order reports (ADR-409): the orders received in a period of whole days in the company's
 * time zone, per day and status, their subtotals per currency, and the items by product. Amounts
 * are summed in SQL as numeric over the bigint minor units and carried as `bigint` here, so no
 * total ever passes through a float. Totals carry no customer data. The caller passes the order
 * list's visibility (the inbox's, ADR-235) and runs the queries in one repeatable-read, read-only
 * transaction, as Reports do (ADR-026); both are bounded by the period on the
 * `(tenant_id, received_at)` order index and reach items through `(tenant_id, order_id, position)`.
 */

/** Products a report lists, most ordered first; the rest are counted, not listed. */
export const ORDER_REPORT_PRODUCT_LIMIT = 200;

export interface CurrencyTotal {
  currency: string;
  /** Orders (or, for products, order lines) the sum counts. */
  count: number;
  minor: bigint;
}

export interface OrderReportCounts {
  orders: number;
  byStatus: Record<OrderStatus, number>;
  /** The subtotals HyFib knows, per currency, sorted by currency. */
  subtotals: CurrencyTotal[];
  /** Orders without a subtotal: an item or price HyFib could not read, or items in several currencies. */
  withoutSubtotal: number;
  /** Cart items HyFib could not read (or kept beyond its limit), counted apart from the products. */
  unreadableItems: number;
  ordersWithUnreadableItems: number;
}

export interface OrderReportDay extends OrderReportCounts {
  day: string;
}

export interface OrderReportStatus {
  status: OrderStatus;
  orders: number;
  subtotals: CurrencyTotal[];
  withoutSubtotal: number;
}

export interface OrderReportProduct {
  retailerId: string;
  /** The name the catalog gave on the latest order that had one; null when HyFib never knew it. */
  name: string | null;
  quantity: number;
  orders: number;
  /** Quantity × unit price where the price was read, per currency. */
  subtotals: CurrencyTotal[];
  /** Quantity on lines whose price HyFib could not read (not in any subtotal). */
  unpricedQuantity: number;
}

export interface OrderReport {
  period: ReportPeriod;
  generatedAt: Date;
  totals: OrderReportCounts;
  days: OrderReportDay[];
  statuses: OrderReportStatus[];
  products: OrderReportProduct[];
  /** Distinct products ordered in the period, listed or not. */
  productCount: number;
}

/** One row of the orders query: the period's orders grouped by day, status and currency. */
export interface OrderGroupRow {
  day: string;
  status: string;
  /** Null when the order's items disagree on currency. */
  currency: string | null;
  orders: number;
  /** Orders of the group whose subtotal is known. */
  withSubtotal: number;
  /** Sum of the known subtotals, in minor units, as the database's exact text. */
  subtotal: string;
  unreadableItems: number;
  withUnreadable: number;
}

const emptyByStatus = (): Record<OrderStatus, number> =>
  Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0])) as Record<OrderStatus, number>;

const emptyCounts = (): OrderReportCounts => ({
  orders: 0,
  byStatus: emptyByStatus(),
  subtotals: [],
  withoutSubtotal: 0,
  unreadableItems: 0,
  ordersWithUnreadableItems: 0,
});

/** An exact integer from the database's text; refuses anything else rather than rounding. */
export function exactMinor(text: string): bigint {
  if (!/^\d+$/.test(text)) throw new Error(`Not a non-negative whole amount: ${text}`);
  return BigInt(text);
}

/** Adds `count` and `minor` to the currency's line of `totals`, keeping it sorted by currency. */
export function addCurrencyTotal(
  totals: CurrencyTotal[],
  currency: string,
  count: number,
  minor: bigint,
): void {
  const line = totals.find((t) => t.currency === currency);
  if (line) {
    line.count += count;
    line.minor += minor;
    return;
  }
  totals.push({ currency, count, minor });
  totals.sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
}

/**
 * Adds the group's known subtotals to `totals`. The database keeps a subtotal only with a currency
 * (`commerce_orders_total`), so a subtotal without one is a bug and throws rather than being summed
 * under no currency.
 */
function addKnownSubtotal(totals: CurrencyTotal[], row: OrderGroupRow): void {
  if (row.withSubtotal === 0) return;
  if (row.currency === null) throw new Error('An order subtotal without a currency');
  addCurrencyTotal(totals, row.currency, row.withSubtotal, exactMinor(row.subtotal));
}

function addGroup(counts: OrderReportCounts, row: OrderGroupRow, status: OrderStatus): void {
  counts.orders += row.orders;
  counts.byStatus[status] += row.orders;
  addKnownSubtotal(counts.subtotals, row);
  counts.withoutSubtotal += row.orders - row.withSubtotal;
  counts.unreadableItems += row.unreadableItems;
  counts.ordersWithUnreadableItems += row.withUnreadable;
}

function isOrderStatus(status: string): status is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(status);
}

/**
 * Folds the orders query's rows into every day of the period (days without orders included), the
 * period's totals and the totals by status. A row for a day outside the period, an unknown status
 * or a subtotal without a currency is a bug, so it throws instead of being dropped.
 */
export function summariseOrderGroups(
  rows: OrderGroupRow[],
  days: string[],
): { totals: OrderReportCounts; days: OrderReportDay[]; statuses: OrderReportStatus[] } {
  const byDay = new Map(days.map((day) => [day, { day, ...emptyCounts() }]));
  const totals = emptyCounts();
  const statuses = new Map<OrderStatus, OrderReportStatus>(
    ORDER_STATUSES.map((status) => [
      status,
      { status, orders: 0, subtotals: [], withoutSubtotal: 0 },
    ]),
  );
  for (const row of rows) {
    const day = byDay.get(row.day);
    if (!day) throw new Error(`Order group outside the report's period: ${row.day}`);
    if (!isOrderStatus(row.status)) throw new Error(`Unknown order status: ${row.status}`);
    addGroup(day, row, row.status);
    addGroup(totals, row, row.status);
    const status = statuses.get(row.status) as OrderReportStatus;
    status.orders += row.orders;
    status.withoutSubtotal += row.orders - row.withSubtotal;
    addKnownSubtotal(status.subtotals, row);
  }
  return { totals, days: [...byDay.values()], statuses: [...statuses.values()] };
}

/** Minor units as exact text in the currency's major unit ("2500.50"; "120" for JPY). */
export function minorToMajorText(minor: bigint, currency: string): string {
  if (minor < 0n) throw new Error('Order totals are never negative');
  const digits = currencyDigits(currency);
  if (digits === 0) return minor.toString();
  const text = minor.toString().padStart(digits + 1, '0');
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/**
 * Formats a total for display ("₹2,500.50"), exactly: Intl formats the decimal text itself, so a
 * sum beyond 2^53 minor units keeps every digit.
 */
export function formatOrderTotal(minor: bigint, currency: string, locale = 'en-IN'): string {
  const digits = currencyDigits(currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(minorToMajorText(minor, currency) as Intl.StringNumericLiteral);
}

const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/**
 * Reads the report's numbers for `period`. `visibility` is the order list's condition over
 * `app.conversations` (undefined for members who see every conversation); the query joins that
 * table unaliased so the condition's column names resolve.
 */
export async function readOrderReport(
  tx: Tx,
  tenantId: string,
  period: ReportPeriod,
  visibility: SQL | undefined,
  now: Date,
): Promise<OrderReport> {
  const visible = visibility === undefined ? sql`` : sql`and ${visibility}`;
  const inPeriod = sql`o.tenant_id = ${tenantId}
      and o.received_at >= ${ts(period.start)} and o.received_at < ${ts(period.end)}`;
  const fromVisibleOrders = sql`from app.commerce_orders o
      join app.conversations
        on app.conversations.tenant_id = o.tenant_id and app.conversations.id = o.conversation_id
     where ${inPeriod} ${visible}`;

  const groups = await tx.execute<{
    day: string;
    status: string;
    currency: string | null;
    orders: number;
    with_subtotal: number;
    subtotal: string;
    unreadable_items: string;
    with_unreadable: number;
  }>(sql`
    select to_char(o.received_at at time zone ${period.timezone}, 'YYYY-MM-DD') as day,
           o.status, o.currency, count(*)::int as orders,
           count(o.subtotal_minor)::int as with_subtotal,
           coalesce(sum(o.subtotal_minor), 0)::text as subtotal,
           coalesce(sum(o.dropped_items), 0)::text as unreadable_items,
           (count(*) filter (where o.dropped_items > 0))::int as with_unreadable
    ${fromVisibleOrders}
    group by 1, 2, 3`);
  const summary = summariseOrderGroups(
    groups.rows.map((r) => ({
      day: r.day,
      status: r.status,
      currency: r.currency,
      orders: Number(r.orders),
      withSubtotal: Number(r.with_subtotal),
      subtotal: r.subtotal,
      unreadableItems: Number(r.unreadable_items),
      withUnreadable: Number(r.with_unreadable),
    })),
    period.days,
  );

  const products = await tx.execute<{
    retailer_id: string;
    name: string | null;
    quantity: string;
    orders: number;
    unpriced_quantity: string;
    product_count: number;
  }>(sql`
    select i.retailer_id,
           (array_agg(i.name order by o.received_at desc, o.id desc)
              filter (where i.name is not null))[1] as name,
           sum(i.quantity)::text as quantity,
           count(distinct o.id)::int as orders,
           coalesce(sum(i.quantity) filter (where i.unit_price_minor is null), 0)::text
             as unpriced_quantity,
           (count(*) over ())::int as product_count
      from app.commerce_order_items i
      join app.commerce_orders o on o.tenant_id = i.tenant_id and o.id = i.order_id
      join app.conversations
        on app.conversations.tenant_id = o.tenant_id and app.conversations.id = o.conversation_id
     where i.tenant_id = ${tenantId} and ${inPeriod} ${visible}
     group by i.retailer_id
     order by sum(i.quantity) desc, i.retailer_id
     limit ${ORDER_REPORT_PRODUCT_LIMIT}`);
  const listed = products.rows.map((r) => r.retailer_id);
  const priced = listed.length
    ? await tx.execute<{ retailer_id: string; currency: string; lines: number; subtotal: string }>(
        sql`
    select i.retailer_id, i.currency, count(*)::int as lines,
           sum(i.quantity::numeric * i.unit_price_minor)::text as subtotal
      from app.commerce_order_items i
      join app.commerce_orders o on o.tenant_id = i.tenant_id and o.id = i.order_id
      join app.conversations
        on app.conversations.tenant_id = o.tenant_id and app.conversations.id = o.conversation_id
     where i.tenant_id = ${tenantId} and ${inPeriod} ${visible}
       and i.unit_price_minor is not null and i.currency is not null
       and i.retailer_id = any(${sql.param(listed)}::text[])
     group by 1, 2`,
      )
    : { rows: [] };
  const subtotals = new Map<string, CurrencyTotal[]>();
  for (const r of priced.rows) {
    const lines = subtotals.get(r.retailer_id) ?? [];
    addCurrencyTotal(lines, r.currency, Number(r.lines), exactMinor(r.subtotal));
    subtotals.set(r.retailer_id, lines);
  }
  return {
    period,
    generatedAt: now,
    ...summary,
    products: products.rows.map((r) => ({
      retailerId: r.retailer_id,
      name: r.name,
      quantity: Number(r.quantity),
      orders: Number(r.orders),
      subtotals: subtotals.get(r.retailer_id) ?? [],
      unpricedQuantity: Number(r.unpriced_quantity),
    })),
    productCount: Number(products.rows[0]?.product_count ?? 0),
  };
}
