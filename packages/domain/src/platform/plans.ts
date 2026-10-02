import { z } from 'zod';
import {
  AppError,
  conflict,
  forbidden,
  notFound,
  parseMajorUnits,
  uuidv7,
  type Clock,
} from '@w360/core';
import {
  and,
  asc,
  auditEvents,
  desc,
  eq,
  inArray,
  outerColumn,
  planPaymentRefunds,
  planPayments,
  planSettings,
  planSubscriptions,
  plans,
  platformAuditEvents,
  sql,
  tenantPlans,
  tenants,
  usageCounters,
  users,
  gt,
  or,
  LIVE_PLAN_SUBSCRIPTION_STATUSES,
  PLAN_MODULES,
  type PlanPaymentRefundOrigin,
  type PlanPaymentRefundStatus,
  type TenantPlanStatus,
} from '@w360/db';
import type { PlatformDatabase } from '@w360/db/platform';
import { API_SCOPE_KEYS } from '../api/model';
import type { RazorpayClient } from '../billing/razorpay';
import { parseLocalDateTime, resolveLocalTime } from '../campaigns/schedule';
import { parseAmountToMinor } from '../crm/money';
import { loadEntitlements } from '../plans/entitlements';
import {
  ASSIGNABLE_PLAN_STATES,
  PLAN_BOUNDS,
  PLAN_MODULE_KEYS,
  PLAN_PAYMENT_MIN_MINOR,
  PLAN_TAX_MAX_BP,
  usagePeriod,
} from '../plans/model';
import { parseInput } from '../validation';
import type { PlatformActor } from './service';

/**
 * Plans (P5-01, ADR-051), platform side. Platform owners keep the catalog: plan versions are drafts
 * until published, published versions never change (a change is a new version) and retire when no
 * longer offered; one published version with trial days may be the default trial for new
 * companies. Platform staff (owners and operators) put companies on plans. Every change is written
 * to the platform audit log, and changes to a company's plan to the company's own log too.
 * Companies may pay for their plan through a Razorpay subscription (ADR-063): platform owners set
 * the tax on plan prices and can cancel a company's subscription; staff plan changes wait until a
 * company has no subscription that can still be charged.
 */

const DAY_MS = 86_400_000;

const blank = (v: unknown) =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

const toNumber = (v: unknown) => (typeof v === 'string' ? Number(v.trim()) : v);

/** A whole number within bounds (form text or a number). */
const whole = (min: number, max: number, message: string) =>
  z.preprocess(
    (v) => (blank(v) ? undefined : toNumber(v)),
    z.number({ error: message }).int(message).min(min, message).max(max, message),
  );

/** Like `whole`, but empty means none (no limit, or not sold). */
const optionalWhole = (min: number, max: number, message: string) =>
  z.preprocess(
    (v) => (blank(v) ? null : toNumber(v)),
    z.number({ error: message }).int(message).min(min, message).max(max, message).nullable(),
  );

/** Zero when empty. */
const quantity = (max: number, message: string) =>
  z.preprocess(
    (v) => (blank(v) ? 0 : toNumber(v)),
    z.number({ error: message }).int(message).min(0, message).max(max, message),
  );

/** Rupees as typed ("2999", "2,999.50") into paise, exactly. */
const rupees = (message: string) =>
  z.preprocess(
    (v) => (blank(v) ? '' : String(v)),
    z.string().transform((text, ctx) => {
      const minor = parseAmountToMinor(text, 'INR');
      if (minor === null || minor > PLAN_BOUNDS.priceMinor) {
        ctx.addIssue({ code: 'custom', message });
        return z.NEVER;
      }
      return minor;
    }),
  );

const optionalRupees = (message: string) =>
  z.preprocess(
    (v) => (blank(v) ? null : String(v)),
    z
      .string()
      .nullable()
      .transform((text, ctx) => {
        if (text === null) return null;
        const minor = parseAmountToMinor(text, 'INR');
        if (minor === null || minor > PLAN_BOUNDS.priceMinor) {
          ctx.addIssue({ code: 'custom', message });
          return z.NEVER;
        }
        return minor;
      }),
  );

const planFieldsSchema = z
  .object({
    name: z
      .string({ error: 'Enter a name' })
      .trim()
      .min(1, 'Enter a name')
      .max(80, 'Keep the name under 80 characters'),
    description: z
      .string()
      .trim()
      .max(500, 'Keep the description under 500 characters')
      .optional()
      .transform((v) => v || null),
    price: rupees('Enter the price in rupees, like 2999 or 2999.50'),
    intervalMonths: z.preprocess(
      toNumber,
      z.union([z.literal(1), z.literal(3), z.literal(12)], {
        error: 'Choose how often the price is paid',
      }),
    ),
    trialDays: whole(0, PLAN_BOUNDS.trialDays, 'Trial days are a whole number from 0 to 90'),
    graceDays: whole(0, PLAN_BOUNDS.graceDays, 'Grace days are a whole number from 0 to 30'),
    seatsIncluded: whole(
      1,
      PLAN_BOUNDS.seats,
      'Seats included are a whole number from 1 to 10,000',
    ),
    seatPrice: optionalRupees('Enter the price of an extra seat in rupees, or leave it empty'),
    seatsMax: optionalWhole(1, PLAN_BOUNDS.seats, 'The most seats are a whole number up to 10,000'),
    numbersIncluded: whole(
      1,
      PLAN_BOUNDS.numbers,
      'WhatsApp numbers included are a whole number from 1 to 100',
    ),
    numberPrice: optionalRupees('Enter the price of an extra number in rupees, or leave it empty'),
    numbersMax: optionalWhole(
      1,
      PLAN_BOUNDS.numbers,
      'The most WhatsApp numbers are a whole number up to 100',
    ),
    teamsMax: optionalWhole(0, PLAN_BOUNDS.teams, 'Teams are a whole number up to 10,000'),
    liveAutomationsMax: optionalWhole(
      0,
      PLAN_BOUNDS.liveAutomations,
      'Live automations are a whole number up to 10,000',
    ),
    automationRunsMonthly: optionalWhole(
      0,
      PLAN_BOUNDS.automationRuns,
      'Automation runs are a whole number up to 100,000,000',
    ),
    runPackSize: optionalWhole(
      1,
      PLAN_BOUNDS.runPackSize,
      'A run pack is a whole number of runs up to 10,000,000',
    ),
    runPackPrice: optionalRupees('Enter the price of a run pack in rupees, or leave it empty'),
    apiRequestsMonthly: optionalWhole(
      0,
      PLAN_BOUNDS.apiRequests,
      'API requests are a whole number up to 1,000,000,000',
    ),
    // Every API scope, including scopes added later, or the scopes chosen (ADR-092).
    apiScopeChoice: z
      .enum(['all', 'chosen'], { error: 'Choose which API scopes the plan includes' })
      .default('all'),
    apiScopes: z
      .preprocess(
        (v) => (v === undefined || v === null ? [] : typeof v === 'string' ? [v] : v),
        z.array(z.enum(API_SCOPE_KEYS, { error: 'Choose API scopes from the list' })),
      )
      .transform((chosen) => API_SCOPE_KEYS.filter((s) => chosen.includes(s))),
    modules: z
      .preprocess(
        (v) => (v === undefined || v === null ? [] : typeof v === 'string' ? [v] : v),
        z.array(z.enum(PLAN_MODULES, { error: 'Choose modules from the list' })),
      )
      .transform((chosen) => PLAN_MODULE_KEYS.filter((m) => chosen.includes(m))),
  })
  .superRefine((d, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (d.seatsMax !== null && d.seatPrice === null)
      issue('seatsMax', 'Set a price for extra seats, or leave the most seats empty');
    if (d.seatsMax !== null && d.seatsMax < d.seatsIncluded)
      issue('seatsMax', 'The most seats cannot be fewer than the seats included');
    if (d.numbersMax !== null && d.numberPrice === null)
      issue('numbersMax', 'Set a price for extra numbers, or leave the most numbers empty');
    if (d.numbersMax !== null && d.numbersMax < d.numbersIncluded)
      issue('numbersMax', 'The most WhatsApp numbers cannot be fewer than the numbers included');
    if ((d.runPackSize === null) !== (d.runPackPrice === null))
      issue('runPackSize', 'Give both the size and the price of a run pack, or neither');
    if (d.runPackSize !== null && d.automationRunsMonthly === null)
      issue('runPackSize', 'Run packs need a monthly automation run limit');
    if (d.apiScopeChoice === 'chosen' && d.apiRequestsMonthly !== 0 && d.apiScopes.length === 0)
      issue('apiScopes', 'Choose at least one API scope, or include every scope');
  });

type PlanFields = z.infer<typeof planFieldsSchema>;

const createPlanSchema = z.intersection(
  z.object({
    code: z
      .string({ error: 'Enter a code' })
      .trim()
      .toLowerCase()
      .regex(
        /^[a-z][a-z0-9-]{1,39}$/,
        'Use 2 to 40 lowercase letters, digits and hyphens, starting with a letter',
      ),
  }),
  planFieldsSchema,
);

const reasonSchema = z.object({
  reason: z
    .string({ error: 'Give a reason of at least 10 characters' })
    .trim()
    .min(10, 'Give a reason of at least 10 characters')
    .max(500, 'Keep the reason under 500 characters'),
});

const defaultTrialSchema = z.object({
  planId: z.preprocess((v) => (blank(v) ? null : v), z.uuid('Choose a plan').nullable()),
});

/** A percentage as typed ("18", "12.5") in basis points, exactly; empty: not set. */
const taxPercent = z.preprocess(
  (v) => (blank(v) ? null : String(v).trim()),
  z
    .string()
    .nullable()
    .transform((text, ctx) => {
      if (text === null) return null;
      const match = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(text);
      const bp = match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : NaN;
      if (!Number.isInteger(bp) || bp > PLAN_TAX_MAX_BP) {
        ctx.addIssue({ code: 'custom', message: 'Enter the tax as a percentage from 0 to 50' });
        return z.NEVER;
      }
      return bp;
    }),
);

const planTaxSchema = z.object({ tax: taxPercent }).and(reasonSchema);

const cancelSubscriptionSchema = z.object({ tenantId: z.uuid() }).and(reasonSchema);

const planPaymentRefundSchema = z.object({
  tenantId: z.uuid(),
  planPaymentId: z.uuid(),
  amount: z.string().trim().min(1, 'Enter the amount to refund.').max(20),
  reason: z
    .string()
    .trim()
    .min(10, 'Give a reason of at least 10 characters.')
    .max(2000, 'Keep the reason under 2,000 characters.'),
});

const day = z.preprocess(
  (v) => (blank(v) ? null : v),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date')
    .nullable(),
);

const tenantPlanSchema = z
  .object({
    tenantId: z.uuid(),
    version: z.coerce.number().int().min(1),
    status: z.enum(ASSIGNABLE_PLAN_STATES, { error: 'Choose what the company gets' }),
    planId: z.preprocess((v) => (blank(v) ? null : v), z.uuid('Choose a plan').nullable()),
    trialEndsOn: day,
    periodStart: day,
    periodEnd: day,
    extraSeats: quantity(PLAN_BOUNDS.addOnUnits, 'Extra seats are a whole number up to 10,000'),
    extraNumbers: quantity(PLAN_BOUNDS.numbers, 'Extra numbers are a whole number up to 100'),
    runPacks: quantity(PLAN_BOUNDS.addOnUnits, 'Run packs are a whole number up to 10,000'),
  })
  .and(reasonSchema);

function planValues(d: PlanFields) {
  return {
    name: d.name,
    description: d.description,
    priceMinor: d.price,
    intervalMonths: d.intervalMonths,
    trialDays: d.trialDays,
    graceDays: d.graceDays,
    seatsIncluded: d.seatsIncluded,
    seatPriceMinor: d.seatPrice,
    seatsMax: d.seatsMax,
    numbersIncluded: d.numbersIncluded,
    numberPriceMinor: d.numberPrice,
    numbersMax: d.numbersMax,
    teamsMax: d.teamsMax,
    liveAutomationsMax: d.liveAutomationsMax,
    automationRunsMonthly: d.automationRunsMonthly,
    runPackSize: d.runPackSize,
    runPackPriceMinor: d.runPackPrice,
    apiRequestsMonthly: d.apiRequestsMonthly,
    // A plan without the API has no scopes to choose.
    apiScopes: d.apiRequestsMonthly === 0 || d.apiScopeChoice === 'all' ? null : d.apiScopes,
    modules: d.modules,
  };
}

function assertOwner(actor: PlatformActor): void {
  if (actor.role !== 'platform_owner')
    throw forbidden('Only platform owners can change plans and the default trial.');
}

const idOrNotFound = (id: string, what: string) => {
  if (!z.uuid().safeParse(id).success) throw notFound(what);
};

/** A plan payment on a company's platform page, with what was refunded of it (ADR-103). */
export interface PlatformPlanPayment {
  id: string;
  providerPaymentId: string;
  /** Razorpay's invoice id: the receipt number the company sees. */
  providerInvoiceId: string;
  amountMinor: number;
  periodStart: Date;
  periodEnd: Date;
  paidAt: Date;
  /** Refunds Razorpay processed. */
  refundedMinor: number;
  /** A refund asked for in HyFib that Razorpay has not finished. */
  openRefundMinor: number | null;
}

/** A refund of a plan payment, for platform staff (with the reason and who asked). */
export interface PlatformPlanPaymentRefund {
  id: string;
  planPaymentId: string;
  origin: PlanPaymentRefundOrigin;
  amountMinor: number;
  status: PlanPaymentRefundStatus;
  providerRefundId: string | null;
  lastError: string | null;
  reason: string | null;
  requestedByName: string | null;
  requestedAt: Date;
  processedAt: Date | null;
  failedAt: Date | null;
}

/**
 * The plan payments a platform owner can refund now and up to how much: what Razorpay has not
 * refunded yet, with no refund of the payment in progress (ADR-103). The request checks it again.
 */
export function refundablePlanPayments(payments: readonly PlatformPlanPayment[]) {
  return payments
    .filter((p) => p.openRefundMinor === null && p.amountMinor > p.refundedMinor)
    .map((p) => ({ ...p, maxMinor: p.amountMinor - p.refundedMinor }));
}

export function createPlanAdminService(deps: {
  platformDb: PlatformDatabase;
  clock: Clock;
  /** HyFib's Razorpay account, for cancelling companies' plan subscriptions (ADR-063). */
  razorpay?: RazorpayClient | null;
}) {
  const { platformDb, clock } = deps;

  const audit = (
    actor: PlatformActor,
    action: string,
    metadata: Record<string, unknown>,
    reason: string | null = null,
    targetTenantId: string | null = null,
  ) => ({
    id: uuidv7(),
    actorUserId: actor.userId,
    action,
    targetTenantId,
    reason,
    result: 'success' as const,
    correlationId: actor.correlationId,
    metadata,
  });

  return {
    /** Every version of every plan, with the companies on each, and the default trial. */
    async listPlans(actor: PlatformActor) {
      return platformDb.run(actor.userId, async (tx) => {
        const rows = await tx
          .select({
            id: plans.id,
            code: plans.code,
            version: plans.version,
            name: plans.name,
            status: plans.status,
            priceMinor: plans.priceMinor,
            intervalMonths: plans.intervalMonths,
            trialDays: plans.trialDays,
            seatsIncluded: plans.seatsIncluded,
            numbersIncluded: plans.numbersIncluded,
            modules: plans.modules,
            createdAt: plans.createdAt,
            offeredAt: plans.offeredAt,
            companies: sql<number>`(select count(*)::int from app.tenant_plans tp where tp.plan_id = ${outerColumn(plans.id)})`,
          })
          .from(plans)
          .orderBy(asc(plans.code), desc(plans.version));
        const [settings] = await tx
          .select({
            defaultTrialPlanId: planSettings.defaultTrialPlanId,
            planTaxBp: planSettings.planTaxBp,
          })
          .from(planSettings);
        return {
          plans: rows,
          defaultTrialPlanId: settings?.defaultTrialPlanId ?? null,
          planTaxBp: settings?.planTaxBp ?? null,
        };
      });
    },

    /**
     * The tax added to plan prices when companies pay for their plan (ADR-063), in basis points;
     * none: companies cannot pay for plans in HyFib. A subscription keeps the rate it started with.
     */
    async setPlanTax(actor: PlatformActor, input: unknown): Promise<void> {
      if (actor.role !== 'platform_owner') {
        throw forbidden('Only platform owners can set the tax on plan prices.');
      }
      const { tax, reason } = parseInput(planTaxSchema, input);
      await platformDb.run(actor.userId, async (tx) => {
        const [settings] = await tx
          .select({ planTaxBp: planSettings.planTaxBp })
          .from(planSettings)
          .for('update');
        if ((settings?.planTaxBp ?? null) === tax) return;
        await tx
          .update(planSettings)
          .set({ planTaxBp: tax, updatedByUserId: actor.userId, updatedAt: clock.now() })
          .where(eq(planSettings.id, true));
        await tx
          .insert(platformAuditEvents)
          .values(
            audit(
              actor,
              'platform.plan_tax_set',
              { taxBp: tax, previousTaxBp: settings?.planTaxBp ?? null },
              reason,
            ),
          );
      });
    },

    /**
     * Refunds part or all of a plan payment (platform owners, ADR-103). It is recorded as asked for,
     * with the reason in the platform audit log, and the worker asks Razorpay. The plan and the
     * subscription do not change.
     */
    async requestPlanPaymentRefund(
      actor: PlatformActor,
      input: unknown,
    ): Promise<{ refundId: string }> {
      if (actor.role !== 'platform_owner') {
        throw forbidden('Only a platform owner can refund a plan payment.');
      }
      const data = parseInput(planPaymentRefundSchema, input);
      let amountMinor: number;
      try {
        amountMinor = Number(parseMajorUnits(data.amount, 'INR'));
      } catch {
        throw new AppError('validation_failed', 'Enter the amount in rupees, like 250 or 250.50.', {
          issues: [{ path: 'amount', message: 'Enter the amount in rupees' }],
        });
      }
      if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) {
        throw new AppError('validation_failed', 'Enter an amount above ₹0.', {
          issues: [{ path: 'amount', message: 'Enter an amount above ₹0' }],
        });
      }
      return platformDb.run(actor.userId, async (tx) => {
        const result = await tx.execute<{ id: string }>(
          sql`select ops.platform_request_plan_payment_refund(${data.tenantId}::uuid,
                ${data.planPaymentId}::uuid, ${amountMinor}::bigint, ${data.reason},
                ${actor.correlationId}) as id`,
        );
        const refundId = result.rows[0]?.id;
        if (!refundId) throw new Error('refund request returned no id');
        return { refundId };
      });
    },

    /**
     * Cancels a company's plan subscription at once (platform owners, with a reason), for example
     * before changing its plan: Razorpay first, then HyFib's record. The period already paid stands.
     */
    async cancelTenantSubscription(actor: PlatformActor, input: unknown): Promise<void> {
      if (actor.role !== 'platform_owner') {
        throw forbidden('Only platform owners can cancel a company’s subscription.');
      }
      const { tenantId, reason } = parseInput(cancelSubscriptionSchema, input);
      const [row] = await platformDb.run(actor.userId, (tx) =>
        tx
          .select()
          .from(planSubscriptions)
          .where(
            and(
              eq(planSubscriptions.tenantId, tenantId),
              inArray(planSubscriptions.status, [...LIVE_PLAN_SUBSCRIPTION_STATUSES]),
            ),
          ),
      );
      if (!row) throw notFound('Subscription');
      if (row.status === 'creating' || !row.providerSubscriptionId) {
        throw conflict('The company is starting a payment. Try again in a few minutes.');
      }
      if (!deps.razorpay) {
        throw new AppError('provider_unavailable', 'Razorpay is not configured on this platform.');
      }
      const res = await deps.razorpay.cancelSubscription(row.providerSubscriptionId, {
        cancelAtCycleEnd: false,
      });
      if (!res.ok) {
        if (res.kind !== 'permanent') {
          throw new AppError('provider_unavailable', 'Razorpay did not answer. Try again.');
        }
        throw new AppError(
          'precondition_failed',
          `Razorpay did not cancel the subscription: ${res.description} HyFib updates its record at its next check with Razorpay.`,
        );
      }
      await platformDb.run(actor.userId, async (tx) => {
        const now = clock.now();
        const updated = await tx
          .update(planSubscriptions)
          .set({
            status: 'cancelled',
            endedAt: now,
            cancelRequestedAt: now,
            cancelledByUserId: actor.userId,
            // The worker emails the company's billing managers about it (ADR-101).
            staffCancelNoticeDue: true,
          })
          .where(
            and(
              eq(planSubscriptions.tenantId, tenantId),
              eq(planSubscriptions.id, row.id),
              inArray(planSubscriptions.status, [...LIVE_PLAN_SUBSCRIPTION_STATUSES]),
            ),
          )
          .returning({ id: planSubscriptions.id });
        if (updated.length === 0) return;
        const metadata = { subscriptionId: row.id, previousStatus: row.status };
        await tx
          .insert(platformAuditEvents)
          .values(audit(actor, 'platform.plan_subscription_cancelled', metadata, reason, tenantId));
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId,
          actorType: 'platform_admin',
          actorId: actor.userId,
          action: 'platform.plan_subscription_cancelled',
          subjectType: 'plan_subscription',
          subjectId: row.id,
          result: 'success',
          correlationId: actor.correlationId,
          metadata: { reason, ...metadata },
        });
      });
    },

    async getPlan(actor: PlatformActor, id: string) {
      idOrNotFound(id, 'Plan');
      return platformDb.run(actor.userId, async (tx) => {
        const [plan] = await tx.select().from(plans).where(eq(plans.id, id));
        if (!plan) throw notFound('Plan');
        const versions = await tx
          .select({ id: plans.id, version: plans.version, status: plans.status })
          .from(plans)
          .where(eq(plans.code, plan.code))
          .orderBy(desc(plans.version));
        const [companies] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(tenantPlans)
          .where(eq(tenantPlans.planId, id));
        const [settings] = await tx
          .select({ defaultTrialPlanId: planSettings.defaultTrialPlanId })
          .from(planSettings);
        return {
          plan,
          versions,
          companies: companies?.n ?? 0,
          isDefaultTrial: settings?.defaultTrialPlanId === id,
        };
      });
    },

    /** Published versions, for putting a company on a plan. */
    async assignablePlans(actor: PlatformActor) {
      return platformDb.run(actor.userId, (tx) =>
        tx
          .select({
            id: plans.id,
            code: plans.code,
            version: plans.version,
            name: plans.name,
            status: plans.status,
            trialDays: plans.trialDays,
            priceMinor: plans.priceMinor,
            intervalMonths: plans.intervalMonths,
            seatPriceMinor: plans.seatPriceMinor,
            seatsIncluded: plans.seatsIncluded,
            seatsMax: plans.seatsMax,
            numberPriceMinor: plans.numberPriceMinor,
            numbersIncluded: plans.numbersIncluded,
            numbersMax: plans.numbersMax,
            runPackSize: plans.runPackSize,
          })
          .from(plans)
          .where(eq(plans.status, 'published'))
          .orderBy(asc(plans.name), desc(plans.version)),
      );
    },

    /** A new plan code, as version 1 (a draft). */
    async createPlan(actor: PlatformActor, input: unknown): Promise<{ id: string }> {
      assertOwner(actor);
      const data = parseInput(createPlanSchema, input);
      const id = uuidv7();
      await platformDb.run(actor.userId, async (tx) => {
        const [taken] = await tx
          .select({ id: plans.id })
          .from(plans)
          .where(eq(plans.code, data.code))
          .limit(1);
        if (taken)
          throw conflict('A plan with this code exists. Create a new version of it instead.');
        await tx.insert(plans).values({
          id,
          code: data.code,
          version: 1,
          ...planValues(data),
          createdByUserId: actor.userId,
        });
        await tx
          .insert(platformAuditEvents)
          .values(
            audit(actor, 'platform.plan_created', { planId: id, code: data.code, version: 1 }),
          );
      });
      return { id };
    },

    /** A new draft version of a plan, starting from the given version's terms. */
    async createVersion(actor: PlatformActor, fromPlanId: string): Promise<{ id: string }> {
      assertOwner(actor);
      idOrNotFound(fromPlanId, 'Plan');
      const id = uuidv7();
      await platformDb.run(actor.userId, async (tx) => {
        const [source] = await tx.select().from(plans).where(eq(plans.id, fromPlanId));
        if (!source) throw notFound('Plan');
        const versions = await tx
          .select({ version: plans.version, status: plans.status })
          .from(plans)
          .where(eq(plans.code, source.code))
          .for('update');
        const draft = versions.find((v) => v.status === 'draft');
        if (draft)
          throw conflict(
            `Version ${draft.version} of this plan is still a draft. Publish it or retire it first.`,
          );
        const version = Math.max(...versions.map((v) => v.version)) + 1;
        if (version > 10_000) throw conflict('This plan has too many versions.');
        await tx.insert(plans).values({
          id,
          code: source.code,
          version,
          name: source.name,
          description: source.description,
          priceMinor: source.priceMinor,
          intervalMonths: source.intervalMonths,
          trialDays: source.trialDays,
          graceDays: source.graceDays,
          seatsIncluded: source.seatsIncluded,
          seatPriceMinor: source.seatPriceMinor,
          seatsMax: source.seatsMax,
          numbersIncluded: source.numbersIncluded,
          numberPriceMinor: source.numberPriceMinor,
          numbersMax: source.numbersMax,
          teamsMax: source.teamsMax,
          liveAutomationsMax: source.liveAutomationsMax,
          automationRunsMonthly: source.automationRunsMonthly,
          runPackSize: source.runPackSize,
          runPackPriceMinor: source.runPackPriceMinor,
          apiRequestsMonthly: source.apiRequestsMonthly,
          apiScopes: source.apiScopes,
          modules: source.modules,
          createdByUserId: actor.userId,
        });
        await tx.insert(platformAuditEvents).values(
          audit(actor, 'platform.plan_version_created', {
            planId: id,
            code: source.code,
            version,
            fromPlanId,
          }),
        );
      });
      return { id };
    },

    async updateDraft(actor: PlatformActor, id: string, input: unknown): Promise<void> {
      assertOwner(actor);
      idOrNotFound(id, 'Plan');
      const data = parseInput(planFieldsSchema, input);
      await platformDb.run(actor.userId, async (tx) => {
        const [plan] = await tx
          .select({ status: plans.status })
          .from(plans)
          .where(eq(plans.id, id))
          .for('update');
        if (!plan) throw notFound('Plan');
        if (plan.status !== 'draft')
          throw conflict('A published plan version cannot change. Create a new version instead.');
        await tx.update(plans).set(planValues(data)).where(eq(plans.id, id));
        await tx
          .insert(platformAuditEvents)
          .values(audit(actor, 'platform.plan_updated', { planId: id }));
      });
    },

    /** Publishing makes the version assignable and fixes its terms for good. */
    async publishPlan(actor: PlatformActor, id: string): Promise<void> {
      assertOwner(actor);
      idOrNotFound(id, 'Plan');
      await platformDb.run(actor.userId, async (tx) => {
        const [plan] = await tx
          .select({ status: plans.status })
          .from(plans)
          .where(eq(plans.id, id))
          .for('update');
        if (!plan) throw notFound('Plan');
        if (plan.status !== 'draft') throw conflict('Only a draft can be published.');
        await tx
          .update(plans)
          .set({ status: 'published', publishedByUserId: actor.userId, publishedAt: clock.now() })
          .where(eq(plans.id, id));
        await tx
          .insert(platformAuditEvents)
          .values(audit(actor, 'platform.plan_published', { planId: id }));
      });
    },

    /**
     * Offers a published version to companies, which can then choose it to pay for (ADR-105). A
     * version priced under ₹1 is refused: it could never be paid.
     */
    async offerPlan(actor: PlatformActor, id: string): Promise<void> {
      assertOwner(actor);
      idOrNotFound(id, 'Plan');
      await platformDb.run(actor.userId, async (tx) => {
        const [plan] = await tx
          .select({
            status: plans.status,
            priceMinor: plans.priceMinor,
            offeredAt: plans.offeredAt,
          })
          .from(plans)
          .where(eq(plans.id, id))
          .for('update');
        if (!plan) throw notFound('Plan');
        if (plan.status !== 'published')
          throw new AppError('precondition_failed', 'Only a published version can be offered.');
        if (plan.priceMinor < PLAN_PAYMENT_MIN_MINOR)
          throw new AppError(
            'precondition_failed',
            'A version priced under ₹1 cannot be offered: companies could never pay for it.',
          );
        if (plan.offeredAt) return;
        await tx
          .update(plans)
          .set({ offeredAt: clock.now(), offeredByUserId: actor.userId })
          .where(eq(plans.id, id));
        await tx
          .insert(platformAuditEvents)
          .values(audit(actor, 'platform.plan_offered', { planId: id }));
      });
    },

    /** Stops offering a version: companies already on it keep it (ADR-105). */
    async withdrawPlanOffer(actor: PlatformActor, id: string): Promise<void> {
      assertOwner(actor);
      idOrNotFound(id, 'Plan');
      await platformDb.run(actor.userId, async (tx) => {
        const [plan] = await tx
          .select({ offeredAt: plans.offeredAt })
          .from(plans)
          .where(eq(plans.id, id))
          .for('update');
        if (!plan) throw notFound('Plan');
        if (!plan.offeredAt) return;
        await tx
          .update(plans)
          .set({ offeredAt: null, offeredByUserId: null })
          .where(eq(plans.id, id));
        await tx
          .insert(platformAuditEvents)
          .values(audit(actor, 'platform.plan_offer_withdrawn', { planId: id }));
      });
    },

    /**
     * No longer offered: companies already on the version keep it, but it cannot be assigned again.
     * Retiring a draft discards it.
     */
    async retirePlan(actor: PlatformActor, id: string, input: unknown): Promise<void> {
      assertOwner(actor);
      idOrNotFound(id, 'Plan');
      const { reason } = parseInput(reasonSchema, input);
      await platformDb.run(actor.userId, async (tx) => {
        const [settings] = await tx
          .select({ defaultTrialPlanId: planSettings.defaultTrialPlanId })
          .from(planSettings)
          .for('update');
        const [plan] = await tx
          .select({ status: plans.status })
          .from(plans)
          .where(eq(plans.id, id))
          .for('update');
        if (!plan) throw notFound('Plan');
        if (plan.status === 'retired') return;
        if (settings?.defaultTrialPlanId === id)
          throw new AppError(
            'precondition_failed',
            'This version is the default trial. Choose another default trial first.',
          );
        await tx
          .update(plans)
          .set({
            status: 'retired',
            retiredByUserId: actor.userId,
            retiredAt: clock.now(),
            // A retired version is no longer offered to companies (ADR-105).
            offeredAt: null,
            offeredByUserId: null,
          })
          .where(eq(plans.id, id));
        await tx
          .insert(platformAuditEvents)
          .values(
            audit(
              actor,
              'platform.plan_retired',
              { planId: id, wasDraft: plan.status === 'draft' },
              reason,
            ),
          );
      });
    },

    /** The version new companies start a trial of; none means new companies are complimentary. */
    async setDefaultTrial(actor: PlatformActor, input: unknown): Promise<void> {
      assertOwner(actor);
      const { planId } = parseInput(defaultTrialSchema, input);
      await platformDb.run(actor.userId, async (tx) => {
        // The settings row first, as retiring a version locks it.
        await tx.select({ id: planSettings.id }).from(planSettings).for('update');
        if (planId) {
          const [plan] = await tx
            .select({ status: plans.status, trialDays: plans.trialDays })
            .from(plans)
            .where(eq(plans.id, planId))
            .for('share');
          if (!plan) throw notFound('Plan');
          if (plan.status !== 'published' || plan.trialDays <= 0)
            throw new AppError(
              'precondition_failed',
              'The default trial must be a published plan version with trial days.',
            );
        }
        await tx
          .update(planSettings)
          .set({
            defaultTrialPlanId: planId,
            updatedByUserId: actor.userId,
            updatedAt: clock.now(),
          })
          .where(eq(planSettings.id, true));
        await tx
          .insert(platformAuditEvents)
          .values(audit(actor, 'platform.default_trial_set', { planId }));
      });
    },

    /** A company's plan state, its limits and what it uses (counts only). */
    async tenantPlan(actor: PlatformActor, tenantId: string) {
      idOrNotFound(tenantId, 'Company');
      return platformDb.run(actor.userId, async (tx) => {
        const [company] = await tx
          .select({ id: tenants.id, timezone: tenants.timezone })
          .from(tenants)
          .where(eq(tenants.id, tenantId));
        if (!company) throw notFound('Company');
        const [state] = await tx
          .select()
          .from(tenantPlans)
          .where(eq(tenantPlans.tenantId, tenantId));
        if (!state) throw new Error('The company has no plan state');
        const [plan] = state.planId
          ? await tx
              .select({
                id: plans.id,
                code: plans.code,
                version: plans.version,
                name: plans.name,
                status: plans.status,
                trialDays: plans.trialDays,
                priceMinor: plans.priceMinor,
                intervalMonths: plans.intervalMonths,
                seatPriceMinor: plans.seatPriceMinor,
                seatsIncluded: plans.seatsIncluded,
                seatsMax: plans.seatsMax,
                numberPriceMinor: plans.numberPriceMinor,
                numbersIncluded: plans.numbersIncluded,
                numbersMax: plans.numbersMax,
                runPackSize: plans.runPackSize,
              })
              .from(plans)
              .where(eq(plans.id, state.planId))
          : [];
        const entitlements = await loadEntitlements(tx, tenantId);
        const counts = await tx.execute<{
          active_members: number;
          pending_invitations: number;
          numbers: number;
          teams: number;
          live_automations: number;
        }>(sql`select * from ops.platform_tenant_usage(${tenantId}::uuid)`);
        const period = usagePeriod(state.usageAnchor, clock.now());
        const counters = await tx
          .select({ metric: usageCounters.metric, used: usageCounters.used })
          .from(usageCounters)
          .where(
            and(
              eq(usageCounters.tenantId, tenantId),
              inArray(usageCounters.metric, ['automation_runs', 'api_requests']),
              eq(usageCounters.periodStart, period.start),
            ),
          );
        const counted = (metric: string) => counters.find((c) => c.metric === metric)?.used ?? 0;
        const usage = counts.rows[0];
        const [subscription] = await tx
          .select({
            id: planSubscriptions.id,
            status: planSubscriptions.status,
            amountMinor: planSubscriptions.amountMinor,
            taxBp: planSubscriptions.taxBp,
            intervalMonths: planSubscriptions.intervalMonths,
            providerSubscriptionId: planSubscriptions.providerSubscriptionId,
            currentStart: planSubscriptions.currentStart,
            currentEnd: planSubscriptions.currentEnd,
            cancelAtPeriodEnd: planSubscriptions.cancelAtPeriodEnd,
            endedAt: planSubscriptions.endedAt,
            failureReason: planSubscriptions.failureReason,
            createdAt: planSubscriptions.createdAt,
            syncedAt: planSubscriptions.syncedAt,
            // The first charge, due at the trial's end (ADR-102).
            startsAt: planSubscriptions.startsAt,
            paidCount: planSubscriptions.paidCount,
          })
          .from(planSubscriptions)
          .where(
            and(
              eq(planSubscriptions.tenantId, tenantId),
              or(
                inArray(planSubscriptions.status, [...LIVE_PLAN_SUBSCRIPTION_STATUSES]),
                gt(planSubscriptions.paidCount, 0),
              ),
            ),
          )
          .orderBy(desc(planSubscriptions.createdAt))
          .limit(1);
        const paid = await tx
          .select({
            id: planPayments.id,
            providerPaymentId: planPayments.providerPaymentId,
            providerInvoiceId: planPayments.providerInvoiceId,
            amountMinor: planPayments.amountMinor,
            periodStart: planPayments.periodStart,
            periodEnd: planPayments.periodEnd,
            paidAt: planPayments.paidAt,
          })
          .from(planPayments)
          .where(eq(planPayments.tenantId, tenantId))
          .orderBy(desc(planPayments.paidAt))
          .limit(12);
        // What was refunded of each payment shown, and a refund in progress (ADR-103).
        const totals =
          paid.length === 0
            ? []
            : await tx
                .select({
                  planPaymentId: planPaymentRefunds.planPaymentId,
                  status: planPaymentRefunds.status,
                  amountMinor: planPaymentRefunds.amountMinor,
                })
                .from(planPaymentRefunds)
                .where(
                  and(
                    eq(planPaymentRefunds.tenantId, tenantId),
                    inArray(
                      planPaymentRefunds.planPaymentId,
                      paid.map((p) => p.id),
                    ),
                    inArray(planPaymentRefunds.status, ['requested', 'submitted', 'processed']),
                  ),
                );
        const payments: PlatformPlanPayment[] = paid.map((p) => {
          const own = totals.filter((t) => t.planPaymentId === p.id);
          const open = own.find((t) => t.status !== 'processed');
          return {
            ...p,
            refundedMinor: own
              .filter((t) => t.status === 'processed')
              .reduce((sum, t) => sum + t.amountMinor, 0),
            openRefundMinor: open ? open.amountMinor : null,
          };
        });
        const refunds: PlatformPlanPaymentRefund[] = await tx
          .select({
            id: planPaymentRefunds.id,
            planPaymentId: planPaymentRefunds.planPaymentId,
            origin: planPaymentRefunds.origin,
            amountMinor: planPaymentRefunds.amountMinor,
            status: planPaymentRefunds.status,
            providerRefundId: planPaymentRefunds.providerRefundId,
            lastError: planPaymentRefunds.lastError,
            reason: planPaymentRefunds.reason,
            requestedByName: users.name,
            requestedAt: planPaymentRefunds.requestedAt,
            processedAt: planPaymentRefunds.processedAt,
            failedAt: planPaymentRefunds.failedAt,
          })
          .from(planPaymentRefunds)
          .leftJoin(users, eq(users.id, planPaymentRefunds.requestedByUserId))
          .where(eq(planPaymentRefunds.tenantId, tenantId))
          .orderBy(desc(planPaymentRefunds.requestedAt), desc(planPaymentRefunds.id))
          .limit(50);
        return {
          timezone: company.timezone,
          state,
          subscription: subscription
            ? {
                ...subscription,
                live: (LIVE_PLAN_SUBSCRIPTION_STATUSES as readonly string[]).includes(
                  subscription.status,
                ),
              }
            : null,
          payments,
          refunds,
          plan: plan ?? null,
          limits: entitlements.limits,
          modules: PLAN_MODULE_KEYS.filter((m) => entitlements.modules.has(m)),
          apiScopes:
            entitlements.apiScopes === null
              ? null
              : API_SCOPE_KEYS.filter((s) => entitlements.apiScopes?.has(s)),
          usage: {
            members: Number(usage?.active_members ?? 0),
            invitations: Number(usage?.pending_invitations ?? 0),
            numbers: Number(usage?.numbers ?? 0),
            teams: Number(usage?.teams ?? 0),
            liveAutomations: Number(usage?.live_automations ?? 0),
            automationRuns: counted('automation_runs'),
            apiRequests: counted('api_requests'),
            periodStart: period.start,
            periodEnd: period.end,
          },
        };
      });
    },

    /**
     * Puts a company on a plan: complimentary (no plan, no limits), a trial of a published version
     * until a day, a paid period of one (from a day until a day, in the company's time zone), or
     * ends its plan (canceled, which restricts the company). Add-ons stay within what the version
     * sells. `version` is the plan state's version the form was built from.
     */
    async setTenantPlan(actor: PlatformActor, input: unknown): Promise<void> {
      const data = parseInput(tenantPlanSchema, input);
      const now = clock.now();
      await platformDb.run(actor.userId, async (tx) => {
        // The company row first, then its plan state: the order the plan sweep and status changes
        // lock them in.
        const [company] = await tx
          .select({ status: tenants.status, timezone: tenants.timezone })
          .from(tenants)
          .where(eq(tenants.id, data.tenantId))
          .for('update');
        if (!company) throw notFound('Company');
        if (company.status === 'pending_deletion' || company.status === 'deleted')
          throw new AppError('precondition_failed', 'Companies being deleted keep their plan.');
        const [current] = await tx
          .select()
          .from(tenantPlans)
          .where(eq(tenantPlans.tenantId, data.tenantId))
          .for('update');
        if (!current) throw new Error('The company has no plan state');
        if (current.version !== data.version)
          throw conflict('The plan changed while you were editing. Reload the page and try again.');
        const [subscribed] = await tx
          .select({ id: planSubscriptions.id })
          .from(planSubscriptions)
          .where(
            and(
              eq(planSubscriptions.tenantId, data.tenantId),
              inArray(planSubscriptions.status, [...LIVE_PLAN_SUBSCRIPTION_STATUSES]),
            ),
          );
        if (subscribed)
          throw new AppError(
            'precondition_failed',
            'The company pays for its plan by Razorpay subscription. Cancel the subscription first.',
          );

        const invalid = (message: string) => new AppError('validation_failed', message);
        let planId: string | null;
        switch (data.status) {
          case 'complimentary':
            planId = null;
            break;
          case 'canceled':
            if (!current.planId)
              throw new AppError(
                'precondition_failed',
                'A complimentary company has no plan to end. Suspend the company instead, or put it on a plan.',
              );
            planId = current.planId;
            break;
          default:
            if (!data.planId) throw invalid('Choose a plan.');
            planId = data.planId;
        }
        const [plan] = planId
          ? await tx.select().from(plans).where(eq(plans.id, planId)).for('share')
          : [];
        if (planId && !plan) throw notFound('Plan');
        if (
          plan &&
          (plan.status === 'draft' || (plan.status === 'retired' && plan.id !== current.planId))
        )
          throw new AppError(
            'precondition_failed',
            'Only a published plan version can be assigned.',
          );

        const startOf = (text: string) => {
          const local = parseLocalDateTime(`${text}T00:00`);
          if (!local) throw invalid('Enter a valid date.');
          return resolveLocalTime(local, company.timezone).instant;
        };
        let trialEndsAt: Date | null = null;
        let periodStart: Date | null = null;
        let periodEnd: Date | null = null;
        if (data.status === 'trialing') {
          if (!data.trialEndsOn) throw invalid('Enter the day the trial ends.');
          trialEndsAt = startOf(data.trialEndsOn);
          if (trialEndsAt <= now) throw invalid('The trial must end after today.');
          if (trialEndsAt.getTime() - now.getTime() > 366 * DAY_MS)
            throw invalid('A trial can last at most a year.');
        } else if (data.status === 'active') {
          if (!data.periodStart || !data.periodEnd)
            throw invalid('Enter the day the paid period starts and the day it ends.');
          periodStart = startOf(data.periodStart);
          periodEnd = startOf(data.periodEnd);
          if (periodEnd <= periodStart) throw invalid('The paid period must end after it starts.');
          if (periodEnd <= now) throw invalid('The paid period must end after today.');
          if (periodEnd.getTime() - periodStart.getTime() > 3 * 366 * DAY_MS)
            throw invalid('A paid period can last at most three years.');
          if (now.getTime() - periodStart.getTime() > 366 * DAY_MS)
            throw invalid('A paid period cannot start more than a year ago.');
        } else if (data.status === 'canceled') {
          // The trial or period that was ended stays on record.
          trialEndsAt = current.trialEndsAt;
          periodStart = current.periodStart;
          periodEnd = current.periodEnd;
        }

        const addOns = plan
          ? {
              extraSeats: data.extraSeats,
              extraNumbers: data.extraNumbers,
              runPacks: data.runPacks,
            }
          : { extraSeats: 0, extraNumbers: 0, runPacks: 0 };
        if (plan) {
          if (addOns.extraSeats > 0 && plan.seatPriceMinor === null)
            throw invalid('This plan does not sell extra seats.');
          if (plan.seatsMax !== null && plan.seatsIncluded + addOns.extraSeats > plan.seatsMax)
            throw invalid(`This plan allows at most ${plan.seatsMax} seats.`);
          if (addOns.extraNumbers > 0 && plan.numberPriceMinor === null)
            throw invalid('This plan does not sell extra WhatsApp numbers.');
          const numbersMax = plan.numbersMax ?? PLAN_BOUNDS.numbers;
          if (plan.numbersIncluded + addOns.extraNumbers > numbersMax)
            throw invalid(`This plan allows at most ${numbersMax} WhatsApp numbers.`);
          if (addOns.runPacks > 0 && plan.runPackSize === null)
            throw invalid('This plan does not sell automation run packs.');
        }

        // Monthly usage periods restart with a new trial or a new paid period, and continue
        // through a change of plan within the same period (ADR-051).
        let usageAnchor = current.usageAnchor;
        if (
          data.status === 'trialing' &&
          (current.status !== 'trialing' || current.planId !== planId)
        )
          usageAnchor = now;
        if (
          data.status === 'active' &&
          periodStart &&
          (!['active', 'past_due'].includes(current.status) ||
            current.periodStart?.getTime() !== periodStart.getTime())
        )
          usageAnchor = periodStart;

        const same =
          current.status === data.status &&
          current.planId === planId &&
          current.trialEndsAt?.getTime() === trialEndsAt?.getTime() &&
          current.periodStart?.getTime() === periodStart?.getTime() &&
          current.periodEnd?.getTime() === periodEnd?.getTime() &&
          current.extraSeats === addOns.extraSeats &&
          current.extraNumbers === addOns.extraNumbers &&
          current.runPacks === addOns.runPacks;
        if (same) return;

        await tx
          .update(tenantPlans)
          .set({
            planId,
            status: data.status,
            trialEndsAt,
            periodStart,
            periodEnd,
            graceEndsAt: null,
            ...addOns,
            usageAnchor,
            // A period staff set is not paid by a subscription (ADR-063).
            subscriptionId: null,
            note: data.reason,
            changedByUserId: actor.userId,
            changedAt: now,
            version: current.version + 1,
            // The worker emails the company's billing managers about this version (ADR-100).
            staffNoticeVersion: current.version + 1,
          })
          .where(eq(tenantPlans.id, current.id));

        const change = {
          previous: { status: current.status, planId: current.planId },
          status: data.status as TenantPlanStatus,
          planId,
          trialEndsAt: trialEndsAt?.toISOString() ?? null,
          periodStart: periodStart?.toISOString() ?? null,
          periodEnd: periodEnd?.toISOString() ?? null,
          ...addOns,
        };
        await tx
          .insert(platformAuditEvents)
          .values(audit(actor, 'platform.tenant_plan_changed', change, data.reason, data.tenantId));
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: data.tenantId,
          actorType: 'platform_admin',
          actorId: actor.userId,
          action: 'platform.tenant_plan_changed',
          subjectType: 'tenant_plan',
          subjectId: current.id,
          result: 'success',
          correlationId: actor.correlationId,
          metadata: { reason: data.reason, ...change },
        });
      });
    },
  };
}

export type PlanAdminService = ReturnType<typeof createPlanAdminService>;
