'use client';
import { useState } from 'react';
import { Button, Field, Select } from '@w360/ui';
import { USAGE_WARNING_PERCENTS } from '@w360/domain/plan-model';
import { setUsageWarningAction } from '@/app/actions/billing';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

/**
 * Chooses the share of a monthly limit at which the billing managers are emailed and members who
 * read billing see a notice (ADR-144).
 */
export function UsageWarningForm({ slug, percent }: { slug: string; percent: number }) {
  const [chosen, setChosen] = useState(String(percent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);
    const result = await setUsageWarningAction(slug, Number(chosen));
    setBusy(false);
    if (!result.ok) setError(result.message);
    else setSaved(`Saved: warned at ${result.data.percent}% of a monthly limit.`);
  }

  return (
    <ClientForm onSubmit={submit} className="grid gap-3 sm:max-w-sm">
      <FormError message={error} />
      <FormSuccess message={saved} />
      <Field id="usage-warning-percent" label="Warn at">
        {(aria) => (
          <Select
            {...aria}
            value={chosen}
            onChange={(e) => {
              setSaved(null);
              setChosen(e.target.value);
            }}
          >
            {USAGE_WARNING_PERCENTS.map((p) => (
              <option key={p} value={String(p)}>
                {p}% of a monthly limit
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save usage warning'}
        </Button>
      </div>
    </ClientForm>
  );
}
