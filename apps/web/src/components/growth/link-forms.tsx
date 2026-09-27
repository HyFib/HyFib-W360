'use client';
import { useId, useState } from 'react';
import { Button, Checkbox, Field, Input, Select, Textarea } from '@w360/ui';
import {
  createChatLinkAction,
  setChatLinkArchivedAction,
  updateChatLinkAction,
} from '@/app/actions/growth';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

export interface ChannelOption {
  id: string;
  name: string;
  active: boolean;
}

interface LinkValues {
  id: string;
  version: number;
  name: string;
  channelAccountId: string;
  message: string;
  includeRef: boolean;
  refCode: string;
}

/** Creates a chat link, or edits one (with its version for concurrent edits). */
export function ChatLinkForm({
  slug,
  channels,
  link,
}: {
  slug: string;
  channels: ChannelOption[];
  link?: LinkValues;
}) {
  const p = useId();
  const active = channels.filter((c) => c.active || c.id === link?.channelAccountId);
  const [name, setName] = useState(link?.name ?? '');
  const [channelAccountId, setChannel] = useState(link?.channelAccountId ?? active[0]?.id ?? '');
  const [message, setMessage] = useState(link?.message ?? 'Hi! I would like to know more.');
  const [includeRef, setIncludeRef] = useState(link?.includeRef ?? true);
  const [version, setVersion] = useState(link?.version ?? 1);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (active.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Connect a WhatsApp number first (Settings → Channels): a link opens a chat with one of your
        numbers.
      </p>
    );
  }
  const preview = includeRef
    ? `${message.trim()}${message.trim() ? ' ' : ''}(ref ${link?.refCode ?? 'XXXXXX'})`
    : message.trim();
  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(null);
        const input = { name, channelAccountId, message, includeRef };
        if (link) {
          void updateChatLinkAction(slug, { ...input, id: link.id, expectedVersion: version }).then(
            (r) => {
              setBusy(false);
              if (!r.ok) setError(r.message);
              else {
                setSaved('Link saved.');
                setVersion(r.data.version);
              }
            },
          );
        } else {
          void createChatLinkAction(slug, input).then((r) => {
            setBusy(false);
            if (!r.ok) setError(r.message);
            else {
              setSaved('Link created.');
              setName('');
            }
          });
        }
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${p}-name`}
          label="Name"
          description="Only your team sees it, for example “Instagram bio”."
        >
          {(aria) => (
            <Input
              {...aria}
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field id={`${p}-channel`} label="WhatsApp number">
          {(aria) => (
            <Select {...aria} value={channelAccountId} onChange={(e) => setChannel(e.target.value)}>
              {active.map((c) => (
                <option key={c.id} value={c.id} disabled={!c.active}>
                  {c.active ? c.name : `${c.name} (not active)`}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Field
        id={`${p}-message`}
        label="Pre-filled message"
        description="Appears in the customer’s chat box; they can change it before sending. Leave it empty for no text."
      >
        {(aria) => (
          <Textarea
            {...aria}
            rows={3}
            maxLength={500}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        )}
      </Field>
      <label htmlFor={`${p}-ref`} className="flex items-start gap-2 text-sm">
        <Checkbox
          id={`${p}-ref`}
          checked={includeRef}
          onChange={(e) => setIncludeRef(e.target.checked)}
        />
        <span>
          Add a reference code to the message, so conversations from this link are counted (it only
          counts when the customer sends the code).
        </span>
      </label>
      <p className="text-sm text-muted-foreground">
        Customers see: <span className="font-medium text-foreground">{preview || '(no text)'}</span>
      </p>
      <div>
        <Button type="submit" disabled={busy || !name.trim() || !channelAccountId}>
          {busy ? 'Saving…' : link ? 'Save link' : 'Create link'}
        </Button>
      </div>
    </ClientForm>
  );
}

export function ArchiveLinkButton({
  slug,
  id,
  version,
  archived,
  name,
}: {
  slug: string;
  id: string;
  version: number;
  archived: boolean;
  name: string;
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
            void setChatLinkArchivedAction(slug, { id, expectedVersion: version }, !archived).then(
              (r) => {
                setBusy(false);
                if (!r.ok) setError(r.message);
              },
            );
          }}
        >
          {archived ? 'Restore' : 'Archive'}
          <span className="sr-only"> link {name}</span>
        </ClientButton>
      </div>
      <FormError message={error} />
    </div>
  );
}
