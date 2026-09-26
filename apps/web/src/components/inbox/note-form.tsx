'use client';
import { useId, useState } from 'react';
import { Button, Textarea } from '@w360/ui';
import { addNoteAction } from '@/app/actions/inbox';
import { FormError } from '@/components/form-status';
import { ClientForm } from '@/components/client-form';

/** Internal notes are visible to the team only; they are never sent to the customer. */
export function NoteForm({ slug, conversationId }: { slug: string; conversationId: string }) {
  const id = useId();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm
      className="grid gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!body.trim()) return;
        setBusy(true);
        setError(null);
        const result = await addNoteAction(slug, { conversationId, body });
        setBusy(false);
        if (result.ok) setBody('');
        else setError(result.message);
      }}
    >
      <label htmlFor={id} className="text-sm font-medium">
        Internal note
      </label>
      <Textarea
        id={id}
        rows={2}
        maxLength={4000}
        value={body}
        placeholder="Visible to your team only"
        onChange={(event) => setBody(event.target.value)}
      />
      <FormError message={error} />
      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="outline" disabled={busy || !body.trim()}>
          Add note
        </Button>
      </div>
    </ClientForm>
  );
}
