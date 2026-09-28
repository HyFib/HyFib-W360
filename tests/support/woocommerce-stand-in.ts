import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * TEST-ONLY local stand-in for the WooCommerce endpoints HyFib's store connector calls: the app
 * authentication endpoint and its key handover (WC-002, WC-003), the REST API v3 routes for the
 * currency, orders, products and webhooks with HTTP Basic keys (WC-004 to WC-011), and webhook
 * deliveries signed with each webhook's secret, with the creation ping and the disabling after
 * failed deliveries (WC-012 to WC-018). Several sites are served under path prefixes
 * (`<base>/<site>`). It lives under tests/ and is never shipped; HyFib reaches it only because test
 * configuration lets the egress client use http:// and loopback addresses.
 *
 * Shapes follow docs/research/store-connectors.md; they are fixtures, not every field WooCommerce
 * returns.
 */

export interface StandInWooOrder {
  id: number;
  number: string;
  status: string;
  currency: string;
  total: string;
  date_created_gmt: string;
  date_modified_gmt: string;
  /** Set when the order is completed (WC-022). */
  date_completed_gmt?: string | null;
  /** The gateway id, `cod` for the core cash on delivery gateway (WC-021), and its title. */
  payment_method?: string;
  payment_method_title?: string;
  billing: { first_name: string; last_name: string; email: string; phone: string };
  line_items: {
    id: number;
    name: string;
    sku: string;
    quantity: number;
    total: string;
    price: number;
  }[];
}

export interface StandInWooProduct {
  id: number;
  name: string;
  status: string;
  sku: string;
  price: string;
  permalink: string;
  stock_quantity: number | null;
  variations: number[];
  date_modified_gmt: string;
}

export interface StandInWooWebhook {
  id: number;
  name: string;
  topic: string;
  status: 'active' | 'paused' | 'disabled';
  delivery_url: string;
  secret: string;
  failures: number;
}

export interface StandInWooSite {
  path: string;
  currency: string;
  keys: Map<string, { secret: string; permissions: 'read' | 'write' | 'read_write' }>;
  orders: Map<number, StandInWooOrder>;
  products: Map<number, StandInWooProduct>;
  webhooks: Map<number, StandInWooWebhook>;
  nextWebhookId: number;
  /** Status answered by the last creation ping. */
  pings: number[];
}

export interface WooDelivery {
  webhookId: number;
  status: number;
}

export interface WooStandIn {
  baseUrl: string;
  sites: Map<string, StandInWooSite>;
  /** Permissions the next approval grants (default read_write). */
  grantPermissions: 'read' | 'write' | 'read_write';
  siteUrl(path: string): string;
  addSite(path: string, currency?: string): StandInWooSite;
  addKeys(
    path: string,
    permissions?: 'read' | 'write' | 'read_write',
  ): { consumerKey: string; consumerSecret: string };
  revokeKeys(path: string): void;
  upsertOrder(path: string, order: Partial<StandInWooOrder> & { id: number }): StandInWooOrder;
  upsertProduct(
    path: string,
    product: Partial<StandInWooProduct> & { id: number },
  ): StandInWooProduct;
  /** Delivers a topic (e.g. 'order.updated') for a resource to the site's active webhooks. */
  deliver(path: string, topic: string, id: number): Promise<WooDelivery[]>;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const gmt = (date = new Date()) => date.toISOString().replace(/\.\d{3}Z$/, '');

function restError(res: ServerResponse, status: number, code: string, message: string) {
  json(res, status, { code, message, data: { status } });
}

export async function startWooStandIn(
  options: { port?: number; host?: string } = {},
): Promise<WooStandIn> {
  const sites = new Map<string, StandInWooSite>();
  const host = options.host ?? '127.0.0.1';
  const standIn = { baseUrl: '', sites, grantPermissions: 'read_write' } as WooStandIn;

  function addSite(path: string, currency = 'INR'): StandInWooSite {
    const site: StandInWooSite = {
      path,
      currency,
      keys: new Map(),
      orders: new Map(),
      products: new Map(),
      webhooks: new Map(),
      nextWebhookId: 1,
      pings: [],
    };
    sites.set(path, site);
    return site;
  }

  const siteOf = (path: string) => sites.get(path) ?? addSite(path);

  function addKeys(path: string, permissions: 'read' | 'write' | 'read_write' = 'read_write') {
    const site = siteOf(path);
    const consumerKey = `ck_${hex(20)}`;
    const consumerSecret = `cs_${hex(20)}`;
    site.keys.set(consumerKey, { secret: consumerSecret, permissions });
    return { consumerKey, consumerSecret };
  }

  function upsertOrder(path: string, order: Partial<StandInWooOrder> & { id: number }) {
    const site = siteOf(path);
    const merged: StandInWooOrder = {
      number: String(order.id),
      status: 'processing',
      currency: site.currency,
      total: '0.00',
      date_created_gmt: gmt(),
      billing: { first_name: '', last_name: '', email: '', phone: '' },
      line_items: [],
      ...site.orders.get(order.id),
      ...order,
      date_modified_gmt: order.date_modified_gmt ?? gmt(),
    };
    site.orders.set(order.id, merged);
    return merged;
  }

  function upsertProduct(path: string, product: Partial<StandInWooProduct> & { id: number }) {
    const site = siteOf(path);
    const merged: StandInWooProduct = {
      name: `Product ${product.id}`,
      status: 'publish',
      sku: `WOO-${product.id}`,
      price: '100.00',
      permalink: `https://shop.example/product/${product.id}`,
      stock_quantity: 5,
      variations: [],
      ...site.products.get(product.id),
      ...product,
      date_modified_gmt: product.date_modified_gmt ?? gmt(),
    };
    site.products.set(product.id, merged);
    return merged;
  }

  async function post(url: string, body: string, headers: Record<string, string>) {
    try {
      const response = await fetch(url, { method: 'POST', headers, body });
      await response.arrayBuffer();
      return response.status;
    } catch {
      return 0;
    }
  }

  async function deliver(path: string, topic: string, id: number): Promise<WooDelivery[]> {
    const site = siteOf(path);
    const [resource, event] = topic.split('.') as [string, string];
    const results: WooDelivery[] = [];
    for (const hook of site.webhooks.values()) {
      if (hook.topic !== topic || hook.status !== 'active') continue;
      const payload =
        event === 'deleted'
          ? { id }
          : resource === 'order'
            ? site.orders.get(id)
            : site.products.get(id);
      const body = JSON.stringify(payload ?? { id });
      const status = await post(hook.delivery_url, body, {
        'content-type': 'application/json',
        'user-agent': 'WooCommerce/10.0.0 Hookshot (WordPress/6.8)',
        'x-wc-webhook-source': `${standIn.siteUrl(path)}/`,
        'x-wc-webhook-topic': topic,
        'x-wc-webhook-resource': resource,
        'x-wc-webhook-event': event,
        'x-wc-webhook-signature': createHmac('sha256', hook.secret).update(body).digest('base64'),
        'x-wc-webhook-id': String(hook.id),
        'x-wc-webhook-delivery-id': hex(16),
      });
      // 2xx, 301 and 302 count as delivered; more than five failures in a row disable it (WC-018).
      if (status >= 200 && status < 303) hook.failures = 0;
      else if (hook.failures > 5) hook.status = 'disabled';
      else hook.failures += 1;
      results.push({ webhookId: hook.id, status });
    }
    return results;
  }

  function authenticate(req: IncomingMessage, site: StandInWooSite) {
    const header = req.headers.authorization ?? '';
    const match = /^Basic (.+)$/.exec(header);
    if (!match) return null;
    const [key, secret] = Buffer.from(match[1] as string, 'base64')
      .toString('utf8')
      .split(':');
    const found = key ? site.keys.get(key) : undefined;
    return found && found.secret === secret ? found : null;
  }

  function paged<T>(res: ServerResponse, items: T[], url: URL) {
    const perPage = Math.min(100, Number(url.searchParams.get('per_page') ?? '10'));
    const page = Number(url.searchParams.get('page') ?? '1');
    const slice = items.slice((page - 1) * perPage, page * perPage);
    json(res, 200, slice, {
      'x-wp-total': String(items.length),
      'x-wp-totalpages': String(Math.ceil(items.length / perPage)),
    });
  }

  /** modified_after (exclusive) and include, ordered by modification time then id (WC-007). */
  function select<T extends { id: number; date_modified_gmt: string }>(items: T[], url: URL): T[] {
    const include = url.searchParams.get('include');
    const ids = include ? new Set(include.split(',').map(Number)) : null;
    const after = url.searchParams.get('modified_after');
    const afterMs = after ? Date.parse(after.endsWith('Z') ? after : `${after}Z`) : null;
    return items
      .filter((i) => (ids ? ids.has(i.id) : true))
      .filter((i) => (afterMs === null ? true : Date.parse(`${i.date_modified_gmt}Z`) > afterMs))
      .sort(
        (a, b) =>
          Date.parse(`${a.date_modified_gmt}Z`) - Date.parse(`${b.date_modified_gmt}Z`) ||
          a.id - b.id,
      );
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stand-in');
      const raw = await readBody(req);
      if (url.pathname.startsWith('/__stand-in/')) {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const path = String(body.site ?? '');
        switch (url.pathname) {
          case '/__stand-in/order':
            return json(res, 200, upsertOrder(path, body.order as StandInWooOrder));
          case '/__stand-in/product':
            return json(res, 200, upsertProduct(path, body.product as StandInWooProduct));
          case '/__stand-in/deliver':
            return json(res, 200, await deliver(path, String(body.topic), Number(body.id)));
          case '/__stand-in/site': {
            const site = sites.get(path);
            return site
              ? json(res, 200, {
                  keys: site.keys.size,
                  webhooks: [...site.webhooks.values()].map((w) => ({
                    id: w.id,
                    topic: w.topic,
                    status: w.status,
                    delivery_url: w.delivery_url,
                  })),
                  pings: site.pings,
                })
              : json(res, 404, { error: 'unknown site' });
          }
          default:
            return json(res, 404, { error: 'unknown control' });
        }
      }
      const match = /^\/([a-z0-9-]+)(\/.*)$/.exec(url.pathname);
      if (!match) return restError(res, 404, 'rest_no_route', 'No route was found.');
      const path = match[1] as string;
      const route = match[2] as string;
      const site = siteOf(path);

      // The store owner approves at once; keys go to callback_url, then the browser goes back.
      if (req.method === 'GET' && route === '/wc-auth/v1/authorize') {
        const callback = url.searchParams.get('callback_url') ?? '';
        const returnUrl = url.searchParams.get('return_url') ?? '';
        const userId = url.searchParams.get('user_id') ?? '';
        const scope = url.searchParams.get('scope') ?? '';
        if (
          !['read', 'write', 'read_write'].includes(scope) ||
          !callback ||
          !returnUrl ||
          !userId
        ) {
          res.writeHead(401, { 'content-type': 'text/plain' });
          return res.end('Error: missing parameter.');
        }
        const permissions = standIn.grantPermissions;
        const keys = addKeys(path, permissions);
        const status = await post(
          callback,
          JSON.stringify({
            key_id: site.keys.size,
            user_id: userId,
            consumer_key: keys.consumerKey,
            consumer_secret: keys.consumerSecret,
            key_permissions: permissions,
          }),
          { 'content-type': 'application/json;charset=UTF-8' },
        );
        if (status !== 200) {
          site.keys.delete(keys.consumerKey);
          res.writeHead(401, { 'content-type': 'text/plain' });
          return res.end(
            'Error: An error occurred in the request and at the time were unable to send the consumer data.',
          );
        }
        const back = new URL(returnUrl);
        back.searchParams.set('success', '1');
        back.searchParams.set('user_id', userId);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (!route.startsWith('/wp-json/wc/v3/'))
        return restError(res, 404, 'rest_no_route', 'No route was found.');
      const key = authenticate(req, site);
      if (!key)
        return restError(
          res,
          401,
          'woocommerce_rest_authentication_error',
          'Consumer key is invalid.',
        );
      const write = req.method !== 'GET' && req.method !== 'HEAD';
      if (write ? !key.permissions.includes('write') : !key.permissions.includes('read')) {
        return restError(
          res,
          401,
          'woocommerce_rest_authentication_error',
          `The API key provided does not have ${write ? 'write' : 'read'} permissions.`,
        );
      }
      const rest = route.slice('/wp-json/wc/v3'.length);
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (req.method === 'GET' && rest === '/settings/general/woocommerce_currency') {
        return json(res, 200, {
          id: 'woocommerce_currency',
          label: 'Currency',
          type: 'select',
          value: site.currency,
        });
      }
      if (req.method === 'GET' && rest === '/orders')
        return paged(res, select([...site.orders.values()], url), url);
      if (req.method === 'GET' && rest === '/products')
        return paged(res, select([...site.products.values()], url), url);
      if (req.method === 'GET' && rest === '/webhooks') {
        return paged(
          res,
          [...site.webhooks.values()].map((w) => ({
            id: w.id,
            name: w.name,
            status: w.status,
            topic: w.topic,
            delivery_url: w.delivery_url,
          })),
          url,
        );
      }
      if (req.method === 'POST' && rest === '/webhooks') {
        const hook: StandInWooWebhook = {
          id: site.nextWebhookId++,
          name: String(parsed.name ?? ''),
          topic: String(parsed.topic ?? ''),
          status: parsed.status === 'active' ? 'active' : 'disabled',
          delivery_url: String(parsed.delivery_url ?? ''),
          secret: String(parsed.secret ?? hex(25)),
          failures: 0,
        };
        site.webhooks.set(hook.id, hook);
        json(res, 201, {
          id: hook.id,
          name: hook.name,
          status: hook.status,
          topic: hook.topic,
          delivery_url: hook.delivery_url,
        });
        // The creation ping (WC-012): unsigned, `webhook_id=<id>`.
        site.pings.push(await post(hook.delivery_url, `webhook_id=${hook.id}`, {}));
        return;
      }
      const hookMatch = /^\/webhooks\/(\d+)$/.exec(rest);
      if (hookMatch) {
        const hook = site.webhooks.get(Number(hookMatch[1]));
        if (!hook) return restError(res, 404, 'woocommerce_rest_webhook_invalid_id', 'Invalid ID.');
        if (req.method === 'PUT') {
          if (
            parsed.status === 'active' ||
            parsed.status === 'paused' ||
            parsed.status === 'disabled'
          ) {
            hook.status = parsed.status;
            if (hook.status === 'active') hook.failures = 0;
          }
          return json(res, 200, {
            id: hook.id,
            status: hook.status,
            topic: hook.topic,
            delivery_url: hook.delivery_url,
          });
        }
        if (req.method === 'DELETE') {
          site.webhooks.delete(hook.id);
          return json(res, 200, { id: hook.id });
        }
      }
      return restError(
        res,
        404,
        'rest_no_route',
        'No route was found matching the URL and request method.',
      );
    })().catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error));
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const { port } = server.address() as AddressInfo;
  standIn.baseUrl = `http://${host}:${port}`;
  standIn.siteUrl = (path: string) => `${standIn.baseUrl}/${path}`;
  standIn.addSite = addSite;
  standIn.addKeys = addKeys;
  standIn.revokeKeys = (path: string) => siteOf(path).keys.clear();
  standIn.upsertOrder = upsertOrder;
  standIn.upsertProduct = upsertProduct;
  standIn.deliver = deliver;
  standIn.close = () =>
    new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return standIn;
}
