'use client';
import { useState } from 'react';
import { Button, Field, Input, Textarea } from '@w360/ui';
import { requestSettlementReconAction, resolveSettlementItemAction } from '@/app/actions/platform';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

const QUEUED =
  'Queued: the worker reads Razorpay’s report for the day within a minute. Refresh this page to see the result.';

/** Reconciles a day, up to a year back (platform owners; the reason is audited). */
export function ReconcileDayForm({ latestDay }: { latestDay: string }) {
  const [date, setDate] = useState(latestDay);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await requestSettlementReconAction({ date, reason });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setReason('');
    setDone(QUEUED);
  }
  return (
    <ClientForm onSubmit={submit} className="grid gap-3" aria-label="Reconcile a day">
      <FormError message={error} />
      <FormSuccess message={done} />
      <Field
        id="recon-date"
        label="Settlement day (India time)"
        description="A day that is over, within the last year. A day already reconciled is read again."
      >
        {(aria) => (
          <Input
            {...aria}
            type="date"
            value={date}
            max={latestDay}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        )}
      </Field>
      <Field id="recon-reason" label="Reason (kept in the platform audit log)">
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
        <Button type="submit" disabled={busy || reason.trim().length < 10 || !date}>
          {busy ? 'Queuing…' : 'Reconcile this day'}
        </Button>
      </div>
    </ClientForm>
  );
}

/** Reads a day's report again, keeping what earlier runs recorded and resolutions (owners). */
export function RunDayAgainForm({ date }: { date: string }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await requestSettlementReconAction({ date, reason });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setReason('');
    setDone(QUEUED);
  }
  return (
    <ClientForm onSubmit={submit} className="grid gap-3" aria-label="Run this day again">
      <FormError message={error} />
      <FormSuccess message={done} />
      <Field id="recon-again-reason" label="Reason (kept in the platform audit log)">
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
        <Button type="submit" variant="secondary" disabled={busy || reason.trim().length < 10}>
          {busy ? 'Queuing…' : 'Run this day again'}
        </Button>
      </div>
    </ClientForm>
  );
}

/** Marks a transaction that needed a person as resolved, with a note (owners; audited). */
export function ResolveSettlementItemForm({
  itemId,
  entityId,
}: {
  itemId: string;
  entityId: string;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await resolveSettlementItemAction({ itemId, note });
    setBusy(false);
    if (!result.ok) setError(result.message);
  }
  return (
    <details className="group">
      <summary className="cursor-pointer text-sm text-primary underline-offset-4 hover:underline">
        Resolve
      </summary>
      <ClientForm
        onSubmit={submit}
        className="mt-2 grid w-64 max-w-full gap-2"
        aria-label={`Resolve ${entityId}`}
      >
        <FormError message={error} />
        <Field id={`recon-note-${itemId}`} label="What was checked or done">
          {(aria) => (
            <Textarea
              {...aria}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              minLength={10}
              maxLength={2000}
              rows={2}
              required
            />
          )}
        </Field>
        <div>
          <Button type="submit" size="sm" disabled={busy || note.trim().length < 10}>
            {busy ? 'Saving…' : 'Mark resolved'}
          </Button>
        </div>
      </ClientForm>
    </details>
  );
}
