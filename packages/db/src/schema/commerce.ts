import {
  bigint,
  boolean,
  customType,
  integer,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema } from './tenancy';

/**
 * Commerce on WhatsApp (migration 0018): catalogs read from Meta, products for product messages,
 * orders customers place in WhatsApp, and Payment Links created in the company's own Razorpay
 * account. Money is integer minor units; payment status comes only from links fetched from Razorpay.
 */
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const money = (name: string) => bigint(name, { mode: 'number' });

/** PostgreSQL xid8, carried as a decimal string (values exceed Number.MAX_SAFE_INTEGER). */
const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => 'xid8',
});

export const COMMERCE_SYNC_STATES = ['idle', 'queued', 'running', 'failed'] as const;
export type CommerceSyncState = (typeof COMMERCE_SYNC_STATES)[number];

export const commerceSyncs = appSchema.table('commerce_syncs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  whatsappAccountId: uuid('whatsapp_account_id').notNull(),
  state: text('state', { enum: COMMERCE_SYNC_STATES }).notNull().default('idle'),
  error: text('error'),
  requestedAt: tz('requested_at'),
  /**
   * When work this row waits for, deferred because Meta throttled the account's management calls,
   * runs again (ADR-399, migration 0310). Windows that give up on a request count from the later of
   * the request and this time, so time spent deferred for a pause is never counted against it.
   */
  managementDeferredUntil: tz('management_deferred_until'),
  finishedAt: tz('finished_at'),
  version: integer('version').notNull().default(1),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const commerceCatalogs = appSchema.table('commerce_catalogs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  whatsappAccountId: uuid('whatsapp_account_id').notNull(),
  metaCatalogId: text('meta_catalog_id').notNull(),
  name: text('name'),
  productCount: integer('product_count'),
  truncated: boolean('truncated').notNull().default(false),
  disconnectedAt: tz('disconnected_at'),
  syncedAt: tz('synced_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const commerceProducts = appSchema.table('commerce_products', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  catalogId: uuid('catalog_id').notNull(),
  retailerId: text('retailer_id').notNull(),
  metaProductId: text('meta_product_id'),
  name: text('name').notNull(),
  description: text('description'),
  /** Meta's display text for the price (its format is not documented, research M-172). */
  priceText: text('price_text'),
  currency: text('currency'),
  availability: text('availability'),
  reviewStatus: text('review_status'),
  removedAt: tz('removed_at'),
  syncedAt: tz('synced_at').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const ORDER_STATUSES = [
  'received',
  'confirmed',
  'awaiting_payment',
  'paid',
  'fulfilled',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Who changed an order's status (ADR-270): a member on the order page, an API key (ADR-168) or
 * HyFib applying what Razorpay reports for the order's Payment Link.
 */
export const ORDER_STATUS_CHANGERS = ['member', 'api', 'payment_link'] as const;
export type OrderStatusChanger = (typeof ORDER_STATUS_CHANGERS)[number];

export const commerceOrders = appSchema.table('commerce_orders', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  reference: text('reference').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  messageId: uuid('message_id').notNull(),
  channelAccountId: uuid('channel_account_id').notNull(),
  metaCatalogId: text('meta_catalog_id').notNull(),
  /** Null when the items disagree on currency. */
  currency: text('currency'),
  /** Minor units; null when a price or item could not be read or currencies differ. */
  subtotalMinor: money('subtotal_minor'),
  itemCount: integer('item_count').notNull(),
  /** Cart items that could not be read (or were beyond HyFib's limit). */
  droppedItems: integer('dropped_items').notNull().default(0),
  customerNote: text('customer_note'),
  status: text('status', { enum: ORDER_STATUSES }).notNull().default('received'),
  statusChangedAt: tz('status_changed_at').notNull().defaultNow(),
  /**
   * Who made the latest status change, with the key for `api` (migration 0187); null when the
   * change did not record it. The database clears a changer an earlier transaction recorded
   * (`statusChangedXact`), so a change that does not say who made it never names the one before.
   */
  statusChangedBy: text('status_changed_by', { enum: ORDER_STATUS_CHANGERS }),
  statusChangedByApiKeyId: uuid('status_changed_by_api_key_id'),
  statusChangedXact: xid8('status_changed_xact'),
  paidAt: tz('paid_at'),
  receivedAt: tz('received_at').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const commerceOrderItems = appSchema.table('commerce_order_items', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  orderId: uuid('order_id').notNull(),
  position: smallint('position').notNull(),
  retailerId: text('retailer_id').notNull(),
  productId: uuid('product_id'),
  name: text('name'),
  quantity: integer('quantity').notNull(),
  unitPriceMinor: money('unit_price_minor'),
  currency: text('currency'),
});

export const PAYMENT_ACCOUNT_STATUSES = ['unverified', 'checking', 'verified', 'failed'] as const;
export type PaymentAccountStatus = (typeof PAYMENT_ACCOUNT_STATUSES)[number];

export const commercePaymentAccounts = appSchema.table('commerce_payment_accounts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  provider: text('provider', { enum: ['razorpay'] })
    .notNull()
    .default('razorpay'),
  keyId: text('key_id').notNull(),
  /** Keyring ciphertexts bound to the row (paymentAccountAad); never sent to browsers. */
  keySecretCiphertext: text('key_secret_ciphertext').notNull(),
  webhookSecretCiphertext: text('webhook_secret_ciphertext').notNull(),
  webhookPublicId: text('webhook_public_id').notNull(),
  status: text('status', { enum: PAYMENT_ACCOUNT_STATUSES }).notNull().default('unverified'),
  statusError: text('status_error'),
  checkedAt: tz('checked_at'),
  version: integer('version').notNull().default(1),
  updatedByMembershipId: uuid('updated_by_membership_id').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const PAYMENT_LINK_STATUSES = [
  'creating',
  'created',
  'partially_paid',
  'paid',
  'expired',
  'cancelled',
  'failed',
] as const;
export type PaymentLinkStatus = (typeof PAYMENT_LINK_STATUSES)[number];
/** Links that may still change at Razorpay (one per order at a time). */
export const OPEN_PAYMENT_LINK_STATUSES: readonly PaymentLinkStatus[] = [
  'creating',
  'created',
  'partially_paid',
];

export const commercePaymentLinks = appSchema.table('commerce_payment_links', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  orderId: uuid('order_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  /** Razorpay's single-use reference_id (research R-106, R-107). */
  reference: text('reference').notNull(),
  amountMinor: money('amount_minor').notNull(),
  currency: text('currency', { enum: ['INR'] }).notNull(),
  status: text('status', { enum: PAYMENT_LINK_STATUSES }).notNull().default('creating'),
  providerLinkId: text('provider_link_id'),
  shortUrl: text('short_url'),
  amountPaidMinor: money('amount_paid_minor').notNull().default(0),
  expiresAt: tz('expires_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  leaseUntil: tz('lease_until'),
  cancelRequestedAt: tz('cancel_requested_at'),
  error: text('error'),
  messageId: uuid('message_id'),
  /** Why the link was not sent in the chat (the window had closed, the number is inactive…). */
  sendError: text('send_error'),
  nextCheckAt: tz('next_check_at'),
  checkedAt: tz('checked_at'),
  paidAt: tz('paid_at'),
  /** Who asked for the payment: a member, or an API key (migration 0202, ADR-283); exactly one. */
  createdByMembershipId: uuid('created_by_membership_id'),
  createdByApiKeyId: uuid('created_by_api_key_id'),
  version: integer('version').notNull().default(1),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const commercePaymentEvents = appSchema.table('commerce_payment_events', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  eventId: text('event_id').notNull(),
  event: text('event').notNull(),
  providerLinkId: text('provider_link_id'),
  receivedAt: tz('received_at').notNull().defaultNow(),
});
