import type { ShopifyConfig } from '@w360/core';
import type { EgressClient } from '@w360/core/egress';
import { isCurrency } from '../crm/money';
import { StoreApiError, asRecord, expectOk, storeRequest } from './http';
import {
  STORE_LIMITS,
  clip,
  httpsUrl,
  statusWord,
  storeAmountToMinor,
  storeDate,
  storeEmail,
  type StoreOrderItemRecord,
  type StoreOrderRecord,
  type StoreProductRecord,
} from './model';

/**
 * Shopify: the OAuth code exchange and refresh (SH-006, SH-007) and the Admin GraphQL API (SH-009)
 * with a fixed set of operations, written against the 2026-07 schema (SH-013 to SH-022). HyFib
 * reads orders, products and the shop, manages its own webhook subscriptions and can uninstall
 * itself; it never writes store data.
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
export type ShopifyWebhookTopic = (typeof SHOPIFY_WEBHOOK_TOPICS)[number];

/**
 * Deliveries only name what changed (SH-023): `updated_at` keeps Shopify from dropping repeated
 * deliveries as duplicates. Deletions and uninstalls keep Shopify's own small payloads.
 */
export const SHOPIFY_INCLUDE_FIELDS: Partial<Record<ShopifyWebhookTopic, string[]>> = {
  ORDERS_CREATE: ['id', 'admin_graphql_api_id', 'updated_at'],
  ORDERS_UPDATED: ['id', 'admin_graphql_api_id', 'updated_at'],
  PRODUCTS_CREATE: ['id', 'admin_graphql_api_id', 'updated_at'],
  PRODUCTS_UPDATE: ['id', 'admin_graphql_api_id', 'updated_at'],
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
  field: 'orders' | 'products',
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
    items,
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
