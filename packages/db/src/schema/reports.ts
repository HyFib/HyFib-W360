import { boolean, integer, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
