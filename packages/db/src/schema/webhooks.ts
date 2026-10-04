import { integer, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { jsonb } from './columns';
import { appSchema } from './tenancy';

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Event types an endpoint can receive (ADR-053, ADR-074, ADR-078, ADR-085); `ping` is only sent as
 * a test.
 */
export const WEBHOOK_EVENT_TYPES = [
  'message.received',
  'message.status',
  'consent.changed',
  'template.status_changed',
  'conversation.status_changed',
  'conversation.assignment_changed',
  'conversation.team_changed',
  'contact.created',
  'contact.updated',
  'contact.erased',
  'automation.run_started',
  'automation.run_ended',
  'order.received',
  'order.status_changed',
  'campaign.status_changed',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** The statuses a `message.status` event carries, which an endpoint can choose (ADR-119). */
export type WebhookMessageStatus =
  'accepted' | 'sent' | 'delivered' | 'read' | 'played' | 'failed' | 'canceled' | 'unknown_outcome';

/**
 * The parts of a contact whose change a `contact.updated` endpoint can choose (ADR-123); `fields`
 * is a change of any custom field.
 */
export type WebhookContactPart = 'name' | 'phone' | 'email' | 'tags' | 'fields';

/** The statuses a `campaign.status_changed` event reports, which an endpoint can choose (ADR-146). */
export type WebhookCampaignStatus =
  'draft' | 'pending_approval' | 'scheduled' | 'running' | 'paused' | 'completed' | 'canceled';

/**
 * The statuses an `order.status_changed` event reports, which an endpoint can choose (ADR-147); an
 * order is `received` only when it is recorded, which `order.received` reports.
 */
export type WebhookOrderStatus =
  'confirmed' | 'awaiting_payment' | 'paid' | 'fulfilled' | 'cancelled';

export const WEBHOOK_DELIVERY_STATES = ['pending', 'delivering', 'succeeded', 'failed'] as const;
export type WebhookDeliveryState = (typeof WEBHOOK_DELIVERY_STATES)[number];

/** A company's webhook endpoint (migration 0025); the secret is encrypted by the keyring. */
export const webhookEndpoints = appSchema.table('webhook_endpoints', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  url: text('url').notNull(),
  description: text('description'),
  eventTypes: text('event_types').array().notNull().$type<WebhookEventType[]>(),
  secretCiphertext: text('secret_ciphertext').notNull(),
  secretVersion: integer('secret_version').notNull().default(1),
  previousSecretCiphertext: text('previous_secret_ciphertext'),
  previousSecretExpiresAt: tz('previous_secret_expires_at'),
  /** The names of the endpoint's own headers, as written (ADR-118); their values are only sealed. */
  headerNames: text('header_names').array().notNull().default([]),
  /** The headers, names and values, encrypted by the keyring; null without headers. */
  headersCiphertext: text('headers_ciphertext'),
  /**
   * The `message.status` statuses the endpoint takes (ADR-119); null takes every status. Set only
   * while `message.status` is among its events.
   */
  messageStatuses: text('message_statuses').array().$type<WebhookMessageStatus[]>(),
  /**
   * The parts of a contact whose change it takes as `contact.updated` (ADR-123); null takes every
   * change. Set only while `contact.updated` is among its events.
   */
  contactParts: text('contact_parts').array().$type<WebhookContactPart[]>(),
  /**
   * The automations whose runs it takes as `automation.run_started` and `automation.run_ended`
   * (ADR-145); null takes every automation. Set only while one of those is among its events.
   */
  automationIds: uuid('automation_ids').array(),
  /**
   * The statuses a campaign reaches that it takes as `campaign.status_changed` (ADR-146); null
   * takes every status. Set only while `campaign.status_changed` is among its events.
   */
  campaignStatuses: text('campaign_statuses').array().$type<WebhookCampaignStatus[]>(),
  /**
   * The statuses an order reaches that it takes as `order.status_changed` (ADR-147); null takes
   * every status. Set only while `order.status_changed` is among its events.
   */
  orderStatuses: text('order_statuses').array().$type<WebhookOrderStatus[]>(),
  state: text('state', { enum: ['active', 'disabled'] })
    .notNull()
    .default('active'),
  disabledReason: text('disabled_reason', { enum: ['manual', 'failing'] }),
  disabledAt: tz('disabled_at'),
  failingSince: tz('failing_since'),
  lastSuccessAt: tz('last_success_at'),
  lastFailureAt: tz('last_failure_at'),
  /** The member who created the endpoint in settings, or the key that created it (ADR-081). */
  createdByUserId: text('created_by_user_id'),
  createdByApiKeyId: uuid('created_by_api_key_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

/**
 * What happened, without personal data; written by the capture triggers (and test sends). The
 * contact events' `captured_xact` (migration 0047) is used only by the capture functions in SQL.
 */
export const webhookEvents = appSchema.table('webhook_events', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  type: text('type', { enum: [...WEBHOOK_EVENT_TYPES, 'ping'] }).notNull(),
  messageId: uuid('message_id'),
  conversationId: uuid('conversation_id'),
  contactId: uuid('contact_id'),
  templateId: uuid('template_id'),
  status: text('status'),
  detail: jsonb('detail').notNull().$type<Record<string, unknown>>(),
  /** What a contact.updated event's transaction changed (ADR-121); null for other events. */
  contactChanges: text('contact_changes').array(),
  occurredAt: tz('occurred_at').notNull().defaultNow(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

/** One delivery of an event to an endpoint, with its attempts. */
export const webhookDeliveries = appSchema.table('webhook_deliveries', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  endpointId: uuid('endpoint_id').notNull(),
  eventId: uuid('event_id').notNull(),
  state: text('state', { enum: WEBHOOK_DELIVERY_STATES }).notNull().default('pending'),
  attempts: smallint('attempts').notNull().default(0),
  nextAttemptAt: tz('next_attempt_at').notNull().defaultNow(),
  leaseUntil: tz('lease_until'),
  lastAttemptAt: tz('last_attempt_at'),
  lastStatusCode: smallint('last_status_code'),
  lastError: text('last_error'),
  lastDurationMs: integer('last_duration_ms'),
  deliveredAt: tz('delivered_at'),
  replayOf: uuid('replay_of'),
  createdAt: tz('created_at').notNull().defaultNow(),
});
