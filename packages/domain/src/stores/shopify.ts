import type { ShopifyConfig } from '@w360/core';
import type { EgressClient } from '@w360/core/egress';
import { isCurrency } from '../crm/money';
import { StoreApiError, asRecord, expectOk, storeRequest } from './http';
import {
  STORE_LIMITS,
  clip,
  httpsUrl,
  isCashOnDeliveryName,
  paymentNameList,
  statusWord,
  storeAmountToMinor,
  storeDate,
  storeEmail,
  type StoreCheckoutConsent,
  type StoreCheckoutRecord,
  type StoreOrderItemRecord,
  type StoreOrderRecord,
  type StoreProductRecord,
  type StoreShipmentRecord,
} from './model';

/**
 * Shopify: the OAuth code exchange and refresh (SH-006, SH-007) and the Admin GraphQL API (SH-009)
 * with a fixed set of operations, written against the 2026-07 schema (SH-013 to SH-022). HyFib
 * reads orders, products, checkouts (SH-037 to SH-041) and the shop, manages its own webhook
 * subscriptions and can uninstall itself; it never writes store data.
 */

export type ShopifyAppConfig = Pick<
  ShopifyConfig,
  'clientId' | 'clientSecret' | 'apiVersion' | 'testBaseUrl'
>;

/** `https://<shop>`, or the test stand-in (configuration allows it only for APP_ENV=local|test). */
export const shopOrigin = (config: Pick<ShopifyConfig, 'testBaseUrl'>, shopDomain: string) =>
  config.testBaseUrl ? `${config.testBaseUrl}/${shopDomain}` : `https://${shopDomain}`;

export interface ShopifyTokens {
  accessToken: string;
  scopes: string[];
  expiresInSeconds: number | null;
  refreshToken: string | null;
  refreshExpiresInSeconds: number | null;
}

const positiveInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

function parseTokens(json: unknown): ShopifyTokens {
  const body = asRecord(json);
  const accessToken = body?.access_token;
  if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 4096) {
    throw new StoreApiError('malformed', 'Shopify’s token response had no access token.');
  }
  const refresh = body?.refresh_token;
  return {
    accessToken,
    scopes:
      typeof body?.scope === 'string'
        ? body.scope
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    expiresInSeconds: positiveInt(body?.expires_in),
    refreshToken: typeof refresh === 'string' && refresh && refresh.length <= 4096 ? refresh : null,
    refreshExpiresInSeconds: positiveInt(body?.refresh_token_expires_in),
  };
}

/** Exchanges the callback's code for an expiring offline token (`expiring=1`, SH-006). */
export async function exchangeShopifyCode(
  egress: EgressClient,
  config: ShopifyAppConfig,
  shopDomain: string,
  code: string,
): Promise<ShopifyTokens> {
  const response = await storeRequest(egress, {
    method: 'POST',
    url: `${shopOrigin(config, shopDomain)}/admin/oauth/access_token`,
    body: { client_id: config.clientId, client_secret: config.clientSecret, code, expiring: '1' },
  });
  expectOk(response, 'Exchanging Shopify’s authorization code');
  return parseTokens(response.json);
}

/** Renews an expiring offline token; the answer carries a new refresh token too (SH-007). */
export async function refreshShopifyToken(
  egress: EgressClient,
  config: ShopifyAppConfig,
  shopDomain: string,
  refreshToken: string,
): Promise<ShopifyTokens> {
  const response = await storeRequest(egress, {
    method: 'POST',
    url: `${shopOrigin(config, shopDomain)}/admin/oauth/access_token`,
    body: {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    },
  });
  expectOk(response, 'Refreshing the Shopify access token');
  return parseTokens(response.json);
}

// GraphQL -------------------------------------------------------------------------------------------

const ORDER_FIELDS = `
fragment W360Order on Order {
  id
  name
  createdAt
  processedAt
  updatedAt
  cancelledAt
  closed
  test
  displayFinancialStatus
  displayFulfillmentStatus
  totalPriceSet { shopMoney { amount currencyCode } }
  phone
  email
  shippingAddress { name phone }
  billingAddress { name phone }
  statusPageUrl
  paymentGatewayNames
  fulfillments(first: ${STORE_LIMITS.shopifyFulfillments}) {
    id
    status
    displayStatus
    createdAt
    updatedAt
    deliveredAt
    trackingInfo(first: 1) { company number url }
  }
  lineItems(first: ${STORE_LIMITS.shopifyLineItems}) {
    nodes { name sku quantity discountedTotalSet { shopMoney { amount currencyCode } } }
    pageInfo { hasNextPage }
  }
}`;

const PRODUCT_FIELDS = `
fragment W360Product on Product {
  id
  title
  status
  updatedAt
  onlineStoreUrl
  totalInventory
  tracksInventory
  variantsCount { count }
  priceRangeV2 {
    minVariantPrice { amount currencyCode }
    maxVariantPrice { amount currencyCode }
  }
  variants(first: 1) { nodes { sku } }
}`;

/**
 * A checkout customers left (SH-039): the number comes from the addresses (protected `phone`,
 * SH-040), and with customer access from the customer, with the WhatsApp consent Shopify records
 * for it (SH-041, `read_customers`, 2026-07 and later).
 */
const CHECKOUT_FIELDS = `
fragment W360Checkout on AbandonedCheckout {
  id
  name
  createdAt
  updatedAt
  completedAt
  abandonedCheckoutUrl
  totalPriceSet { shopMoney { amount currencyCode } }
  lineItemsQuantity
  lineItems(first: ${STORE_LIMITS.checkoutItems}) { nodes { title variantTitle quantity } }
  shippingAddress { name phone }
  billingAddress { name phone }
}`;

const CHECKOUT_CUSTOMER_FIELDS = `
fragment W360CheckoutCustomer on AbandonedCheckout {
  customer {
    id
    displayName
    defaultPhoneNumber {
      phoneNumber
      whatsAppMarketingConsent { state optInLevel collectedFrom updatedAt }
    }
  }
}`;

export const SHOPIFY_OPERATIONS = {
  shop: `query W360Shop { shop { id name myshopifyDomain currencyCode } }`,
  orders: `query W360Orders($query: String!, $after: String) {
  orders(first: ${STORE_LIMITS.shopifyOrdersPage}, after: $after, query: $query, sortKey: UPDATED_AT) {
    nodes { ...W360Order }
    pageInfo { hasNextPage endCursor }
  }
}
${ORDER_FIELDS}`,
  orderNodes: `query W360OrderNodes($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Order { ...W360Order } }
}
${ORDER_FIELDS}`,
  products: `query W360Products($query: String!, $after: String) {
  products(first: ${STORE_LIMITS.shopifyProductsPage}, after: $after, query: $query, sortKey: UPDATED_AT) {
    nodes { ...W360Product }
    pageInfo { hasNextPage endCursor }
  }
}
${PRODUCT_FIELDS}`,
  productNodes: `query W360ProductNodes($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Product { ...W360Product } }
}
${PRODUCT_FIELDS}`,
  webhooks: `query W360Webhooks($uri: String!) {
  webhookSubscriptions(first: 50, uri: $uri) { nodes { id topic } }
}`,
  createWebhook: `mutation W360WebhookCreate($topic: WebhookSubscriptionTopic!, $input: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $input) {
    webhookSubscription { id topic }
    userErrors { field message }
  }
}`,
  uninstall: `mutation W360Uninstall {
  appUninstall { app { id } userErrors { field message code } }
}`,
  checkouts: `query W360Checkouts($query: String!, $after: String) {
  abandonedCheckouts(first: ${STORE_LIMITS.shopifyCheckoutsPage}, after: $after, query: $query) {
    nodes { ...W360Checkout }
    pageInfo { hasNextPage endCursor }
  }
}
${CHECKOUT_FIELDS}`,
} as const;

/** Checkouts with their customers: needs customer access and API version 2026-07 or later. */
export const SHOPIFY_CUSTOMER_OPERATIONS = {
  checkoutsWithCustomers: `query W360CheckoutsWithCustomers($query: String!, $after: String) {
  abandonedCheckouts(first: ${STORE_LIMITS.shopifyCheckoutsPage}, after: $after, query: $query) {
    nodes { ...W360Checkout ...W360CheckoutCustomer }
    pageInfo { hasNextPage endCursor }
  }
}
${CHECKOUT_FIELDS}
${CHECKOUT_CUSTOMER_FIELDS}`,
} as const;

/** The webhook topics HyFib subscribes to (SH-022); compliance topics are set on the app itself. */
export const SHOPIFY_WEBHOOK_TOPICS = [
  'ORDERS_CREATE',
  'ORDERS_UPDATED',
  'ORDERS_DELETE',
  'PRODUCTS_CREATE',
  'PRODUCTS_UPDATE',
  'PRODUCTS_DELETE',
  'APP_UNINSTALLED',
] as const;

/**
 * Shipment webhooks (ADR-413, SH-044): subscribed only while the store's token was granted
 * `read_fulfillments` (or `read_marketplace_orders`). A delivery only asks HyFib to read the
 * fulfillment's order again, like an order webhook.
 */
export const SHOPIFY_SHIPMENT_TOPICS = ['FULFILLMENTS_CREATE', 'FULFILLMENTS_UPDATE'] as const;
export type ShopifyWebhookTopic =
  (typeof SHOPIFY_WEBHOOK_TOPICS)[number] | (typeof SHOPIFY_SHIPMENT_TOPICS)[number];

/**
 * Deliveries only name what changed (SH-023): `updated_at` keeps Shopify from dropping repeated
 * deliveries as duplicates. Deletions and uninstalls keep Shopify's own small payloads. A
 * fulfillment delivery keeps its own id, its order's id and its update time: the fields of the REST
 * Fulfillment resource (SH-048); that a delivery's body is that resource is unconfirmed.
 */
export const SHOPIFY_INCLUDE_FIELDS: Partial<Record<ShopifyWebhookTopic, string[]>> = {
  ORDERS_CREATE: ['id', 'admin_graphql_api_id', 'updated_at'],
  ORDERS_UPDATED: ['id', 'admin_graphql_api_id', 'updated_at'],
  PRODUCTS_CREATE: ['id', 'admin_graphql_api_id', 'updated_at'],
  PRODUCTS_UPDATE: ['id', 'admin_graphql_api_id', 'updated_at'],
  FULFILLMENTS_CREATE: ['id', 'order_id', 'updated_at'],
  FULFILLMENTS_UPDATE: ['id', 'order_id', 'updated_at'],
};

const GID_RE = /^gid:\/\/shopify\/([A-Za-z]+)\/([0-9]{1,20})$/;

/** The numeric id in a Shopify global id of the given type (gid://shopify/Order/123 → "123"). */
export function gidNumber(gid: unknown, type: string): string | null {
  if (typeof gid !== 'string') return null;
  const match = GID_RE.exec(gid);
  return match && match[1] === type ? (match[2] as string) : null;
}

export const shopifyGid = (type: 'Order' | 'Product', id: string) => `gid://shopify/${type}/${id}`;

export interface ShopifyThrottle {
  requested: number;
  available: number;
  restoreRate: number;
}

function parseThrottle(extensions: unknown): ShopifyThrottle | null {
  const cost = asRecord(asRecord(extensions)?.cost);
  const status = asRecord(cost?.throttleStatus);
  const requested = cost?.requestedQueryCost;
  const available = status?.currentlyAvailable;
  const restoreRate = status?.restoreRate;
  if (
    typeof requested !== 'number' ||
    typeof available !== 'number' ||
    typeof restoreRate !== 'number' ||
    restoreRate <= 0
  ) {
    return null;
  }
  return { requested, available, restoreRate };
}

/** Seconds until the bucket holds `needed` points again (SH-011), between 1 and 60. */
export function throttleWaitSeconds(throttle: ShopifyThrottle | null, needed: number): number {
  if (!throttle) return 30;
  const missing = Math.max(0, needed - throttle.available);
  return Math.min(60, Math.max(1, Math.ceil(missing / throttle.restoreRate) + 1));
}

export interface ShopifyQueryResult {
  data: Record<string, unknown>;
  throttle: ShopifyThrottle | null;
  /**
   * Shopify answered but withheld some fields (ACCESS_DENIED on protected customer data, SH-020):
   * those values are null and the rest is used.
   */
  withheld: boolean;
}

export interface Page<T> {
  items: T[];
  hasNext: boolean;
  endCursor: string | null;
  throttle: ShopifyThrottle | null;
  withheld: boolean;
}

/** Shopify's search syntax needs seconds, not milliseconds (SH-016). */
const searchTime = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

export class ShopifyAdmin {
  private readonly url: string;

  constructor(
    private readonly egress: EgressClient,
    config: ShopifyAppConfig,
    shopDomain: string,
    private readonly accessToken: string,
  ) {
    this.url = `${shopOrigin(config, shopDomain)}/admin/api/${config.apiVersion}/graphql.json`;
  }

  async query(query: string, variables: Record<string, unknown> = {}): Promise<ShopifyQueryResult> {
    const response = await storeRequest(this.egress, {
      method: 'POST',
      url: this.url,
      headers: { 'x-shopify-access-token': this.accessToken },
      body: { query, variables },
    });
    expectOk(response, 'The Shopify request');
    const body = asRecord(response.json);
    if (!body) throw new StoreApiError('malformed', 'Shopify’s answer was not JSON.');
    const throttle = parseThrottle(body.extensions);
    const errors = Array.isArray(body.errors) ? body.errors.map((e) => asRecord(e) ?? {}) : [];
    const data = asRecord(body.data);
    if (errors.length > 0) {
      const codes = errors.map((e) => asRecord(e.extensions)?.code);
      const message =
        typeof errors[0]?.message === 'string' ? errors[0].message.slice(0, 200) : 'unknown error';
      if (codes.includes('THROTTLED')) {
        throw new StoreApiError(
          'throttled',
          'Shopify asked HyFib to slow down.',
          null,
          throttleWaitSeconds(throttle, throttle?.requested ?? 0),
        );
      }
      const allDenied = codes.every((code) => code === 'ACCESS_DENIED');
      if (allDenied && data) return { data, throttle, withheld: true };
      if (allDenied) {
        throw new StoreApiError('unauthorized', `Shopify denied access: ${message}`);
      }
      throw new StoreApiError('rejected', `Shopify refused the request: ${message}`);
    }
    if (!data) throw new StoreApiError('malformed', 'Shopify’s answer had no data.');
    return { data, throttle, withheld: false };
  }

  async shop(): Promise<{
    id: string;
    name: string | null;
    domain: string;
    currency: string | null;
  }> {
    const { data } = await this.query(SHOPIFY_OPERATIONS.shop);
    const shop = asRecord(data.shop);
    const id = gidNumber(shop?.id, 'Shop');
    const domain =
      typeof shop?.myshopifyDomain === 'string' ? shop.myshopifyDomain.toLowerCase() : '';
    if (!id || !domain)
      throw new StoreApiError('malformed', 'Shopify’s shop details were incomplete.');
    const currency =
      typeof shop?.currencyCode === 'string' && isCurrency(shop.currencyCode)
        ? shop.currencyCode
        : null;
    return { id, name: clip(shop?.name, 200), domain, currency };
  }

  /** Orders updated at or after `since`, oldest first (SH-016). */
  async ordersPage(since: Date, after: string | null): Promise<Page<StoreOrderRecord>> {
    const result = await this.query(SHOPIFY_OPERATIONS.orders, {
      query: `updated_at:>='${searchTime(since)}'`,
      after,
    });
    return page(result, 'orders', parseShopifyOrder);
  }

  /**
   * Checkouts updated at or after `since` (SH-038); Shopify cannot sort them by update time, so a
   * read pages through all of them. `withCustomers` adds the customer's phone and consent.
   */
  async checkoutsPage(
    since: Date,
    after: string | null,
    withCustomers: boolean,
  ): Promise<Page<StoreCheckoutRecord>> {
    const result = await this.query(
      withCustomers
        ? SHOPIFY_CUSTOMER_OPERATIONS.checkoutsWithCustomers
        : SHOPIFY_OPERATIONS.checkouts,
      { query: `updated_at:>='${searchTime(since)}'`, after },
    );
    return page(result, 'abandonedCheckouts', parseShopifyCheckout);
  }

  async productsPage(since: Date, after: string | null): Promise<Page<StoreProductRecord>> {
    const result = await this.query(SHOPIFY_OPERATIONS.products, {
      query: `updated_at:>='${searchTime(since)}'`,
      after,
    });
    return page(result, 'products', parseShopifyProduct);
  }

  /** Orders by id: an id Shopify no longer returns is simply absent from the map. */
  async ordersById(
    ids: readonly string[],
  ): Promise<{ items: Map<string, StoreOrderRecord>; withheld: boolean }> {
    const result = await this.query(SHOPIFY_OPERATIONS.orderNodes, {
      ids: ids.map((id) => shopifyGid('Order', id)),
    });
    return byId(result, parseShopifyOrder);
  }

  async productsById(
    ids: readonly string[],
  ): Promise<{ items: Map<string, StoreProductRecord>; withheld: boolean }> {
    const result = await this.query(SHOPIFY_OPERATIONS.productNodes, {
      ids: ids.map((id) => shopifyGid('Product', id)),
    });
    return byId(result, parseShopifyProduct);
  }

  /** Topics of the subscriptions this app created for `uri` (SH-021). */
  async webhookTopics(uri: string): Promise<string[]> {
    const { data } = await this.query(SHOPIFY_OPERATIONS.webhooks, { uri });
    const nodes = asRecord(data.webhookSubscriptions)?.nodes;
    return Array.isArray(nodes)
      ? nodes.map((n) => asRecord(n)?.topic).filter((t): t is string => typeof t === 'string')
      : [];
  }

  async createWebhook(topic: ShopifyWebhookTopic, uri: string): Promise<void> {
    const includeFields = SHOPIFY_INCLUDE_FIELDS[topic];
    const { data } = await this.query(SHOPIFY_OPERATIONS.createWebhook, {
      topic,
      input: { uri, format: 'JSON', ...(includeFields ? { includeFields } : {}) },
    });
    const payload = asRecord(data.webhookSubscriptionCreate);
    const errors = Array.isArray(payload?.userErrors) ? payload.userErrors : [];
    if (errors.length > 0) {
      const message = asRecord(errors[0])?.message;
      throw new StoreApiError(
        'rejected',
        `Shopify did not create the ${topic} subscription: ${typeof message === 'string' ? message.slice(0, 200) : 'unknown error'}`,
      );
    }
    // No subscription in the answer (for example withheld with ACCESS_DENIED beside the data):
    // nothing was created, whatever else the answer says.
    if (typeof asRecord(payload?.webhookSubscription)?.id !== 'string') {
      throw new StoreApiError(
        'rejected',
        `Shopify did not create the ${topic} subscription: its answer named no subscription`,
      );
    }
  }

  /** Uninstalls HyFib from the shop (SH-028); an app that is already gone is fine. */
  async uninstall(): Promise<void> {
    const { data } = await this.query(SHOPIFY_OPERATIONS.uninstall);
    const errors = asRecord(data.appUninstall)?.userErrors;
    const list = Array.isArray(errors) ? errors.map((e) => asRecord(e) ?? {}) : [];
    const blocking = list.filter((e) => e.code !== 'APP_NOT_INSTALLED');
    if (blocking.length > 0) {
      const message = blocking[0]?.message;
      throw new StoreApiError(
        'rejected',
        `Shopify did not uninstall HyFib: ${typeof message === 'string' ? message.slice(0, 200) : 'unknown error'}`,
      );
    }
  }
}

function page<T>(
  result: ShopifyQueryResult,
  field: 'orders' | 'products' | 'abandonedCheckouts',
  parse: (node: unknown) => T | null,
): Page<T> {
  const connection = asRecord(result.data[field]);
  const nodes = connection?.nodes;
  const info = asRecord(connection?.pageInfo);
  if (!Array.isArray(nodes) || !info) {
    throw new StoreApiError('malformed', `Shopify’s ${field} answer was incomplete.`);
  }
  return {
    items: nodes.map(parse).filter((item): item is T => item !== null),
    hasNext: info.hasNextPage === true,
    endCursor: typeof info.endCursor === 'string' ? info.endCursor : null,
    throttle: result.throttle,
    withheld: result.withheld,
  };
}

function byId<T extends { externalId: string }>(
  result: ShopifyQueryResult,
  parse: (node: unknown) => T | null,
): { items: Map<string, T>; withheld: boolean } {
  const nodes = result.data.nodes;
  if (!Array.isArray(nodes))
    throw new StoreApiError('malformed', 'Shopify’s answer was incomplete.');
  const items = new Map<string, T>();
  for (const node of nodes) {
    const item = parse(node);
    if (item) items.set(item.externalId, item);
  }
  return { items, withheld: result.withheld };
}

const moneyOf = (set: unknown): { amount: unknown; currency: string | null } => {
  const money = asRecord(asRecord(set)?.shopMoney);
  const currency =
    typeof money?.currencyCode === 'string' && isCurrency(money.currencyCode)
      ? money.currencyCode
      : null;
  return { amount: money?.amount, currency };
};

// Shipments that did not happen (SH-030): `status` uses CANCELLED, `displayStatus` CANCELED.
const FAILED_FULFILLMENT_STATUS = new Set(['CANCELLED', 'ERROR', 'FAILURE']);
const FAILED_FULFILLMENT_DISPLAY = new Set(['CANCELED', 'FAILURE']);

type ShipmentFacts = Pick<
  StoreOrderRecord,
  'shippedAt' | 'deliveredAt' | 'trackingCompany' | 'trackingNumber' | 'trackingUrl' | 'shipments'
>;

/**
 * Each fulfillment Shopify returned with the order (SH-045), at most STORE_LIMITS.shopifyFulfillments:
 * its id, statuses, times and the first of its tracking entries. One without an id or times is
 * left out; a cancelled or failed one is kept, marked `failed`, so a shipment that is cancelled
 * later stops its messages.
 */
export function shopifyShipmentRecords(order: Record<string, unknown>): StoreShipmentRecord[] {
  const list = Array.isArray(order.fulfillments) ? order.fulfillments : [];
  const records: StoreShipmentRecord[] = [];
  for (const raw of list.slice(0, STORE_LIMITS.shopifyFulfillments)) {
    const f = asRecord(raw);
    const externalId = gidNumber(f?.id, 'Fulfillment');
    const createdAt = storeDate(f?.createdAt);
    const updatedAt = storeDate(f?.updatedAt) ?? createdAt;
    if (!f || !externalId || !createdAt || !updatedAt) continue;
    const tracking = asRecord(Array.isArray(f.trackingInfo) ? f.trackingInfo[0] : null);
    records.push({
      externalId,
      status: statusWord(f.status, 30),
      displayStatus: statusWord(f.displayStatus, 30),
      failed:
        FAILED_FULFILLMENT_STATUS.has(String(f.status)) ||
        FAILED_FULFILLMENT_DISPLAY.has(String(f.displayStatus)),
      createdAt,
      updatedAt,
      trackingCompany: clip(tracking?.company, 100),
      trackingNumber: clip(tracking?.number, 100),
      trackingUrl: httpsUrl(tracking?.url),
    });
  }
  return records;
}

/**
 * What an order's shipments say (SH-030): shipped at the first shipment that was not cancelled or
 * failed; delivered once the order is fully shipped and every such shipment is delivered (at the
 * last delivery); the tracking of the latest shipment that has any.
 */
export function shopifyShipments(order: Record<string, unknown>): ShipmentFacts {
  const list = Array.isArray(order.fulfillments) ? order.fulfillments : [];
  const shipments = list
    .map((raw) => asRecord(raw))
    .filter(
      (f): f is Record<string, unknown> =>
        f !== null &&
        !FAILED_FULFILLMENT_STATUS.has(String(f.status)) &&
        !FAILED_FULFILLMENT_DISPLAY.has(String(f.displayStatus)),
    )
    .map((f) => {
      const tracking = asRecord(Array.isArray(f.trackingInfo) ? f.trackingInfo[0] : null);
      const deliveredAt = storeDate(f.deliveredAt);
      return {
        createdAt: storeDate(f.createdAt),
        deliveredAt:
          deliveredAt ?? (f.displayStatus === 'DELIVERED' ? storeDate(f.updatedAt) : null),
        company: clip(tracking?.company, 100),
        number: clip(tracking?.number, 100),
        url: httpsUrl(tracking?.url),
      };
    })
    .filter((f): f is typeof f & { createdAt: Date } => f.createdAt !== null)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const first = shipments[0];
  const delivered =
    order.displayFulfillmentStatus === 'FULFILLED' &&
    shipments.length > 0 &&
    shipments.every((f) => f.deliveredAt !== null);
  const tracked = [...shipments].reverse().find((f) => f.number !== null || f.url !== null);
  return {
    shippedAt: first ? first.createdAt : null,
    deliveredAt: delivered
      ? new Date(Math.max(...shipments.map((f) => (f.deliveredAt as Date).getTime())))
      : null,
    trackingCompany: tracked?.company ?? null,
    trackingNumber: tracked?.number ?? null,
    trackingUrl: tracked?.url ?? null,
    shipments: shopifyShipmentRecords(order),
  };
}

/** A GraphQL Order node as the record HyFib keeps (SH-013, SH-014), or null when unusable. */
export function parseShopifyOrder(node: unknown): StoreOrderRecord | null {
  const order = asRecord(node);
  const externalId = gidNumber(order?.id, 'Order');
  const remoteUpdatedAt = storeDate(order?.updatedAt);
  const placedAt = storeDate(order?.processedAt) ?? storeDate(order?.createdAt);
  if (!order || !externalId || !remoteUpdatedAt || !placedAt) return null;
  const total = moneyOf(order.totalPriceSet);
  const cancelledAt = storeDate(order.cancelledAt);
  const shipping = asRecord(order.shippingAddress);
  const billing = asRecord(order.billingAddress);
  const lineItems = asRecord(order.lineItems);
  const nodes = Array.isArray(lineItems?.nodes) ? lineItems.nodes : [];
  const items: StoreOrderItemRecord[] = [];
  for (const raw of nodes.slice(0, STORE_LIMITS.orderItems)) {
    const line = asRecord(raw);
    if (!line) continue;
    const lineTotal = moneyOf(line.discountedTotalSet);
    const quantity = line.quantity;
    items.push({
      title: clip(line.name, 300) ?? 'Item',
      sku: clip(line.sku, 100),
      quantity:
        typeof quantity === 'number' && Number.isInteger(quantity) && quantity >= 0
          ? Math.min(quantity, 1_000_000)
          : 0,
      totalMinor:
        lineTotal.currency && lineTotal.currency === total.currency
          ? storeAmountToMinor(lineTotal.amount, lineTotal.currency)
          : null,
    });
  }
  const phone = clip(order.phone, 40) ?? clip(shipping?.phone, 40) ?? clip(billing?.phone, 40);
  const paymentNames = paymentNameList(
    Array.isArray(order.paymentGatewayNames) ? order.paymentGatewayNames : [],
  );
  return {
    externalId,
    name: clip(order.name, 100) ?? `#${externalId}`,
    status: cancelledAt ? 'cancelled' : order.closed === true ? 'closed' : 'open',
    financialStatus: statusWord(order.displayFinancialStatus),
    fulfillmentStatus: statusWord(order.displayFulfillmentStatus),
    test: order.test === true,
    currency: total.currency,
    totalMinor: storeAmountToMinor(total.amount, total.currency),
    itemsTruncated:
      asRecord(lineItems?.pageInfo)?.hasNextPage === true || nodes.length > STORE_LIMITS.orderItems,
    placedAt,
    cancelledAt,
    remoteUpdatedAt,
    customerName: clip(shipping?.name, 200) ?? clip(billing?.name, 200),
    customerPhone: phone,
    customerEmail: storeEmail(order.email),
    statusUrl: httpsUrl(order.statusPageUrl),
    paymentNames,
    cashOnDelivery: paymentNames.some(isCashOnDeliveryName),
    ...shopifyShipments(order),
    items,
  };
}

const CONSENT_STATES = new Set([
  'NEVER_SUBSCRIBED',
  'PENDING',
  'REDACTED',
  'SUBSCRIBED',
  'UNSUBSCRIBED',
] as const);
const OPT_IN_LEVELS = new Set(['SINGLE_OPT_IN', 'CONFIRMED_OPT_IN', 'UNKNOWN'] as const);
const COLLECTED_FROM = new Set(['SHOPIFY', 'OTHER'] as const);

function oneOf<T extends string>(set: ReadonlySet<T>, value: unknown): T | null {
  return typeof value === 'string' && (set as ReadonlySet<string>).has(value) ? (value as T) : null;
}

function parseConsent(value: unknown): StoreCheckoutConsent | null {
  const consent = asRecord(value);
  if (!consent) return null;
  return {
    state: oneOf(CONSENT_STATES, consent.state),
    optInLevel: oneOf(OPT_IN_LEVELS, consent.optInLevel),
    collectedFrom: oneOf(COLLECTED_FROM, consent.collectedFrom),
    updatedAt: storeDate(consent.updatedAt),
  };
}

/**
 * A GraphQL AbandonedCheckout node as the record HyFib keeps (SH-039), or null when unusable. The
 * consent is kept only with the customer's own default phone: it says nothing about an address's.
 */
export function parseShopifyCheckout(node: unknown): StoreCheckoutRecord | null {
  const checkout = asRecord(node);
  const externalId = gidNumber(checkout?.id, 'AbandonedCheckout');
  const createdAt = storeDate(checkout?.createdAt);
  const updatedAt = storeDate(checkout?.updatedAt);
  if (!checkout || !externalId || !createdAt || !updatedAt) return null;
  const total = moneyOf(checkout.totalPriceSet);
  const customer = asRecord(checkout.customer);
  const defaultPhone = asRecord(customer?.defaultPhoneNumber);
  const customerPhone = clip(defaultPhone?.phoneNumber, 40);
  const shipping = asRecord(checkout.shippingAddress);
  const billing = asRecord(checkout.billingAddress);
  const lineItems = asRecord(checkout.lineItems);
  const nodes = Array.isArray(lineItems?.nodes) ? lineItems.nodes : [];
  const items: { title: string; quantity: number }[] = [];
  for (const raw of nodes.slice(0, STORE_LIMITS.checkoutItems)) {
    const line = asRecord(raw);
    if (!line) continue;
    const title = clip(line.title, 250);
    const variant = clip(line.variantTitle, 100);
    const quantity = line.quantity;
    items.push({
      title: (title ? (variant ? `${title} (${variant})` : title) : null) ?? 'Item',
      quantity:
        typeof quantity === 'number' && Number.isInteger(quantity) && quantity >= 0
          ? Math.min(quantity, 1_000_000)
          : 0,
    });
  }
  const count = checkout.lineItemsQuantity;
  return {
    externalId,
    name: clip(checkout.name, 100),
    createdAt,
    updatedAt,
    completedAt: storeDate(checkout.completedAt),
    customerExternalId: gidNumber(customer?.id, 'Customer'),
    customerName:
      clip(customer?.displayName, 200) ?? clip(shipping?.name, 200) ?? clip(billing?.name, 200),
    phone: customerPhone ?? clip(shipping?.phone, 40) ?? clip(billing?.phone, 40),
    consent: customerPhone ? parseConsent(defaultPhone?.whatsAppMarketingConsent) : null,
    currency: total.currency,
    totalMinor: storeAmountToMinor(total.amount, total.currency),
    items,
    itemCount:
      typeof count === 'number' && Number.isInteger(count) && count >= 0
        ? Math.min(count, 1_000_000)
        : null,
    recoveryUrl: httpsUrl(checkout.abandonedCheckoutUrl, 2000),
  };
}

/** A GraphQL Product node as the record HyFib keeps (SH-017), or null when unusable. */
export function parseShopifyProduct(node: unknown): StoreProductRecord | null {
  const product = asRecord(node);
  const externalId = gidNumber(product?.id, 'Product');
  const remoteUpdatedAt = storeDate(product?.updatedAt);
  if (!product || !externalId || !remoteUpdatedAt) return null;
  const range = asRecord(product.priceRangeV2);
  const min = asRecord(range?.minVariantPrice);
  const max = asRecord(range?.maxVariantPrice);
  const currency =
    typeof min?.currencyCode === 'string' &&
    isCurrency(min.currencyCode) &&
    min.currencyCode === max?.currencyCode
      ? min.currencyCode
      : null;
  const priceMin = storeAmountToMinor(min?.amount, currency);
  const priceMax = storeAmountToMinor(max?.amount, currency);
  const hasPrices = priceMin !== null && priceMax !== null && priceMin <= priceMax;
  const count = asRecord(product.variantsCount)?.count;
  const variants =
    typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null;
  const firstVariant = asRecord(
    (Array.isArray(asRecord(product.variants)?.nodes)
      ? (asRecord(product.variants)?.nodes as unknown[])
      : [])[0],
  );
  const inventory = product.totalInventory;
  return {
    externalId,
    title: clip(product.title, 300) ?? `Product ${externalId}`,
    status: statusWord(product.status, 30) ?? 'active',
    // A single SKU is shown only for products with one variant.
    sku: variants === 1 ? clip(firstVariant?.sku, 100) : null,
    url: httpsUrl(product.onlineStoreUrl),
    currency: hasPrices ? currency : null,
    priceMinMinor: hasPrices ? priceMin : null,
    priceMaxMinor: hasPrices ? priceMax : null,
    inventory:
      product.tracksInventory === true &&
      typeof inventory === 'number' &&
      Number.isInteger(inventory)
        ? inventory
        : null,
    variants,
    remoteUpdatedAt,
  };
}
