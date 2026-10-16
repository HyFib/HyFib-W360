import { boolean, date, smallint, text, time, timestamp, uuid } from 'drizzle-orm/pg-core';
import { appSchema } from './tenancy';

/**
 * Inbox teams and routing, member availability, business hours, conversation cases, saved replies,
 * note mentions and CSAT surveys (migration 0009). Cases are written by database triggers on
 * app.conversations; application code only reads them.
 */
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const TEAM_ASSIGNMENT_MODES = ['manual', 'round_robin'] as const;
export type TeamAssignmentMode = (typeof TEAM_ASSIGNMENT_MODES)[number];

export const teams = appSchema.table('teams', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  assignment: text('assignment', { enum: TEAM_ASSIGNMENT_MODES }).notNull().default('manual'),
  maxOpenPerMember: smallint('max_open_per_member'),
  routingKeywords: text('routing_keywords').array().notNull().default([]),
  lastAssignedMembershipId: uuid('last_assigned_membership_id'),
  /** The team's own first-response target in minutes (ADR-377); null uses the company's. */
  firstResponseTargetMinutes: smallint('first_response_target_minutes'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const teamMembers = appSchema.table('team_members', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  teamId: uuid('team_id').notNull(),
  membershipId: uuid('membership_id').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const memberAvailability = appSchema.table('member_availability', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  membershipId: uuid('membership_id').notNull(),
  available: boolean('available').notNull(),
  changedAt: tz('changed_at').notNull().defaultNow(),
});

export const businessHours = appSchema.table('business_hours', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  /** ISO weekday, 1 = Monday. */
  weekday: smallint('weekday').notNull(),
  /** 'HH:MM:SS'; closes_at may be '24:00:00'. */
  opensAt: time('opens_at').notNull(),
  closesAt: time('closes_at').notNull(),
});

export const businessHolidays = appSchema.table('business_holidays', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  day: date('day', { mode: 'string' }).notNull(),
  name: text('name').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const conversationCases = appSchema.table('conversation_cases', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  openedAt: tz('opened_at').notNull(),
  resolvedAt: tz('resolved_at'),
  resolvedByMembershipId: uuid('resolved_by_membership_id'),
  assignedMembershipId: uuid('assigned_membership_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const savedReplies = appSchema.table('saved_replies', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  shortcut: text('shortcut').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  /** Exactly one of the member and the key (ADR-291, migration 0211) added the reply. */
  createdByMembershipId: uuid('created_by_membership_id'),
  createdByApiKeyId: uuid('created_by_api_key_id'),
  /** Exactly one of the member and the key last changed it. */
  updatedByMembershipId: uuid('updated_by_membership_id'),
  updatedByApiKeyId: uuid('updated_by_api_key_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const noteMentions = appSchema.table('note_mentions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  noteId: uuid('note_id').notNull(),
  membershipId: uuid('membership_id').notNull(),
  readAt: tz('read_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const CSAT_SKIP_REASONS = [
  'window_closed',
  'opted_out',
  'suppressed',
  'contact_erased',
  'no_phone',
  'channel_inactive',
  'recently_surveyed',
] as const;
export type CsatSkipReason = (typeof CSAT_SKIP_REASONS)[number];

export const csatSurveys = appSchema.table('csat_surveys', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  caseId: uuid('case_id'),
  messageId: uuid('message_id'),
  skipReason: text('skip_reason', { enum: CSAT_SKIP_REASONS }),
  assignedMembershipId: uuid('assigned_membership_id'),
  resolvedByMembershipId: uuid('resolved_by_membership_id'),
  /** 3 = best label, 1 = worst. */
  score: smallint('score'),
  answeredAt: tz('answered_at'),
  responseMessageId: uuid('response_message_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
});
