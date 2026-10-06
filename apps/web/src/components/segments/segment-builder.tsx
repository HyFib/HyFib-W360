'use client';
import { useState } from 'react';
import { minorToInput, parseAmountToMinor } from '@w360/domain/crm-money';
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
  | { type: 'name'; op: (typeof NAME_OPS)[number]['value']; value?: string }
  | { type: 'created'; op: 'before' | 'after'; date: string }
  | { type: 'source'; source: 'whatsapp' | 'manual' | 'import' | 'api' | 'store' }
  | { type: 'last_message'; op: 'within_days' | 'not_within_days'; days: number }
  | { type: 'calling_code'; prefix: string }
  | {
      type: 'campaign';
      campaignId: string;
      outcome: 'delivered' | 'not_delivered' | 'read' | 'replied' | 'not_replied';
    }
  | {
      type: 'orders';
      op: 'at_least' | 'fewer_than';
      count: number;
      days?: number | undefined;
      storeId?: string | undefined;
    }
  | {
      type: 'spend';
      op: 'at_least' | 'less_than';
      currency: string;
      amountMinor: number;
      days?: number | undefined;
      storeId?: string | undefined;
    };

/** A store whose orders conditions can count (ADR-231). */
export interface BuilderStore {
  id: string;
  name: string;
}

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
/** How the contact's name is compared (ADR-143): as a text field's value is. */
const NAME_OPS = [
  { value: 'contains', label: 'contains' },
  { value: 'equals', label: 'is' },
  { value: 'not_equals', label: 'is not' },
  { value: 'is_set', label: 'has a name' },
  { value: 'is_not_set', label: 'has no name' },
] as const;
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
  { value: 'name', label: 'Name' },
  { value: 'field', label: 'Custom field' },
  { value: 'created', label: 'Added to contacts' },
  { value: 'source', label: 'Source' },
  { value: 'last_message', label: 'Last message from them' },
  { value: 'calling_code', label: 'Country calling code' },
  { value: 'campaign', label: 'Response to a campaign' },
  { value: 'orders', label: 'Store orders' },
  { value: 'spend', label: 'Spent in stores' },
];

function blank(
  type: Condition['type'],
  fields: BuilderField[],
  campaigns: { id: string }[],
  orderCurrencies: string[],
): Condition {
  switch (type) {
    case 'tag':
      return { type, op: 'has', tag: '' };
    case 'consent':
      return { type, purpose: 'marketing', status: 'opted_in' };
    case 'field':
      return { type, key: fields[0]?.key ?? '', op: 'is_set' };
    case 'name':
      return { type, op: 'contains', value: '' };
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
    case 'orders':
      return { type, op: 'at_least', count: 1 };
    case 'spend':
      return { type, op: 'at_least', currency: orderCurrencies[0] ?? 'INR', amountMinor: 0 };
  }
}

export function SegmentBuilder({
  slug,
  value,
  onChange,
  fields,
  campaigns,
  stores = [],
  orderCurrencies = [],
  idPrefix = 'seg',
}: {
  slug: string;
  value: Definition;
  onChange: (next: Definition) => void;
  fields: BuilderField[];
  campaigns: { id: string; name: string }[];
  /** The company's stores, when the member can read their orders (ADR-231). */
  stores?: BuilderStore[];
  /** The currencies the company's store orders are in. */
  orderCurrencies?: string[];
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
      (t.value !== 'campaign' || campaigns.length > 0) &&
      (t.value !== 'orders' || stores.length > 0) &&
      (t.value !== 'spend' || (stores.length > 0 && orderCurrencies.length > 0)),
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
                    set(
                      i,
                      blank(
                        e.target.value as Condition['type'],
                        fields,
                        campaigns,
                        orderCurrencies,
                      ),
                    )
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
              stores={stores}
              orderCurrencies={orderCurrencies}
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
                conditions: [...value.conditions, blank('tag', fields, campaigns, orderCurrencies)],
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

/** An optional number of days back; empty means any time. */
function daysValue(text: string): number | undefined {
  const n = Number(text);
  return text.trim() && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The orders' store: any of them, or one (ADR-231). */
function StoreField({
  id,
  stores,
  storeId,
  onChange,
}: {
  id: string;
  stores: BuilderStore[];
  storeId: string | undefined;
  onChange: (storeId: string | undefined) => void;
}) {
  return (
    <Field id={`${id}-store`} label="Store">
      {(aria) => (
        <Select
          {...aria}
          value={storeId ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
          <option value="">any store</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

function DaysField({
  id,
  days,
  onChange,
}: {
  id: string;
  days: number | undefined;
  onChange: (days: number | undefined) => void;
}) {
  return (
    <Field id={`${id}-days`} label="In the last (days)" description="Leave empty for any time.">
      {(aria) => (
        <Input
          {...aria}
          type="number"
          min={1}
          max={3650}
          value={days === undefined ? '' : String(days)}
          onChange={(e) => onChange(daysValue(e.target.value))}
        />
      )}
    </Field>
  );
}

/** An amount typed in major units, kept in minor units once it reads as one. */
function AmountField({
  id,
  currency,
  amountMinor,
  onChange,
}: {
  id: string;
  currency: string;
  amountMinor: number;
  onChange: (amountMinor: number) => void;
}) {
  const [text, setText] = useState(() => minorToInput(amountMinor, currency));
  const valid = parseAmountToMinor(text, currency) !== null;
  return (
    <Field
      id={`${id}-amount`}
      label="Amount"
      {...(valid ? {} : { error: 'Enter an amount like 2500 or 2500.50.' })}
    >
      {(aria) => (
        <Input
          {...aria}
          inputMode="decimal"
          value={text}
          maxLength={20}
          onChange={(e) => {
            setText(e.target.value);
            const minor = parseAmountToMinor(e.target.value, currency);
            if (minor !== null) onChange(minor);
          }}
        />
      )}
    </Field>
  );
}

function ConditionFields({
  id,
  condition: c,
  fields,
  campaigns,
  stores,
  orderCurrencies,
  onChange,
}: {
  id: string;
  condition: Condition;
  fields: BuilderField[];
  campaigns: { id: string; name: string }[];
  stores: BuilderStore[];
  orderCurrencies: string[];
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
    case 'name':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${id}-op`} label="Comparison">
            {(aria) => (
              <Select
                {...aria}
                value={c.op}
                onChange={(e) =>
                  onChange({
                    ...c,
                    op: NAME_OPS.find((o) => o.value === e.target.value)?.value ?? 'contains',
                  })
                }
              >
                {NAME_OPS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {NEEDS_VALUE.has(c.op) ? (
            <Field id={`${id}-value`} label="Name">
              {(aria) => (
                <Input
                  {...aria}
                  value={c.value ?? ''}
                  maxLength={200}
                  onChange={(e) => onChange({ ...c, value: e.target.value })}
                />
              )}
            </Field>
          ) : null}
        </div>
      );
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
    case 'orders':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${id}-op`} label="Placed">
            {(aria) => (
              <Select
                {...aria}
                value={c.op}
                onChange={(e) =>
                  onChange({
                    ...c,
                    op: e.target.value === 'fewer_than' ? 'fewer_than' : 'at_least',
                  })
                }
              >
                <option value="at_least">at least</option>
                <option value="fewer_than">fewer than</option>
              </Select>
            )}
          </Field>
          <Field id={`${id}-count`} label="Orders">
            {(aria) => (
              <Input
                {...aria}
                type="number"
                min={1}
                max={10000}
                value={String(c.count)}
                onChange={(e) => onChange({ ...c, count: Number(e.target.value) || 1 })}
              />
            )}
          </Field>
          <DaysField id={id} days={c.days} onChange={(days) => onChange({ ...c, days })} />
          <StoreField
            id={id}
            stores={stores}
            storeId={c.storeId}
            onChange={(storeId) => onChange({ ...c, storeId })}
          />
        </div>
      );
    case 'spend':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${id}-op`} label="Spent">
            {(aria) => (
              <Select
                {...aria}
                value={c.op}
                onChange={(e) =>
                  onChange({ ...c, op: e.target.value === 'less_than' ? 'less_than' : 'at_least' })
                }
              >
                <option value="at_least">at least</option>
                <option value="less_than">less than</option>
              </Select>
            )}
          </Field>
          <Field id={`${id}-currency`} label="Currency">
            {(aria) => (
              <Select
                {...aria}
                value={c.currency}
                onChange={(e) => onChange({ ...c, currency: e.target.value, amountMinor: 0 })}
              >
                {/* A saved condition keeps its currency after the last order in it goes. */}
                {(orderCurrencies.includes(c.currency)
                  ? orderCurrencies
                  : [c.currency, ...orderCurrencies]
                ).map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <AmountField
            key={c.currency}
            id={id}
            currency={c.currency}
            amountMinor={c.amountMinor}
            onChange={(amountMinor) => onChange({ ...c, amountMinor })}
          />
          <DaysField id={id} days={c.days} onChange={(days) => onChange({ ...c, days })} />
          <StoreField
            id={id}
            stores={stores}
            storeId={c.storeId}
            onChange={(storeId) => onChange({ ...c, storeId })}
          />
        </div>
      );
  }
}
