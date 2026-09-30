'use client';
import { useState } from 'react';
import { Field, Input, Textarea } from '@w360/ui';
import { cancelTenantDeletionAction, scheduleTenantDeletionAction } from '@/app/actions/platform';
import { FormError } from '@/components/form-status';
import { ClientButton, ClientForm } from '@/components/client-form';

/** The reason's length, from the domain (`STAFF_DELETION_REASON`). */
export interface ReasonLimits {
  min: number;
  max: number;
}

/** Schedules the company's deletion for HyFib once its address is typed and a reason given. */
export function ScheduleDeletionForm({
  tenantId,
  slug,
  limits,
}: {
  tenantId: string;
  slug: string;
  limits: ReasonLimits;
}) {
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await scheduleTenantDeletionAction({ tenantId, confirm, reason });
    setBusy(false);
    if (!result.ok) setError(result.message);
  }
  return (
    <ClientForm
      onSubmit={submit}
      aria-label="Schedule the company’s deletion"
      className="grid max-w-xl gap-3"
    >
      <FormError message={error} />
      <Field
        id="staff-deletion-reason"
        label="Reason (emailed to the owners and administrators, and shown in the company)"
      >
        {(aria) => (
          <Textarea
            {...aria}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={limits.min}
            maxLength={limits.max}
            required
          />
        )}
      </Field>
      <Field id="staff-deletion-confirm" label={`Type the company address (${slug}) to confirm`}>
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
          disabled={busy || confirm.trim() !== slug || reason.trim().length < limits.min}
        >
          {busy ? 'Scheduling…' : 'Schedule the deletion'}
        </ClientButton>
      </div>
    </ClientForm>
  );
}

/** Cancels a deletion HyFib scheduled, with a reason the company reads. */
export function CancelStaffDeletionForm({
  tenantId,
  limits,
}: {
  tenantId: string;
  limits: ReasonLimits;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await cancelTenantDeletionAction({ tenantId, reason });
    setBusy(false);
    if (!result.ok) setError(result.message);
    else setReason('');
  }
  return (
    <ClientForm
      onSubmit={submit}
      aria-label="Cancel HyFib’s deletion"
      className="grid max-w-xl gap-3"
    >
      <FormError message={error} />
      <Field
        id="staff-deletion-cancel-reason"
        label="Reason for cancelling (emailed to the owners and administrators)"
      >
        {(aria) => (
          <Textarea
            {...aria}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={limits.min}
            maxLength={limits.max}
            required
          />
        )}
      </Field>
      <div>
        <ClientButton type="submit" disabled={busy || reason.trim().length < limits.min}>
          {busy ? 'Cancelling…' : 'Cancel the deletion'}
        </ClientButton>
      </div>
    </ClientForm>
  );
}
