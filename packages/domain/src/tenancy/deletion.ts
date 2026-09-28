import { z } from 'zod';
import type { Clock } from '@w360/core';
import {
  and,
  eq,
  isNull,
  memberships,
  sql,
  tenantDeletions,
  users,
  type Database,
  type Tx,
} from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
import { assertRecentSignIn } from '../authz/step-up';
import { recordAudit, type RequestMeta } from '../audit';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import { parseInput } from '../validation';

/**
 * Company deletion requested by an owner (P5-11, ADR-055). The company is due for deletion 14 days
 * after the request (set in `app.request_tenant_deletion`) and works as if suspended until then;
 * owners can cancel until the worker starts the deletion. Every owner and administrator is emailed
 * at each step.
 */
export const DELETION_GRACE_DAYS = 14;

export interface CompanyDeletionDeps extends OutboxDeps {
  db: Database;
  clock: Clock;
  appBaseUrl: string;
}

export interface CompanyDeletionView {
  id: string;
  requestedAt: Date;
  dueAt: Date;
  requestedByName: string | null;
  /** The worker has started: it can no longer be cancelled. */
  started: boolean;
}

const requestSchema = z.object({
  confirm: z.string().trim().min(1, 'Type the company address.').max(64),
});

/**
 * A moment in the company's time zone, for emails ("12 October 2026 at 14:05 GMT+5:30").
 * `timeZoneName` cannot be combined with `dateStyle`/`timeStyle`, so the parts are spelled out.
 */
export function formatCompanyTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
    timeZoneName: 'short',
  }).format(at);
}

/** Active owners and administrators, who hear about every step of a deletion. */
export async function deletionRecipients(
  tx: Tx,
  tenantId: string,
): Promise<{ userId: string; name: string; email: string }[]> {
  return tx
    .select({ userId: users.id, name: users.name, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.status, 'active'),
        sql`${memberships.roles} && ARRAY['owner', 'admin']::text[]`,
      ),
    )
    .orderBy(users.id);
}

export function createCompanyDeletionService(deps: CompanyDeletionDeps) {
  const { db } = deps;
  const settingsUrl = (slug: string) => `${deps.appBaseUrl}/c/${slug}/settings/data`;

  return {
    /** The open deletion of the company, if one is scheduled or running. */
    async status(ctx: TenantContext): Promise<CompanyDeletionView | null> {
      assertCan(ctx, 'tenant.read');
      const [row] = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: tenantDeletions.id,
              requestedAt: tenantDeletions.requestedAt,
              dueAt: tenantDeletions.dueAt,
              startedAt: tenantDeletions.startedAt,
              requestedByName: users.name,
            })
            .from(tenantDeletions)
            .leftJoin(users, eq(users.id, tenantDeletions.requestedByUserId))
            .where(
              and(
                eq(tenantDeletions.tenantId, ctx.tenant.id),
                isNull(tenantDeletions.cancelledAt),
                isNull(tenantDeletions.completedAt),
              ),
            ),
        { accessMode: 'read only' },
      );
      if (!row) return null;
      return {
        id: row.id,
        requestedAt: row.requestedAt,
        dueAt: row.dueAt,
        requestedByName: row.requestedByName,
        started: row.startedAt !== null,
      };
    },

    /**
     * Schedules the company's deletion. The owner types the company address to confirm; the
     * company is suspended at once and deleted after the grace period unless an owner cancels.
     */
    async request(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<{ deletionId: string; dueAt: Date }> {
      assertCan(ctx, 'tenant.delete');
      assertRecentSignIn(ctx, deps.clock.now());
      const data = parseInput(requestSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const result = await tx.execute<{ deletion_id: string; due_at: string | Date }>(
          sql`select deletion_id, due_at from app.request_tenant_deletion(${data.confirm})`,
        );
        const row = result.rows[0];
        if (!row) throw new Error('app.request_tenant_deletion returned no row');
        const dueAt = new Date(row.due_at);
        await recordAudit(
          tx,
          ctx,
          {
            action: 'tenant.deletion_requested',
            subjectType: 'tenant',
            subjectId: ctx.tenant.id,
            metadata: { deletionId: row.deletion_id, dueAt: dueAt.toISOString() },
          },
          meta,
        );
        const due = formatCompanyTime(dueAt, ctx.tenant.timezone);
        for (const person of await deletionRecipients(tx, ctx.tenant.id)) {
          await enqueueEmail(deps, tx, {
            to: person.email,
            tenantId: ctx.tenant.id,
            dedupeKey: `tenant-deletion:${row.deletion_id}:requested:${person.userId}`,
            payload: {
              kind: 'tenant.notice',
              companyName: ctx.tenant.name,
              subject: 'Company deletion scheduled',
              lines: [
                `${ctx.user.name} asked for ${ctx.tenant.name} to be deleted. It will be deleted on ${due}.`,
                'Until then the company works as if suspended: members can still read and export its data, but nothing is sent. Any owner can cancel the deletion in Settings, Company data.',
                'After that date its contacts, conversations, messages, templates, campaigns, automations and other data are deleted and cannot be recovered. Billing records are kept as the law requires.',
                'If you did not expect this, cancel the deletion and check who has owner access.',
              ],
              url: settingsUrl(ctx.tenant.slug),
              actionLabel: 'Review the deletion',
            },
          });
        }
        return { deletionId: row.deletion_id, dueAt };
      });
    },

    /** Cancels a scheduled deletion that has not started; the company returns to its status. */
    async cancel(ctx: TenantContext, meta: RequestMeta = {}): Promise<{ status: string }> {
      assertCan(ctx, 'tenant.delete');
      return db.run(ctx.scope, async (tx) => {
        const result = await tx.execute<{ status: string }>(
          sql`select app.cancel_tenant_deletion() as status`,
        );
        const status = result.rows[0]?.status;
        if (!status) throw new Error('app.cancel_tenant_deletion returned no status');
        await recordAudit(
          tx,
          ctx,
          {
            action: 'tenant.deletion_cancelled',
            subjectType: 'tenant',
            subjectId: ctx.tenant.id,
            metadata: { restoredStatus: status },
          },
          meta,
        );
        const now = formatCompanyTime(deps.clock.now(), ctx.tenant.timezone);
        const state =
          status === 'restricted'
            ? 'It is restricted because its plan has ended.'
            : status === 'suspended'
              ? 'It remains suspended by HyFib.'
              : 'It works as before.';
        for (const person of await deletionRecipients(tx, ctx.tenant.id)) {
          await enqueueEmail(deps, tx, {
            to: person.email,
            tenantId: ctx.tenant.id,
            payload: {
              kind: 'tenant.notice',
              companyName: ctx.tenant.name,
              subject: 'Company deletion cancelled',
              lines: [
                `${ctx.user.name} cancelled the deletion of ${ctx.tenant.name} on ${now}. ${state}`,
              ],
              url: settingsUrl(ctx.tenant.slug),
              actionLabel: 'Open company settings',
            },
          });
        }
        return { status };
      });
    },
  };
}

export type CompanyDeletionService = ReturnType<typeof createCompanyDeletionService>;
