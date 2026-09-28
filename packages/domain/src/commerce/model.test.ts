import { describe, expect, it } from 'vitest';
import {
  COMMERCE_LIMITS,
  MEMBER_ORDER_TRANSITIONS,
  ORDER_REFERENCE_RE,
  PAYMENT_LINK_REFERENCE_RE,
  PAYMENT_WEBHOOK_ID_RE,
  buildProductMessageRequest,
  newOrderReference,
  newPaymentLinkReference,
  newPaymentWebhookId,
  orderPriceToMinor,
  parseOrder,
  paymentRequestText,
  productListProblem,
  productMessageSchema,
  razorpayMode,
} from './model';

const item = (
  retailerId: string,
  quantity: unknown,
  price: unknown,
  currency: unknown = 'INR',
) => ({
  product_retailer_id: retailerId,
  quantity,
  item_price: price,
  currency,
});

describe('order prices', () => {
  it('converts webhook prices to minor units exactly', () => {
    expect(orderPriceToMinor(19.99, 'INR')).toBe(1999);
    expect(orderPriceToMinor(0.1, 'INR')).toBe(10);
    expect(orderPriceToMinor(250, 'INR')).toBe(25000);
    expect(orderPriceToMinor(1500, 'JPY')).toBe(1500);
    expect(orderPriceToMinor(1.234, 'BHD')).toBe(1234);
  });

  it('refuses prices that do not fit the currency or are not plain numbers', () => {
    expect(orderPriceToMinor(19.999, 'INR')).toBeNull();
    expect(orderPriceToMinor(1.5, 'JPY')).toBeNull();
    expect(orderPriceToMinor(-1, 'INR')).toBeNull();
    expect(orderPriceToMinor(1e21, 'INR')).toBeNull();
    expect(orderPriceToMinor(Number.NaN, 'INR')).toBeNull();
    expect(orderPriceToMinor('19.99', 'INR')).toBeNull();
    expect(orderPriceToMinor(10, 'ZZZ')).toBeNull();
  });
});

describe('parseOrder', () => {
  it('reads the cart, its note and an exact subtotal', () => {
    const order = parseOrder({
      catalog_id: '5550004',
      text: '  Please gift wrap  ',
      product_items: [item('sku-1', 2, 19.99), item('sku-2', 1, 250), item('sku-9', 1, 0.1)],
    });
    expect(order).toEqual({
      catalogId: '5550004',
      note: 'Please gift wrap',
      items: [
        { retailerId: 'sku-1', quantity: 2, unitPriceMinor: 1999, currency: 'INR' },
        { retailerId: 'sku-2', quantity: 1, unitPriceMinor: 25000, currency: 'INR' },
        { retailerId: 'sku-9', quantity: 1, unitPriceMinor: 10, currency: 'INR' },
      ],
      dropped: 0,
      currency: 'INR',
      subtotalMinor: 29008,
    });
  });

  it('leaves out unreadable items and counts them', () => {
    const order = parseOrder({
      catalog_id: '1',
      product_items: [
        item('sku-1', 1, 10),
        item('', 1, 10),
        item('sku-3', 0, 10),
        item('sku-4', 1.5, 10),
        item('sku-5', '2', 10),
        'not an item',
      ],
    });
    expect(order?.items.map((i) => i.retailerId)).toEqual(['sku-1']);
    expect(order?.dropped).toBe(5);
    // The readable items alone are not the cart: no total, so it cannot be charged short.
    expect(order).toMatchObject({ currency: 'INR', subtotalMinor: null });
  });

  it('keeps at most the item limit', () => {
    const many = Array.from({ length: COMMERCE_LIMITS.orderItems + 3 }, (_, i) =>
      item(`sku-${i}`, 1, 1),
    );
    const order = parseOrder({ catalog_id: '1', product_items: many });
    expect(order?.items).toHaveLength(COMMERCE_LIMITS.orderItems);
    expect(order?.dropped).toBe(3);
    expect(order?.subtotalMinor).toBeNull();
    const full = parseOrder({ catalog_id: '1', product_items: many.slice(0, 100) });
    expect(full).toMatchObject({ dropped: 0, subtotalMinor: COMMERCE_LIMITS.orderItems * 100 });
  });

  it('has no subtotal when a price is unreadable or currencies differ', () => {
    const unreadable = parseOrder({
      catalog_id: '1',
      product_items: [item('a', 1, 10), item('b', 1, 10.001)],
    });
    expect(unreadable).toMatchObject({ currency: 'INR', subtotalMinor: null });
    expect(unreadable?.items[1]?.unitPriceMinor).toBeNull();
    const mixed = parseOrder({
      catalog_id: '1',
      product_items: [item('a', 1, 10), item('b', 1, 10, 'USD')],
    });
    expect(mixed).toMatchObject({ currency: null, subtotalMinor: null });
    const noCurrency = parseOrder({ catalog_id: '1', product_items: [item('a', 1, 10, 'inr')] });
    expect(noCurrency).toMatchObject({ currency: null, subtotalMinor: null });
  });

  it('refuses orders without a catalog or any readable item', () => {
    expect(parseOrder(null)).toBeNull();
    expect(parseOrder([])).toBeNull();
    expect(parseOrder({ product_items: [item('a', 1, 1)] })).toBeNull();
    expect(parseOrder({ catalog_id: 'abc', product_items: [item('a', 1, 1)] })).toBeNull();
    expect(parseOrder({ catalog_id: '1', product_items: [] })).toBeNull();
    expect(parseOrder({ catalog_id: '1', product_items: [item('a', 0, 1)] })).toBeNull();
  });

  it('keeps notes to 1000 characters and drops blank ones', () => {
    const long = parseOrder({
      catalog_id: '1',
      text: 'x'.repeat(1500),
      product_items: [item('a', 1, 1)],
    });
    expect(long?.note).toHaveLength(1000);
    const blank = parseOrder({ catalog_id: '1', text: '   ', product_items: [item('a', 1, 1)] });
    expect(blank?.note).toBeNull();
  });
});

describe('product messages', () => {
  it('builds single, multi-product and catalog messages as Meta documents them', () => {
    expect(
      buildProductMessageRequest('919800000001', {
        kind: 'product',
        catalogId: '555',
        retailerId: 'sku-1',
        body: '',
        footer: '',
      }),
    ).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919800000001',
      type: 'interactive',
      interactive: { type: 'product', action: { catalog_id: '555', product_retailer_id: 'sku-1' } },
    });
    const list = buildProductMessageRequest('919800000001', {
      kind: 'product_list',
      catalogId: '555',
      header: 'Our picks',
      body: 'Have a look',
      footer: 'Prices include tax',
      sections: [
        { title: 'Tea', retailerIds: ['sku-1', 'sku-2'] },
        { title: 'Coffee', retailerIds: ['sku-3'] },
      ],
    });
    expect(list.interactive).toEqual({
      type: 'product_list',
      header: { type: 'text', text: 'Our picks' },
      body: { text: 'Have a look' },
      footer: { text: 'Prices include tax' },
      action: {
        catalog_id: '555',
        sections: [
          {
            title: 'Tea',
            product_items: [{ product_retailer_id: 'sku-1' }, { product_retailer_id: 'sku-2' }],
          },
          { title: 'Coffee', product_items: [{ product_retailer_id: 'sku-3' }] },
        ],
      },
    });
    const single = buildProductMessageRequest('1', {
      kind: 'product_list',
      catalogId: '555',
      header: 'H',
      body: 'B',
      footer: '',
      sections: [{ title: '', retailerIds: ['sku-1'] }],
    });
    expect((single.interactive as { action: { sections: unknown[] } }).action.sections).toEqual([
      { product_items: [{ product_retailer_id: 'sku-1' }] },
    ]);
    expect(
      buildProductMessageRequest('1', {
        kind: 'catalog',
        thumbnailRetailerId: 'sku-2',
        body: 'Browse our catalog',
        footer: '',
      }).interactive,
    ).toEqual({
      type: 'catalog_message',
      body: { text: 'Browse our catalog' },
      action: {
        name: 'catalog_message',
        parameters: { thumbnail_product_retailer_id: 'sku-2' },
      },
    });
  });

  it('checks the limits of multi-product messages', () => {
    const ids = (n: number, from = 0) =>
      Array.from(
        { length: n },
        (_, i) => `00000000-0000-7000-8000-${String(from + i).padStart(12, '0')}`,
      );
    expect(productListProblem([{ title: '', productIds: ids(30) }])).toBeNull();
    expect(productListProblem([{ title: '', productIds: ids(31) }])).toMatch(/at most 30/);
    expect(
      productListProblem([
        { title: 'A', productIds: ids(2) },
        { title: '', productIds: ids(2, 2) },
      ]),
    ).toMatch(/title/);
    expect(
      productListProblem([
        { title: 'A', productIds: ids(2) },
        { title: 'B', productIds: ids(1) },
      ]),
    ).toMatch(/only once/);
    const parsed = productMessageSchema.safeParse({
      kind: 'product_list',
      header: '',
      body: 'x',
      footer: '',
      sections: [{ title: '', productIds: ids(1) }],
    });
    expect(parsed.success).toBe(false);
    expect(
      productMessageSchema.safeParse({
        kind: 'product_list',
        header: 'H',
        body: 'x',
        footer: '',
        sections: Array.from({ length: 11 }, (_, i) => ({ title: `S${i}`, productIds: ids(1, i) })),
      }).success,
    ).toBe(false);
  });
});

describe('orders and payments', () => {
  it('lets members move orders only along the documented statuses', () => {
    expect(MEMBER_ORDER_TRANSITIONS.received).toEqual(['confirmed', 'cancelled']);
    expect(MEMBER_ORDER_TRANSITIONS.confirmed).toEqual(['fulfilled', 'cancelled']);
    expect(MEMBER_ORDER_TRANSITIONS.awaiting_payment).toEqual([]);
    expect(MEMBER_ORDER_TRANSITIONS.paid).toEqual(['fulfilled']);
    expect(MEMBER_ORDER_TRANSITIONS.fulfilled).toEqual([]);
    expect(MEMBER_ORDER_TRANSITIONS.cancelled).toEqual([]);
  });

  it('makes references within Razorpay’s and the database’s limits', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(newOrderReference()).toMatch(ORDER_REFERENCE_RE);
      const reference = newPaymentLinkReference();
      expect(reference).toMatch(PAYMENT_LINK_REFERENCE_RE);
      expect(reference.length).toBeLessThanOrEqual(40);
      expect(newPaymentWebhookId()).toMatch(PAYMENT_WEBHOOK_ID_RE);
    }
    expect(razorpayMode('rzp_live_ABCDEFGH12')).toBe('live');
    expect(razorpayMode('rzp_test_ABCDEFGH12')).toBe('test');
  });

  it('writes the chat message that carries a Payment Link', () => {
    expect(
      paymentRequestText({
        amountMinor: 15000,
        currency: 'INR',
        orderReference: 'ABCDEFGH',
        url: 'https://rzp.io/i/abc123',
      }),
    ).toBe('Pay ₹150.00 for order ABCDEFGH: https://rzp.io/i/abc123');
  });
});
