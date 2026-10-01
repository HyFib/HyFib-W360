'use client';
import { useState } from 'react';
import { Checkbox, Field, Label, Textarea } from '@w360/ui';
import { decidePlanRefundRequestAction, decideRefundRequestAction } from '@/app/actions/platform';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError } from '@/components/form-status';

/**
 * Approves or declines a company's refund request (platform owners): of service credit (ADR-073),
 * where approving starts the staff refund of ADR-058, or of a plan payment (ADR-104), where it starts
 * the staff refund of ADR-103. The server checks every rule again under its locks; declining needs a
 * note the company reads. A decided request leaves the open list, and this form with it.
 */
export function RefundRequestDecision({
  requestId,
  amountLabel,
  kind = 'credit',
}: {
  requestId: string;
  amountLabel: string;
  kind?: 'credit' | 'plan_payment';
}) {
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'approve' | 'decline') {
    setBusy(true);
    setError(null);
    const decideAction =
      kind === 'plan_payment' ? decidePlanRefundRequestAction : decideRefundRequestAction;
    const result = await decideAction({
      requestId,
      decision,
      note: note.trim() === '' ? undefined : note,
    });
    setBusy(false);
    if (!result.ok) setError(result.message);
  }

  return (
    <ClientForm
      onSubmit={(event) => event.preventDefault()}
      className="grid gap-3"
      aria-label="Decide the refund request"
    >
      <FormError message={error} />
      <Field
        id={`refund-decision-note-${requestId}`}
        label="Note for the company (needed to decline; optional to approve)"
      >
        {(aria) => (
          <Textarea
            {...aria}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            minLength={10}
            maxLength={1000}
            rows={2}
          />
        )}
      </Field>
      <div className="flex items-start gap-2">
        <Checkbox
          id={`refund-decision-confirm-${requestId}`}
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        <Label htmlFor={`refund-decision-confirm-${requestId}`} className="font-normal">
          Approving refunds {amountLabel} to the card, UPI or bank account the payment came from,
          from HyFib’s Razorpay balance. It cannot be taken back, and Razorpay keeps its fee.
          {kind === 'plan_payment' ? ' The company’s plan and its paid period do not change.' : ''}
        </Label>
      </div>
      <div className="flex flex-wrap gap-2">
        <ClientButton
          type="button"
          size="sm"
          variant="destructive"
          onClick={() => void decide('approve')}
          disabled={busy || !confirmed}
        >
          Approve and refund
        </ClientButton>
        <ClientButton
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void decide('decline')}
          disabled={busy || note.trim().length < 10}
        >
          Decline
        </ClientButton>
      </div>
    </ClientForm>
  );
}
