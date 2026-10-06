'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@w360/ui/client';
import { mergeContactsAction } from '@/app/actions/contacts';
import { FormError } from '@/components/form-status';
import { ClientButton } from '@/components/client-form';

/** Merges `mergeContactId` into `keepContactId` after a confirmation (ADR-224). */
export function MergeContacts({
  slug,
  keepContactId,
  mergeContactId,
  mergeName,
}: {
  slug: string;
  keepContactId: string;
  mergeContactId: string;
  mergeName: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function merge() {
    setError(null);
    const result = await mergeContactsAction(slug, { keepContactId, mergeContactId });
    if (!result.ok) setError(result.message);
    else router.push(`/c/${slug}/contacts/${keepContactId}?merged=1`);
  }

  return (
    <div className="grid gap-3">
      <FormError message={error} />
      <div>
        <ConfirmDialog
          destructive
          title="Merge these contacts?"
          description={`${mergeName} is deleted after everything above moves to the contact you keep. This cannot be undone.`}
          confirmLabel="Merge contacts"
          onConfirm={() => void merge()}
          trigger={<ClientButton variant="destructive">Merge contacts</ClientButton>}
        />
      </div>
    </div>
  );
}
