import { z } from 'zod';
import { AppError, notFound, uuidv7 } from '@w360/core';
import {
  and,
  contacts,
  crmDeals,
  crmTasks,
  desc,
  eq,
  exactTimestamp,
  sql,
  TASK_STATUSES,
  type CrmActivityKind,
  type CrmChanger,
  type ReminderState,
  type TaskStatus,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { addActivity, crmChangedBy, memberRefs } from '../crm/common';
import { scheduleTaskReminder } from '../crm/reminders';
import { taskTimeIssue } from '../crm/tasks';
import type { OutboundDeps } from '../messaging/outbound';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { apiContactNotFound } from './contact-view';
import { apiActor, assertScope, type ApiContext } from './context';
import { assertCrmInPlan, invalidField } from './deals';
import {
  claimIdempotencyKey,
  storeIdempotentResponse,
  type ApiResponse,
  type IdempotencyInput,
} from './idempotency';
import { API_LIMITS } from './model';

/**
 * CRM tasks through the public API (ADR-258), read with `tasks.read`: the company's tasks as the
 * Tasks page and the contact and deal pages show them, whoever created them (a member or an
 * automation), with the assignee, the contact and the deal by id only. The CRM timeline is never
 * read, nor the contact's name or number (`contacts.read` reads those). A key needs the CRM in the
 * company's plan. Erasing a contact deletes its tasks, so they are no longer read; a merge moves
 * them to the contact kept. With `tasks.write` a key creates tasks as members do (ADR-259) and
 * changes, completes, cancels and reopens them (ADR-260).
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

const taskTime = z.iso.datetime({ offset: true });

const taskTitle = z
  .string()
  .trim()
  .min(1, 'Give the task a title.')
  .max(200, 'A title is limited to 200 characters.');

const taskNotes = z
  .string()
  .trim()
  .max(2000, 'Notes are limited to 2000 characters.')
  .nullable()
  .describe('What the task is about, as members write it; empty or null for none.');

/** What `POST /tasks` takes: a task as members create one, about a contact, a deal or nobody. */
export const apiCreateTaskSchema = z
  .object({
    title: taskTitle,
    notes: taskNotes.optional(),
    assigneeId: z
      .uuid()
      .describe(
        'The member who does the task: an active member who can use the CRM (GET /members).',
      ),
    contactId: z
      .uuid()
      .optional()
      .describe('The customer the task is about, as GET /contacts gives them.'),
    dealId: z
      .uuid()
      .optional()
      .describe(
        'The deal the task is about (GET /deals): the task is about the deal’s contact too.',
      ),
    dueAt: taskTime.nullable().optional().describe('When the task is due, within five years.'),
    remindAt: taskTime
      .nullable()
      .optional()
      .describe('When to email the assignee a reminder: from now to a year ahead.'),
  })
  .strict();

/**
 * What `PATCH /tasks/{id}` takes (ADR-260): any of the task's details, as members edit an open task,
 * and a status that completes, cancels or reopens it, from the version expected when one is given.
 * A task's contact and deal do not change, as for members.
 */
export const apiUpdateTaskSchema = z
  .object({
    title: taskTitle.optional(),
    notes: taskNotes.optional(),
    assigneeId: z
      .uuid()
      .optional()
      .describe('Another active member who can use the CRM to do the task (GET /members).'),
    dueAt: taskTime
      .nullable()
      .optional()
      .describe('When the task is due, within five years, or null for no due time.'),
    remindAt: taskTime
      .nullable()
      .optional()
      .describe(
        'A new reminder time, from now to a year ahead, emailed to the assignee then, or null for none.',
      ),
    status: z
      .enum(TASK_STATUSES)
      .optional()
      .describe(
        '`done` completes and `cancelled` cancels the open task; `open` reopens a closed one.',
      ),
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Change the task only at this `version`: a task changed since is refused with 409 (read it again).',
      ),
  })
  .strict()
  .refine((change) => Object.keys(change).some((key) => key !== 'expectedVersion'), {
    message: 'Give at least one change: a detail or `status`.',
  });

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
  /** Moves on with every change; `PATCH /tasks/{id}` takes it as `expectedVersion` (ADR-260). */
  version: number;
  /**
   * Who made the latest change the task events report (ADR-278), with the key for `api`; null
   * while the task is as it was added and when the change did not record its maker (ADR-277).
   */
  changedBy: CrmChanger | null;
  changedByApiKeyId: string | null;
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
  changedBy: crmTasks.changedBy,
  changedByApiKeyId: crmTasks.changedByApiKeyId,
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
  changedBy: CrmChanger | null;
  changedByApiKeyId: string | null;
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
  changedBy: row.changedBy,
  changedByApiKeyId: row.changedByApiKeyId,
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

/**
 * Creates a task as members do (ADR-259), recorded as created by the key: about one of the
 * company's contacts (not erased), one of its deals and so the deal's contact, or nobody, assigned
 * to an active member who can use the CRM, its reminder scheduled when one is set. The contact is
 * locked against erasure and merges until the task is in, as members' tasks lock it. The
 * `task_created` activity of a task about a contact has no member actor and names the key, so the
 * timeline says it came through the API; the audit log names the key. With an Idempotency-Key a
 * retry answers the first response.
 */
export async function apiCreateTask(
  deps: Pick<OutboundDeps, 'db' | 'clock' | 'jobs' | 'signer'>,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput | null,
): Promise<ApiResponse> {
  assertScope(ctx, 'tasks.write');
  const data = parseInput(apiCreateTaskSchema, input);
  const now = deps.clock.now();
  const dueAt = data.dueAt ? new Date(data.dueAt) : null;
  const remindAt = data.remindAt ? new Date(data.remindAt) : null;
  return deps.db.run(ctx.scope, async (tx) => {
    // Claimed in the task's transaction, so a refused task leaves the key unused (ADR-052), and
    // before the times are checked, so a retry after the reminder time answers the first response.
    let claimed: string | null = null;
    if (idempotency) {
      const claim = await claimIdempotencyKey(tx, ctx, idempotency, now);
      if ('replay' in claim) return claim.replay;
      claimed = claim.claimed;
    }
    const timeIssue = taskTimeIssue(dueAt, remindAt, now, true);
    if (timeIssue) throw invalidField(timeIssue.path, timeIssue.message);
    await assertCrmInPlan(tx, ctx.tenant.id);
    if (!(await memberRefs(tx, ctx.tenant.id, [data.assigneeId])).get(data.assigneeId)?.active) {
      throw invalidField(
        'assigneeId',
        'Give the id of an active member who can use the CRM (GET /members).',
      );
    }
    let contactId = data.contactId ?? null;
    const dealId = data.dealId ?? null;
    if (dealId) {
      const [deal] = await tx
        .select({ contactId: crmDeals.contactId })
        .from(crmDeals)
        .where(and(eq(crmDeals.tenantId, ctx.tenant.id), eq(crmDeals.id, dealId)));
      if (!deal) {
        throw invalidField('dealId', 'Give the id of one of the company’s deals (GET /deals).');
      }
      if (contactId && contactId !== deal.contactId) {
        throw invalidField(
          'contactId',
          'The deal is another contact’s: leave `contactId` out, or give the deal’s contact.',
        );
      }
      contactId = deal.contactId;
    }
    if (contactId) {
      const [contact] = await tx
        .select({ erasedAt: contacts.erasedAt })
        .from(contacts)
        .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, contactId)))
        .for('key share');
      if (dealId) {
        // Merges lock both contacts first, so once the deal's contact is locked the deal stays
        // with it; a contact gone means a merge moved the deal between the reads.
        if (!contact) {
          throw new AppError('conflict', 'The deal moved to another contact meanwhile; try again.');
        }
        if (contact.erasedAt) {
          throw new AppError(
            'conflict',
            'The deal’s contact was erased, so it takes no new tasks.',
          );
        }
      } else if (!contact || contact.erasedAt) {
        throw await apiContactNotFound(tx, ctx.tenant.id, contactId);
      }
    }
    const id = uuidv7();
    await tx.insert(crmTasks).values({
      id,
      tenantId: ctx.tenant.id,
      title: data.title,
      notes: data.notes || null,
      contactId,
      dealId,
      assigneeMembershipId: data.assigneeId,
      dueAt,
      remindAt,
      reminderState: remindAt ? 'pending' : 'none',
      createdByApiKeyId: ctx.key.id,
    });
    if (remindAt) {
      await scheduleTaskReminder(deps, tx, { tenantId: ctx.tenant.id, taskId: id, remindAt });
    }
    if (contactId) {
      await addActivity(tx, {
        tenantId: ctx.tenant.id,
        contactId,
        dealId,
        taskId: id,
        actorMembershipId: null,
        kind: 'task_created',
        data: { apiKeyId: ctx.key.id },
        at: now,
      });
    }
    await recordSystemAudit(
      tx,
      ctx.tenant.id,
      {
        action: 'crm.task_created',
        subjectType: 'crm_task',
        subjectId: id,
        correlationId: ctx.requestId,
        metadata: { assigneeId: data.assigneeId, source: 'api' },
      },
      apiActor(ctx),
    );
    const [task] = await tx
      .select(taskColumns)
      .from(crmTasks)
      .where(and(eq(crmTasks.tenantId, ctx.tenant.id), eq(crmTasks.id, id)));
    if (!task) throw notFound('Task');
    const response = { status: 201, body: { data: toApiTask(task) } };
    if (claimed) await storeIdempotentResponse(tx, ctx, claimed, response);
    return { ...response, replayed: false };
  });
}

/**
 * Changes one of the company's tasks as members do on the Tasks page (ADR-260), in one transaction
 * with the task's contact (if any) and then its row locked, the order erasure takes them in: a closed
 * task is reopened, the open task's title, notes, assignee, due time and reminder changed (a new
 * reminder time resets the reminder and schedules it, as members' edits do), and the open task
 * completed or cancelled (a pending reminder is then skipped), in that order, with the version moving
 * on once. A task already as asked is answered as it is, so a retry changes nothing; a closed task is
 * not changed, or closed the other way, until it is reopened. Reopening and closing are on the
 * timeline of a task about a contact without a member actor, naming the key; the audit log records
 * every change as the key's.
 */
export async function apiUpdateTask(
  deps: Pick<OutboundDeps, 'db' | 'clock' | 'jobs' | 'signer'>,
  ctx: ApiContext,
  taskId: string,
  input: unknown,
): Promise<ApiTask> {
  assertScope(ctx, 'tasks.write');
  if (!z.uuid().safeParse(taskId).success) throw notFound('Task');
  const data = parseInput(apiUpdateTaskSchema, input);
  const now = deps.clock.now();
  const task = await deps.db.run(ctx.scope, async (tx) => {
    await assertCrmInPlan(tx, ctx.tenant.id);
    const [ref] = await tx
      .select({ contactId: crmTasks.contactId })
      .from(crmTasks)
      .where(and(eq(crmTasks.tenantId, ctx.tenant.id), eq(crmTasks.id, taskId)));
    if (!ref) return null;
    let contactFound = true;
    if (ref.contactId) {
      const [contact] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, ref.contactId)))
        .for('key share');
      contactFound = contact !== undefined;
    }
    const [current] = await tx
      .select()
      .from(crmTasks)
      .where(and(eq(crmTasks.tenantId, ctx.tenant.id), eq(crmTasks.id, taskId)))
      .for('update');
    // Erasing the contact deleted the task between the reads.
    if (!current) return null;
    // A merge moved the task to another contact between the reads: its contact is not locked.
    if (!contactFound || current.contactId !== ref.contactId) {
      throw new AppError('conflict', 'The task moved to another contact meanwhile; try again.');
    }
    if (data.expectedVersion !== undefined && data.expectedVersion !== current.version) {
      throw new AppError(
        'conflict',
        `The task changed since version ${data.expectedVersion}; its version is ${current.version}. Read it again.`,
      );
    }

    const next = { ...current };
    const changes: string[] = [];
    const activities: CrmActivityKind[] = [];

    if (data.status === 'open' && next.status !== 'open') {
      // As members reopen a task: a reminder skipped when it was closed is not brought back.
      Object.assign(next, { status: 'open', completedAt: null, completedByMembershipId: null });
      activities.push('task_reopened');
      changes.push('status');
    }

    // Only what differs is a change, so a retry of an edit changes nothing; a closed task is
    // reopened before anything of it changes, as members' edits need an open task.
    const notes = data.notes === undefined ? next.notes : data.notes || null;
    const dueAt = data.dueAt === undefined ? next.dueAt : data.dueAt ? new Date(data.dueAt) : null;
    const remindAt =
      data.remindAt === undefined ? next.remindAt : data.remindAt ? new Date(data.remindAt) : null;
    const dueChanged = (dueAt?.getTime() ?? null) !== (next.dueAt?.getTime() ?? null);
    const remindChanged = (remindAt?.getTime() ?? null) !== (next.remindAt?.getTime() ?? null);
    const assigneeId = data.assigneeId ?? next.assigneeMembershipId;
    const details = [
      ...(data.title !== undefined && data.title !== next.title ? ['title'] : []),
      ...(notes !== next.notes ? ['notes'] : []),
      ...(assigneeId !== next.assigneeMembershipId ? ['assignee'] : []),
      ...(dueChanged ? ['due'] : []),
      ...(remindChanged ? ['reminder'] : []),
    ];
    if (details.length > 0 && next.status !== 'open') {
      throw new AppError('conflict', 'Reopen the task to change it (`status` `open`).');
    }
    const timeIssue = taskTimeIssue(dueChanged ? dueAt : null, remindAt, now, remindChanged);
    if (timeIssue) throw invalidField(timeIssue.path, timeIssue.message);
    if (
      assigneeId !== next.assigneeMembershipId &&
      !(await memberRefs(tx, ctx.tenant.id, [assigneeId])).get(assigneeId)?.active
    ) {
      throw invalidField(
        'assigneeId',
        'Give the id of an active member who can use the CRM (GET /members).',
      );
    }
    Object.assign(next, {
      title: data.title ?? next.title,
      notes,
      assigneeMembershipId: assigneeId,
      dueAt,
      ...(remindChanged
        ? {
            remindAt,
            reminderState: remindAt ? 'pending' : 'none',
            reminderDetail: null,
            remindedAt: null,
          }
        : {}),
    });
    changes.push(...details);

    if (data.status === 'done' || data.status === 'cancelled') {
      if (next.status === 'open') {
        Object.assign(next, {
          status: data.status,
          completedAt: now,
          completedByMembershipId: null,
          // A closed task sends no reminder, as when members close it.
          ...(next.reminderState === 'pending'
            ? { reminderState: 'skipped', reminderDetail: 'task_closed', remindedAt: now }
            : {}),
        });
        activities.push(data.status === 'done' ? 'task_completed' : 'task_cancelled');
        changes.push('status');
      } else if (next.status !== data.status) {
        throw new AppError(
          'conflict',
          `This task is already ${next.status}: reopen it first (\`status\` \`open\`).`,
        );
      }
    }

    if (changes.length > 0) {
      await tx
        .update(crmTasks)
        .set({
          title: next.title,
          notes: next.notes,
          assigneeMembershipId: next.assigneeMembershipId,
          dueAt: next.dueAt,
          remindAt: next.remindAt,
          reminderState: next.reminderState,
          reminderDetail: next.reminderDetail,
          remindedAt: next.remindedAt,
          status: next.status,
          completedAt: next.completedAt,
          completedByMembershipId: next.completedByMembershipId,
          version: current.version + 1,
          ...crmChangedBy({ apiKeyId: ctx.key.id }),
        })
        .where(and(eq(crmTasks.tenantId, ctx.tenant.id), eq(crmTasks.id, current.id)));
      if (remindChanged && next.remindAt && next.reminderState === 'pending') {
        await scheduleTaskReminder(deps, tx, {
          tenantId: ctx.tenant.id,
          taskId: current.id,
          remindAt: next.remindAt,
        });
      }
      if (current.contactId) {
        for (const kind of activities) {
          await addActivity(tx, {
            tenantId: ctx.tenant.id,
            contactId: current.contactId,
            dealId: current.dealId,
            taskId: current.id,
            actorMembershipId: null,
            kind,
            data: { apiKeyId: ctx.key.id },
            at: now,
          });
        }
      }
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action: 'crm.task_updated',
          subjectType: 'crm_task',
          subjectId: current.id,
          correlationId: ctx.requestId,
          metadata: { changes, status: next.status, source: 'api' },
        },
        apiActor(ctx),
      );
    }
    const [row] = await tx
      .select(taskColumns)
      .from(crmTasks)
      .where(and(eq(crmTasks.tenantId, ctx.tenant.id), eq(crmTasks.id, current.id)));
    return row ? toApiTask(row) : null;
  });
  if (!task) throw notFound('Task');
  return task;
}
