import { z } from 'zod';
import type { Clock } from '@w360/core';
import {
  and,
  authorizedTenantScope,
  eq,
  isNull,
  memberships,
  sql,
  systemScope,
  tenantDeletions,
  tenants,
  users,
  type Database,
  type Tx,
} from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
import { assertRecentSignIn } from '../authz/step-up';
import { recordAudit, type RequestMeta } from '../audit';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import { NOTICE_LINE_MAX, splitEmailText } from '../email/templates';
import { parseInput } from '../validation';

/**
 * Company deletion requested by an owner (P5-11, ADR-055) or scheduled by HyFib staff (ADR-090).
 * The company is due for deletion 14 days after the request (set in `app.request_tenant_deletion`
 * and `ops.platform_request_tenant_deletion`) and works as if suspended until then; whoever
 * scheduled it can cancel until the worker starts the deletion (owners their own, platform owners
 * HyFib's). Every owner and administrator is emailed at each step.
 */
export const DELETION_GRACE_DAYS = 14;

/** A staff deletion's reason, and a staff cancellation's: the company reads both. */
export const STAFF_DELETION_REASON = { min: 10, max: 1000 } as const;

export interface CompanyDeletionDeps extends OutboxDeps {
  db: Database;
  clock: Clock;
  appBaseUrl: string;
}

export interface CompanyDeletionView {
  id: string;
  requestedAt: Date;
  dueAt: Date;
  /** An owner asked for it, or HyFib staff scheduled it (ADR-090); only they can cancel it. */
  requestedBy: 'owner' | 'platform';
  /** The owner who asked; never the staff member. */
  requestedByName: string | null;
  /** HyFib's reason, for a deletion staff scheduled. */
  reason: string | null;
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

/** What a company is once its deletion is cancelled, for the email. */
function statusSentence(status: string): string {
  return status === 'restricted'
    ? 'It is restricted because its plan has ended.'
    : status === 'suspended'
      ? 'It remains suspended by HyFib.'
      : 'It works as before.';
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
              requestedBy: tenantDeletions.requestedBy,
              reason: tenantDeletions.reason,
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
      const byOwner = row.requestedBy === 'owner';
      return {
        id: row.id,
        requestedAt: row.requestedAt,
        dueAt: row.dueAt,
        requestedBy: row.requestedBy,
        // Staff are never named to companies ("HyFib platform staff" in the audit log too).
        requestedByName: byOwner ? row.requestedByName : null,
        reason: byOwner ? null : row.reason,
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
        const state = statusSentence(status);
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

export interface StaffDeletionNoticeDeps {
  db: Database;
  outbox: OutboxDeps;
  appBaseUrl: string;
}

/**
 * The minute sweep's emails about deletions HyFib staff scheduled or cancelled (ADR-090): the
 * platform role cannot queue email, so the worker tells the company's owners and administrators,
 * each notice marked in the company's own scope in the transaction that queues its emails. A
 * company that fails is reported and tried again the next minute.
 */
export async function notifyStaffDeletions(
  deps: StaffDeletionNoticeDeps,
  limit = 50,
): Promise<{
  notified: number;
  failed: { tenantId: string; deletionId: string; notice: string; error: unknown }[];
}> {
  const due = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ tenant_id: string; deletion_id: string; notice: 'scheduled' | 'cancelled' }>(
        sql`select tenant_id, deletion_id, notice from ops.tenant_deletion_notices_due(${limit}::int)`,
      ),
    { accessMode: 'read only' },
  );
  let notified = 0;
  const failed: { tenantId: string; deletionId: string; notice: string; error: unknown }[] = [];
  for (const { tenant_id: tenantId, deletion_id: deletionId, notice } of due.rows) {
    // Tenant ids come from the deletion register, never from a request.
    const scope = authorizedTenantScope(tenantId, null);
    try {
      const told = await deps.db.run(scope, async (tx) => {
        const marked = await tx.execute<{ marked: boolean }>(
          sql`select app.tenant_deletion_mark_notified(${deletionId}::uuid, ${notice}) as marked`,
        );
        if (marked.rows[0]?.marked !== true) return false;
        const [row] = await tx
          .select({
            requestedAt: tenantDeletions.requestedAt,
            dueAt: tenantDeletions.dueAt,
            reason: tenantDeletions.reason,
            cancelledAt: tenantDeletions.cancelledAt,
            cancelReason: tenantDeletions.cancelReason,
            companyName: tenants.name,
            slug: tenants.slug,
            timezone: tenants.timezone,
            status: tenants.status,
          })
          .from(tenantDeletions)
          .innerJoin(tenants, eq(tenants.id, tenantDeletions.tenantId))
          .where(and(eq(tenantDeletions.tenantId, tenantId), eq(tenantDeletions.id, deletionId)));
        if (!row) return false;
        const at = (date: Date) => formatCompanyTime(date, row.timezone);
        const url = `${deps.appBaseUrl}/c/${row.slug}/settings/data`;
        const email =
          notice === 'scheduled'
            ? {
                subject: 'HyFib scheduled the company for deletion',
                lines: [
                  `HyFib scheduled ${row.companyName} for deletion. It will be deleted on ${at(row.dueAt)}.`,
                  ...splitEmailText(`HyFib's reason: ${row.reason ?? ''}`, NOTICE_LINE_MAX.tenant),
                  'Until then the company works as if suspended: members can still read its data and owners can download an export in Settings, Company data, but nothing is sent.',
                  'After that date its contacts, conversations, messages, templates, campaigns, automations and other data are deleted and cannot be recovered. Billing records are kept as the law requires.',
                  'Only HyFib can cancel this deletion. Contact HyFib support to discuss it.',
                ],
                actionLabel: 'Review the deletion',
              }
            : {
                subject: 'Company deletion cancelled',
                lines: [
                  `HyFib cancelled the deletion of ${row.companyName} on ${at(row.cancelledAt ?? row.requestedAt)}. ${statusSentence(row.status)}`,
                  ...splitEmailText(
                    `HyFib's reason: ${row.cancelReason ?? ''}`,
                    NOTICE_LINE_MAX.tenant,
                  ),
                ],
                actionLabel: 'Open company settings',
              };
        for (const person of await deletionRecipients(tx, tenantId)) {
          await enqueueEmail(deps.outbox, tx, {
            to: person.email,
            tenantId,
            dedupeKey: `tenant-deletion:${deletionId}:${notice}:${person.userId}`,
            payload: {
              kind: 'tenant.notice',
              companyName: row.companyName,
              subject: email.subject,
              lines: email.lines,
              url,
              actionLabel: email.actionLabel,
            },
          });
        }
        return true;
      });
      if (told) notified += 1;
    } catch (error) {
      failed.push({ tenantId, deletionId, notice, error });
    }
  }
  return { notified, failed };
}
