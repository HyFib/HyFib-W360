'use client';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, Textarea } from '@w360/ui';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

function clientKey() {
  return `file-${crypto.randomUUID()}`;
}

/** A saved reply's file the member inserted from the reply box (ADR-411). */
export interface InsertedSavedReplyFile {
  savedReplyId: string;
  title: string;
  fileId: string;
  kind: 'image' | 'video' | 'audio' | 'document';
  filename: string;
  sizeBytes: number;
  /** The reply's text as the caption; null for a recording, which takes none. */
  caption: string | null;
}

const KIND_LABELS = { image: 'Photo', video: 'Video', audio: 'Recording', document: 'Document' };

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The types the file picker offers; the server checks the file again (ADR-218). */
const ACCEPT = [
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
 * Sends a photo, video, recording or document in the conversation while the customer service
 * window is open (ADR-218): the file goes to HyFib's upload route, which uploads it to WhatsApp and
 * queues the reply. A retry of the same file reuses its key, so it is sent once. Like a text reply,
 * it names the newest message shown, so a file is not sent after another member's reply unseen.
 *
 * A saved reply's file the member inserted (ADR-411) takes the place of a chosen file, with the
 * reply's text as its caption: the member reviews both, and nothing goes until they press Send.
 * The parent gives each insertion a new React key, so the card starts again from it.
 */
export function FileSender({
  slug,
  conversationId,
  latestMessageId,
  inserted = null,
  onClearInserted,
}: {
  slug: string;
  conversationId: string;
  latestMessageId?: string;
  inserted?: InsertedSavedReplyFile | null;
  onClearInserted?: () => void;
}) {
  const p = useId();
  const router = useRouter();
  // A new key empties the file picker after a send.
  const [picker, setPicker] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState(inserted?.caption ?? '');
  const [key, setKey] = useState(clientKey);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!file && !inserted) return;
        setBusy(true);
        setError(null);
        setSent(null);
        const form = new FormData();
        if (inserted) {
          form.set('savedReplyId', inserted.savedReplyId);
          form.set('savedReplyFileId', inserted.fileId);
        } else if (file) {
          form.set('file', file);
        }
        form.set('caption', caption);
        form.set('clientKey', key);
        if (latestMessageId) form.set('afterMessageId', latestMessageId);
        void fetch(`/api/c/${slug}/inbox/${conversationId}/files`, { method: 'POST', body: form })
          .then(async (res) => {
            const body = (await res.json().catch(() => null)) as {
              ok?: boolean;
              message?: string;
            } | null;
            if (!res.ok || !body?.ok) {
              setError(body?.message ?? 'The file was not sent. Try again.');
              // Someone else replied meanwhile: show their message; the file stays chosen.
              if (res.status === 409) router.refresh();
              return;
            }
            setSent('File sent.');
            setFile(null);
            setCaption('');
            setKey(clientKey());
            setPicker((n) => n + 1);
            onClearInserted?.();
            router.refresh();
          })
          .catch(() => setError('The file was not sent: the connection failed. Try again.'))
          .finally(() => setBusy(false));
      }}
    >
      <FormError message={error} />
      <FormSuccess message={sent} />
      {inserted ? (
        <div className="grid gap-2 rounded-md border border-border p-3" data-testid="inserted-file">
          <p className="text-sm">
            <span className="font-medium">{KIND_LABELS[inserted.kind]}</span> from the saved reply “
            {inserted.title}”: {inserted.filename} ({formatSize(inserted.sizeBytes)})
          </p>
          {inserted.kind === 'image' ? (
            // eslint-disable-next-line @next/next/no-img-element -- fetched with the member's session, which Next's image optimiser would not send
            <img
              src={`/c/${slug}/settings/saved-replies/files/${inserted.fileId}`}
              alt={`Preview of ${inserted.filename}`}
              className="max-h-48 w-auto rounded border border-border"
            />
          ) : (
            <a
              className="text-sm text-primary underline-offset-4 hover:underline"
              href={`/c/${slug}/settings/saved-replies/files/${inserted.fileId}`}
              target="_blank"
              rel="noreferrer"
            >
              Open the file
            </a>
          )}
          <div>
            <ClientButton
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setCaption('');
                setKey(clientKey());
                onClearInserted?.();
              }}
            >
              Remove the saved reply’s file
            </ClientButton>
          </div>
        </div>
      ) : null}
      <Field
        id={`${p}-file`}
        label="File"
        description="A JPEG or PNG photo, a video, a recording, or a PDF, text or Office document, up to 16 MB."
      >
        {(aria) => (
          <Input
            {...aria}
            key={picker}
            type="file"
            accept={ACCEPT}
            disabled={inserted !== null}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              // A different file is a different send.
              setKey(clientKey());
              setSent(null);
            }}
          />
        )}
      </Field>
      <Field
        id={`${p}-caption`}
        label={
          inserted?.kind === 'audio'
            ? 'Caption (recordings take none; the saved reply’s text is in the reply box)'
            : 'Caption (optional; not shown with recordings)'
        }
      >
        {(aria) => (
          <Textarea
            {...aria}
            rows={2}
            maxLength={1024}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={busy || (!file && !inserted)}>
          {busy ? 'Sending…' : 'Send file'}
        </Button>
      </div>
    </ClientForm>
  );
}
