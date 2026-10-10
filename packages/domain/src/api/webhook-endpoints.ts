import { z } from 'zod';
import { AppError, notFound, type Clock } from '@w360/core';
import type { EgressPolicy } from '@w360/core/egress';
import {
  and,
  apiKeys,
  asc,
  desc,
  eq,
  exactTimestamp,
  isNotNull,
  sql,
  tenants,
  WEBHOOK_DELIVERY_STATES,
  webhookDeliveries,
  webhookEndpoints,
  webhookEvents,
  type Database,
  type Tx,
  type WebhookDeliveryState,
  type WebhookCampaignStatus,
  type WebhookContactPart,
  type WebhookConversationStatus,
  type WebhookEventType,
  type WebhookMessageSender,
  type WebhookCrmChangeMaker,
  type WebhookSurveyScore,
  type WebhookMessageStatus,
  type WebhookOrderStatus,
  type WebhookPaymentLinkStatus,
  type WebhookCodAnswer,
  type WebhookOrderMessageEvent,
  type WebhookOrderMessageSkipReason,
  type WebhookCartReminder,
  type WebhookCartReminderSkipReason,
  type WebhookCampaignSkipReason,
  type WebhookRunStepOutcome,
  type WebhookRunStepNodeType,
  type WebhookOrderChangeMaker,
  type WebhookDealStatus,
  type WebhookTaskStatus,
  type WebhookDealDetail,
  type WebhookTaskDetail,
  type WebhookRunEndStatus,
  type WebhookRunTrigger,
  type WebhookConsentChange,
  type ContactSource,
  type WebhookReceivedMessageType,
  type AutomationEndReason,
  type WebhookTemplateStatus,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import { deletionRecipients, formatCompanyTime } from '../tenancy/deletion';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import {
  WEBHOOK_CHANNEL_EVENTS,
  WEBHOOK_EVENT_INFO,
  WEBHOOK_LIMITS,
  webhookHost,
  webhookTakesAutomationRuns,
  webhookTakesCampaignEvents,
  webhookTakesChannelEvents,
  webhookTakesFieldChanges,
  webhookTakesPipelineEvents,
  webhookTakesStoreEvents,
  webhookTakesOrderMessages,
  webhookTakesCartReminders,
  webhookRunEndTakesReason,
  webhookTakesTaskEvents,
  webhookTakesNoteEvents,
  webhookTakesCrmChanges,
  WEBHOOK_CRM_CHANGE_MAKERS,
  WEBHOOK_SURVEY_SCORES,
  WEBHOOK_PAYMENT_LINK_STATUSES,
  WEBHOOK_RUN_STEP_OUTCOMES,
  WEBHOOK_COD_ANSWERS,
  WEBHOOK_ORDER_MESSAGE_EVENTS,
  WEBHOOK_ORDER_MESSAGE_SKIP_REASONS,
  WEBHOOK_CART_REMINDERS,
  WEBHOOK_CART_REMINDER_SKIP_REASONS,
  WEBHOOK_CAMPAIGN_SKIP_REASONS,
  WEBHOOK_RUN_STEP_NODE_TYPES,
  WEBHOOK_ORDER_CHANGE_MAKERS,
  WEBHOOK_DEAL_STATUSES,
  WEBHOOK_TASK_STATUSES,
  WEBHOOK_DEAL_DETAILS,
  WEBHOOK_TASK_DETAILS,
  webhookTakesTeamEvents,
  webhookTakesTemplateEvents,
  type WebhookContactFieldValue,
  type WebhookEndpointOAuth,
} from '../webhooks/model';
import {
  assertWebhookAssignees,
  assertWebhookAuthorization,
  assertWebhookAutomations,
  assertWebhookRunApiKeys,
  assertWebhookMessageApiKeys,
  assertWebhookCrmExcludedApiKeys,
  assertWebhookOrderExcludedApiKeys,
  assertWebhookPaymentLinkApiKeys,
  assertWebhookCampaigns,
  assertWebhookStores,
  assertWebhookChannels,
  assertWebhookPipelines,
  assertWebhookOwners,
  assertWebhookStages,
  assertWebhookTaskAssignees,
  assertWebhookTaskPipelines,
  assertWebhookTaskStages,
  assertWebhookTaskDealOwners,
  assertWebhookNotePipelines,
  assertWebhookNoteStages,
  assertWebhookNoteDealOwners,
  assertWebhookSurveyAssignees,
  assertWebhookSurveyTeams,
  assertWebhookTeams,
  assertWebhookTemplates,
  checkedWebhookOAuth,
  checkedWebhookUrl,
  deliveryEventJoin,
  insertWebhookEndpoint,
  lockWebhookEndpoint,
  NO_WEBHOOK_OAUTH,
  queueWebhookTest,
  replayFailedAcrossEndpoints,
  replayFailedWebhookDeliveries,
  replayWebhookDelivery,
  rotateWebhookEndpointSecret,
  sealWebhookHeaders,
  setWebhookEndpointEnabled,
  WEBHOOK_AUTOMATIONS_NEED_THE_EVENTS,
  WEBHOOK_CAMPAIGN_STATUSES_NEED_THE_EVENT,
  WEBHOOK_CHANNELS_NEED_THE_EVENTS,
  WEBHOOK_CONVERSATION_STATUSES_NEED_THE_EVENT,
  WEBHOOK_ORDER_STATUSES_NEED_THE_EVENT,
  WEBHOOK_PAYMENT_LINK_STATUSES_NEED_THE_EVENT,
  WEBHOOK_RUN_STEP_OUTCOMES_NEED_THE_EVENT,
  WEBHOOK_COD_ANSWERS_NEED_THE_EVENT,
  WEBHOOK_STORES_NEED_THE_EVENT,
  WEBHOOK_ORDER_MESSAGES_NEED_THE_EVENT,
  WEBHOOK_ORDER_MESSAGE_SKIP_REASONS_NEED_THE_EVENT,
  WEBHOOK_CART_REMINDERS_NEED_THE_EVENT,
  WEBHOOK_CART_REMINDER_SKIP_REASONS_NEED_THE_EVENT,
  WEBHOOK_CAMPAIGN_SKIP_REASONS_NEED_THE_EVENT,
  WEBHOOK_RUN_STEP_NODE_TYPES_NEED_THE_EVENT,
  WEBHOOK_ORDER_CHANGE_MAKERS_NEED_THE_EVENT,
  WEBHOOK_ORDER_EXCLUDED_API_KEYS_NEED_THE_EVENT,
  WEBHOOK_PAYMENT_LINK_API_KEYS_NEED_THE_EVENT,
  WEBHOOK_DEAL_STATUSES_NEED_THE_EVENT,
  WEBHOOK_TASK_STATUSES_NEED_THE_EVENT,
  WEBHOOK_DEAL_DETAILS_NEED_THE_EVENT,
  WEBHOOK_TASK_DETAILS_NEED_THE_EVENT,
  WEBHOOK_RUN_END_STATUSES_NEED_THE_EVENT,
  WEBHOOK_RUN_TRIGGERS_NEED_THE_EVENTS,
  WEBHOOK_RUN_API_KEYS_NEED_THE_EVENTS,
  WEBHOOK_CONSENT_CHANGES_NEED_THE_EVENT,
  WEBHOOK_CONTACT_SOURCES_NEED_THE_EVENT,
  WEBHOOK_MESSAGE_TYPES_NEED_THE_EVENT,
  WEBHOOK_MESSAGE_WORDS_NEED_THE_EVENT,
  WEBHOOK_RUN_END_REASONS_NEED_THE_EVENT,
  WEBHOOK_RUN_END_REASONS_NEED_THE_ENDS,
  WEBHOOK_SENDERS_NEED_THE_EVENT,
  WEBHOOK_MESSAGE_API_KEYS_NEED_THE_EVENT,
  WEBHOOK_TEAMS_NEED_THE_EVENTS,
  WEBHOOK_TEMPLATES_NEED_THE_EVENTS,
  WEBHOOK_CAMPAIGNS_NEED_THE_EVENTS,
  WEBHOOK_PIPELINES_NEED_THE_EVENTS,
  WEBHOOK_STAGES_NEED_THE_EVENTS,
  WEBHOOK_OWNERS_NEED_THE_EVENTS,
  WEBHOOK_TASK_ASSIGNEES_NEED_THE_EVENTS,
  WEBHOOK_TASK_PIPELINES_NEED_THE_EVENTS,
  WEBHOOK_TASK_STAGES_NEED_THE_EVENTS,
  WEBHOOK_TASK_DEAL_OWNERS_NEED_THE_EVENTS,
  WEBHOOK_NOTE_PIPELINES_NEED_THE_EVENTS,
  WEBHOOK_NOTE_STAGES_NEED_THE_EVENTS,
  WEBHOOK_NOTE_DEAL_OWNERS_NEED_THE_EVENTS,
  WEBHOOK_CRM_CHANGE_MAKERS_NEED_THE_EVENTS,
  WEBHOOK_CRM_EXCLUDED_API_KEYS_NEED_THE_EVENTS,
  WEBHOOK_SURVEY_SCORES_NEED_THE_EVENT,
  WEBHOOK_SURVEY_ASSIGNEES_NEED_THE_EVENT,
  WEBHOOK_SURVEY_TEAMS_NEED_THE_EVENT,
  WEBHOOK_SURVEY_CONTACT_TAGS_NEED_THE_EVENT,
  WEBHOOK_SURVEY_CONVERSATION_TAGS_NEED_THE_EVENT,
  WEBHOOK_CONTACT_EVENT_TAGS_NEED_THE_EVENTS,
  WEBHOOK_CONTACT_EVENT_FIELD_VALUES_NEED_THE_EVENTS,
  WEBHOOK_ASSIGNEES_NEED_THE_EVENTS,
  WEBHOOK_CONTACT_TAGS_NEED_THE_EVENTS,
  WEBHOOK_CONVERSATION_TAGS_NEED_THE_EVENTS,
  WEBHOOK_TEMPLATE_STATUSES_NEED_THE_EVENT,
  webhookAutomationIdsFor,
  webhookAutomationIdsSchema,
  webhookCampaignStatusesFor,
  webhookCampaignStatusesSchema,
  webhookChannelIdsFor,
  webhookChannelIdsSchema,
  webhookContactPartsFor,
  webhookContactFieldKeysFor,
  webhookContactFieldKeysSchema,
  webhookFieldsNeedThePart,
  assertWebhookContactFields,
  WEBHOOK_FIELDS_NEED_THE_PART,
  webhookConversationStatusesFor,
  webhookConversationStatusesSchema,
  webhookRunEndStatusesFor,
  webhookRunEndStatusesSchema,
  webhookRunTriggersFor,
  webhookRunTriggersSchema,
  webhookRunApiKeyIdsFor,
  webhookRunApiKeyIdsSchema,
  webhookConsentChangesFor,
  webhookConsentChangesSchema,
  webhookContactSourcesFor,
  webhookContactSourcesSchema,
  webhookMessageTypesFor,
  webhookMessageTypesSchema,
  webhookMessageWordsFor,
  webhookMessageWordsSchema,
  webhookRunEndReasonsFor,
  webhookRunEndReasonsNeedTheEnds,
  webhookRunEndReasonsSchema,
  webhookTeamIdsFor,
  webhookTeamIdsSchema,
  webhookTemplateIdsFor,
  webhookTemplateIdsSchema,
  webhookCampaignIdsFor,
  webhookCampaignIdsSchema,
  webhookPipelineIdsFor,
  webhookPipelineIdsSchema,
  webhookStageIdsFor,
  webhookStageIdsSchema,
  webhookOwnerIdsFor,
  webhookOwnerIdsSchema,
  webhookTaskAssigneeIdsFor,
  webhookTaskAssigneeIdsSchema,
  webhookTaskPipelineIdsFor,
  webhookTaskPipelineIdsSchema,
  webhookTaskStageIdsFor,
  webhookTaskStageIdsSchema,
  webhookTaskDealOwnerIdsFor,
  webhookTaskDealOwnerIdsSchema,
  webhookNotePipelineIdsFor,
  webhookNotePipelineIdsSchema,
  webhookNoteStageIdsFor,
  webhookNoteStageIdsSchema,
  webhookNoteDealOwnerIdsFor,
  webhookNoteDealOwnerIdsSchema,
  webhookCrmChangeMakersFor,
  webhookCrmChangeMakersSchema,
  webhookCrmExcludedApiKeyIdsFor,
  webhookCrmExcludedApiKeyIdsSchema,
  webhookSurveyScoresFor,
  webhookSurveyScoresSchema,
  webhookSurveyAssigneeIdsFor,
  webhookSurveyAssigneeIdsSchema,
  webhookSurveyTeamIdsFor,
  webhookSurveyTeamIdsSchema,
  webhookSurveyContactTagsFor,
  webhookSurveyContactTagsSchema,
  webhookSurveyConversationTagsFor,
  webhookSurveyConversationTagsSchema,
  webhookContactEventTagsFor,
  webhookContactEventTagsSchema,
  webhookContactEventFieldValuesChecked,
  webhookContactEventFieldValuesFor,
  webhookContactEventFieldValuesSchema,
  webhookAssigneeIdsFor,
  webhookAssigneeIdsSchema,
  webhookContactTagsFor,
  webhookContactTagsSchema,
  webhookConversationTagsFor,
  webhookConversationTagsSchema,
  webhookContactPartsSchema,
  webhookDeliveryColumns,
  WEBHOOK_PARTS_NEED_THE_EVENT,
  WEBHOOK_STATUSES_NEED_THE_EVENT,
  webhookEventTypesSchema,
  webhookFailureKindsSchema,
  webhookHeadersSchema,
  webhookMessageSendersFor,
  webhookMessageSendersSchema,
  webhookMessageApiKeyIdsFor,
  webhookMessageApiKeyIdsSchema,
  webhookMessageStatusesFor,
  webhookMessageStatusesSchema,
  webhookEndpointAuditMetadata,
  webhookOAuthAudit,
  webhookOAuthClientAuthAudit,
  webhookOAuthColumns,
  webhookOAuthSchema,
  webhookOrderStatusesFor,
  webhookOrderStatusesSchema,
  webhookPaymentLinkStatusesFor,
  webhookPaymentLinkStatusesSchema,
  webhookRunStepOutcomesFor,
  webhookRunStepOutcomesSchema,
  webhookCodAnswersFor,
  webhookCodAnswersSchema,
  webhookStoreIdsFor,
  webhookStoreIdsSchema,
  webhookOrderMessageEventsFor,
  webhookOrderMessageEventsSchema,
  webhookOrderMessageSkipReasonsFor,
  webhookOrderMessageSkipReasonsSchema,
  webhookCartRemindersFor,
  webhookCartRemindersSchema,
  webhookCartReminderSkipReasonsFor,
  webhookCartReminderSkipReasonsSchema,
  webhookCampaignSkipReasonsFor,
  webhookCampaignSkipReasonsSchema,
  webhookRunStepNodeTypesFor,
  webhookRunStepNodeTypesSchema,
  webhookOrderChangeMakersFor,
  webhookOrderChangeMakersSchema,
  webhookOrderExcludedApiKeyIdsFor,
  webhookOrderExcludedApiKeyIdsSchema,
  webhookPaymentLinkApiKeyIdsFor,
  webhookPaymentLinkApiKeyIdsSchema,
  webhookDealStatusesFor,
  webhookDealStatusesSchema,
  webhookTaskStatusesFor,
  webhookTaskStatusesSchema,
  webhookDealDetailsFor,
  webhookDealDetailsSchema,
  webhookTaskDetailsFor,
  webhookTaskDetailsSchema,
  webhookTemplateStatusesFor,
  webhookTemplateStatusesSchema,
  type WebhookDeliveryView,
} from '../webhooks/service';
import { apiActor, assertScope, type ApiContext } from './context';
import type { ApiResponse, IdempotencyInput } from './idempotency';
import { API_LIMITS } from './model';
import { idempotent } from './resources';

/**
 * Webhook endpoints through the public API (ADR-081): a `webhooks.manage` key adds endpoints and
 * reads, changes, rotates the secret of and deletes the endpoints keys added; it also reads their
 * deliveries, sends them test events and replays finished deliveries (ADR-083). Endpoints members
 * added in settings, and their deliveries, are not found: their addresses can carry a receiver's
 * own token, and they stay under members' control. Settings → Webhooks shows every endpoint,
 * whoever added it.
 */

const descriptionField = z
  .string()
  .trim()
  .max(WEBHOOK_LIMITS.descriptionLength, 'Keep the description under 200 characters');

const headersField = webhookHeadersSchema.describe(
  `Up to ${WEBHOOK_LIMITS.headers} headers the receiver asks for, sent with every delivery (for example an Authorization header it issued). Values are secrets: they are stored encrypted and never shown again. Not allowed: Content-Type, Content-Encoding, User-Agent, the transport's headers (Host, Content-Length, Transfer-Encoding, Connection, Keep-Alive, Upgrade, TE, Trailer, Expect, Accept-Encoding), Proxy-* and HyFib's W360-*.`,
);

const messageStatusesField = webhookMessageStatusesSchema.describe(
  'The message.status statuses the endpoint receives (accepted, sent, delivered, read, played, failed, canceled, unknown_outcome), only with the message.status event; null receives every status, including statuses added later.',
);

/** Statuses are chosen only for an endpoint that receives `message.status` (ADR-119). */
const invalidStatuses = () =>
  new AppError('validation_failed', WEBHOOK_STATUSES_NEED_THE_EVENT, {
    issues: [{ path: 'messageStatuses', message: WEBHOOK_STATUSES_NEED_THE_EVENT }],
  });

const messageSendersField = webhookMessageSendersSchema.describe(
  'Who sent the messages whose message.status the endpoint receives, as the event names them in message.sentBy (agent: a member, bot: an automation, campaign, api, system: HyFib itself, such as store order updates and satisfaction surveys), only with the message.status event; null receives the statuses of every message.',
);

/** Senders are chosen only for an endpoint that receives `message.status` (ADR-172). */
const invalidSenders = () =>
  new AppError('validation_failed', WEBHOOK_SENDERS_NEED_THE_EVENT, {
    issues: [{ path: 'messageSenders', message: WEBHOOK_SENDERS_NEED_THE_EVENT }],
  });

const messageApiKeyIdsField = webhookMessageApiKeyIdsSchema.describe(
  `The API keys whose sent messages' message.status the endpoint receives: 1 to ${WEBHOOK_LIMITS.messageApiKeys} ids of the company's keys whose messages carry them (messages.send, messages.send_marketing, messages.reply, or orders.request_payment, whose Payment Link is sent in the chat as the key), as message.apiKeyId names them (a key that adds an endpoint finds its own id in the endpoint's apiKeyId), only with the message.status event. A status is received when the key that sent the message through the API is listed, or a key it was rotated from or into, so a list keeps an integration's messages across rotations; a revoked or expired key stays allowed, as the messages it sent still change status. A message sent otherwise (by a member, an automation, a campaign or HyFib itself) belongs to no key and its statuses are not received. With the statuses or who sent the messages too, a status must pass them all. null receives the statuses of every message.`,
);

/** Keys for messages are chosen only for an endpoint that receives `message.status` (ADR-320). */
const invalidMessageApiKeys = () =>
  new AppError('validation_failed', WEBHOOK_MESSAGE_API_KEYS_NEED_THE_EVENT, {
    issues: [{ path: 'messageApiKeyIds', message: WEBHOOK_MESSAGE_API_KEYS_NEED_THE_EVENT }],
  });

const contactPartsField = webhookContactPartsSchema.describe(
  'The parts of a contact whose change the endpoint receives as contact.updated (name, phone, email, tags, fields: a change of any custom field), only with the contact.updated event: an event is sent when its change names one of them, and names every part that changed; null receives every change, including parts added later.',
);

/** Contact parts are chosen only for an endpoint that receives `contact.updated` (ADR-123). */
const invalidParts = () =>
  new AppError('validation_failed', WEBHOOK_PARTS_NEED_THE_EVENT, {
    issues: [{ path: 'contactParts', message: WEBHOOK_PARTS_NEED_THE_EVENT }],
  });

const contactFieldKeysField = webhookContactFieldKeysSchema.describe(
  `The custom fields whose value changes the endpoint receives as contact.updated: 1 to ${WEBHOOK_LIMITS.contactFields} keys of the company's fields (GET /contact-fields), only with contact.updated for every part or for \`fields\`. A change of a custom field is then sent only when its key is listed (the event still names every part that changed); changes of the other parts are narrowed by \`contactParts\` alone. null receives every field's changes, including fields added later.`,
);

const automationIdsField = webhookAutomationIdsSchema.describe(
  `The automations whose runs the endpoint receives as automation.run_started, automation.run_ended and automation.run_step, 1 to ${WEBHOOK_LIMITS.automations} ids of the company's automations that have been published (an archived one stays allowed), only with one of those events; null receives every automation's runs, including automations published later.`,
);

/** Automations are chosen only for an endpoint that receives automation runs (ADR-145). */
const invalidAutomations = () =>
  new AppError('validation_failed', WEBHOOK_AUTOMATIONS_NEED_THE_EVENTS, {
    issues: [{ path: 'automationIds', message: WEBHOOK_AUTOMATIONS_NEED_THE_EVENTS }],
  });

const campaignStatusesField = webhookCampaignStatusesSchema.describe(
  'The statuses a campaign reaches that the endpoint receives as campaign.status_changed (draft, pending_approval, scheduled, running, paused, completed, canceled), only with the campaign.status_changed event; null receives every status.',
);

/** Campaign statuses are chosen only for an endpoint that receives campaign changes (ADR-146). */
const invalidCampaignStatuses = () =>
  new AppError('validation_failed', WEBHOOK_CAMPAIGN_STATUSES_NEED_THE_EVENT, {
    issues: [{ path: 'campaignStatuses', message: WEBHOOK_CAMPAIGN_STATUSES_NEED_THE_EVENT }],
  });

const orderStatusesField = webhookOrderStatusesSchema.describe(
  'The statuses an order reaches that the endpoint receives as order.status_changed (confirmed, awaiting_payment, paid, fulfilled, cancelled), only with the order.status_changed event; null receives every status.',
);

/** Order statuses are chosen only for an endpoint that receives order changes (ADR-147). */
const invalidOrderStatuses = () =>
  new AppError('validation_failed', WEBHOOK_ORDER_STATUSES_NEED_THE_EVENT, {
    issues: [{ path: 'orderStatuses', message: WEBHOOK_ORDER_STATUSES_NEED_THE_EVENT }],
  });

const paymentLinkStatusesField = webhookPaymentLinkStatusesSchema.describe(
  `The statuses a Payment Link reaches that the endpoint receives as payment_link.status_changed (${WEBHOOK_PAYMENT_LINK_STATUSES.join(', ')}), only with the payment_link.status_changed event; null receives every status.`,
);

/** Payment Link statuses are chosen only for an endpoint that receives link changes (ADR-308). */
const invalidPaymentLinkStatuses = () =>
  new AppError('validation_failed', WEBHOOK_PAYMENT_LINK_STATUSES_NEED_THE_EVENT, {
    issues: [
      { path: 'paymentLinkStatuses', message: WEBHOOK_PAYMENT_LINK_STATUSES_NEED_THE_EVENT },
    ],
  });

const runStepOutcomesField = webhookRunStepOutcomesSchema.describe(
  `The outcomes of the run steps the endpoint receives as automation.run_step (${WEBHOOK_RUN_STEP_OUTCOMES.join(', ')}), as step.outcome names them, only with the automation.run_step event; null receives every step. With the automations, what started the runs, their API keys or the numbers chosen too, a step must pass them all.`,
);

/** Step outcomes are chosen only for an endpoint that receives run steps (ADR-327). */
const invalidRunStepOutcomes = () =>
  new AppError('validation_failed', WEBHOOK_RUN_STEP_OUTCOMES_NEED_THE_EVENT, {
    issues: [{ path: 'runStepOutcomes', message: WEBHOOK_RUN_STEP_OUTCOMES_NEED_THE_EVENT }],
  });

const codAnswersField = webhookCodAnswersSchema.describe(
  `The cash on delivery answers the endpoint receives as store_order.cod_answered (${WEBHOOK_COD_ANSWERS.join(', ')}), as confirmation.answer names them, only with the store_order.cod_answered event; null receives every answer, as a list of both does. With the stores or the numbers chosen too, an answer must pass them all.`,
);

/** Answers are chosen only for an endpoint that receives cash on delivery answers (ADR-349). */
const invalidCodAnswers = () =>
  new AppError('validation_failed', WEBHOOK_COD_ANSWERS_NEED_THE_EVENT, {
    issues: [{ path: 'codAnswers', message: WEBHOOK_COD_ANSWERS_NEED_THE_EVENT }],
  });

const storeIdsField = webhookStoreIdsSchema.describe(
  `The connected stores whose cash on delivery answers, skipped and sent order messages and skipped and sent cart reminders the endpoint receives: 1 to ${WEBHOOK_LIMITS.stores} ids of the company's stores (as store_order.cod_answered, store_order.message_skipped, store_order.message_sent, store_checkout.reminder_skipped and store_checkout.reminder_sent events give them in \`store.id\`), only with one of those events. An answer or an order message belongs to the store of its order, and a cart reminder to the store of its checkout. A store removed since it was chosen stays on the list and matches nothing; a company has at most 5 stores at once. With the answers, the order messages, the skip reasons or the numbers chosen too, an event must pass each list that applies to it (a skipped message or reminder belongs to no number). null receives every store's, including those of stores connected later.`,
);

/**
 * Stores are chosen only for an endpoint that receives cash on delivery answers (ADR-349), skipped
 * (ADR-352) or sent (ADR-353) order messages, or cart reminders (ADR-355).
 */
const invalidStores = () =>
  new AppError('validation_failed', WEBHOOK_STORES_NEED_THE_EVENT, {
    issues: [{ path: 'storeIds', message: WEBHOOK_STORES_NEED_THE_EVENT }],
  });

const orderMessageEventsField = webhookOrderMessageEventsSchema.describe(
  `The order messages whose skips and sends the endpoint receives as store_order.message_skipped and store_order.message_sent (${WEBHOOK_ORDER_MESSAGE_EVENTS.join(', ')}), as orderMessage.event names them, only with one of those events; null receives every message's, as a list of all five does. With the stores chosen too, or the numbers for sent messages (a skipped message belongs to no number), an event must pass them all.`,
);

/** Order messages are chosen only for an endpoint that receives skipped or sent ones (ADR-352, ADR-353). */
const invalidOrderMessageEvents = () =>
  new AppError('validation_failed', WEBHOOK_ORDER_MESSAGES_NEED_THE_EVENT, {
    issues: [{ path: 'orderMessageEvents', message: WEBHOOK_ORDER_MESSAGES_NEED_THE_EVENT }],
  });

const orderMessageSkipReasonsField = webhookOrderMessageSkipReasonsSchema.describe(
  `The reasons whose order message skips the endpoint receives as store_order.message_skipped (${WEBHOOK_ORDER_MESSAGE_SKIP_REASONS.join(', ')}), as orderMessage.skipReason names them, only with that event; null receives every reason's, as a list of all of them does. The reasons that concern cart reminders only are not among them: a skipped cart reminder sends store_checkout.reminder_skipped, which this list does not narrow (cartReminderSkipReasons does). With the stores or the order messages chosen too, a skipped message must pass them all.`,
);

/** Skip reasons are chosen only for an endpoint that receives skipped order messages (ADR-354). */
const invalidOrderMessageSkipReasons = () =>
  new AppError('validation_failed', WEBHOOK_ORDER_MESSAGE_SKIP_REASONS_NEED_THE_EVENT, {
    issues: [
      {
        path: 'orderMessageSkipReasons',
        message: WEBHOOK_ORDER_MESSAGE_SKIP_REASONS_NEED_THE_EVENT,
      },
    ],
  });

const cartRemindersField = webhookCartRemindersSchema.describe(
  `The cart reminders whose skips and sends the endpoint receives as store_checkout.reminder_skipped and store_checkout.reminder_sent (${WEBHOOK_CART_REMINDERS.join(', ')}: the first and the second), as reminder.event names them, only with either event; null receives both, as a list of both does. With the stores, and the skip reasons for a skipped reminder or the numbers for a sent one, chosen too, a reminder's event must pass them all.`,
);

/** Cart reminders are chosen only for an endpoint that receives skipped or sent ones (ADR-361). */
const invalidCartReminders = () =>
  new AppError('validation_failed', WEBHOOK_CART_REMINDERS_NEED_THE_EVENT, {
    issues: [{ path: 'cartReminders', message: WEBHOOK_CART_REMINDERS_NEED_THE_EVENT }],
  });

const cartReminderSkipReasonsField = webhookCartReminderSkipReasonsSchema.describe(
  `The reasons whose cart reminder skips the endpoint receives as store_checkout.reminder_skipped (${WEBHOOK_CART_REMINDER_SKIP_REASONS.join(', ')}), as reminder.skipReason names them, only with that event; null receives every reason's, as a list of all of them does. With the stores or the cart reminders chosen too, a skipped reminder must pass them all.`,
);

/** Cart reminder skip reasons are chosen only for an endpoint that receives them (ADR-356). */
const invalidCartReminderSkipReasons = () =>
  new AppError('validation_failed', WEBHOOK_CART_REMINDER_SKIP_REASONS_NEED_THE_EVENT, {
    issues: [
      {
        path: 'cartReminderSkipReasons',
        message: WEBHOOK_CART_REMINDER_SKIP_REASONS_NEED_THE_EVENT,
      },
    ],
  });

const campaignSkipReasonsField = webhookCampaignSkipReasonsSchema.describe(
  `The reasons whose campaign recipient skips the endpoint receives as campaign.recipient_skipped (${WEBHOOK_CAMPAIGN_SKIP_REASONS.join(', ')}), as recipient.skipReason names them, only with that event; null receives every reason's, as a list of all of them does. With the campaigns or the numbers chosen too, a skipped recipient must pass them all.`,
);

/** Campaign skip reasons are chosen only for an endpoint that receives skipped recipients (ADR-359). */
const invalidCampaignSkipReasons = () =>
  new AppError('validation_failed', WEBHOOK_CAMPAIGN_SKIP_REASONS_NEED_THE_EVENT, {
    issues: [
      { path: 'campaignSkipReasons', message: WEBHOOK_CAMPAIGN_SKIP_REASONS_NEED_THE_EVENT },
    ],
  });

const runStepNodeTypesField = webhookRunStepNodeTypesSchema.describe(
  `The kinds of node whose run steps the endpoint receives as automation.run_step (${WEBHOOK_RUN_STEP_NODE_TYPES.join(', ')}), as step.nodeType names them, and outside_node for the steps outside a node (step.nodeType null: the run starting, being stopped or taken over, or failing between steps), only with the automation.run_step event. null receives every step, as a list of all of them does. With the step outcomes, the automations, what started the runs, their API keys or the numbers chosen too, a step must pass them all.`,
);

/** Kinds of step are chosen only for an endpoint that receives run steps (ADR-328). */
const invalidRunStepNodeTypes = () =>
  new AppError('validation_failed', WEBHOOK_RUN_STEP_NODE_TYPES_NEED_THE_EVENT, {
    issues: [{ path: 'runStepNodeTypes', message: WEBHOOK_RUN_STEP_NODE_TYPES_NEED_THE_EVENT }],
  });

const orderChangeMakersField = webhookOrderChangeMakersSchema.describe(
  `Who made the order status changes the endpoint receives as order.status_changed, as the event's changedBy names them (${WEBHOOK_ORDER_CHANGE_MAKERS.join(', ')}): a member on the order page, an API key, or HyFib applying what Razorpay reports for the order's Payment Link; only with the order.status_changed event. A change HyFib did not record the maker of is received whoever is listed, so an integration that moves orders through the API can leave out api and still receive members' and payments' changes. order.received is not narrowed. null receives every change.`,
);

/** Who made the order changes is chosen only for an endpoint that receives them (ADR-322). */
const invalidOrderChangeMakers = () =>
  new AppError('validation_failed', WEBHOOK_ORDER_CHANGE_MAKERS_NEED_THE_EVENT, {
    issues: [{ path: 'orderChangeMakers', message: WEBHOOK_ORDER_CHANGE_MAKERS_NEED_THE_EVENT }],
  });

const orderExcludedApiKeyIdsField = webhookOrderExcludedApiKeyIdsSchema.describe(
  `The API keys whose order status changes the endpoint does not receive as order.status_changed: 1 to ${WEBHOOK_LIMITS.orderExcludedApiKeys} ids of the company's keys that can change orders (orders.write, or orders.request_payment, whose request leaves an order waiting for payment), as the event's apiKeyId names the key that made a change, only with the order.status_changed event. A change is left out when the key that made it is listed, or a key it was rotated from or into, so an order system that moves orders through the API is not sent back what it changed, across rotations, while it is sent the changes of members, Payment Links and other keys. A change HyFib did not record the maker of is never left out, and order.received is not narrowed. With order statuses, who made the changes or other lists too, an event must pass them all. null leaves nothing out.`,
);

/** Keys are left out of order changes only for an endpoint that receives them (ADR-323). */
const invalidOrderExcludedApiKeys = () =>
  new AppError('validation_failed', WEBHOOK_ORDER_EXCLUDED_API_KEYS_NEED_THE_EVENT, {
    issues: [
      { path: 'orderExcludedApiKeyIds', message: WEBHOOK_ORDER_EXCLUDED_API_KEYS_NEED_THE_EVENT },
    ],
  });

const paymentLinkApiKeyIdsField = webhookPaymentLinkApiKeyIdsSchema.describe(
  `The API keys whose Payment Links' payment_link.status_changed the endpoint receives: 1 to ${WEBHOOK_LIMITS.paymentLinkApiKeys} ids of the company's keys that ask customers to pay (orders.request_payment), as the event's paymentLink.requestedByApiKeyId names the key that asked for a link (a key that adds an endpoint finds its own id in the endpoint's apiKeyId), only with the payment_link.status_changed event. A link matches when the key that asked for it is listed, or a key it was rotated from or into, so a payments integration with its own key is sent its own links' changes only, across rotations; a link a member asked for matches no list. A key revoked or expired since stays on the list, and its links still change status. With Payment Link statuses or numbers chosen too, a change must pass them all. null receives every link's changes.`,
);

/** Keys are chosen for Payment Links only for an endpoint that receives their changes (ADR-324). */
const invalidPaymentLinkApiKeys = () =>
  new AppError('validation_failed', WEBHOOK_PAYMENT_LINK_API_KEYS_NEED_THE_EVENT, {
    issues: [
      { path: 'paymentLinkApiKeyIds', message: WEBHOOK_PAYMENT_LINK_API_KEYS_NEED_THE_EVENT },
    ],
  });

const dealStatusesField = webhookDealStatusesSchema.describe(
  `The statuses a deal reaches that the endpoint receives as deal.status_changed (${WEBHOOK_DEAL_STATUSES.join(', ')}; open is a deal reopened), only with the deal.status_changed event; null receives every status.`,
);

/** Deal statuses are chosen only for an endpoint that receives deal status changes (ADR-309). */
const invalidDealStatuses = () =>
  new AppError('validation_failed', WEBHOOK_DEAL_STATUSES_NEED_THE_EVENT, {
    issues: [{ path: 'dealStatuses', message: WEBHOOK_DEAL_STATUSES_NEED_THE_EVENT }],
  });

const taskStatusesField = webhookTaskStatusesSchema.describe(
  `The statuses a task reaches that the endpoint receives as task.status_changed (${WEBHOOK_TASK_STATUSES.join(', ')}; open is a task reopened), only with the task.status_changed event; null receives every status.`,
);

/** Task statuses are chosen only for an endpoint that receives task status changes (ADR-309). */
const invalidTaskStatuses = () =>
  new AppError('validation_failed', WEBHOOK_TASK_STATUSES_NEED_THE_EVENT, {
    issues: [{ path: 'taskStatuses', message: WEBHOOK_TASK_STATUSES_NEED_THE_EVENT }],
  });

const dealDetailsField = webhookDealDetailsSchema.describe(
  `The deal details whose changes the endpoint receives as deal.updated (${WEBHOOK_DEAL_DETAILS.join(', ')}, as the event's changes names them): a change is sent when it changed one of them, naming every detail it changed; only with the deal.updated event. null receives every change.`,
);

/** Deal details are chosen only for an endpoint that receives deals' detail changes (ADR-310). */
const invalidDealDetails = () =>
  new AppError('validation_failed', WEBHOOK_DEAL_DETAILS_NEED_THE_EVENT, {
    issues: [{ path: 'dealDetails', message: WEBHOOK_DEAL_DETAILS_NEED_THE_EVENT }],
  });

const taskDetailsField = webhookTaskDetailsSchema.describe(
  `The task details whose changes the endpoint receives as task.updated (${WEBHOOK_TASK_DETAILS.join(', ')}, as the event's changes names them): a change is sent when it changed one of them, naming every detail it changed; only with the task.updated event. null receives every change.`,
);

/** Task details are chosen only for an endpoint that receives tasks' detail changes (ADR-310). */
const invalidTaskDetails = () =>
  new AppError('validation_failed', WEBHOOK_TASK_DETAILS_NEED_THE_EVENT, {
    issues: [{ path: 'taskDetails', message: WEBHOOK_TASK_DETAILS_NEED_THE_EVENT }],
  });

const templateStatusesField = webhookTemplateStatusesSchema.describe(
  'The template statuses the endpoint receives as template.status_changed (pending, approved, rejected, paused, disabled, in_appeal, flagged, archived, deleted, limit_exceeded, locked), only with the template.status_changed event; null receives every status.',
);

/** Template statuses are chosen only for an endpoint that receives template changes (ADR-148). */
const invalidTemplateStatuses = () =>
  new AppError('validation_failed', WEBHOOK_TEMPLATE_STATUSES_NEED_THE_EVENT, {
    issues: [{ path: 'templateStatuses', message: WEBHOOK_TEMPLATE_STATUSES_NEED_THE_EVENT }],
  });

const conversationStatusesField = webhookConversationStatusesSchema.describe(
  'The statuses a conversation reaches that the endpoint receives as conversation.status_changed (open, resolved), only with the conversation.status_changed event; null receives every status.',
);

/** Conversation statuses are chosen only for an endpoint that receives their changes (ADR-149). */
const invalidConversationStatuses = () =>
  new AppError('validation_failed', WEBHOOK_CONVERSATION_STATUSES_NEED_THE_EVENT, {
    issues: [
      { path: 'conversationStatuses', message: WEBHOOK_CONVERSATION_STATUSES_NEED_THE_EVENT },
    ],
  });

const runEndStatusesField = webhookRunEndStatusesSchema.describe(
  'The statuses a run ended with that the endpoint receives as automation.run_ended (completed, handed_off, taken_over, stopped, failed), only with the automation.run_ended event; null receives every end.',
);

/** How runs ended is chosen only for an endpoint that receives their ends (ADR-151). */
const invalidRunEndStatuses = () =>
  new AppError('validation_failed', WEBHOOK_RUN_END_STATUSES_NEED_THE_EVENT, {
    issues: [{ path: 'runEndStatuses', message: WEBHOOK_RUN_END_STATUSES_NEED_THE_EVENT }],
  });

const runTriggersField = webhookRunTriggersSchema.describe(
  'What started the runs whose events the endpoint receives, as `run.trigger` names it (keyword, conversation_started, any_message, store_event, api), only with automation.run_started, automation.run_ended or automation.run_step; the three events are narrowed alike. null receives every run.',
);

/** What started the runs is chosen only for an endpoint that receives run events (ADR-183). */
const invalidRunTriggers = () =>
  new AppError('validation_failed', WEBHOOK_RUN_TRIGGERS_NEED_THE_EVENTS, {
    issues: [{ path: 'runTriggers', message: WEBHOOK_RUN_TRIGGERS_NEED_THE_EVENTS }],
  });

const runApiKeyIdsField = webhookRunApiKeyIdsSchema.describe(
  `The API keys whose runs the endpoint receives as automation.run_started, automation.run_ended and automation.run_step: 1 to ${WEBHOOK_LIMITS.runApiKeys} ids of the company's keys that can start automations (automations.start), as run.apiKeyId names them (a key that adds an endpoint finds its own id in the endpoint's apiKeyId), only with one of those events. A run started through the API is received when the key that started it is listed, or a key it was rotated from or into, so a list keeps an integration's runs across rotations; a revoked or expired key stays allowed, as the runs it started still end. A run started otherwise belongs to no key and is not received. With the automations or what started the runs too, a run must pass them all. null receives every run.`,
);

/** API keys are chosen only for an endpoint that receives run events (ADR-319). */
const invalidRunApiKeys = () =>
  new AppError('validation_failed', WEBHOOK_RUN_API_KEYS_NEED_THE_EVENTS, {
    issues: [{ path: 'runApiKeyIds', message: WEBHOOK_RUN_API_KEYS_NEED_THE_EVENTS }],
  });

const consentChangesField = webhookConsentChangesSchema.describe(
  "The consent changes the endpoint receives as consent.changed, by the event's purpose and action (marketing_opt_in, marketing_opt_out, utility_opt_in, utility_opt_out), only with consent.changed. null receives every change.",
);

/** Consent changes are chosen only for an endpoint that receives `consent.changed` (ADR-189). */
const invalidConsentChanges = () =>
  new AppError('validation_failed', WEBHOOK_CONSENT_CHANGES_NEED_THE_EVENT, {
    issues: [{ path: 'consentChanges', message: WEBHOOK_CONSENT_CHANGES_NEED_THE_EVENT }],
  });

const contactSourcesField = webhookContactSourcesSchema.describe(
  'Where the contacts whose contact.created the endpoint receives came from, as `contact.source` names it (whatsapp, manual, import, api, store), only with contact.created; contact.updated and contact.erased are not narrowed. Leave out `api` not to hear of the contacts your own keys add. null receives every contact.',
);

/** Where contacts came from is chosen only for an endpoint that receives `contact.created` (ADR-190). */
const invalidContactSources = () =>
  new AppError('validation_failed', WEBHOOK_CONTACT_SOURCES_NEED_THE_EVENT, {
    issues: [{ path: 'contactSources', message: WEBHOOK_CONTACT_SOURCES_NEED_THE_EVENT }],
  });

const messageTypesField = webhookMessageTypesSchema.describe(
  'The types of the received messages the endpoint receives as message.received, as `message.type` names them (text, image, video, audio, document, sticker, location, contacts, interactive, button, reaction, order, system, unsupported), only with message.received; applied with the numbers, teams and members chosen. null receives every type.',
);

/** Message types are chosen only for an endpoint that receives `message.received` (ADR-191). */
const invalidMessageTypes = () =>
  new AppError('validation_failed', WEBHOOK_MESSAGE_TYPES_NEED_THE_EVENT, {
    issues: [{ path: 'messageTypes', message: WEBHOOK_MESSAGE_TYPES_NEED_THE_EVENT }],
  });

const messageWordsField = webhookMessageWordsSchema.describe(
  "1 to 50 words or phrases, each up to 100 characters, trimmed and without control characters, kept once whatever their case; the endpoint receives a received message as message.received when its text, as `message.text` gives it (the text, a caption, a tapped reply's title, a reaction, or a location's name, else its address), contains one of them, whatever its case, and a message without text when the list is null. Only with message.received; applied with the endpoint's types, numbers, teams, members and tags. null receives every message.",
);

/** Words are chosen only for an endpoint that receives `message.received` (ADR-337). */
const invalidMessageWords = () =>
  new AppError('validation_failed', WEBHOOK_MESSAGE_WORDS_NEED_THE_EVENT, {
    issues: [{ path: 'messageWords', message: WEBHOOK_MESSAGE_WORDS_NEED_THE_EVENT }],
  });

const runEndReasonsField = webhookRunEndReasonsSchema.describe(
  'The reasons the runs the endpoint receives as automation.run_ended ended for, as `run.endReason` names them (completed: end_node, no_next; handed_off: handoff_node; taken_over: agent_replied, assigned, take_over, api_replied; stopped: stopped_by_member, conversation_resolved, opted_out, contact_erased, automation_archived, stopped_by_api; failed: budget_steps, budget_loop, budget_messages, budget_http, expired, send_blocked, send_failed, error), only with automation.run_ended and only reasons of the ends it receives. A run then counts only when its reason is listed, for an end the list names reasons of; the runs of its other ends are narrowed by the ends alone. null receives every reason.',
);

/** End reasons are chosen only for an endpoint that receives `automation.run_ended` (ADR-192). */
const invalidRunEndReasons = () =>
  new AppError('validation_failed', WEBHOOK_RUN_END_REASONS_NEED_THE_EVENT, {
    issues: [{ path: 'runEndReasons', message: WEBHOOK_RUN_END_REASONS_NEED_THE_EVENT }],
  });

const channelIdsField = webhookChannelIdsSchema.describe(
  `The WhatsApp numbers whose events the endpoint receives: 1 to ${WEBHOOK_LIMITS.channels} ids of the company's numbers (messages, conversations and orders give a number's id as \`channelId\`, templates in \`channels\` and webhook events as \`channel.id\`), only with an event that happens on a number: ${WEBHOOK_CHANNEL_EVENTS.slice(0, -1).join(', ')} or ${WEBHOOK_CHANNEL_EVENTS.at(-1)}. A campaign's events, and its skipped recipients' (campaign.recipient_skipped), are those of the number it sends from; a campaign without a number yet is on none. A Payment Link's are those of its order's number, a satisfaction survey's or a cash on delivery confirmation's answer that of its conversation, and a sent order message's (store_order.message_sent) or cart reminder's (store_checkout.reminder_sent) the number it went from. Consent, contact, template, skipped order message (store_order.message_skipped), skipped cart reminder (store_checkout.reminder_skipped), deal, task and note events belong to no number: an endpoint that names numbers still receives every one of them it takes. null receives the events of every number, including numbers connected later.`,
);

/** Numbers are chosen only for an endpoint that receives events of numbers (ADR-170). */
const invalidChannels = () =>
  new AppError('validation_failed', WEBHOOK_CHANNELS_NEED_THE_EVENTS, {
    issues: [{ path: 'channelIds', message: WEBHOOK_CHANNELS_NEED_THE_EVENTS }],
  });

const teamIdsField = webhookTeamIdsSchema.describe(
  `The teams whose conversations' events the endpoint receives: 1 to ${WEBHOOK_LIMITS.teams} ids of the company's teams, only with an event of a conversation: message.received, message.status, conversation.status_changed, conversation.assignment_changed or conversation.team_changed. A conversation's team is the one it is in when the event happens, so a conversation in no team is on no list; conversation.team_changed reaches the endpoints of the team the conversation left as well as of the team it joined. Other events are not narrowed. null receives every conversation's events, including those of teams added later.`,
);

/** Teams are chosen only for an endpoint that receives events of conversations (ADR-174). */
const invalidTeams = () =>
  new AppError('validation_failed', WEBHOOK_TEAMS_NEED_THE_EVENTS, {
    issues: [{ path: 'teamIds', message: WEBHOOK_TEAMS_NEED_THE_EVENTS }],
  });

const templateIdsField = webhookTemplateIdsSchema.describe(
  `The templates whose messages' statuses and changes the endpoint receives: 1 to ${WEBHOOK_LIMITS.templates} ids of the company's templates (as \`message.status\` and \`template.status_changed\` events name them), only with one of those two events. message.status is then sent only for messages sent with one of them, so a message sent without a template, such as a member's reply, is left out; template.status_changed only for their changes. Other events are not narrowed. null receives every template's, including templates added later.`,
);

/** Templates are chosen only for an endpoint that receives events of templates (ADR-175). */
const invalidTemplates = () =>
  new AppError('validation_failed', WEBHOOK_TEMPLATES_NEED_THE_EVENTS, {
    issues: [{ path: 'templateIds', message: WEBHOOK_TEMPLATES_NEED_THE_EVENTS }],
  });

const campaignIdsField = webhookCampaignIdsSchema.describe(
  `The campaigns whose messages' statuses, changes and skipped recipients the endpoint receives: 1 to ${WEBHOOK_LIMITS.campaigns} ids of the company's campaigns (as GET /campaigns lists them, and as \`message.status\`, \`campaign.status_changed\` and \`campaign.recipient_skipped\` events name them), only with one of those three events. message.status is then sent only for messages one of them sent, so a message no campaign sent, such as a member's reply, is left out; campaign.status_changed only for their changes, and campaign.recipient_skipped only for their recipients. Other events are not narrowed. null receives every campaign's, including campaigns added later.`,
);

/** Campaigns are chosen only for an endpoint that receives events of campaigns (ADR-185). */
const invalidCampaigns = () =>
  new AppError('validation_failed', WEBHOOK_CAMPAIGNS_NEED_THE_EVENTS, {
    issues: [{ path: 'campaignIds', message: WEBHOOK_CAMPAIGNS_NEED_THE_EVENTS }],
  });

const pipelineIdsField = webhookPipelineIdsSchema.describe(
  `The CRM pipelines whose deals' events the endpoint receives: 1 to ${WEBHOOK_LIMITS.pipelines} ids of the company's pipelines (as GET /pipelines lists them, archived ones included, and as deal events give them in \`deal.pipelineId\`), only with a deal event: deal.created, deal.updated, deal.stage_changed, deal.owner_changed or deal.status_changed. A deal's event belongs to the pipeline it gives, as the event's step left the deal; deal.stage_changed reaches the endpoints of the pipeline a move to another pipeline left (\`deal.previousPipelineId\`) as well as of the one it went to. Task and other events are not narrowed. null receives every pipeline's deal events, including those of pipelines added later.`,
);

/** Pipelines are chosen only for an endpoint that receives deal events (ADR-263). */
const invalidPipelines = () =>
  new AppError('validation_failed', WEBHOOK_PIPELINES_NEED_THE_EVENTS, {
    issues: [{ path: 'pipelineIds', message: WEBHOOK_PIPELINES_NEED_THE_EVENTS }],
  });

const stageIdsField = webhookStageIdsSchema.describe(
  `The CRM stages whose deals' events the endpoint receives: 1 to ${WEBHOOK_LIMITS.stages} ids of the company's stages, of any of its pipelines (as GET /pipelines lists them, removed ones included, and as deal events give them in \`deal.stageId\`), only with a deal event: deal.created, deal.updated, deal.stage_changed, deal.owner_changed or deal.status_changed. A deal's event belongs to the stage it gives, as the event's step left the deal; deal.stage_changed reaches the endpoints of the stage the deal left (\`deal.previousStageId\`) as well as of the one it went to. With pipelines (\`pipelineIds\`) or owners (\`ownerIds\`) too, an event must pass them all. Task and other events are not narrowed. null receives every stage's deal events, including those of stages added later.`,
);

/** Stages are chosen only for an endpoint that receives deal events (ADR-264). */
const invalidStages = () =>
  new AppError('validation_failed', WEBHOOK_STAGES_NEED_THE_EVENTS, {
    issues: [{ path: 'stageIds', message: WEBHOOK_STAGES_NEED_THE_EVENTS }],
  });

const ownerIdsField = webhookOwnerIdsSchema.describe(
  `The members whose deals' events the endpoint receives: 1 to ${WEBHOOK_LIMITS.owners} member ids (as GET /members lists them, and as deal events give them in \`deal.ownerId\`), only with a deal event: deal.created, deal.updated, deal.stage_changed, deal.owner_changed or deal.status_changed. A deal's event belongs to the member who owns the deal when the event happens (the payload gives the owner when it is delivered), so a deal without an owner is on no list; deal.owner_changed reaches the endpoints of the owner the deal left as well as of the one it was given to. A list may add only active members who can use the CRM; one who later leaves or loses access stays on the list. With pipelines or stages too, an event must pass them all. Task and other events are not narrowed. null receives every deal's events.`,
);

/** Deal owners are chosen only for an endpoint that receives deal events (ADR-265). */
const invalidOwners = () =>
  new AppError('validation_failed', WEBHOOK_OWNERS_NEED_THE_EVENTS, {
    issues: [{ path: 'ownerIds', message: WEBHOOK_OWNERS_NEED_THE_EVENTS }],
  });

const taskAssigneeIdsField = webhookTaskAssigneeIdsSchema.describe(
  `The members whose tasks' events the endpoint receives: 1 to ${WEBHOOK_LIMITS.taskAssignees} member ids (as GET /members lists them, and as task events give them in \`task.assigneeId\`), only with a task event: task.created, task.updated, task.assignee_changed or task.status_changed. A task's event belongs to the member it is assigned to when the event happens (the payload gives the assignee when it is delivered); task.assignee_changed reaches the endpoints of the member the task left as well as of the one it was given to. A list may add only active members who can use the CRM; one who later leaves or loses access stays on the list. Deal and other events are not narrowed. null receives every task's events.`,
);

/** Task assignees are chosen only for an endpoint that receives task events (ADR-266). */
const invalidTaskAssignees = () =>
  new AppError('validation_failed', WEBHOOK_TASK_ASSIGNEES_NEED_THE_EVENTS, {
    issues: [{ path: 'taskAssigneeIds', message: WEBHOOK_TASK_ASSIGNEES_NEED_THE_EVENTS }],
  });

const taskPipelineIdsField = webhookTaskPipelineIdsSchema.describe(
  `The CRM pipelines whose deals' tasks' events the endpoint receives: 1 to ${WEBHOOK_LIMITS.taskPipelines} of the company's pipeline ids (as GET /pipelines lists them, archived ones included), only with a task event: task.created, task.updated, task.assignee_changed or task.status_changed. A task's event belongs to the pipeline of the deal the task is about when the event happens (the payload gives the deal's id in \`task.dealId\`), so a task without a deal is on no list, and a task whose deal moves to another pipeline goes by the new one from then. With task assignees, or the stages or owners of tasks' deals too, an event must pass them all. Deal and other events are not narrowed; \`pipelineIds\` narrows deal events. null receives every task's events.`,
);

/** The pipelines of tasks' deals are chosen only for an endpoint that receives task events (ADR-303). */
const invalidTaskPipelines = () =>
  new AppError('validation_failed', WEBHOOK_TASK_PIPELINES_NEED_THE_EVENTS, {
    issues: [{ path: 'taskPipelineIds', message: WEBHOOK_TASK_PIPELINES_NEED_THE_EVENTS }],
  });

const taskStageIdsField = webhookTaskStageIdsSchema.describe(
  `The CRM stages whose deals' tasks' events the endpoint receives: 1 to ${WEBHOOK_LIMITS.taskStages} of the company's stage ids (as GET /pipelines lists them, removed ones included), only with a task event: task.created, task.updated, task.assignee_changed or task.status_changed. A task's event belongs to the stage of the deal the task is about when the event happens, so a task without a deal is on no list, and a task whose deal moves to another stage goes by the new one from then. With task assignees or the pipelines of tasks' deals too, an event must pass them all. Deal and other events are not narrowed; \`stageIds\` narrows deal events. null receives every task's events.`,
);

/** The stages of tasks' deals are chosen only for an endpoint that receives task events (ADR-304). */
const invalidTaskStages = () =>
  new AppError('validation_failed', WEBHOOK_TASK_STAGES_NEED_THE_EVENTS, {
    issues: [{ path: 'taskStageIds', message: WEBHOOK_TASK_STAGES_NEED_THE_EVENTS }],
  });

const taskDealOwnerIdsField = webhookTaskDealOwnerIdsSchema.describe(
  `The members whose deals' tasks' events the endpoint receives: 1 to ${WEBHOOK_LIMITS.taskDealOwners} member ids (as GET /members lists them, and as deal events give them in \`deal.ownerId\`), only with a task event: task.created, task.updated, task.assignee_changed or task.status_changed. A task's event belongs to the member who owns the deal the task is about when the event happens, so a task without a deal, or of a deal without an owner, is on no list, and a task whose deal is given to another member goes by the new owner from then. A list may add only active members who can use the CRM; one who later leaves or loses access stays on the list. With task assignees, or the pipelines or stages of tasks' deals too, an event must pass them all. Deal and other events are not narrowed; \`ownerIds\` narrows deal events. null receives every task's events.`,
);

/** The owners of tasks' deals are chosen only for an endpoint that receives task events (ADR-304). */
const invalidTaskDealOwners = () =>
  new AppError('validation_failed', WEBHOOK_TASK_DEAL_OWNERS_NEED_THE_EVENTS, {
    issues: [{ path: 'taskDealOwnerIds', message: WEBHOOK_TASK_DEAL_OWNERS_NEED_THE_EVENTS }],
  });

const notePipelineIdsField = webhookNotePipelineIdsSchema.describe(
  `The CRM pipelines whose deals' notes' events the endpoint receives: 1 to ${WEBHOOK_LIMITS.notePipelines} of the company's pipeline ids (as GET /pipelines lists them, archived ones included), only with note.created. A note's event belongs to the pipeline of the deal the note is about when the note is added (the payload gives the deal's id in \`note.dealId\`), so a note about a contact alone is on no list. With the stages or owners of notes' deals too, an event must pass them all. Deal, task and other events are not narrowed; \`pipelineIds\` narrows deal events and \`taskPipelineIds\` task events. null receives every note's events.`,
);

/** The pipelines of notes' deals are chosen only for an endpoint that receives notes (ADR-305). */
const invalidNotePipelines = () =>
  new AppError('validation_failed', WEBHOOK_NOTE_PIPELINES_NEED_THE_EVENTS, {
    issues: [{ path: 'notePipelineIds', message: WEBHOOK_NOTE_PIPELINES_NEED_THE_EVENTS }],
  });

const noteStageIdsField = webhookNoteStageIdsSchema.describe(
  `The CRM stages whose deals' notes' events the endpoint receives: 1 to ${WEBHOOK_LIMITS.noteStages} of the company's stage ids (as GET /pipelines lists them, removed ones included), only with note.created. A note's event belongs to the stage of the deal the note is about when the note is added, so a note about a contact alone is on no list. With the pipelines or owners of notes' deals too, an event must pass them all. Deal, task and other events are not narrowed; \`stageIds\` narrows deal events and \`taskStageIds\` task events. null receives every note's events.`,
);

/** The stages of notes' deals are chosen only for an endpoint that receives notes (ADR-305). */
const invalidNoteStages = () =>
  new AppError('validation_failed', WEBHOOK_NOTE_STAGES_NEED_THE_EVENTS, {
    issues: [{ path: 'noteStageIds', message: WEBHOOK_NOTE_STAGES_NEED_THE_EVENTS }],
  });

const noteDealOwnerIdsField = webhookNoteDealOwnerIdsSchema.describe(
  `The members whose deals' notes' events the endpoint receives: 1 to ${WEBHOOK_LIMITS.noteDealOwners} member ids (as GET /members lists them, and as deal events give them in \`deal.ownerId\`), only with note.created. A note's event belongs to the member who owns the deal the note is about when the note is added, so a note about a contact alone, or of a deal without an owner, is on no list. A list may add only active members who can use the CRM; one who later leaves or loses access stays on the list. With the pipelines or stages of notes' deals too, an event must pass them all. Deal, task and other events are not narrowed; \`ownerIds\` narrows deal events and \`taskDealOwnerIds\` task events. null receives every note's events.`,
);

/** The owners of notes' deals are chosen only for an endpoint that receives notes (ADR-305). */
const invalidNoteDealOwners = () =>
  new AppError('validation_failed', WEBHOOK_NOTE_DEAL_OWNERS_NEED_THE_EVENTS, {
    issues: [{ path: 'noteDealOwnerIds', message: WEBHOOK_NOTE_DEAL_OWNERS_NEED_THE_EVENTS }],
  });

const crmChangeMakersField = webhookCrmChangeMakersSchema.describe(
  `Who made the changes whose deal, task and note events the endpoint receives: one or more of ${WEBHOOK_CRM_CHANGE_MAKERS.map((m) => `\`${m}\``).join(', ')}, as the events name them (\`deal.changedBy\`, \`task.changedBy\`, \`note.writtenBy\`), only with a deal, task or note event. An addition belongs to whoever added the deal or task, a note to whoever wrote it, and any other change to the maker HyFib recorded with it; a change HyFib did not record the maker of (\`changedBy\` null, such as erasure retitling a deal) is sent whoever is chosen. With pipelines, stages, owners or assignees chosen too, an event must pass them all. Other events are not narrowed. null receives every change.`,
);

/** Who made the changes is chosen only for an endpoint that receives CRM events (ADR-306). */
const invalidCrmChangeMakers = () =>
  new AppError('validation_failed', WEBHOOK_CRM_CHANGE_MAKERS_NEED_THE_EVENTS, {
    issues: [{ path: 'crmChangeMakers', message: WEBHOOK_CRM_CHANGE_MAKERS_NEED_THE_EVENTS }],
  });

const crmExcludedApiKeyIdsField = webhookCrmExcludedApiKeyIdsSchema.describe(
  `The API keys whose deal, task and note changes the endpoint does not receive: 1 to ${WEBHOOK_LIMITS.crmExcludedApiKeys} ids of the company's keys that can change them (deals.write, tasks.write or notes.write), as \`apiKeyId\` names the key that made a change in deal, task and note events (a key that adds an endpoint finds its own id in the endpoint's apiKeyId), only with a deal, task or note event. An event is left out when the key that made its change is listed, or a key it was rotated from or into, so an integration that writes through the API and takes the events is not sent back what it wrote, across rotations, while it is sent the changes of members, automations and other keys. A change HyFib did not record the maker of is never left out. With who made the changes or other lists too, an event must pass them all. Other events are not narrowed. null leaves nothing out.`,
);

/** Keys are left out only for an endpoint that receives CRM events (ADR-321). */
const invalidCrmExcludedApiKeys = () =>
  new AppError('validation_failed', WEBHOOK_CRM_EXCLUDED_API_KEYS_NEED_THE_EVENTS, {
    issues: [
      { path: 'crmExcludedApiKeyIds', message: WEBHOOK_CRM_EXCLUDED_API_KEYS_NEED_THE_EVENTS },
    ],
  });

const surveyScoresField = webhookSurveyScoresSchema.describe(
  `The scores of the satisfaction survey answers the endpoint receives: one or more of ${WEBHOOK_SURVEY_SCORES.join(', ')}, as the survey's \`score\` gives them (3 for the first and best button, 2 for the second, 1 for the third, whatever the company's buttons say), only with satisfaction_survey.answered. Other events are not narrowed. null receives every answer.`,
);

/** Scores are chosen only for an endpoint that receives satisfaction survey answers (ADR-307). */
const invalidSurveyScores = () =>
  new AppError('validation_failed', WEBHOOK_SURVEY_SCORES_NEED_THE_EVENT, {
    issues: [{ path: 'surveyScores', message: WEBHOOK_SURVEY_SCORES_NEED_THE_EVENT }],
  });

const surveyAssigneeIdsField = webhookSurveyAssigneeIdsSchema.describe(
  `The members credited with the satisfaction survey answers the endpoint receives: 1 to ${WEBHOOK_LIMITS.surveyAssignees} member ids (as GET /members lists them: active members who take conversations), only with satisfaction_survey.answered. An answer is credited to the member its conversation was assigned to when it was resolved, as the survey's assigneeId names them, so an answer of a conversation resolved unassigned is on no list. A member who later stops taking conversations stays on the list, and the answers still credited to them match. With scores, teams or tags too, an answer must pass them all. Other events are not narrowed. null receives every answer.`,
);

/** Members credited with answers are chosen only for an endpoint that receives them (ADR-311). */
const invalidSurveyAssignees = () =>
  new AppError('validation_failed', WEBHOOK_SURVEY_ASSIGNEES_NEED_THE_EVENT, {
    issues: [{ path: 'surveyAssigneeIds', message: WEBHOOK_SURVEY_ASSIGNEES_NEED_THE_EVENT }],
  });

const surveyTeamIdsField = webhookSurveyTeamIdsSchema.describe(
  `The teams whose conversations' satisfaction survey answers the endpoint receives: 1 to ${WEBHOOK_LIMITS.surveyTeams} ids of the company's teams, only with satisfaction_survey.answered. An answer belongs to the team its conversation is in when the customer answers, so an answer of a conversation in no team is on no list; a team deleted since it was chosen stays on the list and matches nothing. With scores, members or tags too, an answer must pass them all. Other events are not narrowed. null receives every answer.`,
);

/** Teams of answered surveys are chosen only for an endpoint that receives answers (ADR-311). */
const invalidSurveyTeams = () =>
  new AppError('validation_failed', WEBHOOK_SURVEY_TEAMS_NEED_THE_EVENT, {
    issues: [{ path: 'surveyTeamIds', message: WEBHOOK_SURVEY_TEAMS_NEED_THE_EVENT }],
  });

const surveyContactTagsField = webhookSurveyContactTagsSchema.describe(
  `The contact tags whose satisfaction survey answers the endpoint receives: 1 to ${WEBHOOK_LIMITS.surveyContactTags} tags as contacts carry them (as GET /contacts gives them: compared as tags are written, in lower case with single spaces, each up to 40 characters without commas), only with satisfaction_survey.answered. An answer counts when the answering contact has any of the tags when they answer, so a contact without them is on no list. A tag no contact has yet may be named; it matches nothing until a contact has it. With scores, members, teams or conversation tags too, an answer must pass them all. Other events are not narrowed. null receives every answer.`,
);

/** Contact tags of answered surveys are chosen only for an endpoint receiving answers (ADR-312). */
const invalidSurveyContactTags = () =>
  new AppError('validation_failed', WEBHOOK_SURVEY_CONTACT_TAGS_NEED_THE_EVENT, {
    issues: [{ path: 'surveyContactTags', message: WEBHOOK_SURVEY_CONTACT_TAGS_NEED_THE_EVENT }],
  });

const surveyConversationTagsField = webhookSurveyConversationTagsSchema.describe(
  `The conversation tags whose satisfaction survey answers the endpoint receives: 1 to ${WEBHOOK_LIMITS.surveyConversationTags} tags as conversations carry them (as GET /conversations and GET /conversation-tags give them: compared as tags are written, in lower case with single spaces, each up to 40 characters without commas), only with satisfaction_survey.answered. An answer counts when its conversation has any of the tags when the customer answers, so a conversation without them is on no list. A tag no conversation has yet may be named; it matches nothing until a conversation has it. With scores, members, teams or contact tags too, an answer must pass them all. Other events are not narrowed. null receives every answer.`,
);

/** Conversation tags of answered surveys likewise (ADR-312). */
const invalidSurveyConversationTags = () =>
  new AppError('validation_failed', WEBHOOK_SURVEY_CONVERSATION_TAGS_NEED_THE_EVENT, {
    issues: [
      {
        path: 'surveyConversationTags',
        message: WEBHOOK_SURVEY_CONVERSATION_TAGS_NEED_THE_EVENT,
      },
    ],
  });

const contactEventTagsField = webhookContactEventTagsSchema.describe(
  `The contact tags whose contact.created and contact.updated the endpoint receives: 1 to ${WEBHOOK_LIMITS.contactEventTags} tags as contacts carry them (as GET /contacts gives them: compared as tags are written, in lower case with single spaces, each up to 40 characters without commas), only with contact.created or contact.updated. A change is sent when the contact has any of the tags when it is saved, or when it adds or removes one of them. A contact is added without tags, so its contact.created is sent when the change that adds it tags it with one of them; one tagged later is sent as contact.updated. A tag no contact has yet may be named; it matches nothing until a contact has it. With where contacts came from, the contact parts or the custom fields too, an event must pass them all. Other events, contact.erased and contact.merged among them, are not narrowed. null receives every contact.`,
);

/** Tags of added and changed contacts are chosen only for an endpoint receiving them (ADR-316). */
const invalidContactEventTags = () =>
  new AppError('validation_failed', WEBHOOK_CONTACT_EVENT_TAGS_NEED_THE_EVENTS, {
    issues: [{ path: 'contactEventTags', message: WEBHOOK_CONTACT_EVENT_TAGS_NEED_THE_EVENTS }],
  });

const contactEventFieldValuesField = webhookContactEventFieldValuesSchema.describe(
  `The custom field conditions whose contact.created and contact.updated the endpoint receives: 1 to ${WEBHOOK_LIMITS.contactEventFieldValues} of a field's key (GET /contact-fields) with one of: \`value\`, a value of the field's type, as contacts take them (text of up to 500 characters, a number, a date as YYYY-MM-DD, or true or false for yes/no); \`contains\`, for a text field, a word or phrase of up to 500 characters its value contains, whatever its case; or \`atLeast\`, \`atMost\` or both, for a number or date field, the ends of a range of its numbers or dates, each included, the start not after the end. Each condition once, up to ${WEBHOOK_LIMITS.contactEventFieldValuesBytes.toLocaleString('en')} bytes as JSON in all, only with contact.created or contact.updated. A change is sent when the contact passes one of them (equal text compared whatever its case, numbers as numbers) once the change is saved, or when it changes one of the fields, so the change that takes a contact out of the values is sent too; a change between two values not named is sent as well, as the event does not say what a field was before. A contact added and given one of the values in the same change is sent as contact.created. A condition given now must be of one of the company's fields; one the endpoint holds stays when its field is deleted, matching nothing until a field with its key is added again (keys never change), whose changes are then sent and whose values are matched as they are kept. With where contacts came from, the contact parts, the custom fields or the tags too, an event must pass them all. Other events, contact.erased and contact.merged among them, are not narrowed. null receives every contact.`,
);

/** Field values of added and changed contacts are chosen only for an endpoint receiving them (ADR-332). */
const invalidContactEventFieldValues = () =>
  new AppError('validation_failed', WEBHOOK_CONTACT_EVENT_FIELD_VALUES_NEED_THE_EVENTS, {
    issues: [
      {
        path: 'contactEventFieldValues',
        message: WEBHOOK_CONTACT_EVENT_FIELD_VALUES_NEED_THE_EVENTS,
      },
    ],
  });

const assigneeIdsField = webhookAssigneeIdsSchema.describe(
  `The members whose assigned conversations' events the endpoint receives: 1 to ${WEBHOOK_LIMITS.assignees} member ids (as GET /members lists them: active members who take conversations), only with an event of a conversation: message.received, message.status, conversation.status_changed, conversation.assignment_changed or conversation.team_changed. A conversation's member is the one it is assigned to when the event happens, so an unassigned conversation is on no list; conversation.assignment_changed reaches the endpoints of the member the conversation left as well as of the member it went to. A member who later stops taking conversations stays on the list: their conversations are released then. Other events are not narrowed. null receives every conversation's events.`,
);

/** Members are chosen only for an endpoint that receives events of conversations (ADR-181). */
const invalidAssignees = () =>
  new AppError('validation_failed', WEBHOOK_ASSIGNEES_NEED_THE_EVENTS, {
    issues: [{ path: 'assigneeIds', message: WEBHOOK_ASSIGNEES_NEED_THE_EVENTS }],
  });

const contactTagsField = webhookContactTagsSchema.describe(
  `The contact tags whose conversations' events the endpoint receives: 1 to ${WEBHOOK_LIMITS.contactTags} tags as contacts carry them (as GET /contacts gives them: compared in lower case and trimmed, each up to 40 characters without commas), only with an event of a conversation: message.received, message.status, conversation.status_changed, conversation.assignment_changed or conversation.team_changed. Such an event belongs to the conversation's contact, and counts when the contact has any of the tags when the event happens: a tag added later counts from the next event on, and a removed one no longer does. A tag no contact has yet may be named; it matches nothing until a contact has it. With numbers, teams or members too, an event must pass them all. Other events are not narrowed. null receives every conversation's events.`,
);

/** Contact tags are chosen only for an endpoint that receives events of conversations (ADR-267). */
const invalidContactTags = () =>
  new AppError('validation_failed', WEBHOOK_CONTACT_TAGS_NEED_THE_EVENTS, {
    issues: [{ path: 'contactTags', message: WEBHOOK_CONTACT_TAGS_NEED_THE_EVENTS }],
  });

const conversationTagsField = webhookConversationTagsSchema.describe(
  `The conversation tags whose events the endpoint receives: 1 to ${WEBHOOK_LIMITS.conversationTags} tags as conversations carry them (as GET /conversations and GET /conversation-tags give them: compared as tags are written, in lower case with single spaces, each up to 40 characters without commas), only with an event of a conversation: message.received, message.status, conversation.status_changed, conversation.assignment_changed or conversation.team_changed. Such an event counts when its conversation has any of the tags when the event happens: a tag added later counts from the next event on, and a removed one no longer does. A tag no conversation has yet may be named; it matches nothing until a conversation has it. With numbers, teams, members or contact tags too, an event must pass them all. Other events are not narrowed. null receives every conversation's events.`,
);

/** Conversation tags are chosen only for an endpoint that receives events of conversations (ADR-273). */
const invalidConversationTags = () =>
  new AppError('validation_failed', WEBHOOK_CONVERSATION_TAGS_NEED_THE_EVENTS, {
    issues: [{ path: 'conversationTags', message: WEBHOOK_CONVERSATION_TAGS_NEED_THE_EVENTS }],
  });

const oauthField = webhookOAuthSchema.describe(
  `An OAuth 2.0 client of the receiver's authorization server (the client credentials grant): before delivering, HyFib asks the token URL (an https address on the public internet, held to the endpoint URL's rules) for an access token, authenticating with the client ID and secret (in an HTTP Basic header, or as \`client_id\` and \`client_secret\` in the request body when \`clientAuthentication\` is \`client_secret_post\`; left out, a change keeps the client's while the token URL stays the same, and a new client or token URL uses \`client_secret_basic\`) and asking for the scope if one is given, and sends the token as \`Authorization: Bearer <token>\`. A token is used until a minute before it expires, for at most a day; one without a lifetime of more than two minutes serves only the deliveries sent with it, and one the endpoint answers 401 to is replaced at the next attempt. A delivery that gets no token fails its attempt (\`lastError\` \`oauth_token_…\`) and is retried. The client ID and secret use printable ASCII characters (up to ${WEBHOOK_LIMITS.oauthClientIdLength} and ${WEBHOOK_LIMITS.oauthClientSecretLength}); the secret is stored encrypted and never shown again. An endpoint with an OAuth client cannot send an Authorization header of its own.`,
);

export const apiCreateWebhookEndpointSchema = z
  .object({
    url: z
      .string({ error: 'Give the endpoint URL' })
      .trim()
      .min(1, 'Give the endpoint URL')
      .max(WEBHOOK_LIMITS.urlLength, 'The URL is too long')
      .describe(
        'Where HyFib sends the events: an https address on the public internet (no credentials, standard ports).',
      ),
    events: webhookEventTypesSchema.describe('The events the endpoint receives.'),
    description: descriptionField.optional().describe('A note for members, up to 200 characters.'),
    headers: headersField.optional(),
    messageStatuses: messageStatusesField.optional(),
    messageSenders: messageSendersField.optional(),
    messageApiKeyIds: messageApiKeyIdsField.optional(),
    contactParts: contactPartsField.optional(),
    contactFieldKeys: contactFieldKeysField.optional(),
    automationIds: automationIdsField.optional(),
    campaignStatuses: campaignStatusesField.optional(),
    orderStatuses: orderStatusesField.optional(),
    paymentLinkStatuses: paymentLinkStatusesField.optional(),
    codAnswers: codAnswersField.optional(),
    storeIds: storeIdsField.optional(),
    orderMessageEvents: orderMessageEventsField.optional(),
    orderMessageSkipReasons: orderMessageSkipReasonsField.optional(),
    cartReminders: cartRemindersField.optional(),
    cartReminderSkipReasons: cartReminderSkipReasonsField.optional(),
    campaignSkipReasons: campaignSkipReasonsField.optional(),
    runStepOutcomes: runStepOutcomesField.optional(),
    runStepNodeTypes: runStepNodeTypesField.optional(),
    orderChangeMakers: orderChangeMakersField.optional(),
    orderExcludedApiKeyIds: orderExcludedApiKeyIdsField.optional(),
    paymentLinkApiKeyIds: paymentLinkApiKeyIdsField.optional(),
    dealStatuses: dealStatusesField.optional(),
    taskStatuses: taskStatusesField.optional(),
    dealDetails: dealDetailsField.optional(),
    taskDetails: taskDetailsField.optional(),
    templateStatuses: templateStatusesField.optional(),
    conversationStatuses: conversationStatusesField.optional(),
    runEndStatuses: runEndStatusesField.optional(),
    runTriggers: runTriggersField.optional(),
    runApiKeyIds: runApiKeyIdsField.optional(),
    consentChanges: consentChangesField.optional(),
    contactSources: contactSourcesField.optional(),
    messageTypes: messageTypesField.optional(),
    messageWords: messageWordsField.optional(),
    runEndReasons: runEndReasonsField.optional(),
    channelIds: channelIdsField.optional(),
    teamIds: teamIdsField.optional(),
    templateIds: templateIdsField.optional(),
    campaignIds: campaignIdsField.optional(),
    pipelineIds: pipelineIdsField.optional(),
    stageIds: stageIdsField.optional(),
    ownerIds: ownerIdsField.optional(),
    taskAssigneeIds: taskAssigneeIdsField.optional(),
    taskPipelineIds: taskPipelineIdsField.optional(),
    taskStageIds: taskStageIdsField.optional(),
    taskDealOwnerIds: taskDealOwnerIdsField.optional(),
    notePipelineIds: notePipelineIdsField.optional(),
    noteStageIds: noteStageIdsField.optional(),
    noteDealOwnerIds: noteDealOwnerIdsField.optional(),
    crmChangeMakers: crmChangeMakersField.optional(),
    crmExcludedApiKeyIds: crmExcludedApiKeyIdsField.optional(),
    surveyScores: surveyScoresField.optional(),
    surveyAssigneeIds: surveyAssigneeIdsField.optional(),
    surveyTeamIds: surveyTeamIdsField.optional(),
    surveyContactTags: surveyContactTagsField.optional(),
    surveyConversationTags: surveyConversationTagsField.optional(),
    contactEventTags: contactEventTagsField.optional(),
    contactEventFieldValues: contactEventFieldValuesField.optional(),
    assigneeIds: assigneeIdsField.optional(),
    contactTags: contactTagsField.optional(),
    conversationTags: conversationTagsField.optional(),
    oauth: oauthField.nullable().optional(),
  })
  .strict()
  .refine((data) => !data.messageStatuses || data.events.includes('message.status'), {
    path: ['messageStatuses'],
    message: WEBHOOK_STATUSES_NEED_THE_EVENT,
  })
  .refine((data) => !data.messageSenders || data.events.includes('message.status'), {
    path: ['messageSenders'],
    message: WEBHOOK_SENDERS_NEED_THE_EVENT,
  })
  .refine((data) => !data.messageApiKeyIds || data.events.includes('message.status'), {
    path: ['messageApiKeyIds'],
    message: WEBHOOK_MESSAGE_API_KEYS_NEED_THE_EVENT,
  })
  .refine((data) => !data.contactParts || data.events.includes('contact.updated'), {
    path: ['contactParts'],
    message: WEBHOOK_PARTS_NEED_THE_EVENT,
  })
  .refine(
    (data) =>
      !data.contactFieldKeys || webhookTakesFieldChanges(data.events, data.contactParts ?? null),
    { path: ['contactFieldKeys'], message: WEBHOOK_FIELDS_NEED_THE_PART },
  )
  .refine((data) => !data.automationIds || webhookTakesAutomationRuns(data.events), {
    path: ['automationIds'],
    message: WEBHOOK_AUTOMATIONS_NEED_THE_EVENTS,
  })
  .refine((data) => !data.campaignStatuses || data.events.includes('campaign.status_changed'), {
    path: ['campaignStatuses'],
    message: WEBHOOK_CAMPAIGN_STATUSES_NEED_THE_EVENT,
  })
  .refine((data) => !data.orderStatuses || data.events.includes('order.status_changed'), {
    path: ['orderStatuses'],
    message: WEBHOOK_ORDER_STATUSES_NEED_THE_EVENT,
  })
  .refine(
    (data) => !data.paymentLinkStatuses || data.events.includes('payment_link.status_changed'),
    { path: ['paymentLinkStatuses'], message: WEBHOOK_PAYMENT_LINK_STATUSES_NEED_THE_EVENT },
  )
  .refine((data) => !data.runStepOutcomes || data.events.includes('automation.run_step'), {
    path: ['runStepOutcomes'],
    message: WEBHOOK_RUN_STEP_OUTCOMES_NEED_THE_EVENT,
  })
  .refine((data) => !data.codAnswers || data.events.includes('store_order.cod_answered'), {
    path: ['codAnswers'],
    message: WEBHOOK_COD_ANSWERS_NEED_THE_EVENT,
  })
  .refine((data) => !data.storeIds || webhookTakesStoreEvents(data.events), {
    path: ['storeIds'],
    message: WEBHOOK_STORES_NEED_THE_EVENT,
  })
  .refine((data) => !data.orderMessageEvents || webhookTakesOrderMessages(data.events), {
    path: ['orderMessageEvents'],
    message: WEBHOOK_ORDER_MESSAGES_NEED_THE_EVENT,
  })
  .refine(
    (data) => !data.orderMessageSkipReasons || data.events.includes('store_order.message_skipped'),
    {
      path: ['orderMessageSkipReasons'],
      message: WEBHOOK_ORDER_MESSAGE_SKIP_REASONS_NEED_THE_EVENT,
    },
  )
  .refine((data) => !data.cartReminders || webhookTakesCartReminders(data.events), {
    path: ['cartReminders'],
    message: WEBHOOK_CART_REMINDERS_NEED_THE_EVENT,
  })
  .refine(
    (data) =>
      !data.cartReminderSkipReasons || data.events.includes('store_checkout.reminder_skipped'),
    {
      path: ['cartReminderSkipReasons'],
      message: WEBHOOK_CART_REMINDER_SKIP_REASONS_NEED_THE_EVENT,
    },
  )
  .refine(
    (data) => !data.campaignSkipReasons || data.events.includes('campaign.recipient_skipped'),
    {
      path: ['campaignSkipReasons'],
      message: WEBHOOK_CAMPAIGN_SKIP_REASONS_NEED_THE_EVENT,
    },
  )
  .refine((data) => !data.runStepNodeTypes || data.events.includes('automation.run_step'), {
    path: ['runStepNodeTypes'],
    message: WEBHOOK_RUN_STEP_NODE_TYPES_NEED_THE_EVENT,
  })
  .refine((data) => !data.orderChangeMakers || data.events.includes('order.status_changed'), {
    path: ['orderChangeMakers'],
    message: WEBHOOK_ORDER_CHANGE_MAKERS_NEED_THE_EVENT,
  })
  .refine((data) => !data.orderExcludedApiKeyIds || data.events.includes('order.status_changed'), {
    path: ['orderExcludedApiKeyIds'],
    message: WEBHOOK_ORDER_EXCLUDED_API_KEYS_NEED_THE_EVENT,
  })
  .refine(
    (data) => !data.paymentLinkApiKeyIds || data.events.includes('payment_link.status_changed'),
    { path: ['paymentLinkApiKeyIds'], message: WEBHOOK_PAYMENT_LINK_API_KEYS_NEED_THE_EVENT },
  )
  .refine((data) => !data.dealStatuses || data.events.includes('deal.status_changed'), {
    path: ['dealStatuses'],
    message: WEBHOOK_DEAL_STATUSES_NEED_THE_EVENT,
  })
  .refine((data) => !data.taskStatuses || data.events.includes('task.status_changed'), {
    path: ['taskStatuses'],
    message: WEBHOOK_TASK_STATUSES_NEED_THE_EVENT,
  })
  .refine((data) => !data.dealDetails || data.events.includes('deal.updated'), {
    path: ['dealDetails'],
    message: WEBHOOK_DEAL_DETAILS_NEED_THE_EVENT,
  })
  .refine((data) => !data.taskDetails || data.events.includes('task.updated'), {
    path: ['taskDetails'],
    message: WEBHOOK_TASK_DETAILS_NEED_THE_EVENT,
  })
  .refine((data) => !data.templateStatuses || data.events.includes('template.status_changed'), {
    path: ['templateStatuses'],
    message: WEBHOOK_TEMPLATE_STATUSES_NEED_THE_EVENT,
  })
  .refine(
    (data) => !data.conversationStatuses || data.events.includes('conversation.status_changed'),
    { path: ['conversationStatuses'], message: WEBHOOK_CONVERSATION_STATUSES_NEED_THE_EVENT },
  )
  .refine((data) => !data.runEndStatuses || data.events.includes('automation.run_ended'), {
    path: ['runEndStatuses'],
    message: WEBHOOK_RUN_END_STATUSES_NEED_THE_EVENT,
  })
  .refine((data) => !data.runTriggers || webhookTakesAutomationRuns(data.events), {
    path: ['runTriggers'],
    message: WEBHOOK_RUN_TRIGGERS_NEED_THE_EVENTS,
  })
  .refine((data) => !data.runApiKeyIds || webhookTakesAutomationRuns(data.events), {
    path: ['runApiKeyIds'],
    message: WEBHOOK_RUN_API_KEYS_NEED_THE_EVENTS,
  })
  .refine((data) => !data.consentChanges || data.events.includes('consent.changed'), {
    path: ['consentChanges'],
    message: WEBHOOK_CONSENT_CHANGES_NEED_THE_EVENT,
  })
  .refine((data) => !data.contactSources || data.events.includes('contact.created'), {
    path: ['contactSources'],
    message: WEBHOOK_CONTACT_SOURCES_NEED_THE_EVENT,
  })
  .refine((data) => !data.messageTypes || data.events.includes('message.received'), {
    path: ['messageTypes'],
    message: WEBHOOK_MESSAGE_TYPES_NEED_THE_EVENT,
  })
  .refine((data) => !data.messageWords || data.events.includes('message.received'), {
    path: ['messageWords'],
    message: WEBHOOK_MESSAGE_WORDS_NEED_THE_EVENT,
  })
  .refine((data) => !data.runEndReasons || data.events.includes('automation.run_ended'), {
    path: ['runEndReasons'],
    message: WEBHOOK_RUN_END_REASONS_NEED_THE_EVENT,
  })
  .refine(
    (data) =>
      !data.runEndReasons ||
      data.runEndReasons.every((reason) =>
        webhookRunEndTakesReason(data.runEndStatuses ?? null, reason),
      ),
    { path: ['runEndReasons'], message: WEBHOOK_RUN_END_REASONS_NEED_THE_ENDS },
  )
  .refine((data) => !data.channelIds || webhookTakesChannelEvents(data.events), {
    path: ['channelIds'],
    message: WEBHOOK_CHANNELS_NEED_THE_EVENTS,
  })
  .refine((data) => !data.teamIds || webhookTakesTeamEvents(data.events), {
    path: ['teamIds'],
    message: WEBHOOK_TEAMS_NEED_THE_EVENTS,
  })
  .refine((data) => !data.templateIds || webhookTakesTemplateEvents(data.events), {
    path: ['templateIds'],
    message: WEBHOOK_TEMPLATES_NEED_THE_EVENTS,
  })
  .refine((data) => !data.campaignIds || webhookTakesCampaignEvents(data.events), {
    path: ['campaignIds'],
    message: WEBHOOK_CAMPAIGNS_NEED_THE_EVENTS,
  })
  .refine((data) => !data.pipelineIds || webhookTakesPipelineEvents(data.events), {
    path: ['pipelineIds'],
    message: WEBHOOK_PIPELINES_NEED_THE_EVENTS,
  })
  .refine((data) => !data.stageIds || webhookTakesPipelineEvents(data.events), {
    path: ['stageIds'],
    message: WEBHOOK_STAGES_NEED_THE_EVENTS,
  })
  .refine((data) => !data.ownerIds || webhookTakesPipelineEvents(data.events), {
    path: ['ownerIds'],
    message: WEBHOOK_OWNERS_NEED_THE_EVENTS,
  })
  .refine((data) => !data.taskAssigneeIds || webhookTakesTaskEvents(data.events), {
    path: ['taskAssigneeIds'],
    message: WEBHOOK_TASK_ASSIGNEES_NEED_THE_EVENTS,
  })
  .refine((data) => !data.taskPipelineIds || webhookTakesTaskEvents(data.events), {
    path: ['taskPipelineIds'],
    message: WEBHOOK_TASK_PIPELINES_NEED_THE_EVENTS,
  })
  .refine((data) => !data.taskStageIds || webhookTakesTaskEvents(data.events), {
    path: ['taskStageIds'],
    message: WEBHOOK_TASK_STAGES_NEED_THE_EVENTS,
  })
  .refine((data) => !data.taskDealOwnerIds || webhookTakesTaskEvents(data.events), {
    path: ['taskDealOwnerIds'],
    message: WEBHOOK_TASK_DEAL_OWNERS_NEED_THE_EVENTS,
  })
  .refine((data) => !data.notePipelineIds || webhookTakesNoteEvents(data.events), {
    path: ['notePipelineIds'],
    message: WEBHOOK_NOTE_PIPELINES_NEED_THE_EVENTS,
  })
  .refine((data) => !data.noteStageIds || webhookTakesNoteEvents(data.events), {
    path: ['noteStageIds'],
    message: WEBHOOK_NOTE_STAGES_NEED_THE_EVENTS,
  })
  .refine((data) => !data.noteDealOwnerIds || webhookTakesNoteEvents(data.events), {
    path: ['noteDealOwnerIds'],
    message: WEBHOOK_NOTE_DEAL_OWNERS_NEED_THE_EVENTS,
  })
  .refine((data) => !data.crmChangeMakers || webhookTakesCrmChanges(data.events), {
    path: ['crmChangeMakers'],
    message: WEBHOOK_CRM_CHANGE_MAKERS_NEED_THE_EVENTS,
  })
  .refine((data) => !data.crmExcludedApiKeyIds || webhookTakesCrmChanges(data.events), {
    path: ['crmExcludedApiKeyIds'],
    message: WEBHOOK_CRM_EXCLUDED_API_KEYS_NEED_THE_EVENTS,
  })
  .refine((data) => !data.surveyScores || data.events.includes('satisfaction_survey.answered'), {
    path: ['surveyScores'],
    message: WEBHOOK_SURVEY_SCORES_NEED_THE_EVENT,
  })
  .refine(
    (data) => !data.surveyAssigneeIds || data.events.includes('satisfaction_survey.answered'),
    { path: ['surveyAssigneeIds'], message: WEBHOOK_SURVEY_ASSIGNEES_NEED_THE_EVENT },
  )
  .refine((data) => !data.surveyTeamIds || data.events.includes('satisfaction_survey.answered'), {
    path: ['surveyTeamIds'],
    message: WEBHOOK_SURVEY_TEAMS_NEED_THE_EVENT,
  })
  .refine(
    (data) => !data.surveyContactTags || data.events.includes('satisfaction_survey.answered'),
    { path: ['surveyContactTags'], message: WEBHOOK_SURVEY_CONTACT_TAGS_NEED_THE_EVENT },
  )
  .refine(
    (data) => !data.surveyConversationTags || data.events.includes('satisfaction_survey.answered'),
    { path: ['surveyConversationTags'], message: WEBHOOK_SURVEY_CONVERSATION_TAGS_NEED_THE_EVENT },
  )
  .refine(
    (data) =>
      !data.contactEventTags ||
      data.events.includes('contact.created') ||
      data.events.includes('contact.updated'),
    { path: ['contactEventTags'], message: WEBHOOK_CONTACT_EVENT_TAGS_NEED_THE_EVENTS },
  )
  .refine(
    (data) =>
      !data.contactEventFieldValues ||
      data.events.includes('contact.created') ||
      data.events.includes('contact.updated'),
    {
      path: ['contactEventFieldValues'],
      message: WEBHOOK_CONTACT_EVENT_FIELD_VALUES_NEED_THE_EVENTS,
    },
  )
  .refine((data) => !data.assigneeIds || webhookTakesTeamEvents(data.events), {
    path: ['assigneeIds'],
    message: WEBHOOK_ASSIGNEES_NEED_THE_EVENTS,
  })
  .refine((data) => !data.contactTags || webhookTakesTeamEvents(data.events), {
    path: ['contactTags'],
    message: WEBHOOK_CONTACT_TAGS_NEED_THE_EVENTS,
  })
  .refine((data) => !data.conversationTags || webhookTakesTeamEvents(data.events), {
    path: ['conversationTags'],
    message: WEBHOOK_CONVERSATION_TAGS_NEED_THE_EVENTS,
  });

export const apiUpdateWebhookEndpointSchema = z
  .object({
    events: webhookEventTypesSchema.optional().describe('The events the endpoint receives.'),
    description: descriptionField
      .optional()
      .describe('A note for members, up to 200 characters; an empty text removes it.'),
    enabled: z
      .boolean()
      .optional()
      .describe(
        'false turns the endpoint off (its waiting deliveries fail); true turns it on again.',
      ),
    headers: headersField
      .optional()
      .describe(
        'Replaces the endpoint’s headers with these (all of them: values are never shown, so give each again); an empty list removes them. Left out, the headers stay.',
      ),
    messageStatuses: messageStatusesField
      .optional()
      .describe(
        'The message.status statuses the endpoint receives; null receives every status. Left out, they stay, unless the events no longer include message.status, which clears them.',
      ),
    messageSenders: messageSendersField
      .optional()
      .describe(
        'Who sent the messages whose message.status the endpoint receives; null receives the statuses of every message. Left out, they stay, unless the events no longer include message.status, which clears them.',
      ),
    messageApiKeyIds: messageApiKeyIdsField
      .optional()
      .describe(
        "The API keys whose sent messages' message.status the endpoint receives (the company's keys whose messages carry them, whatever their state); null receives the statuses of every message. Left out, they stay, unless the events no longer include message.status, which clears them.",
      ),
    contactParts: contactPartsField
      .optional()
      .describe(
        'The parts of a contact whose change the endpoint receives as contact.updated; null receives every change. Left out, they stay, unless the events no longer include contact.updated, which clears them.',
      ),
    contactFieldKeys: contactFieldKeysField
      .optional()
      .describe(
        "The custom fields whose value changes the endpoint receives as contact.updated (the company's fields; one the endpoint already names may have been deleted since and stays); null receives every field's. Left out, they stay, unless the endpoint no longer receives contact.updated for custom field values, which clears them.",
      ),
    automationIds: automationIdsField
      .optional()
      .describe(
        "The automations whose runs the endpoint receives (the company's published automations); null receives every automation's runs. Left out, they stay, unless the events no longer include automation.run_started, automation.run_ended or automation.run_step, which clears them.",
      ),
    campaignStatuses: campaignStatusesField
      .optional()
      .describe(
        'The statuses a campaign reaches that the endpoint receives as campaign.status_changed; null receives every status. Left out, they stay, unless the events no longer include campaign.status_changed, which clears them.',
      ),
    orderStatuses: orderStatusesField
      .optional()
      .describe(
        'The statuses an order reaches that the endpoint receives as order.status_changed; null receives every status. Left out, they stay, unless the events no longer include order.status_changed, which clears them.',
      ),
    paymentLinkStatuses: paymentLinkStatusesField
      .optional()
      .describe(
        'The statuses a Payment Link reaches that the endpoint receives as payment_link.status_changed; null receives every status. Left out, they stay, unless the events no longer include payment_link.status_changed, which clears them.',
      ),
    codAnswers: codAnswersField
      .optional()
      .describe(
        'The cash on delivery answers the endpoint receives as store_order.cod_answered; null receives every answer. Left out, they stay, unless the events no longer include store_order.cod_answered, which clears them.',
      ),
    storeIds: storeIdsField
      .optional()
      .describe(
        "The connected stores whose cash on delivery answers, order messages and cart reminders the endpoint receives (the company's stores); null receives every store's. Left out, they stay, unless the events include none of store_order.cod_answered, store_order.message_skipped, store_order.message_sent, store_checkout.reminder_skipped and store_checkout.reminder_sent any more, which clears them.",
      ),
    orderMessageEvents: orderMessageEventsField
      .optional()
      .describe(
        'The order messages whose skips and sends the endpoint receives as store_order.message_skipped and store_order.message_sent; null receives every message’s. Left out, they stay, unless the events include neither store_order.message_skipped nor store_order.message_sent any more, which clears them.',
      ),
    orderMessageSkipReasons: orderMessageSkipReasonsField
      .optional()
      .describe(
        'The reasons whose order message skips the endpoint receives as store_order.message_skipped; null receives every reason’s. Left out, they stay, unless the events no longer include store_order.message_skipped, which clears them.',
      ),
    cartReminders: cartRemindersField
      .optional()
      .describe(
        'The cart reminders whose skips and sends the endpoint receives as store_checkout.reminder_skipped and store_checkout.reminder_sent; null receives both. Left out, they stay, unless the events include neither store_checkout.reminder_skipped nor store_checkout.reminder_sent any more, which clears them.',
      ),
    cartReminderSkipReasons: cartReminderSkipReasonsField
      .optional()
      .describe(
        'The reasons whose cart reminder skips the endpoint receives as store_checkout.reminder_skipped; null receives every reason’s. Left out, they stay, unless the events no longer include store_checkout.reminder_skipped, which clears them.',
      ),
    campaignSkipReasons: campaignSkipReasonsField
      .optional()
      .describe(
        'The reasons whose campaign recipient skips the endpoint receives as campaign.recipient_skipped; null receives every reason’s. Left out, they stay, unless the events no longer include campaign.recipient_skipped, which clears them.',
      ),
    runStepOutcomes: runStepOutcomesField
      .optional()
      .describe(
        'The outcomes of the run steps the endpoint receives as automation.run_step; null receives every step. Left out, they stay, unless the events no longer include automation.run_step, which clears them.',
      ),
    runStepNodeTypes: runStepNodeTypesField
      .optional()
      .describe(
        'The kinds of node whose run steps the endpoint receives as automation.run_step; null receives every step. Left out, they stay, unless the events no longer include automation.run_step, which clears them.',
      ),
    orderChangeMakers: orderChangeMakersField
      .optional()
      .describe(
        'Who made the order status changes the endpoint receives as order.status_changed; null receives every change. Left out, they stay, unless the events no longer include order.status_changed, which clears them.',
      ),
    orderExcludedApiKeyIds: orderExcludedApiKeyIdsField
      .optional()
      .describe(
        "The API keys whose order status changes the endpoint does not receive (the company's keys that can change orders, whatever their state); null leaves nothing out. Left out, they stay, unless the events no longer include order.status_changed, which clears them.",
      ),
    paymentLinkApiKeyIds: paymentLinkApiKeyIdsField
      .optional()
      .describe(
        "The API keys whose Payment Links' changes the endpoint receives (the company's keys that ask customers to pay, whatever their state); null receives every link's. Left out, they stay, unless the events no longer include payment_link.status_changed, which clears them.",
      ),
    dealStatuses: dealStatusesField
      .optional()
      .describe(
        'The statuses a deal reaches that the endpoint receives as deal.status_changed; null receives every status. Left out, they stay, unless the events no longer include deal.status_changed, which clears them.',
      ),
    taskStatuses: taskStatusesField
      .optional()
      .describe(
        'The statuses a task reaches that the endpoint receives as task.status_changed; null receives every status. Left out, they stay, unless the events no longer include task.status_changed, which clears them.',
      ),
    dealDetails: dealDetailsField
      .optional()
      .describe(
        'The deal details whose changes the endpoint receives as deal.updated; null receives every change. Left out, they stay, unless the events no longer include deal.updated, which clears them.',
      ),
    taskDetails: taskDetailsField
      .optional()
      .describe(
        'The task details whose changes the endpoint receives as task.updated; null receives every change. Left out, they stay, unless the events no longer include task.updated, which clears them.',
      ),
    templateStatuses: templateStatusesField
      .optional()
      .describe(
        'The template statuses the endpoint receives as template.status_changed; null receives every status. Left out, they stay, unless the events no longer include template.status_changed, which clears them.',
      ),
    conversationStatuses: conversationStatusesField
      .optional()
      .describe(
        'The statuses a conversation reaches that the endpoint receives as conversation.status_changed; null receives every status. Left out, they stay, unless the events no longer include conversation.status_changed, which clears them.',
      ),
    runEndStatuses: runEndStatusesField
      .optional()
      .describe(
        'The statuses a run ended with that the endpoint receives as automation.run_ended; null receives every end. Left out, they stay, unless the events no longer include automation.run_ended, which clears them.',
      ),
    runTriggers: runTriggersField
      .optional()
      .describe(
        'What started the runs whose events the endpoint receives; null receives every run. Left out, they stay, unless the events no longer include automation.run_started, automation.run_ended or automation.run_step, which clears them.',
      ),
    runApiKeyIds: runApiKeyIdsField
      .optional()
      .describe(
        "The API keys whose runs the endpoint receives (the company's keys that can start automations, whatever their state); null receives every run. Left out, they stay, unless the events no longer include automation.run_started, automation.run_ended or automation.run_step, which clears them.",
      ),
    consentChanges: consentChangesField
      .optional()
      .describe(
        'The consent changes the endpoint receives as consent.changed; null receives every change. Left out, they stay, unless the events no longer include consent.changed, which clears them.',
      ),
    contactSources: contactSourcesField
      .optional()
      .describe(
        'Where the contacts whose contact.created the endpoint receives came from; null receives every contact. Left out, they stay, unless the events no longer include contact.created, which clears them.',
      ),
    messageTypes: messageTypesField
      .optional()
      .describe(
        'The types of the received messages the endpoint receives as message.received; null receives every type. Left out, they stay, unless the events no longer include message.received, which clears them.',
      ),
    messageWords: messageWordsField
      .optional()
      .describe(
        'The words or phrases whose received messages the endpoint receives as message.received (a message whose text contains one of them, whatever its case); null receives every message. Left out, they stay, unless the events no longer include message.received, which clears them.',
      ),
    runEndReasons: runEndReasonsField
      .optional()
      .describe(
        'The reasons the runs the endpoint receives as automation.run_ended ended for, only reasons of the ends it keeps; null receives every reason. Left out, they stay, less those of ends it no longer receives (none left: every reason), unless the events no longer include automation.run_ended, which clears them.',
      ),
    channelIds: channelIdsField
      .optional()
      .describe(
        "The WhatsApp numbers whose events the endpoint receives (the company's numbers); null receives the events of every number. Left out, they stay, unless the events no longer include an event that happens on a number, which clears them.",
      ),
    teamIds: teamIdsField
      .optional()
      .describe(
        "The teams whose conversations' events the endpoint receives (the company's teams; one the endpoint already names may have been deleted since and stays); null receives every conversation's. Left out, they stay, unless the events no longer include an event of a conversation, which clears them.",
      ),
    templateIds: templateIdsField
      .optional()
      .describe(
        "The templates whose messages' statuses and changes the endpoint receives (the company's templates); null receives every template's. Left out, they stay, unless the events no longer include message.status or template.status_changed, which clears them.",
      ),
    campaignIds: campaignIdsField
      .optional()
      .describe(
        "The campaigns whose messages' statuses, changes and skipped recipients the endpoint receives (the company's campaigns); null receives every campaign's. Left out, they stay, unless the events no longer include message.status, campaign.status_changed or campaign.recipient_skipped, which clears them.",
      ),
    pipelineIds: pipelineIdsField
      .optional()
      .describe(
        "The CRM pipelines whose deals' events the endpoint receives (the company's pipelines, archived ones included); null receives every pipeline's. Left out, they stay, unless the events no longer include a deal event, which clears them.",
      ),
    stageIds: stageIdsField
      .optional()
      .describe(
        "The CRM stages whose deals' events the endpoint receives (the company's stages, removed ones included); null receives every stage's. Left out, they stay, unless the events no longer include a deal event, which clears them.",
      ),
    ownerIds: ownerIdsField
      .optional()
      .describe(
        "The members whose deals' events the endpoint receives (members who can use the CRM; one the endpoint already names may have left since and stays); null receives every deal's. Left out, they stay, unless the events no longer include a deal event, which clears them.",
      ),
    taskAssigneeIds: taskAssigneeIdsField
      .optional()
      .describe(
        "The members whose tasks' events the endpoint receives (members who can use the CRM; one the endpoint already names may have left since and stays); null receives every task's. Left out, they stay, unless the events no longer include a task event, which clears them.",
      ),
    taskPipelineIds: taskPipelineIdsField
      .optional()
      .describe(
        "The CRM pipelines whose deals' tasks' events the endpoint receives (the company's pipelines, archived ones included); null receives every task's. Left out, they stay, unless the events no longer include a task event, which clears them.",
      ),
    taskStageIds: taskStageIdsField
      .optional()
      .describe(
        "The CRM stages whose deals' tasks' events the endpoint receives (the company's stages, removed ones included); null receives every task's. Left out, they stay, unless the events no longer include a task event, which clears them.",
      ),
    taskDealOwnerIds: taskDealOwnerIdsField
      .optional()
      .describe(
        "The members whose deals' tasks' events the endpoint receives (members who can use the CRM; one the endpoint already names may have left since and stays); null receives every task's. Left out, they stay, unless the events no longer include a task event, which clears them.",
      ),
    notePipelineIds: notePipelineIdsField
      .optional()
      .describe(
        "The CRM pipelines whose deals' notes' events the endpoint receives (the company's pipelines, archived ones included); null receives every note's. Left out, they stay, unless the events no longer include note.created, which clears them.",
      ),
    noteStageIds: noteStageIdsField
      .optional()
      .describe(
        "The CRM stages whose deals' notes' events the endpoint receives (the company's stages, removed ones included); null receives every note's. Left out, they stay, unless the events no longer include note.created, which clears them.",
      ),
    noteDealOwnerIds: noteDealOwnerIdsField
      .optional()
      .describe(
        "The members whose deals' notes' events the endpoint receives (members who can use the CRM; one the endpoint already names may have left since and stays); null receives every note's. Left out, they stay, unless the events no longer include note.created, which clears them.",
      ),
    crmChangeMakers: crmChangeMakersField
      .optional()
      .describe(
        'Who made the changes whose deal, task and note events the endpoint receives; null receives every change. Left out, they stay, unless the events no longer include a deal, task or note event, which clears them.',
      ),
    crmExcludedApiKeyIds: crmExcludedApiKeyIdsField
      .optional()
      .describe(
        "The API keys whose deal, task and note changes the endpoint does not receive (the company's keys that can change them, whatever their state); null leaves nothing out. Left out, they stay, unless the events no longer include a deal, task or note event, which clears them.",
      ),
    surveyScores: surveyScoresField
      .optional()
      .describe(
        'The scores of the satisfaction survey answers the endpoint receives; null receives every answer. Left out, they stay, unless the events no longer include satisfaction_survey.answered, which clears them.',
      ),
    surveyAssigneeIds: surveyAssigneeIdsField
      .optional()
      .describe(
        'The members credited with the satisfaction survey answers the endpoint receives (members who take conversations; one the endpoint already names may have stopped since and stays); null receives every answer. Left out, they stay, unless the events no longer include satisfaction_survey.answered, which clears them.',
      ),
    surveyTeamIds: surveyTeamIdsField
      .optional()
      .describe(
        "The teams whose conversations' satisfaction survey answers the endpoint receives (the company's teams; one the endpoint already names may have been deleted since and stays); null receives every answer. Left out, they stay, unless the events no longer include satisfaction_survey.answered, which clears them.",
      ),
    surveyContactTags: surveyContactTagsField
      .optional()
      .describe(
        'The contact tags whose satisfaction survey answers the endpoint receives (any tag, as contacts carry them); null receives every answer. Left out, they stay, unless the events no longer include satisfaction_survey.answered, which clears them.',
      ),
    surveyConversationTags: surveyConversationTagsField
      .optional()
      .describe(
        'The conversation tags whose satisfaction survey answers the endpoint receives (any tag, as conversations carry them); null receives every answer. Left out, they stay, unless the events no longer include satisfaction_survey.answered, which clears them.',
      ),
    contactEventTags: contactEventTagsField
      .optional()
      .describe(
        'The contact tags whose contact.created and contact.updated the endpoint receives (any tag, as contacts carry them); null receives every contact. Left out, they stay, unless the events include neither contact.created nor contact.updated any more, which clears them.',
      ),
    contactEventFieldValues: contactEventFieldValuesField
      .optional()
      .describe(
        "The custom field conditions whose contact.created and contact.updated the endpoint receives (each a field's key with a value of its type, a word its text contains or a range of its numbers or dates; a condition the endpoint holds may stay as it is after its field is deleted); null receives every contact. Left out, they stay, unless the events include neither contact.created nor contact.updated any more, which clears them.",
      ),
    assigneeIds: assigneeIdsField
      .optional()
      .describe(
        "The members whose assigned conversations' events the endpoint receives (members who take conversations; one the endpoint already names may have stopped since and stays); null receives every conversation's. Left out, they stay, unless the events no longer include an event of a conversation, which clears them.",
      ),
    contactTags: contactTagsField
      .optional()
      .describe(
        "The contact tags whose conversations' events the endpoint receives (any tag, as contacts carry them); null receives every conversation's. Left out, they stay, unless the events no longer include an event of a conversation, which clears them.",
      ),
    conversationTags: conversationTagsField
      .optional()
      .describe(
        "The conversation tags whose events the endpoint receives (any tag, as conversations carry them); null receives every conversation's. Left out, they stay, unless the events no longer include an event of a conversation, which clears them.",
      ),
    oauth: oauthField
      .nullable()
      .optional()
      .describe(
        'Replaces the endpoint’s OAuth client: its token URL, client ID and scope (left out: none). The secret may be left out to keep the stored one, unless the token URL changes: the secret is sent there. Its `clientAuthentication` may be left out to keep the one it has while the token URL stays the same (`client_secret_basic` for a new token URL). null removes the client. Left out, it stays.',
      ),
  })
  .strict()
  .refine(
    (data) =>
      data.events !== undefined ||
      data.description !== undefined ||
      data.enabled !== undefined ||
      data.headers !== undefined ||
      data.messageStatuses !== undefined ||
      data.messageSenders !== undefined ||
      data.messageApiKeyIds !== undefined ||
      data.contactParts !== undefined ||
      data.contactFieldKeys !== undefined ||
      data.automationIds !== undefined ||
      data.campaignStatuses !== undefined ||
      data.orderStatuses !== undefined ||
      data.paymentLinkStatuses !== undefined ||
      data.codAnswers !== undefined ||
      data.storeIds !== undefined ||
      data.orderMessageEvents !== undefined ||
      data.orderMessageSkipReasons !== undefined ||
      data.cartReminders !== undefined ||
      data.cartReminderSkipReasons !== undefined ||
      data.campaignSkipReasons !== undefined ||
      data.runStepOutcomes !== undefined ||
      data.runStepNodeTypes !== undefined ||
      data.orderChangeMakers !== undefined ||
      data.orderExcludedApiKeyIds !== undefined ||
      data.paymentLinkApiKeyIds !== undefined ||
      data.dealStatuses !== undefined ||
      data.taskStatuses !== undefined ||
      data.dealDetails !== undefined ||
      data.taskDetails !== undefined ||
      data.templateStatuses !== undefined ||
      data.conversationStatuses !== undefined ||
      data.runEndStatuses !== undefined ||
      data.runTriggers !== undefined ||
      data.runApiKeyIds !== undefined ||
      data.consentChanges !== undefined ||
      data.contactSources !== undefined ||
      data.messageTypes !== undefined ||
      data.messageWords !== undefined ||
      data.runEndReasons !== undefined ||
      data.channelIds !== undefined ||
      data.teamIds !== undefined ||
      data.templateIds !== undefined ||
      data.campaignIds !== undefined ||
      data.pipelineIds !== undefined ||
      data.stageIds !== undefined ||
      data.ownerIds !== undefined ||
      data.taskAssigneeIds !== undefined ||
      data.taskPipelineIds !== undefined ||
      data.taskStageIds !== undefined ||
      data.taskDealOwnerIds !== undefined ||
      data.notePipelineIds !== undefined ||
      data.noteStageIds !== undefined ||
      data.noteDealOwnerIds !== undefined ||
      data.crmChangeMakers !== undefined ||
      data.crmExcludedApiKeyIds !== undefined ||
      data.surveyScores !== undefined ||
      data.surveyAssigneeIds !== undefined ||
      data.surveyTeamIds !== undefined ||
      data.surveyContactTags !== undefined ||
      data.surveyConversationTags !== undefined ||
      data.contactEventTags !== undefined ||
      data.contactEventFieldValues !== undefined ||
      data.assigneeIds !== undefined ||
      data.contactTags !== undefined ||
      data.conversationTags !== undefined ||
      data.oauth !== undefined,
    'Give the events, the description, the headers, the message statuses, who sent the messages, the API keys that sent them, the contact parts, the deal and task details, the custom fields, the automations, the campaign statuses, the order statuses, who made the order changes, the API keys whose order changes are left out, the Payment Link statuses, the API keys that asked for the Payment Links, the template statuses, the conversation statuses, the deal statuses, the task statuses, the run end statuses, the step outcomes, the kinds of step, what started the runs, the API keys that started them, the consent changes, where contacts came from, the received message types, the run end reasons, the numbers, the teams, the templates, the cash on delivery answers, the stores of store events, the order messages whose skips and sends are sent, the skip reasons of skipped order messages, the cart reminders whose skips and sends are sent, the skip reasons of skipped cart reminders, the skip reasons of skipped campaign recipients, the campaigns, the pipelines, the stages, the deal owners, the task assignees, the pipelines, stages and owners of tasks’ deals and of notes’ deals, who made the CRM changes, the API keys whose CRM changes are left out, the survey scores, the members credited with survey answers and the teams of their conversations, the contact and conversation tags of survey answers, the tags and field values of added and changed contacts, the members, the contact tags, the conversation tags, the OAuth client or whether the endpoint is enabled',
  );

export interface ApiWebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  events: WebhookEventType[];
  status: 'active' | 'disabled';
  /** Why a disabled endpoint is off: turned off, or failing for 72 hours (ADR-053). */
  disabledReason: 'manual' | 'failing' | null;
  failingSince: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  secretVersion: number;
  /** Until when the previous secret also signs, after a rotation. */
  previousSecretExpiresAt: string | null;
  /** The endpoint's own headers, by name only (ADR-118): values are never shown. */
  headers: { name: string }[];
  /** The `message.status` statuses it receives (ADR-119); null receives every status. */
  messageStatuses: WebhookMessageStatus[] | null;
  /** Who sent the messages whose statuses it receives (ADR-172); null receives every sender's. */
  messageSenders: WebhookMessageSender[] | null;
  /** The API keys whose messages' statuses it receives (ADR-320); null receives every message's. */
  messageApiKeyIds: string[] | null;
  /** The contact parts it receives as `contact.updated` (ADR-123); null receives every change. */
  contactParts: WebhookContactPart[] | null;
  /** The custom fields whose changes it receives (ADR-184); null receives every field's. */
  contactFieldKeys: string[] | null;
  /** The automations whose runs it receives (ADR-145); null receives every automation's runs. */
  automationIds: string[] | null;
  /** The campaign statuses it receives (ADR-146); null receives every status. */
  campaignStatuses: WebhookCampaignStatus[] | null;
  /** The order statuses it receives (ADR-147); null receives every status. */
  orderStatuses: WebhookOrderStatus[] | null;
  /** The Payment Link statuses it receives (ADR-308); null receives every status. */
  paymentLinkStatuses: WebhookPaymentLinkStatus[] | null;
  /** The cash on delivery answers it receives (ADR-349); null receives every answer. */
  codAnswers: WebhookCodAnswer[] | null;
  /**
   * The stores whose cash on delivery answers (ADR-349), skipped (ADR-352) and sent (ADR-353) order
   * messages and cart reminders (ADR-355) it receives; null receives every one's.
   */
  storeIds: string[] | null;
  /** The order messages whose skips and sends it receives (ADR-352, ADR-353); null: every one's. */
  orderMessageEvents: WebhookOrderMessageEvent[] | null;
  /** The reasons whose order message skips it receives (ADR-354); null receives every reason. */
  orderMessageSkipReasons: WebhookOrderMessageSkipReason[] | null;
  /** The cart reminders whose skips and sends it receives (ADR-361); null receives both. */
  cartReminders: WebhookCartReminder[] | null;
  /** The reasons whose cart reminder skips it receives (ADR-356); null receives every reason. */
  cartReminderSkipReasons: WebhookCartReminderSkipReason[] | null;
  /** The reasons whose campaign recipient skips it receives (ADR-359); null receives every reason. */
  campaignSkipReasons: WebhookCampaignSkipReason[] | null;
  /** The outcomes of the run steps it receives (ADR-327); null receives every step. */
  runStepOutcomes: WebhookRunStepOutcome[] | null;
  /** The kinds of node whose run steps it receives (ADR-328); null receives every step. */
  runStepNodeTypes: WebhookRunStepNodeType[] | null;
  /** Who made the order status changes it receives (ADR-322); null receives every change. */
  orderChangeMakers: WebhookOrderChangeMaker[] | null;
  /** The API keys whose order status changes it leaves out (ADR-323); null: none. */
  orderExcludedApiKeyIds: string[] | null;
  /** The API keys whose Payment Links' changes it receives (ADR-324); null: every link's. */
  paymentLinkApiKeyIds: string[] | null;
  /** The deal statuses it receives (ADR-309); null receives every status. */
  dealStatuses: WebhookDealStatus[] | null;
  /** The task statuses it receives (ADR-309); null receives every status. */
  taskStatuses: WebhookTaskStatus[] | null;
  /** The deal details whose changes it receives (ADR-310); null receives every change. */
  dealDetails: WebhookDealDetail[] | null;
  /** The task details whose changes it receives (ADR-310); null receives every change. */
  taskDetails: WebhookTaskDetail[] | null;
  /** The template statuses it receives (ADR-148); null receives every status. */
  templateStatuses: WebhookTemplateStatus[] | null;
  /** The conversation statuses it receives (ADR-149); null receives every status. */
  conversationStatuses: WebhookConversationStatus[] | null;
  /** How the runs it receives as `automation.run_ended` ended (ADR-151); null receives every end. */
  runEndStatuses: WebhookRunEndStatus[] | null;
  /** What started the runs whose events it receives (ADR-183); null receives every run. */
  runTriggers: WebhookRunTrigger[] | null;
  /** The API keys whose runs it receives (ADR-319); null receives every run. */
  runApiKeyIds: string[] | null;
  /** The consent changes it receives as `consent.changed` (ADR-189); null receives every change. */
  consentChanges: WebhookConsentChange[] | null;
  /** Where the contacts whose `contact.created` it receives came from (ADR-190); null: every one. */
  contactSources: ContactSource[] | null;
  /** The types of the received messages it receives (ADR-191); null receives every type. */
  messageTypes: WebhookReceivedMessageType[] | null;
  /** The words of the received messages it receives (ADR-337); null receives every message. */
  messageWords: string[] | null;
  /** Why the runs it receives as `automation.run_ended` ended (ADR-192); null: every reason. */
  runEndReasons: AutomationEndReason[] | null;
  /** The numbers whose events it receives (ADR-170); null receives every number's. */
  channelIds: string[] | null;
  /** The teams whose conversations' events it receives (ADR-174); null receives every one's. */
  teamIds: string[] | null;
  /** The templates whose statuses and changes it receives (ADR-175); null receives every one's. */
  templateIds: string[] | null;
  /** The campaigns whose statuses and changes it receives (ADR-185); null receives every one's. */
  campaignIds: string[] | null;
  /** The CRM pipelines whose deals' events it receives (ADR-263); null receives every one's. */
  pipelineIds: string[] | null;
  /** The CRM stages whose deals' events it receives (ADR-264); null receives every one's. */
  stageIds: string[] | null;
  /** The members whose deals' events it receives (ADR-265); null receives every deal's. */
  ownerIds: string[] | null;
  /** The members whose tasks' events it receives (ADR-266); null receives every task's. */
  taskAssigneeIds: string[] | null;
  /** The CRM pipelines whose deals' tasks' events it receives (ADR-303); null: every task's. */
  taskPipelineIds: string[] | null;
  /** The CRM stages whose deals' tasks' events it receives (ADR-304); null: every task's. */
  taskStageIds: string[] | null;
  /** The members whose deals' tasks' events it receives (ADR-304); null: every task's. */
  taskDealOwnerIds: string[] | null;
  /** The CRM pipelines whose deals' notes' events it receives (ADR-305); null: every note's. */
  notePipelineIds: string[] | null;
  /** The CRM stages whose deals' notes' events it receives (ADR-305); null: every note's. */
  noteStageIds: string[] | null;
  /** The members whose deals' notes' events it receives (ADR-305); null: every note's. */
  noteDealOwnerIds: string[] | null;
  /** Who made the changes whose deal, task and note events it receives (ADR-306); null: all. */
  crmChangeMakers: WebhookCrmChangeMaker[] | null;
  /** The API keys whose deal, task and note changes it leaves out (ADR-321); null: none. */
  crmExcludedApiKeyIds: string[] | null;
  /** The scores of the satisfaction survey answers it receives (ADR-307); null: every answer. */
  surveyScores: WebhookSurveyScore[] | null;
  /** The members credited with the survey answers it receives (ADR-311); null: every answer. */
  surveyAssigneeIds: string[] | null;
  /** The teams of the conversations whose survey answers it receives (ADR-311); null: every one. */
  surveyTeamIds: string[] | null;
  /** The contact tags whose survey answers it receives (ADR-312); null: every answer. */
  surveyContactTags: string[] | null;
  /** The conversation tags whose survey answers it receives (ADR-312); null: every answer. */
  surveyConversationTags: string[] | null;
  /** The contact tags of the added and changed contacts it receives (ADR-316); null: every one. */
  contactEventTags: string[] | null;
  /** The field values of the added and changed contacts it receives (ADR-332); null: every one. */
  contactEventFieldValues: WebhookContactFieldValue[] | null;
  /** The members whose assigned conversations' events it receives (ADR-181); null: every one's. */
  assigneeIds: string[] | null;
  /** The contact tags whose conversations' events it receives (ADR-267); null: every one's. */
  contactTags: string[] | null;
  /** The conversation tags whose events it receives (ADR-273); null: every conversation's. */
  conversationTags: string[] | null;
  /** Where it gets OAuth tokens and as which client (ADR-173); the secret is never shown. */
  oauth: WebhookEndpointOAuth | null;
  /** The key that added the endpoint. */
  apiKeyId: string;
  createdAt: string;
  updatedAt: string;
}

/** A delivery of an event to an endpoint a key added (ADR-083). */
export interface ApiWebhookDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  /** The event's type, or `ping` for a test event. */
  eventType: string;
  status: WebhookDeliveryState;
  attempts: number;
  /** When the next attempt is due, while the delivery waits. */
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
  deliveredAt: string | null;
  /** The delivery this one replays. */
  replayOf: string | null;
  createdAt: string;
}

/** Replaying an endpoint's failed deliveries (ADR-095). */
export const apiReplayFailedDeliveriesSchema = z
  .object({
    since: z.iso
      .datetime({
        offset: true,
        error: 'Give since as a date and time, such as 2026-09-30T08:00:00Z',
      })
      .describe(
        'Replay the failed deliveries queued at or after this time. Deliveries are kept 30 days.',
      ),
    events: webhookEventTypesSchema
      .optional()
      .describe(
        'Replay only the failed deliveries of these events. Left out, those of every event are replayed.',
      ),
    failures: webhookFailureKindsSchema
      .optional()
      .describe(
        'Replay only the events whose latest failed delivery failed in one of these ways: `server_error` (answered with HTTP 5xx), `client_error` (HTTP 4xx), `other_answer` (HTTP 1xx or 3xx; redirects are not followed), `no_answer` (no valid answer: a timeout, a host or address that failed, a broken connection, an answer too large or without a valid status, an interrupted attempt, or no access token from the endpoint’s OAuth authorization server) or `not_attempted` (ended without an attempt: the endpoint was off, or HyFib could not prepare the request). Left out, every failure is replayed.',
      ),
  })
  .strict();

export const apiWebhookDeliveryListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
    status: z.enum(WEBHOOK_DELIVERY_STATES).optional().describe('Only deliveries in this state.'),
  })
  .strict();

function toApiDelivery(row: WebhookDeliveryView): ApiWebhookDelivery {
  return {
    id: row.id,
    endpointId: row.endpointId,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.state === 'pending' ? row.nextAttemptAt.toISOString() : null,
    lastAttemptAt: iso(row.lastAttemptAt),
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    lastDurationMs: row.lastDurationMs,
    deliveredAt: iso(row.deliveredAt),
    replayOf: row.replayOf,
    createdAt: row.createdAt.toISOString(),
  };
}

const columns = {
  id: webhookEndpoints.id,
  url: webhookEndpoints.url,
  description: webhookEndpoints.description,
  eventTypes: webhookEndpoints.eventTypes,
  state: webhookEndpoints.state,
  disabledReason: webhookEndpoints.disabledReason,
  failingSince: webhookEndpoints.failingSince,
  lastSuccessAt: webhookEndpoints.lastSuccessAt,
  lastFailureAt: webhookEndpoints.lastFailureAt,
  secretVersion: webhookEndpoints.secretVersion,
  previousSecretExpiresAt: webhookEndpoints.previousSecretExpiresAt,
  headerNames: webhookEndpoints.headerNames,
  messageStatuses: webhookEndpoints.messageStatuses,
  messageSenders: webhookEndpoints.messageSenders,
  messageApiKeyIds: webhookEndpoints.messageApiKeyIds,
  contactParts: webhookEndpoints.contactParts,
  contactFieldKeys: webhookEndpoints.contactFieldKeys,
  automationIds: webhookEndpoints.automationIds,
  campaignStatuses: webhookEndpoints.campaignStatuses,
  orderStatuses: webhookEndpoints.orderStatuses,
  paymentLinkStatuses: webhookEndpoints.paymentLinkStatuses,
  codAnswers: webhookEndpoints.codAnswers,
  storeIds: webhookEndpoints.storeIds,
  orderMessageEvents: webhookEndpoints.orderMessageEvents,
  orderMessageSkipReasons: webhookEndpoints.orderMessageSkipReasons,
  cartReminders: webhookEndpoints.cartReminders,
  cartReminderSkipReasons: webhookEndpoints.cartReminderSkipReasons,
  campaignSkipReasons: webhookEndpoints.campaignSkipReasons,
  runStepOutcomes: webhookEndpoints.runStepOutcomes,
  runStepNodeTypes: webhookEndpoints.runStepNodeTypes,
  orderChangeMakers: webhookEndpoints.orderChangeMakers,
  orderExcludedApiKeyIds: webhookEndpoints.orderExcludedApiKeyIds,
  paymentLinkApiKeyIds: webhookEndpoints.paymentLinkApiKeyIds,
  dealStatuses: webhookEndpoints.dealStatuses,
  taskStatuses: webhookEndpoints.taskStatuses,
  dealDetails: webhookEndpoints.dealDetails,
  taskDetails: webhookEndpoints.taskDetails,
  templateStatuses: webhookEndpoints.templateStatuses,
  conversationStatuses: webhookEndpoints.conversationStatuses,
  runEndStatuses: webhookEndpoints.runEndStatuses,
  runTriggers: webhookEndpoints.runTriggers,
  runApiKeyIds: webhookEndpoints.runApiKeyIds,
  consentChanges: webhookEndpoints.consentChanges,
  contactSources: webhookEndpoints.contactSources,
  messageTypes: webhookEndpoints.messageTypes,
  messageWords: webhookEndpoints.messageWords,
  runEndReasons: webhookEndpoints.runEndReasons,
  channelAccountIds: webhookEndpoints.channelAccountIds,
  teamIds: webhookEndpoints.teamIds,
  templateIds: webhookEndpoints.templateIds,
  campaignIds: webhookEndpoints.campaignIds,
  pipelineIds: webhookEndpoints.pipelineIds,
  stageIds: webhookEndpoints.stageIds,
  ownerIds: webhookEndpoints.ownerIds,
  taskAssigneeIds: webhookEndpoints.taskAssigneeIds,
  taskPipelineIds: webhookEndpoints.taskPipelineIds,
  taskStageIds: webhookEndpoints.taskStageIds,
  taskDealOwnerIds: webhookEndpoints.taskDealOwnerIds,
  notePipelineIds: webhookEndpoints.notePipelineIds,
  noteStageIds: webhookEndpoints.noteStageIds,
  noteDealOwnerIds: webhookEndpoints.noteDealOwnerIds,
  crmChangeMakers: webhookEndpoints.crmChangeMakers,
  crmExcludedApiKeyIds: webhookEndpoints.crmExcludedApiKeyIds,
  surveyScores: webhookEndpoints.surveyScores,
  surveyAssigneeIds: webhookEndpoints.surveyAssigneeIds,
  surveyTeamIds: webhookEndpoints.surveyTeamIds,
  surveyContactTags: webhookEndpoints.surveyContactTags,
  surveyConversationTags: webhookEndpoints.surveyConversationTags,
  contactEventTags: webhookEndpoints.contactEventTags,
  contactEventFieldValues: webhookEndpoints.contactEventFieldValues,
  assigneeIds: webhookEndpoints.assigneeIds,
  contactTags: webhookEndpoints.contactTags,
  conversationTags: webhookEndpoints.conversationTags,
  oauthTokenUrl: webhookEndpoints.oauthTokenUrl,
  oauthClientId: webhookEndpoints.oauthClientId,
  oauthScope: webhookEndpoints.oauthScope,
  oauthClientAuth: webhookEndpoints.oauthClientAuth,
  apiKeyId: webhookEndpoints.createdByApiKeyId,
  createdAt: webhookEndpoints.createdAt,
  updatedAt: webhookEndpoints.updatedAt,
};

type EndpointRow = Pick<
  typeof webhookEndpoints.$inferSelect,
  | 'id'
  | 'url'
  | 'description'
  | 'eventTypes'
  | 'state'
  | 'disabledReason'
  | 'failingSince'
  | 'lastSuccessAt'
  | 'lastFailureAt'
  | 'secretVersion'
  | 'previousSecretExpiresAt'
  | 'headerNames'
  | 'messageStatuses'
  | 'messageSenders'
  | 'messageApiKeyIds'
  | 'contactParts'
  | 'contactFieldKeys'
  | 'automationIds'
  | 'campaignStatuses'
  | 'orderStatuses'
  | 'paymentLinkStatuses'
  | 'codAnswers'
  | 'storeIds'
  | 'orderMessageEvents'
  | 'orderMessageSkipReasons'
  | 'cartReminders'
  | 'cartReminderSkipReasons'
  | 'campaignSkipReasons'
  | 'runStepOutcomes'
  | 'runStepNodeTypes'
  | 'orderChangeMakers'
  | 'orderExcludedApiKeyIds'
  | 'paymentLinkApiKeyIds'
  | 'dealStatuses'
  | 'taskStatuses'
  | 'dealDetails'
  | 'taskDetails'
  | 'templateStatuses'
  | 'conversationStatuses'
  | 'runEndStatuses'
  | 'runTriggers'
  | 'runApiKeyIds'
  | 'consentChanges'
  | 'contactSources'
  | 'messageTypes'
  | 'messageWords'
  | 'runEndReasons'
  | 'channelAccountIds'
  | 'teamIds'
  | 'templateIds'
  | 'campaignIds'
  | 'pipelineIds'
  | 'stageIds'
  | 'ownerIds'
  | 'taskAssigneeIds'
  | 'taskPipelineIds'
  | 'taskStageIds'
  | 'taskDealOwnerIds'
  | 'notePipelineIds'
  | 'noteStageIds'
  | 'noteDealOwnerIds'
  | 'crmChangeMakers'
  | 'crmExcludedApiKeyIds'
  | 'surveyScores'
  | 'surveyAssigneeIds'
  | 'surveyTeamIds'
  | 'surveyContactTags'
  | 'surveyConversationTags'
  | 'contactEventTags'
  | 'contactEventFieldValues'
  | 'assigneeIds'
  | 'contactTags'
  | 'conversationTags'
  | 'oauthTokenUrl'
  | 'oauthClientId'
  | 'oauthScope'
  | 'oauthClientAuth'
  | 'createdAt'
  | 'updatedAt'
> & { apiKeyId: string | null };

const iso = (at: Date | null) => at?.toISOString() ?? null;

function toApiEndpoint(row: EndpointRow, now: Date): ApiWebhookEndpoint {
  if (!row.apiKeyId) throw new Error('An endpoint a key added has no key');
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.eventTypes,
    status: row.state,
    disabledReason: row.disabledReason,
    failingSince: iso(row.failingSince),
    lastSuccessAt: iso(row.lastSuccessAt),
    lastFailureAt: iso(row.lastFailureAt),
    secretVersion: row.secretVersion,
    previousSecretExpiresAt:
      row.previousSecretExpiresAt && row.previousSecretExpiresAt > now
        ? row.previousSecretExpiresAt.toISOString()
        : null,
    headers: row.headerNames.map((name) => ({ name })),
    messageStatuses: row.messageStatuses,
    messageSenders: row.messageSenders,
    messageApiKeyIds: row.messageApiKeyIds,
    contactParts: row.contactParts,
    contactFieldKeys: row.contactFieldKeys,
    automationIds: row.automationIds,
    campaignStatuses: row.campaignStatuses,
    orderStatuses: row.orderStatuses,
    paymentLinkStatuses: row.paymentLinkStatuses,
    codAnswers: row.codAnswers,
    storeIds: row.storeIds,
    orderMessageEvents: row.orderMessageEvents,
    orderMessageSkipReasons: row.orderMessageSkipReasons,
    cartReminders: row.cartReminders,
    cartReminderSkipReasons: row.cartReminderSkipReasons,
    campaignSkipReasons: row.campaignSkipReasons,
    runStepOutcomes: row.runStepOutcomes,
    runStepNodeTypes: row.runStepNodeTypes,
    orderChangeMakers: row.orderChangeMakers,
    orderExcludedApiKeyIds: row.orderExcludedApiKeyIds,
    paymentLinkApiKeyIds: row.paymentLinkApiKeyIds,
    dealStatuses: row.dealStatuses,
    taskStatuses: row.taskStatuses,
    dealDetails: row.dealDetails,
    taskDetails: row.taskDetails,
    templateStatuses: row.templateStatuses,
    conversationStatuses: row.conversationStatuses,
    runEndStatuses: row.runEndStatuses,
    runTriggers: row.runTriggers,
    runApiKeyIds: row.runApiKeyIds,
    consentChanges: row.consentChanges,
    contactSources: row.contactSources,
    messageTypes: row.messageTypes,
    messageWords: row.messageWords,
    runEndReasons: row.runEndReasons,
    channelIds: row.channelAccountIds,
    teamIds: row.teamIds,
    templateIds: row.templateIds,
    campaignIds: row.campaignIds,
    pipelineIds: row.pipelineIds,
    stageIds: row.stageIds,
    ownerIds: row.ownerIds,
    taskAssigneeIds: row.taskAssigneeIds,
    taskPipelineIds: row.taskPipelineIds,
    taskStageIds: row.taskStageIds,
    taskDealOwnerIds: row.taskDealOwnerIds,
    notePipelineIds: row.notePipelineIds,
    noteStageIds: row.noteStageIds,
    noteDealOwnerIds: row.noteDealOwnerIds,
    crmChangeMakers: row.crmChangeMakers,
    crmExcludedApiKeyIds: row.crmExcludedApiKeyIds,
    surveyScores: row.surveyScores,
    surveyAssigneeIds: row.surveyAssigneeIds,
    surveyTeamIds: row.surveyTeamIds,
    surveyContactTags: row.surveyContactTags,
    surveyConversationTags: row.surveyConversationTags,
    contactEventTags: row.contactEventTags,
    contactEventFieldValues: row.contactEventFieldValues,
    assigneeIds: row.assigneeIds,
    contactTags: row.contactTags,
    conversationTags: row.conversationTags,
    oauth:
      row.oauthTokenUrl && row.oauthClientId
        ? {
            tokenUrl: row.oauthTokenUrl,
            clientId: row.oauthClientId,
            scope: row.oauthScope,
            clientAuthentication: row.oauthClientAuth,
          }
        : null,
    apiKeyId: row.apiKeyId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const addedByKey = (tenantId: string) =>
  and(eq(webhookEndpoints.tenantId, tenantId), isNotNull(webhookEndpoints.createdByApiKeyId));

async function readEndpoint(tx: Tx, ctx: ApiContext, id: string, now: Date) {
  const [row] = await tx
    .select(columns)
    .from(webhookEndpoints)
    .where(and(addedByKey(ctx.tenant.id), eq(webhookEndpoints.id, id)));
  if (!row) throw notFound('Webhook endpoint');
  return toApiEndpoint(row, now);
}

const endpointId = (id: string) => {
  if (!z.uuid().safeParse(id).success) throw notFound('Webhook endpoint');
  return id;
};

const invalidSince = (message: string) =>
  new AppError('validation_failed', message, { issues: [{ path: 'since', message }] });

const deliveryId = (id: string) => {
  if (!z.uuid().safeParse(id).success) throw notFound('Delivery');
  return id;
};

/** A delivery to an endpoint a key added; any other is not found. */
async function readDelivery(tx: Tx, ctx: ApiContext, id: string): Promise<ApiWebhookDelivery> {
  const [row] = await tx
    .select(webhookDeliveryColumns)
    .from(webhookDeliveries)
    .innerJoin(webhookEvents, deliveryEventJoin)
    .innerJoin(
      webhookEndpoints,
      and(
        eq(webhookEndpoints.tenantId, webhookDeliveries.tenantId),
        eq(webhookEndpoints.id, webhookDeliveries.endpointId),
      ),
    )
    .where(and(addedByKey(ctx.tenant.id), eq(webhookDeliveries.id, id)));
  if (!row) throw notFound('Delivery');
  return toApiDelivery(row);
}

/** The response kept for an `Idempotency-Key`: the same, without the secret (shown once). */
const withoutSecret = (body: Record<string, unknown>) => ({
  ...body,
  data: { ...(body.data as Record<string, unknown>), secret: null },
});

/** The email to owners and administrators when a key adds an endpoint, times in the company's zone. */
export function endpointAnnouncement(input: {
  keyName: string;
  keyPrefix: string;
  host: string;
  events: WebhookEventType[];
  at: Date;
  timeZone: string;
}): { subject: string; lines: string[] } {
  const events = input.events.map((event) => WEBHOOK_EVENT_INFO[event].label).join(', ');
  return {
    subject: 'Webhook endpoint added through the API',
    lines: [
      `The API key “${input.keyName}” (${input.keyPrefix}_…) added a webhook endpoint at ${input.host} on ${formatCompanyTime(input.at, input.timeZone)}. It receives: ${events}.`,
      'If you did not expect this, delete the endpoint in Settings, Webhooks, and revoke the key in Settings, API keys.',
    ],
  };
}

export interface ApiWebhookEndpointsDeps extends OutboxDeps {
  db: Database;
  clock: Clock;
  egressPolicy: Pick<EgressPolicy, 'allowLoopbackForTests'>;
  appBaseUrl: string;
}

export function createApiWebhookEndpoints(deps: ApiWebhookEndpointsDeps) {
  const { db, clock } = deps;

  /** Emails the company's owners and administrators that the request's key added an endpoint. */
  async function announce(
    tx: Tx,
    ctx: ApiContext,
    endpoint: { host: string; events: WebhookEventType[]; at: Date },
  ) {
    const [company] = await tx
      .select({ name: tenants.name, slug: tenants.slug, timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenant.id));
    const [key] = await tx
      .select({ name: apiKeys.name, keyPrefix: apiKeys.keyPrefix })
      .from(apiKeys)
      .where(and(eq(apiKeys.tenantId, ctx.tenant.id), eq(apiKeys.id, ctx.key.id)));
    if (!company || !key) throw new Error('The company or the key of an API request is missing');
    const { subject, lines } = endpointAnnouncement({
      keyName: key.name,
      keyPrefix: key.keyPrefix,
      host: endpoint.host,
      events: endpoint.events,
      at: endpoint.at,
      timeZone: company.timezone,
    });
    for (const person of await deletionRecipients(tx, ctx.tenant.id)) {
      await enqueueEmail(deps, tx, {
        to: person.email,
        tenantId: ctx.tenant.id,
        payload: {
          kind: 'tenant.notice',
          companyName: company.name,
          subject,
          lines,
          url: `${deps.appBaseUrl}/c/${company.slug}/settings/webhooks`,
          actionLabel: 'Review webhooks',
        },
      });
    }
  }

  // An endpoint's entry names its largest lists by length and digest if it would not fit (ADR-363).
  const audit = (
    tx: Tx,
    ctx: ApiContext,
    action: string,
    id: string,
    metadata: Record<string, unknown>,
  ) =>
    recordSystemAudit(
      tx,
      ctx.tenant.id,
      {
        action,
        subjectType: 'webhook_endpoint',
        subjectId: id,
        metadata: { ...webhookEndpointAuditMetadata(metadata), source: 'api' },
        correlationId: ctx.requestId,
      },
      apiActor(ctx),
    );

  return {
    /** GET /api/v1/webhook-endpoints: the endpoints keys added, oldest first. */
    async list(ctx: ApiContext): Promise<{ data: ApiWebhookEndpoint[] }> {
      assertScope(ctx, 'webhooks.manage');
      const now = clock.now();
      return db.run(
        ctx.scope,
        async (tx) => {
          const rows = await tx
            .select(columns)
            .from(webhookEndpoints)
            .where(addedByKey(ctx.tenant.id))
            .orderBy(asc(webhookEndpoints.createdAt), asc(webhookEndpoints.id));
          return { data: rows.map((row) => toApiEndpoint(row, now)) };
        },
        { accessMode: 'read only' },
      );
    },

    /** GET /api/v1/webhook-endpoints/{id}. */
    async get(ctx: ApiContext, id: string): Promise<ApiWebhookEndpoint> {
      assertScope(ctx, 'webhooks.manage');
      endpointId(id);
      return db.run(ctx.scope, (tx) => readEndpoint(tx, ctx, id, clock.now()), {
        accessMode: 'read only',
      });
    },

    /**
     * POST /api/v1/webhook-endpoints: a new endpoint, once per `Idempotency-Key`, with its secret
     * in the first response only. Owners and administrators are emailed about it.
     */
    async create(
      ctx: ApiContext,
      input: unknown,
      idempotency: IdempotencyInput,
    ): Promise<ApiResponse> {
      assertScope(ctx, 'webhooks.manage');
      const data = parseInput(apiCreateWebhookEndpointSchema, input);
      const { url, host } = checkedWebhookUrl(data.url, deps.egressPolicy);
      const oauth = data.oauth
        ? checkedWebhookOAuth(data.oauth, NO_WEBHOOK_OAUTH, deps.egressPolicy)
        : null;
      assertWebhookAuthorization(
        (data.headers ?? []).map((h) => h.name),
        oauth !== null,
        data.headers,
      );
      const now = clock.now();
      return db.run(ctx.scope, (tx) =>
        idempotent(
          tx,
          ctx,
          idempotency,
          now,
          async () => {
            const headers = data.headers ?? [];
            const messageStatuses = webhookMessageStatusesFor(
              data.events,
              data.messageStatuses,
              null,
            );
            const messageSenders = webhookMessageSendersFor(data.events, data.messageSenders, null);
            const messageApiKeyIds = webhookMessageApiKeyIdsFor(
              data.events,
              data.messageApiKeyIds,
              null,
            );
            await assertWebhookMessageApiKeys(tx, ctx.tenant.id, messageApiKeyIds);
            const contactParts = webhookContactPartsFor(data.events, data.contactParts, null);
            const contactFieldKeys = webhookContactFieldKeysFor(
              data.events,
              contactParts,
              data.contactFieldKeys,
              null,
            );
            await assertWebhookContactFields(tx, ctx.tenant.id, contactFieldKeys);
            const automationIds = webhookAutomationIdsFor(data.events, data.automationIds, null);
            await assertWebhookAutomations(tx, ctx.tenant.id, automationIds);
            const campaignStatuses = webhookCampaignStatusesFor(
              data.events,
              data.campaignStatuses,
              null,
            );
            const orderStatuses = webhookOrderStatusesFor(data.events, data.orderStatuses, null);
            const paymentLinkStatuses = webhookPaymentLinkStatusesFor(
              data.events,
              data.paymentLinkStatuses,
              null,
            );
            const runStepOutcomes = webhookRunStepOutcomesFor(
              data.events,
              data.runStepOutcomes,
              null,
            );
            const codAnswers = webhookCodAnswersFor(data.events, data.codAnswers, null);
            const storeIds = webhookStoreIdsFor(data.events, data.storeIds, null);
            await assertWebhookStores(tx, ctx.tenant.id, storeIds);
            const orderMessageEvents = webhookOrderMessageEventsFor(
              data.events,
              data.orderMessageEvents,
              null,
            );
            const orderMessageSkipReasons = webhookOrderMessageSkipReasonsFor(
              data.events,
              data.orderMessageSkipReasons,
              null,
            );
            const cartReminders = webhookCartRemindersFor(data.events, data.cartReminders, null);
            const cartReminderSkipReasons = webhookCartReminderSkipReasonsFor(
              data.events,
              data.cartReminderSkipReasons,
              null,
            );
            const campaignSkipReasons = webhookCampaignSkipReasonsFor(
              data.events,
              data.campaignSkipReasons,
              null,
            );
            const runStepNodeTypes = webhookRunStepNodeTypesFor(
              data.events,
              data.runStepNodeTypes,
              null,
            );
            const orderChangeMakers = webhookOrderChangeMakersFor(
              data.events,
              data.orderChangeMakers,
              null,
            );
            const orderExcludedApiKeyIds = webhookOrderExcludedApiKeyIdsFor(
              data.events,
              data.orderExcludedApiKeyIds,
              null,
            );
            await assertWebhookOrderExcludedApiKeys(tx, ctx.tenant.id, orderExcludedApiKeyIds);
            const paymentLinkApiKeyIds = webhookPaymentLinkApiKeyIdsFor(
              data.events,
              data.paymentLinkApiKeyIds,
              null,
            );
            await assertWebhookPaymentLinkApiKeys(tx, ctx.tenant.id, paymentLinkApiKeyIds);
            const dealStatuses = webhookDealStatusesFor(data.events, data.dealStatuses, null);
            const taskStatuses = webhookTaskStatusesFor(data.events, data.taskStatuses, null);
            const dealDetails = webhookDealDetailsFor(data.events, data.dealDetails, null);
            const taskDetails = webhookTaskDetailsFor(data.events, data.taskDetails, null);
            const templateStatuses = webhookTemplateStatusesFor(
              data.events,
              data.templateStatuses,
              null,
            );
            const conversationStatuses = webhookConversationStatusesFor(
              data.events,
              data.conversationStatuses,
              null,
            );
            const runEndStatuses = webhookRunEndStatusesFor(data.events, data.runEndStatuses, null);
            const runTriggers = webhookRunTriggersFor(data.events, data.runTriggers, null);
            const runApiKeyIds = webhookRunApiKeyIdsFor(data.events, data.runApiKeyIds, null);
            await assertWebhookRunApiKeys(tx, ctx.tenant.id, runApiKeyIds);
            const consentChanges = webhookConsentChangesFor(data.events, data.consentChanges, null);
            const contactSources = webhookContactSourcesFor(data.events, data.contactSources, null);
            const messageTypes = webhookMessageTypesFor(data.events, data.messageTypes, null);
            const messageWords = webhookMessageWordsFor(data.events, data.messageWords, null);
            const runEndReasons = webhookRunEndReasonsFor(
              data.events,
              runEndStatuses,
              data.runEndReasons,
              null,
            );
            const channelIds = webhookChannelIdsFor(data.events, data.channelIds, null);
            await assertWebhookChannels(tx, ctx.tenant.id, channelIds);
            const teamIds = webhookTeamIdsFor(data.events, data.teamIds, null);
            await assertWebhookTeams(tx, ctx.tenant.id, teamIds);
            const templateIds = webhookTemplateIdsFor(data.events, data.templateIds, null);
            await assertWebhookTemplates(tx, ctx.tenant.id, templateIds);
            const campaignIds = webhookCampaignIdsFor(data.events, data.campaignIds, null);
            await assertWebhookCampaigns(tx, ctx.tenant.id, campaignIds);
            const pipelineIds = webhookPipelineIdsFor(data.events, data.pipelineIds, null);
            await assertWebhookPipelines(tx, ctx.tenant.id, pipelineIds);
            const stageIds = webhookStageIdsFor(data.events, data.stageIds, null);
            await assertWebhookStages(tx, ctx.tenant.id, stageIds);
            const ownerIds = webhookOwnerIdsFor(data.events, data.ownerIds, null);
            await assertWebhookOwners(tx, ctx.tenant.id, ownerIds);
            const taskAssigneeIds = webhookTaskAssigneeIdsFor(
              data.events,
              data.taskAssigneeIds,
              null,
            );
            await assertWebhookTaskAssignees(tx, ctx.tenant.id, taskAssigneeIds);
            const taskPipelineIds = webhookTaskPipelineIdsFor(
              data.events,
              data.taskPipelineIds,
              null,
            );
            await assertWebhookTaskPipelines(tx, ctx.tenant.id, taskPipelineIds);
            const taskStageIds = webhookTaskStageIdsFor(data.events, data.taskStageIds, null);
            await assertWebhookTaskStages(tx, ctx.tenant.id, taskStageIds);
            const taskDealOwnerIds = webhookTaskDealOwnerIdsFor(
              data.events,
              data.taskDealOwnerIds,
              null,
            );
            await assertWebhookTaskDealOwners(tx, ctx.tenant.id, taskDealOwnerIds);
            const notePipelineIds = webhookNotePipelineIdsFor(
              data.events,
              data.notePipelineIds,
              null,
            );
            await assertWebhookNotePipelines(tx, ctx.tenant.id, notePipelineIds);
            const noteStageIds = webhookNoteStageIdsFor(data.events, data.noteStageIds, null);
            await assertWebhookNoteStages(tx, ctx.tenant.id, noteStageIds);
            const noteDealOwnerIds = webhookNoteDealOwnerIdsFor(
              data.events,
              data.noteDealOwnerIds,
              null,
            );
            await assertWebhookNoteDealOwners(tx, ctx.tenant.id, noteDealOwnerIds);
            const crmChangeMakers = webhookCrmChangeMakersFor(
              data.events,
              data.crmChangeMakers,
              null,
            );
            const crmExcludedApiKeyIds = webhookCrmExcludedApiKeyIdsFor(
              data.events,
              data.crmExcludedApiKeyIds,
              null,
            );
            await assertWebhookCrmExcludedApiKeys(tx, ctx.tenant.id, crmExcludedApiKeyIds);
            const surveyScores = webhookSurveyScoresFor(data.events, data.surveyScores, null);
            const surveyAssigneeIds = webhookSurveyAssigneeIdsFor(
              data.events,
              data.surveyAssigneeIds,
              null,
            );
            await assertWebhookSurveyAssignees(tx, ctx.tenant.id, surveyAssigneeIds);
            const surveyTeamIds = webhookSurveyTeamIdsFor(data.events, data.surveyTeamIds, null);
            await assertWebhookSurveyTeams(tx, ctx.tenant.id, surveyTeamIds);
            const surveyContactTags = webhookSurveyContactTagsFor(
              data.events,
              data.surveyContactTags,
              null,
            );
            const surveyConversationTags = webhookSurveyConversationTagsFor(
              data.events,
              data.surveyConversationTags,
              null,
            );
            const contactEventTags = webhookContactEventTagsFor(
              data.events,
              data.contactEventTags,
              null,
            );
            // Each value read by its field's type, so the database compares like with like
            // (ADR-332).
            const contactEventFieldValues = await webhookContactEventFieldValuesChecked(
              tx,
              ctx.tenant.id,
              webhookContactEventFieldValuesFor(data.events, data.contactEventFieldValues, null),
            );
            const assigneeIds = webhookAssigneeIdsFor(data.events, data.assigneeIds, null);
            await assertWebhookAssignees(tx, ctx.tenant.id, assigneeIds);
            const contactTags = webhookContactTagsFor(data.events, data.contactTags, null);
            const conversationTags = webhookConversationTagsFor(
              data.events,
              data.conversationTags,
              null,
            );
            const { id, secret } = await insertWebhookEndpoint(tx, deps.keyring, ctx.tenant.id, {
              url,
              description: data.description || null,
              eventTypes: data.events,
              headers,
              messageStatuses,
              messageSenders,
              messageApiKeyIds,
              contactParts,
              contactFieldKeys,
              automationIds,
              campaignStatuses,
              orderStatuses,
              paymentLinkStatuses,
              codAnswers,
              storeIds,
              orderMessageEvents,
              orderMessageSkipReasons,
              cartReminders,
              cartReminderSkipReasons,
              campaignSkipReasons,
              orderChangeMakers,
              runStepOutcomes,
              runStepNodeTypes,
              orderExcludedApiKeyIds,
              paymentLinkApiKeyIds,
              dealStatuses,
              taskStatuses,
              dealDetails,
              taskDetails,
              templateStatuses,
              conversationStatuses,
              runEndStatuses,
              runTriggers,
              runApiKeyIds,
              consentChanges,
              contactSources,
              messageTypes,
              messageWords,
              runEndReasons,
              channelAccountIds: channelIds,
              teamIds,
              templateIds,
              campaignIds,
              pipelineIds,
              stageIds,
              ownerIds,
              taskAssigneeIds,
              taskPipelineIds,
              taskStageIds,
              taskDealOwnerIds,
              notePipelineIds,
              noteStageIds,
              noteDealOwnerIds,
              crmChangeMakers,
              crmExcludedApiKeyIds,
              surveyScores,
              surveyAssigneeIds,
              surveyTeamIds,
              surveyContactTags,
              surveyConversationTags,
              contactEventTags,
              contactEventFieldValues,
              assigneeIds,
              contactTags,
              conversationTags,
              oauth,
              creator: { apiKeyId: ctx.key.id },
            });
            await audit(tx, ctx, 'webhook.endpoint_created', id, {
              host,
              eventTypes: data.events,
              ...(headers.length > 0 ? { headers: headers.map((h) => h.name) } : {}),
              ...(messageStatuses ? { messageStatuses } : {}),
              ...(messageSenders ? { messageSenders } : {}),
              ...(messageApiKeyIds ? { messageApiKeyIds } : {}),
              ...(contactParts ? { contactParts } : {}),
              ...(contactFieldKeys ? { contactFieldKeys } : {}),
              ...(automationIds ? { automationIds } : {}),
              ...(campaignStatuses ? { campaignStatuses } : {}),
              ...(orderStatuses ? { orderStatuses } : {}),
              ...(paymentLinkStatuses ? { paymentLinkStatuses } : {}),
              ...(runStepOutcomes ? { runStepOutcomes } : {}),
              ...(codAnswers ? { codAnswers } : {}),
              ...(storeIds ? { storeIds } : {}),
              ...(orderMessageEvents ? { orderMessageEvents } : {}),
              ...(orderMessageSkipReasons ? { orderMessageSkipReasons } : {}),
              ...(cartReminders ? { cartReminders } : {}),
              ...(cartReminderSkipReasons ? { cartReminderSkipReasons } : {}),
              ...(campaignSkipReasons ? { campaignSkipReasons } : {}),
              ...(runStepNodeTypes ? { runStepNodeTypes } : {}),
              ...(orderChangeMakers ? { orderChangeMakers } : {}),
              ...(orderExcludedApiKeyIds ? { orderExcludedApiKeyIds } : {}),
              ...(paymentLinkApiKeyIds ? { paymentLinkApiKeyIds } : {}),
              ...(dealStatuses ? { dealStatuses } : {}),
              ...(taskStatuses ? { taskStatuses } : {}),
              ...(dealDetails ? { dealDetails } : {}),
              ...(taskDetails ? { taskDetails } : {}),
              ...(templateStatuses ? { templateStatuses } : {}),
              ...(conversationStatuses ? { conversationStatuses } : {}),
              ...(runEndStatuses ? { runEndStatuses } : {}),
              ...(runTriggers ? { runTriggers } : {}),
              ...(runApiKeyIds ? { runApiKeyIds } : {}),
              ...(consentChanges ? { consentChanges } : {}),
              ...(contactSources ? { contactSources } : {}),
              ...(messageTypes ? { messageTypes } : {}),
              ...(messageWords ? { messageWords } : {}),
              ...(runEndReasons ? { runEndReasons } : {}),
              ...(channelIds ? { channelIds } : {}),
              ...(teamIds ? { teamIds } : {}),
              ...(templateIds ? { templateIds } : {}),
              ...(campaignIds ? { campaignIds } : {}),
              ...(pipelineIds ? { pipelineIds } : {}),
              ...(stageIds ? { stageIds } : {}),
              ...(ownerIds ? { ownerIds } : {}),
              ...(taskAssigneeIds ? { taskAssigneeIds } : {}),
              ...(taskPipelineIds ? { taskPipelineIds } : {}),
              ...(taskStageIds ? { taskStageIds } : {}),
              ...(taskDealOwnerIds ? { taskDealOwnerIds } : {}),
              ...(notePipelineIds ? { notePipelineIds } : {}),
              ...(noteStageIds ? { noteStageIds } : {}),
              ...(noteDealOwnerIds ? { noteDealOwnerIds } : {}),
              ...(crmChangeMakers ? { crmChangeMakers } : {}),
              ...(crmExcludedApiKeyIds ? { crmExcludedApiKeyIds } : {}),
              ...(surveyScores ? { surveyScores } : {}),
              ...(surveyAssigneeIds ? { surveyAssigneeIds } : {}),
              ...(surveyTeamIds ? { surveyTeamIds } : {}),
              ...(surveyContactTags ? { surveyContactTags } : {}),
              ...(surveyConversationTags ? { surveyConversationTags } : {}),
              ...(contactEventTags ? { contactEventTags } : {}),
              ...(contactEventFieldValues ? { contactEventFieldValues } : {}),
              ...(assigneeIds ? { assigneeIds } : {}),
              ...(contactTags ? { contactTags } : {}),
              ...(conversationTags ? { conversationTags } : {}),
              ...(oauth
                ? {
                    oauthTokenHost: oauth.host,
                    ...webhookOAuthClientAuthAudit(oauth, NO_WEBHOOK_OAUTH),
                  }
                : {}),
            });
            await announce(tx, ctx, { host, events: data.events, at: now });
            const endpoint = await readEndpoint(tx, ctx, id, now);
            return { status: 201, body: { data: { ...endpoint, secret } } };
          },
          withoutSecret,
        ),
      );
    },

    /**
     * PATCH /api/v1/webhook-endpoints/{id}: its events, description or whether it is enabled. The
     * address cannot change: a new address is a new endpoint, announced to owners and admins.
     */
    async update(ctx: ApiContext, id: string, input: unknown): Promise<ApiWebhookEndpoint> {
      assertScope(ctx, 'webhooks.manage');
      endpointId(id);
      const data = parseInput(apiUpdateWebhookEndpointSchema, input);
      const now = clock.now();
      return db.run(ctx.scope, async (tx) => {
        const endpoint = await lockWebhookEndpoint(tx, ctx.tenant.id, id, 'no key update', {
          keysOnly: true,
        });
        const host = webhookHost(endpoint.url);
        const events = data.events ?? endpoint.eventTypes;
        if (data.messageStatuses && !events.includes('message.status')) throw invalidStatuses();
        if (data.messageSenders && !events.includes('message.status')) throw invalidSenders();
        if (data.messageApiKeyIds && !events.includes('message.status')) {
          throw invalidMessageApiKeys();
        }
        if (data.contactParts && !events.includes('contact.updated')) throw invalidParts();
        // Fields narrow field changes only, given the parts the endpoint keeps (ADR-184).
        const parts = webhookContactPartsFor(events, data.contactParts, endpoint.contactParts);
        if (data.contactFieldKeys && !webhookTakesFieldChanges(events, parts)) {
          throw webhookFieldsNeedThePart();
        }
        if (data.automationIds && !webhookTakesAutomationRuns(events)) throw invalidAutomations();
        if (data.campaignStatuses && !events.includes('campaign.status_changed')) {
          throw invalidCampaignStatuses();
        }
        if (data.orderStatuses && !events.includes('order.status_changed')) {
          throw invalidOrderStatuses();
        }
        if (data.paymentLinkStatuses && !events.includes('payment_link.status_changed')) {
          throw invalidPaymentLinkStatuses();
        }
        if (data.runStepOutcomes && !events.includes('automation.run_step')) {
          throw invalidRunStepOutcomes();
        }
        if (data.codAnswers && !events.includes('store_order.cod_answered')) {
          throw invalidCodAnswers();
        }
        if (data.storeIds && !webhookTakesStoreEvents(events)) {
          throw invalidStores();
        }
        if (data.orderMessageEvents && !webhookTakesOrderMessages(events)) {
          throw invalidOrderMessageEvents();
        }
        if (data.orderMessageSkipReasons && !events.includes('store_order.message_skipped')) {
          throw invalidOrderMessageSkipReasons();
        }
        if (data.cartReminders && !webhookTakesCartReminders(events)) {
          throw invalidCartReminders();
        }
        if (data.cartReminderSkipReasons && !events.includes('store_checkout.reminder_skipped')) {
          throw invalidCartReminderSkipReasons();
        }
        if (data.campaignSkipReasons && !events.includes('campaign.recipient_skipped')) {
          throw invalidCampaignSkipReasons();
        }
        if (data.runStepNodeTypes && !events.includes('automation.run_step')) {
          throw invalidRunStepNodeTypes();
        }
        if (data.orderChangeMakers && !events.includes('order.status_changed')) {
          throw invalidOrderChangeMakers();
        }
        if (data.orderExcludedApiKeyIds && !events.includes('order.status_changed')) {
          throw invalidOrderExcludedApiKeys();
        }
        if (data.paymentLinkApiKeyIds && !events.includes('payment_link.status_changed')) {
          throw invalidPaymentLinkApiKeys();
        }
        if (data.dealStatuses && !events.includes('deal.status_changed')) {
          throw invalidDealStatuses();
        }
        if (data.taskStatuses && !events.includes('task.status_changed')) {
          throw invalidTaskStatuses();
        }
        if (data.dealDetails && !events.includes('deal.updated')) throw invalidDealDetails();
        if (data.taskDetails && !events.includes('task.updated')) throw invalidTaskDetails();
        if (data.templateStatuses && !events.includes('template.status_changed')) {
          throw invalidTemplateStatuses();
        }
        if (data.conversationStatuses && !events.includes('conversation.status_changed')) {
          throw invalidConversationStatuses();
        }
        if (data.runEndStatuses && !events.includes('automation.run_ended')) {
          throw invalidRunEndStatuses();
        }
        if (data.runTriggers && !webhookTakesAutomationRuns(events)) throw invalidRunTriggers();
        if (data.runApiKeyIds && !webhookTakesAutomationRuns(events)) throw invalidRunApiKeys();
        if (data.consentChanges && !events.includes('consent.changed')) {
          throw invalidConsentChanges();
        }
        if (data.contactSources && !events.includes('contact.created')) {
          throw invalidContactSources();
        }
        if (data.messageTypes && !events.includes('message.received')) {
          throw invalidMessageTypes();
        }
        if (data.messageWords && !events.includes('message.received')) {
          throw invalidMessageWords();
        }
        if (data.runEndReasons && !events.includes('automation.run_ended')) {
          throw invalidRunEndReasons();
        }
        // End reasons narrow the ends the endpoint keeps, and only those (ADR-192).
        const ends = webhookRunEndStatusesFor(events, data.runEndStatuses, endpoint.runEndStatuses);
        if (data.runEndReasons?.some((reason) => !webhookRunEndTakesReason(ends, reason))) {
          throw webhookRunEndReasonsNeedTheEnds();
        }
        if (data.channelIds && !webhookTakesChannelEvents(events)) throw invalidChannels();
        if (data.teamIds && !webhookTakesTeamEvents(events)) throw invalidTeams();
        if (data.templateIds && !webhookTakesTemplateEvents(events)) throw invalidTemplates();
        if (data.campaignIds && !webhookTakesCampaignEvents(events)) throw invalidCampaigns();
        if (data.pipelineIds && !webhookTakesPipelineEvents(events)) throw invalidPipelines();
        if (data.stageIds && !webhookTakesPipelineEvents(events)) throw invalidStages();
        if (data.ownerIds && !webhookTakesPipelineEvents(events)) throw invalidOwners();
        if (data.taskAssigneeIds && !webhookTakesTaskEvents(events)) throw invalidTaskAssignees();
        if (data.taskPipelineIds && !webhookTakesTaskEvents(events)) throw invalidTaskPipelines();
        if (data.taskStageIds && !webhookTakesTaskEvents(events)) throw invalidTaskStages();
        if (data.taskDealOwnerIds && !webhookTakesTaskEvents(events)) throw invalidTaskDealOwners();
        if (data.notePipelineIds && !webhookTakesNoteEvents(events)) throw invalidNotePipelines();
        if (data.noteStageIds && !webhookTakesNoteEvents(events)) throw invalidNoteStages();
        if (data.noteDealOwnerIds && !webhookTakesNoteEvents(events)) throw invalidNoteDealOwners();
        if (data.crmChangeMakers && !webhookTakesCrmChanges(events)) throw invalidCrmChangeMakers();
        if (data.crmExcludedApiKeyIds && !webhookTakesCrmChanges(events)) {
          throw invalidCrmExcludedApiKeys();
        }
        if (data.surveyScores && !events.includes('satisfaction_survey.answered')) {
          throw invalidSurveyScores();
        }
        if (data.surveyAssigneeIds && !events.includes('satisfaction_survey.answered')) {
          throw invalidSurveyAssignees();
        }
        if (data.surveyTeamIds && !events.includes('satisfaction_survey.answered')) {
          throw invalidSurveyTeams();
        }
        if (data.surveyContactTags && !events.includes('satisfaction_survey.answered')) {
          throw invalidSurveyContactTags();
        }
        if (data.surveyConversationTags && !events.includes('satisfaction_survey.answered')) {
          throw invalidSurveyConversationTags();
        }
        if (
          data.contactEventTags &&
          !events.includes('contact.created') &&
          !events.includes('contact.updated')
        ) {
          throw invalidContactEventTags();
        }
        if (
          data.contactEventFieldValues &&
          !events.includes('contact.created') &&
          !events.includes('contact.updated')
        ) {
          throw invalidContactEventFieldValues();
        }
        if (data.assigneeIds && !webhookTakesTeamEvents(events)) throw invalidAssignees();
        if (data.contactTags && !webhookTakesTeamEvents(events)) throw invalidContactTags();
        if (data.conversationTags && !webhookTakesTeamEvents(events)) {
          throw invalidConversationTags();
        }
        // Only a list given now is checked: the automations kept were checked when chosen.
        if (data.automationIds !== undefined) {
          await assertWebhookAutomations(tx, ctx.tenant.id, data.automationIds);
        }
        // And the API keys likewise (ADR-319).
        if (data.runApiKeyIds !== undefined) {
          await assertWebhookRunApiKeys(tx, ctx.tenant.id, data.runApiKeyIds);
        }
        // And those for messages (ADR-320).
        if (data.messageApiKeyIds !== undefined) {
          await assertWebhookMessageApiKeys(tx, ctx.tenant.id, data.messageApiKeyIds);
        }
        // And those left out of CRM changes (ADR-321).
        if (data.crmExcludedApiKeyIds !== undefined) {
          await assertWebhookCrmExcludedApiKeys(tx, ctx.tenant.id, data.crmExcludedApiKeyIds);
        }
        // And those left out of order changes (ADR-323).
        if (data.orderExcludedApiKeyIds !== undefined) {
          await assertWebhookOrderExcludedApiKeys(tx, ctx.tenant.id, data.orderExcludedApiKeyIds);
        }
        // And those for Payment Links (ADR-324).
        if (data.paymentLinkApiKeyIds !== undefined) {
          await assertWebhookPaymentLinkApiKeys(tx, ctx.tenant.id, data.paymentLinkApiKeyIds);
        }
        // And the numbers likewise (ADR-170).
        if (data.channelIds !== undefined) {
          await assertWebhookChannels(tx, ctx.tenant.id, data.channelIds);
        }
        // And the teams it adds: those it held may have been deleted since (ADR-174).
        if (data.teamIds !== undefined) {
          await assertWebhookTeams(tx, ctx.tenant.id, data.teamIds, endpoint.teamIds);
        }
        // And the fields it adds likewise (ADR-184).
        if (data.contactFieldKeys !== undefined) {
          await assertWebhookContactFields(
            tx,
            ctx.tenant.id,
            data.contactFieldKeys,
            endpoint.contactFieldKeys,
          );
        }
        // And the templates given now (ADR-175).
        if (data.templateIds !== undefined) {
          await assertWebhookTemplates(tx, ctx.tenant.id, data.templateIds);
        }
        // And the campaigns given now (ADR-185).
        if (data.campaignIds !== undefined) {
          await assertWebhookCampaigns(tx, ctx.tenant.id, data.campaignIds);
        }
        // And the stores a list given now adds (ADR-349): those it held may have been removed.
        if (data.storeIds !== undefined) {
          await assertWebhookStores(tx, ctx.tenant.id, data.storeIds, endpoint.storeIds);
        }
        // And the pipelines given now (ADR-263).
        if (data.pipelineIds !== undefined) {
          await assertWebhookPipelines(tx, ctx.tenant.id, data.pipelineIds);
        }
        // And the stages given now (ADR-264).
        if (data.stageIds !== undefined) {
          await assertWebhookStages(tx, ctx.tenant.id, data.stageIds);
        }
        // And the owners it adds: those it held may have left since (ADR-265).
        if (data.ownerIds !== undefined) {
          await assertWebhookOwners(tx, ctx.tenant.id, data.ownerIds, endpoint.ownerIds);
        }
        // And the assignees it adds: those it held may have left since (ADR-266).
        if (data.taskAssigneeIds !== undefined) {
          await assertWebhookTaskAssignees(
            tx,
            ctx.tenant.id,
            data.taskAssigneeIds,
            endpoint.taskAssigneeIds,
          );
        }
        // And the pipelines of tasks' deals given now (ADR-303), and their stages (ADR-304).
        if (data.taskPipelineIds !== undefined) {
          await assertWebhookTaskPipelines(tx, ctx.tenant.id, data.taskPipelineIds);
        }
        if (data.taskStageIds !== undefined) {
          await assertWebhookTaskStages(tx, ctx.tenant.id, data.taskStageIds);
        }
        // And the owners of tasks' deals it adds: those it held may have left since (ADR-304).
        if (data.taskDealOwnerIds !== undefined) {
          await assertWebhookTaskDealOwners(
            tx,
            ctx.tenant.id,
            data.taskDealOwnerIds,
            endpoint.taskDealOwnerIds,
          );
        }
        // And the pipelines, stages and owners of notes' deals given now (ADR-305): owners it held
        // may have left since.
        if (data.notePipelineIds !== undefined) {
          await assertWebhookNotePipelines(tx, ctx.tenant.id, data.notePipelineIds);
        }
        if (data.noteStageIds !== undefined) {
          await assertWebhookNoteStages(tx, ctx.tenant.id, data.noteStageIds);
        }
        if (data.noteDealOwnerIds !== undefined) {
          await assertWebhookNoteDealOwners(
            tx,
            ctx.tenant.id,
            data.noteDealOwnerIds,
            endpoint.noteDealOwnerIds,
          );
        }
        // And the members it adds: those it held may no longer take conversations (ADR-181).
        if (data.assigneeIds !== undefined) {
          await assertWebhookAssignees(tx, ctx.tenant.id, data.assigneeIds, endpoint.assigneeIds);
        }
        // And the members and teams of survey answers it adds: those it held may have left or been
        // deleted since (ADR-311).
        if (data.surveyAssigneeIds !== undefined) {
          await assertWebhookSurveyAssignees(
            tx,
            ctx.tenant.id,
            data.surveyAssigneeIds,
            endpoint.surveyAssigneeIds,
          );
        }
        if (data.surveyTeamIds !== undefined) {
          await assertWebhookSurveyTeams(
            tx,
            ctx.tenant.id,
            data.surveyTeamIds,
            endpoint.surveyTeamIds,
          );
        }
        // The field values it keeps, each one it adds read by its field's type (ADR-332).
        const contactEventFieldValues = await webhookContactEventFieldValuesChecked(
          tx,
          ctx.tenant.id,
          webhookContactEventFieldValuesFor(
            events,
            data.contactEventFieldValues,
            endpoint.contactEventFieldValues,
          ),
          endpoint.contactEventFieldValues,
        );
        // Left out, the OAuth client stays as it is (ADR-173).
        const oauth = data.oauth
          ? checkedWebhookOAuth(data.oauth, endpoint, deps.egressPolicy)
          : data.oauth;
        assertWebhookAuthorization(
          data.headers ? data.headers.map((h) => h.name) : endpoint.headerNames,
          oauth === undefined ? endpoint.oauthTokenUrl !== null : oauth !== null,
          data.headers,
        );
        if (
          data.events !== undefined ||
          data.description !== undefined ||
          data.headers !== undefined ||
          data.messageStatuses !== undefined ||
          data.messageSenders !== undefined ||
          data.messageApiKeyIds !== undefined ||
          data.contactParts !== undefined ||
          data.contactFieldKeys !== undefined ||
          data.automationIds !== undefined ||
          data.campaignStatuses !== undefined ||
          data.orderStatuses !== undefined ||
          data.paymentLinkStatuses !== undefined ||
          data.codAnswers !== undefined ||
          data.storeIds !== undefined ||
          data.orderMessageEvents !== undefined ||
          data.orderMessageSkipReasons !== undefined ||
          data.cartReminders !== undefined ||
          data.cartReminderSkipReasons !== undefined ||
          data.campaignSkipReasons !== undefined ||
          data.runStepOutcomes !== undefined ||
          data.runStepNodeTypes !== undefined ||
          data.orderChangeMakers !== undefined ||
          data.orderExcludedApiKeyIds !== undefined ||
          data.paymentLinkApiKeyIds !== undefined ||
          data.dealStatuses !== undefined ||
          data.taskStatuses !== undefined ||
          data.dealDetails !== undefined ||
          data.taskDetails !== undefined ||
          data.templateStatuses !== undefined ||
          data.conversationStatuses !== undefined ||
          data.runEndStatuses !== undefined ||
          data.runTriggers !== undefined ||
          data.runApiKeyIds !== undefined ||
          data.consentChanges !== undefined ||
          data.contactSources !== undefined ||
          data.messageTypes !== undefined ||
          data.messageWords !== undefined ||
          data.runEndReasons !== undefined ||
          data.channelIds !== undefined ||
          data.teamIds !== undefined ||
          data.templateIds !== undefined ||
          data.campaignIds !== undefined ||
          data.pipelineIds !== undefined ||
          data.stageIds !== undefined ||
          data.ownerIds !== undefined ||
          data.taskAssigneeIds !== undefined ||
          data.taskPipelineIds !== undefined ||
          data.taskStageIds !== undefined ||
          data.taskDealOwnerIds !== undefined ||
          data.notePipelineIds !== undefined ||
          data.noteStageIds !== undefined ||
          data.noteDealOwnerIds !== undefined ||
          data.crmChangeMakers !== undefined ||
          data.crmExcludedApiKeyIds !== undefined ||
          data.surveyScores !== undefined ||
          data.surveyAssigneeIds !== undefined ||
          data.surveyTeamIds !== undefined ||
          data.surveyContactTags !== undefined ||
          data.surveyConversationTags !== undefined ||
          data.contactEventTags !== undefined ||
          data.contactEventFieldValues !== undefined ||
          data.assigneeIds !== undefined ||
          data.contactTags !== undefined ||
          data.conversationTags !== undefined ||
          oauth !== undefined
        ) {
          const [changed] = await tx
            .update(webhookEndpoints)
            .set({
              ...(data.events !== undefined ? { eventTypes: data.events } : {}),
              ...(data.description !== undefined ? { description: data.description || null } : {}),
              ...(data.headers !== undefined
                ? sealWebhookHeaders(deps.keyring, ctx.tenant.id, id, data.headers)
                : {}),
              ...(oauth !== undefined
                ? webhookOAuthColumns(deps.keyring, ctx.tenant.id, id, oauth, endpoint)
                : {}),
              messageStatuses: webhookMessageStatusesFor(
                events,
                data.messageStatuses,
                endpoint.messageStatuses,
              ),
              messageSenders: webhookMessageSendersFor(
                events,
                data.messageSenders,
                endpoint.messageSenders,
              ),
              messageApiKeyIds: webhookMessageApiKeyIdsFor(
                events,
                data.messageApiKeyIds,
                endpoint.messageApiKeyIds,
              ),
              contactParts: parts,
              contactFieldKeys: webhookContactFieldKeysFor(
                events,
                parts,
                data.contactFieldKeys,
                endpoint.contactFieldKeys,
              ),
              automationIds: webhookAutomationIdsFor(
                events,
                data.automationIds,
                endpoint.automationIds,
              ),
              campaignStatuses: webhookCampaignStatusesFor(
                events,
                data.campaignStatuses,
                endpoint.campaignStatuses,
              ),
              orderStatuses: webhookOrderStatusesFor(
                events,
                data.orderStatuses,
                endpoint.orderStatuses,
              ),
              paymentLinkStatuses: webhookPaymentLinkStatusesFor(
                events,
                data.paymentLinkStatuses,
                endpoint.paymentLinkStatuses,
              ),
              codAnswers: webhookCodAnswersFor(events, data.codAnswers, endpoint.codAnswers),
              storeIds: webhookStoreIdsFor(events, data.storeIds, endpoint.storeIds),
              orderMessageEvents: webhookOrderMessageEventsFor(
                events,
                data.orderMessageEvents,
                endpoint.orderMessageEvents,
              ),
              orderMessageSkipReasons: webhookOrderMessageSkipReasonsFor(
                events,
                data.orderMessageSkipReasons,
                endpoint.orderMessageSkipReasons,
              ),
              cartReminders: webhookCartRemindersFor(
                events,
                data.cartReminders,
                endpoint.cartReminders,
              ),
              cartReminderSkipReasons: webhookCartReminderSkipReasonsFor(
                events,
                data.cartReminderSkipReasons,
                endpoint.cartReminderSkipReasons,
              ),
              campaignSkipReasons: webhookCampaignSkipReasonsFor(
                events,
                data.campaignSkipReasons,
                endpoint.campaignSkipReasons,
              ),
              runStepOutcomes: webhookRunStepOutcomesFor(
                events,
                data.runStepOutcomes,
                endpoint.runStepOutcomes,
              ),
              runStepNodeTypes: webhookRunStepNodeTypesFor(
                events,
                data.runStepNodeTypes,
                endpoint.runStepNodeTypes,
              ),
              orderChangeMakers: webhookOrderChangeMakersFor(
                events,
                data.orderChangeMakers,
                endpoint.orderChangeMakers,
              ),
              orderExcludedApiKeyIds: webhookOrderExcludedApiKeyIdsFor(
                events,
                data.orderExcludedApiKeyIds,
                endpoint.orderExcludedApiKeyIds,
              ),
              paymentLinkApiKeyIds: webhookPaymentLinkApiKeyIdsFor(
                events,
                data.paymentLinkApiKeyIds,
                endpoint.paymentLinkApiKeyIds,
              ),
              dealStatuses: webhookDealStatusesFor(
                events,
                data.dealStatuses,
                endpoint.dealStatuses,
              ),
              taskStatuses: webhookTaskStatusesFor(
                events,
                data.taskStatuses,
                endpoint.taskStatuses,
              ),
              dealDetails: webhookDealDetailsFor(events, data.dealDetails, endpoint.dealDetails),
              taskDetails: webhookTaskDetailsFor(events, data.taskDetails, endpoint.taskDetails),
              templateStatuses: webhookTemplateStatusesFor(
                events,
                data.templateStatuses,
                endpoint.templateStatuses,
              ),
              conversationStatuses: webhookConversationStatusesFor(
                events,
                data.conversationStatuses,
                endpoint.conversationStatuses,
              ),
              runEndStatuses: ends,
              runTriggers: webhookRunTriggersFor(events, data.runTriggers, endpoint.runTriggers),
              runApiKeyIds: webhookRunApiKeyIdsFor(
                events,
                data.runApiKeyIds,
                endpoint.runApiKeyIds,
              ),
              consentChanges: webhookConsentChangesFor(
                events,
                data.consentChanges,
                endpoint.consentChanges,
              ),
              contactSources: webhookContactSourcesFor(
                events,
                data.contactSources,
                endpoint.contactSources,
              ),
              messageTypes: webhookMessageTypesFor(
                events,
                data.messageTypes,
                endpoint.messageTypes,
              ),
              messageWords: webhookMessageWordsFor(
                events,
                data.messageWords,
                endpoint.messageWords,
              ),
              runEndReasons: webhookRunEndReasonsFor(
                events,
                ends,
                data.runEndReasons,
                endpoint.runEndReasons,
              ),
              channelAccountIds: webhookChannelIdsFor(
                events,
                data.channelIds,
                endpoint.channelAccountIds,
              ),
              teamIds: webhookTeamIdsFor(events, data.teamIds, endpoint.teamIds),
              templateIds: webhookTemplateIdsFor(events, data.templateIds, endpoint.templateIds),
              campaignIds: webhookCampaignIdsFor(events, data.campaignIds, endpoint.campaignIds),
              pipelineIds: webhookPipelineIdsFor(events, data.pipelineIds, endpoint.pipelineIds),
              stageIds: webhookStageIdsFor(events, data.stageIds, endpoint.stageIds),
              ownerIds: webhookOwnerIdsFor(events, data.ownerIds, endpoint.ownerIds),
              taskAssigneeIds: webhookTaskAssigneeIdsFor(
                events,
                data.taskAssigneeIds,
                endpoint.taskAssigneeIds,
              ),
              taskPipelineIds: webhookTaskPipelineIdsFor(
                events,
                data.taskPipelineIds,
                endpoint.taskPipelineIds,
              ),
              taskStageIds: webhookTaskStageIdsFor(
                events,
                data.taskStageIds,
                endpoint.taskStageIds,
              ),
              taskDealOwnerIds: webhookTaskDealOwnerIdsFor(
                events,
                data.taskDealOwnerIds,
                endpoint.taskDealOwnerIds,
              ),
              notePipelineIds: webhookNotePipelineIdsFor(
                events,
                data.notePipelineIds,
                endpoint.notePipelineIds,
              ),
              noteStageIds: webhookNoteStageIdsFor(
                events,
                data.noteStageIds,
                endpoint.noteStageIds,
              ),
              noteDealOwnerIds: webhookNoteDealOwnerIdsFor(
                events,
                data.noteDealOwnerIds,
                endpoint.noteDealOwnerIds,
              ),
              crmChangeMakers: webhookCrmChangeMakersFor(
                events,
                data.crmChangeMakers,
                endpoint.crmChangeMakers,
              ),
              crmExcludedApiKeyIds: webhookCrmExcludedApiKeyIdsFor(
                events,
                data.crmExcludedApiKeyIds,
                endpoint.crmExcludedApiKeyIds,
              ),
              surveyScores: webhookSurveyScoresFor(
                events,
                data.surveyScores,
                endpoint.surveyScores,
              ),
              surveyAssigneeIds: webhookSurveyAssigneeIdsFor(
                events,
                data.surveyAssigneeIds,
                endpoint.surveyAssigneeIds,
              ),
              surveyTeamIds: webhookSurveyTeamIdsFor(
                events,
                data.surveyTeamIds,
                endpoint.surveyTeamIds,
              ),
              surveyContactTags: webhookSurveyContactTagsFor(
                events,
                data.surveyContactTags,
                endpoint.surveyContactTags,
              ),
              surveyConversationTags: webhookSurveyConversationTagsFor(
                events,
                data.surveyConversationTags,
                endpoint.surveyConversationTags,
              ),
              contactEventTags: webhookContactEventTagsFor(
                events,
                data.contactEventTags,
                endpoint.contactEventTags,
              ),
              contactEventFieldValues,
              assigneeIds: webhookAssigneeIdsFor(events, data.assigneeIds, endpoint.assigneeIds),
              contactTags: webhookContactTagsFor(events, data.contactTags, endpoint.contactTags),
              conversationTags: webhookConversationTagsFor(
                events,
                data.conversationTags,
                endpoint.conversationTags,
              ),
              updatedAt: now,
            })
            .where(and(eq(webhookEndpoints.tenantId, ctx.tenant.id), eq(webhookEndpoints.id, id)))
            .returning({
              eventTypes: webhookEndpoints.eventTypes,
              messageStatuses: webhookEndpoints.messageStatuses,
              messageSenders: webhookEndpoints.messageSenders,
              messageApiKeyIds: webhookEndpoints.messageApiKeyIds,
              contactParts: webhookEndpoints.contactParts,
              contactFieldKeys: webhookEndpoints.contactFieldKeys,
              automationIds: webhookEndpoints.automationIds,
              campaignStatuses: webhookEndpoints.campaignStatuses,
              orderStatuses: webhookEndpoints.orderStatuses,
              paymentLinkStatuses: webhookEndpoints.paymentLinkStatuses,
              codAnswers: webhookEndpoints.codAnswers,
              storeIds: webhookEndpoints.storeIds,
              orderMessageEvents: webhookEndpoints.orderMessageEvents,
              orderMessageSkipReasons: webhookEndpoints.orderMessageSkipReasons,
              cartReminders: webhookEndpoints.cartReminders,
              cartReminderSkipReasons: webhookEndpoints.cartReminderSkipReasons,
              campaignSkipReasons: webhookEndpoints.campaignSkipReasons,
              runStepOutcomes: webhookEndpoints.runStepOutcomes,
              runStepNodeTypes: webhookEndpoints.runStepNodeTypes,
              orderChangeMakers: webhookEndpoints.orderChangeMakers,
              orderExcludedApiKeyIds: webhookEndpoints.orderExcludedApiKeyIds,
              paymentLinkApiKeyIds: webhookEndpoints.paymentLinkApiKeyIds,
              dealStatuses: webhookEndpoints.dealStatuses,
              taskStatuses: webhookEndpoints.taskStatuses,
              dealDetails: webhookEndpoints.dealDetails,
              taskDetails: webhookEndpoints.taskDetails,
              templateStatuses: webhookEndpoints.templateStatuses,
              conversationStatuses: webhookEndpoints.conversationStatuses,
              runEndStatuses: webhookEndpoints.runEndStatuses,
              runTriggers: webhookEndpoints.runTriggers,
              runApiKeyIds: webhookEndpoints.runApiKeyIds,
              consentChanges: webhookEndpoints.consentChanges,
              contactSources: webhookEndpoints.contactSources,
              messageTypes: webhookEndpoints.messageTypes,
              messageWords: webhookEndpoints.messageWords,
              runEndReasons: webhookEndpoints.runEndReasons,
              channelAccountIds: webhookEndpoints.channelAccountIds,
              teamIds: webhookEndpoints.teamIds,
              templateIds: webhookEndpoints.templateIds,
              campaignIds: webhookEndpoints.campaignIds,
              pipelineIds: webhookEndpoints.pipelineIds,
              stageIds: webhookEndpoints.stageIds,
              ownerIds: webhookEndpoints.ownerIds,
              taskAssigneeIds: webhookEndpoints.taskAssigneeIds,
              taskPipelineIds: webhookEndpoints.taskPipelineIds,
              taskStageIds: webhookEndpoints.taskStageIds,
              taskDealOwnerIds: webhookEndpoints.taskDealOwnerIds,
              notePipelineIds: webhookEndpoints.notePipelineIds,
              noteStageIds: webhookEndpoints.noteStageIds,
              noteDealOwnerIds: webhookEndpoints.noteDealOwnerIds,
              crmChangeMakers: webhookEndpoints.crmChangeMakers,
              crmExcludedApiKeyIds: webhookEndpoints.crmExcludedApiKeyIds,
              surveyScores: webhookEndpoints.surveyScores,
              surveyAssigneeIds: webhookEndpoints.surveyAssigneeIds,
              surveyTeamIds: webhookEndpoints.surveyTeamIds,
              surveyContactTags: webhookEndpoints.surveyContactTags,
              surveyConversationTags: webhookEndpoints.surveyConversationTags,
              contactEventTags: webhookEndpoints.contactEventTags,
              contactEventFieldValues: webhookEndpoints.contactEventFieldValues,
              assigneeIds: webhookEndpoints.assigneeIds,
              contactTags: webhookEndpoints.contactTags,
              conversationTags: webhookEndpoints.conversationTags,
            });
          if (!changed) throw new Error('A locked endpoint was not updated');
          await audit(tx, ctx, 'webhook.endpoint_updated', id, {
            host,
            eventTypes: changed.eventTypes,
            ...(data.headers !== undefined ? { headers: data.headers.map((h) => h.name) } : {}),
            ...(changed.messageStatuses ? { messageStatuses: changed.messageStatuses } : {}),
            ...(changed.messageSenders ? { messageSenders: changed.messageSenders } : {}),
            ...(changed.messageApiKeyIds ? { messageApiKeyIds: changed.messageApiKeyIds } : {}),
            ...(changed.contactParts ? { contactParts: changed.contactParts } : {}),
            ...(changed.contactFieldKeys ? { contactFieldKeys: changed.contactFieldKeys } : {}),
            ...(changed.automationIds ? { automationIds: changed.automationIds } : {}),
            ...(changed.campaignStatuses ? { campaignStatuses: changed.campaignStatuses } : {}),
            ...(changed.orderStatuses ? { orderStatuses: changed.orderStatuses } : {}),
            ...(changed.paymentLinkStatuses
              ? { paymentLinkStatuses: changed.paymentLinkStatuses }
              : {}),
            ...(changed.codAnswers ? { codAnswers: changed.codAnswers } : {}),
            ...(changed.storeIds ? { storeIds: changed.storeIds } : {}),
            ...(changed.orderMessageEvents
              ? { orderMessageEvents: changed.orderMessageEvents }
              : {}),
            ...(changed.orderMessageSkipReasons
              ? { orderMessageSkipReasons: changed.orderMessageSkipReasons }
              : {}),
            ...(changed.cartReminders ? { cartReminders: changed.cartReminders } : {}),
            ...(changed.cartReminderSkipReasons
              ? { cartReminderSkipReasons: changed.cartReminderSkipReasons }
              : {}),
            ...(changed.campaignSkipReasons
              ? { campaignSkipReasons: changed.campaignSkipReasons }
              : {}),
            ...(changed.runStepOutcomes ? { runStepOutcomes: changed.runStepOutcomes } : {}),
            ...(changed.runStepNodeTypes ? { runStepNodeTypes: changed.runStepNodeTypes } : {}),
            ...(changed.orderChangeMakers ? { orderChangeMakers: changed.orderChangeMakers } : {}),
            ...(changed.orderExcludedApiKeyIds
              ? { orderExcludedApiKeyIds: changed.orderExcludedApiKeyIds }
              : {}),
            ...(changed.paymentLinkApiKeyIds
              ? { paymentLinkApiKeyIds: changed.paymentLinkApiKeyIds }
              : {}),
            ...(changed.dealStatuses ? { dealStatuses: changed.dealStatuses } : {}),
            ...(changed.taskStatuses ? { taskStatuses: changed.taskStatuses } : {}),
            ...(changed.dealDetails ? { dealDetails: changed.dealDetails } : {}),
            ...(changed.taskDetails ? { taskDetails: changed.taskDetails } : {}),
            ...(changed.templateStatuses ? { templateStatuses: changed.templateStatuses } : {}),
            ...(changed.conversationStatuses
              ? { conversationStatuses: changed.conversationStatuses }
              : {}),
            ...(changed.runEndStatuses ? { runEndStatuses: changed.runEndStatuses } : {}),
            ...(changed.runTriggers ? { runTriggers: changed.runTriggers } : {}),
            ...(changed.runApiKeyIds ? { runApiKeyIds: changed.runApiKeyIds } : {}),
            ...(changed.consentChanges ? { consentChanges: changed.consentChanges } : {}),
            ...(changed.contactSources ? { contactSources: changed.contactSources } : {}),
            ...(changed.messageTypes ? { messageTypes: changed.messageTypes } : {}),
            ...(changed.messageWords ? { messageWords: changed.messageWords } : {}),
            ...(changed.runEndReasons ? { runEndReasons: changed.runEndReasons } : {}),
            ...(changed.channelAccountIds ? { channelIds: changed.channelAccountIds } : {}),
            ...(changed.teamIds ? { teamIds: changed.teamIds } : {}),
            ...(changed.templateIds ? { templateIds: changed.templateIds } : {}),
            ...(changed.campaignIds ? { campaignIds: changed.campaignIds } : {}),
            ...(changed.pipelineIds ? { pipelineIds: changed.pipelineIds } : {}),
            ...(changed.stageIds ? { stageIds: changed.stageIds } : {}),
            ...(changed.ownerIds ? { ownerIds: changed.ownerIds } : {}),
            ...(changed.taskAssigneeIds ? { taskAssigneeIds: changed.taskAssigneeIds } : {}),
            ...(changed.taskPipelineIds ? { taskPipelineIds: changed.taskPipelineIds } : {}),
            ...(changed.taskStageIds ? { taskStageIds: changed.taskStageIds } : {}),
            ...(changed.taskDealOwnerIds ? { taskDealOwnerIds: changed.taskDealOwnerIds } : {}),
            ...(changed.notePipelineIds ? { notePipelineIds: changed.notePipelineIds } : {}),
            ...(changed.noteStageIds ? { noteStageIds: changed.noteStageIds } : {}),
            ...(changed.noteDealOwnerIds ? { noteDealOwnerIds: changed.noteDealOwnerIds } : {}),
            ...(changed.crmChangeMakers ? { crmChangeMakers: changed.crmChangeMakers } : {}),
            ...(changed.crmExcludedApiKeyIds
              ? { crmExcludedApiKeyIds: changed.crmExcludedApiKeyIds }
              : {}),
            ...(changed.surveyScores ? { surveyScores: changed.surveyScores } : {}),
            ...(changed.surveyAssigneeIds ? { surveyAssigneeIds: changed.surveyAssigneeIds } : {}),
            ...(changed.surveyTeamIds ? { surveyTeamIds: changed.surveyTeamIds } : {}),
            ...(changed.surveyContactTags ? { surveyContactTags: changed.surveyContactTags } : {}),
            ...(changed.surveyConversationTags
              ? { surveyConversationTags: changed.surveyConversationTags }
              : {}),
            ...(changed.contactEventTags ? { contactEventTags: changed.contactEventTags } : {}),
            ...(changed.contactEventFieldValues
              ? { contactEventFieldValues: changed.contactEventFieldValues }
              : {}),
            ...(changed.assigneeIds ? { assigneeIds: changed.assigneeIds } : {}),
            ...(changed.contactTags ? { contactTags: changed.contactTags } : {}),
            ...(changed.conversationTags ? { conversationTags: changed.conversationTags } : {}),
            ...webhookOAuthAudit(oauth, endpoint),
          });
        }
        if (data.enabled !== undefined) {
          const { changed, failed } = await setWebhookEndpointEnabled(
            tx,
            ctx.tenant.id,
            endpoint,
            data.enabled,
            now,
          );
          if (changed) {
            await audit(
              tx,
              ctx,
              data.enabled ? 'webhook.endpoint_enabled' : 'webhook.endpoint_disabled',
              id,
              { host, pendingDeliveriesFailed: failed },
            );
          }
        }
        return readEndpoint(tx, ctx, id, now);
      });
    },

    /** DELETE /api/v1/webhook-endpoints/{id}: the endpoint and its delivery history. */
    async remove(ctx: ApiContext, id: string): Promise<void> {
      assertScope(ctx, 'webhooks.manage');
      endpointId(id);
      await db.run(ctx.scope, async (tx) => {
        const endpoint = await lockWebhookEndpoint(tx, ctx.tenant.id, id, 'update', {
          keysOnly: true,
        });
        await tx
          .delete(webhookEndpoints)
          .where(and(eq(webhookEndpoints.tenantId, ctx.tenant.id), eq(webhookEndpoints.id, id)));
        await audit(tx, ctx, 'webhook.endpoint_deleted', id, { host: webhookHost(endpoint.url) });
      });
    },

    /**
     * POST /api/v1/webhook-endpoints/{id}/rotate-secret: a new secret, once per `Idempotency-Key`
     * and in the first response only; the previous one also signs for 24 hours.
     */
    async rotateSecret(
      ctx: ApiContext,
      id: string,
      idempotency: IdempotencyInput,
    ): Promise<ApiResponse> {
      assertScope(ctx, 'webhooks.manage');
      endpointId(id);
      const now = clock.now();
      return db.run(ctx.scope, (tx) =>
        idempotent(
          tx,
          ctx,
          idempotency,
          now,
          async () => {
            const endpoint = await lockWebhookEndpoint(tx, ctx.tenant.id, id, 'no key update', {
              keysOnly: true,
            });
            const { secret, version } = await rotateWebhookEndpointSecret(
              tx,
              deps.keyring,
              ctx.tenant.id,
              endpoint,
              now,
            );
            await audit(tx, ctx, 'webhook.secret_rotated', id, {
              host: webhookHost(endpoint.url),
              secretVersion: version,
            });
            return {
              status: 200,
              body: { data: { ...(await readEndpoint(tx, ctx, id, now)), secret } },
            };
          },
          withoutSecret,
        ),
      );
    },

    /**
     * GET /api/v1/webhook-endpoints/{id}/deliveries: the endpoint's deliveries, newest first, on
     * exact keyset pages (ADR-083). Deliveries are kept 30 days.
     */
    async deliveries(
      ctx: ApiContext,
      id: string,
      query: unknown,
    ): Promise<{ data: ApiWebhookDelivery[]; nextCursor: string | null }> {
      assertScope(ctx, 'webhooks.manage');
      endpointId(id);
      const q = parseInput(apiWebhookDeliveryListQuerySchema, query);
      const cursor = decodeKeysetCursor(q.cursor);
      const now = clock.now();
      return db.run(
        ctx.scope,
        async (tx) => {
          await readEndpoint(tx, ctx, id, now);
          const rows = await tx
            .select({
              ...webhookDeliveryColumns,
              cursorAt: exactTimestamp(webhookDeliveries.createdAt),
            })
            .from(webhookDeliveries)
            .innerJoin(webhookEvents, deliveryEventJoin)
            .where(
              and(
                eq(webhookDeliveries.tenantId, ctx.tenant.id),
                eq(webhookDeliveries.endpointId, id),
                q.status ? eq(webhookDeliveries.state, q.status) : undefined,
                cursor
                  ? sql`(${webhookDeliveries.createdAt}, ${webhookDeliveries.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
                  : undefined,
              ),
            )
            .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
            .limit(q.limit + 1);
          const shown = rows.slice(0, q.limit);
          const last = shown.at(-1);
          return {
            data: shown.map(({ cursorAt: _cursorAt, ...row }) => toApiDelivery(row)),
            nextCursor:
              rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
          };
        },
        { accessMode: 'read only' },
      );
    },

    /** GET /api/v1/webhook-deliveries/{id}: a delivery to an endpoint a key added (ADR-083). */
    async getDelivery(ctx: ApiContext, id: string): Promise<ApiWebhookDelivery> {
      assertScope(ctx, 'webhooks.manage');
      deliveryId(id);
      return db.run(ctx.scope, (tx) => readDelivery(tx, ctx, id), { accessMode: 'read only' });
    },

    /**
     * POST /api/v1/webhook-endpoints/{id}/test: a `ping` event for the endpoint, which must be on,
     * once per `Idempotency-Key` (ADR-083). Answered with its delivery, to follow with
     * GET /webhook-deliveries/{id}.
     */
    async sendTest(
      ctx: ApiContext,
      id: string,
      idempotency: IdempotencyInput,
    ): Promise<ApiResponse> {
      assertScope(ctx, 'webhooks.manage');
      endpointId(id);
      const now = clock.now();
      return db.run(ctx.scope, (tx) =>
        idempotent(tx, ctx, idempotency, now, async () => {
          const endpoint = await lockWebhookEndpoint(tx, ctx.tenant.id, id, 'no key update', {
            keysOnly: true,
          });
          const queued = await queueWebhookTest(tx, ctx.tenant.id, endpoint);
          return { status: 201, body: { data: await readDelivery(tx, ctx, queued.deliveryId) } };
        }),
      );
    },

    /**
     * POST /api/v1/webhook-deliveries/{id}/replay: the finished delivery's event again, as a new
     * delivery to the same endpoint, which must be on, once per `Idempotency-Key` (ADR-083).
     * Audited as the key, as a member's replay is.
     */
    async replay(ctx: ApiContext, id: string, idempotency: IdempotencyInput): Promise<ApiResponse> {
      assertScope(ctx, 'webhooks.manage');
      deliveryId(id);
      const now = clock.now();
      return db.run(ctx.scope, (tx) =>
        idempotent(tx, ctx, idempotency, now, async () => {
          const replayed = await replayWebhookDelivery(tx, ctx.tenant.id, id, { keysOnly: true });
          await audit(tx, ctx, 'webhook.delivery_replayed', replayed.endpoint.id, {
            host: webhookHost(replayed.endpoint.url),
            deliveryId: id,
            newDeliveryId: replayed.deliveryId,
          });
          return {
            status: 201,
            body: { data: await readDelivery(tx, ctx, replayed.deliveryId) },
          };
        }),
      );
    },

    /**
     * POST /api/v1/webhook-endpoints/{id}/replay-failed: every event whose deliveries to the
     * endpoint all failed since `since`, of the `events` given or of every event (ADR-156),
     * delivered again, at most 500 per call and once per `Idempotency-Key` (ADR-095). Answered with
     * how many were queued and whether more remain. Audited as the key, once per call.
     */
    async replayFailed(
      ctx: ApiContext,
      id: string,
      input: unknown,
      idempotency: IdempotencyInput,
    ): Promise<ApiResponse> {
      assertScope(ctx, 'webhooks.manage');
      endpointId(id);
      const { since, events, failures } = parseInput(apiReplayFailedDeliveriesSchema, input);
      const now = clock.now();
      const from = new Date(since);
      if (from.getTime() > now.getTime()) {
        throw invalidSince('Give a time in the past.');
      }
      return db.run(ctx.scope, (tx) =>
        idempotent(tx, ctx, idempotency, now, async () => {
          const replayed = await replayFailedWebhookDeliveries(tx, ctx.tenant.id, id, from, {
            keysOnly: true,
            events,
            failures,
          });
          await audit(tx, ctx, 'webhook.deliveries_replayed', id, {
            host: webhookHost(replayed.endpoint.url),
            since: from.toISOString(),
            ...(events ? { events } : {}),
            ...(failures ? { failures } : {}),
            queued: replayed.queued,
            more: replayed.more,
          });
          return {
            status: 200,
            body: { data: { queued: replayed.queued, more: replayed.more } },
          };
        }),
      );
    },

    /**
     * POST /api/v1/webhook-endpoints/replay-failed: the failed deliveries of every endpoint the key
     * added that is on, chosen at each as `replayFailed` chooses them, at most 500 per call across
     * them and once per `Idempotency-Key` (ADR-160). Answered with what each endpoint queued and
     * whether more remain. Audited as the key, once per endpoint.
     */
    async replayAllFailed(
      ctx: ApiContext,
      input: unknown,
      idempotency: IdempotencyInput,
    ): Promise<ApiResponse> {
      assertScope(ctx, 'webhooks.manage');
      const { since, events, failures } = parseInput(apiReplayFailedDeliveriesSchema, input);
      const now = clock.now();
      const from = new Date(since);
      if (from.getTime() > now.getTime()) {
        throw invalidSince('Give a time in the past.');
      }
      return db.run(ctx.scope, (tx) =>
        idempotent(tx, ctx, idempotency, now, async () => {
          const replayed = await replayFailedAcrossEndpoints(tx, ctx.tenant.id, from, {
            keysOnly: true,
            events,
            failures,
          });
          for (const endpoint of replayed.endpoints) {
            await audit(tx, ctx, 'webhook.deliveries_replayed', endpoint.id, {
              host: webhookHost(endpoint.url),
              since: from.toISOString(),
              ...(events ? { events } : {}),
              ...(failures ? { failures } : {}),
              queued: endpoint.queued,
              more: endpoint.more,
              allEndpoints: true,
            });
          }
          return {
            status: 200,
            body: {
              data: {
                queued: replayed.queued,
                more: replayed.more,
                endpoints: replayed.endpoints.map(({ id, queued, more }) => ({ id, queued, more })),
              },
            },
          };
        }),
      );
    },
  };
}

export type ApiWebhookEndpoints = ReturnType<typeof createApiWebhookEndpoints>;
