/** Labels for commerce states (shared by the commerce pages and the inbox). */
type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export const ORDER_STATUS: Record<string, { label: string; tone: Tone }> = {
  received: { label: 'Received', tone: 'info' },
  confirmed: { label: 'Confirmed', tone: 'info' },
  awaiting_payment: { label: 'Waiting for payment', tone: 'warning' },
  paid: { label: 'Paid', tone: 'success' },
  fulfilled: { label: 'Fulfilled', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/** Button text for the statuses members can move an order to. */
export const ORDER_STATUS_ACTION: Record<string, string> = {
  confirmed: 'Confirm order',
  fulfilled: 'Mark fulfilled',
  cancelled: 'Cancel order',
};

export const PAYMENT_LINK_STATUS: Record<string, { label: string; tone: Tone }> = {
  creating: { label: 'Being created', tone: 'info' },
  created: { label: 'Waiting for payment', tone: 'warning' },
  partially_paid: { label: 'Partly paid', tone: 'warning' },
  paid: { label: 'Paid', tone: 'success' },
  expired: { label: 'Expired', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  failed: { label: 'Not created', tone: 'danger' },
};

export const PAYMENT_ACCOUNT_STATUS: Record<string, { label: string; tone: Tone }> = {
  unverified: { label: 'Not checked', tone: 'neutral' },
  checking: { label: 'Checking with Razorpay', tone: 'info' },
  verified: { label: 'Working', tone: 'success' },
  failed: { label: 'Check failed', tone: 'danger' },
};

export const CATALOG_SYNC_STATE: Record<string, { label: string; tone: Tone }> = {
  idle: { label: 'Up to date', tone: 'success' },
  queued: { label: 'Waiting to read from Meta', tone: 'info' },
  running: { label: 'Reading from Meta', tone: 'info' },
  failed: { label: 'Last read failed', tone: 'danger' },
};

export const PRODUCT_AVAILABILITY: Record<string, string> = {
  'in stock': 'In stock',
  'out of stock': 'Out of stock',
  preorder: 'Pre-order',
  'available for order': 'Available to order',
  discontinued: 'Discontinued',
};

export const STORE_PLATFORM: Record<string, string> = {
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
};

export const STORE_STATE: Record<string, { label: string; tone: Tone }> = {
  authorizing: { label: 'Waiting for approval', tone: 'info' },
  connecting: { label: 'Connecting', tone: 'info' },
  connected: { label: 'Connected', tone: 'success' },
  failed: { label: 'Needs attention', tone: 'danger' },
  uninstalled: { label: 'Uninstalled in Shopify', tone: 'warning' },
  removing: { label: 'Being removed', tone: 'neutral' },
};

/** A store order's status as members see it (Shopify: open/closed/cancelled; WooCommerce's own). */
export const STORE_ORDER_STATUS: Record<string, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'info' },
  closed: { label: 'Closed', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  pending: { label: 'Pending payment', tone: 'warning' },
  processing: { label: 'Processing', tone: 'info' },
  'on-hold': { label: 'On hold', tone: 'warning' },
  completed: { label: 'Completed', tone: 'success' },
  refunded: { label: 'Refunded', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  'checkout-draft': { label: 'Draft', tone: 'neutral' },
  trash: { label: 'Deleted', tone: 'neutral' },
};

/** Shopify's financial and fulfilment statuses (SH-013), as words. */
export const STORE_STATUS_WORD: Record<string, string> = {
  authorized: 'Authorized',
  expired: 'Expired',
  paid: 'Paid',
  partially_paid: 'Partly paid',
  partially_refunded: 'Partly refunded',
  pending: 'Payment pending',
  refunded: 'Refunded',
  voided: 'Voided',
  fulfilled: 'Fulfilled',
  in_progress: 'In progress',
  on_hold: 'On hold',
  open: 'Unfulfilled',
  partially_fulfilled: 'Partly fulfilled',
  pending_fulfillment: 'Pending fulfilment',
  request_declined: 'Request declined',
  restocked: 'Restocked',
  scheduled: 'Scheduled',
  unfulfilled: 'Unfulfilled',
};

/** A label for a status word HyFib has no label for: the word itself, readable. */
export const statusText = (word: string) =>
  STORE_STATUS_WORD[word] ?? word.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** An order message's status in the store's report (waiting, handed to WhatsApp, Meta's statuses). */
export const STORE_MESSAGE_STATUS: Record<string, { label: string; tone: Tone }> = {
  waiting: { label: 'Waiting', tone: 'info' },
  sending: { label: 'Sending', tone: 'info' },
  sent: { label: 'Sent', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'success' },
  read: { label: 'Read', tone: 'success' },
  failed: { label: 'Not delivered', tone: 'danger' },
  skipped: { label: 'Not sent', tone: 'neutral' },
  started: { label: 'Automation started', tone: 'info' },
};

/** A customer's answer to a cash on delivery message. */
export const COD_ANSWER: Record<string, { label: string; tone: Tone }> = {
  confirmed: { label: 'Customer confirmed', tone: 'success' },
  cancelled: { label: 'Customer asked to cancel', tone: 'warning' },
};
