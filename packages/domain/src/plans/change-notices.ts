import {
  authorizedTenantScope,
  eq,
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
  /** Changes replaced by a later one (the plan sweep's or a subscription's) before they were told. */
  superseded: number;
  /** Companies whose notice failed; it rolled back and is due again on the next sweep. */
  failed: { tenantId: string; error: unknown }[];
}

/**
 * The minute sweep's emails about plans HyFib staff set (ADR-100): the platform role cannot queue
 * email, so the worker tells each company's billing managers, taking the notice in the company's
 * own scope in the transaction that queues the emails. A plan changed again since (by the plan
 * sweep or a subscription, whose own emails tell the company) is not told. A company that fails is
 * reported and tried again the next minute.
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
