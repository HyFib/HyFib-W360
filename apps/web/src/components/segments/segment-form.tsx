'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import {
  archiveSegmentAction,
  createSegmentAction,
  updateSegmentAction,
} from '@/app/actions/campaigns';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';
import { SegmentBuilder, type BuilderField, type Definition } from './segment-builder';

export function SegmentForm({
  slug,
  fields,
  campaigns,
  existing,
}: {
  slug: string;
  fields: BuilderField[];
  campaigns: { id: string; name: string }[];
  existing?: { id: string; name: string; version: number; definition: Definition };
}) {
  const router = useRouter();
  const [name, setName] = useState(existing?.name ?? '');
  const [definition, setDefinition] = useState<Definition>(
    existing?.definition ?? { match: 'all', conditions: [{ type: 'tag', op: 'has', tag: '' }] },
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      if (existing) {
        const r = await updateSegmentAction(slug, existing.id, {
          name,
          definition,
          expectedVersion: existing.version,
        });
        if (!r.ok) setError(r.message);
        else {
          setSaved(true);
          router.refresh();
        }
      } else {
        const r = await createSegmentAction(slug, { name, definition });
        if (!r.ok) setError(r.message);
        else router.push(`/c/${slug}/contacts/segments/${r.data.id}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <ClientForm onSubmit={submit} className="grid gap-4">
        <FormError message={error} />
        <FormSuccess message={saved ? 'Segment saved.' : null} />
        <Field id="segment-name" label="Segment name">
          {(aria) => (
            <Input
              {...aria}
              value={name}
              required
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <SegmentBuilder
          slug={slug}
          value={definition}
          onChange={setDefinition}
          fields={fields}
          campaigns={campaigns}
        />
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save segment'}
          </Button>
        </div>
      </ClientForm>
      {existing ? (
        <ConfirmDialog
          destructive
          title="Archive this segment?"
          description="It disappears from lists. Campaigns that used it keep their audience snapshots."
          confirmLabel="Archive segment"
          onConfirm={() =>
            void archiveSegmentAction(slug, existing.id).then((r) => {
              if (!r.ok) setError(r.message);
              else router.push(`/c/${slug}/contacts/segments`);
            })
          }
          trigger={
            <ClientButton variant="outline" className="justify-self-start text-destructive">
              Archive
            </ClientButton>
          }
        />
      ) : null}
    </div>
  );
}
