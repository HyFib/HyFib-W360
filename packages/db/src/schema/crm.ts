import {
  bigint,
  customType,
  date,
  integer,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { jsonb } from './columns';
import { CONTACT_FIELD_TYPES } from './contacts';
import { appSchema } from './tenancy';

/**
 * CRM (migration 0012): pipelines with ordered stages and one currency each, deals linked to a
 * contact, tasks with email reminders, and an append-only activity timeline per contact and deal.
 * Money is an integer in the pipeline currency's minor unit.
 */
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** PostgreSQL xid8, carried as a decimal string (values exceed Number.MAX_SAFE_INTEGER). */
const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => 'xid8',
});

/** Who changes a deal or a task (migration 0196, ADR-277): a member, an automation's run or a key. */
export const CRM_CHANGERS = ['member', 'automation', 'api'] as const;
export type CrmChanger = (typeof CRM_CHANGERS)[number];

export const crmPipelines = appSchema.table('crm_pipelines', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  currency: text('currency').notNull(),
  position: integer('position').notNull().default(0),
  archivedAt: tz('archived_at'),
  version: integer('version').notNull().default(1),
  /** Who added the pipeline: exactly one of a member and a key (ADR-286, migration 0206). */
  createdByMembershipId: uuid('created_by_membership_id'),
  createdByApiKeyId: uuid('created_by_api_key_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const crmStages = appSchema.table('crm_stages', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  pipelineId: uuid('pipeline_id').notNull(),
  name: text('name').notNull(),
  position: integer('position').notNull(),
  archivedAt: tz('archived_at'),
  /** The chance, in whole percent, that the stage's open deals are won (ADR-242); null: not set. */
  winPercent: smallint('win_percent'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const DEAL_STATUSES = ['open', 'won', 'lost'] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

export const crmDeals = appSchema.table('crm_deals', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  pipelineId: uuid('pipeline_id').notNull(),
  stageId: uuid('stage_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  conversationId: uuid('conversation_id'),
  title: text('title').notNull(),
  valueMinor: bigint('value_minor', { mode: 'number' }),
  ownerMembershipId: uuid('owner_membership_id'),
  status: text('status', { enum: DEAL_STATUSES }).notNull().default('open'),
  lostReason: text('lost_reason'),
  expectedCloseOn: date('expected_close_on', { mode: 'string' }),
  stageEnteredAt: tz('stage_entered_at').notNull().defaultNow(),
  closedAt: tz('closed_at'),
  closedByMembershipId: uuid('closed_by_membership_id'),
  version: integer('version').notNull().default(1),
  /** The member who created the deal, or null when an automation did (migration 0160, ADR-245). */
  createdByMembershipId: uuid('created_by_membership_id'),
  /** The automation whose run created the deal (ADR-245); exactly one creator is set. */
  createdByAutomationId: uuid('created_by_automation_id'),
  /** The API key that created the deal (migration 0169, ADR-254). */
  createdByApiKeyId: uuid('created_by_api_key_id'),
  /**
   * Who made the latest change its events report, with the key for `api` (migration 0196,
   * ADR-277); null when the change did not record it. The database clears a changer an earlier
   * transaction recorded (`changedXact`), so a change that does not say who made it never names the
   * one before.
   */
  changedBy: text('changed_by', { enum: CRM_CHANGERS }),
  changedByApiKeyId: uuid('changed_by_api_key_id'),
  changedXact: xid8('changed_xact'),
  /**
   * The deal's custom field values, keyed by field key (migration 0293, ADR-373), each checked
   * against its field's type by the service (dates as YYYY-MM-DD).
   */
  attributes: jsonb('attributes')
    .notNull()
    .default(sql`'{}'::jsonb`)
    .$type<Record<string, string | number | boolean>>(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

/**
 * A company's custom deal fields (migration 0293, ADR-373), of the types contact fields take; a
 * field's key and type never change.
 */
export const crmDealFields = appSchema.table('crm_deal_fields', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  key: text('key').notNull(),
  label: text('label').notNull(),
  type: text('type', { enum: CONTACT_FIELD_TYPES }).notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const TASK_STATUSES = ['open', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const REMINDER_STATES = ['none', 'pending', 'sent', 'skipped'] as const;
export type ReminderState = (typeof REMINDER_STATES)[number];

export const crmTasks = appSchema.table('crm_tasks', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  title: text('title').notNull(),
  notes: text('notes'),
  contactId: uuid('contact_id'),
  dealId: uuid('deal_id'),
  assigneeMembershipId: uuid('assignee_membership_id').notNull(),
  dueAt: tz('due_at'),
  remindAt: tz('remind_at'),
  reminderState: text('reminder_state', { enum: REMINDER_STATES }).notNull().default('none'),
  reminderDetail: text('reminder_detail'),
  remindedAt: tz('reminded_at'),
  status: text('status', { enum: TASK_STATUSES }).notNull().default('open'),
  completedAt: tz('completed_at'),
  completedByMembershipId: uuid('completed_by_membership_id'),
  version: integer('version').notNull().default(1),
  /** The member who created the task, or null when an automation did (migration 0158, ADR-244). */
  createdByMembershipId: uuid('created_by_membership_id'),
  /** The automation whose run created the task (ADR-244); exactly one creator is set. */
  createdByAutomationId: uuid('created_by_automation_id'),
  /** The API key that created the task (migration 0175, ADR-259). */
  createdByApiKeyId: uuid('created_by_api_key_id'),
  /**
   * Who made the latest change its events report, with the key for `api` (migration 0196,
   * ADR-277); null when the change did not record it. The database clears a changer an earlier
   * transaction recorded (`changedXact`), so a change that does not say who made it never names the
   * one before.
   */
  changedBy: text('changed_by', { enum: CRM_CHANGERS }),
  changedByApiKeyId: uuid('changed_by_api_key_id'),
  changedXact: xid8('changed_xact'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const CRM_ACTIVITY_KINDS = [
  'deal_created',
  'deal_updated',
  'stage_changed',
  'owner_changed',
  'deal_won',
  'deal_lost',
  'deal_reopened',
  'task_created',
  'task_completed',
  'task_reopened',
  'task_cancelled',
  'note',
] as const;
export type CrmActivityKind = (typeof CRM_ACTIVITY_KINDS)[number];

export const crmActivities = appSchema.table('crm_activities', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  dealId: uuid('deal_id'),
  taskId: uuid('task_id'),
  actorMembershipId: uuid('actor_membership_id'),
  kind: text('kind', { enum: CRM_ACTIVITY_KINDS }).notNull(),
  data: jsonb('data').notNull().$type<Record<string, unknown>>().default({}),
  body: text('body'),
  createdAt: tz('created_at').notNull().defaultNow(),
});
