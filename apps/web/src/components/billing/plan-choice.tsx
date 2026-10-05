'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@w360/ui/client';
import { choosePlanAction } from '@/app/actions/billing';
import { ClientButton } from '@/components/client-form';
import { FormError } from '@/components/form-status';

/** Puts the company on an offered plan, then shows Billing, where it pays for it (ADR-105). */
export function ChoosePlanButton({
  slug,
  planId,
  planName,
  consequence,
}: {
  slug: string;
  planId: string;
  planName: string;
  /** What choosing changes for the company now, shown before it confirms. */
  consequence: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-2">
      <FormError message={error} />
      <ConfirmDialog
        title={`Choose ${planName}?`}
        description={consequence}
        confirmLabel={`Choose ${planName}`}
        onConfirm={() =>
          void choosePlanAction(slug, { planId }).then((r) => {
            if (!r.ok) setError(r.message);
            else router.push(`/c/${slug}/billing`);
          })
        }
        trigger={<ClientButton className="justify-self-start">Choose {planName}</ClientButton>}
      />
    </div>
  );
}
