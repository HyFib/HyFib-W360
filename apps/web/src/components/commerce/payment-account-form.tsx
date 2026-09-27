'use client';
import { useId, useState } from 'react';
import { Button, Field, Input } from '@w360/ui';
import { removePaymentAccountAction, savePaymentAccountAction } from '@/app/actions/commerce';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

/**
 * Saves the company's Razorpay key id, key secret and webhook secret. The secrets are sent once
 * and never shown again; both fields are cleared after saving and must be entered again to change
 * the keys.
 */
export function PaymentAccountForm({
  slug,
  keyId: currentKeyId,
  liveAllowed,
}: {
  slug: string;
  keyId: string | null;
  liveAllowed: boolean;
}) {
  const p = useId();
  const [keyId, setKeyId] = useState(currentKeyId ?? '');
  const [keySecret, setKeySecret] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm
      className="grid gap-4"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setIssues({});
        setSaved(null);
        void savePaymentAccountAction(slug, { keyId, keySecret, webhookSecret }).then((r) => {
          setBusy(false);
          if (!r.ok) {
            setError(r.message);
            setIssues(Object.fromEntries((r.issues ?? []).map((i) => [i.path, i.message])));
          } else {
            setKeySecret('');
            setWebhookSecret('');
            setSaved('Saved. HyFib is checking the keys with Razorpay; reload in a moment.');
          }
        });
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved} />
      <Field
        id={`${p}-key`}
        label="Key id"
        description={
          liveAllowed
            ? 'From Razorpay’s API keys page: rzp_test_… for testing or rzp_live_… to take real payments.'
            : 'From Razorpay’s API keys page. Only test keys (rzp_test_…) can be used here: live keys are accepted in production only.'
        }
        error={issues.keyId}
      >
        {(aria) => (
          <Input
            {...aria}
            required
            autoComplete="off"
            spellCheck={false}
            maxLength={60}
            placeholder="rzp_test_…"
            value={keyId}
            onChange={(e) => setKeyId(e.target.value)}
          />
        )}
      </Field>
      <Field
        id={`${p}-secret`}
        label="Key secret"
        description="Stored encrypted and never shown again."
        error={issues.keySecret}
      >
        {(aria) => (
          <Input
            {...aria}
            type="password"
            required
            autoComplete="new-password"
            maxLength={200}
            value={keySecret}
            onChange={(e) => setKeySecret(e.target.value)}
          />
        )}
      </Field>
      <Field
        id={`${p}-webhook`}
        label="Webhook secret"
        description="Choose a long random secret and enter the same one in Razorpay’s webhook settings for the address below. Stored encrypted and never shown again."
        error={issues.webhookSecret}
      >
        {(aria) => (
          <Input
            {...aria}
            type="password"
            required
            autoComplete="new-password"
            maxLength={200}
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
          />
        )}
      </Field>
      <div>
        <Button
          type="submit"
          disabled={busy || !keyId.trim() || !keySecret.trim() || !webhookSecret.trim()}
        >
          {busy ? 'Saving…' : currentKeyId ? 'Replace keys' : 'Save keys'}
        </Button>
      </div>
    </ClientForm>
  );
}

/** Removes the keys (refused while a Payment Link is open), after a confirmation. */
export function RemovePaymentAccountButton({ slug }: { slug: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-2">
      {confirming ? (
        <div className="grid gap-2 rounded-md border border-border p-3 text-sm" role="alert">
          <p>
            Remove your Razorpay keys from HyFib? Payment can no longer be requested until you add
            them again.
          </p>
          <div className="flex gap-2">
            <ClientButton
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                void removePaymentAccountAction(slug).then((r) => {
                  setBusy(false);
                  setConfirming(false);
                  if (!r.ok) setError(r.message);
                });
              }}
            >
              {busy ? 'Removing…' : 'Yes, remove the keys'}
            </ClientButton>
            <ClientButton size="sm" variant="outline" onClick={() => setConfirming(false)}>
              Keep them
            </ClientButton>
          </div>
        </div>
      ) : (
        <div>
          <ClientButton size="sm" variant="outline" onClick={() => setConfirming(true)}>
            Remove keys
          </ClientButton>
        </div>
      )}
      <FormError message={error} />
    </div>
  );
}
