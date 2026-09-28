import { AppError, parseMajorUnits } from '@w360/core';
import { sql, type CreditRefundStatus } from '@w360/db';
import type { PlatformDatabase } from '@w360/db/platform';
import { z } from 'zod';
import { parseInput } from '../validation';
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

export function createPlatformBillingService(deps: PlatformBillingDeps) {
  const { platformDb } = deps;
  return {
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
