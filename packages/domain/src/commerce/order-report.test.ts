import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { conversations, eq, isNull, or, sql, type SQL, type Tx } from '@w360/db';
import { resolvePeriod } from '../reports/period';
import {
  ORDER_REPORT_PRODUCT_LIMIT,
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

  it('refuses rows outside the period, with an unknown status or a subtotal without a currency', () => {
    expect(() => summariseOrderGroups([row({ day: '2026-09-30' })], days)).toThrow(/outside/);
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
        },
      ],
    },
    { rows: [{ retailer_id: 'sku-1', currency: 'INR', lines: 1, subtotal: '24000' }] },
  ];

  it('bounds every statement by the company, the period and the member’s visibility', async () => {
    const { tx, statements } = answering(answers());
    await readOrderReport(tx, 'tenant-1', period, visibility, now);
    expect(statements).toHaveLength(3);
    /** The value bound to the first `$n` after `before` in the statement. */
    const bound = (st: (typeof statements)[0], before: string) => {
      const at = st.sql.indexOf(before);
      if (at < 0) return undefined;
      const m = /^\$(\d+)/.exec(st.sql.slice(at + before.length));
      return m ? st.params[Number(m[1]) - 1] : undefined;
    };
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
    const [groups, products, priced] = statements as [
      (typeof statements)[0],
      (typeof statements)[0],
      (typeof statements)[0],
    ];
    expect(bound(groups, 'to_char(o.received_at at time zone ')).toBe('Asia/Kolkata');
    expect(groups.sql).toContain('group by 1, 2, 3');
    expect(groups.sql).toContain('coalesce(sum(o.subtotal_minor), 0)::text as subtotal');
    expect(bound(products, 'where i.tenant_id = ')).toBe('tenant-1');
    expect(bound(priced, 'where i.tenant_id = ')).toBe('tenant-1');
    expect(bound(products, 'limit ')).toBe(ORDER_REPORT_PRODUCT_LIMIT);
    expect(priced.sql).toContain('sum(i.quantity::numeric * i.unit_price_minor)::text');
    expect(priced.sql).toContain('group by 1, 2');
    expect(bound(priced, 'i.retailer_id = any(')).toEqual(['sku-1']);
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
        subtotals: [{ currency: 'INR', count: 1, minor: 24000n }],
      },
    ]);
    expect(report.productCount).toBe(7);
  });

  it('skips the priced query when no product was ordered', async () => {
    const { tx, statements } = answering([{ rows: [] }, { rows: [] }]);
    const report = await readOrderReport(tx, 'tenant-1', period, undefined, now);
    expect(statements).toHaveLength(2);
    expect(report.products).toHaveLength(0);
    expect(report.productCount).toBe(0);
  });
});
