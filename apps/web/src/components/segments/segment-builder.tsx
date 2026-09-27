'use client';
import { useState } from 'react';
import { Button, Field, Input, Select } from '@w360/ui';
import { previewSegmentAction } from '@/app/actions/campaigns';
import { ClientButton } from '@/components/client-form';
import { FormError } from '@/components/form-status';

/**
 * Builds a segment definition (validated again by the server). Conditions are combined with
 * "all" or "any"; the preview counts matching contacts now.
 */
export type Condition =
  | { type: 'tag'; op: 'has' | 'not_has'; tag: string }
  | {
      type: 'consent';
      purpose: 'marketing' | 'utility';
      status: 'opted_in' | 'opted_out' | 'not_recorded';
    }
  | { type: 'field'; key: string; op: string; value?: string }
  | { type: 'created'; op: 'before' | 'after'; date: string }
  | { type: 'source'; source: 'whatsapp' | 'manual' | 'import' | 'api' | 'store' }
  | { type: 'last_message'; op: 'within_days' | 'not_within_days'; days: number }
  | { type: 'calling_code'; prefix: string }
  | {
      type: 'campaign';
      campaignId: string;
      outcome: 'delivered' | 'not_delivered' | 'read' | 'replied' | 'not_replied';
    };

export interface Definition {
  match: 'all' | 'any';
  conditions: Condition[];
}

export interface BuilderField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'boolean';
}

const FIELD_OPS: Record<BuilderField['type'], { value: string; label: string }[]> = {
  text: [
    { value: 'equals', label: 'is' },
    { value: 'not_equals', label: 'is not' },
    { value: 'contains', label: 'contains' },
    { value: 'is_set', label: 'has a value' },
    { value: 'is_not_set', label: 'has no value' },
  ],
  number: [
    { value: 'equals', label: 'equals' },
    { value: 'not_equals', label: 'does not equal' },
    { value: 'greater_than', label: 'is more than' },
    { value: 'less_than', label: 'is less than' },
    { value: 'is_set', label: 'has a value' },
    { value: 'is_not_set', label: 'has no value' },
  ],
  date: [
    { value: 'equals', label: 'is on' },
    { value: 'before', label: 'is before' },
    { value: 'after', label: 'is after' },
    { value: 'is_set', label: 'has a value' },
    { value: 'is_not_set', label: 'has no value' },
  ],
  boolean: [
    { value: 'is_true', label: 'is yes' },
    { value: 'is_false', label: 'is no' },
    { value: 'is_set', label: 'has a value' },
    { value: 'is_not_set', label: 'has no value' },
  ],
};
const NEEDS_VALUE = new Set([
  'equals',
  'not_equals',
  'contains',
  'greater_than',
  'less_than',
  'before',
  'after',
]);

const TYPES: { value: Condition['type']; label: string }[] = [
  { value: 'tag', label: 'Tag' },
  { value: 'consent', label: 'Consent' },
  { value: 'field', label: 'Custom field' },
  { value: 'created', label: 'Added to contacts' },
  { value: 'source', label: 'Source' },
  { value: 'last_message', label: 'Last message from them' },
  { value: 'calling_code', label: 'Country calling code' },
  { value: 'campaign', label: 'Response to a campaign' },
];

function blank(
  type: Condition['type'],
  fields: BuilderField[],
  campaigns: { id: string }[],
): Condition {
  switch (type) {
    case 'tag':
      return { type, op: 'has', tag: '' };
    case 'consent':
      return { type, purpose: 'marketing', status: 'opted_in' };
    case 'field':
      return { type, key: fields[0]?.key ?? '', op: 'is_set' };
    case 'created':
      return { type, op: 'after', date: '' };
    case 'source':
      return { type, source: 'import' };
    case 'last_message':
      return { type, op: 'within_days', days: 30 };
    case 'calling_code':
      return { type, prefix: '91' };
    case 'campaign':
      return { type, campaignId: campaigns[0]?.id ?? '', outcome: 'replied' };
  }
}

export function SegmentBuilder({
  slug,
  value,
  onChange,
  fields,
  campaigns,
  idPrefix = 'seg',
}: {
  slug: string;
  value: Definition;
  onChange: (next: Definition) => void;
  fields: BuilderField[];
  campaigns: { id: string; name: string }[];
  idPrefix?: string;
}) {
  const [preview, setPreview] = useState<{
    count: number;
    sample: { id: string; displayName: string | null; phoneE164: string | null }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (index: number, condition: Condition) => {
    setPreview(null);
    onChange({
      ...value,
      conditions: value.conditions.map((c, i) => (i === index ? condition : c)),
    });
  };
  const remove = (index: number) => {
    setPreview(null);
    onChange({ ...value, conditions: value.conditions.filter((_, i) => i !== index) });
  };
  const types = TYPES.filter(
    (t) =>
      (t.value !== 'field' || fields.length > 0) &&
      (t.value !== 'campaign' || campaigns.length > 0),
  );

  return (
    <div className="grid gap-4">
      <Field id={`${idPrefix}-match`} label="Contacts must match">
        {(aria) => (
          <Select
            {...aria}
            value={value.match}
            onChange={(e) => {
              setPreview(null);
              onChange({ ...value, match: e.target.value === 'any' ? 'any' : 'all' });
            }}
          >
            <option value="all">all conditions</option>
            <option value="any">any condition</option>
          </Select>
        )}
      </Field>
      <ol className="grid gap-3" aria-label="Conditions">
        {value.conditions.map((c, i) => (
          <li
            key={i}
            className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-end"
          >
            <Field id={`${idPrefix}-type-${i}`} label={`Condition ${i + 1}`}>
              {(aria) => (
                <Select
                  {...aria}
                  value={c.type}
                  onChange={(e) =>
                    set(i, blank(e.target.value as Condition['type'], fields, campaigns))
                  }
                >
                  {types.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <ConditionFields
              id={`${idPrefix}-${i}`}
              condition={c}
              fields={fields}
              campaigns={campaigns}
              onChange={(next) => set(i, next)}
            />
            <Button type="button" variant="ghost" onClick={() => remove(i)}>
              Remove
            </Button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        {value.conditions.length < 20 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setPreview(null);
              onChange({
                ...value,
                conditions: [...value.conditions, blank('tag', fields, campaigns)],
              });
            }}
          >
            Add condition
          </Button>
        ) : null}
        <ClientButton
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || value.conditions.length === 0}
          onClick={() => {
            setBusy(true);
            setError(null);
            void previewSegmentAction(slug, value).then((r) => {
              setBusy(false);
              if (!r.ok) setError(r.message);
              else setPreview(r.data);
            });
          }}
        >
          {busy ? 'Counting…' : 'Preview matches'}
        </ClientButton>
      </div>
      <FormError message={error} />
      {preview ? (
        <div className="grid gap-1 text-sm" aria-live="polite">
          <p className="font-medium">
            {preview.count === 1
              ? '1 contact matches now.'
              : `${preview.count} contacts match now.`}
          </p>
          {preview.sample.length > 0 ? (
            <ul className="text-muted-foreground">
              {preview.sample.map((p) => (
                <li key={p.id}>
                  {p.displayName ?? 'Unnamed'} {p.phoneE164 ? `· ${p.phoneE164}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ConditionFields({
  id,
  condition: c,
  fields,
  campaigns,
  onChange,
}: {
  id: string;
  condition: Condition;
  fields: BuilderField[];
  campaigns: { id: string; name: string }[];
  onChange: (next: Condition) => void;
}) {
  switch (c.type) {
    case 'tag':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${id}-op`} label="Match">
            {(aria) => (
              <Select
                {...aria}
                value={c.op}
                onChange={(e) =>
                  onChange({ ...c, op: e.target.value === 'not_has' ? 'not_has' : 'has' })
                }
              >
                <option value="has">has the tag</option>
                <option value="not_has">does not have the tag</option>
              </Select>
            )}
          </Field>
          <Field id={`${id}-tag`} label="Tag">
            {(aria) => (
              <Input
                {...aria}
                value={c.tag}
                maxLength={40}
                onChange={(e) => onChange({ ...c, tag: e.target.value })}
              />
            )}
          </Field>
        </div>
      );
    case 'consent':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${id}-purpose`} label="Messages">
            {(aria) => (
              <Select
                {...aria}
                value={c.purpose}
                onChange={(e) =>
                  onChange({
                    ...c,
                    purpose: e.target.value === 'utility' ? 'utility' : 'marketing',
                  })
                }
              >
                <option value="marketing">Marketing</option>
                <option value="utility">Utility</option>
              </Select>
            )}
          </Field>
          <Field id={`${id}-status`} label="Consent">
            {(aria) => (
              <Select
                {...aria}
                value={c.status}
                onChange={(e) => onChange({ ...c, status: e.target.value as typeof c.status })}
              >
                <option value="opted_in">opted in</option>
                <option value="opted_out">opted out</option>
                <option value="not_recorded">not recorded</option>
              </Select>
            )}
          </Field>
        </div>
      );
    case 'field': {
      const field = fields.find((f) => f.key === c.key) ?? fields[0];
      const ops = FIELD_OPS[field?.type ?? 'text'];
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field id={`${id}-key`} label="Field">
            {(aria) => (
              <Select
                {...aria}
                value={c.key}
                onChange={(e) => onChange({ type: 'field', key: e.target.value, op: 'is_set' })}
              >
                {fields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id={`${id}-op`} label="Comparison">
            {(aria) => (
              <Select
                {...aria}
                value={c.op}
                onChange={(e) => onChange({ ...c, op: e.target.value })}
              >
                {ops.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {NEEDS_VALUE.has(c.op) ? (
            <Field id={`${id}-value`} label="Value">
              {(aria) => (
                <Input
                  {...aria}
                  type={
                    field?.type === 'date' ? 'date' : field?.type === 'number' ? 'number' : 'text'
                  }
                  value={c.value ?? ''}
                  maxLength={200}
                  onChange={(e) => onChange({ ...c, value: e.target.value })}
                />
              )}
            </Field>
          ) : null}
        </div>
      );
    }
    case 'created':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${id}-op`} label="When">
            {(aria) => (
              <Select
                {...aria}
                value={c.op}
                onChange={(e) =>
                  onChange({ ...c, op: e.target.value === 'before' ? 'before' : 'after' })
                }
              >
                <option value="after">after</option>
                <option value="before">before</option>
              </Select>
            )}
          </Field>
          <Field id={`${id}-date`} label="Date">
            {(aria) => (
              <Input
                {...aria}
                type="date"
                value={c.date}
                onChange={(e) => onChange({ ...c, date: e.target.value })}
              />
            )}
          </Field>
        </div>
      );
    case 'source':
      return (
        <Field id={`${id}-source`} label="Came from">
          {(aria) => (
            <Select
              {...aria}
              value={c.source}
              onChange={(e) => onChange({ ...c, source: e.target.value as typeof c.source })}
            >
              <option value="whatsapp">a WhatsApp message</option>
              <option value="manual">manual entry</option>
              <option value="import">an import</option>
              <option value="api">the API</option>
              <option value="store">a store order</option>
            </Select>
          )}
        </Field>
      );
    case 'last_message':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${id}-op`} label="Wrote to us">
            {(aria) => (
              <Select
                {...aria}
                value={c.op}
                onChange={(e) =>
                  onChange({
                    ...c,
                    op: e.target.value === 'not_within_days' ? 'not_within_days' : 'within_days',
                  })
                }
              >
                <option value="within_days">in the last</option>
                <option value="not_within_days">not in the last</option>
              </Select>
            )}
          </Field>
          <Field id={`${id}-days`} label="Days">
            {(aria) => (
              <Input
                {...aria}
                type="number"
                min={1}
                max={365}
                value={String(c.days)}
                onChange={(e) => onChange({ ...c, days: Number(e.target.value) || 1 })}
              />
            )}
          </Field>
        </div>
      );
    case 'calling_code':
      return (
        <Field
          id={`${id}-prefix`}
          label="Number starts with +"
          description="Digits only, for example 91 or 971."
        >
          {(aria) => (
            <Input
              {...aria}
              inputMode="numeric"
              value={c.prefix}
              maxLength={4}
              onChange={(e) => onChange({ ...c, prefix: e.target.value.replace(/\D/g, '') })}
            />
          )}
        </Field>
      );
    case 'campaign':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${id}-campaign`} label="Campaign">
            {(aria) => (
              <Select
                {...aria}
                value={c.campaignId}
                onChange={(e) => onChange({ ...c, campaignId: e.target.value })}
              >
                {campaigns.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id={`${id}-outcome`} label="They">
            {(aria) => (
              <Select
                {...aria}
                value={c.outcome}
                onChange={(e) => onChange({ ...c, outcome: e.target.value as typeof c.outcome })}
              >
                <option value="replied">replied</option>
                <option value="not_replied">received it but did not reply</option>
                <option value="read">read it</option>
                <option value="delivered">received it</option>
                <option value="not_delivered">did not receive it</option>
              </Select>
            )}
          </Field>
        </div>
      );
  }
}
