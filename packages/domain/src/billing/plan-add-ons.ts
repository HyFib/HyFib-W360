import { z } from 'zod';
import { AppError, type Clock } from '@w360/core';
import {
  LIVE_PLAN_SUBSCRIPTION_STATUSES,
  and,
  eq,
  inArray,
  planSettings,
  planSubscriptions,
  plans,
  sql,
  tenantPlans,
  tenants,
  type Database,
  type TenantPlanStatus,
} from '@w360/db';
import { recordAudit, type RequestMeta } from '../audit';
import { assertCan, type TenantContext } from '../authz/context';
import { assertRecentSignIn } from '../authz/step-up';
import { lockAllLimits, numbersInUse, seatsInUse } from '../plans/entitlements';
import {
  PLAN_BOUNDS,
  planPaymentQuote,
  planShortfallText,
  type PlanAddOnKind,
  type PlanPaymentQuote,
  type PlanPaymentQuoteResult,
} from '../plans/model';
import { parseInput } from '../validation';
import { planChangeUnavailable, type PlanChoiceUnavailable } from './plan-choices';

/**
 * A company choosing its own add-ons (ADR-106): the extra seats, extra WhatsApp numbers and
 * automation run packs of the plan version it is on, under the conditions of choosing a plan
 * (ADR-105), which `app.choose_add_ons` checks again in SQL. The company then pays for them with
 * the plan as before (ADR-063).
 */

/** Why the company cannot choose its add-ons now. */
export type PlanAddOnsUnavailable = PlanChoiceUnavailable | 'plan_retired';

export const PLAN_ADD_ONS_UNAVAILABLE_TEXT: Record<PlanAddOnsUnavailable, string> = {
  not_offered: 'Choosing add-ons here is not available yet. Ask HyFib to change your add-ons.',
  deleting: 'Your company is being deleted, so its add-ons cannot change.',
  suspended: 'Your company is suspended, so its add-ons cannot change.',
  complimentary: 'Your company has complimentary access, so there are no add-ons to choose.',
  payment_started:
    'A payment for your plan is being started. Finish it under Paying for your plan, or wait an hour for its window to close, before changing your add-ons.',
  paying_from_trial_end:
    'Your company pays for its plan from the end of the trial. Cancel that payment under Paying for your plan to change your add-ons; the trial goes on.',
  subscribed:
    'Your company pays for its plan by subscription. Change its add-ons from the end of the paid period under Billing → Change plan.',
  paid_period:
    'Your plan has a paid period. You can choose add-ons once it ends, or ask HyFib to change them.',
  plan_retired:
    'Your plan version is no longer offered, so its add-ons cannot change. Choose another plan under Billing.',
};

/** An add-on the company's version sells, as the company sees it. */
export interface PlanAddOnOption {
  kind: PlanAddOnKind;
  /** The company's quantity now. */
  quantity: number;
  /**
   * The fewest it can keep: what it uses beyond what the version includes, or its quantity now
   * when that is already fewer (an increase is always allowed).
   */
  min: number;
  /** The most the version sells. */
  max: number;
  /** The price of one each interval, in paise. */
  unitPriceMinor: number;
  /** Automation runs a month in one pack; 1 for seats and numbers. */
  unitSize: number;
  /** What the version includes: seats, WhatsApp numbers, or automation runs a month. */
  included: number;
  /** In use now: seats (members and waiting invitations) or WhatsApp numbers; null for run packs. */
  used: number | null;
}

export interface PlanAddOns {
  /** Null when the company can choose; otherwise why not. */
  unavailable: PlanAddOnsUnavailable | null;
  status: TenantPlanStatus;
  trialEndsAt: Date | null;
  /** The version the company is on, with the prices a quote needs; null: complimentary access. */
  plan: {
    id: string;
    name: string;
    intervalMonths: number;
    priceMinor: number;
    seatPriceMinor: number | null;
    numberPriceMinor: number | null;
    runPackPriceMinor: number | null;
  } | null;
  /** The add-ons the version sells, in display order. */
  options: PlanAddOnOption[];
  /** The tax on plan prices, in basis points; null: not set. */
  taxBp: number | null;
  /** What the company would pay each interval now, with its add-ons and the tax; null: no tax. */
  quote: PlanPaymentQuoteResult | null;
}

export interface PlanAddOnsServiceDeps {
  db: Database;
  clock: Clock;
  /** Razorpay subscriptions are on, so the add-ons can be paid for (ADR-063). */
  subscriptionsEnabled: boolean;
}

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

const chooseSchema = z.object({
  extraSeats: count(PLAN_BOUNDS.addOnUnits, 'Extra seats are a whole number up to 10,000.'),
  extraNumbers: count(PLAN_BOUNDS.numbers, 'Extra WhatsApp numbers are a whole number up to 100.'),
  runPacks: count(PLAN_BOUNDS.addOnUnits, 'Run packs are a whole number up to 10,000.'),
});

export function createPlanAddOnsService(deps: PlanAddOnsServiceDeps) {
  const { db, clock } = deps;

  return {
    /** The add-ons the company's version sells and whether it can choose them now (`billing.read`). */
    async addOns(ctx: TenantContext): Promise<PlanAddOns> {
      assertCan(ctx, 'billing.read');
      const now = clock.now();
      return db.run(
        ctx.scope,
        async (tx) => {
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
          const [live] = await tx
            .select({
              status: planSubscriptions.status,
              startsAt: planSubscriptions.startsAt,
              paidCount: planSubscriptions.paidCount,
            })
            .from(planSubscriptions)
            .where(
              and(
                eq(planSubscriptions.tenantId, ctx.tenant.id),
                inArray(planSubscriptions.status, [...LIVE_PLAN_SUBSCRIPTION_STATUSES]),
              ),
            );
          const [version] = state.planId
            ? await tx.select().from(plans).where(eq(plans.id, state.planId))
            : [];

          let unavailable: PlanAddOnsUnavailable | null = planChangeUnavailable({
            companyStatus: company.status,
            planStatus: state.status,
            live,
            subscriptionsEnabled: deps.subscriptionsEnabled,
            taxBp,
          });
          if (unavailable === null && version?.status !== 'published') unavailable = 'plan_retired';

          const options: PlanAddOnOption[] = [];
          if (version) {
            if (version.seatPriceMinor !== null) {
              const used = await seatsInUse(tx, ctx.tenant.id, now);
              options.push({
                kind: 'seats',
                quantity: state.extraSeats,
                min: Math.min(state.extraSeats, Math.max(0, used - version.seatsIncluded)),
                max: Math.min(
                  PLAN_BOUNDS.addOnUnits,
                  version.seatsMax === null
                    ? PLAN_BOUNDS.addOnUnits
                    : version.seatsMax - version.seatsIncluded,
                ),
                unitPriceMinor: version.seatPriceMinor,
                unitSize: 1,
                included: version.seatsIncluded,
                used,
              });
            }
            if (version.numberPriceMinor !== null) {
              const used = await numbersInUse(tx, ctx.tenant.id);
              options.push({
                kind: 'numbers',
                quantity: state.extraNumbers,
                min: Math.min(state.extraNumbers, Math.max(0, used - version.numbersIncluded)),
                max: (version.numbersMax ?? PLAN_BOUNDS.numbers) - version.numbersIncluded,
                unitPriceMinor: version.numberPriceMinor,
                unitSize: 1,
                included: version.numbersIncluded,
                used,
              });
            }
            if (
              version.runPackSize !== null &&
              version.runPackPriceMinor !== null &&
              version.automationRunsMonthly !== null
            ) {
              options.push({
                kind: 'runPacks',
                quantity: state.runPacks,
                min: 0,
                max: PLAN_BOUNDS.addOnUnits,
                unitPriceMinor: version.runPackPriceMinor,
                unitSize: version.runPackSize,
                included: version.automationRunsMonthly,
                used: null,
              });
            }
          }

          return {
            unavailable,
            status: state.status,
            trialEndsAt: state.trialEndsAt,
            plan: version
              ? {
                  id: version.id,
                  name: version.name,
                  intervalMonths: version.intervalMonths,
                  priceMinor: version.priceMinor,
                  seatPriceMinor: version.seatPriceMinor,
                  numberPriceMinor: version.numberPriceMinor,
                  runPackPriceMinor: version.runPackPriceMinor,
                }
              : null,
            options,
            taxBp,
            quote: version && taxBp !== null ? planPaymentQuote(version, state, taxBp) : null,
          };
        },
        { accessMode: 'read only' },
      );
    },

    /**
     * Sets the add-ons of the company's version (`billing.manage` and a recent sign-in). A decrease
     * must leave the seats and WhatsApp numbers the company uses: the limits' locks are taken
     * first, so no addition slips in between the count and the commit.
     */
    async choose(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<{ changed: boolean; quote: PlanPaymentQuote | null }> {
      assertCan(ctx, 'billing.manage');
      // Add-ons change what the company pays (ADR-056).
      assertRecentSignIn(ctx, clock.now());
      if (!deps.subscriptionsEnabled) {
        throw new AppError('precondition_failed', PLAN_ADD_ONS_UNAVAILABLE_TEXT.not_offered);
      }
      const wanted = parseInput(chooseSchema, input);
      return db.run(ctx.scope, async (tx) => {
        await lockAllLimits(tx, ctx.tenant.id);
        const chosen = await tx.execute<{
          result: 'chosen' | 'unchanged';
          previous_extra_seats: number;
          previous_extra_numbers: number;
          previous_run_packs: number;
        }>(
          sql`select * from app.choose_add_ons(${wanted.extraSeats}::integer, ${wanted.extraNumbers}::integer, ${wanted.runPacks}::integer)`,
        );
        const outcome = chosen.rows[0];
        if (!outcome) throw new Error('app.choose_add_ons returned nothing');
        const [state] = await tx
          .select()
          .from(tenantPlans)
          .where(eq(tenantPlans.tenantId, ctx.tenant.id));
        const [version] = state?.planId
          ? await tx.select().from(plans).where(eq(plans.id, state.planId))
          : [];
        const [settings] = await tx.select({ taxBp: planSettings.planTaxBp }).from(planSettings);
        if (!state || !version) throw new Error('The plan state or its version is missing');
        const priced =
          settings?.taxBp === null || settings?.taxBp === undefined
            ? null
            : planPaymentQuote(version, state, settings.taxBp);
        const quote = priced?.ok ? priced.quote : null;
        if (outcome.result === 'unchanged') return { changed: false, quote };
        // Add-ons the company could not pay for are refused as paying for them would be (ADR-063).
        if (priced && !priced.ok) {
          throw new AppError(
            'precondition_failed',
            'With these add-ons your plan costs more than can be paid here. Choose fewer, or ask HyFib to change your plan.',
          );
        }

        // A decrease cannot leave fewer seats or numbers than the company uses; an increase can
        // still leave it over the limit.
        const now = clock.now();
        const over: string[] = [];
        if (state.extraSeats < outcome.previous_extra_seats) {
          const limit = version.seatsIncluded + state.extraSeats;
          const used = await seatsInUse(tx, ctx.tenant.id, now);
          if (used > limit) over.push(planShortfallText({ kind: 'seats', limit, used }));
        }
        if (state.extraNumbers < outcome.previous_extra_numbers) {
          const limit = version.numbersIncluded + state.extraNumbers;
          const used = await numbersInUse(tx, ctx.tenant.id);
          if (used > limit) over.push(planShortfallText({ kind: 'numbers', limit, used }));
        }
        if (over.length > 0) {
          throw new AppError(
            'precondition_failed',
            `With these add-ons your plan holds ${over.join('; ')}. Free some first, or keep more add-ons.`,
          );
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'billing.add_ons_chosen',
            subjectType: 'tenant_plan',
            subjectId: state.id,
            metadata: {
              planId: version.id,
              planStatus: state.status,
              previous: {
                extraSeats: outcome.previous_extra_seats,
                extraNumbers: outcome.previous_extra_numbers,
                runPacks: outcome.previous_run_packs,
              },
              extraSeats: state.extraSeats,
              extraNumbers: state.extraNumbers,
              runPacks: state.runPacks,
            },
          },
          meta,
        );
        return { changed: true, quote };
      });
    },
  };
}

export type PlanAddOnsService = ReturnType<typeof createPlanAddOnsService>;
