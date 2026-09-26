'use client';
import { useId, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Textarea } from '@w360/ui';
import { sendReplyAction } from '@/app/actions/inbox';
import { FormError } from '@/components/form-status';
import { ClientForm } from '@/components/client-form';

const MAX_LENGTH = 4096;

function newClientKey(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

function readDraft(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

// sessionStorage has no same-tab change events; the draft is read once per render.
const noSubscription = () => () => undefined;

/**
 * Reply composer. Drafts are kept in this tab's sessionStorage under a key that includes the member,
 * the company and the conversation, so a draft never appears in another company or for another
 * person using the same browser. Each submission carries an idempotency key; if the network fails
 * mid-request the same key is reused, so a retry cannot create a duplicate message.
 */
export function Composer({
  slug,
  conversationId,
  draftKey,
  disabledReason,
}: {
  slug: string;
  conversationId: string;
  draftKey: string;
  disabledReason: string | null;
}) {
  const id = useId();
  // Server render has no draft; the client reads it from storage (no hydration mismatch).
  const storedDraft = useSyncExternalStore(
    noSubscription,
    () => readDraft(draftKey),
    () => '',
  );
  const [edited, setEdited] = useState<string | null>(null);
  const text = edited ?? storedDraft;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingKey = useRef<string | null>(null);

  const update = (value: string) => {
    setEdited(value);
    try {
      if (value) window.sessionStorage.setItem(draftKey, value);
      else window.sessionStorage.removeItem(draftKey);
    } catch {
      // Storage unavailable (private mode): the draft simply is not kept.
    }
  };

  const submit = async () => {
    const body = text.trim();
    if (!body || busy || disabledReason) return;
    pendingKey.current ??= newClientKey();
    setBusy(true);
    setError(null);
    try {
      const result = await sendReplyAction(slug, {
        conversationId,
        text: body,
        clientKey: pendingKey.current,
      });
      if (result.ok) {
        pendingKey.current = null;
        update('');
      } else {
        setError(result.message);
        // A typed refusal created nothing; an internal error might have, so keep the key.
        if (result.code !== 'internal') pendingKey.current = null;
      }
    } catch {
      setError('The message could not be sent because the connection failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (disabledReason) {
    return (
      <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        {disabledReason}
      </div>
    );
  }

  return (
    <ClientForm
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={id} className="sr-only">
        Reply
      </label>
      <Textarea
        id={id}
        value={text}
        maxLength={MAX_LENGTH}
        rows={3}
        placeholder="Write a reply…"
        aria-describedby={`${id}-hint`}
        onChange={(event) => update(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <FormError message={error} />
      <div className="flex items-center justify-between gap-2">
        <span id={`${id}-hint`} className="text-xs text-muted-foreground">
          Ctrl + Enter to send · {text.length}/{MAX_LENGTH}
        </span>
        <Button type="submit" disabled={busy || text.trim().length === 0}>
          {busy ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </ClientForm>
  );
}
