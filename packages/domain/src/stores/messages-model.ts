import { z } from 'zod';
import { clipText } from '@w360/core/text';
import { sendingWindow } from '../campaigns/schedule';
import { formatMinor, isCurrency } from '../crm/money';
import { TEMPLATE_LIMITS, linkValueProblem, type LinkButton } from '../templates/definition';

/**
 * Order messages (P4-06c): the WhatsApp template a store sends when one of its orders is placed,
 * paid for on delivery, shipped, delivered or cancelled, and cart reminders (P4-06d) about checkouts
 * customers left in a Shopify store. Pure rules shared by the store worker, the message worker and
 * the web pages (research docs/research/store-connectors.md §3 and §4, ADR-048, ADR-049).
 *
 * Order events are found by comparing an order's copy before and after a read from the store. Each
 * order or checkout gets at most one message per event, a rule never messages about anything that
 * happened before it was switched on, and an event HyFib first sees long after it happened is
 * recorded, not sent.
 */

export const STORE_MESSAGE_EVENTS = [
  'order_placed',
  'cod_confirmation',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
  'cart_reminder',
  'cart_second_reminder',
] as const;
export type StoreMessageEvent = (typeof STORE_MESSAGE_EVENTS)[number];

/** The two cart reminders: about a checkout rather than an order, marketing templates only. */
export const CART_EVENTS = ['cart_reminder', 'cart_second_reminder'] as const;
export type CartEvent = (typeof CART_EVENTS)[number];
export const isCartEvent = (event: StoreMessageEvent): event is CartEvent =>
  event === 'cart_reminder' || event === 'cart_second_reminder';

/**
 * The events whose rule can start an automation instead of sending a template (ADR-050): the cash
 * on delivery confirmation records its answer from its own template, and the cart reminders' checks
 * depend on the first reminder having been sent.
 */
export const AUTOMATION_EVENTS = [
  'order_placed',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
] as const;
export type AutomationEvent = (typeof AUTOMATION_EVENTS)[number];
export const canStartAutomation = (event: StoreMessageEvent): event is AutomationEvent =>
  (AUTOMATION_EVENTS as readonly string[]).includes(event);

/** What a rule does when its event happens. */
export const STORE_RULE_ACTIONS = ['template', 'automation'] as const;
export type StoreRuleAction = (typeof STORE_RULE_ACTIONS)[number];

type Platform = 'shopify' | 'woocommerce';

export const STORE_MESSAGE_LIMITS = {
  /** An event first seen more than this long after it happened is recorded as too late. */
  latenessHours: 48,
  /** The longest delay any rule can have (the second cart reminder); see delayRange per event. */
  maxDelayMinutes: 4320,
  /** A cart reminder goes out at most this long after the checkout was left. */
  cartLatenessHours: 72,
  /** Checkouts are read this often while a cart reminder is on, this many pages per run. */
  checkoutReadMinutes: 15,
  checkoutPagesPerRun: 10,
  /** The next checkout read starts this long before the last one did (clock differences). */
  checkoutClockMarginSeconds: 120,
  checkoutRetentionDays: 30,
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
  cart_reminder: {
    label: 'Cart reminder',
    description:
      'When a customer leaves a checkout that has a phone number: reminds them with a marketing template, only if they opted in to marketing messages. HyFib reads the store’s checkouts every 15 minutes and sends nothing once the checkout is completed or an order with the same number is placed. Shopify only.',
    platforms: ['shopify'],
  },
  cart_second_reminder: {
    label: 'Second cart reminder',
    description:
      'A later reminder about the same checkout, sent only if the first reminder was sent and the checkout is still open. Shopify only.',
    platforms: ['shopify'],
  },
};

export function eventAvailable(platform: Platform, event: StoreMessageEvent): boolean {
  return STORE_MESSAGE_EVENT_INFO[event].platforms.includes(platform);
}

/** The delay a rule for `event` may have, in minutes (ADR-049 for the cart reminders). */
export function delayRange(event: StoreMessageEvent): { min: number; max: number } {
  switch (event) {
    case 'cart_reminder':
      return { min: 30, max: 1440 };
    case 'cart_second_reminder':
      return { min: 60, max: 4320 };
    default:
      return { min: 0, max: 1440 };
  }
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
  missing_variable:
    'A template variable had no usable value and no fallback (for the end of a link: none, spaces, or one that would change the website).',
  template_changed:
    'The template’s variables or buttons changed after this message was set up. Set it up again.',
  checkout_completed: 'The customer completed the checkout.',
  checkout_deleted: 'The checkout is no longer in HyFib’s copy of the store.',
  order_placed: 'An order with the same number was placed after the checkout began.',
  first_reminder_not_sent: 'The first reminder was not sent, so the second one is not either.',
  cart_too_old: `More than ${STORE_MESSAGE_LIMITS.cartLatenessHours / 24} days passed since the checkout was left.`,
  not_marketing_template: 'Cart reminders need an approved marketing template.',
  frequency_capped:
    'The contact already received as many marketing messages as the company allows in this period.',
  automation_unavailable:
    'The automation was paused or archived, or its live version no longer starts from order messages.',
  conversation_assigned: 'A team member was handling the conversation with the customer.',
  automation_busy: 'Another automation was handling the conversation with the customer.',
  automation_limit:
    'Automations had already started too often in this conversation within the hour.',
  not_in_plan:
    "The company's plan did not include this (commerce, or automations for a rule that starts one).",
  automation_quota: "The company's automation runs for this month were used up.",
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
    case 'cart_reminder':
    case 'cart_second_reminder':
      // About checkouts (checkoutReminders), never about orders.
      return null;
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

/** The parts of a checkout's copy that cart reminders are about. */
export interface CheckoutState {
  /** When the checkout was left: its last update at the store. */
  updatedAt: Date;
  completed: boolean;
  hasPhone: boolean;
  redacted: boolean;
}

/**
 * The cart reminders a checkout read by the store job calls for: one per cart rule that is on,
 * dated when the checkout was left, for an open checkout with a number updated at or after the
 * rule was switched on. A reminder that is still waiting moves when the checkout is updated again.
 */
export function checkoutReminders(input: {
  checkout: CheckoutState;
  rules: readonly EnabledRule[];
}): { event: CartEvent; occurredAt: Date }[] {
  const { checkout } = input;
  if (checkout.completed || checkout.redacted || !checkout.hasPhone) return [];
  const found: { event: CartEvent; occurredAt: Date }[] = [];
  for (const rule of input.rules) {
    if (!isCartEvent(rule.event)) continue;
    if (checkout.updatedAt < rule.enabledAt) continue;
    found.push({ event: rule.event, occurredAt: checkout.updatedAt });
  }
  return found;
}

/**
 * The consent event a store's WhatsApp consent state stands for (SH-041): subscribed and
 * unsubscribed states with an update time; anything else changes nothing.
 */
export function storeConsentAction(consent: {
  state: string | null;
  updatedAt: Date | null;
}): 'opt_in' | 'opt_out' | null {
  if (!consent.updatedAt) return null;
  if (consent.state === 'SUBSCRIBED') return 'opt_in';
  if (consent.state === 'UNSUBSCRIBED') return 'opt_out';
  return null;
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

/** What a checkout offers to a cart reminder's template variables. */
export const CHECKOUT_VALUE_FIELDS = [
  'customer_name',
  'cart_total',
  'cart_items',
  'checkout_url',
  'store_name',
] as const;
export type CheckoutValueField = (typeof CHECKOUT_VALUE_FIELDS)[number];

export const CHECKOUT_VALUE_LABELS: Record<CheckoutValueField, string> = {
  customer_name: 'Customer name',
  cart_total: 'Cart total (for example ₹1,499.00)',
  cart_items: 'Items (for example "Darjeeling tea and 2 more")',
  checkout_url: 'Link back to the checkout',
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
  z.object({
    source: z.literal('checkout'),
    field: z.enum(CHECKOUT_VALUE_FIELDS),
    fallback: fallback.optional(),
  }),
]);
export type StoreVariableSource = z.infer<typeof storeVariableSourceSchema>;

export const storeVariablesSchema = z.object({
  header: z.array(storeVariableSourceSchema).max(1).default([]),
  body: z.array(storeVariableSourceSchema).max(TEMPLATE_LIMITS.bodyVariables).default([]),
  /** The ends of the template's links that take a value, in button order (ADR-229). */
  buttons: z.array(storeVariableSourceSchema).max(TEMPLATE_LIMITS.urlButtons).default([]),
});
export type StoreVariables = z.infer<typeof storeVariablesSchema>;

export const EMPTY_STORE_VARIABLES: StoreVariables = { header: [], body: [], buttons: [] };

/** Reads stored variables, treating anything unparseable as empty (the editor then asks again). */
export function readStoreVariables(raw: unknown): StoreVariables {
  const parsed = storeVariablesSchema.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_STORE_VARIABLES;
}

/** The variable sources a rule for `event` may use: its subject's fields, or fixed text. */
export function variablesFit(event: StoreMessageEvent, variables: StoreVariables): boolean {
  const kind = isCartEvent(event) ? 'checkout' : 'order';
  return [...variables.header, ...variables.body, ...variables.buttons].every(
    (v) => v.source === 'static' || v.source === kind,
  );
}

/**
 * The first fixed text or fallback among the ends of links that its link cannot end with, naming
 * the button (ADR-229), or null.
 */
export function storeLinkProblem(
  variables: StoreVariables,
  links: readonly LinkButton[],
): string | null {
  for (const [i, source] of variables.buttons.entries()) {
    const link = links[i];
    const fixed = source.source === 'static' ? source.value : source.fallback;
    if (!link || !fixed) continue;
    const problem = linkValueProblem(link.url, fixed);
    if (problem)
      return `${link.text}${source.source === 'static' ? '' : ' (fallback)'}: ${problem}`;
  }
  return null;
}

/** The values an order offers to template variables (null where it has none). */
export type OrderValues = Record<OrderValueField, string | null>;
export type CheckoutValues = Record<CheckoutValueField, string | null>;

/** The values of a message's subject: an order, or a checkout for the cart reminders. */
export type StoreValues =
  { subject: 'order'; values: OrderValues } | { subject: 'checkout'; values: CheckoutValues };

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
  return {
    order_name: collapse(input.name),
    customer_name: collapse(input.customerName),
    order_total: moneyText(input.totalMinor, input.currency),
    items_summary: itemsSummary(input.items),
    status_url: input.statusUrl,
    tracking_number: collapse(input.trackingNumber),
    tracking_company: collapse(input.trackingCompany),
    tracking_url: input.trackingUrl,
    store_name: collapse(input.storeName),
  };
}

function moneyText(totalMinor: number | null, currency: string | null): string | null {
  return totalMinor !== null && currency && isCurrency(currency)
    ? formatMinor(totalMinor, currency)
    : null;
}

/** "Darjeeling tea", or "Darjeeling tea and 2 more". */
function itemsSummary(items: readonly { title: string }[]): string | null {
  const [first, ...rest] = items;
  const firstTitle = collapse(first?.title);
  if (!firstTitle) return null;
  return rest.length > 0 ? `${firstTitle} and ${rest.length} more` : firstTitle;
}

export function checkoutValues(input: {
  customerName: string | null;
  currency: string | null;
  totalMinor: number | null;
  items: readonly { title: string; quantity: number }[];
  recoveryUrl: string | null;
  storeName: string | null;
}): CheckoutValues {
  return {
    customer_name: collapse(input.customerName),
    cart_total: moneyText(input.totalMinor, input.currency),
    cart_items: itemsSummary(input.items),
    checkout_url: input.recoveryUrl,
    store_name: collapse(input.storeName),
  };
}

/**
 * Template parameters for one order or checkout, or the first variable that could not be filled
 * (`header.1`, `body.2`, `buttons.1`, …). Nothing is ever sent with an empty or placeholder value,
 * and a source for the other kind of subject counts as unfilled. The end of a link (ADR-229) is the
 * subject's value when its link (`links`, in button order) can end with it, else the fallback when
 * it can.
 */
export function resolveStoreVariables(
  variables: StoreVariables,
  subject: StoreValues,
  links: readonly Pick<LinkButton, 'url'>[] = [],
):
  | { ok: true; params: { header: string[]; body: string[]; buttons: string[] } }
  | { ok: false; missing: string } {
  const valueOf = (source: StoreVariableSource): string | null => {
    if (source.source === 'static' || source.source !== subject.subject) return null;
    const values: Partial<Record<string, string | null>> = subject.values;
    return values[source.field] ?? null;
  };
  const one = (source: StoreVariableSource): string | null => {
    if (source.source === 'static') return collapse(source.value);
    if (source.source !== subject.subject) return null;
    return valueOf(source) ?? collapse(source.fallback);
  };
  const linkValue = (url: string, text: string | null | undefined): string | null => {
    const value = text?.trim();
    if (!value || value.length > TEMPLATE_LIMITS.parameterValue) return null;
    return linkValueProblem(url, value) === null ? value : null;
  };
  const header: string[] = [];
  for (const [i, source] of variables.header.entries()) {
    const text = one(source);
    if (!text) return { ok: false, missing: `header.${i + 1}` };
    header.push(clipText(text, TEMPLATE_LIMITS.parameterValue));
  }
  const body: string[] = [];
  for (const [i, source] of variables.body.entries()) {
    const text = one(source);
    if (!text) return { ok: false, missing: `body.${i + 1}` };
    body.push(clipText(text, TEMPLATE_LIMITS.parameterValue));
  }
  const buttons: string[] = [];
  for (const [i, source] of variables.buttons.entries()) {
    const link = links[i];
    const text = !link
      ? null
      : source.source === 'static'
        ? linkValue(link.url, source.value)
        : source.source === subject.subject
          ? (linkValue(link.url, valueOf(source)) ?? linkValue(link.url, source.fallback))
          : null;
    if (!text) return { ok: false, missing: `buttons.${i + 1}` };
    buttons.push(text);
  }
  return { ok: true, params: { header, body, buttons } };
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
