'use client';
import { useId, useState } from 'react';
import { Button } from '@w360/ui';
import { updateReportEmailsAction } from '@/app/actions/reports';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

const CHOICES = [
  {
    frequency: 'weekly',
    label: 'Every week',
    description: 'On Mondays at 07:00, for Monday to Sunday of the week before.',
  },
  {
    frequency: 'monthly',
    label: 'Every month',
    description: 'On the 1st at 07:00, for the month before.',
  },
] as const;

/**
 * The member's own report emails (ADR-376): a box for the weekly and one for the monthly email,
 * ticked when it is on. Other members' emails are theirs to choose.
 */
export function ReportEmailsForm({
  slug,
  timezone,
  weekly,
  monthly,
}: {
  slug: string;
  timezone: string;
  weekly: boolean;
  monthly: boolean;
}) {
  const id = useId();
  const [on, setOn] = useState({ weekly, monthly });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);
    const result = await updateReportEmailsAction(slug, on);
    setBusy(false);
    if (!result.ok) setError(result.message);
    else setSaved('Report emails saved.');
  }

  return (
    <ClientForm onSubmit={save} className="grid gap-4">
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">
          Email me the report totals (times in {timezone})
        </legend>
        {CHOICES.map((c) => (
          <div key={c.frequency} className="flex items-start gap-3 text-sm">
            <input
              id={`${id}-${c.frequency}`}
              type="checkbox"
              className="mt-1 h-4 w-4"
              aria-describedby={`${id}-${c.frequency}-about`}
              checked={on[c.frequency]}
              onChange={(event) =>
                setOn((current) => ({ ...current, [c.frequency]: event.target.checked }))
              }
            />
            <span className="grid gap-0.5">
              <label htmlFor={`${id}-${c.frequency}`} className="font-medium">
                {c.label}
              </label>
              <span id={`${id}-${c.frequency}-about`} className="text-muted-foreground">
                {c.description}
              </span>
            </span>
          </div>
        ))}
      </fieldset>
      <FormError message={error} />
      <FormSuccess message={saved} />
      <Button type="submit" variant="outline" className="justify-self-start" disabled={busy}>
        Save report emails
      </Button>
    </ClientForm>
  );
}
