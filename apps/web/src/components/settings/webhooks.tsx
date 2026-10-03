'use client';
import { useId, useState } from 'react';
import { Alert, Button, Checkbox, Field, Input, Label, Select } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import {
  WEBHOOK_EVENT_INFO,
  WEBHOOK_EVENT_KEYS,
  WEBHOOK_LIMITS,
  WEBHOOK_MESSAGE_STATUS_LABELS,
  WEBHOOK_MESSAGE_STATUSES,
  WEBHOOK_REPLAY_PERIODS,
  webhookReplaySummary,
  type WebhookEventType,
  type WebhookMessageStatus,
  type WebhookReplayPeriod,
} from '@w360/domain/webhook-model';
import {
  createWebhookEndpointAction,
  deleteWebhookEndpointAction,
  replayFailedWebhookDeliveriesAction,
  replayWebhookDeliveryAction,
  rotateWebhookSecretAction,
  sendWebhookTestAction,
  setWebhookEndpointEnabledAction,
  updateWebhookEndpointAction,
} from '@/app/actions/webhooks';
import { ActionFailure, type ActionFailureState } from '@/components/action-failure';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormSuccess } from '@/components/form-status';
import { CopyField } from '@/components/growth/copy-field';

/**
 * An endpoint's signing secret, right after it was created or rotated. It lives only in this
 * component's memory: it is not stored anywhere in the browser and cannot be shown again.
 */
function NewSecret({
  secret,
  heading,
  onDone,
}: {
  secret: string;
  heading: string;
  onDone: () => void;
}) {
  return (
    <div className="grid gap-3 rounded-md border border-border bg-muted/30 p-3">
      <Alert tone="warning" title={heading}>
        Copy the signing secret now and store it where your receiver can read it: it checks the{' '}
        <code className="font-mono text-xs">W360-Signature</code> header with it. The secret is not
        shown again, to anyone; if it is lost, rotate it.
      </Alert>
      <CopyField label="Signing secret" value={secret} />
      <div>
        <ClientButton size="sm" variant="outline" onClick={onDone}>
          I have stored the secret
        </ClientButton>
      </div>
    </div>
  );
}

/** The statuses an endpoint takes of `message.status` (ADR-119), shown while it takes the event. */
function StatusChoices({
  prefix,
  chosen,
  onChange,
}: {
  prefix: string;
  chosen: WebhookMessageStatus[];
  onChange: (next: WebhookMessageStatus[]) => void;
}) {
  return (
    <fieldset className="ml-6 grid gap-1">
      <legend className="mb-1 text-xs text-muted-foreground">
        Statuses sent (all of them unless you untick some)
      </legend>
      {WEBHOOK_MESSAGE_STATUSES.map((status) => {
        const id = `${prefix}-status-${status}`;
        return (
          <div key={status} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={chosen.includes(status)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? WEBHOOK_MESSAGE_STATUSES.filter((s) => s === status || chosen.includes(s))
                    : chosen.filter((s) => s !== status),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {WEBHOOK_MESSAGE_STATUS_LABELS[status]}{' '}
              <span className="font-mono text-xs">({status})</span>
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

function EventChoices({
  prefix,
  chosen,
  onChange,
  statuses,
  onStatusesChange,
}: {
  prefix: string;
  chosen: WebhookEventType[];
  onChange: (next: WebhookEventType[]) => void;
  statuses: WebhookMessageStatus[];
  onStatusesChange: (next: WebhookMessageStatus[]) => void;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Events</legend>
      {WEBHOOK_EVENT_KEYS.map((type) => {
        const id = `${prefix}-event-${type}`;
        const info = WEBHOOK_EVENT_INFO[type];
        return (
          <div key={type} className="grid gap-2">
            <div className="flex items-start gap-2">
              <Checkbox
                id={id}
                className="mt-0.5"
                checked={chosen.includes(type)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...chosen, type] : chosen.filter((t) => t !== type))
                }
              />
              <Label htmlFor={id} className="grid gap-0.5 font-normal">
                <span className="font-medium">
                  {info.label} <span className="font-mono text-xs">({type})</span>
                </span>
                <span className="text-xs text-muted-foreground">{info.description}</span>
              </Label>
            </div>
            {type === 'message.status' && chosen.includes(type) ? (
              <StatusChoices prefix={prefix} chosen={statuses} onChange={onStatusesChange} />
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}

interface HeaderRow {
  name: string;
  value: string;
}

/**
 * The headers an endpoint sends (ADR-118), as entered here: values never come back from the
 * server, so a change gives every header again.
 */
function HeaderRows({
  prefix,
  rows,
  onChange,
}: {
  prefix: string;
  rows: HeaderRow[];
  onChange: (next: HeaderRow[]) => void;
}) {
  const set = (index: number, row: Partial<HeaderRow>) =>
    onChange(rows.map((r, i) => (i === index ? { ...r, ...row } : r)));
  return (
    <div className="grid gap-3">
      {rows.map((row, i) => (
        <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_2fr_auto]">
          <Field id={`${prefix}-header-${i}-name`} label={`Header ${i + 1} name`}>
            {(aria) => (
              <Input
                {...aria}
                maxLength={60}
                autoComplete="off"
                placeholder="Authorization"
                value={row.name}
                onChange={(e) => set(i, { name: e.target.value })}
              />
            )}
          </Field>
          <Field id={`${prefix}-header-${i}-value`} label={`Header ${i + 1} value`}>
            {(aria) => (
              <Input
                {...aria}
                type="password"
                maxLength={WEBHOOK_LIMITS.headerValueLength}
                autoComplete="new-password"
                value={row.value}
                onChange={(e) => set(i, { value: e.target.value })}
              />
            )}
          </Field>
          <ClientButton
            size="sm"
            variant="outline"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            Remove<span className="sr-only"> header {i + 1}</span>
          </ClientButton>
        </div>
      ))}
      {rows.length < WEBHOOK_LIMITS.headers ? (
        <div>
          <ClientButton
            size="sm"
            variant="outline"
            onClick={() => onChange([...rows, { name: '', value: '' }])}
          >
            Add a header
          </ClientButton>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Adds an endpoint, or edits one (`endpoint` given). A new endpoint's secret is shown here once,
 * and stays on screen after the list updates.
 */
export function WebhookEndpointForm({
  slug,
  endpoint,
  atLimit = false,
}: {
  slug: string;
  endpoint?: {
    id: string;
    url: string;
    description: string | null;
    eventTypes: WebhookEventType[];
    headerNames: string[];
    messageStatuses: WebhookMessageStatus[] | null;
  };
  atLimit?: boolean;
}) {
  const prefix = useId();
  const [url, setUrl] = useState(endpoint?.url ?? '');
  const [description, setDescription] = useState(endpoint?.description ?? '');
  const [eventTypes, setEventTypes] = useState<WebhookEventType[]>(endpoint?.eventTypes ?? []);
  const [statuses, setStatuses] = useState<WebhookMessageStatus[]>(
    endpoint?.messageStatuses ?? [...WEBHOOK_MESSAGE_STATUSES],
  );
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  // Changing an endpoint keeps its headers unless they are given again.
  const [replaceHeaders, setReplaceHeaders] = useState(false);
  const [error, setError] = useState<ActionFailureState | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  if (secret) {
    return <NewSecret secret={secret} heading="Endpoint added" onDone={() => setSecret(null)} />;
  }
  if (!endpoint && atLimit) {
    return (
      <p className="text-sm text-muted-foreground">
        The company has {WEBHOOK_LIMITS.endpoints} webhook endpoints, the most it can have. Delete
        one you no longer use to add another.
      </p>
    );
  }
  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(null);
        // Every status ticked takes every status, including statuses added later (null).
        const messageStatuses =
          eventTypes.includes('message.status') && statuses.length < WEBHOOK_MESSAGE_STATUSES.length
            ? statuses
            : null;
        const input = { url, description, eventTypes, messageStatuses };
        const done = (r: { ok: true } | { ok: false; code: string; message: string }) => {
          setBusy(false);
          if (!r.ok) setError(r);
        };
        if (endpoint) {
          void updateWebhookEndpointAction(slug, {
            ...input,
            endpointId: endpoint.id,
            ...(replaceHeaders ? { headers } : {}),
          }).then((r) => {
            done(r);
            if (r.ok) {
              setSaved('Endpoint saved.');
              setHeaders([]);
              setReplaceHeaders(false);
            }
          });
        } else {
          void createWebhookEndpointAction(slug, { ...input, headers }).then((r) => {
            done(r);
            if (r.ok) {
              setSecret(r.data.secret);
              setUrl('');
              setDescription('');
              setEventTypes([]);
              setStatuses([...WEBHOOK_MESSAGE_STATUSES]);
              setHeaders([]);
            }
          });
        }
      }}
    >
      <ActionFailure failure={error} />
      <FormSuccess message={saved} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${prefix}-url`}
          label="Endpoint URL"
          description="An https:// address that accepts POST requests."
        >
          {(aria) => (
            <Input
              {...aria}
              type="url"
              required
              inputMode="url"
              maxLength={WEBHOOK_LIMITS.urlLength}
              autoComplete="off"
              placeholder="https://example.com/hooks/w360"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          )}
        </Field>
        <Field
          id={`${prefix}-description`}
          label="Description"
          description="Optional: what receives these events."
        >
          {(aria) => (
            <Input
              {...aria}
              maxLength={WEBHOOK_LIMITS.descriptionLength}
              autoComplete="off"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
      </div>
      <EventChoices
        prefix={prefix}
        chosen={eventTypes}
        onChange={setEventTypes}
        statuses={statuses}
        onStatusesChange={setStatuses}
      />
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Headers</legend>
        <p className="text-xs text-muted-foreground">
          Optional: up to {WEBHOOK_LIMITS.headers} headers your receiver asks for, such as an
          Authorization header it issued, sent with every delivery. Values are stored encrypted and
          never shown again.
        </p>
        {endpoint ? (
          <>
            <p className="text-sm">
              {endpoint.headerNames.length > 0
                ? `Sent now: ${endpoint.headerNames.join(', ')}.`
                : 'No headers are sent now.'}
            </p>
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${prefix}-replace-headers`}
                checked={replaceHeaders}
                onChange={(e) => {
                  setReplaceHeaders(e.target.checked);
                  setHeaders([]);
                }}
              />
              <Label htmlFor={`${prefix}-replace-headers`} className="font-normal">
                Replace the headers (give each one again; none removes them)
              </Label>
            </div>
            {replaceHeaders ? (
              <HeaderRows prefix={prefix} rows={headers} onChange={setHeaders} />
            ) : null}
          </>
        ) : (
          <HeaderRows prefix={prefix} rows={headers} onChange={setHeaders} />
        )}
      </fieldset>
      <div>
        <Button type="submit" disabled={busy || !url.trim() || eventTypes.length === 0}>
          {endpoint ? (busy ? 'Saving…' : 'Save endpoint') : busy ? 'Adding…' : 'Add endpoint'}
        </Button>
      </div>
    </ClientForm>
  );
}

/**
 * An endpoint's actions: a test event, rotating the secret (the new one is shown here once),
 * turning it off or on, and deleting it.
 */
export function WebhookEndpointActions({
  slug,
  endpointId,
  host,
  active,
}: {
  slug: string;
  endpointId: string;
  host: string;
  active: boolean;
}) {
  const [error, setError] = useState<ActionFailureState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  const run = (
    task: Promise<{ ok: true } | { ok: false; code: string; message: string }>,
    done?: string,
  ) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    void task.then((r) => {
      setBusy(false);
      if (!r.ok) setError(r);
      else if (done) setNotice(done);
    });
  };

  return (
    <div className="grid gap-2">
      {secret ? (
        <NewSecret
          secret={secret}
          heading={`New secret for ${host}`}
          onDone={() => setSecret(null)}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {active ? (
          <ClientButton
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(
                sendWebhookTestAction(slug, endpointId),
                'Test event queued. Its delivery appears in the history.',
              )
            }
          >
            Send test event<span className="sr-only"> to {host}</span>
          </ClientButton>
        ) : null}
        <ConfirmDialog
          trigger={
            <ClientButton size="sm" variant="outline" disabled={busy}>
              Rotate secret<span className="sr-only"> of {host}</span>
            </ClientButton>
          }
          title={`Rotate the secret of ${host}?`}
          description={`A new secret is created and shown once. For ${WEBHOOK_LIMITS.previousSecretHours} hours requests are signed with both, so your receiver can switch without losing events.`}
          confirmLabel="Rotate secret"
          onConfirm={() => {
            setBusy(true);
            setError(null);
            setNotice(null);
            void rotateWebhookSecretAction(slug, endpointId).then((r) => {
              setBusy(false);
              if (!r.ok) setError(r);
              else setSecret(r.data.secret);
            });
          }}
        />
        {active ? (
          <ConfirmDialog
            trigger={
              <ClientButton size="sm" variant="outline" disabled={busy}>
                Turn off<span className="sr-only"> {host}</span>
              </ClientButton>
            }
            title={`Turn off ${host}?`}
            description="No new events are sent to it, and deliveries waiting for a retry are marked failed. You can turn it on again and replay them."
            confirmLabel="Turn off"
            onConfirm={() =>
              run(setWebhookEndpointEnabledAction(slug, { endpointId, enabled: false }))
            }
          />
        ) : (
          <ClientButton
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(setWebhookEndpointEnabledAction(slug, { endpointId, enabled: true }))
            }
          >
            Turn on<span className="sr-only"> {host}</span>
          </ClientButton>
        )}
        <ConfirmDialog
          trigger={
            <ClientButton size="sm" variant="ghost" className="text-destructive" disabled={busy}>
              Delete<span className="sr-only"> {host}</span>
            </ClientButton>
          }
          title={`Delete ${host}?`}
          description="The endpoint and its delivery history are deleted. Events are no longer sent to it."
          confirmLabel="Delete endpoint"
          destructive
          onConfirm={() => run(deleteWebhookEndpointAction(slug, endpointId))}
        />
      </div>
      <ActionFailure failure={error} />
      <FormSuccess message={notice} />
    </div>
  );
}

/** Delivers a finished delivery's event again, as a new delivery. */
export function ReplayDeliveryButton({
  slug,
  deliveryId,
  label,
}: {
  slug: string;
  deliveryId: string;
  label: string;
}) {
  const [error, setError] = useState<ActionFailureState | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-1">
      <div>
        <ClientButton
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void replayWebhookDeliveryAction(slug, deliveryId).then((r) => {
              setBusy(false);
              if (!r.ok) setError(r);
            });
          }}
        >
          Replay<span className="sr-only"> {label}</span>
        </ClientButton>
      </div>
      <ActionFailure failure={error} />
    </div>
  );
}

/**
 * Replays the endpoint's failed deliveries from a chosen period, 500 at most at a time (ADR-095):
 * one new delivery per event whose deliveries all failed.
 */
export function ReplayFailedDeliveriesForm({
  slug,
  endpointId,
}: {
  slug: string;
  endpointId: string;
}) {
  const selectId = useId();
  const [period, setPeriod] = useState<WebhookReplayPeriod>('24h');
  const [error, setError] = useState<ActionFailureState | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm
      className="grid gap-2"
      aria-label="Replay failed deliveries"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setDone(null);
        void replayFailedWebhookDeliveriesAction(slug, endpointId, period).then((r) => {
          setBusy(false);
          if (r.ok) setDone(webhookReplaySummary(r.data));
          else setError(r);
        });
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <Label htmlFor={selectId}>Failed deliveries from</Label>
          <Select
            id={selectId}
            className="w-auto min-w-40"
            value={period}
            onChange={(event) => setPeriod(event.target.value as WebhookReplayPeriod)}
          >
            {WEBHOOK_REPLAY_PERIODS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={busy}>
          Replay failed deliveries
        </Button>
      </div>
      <FormSuccess message={done} />
      <ActionFailure failure={error} />
    </ClientForm>
  );
}
