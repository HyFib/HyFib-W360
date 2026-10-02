'use client';
import { useState } from 'react';
import { ConfirmDialog } from '@w360/ui/client';
import {
  cancelPlanSubscriptionAction,
  confirmPlanSubscriptionAction,
  startPlanSubscriptionAction,
} from '@/app/actions/billing';
import { ActionFailure, type ActionFailureState } from '@/components/action-failure';
import { ClientButton } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';
import { CheckoutClosedError, openSubscriptionCheckout } from './razorpay-checkout';

/**
 * Paying for the plan (ADR-063): the server records the subscription and creates it at Razorpay,
 * Checkout takes the first period's payment (or, for a trial paid from its end, only authorises the
 * payment method, ADR-102), and the server verifies the response and asks Razorpay before the plan
 * counts as paid. A payment still being confirmed is shown as such.
 */
export function PayForPlan({ slug, label }: { slug: string; label: string }) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pay() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const started = await startPlanSubscriptionAction(slug);
      if (!started.ok) {
        setError(started.message);
        return;
      }
      const checkout = started.data;
      let response;
      try {
        response = await openSubscriptionCheckout({
          keyId: checkout.keyId,
          subscriptionId: checkout.providerSubscriptionId,
          companyName: checkout.companyName,
          description: `${checkout.planName} plan`,
          prefill: checkout.prefill,
          onAttemptFailed: (message) =>
            setError(`${message} You can try again in the payment window.`),
        });
      } catch (checkoutError) {
        if (checkoutError instanceof CheckoutClosedError) {
          setNotice(
            'Payment window closed. Nothing was charged unless Razorpay confirms a payment; you can finish paying within the hour.',
          );
          return;
        }
        throw checkoutError;
      }
      setError(null);
      const confirmed = await confirmPlanSubscriptionAction(slug, {
        subscriptionId: checkout.subscriptionId,
        paymentId: response.razorpay_payment_id,
        signature: response.razorpay_signature,
      });
      if (!confirmed.ok) {
        setError(confirmed.message);
        return;
      }
      if (confirmed.data.status === 'active') setNotice('Payment received. Your plan is paid.');
      else if (confirmed.data.status === 'scheduled')
        setNotice(
          'Payment method authorised. Razorpay charges for the plan when the trial ends; nothing is charged for it before then.',
        );
      else if (confirmed.data.status === 'processing')
        setNotice(
          'Payment received and being confirmed. Your plan updates as soon as Razorpay confirms it.',
        );
      else setError('The payment did not go through. Your plan is unchanged.');
    } catch (unexpected) {
      setError(
        unexpected instanceof Error ? unexpected.message : 'The payment could not be started.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      <FormError message={error} />
      <FormSuccess message={notice} />
      <div>
        <ClientButton onClick={() => void pay()} disabled={busy}>
          {busy ? 'Opening payment…' : label}
        </ClientButton>
      </div>
    </div>
  );
}

export function CancelPlanSubscription({
  slug,
  description,
}: {
  slug: string;
  description: string;
}) {
  const [error, setError] = useState<ActionFailureState | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-2">
      <ActionFailure failure={error} />
      <ConfirmDialog
        trigger={
          <ClientButton variant="outline" size="sm" disabled={busy}>
            Cancel subscription
          </ClientButton>
        }
        title="Cancel the subscription?"
        description={description}
        confirmLabel="Cancel subscription"
        cancelLabel="Keep paying"
        destructive
        onConfirm={async () => {
          setBusy(true);
          setError(null);
          const result = await cancelPlanSubscriptionAction(slug);
          setBusy(false);
          if (!result.ok) setError(result);
        }}
      />
    </div>
  );
}
