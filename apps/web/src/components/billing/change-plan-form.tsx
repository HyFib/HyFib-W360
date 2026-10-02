'use client';
import { useState } from 'react';
import type { PlanAddOnKind, PlanAddOnOption, PlanPrices } from '@w360/domain';
import { displayMoney } from '@w360/core/money';
import {
  PLAN_ADD_ON_LABELS,
  PLAN_INTERVAL_LABELS,
  planPaymentQuote,
} from '@w360/domain/plan-model';
import { Field, Input } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import { confirmPlanSubscriptionAction, schedulePlanChangeAction } from '@/app/actions/billing';
import { ActionFailure, type ActionFailureState } from '@/components/action-failure';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormSuccess } from '@/components/form-status';
import { CheckoutClosedError, openSubscriptionCheckout } from './razorpay-checkout';

// The server's own formatting, so the page reads the same in every browser (no Intl).
const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');
const counted = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

/** The form field each add-on is sent as. */
const FIELD: Record<PlanAddOnKind, 'extraSeats' | 'extraNumbers' | 'runPacks' | 'apiRequestPacks'> =
  {
    seats: 'extraSeats',
    numbers: 'extraNumbers',
    runPacks: 'runPacks',
    apiRequestPacks: 'apiRequestPacks',
  };

/** A quantity as typed: digits only, empty for none; null for anything else. */
function quantityOf(text: string): number | null {
  const t = text.trim();
  if (t === '') return 0;
  return /^\d{1,6}$/.test(t) ? Number(t) : null;
}

/** What an add-on costs on the plan and the bounds the company has, under its field. */
function addOnHint(option: PlanAddOnOption, planName: string, interval: string): string {
  const price = `${inr(option.unitPriceMinor)} each ${interval}`;
  const least =
    option.min > 0 ? `, and at least ${option.min.toLocaleString('en-IN')} for what it uses` : '';
  const most = `Up to ${option.max.toLocaleString('en-IN')}${least}.`;
  switch (option.kind) {
    case 'seats':
      return `${price}. ${planName} includes ${counted(option.included, 'seat', 'seats')}, and your company uses ${(option.used ?? 0).toLocaleString('en-IN')} (members and invitations still waiting). ${most}`;
    case 'numbers':
      return `${price}. ${planName} includes ${counted(option.included, 'WhatsApp number', 'WhatsApp numbers')}, and your company uses ${(option.used ?? 0).toLocaleString('en-IN')}. ${most}`;
    case 'runPacks':
      return `${counted(option.unitSize, 'automation run', 'automation runs')} a month in each pack, ${price}, on top of the ${option.included.toLocaleString('en-IN')} ${planName} includes. ${most}`;
    case 'apiRequestPacks':
      return `${counted(option.unitSize, 'public API request', 'public API requests')} a month in each pack, ${price}, on top of the ${option.included.toLocaleString('en-IN')} ${planName} includes. ${most}`;
  }
}

/**
 * Changing the plan the company pays for from the end of the paid period (ADR-109): the add-ons of
 * the plan chosen, with what it would cost each interval as they change. Confirming ends the current
 * subscription with the period, then Razorpay's payment window authorises the new one, which is
 * first charged when the period ends.
 */
export function ChangePlanForm({
  slug,
  planId,
  planName,
  prices,
  intervalMonths,
  taxBp,
  options,
  periodEnd,
  currentEnds,
}: {
  slug: string;
  planId: string;
  planName: string;
  prices: PlanPrices;
  intervalMonths: number;
  taxBp: number;
  /** The add-ons the plan sells, with the quantities the form starts from. */
  options: PlanAddOnOption[];
  /** The end of the paid period, formatted in the company's time zone. */
  periodEnd: string;
  /** The current subscription already ends with the period. */
  currentEnds: boolean;
}) {
  const interval = PLAN_INTERVAL_LABELS[intervalMonths] ?? '';
  const [values, setValues] = useState<Record<PlanAddOnKind, string>>(() => ({
    seats: String(options.find((o) => o.kind === 'seats')?.quantity ?? 0),
    numbers: String(options.find((o) => o.kind === 'numbers')?.quantity ?? 0),
    runPacks: String(options.find((o) => o.kind === 'runPacks')?.quantity ?? 0),
    apiRequestPacks: String(options.find((o) => o.kind === 'apiRequestPacks')?.quantity ?? 0),
  }));
  const [error, setError] = useState<ActionFailureState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const extraSeats = quantityOf(values.seats);
  const extraNumbers = quantityOf(values.numbers);
  const runPacks = quantityOf(values.runPacks);
  const apiRequestPacks = quantityOf(values.apiRequestPacks);
  const quote =
    extraSeats === null || extraNumbers === null || runPacks === null || apiRequestPacks === null
      ? null
      : planPaymentQuote(prices, { extraSeats, extraNumbers, runPacks, apiRequestPacks }, taxBp);
  const total = quote?.ok ? inr(quote.quote.totalMinor) : null;

  async function change() {
    setBusy(true);
    setError(null);
    setNotice(null);
    setFieldErrors({});
    try {
      const started = await schedulePlanChangeAction(slug, {
        planId,
        extraSeats: values.seats,
        extraNumbers: values.numbers,
        runPacks: values.runPacks,
        apiRequestPacks: values.apiRequestPacks,
      });
      if (!started.ok) {
        setError(started);
        setFieldErrors(Object.fromEntries((started.issues ?? []).map((i) => [i.path, i.message])));
        return;
      }
      const checkout = started.data;
      let response;
      try {
        response = await openSubscriptionCheckout({
          keyId: checkout.keyId,
          subscriptionId: checkout.providerSubscriptionId,
          companyName: checkout.companyName,
          description: `${checkout.planName} plan`,
          prefill: checkout.prefill,
          onAttemptFailed: (message) =>
            setError({
              code: 'provider_unavailable',
              message: `${message} You can try again in the payment window.`,
            }),
        });
      } catch (checkoutError) {
        if (checkoutError instanceof CheckoutClosedError) {
          setNotice(
            `Payment window closed before the new plan was authorised. Your current subscription ends on ${periodEnd}: authorise the new plan within the hour from Billing, or change again, to keep your plan going.`,
          );
          return;
        }
        throw checkoutError;
      }
      setError(null);
      const confirmed = await confirmPlanSubscriptionAction(slug, {
        subscriptionId: checkout.subscriptionId,
        paymentId: response.razorpay_payment_id,
        signature: response.razorpay_signature,
      });
      if (!confirmed.ok) {
        setError(confirmed);
        return;
      }
      if (confirmed.data.status === 'scheduled') {
        setNotice(
          `Change scheduled. From ${periodEnd} your plan is ${planName}, and Razorpay charges ${inr(checkout.amountMinor)} for it then.`,
        );
      } else if (confirmed.data.status === 'processing') {
        setNotice(
          'Payment method authorised and being confirmed. Billing shows the change once Razorpay confirms it.',
        );
      } else {
        setError({
          code: 'precondition_failed',
          message: `The new plan was not authorised. Your current subscription ends on ${periodEnd}.`,
        });
      }
    } catch (unexpected) {
      setError({
        code: 'internal',
        message:
          unexpected instanceof Error ? unexpected.message : 'The change could not be started.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <ClientForm onSubmit={(event) => event.preventDefault()} className="grid gap-4 sm:max-w-xl">
      <ActionFailure failure={error} />
      <FormSuccess message={notice} />
      {options.map((option) => (
        <Field
          key={option.kind}
          id={`change-add-on-${option.kind}`}
          label={PLAN_ADD_ON_LABELS[option.kind]}
          description={addOnHint(option, planName, interval)}
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
            ? `From ${periodEnd} you would pay ${inr(quote.quote.totalMinor)} ${interval} for ${planName}, with ${taxBp / 100}% tax.`
            : `With these add-ons ${planName} costs more than can be paid here.`}
      </p>
      <p className="text-sm text-muted-foreground">
        {currentEnds
          ? `Your current subscription ends on ${periodEnd}. `
          : `Your current subscription is cancelled at the end of the paid period, on ${periodEnd}; Razorpay cannot restart it. `}
        Then you authorise the new one in Razorpay’s payment window (any amount taken for the check
        is refunded); nothing is charged for it before {periodEnd}.
      </p>
      <div>
        <ConfirmDialog
          trigger={
            <ClientButton type="button" disabled={busy || !quote?.ok}>
              {busy ? 'Opening payment…' : `Change from ${periodEnd}`}
            </ClientButton>
          }
          title={`Change to ${planName} from ${periodEnd}?`}
          description={`${
            currentEnds
              ? `Your current subscription ends on ${periodEnd}.`
              : `Your current subscription will be cancelled at the end of the paid period, on ${periodEnd}, and cannot be restarted.`
          } You then authorise the new subscription in Razorpay’s payment window; Razorpay charges ${total ?? 'its price'} on ${periodEnd} and ${interval} after that. If you do not authorise it, your plan ends on ${periodEnd}.`}
          confirmLabel={`Change from ${periodEnd}`}
          cancelLabel="Keep my plan"
          onConfirm={() => void change()}
        />
      </div>
    </ClientForm>
  );
}
