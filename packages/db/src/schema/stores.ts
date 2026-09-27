import { bigint, boolean, integer, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { appSchema } from './tenancy';

/**
 * Store connectors (migration 0019): a company's own Shopify or WooCommerce store, and the copy of
 * its orders and products HyFib keeps in step with it. Webhooks only say what to fetch; money is
 * integer minor units.
 */
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const money = (name: string) => bigint(name, { mode: 'number' });

export const STORE_PLATFORMS = ['shopify', 'woocommerce'] as const;
export type StorePlatform = (typeof STORE_PLATFORMS)[number];

export const STORE_STATES = [
  'authorizing',
  'connecting',
  'connected',
  'failed',
  'uninstalled',
  'removing',
] as const;
export type StoreState = (typeof STORE_STATES)[number];

export const commerceStores = appSchema.table('commerce_stores', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  platform: text('platform', { enum: STORE_PLATFORMS }).notNull(),
  shopDomain: text('shop_domain'),
  storeUrl: text('store_url').notNull(),
  name: text('name'),
  currency: text('currency'),
  shopExternalId: text('shop_external_id'),
  state: text('state', { enum: STORE_STATES }).notNull().default('authorizing'),
  statusError: text('status_error'),
  /** Keyring ciphertext bound to the row (storeCredentialsAad); never sent to browsers. */
  credentialsCiphertext: text('credentials_ciphertext'),
  credentialsVersion: integer('credentials_version').notNull().default(1),
  accessExpiresAt: tz('access_expires_at'),
  grantedScopes: text('granted_scopes'),
  connectTokenHash: text('connect_token_hash'),
  connectMembershipId: uuid('connect_membership_id'),
  connectExpiresAt: tz('connect_expires_at'),
  webhookPublicId: text('webhook_public_id'),
  webhookSecretCiphertext: text('webhook_secret_ciphertext'),
  webhooksCheckedAt: tz('webhooks_checked_at'),
  webhookError: text('webhook_error'),
  phoneCallingCode: text('phone_calling_code'),
  ordersCursor: tz('orders_cursor'),
  ordersPage: text('orders_page'),
  productsCursor: tz('products_cursor'),
  productsPage: text('products_page'),
  productsTruncated: boolean('products_truncated').notNull().default(false),
  detailsWithheld: boolean('details_withheld').notNull().default(false),
  backfilledAt: tz('backfilled_at'),
  syncedAt: tz('synced_at'),
  nextSyncAt: tz('next_sync_at'),
  syncError: text('sync_error'),
  leaseUntil: tz('lease_until'),
  uninstalledAt: tz('uninstalled_at'),
  version: integer('version').notNull().default(1),
  createdByMembershipId: uuid('created_by_membership_id').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const commerceStoreProducts = appSchema.table('commerce_store_products', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  storeId: uuid('store_id').notNull(),
  externalId: text('external_id').notNull(),
  title: text('title').notNull(),
  status: text('status').notNull(),
  sku: text('sku'),
  url: text('url'),
  currency: text('currency'),
  priceMinMinor: money('price_min_minor'),
  priceMaxMinor: money('price_max_minor'),
  inventory: integer('inventory'),
  variants: integer('variants'),
  remoteUpdatedAt: tz('remote_updated_at').notNull(),
  deletedAt: tz('deleted_at'),
  syncedAt: tz('synced_at').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const commerceStoreOrders = appSchema.table('commerce_store_orders', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  storeId: uuid('store_id').notNull(),
  externalId: text('external_id').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  financialStatus: text('financial_status'),
  fulfillmentStatus: text('fulfillment_status'),
  test: boolean('test').notNull().default(false),
  currency: text('currency'),
  totalMinor: money('total_minor'),
  itemsTruncated: boolean('items_truncated').notNull().default(false),
  placedAt: tz('placed_at').notNull(),
  cancelledAt: tz('cancelled_at'),
  remoteUpdatedAt: tz('remote_updated_at').notNull(),
  customerName: text('customer_name'),
  customerPhone: text('customer_phone'),
  customerEmail: text('customer_email'),
  statusUrl: text('status_url'),
  redactedAt: tz('redacted_at'),
  deletedAt: tz('deleted_at'),
  syncedAt: tz('synced_at').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const commerceStoreOrderItems = appSchema.table('commerce_store_order_items', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  orderId: uuid('order_id').notNull(),
  position: smallint('position').notNull(),
  title: text('title').notNull(),
  sku: text('sku'),
  quantity: integer('quantity').notNull(),
  totalMinor: money('total_minor'),
});

export const STORE_FETCH_KINDS = ['order', 'product'] as const;
export type StoreFetchKind = (typeof STORE_FETCH_KINDS)[number];

export const commerceStoreFetches = appSchema.table('commerce_store_fetches', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  storeId: uuid('store_id').notNull(),
  kind: text('kind', { enum: STORE_FETCH_KINDS }).notNull(),
  externalId: text('external_id').notNull(),
  requestedAt: tz('requested_at').notNull().defaultNow(),
});

export const commerceStoreEvents = appSchema.table('commerce_store_events', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  storeId: uuid('store_id').notNull(),
  deliveryId: text('delivery_id').notNull(),
  topic: text('topic').notNull(),
  receivedAt: tz('received_at').notNull().defaultNow(),
});

export const STORE_PRIVACY_KINDS = ['data_request', 'redact'] as const;
export type StorePrivacyKind = (typeof STORE_PRIVACY_KINDS)[number];

export const commerceStorePrivacyRequests = appSchema.table('commerce_store_privacy_requests', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  storeId: uuid('store_id').notNull(),
  kind: text('kind', { enum: STORE_PRIVACY_KINDS }).notNull(),
  customerEmail: text('customer_email'),
  customerPhone: text('customer_phone'),
  orderIds: text('order_ids').array().notNull().default([]),
  ordersRedacted: integer('orders_redacted'),
  receivedAt: tz('received_at').notNull().defaultNow(),
  answeredAt: tz('answered_at'),
  answeredByMembershipId: uuid('answered_by_membership_id'),
});
