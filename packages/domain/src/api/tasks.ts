import { z } from 'zod';
import { notFound } from '@w360/core';
import {
  and,
  crmTasks,
  desc,
  eq,
  exactTimestamp,
  sql,
  TASK_STATUSES,
  type ReminderState,
  type TaskStatus,
} from '@w360/db';
import type { OutboundDeps } from '../messaging/outbound';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { assertScope, type ApiContext } from './context';
import { assertCrmInPlan } from './deals';
import { API_LIMITS } from './model';

/**
 * CRM tasks through the public API (ADR-258), read with `tasks.read`: the company's tasks as the
 * Tasks page and the contact and deal pages show them, whoever created them (a member or an
 * automation), with the assignee, the contact and the deal by id only. The CRM timeline is never
 * read, nor the contact's name or number (`contacts.read` reads those). A key needs the CRM in the
 * company's plan. Erasing a contact deletes its tasks, so they are no longer read; a merge moves
 * them to the contact kept.
 */

export const apiTaskListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
    status: z.enum(TASK_STATUSES).optional().describe('Only the tasks with this status.'),
    assigneeId: z.uuid().optional().describe('Only the tasks assigned to this member.'),
    contactId: z.uuid().optional().describe('Only the tasks about this contact.'),
    dealId: z.uuid().optional().describe('Only the tasks about this deal.'),
    updatedSince: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        'Only tasks changed at or after this time (created, edited, completed, cancelled or reopened, reminded, or moved to another contact by a merge).',
      ),
  })
  .strict();

export interface ApiTask {
  id: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  dueAt: string | null;
  remindAt: string | null;
  reminderState: ReminderState;
  /** When the reminder was emailed or skipped. */
  remindedAt: string | null;
  /** Why the reminder was skipped: `task_closed`, `too_late` or `assignee_inactive`. */
  reminderSkipReason: string | null;
  /** The member the task is assigned to (an id from GET /members). */
  assigneeId: string;
  contactId: string | null;
  dealId: string | null;
  /** When the task was completed or cancelled; null while open. */
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Moves on when members edit, complete, cancel or reopen the task. */
  version: number;
}

const taskColumns = {
  id: crmTasks.id,
  title: crmTasks.title,
  notes: crmTasks.notes,
  status: crmTasks.status,
  dueAt: crmTasks.dueAt,
  remindAt: crmTasks.remindAt,
  reminderState: crmTasks.reminderState,
  remindedAt: crmTasks.remindedAt,
  reminderDetail: crmTasks.reminderDetail,
  assigneeId: crmTasks.assigneeMembershipId,
  contactId: crmTasks.contactId,
  dealId: crmTasks.dealId,
  completedAt: crmTasks.completedAt,
  createdAt: crmTasks.createdAt,
  updatedAt: crmTasks.updatedAt,
  version: crmTasks.version,
  cursorAt: exactTimestamp(crmTasks.createdAt),
};

interface TaskRow {
  id: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  dueAt: Date | null;
  remindAt: Date | null;
  reminderState: ReminderState;
  remindedAt: Date | null;
  reminderDetail: string | null;
  assigneeId: string;
  contactId: string | null;
  dealId: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const toApiTask = (row: TaskRow): ApiTask => ({
  id: row.id,
  title: row.title,
  notes: row.notes,
  status: row.status,
  dueAt: row.dueAt?.toISOString() ?? null,
  remindAt: row.remindAt?.toISOString() ?? null,
  reminderState: row.reminderState,
  remindedAt: row.remindedAt?.toISOString() ?? null,
  reminderSkipReason: row.reminderDetail,
  assigneeId: row.assigneeId,
  contactId: row.contactId,
  dealId: row.dealId,
  completedAt: row.completedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  version: row.version,
});

/**
 * The company's tasks, open and closed, newest first by when they were created, on exact keyset
 * pages: a page never skips or repeats a task. Filters combine. Only reads, so it records nothing.
 */
export async function apiListTasks(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiTask[]; nextCursor: string | null }> {
  assertScope(ctx, 'tasks.read');
  const q = parseInput(apiTaskListQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      await assertCrmInPlan(tx, ctx.tenant.id);
      const rows = await tx
        .select(taskColumns)
        .from(crmTasks)
        .where(
          and(
            eq(crmTasks.tenantId, ctx.tenant.id),
            q.status ? eq(crmTasks.status, q.status) : undefined,
            q.assigneeId ? eq(crmTasks.assigneeMembershipId, q.assigneeId) : undefined,
            q.contactId ? eq(crmTasks.contactId, q.contactId) : undefined,
            q.dealId ? eq(crmTasks.dealId, q.dealId) : undefined,
            q.updatedSince
              ? sql`${crmTasks.updatedAt} >= ${q.updatedSince}::timestamptz`
              : undefined,
            cursor
              ? sql`(${crmTasks.createdAt}, ${crmTasks.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(crmTasks.createdAt), desc(crmTasks.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      const last = shown.at(-1);
      return {
        data: shown.map(toApiTask),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
}

/** One of the company's tasks. */
export async function apiGetTask(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  taskId: string,
): Promise<ApiTask> {
  assertScope(ctx, 'tasks.read');
  if (!z.uuid().safeParse(taskId).success) throw notFound('Task');
  const [task] = await deps.db.run(
    ctx.scope,
    async (tx) => {
      await assertCrmInPlan(tx, ctx.tenant.id);
      return tx
        .select(taskColumns)
        .from(crmTasks)
        .where(and(eq(crmTasks.tenantId, ctx.tenant.id), eq(crmTasks.id, taskId)));
    },
    { accessMode: 'read only' },
  );
  if (!task) throw notFound('Task');
  return toApiTask(task);
}
