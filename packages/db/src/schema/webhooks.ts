import { integer, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { jsonb } from './columns';
import type { AutomationEndReason } from './automations';
import type { ContactSource, MessageType } from './messaging';
import { appSchema } from './tenancy';

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Event types an endpoint can receive (ADR-053, ADR-074, ADR-078, ADR-085, ADR-225, ADR-256,
 * ADR-261); `ping` is only sent as a test.
 */
export const WEBHOOK_EVENT_TYPES = [
  'message.received',
  'message.status',
  'consent.changed',
  'template.status_changed',
  'conversation.status_changed',
  'conversation.assignment_changed',
  'conversation.team_changed',
  'satisfaction_survey.answered',
  'contact.created',
  'contact.updated',
  'contact.erased',
  'contact.merged',
  'automation.run_started',
  'automation.run_ended',
  'order.received',
  'order.status_changed',
  'payment_link.status_changed',
  'campaign.status_changed',
  'deal.created',
  'deal.updated',
  'deal.stage_changed',
  'deal.owner_changed',
  'deal.status_changed',
  'task.created',
  'task.updated',
  'task.assignee_changed',
  'task.status_changed',
  'note.created',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** The statuses a `message.status` event carries, which an endpoint can choose (ADR-119). */
export type WebhookMessageStatus =
  'accepted' | 'sent' | 'delivered' | 'read' | 'played' | 'failed' | 'canceled' | 'unknown_outcome';

/**
 * Who sent a message whose `message.status` an endpoint can choose to take (ADR-172), as the event's
 * `message.sentBy` says: a member, an automation, a campaign, the API, or HyFib itself.
 */
export type WebhookMessageSender = 'agent' | 'bot' | 'campaign' | 'api' | 'system';

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

/**
 * The statuses a `template.status_changed` event reports, which an endpoint can choose (ADR-148):
 * Meta's review states and the deletion; HyFib's own steps before Meta has the template, a
 * deletion under way or refused and an unrecognised status are not sent.
 */
export type WebhookTemplateStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'paused'
  | 'disabled'
  | 'in_appeal'
  | 'flagged'
  | 'archived'
  | 'deleted'
  | 'limit_exceeded'
  | 'locked';

/**
 * The statuses a `conversation.status_changed` change reaches, which an endpoint can choose
 * (ADR-149); nothing sets a conversation `pending` (ADR-075).
 */
export type WebhookConversationStatus = 'open' | 'resolved';

/**
 * The statuses an `automation.run_ended` event reports, the status a run ended with, which an
 * endpoint can choose (ADR-151); a run's active statuses (`running`, `waiting`) end nothing.
 */
export type WebhookRunEndStatus = 'completed' | 'handed_off' | 'taken_over' | 'stopped' | 'failed';

/**
 * What started a live automation run (ADR-078), which an endpoint taking run events can choose
 * (ADR-183), as the event's `run.trigger` says; members' test runs send no events.
 */
export type WebhookRunTrigger =
  'keyword' | 'conversation_started' | 'any_message' | 'store_event' | 'api';

/**
 * A `consent.changed` change, its purpose and action (ADR-018), which an endpoint can choose
 * (ADR-189).
 */
export type WebhookConsentChange =
  'marketing_opt_in' | 'marketing_opt_out' | 'utility_opt_in' | 'utility_opt_out';

/**
 * The types a received message has (`message.received`'s `message.type`), which an endpoint can
 * choose (ADR-191): every message type but `template`, which only HyFib sends.
 */
export type WebhookReceivedMessageType = Exclude<MessageType, 'template'>;

export const WEBHOOK_DELIVERY_STATES = ['pending', 'delivering', 'succeeded', 'failed'] as const;
export type WebhookDeliveryState = (typeof WEBHOOK_DELIVERY_STATES)[number];

/**
 * A company's webhook endpoint (migration 0025); its secrets (signing, headers, OAuth client) are
 * encrypted by the keyring.
 */
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
   * Who sent the messages whose `message.status` it takes (ADR-172); null takes every sender. Set
   * only while `message.status` is among its events.
   */
  messageSenders: text('message_senders').array().$type<WebhookMessageSender[]>(),
  /**
   * The parts of a contact whose change it takes as `contact.updated` (ADR-123); null takes every
   * change. Set only while `contact.updated` is among its events.
   */
  contactParts: text('contact_parts').array().$type<WebhookContactPart[]>(),
  /**
   * The custom fields (keys) whose changes it takes as `contact.updated` (ADR-184); null takes every
   * field's. Set only while it takes `contact.updated` for every part or for `fields`.
   */
  contactFieldKeys: text('contact_field_keys').array(),
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
  /**
   * The template statuses it takes as `template.status_changed` (ADR-148); null takes every status.
   * Set only while `template.status_changed` is among its events.
   */
  templateStatuses: text('template_statuses').array().$type<WebhookTemplateStatus[]>(),
  /**
   * The statuses a conversation reaches that it takes as `conversation.status_changed` (ADR-149);
   * null takes every status. Set only while `conversation.status_changed` is among its events.
   */
  conversationStatuses: text('conversation_statuses').array().$type<WebhookConversationStatus[]>(),
  /**
   * The statuses a run ended with that it takes as `automation.run_ended` (ADR-151); null takes
   * every end. Set only while `automation.run_ended` is among its events.
   */
  runEndStatuses: text('run_end_statuses').array().$type<WebhookRunEndStatus[]>(),
  /**
   * What started the runs whose events it takes (ADR-183); null takes every run's. Set only while
   * `automation.run_started` or `automation.run_ended` is among its events.
   */
  runTriggers: text('run_triggers').array().$type<WebhookRunTrigger[]>(),
  /**
   * The WhatsApp numbers (channel accounts) whose events it takes (ADR-170): message,
   * conversation, automation run, order and campaign events; null takes every number. Set only
   * while one of those is among its events.
   */
  channelAccountIds: uuid('channel_account_ids').array(),
  /**
   * The teams whose conversations' message and conversation events it takes (ADR-174); null takes
   * every conversation's. Set only while one of those events is among its events.
   */
  teamIds: uuid('team_ids').array(),
  /**
   * The templates whose messages' statuses and changes it takes (ADR-175); null takes every
   * template's. Set only while `message.status` or `template.status_changed` is among its events.
   */
  templateIds: uuid('template_ids').array(),
  /**
   * The members (memberships) whose assigned conversations' message and conversation events it
   * takes (ADR-181); null takes every conversation's. Set only while one of those events is among
   * its events.
   */
  assigneeIds: uuid('assignee_ids').array(),
  /**
   * The contact tags whose conversations' message and conversation events it takes (migration 0183,
   * ADR-267), by the tags the conversation's contact has when the event happens; null takes every
   * conversation's. Set only while one of those events is among its events.
   */
  contactTags: text('contact_tags').array(),
  /**
   * The conversation tags whose message and conversation events it takes (migration 0189,
   * ADR-273), by the tags the conversation has when the event happens; null takes every
   * conversation's. Set only while one of those events is among its events.
   */
  conversationTags: text('conversation_tags').array(),
  /**
   * The campaigns whose messages' statuses and changes it takes (ADR-185); null takes every
   * campaign's. Set only while `message.status` or `campaign.status_changed` is among its events.
   */
  campaignIds: uuid('campaign_ids').array(),
  /**
   * The CRM pipelines whose deals' events it takes (migration 0179, ADR-263), by the pipeline the
   * event gives (and for a move, the one it left); null takes every pipeline's. Set only while a
   * deal event is among its events.
   */
  pipelineIds: uuid('pipeline_ids').array(),
  /**
   * The CRM stages whose deals' events it takes (migration 0180, ADR-264), by the stage the event
   * gives (and for a move, the one it left); null takes every stage's. Set only while a deal event
   * is among its events.
   */
  stageIds: uuid('stage_ids').array(),
  /**
   * The members (memberships) whose deals' events it takes (migration 0181, ADR-265), by the deal's
   * owner when the event happens; null takes every deal's. Set only while a deal event is among its
   * events.
   */
  ownerIds: uuid('owner_ids').array(),
  /**
   * The members (memberships) whose tasks' events it takes (migration 0182, ADR-266), by the task's
   * assignee when the event happens; null takes every task's. Set only while a task event is among
   * its events.
   */
  taskAssigneeIds: uuid('task_assignee_ids').array(),
  /**
   * The CRM pipelines whose deals' tasks' events it takes (migration 0226, ADR-303), by the pipeline
   * of the task's deal when the event happens; a task without a deal is in none. null takes every
   * task's. Set only while a task event is among its events.
   */
  taskPipelineIds: uuid('task_pipeline_ids').array(),
  /**
   * The consent changes it takes as `consent.changed` (ADR-189), by purpose and action; null takes
   * every change. Set only while `consent.changed` is among its events.
   */
  consentChanges: text('consent_changes').array().$type<WebhookConsentChange[]>(),
  /**
   * Where the contacts whose `contact.created` it takes came from (ADR-190), as the payload's
   * `contact.source`; null takes every contact. Set only while `contact.created` is among its events.
   */
  contactSources: text('contact_sources').array().$type<ContactSource[]>(),
  /**
   * The types of the received messages it takes as `message.received` (ADR-191); null takes every
   * type. Set only while `message.received` is among its events.
   */
  messageTypes: text('message_types').array().$type<WebhookReceivedMessageType[]>(),
  /**
   * The reasons the runs it takes as `automation.run_ended` ended for (ADR-192), applied with the
   * ends it chose; null takes every reason. Set only while `automation.run_ended` is among its events.
   */
  runEndReasons: text('run_end_reasons').array().$type<AutomationEndReason[]>(),
  /**
   * The endpoint's OAuth client (ADR-173): its authorization server's token endpoint, the client
   * identifier, the secret encrypted by the keyring and the scope to ask for (null: none). All
   * null without OAuth; the scope alone is optional.
   */
  oauthTokenUrl: text('oauth_token_url'),
  oauthClientId: text('oauth_client_id'),
  oauthClientSecretCiphertext: text('oauth_client_secret_ciphertext'),
  oauthScope: text('oauth_scope'),
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
  /**
   * The tags a contact.updated event's transaction added and removed (ADR-182), both null for other
   * events, for those captured before migration 0129 and once the contact is erased.
   */
  tagsAdded: text('tags_added').array(),
  tagsRemoved: text('tags_removed').array(),
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
