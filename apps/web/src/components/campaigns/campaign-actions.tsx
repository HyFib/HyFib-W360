'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, Select, Textarea } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import {
  campaignTransitionAction,
  createCampaignAction,
  sendCampaignTestAction,
  submitCampaignAction,
  updateGuardrailsAction,
} from '@/app/actions/campaigns';
import { ClientButton, ClientForm, useHydrated } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

export function CreateCampaignForm({ slug }: { slug: string }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void createCampaignAction(slug, { name }).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else router.push(`/c/${slug}/campaigns/${r.data.id}`);
        });
      }}
    >
      <FormError message={error} />
      <Field id="new-campaign-name" label="Campaign name" description="Only your team sees this.">
        {(aria) => (
          <Input
            {...aria}
            value={name}
            required
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create draft'}
        </Button>
      </div>
    </ClientForm>
  );
}

export function SubmitCampaign({
  slug,
  campaignId,
  version,
  approvalRequired,
  disabled,
  summary,
}: {
  slug: string;
  campaignId: string;
  version: number;
  approvalRequired: boolean;
  disabled: boolean;
  summary: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-2">
      <FormError message={error} />
      <ConfirmDialog
        title={approvalRequired ? 'Send this campaign for approval?' : 'Start this campaign?'}
        description={`${summary} The audience is frozen now; consent, suppression and the frequency cap are checked again before each message is sent.`}
        confirmLabel={approvalRequired ? 'Send for approval' : 'Start campaign'}
        onConfirm={() => {
          setBusy(true);
          setError(null);
          void submitCampaignAction(slug, campaignId, { expectedVersion: version }).then((r) => {
            setBusy(false);
            if (!r.ok) setError(r.message);
          });
        }}
        trigger={
          <ClientButton disabled={disabled || busy}>
            {busy ? 'Submitting…' : approvalRequired ? 'Send for approval' : 'Start campaign'}
          </ClientButton>
        }
      />
    </div>
  );
}

export function SendTest({ slug, campaignId }: { slug: string; campaignId: string }) {
  const [phones, setPhones] = useState('');
  const [results, setResults] = useState<{ phone: string; ok: boolean; message: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setResults([]);
        const list = phones
          .split(/[\n,;]+/)
          .map((p) => p.trim())
          .filter(Boolean);
        void sendCampaignTestAction(slug, campaignId, { phones: list }).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else setResults(r.data);
        });
      }}
    >
      <FormError message={error} />
      <Field
        id="test-phones"
        label="Send a test to"
        description="Up to five numbers of existing contacts, with country code. Their consent and the suppression list apply; tests are not counted in the results."
      >
        {(aria) => (
          <Textarea {...aria} rows={2} value={phones} onChange={(e) => setPhones(e.target.value)} />
        )}
      </Field>
      {results.length > 0 ? (
        <ul className="grid gap-1 text-sm" aria-live="polite">
          {results.map((r) => (
            <li key={r.phone} className={r.ok ? 'text-success' : 'text-destructive'}>
              {r.phone}: {r.message}
            </li>
          ))}
        </ul>
      ) : null}
      <div>
        <Button type="submit" variant="outline" disabled={busy || !phones.trim()}>
          {busy ? 'Sending…' : 'Send test'}
        </Button>
      </div>
    </ClientForm>
  );
}

export function ApprovalActions({
  slug,
  campaignId,
  canApprove,
  canWithdraw,
}: {
  slug: string;
  campaignId: string;
  canApprove: boolean;
  canWithdraw: boolean;
}) {
  // The note stays disabled until hydration: one typed before would never reach `note`, leaving
  // "Send back for changes" disabled (see useHydrated).
  const hydrated = useHydrated();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (transition: 'approve' | 'reject' | 'withdraw') => {
    setBusy(true);
    setError(null);
    void campaignTransitionAction(slug, campaignId, transition, note.trim() ? { note } : {}).then(
      (r) => {
        setBusy(false);
        if (!r.ok) setError(r.message);
      },
    );
  };
  return (
    <div className="grid gap-3">
      <FormError message={error} />
      {canApprove ? (
        <Field
          id="review-note"
          label="Note to the submitter"
          description="Required when sending it back."
        >
          {(aria) => (
            <Textarea
              {...aria}
              rows={2}
              maxLength={500}
              value={note}
              disabled={!hydrated}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </Field>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canApprove ? (
          <>
            <ClientButton disabled={busy} onClick={() => run('approve')}>
              Approve
            </ClientButton>
            <ClientButton
              variant="outline"
              disabled={busy || !note.trim()}
              onClick={() => run('reject')}
            >
              Send back for changes
            </ClientButton>
          </>
        ) : null}
        {canWithdraw ? (
          <ClientButton variant="outline" disabled={busy} onClick={() => run('withdraw')}>
            Withdraw
          </ClientButton>
        ) : null}
      </div>
    </div>
  );
}

export function RunControls({
  slug,
  campaignId,
  status,
}: {
  slug: string;
  campaignId: string;
  status: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (transition: 'pause' | 'resume' | 'cancel', done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    void campaignTransitionAction(slug, campaignId, transition).then((r) => {
      setBusy(false);
      if (!r.ok) setError(r.message);
      else setNotice(done);
    });
  };
  const active = ['scheduled', 'running', 'paused', 'pending_approval', 'draft'].includes(status);
  return (
    <div className="grid gap-2">
      <FormError message={error} />
      <FormSuccess message={notice} />
      <div className="flex flex-wrap gap-2">
        {status === 'scheduled' || status === 'running' ? (
          <ClientButton
            variant="outline"
            disabled={busy}
            onClick={() => run('pause', 'Campaign paused.')}
          >
            Pause
          </ClientButton>
        ) : null}
        {status === 'paused' ? (
          <ClientButton disabled={busy} onClick={() => run('resume', 'Campaign resumed.')}>
            Resume
          </ClientButton>
        ) : null}
        {active ? (
          <ConfirmDialog
            destructive
            title="Cancel this campaign?"
            description="Recipients not reached yet are not sent to. Messages already handed to WhatsApp cannot be recalled. This cannot be undone."
            confirmLabel="Cancel campaign"
            onConfirm={() => run('cancel', 'Campaign cancelled.')}
            trigger={
              <ClientButton variant="outline" className="text-destructive" disabled={busy}>
                Cancel campaign
              </ClientButton>
            }
          />
        ) : null}
      </div>
    </div>
  );
}

export function GuardrailsForm({
  slug,
  campaignId,
  initial,
  currencies,
}: {
  slug: string;
  campaignId: string;
  initial: {
    ratePerMinute: number | null;
    maxMessages: number | null;
    budgetAmount: string;
    budgetCurrency: string | null;
  };
  currencies: string[];
}) {
  const [values, setValues] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(false);
        void updateGuardrailsAction(slug, campaignId, {
          ratePerMinute: values.ratePerMinute,
          maxMessages: values.maxMessages,
          budget:
            values.budgetAmount && values.budgetCurrency
              ? { amount: values.budgetAmount, currency: values.budgetCurrency }
              : null,
        }).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else setSaved(true);
        });
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved ? 'Limits saved.' : null} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="g-rate" label="Messages per minute">
          {(aria) => (
            <Input
              {...aria}
              type="number"
              min={1}
              max={6000}
              value={values.ratePerMinute ?? ''}
              onChange={(e) =>
                setValues({
                  ...values,
                  ratePerMinute: e.target.value ? Number(e.target.value) : null,
                })
              }
            />
          )}
        </Field>
        <Field id="g-max" label="Message cap">
          {(aria) => (
            <Input
              {...aria}
              type="number"
              min={1}
              value={values.maxMessages ?? ''}
              onChange={(e) =>
                setValues({
                  ...values,
                  maxMessages: e.target.value ? Number(e.target.value) : null,
                })
              }
            />
          )}
        </Field>
        {currencies.length > 0 ? (
          <>
            <Field id="g-budget" label="Estimated spending cap">
              {(aria) => (
                <Input
                  {...aria}
                  inputMode="decimal"
                  value={values.budgetAmount}
                  onChange={(e) =>
                    setValues({
                      ...values,
                      budgetAmount: e.target.value,
                      budgetCurrency: values.budgetCurrency ?? currencies[0] ?? null,
                    })
                  }
                />
              )}
            </Field>
            <Field id="g-currency" label="Currency">
              {(aria) => (
                <Select
                  {...aria}
                  value={values.budgetCurrency ?? currencies[0]}
                  onChange={(e) => setValues({ ...values, budgetCurrency: e.target.value })}
                >
                  {currencies.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </>
        ) : null}
      </div>
      <div>
        <Button type="submit" variant="outline" disabled={busy}>
          {busy ? 'Saving…' : 'Save limits'}
        </Button>
      </div>
    </ClientForm>
  );
}

/** Re-renders the page every 15 seconds while the campaign is in progress. */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}
