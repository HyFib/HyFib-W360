import { AppError, normalizeIpAddress } from '@w360/core';
import {
  authorizedTenantScope,
  sql,
  systemScope,
  type ApiScope,
  type Database,
  type TenantScope,
  type TenantStatus,
} from '@w360/db';
import { apiScopesNotInPlan, loadEntitlements } from '../plans/entitlements';
import { hashApiToken } from './keys';
import { API_SCOPE_INFO } from './model';

/**
 * The key a public API request authenticated with (ADR-052): it acts for its company as its key,
 * not as a member. Data access runs in the company's scope without a user; audit rows name the key.
 */
export interface ApiKeyContext {
  readonly tenant: { id: string; status: TenantStatus };
  readonly key: { id: string; scopes: ReadonlySet<ApiScope> };
  readonly scope: TenantScope;
  readonly requestId: string;
}

/**
 * A request admitted under its company's plan (`admitApiRequest`): the key, and the scopes the plan
 * includes, which bound the key's (ADR-092).
 */
export interface ApiContext extends ApiKeyContext {
  /** The scopes the company's plan includes; null: every scope. */
  readonly planScopes: ReadonlySet<ApiScope> | null;
}

/**
 * What a token presented from an address gets: the key, or a key that does not accept requests
 * from that address (ADR-076), which is refused without a context.
 */
export type ApiAuthentication =
  { authenticated: ApiKeyContext } | { refused: 'address'; keyId: string; tenantId: string };

/**
 * The key a token belongs to, through `ops.api_key_authenticate` (unknown, revoked and expired
 * keys, and companies being deleted, give nothing). A key that lists networks accepts only a client
 * address inside one of them; an address that could not be determined is refused by such a key.
 * The token itself is only hashed here.
 */
export async function authenticateApiRequest(
  db: Database,
  token: string,
  requestId: string,
  clientIp: string | null,
): Promise<ApiAuthentication | null> {
  const address = normalizeIpAddress(clientIp);
  const res = await db.run(systemScope, (tx) =>
    tx.execute<{
      key_id: string;
      tenant_id: string;
      scopes: ApiScope[];
      tenant_status: TenantStatus;
      address_allowed: boolean;
    }>(
      sql`select key_id, tenant_id, scopes, tenant_status, address_allowed
            from ops.api_key_authenticate(${hashApiToken(token)}, ${address}::inet)`,
    ),
  );
  const row = res.rows[0];
  if (!row) return null;
  if (!row.address_allowed)
    return { refused: 'address', keyId: row.key_id, tenantId: row.tenant_id };
  return {
    authenticated: {
      tenant: { id: row.tenant_id, status: row.tenant_status },
      key: { id: row.key_id, scopes: new Set(row.scopes) },
      scope: authorizedTenantScope(row.tenant_id, null),
      requestId,
    },
  };
}

/**
 * The context of a token presented from `clientIp` (none known by default), or null, with the
 * scopes the company's plan includes, without counting a request (the web app admits each request
 * with `admitApiRequest`, which counts it).
 */
export async function authenticateApiToken(
  db: Database,
  token: string,
  requestId: string,
  clientIp: string | null = null,
): Promise<ApiContext | null> {
  const auth = await authenticateApiRequest(db, token, requestId, clientIp);
  if (!auth || !('authenticated' in auth)) return null;
  const key = auth.authenticated;
  const entitlements = await db.run(key.scope, (tx) => loadEntitlements(tx, key.tenant.id), {
    accessMode: 'read only',
  });
  return { ...key, planScopes: entitlements.apiScopes };
}

/** Whether the request may use the scope: its key has it and the company's plan includes it. */
export function hasScope(ctx: ApiContext, scope: ApiScope): boolean {
  return ctx.key.scopes.has(scope) && (ctx.planScopes === null || ctx.planScopes.has(scope));
}

/**
 * Refuses a request whose key lacks the scope or whose company's plan leaves it out (reason
 * `not_in_plan`, ADR-092), and writing scopes while the company is suspended or restricted (reading
 * stays, as in the app).
 */
export function assertScope(ctx: ApiContext, scope: ApiScope): void {
  if (!ctx.key.scopes.has(scope)) {
    throw new AppError('forbidden', `This API key does not have the ${scope} scope.`);
  }
  if (ctx.planScopes !== null && !ctx.planScopes.has(scope)) throw apiScopesNotInPlan([scope]);
  if (API_SCOPE_INFO[scope].writes && ctx.tenant.status !== 'active') {
    throw new AppError(
      'tenant_suspended',
      ctx.tenant.status === 'restricted'
        ? "The company's plan has ended, so the API cannot change data or send messages."
        : 'The company is suspended, so the API cannot change data or send messages.',
    );
  }
}

/**
 * Refuses a request that may use none of the scopes, for reads any one of them allows (whatever the
 * company's status). The refusal names a scope the key has, when it has one, so it says the plan
 * leaves that scope out.
 */
export function assertAnyScope(ctx: ApiContext, scopes: readonly [ApiScope, ...ApiScope[]]): void {
  if (scopes.some((scope) => hasScope(ctx, scope))) return;
  assertScope(ctx, scopes.find((scope) => ctx.key.scopes.has(scope)) ?? scopes[0]);
}

/** The audit actor of API work. */
export const apiActor = (ctx: ApiContext) => ({ type: 'api_key' as const, id: ctx.key.id });
