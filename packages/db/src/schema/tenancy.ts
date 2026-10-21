import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  inet,
  integer,
  pgSchema,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { jsonb } from './columns';

export const appSchema = pgSchema('app');

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const TENANT_ROLES = [
  'owner',
  'admin',
  'supervisor',
  'agent',
  'marketer',
  'analyst',
  'billing',
] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

/**
 * The roles a company can hide customers' numbers from (migration 0152, ADR-226); owners and
 * administrators always see them.
 */
export const MASKABLE_ROLES = ['supervisor', 'agent', 'marketer', 'analyst'] as const;
export type MaskableRole = (typeof MASKABLE_ROLES)[number];

/** restricted: the company's plan lapsed (ADR-051); it behaves like suspended. */
export const TENANT_STATUSES = [
  'active',
  'suspended',
  'restricted',
  'pending_deletion',
  'deleted',
] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const MEMBERSHIP_STATUSES = ['active', 'suspended', 'removed'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const tenants = appSchema.table('tenants', {
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  status: text('status', { enum: TENANT_STATUSES }).notNull().default('active'),
  statusReason: text('status_reason'),
  statusChangedAt: tz('status_changed_at'),
  billingMode: text('billing_mode', { enum: ['direct_meta', 'partner_billed'] })
    .notNull()
    .default('direct_meta'),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  locale: text('locale').notNull().default('en'),
  dataRegion: text('data_region').notNull().default('in'),
  requireMfaAllMembers: boolean('require_mfa_all_members').notNull().default(false),
  /** The roles whose members see customers' numbers masked (migration 0152, ADR-226). */
  maskedNumberRoles: text('masked_number_roles')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`)
    .$type<MaskableRole[]>(),
  /** The share of a monthly limit at which billing managers are warned (ADR-144). */
  usageWarningPercent: smallint('usage_warning_percent').notNull().default(80),
  createdByUserId: text('created_by_user_id').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const memberships = appSchema.table('memberships', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: text('user_id').notNull(),
  roles: text('roles').array().notNull().$type<TenantRole[]>(),
  status: text('status', { enum: MEMBERSHIP_STATUSES }).notNull().default('active'),
  displayName: text('display_name'),
  invitedByUserId: text('invited_by_user_id'),
  joinedAt: tz('joined_at').notNull().defaultNow(),
  statusChangedAt: tz('status_changed_at'),
  statusChangedBy: text('status_changed_by'),
  /** The notice emails the member turned off in this company (migration 0142, ADR-215). */
  emailOptOuts: text('email_opt_outs')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const invitations = appSchema.table('invitations', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  email: text('email').notNull(),
  roles: text('roles').array().notNull().$type<TenantRole[]>(),
  tokenHash: text('token_hash').notNull(),
  status: text('status', { enum: ['pending', 'accepted', 'revoked', 'expired'] })
    .notNull()
    .default('pending'),
  expiresAt: tz('expires_at').notNull(),
  invitedByUserId: text('invited_by_user_id').notNull(),
  acceptedByUserId: text('accepted_by_user_id'),
  acceptedAt: tz('accepted_at'),
  revokedByUserId: text('revoked_by_user_id'),
  revokedAt: tz('revoked_at'),
  sendCount: integer('send_count').notNull().default(1),
  lastSentAt: tz('last_sent_at').notNull().defaultNow(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const AUDIT_ACTOR_TYPES = [
  'user',
  'system',
  'platform_admin',
  'api_key',
  'provider',
] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const auditEvents = appSchema.table('audit_events', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  occurredAt: tz('occurred_at').notNull().defaultNow(),
  actorType: text('actor_type', { enum: AUDIT_ACTOR_TYPES }).notNull(),
  actorId: text('actor_id'),
  action: text('action').notNull(),
  subjectType: text('subject_type'),
  subjectId: text('subject_id'),
  result: text('result', { enum: ['success', 'denied', 'failure'] }).notNull(),
  correlationId: text('correlation_id'),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  metadata: jsonb('metadata')
    .notNull()
    .default(sql`'{}'::jsonb`)
    .$type<Record<string, unknown>>(),
});

/** A stored company export's status (migration 0325, ADR-415). */
export const COMPANY_EXPORT_STATUSES = ['queued', 'running', 'ready', 'failed', 'expired'] as const;
export type CompanyExportStatus = (typeof COMPANY_EXPORT_STATUSES)[number];

/** Why a stored company export failed: codes only, never data (ADR-129). */
export const COMPANY_EXPORT_FAILURE_REASONS = [
  'too_large',
  'requester_not_allowed',
  'interrupted',
  'timed_out',
  'error',
] as const;
export type CompanyExportFailureReason = (typeof COMPANY_EXPORT_FAILURE_REASONS)[number];

/** One request for a stored company export (migration 0325, ADR-415). */
export const companyExports = appSchema.table('company_exports', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  requestedByMembershipId: uuid('requested_by_membership_id').notNull(),
  status: text('status', { enum: COMPANY_EXPORT_STATUSES }).notNull().default('queued'),
  attempts: smallint('attempts').notNull().default(0),
  leaseUntil: tz('lease_until'),
  requestedAt: tz('requested_at').notNull().defaultNow(),
  startedAt: tz('started_at'),
  finishedAt: tz('finished_at'),
  expiresAt: tz('expires_at'),
  deletedAt: tz('deleted_at'),
  byteSize: bigint('byte_size', { mode: 'number' }),
  sha256: text('sha256'),
  partCount: integer('part_count'),
  failureReason: text('failure_reason', { enum: COMPANY_EXPORT_FAILURE_REASONS }),
  failureCode: text('failure_code'),
});

/** A part of a stored company export's file, sealed with the keyring (migration 0325). */
export const companyExportParts = appSchema.table('company_export_parts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  exportId: uuid('export_id').notNull(),
  attempt: smallint('attempt').notNull(),
  seq: integer('seq').notNull(),
  byteSize: integer('byte_size').notNull(),
  ciphertext: text('ciphertext').notNull(),
});

export const userPreferences = appSchema.table('user_preferences', {
  userId: text('user_id').primaryKey(),
  lastTenantId: uuid('last_tenant_id'),
  theme: text('theme', { enum: ['system', 'light', 'dark'] }),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});
