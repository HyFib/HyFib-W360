import { boolean, date, integer, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { appSchema } from './tenancy';
import { opsSchema } from './ops';

/**
 * Persisted metric definitions and reply turns (migration 0007). Turns are written by database
 * triggers on app.messages, app.conversations and app.automation_runs (migration 0011); application
 * code only reads them.
 */
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const METRIC_UNITS = ['count', 'rate', 'duration', 'money'] as const;

export const metricDefinitions = opsSchema.table(
  'metric_definitions',
  {
    key: text('key').notNull(),
    version: integer('version').notNull(),
    label: text('label').notNull(),
    unit: text('unit', { enum: METRIC_UNITS }).notNull(),
    description: text('description').notNull(),
    numerator: text('numerator').notNull(),
    denominator: text('denominator'),
    windowRule: text('window_rule'),
    timezoneRule: text('timezone_rule'),
    missingData: text('missing_data').notNull(),
    freshness: text('freshness').notNull(),
    available: boolean('available').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.key, t.version] })],
);

/** `automated`: an automation took the conversation over while the customer was waiting. */
export const TURN_END_REASONS = ['replied', 'resolved', 'automated'] as const;
export type TurnEndReason = (typeof TURN_END_REASONS)[number];

/** `handoff`: the turn opened when an automation passed the conversation to people. */
export const TURN_START_REASONS = ['customer', 'handoff'] as const;
export type TurnStartReason = (typeof TURN_START_REASONS)[number];

export const conversationTurns = appSchema.table('conversation_turns', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  firstMessageId: uuid('first_message_id'),
  startedAt: tz('started_at').notNull(),
  startReason: text('start_reason', { enum: TURN_START_REASONS }).notNull().default('customer'),
  endedAt: tz('ended_at'),
  endReason: text('end_reason', { enum: TURN_END_REASONS }),
  endedByMembershipId: uuid('ended_by_membership_id'),
  replyMessageId: uuid('reply_message_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

/**
 * Overdue reply emails (migration 0154, ADR-230): at most one per reply turn. `waiting` while
 * business hours put the due time off (the sweep looks again at `dueAt`); `sent` or `skipped` for
 * good.
 */
export const OVERDUE_NOTICE_STATES = ['waiting', 'sent', 'skipped'] as const;
export type OverdueNoticeState = (typeof OVERDUE_NOTICE_STATES)[number];

/**
 * `too_late`: due more than a day before the sweep saw it (the worker was down, the company was
 * suspended); `no_one`: no active member could answer it; `opted_out`: every member responsible
 * turned these emails off.
 */
export const OVERDUE_NOTICE_SKIP_REASONS = ['too_late', 'no_one', 'opted_out'] as const;
export type OverdueNoticeSkipReason = (typeof OVERDUE_NOTICE_SKIP_REASONS)[number];

export const overdueReplyNotices = appSchema.table('overdue_reply_notices', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  turnId: uuid('turn_id').notNull(),
  state: text('state', { enum: OVERDUE_NOTICE_STATES }).notNull(),
  dueAt: tz('due_at').notNull(),
  emailed: integer('emailed').notNull().default(0),
  skipReason: text('skip_reason', { enum: OVERDUE_NOTICE_SKIP_REASONS }),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

/** How often a member's report email goes out (ADR-376). */
export const REPORT_EMAIL_FREQUENCIES = ['weekly', 'monthly'] as const;
export type ReportEmailFrequency = (typeof REPORT_EMAIL_FREQUENCIES)[number];

/**
 * Report emails (migration 0295, ADR-376): a member's own choice of an email of the company's
 * report totals each week or month, due at `nextSendAt`; the last period emailed is kept.
 */
export const reportEmailSubscriptions = appSchema.table('report_email_subscriptions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  membershipId: uuid('membership_id').notNull(),
  frequency: text('frequency', { enum: REPORT_EMAIL_FREQUENCIES }).notNull(),
  nextSendAt: tz('next_send_at').notNull(),
  attemptedAt: tz('attempted_at'),
  lastPeriodFrom: date('last_period_from', { mode: 'string' }),
  lastPeriodTo: date('last_period_to', { mode: 'string' }),
  lastSentAt: tz('last_sent_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});
