import { boolean, integer, jsonb, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from './tenancy';

/**
 * Contact profile extensions, consent and suppression (migration 0005). The contacts table itself
 * lives in ./messaging (it predates this migration). Current consent state is written only by the
 * `app.apply_consent_event` trigger; runtime code appends consent events and reads the state.
 */
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const contactTags = appSchema.table('contact_tags', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  tag: text('tag').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const CONTACT_FIELD_TYPES = ['text', 'number', 'date', 'boolean'] as const;
export type ContactFieldType = (typeof CONTACT_FIELD_TYPES)[number];

export const contactFields = appSchema.table('contact_fields', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  key: text('key').notNull(),
  label: text('label').notNull(),
  type: text('type', { enum: CONTACT_FIELD_TYPES }).notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

/** A row-level import message: `error` rows were not imported; `notice` rows were, with a caveat. */
export interface ImportRowMessage {
  row: number;
  level: 'error' | 'notice';
  message: string;
}

export const contactImports = appSchema.table('contact_imports', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  fileName: text('file_name').notNull(),
  totalRows: integer('total_rows').notNull(),
  createdCount: integer('created_count').notNull(),
  updatedCount: integer('updated_count').notNull(),
  skippedCount: integer('skipped_count').notNull().default(0),
  errorCount: integer('error_count').notNull(),
  consentRecordedCount: integer('consent_recorded_count').notNull().default(0),
  errors: jsonb('errors')
    .notNull()
    .default(sql`'[]'::jsonb`)
    .$type<ImportRowMessage[]>(),
  consentAttestation: text('consent_attestation'),
  createdByUserId: text('created_by_user_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const CONSENT_PURPOSES = ['marketing', 'utility'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export const CONSENT_SOURCES = [
  'keyword',
  'agent',
  'import',
  'provider',
  'api',
  'erasure',
] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export const consentEvents = appSchema.table('consent_events', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  purpose: text('purpose', { enum: CONSENT_PURPOSES }).notNull(),
  action: text('action', { enum: ['opt_in', 'opt_out'] }).notNull(),
  source: text('source', { enum: CONSENT_SOURCES }).notNull(),
  channelAccountId: uuid('channel_account_id'),
  evidence: jsonb('evidence')
    .notNull()
    .default(sql`'{}'::jsonb`)
    .$type<Record<string, unknown>>(),
  actorType: text('actor_type', { enum: ['user', 'contact', 'system', 'provider'] }).notNull(),
  actorId: text('actor_id'),
  occurredAt: tz('occurred_at').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const contactConsents = appSchema.table('contact_consents', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  purpose: text('purpose', { enum: CONSENT_PURPOSES }).notNull(),
  status: text('status', { enum: ['opted_in', 'opted_out'] }).notNull(),
  eventId: uuid('event_id').notNull(),
  occurredAt: tz('occurred_at').notNull(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const SUPPRESSION_REASONS = ['manual', 'complaint', 'legal', 'erased'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const suppressions = appSchema.table('suppressions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  phoneE164: text('phone_e164').notNull(),
  reason: text('reason', { enum: SUPPRESSION_REASONS }).notNull(),
  note: text('note'),
  createdByUserId: text('created_by_user_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const messagingSettings = appSchema.table('messaging_settings', {
  tenantId: uuid('tenant_id').primaryKey(),
  optOutKeywords: text('opt_out_keywords').array().notNull(),
  marketingOptOutKeywords: text('marketing_opt_out_keywords').array().notNull(),
  optInKeywords: text('opt_in_keywords').array().notNull(),
  requireMarketingOptIn: boolean('require_marketing_opt_in').notNull().default(true),
  campaignApprovalRequired: boolean('campaign_approval_required').notNull().default(false),
  marketingCapCount: smallint('marketing_cap_count'),
  marketingCapDays: smallint('marketing_cap_days'),
  costCurrency: text('cost_currency'),
  firstResponseTargetMinutes: smallint('first_response_target_minutes'),
  updatedByUserId: text('updated_by_user_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});
