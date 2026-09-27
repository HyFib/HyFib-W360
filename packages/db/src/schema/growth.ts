import { boolean, date, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { appSchema } from './tenancy';

/**
 * Growth tools (migration 0016): click-to-chat links with a counted short link, website widgets
 * that open a link, and where conversations come from (click-to-WhatsApp ads and links).
 */
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const chatLinks = appSchema.table('chat_links', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  channelAccountId: uuid('channel_account_id').notNull(),
  name: text('name').notNull(),
  message: text('message').notNull().default(''),
  /** Appended to the pre-filled message as "(ref ABC123)" when `includeRef` is set. */
  refCode: text('ref_code').notNull(),
  includeRef: boolean('include_ref').notNull().default(true),
  /** The public short link /l/<slug>. */
  slug: text('slug').notNull(),
  archivedAt: tz('archived_at'),
  version: integer('version').notNull().default(1),
  createdByMembershipId: uuid('created_by_membership_id').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

/** Clicks per link and day (company time zone), counted by ops.follow_chat_link. */
export const chatLinkClicks = appSchema.table('chat_link_clicks', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  linkId: uuid('link_id').notNull(),
  day: date('day', { mode: 'string' }).notNull(),
  clicks: integer('clicks').notNull().default(0),
});

export const WIDGET_SIDES = ['left', 'right'] as const;
export type WidgetSide = (typeof WIDGET_SIDES)[number];

export const chatWidgets = appSchema.table('chat_widgets', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  linkId: uuid('link_id').notNull(),
  /** The script's public address /widget/<publicId>.js. */
  publicId: text('public_id').notNull(),
  label: text('label').notNull(),
  greeting: text('greeting'),
  side: text('side', { enum: WIDGET_SIDES }).notNull().default('right'),
  color: text('color').notNull().default('#1f7a4d'),
  enabled: boolean('enabled').notNull().default(true),
  version: integer('version').notNull().default(1),
  createdByMembershipId: uuid('created_by_membership_id').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const CONVERSATION_SOURCE_KINDS = ['ad', 'link'] as const;
export type ConversationSourceKind = (typeof CONVERSATION_SOURCE_KINDS)[number];

export const conversationSources = appSchema.table('conversation_sources', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  messageId: uuid('message_id').notNull(),
  kind: text('kind', { enum: CONVERSATION_SOURCE_KINDS }).notNull(),
  linkId: uuid('link_id'),
  adSourceType: text('ad_source_type'),
  adSourceId: text('ad_source_id'),
  adSourceUrl: text('ad_source_url'),
  adHeadline: text('ad_headline'),
  occurredAt: tz('occurred_at').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});
