'use client';
import { useId, useState } from 'react';
import { Button, Checkbox, Field, Input, Select } from '@w360/ui';
import {
  createChatWidgetAction,
  deleteChatWidgetAction,
  updateChatWidgetAction,
} from '@/app/actions/growth';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

interface WidgetValues {
  id: string;
  version: number;
  linkId: string;
  label: string;
  greeting: string | null;
  side: 'left' | 'right';
  color: string;
  enabled: boolean;
}

/** Creates a website widget, or edits one. */
export function ChatWidgetForm({
  slug,
  links,
  widget,
}: {
  slug: string;
  links: { id: string; name: string }[];
  widget?: WidgetValues;
}) {
  const p = useId();
  const [linkId, setLinkId] = useState(widget?.linkId ?? links[0]?.id ?? '');
  const [label, setLabel] = useState(widget?.label ?? 'Chat with us on WhatsApp');
  const [greeting, setGreeting] = useState(widget?.greeting ?? '');
  const [side, setSide] = useState<'left' | 'right'>(widget?.side ?? 'right');
  const [color, setColor] = useState(widget?.color ?? '#1f7a4d');
  const [enabled, setEnabled] = useState(widget?.enabled ?? true);
  const [version, setVersion] = useState(widget?.version ?? 1);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (links.length === 0 && !widget) {
    return (
      <p className="text-sm text-muted-foreground">
        Create a chat link first: the button opens one of your links.
      </p>
    );
  }
  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(null);
        const input = { linkId, label, greeting, side, color, enabled };
        if (widget) {
          void updateChatWidgetAction(slug, {
            ...input,
            id: widget.id,
            expectedVersion: version,
          }).then((r) => {
            setBusy(false);
            if (!r.ok) setError(r.message);
            else {
              setSaved('Widget saved.');
              setVersion(r.data.version);
            }
          });
        } else {
          void createChatWidgetAction(slug, input).then((r) => {
            setBusy(false);
            if (!r.ok) setError(r.message);
            else setSaved('Widget created. Copy its tag into your website below.');
          });
        }
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${p}-link`} label="Opens the link">
          {(aria) => (
            <Select {...aria} value={linkId} onChange={(e) => setLinkId(e.target.value)}>
              {links.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id={`${p}-label`} label="Button text">
          {(aria) => (
            <Input
              {...aria}
              required
              maxLength={40}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          )}
        </Field>
      </div>
      <Field
        id={`${p}-greeting`}
        label="Greeting (optional)"
        description="A short line shown above the button, for example “Questions? We reply on WhatsApp.”"
      >
        {(aria) => (
          <Input
            {...aria}
            maxLength={200}
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id={`${p}-side`} label="Corner">
          {(aria) => (
            <Select
              {...aria}
              value={side}
              onChange={(e) => setSide(e.target.value === 'left' ? 'left' : 'right')}
            >
              <option value="right">Bottom right</option>
              <option value="left">Bottom left</option>
            </Select>
          )}
        </Field>
        <Field id={`${p}-color`} label="Button colour" description="For example #1f7a4d.">
          {(aria) => (
            <Input
              {...aria}
              required
              pattern="#[0-9a-fA-F]{6}"
              maxLength={7}
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          )}
        </Field>
        <label htmlFor={`${p}-enabled`} className="flex items-center gap-2 self-end pb-2 text-sm">
          <Checkbox
            id={`${p}-enabled`}
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Show the button
        </label>
      </div>
      <div>
        <Button type="submit" disabled={busy || !label.trim() || !linkId}>
          {busy ? 'Saving…' : widget ? 'Save widget' : 'Create widget'}
        </Button>
      </div>
    </ClientForm>
  );
}

export function DeleteWidgetButton({
  slug,
  id,
  version,
  label,
}: {
  slug: string;
  id: string;
  version: number;
  label: string;
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
            void deleteChatWidgetAction(slug, { id, expectedVersion: version }).then((r) => {
              setBusy(false);
              if (!r.ok) setError(r.message);
            });
          }}
        >
          Delete<span className="sr-only"> widget {label}</span>
        </ClientButton>
      </div>
      <FormError message={error} />
    </div>
  );
}
