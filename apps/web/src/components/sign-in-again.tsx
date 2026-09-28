'use client';
import { useState } from 'react';
import { Alert } from '@w360/ui';
import { ClientButton } from '@/components/client-form';
import { FormError } from '@/components/form-status';
import { authClient } from '@/lib/auth-client';

/**
 * Step-up re-authentication (ADR-056): signs the member out and brings them back to this page
 * once they have signed in again (with two-factor when it is on). Nothing else renews the window.
 */
export function SignInAgain({ reason }: { reason: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function signInAgain() {
    setBusy(true);
    setError(null);
    const here = `${window.location.pathname}${window.location.search}`;
    const result = await authClient.signOut();
    if (result.error) {
      setBusy(false);
      setError('Signing out did not work. Try again.');
      return;
    }
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full load drops the old session's client state
    window.location.assign(`/sign-in?next=${encodeURIComponent(here)}`);
  }
  return (
    <div className="grid gap-2">
      <Alert
        tone="info"
        title="Sign in again to continue"
        action={
          <ClientButton
            size="sm"
            variant="outline"
            onClick={() => void signInAgain()}
            disabled={busy}
          >
            {busy ? 'Signing out…' : 'Sign in again'}
          </ClientButton>
        }
      >
        {reason}
      </Alert>
      <FormError message={error} />
    </div>
  );
}
