import { z } from 'zod';
import { AppError, forbidden, notFound, uuidv7, type Clock } from '@w360/core';
import {
  and,
  authenticatedUserScope,
  desc,
  eq,
  gt,
  isNull,
  platformAdmins,
  platformAuditEvents,
  plans,
  sql,
  supportAccessGrants,
  tenantDeletions,
  tenantPlans,
  tenants,
  users,
  auditEvents,
  SUPPORT_SCOPES,
  type Database,
  type Tx,
} from '@w360/db';
import type { PlatformDatabase } from '@w360/db/platform';
import { planGivesAccess } from '../plans/model';
import { STAFF_DELETION_REASON } from '../tenancy/deletion';

/**
 * Platform administration (HyFib staff). Separately authorised from tenant roles: the actor must be
 * listed in ops.platform_admins and must have MFA enabled. All actions are written to the platform
 * audit log, and actions affecting a company are also written to that company's audit log so the
 * company can see what platform staff did and why.
 */
export interface PlatformActor {
  userId: string;
  role: 'platform_owner' | 'platform_operator';
  correlationId: string;
}

export interface PlatformDeps {
  db: Database;
  platformDb: PlatformDatabase;
  clock: Clock;
}

const statusChangeSchema = z.object({
  tenantId: z.uuid(),
  status: z.enum(['active', 'suspended']),
  reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(2000),
});

const supportGrantSchema = z.object({
  tenantId: z.uuid(),
  reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(2000),
  scopes: z.array(z.enum(SUPPORT_SCOPES)).min(1).max(SUPPORT_SCOPES.length),
  durationMinutes: z.number().int().min(15).max(480),
});

const staffDeletionReason = z
  .string()
  .trim()
  .min(STAFF_DELETION_REASON.min, 'Give a reason of at least 10 characters; the company reads it.')
  .max(STAFF_DELETION_REASON.max, 'Keep the reason under 1,000 characters.');

/** A platform owner schedules a company's deletion (ADR-090): the address typed, and a reason. */
const scheduleDeletionSchema = z.object({
  tenantId: z.uuid(),
  confirm: z.string().trim().min(1, 'Type the company address.').max(64),
  reason: staffDeletionReason,
});

const cancelDeletionSchema = z.object({ tenantId: z.uuid(), reason: staffDeletionReason });

const mfaResetSchema = z.object({
  userId: z.string().min(1).max(200),
  reason: z.string().trim().min(10).max(2000),
});

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError('validation_failed', 'Please correct the highlighted fields.', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

const tenantSummaryColumns = {
  id: tenants.id,
  slug: tenants.slug,
  name: tenants.name,
  status: tenants.status,
  statusReason: tenants.statusReason,
  billingMode: tenants.billingMode,
  createdAt: tenants.createdAt,
  planStatus: tenantPlans.status,
  planName: plans.name,
  planVersion: plans.version,
};

/** Adds active seat counts through the platform's aggregate-only definer function. */
async function withActiveMemberCounts<T extends { id: string }>(
  tx: Tx,
  rows: T[],
): Promise<(T & { activeMembers: number })[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const counts = await tx.execute<{ tenant_id: string; active_members: number }>(
    // sql.param keeps the array a single bound parameter (a plain array would expand to a list).
    sql`select tenant_id, active_members from ops.platform_active_member_counts(${sql.param(ids)}::uuid[])`,
  );
  const byTenant = new Map(counts.rows.map((c) => [c.tenant_id, Number(c.active_members)]));
  return rows.map((r) => ({ ...r, activeMembers: byTenant.get(r.id) ?? 0 }));
}

export function createPlatformService(deps: PlatformDeps) {
  const { db, platformDb, clock } = deps;

  return {
    /** Returns the platform actor for a user, or null if they are not platform staff with MFA. */
    async resolveActor(userId: string, correlationId: string): Promise<PlatformActor | null> {
      const row = await db.run(
        authenticatedUserScope(userId),
        async (tx) => {
          const rows = await tx
            .select({ role: platformAdmins.role, mfa: users.twoFactorEnabled })
            .from(platformAdmins)
            .innerJoin(users, eq(users.id, platformAdmins.userId))
            .where(eq(platformAdmins.userId, userId));
          return rows[0];
        },
        { accessMode: 'read only' },
      );
      if (!row || !row.mfa) return null;
      return { userId, role: row.role, correlationId };
    },

    async listTenants(actor: PlatformActor, options: { search?: string; limit?: number } = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const search = options.search?.trim().toLowerCase();
      return platformDb.run(actor.userId, async (tx) => {
        const rows = await tx
          .select(tenantSummaryColumns)
          .from(tenants)
          .leftJoin(tenantPlans, eq(tenantPlans.tenantId, tenants.id))
          .leftJoin(plans, eq(plans.id, tenantPlans.planId))
          .where(
            search
              ? sql`(lower(${tenants.name}) like ${`%${search}%`} or ${tenants.slug} like ${`%${search}%`})`
              : undefined,
          )
          .orderBy(desc(tenants.createdAt))
          .limit(limit);
        return withActiveMemberCounts(tx, rows);
      });
    },

    /** One company by id (not limited to the newest companies shown in the list). */
    async getTenant(actor: PlatformActor, tenantId: string) {
      if (!z.uuid().safeParse(tenantId).success) return null;
      return platformDb.run(actor.userId, async (tx) => {
        const rows = await tx
          .select(tenantSummaryColumns)
          .from(tenants)
          .leftJoin(tenantPlans, eq(tenantPlans.tenantId, tenants.id))
          .leftJoin(plans, eq(plans.id, tenantPlans.planId))
          .where(eq(tenants.id, tenantId));
        const [company] = await withActiveMemberCounts(tx, rows);
        return company ?? null;
      });
    },

    async setTenantStatus(actor: PlatformActor, input: unknown): Promise<void> {
      const data = parse(statusChangeSchema, input);
      await platformDb.run(actor.userId, async (tx) => {
        const [current] = await tx
          .select({ status: tenants.status })
          .from(tenants)
          .where(eq(tenants.id, data.tenantId))
          .for('update');
        if (!current) throw notFound('Company');
        if (current.status === 'deleted' || current.status === 'pending_deletion') {
          throw new AppError(
            'precondition_failed',
            'Companies being deleted cannot change status here.',
          );
        }
        if (current.status === data.status) return;
        let next: 'active' | 'suspended' | 'restricted' = data.status;
        let statusReason = data.reason;
        if (data.status === 'active') {
          // A lapsed plan restricts the company; only a plan change lifts that (ADR-051).
          if (current.status === 'restricted') {
            throw new AppError(
              'precondition_failed',
              "This company is restricted because its plan ended. Change the company's plan to lift the restriction.",
            );
          }
          const [plan] = await tx
            .select({ status: tenantPlans.status })
            .from(tenantPlans)
            .where(eq(tenantPlans.tenantId, data.tenantId))
            .for('update');
          if (plan && !planGivesAccess(plan.status)) {
            next = 'restricted';
            // As the plan state sets it (0023): the reason shown to the company.
            statusReason =
              plan.status === 'canceled' ? 'The plan was canceled.' : 'The plan ended.';
          }
        }
        await tx
          .update(tenants)
          .set({ status: next, statusReason, statusChangedAt: clock.now() })
          .where(eq(tenants.id, data.tenantId));
        const action =
          data.status === 'suspended' ? 'platform.tenant_suspended' : 'platform.tenant_reactivated';
        await tx.insert(platformAuditEvents).values({
          id: uuidv7(),
          actorUserId: actor.userId,
          action,
          targetTenantId: data.tenantId,
          reason: data.reason,
          result: 'success',
          correlationId: actor.correlationId,
        });
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: data.tenantId,
          actorType: 'platform_admin',
          actorId: actor.userId,
          action,
          subjectType: 'tenant',
          subjectId: data.tenantId,
          result: 'success',
          correlationId: actor.correlationId,
          metadata: { reason: data.reason, status: next },
        });
      });
    },

    async grantSupportAccess(
      actor: PlatformActor,
      input: unknown,
    ): Promise<{ grantId: string; expiresAt: Date }> {
      const data = parse(supportGrantSchema, input);
      const grantId = uuidv7();
      const expiresAt = new Date(clock.now().getTime() + data.durationMinutes * 60_000);
      await platformDb.run(actor.userId, async (tx) => {
        const [exists] = await tx
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.id, data.tenantId));
        if (!exists) throw notFound('Company');
        await tx.insert(supportAccessGrants).values({
          id: grantId,
          tenantId: data.tenantId,
          platformUserId: actor.userId,
          reason: data.reason,
          scopes: data.scopes,
          expiresAt,
        });
        await tx.insert(platformAuditEvents).values({
          id: uuidv7(),
          actorUserId: actor.userId,
          action: 'platform.support_access_granted',
          targetTenantId: data.tenantId,
          reason: data.reason,
          result: 'success',
          correlationId: actor.correlationId,
          metadata: { scopes: data.scopes, expiresAt: expiresAt.toISOString() },
        });
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: data.tenantId,
          actorType: 'platform_admin',
          actorId: actor.userId,
          action: 'platform.support_access_granted',
          subjectType: 'support_grant',
          subjectId: grantId,
          result: 'success',
          correlationId: actor.correlationId,
          metadata: {
            reason: data.reason,
            scopes: data.scopes,
            expiresAt: expiresAt.toISOString(),
          },
        });
      });
      return { grantId, expiresAt };
    },

    async revokeSupportAccess(actor: PlatformActor, grantId: string): Promise<void> {
      if (!z.uuid().safeParse(grantId).success) throw notFound('Support grant');
      await platformDb.run(actor.userId, async (tx) => {
        const updated = await tx
          .update(supportAccessGrants)
          .set({ revokedAt: clock.now(), revokedBy: actor.userId })
          .where(and(eq(supportAccessGrants.id, grantId), isNull(supportAccessGrants.revokedAt)))
          .returning({ tenantId: supportAccessGrants.tenantId });
        const row = updated[0];
        if (!row) throw notFound('Active support grant');
        await tx.insert(platformAuditEvents).values({
          id: uuidv7(),
          actorUserId: actor.userId,
          action: 'platform.support_access_revoked',
          targetTenantId: row.tenantId,
          result: 'success',
          correlationId: actor.correlationId,
          metadata: { grantId },
        });
        // The company sees when platform access to its data ended, not only when it began.
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: row.tenantId,
          actorType: 'platform_admin',
          actorId: actor.userId,
          action: 'platform.support_access_revoked',
          subjectType: 'support_grant',
          subjectId: grantId,
          result: 'success',
          correlationId: actor.correlationId,
          metadata: {},
        });
      });
    },

    async listActiveGrants(actor: PlatformActor) {
      return platformDb.run(actor.userId, async (tx) =>
        tx
          .select({
            id: supportAccessGrants.id,
            tenantId: supportAccessGrants.tenantId,
            tenantName: tenants.name,
            platformUserId: supportAccessGrants.platformUserId,
            reason: supportAccessGrants.reason,
            scopes: supportAccessGrants.scopes,
            expiresAt: supportAccessGrants.expiresAt,
          })
          .from(supportAccessGrants)
          .innerJoin(tenants, eq(tenants.id, supportAccessGrants.tenantId))
          .where(
            and(
              isNull(supportAccessGrants.revokedAt),
              gt(supportAccessGrants.expiresAt, clock.now()),
            ),
          )
          .orderBy(desc(supportAccessGrants.createdAt)),
      );
    },

    async recentPlatformAudit(actor: PlatformActor, limit = 100) {
      return platformDb.run(actor.userId, async (tx) =>
        tx
          .select()
          .from(platformAuditEvents)
          .orderBy(desc(platformAuditEvents.occurredAt))
          .limit(Math.min(Math.max(limit, 1), 500)),
      );
    },

    /**
     * Owners of one company for account recovery. Uses a narrow definer function: the full membership
     * directory is customer data and needs a members.read support grant.
     */
    async tenantOwners(actor: PlatformActor, tenantId: string) {
      if (!z.uuid().safeParse(tenantId).success) throw notFound('Company');
      return platformDb.run(actor.userId, async (tx) => {
        const result = await tx.execute<{
          user_id: string;
          name: string;
          membership_status: string;
          two_factor_enabled: boolean;
        }>(sql`select * from ops.platform_tenant_owners(${tenantId}::uuid)`);
        return result.rows.map((r) => ({
          userId: r.user_id,
          name: r.name,
          status: r.membership_status,
          twoFactorEnabled: r.two_factor_enabled,
        }));
      });
    },

    /**
     * Schedules the company's deletion for HyFib (platform owners, ADR-090): due in 14 days, the
     * company working as if suspended until then, its owners and administrators emailed by the
     * worker. Refused while the company is already being deleted.
     */
    async scheduleTenantDeletion(
      actor: PlatformActor,
      input: unknown,
    ): Promise<{ deletionId: string; dueAt: Date }> {
      const data = parse(scheduleDeletionSchema, input);
      if (actor.role !== 'platform_owner') {
        throw forbidden('Only a platform owner can schedule a company’s deletion.');
      }
      return platformDb.run(actor.userId, async (tx) => {
        const result = await tx.execute<{ deletion_id: string; due_at: string | Date }>(
          sql`select deletion_id, due_at from ops.platform_request_tenant_deletion(
                ${data.tenantId}::uuid, ${data.confirm}, ${data.reason}, ${actor.correlationId})`,
        );
        const row = result.rows[0];
        if (!row) throw new Error('ops.platform_request_tenant_deletion returned no row');
        return { deletionId: row.deletion_id, dueAt: new Date(row.due_at) };
      });
    },

    /**
     * Cancels a deletion HyFib scheduled, before it starts (platform owners, ADR-090); the company
     * returns to the status it had. A deletion an owner asked for is refused: only owners cancel it.
     */
    async cancelTenantDeletion(actor: PlatformActor, input: unknown): Promise<{ status: string }> {
      const data = parse(cancelDeletionSchema, input);
      if (actor.role !== 'platform_owner') {
        throw forbidden('Only a platform owner can cancel a company’s deletion.');
      }
      return platformDb.run(actor.userId, async (tx) => {
        const result = await tx.execute<{ status: string }>(
          sql`select ops.platform_cancel_tenant_deletion(${data.tenantId}::uuid, ${data.reason},
                ${actor.correlationId}) as status`,
        );
        const status = result.rows[0]?.status;
        if (!status) throw new Error('ops.platform_cancel_tenant_deletion returned no status');
        return { status };
      });
    },

    /**
     * The company's latest deletion request, if any (ADR-055): dates, state, provider cleanup, and
     * who scheduled or cancelled it and why (ADR-090).
     */
    async tenantDeletion(actor: PlatformActor, tenantId: string) {
      if (!z.uuid().safeParse(tenantId).success) throw notFound('Company');
      return platformDb.run(actor.userId, async (tx) => {
        const [row] = await tx
          .select({
            id: tenantDeletions.id,
            requestedAt: tenantDeletions.requestedAt,
            dueAt: tenantDeletions.dueAt,
            previousStatus: tenantDeletions.previousStatus,
            cancelledAt: tenantDeletions.cancelledAt,
            startedAt: tenantDeletions.startedAt,
            attempts: tenantDeletions.attempts,
            providerCleanup: tenantDeletions.providerCleanup,
            providerCleanupAt: tenantDeletions.providerCleanupAt,
            rowsDeleted: tenantDeletions.rowsDeleted,
            completedAt: tenantDeletions.completedAt,
            requestedBy: tenantDeletions.requestedBy,
            reason: tenantDeletions.reason,
            cancelledBy: tenantDeletions.cancelledBy,
            cancelReason: tenantDeletions.cancelReason,
          })
          .from(tenantDeletions)
          .where(eq(tenantDeletions.tenantId, tenantId))
          .orderBy(desc(tenantDeletions.requestedAt), desc(tenantDeletions.id))
          .limit(1);
        return row ?? null;
      });
    },

    async resetUserMfa(actor: PlatformActor, input: unknown): Promise<void> {
      const data = parse(mfaResetSchema, input);
      if (actor.role !== 'platform_owner' && actor.role !== 'platform_operator') throw forbidden();
      await platformDb.run(actor.userId, async (tx) => {
        await tx.execute(sql`select ops.platform_reset_user_mfa(${data.userId}, ${data.reason})`);
      });
    },
  };
}

export type PlatformService = ReturnType<typeof createPlatformService>;
