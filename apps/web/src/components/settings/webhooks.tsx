'use client';
import { useId, useState } from 'react';
import { Alert, Button, Checkbox, Field, Input, Label, Select } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import {
  WEBHOOK_CAMPAIGN_STATUS_LABELS,
  WEBHOOK_CAMPAIGN_STATUSES,
  WEBHOOK_CONTACT_PART_LABELS,
  WEBHOOK_CONTACT_PARTS,
  WEBHOOK_CONVERSATION_STATUS_LABELS,
  WEBHOOK_CONVERSATION_STATUSES,
  WEBHOOK_EVENT_INFO,
  WEBHOOK_EVENT_KEYS,
  WEBHOOK_FAILURE_KINDS,
  WEBHOOK_FAILURE_LABELS,
  WEBHOOK_LIMITS,
  WEBHOOK_MESSAGE_STATUS_LABELS,
  WEBHOOK_MESSAGE_STATUSES,
  WEBHOOK_ORDER_STATUS_LABELS,
  WEBHOOK_ORDER_STATUSES,
  WEBHOOK_REPLAY_PERIODS,
  WEBHOOK_RUN_END_STATUS_LABELS,
  WEBHOOK_RUN_END_STATUSES,
  WEBHOOK_TEMPLATE_STATUS_LABELS,
  WEBHOOK_TEMPLATE_STATUSES,
  webhookChannelText,
  webhookReplayAllSummary,
  webhookReplaySummary,
  webhookTakesAutomationRuns,
  webhookTakesChannelEvents,
  type WebhookAutomationChoice,
  type WebhookCampaignStatus,
  type WebhookChannelChoice,
  type WebhookContactPart,
  type WebhookConversationStatus,
  type WebhookEventType,
  type WebhookFailureKind,
  type WebhookMessageStatus,
  type WebhookOrderStatus,
  type WebhookReplayPeriod,
  type WebhookRunEndStatus,
  type WebhookTemplateStatus,
} from '@w360/domain/webhook-model';
import {
  createWebhookEndpointAction,
  deleteWebhookEndpointAction,
  replayAllFailedWebhookDeliveriesAction,
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

/**
 * The statuses a campaign (`campaign.status_changed`, ADR-146), an order
 * (`order.status_changed`, ADR-147), a template (`template.status_changed`, ADR-148) or a
 * conversation (`conversation.status_changed`, ADR-149) reaches, or a run ends with
 * (`automation.run_ended`, ADR-151), that an endpoint takes, shown while it takes the event;
 * `statuses` come in the order their pages list them, and a status ticked again keeps that order.
 */
function ReachedStatusChoices<S extends string>({
  prefix,
  kind,
  statuses,
  labels,
  chosen,
  onChange,
}: {
  prefix: string;
  kind: 'campaign' | 'order' | 'template' | 'conversation' | 'run';
  statuses: readonly S[];
  labels: Record<S, string>;
  chosen: S[];
  onChange: (next: S[]) => void;
}) {
  return (
    <fieldset className="ml-6 grid gap-1">
      <legend className="mb-1 text-xs text-muted-foreground">
        Statuses sent (all of them unless you untick some; an event is the status{' '}
        {kind === 'order' ? 'an order' : `a ${kind}`} {kind === 'run' ? 'ended with' : 'reached'})
      </legend>
      {statuses.map((status) => {
        const id = `${prefix}-${kind}-status-${status}`;
        return (
          <div key={status} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={chosen.includes(status)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? statuses.filter((s) => s === status || chosen.includes(s))
                    : chosen.filter((s) => s !== status),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {labels[status]} <span className="font-mono text-xs">({status})</span>
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * The parts of a contact whose change an endpoint takes as `contact.updated` (ADR-123), shown while
 * it takes the event.
 */
function PartChoices({
  prefix,
  chosen,
  onChange,
}: {
  prefix: string;
  chosen: WebhookContactPart[];
  onChange: (next: WebhookContactPart[]) => void;
}) {
  return (
    <fieldset className="ml-6 grid gap-1">
      <legend className="mb-1 text-xs text-muted-foreground">
        Changes sent (all of them unless you untick some; an event names every part that changed)
      </legend>
      {WEBHOOK_CONTACT_PARTS.map((part) => {
        const id = `${prefix}-part-${part}`;
        return (
          <div key={part} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={chosen.includes(part)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? WEBHOOK_CONTACT_PARTS.filter((p) => p === part || chosen.includes(p))
                    : chosen.filter((p) => p !== part),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {WEBHOOK_CONTACT_PART_LABELS[part]}{' '}
              <span className="font-mono text-xs">({part})</span>
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * The automations whose runs an endpoint takes (ADR-145), shown while it takes an automation run
 * event: every automation, including automations published later, or only those ticked. Only
 * published automations can be chosen; an archived one is listed only if the endpoint has it.
 */
function AutomationChoices({
  prefix,
  choices,
  stored,
  every,
  onEveryChange,
  chosen,
  onChange,
}: {
  prefix: string;
  choices: WebhookAutomationChoice[];
  /** The automations the endpoint has now, so an archived one stays listed until saved. */
  stored: readonly string[];
  every: boolean;
  onEveryChange: (next: boolean) => void;
  chosen: string[];
  onChange: (next: string[]) => void;
}) {
  const listed = choices.filter((a) => a.status !== 'archived' || stored.includes(a.id));
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Automation runs sent</legend>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-automations`}
          className="mt-1"
          checked={every}
          onChange={() => onEveryChange(true)}
        />
        <span>
          Every automation’s runs
          <span className="block text-xs text-muted-foreground">
            Including automations published later.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-automations`}
          className="mt-1"
          checked={!every}
          disabled={listed.length === 0}
          onChange={() => onEveryChange(false)}
        />
        <span>
          Only the runs of the automations ticked
          {listed.length === 0 ? (
            <span className="block text-xs text-muted-foreground">
              No automation has been published yet.
            </span>
          ) : null}
        </span>
      </label>
      {!every ? (
        <div className="ml-6 grid gap-1">
          {listed.map((a) => {
            const id = `${prefix}-automation-${a.id}`;
            return (
              <div key={a.id} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={chosen.includes(a.id)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? listed
                            .filter((l) => l.id === a.id || chosen.includes(l.id))
                            .map((l) => l.id)
                        : chosen.filter((c) => c !== a.id),
                    )
                  }
                />
                <Label htmlFor={id} className="font-normal">
                  {a.name}
                  {a.status === 'archived'
                    ? ' (archived)'
                    : a.status === 'paused'
                      ? ' (paused)'
                      : ''}
                </Label>
              </div>
            );
          })}
        </div>
      ) : null}
    </fieldset>
  );
}

/**
 * The WhatsApp numbers whose events an endpoint takes (ADR-170), shown while it takes an event that
 * happens on a number: every number, including numbers connected later, or only those ticked. Any
 * of the company's numbers can be chosen, whatever its status.
 */
function ChannelChoices({
  prefix,
  choices,
  every,
  onEveryChange,
  chosen,
  onChange,
}: {
  prefix: string;
  choices: WebhookChannelChoice[];
  every: boolean;
  onEveryChange: (next: boolean) => void;
  chosen: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">WhatsApp numbers</legend>
      <p className="text-xs text-muted-foreground">
        Message, conversation, automation, order and campaign events happen on a number. Consent,
        contact and template events are sent whichever numbers are chosen.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-channels`}
          className="mt-1"
          checked={every}
          onChange={() => onEveryChange(true)}
        />
        <span>
          Every number’s events
          <span className="block text-xs text-muted-foreground">
            Including numbers connected later.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-channels`}
          className="mt-1"
          checked={!every}
          disabled={choices.length === 0}
          onChange={() => onEveryChange(false)}
        />
        <span>
          Only the events of the numbers ticked
          {choices.length === 0 ? (
            <span className="block text-xs text-muted-foreground">
              No WhatsApp number has been connected yet.
            </span>
          ) : null}
        </span>
      </label>
      {!every ? (
        <div className="ml-6 grid gap-1">
          {choices.map((c) => {
            const id = `${prefix}-channel-${c.id}`;
            return (
              <div key={c.id} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={chosen.includes(c.id)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? choices
                            .filter((l) => l.id === c.id || chosen.includes(l.id))
                            .map((l) => l.id)
                        : chosen.filter((x) => x !== c.id),
                    )
                  }
                />
                <Label htmlFor={id} className="font-normal">
                  {webhookChannelText(c)}
                </Label>
              </div>
            );
          })}
        </div>
      ) : null}
    </fieldset>
  );
}

function EventChoices({
  prefix,
  chosen,
  onChange,
  statuses,
  onStatusesChange,
  parts,
  onPartsChange,
  campaignStatuses,
  onCampaignStatusesChange,
  orderStatuses,
  onOrderStatusesChange,
  templateStatuses,
  onTemplateStatusesChange,
  conversationStatuses,
  onConversationStatusesChange,
  runEndStatuses,
  onRunEndStatusesChange,
}: {
  prefix: string;
  chosen: WebhookEventType[];
  onChange: (next: WebhookEventType[]) => void;
  statuses: WebhookMessageStatus[];
  onStatusesChange: (next: WebhookMessageStatus[]) => void;
  parts: WebhookContactPart[];
  onPartsChange: (next: WebhookContactPart[]) => void;
  campaignStatuses: WebhookCampaignStatus[];
  onCampaignStatusesChange: (next: WebhookCampaignStatus[]) => void;
  orderStatuses: WebhookOrderStatus[];
  onOrderStatusesChange: (next: WebhookOrderStatus[]) => void;
  templateStatuses: WebhookTemplateStatus[];
  onTemplateStatusesChange: (next: WebhookTemplateStatus[]) => void;
  conversationStatuses: WebhookConversationStatus[];
  onConversationStatusesChange: (next: WebhookConversationStatus[]) => void;
  runEndStatuses: WebhookRunEndStatus[];
  onRunEndStatusesChange: (next: WebhookRunEndStatus[]) => void;
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
            {type === 'template.status_changed' && chosen.includes(type) ? (
              <ReachedStatusChoices
                prefix={prefix}
                kind="template"
                statuses={WEBHOOK_TEMPLATE_STATUSES}
                labels={WEBHOOK_TEMPLATE_STATUS_LABELS}
                chosen={templateStatuses}
                onChange={onTemplateStatusesChange}
              />
            ) : null}
            {type === 'conversation.status_changed' && chosen.includes(type) ? (
              <ReachedStatusChoices
                prefix={prefix}
                kind="conversation"
                statuses={WEBHOOK_CONVERSATION_STATUSES}
                labels={WEBHOOK_CONVERSATION_STATUS_LABELS}
                chosen={conversationStatuses}
                onChange={onConversationStatusesChange}
              />
            ) : null}
            {type === 'automation.run_ended' && chosen.includes(type) ? (
              <ReachedStatusChoices
                prefix={prefix}
                kind="run"
                statuses={WEBHOOK_RUN_END_STATUSES}
                labels={WEBHOOK_RUN_END_STATUS_LABELS}
                chosen={runEndStatuses}
                onChange={onRunEndStatusesChange}
              />
            ) : null}
            {type === 'contact.updated' && chosen.includes(type) ? (
              <PartChoices prefix={prefix} chosen={parts} onChange={onPartsChange} />
            ) : null}
            {type === 'order.status_changed' && chosen.includes(type) ? (
              <ReachedStatusChoices
                prefix={prefix}
                kind="order"
                statuses={WEBHOOK_ORDER_STATUSES}
                labels={WEBHOOK_ORDER_STATUS_LABELS}
                chosen={orderStatuses}
                onChange={onOrderStatusesChange}
              />
            ) : null}
            {type === 'campaign.status_changed' && chosen.includes(type) ? (
              <ReachedStatusChoices
                prefix={prefix}
                kind="campaign"
                statuses={WEBHOOK_CAMPAIGN_STATUSES}
                labels={WEBHOOK_CAMPAIGN_STATUS_LABELS}
                chosen={campaignStatuses}
                onChange={onCampaignStatusesChange}
              />
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
  automationChoices,
  channelChoices,
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
    contactParts: WebhookContactPart[] | null;
    automationIds: string[] | null;
    campaignStatuses: WebhookCampaignStatus[] | null;
    orderStatuses: WebhookOrderStatus[] | null;
    templateStatuses: WebhookTemplateStatus[] | null;
    conversationStatuses: WebhookConversationStatus[] | null;
    runEndStatuses: WebhookRunEndStatus[] | null;
    channelIds: string[] | null;
  };
  /** The company's published automations, which an endpoint can choose (ADR-145). */
  automationChoices: WebhookAutomationChoice[];
  /** The company's WhatsApp numbers, which an endpoint can choose (ADR-170). */
  channelChoices: WebhookChannelChoice[];
  atLimit?: boolean;
}) {
  const prefix = useId();
  const [url, setUrl] = useState(endpoint?.url ?? '');
  const [description, setDescription] = useState(endpoint?.description ?? '');
  const [eventTypes, setEventTypes] = useState<WebhookEventType[]>(endpoint?.eventTypes ?? []);
  const [statuses, setStatuses] = useState<WebhookMessageStatus[]>(
    endpoint?.messageStatuses ?? [...WEBHOOK_MESSAGE_STATUSES],
  );
  const [parts, setParts] = useState<WebhookContactPart[]>(
    endpoint?.contactParts ?? [...WEBHOOK_CONTACT_PARTS],
  );
  const [campaignStatuses, setCampaignStatuses] = useState<WebhookCampaignStatus[]>(
    endpoint?.campaignStatuses ?? [...WEBHOOK_CAMPAIGN_STATUSES],
  );
  const [orderStatuses, setOrderStatuses] = useState<WebhookOrderStatus[]>(
    endpoint?.orderStatuses ?? [...WEBHOOK_ORDER_STATUSES],
  );
  const [templateStatuses, setTemplateStatuses] = useState<WebhookTemplateStatus[]>(
    endpoint?.templateStatuses ?? [...WEBHOOK_TEMPLATE_STATUSES],
  );
  const [conversationStatuses, setConversationStatuses] = useState<WebhookConversationStatus[]>(
    endpoint?.conversationStatuses ?? [...WEBHOOK_CONVERSATION_STATUSES],
  );
  const [runEndStatuses, setRunEndStatuses] = useState<WebhookRunEndStatus[]>(
    endpoint?.runEndStatuses ?? [...WEBHOOK_RUN_END_STATUSES],
  );
  const [everyAutomation, setEveryAutomation] = useState(!endpoint?.automationIds);
  const [automationIds, setAutomationIds] = useState<string[]>(endpoint?.automationIds ?? []);
  const [everyChannel, setEveryChannel] = useState(!endpoint?.channelIds);
  const [channelIds, setChannelIds] = useState<string[]>(endpoint?.channelIds ?? []);
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
        // Every part ticked takes every change, including parts added later (null).
        const contactParts =
          eventTypes.includes('contact.updated') && parts.length < WEBHOOK_CONTACT_PARTS.length
            ? parts
            : null;
        // Every automation's runs unless the automations ticked are chosen (ADR-145).
        const chosenAutomations =
          webhookTakesAutomationRuns(eventTypes) && !everyAutomation ? automationIds : null;
        // Every campaign status ticked takes every status (null, ADR-146).
        const chosenCampaignStatuses =
          eventTypes.includes('campaign.status_changed') &&
          campaignStatuses.length < WEBHOOK_CAMPAIGN_STATUSES.length
            ? campaignStatuses
            : null;
        // Every order status ticked takes every status (null, ADR-147).
        const chosenOrderStatuses =
          eventTypes.includes('order.status_changed') &&
          orderStatuses.length < WEBHOOK_ORDER_STATUSES.length
            ? orderStatuses
            : null;
        // Every template status ticked takes every status (null, ADR-148).
        const chosenTemplateStatuses =
          eventTypes.includes('template.status_changed') &&
          templateStatuses.length < WEBHOOK_TEMPLATE_STATUSES.length
            ? templateStatuses
            : null;
        // Every conversation status ticked takes every status (null, ADR-149).
        const chosenConversationStatuses =
          eventTypes.includes('conversation.status_changed') &&
          conversationStatuses.length < WEBHOOK_CONVERSATION_STATUSES.length
            ? conversationStatuses
            : null;
        // Every way a run ends ticked takes every end (null, ADR-151).
        const chosenRunEndStatuses =
          eventTypes.includes('automation.run_ended') &&
          runEndStatuses.length < WEBHOOK_RUN_END_STATUSES.length
            ? runEndStatuses
            : null;
        // Every number's events unless the numbers ticked are chosen (ADR-170).
        const chosenChannels =
          webhookTakesChannelEvents(eventTypes) && !everyChannel ? channelIds : null;
        const input = {
          url,
          description,
          eventTypes,
          messageStatuses,
          contactParts,
          automationIds: chosenAutomations,
          campaignStatuses: chosenCampaignStatuses,
          orderStatuses: chosenOrderStatuses,
          templateStatuses: chosenTemplateStatuses,
          conversationStatuses: chosenConversationStatuses,
          runEndStatuses: chosenRunEndStatuses,
          channelIds: chosenChannels,
        };
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
              setParts([...WEBHOOK_CONTACT_PARTS]);
              setCampaignStatuses([...WEBHOOK_CAMPAIGN_STATUSES]);
              setOrderStatuses([...WEBHOOK_ORDER_STATUSES]);
              setTemplateStatuses([...WEBHOOK_TEMPLATE_STATUSES]);
              setConversationStatuses([...WEBHOOK_CONVERSATION_STATUSES]);
              setRunEndStatuses([...WEBHOOK_RUN_END_STATUSES]);
              setEveryAutomation(true);
              setAutomationIds([]);
              setEveryChannel(true);
              setChannelIds([]);
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
        parts={parts}
        onPartsChange={setParts}
        campaignStatuses={campaignStatuses}
        onCampaignStatusesChange={setCampaignStatuses}
        orderStatuses={orderStatuses}
        onOrderStatusesChange={setOrderStatuses}
        templateStatuses={templateStatuses}
        onTemplateStatusesChange={setTemplateStatuses}
        conversationStatuses={conversationStatuses}
        onConversationStatusesChange={setConversationStatuses}
        runEndStatuses={runEndStatuses}
        onRunEndStatusesChange={setRunEndStatuses}
      />
      {webhookTakesAutomationRuns(eventTypes) ? (
        <AutomationChoices
          prefix={prefix}
          choices={automationChoices}
          stored={endpoint?.automationIds ?? []}
          every={everyAutomation}
          onEveryChange={setEveryAutomation}
          chosen={automationIds}
          onChange={setAutomationIds}
        />
      ) : null}
      {webhookTakesChannelEvents(eventTypes) ? (
        <ChannelChoices
          prefix={prefix}
          choices={channelChoices}
          every={everyChannel}
          onEveryChange={setEveryChannel}
          chosen={channelIds}
          onChange={setChannelIds}
        />
      ) : null}
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
 * one new delivery per event whose deliveries all failed, of every event or of one the endpoint
 * receives (ADR-156), of every failure or of one kind (ADR-159). Without an endpoint, those of
 * every endpoint that is on, 500 at most across them (ADR-160).
 */
export function ReplayFailedDeliveriesForm({
  slug,
  endpointId,
  events,
}: {
  slug: string;
  /** The endpoint, or null for every endpoint that is on. */
  endpointId: string | null;
  /** The events the endpoints receive, offered as a choice beside every event. */
  events: readonly WebhookEventType[];
}) {
  const selectId = useId();
  const eventId = useId();
  const failureId = useId();
  const [period, setPeriod] = useState<WebhookReplayPeriod>('24h');
  const [eventType, setEventType] = useState<WebhookEventType | ''>('');
  const [failure, setFailure] = useState<WebhookFailureKind | ''>('');
  const [error, setError] = useState<ActionFailureState | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = endpointId
    ? 'Replay failed deliveries'
    : 'Replay every endpoint’s failed deliveries';
  return (
    <ClientForm
      className="grid gap-2"
      aria-label={name}
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setDone(null);
        const replayed = endpointId
          ? replayFailedWebhookDeliveriesAction(
              slug,
              endpointId,
              period,
              eventType || null,
              failure || null,
            ).then((r) => (r.ok ? { ok: true as const, summary: webhookReplaySummary(r.data) } : r))
          : replayAllFailedWebhookDeliveriesAction(
              slug,
              period,
              eventType || null,
              failure || null,
            ).then((r) =>
              r.ok ? { ok: true as const, summary: webhookReplayAllSummary(r.data) } : r,
            );
        void replayed.then((r) => {
          setBusy(false);
          if (r.ok) setDone(r.summary);
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
        <div className="grid gap-1">
          <Label htmlFor={eventId}>Events</Label>
          <Select
            id={eventId}
            className="w-auto min-w-40"
            value={eventType}
            onChange={(e) => setEventType(e.target.value as WebhookEventType | '')}
          >
            <option value="">Every event</option>
            {events.map((type) => (
              <option key={type} value={type}>
                {WEBHOOK_EVENT_INFO[type].label} ({type})
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={failureId}>Failures</Label>
          <Select
            id={failureId}
            className="w-auto min-w-40"
            value={failure}
            onChange={(e) => setFailure(e.target.value as WebhookFailureKind | '')}
          >
            <option value="">Every failure</option>
            {WEBHOOK_FAILURE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {WEBHOOK_FAILURE_LABELS[kind]}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={busy}>
          {name}
        </Button>
      </div>
      <FormSuccess message={done} />
      <ActionFailure failure={error} />
    </ClientForm>
  );
}
