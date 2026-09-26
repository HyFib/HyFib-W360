'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, Textarea } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import {
  createRateCardAction,
  publishRateCardAction,
  withdrawRateCardAction,
} from '@/app/actions/platform';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError } from '@/components/form-status';

const EXAMPLE =
  'market,calling_codes,marketing,utility,authentication,authentication_international,service';

export function CreateRateCardForm() {
  const router = useRouter();
  const [values, setValues] = useState({
    currency: 'INR',
    effectiveFrom: '',
    sourceUrl: '',
    notes: '',
    csv: `${EXAMPLE}\n`,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof values>) => setValues((v) => ({ ...v, ...patch }));
  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void createRateCardAction(values).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else router.push(`/platform/rate-cards/${r.data.id}`);
        });
      }}
    >
      <FormError message={error} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="rc-currency" label="Currency">
          {(aria) => (
            <Input
              {...aria}
              value={values.currency}
              maxLength={3}
              onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
            />
          )}
        </Field>
        <Field id="rc-effective" label="Applies from (UTC)">
          {(aria) => (
            <Input
              {...aria}
              type="datetime-local"
              value={values.effectiveFrom}
              onChange={(e) => set({ effectiveFrom: e.target.value })}
            />
          )}
        </Field>
        <Field id="rc-source" label="Meta’s published rate card (link)">
          {(aria) => (
            <Input
              {...aria}
              type="url"
              value={values.sourceUrl}
              onChange={(e) => set({ sourceUrl: e.target.value })}
            />
          )}
        </Field>
      </div>
      <Field
        id="rc-csv"
        label="Rates"
        description="One market per row. Calling codes separated by spaces or semicolons; prices per message in the card’s currency (up to six decimals); an empty cell means no price."
      >
        {(aria) => (
          <Textarea
            {...aria}
            rows={10}
            className="font-mono text-xs"
            value={values.csv}
            onChange={(e) => set({ csv: e.target.value })}
          />
        )}
      </Field>
      <Field id="rc-notes" label="Notes (optional)">
        {(aria) => (
          <Input
            {...aria}
            value={values.notes}
            maxLength={1000}
            onChange={(e) => set({ notes: e.target.value })}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save draft rate card'}
        </Button>
      </div>
    </ClientForm>
  );
}

export function RateCardActions({ id, status }: { id: string; status: string }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-3">
      <FormError message={error} />
      {status === 'draft' ? (
        <ConfirmDialog
          title="Publish this rate card?"
          description="Companies' cost estimates and spending caps start using it from its effective date. Published cards cannot be edited; a mistake is corrected by withdrawing the card and publishing a new one."
          confirmLabel="Publish"
          onConfirm={() =>
            void publishRateCardAction(id).then((r) => {
              if (!r.ok) setError(r.message);
            })
          }
          trigger={<ClientButton>Publish</ClientButton>}
        />
      ) : null}
      {status !== 'withdrawn' ? (
        <div className="grid gap-2">
          <Field id="rc-reason" label="Reason for withdrawing">
            {(aria) => (
              <Input
                {...aria}
                value={reason}
                maxLength={2000}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </Field>
          <ConfirmDialog
            destructive
            title="Withdraw this rate card?"
            description="Estimates stop using it. It stays listed so earlier estimates remain explainable."
            confirmLabel="Withdraw"
            onConfirm={() =>
              void withdrawRateCardAction(id, { reason }).then((r) => {
                if (!r.ok) setError(r.message);
              })
            }
            trigger={
              <ClientButton
                variant="outline"
                className="justify-self-start text-destructive"
                disabled={reason.trim().length < 10}
              >
                Withdraw
              </ClientButton>
            }
          />
        </div>
      ) : null}
    </div>
  );
}
