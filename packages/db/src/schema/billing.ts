import { sql } from 'drizzle-orm';
import { bigint, boolean, integer, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { appSchema } from './tenancy';

/**
 * Billing tables (migration 0004). Amounts are integer paise carried as JS `number` (values stay far
 * below Number.MAX_SAFE_INTEGER; the database enforces per-row bounds). Runtime code reads these
 * tables; ledger postings and payment state changes go through SECURITY DEFINER functions.
 */
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const paise = (name: string) => bigint(name, { mode: 'number' });

export const wallets = appSchema.table('wallets', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  currency: text('currency', { enum: ['INR'] })
    .notNull()
    .default('INR'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const LEDGER_ACCOUNT_CODES = [
  'wallet_available',
  'wallet_held',
  'payment_clearing',
  'service_revenue',
  'dispute_losses',
] as const;
export type LedgerAccountCode = (typeof LEDGER_ACCOUNT_CODES)[number];

export const ledgerAccounts = appSchema.table('ledger_accounts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  walletId: uuid('wallet_id').notNull(),
  code: text('code', { enum: LEDGER_ACCOUNT_CODES }).notNull(),
  normalSide: text('normal_side', { enum: ['debit', 'credit'] }).notNull(),
  balanceMinor: paise('balance_minor').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const LEDGER_KINDS = [
  'topup_credit',
  'hold',
  'hold_release',
  'hold_settle',
  'refund',
  'dispute_loss',
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const ledgerTransactions = appSchema.table('ledger_transactions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  walletId: uuid('wallet_id').notNull(),
  kind: text('kind', { enum: LEDGER_KINDS }).notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  referenceType: text('reference_type'),
  referenceId: text('reference_id'),
  description: text('description'),
  actorType: text('actor_type', { enum: ['user', 'system', 'provider'] }).notNull(),
  actorId: text('actor_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const ledgerEntries = appSchema.table('ledger_entries', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  transactionId: uuid('transaction_id').notNull(),
  accountId: uuid('account_id').notNull(),
  direction: text('direction', { enum: ['debit', 'credit'] }).notNull(),
  amountMinor: paise('amount_minor').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const walletHolds = appSchema.table('wallet_holds', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  walletId: uuid('wallet_id').notNull(),
  amountMinor: paise('amount_minor').notNull(),
  settledMinor: paise('settled_minor'),
  status: text('status', { enum: ['held', 'settled', 'released'] }).notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  referenceType: text('reference_type').notNull(),
  referenceId: text('reference_id').notNull(),
  expiresAt: tz('expires_at').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  resolvedAt: tz('resolved_at'),
});

export const billingCustomers = appSchema.table('billing_customers', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  provider: text('provider', { enum: ['razorpay'] })
    .notNull()
    .default('razorpay'),
  providerCustomerId: text('provider_customer_id').notNull(),
  email: text('email').notNull(),
  contact: text('contact').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const MANDATE_STATUSES = [
  'pending_authorization',
  'active',
  'rejected',
  'cancelled',
  'paused',
  'expired',
] as const;
export type MandateStatus = (typeof MANDATE_STATUSES)[number];

export const paymentMandates = appSchema.table('payment_mandates', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  provider: text('provider', { enum: ['razorpay'] })
    .notNull()
    .default('razorpay'),
  billingCustomerId: uuid('billing_customer_id').notNull(),
  authorizationOrderId: text('authorization_order_id'),
  authorizationPaymentId: text('authorization_payment_id'),
  authorizationRefundId: text('authorization_refund_id'),
  providerTokenId: text('provider_token_id'),
  status: text('status', { enum: MANDATE_STATUSES }).notNull().default('pending_authorization'),
  maxAmountMinor: paise('max_amount_minor').notNull(),
  cardNetwork: text('card_network'),
  cardIssuer: text('card_issuer'),
  cardLast4: text('card_last4'),
  cardExpiryMonth: smallint('card_expiry_month'),
  cardExpiryYear: smallint('card_expiry_year'),
  createdByUserId: text('created_by_user_id'),
  confirmedAt: tz('confirmed_at'),
  endedAt: tz('ended_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const autoRechargeSettings = appSchema.table('auto_recharge_settings', {
  tenantId: uuid('tenant_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  mandateId: uuid('mandate_id'),
  thresholdMinor: paise('threshold_minor').notNull(),
  amountMinor: paise('amount_minor').notNull(),
  dailyCapMinor: paise('daily_cap_minor').notNull(),
  monthlyCapMinor: paise('monthly_cap_minor').notNull(),
  updatedByUserId: text('updated_by_user_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const TOPUP_STATUSES = [
  'creating',
  'awaiting_payment',
  'paid',
  'partially_refunded',
  'refunded',
  'failed',
  'expired',
] as const;
export type TopupStatus = (typeof TOPUP_STATUSES)[number];

export const topups = appSchema.table('topups', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  walletId: uuid('wallet_id').notNull(),
  kind: text('kind', { enum: ['manual', 'auto_recharge'] }).notNull(),
  amountMinor: paise('amount_minor').notNull(),
  currency: text('currency', { enum: ['INR'] })
    .notNull()
    .default('INR'),
  status: text('status', { enum: TOPUP_STATUSES }).notNull().default('creating'),
  receipt: text('receipt').notNull(),
  providerOrderId: text('provider_order_id'),
  providerPaymentId: text('provider_payment_id'),
  refundedMinor: paise('refunded_minor').notNull().default(0),
  failureReason: text('failure_reason'),
  creditedTransactionId: uuid('credited_transaction_id'),
  /** Razorpay's payment method for the credited payment (0029); set by a definer function. */
  paymentMethod: text('payment_method'),
  createdByUserId: text('created_by_user_id'),
  nextCheckAt: tz('next_check_at')
    .notNull()
    .default(sql`now() + interval '15 minutes'`),
  paidAt: tz('paid_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export const ATTEMPT_STATUSES = [
  'scheduled',
  'order_created',
  'payment_requested',
  'unknown',
  'succeeded',
  'failed',
  'canceled',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const autoRechargeAttempts = appSchema.table('auto_recharge_attempts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  walletId: uuid('wallet_id').notNull(),
  mandateId: uuid('mandate_id').notNull(),
  topupId: uuid('topup_id').notNull(),
  amountMinor: paise('amount_minor').notNull(),
  status: text('status', { enum: ATTEMPT_STATUSES }).notNull().default('scheduled'),
  unknownStep: text('unknown_step', { enum: ['create_order', 'request_payment'] }),
  lastError: text('last_error'),
  nextCheckAt: tz('next_check_at').notNull().defaultNow(),
  paymentRequestedAt: tz('payment_requested_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
  resolvedAt: tz('resolved_at'),
});

export const CREDIT_REFUND_STATUSES = ['requested', 'submitted', 'processed', 'failed'] as const;
export type CreditRefundStatus = (typeof CREDIT_REFUND_STATUSES)[number];

/**
 * Refunds of unused service credit started by platform owners (0032, ADR-058). The company role
 * reads every column except the staff reason and who asked (column grants).
 */
export const creditRefunds = appSchema.table('credit_refunds', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  topupId: uuid('topup_id').notNull(),
  holdId: uuid('hold_id').notNull(),
  amountMinor: paise('amount_minor').notNull(),
  status: text('status', { enum: CREDIT_REFUND_STATUSES }).notNull().default('requested'),
  reason: text('reason').notNull(),
  requestedByUserId: text('requested_by_user_id').notNull(),
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

/** Refunds of unused credit asked for by companies (0046, ADR-073). */
export const CREDIT_REFUND_REQUEST_STATUSES = [
  'open',
  'approved',
  'declined',
  'withdrawn',
] as const;
export type CreditRefundRequestStatus = (typeof CREDIT_REFUND_REQUEST_STATUSES)[number];

/**
 * A company's request: it inserts open requests and withdraws open ones; platform owners decide
 * through a definer function. Who decided and the notice marks are not readable by the company.
 */
export const creditRefundRequests = appSchema.table('credit_refund_requests', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  topupId: uuid('topup_id').notNull(),
  amountMinor: paise('amount_minor').notNull(),
  reason: text('reason').notNull(),
  status: text('status', { enum: CREDIT_REFUND_REQUEST_STATUSES }).notNull().default('open'),
  requestedByUserId: text('requested_by_user_id').notNull(),
  requestedAt: tz('requested_at').notNull().defaultNow(),
  withdrawnAt: tz('withdrawn_at'),
  decidedAt: tz('decided_at'),
  decisionNote: text('decision_note'),
  creditRefundId: uuid('credit_refund_id'),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

/**
 * Settlement reconciliation (0034, ADR-059). The tables are platform tables no runtime role can read
 * or write directly: the worker writes through definer functions and platform staff read through
 * others, so only the vocabulary is shared here.
 */
export const SETTLEMENT_RECON_RUN_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;
export type SettlementReconRunStatus = (typeof SETTLEMENT_RECON_RUN_STATUSES)[number];

export const SETTLEMENT_RECON_ITEM_STATUSES = [
  'matched',
  'recorded',
  'mismatch',
  'review',
  'not_hyfib',
] as const;
export type SettlementReconItemStatus = (typeof SETTLEMENT_RECON_ITEM_STATUSES)[number];

/** Why an item has its status; the database checks each reason against its status. */
export const SETTLEMENT_RECON_REASONS = [
  'mandate_authorization',
  'uncredited_payment_refund',
  'plan_payment',
  'credited',
  'refund_recorded',
  'plan_payment_recorded',
  'amount_differs',
  'second_payment',
  'not_captured',
  'mandate_payment',
  'refund_not_processed',
  'refund_exceeds_payment',
  'payment_unavailable',
  'refund_unavailable',
  'plan_payment_unrecorded',
  'adjustment',
  'dispute',
  'unknown_type',
  'currency',
  'unreadable',
  'plan_payment_refund',
  'unknown_payment',
  'unknown_refund',
  'transfer',
] as const;
export type SettlementReconReason = (typeof SETTLEMENT_RECON_REASONS)[number];

export const SETTLEMENT_RECON_ITEM_TYPES = [
  'payment',
  'refund',
  'transfer',
  'adjustment',
  'other',
] as const;
export type SettlementReconItemType = (typeof SETTLEMENT_RECON_ITEM_TYPES)[number];
