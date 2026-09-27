'use client';
import { useId, useState } from 'react';
import { Button, Field, Input } from '@w360/ui';
import {
  answerPrivacyRequestAction,
  removeStoreAction,
  requestStoreSyncAction,
  startShopifyConnectAction,
  startWooConnectAction,
  updateStoreSettingsAction,
} from '@/app/actions/stores';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

/** Asks the worker to read the store again now (and to check HyFib's webhooks there). */
export function StoreSyncButton({ slug, storeId }: { slug: string; storeId: string }) {
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
            void requestStoreSyncAction(slug, { id: storeId }).then((r) => {
              setBusy(false);
              if (!r.ok) setError(r.message);
            });
          }}
        >
          {busy ? 'Asking…' : 'Read the store now'}
        </ClientButton>
      </div>
      <FormError message={error} />
    </div>
  );
}

/** Connects a failed or uninstalled store again (a new approval in Shopify or WooCommerce). */
export function StoreReconnectButton({
  slug,
  platform,
  address,
}: {
  slug: string;
  platform: 'shopify' | 'woocommerce';
  /** The shop's myshopify.com name or the WooCommerce site address. */
  address: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-2">
      <div>
        <ClientButton
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            const started =
              platform === 'shopify'
                ? startShopifyConnectAction(slug, { shop: address, callingCode: '' })
                : startWooConnectAction(slug, { url: address, callingCode: '' });
            void started.then((r) => {
              if (!r.ok) {
                setBusy(false);
                setError(r.message);
                return;
              }
              window.location.assign(r.data.url);
            });
          }}
        >
          {busy ? 'Opening…' : 'Connect again'}
        </ClientButton>
      </div>
      <FormError message={error} />
    </div>
  );
}

/** Removes the store after a confirmation: HyFib leaves the store and deletes what it read. */
export function StoreRemoveButton({
  slug,
  storeId,
  platform,
}: {
  slug: string;
  storeId: string;
  platform: 'shopify' | 'woocommerce';
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-2">
      {confirming ? (
        <div className="grid gap-2 rounded-md border border-border p-3 text-sm" role="alert">
          <p>
            {platform === 'shopify'
              ? 'Remove this store? HyFib uninstalls itself from Shopify and deletes the orders and products it read.'
              : 'Remove this store? HyFib deletes its webhooks from the site and the orders and products it read. Revoke the key in WooCommerce → Settings → Advanced → REST API as well.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <ClientButton
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                void removeStoreAction(slug, { id: storeId }).then((r) => {
                  setBusy(false);
                  setConfirming(false);
                  if (!r.ok) setError(r.message);
                });
              }}
            >
              {busy ? 'Removing…' : 'Yes, remove the store'}
            </ClientButton>
            <ClientButton size="sm" variant="outline" onClick={() => setConfirming(false)}>
              Keep it
            </ClientButton>
          </div>
        </div>
      ) : (
        <div>
          <ClientButton size="sm" variant="outline" onClick={() => setConfirming(true)}>
            Remove store
          </ClientButton>
        </div>
      )}
      <FormError message={error} />
    </div>
  );
}

/** The calling code for customers' numbers typed without one. */
export function StoreSettingsForm({
  slug,
  storeId,
  callingCode,
}: {
  slug: string;
  storeId: string;
  callingCode: string | null;
}) {
  const p = useId();
  const [code, setCode] = useState(callingCode ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(null);
        void updateStoreSettingsAction(slug, { id: storeId, callingCode: code }).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else setSaved('Saved. Orders from the last 60 days are read again with this setting.');
        });
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved} />
      <Field
        id={`${p}-code`}
        label="Country calling code for numbers without one"
        description="Leave empty to link only numbers that include their country code."
      >
        {(aria) => (
          <Input
            {...aria}
            inputMode="numeric"
            maxLength={4}
            placeholder="91"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        )}
      </Field>
      <div>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </ClientForm>
  );
}

/** Marks a Shopify customer data request answered (who asked is then no longer kept). */
export function AnswerRequestButton({ slug, requestId }: { slug: string; requestId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-1">
      <div>
        <ClientButton
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void answerPrivacyRequestAction(slug, { id: requestId }).then((r) => {
              setBusy(false);
              if (!r.ok) setError(r.message);
            });
          }}
        >
          {busy ? 'Saving…' : 'Mark answered'}
        </ClientButton>
      </div>
      <FormError message={error} />
    </div>
  );
}
