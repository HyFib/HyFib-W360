'use client';
import { useId, useState } from 'react';
import { Button, Field, Input } from '@w360/ui';
import {
  saveWooKeysAction,
  startShopifyConnectAction,
  startWooConnectAction,
} from '@/app/actions/stores';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

type Issues = Record<string, string>;
const issuesOf = (issues: { path: string; message: string }[] | undefined): Issues =>
  Object.fromEntries((issues ?? []).map((i) => [i.path, i.message]));

function CallingCodeField({
  id,
  value,
  onChange,
  error,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  return (
    <Field
      id={id}
      label="Country calling code for numbers without one (optional)"
      description="Customers’ numbers with a country code are always linked to contacts. Enter one (for example 91) to read numbers typed without it as numbers of that country; otherwise they are not linked. HyFib never guesses."
      error={error}
    >
      {(aria) => (
        <Input
          {...aria}
          inputMode="numeric"
          maxLength={4}
          placeholder="91"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/** Sends the member to Shopify to approve HyFib for their store (read orders and products). */
export function ShopifyConnectForm({
  slug,
  defaultShop = '',
}: {
  slug: string;
  defaultShop?: string;
}) {
  const p = useId();
  const [shop, setShop] = useState(defaultShop);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issues>({});
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setIssues({});
        void startShopifyConnectAction(slug, { shop, callingCode: code }).then((r) => {
          if (!r.ok) {
            setBusy(false);
            setError(r.message);
            setIssues(issuesOf(r.issues));
            return;
          }
          window.location.assign(r.data.url);
        });
      }}
    >
      <FormError message={error} />
      <Field
        id={`${p}-shop`}
        label="Shopify store"
        description="Your store’s myshopify.com address. You approve HyFib in Shopify next."
        error={issues.shop}
      >
        {(aria) => (
          <Input
            {...aria}
            required
            spellCheck={false}
            autoComplete="off"
            maxLength={300}
            placeholder="my-shop.myshopify.com"
            value={shop}
            onChange={(e) => setShop(e.target.value)}
          />
        )}
      </Field>
      <CallingCodeField
        id={`${p}-code`}
        value={code}
        onChange={setCode}
        error={issues.callingCode}
      />
      <div>
        <Button type="submit" disabled={busy || !shop.trim()}>
          {busy ? 'Opening Shopify…' : 'Connect with Shopify'}
        </Button>
      </div>
    </ClientForm>
  );
}

/** Sends the member to their WooCommerce site to approve Read/Write keys for HyFib. */
export function WooConnectForm({ slug, defaultUrl = '' }: { slug: string; defaultUrl?: string }) {
  const p = useId();
  const [url, setUrl] = useState(defaultUrl);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issues>({});
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setIssues({});
        void startWooConnectAction(slug, { url, callingCode: code }).then((r) => {
          if (!r.ok) {
            setBusy(false);
            setError(r.message);
            setIssues(issuesOf(r.issues));
            return;
          }
          window.location.assign(r.data.url);
        });
      }}
    >
      <FormError message={error} />
      <Field
        id={`${p}-url`}
        label="WooCommerce site"
        description="The site’s https address. You sign in to WordPress and approve HyFib there next."
        error={issues.url}
      >
        {(aria) => (
          <Input
            {...aria}
            required
            spellCheck={false}
            autoComplete="off"
            maxLength={300}
            placeholder="https://shop.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        )}
      </Field>
      <CallingCodeField
        id={`${p}-code`}
        value={code}
        onChange={setCode}
        error={issues.callingCode}
      />
      <div>
        <Button type="submit" disabled={busy || !url.trim()}>
          {busy ? 'Opening your site…' : 'Connect with WooCommerce'}
        </Button>
      </div>
    </ClientForm>
  );
}

/**
 * Connects a WooCommerce site with REST API keys created in WooCommerce (for sites where the
 * approval page cannot be used). The secret is stored encrypted and never shown again.
 */
export function WooKeysForm({ slug }: { slug: string }) {
  const p = useId();
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [consumerKey, setConsumerKey] = useState('');
  const [consumerSecret, setConsumerSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issues>({});
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
        void saveWooKeysAction(slug, { url, callingCode: code, consumerKey, consumerSecret }).then(
          (r) => {
            setBusy(false);
            if (!r.ok) {
              setError(r.message);
              setIssues(issuesOf(r.issues));
              return;
            }
            setConsumerSecret('');
            setSaved('Saved. HyFib is checking the keys with your store.');
          },
        );
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved} />
      <Field id={`${p}-url`} label="WooCommerce site" error={issues.url}>
        {(aria) => (
          <Input
            {...aria}
            required
            spellCheck={false}
            maxLength={300}
            placeholder="https://shop.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        )}
      </Field>
      <Field
        id={`${p}-key`}
        label="Consumer key"
        description="WooCommerce → Settings → Advanced → REST API → Add key, with Read/Write permissions."
        error={issues.consumerKey}
      >
        {(aria) => (
          <Input
            {...aria}
            required
            spellCheck={false}
            maxLength={80}
            placeholder="ck_…"
            value={consumerKey}
            onChange={(e) => setConsumerKey(e.target.value)}
          />
        )}
      </Field>
      <Field
        id={`${p}-secret`}
        label="Consumer secret"
        description="Stored encrypted and never shown again."
        error={issues.consumerSecret}
      >
        {(aria) => (
          <Input
            {...aria}
            type="password"
            required
            autoComplete="new-password"
            maxLength={80}
            placeholder="cs_…"
            value={consumerSecret}
            onChange={(e) => setConsumerSecret(e.target.value)}
          />
        )}
      </Field>
      <CallingCodeField
        id={`${p}-code`}
        value={code}
        onChange={setCode}
        error={issues.callingCode}
      />
      <div>
        <Button
          type="submit"
          disabled={busy || !url.trim() || !consumerKey.trim() || !consumerSecret.trim()}
        >
          {busy ? 'Saving…' : 'Connect with these keys'}
        </Button>
      </div>
    </ClientForm>
  );
}
