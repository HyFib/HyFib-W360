'use client';
import { useState } from 'react';
import { Button, Field, Input, Textarea } from '@w360/ui';
import {
  askForPlanRefundAction,
  askForRefundAction,
  withdrawPlanRefundRequestAction,
  withdrawRefundRequestAction,
} from '@/app/actions/billing';
import { ActionFailure, type ActionFailureState } from '@/components/action-failure';
import { ClientButton, ClientForm } from '@/components/client-form';

/** What a request asks HyFib to refund: unused credit from a top-up, or a plan payment. */
export type RefundRequestTarget =
  { kind: 'topup'; topupId: string } | { kind: 'plan_payment'; planPaymentId: string };

/**
 * Asks HyFib to refund unused credit from a top-up (ADR-073) or part of a plan payment (ADR-104). A
 * platform owner decides; the server checks every rule, and approving checks them again, so the form
 * only suggests an amount. After a request the page shows it as waiting and no longer offers the
 * form.
 */
export function RefundRequestForm({
  slug,
  target,
  maxAmount,
  maxLabel,
}: {
  slug: string;
  target: RefundRequestTarget;
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
    const result =
      target.kind === 'topup'
        ? await askForRefundAction(slug, { topupId: target.topupId, amount, reason })
        : await askForPlanRefundAction(slug, {
            planPaymentId: target.planPaymentId,
            amount,
            reason,
          });
    setBusy(false);
    if (!result.ok) setFailure(result);
  }

  return (
    <ClientForm onSubmit={submit} className="grid gap-3" aria-label="Ask for a refund">
      <ActionFailure failure={failure} />
      <Field
        id="refund-request-amount"
        label="Amount in rupees"
        description={
          target.kind === 'topup'
            ? `At most ${maxLabel}: what is left of this payment, and no more than your unused credit.`
            : `At most ${maxLabel}: what is left of this payment.`
        }
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

/** Withdraws an open request (ADR-073, ADR-104). */
export function WithdrawRefundRequestButton({
  slug,
  requestId,
  kind = 'topup',
}: {
  slug: string;
  requestId: string;
  kind?: RefundRequestTarget['kind'];
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ActionFailureState | null>(null);
  async function withdraw() {
    setBusy(true);
    setFailure(null);
    const result =
      kind === 'topup'
        ? await withdrawRefundRequestAction(slug, requestId)
        : await withdrawPlanRefundRequestAction(slug, requestId);
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
