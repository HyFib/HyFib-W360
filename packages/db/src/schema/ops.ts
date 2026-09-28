import { sql } from 'drizzle-orm';
import {
  boolean,
  inet,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

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
});
