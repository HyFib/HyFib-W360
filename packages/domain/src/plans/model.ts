import type { PlanModule, TenantPlanStatus } from '@w360/db';
import type { Permission } from '../authz/permissions';

export type { PlanModule, PlanStatus, TenantPlanStatus } from '@w360/db';

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
  plan: { sellsSeats: boolean; sellsNumbers: boolean; sellsRunPacks: boolean } | undefined,
  addOns: { extraSeats: string; extraNumbers: string; runPacks: string },
): { extraSeats: string; extraNumbers: string; runPacks: string } {
  return {
    extraSeats: plan?.sellsSeats ? addOns.extraSeats : '0',
    extraNumbers: plan?.sellsNumbers ? addOns.extraNumbers : '0',
    runPacks: plan?.sellsRunPacks ? addOns.runPacks : '0',
  };
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
} as const;

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
