'use client';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
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
  reply?: {
    id: string;
    shortcut: string;
    title: string;
    body: string;
    /** The file it carries (ADR-411): with a photo, video or document the text is its caption. */
    attachment?: { kind: 'image' | 'video' | 'audio' | 'document' } | null;
  };
}) {
  const captioned = reply?.attachment ? reply.attachment.kind !== 'audio' : false;
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
        description={`{{name}} is replaced by the customer’s name, {{agent}} by the member’s and {{company}} by the company’s. Members review the text before sending.${captioned ? ' The reply carries a photo, video or document, so this text is its caption: at most 1,024 characters.' : ''}`}
      >
        {(aria) => (
          <Textarea
            {...aria}
            rows={4}
            required
            maxLength={captioned ? 1024 : 4096}
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

/** The file types Settings offers; the server checks the file again (ADR-218, ADR-411). */
const FILE_ACCEPT = [
  'image/jpeg',
  'image/png',
  'video/mp4',
  'video/3gpp',
  'audio/aac',
  'audio/amr',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'application/pdf',
  'text/plain',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
].join(',');

/**
 * Adds, replaces or removes the file a saved reply carries (ADR-411). The file goes to HyFib's own
 * route, which checks it as a file sent from the inbox and keeps it once for the company.
 */
export function SavedReplyFileForm({
  slug,
  id,
  shortcut,
  hasFile,
}: {
  slug: string;
  id: string;
  shortcut: string;
  hasFile: boolean;
}) {
  const prefix = useId();
  const router = useRouter();
  const [picker, setPicker] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = (method: 'POST' | 'DELETE', body?: FormData) => {
    setBusy(true);
    setError(null);
    setSaved(null);
    void fetch(`/api/c/${slug}/saved-replies/${id}/file`, { method, ...(body ? { body } : {}) })
      .then(async (res) => {
        const answer = (await res.json().catch(() => null)) as {
          ok?: boolean;
          message?: string;
        } | null;
        if (!res.ok || !answer?.ok) {
          setError(answer?.message ?? 'The file was not saved. Try again.');
          return;
        }
        setSaved(method === 'POST' ? 'File saved.' : 'File removed.');
        setFile(null);
        setPicker((n) => n + 1);
        router.refresh();
      })
      .catch(() => setError('The file was not saved: the connection failed. Try again.'))
      .finally(() => setBusy(false));
  };
  return (
    <div className="grid gap-3">
      <ClientForm
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!file) return;
          const form = new FormData();
          form.set('file', file);
          send('POST', form);
        }}
      >
        <FormError message={error} />
        <FormSuccess message={saved} />
        <Field
          id={`${prefix}-file`}
          label={hasFile ? 'Replace the file' : 'Attach a file'}
          description="A JPEG or PNG photo, a video, a recording, or a PDF, text or Office document, up to 16 MB. With a photo, video or document the reply’s text is its caption (at most 1,024 characters); a recording takes none."
        >
          {(aria) => (
            <Input
              {...aria}
              key={picker}
              type="file"
              accept={FILE_ACCEPT}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setSaved(null);
              }}
            />
          )}
        </Field>
        <div>
          <Button type="submit" size="sm" disabled={busy || !file}>
            {busy ? 'Saving…' : 'Save file'}
            <span className="sr-only"> for saved reply {shortcut}</span>
          </Button>
        </div>
      </ClientForm>
      {hasFile ? (
        <div>
          <ClientButton size="sm" variant="outline" disabled={busy} onClick={() => send('DELETE')}>
            Remove the file<span className="sr-only"> of saved reply {shortcut}</span>
          </ClientButton>
        </div>
      ) : null}
    </div>
  );
}
