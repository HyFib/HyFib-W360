'use client';
import { useState } from 'react';
import { acceptInvitationAction } from '@/app/actions/tenancy';
import { FormError } from '@/components/form-status';
import { ClientButton } from '@/components/client-form';

export function AcceptInvitationButton({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function accept() {
    setBusy(true);
    setError(null);
    const result = await acceptInvitationAction(token);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full load deliberately drops all client state when the company/identity context changes
    window.location.assign(`/c/${result.data.slug}`);
  }
  return (
    <div className="grid gap-3">
      <FormError message={error} />
      <ClientButton onClick={accept} disabled={busy}>
        {busy ? 'Joining…' : 'Accept invitation'}
      </ClientButton>
    </div>
  );
}
