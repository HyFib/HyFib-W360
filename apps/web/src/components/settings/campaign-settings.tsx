'use client';
import { useState } from 'react';
import { Button, Checkbox, Field, Input, Select } from '@w360/ui';
import { updateCampaignSettingsAction } from '@/app/actions/campaigns';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

export function CampaignSettingsForm({
  slug,
  initial,
  currencies,
  canEdit,
}: {
  slug: string;
  initial: {
    approvalRequired: boolean;
    capCount: number | null;
    capDays: number | null;
    costCurrency: string | null;
  };
  currencies: string[];
  canEdit: boolean;
}) {
  const [approval, setApproval] = useState(initial.approvalRequired);
  const [capOn, setCapOn] = useState(initial.capCount !== null);
  const [capCount, setCapCount] = useState(initial.capCount ?? 1);
  const [capDays, setCapDays] = useState(initial.capDays ?? 7);
  const [currency, setCurrency] = useState(initial.costCurrency ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const options =
    currency && !currencies.includes(currency) ? [currency, ...currencies] : currencies;
  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(false);
        void updateCampaignSettingsAction(slug, {
          approvalRequired: approval,
          cap: capOn ? { count: capCount, days: capDays } : null,
          costCurrency: currency || null,
        }).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else setSaved(true);
        });
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved ? 'Campaign settings saved.' : null} />
      <fieldset disabled={!canEdit} className="grid gap-4">
        <label htmlFor="cs-approval" className="flex items-start gap-2 text-sm">
          <Checkbox
            id="cs-approval"
            checked={approval}
            onChange={(e) => setApproval(e.target.checked)}
          />
          <span>
            Campaigns need approval by a second member
            <span className="block text-muted-foreground">
              A member with approval rights, other than the one who submitted it, must approve each
              campaign before it starts.
            </span>
          </span>
        </label>
        <label htmlFor="cs-cap" className="flex items-start gap-2 text-sm">
          <Checkbox id="cs-cap" checked={capOn} onChange={(e) => setCapOn(e.target.checked)} />
          <span>
            Limit how many marketing messages a contact receives
            <span className="block text-muted-foreground">
              Campaigns skip contacts who already received this many marketing templates (from
              campaigns or the inbox) in the period. Meta applies its own per-person limit too.
            </span>
          </span>
        </label>
        {capOn ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="cs-cap-count" label="At most">
              {(aria) => (
                <Input
                  {...aria}
                  type="number"
                  min={1}
                  max={50}
                  value={capCount}
                  onChange={(e) => setCapCount(Number(e.target.value) || 1)}
                />
              )}
            </Field>
            <Field id="cs-cap-days" label="Marketing messages per (days)">
              {(aria) => (
                <Input
                  {...aria}
                  type="number"
                  min={1}
                  max={30}
                  value={capDays}
                  onChange={(e) => setCapDays(Number(e.target.value) || 1)}
                />
              )}
            </Field>
          </div>
        ) : null}
        <Field
          id="cs-currency"
          label="Currency Meta bills you in"
          description={
            currencies.length === 0
              ? 'No rate card is published yet, so cost estimates are not available.'
              : 'Used for cost estimates from the published Meta rate cards.'
          }
        >
          {(aria) => (
            <Select {...aria} value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option value="">No estimates</option>
              {options.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {canEdit ? (
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save campaign settings'}
            </Button>
          </div>
        ) : null}
      </fieldset>
    </ClientForm>
  );
}
