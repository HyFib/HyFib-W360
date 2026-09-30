'use client';
import { useState } from 'react';
import { Button, Checkbox, Field, Input, Label, Select, Textarea } from '@w360/ui';
import { requestPlanPaymentRefundAction } from '@/app/actions/platform';
import { FormError, FormSuccess } from '@/components/form-status';
import { ClientForm } from '@/components/client-form';

export interface RefundablePlanPayment {
  id: string;
  /** Receipt number, amount and date, as the page shows them. */
  label: string;
  /** The most this refund can be: what Razorpay has not refunded of the payment. */
  maxMinor: number;
  /** `maxMinor` as a plain rupee amount ("250.50"), the form's starting value. */
  maxAmount: string;
  maxLabel: string;
}

/**
 * Refunds part or all of one plan payment (platform owners, ADR-103). The server checks every rule
 * again under the payment's lock; the form only helps pick an amount that can pass.
 */
export function PlanPaymentRefundForm({
  tenantId,
  payments,
}: {
  tenantId: string;
  payments: RefundablePlanPayment[];
}) {
  const [paymentId, setPaymentId] = useState(payments[0]?.id ?? '');
  const selected = payments.find((p) => p.id === paymentId) ?? payments[0];
  const [amount, setAmount] = useState(selected?.maxAmount ?? '');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    // The payment shown: after a refund the list can change under a stale selection.
    if (!selected) return;
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await requestPlanPaymentRefundAction({
      tenantId,
      planPaymentId: selected.id,
      amount,
      reason,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setReason('');
    setConfirmed(false);
    setDone(
      'Refund requested. Razorpay is asked within a few minutes, and the company’s billing managers are emailed when it accepts. The plan and its paid period do not change.',
    );
  }

  // Nothing left to refund, often right after a refund: the page refreshes without the payment,
  // and this stays mounted so the confirmation is still shown.
  if (!selected) {
    return (
      <div className="grid gap-3">
        <FormSuccess message={done} />
        <p className="text-muted-foreground">
          Nothing to refund: a refund needs a plan payment with an unrefunded amount and no other
          refund of it in progress.
        </p>
      </div>
    );
  }
  return (
    <ClientForm onSubmit={submit} className="grid gap-3" aria-label="Refund a plan payment">
      <FormError message={error} />
      <FormSuccess message={done} />
      <Field id="plan-refund-payment" label="Payment to refund">
        {(aria) => (
          <Select
            {...aria}
            value={selected.id}
            onChange={(e) => {
              setPaymentId(e.target.value);
              setAmount(payments.find((p) => p.id === e.target.value)?.maxAmount ?? '');
            }}
          >
            {payments.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        id="plan-refund-amount"
        label="Amount in rupees"
        description={`At most ${selected.maxLabel}: what is left of the payment.`}
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
      <Field
        id="plan-refund-reason"
        label="Reason (ticket reference and why; kept in the platform audit log, not shown to the company)"
      >
        {(aria) => (
          <Textarea
            {...aria}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={10}
            maxLength={2000}
            required
          />
        )}
      </Field>
      <div className="flex items-start gap-2">
        <Checkbox
          id="plan-refund-confirm"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        <Label htmlFor="plan-refund-confirm" className="font-normal">
          The money goes back to the card, UPI or bank account the payment came from, from HyFib’s
          Razorpay balance, and cannot be taken back. Razorpay keeps its fee. The company’s plan and
          its paid period do not change: to end them, cancel the subscription and change the plan.
        </Label>
      </div>
      <div>
        <Button
          type="submit"
          variant="destructive"
          disabled={busy || !confirmed || reason.trim().length < 10 || amount.trim() === ''}
        >
          Refund payment
        </Button>
      </div>
    </ClientForm>
  );
}
