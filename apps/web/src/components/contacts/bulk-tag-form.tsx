'use client';
import { useId, useState } from 'react';
import { Button, Input, Label } from '@w360/ui';
import { bulkTagContactsAction } from '@/app/actions/contacts';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

/**
 * Adds or removes one tag on every contact the page's filters match (ADR-213). The count the member
 * sees goes with the request, so an edit is refused if the matches changed meanwhile.
 */
export function BulkTagForm({
  slug,
  filter,
  count,
}: {
  slug: string;
  filter: { q?: string | undefined; tag?: string | undefined; consent?: string | undefined };
  count: number;
}) {
  const id = useId();
  const [tag, setTag] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const contacts = `${count.toLocaleString('en-IN')} ${count === 1 ? 'contact' : 'contacts'}`;

  async function run(action: 'add' | 'remove') {
    if (!tag.trim()) return;
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await bulkTagContactsAction(slug, { filter, tag, action, expectedCount: count });
    setBusy(false);
    if (!result.ok) setError(result.message);
    else {
      setDone(result.data.message);
      setTag('');
    }
  }

  return (
    <div className="grid gap-2">
      <ClientForm
        onSubmit={(event) => {
          event.preventDefault();
          void run('add');
        }}
        className="flex flex-wrap items-end gap-2"
        aria-label="Tag the contacts these filters match"
      >
        <div className="grid gap-1">
          <Label htmlFor={id}>Tag for the {contacts} shown by these filters</Label>
          <Input
            id={id}
            value={tag}
            maxLength={40}
            className="w-64"
            onChange={(event) => setTag(event.target.value)}
          />
        </div>
        <Button type="submit" variant="outline" disabled={busy || !tag.trim()}>
          Add to {contacts}
        </Button>
        <ClientButton
          type="button"
          variant="outline"
          disabled={busy || !tag.trim()}
          onClick={() => void run('remove')}
        >
          Remove from {contacts}
        </ClientButton>
      </ClientForm>
      <FormError message={error} />
      <FormSuccess message={done} />
    </div>
  );
}
