/**
 * Database access scopes.
 *
 * Every query runs inside a transaction whose first statement sets the transaction-local settings
 * `app.tenant_id` and `app.user_id`. Row level security policies read these settings; a missing
 * value evaluates to NULL and matches nothing (fail closed). Because the settings are local to the
 * transaction they are discarded on COMMIT/ROLLBACK and can never leak to the next borrower of a
 * pooled connection.
 *
 * Scopes are branded so that tenant scopes are only created by code that has authorised them
 * (membership resolution in the web tier, signed-job verification in the worker). The brand is a
 * compile-time guard; RLS is the runtime backstop.
 */
declare const tenantScopeBrand: unique symbol;
declare const userScopeBrand: unique symbol;

export interface TenantScope {
  readonly kind: 'tenant';
  readonly tenantId: string;
  /** Acting user, or null for system work (webhook ingestion, schedulers). */
  readonly userId: string | null;
  readonly [tenantScopeBrand]: true;
}

export interface UserScope {
  readonly kind: 'user';
  readonly userId: string;
  readonly [userScopeBrand]: true;
}

/** No tenant, no user: only non-tenant infrastructure tables are reachable. */
export interface SystemScope {
  readonly kind: 'system';
}

export type Scope = TenantScope | UserScope | SystemScope;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Creates a tenant scope. Callers MUST have verified authority first: an active membership for the
 * user, a verified provider asset mapping, or a verified signed job envelope.
 */
export function authorizedTenantScope(tenantId: string, userId: string | null): TenantScope {
  if (!UUID_RE.test(tenantId)) throw new Error('Invalid tenant id for scope');
  if (userId !== null && (userId.length === 0 || userId.length > 200))
    throw new Error('Invalid user id for scope');
  return { kind: 'tenant', tenantId, userId } as TenantScope;
}

/** Creates a user scope for an authenticated user (no company selected). */
export function authenticatedUserScope(userId: string): UserScope {
  if (userId.length === 0 || userId.length > 200) throw new Error('Invalid user id for scope');
  return { kind: 'user', userId } as UserScope;
}

export const systemScope: SystemScope = Object.freeze({ kind: 'system' as const });
