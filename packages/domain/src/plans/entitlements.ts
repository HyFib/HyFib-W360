import { AppError, uuidv7 } from '@w360/core';
import {
  and,
  apiKeys,
  automations,
  channelAccounts,
  eq,
  gt,
  inArray,
  invitations,
  memberships,
  ne,
  sql,
  teams,
  type ApiScope,
  type PlanModule,
  type TenantPlanStatus,
  type Tx,
} from '@w360/db';
import { PLAN_MODULE_LABELS, usagePeriod, type PlanLimits } from './model';

/**
 * What a company may use (ADR-051), read through `app.tenant_entitlements` so the services and
 * the invitation acceptance in SQL apply the same limits. Complimentary access has no limits and
 * every module.
 */
export interface Entitlements {
  planStatus: TenantPlanStatus;
  planId: string | null;
  limits: PlanLimits;
  modules: ReadonlySet<PlanModule>;
  usageAnchor: Date;
  /** The public API scopes the plan includes; null: every scope (ADR-092). */
  apiScopes: ReadonlySet<ApiScope> | null;
}

interface EntitlementRow extends Record<string, unknown> {
  plan_status: TenantPlanStatus;
  plan_id: string | null;
  seats: number | null;
  numbers: number | null;
  teams: number | null;
  live_automations: number | null;
  automation_runs: number | null;
  modules: PlanModule[];
  usage_anchor: Date | string;
  api_requests: number | null;
  api_scopes: ApiScope[] | null;
}

/** The company's entitlements; `tx` must be in the company's scope. */
export async function loadEntitlements(tx: Tx, tenantId: string): Promise<Entitlements> {
  const res = await tx.execute<EntitlementRow>(
    sql`select * from app.tenant_entitlements(${tenantId}::uuid)`,
  );
  const row = res.rows[0];
  if (!row) throw new Error('The company has no plan state');
  return {
    planStatus: row.plan_status,
    planId: row.plan_id,
    limits: {
      seats: row.seats,
      numbers: row.numbers,
      teams: row.teams,
      liveAutomations: row.live_automations,
      automationRuns: row.automation_runs,
      apiRequests: row.api_requests,
    },
    modules: new Set(row.modules),
    usageAnchor: new Date(row.usage_anchor),
    apiScopes: row.api_scopes === null ? null : new Set(row.api_scopes),
  };
}

export const notInPlan = (module: PlanModule) =>
  new AppError(
    'forbidden',
    `Your company's plan does not include ${PLAN_MODULE_LABELS[module]}. Ask HyFib to change the plan.`,
  );

/** Refuses when the plan leaves the module out. */
export function assertModule(
  entitlements: { modules: ReadonlySet<PlanModule> },
  module: PlanModule,
) {
  if (!entitlements.modules.has(module)) throw notInPlan(module);
}

type LimitKind = 'seats' | 'numbers' | 'teams' | 'automations';

/**
 * Serialises additions of one kind within a company, so two concurrent additions cannot both pass
 * a limit (the invitation acceptance in SQL takes the same seats lock).
 */
async function lockLimit(tx: Tx, tenantId: string, kind: LimitKind): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${kind}:${tenantId}`}, 0))`,
  );
}

/**
 * Takes every limit's lock, in one fixed order, before the limits themselves change (ADR-105): an
 * addition that has not counted yet waits for the change, and one that has is counted by it.
 */
export async function lockAllLimits(tx: Tx, tenantId: string): Promise<void> {
  for (const kind of ['seats', 'numbers', 'teams', 'automations'] as const) {
    await lockLimit(tx, tenantId, kind);
  }
}

const full = (what: string, limit: number) =>
  new AppError(
    'precondition_failed',
    `Your company's plan allows ${limit} ${what}, and all are in use. Free one, or ask HyFib to add more.`,
  );

export async function activeMemberCount(tx: Tx, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.status, 'active')));
  return row?.n ?? 0;
}

/** Invitations that can still be accepted. */
export async function waitingInvitationCount(tx: Tx, tenantId: string, now: Date): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(invitations)
    .where(
      and(
        eq(invitations.tenantId, tenantId),
        eq(invitations.status, 'pending'),
        gt(invitations.expiresAt, now),
      ),
    );
  return row?.n ?? 0;
}

/** Seats in use: active members plus invitations still waiting (they hold a seat). */
export async function seatsInUse(tx: Tx, tenantId: string, now: Date): Promise<number> {
  return (
    (await activeMemberCount(tx, tenantId)) + (await waitingInvitationCount(tx, tenantId, now))
  );
}

/** Before inviting someone or restoring a suspended member: a seat must be free. */
export async function assertSeatAvailable(tx: Tx, tenantId: string, now: Date): Promise<void> {
  await lockLimit(tx, tenantId, 'seats');
  const { limits } = await loadEntitlements(tx, tenantId);
  if (limits.seats === null) return;
  if ((await seatsInUse(tx, tenantId, now)) >= limits.seats) {
    throw full(limits.seats === 1 ? 'seat' : 'seats', limits.seats);
  }
}

/** Numbers that take a slot: connected or being connected (not disconnected or failed). */
export const COUNTED_CHANNEL_STATUSES = ['onboarding', 'active', 'needs_reconnect'] as const;

export async function numbersInUse(tx: Tx, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.tenantId, tenantId),
        inArray(channelAccounts.status, [...COUNTED_CHANNEL_STATUSES]),
      ),
    );
  return row?.n ?? 0;
}

/** Before connecting a WhatsApp number (or connecting a disconnected one again). */
export async function assertNumberAvailable(tx: Tx, tenantId: string): Promise<void> {
  await lockLimit(tx, tenantId, 'numbers');
  const { limits } = await loadEntitlements(tx, tenantId);
  if (limits.numbers === null) return;
  if ((await numbersInUse(tx, tenantId)) >= limits.numbers) {
    throw full(limits.numbers === 1 ? 'WhatsApp number' : 'WhatsApp numbers', limits.numbers);
  }
}

export async function teamsInUse(tx: Tx, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(teams)
    .where(eq(teams.tenantId, tenantId));
  return row?.n ?? 0;
}

/** Before creating a team. */
export async function assertTeamAvailable(tx: Tx, tenantId: string): Promise<void> {
  await lockLimit(tx, tenantId, 'teams');
  const { limits } = await loadEntitlements(tx, tenantId);
  if (limits.teams === null) return;
  if ((await teamsInUse(tx, tenantId)) >= limits.teams) {
    throw full(limits.teams === 1 ? 'team' : 'teams', limits.teams);
  }
}

export async function liveAutomationsInUse(
  tx: Tx,
  tenantId: string,
  exceptAutomationId: string | null = null,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(automations)
    .where(
      and(
        eq(automations.tenantId, tenantId),
        eq(automations.status, 'active'),
        exceptAutomationId ? ne(automations.id, exceptAutomationId) : undefined,
      ),
    );
  return row?.n ?? 0;
}

/** Before an automation goes live (published for the first time or turned on again). */
export async function assertLiveAutomationAvailable(
  tx: Tx,
  tenantId: string,
  automationId: string,
): Promise<void> {
  await lockLimit(tx, tenantId, 'automations');
  const { limits } = await loadEntitlements(tx, tenantId);
  if (limits.liveAutomations === null) return;
  if ((await liveAutomationsInUse(tx, tenantId, automationId)) >= limits.liveAutomations) {
    throw full(
      limits.liveAutomations === 1 ? 'live automation' : 'live automations',
      limits.liveAutomations,
    );
  }
}

/** Automation runs started in the usage period containing `now`. */
export async function automationRunsUsed(
  tx: Tx,
  tenantId: string,
  entitlements: Entitlements,
  now: Date,
): Promise<number> {
  const { start } = usagePeriod(entitlements.usageAnchor, now);
  const res = await tx.execute<{ used: number }>(
    sql`select used from app.usage_counters
         where tenant_id = ${tenantId}::uuid and metric = 'automation_runs'
           and period_start = ${start.toISOString()}::timestamptz`,
  );
  return res.rows[0]?.used ?? 0;
}

export type AutomationRunRefusal = 'not_in_plan' | 'automation_quota';

/**
 * Counts one live automation run against the month's limit, atomically: at most the limit can be
 * counted, whatever runs in parallel. Refuses when the plan has no automations or the month's runs
 * are used up. Test runs are not counted.
 */
export async function consumeAutomationRun(
  tx: Tx,
  tenantId: string,
  now: Date,
): Promise<{ ok: true } | { ok: false; reason: AutomationRunRefusal }> {
  const entitlements = await loadEntitlements(tx, tenantId);
  if (!entitlements.modules.has('automations')) return { ok: false, reason: 'not_in_plan' };
  const limit = entitlements.limits.automationRuns;
  if (limit === null) return { ok: true };
  if (limit <= 0) return { ok: false, reason: 'automation_quota' };
  const { start } = usagePeriod(entitlements.usageAnchor, now);
  const res = await tx.execute<{ used: number }>(
    sql`insert into app.usage_counters as u (id, tenant_id, metric, period_start, used)
        values (${uuidv7()}::uuid, ${tenantId}::uuid, 'automation_runs',
                ${start.toISOString()}::timestamptz, 1)
        on conflict (tenant_id, metric, period_start)
        do update set used = u.used + 1 where u.used < ${limit}
        returning u.used`,
  );
  return res.rows.length > 0 ? { ok: true } : { ok: false, reason: 'automation_quota' };
}

/** Public API requests counted in the usage period containing `now` (ADR-061). */
export async function apiRequestsUsed(
  tx: Tx,
  tenantId: string,
  entitlements: Entitlements,
  now: Date,
): Promise<number> {
  const { start } = usagePeriod(entitlements.usageAnchor, now);
  const res = await tx.execute<{ used: number }>(
    sql`select used from app.usage_counters
         where tenant_id = ${tenantId}::uuid and metric = 'api_requests'
           and period_start = ${start.toISOString()}::timestamptz`,
  );
  return res.rows[0]?.used ?? 0;
}

export const API_NOT_IN_PLAN =
  "Your company's plan does not include the public API. Ask HyFib to change the plan.";

/** Refuses when the plan leaves the public API out (a monthly limit of 0). */
export function assertApiInPlan(entitlements: { limits: { apiRequests: number | null } }) {
  if (entitlements.limits.apiRequests === 0) {
    throw new AppError('forbidden', API_NOT_IN_PLAN, { details: { apiReason: 'not_in_plan' } });
  }
}

/** The scopes of `scopes` the plan leaves out (ADR-092); none when it includes every scope. */
export function scopesNotInPlan(
  entitlements: { apiScopes: ReadonlySet<ApiScope> | null },
  scopes: readonly ApiScope[],
): ApiScope[] {
  const included = entitlements.apiScopes;
  return included === null ? [] : scopes.filter((scope) => !included.has(scope));
}

/** The refusal of scopes the plan leaves out, for the API and for key creation alike. */
export function apiScopesNotInPlan(scopes: readonly ApiScope[]): AppError {
  const names =
    scopes.length === 1 ? scopes[0] : `${scopes.slice(0, -1).join(', ')} and ${scopes.at(-1)}`;
  return new AppError(
    'forbidden',
    `Your company's plan does not include the ${names} ${scopes.length === 1 ? 'scope' : 'scopes'}. Ask HyFib to change the plan.`,
    { details: { apiReason: 'not_in_plan' } },
  );
}

/** Refuses scopes the plan leaves out, when a key is given them (ADR-092). */
export function assertScopesInPlan(
  entitlements: { apiScopes: ReadonlySet<ApiScope> | null },
  scopes: readonly ApiScope[],
): void {
  const missing = scopesNotInPlan(entitlements, scopes);
  if (missing.length > 0) throw apiScopesNotInPlan(missing);
}

export type ApiRequestCount =
  | {
      ok: true;
      /** The company's requests this period, this one included, and the plan's limit. */
      used: number;
      limit: number | null;
      /** The key's requests this period, this one included, and its own limit (ADR-097). */
      keyUsed: number;
      keyLimit: number | null;
      apiScopes: ReadonlySet<ApiScope> | null;
    }
  | {
      ok: false;
      reason: 'not_in_plan' | 'quota_exceeded' | 'key_quota_exceeded';
      limit: number;
      periodEnd: Date;
    };

/**
 * Counts one public API request in the month's usage period (ADR-061), for the company and for the
 * key that made it (ADR-097), atomically and never beyond either limit, whatever runs in parallel;
 * counted without a limit too, so the month's use is known. Refuses when the plan leaves the API
 * out (limit 0), the key's own requests for the month are used up, or the company's are; a request
 * refused counts for neither. Otherwise gives the scopes the plan includes (ADR-092), which the
 * request is then held to.
 */
export async function consumeApiRequest(
  tx: Tx,
  tenantId: string,
  keyId: string,
  now: Date,
): Promise<ApiRequestCount> {
  const entitlements = await loadEntitlements(tx, tenantId);
  const limit = entitlements.limits.apiRequests;
  const { start, end } = usagePeriod(entitlements.usageAnchor, now);
  if (limit === 0) return { ok: false, reason: 'not_in_plan', limit, periodEnd: end };
  // A change of the key's limit holds its row FOR UPDATE until it commits: the request waits for
  // it and counts under the new limit, never under the one it replaced.
  const [key] = await tx
    .select({ limit: apiKeys.monthlyRequestLimit })
    .from(apiKeys)
    .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, keyId)))
    .for('key share');
  if (!key) throw new Error('The API key of an authenticated request was not found.');
  const keyLimit = key.limit;
  // The key first, as the rate limits (ADR-068): a request its key refuses takes nothing from the
  // company. Every request locks its key's row before the company's, so they cannot deadlock.
  await tx.execute(sql`savepoint api_request_count`);
  const counted = await tx.execute<{ used: number }>(
    sql`insert into app.api_key_usage as u (id, tenant_id, api_key_id, period_start, used)
        values (${uuidv7()}::uuid, ${tenantId}::uuid, ${keyId}::uuid,
                ${start.toISOString()}::timestamptz, 1)
        on conflict (tenant_id, api_key_id, period_start)
        do update set used = u.used + 1
        where ${keyLimit === null ? sql`true` : sql`u.used < ${keyLimit}`}
        returning u.used`,
  );
  const keyRow = counted.rows[0];
  if (!keyRow) {
    return { ok: false, reason: 'key_quota_exceeded', limit: keyLimit ?? 0, periodEnd: end };
  }
  const res = await tx.execute<{ used: number }>(
    sql`insert into app.usage_counters as u (id, tenant_id, metric, period_start, used)
        values (${uuidv7()}::uuid, ${tenantId}::uuid, 'api_requests',
                ${start.toISOString()}::timestamptz, 1)
        on conflict (tenant_id, metric, period_start)
        do update set used = u.used + 1
        where ${limit === null ? sql`true` : sql`u.used < ${limit}`}
        returning u.used`,
  );
  const row = res.rows[0];
  if (!row) {
    // The company refuses it: the key's count goes back to what it was.
    await tx.execute(sql`rollback to savepoint api_request_count`);
    return { ok: false, reason: 'quota_exceeded', limit: limit ?? 0, periodEnd: end };
  }
  await tx.execute(sql`release savepoint api_request_count`);
  return {
    ok: true,
    used: row.used,
    limit,
    keyUsed: keyRow.used,
    keyLimit,
    apiScopes: entitlements.apiScopes,
  };
}
