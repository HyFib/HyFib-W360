'use client';
import { useId, useState } from 'react';
import { Button, Checkbox, Textarea } from '@w360/ui';
import { addNoteAction } from '@/app/actions/inbox';
import { FormError } from '@/components/form-status';
import { ClientForm } from '@/components/client-form';

/**
 * Internal notes are visible to the team only; they are never sent to the customer. Members named
 * in a note see it under Inbox → Mentions; only members who can see the conversation are offered.
 */
export function NoteForm({
  slug,
  conversationId,
  mentionable = [],
  myMembershipId,
}: {
  slug: string;
  conversationId: string;
  mentionable?: { membershipId: string; name: string }[];
  myMembershipId?: string;
}) {
  const id = useId();
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const others = mentionable.filter((m) => m.membershipId !== myMembershipId);
  return (
    <ClientForm
      className="grid gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!body.trim()) return;
        setBusy(true);
        setError(null);
        const result = await addNoteAction(slug, { conversationId, body, mentionIds: mentions });
        setBusy(false);
        if (result.ok) {
          setBody('');
          setMentions([]);
        } else setError(result.message);
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
      {others.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Mention someone{mentions.length > 0 ? ` (${mentions.length})` : ''}
          </summary>
          <fieldset className="mt-2 grid gap-1.5">
            <legend className="sr-only">Members to mention</legend>
            {others.map((m) => (
              <label key={m.membershipId} className="flex items-center gap-2">
                <Checkbox
                  checked={mentions.includes(m.membershipId)}
                  onChange={(event) =>
                    setMentions((list) =>
                      event.target.checked
                        ? [...list, m.membershipId]
                        : list.filter((x) => x !== m.membershipId),
                    )
                  }
                />
                {m.name}
              </label>
            ))}
          </fieldset>
        </details>
      ) : null}
      <FormError message={error} />
      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="outline" disabled={busy || !body.trim()}>
          Add note
        </Button>
      </div>
    </ClientForm>
  );
}
