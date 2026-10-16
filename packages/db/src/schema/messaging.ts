import { sql } from 'drizzle-orm';
import {
  bigint,
  customType,
  doublePrecision,
  integer,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { jsonb } from './columns';
import { appSchema } from './tenancy';
import { opsSchema } from './ops';

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** PostgreSQL xid8, carried as a decimal string (values exceed Number.MAX_SAFE_INTEGER). */
const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => 'xid8',
});

export const CHANNEL_STATUSES = [
  'onboarding',
  'active',
  'needs_reconnect',
  'disconnected',
  'failed',
] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

export const whatsappAccounts = appSchema.table('whatsapp_accounts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  wabaId: text('waba_id').notNull(),
  businessId: text('business_id'),
  name: text('name'),
  status: text('status', { enum: ['connected', 'needs_reconnect', 'disconnected'] })
    .notNull()
    .default('connected'),
  credentialCiphertext: text('credential_ciphertext'),
  grantedScopes: text('granted_scopes')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  tokenCheckedAt: tz('token_checked_at'),
  connectedByUserId: text('connected_by_user_id'),
  templatesSyncRequestedAt: tz('templates_sync_requested_at'),
  templatesSyncedAt: tz('templates_synced_at'),
  /** The access checks of ADR-137 (migration 0104). */
  tokenCheckAttemptedAt: tz('token_check_attempted_at'),
  tokenCheckRequestedAt: tz('token_check_requested_at'),
  tokenCheckError: text('token_check_error'),
  tokenExpiresAt: tz('token_expires_at'),
  tokenExpiryRemindedAt: tz('token_expiry_reminded_at'),
  tokenProblem: text('token_problem', {
    enum: ['invalid', 'other_app', 'missing_permission', 'account_not_shared'],
  }),
  tokenProblemAt: tz('token_problem_at'),
  /** The app's webhook subscription to the account (ADR-138). */
  webhooksCheckedAt: tz('webhooks_checked_at'),
  webhooksCheckError: text('webhooks_check_error'),
  webhooksMissingSince: tz('webhooks_missing_since'),
  webhooksRestoredAt: tz('webhooks_restored_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const channelAccounts = appSchema.table('channel_accounts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  whatsappAccountId: uuid('whatsapp_account_id').notNull(),
  provider: text('provider', { enum: ['meta_whatsapp'] })
    .notNull()
    .default('meta_whatsapp'),
  phoneNumberId: text('phone_number_id').notNull(),
  displayPhoneNumber: text('display_phone_number'),
  verifiedName: text('verified_name'),
  status: text('status', { enum: CHANNEL_STATUSES }).notNull().default('onboarding'),
  onboardingStep: text('onboarding_step', {
    enum: ['subscribe_app', 'register_number', 'health_check', 'done'],
  }),
  onboardingError: text('onboarding_error'),
  qualityRating: text('quality_rating'),
  nameStatus: text('name_status'),
  codeVerificationStatus: text('code_verification_status'),
  registrationPinCiphertext: text('registration_pin_ciphertext'),
  healthCheckedAt: tz('health_checked_at'),
  /** Team new conversations on this number start in (migration 0009). */
  defaultTeamId: uuid('default_team_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
  /**
   * The number's messaging limit tier as Meta gave it, and when a health read that asked for it
   * succeeded: null for a number never asked (ADR-398, migration 0309).
   */
  messagingLimitTier: text('messaging_limit_tier'),
  messagingLimitCheckedAt: tz('messaging_limit_checked_at'),
});

export const channelOnboardingSessions = appSchema.table('channel_onboarding_sessions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  stateHash: text('state_hash').notNull(),
  createdByUserId: text('created_by_user_id').notNull(),
  authSessionId: text('auth_session_id').notNull(),
  status: text('status', { enum: ['started', 'exchanging', 'completed', 'failed', 'expired'] })
    .notNull()
    .default('started'),
  failureReason: text('failure_reason'),
  resultWhatsappAccountId: uuid('result_whatsapp_account_id'),
  expiresAt: tz('expires_at').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const CONTACT_SOURCES = ['whatsapp', 'manual', 'import', 'api', 'store'] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];

export const contacts = appSchema.table('contacts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  displayName: text('display_name'),
  phoneE164: text('phone_e164'),
  email: text('email'),
  attributes: jsonb('attributes')
    .notNull()
    .default(sql`'{}'::jsonb`)
    .$type<Record<string, string | number | boolean>>(),
  source: text('source', { enum: CONTACT_SOURCES }).notNull().default('whatsapp'),
  erasedAt: tz('erased_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const contactIdentities = appSchema.table('contact_identities', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  whatsappAccountId: uuid('whatsapp_account_id').notNull(),
  bsuid: text('bsuid'),
  parentBsuid: text('parent_bsuid'),
  waId: text('wa_id'),
  profileName: text('profile_name'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const CONVERSATION_STATUSES = ['open', 'pending', 'resolved'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const conversations = appSchema.table('conversations', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  channelAccountId: uuid('channel_account_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  status: text('status', { enum: CONVERSATION_STATUSES }).notNull().default('open'),
  assignedMembershipId: uuid('assigned_membership_id'),
  teamId: uuid('team_id'),
  lastMessageAt: tz('last_message_at'),
  lastMessagePreview: text('last_message_preview'),
  lastInboundAt: tz('last_inbound_at'),
  unreadCount: integer('unread_count').notNull().default(0),
  version: integer('version').notNull().default(0),
  resolvedAt: tz('resolved_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const conversationNotes = appSchema.table('conversation_notes', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  /** The member who wrote the note, or the key that wrote it through the API (ADR-084). */
  authorMembershipId: uuid('author_membership_id'),
  authorApiKeyId: uuid('author_api_key_id'),
  body: text('body').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

/** Tags members put on a conversation (migration 0145, ADR-220), written as contact tags are. */
export const conversationTags = appSchema.table('conversation_tags', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  tag: text('tag').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

/** Members who have a conversation open (migration 0157, ADR-243), reported every 20 seconds. */
export const conversationViewers = appSchema.table('conversation_viewers', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  membershipId: uuid('membership_id').notNull(),
  seenAt: tz('seen_at').notNull().defaultNow(),
});

export const MESSAGE_TYPES = [
  'text',
  'image',
  'video',
  'audio',
  'document',
  'sticker',
  'location',
  'contacts',
  'interactive',
  'button',
  'reaction',
  'template',
  'order',
  'system',
  'unsupported',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const MESSAGE_STATUSES = [
  'received',
  'queued',
  'sending',
  'accepted',
  'sent',
  'delivered',
  'read',
  'played',
  'failed',
  'canceled',
  'unknown_outcome',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const messages = appSchema.table('messages', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  channelAccountId: uuid('channel_account_id').notNull(),
  direction: text('direction', { enum: ['inbound', 'outbound'] }).notNull(),
  externalMessageId: text('external_message_id'),
  type: text('type', { enum: MESSAGE_TYPES }).notNull(),
  content: jsonb('content')
    .notNull()
    .default(sql`'{}'::jsonb`)
    .$type<Record<string, unknown>>(),
  status: text('status', { enum: MESSAGE_STATUSES }).notNull(),
  statusRank: smallint('status_rank').notNull().default(0),
  statusAt: tz('status_at').notNull().defaultNow(),
  errorCode: text('error_code'),
  errorTitle: text('error_title'),
  senderType: text('sender_type', {
    enum: ['contact', 'agent', 'bot', 'campaign', 'api', 'system'],
  }).notNull(),
  senderMembershipId: uuid('sender_membership_id'),
  clientKey: text('client_key'),
  contextExternalId: text('context_external_id'),
  /** No longer written (0016): ad sources are kept in `conversation_sources`; erasure clears it. */
  referral: jsonb('referral').$type<Record<string, unknown>>(),
  pricing: jsonb('pricing').$type<Record<string, unknown>>(),
  providerTimestamp: tz('provider_timestamp'),
  templateId: uuid('template_id'),
  campaignId: uuid('campaign_id'),
  /** The API key that sent it (sender_type 'api', migration 0024). */
  apiKeyId: uuid('api_key_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

/**
 * Each message's latest change (migration 0093, ADR-116): the transaction that last changed how the
 * API describes it. Only the trigger on `app.messages` writes it; keys read it in order.
 */
export const messageChanges = appSchema.table('message_changes', {
  id: bigint('id', { mode: 'bigint' }).notNull(),
  tenantId: uuid('tenant_id').notNull(),
  messageId: uuid('message_id').notNull(),
  xact: xid8('xact').notNull(),
});

export const messageStatusEvents = appSchema.table('message_status_events', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  channelAccountId: uuid('channel_account_id').notNull(),
  messageId: uuid('message_id'),
  externalMessageId: text('external_message_id').notNull(),
  status: text('status').notNull(),
  providerTimestamp: tz('provider_timestamp').notNull(),
  recipientWaId: text('recipient_wa_id'),
  recipientBsuid: text('recipient_bsuid'),
  errors: jsonb('errors').$type<unknown>(),
  pricing: jsonb('pricing').$type<Record<string, unknown>>(),
  receiptId: uuid('receipt_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const SEND_INTENT_STATES = [
  'queued',
  'sending',
  'accepted',
  'failed',
  'canceled',
  'unknown_outcome',
  'deferred',
] as const;
export type SendIntentState = (typeof SEND_INTENT_STATES)[number];

export const sendIntents = appSchema.table('send_intents', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  messageId: uuid('message_id').notNull(),
  channelAccountId: uuid('channel_account_id').notNull(),
  state: text('state', { enum: SEND_INTENT_STATES }).notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: tz('next_attempt_at').notNull().defaultNow(),
  leaseUntil: tz('lease_until'),
  request: jsonb('request').notNull().$type<Record<string, unknown>>(),
  lastErrorCode: text('last_error_code'),
  lastError: text('last_error'),
  actorUserId: text('actor_user_id'),
  sentAt: tz('sent_at'),
  resolvedAt: tz('resolved_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const mediaObjects = appSchema.table('media_objects', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  messageId: uuid('message_id'),
  providerMediaId: text('provider_media_id'),
  mimeType: text('mime_type'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  sha256: text('sha256'),
  filename: text('filename'),
  storageKey: text('storage_key'),
  status: text('status', { enum: ['pending', 'stored', 'failed', 'rejected', 'expired'] })
    .notNull()
    .default('pending'),
  failureReason: text('failure_reason'),
  /** The number a key uploaded the file for (ADR-219). */
  channelAccountId: uuid('channel_account_id'),
  /** The key that uploaded the file through the API (ADR-219). */
  apiKeyId: uuid('api_key_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const tenantEvents = appSchema.table('tenant_events', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  txid: xid8('txid')
    .notNull()
    .default(sql`pg_current_xact_id()`),
  type: text('type').notNull(),
  conversationId: uuid('conversation_id'),
  assignedMembershipId: uuid('assigned_membership_id'),
  payload: jsonb('payload')
    .notNull()
    .default(sql`'{}'::jsonb`)
    .$type<Record<string, unknown>>(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const webhookReceipts = opsSchema.table('webhook_receipts', {
  id: uuid('id').primaryKey(),
  provider: text('provider', { enum: ['meta_whatsapp', 'razorpay'] }).notNull(),
  receivedAt: tz('received_at').notNull().defaultNow(),
  bodySha256: text('body_sha256').notNull(),
  bodyCiphertext: text('body_ciphertext'),
  bodySize: integer('body_size').notNull(),
  eventId: text('event_id'),
  status: text('status', {
    enum: ['pending', 'processing', 'processed', 'failed', 'quarantined', 'ignored'],
  })
    .notNull()
    .default('pending'),
  attempts: integer('attempts').notNull().default(0),
  leaseUntil: tz('lease_until'),
  lastError: text('last_error'),
  summary: jsonb('summary')
    .notNull()
    .default(sql`'{}'::jsonb`)
    .$type<Record<string, unknown>>(),
  processedAt: tz('processed_at'),
  /** When platform staff were emailed that it used all its attempts (ADR-091); cleared on retry. */
  exhaustedAlertedAt: tz('exhausted_alerted_at'),
});

/**
 * An administrator's note on a webhook receipt the console lists (ADR-179), deleted with the
 * receipt. Platform staff read it; only `ops.platform_acknowledge_webhook_receipt` writes it.
 */
export const receiptAcknowledgements = opsSchema.table('receipt_acknowledgements', {
  receiptId: uuid('receipt_id').primaryKey(),
  acknowledgedByUserId: text('acknowledged_by_user_id').notNull(),
  acknowledgedAt: tz('acknowledged_at').notNull(),
  note: text('note').notNull(),
});

export const webhookQuarantine = opsSchema.table('webhook_quarantine', {
  id: uuid('id').primaryKey(),
  receiptId: uuid('receipt_id').notNull(),
  provider: text('provider', { enum: ['meta_whatsapp', 'razorpay'] }).notNull(),
  reason: text('reason', {
    enum: ['unknown_asset', 'asset_mismatch', 'malformed', 'unsupported_object'],
  }).notNull(),
  externalIds: jsonb('external_ids')
    .notNull()
    .default(sql`'{}'::jsonb`)
    .$type<Record<string, unknown>>(),
  createdAt: tz('created_at').notNull().defaultNow(),
  resolvedAt: tz('resolved_at'),
  resolution: text('resolution'),
  /** When platform staff were emailed about it (ADR-091). */
  alertedAt: tz('alerted_at'),
});

/**
 * An administrator's note on an open quarantine entry (ADR-199), deleted with the entry. Platform
 * staff read it; only `ops.platform_acknowledge_quarantine_entry` writes it.
 */
export const quarantineAcknowledgements = opsSchema.table('quarantine_acknowledgements', {
  quarantineId: uuid('quarantine_id').primaryKey(),
  acknowledgedByUserId: text('acknowledged_by_user_id').notNull(),
  acknowledgedAt: tz('acknowledged_at').notNull(),
  note: text('note').notNull(),
});

export const rateLimitBuckets = opsSchema.table('rate_limit_buckets', {
  key: text('key').primaryKey(),
  tokens: doublePrecision('tokens').notNull(),
  capacity: doublePrecision('capacity').notNull(),
  refillPerSecond: doublePrecision('refill_per_second').notNull(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});
