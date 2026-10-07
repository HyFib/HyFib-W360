'use client';
import { useState, useTransition } from 'react';
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
import {
  SegmentBuilder,
  type BuilderField,
  type BuilderStore,
  type Definition,
} from './segment-builder';

export function SegmentForm({
  slug,
  fields,
  campaigns,
  stores,
  orderCurrencies,
  existing,
}: {
  slug: string;
  fields: BuilderField[];
  campaigns: { id: string; name: string }[];
  stores: BuilderStore[];
  orderCurrencies: string[];
  existing?: { id: string; name: string; version: number; definition: Definition };
}) {
  const router = useRouter();
  const [name, setName] = useState(existing?.name ?? '');
  const [definition, setDefinition] = useState<Definition>(
    existing?.definition ?? { match: 'all', conditions: [{ type: 'tag', op: 'has', tag: '' }] },
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    // The actions refresh the page on the server; the result is set inside the transition so it
    // appears together with that render.
    startTransition(async () => {
      try {
        if (existing) {
          const r = await updateSegmentAction(slug, existing.id, {
            name,
            definition,
            expectedVersion: existing.version,
          });
          startTransition(() => {
            if (!r.ok) setError(r.message);
            else setSaved(true);
          });
        } else {
          const r = await createSegmentAction(slug, { name, definition });
          if (!r.ok) startTransition(() => setError(r.message));
          else router.push(`/c/${slug}/contacts/segments/${r.data.id}`);
        }
      } catch {
        startTransition(() =>
          setError('The segment could not be saved because the connection failed. Try again.'),
        );
      }
    });
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
          stores={stores}
          orderCurrencies={orderCurrencies}
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
