import { z } from 'zod';
import type { Clock } from '@w360/core';
import {
  LIVE_PLAN_SUBSCRIPTION_STATUSES,
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  planSettings,
  planSubscriptions,
  plans,
  tenantPlans,
  tenants,
  type ApiScope,
  type Database,
  type PlanModule,
  type PlanSubscriptionStatus,
  type TenantPlanStatus,
  type Tx,
} from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
import { liveAutomationsInUse, numbersInUse, seatsInUse, teamsInUse } from '../plans/entitlements';
import {
  PLAN_BOUNDS,
  PLAN_MODULE_KEYS,
  PLAN_PAYMENT_START_LEAD_MS,
  planShortfalls,
  versionHoldingLimits,
  type PlanHoldings,
  type PlanShortfall,
} from '../plans/model';
import type { PlanAddOnOption } from './plan-add-ons';

/**
 * Changing the plan a company pays for by subscription, from the end of the paid period (ADR-109):
 * whether it can, the versions it can change to and the add-ons each sells. The change itself is
 * made by the plan subscription service (`scheduleChange`): it cancels the current subscription at
 * the end of its cycle and records a subscription that follows it, which
 * `app.guard_plan_subscription_follow` checks again in SQL.
 */

/** Why the company cannot change its plan from the end of the paid period now. */
export type PlanChangeUnavailable =
  'not_offered' | 'deleting' | 'suspended' | 'not_paying' | 'not_charging' | 'too_late';

export const PLAN_CHANGE_UNAVAILABLE_TEXT: Record<PlanChangeUnavailable, string> = {
  not_offered: 'Changing your plan here is not available yet. Ask HyFib to change your plan.',
  deleting: 'Your company is being deleted, so its plan cannot change.',
  suspended: 'Your company is suspended, so its plan cannot change.',
  not_paying:
    'Your plan has no period paid by subscription to change it from. Choose a plan under Billing instead.',
  not_charging:
    'Razorpay reports your subscription as paused or not charging. Once it charges again, you can change your plan from the end of the paid period.',
  too_late:
    'Your paid period ends within 48 hours, too soon for Razorpay to start a new subscription then. Choose a plan under Billing once it ends.',
};

/** Statuses of the subscription that paid the plan from which a change can follow it. */
const FOLLOWABLE: readonly PlanSubscriptionStatus[] = [
  'active',
  'cancelled',
  'completed',
  'expired',
];

/**
 * Whether a company may change its plan from the end of the paid period now (ADR-109): null when it
 * may, otherwise why not. `app.guard_plan_subscription_follow` checks the same in SQL.
 */
export function planChangeFromPeriodEndUnavailable(facts: {
  companyStatus: string;
  planStatus: TenantPlanStatus;
  periodEnd: Date | null;
  /** The subscription that paid the plan's period, if any. */
  paying: { status: PlanSubscriptionStatus } | null;
  subscriptionsEnabled: boolean;
  taxBp: number | null;
  now: Date;
}): PlanChangeUnavailable | null {
  const { companyStatus, paying, periodEnd } = facts;
  if (companyStatus === 'pending_deletion' || companyStatus === 'deleted') return 'deleting';
  if (companyStatus === 'suspended') return 'suspended';
  if (!facts.subscriptionsEnabled || facts.taxBp === null) return 'not_offered';
  if (facts.planStatus !== 'active' || !paying || !periodEnd) return 'not_paying';
  if (!FOLLOWABLE.includes(paying.status)) return 'not_charging';
  if (periodEnd.getTime() - facts.now.getTime() < PLAN_PAYMENT_START_LEAD_MS) return 'too_late';
  return null;
}

/** What a version gives, as the company sees it when changing its plan. */
export interface PlanChangeVersion {
  id: string;
  name: string;
  description: string | null;
  priceMinor: number;
  intervalMonths: number;
  seatsIncluded: number;
  numbersIncluded: number;
  teamsMax: number | null;
  liveAutomationsMax: number | null;
  automationRunsMonthly: number | null;
  apiRequestsMonthly: number | null;
  /** The API scopes it includes; null: every scope (ADR-092). */
  apiScopes: ApiScope[] | null;
  modules: PlanModule[];
  seatPriceMinor: number | null;
  numberPriceMinor: number | null;
  runPackSize: number | null;
  runPackPriceMinor: number | null;
  /** The version the company is on. */
  current: boolean;
  /** What the company has that the version cannot hold, even with the most add-ons it sells. */
  shortfalls: PlanShortfall[];
}

/** The plan the company pays for now. */
export interface PlanChangeCurrent {
  planId: string;
  name: string;
  intervalMonths: number;
  extraSeats: number;
  extraNumbers: number;
  runPacks: number;
  /** What the subscription that paid the period charges each interval. */
  amountMinor: number | null;
}

/** The subscription that follows the current one from the end of the paid period. */
export interface PlanChangeNext {
  id: string;
  status: PlanSubscriptionStatus;
  planId: string;
  planName: string;
  intervalMonths: number;
  extraSeats: number;
  extraNumbers: number;
  runPacks: number;
  amountMinor: number;
  startsAt: Date;
  authorizeBy: Date;
  /** Checkout can still authorise it: created and its window is open. */
  checkoutOpen: boolean;
}

export interface PlanChangeOverview {
  /** Null when the company can change its plan; otherwise why not. */
  unavailable: PlanChangeUnavailable | null;
  /** The end of the paid period, when a change takes effect. */
  periodEnd: Date | null;
  /** Until when a change can be made: 48 hours before the period ends. */
  changeBy: Date | null;
  current: PlanChangeCurrent | null;
  /** The subscription that paid the period charges no more after it (cancelled at its end, or ended). */
  currentEnds: boolean;
  next: PlanChangeNext | null;
  holdings: PlanHoldings;
  /** The tax on plan prices, in basis points; null: not set. */
  taxBp: number | null;
  /** Versions the company can change to: the offered ones and its own while published, cheapest first. */
  versions: PlanChangeVersion[];
}

export interface PlanChangeOption extends Omit<PlanChangeOverview, 'versions'> {
  version: PlanChangeVersion;
  /** The add-ons the version sells, with the quantities the form starts from. */
  options: PlanAddOnOption[];
}

export interface PlanChangeServiceDeps {
  db: Database;
  clock: Clock;
  /** Razorpay subscriptions are on, so a changed plan can be paid for (ADR-063). */
  subscriptionsEnabled: boolean;
}

type PlanRow = typeof plans.$inferSelect;

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

/**
 * The add-ons a version sells for a company that uses `used`, starting from `start` (kept within
 * what the version sells and what the company needs): the most the version sells, and the fewest
 * that hold the seats and WhatsApp numbers the company uses. `min` above `max` means the version
 * cannot hold them.
 */
export function planChangeAddOns(
  version: Pick<
    PlanRow,
    | 'seatsIncluded'
    | 'seatPriceMinor'
    | 'seatsMax'
    | 'numbersIncluded'
    | 'numberPriceMinor'
    | 'numbersMax'
    | 'runPackSize'
    | 'runPackPriceMinor'
    | 'automationRunsMonthly'
  >,
  start: { extraSeats: number; extraNumbers: number; runPacks: number },
  used: { seats: number; numbers: number },
): PlanAddOnOption[] {
  const options: PlanAddOnOption[] = [];
  if (version.seatPriceMinor !== null) {
    const min = Math.max(0, used.seats - version.seatsIncluded);
    const max = Math.min(
      PLAN_BOUNDS.addOnUnits,
      version.seatsMax === null ? PLAN_BOUNDS.addOnUnits : version.seatsMax - version.seatsIncluded,
    );
    options.push({
      kind: 'seats',
      quantity: clamp(start.extraSeats, min, max),
      min,
      max,
      unitPriceMinor: version.seatPriceMinor,
      unitSize: 1,
      included: version.seatsIncluded,
      used: used.seats,
    });
  }
  if (version.numberPriceMinor !== null) {
    const min = Math.max(0, used.numbers - version.numbersIncluded);
    const max = (version.numbersMax ?? PLAN_BOUNDS.numbers) - version.numbersIncluded;
    options.push({
      kind: 'numbers',
      quantity: clamp(start.extraNumbers, min, max),
      min,
      max,
      unitPriceMinor: version.numberPriceMinor,
      unitSize: 1,
      included: version.numbersIncluded,
      used: used.numbers,
    });
  }
  if (
    version.runPackSize !== null &&
    version.runPackPriceMinor !== null &&
    version.automationRunsMonthly !== null
  ) {
    options.push({
      kind: 'runPacks',
      quantity: clamp(start.runPacks, 0, PLAN_BOUNDS.addOnUnits),
      min: 0,
      max: PLAN_BOUNDS.addOnUnits,
      unitPriceMinor: version.runPackPriceMinor,
      unitSize: version.runPackSize,
      included: version.automationRunsMonthly,
      used: null,
    });
  }
  return options;
}

/**
 * Add-ons on another version that keep what the company has now: as many seats, WhatsApp numbers
 * and automation runs a month as its current version and add-ons give (planChangeAddOns then keeps
 * them within what the version sells). The form for its current version starts from its add-ons.
 */
export function addOnsKeepingCapacity(
  current: Pick<
    PlanRow,
    'seatsIncluded' | 'numbersIncluded' | 'automationRunsMonthly' | 'runPackSize'
  > | null,
  have: { extraSeats: number; extraNumbers: number; runPacks: number },
  version: Pick<
    PlanRow,
    'seatsIncluded' | 'numbersIncluded' | 'automationRunsMonthly' | 'runPackSize'
  >,
): { extraSeats: number; extraNumbers: number; runPacks: number } {
  if (!current) return { extraSeats: 0, extraNumbers: 0, runPacks: 0 };
  const runs =
    current.automationRunsMonthly === null
      ? null
      : current.automationRunsMonthly + have.runPacks * (current.runPackSize ?? 0);
  return {
    extraSeats: Math.max(0, current.seatsIncluded + have.extraSeats - version.seatsIncluded),
    extraNumbers: Math.max(
      0,
      current.numbersIncluded + have.extraNumbers - version.numbersIncluded,
    ),
    runPacks:
      runs === null || version.automationRunsMonthly === null || version.runPackSize === null
        ? 0
        : Math.ceil(Math.max(0, runs - version.automationRunsMonthly) / version.runPackSize),
  };
}

/** The most extra seats and WhatsApp numbers a version sells. */
function mostAddOns(version: PlanRow) {
  return {
    extraSeats:
      version.seatPriceMinor === null
        ? 0
        : Math.min(
            PLAN_BOUNDS.addOnUnits,
            version.seatsMax === null
              ? PLAN_BOUNDS.addOnUnits
              : version.seatsMax - version.seatsIncluded,
          ),
    extraNumbers:
      version.numberPriceMinor === null
        ? 0
        : (version.numbersMax ?? PLAN_BOUNDS.numbers) - version.numbersIncluded,
  };
}

function versionOf(p: PlanRow, currentPlanId: string | null, holdings: PlanHoldings) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    priceMinor: p.priceMinor,
    intervalMonths: p.intervalMonths,
    seatsIncluded: p.seatsIncluded,
    numbersIncluded: p.numbersIncluded,
    teamsMax: p.teamsMax,
    liveAutomationsMax: p.liveAutomationsMax,
    automationRunsMonthly: p.automationRunsMonthly,
    apiRequestsMonthly: p.apiRequestsMonthly,
    apiScopes: p.apiScopes,
    modules: PLAN_MODULE_KEYS.filter((m) => p.modules.includes(m)),
    seatPriceMinor: p.seatPriceMinor,
    numberPriceMinor: p.numberPriceMinor,
    runPackSize: p.runPackSize,
    runPackPriceMinor: p.runPackPriceMinor,
    current: p.id === currentPlanId,
    shortfalls: planShortfalls(versionHoldingLimits(p, mostAddOns(p)), holdings),
  } satisfies PlanChangeVersion;
}

/** What the company has that a plan must hold (ADR-105's shortfalls). */
export async function planChangeHoldings(
  tx: Tx,
  tenantId: string,
  now: Date,
): Promise<PlanHoldings> {
  return {
    seats: await seatsInUse(tx, tenantId, now),
    numbers: await numbersInUse(tx, tenantId),
    teams: await teamsInUse(tx, tenantId),
    liveAutomations: await liveAutomationsInUse(tx, tenantId),
  };
}

const planIdSchema = z.uuid('Choose a plan.');

/** A quantity typed in the form: digits only, empty for none. */
const count = (max: number, message: string) =>
  z.preprocess(
    (v) => {
      if (typeof v !== 'string') return v;
      const text = v.trim();
      if (text === '') return 0;
      return /^\d{1,6}$/.test(text) ? Number(text) : Number.NaN;
    },
    z.number({ error: message }).int(message).min(0, message).max(max, message),
  );

/** A change of plan as the form sends it: the version and the add-ons wanted on it. */
export const planChangeSchema = z.object({
  planId: planIdSchema,
  extraSeats: count(PLAN_BOUNDS.addOnUnits, 'Extra seats are a whole number up to 10,000.'),
  extraNumbers: count(PLAN_BOUNDS.numbers, 'Extra WhatsApp numbers are a whole number up to 100.'),
  runPacks: count(PLAN_BOUNDS.addOnUnits, 'Run packs are a whole number up to 10,000.'),
});

export function createPlanChangeService(deps: PlanChangeServiceDeps) {
  const { db, clock } = deps;

  /** Everything about the company's plan and subscriptions a change depends on. */
  async function load(tx: Tx, ctx: TenantContext) {
    const now = clock.now();
    const [company] = await tx
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenant.id));
    const [state] = await tx
      .select()
      .from(tenantPlans)
      .where(eq(tenantPlans.tenantId, ctx.tenant.id));
    if (!company || !state) throw new Error('The company has no plan state');
    const [settings] = await tx.select({ taxBp: planSettings.planTaxBp }).from(planSettings);
    const taxBp = settings?.taxBp ?? null;
    const [paying] = state.subscriptionId
      ? await tx
          .select()
          .from(planSubscriptions)
          .where(
            and(
              eq(planSubscriptions.tenantId, ctx.tenant.id),
              eq(planSubscriptions.id, state.subscriptionId),
            ),
          )
      : [];
    const [next] = paying
      ? await tx
          .select({ row: planSubscriptions, planName: plans.name })
          .from(planSubscriptions)
          .innerJoin(plans, eq(plans.id, planSubscriptions.planId))
          .where(
            and(
              eq(planSubscriptions.tenantId, ctx.tenant.id),
              eq(planSubscriptions.followsSubscriptionId, paying.id),
              inArray(planSubscriptions.status, [...LIVE_PLAN_SUBSCRIPTION_STATUSES]),
            ),
          )
      : [];
    const [current] = state.planId
      ? await tx.select().from(plans).where(eq(plans.id, state.planId))
      : [];
    const holdings = await planChangeHoldings(tx, ctx.tenant.id, now);
    const unavailable = planChangeFromPeriodEndUnavailable({
      companyStatus: company.status,
      planStatus: state.status,
      periodEnd: state.periodEnd,
      paying: paying ?? null,
      subscriptionsEnabled: deps.subscriptionsEnabled,
      taxBp,
      now,
    });
    const periodEnd = state.status === 'active' && paying ? state.periodEnd : null;
    const overview: Omit<PlanChangeOverview, 'versions'> = {
      unavailable,
      periodEnd,
      changeBy: periodEnd ? new Date(periodEnd.getTime() - PLAN_PAYMENT_START_LEAD_MS) : null,
      current: current
        ? {
            planId: current.id,
            name: current.name,
            intervalMonths: current.intervalMonths,
            extraSeats: state.extraSeats,
            extraNumbers: state.extraNumbers,
            runPacks: state.runPacks,
            amountMinor: paying?.amountMinor ?? null,
          }
        : null,
      currentEnds: paying
        ? (paying.status === 'active' && paying.cancelAtPeriodEnd) ||
          ['cancelled', 'completed', 'expired'].includes(paying.status)
        : false,
      next:
        next && next.row.startsAt
          ? {
              id: next.row.id,
              status: next.row.status,
              planId: next.row.planId,
              planName: next.planName,
              intervalMonths: next.row.intervalMonths,
              extraSeats: next.row.extraSeats,
              extraNumbers: next.row.extraNumbers,
              runPacks: next.row.runPacks,
              amountMinor: next.row.amountMinor,
              startsAt: next.row.startsAt,
              authorizeBy: next.row.authorizeBy,
              checkoutOpen:
                next.row.status === 'created' &&
                next.row.providerSubscriptionId !== null &&
                now < next.row.authorizeBy,
            }
          : null,
      holdings,
      taxBp,
    };
    return { overview, state, current: current ?? null, now };
  }

  /** The versions the company can change to: offered ones, and its own while published. */
  async function choosable(tx: Tx, currentPlanId: string | null): Promise<PlanRow[]> {
    const offered = await tx
      .select()
      .from(plans)
      .where(and(eq(plans.status, 'published'), isNotNull(plans.offeredAt)))
      .orderBy(asc(plans.priceMinor), asc(plans.name), asc(plans.id));
    if (!currentPlanId || offered.some((p) => p.id === currentPlanId)) return offered;
    const [own] = await tx
      .select()
      .from(plans)
      .where(and(eq(plans.id, currentPlanId), eq(plans.status, 'published')));
    if (!own) return offered;
    return [...offered, own].sort(
      (a, b) =>
        a.priceMinor - b.priceMinor || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
  }

  return {
    /** Whether and to which versions the company can change its plan (`billing.read`). */
    async overview(ctx: TenantContext): Promise<PlanChangeOverview> {
      assertCan(ctx, 'billing.read');
      return db.run(
        ctx.scope,
        async (tx) => {
          const { overview, state } = await load(tx, ctx);
          const versions = (await choosable(tx, state.planId)).map((p) =>
            versionOf(p, state.planId, overview.holdings),
          );
          return { ...overview, versions };
        },
        { accessMode: 'read only' },
      );
    },

    /**
     * One version the company could change to, with the add-ons it sells (`billing.read`). Not
     * found for a version the company cannot choose.
     */
    async option(ctx: TenantContext, planId: string): Promise<PlanChangeOption | null> {
      assertCan(ctx, 'billing.read');
      const parsed = planIdSchema.safeParse(planId);
      if (!parsed.success) return null;
      return db.run(
        ctx.scope,
        async (tx) => {
          const { overview, state, current } = await load(tx, ctx);
          const version = (await choosable(tx, state.planId)).find((p) => p.id === parsed.data);
          if (!version) return null;
          const start =
            version.id === state.planId ? state : addOnsKeepingCapacity(current, state, version);
          return {
            ...overview,
            version: versionOf(version, state.planId, overview.holdings),
            options: planChangeAddOns(version, start, overview.holdings),
          };
        },
        { accessMode: 'read only' },
      );
    },
  };
}

export type PlanChangeService = ReturnType<typeof createPlanChangeService>;
