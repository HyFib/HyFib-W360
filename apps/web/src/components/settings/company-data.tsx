'use client';
import { useState } from 'react';
import { Field, Input } from '@w360/ui';
import { cancelCompanyDeletionAction, requestCompanyDeletionAction } from '@/app/actions/tenancy';
import { ActionFailure, type ActionFailureState } from '@/components/action-failure';
import { ClientButton, ClientForm } from '@/components/client-form';

/** Schedules the company's deletion once the owner types its address. */
export function RequestDeletionForm({ slug }: { slug: string }) {
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionFailureState | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await requestCompanyDeletionAction(slug, { confirm });
    setBusy(false);
    if (!result.ok) setError(result);
  }
  return (
    <ClientForm onSubmit={submit} className="grid max-w-md gap-3">
      <ActionFailure failure={error} />
      <Field id="delete-confirm" label={`Type the company address (${slug}) to confirm`}>
        {(aria) => (
          <Input
            {...aria}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
        )}
      </Field>
      <div>
        <ClientButton
          type="submit"
          variant="destructive"
          disabled={busy || confirm.trim() !== slug}
        >
          {busy ? 'Scheduling…' : 'Delete the company'}
        </ClientButton>
      </div>
    </ClientForm>
  );
}

/** Cancels a scheduled deletion (until the worker starts it). */
export function CancelDeletionButton({ slug }: { slug: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionFailureState | null>(null);
  async function cancel() {
    setBusy(true);
    setError(null);
    const result = await cancelCompanyDeletionAction(slug);
    setBusy(false);
    if (!result.ok) setError(result);
  }
  return (
    <div className="grid gap-2">
      <ActionFailure failure={error} />
      <div>
        <ClientButton onClick={cancel} disabled={busy}>
          {busy ? 'Cancelling…' : 'Cancel the deletion'}
        </ClientButton>
      </div>
    </div>
  );
}
