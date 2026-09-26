'use client';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Checkbox } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import { eraseContactAction } from '@/app/actions/contacts';
import { FormError } from '@/components/form-status';
import { ClientButton } from '@/components/client-form';

/** Irreversible erasure of a contact's personal data (see the confirmation text). */
export function EraseContact({ slug, contactId }: { slug: string; contactId: string }) {
  const id = useId();
  const router = useRouter();
  const [suppress, setSuppress] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function erase() {
    setError(null);
    const result = await eraseContactAction(slug, { contactId, suppress });
    if (!result.ok) setError(result.message);
    else router.push(`/c/${slug}/contacts`);
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-start gap-2">
        <Checkbox id={id} checked={suppress} onChange={(e) => setSuppress(e.target.checked)} />
        <label htmlFor={id} className="text-sm">
          Keep the number on the suppression list so it is never messaged again
        </label>
      </div>
      <FormError message={error} />
      <div>
        <ConfirmDialog
          destructive
          title="Erase this contact?"
          description="Name, number, email, tags and custom values are deleted and every message in their conversations is redacted. Queued messages are cancelled. Consent history is kept as proof and ends with an opt-out. This cannot be undone."
          confirmLabel="Erase contact"
          onConfirm={() => void erase()}
          trigger={<ClientButton variant="destructive">Erase contact</ClientButton>}
        />
      </div>
    </div>
  );
}
