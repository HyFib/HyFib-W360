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
import { jsonb } from './columns';
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

/** PostgreSQL xid8, carried as a decimal string (values exceed Number.MAX_SAFE_INTEGER). */
const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => 'xid8',
});

/**
 * One row per contact and transaction that changed how the API describes the contact, written only
 * by triggers (migration 0091, ADR-114) and read by the API's contact change feed.
 */
export const contactChanges = appSchema.table('contact_changes', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  xact: xid8('xact').notNull(),
  /**
   * The parts of the contact the transaction changed, in the API contact's names (migration 0251,
   * ADR-329): `added` or `erased` alone, else name, phone, email, tags, `fields.<key>`,
   * `consent.marketing`, `consent.utility`, source and merged; null for a change recorded before
   * 0251.
   */
  parts: text('parts').array(),
  /**
   * Where each part last changed among the changes the compaction deleted in this one's favour:
   * part → [transaction, change id], `*` for those recorded before 0251 (ADR-329).
   */
  replaced: jsonb('replaced')
    .notNull()
    .default(sql`'{}'::jsonb`),
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
  'store',
  /** An opt-out a merged contact had, carried to the contact it was merged into (ADR-224). */
  'merge',
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
  actorType: text('actor_type', {
    enum: ['user', 'contact', 'system', 'provider', 'api_key'],
  }).notNull(),
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

/**
 * A contact merged into another and deleted (migration 0147, ADR-224), written only by
 * `app.merge_contacts`: who merged it and when, and how many records moved. The merged contact's
 * details are not kept.
 */
export const contactMerges = appSchema.table('contact_merges', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  keptContactId: uuid('kept_contact_id').notNull(),
  mergedContactId: uuid('merged_contact_id').notNull(),
  mergedByUserId: text('merged_by_user_id'),
  summary: jsonb('summary')
    .notNull()
    .default(sql`'{}'::jsonb`)
    .$type<Record<string, unknown>>(),
  mergedAt: tz('merged_at').notNull().defaultNow(),
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
  businessHoursEnabled: boolean('business_hours_enabled').notNull().default(false),
  csatEnabled: boolean('csat_enabled').notNull().default(false),
  csatQuestion: text('csat_question'),
  csatLabels: text('csat_labels').array(),
  /** Read receipts and typing indicators to customers (migration 0146, ADR-223). */
  readReceipts: boolean('read_receipts').notNull().default(false),
  /**
   * The automatic reply when members are slow to answer (migration 0300, ADR-384): on or off, the
   * text, the delay in minutes and when it was last turned on (only waits started since get it).
   */
  slowReplyEnabled: boolean('slow_reply_enabled').notNull().default(false),
  slowReplyText: text('slow_reply_text'),
  slowReplyDelayMinutes: smallint('slow_reply_delay_minutes'),
  slowReplySince: tz('slow_reply_since'),
  updatedByUserId: text('updated_by_user_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});
