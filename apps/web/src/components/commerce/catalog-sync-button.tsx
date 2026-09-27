'use client';
import { useState } from 'react';
import { requestCatalogSyncAction } from '@/app/actions/commerce';
import { ClientButton } from '@/components/client-form';
import { FormError } from '@/components/form-status';

/** Asks the worker to read the account's catalogs and products from Meta again. */
export function CatalogSyncButton({
  slug,
  whatsappAccountId,
  busy: working,
}: {
  slug: string;
  whatsappAccountId: string;
  /** A read is already waiting or running. */
  busy: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-2">
      <div>
        <ClientButton
          size="sm"
          variant="outline"
          disabled={busy || working}
          onClick={() => {
            setBusy(true);
            setError(null);
            setMessage(null);
            void requestCatalogSyncAction(slug, { whatsappAccountId }).then((r) => {
              setBusy(false);
              if (!r.ok) setError(r.message);
              else setMessage('HyFib is reading your catalog from Meta. Reload in a moment.');
            });
          }}
        >
          {working ? 'Reading from Meta…' : busy ? 'Asking…' : 'Read from Meta'}
        </ClientButton>
      </div>
      {message ? (
        <p className="text-sm text-muted-foreground" role="status">
          {message}
        </p>
      ) : null}
      <FormError message={error} />
    </div>
  );
}
