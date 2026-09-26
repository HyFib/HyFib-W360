'use client';
import { useState } from 'react';
import { Button, Field, Select, Textarea } from '@w360/ui';
import { recordConsentAction } from '@/app/actions/contacts';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

/** Records consent the customer gave a member directly (phone, in person, email), with a note. */
export function ConsentForm({ slug, contactId }: { slug: string; contactId: string }) {
  const [purpose, setPurpose] = useState<'marketing' | 'utility'>('marketing');
  const [action, setAction] = useState<'opt_in' | 'opt_out'>('opt_in');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const result = await recordConsentAction(slug, { contactId, purpose, action, note });
    setBusy(false);
    if (!result.ok) setError(result.message);
    else {
      setSaved(true);
      setNote('');
    }
  }

  return (
    <ClientForm onSubmit={submit} className="grid gap-3">
      <FormError message={error} />
      <FormSuccess message={saved ? 'Consent recorded.' : null} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="consent-purpose" label="Messages">
          {(aria) => (
            <Select
              {...aria}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value as 'marketing' | 'utility')}
            >
              <option value="marketing">Marketing</option>
              <option value="utility">Utility (updates and alerts)</option>
            </Select>
          )}
        </Field>
        <Field id="consent-action" label="Customer said">
          {(aria) => (
            <Select
              {...aria}
              value={action}
              onChange={(e) => setAction(e.target.value as 'opt_in' | 'opt_out')}
            >
              <option value="opt_in">Yes, send these (opt in)</option>
              <option value="opt_out">Stop sending these (opt out)</option>
            </Select>
          )}
        </Field>
      </div>
      <Field
        id="consent-note"
        label="How and when did they tell you?"
        description="Kept with the consent history as evidence."
      >
        {(aria) => (
          <Textarea
            {...aria}
            value={note}
            maxLength={500}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
          />
        )}
      </Field>
      <div>
        <Button type="submit" variant="outline" disabled={busy}>
          {busy ? 'Recording…' : 'Record consent'}
        </Button>
      </div>
    </ClientForm>
  );
}
