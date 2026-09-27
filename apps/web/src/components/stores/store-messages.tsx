'use client';
import { useId, useMemo, useState } from 'react';
import { Alert, Badge, Button, Checkbox, Field, Input, Select } from '@w360/ui';
import type { StoreMessageRuleView, StoreMessageTemplateOption } from '@w360/domain';
import {
  ORDER_VALUE_FIELDS,
  ORDER_VALUE_LABELS,
  type OrderValueField,
  type StoreVariableSource,
  type StoreVariables,
} from '@w360/domain/store-messages-model';
import {
  saveStoreMessageRuleAction,
  saveStoreMessageSettingsAction,
} from '@/app/actions/store-messages';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

/** A store's message settings: the customers' opt-in confirmation, the sending window, test orders. */
export function StoreMessageSettingsForm({
  slug,
  storeId,
  optIn,
  optInNote,
  windowStart,
  windowEnd,
  testOrders,
  platform,
  timezone,
}: {
  slug: string;
  storeId: string;
  optIn: boolean;
  /** Who confirmed the opt-in and when, already formatted. */
  optInNote: string | null;
  windowStart: string;
  windowEnd: string;
  testOrders: boolean;
  platform: 'shopify' | 'woocommerce';
  timezone: string;
}) {
  const id = useId();
  const [state, setState] = useState({ optIn, windowStart, windowEnd, testOrders });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  return (
    <ClientForm
      aria-label="Message settings"
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(false);
        void saveStoreMessageSettingsAction(slug, { storeId, ...state }).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else setSaved(true);
        });
      }}
    >
      <div className="grid gap-1">
        <label htmlFor={`${id}-optin`} className="flex items-start gap-2 text-sm">
          <Checkbox
            id={`${id}-optin`}
            checked={state.optIn}
            onChange={(e) => setState({ ...state, optIn: e.target.checked })}
          />
          <span>
            This store’s customers agreed to receive order messages from us on WhatsApp (for example
            with a box at checkout that names our business).
          </span>
        </label>
        <p className="text-xs text-muted-foreground">
          Meta requires people’s agreement before businesses message them first. HyFib cannot see
          your checkout, so a manager confirms it here. Unticking it switches every message off.
          {optInNote ? ` ${optInNote}` : ''}
        </p>
      </div>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Sending hours</legend>
        <p className="text-xs text-muted-foreground">
          Messages due outside these hours wait until they begin ({timezone}). Leave both empty to
          send at any time.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Field id={`${id}-start`} label="From">
            {(aria) => (
              <Input
                {...aria}
                type="time"
                value={state.windowStart}
                onChange={(e) => setState({ ...state, windowStart: e.target.value })}
                className="w-32"
              />
            )}
          </Field>
          <Field id={`${id}-end`} label="Until">
            {(aria) => (
              <Input
                {...aria}
                type="time"
                value={state.windowEnd}
                onChange={(e) => setState({ ...state, windowEnd: e.target.value })}
                className="w-32"
              />
            )}
          </Field>
        </div>
      </fieldset>
      {platform === 'shopify' ? (
        <label htmlFor={`${id}-test`} className="flex items-start gap-2 text-sm">
          <Checkbox
            id={`${id}-test`}
            checked={state.testOrders}
            onChange={(e) => setState({ ...state, testOrders: e.target.checked })}
          />
          <span>Also message about Shopify test orders (to try the messages out).</span>
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </Button>
        <FormSuccess message={saved ? 'Settings saved.' : null} />
      </div>
      <FormError message={error} />
    </ClientForm>
  );
}

interface ChannelOption {
  id: string;
  whatsappAccountId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  status: string;
}

const channelLabel = (c: ChannelOption) =>
  [c.verifiedName, c.displayPhoneNumber].filter(Boolean).join(' · ') || 'WhatsApp number';

/** Keeps a mapping the size of the template's variables, keeping what was chosen so far. */
function sized(sources: StoreVariableSource[], count: number): StoreVariableSource[] {
  const next = sources.slice(0, count);
  while (next.length < count) next.push({ source: 'order', field: 'order_name' });
  return next;
}

/** One event's message: switched on or off, the number and template, variables, delay, buttons. */
export function StoreMessageRuleForm({
  slug,
  storeId,
  rule,
  channels,
  templates,
}: {
  slug: string;
  storeId: string;
  rule: StoreMessageRuleView;
  channels: ChannelOption[];
  templates: StoreMessageTemplateOption[];
}) {
  const id = useId();
  const active = channels.filter((c) => c.status === 'active' || c.id === rule.channelAccountId);
  const [enabled, setEnabled] = useState(rule.enabled);
  const [channelId, setChannelId] = useState(rule.channelAccountId ?? active[0]?.id ?? '');
  const channel = channels.find((c) => c.id === channelId);
  const usable = useMemo(
    () => templates.filter((t) => t.whatsappAccountId === channel?.whatsappAccountId),
    [templates, channel?.whatsappAccountId],
  );
  const [templateId, setTemplateId] = useState(rule.templateId ?? '');
  const template = usable.find((t) => t.id === templateId) ?? null;
  const [variables, setVariables] = useState<StoreVariables>(rule.variables);
  const [delay, setDelay] = useState(String(rule.delayMinutes));
  const [confirmButton, setConfirmButton] = useState(
    rule.confirmButton === null ? '' : String(rule.confirmButton),
  );
  const [cancelButton, setCancelButton] = useState(
    rule.cancelButton === null ? '' : String(rule.cancelButton),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const cod = rule.event === 'cod_confirmation';
  const header = template ? sized(variables.header, template.headerParams) : [];
  const body = template ? sized(variables.body, template.bodyParams) : [];

  if (!rule.available) {
    return (
      <p className="text-sm text-muted-foreground">
        Not available for this store: WooCommerce has no delivered status.
      </p>
    );
  }

  return (
    <ClientForm
      aria-label={rule.label}
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(false);
        void saveStoreMessageRuleAction(slug, {
          storeId,
          event: rule.event,
          enabled,
          channelAccountId: channelId || null,
          templateId: template ? template.id : null,
          variables: { header, body },
          delayMinutes: Number.parseInt(delay, 10) || 0,
          confirmButton: cod && confirmButton !== '' ? Number(confirmButton) : null,
          cancelButton: cod && cancelButton !== '' ? Number(cancelButton) : null,
          version: rule.version,
        }).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else setSaved(true);
        });
      }}
    >
      {rule.problem ? <Alert tone="warning">{rule.problem}</Alert> : null}
      <label htmlFor={`${id}-enabled`} className="flex items-center gap-2 text-sm font-medium">
        <Checkbox
          id={`${id}-enabled`}
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Send this message
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${id}-channel`} label="WhatsApp number">
          {(aria) => (
            <Select
              {...aria}
              value={channelId}
              onChange={(e) => {
                setChannelId(e.target.value);
                setTemplateId('');
              }}
            >
              {active.length === 0 ? <option value="">No active number</option> : null}
              {active.map((c) => (
                <option key={c.id} value={c.id}>
                  {channelLabel(c)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          id={`${id}-template`}
          label="Template"
          description="Approved utility or marketing templates of this number’s account."
        >
          {(aria) => (
            <Select {...aria} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Choose a template</option>
              {usable.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.language}, {t.category === 'MARKETING' ? 'marketing' : 'utility'})
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {template ? (
        <div className="grid gap-3">
          <p className="rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">{template.preview}</p>
          {template.category === 'MARKETING' ? (
            <Alert tone="info">
              A marketing template is sent only to customers who opted in to marketing messages when
              the company requires it (Settings → Consent).
            </Alert>
          ) : null}
          {header.map((source, i) => (
            <VariableInput
              key={`h${i}`}
              id={`${id}-h${i}`}
              label="Header variable"
              source={source}
              onChange={(next) =>
                setVariables({ header: header.map((s, j) => (j === i ? next : s)), body })
              }
            />
          ))}
          {body.map((source, i) => (
            <VariableInput
              key={`b${i}`}
              id={`${id}-b${i}`}
              label={`Variable {{${i + 1}}}`}
              source={source}
              onChange={(next) =>
                setVariables({ header, body: body.map((s, j) => (j === i ? next : s)) })
              }
            />
          ))}
          {cod ? (
            template.quickReplies.length < 2 ? (
              <Alert tone="warning">
                This message needs a template with two quick reply buttons (for example “Confirm
                order” and “Cancel order”).
              </Alert>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id={`${id}-confirm`} label="Button that confirms the order">
                  {(aria) => (
                    <Select
                      {...aria}
                      value={confirmButton}
                      onChange={(e) => setConfirmButton(e.target.value)}
                    >
                      <option value="">Choose a button</option>
                      {template.quickReplies.map((b) => (
                        <option key={b.index} value={String(b.index)}>
                          {b.text}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field id={`${id}-cancel`} label="Button that cancels it">
                  {(aria) => (
                    <Select
                      {...aria}
                      value={cancelButton}
                      onChange={(e) => setCancelButton(e.target.value)}
                    >
                      <option value="">Choose a button</option>
                      {template.quickReplies.map((b) => (
                        <option key={b.index} value={String(b.index)}>
                          {b.text}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
            )
          ) : null}
        </div>
      ) : templateId && rule.templateId === templateId ? (
        <Alert tone="warning">
          The saved template is no longer approved or cannot be sent. Choose another.
        </Alert>
      ) : null}
      <Field
        id={`${id}-delay`}
        label="Wait before sending (minutes)"
        description="Counted from when it happened in the store; 0 sends as soon as HyFib sees it."
      >
        {(aria) => (
          <Input
            {...aria}
            type="number"
            min={0}
            max={1440}
            inputMode="numeric"
            value={delay}
            onChange={(e) => setDelay(e.target.value)}
            className="w-32"
          />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        {rule.enabled ? <Badge tone="success">On</Badge> : <Badge tone="neutral">Off</Badge>}
        <FormSuccess message={saved ? 'Saved.' : null} />
      </div>
      <FormError message={error} />
    </ClientForm>
  );
}

function VariableInput({
  id,
  label,
  source,
  onChange,
}: {
  id: string;
  label: string;
  source: StoreVariableSource;
  onChange: (next: StoreVariableSource) => void;
}) {
  return (
    <fieldset className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-end">
      <legend className="sr-only">{label}</legend>
      <Field id={`${id}-source`} label={label}>
        {(aria) => (
          <Select
            {...aria}
            value={source.source === 'static' ? 'static' : source.field}
            onChange={(e) =>
              onChange(
                e.target.value === 'static'
                  ? { source: 'static', value: '' }
                  : { source: 'order', field: e.target.value as OrderValueField },
              )
            }
          >
            {ORDER_VALUE_FIELDS.map((f) => (
              <option key={f} value={f}>
                {ORDER_VALUE_LABELS[f]}
              </option>
            ))}
            <option value="static">Same text for every order</option>
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
      ) : (
        <Field
          id={`${id}-fallback`}
          label="If the order has none, use"
          description="Leave empty to skip orders without a value."
        >
          {(aria) => (
            <Input
              {...aria}
              value={source.fallback ?? ''}
              maxLength={200}
              onChange={(e) =>
                onChange({
                  source: 'order',
                  field: source.field,
                  ...(e.target.value ? { fallback: e.target.value } : {}),
                })
              }
            />
          )}
        </Field>
      )}
    </fieldset>
  );
}
