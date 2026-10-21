import { integer, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { jsonb } from './columns';
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
  taken_over: ['agent_replied', 'assigned', 'take_over', 'api_replied'],
  stopped: [
    'stopped_by_member',
    'conversation_resolved',
    'opted_out',
    'contact_erased',
    'automation_archived',
    /** Stopped through the public API (migration 0057, ADR-079). */
    'stopped_by_api',
  ],
  failed: [
    'budget_steps',
    'budget_loop',
    'budget_messages',
    'budget_http',
    'expired',
    'send_blocked',
    'send_failed',
    'error',
  ],
} as const;
export type AutomationEndStatus = keyof typeof AUTOMATION_END_REASONS;
export type AutomationEndReason = (typeof AUTOMATION_END_REASONS)[AutomationEndStatus][number];

export const AUTOMATION_TRIGGER_TYPES = [
  'keyword',
  'conversation_started',
  'any_message',
  'test',
  /** Started by a store's order message rule (migration 0022). */
  'store_event',
  /** Started through the public API by a key (migration 0052). */
  'api',
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
  /**
   * The store order a run started by order messages (or a test run with a chosen order) reads
   * while it runs, and the event that started it (migration 0022). Cleared when the order is deleted.
   */
  storeOrderId: uuid('store_order_id'),
  storeEvent: text('store_event', {
    enum: ['order_placed', 'order_shipped', 'order_delivered', 'order_cancelled'],
  }),
  /** The API key a run started through the API came from (migration 0052, ADR-077). */
  apiKeyId: uuid('api_key_id'),
  /** The members' enrolment a run of an `api` automation came from (migration 0311, ADR-401). */
  enrollmentId: uuid('enrollment_id'),
  startedByMembershipId: uuid('started_by_membership_id'),
  startedByUserId: text('started_by_user_id'),
  status: text('status', { enum: AUTOMATION_RUN_STATUSES }).notNull().default('running'),
  currentNodeId: text('current_node_id'),
  nodeVisit: integer('node_visit').notNull().default(0),
  waitingFor: text('waiting_for', { enum: ['reply', 'timer', 'http'] }),
  waitUntil: tz('wait_until'),
  inputMessageId: uuid('input_message_id'),
  /** A bot message the run queued and Meta has not accepted yet; the run waits for it. */
  pendingMessageId: uuid('pending_message_id'),
  retries: smallint('retries').notNull().default(0),
  failures: smallint('failures').notNull().default(0),
  stepCount: integer('step_count').notNull().default(0),
  messageCount: integer('message_count').notNull().default(0),
  /** HTTP calls made by the run (migration 0014; limited per run). */
  httpCallCount: integer('http_call_count').notNull().default(0),
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
  'requested',
  'responded',
  /** A task step created its CRM task, or skipped it (migration 0158, ADR-244). */
  'created',
  'skipped',
  /** A step moved the contact's deal (migration 0162, ADR-250). */
  'moved',
  /** A step closed the contact's deal (migration 0164, ADR-251). */
  'closed',
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

/**
 * The HTTP step (migration 0014): domains a company allows its automations to call, named secrets
 * for request headers (encrypted, never read back by the web app), and the calls runs make, written
 * ahead of the request and never retried once they may have been sent.
 */
export const httpAllowedDomains = appSchema.table('http_allowed_domains', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  domain: text('domain').notNull(),
  createdByMembershipId: uuid('created_by_membership_id').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const httpSecrets = appSchema.table('http_secrets', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  /** The allowed domain (exact or *.pattern) the secret may be sent to. */
  domain: text('domain').notNull(),
  valueCiphertext: text('value_ciphertext').notNull(),
  version: integer('version').notNull().default(1),
  createdByMembershipId: uuid('created_by_membership_id').notNull(),
  updatedByMembershipId: uuid('updated_by_membership_id').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const HTTP_CALL_STATES = [
  'queued',
  'in_flight',
  'succeeded',
  'failed',
  'unknown',
  'canceled',
] as const;
export type HttpCallState = (typeof HTTP_CALL_STATES)[number];

export const automationHttpCalls = appSchema.table('automation_http_calls', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  runId: uuid('run_id').notNull(),
  nodeId: text('node_id').notNull(),
  nodeVisit: integer('node_visit').notNull(),
  method: text('method', { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }).notNull(),
  host: text('host').notNull(),
  path: text('path').notNull(),
  requestCiphertext: text('request_ciphertext'),
  state: text('state', { enum: HTTP_CALL_STATES }).notNull().default('queued'),
  statusCode: smallint('status_code'),
  errorCode: text('error_code'),
  durationMs: integer('duration_ms'),
  savedValues: jsonb('saved_values')
    .notNull()
    .default(sql`'{}'::jsonb`)
    .$type<Record<string, string>>(),
  startedAt: tz('started_at'),
  leaseUntil: tz('lease_until'),
  finishedAt: tz('finished_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

/** What an enrolment started from (migration 0311, ADR-401). */
export const AUTOMATION_ENROLLMENT_SOURCES = ['contacts', 'segment'] as const;
export type AutomationEnrollmentSource = (typeof AUTOMATION_ENROLLMENT_SOURCES)[number];

export const AUTOMATION_ENROLLMENT_STATUSES = [
  'running',
  'completed',
  'stopped',
  'failed',
] as const;
export type AutomationEnrollmentStatus = (typeof AUTOMATION_ENROLLMENT_STATUSES)[number];

/** Why an enrolment stopped before every contact was handled (the table's CHECK lists the same). */
export const AUTOMATION_ENROLLMENT_END_REASONS = [
  'stopped_by_member',
  'member_removed',
  'automation_paused',
  'automation_unavailable',
  'channel_unavailable',
  'not_in_plan',
  'inputs_changed',
  'marketing_not_allowed',
  /** Failed: its batch made no progress after the sweep signalled it 3 times. */
  'stalled',
] as const;
export type AutomationEnrollmentEndReason = (typeof AUTOMATION_ENROLLMENT_END_REASONS)[number];

/**
 * Members' enrolments of contacts or a segment in an automation started by a member or through the
 * API (migration 0311, ADR-401): who, which automation, whom, the inputs (cleared at the end), the
 * counts and the position of the last contact handled.
 */
export const automationEnrollments = appSchema.table('automation_enrollments', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  automationId: uuid('automation_id').notNull(),
  source: text('source', { enum: AUTOMATION_ENROLLMENT_SOURCES }).notNull(),
  segmentId: uuid('segment_id'),
  inputs: jsonb('inputs')
    .notNull()
    .default(sql`'{}'::jsonb`)
    .$type<Record<string, string>>(),
  status: text('status', { enum: AUTOMATION_ENROLLMENT_STATUSES }).notNull().default('running'),
  endReason: text('end_reason', { enum: AUTOMATION_ENROLLMENT_END_REASONS }),
  total: integer('total').notNull(),
  startedCount: integer('started_count').notNull().default(0),
  refusedCount: integer('refused_count').notNull().default(0),
  cancelledCount: integer('cancelled_count').notNull().default(0),
  cursorPosition: integer('cursor_position').notNull().default(0),
  /** When the next batch is due (paced by the number's send rate); null once ended. */
  nextBatchAt: tz('next_batch_at'),
  /** Sweep signals since the last batch handled (ADR-401); at 3 the next sweep fails it. */
  resignalCount: smallint('resignal_count').notNull().default(0),
  createdByMembershipId: uuid('created_by_membership_id').notNull(),
  createdByUserId: text('created_by_user_id').notNull(),
  stoppedByMembershipId: uuid('stopped_by_membership_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
  endedAt: tz('ended_at'),
});

export const AUTOMATION_ENROLLMENT_OUTCOMES = [
  'pending',
  'started',
  'refused',
  'cancelled',
] as const;
export type AutomationEnrollmentOutcome = (typeof AUTOMATION_ENROLLMENT_OUTCOMES)[number];

/** Each enrolled contact, in snapshot order, with its outcome (migration 0311, ADR-401). */
export const automationEnrollmentContacts = appSchema.table('automation_enrollment_contacts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  enrollmentId: uuid('enrollment_id').notNull(),
  position: integer('position').notNull(),
  contactId: uuid('contact_id'),
  outcome: text('outcome', { enum: AUTOMATION_ENROLLMENT_OUTCOMES }).notNull().default('pending'),
  reason: text('reason'),
  runId: uuid('run_id'),
  processedAt: tz('processed_at'),
});
