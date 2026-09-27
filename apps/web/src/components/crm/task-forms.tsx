'use client';
import { useId, useState } from 'react';
import { Button, Field, Input, Select, Textarea } from '@w360/ui';
import {
  addNoteAction,
  createTaskAction,
  setTaskStatusAction,
  updateTaskAction,
} from '@/app/actions/crm';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';
import type { MemberOption } from './deal-forms';

/**
 * Adds a task (optionally about a contact or deal) or edits an open one. Times are wall-clock
 * readings in the company's time zone; a reminder is emailed to the assignee at that time.
 */
export function TaskForm({
  slug,
  members,
  timeZone,
  defaultAssigneeId,
  contactId = null,
  dealId = null,
  task,
}: {
  slug: string;
  members: MemberOption[];
  timeZone: string;
  defaultAssigneeId: string;
  contactId?: string | null;
  dealId?: string | null;
  task?: {
    id: string;
    version: number;
    title: string;
    notes: string | null;
    dueLocal: string;
    remindLocal: string;
    assigneeMembershipId: string;
  };
}) {
  const prefix = useId();
  const [title, setTitle] = useState(task?.title ?? '');
  const [notes, setNotes] = useState(task?.notes ?? '');
  const [due, setDue] = useState(task?.dueLocal ?? '');
  const [remind, setRemind] = useState(task?.remindLocal ?? '');
  const [assignee, setAssignee] = useState(task?.assigneeMembershipId ?? defaultAssigneeId);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(null);
        const common = {
          title,
          notes: notes || null,
          dueLocal: due || null,
          remindLocal: remind || null,
          assigneeMembershipId: assignee,
        };
        const request = task
          ? updateTaskAction(slug, { ...common, id: task.id, expectedVersion: task.version })
          : createTaskAction(slug, { ...common, contactId, dealId });
        void request.then((r) => {
          setBusy(false);
          if (!r.ok) {
            setError(r.message);
            return;
          }
          setSaved(task ? 'Task saved.' : 'Task added.');
          if (!task) {
            setTitle('');
            setNotes('');
            setDue('');
            setRemind('');
          }
        });
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved} />
      <Field id={`${prefix}-title`} label="Task">
        {(aria) => (
          <Input
            {...aria}
            value={title}
            required
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        )}
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field id={`${prefix}-assignee`} label="Assigned to">
          {(aria) => (
            <Select {...aria} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              {members.map((m) => (
                <option key={m.membershipId} value={m.membershipId}>
                  {m.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id={`${prefix}-due`} label="Due" description={`Optional. ${timeZone} time.`}>
          {(aria) => (
            <Input
              {...aria}
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          )}
        </Field>
        <Field
          id={`${prefix}-remind`}
          label="Email a reminder at"
          description={`Optional. ${timeZone} time.`}
        >
          {(aria) => (
            <Input
              {...aria}
              type="datetime-local"
              value={remind}
              onChange={(e) => setRemind(e.target.value)}
            />
          )}
        </Field>
      </div>
      <Field id={`${prefix}-notes`} label="Notes" description="Optional.">
        {(aria) => (
          <Textarea
            {...aria}
            rows={2}
            value={notes}
            maxLength={2000}
            onChange={(e) => setNotes(e.target.value)}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={busy || !title.trim()}>
          {busy ? 'Saving…' : task ? 'Save task' : 'Add task'}
        </Button>
      </div>
    </ClientForm>
  );
}

export function TaskStatusActions({
  slug,
  taskId,
  taskTitle,
  version,
  status,
}: {
  slug: string;
  taskId: string;
  taskTitle: string;
  version: number;
  status: 'open' | 'done' | 'cancelled';
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (next: 'done' | 'cancelled' | 'open') => {
    setBusy(true);
    setError(null);
    void setTaskStatusAction(slug, { id: taskId, expectedVersion: version, status: next }).then(
      (r) => {
        setBusy(false);
        if (!r.ok) setError(r.message);
      },
    );
  };
  return (
    <div className="grid gap-1">
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        {status === 'open' ? (
          <>
            <ClientButton
              size="sm"
              disabled={busy}
              aria-label={`Mark “${taskTitle}” done`}
              onClick={() => run('done')}
            >
              Done
            </ClientButton>
            <ClientButton
              size="sm"
              variant="outline"
              disabled={busy}
              aria-label={`Cancel “${taskTitle}”`}
              onClick={() => run('cancelled')}
            >
              Cancel task
            </ClientButton>
          </>
        ) : (
          <ClientButton
            size="sm"
            variant="outline"
            disabled={busy}
            aria-label={`Reopen “${taskTitle}”`}
            onClick={() => run('open')}
          >
            Reopen
          </ClientButton>
        )}
      </div>
    </div>
  );
}

/** A note on the contact's timeline (and the deal's, when given). Notes cannot be edited later. */
export function NoteForm({
  slug,
  contactId = null,
  dealId = null,
}: {
  slug: string;
  contactId?: string | null;
  dealId?: string | null;
}) {
  const prefix = useId();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void addNoteAction(slug, { contactId, dealId, body }).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else setBody('');
        });
      }}
    >
      <FormError message={error} />
      <Field
        id={`${prefix}-note`}
        label="Add a CRM note"
        description="Visible to members with CRM access. Notes cannot be edited later."
      >
        {(aria) => (
          <Textarea
            {...aria}
            rows={2}
            value={body}
            maxLength={4000}
            onChange={(e) => setBody(e.target.value)}
          />
        )}
      </Field>
      <div>
        <Button type="submit" variant="outline" disabled={busy || !body.trim()}>
          {busy ? 'Saving…' : 'Add note'}
        </Button>
      </div>
    </ClientForm>
  );
}
