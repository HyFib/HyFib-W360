import { z } from 'zod';
import {
  constantTimeEqual,
  hmacSha256,
  hmacSha256Hex,
  randomToken as randomBase64Url,
  sha256Hex,
} from '@w360/core';
import { normalizePhone } from '../contacts/phone';
import { currencyDigits, isCurrency, parseAmountToMinor } from '../crm/money';
import { TOKEN_ALPHABET, randomToken } from '../growth/model';

/**
 * Store connectors (P4-06b): a company's own Shopify or WooCommerce store. Pure rules shared by the
 * web service, the webhook routes and the worker: addresses, handshake tokens, signatures, money and
 * the records HyFib keeps (research docs/research/store-connectors.md, SH-* and WC-*).
 */

export const STORE_LIMITS = {
  storesPerCompany: 5,
  /** How long a store owner has to approve HyFib after a member starts connecting. */
  connectMinutes: 15,
  /** How long the worker may take to finish connecting before the store is marked failed. */
  connectingMinutes: 30,
  /** Orders read when a store is connected: Shopify shares 60 days without read_all_orders (SH-012). */
  backfillDays: 60,
  productsPerStore: 20_000,
  orderItems: 100,
  /** Shipments read per Shopify order (SH-030) and payment names kept per order. */
  shopifyFulfillments: 10,
  paymentNames: 5,
  /** Page sizes keep a Shopify query well under its cost limit (SH-011). */
  shopifyOrdersPage: 20,
  shopifyLineItems: 25,
  shopifyProductsPage: 50,
  shopifyNodesPage: 20,
  /** Checkouts per page (SH-038) and items kept per checkout. */
  shopifyCheckoutsPage: 50,
  checkoutItems: 10,
  wooOrdersPage: 25,
  wooProductsPage: 50,
  /** Pages one job reads per resource before handing over to the next job. */
  pagesPerRun: 5,
  fetchesPerRun: 50,
  syncIntervalMinutes: 60,
  webhookCheckHours: 6,
  eventRetentionDays: 30,
  leaseMinutes: 5,
  /** Refresh a Shopify access token this long before it expires (SH-007). */
  refreshMarginMinutes: 5,
} as const;

// Addresses ----------------------------------------------------------------------------------------

/** A shop's myshopify.com name, lower case (SH-005; HyFib accepts only myshopify.com). */
export const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;

/**
 * Reads what a member typed as their Shopify store: "my-shop", "my-shop.myshopify.com",
 * "https://my-shop.myshopify.com/admin" or "admin.shopify.com/store/my-shop".
 */
export function normalizeShopDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value || value.length > 300) return null;
  value = value.replace(/^https?:\/\//, '');
  const admin = /^admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)(?:[/?#].*)?$/.exec(value);
  if (admin) value = `${admin[1]}.myshopify.com`;
  value = value.replace(/[/?#].*$/, '');
  if (!value.includes('.')) value = `${value}.myshopify.com`;
  return SHOP_DOMAIN_RE.test(value) ? value : null;
}

export type StoreUrlResult = { ok: true; url: string } | { ok: false; message: string };

/**
 * A WooCommerce site address as the REST API base: scheme, host, port and the WordPress path, with
 * no credentials, query or fragment. https only, except for local test sites (`allowHttp`, which
 * configuration permits only with APP_ENV=local|test).
 */
export function normalizeStoreUrl(input: string, allowHttp: boolean): StoreUrlResult {
  const raw = input.trim();
  if (!raw) return { ok: false, message: 'Enter your store’s address.' };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return {
      ok: false,
      message: 'Enter the store’s address, for example https://shop.example.com.',
    };
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    return {
      ok: false,
      message: 'The store must use https (WooCommerce accepts keys only over https).',
    };
  }
  if (url.username || url.password) {
    return { ok: false, message: 'Remove the user name and password from the address.' };
  }
  if (url.search || url.hash) {
    return { ok: false, message: 'Enter the site address without ? or # parts.' };
  }
  const path = url.pathname.replace(/\/+$/, '');
  const normalized = `${url.protocol}//${url.host.toLowerCase()}${path}`;
  if (normalized.length > 300) return { ok: false, message: 'The address is too long.' };
  if (/\s/.test(normalized)) return { ok: false, message: 'The address cannot contain spaces.' };
  return { ok: true, url: normalized };
}

// Handshakes, secrets and signatures ----------------------------------------------------------------

/** A single-use handshake token (Shopify `state`, WooCommerce `user_id`): 256 random bits. */
export const CONNECT_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newConnectToken(): { token: string; hash: string } {
  const token = randomBase64Url(32);
  return { token, hash: sha256Hex(token) };
}

export const connectTokenHash = (token: string) => sha256Hex(token);

/** WooCommerce webhook address ids (80 random bits) and signing secrets (256 bits). */
export const STORE_WEBHOOK_ID_RE = /^[a-z2-7]{16}$/;
export const newStoreWebhookId = () => randomToken(TOKEN_ALPHABET, 16);
export const newStoreWebhookSecret = () => randomBase64Url(32);

/** Keyring associated data binding a store's credentials and webhook secret to its row. */
export const storeCredentialsAad = (tenantId: string, storeId: string) =>
  `commerce-store:${tenantId}:${storeId}:credentials`;
export const storeWebhookSecretAad = (tenantId: string, storeId: string) =>
  `commerce-store:${tenantId}:${storeId}:webhook`;
/** An authorization code for more access on a connected store (its own column, its own binding). */
export const storeAccessCodeAad = (tenantId: string, storeId: string) =>
  `commerce-store:${tenantId}:${storeId}:access-code`;

/** What the credentials ciphertext holds at each stage. */
export const storeCredentialsSchema = z.discriminatedUnion('kind', [
  // Shopify's authorization code, waiting for the worker to exchange it.
  z.object({ kind: z.literal('shopify_code'), code: z.string().min(1).max(512) }),
  z.object({
    kind: z.literal('shopify_token'),
    accessToken: z.string().min(1).max(4096),
    refreshToken: z.string().min(1).max(4096).nullable(),
    refreshExpiresAt: z.iso.datetime().nullable(),
  }),
  z.object({
    kind: z.literal('woo_keys'),
    consumerKey: z.string().regex(/^ck_[A-Za-z0-9]{8,64}$/),
    consumerSecret: z.string().regex(/^cs_[A-Za-z0-9]{8,64}$/),
  }),
]);
export type StoreCredentials = z.infer<typeof storeCredentialsSchema>;

export const WOO_CONSUMER_KEY_RE = /^ck_[A-Za-z0-9]{8,64}$/;
export const WOO_CONSUMER_SECRET_RE = /^cs_[A-Za-z0-9]{8,64}$/;

/** Tolerance for the Shopify callback's `timestamp`, as in Shopify's own library (SH-004). */
export const SHOPIFY_CALLBACK_TOLERANCE_SECONDS = 90;

export type ShopifyCallbackCheck =
  { ok: true } | { ok: false; reason: 'missing_hmac' | 'bad_timestamp' | 'mismatch' };

/**
 * Verifies the query of Shopify's OAuth callback (SH-004): HMAC-SHA256 (hex) with the app secret
 * over the other parameters sorted by name and written as a URL query, and a timestamp within 90
 * seconds. Repeated parameters are joined with commas, as Shopify's library does.
 */
export function verifyShopifyCallback(
  params: URLSearchParams,
  secrets: readonly string[],
  nowMs: number,
): ShopifyCallbackCheck {
  const joined = new Map<string, string>();
  for (const [key, value] of params) {
    const existing = joined.get(key);
    joined.set(key, existing === undefined ? value : `${existing},${value}`);
  }
  const hmac = joined.get('hmac');
  if (!hmac) return { ok: false, reason: 'missing_hmac' };
  const timestamp = Number(joined.get('timestamp'));
  if (
    !Number.isInteger(timestamp) ||
    Math.abs(Math.trunc(nowMs / 1000) - timestamp) > SHOPIFY_CALLBACK_TOLERANCE_SECONDS
  ) {
    return { ok: false, reason: 'bad_timestamp' };
  }
  joined.delete('hmac');
  joined.delete('signature');
  const sorted = [...joined.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const message = new URLSearchParams(sorted).toString().replace(/\+/g, '%20');
  const valid = secrets.some((secret) =>
    constantTimeEqual(hmacSha256Hex(secret, message), hmac.toLowerCase()),
  );
  return valid ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** Shopify webhook deliveries: base64 HMAC-SHA256 of the raw body with the app secret (SH-024). */
export function verifyShopifyWebhook(
  rawBody: Buffer,
  signature: string | null,
  secrets: readonly string[],
): boolean {
  if (!signature || rawBody.length === 0) return false;
  return secrets.some((secret) =>
    constantTimeEqual(hmacSha256(secret, rawBody).toString('base64'), signature.trim()),
  );
}

/** WooCommerce deliveries: base64 HMAC-SHA256 of the raw body with the store's secret (WC-014). */
export function verifyWooWebhook(
  rawBody: Buffer,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || rawBody.length === 0) return false;
  return constantTimeEqual(hmacSha256(secret, rawBody).toString('base64'), signature.trim());
}

/** WooCommerce's creation ping: `webhook_id=<id>`, unsigned (WC-012). */
export const WOO_PING_RE = /^webhook_id=[0-9]{1,20}$/;

// Redirects -----------------------------------------------------------------------------------------

export const SHOPIFY_SCOPES = ['read_orders', 'read_products'] as const;

/**
 * Customer access, asked for only when a manager allows it for cart reminders (SH-041, SH-042):
 * the customer's phone and the WhatsApp consent Shopify records for it.
 */
export const SHOPIFY_CUSTOMER_SCOPE = 'read_customers';

/** Shopify records WhatsApp consent from this Admin API version on (SH-041). */
export const SHOPIFY_CONSENT_API_VERSION = '2026-07';
export const shopifyConsentSupported = (apiVersion: string | null | undefined) =>
  typeof apiVersion === 'string' && /^\d{4}-\d{2}$/.test(apiVersion)
    ? apiVersion >= SHOPIFY_CONSENT_API_VERSION
    : false;

/** The scopes an authorization of this store asks for. */
export function shopifyScopesFor(store: { customerAccessRequestedAt: Date | null }): string[] {
  return store.customerAccessRequestedAt
    ? [...SHOPIFY_SCOPES, SHOPIFY_CUSTOMER_SCOPE]
    : [...SHOPIFY_SCOPES];
}

/** Whether the store's current token was granted customer access. */
export const hasCustomerAccess = (grantedScopes: string | null) =>
  (grantedScopes ?? '').split(',').some((scope) => scope.trim() === SHOPIFY_CUSTOMER_SCOPE);

/** The authorize URL for an offline token (SH-003): `grant_options[]` empty, as Shopify's library. */
export function shopifyAuthorizeUrl(
  shopOrigin: string,
  input: { clientId: string; redirectUri: string; state: string; scopes?: readonly string[] },
): string {
  const query = new URLSearchParams([
    ['client_id', input.clientId],
    ['scope', (input.scopes ?? SHOPIFY_SCOPES).join(',')],
    ['redirect_uri', input.redirectUri],
    ['state', input.state],
    ['grant_options[]', ''],
  ]);
  return `${shopOrigin}/admin/oauth/authorize?${query.toString().replace(/\+/g, '%20')}`;
}

/** WooCommerce's app authentication endpoint (WC-002), asking for Read/Write keys (WC-004). */
export function wooAuthorizeUrl(
  storeUrl: string,
  input: { appName: string; userId: string; returnUrl: string; callbackUrl: string },
): string {
  const query = new URLSearchParams([
    ['app_name', input.appName],
    ['scope', 'read_write'],
    ['user_id', input.userId],
    ['return_url', input.returnUrl],
    ['callback_url', input.callbackUrl],
  ]);
  return `${storeUrl}/wc-auth/v1/authorize?${query.toString().replace(/\+/g, '%20')}`;
}

// Records -------------------------------------------------------------------------------------------

export interface StoreOrderItemRecord {
  title: string;
  sku: string | null;
  quantity: number;
  totalMinor: number | null;
}

export interface StoreOrderRecord {
  externalId: string;
  name: string;
  status: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  test: boolean;
  currency: string | null;
  totalMinor: number | null;
  itemsTruncated: boolean;
  placedAt: Date;
  cancelledAt: Date | null;
  remoteUpdatedAt: Date;
  customerName: string | null;
  /** As the store gave it; linked to contacts only once it reads as an E.164 number. */
  customerPhone: string | null;
  customerEmail: string | null;
  statusUrl: string | null;
  /** Payment method names as the store gives them (Shopify gateways, SH-031; the WooCommerce title). */
  paymentNames: string[];
  cashOnDelivery: boolean;
  /** The first shipment that was not cancelled (Shopify) or the completion (WooCommerce, WC-022). */
  shippedAt: Date | null;
  /** When every shipment of a fully shipped order was delivered (Shopify only, SH-030). */
  deliveredAt: Date | null;
  /** The latest shipment's tracking (Shopify only). */
  trackingCompany: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  items: StoreOrderItemRecord[];
}

/** Shopify's WhatsApp marketing consent for a checkout's number (SH-041), as read. */
export interface StoreCheckoutConsent {
  state: 'NEVER_SUBSCRIBED' | 'PENDING' | 'REDACTED' | 'SUBSCRIBED' | 'UNSUBSCRIBED' | null;
  optInLevel: 'SINGLE_OPT_IN' | 'CONFIRMED_OPT_IN' | 'UNKNOWN' | null;
  collectedFrom: 'SHOPIFY' | 'OTHER' | null;
  updatedAt: Date | null;
}

/** A checkout a customer left in a Shopify store (SH-039). */
export interface StoreCheckoutRecord {
  externalId: string;
  name: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  customerExternalId: string | null;
  customerName: string | null;
  /**
   * As Shopify gives it: the customer's default phone (with customer access), else the shipping or
   * billing phone. Linked to contacts only once it reads as an E.164 number.
   */
  phone: string | null;
  /** The consent Shopify records for `phone`, only when `phone` is the customer's default phone. */
  consent: StoreCheckoutConsent | null;
  currency: string | null;
  totalMinor: number | null;
  items: { title: string; quantity: number }[];
  itemCount: number | null;
  recoveryUrl: string | null;
}

export interface StoreProductRecord {
  externalId: string;
  title: string;
  status: string;
  sku: string | null;
  url: string | null;
  currency: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  inventory: number | null;
  variants: number | null;
  remoteUpdatedAt: Date;
}

export const EXTERNAL_ID_RE = /^[0-9]{1,20}$/;

/**
 * A store's decimal amount string (Shopify `Decimal`/`Money`, SH-015; WooCommerce totals, WC-008)
 * in minor units, exactly. Digits beyond the currency's decimals are accepted only when they are
 * zeros ("29.990" INR is 2999); anything else, and anything that is not a plain non-negative
 * decimal, is unknown (null), never rounded.
 */
export function storeAmountToMinor(value: unknown, currency: string | null): number | null {
  if (typeof value !== 'string' || !currency || !isCurrency(currency)) return null;
  const m = /^(\d{1,16})(?:\.(\d{1,12}))?$/.exec(value.trim());
  if (!m) return null;
  const digits = currencyDigits(currency);
  let fraction = m[2] ?? '';
  if (fraction.length > digits) {
    if (!/^0+$/.test(fraction.slice(digits))) return null;
    fraction = fraction.slice(0, digits);
  }
  return parseAmountToMinor(fraction ? `${m[1]}.${fraction}` : (m[1] as string), currency);
}

/**
 * A customer's number from a store as E.164, or null. Numbers without a country code are read as
 * national numbers only when the company set the store's calling code; otherwise they stay unlinked
 * (a number is never guessed).
 */
export function storeCustomerPhone(raw: string | null, callingCode: string | null): string | null {
  if (!raw) return null;
  const result = normalizePhone(
    raw,
    callingCode ? { kind: 'national', callingCode } : { kind: 'explicit' },
  );
  return result.ok ? result.e164 : null;
}

/** Text from a store, trimmed to a column's limit; empty becomes null. */
export function clip(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** A timestamp from a store, or null when it does not parse. */
export function storeDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  // WooCommerce's *_gmt fields carry no zone designator (WC-008): they are UTC.
  const text = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A status word as stored: lower-case letters, underscores and hyphens (spaces become underscores,
 * anything else is dropped).
 */
export function statusWord(value: unknown, max = 40): string | null {
  if (typeof value !== 'string') return null;
  const word = value
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, '_')
    .replace(/[^a-z_-]/g, '')
    .slice(0, max);
  return word || null;
}

/** An email as stored: trimmed, lower case, at most 320 characters, roughly shaped like one. */
export function storeEmail(value: unknown): string | null {
  const text = clip(value, 320);
  if (!text) return null;
  const lower = text.toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(lower) ? lower : null;
}

/**
 * Whether a payment method name means cash on delivery. Shopify's own example of a gateway name is
 * "Cash on Delivery (COD)" (SH-031); a name containing "cash on delivery" counts, other manual
 * payment names do not. WooCommerce orders are read by the gateway id instead (WC-021).
 */
export function isCashOnDeliveryName(name: string): boolean {
  return /cash\s+on\s+delivery/i.test(name);
}

/** Payment method names as stored: clipped, without duplicates, at most STORE_LIMITS.paymentNames. */
export function paymentNameList(values: unknown[]): string[] {
  const names: string[] = [];
  for (const value of values) {
    const name = clip(value, 100);
    if (name && !names.includes(name)) names.push(name);
    if (names.length === STORE_LIMITS.paymentNames) break;
  }
  return names;
}

/** An https URL as stored (other schemes are dropped). */
export function httpsUrl(value: unknown, max = 1000): string | null {
  if (typeof value !== 'string' || value.length > max) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
