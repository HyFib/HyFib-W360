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
  type TenantRole,
  type TenantScope,
  type TenantStatus,
} from '@w360/db';
import {
  ALLOWED_WHEN_SUSPENDED,
  ALLOWED_WITHOUT_MFA,
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
  };
  readonly user: { id: string; email: string; name: string; twoFactorEnabled: boolean };
  readonly membership: { id: string; roles: TenantRole[]; joinedAt: Date };
  /** Effective permissions after suspension and MFA restrictions. */
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
  readonly correlationId: string;
  readonly scope: TenantScope;
}

export interface ResolveTenantContextInput {
  userId: string;
  sessionId: string | null;
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
    },
    user: {
      id: input.userId,
      email: row.email,
      name: row.userName,
      twoFactorEnabled: row.twoFactorEnabled,
    },
    membership: { id: row.membershipId, roles: row.roles, joinedAt: row.joinedAt },
    permissions: effective,
    rolePermissions,
    mfa: { required: mfaRequired, satisfied: mfaSatisfied, graceEndsAt, blocking: mfaBlocking },
    sessionId: input.sessionId,
    correlationId: input.correlationId,
    scope: authorizedTenantScope(row.tenantId, input.userId),
  };
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
    if (ctx.tenant.status !== 'active') {
      throw new AppError(
        'tenant_suspended',
        'This company is suspended; this action is unavailable.',
      );
    }
  }
  throw forbidden();
}
