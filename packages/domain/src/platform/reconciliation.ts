import { AppError } from '@w360/core';
import {
  sql,
  type SettlementReconItemStatus,
  type SettlementReconItemType,
  type SettlementReconReason,
  type SettlementReconRunStatus,
} from '@w360/db';
import type { PlatformDatabase } from '@w360/db/platform';
import { z } from 'zod';
import { parseInput } from '../validation';
import type { PlatformActor } from './service';

/**
 * Settlement reconciliation for platform staff (ADR-059): the daily runs, each run's transactions
 * and how they matched HyFib's records, and paid top-ups no settlement has shown yet. Platform owners
 * reconcile a day (again) and resolve what needs a person; both go to the platform audit log. The
 * worker side is billing/settlement-recon.
 */

export const SETTLEMENT_RECON_RUN_STATUS_LABELS: Record<SettlementReconRunStatus, string> = {
  pending: 'Waiting',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
};

export const SETTLEMENT_RECON_ITEM_STATUS_LABELS: Record<SettlementReconItemStatus, string> = {
  matched: 'Matched',
  recorded: 'Recorded by the check',
  mismatch: 'Does not match',
  review: 'Needs a look',
  not_hyfib: 'Not HyFib’s',
};

/** What each reason means, and what to do where a person is needed. */
export const SETTLEMENT_RECON_REASON_TEXT: Record<SettlementReconReason, string> = {
  mandate_authorization: 'A card mandate’s authorisation payment, or its refund.',
  uncredited_payment_refund:
    'A refund of a payment HyFib never credited, such as a second payment on an order.',
  plan_payment: 'A payment of a company’s plan subscription that HyFib recorded.',
  credited:
    'Razorpay settled a captured payment HyFib had not credited. The check credited it, as its webhook would have.',
  refund_recorded:
    'Razorpay settled a refund HyFib had not recorded. The check recorded it, as its webhook would have.',
  plan_payment_recorded:
    'Razorpay settled a plan subscription payment HyFib had not recorded. The check synced the subscription, which recorded it, as its webhook would have.',
  amount_differs: 'The amount is not HyFib’s amount for this transaction.',
  second_payment:
    'A second payment on a top-up another payment already paid. HyFib gave no credit for it: refund it in the Razorpay Dashboard.',
  not_captured:
    'A settled payment on a HyFib top-up’s order that Razorpay does not report as captured.',
  mandate_payment:
    'A payment on a card mandate’s authorisation order that HyFib has not recorded. Check the mandate.',
  refund_not_processed: 'Razorpay settled this refund but reports it as not processed.',
  refund_exceeds_payment:
    'Recording this refund would refund more than the payment. Check the top-up’s refunds.',
  payment_unavailable: 'Razorpay did not return this payment, so HyFib could not record it.',
  refund_unavailable: 'Razorpay did not return this refund, so HyFib could not record it.',
  plan_payment_unrecorded:
    'A payment of a HyFib plan subscription that syncing the subscription did not record (not captured, or not the subscription’s amount). Check the subscription in the Razorpay Dashboard.',
  adjustment: 'An adjustment by Razorpay. Check it in the Razorpay Dashboard.',
  dispute:
    'The transaction has a dispute, and the report does not say which transaction carries a chargeback’s deduction. Check it in the Razorpay Dashboard; a lost chargeback is recorded from its webhook. If HyFib had missed the payment or refund, the check recorded it first, as its webhook would have.',
  unknown_type: 'A kind of transaction HyFib does not know.',
  currency: 'Not in rupees.',
  unreadable: 'Razorpay returned a transaction HyFib could not read.',
  plan_payment_refund:
    'A refund of a plan subscription payment. HyFib does not refund plan payments, and the paid period is unchanged: check it in the Razorpay Dashboard.',
  unknown_payment:
    'A payment that is not HyFib’s (another integration or a payment made in the Dashboard).',
  unknown_refund: 'A refund of a payment that is not HyFib’s.',
  transfer: 'A Route transfer. HyFib does not use Route.',
};

export interface SettlementReconRunSummary {
  id: string;
  date: string;
  status: SettlementReconRunStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  requestedAt: Date | null;
  requestedByName: string | null;
  itemCount: number;
  matchedCount: number;
  recordedCount: number;
  attentionCount: number;
  /** Items still needing a person (not resolved). */
  openCount: number;
  creditMinor: number;
  debitMinor: number;
  feeMinor: number;
  taxMinor: number;
  settlementCount: number;
  removedCount: number;
}

export interface SettlementReconItemView {
  id: string;
  type: SettlementReconItemType;
  entityId: string;
  providerType: string | null;
  amountMinor: number;
  debitMinor: number;
  creditMinor: number;
  feeMinor: number;
  taxMinor: number;
  currency: string | null;
  onHold: boolean | null;
  settlementId: string | null;
  settledAt: Date | null;
  paymentId: string | null;
  orderId: string | null;
  disputeId: string | null;
  method: string | null;
  status: SettlementReconItemStatus;
  reason: SettlementReconReason | null;
  tenantId: string | null;
  companyName: string | null;
  topupId: string | null;
  topupReceipt: string | null;
  hyfibAmountMinor: number | null;
  resolvedAt: Date | null;
  resolvedByName: string | null;
  resolutionNote: string | null;
}

export interface SettlementReconRunDetail {
  run: SettlementReconRunSummary;
  settlements: { id: string; utr: string | null }[];
  /** At most 2000, those needing a person first. */
  items: SettlementReconItemView[];
}

export interface UnsettledTopup {
  id: string;
  tenantId: string;
  companyName: string;
  receipt: string;
  kind: 'manual' | 'auto_recharge';
  amountMinor: number;
  status: string;
  paymentId: string;
  paidAt: Date;
  /** When platform owners were emailed about it (ADR-071); null until the minute sweep does. */
  alertedAt: Date | null;
}

export interface UnsettledReport {
  /** The latest day with a completed run; null before the first one. */
  latestDay: string | null;
  /** Days of the last 30 up to the latest completed run without a completed run. */
  daysWithoutRun: number;
  topups: UnsettledTopup[];
}

/** An item needs a person when it did not match or is not HyFib's, until someone resolves it. */
export function needsAttention(item: Pick<SettlementReconItemView, 'status' | 'resolvedAt'>) {
  return (
    (item.status === 'mismatch' || item.status === 'review' || item.status === 'not_hyfib') &&
    item.resolvedAt === null
  );
}

type Row = Record<string, unknown>;
const num = (value: unknown) => Number(value ?? 0);
const optionalNum = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);
const optionalDate = (value: unknown) =>
  typeof value === 'string' || value instanceof Date ? new Date(value) : null;
const text = (value: unknown) => (typeof value === 'string' ? value : null);
const flag = (value: unknown) => (typeof value === 'boolean' ? value : null);

function parseRun(r: Row): SettlementReconRunSummary {
  return {
    id: String(r.id),
    date: String(r.settlement_date),
    status: String(r.status) as SettlementReconRunStatus,
    attempts: num(r.attempts),
    nextAttemptAt: optionalDate(r.next_attempt_at),
    lastError: text(r.last_error),
    startedAt: optionalDate(r.started_at),
    completedAt: optionalDate(r.completed_at),
    requestedAt: optionalDate(r.requested_at),
    requestedByName: text(r.requested_by_name),
    itemCount: num(r.item_count),
    matchedCount: num(r.matched_count),
    recordedCount: num(r.recorded_count),
    attentionCount: num(r.attention_count),
    openCount: num(r.open_count),
    creditMinor: num(r.credit_minor),
    debitMinor: num(r.debit_minor),
    feeMinor: num(r.fee_minor),
    taxMinor: num(r.tax_minor),
    settlementCount: num(r.settlement_count),
    removedCount: num(r.removed_count),
  };
}

function parseItem(r: Row): SettlementReconItemView {
  return {
    id: String(r.id),
    type: String(r.item_type) as SettlementReconItemType,
    entityId: String(r.entity_id),
    providerType: text(r.provider_type),
    amountMinor: num(r.amount_minor),
    debitMinor: num(r.debit_minor),
    creditMinor: num(r.credit_minor),
    feeMinor: num(r.fee_minor),
    taxMinor: num(r.tax_minor),
    currency: text(r.currency),
    onHold: flag(r.on_hold),
    settlementId: text(r.settlement_id),
    settledAt: optionalDate(r.settled_at),
    paymentId: text(r.payment_id),
    orderId: text(r.order_id),
    disputeId: text(r.dispute_id),
    method: text(r.method),
    status: String(r.status) as SettlementReconItemStatus,
    reason: text(r.reason) as SettlementReconReason | null,
    tenantId: text(r.tenant_id),
    companyName: text(r.company_name),
    topupId: text(r.topup_id),
    topupReceipt: text(r.topup_receipt),
    hyfibAmountMinor: optionalNum(r.hyfib_amount_minor),
    resolvedAt: optionalDate(r.resolved_at),
    resolvedByName: text(r.resolved_by_name),
    resolutionNote: text(r.resolution_note),
  };
}

const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a day.')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Choose a day.');

const requestSchema = z.object({
  date: dateSchema,
  reason: z
    .string()
    .trim()
    .min(10, 'Give a reason of at least 10 characters.')
    .max(2000, 'Keep the reason under 2,000 characters.'),
});

const resolveSchema = z.object({
  itemId: z.uuid(),
  note: z
    .string()
    .trim()
    .min(10, 'Write a note of at least 10 characters.')
    .max(2000, 'Keep the note under 2,000 characters.'),
});

export interface PlatformReconciliationDeps {
  platformDb: PlatformDatabase;
}

export function createPlatformReconciliationService(deps: PlatformReconciliationDeps) {
  const { platformDb } = deps;
  return {
    /** The latest runs, newest day first. */
    async runs(actor: PlatformActor, limit = 90): Promise<SettlementReconRunSummary[]> {
      return platformDb.run(actor.userId, async (tx) => {
        const res = await tx.execute<{ runs: unknown }>(
          sql`select ops.platform_settlement_recon_runs(${limit}::int) as runs`,
        );
        return ((res.rows[0]?.runs as Row[] | undefined) ?? []).map(parseRun);
      });
    },

    /** One day's run with its transactions; null when the day has no run. */
    async run(actor: PlatformActor, date: string): Promise<SettlementReconRunDetail | null> {
      const day = parseInput(dateSchema, date);
      return platformDb.run(actor.userId, async (tx) => {
        const res = await tx.execute<{ detail: unknown }>(
          sql`select ops.platform_settlement_recon_run(${day}::date) as detail`,
        );
        const detail = res.rows[0]?.detail as Row | null | undefined;
        if (!detail) return null;
        return {
          run: parseRun(detail.run as Row),
          settlements: ((detail.settlements as Row[] | undefined) ?? []).map((s) => ({
            id: String(s.id),
            utr: text(s.utr),
          })),
          items: ((detail.items as Row[] | undefined) ?? []).map(parseItem),
        };
      });
    },

    /** Paid top-ups no settlement has shown 7 days after the payment (ADR-059). */
    async unsettled(actor: PlatformActor, limit = 100): Promise<UnsettledReport> {
      return platformDb.run(actor.userId, async (tx) => {
        const res = await tx.execute<{ report: unknown }>(
          sql`select ops.platform_settlement_recon_unsettled(${limit}::int) as report`,
        );
        const report = (res.rows[0]?.report ?? {}) as Row;
        return {
          latestDay: text(report.latestDay),
          daysWithoutRun: num(report.daysWithoutRun),
          topups: ((report.topups as Row[] | undefined) ?? []).map((t) => ({
            id: String(t.id),
            tenantId: String(t.tenant_id),
            companyName: String(t.company_name ?? ''),
            receipt: String(t.receipt),
            kind: t.kind === 'auto_recharge' ? 'auto_recharge' : 'manual',
            amountMinor: num(t.amount_minor),
            status: String(t.status),
            paymentId: String(t.provider_payment_id),
            paidAt: optionalDate(t.paid_at) ?? new Date(0),
            alertedAt: optionalDate(t.alerted_at),
          })),
        };
      });
    },

    /**
     * Reconciles a day, or runs it again (platform owners, with a reason in the platform audit log).
     * The worker picks it up within a minute.
     */
    async requestDay(actor: PlatformActor, input: unknown): Promise<{ runId: string }> {
      if (actor.role !== 'platform_owner') {
        throw new AppError('forbidden', 'Only a platform owner can run a reconciliation.');
      }
      const data = parseInput(requestSchema, input);
      return platformDb.run(actor.userId, async (tx) => {
        const res = await tx.execute<{ id: string }>(
          sql`select ops.platform_request_settlement_recon(${data.date}::date, ${data.reason},
                ${actor.correlationId}) as id`,
        );
        const runId = res.rows[0]?.id;
        if (!runId) throw new Error('reconciliation request returned no run');
        return { runId };
      });
    },

    /** Marks an item that needed a person as resolved (platform owners, audited with the note). */
    async resolveItem(actor: PlatformActor, input: unknown): Promise<void> {
      if (actor.role !== 'platform_owner') {
        throw new AppError('forbidden', 'Only a platform owner can resolve a reconciliation item.');
      }
      const data = parseInput(resolveSchema, input);
      await platformDb.run(actor.userId, (tx) =>
        tx.execute(
          sql`select ops.platform_resolve_settlement_item(${data.itemId}::uuid, ${data.note},
                ${actor.correlationId})`,
        ),
      );
    },
  };
}

export type PlatformReconciliationService = ReturnType<typeof createPlatformReconciliationService>;
