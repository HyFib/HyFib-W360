import {
  bigint,
  integer,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { jsonb } from './columns';
import { appSchema } from './tenancy';
import { opsSchema } from './ops';

/**
 * Saved segments, campaigns, campaign recipients and history (migration 0006), plus the
 * platform-maintained provider rate cards used for cost estimates. Prices and estimates are
 * millionths of the currency's major unit (per-message prices are fractions of a minor unit).
 */
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const micros = (name: string) => bigint(name, { mode: 'number' });

export const segments = appSchema.table('segments', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  definition: jsonb('definition').notNull().$type<Record<string, unknown>>(),
  version: integer('version').notNull().default(0),
  createdByUserId: text('created_by_user_id'),
  updatedByUserId: text('updated_by_user_id'),
  archivedAt: tz('archived_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const CAMPAIGN_STATUSES = [
  'draft',
  'pending_approval',
  'scheduled',
  'running',
  'paused',
  'completed',
  'canceled',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_PAUSE_REASONS = [
  'manual',
  'api',
  'budget_reached',
  'message_cap_reached',
  'template_not_approved',
  'channel_inactive',
  'launcher_removed',
  'launcher_not_permitted',
  'rate_card_missing',
] as const;
export type CampaignPauseReason = (typeof CAMPAIGN_PAUSE_REASONS)[number];

export const CAMPAIGN_COMPLETION_REASONS = ['all_processed', 'deadline_passed'] as const;

export const campaigns = appSchema.table('campaigns', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  status: text('status', { enum: CAMPAIGN_STATUSES }).notNull().default('draft'),
  channelAccountId: uuid('channel_account_id'),
  templateId: uuid('template_id'),
  variables: jsonb('variables').notNull().$type<Record<string, unknown>>(),
  segmentId: uuid('segment_id'),
  audienceDefinition: jsonb('audience_definition').$type<Record<string, unknown>>(),
  audienceUsed: jsonb('audience_used').$type<Record<string, unknown>>(),
  timezone: text('timezone').notNull(),
  scheduleKind: text('schedule_kind', { enum: ['now', 'later'] })
    .notNull()
    .default('now'),
  /** Wall-clock time in `timezone`, as 'YYYY-MM-DD HH:MM:SS'. */
  scheduledLocal: timestamp('scheduled_local', { mode: 'string' }),
  scheduledAt: tz('scheduled_at'),
  scheduleAdjustment: text('schedule_adjustment', { enum: ['gap_shifted', 'ambiguous_earlier'] }),
  /** 'HH:MM:SS' in `timezone`. */
  windowStart: time('window_start'),
  windowEnd: time('window_end'),
  ratePerMinute: integer('rate_per_minute'),
  maxMessages: integer('max_messages'),
  budgetMicros: micros('budget_micros'),
  budgetCurrency: text('budget_currency'),
  estimateCurrency: text('estimate_currency'),
  stopAfterHours: smallint('stop_after_hours').notNull().default(24),
  submittedByUserId: text('submitted_by_user_id'),
  /** The key that submitted it through the API (ADR-202), never with a submitting member. */
  submittedByApiKeyId: uuid('submitted_by_api_key_id'),
  submittedAt: tz('submitted_at'),
  approvedByUserId: text('approved_by_user_id'),
  approvedAt: tz('approved_at'),
  reviewNote: text('review_note'),
  launchedByUserId: text('launched_by_user_id'),
  startedAt: tz('started_at'),
  deadlineAt: tz('deadline_at'),
  nextRunAt: tz('next_run_at'),
  pausedAt: tz('paused_at'),
  pauseReason: text('pause_reason', { enum: CAMPAIGN_PAUSE_REASONS }),
  completedAt: tz('completed_at'),
  completionReason: text('completion_reason', { enum: CAMPAIGN_COMPLETION_REASONS }),
  canceledAt: tz('canceled_at'),
  canceledByUserId: text('canceled_by_user_id'),
  audienceCount: integer('audience_count').notNull().default(0),
  queuedCount: integer('queued_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  spentEstimateMicros: micros('spent_estimate_micros').notNull().default(0),
  version: integer('version').notNull().default(0),
  createdByUserId: text('created_by_user_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const RECIPIENT_STATES = ['pending', 'queued', 'skipped', 'canceled'] as const;
export type RecipientState = (typeof RECIPIENT_STATES)[number];

export const SKIP_REASONS = [
  'contact_erased',
  'no_phone',
  'suppressed',
  'opted_out',
  'no_marketing_opt_in',
  'missing_variable',
  'frequency_capped',
  'cost_unknown',
  'expired',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const campaignRecipients = appSchema.table('campaign_recipients', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  campaignId: uuid('campaign_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  state: text('state', { enum: RECIPIENT_STATES }).notNull().default('pending'),
  skipReason: text('skip_reason', { enum: SKIP_REASONS }),
  messageId: uuid('message_id'),
  market: text('market'),
  estimatedCostMicros: micros('estimated_cost_micros'),
  queuedAt: tz('queued_at'),
  repliedAt: tz('replied_at'),
  optedOutAt: tz('opted_out_at'),
  /** The variant it was given when the audience was taken (migration 0317, ADR-405); never changes. */
  variant: text('variant').notNull().default('A'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

/**
 * A campaign's variants after A (migration 0317, ADR-405): a second template with its own mapping,
 * sent to `share_percent` of the recipients. A is the campaign's own template and mapping.
 */
export const campaignVariants = appSchema.table('campaign_variants', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  campaignId: uuid('campaign_id').notNull(),
  label: text('label').notNull(),
  templateId: uuid('template_id'),
  variables: jsonb('variables').notNull().$type<Record<string, unknown>>(),
  sharePercent: smallint('share_percent').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const CAMPAIGN_EVENT_TYPES = [
  'created',
  'edited',
  'submitted',
  'withdrawn',
  'approved',
  'rejected',
  'scheduled',
  'started',
  'paused',
  'resumed',
  'canceled',
  'completed',
  'test_sent',
] as const;
export type CampaignEventType = (typeof CAMPAIGN_EVENT_TYPES)[number];

export const campaignEvents = appSchema.table('campaign_events', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  campaignId: uuid('campaign_id').notNull(),
  type: text('type', { enum: CAMPAIGN_EVENT_TYPES }).notNull(),
  detail: jsonb('detail').notNull().$type<Record<string, unknown>>(),
  actorUserId: text('actor_user_id'),
  occurredAt: tz('occurred_at').notNull().defaultNow(),
});

export const RATE_CATEGORIES = [
  'marketing',
  'utility',
  'authentication',
  'authentication_international',
  'service',
] as const;
export type RateCategory = (typeof RATE_CATEGORIES)[number];

export const rateCards = opsSchema.table('rate_cards', {
  id: uuid('id').primaryKey(),
  provider: text('provider', { enum: ['meta_whatsapp'] })
    .notNull()
    .default('meta_whatsapp'),
  currency: text('currency').notNull(),
  effectiveFrom: tz('effective_from').notNull(),
  sourceUrl: text('source_url').notNull(),
  notes: text('notes'),
  status: text('status', { enum: ['draft', 'published', 'withdrawn'] })
    .notNull()
    .default('draft'),
  createdByUserId: text('created_by_user_id').notNull(),
  publishedByUserId: text('published_by_user_id'),
  publishedAt: tz('published_at'),
  withdrawnByUserId: text('withdrawn_by_user_id'),
  withdrawnAt: tz('withdrawn_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const rateCardPrefixes = opsSchema.table(
  'rate_card_prefixes',
  {
    rateCardId: uuid('rate_card_id').notNull(),
    prefix: text('prefix').notNull(),
    market: text('market').notNull(),
  },
  (t) => [primaryKey({ columns: [t.rateCardId, t.prefix] })],
);

export const rateCardPrices = opsSchema.table(
  'rate_card_prices',
  {
    rateCardId: uuid('rate_card_id').notNull(),
    market: text('market').notNull(),
    category: text('category', { enum: RATE_CATEGORIES }).notNull(),
    tierFrom: bigint('tier_from', { mode: 'number' }).notNull().default(0),
    priceMicros: micros('price_micros').notNull(),
  },
  (t) => [primaryKey({ columns: [t.rateCardId, t.market, t.category, t.tierFrom] })],
);

/**
 * A company told about a published rate card before it takes effect (migration 0038, ADR-065):
 * one row per company and card, written with the email.
 */
export const rateChangeNotices = appSchema.table('rate_change_notices', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  rateCardId: uuid('rate_card_id').notNull(),
  currency: text('currency').notNull(),
  effectiveFrom: tz('effective_from').notNull(),
  sentAt: tz('sent_at').notNull().defaultNow(),
});
