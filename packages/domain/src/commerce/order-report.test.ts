import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { conversations, eq, isNull, or, sql, type SQL, type Tx } from '@w360/db';
import { resolvePeriod } from '../reports/period';
import {
  ORDER_REPORT_PRODUCT_LIMIT,
  PRICED_LINE,
  UNPRICED_LINE,
  addCurrencyTotal,
  exactMinor,
  formatOrderTotal,
  minorToMajorText,
  readOrderReport,
  summariseOrderGroups,
  type CurrencyTotal,
  type OrderGroupRow,
} from './order-report';

const query = (q: SQL) => {
  const built = new PgDialect().sqlToQuery(q);
  return { sql: built.sql.replace(/\s+/g, ' ').trim(), params: built.params };
};

/** A transaction that records each statement and answers it in turn. */
function answering(answers: { rows: unknown[] }[]) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const tx = {
    execute: async (q: SQL) => {
      statements.push(query(q));
      const next = answers.shift();
      if (!next) throw new Error(`unexpected statement: ${query(q).sql}`);
      return next;
    },
  };
  return { tx: tx as unknown as Tx, statements };
}

const row = (over: Partial<OrderGroupRow>): OrderGroupRow => ({
  day: '2026-10-01',
  status: 'received',
  currency: 'INR',
  orders: 1,
  withSubtotal: 1,
  subtotal: '0',
  unreadableItems: 0,
  withUnreadable: 0,
  ...over,
});

describe('order report aggregation (ADR-409)', () => {
  const days = ['2026-10-01', '2026-10-02', '2026-10-03'];

  it('lists every day of the period, with days without orders at zero', () => {
    const { days: out, totals } = summariseOrderGroups([], days);
    expect(out.map((d) => d.day)).toEqual(days);
    expect(out.every((d) => d.orders === 0 && d.subtotals.length === 0)).toBe(true);
    expect(totals.orders).toBe(0);
    expect(totals.byStatus.received).toBe(0);
    expect(totals.byStatus.cancelled).toBe(0);
  });

  it('counts orders per day and status and sums subtotals per currency, exactly', () => {
    const {
      days: out,
      totals,
      statuses,
    } = summariseOrderGroups(
      [
        row({
          day: '2026-10-01',
          status: 'received',
          orders: 2,
          withSubtotal: 2,
          subtotal: '32050',
        }),
        row({ day: '2026-10-01', status: 'paid', currency: 'USD', orders: 1, subtotal: '1999' }),
        row({ day: '2026-10-03', status: 'received', orders: 1, subtotal: '9007199254740993' }),
        row({ day: '2026-10-03', status: 'cancelled', orders: 1, subtotal: '100' }),
      ],
      days,
    );
    expect(out[0]?.orders).toBe(3);
    expect(out[0]?.byStatus.received).toBe(2);
    expect(out[0]?.byStatus.paid).toBe(1);
    expect(out[0]?.subtotals).toEqual([
      { currency: 'INR', count: 2, minor: 32050n },
      { currency: 'USD', count: 1, minor: 1999n },
    ]);
    expect(out[1]?.orders).toBe(0);
    expect(totals.orders).toBe(5);
    // Beyond 2^53 minor units, still exact.
    expect(totals.subtotals.find((s) => s.currency === 'INR')?.minor).toBe(
      32050n + 9007199254740993n + 100n,
    );
    const received = statuses.find((s) => s.status === 'received');
    expect(received?.orders).toBe(3);
    expect(received?.subtotals).toEqual([
      { currency: 'INR', count: 3, minor: 32050n + 9007199254740993n },
    ]);
    expect(statuses.map((s) => s.status)).toEqual([
      'received',
      'confirmed',
      'awaiting_payment',
      'paid',
      'fulfilled',
      'cancelled',
    ]);
  });

  it('keeps orders without a subtotal and unreadable items apart from the sums', () => {
    const { totals, days: out } = summariseOrderGroups(
      [
        // Two orders, one with a total of ₹10 and one with an unreadable item (no total).
        row({
          orders: 2,
          withSubtotal: 1,
          subtotal: '1000',
          unreadableItems: 3,
          withUnreadable: 1,
        }),
        // Items in several currencies: no currency, no total.
        row({ currency: null, orders: 1, withSubtotal: 0, subtotal: '0' }),
      ],
      days,
    );
    expect(totals.orders).toBe(3);
    expect(totals.withoutSubtotal).toBe(2);
    expect(totals.subtotals).toEqual([{ currency: 'INR', count: 1, minor: 1000n }]);
    expect(totals.unreadableItems).toBe(3);
    expect(totals.ordersWithUnreadableItems).toBe(1);
    expect(out[0]?.withoutSubtotal).toBe(2);
  });

  it('leaves rows dated outside the period out of every figure and returns them to log', () => {
    const {
      totals,
      days: out,
      statuses,
      outsidePeriod,
    } = summariseOrderGroups(
      [
        row({
          day: '2026-09-30',
          orders: 2,
          subtotal: '500',
          unreadableItems: 1,
          withUnreadable: 1,
        }),
        row({ day: '2026-09-30', status: 'paid', orders: 1, subtotal: '100' }),
        row({ day: '2026-10-02', orders: 1, subtotal: '700' }),
      ],
      days,
    );
    expect(outsidePeriod).toEqual([{ day: '2026-09-30', orders: 3 }]);
    expect(totals.orders).toBe(1);
    expect(totals.unreadableItems).toBe(0);
    expect(totals.subtotals).toEqual([{ currency: 'INR', count: 1, minor: 700n }]);
    expect(out.map((d) => d.orders)).toEqual([0, 1, 0]);
    expect(statuses.find((s) => s.status === 'paid')?.orders).toBe(0);
    expect(summariseOrderGroups([row({})], days).outsidePeriod).toEqual([]);
  });

  it('refuses rows with an unknown status or a subtotal without a currency', () => {
    expect(() => summariseOrderGroups([row({ status: 'shipped' })], days)).toThrow(/status/);
    expect(() => summariseOrderGroups([row({ currency: null, subtotal: '100' })], days)).toThrow(
      /without a currency/,
    );
  });

  it('adds currency lines in currency order and refuses inexact amounts', () => {
    const lines: CurrencyTotal[] = [];
    addCurrencyTotal(lines, 'USD', 1, 5n);
    addCurrencyTotal(lines, 'AED', 2, 7n);
    addCurrencyTotal(lines, 'USD', 1, 5n);
    expect(lines).toEqual([
      { currency: 'AED', count: 2, minor: 7n },
      { currency: 'USD', count: 2, minor: 10n },
    ]);
    expect(exactMinor('12345678901234567890')).toBe(12345678901234567890n);
    expect(() => exactMinor('12.5')).toThrow();
    expect(() => exactMinor('-1')).toThrow();
    expect(() => exactMinor('1e3')).toThrow();
  });
});

describe('order report money (ADR-409)', () => {
  it('writes minor units exactly in the currency’s major unit', () => {
    expect(minorToMajorText(32050n, 'INR')).toBe('320.50');
    expect(minorToMajorText(5n, 'INR')).toBe('0.05');
    expect(minorToMajorText(0n, 'USD')).toBe('0.00');
    expect(minorToMajorText(1200n, 'JPY')).toBe('1200');
    expect(minorToMajorText(1234n, 'BHD')).toBe('1.234');
    expect(minorToMajorText(9007199254740993n, 'INR')).toBe('90071992547409.93');
    expect(() => minorToMajorText(-1n, 'INR')).toThrow();
  });

  it('formats totals for display without losing digits', () => {
    expect(formatOrderTotal(32050n, 'INR')).toBe('₹320.50');
    expect(formatOrderTotal(1999n, 'USD', 'en-US')).toBe('$19.99');
    expect(formatOrderTotal(1200n, 'JPY', 'en-US')).toBe('¥1,200');
    // A double would round this to …409.92 or …409.94; the decimal text keeps the last paisa.
    expect(formatOrderTotal(9007199254740993n, 'INR', 'en-US')).toBe('₹90,071,992,547,409.93');
  });
});

describe('order report periods (ADR-409)', () => {
  it('bounds a period by local midnights in the company’s time zone', () => {
    const now = new Date('2026-10-21T06:00:00Z');
    const p = resolvePeriod(
      { preset: 'custom', from: '2026-10-01', to: '2026-10-02' },
      'Asia/Kolkata',
      now,
    );
    // 00:00 in Kolkata (UTC+05:30) is 18:30 UTC the day before.
    expect(p.start.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(p.end.toISOString()).toBe('2026-10-02T18:30:00.000Z');
    expect(p.days).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('refuses periods longer than 92 days or ending after today', () => {
    const now = new Date('2026-10-21T06:00:00Z');
    expect(() =>
      resolvePeriod({ preset: 'custom', from: '2026-01-01', to: '2026-10-01' }, 'UTC', now),
    ).toThrow(/at most 92 days/);
    expect(() =>
      resolvePeriod({ preset: 'custom', from: '2026-10-20', to: '2026-10-22' }, 'UTC', now),
    ).toThrow(/after today/);
  });
});

describe('reading the order report (ADR-409)', () => {
  const now = new Date('2026-10-21T06:00:00Z');
  const period = resolvePeriod(
    { preset: 'custom', from: '2026-10-01', to: '2026-10-02' },
    'Asia/Kolkata',
    now,
  );
  // The order list's condition for a member who sees assigned conversations.
  const visibility = or(
    isNull(conversations.assignedMembershipId),
    eq(conversations.assignedMembershipId, 'membership-7'),
  ) as SQL;
  const answers = () => [
    {
      rows: [
        {
          day: '2026-10-02',
          status: 'paid',
          currency: 'INR',
          orders: 2,
          with_subtotal: 1,
          subtotal: '9007199254740993',
          unreadable_items: '1',
          with_unreadable: 1,
        },
      ],
    },
    {
      rows: [
        {
          retailer_id: 'sku-1',
          name: 'Masala chai',
          quantity: '3',
          orders: 2,
          unpriced_quantity: '1',
          product_count: 7,
          priced: [
            { currency: 'USD', lines: 1, subtotal: '12345678901234567890' },
            { currency: 'INR', lines: 1, subtotal: '24000' },
          ],
        },
      ],
    },
  ];
  /** The value bound to the first `$n` after `before` in the statement. */
  const bound = (st: { sql: string; params: unknown[] }, before: string) => {
    const at = st.sql.indexOf(before);
    if (at < 0) return undefined;
    const m = /^\$(\d+)/.exec(st.sql.slice(at + before.length));
    return m ? st.params[Number(m[1]) - 1] : undefined;
  };

  it('bounds both statements by the company, the period and the member’s visibility', async () => {
    const { tx, statements } = answering(answers());
    await readOrderReport(tx, 'tenant-1', period, visibility, now);
    expect(statements).toHaveLength(2);
    for (const st of statements) {
      expect(bound(st, 'where o.tenant_id = ') ?? bound(st, 'and o.tenant_id = ')).toBe('tenant-1');
      expect(bound(st, 'o.received_at >= ')).toBe('2026-09-30T18:30:00.000Z');
      expect(bound(st, 'o.received_at < ')).toBe('2026-10-02T18:30:00.000Z');
      expect(bound(st, '"app"."conversations"."assigned_membership_id" = ')).toBe('membership-7');
      expect(st.sql).toContain(
        'and ("app"."conversations"."assigned_membership_id" is null or "app"."conversations"."assigned_membership_id" = $',
      );
      expect(st.sql).toContain(
        'join app.conversations on app.conversations.tenant_id = o.tenant_id and app.conversations.id = o.conversation_id',
      );
    }
    const [groups, products] = statements as [(typeof statements)[0], (typeof statements)[0]];
    expect(bound(groups, 'to_char(o.received_at at time zone ')).toBe('Asia/Kolkata');
    expect(groups.sql).toContain('group by 1, 2, 3');
    expect(groups.sql).toContain('coalesce(sum(o.subtotal_minor), 0)::text as subtotal');
    expect(bound(products, 'where i.tenant_id = ')).toBe('tenant-1');
    expect(bound(products, 'limit ')).toBe(ORDER_REPORT_PRODUCT_LIMIT);
    // The items are read once; the names and priced subtotals use that set, listed products only.
    expect(products.sql.match(/app\.commerce_order_items/g)).toHaveLength(1);
    expect(products.sql).toContain(
      'select distinct on (l.retailer_id) l.retailer_id, l.name from lines l join listed p on p.retailer_id = l.retailer_id where l.name is not null order by l.retailer_id, l.received_at desc, l.order_id desc',
    );
    expect(products.sql).toContain('sum(l.quantity::numeric * l.unit_price_minor)::text');
    expect(products.sql).toContain(
      'from lines l join listed p on p.retailer_id = l.retailer_id where unit_price_minor is not null and currency is not null group by 1, 2',
    );
    expect(products.sql).toContain(
      'coalesce(sum(quantity) filter (where unit_price_minor is null or currency is null), 0)',
    );
  });

  it('counts each line once: priced and unpriced are exact complements', () => {
    // Every combination of a read price and a read currency is either priced or unpriced, never
    // both and never neither, so the two always add up to the product's quantity.
    const priced = (price: boolean, currency: boolean) => price && currency;
    const unpriced = (price: boolean, currency: boolean) => !price || !currency;
    for (const price of [true, false]) {
      for (const currency of [true, false]) {
        expect(priced(price, currency)).not.toBe(unpriced(price, currency));
      }
    }
    expect(query(sql`${PRICED_LINE}`).sql).toBe(
      'unit_price_minor is not null and currency is not null',
    );
    expect(query(sql`${UNPRICED_LINE}`).sql).toBe('unit_price_minor is null or currency is null');
  });

  it('adds no condition for members who see every conversation', async () => {
    const { tx, statements } = answering(answers());
    await readOrderReport(tx, 'tenant-1', period, undefined, now);
    for (const s of statements) expect(s.sql).not.toContain('assigned_membership_id');
  });

  it('carries the database’s sums exactly into the report', async () => {
    const { tx } = answering(answers());
    const report = await readOrderReport(tx, 'tenant-1', period, sql`true`, now);
    expect(report.generatedAt).toBe(now);
    expect(report.totals).toMatchObject({
      orders: 2,
      withoutSubtotal: 1,
      unreadableItems: 1,
      ordersWithUnreadableItems: 1,
      subtotals: [{ currency: 'INR', count: 1, minor: 9007199254740993n }],
    });
    expect(report.days.map((d) => d.orders)).toEqual([0, 2]);
    expect(report.products).toMatchObject([
      {
        retailerId: 'sku-1',
        name: 'Masala chai',
        quantity: 3,
        orders: 2,
        unpricedQuantity: 1,
        subtotals: [
          { currency: 'INR', count: 1, minor: 24000n },
          { currency: 'USD', count: 1, minor: 12345678901234567890n },
        ],
      },
    ]);
    expect(report.productCount).toBe(7);
    expect(report.outsidePeriod).toEqual([]);
  });

  it('lists nothing when no product was ordered', async () => {
    const { tx, statements } = answering([{ rows: [] }, { rows: [] }]);
    const report = await readOrderReport(tx, 'tenant-1', period, undefined, now);
    expect(statements).toHaveLength(2);
    expect(report.products).toHaveLength(0);
    expect(report.productCount).toBe(0);
  });
});
