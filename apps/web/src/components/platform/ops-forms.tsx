'use client';
import { useState } from 'react';
import { Button, Field, Textarea } from '@w360/ui';
import {
  acknowledgeDeadLetterAction,
  acknowledgeIntegrationFailureAction,
  acknowledgeLateQueueAction,
  acknowledgeReceiptAction,
  resolveQuarantineAction,
  retryDeadLetterAction,
  retryWebhookReceiptAction,
} from '@/app/actions/platform';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

/** Sends a failed or quarantined webhook receipt back to processing, with a reason (audited). */
export function RetryReceiptForm({ receiptId }: { receiptId: string }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await retryWebhookReceiptAction({ receiptId, reason });
    setBusy(false);
    if (!result.ok) setError(result.message);
    else setDone(true);
  }
  if (done) return <FormSuccess message="Sent back to processing: the minute sweep picks it up." />;
  return (
    <details className="group">
      <summary className="cursor-pointer text-sm text-primary underline-offset-4 hover:underline">
        Retry
      </summary>
      <ClientForm onSubmit={submit} className="mt-2 grid w-64 max-w-full gap-2">
        <FormError message={error} />
        <Field id={`retry-reason-${receiptId}`} label="Reason (the fix made)">
          {(aria) => (
            <Textarea
              {...aria}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={10}
              maxLength={2000}
              rows={2}
              required
            />
          )}
        </Field>
        <div>
          <Button type="submit" size="sm" disabled={busy || reason.trim().length < 10}>
            {busy ? 'Retrying…' : 'Retry receipt'}
          </Button>
        </div>
      </ClientForm>
    </details>
  );
}

/** Sends a dead letter's job back to its queue for one more attempt, with a reason (audited). */
export function RetryDeadLetterForm({ deadLetterId }: { deadLetterId: string }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await retryDeadLetterAction({ deadLetterId, reason });
    setBusy(false);
    if (!result.ok) setError(result.message);
  }
  return (
    <details className="group">
      <summary className="cursor-pointer text-sm text-primary underline-offset-4 hover:underline">
        Retry
      </summary>
      <ClientForm onSubmit={submit} className="mt-2 grid w-64 max-w-full gap-2">
        <FormError message={error} />
        <Field id={`dead-letter-reason-${deadLetterId}`} label="Reason (the fix made)">
          {(aria) => (
            <Textarea
              {...aria}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={10}
              maxLength={2000}
              rows={2}
              required
            />
          )}
        </Field>
        <div>
          <Button type="submit" size="sm" disabled={busy || reason.trim().length < 10}>
            {busy ? 'Retrying…' : 'Retry job'}
          </Button>
        </div>
      </ClientForm>
    </details>
  );
}

/** Records how a quarantined webhook event was resolved (audited). */
export function ResolveQuarantineForm({ quarantineId }: { quarantineId: string }) {
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await resolveQuarantineAction({ quarantineId, resolution });
    setBusy(false);
    if (!result.ok) setError(result.message);
  }
  return (
    <details className="group">
      <summary className="cursor-pointer text-sm text-primary underline-offset-4 hover:underline">
        Resolve
      </summary>
      <ClientForm onSubmit={submit} className="mt-2 grid w-64 max-w-full gap-2">
        <FormError message={error} />
        <Field id={`resolution-${quarantineId}`} label="Resolution">
          {(aria) => (
            <Textarea
              {...aria}
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              minLength={10}
              maxLength={1000}
              rows={2}
              required
            />
          )}
        </Field>
        <div>
          <Button type="submit" size="sm" disabled={busy || resolution.trim().length < 10}>
            {busy ? 'Saving…' : 'Mark resolved'}
          </Button>
        </div>
      </ClientForm>
    </details>
  );
}

/**
 * Acknowledges a dead letter with a note, or replaces the note (audited, ADR-169): the other
 * administrators see that someone looked at it, and what they found.
 */
export function AcknowledgeDeadLetterForm({
  deadLetterId,
  acknowledged,
}: {
  deadLetterId: string;
  acknowledged: boolean;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await acknowledgeDeadLetterAction({ deadLetterId, note });
    setBusy(false);
    if (!result.ok) setError(result.message);
    else setNote('');
  }
  const id = `acknowledge-dead-letter-${deadLetterId}`;
  return (
    <details className="group">
      <summary className="cursor-pointer text-sm text-primary underline-offset-4 hover:underline">
        {acknowledged ? 'Replace the note' : 'Acknowledge'}
      </summary>
      <ClientForm onSubmit={submit} className="mt-2 grid w-64 max-w-full gap-2">
        <FormError message={error} />
        <Field id={id} label="Note (what was found or done)">
          {(aria) => (
            <Textarea
              {...aria}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              minLength={10}
              maxLength={500}
              rows={2}
              required
            />
          )}
        </Field>
        <div>
          <Button type="submit" size="sm" disabled={busy || note.trim().length < 10}>
            {busy ? 'Saving…' : 'Acknowledge dead letter'}
          </Button>
        </div>
      </ClientForm>
    </details>
  );
}

/**
 * Acknowledges a webhook receipt the console lists with a note, or replaces the note (audited,
 * ADR-179): the other administrators see who looked at it.
 */
export function AcknowledgeReceiptForm({
  receiptId,
  acknowledged,
}: {
  receiptId: string;
  acknowledged: boolean;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await acknowledgeReceiptAction({ receiptId, note });
    setBusy(false);
    if (!result.ok) setError(result.message);
    else setNote('');
  }
  const id = `acknowledge-receipt-${receiptId}`;
  return (
    <details className="group">
      <summary className="cursor-pointer text-sm text-primary underline-offset-4 hover:underline">
        {acknowledged ? 'Replace the note' : 'Acknowledge'}
      </summary>
      <ClientForm onSubmit={submit} className="mt-2 grid w-64 max-w-full gap-2">
        <FormError message={error} />
        <Field id={id} label="Note (what was found or done)">
          {(aria) => (
            <Textarea
              {...aria}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              minLength={10}
              maxLength={500}
              rows={2}
              required
            />
          )}
        </Field>
        <div>
          <Button type="submit" size="sm" disabled={busy || note.trim().length < 10}>
            {busy ? 'Saving…' : 'Acknowledge receipt'}
          </Button>
        </div>
      </ClientForm>
    </details>
  );
}

/**
 * Acknowledges a queue that is late now with a note, or replaces the note (audited, ADR-177): the
 * other administrators see who looked at it. The lateness is named by when it began, as the page
 * shows it, so a page left open does not acknowledge a later one.
 */
export function AcknowledgeLateQueueForm({
  queue,
  lateSince,
  acknowledged,
}: {
  queue: string;
  lateSince: string;
  acknowledged: boolean;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await acknowledgeLateQueueAction({ queue, lateSince, note });
    setBusy(false);
    if (!result.ok) setError(result.message);
    else setNote('');
  }
  const id = `acknowledge-late-queue-${queue}`;
  return (
    <details className="group">
      <summary className="cursor-pointer text-sm text-primary underline-offset-4 hover:underline">
        {acknowledged ? 'Replace the note' : 'Acknowledge'}
      </summary>
      <ClientForm onSubmit={submit} className="mt-2 grid w-64 max-w-full gap-2">
        <FormError message={error} />
        <Field id={id} label="Note (what was found or done)">
          {(aria) => (
            <Textarea
              {...aria}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              minLength={10}
              maxLength={500}
              rows={2}
              required
            />
          )}
        </Field>
        <div>
          <Button type="submit" size="sm" disabled={busy || note.trim().length < 10}>
            {busy ? 'Saving…' : 'Acknowledge late queue'}
          </Button>
        </div>
      </ClientForm>
    </details>
  );
}

/**
 * Acknowledges a company's failing integration with a note, or replaces the note (audited,
 * ADR-141): the other administrators see who took it.
 */
export function AcknowledgeFailureForm({
  source,
  subjectId,
  state,
  acknowledged,
}: {
  source: string;
  subjectId: string;
  state: string;
  acknowledged: boolean;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await acknowledgeIntegrationFailureAction({ source, subjectId, state, note });
    setBusy(false);
    if (!result.ok) setError(result.message);
    else setNote('');
  }
  const id = `acknowledge-${source}-${subjectId}-${state}`;
  return (
    <details className="group">
      <summary className="cursor-pointer text-sm text-primary underline-offset-4 hover:underline">
        {acknowledged ? 'Replace the note' : 'Acknowledge'}
      </summary>
      <ClientForm onSubmit={submit} className="mt-2 grid w-64 max-w-full gap-2">
        <FormError message={error} />
        <Field id={id} label="Note (what was done or found)">
          {(aria) => (
            <Textarea
              {...aria}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              minLength={10}
              maxLength={500}
              rows={2}
              required
            />
          )}
        </Field>
        <div>
          <Button type="submit" size="sm" disabled={busy || note.trim().length < 10}>
            {busy ? 'Saving…' : 'Acknowledge failure'}
          </Button>
        </div>
      </ClientForm>
    </details>
  );
}
