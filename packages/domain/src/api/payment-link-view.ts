import { z } from 'zod';
import { commercePaymentLinks, PAYMENT_LINK_STATUSES, type PaymentLinkStatus } from '@w360/db';

/**
 * A Payment Link of a WhatsApp order as the API and the webhook events give it (ADR-284, ADR-285):
 * as the order page lists it, with who asked (a key by its id, never which member), never its
 * address or Razorpay's ids for the link and its payments. A leaf module, so the webhook payloads
 * read it without importing the API.
 */

/** A Payment Link of an order, as `GET /orders/{id}/payment-links` gives it (ADR-284). */
export const apiPaymentLinkSchema = z.object({
  id: z.uuid(),
  orderId: z.uuid(),
  status: z
    .enum(PAYMENT_LINK_STATUSES)
    .describe(
      'As the order page shows it: creating (HyFib is creating it at Razorpay), created (open, unpaid), partially_paid (open, part paid), paid (the whole amount paid, which marks the order paid), expired, cancelled, or failed (Razorpay could not create it: error says why).',
    ),
  amountMinor: z.number().int().describe('The amount asked for, in the currency’s minor units.'),
  amountPaidMinor: z
    .number()
    .int()
    .describe('What Razorpay reports paid so far, in the currency’s minor units.'),
  currency: z.enum(['INR']),
  expiresAt: z.iso.datetime().describe('When the link expires if it is not paid first.'),
  paidAt: z.iso.datetime().nullable().describe('When Razorpay reported it paid.'),
  cancelRequestedAt: z.iso
    .datetime()
    .nullable()
    .describe(
      'When its cancellation was asked for (by a member, a key, or HyFib when the contact was erased); it stays open until Razorpay reports it cancelled.',
    ),
  messageId: z
    .uuid()
    .nullable()
    .describe(
      'The message that sent it in the order’s conversation (GET /messages/{id}); null while it was not sent.',
    ),
  notSentReason: z
    .string()
    .nullable()
    .describe(
      'Why it was not sent in the chat (the customer service window had closed, the number is inactive…), as the order page says it; null once it was sent, and while nothing stopped it.',
    ),
  error: z
    .string()
    .nullable()
    .describe('What went wrong at Razorpay with it, as the order page says it; null otherwise.'),
  requestedBy: z
    .enum(['member', 'api'])
    .describe(
      'Who asked for the payment: a member on the order page (member, never which member) or an API key (api, named by requestedByApiKeyId).',
    ),
  requestedByApiKeyId: z
    .uuid()
    .nullable()
    .describe('The API key that asked for it, when requestedBy is api; null otherwise.'),
  createdAt: z.iso.datetime(),
  checkedAt: z.iso.datetime().nullable().describe('When HyFib last read it from Razorpay.'),
});

/**
 * A Payment Link as the API gives it (ADR-284): as the order page lists it, with who asked (a key by
 * its id, never which member), never its address or Razorpay's ids for the link and its payments.
 */
export interface ApiPaymentLink {
  id: string;
  orderId: string;
  status: PaymentLinkStatus;
  amountMinor: number;
  amountPaidMinor: number;
  currency: 'INR';
  expiresAt: string;
  paidAt: string | null;
  cancelRequestedAt: string | null;
  messageId: string | null;
  /** Why it was not sent in the chat, while it was not. */
  notSentReason: string | null;
  error: string | null;
  requestedBy: 'member' | 'api';
  requestedByApiKeyId: string | null;
  createdAt: string;
  checkedAt: string | null;
}

/** The columns a Payment Link is read with: never `short_url`, `provider_link_id` or `reference`. */
export const paymentLinkColumns = {
  id: commercePaymentLinks.id,
  orderId: commercePaymentLinks.orderId,
  status: commercePaymentLinks.status,
  amountMinor: commercePaymentLinks.amountMinor,
  amountPaidMinor: commercePaymentLinks.amountPaidMinor,
  currency: commercePaymentLinks.currency,
  expiresAt: commercePaymentLinks.expiresAt,
  paidAt: commercePaymentLinks.paidAt,
  cancelRequestedAt: commercePaymentLinks.cancelRequestedAt,
  messageId: commercePaymentLinks.messageId,
  sendError: commercePaymentLinks.sendError,
  error: commercePaymentLinks.error,
  apiKeyId: commercePaymentLinks.createdByApiKeyId,
  createdAt: commercePaymentLinks.createdAt,
  checkedAt: commercePaymentLinks.checkedAt,
};

/** A Payment Link's row as `paymentLinkColumns` reads it. */
export interface PaymentLinkRow {
  id: string;
  orderId: string;
  status: PaymentLinkStatus;
  amountMinor: number;
  amountPaidMinor: number;
  currency: 'INR';
  expiresAt: Date;
  paidAt: Date | null;
  cancelRequestedAt: Date | null;
  messageId: string | null;
  sendError: string | null;
  error: string | null;
  apiKeyId: string | null;
  createdAt: Date;
  checkedAt: Date | null;
}

/** A link as the API gives it: a reason it was not sent only while it was not (ADR-284). */
export const toApiPaymentLink = (row: PaymentLinkRow): ApiPaymentLink => ({
  id: row.id,
  orderId: row.orderId,
  status: row.status,
  amountMinor: row.amountMinor,
  amountPaidMinor: row.amountPaidMinor,
  currency: row.currency,
  expiresAt: row.expiresAt.toISOString(),
  paidAt: row.paidAt?.toISOString() ?? null,
  cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
  messageId: row.messageId,
  notSentReason: row.messageId ? null : row.sendError,
  error: row.error,
  requestedBy: row.apiKeyId ? 'api' : 'member',
  requestedByApiKeyId: row.apiKeyId,
  createdAt: row.createdAt.toISOString(),
  checkedAt: row.checkedAt?.toISOString() ?? null,
});
