import { notFound, type Clock } from '@w360/core';
import {
  eq,
  plans,
  sql,
  tenantPlans,
  tenants,
  type ApiScope,
  type Database,
  type PlanModule,
  type PlanStatus,
  type TenantPlanStatus,
  type Tx,
} from '@w360/db';
import { API_SCOPE_KEYS } from '../api/model';
import { recordAudit, type RequestMeta } from '../audit';
import { assertCan, type TenantContext } from '../authz/context';
import { parseInput } from '../validation';
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
import { limitNotices, type LimitNotice } from './limit-notices';
import { PLAN_MODULE_KEYS, usagePeriod, type PlanAddOnQuantities, type PlanLimits } from './model';
import { loadUsageWarningPercent, usageWarningSchema } from './usage-warnings';

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
  /** The public API scopes the plan includes, in the list's order; null: every scope (ADR-092). */
  apiScopes: ApiScope[] | null;
}

/** The company's own view of its plan (ADR-051), shown on the Billing page. */
export interface CompanyPlanOverview {
  status: TenantPlanStatus;
  trialEndsAt: Date | null;
  /**
   * A trial that has ended while its subscription's first charge is due waits for that charge
   * until then (ADR-102); null otherwise.
   */
  trialWaitsUntil: Date | null;
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
    apiRequestPackSize: number | null;
    apiRequestPackPriceMinor: number | null;
  } | null;
  addOns: PlanAddOnQuantities;
  modules: PlanModule[];
  usage: PlanUsage;
  /** The share of a monthly limit at which the billing managers are warned (ADR-144). */
  usageWarningPercent: number;
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
    const included = entitlements.apiScopes;
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
      apiScopes: included === null ? null : API_SCOPE_KEYS.filter((s) => included.has(s)),
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

    /**
     * The notices of monthly limits nearly or fully used that this member sees on every page of
     * the company (ADR-140).
     */
    limitNotices(ctx: TenantContext): Promise<LimitNotice[]> {
      return limitNotices({ db, clock }, ctx);
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
                  apiRequestPackSize: plans.apiRequestPackSize,
                  apiRequestPackPriceMinor: plans.apiRequestPackPriceMinor,
                  modules: plans.modules,
                })
                .from(plans)
                .where(eq(plans.id, state.planId))
            : [];
          const usage = await usageIn(tx, ctx.tenant.id);
          const { modules, ...planDetails } = plan ?? { modules: [...PLAN_MODULE_KEYS] };
          let trialWaitsUntil: Date | null = null;
          if (
            state.status === 'trialing' &&
            state.trialEndsAt &&
            state.trialEndsAt <= clock.now()
          ) {
            const wait = await tx.execute<{ until: Date | string | null }>(
              sql`select app.trial_charge_wait_until(${ctx.tenant.id}::uuid) as until`,
            );
            const until = wait.rows[0]?.until ?? null;
            trialWaitsUntil = until === null ? null : new Date(until);
          }
          return {
            status: state.status,
            trialEndsAt: state.trialEndsAt,
            trialWaitsUntil,
            periodStart: state.periodStart,
            periodEnd: state.periodEnd,
            graceEndsAt: state.graceEndsAt,
            plan: plan ? (planDetails as NonNullable<CompanyPlanOverview['plan']>) : null,
            addOns: {
              extraSeats: state.extraSeats,
              extraNumbers: state.extraNumbers,
              runPacks: state.runPacks,
              apiRequestPacks: state.apiRequestPacks,
            },
            modules: PLAN_MODULE_KEYS.filter((m) => modules.includes(m)),
            usage,
            usageWarningPercent: await loadUsageWarningPercent(tx, ctx.tenant.id),
          };
        },
        { accessMode: 'read only' },
      );
    },

    /**
     * Chooses the share of a monthly limit at which the billing managers are emailed and members
     * who read billing see a notice (ADR-144); `billing.manage`, audited with the share before and
     * after. Choosing the share the company has changes nothing.
     */
    async setUsageWarningPercent(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta,
    ): Promise<{ percent: number; changed: boolean }> {
      assertCan(ctx, 'billing.manage');
      const { percent } = parseInput(usageWarningSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const [before] = await tx
          .select({ percent: tenants.usageWarningPercent })
          .from(tenants)
          .where(eq(tenants.id, ctx.tenant.id))
          .for('update');
        if (!before) throw notFound('Company');
        if (before.percent === percent) return { percent, changed: false };
        await tx
          .update(tenants)
          .set({ usageWarningPercent: percent, updatedAt: clock.now() })
          .where(eq(tenants.id, ctx.tenant.id));
        await recordAudit(
          tx,
          ctx,
          {
            action: 'billing.usage_warning_changed',
            subjectType: 'tenant',
            subjectId: ctx.tenant.id,
            metadata: { from: before.percent, to: percent },
          },
          meta,
        );
        return { percent, changed: true };
      });
    },
  };
}

export type PlansService = ReturnType<typeof createPlansService>;
