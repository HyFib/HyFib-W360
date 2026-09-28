import { and, eq, memberships, sql, tenants, users, type TenantScope, type Tx } from '@w360/db';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';

export interface BillingNoticeDeps {
  outbox: OutboxDeps;
  appBaseUrl: string;
}

/**
 * Emails the company's active billing managers (owner and billing roles, the roles with
 * billing.manage) about a billing event, inside the caller's transaction so the notice is sent only
 * if the event commits.
 */
export async function notifyBillingManagers(
  deps: BillingNoticeDeps,
  tx: Tx,
  scope: TenantScope,
  notice: { subject: string; lines: string[] },
): Promise<number> {
  const [company] = await tx
    .select({ name: tenants.name, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, scope.tenantId));
  if (!company) return 0;
  const managers = await tx
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.tenantId, scope.tenantId),
        eq(memberships.status, 'active'),
        sql`${memberships.roles} && array['owner', 'billing']::text[]`,
      ),
    );
  const url = new URL(`/c/${company.slug}/billing`, deps.appBaseUrl).toString();
  for (const manager of managers) {
    await enqueueEmail(deps.outbox, tx, {
      to: manager.email,
      tenantId: scope.tenantId,
      payload: {
        kind: 'billing.notice',
        companyName: company.name,
        subject: notice.subject,
        lines: notice.lines,
        url,
      },
    });
  }
  return managers.length;
}
