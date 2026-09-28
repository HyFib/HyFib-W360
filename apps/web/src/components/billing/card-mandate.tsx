'use client';
import { useState } from 'react';
import { Button, Field, Input } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import {
  cancelMandateAction,
  confirmMandateAction,
  startMandateSetupAction,
} from '@/app/actions/billing';
import { ActionFailure, type ActionFailureState } from '@/components/action-failure';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormSuccess } from '@/components/form-status';
import { CheckoutClosedError, openCheckout } from './razorpay-checkout';

/**
 * Registers the card mandate used by auto-recharge: a ₹1 authorisation in Razorpay Checkout
 * (refunded once the mandate is confirmed). Only the card network, issuer, last four digits and
 * expiry are stored.
 */
export function CardMandateSetup({
  slug,
  defaultEmail,
  defaultContact,
}: {
  slug: string;
  defaultEmail: string;
  defaultContact: string;
}) {
  const [maxAmount, setMaxAmount] = useState('15000');
  const [email, setEmail] = useState(defaultEmail);
  const [contact, setContact] = useState(defaultContact);
  const [error, setError] = useState<ActionFailureState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setFieldErrors({});
    try {
      const started = await startMandateSetupAction(slug, { maxAmount, email, contact });
      if (!started.ok) {
        setError(started);
        setFieldErrors(Object.fromEntries((started.issues ?? []).map((i) => [i.path, i.message])));
        return;
      }
      const setup = started.data;
      let response;
      try {
        response = await openCheckout({
          keyId: setup.keyId,
          orderId: setup.orderId,
          amountMinor: setup.amountMinor,
          companyName: setup.companyName,
          description: 'Card authorisation for auto-recharge (₹1, refunded)',
          prefill: setup.prefill,
          customerId: setup.customerId,
          recurring: true,
          onAttemptFailed: (message) =>
            setError({
              code: 'provider_rejected',
              message: `${message} You can try again in the payment window.`,
            }),
        });
      } catch (checkoutError) {
        if (checkoutError instanceof CheckoutClosedError) {
          setNotice('Card setup cancelled.');
          return;
        }
        throw checkoutError;
      }
      setError(null);
      const confirmed = await confirmMandateAction(slug, {
        mandateId: setup.mandateId,
        paymentId: response.razorpay_payment_id,
        signature: response.razorpay_signature,
      });
      if (!confirmed.ok) {
        setError(confirmed);
        return;
      }
      setNotice(
        confirmed.data.status === 'active'
          ? 'Card saved for auto-recharge. The ₹1 authorisation is being refunded.'
          : 'Your bank is still confirming the card. This page updates when it is done.',
      );
    } catch (unexpected) {
      setError({
        code: 'internal',
        message: unexpected instanceof Error ? unexpected.message : 'The card could not be set up.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <ClientForm onSubmit={submit} className="grid gap-3 sm:max-w-md">
      <ActionFailure failure={error} />
      <FormSuccess message={notice} />
      <Field
        id="mandate-max"
        label="Largest single charge (₹)"
        description="Your bank will never let us charge more than this per recharge. ₹15,000 at most."
        error={fieldErrors.maxAmount}
      >
        {(aria) => (
          <Input
            inputMode="decimal"
            autoComplete="off"
            value={maxAmount}
            onChange={(e) => setMaxAmount(e.target.value)}
            {...aria}
          />
        )}
      </Field>
      <Field id="mandate-email" label="Billing email" error={fieldErrors.email}>
        {(aria) => (
          <Input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            {...aria}
          />
        )}
      </Field>
      <Field
        id="mandate-contact"
        label="Billing phone"
        description="With country code, for example +91 98765 43210. Your bank sends charge notices here."
        error={fieldErrors.contact}
      >
        {(aria) => (
          <Input
            type="tel"
            autoComplete="tel"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            {...aria}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Opening card setup…' : 'Set up card'}
        </Button>
      </div>
    </ClientForm>
  );
}

export function RemoveCard({ slug, mandateId }: { slug: string; mandateId: string }) {
  const [error, setError] = useState<ActionFailureState | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-2">
      <ActionFailure failure={error} />
      <ConfirmDialog
        trigger={
          <ClientButton variant="outline" size="sm" disabled={busy}>
            Remove card
          </ClientButton>
        }
        title="Remove this card?"
        description="Auto-recharge turns off and no new charges are requested. A charge your bank is already processing may still complete and will be added to your credit."
        confirmLabel="Remove card"
        destructive
        onConfirm={async () => {
          setBusy(true);
          setError(null);
          const result = await cancelMandateAction(slug, mandateId);
          setBusy(false);
          if (!result.ok) setError(result);
        }}
      />
    </div>
  );
}
