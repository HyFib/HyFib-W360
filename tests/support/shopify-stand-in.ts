import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * TEST-ONLY local stand-in for the Shopify endpoints HyFib's store connector calls: the OAuth
 * authorize redirect and token endpoint (SH-003 to SH-008) and the Admin GraphQL API for HyFib's
 * fixed operations (SH-009 to SH-022). It also delivers webhooks the way Shopify does (signed with
 * the app's client secret, SH-024). Shops are served under `<base>/<shop>` (what
 * SHOPIFY_TEST_BASE_URL points the app at, allowed only for APP_ENV=local|test). It lives under
 * tests/ and is never shipped.
 *
 * Shapes follow docs/research/store-connectors.md; they are fixtures, not a claim about every field
 * Shopify returns.
 */

export interface StandInShopifyOrder {
  id: string;
  name: string;
  createdAt: string;
  processedAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  closed: boolean;
  test: boolean;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string;
  total: { amount: string; currencyCode: string };
  phone: string | null;
  email: string | null;
  shippingAddress: { name: string | null; phone: string | null } | null;
  billingAddress: { name: string | null; phone: string | null } | null;
  statusPageUrl: string;
  /** Payment gateway names (SH-031), for example "Cash on Delivery (COD)". */
  paymentGatewayNames: string[];
  /** Shipments (SH-030); a delivery need not change the order's updatedAt (SH-034). */
  fulfillments: StandInFulfillment[];
  lineItems: {
    name: string;
    sku: string | null;
    quantity: number;
    total: { amount: string; currencyCode: string };
  }[];
}

export interface StandInFulfillment {
  /** The fulfillment's numeric id (SH-045); defaults to one made from the order's id and place. */
  id?: string;
  status: 'SUCCESS' | 'CANCELLED' | 'ERROR' | 'FAILURE';
  displayStatus: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
  trackingInfo: { company: string | null; number: string | null; url: string | null }[];
}

export interface StandInShopifyProduct {
  id: string;
  title: string;
  status: 'ACTIVE' | 'ARCHIVED' | 'DRAFT' | 'UNLISTED';
  updatedAt: string;
  onlineStoreUrl: string | null;
  totalInventory: number;
  tracksInventory: boolean;
  variants: { sku: string | null; price: string }[];
  currencyCode: string;
}

/** A checkout a customer left (SH-039), with the customer and consent Shopify records (SH-041). */
export interface StandInCheckout {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  recoveryUrl: string | null;
  total: { amount: string; currencyCode: string };
  lineItems: { title: string; variantTitle: string | null; quantity: number }[];
  shippingAddress: { name: string | null; phone: string | null } | null;
  billingAddress: { name: string | null; phone: string | null } | null;
  customer: {
    id: string;
    displayName: string | null;
    phone: string | null;
    consent: {
      state: string;
      optInLevel: string | null;
      collectedFrom: string | null;
      updatedAt: string | null;
    } | null;
  } | null;
}

export interface StandInSubscription {
  id: string;
  topic: string;
  uri: string;
  includeFields: string[] | null;
}

export interface StandInShop {
  domain: string;
  id: string;
  name: string;
  currency: string;
  installed: boolean;
  codes: Set<string>;
  accessTokens: Map<string, number>;
  refreshTokens: Set<string>;
  scopes: string[];
  subscriptions: StandInSubscription[];
  orders: Map<string, StandInShopifyOrder>;
  products: Map<string, StandInShopifyProduct>;
  checkouts: Map<string, StandInCheckout>;
  /** Protected customer data not approved: customer fields come back null with ACCESS_DENIED. */
  withhold: boolean;
  /** Checkouts refused as a whole (for example a staff permission, SH-037). */
  denyCheckouts: boolean;
  /**
   * How a subscription to a topic the token's scopes do not allow is refused (Shopify's own shape
   * is unconfirmed, research §5): `userErrors` in the payload, a null payload withheld with
   * ACCESS_DENIED beside the data, or ACCESS_DENIED without data.
   */
  topicRefusal: 'user_errors' | 'access_denied_with_data' | 'access_denied';
  /** Points left in the cost bucket (SH-011); a query needing more is THROTTLED. */
  available: number;
}

export interface RecordedShopifyCall {
  method: string;
  path: string;
  operation: string | null;
  variables: Record<string, unknown> | null;
  accessToken: string | null;
}

export interface ShopifyDelivery {
  topic: string;
  uri: string;
  status: number;
  webhookId: string;
}

export interface ShopifyStandIn {
  baseUrl: string;
  shops: Map<string, StandInShop>;
  calls: RecordedShopifyCall[];
  /** Access tokens expire this many seconds after they are issued (SH-007: 60 minutes). */
  accessTtlSeconds: number;
  /** Scopes the next approval grants (default: what was asked for). */
  grantScopes: string[] | null;
  /**
   * Runs once the answer to an Admin API or token request is ready and before it is sent, so a
   * test can make something happen while HyFib waits for Shopify (a webhook, a reconnect).
   */
  beforeAnswer:
    | ((request: { shop: string; operation: string | null; grant: string | null }) => Promise<void>)
    | null;
  addShop(domain: string, options?: { name?: string; currency?: string }): StandInShop;
  upsertOrder(
    domain: string,
    order: Partial<StandInShopifyOrder> & { id: string },
  ): StandInShopifyOrder;
  upsertProduct(
    domain: string,
    product: Partial<StandInShopifyProduct> & { id: string },
  ): StandInShopifyProduct;
  upsertCheckout(
    domain: string,
    checkout: Partial<StandInCheckout> & { id: string },
  ): StandInCheckout;
  /** Delivers a webhook to the shop's subscriptions for `topic` (e.g. 'orders/updated'). */
  deliver(
    domain: string,
    topic: string,
    payload: Record<string, unknown>,
    webhookId?: string,
  ): Promise<ShopifyDelivery[]>;
  /** Delivers a compliance webhook to the app's compliance address (SH-027). */
  deliverCompliance(
    topic: string,
    payload: Record<string, unknown>,
    webhookId?: string,
  ): Promise<number>;
  /** The merchant uninstalls the app: tokens stop working, subscriptions go, app/uninstalled is sent. */
  uninstall(domain: string): Promise<ShopifyDelivery[]>;
  close(): Promise<void>;
}

const TOPIC_ENUM: Record<string, string> = {
  'orders/create': 'ORDERS_CREATE',
  'orders/updated': 'ORDERS_UPDATED',
  'orders/delete': 'ORDERS_DELETE',
  'products/create': 'PRODUCTS_CREATE',
  'products/update': 'PRODUCTS_UPDATE',
  'products/delete': 'PRODUCTS_DELETE',
  'app/uninstalled': 'APP_UNINSTALLED',
  'fulfillments/create': 'FULFILLMENTS_CREATE',
  'fulfillments/update': 'FULFILLMENTS_UPDATE',
};
const KNOWN_TOPICS = new Set(Object.values(TOPIC_ENUM));
/** Topics that need a scope beyond the connector's own (SH-044: the shipment topics). */
const TOPIC_SCOPES: Record<string, readonly string[]> = {
  FULFILLMENTS_CREATE: ['read_fulfillments', 'read_marketplace_orders'],
  FULFILLMENTS_UPDATE: ['read_fulfillments', 'read_marketplace_orders'],
};

/** A fulfillment's id as the stand-in serves it. */
export const standInFulfillmentId = (orderId: string, index: number, f: StandInFulfillment) =>
  f.id ?? `${orderId}${String(index + 1).padStart(2, '0')}`;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const token = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;

/** Shopify's callback HMAC (SH-004): sorted query without hmac, hex HMAC-SHA256 with the secret. */
export function shopifyQueryHmac(params: Record<string, string>, secret: string): string {
  const sorted = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const message = new URLSearchParams(sorted).toString().replace(/\+/g, '%20');
  return createHmac('sha256', secret).update(message).digest('hex');
}

export function shopifyWebhookHmac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

export async function startShopifyStandIn(options: {
  clientId: string;
  clientSecret: string;
  /** Where compliance webhooks go (HyFib's /api/webhooks/shopify). */
  complianceUri?: string;
  port?: number;
  host?: string;
}): Promise<ShopifyStandIn> {
  const shops = new Map<string, StandInShop>();
  const calls: RecordedShopifyCall[] = [];

  const standIn = {
    baseUrl: '',
    shops,
    calls,
    accessTtlSeconds: 3600,
    grantScopes: null as string[] | null,
    beforeAnswer: null,
  } as ShopifyStandIn;

  function addShop(domain: string, opts: { name?: string; currency?: string } = {}) {
    const shop: StandInShop = {
      domain,
      id: String(10_000 + shops.size + 1),
      name: opts.name ?? domain.split('.')[0] ?? domain,
      currency: opts.currency ?? 'INR',
      installed: false,
      codes: new Set(),
      accessTokens: new Map(),
      refreshTokens: new Set(),
      scopes: [],
      subscriptions: [],
      orders: new Map(),
      products: new Map(),
      checkouts: new Map(),
      withhold: false,
      denyCheckouts: false,
      topicRefusal: 'user_errors',
      available: 1000,
    };
    shops.set(domain, shop);
    return shop;
  }

  function shopOf(domain: string): StandInShop {
    const shop = shops.get(domain) ?? addShop(domain);
    return shop;
  }

  function upsertCheckout(domain: string, checkout: Partial<StandInCheckout> & { id: string }) {
    const shop = shopOf(domain);
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const existing = shop.checkouts.get(checkout.id);
    const merged: StandInCheckout = {
      name: `#C${1000 + shop.checkouts.size + 1}`,
      createdAt: now,
      completedAt: null,
      recoveryUrl: `https://${domain}/checkouts/${checkout.id}/recover?key=k${checkout.id}`,
      total: { amount: '0.00', currencyCode: shop.currency },
      lineItems: [],
      shippingAddress: null,
      billingAddress: null,
      customer: null,
      ...existing,
      ...checkout,
      updatedAt: checkout.updatedAt ?? now,
    };
    shop.checkouts.set(checkout.id, merged);
    return merged;
  }

  function upsertOrder(domain: string, order: Partial<StandInShopifyOrder> & { id: string }) {
    const shop = shopOf(domain);
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const existing = shop.orders.get(order.id);
    const merged: StandInShopifyOrder = {
      name: `#${1000 + shop.orders.size + 1}`,
      createdAt: now,
      processedAt: now,
      cancelledAt: null,
      closed: false,
      test: false,
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'UNFULFILLED',
      total: { amount: '0.00', currencyCode: shop.currency },
      phone: null,
      email: null,
      shippingAddress: null,
      billingAddress: null,
      statusPageUrl: `https://${domain}/orders/status/${order.id}`,
      paymentGatewayNames: ['Shopify Payments'],
      fulfillments: [],
      lineItems: [],
      ...existing,
      ...order,
      updatedAt: order.updatedAt ?? now,
    };
    shop.orders.set(order.id, merged);
    return merged;
  }

  function upsertProduct(domain: string, product: Partial<StandInShopifyProduct> & { id: string }) {
    const shop = shopOf(domain);
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const merged: StandInShopifyProduct = {
      title: `Product ${product.id}`,
      status: 'ACTIVE',
      onlineStoreUrl: `https://${domain}/products/${product.id}`,
      totalInventory: 10,
      tracksInventory: true,
      variants: [{ sku: `SKU-${product.id}`, price: '100.00' }],
      currencyCode: shop.currency,
      ...shop.products.get(product.id),
      ...product,
      updatedAt: product.updatedAt ?? now,
    };
    shop.products.set(product.id, merged);
    return merged;
  }

  async function post(uri: string, topic: string, domain: string, body: string, webhookId: string) {
    const response = await fetch(uri, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shopify-topic': topic,
        'x-shopify-hmac-sha256': shopifyWebhookHmac(body, options.clientSecret),
        'x-shopify-shop-domain': domain,
        'x-shopify-api-version': '2026-07',
        'x-shopify-webhook-id': webhookId,
        'x-shopify-event-id': randomUUID(),
        'x-shopify-triggered-at': new Date().toISOString(),
      },
      body,
    });
    await response.arrayBuffer();
    return response.status;
  }

  async function deliver(
    domain: string,
    topic: string,
    payload: Record<string, unknown>,
    webhookId?: string,
  ): Promise<ShopifyDelivery[]> {
    const shop = shopOf(domain);
    const enumTopic = TOPIC_ENUM[topic];
    const results: ShopifyDelivery[] = [];
    for (const sub of shop.subscriptions.filter((s) => s.topic === enumTopic)) {
      const fields = sub.includeFields;
      const body = JSON.stringify(
        fields
          ? Object.fromEntries(Object.entries(payload).filter(([k]) => fields.includes(k)))
          : payload,
      );
      const id = webhookId ?? randomUUID();
      results.push({
        topic,
        uri: sub.uri,
        status: await post(sub.uri, topic, domain, body, id),
        webhookId: id,
      });
    }
    return results;
  }

  async function deliverCompliance(
    topic: string,
    payload: Record<string, unknown>,
    webhookId?: string,
  ) {
    if (!options.complianceUri) throw new Error('no compliance address configured');
    const domain = typeof payload.shop_domain === 'string' ? payload.shop_domain : '';
    return post(
      options.complianceUri,
      topic,
      domain,
      JSON.stringify(payload),
      webhookId ?? randomUUID(),
    );
  }

  async function uninstall(domain: string) {
    const shop = shopOf(domain);
    shop.installed = false;
    shop.accessTokens.clear();
    shop.refreshTokens.clear();
    const subscriptions = shop.subscriptions;
    shop.subscriptions = [];
    const results: ShopifyDelivery[] = [];
    for (const sub of subscriptions.filter((s) => s.topic === 'APP_UNINSTALLED')) {
      const body = JSON.stringify({
        id: Number(shop.id),
        myshopify_domain: domain,
        name: shop.name,
      });
      const id = randomUUID();
      results.push({
        topic: 'app/uninstalled',
        uri: sub.uri,
        status: await post(sub.uri, 'app/uninstalled', domain, body, id),
        webhookId: id,
      });
    }
    return results;
  }

  function issueTokens(shop: StandInShop) {
    const access = token('shpat');
    const refresh = token('shprt');
    shop.accessTokens.set(access, Date.now() + standIn.accessTtlSeconds * 1000);
    shop.refreshTokens.add(refresh);
    return {
      access_token: access,
      scope: shop.scopes.join(','),
      expires_in: standIn.accessTtlSeconds,
      refresh_token: refresh,
      refresh_token_expires_in: 7_776_000,
    };
  }

  const gid = (type: string, id: string) => `gid://shopify/${type}/${id}`;
  const money = (amount: string, currencyCode: string) => ({ shopMoney: { amount, currencyCode } });

  function orderNode(shop: StandInShop, o: StandInShopifyOrder) {
    const hide = shop.withhold;
    return {
      id: gid('Order', o.id),
      name: o.name,
      createdAt: o.createdAt,
      processedAt: o.processedAt,
      updatedAt: o.updatedAt,
      cancelledAt: o.cancelledAt,
      closed: o.closed,
      test: o.test,
      displayFinancialStatus: o.displayFinancialStatus,
      displayFulfillmentStatus: o.displayFulfillmentStatus,
      totalPriceSet: money(o.total.amount, o.total.currencyCode),
      phone: hide ? null : o.phone,
      email: hide ? null : o.email,
      shippingAddress: hide ? null : o.shippingAddress,
      billingAddress: hide ? null : o.billingAddress,
      statusPageUrl: o.statusPageUrl,
      paymentGatewayNames: o.paymentGatewayNames,
      fulfillments: o.fulfillments.slice(0, 10).map((f, index) => ({
        id: gid('Fulfillment', standInFulfillmentId(o.id, index, f)),
        status: f.status,
        displayStatus: f.displayStatus,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        deliveredAt: f.deliveredAt,
        trackingInfo: f.trackingInfo.slice(0, 1),
      })),
      lineItems: {
        nodes: o.lineItems.slice(0, 25).map((l) => ({
          name: l.name,
          sku: l.sku,
          quantity: l.quantity,
          discountedTotalSet: money(l.total.amount, l.total.currencyCode),
        })),
        pageInfo: { hasNextPage: o.lineItems.length > 25 },
      },
    };
  }

  function productNode(p: StandInShopifyProduct) {
    const prices = p.variants.map((v) => Number(v.price));
    const min = p.variants[prices.indexOf(Math.min(...prices))]?.price ?? '0.00';
    const max = p.variants[prices.indexOf(Math.max(...prices))]?.price ?? '0.00';
    return {
      id: gid('Product', p.id),
      title: p.title,
      status: p.status,
      updatedAt: p.updatedAt,
      onlineStoreUrl: p.onlineStoreUrl,
      totalInventory: p.totalInventory,
      tracksInventory: p.tracksInventory,
      variantsCount: { count: p.variants.length },
      priceRangeV2: {
        minVariantPrice: { amount: min, currencyCode: p.currencyCode },
        maxVariantPrice: { amount: max, currencyCode: p.currencyCode },
      },
      variants: { nodes: p.variants.slice(0, 1).map((v) => ({ sku: v.sku })) },
    };
  }

  /** `updated_at:>='…'` (SH-016), sorted by updated time then id, paged by an index cursor. */
  function connection<T extends { id: string; updatedAt: string }>(
    items: T[],
    query: string,
    first: number,
    after: unknown,
    node: (item: T) => unknown,
  ) {
    const since = /updated_at:>='([^']+)'/.exec(query)?.[1];
    const sinceMs = since ? Date.parse(since) : 0;
    const sorted = items
      .filter((i) => Date.parse(i.updatedAt) >= sinceMs)
      .sort(
        (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || Number(a.id) - Number(b.id),
      );
    const start =
      typeof after === 'string' ? Number(Buffer.from(after, 'base64').toString('utf8')) + 1 : 0;
    const page = sorted.slice(start, start + first);
    const end = start + page.length - 1;
    return {
      nodes: page.map(node),
      pageInfo: {
        hasNextPage: start + first < sorted.length,
        endCursor: page.length ? Buffer.from(String(end)).toString('base64') : null,
      },
    };
  }

  function checkoutNode(shop: StandInShop, c: StandInCheckout, withCustomers: boolean) {
    const hide = shop.withhold;
    const customerAccess = shop.scopes.includes('read_customers');
    return {
      id: gid('AbandonedCheckout', c.id),
      name: c.name,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      completedAt: c.completedAt,
      abandonedCheckoutUrl: c.recoveryUrl,
      totalPriceSet: money(c.total.amount, c.total.currencyCode),
      lineItemsQuantity: c.lineItems.reduce((n, l) => n + l.quantity, 0),
      lineItems: {
        nodes: c.lineItems
          .slice(0, 10)
          .map((l) => ({ title: l.title, variantTitle: l.variantTitle, quantity: l.quantity })),
      },
      shippingAddress: c.shippingAddress
        ? {
            name: hide ? null : c.shippingAddress.name,
            phone: hide ? null : c.shippingAddress.phone,
          }
        : null,
      billingAddress: c.billingAddress
        ? { name: hide ? null : c.billingAddress.name, phone: hide ? null : c.billingAddress.phone }
        : null,
      ...(withCustomers
        ? {
            customer:
              customerAccess && c.customer
                ? {
                    id: gid('Customer', c.customer.id),
                    displayName: hide ? null : c.customer.displayName,
                    defaultPhoneNumber: c.customer.phone
                      ? {
                          phoneNumber: hide ? null : c.customer.phone,
                          whatsAppMarketingConsent: c.customer.consent,
                        }
                      : null,
                  }
                : null,
          }
        : {}),
    };
  }

  /** `updated_at:>='…'` (SH-038); no sort by update time exists, so the list is in id order. */
  function checkoutConnection(
    shop: StandInShop,
    query: string,
    first: number,
    after: unknown,
    withCustomers: boolean,
  ) {
    const since = /updated_at:>='([^']+)'/.exec(query)?.[1];
    const sinceMs = since ? Date.parse(since) : 0;
    const sorted = [...shop.checkouts.values()]
      .filter((c) => Date.parse(c.updatedAt) >= sinceMs)
      .sort((a, b) => Number(a.id) - Number(b.id));
    const start =
      typeof after === 'string' ? Number(Buffer.from(after, 'base64').toString('utf8')) + 1 : 0;
    const page = sorted.slice(start, start + first);
    const end = start + page.length - 1;
    return {
      nodes: page.map((c) => checkoutNode(shop, c, withCustomers)),
      pageInfo: {
        hasNextPage: start + first < sorted.length,
        endCursor: page.length ? Buffer.from(String(end)).toString('base64') : null,
      },
    };
  }

  function graphql(shop: StandInShop, query: string, variables: Record<string, unknown>) {
    const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? '';
    const requested = operation === 'W360Orders' || operation === 'W360OrderNodes' ? 200 : 20;
    if (shop.available < requested) {
      return {
        errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
        extensions: {
          cost: {
            requestedQueryCost: requested,
            actualQueryCost: null,
            throttleStatus: {
              maximumAvailable: 1000,
              currentlyAvailable: shop.available,
              restoreRate: 50,
            },
          },
        },
      };
    }
    const cost = {
      cost: {
        requestedQueryCost: requested,
        actualQueryCost: requested,
        throttleStatus: {
          maximumAvailable: 1000,
          currentlyAvailable: shop.available,
          restoreRate: 50,
        },
      },
    };
    const first = Number(/(?:orders|products)\(first: (\d+)/.exec(query)?.[1] ?? '50');
    const denied = shop.withhold
      ? [
          {
            message: 'Access denied for protected customer data fields.',
            extensions: { code: 'ACCESS_DENIED' },
          },
        ]
      : [];
    switch (operation) {
      case 'W360Shop':
        return {
          data: {
            shop: {
              id: gid('Shop', shop.id),
              name: shop.name,
              myshopifyDomain: shop.domain,
              currencyCode: shop.currency,
            },
          },
          extensions: cost,
        };
      case 'W360Orders':
        return {
          data: {
            orders: connection(
              [...shop.orders.values()],
              String(variables.query ?? ''),
              first,
              variables.after,
              (o) => orderNode(shop, o),
            ),
          },
          ...(denied.length ? { errors: denied } : {}),
          extensions: cost,
        };
      case 'W360OrderNodes':
        return {
          data: {
            nodes: (variables.ids as string[]).map((id) => {
              const order = shop.orders.get(id.split('/').pop() ?? '');
              return order ? orderNode(shop, order) : null;
            }),
          },
          ...(denied.length ? { errors: denied } : {}),
          extensions: cost,
        };
      case 'W360Checkouts':
      case 'W360CheckoutsWithCustomers': {
        if (shop.denyCheckouts) {
          return {
            errors: [
              {
                message: 'Access denied for abandonedCheckouts field.',
                extensions: { code: 'ACCESS_DENIED' },
              },
            ],
            extensions: cost,
          };
        }
        const withCustomers = operation === 'W360CheckoutsWithCustomers';
        const pageSize = Number(/abandonedCheckouts\(first: (\d+)/.exec(query)?.[1] ?? '50');
        const errors = [
          ...denied,
          ...(withCustomers && !shop.scopes.includes('read_customers')
            ? [
                {
                  message: 'Access denied for customer field. Required access: `read_customers`.',
                  extensions: { code: 'ACCESS_DENIED' },
                },
              ]
            : []),
        ];
        return {
          data: {
            abandonedCheckouts: checkoutConnection(
              shop,
              String(variables.query ?? ''),
              pageSize,
              variables.after,
              withCustomers,
            ),
          },
          ...(errors.length ? { errors } : {}),
          extensions: cost,
        };
      }
      case 'W360Products':
        return {
          data: {
            products: connection(
              [...shop.products.values()],
              String(variables.query ?? ''),
              first,
              variables.after,
              productNode,
            ),
          },
          extensions: cost,
        };
      case 'W360ProductNodes':
        return {
          data: {
            nodes: (variables.ids as string[]).map((id) => {
              const product = shop.products.get(id.split('/').pop() ?? '');
              return product ? productNode(product) : null;
            }),
          },
          extensions: cost,
        };
      case 'W360Webhooks':
        return {
          data: {
            webhookSubscriptions: {
              nodes: shop.subscriptions
                .filter((s) => s.uri === variables.uri)
                .map((s) => ({ id: s.id, topic: s.topic })),
            },
          },
          extensions: cost,
        };
      case 'W360WebhookCreate': {
        const topic = String(variables.topic ?? '');
        const input = (variables.input ?? {}) as { uri?: string; includeFields?: string[] };
        if (!KNOWN_TOPICS.has(topic) || !input.uri) {
          return {
            data: {
              webhookSubscriptionCreate: {
                webhookSubscription: null,
                userErrors: [{ field: ['topic'], message: 'Invalid topic' }],
              },
            },
            extensions: cost,
          };
        }
        const needed = TOPIC_SCOPES[topic];
        if (needed && !needed.some((scope) => shop.scopes.includes(scope))) {
          const denied = {
            message: `Access denied for webhookSubscriptionCreate field (${topic}).`,
            extensions: { code: 'ACCESS_DENIED' },
          };
          if (shop.topicRefusal === 'access_denied') {
            return { errors: [denied], extensions: cost };
          }
          if (shop.topicRefusal === 'access_denied_with_data') {
            return {
              data: { webhookSubscriptionCreate: null },
              errors: [denied],
              extensions: cost,
            };
          }
          return {
            data: {
              webhookSubscriptionCreate: {
                webhookSubscription: null,
                userErrors: [
                  { field: ['topic'], message: `${topic} requires the read_fulfillments scope` },
                ],
              },
            },
            extensions: cost,
          };
        }
        const sub = {
          id: gid('WebhookSubscription', String(Date.now() + shop.subscriptions.length)),
          topic,
          uri: input.uri,
          includeFields: input.includeFields ?? null,
        };
        shop.subscriptions.push(sub);
        return {
          data: {
            webhookSubscriptionCreate: {
              webhookSubscription: { id: sub.id, topic },
              userErrors: [],
            },
          },
          extensions: cost,
        };
      }
      case 'W360Uninstall':
        shop.installed = false;
        shop.accessTokens.clear();
        shop.refreshTokens.clear();
        shop.subscriptions = [];
        return {
          data: { appUninstall: { app: { id: gid('App', '1') }, userErrors: [] } },
          extensions: cost,
        };
      default:
        return { errors: [{ message: `Unknown operation ${operation}` }] };
    }
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stand-in');
      // TEST-ONLY controls answer on a connection of their own: a runner request sent on a kept-alive
      // socket just as the server closes it after its idle timeout hangs up (once in CI).
      if (url.pathname.startsWith('/__stand-in/')) res.setHeader('connection', 'close');
      const raw = await readBody(req);
      // TEST-ONLY controls for the end-to-end tests (other processes cannot call the methods).
      if (url.pathname.startsWith('/__stand-in/')) {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const domain = String(body.shop ?? '');
        switch (url.pathname) {
          case '/__stand-in/order':
            return json(res, 200, upsertOrder(domain, body.order as StandInShopifyOrder));
          case '/__stand-in/product':
            return json(res, 200, upsertProduct(domain, body.product as StandInShopifyProduct));
          case '/__stand-in/checkout':
            return json(res, 200, upsertCheckout(domain, body.checkout as StandInCheckout));
          case '/__stand-in/deliver':
            return json(
              res,
              200,
              await deliver(domain, String(body.topic), body.payload as Record<string, unknown>),
            );
          case '/__stand-in/uninstall':
            return json(res, 200, await uninstall(domain));
          case '/__stand-in/shop': {
            const shop = shops.get(domain);
            return shop
              ? json(res, 200, {
                  installed: shop.installed,
                  subscriptions: shop.subscriptions.map((s) => ({ topic: s.topic, uri: s.uri })),
                })
              : json(res, 404, { error: 'unknown shop' });
          }
          default:
            return json(res, 404, { error: 'unknown control' });
        }
      }
      const match = /^\/([a-z0-9][a-z0-9-]*\.myshopify\.com)(\/.*)$/.exec(url.pathname);
      if (!match) return json(res, 404, { errors: 'Not Found' });
      const domain = match[1] as string;
      const path = match[2] as string;
      const shop = shopOf(domain);
      const accessToken = (req.headers['x-shopify-access-token'] as string | undefined) ?? null;
      let parsed: Record<string, unknown>;
      try {
        parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        parsed = {};
      }
      const operation =
        typeof parsed.query === 'string'
          ? (/(?:query|mutation)\s+(\w+)/.exec(parsed.query)?.[1] ?? null)
          : null;
      calls.push({
        method: req.method ?? 'GET',
        path,
        operation,
        variables: (parsed.variables as Record<string, unknown> | undefined) ?? null,
        accessToken,
      });

      // The merchant approves at once (SH-003) and Shopify redirects back with a signed query.
      if (req.method === 'GET' && path === '/admin/oauth/authorize') {
        if (url.searchParams.get('client_id') !== options.clientId) {
          return json(res, 400, { error: 'invalid client_id' });
        }
        const redirect = url.searchParams.get('redirect_uri') ?? '';
        const code = token('code');
        shop.codes.add(code);
        shop.scopes = standIn.grantScopes ?? (url.searchParams.get('scope') ?? '').split(',');
        const params: Record<string, string> = {
          code,
          host: Buffer.from(`admin.shopify.com/store/${domain.split('.')[0]}`).toString('base64'),
          shop: domain,
          state: url.searchParams.get('state') ?? '',
          timestamp: String(Math.trunc(Date.now() / 1000)),
        };
        params.hmac = shopifyQueryHmac(params, options.clientSecret);
        res.writeHead(302, { location: `${redirect}?${new URLSearchParams(params).toString()}` });
        return res.end();
      }
      if (req.method === 'POST' && path === '/admin/oauth/access_token') {
        if (
          parsed.client_id !== options.clientId ||
          parsed.client_secret !== options.clientSecret
        ) {
          return json(res, 401, { error: 'invalid_client' });
        }
        if (parsed.grant_type === 'refresh_token') {
          const refresh = String(parsed.refresh_token ?? '');
          if (!shop.refreshTokens.has(refresh)) return json(res, 400, { error: 'invalid_grant' });
          shop.refreshTokens.delete(refresh);
          shop.accessTokens.clear();
          const refreshed = issueTokens(shop);
          await standIn.beforeAnswer?.({ shop: domain, operation: null, grant: 'refresh_token' });
          return json(res, 200, refreshed);
        }
        const code = String(parsed.code ?? '');
        if (!shop.codes.has(code))
          return json(res, 400, {
            error: 'invalid_request',
            error_description: 'The authorization code was not found or was already used',
          });
        shop.codes.delete(code);
        shop.installed = true;
        // One current expiring offline token per app and store (SH-007).
        shop.accessTokens.clear();
        shop.refreshTokens.clear();
        const issued = issueTokens(shop);
        await standIn.beforeAnswer?.({
          shop: domain,
          operation: null,
          grant: 'authorization_code',
        });
        return json(res, 200, issued);
      }
      const api = /^\/admin\/api\/(\d{4}-\d{2})\/graphql\.json$/.exec(path);
      if (req.method === 'POST' && api) {
        const expires = accessToken ? shop.accessTokens.get(accessToken) : undefined;
        if (!shop.installed || !expires || expires < Date.now()) {
          return json(res, 401, {
            errors: '[API] Invalid API key or access token (unrecognized login or wrong password)',
          });
        }
        const answer = graphql(
          shop,
          String(parsed.query ?? ''),
          (parsed.variables ?? {}) as Record<string, unknown>,
        );
        await standIn.beforeAnswer?.({ shop: domain, operation, grant: null });
        return json(res, 200, answer);
      }
      return json(res, 404, { errors: 'Not Found' });
    })().catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error));
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve),
  );
  const { port } = server.address() as AddressInfo;
  standIn.baseUrl = `http://${options.host ?? '127.0.0.1'}:${port}`;
  standIn.addShop = addShop;
  standIn.upsertOrder = upsertOrder;
  standIn.upsertProduct = upsertProduct;
  standIn.upsertCheckout = upsertCheckout;
  standIn.deliver = deliver;
  standIn.deliverCompliance = deliverCompliance;
  standIn.uninstall = uninstall;
  standIn.close = () =>
    new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return standIn;
}
