import { z } from 'zod';
import { sendingWindow } from '../campaigns/schedule';
import { formatMinor, isCurrency } from '../crm/money';
import { TEMPLATE_LIMITS } from '../templates/definition';

/**
 * Order messages (P4-06c): the WhatsApp template a store sends when one of its orders is placed,
 * paid for on delivery, shipped, delivered or cancelled. Pure rules shared by the store worker, the
 * message worker and the web pages (research docs/research/store-connectors.md §3, ADR-048).
 *
 * Events are found by comparing an order's copy before and after a read from the store. Each order
 * gets at most one message per event, a rule never messages about anything that happened before it
 * was switched on, and an event HyFib first sees long after it happened is recorded, not sent.
 */

export const STORE_MESSAGE_EVENTS = [
  'order_placed',
  'cod_confirmation',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
] as const;
export type StoreMessageEvent = (typeof STORE_MESSAGE_EVENTS)[number];

type Platform = 'shopify' | 'woocommerce';

export const STORE_MESSAGE_LIMITS = {
  /** An event first seen more than this long after it happened is recorded as too late. */
  latenessHours: 48,
  maxDelayMinutes: 1440,
  /** Shopify orders in transit are read again this often, for this long after they shipped. */
  transitRereadHours: 3,
  transitDays: 14,
  transitPerRun: 100,
  /** Messages the minute sweep hands to the worker at a time. */
  sweepBatch: 100,
} as const;

export const STORE_MESSAGE_EVENT_INFO: Record<
  StoreMessageEvent,
  { label: string; description: string; platforms: readonly Platform[] }
> = {
  order_placed: {
    label: 'Order placed',
    description:
      'When a new order arrives. Orders paid on delivery get the cash on delivery message instead while that one is on.',
    platforms: ['shopify', 'woocommerce'],
  },
  cod_confirmation: {
    label: 'Cash on delivery confirmation',
    description:
      'When a new order is to be paid on delivery: asks the customer to confirm or cancel it with two of the template’s buttons. Their answer shows on the order; HyFib does not change the order in the store.',
    platforms: ['shopify', 'woocommerce'],
  },
  order_shipped: {
    label: 'Order shipped',
    description:
      'Shopify: at the order’s first shipment, with its tracking. WooCommerce: when the order is marked completed.',
    platforms: ['shopify', 'woocommerce'],
  },
  order_delivered: {
    label: 'Order delivered',
    description:
      'When every shipment of a fully shipped order is delivered. HyFib checks orders in transit every few hours. Shopify only: WooCommerce has no delivered status.',
    platforms: ['shopify'],
  },
  order_cancelled: {
    label: 'Order cancelled',
    description: 'When an order is cancelled in the store.',
    platforms: ['shopify', 'woocommerce'],
  },
};

export function eventAvailable(platform: Platform, event: StoreMessageEvent): boolean {
  return STORE_MESSAGE_EVENT_INFO[event].platforms.includes(platform);
}

/** Why a message was not sent (recorded on the store message and shown in the report). */
export const STORE_MESSAGE_SKIP_REASONS = {
  test_order: 'A test order (test orders are not messaged unless the store’s setting allows it).',
  too_late: `HyFib saw this more than ${STORE_MESSAGE_LIMITS.latenessHours} hours after it happened.`,
  cash_on_delivery: 'The order is paid on delivery: the cash on delivery confirmation covers it.',
  rule_disabled: 'The message for this event was switched off before it was sent.',
  store_disconnected: 'The store was no longer connected.',
  no_opt_in: 'Nobody has confirmed that this store’s customers agreed to WhatsApp messages.',
  order_deleted: 'The order was deleted from the store.',
  order_cancelled: 'The order was cancelled before the message was sent.',
  customer_erased: 'The customer’s details were erased.',
  no_phone: 'The order has no phone number HyFib can message (or the store withheld it).',
  contact_erased: 'The contact was erased.',
  suppressed: 'The number is on the company’s suppression list.',
  opted_out: 'The contact opted out of these messages.',
  no_marketing_opt_in: 'The template is a marketing template and the contact has not opted in.',
  template_unavailable: 'The template is not approved, or HyFib cannot send it.',
  channel_unavailable: 'The WhatsApp number is not active or does not match the template.',
  missing_variable: 'A template variable had no value and no fallback.',
  template_changed:
    'The template’s variables or buttons changed after this message was set up. Set it up again.',
} as const;
export type StoreMessageSkipReason = keyof typeof STORE_MESSAGE_SKIP_REASONS;

// Detection -------------------------------------------------------------------------------------------

/** The parts of an order's copy that order messages are about. */
export interface OrderMilestones {
  placedAt: Date;
  cancelled: boolean;
  /** When the store says it was cancelled (Shopify); null when it gives no time (WooCommerce). */
  cancelledAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  cashOnDelivery: boolean;
  test: boolean;
}

/** An order whose copy a read changed, with its milestones before (null: new) and after. */
export interface SavedOrderChange {
  orderId: string;
  previous: OrderMilestones | null;
  current: OrderMilestones;
}

export interface EnabledRule {
  event: StoreMessageEvent;
  enabledAt: Date;
}

export interface DetectedEvent {
  event: StoreMessageEvent;
  occurredAt: Date;
  /** Recorded without sending: a test order, too late, or covered by the cash on delivery message. */
  skip: Extract<StoreMessageSkipReason, 'test_order' | 'too_late' | 'cash_on_delivery'> | null;
}

/**
 * When `event` happened, judging by the order before (`previous`, null when the order is new to
 * the copy) and after this read, or null when this read did not reach it. Only a change seen now
 * counts: an order already shipped in the copy is not shipped again.
 */
function occurrence(
  event: StoreMessageEvent,
  previous: OrderMilestones | null,
  current: OrderMilestones,
  now: Date,
): Date | null {
  switch (event) {
    case 'order_placed':
      return previous === null && !current.cancelled ? current.placedAt : null;
    case 'cod_confirmation':
      return previous === null && !current.cancelled && current.cashOnDelivery
        ? current.placedAt
        : null;
    case 'order_shipped':
      return current.shippedAt && !current.cancelled && !previous?.shippedAt
        ? current.shippedAt
        : null;
    case 'order_delivered':
      return current.deliveredAt && !current.cancelled && !previous?.deliveredAt
        ? current.deliveredAt
        : null;
    case 'order_cancelled':
      if (!current.cancelled) return null;
      // A cancellation seen on an order already in the copy happened by now at the latest; an
      // order new to the copy and already cancelled counts only when the store says when.
      if (previous) return previous.cancelled ? null : (current.cancelledAt ?? now);
      return current.cancelledAt;
  }
}

/**
 * The messages a read of one order calls for, under the store's enabled rules. Nothing is created
 * for events that happened before their rule was switched on; test orders (unless the store allows
 * them), late events and orders covered by the cash on delivery message are recorded as skipped.
 */
export function detectOrderEvents(input: {
  previous: OrderMilestones | null;
  current: OrderMilestones;
  rules: readonly EnabledRule[];
  includeTestOrders: boolean;
  now: Date;
}): DetectedEvent[] {
  const { previous, current, rules, now } = input;
  const codRule = rules.some((r) => r.event === 'cod_confirmation');
  const events: DetectedEvent[] = [];
  for (const rule of rules) {
    const occurredAt = occurrence(rule.event, previous, current, now);
    if (!occurredAt || occurredAt < rule.enabledAt) continue;
    let skip: DetectedEvent['skip'] = null;
    if (current.test && !input.includeTestOrders) skip = 'test_order';
    else if (now.getTime() - occurredAt.getTime() > STORE_MESSAGE_LIMITS.latenessHours * 3_600_000)
      skip = 'too_late';
    else if (rule.event === 'order_placed' && current.cashOnDelivery && codRule)
      skip = 'cash_on_delivery';
    events.push({ event: rule.event, occurredAt, skip });
  }
  return events;
}

// Sending time ------------------------------------------------------------------------------------------

export interface SendWindow {
  /** Minutes after midnight in the company's time zone; an end before the start wraps midnight. */
  start: number;
  end: number;
}

/**
 * When a message may go out: the event's time plus the rule's delay (never before now), moved to
 * the next opening of the store's sending window when it falls outside it.
 */
export function storeMessageSendAt(input: {
  occurredAt: Date;
  now: Date;
  delayMinutes: number;
  window: SendWindow | null;
  timeZone: string;
}): Date {
  const base = Math.max(
    input.now.getTime(),
    input.occurredAt.getTime() + input.delayMinutes * 60_000,
  );
  if (!input.window) return new Date(base);
  const w = sendingWindow(base, input.timeZone, input.window.start, input.window.end);
  return w.open ? new Date(base) : w.opensAt;
}

// Template variables ------------------------------------------------------------------------------------

export const ORDER_VALUE_FIELDS = [
  'order_name',
  'customer_name',
  'order_total',
  'items_summary',
  'status_url',
  'tracking_number',
  'tracking_company',
  'tracking_url',
  'store_name',
] as const;
export type OrderValueField = (typeof ORDER_VALUE_FIELDS)[number];

export const ORDER_VALUE_LABELS: Record<OrderValueField, string> = {
  order_name: 'Order number (for example #1001)',
  customer_name: 'Customer name',
  order_total: 'Order total (for example ₹1,499.00)',
  items_summary: 'Items (for example "Darjeeling tea and 2 more")',
  status_url: 'Order status page (Shopify)',
  tracking_number: 'Tracking number (Shopify)',
  tracking_company: 'Carrier (Shopify)',
  tracking_url: 'Tracking link (Shopify)',
  store_name: 'Store name',
};

const fallback = z.string().trim().max(200);

export const storeVariableSourceSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('static'),
    value: z.string().trim().min(1, 'Enter the text').max(TEMPLATE_LIMITS.parameterValue),
  }),
  z.object({
    source: z.literal('order'),
    field: z.enum(ORDER_VALUE_FIELDS),
    fallback: fallback.optional(),
  }),
]);
export type StoreVariableSource = z.infer<typeof storeVariableSourceSchema>;

export const storeVariablesSchema = z.object({
  header: z.array(storeVariableSourceSchema).max(1).default([]),
  body: z.array(storeVariableSourceSchema).max(TEMPLATE_LIMITS.bodyVariables).default([]),
});
export type StoreVariables = z.infer<typeof storeVariablesSchema>;

export const EMPTY_STORE_VARIABLES: StoreVariables = { header: [], body: [] };

/** Reads stored variables, treating anything unparseable as empty (the editor then asks again). */
export function readStoreVariables(raw: unknown): StoreVariables {
  const parsed = storeVariablesSchema.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_STORE_VARIABLES;
}

/** The values an order offers to template variables (null where it has none). */
export type OrderValues = Record<OrderValueField, string | null>;

function collapse(text: string | null | undefined): string | null {
  const value = text?.replace(/\s+/g, ' ').trim();
  return value ? value : null;
}

export function orderValues(input: {
  name: string;
  customerName: string | null;
  currency: string | null;
  totalMinor: number | null;
  items: readonly { title: string; quantity: number }[];
  statusUrl: string | null;
  trackingNumber: string | null;
  trackingCompany: string | null;
  trackingUrl: string | null;
  storeName: string | null;
}): OrderValues {
  const [first, ...rest] = input.items;
  const firstTitle = collapse(first?.title);
  return {
    order_name: collapse(input.name),
    customer_name: collapse(input.customerName),
    order_total:
      input.totalMinor !== null && input.currency && isCurrency(input.currency)
        ? formatMinor(input.totalMinor, input.currency)
        : null,
    items_summary: firstTitle
      ? rest.length > 0
        ? `${firstTitle} and ${rest.length} more`
        : firstTitle
      : null,
    status_url: input.statusUrl,
    tracking_number: collapse(input.trackingNumber),
    tracking_company: collapse(input.trackingCompany),
    tracking_url: input.trackingUrl,
    store_name: collapse(input.storeName),
  };
}

/**
 * Template parameters for one order, or the first variable that could not be filled (`header.1`,
 * `body.2`, …). Nothing is ever sent with an empty or placeholder value.
 */
export function resolveStoreVariables(
  variables: StoreVariables,
  values: OrderValues,
): { ok: true; params: { header: string[]; body: string[] } } | { ok: false; missing: string } {
  const one = (source: StoreVariableSource): string | null =>
    source.source === 'static'
      ? collapse(source.value)
      : (values[source.field] ?? collapse(source.fallback));
  const header: string[] = [];
  for (const [i, source] of variables.header.entries()) {
    const text = one(source);
    if (!text) return { ok: false, missing: `header.${i + 1}` };
    header.push(text.slice(0, TEMPLATE_LIMITS.parameterValue));
  }
  const body: string[] = [];
  for (const [i, source] of variables.body.entries()) {
    const text = one(source);
    if (!text) return { ok: false, missing: `body.${i + 1}` };
    body.push(text.slice(0, TEMPLATE_LIMITS.parameterValue));
  }
  return { ok: true, params: { header, body } };
}

// Cash on delivery answers ---------------------------------------------------------------------------------

const COD_PAYLOAD_RE =
  /^w360-cod:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(confirm|cancel)$/;

/**
 * The payload HyFib sets on a cash on delivery message's buttons (research M-177). It names the
 * store message; the tap is still accepted only from that message's own contact and thread.
 */
export function codPayload(storeMessageId: string, answer: 'confirm' | 'cancel'): string {
  return `w360-cod:${storeMessageId}:${answer}`;
}

export function parseCodPayload(
  payload: unknown,
): { storeMessageId: string; answer: 'confirmed' | 'cancelled' } | null {
  if (typeof payload !== 'string') return null;
  const m = COD_PAYLOAD_RE.exec(payload);
  if (!m) return null;
  return {
    storeMessageId: m[1] as string,
    answer: m[2] === 'confirm' ? 'confirmed' : 'cancelled',
  };
}
