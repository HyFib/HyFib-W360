import { describe, expect, it } from 'vitest';
import { TEMPLATE_LIMITS, buildTemplateSend, sendSpecFor } from '../templates/definition';
import {
  checkoutReminders,
  checkoutValues,
  codPayload,
  delayRange,
  detectOrderEvents,
  orderValues,
  parseCodPayload,
  resolveStoreVariables,
  storeConsentAction,
  storeLinkProblem,
  storeVariablesSchema,
  storeMessageSendAt,
  variablesFit,
  type EnabledRule,
  type OrderMilestones,
  type StoreMessageEvent,
  type StoreVariableSource,
} from './messages-model';
import {
  hasCustomerAccess,
  isCashOnDeliveryName,
  shopifyAuthorizeUrl,
  shopifyConsentSupported,
  shopifyScopesFor,
} from './model';
import { parseShopifyCheckout, parseShopifyOrder } from './shopify';
import { parseWooOrder } from './woocommerce';

const NOW = new Date('2026-09-27T10:00:00Z');
const ENABLED = new Date('2026-09-27T08:00:00Z');
const at = (iso: string) => new Date(iso);

const order = (over: Partial<OrderMilestones> = {}): OrderMilestones => ({
  placedAt: at('2026-09-27T09:00:00Z'),
  cancelled: false,
  cancelledAt: null,
  shippedAt: null,
  deliveredAt: null,
  cashOnDelivery: false,
  test: false,
  ...over,
});

const rules = (...events: StoreMessageEvent[]): EnabledRule[] =>
  events.map((event) => ({ event, enabledAt: ENABLED }));

const detect = (
  previous: OrderMilestones | null,
  current: OrderMilestones,
  enabled: EnabledRule[],
  includeTestOrders = false,
) => detectOrderEvents({ previous, current, rules: enabled, includeTestOrders, now: NOW });

describe('order events', () => {
  it('messages a new order placed after the rule was switched on, never an older one', () => {
    expect(detect(null, order(), rules('order_placed'))).toEqual([
      { event: 'order_placed', occurredAt: at('2026-09-27T09:00:00Z'), skip: null },
    ]);
    // The first read of a store brings 60 days of orders: none of them is new to the rule.
    expect(
      detect(null, order({ placedAt: at('2026-09-27T07:59:59Z') }), rules('order_placed')),
    ).toEqual([]);
    // An order already in the copy is not placed again.
    expect(detect(order(), order(), rules('order_placed'))).toEqual([]);
    expect(detect(null, order({ cancelled: true }), rules('order_placed'))).toEqual([]);
  });

  it('asks orders paid on delivery to confirm, instead of the plain confirmation', () => {
    const cod = order({ cashOnDelivery: true });
    expect(detect(null, cod, rules('order_placed', 'cod_confirmation'))).toEqual([
      { event: 'order_placed', occurredAt: cod.placedAt, skip: 'cash_on_delivery' },
      { event: 'cod_confirmation', occurredAt: cod.placedAt, skip: null },
    ]);
    // Without the cash on delivery message, such an order gets the plain confirmation.
    expect(detect(null, cod, rules('order_placed'))).toEqual([
      { event: 'order_placed', occurredAt: cod.placedAt, skip: null },
    ]);
    expect(detect(null, order(), rules('cod_confirmation'))).toEqual([]);
  });

  it('sees shipping and delivery only when they change, and never on cancelled orders', () => {
    const shipped = at('2026-09-27T09:30:00Z');
    const delivered = at('2026-09-27T09:45:00Z');
    expect(detect(order(), order({ shippedAt: shipped }), rules('order_shipped'))).toEqual([
      { event: 'order_shipped', occurredAt: shipped, skip: null },
    ]);
    expect(
      detect(order({ shippedAt: shipped }), order({ shippedAt: shipped }), rules('order_shipped')),
    ).toEqual([]);
    // Placed and shipped between two reads: both happened after the rule was switched on.
    expect(detect(null, order({ shippedAt: shipped }), rules('order_shipped'))).toHaveLength(1);
    expect(
      detect(order(), order({ shippedAt: shipped, cancelled: true }), rules('order_shipped')),
    ).toEqual([]);
    expect(
      detect(
        order({ shippedAt: shipped }),
        order({ shippedAt: shipped, deliveredAt: delivered }),
        rules('order_delivered', 'order_shipped'),
      ),
    ).toEqual([{ event: 'order_delivered', occurredAt: delivered, skip: null }]);
    // Shipped before the rule was switched on: nothing, even though HyFib sees it only now.
    expect(
      detect(order(), order({ shippedAt: at('2026-09-27T07:00:00Z') }), rules('order_shipped')),
    ).toEqual([]);
  });

  it('dates a cancellation by the store, or by when HyFib saw it change', () => {
    const shopify = at('2026-09-27T09:50:00Z');
    expect(
      detect(order(), order({ cancelled: true, cancelledAt: shopify }), rules('order_cancelled')),
    ).toEqual([{ event: 'order_cancelled', occurredAt: shopify, skip: null }]);
    // WooCommerce gives no time: the change seen now is dated now.
    expect(detect(order(), order({ cancelled: true }), rules('order_cancelled'))).toEqual([
      { event: 'order_cancelled', occurredAt: NOW, skip: null },
    ]);
    // New to the copy and already cancelled: only with the store's own time.
    expect(detect(null, order({ cancelled: true }), rules('order_cancelled'))).toEqual([]);
    expect(
      detect(null, order({ cancelled: true, cancelledAt: shopify }), rules('order_cancelled')),
    ).toHaveLength(1);
    expect(
      detect(
        order({ cancelled: true }),
        order({ cancelled: true, cancelledAt: shopify }),
        rules('order_cancelled'),
      ),
    ).toEqual([]);
  });

  it('records test orders and late events without sending them', () => {
    expect(detect(null, order({ test: true }), rules('order_placed'))).toEqual([
      { event: 'order_placed', occurredAt: at('2026-09-27T09:00:00Z'), skip: 'test_order' },
    ]);
    expect(detect(null, order({ test: true }), rules('order_placed'), true)[0]?.skip).toBeNull();
    const old: EnabledRule[] = [{ event: 'order_placed', enabledAt: at('2026-09-20T00:00:00Z') }];
    expect(detect(null, order({ placedAt: at('2026-09-25T09:59:59Z') }), old)[0]?.skip).toBe(
      'too_late',
    );
    expect(detect(null, order({ placedAt: at('2026-09-25T10:00:00Z') }), old)[0]?.skip).toBeNull();
  });
});

describe('send time', () => {
  const window = { start: 9 * 60, end: 21 * 60 };

  it('adds the delay to the event, but never sends before now', () => {
    expect(
      storeMessageSendAt({
        occurredAt: at('2026-09-27T09:58:00Z'),
        now: NOW,
        delayMinutes: 10,
        window: null,
        timeZone: 'UTC',
      }),
    ).toEqual(at('2026-09-27T10:08:00Z'));
    expect(
      storeMessageSendAt({
        occurredAt: at('2026-09-27T09:00:00Z'),
        now: NOW,
        delayMinutes: 10,
        window: null,
        timeZone: 'UTC',
      }),
    ).toEqual(NOW);
  });

  it('waits for the sending hours in the company’s time zone', () => {
    // 10:00 UTC is 15:30 in Kolkata: inside 09:00–21:00.
    expect(
      storeMessageSendAt({
        occurredAt: NOW,
        now: NOW,
        delayMinutes: 0,
        window,
        timeZone: 'Asia/Kolkata',
      }),
    ).toEqual(NOW);
    // 17:00 UTC is 22:30 in Kolkata: the next morning at 09:00 (03:30 UTC).
    const late = at('2026-09-27T17:00:00Z');
    expect(
      storeMessageSendAt({
        occurredAt: late,
        now: late,
        delayMinutes: 0,
        window,
        timeZone: 'Asia/Kolkata',
      }),
    ).toEqual(at('2026-09-28T03:30:00Z'));
  });
});

describe('template variables', () => {
  const values = orderValues({
    name: '#1001',
    customerName: '  Priya\n Customer ',
    currency: 'INR',
    totalMinor: 149900,
    items: [
      { title: 'Darjeeling tea', quantity: 3 },
      { title: 'Cup', quantity: 1 },
      { title: 'Saucer', quantity: 1 },
    ],
    statusUrl: null,
    trackingNumber: 'AWB123',
    trackingCompany: 'Delhivery',
    trackingUrl: 'https://track.example/AWB123',
    storeName: 'Tara Tea',
  });

  it('offers the order’s values, formatted', () => {
    expect(values).toMatchObject({
      order_name: '#1001',
      customer_name: 'Priya Customer',
      order_total: '₹1,499.00',
      items_summary: 'Darjeeling tea and 2 more',
      status_url: null,
      tracking_number: 'AWB123',
    });
  });

  it('fills the ends of links from the order, using the fallback a link can take (ADR-229)', () => {
    const links = [
      { index: 0, text: 'Track', url: 'https://tara.example/track/{{1}}' },
      { index: 1, text: 'Review', url: 'https://tara.example/review?o={{1}}' },
    ];
    const linked = (buttons: StoreVariableSource[]) => ({ header: [], body: [], buttons });
    expect(
      resolveStoreVariables(
        linked([
          { source: 'order', field: 'tracking_number' },
          { source: 'static', value: 'wa' },
        ]),
        { subject: 'order', values },
        links,
      ),
    ).toEqual({ ok: true, params: { header: [], body: [], buttons: ['AWB123', 'wa'] } });
    // A value a link cannot end with (spaces), or none: the fallback when it can.
    expect(
      resolveStoreVariables(
        linked([
          { source: 'order', field: 'items_summary', fallback: 'latest' },
          { source: 'order', field: 'status_url', fallback: 'orders' },
        ]),
        { subject: 'order', values },
        links,
      ),
    ).toMatchObject({ params: { buttons: ['latest', 'orders'] } });
    expect(
      resolveStoreVariables(
        linked([{ source: 'order', field: 'items_summary', fallback: 'a b' }]),
        { subject: 'order', values },
        links,
      ),
    ).toEqual({ ok: false, missing: 'buttons.1' });
    // A checkout's field for an order's message, or no link for the value, is not filled.
    expect(
      resolveStoreVariables(
        linked([{ source: 'checkout', field: 'customer_name' }]),
        { subject: 'order', values },
        links,
      ),
    ).toEqual({ ok: false, missing: 'buttons.1' });
    expect(
      resolveStoreVariables(linked([{ source: 'static', value: 'wa' }]), {
        subject: 'order',
        values,
      }),
    ).toEqual({ ok: false, missing: 'buttons.1' });
    expect(variablesFit('cart_reminder', linked([{ source: 'order', field: 'order_name' }]))).toBe(
      false,
    );
    // At most two, as a template has at most two website buttons.
    expect(
      storeVariablesSchema.safeParse({
        buttons: ['a', 'b', 'c'].map((value) => ({ source: 'static', value })),
      }).success,
    ).toBe(false);
    // Fixed text and fallbacks are checked when the message is saved.
    expect(storeLinkProblem(linked([{ source: 'static', value: 'wa' }]), links)).toBeNull();
    expect(storeLinkProblem(linked([{ source: 'static', value: 'w a' }]), links)).toBe(
      'Track: The end of a link cannot contain spaces.',
    );
    expect(
      storeLinkProblem(
        linked([
          { source: 'order', field: 'tracking_number' },
          { source: 'order', field: 'order_name', fallback: 'no order' },
        ]),
        links,
      ),
    ).toBe('Review (fallback): The end of a link cannot contain spaces.');
  });

  it('fills variables with fallbacks and names the first one it cannot fill', () => {
    expect(
      resolveStoreVariables(
        {
          header: [{ source: 'static', value: 'Tara  Tea' }],
          body: [
            { source: 'order', field: 'customer_name' },
            { source: 'order', field: 'status_url', fallback: 'our website' },
          ],
          buttons: [],
        },
        { subject: 'order', values },
      ),
    ).toEqual({
      ok: true,
      params: { header: ['Tara Tea'], body: ['Priya Customer', 'our website'], buttons: [] },
    });
    expect(
      resolveStoreVariables(
        {
          header: [],
          body: [
            { source: 'order', field: 'order_name' },
            { source: 'order', field: 'status_url' },
          ],
          buttons: [],
        },
        { subject: 'order', values },
      ),
    ).toEqual({ ok: false, missing: 'body.2' });
    // A value is clipped to the parameter limit without splitting an emoji (ADR-133).
    const long = `${'x'.repeat(TEMPLATE_LIMITS.parameterValue - 1)}😀 and more`;
    expect(
      resolveStoreVariables(
        {
          header: [{ source: 'order', field: 'customer_name' }],
          body: [{ source: 'order', field: 'customer_name' }],
          buttons: [],
        },
        { subject: 'order', values: { ...values, customer_name: long } },
      ),
    ).toEqual({
      ok: true,
      params: {
        header: ['x'.repeat(TEMPLATE_LIMITS.parameterValue - 1)],
        body: ['x'.repeat(TEMPLATE_LIMITS.parameterValue - 1)],
        buttons: [],
      },
    });
  });
});

describe('cash on delivery answers', () => {
  const id = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';

  it('round-trips the button payloads and refuses anything else', () => {
    expect(parseCodPayload(codPayload(id, 'confirm'))).toEqual({
      storeMessageId: id,
      answer: 'confirmed',
    });
    expect(parseCodPayload(codPayload(id, 'cancel'))?.answer).toBe('cancelled');
    for (const bad of [
      'Confirm order',
      `w360-cod:${id}:yes`,
      `w360-cod:${id.toUpperCase()}:confirm`,
      `x${codPayload(id, 'confirm')}`,
      42,
      null,
    ]) {
      expect(parseCodPayload(bad)).toBeNull();
    }
  });

  it('sets the payloads on the template’s quick reply buttons', () => {
    const spec = sendSpecFor('UTILITY', [
      { type: 'BODY', text: 'Confirm order {{1}}?', example: { body_text: [['#1']] } },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Confirm' },
          { type: 'QUICK_REPLY', text: 'Cancel' },
          { type: 'URL', text: 'Shop', url: 'https://shop.example' },
        ],
      },
    ]);
    if (!spec.supported) throw new Error(spec.reason);
    const built = buildTemplateSend(
      { name: 'cod', language: 'en' },
      spec,
      { header: [], body: ['#1001'] },
      {
        quickReplyPayloads: new Map([
          [1, codPayload(id, 'cancel')],
          [0, codPayload(id, 'confirm')],
        ]),
      },
    );
    expect(built.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '#1001' }] },
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '0',
        parameters: [{ type: 'payload', payload: codPayload(id, 'confirm') }],
      },
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '1',
        parameters: [{ type: 'payload', payload: codPayload(id, 'cancel') }],
      },
    ]);
    expect(() =>
      buildTemplateSend(
        { name: 'cod', language: 'en' },
        spec,
        { header: [], body: ['#1001'] },
        { quickReplyPayloads: new Map([[2, 'x']]) },
      ),
    ).toThrow(/not a quick reply/);
  });
});

describe('order milestones from the stores', () => {
  const money = (amount: string) => ({ shopMoney: { amount, currencyCode: 'INR' } });
  const base = {
    id: 'gid://shopify/Order/5001',
    name: '#1001',
    createdAt: '2026-09-27T09:00:00Z',
    updatedAt: '2026-09-27T09:50:00Z',
    totalPriceSet: money('1499.00'),
    lineItems: { nodes: [], pageInfo: { hasNextPage: false } },
  };

  it('reads Shopify shipments: the first real one ships, all delivered delivers', () => {
    const parsed = parseShopifyOrder({
      ...base,
      displayFulfillmentStatus: 'FULFILLED',
      paymentGatewayNames: ['Cash on Delivery (COD)'],
      fulfillments: [
        // Each flag alone rules a shipment out: a cancelled or failed status, or display status.
        {
          status: 'CANCELLED',
          displayStatus: null,
          createdAt: '2026-09-27T09:05:00Z',
          trackingInfo: [{ company: 'Old', number: 'X', url: null }],
        },
        {
          status: 'SUCCESS',
          displayStatus: 'FAILURE',
          createdAt: '2026-09-27T09:06:00Z',
          trackingInfo: [{ company: 'Old', number: 'Y', url: null }],
        },
        {
          status: 'SUCCESS',
          displayStatus: 'DELIVERED',
          createdAt: '2026-09-27T09:10:00Z',
          updatedAt: '2026-09-27T09:40:00Z',
          deliveredAt: '2026-09-27T09:30:00Z',
          trackingInfo: [{ company: 'Delhivery', number: 'AWB1', url: 'https://t.example/1' }],
        },
        {
          status: 'SUCCESS',
          displayStatus: 'DELIVERED',
          createdAt: '2026-09-27T09:20:00Z',
          updatedAt: '2026-09-27T09:45:00Z',
          deliveredAt: null,
          trackingInfo: [{ company: 'Blue Dart', number: 'AWB2', url: 'http://t.example/2' }],
        },
      ],
    });
    expect(parsed).toMatchObject({
      paymentNames: ['Cash on Delivery (COD)'],
      cashOnDelivery: true,
      shippedAt: at('2026-09-27T09:10:00Z'),
      // The second shipment is DELIVERED without a time: its last update counts.
      deliveredAt: at('2026-09-27T09:45:00Z'),
      trackingCompany: 'Blue Dart',
      trackingNumber: 'AWB2',
      // Only https tracking links are kept.
      trackingUrl: null,
    });
    const partly = parseShopifyOrder({
      ...base,
      displayFulfillmentStatus: 'PARTIALLY_FULFILLED',
      paymentGatewayNames: ['Shopify Payments'],
      fulfillments: [
        {
          status: 'SUCCESS',
          displayStatus: 'DELIVERED',
          createdAt: '2026-09-27T09:10:00Z',
          deliveredAt: '2026-09-27T09:30:00Z',
          trackingInfo: [],
        },
      ],
    });
    expect(partly).toMatchObject({
      cashOnDelivery: false,
      shippedAt: at('2026-09-27T09:10:00Z'),
      deliveredAt: null,
      trackingNumber: null,
    });
    expect(parseShopifyOrder({ ...base, fulfillments: [] })).toMatchObject({
      shippedAt: null,
      deliveredAt: null,
      paymentNames: [],
    });
  });

  it('reads WooCommerce payment by gateway id and completion as shipped', () => {
    const woo = (status: string, extra: Record<string, unknown> = {}) =>
      parseWooOrder(
        {
          id: 41,
          number: '41',
          status,
          currency: 'INR',
          total: '850.00',
          date_created_gmt: '2026-09-27T09:00:00',
          date_modified_gmt: '2026-09-27T09:40:00',
          payment_method: 'cod',
          payment_method_title: 'Pay when it arrives',
          line_items: [],
          ...extra,
        },
        'INR',
      );
    expect(woo('processing')).toMatchObject({
      cashOnDelivery: true,
      paymentNames: ['Pay when it arrives'],
      shippedAt: null,
      deliveredAt: null,
    });
    expect(woo('completed', { date_completed_gmt: '2026-09-27T09:30:00' })).toMatchObject({
      shippedAt: at('2026-09-27T09:30:00Z'),
    });
    expect(woo('completed', { payment_method: 'bacs' })).toMatchObject({
      cashOnDelivery: false,
      shippedAt: at('2026-09-27T09:40:00Z'),
    });
  });

  it('recognises cash on delivery names conservatively', () => {
    expect(isCashOnDeliveryName('Cash on Delivery (COD)')).toBe(true);
    expect(isCashOnDeliveryName('cash  on delivery')).toBe(true);
    expect(isCashOnDeliveryName('COD')).toBe(false);
    expect(isCashOnDeliveryName('Bank Deposit')).toBe(false);
  });
});

describe('cart reminders', () => {
  const checkout = (over: Partial<Parameters<typeof checkoutReminders>[0]['checkout']> = {}) => ({
    updatedAt: at('2026-09-27T09:30:00Z'),
    completed: false,
    hasPhone: true,
    redacted: false,
    ...over,
  });

  it('reminds about open checkouts with a number, left after the rule was switched on', () => {
    const on = rules('cart_reminder', 'cart_second_reminder', 'order_placed');
    expect(checkoutReminders({ checkout: checkout(), rules: on })).toEqual([
      { event: 'cart_reminder', occurredAt: at('2026-09-27T09:30:00Z') },
      { event: 'cart_second_reminder', occurredAt: at('2026-09-27T09:30:00Z') },
    ]);
    // Left exactly when the rule went on still counts; a second earlier does not.
    expect(
      checkoutReminders({ checkout: checkout({ updatedAt: ENABLED }), rules: on }),
    ).toHaveLength(2);
    expect(
      checkoutReminders({
        checkout: checkout({ updatedAt: new Date(ENABLED.getTime() - 1000) }),
        rules: on,
      }),
    ).toEqual([]);
    for (const over of [{ completed: true }, { hasPhone: false }, { redacted: true }]) {
      expect(checkoutReminders({ checkout: checkout(over), rules: on })).toEqual([]);
    }
    // Order rules never react to checkouts, and cart rules never to orders.
    expect(checkoutReminders({ checkout: checkout(), rules: rules('order_placed') })).toEqual([]);
    expect(detect(null, order(), rules('cart_reminder', 'cart_second_reminder'))).toEqual([]);
  });

  it('keeps the delays of the reminders apart from the order messages', () => {
    expect(delayRange('cart_reminder')).toEqual({ min: 30, max: 1440 });
    expect(delayRange('cart_second_reminder')).toEqual({ min: 60, max: 4320 });
    expect(delayRange('order_placed')).toEqual({ min: 0, max: 1440 });
  });

  it('reads the store’s consent: subscribed and unsubscribed with a time, nothing else', () => {
    const when = at('2026-09-20T10:00:00Z');
    expect(storeConsentAction({ state: 'SUBSCRIBED', updatedAt: when })).toBe('opt_in');
    expect(storeConsentAction({ state: 'UNSUBSCRIBED', updatedAt: when })).toBe('opt_out');
    expect(storeConsentAction({ state: 'SUBSCRIBED', updatedAt: null })).toBeNull();
    for (const state of ['PENDING', 'NEVER_SUBSCRIBED', 'REDACTED', null]) {
      expect(storeConsentAction({ state, updatedAt: when })).toBeNull();
    }
  });

  it('fills checkout variables and refuses variables of the other kind of subject', () => {
    const values = checkoutValues({
      customerName: '  Asha  K ',
      currency: 'INR',
      totalMinor: 149_900,
      items: [
        { title: 'Darjeeling tea (250 g)', quantity: 2 },
        { title: 'Kettle', quantity: 1 },
      ],
      recoveryUrl: 'https://tara.example/checkouts/1/recover?key=k1',
      storeName: 'Tara Tea',
    });
    expect(values).toEqual({
      customer_name: 'Asha K',
      cart_total: '₹1,499.00',
      cart_items: 'Darjeeling tea (250 g) and 1 more',
      checkout_url: 'https://tara.example/checkouts/1/recover?key=k1',
      store_name: 'Tara Tea',
    });
    const cart = {
      header: [],
      body: [
        { source: 'checkout' as const, field: 'customer_name' as const },
        { source: 'checkout' as const, field: 'checkout_url' as const },
      ],
      buttons: [],
    };
    expect(resolveStoreVariables(cart, { subject: 'checkout', values })).toEqual({
      ok: true,
      params: {
        header: [],
        body: ['Asha K', 'https://tara.example/checkouts/1/recover?key=k1'],
        buttons: [],
      },
    });
    const orderValuesOf = orderValues({
      name: '#1',
      customerName: 'Asha',
      currency: null,
      totalMinor: null,
      items: [],
      statusUrl: null,
      trackingNumber: null,
      trackingCompany: null,
      trackingUrl: null,
      storeName: null,
    });
    expect(resolveStoreVariables(cart, { subject: 'order', values: orderValuesOf })).toEqual({
      ok: false,
      missing: 'body.1',
    });
    expect(variablesFit('cart_reminder', cart)).toBe(true);
    expect(variablesFit('order_placed', cart)).toBe(false);
    expect(
      variablesFit('cart_reminder', {
        header: [],
        body: [{ source: 'order', field: 'order_name' }],
        buttons: [],
      }),
    ).toBe(false);
  });

  it('parses a Shopify checkout, keeping the consent only with the customer’s own number', () => {
    const node = {
      id: 'gid://shopify/AbandonedCheckout/9001',
      name: '#C1001',
      createdAt: '2026-09-27T09:00:00Z',
      updatedAt: '2026-09-27T09:30:00Z',
      completedAt: null,
      abandonedCheckoutUrl: 'https://tara.example/checkouts/9001/recover?key=k',
      totalPriceSet: { shopMoney: { amount: '1499.00', currencyCode: 'INR' } },
      lineItemsQuantity: 3,
      lineItems: {
        nodes: [
          { title: 'Darjeeling tea', variantTitle: '250 g', quantity: 2 },
          { title: 'Kettle', variantTitle: null, quantity: 1 },
        ],
      },
      shippingAddress: { name: 'Address Name', phone: '+919800000001' },
      billingAddress: null,
      customer: {
        id: 'gid://shopify/Customer/77',
        displayName: 'Asha K',
        defaultPhoneNumber: {
          phoneNumber: '+919800000002',
          whatsAppMarketingConsent: {
            state: 'SUBSCRIBED',
            optInLevel: 'CONFIRMED_OPT_IN',
            collectedFrom: 'SHOPIFY',
            updatedAt: '2026-09-20T10:00:00Z',
          },
        },
      },
    };
    expect(parseShopifyCheckout(node)).toEqual({
      externalId: '9001',
      name: '#C1001',
      createdAt: at('2026-09-27T09:00:00Z'),
      updatedAt: at('2026-09-27T09:30:00Z'),
      completedAt: null,
      customerExternalId: '77',
      customerName: 'Asha K',
      phone: '+919800000002',
      consent: {
        state: 'SUBSCRIBED',
        optInLevel: 'CONFIRMED_OPT_IN',
        collectedFrom: 'SHOPIFY',
        updatedAt: at('2026-09-20T10:00:00Z'),
      },
      currency: 'INR',
      totalMinor: 149_900,
      items: [
        { title: 'Darjeeling tea (250 g)', quantity: 2 },
        { title: 'Kettle', quantity: 1 },
      ],
      itemCount: 3,
      recoveryUrl: 'https://tara.example/checkouts/9001/recover?key=k',
    });
    // Without the customer's own number, the address's number is used and no consent kept.
    const withheld = parseShopifyCheckout({
      ...node,
      customer: {
        ...node.customer,
        defaultPhoneNumber: { ...node.customer.defaultPhoneNumber, phoneNumber: null },
      },
    });
    expect(withheld).toMatchObject({ phone: '+919800000001', consent: null });
    // Unknown states are not trusted; an http recovery address is not kept.
    expect(
      parseShopifyCheckout({
        ...node,
        abandonedCheckoutUrl: 'http://tara.example/recover',
        customer: {
          ...node.customer,
          defaultPhoneNumber: {
            phoneNumber: '+919800000002',
            whatsAppMarketingConsent: { state: 'MAYBE', updatedAt: 'nonsense' },
          },
        },
      }),
    ).toMatchObject({
      recoveryUrl: null,
      consent: { state: null, optInLevel: null, collectedFrom: null, updatedAt: null },
    });
    expect(parseShopifyCheckout({ ...node, id: 'gid://shopify/Order/9001' })).toBeNull();
  });

  it('asks for customer access only when a manager requested it', () => {
    // Every authorization asks for shipment updates too (ADR-413, SH-044).
    expect(shopifyScopesFor({ customerAccessRequestedAt: null })).toEqual([
      'read_orders',
      'read_products',
      'read_fulfillments',
    ]);
    expect(shopifyScopesFor({ customerAccessRequestedAt: NOW })).toEqual([
      'read_orders',
      'read_products',
      'read_fulfillments',
      'read_customers',
    ]);
    const url = new URL(
      shopifyAuthorizeUrl('https://tara.myshopify.com', {
        clientId: 'id',
        redirectUri: 'https://app.example/cb',
        state: 's',
        scopes: shopifyScopesFor({ customerAccessRequestedAt: NOW }),
      }),
    );
    expect(url.searchParams.get('scope')).toBe(
      'read_orders,read_products,read_fulfillments,read_customers',
    );
    expect(hasCustomerAccess('read_orders, read_products,read_customers')).toBe(true);
    expect(hasCustomerAccess('read_orders,read_products,read_customers_extra')).toBe(false);
    expect(hasCustomerAccess(null)).toBe(false);
    expect(shopifyConsentSupported('2026-07')).toBe(true);
    expect(shopifyConsentSupported('2026-10')).toBe(true);
    expect(shopifyConsentSupported('2025-10')).toBe(false);
    expect(shopifyConsentSupported('unstable')).toBe(false);
    expect(shopifyConsentSupported(null)).toBe(false);
  });
});
