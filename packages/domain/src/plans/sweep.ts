import type { Clock } from '@w360/core';
import {
  authorizedTenantScope,
  eq,
  plans,
  sql,
  systemScope,
  tenants,
  type Database,
  and,
  inArray,
  planSettings,
  planSubscriptions,
  tenantPlans,
  LIVE_PLAN_SUBSCRIPTION_STATUSES,
  type TenantPlanStatus,
  type TenantScope,
  type Tx,
  type UsageMetric,
} from '@w360/db';
import { notifyBillingManagers, type BillingNoticeDeps } from '../billing/notices';
import { loadEntitlements } from './entitlements';
import { usagePeriod, warningThreshold } from './model';

export interface PlanSweepDeps {
  db: Database;
  clock: Clock;
  notices: BillingNoticeDeps;
  /**
   * Plan subscriptions (ADR-063), when Razorpay is configured: the subscription that paid a period
   * is synced before the period is moved on, and `offered` says whether companies can pay for their
   * plan in billing (the emails then say so).
   */
  planPayments?: {
    offered: boolean;
    syncBeforeTransition: (scope: TenantScope) => Promise<void>;
  };
}

async function companyFacts(tx: Tx, tenantId: string, planId: string | null) {
  const [company] = await tx
    .select({ timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  const [plan] = planId
    ? await tx.select({ name: plans.name }).from(plans).where(eq(plans.id, planId))
    : [];
  const day = (at: Date) =>
    new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeZone: company?.timezone ?? 'Asia/Kolkata',
    }).format(at);
  return { planName: plan?.name ?? 'your', day };
}

/** Whether the subscription that paid the company's plan may still be charged (ADR-063). */
async function subscriptionLive(tx: Tx, tenantId: string): Promise<boolean> {
  const [linked] = await tx
    .select({ id: planSubscriptions.id })
    .from(tenantPlans)
    .innerJoin(
      planSubscriptions,
      and(
        eq(planSubscriptions.tenantId, tenantPlans.tenantId),
        eq(planSubscriptions.id, tenantPlans.subscriptionId),
      ),
    )
    .where(
      and(
        eq(tenantPlans.tenantId, tenantId),
        inArray(planSubscriptions.status, [...LIVE_PLAN_SUBSCRIPTION_STATUSES]),
      ),
    );
  return Boolean(linked);
}

/** Whether platform owners set the tax on plan prices (paying for plans needs it, ADR-063). */
async function planTaxSet(tx: Tx): Promise<boolean> {
  const [settings] = await tx.select({ planTaxBp: planSettings.planTaxBp }).from(planSettings);
  return settings?.planTaxBp !== null && settings?.planTaxBp !== undefined;
}

export interface PlanSweepResult {
  transitioned: number;
  announced: number;
  /** Companies whose work failed; it rolled back and is due again on the next sweep. */
  failed: { tenantId: string; error: unknown }[];
}

/**
 * The minute sweep's plan work (ADR-051): moves trials, paid periods and grace periods that have
 * ended to their next state (each in the company's own scope, recorded in its audit log, after
 * syncing the subscription that paid the period, ADR-063) and emails the company's billing
 * managers; then announces, once per month, automation run limits
 * and monthly API request limits (ADR-061) that were reached, and warns once when 80% of one is
 * used (ADR-062). One company's failure does not hold up the others.
 */
export async function sweepPlanStates(deps: PlanSweepDeps, limit = 200): Promise<PlanSweepResult> {
  const failed: PlanSweepResult['failed'] = [];
  const due = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ tenant_id: string }>(
        sql`select tenant_id from ops.plan_transitions_due(${limit}) as tenant_id`,
      ),
    { accessMode: 'read only' },
  );
  let transitioned = 0;
  for (const { tenant_id: tenantId } of due.rows) {
    const scope = authorizedTenantScope(tenantId, null);
    if (deps.planPayments) {
      // A renewal Razorpay charged counts before the period ends; when Razorpay cannot answer,
      // the company waits for the next sweep instead of losing a period it may have paid for.
      const synced = await deps.planPayments.syncBeforeTransition(scope).then(
        () => true,
        (error: unknown) => {
          failed.push({ tenantId, error });
          return false;
        },
      );
      if (!synced) continue;
    }
    const moved = await deps.db
      .run(scope, async (tx) => {
        const res = await tx.execute<{
          previous_status: TenantPlanStatus;
          new_status: TenantPlanStatus;
          plan_id: string | null;
        }>(sql`select * from app.apply_plan_transition(${tenantId}::uuid)`);
        const row = res.rows[0];
        if (!row) return false;
        const { planName, day } = await companyFacts(tx, tenantId, row.plan_id);
        const now = deps.clock.now();
        const payHere = deps.planPayments?.offered === true && (await planTaxSet(tx));
        // A company still paying by subscription waits for Razorpay's next charge (ADR-063).
        const subscribed = await subscriptionLive(tx, tenantId);
        if (row.new_status === 'past_due') {
          const ent = await tx.execute<{ grace_ends_at: Date | string }>(
            sql`select grace_ends_at from app.tenant_plans where tenant_id = ${tenantId}::uuid`,
          );
          const graceEnds = ent.rows[0]?.grace_ends_at;
          await notifyBillingManagers(deps.notices, tx, scope, {
            subject: 'The paid period of your HyFib plan has ended',
            lines: subscribed
              ? [
                  `The paid period of the ${planName} plan ended on ${day(now)}, and Razorpay has not charged for the next one yet.`,
                  graceEnds
                    ? `Everything keeps working until ${day(new Date(graceEnds))}. The plan is paid again once a charge goes through; the payer can change the card through the link in Razorpay’s email.`
                    : 'The plan is paid again once a charge goes through; the payer can change the card through the link in Razorpay’s email.',
                ]
              : [
                  `The paid period of the ${planName} plan ended on ${day(now)}.`,
                  graceEnds
                    ? `Everything keeps working until ${day(new Date(graceEnds))}. ${payHere ? 'Pay for the plan in billing, or ask HyFib to renew it, before then.' : 'Ask HyFib to renew the plan before then.'}`
                    : payHere
                      ? 'Pay for the plan in billing, or ask HyFib to renew it.'
                      : 'Ask HyFib to renew the plan.',
                ],
          });
        } else {
          await notifyBillingManagers(deps.notices, tx, scope, {
            subject:
              row.previous_status === 'trialing'
                ? 'Your HyFib trial has ended'
                : 'Your HyFib plan has ended',
            lines: [
              row.previous_status === 'trialing'
                ? `The trial of the ${planName} plan ended on ${day(now)}.`
                : `The ${planName} plan ended on ${day(now)}.`,
              'Sending messages, campaigns and automations is paused. Your data is kept, and you can still review and export it.',
              subscribed
                ? 'The plan is paid again once a Razorpay charge goes through (the payer can change the card through the link in Razorpay’s email), or cancel the subscription in billing and pay again.'
                : payHere
                  ? 'Pay for the plan in billing, or ask HyFib to choose a plan, to continue.'
                  : 'Ask HyFib to choose a plan to continue.',
            ],
          });
        }
        return true;
      })
      .catch((error: unknown) => {
        failed.push({ tenantId, error });
        return false;
      });
    if (moved) transitioned += 1;
  }

  const reached = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ tenant_id: string; counter_id: string }>(
        sql`select tenant_id, counter_id from ops.usage_limits_reached(${limit})`,
      ),
    { accessMode: 'read only' },
  );
  let announced = 0;
  for (const { tenant_id: tenantId, counter_id: counterId } of reached.rows) {
    const sent = await announceRunLimit(deps, tenantId, counterId).catch((error: unknown) => {
      failed.push({ tenantId, error });
      return false;
    });
    if (sent) announced += 1;
  }

  const apiReached = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ tenant_id: string; counter_id: string }>(
        sql`select tenant_id, counter_id from ops.api_quota_reached(${limit})`,
      ),
    { accessMode: 'read only' },
  );
  for (const { tenant_id: tenantId, counter_id: counterId } of apiReached.rows) {
    const sent = await announceApiQuota(deps, tenantId, counterId).catch((error: unknown) => {
      failed.push({ tenantId, error });
      return false;
    });
    if (sent) announced += 1;
  }

  const warnings = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ tenant_id: string; counter_id: string }>(
        sql`select tenant_id, counter_id from ops.usage_warnings_due(${limit})`,
      ),
    { accessMode: 'read only' },
  );
  for (const { tenant_id: tenantId, counter_id: counterId } of warnings.rows) {
    const sent = await warnBeforeLimit(deps, tenantId, counterId).catch((error: unknown) => {
      failed.push({ tenantId, error });
      return false;
    });
    if (sent) announced += 1;
  }
  return { transitioned, announced, failed };
}

type UsageNotice = 'used_up' | 'warning';

/** A usage counter locked for a notice, with the company's current limit and usage period. */
interface NoticeCounter {
  metric: UsageMetric;
  used: number;
  /** The company's current limit for the counter's metric; null for none. */
  limit: number | null;
  planId: string | null;
  period: { start: Date; end: Date };
}

/**
 * Locks the counter while its notice is unsent, so only one of two sweeps that listed it sends the
 * notice, and returns it with the company's current limit and usage period; null when the notice
 * went out meanwhile. A counter of an earlier usage period is never current again, so it is marked
 * as done without an email (and null returned) instead of being listed every minute.
 */
async function lockForNotice(
  tx: Tx,
  now: Date,
  tenantId: string,
  counterId: string,
  notice: UsageNotice,
): Promise<NoticeCounter | null> {
  const unsent =
    notice === 'used_up'
      ? sql`notified_at is null`
      : sql`warned_at is null and notified_at is null`;
  const found = await tx.execute<{
    metric: UsageMetric;
    used: number;
    period_start: Date | string;
  }>(
    sql`select metric, used, period_start from app.usage_counters
         where tenant_id = ${tenantId}::uuid and id = ${counterId}::uuid and ${unsent}
         for update`,
  );
  const row = found.rows[0];
  if (!row) return null;
  const entitlements = await loadEntitlements(tx, tenantId);
  const period = usagePeriod(entitlements.usageAnchor, now);
  if (new Date(row.period_start).getTime() !== period.start.getTime()) {
    await markNoticeDone(tx, tenantId, counterId, notice);
    return null;
  }
  const limit =
    row.metric === 'automation_runs'
      ? entitlements.limits.automationRuns
      : entitlements.limits.apiRequests;
  return { metric: row.metric, used: row.used, limit, planId: entitlements.planId, period };
}

async function markNoticeDone(tx: Tx, tenantId: string, counterId: string, notice: UsageNotice) {
  await tx.execute(
    notice === 'used_up'
      ? sql`update app.usage_counters set notified_at = now()
             where tenant_id = ${tenantId}::uuid and id = ${counterId}::uuid`
      : sql`update app.usage_counters set warned_at = now()
             where tenant_id = ${tenantId}::uuid and id = ${counterId}::uuid`,
  );
}

/**
 * Emails the company's billing managers that its automation runs for the month are used up, once
 * per counter (see `lockForNotice`). A counter below the limit, because the limit was raised after
 * the sweep listed it, is left for a later sweep. Returns whether this call sent it.
 */
export async function announceRunLimit(
  deps: PlanSweepDeps,
  tenantId: string,
  counterId: string,
): Promise<boolean> {
  const scope = authorizedTenantScope(tenantId, null);
  return deps.db.run(scope, async (tx) => {
    const counter = await lockForNotice(tx, deps.clock.now(), tenantId, counterId, 'used_up');
    if (!counter || counter.limit === null || counter.used < counter.limit) return false;
    await markNoticeDone(tx, tenantId, counterId, 'used_up');
    const { planName, day } = await companyFacts(tx, tenantId, counter.planId);
    await notifyBillingManagers(deps.notices, tx, scope, {
      subject: "This month's automation runs are used up",
      lines: [
        `Your company used all ${counter.limit} automation runs of the ${planName} plan for this month.`,
        `Automations will not start again from customer messages, store events or the API until ${day(counter.period.end)}. Runs already in progress continue.`,
        'Ask HyFib for more automation runs or a larger plan.',
      ],
    });
    return true;
  });
}

/**
 * Emails the company's billing managers that its API requests for the month are used up (ADR-061),
 * once per counter, like the automation run notice. Returns whether this call sent it.
 */
export async function announceApiQuota(
  deps: PlanSweepDeps,
  tenantId: string,
  counterId: string,
): Promise<boolean> {
  const scope = authorizedTenantScope(tenantId, null);
  return deps.db.run(scope, async (tx) => {
    const counter = await lockForNotice(tx, deps.clock.now(), tenantId, counterId, 'used_up');
    if (!counter || counter.limit === null || counter.limit <= 0 || counter.used < counter.limit)
      return false;
    await markNoticeDone(tx, tenantId, counterId, 'used_up');
    const { planName, day } = await companyFacts(tx, tenantId, counter.planId);
    await notifyBillingManagers(deps.notices, tx, scope, {
      subject: "This month's API requests are used up",
      lines: [
        `Your company used all ${counter.limit.toLocaleString('en-IN')} API requests of the ${planName} plan for this month.`,
        `The public API refuses requests until ${day(counter.period.end)}. The app itself, automations and outgoing webhooks are not affected.`,
        'Ask HyFib for a larger plan.',
      ],
    });
    return true;
  });
}

/**
 * Warns the company's billing managers once that 80% of a monthly limit is used (ADR-062; see
 * `lockForNotice`). A counter outside the warning range under the current limit, because the limit
 * changed after the sweep listed it, is left for a later sweep. Returns whether this call sent it.
 */
export async function warnBeforeLimit(
  deps: PlanSweepDeps,
  tenantId: string,
  counterId: string,
): Promise<boolean> {
  const scope = authorizedTenantScope(tenantId, null);
  return deps.db.run(scope, async (tx) => {
    const counter = await lockForNotice(tx, deps.clock.now(), tenantId, counterId, 'warning');
    if (!counter) return false;
    const { limit, used, period } = counter;
    const threshold = warningThreshold(limit);
    if (limit === null || threshold === null || used < threshold || used >= limit) return false;
    await markNoticeDone(tx, tenantId, counterId, 'warning');
    const runs = counter.metric === 'automation_runs';
    const { planName, day } = await companyFacts(tx, tenantId, counter.planId);
    const count = (n: number) => n.toLocaleString('en-IN');
    await notifyBillingManagers(deps.notices, tx, scope, {
      subject: runs
        ? "This month's automation runs are nearly used up"
        : "This month's API requests are nearly used up",
      lines: runs
        ? [
            `Your company has used ${count(used)} of the ${count(limit)} automation runs of the ${planName} plan for this month.`,
            `At ${count(limit)}, automations stop starting from customer messages, store events and the API until ${day(period.end)}. Runs in progress continue.`,
            'Ask HyFib for more automation runs or a larger plan if you need them.',
          ]
        : [
            `Your company has used ${count(used)} of the ${count(limit)} API requests of the ${planName} plan for this month.`,
            `At ${count(limit)}, the public API refuses requests until ${day(period.end)}. The app itself is not affected.`,
            'Ask HyFib for a larger plan if you need more.',
          ],
    });
    return true;
  });
}
