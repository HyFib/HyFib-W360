'use client';
import { useState } from 'react';
import { Button, Field, Input, Textarea } from '@w360/ui';
import { askForRefundAction, withdrawRefundRequestAction } from '@/app/actions/billing';
import { ActionFailure, type ActionFailureState } from '@/components/action-failure';
import { ClientButton, ClientForm } from '@/components/client-form';

/**
 * Asks HyFib to refund unused credit from this payment (ADR-073). A platform owner decides; the
 * server checks every rule, and approving checks them again, so the form only suggests an amount.
 * After a request the page shows it as waiting and no longer offers the form.
 */
export function RefundRequestForm({
  slug,
  topupId,
  maxAmount,
  maxLabel,
}: {
  slug: string;
  topupId: string;
  /** The most that can be asked for, as a plain rupee amount ("250.50"): the starting value. */
  maxAmount: string;
  maxLabel: string;
}) {
  const [amount, setAmount] = useState(maxAmount);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ActionFailureState | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    const result = await askForRefundAction(slug, { topupId, amount, reason });
    setBusy(false);
    if (!result.ok) setFailure(result);
  }

  return (
    <ClientForm onSubmit={submit} className="grid gap-3" aria-label="Ask for a refund">
      <ActionFailure failure={failure} />
      <Field
        id="refund-request-amount"
        label="Amount in rupees"
        description={`At most ${maxLabel}: what is left of this payment, and no more than your unused credit.`}
      >
        {(aria) => (
          <Input
            {...aria}
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        )}
      </Field>
      <Field id="refund-request-reason" label="Why you want the refund (HyFib reads this)">
        {(aria) => (
          <Textarea
            {...aria}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={10}
            maxLength={1000}
            required
          />
        )}
      </Field>
      <div>
        <Button
          type="submit"
          variant="outline"
          disabled={busy || reason.trim().length < 10 || amount.trim() === ''}
        >
          Ask for a refund
        </Button>
      </div>
    </ClientForm>
  );
}

/** Withdraws an open request (ADR-073). */
export function WithdrawRefundRequestButton({
  slug,
  requestId,
}: {
  slug: string;
  requestId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ActionFailureState | null>(null);
  async function withdraw() {
    setBusy(true);
    setFailure(null);
    const result = await withdrawRefundRequestAction(slug, requestId);
    setBusy(false);
    if (!result.ok) setFailure(result);
  }
  return (
    <div className="grid gap-1">
      <ActionFailure failure={failure} />
      <div>
        <ClientButton size="sm" variant="outline" onClick={() => void withdraw()} disabled={busy}>
          Withdraw
        </ClientButton>
      </div>
    </div>
  );
}
