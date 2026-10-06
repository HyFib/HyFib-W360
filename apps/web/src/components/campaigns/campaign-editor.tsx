'use client';
import { useMemo, useState, useTransition } from 'react';
import type { RenderedTemplate } from '@w360/domain/template-definition';
import { Button, Checkbox, Field, Input, Select } from '@w360/ui';
import { updateCampaignAction } from '@/app/actions/campaigns';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';
import {
  SegmentBuilder,
  type BuilderField,
  type BuilderStore,
  type Definition,
} from '@/components/segments/segment-builder';
import type { SendableTemplate, SenderChannel } from '@/components/templates/template-sender';
import { TemplatePreview } from '@/components/templates/template-preview';

/** How a variable is filled (mirrors the domain's campaign variable schema). */
type Source =
  | { source: 'static'; value: string }
  | { source: 'name'; fallback: string }
  | { source: 'field'; key: string; fallback?: string };

export interface EditableCampaign {
  id: string;
  version: number;
  name: string;
  channelAccountId: string | null;
  templateId: string | null;
  /** `buttons`: the ends of the template's links that take a value (ADR-229). */
  variables: { header: Source[]; body: Source[]; buttons: Source[] };
  segmentId: string | null;
  audienceDefinition: Definition | null;
  timezone: string;
  scheduleKind: 'now' | 'later';
  /** 'YYYY-MM-DDTHH:MM' or ''. */
  scheduledLocal: string;
  windowStart: string;
  windowEnd: string;
  ratePerMinute: number | null;
  maxMessages: number | null;
  budgetAmount: string;
  budgetCurrency: string | null;
  stopAfterHours: number;
}

function fill(text: string, values: string[]): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n: string) => values[Number(n) - 1] || m);
}

function describe(source: Source | undefined, fields: BuilderField[]): string {
  if (!source) return '';
  if (source.source === 'static') return source.value;
  if (source.source === 'name') return `[name, or “${source.fallback}”]`;
  const label = fields.find((f) => f.key === source.key)?.label ?? source.key;
  return source.fallback ? `[${label}, or “${source.fallback}”]` : `[${label}]`;
}

function resize(list: Source[], length: number): Source[] {
  return Array.from({ length }, (_, i) => list[i] ?? { source: 'static', value: '' });
}

/**
 * Draft editor. Everything is checked again by the server; the review panel on the page shows
 * what submitting would do.
 */
export function CampaignEditor({
  slug,
  campaign,
  channels,
  templates,
  segments,
  fields,
  campaigns,
  stores,
  orderCurrencies,
  timezones,
  currencies,
}: {
  slug: string;
  campaign: EditableCampaign;
  channels: SenderChannel[];
  templates: SendableTemplate[];
  segments: { id: string; name: string }[];
  fields: BuilderField[];
  campaigns: { id: string; name: string }[];
  /** For audience conditions on store orders (ADR-231). */
  stores: BuilderStore[];
  orderCurrencies: string[];
  timezones: string[];
  currencies: string[];
}) {
  const [c, setC] = useState(campaign);
  const [audienceKind, setAudienceKind] = useState<'segment' | 'conditions'>(
    campaign.audienceDefinition || segments.length === 0 ? 'conditions' : 'segment',
  );
  const [definition, setDefinition] = useState<Definition>(
    campaign.audienceDefinition ?? {
      match: 'all',
      conditions: [{ type: 'tag', op: 'has', tag: '' }],
    },
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, startTransition] = useTransition();

  const update = (patch: Partial<EditableCampaign>) => {
    setSaved(false);
    setC((prev) => ({ ...prev, ...patch }));
  };
  const channel = channels.find((x) => x.id === c.channelAccountId);
  const available = useMemo(
    () => templates.filter((t) => t.whatsappAccountId === channel?.whatsappAccountId),
    [templates, channel],
  );
  const template = available.find((t) => t.id === c.templateId);
  const header = resize(c.variables.header, template?.headerParams ?? 0);
  const body = resize(c.variables.body, template?.bodyParams ?? 0);
  const buttons = resize(c.variables.buttons, template?.links.length ?? 0);
  const preview: RenderedTemplate | null = template
    ? {
        ...template.preview,
        header: template.preview.header
          ? fill(
              template.preview.header,
              header.map((s) => describe(s, fields)),
            )
          : null,
        body: fill(
          template.preview.body,
          body.map((s) => describe(s, fields)),
        ),
        // Each link that takes a value, ending with what fills it.
        buttons: template.preview.buttons.map((b, index) => {
          const i = template.links.findIndex((link) => link.index === index);
          const link = template.links[i];
          return link
            ? { ...b, url: `${link.url.slice(0, -'{{1}}'.length)}${describe(buttons[i], fields)}` }
            : b;
        }),
      }
    : null;
  const setVariable = (part: 'header' | 'body' | 'buttons', index: number, source: Source) => {
    const next = { header: [...header], body: [...body], buttons: [...buttons] };
    next[part][index] = source;
    update({ variables: next });
  };

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    // The action refreshes the page on the server (the review below comes with its response); the
    // result is set inside the transition so the message appears together with that render.
    startTransition(async () => {
      try {
        const result = await updateCampaignAction(slug, c.id, {
          expectedVersion: c.version,
          name: c.name,
          channelAccountId: c.channelAccountId,
          templateId: template ? template.id : null,
          variables: { header, body, buttons },
          audience:
            audienceKind === 'segment'
              ? c.segmentId
                ? { kind: 'segment', segmentId: c.segmentId }
                : { kind: 'none' }
              : { kind: 'conditions', definition },
          schedule: {
            kind: c.scheduleKind,
            ...(c.scheduleKind === 'later' ? { local: c.scheduledLocal } : {}),
            timezone: c.timezone,
          },
          window: c.windowStart && c.windowEnd ? { start: c.windowStart, end: c.windowEnd } : null,
          ratePerMinute: c.ratePerMinute,
          maxMessages: c.maxMessages,
          budget:
            c.budgetCurrency && c.budgetAmount
              ? { amount: c.budgetAmount, currency: c.budgetCurrency }
              : null,
          stopAfterHours: c.stopAfterHours,
        });
        startTransition(() => {
          if (!result.ok) setError(result.message);
          else {
            setSaved(true);
            setC((prev) => ({ ...prev, version: prev.version + 1 }));
          }
        });
      } catch {
        startTransition(() =>
          setError('The draft could not be saved because the connection failed. Try again.'),
        );
      }
    });
  }

  return (
    <ClientForm onSubmit={submit} className="grid gap-6">
      <FormError message={error} />
      <FormSuccess message={saved ? 'Draft saved. The review below is updated.' : null} />
      <Field id="cmp-name" label="Campaign name">
        {(aria) => (
          <Input
            {...aria}
            value={c.name}
            required
            maxLength={120}
            onChange={(e) => update({ name: e.target.value })}
          />
        )}
      </Field>

      <fieldset className="grid gap-4">
        <legend className="mb-2 text-base font-semibold">Message</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="cmp-channel" label="Send from">
            {(aria) => (
              <Select
                {...aria}
                value={c.channelAccountId ?? ''}
                onChange={(e) =>
                  update({ channelAccountId: e.target.value || null, templateId: null })
                }
              >
                <option value="">Choose a WhatsApp number</option>
                {channels.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            id="cmp-template"
            label="Template"
            description={
              channel && available.length === 0
                ? 'No approved template for this number’s account yet.'
                : undefined
            }
          >
            {(aria) => (
              <Select
                {...aria}
                value={template?.id ?? ''}
                disabled={!channel}
                onChange={(e) =>
                  update({
                    templateId: e.target.value || null,
                    variables: { header: [], body: [], buttons: [] },
                  })
                }
              >
                <option value="">Choose an approved template</option>
                {available.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.language}, {t.category.toLowerCase()})
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {template ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="grid gap-3">
              {[
                ...header.map((s, i) => ({ part: 'header' as const, index: i, source: s })),
                ...body.map((s, i) => ({ part: 'body' as const, index: i, source: s })),
                ...buttons.map((s, i) => ({ part: 'buttons' as const, index: i, source: s })),
              ].map(({ part, index, source }) => (
                <VariableInput
                  key={`${part}-${index}`}
                  id={`cmp-var-${part}-${index}`}
                  label={
                    part === 'buttons'
                      ? `End of the “${template.links[index]?.text ?? ''}” link`
                      : `${part === 'header' ? 'Header' : 'Body'} variable {{${index + 1}}}`
                  }
                  source={source}
                  fields={fields}
                  onChange={(next) => setVariable(part, index, next)}
                />
              ))}
              {header.length + body.length + buttons.length === 0 ? (
                <p className="text-sm text-muted-foreground">This template has no variables.</p>
              ) : null}
            </div>
            {preview ? (
              <TemplatePreview rendered={preview} label="Campaign message preview" />
            ) : null}
          </div>
        ) : null}
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="mb-2 text-base font-semibold">Audience</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="cmp-audience"
              checked={audienceKind === 'segment'}
              disabled={segments.length === 0}
              onChange={() => {
                setSaved(false);
                setAudienceKind('segment');
              }}
            />
            A saved segment
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="cmp-audience"
              checked={audienceKind === 'conditions'}
              onChange={() => {
                setSaved(false);
                setAudienceKind('conditions');
              }}
            />
            Conditions for this campaign
          </label>
        </div>
        {audienceKind === 'segment' ? (
          <Field id="cmp-segment" label="Segment">
            {(aria) => (
              <Select
                {...aria}
                value={c.segmentId ?? ''}
                onChange={(e) => update({ segmentId: e.target.value || null })}
              >
                <option value="">Choose a segment</option>
                {segments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : (
          <SegmentBuilder
            slug={slug}
            value={definition}
            onChange={(next) => {
              setSaved(false);
              setDefinition(next);
            }}
            fields={fields}
            campaigns={campaigns.filter((x) => x.id !== c.id)}
            stores={stores}
            orderCurrencies={orderCurrencies}
            idPrefix="cmp-seg"
          />
        )}
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="mb-2 text-base font-semibold">Schedule</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field id="cmp-when" label="When">
            {(aria) => (
              <Select
                {...aria}
                value={c.scheduleKind}
                onChange={(e) =>
                  update({ scheduleKind: e.target.value === 'later' ? 'later' : 'now' })
                }
              >
                <option value="now">As soon as it is ready</option>
                <option value="later">At a date and time</option>
              </Select>
            )}
          </Field>
          {c.scheduleKind === 'later' ? (
            <Field id="cmp-at" label="Date and time">
              {(aria) => (
                <Input
                  {...aria}
                  type="datetime-local"
                  value={c.scheduledLocal}
                  onChange={(e) => update({ scheduledLocal: e.target.value })}
                />
              )}
            </Field>
          ) : null}
          <Field
            id="cmp-tz"
            label="Time zone"
            description="Daylight-saving changes are handled; see the review."
          >
            {(aria) => (
              <Select
                {...aria}
                value={c.timezone}
                onChange={(e) => update({ timezone: e.target.value })}
              >
                {timezones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <label htmlFor="cmp-window" className="flex items-center gap-2 text-sm">
          <Checkbox
            id="cmp-window"
            checked={Boolean(c.windowStart && c.windowEnd)}
            onChange={(e) =>
              update(
                e.target.checked
                  ? { windowStart: '09:00', windowEnd: '20:00' }
                  : { windowStart: '', windowEnd: '' },
              )
            }
          />
          Only send during certain hours
        </label>
        {c.windowStart && c.windowEnd ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="cmp-window-start" label="From">
              {(aria) => (
                <Input
                  {...aria}
                  type="time"
                  value={c.windowStart}
                  onChange={(e) => update({ windowStart: e.target.value })}
                />
              )}
            </Field>
            <Field id="cmp-window-end" label="Until">
              {(aria) => (
                <Input
                  {...aria}
                  type="time"
                  value={c.windowEnd}
                  onChange={(e) => update({ windowEnd: e.target.value })}
                />
              )}
            </Field>
          </div>
        ) : null}
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="mb-2 text-base font-semibold">Pacing and limits</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            id="cmp-rate"
            label="Messages per minute (optional)"
            description="Lower than the number’s sending rate."
          >
            {(aria) => (
              <Input
                {...aria}
                type="number"
                min={1}
                max={6000}
                value={c.ratePerMinute ?? ''}
                onChange={(e) =>
                  update({ ratePerMinute: e.target.value ? Number(e.target.value) : null })
                }
              />
            )}
          </Field>
          <Field id="cmp-max" label="Message cap (optional)">
            {(aria) => (
              <Input
                {...aria}
                type="number"
                min={1}
                value={c.maxMessages ?? ''}
                onChange={(e) =>
                  update({ maxMessages: e.target.value ? Number(e.target.value) : null })
                }
              />
            )}
          </Field>
          <Field id="cmp-stop" label="Stop sending after (hours)">
            {(aria) => (
              <Input
                {...aria}
                type="number"
                min={1}
                max={168}
                value={c.stopAfterHours}
                onChange={(e) => update({ stopAfterHours: Number(e.target.value) || 24 })}
              />
            )}
          </Field>
        </div>
        {currencies.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="cmp-budget"
              label="Estimated spending cap (optional)"
              description="Meta bills you directly; sending pauses before the estimated Meta cost passes this amount."
            >
              {(aria) => (
                <Input
                  {...aria}
                  inputMode="decimal"
                  value={c.budgetAmount}
                  onChange={(e) =>
                    update({
                      budgetAmount: e.target.value,
                      budgetCurrency: c.budgetCurrency ?? currencies[0] ?? null,
                    })
                  }
                />
              )}
            </Field>
            <Field id="cmp-budget-currency" label="Currency">
              {(aria) => (
                <Select
                  {...aria}
                  value={c.budgetCurrency ?? currencies[0]}
                  onChange={(e) => update({ budgetCurrency: e.target.value })}
                >
                  {currencies.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Spending caps need a published Meta rate card; none is available yet.
          </p>
        )}
      </fieldset>

      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save draft'}
        </Button>
      </div>
    </ClientForm>
  );
}

function VariableInput({
  id,
  label,
  source,
  fields,
  onChange,
}: {
  id: string;
  label: string;
  source: Source;
  fields: BuilderField[];
  onChange: (next: Source) => void;
}) {
  return (
    <fieldset className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[11rem_minmax(0,1fr)_minmax(0,1fr)] sm:items-end">
      <legend className="sr-only">{label}</legend>
      <Field id={`${id}-source`} label={label}>
        {(aria) => (
          <Select
            {...aria}
            value={source.source}
            onChange={(e) =>
              onChange(
                e.target.value === 'name'
                  ? { source: 'name', fallback: 'there' }
                  : e.target.value === 'field'
                    ? { source: 'field', key: fields[0]?.key ?? '' }
                    : { source: 'static', value: '' },
              )
            }
          >
            <option value="static">Same text for everyone</option>
            <option value="name">Contact name</option>
            {fields.length > 0 ? <option value="field">Custom field</option> : null}
          </Select>
        )}
      </Field>
      {source.source === 'static' ? (
        <Field id={`${id}-value`} label="Text">
          {(aria) => (
            <Input
              {...aria}
              value={source.value}
              maxLength={1000}
              onChange={(e) => onChange({ ...source, value: e.target.value })}
            />
          )}
        </Field>
      ) : source.source === 'field' ? (
        <Field id={`${id}-field`} label="Field">
          {(aria) => (
            <Select
              {...aria}
              value={source.key}
              onChange={(e) => onChange({ ...source, key: e.target.value })}
            >
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : (
        <span />
      )}
      {source.source !== 'static' ? (
        <Field
          id={`${id}-fallback`}
          label="If empty, use"
          description={
            source.source === 'field' ? 'Leave empty to skip contacts without a value.' : undefined
          }
        >
          {(aria) => (
            <Input
              {...aria}
              value={source.fallback ?? ''}
              maxLength={200}
              onChange={(e) => onChange({ ...source, fallback: e.target.value })}
            />
          )}
        </Field>
      ) : null}
    </fieldset>
  );
}
