'use client';
import { useId, useState } from 'react';
import { Badge, Button, Input } from '@w360/ui';
import { addTagsAction, removeTagAction } from '@/app/actions/contacts';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError } from '@/components/form-status';

export function TagEditor({
  slug,
  contactId,
  tags,
  canEdit,
}: {
  slug: string;
  contactId: string;
  tags: string[];
  canEdit: boolean;
}) {
  const id = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    const result = await addTagsAction(slug, contactId, value);
    setBusy(false);
    if (!result.ok) setError(result.message);
    else setValue('');
  }

  async function remove(tag: string) {
    setError(null);
    const result = await removeTagAction(slug, contactId, tag);
    if (!result.ok) setError(result.message);
  }

  return (
    <div className="grid gap-3">
      {tags.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tags.</p>
      ) : (
        <ul className="flex flex-wrap gap-2" aria-label="Tags">
          {tags.map((tag) => (
            <li key={tag}>
              <Badge tone="info">
                {tag}
                {canEdit ? (
                  <ClientButton
                    variant="ghost"
                    size="sm"
                    className="-mr-1 h-5 px-1"
                    aria-label={`Remove tag ${tag}`}
                    onClick={() => void remove(tag)}
                  >
                    ×
                  </ClientButton>
                ) : null}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <FormError message={error} />
      {canEdit ? (
        <ClientForm onSubmit={add} className="flex gap-2">
          <label htmlFor={id} className="sr-only">
            Add tags
          </label>
          <Input
            id={id}
            value={value}
            placeholder="Add tags, separated by commas"
            onChange={(e) => setValue(e.target.value)}
          />
          <Button type="submit" variant="outline" disabled={busy || !value.trim()}>
            Add
          </Button>
        </ClientForm>
      ) : null}
    </div>
  );
}
