import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  inet,
  integer,
  pgSchema,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { jsonb } from './columns';

export const opsSchema = pgSchema('ops');

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const platformAdmins = opsSchema.table('platform_admins', {
  userId: text('user_id').primaryKey(),
  role: text('role', { enum: ['platform_owner', 'platform_operator'] }).notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  createdBy: text('created_by'),
});

export const SUPPORT_SCOPES = [
  'tenant.read',
  'members.read',
  'messages.metadata.read',
  'billing.read',
  'diagnostics.read',
] as const;
export type SupportScope = (typeof SUPPORT_SCOPES)[number];

export const supportAccessGrants = opsSchema.table('support_access_grants', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  platformUserId: text('platform_user_id').notNull(),
  reason: text('reason').notNull(),
  scopes: text('scopes').array().notNull().$type<SupportScope[]>(),
  createdAt: tz('created_at').notNull().defaultNow(),
  expiresAt: tz('expires_at').notNull(),
  revokedAt: tz('revoked_at'),
  revokedBy: text('revoked_by'),
});

export const platformAuditEvents = opsSchema.table('platform_audit_events', {
  id: uuid('id').primaryKey(),
  occurredAt: tz('occurred_at').notNull().defaultNow(),
  actorUserId: text('actor_user_id').notNull(),
  action: text('action').notNull(),
  targetTenantId: uuid('target_tenant_id'),
  reason: text('reason'),
  result: text('result', { enum: ['success', 'denied', 'failure'] }).notNull(),
  correlationId: text('correlation_id'),
  metadata: jsonb('metadata')
    .notNull()
    .default(sql`'{}'::jsonb`)
    .$type<Record<string, unknown>>(),
});

export const securityEvents = opsSchema.table('security_events', {
  id: uuid('id').primaryKey(),
  occurredAt: tz('occurred_at').notNull().defaultNow(),
  eventType: text('event_type').notNull(),
  severity: text('severity', { enum: ['info', 'warning', 'critical'] }).notNull(),
  userId: text('user_id'),
  tenantId: uuid('tenant_id'),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  correlationId: text('correlation_id'),
  details: jsonb('details')
    .notNull()
    .default(sql`'{}'::jsonb`)
    .$type<Record<string, unknown>>(),
});

export const emailOutbox = opsSchema.table('email_outbox', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id'),
  kind: text('kind').notNull(),
  toAddress: text('to_address').notNull(),
  payloadCiphertext: text('payload_ciphertext'),
  status: text('status', { enum: ['pending', 'sending', 'sent', 'failed', 'cancelled'] })
    .notNull()
    .default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: tz('next_attempt_at').notNull().defaultNow(),
  lockedUntil: tz('locked_until'),
  lastError: text('last_error'),
  providerMessageId: text('provider_message_id'),
  dedupeKey: text('dedupe_key'),
  createdAt: tz('created_at').notNull().defaultNow(),
  sentAt: tz('sent_at'),
});

/**
 * Jobs the dead-letter queue received, recorded by the worker (ADR-054). Kind, reference and company
 * are set only when the envelope signature verified; only the error's name and code are kept. The
 * worker may insert only; platform staff read.
 */
export const deadLetters = opsSchema.table('dead_letters', {
  id: uuid('id').primaryKey(),
  sourceQueue: text('source_queue').notNull(),
  sourceJobId: uuid('source_job_id'),
  kind: text('kind'),
  tenantId: uuid('tenant_id'),
  ref: text('ref'),
  verified: boolean('verified').notNull(),
  retries: integer('retries'),
  errorName: text('error_name'),
  errorCode: text('error_code'),
  firstQueuedAt: tz('first_queued_at'),
  failedAt: tz('failed_at').notNull(),
  recordedAt: tz('recorded_at').notNull().defaultNow(),
  /** When platform staff were emailed about it (ADR-091). */
  alertedAt: tz('alerted_at'),
  /** When a platform administrator sent the job back to its queue, and who (ADR-108). */
  retriedAt: tz('retried_at'),
  retriedByUserId: text('retried_by_user_id'),
  /**
   * When the sweep settled its work for the company, and whether anything was left to end
   * (ADR-111); only for the stranded-work queues, never with a retry.
   */
  settledAt: tz('settled_at'),
  settledEnded: boolean('settled_ended'),
  /** When a platform administrator noted that it was looked at, who, and the note (ADR-169). */
  acknowledgedAt: tz('acknowledged_at'),
  acknowledgedByUserId: text('acknowledged_by_user_id'),
  acknowledgement: text('acknowledgement'),
});

/**
 * When each platform alert last went out: failures (ADR-091) and late queues (ADR-096), each at most
 * every 15 minutes.
 */
export const platformAlerts = opsSchema.table('platform_alerts', {
  kind: text('kind', { enum: ['failures', 'queues', 'integrations'] }).primaryKey(),
  lastSentAt: tz('last_sent_at'),
});

/**
 * How long jobs wait in each queue, as the worker's minute sweep last read them from pg-boss
 * (ADR-096): jobs pg-boss would hand to a worker now and when the oldest became due. Late past the
 * queue's limit until the wait is back under half of it. Written only through
 * `ops.record_queue_waits`, `ops.mark_queue_alert` and `ops.platform_acknowledge_late_queue`;
 * platform staff read it all, the worker only the check (not the acknowledgement, ADR-177).
 */
export const queueWaits = opsSchema.table('queue_waits', {
  queue: text('queue').primaryKey(),
  waiting: integer('waiting').notNull(),
  oldestWaitingSince: tz('oldest_waiting_since'),
  limitMinutes: integer('limit_minutes').notNull(),
  checkedAt: tz('checked_at').notNull(),
  lateSince: tz('late_since'),
  alertedAt: tz('alerted_at'),
  /** An administrator's note while the queue is late (ADR-177), cleared once it is on time. */
  acknowledgedAt: tz('acknowledged_at'),
  acknowledgedByUserId: text('acknowledged_by_user_id'),
  acknowledgement: text('acknowledgement'),
});

/** What happened at one provider while a company was deleted (ADR-055). */
export interface TenantDeletionCleanup {
  kind:
    | 'whatsapp_account'
    | 'shopify_store'
    | 'woocommerce_store'
    | 'card_mandate'
    | 'plan_subscription';
  label: string;
  outcome: 'done' | 'failed' | 'skipped';
  code?: string;
}

/** The deletion register: one row per request to delete a company, kept afterwards (ADR-055). */
export const tenantDeletions = opsSchema.table('tenant_deletions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  requestedByUserId: text('requested_by_user_id').notNull(),
  requestedAt: tz('requested_at').notNull().defaultNow(),
  dueAt: tz('due_at').notNull(),
  previousStatus: text('previous_status', {
    enum: ['active', 'suspended', 'restricted'],
  }).notNull(),
  previousStatusReason: text('previous_status_reason'),
  companyName: text('company_name').notNull(),
  cancelledAt: tz('cancelled_at'),
  cancelledByUserId: text('cancelled_by_user_id'),
  startedAt: tz('started_at'),
  attempts: integer('attempts').notNull().default(0),
  notifyUserIds: text('notify_user_ids')
    .array()
    .notNull()
    .default(sql`'{}'`),
  providerCleanup: jsonb('provider_cleanup')
    .$type<TenantDeletionCleanup[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  providerCleanupAt: tz('provider_cleanup_at'),
  rowsDeleted: bigint('rows_deleted', { mode: 'number' }).notNull().default(0),
  completedAt: tz('completed_at'),
  /** Who scheduled the deletion (ADR-090): an owner, or HyFib staff with `reason`. */
  requestedBy: text('requested_by', { enum: ['owner', 'platform'] })
    .notNull()
    .default('owner'),
  reason: text('reason'),
  /** Who cancelled it; empty on deletions cancelled before ADR-090 (owners only then). */
  cancelledBy: text('cancelled_by', { enum: ['owner', 'platform'] }),
  cancelReason: text('cancel_reason'),
  scheduledNotifiedAt: tz('scheduled_notified_at'),
  cancelledNotifiedAt: tz('cancelled_notified_at'),
});

/**
 * The chat channel the operations alerts are posted to (ADR-338): one row at most, its address
 * sealed with the keyring under its id. Set, removed and read for the console only through the
 * definer functions of migrations 0258 and 0261; the runtime role reads the sealed address, to send
 * the posts, and re-encrypts it (the keyring sweep).
 */
export const platformAlertChannel = opsSchema.table('platform_alert_channel', {
  id: uuid('id').primaryKey(),
  urlCiphertext: text('url_ciphertext').notNull(),
  host: text('host').notNull(),
  /** The alerts it gets, in the console's order (ADR-340). */
  kinds: text('kinds')
    .array()
    .notNull()
    .default(sql`ARRAY['failures', 'queues', 'integrations']::text[]`)
    .$type<('failures' | 'queues' | 'integrations' | 'reconciliation' | 'unsettled')[]>(),
  /** How it reads a post: a JSON `text` member or a Teams card (ADR-388, migration 0304). */
  format: text('format', { enum: ['text', 'teams_card'] })
    .notNull()
    .default('text'),
  setBy: text('set_by'),
  setAt: tz('set_at').notNull().defaultNow(),
  lastSentAt: tz('last_sent_at'),
  lastFailedAt: tz('last_failed_at'),
  /** The last failure: an HTTP status or an error code, never both. */
  lastStatus: integer('last_status'),
  lastError: text('last_error'),
});

/**
 * The alerts' posts to the chat channel (ADR-338), each with its alert's counts-only text, kept 7
 * days after it is sent or fails. Written only through the definer functions of migration 0258.
 */
export const platformAlertPosts = opsSchema.table('platform_alert_posts', {
  id: uuid('id').primaryKey(),
  kind: text('kind', {
    enum: ['failures', 'queues', 'integrations', 'reconciliation', 'unsettled', 'test'],
  }).notNull(),
  body: text('body').notNull(),
  /** The text unescaped, rendered in the channel's format when sent (ADR-388); null before 0304. */
  plainBody: text('plain_body'),
  createdAt: tz('created_at').notNull().defaultNow(),
  attempts: smallint('attempts').notNull().default(0),
  nextAttemptAt: tz('next_attempt_at').notNull().defaultNow(),
  leaseUntil: tz('lease_until'),
  sentAt: tz('sent_at'),
  failedAt: tz('failed_at'),
  lastStatus: integer('last_status'),
  lastError: text('last_error'),
});

/**
 * Each company's messages on each UTC day it had any (ADR-341): sent, those of them failed and
 * received, counted by the worker once the day ended, and since migration 0264 those of them
 * cancelled, delivered and read (ADR-346; null on a row counted before it). Written and read only
 * through the definer functions of migrations 0262 and 0264; a company's rows are deleted with the
 * company.
 */
export const platformMessageDays = opsSchema.table('platform_message_days', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  utcDay: date('utc_day', { mode: 'string' }).notNull(),
  outbound: integer('outbound').notNull(),
  failed: integer('failed').notNull(),
  inbound: integer('inbound').notNull(),
  canceled: integer('canceled'),
  delivered: integer('delivered'),
  read: integer('read'),
});

/**
 * The days `platformMessageDays` holds counts of, when each was last counted (ADR-341), whether it
 * was counted with its sends cancelled, delivered and read (ADR-346), and whether with its failed
 * sends by code (ADR-350).
 */
export const platformMessageDaysCounted = opsSchema.table('platform_message_days_counted', {
  utcDay: date('utc_day', { mode: 'string' }).primaryKey(),
  countedAt: tz('counted_at').notNull().defaultNow(),
  outcomes: boolean('outcomes').notNull().default(false),
  reasons: boolean('reasons').notNull().default(false),
});

/**
 * Each company's failed sends on each UTC day by error code (ADR-350; the empty code for a failure
 * recorded without one), counted with the day's counts. Written and read only through the definer
 * functions of migration 0269; a company's rows are deleted with the company.
 */
export const platformFailureReasonDays = opsSchema.table('platform_failure_reason_days', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  utcDay: date('utc_day', { mode: 'string' }).notNull(),
  reasonCode: text('reason_code').notNull(),
  failed: integer('failed').notNull(),
});
