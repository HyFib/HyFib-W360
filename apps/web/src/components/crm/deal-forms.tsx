'use client';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, Select } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import {
  closeDealAction,
  createDealAction,
  moveDealAction,
  reopenDealAction,
  searchContactsAction,
  updateDealAction,
} from '@/app/actions/crm';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';
import { givenFieldValues } from '@/lib/deal-fields';

export interface PipelineOption {
  id: string;
  name: string;
  currency: string;
  stages: { id: string; name: string }[];
}

export interface MemberOption {
  membershipId: string;
  name: string;
}

interface ContactChoice {
  id: string;
  label: string;
}

function ContactSearch({
  slug,
  value,
  onChange,
}: {
  slug: string;
  value: ContactChoice | null;
  onChange: (c: ContactChoice | null) => void;
}) {
  const prefix = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ContactChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (value) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          Contact: <strong>{value.label}</strong>
        </span>
        <ClientButton type="button" size="sm" variant="outline" onClick={() => onChange(null)}>
          Change
        </ClientButton>
      </div>
    );
  }
  const search = () => {
    setBusy(true);
    setError(null);
    void searchContactsAction(slug, query).then((r) => {
      setBusy(false);
      if (!r.ok) setError(r.message);
      else
        setResults(
          r.data.map((c) => ({ id: c.id, label: c.name ?? c.phone ?? 'Unnamed contact' })),
        );
    });
  };
  return (
    <div className="grid gap-2">
      <FormError message={error} />
      <div className="flex flex-wrap items-end gap-2">
        <Field
          id={`${prefix}-q`}
          label="Contact"
          description="Search by name or number."
          className="min-w-48 flex-1"
        >
          {(aria) => (
            <Input
              {...aria}
              value={query}
              maxLength={100}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  search();
                }
              }}
            />
          )}
        </Field>
        <ClientButton type="button" variant="outline" disabled={busy} onClick={search}>
          {busy ? 'Searching…' : 'Search'}
        </ClientButton>
      </div>
      {results ? (
        results.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matching contact.</p>
        ) : (
          <ul className="grid gap-1" aria-label="Matching contacts">
            {results.map((c) => (
              <li key={c.id}>
                <ClientButton type="button" size="sm" variant="ghost" onClick={() => onChange(c)}>
                  {c.label}
                </ClientButton>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

/**
 * Creates a deal for a contact (fixed when opened from a contact or conversation), with values for
 * the company's custom deal fields (ADR-379).
 */
export function NewDealForm({
  slug,
  pipelines,
  members,
  fields = [],
  contact,
  conversationId = null,
  defaultOwnerId = null,
}: {
  slug: string;
  pipelines: PipelineOption[];
  members: MemberOption[];
  fields?: readonly DealFieldOption[];
  contact?: ContactChoice | null;
  conversationId?: string | null;
  defaultOwnerId?: string | null;
}) {
  const prefix = useId();
  const router = useRouter();
  const [chosen, setChosen] = useState<ContactChoice | null>(contact ?? null);
  const [pipelineId, setPipelineId] = useState(pipelines[0]?.id ?? '');
  const pipeline = pipelines.find((p) => p.id === pipelineId);
  const [stageId, setStageId] = useState(pipelines[0]?.stages[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [value, setValue] = useState('');
  const [owner, setOwner] = useState(defaultOwnerId ?? '');
  const [closeOn, setCloseOn] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (pipelines.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Deals need a pipeline. An owner or administrator can create one in Settings → Pipelines.
      </p>
    );
  }
  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!chosen) {
          setError('Choose a contact.');
          return;
        }
        setBusy(true);
        setError(null);
        void createDealAction(slug, {
          contactId: chosen.id,
          conversationId,
          pipelineId,
          stageId,
          title,
          value,
          ownerMembershipId: owner || null,
          expectedCloseOn: closeOn || null,
          fields: givenFieldValues(values),
        }).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else router.push(`/c/${slug}/crm/deals/${r.data.id}`);
        });
      }}
    >
      <FormError message={error} />
      {contact ? null : <ContactSearch slug={slug} value={chosen} onChange={setChosen} />}
      <Field id={`${prefix}-title`} label="Deal title">
        {(aria) => (
          <Input
            {...aria}
            value={title}
            required
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${prefix}-pipeline`} label="Pipeline">
          {(aria) => (
            <Select
              {...aria}
              value={pipelineId}
              onChange={(e) => {
                setPipelineId(e.target.value);
                setStageId(pipelines.find((p) => p.id === e.target.value)?.stages[0]?.id ?? '');
              }}
            >
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.currency})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id={`${prefix}-stage`} label="Stage">
          {(aria) => (
            <Select {...aria} value={stageId} onChange={(e) => setStageId(e.target.value)}>
              {(pipeline?.stages ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          id={`${prefix}-value`}
          label={`Value (${pipeline?.currency ?? ''})`}
          description="Optional."
        >
          {(aria) => (
            <Input
              {...aria}
              inputMode="decimal"
              value={value}
              maxLength={40}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </Field>
        <Field id={`${prefix}-owner`} label="Owner">
          {(aria) => (
            <Select {...aria} value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">No owner</option>
              {members.map((m) => (
                <option key={m.membershipId} value={m.membershipId}>
                  {m.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id={`${prefix}-close`} label="Expected close date" description="Optional.">
          {(aria) => (
            <Input
              {...aria}
              type="date"
              value={closeOn}
              onChange={(e) => setCloseOn(e.target.value)}
            />
          )}
        </Field>
        {fields.map((field) => (
          <DealFieldControl
            key={field.key}
            id={`${prefix}-field-${field.key}`}
            field={field}
            value={values[field.key] ?? ''}
            onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
          />
        ))}
      </div>
      <div>
        <Button type="submit" disabled={busy || !title.trim()}>
          {busy ? 'Creating…' : 'Create deal'}
        </Button>
      </div>
    </ClientForm>
  );
}

interface DealEditProps {
  slug: string;
  deal: {
    id: string;
    version: number;
    title: string;
    value: string;
    currency: string;
    ownerMembershipId: string | null;
    expectedCloseOn: string | null;
  };
  members: MemberOption[];
  /** The company's custom deal fields (ADR-373), with the deal's value of each as typed. */
  fields: DealFieldInput[];
}

/** One of the company's custom deal fields (ADR-373), as deal forms show it. */
export interface DealFieldOption {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'boolean';
}

export interface DealFieldInput extends DealFieldOption {
  /** The deal's value as a form shows it; empty when it has none. */
  value: string;
}

/** One custom field's input: text, a number, a date, or yes/no (empty for none). */
function DealFieldControl({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: DealFieldOption;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field id={id} label={field.label}>
      {(aria) =>
        field.type === 'boolean' ? (
          <Select {...aria} value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">Not set</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </Select>
        ) : (
          <Input
            {...aria}
            type={field.type === 'date' ? 'date' : 'text'}
            inputMode={field.type === 'number' ? 'decimal' : undefined}
            value={value}
            maxLength={1000}
            onChange={(e) => onChange(e.target.value)}
          />
        )
      }
    </Field>
  );
}

/**
 * Edits a deal. After each save the fields start again from the saved deal (they are keyed by its
 * version); the confirmation is kept outside them so it stays visible.
 */
export function DealEditForm(props: DealEditProps) {
  const [saved, setSaved] = useState<string | null>(null);
  return (
    <div className="grid gap-4">
      <FormSuccess message={saved} />
      <DealEditFields
        key={props.deal.version}
        {...props}
        onSubmitting={() => setSaved(null)}
        onSaved={() => setSaved('Deal saved.')}
      />
    </div>
  );
}

function DealEditFields({
  slug,
  deal,
  members,
  fields,
  onSubmitting,
  onSaved,
}: DealEditProps & { onSubmitting: () => void; onSaved: () => void }) {
  const prefix = useId();
  const [title, setTitle] = useState(deal.title);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.key, field.value])),
  );
  const [value, setValue] = useState(deal.value);
  const [owner, setOwner] = useState(deal.ownerMembershipId ?? '');
  const [closeOn, setCloseOn] = useState(deal.expectedCloseOn ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        onSubmitting();
        void updateDealAction(slug, {
          id: deal.id,
          expectedVersion: deal.version,
          title,
          value,
          ownerMembershipId: owner || null,
          expectedCloseOn: closeOn || null,
          fields: values,
        }).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else onSaved();
        });
      }}
    >
      <FormError message={error} />
      <Field id={`${prefix}-title`} label="Deal title">
        {(aria) => (
          <Input
            {...aria}
            value={title}
            required
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id={`${prefix}-value`} label={`Value (${deal.currency})`}>
          {(aria) => (
            <Input
              {...aria}
              inputMode="decimal"
              value={value}
              maxLength={40}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </Field>
        <Field id={`${prefix}-owner`} label="Owner">
          {(aria) => (
            <Select {...aria} value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">No owner</option>
              {members.map((m) => (
                <option key={m.membershipId} value={m.membershipId}>
                  {m.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id={`${prefix}-close`} label="Expected close date">
          {(aria) => (
            <Input
              {...aria}
              type="date"
              value={closeOn}
              onChange={(e) => setCloseOn(e.target.value)}
            />
          )}
        </Field>
      </div>
      {fields.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-3">
          {fields.map((field) => (
            <DealFieldControl
              key={field.key}
              id={`${prefix}-field-${field.key}`}
              field={field}
              value={values[field.key] ?? ''}
              onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
            />
          ))}
        </div>
      ) : null}
      <div>
        <Button type="submit" disabled={busy || !title.trim()}>
          {busy ? 'Saving…' : 'Save deal'}
        </Button>
      </div>
    </ClientForm>
  );
}

/** Moves an open deal to another stage of its pipeline. */
export function StageSelect({
  slug,
  dealId,
  dealTitle,
  version,
  stageId,
  stages,
}: {
  slug: string;
  dealId: string;
  dealTitle: string;
  version: number;
  stageId: string;
  stages: { id: string; name: string }[];
}) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm className="grid gap-1" onSubmit={(e) => e.preventDefault()}>
      <label htmlFor={id} className="sr-only">
        Stage of {dealTitle}
      </label>
      <Select
        id={id}
        value={stageId}
        disabled={busy}
        onChange={(e) => {
          setBusy(true);
          setError(null);
          void moveDealAction(slug, {
            id: dealId,
            expectedVersion: version,
            stageId: e.target.value,
          }).then((r) => {
            setBusy(false);
            if (!r.ok) setError(r.message);
          });
        }}
      >
        {stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
      <FormError message={error} />
    </ClientForm>
  );
}

/**
 * Moves an open deal to a stage of another of the company's pipelines (ADR-234). The deal keeps its
 * value only between pipelines of one currency: the service refuses the move otherwise.
 */
export function PipelineMoveForm({
  slug,
  dealId,
  version,
  pipelines,
}: {
  slug: string;
  dealId: string;
  version: number;
  /** The company's other pipelines with stages a deal can be in. */
  pipelines: PipelineOption[];
}) {
  const prefix = useId();
  const choices = pipelines.filter((p) => p.stages.length > 0);
  const [pipelineId, setPipelineId] = useState(choices[0]?.id ?? '');
  const pipeline = choices.find((p) => p.id === pipelineId);
  const [stageId, setStageId] = useState(choices[0]?.stages[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (choices.length === 0) return null;
  return (
    <ClientForm
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        void moveDealAction(slug, { id: dealId, expectedVersion: version, pipelineId, stageId })
          .then((r) => {
            if (!r.ok) setError(r.message);
          })
          .catch(() => setError('The deal could not be moved because the connection failed.'))
          .finally(() => setBusy(false));
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${prefix}-pipeline`} label="Pipeline">
          {(aria) => (
            <Select
              {...aria}
              value={pipelineId}
              onChange={(e) => {
                setPipelineId(e.target.value);
                setStageId(choices.find((p) => p.id === e.target.value)?.stages[0]?.id ?? '');
              }}
            >
              {choices.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.currency})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id={`${prefix}-stage`} label="Stage in that pipeline">
          {(aria) => (
            <Select {...aria} value={stageId} onChange={(e) => setStageId(e.target.value)}>
              {(pipeline?.stages ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <FormError message={error} />
      <div>
        <Button type="submit" variant="outline" disabled={busy || !stageId}>
          {busy ? 'Moving…' : 'Move deal'}
        </Button>
      </div>
    </ClientForm>
  );
}

/** Marks an open deal won or lost (with an optional reason), or reopens a closed one. */
export function DealOutcomeActions({
  slug,
  dealId,
  version,
  status,
}: {
  slug: string;
  dealId: string;
  version: number;
  status: 'open' | 'won' | 'lost';
}) {
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<{ ok: true } | { ok: false; message: string }>) => {
    setBusy(true);
    setError(null);
    void fn().then((r) => {
      setBusy(false);
      if (!r.ok) setError(r.message);
    });
  };
  if (status !== 'open') {
    return (
      <div className="grid gap-2">
        <FormError message={error} />
        <div>
          <ClientButton
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(() => reopenDealAction(slug, { id: dealId, expectedVersion: version }))
            }
          >
            Reopen deal
          </ClientButton>
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <ClientButton
          disabled={busy}
          onClick={() =>
            run(() =>
              closeDealAction(slug, { id: dealId, expectedVersion: version, outcome: 'won' }),
            )
          }
        >
          Mark won
        </ClientButton>
        <ConfirmDialog
          title="Mark this deal lost?"
          description="It leaves the board and counts as lost in reports. You can reopen it later."
          confirmLabel="Mark lost"
          onConfirm={() =>
            run(() =>
              closeDealAction(slug, {
                id: dealId,
                expectedVersion: version,
                outcome: 'lost',
                lostReason: reason || null,
              }),
            )
          }
          trigger={
            <ClientButton variant="outline" disabled={busy}>
              Mark lost
            </ClientButton>
          }
        >
          <Field id={reasonId} label="Reason (optional)" description="Only your team sees this.">
            {(aria) => (
              <Input
                {...aria}
                value={reason}
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </Field>
        </ConfirmDialog>
      </div>
    </div>
  );
}
