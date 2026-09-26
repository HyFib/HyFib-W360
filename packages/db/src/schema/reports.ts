import { boolean, integer, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { appSchema } from './tenancy';
import { opsSchema } from './ops';

/**
 * Persisted metric definitions and reply turns (migration 0007). Turns are written by database
 * triggers on app.messages and app.conversations; application code only reads them.
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

export const TURN_END_REASONS = ['replied', 'resolved'] as const;
export type TurnEndReason = (typeof TURN_END_REASONS)[number];

export const conversationTurns = appSchema.table('conversation_turns', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  firstMessageId: uuid('first_message_id'),
  startedAt: tz('started_at').notNull(),
  endedAt: tz('ended_at'),
  endReason: text('end_reason', { enum: TURN_END_REASONS }),
  endedByMembershipId: uuid('ended_by_membership_id'),
  replyMessageId: uuid('reply_message_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
});
