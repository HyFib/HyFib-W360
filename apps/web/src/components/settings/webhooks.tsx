'use client';
import { useId, useState } from 'react';
import { Alert, Button, Checkbox, Field, Input, Label, Select, Textarea } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import { WebhookOAuthPublicKeyDetails } from './webhook-oauth-public-key';
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
  WEBHOOK_CRM_CHANGE_MAKER_LABELS,
  WEBHOOK_CRM_CHANGE_MAKERS,
  WEBHOOK_SURVEY_SCORE_LABELS,
  WEBHOOK_SURVEY_SCORES,
  WEBHOOK_MESSAGE_SENDERS,
  WEBHOOK_MESSAGE_STATUS_LABELS,
  WEBHOOK_MESSAGE_STATUSES,
  WEBHOOK_OAUTH_CLIENT_AUTHENTICATION_LABELS,
  WEBHOOK_OAUTH_CLIENT_AUTHENTICATIONS,
  WEBHOOK_OAUTH_KEY_ALGORITHM_CHOICES,
  WEBHOOK_OAUTH_KEY_ALGORITHM_LABELS,
  WEBHOOK_ORDER_STATUS_LABELS,
  WEBHOOK_ORDER_STATUSES,
  WEBHOOK_PAYMENT_LINK_STATUS_LABELS,
  WEBHOOK_COD_ANSWER_LABELS,
  WEBHOOK_COD_ANSWERS,
  WEBHOOK_ORDER_MESSAGE_EVENT_LABELS,
  WEBHOOK_ORDER_MESSAGE_EVENTS,
  WEBHOOK_ORDER_MESSAGE_SKIP_REASONS,
  WEBHOOK_CART_REMINDERS,
  WEBHOOK_CART_REMINDER_SKIP_REASONS,
  WEBHOOK_CAMPAIGN_SKIP_REASONS,
  WEBHOOK_PAYMENT_LINK_STATUSES,
  WEBHOOK_RUN_STEP_OUTCOME_LABELS,
  WEBHOOK_RUN_STEP_OUTCOMES,
  WEBHOOK_RUN_STEP_NODE_TYPE_LABELS,
  WEBHOOK_RUN_STEP_NODE_TYPES,
  WEBHOOK_ORDER_CHANGE_MAKER_LABELS,
  WEBHOOK_ORDER_CHANGE_MAKERS,
  WEBHOOK_DEAL_STATUS_LABELS,
  WEBHOOK_DEAL_STATUSES,
  WEBHOOK_TASK_STATUS_LABELS,
  WEBHOOK_TASK_STATUSES,
  WEBHOOK_DEAL_DETAIL_LABELS,
  WEBHOOK_DEAL_DETAILS,
  WEBHOOK_TASK_DETAIL_LABELS,
  WEBHOOK_TASK_DETAILS,
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
  webhookStoreText,
  webhookTakesStoreEvents,
  webhookTakesOrderMessages,
  webhookTakesCartReminders,
  webhookChannelText,
  webhookContactFieldConditionText,
  webhookContactFieldKind,
  webhookContactFieldValueId,
  webhookFieldConditionEditable,
  webhookFieldRangeFromInputs,
  webhookFieldText,
  webhookFieldValuesFromLines,
  webhookFieldValueText,
  webhookFieldWordsFromLines,
  webhookMessageWordsFromLines,
  webhookOAuthSignsJwts,
  webhookOAuthText,
  WEBHOOK_OAUTH_JWKS_HINT,
  webhookOwnerText,
  webhookPipelineText,
  webhookReplayAllSummary,
  webhookReplaySummary,
  webhookApiKeyText,
  webhookRunEndReasonsChosen,
  webhookRunEndReasonsTicked,
  webhookStageText,
  webhookTakesAutomationRuns,
  webhookTakesCampaignEvents,
  webhookTakesChannelEvents,
  webhookTakesFieldChanges,
  webhookTakesPipelineEvents,
  webhookTakesTaskEvents,
  webhookTakesNoteEvents,
  webhookTakesCrmChanges,
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
  type WebhookCodAnswer,
  type WebhookOrderMessageEvent,
  type WebhookOrderMessageSkipReason,
  type WebhookCartReminder,
  type WebhookCartReminderSkipReason,
  type WebhookCampaignSkipReason,
  type WebhookStoreChoice,
  type WebhookEndpointStore,
  type WebhookContactFieldValue,
  type WebhookContactPart,
  type WebhookCrmChangeMaker,
  type WebhookSurveyScore,
  type WebhookConversationStatus,
  type WebhookEndpointAssignee,
  type WebhookEndpointCampaign,
  type WebhookEndpointField,
  type WebhookEndpointOAuth,
  type WebhookOAuthClientAuth,
  type WebhookOAuthKeyAlgorithm,
  type WebhookOAuthNextKeyAction,
  type WebhookEndpointOwner,
  type WebhookEndpointPipeline,
  type WebhookEndpointApiKey,
  type WebhookEndpointStage,
  type WebhookEndpointTeam,
  type WebhookEventType,
  type WebhookFailureKind,
  type WebhookFieldChoice,
  type WebhookMessageSender,
  type WebhookMessageStatus,
  type WebhookOrderStatus,
  type WebhookPaymentLinkStatus,
  type WebhookRunStepOutcome,
  type WebhookRunStepNodeType,
  type WebhookOrderChangeMaker,
  type WebhookDealStatus,
  type WebhookTaskStatus,
  type WebhookDealDetail,
  type WebhookTaskDetail,
  type WebhookOwnerChoice,
  type WebhookPipelineChoice,
  type WebhookReplayPeriod,
  type WebhookApiKeyChoice,
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
  STORE_MESSAGE_EVENT_INFO,
  STORE_MESSAGE_SKIP_REASONS,
} from '@w360/domain/store-messages-model';
import { SKIP_REASONS as CAMPAIGN_SKIP_REASON_LABELS } from '@/lib/campaign-labels';
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
 * The scores of the satisfaction survey answers an endpoint takes (ADR-307), shown while it takes
 * the event: every answer unless some scores are unticked.
 */
function ScoreChoices({
  prefix,
  chosen,
  onChange,
}: {
  prefix: string;
  chosen: WebhookSurveyScore[];
  onChange: (next: WebhookSurveyScore[]) => void;
}) {
  return (
    <fieldset className="ml-6 grid gap-1">
      <legend className="mb-1 text-xs text-muted-foreground">
        Answers scored (all of them unless you untick some)
      </legend>
      {WEBHOOK_SURVEY_SCORES.map((score) => {
        const id = `${prefix}-survey-score-${score}`;
        return (
          <div key={score} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={chosen.includes(score)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? WEBHOOK_SURVEY_SCORES.filter((s) => s === score || chosen.includes(s))
                    : chosen.filter((s) => s !== score),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {WEBHOOK_SURVEY_SCORE_LABELS[score]}{' '}
              <span className="font-mono text-xs">({score})</span>
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * Who made the changes whose deal, task and note events an endpoint takes (ADR-306), shown while it
 * takes one of those events: every change unless some makers are unticked. A change whose maker was
 * not recorded is sent whichever are ticked.
 */
function ChangeMakerChoices({
  prefix,
  chosen,
  onChange,
}: {
  prefix: string;
  chosen: WebhookCrmChangeMaker[];
  onChange: (next: WebhookCrmChangeMaker[]) => void;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Changes made by</legend>
      <p className="text-xs text-muted-foreground">
        A deal’s or task’s events belong to whoever made the change (an addition to whoever added
        it), and a note’s to whoever wrote it. Untick API keys to leave out what your integrations
        change through the API. A change HyFib did not record the maker of is sent whichever are
        ticked. Other events are sent whoever made them.
      </p>
      {WEBHOOK_CRM_CHANGE_MAKERS.map((maker) => {
        const id = `${prefix}-change-maker-${maker}`;
        return (
          <div key={maker} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={chosen.includes(maker)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? WEBHOOK_CRM_CHANGE_MAKERS.filter((m) => m === maker || chosen.includes(m))
                    : chosen.filter((m) => m !== maker),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {WEBHOOK_CRM_CHANGE_MAKER_LABELS[maker]}{' '}
              <span className="font-mono text-xs">({maker})</span>
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * Who made the order status changes an endpoint takes (ADR-322), shown while it takes Order status:
 * every change unless some makers are unticked. A change whose maker was not recorded is sent
 * whichever are ticked.
 */
function OrderChangeMakerChoices({
  prefix,
  chosen,
  onChange,
}: {
  prefix: string;
  chosen: WebhookOrderChangeMaker[];
  onChange: (next: WebhookOrderChangeMaker[]) => void;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Order changes made by</legend>
      <p className="text-xs text-muted-foreground">
        An order’s status change belongs to whoever made it: a member on the order page, an API key,
        or HyFib applying what Razorpay reports for the order’s Payment Link. Untick API keys to
        leave out what your integrations change through the API. A change HyFib did not record the
        maker of is sent whichever are ticked, and new orders are sent whoever is ticked.
      </p>
      {WEBHOOK_ORDER_CHANGE_MAKERS.map((maker) => {
        const id = `${prefix}-order-change-maker-${maker}`;
        return (
          <div key={maker} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={chosen.includes(maker)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? WEBHOOK_ORDER_CHANGE_MAKERS.filter((m) => m === maker || chosen.includes(m))
                    : chosen.filter((m) => m !== maker),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {WEBHOOK_ORDER_CHANGE_MAKER_LABELS[maker]}{' '}
              <span className="font-mono text-xs">({maker})</span>
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
        Automation started, Automation ended and Automation step are sent for the runs started by
        the ways ticked (all of them unless you untick some).
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
 * The outcomes of the run steps an endpoint takes as `automation.run_step` (ADR-327), shown while
 * it takes the event: every step unless some outcomes are unticked, in the order the run's log
 * names them.
 */
function StepOutcomeChoices({
  prefix,
  chosen,
  onChange,
}: {
  prefix: string;
  chosen: WebhookRunStepOutcome[];
  onChange: (next: WebhookRunStepOutcome[]) => void;
}) {
  return (
    <fieldset className="ml-6 grid gap-1">
      <legend className="mb-1 text-xs text-muted-foreground">
        Steps sent (all of them unless you untick some; a step&rsquo;s outcome is what it did, as
        the run&rsquo;s page lists it)
      </legend>
      {WEBHOOK_RUN_STEP_OUTCOMES.map((outcome) => {
        const id = `${prefix}-step-outcome-${outcome}`;
        return (
          <div key={outcome} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={chosen.includes(outcome)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? WEBHOOK_RUN_STEP_OUTCOMES.filter((o) => o === outcome || chosen.includes(o))
                    : chosen.filter((o) => o !== outcome),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {WEBHOOK_RUN_STEP_OUTCOME_LABELS[outcome]}{' '}
              <span className="font-mono text-xs">({outcome})</span>
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * The answers an endpoint takes as `store_order.cod_answered` (ADR-349), shown while it takes the
 * event: both unless one is unticked, in the order the store's confirmation offers them.
 */
function CodAnswerChoices({
  prefix,
  chosen,
  onChange,
}: {
  prefix: string;
  chosen: WebhookCodAnswer[];
  onChange: (next: WebhookCodAnswer[]) => void;
}) {
  return (
    <fieldset className="ml-6 grid gap-1">
      <legend className="mb-1 text-xs text-muted-foreground">
        Answers sent (both unless you untick one)
      </legend>
      {WEBHOOK_COD_ANSWERS.map((answer) => {
        const id = `${prefix}-cod-answer-${answer}`;
        return (
          <div key={answer} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={chosen.includes(answer)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? WEBHOOK_COD_ANSWERS.filter((a) => a === answer || chosen.includes(a))
                    : chosen.filter((a) => a !== answer),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {WEBHOOK_COD_ANSWER_LABELS[answer]}{' '}
              <span className="font-mono text-xs">({answer})</span>
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * The order messages whose skips and sends an endpoint takes as `store_order.message_skipped`
 * (ADR-352) and `store_order.message_sent` (ADR-353), shown while it takes either: all five unless
 * some are unticked, in the order a store's order messages list them.
 */
function OrderMessageChoices({
  prefix,
  chosen,
  onChange,
}: {
  prefix: string;
  chosen: WebhookOrderMessageEvent[];
  onChange: (next: WebhookOrderMessageEvent[]) => void;
}) {
  return (
    <fieldset className="grid gap-1">
      <legend className="mb-1 text-sm font-medium">Order messages</legend>
      <p className="mb-1 text-xs text-muted-foreground">
        The order message events the endpoint takes are sent for the messages ticked (all five
        unless you untick some).
      </p>
      {WEBHOOK_ORDER_MESSAGE_EVENTS.map((event) => {
        const id = `${prefix}-order-message-${event}`;
        return (
          <div key={event} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={chosen.includes(event)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? WEBHOOK_ORDER_MESSAGE_EVENTS.filter((m) => m === event || chosen.includes(m))
                    : chosen.filter((m) => m !== event),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {WEBHOOK_ORDER_MESSAGE_EVENT_LABELS[event]}{' '}
              <span className="font-mono text-xs">({event})</span>
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * The cart reminders whose skips and sends an endpoint takes as `store_checkout.reminder_skipped`
 * and `store_checkout.reminder_sent` (ADR-361), shown while it takes either: both unless one is
 * unticked, the first then the second, as a store's Messages page names them.
 */
function CartReminderChoices({
  prefix,
  chosen,
  onChange,
}: {
  prefix: string;
  chosen: WebhookCartReminder[];
  onChange: (next: WebhookCartReminder[]) => void;
}) {
  return (
    <fieldset className="grid gap-1">
      <legend className="mb-1 text-sm font-medium">Cart reminders</legend>
      <p className="mb-1 text-xs text-muted-foreground">
        The cart reminder events the endpoint takes are sent for the reminders ticked (both unless
        you untick one).
      </p>
      {WEBHOOK_CART_REMINDERS.map((reminder) => {
        const id = `${prefix}-cart-reminder-${reminder}`;
        return (
          <div key={reminder} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={chosen.includes(reminder)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? WEBHOOK_CART_REMINDERS.filter((r) => r === reminder || chosen.includes(r))
                    : chosen.filter((r) => r !== reminder),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {STORE_MESSAGE_EVENT_INFO[reminder].label}{' '}
              <span className="font-mono text-xs">({reminder})</span>
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * The reasons whose order message skips an endpoint takes as `store_order.message_skipped`
 * (ADR-354), shown while it takes the event: every reason unless some are unticked, in the order
 * and words a store's Messages page (Commerce → Stores) explains them.
 */
function SkipReasonChoices({
  prefix,
  chosen,
  onChange,
}: {
  prefix: string;
  chosen: WebhookOrderMessageSkipReason[];
  onChange: (next: WebhookOrderMessageSkipReason[]) => void;
}) {
  return (
    <fieldset className="ml-6 grid gap-1">
      <legend className="mb-1 text-xs text-muted-foreground">
        Order message skip reasons sent (all of them unless you untick some, as a store&rsquo;s
        Messages page explains them)
      </legend>
      {WEBHOOK_ORDER_MESSAGE_SKIP_REASONS.map((reason) => {
        const id = `${prefix}-skip-reason-${reason}`;
        return (
          <div key={reason} className="flex items-start gap-2">
            <Checkbox
              id={id}
              className="mt-0.5"
              checked={chosen.includes(reason)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? WEBHOOK_ORDER_MESSAGE_SKIP_REASONS.filter(
                        (r) => r === reason || chosen.includes(r),
                      )
                    : chosen.filter((r) => r !== reason),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {STORE_MESSAGE_SKIP_REASONS[reason]}{' '}
              <span className="font-mono text-xs">({reason})</span>
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * The reasons whose cart reminder skips an endpoint takes as `store_checkout.reminder_skipped`
 * (ADR-356), shown while it takes the event: every reason unless some are unticked, in the order
 * and words a store's Messages page (Commerce → Stores) explains them.
 */
function CartReminderSkipReasonChoices({
  prefix,
  chosen,
  onChange,
}: {
  prefix: string;
  chosen: WebhookCartReminderSkipReason[];
  onChange: (next: WebhookCartReminderSkipReason[]) => void;
}) {
  return (
    <fieldset className="ml-6 grid gap-1">
      <legend className="mb-1 text-xs text-muted-foreground">
        Cart reminder skip reasons sent (all of them unless you untick some, as a store&rsquo;s
        Messages page explains them)
      </legend>
      {WEBHOOK_CART_REMINDER_SKIP_REASONS.map((reason) => {
        const id = `${prefix}-cart-skip-reason-${reason}`;
        return (
          <div key={reason} className="flex items-start gap-2">
            <Checkbox
              id={id}
              className="mt-0.5"
              checked={chosen.includes(reason)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? WEBHOOK_CART_REMINDER_SKIP_REASONS.filter(
                        (r) => r === reason || chosen.includes(r),
                      )
                    : chosen.filter((r) => r !== reason),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {STORE_MESSAGE_SKIP_REASONS[reason]}{' '}
              <span className="font-mono text-xs">({reason})</span>
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * The reasons whose campaign recipient skips an endpoint takes as `campaign.recipient_skipped`
 * (ADR-359), shown while it takes the event: every reason unless some are unticked, in the order
 * 0006 lists them and the words a campaign's page uses for them.
 */
function CampaignSkipReasonChoices({
  prefix,
  chosen,
  onChange,
}: {
  prefix: string;
  chosen: WebhookCampaignSkipReason[];
  onChange: (next: WebhookCampaignSkipReason[]) => void;
}) {
  return (
    <fieldset className="ml-6 grid gap-1">
      <legend className="mb-1 text-xs text-muted-foreground">
        Campaign skip reasons sent (all of them unless you untick some, in the words of a
        campaign&rsquo;s page)
      </legend>
      {WEBHOOK_CAMPAIGN_SKIP_REASONS.map((reason) => {
        const id = `${prefix}-campaign-skip-reason-${reason}`;
        return (
          <div key={reason} className="flex items-start gap-2">
            <Checkbox
              id={id}
              className="mt-0.5"
              checked={chosen.includes(reason)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? WEBHOOK_CAMPAIGN_SKIP_REASONS.filter(
                        (r) => r === reason || chosen.includes(r),
                      )
                    : chosen.filter((r) => r !== reason),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {CAMPAIGN_SKIP_REASON_LABELS[reason]}{' '}
              <span className="font-mono text-xs">({reason})</span>
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * The kinds of node whose run steps an endpoint takes as `automation.run_step` (ADR-328), shown
 * while it takes the event: every step unless some kinds are unticked, in the order the automation
 * builder lists them, then the steps outside a node.
 */
function StepNodeTypeChoices({
  prefix,
  chosen,
  onChange,
}: {
  prefix: string;
  chosen: WebhookRunStepNodeType[];
  onChange: (next: WebhookRunStepNodeType[]) => void;
}) {
  return (
    <fieldset className="ml-6 grid gap-1">
      <legend className="mb-1 text-xs text-muted-foreground">
        Kinds of step sent (all of them unless you untick some; a step is sent when the kind of step
        it ran is ticked)
      </legend>
      {WEBHOOK_RUN_STEP_NODE_TYPES.map((type) => {
        const id = `${prefix}-step-node-${type}`;
        return (
          <div key={type} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={chosen.includes(type)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? WEBHOOK_RUN_STEP_NODE_TYPES.filter((t) => t === type || chosen.includes(t))
                    : chosen.filter((t) => t !== type),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {WEBHOOK_RUN_STEP_NODE_TYPE_LABELS[type]}{' '}
              <span className="font-mono text-xs">({type})</span>
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
  kind:
    'campaign' | 'order' | 'payment_link' | 'deal' | 'task' | 'template' | 'conversation' | 'run';
  statuses: readonly S[];
  labels: Record<S, string>;
  chosen: S[];
  onChange: (next: S[]) => void;
}) {
  return (
    <fieldset className="ml-6 grid gap-1">
      <legend className="mb-1 text-xs text-muted-foreground">
        Statuses sent (all of them unless you untick some; an event is the status{' '}
        {kind === 'order' ? 'an order' : kind === 'payment_link' ? 'a Payment Link' : `a ${kind}`}{' '}
        {kind === 'run' ? 'ended with' : 'reached'})
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
/**
 * The details of a deal or a task whose changes an endpoint takes (ADR-310), shown while it takes
 * the event: every change unless some details are unticked.
 */
function DetailChoices<D extends string>({
  prefix,
  kind,
  details,
  labels,
  chosen,
  onChange,
}: {
  prefix: string;
  kind: 'deal' | 'task';
  details: readonly D[];
  labels: Record<D, string>;
  chosen: D[];
  onChange: (next: D[]) => void;
}) {
  return (
    <fieldset className="ml-6 grid gap-1">
      <legend className="mb-1 text-xs text-muted-foreground">
        Changes sent (all of them unless you untick some; an event names every detail of the {kind}{' '}
        that changed)
      </legend>
      {details.map((detail) => {
        const id = `${prefix}-${kind}-detail-${detail}`;
        return (
          <div key={detail} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={chosen.includes(detail)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? details.filter((d) => d === detail || chosen.includes(d))
                    : chosen.filter((d) => d !== detail),
                )
              }
            />
            <Label htmlFor={id} className="font-normal">
              {labels[detail]} <span className="font-mono text-xs">({detail})</span>
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

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
 * The words and phrases whose received messages an endpoint takes as `message.received` (ADR-337),
 * shown while it takes the event: every message, or only those whose text contains one of them,
 * whatever its case, typed one a line and read as the service reads them.
 */
function MessageWordChoices({
  prefix,
  every,
  onEveryChange,
  text,
  onTextChange,
}: {
  prefix: string;
  every: boolean;
  onEveryChange: (next: boolean) => void;
  text: string;
  onTextChange: (next: string) => void;
}) {
  return (
    <fieldset className="ml-6 grid gap-2">
      <legend className="mb-1 text-xs text-muted-foreground">
        Received messages sent, by words
      </legend>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-message-words-every`}
          className="mt-1"
          checked={every}
          onChange={() => onEveryChange(true)}
        />
        <span>Every message, whatever its text</span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-message-words-every`}
          className="mt-1"
          checked={!every}
          onChange={() => onEveryChange(false)}
        />
        <span>
          Only the messages whose text contains any of these words or phrases
          <span className="block text-xs text-muted-foreground">
            The text, a caption, the title of a tapped reply, a reaction or a location’s name,
            whatever its case. A message without text is not sent.
          </span>
        </span>
      </label>
      {!every ? (
        <div className="ml-6">
          <Field
            id={`${prefix}-message-words`}
            label="Words and phrases"
            description={`One a line, up to ${WEBHOOK_LIMITS.messageWords}, each up to ${WEBHOOK_LIMITS.messageWordLength} characters.`}
          >
            {(aria) => (
              <Textarea
                {...aria}
                rows={3}
                autoComplete="off"
                value={text}
                onChange={(e) => onTextChange(e.target.value)}
              />
            )}
          </Field>
        </div>
      ) : null}
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
 * What the API keys' fieldset says for runs (ADR-319), messages' statuses (ADR-320) and Payment
 * Links (ADR-324), and the CRM (ADR-321) and order (ADR-323) changes left out.
 */
const API_KEY_WORDS = {
  runs: {
    legend: 'Runs started through the API',
    help: 'A run started through the API belongs to the key that started it, and to the keys that key was rotated from or into; a run started otherwise belongs to none. With automations or what started the runs chosen too, a run must pass them all.',
    every: 'Every run',
    everyHelp: 'Including runs started otherwise, and by keys added later.',
    only: 'Only the runs the API keys ticked started',
    none: 'No API key can start automations yet.',
    idPart: 'run-api-key',
  },
  messages: {
    legend: 'Messages sent through the API',
    help: 'A message sent through the API belongs to the key that sent it (a Payment Link, to the key that asked for it), and to the keys that key was rotated from or into; a message a member, an automation, a campaign or HyFib sent belongs to none. With statuses or senders chosen too, a status must pass them all.',
    every: 'Every message’s statuses',
    everyHelp: 'Including messages sent otherwise, and by keys added later.',
    only: 'Only the statuses of the messages the API keys ticked sent',
    none: 'No API key can send messages yet.',
    idPart: 'message-api-key',
  },
  crm: {
    legend: 'Deal, task and note changes made through the API',
    help: 'Leave out the changes chosen keys made, so that an integration is not sent back what it wrote: a change made through the API belongs to the key that made it, and to the keys that key was rotated from or into. Changes members and automations make are never left out here. With who made the changes chosen too, an event must pass both.',
    every: 'Every change',
    everyHelp: 'Whichever key made it.',
    only: 'Leave out the changes the API keys ticked made',
    none: 'No API key can change deals, tasks or notes yet.',
    idPart: 'crm-api-key',
  },
  orders: {
    legend: 'Order changes made through the API',
    help: 'Leave out the order status changes chosen keys made, so that an order system is not sent back what it changed: a change made through the API belongs to the key that made it (asking for payment included), and to the keys that key was rotated from or into. Changes members and Payment Links make are never left out here. With who made the order changes chosen too, a change must pass both.',
    every: 'Every order change',
    everyHelp: 'Whichever key made it.',
    only: 'Leave out the order changes the API keys ticked made',
    none: 'No API key can change orders yet.',
    idPart: 'order-api-key',
  },
  paymentLinks: {
    legend: 'Payment Links asked for through the API',
    help: 'A Payment Link asked for through the API belongs to the key that asked for it, and to the keys that key was rotated from or into; a link a member asked for belongs to none. With Payment Link statuses or numbers chosen too, a change must pass them all.',
    every: 'Every Payment Link’s changes',
    everyHelp: 'Including links members asked for, and by keys added later.',
    only: 'Only the changes of the links the API keys ticked asked for',
    none: 'No API key can ask customers to pay yet.',
    idPart: 'payment-link-api-key',
  },
} as const;

/**
 * The API keys whose runs (ADR-319) or messages' statuses (ADR-320) an endpoint takes, or whose
 * deal, task and note changes (ADR-321) or order changes (ADR-323) it leaves out, or whose Payment
 * Links' changes it takes (ADR-324), as `kind` says,
 * shown while it takes their events: every run, message or change, or only those of the keys
 * ticked, or all but theirs. The keys that can start automations, send messages, change deals,
 * tasks, notes or orders, or ask customers to pay, work and were not rotated are offered; one the
 * endpoint already names stays listed, ticked, until it is unticked.
 */
function ApiKeyChoices({
  kind,
  prefix,
  choices,
  stored,
  every,
  onEveryChange,
  chosen,
  onChange,
}: {
  kind: keyof typeof API_KEY_WORDS;
  prefix: string;
  choices: WebhookApiKeyChoice[];
  /** The keys the endpoint names now, so one that stopped working stays listed until saved. */
  stored: readonly WebhookEndpointApiKey[];
  every: boolean;
  onEveryChange: (next: boolean) => void;
  chosen: string[];
  onChange: (next: string[]) => void;
}) {
  const listed: WebhookEndpointApiKey[] = [
    ...choices.map((c): WebhookEndpointApiKey => ({ ...c, state: 'active' })),
    ...stored.filter((s) => !choices.some((c) => c.id === s.id)),
  ];
  const words = API_KEY_WORDS[kind];
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
            <span className="block text-xs text-muted-foreground">{words.none}</span>
          ) : null}
        </span>
      </label>
      {!every ? (
        <div className="ml-6 grid max-h-64 gap-1 overflow-y-auto">
          {listed.map((k) => {
            const id = `${prefix}-${words.idPart}-${k.id}`;
            return (
              <div key={k.id} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={chosen.includes(k.id)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? listed
                            .filter((l) => l.id === k.id || chosen.includes(l.id))
                            .map((l) => l.id)
                        : chosen.filter((x) => x !== k.id),
                    )
                  }
                />
                <Label htmlFor={id} className="font-normal break-all">
                  {webhookApiKeyText(k)}
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
        Message, conversation, survey answer, automation, order, Payment Link, cash on delivery
        answer, sent order message, sent cart reminder and campaign events happen on a number.
        Consent, contact, template, skipped order message, skipped cart reminder, deal, task and
        note events are sent whichever numbers are chosen.
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
 * What the teams' fieldset says for conversations' events (ADR-174) and satisfaction survey answers
 * (ADR-311).
 */
const TEAM_WORDS = {
  conversations: {
    legend: 'Teams',
    help: 'Message and conversation events belong to the team the conversation is in when they happen, and a change of team to the team it left as well. Other events are sent whichever teams are chosen.',
    every: 'Every conversation’s events',
    everyHelp: 'Including teams added later, and conversations in no team.',
    only: 'Only the events of the conversations of the teams ticked',
    idPart: 'team',
  },
  surveys: {
    legend: 'Teams of answered surveys',
    help: 'A satisfaction survey’s answer belongs to the team its conversation is in when the customer answers; a conversation in no team belongs to none. With scores or the other lists of answers chosen too, an answer must pass them all. Other events are sent whichever teams are chosen.',
    every: 'Every answer',
    everyHelp: 'Including teams added later, and conversations in no team.',
    only: 'Only the answers of the conversations of the teams ticked',
    idPart: 'survey-team',
  },
} as const;

/**
 * The teams whose conversations' events (ADR-174) or satisfaction survey answers (ADR-311) an
 * endpoint takes, as `kind` says: every conversation's, or those of the teams ticked. A team
 * deleted since it was chosen stays listed, ticked, until it is unticked: it matches no
 * conversation.
 */
function TeamChoices({
  kind,
  prefix,
  choices,
  stored,
  every,
  onEveryChange,
  chosen,
  onChange,
}: {
  kind: keyof typeof TEAM_WORDS;
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
  const words = TEAM_WORDS[kind];
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
            <span className="block text-xs text-muted-foreground">
              The company has no team yet.
            </span>
          ) : null}
        </span>
      </label>
      {!every ? (
        <div className="ml-6 grid gap-1">
          {listed.map((t) => {
            const id = `${prefix}-${words.idPart}-${t.id}`;
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
 * What the members' fieldset says for conversations' events (ADR-181) and satisfaction survey
 * answers (ADR-311).
 */
const ASSIGNEE_WORDS = {
  conversations: {
    legend: 'Members',
    help: 'Message and conversation events belong to the member the conversation is assigned to when they happen, and a change of assignee to the member it left as well. Other events are sent whichever members are chosen.',
    every: 'Every conversation’s events',
    everyHelp: 'Including unassigned conversations, and members who join later.',
    only: 'Only the events of the conversations assigned to the members ticked',
    idPart: 'assignee',
  },
  surveys: {
    legend: 'Members credited with answers',
    help: 'A satisfaction survey’s answer is credited to the member its conversation was assigned to when it was resolved, as Reports credits it; a conversation resolved unassigned credits no one. With scores or the other lists of answers chosen too, an answer must pass them all. Other events are sent whichever members are chosen.',
    every: 'Every answer',
    everyHelp: 'Including answers credited to no one, and members who join later.',
    only: 'Only the answers credited to the members ticked',
    idPart: 'survey-assignee',
  },
} as const;

/**
 * The members whose assigned conversations' events (ADR-181), or whose credited satisfaction survey
 * answers (ADR-311), an endpoint takes, as `kind` says: every conversation's or answer, or those of
 * the members ticked. A member who no longer takes conversations stays listed, ticked, until
 * unticked: they hold no conversation, and answers already credited to them still match.
 */
function AssigneeChoices({
  kind,
  prefix,
  choices,
  stored,
  every,
  onEveryChange,
  chosen,
  onChange,
}: {
  kind: keyof typeof ASSIGNEE_WORDS;
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
  const words = ASSIGNEE_WORDS[kind];
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
            <span className="block text-xs text-muted-foreground">
              No member takes conversations yet.
            </span>
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
 * The campaigns whose messages' statuses, changes and skipped recipients (ADR-358) an endpoint takes
 * (ADR-185): every campaign's, or those of the campaigns ticked. The company's newest campaigns are
 * offered; one the endpoint already names stays listed, ticked, until it is unticked.
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
        Message statuses, campaign changes and skipped recipients belong to a campaign; a message no
        campaign sent, such as a member’s reply, belongs to none. Other events are sent whichever
        campaigns are chosen.
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
          Every message’s statuses and every campaign’s changes and skipped recipients
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
 * The stores whose cash on delivery answers (ADR-349), skipped and sent order messages (ADR-352,
 * ADR-353) and cart reminders (ADR-355) an endpoint takes: every store's, or those of the stores
 * ticked. A store the endpoint names that was removed since stays listed, ticked, until it is
 * unticked.
 */
function StoreChoices({
  prefix,
  choices,
  stored,
  every,
  onEveryChange,
  chosen,
  onChange,
}: {
  prefix: string;
  choices: WebhookStoreChoice[];
  /** The stores the endpoint names now, so a removed one stays listed until it is saved without. */
  stored: readonly WebhookEndpointStore[];
  every: boolean;
  onEveryChange: (next: boolean) => void;
  chosen: string[];
  onChange: (next: string[]) => void;
}) {
  const listed: WebhookEndpointStore[] = [
    ...choices,
    ...stored.filter((s) => !choices.some((c) => c.id === s.id)),
  ];
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Stores</legend>
      <p className="text-xs text-muted-foreground">
        A cash on delivery answer or an order message, skipped or sent, belongs to the store of its
        order, and a cart reminder, skipped or sent, to the store of its checkout. Other events are
        sent whichever stores are chosen.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-stores`}
          className="mt-1"
          checked={every}
          onChange={() => onEveryChange(true)}
        />
        <span>
          Every store’s answers, order messages and cart reminders
          <span className="block text-xs text-muted-foreground">
            Including stores connected later.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-stores`}
          className="mt-1"
          checked={!every}
          disabled={listed.length === 0}
          onChange={() => onEveryChange(false)}
        />
        <span>
          Only those of the stores ticked
          {listed.length === 0 ? (
            <span className="block text-xs text-muted-foreground">
              The company has no connected store.
            </span>
          ) : null}
        </span>
      </label>
      {!every ? (
        <div className="ml-6 grid gap-1">
          {listed.map((st) => {
            const id = `${prefix}-store-${st.id}`;
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
                  {webhookStoreText(st)}
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
 * What the pipelines' fieldset says for deals' events (ADR-263), tasks' events (ADR-303) and notes'
 * events (ADR-305).
 */
const PIPELINE_WORDS = {
  deals: {
    legend: 'Pipelines',
    help: 'A deal’s events belong to its pipeline; a deal moved to another pipeline belongs to both for that move. Task and other events are sent whichever pipelines are chosen.',
    every: 'Every deal’s events',
    everyHelp: 'Including pipelines added later.',
    only: 'Only those of the deals in the pipelines ticked',
    idPart: 'pipeline',
  },
  tasks: {
    legend: 'Pipelines of tasks’ deals',
    help: 'A task’s events belong to the pipeline of the deal it is about when they happen; a task about no deal belongs to none. With task assignees, or the stages or owners of tasks’ deals chosen too, an event must pass them all. Deal and other events are sent whichever pipelines are chosen.',
    every: 'Every task’s events',
    everyHelp: 'Including tasks about no deal, and pipelines added later.',
    only: 'Only those of the tasks about deals in the pipelines ticked',
    idPart: 'task-pipeline',
  },
  notes: {
    legend: 'Pipelines of notes’ deals',
    help: 'A note’s event belongs to the pipeline of the deal it is about when it is added; a note about a contact alone belongs to none. With the stages or owners of notes’ deals chosen too, an event must pass them all. Deal, task and other events are sent whichever pipelines are chosen.',
    every: 'Every note’s events',
    everyHelp: 'Including notes about a contact alone, and pipelines added later.',
    only: 'Only those of the notes about deals in the pipelines ticked',
    idPart: 'note-pipeline',
  },
} as const;

/**
 * The CRM pipelines whose deals' events (ADR-263), deals' tasks' events (ADR-303) or deals' notes'
 * events (ADR-305) an endpoint takes, as `kind` says: every deal's, task's or note's, or those of
 * the deals in the pipelines ticked, or of the tasks or notes about them. The pipelines the company
 * uses are offered; an archived one the endpoint already names stays listed, ticked, until it is
 * unticked.
 */
function PipelineChoices({
  kind,
  prefix,
  choices,
  stored,
  every,
  onEveryChange,
  chosen,
  onChange,
}: {
  kind: keyof typeof PIPELINE_WORDS;
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
  const words = PIPELINE_WORDS[kind];
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
            <span className="block text-xs text-muted-foreground">
              The company has no pipeline yet.
            </span>
          ) : null}
        </span>
      </label>
      {!every ? (
        <div className="ml-6 grid max-h-64 gap-1 overflow-y-auto">
          {listed.map((p) => {
            const id = `${prefix}-${words.idPart}-${p.id}`;
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
 * What the stages' fieldset says for deals' events (ADR-264), tasks' events (ADR-304) and notes'
 * events (ADR-305).
 */
const STAGE_WORDS = {
  deals: {
    legend: 'Stages',
    help: 'A deal’s events belong to its stage; a deal moved to another stage belongs to both for that move. With pipelines or deal owners chosen too, an event must pass them all. Task and other events are sent whichever stages are chosen.',
    every: 'Every stage’s deals',
    everyHelp: 'Including stages added later.',
    only: 'Only those of the deals in the stages ticked',
    idPart: 'stage',
  },
  tasks: {
    legend: 'Stages of tasks’ deals',
    help: 'A task’s events belong to the stage of the deal it is about when they happen; a task about no deal belongs to none. With task assignees, or the pipelines or owners of tasks’ deals chosen too, an event must pass them all. Deal and other events are sent whichever stages are chosen.',
    every: 'Every task’s events',
    everyHelp: 'Including tasks about no deal, and stages added later.',
    only: 'Only those of the tasks about deals in the stages ticked',
    idPart: 'task-stage',
  },
  notes: {
    legend: 'Stages of notes’ deals',
    help: 'A note’s event belongs to the stage of the deal it is about when it is added; a note about a contact alone belongs to none. With the pipelines or owners of notes’ deals chosen too, an event must pass them all. Deal, task and other events are sent whichever stages are chosen.',
    every: 'Every note’s events',
    everyHelp: 'Including notes about a contact alone, and stages added later.',
    only: 'Only those of the notes about deals in the stages ticked',
    idPart: 'note-stage',
  },
} as const;

/**
 * The CRM stages whose deals' events (ADR-264), deals' tasks' events (ADR-304) or deals' notes'
 * events (ADR-305) an endpoint takes, as `kind` says: every stage's, or those of the stages ticked,
 * named with their pipelines. The stages in use of the pipelines the company uses are offered; a
 * removed one, or one of an archived pipeline, the endpoint already names stays listed, ticked,
 * until it is unticked.
 */
function StageChoices({
  kind,
  prefix,
  choices,
  stored,
  every,
  onEveryChange,
  chosen,
  onChange,
}: {
  kind: keyof typeof STAGE_WORDS;
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
  const words = STAGE_WORDS[kind];
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
            <span className="block text-xs text-muted-foreground">
              The company has no pipeline yet.
            </span>
          ) : null}
        </span>
      </label>
      {!every ? (
        <div className="ml-6 grid max-h-64 gap-1 overflow-y-auto">
          {listed.map((st) => {
            const id = `${prefix}-${words.idPart}-${st.id}`;
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

/**
 * What the members' fieldset says for deal owners (ADR-265), task assignees (ADR-266) and the owners
 * of tasks' deals (ADR-304) and of notes' deals (ADR-305).
 */
const CRM_MEMBER_WORDS = {
  owners: {
    legend: 'Deal owners',
    help: 'A deal’s events belong to the member who owns the deal when they happen, and a change of owner to the member it left as well; a deal without an owner belongs to no one. With pipelines or stages chosen too, an event must pass them all. Task and other events are sent whichever owners are chosen.',
    every: 'Every deal’s events',
    everyHelp: 'Including deals without an owner, and members who join later.',
    only: 'Only those of the deals the members ticked own',
    idPart: 'owner',
  },
  taskDealOwners: {
    legend: 'Owners of tasks’ deals',
    help: 'A task’s events belong to the member who owns the deal it is about when they happen; a task about no deal, or of a deal without an owner, belongs to no one. With task assignees, or the pipelines or stages of tasks’ deals chosen too, an event must pass them all. Deal and other events are sent whichever owners are chosen.',
    every: 'Every task’s events',
    everyHelp: 'Including tasks about no deal, deals without an owner, and members who join later.',
    only: 'Only those of the tasks about deals the members ticked own',
    idPart: 'task-deal-owner',
  },
  noteDealOwners: {
    legend: 'Owners of notes’ deals',
    help: 'A note’s event belongs to the member who owns the deal it is about when it is added; a note about a contact alone, or of a deal without an owner, belongs to no one. With the pipelines or stages of notes’ deals chosen too, an event must pass them all. Deal, task and other events are sent whichever owners are chosen.',
    every: 'Every note’s events',
    everyHelp:
      'Including notes about a contact alone, deals without an owner, and members who join later.',
    only: 'Only those of the notes about deals the members ticked own',
    idPart: 'note-deal-owner',
  },
  taskAssignees: {
    legend: 'Task assignees',
    help: 'A task’s events belong to the member it is assigned to when they happen, and a change of assignee to the member it left as well. Deal and other events are sent whichever assignees are chosen.',
    every: 'Every task’s events',
    everyHelp: 'Including those of members who join later.',
    only: 'Only those of the tasks assigned to the members ticked',
    idPart: 'task-assignee',
  },
} as const;

/**
 * The members whose deals' events (ADR-265), tasks' events (ADR-266), deals' tasks' events
 * (ADR-304) or deals' notes' events (ADR-305) an endpoint takes, as `kind` says: every deal's,
 * task's or note's, or those of the deals the members ticked own, of the tasks assigned to them, or
 * of the tasks or notes about the deals they own, when the events happen. Members who can own
 * deals and be assigned tasks are offered; one the endpoint already names who no longer can stays
 * listed, ticked, until it is unticked.
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

/**
 * What the contact tags' fieldset says for conversations' events (ADR-267), satisfaction survey
 * answers (ADR-312) and added and changed contacts (ADR-316).
 */
const CONTACT_TAG_WORDS = {
  conversations: {
    legend: 'Contact tags',
    help: 'Message and conversation events belong to the tags the conversation’s contact has when they happen. With numbers, teams or members chosen too, an event must pass them all. Other events are sent whichever tags are given.',
    every: 'Every conversation’s events',
    only: 'Only the events of the conversations whose contact has any of these tags',
    idPart: 'contact-tags',
    limit: WEBHOOK_LIMITS.contactTags,
  },
  surveys: {
    legend: 'Contact tags of answered surveys',
    help: 'A satisfaction survey’s answer belongs to the tags the answering contact has when they answer. With scores or the other lists of answers chosen too, an answer must pass them all. Other events are sent whichever tags are given.',
    every: 'Every answer',
    only: 'Only the answers of the contacts who have any of these tags',
    idPart: 'survey-contact-tags',
    limit: WEBHOOK_LIMITS.surveyContactTags,
  },
  contacts: {
    legend: 'Tags of added and changed contacts',
    help: 'A change of a contact is sent when the contact has any of the tags when it is saved, or when the change adds or removes one of them; a contact added and tagged with one in the same change is sent as added. With where contacts came from, the parts or the fields chosen too, an event must pass them all. Other events are sent whichever tags are given.',
    every: 'Every contact',
    only: 'Only the contacts who have any of these tags',
    idPart: 'contact-event-tags',
    limit: WEBHOOK_LIMITS.contactEventTags,
  },
} as const;

/**
 * The contact tags whose conversations' events (ADR-267), satisfaction survey answers (ADR-312) or
 * added and changed contacts (ADR-316) an endpoint takes, as `kind` says: every conversation's,
 * answer or contact, or those whose contact has any of the tags given when the event happens. Tags
 * are typed separated by commas, as on a contact; the service reads them as contacts carry them.
 */
function ContactTagChoices({
  kind,
  prefix,
  every,
  onEveryChange,
  text,
  onTextChange,
}: {
  kind: keyof typeof CONTACT_TAG_WORDS;
  prefix: string;
  every: boolean;
  onEveryChange: (next: boolean) => void;
  text: string;
  onTextChange: (next: string) => void;
}) {
  const words = CONTACT_TAG_WORDS[kind];
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">{words.legend}</legend>
      <p className="text-xs text-muted-foreground">{words.help}</p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-${words.idPart}-every`}
          className="mt-1"
          checked={every}
          onChange={() => onEveryChange(true)}
        />
        <span>
          {words.every}
          <span className="block text-xs text-muted-foreground">
            Including contacts without tags.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-${words.idPart}-every`}
          className="mt-1"
          checked={!every}
          onChange={() => onEveryChange(false)}
        />
        <span>{words.only}</span>
      </label>
      {!every ? (
        <div className="ml-6">
          <Field
            id={`${prefix}-${words.idPart}`}
            label="Tags"
            description={`Separate tags with commas, up to ${words.limit}. A tag no contact has yet matches nothing until one has it.`}
          >
            {(aria) => (
              <Input
                {...aria}
                autoComplete="off"
                value={text}
                onChange={(e) => onTextChange(e.target.value)}
              />
            )}
          </Field>
        </div>
      ) : null}
    </fieldset>
  );
}

/**
 * The custom field values whose added and changed contacts an endpoint takes (ADR-332), shown while
 * it takes either event: every contact, or only those that pass one of the conditions given. Values
 * are typed one a line for text, number and date fields, read as a member's entry of the field is,
 * and ticked for yes/no fields; words a text field's value contains are typed one a line, and a
 * number or date field takes one range, either end or both (ADR-335). A condition the endpoint
 * holds that its field's inputs cannot show as it is (its field deleted since, added again with
 * another type, or a second range given through the API) stays listed, ticked and kept as it is,
 * until it is unticked.
 */
function FieldValueChoices({
  prefix,
  choices,
  kept,
  every,
  onEveryChange,
  lines,
  onLinesChange,
  words,
  onWordsChange,
  ranges,
  onRangesChange,
  ticked,
  onTickedChange,
}: {
  prefix: string;
  choices: WebhookFieldChoice[];
  /** The values the endpoint holds that the fields' inputs cannot show as they are. */
  kept: readonly WebhookContactFieldValue[];
  every: boolean;
  onEveryChange: (next: boolean) => void;
  /** The lines typed for each text, number and date field, by key. */
  lines: Record<string, string>;
  onLinesChange: (next: Record<string, string>) => void;
  /** The words typed for each text field, one a line, by key (ADR-335). */
  words: Record<string, string>;
  onWordsChange: (next: Record<string, string>) => void;
  /** The range typed for each number and date field, by key (ADR-335). */
  ranges: Record<string, { from: string; to: string }>;
  onRangesChange: (next: Record<string, { from: string; to: string }>) => void;
  /** The yes/no values and the values kept as they are ticked (`webhookContactFieldValueId`). */
  ticked: string[];
  onTickedChange: (next: string[]) => void;
}) {
  const tick = (id: string, on: boolean) =>
    onTickedChange(on ? [...ticked.filter((t) => t !== id), id] : ticked.filter((t) => t !== id));
  const fieldByKey = new Map(choices.map((f) => [f.key, f]));
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">
        Field values of added and changed contacts
      </legend>
      <p className="text-xs text-muted-foreground">
        A change of a contact is sent when the contact has any of the values, a word given or a
        number or date in a range once it is saved, or when the change changes one of these fields,
        so the change that takes a contact out of them is sent too; text is compared whatever its
        case, and a range includes its ends. A contact added passing one of them is sent as added.
        With where contacts came from, the parts, the fields or the tags chosen too, an event must
        pass them all. Other events are sent whichever values are given.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-contact-event-field-values-every`}
          className="mt-1"
          checked={every}
          onChange={() => onEveryChange(true)}
        />
        <span>
          Every contact
          <span className="block text-xs text-muted-foreground">
            Including contacts without values.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-contact-event-field-values-every`}
          className="mt-1"
          checked={!every}
          disabled={choices.length === 0 && kept.length === 0}
          onChange={() => onEveryChange(false)}
        />
        <span>
          Only the contacts who have any of these values, words or ranges
          {choices.length === 0 && kept.length === 0 ? (
            <span className="block text-xs text-muted-foreground">
              The company has no custom field yet.
            </span>
          ) : null}
        </span>
      </label>
      {!every ? (
        <div className="ml-6 grid max-h-96 gap-3 overflow-y-auto">
          {choices.map((field) => {
            const id = `${prefix}-field-value-${field.key}`;
            if (field.type === 'boolean') {
              return (
                <div key={field.key} role="group" aria-labelledby={id} className="grid gap-1">
                  <span id={id} className="text-sm font-medium break-all">
                    {webhookFieldText(field)}
                  </span>
                  <div className="flex flex-wrap gap-4">
                    {[true, false].map((value) => {
                      const pairId = webhookContactFieldValueId({ key: field.key, value });
                      const boxId = `${id}-${value ? 'yes' : 'no'}`;
                      return (
                        <div key={pairId} className="flex items-center gap-2">
                          <Checkbox
                            id={boxId}
                            checked={ticked.includes(pairId)}
                            onChange={(e) => tick(pairId, e.target.checked)}
                          />
                          <Label htmlFor={boxId} className="font-normal">
                            {webhookFieldValueText(value)}
                          </Label>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            }
            const range = ranges[field.key] ?? { from: '', to: '' };
            const setRange = (next: { from: string; to: string }) =>
              onRangesChange({ ...ranges, [field.key]: next });
            return (
              <div key={field.key} className="grid gap-2">
                <Field
                  id={id}
                  label={webhookFieldText(field)}
                  description={
                    field.type === 'number'
                      ? 'Numbers, one a line.'
                      : field.type === 'date'
                        ? 'Dates written as YYYY-MM-DD, one a line.'
                        : 'Values, one a line.'
                  }
                >
                  {(aria) => (
                    <Textarea
                      {...aria}
                      rows={2}
                      autoComplete="off"
                      value={lines[field.key] ?? ''}
                      onChange={(e) => onLinesChange({ ...lines, [field.key]: e.target.value })}
                    />
                  )}
                </Field>
                {field.type === 'text' ? (
                  <Field
                    id={`${id}-words`}
                    label={`${webhookFieldText(field)}: containing`}
                    description="Words or phrases the text contains, whatever its case, one a line."
                  >
                    {(aria) => (
                      <Textarea
                        {...aria}
                        rows={2}
                        autoComplete="off"
                        value={words[field.key] ?? ''}
                        onChange={(e) => onWordsChange({ ...words, [field.key]: e.target.value })}
                      />
                    )}
                  </Field>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field
                      id={`${id}-from`}
                      label={`${webhookFieldText(field)}: ${field.type === 'date' ? 'from' : 'at least'}`}
                      description="The range's start, included; blank for none."
                    >
                      {(aria) => (
                        <Input
                          {...aria}
                          type={field.type === 'date' ? 'date' : 'text'}
                          autoComplete="off"
                          value={range.from}
                          onChange={(e) => setRange({ ...range, from: e.target.value })}
                        />
                      )}
                    </Field>
                    <Field
                      id={`${id}-to`}
                      label={`${webhookFieldText(field)}: ${field.type === 'date' ? 'until' : 'at most'}`}
                      description="The range's end, included; blank for none."
                    >
                      {(aria) => (
                        <Input
                          {...aria}
                          type={field.type === 'date' ? 'date' : 'text'}
                          autoComplete="off"
                          value={range.to}
                          onChange={(e) => setRange({ ...range, to: e.target.value })}
                        />
                      )}
                    </Field>
                  </div>
                )}
              </div>
            );
          })}
          {kept.map((pair, index) => {
            const pairId = webhookContactFieldValueId(pair);
            const boxId = `${prefix}-field-value-kept-${index}`;
            const field = fieldByKey.get(pair.key);
            return (
              <div key={pairId} className="flex items-center gap-2">
                <Checkbox
                  id={boxId}
                  checked={ticked.includes(pairId)}
                  onChange={(e) => tick(pairId, e.target.checked)}
                />
                <Label htmlFor={boxId} className="font-normal break-all">
                  {webhookFieldText(field ?? { key: pair.key, label: null })}:{' '}
                  {webhookContactFieldConditionText(pair)}
                  {field ? ' (kept as it is: its field’s inputs cannot show it)' : ''}
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
 * What the conversation tags' fieldset says for conversations' events (ADR-273) and satisfaction
 * survey answers (ADR-312).
 */
const CONVERSATION_TAG_WORDS = {
  conversations: {
    legend: 'Conversation tags',
    help: 'Message and conversation events belong to the tags the conversation has when they happen. With numbers, teams, members or contact tags chosen too, an event must pass them all. Other events are sent whichever tags are given.',
    every: 'Every conversation’s events',
    only: 'Only the events of the conversations that have any of these tags',
    idPart: 'conversation-tags',
    limit: WEBHOOK_LIMITS.conversationTags,
  },
  surveys: {
    legend: 'Conversation tags of answered surveys',
    help: 'A satisfaction survey’s answer belongs to the tags its conversation has when the customer answers. With scores or the other lists of answers chosen too, an answer must pass them all. Other events are sent whichever tags are given.',
    every: 'Every answer',
    only: 'Only the answers of the conversations that have any of these tags',
    idPart: 'survey-conversation-tags',
    limit: WEBHOOK_LIMITS.surveyConversationTags,
  },
} as const;

/**
 * The conversation tags whose events (ADR-273) or satisfaction survey answers (ADR-312) an endpoint
 * takes, as `kind` says: every conversation's or answer, or those of the conversations that have
 * any of the tags given when the event happens. Tags are typed separated by commas, as in the
 * inbox; the service reads them as conversations carry them.
 */
function ConversationTagChoices({
  kind,
  prefix,
  every,
  onEveryChange,
  text,
  onTextChange,
}: {
  kind: keyof typeof CONVERSATION_TAG_WORDS;
  prefix: string;
  every: boolean;
  onEveryChange: (next: boolean) => void;
  text: string;
  onTextChange: (next: string) => void;
}) {
  const words = CONVERSATION_TAG_WORDS[kind];
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">{words.legend}</legend>
      <p className="text-xs text-muted-foreground">{words.help}</p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-${words.idPart}-every`}
          className="mt-1"
          checked={every}
          onChange={() => onEveryChange(true)}
        />
        <span>
          {words.every}
          <span className="block text-xs text-muted-foreground">
            Including conversations without tags.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`${prefix}-${words.idPart}-every`}
          className="mt-1"
          checked={!every}
          onChange={() => onEveryChange(false)}
        />
        <span>{words.only}</span>
      </label>
      {!every ? (
        <div className="ml-6">
          <Field
            id={`${prefix}-${words.idPart}`}
            label="Tags"
            description={`Separate tags with commas, up to ${words.limit}. A tag no conversation has yet matches nothing until one has it.`}
          >
            {(aria) => (
              <Input
                {...aria}
                autoComplete="off"
                value={text}
                onChange={(e) => onTextChange(e.target.value)}
              />
            )}
          </Field>
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
  paymentLinkStatuses,
  onPaymentLinkStatusesChange,
  codAnswers,
  onCodAnswersChange,
  skipReasons,
  onSkipReasonsChange,
  cartSkipReasons,
  onCartSkipReasonsChange,
  campaignSkipReasons,
  onCampaignSkipReasonsChange,
  runStepOutcomes,
  onRunStepOutcomesChange,
  runStepNodeTypes,
  onRunStepNodeTypesChange,
  dealStatuses,
  onDealStatusesChange,
  taskStatuses,
  onTaskStatusesChange,
  dealDetails,
  onDealDetailsChange,
  taskDetails,
  onTaskDetailsChange,
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
  everyMessageWord,
  onEveryMessageWordChange,
  messageWordsText,
  onMessageWordsTextChange,
  runEndReasons,
  onRunEndReasonsChange,
  scores,
  onScoresChange,
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
  paymentLinkStatuses: WebhookPaymentLinkStatus[];
  onPaymentLinkStatusesChange: (next: WebhookPaymentLinkStatus[]) => void;
  codAnswers: WebhookCodAnswer[];
  onCodAnswersChange: (next: WebhookCodAnswer[]) => void;
  skipReasons: WebhookOrderMessageSkipReason[];
  onSkipReasonsChange: (next: WebhookOrderMessageSkipReason[]) => void;
  cartSkipReasons: WebhookCartReminderSkipReason[];
  onCartSkipReasonsChange: (next: WebhookCartReminderSkipReason[]) => void;
  campaignSkipReasons: WebhookCampaignSkipReason[];
  onCampaignSkipReasonsChange: (next: WebhookCampaignSkipReason[]) => void;
  runStepOutcomes: WebhookRunStepOutcome[];
  onRunStepOutcomesChange: (next: WebhookRunStepOutcome[]) => void;
  runStepNodeTypes: WebhookRunStepNodeType[];
  onRunStepNodeTypesChange: (next: WebhookRunStepNodeType[]) => void;
  dealStatuses: WebhookDealStatus[];
  onDealStatusesChange: (next: WebhookDealStatus[]) => void;
  taskStatuses: WebhookTaskStatus[];
  onTaskStatusesChange: (next: WebhookTaskStatus[]) => void;
  dealDetails: WebhookDealDetail[];
  onDealDetailsChange: (next: WebhookDealDetail[]) => void;
  taskDetails: WebhookTaskDetail[];
  onTaskDetailsChange: (next: WebhookTaskDetail[]) => void;
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
  everyMessageWord: boolean;
  onEveryMessageWordChange: (next: boolean) => void;
  messageWordsText: string;
  onMessageWordsTextChange: (next: string) => void;
  runEndReasons: AutomationEndReason[];
  onRunEndReasonsChange: (next: AutomationEndReason[]) => void;
  scores: WebhookSurveyScore[];
  onScoresChange: (next: WebhookSurveyScore[]) => void;
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
              <>
                <MessageTypeChoices
                  prefix={prefix}
                  chosen={messageTypes}
                  onChange={onMessageTypesChange}
                />
                <MessageWordChoices
                  prefix={prefix}
                  every={everyMessageWord}
                  onEveryChange={onEveryMessageWordChange}
                  text={messageWordsText}
                  onTextChange={onMessageWordsTextChange}
                />
              </>
            ) : null}
            {type === 'satisfaction_survey.answered' && chosen.includes(type) ? (
              <ScoreChoices prefix={prefix} chosen={scores} onChange={onScoresChange} />
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
            {type === 'payment_link.status_changed' && chosen.includes(type) ? (
              <ReachedStatusChoices
                prefix={prefix}
                kind="payment_link"
                statuses={WEBHOOK_PAYMENT_LINK_STATUSES}
                labels={WEBHOOK_PAYMENT_LINK_STATUS_LABELS}
                chosen={paymentLinkStatuses}
                onChange={onPaymentLinkStatusesChange}
              />
            ) : null}
            {type === 'store_order.cod_answered' && chosen.includes(type) ? (
              <CodAnswerChoices prefix={prefix} chosen={codAnswers} onChange={onCodAnswersChange} />
            ) : null}
            {type === 'store_order.message_skipped' && chosen.includes(type) ? (
              <SkipReasonChoices
                prefix={prefix}
                chosen={skipReasons}
                onChange={onSkipReasonsChange}
              />
            ) : null}
            {type === 'store_checkout.reminder_skipped' && chosen.includes(type) ? (
              <CartReminderSkipReasonChoices
                prefix={prefix}
                chosen={cartSkipReasons}
                onChange={onCartSkipReasonsChange}
              />
            ) : null}
            {type === 'campaign.recipient_skipped' && chosen.includes(type) ? (
              <CampaignSkipReasonChoices
                prefix={prefix}
                chosen={campaignSkipReasons}
                onChange={onCampaignSkipReasonsChange}
              />
            ) : null}
            {type === 'automation.run_step' && chosen.includes(type) ? (
              <StepOutcomeChoices
                prefix={prefix}
                chosen={runStepOutcomes}
                onChange={onRunStepOutcomesChange}
              />
            ) : null}
            {type === 'automation.run_step' && chosen.includes(type) ? (
              <StepNodeTypeChoices
                prefix={prefix}
                chosen={runStepNodeTypes}
                onChange={onRunStepNodeTypesChange}
              />
            ) : null}
            {type === 'deal.status_changed' && chosen.includes(type) ? (
              <ReachedStatusChoices
                prefix={prefix}
                kind="deal"
                statuses={WEBHOOK_DEAL_STATUSES}
                labels={WEBHOOK_DEAL_STATUS_LABELS}
                chosen={dealStatuses}
                onChange={onDealStatusesChange}
              />
            ) : null}
            {type === 'task.status_changed' && chosen.includes(type) ? (
              <ReachedStatusChoices
                prefix={prefix}
                kind="task"
                statuses={WEBHOOK_TASK_STATUSES}
                labels={WEBHOOK_TASK_STATUS_LABELS}
                chosen={taskStatuses}
                onChange={onTaskStatusesChange}
              />
            ) : null}
            {type === 'deal.updated' && chosen.includes(type) ? (
              <DetailChoices
                prefix={prefix}
                kind="deal"
                details={WEBHOOK_DEAL_DETAILS}
                labels={WEBHOOK_DEAL_DETAIL_LABELS}
                chosen={dealDetails}
                onChange={onDealDetailsChange}
              />
            ) : null}
            {type === 'task.updated' && chosen.includes(type) ? (
              <DetailChoices
                prefix={prefix}
                kind="task"
                details={WEBHOOK_TASK_DETAILS}
                labels={WEBHOOK_TASK_DETAIL_LABELS}
                chosen={taskDetails}
                onChange={onTaskDetailsChange}
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
  /** How the client proves itself to the token URL (ADR-357, ADR-366, ADR-367). */
  clientAuthentication: WebhookOAuthClientAuth;
  /** What becomes of the key pair of a client that signs with HyFib's (ADR-367, ADR-368). */
  keyAction: OAuthKeyAction;
  /** The audience a client that signs JWTs names in them; empty: its token URL (ADR-369). */
  assertionAudience: string;
  /** The algorithm of the key pairs the change makes (ADR-371); the pair in use's, or RS256. */
  keyAlgorithm: WebhookOAuthKeyAlgorithm;
}

/**
 * What a change does with the key pair of a client that signs with one: keeps it, replaces it at
 * once (ADR-367), or makes, uses or drops its next one (ADR-368).
 */
type OAuthKeyAction = 'keep' | 'replace' | WebhookOAuthNextKeyAction;

/** The key pair choices a client that signs with HyFib's key pair offers, and how they read. */
function oauthKeyActions(hasNext: boolean): (readonly [OAuthKeyAction, string])[] {
  return hasNext
    ? [
        ['keep', 'Keep the key pair and its next one'],
        [
          'use',
          'Sign with the next key pair from now on (register its public key first); the current one goes',
        ],
        ['drop', 'Drop the next key pair, unused'],
        ['make', 'Make another next key pair in place of the one not used yet'],
        [
          'replace',
          'Make a new key pair, used at once: the current one stops working, so register the new public key with the authorization server',
        ],
      ]
    : [
        ['keep', 'Keep the key pair'],
        [
          'make',
          'Make a next key pair to register first; HyFib goes on signing with the current one until you switch',
        ],
        [
          'replace',
          'Make a new key pair, used at once: the current one stops working, so register the new public key with the authorization server',
        ],
      ];
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
  jwksUrl,
  change,
  onChangeChange,
  fields,
  onFieldsChange,
}: {
  prefix: string;
  /** The endpoint's client; null for a new endpoint or one without a client. */
  stored: WebhookEndpointOAuth | null;
  /** The JWKS URL serving a client's public keys, when it signs with a key pair (ADR-370). */
  jwksUrl: string | null;
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
          {stored.publicKey ? <WebhookOAuthPublicKeyDetails publicKey={stored.publicKey} /> : null}
          {stored.publicKey && stored.nextPublicKey ? (
            <WebhookOAuthPublicKeyDetails
              publicKey={stored.nextPublicKey}
              inUse={stored.publicKey}
            />
          ) : null}
          {stored.publicKey && jwksUrl ? (
            <CopyField label="JWKS URL" value={jwksUrl} description={WEBHOOK_OAUTH_JWKS_HINT} />
          ) : null}
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
          {fields.clientAuthentication === 'private_key_jwt' ? (
            // A client that signs with HyFib's key pair has no secret (ADR-367); it keeps its key
            // pair, replaces it at once, or changes keys through a next pair (ADR-368).
            stored?.clientAuthentication === 'private_key_jwt' ? (
              <fieldset className="grid gap-1 sm:col-span-2">
                <legend className="mb-1 text-sm font-medium">Key pair</legend>
                {oauthKeyActions(stored.nextPublicKey !== null).map(([value, label]) => (
                  <label key={value} className="flex items-start gap-2 text-sm">
                    <input
                      type="radio"
                      className="mt-1"
                      name={`${prefix}-oauth-key`}
                      checked={fields.keyAction === value}
                      onChange={() => set({ keyAction: value })}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
            ) : (
              <p className="text-xs text-muted-foreground sm:col-span-2">
                HyFib makes a key pair when you save, keeps its private key and signs each JWT with
                it; register the public key shown then with the authorization server.
              </p>
            )
          ) : null}
          {fields.clientAuthentication === 'private_key_jwt' &&
          (stored?.clientAuthentication !== 'private_key_jwt' ||
            fields.keyAction === 'replace' ||
            fields.keyAction === 'make') ? (
            // The algorithm of the key pair made now: RS256 unless the server wants another
            // (ADR-371).
            <Field
              id={`${prefix}-oauth-key-algorithm`}
              label="Key algorithm"
              description="The algorithm the new key pair signs with: RS256 unless the authorization server asks for PS256 or ES256."
            >
              {(aria) => (
                <Select
                  {...aria}
                  value={fields.keyAlgorithm}
                  onChange={(e) =>
                    set({ keyAlgorithm: e.target.value as WebhookOAuthKeyAlgorithm })
                  }
                >
                  {WEBHOOK_OAUTH_KEY_ALGORITHM_CHOICES.map((algorithm) => (
                    <option key={algorithm} value={algorithm}>
                      {WEBHOOK_OAUTH_KEY_ALGORITHM_LABELS[algorithm]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          {fields.clientAuthentication !== 'private_key_jwt' ? (
            <Field
              id={`${prefix}-oauth-client-secret`}
              label="Client secret"
              description={
                stored?.clientAuthentication !== 'private_key_jwt' && stored
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
          ) : null}
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
          <Field
            id={`${prefix}-oauth-client-authentication`}
            label="How the client authenticates"
            description="HTTP Basic is the standard way; choose the request body, a JWT signed with a secret of at least 32 bytes, or a JWT signed with a key pair HyFib keeps, only for an authorization server that asks for it."
          >
            {(aria) => (
              <Select
                {...aria}
                value={fields.clientAuthentication}
                onChange={(e) =>
                  set({ clientAuthentication: e.target.value as WebhookOAuthClientAuth })
                }
              >
                {WEBHOOK_OAUTH_CLIENT_AUTHENTICATIONS.map((method) => (
                  <option key={method} value={method}>
                    {WEBHOOK_OAUTH_CLIENT_AUTHENTICATION_LABELS[method]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {webhookOAuthSignsJwts(fields.clientAuthentication) ? (
            // The audience the JWTs name, for a server that wants another than its token URL
            // (ADR-369).
            <Field
              id={`${prefix}-oauth-assertion-audience`}
              label="JWT audience"
              description="Optional: the value the server expects as each JWT’s audience, such as its issuer identifier. Left empty, the token URL."
            >
              {(aria) => (
                <Input
                  {...aria}
                  type="url"
                  inputMode="url"
                  maxLength={WEBHOOK_LIMITS.urlLength}
                  autoComplete="off"
                  placeholder="https://auth.example.com/"
                  value={fields.assertionAudience}
                  onChange={(e) => set({ assertionAudience: e.target.value })}
                />
              )}
            </Field>
          ) : null}
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
  clientAuthentication: stored?.clientAuthentication ?? 'client_secret_basic',
  keyAction: 'keep',
  assertionAudience: stored?.assertionAudience ?? '',
  keyAlgorithm: stored?.publicKey?.jwk.alg ?? 'RS256',
});

/**
 * Adds an endpoint, or edits one (`endpoint` given). A new endpoint's secret is shown here once,
 * and stays on screen after the list updates.
 */
export function WebhookEndpointForm({
  slug,
  endpoint,
  oauthJwksUrl,
  automationChoices,
  runApiKeyChoices,
  messageApiKeyChoices,
  crmApiKeyChoices,
  orderApiKeyChoices,
  paymentLinkApiKeyChoices,
  channelChoices,
  teamChoices,
  templateChoices,
  campaignChoices,
  storeChoices,
  pipelineChoices,
  stageChoices,
  ownerChoices,
  assigneeChoices,
  contactFieldChoices,
  atLimit = false,
}: {
  slug: string;
  /** The JWKS URL of the endpoint's OAuth client, when it signs with a key pair (ADR-370). */
  oauthJwksUrl?: string | null;
  endpoint?: {
    id: string;
    url: string;
    description: string | null;
    eventTypes: WebhookEventType[];
    headerNames: string[];
    messageStatuses: WebhookMessageStatus[] | null;
    messageSenders: WebhookMessageSender[] | null;
    /** The API keys whose sent messages' statuses it takes (ADR-320); null: every message. */
    messageApiKeys: WebhookEndpointApiKey[] | null;
    contactParts: WebhookContactPart[] | null;
    /** The custom fields it names (ADR-184), deleted ones without a label; null for every field. */
    contactFields: WebhookEndpointField[] | null;
    automationIds: string[] | null;
    campaignStatuses: WebhookCampaignStatus[] | null;
    orderStatuses: WebhookOrderStatus[] | null;
    /** The Payment Link statuses it takes (ADR-308); null for every status. */
    paymentLinkStatuses: WebhookPaymentLinkStatus[] | null;
    /** The cash on delivery answers it takes (ADR-349); null for every answer. */
    codAnswers: WebhookCodAnswer[] | null;
    /**
     * The stores whose cash on delivery answers (ADR-349), order messages (ADR-352, ADR-353) and
     * cart reminders (ADR-355) it takes, named; null for every one's.
     */
    stores: WebhookEndpointStore[] | null;
    /** The order messages whose skips and sends it takes (ADR-352, ADR-353); null for every message's. */
    orderMessageEvents: WebhookOrderMessageEvent[] | null;
    /** The reasons whose order message skips it takes (ADR-354); null for every reason. */
    orderMessageSkipReasons: WebhookOrderMessageSkipReason[] | null;
    /** The cart reminders whose skips and sends it takes (ADR-361); null for both. */
    cartReminders: WebhookCartReminder[] | null;
    /** The reasons whose cart reminder skips it takes (ADR-356); null for every reason. */
    cartReminderSkipReasons: WebhookCartReminderSkipReason[] | null;
    /** The reasons whose campaign recipient skips it takes (ADR-359); null for every reason. */
    campaignSkipReasons: WebhookCampaignSkipReason[] | null;
    /** The outcomes of the run steps it takes (ADR-327); null for every step. */
    runStepOutcomes: WebhookRunStepOutcome[] | null;
    /** The kinds of node whose run steps it takes (ADR-328); null for every step. */
    runStepNodeTypes: WebhookRunStepNodeType[] | null;
    /** Who made the order status changes it takes (ADR-322); null for every change. */
    orderChangeMakers: WebhookOrderChangeMaker[] | null;
    /** The API keys whose order changes it leaves out (ADR-323), and if they work; null: none. */
    orderExcludedApiKeys: WebhookEndpointApiKey[] | null;
    /** The keys whose Payment Links' changes it takes (ADR-324), and if they work; null: all. */
    paymentLinkApiKeys: WebhookEndpointApiKey[] | null;
    /** The deal statuses it takes (ADR-309); null for every status. */
    dealStatuses: WebhookDealStatus[] | null;
    /** The task statuses it takes (ADR-309); null for every status. */
    taskStatuses: WebhookTaskStatus[] | null;
    /** The deal details whose changes it takes (ADR-310); null for every change. */
    dealDetails: WebhookDealDetail[] | null;
    /** The task details whose changes it takes (ADR-310); null for every change. */
    taskDetails: WebhookTaskDetail[] | null;
    templateStatuses: WebhookTemplateStatus[] | null;
    conversationStatuses: WebhookConversationStatus[] | null;
    runEndStatuses: WebhookRunEndStatus[] | null;
    /** What started the runs it takes (ADR-183); null for every run. */
    runTriggers: WebhookRunTrigger[] | null;
    /** The API keys whose runs it takes (ADR-319), and whether they work; null: every run. */
    runApiKeys: WebhookEndpointApiKey[] | null;
    /** The consent changes it takes (ADR-189); null for every change. */
    consentChanges: WebhookConsentChange[] | null;
    /** Where the contacts it takes as `contact.created` came from (ADR-190); null for every one. */
    contactSources: ContactSource[] | null;
    /** The types of the received messages it takes (ADR-191); null for every type. */
    messageTypes: WebhookReceivedMessageType[] | null;
    messageWords: string[] | null;
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
    /** The CRM pipelines whose deals' tasks it takes (ADR-303), archived or not; null: every one. */
    taskPipelines: WebhookEndpointPipeline[] | null;
    /** The CRM stages whose deals' tasks it takes (ADR-304), with their pipelines; null: every one. */
    taskStages: WebhookEndpointStage[] | null;
    /** The members whose deals' tasks it takes (ADR-304), with whether they can own deals; null: all. */
    taskDealOwners: WebhookEndpointOwner[] | null;
    /** The CRM pipelines whose deals' notes it takes (ADR-305), archived or not; null: all. */
    notePipelines: WebhookEndpointPipeline[] | null;
    /** The CRM stages whose deals' notes it takes (ADR-305), with their pipelines; null: all. */
    noteStages: WebhookEndpointStage[] | null;
    /** The members whose deals' notes it takes (ADR-305), and if they can own deals; null: all. */
    noteDealOwners: WebhookEndpointOwner[] | null;
    /** Who made the changes whose deal, task and note events it takes (ADR-306); null: all. */
    crmChangeMakers: WebhookCrmChangeMaker[] | null;
    /** The API keys whose CRM changes it leaves out (ADR-321), and if they work; null: none. */
    crmExcludedApiKeys: WebhookEndpointApiKey[] | null;
    /** The scores of the survey answers it takes (ADR-307); null: every answer. */
    surveyScores: WebhookSurveyScore[] | null;
    /** The members credited with the survey answers it takes (ADR-311); null: every answer. */
    surveyAssignees: WebhookEndpointAssignee[] | null;
    /** The teams of the survey answers it takes (ADR-311); null: every answer. */
    surveyTeams: WebhookEndpointTeam[] | null;
    /** The contact tags of the survey answers it takes (ADR-312); null: every answer. */
    surveyContactTags: string[] | null;
    /** The conversation tags of the survey answers it takes (ADR-312); null: every answer. */
    surveyConversationTags: string[] | null;
    /** The contact tags of the added and changed contacts it takes (ADR-316); null: every one. */
    contactEventTags: string[] | null;
    /** The field values of the added and changed contacts it takes (ADR-332); null: every one. */
    contactEventFieldValues: WebhookContactFieldValue[] | null;
    /** The members it names (ADR-181), with whether they still take conversations; null: all. */
    assignees: WebhookEndpointAssignee[] | null;
    /** The contact tags it names (ADR-267); null for every conversation. */
    contactTags: string[] | null;
    /** The conversation tags it names (ADR-273); null for every conversation. */
    conversationTags: string[] | null;
    oauth: WebhookEndpointOAuth | null;
  };
  /** The company's published automations, which an endpoint can choose (ADR-145). */
  automationChoices: WebhookAutomationChoice[];
  /** The company's API keys that can start runs, which an endpoint can choose (ADR-319). */
  runApiKeyChoices: WebhookApiKeyChoice[];
  /** The company's API keys whose messages carry them, which an endpoint can choose (ADR-320). */
  messageApiKeyChoices: WebhookApiKeyChoice[];
  /** The company's API keys that change deals, tasks or notes, which an endpoint can leave out. */
  crmApiKeyChoices: WebhookApiKeyChoice[];
  /** The company's API keys that change orders, which an endpoint can leave out (ADR-323). */
  orderApiKeyChoices: WebhookApiKeyChoice[];
  /** The company's API keys that ask customers to pay, which an endpoint can choose (ADR-324). */
  paymentLinkApiKeyChoices: WebhookApiKeyChoice[];
  /** The company's WhatsApp numbers, which an endpoint can choose (ADR-170). */
  channelChoices: WebhookChannelChoice[];
  /** The company's teams, which an endpoint can choose (ADR-174). */
  teamChoices: WebhookTeamChoice[];
  /** The company's templates, which an endpoint can choose (ADR-175). */
  templateChoices: WebhookTemplateChoice[];
  /** The company's newest campaigns, which an endpoint can choose, and whether there are more. */
  campaignChoices: { campaigns: WebhookCampaignChoice[]; more: boolean };
  /** The company's connected stores, which an endpoint can choose (ADR-349, ADR-352). */
  storeChoices: WebhookStoreChoice[];
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
  const [paymentLinkStatuses, setPaymentLinkStatuses] = useState<WebhookPaymentLinkStatus[]>(
    endpoint?.paymentLinkStatuses ?? [...WEBHOOK_PAYMENT_LINK_STATUSES],
  );
  const [codAnswers, setCodAnswers] = useState<WebhookCodAnswer[]>(
    endpoint?.codAnswers ?? [...WEBHOOK_COD_ANSWERS],
  );
  const [everyStore, setEveryStore] = useState(!endpoint?.stores);
  const [storeIds, setStoreIds] = useState<string[]>(endpoint?.stores?.map((st) => st.id) ?? []);
  const [orderMessageEvents, setOrderMessageEvents] = useState<WebhookOrderMessageEvent[]>(
    endpoint?.orderMessageEvents ?? [...WEBHOOK_ORDER_MESSAGE_EVENTS],
  );
  const [skipReasons, setSkipReasons] = useState<WebhookOrderMessageSkipReason[]>(
    endpoint?.orderMessageSkipReasons ?? [...WEBHOOK_ORDER_MESSAGE_SKIP_REASONS],
  );
  const [cartReminders, setCartReminders] = useState<WebhookCartReminder[]>(
    endpoint?.cartReminders ?? [...WEBHOOK_CART_REMINDERS],
  );
  const [cartSkipReasons, setCartSkipReasons] = useState<WebhookCartReminderSkipReason[]>(
    endpoint?.cartReminderSkipReasons ?? [...WEBHOOK_CART_REMINDER_SKIP_REASONS],
  );
  const [campaignSkipReasons, setCampaignSkipReasons] = useState<WebhookCampaignSkipReason[]>(
    endpoint?.campaignSkipReasons ?? [...WEBHOOK_CAMPAIGN_SKIP_REASONS],
  );
  const [runStepOutcomes, setRunStepOutcomes] = useState<WebhookRunStepOutcome[]>(
    endpoint?.runStepOutcomes ?? [...WEBHOOK_RUN_STEP_OUTCOMES],
  );
  const [runStepNodeTypes, setRunStepNodeTypes] = useState<WebhookRunStepNodeType[]>(
    endpoint?.runStepNodeTypes ?? [...WEBHOOK_RUN_STEP_NODE_TYPES],
  );
  const [orderChangeMakers, setOrderChangeMakers] = useState<WebhookOrderChangeMaker[]>(
    endpoint?.orderChangeMakers ?? [...WEBHOOK_ORDER_CHANGE_MAKERS],
  );
  const [everyOrderChange, setEveryOrderChange] = useState(!endpoint?.orderExcludedApiKeys);
  const [orderExcludedApiKeyIds, setOrderExcludedApiKeyIds] = useState<string[]>(
    endpoint?.orderExcludedApiKeys?.map((k) => k.id) ?? [],
  );
  const [everyPaymentLinkApiKey, setEveryPaymentLinkApiKey] = useState(
    !endpoint?.paymentLinkApiKeys,
  );
  const [paymentLinkApiKeyIds, setPaymentLinkApiKeyIds] = useState<string[]>(
    endpoint?.paymentLinkApiKeys?.map((k) => k.id) ?? [],
  );
  const [dealStatuses, setDealStatuses] = useState<WebhookDealStatus[]>(
    endpoint?.dealStatuses ?? [...WEBHOOK_DEAL_STATUSES],
  );
  const [taskStatuses, setTaskStatuses] = useState<WebhookTaskStatus[]>(
    endpoint?.taskStatuses ?? [...WEBHOOK_TASK_STATUSES],
  );
  const [dealDetails, setDealDetails] = useState<WebhookDealDetail[]>(
    endpoint?.dealDetails ?? [...WEBHOOK_DEAL_DETAILS],
  );
  const [taskDetails, setTaskDetails] = useState<WebhookTaskDetail[]>(
    endpoint?.taskDetails ?? [...WEBHOOK_TASK_DETAILS],
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
  const [everyMessageWord, setEveryMessageWord] = useState(!endpoint?.messageWords);
  const [messageWordsText, setMessageWordsText] = useState(
    endpoint?.messageWords?.join('\n') ?? '',
  );
  const [runEndReasons, setRunEndReasons] = useState<AutomationEndReason[]>(
    webhookRunEndReasonsTicked(endpoint?.runEndReasons ?? null),
  );
  const [everyAutomation, setEveryAutomation] = useState(!endpoint?.automationIds);
  const [automationIds, setAutomationIds] = useState<string[]>(endpoint?.automationIds ?? []);
  const [everyRunApiKey, setEveryRunApiKey] = useState(!endpoint?.runApiKeys);
  const [runApiKeyIds, setRunApiKeyIds] = useState<string[]>(
    endpoint?.runApiKeys?.map((k) => k.id) ?? [],
  );
  const [everyMessageApiKey, setEveryMessageApiKey] = useState(!endpoint?.messageApiKeys);
  const [messageApiKeyIds, setMessageApiKeyIds] = useState<string[]>(
    endpoint?.messageApiKeys?.map((k) => k.id) ?? [],
  );
  const [everyCrmChange, setEveryCrmChange] = useState(!endpoint?.crmExcludedApiKeys);
  const [crmExcludedApiKeyIds, setCrmExcludedApiKeyIds] = useState<string[]>(
    endpoint?.crmExcludedApiKeys?.map((k) => k.id) ?? [],
  );
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
  const [everyTaskPipeline, setEveryTaskPipeline] = useState(!endpoint?.taskPipelines);
  const [taskPipelineIds, setTaskPipelineIds] = useState<string[]>(
    endpoint?.taskPipelines?.map((p) => p.id) ?? [],
  );
  const [everyTaskStage, setEveryTaskStage] = useState(!endpoint?.taskStages);
  const [taskStageIds, setTaskStageIds] = useState<string[]>(
    endpoint?.taskStages?.map((st) => st.id) ?? [],
  );
  const [everyTaskDealOwner, setEveryTaskDealOwner] = useState(!endpoint?.taskDealOwners);
  const [taskDealOwnerIds, setTaskDealOwnerIds] = useState<string[]>(
    endpoint?.taskDealOwners?.map((m) => m.id) ?? [],
  );
  const [everyNotePipeline, setEveryNotePipeline] = useState(!endpoint?.notePipelines);
  const [notePipelineIds, setNotePipelineIds] = useState<string[]>(
    endpoint?.notePipelines?.map((p) => p.id) ?? [],
  );
  const [everyNoteStage, setEveryNoteStage] = useState(!endpoint?.noteStages);
  const [noteStageIds, setNoteStageIds] = useState<string[]>(
    endpoint?.noteStages?.map((st) => st.id) ?? [],
  );
  const [everyNoteDealOwner, setEveryNoteDealOwner] = useState(!endpoint?.noteDealOwners);
  const [noteDealOwnerIds, setNoteDealOwnerIds] = useState<string[]>(
    endpoint?.noteDealOwners?.map((m) => m.id) ?? [],
  );
  const [changeMakers, setChangeMakers] = useState<WebhookCrmChangeMaker[]>(
    endpoint?.crmChangeMakers ?? [...WEBHOOK_CRM_CHANGE_MAKERS],
  );
  const [scores, setScores] = useState<WebhookSurveyScore[]>(
    endpoint?.surveyScores ?? [...WEBHOOK_SURVEY_SCORES],
  );
  const [everySurveyAssignee, setEverySurveyAssignee] = useState(!endpoint?.surveyAssignees);
  const [surveyAssigneeIds, setSurveyAssigneeIds] = useState<string[]>(
    endpoint?.surveyAssignees?.map((m) => m.id) ?? [],
  );
  const [everySurveyTeam, setEverySurveyTeam] = useState(!endpoint?.surveyTeams);
  const [surveyTeamIds, setSurveyTeamIds] = useState<string[]>(
    endpoint?.surveyTeams?.map((t) => t.id) ?? [],
  );
  const [everySurveyContactTag, setEverySurveyContactTag] = useState(!endpoint?.surveyContactTags);
  const [surveyContactTagsText, setSurveyContactTagsText] = useState(
    endpoint?.surveyContactTags?.join(', ') ?? '',
  );
  const [everySurveyConversationTag, setEverySurveyConversationTag] = useState(
    !endpoint?.surveyConversationTags,
  );
  const [surveyConversationTagsText, setSurveyConversationTagsText] = useState(
    endpoint?.surveyConversationTags?.join(', ') ?? '',
  );
  const [everyContactEventTag, setEveryContactEventTag] = useState(!endpoint?.contactEventTags);
  const [contactEventTagsText, setContactEventTagsText] = useState(
    endpoint?.contactEventTags?.join(', ') ?? '',
  );
  // The field values of added and changed contacts (ADR-332): lines for text, number and date
  // fields and ticks for yes/no fields, words for text fields and one range a number or date field
  // (ADR-335); a condition the endpoint holds that its field's inputs cannot show as it is (its
  // field deleted, added again with another type, or a field's second range) is ticked and kept as
  // it is.
  // Which conditions the inputs show and which are kept apart is decided once, as the form opens:
  // a save refreshes the endpoint without remounting the form, and deciding again from it (which
  // range comes first) would move a range the inputs do not hold out of the kept list unseen.
  const [fieldConditionLayout] = useState(() => {
    const fieldTypeByKey = new Map(contactFieldChoices.map((f) => [f.key, f.type]));
    const editable = (pair: WebhookContactFieldValue) => {
      const type = fieldTypeByKey.get(pair.key);
      return type !== undefined && webhookFieldConditionEditable(type, pair);
    };
    const stored = endpoint?.contactEventFieldValues ?? [];
    const rangeShown = new Set<string>();
    const shown = stored.filter((pair) => {
      if (!editable(pair)) return false;
      if (webhookContactFieldKind(pair) !== 'range') return true;
      if (rangeShown.has(pair.key)) return false;
      rangeShown.add(pair.key);
      return true;
    });
    return { shown, kept: stored.filter((pair) => !shown.includes(pair)) };
  });
  const shownInInputs = (pair: WebhookContactFieldValue) =>
    fieldConditionLayout.shown.includes(pair);
  const keptFieldValues = fieldConditionLayout.kept;
  const [everyContactEventFieldValue, setEveryContactEventFieldValue] = useState(
    !endpoint?.contactEventFieldValues,
  );
  const [fieldValueLines, setFieldValueLines] = useState<Record<string, string>>(() => {
    const lines: Record<string, string> = {};
    for (const pair of endpoint?.contactEventFieldValues ?? []) {
      if (!shownInInputs(pair) || !('value' in pair) || typeof pair.value === 'boolean') continue;
      const text = webhookFieldValueText(pair.value);
      lines[pair.key] = lines[pair.key] ? `${lines[pair.key]}\n${text}` : text;
    }
    return lines;
  });
  const [fieldWordLines, setFieldWordLines] = useState<Record<string, string>>(() => {
    const lines: Record<string, string> = {};
    for (const pair of endpoint?.contactEventFieldValues ?? []) {
      if (!shownInInputs(pair) || !('contains' in pair)) continue;
      lines[pair.key] = lines[pair.key] ? `${lines[pair.key]}\n${pair.contains}` : pair.contains;
    }
    return lines;
  });
  const [fieldRanges, setFieldRanges] = useState<Record<string, { from: string; to: string }>>(
    () => {
      const ranges: Record<string, { from: string; to: string }> = {};
      for (const pair of fieldConditionLayout.shown) {
        if ('value' in pair || 'contains' in pair) continue;
        ranges[pair.key] = {
          from: pair.atLeast === undefined ? '' : String(pair.atLeast),
          to: pair.atMost === undefined ? '' : String(pair.atMost),
        };
      }
      return ranges;
    },
  );
  const [fieldValuesTicked, setFieldValuesTicked] = useState<string[]>(() =>
    (endpoint?.contactEventFieldValues ?? [])
      .filter(
        (pair) => !shownInInputs(pair) || ('value' in pair && typeof pair.value === 'boolean'),
      )
      .map(webhookContactFieldValueId),
  );
  const [everyAssignee, setEveryAssignee] = useState(!endpoint?.assignees);
  const [everyField, setEveryField] = useState(!endpoint?.contactFields);
  const [fieldKeys, setFieldKeys] = useState<string[]>(
    endpoint?.contactFields?.map((f) => f.key) ?? [],
  );
  const [assigneeIds, setAssigneeIds] = useState<string[]>(
    endpoint?.assignees?.map((m) => m.id) ?? [],
  );
  const [everyContactTag, setEveryContactTag] = useState(!endpoint?.contactTags);
  const [contactTagsText, setContactTagsText] = useState(endpoint?.contactTags?.join(', ') ?? '');
  const [everyConversationTag, setEveryConversationTag] = useState(!endpoint?.conversationTags);
  const [conversationTagsText, setConversationTagsText] = useState(
    endpoint?.conversationTags?.join(', ') ?? '',
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
        // Every message's statuses unless the API keys ticked are chosen (ADR-320).
        const chosenMessageApiKeys =
          eventTypes.includes('message.status') && !everyMessageApiKey ? messageApiKeyIds : null;
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
        // Every Payment Link status ticked takes every status (null, ADR-308).
        const chosenPaymentLinkStatuses =
          eventTypes.includes('payment_link.status_changed') &&
          paymentLinkStatuses.length < WEBHOOK_PAYMENT_LINK_STATUSES.length
            ? paymentLinkStatuses
            : null;
        // Both answers ticked take every answer (null, ADR-349).
        const chosenCodAnswers =
          eventTypes.includes('store_order.cod_answered') &&
          codAnswers.length < WEBHOOK_COD_ANSWERS.length
            ? codAnswers
            : null;
        // Every store's unless the stores ticked are chosen (ADR-349, ADR-352).
        const chosenStores = webhookTakesStoreEvents(eventTypes) && !everyStore ? storeIds : null;
        // Every order message ticked takes every message's skips and sends (null, ADR-352, ADR-353).
        const chosenOrderMessageEvents =
          webhookTakesOrderMessages(eventTypes) &&
          orderMessageEvents.length < WEBHOOK_ORDER_MESSAGE_EVENTS.length
            ? orderMessageEvents
            : null;
        // Every reason ticked takes every reason's skips (null, ADR-354).
        const chosenSkipReasons =
          eventTypes.includes('store_order.message_skipped') &&
          skipReasons.length < WEBHOOK_ORDER_MESSAGE_SKIP_REASONS.length
            ? skipReasons
            : null;
        // Both cart reminders ticked take both reminders' skips and sends (null, ADR-361).
        const chosenCartReminders =
          webhookTakesCartReminders(eventTypes) &&
          cartReminders.length < WEBHOOK_CART_REMINDERS.length
            ? cartReminders
            : null;
        // Every cart reminder reason ticked takes every reason's skips (null, ADR-356).
        const chosenCartSkipReasons =
          eventTypes.includes('store_checkout.reminder_skipped') &&
          cartSkipReasons.length < WEBHOOK_CART_REMINDER_SKIP_REASONS.length
            ? cartSkipReasons
            : null;
        // Every campaign skip reason ticked takes every reason's skips (null, ADR-359).
        const chosenCampaignSkipReasons =
          eventTypes.includes('campaign.recipient_skipped') &&
          campaignSkipReasons.length < WEBHOOK_CAMPAIGN_SKIP_REASONS.length
            ? campaignSkipReasons
            : null;
        // Every step outcome ticked takes every step (null, ADR-327).
        const chosenRunStepOutcomes =
          eventTypes.includes('automation.run_step') &&
          runStepOutcomes.length < WEBHOOK_RUN_STEP_OUTCOMES.length
            ? runStepOutcomes
            : null;
        // Every kind of step ticked, the steps outside a node among them, takes every step (null,
        // ADR-328); a list of every kind but those keeps them out.
        const chosenRunStepNodeTypes =
          eventTypes.includes('automation.run_step') &&
          runStepNodeTypes.length < WEBHOOK_RUN_STEP_NODE_TYPES.length
            ? runStepNodeTypes
            : null;
        // Every maker ticked takes every order change (null, ADR-322).
        const chosenOrderChangeMakers =
          eventTypes.includes('order.status_changed') &&
          orderChangeMakers.length < WEBHOOK_ORDER_CHANGE_MAKERS.length
            ? orderChangeMakers
            : null;
        // Every order change unless the API keys ticked are left out (ADR-323).
        const chosenOrderExcludedApiKeys =
          eventTypes.includes('order.status_changed') && !everyOrderChange
            ? orderExcludedApiKeyIds
            : null;
        // Every Payment Link's changes unless the API keys ticked are chosen (ADR-324).
        const chosenPaymentLinkApiKeys =
          eventTypes.includes('payment_link.status_changed') && !everyPaymentLinkApiKey
            ? paymentLinkApiKeyIds
            : null;
        // Every deal or task status ticked takes every status (null, ADR-309).
        const chosenDealStatuses =
          eventTypes.includes('deal.status_changed') &&
          dealStatuses.length < WEBHOOK_DEAL_STATUSES.length
            ? dealStatuses
            : null;
        const chosenTaskStatuses =
          eventTypes.includes('task.status_changed') &&
          taskStatuses.length < WEBHOOK_TASK_STATUSES.length
            ? taskStatuses
            : null;
        // Every deal or task detail ticked takes every change (null, ADR-310).
        const chosenDealDetails =
          eventTypes.includes('deal.updated') && dealDetails.length < WEBHOOK_DEAL_DETAILS.length
            ? dealDetails
            : null;
        const chosenTaskDetails =
          eventTypes.includes('task.updated') && taskDetails.length < WEBHOOK_TASK_DETAILS.length
            ? taskDetails
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
        // Every run unless the API keys ticked are chosen (ADR-319).
        const chosenRunApiKeys =
          webhookTakesAutomationRuns(eventTypes) && !everyRunApiKey ? runApiKeyIds : null;
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
        // Every received message unless words are given, one a line (ADR-337).
        let chosenMessageWords: string[] | null = null;
        if (eventTypes.includes('message.received') && !everyMessageWord) {
          const read = webhookMessageWordsFromLines(messageWordsText);
          if (!read.ok) {
            setBusy(false);
            setError({ code: 'validation_failed', message: read.message });
            return;
          }
          chosenMessageWords = read.words;
        }
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
        // Every task's events unless the pipelines of their deals ticked are chosen (ADR-303).
        const chosenTaskPipelines =
          webhookTakesTaskEvents(eventTypes) && !everyTaskPipeline ? taskPipelineIds : null;
        // Every task's events unless the stages or owners of their deals ticked are chosen (ADR-304).
        const chosenTaskStages =
          webhookTakesTaskEvents(eventTypes) && !everyTaskStage ? taskStageIds : null;
        const chosenTaskDealOwners =
          webhookTakesTaskEvents(eventTypes) && !everyTaskDealOwner ? taskDealOwnerIds : null;
        // Every note's events unless the pipelines, stages or owners of their deals ticked are
        // chosen (ADR-305).
        const chosenNotePipelines =
          webhookTakesNoteEvents(eventTypes) && !everyNotePipeline ? notePipelineIds : null;
        const chosenNoteStages =
          webhookTakesNoteEvents(eventTypes) && !everyNoteStage ? noteStageIds : null;
        const chosenNoteDealOwners =
          webhookTakesNoteEvents(eventTypes) && !everyNoteDealOwner ? noteDealOwnerIds : null;
        // Every maker ticked takes every change (null, ADR-306).
        const crmChangeMakers =
          webhookTakesCrmChanges(eventTypes) &&
          changeMakers.length < WEBHOOK_CRM_CHANGE_MAKERS.length
            ? changeMakers
            : null;
        // Every change unless the API keys ticked are left out (ADR-321).
        const chosenCrmExcludedApiKeys =
          webhookTakesCrmChanges(eventTypes) && !everyCrmChange ? crmExcludedApiKeyIds : null;
        // Every score ticked takes every answer (null, ADR-307).
        const surveyScores =
          eventTypes.includes('satisfaction_survey.answered') &&
          scores.length < WEBHOOK_SURVEY_SCORES.length
            ? scores
            : null;
        // Every answer unless the members credited or the teams ticked are chosen (ADR-311).
        const chosenSurveyAssignees =
          eventTypes.includes('satisfaction_survey.answered') && !everySurveyAssignee
            ? surveyAssigneeIds
            : null;
        const chosenSurveyTeams =
          eventTypes.includes('satisfaction_survey.answered') && !everySurveyTeam
            ? surveyTeamIds
            : null;
        // Every answer unless contact or conversation tags are given for answers (ADR-312).
        const chosenSurveyContactTags =
          eventTypes.includes('satisfaction_survey.answered') && !everySurveyContactTag
            ? surveyContactTagsText
                .split(',')
                .map((tag) => tag.trim())
                .filter((tag) => tag !== '')
            : null;
        const chosenSurveyConversationTags =
          eventTypes.includes('satisfaction_survey.answered') && !everySurveyConversationTag
            ? surveyConversationTagsText
                .split(',')
                .map((tag) => tag.trim())
                .filter((tag) => tag !== '')
            : null;
        // Every contact unless tags are given for added and changed contacts (ADR-316).
        const chosenContactEventTags =
          (eventTypes.includes('contact.created') || eventTypes.includes('contact.updated')) &&
          !everyContactEventTag
            ? contactEventTagsText
                .split(',')
                .map((tag) => tag.trim())
                .filter((tag) => tag !== '')
            : null;
        // Every contact unless field values are given for added and changed contacts (ADR-332):
        // the lines read by each field's type, the yes/no values ticked and the deleted fields'
        // values kept.
        let chosenContactEventFieldValues: WebhookContactFieldValue[] | null = null;
        if (
          (eventTypes.includes('contact.created') || eventTypes.includes('contact.updated')) &&
          !everyContactEventFieldValue
        ) {
          chosenContactEventFieldValues = [];
          for (const field of contactFieldChoices) {
            if (field.type === 'boolean') {
              for (const value of [true, false]) {
                if (
                  fieldValuesTicked.includes(webhookContactFieldValueId({ key: field.key, value }))
                )
                  chosenContactEventFieldValues.push({ key: field.key, value });
              }
              continue;
            }
            const read = webhookFieldValuesFromLines(field, fieldValueLines[field.key] ?? '');
            if (!read.ok) {
              setBusy(false);
              setError({ code: 'validation_failed', message: read.message });
              return;
            }
            for (const value of read.values) {
              chosenContactEventFieldValues.push({ key: field.key, value });
            }
            // Words of a text field, the range of a number or date field (ADR-335).
            if (field.type === 'text') {
              const typed = webhookFieldWordsFromLines(field, fieldWordLines[field.key] ?? '');
              if (!typed.ok) {
                setBusy(false);
                setError({ code: 'validation_failed', message: typed.message });
                return;
              }
              for (const contains of typed.words) {
                chosenContactEventFieldValues.push({ key: field.key, contains });
              }
            } else {
              const range = webhookFieldRangeFromInputs(
                field,
                fieldRanges[field.key]?.from ?? '',
                fieldRanges[field.key]?.to ?? '',
              );
              if (!range.ok) {
                setBusy(false);
                setError({ code: 'validation_failed', message: range.message });
                return;
              }
              if (range.range) chosenContactEventFieldValues.push(range.range);
            }
          }
          for (const pair of keptFieldValues) {
            if (fieldValuesTicked.includes(webhookContactFieldValueId(pair))) {
              chosenContactEventFieldValues.push(pair);
            }
          }
        }
        // Every conversation's events unless the members ticked are chosen (ADR-181).
        const chosenAssignees =
          webhookTakesTeamEvents(eventTypes) && !everyAssignee ? assigneeIds : null;
        // Every conversation's events unless contact tags are given (ADR-267).
        const chosenContactTags =
          webhookTakesTeamEvents(eventTypes) && !everyContactTag
            ? contactTagsText
                .split(',')
                .map((tag) => tag.trim())
                .filter((tag) => tag !== '')
            : null;
        // Every conversation's events unless conversation tags are given (ADR-273).
        const chosenConversationTags =
          webhookTakesTeamEvents(eventTypes) && !everyConversationTag
            ? conversationTagsText
                .split(',')
                .map((tag) => tag.trim())
                .filter((tag) => tag !== '')
            : null;
        const input = {
          url,
          description,
          eventTypes,
          messageStatuses,
          messageSenders,
          messageApiKeyIds: chosenMessageApiKeys,
          contactParts,
          contactFieldKeys: chosenFields,
          automationIds: chosenAutomations,
          campaignStatuses: chosenCampaignStatuses,
          orderStatuses: chosenOrderStatuses,
          paymentLinkStatuses: chosenPaymentLinkStatuses,
          codAnswers: chosenCodAnswers,
          storeIds: chosenStores,
          orderMessageEvents: chosenOrderMessageEvents,
          orderMessageSkipReasons: chosenSkipReasons,
          cartReminders: chosenCartReminders,
          cartReminderSkipReasons: chosenCartSkipReasons,
          campaignSkipReasons: chosenCampaignSkipReasons,
          runStepOutcomes: chosenRunStepOutcomes,
          runStepNodeTypes: chosenRunStepNodeTypes,
          orderChangeMakers: chosenOrderChangeMakers,
          orderExcludedApiKeyIds: chosenOrderExcludedApiKeys,
          paymentLinkApiKeyIds: chosenPaymentLinkApiKeys,
          dealStatuses: chosenDealStatuses,
          taskStatuses: chosenTaskStatuses,
          dealDetails: chosenDealDetails,
          taskDetails: chosenTaskDetails,
          templateStatuses: chosenTemplateStatuses,
          conversationStatuses: chosenConversationStatuses,
          runEndStatuses: chosenRunEndStatuses,
          runTriggers: chosenRunTriggers,
          runApiKeyIds: chosenRunApiKeys,
          consentChanges: chosenConsentChanges,
          contactSources: chosenContactSources,
          messageTypes: chosenMessageTypes,
          messageWords: chosenMessageWords,
          runEndReasons: chosenRunEndReasons,
          channelIds: chosenChannels,
          teamIds: chosenTeams,
          templateIds: chosenTemplates,
          campaignIds: chosenCampaigns,
          pipelineIds: chosenPipelines,
          stageIds: chosenStages,
          ownerIds: chosenOwners,
          taskAssigneeIds: chosenTaskAssignees,
          taskPipelineIds: chosenTaskPipelines,
          taskStageIds: chosenTaskStages,
          taskDealOwnerIds: chosenTaskDealOwners,
          notePipelineIds: chosenNotePipelines,
          noteStageIds: chosenNoteStages,
          noteDealOwnerIds: chosenNoteDealOwners,
          crmChangeMakers,
          crmExcludedApiKeyIds: chosenCrmExcludedApiKeys,
          surveyScores,
          surveyAssigneeIds: chosenSurveyAssignees,
          surveyTeamIds: chosenSurveyTeams,
          surveyContactTags: chosenSurveyContactTags,
          surveyConversationTags: chosenSurveyConversationTags,
          contactEventTags: chosenContactEventTags,
          contactEventFieldValues: chosenContactEventFieldValues,
          assigneeIds: chosenAssignees,
          contactTags: chosenContactTags,
          conversationTags: chosenConversationTags,
        };
        const done = (r: { ok: true } | { ok: false; code: string; message: string }) => {
          setBusy(false);
          if (!r.ok) setError(r);
        };
        // The OAuth client to set (ADR-173); an empty secret keeps the stored one, and a client that
        // signs with HyFib's key pair sends none, only what becomes of its key pair (ADR-367,
        // ADR-368): using or dropping the next pair names the next key shown here, so the change is
        // refused if another one has been made since.
        const signsWithKey = oauthFields.clientAuthentication === 'private_key_jwt';
        const keyAction = signsWithKey ? oauthFields.keyAction : 'keep';
        const shownNextKeyId = endpoint?.oauth?.nextPublicKey?.keyId;
        // A key pair is made for a client that had none of its own, to replace it or as the next
        // pair, with the algorithm chosen (ADR-371).
        const makesPair =
          signsWithKey &&
          (endpoint?.oauth?.clientAuthentication !== 'private_key_jwt' ||
            keyAction === 'replace' ||
            keyAction === 'make');
        const oauth = {
          tokenUrl: oauthFields.tokenUrl,
          clientId: oauthFields.clientId,
          scope: oauthFields.scope,
          clientAuthentication: oauthFields.clientAuthentication,
          ...(oauthFields.clientSecret && !signsWithKey
            ? { clientSecret: oauthFields.clientSecret }
            : {}),
          ...(webhookOAuthSignsJwts(oauthFields.clientAuthentication)
            ? { assertionAudience: oauthFields.assertionAudience }
            : {}),
          ...(keyAction === 'replace' ? { replaceKey: true } : {}),
          ...(keyAction === 'make' ? { nextKey: keyAction } : {}),
          ...((keyAction === 'use' || keyAction === 'drop') && shownNextKeyId
            ? { nextKey: keyAction, nextKeyId: shownNextKeyId }
            : {}),
          ...(makesPair ? { keyAlgorithm: oauthFields.keyAlgorithm } : {}),
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
              setOAuthFields((fields) => ({ ...fields, clientSecret: '', keyAction: 'keep' }));
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
              setPaymentLinkStatuses([...WEBHOOK_PAYMENT_LINK_STATUSES]);
              setCodAnswers([...WEBHOOK_COD_ANSWERS]);
              setEveryStore(true);
              setStoreIds([]);
              setOrderMessageEvents([...WEBHOOK_ORDER_MESSAGE_EVENTS]);
              setSkipReasons([...WEBHOOK_ORDER_MESSAGE_SKIP_REASONS]);
              setCartReminders([...WEBHOOK_CART_REMINDERS]);
              setCartSkipReasons([...WEBHOOK_CART_REMINDER_SKIP_REASONS]);
              setCampaignSkipReasons([...WEBHOOK_CAMPAIGN_SKIP_REASONS]);
              setRunStepOutcomes([...WEBHOOK_RUN_STEP_OUTCOMES]);
              setRunStepNodeTypes([...WEBHOOK_RUN_STEP_NODE_TYPES]);
              setOrderChangeMakers([...WEBHOOK_ORDER_CHANGE_MAKERS]);
              setEveryOrderChange(true);
              setOrderExcludedApiKeyIds([]);
              setEveryPaymentLinkApiKey(true);
              setPaymentLinkApiKeyIds([]);
              setDealStatuses([...WEBHOOK_DEAL_STATUSES]);
              setTaskStatuses([...WEBHOOK_TASK_STATUSES]);
              setDealDetails([...WEBHOOK_DEAL_DETAILS]);
              setTaskDetails([...WEBHOOK_TASK_DETAILS]);
              setTemplateStatuses([...WEBHOOK_TEMPLATE_STATUSES]);
              setConversationStatuses([...WEBHOOK_CONVERSATION_STATUSES]);
              setRunEndStatuses([...WEBHOOK_RUN_END_STATUSES]);
              setRunTriggers([...WEBHOOK_RUN_TRIGGERS]);
              setConsentChanges([...WEBHOOK_CONSENT_CHANGES]);
              setContactSources([...WEBHOOK_CONTACT_SOURCES]);
              setMessageTypes([...WEBHOOK_RECEIVED_MESSAGE_TYPES]);
              setEveryMessageWord(true);
              setMessageWordsText('');
              setRunEndReasons([...WEBHOOK_RUN_END_REASONS]);
              setEveryAutomation(true);
              setAutomationIds([]);
              setEveryRunApiKey(true);
              setRunApiKeyIds([]);
              setEveryMessageApiKey(true);
              setMessageApiKeyIds([]);
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
              setEveryTaskPipeline(true);
              setTaskPipelineIds([]);
              setEveryTaskStage(true);
              setTaskStageIds([]);
              setEveryTaskDealOwner(true);
              setTaskDealOwnerIds([]);
              setEveryNotePipeline(true);
              setNotePipelineIds([]);
              setEveryNoteStage(true);
              setNoteStageIds([]);
              setEveryNoteDealOwner(true);
              setNoteDealOwnerIds([]);
              setChangeMakers([...WEBHOOK_CRM_CHANGE_MAKERS]);
              setEveryCrmChange(true);
              setCrmExcludedApiKeyIds([]);
              setScores([...WEBHOOK_SURVEY_SCORES]);
              setEverySurveyAssignee(true);
              setSurveyAssigneeIds([]);
              setEverySurveyTeam(true);
              setSurveyTeamIds([]);
              setEverySurveyContactTag(true);
              setSurveyContactTagsText('');
              setEverySurveyConversationTag(true);
              setSurveyConversationTagsText('');
              setEveryContactEventTag(true);
              setContactEventTagsText('');
              setEveryContactEventFieldValue(true);
              setFieldValueLines({});
              setFieldValuesTicked([]);
              setEveryAssignee(true);
              setAssigneeIds([]);
              setEveryContactTag(true);
              setContactTagsText('');
              setEveryConversationTag(true);
              setConversationTagsText('');
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
        paymentLinkStatuses={paymentLinkStatuses}
        onPaymentLinkStatusesChange={setPaymentLinkStatuses}
        codAnswers={codAnswers}
        onCodAnswersChange={setCodAnswers}
        skipReasons={skipReasons}
        onSkipReasonsChange={setSkipReasons}
        cartSkipReasons={cartSkipReasons}
        onCartSkipReasonsChange={setCartSkipReasons}
        campaignSkipReasons={campaignSkipReasons}
        onCampaignSkipReasonsChange={setCampaignSkipReasons}
        runStepOutcomes={runStepOutcomes}
        onRunStepOutcomesChange={setRunStepOutcomes}
        runStepNodeTypes={runStepNodeTypes}
        onRunStepNodeTypesChange={setRunStepNodeTypes}
        dealStatuses={dealStatuses}
        onDealStatusesChange={setDealStatuses}
        taskStatuses={taskStatuses}
        onTaskStatusesChange={setTaskStatuses}
        dealDetails={dealDetails}
        onDealDetailsChange={setDealDetails}
        taskDetails={taskDetails}
        onTaskDetailsChange={setTaskDetails}
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
        everyMessageWord={everyMessageWord}
        onEveryMessageWordChange={setEveryMessageWord}
        messageWordsText={messageWordsText}
        onMessageWordsTextChange={setMessageWordsText}
        runEndReasons={runEndReasons}
        onRunEndReasonsChange={setRunEndReasons}
        scores={scores}
        onScoresChange={setScores}
      />
      {eventTypes.includes('message.status') ? (
        <ApiKeyChoices
          kind="messages"
          prefix={prefix}
          choices={messageApiKeyChoices}
          stored={endpoint?.messageApiKeys ?? []}
          every={everyMessageApiKey}
          onEveryChange={setEveryMessageApiKey}
          chosen={messageApiKeyIds}
          onChange={setMessageApiKeyIds}
        />
      ) : null}
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
      {webhookTakesAutomationRuns(eventTypes) ? (
        <ApiKeyChoices
          kind="runs"
          prefix={prefix}
          choices={runApiKeyChoices}
          stored={endpoint?.runApiKeys ?? []}
          every={everyRunApiKey}
          onEveryChange={setEveryRunApiKey}
          chosen={runApiKeyIds}
          onChange={setRunApiKeyIds}
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
      {webhookTakesStoreEvents(eventTypes) ? (
        <StoreChoices
          prefix={prefix}
          choices={storeChoices}
          stored={endpoint?.stores ?? []}
          every={everyStore}
          onEveryChange={setEveryStore}
          chosen={storeIds}
          onChange={setStoreIds}
        />
      ) : null}
      {webhookTakesOrderMessages(eventTypes) ? (
        <OrderMessageChoices
          prefix={prefix}
          chosen={orderMessageEvents}
          onChange={setOrderMessageEvents}
        />
      ) : null}
      {webhookTakesCartReminders(eventTypes) ? (
        <CartReminderChoices prefix={prefix} chosen={cartReminders} onChange={setCartReminders} />
      ) : null}
      {webhookTakesTeamEvents(eventTypes) ? (
        <TeamChoices
          kind="conversations"
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
          kind="conversations"
          prefix={prefix}
          choices={assigneeChoices}
          stored={endpoint?.assignees ?? []}
          every={everyAssignee}
          onEveryChange={setEveryAssignee}
          chosen={assigneeIds}
          onChange={setAssigneeIds}
        />
      ) : null}
      {webhookTakesTeamEvents(eventTypes) ? (
        <ContactTagChoices
          kind="conversations"
          prefix={prefix}
          every={everyContactTag}
          onEveryChange={setEveryContactTag}
          text={contactTagsText}
          onTextChange={setContactTagsText}
        />
      ) : null}
      {webhookTakesTeamEvents(eventTypes) ? (
        <ConversationTagChoices
          kind="conversations"
          prefix={prefix}
          every={everyConversationTag}
          onEveryChange={setEveryConversationTag}
          text={conversationTagsText}
          onTextChange={setConversationTagsText}
        />
      ) : null}
      {eventTypes.includes('order.status_changed') ? (
        <OrderChangeMakerChoices
          prefix={prefix}
          chosen={orderChangeMakers}
          onChange={setOrderChangeMakers}
        />
      ) : null}
      {eventTypes.includes('order.status_changed') ? (
        <ApiKeyChoices
          kind="orders"
          prefix={prefix}
          choices={orderApiKeyChoices}
          stored={endpoint?.orderExcludedApiKeys ?? []}
          every={everyOrderChange}
          onEveryChange={setEveryOrderChange}
          chosen={orderExcludedApiKeyIds}
          onChange={setOrderExcludedApiKeyIds}
        />
      ) : null}
      {eventTypes.includes('payment_link.status_changed') ? (
        <ApiKeyChoices
          kind="paymentLinks"
          prefix={prefix}
          choices={paymentLinkApiKeyChoices}
          stored={endpoint?.paymentLinkApiKeys ?? []}
          every={everyPaymentLinkApiKey}
          onEveryChange={setEveryPaymentLinkApiKey}
          chosen={paymentLinkApiKeyIds}
          onChange={setPaymentLinkApiKeyIds}
        />
      ) : null}
      {eventTypes.includes('satisfaction_survey.answered') ? (
        <AssigneeChoices
          kind="surveys"
          prefix={prefix}
          choices={assigneeChoices}
          stored={endpoint?.surveyAssignees ?? []}
          every={everySurveyAssignee}
          onEveryChange={setEverySurveyAssignee}
          chosen={surveyAssigneeIds}
          onChange={setSurveyAssigneeIds}
        />
      ) : null}
      {eventTypes.includes('satisfaction_survey.answered') ? (
        <TeamChoices
          kind="surveys"
          prefix={prefix}
          choices={teamChoices}
          stored={endpoint?.surveyTeams ?? []}
          every={everySurveyTeam}
          onEveryChange={setEverySurveyTeam}
          chosen={surveyTeamIds}
          onChange={setSurveyTeamIds}
        />
      ) : null}
      {eventTypes.includes('satisfaction_survey.answered') ? (
        <ContactTagChoices
          kind="surveys"
          prefix={prefix}
          every={everySurveyContactTag}
          onEveryChange={setEverySurveyContactTag}
          text={surveyContactTagsText}
          onTextChange={setSurveyContactTagsText}
        />
      ) : null}
      {eventTypes.includes('satisfaction_survey.answered') ? (
        <ConversationTagChoices
          kind="surveys"
          prefix={prefix}
          every={everySurveyConversationTag}
          onEveryChange={setEverySurveyConversationTag}
          text={surveyConversationTagsText}
          onTextChange={setSurveyConversationTagsText}
        />
      ) : null}
      {eventTypes.includes('contact.created') || eventTypes.includes('contact.updated') ? (
        <ContactTagChoices
          kind="contacts"
          prefix={prefix}
          every={everyContactEventTag}
          onEveryChange={setEveryContactEventTag}
          text={contactEventTagsText}
          onTextChange={setContactEventTagsText}
        />
      ) : null}
      {eventTypes.includes('contact.created') || eventTypes.includes('contact.updated') ? (
        <FieldValueChoices
          prefix={prefix}
          choices={contactFieldChoices}
          kept={keptFieldValues}
          every={everyContactEventFieldValue}
          onEveryChange={setEveryContactEventFieldValue}
          lines={fieldValueLines}
          onLinesChange={setFieldValueLines}
          words={fieldWordLines}
          onWordsChange={setFieldWordLines}
          ranges={fieldRanges}
          onRangesChange={setFieldRanges}
          ticked={fieldValuesTicked}
          onTickedChange={setFieldValuesTicked}
        />
      ) : null}
      {webhookTakesPipelineEvents(eventTypes) ? (
        <PipelineChoices
          kind="deals"
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
          kind="deals"
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
      {webhookTakesTaskEvents(eventTypes) ? (
        <PipelineChoices
          kind="tasks"
          prefix={prefix}
          choices={pipelineChoices}
          stored={endpoint?.taskPipelines ?? []}
          every={everyTaskPipeline}
          onEveryChange={setEveryTaskPipeline}
          chosen={taskPipelineIds}
          onChange={setTaskPipelineIds}
        />
      ) : null}
      {webhookTakesTaskEvents(eventTypes) ? (
        <StageChoices
          kind="tasks"
          prefix={prefix}
          choices={stageChoices}
          stored={endpoint?.taskStages ?? []}
          every={everyTaskStage}
          onEveryChange={setEveryTaskStage}
          chosen={taskStageIds}
          onChange={setTaskStageIds}
        />
      ) : null}
      {webhookTakesTaskEvents(eventTypes) ? (
        <CrmMemberChoices
          kind="taskDealOwners"
          prefix={prefix}
          choices={ownerChoices}
          stored={endpoint?.taskDealOwners ?? []}
          every={everyTaskDealOwner}
          onEveryChange={setEveryTaskDealOwner}
          chosen={taskDealOwnerIds}
          onChange={setTaskDealOwnerIds}
        />
      ) : null}
      {webhookTakesNoteEvents(eventTypes) ? (
        <PipelineChoices
          kind="notes"
          prefix={prefix}
          choices={pipelineChoices}
          stored={endpoint?.notePipelines ?? []}
          every={everyNotePipeline}
          onEveryChange={setEveryNotePipeline}
          chosen={notePipelineIds}
          onChange={setNotePipelineIds}
        />
      ) : null}
      {webhookTakesNoteEvents(eventTypes) ? (
        <StageChoices
          kind="notes"
          prefix={prefix}
          choices={stageChoices}
          stored={endpoint?.noteStages ?? []}
          every={everyNoteStage}
          onEveryChange={setEveryNoteStage}
          chosen={noteStageIds}
          onChange={setNoteStageIds}
        />
      ) : null}
      {webhookTakesNoteEvents(eventTypes) ? (
        <CrmMemberChoices
          kind="noteDealOwners"
          prefix={prefix}
          choices={ownerChoices}
          stored={endpoint?.noteDealOwners ?? []}
          every={everyNoteDealOwner}
          onEveryChange={setEveryNoteDealOwner}
          chosen={noteDealOwnerIds}
          onChange={setNoteDealOwnerIds}
        />
      ) : null}
      {webhookTakesCrmChanges(eventTypes) ? (
        <ChangeMakerChoices prefix={prefix} chosen={changeMakers} onChange={setChangeMakers} />
      ) : null}
      {webhookTakesCrmChanges(eventTypes) ? (
        <ApiKeyChoices
          kind="crm"
          prefix={prefix}
          choices={crmApiKeyChoices}
          stored={endpoint?.crmExcludedApiKeys ?? []}
          every={everyCrmChange}
          onEveryChange={setEveryCrmChange}
          chosen={crmExcludedApiKeyIds}
          onChange={setCrmExcludedApiKeyIds}
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
        jwksUrl={oauthJwksUrl ?? null}
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
