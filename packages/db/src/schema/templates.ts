import { integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { jsonb } from './columns';
import { appSchema } from './tenancy';

/** WhatsApp message templates and their review history (migration 0005). */
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/**
 * `draft`, `submitting` and `submit_failed` are local states before Meta has the template; the
 * rest mirror Meta's review states (`unknown` holds a value we do not recognise).
 */
export const TEMPLATE_STATUSES = [
  'draft',
  'submitting',
  'submit_failed',
  'pending',
  'approved',
  'rejected',
  'paused',
  'disabled',
  'in_appeal',
  'flagged',
  'archived',
  'pending_deletion',
  'deleted',
  'limit_exceeded',
  'locked',
  'unknown',
] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const TEMPLATE_EDIT_STATES = ['sending', 'failed'] as const;
export type TemplateEditState = (typeof TEMPLATE_EDIT_STATES)[number];

/** Where a template's status change came from (`edit`: an edit of a template Meta has, 0316). */
export const TEMPLATE_EVENT_SOURCES = ['submit', 'sync', 'send', 'delete', 'edit'] as const;
export type TemplateEventSource = (typeof TEMPLATE_EVENT_SOURCES)[number];

export const messageTemplates = appSchema.table('message_templates', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  whatsappAccountId: uuid('whatsapp_account_id').notNull(),
  name: text('name').notNull(),
  language: text('language').notNull(),
  category: text('category', { enum: TEMPLATE_CATEGORIES }).notNull(),
  components: jsonb('components').notNull().$type<unknown[]>(),
  status: text('status', { enum: TEMPLATE_STATUSES }).notNull().default('draft'),
  providerTemplateId: text('provider_template_id'),
  providerStatus: text('provider_status'),
  rejectionReason: text('rejection_reason'),
  qualityScore: text('quality_score'),
  submitError: text('submit_error'),
  origin: text('origin', { enum: ['local', 'synced'] })
    .notNull()
    .default('local'),
  version: integer('version').notNull().default(0),
  createdByUserId: text('created_by_user_id'),
  /** The key that added it through the API (ADR-295); neither for a template found at Meta. */
  createdByApiKeyId: uuid('created_by_api_key_id'),
  submittedAt: tz('submitted_at'),
  /**
   * When work this row waits for, deferred because Meta throttled the account's management calls,
   * runs again (ADR-399, migration 0310). Windows that give up on a request count from the later of
   * the request and this time, so time spent deferred for a pause is never counted against it.
   */
  managementDeferredUntil: tz('management_deferred_until'),
  /**
   * An edit of a template Meta has (ADR-404, migration 0316): `sending` from the request until
   * Meta's answer (written ahead), `failed` when Meta refused it or never confirmed it; null when
   * none is open. The content sent, when and by which member (null for an API key) it was asked.
   */
  editState: text('edit_state', { enum: TEMPLATE_EDIT_STATES }),
  editComponents: jsonb('edit_components').$type<unknown[]>(),
  editError: text('edit_error'),
  editRequestedAt: tz('edit_requested_at'),
  editRequestedByUserId: text('edit_requested_by_user_id'),
  lastSyncedAt: tz('last_synced_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const templateStatusEvents = appSchema.table('template_status_events', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  templateId: uuid('template_id').notNull(),
  status: text('status').notNull(),
  reason: text('reason'),
  source: text('source', { enum: TEMPLATE_EVENT_SOURCES }).notNull(),
  actorUserId: text('actor_user_id'),
  occurredAt: tz('occurred_at').notNull().defaultNow(),
});
