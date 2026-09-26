import {
  authorizedTenantScope,
  and,
  eq,
  memberships,
  sql,
  systemScope,
  type Database,
  type TenantScope,
} from '@w360/db';
import type { JobEnvelope } from '@w360/contracts';
import { recordSecurityEvent } from '../audit';
import type { JobSigner } from './envelope';

/**
 * Worker-side authorisation for a job, mirroring what the web tier does for a request:
 * 1. verify the envelope signature (forged or tampered jobs are dropped and reported);
 * 2. for company jobs, confirm the company still exists and, when required, is active;
 * 3. for actor-bound jobs, confirm the acting member still has an active membership, so
 *    revoking a member stops work they queued;
 * 4. return an RLS scope for exactly that company. Handlers then load their referenced row
 *    under this scope; a row from another company is simply not visible.
 */
export type JobAuthorization =
  | { outcome: 'authorized'; envelope: JobEnvelope; scope: TenantScope | null }
  | {
      outcome: 'rejected';
      reason: 'invalid_signature' | 'unexpected_kind' | 'tenant_missing' | 'actor_not_member';
    }
  | { outcome: 'deferred'; reason: 'tenant_suspended' };

export interface AuthorizeJobOptions {
  expectedKind: string;
  requireActiveTenant: boolean;
  requireActiveActor: boolean;
}

export async function authorizeJob(
  deps: { db: Database; signer: JobSigner },
  data: unknown,
  options: AuthorizeJobOptions,
): Promise<JobAuthorization> {
  const envelope = deps.signer.verify(data);
  if (!envelope) {
    await recordSecurityEvent(deps.db, {
      eventType: 'job.invalid_signature',
      severity: 'critical',
      details: { expectedKind: options.expectedKind },
    });
    return { outcome: 'rejected', reason: 'invalid_signature' };
  }
  if (envelope.kind !== options.expectedKind)
    return { outcome: 'rejected', reason: 'unexpected_kind' };
  if (envelope.tenantId === null) return { outcome: 'authorized', envelope, scope: null };

  const tenantId = envelope.tenantId;
  const status = await deps.db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{ status: string | null }>(
        sql`select app.tenant_status(${tenantId}::uuid) as status`,
      );
      return res.rows[0]?.status ?? null;
    },
    { accessMode: 'read only' },
  );
  if (status === null || status === 'deleted')
    return { outcome: 'rejected', reason: 'tenant_missing' };
  if (options.requireActiveTenant && status !== 'active')
    return { outcome: 'deferred', reason: 'tenant_suspended' };

  const scope = authorizedTenantScope(tenantId, envelope.actorUserId);
  if (options.requireActiveActor && envelope.actorUserId) {
    const actorId = envelope.actorUserId;
    const active = await deps.db.run(
      scope,
      async (tx) => {
        const rows = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.tenantId, tenantId),
              eq(memberships.userId, actorId),
              eq(memberships.status, 'active'),
            ),
          );
        return rows.length > 0;
      },
      { accessMode: 'read only' },
    );
    if (!active) return { outcome: 'rejected', reason: 'actor_not_member' };
  }
  return { outcome: 'authorized', envelope, scope };
}
