'use client';
import { useState } from 'react';
import { Button, Checkbox, Field, Input, Label, Select, Textarea } from '@w360/ui';
import { requestCreditRefundAction } from '@/app/actions/platform';
import { FormError, FormSuccess } from '@/components/form-status';
import { ClientForm } from '@/components/client-form';

export interface RefundableTopup {
  id: string;
  /** Receipt number, amount and date, as the page shows them. */
  label: string;
  /** The most this refund can be: the unrefunded amount, capped by the available credit. */
  maxMinor: number;
  /** `maxMinor` as a plain rupee amount ("250.50"), the form's starting value. */
  maxAmount: string;
  maxLabel: string;
}

/**
 * Refunds unused service credit from one paid top-up (platform owners, ADR-058). The server checks
 * every rule again under the wallet's lock; the form only helps pick an amount that can pass.
 */
export function CreditRefundForm({
  tenantId,
  topups,
}: {
  tenantId: string;
  topups: RefundableTopup[];
}) {
  const [topupId, setTopupId] = useState(topups[0]?.id ?? '');
  const selected = topups.find((t) => t.id === topupId) ?? topups[0];
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
    const result = await requestCreditRefundAction({
      tenantId,
      topupId: selected.id,
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
      'Refund requested. The credit is reserved now; Razorpay is asked within a few minutes and the company’s billing managers are emailed when it accepts.',
    );
  }

  // Nothing left to refund, often right after a refund: the page refreshes without the payment,
  // and this stays mounted so the confirmation is still shown.
  if (!selected) {
    return (
      <div className="grid gap-3">
        <FormSuccess message={done} />
        <p className="text-muted-foreground">
          Nothing to refund: a refund needs a paid top-up with an unrefunded amount, no other refund
          of it in progress, and available credit.
        </p>
      </div>
    );
  }
  return (
    <ClientForm onSubmit={submit} className="grid gap-3" aria-label="Refund service credit">
      <FormError message={error} />
      <FormSuccess message={done} />
      <Field id="refund-topup" label="Payment to refund">
        {(aria) => (
          <Select
            {...aria}
            value={selected.id}
            onChange={(e) => {
              setTopupId(e.target.value);
              setAmount(topups.find((t) => t.id === e.target.value)?.maxAmount ?? '');
            }}
          >
            {topups.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        id="refund-amount"
        label="Amount in rupees"
        description={`At most ${selected.maxLabel}: what is left of the payment, and no more than the available credit.`}
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
        id="refund-reason"
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
          id="refund-confirm"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        <Label htmlFor="refund-confirm" className="font-normal">
          The money goes back to the card, UPI or bank account the payment came from, from HyFib’s
          Razorpay balance, and cannot be taken back. Razorpay keeps its fee.
        </Label>
      </div>
      <div>
        <Button
          type="submit"
          variant="destructive"
          disabled={busy || !confirmed || reason.trim().length < 10 || amount.trim() === ''}
        >
          Refund credit
        </Button>
      </div>
    </ClientForm>
  );
}
