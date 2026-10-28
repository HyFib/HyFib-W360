import { bigint, boolean, integer, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { jsonb } from './columns';
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
  /** Order messages (0020): who confirmed the customers' opt-in, the sending window, test orders. */
  messagesOptInAt: tz('messages_opt_in_at'),
  messagesOptInMembershipId: uuid('messages_opt_in_membership_id'),
  sendWindowStart: smallint('send_window_start'),
  sendWindowEnd: smallint('send_window_end'),
  messageTestOrders: boolean('message_test_orders').notNull().default(false),
  /**
   * Cart reminders (0021): the checkout read (cursor, Shopify's page cursor while a read continues,
   * when the next read is due), the request for customer access and its sealed authorization code
   * (keyring ciphertext bound to the row, like the credentials), and who chose to use the WhatsApp
   * consent Shopify records.
   */
  checkoutsCursor: tz('checkouts_cursor'),
  checkoutsPage: text('checkouts_page'),
  checkoutsReadAt: tz('checkouts_read_at'),
  checkoutsError: text('checkouts_error'),
  customerAccessRequestedAt: tz('customer_access_requested_at'),
  accessCodeCiphertext: text('access_code_ciphertext'),
  accessError: text('access_error'),
  storeConsentAt: tz('store_consent_at'),
  storeConsentMembershipId: uuid('store_consent_membership_id'),
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
  /** Milestones and payment (0020): what order messages are about. */
  paymentNames: text('payment_names').array().notNull().default([]),
  cashOnDelivery: boolean('cash_on_delivery').notNull().default(false),
  shippedAt: tz('shipped_at'),
  deliveredAt: tz('delivered_at'),
  trackingCompany: text('tracking_company'),
  trackingNumber: text('tracking_number'),
  trackingUrl: text('tracking_url'),
  trackedAt: tz('tracked_at'),
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

/** Shopify's WhatsApp marketing consent states and details (SH-041). */
export const STORE_CONSENT_STATES = [
  'NEVER_SUBSCRIBED',
  'PENDING',
  'REDACTED',
  'SUBSCRIBED',
  'UNSUBSCRIBED',
] as const;
export type StoreConsentState = (typeof STORE_CONSENT_STATES)[number];
export const STORE_CONSENT_OPT_IN_LEVELS = [
  'SINGLE_OPT_IN',
  'CONFIRMED_OPT_IN',
  'UNKNOWN',
] as const;
export const STORE_CONSENT_COLLECTED_FROM = ['SHOPIFY', 'OTHER'] as const;

/**
 * Checkouts customers left in a Shopify store (migration 0021), read while a cart reminder is on;
 * redacted for good with the customer and deleted 30 days after their last update.
 */
export const commerceStoreCheckouts = appSchema.table('commerce_store_checkouts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  storeId: uuid('store_id').notNull(),
  externalId: text('external_id').notNull(),
  name: text('name'),
  remoteCreatedAt: tz('remote_created_at').notNull(),
  remoteUpdatedAt: tz('remote_updated_at').notNull(),
  completedAt: tz('completed_at'),
  customerExternalId: text('customer_external_id'),
  customerName: text('customer_name'),
  customerPhone: text('customer_phone'),
  consentState: text('consent_state', { enum: STORE_CONSENT_STATES }),
  consentUpdatedAt: tz('consent_updated_at'),
  consentOptInLevel: text('consent_opt_in_level', { enum: STORE_CONSENT_OPT_IN_LEVELS }),
  consentCollectedFrom: text('consent_collected_from', { enum: STORE_CONSENT_COLLECTED_FROM }),
  currency: text('currency'),
  totalMinor: money('total_minor'),
  items: jsonb('items').$type<{ title: string; quantity: number }[]>().notNull().default([]),
  itemCount: integer('item_count'),
  recoveryUrl: text('recovery_url'),
  redactedAt: tz('redacted_at'),
  readAt: tz('read_at').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

/**
 * A Shopify order's shipments (fulfillments) as HyFib last read them with the order (migration
 * 0323, ADR-413): what shipment messages are about. `trackingKeys` are digests of the distinct
 * tracking numbers and links seen for the shipment (at most ten); the tracking and its digests go
 * with the customer's details when the order is redacted.
 */
export const commerceStoreShipments = appSchema.table('commerce_store_shipments', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  storeId: uuid('store_id').notNull(),
  orderId: uuid('order_id').notNull(),
  externalId: text('external_id').notNull(),
  status: text('status'),
  displayStatus: text('display_status'),
  failed: boolean('failed').notNull().default(false),
  remoteCreatedAt: tz('remote_created_at').notNull(),
  remoteUpdatedAt: tz('remote_updated_at').notNull(),
  trackingCompany: text('tracking_company'),
  trackingNumber: text('tracking_number'),
  trackingUrl: text('tracking_url'),
  trackingKeys: text('tracking_keys').array().notNull().default([]),
  syncedAt: tz('synced_at').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

/**
 * Order messages (migration 0020): the template a store sends when one of its orders reaches an
 * event, and the messages themselves (at most one per order and event; per shipment, and per
 * shipment and tracking, for the shipment events of migration 0323).
 */
export const STORE_MESSAGE_EVENTS = [
  'order_placed',
  'cod_confirmation',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
  'shipment_created',
  'tracking_updated',
  'cart_reminder',
  'cart_second_reminder',
] as const;
export type StoreMessageEvent = (typeof STORE_MESSAGE_EVENTS)[number];

export const commerceStoreMessageRules = appSchema.table('commerce_store_message_rules', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  storeId: uuid('store_id').notNull(),
  event: text('event', { enum: STORE_MESSAGE_EVENTS }).notNull(),
  enabled: boolean('enabled').notNull().default(false),
  enabledAt: tz('enabled_at'),
  channelAccountId: uuid('channel_account_id'),
  /** Send the rule's template, or start `automationId` (order events only; migration 0022). */
  action: text('action', { enum: ['template', 'automation'] })
    .notNull()
    .default('template'),
  automationId: uuid('automation_id'),
  templateId: uuid('template_id'),
  variables: jsonb('variables').notNull().default({ header: [], body: [] }),
  delayMinutes: integer('delay_minutes').notNull().default(0),
  confirmButton: smallint('confirm_button'),
  cancelButton: smallint('cancel_button'),
  version: integer('version').notNull().default(1),
  updatedByMembershipId: uuid('updated_by_membership_id').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

/** `started`: the rule started an automation run (migration 0022). */
export const STORE_MESSAGE_STATES = ['pending', 'queued', 'skipped', 'started'] as const;
export type StoreMessageState = (typeof STORE_MESSAGE_STATES)[number];
export const STORE_MESSAGE_ANSWERS = ['confirmed', 'cancelled'] as const;
export type StoreMessageAnswer = (typeof STORE_MESSAGE_ANSWERS)[number];

export const commerceStoreMessages = appSchema.table('commerce_store_messages', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  storeId: uuid('store_id').notNull(),
  /**
   * The subject: an order, a checkout for the two cart reminders (0021), or a shipment for the two
   * shipment events (0323), whose `dedupeKey` says which of its messages it is.
   */
  orderId: uuid('order_id'),
  checkoutId: uuid('checkout_id'),
  shipmentId: uuid('shipment_id'),
  dedupeKey: text('dedupe_key'),
  /** The tracking a sent "Shipment sent" message carried (its place among the remembered ones). */
  trackingRevision: smallint('tracking_revision'),
  event: text('event', { enum: STORE_MESSAGE_EVENTS }).notNull(),
  state: text('state', { enum: STORE_MESSAGE_STATES }).notNull().default('pending'),
  skipReason: text('skip_reason'),
  occurredAt: tz('occurred_at').notNull(),
  sendAt: tz('send_at').notNull(),
  contactId: uuid('contact_id'),
  messageId: uuid('message_id'),
  /** The run a rule started (cleared when retention deletes the run). */
  automationRunId: uuid('automation_run_id'),
  answer: text('answer', { enum: STORE_MESSAGE_ANSWERS }),
  answeredAt: tz('answered_at'),
  answerMessageId: uuid('answer_message_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});
