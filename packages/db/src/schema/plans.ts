import { bigint, boolean, integer, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { ApiScope } from './api';
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
  /** The public API scopes the plan includes; null: every scope, including later ones (ADR-092). */
  apiScopes: text('api_scopes').array().$type<ApiScope[]>(),
  status: text('status', { enum: PLAN_STATUSES }).notNull().default('draft'),
  createdByUserId: text('created_by_user_id').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  publishedByUserId: text('published_by_user_id'),
  publishedAt: tz('published_at'),
  retiredByUserId: text('retired_by_user_id'),
  retiredAt: tz('retired_at'),
});

/** The default trial for new companies and the tax on plan prices (a single row). */
export const planSettings = opsSchema.table('plan_settings', {
  id: boolean('id').primaryKey().default(true),
  defaultTrialPlanId: uuid('default_trial_plan_id'),
  /** Tax added to plan prices, in basis points (1800 = 18%); null: not set (ADR-063). */
  planTaxBp: integer('plan_tax_bp'),
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
  /** The subscription that paid the current period; null for periods staff set (ADR-063). */
  subscriptionId: uuid('subscription_id'),
  /**
   * The version staff set that the company's billing managers were not emailed about yet
   * (ADR-100, migration 0077); the worker's sweep clears it.
   */
  staffNoticeVersion: integer('staff_notice_version'),
});

export const PLAN_SUBSCRIPTION_STATUSES = [
  'creating',
  'created',
  'authenticated',
  'active',
  'pending',
  'halted',
  'paused',
  'cancelled',
  'completed',
  'expired',
  'failed',
] as const;
export type PlanSubscriptionStatus = (typeof PLAN_SUBSCRIPTION_STATUSES)[number];
/** Subscriptions that may still be authorised or charged: at most one per company (0037). */
export const LIVE_PLAN_SUBSCRIPTION_STATUSES = [
  'creating',
  'created',
  'authenticated',
  'active',
  'pending',
  'halted',
  'paused',
] as const satisfies readonly PlanSubscriptionStatus[];

/** A Razorpay subscription for the company's plan version and add-ons (migration 0037). */
export const planSubscriptions = appSchema.table('plan_subscriptions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  planId: uuid('plan_id').notNull(),
  status: text('status', { enum: PLAN_SUBSCRIPTION_STATUSES }).notNull().default('creating'),
  intervalMonths: smallint('interval_months').notNull(),
  extraSeats: integer('extra_seats').notNull(),
  extraNumbers: integer('extra_numbers').notNull(),
  runPacks: integer('run_packs').notNull(),
  subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull(),
  taxBp: integer('tax_bp').notNull(),
  taxMinor: bigint('tax_minor', { mode: 'number' }).notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  currency: text('currency').notNull().default('INR'),
  totalCount: smallint('total_count').notNull(),
  providerPlanId: text('provider_plan_id'),
  providerSubscriptionId: text('provider_subscription_id'),
  authorizeBy: tz('authorize_by').notNull(),
  currentStart: tz('current_start'),
  currentEnd: tz('current_end'),
  chargeAt: tz('charge_at'),
  paidCount: integer('paid_count').notNull().default(0),
  endedAt: tz('ended_at'),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  cancelRequestedAt: tz('cancel_requested_at'),
  cancelledByUserId: text('cancelled_by_user_id'),
  failureReason: text('failure_reason'),
  createdByUserId: text('created_by_user_id').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  syncedAt: tz('synced_at'),
  updatedAt: tz('updated_at').notNull().defaultNow(),
  /**
   * A cancellation by HyFib staff the company's billing managers were not emailed about yet
   * (ADR-101, migration 0078); the worker's sweep clears it.
   */
  staffCancelNoticeDue: boolean('staff_cancel_notice_due').notNull().default(false),
  /** When the first charge is due, at the trial's end (ADR-102, 0079); null: charged in Checkout. */
  startsAt: tz('starts_at'),
});

/** A paid invoice of a subscription: the charge and the billing cycle it paid for (0037). */
export const planPayments = appSchema.table('plan_payments', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  subscriptionId: uuid('subscription_id').notNull(),
  providerPaymentId: text('provider_payment_id').notNull(),
  providerInvoiceId: text('provider_invoice_id').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  currency: text('currency').notNull(),
  periodStart: tz('period_start').notNull(),
  periodEnd: tz('period_end').notNull(),
  paidAt: tz('paid_at').notNull(),
  method: text('method'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const PLAN_PAYMENT_REFUND_STATUSES = [
  'requested',
  'submitted',
  'processed',
  'failed',
] as const;
export type PlanPaymentRefundStatus = (typeof PLAN_PAYMENT_REFUND_STATUSES)[number];
export const PLAN_PAYMENT_REFUND_ORIGINS = ['staff', 'razorpay'] as const;
export type PlanPaymentRefundOrigin = (typeof PLAN_PAYMENT_REFUND_ORIGINS)[number];

/**
 * Refunds of plan payments (0080, ADR-103): asked for by a platform owner, or made at Razorpay and
 * recorded from what it reports. The company role reads every column except the staff reason and
 * who asked (column grants).
 */
export const planPaymentRefunds = appSchema.table('plan_payment_refunds', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  planPaymentId: uuid('plan_payment_id').notNull(),
  origin: text('origin', { enum: PLAN_PAYMENT_REFUND_ORIGINS }).notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  status: text('status', { enum: PLAN_PAYMENT_REFUND_STATUSES }).notNull().default('requested'),
  reason: text('reason'),
  requestedByUserId: text('requested_by_user_id'),
  providerRefundId: text('provider_refund_id'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: tz('next_attempt_at').notNull().defaultNow(),
  lastError: text('last_error'),
  requestedAt: tz('requested_at').notNull().defaultNow(),
  submittedAt: tz('submitted_at'),
  processedAt: tz('processed_at'),
  failedAt: tz('failed_at'),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

/**
 * A company's request for a refund of a plan payment (0081, ADR-104): it inserts open requests and
 * withdraws open ones; platform owners decide through a definer function, and approving starts the
 * staff refund of ADR-103. Who decided and the notice marks are not readable by the company.
 */
export const PLAN_PAYMENT_REFUND_REQUEST_STATUSES = [
  'open',
  'approved',
  'declined',
  'withdrawn',
] as const;
export type PlanPaymentRefundRequestStatus = (typeof PLAN_PAYMENT_REFUND_REQUEST_STATUSES)[number];

export const planPaymentRefundRequests = appSchema.table('plan_payment_refund_requests', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  planPaymentId: uuid('plan_payment_id').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  reason: text('reason').notNull(),
  status: text('status', { enum: PLAN_PAYMENT_REFUND_REQUEST_STATUSES }).notNull().default('open'),
  requestedByUserId: text('requested_by_user_id').notNull(),
  requestedAt: tz('requested_at').notNull().defaultNow(),
  withdrawnAt: tz('withdrawn_at'),
  decidedAt: tz('decided_at'),
  decisionNote: text('decision_note'),
  planPaymentRefundId: uuid('plan_payment_refund_id'),
  updatedAt: tz('updated_at').notNull().defaultNow(),
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
  /** When the billing managers were warned that 80% of the limit was used (ADR-062). */
  warnedAt: tz('warned_at'),
});
