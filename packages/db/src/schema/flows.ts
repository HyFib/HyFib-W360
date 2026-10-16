import { integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { jsonb } from './columns';
import { appSchema } from './tenancy';

/**
 * WhatsApp Flows (migration 0017): forms designed as Flow JSON, sent in chats and answered natively
 * in WhatsApp. HyFib keeps the draft; the worker creates, uploads, publishes and deprecates it at
 * Meta. Flows that fetch data while open use a per-WhatsApp-account encryption key.
 */
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const FLOW_KEY_STATES = ['active', 'previous', 'retired'] as const;
export type FlowKeyState = (typeof FLOW_KEY_STATES)[number];

export const flowKeys = appSchema.table('flow_keys', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  whatsappAccountId: uuid('whatsapp_account_id').notNull(),
  publicKeyPem: text('public_key_pem').notNull(),
  fingerprint: text('fingerprint').notNull(),
  /** Keyring ciphertext bound to the row (flowKeyAad); null once retired. */
  privateKeyCiphertext: text('private_key_ciphertext'),
  state: text('state', { enum: FLOW_KEY_STATES }).notNull().default('active'),
  createdAt: tz('created_at').notNull().defaultNow(),
  replacedAt: tz('replaced_at'),
  retiredAt: tz('retired_at'),
});

export const FLOW_KEY_UPLOAD_STATES = ['pending', 'uploaded', 'failed'] as const;
export type FlowKeyUploadState = (typeof FLOW_KEY_UPLOAD_STATES)[number];

export const flowKeyUploads = appSchema.table('flow_key_uploads', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  keyId: uuid('key_id').notNull(),
  channelAccountId: uuid('channel_account_id').notNull(),
  state: text('state', { enum: FLOW_KEY_UPLOAD_STATES }).notNull().default('pending'),
  /** Meta's business_public_key_signature_status (research M-164). */
  signatureStatus: text('signature_status', { enum: ['VALID', 'MISMATCH'] }),
  errorCode: text('error_code'),
  attempts: integer('attempts').notNull().default(0),
  uploadedAt: tz('uploaded_at'),
  checkedAt: tz('checked_at'),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const FLOW_META_STATUSES = [
  'DRAFT',
  'PUBLISHED',
  'DEPRECATED',
  'BLOCKED',
  'THROTTLED',
] as const;
export type FlowMetaStatus = (typeof FLOW_META_STATUSES)[number];

export const FLOW_SYNC_OPS = [
  'create',
  'upload',
  'publish',
  'deprecate',
  'delete',
  'refresh',
] as const;
export type FlowSyncOp = (typeof FLOW_SYNC_OPS)[number];

export const FLOW_SYNC_STATES = ['idle', 'queued', 'running', 'failed'] as const;
export type FlowSyncState = (typeof FLOW_SYNC_STATES)[number];

/** Meta's validation error for an uploaded Flow JSON (research M-162). */
export interface FlowValidationError {
  error: string;
  errorType: string | null;
  message: string;
  lineStart: number | null;
  lineEnd: number | null;
  columnStart: number | null;
  columnEnd: number | null;
}

/** Where one answer of a completed flow goes on the contact. */
export interface FlowAnswerMapping {
  key: string;
  /** `name`, `email`, or `field:<custom field key>`. */
  target: string;
}

export const flows = appSchema.table('flows', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  whatsappAccountId: uuid('whatsapp_account_id').notNull(),
  /** Names the flow in HyFib's data endpoint address /api/flows/endpoint/<publicId>. */
  publicId: text('public_id').notNull(),
  name: text('name').notNull(),
  categories: text('categories').array().notNull(),
  /** The Flow JSON exactly as written (Meta's validation errors refer to its lines). */
  flowJson: text('flow_json').notNull(),
  jsonVersion: text('json_version').notNull(),
  dataApiVersion: text('data_api_version'),
  firstScreen: text('first_screen').notNull(),
  answerKeys: text('answer_keys').array().notNull().default([]),
  answerMapping: jsonb('answer_mapping').$type<FlowAnswerMapping[]>().notNull().default([]),
  endpointUrl: text('endpoint_url'),
  endpointSecretName: text('endpoint_secret_name'),
  derivedFromFlowId: uuid('derived_from_flow_id'),
  metaFlowId: text('meta_flow_id'),
  metaStatus: text('meta_status', { enum: FLOW_META_STATUSES }),
  uploadedJsonSha256: text('uploaded_json_sha256'),
  validationErrors: jsonb('validation_errors').$type<FlowValidationError[]>().notNull().default([]),
  health: jsonb('health').$type<Record<string, unknown>>(),
  previewUrl: text('preview_url'),
  previewExpiresAt: tz('preview_expires_at'),
  syncOp: text('sync_op', { enum: FLOW_SYNC_OPS }),
  syncState: text('sync_state', { enum: FLOW_SYNC_STATES }).notNull().default('idle'),
  syncError: text('sync_error'),
  syncRequestedAt: tz('sync_requested_at'),
  /**
   * When work this row waits for, deferred because Meta throttled the account's management calls,
   * runs again (ADR-399, migration 0310). Windows that give up on a request count from the later of
   * the request and this time, so time spent deferred for a pause is never counted against it.
   */
  managementDeferredUntil: tz('management_deferred_until'),
  syncedAt: tz('synced_at'),
  archivedAt: tz('archived_at'),
  version: integer('version').notNull().default(1),
  createdByMembershipId: uuid('created_by_membership_id').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const FLOW_SEND_MODES = ['draft', 'published'] as const;
export type FlowSendMode = (typeof FLOW_SEND_MODES)[number];

export const flowSends = appSchema.table('flow_sends', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  flowId: uuid('flow_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  messageId: uuid('message_id').notNull(),
  /** The random flow_token sent with the message (research M-165). */
  token: text('token').notNull(),
  mode: text('mode', { enum: FLOW_SEND_MODES }).notNull(),
  sentByMembershipId: uuid('sent_by_membership_id'),
  expiresAt: tz('expires_at').notNull(),
  completedAt: tz('completed_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

/** What happened to one answer when a completed flow was applied to the contact. */
export interface FlowAnswerOutcome {
  key: string;
  target: string;
  outcome: 'applied' | 'missing' | 'invalid' | 'skipped';
  message?: string;
}

export const flowResponses = appSchema.table('flow_responses', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  flowId: uuid('flow_id'),
  flowSendId: uuid('flow_send_id'),
  conversationId: uuid('conversation_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  messageId: uuid('message_id').notNull(),
  answers: jsonb('answers').$type<Record<string, unknown>>().notNull(),
  applied: jsonb('applied').$type<FlowAnswerOutcome[]>().notNull().default([]),
  receivedAt: tz('received_at').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});
