'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Checkbox, Field, Input, Label, Select, Textarea } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import { PLAN_MODULE_KEYS, PLAN_MODULE_LABELS, addOnsForPlan } from '@w360/domain/plan-model';
import {
  createPlanAction,
  createPlanVersionAction,
  publishPlanAction,
  retirePlanAction,
  setDefaultTrialAction,
  setTenantPlanAction,
  updatePlanDraftAction,
} from '@/app/actions/platform';
import { ClientButton, ClientForm, useHydrated } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

/** A plan version's terms as form text (money in rupees; empty means none or no limit). */
export interface PlanFormValues {
  code: string;
  name: string;
  description: string;
  price: string;
  intervalMonths: string;
  trialDays: string;
  graceDays: string;
  seatsIncluded: string;
  seatPrice: string;
  seatsMax: string;
  numbersIncluded: string;
  numberPrice: string;
  numbersMax: string;
  teamsMax: string;
  liveAutomationsMax: string;
  automationRunsMonthly: string;
  runPackSize: string;
  runPackPrice: string;
  modules: string[];
}

export const EMPTY_PLAN_FORM: PlanFormValues = {
  code: '',
  name: '',
  description: '',
  price: '',
  intervalMonths: '1',
  trialDays: '0',
  graceDays: '7',
  seatsIncluded: '1',
  seatPrice: '',
  seatsMax: '',
  numbersIncluded: '1',
  numberPrice: '',
  numbersMax: '',
  teamsMax: '',
  liveAutomationsMax: '',
  automationRunsMonthly: '',
  runPackSize: '',
  runPackPrice: '',
  modules: [],
};

type Issues = Record<string, string>;

function issuesOf(result: { issues?: { path: string; message: string }[] }): Issues {
  const out: Issues = {};
  for (const issue of result.issues ?? []) out[issue.path] ??= issue.message;
  return out;
}

export function PlanForm({
  planId,
  initial,
}: {
  /** Absent for a new plan (version 1); a draft's id when editing it. */
  planId?: string;
  initial: PlanFormValues;
}) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [issues, setIssues] = useState<Issues>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<PlanFormValues>) => setValues((v) => ({ ...v, ...patch }));

  const text = (
    key: Exclude<keyof PlanFormValues, 'modules'>,
    label: string,
    options: { description?: string; inputMode?: 'numeric' | 'decimal'; placeholder?: string } = {},
  ) => (
    <Field id={`plan-${key}`} label={label} description={options.description} error={issues[key]}>
      {(aria) => (
        <Input
          {...aria}
          value={values[key]}
          inputMode={options.inputMode}
          placeholder={options.placeholder}
          onChange={(e) => set({ [key]: e.target.value })}
        />
      )}
    </Field>
  );

  return (
    <ClientForm
      className="grid gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(null);
        setIssues({});
        const failed = (r: { ok: boolean }) => {
          setBusy(false);
          if (r.ok) return false;
          const failure = r as Extract<Awaited<ReturnType<typeof createPlanAction>>, { ok: false }>;
          setError(failure.message);
          setIssues(issuesOf(failure));
          return true;
        };
        if (planId) {
          const { code: _code, ...terms } = values;
          void updatePlanDraftAction(planId, terms).then((r) => {
            if (!failed(r)) setSaved('Draft saved.');
          });
        } else {
          void createPlanAction(values).then((r) => {
            if (!failed(r) && r.ok) router.push(`/platform/plans/${r.data.id}`);
          });
        }
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved} />
      <fieldset className="grid gap-4">
        <legend className="mb-2 text-sm font-semibold">Name and price</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {planId ? null : (
            <Field
              id="plan-code"
              label="Code"
              description="Stays the same across versions, like growth or pro-annual."
              error={issues.code}
            >
              {(aria) => (
                <Input
                  {...aria}
                  value={values.code}
                  maxLength={40}
                  onChange={(e) => set({ code: e.target.value.toLowerCase() })}
                />
              )}
            </Field>
          )}
          {text('name', 'Name shown to companies')}
        </div>
        <Field id="plan-description" label="Description (optional)" error={issues.description}>
          {(aria) => (
            <Textarea
              {...aria}
              rows={2}
              maxLength={500}
              value={values.description}
              onChange={(e) => set({ description: e.target.value })}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          {text('price', 'Price (₹)', { inputMode: 'decimal', description: 'Before tax.' })}
          <Field id="plan-interval" label="Paid" error={issues.intervalMonths}>
            {(aria) => (
              <Select
                {...aria}
                value={values.intervalMonths}
                onChange={(e) => set({ intervalMonths: e.target.value })}
              >
                <option value="1">Monthly</option>
                <option value="3">Quarterly</option>
                <option value="12">Yearly</option>
              </Select>
            )}
          </Field>
        </div>
      </fieldset>
      <fieldset className="grid gap-4">
        <legend className="mb-2 text-sm font-semibold">Trial and grace</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {text('trialDays', 'Trial days', {
            inputMode: 'numeric',
            description: '0 to 90. A version with trial days can be the default trial.',
          })}
          {text('graceDays', 'Grace days after a paid period ends', {
            inputMode: 'numeric',
            description: '0 to 30. The company keeps working meanwhile.',
          })}
        </div>
      </fieldset>
      <fieldset className="grid gap-4">
        <legend className="mb-2 text-sm font-semibold">Seats and WhatsApp numbers</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          {text('seatsIncluded', 'Seats included', { inputMode: 'numeric' })}
          {text('seatPrice', 'Extra seat (₹ each)', {
            inputMode: 'decimal',
            description: 'Empty: extra seats are not sold.',
          })}
          {text('seatsMax', 'Most seats', {
            inputMode: 'numeric',
            description: 'Empty: no maximum.',
          })}
          {text('numbersIncluded', 'Numbers included', { inputMode: 'numeric' })}
          {text('numberPrice', 'Extra number (₹ each)', {
            inputMode: 'decimal',
            description: 'Empty: extra numbers are not sold.',
          })}
          {text('numbersMax', 'Most numbers', {
            inputMode: 'numeric',
            description: 'Empty: up to 100.',
          })}
        </div>
      </fieldset>
      <fieldset className="grid gap-4">
        <legend className="mb-2 text-sm font-semibold">Limits</legend>
        <p className="text-xs text-muted-foreground">Leave a limit empty for no limit.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          {text('teamsMax', 'Teams', { inputMode: 'numeric' })}
          {text('liveAutomationsMax', 'Live automations', { inputMode: 'numeric' })}
          {text('automationRunsMonthly', 'Automation runs a month', { inputMode: 'numeric' })}
          {text('runPackSize', 'Run pack (runs)', {
            inputMode: 'numeric',
            description: 'Needs a monthly run limit. Empty: not sold.',
          })}
          {text('runPackPrice', 'Run pack (₹)', { inputMode: 'decimal' })}
        </div>
      </fieldset>
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-semibold">Modules</legend>
        <p className="text-xs text-muted-foreground">
          Inbox, contacts, templates, campaigns, growth tools, reports and billing are in every
          plan.
        </p>
        {PLAN_MODULE_KEYS.map((m) => (
          <div key={m} className="flex items-center gap-2">
            <Checkbox
              id={`plan-module-${m}`}
              checked={values.modules.includes(m)}
              onChange={(e) =>
                set({
                  modules: e.target.checked
                    ? [...values.modules, m]
                    : values.modules.filter((x) => x !== m),
                })
              }
            />
            <Label htmlFor={`plan-module-${m}`} className="font-normal">
              {PLAN_MODULE_LABELS[m]}
            </Label>
          </div>
        ))}
        {issues.modules ? (
          <p role="alert" className="text-xs font-medium text-destructive">
            {issues.modules}
          </p>
        ) : null}
      </fieldset>
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : planId ? 'Save draft' : 'Create draft'}
        </Button>
      </div>
    </ClientForm>
  );
}

/** Publish, retire (or discard a draft) and start a new version. */
export function PlanVersionActions({
  id,
  status,
  companies,
}: {
  id: string;
  status: 'draft' | 'published' | 'retired';
  companies: number;
}) {
  const router = useRouter();
  // The reason stays disabled until hydration: one typed before would never reach `reason`,
  // leaving the retire button disabled (see useHydrated).
  const hydrated = useHydrated();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fail = (r: { ok: boolean; message?: string }) => {
    if (!r.ok) setError(r.message ?? 'Something went wrong.');
  };
  return (
    <div className="grid gap-4">
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        {status === 'draft' ? (
          <ConfirmDialog
            title="Publish this version?"
            description="It can then be assigned to companies, and its terms can never change again. A change needs a new version."
            confirmLabel="Publish"
            onConfirm={() => void publishPlanAction(id).then(fail)}
            trigger={<ClientButton>Publish</ClientButton>}
          />
        ) : (
          <ClientButton
            variant="outline"
            onClick={() =>
              void createPlanVersionAction(id).then((r) => {
                if (r.ok) router.push(`/platform/plans/${r.data.id}`);
                else setError(r.message);
              })
            }
          >
            New version from this one
          </ClientButton>
        )}
      </div>
      {status !== 'retired' ? (
        <div className="grid gap-2">
          <Field
            id="plan-retire-reason"
            label={status === 'draft' ? 'Reason for discarding' : 'Reason for retiring'}
          >
            {(aria) => (
              <Input
                {...aria}
                value={reason}
                maxLength={500}
                disabled={!hydrated}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </Field>
          <ConfirmDialog
            destructive
            title={status === 'draft' ? 'Discard this draft?' : 'Retire this version?'}
            description={
              status === 'draft'
                ? 'It stays listed as retired and can never be assigned.'
                : `It can no longer be assigned. The ${companies} ${companies === 1 ? 'company' : 'companies'} on it keep it.`
            }
            confirmLabel={status === 'draft' ? 'Discard' : 'Retire'}
            onConfirm={() => void retirePlanAction(id, { reason }).then(fail)}
            trigger={
              <ClientButton
                variant="outline"
                className="justify-self-start text-destructive"
                disabled={reason.trim().length < 10}
              >
                {status === 'draft' ? 'Discard draft' : 'Retire version'}
              </ClientButton>
            }
          />
        </div>
      ) : null}
    </div>
  );
}

export function DefaultTrialForm({
  current,
  options,
}: {
  current: string | null;
  options: { id: string; label: string }[];
}) {
  const [planId, setPlanId] = useState(current ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  return (
    <ClientForm
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setSaved(null);
        void setDefaultTrialAction({ planId }).then((r) => {
          if (!r.ok) setError(r.message);
          else
            setSaved(
              planId
                ? 'New companies now start this trial.'
                : 'New companies now start complimentary.',
            );
        });
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved} />
      <Field
        id="default-trial"
        label="New companies start"
        description="Only published versions with trial days are listed."
      >
        {(aria) => (
          <Select {...aria} value={planId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="">Complimentary (no plan, no limits)</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div>
        <Button type="submit">Save</Button>
      </div>
    </ClientForm>
  );
}

export interface AssignablePlanOption {
  id: string;
  label: string;
  trialDays: number;
  intervalMonths: number;
  sellsSeats: boolean;
  sellsNumbers: boolean;
  sellsRunPacks: boolean;
}

/** Calendar arithmetic on YYYY-MM-DD, independent of the browser's time zone. */
function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))).toISOString().slice(0, 10);
}

const STATE_LABELS = {
  complimentary: 'Complimentary (no plan, no limits, every module)',
  trialing: 'A trial of a plan',
  active: 'A paid period of a plan',
  canceled: 'End the plan (the company is restricted)',
} as const;

export function TenantPlanForm({
  tenantId,
  version,
  today,
  current,
  options,
}: {
  tenantId: string;
  version: number;
  /** Today in the company's time zone (YYYY-MM-DD). */
  today: string;
  current: {
    status: string;
    planId: string | null;
    trialEndsOn: string;
    periodStart: string;
    periodEnd: string;
    extraSeats: number;
    extraNumbers: number;
    runPacks: number;
  };
  options: AssignablePlanOption[];
}) {
  const initialStatus = (
    ['complimentary', 'trialing', 'active', 'canceled'].includes(current.status)
      ? current.status
      : current.status === 'past_due'
        ? 'active'
        : 'trialing'
  ) as keyof typeof STATE_LABELS;
  const [status, setStatus] = useState<keyof typeof STATE_LABELS>(initialStatus);
  const [planId, setPlanId] = useState(current.planId ?? options[0]?.id ?? '');
  const plan = options.find((o) => o.id === planId);
  const [trialEndsOn, setTrialEndsOn] = useState(
    current.trialEndsOn || addDays(today, plan?.trialDays || 14),
  );
  const [periodStart, setPeriodStart] = useState(current.periodStart || today);
  const [periodEnd, setPeriodEnd] = useState(
    current.periodEnd || addMonths(today, plan?.intervalMonths ?? 1),
  );
  const [addOns, setAddOns] = useState({
    extraSeats: String(current.extraSeats),
    extraNumbers: String(current.extraNumbers),
    runPacks: String(current.runPacks),
  });
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const needsPlan = status === 'trialing' || status === 'active';

  const submit = () => {
    setError(null);
    setSaved(null);
    void setTenantPlanAction({
      tenantId,
      version,
      status,
      planId: needsPlan ? planId : '',
      trialEndsOn: status === 'trialing' ? trialEndsOn : '',
      periodStart: status === 'active' ? periodStart : '',
      periodEnd: status === 'active' ? periodEnd : '',
      ...(needsPlan ? addOnsForPlan(plan, addOns) : addOns),
      reason,
    }).then((r) => {
      if (!r.ok) setError(r.message);
      else {
        setSaved('The company’s plan was changed.');
        setReason('');
      }
    });
  };

  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved} />
      <Field id="tenant-plan-status" label="The company gets">
        {(aria) => (
          <Select
            {...aria}
            value={status}
            onChange={(e) => setStatus(e.target.value as keyof typeof STATE_LABELS)}
          >
            {(Object.keys(STATE_LABELS) as (keyof typeof STATE_LABELS)[])
              .filter((s) => s !== 'canceled' || current.planId)
              .map((s) => (
                <option key={s} value={s}>
                  {STATE_LABELS[s]}
                </option>
              ))}
          </Select>
        )}
      </Field>
      {needsPlan ? (
        options.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No plan is published yet. A platform owner publishes plans under Plans.
          </p>
        ) : (
          <Field id="tenant-plan-plan" label="Plan">
            {(aria) => (
              <Select {...aria} value={planId} onChange={(e) => setPlanId(e.target.value)}>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )
      ) : null}
      {status === 'trialing' ? (
        <Field
          id="tenant-plan-trial"
          label="Trial ends on"
          description="At the start of this day in the company’s time zone."
        >
          {(aria) => (
            <Input
              {...aria}
              type="date"
              value={trialEndsOn}
              min={addDays(today, 1)}
              onChange={(e) => setTrialEndsOn(e.target.value)}
            />
          )}
        </Field>
      ) : null}
      {status === 'active' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="tenant-plan-start"
            label="Paid from"
            description="The start of this day, company time."
          >
            {(aria) => (
              <Input
                {...aria}
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            )}
          </Field>
          <Field
            id="tenant-plan-end"
            label="Paid until"
            description="The period ends at the start of this day."
          >
            {(aria) => (
              <Input
                {...aria}
                type="date"
                value={periodEnd}
                min={addDays(today, 1)}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            )}
          </Field>
        </div>
      ) : null}
      {needsPlan && plan && (plan.sellsSeats || plan.sellsNumbers || plan.sellsRunPacks) ? (
        <div className="grid gap-4 sm:grid-cols-3">
          {plan.sellsSeats ? (
            <Field id="tenant-plan-seats" label="Extra seats">
              {(aria) => (
                <Input
                  {...aria}
                  inputMode="numeric"
                  value={addOns.extraSeats}
                  onChange={(e) => setAddOns({ ...addOns, extraSeats: e.target.value })}
                />
              )}
            </Field>
          ) : null}
          {plan.sellsNumbers ? (
            <Field id="tenant-plan-numbers" label="Extra WhatsApp numbers">
              {(aria) => (
                <Input
                  {...aria}
                  inputMode="numeric"
                  value={addOns.extraNumbers}
                  onChange={(e) => setAddOns({ ...addOns, extraNumbers: e.target.value })}
                />
              )}
            </Field>
          ) : null}
          {plan.sellsRunPacks ? (
            <Field id="tenant-plan-packs" label="Automation run packs">
              {(aria) => (
                <Input
                  {...aria}
                  inputMode="numeric"
                  value={addOns.runPacks}
                  onChange={(e) => setAddOns({ ...addOns, runPacks: e.target.value })}
                />
              )}
            </Field>
          ) : null}
        </div>
      ) : null}
      <Field
        id="tenant-plan-reason"
        label="Reason (shown in the company’s audit log)"
        description="For example the invoice or ticket reference."
      >
        {(aria) => (
          <Textarea
            {...aria}
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </Field>
      <div>
        {status === 'canceled' ? (
          <ConfirmDialog
            destructive
            title="End this company’s plan?"
            description="The company is restricted at once: sending messages, campaigns and automations pauses until it is put on a plan again. Its data is kept."
            confirmLabel="End the plan"
            onConfirm={submit}
            trigger={
              <ClientButton variant="destructive" disabled={reason.trim().length < 10}>
                End the plan
              </ClientButton>
            }
          />
        ) : (
          <Button type="submit" disabled={reason.trim().length < 10 || (needsPlan && !plan)}>
            Save plan
          </Button>
        )}
      </div>
    </ClientForm>
  );
}
