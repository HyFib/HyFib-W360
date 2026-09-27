import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Select,
} from '@w360/ui';
import { CrmTabs } from '@/components/crm/crm-tabs';
import type { MemberOption } from '@/components/crm/deal-forms';
import { TaskForm, TaskStatusActions } from '@/components/crm/task-forms';
import { PageHeader } from '@/components/page-header';
import { contactLabel, REMINDER_DETAIL, REMINDER_TEXT, TASK_STATUS } from '@/lib/crm-labels';
import { formatDateTime } from '@/lib/format';
import { crmLookups } from '@/server/crm';
import { isoToLocal } from '@/server/crm-time';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Tasks' };
export const dynamic = 'force-dynamic';

export default async function CrmTasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ scope?: string; status?: string; assignee?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'crm.read')) notFound();
  const { crm } = await getRuntime();
  const base = `/c/${ctx.tenant.slug}/crm/tasks`;
  const tz = ctx.tenant.timezone;
  const canWrite = can(ctx, 'crm.write');
  const scope = query.scope === 'all' ? 'all' : 'mine';
  const status = query.status === 'done' ? 'done' : 'open';
  const lookups = await crmLookups(ctx);
  const assignee =
    scope === 'all'
      ? (lookups.memberOptions.find((m) => m.membershipId === query.assignee)?.membershipId ?? null)
      : null;
  const tasks = await crm.listTasks(ctx, { scope, status, assigneeMembershipId: assignee });
  const me = ctx.membership.id;
  const defaultAssignee = lookups.memberOptions.some((m) => m.membershipId === me)
    ? me
    : (lookups.memberOptions[0]?.membershipId ?? '');
  const contactsHref = can(ctx, 'contacts.read') ? `/c/${ctx.tenant.slug}/contacts` : null;
  const now = new Date();
  const href = (next: { scope?: string; status?: string }) => {
    const p = new URLSearchParams();
    const s = next.scope ?? scope;
    const st = next.status ?? status;
    if (s === 'all') p.set('scope', 'all');
    if (st === 'done') p.set('status', 'done');
    if (s === 'all' && assignee && next.scope === undefined) p.set('assignee', assignee);
    const q = p.toString();
    return q ? `${base}?${q}` : base;
  };
  const filterClass = (active: boolean) =>
    active
      ? 'rounded-md bg-primary/10 px-3 py-1 font-medium'
      : 'rounded-md px-3 py-1 text-muted-foreground hover:text-foreground';
  /** The edit form's assignee list, keeping a current assignee who has since lost CRM access. */
  const assigneeOptions = (
    current: { membershipId: string; name: string } | null,
  ): MemberOption[] =>
    current && !lookups.memberOptions.some((m) => m.membershipId === current.membershipId)
      ? [
          ...lookups.memberOptions,
          { membershipId: current.membershipId, name: `${current.name} (no CRM access)` },
        ]
      : lookups.memberOptions;

  return (
    <>
      <PageHeader title="CRM" description="Deals by stage, and the tasks that move them forward." />
      <CrmTabs slug={ctx.tenant.slug} active="tasks" />
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <nav aria-label="Whose tasks" className="flex flex-wrap gap-2">
          <Link
            href={href({ scope: 'mine' })}
            aria-current={scope === 'mine' ? 'page' : undefined}
            className={filterClass(scope === 'mine')}
          >
            My tasks
          </Link>
          <Link
            href={href({ scope: 'all' })}
            aria-current={scope === 'all' ? 'page' : undefined}
            className={filterClass(scope === 'all')}
          >
            Everyone’s
          </Link>
        </nav>
        <nav aria-label="Task status" className="flex flex-wrap gap-2">
          <Link
            href={href({ status: 'open' })}
            aria-current={status === 'open' ? 'page' : undefined}
            className={filterClass(status === 'open')}
          >
            Open
          </Link>
          <Link
            href={href({ status: 'done' })}
            aria-current={status === 'done' ? 'page' : undefined}
            className={filterClass(status === 'done')}
          >
            Closed
          </Link>
        </nav>
      </div>
      {scope === 'all' && lookups.memberOptions.length > 1 ? (
        <form
          method="get"
          action={base}
          className="mt-4 flex flex-wrap items-end gap-3"
          aria-label="Filter tasks by assignee"
        >
          <input type="hidden" name="scope" value="all" />
          {status === 'done' ? <input type="hidden" name="status" value="done" /> : null}
          <div className="grid gap-1">
            <Label htmlFor="task-assignee">Assigned to</Label>
            <Select
              id="task-assignee"
              name="assignee"
              defaultValue={assignee ?? ''}
              className="w-56"
            >
              <option value="">Anyone</option>
              {lookups.memberOptions.map((m) => (
                <option key={m.membershipId} value={m.membershipId}>
                  {m.name}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" variant="outline">
            Show tasks
          </Button>
        </form>
      ) : null}

      <div className="mt-6 grid grid-cols-1 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>
              {status === 'open' ? 'Open tasks' : 'Closed tasks'}
              {scope === 'mine' ? ' assigned to you' : ''}
            </CardTitle>
            <CardDescription>
              {status === 'open'
                ? `By due time, in ${tz} time. Tasks without a due time come last.`
                : 'Most recently closed first.'}
              {tasks.length >= 200 ? ' Showing the first 200.' : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {tasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {status === 'open' ? 'No open tasks.' : 'No closed tasks.'}
              </p>
            ) : (
              <ul className="grid gap-3">
                {tasks.map((t) => {
                  const overdue =
                    t.status === 'open' && t.dueAt !== null && new Date(t.dueAt) < now;
                  const taskStatus = TASK_STATUS[t.status] ?? {
                    label: t.status,
                    tone: 'neutral' as const,
                  };
                  const reminder =
                    t.reminderState === 'none'
                      ? null
                      : `${REMINDER_TEXT[t.reminderState] ?? t.reminderState}${
                          t.remindAt ? ` (${formatDateTime(t.remindAt, tz)})` : ''
                        }${
                          t.reminderState === 'skipped' && t.reminderDetail
                            ? `: ${REMINDER_DETAIL[t.reminderDetail] ?? t.reminderDetail}`
                            : ''
                        }`;
                  return (
                    <li
                      key={t.id}
                      className="grid min-w-0 gap-2 rounded-md border border-border p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={
                            t.status === 'open'
                              ? 'min-w-0 break-words font-medium'
                              : 'min-w-0 break-words font-medium line-through'
                          }
                        >
                          {t.title}
                        </span>
                        {t.status !== 'open' ? (
                          <Badge tone={taskStatus.tone}>{taskStatus.label}</Badge>
                        ) : null}
                        {overdue ? <Badge tone="danger">Overdue</Badge> : null}
                      </div>
                      <p className="break-words text-xs text-muted-foreground">
                        {t.assignee ? t.assignee.name : 'Unassigned'}
                        {t.dueAt ? ` · due ${formatDateTime(t.dueAt, tz)}` : ' · no due time'}
                        {t.completedAt ? ` · closed ${formatDateTime(t.completedAt, tz)}` : ''}
                        {reminder ? ` · ${reminder}` : ''}
                      </p>
                      {t.contact || t.deal ? (
                        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                          {t.contact ? (
                            contactsHref && !t.contact.erased ? (
                              <Link
                                href={`${contactsHref}/${t.contact.id}`}
                                className="text-primary underline-offset-4 hover:underline"
                              >
                                {contactLabel(t.contact)}
                              </Link>
                            ) : (
                              <span>{contactLabel(t.contact)}</span>
                            )
                          ) : null}
                          {t.deal ? (
                            <Link
                              href={`/c/${ctx.tenant.slug}/crm/deals/${t.deal.id}`}
                              className="break-words text-primary underline-offset-4 hover:underline"
                            >
                              Deal: {t.deal.title}
                            </Link>
                          ) : null}
                        </p>
                      ) : null}
                      {t.notes ? (
                        <p className="whitespace-pre-wrap break-words text-muted-foreground">
                          {t.notes}
                        </p>
                      ) : null}
                      {canWrite ? (
                        <TaskStatusActions
                          slug={ctx.tenant.slug}
                          taskId={t.id}
                          taskTitle={t.title}
                          version={t.version}
                          status={t.status}
                        />
                      ) : null}
                      {canWrite && t.status === 'open' && lookups.memberOptions.length > 0 ? (
                        <details>
                          <summary className="cursor-pointer text-sm font-medium">
                            Edit “{t.title}”
                          </summary>
                          <div className="mt-3">
                            <TaskForm
                              key={t.version}
                              slug={ctx.tenant.slug}
                              members={assigneeOptions(t.assignee)}
                              timeZone={tz}
                              defaultAssigneeId={defaultAssignee}
                              task={{
                                id: t.id,
                                version: t.version,
                                title: t.title,
                                notes: t.notes,
                                dueLocal: isoToLocal(t.dueAt, tz),
                                remindLocal: isoToLocal(t.remindAt, tz),
                                assigneeMembershipId: t.assignee?.membershipId ?? defaultAssignee,
                              }}
                            />
                          </div>
                        </details>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {canWrite && lookups.memberOptions.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>New task</CardTitle>
              <CardDescription>
                A task on its own. To tie one to a customer, add it from their contact, deal or
                conversation.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TaskForm
                slug={ctx.tenant.slug}
                members={lookups.memberOptions}
                timeZone={tz}
                defaultAssigneeId={defaultAssignee}
              />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
