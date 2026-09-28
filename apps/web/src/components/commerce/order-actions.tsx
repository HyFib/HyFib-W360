'use client';
import { useState } from 'react';
import {
  cancelPaymentLinkAction,
  requestPaymentAction,
  setOrderStatusAction,
} from '@/app/actions/commerce';
import { ClientButton } from '@/components/client-form';
import { FormError } from '@/components/form-status';
import { ORDER_STATUS_ACTION } from '@/lib/commerce-labels';

type MemberStatus = 'confirmed' | 'fulfilled' | 'cancelled';

/** The statuses a member can move the order to; cancelling is asked twice. */
export function OrderStatusButtons({
  slug,
  orderId,
  version,
  next,
}: {
  slug: string;
  orderId: string;
  version: number;
  next: readonly string[];
}) {
  const [pending, setPending] = useState<MemberStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statuses = next.filter((s): s is MemberStatus =>
    ['confirmed', 'fulfilled', 'cancelled'].includes(s),
  );
  if (statuses.length === 0) return null;
  const run = (status: MemberStatus) => {
    setPending(status);
    setError(null);
    void setOrderStatusAction(slug, { id: orderId, expectedVersion: version, status }).then((r) => {
      setPending(null);
      setConfirming(false);
      if (!r.ok) setError(r.message);
    });
  };
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        {statuses.map((status) => (
          <ClientButton
            key={status}
            size="sm"
            variant={status === 'cancelled' ? 'outline' : 'primary'}
            disabled={pending !== null}
            onClick={() => (status === 'cancelled' ? setConfirming(true) : run(status))}
          >
            {pending === status ? 'Saving…' : ORDER_STATUS_ACTION[status]}
          </ClientButton>
        ))}
      </div>
      {confirming ? (
        <div className="grid gap-2 rounded-md border border-border p-3 text-sm" role="alert">
          <p>Cancel this order? The customer is not told automatically.</p>
          <div className="flex gap-2">
            <ClientButton size="sm" disabled={pending !== null} onClick={() => run('cancelled')}>
              {pending === 'cancelled' ? 'Saving…' : 'Yes, cancel the order'}
            </ClientButton>
            <ClientButton size="sm" variant="outline" onClick={() => setConfirming(false)}>
              Keep it
            </ClientButton>
          </div>
        </div>
      ) : null}
      <FormError message={error} />
    </div>
  );
}

/**
 * Asks the customer to pay the order total with a Payment Link, after a confirmation. The page then
 * shows the new link (the button disappears while it is open), so nothing is kept here.
 */
export function RequestPaymentButton({
  slug,
  orderId,
  version,
  amount,
}: {
  slug: string;
  orderId: string;
  version: number;
  /** The formatted total, shown in the confirmation. */
  amount: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-3">
      {!confirming ? (
        <div>
          <ClientButton size="sm" onClick={() => setConfirming(true)}>
            Request payment
          </ClientButton>
        </div>
      ) : (
        <div className="grid gap-2 rounded-md border border-border p-3 text-sm" role="alert">
          <p>
            Create a Payment Link for {amount} in your Razorpay account and send it in the chat? The
            link stays open for 7 days. The order counts as paid only when Razorpay reports the link
            paid.
          </p>
          <div className="flex gap-2">
            <ClientButton
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                void requestPaymentAction(slug, { id: orderId, expectedVersion: version }).then(
                  (r) => {
                    setBusy(false);
                    setConfirming(false);
                    if (!r.ok) setError(r.message);
                  },
                );
              }}
            >
              {busy ? 'Requesting…' : 'Yes, request payment'}
            </ClientButton>
            <ClientButton size="sm" variant="outline" onClick={() => setConfirming(false)}>
              Not now
            </ClientButton>
          </div>
        </div>
      )}
      <FormError message={error} />
    </div>
  );
}

/**
 * Cancels the order's open Payment Link at Razorpay (refused by Razorpay once paid). The page then
 * marks the link as being cancelled.
 */
export function CancelPaymentLinkButton({ slug, orderId }: { slug: string; orderId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-2">
      <div>
        <ClientButton
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void cancelPaymentLinkAction(slug, { orderId }).then((r) => {
              setBusy(false);
              if (!r.ok) setError(r.message);
            });
          }}
        >
          {busy ? 'Cancelling…' : 'Cancel the link'}
        </ClientButton>
      </div>
      <FormError message={error} />
    </div>
  );
}
