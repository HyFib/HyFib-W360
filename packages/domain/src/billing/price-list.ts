import { displayMoney } from '@w360/core';
import {
  and,
  asc,
  eq,
  gt,
  isNotNull,
  planSettings,
  plans,
  systemScope,
  type Database,
  type PlanModule,
} from '@w360/db';
import {
  PLAN_INTERVAL_LABELS,
  PLAN_MODULE_KEYS,
  PLAN_MODULE_LABELS,
  planPaymentQuote,
} from '../plans/model';

/**
 * The price list for visitors (ADR-107): the plan versions offered to companies (ADR-105), with
 * their prices before and with the tax, what they include and the add-ons they sell, for anyone
 * who has not signed in. Platform owners show or hide it. Visitors see it only when they could
 * follow it: sign up, start the default trial, then choose one of these versions under Billing and
 * pay for it.
 */

/** What keeps the price list from visitors. */
export type PriceListGap =
  'hidden' | 'payments_off' | 'no_tax' | 'no_default_trial' | 'nothing_payable';

export const PRICE_LIST_GAP_TEXT: Record<PriceListGap, string> = {
  hidden: 'A platform owner has not shown it.',
  payments_off: 'Paying for plans is turned off on this platform.',
  no_tax: 'No tax on plan prices is set, so companies cannot pay for plans.',
  no_default_trial:
    'There is no default trial: new companies start complimentary, and cannot choose a plan.',
  nothing_payable:
    'No version is offered to companies that one plan payment can cover with the tax.',
};

const NO_ADD_ONS = { extraSeats: 0, extraNumbers: 0, runPacks: 0 };

/** What one interval of the version costs with the tax, if one plan payment can cover it. */
function totalWithTax(priceMinor: number, taxBp: number): number | null {
  const quote = planPaymentQuote(
    { priceMinor, seatPriceMinor: null, numberPriceMinor: null, runPackPriceMinor: null },
    NO_ADD_ONS,
    taxBp,
  );
  return quote.ok ? quote.quote.totalMinor : null;
}

/**
 * Every reason visitors see no price list, in order; none: they see it. The same facts decide the
 * public page and the platform's card about it.
 */
export function priceListGaps(facts: {
  shown: boolean;
  subscriptionsEnabled: boolean;
  taxBp: number | null;
  /** The default trial's length; null: no default trial. */
  defaultTrialDays: number | null;
  /** The prices of the versions offered to companies. */
  offeredPrices: readonly number[];
}): PriceListGap[] {
  const gaps: PriceListGap[] = [];
  if (!facts.shown) gaps.push('hidden');
  if (!facts.subscriptionsEnabled) gaps.push('payments_off');
  if (facts.taxBp === null) gaps.push('no_tax');
  if (facts.defaultTrialDays === null) gaps.push('no_default_trial');
  // Without a tax the totals cannot be known yet; the versions are counted before tax then.
  const taxBp = facts.taxBp ?? 0;
  if (!facts.offeredPrices.some((price) => totalWithTax(price, taxBp) !== null))
    gaps.push('nothing_payable');
  return gaps;
}

/** An offered version as visitors see it. */
export interface PriceListPlan {
  id: string;
  name: string;
  description: string | null;
  priceMinor: number;
  /** One interval with the tax. */
  totalMinor: number;
  intervalMonths: number;
  seatsIncluded: number;
  numbersIncluded: number;
  teamsMax: number | null;
  liveAutomationsMax: number | null;
  automationRunsMonthly: number | null;
  apiRequestsMonthly: number | null;
  /** The version includes only some API scopes (ADR-092). */
  someApiScopes: boolean;
  modules: PlanModule[];
  seatPriceMinor: number | null;
  seatsMax: number | null;
  numberPriceMinor: number | null;
  numbersMax: number | null;
  runPackSize: number | null;
  runPackPriceMinor: number | null;
}

export interface PriceList {
  taxBp: number;
  /** How long the trial new companies start with lasts. */
  trialDays: number;
  /** Cheapest first, as companies see them under Billing → Choose a plan. */
  plans: PriceListPlan[];
}

const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');

const amount = (value: number | null, one: string, many: string) =>
  value === null
    ? `Unlimited ${many}`
    : `${value.toLocaleString('en-IN')} ${value === 1 ? one : many}`;

/** What a version includes and the add-ons it sells, in words for visitors. */
export function priceListLines(plan: PriceListPlan): { included: string[]; addOns: string[] } {
  const interval = PLAN_INTERVAL_LABELS[plan.intervalMonths] ?? '';
  // Automation limits and run packs mean nothing without the module.
  const automations = plan.modules.includes('automations');
  const included = [
    amount(plan.seatsIncluded, 'seat', 'seats'),
    amount(plan.numbersIncluded, 'WhatsApp number', 'WhatsApp numbers'),
    amount(plan.teamsMax, 'team', 'teams'),
    ...(automations
      ? [
          amount(plan.liveAutomationsMax, 'live automation', 'live automations'),
          `${amount(plan.automationRunsMonthly, 'automation run', 'automation runs')} a month`,
        ]
      : []),
    plan.apiRequestsMonthly === 0
      ? 'No public API'
      : `${amount(plan.apiRequestsMonthly, 'public API request', 'public API requests')} a month${plan.someApiScopes ? ', for part of the API' : ''}`,
  ];
  const withModules = PLAN_MODULE_KEYS.filter((m) => plan.modules.includes(m));
  const withoutModules = PLAN_MODULE_KEYS.filter((m) => !plan.modules.includes(m));
  if (withModules.length > 0)
    included.push(`With ${withModules.map((m) => PLAN_MODULE_LABELS[m]).join(', ')}`);
  if (withoutModules.length > 0)
    included.push(`Without ${withoutModules.map((m) => PLAN_MODULE_LABELS[m]).join(', ')}`);

  const addOns: string[] = [];
  if (plan.seatPriceMinor !== null)
    addOns.push(
      `Extra seats: ${inr(plan.seatPriceMinor)} each ${interval}${plan.seatsMax !== null ? `, up to ${amount(plan.seatsMax, 'seat', 'seats')} in all` : ''}`,
    );
  if (plan.numberPriceMinor !== null)
    addOns.push(
      `Extra WhatsApp numbers: ${inr(plan.numberPriceMinor)} each ${interval}${plan.numbersMax !== null ? `, up to ${amount(plan.numbersMax, 'number', 'numbers')} in all` : ''}`,
    );
  if (automations && plan.runPackSize !== null && plan.runPackPriceMinor !== null)
    addOns.push(
      `Automation run packs: ${amount(plan.runPackSize, 'more automation run', 'more automation runs')} a month, ${inr(plan.runPackPriceMinor)} each ${interval}`,
    );
  return { included, addOns };
}

export function createPriceListService(deps: {
  db: Database;
  /** Razorpay subscriptions are on: companies can pay for plans here (ADR-063). */
  subscriptionsEnabled: boolean;
}) {
  return {
    /**
     * The price list as visitors see it, or null when they see none. Read in the system scope:
     * nothing of any company, and of the settings only whether the list is shown, the tax and the
     * default trial.
     */
    async publicPriceList(): Promise<PriceList | null> {
      return deps.db.run(
        systemScope,
        async (tx) => {
          const [settings] = await tx
            .select({
              shownAt: planSettings.priceListShownAt,
              taxBp: planSettings.planTaxBp,
              // The trial a new company starts, as app.init_tenant_plan picks it.
              trialDays: plans.trialDays,
            })
            .from(planSettings)
            .leftJoin(
              plans,
              and(
                eq(plans.id, planSettings.defaultTrialPlanId),
                eq(plans.status, 'published'),
                gt(plans.trialDays, 0),
              ),
            );
          if (!settings?.shownAt) return null;
          // The commercial terms only: not who made or offered the version.
          const offered = await tx
            .select({
              id: plans.id,
              name: plans.name,
              description: plans.description,
              priceMinor: plans.priceMinor,
              intervalMonths: plans.intervalMonths,
              seatsIncluded: plans.seatsIncluded,
              numbersIncluded: plans.numbersIncluded,
              teamsMax: plans.teamsMax,
              liveAutomationsMax: plans.liveAutomationsMax,
              automationRunsMonthly: plans.automationRunsMonthly,
              apiRequestsMonthly: plans.apiRequestsMonthly,
              apiScopes: plans.apiScopes,
              modules: plans.modules,
              seatPriceMinor: plans.seatPriceMinor,
              seatsMax: plans.seatsMax,
              numberPriceMinor: plans.numberPriceMinor,
              numbersMax: plans.numbersMax,
              runPackSize: plans.runPackSize,
              runPackPriceMinor: plans.runPackPriceMinor,
            })
            .from(plans)
            .where(and(eq(plans.status, 'published'), isNotNull(plans.offeredAt)))
            .orderBy(asc(plans.priceMinor), asc(plans.name), asc(plans.id));
          const gaps = priceListGaps({
            shown: true,
            subscriptionsEnabled: deps.subscriptionsEnabled,
            taxBp: settings.taxBp,
            defaultTrialDays: settings.trialDays,
            offeredPrices: offered.map((p) => p.priceMinor),
          });
          if (gaps.length > 0 || settings.taxBp === null || settings.trialDays === null)
            return null;
          const taxBp = settings.taxBp;
          const list: PriceListPlan[] = [];
          for (const p of offered) {
            const totalMinor = totalWithTax(p.priceMinor, taxBp);
            // A version one plan payment cannot cover could never be chosen (ADR-105).
            if (totalMinor === null) continue;
            list.push({
              id: p.id,
              name: p.name,
              description: p.description,
              priceMinor: p.priceMinor,
              totalMinor,
              intervalMonths: p.intervalMonths,
              seatsIncluded: p.seatsIncluded,
              numbersIncluded: p.numbersIncluded,
              teamsMax: p.teamsMax,
              liveAutomationsMax: p.liveAutomationsMax,
              automationRunsMonthly: p.automationRunsMonthly,
              apiRequestsMonthly: p.apiRequestsMonthly,
              someApiScopes: p.apiScopes !== null,
              modules: PLAN_MODULE_KEYS.filter((m) => p.modules.includes(m)),
              seatPriceMinor: p.seatPriceMinor,
              seatsMax: p.seatsMax,
              numberPriceMinor: p.numberPriceMinor,
              numbersMax: p.numbersMax,
              runPackSize: p.runPackSize,
              runPackPriceMinor: p.runPackPriceMinor,
            });
          }
          return { taxBp, trialDays: settings.trialDays, plans: list };
        },
        { accessMode: 'read only' },
      );
    },
  };
}

export type PriceListService = ReturnType<typeof createPriceListService>;
