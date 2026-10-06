'use client';
import { useId, useRef, useState } from 'react';
import { Button, Field, Input, Select } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import {
  archivePipelineAction,
  createPipelineAction,
  restorePipelineAction,
  updatePipelineAction,
} from '@/app/actions/crm';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

interface StageDraft {
  key: string;
  id: string | null;
  name: string;
  /** The chance of winning in percent as typed; empty for none (ADR-242). */
  winPercent: string;
}

/** A typed chance as the service takes it: a whole number, or null for an empty field. */
const chance = (typed: string): number | null =>
  typed.trim() === '' ? null : Number(typed.trim());

interface PipelineFormProps {
  slug: string;
  pipeline?: {
    id: string;
    name: string;
    currency: string;
    version: number;
    stages: { id: string; name: string; winPercent: number | null }[];
  };
  currencies: string[];
  defaultCurrency: string;
}

/**
 * Creates a pipeline, or renames one and sets its stages in order. Stages removed here are archived
 * (only when no open deal is in them); the currency is fixed when the pipeline is created. An edit
 * form's fields start again from the saved pipeline after each save (keyed by its version); the
 * confirmation is kept outside them so it stays visible.
 */
export function PipelineForm(props: PipelineFormProps) {
  const [saved, setSaved] = useState<string | null>(null);
  return (
    <div className="grid gap-4">
      <FormSuccess message={saved} />
      <PipelineFields
        key={props.pipeline ? props.pipeline.version : 'new'}
        {...props}
        onSubmitting={() => setSaved(null)}
        onSaved={setSaved}
      />
    </div>
  );
}

function PipelineFields({
  slug,
  pipeline,
  currencies,
  defaultCurrency,
  onSubmitting,
  onSaved,
}: PipelineFormProps & { onSubmitting: () => void; onSaved: (message: string) => void }) {
  const prefix = useId();
  const [name, setName] = useState(pipeline?.name ?? '');
  const [currency, setCurrency] = useState(pipeline?.currency ?? defaultCurrency);
  const [stages, setStages] = useState<StageDraft[]>(
    pipeline
      ? pipeline.stages.map((s) => ({
          key: s.id,
          id: s.id,
          name: s.name,
          winPercent: s.winPercent === null ? '' : String(s.winPercent),
        }))
      : ['New', 'Qualified', 'Proposal', 'Negotiation'].map((n, i) => ({
          key: `default-${i}`,
          id: null,
          name: n,
          winPercent: '',
        })),
  );
  // Keys for stages added in this editor (used from event handlers only).
  const added = useRef(0);
  const newKey = () => `new-${(added.current += 1)}`;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const move = (index: number, delta: number) => {
    const next = [...stages];
    const [item] = next.splice(index, 1);
    if (item) next.splice(index + delta, 0, item);
    setStages(next);
  };

  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        onSubmitting();
        const done = (r: { ok: true } | { ok: false; message: string }, message: string) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else onSaved(message);
        };
        if (pipeline) {
          void updatePipelineAction(slug, {
            id: pipeline.id,
            expectedVersion: pipeline.version,
            name,
            stages: stages.map((s) => ({
              id: s.id,
              name: s.name,
              winPercent: chance(s.winPercent),
            })),
          }).then((r) => done(r, 'Pipeline saved.'));
        } else {
          void createPipelineAction(slug, {
            name,
            currency,
            stages: stages.map((s) => ({ name: s.name, winPercent: chance(s.winPercent) })),
          }).then((r) => {
            done(r, 'Pipeline created.');
            if (r.ok) {
              setName('');
              setStages([{ key: newKey(), id: null, name: 'New', winPercent: '' }]);
            }
          });
        }
      }}
    >
      <FormError message={error} />
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_200px]">
        <Field id={`${prefix}-name`} label="Name">
          {(aria) => (
            <Input
              {...aria}
              value={name}
              required
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        {pipeline ? (
          <div className="grid content-start gap-2 text-sm">
            <span className="font-medium">Currency</span>
            <span>{pipeline.currency}</span>
            <span className="text-xs text-muted-foreground">
              Fixed when the pipeline was created.
            </span>
          </div>
        ) : (
          <Field
            id={`${prefix}-currency`}
            label="Currency"
            description="All deal values in this pipeline use it; it cannot change later."
          >
            {(aria) => (
              <Select {...aria} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {currencies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Stages, in order</legend>
        <ol className="grid gap-2">
          {stages.map((stage, index) => (
            <li key={stage.key} className="flex flex-wrap items-center gap-2">
              <label htmlFor={`${prefix}-stage-${index}`} className="sr-only">
                Stage {index + 1} name
              </label>
              <Input
                id={`${prefix}-stage-${index}`}
                className="min-w-40 flex-1"
                value={stage.name}
                maxLength={40}
                required
                onChange={(e) =>
                  setStages(
                    stages.map((s) => (s.key === stage.key ? { ...s, name: e.target.value } : s)),
                  )
                }
              />
              <label htmlFor={`${prefix}-chance-${index}`} className="sr-only">
                Stage {index + 1} chance of winning, in percent
              </label>
              <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                <Input
                  id={`${prefix}-chance-${index}`}
                  className="w-20"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={100}
                  step={1}
                  placeholder="—"
                  value={stage.winPercent}
                  onChange={(e) =>
                    setStages(
                      stages.map((s) =>
                        s.key === stage.key ? { ...s, winPercent: e.target.value } : s,
                      ),
                    )
                  }
                />
                %
              </span>
              <ClientButton
                type="button"
                size="sm"
                variant="outline"
                disabled={index === 0}
                aria-label={`Move ${stage.name || 'stage'} up`}
                onClick={() => move(index, -1)}
              >
                Up
              </ClientButton>
              <ClientButton
                type="button"
                size="sm"
                variant="outline"
                disabled={index === stages.length - 1}
                aria-label={`Move ${stage.name || 'stage'} down`}
                onClick={() => move(index, 1)}
              >
                Down
              </ClientButton>
              <ClientButton
                type="button"
                size="sm"
                variant="outline"
                disabled={stages.length === 1}
                aria-label={`Remove ${stage.name || 'stage'}`}
                onClick={() => setStages(stages.filter((s) => s.key !== stage.key))}
              >
                Remove
              </ClientButton>
            </li>
          ))}
        </ol>
        <div>
          <ClientButton
            type="button"
            size="sm"
            variant="outline"
            disabled={stages.length >= 30}
            onClick={() =>
              setStages([...stages, { key: newKey(), id: null, name: '', winPercent: '' }])
            }
          >
            Add stage
          </ClientButton>
        </div>
        <p className="text-xs text-muted-foreground">
          The percentage beside a stage is its chance of winning a deal: the board weighs each
          stage&apos;s open deals by it. Leave it empty to leave the stage out.
        </p>
        {pipeline ? (
          <p className="text-xs text-muted-foreground">
            Removing a stage keeps its closed deals; a stage with open deals cannot be removed until
            they move.
          </p>
        ) : null}
      </fieldset>
      <div>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : pipeline ? 'Save pipeline' : 'Create pipeline'}
        </Button>
      </div>
    </ClientForm>
  );
}

export function PipelineArchiveButton({
  slug,
  pipelineId,
  version,
  archived,
}: {
  slug: string;
  pipelineId: string;
  version: number;
  archived: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (action: typeof archivePipelineAction) => {
    setBusy(true);
    setError(null);
    void action(slug, { id: pipelineId, expectedVersion: version }).then((r) => {
      setBusy(false);
      if (!r.ok) setError(r.message);
    });
  };
  return (
    <div className="grid gap-2">
      <FormError message={error} />
      {archived ? (
        <div>
          <ClientButton
            variant="outline"
            disabled={busy}
            onClick={() => run(restorePipelineAction)}
          >
            Restore pipeline
          </ClientButton>
        </div>
      ) : (
        <ConfirmDialog
          title="Archive this pipeline?"
          description="It disappears from the board. Its closed deals stay in reports. A pipeline with open deals cannot be archived."
          confirmLabel="Archive"
          destructive
          onConfirm={() => run(archivePipelineAction)}
          trigger={
            <ClientButton variant="outline" disabled={busy}>
              Archive pipeline
            </ClientButton>
          }
        />
      )}
    </div>
  );
}
