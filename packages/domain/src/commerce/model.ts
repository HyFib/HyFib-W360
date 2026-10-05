import { z } from 'zod';
import { clipText } from '@w360/core';
import type { OrderStatus } from '@w360/db';
import { formatMinor, isCurrency, parseAmountToMinor } from '../crm/money';
import { REF_ALPHABET, TOKEN_ALPHABET, randomToken } from '../growth/model';

/**
 * Commerce on WhatsApp (P4-06): product messages (research M-169), orders customers send from their
 * cart (M-170) and Payment Links for an order's subtotal (R-016, R-106 to R-109). Money is integer
 * minor units; the order webhook's prices (numbers in major units) are converted exactly through
 * their shortest decimal text and refused when they do not fit the currency's decimals.
 */

export const COMMERCE_LIMITS = {
  /** Products HyFib reads per catalog (the rest can still be sent at Meta, just not picked here). */
  productsPerCatalog: 5000,
  catalogsPerAccount: 10,
  /** product_list: 1 to 10 sections (M-169); HyFib also keeps the total at 30 products. */
  sections: 10,
  productsPerMessage: 30,
  sectionTitleLength: 24,
  headerLength: 60,
  bodyLength: 1024,
  footerLength: 60,
  /** Items HyFib keeps from one order message. */
  orderItems: 100,
  /** Payment Links stay open this long (Razorpay allows up to six months, R-016). */
  paymentLinkDays: 7,
  /** Razorpay's smallest amount for INR (one rupee, in paise). */
  minPaymentMinor: 100,
  /** HyFib's own cap on one Payment Link (₹50 crore, in paise; the database enforces it too). */
  maxPaymentMinor: 50_000_000_000,
} as const;

/** Order references members and customers can quote: 8 characters, no I, O, 0 or 1. */
export const ORDER_REFERENCE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
export const newOrderReference = () => randomToken(REF_ALPHABET, 8);

/** Razorpay reference_id for a Payment Link (at most 40 characters, single-use: R-106). */
export const PAYMENT_LINK_REFERENCE_RE = /^w360_[a-z2-7]{20}$/;
export const newPaymentLinkReference = () => `w360_${randomToken(TOKEN_ALPHABET, 20)}`;

/** Webhook address ids for companies' Razorpay accounts (80 random bits). */
export const PAYMENT_WEBHOOK_ID_RE = /^[a-z2-7]{16}$/;
export const newPaymentWebhookId = () => randomToken(TOKEN_ALPHABET, 16);

/** Keyring associated data binding a company's Razorpay secrets to their row. */
export const paymentAccountAad = (tenantId: string, accountId: string, part: 'key' | 'webhook') =>
  `commerce-payments:${tenantId}:${accountId}:${part}`;

export const RAZORPAY_KEY_ID_RE = /^rzp_(test|live)_[A-Za-z0-9]{8,32}$/;
export const razorpayMode = (keyId: string): 'test' | 'live' =>
  keyId.startsWith('rzp_live_') ? 'live' : 'test';

/** Order statuses and the ones members may move an order to from each. */
export const MEMBER_ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  received: ['confirmed', 'cancelled'],
  confirmed: ['fulfilled', 'cancelled'],
  // An order waiting for payment is cancelled by cancelling its link first.
  awaiting_payment: [],
  paid: ['fulfilled'],
  fulfilled: [],
  cancelled: [],
};

/** Statuses from which a Payment Link can be requested. */
export const PAYABLE_ORDER_STATUSES: readonly OrderStatus[] = ['received', 'confirmed'];

// Product messages ---------------------------------------------------------------------------------

const text = (max: number, label: string) =>
  z.string().trim().max(max, `Use at most ${max} characters for the ${label}.`);

export const productMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('product'),
    productId: z.uuid('Choose a product.'),
    body: text(COMMERCE_LIMITS.bodyLength, 'message'),
    footer: text(COMMERCE_LIMITS.footerLength, 'footer'),
  }),
  z.object({
    kind: z.literal('product_list'),
    header: text(COMMERCE_LIMITS.headerLength, 'heading').min(1, 'Write a heading.'),
    body: text(COMMERCE_LIMITS.bodyLength, 'message').min(1, 'Write the message.'),
    footer: text(COMMERCE_LIMITS.footerLength, 'footer'),
    sections: z
      .array(
        z.object({
          title: text(COMMERCE_LIMITS.sectionTitleLength, 'section title'),
          productIds: z.array(z.uuid()).min(1, 'Add at least one product to each section.'),
        }),
      )
      .min(1, 'Add at least one section.')
      .max(COMMERCE_LIMITS.sections, `Use at most ${COMMERCE_LIMITS.sections} sections.`),
  }),
  z.object({
    kind: z.literal('catalog'),
    thumbnailProductId: z.uuid('Choose the product shown on the message.'),
    body: text(COMMERCE_LIMITS.bodyLength, 'message').min(1, 'Write the message.'),
    footer: text(COMMERCE_LIMITS.footerLength, 'footer'),
  }),
]);
export type ProductMessageInput = z.infer<typeof productMessageSchema>;

/** Further rules the schema cannot express (the product_list limits of M-169). */
export function productListProblem(sections: { title: string; productIds: string[] }[]) {
  const total = sections.reduce((n, s) => n + s.productIds.length, 0);
  if (total > COMMERCE_LIMITS.productsPerMessage) {
    return `Send at most ${COMMERCE_LIMITS.productsPerMessage} products in one message.`;
  }
  if (sections.length > 1 && sections.some((s) => !s.title)) {
    return 'Give every section a title when there is more than one.';
  }
  const ids = sections.flatMap((s) => s.productIds);
  if (new Set(ids).size !== ids.length) return 'Each product can appear only once.';
  return null;
}

/** The resolved message: products are named by their retailer ids in one catalog. */
export type ResolvedProductMessage =
  | { kind: 'product'; catalogId: string; retailerId: string; body: string; footer: string }
  | {
      kind: 'product_list';
      catalogId: string;
      header: string;
      body: string;
      footer: string;
      sections: { title: string; retailerIds: string[] }[];
    }
  | { kind: 'catalog'; thumbnailRetailerId: string; body: string; footer: string };

/**
 * The `interactive` object of a product, multi-product or catalog message (research M-169), shared
 * by the inbox and the public API (ADR-086).
 */
export function productInteractive(message: ResolvedProductMessage): Record<string, unknown> {
  const footer = message.footer ? { footer: { text: message.footer } } : {};
  switch (message.kind) {
    case 'product':
      return {
        type: 'product',
        ...(message.body ? { body: { text: message.body } } : {}),
        ...footer,
        action: { catalog_id: message.catalogId, product_retailer_id: message.retailerId },
      };
    case 'product_list':
      return {
        type: 'product_list',
        header: { type: 'text', text: message.header },
        body: { text: message.body },
        ...footer,
        action: {
          catalog_id: message.catalogId,
          sections: message.sections.map((s) => ({
            ...(s.title ? { title: s.title } : {}),
            product_items: s.retailerIds.map((id) => ({ product_retailer_id: id })),
          })),
        },
      };
    case 'catalog':
      return {
        type: 'catalog_message',
        body: { text: message.body },
        ...footer,
        action: {
          name: 'catalog_message',
          parameters: { thumbnail_product_retailer_id: message.thumbnailRetailerId },
        },
      };
  }
}

/** The Graph request for a product, multi-product or catalog message (research M-169). */
export function buildProductMessageRequest(
  to: string,
  message: ResolvedProductMessage,
): Record<string, unknown> {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: productInteractive(message),
  };
}

// Orders -----------------------------------------------------------------------------------------

export interface ParsedOrderItem {
  retailerId: string;
  quantity: number;
  /** Null when the price is missing or does not fit the currency's decimals. */
  unitPriceMinor: number | null;
  currency: string | null;
}

export interface ParsedOrder {
  catalogId: string;
  note: string | null;
  items: ParsedOrderItem[];
  /** Items beyond HyFib's limit, or unreadable, that were left out. */
  dropped: number;
  currency: string | null;
  /**
   * Null unless every item was read with a price in one currency: a cart with items left out never
   * has a total, so it can never be charged for less than the customer ordered.
   */
  subtotalMinor: number | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A price from the order webhook (a JSON number in major units, M-170) in minor units. The number's
 * shortest decimal text is parsed exactly, so 19.99 INR is 1999 paise; values with more decimals
 * than the currency has, negative values and exponent notation are refused.
 */
export function orderPriceToMinor(value: unknown, currency: string): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  if (!isCurrency(currency)) return null;
  return parseAmountToMinor(String(value), currency);
}

/** Reads a webhook message's `order` object (M-170), or null when it is not a usable order. */
export function parseOrder(order: unknown): ParsedOrder | null {
  if (!isObject(order)) return null;
  const catalogId = typeof order.catalog_id === 'string' ? order.catalog_id : '';
  if (!/^[0-9]{1,32}$/.test(catalogId)) return null;
  const rawItems = Array.isArray(order.product_items) ? order.product_items : [];
  const items: ParsedOrderItem[] = [];
  let dropped = 0;
  for (const raw of rawItems) {
    if (items.length >= COMMERCE_LIMITS.orderItems || !isObject(raw)) {
      dropped += 1;
      continue;
    }
    const retailerId = typeof raw.product_retailer_id === 'string' ? raw.product_retailer_id : '';
    const quantity = raw.quantity;
    if (
      !retailerId ||
      retailerId.length > 100 ||
      typeof quantity !== 'number' ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 100_000
    ) {
      dropped += 1;
      continue;
    }
    const currency =
      typeof raw.currency === 'string' && /^[A-Z]{3}$/.test(raw.currency) ? raw.currency : null;
    items.push({
      retailerId,
      quantity,
      currency,
      unitPriceMinor: currency ? orderPriceToMinor(raw.item_price, currency) : null,
    });
  }
  if (items.length === 0) return null;
  const currencies = new Set(items.map((i) => i.currency));
  const currency = currencies.size === 1 ? (items[0]?.currency ?? null) : null;
  let subtotal: bigint | null = currency && dropped === 0 ? 0n : null;
  for (const item of items) {
    if (subtotal === null || item.unitPriceMinor === null) {
      subtotal = null;
      break;
    }
    subtotal += BigInt(item.unitPriceMinor) * BigInt(item.quantity);
  }
  const note = typeof order.text === 'string' && order.text.trim() ? order.text.trim() : null;
  return {
    catalogId,
    note: note ? clipText(note, 1000) : null,
    items,
    dropped,
    currency,
    subtotalMinor: subtotal !== null && subtotal <= 50_000_000_000_000n ? Number(subtotal) : null,
  };
}

/** The chat message that carries a Payment Link. */
export function paymentRequestText(input: {
  amountMinor: number;
  currency: string;
  orderReference: string;
  url: string;
}): string {
  return `Pay ${formatMinor(input.amountMinor, input.currency)} for order ${input.orderReference}: ${input.url}`;
}
