import { type Clock } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  crmTasks,
  eq,
  memberships,
  sql,
  systemScope,
  tenants,
  users,
  type Database,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { permissionsForRoles } from '../authz/permissions';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';

/**
 * Task reminders (queue `crm.reminder`). The task row is the source of truth: a job scheduled for
 * the reminder time only signals it, the minute sweep signals reminders whose job was lost, and the
 * reminder is emailed once — the email is queued in the same transaction that marks the reminder
 * sent, under the task's row lock.
 */

/** Reminders more than this late (the company was suspended, the worker was down) are skipped. */
export const REMINDER_LATE_LIMIT_MS = 24 * 3600_000;

export async function scheduleTaskReminder(
  deps: { jobs: JobQueue; signer: JobSigner },
  tx: Tx | null,
  input: { tenantId: string; taskId: string; remindAt: Date },
): Promise<void> {
  await deps.jobs.enqueue(
    tx,
    QUEUES.crmReminder.name,
    deps.signer.sign({
      kind: 'crm.reminder',
      tenantId: input.tenantId,
      actorUserId: null,
      ref: input.taskId,
    }),
    { singletonKey: `${input.taskId}:${input.remindAt.getTime()}`, startAfter: input.remindAt },
  );
}

/** Reminders the sweep must signal (definer function; ids only, active companies only). */
export async function findDueReminders(
  db: Database,
  limit = 200,
): Promise<{ tenantId: string; taskId: string; remindAt: Date }[]> {
  return db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{ tenant_id: string; task_id: string; remind_at: string }>(
        sql`select tenant_id, task_id, remind_at from ops.crm_reminders_due(${limit})`,
      );
      return res.rows.map((r) => ({
        tenantId: r.tenant_id,
        taskId: r.task_id,
        remindAt: new Date(r.remind_at),
      }));
    },
    { accessMode: 'read only' },
  );
}

export interface ReminderDeps {
  db: Database;
  clock: Clock;
  outbox: OutboxDeps;
  appBaseUrl: string;
}

export type ReminderOutcome = 'sent' | 'skipped' | 'not_due' | 'idle';

/** Emails a due reminder to the task's assignee, or records why it was skipped. */
export async function sendTaskReminder(
  deps: ReminderDeps,
  scope: TenantScope,
  taskId: string,
): Promise<ReminderOutcome> {
  const tenantId = scope.tenantId;
  return deps.db.run(scope, async (tx) => {
    const now = deps.clock.now();
    const [task] = await tx
      .select()
      .from(crmTasks)
      .where(and(eq(crmTasks.tenantId, tenantId), eq(crmTasks.id, taskId)))
      .for('update');
    if (!task || task.status !== 'open' || task.reminderState !== 'pending' || !task.remindAt)
      return 'idle';
    if (task.remindAt > now) return 'not_due';

    const skip = async (detail: string) => {
      await tx
        .update(crmTasks)
        .set({ reminderState: 'skipped', reminderDetail: detail, remindedAt: now })
        .where(and(eq(crmTasks.tenantId, tenantId), eq(crmTasks.id, task.id)));
      return 'skipped' as const;
    };
    if (now.getTime() - task.remindAt.getTime() > REMINDER_LATE_LIMIT_MS) return skip('too_late');

    const [assignee] = await tx
      .select({
        status: memberships.status,
        roles: memberships.roles,
        name: sql<string>`coalesce(${memberships.displayName}, ${users.name})`,
        email: users.email,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(eq(memberships.tenantId, tenantId), eq(memberships.id, task.assigneeMembershipId)),
      );
    if (
      !assignee ||
      assignee.status !== 'active' ||
      !permissionsForRoles(assignee.roles).has('crm.read')
    ) {
      return skip('assignee_inactive');
    }
    const [company] = await tx
      .select({ name: tenants.name, slug: tenants.slug, timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!company) return 'idle';

    await enqueueEmail(deps.outbox, tx, {
      to: assignee.email,
      tenantId,
      dedupeKey: `crm.reminder:${task.id}:${task.version}:${task.remindAt.getTime()}`,
      payload: {
        kind: 'crm.task_reminder',
        companyName: company.name,
        name: assignee.name,
        taskTitle: task.title,
        due: task.dueAt ? formatInZone(task.dueAt, company.timezone) : null,
        url: new URL(`/c/${company.slug}/crm/tasks`, deps.appBaseUrl).toString(),
      },
    });
    await tx
      .update(crmTasks)
      .set({ reminderState: 'sent', remindedAt: now })
      .where(and(eq(crmTasks.tenantId, tenantId), eq(crmTasks.id, task.id)));
    return 'sent';
  });
}

function formatInZone(at: Date, timeZone: string): string {
  const text = new Intl.DateTimeFormat('en-IN', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(at);
  return `${text} (${timeZone})`;
}
