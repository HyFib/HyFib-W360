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
