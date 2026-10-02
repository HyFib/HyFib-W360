import { AppError, parseMajorUnits } from '@w360/core';
import {
  sql,
  type CreditRefundRequestStatus,
  type CreditRefundStatus,
  type PlanPaymentRefundOrigin,
  type PlanPaymentRefundRequestStatus,
  type PlanPaymentRefundStatus,
} from '@w360/db';
import type { PlatformDatabase } from '@w360/db/platform';
import { z } from 'zod';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import type { PlatformActor } from './service';

/**
 * Service credit for platform staff (ADR-058): a company's balances, paid top-ups and refunds,
 * read through `ops.platform_company_billing` (payments to HyFib, no company content), and refunds
 * of unused credit started by platform owners through `ops.platform_request_credit_refund`, which
 * holds the credit and writes the platform audit log. The worker side is billing/credit-refunds.
 */
export interface PlatformCompanyTopup {
  id: string;
  receipt: string;
  kind: 'manual' | 'auto_recharge';
  amountMinor: number;
  refundedMinor: number;
  status: string;
  paymentMethod: string | null;
  paidAt: Date | null;
  createdAt: Date;
  /** What is left of the payment to refund (before other open refunds). */
  unrefundedMinor: number;
  openRefund: { id: string; amountMinor: number; status: CreditRefundStatus } | null;
}

export interface PlatformCompanyRefund {
  id: string;
  topupId: string;
  amountMinor: number;
  status: CreditRefundStatus;
  providerRefundId: string | null;
  lastError: string | null;
  reason: string;
  requestedByName: string | null;
  requestedAt: Date;
  submittedAt: Date | null;
  processedAt: Date | null;
  failedAt: Date | null;
}

/** A company's refund request as platform staff see it (ADR-073). */
export interface PlatformRefundRequest {
  id: string;
  tenantId: string;
  companyName: string;
  companySlug: string;
  companyStatus: string;
  topupId: string;
  topupReceipt: string;
  topupAmountMinor: number;
  topupRefundedMinor: number;
  topupPaidAt: Date | null;
  /** The company's unused credit now (null without a wallet). */
  availableMinor: number | null;
  /** A refund of the top-up is already running (approving would be refused). */
  refundInProgress: boolean;
  amountMinor: number;
  reason: string;
  status: CreditRefundRequestStatus;
  requestedByName: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
  decidedByName: string | null;
  decisionNote: string | null;
  creditRefundId: string | null;
  creditRefundStatus: CreditRefundStatus | null;
}

/** A refund of service credit in the platform-wide list (ADR-073). */
export interface PlatformCreditRefund {
  id: string;
  tenantId: string;
  companyName: string;
  companySlug: string;
  topupId: string;
  topupReceipt: string;
  amountMinor: number;
  status: CreditRefundStatus;
  reason: string;
  requestedByName: string | null;
  requestedAt: Date;
  submittedAt: Date | null;
  processedAt: Date | null;
  failedAt: Date | null;
  lastError: string | null;
  /** The company request it answers, if any. */
  requestId: string | null;
}

/** A company's request for a refund of a plan payment as platform staff see it (ADR-104). */
export interface PlatformPlanRefundRequest {
  id: string;
  tenantId: string;
  companyName: string;
  companySlug: string;
  companyStatus: string;
  planPaymentId: string;
  paymentReceipt: string;
  paymentAmountMinor: number;
  /** What Razorpay refunded of the payment (processed refunds). */
  paymentRefundedMinor: number;
  paymentPaidAt: Date | null;
  /** A refund of the payment is already running (approving would be refused). */
  refundInProgress: boolean;
  amountMinor: number;
  reason: string;
  status: PlanPaymentRefundRequestStatus;
  requestedByName: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
  decidedByName: string | null;
  decisionNote: string | null;
  planPaymentRefundId: string | null;
  planPaymentRefundStatus: PlanPaymentRefundStatus | null;
}

/** A refund of a plan payment in the platform-wide list (ADR-104). */
export interface PlatformPlanRefundListItem {
  id: string;
  tenantId: string;
  companyName: string;
  companySlug: string;
  planPaymentId: string;
  paymentReceipt: string;
  /** Started by HyFib (`staff`) or made at Razorpay, for example in its Dashboard. */
  origin: PlanPaymentRefundOrigin;
  amountMinor: number;
  status: PlanPaymentRefundStatus;
  /** The staff reason; none for a refund made at Razorpay. */
  reason: string | null;
  requestedByName: string | null;
  requestedAt: Date;
  submittedAt: Date | null;
  processedAt: Date | null;
  failedAt: Date | null;
  lastError: string | null;
  /** The company request it answers, if any. */
  requestId: string | null;
}

export interface PlatformCompanyBilling {
  /** Null when the company never started a payment (no wallet). */
  availableMinor: number | null;
  reservedMinor: number | null;
  topups: PlatformCompanyTopup[];
  refunds: PlatformCompanyRefund[];
}

/**
 * The paid top-ups a refund can be asked for now, with the most each allows: what is left of the
 * payment, capped by the available credit (ADR-058). Only a help for the form: the SQL function
 * checks every rule again under the wallet's lock.
 */
export function refundableTopups(
  billing: PlatformCompanyBilling,
): (PlatformCompanyTopup & { maxMinor: number })[] {
  const available = billing.availableMinor ?? 0;
  if (available <= 0) return [];
  return billing.topups
    .filter(
      (t) =>
        (t.status === 'paid' || t.status === 'partially_refunded') &&
        t.unrefundedMinor > 0 &&
        !t.openRefund,
    )
    .map((t) => ({ ...t, maxMinor: Math.min(t.unrefundedMinor, available) }));
}

export interface PlatformBillingDeps {
  platformDb: PlatformDatabase;
}

/** Rows per page of the platform refund lists. */
export const PLATFORM_REFUNDS_PAGE = 50;

const requestListSchema = z.object({
  status: z.enum(['open', 'decided', 'all']).default('open'),
  cursor: z.string().max(200).optional(),
});

const refundListSchema = z.object({ cursor: z.string().max(200).optional() });

const decisionSchema = z.object({
  requestId: z.uuid(),
  decision: z.enum(['approve', 'decline']),
  note: z.string().trim().max(1000, 'Keep the note under 1,000 characters.').optional(),
});

const refundRequestSchema = z.object({
  tenantId: z.uuid(),
  topupId: z.uuid(),
  amount: z.string().trim().min(1, 'Enter the amount to refund.').max(20),
  reason: z
    .string()
    .trim()
    .min(10, 'Give a reason of at least 10 characters.')
    .max(2000, 'Keep the reason under 2,000 characters.'),
});

type Row = Record<string, unknown>;
const num = (value: unknown) => Number(value ?? 0);
const optionalNum = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);
const optionalDate = (value: unknown) =>
  typeof value === 'string' || value instanceof Date ? new Date(value) : null;
const text = (value: unknown) => (typeof value === 'string' ? value : null);

function parseCompanyBilling(value: unknown): PlatformCompanyBilling {
  const data = (value ?? {}) as Row;
  const refunds: PlatformCompanyRefund[] = ((data.refunds as Row[] | undefined) ?? []).map((r) => ({
    id: String(r.id),
    topupId: String(r.topup_id),
    amountMinor: num(r.amount_minor),
    status: String(r.status) as CreditRefundStatus,
    providerRefundId: text(r.provider_refund_id),
    lastError: text(r.last_error),
    reason: String(r.reason ?? ''),
    requestedByName: text(r.requested_by_name),
    requestedAt: optionalDate(r.requested_at) ?? new Date(0),
    submittedAt: optionalDate(r.submitted_at),
    processedAt: optionalDate(r.processed_at),
    failedAt: optionalDate(r.failed_at),
  }));
  const open = new Map(
    refunds
      .filter((r) => r.status === 'requested' || r.status === 'submitted')
      .map((r) => [r.topupId, r]),
  );
  const topupsList: PlatformCompanyTopup[] = ((data.topups as Row[] | undefined) ?? []).map((t) => {
    const openRefund = open.get(String(t.id));
    return {
      id: String(t.id),
      receipt: String(t.receipt),
      kind: t.kind === 'auto_recharge' ? 'auto_recharge' : 'manual',
      amountMinor: num(t.amount_minor),
      refundedMinor: num(t.refunded_minor),
      status: String(t.status),
      paymentMethod: text(t.payment_method),
      paidAt: optionalDate(t.paid_at),
      createdAt: optionalDate(t.created_at) ?? new Date(0),
      unrefundedMinor: num(t.amount_minor) - num(t.refunded_minor),
      openRefund: openRefund
        ? { id: openRefund.id, amountMinor: openRefund.amountMinor, status: openRefund.status }
        : null,
    };
  });
  return {
    availableMinor: optionalNum(data.available),
    reservedMinor: optionalNum(data.reserved),
    topups: topupsList,
    refunds,
  };
}

const requiredDate = (value: unknown) => optionalDate(value) ?? new Date(0);

function parseRefundRequest(r: Row): PlatformRefundRequest {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    companyName: String(r.company_name ?? ''),
    companySlug: String(r.company_slug ?? ''),
    companyStatus: String(r.company_status ?? ''),
    topupId: String(r.topup_id),
    topupReceipt: String(r.topup_receipt ?? ''),
    topupAmountMinor: num(r.topup_amount_minor),
    topupRefundedMinor: num(r.topup_refunded_minor),
    topupPaidAt: optionalDate(r.topup_paid_at),
    availableMinor: optionalNum(r.available_minor),
    refundInProgress: r.refund_in_progress === true,
    amountMinor: num(r.amount_minor),
    reason: String(r.reason ?? ''),
    status: String(r.status) as CreditRefundRequestStatus,
    requestedByName: text(r.requested_by_name),
    requestedAt: requiredDate(r.requested_at),
    decidedAt: optionalDate(r.decided_at),
    decidedByName: text(r.decided_by_name),
    decisionNote: text(r.decision_note),
    creditRefundId: text(r.credit_refund_id),
    creditRefundStatus: (text(r.credit_refund_status) as CreditRefundStatus | null) ?? null,
  };
}

function parsePlanRefundRequest(r: Row): PlatformPlanRefundRequest {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    companyName: String(r.company_name ?? ''),
    companySlug: String(r.company_slug ?? ''),
    companyStatus: String(r.company_status ?? ''),
    planPaymentId: String(r.plan_payment_id),
    paymentReceipt: String(r.payment_receipt ?? ''),
    paymentAmountMinor: num(r.payment_amount_minor),
    paymentRefundedMinor: num(r.payment_refunded_minor),
    paymentPaidAt: optionalDate(r.payment_paid_at),
    refundInProgress: r.refund_in_progress === true,
    amountMinor: num(r.amount_minor),
    reason: String(r.reason ?? ''),
    status: String(r.status) as PlanPaymentRefundRequestStatus,
    requestedByName: text(r.requested_by_name),
    requestedAt: requiredDate(r.requested_at),
    decidedAt: optionalDate(r.decided_at),
    decidedByName: text(r.decided_by_name),
    decisionNote: text(r.decision_note),
    planPaymentRefundId: text(r.plan_payment_refund_id),
    planPaymentRefundStatus:
      (text(r.plan_payment_refund_status) as PlanPaymentRefundStatus | null) ?? null,
  };
}

function parsePlanRefund(r: Row): PlatformPlanRefundListItem {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    companyName: String(r.company_name ?? ''),
    companySlug: String(r.company_slug ?? ''),
    planPaymentId: String(r.plan_payment_id),
    paymentReceipt: String(r.payment_receipt ?? ''),
    origin: String(r.origin) as PlanPaymentRefundOrigin,
    amountMinor: num(r.amount_minor),
    status: String(r.status) as PlanPaymentRefundStatus,
    reason: text(r.reason),
    requestedByName: text(r.requested_by_name),
    requestedAt: requiredDate(r.requested_at),
    submittedAt: optionalDate(r.submitted_at),
    processedAt: optionalDate(r.processed_at),
    failedAt: optionalDate(r.failed_at),
    lastError: text(r.last_error),
    requestId: text(r.request_id),
  };
}

function parseCreditRefund(r: Row): PlatformCreditRefund {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    companyName: String(r.company_name ?? ''),
    companySlug: String(r.company_slug ?? ''),
    topupId: String(r.topup_id),
    topupReceipt: String(r.topup_receipt ?? ''),
    amountMinor: num(r.amount_minor),
    status: String(r.status) as CreditRefundStatus,
    reason: String(r.reason ?? ''),
    requestedByName: text(r.requested_by_name),
    requestedAt: requiredDate(r.requested_at),
    submittedAt: optionalDate(r.submitted_at),
    processedAt: optionalDate(r.processed_at),
    failedAt: optionalDate(r.failed_at),
    lastError: text(r.last_error),
    requestId: text(r.request_id),
  };
}

/** A decision's note: required to decline (the company reads it), optional to approve. */
function decisionNote(decision: 'approve' | 'decline', typed: string | undefined): string | null {
  const note = typed ? typed : null;
  if (decision === 'decline' && (note === null || note.length < 10)) {
    throw new AppError('validation_failed', 'Write a note of at least 10 characters.', {
      issues: [{ path: 'note', message: 'The company reads this note' }],
    });
  }
  if (note !== null && note.length < 10) {
    throw new AppError('validation_failed', 'Write a note of at least 10 characters, or none.', {
      issues: [{ path: 'note', message: 'At least 10 characters' }],
    });
  }
  return note;
}

/** A page from rows fetched one past the page size, with the exact cursor of its last row. */
function pageOf<T>(rows: Row[], parse: (r: Row) => T): { items: T[]; nextCursor: string | null } {
  const shown = rows.slice(0, PLATFORM_REFUNDS_PAGE);
  const last = shown.at(-1);
  return {
    items: shown.map(parse),
    nextCursor:
      rows.length > PLATFORM_REFUNDS_PAGE && last
        ? encodeKeysetCursor(String(last.cursor_at), String(last.id))
        : null,
  };
}

export function createPlatformBillingService(deps: PlatformBillingDeps) {
  const { platformDb } = deps;
  return {
    /**
     * Refund requests companies made (ADR-073), newest first: open ones, decided ones or all, for
     * any platform staff member (only owners decide).
     */
    async refundRequests(
      actor: PlatformActor,
      input: unknown = {},
    ): Promise<{ items: PlatformRefundRequest[]; nextCursor: string | null }> {
      const data = parseInput(requestListSchema, input);
      const cursor = decodeKeysetCursor(data.cursor);
      const status = data.status === 'all' ? null : data.status;
      return platformDb.run(actor.userId, async (tx) => {
        const result = await tx.execute<Row>(
          sql`select * from ops.platform_credit_refund_requests(${status}::text,
                ${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::uuid,
                ${PLATFORM_REFUNDS_PAGE + 1}::int)`,
        );
        return pageOf(result.rows, parseRefundRequest);
      });
    },

    /** Every refund of service credit across companies, newest first (ADR-073). */
    async creditRefunds(
      actor: PlatformActor,
      input: unknown = {},
    ): Promise<{ items: PlatformCreditRefund[]; nextCursor: string | null }> {
      const data = parseInput(refundListSchema, input);
      const cursor = decodeKeysetCursor(data.cursor);
      return platformDb.run(actor.userId, async (tx) => {
        const result = await tx.execute<Row>(
          sql`select * from ops.platform_credit_refunds(${cursor?.at ?? null}::timestamptz,
                ${cursor?.id ?? null}::uuid, ${PLATFORM_REFUNDS_PAGE + 1}::int)`,
        );
        return pageOf(result.rows, parseCreditRefund);
      });
    },

    /**
     * Decides a company's open refund request (platform owners). Approving starts the staff refund
     * for the request's amount, checked again under its locks; declining needs a note the company
     * reads. Both are in the platform audit log.
     */
    async decideRefundRequest(
      actor: PlatformActor,
      input: unknown,
    ): Promise<{ refundId: string | null }> {
      if (actor.role !== 'platform_owner') {
        throw new AppError('forbidden', 'Only a platform owner can decide a refund request.');
      }
      const data = parseInput(decisionSchema, input);
      const note = decisionNote(data.decision, data.note);
      return platformDb.run(actor.userId, async (tx) => {
        const result = await tx.execute<{ id: string | null }>(
          sql`select ops.platform_decide_credit_refund_request(${data.requestId}::uuid,
                ${data.decision === 'approve'}::boolean, ${note}::text, ${actor.correlationId}) as id`,
        );
        return { refundId: result.rows[0]?.id ?? null };
      });
    },

    /**
     * Requests for refunds of plan payments companies made (ADR-104), newest first: open ones,
     * decided ones or all, for any platform staff member (only owners decide).
     */
    async planRefundRequests(
      actor: PlatformActor,
      input: unknown = {},
    ): Promise<{ items: PlatformPlanRefundRequest[]; nextCursor: string | null }> {
      const data = parseInput(requestListSchema, input);
      const cursor = decodeKeysetCursor(data.cursor);
      const status = data.status === 'all' ? null : data.status;
      return platformDb.run(actor.userId, async (tx) => {
        const result = await tx.execute<Row>(
          sql`select * from ops.platform_plan_payment_refund_requests(${status}::text,
                ${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::uuid,
                ${PLATFORM_REFUNDS_PAGE + 1}::int)`,
        );
        return pageOf(result.rows, parsePlanRefundRequest);
      });
    },

    /**
     * Every refund of a plan payment across companies, newest first (ADR-104): started by HyFib,
     * answering a request, or made at Razorpay.
     */
    async planPaymentRefunds(
      actor: PlatformActor,
      input: unknown = {},
    ): Promise<{ items: PlatformPlanRefundListItem[]; nextCursor: string | null }> {
      const data = parseInput(refundListSchema, input);
      const cursor = decodeKeysetCursor(data.cursor);
      return platformDb.run(actor.userId, async (tx) => {
        const result = await tx.execute<Row>(
          sql`select * from ops.platform_plan_payment_refunds(${cursor?.at ?? null}::timestamptz,
                ${cursor?.id ?? null}::uuid, ${PLATFORM_REFUNDS_PAGE + 1}::int)`,
        );
        return pageOf(result.rows, parsePlanRefund);
      });
    },

    /**
     * Decides a company's open request for a refund of a plan payment (platform owners). Approving
     * starts the staff refund of ADR-103 for the request's amount, checked again under its lock;
     * declining needs a note the company reads. Both are in the platform audit log.
     */
    async decidePlanRefundRequest(
      actor: PlatformActor,
      input: unknown,
    ): Promise<{ refundId: string | null }> {
      if (actor.role !== 'platform_owner') {
        throw new AppError('forbidden', 'Only a platform owner can decide a refund request.');
      }
      const data = parseInput(decisionSchema, input);
      const note = decisionNote(data.decision, data.note);
      return platformDb.run(actor.userId, async (tx) => {
        const result = await tx.execute<{ id: string | null }>(
          sql`select ops.platform_decide_plan_payment_refund_request(${data.requestId}::uuid,
                ${data.decision === 'approve'}::boolean, ${note}::text, ${actor.correlationId}) as id`,
        );
        return { refundId: result.rows[0]?.id ?? null };
      });
    },

    /** A company's balances, paid top-ups and refunds, for platform staff (payments to HyFib). */
    async companyBilling(actor: PlatformActor, tenantId: string): Promise<PlatformCompanyBilling> {
      const id = parseInput(z.uuid(), tenantId);
      return platformDb.run(actor.userId, async (tx) => {
        const result = await tx.execute<{ billing: unknown }>(
          sql`select ops.platform_company_billing(${id}::uuid) as billing`,
        );
        return parseCompanyBilling(result.rows[0]?.billing);
      });
    },

    /**
     * Refunds part or all of a paid top-up's unused credit (platform owners). The credit is held at
     * once and the worker asks Razorpay; audited with the reason in the platform audit log.
     */
    async requestRefund(actor: PlatformActor, input: unknown): Promise<{ refundId: string }> {
      if (actor.role !== 'platform_owner') {
        throw new AppError('forbidden', 'Only a platform owner can refund service credit.');
      }
      const data = parseInput(refundRequestSchema, input);
      let amountMinor: number;
      try {
        amountMinor = Number(parseMajorUnits(data.amount, 'INR'));
      } catch {
        throw new AppError('validation_failed', 'Enter the amount in rupees, like 250 or 250.50.', {
          issues: [{ path: 'amount', message: 'Enter the amount in rupees' }],
        });
      }
      if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) {
        throw new AppError('validation_failed', 'Enter an amount above ₹0.', {
          issues: [{ path: 'amount', message: 'Enter an amount above ₹0' }],
        });
      }
      return platformDb.run(actor.userId, async (tx) => {
        const result = await tx.execute<{ id: string }>(
          sql`select ops.platform_request_credit_refund(${data.tenantId}::uuid, ${data.topupId}::uuid,
                ${amountMinor}::bigint, ${data.reason}, ${actor.correlationId}) as id`,
        );
        const refundId = result.rows[0]?.id;
        if (!refundId) throw new Error('refund request returned no id');
        return { refundId };
      });
    },
  };
}

export type PlatformBillingService = ReturnType<typeof createPlatformBillingService>;
