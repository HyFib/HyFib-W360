import {
  and,
  auditEvents,
  authorizedTenantScope,
  desc,
  eq,
  planSubscriptions,
  plans,
  sql,
  systemScope,
  tenantPlans,
  tenants,
  type Database,
  type TenantPlanStatus,
} from '@w360/db';
import { notifyBillingManagers, type BillingNoticeDeps } from '../billing/notices';
import { NOTICE_LINE_MAX, splitEmailText } from '../email/templates';
import { TENANT_PLAN_STATUS_LABELS } from './model';

/** The plan state staff set, as the email to the company's billing managers tells it (ADR-100). */
export interface PlanChangeFacts {
  companyName: string;
  status: TenantPlanStatus;
  planName: string | null;
  trialEndsAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  extraSeats: number;
  extraNumbers: number;
  runPacks: number;
  changedAt: Date;
  /** The reason staff gave, which the company's audit log shows too. */
  reason: string | null;
  timeZone: string;
}

const counted = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

/** "a", "a and b", "a, b and c". */
function spoken(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The email to a company's billing managers about the plan HyFib staff set (ADR-100): what the plan
 * is now, in the company's time zone, its add-ons and HyFib's reason.
 */
export function planChangeNotice(facts: PlanChangeFacts): { subject: string; lines: string[] } {
  // The table's checks give a trial its end and a paid period both ends.
  const day = (at: Date | null, what: string) => {
    if (!at) throw new Error(`The ${facts.status} plan state has no ${what}`);
    return new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeZone: facts.timeZone,
    }).format(at);
  };
  const plan = facts.planName ? `the ${facts.planName} plan` : 'its plan';
  let state: string;
  switch (facts.status) {
    case 'complimentary':
      state = 'It now has complimentary access from HyFib: no limits and every module.';
      break;
    case 'trialing':
      state = `It is now on a trial of ${plan} until ${day(facts.trialEndsAt, 'trial end')}.`;
      break;
    case 'active':
      state = `It is now on ${plan}, for the paid period from ${day(facts.periodStart, 'period start')} to ${day(facts.periodEnd, 'period end')}.`;
      break;
    case 'canceled':
      state = `HyFib ended ${plan}: sending messages, campaigns and automations is paused until the company is put on a plan again. Its data is kept, and members can still review and export it.`;
      break;
    default:
      state = `Its plan is now ${TENANT_PLAN_STATUS_LABELS[facts.status].toLowerCase()}.`;
  }
  const addOns = [
    facts.extraSeats > 0 ? counted(facts.extraSeats, 'extra seat', 'extra seats') : null,
    facts.extraNumbers > 0
      ? counted(facts.extraNumbers, 'extra WhatsApp number', 'extra WhatsApp numbers')
      : null,
    facts.runPacks > 0
      ? counted(facts.runPacks, 'automation run pack', 'automation run packs')
      : null,
  ].filter((item): item is string => item !== null);
  const reason = facts.reason?.trim();
  return {
    subject: 'HyFib changed your plan',
    lines: [
      `HyFib changed the plan of ${facts.companyName} on ${day(facts.changedAt, 'change time')}.`,
      state,
      ...(addOns.length > 0 && facts.status !== 'canceled'
        ? [`It includes ${spoken(addOns)} on top of the plan.`]
        : []),
      // The reason may hold 500 characters, a notice line's limit before the prefix.
      ...(reason ? splitEmailText(`HyFib's reason: ${reason}`, NOTICE_LINE_MAX.billing) : []),
      'The plan card in Billing shows the limits that apply and what the company used this month.',
    ],
  };
}

export interface PlanChangeNoticeDeps {
  db: Database;
  notices: BillingNoticeDeps;
}

export interface PlanChangeNoticeResult {
  notified: number;
  /**
   * Changes replaced by a later one (the plan sweep's, a subscription's or the company's own choice,
   * ADR-105) before they were told.
   */
  superseded: number;
  /** Companies whose notice failed; it rolled back and is due again on the next sweep. */
  failed: { tenantId: string; error: unknown }[];
}

/**
 * The minute sweep's emails about plans HyFib staff set (ADR-100): the platform role cannot queue
 * email, so the worker tells each company's billing managers, taking the notice in the company's
 * own scope in the transaction that queues the emails. A plan changed again since (by the plan
 * sweep or a subscription, whose own emails tell the company, or by the company's own choice) is
 * not told. A company that fails is reported and tried again the next minute.
 */
export async function notifyStaffPlanChanges(
  deps: PlanChangeNoticeDeps,
  limit = 50,
): Promise<PlanChangeNoticeResult> {
  const due = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ tenant_id: string }>(
        sql`select tenant_id from ops.plan_change_notices_due(${limit}::int)`,
      ),
    { accessMode: 'read only' },
  );
  const result: PlanChangeNoticeResult = { notified: 0, superseded: 0, failed: [] };
  for (const { tenant_id: tenantId } of due.rows) {
    // Tenant ids come from the plan states staff changed, never from a request.
    const scope = authorizedTenantScope(tenantId, null);
    try {
      const outcome = await deps.db.run(scope, async (tx) => {
        const taken = await tx.execute<{ due: boolean | null }>(
          sql`select app.take_plan_change_notice() as due`,
        );
        const notice = taken.rows[0]?.due;
        if (notice === null || notice === undefined) return 'none';
        if (!notice) return 'superseded';
        const [row] = await tx
          .select({
            companyName: tenants.name,
            timeZone: tenants.timezone,
            status: tenantPlans.status,
            planName: plans.name,
            trialEndsAt: tenantPlans.trialEndsAt,
            periodStart: tenantPlans.periodStart,
            periodEnd: tenantPlans.periodEnd,
            extraSeats: tenantPlans.extraSeats,
            extraNumbers: tenantPlans.extraNumbers,
            runPacks: tenantPlans.runPacks,
            changedAt: tenantPlans.changedAt,
            reason: tenantPlans.note,
          })
          .from(tenantPlans)
          .innerJoin(tenants, eq(tenants.id, tenantPlans.tenantId))
          .leftJoin(plans, eq(plans.id, tenantPlans.planId))
          .where(eq(tenantPlans.tenantId, tenantId));
        // The notice was taken from this row in this transaction: it cannot be missing.
        if (!row) throw new Error('The company has no plan state');
        await notifyBillingManagers(deps.notices, tx, scope, planChangeNotice(row));
        return 'notified';
      });
      if (outcome === 'notified') result.notified += 1;
      else if (outcome === 'superseded') result.superseded += 1;
    } catch (error) {
      result.failed.push({ tenantId, error });
    }
  }
  return result;
}

/** A subscription HyFib staff cancelled, as the email to the billing managers tells it (ADR-101). */
export interface SubscriptionCancelFacts {
  companyName: string;
  planName: string;
  cancelledAt: Date;
  /**
   * What the cancellation leaves of the company's plan: a period the subscription paid that is still
   * running, the grace days after the last period it paid, the trial its payments were to start
   * after (ADR-102), or none of these (a plan staff set or a plan that already ended), which the
   * cancellation does not change.
   */
  plan:
    | { kind: 'paid'; periodEnd: Date }
    | { kind: 'grace'; periodEnd: Date; graceEndsAt: Date }
    | { kind: 'trial'; trialEndsAt: Date; ended: boolean }
    | { kind: 'unchanged' };
  /** The reason staff gave, which the company's audit log shows too. */
  reason: string | null;
  timeZone: string;
}

/**
 * The email to a company's billing managers about the plan subscription HyFib staff cancelled at
 * once (ADR-101): nothing more is charged, what the plan keeps, and HyFib's reason.
 */
export function subscriptionCancelNotice(facts: SubscriptionCancelFacts): {
  subject: string;
  lines: string[];
} {
  const day = (at: Date) =>
    new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: facts.timeZone }).format(at);
  let plan: string;
  switch (facts.plan.kind) {
    case 'paid':
      plan = `The period it paid runs until ${day(facts.plan.periodEnd)}; the plan then ends, and Billing shows how to continue.`;
      break;
    case 'grace':
      plan = `Its last paid period ended on ${day(facts.plan.periodEnd)}, and the plan ends when its grace days end on ${day(facts.plan.graceEndsAt)}; Billing shows how to continue.`;
      break;
    case 'trial':
      plan = facts.plan.ended
        ? `Its payments were to start when the trial ended on ${day(facts.plan.trialEndsAt)}, so the trial is over; Billing shows how to continue.`
        : `Its payments were to start when the trial ends on ${day(facts.plan.trialEndsAt)}. The trial goes on until then; Billing shows how to continue after it.`;
      break;
    case 'unchanged':
      plan = 'This does not change the company’s plan; the plan card in Billing shows it.';
      break;
  }
  const reason = facts.reason?.trim();
  return {
    subject: 'HyFib cancelled your plan subscription',
    lines: [
      `HyFib cancelled the Razorpay subscription for the ${facts.planName} plan of ${facts.companyName} on ${day(facts.cancelledAt)}, so nothing more is charged.`,
      plan,
      ...(reason ? splitEmailText(`HyFib's reason: ${reason}`, NOTICE_LINE_MAX.billing) : []),
    ],
  };
}

export interface SubscriptionCancelNoticeResult {
  notified: number;
  /** Companies whose notice failed; it rolled back and is due again on the next sweep. */
  failed: { tenantId: string; subscriptionId: string; error: unknown }[];
}

/**
 * The minute sweep's emails about plan subscriptions HyFib staff cancelled (ADR-101), as for plan
 * changes (ADR-100): each notice is taken in the company's own scope, in the transaction that
 * queues the emails to its billing managers. A company that fails is reported and tried again the
 * next minute.
 */
export async function notifyStaffSubscriptionCancellations(
  deps: PlanChangeNoticeDeps,
  limit = 50,
): Promise<SubscriptionCancelNoticeResult> {
  const due = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ tenant_id: string; subscription_id: string }>(
        sql`select tenant_id, subscription_id from ops.plan_subscription_cancel_notices_due(${limit}::int)`,
      ),
    { accessMode: 'read only' },
  );
  const result: SubscriptionCancelNoticeResult = { notified: 0, failed: [] };
  for (const { tenant_id: tenantId, subscription_id: subscriptionId } of due.rows) {
    // Tenant and subscription ids come from the cancellations staff made, never from a request.
    const scope = authorizedTenantScope(tenantId, null);
    try {
      const told = await deps.db.run(scope, async (tx) => {
        const taken = await tx.execute<{ taken: boolean }>(
          sql`select app.take_plan_subscription_cancel_notice(${subscriptionId}::uuid) as taken`,
        );
        if (taken.rows[0]?.taken !== true) return false;
        const [row] = await tx
          .select({
            companyName: tenants.name,
            timeZone: tenants.timezone,
            planName: plans.name,
            cancelledAt: planSubscriptions.cancelRequestedAt,
            startsAt: planSubscriptions.startsAt,
            paidCount: planSubscriptions.paidCount,
          })
          .from(planSubscriptions)
          .innerJoin(tenants, eq(tenants.id, planSubscriptions.tenantId))
          .innerJoin(plans, eq(plans.id, planSubscriptions.planId))
          .where(
            and(eq(planSubscriptions.tenantId, tenantId), eq(planSubscriptions.id, subscriptionId)),
          );
        // The notice was taken from this row in this transaction: it cannot be missing.
        if (!row?.cancelledAt) throw new Error('The cancelled subscription has no cancellation');
        const [state] = await tx
          .select({
            status: tenantPlans.status,
            trialEndsAt: tenantPlans.trialEndsAt,
            periodEnd: tenantPlans.periodEnd,
            graceEndsAt: tenantPlans.graceEndsAt,
            subscriptionId: tenantPlans.subscriptionId,
            trialRunning: sql<boolean>`${tenantPlans.trialEndsAt} > now()`,
            // A period or grace days the plan sweep has not moved on yet (Razorpay did not answer)
            // are not told as running; the sweep's own email tells the company when the plan ends.
            periodRunning: sql<boolean>`${tenantPlans.periodEnd} > now()`,
            graceRunning: sql<boolean>`${tenantPlans.graceEndsAt} > now()`,
          })
          .from(tenantPlans)
          .where(eq(tenantPlans.tenantId, tenantId));
        // Staff record the reason in the company's audit log with the cancellation.
        const [audit] = await tx
          .select({ metadata: auditEvents.metadata })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.tenantId, tenantId),
              eq(auditEvents.action, 'platform.plan_subscription_cancelled'),
              eq(auditEvents.subjectId, subscriptionId),
            ),
          )
          .orderBy(desc(auditEvents.occurredAt))
          .limit(1);
        const reason = (audit?.metadata as { reason?: unknown } | undefined)?.reason;
        // The plan still on a period this subscription paid ends with it. A trial its payments were
        // to start after (ADR-102) goes on to its end, or is over if it ended waiting for the first
        // charge (the plan sweep may have ended it already). Any other plan state (a plan staff set
        // since, an ended plan) is not changed by the cancellation.
        let plan: SubscriptionCancelFacts['plan'] = { kind: 'unchanged' };
        if (state?.subscriptionId === subscriptionId && state.periodEnd) {
          if (state.status === 'active' && state.periodRunning) {
            plan = { kind: 'paid', periodEnd: state.periodEnd };
          } else if (state.status === 'past_due' && state.graceEndsAt && state.graceRunning) {
            plan = { kind: 'grace', periodEnd: state.periodEnd, graceEndsAt: state.graceEndsAt };
          }
        } else if (
          (state?.status === 'trialing' || state?.status === 'expired') &&
          state.trialEndsAt &&
          row.paidCount === 0 &&
          row.startsAt?.getTime() === state.trialEndsAt.getTime()
        ) {
          plan = {
            kind: 'trial',
            trialEndsAt: state.trialEndsAt,
            ended: state.status === 'expired' || !state.trialRunning,
          };
        }
        await notifyBillingManagers(
          deps.notices,
          tx,
          scope,
          subscriptionCancelNotice({
            companyName: row.companyName,
            planName: row.planName,
            cancelledAt: row.cancelledAt,
            plan,
            reason: typeof reason === 'string' ? reason : null,
            timeZone: row.timeZone,
          }),
        );
        return true;
      });
      if (told) result.notified += 1;
    } catch (error) {
      result.failed.push({ tenantId, subscriptionId, error });
    }
  }
  return result;
}
