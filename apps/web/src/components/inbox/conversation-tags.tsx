'use client';
import { useId, useState } from 'react';
import { Badge, Button, Input } from '@w360/ui';
import { addConversationTagsAction, removeConversationTagAction } from '@/app/actions/inbox';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError } from '@/components/form-status';

/**
 * A conversation's tags (ADR-220). Members who can reply add tags (suggesting those already in
 * use) and remove them; everyone who sees the conversation sees them.
 */
export function ConversationTags({
  slug,
  conversationId,
  tags,
  suggestions,
  canEdit,
}: {
  slug: string;
  conversationId: string;
  tags: string[];
  /** Tags on other conversations the member can see. */
  suggestions: string[];
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
    const result = await addConversationTagsAction(slug, { conversationId, tags: value });
    setBusy(false);
    if (!result.ok) setError(result.message);
    else setValue('');
  }

  async function remove(tag: string) {
    setError(null);
    const result = await removeConversationTagAction(slug, { conversationId, tag });
    if (!result.ok) setError(result.message);
  }

  const offered = suggestions.filter((tag) => !tags.includes(tag));
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Tags</span>
        {tags.length === 0 ? (
          <span className="text-sm text-muted-foreground">No tags.</span>
        ) : (
          <ul className="flex flex-wrap gap-2" aria-label="Conversation tags">
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
      </div>
      <FormError message={error} />
      {canEdit ? (
        <ClientForm onSubmit={add} className="flex gap-2">
          <label htmlFor={id} className="sr-only">
            Add tags to this conversation
          </label>
          <Input
            id={id}
            value={value}
            list={offered.length > 0 ? `${id}-tags` : undefined}
            placeholder="Add tags, separated by commas"
            maxLength={1000}
            onChange={(e) => setValue(e.target.value)}
          />
          {offered.length > 0 ? (
            <datalist id={`${id}-tags`}>
              {offered.map((tag) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
          ) : null}
          <Button type="submit" variant="outline" disabled={busy || !value.trim()}>
            Add tags
          </Button>
        </ClientForm>
      ) : null}
    </div>
  );
}
