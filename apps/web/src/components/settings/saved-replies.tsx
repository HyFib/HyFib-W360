'use client';
import { useId, useState } from 'react';
import { Button, Field, Input, Textarea } from '@w360/ui';
import {
  createSavedReplyAction,
  deleteSavedReplyAction,
  updateSavedReplyAction,
} from '@/app/actions/inbox-settings';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

/** Creates or edits a saved reply. Placeholders: {{name}}, {{agent}}, {{company}}. */
export function SavedReplyForm({
  slug,
  reply,
}: {
  slug: string;
  reply?: { id: string; shortcut: string; title: string; body: string };
}) {
  const prefix = useId();
  const [shortcut, setShortcut] = useState(reply?.shortcut ?? '');
  const [title, setTitle] = useState(reply?.title ?? '');
  const [body, setBody] = useState(reply?.body ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(null);
        const input = { shortcut, title, body };
        const request = reply
          ? updateSavedReplyAction(slug, reply.id, input)
          : createSavedReplyAction(slug, input);
        void request.then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else if (reply) setSaved('Saved reply updated.');
          else {
            setSaved('Saved reply added.');
            setShortcut('');
            setTitle('');
            setBody('');
          }
        });
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${prefix}-shortcut`}
          label="Shortcut"
          description="Lower-case letters, digits, - or _. Members find the reply by it."
        >
          {(aria) => (
            <Input
              {...aria}
              required
              maxLength={32}
              value={shortcut}
              autoComplete="off"
              onChange={(e) => setShortcut(e.target.value)}
            />
          )}
        </Field>
        <Field id={`${prefix}-title`} label="Title">
          {(aria) => (
            <Input
              {...aria}
              required
              maxLength={80}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          )}
        </Field>
      </div>
      <Field
        id={`${prefix}-body`}
        label="Reply"
        description="{{name}} is replaced by the customer’s name, {{agent}} by the member’s and {{company}} by the company’s. Members review the text before sending."
      >
        {(aria) => (
          <Textarea
            {...aria}
            rows={4}
            required
            maxLength={4096}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={busy || !shortcut.trim() || !title.trim() || !body.trim()}>
          {busy ? 'Saving…' : reply ? 'Save reply' : 'Add saved reply'}
        </Button>
      </div>
    </ClientForm>
  );
}

export function DeleteSavedReplyButton({
  slug,
  id,
  shortcut,
}: {
  slug: string;
  id: string;
  shortcut: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-2">
      <div>
        <ClientButton
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void deleteSavedReplyAction(slug, id).then((r) => {
              setBusy(false);
              if (!r.ok) setError(r.message);
            });
          }}
        >
          Delete<span className="sr-only"> saved reply {shortcut}</span>
        </ClientButton>
      </div>
      <FormError message={error} />
    </div>
  );
}
