import type { EgressClient } from '@w360/core/egress';
import { isCurrency } from '../crm/money';
import { StoreApiError, asRecord, expectOk, storeRequest, type StoreResponse } from './http';
import {
  EXTERNAL_ID_RE,
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
 * WooCommerce REST API v3 with the store's Read/Write keys (WC-001 to WC-011), over https with HTTP
 * Basic authentication only: keys never go into URLs (the query-string fallback is not used). HyFib
 * reads orders, products and the store currency and manages its own webhooks; nothing else is
 * written to the store.
 */

export const WOO_WEBHOOK_TOPICS = [
  'order.created',
  'order.updated',
  'order.deleted',
  'order.restored',
  'product.created',
  'product.updated',
  'product.deleted',
  'product.restored',
] as const;
export type WooWebhookTopic = (typeof WOO_WEBHOOK_TOPICS)[number];

export interface WooKeys {
  consumerKey: string;
  consumerSecret: string;
}

export interface WooWebhook {
  id: string;
  topic: string;
  status: string;
  deliveryUrl: string;
}

export interface WooPage<T> {
  items: T[];
  hasNext: boolean;
}

/** WordPress accepts dates without milliseconds (the `*_gmt` filters with dates_are_gmt, WC-007). */
const wooTime = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

export class WooStore {
  private readonly authorization: string;

  constructor(
    private readonly egress: EgressClient,
    private readonly storeUrl: string,
    keys: WooKeys,
  ) {
    this.authorization = `Basic ${Buffer.from(`${keys.consumerKey}:${keys.consumerSecret}`).toString('base64')}`;
  }

  private async call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    query: Record<string, string> = {},
    body?: unknown,
  ): Promise<StoreResponse> {
    const search = new URLSearchParams(query).toString();
    return storeRequest(this.egress, {
      method,
      url: `${this.storeUrl}/wp-json/wc/v3${path}${search ? `?${search}` : ''}`,
      headers: { authorization: this.authorization },
      body,
    });
  }

  /** The store's currency (WC-010); also proves the keys can read. */
  async currency(): Promise<string | null> {
    const response = await this.call('GET', '/settings/general/woocommerce_currency');
    if (response.status === 404) {
      throw new StoreApiError(
        'not_found',
        'No WooCommerce REST API answered at this address (/wp-json/wc/v3). Check the address and that the site uses pretty permalinks.',
        404,
      );
    }
    expectOk(response, 'Reading the store currency');
    const value = asRecord(response.json)?.value;
    if (response.json === null) {
      throw new StoreApiError('malformed', 'The store did not answer with JSON.');
    }
    return typeof value === 'string' && isCurrency(value) ? value : null;
  }

  async ordersPage(
    since: Date,
    page: number,
    currency: string | null,
  ): Promise<WooPage<StoreOrderRecord>> {
    const response = await this.call('GET', '/orders', {
      modified_after: wooTime(since),
      dates_are_gmt: 'true',
      orderby: 'modified',
      order: 'asc',
      per_page: String(STORE_LIMITS.wooOrdersPage),
      page: String(page),
    });
    expectOk(response, 'Reading orders');
    return listPage(response, page, (raw) => parseWooOrder(raw, currency));
  }

  async productsPage(
    since: Date,
    page: number,
    currency: string | null,
  ): Promise<WooPage<StoreProductRecord>> {
    const response = await this.call('GET', '/products', {
      modified_after: wooTime(since),
      dates_are_gmt: 'true',
      orderby: 'modified',
      order: 'asc',
      status: 'any',
      per_page: String(STORE_LIMITS.wooProductsPage),
      page: String(page),
    });
    expectOk(response, 'Reading products');
    return listPage(response, page, (raw) => parseWooProduct(raw, currency));
  }

  async ordersById(
    ids: readonly string[],
    currency: string | null,
  ): Promise<Map<string, StoreOrderRecord>> {
    const response = await this.call('GET', '/orders', {
      include: ids.join(','),
      per_page: String(Math.min(100, ids.length)),
    });
    expectOk(response, 'Reading orders');
    return byId(response, (raw) => parseWooOrder(raw, currency));
  }

  async productsById(
    ids: readonly string[],
    currency: string | null,
  ): Promise<Map<string, StoreProductRecord>> {
    const response = await this.call('GET', '/products', {
      include: ids.join(','),
      status: 'any',
      per_page: String(Math.min(100, ids.length)),
    });
    expectOk(response, 'Reading products');
    return byId(response, (raw) => parseWooProduct(raw, currency));
  }

  /** The store's webhooks (at most 300), to find HyFib's own by delivery address. */
  async webhooks(): Promise<WooWebhook[]> {
    const all: WooWebhook[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const response = await this.call('GET', '/webhooks', {
        per_page: '100',
        page: String(page),
      });
      expectOk(response, 'Listing webhooks');
      const list = Array.isArray(response.json) ? response.json : null;
      if (!list) throw new StoreApiError('malformed', 'The store’s webhook list was not a list.');
      for (const raw of list) {
        const hook = asRecord(raw);
        const id = hook?.id;
        if (
          typeof id === 'number' &&
          Number.isInteger(id) &&
          typeof hook?.topic === 'string' &&
          typeof hook.delivery_url === 'string'
        ) {
          all.push({
            id: String(id),
            topic: hook.topic,
            status: typeof hook.status === 'string' ? hook.status : 'unknown',
            deliveryUrl: hook.delivery_url,
          });
        }
      }
      if (page >= totalPages(response)) break;
    }
    return all;
  }

  /** Creates one of HyFib's webhooks with the store's signing secret (WC-011). */
  async createWebhook(topic: WooWebhookTopic, deliveryUrl: string, secret: string): Promise<void> {
    const response = await this.call(
      'POST',
      '/webhooks',
      {},
      {
        name: `HyFib W360 ${topic}`,
        status: 'active',
        topic,
        delivery_url: deliveryUrl,
        secret,
      },
    );
    expectOk(response, `Creating the ${topic} webhook`);
  }

  /** Re-enables a webhook WooCommerce disabled after failed deliveries (WC-018). */
  async activateWebhook(id: string): Promise<void> {
    const response = await this.call(
      'PUT',
      `/webhooks/${encodeURIComponent(id)}`,
      {},
      { status: 'active' },
    );
    expectOk(response, 'Re-enabling a webhook');
  }

  async deleteWebhook(id: string): Promise<void> {
    const response = await this.call('DELETE', `/webhooks/${encodeURIComponent(id)}`, {
      force: 'true',
    });
    if (response.status === 404) return;
    expectOk(response, 'Deleting a webhook');
  }
}

function totalPages(response: StoreResponse): number {
  const pages = Number(response.headers['x-wp-totalpages']);
  return Number.isInteger(pages) && pages >= 0 ? pages : 1;
}

function listPage<T>(
  response: StoreResponse,
  page: number,
  parse: (raw: unknown) => T | null,
): WooPage<T> {
  if (!Array.isArray(response.json)) {
    throw new StoreApiError('malformed', 'The store’s answer was not a list.');
  }
  return {
    items: response.json.map(parse).filter((item): item is T => item !== null),
    hasNext: page < totalPages(response),
  };
}

function byId<T extends { externalId: string }>(
  response: StoreResponse,
  parse: (raw: unknown) => T | null,
): Map<string, T> {
  if (!Array.isArray(response.json)) {
    throw new StoreApiError('malformed', 'The store’s answer was not a list.');
  }
  const items = new Map<string, T>();
  for (const raw of response.json) {
    const item = parse(raw);
    if (item) items.set(item.externalId, item);
  }
  return items;
}

const wooId = (value: unknown): string | null =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value > 0 &&
  EXTERNAL_ID_RE.test(String(value))
    ? String(value)
    : null;

const personName = (address: Record<string, unknown> | null): string | null =>
  clip(
    [address?.first_name, address?.last_name].filter((p) => typeof p === 'string').join(' '),
    200,
  );

/** A REST order (WC-008) as the record HyFib keeps, or null when unusable. */
export function parseWooOrder(raw: unknown, storeCurrency: string | null): StoreOrderRecord | null {
  const order = asRecord(raw);
  const externalId = wooId(order?.id);
  const placedAt = storeDate(order?.date_created_gmt);
  const remoteUpdatedAt = storeDate(order?.date_modified_gmt) ?? placedAt;
  if (!order || !externalId || !placedAt || !remoteUpdatedAt) return null;
  const currency =
    typeof order.currency === 'string' && isCurrency(order.currency)
      ? order.currency
      : storeCurrency;
  const billing = asRecord(order.billing);
  const shipping = asRecord(order.shipping);
  const lines = Array.isArray(order.line_items) ? order.line_items : [];
  const items: StoreOrderItemRecord[] = [];
  for (const rawLine of lines.slice(0, STORE_LIMITS.orderItems)) {
    const line = asRecord(rawLine);
    if (!line) continue;
    const quantity = line.quantity;
    items.push({
      title: clip(line.name, 300) ?? 'Item',
      sku: clip(line.sku, 100),
      quantity:
        typeof quantity === 'number' && Number.isInteger(quantity) && quantity >= 0
          ? Math.min(quantity, 1_000_000)
          : 0,
      // The line's `total` string (after line discounts); its float `price` is not used (WC-008).
      totalMinor: storeAmountToMinor(line.total, currency),
    });
  }
  const number = clip(order.number, 90) ?? externalId;
  return {
    externalId,
    name: `#${number}`,
    status: statusWord(order.status) ?? 'unknown',
    financialStatus: null,
    fulfillmentStatus: null,
    test: false,
    currency,
    totalMinor: storeAmountToMinor(order.total, currency),
    itemsTruncated: lines.length > STORE_LIMITS.orderItems,
    placedAt,
    cancelledAt: null,
    remoteUpdatedAt,
    customerName: personName(billing) ?? personName(shipping),
    customerPhone: clip(billing?.phone, 40) ?? clip(shipping?.phone, 40),
    customerEmail: storeEmail(billing?.email),
    statusUrl: null,
    items,
  };
}

/** A REST product (WC-009) as the record HyFib keeps, or null when unusable. */
export function parseWooProduct(
  raw: unknown,
  storeCurrency: string | null,
): StoreProductRecord | null {
  const product = asRecord(raw);
  const externalId = wooId(product?.id);
  const remoteUpdatedAt =
    storeDate(product?.date_modified_gmt) ?? storeDate(product?.date_created_gmt);
  if (!product || !externalId || !remoteUpdatedAt) return null;
  // A variable product's `price` is its lowest variation price.
  const price = storeAmountToMinor(product.price, storeCurrency);
  const variations = Array.isArray(product.variations) ? product.variations.length : 0;
  const stock = product.stock_quantity;
  return {
    externalId,
    title: clip(product.name, 300) ?? `Product ${externalId}`,
    status: statusWord(product.status, 30) ?? 'publish',
    sku: clip(product.sku, 100),
    url: httpsUrl(product.permalink),
    currency: price === null ? null : storeCurrency,
    priceMinMinor: price,
    priceMaxMinor: price,
    inventory: typeof stock === 'number' && Number.isInteger(stock) ? stock : null,
    variants: variations > 0 ? variations : 1,
    remoteUpdatedAt,
  };
}
