'use client';
import { useState } from 'react';
import { Button, Field, Input } from '@w360/ui';
import { updateAutoRechargeAction } from '@/app/actions/billing';
import { ActionFailure, type ActionFailureState } from '@/components/action-failure';
import { ClientForm } from '@/components/client-form';
import { FormSuccess } from '@/components/form-status';

const rupees = (paise: number) => (paise / 100).toFixed(paise % 100 === 0 ? 0 : 2);

export interface AutoRechargeValues {
  enabled: boolean;
  thresholdMinor: number;
  amountMinor: number;
  dailyCapMinor: number;
  monthlyCapMinor: number;
}

/**
 * Auto-recharge settings. Charges are requested when credit falls below the threshold and take one
 * to three days to complete (card mandate rules), so the threshold should leave headroom.
 */
export function AutoRechargeForm({
  slug,
  initial,
  canEnable,
}: {
  slug: string;
  initial: AutoRechargeValues;
  canEnable: boolean;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [threshold, setThreshold] = useState(rupees(initial.thresholdMinor));
  const [amount, setAmount] = useState(rupees(initial.amountMinor));
  const [dailyCap, setDailyCap] = useState(rupees(initial.dailyCapMinor));
  const [monthlyCap, setMonthlyCap] = useState(rupees(initial.monthlyCapMinor));
  const [error, setError] = useState<ActionFailureState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setFieldErrors({});
    const result = await updateAutoRechargeAction(slug, {
      enabled,
      threshold,
      amount,
      dailyCap,
      monthlyCap,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result);
      setFieldErrors(Object.fromEntries((result.issues ?? []).map((i) => [i.path, i.message])));
      return;
    }
    setNotice(result.data.enabled ? 'Auto-recharge is on.' : 'Auto-recharge is off.');
  }

  const money = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    field: string,
    description?: string,
  ) => (
    <Field id={id} label={label} description={description} error={fieldErrors[field]}>
      {(aria) => (
        <Input
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(e) => set(e.target.value)}
          {...aria}
        />
      )}
    </Field>
  );

  return (
    <ClientForm onSubmit={submit} className="grid gap-3 sm:max-w-md">
      <ActionFailure failure={error} />
      <FormSuccess message={notice} />
      <div className="flex items-start gap-3 text-sm">
        <input
          id="ar-enabled"
          type="checkbox"
          className="mt-0.5 size-4"
          aria-describedby="ar-enabled-hint"
          checked={enabled}
          disabled={!canEnable && !enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <div>
          <label htmlFor="ar-enabled" className="font-medium">
            Recharge automatically
          </label>
          <p id="ar-enabled-hint" className="text-muted-foreground">
            {canEnable
              ? 'Charge the saved card when credit falls below the threshold.'
              : 'Set up a card first.'}
          </p>
        </div>
      </div>
      {money(
        'ar-threshold',
        'When credit falls below (₹)',
        threshold,
        setThreshold,
        'threshold',
        'A card charge takes one to three days to complete, so leave headroom.',
      )}
      {money(
        'ar-amount',
        'Add this much (₹)',
        amount,
        setAmount,
        'amount',
        '₹100 to ₹15,000, and at most your card limit.',
      )}
      {money('ar-daily', 'At most per day (₹)', dailyCap, setDailyCap, 'dailyCap')}
      {money(
        'ar-monthly',
        'At most per 30 days (₹)',
        monthlyCap,
        setMonthlyCap,
        'monthlyCap',
        'Limits include charges still being processed.',
      )}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save auto-recharge'}
        </Button>
      </div>
    </ClientForm>
  );
}
