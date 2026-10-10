import { z } from 'zod';
import {
  AUTOMATION_END_REASONS,
  AUTOMATION_RUN_STATUSES,
  CAMPAIGN_STATUSES,
  CHANNEL_STATUSES,
  CONVERSATION_SOURCE_KINDS,
  CONVERSATION_STATUSES,
  CRM_CHANGERS,
  DEAL_STATUSES,
  MESSAGE_STATUSES,
  TEAM_ASSIGNMENT_MODES,
  MESSAGE_TYPES,
  ORDER_STATUSES,
  ORDER_STATUS_CHANGERS,
  REMINDER_STATES,
  TASK_STATUSES,
  TEMPLATE_STATUSES,
  WEBHOOK_DELIVERY_STATES,
  type MessageStatus,
} from '@w360/db';
import {
  WEBHOOK_CAMPAIGN_STATUSES,
  WEBHOOK_CONVERSATION_STATUSES,
  WEBHOOK_CONTACT_PARTS,
  WEBHOOK_EVENT_INFO,
  WEBHOOK_EVENT_KEYS,
  WEBHOOK_LIMITS,
  WEBHOOK_MESSAGE_SENDERS,
  WEBHOOK_CRM_CHANGE_MAKERS,
  WEBHOOK_SURVEY_SCORES,
  WEBHOOK_MESSAGE_STATUSES,
  WEBHOOK_ORDER_STATUSES,
  WEBHOOK_PAYMENT_LINK_STATUSES,
  WEBHOOK_RUN_STEP_OUTCOMES,
  WEBHOOK_RUN_STEP_NODE_TYPES,
  WEBHOOK_ORDER_CHANGE_MAKERS,
  WEBHOOK_DEAL_STATUSES,
  WEBHOOK_TASK_STATUSES,
  WEBHOOK_DEAL_DETAILS,
  WEBHOOK_TASK_DETAILS,
  WEBHOOK_RUN_END_STATUSES,
  WEBHOOK_RUN_TRIGGERS,
  WEBHOOK_CONSENT_CHANGES,
  WEBHOOK_CONTACT_SOURCES,
  WEBHOOK_RECEIVED_MESSAGE_TYPES,
  WEBHOOK_RUN_END_REASONS,
  WEBHOOK_RETRY_SECONDS,
  WEBHOOK_TEMPLATE_STATUSES,
} from '../webhooks/model';
import {
  automationRunEndedPayloadSchema,
  automationRunStartedPayloadSchema,
  automationRunStepPayloadSchema,
  campaignStatusChangedPayloadSchema,
  dealCreatedPayloadSchema,
  dealUpdatedPayloadSchema,
  dealStageChangedPayloadSchema,
  dealOwnerChangedPayloadSchema,
  dealStatusChangedPayloadSchema,
  taskCreatedPayloadSchema,
  taskUpdatedPayloadSchema,
  taskAssigneeChangedPayloadSchema,
  taskStatusChangedPayloadSchema,
  noteCreatedPayloadSchema,
  satisfactionSurveyAnsweredPayloadSchema,
  storeOrderCodAnsweredPayloadSchema,
  paymentLinkStatusChangedPayloadSchema,
  consentChangedPayloadSchema,
  contactCreatedPayloadSchema,
  contactErasedPayloadSchema,
  contactMergedPayloadSchema,
  contactsLeftOutSchema,
  messageContactsSchema,
  contactUpdatedPayloadSchema,
  conversationAssignmentPayloadSchema,
  conversationStatusPayloadSchema,
  conversationTeamPayloadSchema,
  contentTooLargeSchema,
  tappedReplySchema,
  messageReceivedPayloadSchema,
  messageStatusPayloadSchema,
  orderReceivedPayloadSchema,
  orderStatusChangedPayloadSchema,
  pingPayloadSchema,
  templateStatusPayloadSchema,
} from '../webhooks/payloads';
import { RECIPIENT_OUTCOMES } from '../campaigns/outcomes';
import { SEGMENT_LIMITS } from '../campaigns/segments';
import { ORDER_REFERENCE_RE } from '../commerce/model';
import { CRM_LIMITS } from '../crm/common';
import { CONTACT_FIELD_KEY_RE } from '../contacts/field-definitions';
import { MAX_CONTACT_FIELDS } from '../contacts/fields';
import { MAX_TAGS_PER_CONVERSATION } from '../inbox/conversation-tags';
import { TEMPLATE_HEADER_MEDIA } from '../templates/definition';
import {
  apiCreateMessageTemplateSchema,
  apiUpdateMessageTemplateSchema,
} from './message-template-drafts';
import { MESSAGE_TEMPLATE_HISTORY } from './message-templates';
import {
  apiStartAutomationSchema,
  apiStartManyAutomationRunsSchema,
  apiStopManyAutomationRunsSchema,
} from './automations';
import {
  apiCampaignRecipientSchema,
  apiCampaignDetailSchema,
  apiCampaignReviewSchema,
  apiCampaignSchema,
  apiCreateCampaignSchema,
  apiSubmitCampaignSchema,
  apiUpdateCampaignSchema,
} from './campaigns';
import {
  apiCreateSegmentSchema,
  apiSegmentDetailSchema,
  apiSegmentSchema,
  apiUpdateSegmentSchema,
} from './segments';
import { apiContactFieldCreateSchema, apiContactFieldUpdateSchema } from './contact-fields';
import { apiContactSearchSchema, apiUpdateMatchingContactsSchema } from './contact-search';
import { CONTACT_FEED_PART_RE } from './contact-changes';
import { apiContactSchema } from './contact-view';
import {
  API_CONTACT_SEARCH_WINDOW,
  MAX_FIELD_FILTERS,
  apiContactFieldSchema,
  apiContactMergeResultSchema,
  apiContactUpdateSchema,
  apiMergeContactsSchema,
  apiUpdateManyContactsSchema,
} from './contacts';
import {
  API_MESSAGE_FEED_WINDOW,
  apiAddNoteSchema,
  apiUpdateConversationSchema,
  apiUpdateManyConversationsSchema,
  apiUpdateMatchingConversationsSchema,
} from './conversations';
import { API_LIMITS, API_SCOPE_INFO, API_SCOPE_KEYS } from './model';
import { apiPaymentLinkSchema } from './payment-link-view';
import {
  API_DEAL_HISTORY_DETAILS,
  API_DEAL_HISTORY_TYPES,
  apiCreateDealSchema,
  apiUpdateDealSchema,
  type ApiDealHistoryDetail,
  type ApiDealHistoryType,
} from './deals';
import { API_NOTE_MAX_LENGTH, apiCreateNoteSchema } from './notes';
import { apiCreatePipelineSchema, apiUpdatePipelineSchema } from './pipelines';
import { apiPipelineForecastSchema } from './pipeline-forecast';
import { apiReportSchema } from './reports';
import { apiFlowResponseSchema, apiFlowSchema, apiJsonValueSchema } from './flows';
import {
  apiChatLinkDetailSchema,
  apiChatLinkSchema,
  apiCreateChatLinkSchema,
  apiUpdateChatLinkSchema,
} from './chat-links';
import { apiAdSchema } from './ads';
import { MAX_PERIOD_DAYS, PERIOD_PRESETS } from '../reports/period';
import { apiCreateTeamSchema, apiUpdateTeamSchema } from './teams';
import { apiUpdateMemberSchema } from './members';
import { apiCreateClosedDaySchema, apiUpdateBusinessHoursSchema } from './business-hours';
import { MAX_RANGES_PER_DAY } from '../inbox/business-hours';
import { MAX_SAVED_REPLIES } from '../inbox/saved-replies';
import { GROWTH_LIMITS } from '../growth/model';
import {
  SATISFACTION_SURVEY_STATUSES,
  apiSatisfactionSurveySchema,
} from './satisfaction-survey-view';
import { apiCreateSavedReplySchema, apiUpdateSavedReplySchema } from './saved-replies';
import { apiCreateTaskSchema, apiUpdateTaskSchema } from './tasks';
import { apiUpdateOrderSchema } from './orders';
import {
  apiConsentSchema,
  apiContactCreateSchema,
  apiSendButtonsSchema,
  apiSendCatalogSchema,
  apiSendListSchema,
  apiSendProductListSchema,
  apiSendProductSchema,
  apiSendReactionSchema,
  apiSendManyTemplatesSchema,
  apiSendMessageSchema,
  apiSendTextSchema,
  apiSendImageSchema,
  apiSendVideoSchema,
  apiSendAudioSchema,
  apiSendDocumentSchema,
  API_MESSAGE_TYPES,
  apiSendStickerSchema,
  apiSendLocationSchema,
  apiSendContactsSchema,
} from './resources';
import {
  apiCreateWebhookEndpointSchema,
  apiReplayFailedDeliveriesSchema,
  apiUpdateWebhookEndpointSchema,
} from './webhook-endpoints';

/**
 * The OpenAPI 3.1 document of the public API v1 (ADR-052), built from the zod schemas that
 * validate requests and describe responses, so the document and the checks cannot drift apart.
 */

export const apiTemplateSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  language: z.string(),
  category: z.enum(['utility', 'marketing']),
  variables: z.object({
    header: z.number().int().describe('How many header values the template needs (0 or 1).'),
    body: z.number().int().describe('How many body values the template needs.'),
    buttons: z
      .number()
      .int()
      .describe('How many ends of links the template needs (0 to 2): one for each of its `links`.'),
  }),
  links: z
    .array(
      z.object({
        button: z.string().describe('The website button’s text.'),
        url: z.string().describe('Its link, ending with {{1}} where the value a send gives goes.'),
      }),
    )
    .describe(
      'The template’s website buttons whose link ends with a value, in the order a send gives their values in `variables.buttons`; empty for other templates.',
    ),
  headerMedia: z
    .enum(TEMPLATE_HEADER_MEDIA)
    .nullable()
    .describe(
      'For a template with a photo (`image`), video or document header, the file a send gives in its `headerMedia`, by link; null for other templates.',
    ),
  text: z.object({
    header: z.string().nullable(),
    body: z.string(),
    footer: z.string().nullable(),
  }),
  channels: z
    .array(z.object({ id: z.uuid(), phone: z.string().nullable() }))
    .describe('Active WhatsApp numbers that can send the template.'),
});

export const apiQueuedMessageSchema = z.object({
  id: z.uuid(),
  type: z
    .enum(API_MESSAGE_TYPES)
    .describe(
      'interactive: reply buttons or a list; image, video, audio, document and sticker: media sent from a link; location: a place; contacts: contact cards.',
    ),
  status: z.literal('queued'),
  contactId: z.uuid(),
  channelId: z.uuid(),
  templateId: z.uuid().optional().describe('The template sent, for templates.'),
});

/** What a send of a template to many numbers answers for one number (ADR-163). */
export const apiTemplateSendSchema = z.object({
  to: z.string().describe('The number, in E.164 form.'),
  message: apiQueuedMessageSchema
    .nullable()
    .describe('The message, as it is queued; null when it was not.'),
  error: z
    .object({ code: z.literal('precondition_failed'), message: z.string() })
    .nullable()
    .describe(
      'Why the message was not queued, as a send to the number alone would refuse it (the contact erased, opted out, on the suppression list or without the marketing opt-in the company asks for, or at the marketing frequency cap), in the message’s words; null when it was.',
    ),
});

/** The states of an outbound message (the `received` state is for inbound messages only). */
const OUTBOUND_STATUSES = [
  'queued',
  'sending',
  'accepted',
  'sent',
  'delivered',
  'read',
  'played',
  'failed',
  'canceled',
  'unknown_outcome',
] as const satisfies readonly MessageStatus[];

export const apiMessageSchema = z.object({
  id: z.uuid(),
  type: z
    .enum(API_MESSAGE_TYPES)
    .describe(
      'interactive: reply buttons or a list; image, video, audio, document and sticker: media sent from a link; location: a place; contacts: contact cards.',
    ),
  status: z
    .enum(OUTBOUND_STATUSES)
    .describe(
      'accepted: WhatsApp took the message; sent, delivered, read and failed follow from its status updates. unknown_outcome: the send was interrupted and it is unknown whether WhatsApp took it, so it is not retried.',
    ),
  statusAt: z.iso.datetime(),
  to: z.string().nullable(),
  templateId: z.uuid().nullable(),
  templateName: z.string().nullable(),
  channelId: z.uuid(),
  contactId: z.uuid(),
  replyTo: z
    .uuid()
    .nullable()
    .describe('The message it quotes or reacts to, when that message is in the conversation.'),
  error: z.object({ code: z.string().nullable(), title: z.string().nullable() }).nullable(),
  createdAt: z.iso.datetime(),
});

export const apiConversationSchema = z.object({
  id: z.uuid(),
  contactId: z.uuid(),
  channelId: z.uuid().describe('The WhatsApp number the conversation is on.'),
  status: z.enum(CONVERSATION_STATUSES),
  assigned: z.boolean().describe('Whether a member of the team is assigned.'),
  assigneeId: z.uuid().nullable().describe('The member assigned, as GET /members lists them.'),
  teamId: z
    .uuid()
    .nullable()
    .describe('The team the conversation is in, as GET /teams lists them.'),
  tags: z
    .array(z.string())
    .describe(
      'The conversation’s tags, alphabetically, as members and keys put them on it (lower-cased, without commas).',
    ),
  source: z
    .object({
      kind: z.enum(CONVERSATION_SOURCE_KINDS),
      at: z.iso.datetime().describe('When the customer’s message that carried it arrived.'),
      chatLink: z
        .object({ id: z.uuid(), name: z.string() })
        .nullable()
        .describe(
          'The chat link whose reference the customer sent (`link`), as GET /chat-links names it.',
        ),
      ad: z
        .object({
          id: z.string().nullable(),
          type: z.string().nullable(),
          headline: z.string().nullable(),
          url: z.string().nullable(),
        })
        .nullable()
        .describe(
          'The click-to-WhatsApp ad the customer wrote from (`ad`): Meta’s id and type for it, its headline and web address, as Meta sent them; never the ad click id.',
        ),
    })
    .nullable()
    .describe(
      'Where the conversation came from, as the inbox shows it: its latest source, the chat link whose reference the customer sent or the click-to-WhatsApp ad they wrote from; null for neither.',
    ),
  unreadCount: z.number().int(),
  lastMessageAt: z.iso.datetime().nullable(),
  lastInboundAt: z.iso.datetime().nullable().describe('When the contact last wrote.'),
  serviceWindowEndsAt: z.iso
    .datetime()
    .nullable()
    .describe(
      'When WhatsApp’s customer service window ends, 24 hours after the contact last wrote: until then a text reply can be sent (POST /messages with `type` `text`).',
    ),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime().describe('When anything about the conversation last changed.'),
  resolvedAt: z.iso.datetime().nullable(),
});

const ORDER_REFERENCE_PATTERN = ORDER_REFERENCE_RE.source;

/** A WhatsApp order a customer sent from the company's catalog (ADR-167). */
export const apiOrderSchema = z.object({
  id: z.uuid(),
  reference: z
    .string()
    .describe('The short reference members and the customer quote, like K7M2QX9P.'),
  status: z
    .enum(ORDER_STATUSES)
    .describe(
      'As the Orders page shows it: received as the customer sent it, then confirmed, awaiting_payment (a Payment Link was sent), paid, fulfilled or cancelled.',
    ),
  statusChangedAt: z.iso.datetime(),
  statusChangedBy: z
    .enum(ORDER_STATUS_CHANGERS)
    .nullable()
    .describe(
      'Who made the latest status change: a member on the order page (member, never which member), an API key (api, named by statusChangedByApiKeyId) or HyFib applying what Razorpay reports for the order’s Payment Link (payment_link). Null while the order is as the customer sent it, and when HyFib did not record who made the latest change.',
    ),
  statusChangedByApiKeyId: z
    .uuid()
    .nullable()
    .describe(
      'The API key that made the latest status change, when statusChangedBy is api; null otherwise.',
    ),
  conversationId: z.uuid().describe('The conversation the order was sent in.'),
  contactId: z
    .uuid()
    .describe('The customer, as GET /contacts/{id} reads them with `contacts.read`.'),
  channelId: z.uuid().describe('The WhatsApp number the order was sent to.'),
  messageId: z
    .uuid()
    .describe('The order message, as the conversation’s messages and `message.received` name it.'),
  catalogId: z.string().describe('The Meta catalog the cart came from.'),
  currency: z
    .string()
    .nullable()
    .describe('ISO 4217, like INR; null when the items are in different currencies.'),
  subtotalMinor: z
    .number()
    .int()
    .nullable()
    .describe(
      'The items’ total in the currency’s minor units (paise for INR); null when a price could not be read, the currencies differ or items were left out.',
    ),
  itemCount: z.number().int().describe('The items read from the cart.'),
  droppedItems: z
    .number()
    .int()
    .describe(
      'Cart items that could not be read or were beyond the limit of items an order keeps.',
    ),
  customerNote: z
    .string()
    .nullable()
    .describe(
      'The note the customer sent with the cart; null if none or once the contact is erased.',
    ),
  items: z.array(
    z.object({
      retailerId: z.string().describe('The item’s content id (SKU) in the catalog.'),
      name: z
        .string()
        .nullable()
        .describe('The product’s name when the order was received; null if it was not known.'),
      quantity: z.number().int(),
      unitPriceMinor: z
        .number()
        .int()
        .nullable()
        .describe('In the currency’s minor units; null when the price could not be read.'),
      currency: z.string().nullable(),
    }),
  ),
  receivedAt: z.iso.datetime(),
  paidAt: z.iso.datetime().nullable().describe('When Razorpay reported its Payment Link paid.'),
  updatedAt: z.iso.datetime().describe('When anything about the order last changed.'),
});

/** A CRM pipeline with its stages (ADR-253). */
export const apiPipelineSchema = z.object({
  id: z.uuid().describe('The pipeline, as deals name it (`pipelineId`).'),
  name: z.string(),
  currency: z
    .string()
    .describe('ISO 4217, like INR: the currency of every deal’s value in the pipeline.'),
  position: z
    .number()
    .int()
    .describe('The pipeline’s place among the company’s pipelines in the app, the first lowest.'),
  archived: z
    .boolean()
    .describe(
      'An archived pipeline holds only closed deals and takes none until members restore it.',
    ),
  stages: z
    .array(
      z.object({
        id: z.uuid().describe('The stage, as deals name it (`stageId`).'),
        name: z.string(),
        position: z.number().int().describe('The stage’s place on the board, the leftmost lowest.'),
        archived: z
          .boolean()
          .describe(
            'Removed from the board: an archived stage holds no open deals, and the closed deals closed in it keep it.',
          ),
        winPercent: z
          .number()
          .int()
          .min(0)
          .max(100)
          .nullable()
          .describe(
            'The chance, in whole percent, that the stage’s open deals are won, which the board and Reports weigh them by; null when it is not set.',
          ),
      }),
    )
    .describe('In board order, archived stages last.'),
  version: z
    .number()
    .int()
    .describe(
      'Moves on with every change of the pipeline or its stages; PATCH /pipelines/{id} takes it as `expectedVersion`.',
    ),
  createdBy: z
    .enum(['member', 'api'])
    .describe('Who added the pipeline: a member in Settings (never which), or an API key.'),
  createdByApiKeyId: z
    .uuid()
    .nullable()
    .describe('With `createdBy` `api`, the key that added it; null otherwise.'),
  createdAt: z.iso.datetime(),
});

/** A CRM deal (ADR-253). */
export const apiDealSchema = z.object({
  id: z.uuid(),
  title: z.string().describe('“Deal (contact erased)” once its contact is erased.'),
  pipelineId: z.uuid().describe('The deal’s pipeline, as GET /pipelines lists it.'),
  stageId: z
    .uuid()
    .describe('The deal’s stage in its pipeline; a closed deal keeps the stage it was closed in.'),
  status: z.enum(DEAL_STATUSES).describe('`open`, or closed as `won` or `lost`.'),
  valueMinor: z
    .number()
    .int()
    .nullable()
    .describe(
      'The deal’s value in the pipeline currency’s minor units (paise for INR); null when it has none.',
    ),
  currency: z.string().describe('ISO 4217, like INR: the pipeline’s currency.'),
  contactId: z
    .uuid()
    .describe('The customer, as GET /contacts/{id} reads them with `contacts.read`.'),
  conversationId: z
    .uuid()
    .nullable()
    .describe('The conversation the deal was created from, if any.'),
  ownerId: z
    .uuid()
    .nullable()
    .describe(
      'The member who owns the deal, by the id GET /members gives them (it lists the members still active); null when it has no owner.',
    ),
  expectedCloseOn: z.iso.date().nullable().describe('The day the deal is expected to close.'),
  stageEnteredAt: z.iso.datetime().describe('When the deal entered its stage.'),
  lostReason: z
    .string()
    .nullable()
    .describe(
      'Why a lost deal was lost, as a member or an automation wrote it; null otherwise, and once its contact is erased.',
    ),
  closedAt: z.iso.datetime().nullable().describe('When the deal was won or lost; null while open.'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime().describe('When anything about the deal last changed.'),
  version: z
    .number()
    .int()
    .describe(
      'Moves on with every change of the deal, by members, automations or keys; PATCH /deals/{id} takes it as `expectedVersion`.',
    ),
  changedBy: z
    .enum(CRM_CHANGERS)
    .nullable()
    .describe(
      'Who made the latest change of what deal events report (its stage, status, owner, title, value or expected close date): a member (member, never which member), an automation’s run (automation) or an API key (api, named by changedByApiKeyId). Null while the deal is as it was added, and when HyFib did not record who made the latest change, such as erasure retitling the deal; never the maker of an earlier change.',
    ),
  changedByApiKeyId: z
    .uuid()
    .nullable()
    .describe('The API key that made the latest change, when changedBy is api; null otherwise.'),
  createdBy: z
    .enum(CRM_CHANGERS)
    .describe(
      'Who added the deal: a member (member, never which member), an automation’s run (automation) or an API key (api, named by createdByApiKeyId), as deal.created says.',
    ),
  createdByApiKeyId: z
    .uuid()
    .nullable()
    .describe('The API key that added the deal, when createdBy is api; null otherwise.'),
});

/** One change of a CRM deal, as its history gives it (ADR-281). */
export const apiDealHistoryEntrySchema = z.object({
  id: z.uuid().describe('The change, on the deal’s timeline.'),
  type: z
    .enum(Object.values(API_DEAL_HISTORY_TYPES) as [ApiDealHistoryType, ...ApiDealHistoryType[]])
    .describe(
      'What changed: the deal was added (created), its title, value or expected close date changed (updated), it moved to another stage or pipeline (stage_changed), it was given to another owner or left without one (owner_changed), or it was won, lost or reopened.',
    ),
  createdAt: z.iso.datetime().describe('When the change was made.'),
  changedBy: z
    .enum(CRM_CHANGERS)
    .nullable()
    .describe(
      'Who made the change: a member (member, never which member), an automation’s run (automation) or an API key (api, named by changedByApiKeyId). Null when HyFib did not record who.',
    ),
  changedByApiKeyId: z
    .uuid()
    .nullable()
    .describe('The API key that made the change, when changedBy is api; null otherwise.'),
  stageId: z
    .uuid()
    .nullable()
    .describe(
      'created: the stage the deal was added in; stage_changed: the stage it moved to. Null for other changes.',
    ),
  pipelineId: z.uuid().nullable().describe('The pipeline of stageId, when there is one.'),
  previousStageId: z
    .uuid()
    .nullable()
    .describe('stage_changed: the stage the deal left. Null for other changes.'),
  previousPipelineId: z
    .uuid()
    .nullable()
    .describe(
      'The pipeline of previousStageId: another pipeline than pipelineId when the deal moved to another pipeline.',
    ),
  ownerId: z
    .uuid()
    .nullable()
    .describe(
      'owner_changed: the member the deal was given to, or null when it was left without an owner. Null for other changes.',
    ),
  previousOwnerId: z
    .uuid()
    .nullable()
    .describe(
      'owner_changed: the member who owned the deal before, or null. Null for other changes.',
    ),
  changes: z
    .array(
      z.enum(
        Object.values(API_DEAL_HISTORY_DETAILS) as [
          ApiDealHistoryDetail,
          ...ApiDealHistoryDetail[],
        ],
      ),
    )
    .nullable()
    .describe(
      'updated: what changed, in this order: `title`, `valueMinor` and `expectedCloseOn`; names only, never the title or date before. Null for other changes.',
    ),
  valueMinor: z
    .number()
    .int()
    .nullable()
    .describe(
      'created and won: the deal’s value then, in the pipeline currency’s minor units; updated: the new value, when the value changed (null when it was cleared). Null otherwise.',
    ),
  previousValueMinor: z
    .number()
    .int()
    .nullable()
    .describe('updated: the value before, when the value changed. Null otherwise.'),
});

/**
 * A note on the CRM timeline, as `POST /notes` answers it (ADR-268) and `GET /notes` reads it
 * (ADR-279).
 */
export const apiNoteSchema = z.object({
  id: z.uuid().describe('The note, on the CRM timeline.'),
  body: z.string().describe('The note as kept: its text, spaces around it trimmed.'),
  contactId: z
    .uuid()
    .describe(
      'The contact whose timeline holds the note: the one it was added to, or the deal’s; a merge moves it to the contact kept.',
    ),
  dealId: z
    .uuid()
    .nullable()
    .describe('The deal the note is about; null when it is about the contact only.'),
  writtenBy: z
    .enum(['member', 'api'])
    .describe(
      'Who wrote the note: a member on the contact or deal page (member, never which member) or an API key (api, named by apiKeyId).',
    ),
  apiKeyId: z
    .uuid()
    .nullable()
    .describe(
      'The key that added the note through the API, when writtenBy is api; null otherwise.',
    ),
  createdAt: z.iso.datetime().describe('When the note was added.'),
});

/** A CRM task (ADR-258). */
export const apiTaskSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  notes: z.string().nullable().describe('As members wrote them; null when the task has none.'),
  status: z.enum(TASK_STATUSES).describe('`open`, or closed as `done` or `cancelled`.'),
  dueAt: z.iso
    .datetime()
    .nullable()
    .describe('When the task is due; null when it has no due time.'),
  remindAt: z.iso
    .datetime()
    .nullable()
    .describe('When the assignee is to be emailed a reminder; null when none is set.'),
  reminderState: z
    .enum(REMINDER_STATES)
    .describe(
      '`none` without a reminder, `pending` until it is due, then `sent` once the reminder email to the assignee was queued, or `skipped` when it was not sent (`reminderSkipReason` says why).',
    ),
  remindedAt: z.iso
    .datetime()
    .nullable()
    .describe('When the reminder was sent or skipped; null before.'),
  reminderSkipReason: z
    .string()
    .nullable()
    .describe(
      'Why a skipped reminder was not sent: `task_closed` (the task was closed first), `too_late` (it came due more than a day before it could be sent) or `assignee_inactive` (the assignee could no longer use the CRM); null otherwise.',
    ),
  assigneeId: z
    .uuid()
    .describe(
      'The member the task is assigned to, by the id GET /members gives them (it lists the members still active).',
    ),
  contactId: z
    .uuid()
    .nullable()
    .describe(
      'The customer the task is about, as GET /contacts/{id} reads them with `contacts.read`; null when it is about none.',
    ),
  dealId: z
    .uuid()
    .nullable()
    .describe(
      'The deal the task is about, as GET /deals/{id} reads it with `deals.read`; null when it is about none. A task about a deal is about its contact too.',
    ),
  completedAt: z.iso
    .datetime()
    .nullable()
    .describe('When the task was done or cancelled; null while open.'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime().describe('When anything about the task last changed.'),
  version: z
    .number()
    .int()
    .describe(
      'Moves on with every change of the task by members or keys; PATCH /tasks/{id} takes it as `expectedVersion`.',
    ),
  changedBy: z
    .enum(CRM_CHANGERS)
    .nullable()
    .describe(
      'Who made the latest change of what task events report (its status, assignee, title, notes, due time or reminder time): a member (member, never which member) or an API key (api, named by changedByApiKeyId); automations only add tasks. Null while the task is as it was added, and when HyFib did not record who made the latest change; never the maker of an earlier change.',
    ),
  changedByApiKeyId: z
    .uuid()
    .nullable()
    .describe('The API key that made the latest change, when changedBy is api; null otherwise.'),
  createdBy: z
    .enum(CRM_CHANGERS)
    .describe(
      'Who added the task: a member (member, never which member), an automation’s run (automation) or an API key (api, named by createdByApiKeyId), as task.created says.',
    ),
  createdByApiKeyId: z
    .uuid()
    .nullable()
    .describe('The API key that added the task, when createdBy is api; null otherwise.'),
});

/** A member conversations can be assigned to (ADR-093). */
export const apiMemberSchema = z.object({
  id: z.uuid().describe('The member, as `assigneeId` names them.'),
  name: z.string(),
  available: z
    .boolean()
    .describe('Whether the member takes new conversations now (round-robin teams give them some).'),
  teamIds: z.array(z.uuid()).describe('The teams the member belongs to.'),
});

/** A member's availability, as `PATCH /members/{id}` answers it (ADR-289). */
export const apiMemberAvailabilitySchema = z.object({
  id: z.uuid(),
  available: z.boolean().describe('Whether the member takes the conversations routing gives out.'),
  changedAt: z.iso
    .datetime()
    .nullable()
    .describe('When the member’s availability last changed; null when it was never set.'),
});

const apiTimeRangeSchema = z.object({
  opens: z.string().describe('HH:MM in the company’s time zone.'),
  closes: z.string().describe('HH:MM, after `opens`; 24:00 is midnight at the end of the day.'),
});

/** The company's business hours and whether it is open now (ADR-290). */
export const apiBusinessHoursSchema = z.object({
  enabled: z
    .boolean()
    .describe(
      'Whether business hours are turned on; while they are off, the company counts as always open.',
    ),
  timeZone: z
    .string()
    .describe('The company’s time zone, like Asia/Kolkata, in which the hours and days are kept.'),
  days: z
    .array(z.array(apiTimeRangeSchema))
    .length(7)
    .describe(
      'Seven days, Monday first, each with its opening ranges in order; none: closed all day.',
    ),
  open: z
    .boolean()
    .describe(
      'Whether the company is open now: within its hours and not on a closed day, or always while the hours are off or have no opening time, as automations’ off-hours branches take it.',
    ),
  opensAt: z.iso
    .datetime()
    .nullable()
    .describe('While closed: when it next opens; null while open, or when not within a year.'),
  closesAt: z.iso
    .datetime()
    .nullable()
    .describe(
      'While open by its hours: when this opening ends; null while closed, while the hours are off, or when it stays open for the next 14 days.',
    ),
  asOf: z.iso.datetime().describe('When `open`, `opensAt` and `closesAt` were worked out.'),
});

/** A saved reply (ADR-291). */
export const apiSavedReplySchema = z.object({
  id: z.uuid(),
  shortcut: z.string().describe('What members type after / in the reply box to find it.'),
  title: z.string(),
  body: z
    .string()
    .describe(
      'The text, with {{name}}, {{agent}} and {{company}} where the reply box fills in the customer’s name, the member’s and the company’s before the member reviews it.',
    ),
  createdBy: z
    .enum(['member', 'api'])
    .describe('Who added it: a member in Settings (never which), or an API key.'),
  createdByApiKeyId: z.uuid().nullable(),
  updatedBy: z.enum(['member', 'api']).describe('Who last changed it, likewise.'),
  updatedByApiKeyId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** A template's content as HyFib represents it (ADR-294). */
const apiTemplateDefinitionSchema = z.object({
  category: z.enum(['MARKETING', 'UTILITY']),
  header: z.discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    z.object({
      type: z.literal('text'),
      text: z.string().describe('With {{1}} where a send gives a value.'),
      example: z.string().nullable().describe('The value Meta reviews it with.'),
    }),
  ]),
  body: z.object({
    text: z.string().describe('With {{1}}, {{2}}… where a send gives values.'),
    examples: z.array(z.string()).describe('The values Meta reviews it with, in order.'),
  }),
  footer: z.string().nullable(),
  buttons: z.array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('QUICK_REPLY'), text: z.string() }),
      z.object({
        type: z.literal('URL'),
        text: z.string(),
        url: z.string().describe('Ending with {{1}} when a send gives the end of the link.'),
        example: z.string().optional().describe('That end as Meta reviews it.'),
      }),
      z.object({ type: z.literal('PHONE_NUMBER'), text: z.string(), phoneNumber: z.string() }),
    ]),
  ),
});

/** A message template of any status (ADR-294). */
export const apiMessageTemplateSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  language: z.string(),
  category: z.enum(['marketing', 'utility', 'authentication']),
  status: z
    .enum(TEMPLATE_STATUSES)
    .describe(
      '`draft`, `submitting` and `submit_failed` before Meta has it; then Meta’s review states (`pending`, `approved`, `rejected`, `paused`, `disabled`, …, `unknown` for one HyFib does not recognise); `pending_deletion` and `deleted` once deleted.',
    ),
  rejectionReason: z.string().nullable().describe('Meta’s reason for rejecting it.'),
  qualityScore: z.string().nullable().describe('Meta’s quality rating of an approved template.'),
  submitError: z
    .string()
    .nullable()
    .describe(
      'Why HyFib could not submit it, while its status is `submit_failed`; while it is `submitting`, that HyFib is waiting for Meta to confirm it.',
    ),
  origin: z
    .enum(['local', 'synced'])
    .describe('`local`: added in HyFib; `synced`: found at Meta, added in WhatsApp Manager.'),
  createdBy: z
    .enum(['member', 'api'])
    .nullable()
    .describe('Who added it in HyFib: a member (never which) or a key; null when found at Meta.'),
  createdByApiKeyId: z.uuid().nullable().describe('The key that added it, when a key did.'),
  version: z.number().int().describe('Changes with every change HyFib records.'),
  sendable: z
    .boolean()
    .describe('Whether a send can use it now, as GET /templates lists the approved templates.'),
  unsupportedReason: z
    .string()
    .nullable()
    .describe('Why HyFib cannot send it or show its content, when it cannot.'),
  definition: apiTemplateDefinitionSchema
    .nullable()
    .describe('Its content as HyFib represents it; null when HyFib cannot (`unsupportedReason`).'),
  headerMedia: z
    .enum(TEMPLATE_HEADER_MEDIA)
    .nullable()
    .describe('The file its header takes when sent, or null.'),
  channels: z
    .array(z.object({ id: z.uuid(), phone: z.string().nullable() }))
    .describe('The active numbers of its WhatsApp Business account, which send it once approved.'),
  submittedAt: z.iso.datetime().nullable(),
  lastSyncedAt: z.iso.datetime().nullable().describe('When HyFib last read it from Meta.'),
  createdAt: z.iso.datetime().describe('When HyFib added it.'),
  updatedAt: z.iso.datetime(),
});

/** One message template with its latest status changes (ADR-294). */
export const apiMessageTemplateDetailSchema = apiMessageTemplateSchema.extend({
  history: z
    .array(
      z.object({
        status: z.string(),
        reason: z.string().nullable().describe('Meta’s reason, or HyFib’s, when one was given.'),
        source: z
          .enum(['submit', 'sync', 'send', 'delete'])
          .describe(
            '`submit`: sent for review; `sync`: read from Meta; `send`: refused by Meta on a send; `delete`.',
          ),
        occurredAt: z.iso.datetime(),
      }),
    )
    .describe(`Its latest ${MESSAGE_TEMPLATE_HISTORY} status changes, newest first.`),
});

/** A closed day (ADR-290). */
export const apiClosedDaySchema = z.object({
  id: z.uuid(),
  day: z.string().describe('YYYY-MM-DD in the company’s time zone.'),
  name: z.string(),
});

/** A WhatsApp number of the company (ADR-171). */
export const apiChannelSchema = z.object({
  id: z
    .uuid()
    .describe(
      'The number, as messages, conversations, orders and webhook events name it (`channelId`, `channel.id`) and a send takes it (`from`).',
    ),
  phone: z
    .string()
    .nullable()
    .describe('The number as WhatsApp shows it, like +91 98765 43210; null until Meta reports it.'),
  name: z
    .string()
    .nullable()
    .describe('The business name WhatsApp verified for the number; null until Meta reports it.'),
  status: z
    .enum(CHANNEL_STATUSES)
    .describe(
      '`active`: it sends and receives; `onboarding`: being connected; `needs_reconnect`: the WhatsApp account must be connected again; `disconnected`; `failed`: connecting it failed.',
    ),
  createdAt: z.iso.datetime().describe('When the number was added to the company.'),
});

/** A team conversations can be moved to (ADR-093). */
/** A tag on the company's contacts, with how many have it (ADR-272). */
export const apiContactTagSchema = z.object({
  tag: z.string().describe('As contacts carry it: lower case, single spaces, up to 40 characters.'),
  contacts: z
    .number()
    .int()
    .describe('The contacts that have the tag when the page is read; erased contacts have none.'),
});

/** A tag on the company's conversations, with how many have it (ADR-272). */
export const apiConversationTagSchema = z.object({
  tag: z
    .string()
    .describe('As conversations carry it: lower case, single spaces, up to 40 characters.'),
  conversations: z
    .number()
    .int()
    .describe('The conversations that have the tag when the page is read.'),
});

export const apiTeamSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  assignment: z
    .enum(TEAM_ASSIGNMENT_MODES)
    .describe(
      '`round_robin`: conversations moved to the team without a member go to its available members in turn; `manual`: they wait for someone to take them.',
    ),
});

/** A team with its settings, members and numbers (ADR-287). */
export const apiTeamSettingsSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  assignment: apiTeamSchema.shape.assignment,
  maxOpenPerMember: z
    .number()
    .int()
    .nullable()
    .describe(
      'With round robin, the open conversations a member is given at most; null for no limit.',
    ),
  routingKeywords: z
    .array(z.string())
    .describe('Words in a customer’s first message that route the conversation to the team.'),
  memberIds: z
    .array(z.uuid())
    .describe(
      'The team’s members who answer conversations now, as GET /members lists them, in the order they joined; a member suspended or given another role is left out until they can again.',
    ),
  channelIds: z
    .array(z.uuid())
    .describe('The WhatsApp numbers whose new conversations go to the team (GET /channels).'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** A note a key added to a conversation (ADR-084). */
export const apiConversationNoteSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  text: z.string(),
  writtenBy: z
    .enum(['agent', 'api'])
    .describe('Who wrote the note: a member in the inbox (agent, never which member) or the API.'),
  apiKeyId: z
    .uuid()
    .nullable()
    .describe(
      'The key that added the note through the API, which the inbox names; null for members.',
    ),
  createdAt: z.iso.datetime(),
});

export const apiConversationMessageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  direction: z.enum(['inbound', 'outbound']).describe('inbound: written by the contact.'),
  type: z.enum(MESSAGE_TYPES),
  text: z
    .string()
    .nullable()
    .describe(
      'The words of the message: the text, a caption, a reaction, or a location’s name (its address if it has no name); for inbound messages also the title of a tapped reply, for outbound ones a template’s body with its values or an interactive message’s body. Null if none.',
    ),
  reply: tappedReplySchema,
  replyTo: z
    .uuid()
    .nullable()
    .describe(
      'The id of the message this one answers: the message it quotes, the message a reaction is for, or the message whose button or row the contact tapped. Null when there is none or it is not in the conversation.',
    ),
  mimeType: z.string().nullable().describe('For media messages (the media is not attached).'),
  contentTooLarge: contentTooLargeSchema,
  contactsLeftOut: contactsLeftOutSchema,
  contacts: messageContactsSchema,
  templateId: z.uuid().nullable(),
  templateName: z.string().nullable(),
  sentBy: z
    .enum(['agent', 'bot', 'campaign', 'api', 'system'])
    .nullable()
    .describe(
      'Who sent an outbound message: a member (agent), an automation (bot), a campaign, the API or HyFib (system). Null for inbound messages.',
    ),
  apiKeyId: z
    .uuid()
    .nullable()
    .describe('The API key that sent it, for messages sent through the API.'),
  status: z.enum(MESSAGE_STATUSES).describe('received for inbound messages.'),
  statusAt: z.iso.datetime(),
  error: z.object({ code: z.string().nullable(), title: z.string().nullable() }).nullable(),
  createdAt: z.iso.datetime(),
});

/** A message of the feed across conversations (ADR-088). */
export const apiFeedMessageSchema = apiConversationMessageSchema.extend({
  contactId: z.uuid().describe('The contact of the message’s conversation.'),
  channelId: z.uuid().describe('The WhatsApp number the message was received on or sent from.'),
});

export const apiAutomationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z
    .enum(['active', 'paused'])
    .describe('A paused automation refuses to start (reason automation_paused).'),
  inputs: z
    .array(z.string())
    .describe('The inputs every start must give, by name; the steps use them as {{input.<name>}}.'),
  channelId: z.uuid().nullable().describe('The WhatsApp number the automation sends from.'),
  phoneNumber: z.string().nullable().describe('That number, as WhatsApp displays it.'),
  createdAt: z.iso.datetime(),
});

export const apiAutomationRunSchema = z.object({
  id: z.uuid(),
  automationId: z.uuid(),
  contactId: z.uuid(),
  conversationId: z.uuid(),
  channelId: z.uuid(),
  status: z
    .enum(AUTOMATION_RUN_STATUSES)
    .describe(
      'running or waiting while it works (waiting for the contact, a timer or a web request); completed, handed_off (to a member), taken_over (a member or the API replied), stopped or failed once it ended.',
    ),
  endReason: z
    .enum(Object.values(AUTOMATION_END_REASONS).flat() as [string, ...string[]])
    .nullable()
    .describe('Why the run ended; null while it works.'),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
});

/** What a start of many runs answers for one number (ADR-161). */
export const apiAutomationRunStartSchema = z.object({
  to: z.string().describe('The number, in E.164 form.'),
  run: apiAutomationRunSchema.nullable().describe('The run, as it starts; null when it did not.'),
  error: z
    .object({
      code: z.enum(['conflict', 'precondition_failed']),
      message: z.string(),
      reason: z
        .string()
        .optional()
        .describe(
          'automation_busy, automation_limit, automation_quota or conversation_assigned; none for consent and the suppression list, which the message names.',
        ),
    })
    .nullable()
    .describe(
      'Why the run did not start, as a start of one run would refuse it; null when it did.',
    ),
});

export const apiWebhookEndpointSchema = z.object({
  id: z.uuid(),
  url: z.string(),
  description: z.string().nullable(),
  events: z.array(z.enum(WEBHOOK_EVENT_KEYS)),
  status: z
    .enum(['active', 'disabled'])
    .describe('A disabled endpoint receives nothing until it is enabled again.'),
  disabledReason: z
    .enum(['manual', 'failing'])
    .nullable()
    .describe(
      'Why it is disabled: turned off, or every delivery failed for 72 hours (owners and administrators were emailed).',
    ),
  failingSince: z.iso
    .datetime()
    .nullable()
    .describe('Since when every delivery has failed; null after a success.'),
  lastSuccessAt: z.iso.datetime().nullable(),
  lastFailureAt: z.iso.datetime().nullable(),
  secretVersion: z.number().int().describe('1, then one more at each rotation.'),
  previousSecretExpiresAt: z.iso
    .datetime()
    .nullable()
    .describe('Until when the previous secret also signs, after a rotation.'),
  headers: z
    .array(z.object({ name: z.string() }))
    .describe(
      'The headers sent with every delivery, by name: their values are secrets and never shown.',
    ),
  messageStatuses: z
    .array(z.enum(WEBHOOK_MESSAGE_STATUSES))
    .nullable()
    .describe(
      'The message.status statuses the endpoint receives; null receives every status, including statuses added later.',
    ),
  messageSenders: z
    .array(z.enum(WEBHOOK_MESSAGE_SENDERS))
    .nullable()
    .describe(
      'Who sent the messages whose message.status the endpoint receives, as message.sentBy names them; null receives the statuses of every message.',
    ),
  messageApiKeyIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The API keys whose sent messages' message.status the endpoint receives, as message.apiKeyId names them: the messages one of them sent through the API, or a key one of them was rotated from or into. A message sent otherwise is not received. null receives the statuses of every message.",
    ),
  contactParts: z
    .array(z.enum(WEBHOOK_CONTACT_PARTS))
    .nullable()
    .describe(
      'The parts of a contact whose change the endpoint receives as contact.updated (fields: a change of any custom field); null receives every change, including parts added later.',
    ),
  contactFieldKeys: z
    .array(z.string())
    .nullable()
    .describe(
      'The custom fields (their keys, as GET /contact-fields lists them) whose value changes the endpoint receives as contact.updated; null receives every field’s, including fields added later. Changes of the other parts are not narrowed.',
    ),
  automationIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The automations whose runs the endpoint receives as automation.run_started, automation.run_ended and automation.run_step; null receives every automation's runs, including automations published later.",
    ),
  campaignStatuses: z
    .array(z.enum(WEBHOOK_CAMPAIGN_STATUSES))
    .nullable()
    .describe(
      'The statuses a campaign reaches that the endpoint receives as campaign.status_changed; null receives every status.',
    ),
  orderStatuses: z
    .array(z.enum(WEBHOOK_ORDER_STATUSES))
    .nullable()
    .describe(
      'The statuses an order reaches that the endpoint receives as order.status_changed; null receives every status.',
    ),
  paymentLinkStatuses: z
    .array(z.enum(WEBHOOK_PAYMENT_LINK_STATUSES))
    .nullable()
    .describe(
      'The statuses a Payment Link reaches that the endpoint receives as payment_link.status_changed; null receives every status.',
    ),
  runStepOutcomes: z
    .array(z.enum(WEBHOOK_RUN_STEP_OUTCOMES))
    .nullable()
    .describe(
      'The outcomes of the run steps the endpoint receives as automation.run_step, as step.outcome names them; null receives every step.',
    ),
  runStepNodeTypes: z
    .array(z.enum(WEBHOOK_RUN_STEP_NODE_TYPES))
    .nullable()
    .describe(
      'The kinds of node whose run steps the endpoint receives as automation.run_step, as step.nodeType names them, outside_node standing for the steps outside a node (step.nodeType null); null receives every step.',
    ),
  orderChangeMakers: z
    .array(z.enum(WEBHOOK_ORDER_CHANGE_MAKERS))
    .nullable()
    .describe(
      "Who made the order status changes the endpoint receives as order.status_changed, as the event's changedBy names them; a change HyFib did not record the maker of is received whoever is listed. null receives every change.",
    ),
  orderExcludedApiKeyIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The API keys whose order status changes the endpoint does not receive as order.status_changed, as the event's apiKeyId names the key that made a change: the changes one of them made through the API, or a key one of them was rotated from or into. Changes members and Payment Links made, and those HyFib did not record the maker of, are never left out. null leaves nothing out.",
    ),
  paymentLinkApiKeyIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The API keys whose Payment Links' payment_link.status_changed the endpoint receives, as the event's paymentLink.requestedByApiKeyId names the key that asked for a link: the links one of them asked for through the API, or a key one of them was rotated from or into. A link a member asked for matches no list. null receives every link's changes.",
    ),
  dealStatuses: z
    .array(z.enum(WEBHOOK_DEAL_STATUSES))
    .nullable()
    .describe(
      'The statuses a deal reaches that the endpoint receives as deal.status_changed (open is a deal reopened); null receives every status.',
    ),
  taskStatuses: z
    .array(z.enum(WEBHOOK_TASK_STATUSES))
    .nullable()
    .describe(
      'The statuses a task reaches that the endpoint receives as task.status_changed (open is a task reopened); null receives every status.',
    ),
  dealDetails: z
    .array(z.enum(WEBHOOK_DEAL_DETAILS))
    .nullable()
    .describe(
      'The deal details whose changes the endpoint receives as deal.updated: a change that changed one of them; null receives every change.',
    ),
  taskDetails: z
    .array(z.enum(WEBHOOK_TASK_DETAILS))
    .nullable()
    .describe(
      'The task details whose changes the endpoint receives as task.updated: a change that changed one of them; null receives every change.',
    ),
  templateStatuses: z
    .array(z.enum(WEBHOOK_TEMPLATE_STATUSES))
    .nullable()
    .describe(
      'The template statuses the endpoint receives as template.status_changed; null receives every status.',
    ),
  conversationStatuses: z
    .array(z.enum(WEBHOOK_CONVERSATION_STATUSES))
    .nullable()
    .describe(
      'The statuses a conversation reaches that the endpoint receives as conversation.status_changed; null receives every status.',
    ),
  runEndStatuses: z
    .array(z.enum(WEBHOOK_RUN_END_STATUSES))
    .nullable()
    .describe(
      'The statuses a run ended with that the endpoint receives as automation.run_ended; null receives every end.',
    ),
  runTriggers: z
    .array(z.enum(WEBHOOK_RUN_TRIGGERS))
    .nullable()
    .describe(
      'What started the runs whose events (automation.run_started, automation.run_ended and automation.run_step) the endpoint receives, as run.trigger names it; null receives every run.',
    ),
  runApiKeyIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      'The API keys whose runs (automation.run_started, automation.run_ended and automation.run_step) the endpoint receives, as run.apiKeyId names them: the runs one of them started through the API, or a key one of them was rotated from or into. A run started otherwise is not received. null receives every run.',
    ),
  consentChanges: z
    .array(z.enum(WEBHOOK_CONSENT_CHANGES))
    .nullable()
    .describe(
      'The consent changes the endpoint receives as consent.changed, by the event’s purpose and action; null receives every change.',
    ),
  contactSources: z
    .array(z.enum(WEBHOOK_CONTACT_SOURCES))
    .nullable()
    .describe(
      'Where the contacts whose contact.created the endpoint receives came from, as contact.source names it; null receives every contact.',
    ),
  messageTypes: z
    .array(z.enum(WEBHOOK_RECEIVED_MESSAGE_TYPES))
    .nullable()
    .describe(
      'The types of the received messages the endpoint receives as message.received, as message.type names them; null receives every type.',
    ),
  messageWords: z
    .array(z.string())
    .nullable()
    .describe(
      'The words or phrases whose received messages the endpoint receives as message.received: a message whose text, as message.text gives it, contains one of them, whatever its case. null receives every message.',
    ),
  runEndReasons: z
    .array(z.enum(WEBHOOK_RUN_END_REASONS))
    .nullable()
    .describe(
      'The reasons the runs the endpoint receives as automation.run_ended ended for, as run.endReason names them, each narrowing the end it belongs to; null receives every reason.',
    ),
  channelIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The WhatsApp numbers whose message, conversation, satisfaction survey answer, automation run, order, Payment Link, cash on delivery answer and campaign events the endpoint receives; null receives every number's, including numbers connected later. Consent, contact, template, deal, task and note events are not narrowed.",
    ),
  teamIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The teams whose conversations' message and conversation events the endpoint receives, by the team a conversation is in when the event happens (conversation.team_changed also by the team it left); null receives every conversation's. Other events are not narrowed.",
    ),
  templateIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The templates whose messages' statuses (message.status) and changes (template.status_changed) the endpoint receives; a message sent without a template is on no list. null receives every template's. Other events are not narrowed.",
    ),
  campaignIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The campaigns whose messages' statuses (message.status) and changes (campaign.status_changed) the endpoint receives; a message no campaign sent is on no list. null receives every campaign's. Other events are not narrowed.",
    ),
  pipelineIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The CRM pipelines whose deals' events (deal.created, deal.updated, deal.stage_changed, deal.owner_changed, deal.status_changed) the endpoint receives, by the pipeline an event gives (deal.stage_changed also by the pipeline a move to another pipeline left); null receives every pipeline's. Other events are not narrowed.",
    ),
  stageIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The CRM stages whose deals' events (deal.created, deal.updated, deal.stage_changed, deal.owner_changed, deal.status_changed) the endpoint receives, by the stage an event gives (deal.stage_changed also by the stage the deal left); null receives every stage's. With pipelineIds or ownerIds too, an event must pass them all. Other events are not narrowed.",
    ),
  ownerIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The members whose deals' events (deal.created, deal.updated, deal.stage_changed, deal.owner_changed, deal.status_changed) the endpoint receives, by the deal's owner when an event happens (deal.owner_changed also by the owner it left); a deal without an owner is on no list. null receives every deal's. With pipelineIds or stageIds too, an event must pass them all. Other events are not narrowed.",
    ),
  taskAssigneeIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The members whose tasks' events (task.created, task.updated, task.assignee_changed, task.status_changed) the endpoint receives, by the member a task is assigned to when an event happens (task.assignee_changed also by the member it left). null receives every task's. Other events are not narrowed.",
    ),
  taskPipelineIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The CRM pipelines whose deals' tasks' events (task.created, task.updated, task.assignee_changed, task.status_changed) the endpoint receives, by the pipeline of the task's deal when an event happens; a task without a deal is on no list. null receives every task's. With taskAssigneeIds, taskStageIds or taskDealOwnerIds too, an event must pass them all. Other events are not narrowed.",
    ),
  taskStageIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The CRM stages whose deals' tasks' events (task.created, task.updated, task.assignee_changed, task.status_changed) the endpoint receives, by the stage of the task's deal when an event happens; a task without a deal is on no list. null receives every task's. With taskAssigneeIds, taskPipelineIds or taskDealOwnerIds too, an event must pass them all. Other events are not narrowed.",
    ),
  taskDealOwnerIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The members whose deals' tasks' events (task.created, task.updated, task.assignee_changed, task.status_changed) the endpoint receives, by the owner of the task's deal when an event happens; a task without a deal, or of a deal without an owner, is on no list. null receives every task's. With taskAssigneeIds, taskPipelineIds or taskStageIds too, an event must pass them all. Other events are not narrowed.",
    ),
  notePipelineIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The CRM pipelines whose deals' notes' events (note.created) the endpoint receives, by the pipeline of the note's deal when the note is added; a note about a contact alone is on no list. null receives every note's. With noteStageIds or noteDealOwnerIds too, an event must pass them all. Other events are not narrowed.",
    ),
  noteStageIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The CRM stages whose deals' notes' events (note.created) the endpoint receives, by the stage of the note's deal when the note is added; a note about a contact alone is on no list. null receives every note's. With notePipelineIds or noteDealOwnerIds too, an event must pass them all. Other events are not narrowed.",
    ),
  noteDealOwnerIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The members whose deals' notes' events (note.created) the endpoint receives, by the owner of the note's deal when the note is added; a note about a contact alone, or of a deal without an owner, is on no list. null receives every note's. With notePipelineIds or noteStageIds too, an event must pass them all. Other events are not narrowed.",
    ),
  crmChangeMakers: z
    .array(z.enum(WEBHOOK_CRM_CHANGE_MAKERS))
    .nullable()
    .describe(
      "Who made the changes whose deal, task and note events the endpoint receives, as deal.changedBy, task.changedBy and note.writtenBy name them: an addition's maker is whoever added the deal or task, a note's whoever wrote it. A change HyFib did not record the maker of (changedBy null) is sent whoever is listed. null receives every change. Other events are not narrowed.",
    ),
  crmExcludedApiKeyIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The API keys whose deal, task and note changes the endpoint does not receive, as the events' apiKeyId names the key that made a change: the changes one of them made through the API, or a key one of them was rotated from or into. Changes members and automations made, and those HyFib did not record the maker of, are never left out. null leaves nothing out. Other events are not narrowed.",
    ),
  surveyScores: z
    .array(z.literal(WEBHOOK_SURVEY_SCORES))
    .nullable()
    .describe(
      'The scores of the satisfaction survey answers (satisfaction_survey.answered) the endpoint receives, as survey.score gives them (3 for the first and best button, 1 for the third); null receives every answer. Other events are not narrowed.',
    ),
  surveyAssigneeIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      'The members credited with the satisfaction survey answers (satisfaction_survey.answered) the endpoint receives, as survey.assigneeId names them: the member the conversation was assigned to when it was resolved; null receives every answer. Other events are not narrowed.',
    ),
  surveyTeamIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The teams whose conversations' satisfaction survey answers (satisfaction_survey.answered) the endpoint receives, by the team the conversation is in when the customer answers; null receives every answer. Other events are not narrowed.",
    ),
  surveyContactTags: z
    .array(z.string())
    .nullable()
    .describe(
      'The contact tags whose satisfaction survey answers (satisfaction_survey.answered) the endpoint receives, by the tags the answering contact has when they answer, as contacts carry them; null receives every answer. Other events are not narrowed.',
    ),
  surveyConversationTags: z
    .array(z.string())
    .nullable()
    .describe(
      'The conversation tags whose satisfaction survey answers (satisfaction_survey.answered) the endpoint receives, by the tags the conversation has when the customer answers, as conversations carry them; null receives every answer. Other events are not narrowed.',
    ),
  contactEventTags: z
    .array(z.string())
    .nullable()
    .describe(
      'The contact tags whose contact.created and contact.updated the endpoint receives, as contacts carry them: the changes of a contact that has one of them when they are saved, and those adding or removing one; a contact.created is received when the change that adds the contact tags it with one. null receives every contact. Other events are not narrowed.',
    ),
  contactEventFieldValues: z
    .array(
      z.union([
        z.object({
          key: z.string().describe("The custom field's key (GET /contact-fields)."),
          value: z
            .union([z.string(), z.number(), z.boolean()])
            .describe(
              'A value of the field’s type: text, a number, a date as YYYY-MM-DD, or true or false for yes/no.',
            ),
        }),
        z.object({
          key: z.string().describe("The text field's key (GET /contact-fields)."),
          contains: z
            .string()
            .describe('A word or phrase the field’s text contains, whatever its case.'),
        }),
        z.object({
          key: z.string().describe("The number or date field's key (GET /contact-fields)."),
          atLeast: z
            .union([z.number(), z.string()])
            .optional()
            .describe(
              'The range’s start, included: a number for a number field, a date as YYYY-MM-DD for a date field.',
            ),
          atMost: z
            .union([z.number(), z.string()])
            .optional()
            .describe('The range’s end, included, of the same kind as its start.'),
        }),
      ]),
    )
    .nullable()
    .describe(
      'The custom field conditions whose contact.created and contact.updated the endpoint receives: the changes of a contact that passes one of them once they are saved (a value it has, text compared whatever its case and numbers as numbers; a word its text contains; or a range its number or date is in, the ends included), and those changing one of the fields, so the change that takes a contact out of the conditions is received too; a contact.created is received when the change that adds the contact makes it pass one of them. A condition stays after its field is deleted, matching nothing until a field with its key is added again. null receives every contact. Other events are not narrowed.',
    ),
  assigneeIds: z
    .array(z.uuid())
    .nullable()
    .describe(
      "The members whose assigned conversations' message and conversation events the endpoint receives, by the member a conversation is assigned to when the event happens (conversation.assignment_changed also by the member it left); null receives every conversation's. Other events are not narrowed.",
    ),
  contactTags: z
    .array(z.string())
    .nullable()
    .describe(
      "The contact tags whose conversations' message and conversation events the endpoint receives, by the tags the conversation's contact has when the event happens (any of them); null receives every conversation's. Other events are not narrowed.",
    ),
  conversationTags: z
    .array(z.string())
    .nullable()
    .describe(
      "The conversation tags whose message and conversation events the endpoint receives, by the tags the conversation has when the event happens (any of them); null receives every conversation's. Other events are not narrowed.",
    ),
  oauth: z
    .object({
      tokenUrl: z.string().describe('Where HyFib asks for access tokens.'),
      clientId: z.string(),
      scope: z.string().nullable().describe('The scope it asks for; null: none.'),
    })
    .nullable()
    .describe(
      'The OAuth 2.0 client whose access tokens are sent as `Authorization: Bearer <token>` with every delivery (the client credentials grant); null: none. The secret is never shown.',
    ),
  apiKeyId: z.uuid().describe('The API key that added the endpoint.'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const apiWebhookDeliverySchema = z.object({
  id: z.uuid(),
  endpointId: z.uuid(),
  eventId: z.uuid().describe('The event delivered; a replay delivers the same event again.'),
  eventType: z
    .enum([...WEBHOOK_EVENT_KEYS, 'ping'])
    .describe('The event’s type, or `ping` for a test event.'),
  status: z
    .enum(WEBHOOK_DELIVERY_STATES)
    .describe(
      'pending: waiting for its next attempt; delivering: an attempt is under way; succeeded: the endpoint answered 2xx; failed: every attempt failed, the endpoint was turned off, the event is gone, or HyFib could not prepare the request (build or sign it, or open the endpoint’s headers or OAuth client).',
    ),
  attempts: z.number().int(),
  nextAttemptAt: z.iso
    .datetime()
    .nullable()
    .describe('When the next attempt is due, while pending.'),
  lastAttemptAt: z.iso.datetime().nullable(),
  lastStatusCode: z.number().int().nullable().describe('The HTTP status of the last attempt.'),
  lastError: z
    .string()
    .nullable()
    .describe(
      'Why the last attempt failed, or why the delivery ended without one, as a code (for example `invalid_status`, `timeout`, `endpoint_disabled`, `event_gone`, or `payload_failed`: HyFib could not prepare the request (build or sign it, or open the endpoint’s headers or OAuth client), which a replay sends once the cause is fixed). An endpoint with an OAuth client that got no access token fails the attempt without sending it: `oauth_token_refused_<status>` (the authorization server answered with that status), `oauth_token_invalid` (it answered 200 without a usable bearer token), or `oauth_token_` and the code of the request that failed (such as `oauth_token_timeout`).',
    ),
  lastDurationMs: z.number().int().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  replayOf: z.uuid().nullable().describe('The delivery this one replays.'),
  createdAt: z.iso.datetime(),
});

/** What a replay of an endpoint's failed deliveries queued (ADR-095). */
export const apiFailedReplaySchema = z.object({
  queued: z
    .number()
    .int()
    .min(0)
    .max(WEBHOOK_LIMITS.replayBatch)
    .describe('New deliveries queued, one per event.'),
  more: z
    .boolean()
    .describe('Whether more failed deliveries remain: call again to queue the next ones.'),
});

/** What a replay of every endpoint's failed deliveries queued (ADR-160). */
export const apiFailedReplayAcrossSchema = apiFailedReplaySchema.extend({
  endpoints: z
    .array(z.object({ id: z.uuid().describe('The endpoint.'), ...apiFailedReplaySchema.shape }))
    .max(WEBHOOK_LIMITS.endpoints)
    .describe(
      'What each endpoint that is on queued, in the order the endpoints were added. Endpoints that are off are left out.',
    ),
});

export const apiWebhookEndpointWithSecretSchema = apiWebhookEndpointSchema.extend({
  secret: z
    .string()
    .nullable()
    .describe(
      'The signing secret, in this response only: store it now. A retry with the same Idempotency-Key answers null; rotate the secret if it was lost.',
    ),
});

export const apiErrorSchema = z.object({
  error: z.object({
    code: z
      .string()
      .describe(
        'unauthenticated, forbidden, not_found, conflict, validation_failed, precondition_failed, rate_limited, tenant_suspended, unsupported, bad_request, internal.',
      ),
    message: z.string(),
    reason: z
      .string()
      .optional()
      .describe(
        'A finer reason: automation_busy, automation_limit, automation_paused, automation_quota, automation_unavailable, channel_unavailable, contact_merged, conversation_assigned, idempotency_key_reused, idempotency_response_too_large, ip_not_allowed, key_quota_exceeded, not_in_plan, quota_exceeded or window_closed.',
      ),
    mergedInto: z
      .uuid()
      .optional()
      .describe(
        'With reason contact_merged: the contact the requested one was merged into, as it is now (GET /contacts/{id}).',
      ),
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
  requestId: z.string(),
});

function jsonSchema(schema: z.ZodType, io: 'input' | 'output' = 'output') {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io,
    // Any JSON value (a form's answers) is the JsonValue component; nothing else is unnamed.
    unrepresentable: (ctx) => (ctx.zodSchema === apiJsonValueSchema ? ref('JsonValue') : 'throw'),
  }) as Record<string, unknown>;
  return rest;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ 'application/json': { schema } });
const dataOf = (schema: unknown) => ({
  type: 'object',
  properties: { data: schema },
  required: ['data'],
});

const errors = (...statuses: number[]) =>
  Object.fromEntries(
    statuses.map((status) => [
      String(status),
      {
        description:
          {
            400: 'The request is malformed (for example invalid JSON or a missing header).',
            401: 'No valid API key: missing, unknown, revoked or expired.',
            403: "The key lacks the scope this needs, the company's plan does not include the API, the scope this needs, automations when starting one, the CRM for pipelines, deals and tasks, or Commerce when sending products or reading or changing orders (reason not_in_plan), or the key, or its company for all its keys, does not accept requests from the client's address (reason ip_not_allowed).",
            404: 'Not found in the company.',
            409: 'The request conflicts with the current state. Starting an automation: another automation handles the conversation (reason automation_busy), a member is assigned to it (conversation_assigned), or it had as many runs in the last hour as allowed (automation_limit). Pausing, resuming or cancelling a campaign: its status does not allow it, or, resuming, a member or HyFib paused it; the message names the status or the pause reason.',
            412: "A condition for sending or saving is not met (consent, suppression, state). With reason window_closed, the number has not written to the WhatsApp number in the last 24 hours, so only templates can be sent to it. Starting an automation: it is not published, archived or not started through the API (automation_unavailable), paused (automation_paused), its number is not active (channel_unavailable), or the plan's automation runs for the month are used up (automation_quota).",
            415: 'The body must be JSON (Content-Type: application/json).',
            422: 'The request body or parameters are invalid.',
            423: 'The company is suspended or its plan has ended: reading only.',
            429: "Too many requests: wait for Retry-After seconds. With reason quota_exceeded, the plan's API requests for the month are used up; with reason key_quota_exceeded, the key's own monthly limit is (set in Settings → API keys). Either way Retry-After counts the seconds until the next month's period starts.",
            500: 'Something went wrong on our side; retry later (with the same Idempotency-Key).',
          }[status] ?? 'Error',
        content: json(ref('Error')),
      },
    ]),
  );

/** Narrows a page of tags to those starting with a text (ADR-272). */
const tagPrefixParam = {
  name: 'prefix',
  in: 'query',
  schema: { type: 'string', maxLength: 100 },
  description:
    'Only the tags that start with this text, compared as tags are written (lower case, single spaces).',
};

/** How pages of tags are read, for both lists (ADR-272). */
const tagPagesNote =
  'Pages continue after the last tag of the page before, so paging never skips or repeats a tag that stays in use; a tag first used meanwhile before the cursor is listed on the next pass, and the counts are read with each page.';

const pageParams = [
  {
    name: 'limit',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: API_LIMITS.pageSize, default: 50 },
  },
  {
    name: 'cursor',
    in: 'query',
    schema: { type: 'string' },
    description: '`nextCursor` from the previous page.',
  },
];

const pageOf = (schema: string) =>
  json({
    type: 'object',
    properties: {
      data: { type: 'array', items: ref(schema) },
      nextCursor: { type: ['string', 'null'] },
    },
    required: ['data', 'nextCursor'],
  });

const scopeNote = (...scopes: string[]) => `Scope: ${scopes.map((s) => `\`${s}\``).join(' or ')}.`;

/** How a contact merged into another answers (ADR-225). */
const MERGED_CONTACT_NOTE =
  'A contact merged into another is not found: 404 with reason `contact_merged`, and `mergedInto` naming the contact it belongs to now.';

const retrySchedule = WEBHOOK_RETRY_SECONDS.map((seconds) =>
  seconds < 3_600 ? `${seconds / 60} min` : `${seconds / 3_600} h`,
).join(', ');

/** One webhook the API sends (OpenAPI 3.1 `webhooks`): a signed POST to the company's endpoint. */
const webhook = (operationId: string, summary: string, description: string, schema: string) => ({
  post: {
    operationId,
    summary,
    description: `${description} Verify \`W360-Signature\` before trusting the body, and deduplicate on the event id.`,
    security: [],
    parameters: [
      { $ref: '#/components/parameters/WebhookSignature' },
      { $ref: '#/components/parameters/WebhookEventId' },
      { $ref: '#/components/parameters/WebhookEventType' },
      { $ref: '#/components/parameters/WebhookDeliveryId' },
      { $ref: '#/components/parameters/WebhookDeliveryAttempt' },
    ],
    requestBody: { required: true, content: json(ref(schema)) },
    responses: {
      '2XX': {
        description: `Received. Any other answer, or none within 10 seconds, is retried (${retrySchedule}).`,
      },
    },
  },
});

export function buildOpenApiDocument(serverUrl: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'HyFib W360 API',
      version: '1.0.0',
      description: [
        'Send approved WhatsApp templates, reply with text to contacts who wrote in the last 24 hours, read conversations, their messages (one conversation or all of them) and their notes, resolve, reopen, assign and tag conversations or move them between teams, manage contacts and consent, list the tags in use on contacts and conversations, read campaigns, their results and their recipients, read and manage saved segments and list their contacts, create, edit, review and submit campaign drafts for a member’s approval, pause and cancel campaigns and resume the ones you paused, list your WhatsApp numbers, and read message status for your company.',
        '',
        'Authenticate with `Authorization: Bearer <API key>`; keys are created in Settings → API keys and belong to the company. A key, and the company for all its keys, can be limited to the addresses its systems call from: a request from any other address is refused with 403 (reason `ip_not_allowed`).',
        `Scopes: ${API_SCOPE_KEYS.map((s) => `\`${s}\` (${API_SCOPE_INFO[s].label.toLowerCase()})`).join(', ')}. A company's plan may include only some of them: a request that needs a scope the plan leaves out is refused with 403 (reason \`not_in_plan\`), whatever scopes its key has.`,
        '',
        `Limits: ${API_LIMITS.keyRate.refillPerSecond} requests a second per key (bursts of ${API_LIMITS.keyRate.capacity}) and ${API_LIMITS.companyRate.refillPerSecond} per company; JSON bodies up to ${API_LIMITS.bodyBytes / 1024} KB. Text cannot hold the NUL character (U+0000): a request with it anywhere in its query string or body is refused with 422, naming where it is.`,
        '',
        `POST /messages needs an \`Idempotency-Key\` header: a retry with the same key and body returns the first response (header \`Idempotent-Replayed: true\`) and never sends twice; responses are kept ${API_LIMITS.idempotencyHours} hours. Delivery itself follows WhatsApp: read the status with GET /messages/{id}.`,
        `A response kept for an \`Idempotency-Key\`, on POST /messages and the other requests that take one, holds up to ${API_LIMITS.idempotentResponseBytes / 1024} KiB: a request whose response would be larger is refused with 422 and reason \`idempotency_response_too_large\`, and nothing is done. Only requests whose key is optional can give a response that large, so send such a request again without a key.`,
        '',
        `Webhooks: endpoints added in Settings → Webhooks receive the events below as signed JSON POSTs. \`W360-Signature: t=<unix time>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the endpoint secret>\` (two \`v1\` values for ${WEBHOOK_LIMITS.previousSecretHours} hours after the secret is rotated); reject a time more than 5 minutes from yours. Answer with a 2xx status within 10 seconds; anything else is retried (${retrySchedule}; ${WEBHOOK_LIMITS.attempts} attempts). Delivery is at least once and unordered: deduplicate on the event id. An endpoint failing for ${WEBHOOK_LIMITS.disableAfterHours} hours is turned off. An endpoint can also send up to ${WEBHOOK_LIMITS.headers} headers of its own with every delivery, such as an \`Authorization\` header its receiver issued; they never replace HyFib's. Or it can get an access token from its receiver's authorization server (OAuth 2.0 client credentials) and send it as \`Authorization: Bearer <token>\`. An endpoint receives the events of every WhatsApp number unless it names the numbers it takes (its \`channelIds\`, or the numbers chosen in Settings → Webhooks): then it receives the message, conversation, satisfaction survey answer, automation run, order, Payment Link, cash on delivery answer and campaign events of those numbers only (a campaign's are those of the number it sends from), and still every consent, contact, template, deal, task and note event it takes. It can likewise name teams (its \`teamIds\`, or the teams chosen in Settings → Webhooks): then it receives the message and conversation events of those teams' conversations only, by the team a conversation is in when the event happens, or members (its \`assigneeIds\`): then those of the conversations assigned to them only, by the member a conversation is assigned to when the event happens, or contact tags (its \`contactTags\`): then those of the conversations whose contact has any of the tags when the event happens only, or conversation tags (its \`conversationTags\`): then those of the conversations that have any of the tags when the event happens only. And it can name templates (its \`templateIds\`): then it receives the statuses of the messages sent with them and their changes only, or campaigns (its \`campaignIds\`): then the statuses of the messages they sent and their changes only. And it can name CRM pipelines (its \`pipelineIds\`): then it receives the events of those pipelines' deals only, by the pipeline an event gives, a move to another pipeline reaching the endpoints of the pipeline it left as well, or stages (its \`stageIds\`): then those of the deals in those stages only, a move reaching the endpoints of the stage it left as well, or the deals' owners (its \`ownerIds\`): then those of the deals the members own when the event happens only, a change of owner reaching the endpoints of the owner it left as well; with more than one of these, an event must pass them all. And it can name the members whose tasks it takes (its \`taskAssigneeIds\`): then it receives the events of the tasks assigned to them when the event happens only, a change of assignee reaching the endpoints of the member it left as well, or the pipelines, stages or owners of the deals whose tasks it takes (its \`taskPipelineIds\`, \`taskStageIds\` and \`taskDealOwnerIds\`): then those of the tasks about deals in those pipelines or stages, or owned by those members, when the event happens only; with more than one of these, an event must pass them all. And it can name the pipelines, stages or owners of the deals whose notes it takes (its \`notePipelineIds\`, \`noteStageIds\` and \`noteDealOwnerIds\`): then it receives the events of the notes about deals in those pipelines or stages, or owned by those members, when the note is added only; with more than one of these, an event must pass them all. And it can name who made the changes whose deal, task and note events it takes (its \`crmChangeMakers\`: members, automations or API keys, as \`changedBy\` and \`writtenBy\` name them): then it receives the events of the changes they made only, and those HyFib did not record the maker of, so an integration can leave out the changes keys make; or it can leave out only the changes chosen keys made (its \`crmExcludedApiKeyIds\`, a key rotated from or into one of them included), to be sent every change but its own.`,
      ].join('\n'),
    },
    servers: [{ url: serverUrl }],
    security: [{ apiKey: [] }],
    paths: {
      '/templates': {
        get: {
          operationId: 'listTemplates',
          summary: 'Approved templates that can be sent',
          description: `${scopeNote('templates.read')} Approved utility and marketing templates that HyFib can send, with how many values their variables need, for a header that is a photo, a video or a document, which file a send gives (\`headerMedia\`), and the website buttons whose link ends with a value a send gives (\`links\`).`,
          responses: {
            '200': {
              description: 'The templates.',
              content: json(dataOf({ type: 'array', items: ref('Template') })),
            },
            ...errors(401, 403, 429, 500),
          },
        },
      },
      '/message-templates': {
        get: {
          operationId: 'listMessageTemplates',
          summary: 'Templates of every status, newest first',
          description: `${scopeNote('templates.read')} The company’s message templates as the Templates page lists them: drafts, those Meta is reviewing, approved, rejected, paused or disabled, and those found at Meta (\`origin\`), with Meta’s reasons and quality rating, whether a send can use each now (as GET /templates lists the approved ones) and its content as HyFib represents it, null for content HyFib cannot represent. Deleted templates are listed only when \`status\` asks for them. Newest first by when HyFib added them; pages never skip or repeat a template. Filters combine. template.status_changed webhooks say when a status changes.`,
          parameters: [
            ...pageParams,
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: [...TEMPLATE_STATUSES] },
              description: 'Only the templates in this status; deleted ones are listed only so.',
            },
            {
              name: 'channelId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description:
                'Only the templates this number can send: its WhatsApp Business account’s.',
            },
            {
              name: 'name',
              in: 'query',
              schema: { type: 'string', maxLength: 512 },
              description: 'Only the templates of this name.',
            },
          ],
          responses: {
            '200': { description: 'A page of templates.', content: pageOf('MessageTemplate') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
        post: {
          operationId: 'createMessageTemplate',
          summary: 'Add a template draft',
          description: `${scopeNote('templates.write')} A draft as members add one on the Templates page, for the WhatsApp Business account of one of the company’s numbers (\`channelId\`; 404 for another company’s number or an unknown one): a name of lower-case letters, digits and underscores and a language code, unique together in the account (409 otherwise; a deleted draft Meta never received is used again), and its content, checked as the template editor checks it (422 with the problems otherwise). It stays a draft until it is submitted to Meta (POST /message-templates/{id}/submit, or on the Templates page). The audit log names the key, and the template gives \`createdBy: "api"\`. With an \`Idempotency-Key\`, a retry answers the first response.`,
          parameters: [{ $ref: '#/components/parameters/IdempotencyKeyOptional' }],
          requestBody: { required: true, content: json(ref('CreateMessageTemplate')) },
          responses: {
            '201': {
              description: 'The draft.',
              content: json(dataOf(ref('MessageTemplateDetail'))),
            },
            ...errors(400, 401, 403, 404, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/message-templates/{id}': {
        get: {
          operationId: 'getMessageTemplate',
          summary: 'A template of any status, with its history',
          description: `${scopeNote('templates.read')} As GET /message-templates gives it, deleted ones included, with its latest ${MESSAGE_TEMPLATE_HISTORY} status changes, newest first, and what each came from. Another company’s template answers 404, as an unknown one does.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'The template.',
              content: json(dataOf(ref('MessageTemplateDetail'))),
            },
            ...errors(401, 403, 404, 429, 500),
          },
        },
        patch: {
          operationId: 'updateMessageTemplate',
          summary: 'Change a draft’s content',
          description: `${scopeNote('templates.write')} Sets a draft’s whole content as members save it on the Templates page, checked as when adding one: only a draft Meta never received (\`draft\` or \`submit_failed\`; 412 otherwise), from \`expectedVersion\` when given (409 for another version). Its name and language stay. Content the draft already has answers it as it is, with no audit entry, so a retry needs no \`Idempotency-Key\`; otherwise it becomes a \`draft\` again, its version moves on and the audit log names the key.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          requestBody: { required: true, content: json(ref('UpdateMessageTemplate')) },
          responses: {
            '200': {
              description: 'The draft now.',
              content: json(dataOf(ref('MessageTemplateDetail'))),
            },
            ...errors(400, 401, 403, 404, 409, 412, 415, 422, 423, 429, 500),
          },
        },
        delete: {
          operationId: 'deleteMessageTemplate',
          summary: 'Delete a template',
          description: `${scopeNote('templates.write')} Deletes a template as members do on the Templates page. A draft Meta never received is deleted at once: it is then listed with \`status=deleted\`, and its name and language can be used again. One Meta has also needs \`templates.submit\` (403 naming it otherwise): HyFib asks Meta to delete it, and it is \`pending_deletion\` until Meta answers, then \`deleted\`, when it can no longer be sent (messages already sent are not affected), or, when Meta refuses, back to the status Meta reports, with a \`delete_failed\` change in its history. One being submitted answers 412; one already deleted, or being deleted, 409. The audit log names the key.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'Deleted, or being deleted at Meta.',
              content: json(
                dataOf({
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    deleted: {
                      type: 'boolean',
                      description: 'Whether it is deleted now: false while Meta deletes it.',
                    },
                    status: { type: 'string', enum: ['deleted', 'pending_deletion'] },
                  },
                  required: ['id', 'deleted', 'status'],
                }),
              ),
            },
            ...errors(401, 403, 404, 409, 412, 423, 429, 500),
          },
        },
      },
      '/message-templates/{id}/submit': {
        post: {
          operationId: 'submitMessageTemplate',
          summary: 'Submit a draft to Meta for review',
          description: [
            `${scopeNote('templates.submit')} Submits a draft as members do on the Templates page: only a draft Meta never received (\`draft\` or \`submit_failed\`; 412 otherwise, as for one submitted already), whose WhatsApp Business account is connected (412 otherwise), its content checked again as the template editor checks it (422). It is \`submitting\` until HyFib has Meta’s answer, then as Meta reports it: \`pending\` while Meta reviews it, then \`approved\` or \`rejected\` with Meta’s reason, which GET /message-templates/{id} gives and template.status_changed webhook events report; or \`submit_failed\`, with \`submitError\` saying why, when Meta did not take it, to be changed and submitted again. Its content no longer changes once Meta has it. The audit log names the key.`,
            'With an `Idempotency-Key`, a retry answers the first response; without one, submitting it again is refused with 412.',
          ].join('\n\n'),
          parameters: [
            { $ref: '#/components/parameters/Id' },
            { $ref: '#/components/parameters/IdempotencyKeyOptional' },
          ],
          responses: {
            '200': {
              description: 'The template, being submitted.',
              content: json(dataOf(ref('MessageTemplateDetail'))),
            },
            ...errors(400, 401, 403, 404, 412, 422, 423, 429, 500),
          },
        },
      },
      '/channels': {
        get: {
          operationId: 'listChannels',
          summary: 'WhatsApp numbers, oldest first',
          description: `${scopeNote('channels.read')} The company's WhatsApp numbers, whatever their status: the ids messages, conversations, orders and webhook events name them by, and that \`from\` takes on POST /messages when the company has several. Meta's ids for them and their credentials are never given.`,
          parameters: [
            ...pageParams,
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: [...CHANNEL_STATUSES] },
              description:
                'Only the numbers with this status (`active` for those that send and receive).',
            },
          ],
          responses: {
            '200': { description: 'A page of numbers.', content: pageOf('Channel') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
      },
      '/contacts': {
        get: {
          operationId: 'listContacts',
          summary: 'Contacts, newest first',
          description: `${scopeNote('contacts.read')} Filters combine: a contact matches all of them. Pages never skip or repeat a contact. A page filtered by \`name\`, \`tag\` or \`fields\` reads at most ${API_CONTACT_SEARCH_WINDOW.toLocaleString('en-US')} of the company's contacts, newest first: when the filters leave out most of them, a page can hold fewer contacts than \`limit\`, or none, and still give a \`nextCursor\`; follow it until it is \`null\`.`,
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: API_LIMITS.pageSize, default: 50 },
            },
            {
              name: 'cursor',
              in: 'query',
              schema: { type: 'string' },
              description: '`nextCursor` from the previous page.',
            },
            {
              name: 'phone',
              in: 'query',
              schema: { type: 'string' },
              description: 'Only the contact with this number (with its country code).',
            },
            {
              name: 'email',
              in: 'query',
              schema: { type: 'string', maxLength: 254 },
              description: 'Only contacts with this email address, whatever its case.',
            },
            {
              name: 'name',
              in: 'query',
              schema: { type: 'string', minLength: 1, maxLength: 200 },
              description:
                'Only contacts whose name contains this text, as members’ search finds them: letters whatever their case (as the database’s locale folds them), the text as written (`%` and `_` are characters, not patterns), without the spaces at its ends. Contacts without a name never match.',
            },
            {
              name: 'tag',
              in: 'query',
              schema: { type: 'string', maxLength: 40 },
              description: 'Only contacts with this tag (tags are lower-cased).',
            },
            {
              name: 'fields',
              in: 'query',
              style: 'deepObject',
              explode: true,
              schema: {
                type: 'object',
                additionalProperties: { type: 'string', maxLength: 500 },
                maxProperties: MAX_FIELD_FILTERS,
              },
              description: `Only contacts whose custom field has this value, as \`fields[<key>]=<value>\` (keys from GET /contact-fields), at most ${MAX_FIELD_FILTERS}: text equal whatever its case, a number equal as a number, a date as YYYY-MM-DD, \`true\` or \`false\` for yes/no. An unknown key or a value of another type is refused, naming \`fields.<key>\`.`,
            },
          ],
          responses: {
            '200': {
              description: 'A page of contacts.',
              content: json({
                type: 'object',
                properties: {
                  data: { type: 'array', items: ref('Contact') },
                  nextCursor: { type: ['string', 'null'] },
                },
                required: ['data', 'nextCursor'],
              }),
            },
            ...errors(401, 403, 422, 429, 500),
          },
        },
        post: {
          operationId: 'createContact',
          summary: 'Create a contact, or get the existing one for the number',
          description: `${scopeNote('contacts.write')} An existing contact answers 200 with \`created: false\`; an empty name, email or custom field is filled, values it has are kept, and tags are added (50 at most per contact).`,
          parameters: [{ $ref: '#/components/parameters/IdempotencyKeyOptional' }],
          requestBody: { required: true, content: json(ref('ContactCreate')) },
          responses: {
            '201': {
              description: 'Created.',
              content: json({
                type: 'object',
                properties: { data: ref('Contact'), created: { type: 'boolean' } },
                required: ['data', 'created'],
              }),
            },
            '200': {
              description: 'The contact already existed.',
              content: json({
                type: 'object',
                properties: { data: ref('Contact'), created: { type: 'boolean' } },
                required: ['data', 'created'],
              }),
            },
            ...errors(400, 401, 403, 412, 415, 422, 423, 429, 500),
          },
        },
      },
      '/contacts/search': {
        post: {
          operationId: 'searchContacts',
          summary: 'Contacts matching conditions, as segments find them, newest first',
          description: `${scopeNote('contacts.read')} Finds contacts with segments' conditions and comparisons: the contact's name, custom field values, tags, consent, the day a contact was added (in the company's time zone), where it came from and its country calling code, whether it wrote in the last days (\`last_message\`, which also needs \`conversations.read\`), what happened to a campaign's message to it (\`campaign\`, which also needs \`campaigns.read\`), and the orders it placed in the company's stores or what they totalled in a currency (\`orders\` and \`spend\`, which also need \`orders.read\`), matching all of them or any. Conditions can also be put in groups a contact matches together, all of a group's conditions or any (\`type\` \`group\`, with its own \`match\`), so a search can ask for all of some conditions and any of others: a group holds conditions, not groups, and a search holds at most ${SEGMENT_LIMITS.conditions} conditions in all, those in groups included. Answers as GET /contacts does: newest first, erased contacts left out, pages that never skip or repeat a contact. Each page reads at most ${API_CONTACT_SEARCH_WINDOW.toLocaleString('en-US')} of the company's contacts: when the conditions leave out most of them, a page can hold fewer contacts than \`limit\`, or none, and still give a \`nextCursor\`; send the same conditions with it until it is \`null\`. A condition the company's fields do not allow, or a campaign or store it does not have, is refused, naming it (like \`conditions.1.key\`, or \`conditions.2.conditions.0.key\` in a group). It only reads, so no \`Idempotency-Key\` is needed.`,
          requestBody: { required: true, content: json(ref('ContactSearch')) },
          responses: {
            '200': { description: 'A page of contacts.', content: pageOf('Contact') },
            ...errors(400, 401, 403, 415, 422, 429, 500),
          },
        },
      },
      '/contacts/{id}': {
        get: {
          operationId: 'getContact',
          summary: 'A contact',
          description: `${scopeNote('contacts.read')} ${MERGED_CONTACT_NOTE}`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': { description: 'The contact.', content: json(dataOf(ref('Contact'))) },
            ...errors(401, 403, 404, 429, 500),
          },
        },
        patch: {
          operationId: 'updateContact',
          summary: 'Change a contact’s name, email, number, custom fields or tags',
          description: `${scopeNote('contacts.write')} A field's value must have its type (GET /contact-fields); a refusal names \`fields.<key>\` and saves nothing. Tags are lower-cased, 50 at most per contact. A number changes only when it was typed for the contact, as members change it: one WhatsApp gave (the contact wrote to one of the company's numbers) is the contact's identity and is refused with 412, as is a number on the company's suppression list; a number another contact has is refused with 409, without naming that contact. POST /contacts/update-many changes numbers too; the same change for many contacts does not. What the contact already has changes nothing, so a retry is safe without an \`Idempotency-Key\`. Erased contacts are not found. ${MERGED_CONTACT_NOTE}`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          requestBody: { required: true, content: json(ref('ContactUpdate')) },
          responses: {
            '200': {
              description: 'The contact as it is now.',
              content: json(dataOf(ref('Contact'))),
            },
            ...errors(400, 401, 403, 404, 409, 412, 415, 422, 423, 429, 500),
          },
        },
      },
      '/contacts/update-many': {
        post: {
          operationId: 'updateManyContacts',
          summary: 'Change many contacts’ names, emails, numbers, custom fields or tags at once',
          description: [
            `${scopeNote('contacts.write')} Up to ${API_LIMITS.contactsPerChange} contacts, each with its \`id\` and what PATCH /contacts/{id} takes, each changed as that changes one. All of them or none: a contact of another company or an erased one, a value of another type, an unknown field or a 51st tag refuses the call (422, naming the place, as \`contacts.3.fields.plan\`), and nothing is changed.`,
            'A number changes as PATCH /contacts/{id} changes one: one WhatsApp gave, or one on the company’s suppression list, is refused with 412, and one another contact has with 409. Each number must be free before the call, so a number one of the call’s own contacts has is refused too, whatever the order and even when that contact is given another: a call never swaps or moves numbers between contacts. A number given twice, in any form, is refused with 422. These refusals name the place, as `contacts.2.phone`, and nothing is changed.',
            'The contacts are changed in the order given and answered in it. A call counts as one request against the rate and monthly limits, within the 64 KB a body may hold. What a contact already has changes nothing, so a retry is safe without an `Idempotency-Key`.',
          ].join('\n\n'),
          requestBody: { required: true, content: json(ref('UpdateManyContacts')) },
          responses: {
            '200': {
              description: 'The contacts, as they now are, in the order given.',
              content: json({
                type: 'object',
                properties: { data: { type: 'array', items: ref('Contact') } },
                required: ['data'],
              }),
            },
            ...errors(400, 401, 403, 409, 412, 415, 422, 423, 429, 500),
          },
        },
      },
      '/contacts/update-matching': {
        post: {
          operationId: 'updateMatchingContacts',
          summary: 'Change the contacts a search finds, a page at a time',
          description: [
            `Scopes: \`contacts.read\` and \`contacts.write\`; a \`last_message\` condition also needs \`conversations.read\`, a \`campaign\` condition \`campaigns.read\`, and an \`orders\` or \`spend\` condition \`orders.read\`, as for POST /contacts/search. Takes a search's conditions, groups included, and a change: custom field values (\`fields\`) and tags (\`addTags\`, \`removeTags\`), the same for every contact.`,
            `Each call reads one page of the contacts POST /contacts/search finds with the same conditions (newest first, at most ${API_LIMITS.contactsPerChange} contacts, read in windows of ${API_CONTACT_SEARCH_WINDOW.toLocaleString('en-US')}), changes each of them as PATCH /contacts/{id} changes one and answers them as they now are with \`nextCursor\`: send the same conditions and change with it until it is \`null\`. A page is found by the conditions as they are when it is read, so a contact the change takes out of the search is not read again.`,
            'A field the company does not have, a value of another type, or a contact the change would give more than 50 tags refuses the call (422, naming the part, as `change.fields.plan`), and nothing is changed. The page is read and changed in one transaction: when a contact on it is changed by someone else at the same moment, the call can be refused as a whole (409, changing nothing): send it again with the same cursor. What a contact already has changes nothing, and a contact the change took out of the search is not found again, so a call sent again after a lost answer is safe without an `Idempotency-Key`: the pages still reach every contact the search finds, each changed once. A call counts as one request against the rate and monthly limits.',
          ].join('\n\n'),
          requestBody: { required: true, content: json(ref('UpdateMatchingContacts')) },
          responses: {
            '200': {
              description: 'The page’s contacts, as they now are, and where the next page starts.',
              content: pageOf('Contact'),
            },
            ...errors(400, 401, 403, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/contact-tags': {
        get: {
          operationId: 'listContactTags',
          summary: 'Tags on contacts, alphabetically',
          description: [
            `${scopeNote('contacts.read')} The tags on the company's contacts, alphabetically, each with how many contacts have it when the page is read: the tags contacts carry (\`tags\`), \`GET /contacts\` filters by (\`tag\`) and webhook endpoints name (\`contactTags\`). A tag no contact has any more is not listed.`,
            tagPagesNote,
          ].join('\n\n'),
          parameters: [...pageParams, tagPrefixParam],
          responses: {
            '200': { description: 'A page of tags.', content: pageOf('ContactTag') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
      },
      '/contact-fields': {
        get: {
          operationId: 'listContactFields',
          summary: 'The company’s custom fields',
          description: `${scopeNote('contacts.read', 'contact_fields.manage')} The keys and types of the values \`fields\` holds, by label. Owners and administrators define fields in Settings, and keys with \`contact_fields.manage\` through this API.`,
          responses: {
            '200': {
              description: `The fields (at most ${MAX_CONTACT_FIELDS}).`,
              content: json(dataOf({ type: 'array', items: ref('ContactField') })),
            },
            ...errors(401, 403, 429, 500),
          },
        },
        post: {
          operationId: 'createContactField',
          summary: 'Add a custom field',
          description: `${scopeNote('contact_fields.manage')} A company has at most ${MAX_CONTACT_FIELDS} fields. The key is made from the label unless given; a key the company has is refused with 409 (path \`key\`). The key and the type never change. One field per \`Idempotency-Key\`: a retry answers with the field as first added.`,
          parameters: [{ $ref: '#/components/parameters/IdempotencyKeyOptional' }],
          requestBody: { required: true, content: json(ref('ContactFieldCreate')) },
          responses: {
            '201': { description: 'The field.', content: json(dataOf(ref('ContactField'))) },
            ...errors(400, 401, 403, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/contact-fields/{key}': {
        patch: {
          operationId: 'updateContactField',
          summary: 'Rename a custom field',
          description: `${scopeNote('contact_fields.manage')} Only the label changes: values stay under the key. The same label changes nothing, so a retry is safe without an \`Idempotency-Key\`.`,
          parameters: [{ $ref: '#/components/parameters/FieldKey' }],
          requestBody: { required: true, content: json(ref('ContactFieldUpdate')) },
          responses: {
            '200': { description: 'The field.', content: json(dataOf(ref('ContactField'))) },
            ...errors(400, 401, 403, 404, 415, 422, 423, 429, 500),
          },
        },
        delete: {
          operationId: 'deleteContactField',
          summary: 'Delete a custom field and its values',
          description: `${scopeNote('contact_fields.manage')} Every contact's value for the field is deleted with it, as when a member deletes the field in Settings; segments and automations that use the key find no value. Each contact that had a value appears in GET /contact-changes; no webhook is sent.`,
          parameters: [{ $ref: '#/components/parameters/FieldKey' }],
          responses: {
            '200': {
              description: 'Deleted.',
              content: json(
                dataOf({
                  type: 'object',
                  properties: { key: { type: 'string' }, deleted: { const: true } },
                  required: ['key', 'deleted'],
                }),
              ),
            },
            ...errors(401, 403, 404, 423, 429, 500),
          },
        },
      },
      '/contact-changes': {
        get: {
          operationId: 'listContactChanges',
          summary: 'Contacts in the order they changed',
          description: `${scopeNote('contacts.read')} Every contact whose name, number, email, custom field values, tags or consent changed, that was added or erased, or that another contact was merged into, once, as it is now, in the order the changes were saved, with what changed since your pass through the feed began (\`changes\`). A merged contact is not read again: the contact it was merged into is, naming it in \`mergedContactIds\`. Start without a cursor to read every contact the company has; keep \`nextCursor\` and ask again with it to read what changed since. No change is skipped: a change appears once every change saved before it has finished, and a contact changed again appears again. Read pages until \`hasMore\` is false, then ask again later with the last \`nextCursor\`. A cursor works only for the company that read it.`,
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: API_LIMITS.pageSize, default: 50 },
            },
            {
              name: 'cursor',
              in: 'query',
              schema: { type: 'string', maxLength: 400 },
              description:
                '`nextCursor` from the previous page; none to start from the first change.',
            },
          ],
          responses: {
            '200': {
              description: 'A page of changed contacts.',
              content: json({
                type: 'object',
                properties: {
                  data: { type: 'array', items: ref('ContactChange') },
                  nextCursor: {
                    type: 'string',
                    description: 'Where the next page starts; keep it to ask again later.',
                  },
                  hasMore: {
                    type: 'boolean',
                    description: 'Whether more changes can be read now.',
                  },
                },
                required: ['data', 'nextCursor', 'hasMore'],
              }),
            },
            ...errors(401, 403, 422, 429, 500),
          },
        },
      },
      '/contacts/{id}/consent': {
        post: {
          operationId: 'recordConsent',
          summary: 'Record an opt-in or opt-out',
          description: `${scopeNote('contacts.write')} Recorded with its evidence as consent from the API; marketing templates need the contact's marketing opt-in. ${MERGED_CONTACT_NOTE}`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          requestBody: { required: true, content: json(ref('Consent')) },
          responses: {
            '200': {
              description: 'The contact with its consent.',
              content: json(dataOf(ref('Contact'))),
            },
            ...errors(400, 401, 403, 404, 415, 422, 423, 429, 500),
          },
        },
      },
      '/contacts/{id}/merge': {
        post: {
          operationId: 'mergeContacts',
          summary: 'Merge another contact of the same person into this one',
          description: `${scopeNote('contacts.merge')} Everything of \`mergeContactId\` moves to the contact the path names: its WhatsApp identities, conversations, consent history, tags, deals, tasks and notes, orders, campaign sends, automation runs and Flow answers. The kept contact keeps its name, number, email and custom field values and takes the other's where it has none; an opt-out of either stands, and no opt-in is added. The merged contact is then deleted, which cannot be undone: its id answers 404 with reason \`contact_merged\` and \`mergedInto\`. Refused with 409 for the same contact twice, an erased contact, or a message to the merged contact being sent (try again in a minute), and with 412 when both have a phone number (a contact keeps one), both have a conversation on the same WhatsApp number, they have more than 50 tags between them, or both were sent the same campaign. Endpoints taking \`contact.merged\` are sent the merge. With an \`Idempotency-Key\`, a retry answers the first response. ${MERGED_CONTACT_NOTE}`,
          parameters: [
            { $ref: '#/components/parameters/Id' },
            { $ref: '#/components/parameters/IdempotencyKeyOptional' },
          ],
          requestBody: { required: true, content: json(ref('ContactMerge')) },
          responses: {
            '200': {
              description: 'The contact kept, the contact merged, and what moved.',
              content: json(dataOf(ref('ContactMergeResult'))),
            },
            ...errors(400, 401, 403, 404, 409, 412, 415, 422, 423, 429, 500),
          },
        },
      },
      '/messages': {
        post: {
          operationId: 'sendMessage',
          summary:
            'Send an approved template, or a reply: text, buttons, a list, products, a reaction, media, a location or contacts',
          description: [
            `${scopeNote('messages.send', 'messages.send_marketing', 'messages.reply')}`,
            'A template (`type` `template` or left out): utility templates need `messages.send`, marketing templates `messages.send_marketing`. The contact is created when new; consent, the suppression list and the marketing frequency cap are checked.',
            'A reply (`type` `text`, `buttons`, `list`, `product`, `product_list`, `catalog`, `reaction`, `image`, `video`, `audio`, `document`, `sticker`, `location` or `contacts`) needs `messages.reply` and goes only to a number that wrote to the WhatsApp number in the last 24 hours (WhatsApp’s customer service window); otherwise it is refused with reason `window_closed`, and nothing tells whether the number is a contact. Any reply but a reaction stops an automation answering the conversation, and the conversation keeps waiting for a member of the team. The window is checked again when the message is sent.',
            'Products (`product`: one; `product_list`: up to 30 in sections, with a header; `catalog`: the catalog, opened from a product’s picture) need Commerce in the company’s plan (403, reason `not_in_plan`, otherwise). They are named by their content ids (`retailerId`) in a catalog HyFib has read from Meta for the WhatsApp number (Commerce → Catalogs), still connected, and not removed at Meta; all from one catalog, which `catalogId` names when more than one has them all. Unknown ids are refused by name (422, `products`).',
            'A text, buttons, a list, products, media, a location or contacts can quote a message of the conversation with `replyTo`, its id from `GET /conversations/{id}/messages`, the `message.received` webhook or a send’s response: a message the contact sent, or one the business sent that WhatsApp accepted. A reaction (`type` `reaction`) puts one emoji on a message the contact sent in the last 30 days; reactions cannot be taken back through the API. A message of another conversation, or one that cannot be quoted or reacted to, is refused (422, `replyTo`).',
            'Media (`image`, `video`, `audio`, `document` or `sticker`) is sent from an https:// `link` that WhatsApp fetches when it sends the message, reachable from the internet without signing in; HyFib neither fetches nor keeps the media, and stores the link with the message. A photo, a video or a document may carry a `caption` of up to 1,024 characters; audio and stickers take none, and WhatsApp decides whether a file can be a sticker. A link WhatsApp cannot fetch, or media it does not accept, makes the message fail: `GET /messages/{id}` and the `message.status` webhook report it with WhatsApp’s error. In place of a link, a photo, a video, audio or a document may name a file uploaded with `POST /media` for the number it is sent from in the last 30 days (`mediaId`); the file is sent as WhatsApp keeps it, a document under the name it was uploaded with.',
            'A template whose header is a photo, a video or a document (its `headerMedia` in GET /templates) needs the file in `headerMedia`: an https:// `link` that WhatsApp fetches when it sends the message, as for media below, shown without a caption. Documents must be PDF files. HyFib neither fetches nor keeps the file, and stores the link with the message. Other templates take no file (422, `headerMedia`). A file WhatsApp cannot fetch, or does not accept, makes the message fail: `GET /messages/{id}` and the `message.status` webhook report it with WhatsApp’s error.',
            'A template whose website buttons’ links end with a value (its `links` in GET /templates) needs the end of each link in `variables.buttons`, in the order of `links`: it replaces the link’s {{1}}, holds no spaces and cannot change the website the button opens (422, naming the value, as `variables.buttons.0`). The message keeps the links as sent. Other templates take none.',
            'A location (`location`) is a place given by its `latitude` and `longitude` in decimal degrees, with its `name` and `address` if wanted, up to 1,000 characters each, all stored with the message. A location WhatsApp does not accept makes the message fail: `GET /messages/{id}` and the `message.status` webhook report it with WhatsApp’s error.',
            'Contacts (`contacts`) share 1 to 5 contact cards, as Meta’s spec describes them: each with a `name` (its `formattedName` and at least one other part) and, if wanted, `phones`, `emails`, `urls` and `addresses` (up to 5 of each, each with a `type` of HOME or WORK if wanted), an `org` and a `birthday` (YYYY-MM-DD); each text up to 256 characters, a link up to 2,000. Messages read back give them in `contacts`, as they give the cards customers share. A card WhatsApp does not accept makes the message fail: `GET /messages/{id}` and the `message.status` webhook report it with WhatsApp’s error.',
            'Buttons (up to 3) and lists (up to 10 rows) carry ids you choose: when the customer taps one, the `message.received` webhook gives it as `reply.id`, with `reply.type` (`button` or `list`). Ids cannot start with `w360`, which HyFib’s own buttons use.',
            'Messages queued one after the other may be sent in either order: to be sure the customer sees one before the next, send the next once `GET /messages/{id}` reports the first `accepted`.',
          ].join('\n\n'),
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: {
            required: true,
            content: json({
              oneOf: [
                ref('SendTemplate'),
                ref('SendText'),
                ref('SendButtons'),
                ref('SendList'),
                ref('SendProduct'),
                ref('SendProductList'),
                ref('SendCatalog'),
                ref('SendReaction'),
                ref('SendImage'),
                ref('SendVideo'),
                ref('SendAudio'),
                ref('SendDocument'),
                ref('SendSticker'),
                ref('SendLocation'),
                ref('SendContacts'),
              ],
            }),
          },
          responses: {
            '201': {
              description: 'Queued for sending.',
              content: json(dataOf(ref('QueuedMessage'))),
            },
            ...errors(400, 401, 403, 404, 412, 415, 422, 423, 429, 500),
          },
        },
        get: {
          operationId: 'listMessages',
          summary: 'Messages across every conversation, newest first',
          description: [
            `${scopeNote('conversations.read')} Every message the company's conversations hold, read as \`GET /conversations/{id}/messages\` reads them, with the conversation's contact (\`contactId\`) and the number the message was received on or sent from (\`channelId\`); media is not attached and internal notes are not messages. Messages of erased contacts' conversations are left out.`,
            `Pages never skip or repeat a message. Each page reads at most ${API_MESSAGE_FEED_WINDOW.toLocaleString('en-US')} of the company's messages, newest first: when \`direction\` or \`channelId\` leave out most of them, a page can hold fewer messages than \`limit\`, or none, and still give a \`nextCursor\`; follow it until it is \`null\`.`,
            'To catch up on what you missed (after your receiver was down, say), ask for `since` a little before your previous pass began (a minute) and expect to see some messages again: a message carries the time it began to be saved, so one still being saved while you read can carry an earlier time. Statuses change after a message is created; follow them, exactly, with `GET /message-changes`, or with the `message.status` webhook.',
          ].join('\n\n'),
          parameters: [
            ...pageParams,
            {
              name: 'direction',
              in: 'query',
              schema: { type: 'string', enum: ['inbound', 'outbound'] },
              description:
                'Only messages the contacts wrote (inbound) or the company sent (outbound).',
            },
            {
              name: 'channelId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description: 'Only messages received on or sent from this WhatsApp number.',
            },
            {
              name: 'since',
              in: 'query',
              schema: { type: 'string', format: 'date-time' },
              description: 'Only messages created at or after this time.',
            },
          ],
          responses: {
            '200': { description: 'A page of messages.', content: pageOf('FeedMessage') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
      },
      '/messages/send-many': {
        post: {
          operationId: 'sendManyTemplates',
          summary: 'Send an approved template to many numbers',
          description: [
            `${scopeNote('messages.send', 'messages.send_marketing')} Utility templates need \`messages.send\`, marketing templates \`messages.send_marketing\`. Sends the template to up to ${API_LIMITS.messagesPerSend} numbers, each with the values of its variables and each as POST /messages sends a template: the contact is created when new, and consent, the suppression list and the marketing frequency cap are checked for each. The call counts as one request against the rate and monthly limits, within the 64 KB a body may hold.`,
            'Each number is answered in its place, in the order given, with its message, queued, or with why it was not (the contact erased, opted out, on the suppression list or without the marketing opt-in the company asks for, or at the marketing frequency cap): a refused number changes nothing, a contact created for it included, and the others are still sent. Messages queued together may leave in any order.',
            'Refused as a whole, sending nothing: a template or a WhatsApp number that cannot send (as for one message), a number that is not valid or given twice, values that do not fill the template’s variables, the end of a link a button cannot open, or a header file missing or given when the template takes none (422, naming the place, as `messages.3.variables`, `messages.3.variables.buttons.0` or `messages.3.headerMedia`). One call per `Idempotency-Key`: a retry answers as the first request did.',
            'The call is one transaction holding the conversations it sends in until it ends. When it collides with another call taking several of them at the same moment in another order (another send to many numbers, say), it can be refused as a whole (409, sending nothing): send it again with the same `Idempotency-Key`.',
          ].join('\n\n'),
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: { required: true, content: json(ref('SendManyTemplates')) },
          responses: {
            '200': {
              description: 'Each number, in the order given: its message, or why it was not sent.',
              content: json(dataOf({ type: 'array', items: ref('TemplateSend') })),
            },
            ...errors(400, 401, 403, 404, 409, 412, 415, 422, 423, 429, 500),
          },
        },
      },
      '/conversations': {
        get: {
          operationId: 'listConversations',
          summary: 'Conversations, newest first',
          description: `${scopeNote('conversations.read')} Pages never skip or repeat a conversation. To catch up on changes, ask for \`updatedSince\` a little before your previous pass began (a minute, say) and expect to see some conversations again: a change carries the time it began to be saved, so one still being saved while you read can carry an earlier time. Conversations of erased contacts are not listed.`,
          parameters: [
            ...pageParams,
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: [...CONVERSATION_STATUSES] },
            },
            {
              name: 'contactId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description: 'Only the conversations of this contact.',
            },
            {
              name: 'channelId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description: 'Only the conversations on this WhatsApp number.',
            },
            {
              name: 'assigneeId',
              in: 'query',
              schema: { anyOf: [{ type: 'string', format: 'uuid' }, { const: 'none' }] },
              description:
                'Only the conversations assigned to this member, or `none` for those without one.',
            },
            {
              name: 'teamId',
              in: 'query',
              schema: { anyOf: [{ type: 'string', format: 'uuid' }, { const: 'none' }] },
              description: 'Only the conversations of this team, or `none` for those without one.',
            },
            {
              name: 'updatedSince',
              in: 'query',
              schema: { type: 'string', format: 'date-time' },
              description:
                'Only conversations changed at or after this time (a new message, a status, assignee or tag change, a read).',
            },
            {
              name: 'tag',
              in: 'query',
              schema: { type: 'string', maxLength: 100 },
              description:
                'Only the conversations with this tag, however its letters are cased. A value that cannot be a tag (over 40 characters, or with a comma) is refused (422).',
            },
            {
              name: 'source',
              in: 'query',
              schema: { type: 'string', enum: [...CONVERSATION_SOURCE_KINDS] },
              description:
                'Only the conversations that came from a chat link (`link`: the customer sent its reference) or from a click-to-WhatsApp ad (`ad`), whenever in the conversation.',
            },
            {
              name: 'chatLinkId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description:
                'Only the conversations whose customer sent this chat link’s reference (GET /chat-links), whenever in the conversation; a link’s `last30Days.conversations` counts those of the last 30 days.',
            },
            {
              name: 'adId',
              in: 'query',
              schema: { type: 'string', minLength: 1, maxLength: 128 },
              description:
                'Only the conversations whose customer wrote from this click-to-WhatsApp ad (its `id` in GET /ads), whenever in the conversation; an ad’s `last30Days.conversations` counts those of the last 30 days.',
            },
          ],
          responses: {
            '200': { description: 'A page of conversations.', content: pageOf('Conversation') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
      },
      '/conversations/{id}': {
        get: {
          operationId: 'getConversation',
          summary: 'A conversation',
          description: scopeNote('conversations.read'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'The conversation.',
              content: json(dataOf(ref('Conversation'))),
            },
            ...errors(401, 403, 404, 429, 500),
          },
        },
        patch: {
          operationId: 'updateConversation',
          summary: 'Resolve, reopen, assign, move or tag a conversation',
          description: [
            `${scopeNote('conversations.write')} As members do in the inbox, with any of \`status\`, \`assigneeId\`, \`teamId\`, \`addTags\` and \`removeTags\`, applied together: the team, then the member, then the status, then the tags.`,
            "Resolving stops an automation answering the conversation and ends the wait for a reply; the contact's next message opens the conversation again. No satisfaction survey is sent: surveys follow a member's resolve.",
            'Assigning a member (one from GET /members) stops an automation answering the conversation; `null` unassigns it, and a round-robin team gives it out again within a minute. Moving it to a team (one from GET /teams) gives it to the team’s next available member when the team assigns in turn and the conversation is open with no member. A member who cannot answer conversations, or a team of another company, is refused (422, naming the field). When routing hands the conversation out at the same moment as a move into a team, the request can be refused (409, changing nothing): send it again.',
            `Tags are written as members write them (lower-cased, spaces collapsed, at most 40 characters, no commas), each once; a tag cannot be both added and removed. A conversation has at most ${MAX_TAGS_PER_CONVERSATION} tags: a change that would give it more is refused (422, naming \`addTags\`). A change of the tags is a change of the conversation (\`updatedAt\`).`,
            'What the conversation already has changes nothing, so a retry is safe without an `Idempotency-Key`. Conversations of erased contacts are not found.',
          ].join('\n\n'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          requestBody: { required: true, content: json(ref('UpdateConversation')) },
          responses: {
            '200': {
              description: 'The conversation, as it now is.',
              content: json(dataOf(ref('Conversation'))),
            },
            ...errors(400, 401, 403, 404, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/conversations/update-many': {
        post: {
          operationId: 'updateManyConversations',
          summary: 'Resolve, reopen, assign, move or tag many conversations at once',
          description: [
            `${scopeNote('conversations.write')} Up to ${API_LIMITS.conversationsPerChange} conversations, each changed as PATCH /conversations/{id} changes one, with any of \`status\`, \`assigneeId\`, \`teamId\`, \`addTags\` and \`removeTags\`. All of them or none: an id that names none of the company's conversations (an erased contact's included), a member who cannot answer conversations, a team of another company or a conversation that would have more than ${MAX_TAGS_PER_CONVERSATION} tags refuses the call (422, naming the field, as \`conversationIds.3\`), and nothing is changed.`,
            'The conversations are changed in the order given (a team that assigns in turn gives them out in that order) and answered in it. When routing hands one of them out at the same moment as a move into a team, the call can be refused as a whole (409, changing nothing): send it again. A call counts as one request against the rate and monthly limits. What a conversation already has changes nothing, so a retry is safe without an `Idempotency-Key`.',
          ].join('\n\n'),
          requestBody: { required: true, content: json(ref('UpdateManyConversations')) },
          responses: {
            '200': {
              description: 'The conversations, as they now are, in the order given.',
              content: json({
                type: 'object',
                properties: { data: { type: 'array', items: ref('Conversation') } },
                required: ['data'],
              }),
            },
            ...errors(400, 401, 403, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/conversations/update-matching': {
        post: {
          operationId: 'updateMatchingConversations',
          summary: 'Change the conversations a filter finds, a page at a time',
          description: [
            'Scopes: `conversations.read` and `conversations.write`. Takes the filters of GET /conversations (`filter`, at least one) and a change (`change`): any of `status`, `assigneeId`, `teamId`, `addTags` and `removeTags`, the same for every conversation, applied as PATCH /conversations/{id} applies them: the team, then the member, then the status, then the tags.',
            `Each call reads one page of the conversations GET /conversations lists with the same filters (newest first, at most ${API_LIMITS.conversationsPerChange}), changes each of them as PATCH /conversations/{id} changes one, in that order, and answers them as they now are with \`nextCursor\`: send the same filter and change with it until it is \`null\`. Pages go from newer conversations to older ones, each found by the filters as they are when it is read, so a conversation the change takes out of the filter is not read again. One someone else takes out of the filter between the read and the change is left out, so a page can hold fewer conversations than the limit while more follow. Conversations of erased contacts are left out.`,
            `A member who cannot answer conversations or a team of another company refuses the call (422, naming the field, as \`change.teamId\`), even when no conversation matches, and nothing is changed; so does a conversation of the page that would have more than ${MAX_TAGS_PER_CONVERSATION} tags (\`change.addTags\`). When the call moves conversations into a team while routing hands out one of them, it can be refused as a whole (409, changing nothing): send it again with the same cursor.`,
            'What a conversation already has changes nothing, and one the change took out of the filter is not found again, so a call sent again after a lost answer is safe without an `Idempotency-Key`: the pages still reach every conversation the filter finds, each changed once. A call counts as one request against the rate and monthly limits.',
          ].join('\n\n'),
          requestBody: { required: true, content: json(ref('UpdateMatchingConversations')) },
          responses: {
            '200': {
              description:
                'The page’s conversations, as they now are, and where the next page starts.',
              content: pageOf('Conversation'),
            },
            ...errors(400, 401, 403, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/conversations/{id}/notes': {
        post: {
          operationId: 'addConversationNote',
          summary: 'Add an internal note to a conversation',
          description: [
            `${scopeNote('conversations.write')} The team reads the note in the inbox, named as the key's. WhatsApp never receives it, and nothing else about the conversation changes: its status, assignee and wait for a reply stay as they are.`,
            'One note per `Idempotency-Key`. Conversations of erased contacts are not found.',
          ].join('\n\n'),
          parameters: [
            { $ref: '#/components/parameters/Id' },
            { $ref: '#/components/parameters/IdempotencyKey' },
          ],
          requestBody: { required: true, content: json(ref('AddConversationNote')) },
          responses: {
            '201': { description: 'The note.', content: json(dataOf(ref('ConversationNote'))) },
            ...errors(400, 401, 403, 404, 415, 422, 423, 429, 500),
          },
        },
        get: {
          operationId: 'listConversationNotes',
          summary: 'The internal notes of a conversation, newest first',
          description: `${scopeNote('conversations.read')} What members wrote in the inbox and what keys added through the API, each saying which (\`writtenBy\`) and, for a key's note, which key. Never which member wrote a note or whom it mentions. Conversations of erased contacts are not found.`,
          parameters: [{ $ref: '#/components/parameters/Id' }, ...pageParams],
          responses: {
            '200': { description: 'A page of notes.', content: pageOf('ConversationNote') },
            ...errors(401, 403, 404, 422, 429, 500),
          },
        },
      },
      '/conversations/{id}/messages': {
        get: {
          operationId: 'listConversationMessages',
          summary: 'The messages of a conversation, newest first',
          description: `${scopeNote('conversations.read')} Messages read as the webhooks describe them; media is not attached. Internal notes are not messages.`,
          parameters: [{ $ref: '#/components/parameters/Id' }, ...pageParams],
          responses: {
            '200': { description: 'A page of messages.', content: pageOf('ConversationMessage') },
            ...errors(401, 403, 404, 422, 429, 500),
          },
        },
      },
      '/satisfaction-surveys': {
        get: {
          operationId: 'listSatisfactionSurveys',
          summary: 'Satisfaction surveys, newest first',
          description: [
            `${scopeNote('conversations.read')} The surveys HyFib sends a customer when a member resolves a conversation while satisfaction surveys are on (Settings → Inbox): a question with three buttons, sent only inside the 24-hour window to a customer who has not opted out; or skipped, with the reason. Each survey has its conversation, its message and the customer’s tap by id (both among the conversation’s messages), the score once answered, and the members credited and resolving by id, as GET /members lists them. Newest first by when it was sent or skipped; pages never skip or repeat a survey. Filters combine. The surveys of erased contacts’ conversations are left out, as the conversations are.`,
            'An answer comes later than its survey: to catch up on answers, read the surveys `asked` since you last saw them unanswered, or ask for `createdSince` a little before your previous pass began (a minute, say) and expect to see some surveys again. The question and the buttons’ labels are the company’s settings at the time, in the survey message. Conversations resolved through the API are never surveyed.',
          ].join('\n\n'),
          parameters: [
            ...pageParams,
            {
              name: 'conversationId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description: 'Only this conversation’s surveys.',
            },
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: [...SATISFACTION_SURVEY_STATUSES] },
              description: 'Only the surveys in this status.',
            },
            {
              name: 'createdSince',
              in: 'query',
              schema: { type: 'string', format: 'date-time' },
              description: 'Only the surveys sent or skipped at or after this time.',
            },
          ],
          responses: {
            '200': { description: 'A page of surveys.', content: pageOf('SatisfactionSurvey') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
      },
      '/flows': {
        get: {
          operationId: 'listFlows',
          summary: 'WhatsApp Flows, newest first',
          description: `${scopeNote('flows.read')} The company’s WhatsApp Flows, the forms members send in chats, as the Flows page lists them: those in use, or archived ones with \`archived=true\`, newest first on pages that never skip or repeat a flow. Each with Meta’s status, the keys of its answers, where each answer goes on the contact and the numbers that can send it. Never the Flow JSON or its data endpoint.`,
          parameters: [
            ...pageParams,
            {
              name: 'archived',
              in: 'query',
              schema: { type: 'string', enum: ['true', 'false'] },
              description: '`true`: only archived flows; otherwise only those in use.',
            },
          ],
          responses: {
            '200': { description: 'A page of flows.', content: pageOf('Flow') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
      },
      '/flow-responses': {
        get: {
          operationId: 'listFlowResponses',
          summary: 'Completed forms, newest first',
          description: [
            `${scopeNote('flows.read')} The forms customers completed with the company’s flows, newest first by when they were received, on pages that never skip or repeat one, by flow, contact and time; filters combine. Each with what each mapped answer did to the contact. Erasing a contact deletes its responses.`,
            `Who completed a form (\`contactId\`, \`conversationId\` and \`messageId\`, the customer’s message that completed it) and what they typed (\`answers\`) are given only to keys with \`contacts.read\` too, as members see them on the Flows page only with that permission: other keys get null and may not filter by contact. A form whose token matched no form HyFib sent has no flow (\`flowId\` null) and changed no contact.`,
          ].join('\n\n'),
          parameters: [
            ...pageParams,
            {
              name: 'flowId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description: 'Only this flow’s responses.',
            },
            {
              name: 'contactId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description: 'Only this contact’s responses; needs `contacts.read` too.',
            },
            {
              name: 'receivedSince',
              in: 'query',
              schema: { type: 'string', format: 'date-time' },
              description: 'Only the responses received at or after this time.',
            },
          ],
          responses: {
            '200': { description: 'A page of responses.', content: pageOf('FlowResponse') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
      },
      '/chat-links': {
        get: {
          operationId: 'listChatLinks',
          summary: 'Chat links, newest first',
          description: `${scopeNote('chat_links.read')} The company’s chat links, as the Growth pages list them: short links and QR codes that open a chat with one of its numbers with a message ready to send. Those in use, or archived ones with \`archived=true\`, newest first on pages that never skip or repeat a link. Each with its short link, the wa.me address it opens, its number, and its clicks and the conversations it started in the last 30 days. Visitors are never identified: clicks are counted per link and day only, repeated clicks and automated visits included.`,
          parameters: [
            ...pageParams,
            {
              name: 'archived',
              in: 'query',
              schema: { type: 'string', enum: ['true', 'false'] },
              description: '`true`: only archived links; otherwise only those in use.',
            },
          ],
          responses: {
            '200': { description: 'A page of chat links.', content: pageOf('ChatLink') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
        post: {
          operationId: 'createChatLink',
          summary: 'Add a chat link',
          description: `${scopeNote('chat_links.write')} As members who write campaigns add one under Growth → Chat links: on one of the company’s active numbers (422 otherwise), with a new reference and short link. A company keeps at most ${GROWTH_LIMITS.links} links in use (409 at the limit: archive some first). The link names the key as its author (\`createdBy\` \`api\`), and the audit log names it too. With an \`Idempotency-Key\`, a retry answers the first response.`,
          parameters: [{ $ref: '#/components/parameters/IdempotencyKeyOptional' }],
          requestBody: { required: true, content: json(ref('CreateChatLink')) },
          responses: {
            '201': { description: 'The chat link.', content: json(dataOf(ref('ChatLink'))) },
            ...errors(400, 401, 403, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/chat-links/{id}': {
        get: {
          operationId: 'getChatLink',
          summary: 'A chat link with its clicks per day',
          description: `${scopeNote('chat_links.read')} As GET /chat-links gives it, archived or not, with the days of the last 30 it was clicked on, in the company’s time zone, newest first. A conversation counts for a link when the customer’s message carries the link’s reference (“(ref CODE)”) on the link’s number, so the count is a lower bound: customers can edit the message, and a link without its reference counts none.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'The chat link.',
              content: json(dataOf(ref('ChatLinkDetail'))),
            },
            ...errors(401, 403, 404, 429, 500),
          },
        },
        patch: {
          operationId: 'updateChatLink',
          summary: 'Change, archive or restore a chat link',
          description: `${scopeNote('chat_links.write')} As members edit one under Growth → Chat links: what is given changes and the rest stays as it is, with the same checks as when adding one; a new number must be active. An archived link is changed only once restored (409): \`archived\` archives or restores it, in a request of its own. Its short link, QR code and buttons open nothing while it is archived. With \`expectedVersion\`, a link changed since is refused (409). A change that leaves the link as it is answers it as it is, with no audit entry, so a retry needs no \`Idempotency-Key\`; otherwise the audit log names the key.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          requestBody: { required: true, content: json(ref('UpdateChatLink')) },
          responses: {
            '200': { description: 'The chat link now.', content: json(dataOf(ref('ChatLink'))) },
            ...errors(400, 401, 403, 404, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/ads': {
        get: {
          operationId: 'listAds',
          summary: 'Click-to-WhatsApp ads customers wrote from',
          description: `${scopeNote('ads.read')} The click-to-WhatsApp ads customers wrote from in the last 30 days, as Growth → Ads lists them: at most ${GROWTH_LIMITS.adsShown}, those that started the most conversations first, then the latest, each with the conversations it started and the customers’ messages that came from it. An ad is listed once for each id, type, headline and web address Meta sent with it. HyFib keeps only what identifies an ad, never the ad click id, its image or video addresses or its text, and connects no ad account, so spend and costs are not given. \`GET /conversations?adId=\` finds an ad’s conversations.`,
          responses: {
            '200': {
              description: 'The ads of the last 30 days.',
              content: json(dataOf({ type: 'array', items: ref('Ad') })),
            },
            ...errors(401, 403, 422, 429, 500),
          },
        },
      },
      '/reports': {
        get: {
          operationId: 'getReport',
          summary: 'The company’s report for a period',
          description: [
            `${scopeNote('reports.read')} The numbers the Reports page shows, for one period: messaging outcomes, estimated Meta charges, the inbox and its reply and resolution times, satisfaction surveys, automation runs, CRM deals with each pipeline’s forecast, each member’s activity and the funnel of the campaigns started in the period, with what each metric counts (\`definitions\`). Read as the Reports page reads them, in the company’s time zone and in one snapshot, so they agree with each other and with the page at that moment. Members are named by id and name only, as GET /members names them.`,
            `A period is a preset (\`last_7_days\` by default, \`last_30_days\`, \`this_month\` or \`last_month\`) or \`custom\` days \`from\` and \`to\`, at most ${MAX_PERIOD_DAYS} days and not after today (422 otherwise). Numbers are computed from HyFib’s records when asked: statuses Meta reports late change them later, and the inbox (\`inbox.now\`) and open deals are as they are when asked. Estimated charges are estimates from the published rates, never an invoice.`,
          ].join('\n\n'),
          parameters: [
            {
              name: 'preset',
              in: 'query',
              schema: {
                type: 'string',
                enum: [...PERIOD_PRESETS, 'custom'],
                default: 'last_7_days',
              },
              description: 'The period, ending today, or `custom` for the days `from` and `to`.',
            },
            {
              name: 'from',
              in: 'query',
              schema: { type: 'string', format: 'date' },
              description: 'With `custom`: the first day, YYYY-MM-DD, in the company’s time zone.',
            },
            {
              name: 'to',
              in: 'query',
              schema: { type: 'string', format: 'date' },
              description: 'With `custom`: the last day, included, YYYY-MM-DD.',
            },
          ],
          responses: {
            '200': { description: 'The report.', content: json(dataOf(ref('Report'))) },
            ...errors(401, 403, 422, 429, 500),
          },
        },
      },
      '/members': {
        get: {
          operationId: 'listMembers',
          summary: 'Members conversations can be assigned to, oldest first',
          description: `${scopeNote('conversations.read')} The active members whose role reads and answers conversations, with their teams and whether they take new conversations now. Names only: no email or role.`,
          parameters: pageParams,
          responses: {
            '200': { description: 'A page of members.', content: pageOf('Member') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
      },
      '/business-hours': {
        get: {
          operationId: 'getBusinessHours',
          summary: 'Business hours, and whether the company is open now',
          description: `${scopeNote('business_hours.read', 'business_hours.manage')} The company’s weekly business hours in its time zone, as Settings → Inbox shows them, and whether it is open now (within its hours and not on a closed day), with when it next opens or closes. While the hours are off, or have no opening time, the company counts as always open, as reply-due timers and automations’ off-hours branches take it. Reading works while the company is suspended.`,
          responses: {
            '200': {
              description: 'The business hours.',
              content: json(dataOf(ref('BusinessHours'))),
            },
            ...errors(401, 403, 429, 500),
          },
        },
        put: {
          operationId: 'updateBusinessHours',
          summary: 'Set the business hours',
          description: `${scopeNote('business_hours.manage')} As owners and administrators save them in Settings → Inbox: \`days\` replaces the whole week, Monday first, each day with up to ${MAX_RANGES_PER_DAY} ranges that do not overlap (422 naming \`days.<n>\` otherwise), and \`enabled\` turns the hours on (422 without an opening time) or off. Reply-due timers and automations’ off-hours branches follow them. A week and switch the company already has are answered as they are, with no audit entry, so a retry needs no \`Idempotency-Key\`; otherwise the audit log names the key.`,
          requestBody: { required: true, content: json(ref('UpdateBusinessHours')) },
          responses: {
            '200': {
              description: 'The business hours now.',
              content: json(dataOf(ref('BusinessHours'))),
            },
            ...errors(400, 401, 403, 415, 422, 423, 429, 500),
          },
        },
      },
      '/business-hours/closed-days': {
        get: {
          operationId: 'listClosedDays',
          summary: 'Closed days, in order',
          description: `${scopeNote('business_hours.read', 'business_hours.manage')} The days the company marked closed, from \`from\` to \`to\` (a year at most; from today in the company’s time zone by default), in order, with the span read. Closed days hold no business hours, so reply-due timers wait over them. Reading works while the company is suspended.`,
          parameters: [
            {
              name: 'from',
              in: 'query',
              schema: { type: 'string', format: 'date' },
              description:
                'The first day, YYYY-MM-DD; today in the company’s time zone by default.',
            },
            {
              name: 'to',
              in: 'query',
              schema: { type: 'string', format: 'date' },
              description:
                'The last day, YYYY-MM-DD, at most 365 days after `from`; that by default.',
            },
          ],
          responses: {
            '200': {
              description: 'The closed days in the span.',
              content: json({
                type: 'object',
                properties: {
                  data: { type: 'array', items: ref('ClosedDay') },
                  from: { type: 'string', format: 'date' },
                  to: { type: 'string', format: 'date' },
                },
                required: ['data', 'from', 'to'],
              }),
            },
            ...errors(401, 403, 422, 429, 500),
          },
        },
        post: {
          operationId: 'createClosedDay',
          summary: 'Mark a day closed',
          description: `${scopeNote('business_hours.manage')} As owners and administrators do in Settings → Inbox: the company is closed all that day, in its time zone, whatever its weekly hours (409 when the day is already marked closed). The audit log names the key. With an \`Idempotency-Key\`, a retry answers the first response.`,
          parameters: [{ $ref: '#/components/parameters/IdempotencyKeyOptional' }],
          requestBody: { required: true, content: json(ref('CreateClosedDay')) },
          responses: {
            '201': { description: 'The closed day.', content: json(dataOf(ref('ClosedDay'))) },
            ...errors(400, 401, 403, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/business-hours/closed-days/{id}': {
        delete: {
          operationId: 'deleteClosedDay',
          summary: 'Open a closed day again',
          description: `${scopeNote('business_hours.manage')} As owners and administrators do in Settings → Inbox: the day follows the weekly hours again. A day already opened again answers 404. The audit log names the key.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'Opened again.',
              content: json(
                dataOf({
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    deleted: { const: true },
                    day: { type: 'string', format: 'date' },
                  },
                  required: ['id', 'deleted', 'day'],
                }),
              ),
            },
            ...errors(401, 403, 404, 423, 429, 500),
          },
        },
      },
      '/saved-replies': {
        get: {
          operationId: 'listSavedReplies',
          summary: 'Saved replies, by shortcut',
          description: `${scopeNote('messages.reply', 'saved_replies.manage')} The company’s saved replies, the answers members put in the reply box, all of them (a company keeps at most ${MAX_SAVED_REPLIES}), by shortcut. A reply’s placeholders are left as written: fill {{name}}, {{agent}} and {{company}} before sending it. Reading works while the company is suspended.`,
          responses: {
            '200': {
              description: 'The saved replies.',
              content: json({
                type: 'object',
                properties: { data: { type: 'array', items: ref('SavedReply') } },
                required: ['data'],
              }),
            },
            ...errors(401, 403, 429, 500),
          },
        },
        post: {
          operationId: 'createSavedReply',
          summary: 'Add a saved reply',
          description: `${scopeNote('saved_replies.manage')} As members who supervise the inbox add one in Settings → Saved replies: a shortcut unique in the company (409 otherwise), a title, and the text, with only the placeholders {{name}}, {{agent}} and {{company}} (422 otherwise). A company keeps at most ${MAX_SAVED_REPLIES} (409 at the limit: delete one first). Settings shows it as changed through the API, and the audit log names the key. With an \`Idempotency-Key\`, a retry answers the first response.`,
          parameters: [{ $ref: '#/components/parameters/IdempotencyKeyOptional' }],
          requestBody: { required: true, content: json(ref('CreateSavedReply')) },
          responses: {
            '201': { description: 'The saved reply.', content: json(dataOf(ref('SavedReply'))) },
            ...errors(400, 401, 403, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/saved-replies/{id}': {
        patch: {
          operationId: 'updateSavedReply',
          summary: 'Change a saved reply',
          description: `${scopeNote('saved_replies.manage')} As members save one in Settings → Saved replies: what is given changes and the rest stays as it is, with the same checks as when adding one. A change that leaves the reply as it is answers it as it is, with no audit entry, so a retry needs no \`Idempotency-Key\`; otherwise the audit log names the key.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          requestBody: { required: true, content: json(ref('UpdateSavedReply')) },
          responses: {
            '200': {
              description: 'The saved reply now.',
              content: json(dataOf(ref('SavedReply'))),
            },
            ...errors(400, 401, 403, 404, 409, 415, 422, 423, 429, 500),
          },
        },
        delete: {
          operationId: 'deleteSavedReply',
          summary: 'Delete a saved reply',
          description: `${scopeNote('saved_replies.manage')} As members do in Settings → Saved replies. One already deleted answers 404. The audit log names the key.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'Deleted.',
              content: json(
                dataOf({
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    deleted: { const: true },
                  },
                  required: ['id', 'deleted'],
                }),
              ),
            },
            ...errors(401, 403, 404, 423, 429, 500),
          },
        },
      },
      '/members/{id}': {
        patch: {
          operationId: 'updateMember',
          summary: 'Set whether a member takes conversations',
          description: `${scopeNote('availability.write')} As members who assign conversations switch it in Settings → Teams: \`available\` \`true\` lets routing give the member conversations of their round-robin teams, and \`false\` stops it; the conversations they have stay with them. Only an active member whose role answers conversations is made available (422 otherwise; \`GET /members\` lists them); any of the company’s members can be made unavailable. Making a member available routes waiting conversations again, as Settings does. A member already so is answered as they are, with no audit entry, so a retry needs no \`Idempotency-Key\`; otherwise the audit log names the key and the inbox shows the change at once.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          requestBody: { required: true, content: json(ref('UpdateMember')) },
          responses: {
            '200': {
              description: 'The member’s availability now.',
              content: json(dataOf(ref('MemberAvailability'))),
            },
            ...errors(400, 401, 403, 404, 415, 422, 423, 429, 500),
          },
        },
      },
      '/conversation-tags': {
        get: {
          operationId: 'listConversationTags',
          summary: 'Tags on conversations, alphabetically',
          description: [
            `${scopeNote('conversations.read')} The tags on the company's conversations, alphabetically, each with how many conversations have it when the page is read: the tags conversations carry (\`tags\`), \`GET /conversations\` filters by (\`tag\`), changes add and remove (\`addTags\`, \`removeTags\`) and webhook endpoints name (\`conversationTags\`). A tag no conversation has any more is not listed.`,
            tagPagesNote,
          ].join('\n\n'),
          parameters: [...pageParams, tagPrefixParam],
          responses: {
            '200': { description: 'A page of tags.', content: pageOf('ConversationTag') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
      },
      '/teams': {
        get: {
          operationId: 'listTeams',
          summary: 'Teams, oldest first',
          description: `${scopeNote('conversations.read', 'teams.manage')} The company's teams and how each gives out conversations; GET /teams/{id} gives a team's settings, members and numbers.`,
          parameters: pageParams,
          responses: {
            '200': { description: 'A page of teams.', content: pageOf('Team') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
        post: {
          operationId: 'createTeam',
          summary: 'Add a team',
          description: `${scopeNote('teams.manage')} As members who supervise the inbox add one in Settings → Teams: a name unique among the company’s teams ignoring case (409 otherwise), how it gives out conversations, its routing keywords, members (active members whose role answers conversations; 422 naming \`memberIds\` otherwise) and numbers (the company’s; a number named here leaves the team it was in). A plan may limit how many teams a company has (412 at the limit: delete one first). Waiting conversations are routed again, so some may go to the new team at once. The audit log names the key. With an \`Idempotency-Key\`, a retry answers the first response.`,
          parameters: [{ $ref: '#/components/parameters/IdempotencyKeyOptional' }],
          requestBody: { required: true, content: json(ref('CreateTeam')) },
          responses: {
            '201': {
              description: 'The team added, with its settings.',
              content: json(dataOf(ref('TeamSettings'))),
            },
            ...errors(400, 401, 403, 409, 412, 415, 422, 423, 429, 500),
          },
        },
      },
      '/teams/{id}': {
        get: {
          operationId: 'getTeam',
          summary: 'A team with its settings',
          description: `${scopeNote('teams.manage')} The team’s settings, its active members and its numbers, as Settings → Teams shows them. Reading works while the company is suspended.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': { description: 'The team.', content: json(dataOf(ref('TeamSettings'))) },
            ...errors(401, 403, 404, 429, 500),
          },
        },
        patch: {
          operationId: 'updateTeam',
          summary: 'Change a team',
          description: `${scopeNote('teams.manage')} As members save a team in Settings → Teams: the settings given change and the rest stay as they are; \`memberIds\` and \`channelIds\` replace the team’s lists, though members who cannot answer conversations now (suspended, or given another role) are never in \`memberIds\` and keep their place in the team. The same checks as when adding one apply (409 for a name in use, 422 naming \`memberIds\` or \`channelIds\`). Waiting conversations are routed again. A change that leaves the team as it is answers it as it is, with no audit entry, so a retry needs no \`Idempotency-Key\`; otherwise the audit log names the key.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          requestBody: { required: true, content: json(ref('UpdateTeam')) },
          responses: {
            '200': {
              description: 'The team as it is now.',
              content: json(dataOf(ref('TeamSettings'))),
            },
            ...errors(400, 401, 403, 404, 409, 415, 422, 423, 429, 500),
          },
        },
        delete: {
          operationId: 'deleteTeam',
          summary: 'Delete a team',
          description: `${scopeNote('teams.manage')} As members delete one in Settings → Teams: its conversations leave the team and keep their assignees, its numbers no longer route new conversations to it, and \`conversations\` counts the conversations that left it. A team already deleted answers 404. The audit log names the key.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'Deleted.',
              content: json(
                dataOf({
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    deleted: { const: true },
                    conversations: { type: 'integer', minimum: 0 },
                  },
                  required: ['id', 'deleted', 'conversations'],
                }),
              ),
            },
            ...errors(401, 403, 404, 423, 429, 500),
          },
        },
      },
      '/campaigns': {
        get: {
          operationId: 'listCampaigns',
          summary: 'Campaigns, newest first',
          description: `${scopeNote('campaigns.read')} The company's campaigns, whoever made them, with the counters kept as they run: the audience taken when each was submitted and the recipients queued and skipped. GET /campaigns/{id} adds the results.`,
          parameters: [
            ...pageParams,
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: [...CAMPAIGN_STATUSES] },
              description: 'Only campaigns in this status.',
            },
          ],
          responses: {
            '200': { description: 'A page of campaigns.', content: pageOf('Campaign') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
        post: {
          operationId: 'createCampaign',
          summary: 'Create a campaign draft',
          description: `${scopeNote('campaigns.write')} A draft with the settings given, checked as members' drafts are: the number, template and segment must be the company's (a segment not archived), and conditions are checked by segments' rules (a field's comparisons by its type, a campaign or store of the company; an \`orders\` or \`spend\` condition also needs \`orders.read\`). Settings left out start as a member's new draft does: no number, template or audience, starting at once once submitted, in the company's time zone, sending for 24 hours. A draft sends nothing: a member submits it in the app, or a key submits it for a member's approval (POST /campaigns/{id}/submit), and it sends under the authority of a member allowed to send campaigns; a submission checks what a draft needs (an approved template of the number's WhatsApp account, every variable filled, an audience). Its history in the app names the key. One draft per \`Idempotency-Key\`: a retry answers with the draft as first created.`,
          parameters: [{ $ref: '#/components/parameters/IdempotencyKeyOptional' }],
          requestBody: { required: true, content: json(ref('CreateCampaign')) },
          responses: {
            '201': {
              description: 'The draft, with its settings.',
              content: json(dataOf(ref('CampaignWithResults'))),
            },
            ...errors(400, 401, 403, 404, 415, 422, 423, 429, 500),
          },
        },
      },
      '/campaigns/{id}': {
        get: {
          operationId: 'getCampaign',
          summary: 'A campaign with its results and settings',
          description: `${scopeNote('campaigns.read')} The results are counted when the campaign is read, as its page in the app counts them: messages sent, delivered, read and failed, replies and opt-outs, why recipients were skipped and the commonest WhatsApp error codes of failed messages; null for a draft. Counts only (GET /campaigns/{id}/recipients lists the recipients): never members or costs. A key that also holds \`campaigns.write\` gets its settings, as members edit them while it is a draft, and its version; other keys get null for both.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'The campaign with its results and settings.',
              content: json(dataOf(ref('CampaignWithResults'))),
            },
            ...errors(401, 403, 404, 429, 500),
          },
        },
        patch: {
          operationId: 'updateCampaign',
          summary: 'Edit a campaign draft',
          description: `${scopeNote('campaigns.write')} Changes the settings given and keeps the others, as a member saving the draft would, with the same checks as POST /campaigns. Only a draft is edited: any other status is refused with 409, naming it. With \`expectedVersion\`, a draft changed since you read it (by a member or a key) is refused with 409 and keeps its settings. A retry sets the same settings again. Its history in the app names the key.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          requestBody: { required: true, content: json(ref('UpdateCampaign')) },
          responses: {
            '200': {
              description: 'The draft, with its settings.',
              content: json(dataOf(ref('CampaignWithResults'))),
            },
            ...errors(400, 401, 403, 404, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/campaigns/{id}/review': {
        get: {
          operationId: 'reviewCampaign',
          summary: 'What submitting a campaign draft would do now',
          description: [
            `${scopeNote('campaigns.write')} The draft's review as members see it in the app before they submit it, read now: what must change before a member can submit it, how many contacts it would reach and why the others would be skipped, an upper bound of Meta's charges from the rate card HyFib publishes, when it would start, and whether it would wait for a member's approval. It changes nothing, and is answered whatever the company's status. Counts only: never contacts or members.`,
            'Only a draft is reviewed: any other status is refused with 409, naming it (a submitted campaign keeps the audience it was submitted with, and GET /campaigns/{id} counts its results). A member submits the draft in the app, or a key with POST /campaigns/{id}/submit, and the submission checks it again.',
          ].join('\n\n'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'The review, as read now.',
              content: json(dataOf(ref('CampaignReview'))),
            },
            ...errors(401, 403, 404, 409, 429, 500),
          },
        },
      },
      '/campaigns/{id}/submit': {
        post: {
          operationId: 'submitCampaign',
          summary: 'Submit a campaign draft for a member’s approval',
          description: [
            `${scopeNote('campaigns.write')} Submits the draft as a member submits it in the app: it must be at \`expectedVersion\` and pass the checks its review lists (GET /campaigns/{id}/review), and its audience is taken now (\`audienceCount\`, \`skippedCount\`). It then waits for a member's approval (\`pending_approval\`), whatever the company's settings: a key never starts a campaign. A member who may approve and send campaigns approves it in the app, and it sends under their authority from the time it was set to start, or at once when that time has passed; or a member rejects it with a note or takes it back, or the key withdraws it (POST /campaigns/{id}/withdraw), and it is a draft again at a new version. Its history in the app names the key.`,
            'A draft changed since you read it is refused with 409 and stays a draft; one the checks refuse is refused with 412, naming the first thing to change, and stays a draft. A campaign this key submitted is answered as it is, so a retry changes nothing; any other campaign that is not a draft is refused with 409, naming its status.',
          ].join('\n\n'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          requestBody: { required: true, content: json(ref('SubmitCampaign')) },
          responses: {
            '200': {
              description: 'The campaign, waiting for a member’s approval.',
              content: json(dataOf(ref('Campaign'))),
            },
            ...errors(400, 401, 403, 404, 409, 412, 415, 422, 423, 429, 500),
          },
        },
      },
      '/campaigns/{id}/withdraw': {
        post: {
          operationId: 'withdrawCampaign',
          summary: 'Take back a campaign submission this key made',
          description: [
            `${scopeNote('campaigns.write')} Takes a campaign this key submitted (POST /campaigns/{id}/submit) back to a draft while it waits for a member's approval, as a member takes back their own: its audience is dropped (nothing was sent), its version goes up, and it can be edited and submitted again. Its history in the app names the key.`,
            'A draft is answered as it is, so a retry changes nothing. A submission a member or another key made is refused with 403 (members withdraw it in the app), and a campaign that no longer waits for approval with 409, naming its status.',
          ].join('\n\n'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'The campaign, a draft again.',
              content: json(dataOf(ref('Campaign'))),
            },
            ...errors(401, 403, 404, 409, 423, 429, 500),
          },
        },
      },
      '/campaigns/{id}/recipients': {
        get: {
          operationId: 'listCampaignRecipients',
          summary: 'A campaign’s recipients and what happened to each',
          description: `${scopeNote('campaigns.read')} Also needs \`contacts.read\`, as the list names contacts. The campaign's recipients in a fixed order (by id), on pages that never skip or repeat one: the contact, whether the recipient is waiting, queued, skipped (and why) or was left out when the campaign was canceled, the message queued for it (the id the message feeds, with \`conversations.read\`, and \`message.status\` webhooks give it) with its status and WhatsApp's error, and when a reply and an opt-out were counted for it. \`outcome\` keeps the recipients one count of the campaign's results counts (GET /campaigns/{id}), by the count's own rule, so it lists as many recipients as that count, less those whose contact was erased: the API never lists erased contacts. Each page is read when it is asked for, so outcomes can change between pages while the campaign runs. A draft has no recipients.`,
          parameters: [
            { $ref: '#/components/parameters/Id' },
            ...pageParams,
            {
              name: 'outcome',
              in: 'query',
              schema: { type: 'string', enum: [...RECIPIENT_OUTCOMES] },
              description:
                'Only the recipients this count of the results counts: in_progress is inProgress, message_canceled messagesCanceled and opted_out optedOut.',
            },
          ],
          responses: {
            '200': { description: 'A page of recipients.', content: pageOf('CampaignRecipient') },
            ...errors(401, 403, 404, 422, 429, 500),
          },
        },
      },
      '/campaigns/{id}/pause': {
        post: {
          operationId: 'pauseCampaign',
          summary: 'Pause a campaign',
          description: [
            `${scopeNote('campaigns.stop')} Pauses a scheduled or running campaign as a member pauses it, and its \`pauseReason\` is \`api\`: messages it queued that are not yet on their way to WhatsApp are not sent, and their recipients wait again. A message already on its way cannot be recalled and ends as it ends. Members resume the campaign in the app, and so can a key with \`campaigns.resume\` (POST /campaigns/{id}/resume).`,
            'A paused campaign is answered as it is, whatever paused it, so a retry is harmless. A draft, a campaign waiting for approval, a completed and a cancelled one are refused with 409, naming the status. No `Idempotency-Key` is needed. `campaign.status_changed` webhooks report the change.',
          ].join('\n\n'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'The campaign, as it is now.',
              content: json(dataOf(ref('Campaign'))),
            },
            ...errors(401, 403, 404, 409, 423, 429, 500),
          },
        },
      },
      '/campaigns/{id}/resume': {
        post: {
          operationId: 'resumeCampaign',
          summary: 'Resume a campaign a key paused',
          description: [
            `${scopeNote('campaigns.resume')} Resumes a campaign whose \`pauseReason\` is \`api\`, after the checks members' resuming makes: the template is still approved by Meta and the number active (412 otherwise), neither the message cap nor the spending cap is reached (412: members raise them in the app), and a rate card is published for a spending cap's currency (412). It sends again, or waits for its scheduled time if it never started, under the authority of the member who launched it, who must still be allowed to send campaigns (412 otherwise: a member who can resumes it in the app). Its recipients waiting since the pause are queued again.`,
            'A scheduled or running campaign is answered as it is, so a retry is harmless. A campaign a member or HyFib paused (any other `pauseReason`) is refused with 409, naming it: members resume it in the app. A draft, a campaign waiting for approval, a completed and a cancelled one are refused with 409, naming the status. No `Idempotency-Key` is needed. `campaign.status_changed` webhooks report the change.',
          ].join('\n\n'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'The campaign, as it is now.',
              content: json(dataOf(ref('Campaign'))),
            },
            ...errors(401, 403, 404, 409, 412, 423, 429, 500),
          },
        },
      },
      '/campaigns/{id}/cancel': {
        post: {
          operationId: 'cancelCampaign',
          summary: 'Cancel a campaign',
          description: [
            `${scopeNote('campaigns.stop')} Cancels a campaign waiting for approval, scheduled, running or paused, as a member cancels it: recipients still waiting, and messages it queued that are not yet on their way to WhatsApp, are cancelled (GET /campaigns/{id}/recipients lists them as \`canceled\`, with the message error \`campaign_canceled\` for the messages). A message already on its way cannot be recalled and ends as it ends. A cancelled campaign is never resumed.`,
            'A draft is cancelled by a key with `campaigns.write` instead, as members cancel drafts with the permission of that name. A cancelled or completed campaign is answered as it is to a key with either scope, so a retry is harmless. A draft is refused with 409 to a key without `campaigns.write`: it sends nothing until a member submits it, and members edit or cancel drafts in the app. A key with only `campaigns.write` is refused any other campaign with 403. No `Idempotency-Key` is needed. `campaign.status_changed` webhooks report the change.',
          ].join('\n\n'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'The campaign, as it is now.',
              content: json(dataOf(ref('Campaign'))),
            },
            ...errors(401, 403, 404, 409, 423, 429, 500),
          },
        },
      },
      '/segments': {
        get: {
          operationId: 'listSegments',
          summary: 'Saved segments, newest first',
          description: `${scopeNote('campaigns.read')} The company's saved segments that are not archived, as members' Segments page lists them, each with its conditions in the words POST /contacts/search and drafts' audiences take, and \`problem\` saying why it cannot be used now. A draft's audience takes a segment by its id (\`segmentId\`). GET /segments/{id} counts the contacts one matches. Members create, change and archive segments in the app.`,
          parameters: [...pageParams],
          responses: {
            '200': { description: 'A page of segments.', content: pageOf('Segment') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
        post: {
          operationId: 'createSegment',
          summary: 'Create a saved segment',
          description: `${scopeNote('campaigns.write')} A segment with the name and conditions given, as members create them on the Segments page: each condition is checked as POST /contacts/search checks it (a custom field of the company and a comparison its type takes, a valid tag or date, a campaign or store of the company; an \`orders\` or \`spend\` condition also needs \`orders.read\`), and a problem is refused with 422 naming the condition, like \`definition.conditions.1.key\`. A name another segment of the company has, whatever its case, is refused with 409. Members see it on the Segments page; the audit names the key. One segment per \`Idempotency-Key\`: a retry answers with the segment as first created.`,
          parameters: [{ $ref: '#/components/parameters/IdempotencyKeyOptional' }],
          requestBody: { required: true, content: json(ref('CreateSegment')) },
          responses: {
            '201': {
              description: 'The segment, counted now.',
              content: json(dataOf(ref('SegmentWithCount'))),
            },
            ...errors(400, 401, 403, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/segments/{id}': {
        get: {
          operationId: 'getSegment',
          summary: 'A saved segment with how many contacts match it now',
          description: `${scopeNote('campaigns.read')} One of the company's segments that is not archived, with \`count\`: how many contacts match it now, erased contacts left out, as members' segment page counts them (null when it has a problem). Dates are read in the company's time zone. Counts only: POST /contacts/search with the same conditions finds the contacts, with \`contacts.read\`. An archived segment and another company's are not found.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'The segment, counted now.',
              content: json(dataOf(ref('SegmentWithCount'))),
            },
            ...errors(401, 403, 404, 429, 500),
          },
        },
        patch: {
          operationId: 'updateSegment',
          summary: 'Change a saved segment',
          description: `${scopeNote('campaigns.write')} Changes the name or the conditions given, as members change a segment: what is left out stays, new conditions replace its conditions and are checked as POST /contacts/search checks them, and its version goes up. With \`expectedVersion\`, a segment changed since you read it is refused with 409; so is a name another segment has. Campaigns already submitted keep the audience they were submitted with; drafts with this segment take its new conditions. The audit names the key.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          requestBody: { required: true, content: json(ref('UpdateSegment')) },
          responses: {
            '200': {
              description: 'The segment as changed, counted now.',
              content: json(dataOf(ref('SegmentWithCount'))),
            },
            ...errors(400, 401, 403, 404, 409, 415, 422, 423, 429, 500),
          },
        },
        delete: {
          operationId: 'archiveSegment',
          summary: 'Archive a saved segment',
          description: `${scopeNote('campaigns.write')} Archives it, as members do: it leaves the lists and reads, and its name is free again. Campaigns already submitted keep their audience; a draft with it cannot be submitted until it takes another audience. A segment already archived is answered as it is, so a retry is harmless; another company's is not found. The audit names the key.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'Archived.',
              content: json(
                dataOf({
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    archived: { const: true },
                  },
                  required: ['id', 'archived'],
                }),
              ),
            },
            ...errors(401, 403, 404, 423, 429, 500),
          },
        },
      },
      '/segments/{id}/contacts': {
        get: {
          operationId: 'listSegmentContacts',
          summary: 'The contacts a saved segment holds now, newest first',
          description: `${scopeNote('campaigns.read')} Also needs \`contacts.read\`, \`conversations.read\` for a segment with a \`last_message\` condition and \`orders.read\` for one with an \`orders\` or \`spend\` condition, as POST /contacts/search does. The segment's conditions are read now as members' segment page and campaigns read them, with dates in the company's time zone, and its contacts answered as POST /contacts/search answers them: newest first, erased contacts left out, pages that never skip or repeat a contact. Each page reads at most ${API_CONTACT_SEARCH_WINDOW.toLocaleString('en-US')} of the company's contacts, so a page can hold fewer contacts than \`limit\`, or none, and still give a \`nextCursor\`: follow it until it is \`null\`. A segment with a \`problem\` (GET /segments/{id}) is refused with 412 saying it; an archived segment and another company's are not found.`,
          parameters: [{ $ref: '#/components/parameters/Id' }, ...pageParams],
          responses: {
            '200': { description: 'A page of contacts.', content: pageOf('Contact') },
            ...errors(401, 403, 404, 412, 422, 429, 500),
          },
        },
      },
      '/automations': {
        get: {
          operationId: 'listAutomations',
          summary: 'Automations started through the API, oldest first',
          description: `${scopeNote('automations.start')} Published automations whose trigger is "Started through the API", active or paused, with the inputs each start must give.`,
          parameters: pageParams,
          responses: {
            '200': { description: 'A page of automations.', content: pageOf('Automation') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
      },
      '/automations/{id}/runs': {
        post: {
          operationId: 'startAutomationRun',
          summary: 'Start an automation for a contact',
          description: [
            `${scopeNote('automations.start')} An automation that sends marketing templates also needs \`messages.send_marketing\`. Starts the published automation for the contact with this number (created when new), with every input its trigger declares. The run sends from the automation's number; until the contact replies it sends templates only, each checked for consent (and, for marketing, the frequency cap) when it is sent.`,
            'Refused, changing nothing, when the contact was erased, opted out or is on the suppression list, when a member is assigned to the conversation or another automation handles it, or when the plan has no automation runs left. One run per `Idempotency-Key`: a retry answers as the first request did.',
          ].join('\n\n'),
          parameters: [
            { $ref: '#/components/parameters/Id' },
            { $ref: '#/components/parameters/IdempotencyKey' },
          ],
          requestBody: { required: true, content: json(ref('StartAutomationRun')) },
          responses: {
            '201': {
              description: 'The run, as it starts.',
              content: json(dataOf(ref('AutomationRun'))),
            },
            ...errors(400, 401, 403, 404, 409, 412, 415, 422, 423, 429, 500),
          },
        },
      },
      '/automations/{id}/runs/start-many': {
        post: {
          operationId: 'startManyAutomationRuns',
          summary: 'Start an automation for many contacts',
          description: [
            `${scopeNote('automations.start')} An automation that sends marketing templates also needs \`messages.send_marketing\`. Starts the published automation for up to ${API_LIMITS.runsPerStart} contacts, in the order given, each as POST /automations/{id}/runs starts one: the contact with the number (created when new), with every input its trigger declares. The call counts as one request.`,
            'Each start is answered in its place with its run, or with why it did not start (the contact erased, opted out or on the suppression list, a member assigned to the conversation or another automation handling it, the hourly limit for the conversation, or the plan out of automation runs): a refused start changes nothing, a contact created for it included, and the others still start.',
            'Refused as a whole, starting nothing: an automation that cannot start (as for one run), a number that is not valid or given twice, or inputs the automation does not take (422, naming the place, as `runs.3.inputs`). One call per `Idempotency-Key`: a retry answers as the first request did.',
            'The call is one transaction holding the conversations it starts in until it ends. When it collides with a run starting at the same moment for a contact further down the list, it can be refused as a whole (409, starting nothing): send it again with the same `Idempotency-Key`.',
          ].join('\n\n'),
          parameters: [
            { $ref: '#/components/parameters/Id' },
            { $ref: '#/components/parameters/IdempotencyKey' },
          ],
          requestBody: { required: true, content: json(ref('StartManyAutomationRuns')) },
          responses: {
            '200': {
              description: 'Each start, in the order given: its run, or why it did not start.',
              content: json(dataOf({ type: 'array', items: ref('AutomationRunStart') })),
            },
            ...errors(400, 401, 403, 404, 409, 412, 415, 422, 423, 429, 500),
          },
        },
      },
      '/automation-runs/{id}': {
        get: {
          operationId: 'getAutomationRun',
          summary: 'A run started through the API',
          description: `${scopeNote('automations.start')} Any run a key of the company started.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': { description: 'The run.', content: json(dataOf(ref('AutomationRun'))) },
            ...errors(401, 403, 404, 429, 500),
          },
        },
      },
      '/automation-runs/{id}/stop': {
        post: {
          operationId: 'stopAutomationRun',
          summary: 'Stop a run started through the API',
          description: [
            `${scopeNote('automations.start')} Any run a key of the company started. A running or waiting run ends as \`stopped\` with the reason \`stopped_by_api\`: messages it queued that have not left are cancelled, and the conversation is not handed to people (a customer who wrote waits for a member in the inbox, as after a reply through the API).`,
            'A run that has already ended is answered as it is and nothing changes, so a retry is harmless; its `endReason` says how it ended.',
          ].join('\n\n'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'The run, as it is now.',
              content: json(dataOf(ref('AutomationRun'))),
            },
            ...errors(401, 403, 404, 423, 429, 500),
          },
        },
      },
      '/automation-runs/stop-many': {
        post: {
          operationId: 'stopManyAutomationRuns',
          summary: 'Stop many runs started through the API',
          description: [
            `${scopeNote('automations.start')} Up to ${API_LIMITS.runsPerStop} runs keys of the company started, each stopped as POST /automation-runs/{id}/stop stops one: a running or waiting run ends as \`stopped\` with the reason \`stopped_by_api\`, and a run that has already ended is answered as it is. All of them or none: an id that names no run a key of the company started refuses the call (422, naming the field, as \`runIds.3\`), and nothing is stopped.`,
            'The runs are stopped in the order given and answered in it. A call counts as one request against the rate and monthly limits. A run that has ended stays as it is, so a retry is safe without an `Idempotency-Key`.',
          ].join('\n\n'),
          requestBody: { required: true, content: json(ref('StopManyAutomationRuns')) },
          responses: {
            '200': {
              description: 'The runs, as they now are, in the order given.',
              content: json(dataOf({ type: 'array', items: ref('AutomationRun') })),
            },
            ...errors(400, 401, 403, 415, 422, 423, 429, 500),
          },
        },
      },
      '/orders': {
        get: {
          operationId: 'listOrders',
          summary: 'WhatsApp orders, newest first',
          description: [
            `${scopeNote('orders.read')} The carts customers send from the company’s WhatsApp catalog, as the Orders page lists them, newest first by when they were received; pages never skip or repeat an order. Each order has its items, total and note, with its conversation, contact and number by id. Needs Commerce in the company’s plan (403, reason not_in_plan).`,
            'Amounts are integers in the currency’s minor units (paise for INR). An order’s Payment Links are read with GET /orders/{id}/payment-links, never their address or Razorpay’s ids. An erased contact’s orders are listed without the note, which erasure clears. To catch up on changes, ask for `updatedSince` a little before your previous pass began (a minute, say) and expect to see some orders again: a change carries the time it began to be saved, so one still being saved while you read can carry an earlier time.',
            '`statusChangedBy` says who made an order’s latest status change, with the key for one made through the API (`statusChangedByApiKeyId`), so an integration can tell the orders it changed last from those members or payments did.',
          ].join('\n\n'),
          parameters: [
            ...pageParams,
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: [...ORDER_STATUSES] },
              description: 'Only orders in this status.',
            },
            {
              name: 'contactId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description: 'Only the orders of this contact.',
            },
            {
              name: 'conversationId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description: 'Only the orders sent in this conversation.',
            },
            {
              name: 'reference',
              in: 'query',
              schema: { type: 'string', pattern: ORDER_REFERENCE_PATTERN },
              description:
                'Only the order with this reference, in capitals as members and customers see it.',
            },
            {
              name: 'updatedSince',
              in: 'query',
              schema: { type: 'string', format: 'date-time' },
              description:
                'Only orders changed at or after this time (received, a new status, or the note cleared when the contact was erased).',
            },
          ],
          responses: {
            '200': { description: 'A page of orders.', content: pageOf('Order') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
      },
      '/orders/{id}': {
        get: {
          operationId: 'getOrder',
          summary: 'A WhatsApp order',
          description: `${scopeNote('orders.read')} With its items, total and note. Needs Commerce in the company’s plan (403, reason not_in_plan).`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': { description: 'The order.', content: json(dataOf(ref('Order'))) },
            ...errors(401, 403, 404, 429, 500),
          },
        },
        patch: {
          operationId: 'updateOrder',
          summary: 'Confirm, fulfil or cancel a WhatsApp order',
          description: [
            `${scopeNote('orders.write')} As members do on the order page: a received order is confirmed or cancelled, a confirmed one fulfilled or cancelled, a paid one fulfilled. Needs Commerce in the company’s plan (403, reason not_in_plan). The order’s \`order.status_changed\` webhook event follows, as for a member’s change.`,
            'Any other move is refused (409, naming the order’s status, changing nothing), and so is an order not in `expectedStatus` when you give it. Payment statuses come only from Razorpay, and an order waiting for payment is not changed: cancel its Payment Link first, with POST /orders/{id}/cancel-payment or in the app. Nothing is sent to the customer.',
            'An order that already has the status asked for is answered as it is, whatever `expectedStatus` says, so a retry is safe without an `Idempotency-Key`.',
          ].join('\n\n'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          requestBody: { required: true, content: json(ref('UpdateOrder')) },
          responses: {
            '200': {
              description: 'The order, as it now is.',
              content: json(dataOf(ref('Order'))),
            },
            ...errors(400, 401, 403, 404, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/orders/{id}/payment-links': {
        get: {
          operationId: 'listOrderPaymentLinks',
          summary: 'A WhatsApp order’s Payment Links, newest first',
          description: [
            `${scopeNote('orders.read')} The Payment Links asked for the order, by members on the order page or by API keys, newest first by when they were asked for, as the order page lists them: each one’s status, amount and amount paid, expiry, whether it was sent in the order’s conversation (the message’s id) or why not, what went wrong at Razorpay, and who asked. Needs Commerce in the company’s plan (403, reason not_in_plan).`,
            'Never the link’s address or Razorpay’s ids for the link and its payments: HyFib sends the link in the chat, and members copy it from the order page. Only Razorpay’s report marks a link paid, and with it the order.',
          ].join('\n\n'),
          parameters: [{ $ref: '#/components/parameters/Id' }, ...pageParams],
          responses: {
            '200': {
              description: 'A page of the order’s Payment Links.',
              content: pageOf('PaymentLink'),
            },
            ...errors(401, 403, 404, 422, 429, 500),
          },
        },
      },
      '/orders/{id}/request-payment': {
        post: {
          operationId: 'requestOrderPayment',
          summary: 'Ask the customer to pay a WhatsApp order',
          description: [
            `${scopeNote('orders.request_payment')} As members ask for payment on the order page: a Payment Link for the order’s total from the company’s own Razorpay account, which HyFib creates at Razorpay and sends in the order’s conversation, as the key, while the customer service window is open (otherwise members copy it from the order page). The order waits for payment (\`awaiting_payment\`) until Razorpay reports the link paid, which marks it \`paid\`, or expired or cancelled, which takes it back to \`confirmed\`; \`order.status_changed\` webhook events report each change. Needs Commerce in the company’s plan (403, reason not_in_plan).`,
            'Only a received or confirmed order is asked for (409 otherwise, naming its status, and for an order that already has an open link). Refused with 412 when HyFib could not read the whole cart or work out its total, the total is not in Indian rupees, below ₹1 or above the most HyFib asks for in one link, or the company’s Razorpay account is missing or not checked (members add and check it in Commerce → Payments). Payment statuses come only from Razorpay, never from the API.',
            'With an `Idempotency-Key`, a retry answers the first response; without one, asking again for an order waiting for payment is refused with 409.',
          ].join('\n\n'),
          parameters: [
            { $ref: '#/components/parameters/Id' },
            { $ref: '#/components/parameters/IdempotencyKeyOptional' },
          ],
          responses: {
            '200': {
              description: 'The order, waiting for payment.',
              content: json(dataOf(ref('Order'))),
            },
            ...errors(400, 401, 403, 404, 409, 412, 423, 429, 500),
          },
        },
      },
      '/orders/{id}/cancel-payment': {
        post: {
          operationId: 'cancelOrderPayment',
          summary: 'Cancel a WhatsApp order’s Payment Link',
          description: [
            `${scopeNote('orders.request_payment')} As members cancel a link on the order page: HyFib cancels the order’s open Payment Link at Razorpay, and the order goes back to \`confirmed\` once Razorpay reports the link cancelled, or is marked \`paid\` if the customer paid first; \`order.status_changed\` webhook events report it. Needs Commerce in the company’s plan (403, reason not_in_plan).`,
            'An order without an open link is refused with 409, naming its status. Asking again while the link is being cancelled answers the order as it is, so a retry is harmless until the link has ended. No `Idempotency-Key` is needed.',
          ].join('\n\n'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description:
                'The order, as it is now: still waiting for payment until Razorpay reports the link cancelled.',
              content: json(dataOf(ref('Order'))),
            },
            ...errors(401, 403, 404, 409, 423, 429, 500),
          },
        },
      },
      '/pipelines': {
        get: {
          operationId: 'listPipelines',
          summary: 'CRM pipelines, oldest first',
          description: `${scopeNote('deals.read')} The company’s CRM pipelines, archived ones too, each with its stages in board order and each stage’s chance of winning, read together; pages never skip or repeat a pipeline. Needs the CRM in the company’s plan (403, reason not_in_plan).`,
          parameters: [...pageParams],
          responses: {
            '200': { description: 'A page of pipelines.', content: pageOf('Pipeline') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
        post: {
          operationId: 'createPipeline',
          summary: 'Add a CRM pipeline',
          description: `${scopeNote('pipelines.manage')} As owners and administrators add one in Settings → Pipelines: a name unique among the company’s active pipelines (409 otherwise), a currency for every deal’s value in it, which never changes, and its stages in board order, each with a chance of winning if wanted. It is placed after the company’s other pipelines; a company uses at most ${CRM_LIMITS.pipelines} active pipelines (409 at the limit: archive one first). The pipeline is recorded as added through the API, which Settings shows, and the audit log names the key. Needs the CRM in the company’s plan (403, reason not_in_plan). With an \`Idempotency-Key\`, a retry answers the first response.`,
          parameters: [{ $ref: '#/components/parameters/IdempotencyKeyOptional' }],
          requestBody: { required: true, content: json(ref('CreatePipeline')) },
          responses: {
            '201': {
              description: 'The pipeline added, with its stages.',
              content: json(dataOf(ref('Pipeline'))),
            },
            ...errors(400, 401, 403, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/pipelines/{id}': {
        patch: {
          operationId: 'updatePipeline',
          summary: 'Change, archive or restore a CRM pipeline',
          description: [
            `${scopeNote('pipelines.manage')} As owners and administrators do in Settings → Pipelines. \`name\` renames the pipeline. \`stages\` lists all its stages as they should be, in board order: a stage with its \`id\` is kept with its deals, renamed, moved or given another chance (left out, its chance stays); a stage without one is added; and an active stage left out is removed from the board (archived, as Settings removes stages), refused with 409 while it holds open deals. An archived stage cannot be listed (422) or brought back: the closed deals closed in it keep it. \`archived\` \`true\` archives the pipeline, refused with 409 while it holds open deals, and \`false\` restores it (409 at the company’s limit of ${CRM_LIMITS.pipelines} active pipelines, or when another active pipeline took its name meanwhile); archiving or restoring goes in a request of its own (422), and an archived pipeline is restored before it is changed (409).`,
            'A change that leaves the pipeline as it is (the same name and stages, archiving an archived pipeline, restoring an active one) answers it as it is, with no new version or audit entry. With `expectedVersion`, a pipeline changed since is refused with 409; send it, or an `Idempotency-Key`, when a request adds stages, so a retry never adds them twice. The audit log names the key. Needs the CRM in the company’s plan (403, reason not_in_plan). The currency never changes, and pipelines are never deleted.',
          ].join('\n\n'),
          parameters: [
            { $ref: '#/components/parameters/Id' },
            { $ref: '#/components/parameters/IdempotencyKeyOptional' },
          ],
          requestBody: { required: true, content: json(ref('UpdatePipeline')) },
          responses: {
            '200': {
              description: 'The pipeline as it is now, with its stages.',
              content: json(dataOf(ref('Pipeline'))),
            },
            ...errors(400, 401, 403, 404, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/pipelines/{id}/forecast': {
        get: {
          operationId: 'getPipelineForecast',
          summary: 'A CRM pipeline’s weighted forecast',
          description: `${scopeNote('deals.read')} The pipeline’s open deals in active stages by the month they are expected to close, in the company’s time zone: this month (dates already past included, as on the board), the next two months, later, and without a date, each with the number of deals, their value and that value weighed by each stage’s chance of winning, as Reports shows it. This month’s weighted value is the board’s. Deals in stages without a chance are counted but not weighed (\`dealsWithoutChance\`); a pipeline without any chance has no weighted values. It is read now, in one snapshot, and not stored; an archived pipeline holds no open deals, so its buckets are empty. Needs the CRM in the company’s plan (403, reason not_in_plan).`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'The forecast.',
              content: json(dataOf(ref('PipelineForecast'))),
            },
            ...errors(401, 403, 404, 429, 500),
          },
        },
      },
      '/deals': {
        get: {
          operationId: 'listDeals',
          summary: 'CRM deals, newest first',
          description: [
            `${scopeNote('deals.read')} The company’s CRM deals, open and closed, as the CRM board and the deal page show them, newest first by when they were created; pages never skip or repeat a deal. Filters combine: a deal matches all of them. Each deal has its pipeline, stage, status, value, expected close date and owner, with its contact and conversation by id. Needs the CRM in the company’s plan (403, reason not_in_plan).`,
            'Values are integers in the pipeline currency’s minor units (paise for INR). Notes, tasks and the deal’s timeline are never read here, nor the contact’s name or number, which `contacts.read` reads. An erased contact’s deals are kept, renamed and without a lost reason, as erasure leaves them. To catch up on changes, ask for `updatedSince` a little before your previous pass began (a minute, say) and expect to see some deals again: a change carries the time it began to be saved, so one still being saved while you read can carry an earlier time.',
            '`changedBy` says who made a deal’s latest change of what deal events report, with the key for one made through the API (`changedByApiKeyId`), so an integration can tell the deals it changed last from those members or automations did; `createdBy` and `createdByApiKeyId` say likewise who added it.',
          ].join('\n\n'),
          parameters: [
            ...pageParams,
            {
              name: 'pipelineId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description: 'Only the deals of this pipeline.',
            },
            {
              name: 'stageId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description: 'Only the deals in this stage.',
            },
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: [...DEAL_STATUSES] },
              description: 'Only the deals with this status.',
            },
            {
              name: 'contactId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description: 'Only the deals of this contact.',
            },
            {
              name: 'ownerId',
              in: 'query',
              schema: { anyOf: [{ type: 'string', format: 'uuid' }, { const: 'none' }] },
              description: 'Only the deals this member owns, or `none` for those without an owner.',
            },
            {
              name: 'updatedSince',
              in: 'query',
              schema: { type: 'string', format: 'date-time' },
              description:
                'Only deals changed at or after this time (created, edited, moved, closed or reopened, moved to another contact by a merge, or renamed when their contact was erased).',
            },
          ],
          responses: {
            '200': { description: 'A page of deals.', content: pageOf('Deal') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
        post: {
          operationId: 'createDeal',
          summary: 'Create a CRM deal',
          description: `${scopeNote('deals.write')} As members create a deal on the board: for a contact (not erased) in an active stage of an active pipeline, its first when \`stageId\` is left out, with a title, a value in the pipeline currency’s minor units, an owner who is an active member able to use the CRM (GET /members) and an expected close date. The deal is recorded as created through the API: its timeline and page say so, and the audit log names the key. A pipeline or stage members archived is refused with 409; an unknown pipeline, stage or owner with 422 naming the field. Needs the CRM in the company’s plan (403, reason not_in_plan). With an \`Idempotency-Key\`, a retry answers the first response. ${MERGED_CONTACT_NOTE}`,
          parameters: [{ $ref: '#/components/parameters/IdempotencyKeyOptional' }],
          requestBody: { required: true, content: json(ref('CreateDeal')) },
          responses: {
            '201': { description: 'The deal created.', content: json(dataOf(ref('Deal'))) },
            ...errors(400, 401, 403, 404, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/deals/{id}': {
        get: {
          operationId: 'getDeal',
          summary: 'A CRM deal',
          description: `${scopeNote('deals.read')} As GET /deals gives it. Needs the CRM in the company’s plan (403, reason not_in_plan).`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': { description: 'The deal.', content: json(dataOf(ref('Deal'))) },
            ...errors(401, 403, 404, 429, 500),
          },
        },
        patch: {
          operationId: 'updateDeal',
          summary: 'Change, move, close or reopen a CRM deal',
          description: `${scopeNote('deals.write')} As members do on the deal page, in this order: \`status\` \`open\` reopens a closed deal (in its stage, or its pipeline’s first active stage when its stage was removed); \`stageId\` moves the open deal to another active stage of its pipeline, and \`pipelineId\` to another active pipeline, in \`stageId\` or that pipeline’s first active stage (a deal with a value moves only to a pipeline of its currency: clear the value in a request of its own first, 409 otherwise); the title, the value in the pipeline currency’s minor units, the owner (an active member able to use the CRM, or null) and the expected close date change, except once the deal’s contact is erased (409); \`status\` \`won\` or \`lost\` closes the open deal, with \`lostReason\` for a lost one. A deal already as asked is answered as it is, so a retry changes nothing; a closed deal is not moved, or closed the other way, until it is reopened (409), and a deal in an archived pipeline is not reopened (409). With \`expectedVersion\`, a deal changed since is refused with 409. Each change is on the deal’s timeline as done through the API, and the audit log names the key. Needs the CRM in the company’s plan (403, reason not_in_plan).`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          requestBody: { required: true, content: json(ref('UpdateDeal')) },
          responses: {
            '200': { description: 'The deal as it is now.', content: json(dataOf(ref('Deal'))) },
            ...errors(400, 401, 403, 404, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/deals/{id}/history': {
        get: {
          operationId: 'listDealHistory',
          summary: 'A CRM deal’s history, newest first',
          description: [
            `${scopeNote('deals.read')} The changes the deal events report, as the deal’s timeline keeps them: the deal added, its title, value or expected close date changed, moved to another stage or pipeline, given to another owner, won, lost or reopened, by members, automations and API keys, newest first; pages never skip or repeat a change. Each says who made it (\`changedBy\`, never which member, with the key for one made through the API), so an integration can rebuild how a deal moved, and skip its own changes. Needs the CRM in the company’s plan (403, reason not_in_plan).`,
            'Notes and the deal’s tasks are never given here (`GET /notes` and `GET /tasks` read them), nor the title, date or lost reason before a change. Erasing a contact deletes its timeline, so an erased contact’s deal has no history; a merge keeps the deal’s.',
          ].join('\n\n'),
          parameters: [{ $ref: '#/components/parameters/Id' }, ...pageParams],
          responses: {
            '200': {
              description: 'A page of the deal’s changes.',
              content: pageOf('DealHistoryEntry'),
            },
            ...errors(401, 403, 404, 422, 429, 500),
          },
        },
      },
      '/tasks': {
        get: {
          operationId: 'listTasks',
          summary: 'CRM tasks, newest first',
          description: [
            `${scopeNote('tasks.read')} The company’s CRM tasks, open and closed, as the Tasks page and the contact and deal pages show them, whoever created them (a member, an automation or an API key), newest first by when they were created; pages never skip or repeat a task. Filters combine: a task matches all of them. Each task has its title, notes, due time, reminder, status and assignee, with its contact and deal by id. Needs the CRM in the company’s plan (403, reason not_in_plan).`,
            'The CRM timeline is never read here, nor the contact’s name or number, which `contacts.read` reads. Erasing a contact deletes its tasks, so they are no longer listed, and their ids answer 404; merging contacts moves the merged contact’s tasks to the one kept. To catch up on changes, ask for `updatedSince` a little before your previous pass began (a minute, say) and expect to see some tasks again: a change carries the time it began to be saved, so one still being saved while you read can carry an earlier time.',
            '`changedBy` says who made a task’s latest change of what task events report, with the key for one made through the API (`changedByApiKeyId`), so an integration can tell the tasks it changed last from those members did; `createdBy` and `createdByApiKeyId` say likewise who added it.',
          ].join('\n\n'),
          parameters: [
            ...pageParams,
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: [...TASK_STATUSES] },
              description: 'Only the tasks with this status.',
            },
            {
              name: 'assigneeId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description: 'Only the tasks assigned to this member.',
            },
            {
              name: 'contactId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description: 'Only the tasks about this contact.',
            },
            {
              name: 'dealId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description: 'Only the tasks about this deal.',
            },
            {
              name: 'updatedSince',
              in: 'query',
              schema: { type: 'string', format: 'date-time' },
              description:
                'Only tasks changed at or after this time (created, edited, completed, cancelled or reopened, reminded, or moved to another contact by a merge).',
            },
          ],
          responses: {
            '200': { description: 'A page of tasks.', content: pageOf('Task') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
        post: {
          operationId: 'createTask',
          summary: 'Create a CRM task',
          description: `${scopeNote('tasks.write')} As members create a task on the Tasks page and the contact and deal pages: about a contact (not erased), a deal and so its contact, or nobody, assigned to an active member who can use the CRM (GET /members), with notes, a due time within five years and a reminder emailed to the assignee, from now to a year ahead. The task is recorded as created through the API: the timeline of a task about a contact says so, and the audit log names the key. An unknown assignee or deal, a contact other than the deal’s, or a refused time is answered with 422 naming the field; an unknown or erased contact with 404, and a deal whose contact was erased with 409. Needs the CRM in the company’s plan (403, reason not_in_plan). With an \`Idempotency-Key\`, a retry answers the first response. ${MERGED_CONTACT_NOTE}`,
          parameters: [{ $ref: '#/components/parameters/IdempotencyKeyOptional' }],
          requestBody: { required: true, content: json(ref('CreateTask')) },
          responses: {
            '201': { description: 'The task created.', content: json(dataOf(ref('Task'))) },
            ...errors(400, 401, 403, 404, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/tasks/{id}': {
        get: {
          operationId: 'getTask',
          summary: 'A CRM task',
          description: `${scopeNote('tasks.read')} As GET /tasks gives it. Needs the CRM in the company’s plan (403, reason not_in_plan).`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': { description: 'The task.', content: json(dataOf(ref('Task'))) },
            ...errors(401, 403, 404, 429, 500),
          },
        },
        patch: {
          operationId: 'updateTask',
          summary: 'Change, complete, cancel or reopen a CRM task',
          description: `${scopeNote('tasks.write')} As members do on the Tasks page, in this order: \`status\` \`open\` reopens a closed task (a reminder skipped when it was closed is not brought back); the title, the notes, the assignee (an active member able to use the CRM), the due time (within five years) and the reminder time of the open task change (a new reminder time, from now to a year ahead, is emailed to the assignee then, and null removes it); \`status\` \`done\` completes and \`cancelled\` cancels the open task, skipping a pending reminder. A task’s contact and deal do not change. Only what differs is a change, so a retry changes nothing; a closed task is not changed, or closed the other way, until it is reopened (409). With \`expectedVersion\`, a task changed since is refused with 409. Reopening and closing a task about a contact are on its timeline as done through the API, and the audit log names the key. Needs the CRM in the company’s plan (403, reason not_in_plan).`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          requestBody: { required: true, content: json(ref('UpdateTask')) },
          responses: {
            '200': { description: 'The task as it is now.', content: json(dataOf(ref('Task'))) },
            ...errors(400, 401, 403, 404, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/notes': {
        get: {
          operationId: 'listNotes',
          summary: 'CRM notes, newest first',
          description: [
            `${scopeNote('notes.read')} The notes on the CRM timelines of the company’s contacts and deals, as the contact and deal pages show them, whoever wrote them (a member or an API key), newest first by when they were added; pages never skip or repeat a note. Filters combine: a note matches all of them. Each note has its text and the contact and deal it is about by id, and says who wrote it (\`writtenBy\`), with the key for one added through the API (\`apiKeyId\`), never which member, so an integration can tell the notes it added from members’. Needs the CRM in the company’s plan (403, reason not_in_plan).`,
            'The rest of the timeline (stage moves, closings, tasks done) is never read here, nor the contact’s name or number, which `contacts.read` reads. A note is never changed; erasing a contact deletes its notes, so they are no longer listed and their ids answer 404, and merging contacts moves the merged contact’s notes to the one kept (`contactId` changes; `contact.merged` and GET /contact-changes say when). To catch up, ask for `createdSince` a little before your previous pass began (a minute, say) and expect to see some notes again: a note carries the time it began to be saved, so one still being saved while you read can carry an earlier time.',
          ].join('\n\n'),
          parameters: [
            ...pageParams,
            {
              name: 'contactId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description:
                'Only the notes on this contact’s timeline: about the contact or one of its deals.',
            },
            {
              name: 'dealId',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
              description: 'Only the notes about this deal.',
            },
            {
              name: 'createdSince',
              in: 'query',
              schema: { type: 'string', format: 'date-time' },
              description: 'Only the notes added at or after this time.',
            },
          ],
          responses: {
            '200': { description: 'A page of notes.', content: pageOf('Note') },
            ...errors(401, 403, 422, 429, 500),
          },
        },
        post: {
          operationId: 'createNote',
          summary: 'Add a note to the CRM timeline',
          description: `${scopeNote('notes.write')} As members add a note on the contact and deal pages: to a contact (not erased), or to a deal and so to its contact, up to ${API_NOTE_MAX_LENGTH} characters. The note is recorded as written through the API: the timeline says so, and the audit log names the key, never the note’s text. GET /notes reads notes (\`notes.read\`); the rest of the timeline is not read through the API. An unknown deal or a contact other than the deal’s is answered with 422 naming the field; an unknown or erased contact with 404, and a deal whose contact was erased with 409. Needs the CRM in the company’s plan (403, reason not_in_plan). With an \`Idempotency-Key\`, a retry answers the first response. ${MERGED_CONTACT_NOTE}`,
          parameters: [{ $ref: '#/components/parameters/IdempotencyKeyOptional' }],
          requestBody: { required: true, content: json(ref('CreateNote')) },
          responses: {
            '201': { description: 'The note added.', content: json(dataOf(ref('Note'))) },
            ...errors(400, 401, 403, 404, 409, 415, 422, 423, 429, 500),
          },
        },
      },
      '/notes/{id}': {
        get: {
          operationId: 'getNote',
          summary: 'A CRM note',
          description: `${scopeNote('notes.read')} As GET /notes gives it. The id of any other timeline entry answers 404, as an unknown one does. Needs the CRM in the company’s plan (403, reason not_in_plan).`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': { description: 'The note.', content: json(dataOf(ref('Note'))) },
            ...errors(401, 403, 404, 429, 500),
          },
        },
      },
      '/webhook-endpoints': {
        get: {
          operationId: 'listWebhookEndpoints',
          summary: 'Webhook endpoints API keys added, oldest first',
          description: `${scopeNote('webhooks.manage')} Endpoints members added in Settings → Webhooks are not listed: keys manage only the endpoints keys added, whichever key of the company added them.`,
          responses: {
            '200': {
              description: "The endpoints (at most 10 per company, with members' ones).",
              content: json({
                type: 'object',
                properties: { data: { type: 'array', items: ref('WebhookEndpoint') } },
                required: ['data'],
              }),
            },
            ...errors(401, 403, 423, 429, 500),
          },
        },
        post: {
          operationId: 'createWebhookEndpoint',
          summary: 'Add a webhook endpoint',
          description: [
            `${scopeNote('webhooks.manage')} The endpoint receives the events it names, signed with its secret, from the next event on. The address must be https on the public internet: HyFib never calls private or local addresses. A company has at most ${WEBHOOK_LIMITS.endpoints} endpoints, members' included.`,
            "The secret is in the first response only. One endpoint per `Idempotency-Key`: a retry answers with the endpoint and `secret: null`. The company's owners and administrators are emailed that the key added an endpoint, with its host and events.",
          ].join('\n\n'),
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: { required: true, content: json(ref('CreateWebhookEndpoint')) },
          responses: {
            '201': {
              description: 'The endpoint, with its secret.',
              content: json(dataOf(ref('WebhookEndpointWithSecret'))),
            },
            ...errors(400, 401, 403, 412, 415, 422, 423, 429, 500),
          },
        },
      },
      '/webhook-endpoints/replay-failed': {
        post: {
          operationId: 'replayAllFailedWebhookDeliveries',
          summary: "Deliver every endpoint's failed events again",
          description: `${scopeNote('webhooks.manage')} What POST /webhook-endpoints/{id}/replay-failed does for one endpoint, for every endpoint the API key added that is on, with the same \`since\`, \`events\` and \`failures\`: at most ${WEBHOOK_LIMITS.replayBatch} new deliveries per call across them, endpoint by endpoint in the order they were added, each one's oldest event first. \`more\` says whether another call would queue more, and \`endpoints\` what each endpoint queued. Endpoints that are off are left out; when none is on, the call is refused (412). One call per \`Idempotency-Key\`; audited as the key, once per endpoint.`,
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: { required: true, content: json(ref('ReplayFailedDeliveries')) },
          responses: {
            '200': {
              description:
                'How many deliveries were queued, at each endpoint, and whether more remain.',
              content: json(dataOf(ref('FailedReplayAcrossEndpoints'))),
            },
            ...errors(400, 401, 403, 412, 422, 423, 429, 500),
          },
        },
      },
      '/webhook-endpoints/{id}': {
        get: {
          operationId: 'getWebhookEndpoint',
          summary: 'A webhook endpoint an API key added',
          description: scopeNote('webhooks.manage'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': { description: 'The endpoint.', content: json(dataOf(ref('WebhookEndpoint'))) },
            ...errors(401, 403, 404, 423, 429, 500),
          },
        },
        patch: {
          operationId: 'updateWebhookEndpoint',
          summary: 'Change the events, description, headers or state of an endpoint',
          description: `${scopeNote('webhooks.manage')} The address cannot change: add a new endpoint and delete this one. Turning an endpoint off fails the deliveries waiting for it; turning it on again starts its health afresh. Headers given replace all of the endpoint's headers.`,
          parameters: [{ $ref: '#/components/parameters/Id' }],
          requestBody: { required: true, content: json(ref('UpdateWebhookEndpoint')) },
          responses: {
            '200': { description: 'The endpoint.', content: json(dataOf(ref('WebhookEndpoint'))) },
            ...errors(401, 403, 404, 415, 422, 423, 429, 500),
          },
        },
        delete: {
          operationId: 'deleteWebhookEndpoint',
          summary: 'Delete an endpoint and its delivery history',
          description: scopeNote('webhooks.manage'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'Deleted.',
              content: json(
                dataOf({
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    deleted: { const: true },
                  },
                  required: ['id', 'deleted'],
                }),
              ),
            },
            ...errors(401, 403, 404, 423, 429, 500),
          },
        },
      },
      '/webhook-endpoints/{id}/rotate-secret': {
        post: {
          operationId: 'rotateWebhookEndpointSecret',
          summary: "Replace an endpoint's signing secret",
          description: `${scopeNote('webhooks.manage')} The new secret is in this response only; the previous one signs too (a second \`v1\` in \`W360-Signature\`) for ${WEBHOOK_LIMITS.previousSecretHours} hours, so the receiver can switch without losing deliveries. One rotation per \`Idempotency-Key\`: a retry answers \`secret: null\`.`,
          parameters: [
            { $ref: '#/components/parameters/Id' },
            { $ref: '#/components/parameters/IdempotencyKey' },
          ],
          responses: {
            '200': {
              description: 'The endpoint, with its new secret.',
              content: json(dataOf(ref('WebhookEndpointWithSecret'))),
            },
            ...errors(400, 401, 403, 404, 423, 429, 500),
          },
        },
      },
      '/webhook-endpoints/{id}/deliveries': {
        get: {
          operationId: 'listWebhookDeliveries',
          summary: "An endpoint's deliveries, newest first",
          description: `${scopeNote('webhooks.manage')} Only for endpoints API keys added. Deliveries are kept 30 days; pages never skip or repeat one.`,
          parameters: [
            { $ref: '#/components/parameters/Id' },
            ...pageParams,
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: [...WEBHOOK_DELIVERY_STATES] },
              description: 'Only deliveries in this state.',
            },
          ],
          responses: {
            '200': { description: 'A page of deliveries.', content: pageOf('WebhookDelivery') },
            ...errors(401, 403, 404, 422, 423, 429, 500),
          },
        },
      },
      '/webhook-endpoints/{id}/test': {
        post: {
          operationId: 'sendWebhookTest',
          summary: 'Send an endpoint a test event',
          description: `${scopeNote('webhooks.manage')} Queues a \`ping\` event, signed like any other, for an endpoint that is on (412 otherwise). One test per \`Idempotency-Key\`. Follow its delivery with \`GET /webhook-deliveries/{id}\`.`,
          parameters: [
            { $ref: '#/components/parameters/Id' },
            { $ref: '#/components/parameters/IdempotencyKey' },
          ],
          responses: {
            '201': {
              description: 'The test event’s delivery.',
              content: json(dataOf(ref('WebhookDelivery'))),
            },
            ...errors(400, 401, 403, 404, 412, 423, 429, 500),
          },
        },
      },
      '/webhook-endpoints/{id}/replay-failed': {
        post: {
          operationId: 'replayFailedWebhookDeliveries',
          summary: "Deliver an endpoint's failed events again",
          description: `${scopeNote('webhooks.manage')} Every event whose deliveries to the endpoint all failed, from deliveries queued at or after \`since\` (only those of the \`events\` given, and only those whose latest failed delivery failed in one of the \`failures\` given, when given), is delivered again as a new delivery whose \`replayOf\` names its latest failed one, oldest event first, at most ${WEBHOOK_LIMITS.replayBatch} per call; \`more\` says whether another call would queue more. Left out: events delivered since or already waiting to be, deliveries that failed because what the event names no longer exists (\`event_gone\`), and test events. The endpoint must be on (412 otherwise). One call per \`Idempotency-Key\`; audited as the key, once per call.`,
          parameters: [
            { $ref: '#/components/parameters/Id' },
            { $ref: '#/components/parameters/IdempotencyKey' },
          ],
          requestBody: { required: true, content: json(ref('ReplayFailedDeliveries')) },
          responses: {
            '200': {
              description: 'How many deliveries were queued, and whether more remain.',
              content: json(dataOf(ref('FailedReplay'))),
            },
            ...errors(400, 401, 403, 404, 412, 422, 423, 429, 500),
          },
        },
      },
      '/webhook-deliveries/{id}': {
        get: {
          operationId: 'getWebhookDelivery',
          summary: 'A delivery to an endpoint an API key added',
          description: scopeNote('webhooks.manage'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': { description: 'The delivery.', content: json(dataOf(ref('WebhookDelivery'))) },
            ...errors(401, 403, 404, 423, 429, 500),
          },
        },
      },
      '/webhook-deliveries/{id}/replay': {
        post: {
          operationId: 'replayWebhookDelivery',
          summary: 'Deliver an event again',
          description: `${scopeNote('webhooks.manage')} A delivery that succeeded or failed is delivered again, as a new delivery of the same event to the same endpoint, which must be on (412 otherwise); one still being attempted is refused (409). The payload is built when delivered, so it shows the data as it is then. One replay per \`Idempotency-Key\`; audited as the key.`,
          parameters: [
            { $ref: '#/components/parameters/Id' },
            { $ref: '#/components/parameters/IdempotencyKey' },
          ],
          responses: {
            '201': {
              description: 'The new delivery.',
              content: json(dataOf(ref('WebhookDelivery'))),
            },
            ...errors(400, 401, 403, 404, 409, 412, 423, 429, 500),
          },
        },
      },
      '/messages/{id}': {
        get: {
          operationId: 'getMessage',
          summary: 'The status of a message sent through the API',
          description: scopeNote('messages.send', 'messages.send_marketing', 'messages.reply'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': { description: 'The message.', content: json(dataOf(ref('Message'))) },
            ...errors(401, 403, 404, 429, 500),
          },
        },
      },
      '/media': {
        post: {
          operationId: 'uploadMedia',
          summary: 'Upload a file to send by id',
          description: [
            `${scopeNote('messages.reply')} Uploads a photo (JPEG, PNG), a video (MP4, 3GPP), audio (AAC, AMR, MP3, MP4, OGG) or a document (PDF, text, Word, Excel, PowerPoint) of up to 16 MB to WhatsApp for one of the company's numbers, as multipart form data: \`file\`, and \`from\` (the number's id) when the company has several active numbers. The answer's \`id\` goes in \`POST /messages\` as \`mediaId\`, from that number, as often as needed for 30 days, as long as WhatsApp keeps the file. HyFib keeps no copy.`,
            'WhatsApp may refuse a file it cannot send (422, with its reason). Retrying an upload uploads the file again: it takes no Idempotency-Key.',
          ].join('\n\n'),
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    file: {
                      type: 'string',
                      format: 'binary',
                      description: 'The file, with its type.',
                    },
                    from: {
                      type: 'string',
                      format: 'uuid',
                      description: 'The id of the number to send it from (`GET /channels`).',
                    },
                  },
                  required: ['file'],
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'The file was uploaded.',
              content: json(dataOf(ref('UploadedMedia'))),
            },
            ...errors(400, 401, 403, 404, 412, 415, 422, 429, 500),
            '413': {
              description: 'The body is larger than 16 MB.',
              content: json(ref('Error')),
            },
            '503': {
              description: 'WhatsApp did not answer, so the file was not uploaded: retry later.',
              content: json(ref('Error')),
            },
          },
        },
      },
      '/messages/{id}/media': {
        get: {
          operationId: 'getMessageMedia',
          summary: 'The file a customer sent with a message',
          description: [
            `${scopeNote('conversations.read')} The photo, video, recording, document or sticker a customer sent with a message (\`direction\` \`inbound\`, \`type\` \`image\`, \`video\`, \`audio\`, \`document\` or \`sticker\`, as \`GET /messages\` and \`message.received\` give it), fetched from WhatsApp for this request and passed on as it arrives. HyFib keeps no copy and WhatsApp keeps a file for a limited time, so fetch it soon after it arrives if you need it.`,
            'The answer is the file itself, with the type WhatsApp gave it in `Content-Type` (`application/octet-stream` when it gave none) and `Content-Disposition: attachment` naming it: the name a document came with, or `whatsapp-<type>-<message>.<extension>`. A file is at most 100 MB. Refusals come before the first byte, as JSON errors.',
          ].join('\n\n'),
          parameters: [{ $ref: '#/components/parameters/Id' }],
          responses: {
            '200': {
              description: 'The file, as WhatsApp gave it.',
              content: {
                'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
              },
            },
            ...errors(401, 403, 429, 500),
            '404': {
              description:
                'Not found in the company (a message of an erased contact is not found), or no file to give: the message has none from the customer (reason no_file), or WhatsApp no longer gives it (reason file_expired).',
              content: json(ref('Error')),
            },
            '412': {
              description:
                'The WhatsApp account that received the file is disconnected (reason channel_disconnected), or WhatsApp refused its access (reason access_refused): an administrator reconnects it in Settings → Channels. Or the file is larger than 100 MB (reason file_too_large).',
              content: json(ref('Error')),
            },
            '503': {
              description: 'WhatsApp did not answer or did not give the file: retry later.',
              content: json(ref('Error')),
            },
          },
        },
      },
      '/message-changes': {
        get: {
          operationId: 'listMessageChanges',
          summary: 'Messages in the order they changed',
          description: [
            `${scopeNote('conversations.read')} Every message the company's conversations hold, once, as it is now, in the order its changes were saved: received or sent, its status, status time or error changed, or its contact erased. Each message is given as \`GET /messages\` gives it; a message whose contact was erased is given as erased, with nothing else of it. Start without a cursor to read every message the company has; keep \`nextCursor\` and ask again with it to read what changed since.`,
            'No change is skipped: a change appears once every change saved before it has finished, and a message changed again (a template sent, then delivered, then read) appears again. Read pages until `hasMore` is false, then ask again later with the last `nextCursor`. A cursor works only for the company that read it, and only with this feed.',
          ].join('\n\n'),
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: API_LIMITS.pageSize, default: 50 },
            },
            {
              name: 'cursor',
              in: 'query',
              schema: { type: 'string', maxLength: 400 },
              description:
                '`nextCursor` from the previous page; none to start from the first change.',
            },
          ],
          responses: {
            '200': {
              description: 'A page of changed messages.',
              content: json({
                type: 'object',
                properties: {
                  data: { type: 'array', items: ref('MessageChange') },
                  nextCursor: {
                    type: 'string',
                    description: 'Where the next page starts; keep it to ask again later.',
                  },
                  hasMore: {
                    type: 'boolean',
                    description: 'Whether more changes can be read now.',
                  },
                },
                required: ['data', 'nextCursor', 'hasMore'],
              }),
            },
            ...errors(401, 403, 422, 429, 500),
          },
        },
      },
    },
    webhooks: {
      'message.received': webhook(
        'webhookMessageReceived',
        WEBHOOK_EVENT_INFO['message.received'].label,
        `${WEBHOOK_EVENT_INFO['message.received'].description} An endpoint receives every received message, or only those of the types it names (its \`messageTypes\`). An endpoint that names words and phrases (its \`messageWords\`) receives only the messages whose text, as \`message.text\` gives it, contains one of them, whatever its case, and no message without text.`,
        'WebhookMessageReceived',
      ),
      'message.status': webhook(
        'webhookMessageStatus',
        WEBHOOK_EVENT_INFO['message.status'].label,
        `${WEBHOOK_EVENT_INFO['message.status'].description} An endpoint receives every status unless it names the ones it takes (its \`messageStatuses\`, or the statuses ticked in Settings → Webhooks), and the statuses of every message unless it names who sent them (its \`messageSenders\`, as message.sentBy names them, or the senders ticked in Settings → Webhooks) or the API keys that sent them (its \`messageApiKeyIds\`, as message.apiKeyId names them, a key rotated from or into one of them included, or the keys ticked in Settings → Webhooks); a status no endpoint takes is not recorded.`,
        'WebhookMessageStatus',
      ),
      'consent.changed': webhook(
        'webhookConsentChanged',
        WEBHOOK_EVENT_INFO['consent.changed'].label,
        WEBHOOK_EVENT_INFO['consent.changed'].description,
        'WebhookConsentChanged',
      ),
      'template.status_changed': webhook(
        'webhookTemplateStatusChanged',
        WEBHOOK_EVENT_INFO['template.status_changed'].label,
        `${WEBHOOK_EVENT_INFO['template.status_changed'].description} An endpoint receives every status unless it names the statuses it takes (its \`templateStatuses\`, or the statuses ticked in Settings → Webhooks).`,
        'WebhookTemplateStatusChanged',
      ),
      'conversation.status_changed': webhook(
        'webhookConversationStatusChanged',
        WEBHOOK_EVENT_INFO['conversation.status_changed'].label,
        `${WEBHOOK_EVENT_INFO['conversation.status_changed'].description} An endpoint receives every status unless it names the statuses it takes (its \`conversationStatuses\`, or the statuses ticked in Settings → Webhooks).`,
        'WebhookConversationStatusChanged',
      ),
      'conversation.assignment_changed': webhook(
        'webhookConversationAssignmentChanged',
        WEBHOOK_EVENT_INFO['conversation.assignment_changed'].label,
        `${WEBHOOK_EVENT_INFO['conversation.assignment_changed'].description} conversation.assigneeId and conversation.previousAssigneeId are the change (members as GET /members lists them); the rest is the conversation when the event is delivered. Deliveries are not ordered: the latest change is the one with the latest createdAt. createdAt is given to the millisecond, and one request can change the member twice (taking it off and moving the conversation to a team whose routing gives it out again): createdAtExact gives each change's own time to the microsecond, as it was captured, which tells the two apart.`,
        'WebhookConversationAssignmentChanged',
      ),
      'conversation.team_changed': webhook(
        'webhookConversationTeamChanged',
        WEBHOOK_EVENT_INFO['conversation.team_changed'].label,
        `${WEBHOOK_EVENT_INFO['conversation.team_changed'].description} conversation.teamId and conversation.previousTeamId are the change (teams as GET /teams lists them); the rest is the conversation when the event is delivered. Deleting a team sends one event for each of its conversations. Deliveries are not ordered: the latest change is the one with the latest createdAt.`,
        'WebhookConversationTeamChanged',
      ),
      'satisfaction_survey.answered': webhook(
        'webhookSatisfactionSurveyAnswered',
        WEBHOOK_EVENT_INFO['satisfaction_survey.answered'].label,
        `${WEBHOOK_EVENT_INFO['satisfaction_survey.answered'].description} The survey is the survey as GET /satisfaction-surveys reads it when the event is delivered: its score (3 for the first and best button, 1 for the third), the customer’s tap and the survey message by id among the conversation’s messages, and the members credited and resolving by id. Only the customer’s first tap answers a survey, so a survey is answered once and this event is sent once for it; surveys skipped or never answered send nothing. It happens on the conversation’s WhatsApp number, so an endpoint that names numbers receives it for those numbers only; the team, member and tag filters of conversations’ events do not narrow it. An endpoint receives every answer unless it names the scores it takes (its \`surveyScores\`, or the scores ticked in Settings → Webhooks). It can name as well the members credited with the answers it takes (its \`surveyAssigneeIds\`: the member the conversation was assigned to when it was resolved, the survey’s assigneeId) and the teams whose conversations’ answers it takes (its \`surveyTeamIds\`: the team the conversation is in when the customer answers), in Settings → Webhooks too; an answer credited to no member, or of a conversation in no team, matches no such list, and with more than one list an answer must pass them all. Tags narrow it too (its \`surveyContactTags\` and \`surveyConversationTags\`, or the tags given in Settings → Webhooks): an answer is sent when the answering contact, or its conversation, has any of the tags when the customer answers. Deliveries are not ordered.`,
        'WebhookSatisfactionSurveyAnswered',
      ),
      'contact.created': webhook(
        'webhookContactCreated',
        WEBHOOK_EVENT_INFO['contact.created'].label,
        `${WEBHOOK_EVENT_INFO['contact.created'].description} An import sends one per contact added. An endpoint that names tags (its \`contactEventTags\`, or the tags given in Settings → Webhooks) receives it for a contact the change that adds it tags with one of them, and one that names custom field values, words or ranges (its \`contactEventFieldValues\`) for a contact the change that adds it makes pass one of them.`,
        'WebhookContactCreated',
      ),
      'contact.updated': webhook(
        'webhookContactUpdated',
        WEBHOOK_EVENT_INFO['contact.updated'].label,
        `${WEBHOOK_EVENT_INFO['contact.updated'].description} One event per contact for each change saved; a contact added in the same change is sent as contact.created only. An endpoint receives every change unless it names the parts it takes (its \`contactParts\`, or the parts ticked in Settings → Webhooks): then it receives the events whose changes name one of them, each naming every part that changed. An endpoint that names tags (its \`contactEventTags\`) receives the changes of contacts that have one of them when they are saved, and the changes that add or remove one; one that names custom field values, words or ranges (its \`contactEventFieldValues\`) receives the changes of contacts that pass one of them when they are saved, and the changes of those fields.`,
        'WebhookContactUpdated',
      ),
      'contact.erased': webhook(
        'webhookContactErased',
        WEBHOOK_EVENT_INFO['contact.erased'].label,
        WEBHOOK_EVENT_INFO['contact.erased'].description,
        'WebhookContactErased',
      ),
      'contact.merged': webhook(
        'webhookContactMerged',
        WEBHOOK_EVENT_INFO['contact.merged'].label,
        `${WEBHOOK_EVENT_INFO['contact.merged'].description} One event per merge. The merged contact's id is no longer found: GET /contacts/{id} answers 404 with reason \`contact_merged\` and \`mergedInto\`, the contact it belongs to now. What the merge changed of the kept contact is sent as contact.updated; a contact.created or contact.updated of the merged contact not yet delivered is not sent.`,
        'WebhookContactMerged',
      ),
      'automation.run_started': webhook(
        'webhookAutomationRunStarted',
        WEBHOOK_EVENT_INFO['automation.run_started'].label,
        `${WEBHOOK_EVENT_INFO['automation.run_started'].description} For a run started through the API, run.id is the id POST /automations/{id}/runs answered and run.apiKeyId names the key that called it. An endpoint receives every automation's runs unless it names the automations it takes (its \`automationIds\`, or the automations chosen in Settings → Webhooks), and every run unless it names the API keys whose runs it takes (its \`runApiKeyIds\`, or the keys ticked in Settings → Webhooks): then it receives the runs those keys started, or a key rotated from or into one of them.`,
        'WebhookAutomationRunStarted',
      ),
      'automation.run_ended': webhook(
        'webhookAutomationRunEnded',
        WEBHOOK_EVENT_INFO['automation.run_ended'].label,
        `${WEBHOOK_EVENT_INFO['automation.run_ended'].description} Deliveries are not ordered: the end of a short run can arrive before its start, so compare run.startedAt and run.endedAt. An endpoint that names the automations or API keys it takes receives only their runs, as for automation.run_started, and an endpoint receives every end unless it names the statuses it takes (its \`runEndStatuses\`, or the endings ticked in Settings → Webhooks).`,
        'WebhookAutomationRunEnded',
      ),
      'automation.run_step': webhook(
        'webhookAutomationRunStep',
        WEBHOOK_EVENT_INFO['automation.run_step'].label,
        `${WEBHOOK_EVENT_INFO['automation.run_step'].description} One event for each step a live run records in its log, its start included (step 0), alongside the run's automation.run_started and automation.run_ended. The step gives its number in the run, the kind of node it ran, its outcome and the message it sent; never the branch it took (for an answered question, the title of the button the customer tapped, which is their answer: run events never send a run's answers) or the step's detail (a note for the run's page in Automations, such as what started the run, a web request's status or why a send was refused). Deliveries are not ordered: order a run's steps by step.number. An endpoint that names the automations, what started the runs, the API keys or the numbers it takes receives only those runs' steps, as for automation.run_started; a run's end statuses and end reasons do not narrow its steps. An endpoint receives every step unless it names the outcomes it takes (its \`runStepOutcomes\`, or the outcomes ticked in Settings → Webhooks), or the kinds of node it takes (its \`runStepNodeTypes\`, outside_node standing for the steps outside a node, or the kinds ticked there).`,
        'WebhookAutomationRunStep',
      ),
      'order.received': webhook(
        'webhookOrderReceived',
        WEBHOOK_EVENT_INFO['order.received'].label,
        `${WEBHOOK_EVENT_INFO['order.received'].description} The order message itself is also sent as message.received (type order). Amounts are integers in the currency’s minor units.`,
        'WebhookOrderReceived',
      ),
      'order.status_changed': webhook(
        'webhookOrderStatusChanged',
        WEBHOOK_EVENT_INFO['order.status_changed'].label,
        `${WEBHOOK_EVENT_INFO['order.status_changed'].description} order.status and order.previousStatus are the change, and order.changedBy who made it: a member, an API key (order.apiKeyId names it, so an integration can tell its own changes from others') or HyFib applying the order’s Payment Link; the rest is the order when the event is delivered. Deliveries are not ordered: the latest change is the one with the latest createdAt. An endpoint receives every status unless it names the statuses it takes (its \`orderStatuses\`, or the statuses ticked in Settings → Webhooks), and every change unless it names who made the changes it takes (its \`orderChangeMakers\`, or the makers ticked in Settings → Webhooks): then the changes they made only, and those HyFib did not record the maker of, so an integration that moves orders through the API can leave out the changes keys make; or it can leave out only the changes chosen keys made (its \`orderExcludedApiKeyIds\`, a key rotated from or into one of them included), to be sent every change but its own.`,
        'WebhookOrderStatusChanged',
      ),
      'payment_link.status_changed': webhook(
        'webhookPaymentLinkStatusChanged',
        WEBHOOK_EVENT_INFO['payment_link.status_changed'].label,
        `${WEBHOOK_EVENT_INFO['payment_link.status_changed'].description} paymentLink.status and paymentLink.previousStatus are the change, as the worker wrote it from what it did at Razorpay or what Razorpay reported; the rest is the link as GET /orders/{id}/payment-links reads it when the event is delivered: its amounts, expiry, the message that sent it in the chat or why it was not sent (notSentReason), what went wrong at Razorpay, and who asked for it (a member, never which, or an API key by its id). Never the link’s address or Razorpay’s ids. Only a link Razorpay reports paid marks the order paid, which order.status_changed reports. Asking for payment and asking to cancel a link send no event of their own here: the link is \`creating\` until the worker creates it, and cancelled when Razorpay reports it. An endpoint receives every status unless it names the statuses it takes (its \`paymentLinkStatuses\`, or the statuses ticked in Settings → Webhooks), and every link's changes unless it names the API keys whose links it takes (its \`paymentLinkApiKeyIds\`, a key rotated from or into one of them included): then those of the links they asked for only. It happens on the order’s WhatsApp number, so an endpoint that names numbers receives it for those numbers only. Deliveries are not ordered: the latest change is the one with the latest createdAt.`,
        'WebhookPaymentLinkStatusChanged',
      ),
      'store_order.cod_answered': webhook(
        'webhookStoreOrderCodAnswered',
        WEBHOOK_EVENT_INFO['store_order.cod_answered'].label,
        `${WEBHOOK_EVENT_INFO['store_order.cod_answered'].description} A store’s cash on delivery message carries two quick-reply buttons, one confirming the order and one cancelling it, and HyFib changes nothing in the store: this event is how an order system learns the answer. confirmation.answer and confirmation.previousAnswer are the change, with when the customer tapped and the tap’s message, as captured; the order is HyFib’s copy of the store’s order and the store the one it came from, as they are when the event is delivered, with the store’s own order id (storeOrder.externalId) to find it there. Never the customer’s details from the store: contact is the conversation’s contact, as erasure left it. The event is sent for the first answer and whenever a later tap replaces it with the other one; a tap that repeats the answer, an older tap arriving late and a tap outside the confirmation’s conversation send nothing. Store orders themselves are not sent: the store reports them through its own webhooks. It happens on the WhatsApp number the confirmation was sent from, so an endpoint that names numbers receives it for those numbers only. A confirmation is deleted with its order or its store, after which a delivery not yet made fails as event_gone. Deliveries are not ordered: the latest answer is the one with the latest createdAt.`,
        'WebhookStoreOrderCodAnswered',
      ),
      'campaign.status_changed': webhook(
        'webhookCampaignStatusChanged',
        WEBHOOK_EVENT_INFO['campaign.status_changed'].label,
        `${WEBHOOK_EVENT_INFO['campaign.status_changed'].description} campaign.status and campaign.previousStatus are the change, with why it paused or completed; the rest is the campaign when the event is delivered. campaign.results are its results as GET /campaigns/{id} counts them, counted when the request is built, so a retry or a replay counts again; null while it is a draft. Deliveries are not ordered: the latest change is the one with the latest createdAt. An endpoint receives every status unless it names the statuses it takes (its \`campaignStatuses\`, or the statuses ticked in Settings → Webhooks).`,
        'WebhookCampaignStatusChanged',
      ),
      'deal.created': webhook(
        'webhookDealCreated',
        WEBHOOK_EVENT_INFO['deal.created'].label,
        `${WEBHOOK_EVENT_INFO['deal.created'].description} deal.stageId, deal.pipelineId and deal.status are those it was added with; the rest is the deal when the event is delivered, so a deal whose contact was erased is sent as erasure left it, without the contact's number or name. Read deals with GET /deals/{id} (\`deals.read\`). Every deal event's deal.changedBy says who made what it reports, as captured: a member, an automation or an API key, which deal.apiKeyId names, so an integration that changes deals through the API can tell its own changes from others'.`,
        'WebhookDealCreated',
      ),
      'deal.updated': webhook(
        'webhookDealUpdated',
        WEBHOOK_EVENT_INFO['deal.updated'].label,
        `${WEBHOOK_EVENT_INFO['deal.updated'].description} changes names what changed (title, valueMinor, expectedCloseOn), never the values before: the deal is the deal when the event is delivered, so a deal changed again since gives its latest details, and a deal whose contact was erased is sent as erasure left it. One change can also move, reopen, close or give the deal to another owner, and then sends deal.stage_changed, deal.status_changed and deal.owner_changed as well, in the order the steps happen: reopened, moved, details changed, given to another owner, closed; they can have the same createdAt. Pipelines, stages and owners an endpoint names narrow it as the other deal events. An endpoint receives every change unless it names the details it takes (its \`dealDetails\`, or the details ticked in Settings → Webhooks): a change is sent when it changed one of them, and its changes still name every detail it changed. Deliveries are not ordered: the latest change is the one with the latest createdAt.`,
        'WebhookDealUpdated',
      ),
      'deal.stage_changed': webhook(
        'webhookDealStageChanged',
        WEBHOOK_EVENT_INFO['deal.stage_changed'].label,
        `${WEBHOOK_EVENT_INFO['deal.stage_changed'].description} deal.stageId and deal.previousStageId are the move, with deal.previousPipelineId when it moved to another pipeline, and deal.status is its status as it moved; the rest is the deal when the event is delivered. One change can also reopen or close the deal, and then sends deal.status_changed as well, in the order the steps happen (a closed deal never moves): a deal reopened in another stage, because its stage was removed, is reopened and then moved; a deal one request moves and closes is moved and then closed. Each event gives the deal as its step left it; the two can have the same createdAt. Deliveries are not ordered: the latest move is the one with the latest createdAt.`,
        'WebhookDealStageChanged',
      ),
      'deal.owner_changed': webhook(
        'webhookDealOwnerChanged',
        WEBHOOK_EVENT_INFO['deal.owner_changed'].label,
        `${WEBHOOK_EVENT_INFO['deal.owner_changed'].description} deal.ownerId and deal.previousOwnerId are the change (null for no owner), with the stage, pipeline and status the deal had; the rest is the deal when the event is delivered. One change can also move, reopen or close the deal or change its details, and then sends deal.stage_changed, deal.status_changed and deal.updated as well, in the order the steps happen: reopened, moved, details changed, given to another owner, closed; each event gives the deal as its step left it, and they can have the same createdAt. An endpoint that names owners (its \`ownerIds\`) receives it for the owner the deal left as well as for the one it was given to. Deliveries are not ordered: the latest change is the one with the latest createdAt.`,
        'WebhookDealOwnerChanged',
      ),
      'deal.status_changed': webhook(
        'webhookDealStatusChanged',
        WEBHOOK_EVENT_INFO['deal.status_changed'].label,
        `${WEBHOOK_EVENT_INFO['deal.status_changed'].description} deal.status and deal.previousStatus are the change (open, won or lost), with the stage and pipeline it was in; the rest is the deal when the event is delivered, so deal.lostReason is its reason then. A change that also moves the deal sends deal.stage_changed as well (see it for their order). An endpoint receives every status unless it names the statuses it takes (its \`dealStatuses\`, or the statuses ticked in Settings → Webhooks). Deliveries are not ordered: the latest change is the one with the latest createdAt.`,
        'WebhookDealStatusChanged',
      ),
      'task.created': webhook(
        'webhookTaskCreated',
        WEBHOOK_EVENT_INFO['task.created'].label,
        `${WEBHOOK_EVENT_INFO['task.created'].description} task.status is the one it was added with; the rest is the task when the event is delivered. A task’s notes are never sent: read the task with GET /tasks/{id} (\`tasks.read\`). Erasing a contact deletes its tasks, so the events of an erased contact’s task are no longer delivered. Every task event's task.changedBy says who made what it reports, as captured: a member, an automation (which only adds tasks) or an API key, which task.apiKeyId names, so an integration that changes tasks through the API can tell its own changes from others'.`,
        'WebhookTaskCreated',
      ),
      'task.updated': webhook(
        'webhookTaskUpdated',
        WEBHOOK_EVENT_INFO['task.updated'].label,
        `${WEBHOOK_EVENT_INFO['task.updated'].description} changes names what changed (title, notes, dueAt, remindAt), never the values before: the task is the task when the event is delivered, so a task changed again since gives its latest title and due time, and its notes and reminder are never sent: read them with GET /tasks/{id} (\`tasks.read\`). One change can also give the task to another member, and one through the API can also reopen or close it, and then sends task.assignee_changed and task.status_changed as well, in the order the steps happen: reopened, details changed, given to another member, closed; they can have the same createdAt. Assignees an endpoint names narrow it as the other task events. An endpoint receives every change unless it names the details it takes (its \`taskDetails\`, or the details ticked in Settings → Webhooks): a change is sent when it changed one of them, and its changes still name every detail it changed. Deliveries are not ordered: the latest change is the one with the latest createdAt.`,
        'WebhookTaskUpdated',
      ),
      'task.assignee_changed': webhook(
        'webhookTaskAssigneeChanged',
        WEBHOOK_EVENT_INFO['task.assignee_changed'].label,
        `${WEBHOOK_EVENT_INFO['task.assignee_changed'].description} task.assigneeId and task.previousAssigneeId are the change, with the status the task had; the rest is the task when the event is delivered. One change can also change the task’s details, and one through the API can also reopen or close it, and then sends task.updated and task.status_changed as well, in the order the steps happen: reopened, details changed, given to another member, closed; each event gives the task as its step left it, and they can have the same createdAt. An endpoint that names assignees (its \`taskAssigneeIds\`) receives it for the member the task left as well as for the one it was given to. Deliveries are not ordered: the latest change is the one with the latest createdAt.`,
        'WebhookTaskAssigneeChanged',
      ),
      'task.status_changed': webhook(
        'webhookTaskStatusChanged',
        WEBHOOK_EVENT_INFO['task.status_changed'].label,
        `${WEBHOOK_EVENT_INFO['task.status_changed'].description} task.status and task.previousStatus are the change (open, done or cancelled); the rest is the task when the event is delivered. An endpoint receives every status unless it names the statuses it takes (its \`taskStatuses\`, or the statuses ticked in Settings → Webhooks). Editing its title, notes, due time or reminder sends task.updated, and giving it to another member task.assignee_changed. Deliveries are not ordered: the latest change is the one with the latest createdAt.`,
        'WebhookTaskStatusChanged',
      ),
      'note.created': webhook(
        'webhookNoteCreated',
        WEBHOOK_EVENT_INFO['note.created'].label,
        `${WEBHOOK_EVENT_INFO['note.created'].description} The note is the note when the event is delivered: the deal it is about, who wrote it (\`note.writtenBy\`: a member, never which, or an API key, named by note.apiKeyId, so an integration that adds notes through the API can tell its own from members’), and its contact, the contact kept when a merge has moved it. Never the note’s text, which may hold anything a member wrote: read the note with GET /notes/{id} (\`notes.read\`). Notes are never changed, so no other note event is sent; erasing a contact deletes its notes, so the events of an erased contact’s notes are no longer delivered. An endpoint can narrow it by the pipeline, stage or owner of the note’s deal when the note is added (\`notePipelineIds\`, \`noteStageIds\`, \`noteDealOwnerIds\`): a note about a contact alone then matches none.`,
        'WebhookNoteCreated',
      ),
      ping: webhook(
        'webhookPing',
        'Test event',
        'Sent only when a member chooses "Send test event" for the endpoint.',
        'WebhookPing',
      ),
    },
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', description: 'A company API key.' },
      },
      parameters: {
        Id: { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        FieldKey: {
          name: 'key',
          in: 'path',
          required: true,
          schema: { type: 'string', pattern: CONTACT_FIELD_KEY_RE.source },
          description: 'The field’s key (GET /contact-fields).',
        },
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          schema: { type: 'string', maxLength: API_LIMITS.idempotencyKeyLength },
          description: 'A unique key per request (for example a UUID), reused only for retries.',
        },
        IdempotencyKeyOptional: {
          name: 'Idempotency-Key',
          in: 'header',
          required: false,
          schema: { type: 'string', maxLength: API_LIMITS.idempotencyKeyLength },
        },
        WebhookSignature: {
          name: 'W360-Signature',
          in: 'header',
          required: true,
          schema: { type: 'string' },
          description:
            '`t=<unix time>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, with one `v1` per signing secret.',
        },
        WebhookEventId: {
          name: 'W360-Event-Id',
          in: 'header',
          required: true,
          schema: { type: 'string', format: 'uuid' },
          description:
            'The event id (also `id` in the body): the same on every attempt and replay.',
        },
        WebhookEventType: {
          name: 'W360-Event-Type',
          in: 'header',
          required: true,
          schema: { type: 'string' },
        },
        WebhookDeliveryId: {
          name: 'W360-Delivery-Id',
          in: 'header',
          required: true,
          schema: { type: 'string', format: 'uuid' },
          description: 'This delivery; a replay is a new delivery of the same event.',
        },
        WebhookDeliveryAttempt: {
          name: 'W360-Delivery-Attempt',
          in: 'header',
          required: true,
          schema: { type: 'integer', minimum: 1, maximum: WEBHOOK_LIMITS.attempts },
        },
      },
      schemas: {
        UploadedMedia: {
          type: 'object',
          description: 'A file uploaded for a number, to send by id.',
          properties: {
            id: { type: 'string', format: 'uuid', description: 'Give it as `mediaId`.' },
            channelId: {
              type: 'string',
              format: 'uuid',
              description: 'The number it was uploaded for, the only one it is sent from.',
            },
            type: {
              type: 'string',
              enum: ['image', 'video', 'audio', 'document'],
              description: 'The `type` of the messages that send it.',
            },
            mimeType: { type: 'string' },
            size: { type: 'integer', description: 'In bytes.' },
            fileName: {
              type: 'string',
              description: 'The name a document is sent under.',
            },
            createdAt: { type: 'string', format: 'date-time' },
            expiresAt: {
              type: 'string',
              format: 'date-time',
              description: '30 days after the upload: WhatsApp no longer keeps the file after it.',
            },
          },
          required: [
            'id',
            'channelId',
            'type',
            'mimeType',
            'size',
            'fileName',
            'createdAt',
            'expiresAt',
          ],
        },
        Contact: jsonSchema(apiContactSchema),
        ContactCreate: jsonSchema(apiContactCreateSchema, 'input'),
        ContactUpdate: jsonSchema(apiContactUpdateSchema, 'input'),
        UpdateManyContacts: jsonSchema(apiUpdateManyContactsSchema, 'input'),
        ContactSearch: jsonSchema(apiContactSearchSchema, 'input'),
        UpdateMatchingContacts: jsonSchema(apiUpdateMatchingContactsSchema, 'input'),
        ContactField: jsonSchema(apiContactFieldSchema),
        ContactTag: jsonSchema(apiContactTagSchema),
        ConversationTag: jsonSchema(apiConversationTagSchema),
        ContactFieldCreate: jsonSchema(apiContactFieldCreateSchema, 'input'),
        ContactFieldUpdate: jsonSchema(apiContactFieldUpdateSchema, 'input'),
        ContactChange: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid', description: 'The contact’s id.' },
            erased: { type: 'boolean' },
            contact: {
              oneOf: [ref('Contact'), { type: 'null' }],
              description: 'The contact as it is now; null once it was erased.',
            },
            changes: {
              oneOf: [
                {
                  type: 'array',
                  items: { type: 'string', pattern: CONTACT_FEED_PART_RE.source },
                },
                { type: 'null' },
              ],
              description:
                'What changed since your pass through the feed began, sorted, once each: `name`, `phone`, `email`, `tags` (a tag added or removed), `fields.<key>` for each custom field whose value changed or was deleted (GET /contact-fields), `consent.marketing`, `consent.utility`, `source`, and `merged` when another contact was merged into this one (`mergedContactIds`). `added` alone when the contact was added since, and `erased` alone once it is erased. A pass begins without a cursor (at the first change) or with the `nextCursor` of a page whose `hasMore` was false, and ends at the next such page: counted from its beginning, a contact a later page reads misses none of the changes the pages before it passed over. Names only: `contact` carries the values as they are now. A part can be named again: a contact read twice in one pass is named with everything since the pass began, and a change saved while you read the page before can be named with its value already in the contact you read then. Null when some of those changes were saved before HyFib recorded what changed, or the pass began with a cursor given before HyFib counted passes: take the whole contact.',
            },
            mergedContactIds: {
              type: 'array',
              items: { type: 'string', format: 'uuid' },
              description:
                'The contacts merged into this one, oldest merge first, including those merged into a contact that was merged into this one later: they no longer exist, and their records are this contact’s. Delete your copies.',
            },
          },
          required: ['id', 'erased', 'contact', 'changes', 'mergedContactIds'],
        },
        Consent: jsonSchema(apiConsentSchema, 'input'),
        ContactMerge: jsonSchema(apiMergeContactsSchema, 'input'),
        ContactMergeResult: jsonSchema(apiContactMergeResultSchema),
        Template: jsonSchema(apiTemplateSchema),
        SendTemplate: jsonSchema(apiSendMessageSchema, 'input'),
        SendManyTemplates: jsonSchema(apiSendManyTemplatesSchema, 'input'),
        TemplateSend: jsonSchema(apiTemplateSendSchema),
        SendText: jsonSchema(apiSendTextSchema, 'input'),
        SendImage: jsonSchema(apiSendImageSchema, 'input'),
        SendVideo: jsonSchema(apiSendVideoSchema, 'input'),
        SendAudio: jsonSchema(apiSendAudioSchema, 'input'),
        SendDocument: jsonSchema(apiSendDocumentSchema, 'input'),
        SendSticker: jsonSchema(apiSendStickerSchema, 'input'),
        SendLocation: jsonSchema(apiSendLocationSchema, 'input'),
        SendContacts: jsonSchema(apiSendContactsSchema, 'input'),
        SendButtons: jsonSchema(apiSendButtonsSchema, 'input'),
        SendList: jsonSchema(apiSendListSchema, 'input'),
        SendReaction: jsonSchema(apiSendReactionSchema, 'input'),
        SendProduct: jsonSchema(apiSendProductSchema, 'input'),
        SendProductList: jsonSchema(apiSendProductListSchema, 'input'),
        SendCatalog: jsonSchema(apiSendCatalogSchema, 'input'),
        QueuedMessage: jsonSchema(apiQueuedMessageSchema),
        Message: jsonSchema(apiMessageSchema),
        Conversation: jsonSchema(apiConversationSchema),
        ConversationMessage: jsonSchema(apiConversationMessageSchema),
        FeedMessage: jsonSchema(apiFeedMessageSchema),
        MessageChange: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid', description: 'The message’s id.' },
            erased: {
              type: 'boolean',
              description: 'Whether the message’s contact was erased.',
            },
            message: {
              oneOf: [ref('FeedMessage'), { type: 'null' }],
              description: 'The message as it is now; null once its contact was erased.',
            },
          },
          required: ['id', 'erased', 'message'],
        },
        UpdateConversation: jsonSchema(apiUpdateConversationSchema, 'input'),
        UpdateManyConversations: jsonSchema(apiUpdateManyConversationsSchema, 'input'),
        UpdateMatchingConversations: jsonSchema(apiUpdateMatchingConversationsSchema, 'input'),
        Channel: jsonSchema(apiChannelSchema),
        Member: jsonSchema(apiMemberSchema),
        MemberAvailability: jsonSchema(apiMemberAvailabilitySchema),
        BusinessHours: jsonSchema(apiBusinessHoursSchema),
        UpdateBusinessHours: jsonSchema(apiUpdateBusinessHoursSchema, 'input'),
        ClosedDay: jsonSchema(apiClosedDaySchema),
        SatisfactionSurvey: jsonSchema(apiSatisfactionSurveySchema),
        Report: jsonSchema(apiReportSchema),
        Flow: jsonSchema(apiFlowSchema),
        FlowResponse: jsonSchema(apiFlowResponseSchema),
        Ad: jsonSchema(apiAdSchema),
        ChatLink: jsonSchema(apiChatLinkSchema),
        ChatLinkDetail: jsonSchema(apiChatLinkDetailSchema),
        CreateChatLink: jsonSchema(apiCreateChatLinkSchema, 'input'),
        UpdateChatLink: jsonSchema(apiUpdateChatLinkSchema, 'input'),
        JsonValue: {
          description:
            'Any JSON value: text, a number, true or false, null, a list of JSON values or an object of them.',
          anyOf: [
            { type: 'string' },
            { type: 'number' },
            { type: 'boolean' },
            { type: 'null' },
            { type: 'array', items: ref('JsonValue') },
            { type: 'object', additionalProperties: ref('JsonValue') },
          ],
        },
        MessageTemplate: jsonSchema(apiMessageTemplateSchema),
        MessageTemplateDetail: jsonSchema(apiMessageTemplateDetailSchema),
        CreateMessageTemplate: jsonSchema(apiCreateMessageTemplateSchema, 'input'),
        UpdateMessageTemplate: jsonSchema(apiUpdateMessageTemplateSchema, 'input'),
        SavedReply: jsonSchema(apiSavedReplySchema),
        CreateSavedReply: jsonSchema(apiCreateSavedReplySchema, 'input'),
        UpdateSavedReply: jsonSchema(apiUpdateSavedReplySchema, 'input'),
        CreateClosedDay: jsonSchema(apiCreateClosedDaySchema, 'input'),
        UpdateMember: jsonSchema(apiUpdateMemberSchema, 'input'),
        Team: jsonSchema(apiTeamSchema),
        TeamSettings: jsonSchema(apiTeamSettingsSchema),
        CreateTeam: jsonSchema(apiCreateTeamSchema, 'input'),
        UpdateTeam: jsonSchema(apiUpdateTeamSchema, 'input'),
        AddConversationNote: jsonSchema(apiAddNoteSchema, 'input'),
        ConversationNote: jsonSchema(apiConversationNoteSchema),
        Campaign: jsonSchema(apiCampaignSchema),
        Order: jsonSchema(apiOrderSchema),
        PaymentLink: jsonSchema(apiPaymentLinkSchema),
        UpdateOrder: jsonSchema(apiUpdateOrderSchema, 'input'),
        Pipeline: jsonSchema(apiPipelineSchema),
        PipelineForecast: jsonSchema(apiPipelineForecastSchema),
        CreatePipeline: jsonSchema(apiCreatePipelineSchema, 'input'),
        UpdatePipeline: jsonSchema(apiUpdatePipelineSchema, 'input'),
        Deal: jsonSchema(apiDealSchema),
        DealHistoryEntry: jsonSchema(apiDealHistoryEntrySchema),
        CreateDeal: jsonSchema(apiCreateDealSchema, 'input'),
        UpdateDeal: jsonSchema(apiUpdateDealSchema, 'input'),
        Task: jsonSchema(apiTaskSchema),
        CreateTask: jsonSchema(apiCreateTaskSchema, 'input'),
        UpdateTask: jsonSchema(apiUpdateTaskSchema, 'input'),
        Note: jsonSchema(apiNoteSchema),
        CreateNote: jsonSchema(apiCreateNoteSchema, 'input'),
        CampaignWithResults: jsonSchema(apiCampaignDetailSchema),
        CampaignReview: jsonSchema(apiCampaignReviewSchema),
        CreateCampaign: jsonSchema(apiCreateCampaignSchema, 'input'),
        UpdateCampaign: jsonSchema(apiUpdateCampaignSchema, 'input'),
        SubmitCampaign: jsonSchema(apiSubmitCampaignSchema, 'input'),
        CampaignRecipient: jsonSchema(apiCampaignRecipientSchema),
        Segment: jsonSchema(apiSegmentSchema),
        SegmentWithCount: jsonSchema(apiSegmentDetailSchema),
        CreateSegment: jsonSchema(apiCreateSegmentSchema, 'input'),
        UpdateSegment: jsonSchema(apiUpdateSegmentSchema, 'input'),
        Automation: jsonSchema(apiAutomationSchema),
        AutomationRun: jsonSchema(apiAutomationRunSchema),
        StartAutomationRun: jsonSchema(apiStartAutomationSchema, 'input'),
        StartManyAutomationRuns: jsonSchema(apiStartManyAutomationRunsSchema, 'input'),
        StopManyAutomationRuns: jsonSchema(apiStopManyAutomationRunsSchema, 'input'),
        AutomationRunStart: jsonSchema(apiAutomationRunStartSchema),
        WebhookEndpoint: jsonSchema(apiWebhookEndpointSchema),
        WebhookEndpointWithSecret: jsonSchema(apiWebhookEndpointWithSecretSchema),
        WebhookDelivery: jsonSchema(apiWebhookDeliverySchema),
        CreateWebhookEndpoint: jsonSchema(apiCreateWebhookEndpointSchema, 'input'),
        UpdateWebhookEndpoint: jsonSchema(apiUpdateWebhookEndpointSchema, 'input'),
        ReplayFailedDeliveries: jsonSchema(apiReplayFailedDeliveriesSchema, 'input'),
        FailedReplay: jsonSchema(apiFailedReplaySchema),
        FailedReplayAcrossEndpoints: jsonSchema(apiFailedReplayAcrossSchema),
        Error: jsonSchema(apiErrorSchema),
        WebhookMessageReceived: jsonSchema(messageReceivedPayloadSchema),
        WebhookMessageStatus: jsonSchema(messageStatusPayloadSchema),
        WebhookConsentChanged: jsonSchema(consentChangedPayloadSchema),
        WebhookTemplateStatusChanged: jsonSchema(templateStatusPayloadSchema),
        WebhookConversationStatusChanged: jsonSchema(conversationStatusPayloadSchema),
        WebhookConversationAssignmentChanged: jsonSchema(conversationAssignmentPayloadSchema),
        WebhookConversationTeamChanged: jsonSchema(conversationTeamPayloadSchema),
        WebhookContactCreated: jsonSchema(contactCreatedPayloadSchema),
        WebhookContactUpdated: jsonSchema(contactUpdatedPayloadSchema),
        WebhookContactErased: jsonSchema(contactErasedPayloadSchema),
        WebhookContactMerged: jsonSchema(contactMergedPayloadSchema),
        WebhookAutomationRunStarted: jsonSchema(automationRunStartedPayloadSchema),
        WebhookAutomationRunEnded: jsonSchema(automationRunEndedPayloadSchema),
        WebhookAutomationRunStep: jsonSchema(automationRunStepPayloadSchema),
        WebhookOrderReceived: jsonSchema(orderReceivedPayloadSchema),
        WebhookOrderStatusChanged: jsonSchema(orderStatusChangedPayloadSchema),
        WebhookPaymentLinkStatusChanged: jsonSchema(paymentLinkStatusChangedPayloadSchema),
        WebhookCampaignStatusChanged: jsonSchema(campaignStatusChangedPayloadSchema),
        WebhookDealCreated: jsonSchema(dealCreatedPayloadSchema),
        WebhookDealUpdated: jsonSchema(dealUpdatedPayloadSchema),
        WebhookDealStageChanged: jsonSchema(dealStageChangedPayloadSchema),
        WebhookDealOwnerChanged: jsonSchema(dealOwnerChangedPayloadSchema),
        WebhookDealStatusChanged: jsonSchema(dealStatusChangedPayloadSchema),
        WebhookTaskCreated: jsonSchema(taskCreatedPayloadSchema),
        WebhookTaskUpdated: jsonSchema(taskUpdatedPayloadSchema),
        WebhookTaskAssigneeChanged: jsonSchema(taskAssigneeChangedPayloadSchema),
        WebhookTaskStatusChanged: jsonSchema(taskStatusChangedPayloadSchema),
        WebhookNoteCreated: jsonSchema(noteCreatedPayloadSchema),
        WebhookSatisfactionSurveyAnswered: jsonSchema(satisfactionSurveyAnsweredPayloadSchema),
        WebhookStoreOrderCodAnswered: jsonSchema(storeOrderCodAnsweredPayloadSchema),
        WebhookPing: jsonSchema(pingPayloadSchema),
      },
    },
  };
}

/** The routes the document describes: method and path template (checked by a unit test). */
export const API_ROUTES = [
  ['get', '/templates'],
  ['get', '/message-templates'],
  ['post', '/message-templates'],
  ['get', '/message-templates/{id}'],
  ['patch', '/message-templates/{id}'],
  ['delete', '/message-templates/{id}'],
  ['post', '/message-templates/{id}/submit'],
  ['get', '/channels'],
  ['get', '/contacts'],
  ['post', '/contacts'],
  ['post', '/contacts/search'],
  ['post', '/contacts/update-many'],
  ['post', '/contacts/update-matching'],
  ['get', '/contacts/{id}'],
  ['patch', '/contacts/{id}'],
  ['post', '/contacts/{id}/consent'],
  ['post', '/contacts/{id}/merge'],
  ['get', '/contact-fields'],
  ['get', '/contact-tags'],
  ['get', '/conversation-tags'],
  ['post', '/contact-fields'],
  ['patch', '/contact-fields/{key}'],
  ['delete', '/contact-fields/{key}'],
  ['get', '/contact-changes'],
  ['post', '/messages'],
  ['post', '/messages/send-many'],
  ['get', '/messages'],
  ['get', '/messages/{id}'],
  ['get', '/messages/{id}/media'],
  ['post', '/media'],
  ['get', '/message-changes'],
  ['get', '/conversations'],
  ['get', '/conversations/{id}'],
  ['patch', '/conversations/{id}'],
  ['post', '/conversations/update-many'],
  ['post', '/conversations/update-matching'],
  ['post', '/conversations/{id}/notes'],
  ['get', '/conversations/{id}/notes'],
  ['get', '/conversations/{id}/messages'],
  ['get', '/satisfaction-surveys'],
  ['get', '/reports'],
  ['get', '/flows'],
  ['get', '/flow-responses'],
  ['get', '/chat-links'],
  ['post', '/chat-links'],
  ['get', '/chat-links/{id}'],
  ['patch', '/chat-links/{id}'],
  ['get', '/ads'],
  ['get', '/members'],
  ['patch', '/members/{id}'],
  ['get', '/business-hours'],
  ['put', '/business-hours'],
  ['get', '/business-hours/closed-days'],
  ['post', '/business-hours/closed-days'],
  ['delete', '/business-hours/closed-days/{id}'],
  ['get', '/saved-replies'],
  ['post', '/saved-replies'],
  ['patch', '/saved-replies/{id}'],
  ['delete', '/saved-replies/{id}'],
  ['get', '/teams'],
  ['post', '/teams'],
  ['get', '/teams/{id}'],
  ['patch', '/teams/{id}'],
  ['delete', '/teams/{id}'],
  ['get', '/campaigns'],
  ['post', '/campaigns'],
  ['get', '/campaigns/{id}'],
  ['patch', '/campaigns/{id}'],
  ['get', '/campaigns/{id}/review'],
  ['post', '/campaigns/{id}/submit'],
  ['post', '/campaigns/{id}/withdraw'],
  ['get', '/campaigns/{id}/recipients'],
  ['post', '/campaigns/{id}/pause'],
  ['post', '/campaigns/{id}/resume'],
  ['post', '/campaigns/{id}/cancel'],
  ['get', '/segments'],
  ['post', '/segments'],
  ['get', '/segments/{id}'],
  ['patch', '/segments/{id}'],
  ['delete', '/segments/{id}'],
  ['get', '/segments/{id}/contacts'],
  ['get', '/automations'],
  ['post', '/automations/{id}/runs'],
  ['post', '/automations/{id}/runs/start-many'],
  ['get', '/automation-runs/{id}'],
  ['post', '/automation-runs/{id}/stop'],
  ['post', '/automation-runs/stop-many'],
  ['get', '/orders'],
  ['get', '/orders/{id}'],
  ['get', '/orders/{id}/payment-links'],
  ['patch', '/orders/{id}'],
  ['post', '/orders/{id}/request-payment'],
  ['post', '/orders/{id}/cancel-payment'],
  ['get', '/pipelines'],
  ['post', '/pipelines'],
  ['patch', '/pipelines/{id}'],
  ['get', '/pipelines/{id}/forecast'],
  ['get', '/deals'],
  ['post', '/deals'],
  ['get', '/deals/{id}'],
  ['patch', '/deals/{id}'],
  ['get', '/deals/{id}/history'],
  ['get', '/tasks'],
  ['post', '/tasks'],
  ['get', '/tasks/{id}'],
  ['patch', '/tasks/{id}'],
  ['get', '/notes'],
  ['post', '/notes'],
  ['get', '/notes/{id}'],
  ['get', '/webhook-endpoints'],
  ['post', '/webhook-endpoints'],
  ['post', '/webhook-endpoints/replay-failed'],
  ['get', '/webhook-endpoints/{id}'],
  ['patch', '/webhook-endpoints/{id}'],
  ['delete', '/webhook-endpoints/{id}'],
  ['post', '/webhook-endpoints/{id}/rotate-secret'],
  ['get', '/webhook-endpoints/{id}/deliveries'],
  ['post', '/webhook-endpoints/{id}/test'],
  ['post', '/webhook-endpoints/{id}/replay-failed'],
  ['get', '/webhook-deliveries/{id}'],
  ['post', '/webhook-deliveries/{id}/replay'],
] as const;
