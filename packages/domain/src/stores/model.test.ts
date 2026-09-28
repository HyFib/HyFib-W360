import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StoreApiError, expectOk } from './http';
import {
  CONNECT_TOKEN_RE,
  STORE_WEBHOOK_ID_RE,
  connectTokenHash,
  newConnectToken,
  newStoreWebhookId,
  normalizeShopDomain,
  normalizeStoreUrl,
  shopifyAuthorizeUrl,
  storeAmountToMinor,
  storeCustomerPhone,
  storeDate,
  verifyShopifyCallback,
  verifyShopifyWebhook,
  verifyWooWebhook,
  wooAuthorizeUrl,
} from './model';
import { gidNumber, parseShopifyOrder, parseShopifyProduct, throttleWaitSeconds } from './shopify';
import { parseWooOrder, parseWooProduct } from './woocommerce';

const SECRET = 'app-secret';

/** Shopify's callback HMAC written out independently of the code under test (SH-004). */
function signedQuery(params: Record<string, string>, secret = SECRET): URLSearchParams {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k] as string)}`)
    .join('&');
  const hmac = createHmac('sha256', secret).update(sorted).digest('hex');
  return new URLSearchParams({ ...params, hmac });
}

describe('store addresses', () => {
  it('reads what members type as their Shopify store', () => {
    expect(normalizeShopDomain('my-shop')).toBe('my-shop.myshopify.com');
    expect(normalizeShopDomain(' My-Shop.myshopify.com ')).toBe('my-shop.myshopify.com');
    expect(normalizeShopDomain('https://my-shop.myshopify.com/admin/orders')).toBe(
      'my-shop.myshopify.com',
    );
    expect(normalizeShopDomain('admin.shopify.com/store/my-shop/orders')).toBe(
      'my-shop.myshopify.com',
    );
    expect(normalizeShopDomain('shop.example.com')).toBeNull();
    expect(normalizeShopDomain('-bad.myshopify.com')).toBeNull();
    expect(normalizeShopDomain('evil.myshopify.com.attacker.test')).toBeNull();
    expect(normalizeShopDomain('')).toBeNull();
  });

  it('keeps WooCommerce addresses to https sites without credentials, queries or fragments', () => {
    expect(normalizeStoreUrl('shop.example.com/', false)).toEqual({
      ok: true,
      url: 'https://shop.example.com',
    });
    expect(normalizeStoreUrl('https://Shop.Example.com/wp/', false)).toEqual({
      ok: true,
      url: 'https://shop.example.com/wp',
    });
    expect(normalizeStoreUrl('http://shop.example.com', false)).toMatchObject({ ok: false });
    expect(normalizeStoreUrl('http://127.0.0.1:4040/site', true)).toEqual({
      ok: true,
      url: 'http://127.0.0.1:4040/site',
    });
    expect(normalizeStoreUrl('https://user:pass@shop.example.com', false)).toMatchObject({
      ok: false,
    });
    expect(normalizeStoreUrl('https://shop.example.com/?x=1', false)).toMatchObject({ ok: false });
    expect(normalizeStoreUrl('ftp://shop.example.com', true)).toMatchObject({ ok: false });
    expect(normalizeStoreUrl('   ', false)).toMatchObject({ ok: false });
  });

  it('builds the approval addresses with the documented parameters', () => {
    const shopify = new URL(
      shopifyAuthorizeUrl('https://my-shop.myshopify.com', {
        clientId: 'client',
        redirectUri: 'https://app.test/api/stores/shopify/callback',
        state: 'state-1',
      }),
    );
    expect(shopify.origin + shopify.pathname).toBe(
      'https://my-shop.myshopify.com/admin/oauth/authorize',
    );
    expect(Object.fromEntries(shopify.searchParams)).toEqual({
      client_id: 'client',
      scope: 'read_orders,read_products',
      redirect_uri: 'https://app.test/api/stores/shopify/callback',
      state: 'state-1',
      'grant_options[]': '',
    });
    const woo = new URL(
      wooAuthorizeUrl('https://shop.example.com/wp', {
        appName: 'HyFib W360',
        userId: 'token',
        returnUrl: 'https://app.test/c/acme/commerce/stores/1',
        callbackUrl: 'https://app.test/api/stores/woocommerce/callback',
      }),
    );
    expect(woo.pathname).toBe('/wp/wc-auth/v1/authorize');
    expect(Object.fromEntries(woo.searchParams)).toEqual({
      app_name: 'HyFib W360',
      scope: 'read_write',
      user_id: 'token',
      return_url: 'https://app.test/c/acme/commerce/stores/1',
      callback_url: 'https://app.test/api/stores/woocommerce/callback',
    });
  });

  it('makes single-use handshake tokens and webhook ids of the right shape', () => {
    for (let i = 0; i < 20; i += 1) {
      const { token, hash } = newConnectToken();
      expect(token).toMatch(CONNECT_TOKEN_RE);
      expect(hash).toBe(connectTokenHash(token));
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(newStoreWebhookId()).toMatch(STORE_WEBHOOK_ID_RE);
    }
  });
});

describe('signatures', () => {
  const now = Date.UTC(2026, 8, 27, 10, 0, 0);
  const base = {
    code: 'abc',
    host: 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvbXktc2hvcA',
    shop: 'my-shop.myshopify.com',
    state: 'x y+z',
    timestamp: String(now / 1000),
  };

  it('accepts Shopify’s callback signed with the current or previous secret', () => {
    expect(verifyShopifyCallback(signedQuery(base), [SECRET], now)).toEqual({ ok: true });
    expect(verifyShopifyCallback(signedQuery(base, 'old'), [SECRET, 'old'], now)).toEqual({
      ok: true,
    });
  });

  it('refuses a tampered, unsigned or stale callback', () => {
    const tampered = signedQuery(base);
    tampered.set('shop', 'other.myshopify.com');
    expect(verifyShopifyCallback(tampered, [SECRET], now)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    const unsigned = new URLSearchParams(base);
    expect(verifyShopifyCallback(unsigned, [SECRET], now)).toEqual({
      ok: false,
      reason: 'missing_hmac',
    });
    expect(verifyShopifyCallback(signedQuery(base), [SECRET], now + 91_000)).toEqual({
      ok: false,
      reason: 'bad_timestamp',
    });
    expect(verifyShopifyCallback(signedQuery(base), ['other'], now)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('verifies webhook bodies byte for byte', () => {
    const body = Buffer.from('{"id":1,"updated_at":"2026-09-27T10:00:00Z"}');
    const shopifySig = createHmac('sha256', SECRET).update(body).digest('base64');
    expect(verifyShopifyWebhook(body, shopifySig, [SECRET])).toBe(true);
    expect(verifyShopifyWebhook(body, shopifySig, ['wrong', SECRET])).toBe(true);
    expect(verifyShopifyWebhook(Buffer.from(`${body.toString()} `), shopifySig, [SECRET])).toBe(
      false,
    );
    expect(verifyShopifyWebhook(body, null, [SECRET])).toBe(false);
    expect(verifyShopifyWebhook(Buffer.alloc(0), shopifySig, [SECRET])).toBe(false);
    const wooSig = createHmac('sha256', 'store-secret').update(body).digest('base64');
    expect(verifyWooWebhook(body, wooSig, 'store-secret')).toBe(true);
    expect(verifyWooWebhook(body, wooSig, 'other')).toBe(false);
  });
});

describe('money and people', () => {
  it('converts store amounts to minor units exactly and never rounds', () => {
    expect(storeAmountToMinor('29.99', 'INR')).toBe(2999);
    expect(storeAmountToMinor('29.990', 'INR')).toBe(2999);
    expect(storeAmountToMinor('29', 'INR')).toBe(2900);
    expect(storeAmountToMinor('29.999', 'INR')).toBeNull();
    expect(storeAmountToMinor('1500', 'JPY')).toBe(1500);
    expect(storeAmountToMinor('1.5', 'JPY')).toBeNull();
    expect(storeAmountToMinor('12.345', 'BHD')).toBe(12345);
    expect(storeAmountToMinor('-1.00', 'INR')).toBeNull();
    expect(storeAmountToMinor('1e3', 'INR')).toBeNull();
    expect(storeAmountToMinor(29.99, 'INR')).toBeNull();
    expect(storeAmountToMinor('10.00', 'ZZZ')).toBeNull();
    expect(storeAmountToMinor('10.00', null)).toBeNull();
  });

  it('links numbers only when they read as international numbers', () => {
    expect(storeCustomerPhone('+91 98123 45678', null)).toBe('+919812345678');
    expect(storeCustomerPhone('0091-98123-45678', null)).toBe('+919812345678');
    expect(storeCustomerPhone('09876543210', null)).toBeNull();
    expect(storeCustomerPhone('09876543210', '91')).toBe('+919876543210');
    expect(storeCustomerPhone('call me', '91')).toBeNull();
    expect(storeCustomerPhone(null, '91')).toBeNull();
  });

  it('reads WooCommerce GMT times without a zone as UTC', () => {
    expect(storeDate('2026-09-27T10:00:00')?.toISOString()).toBe('2026-09-27T10:00:00.000Z');
    expect(storeDate('2026-09-27T10:00:00Z')?.toISOString()).toBe('2026-09-27T10:00:00.000Z');
    expect(storeDate('not a date')).toBeNull();
  });
});

describe('records', () => {
  const money = (amount: string, currencyCode = 'INR') => ({ shopMoney: { amount, currencyCode } });

  it('reads Shopify orders: statuses, exact totals and the customer as shared', () => {
    const order = parseShopifyOrder({
      id: 'gid://shopify/Order/123',
      name: '#1001',
      createdAt: '2026-09-01T00:00:00Z',
      processedAt: '2026-08-31T12:00:00Z',
      updatedAt: '2026-09-02T00:00:00Z',
      cancelledAt: null,
      closed: true,
      test: false,
      displayFinancialStatus: 'PARTIALLY_REFUNDED',
      displayFulfillmentStatus: 'FULFILLED',
      totalPriceSet: money('1999.50'),
      phone: null,
      email: 'A@B.CO',
      shippingAddress: { name: 'Asha', phone: '+919800000001' },
      billingAddress: null,
      statusPageUrl: 'https://my-shop.myshopify.com/status/1',
      lineItems: {
        nodes: [
          { name: 'Tea', sku: 'T', quantity: 2, discountedTotalSet: money('1000.00') },
          { name: 'Cup', sku: null, quantity: 1, discountedTotalSet: money('10.00', 'USD') },
        ],
        pageInfo: { hasNextPage: true },
      },
    });
    expect(order).toMatchObject({
      externalId: '123',
      status: 'closed',
      financialStatus: 'partially_refunded',
      fulfillmentStatus: 'fulfilled',
      totalMinor: 199950,
      currency: 'INR',
      placedAt: new Date('2026-08-31T12:00:00Z'),
      customerName: 'Asha',
      customerPhone: '+919800000001',
      customerEmail: 'a@b.co',
      itemsTruncated: true,
    });
    // A line in another currency than the order has no amount.
    expect(order?.items).toEqual([
      { title: 'Tea', sku: 'T', quantity: 2, totalMinor: 100000 },
      { title: 'Cup', sku: null, quantity: 1, totalMinor: null },
    ]);
    expect(
      parseShopifyOrder({ id: 'gid://shopify/Product/1', updatedAt: '2026-09-02T00:00:00Z' }),
    ).toBeNull();
    expect(
      parseShopifyOrder({
        id: 'gid://shopify/Order/9',
        processedAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-02T00:00:00Z',
        cancelledAt: '2026-09-02T00:00:00Z',
        totalPriceSet: money('5.00'),
      })?.status,
    ).toBe('cancelled');
  });

  it('reads Shopify products: price range, and a SKU only for single-variant products', () => {
    const base = {
      id: 'gid://shopify/Product/7',
      title: 'Tea',
      status: 'ACTIVE',
      updatedAt: '2026-09-02T00:00:00Z',
      onlineStoreUrl: 'https://shop.example/products/tea',
      totalInventory: 12,
      tracksInventory: true,
      priceRangeV2: {
        minVariantPrice: { amount: '5.00', currencyCode: 'INR' },
        maxVariantPrice: { amount: '9.00', currencyCode: 'INR' },
      },
      variants: { nodes: [{ sku: 'T-1' }] },
    };
    expect(parseShopifyProduct({ ...base, variantsCount: { count: 2 } })).toMatchObject({
      externalId: '7',
      status: 'active',
      sku: null,
      priceMinMinor: 500,
      priceMaxMinor: 900,
      inventory: 12,
      variants: 2,
    });
    expect(
      parseShopifyProduct({ ...base, variantsCount: { count: 1 }, tracksInventory: false }),
    ).toMatchObject({
      sku: 'T-1',
      inventory: null,
    });
    expect(gidNumber('gid://shopify/Order/123', 'Order')).toBe('123');
    expect(gidNumber('gid://shopify/Order/123', 'Product')).toBeNull();
  });

  it('reads WooCommerce orders and products from the REST shapes', () => {
    const order = parseWooOrder(
      {
        id: 41,
        number: '41',
        status: 'on-hold',
        currency: 'INR',
        total: '1234.50',
        date_created_gmt: '2026-09-01T10:00:00',
        date_modified_gmt: '2026-09-02T10:00:00',
        billing: { first_name: 'Ravi', last_name: 'S', email: 'R@X.IN', phone: '9900011122' },
        line_items: [
          { id: 1, name: 'Mug', sku: 'MUG', quantity: 3, total: '1234.50', price: 411.5 },
        ],
      },
      'INR',
    );
    expect(order).toMatchObject({
      externalId: '41',
      name: '#41',
      status: 'on-hold',
      totalMinor: 123450,
      customerName: 'Ravi S',
      customerPhone: '9900011122',
      customerEmail: 'r@x.in',
      remoteUpdatedAt: new Date('2026-09-02T10:00:00Z'),
      items: [{ title: 'Mug', sku: 'MUG', quantity: 3, totalMinor: 123450 }],
    });
    expect(parseWooOrder({ id: -1, date_created_gmt: '2026-09-01T10:00:00' }, 'INR')).toBeNull();
    expect(
      parseWooProduct(
        {
          id: 9,
          name: 'Mug',
          status: 'publish',
          price: '411.50',
          variations: [1, 2],
          date_modified_gmt: '2026-09-02T10:00:00',
        },
        'INR',
      ),
    ).toMatchObject({
      externalId: '9',
      priceMinMinor: 41150,
      priceMaxMinor: 41150,
      variants: 2,
      currency: 'INR',
    });
  });
});

describe('store API errors', () => {
  const response = (
    status: number,
    headers: Record<string, string> = {},
    json: unknown = null,
  ) => ({
    status,
    headers,
    json,
  });
  const failure = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      return error instanceof StoreApiError ? error : null;
    }
    return null;
  };

  it('maps statuses to what the worker does next', () => {
    expect(() => expectOk(response(200), 'x')).not.toThrow();
    expect(
      failure(() => expectOk(response(401, {}, { message: 'Consumer key is invalid.' }), 'x')),
    ).toMatchObject({
      failure: 'unauthorized',
      message: 'x was refused (HTTP 401): Consumer key is invalid.',
    });
    expect(failure(() => expectOk(response(404), 'x'))?.failure).toBe('not_found');
    expect(failure(() => expectOk(response(429, { 'retry-after': '2.5' }), 'x'))).toMatchObject({
      failure: 'throttled',
      retryAfterSeconds: 3,
    });
    expect(failure(() => expectOk(response(302), 'x'))?.failure).toBe('rejected');
    expect(failure(() => expectOk(response(503), 'x'))?.failure).toBe('server');
    expect(throttleWaitSeconds({ requested: 200, available: 50, restoreRate: 50 }, 200)).toBe(4);
    expect(throttleWaitSeconds(null, 200)).toBe(30);
  });
});
