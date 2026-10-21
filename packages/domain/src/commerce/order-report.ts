import { ORDER_STATUSES, sql, type OrderStatus, type SQL, type Tx } from '@w360/db';
import { currencyDigits } from '../crm/money';
import type { ReportPeriod } from '../reports/period';

/**
 * WhatsApp order reports (ADR-409): the orders received in a period of whole days in the company's
 * time zone, per day and status, their subtotals per currency, and the items by product. Amounts
 * are summed in SQL as numeric over the bigint minor units and carried as `bigint` here, so no
 * total ever passes through a float. Totals carry no customer data. The caller passes the order
 * list's visibility (the inbox's, ADR-235) and runs the two statements in one repeatable-read,
 * read-only transaction, as Reports do (ADR-026). Both select orders by the period on the order
 * list's `(tenant_id, received_at)` index; the products statement reads the period's visible items
 * once, by order id, and derives every product figure from that one set.
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
  /**
   * Groups the database dated outside the period's days, left out of every figure as Reports leave
   * them out. Only a disagreement between PostgreSQL's time zone data and the runtime's (ICU) can
   * produce one; the page logs them (RUNBOOKS §10H).
   */
  outsidePeriod: { day: string; orders: number }[];
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
 * period's totals and the totals by status. A row dated outside the period's days is left out of
 * every figure, as Reports leave such rows out, and returned in `outsidePeriod` so the caller can
 * log it. An unknown status or a subtotal without a currency is a bug, so it throws.
 */
export function summariseOrderGroups(
  rows: OrderGroupRow[],
  days: string[],
): {
  totals: OrderReportCounts;
  days: OrderReportDay[];
  statuses: OrderReportStatus[];
  outsidePeriod: { day: string; orders: number }[];
} {
  const byDay = new Map(days.map((day) => [day, { day, ...emptyCounts() }]));
  const totals = emptyCounts();
  const statuses = new Map<OrderStatus, OrderReportStatus>(
    ORDER_STATUSES.map((status) => [
      status,
      { status, orders: 0, subtotals: [], withoutSubtotal: 0 },
    ]),
  );
  const outside = new Map<string, number>();
  for (const row of rows) {
    if (!isOrderStatus(row.status)) throw new Error(`Unknown order status: ${row.status}`);
    const day = byDay.get(row.day);
    if (!day) {
      outside.set(row.day, (outside.get(row.day) ?? 0) + row.orders);
      continue;
    }
    addGroup(day, row, row.status);
    addGroup(totals, row, row.status);
    const status = statuses.get(row.status) as OrderReportStatus;
    status.orders += row.orders;
    status.withoutSubtotal += row.orders - row.withSubtotal;
    addKnownSubtotal(status.subtotals, row);
  }
  return {
    totals,
    days: [...byDay.values()],
    statuses: [...statuses.values()],
    outsidePeriod: [...outside].map(([day, orders]) => ({ day, orders })),
  };
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

/** A line whose price HyFib read, in a currency: counted in the product's subtotal. */
export const PRICED_LINE = sql.raw('unit_price_minor is not null and currency is not null');
/** Its exact complement: the line's quantity is shown without a price. */
export const UNPRICED_LINE = sql.raw('unit_price_minor is null or currency is null');

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

  // The period's visible items, read once (a CTE referenced several times is materialised), and
  // every product figure derived from them: totals, names and priced subtotals for the listed
  // products only. Priced and unpriced lines are exact complements, so they add up to the quantity.
  const products = await tx.execute<{
    retailer_id: string;
    name: string | null;
    quantity: string;
    orders: number;
    unpriced_quantity: string;
    product_count: number;
    priced: { currency: string; lines: number; subtotal: string }[];
  }>(sql`
    with lines as (
      select i.retailer_id, i.name, i.quantity, i.unit_price_minor, i.currency,
             o.id as order_id, o.received_at
        from app.commerce_orders o
        join app.conversations
          on app.conversations.tenant_id = o.tenant_id and app.conversations.id = o.conversation_id
        join app.commerce_order_items i on i.tenant_id = o.tenant_id and i.order_id = o.id
       where i.tenant_id = ${tenantId} and ${inPeriod} ${visible}
    ), listed as (
      select retailer_id, sum(quantity) as quantity, count(distinct order_id)::int as orders,
             coalesce(sum(quantity) filter (where ${UNPRICED_LINE}), 0) as unpriced_quantity,
             (count(*) over ())::int as product_count
        from lines
       group by retailer_id
       order by sum(quantity) desc, retailer_id
       limit ${ORDER_REPORT_PRODUCT_LIMIT}
    ), names as (
      select distinct on (l.retailer_id) l.retailer_id, l.name
        from lines l join listed p on p.retailer_id = l.retailer_id
       where l.name is not null
       order by l.retailer_id, l.received_at desc, l.order_id desc
    ), priced as (
      select l.retailer_id, l.currency, count(*)::int as lines,
             sum(l.quantity::numeric * l.unit_price_minor)::text as subtotal
        from lines l join listed p on p.retailer_id = l.retailer_id
       where ${PRICED_LINE}
       group by 1, 2
    )
    select p.retailer_id, n.name, p.quantity::text as quantity, p.orders,
           p.unpriced_quantity::text as unpriced_quantity, p.product_count,
           coalesce((select json_agg(json_build_object('currency', c.currency, 'lines', c.lines,
                                                       'subtotal', c.subtotal) order by c.currency)
                       from priced c where c.retailer_id = p.retailer_id), '[]'::json) as priced
      from listed p
      left join names n on n.retailer_id = p.retailer_id
     order by p.quantity desc, p.retailer_id`);
  return {
    period,
    generatedAt: now,
    ...summary,
    products: products.rows.map((r) => {
      const subtotals: CurrencyTotal[] = [];
      for (const c of r.priced) {
        addCurrencyTotal(subtotals, c.currency, Number(c.lines), exactMinor(c.subtotal));
      }
      return {
        retailerId: r.retailer_id,
        name: r.name,
        quantity: Number(r.quantity),
        orders: Number(r.orders),
        subtotals,
        unpricedQuantity: Number(r.unpriced_quantity),
      };
    }),
    productCount: Number(products.rows[0]?.product_count ?? 0),
  };
}
