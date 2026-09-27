import { integer, jsonb, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from './tenancy';

/**
 * Automations (migration 0011): an editable draft per automation, immutable versions, runs pinned
 * to a version with their durable position, and an append-only step log. Trigger and graph JSON
 * are validated by the application (`@w360/domain` automations/graph) before they are stored.
 */
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const AUTOMATION_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export const automations = appSchema.table('automations', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status', { enum: AUTOMATION_STATUSES }).notNull().default('draft'),
  draftTrigger: jsonb('draft_trigger').notNull().$type<unknown>(),
  draftGraph: jsonb('draft_graph').notNull().$type<unknown>(),
  draftChannelAccountId: uuid('draft_channel_account_id'),
  draftUpdatedAt: tz('draft_updated_at').notNull().defaultNow(),
  draftUpdatedByMembershipId: uuid('draft_updated_by_membership_id').notNull(),
  activeVersionId: uuid('active_version_id'),
  version: integer('version').notNull().default(0),
  createdByMembershipId: uuid('created_by_membership_id').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const AUTOMATION_VERSION_KINDS = ['published', 'test'] as const;
export type AutomationVersionKind = (typeof AUTOMATION_VERSION_KINDS)[number];

export const automationVersions = appSchema.table('automation_versions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  automationId: uuid('automation_id').notNull(),
  kind: text('kind', { enum: AUTOMATION_VERSION_KINDS }).notNull(),
  number: integer('number'),
  trigger: jsonb('trigger').notNull().$type<unknown>(),
  graph: jsonb('graph').notNull().$type<unknown>(),
  channelAccountId: uuid('channel_account_id'),
  definitionSha256: text('definition_sha256').notNull(),
  note: text('note'),
  createdByMembershipId: uuid('created_by_membership_id').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const AUTOMATION_RUN_STATUSES = [
  'running',
  'waiting',
  'completed',
  'handed_off',
  'taken_over',
  'stopped',
  'failed',
] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];
export const ACTIVE_RUN_STATUSES = ['running', 'waiting'] as const;

/** Why a run ended, by status (the table's CHECK constraint lists the same pairs). */
export const AUTOMATION_END_REASONS = {
  completed: ['end_node', 'no_next'],
  handed_off: ['handoff_node'],
  taken_over: ['agent_replied', 'assigned', 'take_over'],
  stopped: [
    'stopped_by_member',
    'conversation_resolved',
    'opted_out',
    'contact_erased',
    'automation_archived',
  ],
  failed: ['budget_steps', 'budget_loop', 'budget_messages', 'expired', 'send_blocked', 'error'],
} as const;
export type AutomationEndStatus = keyof typeof AUTOMATION_END_REASONS;
export type AutomationEndReason = (typeof AUTOMATION_END_REASONS)[AutomationEndStatus][number];

export const AUTOMATION_TRIGGER_TYPES = [
  'keyword',
  'conversation_started',
  'any_message',
  'test',
] as const;
export type AutomationRunTrigger = (typeof AUTOMATION_TRIGGER_TYPES)[number];

export const automationRuns = appSchema.table('automation_runs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  automationId: uuid('automation_id').notNull(),
  versionId: uuid('version_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  channelAccountId: uuid('channel_account_id').notNull(),
  mode: text('mode', { enum: ['live', 'test'] })
    .notNull()
    .default('live'),
  triggerType: text('trigger_type', { enum: AUTOMATION_TRIGGER_TYPES }).notNull(),
  triggerMessageId: uuid('trigger_message_id'),
  startedByMembershipId: uuid('started_by_membership_id'),
  startedByUserId: text('started_by_user_id'),
  status: text('status', { enum: AUTOMATION_RUN_STATUSES }).notNull().default('running'),
  currentNodeId: text('current_node_id'),
  nodeVisit: integer('node_visit').notNull().default(0),
  waitingFor: text('waiting_for', { enum: ['reply', 'timer'] }),
  waitUntil: tz('wait_until'),
  inputMessageId: uuid('input_message_id'),
  retries: smallint('retries').notNull().default(0),
  stepCount: integer('step_count').notNull().default(0),
  messageCount: integer('message_count').notNull().default(0),
  visits: jsonb('visits')
    .notNull()
    .default(sql`'{}'::jsonb`)
    .$type<Record<string, number>>(),
  variables: jsonb('variables')
    .notNull()
    .default(sql`'{}'::jsonb`)
    .$type<Record<string, string>>(),
  nextStepAt: tz('next_step_at'),
  startedAt: tz('started_at').notNull().defaultNow(),
  endedAt: tz('ended_at'),
  endReason: text('end_reason').$type<AutomationEndReason>(),
  endDetail: text('end_detail'),
  endedByMembershipId: uuid('ended_by_membership_id'),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const AUTOMATION_STEP_OUTCOMES = [
  'started',
  'sent',
  'asked',
  'answered',
  'retried',
  'timed_out',
  'branched',
  'updated',
  'waiting',
  'resumed',
  'handed_off',
  'completed',
  'failed',
  'stopped',
  'taken_over',
] as const;
export type AutomationStepOutcome = (typeof AUTOMATION_STEP_OUTCOMES)[number];

export const automationRunSteps = appSchema.table('automation_run_steps', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  runId: uuid('run_id').notNull(),
  seq: integer('seq').notNull(),
  nodeId: text('node_id'),
  nodeType: text('node_type'),
  outcome: text('outcome', { enum: AUTOMATION_STEP_OUTCOMES }).notNull(),
  branch: text('branch'),
  messageId: uuid('message_id'),
  detail: text('detail'),
  createdAt: tz('created_at').notNull().defaultNow(),
});
