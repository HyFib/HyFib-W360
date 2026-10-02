'use client';
import { useState } from 'react';
import type { PlanAddOnKind, PlanAddOnOption } from '@w360/domain';
import { displayMoney } from '@w360/core/money';
import {
  PLAN_ADD_ON_LABELS,
  PLAN_INTERVAL_LABELS,
  planPaymentQuote,
} from '@w360/domain/plan-model';
import { Button, Field, Input } from '@w360/ui';
import { chooseAddOnsAction } from '@/app/actions/billing';
import { ActionFailure, type ActionFailureState } from '@/components/action-failure';
import { ClientForm } from '@/components/client-form';
import { FormSuccess } from '@/components/form-status';

// The server's own formatting, so the page reads the same in every browser (no Intl).
const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');
const counted = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

/** The form field each add-on is sent as. */
const FIELD: Record<PlanAddOnKind, 'extraSeats' | 'extraNumbers' | 'runPacks'> = {
  seats: 'extraSeats',
  numbers: 'extraNumbers',
  runPacks: 'runPacks',
};

/** A quantity as typed: digits only, empty for none; null for anything else. */
function quantityOf(text: string): number | null {
  const t = text.trim();
  if (t === '') return 0;
  return /^\d{1,6}$/.test(t) ? Number(t) : null;
}

/** What an add-on costs and the bounds the company has, under its field. */
function addOnHint(option: PlanAddOnOption, interval: string): string {
  const price = `${inr(option.unitPriceMinor)} each ${interval}`;
  const least =
    option.min > 0 ? `, and at least ${option.min.toLocaleString('en-IN')} for what it uses` : '';
  const most = `Up to ${option.max.toLocaleString('en-IN')}${least}.`;
  switch (option.kind) {
    case 'seats':
      return `${price}. Your plan includes ${counted(option.included, 'seat', 'seats')}, and your company uses ${(option.used ?? 0).toLocaleString('en-IN')} (members and invitations still waiting). ${most}`;
    case 'numbers':
      return `${price}. Your plan includes ${counted(option.included, 'WhatsApp number', 'WhatsApp numbers')}, and your company uses ${(option.used ?? 0).toLocaleString('en-IN')}. ${most}`;
    case 'runPacks':
      return `${counted(option.unitSize, 'automation run', 'automation runs')} a month in each pack, ${price}, on top of the ${option.included.toLocaleString('en-IN')} your plan includes. ${most}`;
  }
}

/**
 * The company's add-ons on its plan version (ADR-106), with what it would pay each interval as the
 * quantities change. Saving changes the limits at once; the company pays for them with its plan.
 */
export function AddOnsForm({
  slug,
  prices,
  intervalMonths,
  taxBp,
  options,
  consequence,
}: {
  slug: string;
  prices: {
    priceMinor: number;
    seatPriceMinor: number | null;
    numberPriceMinor: number | null;
    runPackPriceMinor: number | null;
  };
  intervalMonths: number;
  taxBp: number;
  /** The add-ons the version sells. */
  options: PlanAddOnOption[];
  /** What saving changes for the company now. */
  consequence: string;
}) {
  const interval = PLAN_INTERVAL_LABELS[intervalMonths] ?? '';
  const [values, setValues] = useState<Record<PlanAddOnKind, string>>(() => ({
    seats: String(options.find((o) => o.kind === 'seats')?.quantity ?? 0),
    numbers: String(options.find((o) => o.kind === 'numbers')?.quantity ?? 0),
    runPacks: String(options.find((o) => o.kind === 'runPacks')?.quantity ?? 0),
  }));
  const [error, setError] = useState<ActionFailureState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const extraSeats = quantityOf(values.seats);
  const extraNumbers = quantityOf(values.numbers);
  const runPacks = quantityOf(values.runPacks);
  const quote =
    extraSeats === null || extraNumbers === null || runPacks === null
      ? null
      : planPaymentQuote(prices, { extraSeats, extraNumbers, runPacks }, taxBp);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setFieldErrors({});
    const result = await chooseAddOnsAction(slug, {
      extraSeats: values.seats,
      extraNumbers: values.numbers,
      runPacks: values.runPacks,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result);
      setFieldErrors(Object.fromEntries((result.issues ?? []).map((i) => [i.path, i.message])));
      return;
    }
    setNotice(
      result.data.changed
        ? `Your add-ons are saved.${result.data.totalMinor === null ? '' : ` You would pay ${inr(result.data.totalMinor)} ${interval} for your plan.`}`
        : 'Your add-ons were already these.',
    );
  }

  return (
    <ClientForm onSubmit={submit} className="grid gap-4 sm:max-w-xl">
      <ActionFailure failure={error} />
      <FormSuccess message={notice} />
      {options.map((option) => (
        <Field
          key={option.kind}
          id={`add-on-${option.kind}`}
          label={PLAN_ADD_ON_LABELS[option.kind]}
          description={addOnHint(option, interval)}
          error={fieldErrors[FIELD[option.kind]]}
        >
          {(aria) => (
            <Input
              inputMode="numeric"
              autoComplete="off"
              className="max-w-32"
              value={values[option.kind]}
              onChange={(e) => setValues((v) => ({ ...v, [option.kind]: e.target.value }))}
              {...aria}
            />
          )}
        </Field>
      ))}
      <p className="text-sm" aria-live="polite">
        {quote === null
          ? 'Enter whole numbers.'
          : quote.ok
            ? `With these add-ons you would pay ${inr(quote.quote.totalMinor)} ${interval} for your plan, with ${taxBp / 100}% tax.`
            : 'With these add-ons your plan costs more than can be paid here.'}
      </p>
      <p className="text-sm text-muted-foreground">{consequence}</p>
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save add-ons'}
        </Button>
      </div>
    </ClientForm>
  );
}
