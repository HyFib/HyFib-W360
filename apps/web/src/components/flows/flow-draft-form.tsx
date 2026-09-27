'use client';
import { useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FLOW_CATEGORIES, checkFlowJson } from '@w360/domain/flow-json';
import { Button, Checkbox, Field, Input, Select, Textarea } from '@w360/ui';
import { createFlowAction, updateFlowDraftAction } from '@/app/actions/flows';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';
import { FLOW_CATEGORY_LABELS } from '@/lib/flow-labels';

interface DraftValues {
  id: string;
  version: number;
  name: string;
  categories: string[];
  json: string;
}

/**
 * Creates a flow, or edits a draft: name, categories and the Flow JSON, checked as it is typed.
 * Meta validates every component again when the JSON is uploaded.
 */
export function FlowDraftForm({
  slug,
  accounts,
  draft,
  starterJson,
  locked,
}: {
  slug: string;
  accounts?: { id: string; name: string; connected: boolean }[];
  draft?: DraftValues;
  starterJson?: string;
  /** Why the draft cannot be saved right now (Meta is processing the last change). */
  locked?: string | null;
}) {
  const router = useRouter();
  const p = useId();
  const usable = (accounts ?? []).filter((a) => a.connected);
  const [accountId, setAccountId] = useState(usable[0]?.id ?? '');
  const [name, setName] = useState(draft?.name ?? '');
  const [categories, setCategories] = useState<string[]>(draft?.categories ?? ['LEAD_GENERATION']);
  const [json, setJson] = useState(draft?.json ?? starterJson ?? '');
  // The page passes the current version after each change; a save made here may be newer still.
  const [savedVersion, setSavedVersion] = useState(0);
  const version = Math.max(draft?.version ?? 1, savedVersion);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = useMemo(() => checkFlowJson(json), [json]);
  if (!draft && usable.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Connect a WhatsApp account first (Settings → Channels): a flow belongs to one account.
      </p>
    );
  }
  const toggle = (c: string) =>
    setCategories((current) =>
      current.includes(c) ? current.filter((x) => x !== c) : [...current, c],
    );
  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(null);
        if (draft) {
          void updateFlowDraftAction(slug, {
            id: draft.id,
            expectedVersion: version,
            name,
            categories,
            json,
          }).then((r) => {
            setBusy(false);
            if (!r.ok) setError(r.message);
            else {
              setSavedVersion(r.data.version);
              setSaved(
                r.data.syncing
                  ? 'Saved. HyFib is sending the draft to Meta.'
                  : 'Nothing changed: Meta already has this draft.',
              );
            }
          });
        } else {
          void createFlowAction(slug, {
            whatsappAccountId: accountId,
            name,
            categories,
            json,
          }).then((r) => {
            setBusy(false);
            if (!r.ok) setError(r.message);
            else router.push(`/c/${slug}/flows/${r.data.id}`);
          });
        }
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${p}-name`}
          label="Name"
          description="Shown to your team and in WhatsApp Manager."
        >
          {(aria) => (
            <Input
              {...aria}
              required
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        {draft ? null : (
          <Field id={`${p}-account`} label="WhatsApp account">
            {(aria) => (
              <Select {...aria} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {usable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Categories</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {FLOW_CATEGORIES.map((c) => (
            <label key={c} htmlFor={`${p}-cat-${c}`} className="flex items-center gap-2 text-sm">
              <Checkbox
                id={`${p}-cat-${c}`}
                checked={categories.includes(c)}
                onChange={() => toggle(c)}
              />
              {FLOW_CATEGORY_LABELS[c] ?? c}
            </label>
          ))}
        </div>
      </fieldset>
      <Field
        id={`${p}-json`}
        label="Flow JSON"
        description="The screens and components of the form, in Meta’s Flow JSON format."
      >
        {(aria) => (
          <Textarea
            {...aria}
            rows={18}
            spellCheck={false}
            className="font-mono text-xs"
            value={json}
            onChange={(e) => setJson(e.target.value)}
          />
        )}
      </Field>
      {check.ok ? (
        <p className="text-sm text-muted-foreground" role="status">
          Version {check.summary.version} · screens: {check.summary.screens.join(', ')}
          {check.summary.answerKeys.length > 0
            ? ` · answers: ${check.summary.answerKeys.join(', ')}`
            : ''}
          {check.summary.dataApiVersion ? ' · fetches data from your endpoint' : ''}
        </p>
      ) : (
        <ul className="grid gap-1 text-sm text-destructive" role="status">
          {check.issues.slice(0, 8).map((issue) => (
            <li key={`${issue.path}-${issue.message}`}>
              {issue.path}: {issue.message}
            </li>
          ))}
        </ul>
      )}
      {locked ? <p className="text-sm text-muted-foreground">{locked}</p> : null}
      <div>
        <Button
          type="submit"
          disabled={
            busy ||
            Boolean(locked) ||
            !check.ok ||
            !name.trim() ||
            categories.length === 0 ||
            (!draft && !accountId)
          }
        >
          {busy ? 'Saving…' : draft ? 'Save and send to Meta' : 'Create and send to Meta'}
        </Button>
      </div>
    </ClientForm>
  );
}
