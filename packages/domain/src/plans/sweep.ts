import type { Clock } from '@w360/core';
import {
  authorizedTenantScope,
  eq,
  plans,
  sql,
  systemScope,
  tenants,
  type Database,
  type TenantPlanStatus,
  type Tx,
} from '@w360/db';
import { notifyBillingManagers, type BillingNoticeDeps } from '../billing/notices';
import { loadEntitlements } from './entitlements';
import { usagePeriod } from './model';

export interface PlanSweepDeps {
  db: Database;
  clock: Clock;
  notices: BillingNoticeDeps;
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

export interface PlanSweepResult {
  transitioned: number;
  announced: number;
  /** Companies whose work failed; it rolled back and is due again on the next sweep. */
  failed: { tenantId: string; error: unknown }[];
}

/**
 * The minute sweep's plan work (ADR-051): moves trials, paid periods and grace periods that have
 * ended to their next state (each in the company's own scope, recorded in its audit log) and
 * emails the company's billing managers; then announces, once per month, automation run limits
 * that were reached. One company's failure does not hold up the others.
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
        if (row.new_status === 'past_due') {
          const ent = await tx.execute<{ grace_ends_at: Date | string }>(
            sql`select grace_ends_at from app.tenant_plans where tenant_id = ${tenantId}::uuid`,
          );
          const graceEnds = ent.rows[0]?.grace_ends_at;
          await notifyBillingManagers(deps.notices, tx, scope, {
            subject: 'The paid period of your HyFib plan has ended',
            lines: [
              `The paid period of the ${planName} plan ended on ${day(now)}.`,
              graceEnds
                ? `Everything keeps working until ${day(new Date(graceEnds))}. Ask HyFib to renew the plan before then.`
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
              'Ask HyFib to choose a plan to continue.',
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
  return { transitioned, announced, failed };
}

/**
 * Emails the company's billing managers that its automation runs for the month are used up, once
 * per counter: the claim on `notified_at` lets only one of two sweeps that listed the same counter
 * send it. Returns whether this call sent it.
 */
export async function announceRunLimit(
  deps: PlanSweepDeps,
  tenantId: string,
  counterId: string,
): Promise<boolean> {
  const scope = authorizedTenantScope(tenantId, null);
  return deps.db.run(scope, async (tx) => {
    const claimed = await tx.execute<{ id: string }>(
      sql`update app.usage_counters set notified_at = now()
           where tenant_id = ${tenantId}::uuid and id = ${counterId}::uuid and notified_at is null
           returning id`,
    );
    if (claimed.rows.length === 0) return false;
    const entitlements = await loadEntitlements(tx, tenantId);
    const { planName, day } = await companyFacts(tx, tenantId, entitlements.planId);
    const { end } = usagePeriod(entitlements.usageAnchor, deps.clock.now());
    await notifyBillingManagers(deps.notices, tx, scope, {
      subject: "This month's automation runs are used up",
      lines: [
        `Your company used all ${entitlements.limits.automationRuns ?? 0} automation runs of the ${planName} plan for this month.`,
        `Automations will not start again from customer messages or store events until ${day(end)}. Runs already in progress continue.`,
        'Ask HyFib for more automation runs or a larger plan.',
      ],
    });
    return true;
  });
}
