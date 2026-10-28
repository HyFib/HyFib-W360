'use client';
import { useRouter } from 'next/navigation';
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { clipText } from '@w360/core/text';
import { Button, Select, Textarea } from '@w360/ui';
import {
  savedReplyFileForInsertAction,
  sendReplyAction,
  showTypingAction,
} from '@/app/actions/inbox';
import { FormError } from '@/components/form-status';
import { ClientForm } from '@/components/client-form';

const MAX_LENGTH = 4096;
/** A caption's limit, as the file card has it (ADR-218). */
const CAPTION_MAX_LENGTH = 1024;

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

const FILE_WORDS = {
  image: 'a photo',
  video: 'a video',
  audio: 'a recording',
  document: 'a document',
};

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
  /** The file it carries (ADR-411), or null. */
  attachment: { fileId: string; kind: 'image' | 'video' | 'audio' | 'document' } | null;
}

/** A saved reply's file inserted from the reply box, for the file card (ADR-411). */
export interface ComposerInsertedFile {
  savedReplyId: string;
  title: string;
  fileId: string;
  kind: 'image' | 'video' | 'audio' | 'document';
  filename: string;
  sizeBytes: number;
  caption: string | null;
}

/**
 * Reply composer. Drafts are kept in this tab's sessionStorage under a key that includes the member,
 * the company and the conversation, so a draft never appears in another company or for another
 * person using the same browser. Each submission carries an idempotency key; if the network fails
 * mid-request the same key is reused, so a retry cannot create a duplicate message. It also carries
 * the newest message shown, so a reply another member sent meanwhile is shown before this one goes.
 *
 * A saved reply with a file (ADR-411) is checked when inserted: its file must still be there and
 * readable, or the member is told and nothing is inserted. A photo, video or document goes to the
 * file card with the reply's text as its caption; a recording goes there without one and its text
 * comes here. Nothing is sent until the member presses Send.
 */
export function Composer({
  slug,
  conversationId,
  draftKey,
  disabledReason,
  savedReplies = [],
  latestMessageId,
  typingIndicator = false,
  onInsertFile,
  fileCardInUse = false,
}: {
  slug: string;
  conversationId: string;
  draftKey: string;
  disabledReason: string | null;
  savedReplies?: ComposerSavedReply[];
  latestMessageId?: string;
  /** The company shows customers that a member is writing (ADR-223). */
  typingIndicator?: boolean;
  /** Gives the file card a saved reply's file; without it, replies with files are not offered. */
  onInsertFile?: (file: ComposerInsertedFile) => void;
  /** The file card holds a file or a caption already, which an insertion must not discard. */
  fileCardInUse?: boolean;
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
  const [inserting, setInserting] = useState(false);
  // What the reply box and the file card hold now: both stay editable while a saved reply's file
  // is checked, so its result must not apply the text or the card as they were when it started.
  const latest = useRef({ text, fileCardInUse });
  useLayoutEffect(() => {
    latest.current = { text, fileCardInUse };
  });
  // Without a file card (the window is closed), a reply's file could not be sent.
  const offered = onInsertFile ? savedReplies : savedReplies.filter((r) => !r.attachment);
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

  const insertText = (chosen: ComposerSavedReply) => {
    const current = latest.current.text;
    const next = current.trim() ? `${current.trimEnd()}\n${chosen.text}` : chosen.text;
    update(clipText(next, MAX_LENGTH));
  };

  const missingNote = (chosen: ComposerSavedReply) =>
    chosen.missing.includes('name')
      ? ' This customer has no name on file, so {{name}} was left empty: check the text.'
      : '';

  const insert = (chosen: ComposerSavedReply) => {
    setError(null);
    if (!chosen.attachment || !onInsertFile) {
      insertText(chosen);
      setNotice(
        chosen.missing.includes('name')
          ? `Inserted “${chosen.title}”. This customer has no name on file, so {{name}} was left empty: check the text.`
          : `Inserted “${chosen.title}”. Review it before sending.`,
      );
      return;
    }
    if (fileCardInUse) {
      setNotice(null);
      setError(
        `Send a file below already holds a file or a caption, so “${chosen.title}” was not inserted. Send it or clear it first.`,
      );
      return;
    }
    setInserting(true);
    setNotice(null);
    void savedReplyFileForInsertAction(slug, conversationId, chosen.id)
      .then((result) => {
        if (!result.ok) {
          setError(result.message);
          return;
        }
        // A file or a caption the member gave the card while the file was checked stays.
        if (latest.current.fileCardInUse) {
          setError(
            `Send a file below now holds a file or a caption, so “${chosen.title}” was not inserted. Send it or clear it first.`,
          );
          return;
        }
        const file = result.data;
        const caption = file.caption ? clipText(chosen.text, CAPTION_MAX_LENGTH) : null;
        if (!file.caption) insertText(chosen);
        onInsertFile({
          savedReplyId: chosen.id,
          title: chosen.title,
          fileId: file.fileId,
          kind: file.kind,
          filename: file.filename,
          sizeBytes: file.sizeBytes,
          caption,
        });
        const cut =
          caption !== null && caption.length < chosen.text.length
            ? ' The text was cut to the 1,024 characters a caption holds.'
            : '';
        setNotice(
          file.caption
            ? `Inserted “${chosen.title}”: its file and its text as the caption are in Send a file below. Review them before sending.${cut}${missingNote(chosen)}`
            : `Inserted “${chosen.title}”: its text is in the reply box and its recording in Send a file below, sent separately. Review them before sending.${missingNote(chosen)}`,
        );
      })
      .catch(() => setError('The saved reply’s file could not be checked: the connection failed.'))
      .finally(() => setInserting(false));
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
        {offered.length > 0 ? (
          <>
            <label htmlFor={`${id}-saved`} className="sr-only">
              Insert a saved reply
            </label>
            <Select
              id={`${id}-saved`}
              className="w-auto min-w-40"
              value=""
              disabled={inserting}
              onChange={(event) => {
                const chosen = offered.find((r) => r.id === event.target.value);
                if (chosen) insert(chosen);
              }}
            >
              <option value="">Saved replies…</option>
              {offered.map((r) => (
                <option key={r.id} value={r.id}>
                  /{r.shortcut} · {r.title}
                  {r.attachment ? ` (with ${FILE_WORDS[r.attachment.kind]})` : ''}
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
