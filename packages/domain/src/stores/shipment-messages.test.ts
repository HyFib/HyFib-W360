import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_EVENTS,
  ORDER_MESSAGE_EVENTS,
  SHIPMENT_DEDUPE_KEY_RE,
  STORE_MESSAGE_EVENTS,
  STORE_MESSAGE_LIMITS,
  canStartAutomation,
  delayRange,
  detectOrderEvents,
  detectShipmentEvents,
  eventAvailable,
  isShipmentEvent,
  nextTrackingKeys,
  variablesFit,
  type EnabledRule,
  type SavedShipmentChange,
  type StoreMessageEvent,
} from './messages-model';
import { hasShipmentAccess, shipmentTrackingKey, shopifyScopesFor } from './model';
import {
  SHOPIFY_INCLUDE_FIELDS,
  SHOPIFY_SHIPMENT_TOPICS,
  SHOPIFY_WEBHOOK_TOPICS,
  parseShopifyOrder,
  shopifyShipmentRecords,
} from './shopify';
import { fulfillmentOrderId } from './webhook';
import { parseWooOrder } from './woocommerce';
import { TRANSIT_EVENTS } from './order-messages';
import { accessShortfall } from './worker';

/** Shipment messages (ADR-413): rules, bounds and parsers, research SH-044 to SH-048. */

const NOW = new Date('2026-10-21T10:00:00Z');
const ENABLED = new Date('2026-10-21T08:00:00Z');
const at = (iso: string) => new Date(iso);

const rules = (...events: StoreMessageEvent[]): EnabledRule[] =>
  events.map((event) => ({ event, enabledAt: ENABLED }));

const shipment = (over: Partial<SavedShipmentChange> = {}): SavedShipmentChange => ({
  shipmentId: 'ship-1',
  orderId: 'order-1',
  isNew: true,
  trackingRevision: null,
  current: {
    createdAt: at('2026-10-21T09:00:00Z'),
    updatedAt: at('2026-10-21T09:30:00Z'),
    failed: false,
  },
  test: false,
  orderCancelled: false,
  ...over,
});

const detect = (change: SavedShipmentChange, enabled: EnabledRule[], includeTestOrders = false) =>
  detectShipmentEvents({ change, rules: enabled, includeTestOrders, now: NOW });

describe('shipment events', () => {
  it('are two new events, Shopify only, that may start automations and wait up to a day', () => {
    expect(STORE_MESSAGE_EVENTS).toContain('shipment_created');
    expect(STORE_MESSAGE_EVENTS).toContain('tracking_updated');
    for (const event of ['shipment_created', 'tracking_updated'] as const) {
      expect(isShipmentEvent(event)).toBe(true);
      expect(eventAvailable('shopify', event)).toBe(true);
      expect(eventAvailable('woocommerce', event)).toBe(false);
      expect(canStartAutomation(event)).toBe(true);
      expect(delayRange(event)).toEqual({ min: 0, max: 1440 });
      // The order's fields (with the shipment's tracking) fill their variables, not a checkout's.
      expect(
        variablesFit(event, {
          header: [],
          body: [{ source: 'order', field: 'tracking_number' }],
          buttons: [],
        }),
      ).toBe(true);
      expect(
        variablesFit(event, {
          header: [],
          body: [{ source: 'checkout', field: 'checkout_url' }],
          buttons: [],
        }),
      ).toBe(false);
    }
    expect(isShipmentEvent('order_shipped')).toBe(false);
    expect(AUTOMATION_EVENTS).toEqual([
      'order_placed',
      'order_shipped',
      'order_delivered',
      'order_cancelled',
      'shipment_created',
      'tracking_updated',
    ]);
    // Outgoing webhooks keep reporting the five order events only.
    expect(ORDER_MESSAGE_EVENTS).not.toContain('shipment_created');
    expect(ORDER_MESSAGE_EVENTS).not.toContain('tracking_updated');
    // Orders in transit are read again while a delivered or shipment rule is on.
    expect(TRANSIT_EVENTS).toEqual(['order_delivered', 'shipment_created', 'tracking_updated']);
  });

  it('send a shipment seen for the first time, once, dated when it was created', () => {
    expect(detect(shipment(), rules('shipment_created'))).toEqual([
      {
        event: 'shipment_created',
        occurredAt: at('2026-10-21T09:00:00Z'),
        dedupeKey: 'created',
        skip: null,
      },
    ]);
    // Seen before: no second message, whatever else changed.
    expect(detect(shipment({ isNew: false }), rules('shipment_created'))).toEqual([]);
    // A new shipment's tracking is part of its first message, not a tracking update.
    expect(detect(shipment({ trackingRevision: 1 }), rules('tracking_updated'))).toEqual([]);
    // No rule on, nothing.
    expect(detect(shipment(), [])).toEqual([]);
    expect(detect(shipment(), rules('order_shipped', 'order_delivered'))).toEqual([]);
  });

  it('update a tracking not seen for the shipment before, dated by its last change', () => {
    expect(
      detect(shipment({ isNew: false, trackingRevision: 2 }), rules('tracking_updated')),
    ).toEqual([
      {
        event: 'tracking_updated',
        occurredAt: at('2026-10-21T09:30:00Z'),
        dedupeKey: 'tracking:2',
        skip: null,
      },
    ]);
    expect(detect(shipment({ isNew: false }), rules('tracking_updated'))).toEqual([]);
    expect(
      detect(
        shipment({ isNew: false, trackingRevision: 1 }),
        rules('shipment_created', 'tracking_updated'),
      ).map((e) => e.dedupeKey),
    ).toEqual(['tracking:1']);
  });

  it('send nothing about a cancelled or failed shipment, or a cancelled order', () => {
    const failed = shipment({
      current: { ...shipment().current, failed: true },
    });
    expect(detect(failed, rules('shipment_created'))).toEqual([]);
    expect(
      detect({ ...failed, isNew: false, trackingRevision: 1 }, rules('tracking_updated')),
    ).toEqual([]);
    expect(detect(shipment({ orderCancelled: true }), rules('shipment_created'))).toEqual([]);
    expect(
      detect(
        shipment({ isNew: false, trackingRevision: 1, orderCancelled: true }),
        rules('tracking_updated'),
      ),
    ).toEqual([]);
  });

  it('never message about what happened before the rule was switched on (from its second)', () => {
    const before = shipment({
      current: {
        createdAt: new Date(ENABLED.getTime() - 1000),
        updatedAt: new Date(ENABLED.getTime() - 1),
        failed: false,
      },
    });
    expect(detect(before, rules('shipment_created'))).toEqual([]);
    expect(
      detect({ ...before, isNew: false, trackingRevision: 1 }, rules('tracking_updated')),
    ).toEqual([]);
    const exactly = shipment({
      current: { createdAt: ENABLED, updatedAt: ENABLED, failed: false },
    });
    expect(detect(exactly, rules('shipment_created'))).toHaveLength(1);
    expect(
      detect({ ...exactly, isNew: false, trackingRevision: 1 }, rules('tracking_updated')),
    ).toHaveLength(1);
  });

  it('record test orders and events seen over 48 hours late as skipped', () => {
    expect(detect(shipment({ test: true }), rules('shipment_created'))[0]?.skip).toBe('test_order');
    expect(detect(shipment({ test: true }), rules('shipment_created'), true)[0]?.skip).toBeNull();
    const old = new Date(NOW.getTime() - STORE_MESSAGE_LIMITS.latenessHours * 3_600_000);
    const enabledLongAgo: EnabledRule[] = [
      { event: 'shipment_created', enabledAt: at('2026-10-01T00:00:00Z') },
      { event: 'tracking_updated', enabledAt: at('2026-10-01T00:00:00Z') },
    ];
    const edge = shipment({ current: { createdAt: old, updatedAt: old, failed: false } });
    expect(detect(edge, enabledLongAgo)[0]?.skip).toBeNull();
    const late = shipment({
      current: {
        createdAt: new Date(old.getTime() - 1),
        updatedAt: new Date(old.getTime() - 1),
        failed: false,
      },
    });
    expect(detect(late, enabledLongAgo)[0]?.skip).toBe('too_late');
    expect(detect({ ...late, isNew: false, trackingRevision: 3 }, enabledLongAgo)).toEqual([
      expect.objectContaining({ event: 'tracking_updated', skip: 'too_late' }),
    ]);
  });

  it('are not order events', () => {
    const milestones = {
      placedAt: at('2026-10-21T09:00:00Z'),
      cancelled: false,
      cancelledAt: null,
      shippedAt: at('2026-10-21T09:10:00Z'),
      deliveredAt: null,
      cashOnDelivery: false,
      test: false,
    };
    expect(
      detectOrderEvents({
        previous: null,
        current: milestones,
        rules: rules('shipment_created', 'tracking_updated'),
        includeTestOrders: false,
        now: NOW,
      }),
    ).toEqual([]);
  });
});

describe('tracking changes', () => {
  const A = shipmentTrackingKey('1Z999', 'https://track.example/1Z999') as string;
  const B = shipmentTrackingKey('1Z888', 'https://track.example/1Z888') as string;

  it('identify a tracking by its number and link, never by the carrier', () => {
    expect(shipmentTrackingKey(null, null)).toBeNull();
    expect(shipmentTrackingKey('', '  ')).toBeNull();
    expect(A).toMatch(/^[0-9a-f]{64}$/);
    // The number ignores case and repeated spaces; a different number or link is a change.
    expect(shipmentTrackingKey(' 1z  999 ', 'https://track.example/1Z999')).toBe(
      shipmentTrackingKey('1Z 999', 'https://track.example/1Z999'),
    );
    expect(shipmentTrackingKey('1Z999', null)).not.toBe(A);
    expect(shipmentTrackingKey(null, 'https://track.example/1Z999')).not.toBe(A);
    expect(shipmentTrackingKey('1Z999', 'https://track.example/other')).not.toBe(A);
    // Number and link cannot be shifted into each other.
    expect(shipmentTrackingKey('a', null)).not.toBe(shipmentTrackingKey(null, 'a'));
  });

  it('remember a first-seen tracking without counting it, then number each new one', () => {
    expect(nextTrackingKeys(null, A)).toEqual({ keys: [A], revision: null });
    expect(nextTrackingKeys(null, null)).toEqual({ keys: [], revision: null });
    expect(nextTrackingKeys([], A)).toEqual({ keys: [A], revision: 1 });
    expect(nextTrackingKeys([A], B)).toEqual({ keys: [A, B], revision: 2 });
    // The same tracking again, or back to one seen before, is no change.
    expect(nextTrackingKeys([A], A)).toEqual({ keys: [A], revision: null });
    expect(nextTrackingKeys([A, B], A)).toEqual({ keys: [A, B], revision: null });
    // Tracking removed: nothing to send, and what was seen is kept.
    expect(nextTrackingKeys([A, B], null)).toEqual({ keys: [A, B], revision: null });
  });

  it('remember at most ten trackings per shipment; one more changes nothing', () => {
    const keys = Array.from(
      { length: STORE_MESSAGE_LIMITS.trackingKeysPerShipment - 1 },
      (_, i) => shipmentTrackingKey(`N${i}`, null) as string,
    );
    const tenth = nextTrackingKeys(keys, A);
    expect(tenth.revision).toBe(10);
    expect(tenth.keys).toHaveLength(10);
    expect(nextTrackingKeys(tenth.keys, B)).toEqual({ keys: tenth.keys, revision: null });
    expect(STORE_MESSAGE_LIMITS.trackingKeysPerShipment).toBe(10);
  });

  it('name each message of a shipment with a key the database accepts', () => {
    expect(SHIPMENT_DEDUPE_KEY_RE.test('created')).toBe(true);
    expect(SHIPMENT_DEDUPE_KEY_RE.test('tracking:1')).toBe(true);
    expect(SHIPMENT_DEDUPE_KEY_RE.test('tracking:10')).toBe(true);
    expect(SHIPMENT_DEDUPE_KEY_RE.test('tracking:0')).toBe(false);
    expect(SHIPMENT_DEDUPE_KEY_RE.test('tracking:100')).toBe(false);
    expect(SHIPMENT_DEDUPE_KEY_RE.test('tracking:')).toBe(false);
  });
});

describe('Shopify shipments', () => {
  const fulfillment = (over: Record<string, unknown> = {}) => ({
    id: 'gid://shopify/Fulfillment/7001',
    status: 'SUCCESS',
    displayStatus: 'IN_TRANSIT',
    createdAt: '2026-10-21T09:00:00Z',
    updatedAt: '2026-10-21T09:30:00Z',
    deliveredAt: null,
    trackingInfo: [
      { company: ' Blue  Dart ', number: 'BD123', url: 'https://bluedart.example/BD123' },
      { company: 'Other', number: 'X2', url: 'https://other.example/X2' },
    ],
    ...over,
  });

  it('keep each fulfillment with its id, statuses, times and first tracking (SH-045)', () => {
    expect(shopifyShipmentRecords({ fulfillments: [fulfillment()] })).toEqual([
      {
        externalId: '7001',
        status: 'success',
        displayStatus: 'in_transit',
        failed: false,
        createdAt: at('2026-10-21T09:00:00Z'),
        updatedAt: at('2026-10-21T09:30:00Z'),
        trackingCompany: 'Blue Dart',
        trackingNumber: 'BD123',
        trackingUrl: 'https://bluedart.example/BD123',
      },
    ]);
  });

  it('mark cancelled and failed fulfillments, and keep only https links', () => {
    const [cancelled, failed, canceled, plain] = shopifyShipmentRecords({
      fulfillments: [
        fulfillment({ id: 'gid://shopify/Fulfillment/1', status: 'CANCELLED' }),
        fulfillment({ id: 'gid://shopify/Fulfillment/2', status: 'ERROR' }),
        fulfillment({ id: 'gid://shopify/Fulfillment/3', displayStatus: 'CANCELED' }),
        fulfillment({
          id: 'gid://shopify/Fulfillment/4',
          trackingInfo: [{ company: null, number: null, url: 'http://insecure.example/x' }],
        }),
      ],
    });
    expect([cancelled?.failed, failed?.failed, canceled?.failed, plain?.failed]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(plain).toMatchObject({ trackingCompany: null, trackingNumber: null, trackingUrl: null });
  });

  it('leave out fulfillments without an id or times, and read at most ten', () => {
    expect(
      shopifyShipmentRecords({
        fulfillments: [
          fulfillment({ id: null }),
          fulfillment({ id: 'gid://shopify/Order/7001' }),
          fulfillment({ id: 'gid://shopify/Fulfillment/5', createdAt: 'yesterday' }),
          fulfillment({ id: 'gid://shopify/Fulfillment/6', updatedAt: null }),
          'not an object',
        ],
      }).map((s) => [s.externalId, s.updatedAt.toISOString()]),
    ).toEqual([['6', '2026-10-21T09:00:00.000Z']]);
    const many = Array.from({ length: 12 }, (_, i) =>
      fulfillment({ id: `gid://shopify/Fulfillment/${100 + i}` }),
    );
    expect(shopifyShipmentRecords({ fulfillments: many })).toHaveLength(10);
    expect(shopifyShipmentRecords({})).toEqual([]);
  });

  it('come with every Shopify order, and never with a WooCommerce one', () => {
    const order = parseShopifyOrder({
      id: 'gid://shopify/Order/9001',
      name: '#1001',
      createdAt: '2026-10-21T08:00:00Z',
      processedAt: '2026-10-21T08:00:00Z',
      updatedAt: '2026-10-21T09:30:00Z',
      displayFulfillmentStatus: 'PARTIALLY_FULFILLED',
      fulfillments: [fulfillment()],
      lineItems: { nodes: [], pageInfo: { hasNextPage: false } },
    });
    expect(order?.shipments.map((s) => s.externalId)).toEqual(['7001']);
    const woo = parseWooOrder(
      {
        id: 51,
        number: '51',
        status: 'completed',
        currency: 'INR',
        total: '10.00',
        date_created_gmt: '2026-10-21T08:00:00',
        date_modified_gmt: '2026-10-21T09:00:00',
        date_completed_gmt: '2026-10-21T09:00:00',
        billing: {},
        line_items: [],
      },
      'INR',
    );
    expect(woo?.shipments).toEqual([]);
  });
});

describe('shipment webhooks', () => {
  it('are subscribed only with read_fulfillments or read_marketplace_orders (SH-044)', () => {
    expect(SHOPIFY_SHIPMENT_TOPICS).toEqual(['FULFILLMENTS_CREATE', 'FULFILLMENTS_UPDATE']);
    expect(SHOPIFY_WEBHOOK_TOPICS).not.toContain('FULFILLMENTS_CREATE');
    expect(hasShipmentAccess('read_orders,read_products,read_fulfillments')).toBe(true);
    expect(hasShipmentAccess('read_orders, read_marketplace_orders')).toBe(true);
    expect(hasShipmentAccess('read_orders,read_products')).toBe(false);
    expect(hasShipmentAccess('read_orders,read_fulfillments_extra')).toBe(false);
    expect(hasShipmentAccess(null)).toBe(false);
    expect(shopifyScopesFor({ customerAccessRequestedAt: null })).toContain('read_fulfillments');
  });

  it('keep only the fulfillment, its order and its update time (SH-023, SH-048)', () => {
    expect(SHOPIFY_INCLUDE_FIELDS.FULFILLMENTS_CREATE).toEqual(['id', 'order_id', 'updated_at']);
    expect(SHOPIFY_INCLUDE_FIELDS.FULFILLMENTS_UPDATE).toEqual(['id', 'order_id', 'updated_at']);
  });

  it('name the order to read by the body’s order_id only', () => {
    expect(fulfillmentOrderId({ order_id: 820982911946154500 })).toBeNull();
    expect(fulfillmentOrderId({ order_id: 450789469 })).toBe('450789469');
    expect(fulfillmentOrderId({ order_id: '450789469' })).toBe('450789469');
    for (const bad of [0, -1, 1.5, '12a', '', '123456789012345678901', null, undefined, {}]) {
      expect(fulfillmentOrderId({ order_id: bad }), String(bad)).toBeNull();
    }
    // The fulfillment's own id is never taken for the order's.
    expect(
      fulfillmentOrderId({ id: 255858046, admin_graphql_api_id: 'gid://shopify/Order/1' }),
    ).toBeNull();
  });

  it('say what an approval for more access did not grant', () => {
    const granted = ['read_orders', 'read_products', 'read_fulfillments'];
    expect(accessShortfall({ customerAccessRequestedAt: null }, granted)).toBeNull();
    expect(accessShortfall({ customerAccessRequestedAt: NOW }, granted)).toBe(
      'Shopify did not grant access to customers. The store keeps working without it.',
    );
    expect(
      accessShortfall({ customerAccessRequestedAt: NOW }, [...granted, 'read_customers']),
    ).toBeNull();
    expect(accessShortfall({ customerAccessRequestedAt: null }, ['read_orders'])).toMatch(
      /^Shopify did not grant access to shipment updates \(read_fulfillments\)/,
    );
    expect(accessShortfall({ customerAccessRequestedAt: NOW }, ['read_orders'])).toMatch(
      /customers\. .*shipment updates/,
    );
  });
});
