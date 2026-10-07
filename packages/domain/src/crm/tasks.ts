import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  crmDeals,
  crmTasks,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  sql,
  type Database,
  type ReminderState,
  type TaskStatus,
  type Tx,
} from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
import type { NumberViewer } from '../contacts/number-masking';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { parseInput } from '../validation';
import {
  addActivity,
  assertCrmMember,
  assertLiveContact,
  contactRefs,
  crmChangedBy,
  lockContact,
  memberRefs,
  trimmed,
  uuidSchema,
  versionConflict,
  type ContactRef,
  type MemberRef,
} from './common';
import { scheduleTaskReminder } from './reminders';
import { endOfLocalDay } from './time';

export interface TaskItem {
  id: string;
  title: string;
  notes: string | null;
  dueAt: string | null;
  remindAt: string | null;
  reminderState: ReminderState;
  reminderDetail: string | null;
  status: TaskStatus;
  completedAt: string | null;
  assignee: MemberRef | null;
  contact: ContactRef | null;
  deal: { id: string; title: string } | null;
  version: number;
  createdAt: string;
}

const YEAR_MS = 365 * 24 * 3600_000;
/** A reminder may be set up to a minute in the past (clock differences between browser and server). */
const REMINDER_GRACE_MS = 60_000;

const when = z.iso.datetime({ offset: true, message: 'Enter a valid date and time.' }).nullable();

const createSchema = z.object({
  title: trimmed(200, 'a title'),
  notes: z
    .string()
    .trim()
    .max(2000, 'Notes are limited to 2000 characters.')
    .nullable()
    .default(null),
  dueAt: when.default(null),
  remindAt: when.default(null),
  assigneeMembershipId: uuidSchema,
  contactId: uuidSchema.nullable().default(null),
  dealId: uuidSchema.nullable().default(null),
});

const updateSchema = z.object({
  id: uuidSchema,
  expectedVersion: z.number().int().min(1),
  title: trimmed(200, 'a title'),
  notes: z.string().trim().max(2000, 'Notes are limited to 2000 characters.').nullable(),
  dueAt: when,
  remindAt: when,
  assigneeMembershipId: uuidSchema,
});

const versionSchema = z.object({ id: uuidSchema, expectedVersion: z.number().int().min(1) });

const listSchema = z.object({
  scope: z.enum(['mine', 'all']).default('mine'),
  status: z.enum(['open', 'done']).default('open'),
  assigneeMembershipId: uuidSchema.nullable().default(null),
});

/**
 * Why a due or reminder time is refused, named by its field, or null: a due date within five years,
 * and a new reminder in the future and within a year. Members' and keys' tasks share the rule.
 */
export function taskTimeIssue(
  dueAt: Date | null,
  remindAt: Date | null,
  now: Date,
  remindChanged: boolean,
): { path: 'dueAt' | 'remindAt'; message: string } | null {
  if (dueAt && Math.abs(dueAt.getTime() - now.getTime()) > 5 * YEAR_MS) {
    return { path: 'dueAt', message: 'Choose a due date within five years.' };
  }
  if (remindAt && remindChanged) {
    if (remindAt.getTime() < now.getTime() - REMINDER_GRACE_MS) {
      return { path: 'remindAt', message: 'Choose a reminder time in the future.' };
    }
    if (remindAt.getTime() - now.getTime() > YEAR_MS) {
      return { path: 'remindAt', message: 'Choose a reminder time within a year.' };
    }
  }
  return null;
}

/** What a member's save of a task's details writes, as `taskDetailsChanged` compares it. */
interface TaskDetails {
  title: string;
  notes: string | null;
  dueAt: Date | null;
  remindAt: Date | null;
  assigneeMembershipId: string;
}

/**
 * Whether a member's save changes anything the task events report (ADR-274, ADR-276), and so
 * records who made it: a save changing nothing moves the version on and keeps the latest changer
 * (ADR-278).
 */
export function taskDetailsChanged(task: TaskDetails, next: TaskDetails): boolean {
  const time = (at: Date | null) => at?.getTime() ?? null;
  return (
    next.title !== task.title ||
    next.notes !== task.notes ||
    time(next.dueAt) !== time(task.dueAt) ||
    time(next.remindAt) !== time(task.remindAt) ||
    next.assigneeMembershipId !== task.assigneeMembershipId
  );
}

function checkTimes(dueAt: Date | null, remindAt: Date | null, now: Date, remindChanged: boolean) {
  const issue = taskTimeIssue(dueAt, remindAt, now, remindChanged);
  if (issue) throw new AppError('validation_failed', issue.message);
}

/** Task rows as pages show them, with assignee, contact and deal. */
export async function taskItems(
  tx: Tx,
  tenantId: string,
  rows: (typeof crmTasks.$inferSelect)[],
  viewer: NumberViewer,
): Promise<TaskItem[]> {
  const members = await memberRefs(
    tx,
    tenantId,
    rows.map((r) => r.assigneeMembershipId),
  );
  const people = await contactRefs(
    tx,
    tenantId,
    rows.map((r) => r.contactId),
    viewer,
  );
  const dealIds = [...new Set(rows.map((r) => r.dealId).filter((id): id is string => id !== null))];
  const deals =
    dealIds.length > 0
      ? await tx
          .select({ id: crmDeals.id, title: crmDeals.title })
          .from(crmDeals)
          .where(and(eq(crmDeals.tenantId, tenantId), inArray(crmDeals.id, dealIds)))
      : [];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    notes: r.notes,
    dueAt: r.dueAt?.toISOString() ?? null,
    remindAt: r.remindAt?.toISOString() ?? null,
    reminderState: r.reminderState,
    reminderDetail: r.reminderDetail,
    status: r.status,
    completedAt: r.completedAt?.toISOString() ?? null,
    assignee: members.get(r.assigneeMembershipId) ?? null,
    contact: r.contactId ? (people.get(r.contactId) ?? null) : null,
    deal: r.dealId ? (deals.find((d) => d.id === r.dealId) ?? null) : null,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Open tasks first by due time (tasks without one last), then the most recently done. */
export async function tasksWhere(
  tx: Tx,
  tenantId: string,
  filter: { contactId?: string; dealId?: string; status: 'open' | 'done' },
  viewer: NumberViewer,
): Promise<TaskItem[]> {
  const rows = await tx
    .select()
    .from(crmTasks)
    .where(
      and(
        eq(crmTasks.tenantId, tenantId),
        filter.contactId ? eq(crmTasks.contactId, filter.contactId) : undefined,
        filter.dealId ? eq(crmTasks.dealId, filter.dealId) : undefined,
        filter.status === 'open'
          ? eq(crmTasks.status, 'open')
          : inArray(crmTasks.status, ['done', 'cancelled']),
      ),
    )
    .orderBy(
      ...(filter.status === 'open'
        ? [sql`${crmTasks.dueAt} asc nulls last`, asc(crmTasks.createdAt)]
        : [desc(crmTasks.completedAt)]),
    )
    .limit(100);
  return taskItems(tx, tenantId, rows, viewer);
}

async function lockTask(tx: Tx, tenantId: string, id: string, expectedVersion: number) {
  const [task] = await tx
    .select()
    .from(crmTasks)
    .where(and(eq(crmTasks.tenantId, tenantId), eq(crmTasks.id, id)))
    .for('update');
  if (!task) throw notFound('Task');
  if (task.version !== expectedVersion) throw versionConflict();
  return task;
}

/**
 * Locks a task for a change, after locking its contact (if any) against erasure, in the order
 * erasure takes them. A task's contact never changes, so reading it before the locks is safe.
 */
async function lockTaskForChange(tx: Tx, tenantId: string, id: string, expectedVersion: number) {
  const [ref] = await tx
    .select({ contactId: crmTasks.contactId })
    .from(crmTasks)
    .where(and(eq(crmTasks.tenantId, tenantId), eq(crmTasks.id, id)));
  if (!ref) throw notFound('Task');
  if (ref.contactId) await lockContact(tx, tenantId, ref.contactId);
  return lockTask(tx, tenantId, id, expectedVersion);
}

export function taskOperations(deps: {
  db: Database;
  clock: Clock;
  jobs: JobQueue;
  signer: JobSigner;
}) {
  const { db, clock } = deps;

  async function setStatus(
    ctx: TenantContext,
    input: unknown,
    status: TaskStatus,
    kind: 'task_completed' | 'task_cancelled' | 'task_reopened',
  ) {
    assertCan(ctx, 'crm.write');
    const data = parseInput(versionSchema, input);
    return db.run(ctx.scope, async (tx) => {
      const task = await lockTaskForChange(tx, ctx.tenant.id, data.id, data.expectedVersion);
      if (task.status === status) return { version: task.version };
      if (status !== 'open' && task.status !== 'open') {
        throw new AppError('conflict', 'Reopen the task first.');
      }
      const now = clock.now();
      const closing = status !== 'open';
      const version = task.version + 1;
      await tx
        .update(crmTasks)
        .set({
          status,
          completedAt: closing ? now : null,
          completedByMembershipId: closing ? ctx.membership.id : null,
          // A closed task sends no reminder; reopening does not bring a skipped one back.
          ...(closing && task.reminderState === 'pending'
            ? { reminderState: 'skipped' as const, reminderDetail: 'task_closed', remindedAt: now }
            : {}),
          version,
          ...crmChangedBy('member'),
        })
        .where(and(eq(crmTasks.tenantId, ctx.tenant.id), eq(crmTasks.id, task.id)));
      if (task.contactId) {
        await addActivity(tx, {
          tenantId: ctx.tenant.id,
          contactId: task.contactId,
          dealId: task.dealId,
          taskId: task.id,
          actorMembershipId: ctx.membership.id,
          kind,
          at: now,
        });
      }
      return { version };
    });
  }

  return {
    async listTasks(ctx: TenantContext, input: unknown = {}) {
      assertCan(ctx, 'crm.read');
      const data = parseInput(listSchema, input);
      const assignee =
        data.scope === 'mine' ? ctx.membership.id : (data.assigneeMembershipId ?? null);
      return db.run(
        ctx.scope,
        async (tx) => {
          const rows = await tx
            .select()
            .from(crmTasks)
            .where(
              and(
                eq(crmTasks.tenantId, ctx.tenant.id),
                assignee ? eq(crmTasks.assigneeMembershipId, assignee) : undefined,
                data.status === 'open'
                  ? eq(crmTasks.status, 'open')
                  : inArray(crmTasks.status, ['done', 'cancelled']),
              ),
            )
            .orderBy(
              ...(data.status === 'open'
                ? [sql`${crmTasks.dueAt} asc nulls last`, asc(crmTasks.createdAt)]
                : [desc(crmTasks.completedAt)]),
            )
            .limit(200);
          return taskItems(tx, ctx.tenant.id, rows, ctx);
        },
        { accessMode: 'read only' },
      );
    },

    /** The member's open tasks that are overdue or due today (company time zone). */
    async taskCounts(ctx: TenantContext): Promise<{ overdue: number; dueToday: number }> {
      if (!ctx.permissions.has('crm.read')) return { overdue: 0, dueToday: 0 };
      const now = clock.now();
      const endOfDay = endOfLocalDay(now, ctx.tenant.timezone);
      return db.run(
        ctx.scope,
        async (tx) => {
          const [row] = await tx
            .select({
              overdue: sql<number>`count(*) filter (where ${crmTasks.dueAt} < ${now.toISOString()}::timestamptz)::int`,
              dueToday: sql<number>`count(*) filter (where ${crmTasks.dueAt} >= ${now.toISOString()}::timestamptz)::int`,
            })
            .from(crmTasks)
            .where(
              and(
                eq(crmTasks.tenantId, ctx.tenant.id),
                eq(crmTasks.assigneeMembershipId, ctx.membership.id),
                eq(crmTasks.status, 'open'),
                isNotNull(crmTasks.dueAt),
                lt(crmTasks.dueAt, endOfDay),
              ),
            );
          return { overdue: row?.overdue ?? 0, dueToday: row?.dueToday ?? 0 };
        },
        { accessMode: 'read only' },
      );
    },

    async createTask(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'crm.write');
      const data = parseInput(createSchema, input);
      const now = clock.now();
      const dueAt = data.dueAt ? new Date(data.dueAt) : null;
      const remindAt = data.remindAt ? new Date(data.remindAt) : null;
      checkTimes(dueAt, remindAt, now, true);
      return db.run(ctx.scope, async (tx) => {
        await assertCrmMember(tx, ctx.tenant.id, data.assigneeMembershipId);
        let contactId = data.contactId;
        if (data.dealId) {
          const [deal] = await tx
            .select({ contactId: crmDeals.contactId })
            .from(crmDeals)
            .where(and(eq(crmDeals.tenantId, ctx.tenant.id), eq(crmDeals.id, data.dealId)));
          if (!deal) throw notFound('Deal');
          if (contactId && contactId !== deal.contactId) {
            throw new AppError('validation_failed', 'The deal belongs to another contact.');
          }
          contactId = deal.contactId;
        }
        if (contactId) await assertLiveContact(tx, ctx.tenant.id, contactId);
        const id = uuidv7();
        await tx.insert(crmTasks).values({
          id,
          tenantId: ctx.tenant.id,
          title: data.title,
          notes: data.notes || null,
          contactId,
          dealId: data.dealId,
          assigneeMembershipId: data.assigneeMembershipId,
          dueAt,
          remindAt,
          reminderState: remindAt ? 'pending' : 'none',
          createdByMembershipId: ctx.membership.id,
        });
        if (remindAt) {
          await scheduleTaskReminder(deps, tx, { tenantId: ctx.tenant.id, taskId: id, remindAt });
        }
        if (contactId) {
          await addActivity(tx, {
            tenantId: ctx.tenant.id,
            contactId,
            dealId: data.dealId,
            taskId: id,
            actorMembershipId: ctx.membership.id,
            kind: 'task_created',
            at: now,
          });
        }
        return { id };
      });
    },

    /** Edits an open task; a changed reminder time schedules a new reminder. */
    async updateTask(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'crm.write');
      const data = parseInput(updateSchema, input);
      const now = clock.now();
      const dueAt = data.dueAt ? new Date(data.dueAt) : null;
      const remindAt = data.remindAt ? new Date(data.remindAt) : null;
      return db.run(ctx.scope, async (tx) => {
        const task = await lockTaskForChange(tx, ctx.tenant.id, data.id, data.expectedVersion);
        if (task.status !== 'open') throw new AppError('conflict', 'Reopen the task to edit it.');
        const remindChanged = (task.remindAt?.getTime() ?? null) !== (remindAt?.getTime() ?? null);
        checkTimes(dueAt, remindAt, now, remindChanged);
        if (data.assigneeMembershipId !== task.assigneeMembershipId) {
          await assertCrmMember(tx, ctx.tenant.id, data.assigneeMembershipId);
        }
        const changed = taskDetailsChanged(task, {
          title: data.title,
          notes: data.notes || null,
          dueAt,
          remindAt,
          assigneeMembershipId: data.assigneeMembershipId,
        });
        const version = task.version + 1;
        await tx
          .update(crmTasks)
          .set({
            title: data.title,
            notes: data.notes || null,
            dueAt,
            assigneeMembershipId: data.assigneeMembershipId,
            ...(remindChanged
              ? {
                  remindAt,
                  reminderState: remindAt ? ('pending' as const) : ('none' as const),
                  reminderDetail: null,
                  remindedAt: null,
                }
              : {}),
            version,
            ...(changed ? crmChangedBy('member') : {}),
          })
          .where(and(eq(crmTasks.tenantId, ctx.tenant.id), eq(crmTasks.id, task.id)));
        if (remindChanged && remindAt) {
          await scheduleTaskReminder(deps, tx, {
            tenantId: ctx.tenant.id,
            taskId: task.id,
            remindAt,
          });
        }
        return { version };
      });
    },

    completeTask: (ctx: TenantContext, input: unknown) =>
      setStatus(ctx, input, 'done', 'task_completed'),
    cancelTask: (ctx: TenantContext, input: unknown) =>
      setStatus(ctx, input, 'cancelled', 'task_cancelled'),
    reopenTask: (ctx: TenantContext, input: unknown) =>
      setStatus(ctx, input, 'open', 'task_reopened'),
  };
}
