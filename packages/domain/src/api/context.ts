import { AppError } from '@w360/core';
import {
  authorizedTenantScope,
  sql,
  systemScope,
  type ApiScope,
  type Database,
  type TenantScope,
  type TenantStatus,
} from '@w360/db';
import { hashApiToken } from './keys';
import { API_SCOPE_INFO } from './model';

/**
 * A public API request (ADR-052): it acts for its company as its key, not as a member. Data access
 * runs in the company's scope without a user; audit rows name the key.
 */
export interface ApiContext {
  readonly tenant: { id: string; status: TenantStatus };
  readonly key: { id: string; scopes: ReadonlySet<ApiScope> };
  readonly scope: TenantScope;
  readonly requestId: string;
}

/**
 * The key a token belongs to, through `ops.api_key_authenticate` (unknown, revoked and expired
 * keys, and companies being deleted, give nothing). The token itself is only hashed here.
 */
export async function authenticateApiToken(
  db: Database,
  token: string,
  requestId: string,
): Promise<ApiContext | null> {
  const res = await db.run(systemScope, (tx) =>
    tx.execute<{
      key_id: string;
      tenant_id: string;
      scopes: ApiScope[];
      tenant_status: TenantStatus;
    }>(
      sql`select key_id, tenant_id, scopes, tenant_status from ops.api_key_authenticate(${hashApiToken(token)})`,
    ),
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    tenant: { id: row.tenant_id, status: row.tenant_status },
    key: { id: row.key_id, scopes: new Set(row.scopes) },
    scope: authorizedTenantScope(row.tenant_id, null),
    requestId,
  };
}

/**
 * Refuses a request whose key lacks the scope, and writing scopes while the company is suspended
 * or restricted (reading stays, as in the app).
 */
export function assertScope(ctx: ApiContext, scope: ApiScope): void {
  if (!ctx.key.scopes.has(scope)) {
    throw new AppError('forbidden', `This API key does not have the ${scope} scope.`);
  }
  if (API_SCOPE_INFO[scope].writes && ctx.tenant.status !== 'active') {
    throw new AppError(
      'tenant_suspended',
      ctx.tenant.status === 'restricted'
        ? "The company's plan has ended, so the API cannot change data or send messages."
        : 'The company is suspended, so the API cannot change data or send messages.',
    );
  }
}

/** The audit actor of API work. */
export const apiActor = (ctx: ApiContext) => ({ type: 'api_key' as const, id: ctx.key.id });
