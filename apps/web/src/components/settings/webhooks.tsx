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
  WEBHOOK_MESSAGE_SENDER_LABELS,
  WEBHOOK_MESSAGE_SENDERS,
  WEBHOOK_MESSAGE_STATUS_LABELS,
  WEBHOOK_MESSAGE_STATUSES,
  WEBHOOK_ORDER_STATUS_LABELS,
  WEBHOOK_ORDER_STATUSES,
  WEBHOOK_REPLAY_PERIODS,
  WEBHOOK_RUN_END_STATUS_LABELS,
  WEBHOOK_RUN_END_STATUSES,
  WEBHOOK_RUN_TRIGGER_LABELS,
  WEBHOOK_RUN_TRIGGERS,
  WEBHOOK_CONSENT_CHANGE_LABELS,
  WEBHOOK_CONSENT_CHANGES,
  WEBHOOK_CONTACT_SOURCE_LABELS,
  WEBHOOK_CONTACT_SOURCES,
  WEBHOOK_RECEIVED_MESSAGE_TYPE_LABELS,
  WEBHOOK_RECEIVED_MESSAGE_TYPES,
  WEBHOOK_RUN_END_REASON_LABELS,
  WEBHOOK_RUN_END_REASONS,
  WEBHOOK_RUN_END_REASONS_BY_END,
  WEBHOOK_TEMPLATE_STATUS_LABELS,
  WEBHOOK_TEMPLATE_STATUSES,
  webhookAssigneeText,
  webhookCampaignText,
  webhookChannelText,
  webhookFieldText,
  webhookOAuthText,
  webhookOwnerText,
  webhookPipelineText,
  webhookReplayAllSummary,
  webhookReplaySummary,
  webhookRunEndReasonsChosen,
  webhookRunEndReasonsTicked,
  webhookStageText,
  webhookTakesAutomationRuns,
  webhookTakesCampaignEvents,
  webhookTakesChannelEvents,
  webhookTakesFieldChanges,
  webhookTakesPipelineEvents,
  webhookTakesTaskEvents,
  webhookTakesTeamEvents,
  webhookTakesTemplateEvents,
  webhookTeamText,
  webhookTemplateText,
  type AutomationEndReason,
  type WebhookAssigneeChoice,
  type WebhookAutomationChoice,
  type WebhookCampaignStatus,
  type WebhookChannelChoice,
  type WebhookCampaignChoice,
  type WebhookContactPart,
  type WebhookConversationStatus,
  type WebhookEndpointAssignee,
  type WebhookEndpointCampaign,
  type WebhookEndpointField,
  type WebhookEndpointOAuth,
  type WebhookEndpointOwner,
  type WebhookEndpointPipeline,
  type WebhookEndpointStage,
  type WebhookEndpointTeam,
  type WebhookEventType,
  type WebhookFailureKind,
  type WebhookFieldChoice,
  type WebhookMessageSender,
  type WebhookMessageStatus,
  type WebhookOrderStatus,
  type WebhookOwnerChoice,
  type WebhookPipelineChoice,
  type WebhookReplayPeriod,
  type WebhookStageChoice,
  type WebhookRunEndStatus,
  type WebhookRunTrigger,
  type WebhookConsentChange,
  type ContactSource,
  type WebhookReceivedMessageType,
  type WebhookTeamChoice,
  type WebhookTemplateChoice,
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
 * Who sent the messages whose `message.status` an endpoint takes (ADR-172), shown while it takes the
 * event, as the event's `message.sentBy` names them.
 */
function SenderChoices({
  prefix,
  chosen,
  onChange,
}: {
  prefix: string;
  chosen: WebhookMessageSender[];
  onChange: (next: WebhookMessageSender[]) => void;
}) {
  return (
    <fieldset className="ml-6 grid gap-1">
      <legend className="mb-1 text-xs text-muted-foreground">
        Messages sent by (all of them unless you untick some)
      </legend>
      {WEBHOOK_MESSAGE_SENDERS.map((sender) => {
        const id = `${prefix}-sender-${sender}`;
        return (
          <div key={sender} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={chosen.includes(sender)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? WEBHOOK_MESSAGE_SENDERS.filter((s) => s === sender || chosen.includes(s))
                    : chosen.filter((s) => s !== sender),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {WEBHOOK_MESSAGE_SENDER_LABELS[sender]}{' '}
              <span className="font-mono text-xs">({sender})</span>
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * What started the runs whose events an endpoint takes (ADR-183), shown while it takes a run event:
 * every run unless some are unticked.
 */
function TriggerChoices({
  prefix,
  chosen,
  onChange,
}: {
  prefix: string;
  chosen: WebhookRunTrigger[];
  onChange: (next: WebhookRunTrigger[]) => void;
}) {
  return (
    <fieldset className="grid gap-1">
      <legend className="mb-1 text-sm font-medium">Runs started by</legend>
      <p className="text-xs text-muted-foreground">
        Automation started and Automation ended are sent for the runs started by the ways ticked
        (all of them unless you untick some).
      </p>
      {WEBHOOK_RUN_TRIGGERS.map((trigger) => {
        const id = `${prefix}-run-trigger-${trigger}`;
        return (
          <div key={trigger} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={chosen.includes(trigger)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? WEBHOOK_RUN_TRIGGERS.filter((t) => t === trigger || chosen.includes(t))
                    : chosen.filter((t) => t !== trigger),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {WEBHOOK_RUN_TRIGGER_LABELS[trigger]}{' '}
              <span className="font-mono text-xs">({trigger})</span>
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
 * The consent changes an endpoint takes as `consent.changed` (ADR-189), by purpose and action, shown
 * while it takes the event.
 */
function ConsentChoices({
  prefix,
  chosen,
  onChange,
}: {
  prefix: string;
  chosen: WebhookConsentChange[];
  onChange: (next: WebhookConsentChange[]) => void;
}) {
  return (
    <fieldset className="ml-6 grid gap-1">
      <legend className="mb-1 text-xs text-muted-foreground">
        Consent changes sent (all of them unless you untick some)
      </legend>
      {WEBHOOK_CONSENT_CHANGES.map((change) => {
        const id = `${prefix}-consent-${change}`;
        return (
          <div key={change} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={chosen.includes(change)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? WEBHOOK_CONSENT_CHANGES.filter((c) => c === change || chosen.includes(c))
                    : chosen.filter((c) => c !== change),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {WEBHOOK_CONSENT_CHANGE_LABELS[change]}{' '}
              <span className="font-mono text-xs">({change})</span>
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * Where the contacts whose `contact.created` an endpoint takes came from (ADR-190), shown while it
 * takes the event.
 */
function ContactSourceChoices({
  prefix,
  chosen,
  onChange,
}: {
  prefix: string;
  chosen: ContactSource[];
  onChange: (next: ContactSource[]) => void;
}) {
  return (
    <fieldset className="ml-6 grid gap-1">
      <legend className="mb-1 text-xs text-muted-foreground">
        New contacts sent, by where they came from (all of them unless you untick some)
      </legend>
      {WEBHOOK_CONTACT_SOURCES.map((source) => {
        const id = `${prefix}-contact-source-${source}`;
        return (
          <div key={source} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={chosen.includes(source)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? WEBHOOK_CONTACT_SOURCES.filter((s) => s === source || chosen.includes(s))
                    : chosen.filter((s) => s !== source),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {WEBHOOK_CONTACT_SOURCE_LABELS[source]}{' '}
              <span className="font-mono text-xs">({source})</span>
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * The types of the received messages an endpoint takes as `message.received` (ADR-191), shown while
 * it takes the event.
 */
function MessageTypeChoices({
  prefix,
  chosen,
  onChange,
}: {
  prefix: string;
  chosen: WebhookReceivedMessageType[];
  onChange: (next: WebhookReceivedMessageType[]) => void;
}) {
  return (
    <fieldset className="ml-6 grid gap-1">
      <legend className="mb-1 text-xs text-muted-foreground">
        Received messages sent, by type (all of them unless you untick some)
      </legend>
      {WEBHOOK_RECEIVED_MESSAGE_TYPES.map((type) => {
        const id = `${prefix}-message-type-${type}`;
        return (
          <div key={type} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={chosen.includes(type)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? WEBHOOK_RECEIVED_MESSAGE_TYPES.filter((t) => t === type || chosen.includes(t))
                    : chosen.filter((t) => t !== type),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {WEBHOOK_RECEIVED_MESSAGE_TYPE_LABELS[type]}{' '}
              <span className="font-mono text-xs">({type})</span>
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * Why the runs an endpoint takes as `automation.run_ended` ended (ADR-192), by end, shown for the
 * ends it takes: every reason of an end unless some are unticked. The last reason ticked of an end
 * stays ticked: unticking the end above stops its runs.
 */
function RunEndReasonChoices({
  prefix,
  ends,
  chosen,
  onChange,
}: {
  prefix: string;
  ends: WebhookRunEndStatus[];
  chosen: AutomationEndReason[];
  onChange: (next: AutomationEndReason[]) => void;
}) {
  return (
    <fieldset className="ml-6 grid gap-2">
      <legend className="mb-1 text-xs text-muted-foreground">
        Why the runs ended, by status (every reason unless you untick some; untick a status above to
        stop its runs)
      </legend>
      {WEBHOOK_RUN_END_STATUSES.filter((end) => ends.includes(end)).map((end) => {
        const reasons: readonly AutomationEndReason[] = WEBHOOK_RUN_END_REASONS_BY_END[end];
        const ticked = reasons.filter((reason) => chosen.includes(reason));
        return (
          <div key={end} className="grid gap-1">
            <span className="text-xs font-medium">{WEBHOOK_RUN_END_STATUS_LABELS[end]}</span>
            {reasons.map((reason) => {
              const id = `${prefix}-run-end-reason-${reason}`;
              const checked = chosen.includes(reason);
              return (
                <div key={reason} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={checked}
                    disabled={checked && ticked.length === 1}
                    onChange={(e) =>
                      onChange(
                        e.target.checked
                          ? WEBHOOK_RUN_END_REASONS.filter(
                              (r) => r === reason || chosen.includes(r),
                            )
                          : chosen.filter((r) => r !== reason),
                      )
                    }
                  />
                  <Label htmlFor={id} className="font-normal">
                    {WEBHOOK_RUN_END_REASON_LABELS[reason]}{' '}
                    <span className="font-mono text-xs">({reason})</span>
                  </Label>
                </div>
              );
            })}
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * The custom fields whose changes an endpoint takes as `contact.updated` (ADR-184), shown while it
 * takes field changes: every field's, or those of the fields ticked. A field deleted since it was
 * chosen stays listed, ticked, until it is unticked.
 */
function FieldChoices({
  prefix,
  choices,
  stored,
  every,
  onEveryChange,
  chosen,
  onChange,
}: {
  prefix: string;
  choices: WebhookFieldChoice[];
  /** The fields the endpoint names now, so a deleted one stays listed until it is saved without. */
  stored: readonly WebhookEndpointField[];
  every: boolean;
  onEveryChange: (next: boolean) => void;
  chosen: string[];
  onChange: (next: string[]) => void;
}) {
  const listed = [
    ...choices.map((c) => ({ key: c.key, text: webhookFieldText(c) })),
    ...stored
      .filter((f) => f.label === null)
      .map((f) => ({ key: f.key, text: webhookFieldText(f) })),
  ];
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Custom fields</legend>
      <p className="text-xs text-muted-foreground">
        A change of a custom field is sent only for the fields ticked; changes of the other parts of
        a contact are sent as chosen under Contact changed.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-fields`}
          className="mt-1"
          checked={every}
          onChange={() => onEveryChange(true)}
        />
        <span>
          Every custom field’s changes
          <span className="block text-xs text-muted-foreground">Including fields added later.</span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-fields`}
          className="mt-1"
          checked={!every}
          disabled={listed.length === 0}
          onChange={() => onEveryChange(false)}
        />
        <span>
          Only the changes of the fields ticked
          {listed.length === 0 ? (
            <span className="block text-xs text-muted-foreground">
              The company has no custom field yet.
            </span>
          ) : null}
        </span>
      </label>
      {!every ? (
        <div className="ml-6 grid max-h-64 gap-1 overflow-y-auto">
          {listed.map((f) => {
            const id = `${prefix}-field-${f.key}`;
            return (
              <div key={f.key} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={chosen.includes(f.key)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? listed
                            .filter((l) => l.key === f.key || chosen.includes(l.key))
                            .map((l) => l.key)
                        : chosen.filter((x) => x !== f.key),
                    )
                  }
                />
                <Label htmlFor={id} className="font-normal break-all">
                  {f.text}
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
        contact, template, deal and task events are sent whichever numbers are chosen.
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

/**
 * The teams whose conversations' events an endpoint takes (ADR-174): every conversation's, or those
 * of the teams ticked. A team deleted since it was chosen stays listed, ticked, until it is
 * unticked: it matches no conversation.
 */
function TeamChoices({
  prefix,
  choices,
  stored,
  every,
  onEveryChange,
  chosen,
  onChange,
}: {
  prefix: string;
  choices: WebhookTeamChoice[];
  /** The teams the endpoint names now, so a deleted one stays listed until it is saved without. */
  stored: readonly WebhookEndpointTeam[];
  every: boolean;
  onEveryChange: (next: boolean) => void;
  chosen: string[];
  onChange: (next: string[]) => void;
}) {
  const listed = [
    ...choices.map((c) => ({ id: c.id, text: c.name })),
    ...stored.filter((t) => t.name === null).map((t) => ({ id: t.id, text: webhookTeamText(t) })),
  ];
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Teams</legend>
      <p className="text-xs text-muted-foreground">
        Message and conversation events belong to the team the conversation is in when they happen,
        and a change of team to the team it left as well. Other events are sent whichever teams are
        chosen.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-teams`}
          className="mt-1"
          checked={every}
          onChange={() => onEveryChange(true)}
        />
        <span>
          Every conversation’s events
          <span className="block text-xs text-muted-foreground">
            Including teams added later, and conversations in no team.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-teams`}
          className="mt-1"
          checked={!every}
          disabled={listed.length === 0}
          onChange={() => onEveryChange(false)}
        />
        <span>
          Only the events of the conversations of the teams ticked
          {listed.length === 0 ? (
            <span className="block text-xs text-muted-foreground">
              The company has no team yet.
            </span>
          ) : null}
        </span>
      </label>
      {!every ? (
        <div className="ml-6 grid gap-1">
          {listed.map((t) => {
            const id = `${prefix}-team-${t.id}`;
            return (
              <div key={t.id} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={chosen.includes(t.id)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? listed
                            .filter((l) => l.id === t.id || chosen.includes(l.id))
                            .map((l) => l.id)
                        : chosen.filter((x) => x !== t.id),
                    )
                  }
                />
                <Label htmlFor={id} className="font-normal">
                  {t.text}
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
 * The members whose assigned conversations' events an endpoint takes (ADR-181): every
 * conversation's, or those of the conversations assigned to the members ticked. A member who no
 * longer takes conversations stays listed, ticked, until unticked: they hold none.
 */
function AssigneeChoices({
  prefix,
  choices,
  stored,
  every,
  onEveryChange,
  chosen,
  onChange,
}: {
  prefix: string;
  choices: WebhookAssigneeChoice[];
  /** The members the endpoint names now, so one who stopped stays listed until saved without. */
  stored: readonly WebhookEndpointAssignee[];
  every: boolean;
  onEveryChange: (next: boolean) => void;
  chosen: string[];
  onChange: (next: string[]) => void;
}) {
  const listed = [
    ...choices.map((c) => ({ id: c.id, text: c.name })),
    ...stored
      .filter((m) => !choices.some((c) => c.id === m.id))
      .map((m) => ({ id: m.id, text: webhookAssigneeText(m) })),
  ];
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Members</legend>
      <p className="text-xs text-muted-foreground">
        Message and conversation events belong to the member the conversation is assigned to when
        they happen, and a change of assignee to the member it left as well. Other events are sent
        whichever members are chosen.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-assignees`}
          className="mt-1"
          checked={every}
          onChange={() => onEveryChange(true)}
        />
        <span>
          Every conversation’s events
          <span className="block text-xs text-muted-foreground">
            Including unassigned conversations, and members who join later.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-assignees`}
          className="mt-1"
          checked={!every}
          disabled={listed.length === 0}
          onChange={() => onEveryChange(false)}
        />
        <span>
          Only the events of the conversations assigned to the members ticked
          {listed.length === 0 ? (
            <span className="block text-xs text-muted-foreground">
              No member takes conversations yet.
            </span>
          ) : null}
        </span>
      </label>
      {!every ? (
        <div className="ml-6 grid max-h-64 gap-1 overflow-y-auto">
          {listed.map((m) => {
            const id = `${prefix}-assignee-${m.id}`;
            return (
              <div key={m.id} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={chosen.includes(m.id)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? listed
                            .filter((l) => l.id === m.id || chosen.includes(l.id))
                            .map((l) => l.id)
                        : chosen.filter((x) => x !== m.id),
                    )
                  }
                />
                <Label htmlFor={id} className="font-normal break-all">
                  {m.text}
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
 * The templates whose messages' statuses and changes an endpoint takes (ADR-175): every
 * template's, or those of the templates ticked.
 */
function TemplateChoices({
  prefix,
  choices,
  every,
  onEveryChange,
  chosen,
  onChange,
}: {
  prefix: string;
  choices: WebhookTemplateChoice[];
  every: boolean;
  onEveryChange: (next: boolean) => void;
  chosen: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Templates</legend>
      <p className="text-xs text-muted-foreground">
        Message statuses and template changes belong to a template; a message sent without one, such
        as a member’s reply, belongs to none. Other events are sent whichever templates are chosen.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-templates`}
          className="mt-1"
          checked={every}
          onChange={() => onEveryChange(true)}
        />
        <span>
          Every message’s statuses and every template’s changes
          <span className="block text-xs text-muted-foreground">
            Including templates added later.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-templates`}
          className="mt-1"
          checked={!every}
          disabled={choices.length === 0}
          onChange={() => onEveryChange(false)}
        />
        <span>
          Only those of the templates ticked
          {choices.length === 0 ? (
            <span className="block text-xs text-muted-foreground">
              The company has no template yet.
            </span>
          ) : null}
        </span>
      </label>
      {!every ? (
        <div className="ml-6 grid max-h-64 gap-1 overflow-y-auto">
          {choices.map((t) => {
            const id = `${prefix}-template-${t.id}`;
            return (
              <div key={t.id} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={chosen.includes(t.id)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? choices
                            .filter((l) => l.id === t.id || chosen.includes(l.id))
                            .map((l) => l.id)
                        : chosen.filter((x) => x !== t.id),
                    )
                  }
                />
                <Label htmlFor={id} className="font-normal break-all">
                  {webhookTemplateText(t)}
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
 * The campaigns whose messages' statuses and changes an endpoint takes (ADR-185): every campaign's,
 * or those of the campaigns ticked. The company's newest campaigns are offered; one the endpoint
 * already names stays listed, ticked, until it is unticked.
 */
function CampaignChoices({
  prefix,
  choices,
  more,
  stored,
  every,
  onEveryChange,
  chosen,
  onChange,
}: {
  prefix: string;
  choices: WebhookCampaignChoice[];
  /** Whether the company has campaigns older than those offered. */
  more: boolean;
  /** The campaigns the endpoint names now, so an older one stays listed until it is saved without. */
  stored: readonly WebhookEndpointCampaign[];
  every: boolean;
  onEveryChange: (next: boolean) => void;
  chosen: string[];
  onChange: (next: string[]) => void;
}) {
  const listed: WebhookEndpointCampaign[] = [
    ...choices,
    ...stored.filter((s) => !choices.some((c) => c.id === s.id)),
  ];
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Campaigns</legend>
      <p className="text-xs text-muted-foreground">
        Message statuses and campaign changes belong to a campaign; a message no campaign sent, such
        as a member’s reply, belongs to none. Other events are sent whichever campaigns are chosen.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-campaigns`}
          className="mt-1"
          checked={every}
          onChange={() => onEveryChange(true)}
        />
        <span>
          Every message’s statuses and every campaign’s changes
          <span className="block text-xs text-muted-foreground">
            Including campaigns added later.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-campaigns`}
          className="mt-1"
          checked={!every}
          disabled={listed.length === 0}
          onChange={() => onEveryChange(false)}
        />
        <span>
          Only those of the campaigns ticked
          {listed.length === 0 ? (
            <span className="block text-xs text-muted-foreground">
              The company has no campaign yet.
            </span>
          ) : null}
        </span>
      </label>
      {!every ? (
        <div className="ml-6 grid gap-1">
          <div className="grid max-h-64 gap-1 overflow-y-auto">
            {listed.map((c) => {
              const id = `${prefix}-campaign-${c.id}`;
              return (
                <div key={c.id} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={chosen.includes(c.id)}
                    onChange={(e) =>
                      onChange(
                        e.target.checked
                          ? listed
                              .filter((l) => l.id === c.id || chosen.includes(l.id))
                              .map((l) => l.id)
                          : chosen.filter((x) => x !== c.id),
                      )
                    }
                  />
                  <Label htmlFor={id} className="font-normal break-all">
                    {webhookCampaignText(c)}
                  </Label>
                </div>
              );
            })}
          </div>
          {more ? (
            <p className="text-xs text-muted-foreground">
              The {WEBHOOK_LIMITS.campaignChoices} newest campaigns are listed; an older one can be
              chosen through the API.
            </p>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}

/**
 * The CRM pipelines whose deals' events an endpoint takes (ADR-263): every pipeline's, or those of
 * the pipelines ticked. The pipelines the company uses are offered; an archived one the endpoint
 * already names stays listed, ticked, until it is unticked.
 */
function PipelineChoices({
  prefix,
  choices,
  stored,
  every,
  onEveryChange,
  chosen,
  onChange,
}: {
  prefix: string;
  choices: WebhookPipelineChoice[];
  /** The pipelines the endpoint names now, so an archived one stays listed until saved without. */
  stored: readonly WebhookEndpointPipeline[];
  every: boolean;
  onEveryChange: (next: boolean) => void;
  chosen: string[];
  onChange: (next: string[]) => void;
}) {
  const listed: WebhookEndpointPipeline[] = [
    ...choices.map((c) => ({ ...c, archived: false })),
    ...stored.filter((s) => !choices.some((c) => c.id === s.id)),
  ];
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Pipelines</legend>
      <p className="text-xs text-muted-foreground">
        A deal’s events belong to its pipeline; a deal moved to another pipeline belongs to both for
        that move. Task and other events are sent whichever pipelines are chosen.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-pipelines`}
          className="mt-1"
          checked={every}
          onChange={() => onEveryChange(true)}
        />
        <span>
          Every deal’s events
          <span className="block text-xs text-muted-foreground">
            Including pipelines added later.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-pipelines`}
          className="mt-1"
          checked={!every}
          disabled={listed.length === 0}
          onChange={() => onEveryChange(false)}
        />
        <span>
          Only those of the deals in the pipelines ticked
          {listed.length === 0 ? (
            <span className="block text-xs text-muted-foreground">
              The company has no pipeline yet.
            </span>
          ) : null}
        </span>
      </label>
      {!every ? (
        <div className="ml-6 grid max-h-64 gap-1 overflow-y-auto">
          {listed.map((p) => {
            const id = `${prefix}-pipeline-${p.id}`;
            return (
              <div key={p.id} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={chosen.includes(p.id)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? listed
                            .filter((l) => l.id === p.id || chosen.includes(l.id))
                            .map((l) => l.id)
                        : chosen.filter((x) => x !== p.id),
                    )
                  }
                />
                <Label htmlFor={id} className="font-normal break-all">
                  {webhookPipelineText(p)}
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
 * The CRM stages whose deals' events an endpoint takes (ADR-264): every stage's, or those of the
 * stages ticked, named with their pipelines. The stages in use of the pipelines the company uses are
 * offered; a removed one, or one of an archived pipeline, the endpoint already names stays listed,
 * ticked, until it is unticked.
 */
function StageChoices({
  prefix,
  choices,
  stored,
  every,
  onEveryChange,
  chosen,
  onChange,
}: {
  prefix: string;
  choices: WebhookStageChoice[];
  /** The stages the endpoint names now, so a removed one stays listed until saved without. */
  stored: readonly WebhookEndpointStage[];
  every: boolean;
  onEveryChange: (next: boolean) => void;
  chosen: string[];
  onChange: (next: string[]) => void;
}) {
  const listed: WebhookEndpointStage[] = [
    ...choices.map((c) => ({
      id: c.id,
      name: c.name,
      pipelineName: c.pipelineName,
      removed: false,
      pipelineArchived: false,
    })),
    ...stored.filter((s) => !choices.some((c) => c.id === s.id)),
  ];
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Stages</legend>
      <p className="text-xs text-muted-foreground">
        A deal’s events belong to its stage; a deal moved to another stage belongs to both for that
        move. With pipelines chosen too, an event must pass both. Task and other events are sent
        whichever stages are chosen.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-stages`}
          className="mt-1"
          checked={every}
          onChange={() => onEveryChange(true)}
        />
        <span>
          Every stage’s deals
          <span className="block text-xs text-muted-foreground">Including stages added later.</span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-stages`}
          className="mt-1"
          checked={!every}
          disabled={listed.length === 0}
          onChange={() => onEveryChange(false)}
        />
        <span>
          Only those of the deals in the stages ticked
          {listed.length === 0 ? (
            <span className="block text-xs text-muted-foreground">
              The company has no pipeline yet.
            </span>
          ) : null}
        </span>
      </label>
      {!every ? (
        <div className="ml-6 grid max-h-64 gap-1 overflow-y-auto">
          {listed.map((st) => {
            const id = `${prefix}-stage-${st.id}`;
            return (
              <div key={st.id} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={chosen.includes(st.id)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? listed
                            .filter((l) => l.id === st.id || chosen.includes(l.id))
                            .map((l) => l.id)
                        : chosen.filter((x) => x !== st.id),
                    )
                  }
                />
                <Label htmlFor={id} className="font-normal break-all">
                  {webhookStageText(st)}
                </Label>
              </div>
            );
          })}
        </div>
      ) : null}
    </fieldset>
  );
}

/** What the members' fieldset says for deal owners (ADR-265) and task assignees (ADR-266). */
const CRM_MEMBER_WORDS = {
  owners: {
    legend: 'Deal owners',
    help: 'A deal’s events belong to the member who owns the deal when they happen; a deal without an owner belongs to no one. With pipelines or stages chosen too, an event must pass them all. Task and other events are sent whichever owners are chosen.',
    every: 'Every deal’s events',
    everyHelp: 'Including deals without an owner, and members who join later.',
    only: 'Only those of the deals the members ticked own',
    idPart: 'owner',
  },
  taskAssignees: {
    legend: 'Task assignees',
    help: 'A task’s events belong to the member it is assigned to when they happen. Deal and other events are sent whichever assignees are chosen.',
    every: 'Every task’s events',
    everyHelp: 'Including those of members who join later.',
    only: 'Only those of the tasks assigned to the members ticked',
    idPart: 'task-assignee',
  },
} as const;

/**
 * The members whose deals' events (ADR-265) or tasks' events (ADR-266) an endpoint takes, as `kind`
 * says: every deal's or task's, or those of the deals the members ticked own, or of the tasks
 * assigned to them, when the events happen. Members who can own deals and be assigned tasks are
 * offered; one the endpoint already names who no longer can stays listed, ticked, until it is
 * unticked.
 */
function CrmMemberChoices({
  kind,
  prefix,
  choices,
  stored,
  every,
  onEveryChange,
  chosen,
  onChange,
}: {
  kind: keyof typeof CRM_MEMBER_WORDS;
  prefix: string;
  choices: WebhookOwnerChoice[];
  /** The members the endpoint names now, so one who left stays listed until saved without. */
  stored: readonly WebhookEndpointOwner[];
  every: boolean;
  onEveryChange: (next: boolean) => void;
  chosen: string[];
  onChange: (next: string[]) => void;
}) {
  const listed = [
    ...choices.map((c) => ({ id: c.id, text: c.name })),
    ...stored
      .filter((m) => !choices.some((c) => c.id === m.id))
      .map((m) => ({ id: m.id, text: webhookOwnerText(m) })),
  ];
  const words = CRM_MEMBER_WORDS[kind];
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">{words.legend}</legend>
      <p className="text-xs text-muted-foreground">{words.help}</p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-${words.idPart}s`}
          className="mt-1"
          checked={every}
          onChange={() => onEveryChange(true)}
        />
        <span>
          {words.every}
          <span className="block text-xs text-muted-foreground">{words.everyHelp}</span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-${words.idPart}s`}
          className="mt-1"
          checked={!every}
          disabled={listed.length === 0}
          onChange={() => onEveryChange(false)}
        />
        <span>
          {words.only}
          {listed.length === 0 ? (
            <span className="block text-xs text-muted-foreground">No member uses the CRM yet.</span>
          ) : null}
        </span>
      </label>
      {!every ? (
        <div className="ml-6 grid max-h-64 gap-1 overflow-y-auto">
          {listed.map((m) => {
            const id = `${prefix}-${words.idPart}-${m.id}`;
            return (
              <div key={m.id} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={chosen.includes(m.id)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? listed
                            .filter((l) => l.id === m.id || chosen.includes(l.id))
                            .map((l) => l.id)
                        : chosen.filter((x) => x !== m.id),
                    )
                  }
                />
                <Label htmlFor={id} className="font-normal break-all">
                  {m.text}
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
  senders,
  onSendersChange,
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
  consentChanges,
  onConsentChangesChange,
  contactSources,
  onContactSourcesChange,
  messageTypes,
  onMessageTypesChange,
  runEndReasons,
  onRunEndReasonsChange,
}: {
  prefix: string;
  chosen: WebhookEventType[];
  onChange: (next: WebhookEventType[]) => void;
  statuses: WebhookMessageStatus[];
  onStatusesChange: (next: WebhookMessageStatus[]) => void;
  senders: WebhookMessageSender[];
  onSendersChange: (next: WebhookMessageSender[]) => void;
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
  consentChanges: WebhookConsentChange[];
  onConsentChangesChange: (next: WebhookConsentChange[]) => void;
  contactSources: ContactSource[];
  onContactSourcesChange: (next: ContactSource[]) => void;
  messageTypes: WebhookReceivedMessageType[];
  onMessageTypesChange: (next: WebhookReceivedMessageType[]) => void;
  runEndReasons: AutomationEndReason[];
  onRunEndReasonsChange: (next: AutomationEndReason[]) => void;
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
            {type === 'message.received' && chosen.includes(type) ? (
              <MessageTypeChoices
                prefix={prefix}
                chosen={messageTypes}
                onChange={onMessageTypesChange}
              />
            ) : null}
            {type === 'message.status' && chosen.includes(type) ? (
              <>
                <StatusChoices prefix={prefix} chosen={statuses} onChange={onStatusesChange} />
                <SenderChoices prefix={prefix} chosen={senders} onChange={onSendersChange} />
              </>
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
              <>
                <ReachedStatusChoices
                  prefix={prefix}
                  kind="run"
                  statuses={WEBHOOK_RUN_END_STATUSES}
                  labels={WEBHOOK_RUN_END_STATUS_LABELS}
                  chosen={runEndStatuses}
                  onChange={onRunEndStatusesChange}
                />
                <RunEndReasonChoices
                  prefix={prefix}
                  ends={runEndStatuses}
                  chosen={runEndReasons}
                  onChange={onRunEndReasonsChange}
                />
              </>
            ) : null}
            {type === 'consent.changed' && chosen.includes(type) ? (
              <ConsentChoices
                prefix={prefix}
                chosen={consentChanges}
                onChange={onConsentChangesChange}
              />
            ) : null}
            {type === 'contact.created' && chosen.includes(type) ? (
              <ContactSourceChoices
                prefix={prefix}
                chosen={contactSources}
                onChange={onContactSourcesChange}
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

/** An endpoint's OAuth client as entered here (ADR-173); the secret never comes back. */
interface OAuthFields {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

/**
 * What a change does to the endpoint's OAuth client: keeps it (or, without one, adds none), sets
 * it (adds or changes it) or removes it.
 */
type OAuthChange = 'keep' | 'set' | 'remove';

/**
 * The OAuth client an endpoint gets access tokens as (ADR-173): its receiver's authorization server
 * and the client it issued. A change shows the stored client, without its secret, which a member
 * gives again only to replace it or when the token URL changes.
 */
function OAuthClientFields({
  prefix,
  stored,
  change,
  onChangeChange,
  fields,
  onFieldsChange,
}: {
  prefix: string;
  /** The endpoint's client; null for a new endpoint or one without a client. */
  stored: WebhookEndpointOAuth | null;
  change: OAuthChange;
  onChangeChange: (next: OAuthChange) => void;
  fields: OAuthFields;
  onFieldsChange: (next: OAuthFields) => void;
}) {
  const set = (part: Partial<OAuthFields>) => onFieldsChange({ ...fields, ...part });
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">OAuth 2.0</legend>
      <p className="text-xs text-muted-foreground">
        Optional: if your receiver wants an access token from its authorization server (the OAuth
        2.0 client credentials grant), HyFib gets one as the client below and sends it as an
        Authorization header with every delivery. The client secret is stored encrypted and never
        shown again.
      </p>
      {stored ? (
        <>
          <p className="text-sm break-all">{webhookOAuthText(stored)}.</p>
          {(
            [
              ['keep', 'Keep the OAuth client'],
              ['set', 'Change the OAuth client'],
              ['remove', 'Remove the OAuth client (stop getting tokens)'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${prefix}-oauth-change`}
                checked={change === value}
                onChange={() => onChangeChange(value)}
              />
              {label}
            </label>
          ))}
        </>
      ) : (
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${prefix}-oauth`}
            checked={change === 'set'}
            onChange={(e) => onChangeChange(e.target.checked ? 'set' : 'keep')}
          />
          <Label htmlFor={`${prefix}-oauth`} className="font-normal">
            Get an OAuth access token for each delivery
          </Label>
        </div>
      )}
      {change === 'set' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id={`${prefix}-oauth-token-url`}
            label="Token URL"
            description="The authorization server’s https:// token endpoint."
          >
            {(aria) => (
              <Input
                {...aria}
                type="url"
                inputMode="url"
                maxLength={WEBHOOK_LIMITS.urlLength}
                autoComplete="off"
                placeholder="https://auth.example.com/oauth2/token"
                value={fields.tokenUrl}
                onChange={(e) => set({ tokenUrl: e.target.value })}
              />
            )}
          </Field>
          <Field id={`${prefix}-oauth-client-id`} label="Client ID">
            {(aria) => (
              <Input
                {...aria}
                maxLength={WEBHOOK_LIMITS.oauthClientIdLength}
                autoComplete="off"
                value={fields.clientId}
                onChange={(e) => set({ clientId: e.target.value })}
              />
            )}
          </Field>
          <Field
            id={`${prefix}-oauth-client-secret`}
            label="Client secret"
            description={
              stored
                ? 'Leave empty to keep the stored secret, unless the token URL changes.'
                : undefined
            }
          >
            {(aria) => (
              <Input
                {...aria}
                type="password"
                maxLength={WEBHOOK_LIMITS.oauthClientSecretLength}
                autoComplete="new-password"
                value={fields.clientSecret}
                onChange={(e) => set({ clientSecret: e.target.value })}
              />
            )}
          </Field>
          <Field
            id={`${prefix}-oauth-scope`}
            label="Scope"
            description="Optional: the values the server expects, separated by spaces."
          >
            {(aria) => (
              <Input
                {...aria}
                maxLength={WEBHOOK_LIMITS.oauthScopeLength}
                autoComplete="off"
                value={fields.scope}
                onChange={(e) => set({ scope: e.target.value })}
              />
            )}
          </Field>
        </div>
      ) : null}
    </fieldset>
  );
}

/** The fields for a client: the stored one's, without its secret, or empty. */
const oauthFieldsOf = (stored: WebhookEndpointOAuth | null | undefined): OAuthFields => ({
  tokenUrl: stored?.tokenUrl ?? '',
  clientId: stored?.clientId ?? '',
  clientSecret: '',
  scope: stored?.scope ?? '',
});

/**
 * Adds an endpoint, or edits one (`endpoint` given). A new endpoint's secret is shown here once,
 * and stays on screen after the list updates.
 */
export function WebhookEndpointForm({
  slug,
  endpoint,
  automationChoices,
  channelChoices,
  teamChoices,
  templateChoices,
  campaignChoices,
  pipelineChoices,
  stageChoices,
  ownerChoices,
  assigneeChoices,
  contactFieldChoices,
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
    messageSenders: WebhookMessageSender[] | null;
    contactParts: WebhookContactPart[] | null;
    /** The custom fields it names (ADR-184), deleted ones without a label; null for every field. */
    contactFields: WebhookEndpointField[] | null;
    automationIds: string[] | null;
    campaignStatuses: WebhookCampaignStatus[] | null;
    orderStatuses: WebhookOrderStatus[] | null;
    templateStatuses: WebhookTemplateStatus[] | null;
    conversationStatuses: WebhookConversationStatus[] | null;
    runEndStatuses: WebhookRunEndStatus[] | null;
    /** What started the runs it takes (ADR-183); null for every run. */
    runTriggers: WebhookRunTrigger[] | null;
    /** The consent changes it takes (ADR-189); null for every change. */
    consentChanges: WebhookConsentChange[] | null;
    /** Where the contacts it takes as `contact.created` came from (ADR-190); null for every one. */
    contactSources: ContactSource[] | null;
    /** The types of the received messages it takes (ADR-191); null for every type. */
    messageTypes: WebhookReceivedMessageType[] | null;
    /** Why the runs it takes ended (ADR-192), narrowing the ends they belong to; null: every one. */
    runEndReasons: AutomationEndReason[] | null;
    channelIds: string[] | null;
    /** The teams it names (ADR-174), deleted ones without a name; null for every team. */
    teams: WebhookEndpointTeam[] | null;
    /** The templates it names (ADR-175); null for every template. */
    templateIds: string[] | null;
    /** The campaigns it names (ADR-185), with their names and statuses; null for every campaign. */
    campaigns: WebhookEndpointCampaign[] | null;
    /** The CRM pipelines it names (ADR-263), with whether they are archived; null for every one. */
    pipelines: WebhookEndpointPipeline[] | null;
    /** The CRM stages it names (ADR-264), with their pipelines; null for every one. */
    stages: WebhookEndpointStage[] | null;
    /** The members whose deals it takes (ADR-265), with whether they can own deals; null: all. */
    owners: WebhookEndpointOwner[] | null;
    /** The members whose tasks it takes (ADR-266), with whether they can be assigned; null: all. */
    taskAssignees: WebhookEndpointOwner[] | null;
    /** The members it names (ADR-181), with whether they still take conversations; null: all. */
    assignees: WebhookEndpointAssignee[] | null;
    oauth: WebhookEndpointOAuth | null;
  };
  /** The company's published automations, which an endpoint can choose (ADR-145). */
  automationChoices: WebhookAutomationChoice[];
  /** The company's WhatsApp numbers, which an endpoint can choose (ADR-170). */
  channelChoices: WebhookChannelChoice[];
  /** The company's teams, which an endpoint can choose (ADR-174). */
  teamChoices: WebhookTeamChoice[];
  /** The company's templates, which an endpoint can choose (ADR-175). */
  templateChoices: WebhookTemplateChoice[];
  /** The company's newest campaigns, which an endpoint can choose, and whether there are more. */
  campaignChoices: { campaigns: WebhookCampaignChoice[]; more: boolean };
  /** The CRM pipelines the company uses, which an endpoint can choose (ADR-263). */
  pipelineChoices: WebhookPipelineChoice[];
  /** The stages in use of the pipelines the company uses, which an endpoint can choose (ADR-264). */
  stageChoices: WebhookStageChoice[];
  /**
   * The company's members who can own deals and be assigned tasks, whom an endpoint can choose as
   * deal owners (ADR-265) and task assignees (ADR-266).
   */
  ownerChoices: WebhookOwnerChoice[];
  /** The company's members who take conversations, whom an endpoint can choose (ADR-181). */
  assigneeChoices: WebhookAssigneeChoice[];
  /** The company's custom fields, which an endpoint can choose (ADR-184). */
  contactFieldChoices: WebhookFieldChoice[];
  atLimit?: boolean;
}) {
  const prefix = useId();
  const [url, setUrl] = useState(endpoint?.url ?? '');
  const [description, setDescription] = useState(endpoint?.description ?? '');
  const [eventTypes, setEventTypes] = useState<WebhookEventType[]>(endpoint?.eventTypes ?? []);
  const [statuses, setStatuses] = useState<WebhookMessageStatus[]>(
    endpoint?.messageStatuses ?? [...WEBHOOK_MESSAGE_STATUSES],
  );
  const [senders, setSenders] = useState<WebhookMessageSender[]>(
    endpoint?.messageSenders ?? [...WEBHOOK_MESSAGE_SENDERS],
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
  const [runTriggers, setRunTriggers] = useState<WebhookRunTrigger[]>(
    endpoint?.runTriggers ?? [...WEBHOOK_RUN_TRIGGERS],
  );
  const [consentChanges, setConsentChanges] = useState<WebhookConsentChange[]>(
    endpoint?.consentChanges ?? [...WEBHOOK_CONSENT_CHANGES],
  );
  const [contactSources, setContactSources] = useState<ContactSource[]>(
    endpoint?.contactSources ?? [...WEBHOOK_CONTACT_SOURCES],
  );
  const [messageTypes, setMessageTypes] = useState<WebhookReceivedMessageType[]>(
    endpoint?.messageTypes ?? [...WEBHOOK_RECEIVED_MESSAGE_TYPES],
  );
  const [runEndReasons, setRunEndReasons] = useState<AutomationEndReason[]>(
    webhookRunEndReasonsTicked(endpoint?.runEndReasons ?? null),
  );
  const [everyAutomation, setEveryAutomation] = useState(!endpoint?.automationIds);
  const [automationIds, setAutomationIds] = useState<string[]>(endpoint?.automationIds ?? []);
  const [everyChannel, setEveryChannel] = useState(!endpoint?.channelIds);
  const [channelIds, setChannelIds] = useState<string[]>(endpoint?.channelIds ?? []);
  const [everyTeam, setEveryTeam] = useState(!endpoint?.teams);
  const [teamIds, setTeamIds] = useState<string[]>(endpoint?.teams?.map((t) => t.id) ?? []);
  const [everyTemplate, setEveryTemplate] = useState(!endpoint?.templateIds);
  const [templateIds, setTemplateIds] = useState<string[]>(endpoint?.templateIds ?? []);
  const [everyCampaign, setEveryCampaign] = useState(!endpoint?.campaigns);
  const [campaignIds, setCampaignIds] = useState<string[]>(
    endpoint?.campaigns?.map((c) => c.id) ?? [],
  );
  const [everyPipeline, setEveryPipeline] = useState(!endpoint?.pipelines);
  const [pipelineIds, setPipelineIds] = useState<string[]>(
    endpoint?.pipelines?.map((p) => p.id) ?? [],
  );
  const [everyStage, setEveryStage] = useState(!endpoint?.stages);
  const [stageIds, setStageIds] = useState<string[]>(endpoint?.stages?.map((st) => st.id) ?? []);
  const [everyOwner, setEveryOwner] = useState(!endpoint?.owners);
  const [ownerIds, setOwnerIds] = useState<string[]>(endpoint?.owners?.map((m) => m.id) ?? []);
  const [everyTaskAssignee, setEveryTaskAssignee] = useState(!endpoint?.taskAssignees);
  const [taskAssigneeIds, setTaskAssigneeIds] = useState<string[]>(
    endpoint?.taskAssignees?.map((m) => m.id) ?? [],
  );
  const [everyAssignee, setEveryAssignee] = useState(!endpoint?.assignees);
  const [everyField, setEveryField] = useState(!endpoint?.contactFields);
  const [fieldKeys, setFieldKeys] = useState<string[]>(
    endpoint?.contactFields?.map((f) => f.key) ?? [],
  );
  const [assigneeIds, setAssigneeIds] = useState<string[]>(
    endpoint?.assignees?.map((m) => m.id) ?? [],
  );
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  // Changing an endpoint keeps its headers unless they are given again.
  const [replaceHeaders, setReplaceHeaders] = useState(false);
  // And its OAuth client unless it is changed or removed (ADR-173).
  const [oauthChange, setOAuthChange] = useState<OAuthChange>('keep');
  const [oauthFields, setOAuthFields] = useState<OAuthFields>(oauthFieldsOf(endpoint?.oauth));
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
        // Every sender ticked takes the statuses of every message (null, ADR-172).
        const messageSenders =
          eventTypes.includes('message.status') && senders.length < WEBHOOK_MESSAGE_SENDERS.length
            ? senders
            : null;
        // Every part ticked takes every change, including parts added later (null).
        const contactParts =
          eventTypes.includes('contact.updated') && parts.length < WEBHOOK_CONTACT_PARTS.length
            ? parts
            : null;
        // Every custom field's changes unless the fields ticked are chosen (ADR-184).
        const chosenFields =
          webhookTakesFieldChanges(eventTypes, contactParts) && !everyField ? fieldKeys : null;
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
        // Every way a run starts ticked takes every run (null, ADR-183).
        const chosenRunTriggers =
          webhookTakesAutomationRuns(eventTypes) && runTriggers.length < WEBHOOK_RUN_TRIGGERS.length
            ? runTriggers
            : null;
        // Every consent change ticked takes every change (null, ADR-189).
        const chosenConsentChanges =
          eventTypes.includes('consent.changed') &&
          consentChanges.length < WEBHOOK_CONSENT_CHANGES.length
            ? consentChanges
            : null;
        // Every source ticked takes every new contact (null, ADR-190).
        const chosenContactSources =
          eventTypes.includes('contact.created') &&
          contactSources.length < WEBHOOK_CONTACT_SOURCES.length
            ? contactSources
            : null;
        // Every message type ticked takes every received message (null, ADR-191).
        const chosenMessageTypes =
          eventTypes.includes('message.received') &&
          messageTypes.length < WEBHOOK_RECEIVED_MESSAGE_TYPES.length
            ? messageTypes
            : null;
        // Every reason ticked of an end takes its every run; those ticked narrow the others (ADR-192).
        const chosenRunEndReasons = eventTypes.includes('automation.run_ended')
          ? webhookRunEndReasonsChosen(chosenRunEndStatuses, runEndReasons)
          : null;
        // Every number's events unless the numbers ticked are chosen (ADR-170).
        const chosenChannels =
          webhookTakesChannelEvents(eventTypes) && !everyChannel ? channelIds : null;
        // Every conversation's events unless the teams ticked are chosen (ADR-174).
        const chosenTeams = webhookTakesTeamEvents(eventTypes) && !everyTeam ? teamIds : null;
        // Every template's statuses and changes unless the templates ticked are chosen (ADR-175).
        const chosenTemplates =
          webhookTakesTemplateEvents(eventTypes) && !everyTemplate ? templateIds : null;
        // Every campaign's statuses and changes unless the campaigns ticked are chosen (ADR-185).
        const chosenCampaigns =
          webhookTakesCampaignEvents(eventTypes) && !everyCampaign ? campaignIds : null;
        // Every deal's events unless the pipelines ticked are chosen (ADR-263).
        const chosenPipelines =
          webhookTakesPipelineEvents(eventTypes) && !everyPipeline ? pipelineIds : null;
        // Every stage's deals unless the stages ticked are chosen (ADR-264).
        const chosenStages =
          webhookTakesPipelineEvents(eventTypes) && !everyStage ? stageIds : null;
        // Every deal's events unless the owners ticked are chosen (ADR-265).
        const chosenOwners =
          webhookTakesPipelineEvents(eventTypes) && !everyOwner ? ownerIds : null;
        // Every task's events unless the assignees ticked are chosen (ADR-266).
        const chosenTaskAssignees =
          webhookTakesTaskEvents(eventTypes) && !everyTaskAssignee ? taskAssigneeIds : null;
        // Every conversation's events unless the members ticked are chosen (ADR-181).
        const chosenAssignees =
          webhookTakesTeamEvents(eventTypes) && !everyAssignee ? assigneeIds : null;
        const input = {
          url,
          description,
          eventTypes,
          messageStatuses,
          messageSenders,
          contactParts,
          contactFieldKeys: chosenFields,
          automationIds: chosenAutomations,
          campaignStatuses: chosenCampaignStatuses,
          orderStatuses: chosenOrderStatuses,
          templateStatuses: chosenTemplateStatuses,
          conversationStatuses: chosenConversationStatuses,
          runEndStatuses: chosenRunEndStatuses,
          runTriggers: chosenRunTriggers,
          consentChanges: chosenConsentChanges,
          contactSources: chosenContactSources,
          messageTypes: chosenMessageTypes,
          runEndReasons: chosenRunEndReasons,
          channelIds: chosenChannels,
          teamIds: chosenTeams,
          templateIds: chosenTemplates,
          campaignIds: chosenCampaigns,
          pipelineIds: chosenPipelines,
          stageIds: chosenStages,
          ownerIds: chosenOwners,
          taskAssigneeIds: chosenTaskAssignees,
          assigneeIds: chosenAssignees,
        };
        const done = (r: { ok: true } | { ok: false; code: string; message: string }) => {
          setBusy(false);
          if (!r.ok) setError(r);
        };
        // The OAuth client to set (ADR-173); an empty secret keeps the stored one.
        const oauth = {
          tokenUrl: oauthFields.tokenUrl,
          clientId: oauthFields.clientId,
          scope: oauthFields.scope,
          ...(oauthFields.clientSecret ? { clientSecret: oauthFields.clientSecret } : {}),
        };
        if (endpoint) {
          void updateWebhookEndpointAction(slug, {
            ...input,
            endpointId: endpoint.id,
            ...(replaceHeaders ? { headers } : {}),
            ...(oauthChange === 'set'
              ? { oauth }
              : oauthChange === 'remove'
                ? { oauth: null }
                : {}),
          }).then((r) => {
            done(r);
            if (r.ok) {
              setSaved('Endpoint saved.');
              setHeaders([]);
              setReplaceHeaders(false);
              setOAuthChange('keep');
              setOAuthFields((fields) => ({ ...fields, clientSecret: '' }));
            }
          });
        } else {
          void createWebhookEndpointAction(slug, {
            ...input,
            headers,
            oauth: oauthChange === 'set' ? oauth : null,
          }).then((r) => {
            done(r);
            if (r.ok) {
              setSecret(r.data.secret);
              setUrl('');
              setDescription('');
              setEventTypes([]);
              setStatuses([...WEBHOOK_MESSAGE_STATUSES]);
              setSenders([...WEBHOOK_MESSAGE_SENDERS]);
              setParts([...WEBHOOK_CONTACT_PARTS]);
              setCampaignStatuses([...WEBHOOK_CAMPAIGN_STATUSES]);
              setOrderStatuses([...WEBHOOK_ORDER_STATUSES]);
              setTemplateStatuses([...WEBHOOK_TEMPLATE_STATUSES]);
              setConversationStatuses([...WEBHOOK_CONVERSATION_STATUSES]);
              setRunEndStatuses([...WEBHOOK_RUN_END_STATUSES]);
              setRunTriggers([...WEBHOOK_RUN_TRIGGERS]);
              setConsentChanges([...WEBHOOK_CONSENT_CHANGES]);
              setContactSources([...WEBHOOK_CONTACT_SOURCES]);
              setMessageTypes([...WEBHOOK_RECEIVED_MESSAGE_TYPES]);
              setRunEndReasons([...WEBHOOK_RUN_END_REASONS]);
              setEveryAutomation(true);
              setAutomationIds([]);
              setEveryChannel(true);
              setChannelIds([]);
              setEveryTeam(true);
              setTeamIds([]);
              setEveryTemplate(true);
              setTemplateIds([]);
              setEveryCampaign(true);
              setCampaignIds([]);
              setEveryPipeline(true);
              setPipelineIds([]);
              setEveryStage(true);
              setStageIds([]);
              setEveryOwner(true);
              setOwnerIds([]);
              setEveryTaskAssignee(true);
              setTaskAssigneeIds([]);
              setEveryAssignee(true);
              setAssigneeIds([]);
              setEveryField(true);
              setFieldKeys([]);
              setHeaders([]);
              setOAuthChange('keep');
              setOAuthFields(oauthFieldsOf(null));
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
        senders={senders}
        onSendersChange={setSenders}
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
        consentChanges={consentChanges}
        onConsentChangesChange={setConsentChanges}
        contactSources={contactSources}
        onContactSourcesChange={setContactSources}
        messageTypes={messageTypes}
        onMessageTypesChange={setMessageTypes}
        runEndReasons={runEndReasons}
        onRunEndReasonsChange={setRunEndReasons}
      />
      {webhookTakesFieldChanges(eventTypes, parts) ? (
        <FieldChoices
          prefix={prefix}
          choices={contactFieldChoices}
          stored={endpoint?.contactFields ?? []}
          every={everyField}
          onEveryChange={setEveryField}
          chosen={fieldKeys}
          onChange={setFieldKeys}
        />
      ) : null}
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
      {webhookTakesAutomationRuns(eventTypes) ? (
        <TriggerChoices prefix={prefix} chosen={runTriggers} onChange={setRunTriggers} />
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
      {webhookTakesTemplateEvents(eventTypes) ? (
        <TemplateChoices
          prefix={prefix}
          choices={templateChoices}
          every={everyTemplate}
          onEveryChange={setEveryTemplate}
          chosen={templateIds}
          onChange={setTemplateIds}
        />
      ) : null}
      {webhookTakesCampaignEvents(eventTypes) ? (
        <CampaignChoices
          prefix={prefix}
          choices={campaignChoices.campaigns}
          more={campaignChoices.more}
          stored={endpoint?.campaigns ?? []}
          every={everyCampaign}
          onEveryChange={setEveryCampaign}
          chosen={campaignIds}
          onChange={setCampaignIds}
        />
      ) : null}
      {webhookTakesTeamEvents(eventTypes) ? (
        <TeamChoices
          prefix={prefix}
          choices={teamChoices}
          stored={endpoint?.teams ?? []}
          every={everyTeam}
          onEveryChange={setEveryTeam}
          chosen={teamIds}
          onChange={setTeamIds}
        />
      ) : null}
      {webhookTakesTeamEvents(eventTypes) ? (
        <AssigneeChoices
          prefix={prefix}
          choices={assigneeChoices}
          stored={endpoint?.assignees ?? []}
          every={everyAssignee}
          onEveryChange={setEveryAssignee}
          chosen={assigneeIds}
          onChange={setAssigneeIds}
        />
      ) : null}
      {webhookTakesPipelineEvents(eventTypes) ? (
        <PipelineChoices
          prefix={prefix}
          choices={pipelineChoices}
          stored={endpoint?.pipelines ?? []}
          every={everyPipeline}
          onEveryChange={setEveryPipeline}
          chosen={pipelineIds}
          onChange={setPipelineIds}
        />
      ) : null}
      {webhookTakesPipelineEvents(eventTypes) ? (
        <StageChoices
          prefix={prefix}
          choices={stageChoices}
          stored={endpoint?.stages ?? []}
          every={everyStage}
          onEveryChange={setEveryStage}
          chosen={stageIds}
          onChange={setStageIds}
        />
      ) : null}
      {webhookTakesPipelineEvents(eventTypes) ? (
        <CrmMemberChoices
          kind="owners"
          prefix={prefix}
          choices={ownerChoices}
          stored={endpoint?.owners ?? []}
          every={everyOwner}
          onEveryChange={setEveryOwner}
          chosen={ownerIds}
          onChange={setOwnerIds}
        />
      ) : null}
      {webhookTakesTaskEvents(eventTypes) ? (
        <CrmMemberChoices
          kind="taskAssignees"
          prefix={prefix}
          choices={ownerChoices}
          stored={endpoint?.taskAssignees ?? []}
          every={everyTaskAssignee}
          onEveryChange={setEveryTaskAssignee}
          chosen={taskAssigneeIds}
          onChange={setTaskAssigneeIds}
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
      <OAuthClientFields
        prefix={prefix}
        stored={endpoint?.oauth ?? null}
        change={oauthChange}
        onChangeChange={setOAuthChange}
        fields={oauthFields}
        onFieldsChange={setOAuthFields}
      />
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
