'use client';
import { useState } from 'react';
import { Button, Field, Input } from '@w360/ui';
import { confirmTopupAction, startTopupAction } from '@/app/actions/billing';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';
import { CheckoutClosedError, openCheckout } from './razorpay-checkout';

const PRESETS = ['1000', '5000', '10000'];

/**
 * Manual top-up: the server creates the order, Razorpay Checkout takes the card, and the server
 * verifies and fetches the payment before anything is credited. A payment that is still being
 * confirmed is shown as such and credited by the webhook or reconciliation.
 */
export function AddCredit({ slug }: { slug: string }) {
  const [amount, setAmount] = useState('1000');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setFieldError(undefined);
    try {
      const started = await startTopupAction(slug, { amount });
      if (!started.ok) {
        setError(started.message);
        setFieldError(started.issues?.find((i) => i.path === 'amount')?.message);
        return;
      }
      const checkout = started.data;
      let response;
      try {
        response = await openCheckout({
          keyId: checkout.keyId,
          orderId: checkout.orderId,
          amountMinor: checkout.amountMinor,
          companyName: checkout.companyName,
          description: 'Service credit',
          prefill: checkout.prefill,
          onAttemptFailed: (message) =>
            setError(`${message} You can try again in the payment window.`),
        });
      } catch (checkoutError) {
        if (checkoutError instanceof CheckoutClosedError) {
          setNotice(
            'Payment window closed. No money was taken unless your bank confirms a payment.',
          );
          return;
        }
        throw checkoutError;
      }
      setError(null);
      const confirmed = await confirmTopupAction(slug, {
        topupId: checkout.topupId,
        paymentId: response.razorpay_payment_id,
        signature: response.razorpay_signature,
      });
      if (!confirmed.ok) {
        setError(confirmed.message);
        return;
      }
      if (confirmed.data.status === 'credited')
        setNotice('Payment received. Your credit is updated.');
      else if (confirmed.data.status === 'processing')
        setNotice(
          'Payment received and being confirmed. Your credit updates as soon as Razorpay confirms it.',
        );
      else setError('The payment failed. No credit was added.');
    } catch (unexpected) {
      setError(
        unexpected instanceof Error ? unexpected.message : 'The payment could not be started.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <ClientForm onSubmit={submit} className="grid gap-3 sm:max-w-md">
      <FormError message={error} />
      <FormSuccess message={notice} />
      <Field
        id="topup-amount"
        label="Amount (₹)"
        description="Between ₹100 and ₹1,00,000. Paid by card through Razorpay."
        error={fieldError}
      >
        {(aria) => (
          <Input
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            {...aria}
          />
        )}
      </Field>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Suggested amounts">
        {PRESETS.map((preset) => (
          <Button
            key={preset}
            type="button"
            size="sm"
            variant={amount === preset ? 'secondary' : 'outline'}
            aria-pressed={amount === preset}
            onClick={() => setAmount(preset)}
          >
            ₹{Number(preset).toLocaleString('en-IN')}
          </Button>
        ))}
      </div>
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Opening payment…' : 'Add credit'}
        </Button>
      </div>
    </ClientForm>
  );
}
