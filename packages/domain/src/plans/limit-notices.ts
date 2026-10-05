import { sql, type Database } from '@w360/db';
import type { Clock } from '@w360/core';
import { assertCan, can, type TenantContext } from '../authz/context';
import { loadEntitlements } from './entitlements';
import { usagePeriod, warningThreshold } from './model';
import { loadUsageWarningPercent } from './usage-warnings';

/**
 * Notices in the app when a monthly limit is nearly or fully used (ADR-140): the automation runs
 * (ADR-051) and public API requests (ADR-061) of the current usage period, packs included, on every
 * page of the company, for the members they concern. The billing managers' emails (ADR-062) say the
 * same once; a notice stays while it holds.
 */

export type LimitNoticeMetric = 'automation_runs' | 'api_requests';

export interface LimitNotice {
  metric: LimitNoticeMetric;
  /**
   * `used_up`: the limit is reached; `nearly`: at least the company's warning share of it is used
   * (ADR-062, ADR-144).
   */
  state: 'nearly' | 'used_up';
  used: number;
  limit: number;
  /** When the usage period ends and the count starts again. */
  periodEnd: Date;
  /**
   * Whether the member reads billing: asked to ask HyFib for more, with a link to Billing; the
   * others are asked to ask a member who manages billing.
   */
  forBilling: boolean;
}

/** Whom a member is, for the notices. */
export interface LimitNoticeAudience {
  /** Reads billing: told of both limits, nearly and fully used. */
  billing: boolean;
  /** Reads automations: told once the automation runs are used up. */
  automations: boolean;
  /** Manages API keys: told once the API requests are used up. */
  developer: boolean;
}

export interface LimitNoticeFacts {
  /** Whether the plan includes automations. */
  automationsInPlan: boolean;
  /** The period's limits, packs included; null: no limit. */
  limits: { automationRuns: number | null; apiRequests: number | null };
  used: { automationRuns: number; apiRequests: number };
  periodEnd: Date;
  /** The share of a limit at which the company is warned (ADR-144). */
  warningPercent: number;
}

/** The notices one member gets for the company's counts; pure, so the rules are unit-tested. */
export function limitNoticesFor(audience: LimitNoticeAudience, facts: LimitNoticeFacts) {
  const notices: LimitNotice[] = [];
  const consider = (
    metric: LimitNoticeMetric,
    limit: number | null,
    used: number,
    affected: boolean,
  ) => {
    // No limit, or none allowed at all (0 leaves the API or the runs out of the plan).
    if (limit === null || limit <= 0) return;
    if (used >= limit) {
      if (audience.billing || affected) {
        notices.push({
          metric,
          state: 'used_up',
          used,
          limit,
          periodEnd: facts.periodEnd,
          forBilling: audience.billing,
        });
      }
      return;
    }
    const threshold = warningThreshold(limit, facts.warningPercent);
    if (audience.billing && threshold !== null && used >= threshold) {
      notices.push({
        metric,
        state: 'nearly',
        used,
        limit,
        periodEnd: facts.periodEnd,
        forBilling: true,
      });
    }
  };
  if (facts.automationsInPlan) {
    consider(
      'automation_runs',
      facts.limits.automationRuns,
      facts.used.automationRuns,
      audience.automations,
    );
  }
  consider('api_requests', facts.limits.apiRequests, facts.used.apiRequests, audience.developer);
  return notices;
}

/** What a notice says, as the billing managers' emails do (ADR-062); pure, so it is unit-tested. */
export function limitNoticeText(
  notice: LimitNotice,
  timeZone: string,
): { tone: 'warning' | 'danger'; title: string; body: string } {
  const count = (n: number) => n.toLocaleString('en-IN');
  const until = new Intl.DateTimeFormat('en-IN', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(notice.periodEnd);
  const runs = notice.metric === 'automation_runs';
  const ask = notice.forBilling
    ? runs
      ? 'Ask HyFib for more automation runs or a larger plan.'
      : 'Ask HyFib for more API requests or a larger plan.'
    : 'A member who manages billing can ask HyFib for more.';
  if (notice.state === 'used_up') {
    return {
      tone: 'danger',
      title: runs
        ? "This month's automation runs are used up"
        : "This month's API requests are used up",
      body: runs
        ? `Your company has used all ${count(notice.limit)} automation runs of this month. Automations do not start from customer messages, store events or the API until ${until}; runs in progress continue. ${ask}`
        : `Your company has used all ${count(notice.limit)} API requests of this month. The public API refuses requests (429, reason quota_exceeded) until ${until}; the app itself, automations and outgoing webhooks are not affected. ${ask}`,
    };
  }
  return {
    tone: 'warning',
    title: runs
      ? "This month's automation runs are nearly used up"
      : "This month's API requests are nearly used up",
    body: runs
      ? `Your company has used ${count(notice.used)} of its ${count(notice.limit)} automation runs for this month. At ${count(notice.limit)}, automations stop starting from customer messages, store events and the API until ${until}; runs in progress continue. ${ask}`
      : `Your company has used ${count(notice.used)} of its ${count(notice.limit)} API requests for this month. At ${count(notice.limit)}, the public API refuses requests until ${until}; the app itself is not affected. ${ask}`,
  };
}

export interface LimitNoticesDeps {
  db: Database;
  clock: Clock;
}

/**
 * The notices of monthly limits a member gets on the company's pages (ADR-140): none while the
 * company is not active, and nothing is read for a member who would get none.
 */
export async function limitNotices(
  deps: LimitNoticesDeps,
  ctx: TenantContext,
): Promise<LimitNotice[]> {
  assertCan(ctx, 'tenant.read');
  const audience: LimitNoticeAudience = {
    billing: can(ctx, 'billing.read'),
    automations: can(ctx, 'automations.read'),
    developer: can(ctx, 'developer.manage'),
  };
  if (ctx.tenant.status !== 'active') return [];
  if (!audience.billing && !audience.automations && !audience.developer) return [];
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const entitlements = await loadEntitlements(tx, ctx.tenant.id);
      const period = usagePeriod(entitlements.usageAnchor, deps.clock.now());
      const counted = await tx.execute<{ metric: string; used: number }>(
        sql`select metric, used from app.usage_counters
             where tenant_id = ${ctx.tenant.id}::uuid
               and metric in ('automation_runs', 'api_requests')
               and period_start = ${period.start.toISOString()}::timestamptz`,
      );
      const used = (metric: LimitNoticeMetric) =>
        Number(counted.rows.find((r) => r.metric === metric)?.used ?? 0);
      return limitNoticesFor(audience, {
        automationsInPlan: entitlements.modules.has('automations'),
        limits: {
          automationRuns: entitlements.limits.automationRuns,
          apiRequests: entitlements.limits.apiRequests,
        },
        used: { automationRuns: used('automation_runs'), apiRequests: used('api_requests') },
        periodEnd: period.end,
        warningPercent: await loadUsageWarningPercent(tx, ctx.tenant.id),
      });
    },
    { accessMode: 'read only' },
  );
}
