'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, Select } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import {
  archiveAutomationAction,
  createAutomationAction,
  deleteAutomationAction,
  publishAutomationAction,
  restoreAutomationAction,
  setAutomationStatusAction,
  startTestRunAction,
  stopRunAction,
  takeOverAction,
} from '@/app/actions/automations';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

export function CreateAutomationForm({ slug }: { slug: string }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void createAutomationAction(slug, { name }).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else router.push(`/c/${slug}/automations/${r.data.id}`);
        });
      }}
    >
      <FormError message={error} />
      <Field id="new-automation-name" label="Name" description="Only your team sees this.">
        {(aria) => (
          <Input
            {...aria}
            value={name}
            required
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create draft'}
        </Button>
      </div>
    </ClientForm>
  );
}

/** Publish, pause/activate, archive/restore and delete, as the automation's state allows. */
export function AutomationStatusActions({
  slug,
  automationId,
  version,
  status,
  hasVersion,
  draftChanged,
  canPublish,
  canWrite,
  errors,
}: {
  slug: string;
  automationId: string;
  version: number;
  status: string;
  hasVersion: boolean;
  draftChanged: boolean;
  canPublish: boolean;
  canWrite: boolean;
  errors: number;
}) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (
    fn: () => Promise<{ ok: true } | { ok: false; message: string }>,
    success: string,
  ) => {
    setBusy(true);
    setError(null);
    setDone(null);
    void fn().then((r) => {
      setBusy(false);
      if (!r.ok) setError(r.message);
      else setDone(success);
    });
  };
  const input = { id: automationId, expectedVersion: version };
  return (
    <div className="grid gap-3">
      <FormError message={error} />
      <FormSuccess message={done} />
      <div className="flex flex-wrap gap-2">
        {canPublish && status !== 'archived' ? (
          <ConfirmDialog
            title="Publish this automation?"
            description={
              hasVersion
                ? 'The current draft becomes a new version. New runs use it at once; runs in progress finish on the version they started with.'
                : 'The draft becomes version 1 and the automation turns on: it starts for customers who match its trigger.'
            }
            confirmLabel="Publish"
            onConfirm={() =>
              run(
                () =>
                  publishAutomationAction(slug, { ...input, note: note || null }).then((r) =>
                    r.ok ? { ok: true as const } : r,
                  ),
                'Published.',
              )
            }
            trigger={
              <ClientButton disabled={busy || errors > 0 || (hasVersion && !draftChanged)}>
                Publish
              </ClientButton>
            }
          >
            <Field
              id="publish-note"
              label="What changed (optional)"
              description="Kept with the version."
            >
              {(aria) => (
                <Input
                  {...aria}
                  value={note}
                  maxLength={300}
                  onChange={(e) => setNote(e.target.value)}
                />
              )}
            </Field>
          </ConfirmDialog>
        ) : null}
        {canPublish && status === 'active' ? (
          <ClientButton
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(
                () => setAutomationStatusAction(slug, { ...input, status: 'paused' }),
                'Paused: no new runs start. Runs in progress finish.',
              )
            }
          >
            Pause
          </ClientButton>
        ) : null}
        {canPublish && status === 'paused' ? (
          <ClientButton
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(() => setAutomationStatusAction(slug, { ...input, status: 'active' }), 'Active.')
            }
          >
            Turn on
          </ClientButton>
        ) : null}
        {canPublish && status !== 'archived' && status !== 'draft' ? (
          <ConfirmDialog
            title="Archive this automation?"
            description="No new runs start, and runs in progress stop; their conversations go to your team. Versions and run history are kept."
            confirmLabel="Archive"
            destructive
            onConfirm={() =>
              run(
                () =>
                  archiveAutomationAction(slug, input).then((r) =>
                    r.ok ? { ok: true as const } : r,
                  ),
                'Archived.',
              )
            }
            trigger={
              <ClientButton variant="outline" disabled={busy}>
                Archive
              </ClientButton>
            }
          />
        ) : null}
        {canPublish && status === 'archived' ? (
          <ClientButton
            variant="outline"
            disabled={busy}
            onClick={() => run(() => restoreAutomationAction(slug, input), 'Restored.')}
          >
            Restore
          </ClientButton>
        ) : null}
        {canWrite && status === 'draft' ? (
          <ConfirmDialog
            title="Delete this draft?"
            description="Drafts that were never published or tested can be deleted. This cannot be undone."
            confirmLabel="Delete"
            destructive
            onConfirm={() => {
              setBusy(true);
              setError(null);
              void deleteAutomationAction(slug, input).then((r) => {
                setBusy(false);
                if (!r.ok) setError(r.message);
                else router.push(`/c/${slug}/automations`);
              });
            }}
            trigger={
              <ClientButton variant="outline" disabled={busy}>
                Delete draft
              </ClientButton>
            }
          />
        ) : null}
      </div>
      {canPublish && errors > 0 ? (
        <p className="text-sm text-muted-foreground">Fix the errors listed below to publish.</p>
      ) : null}
      {canPublish && hasVersion && !draftChanged && status !== 'archived' ? (
        <p className="text-sm text-muted-foreground">The published version matches the draft.</p>
      ) : null}
    </div>
  );
}

/** Runs the saved draft on a conversation the member can see; real messages are sent there. */
export function TestRunForm({
  slug,
  automationId,
  version,
  conversations,
  disabledReason,
}: {
  slug: string;
  automationId: string;
  version: number;
  conversations: { id: string; label: string }[];
  disabledReason: string | null;
}) {
  const [conversationId, setConversationId] = useState(conversations[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (disabledReason) return <p className="text-sm text-muted-foreground">{disabledReason}</p>;
  if (conversations.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No conversation can be used right now. Send a WhatsApp message to your number from a test
        phone; conversations with a customer message in the last 24 hours that are unassigned or
        assigned to you appear here.
      </p>
    );
  }
  return (
    <ClientForm
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setRunId(null);
        void startTestRunAction(slug, {
          id: automationId,
          expectedVersion: version,
          conversationId,
        }).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else setRunId(r.data.runId);
        });
      }}
    >
      <FormError message={error} />
      {runId ? (
        <FormSuccess message="Test started. Reply from the test phone to continue it." />
      ) : null}
      <Field
        id="test-conversation"
        label="Conversation"
        description="The saved draft runs there and sends real WhatsApp messages."
      >
        {(aria) => (
          <Select
            {...aria}
            value={conversationId}
            onChange={(e) => setConversationId(e.target.value)}
          >
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" disabled={busy || !conversationId}>
          {busy ? 'Starting…' : 'Start test run'}
        </Button>
        {runId ? (
          <a
            href={`/c/${slug}/automations/runs/${runId}`}
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            Open the run
          </a>
        ) : null}
      </div>
    </ClientForm>
  );
}

export function StopRunButton({ slug, runId }: { slug: string; runId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-2">
      <FormError message={error} />
      <ConfirmDialog
        title="Stop this run?"
        description="The automation sends nothing more in this conversation, and the conversation goes to your team."
        confirmLabel="Stop run"
        destructive
        onConfirm={() => {
          setBusy(true);
          setError(null);
          void stopRunAction(slug, runId).then((r) => {
            setBusy(false);
            if (!r.ok) setError(r.message);
          });
        }}
        trigger={
          <ClientButton variant="outline" disabled={busy}>
            Stop run
          </ClientButton>
        }
      />
    </div>
  );
}

export function TakeOverButton({ slug, conversationId }: { slug: string; conversationId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-2">
      <FormError message={error} />
      <ClientButton
        size="sm"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void takeOverAction(slug, conversationId).then((r) => {
            setBusy(false);
            if (!r.ok) setError(r.message);
          });
        }}
      >
        {busy ? 'Taking over…' : 'Take over'}
      </ClientButton>
    </div>
  );
}
