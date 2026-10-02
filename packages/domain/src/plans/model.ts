import type { PlanModule, PlanSubscriptionStatus, TenantPlanStatus } from '@w360/db';
import type { Permission } from '../authz/permissions';

export type { PlanModule, PlanStatus, PlanSubscriptionStatus, TenantPlanStatus } from '@w360/db';

/**
 * Plans and entitlements (P5-01, ADR-051): the parts the pages and the services share. Pure
 * functions without server dependencies, so pages can use them in the browser.
 */

/** Areas a plan may leave out, in display order (the rest is in every plan). */
export const PLAN_MODULE_KEYS = [
  'automations',
  'flows',
  'crm',
  'commerce',
] as const satisfies readonly PlanModule[];

export const PLAN_MODULE_LABELS: Record<PlanModule, string> = {
  automations: 'Automations',
  flows: 'WhatsApp Flows',
  crm: 'CRM',
  commerce: 'Commerce and stores',
};

/**
 * Permissions a plan without the module takes away. Read access stays, so what a company already
 * has remains visible after a downgrade.
 */
export const MODULE_WRITE_PERMISSIONS: Record<PlanModule, readonly Permission[]> = {
  automations: ['automations.write', 'automations.publish'],
  flows: ['flows.write', 'flows.publish'],
  crm: ['crm.write'],
  commerce: ['commerce.manage'],
};

/** The module whose plan entitlement grants `permission`, if it is one of them. */
export function moduleOfPermission(permission: Permission): PlanModule | null {
  for (const key of PLAN_MODULE_KEYS) {
    if (MODULE_WRITE_PERMISSIONS[key].includes(permission)) return key;
  }
  return null;
}

export const TENANT_PLAN_STATUS_LABELS: Record<TenantPlanStatus, string> = {
  complimentary: 'Complimentary',
  trialing: 'Trial',
  active: 'Active',
  past_due: 'Payment overdue',
  expired: 'Ended',
  canceled: 'Canceled',
};

/** What platform staff may set; the sweep moves plans to past_due and expired as time passes. */
export const ASSIGNABLE_PLAN_STATES = ['complimentary', 'trialing', 'active', 'canceled'] as const;

/** Whether the plan state gives access (the others restrict the company). */
export const planGivesAccess = (status: TenantPlanStatus): boolean =>
  status !== 'expired' && status !== 'canceled';

/**
 * The add-on quantities (as typed in the plan form) to assign with a plan: those the plan does not
 * sell are zero, so a quantity kept from a previous plan cannot block the change.
 */
export function addOnsForPlan(
  plan:
    | {
        sellsSeats: boolean;
        sellsNumbers: boolean;
        sellsRunPacks: boolean;
        sellsApiRequestPacks: boolean;
      }
    | undefined,
  addOns: { extraSeats: string; extraNumbers: string; runPacks: string; apiRequestPacks: string },
): { extraSeats: string; extraNumbers: string; runPacks: string; apiRequestPacks: string } {
  return {
    extraSeats: plan?.sellsSeats ? addOns.extraSeats : '0',
    extraNumbers: plan?.sellsNumbers ? addOns.extraNumbers : '0',
    runPacks: plan?.sellsRunPacks ? addOns.runPacks : '0',
    apiRequestPacks: plan?.sellsApiRequestPacks ? addOns.apiRequestPacks : '0',
  };
}

/** The add-ons a plan version can sell (ADR-051, API request packs ADR-110), in display order. */
export type PlanAddOnKind = 'seats' | 'numbers' | 'runPacks' | 'apiRequestPacks';

export const PLAN_ADD_ON_LABELS: Record<PlanAddOnKind, string> = {
  seats: 'Extra seats',
  numbers: 'Extra WhatsApp numbers',
  runPacks: 'Automation run packs',
  apiRequestPacks: 'API request packs',
};

/** A company's add-on quantities (the plan state's, or a subscription's). */
export interface PlanAddOnQuantities {
  extraSeats: number;
  extraNumbers: number;
  runPacks: number;
  apiRequestPacks: number;
}

/** Limits after add-ons; null means no limit. */
export interface PlanLimits {
  seats: number | null;
  numbers: number | null;
  teams: number | null;
  liveAutomations: number | null;
  automationRuns: number | null;
  /** Public API requests per monthly period; 0: the plan leaves the API out (ADR-061). */
  apiRequests: number | null;
}

/** Bounds of plan versions (the database checks the same). */
export const PLAN_BOUNDS = {
  priceMinor: 1_000_000_000_000,
  trialDays: 90,
  graceDays: 30,
  seats: 10_000,
  numbers: 100,
  teams: 10_000,
  liveAutomations: 10_000,
  automationRuns: 100_000_000,
  runPackSize: 10_000_000,
  addOnUnits: 10_000,
  apiRequests: 1_000_000_000,
  apiRequestPackSize: 100_000_000,
  /**
   * The most a monthly limit can be with its packs (ADR-110): the database returns limits as 32-bit
   * integers, and the plan state's guard refuses more packs.
   */
  limitWithPacks: 2_000_000_000,
} as const;

/**
 * The most packs of `size` a version sells on top of the `included` monthly limit: 10,000, or fewer
 * when more would take the limit past PLAN_BOUNDS.limitWithPacks (ADR-110).
 */
export function packsMax(included: number, size: number): number {
  return Math.max(
    0,
    Math.min(PLAN_BOUNDS.addOnUnits, Math.floor((PLAN_BOUNDS.limitWithPacks - included) / size)),
  );
}

/**
 * The count at which the billing managers are warned before a monthly limit (ADR-062): 80% of the
 * limit, rounded up, when that is still below the limit; null for no warning (no limit, a limit of
 * 0, and limits of 1 to 4). Integer arithmetic, so it matches `ceil(limit * 0.8)` in SQL.
 */
export function warningThreshold(limit: number | null): number | null {
  if (limit === null) return null;
  const threshold = Math.ceil((limit * 4) / 5);
  return threshold < limit ? threshold : null;
}

/** Razorpay's minimum payment, ₹1 (R-064). */
export const PLAN_PAYMENT_MIN_MINOR = 100;
/** HyFib's ceiling on one plan charge: a plan version's highest price. */
export const PLAN_PAYMENT_MAX_MINOR = PLAN_BOUNDS.priceMinor;
/** The highest tax on plan prices platform owners can set, in basis points (the database checks it). */
export const PLAN_TAX_MAX_BP = 5000;
/**
 * Above this charge (₹15,000), an Indian card needs the payer's approval through their bank for every
 * subscription debit: RBI's card mandate rules, as Razorpay's Subscriptions FAQ documents them.
 */
export const CARD_MANDATE_FRICTIONLESS_MAX_MINOR = 1_500_000;

/**
 * A trial ending at least this far away is paid from its end (ADR-102): Razorpay starts a card debit
 * with the bank's notice to the payer 24 to 36 hours before it (R-073, R-119), so a closer first
 * charge is taken at once instead.
 */
export const PLAN_PAYMENT_START_LEAD_MS = 48 * 3600_000;

/**
 * When a subscription started now would first be charged (ADR-102): at the end of a trial at least
 * PLAN_PAYMENT_START_LEAD_MS away, else null (charged at once in Checkout, and the rest of any
 * trial is not carried over).
 */
export function planPaymentStart(
  state: { status: TenantPlanStatus; trialEndsAt: Date | null },
  now: Date,
): Date | null {
  if (state.status !== 'trialing' || !state.trialEndsAt) return null;
  return state.trialEndsAt.getTime() - now.getTime() >= PLAN_PAYMENT_START_LEAD_MS
    ? state.trialEndsAt
    : null;
}

/** What a company pays for its plan each billing interval (ADR-063), in paise. */
export interface PlanPaymentQuote {
  planMinor: number;
  seatsMinor: number;
  numbersMinor: number;
  runPacksMinor: number;
  apiRequestPacksMinor: number;
  subtotalMinor: number;
  taxBp: number;
  taxMinor: number;
  totalMinor: number;
}

export type PlanPaymentQuoteResult =
  | { ok: true; quote: PlanPaymentQuote }
  | { ok: false; reason: 'add_on_not_sold' | 'too_small' | 'too_large' };

/** A plan version's price and the prices of its add-ons per billing interval, in paise. */
export interface PlanPrices {
  priceMinor: number;
  seatPriceMinor: number | null;
  numberPriceMinor: number | null;
  runPackPriceMinor: number | null;
  apiRequestPackPriceMinor: number | null;
}

/**
 * The price of a plan version with add-ons at the version's prices, plus the tax on plan prices
 * (rounded half up to the paisa). Exact integer arithmetic: a quantity of an add-on the version
 * does not sell, a total below ₹1 or above HyFib's ceiling is refused.
 */
export function planPaymentQuote(
  prices: PlanPrices,
  addOns: PlanAddOnQuantities,
  taxBp: number,
): PlanPaymentQuoteResult {
  const line = (quantity: number, price: number | null): bigint | null =>
    quantity === 0 ? 0n : price === null ? null : BigInt(quantity) * BigInt(price);
  const seats = line(addOns.extraSeats, prices.seatPriceMinor);
  const numbers = line(addOns.extraNumbers, prices.numberPriceMinor);
  const runPacks = line(addOns.runPacks, prices.runPackPriceMinor);
  const apiRequestPacks = line(addOns.apiRequestPacks, prices.apiRequestPackPriceMinor);
  if (seats === null || numbers === null || runPacks === null || apiRequestPacks === null) {
    return { ok: false, reason: 'add_on_not_sold' };
  }
  const subtotal = BigInt(prices.priceMinor) + seats + numbers + runPacks + apiRequestPacks;
  const tax = (subtotal * BigInt(taxBp) + 5000n) / 10000n;
  const total = subtotal + tax;
  if (total < BigInt(PLAN_PAYMENT_MIN_MINOR)) return { ok: false, reason: 'too_small' };
  if (total > BigInt(PLAN_PAYMENT_MAX_MINOR)) return { ok: false, reason: 'too_large' };
  return {
    ok: true,
    quote: {
      planMinor: prices.priceMinor,
      seatsMinor: Number(seats),
      numbersMinor: Number(numbers),
      runPacksMinor: Number(runPacks),
      apiRequestPacksMinor: Number(apiRequestPacks),
      subtotalMinor: Number(subtotal),
      taxBp,
      taxMinor: Number(tax),
      totalMinor: Number(total),
    },
  };
}

/** Why a company cannot pay for its plan here now (ADR-063). */
export type PlanPaymentUnavailable =
  | 'not_offered'
  | 'no_tax'
  | 'complimentary'
  | 'paid_period'
  | 'plan_not_published'
  | 'add_on_not_sold'
  | 'too_small'
  | 'too_large'
  | 'subscribed'
  | 'deleting';

export const PLAN_PAYMENT_UNAVAILABLE_TEXT: Record<PlanPaymentUnavailable, string> = {
  not_offered: 'Paying for plans here is not available yet. Ask HyFib to renew your plan.',
  no_tax: 'Paying for plans here is not available yet. Ask HyFib to renew your plan.',
  complimentary: 'Your company has complimentary access, so there is nothing to pay.',
  paid_period:
    'Your plan has a paid period. You can pay here once it ends, or ask HyFib to renew it.',
  plan_not_published: 'Your plan version is no longer offered. Ask HyFib to choose a plan.',
  add_on_not_sold:
    'Your add-ons are not sold with this plan version. Ask HyFib to update the plan.',
  too_small: 'Your plan costs less than ₹1, so there is nothing to pay.',
  too_large: 'Your plan costs more than can be paid here. Ask HyFib to renew your plan.',
  subscribed: 'Your company already pays for its plan by subscription.',
  deleting: 'Your company is being deleted.',
};

export const PLAN_SUBSCRIPTION_STATUS_LABELS: Record<PlanSubscriptionStatus, string> = {
  creating: 'Starting',
  created: 'Waiting for payment',
  authenticated: 'Authorised',
  active: 'Active',
  pending: 'Payment failed, Razorpay is retrying',
  halted: 'Payments stopped',
  paused: 'Paused',
  cancelled: 'Cancelled',
  completed: 'Completed',
  expired: 'Not paid in time',
  failed: 'Could not start',
};

export const PLAN_INTERVAL_LABELS: Record<number, string> = {
  1: 'per month',
  3: 'per quarter',
  12: 'per year',
};

function addMonthsUtc(anchor: Date, months: number): Date {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

/**
 * The monthly usage period containing `now`: periods start on the anchor's day of the month (in
 * UTC, on the month's last day when it is shorter), whatever the billing interval.
 */
export function usagePeriod(anchor: Date, now: Date): { start: Date; end: Date } {
  let months =
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - anchor.getUTCMonth());
  if (months < 0) months = 0;
  while (months > 0 && addMonthsUtc(anchor, months) > now) months -= 1;
  while (addMonthsUtc(anchor, months + 1) <= now) months += 1;
  return { start: addMonthsUtc(anchor, months), end: addMonthsUtc(anchor, months + 1) };
}

/** What a company holds now that a plan version's limits must fit (ADR-105). */
export interface PlanHoldings {
  /** Active members and invitations still waiting (both hold a seat). */
  seats: number;
  numbers: number;
  teams: number;
  liveAutomations: number;
}

export type PlanShortfallKind = keyof PlanHoldings;

/** A limit of a plan version that holds less than the company already has. */
export interface PlanShortfall {
  kind: PlanShortfallKind;
  limit: number;
  used: number;
}

/**
 * The limits a plan version gives a company with its add-ons, as `app.tenant_entitlements` counts
 * them: seats and WhatsApp numbers include the extras bought; null means no limit.
 */
export function versionHoldingLimits(
  version: {
    seatsIncluded: number;
    numbersIncluded: number;
    teamsMax: number | null;
    liveAutomationsMax: number | null;
  },
  addOns: { extraSeats: number; extraNumbers: number },
): Record<PlanShortfallKind, number | null> {
  return {
    seats: version.seatsIncluded + addOns.extraSeats,
    numbers: version.numbersIncluded + addOns.extraNumbers,
    teams: version.teamsMax,
    liveAutomations: version.liveAutomationsMax,
  };
}

/**
 * The limits that hold less than the company has now, in display order (ADR-105). Holding exactly
 * the limit fits: additions stop at a limit, but what is already there stays.
 */
export function planShortfalls(
  limits: Record<PlanShortfallKind, number | null>,
  holdings: PlanHoldings,
): PlanShortfall[] {
  const shortfalls: PlanShortfall[] = [];
  for (const kind of ['seats', 'numbers', 'teams', 'liveAutomations'] as const) {
    const limit = limits[kind];
    if (limit !== null && holdings[kind] > limit) {
      shortfalls.push({ kind, limit, used: holdings[kind] });
    }
  }
  return shortfalls;
}

const SHORTFALL_NOUNS: Record<PlanShortfallKind, readonly [string, string]> = {
  seats: ['seat', 'seats'],
  numbers: ['WhatsApp number', 'WhatsApp numbers'],
  teams: ['team', 'teams'],
  liveAutomations: ['live automation', 'live automations'],
};

/** "3 seats, where your company uses 5 (members and invitations still waiting)". */
export function planShortfallText(shortfall: PlanShortfall): string {
  const [one, many] = SHORTFALL_NOUNS[shortfall.kind];
  const text = `${shortfall.limit.toLocaleString('en-IN')} ${shortfall.limit === 1 ? one : many}, where your company uses ${shortfall.used.toLocaleString('en-IN')}`;
  return shortfall.kind === 'seats' ? `${text} (members and invitations still waiting)` : text;
}
