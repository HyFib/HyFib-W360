import { bigint, boolean, integer, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { opsSchema } from './ops';
import { appSchema } from './tenancy';

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Areas a plan may leave out (ADR-051); everything else is in every plan. */
export const PLAN_MODULES = ['automations', 'flows', 'crm', 'commerce'] as const;
export type PlanModule = (typeof PLAN_MODULES)[number];

export const PLAN_STATUSES = ['draft', 'published', 'retired'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_INTERVALS = [1, 3, 12] as const;

/** One version of a plan code (migration 0023). NULL limits mean no limit. */
export const plans = opsSchema.table('plans', {
  id: uuid('id').primaryKey(),
  code: text('code').notNull(),
  version: integer('version').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  currency: text('currency').notNull().default('INR'),
  priceMinor: bigint('price_minor', { mode: 'number' }).notNull(),
  intervalMonths: smallint('interval_months').notNull(),
  trialDays: smallint('trial_days').notNull().default(0),
  graceDays: smallint('grace_days').notNull().default(7),
  seatsIncluded: integer('seats_included').notNull(),
  seatPriceMinor: bigint('seat_price_minor', { mode: 'number' }),
  seatsMax: integer('seats_max'),
  numbersIncluded: integer('numbers_included').notNull(),
  numberPriceMinor: bigint('number_price_minor', { mode: 'number' }),
  numbersMax: integer('numbers_max'),
  teamsMax: integer('teams_max'),
  liveAutomationsMax: integer('live_automations_max'),
  automationRunsMonthly: integer('automation_runs_monthly'),
  runPackSize: integer('run_pack_size'),
  runPackPriceMinor: bigint('run_pack_price_minor', { mode: 'number' }),
  modules: text('modules').array().notNull().$type<PlanModule[]>(),
  /** Requests to the public API per monthly usage period; null: no limit; 0: no API (ADR-061). */
  apiRequestsMonthly: integer('api_requests_monthly'),
  status: text('status', { enum: PLAN_STATUSES }).notNull().default('draft'),
  createdByUserId: text('created_by_user_id').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  publishedByUserId: text('published_by_user_id'),
  publishedAt: tz('published_at'),
  retiredByUserId: text('retired_by_user_id'),
  retiredAt: tz('retired_at'),
});

/** The default trial for new companies (a single row). */
export const planSettings = opsSchema.table('plan_settings', {
  id: boolean('id').primaryKey().default(true),
  defaultTrialPlanId: uuid('default_trial_plan_id'),
  updatedByUserId: text('updated_by_user_id'),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const TENANT_PLAN_STATUSES = [
  'complimentary',
  'trialing',
  'active',
  'past_due',
  'expired',
  'canceled',
] as const;
export type TenantPlanStatus = (typeof TENANT_PLAN_STATUSES)[number];

/** A company's plan state (one row per company). */
export const tenantPlans = appSchema.table('tenant_plans', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  planId: uuid('plan_id'),
  status: text('status', { enum: TENANT_PLAN_STATUSES }).notNull(),
  trialEndsAt: tz('trial_ends_at'),
  periodStart: tz('period_start'),
  periodEnd: tz('period_end'),
  graceEndsAt: tz('grace_ends_at'),
  extraSeats: integer('extra_seats').notNull().default(0),
  extraNumbers: integer('extra_numbers').notNull().default(0),
  runPacks: integer('run_packs').notNull().default(0),
  usageAnchor: tz('usage_anchor').notNull().defaultNow(),
  note: text('note'),
  changedByUserId: text('changed_by_user_id'),
  changedAt: tz('changed_at').notNull().defaultNow(),
  version: integer('version').notNull().default(1),
});

export const USAGE_METRICS = ['automation_runs', 'api_requests'] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export const usageCounters = appSchema.table('usage_counters', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  metric: text('metric', { enum: USAGE_METRICS }).notNull(),
  periodStart: tz('period_start').notNull(),
  used: integer('used').notNull(),
  notifiedAt: tz('notified_at'),
});
