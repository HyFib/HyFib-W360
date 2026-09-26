'use client';
import { useState } from 'react';
import { Button, Checkbox, Field, Input } from '@w360/ui';
import { updateResponseTargetAction } from '@/app/actions/inbox';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

/** The first-response target that reports compare reply times with. */
export function ResponseTargetForm({
  slug,
  initial,
  canEdit,
}: {
  slug: string;
  initial: number | null;
  canEdit: boolean;
}) {
  const [on, setOn] = useState(initial !== null);
  const [minutes, setMinutes] = useState(String(initial ?? 60));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(false);
        void updateResponseTargetAction(slug, { minutes: on ? Number(minutes) : null }).then(
          (r) => {
            setBusy(false);
            if (!r.ok) setError(r.message);
            else setSaved(true);
          },
        );
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved ? 'Response target saved.' : null} />
      <fieldset disabled={!canEdit} className="grid gap-4">
        <label htmlFor="rt-on" className="flex items-start gap-2 text-sm">
          <Checkbox id="rt-on" checked={on} onChange={(e) => setOn(e.target.checked)} />
          <span>
            Set a first-response target
            <span className="block text-muted-foreground">
              Reports show how many waiting customers got a first reply within it. Measured in
              absolute time; business hours are not supported yet.
            </span>
          </span>
        </label>
        {on ? (
          <Field
            id="rt-minutes"
            label="Target (minutes)"
            description="From the customer’s first waiting message to a member’s reply; 1 to 1440."
          >
            {(aria) => (
              <Input
                {...aria}
                type="number"
                inputMode="numeric"
                min={1}
                max={1440}
                required
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
              />
            )}
          </Field>
        ) : null}
        {canEdit ? (
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save response target'}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Only members who manage company settings can change this.
          </p>
        )}
      </fieldset>
    </ClientForm>
  );
}
