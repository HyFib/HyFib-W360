'use client';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, useSyncExternalStore } from 'react';
import { clipText } from '@w360/core/text';
import { Button, Select, Textarea } from '@w360/ui';
import { sendReplyAction, showTypingAction } from '@/app/actions/inbox';
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

export interface ComposerSavedReply {
  id: string;
  shortcut: string;
  title: string;
  /** Text with placeholders already filled in for this conversation. */
  text: string;
  /** Placeholders that had no value (for example a customer without a name). */
  missing: string[];
}

/**
 * Reply composer. Drafts are kept in this tab's sessionStorage under a key that includes the member,
 * the company and the conversation, so a draft never appears in another company or for another
 * person using the same browser. Each submission carries an idempotency key; if the network fails
 * mid-request the same key is reused, so a retry cannot create a duplicate message. It also carries
 * the newest message shown, so a reply another member sent meanwhile is shown before this one goes.
 */
export function Composer({
  slug,
  conversationId,
  draftKey,
  disabledReason,
  savedReplies = [],
  latestMessageId,
  typingIndicator = false,
}: {
  slug: string;
  conversationId: string;
  draftKey: string;
  disabledReason: string | null;
  savedReplies?: ComposerSavedReply[];
  latestMessageId?: string;
  /** The company shows customers that a member is writing (ADR-223). */
  typingIndicator?: boolean;
}) {
  const router = useRouter();
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
  const [notice, setNotice] = useState<string | null>(null);
  const pendingKey = useRef<string | null>(null);
  // When the customer was last shown that a member is writing, or -1 once the server said no.
  const typingShownAt = useRef(0);

  /** Shows the customer that a member is writing, at most every 20 seconds while they type. */
  const showTyping = () => {
    const now = Date.now();
    if (!typingIndicator || typingShownAt.current < 0 || now - typingShownAt.current < 20_000) {
      return;
    }
    typingShownAt.current = now;
    void showTypingAction(slug, conversationId).then((result) => {
      // Turned off, or refused: stop asking until the page is opened again.
      if (!result.ok || result.data.outcome === 'off') typingShownAt.current = -1;
    });
  };

  const update = (value: string) => {
    setEdited(value);
    if (value.trim()) showTyping();
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
        ...(latestMessageId ? { afterMessageId: latestMessageId } : {}),
      });
      if (result.ok) {
        pendingKey.current = null;
        update('');
      } else {
        setError(result.message);
        // A typed refusal created nothing; an internal error might have, so keep the key.
        if (result.code !== 'internal') pendingKey.current = null;
        // Someone else replied meanwhile: show their message; the draft stays for a second try.
        if (result.code === 'conflict') router.refresh();
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
      {notice ? (
        <p className="text-xs text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={`${id}-hint`} className="text-xs text-muted-foreground">
          Ctrl + Enter to send · {text.length}/{MAX_LENGTH}
        </span>
        {savedReplies.length > 0 ? (
          <>
            <label htmlFor={`${id}-saved`} className="sr-only">
              Insert a saved reply
            </label>
            <Select
              id={`${id}-saved`}
              className="w-auto min-w-40"
              value=""
              onChange={(event) => {
                const chosen = savedReplies.find((r) => r.id === event.target.value);
                if (!chosen) return;
                const next = text.trim() ? `${text.trimEnd()}\n${chosen.text}` : chosen.text;
                update(clipText(next, MAX_LENGTH));
                setNotice(
                  chosen.missing.includes('name')
                    ? `Inserted “${chosen.title}”. This customer has no name on file, so {{name}} was left empty: check the text.`
                    : `Inserted “${chosen.title}”. Review it before sending.`,
                );
              }}
            >
              <option value="">Saved replies…</option>
              {savedReplies.map((r) => (
                <option key={r.id} value={r.id}>
                  /{r.shortcut} · {r.title}
                </option>
              ))}
            </Select>
          </>
        ) : null}
        <Button type="submit" disabled={busy || text.trim().length === 0}>
          {busy ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </ClientForm>
  );
}
