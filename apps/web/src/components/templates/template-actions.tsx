'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@w360/ui/client';
import {
  deleteTemplateAction,
  submitTemplateAction,
  syncTemplatesAction,
} from '@/app/actions/templates';
import { ClientButton } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

export function SubmitTemplate({ slug, templateId }: { slug: string; templateId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-2">
      <FormError message={error} />
      <ConfirmDialog
        title="Submit this template to Meta?"
        description="Meta reviews it before it can be sent. The status updates here automatically; drafts can no longer be edited once Meta has them."
        confirmLabel="Submit for review"
        onConfirm={() => {
          setBusy(true);
          setError(null);
          void submitTemplateAction(slug, templateId).then((r) => {
            setBusy(false);
            if (!r.ok) setError(r.message);
          });
        }}
        trigger={
          <ClientButton disabled={busy}>{busy ? 'Submitting…' : 'Submit to Meta'}</ClientButton>
        }
      />
    </div>
  );
}

export function DeleteTemplate({
  slug,
  templateId,
  atMeta,
}: {
  slug: string;
  templateId: string;
  atMeta: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-2">
      <FormError message={error} />
      <ConfirmDialog
        destructive
        title="Delete this template?"
        description={
          atMeta
            ? 'It is deleted from your WhatsApp account at Meta and can no longer be sent. Messages already sent are not affected.'
            : 'The draft is deleted.'
        }
        confirmLabel="Delete template"
        onConfirm={() =>
          void deleteTemplateAction(slug, templateId).then((r) => {
            if (!r.ok) setError(r.message);
            else router.push(`/c/${slug}/templates`);
          })
        }
        trigger={
          <ClientButton variant="outline" className="text-destructive">
            Delete
          </ClientButton>
        }
      />
    </div>
  );
}

export function SyncTemplates({
  slug,
  whatsappAccountId,
}: {
  slug: string;
  whatsappAccountId: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-2">
      <ClientButton
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          setNotice(null);
          void syncTemplatesAction(slug, whatsappAccountId).then((r) => {
            setBusy(false);
            if (!r.ok) setError(r.message);
            else setNotice('Refresh requested. Statuses update within a minute.');
          });
        }}
      >
        {busy ? 'Requesting…' : 'Refresh from Meta'}
      </ClientButton>
      <FormError message={error} />
      <FormSuccess message={notice} />
    </div>
  );
}
