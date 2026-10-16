import Link from 'next/link';
import type { ContactCrm } from '@w360/domain';
import { formatMinor } from '@w360/domain/crm-money';
import { Badge } from '@w360/ui';
import { contactLabel, DEAL_STATUS } from '@/lib/crm-labels';
import { formatDateTime } from '@/lib/format';
import {
  NewDealForm,
  type DealFieldOption,
  type MemberOption,
  type PipelineOption,
} from './deal-forms';
import { NoteForm, TaskForm, TaskStatusActions } from './task-forms';
import { Timeline } from './timeline';

/**
 * A contact's deals, open tasks and timeline, with forms to add a deal, a task or a note. Used on
 * the contact page and next to a conversation in the inbox.
 */
export function ContactCrmPanel({
  slug,
  timeZone,
  canWrite,
  conversationId = null,
  data,
  pipelines,
  members,
  dealFields = [],
  myMembershipId,
  stageNames,
  memberNames,
  compact = false,
}: {
  slug: string;
  timeZone: string;
  canWrite: boolean;
  conversationId?: string | null;
  data: ContactCrm;
  pipelines: PipelineOption[];
  members: MemberOption[];
  /** The company's custom deal fields, given when a deal is added (ADR-379). */
  dealFields?: readonly DealFieldOption[];
  myMembershipId: string;
  stageNames: Record<string, string>;
  memberNames: Record<string, string>;
  /** Fewer timeline entries (inbox side panel). */
  compact?: boolean;
}) {
  const contact = data.contact;
  const writable = canWrite && !contact.erased;
  const canAssign = members.some((m) => m.membershipId === myMembershipId);
  return (
    <div className="grid gap-5">
      <section className="grid gap-2" aria-labelledby={`deals-${contact.id}`}>
        <h3 id={`deals-${contact.id}`} className="text-sm font-semibold">
          Deals
        </h3>
        {data.deals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No deals.</p>
        ) : (
          <ul className="grid gap-2">
            {data.deals.map((d) => {
              const status = DEAL_STATUS[d.status] ?? { label: d.status, tone: 'neutral' as const };
              return (
                <li key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <Link
                    href={`/c/${slug}/crm/deals/${d.id}`}
                    className="min-w-0 break-words font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {d.title}
                  </Link>
                  <Badge tone={status.tone}>
                    {d.status === 'open' ? (stageNames[d.stageId] ?? 'Open') : status.label}
                  </Badge>
                  {d.valueMinor !== null ? (
                    <span className="text-muted-foreground">
                      {formatMinor(d.valueMinor, d.currency)}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {writable ? (
          <details className="rounded-md border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">New deal</summary>
            <div className="mt-3">
              <NewDealForm
                slug={slug}
                pipelines={pipelines}
                members={members}
                fields={dealFields}
                contact={{ id: contact.id, label: contactLabel(contact) }}
                conversationId={conversationId}
                defaultOwnerId={canAssign ? myMembershipId : null}
              />
            </div>
          </details>
        ) : null}
      </section>

      <section className="grid gap-2" aria-labelledby={`tasks-${contact.id}`}>
        <h3 id={`tasks-${contact.id}`} className="text-sm font-semibold">
          Open tasks
        </h3>
        {data.tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open tasks.</p>
        ) : (
          <ul className="grid gap-3">
            {data.tasks.map((t) => (
              <li key={t.id} className="grid gap-1 text-sm">
                <span className="min-w-0 break-words font-medium">{t.title}</span>
                <span className="text-xs text-muted-foreground">
                  {t.assignee ? t.assignee.name : 'Unassigned'}
                  {t.dueAt ? ` · due ${formatDateTime(t.dueAt, timeZone)}` : ''}
                </span>
                {canWrite ? (
                  <TaskStatusActions
                    slug={slug}
                    taskId={t.id}
                    taskTitle={t.title}
                    version={t.version}
                    status={t.status}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {writable && members.length > 0 ? (
          <details className="rounded-md border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">New task</summary>
            <div className="mt-3">
              <TaskForm
                slug={slug}
                members={members}
                timeZone={timeZone}
                defaultAssigneeId={canAssign ? myMembershipId : (members[0]?.membershipId ?? '')}
                contactId={contact.id}
              />
            </div>
          </details>
        ) : null}
      </section>

      <section className="grid gap-2" aria-labelledby={`timeline-${contact.id}`}>
        <h3 id={`timeline-${contact.id}`} className="text-sm font-semibold">
          Timeline
        </h3>
        {writable ? <NoteForm slug={slug} contactId={contact.id} /> : null}
        <Timeline
          items={compact ? data.timeline.slice(0, 10) : data.timeline}
          slug={slug}
          timeZone={timeZone}
          stageNames={stageNames}
          memberNames={memberNames}
          showDeal
        />
      </section>
    </div>
  );
}
