'use client';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, Textarea } from '@w360/ui';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

function clientKey() {
  return `file-${crypto.randomUUID()}`;
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
 * queues the reply. A retry of the same file reuses its key, so it is sent once.
 */
export function FileSender({ slug, conversationId }: { slug: string; conversationId: string }) {
  const p = useId();
  const router = useRouter();
  // A new key empties the file picker after a send.
  const [picker, setPicker] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [key, setKey] = useState(clientKey);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!file) return;
        setBusy(true);
        setError(null);
        setSent(null);
        const form = new FormData();
        form.set('file', file);
        form.set('caption', caption);
        form.set('clientKey', key);
        void fetch(`/api/c/${slug}/inbox/${conversationId}/files`, { method: 'POST', body: form })
          .then(async (res) => {
            const body = (await res.json().catch(() => null)) as {
              ok?: boolean;
              message?: string;
            } | null;
            if (!res.ok || !body?.ok) {
              setError(body?.message ?? 'The file was not sent. Try again.');
              return;
            }
            setSent('File sent.');
            setFile(null);
            setCaption('');
            setKey(clientKey());
            setPicker((n) => n + 1);
            router.refresh();
          })
          .catch(() => setError('The file was not sent: the connection failed. Try again.'))
          .finally(() => setBusy(false));
      }}
    >
      <FormError message={error} />
      <FormSuccess message={sent} />
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
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              // A different file is a different send.
              setKey(clientKey());
              setSent(null);
            }}
          />
        )}
      </Field>
      <Field id={`${p}-caption`} label="Caption (optional; not shown with recordings)">
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
        <Button type="submit" disabled={busy || !file}>
          {busy ? 'Sending…' : 'Send file'}
        </Button>
      </div>
    </ClientForm>
  );
}
