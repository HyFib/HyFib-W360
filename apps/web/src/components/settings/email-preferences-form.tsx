'use client';
import { useId, useState } from 'react';
import { Button } from '@w360/ui';
import type { EmailPreference } from '@w360/domain';
import { updateEmailPreferencesAction } from '@/app/actions/tenancy';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

/** The member's own choice of notice emails (ADR-215): one box per kind, ticked when it is on. */
export function EmailPreferencesForm({
  slug,
  preferences,
}: {
  slug: string;
  preferences: EmailPreference[];
}) {
  const id = useId();
  const [on, setOn] = useState<Record<string, boolean>>(
    Object.fromEntries(preferences.map((p) => [p.kind, p.email])),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);
    const result = await updateEmailPreferencesAction(slug, {
      off: preferences.filter((p) => !on[p.kind]).map((p) => p.kind),
    });
    setBusy(false);
    if (!result.ok) setError(result.message);
    else setSaved('Email settings saved.');
  }

  return (
    <ClientForm onSubmit={save} className="grid gap-4">
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">Email me when</legend>
        {preferences.map((p) => (
          <div key={p.kind} className="flex items-start gap-3 text-sm">
            <input
              id={`${id}-${p.kind}`}
              type="checkbox"
              className="mt-1 h-4 w-4"
              aria-describedby={`${id}-${p.kind}-about`}
              checked={on[p.kind] ?? true}
              onChange={(event) =>
                setOn((current) => ({ ...current, [p.kind]: event.target.checked }))
              }
            />
            <span className="grid gap-0.5">
              <label htmlFor={`${id}-${p.kind}`} className="font-medium">
                {p.label}
              </label>
              <span id={`${id}-${p.kind}-about`} className="text-muted-foreground">
                {p.description}
              </span>
            </span>
          </div>
        ))}
      </fieldset>
      <FormError message={error} />
      <FormSuccess message={saved} />
      <Button type="submit" className="justify-self-start" disabled={busy}>
        Save email settings
      </Button>
    </ClientForm>
  );
}
