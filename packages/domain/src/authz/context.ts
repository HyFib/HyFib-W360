import { AppError, forbidden, type Clock } from '@w360/core';
import {
  and,
  authenticatedUserScope,
  authorizedTenantScope,
  eq,
  memberships,
  tenants,
  users,
  type Database,
  type MaskableRole,
  type PlanModule,
  type TenantPlanStatus,
  type TenantRole,
  type TenantScope,
  type TenantStatus,
} from '@w360/db';
import { loadEntitlements } from '../plans/entitlements';
import {
  MODULE_WRITE_PERMISSIONS,
  PLAN_MODULE_KEYS,
  PLAN_MODULE_LABELS,
  moduleOfPermission,
  type PlanLimits,
} from '../plans/model';
import {
  ALLOWED_WHEN_SUSPENDED,
  ALLOWED_WITHOUT_MFA,
  ROLE_PERMISSIONS,
  isPrivileged,
  permissionsForRoles,
  type Permission,
} from './permissions';

/**
 * The authorization context for one request or job inside one company. It is derived fresh from
 * the database for each request (never cached across requests), so membership revocation, role
 * changes and suspensions take effect on the very next request.
 */
export interface TenantContext {
  readonly tenant: {
    id: string;
    slug: string;
    name: string;
    status: TenantStatus;
    timezone: string;
    locale: string;
    billingMode: 'direct_meta' | 'partner_billed';
    requireMfaAllMembers: boolean;
    /** The roles whose members see customers' numbers masked (ADR-226). */
    maskedNumberRoles: readonly MaskableRole[];
  };
  readonly user: { id: string; email: string; name: string; twoFactorEnabled: boolean };
  readonly membership: { id: string; roles: TenantRole[]; joinedAt: Date };
  /** The company's plan (ADR-051): its state, the modules it includes and its limits. */
  readonly plan: {
    status: TenantPlanStatus;
    planId: string | null;
    modules: ReadonlySet<PlanModule>;
    limits: PlanLimits;
  };
  /** Effective permissions after plan, suspension and MFA restrictions. */
  readonly permissions: ReadonlySet<Permission>;
  /** Role permissions before restrictions (used to explain why something is unavailable). */
  readonly rolePermissions: ReadonlySet<Permission>;
  readonly mfa: {
    required: boolean;
    satisfied: boolean;
    graceEndsAt: Date | null;
    blocking: boolean;
  };
  readonly sessionId: string | null;
  /**
   * When the member signed in (the session's start), for step-up checks (ADR-056); null without an
   * interactive session.
   */
  readonly signedInAt: Date | null;
  readonly correlationId: string;
  readonly scope: TenantScope;
}

export interface ResolveTenantContextInput {
  userId: string;
  sessionId: string | null;
  /** When the session started (the authentication library's session creation time). */
  sessionCreatedAt?: Date | null;
  tenantSlug: string;
  correlationId: string;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;

export async function resolveTenantContext(
  deps: { db: Database; clock: Clock; mfaGracePeriodHours: number },
  input: ResolveTenantContextInput,
): Promise<TenantContext> {
  // Anti-enumeration: every failure below is the same "not found" regardless of whether the company
  // exists, so a non-member cannot probe for company slugs.
  const notFound = new AppError('not_found', 'Company not found.');
  if (!SLUG_RE.test(input.tenantSlug)) throw notFound;

  const row = await deps.db.run(
    authenticatedUserScope(input.userId),
    async (tx) => {
      const rows = await tx
        .select({
          tenantId: tenants.id,
          slug: tenants.slug,
          name: tenants.name,
          status: tenants.status,
          timezone: tenants.timezone,
          locale: tenants.locale,
          billingMode: tenants.billingMode,
          requireMfaAllMembers: tenants.requireMfaAllMembers,
          maskedNumberRoles: tenants.maskedNumberRoles,
          membershipId: memberships.id,
          roles: memberships.roles,
          membershipStatus: memberships.status,
          joinedAt: memberships.joinedAt,
          email: users.email,
          userName: users.name,
          twoFactorEnabled: users.twoFactorEnabled,
        })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(tenants.slug, input.tenantSlug), eq(memberships.userId, input.userId)))
        .limit(1);
      return rows[0];
    },
    { accessMode: 'read only' },
  );

  if (!row || row.membershipStatus !== 'active' || row.status === 'deleted') throw notFound;

  // The plan is read in the company's scope, now that membership is established.
  const entitlements = await deps.db.run(
    authorizedTenantScope(row.tenantId, input.userId),
    (tx) => loadEntitlements(tx, row.tenantId),
    { accessMode: 'read only' },
  );

  const rolePermissions = permissionsForRoles(row.roles);
  const now = deps.clock.now();
  const mfaRequired = row.requireMfaAllMembers || isPrivileged(row.roles);
  const mfaSatisfied = !mfaRequired || row.twoFactorEnabled;
  const graceEndsAt =
    mfaRequired && !mfaSatisfied
      ? new Date(row.joinedAt.getTime() + deps.mfaGracePeriodHours * 3600_000)
      : null;
  const mfaBlocking = graceEndsAt !== null && now >= graceEndsAt;

  let effective = new Set(rolePermissions);
  // A module the plan leaves out keeps read access but loses its write permissions.
  for (const module of PLAN_MODULE_KEYS) {
    if (entitlements.modules.has(module)) continue;
    for (const permission of MODULE_WRITE_PERMISSIONS[module]) effective.delete(permission);
  }
  // Customers' numbers whole only through a role the company does not mask (ADR-226).
  if (!seesNumbersWhole(row.roles, row.maskedNumberRoles))
    effective.delete('contacts.view_numbers');
  if (row.status !== 'active')
    effective = new Set([...effective].filter((p) => ALLOWED_WHEN_SUSPENDED.has(p)));
  if (mfaBlocking) effective = new Set([...effective].filter((p) => ALLOWED_WITHOUT_MFA.has(p)));

  return {
    tenant: {
      id: row.tenantId,
      slug: row.slug,
      name: row.name,
      status: row.status,
      timezone: row.timezone,
      locale: row.locale,
      billingMode: row.billingMode,
      requireMfaAllMembers: row.requireMfaAllMembers,
      maskedNumberRoles: row.maskedNumberRoles,
    },
    user: {
      id: input.userId,
      email: row.email,
      name: row.userName,
      twoFactorEnabled: row.twoFactorEnabled,
    },
    membership: { id: row.membershipId, roles: row.roles, joinedAt: row.joinedAt },
    plan: {
      status: entitlements.planStatus,
      planId: entitlements.planId,
      modules: entitlements.modules,
      limits: entitlements.limits,
    },
    permissions: effective,
    rolePermissions,
    mfa: { required: mfaRequired, satisfied: mfaSatisfied, graceEndsAt, blocking: mfaBlocking },
    sessionId: input.sessionId,
    signedInAt: input.sessionCreatedAt ?? null,
    correlationId: input.correlationId,
    scope: authorizedTenantScope(row.tenantId, input.userId),
  };
}

/**
 * Whether a member with these roles sees customers' numbers whole when the company masks them for
 * `masked` (ADR-226): through any role that grants it and is not masked. Owners and administrators
 * cannot be masked.
 */
export function seesNumbersWhole(
  roles: readonly TenantRole[],
  masked: readonly MaskableRole[],
): boolean {
  return roles.some(
    (role) =>
      ROLE_PERMISSIONS[role].has('contacts.view_numbers') &&
      !(masked as readonly TenantRole[]).includes(role),
  );
}

export function can(ctx: TenantContext, permission: Permission): boolean {
  return ctx.permissions.has(permission);
}

/** Throws a precise, user-presentable error when the permission is not held. */
export function assertCan(ctx: TenantContext, permission: Permission): void {
  if (ctx.permissions.has(permission)) return;
  if (ctx.rolePermissions.has(permission)) {
    if (ctx.mfa.blocking) {
      throw new AppError(
        'mfa_required',
        'Set up two-factor authentication to continue using this company.',
      );
    }
    if (ctx.tenant.status === 'restricted') {
      throw new AppError(
        'tenant_suspended',
        "This company's plan has ended, so this action is unavailable. Ask HyFib to renew the plan; you can still review and export your data.",
      );
    }
    if (ctx.tenant.status === 'pending_deletion') {
      throw new AppError(
        'tenant_suspended',
        'This company is being deleted, so this action is unavailable. An owner can cancel the deletion in Settings, Company data; you can still review and export your data.',
      );
    }
    if (ctx.tenant.status !== 'active') {
      throw new AppError(
        'tenant_suspended',
        'This company is suspended; this action is unavailable.',
      );
    }
    const module = moduleOfPermission(permission);
    if (module && !ctx.plan.modules.has(module)) {
      throw new AppError(
        'forbidden',
        `Your company's plan does not include ${PLAN_MODULE_LABELS[module]}. Ask HyFib to change the plan.`,
      );
    }
    if (permission === 'contacts.view_numbers') throw new AppError('forbidden', NUMBERS_HIDDEN);
  }
  throw forbidden();
}

/** Why a member whose company masks customers' numbers cannot do what needs them whole. */
export const NUMBERS_HIDDEN =
  "Your company hides customers' phone numbers from your role, so this is unavailable. Ask an owner or administrator.";
