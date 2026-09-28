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

export const userPreferences = appSchema.table('user_preferences', {
  userId: text('user_id').primaryKey(),
  lastTenantId: uuid('last_tenant_id'),
  theme: text('theme', { enum: ['system', 'light', 'dark'] }),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});
