import type { Clock } from '@w360/core';
import {
  eq,
  plans,
  tenantPlans,
  type Database,
  type PlanModule,
  type PlanStatus,
  type TenantPlanStatus,
  type Tx,
} from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
import {
  activeMemberCount,
  apiRequestsUsed,
  automationRunsUsed,
  liveAutomationsInUse,
  loadEntitlements,
  numbersInUse,
  teamsInUse,
  waitingInvitationCount,
} from './entitlements';
import { PLAN_MODULE_KEYS, usagePeriod, type PlanLimits } from './model';

/** What the company uses against its plan's limits (null limit: no limit). */
export interface PlanUsage {
  limits: PlanLimits;
  /** Active members and invitations still waiting (both hold a seat). */
  seats: { members: number; invitations: number };
  numbers: number;
  teams: number;
  liveAutomations: number;
  automationRuns: { used: number; periodStart: Date; periodEnd: Date };
  /** Public API requests counted this period (ADR-061), with or without a limit. */
  apiRequests: { used: number; periodStart: Date; periodEnd: Date };
}

/** The company's own view of its plan (ADR-051), shown on the Billing page. */
export interface CompanyPlanOverview {
  status: TenantPlanStatus;
  trialEndsAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  graceEndsAt: Date | null;
  plan: {
    name: string;
    description: string | null;
    status: PlanStatus;
    priceMinor: number;
    intervalMonths: number;
    graceDays: number;
    seatPriceMinor: number | null;
    numberPriceMinor: number | null;
    runPackSize: number | null;
    runPackPriceMinor: number | null;
  } | null;
  addOns: { extraSeats: number; extraNumbers: number; runPacks: number };
  modules: PlanModule[];
  usage: PlanUsage;
}

export interface PlansServiceDeps {
  db: Database;
  clock: Clock;
}

export function createPlansService(deps: PlansServiceDeps) {
  const { db, clock } = deps;

  async function usageIn(tx: Tx, tenantId: string): Promise<PlanUsage> {
    const now = clock.now();
    const entitlements = await loadEntitlements(tx, tenantId);
    const period = usagePeriod(entitlements.usageAnchor, now);
    return {
      limits: entitlements.limits,
      seats: {
        members: await activeMemberCount(tx, tenantId),
        invitations: await waitingInvitationCount(tx, tenantId, now),
      },
      numbers: await numbersInUse(tx, tenantId),
      teams: await teamsInUse(tx, tenantId),
      liveAutomations: await liveAutomationsInUse(tx, tenantId),
      automationRuns: {
        used: await automationRunsUsed(tx, tenantId, entitlements, now),
        periodStart: period.start,
        periodEnd: period.end,
      },
      apiRequests: {
        used: await apiRequestsUsed(tx, tenantId, entitlements, now),
        periodStart: period.start,
        periodEnd: period.end,
      },
    };
  }

  return {
    /**
     * Counts against the plan's limits, for the hints beside the forms that add members, numbers,
     * teams and automations. Any member may see them (counts only).
     */
    async usage(ctx: TenantContext): Promise<PlanUsage> {
      assertCan(ctx, 'tenant.read');
      return db.run(ctx.scope, (tx) => usageIn(tx, ctx.tenant.id), { accessMode: 'read only' });
    },

    /** The plan, its state, its price and add-ons, and usage (`billing.read`). */
    async overview(ctx: TenantContext): Promise<CompanyPlanOverview> {
      assertCan(ctx, 'billing.read');
      return db.run(
        ctx.scope,
        async (tx) => {
          const [state] = await tx
            .select()
            .from(tenantPlans)
            .where(eq(tenantPlans.tenantId, ctx.tenant.id));
          if (!state) throw new Error('The company has no plan state');
          const [plan] = state.planId
            ? await tx
                .select({
                  name: plans.name,
                  description: plans.description,
                  status: plans.status,
                  priceMinor: plans.priceMinor,
                  intervalMonths: plans.intervalMonths,
                  graceDays: plans.graceDays,
                  seatPriceMinor: plans.seatPriceMinor,
                  numberPriceMinor: plans.numberPriceMinor,
                  runPackSize: plans.runPackSize,
                  runPackPriceMinor: plans.runPackPriceMinor,
                  modules: plans.modules,
                })
                .from(plans)
                .where(eq(plans.id, state.planId))
            : [];
          const usage = await usageIn(tx, ctx.tenant.id);
          const { modules, ...planDetails } = plan ?? { modules: [...PLAN_MODULE_KEYS] };
          return {
            status: state.status,
            trialEndsAt: state.trialEndsAt,
            periodStart: state.periodStart,
            periodEnd: state.periodEnd,
            graceEndsAt: state.graceEndsAt,
            plan: plan ? (planDetails as NonNullable<CompanyPlanOverview['plan']>) : null,
            addOns: {
              extraSeats: state.extraSeats,
              extraNumbers: state.extraNumbers,
              runPacks: state.runPacks,
            },
            modules: PLAN_MODULE_KEYS.filter((m) => modules.includes(m)),
            usage,
          };
        },
        { accessMode: 'read only' },
      );
    },
  };
}

export type PlansService = ReturnType<typeof createPlansService>;
