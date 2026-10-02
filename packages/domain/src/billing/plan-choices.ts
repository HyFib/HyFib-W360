import { z } from 'zod';
import { AppError, type Clock } from '@w360/core';
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
  sql,
  tenantPlans,
  tenants,
  type ApiScope,
  type Database,
  type PlanModule,
  type TenantPlanStatus,
  type Tx,
} from '@w360/db';
import { recordAudit, type RequestMeta } from '../audit';
import { assertCan, type TenantContext } from '../authz/context';
import { assertRecentSignIn } from '../authz/step-up';
import {
  liveAutomationsInUse,
  loadEntitlements,
  lockAllLimits,
  numbersInUse,
  seatsInUse,
  teamsInUse,
} from '../plans/entitlements';
import {
  PLAN_MODULE_KEYS,
  planPaymentQuote,
  planShortfallText,
  planShortfalls,
  versionHoldingLimits,
  type PlanHoldings,
  type PlanPaymentQuote,
  type PlanPaymentQuoteResult,
  type PlanShortfall,
} from '../plans/model';
import { parseInput } from '../validation';

/**
 * Choosing the plan a company pays for (ADR-105): the published versions platform owners offer,
 * what each would cost the company with its add-ons and whether it holds what the company has, and
 * the choice itself, which `app.choose_plan` checks again in SQL. The company then pays for the
 * chosen version as before (ADR-063).
 */

/** Why the company cannot choose a plan now. */
export type PlanChoiceUnavailable =
  | 'not_offered'
  | 'deleting'
  | 'suspended'
  | 'complimentary'
  | 'payment_started'
  | 'paying_from_trial_end'
  | 'subscribed'
  | 'paid_period';

export const PLAN_CHOICE_UNAVAILABLE_TEXT: Record<PlanChoiceUnavailable, string> = {
  not_offered: 'Choosing a plan here is not available yet. Ask HyFib to change your plan.',
  deleting: 'Your company is being deleted, so its plan cannot change.',
  suspended: 'Your company is suspended, so its plan cannot change.',
  complimentary: 'Your company has complimentary access, so there is no plan to choose.',
  payment_started:
    'A payment for your plan is being started. Finish it under Paying for your plan, or wait an hour for its window to close, before choosing another plan.',
  paying_from_trial_end:
    'Your company pays for its plan from the end of the trial. Cancel that payment under Paying for your plan to choose another plan; the trial goes on.',
  subscribed:
    'Your company pays for its plan by subscription. Changing a plan that is being paid for is not available here yet; ask HyFib.',
  paid_period:
    'Your plan has a paid period. You can choose a plan once it ends, or ask HyFib to change it.',
};

/**
 * Whether a company may change its plan or its add-ons now (ADR-105, ADR-106): null when it may,
 * otherwise why not. `app.choose_plan` and `app.choose_add_ons` check the same in SQL.
 */
export function planChangeUnavailable(facts: {
  companyStatus: string;
  planStatus: TenantPlanStatus;
  /** The company's subscription Razorpay may still charge, if any. */
  live: { status: string; startsAt: Date | null; paidCount: number } | undefined;
  subscriptionsEnabled: boolean;
  taxBp: number | null;
}): PlanChoiceUnavailable | null {
  const { companyStatus, planStatus, live } = facts;
  if (companyStatus === 'pending_deletion' || companyStatus === 'deleted') return 'deleting';
  if (companyStatus === 'suspended') return 'suspended';
  if (!facts.subscriptionsEnabled || facts.taxBp === null) return 'not_offered';
  if (planStatus === 'complimentary') return 'complimentary';
  if (live) {
    if (['creating', 'created'].includes(live.status)) return 'payment_started';
    return live.startsAt !== null && live.paidCount === 0 ? 'paying_from_trial_end' : 'subscribed';
  }
  if (planStatus === 'active') return 'paid_period';
  return null;
}

/** A plan version the company could choose, as the company sees it. */
export interface PlanChoice {
  id: string;
  name: string;
  description: string | null;
  priceMinor: number;
  intervalMonths: number;
  trialDays: number;
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
  /** What the company would pay each interval with its add-ons and the tax; null: no tax set. */
  quote: PlanPaymentQuoteResult | null;
  /** Limits that hold less than the company has now (it cannot choose the version then). */
  shortfalls: PlanShortfall[];
  /** The version the company is on. */
  current: boolean;
}

export interface PlanChoices {
  /** Null when the company can choose; otherwise why not. */
  unavailable: PlanChoiceUnavailable | null;
  status: TenantPlanStatus;
  trialEndsAt: Date | null;
  /** The version the company is on, offered or not. */
  currentPlan: { id: string; name: string } | null;
  addOns: { extraSeats: number; extraNumbers: number; runPacks: number };
  holdings: PlanHoldings;
  /** Offered versions, cheapest first. */
  choices: PlanChoice[];
}

export interface PlanChoicesServiceDeps {
  db: Database;
  clock: Clock;
  /** Razorpay subscriptions are on, so a chosen plan can be paid for (ADR-063). */
  subscriptionsEnabled: boolean;
}

const chooseSchema = z.object({ planId: z.uuid('Choose a plan.') });

/** Why a version cannot be paid for with the company's add-ons and the tax, after its name. */
const UNPAYABLE_TEXT: Record<Extract<PlanPaymentQuoteResult, { ok: false }>['reason'], string> = {
  add_on_not_sold: 'does not sell your add-ons',
  too_small: 'costs less than can be paid here',
  too_large: 'costs more than can be paid here with your add-ons and the tax',
};

async function holdingsOf(tx: Tx, tenantId: string, now: Date): Promise<PlanHoldings> {
  return {
    seats: await seatsInUse(tx, tenantId, now),
    numbers: await numbersInUse(tx, tenantId),
    teams: await teamsInUse(tx, tenantId),
    liveAutomations: await liveAutomationsInUse(tx, tenantId),
  };
}

export function createPlanChoicesService(deps: PlanChoicesServiceDeps) {
  const { db, clock } = deps;

  return {
    /** The offered versions and whether the company can choose one now (`billing.read`). */
    async choices(ctx: TenantContext): Promise<PlanChoices> {
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
          const [current] = state.planId
            ? await tx
                .select({ id: plans.id, name: plans.name })
                .from(plans)
                .where(eq(plans.id, state.planId))
            : [];
          const offered = await tx
            .select()
            .from(plans)
            .where(and(eq(plans.status, 'published'), isNotNull(plans.offeredAt)))
            .orderBy(asc(plans.priceMinor), asc(plans.name), asc(plans.id));
          const holdings = await holdingsOf(tx, ctx.tenant.id, now);

          const unavailable = planChangeUnavailable({
            companyStatus: company.status,
            planStatus: state.status,
            live,
            subscriptionsEnabled: deps.subscriptionsEnabled,
            taxBp,
          });

          const addOns = {
            extraSeats: state.extraSeats,
            extraNumbers: state.extraNumbers,
            runPacks: state.runPacks,
          };
          return {
            unavailable,
            status: state.status,
            trialEndsAt: state.trialEndsAt,
            currentPlan: current ?? null,
            addOns,
            holdings,
            choices: offered.map((p) => ({
              id: p.id,
              name: p.name,
              description: p.description,
              priceMinor: p.priceMinor,
              intervalMonths: p.intervalMonths,
              trialDays: p.trialDays,
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
              quote: taxBp === null ? null : planPaymentQuote(p, addOns, taxBp),
              shortfalls: planShortfalls(versionHoldingLimits(p, addOns), holdings),
              current: p.id === state.planId,
            })),
          };
        },
        { accessMode: 'read only' },
      );
    },

    /**
     * Puts the company on an offered version (`billing.manage` and a recent sign-in). The version
     * must hold what the company has: the limits' locks are taken first, so no addition slips in
     * between the count and the commit.
     */
    async choose(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<{ changed: boolean; planName: string; quote: PlanPaymentQuote | null }> {
      assertCan(ctx, 'billing.manage');
      // Choosing a plan changes what the company pays (ADR-056).
      assertRecentSignIn(ctx, clock.now());
      if (!deps.subscriptionsEnabled) {
        throw new AppError('precondition_failed', PLAN_CHOICE_UNAVAILABLE_TEXT.not_offered);
      }
      const { planId } = parseInput(chooseSchema, input);
      return db.run(ctx.scope, async (tx) => {
        await lockAllLimits(tx, ctx.tenant.id);
        const chosen = await tx.execute<{
          result: 'chosen' | 'unchanged';
          previous_plan_id: string;
        }>(sql`select * from app.choose_plan(${planId}::uuid)`);
        const outcome = chosen.rows[0];
        if (!outcome) throw new Error('app.choose_plan returned nothing');
        const [plan] = await tx.select().from(plans).where(eq(plans.id, planId));
        const [state] = await tx
          .select()
          .from(tenantPlans)
          .where(eq(tenantPlans.tenantId, ctx.tenant.id));
        const [settings] = await tx.select({ taxBp: planSettings.planTaxBp }).from(planSettings);
        if (!plan || !state) throw new Error('The chosen plan or the plan state is missing');
        const priced =
          settings?.taxBp === null || settings?.taxBp === undefined
            ? null
            : planPaymentQuote(plan, state, settings.taxBp);
        const quote = priced?.ok ? priced.quote : null;
        if (outcome.result === 'unchanged') return { changed: false, planName: plan.name, quote };
        // A version the company could not pay for is refused as paying for it would be (ADR-063),
        // whatever the page showed when it was loaded (the tax may have changed since).
        if (priced && !priced.ok) {
          throw new AppError(
            'precondition_failed',
            `${plan.name} ${UNPAYABLE_TEXT[priced.reason]}. Choose another plan, or ask HyFib to change your plan.`,
          );
        }

        const { limits } = await loadEntitlements(tx, ctx.tenant.id);
        const shortfalls = planShortfalls(limits, await holdingsOf(tx, ctx.tenant.id, clock.now()));
        if (shortfalls.length > 0) {
          throw new AppError(
            'precondition_failed',
            `${plan.name} holds less than your company has now: ${shortfalls.map(planShortfallText).join('; ')}. Free some first, or choose a plan with more.`,
          );
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'billing.plan_chosen',
            subjectType: 'tenant_plan',
            subjectId: state.id,
            metadata: {
              previousPlanId: outcome.previous_plan_id,
              planId,
              planStatus: state.status,
            },
          },
          meta,
        );
        return { changed: true, planName: plan.name, quote };
      });
    },
  };
}

export type PlanChoicesService = ReturnType<typeof createPlanChoicesService>;
