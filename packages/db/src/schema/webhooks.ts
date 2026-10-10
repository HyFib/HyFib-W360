import { integer, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { jsonb } from './columns';
import type { AutomationEndReason, AutomationStepOutcome } from './automations';
import type { OrderStatusChanger, PaymentLinkStatus } from './commerce';
import type { CrmChanger, DealStatus, TaskStatus } from './crm';
import type { ContactSource, MessageType } from './messaging';
import type { StoreMessageAnswer, StoreMessageEvent } from './stores';
import { appSchema } from './tenancy';

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Event types an endpoint can receive (ADR-053, ADR-074, ADR-078, ADR-085, ADR-225, ADR-256,
 * ADR-261, ADR-326, ADR-348, ADR-351, ADR-353, ADR-355); `ping` is only sent as a test.
 */
export const WEBHOOK_EVENT_TYPES = [
  'message.received',
  'message.status',
  'consent.changed',
  'template.status_changed',
  'conversation.status_changed',
  'conversation.assignment_changed',
  'conversation.team_changed',
  'satisfaction_survey.answered',
  'contact.created',
  'contact.updated',
  'contact.erased',
  'contact.merged',
  'automation.run_started',
  'automation.run_ended',
  'automation.run_step',
  'order.received',
  'order.status_changed',
  'payment_link.status_changed',
  'store_order.cod_answered',
  'store_order.message_skipped',
  'store_order.message_sent',
  'store_checkout.reminder_skipped',
  'store_checkout.reminder_sent',
  'campaign.status_changed',
  'campaign.recipient_skipped',
  'deal.created',
  'deal.updated',
  'deal.stage_changed',
  'deal.owner_changed',
  'deal.status_changed',
  'task.created',
  'task.updated',
  'task.assignee_changed',
  'task.status_changed',
  'note.created',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** The statuses a `message.status` event carries, which an endpoint can choose (ADR-119). */
export type WebhookMessageStatus =
  'accepted' | 'sent' | 'delivered' | 'read' | 'played' | 'failed' | 'canceled' | 'unknown_outcome';

/**
 * Who sent a message whose `message.status` an endpoint can choose to take (ADR-172), as the event's
 * `message.sentBy` says: a member, an automation, a campaign, the API, or HyFib itself.
 */
export type WebhookMessageSender = 'agent' | 'bot' | 'campaign' | 'api' | 'system';

/**
 * Who made a change a deal, task or note event reports, as an endpoint can choose them (ADR-306): a
 * member, an automation's run or an API key, as the events' `changedBy` and a note's `writtenBy`
 * name them.
 */
export type WebhookCrmChangeMaker = CrmChanger;

/**
 * The score of a satisfaction survey answer, which an endpoint can choose to take (ADR-307), as the
 * survey's `score` gives it: 3 for the first (best) button, 2 for the second, 1 for the third.
 */
export type WebhookSurveyScore = 3 | 2 | 1;

/**
 * The parts of a contact whose change a `contact.updated` endpoint can choose (ADR-123); `fields`
 * is a change of any custom field.
 */
export type WebhookContactPart = 'name' | 'phone' | 'email' | 'tags' | 'fields';

/** The statuses a `campaign.status_changed` event reports, which an endpoint can choose (ADR-146). */
export type WebhookCampaignStatus =
  'draft' | 'pending_approval' | 'scheduled' | 'running' | 'paused' | 'completed' | 'canceled';

/**
 * The statuses an `order.status_changed` event reports, which an endpoint can choose (ADR-147); an
 * order is `received` only when it is recorded, which `order.received` reports.
 */
export type WebhookOrderStatus =
  'confirmed' | 'awaiting_payment' | 'paid' | 'fulfilled' | 'cancelled';

/**
 * The statuses a `payment_link.status_changed` event reports, which an endpoint can choose
 * (ADR-308); a link is `creating` only until the worker creates it, which sends no event.
 */
export type WebhookPaymentLinkStatus = Exclude<PaymentLinkStatus, 'creating'>;

/**
 * The answers a `store_order.cod_answered` event reports, which an endpoint can choose (ADR-349):
 * the customer confirmed the order or cancelled it.
 */
export type WebhookCodAnswer = StoreMessageAnswer;

/**
 * The order messages a `store_order.message_skipped` or `store_order.message_sent` event is about,
 * which an endpoint can choose (ADR-352, ADR-353): every store message event but the two cart
 * reminders, which send `store_checkout.*` events instead (ADR-355).
 */
export type WebhookOrderMessageEvent = Exclude<
  StoreMessageEvent,
  'cart_reminder' | 'cart_second_reminder'
>;

/**
 * The reasons a store's order message can be skipped for, which an endpoint can choose to take the
 * skips of as `store_order.message_skipped` (ADR-354): the reasons a store's Messages page
 * (Commerce → Stores) explains for a message not sent, but the six that concern cart reminders
 * only (checkout_completed, checkout_deleted, order_placed, first_reminder_not_sent, cart_too_old,
 * not_marketing_template), which `store_checkout.reminder_skipped` gives instead (ADR-355).
 */
export type WebhookOrderMessageSkipReason =
  | 'test_order'
  | 'too_late'
  | 'cash_on_delivery'
  | 'rule_disabled'
  | 'store_disconnected'
  | 'no_opt_in'
  | 'order_deleted'
  | 'order_cancelled'
  | 'customer_erased'
  | 'no_phone'
  | 'contact_erased'
  | 'suppressed'
  | 'opted_out'
  | 'no_marketing_opt_in'
  | 'template_unavailable'
  | 'channel_unavailable'
  | 'missing_variable'
  | 'template_changed'
  | 'frequency_capped'
  | 'automation_unavailable'
  | 'conversation_assigned'
  | 'automation_busy'
  | 'automation_limit'
  | 'not_in_plan'
  | 'automation_quota';

/**
 * How a webhook endpoint's OAuth client authenticates to its authorization server (ADR-357), as
 * RFC 7591 names the methods of RFC 6749 section 2.3.1: its identifier and secret in an HTTP Basic
 * header, or as form parameters in the request body; or a JWT signed with its secret, sent as a
 * client assertion (RFC 7523, ADR-366).
 */
export const WEBHOOK_OAUTH_CLIENT_AUTHS = [
  'client_secret_basic',
  'client_secret_post',
  'client_secret_jwt',
] as const;
export type WebhookOAuthClientAuth = (typeof WEBHOOK_OAUTH_CLIENT_AUTHS)[number];

/**
 * The cart reminders, first and second, whose `store_checkout.reminder_skipped` and
 * `store_checkout.reminder_sent` events an endpoint can choose to take (ADR-361): a Shopify store's
 * first reminder about a checkout a customer left, and the second (0021).
 */
export type WebhookCartReminder = 'cart_reminder' | 'cart_second_reminder';

/**
 * The reasons a store's cart reminder can be skipped for, which an endpoint can choose to take the
 * skips of as `store_checkout.reminder_skipped` (ADR-356): the reasons a store's Messages page
 * (Commerce → Stores) explains for a message not sent, but those that concern order messages only
 * and `checkout_deleted`, which no reminder gets (it is deleted with its checkout, ADR-355).
 */
export type WebhookCartReminderSkipReason =
  | 'rule_disabled'
  | 'store_disconnected'
  | 'no_opt_in'
  | 'customer_erased'
  | 'no_phone'
  | 'contact_erased'
  | 'suppressed'
  | 'opted_out'
  | 'no_marketing_opt_in'
  | 'template_unavailable'
  | 'channel_unavailable'
  | 'missing_variable'
  | 'template_changed'
  | 'checkout_completed'
  | 'order_placed'
  | 'first_reminder_not_sent'
  | 'cart_too_old'
  | 'not_marketing_template'
  | 'frequency_capped'
  | 'not_in_plan';

/**
 * The reasons a campaign skips a recipient for, which an endpoint can choose to take the skips of as
 * `campaign.recipient_skipped` (ADR-359): every reason a campaign recipient can be skipped for
 * (0006), when the audience is taken or as the campaign sends.
 */
export type WebhookCampaignSkipReason =
  | 'contact_erased'
  | 'no_phone'
  | 'suppressed'
  | 'opted_out'
  | 'no_marketing_opt_in'
  | 'missing_variable'
  | 'frequency_capped'
  | 'cost_unknown'
  | 'expired';

/**
 * Who made an order status change `order.status_changed` reports, as an endpoint can choose them
 * (ADR-322): a member on the order page, an API key, or HyFib applying what Razorpay reports for
 * the order's Payment Link, as the event's `changedBy` names them.
 */
export type WebhookOrderChangeMaker = OrderStatusChanger;

/**
 * The statuses a `deal.status_changed` event reports, which an endpoint can choose (ADR-309): a
 * deal won, lost, or reopened (`open`).
 */
export type WebhookDealStatus = DealStatus;

/**
 * The statuses a `task.status_changed` event reports, which an endpoint can choose (ADR-309): a
 * task done, cancelled, or reopened (`open`).
 */
export type WebhookTaskStatus = TaskStatus;

/**
 * The details whose change a `deal.updated` endpoint can choose (ADR-310), as the event's `changes`
 * names them.
 */
export type WebhookDealDetail = 'title' | 'valueMinor' | 'expectedCloseOn';

/**
 * The details whose change a `task.updated` endpoint can choose (ADR-310), as the event's `changes`
 * names them.
 */
export type WebhookTaskDetail = 'title' | 'notes' | 'dueAt' | 'remindAt';

/**
 * The statuses a `template.status_changed` event reports, which an endpoint can choose (ADR-148):
 * Meta's review states and the deletion; HyFib's own steps before Meta has the template, a
 * deletion under way or refused and an unrecognised status are not sent.
 */
export type WebhookTemplateStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'paused'
  | 'disabled'
  | 'in_appeal'
  | 'flagged'
  | 'archived'
  | 'deleted'
  | 'limit_exceeded'
  | 'locked';

/**
 * The statuses a `conversation.status_changed` change reaches, which an endpoint can choose
 * (ADR-149); nothing sets a conversation `pending` (ADR-075).
 */
export type WebhookConversationStatus = 'open' | 'resolved';

/**
 * The statuses an `automation.run_ended` event reports, the status a run ended with, which an
 * endpoint can choose (ADR-151); a run's active statuses (`running`, `waiting`) end nothing.
 */
export type WebhookRunEndStatus = 'completed' | 'handed_off' | 'taken_over' | 'stopped' | 'failed';

/**
 * The outcomes an `automation.run_step` event reports, each step's as the run's log recorded it,
 * which an endpoint can choose (ADR-327).
 */
export type WebhookRunStepOutcome = AutomationStepOutcome;

/**
 * The kinds of automation node whose steps an endpoint can choose to take as `automation.run_step`
 * (ADR-328), as the event's `step.nodeType` names them and the automation builder defines them,
 * and `outside_node` for the steps outside a node (the run starting, being stopped or taken over, or
 * failing between steps), whose `step.nodeType` is null.
 */
export type WebhookRunStepNodeType =
  | 'send_text'
  | 'ask_buttons'
  | 'ask_text'
  | 'send_template'
  | 'ask_template'
  | 'send_flow'
  | 'condition'
  | 'update_contact'
  | 'update_conversation'
  | 'http_request'
  | 'create_task'
  | 'create_deal'
  | 'move_deal'
  | 'close_deal'
  | 'wait'
  | 'handoff'
  | 'end'
  | 'outside_node';

/**
 * What started a live automation run (ADR-078), which an endpoint taking run events can choose
 * (ADR-183), as the event's `run.trigger` says; members' test runs send no events.
 */
export type WebhookRunTrigger =
  'keyword' | 'conversation_started' | 'any_message' | 'store_event' | 'api';

/**
 * A `consent.changed` change, its purpose and action (ADR-018), which an endpoint can choose
 * (ADR-189).
 */
export type WebhookConsentChange =
  'marketing_opt_in' | 'marketing_opt_out' | 'utility_opt_in' | 'utility_opt_out';

/**
 * The types a received message has (`message.received`'s `message.type`), which an endpoint can
 * choose (ADR-191): every message type but `template`, which only HyFib sends.
 */
export type WebhookReceivedMessageType = Exclude<MessageType, 'template'>;

export const WEBHOOK_DELIVERY_STATES = ['pending', 'delivering', 'succeeded', 'failed'] as const;
export type WebhookDeliveryState = (typeof WEBHOOK_DELIVERY_STATES)[number];

/**
 * A company's webhook endpoint (migration 0025); its secrets (signing, headers, OAuth client) are
 * encrypted by the keyring.
 */
export const webhookEndpoints = appSchema.table('webhook_endpoints', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  url: text('url').notNull(),
  description: text('description'),
  eventTypes: text('event_types').array().notNull().$type<WebhookEventType[]>(),
  secretCiphertext: text('secret_ciphertext').notNull(),
  secretVersion: integer('secret_version').notNull().default(1),
  previousSecretCiphertext: text('previous_secret_ciphertext'),
  previousSecretExpiresAt: tz('previous_secret_expires_at'),
  /** The names of the endpoint's own headers, as written (ADR-118); their values are only sealed. */
  headerNames: text('header_names').array().notNull().default([]),
  /** The headers, names and values, encrypted by the keyring; null without headers. */
  headersCiphertext: text('headers_ciphertext'),
  /**
   * The `message.status` statuses the endpoint takes (ADR-119); null takes every status. Set only
   * while `message.status` is among its events.
   */
  messageStatuses: text('message_statuses').array().$type<WebhookMessageStatus[]>(),
  /**
   * Who sent the messages whose `message.status` it takes (ADR-172); null takes every sender. Set
   * only while `message.status` is among its events.
   */
  messageSenders: text('message_senders').array().$type<WebhookMessageSender[]>(),
  /**
   * The API keys whose sent messages' `message.status` it takes (migration 0242, ADR-320): the
   * messages one of them sent through the API, or a key one of them was rotated from or into. null
   * takes every message's. Set only while `message.status` is among its events.
   */
  messageApiKeyIds: uuid('message_api_key_ids').array(),
  /**
   * The parts of a contact whose change it takes as `contact.updated` (ADR-123); null takes every
   * change. Set only while `contact.updated` is among its events.
   */
  contactParts: text('contact_parts').array().$type<WebhookContactPart[]>(),
  /**
   * The custom fields (keys) whose changes it takes as `contact.updated` (ADR-184); null takes every
   * field's. Set only while it takes `contact.updated` for every part or for `fields`.
   */
  contactFieldKeys: text('contact_field_keys').array(),
  /**
   * The automations whose runs it takes as `automation.run_started`, `automation.run_ended` and
   * `automation.run_step` (ADR-145, ADR-326); null takes every automation. Set only while one of
   * those is among its events.
   */
  automationIds: uuid('automation_ids').array(),
  /**
   * The statuses a campaign reaches that it takes as `campaign.status_changed` (ADR-146); null
   * takes every status. Set only while `campaign.status_changed` is among its events.
   */
  campaignStatuses: text('campaign_statuses').array().$type<WebhookCampaignStatus[]>(),
  /**
   * The statuses an order reaches that it takes as `order.status_changed` (ADR-147); null takes
   * every status. Set only while `order.status_changed` is among its events.
   */
  orderStatuses: text('order_statuses').array().$type<WebhookOrderStatus[]>(),
  /**
   * The statuses a Payment Link reaches that it takes as `payment_link.status_changed` (migration
   * 0231, ADR-308); null takes every status. Set only while `payment_link.status_changed` is among
   * its events.
   */
  paymentLinkStatuses: text('payment_link_statuses').array().$type<WebhookPaymentLinkStatus[]>(),
  /**
   * Who made the order status changes it takes as `order.status_changed` (migration 0244, ADR-322);
   * null takes every change, and a change whose maker was not recorded is taken whoever is listed.
   * Set only while `order.status_changed` is among its events.
   */
  orderChangeMakers: text('order_change_makers').array().$type<WebhookOrderChangeMaker[]>(),
  /**
   * The API keys whose order status changes it leaves out (migration 0245, ADR-323): the changes
   * one of them made through the API, or a key one of them was rotated from or into. null leaves
   * nothing out. Set only while `order.status_changed` is among its events.
   */
  orderExcludedApiKeyIds: uuid('order_excluded_api_key_ids').array(),
  /**
   * The API keys whose Payment Links' changes it takes as `payment_link.status_changed` (migration
   * 0246, ADR-324): the links one of them asked for, or a key one of them was rotated from or into.
   * null takes every link's. Set only while `payment_link.status_changed` is among its events.
   */
  paymentLinkApiKeyIds: uuid('payment_link_api_key_ids').array(),
  /**
   * The answers it takes as `store_order.cod_answered` (migration 0268, ADR-349); null takes every
   * answer. Set only while `store_order.cod_answered` is among its events.
   */
  codAnswers: text('cod_answers').array().$type<WebhookCodAnswer[]>(),
  /**
   * The connected stores whose cash on delivery answers (migration 0268, ADR-349), skipped and
   * sent order messages (migrations 0272 and 0273, ADR-352, ADR-353) and cart reminders (migration
   * 0276, ADR-355) it takes, by the store of the order or the checkout; null takes every store's.
   * Set only while one of those events is among its events.
   */
  storeIds: uuid('store_ids').array(),
  /**
   * The order messages whose skips and sends it takes as `store_order.message_skipped` and
   * `store_order.message_sent` (migrations 0272 and 0273, ADR-352, ADR-353); null takes every
   * message's. Set only while one of those events is among its events.
   */
  orderMessageEvents: text('order_message_events').array().$type<WebhookOrderMessageEvent[]>(),
  /**
   * The reasons whose order message skips it takes as `store_order.message_skipped` (migration
   * 0275, ADR-354); null takes every reason. Set only while that event is among its events.
   */
  orderMessageSkipReasons: text('order_message_skip_reasons')
    .array()
    .$type<WebhookOrderMessageSkipReason[]>(),
  /**
   * The cart reminders whose `store_checkout.reminder_skipped` and `store_checkout.reminder_sent`
   * events it takes (migration 0284, ADR-361); null takes both. Set only while either event is
   * among its events.
   */
  cartReminders: text('cart_reminders').array().$type<WebhookCartReminder[]>(),
  /**
   * The reasons whose cart reminder skips it takes as `store_checkout.reminder_skipped` (migration
   * 0278, ADR-356); null takes every reason. Set only while that event is among its events.
   */
  cartReminderSkipReasons: text('cart_reminder_skip_reasons')
    .array()
    .$type<WebhookCartReminderSkipReason[]>(),
  /**
   * The reasons whose campaign recipient skips it takes as `campaign.recipient_skipped` (migration
   * 0282, ADR-359); null takes every reason. Set only while that event is among its events.
   */
  campaignSkipReasons: text('campaign_skip_reasons').array().$type<WebhookCampaignSkipReason[]>(),
  /**
   * The statuses a deal reaches that it takes as `deal.status_changed` (migration 0232, ADR-309);
   * null takes every status. Set only while `deal.status_changed` is among its events.
   */
  dealStatuses: text('deal_statuses').array().$type<WebhookDealStatus[]>(),
  /**
   * The statuses a task reaches that it takes as `task.status_changed` (migration 0232, ADR-309);
   * null takes every status. Set only while `task.status_changed` is among its events.
   */
  taskStatuses: text('task_statuses').array().$type<WebhookTaskStatus[]>(),
  /**
   * The details whose changes it takes as `deal.updated` (migration 0233, ADR-310): a change that
   * changed any of them. null takes every change. Set only while `deal.updated` is among its
   * events.
   */
  dealDetails: text('deal_details').array().$type<WebhookDealDetail[]>(),
  /**
   * The details whose changes it takes as `task.updated` (migration 0233, ADR-310): a change that
   * changed any of them. null takes every change. Set only while `task.updated` is among its
   * events.
   */
  taskDetails: text('task_details').array().$type<WebhookTaskDetail[]>(),
  /**
   * The template statuses it takes as `template.status_changed` (ADR-148); null takes every status.
   * Set only while `template.status_changed` is among its events.
   */
  templateStatuses: text('template_statuses').array().$type<WebhookTemplateStatus[]>(),
  /**
   * The statuses a conversation reaches that it takes as `conversation.status_changed` (ADR-149);
   * null takes every status. Set only while `conversation.status_changed` is among its events.
   */
  conversationStatuses: text('conversation_statuses').array().$type<WebhookConversationStatus[]>(),
  /**
   * The statuses a run ended with that it takes as `automation.run_ended` (ADR-151); null takes
   * every end. Set only while `automation.run_ended` is among its events.
   */
  runEndStatuses: text('run_end_statuses').array().$type<WebhookRunEndStatus[]>(),
  /**
   * The outcomes of the run steps it takes as `automation.run_step` (migration 0249, ADR-327); null
   * takes every step. Set only while `automation.run_step` is among its events.
   */
  runStepOutcomes: text('run_step_outcomes').array().$type<WebhookRunStepOutcome[]>(),
  /**
   * The kinds of node whose run steps it takes as `automation.run_step` (migration 0250, ADR-328),
   * `outside_node` for the steps outside a node; null takes every step. Set only while
   * `automation.run_step` is among its events.
   */
  runStepNodeTypes: text('run_step_node_types').array().$type<WebhookRunStepNodeType[]>(),
  /**
   * What started the runs whose events it takes (ADR-183); null takes every run's. Set only while
   * `automation.run_started`, `automation.run_ended` or `automation.run_step` is among its events.
   */
  runTriggers: text('run_triggers').array().$type<WebhookRunTrigger[]>(),
  /**
   * The API keys whose runs' events it takes (migration 0241, ADR-319): the runs one of them
   * started through the API, or a key one of them was rotated from or into. null takes every run.
   * Set only while `automation.run_started`, `automation.run_ended` or `automation.run_step` is
   * among its events.
   */
  runApiKeyIds: uuid('run_api_key_ids').array(),
  /**
   * The WhatsApp numbers (channel accounts) whose events it takes (ADR-170): message,
   * conversation, survey answer, automation run and step, order, Payment Link, cash on delivery
   * answer (ADR-348), sent order message (ADR-353), sent cart reminder (ADR-355) and campaign
   * events, as `WEBHOOK_CHANNEL_EVENTS` lists them; null takes every number. Set only while one of
   * those is among its events.
   */
  channelAccountIds: uuid('channel_account_ids').array(),
  /**
   * The teams whose conversations' message and conversation events it takes (ADR-174); null takes
   * every conversation's. Set only while one of those events is among its events.
   */
  teamIds: uuid('team_ids').array(),
  /**
   * The templates whose messages' statuses and changes it takes (ADR-175); null takes every
   * template's. Set only while `message.status` or `template.status_changed` is among its events.
   */
  templateIds: uuid('template_ids').array(),
  /**
   * The members (memberships) whose assigned conversations' message and conversation events it
   * takes (ADR-181); null takes every conversation's. Set only while one of those events is among
   * its events.
   */
  assigneeIds: uuid('assignee_ids').array(),
  /**
   * The contact tags whose conversations' message and conversation events it takes (migration 0183,
   * ADR-267), by the tags the conversation's contact has when the event happens; null takes every
   * conversation's. Set only while one of those events is among its events.
   */
  contactTags: text('contact_tags').array(),
  /**
   * The conversation tags whose message and conversation events it takes (migration 0189,
   * ADR-273), by the tags the conversation has when the event happens; null takes every
   * conversation's. Set only while one of those events is among its events.
   */
  conversationTags: text('conversation_tags').array(),
  /**
   * The campaigns whose messages' statuses and changes it takes (ADR-185); null takes every
   * campaign's. Set only while `message.status` or `campaign.status_changed` is among its events.
   */
  campaignIds: uuid('campaign_ids').array(),
  /**
   * The CRM pipelines whose deals' events it takes (migration 0179, ADR-263), by the pipeline the
   * event gives (and for a move, the one it left); null takes every pipeline's. Set only while a
   * deal event is among its events.
   */
  pipelineIds: uuid('pipeline_ids').array(),
  /**
   * The CRM stages whose deals' events it takes (migration 0180, ADR-264), by the stage the event
   * gives (and for a move, the one it left); null takes every stage's. Set only while a deal event
   * is among its events.
   */
  stageIds: uuid('stage_ids').array(),
  /**
   * The members (memberships) whose deals' events it takes (migration 0181, ADR-265), by the deal's
   * owner when the event happens; null takes every deal's. Set only while a deal event is among its
   * events.
   */
  ownerIds: uuid('owner_ids').array(),
  /**
   * The members (memberships) whose tasks' events it takes (migration 0182, ADR-266), by the task's
   * assignee when the event happens; null takes every task's. Set only while a task event is among
   * its events.
   */
  taskAssigneeIds: uuid('task_assignee_ids').array(),
  /**
   * The CRM pipelines whose deals' tasks' events it takes (migration 0226, ADR-303), by the pipeline
   * of the task's deal when the event happens; a task without a deal is in none. null takes every
   * task's. Set only while a task event is among its events.
   */
  taskPipelineIds: uuid('task_pipeline_ids').array(),
  /**
   * The CRM stages whose deals' tasks' events it takes (migration 0227, ADR-304), by the stage of the
   * task's deal when the event happens; a task without a deal is in none. null takes every task's.
   * Set only while a task event is among its events.
   */
  taskStageIds: uuid('task_stage_ids').array(),
  /**
   * The members (memberships) whose deals' tasks' events it takes (migration 0227, ADR-304), by the
   * owner of the task's deal when the event happens; a task without a deal, or of a deal without an
   * owner, has none. null takes every task's. Set only while a task event is among its events.
   */
  taskDealOwnerIds: uuid('task_deal_owner_ids').array(),
  /**
   * The CRM pipelines whose deals' notes' events it takes (migration 0228, ADR-305), by the
   * pipeline of the note's deal when the note is added; a note about a contact alone is in none.
   * null takes every note's. Set only while `note.created` is among its events.
   */
  notePipelineIds: uuid('note_pipeline_ids').array(),
  /**
   * The CRM stages whose deals' notes' events it takes (migration 0228, ADR-305), by the stage of
   * the note's deal when the note is added; a note about a contact alone is in none. null takes
   * every note's. Set only while `note.created` is among its events.
   */
  noteStageIds: uuid('note_stage_ids').array(),
  /**
   * The members (memberships) whose deals' notes' events it takes (migration 0228, ADR-305), by the
   * owner of the note's deal when the note is added; a note about a contact alone, or of a deal
   * without an owner, has none. null takes every note's. Set only while `note.created` is among its
   * events.
   */
  noteDealOwnerIds: uuid('note_deal_owner_ids').array(),
  /**
   * Who made the changes whose deal, task and note events it takes (migration 0229, ADR-306): an
   * addition's maker is whoever added the deal or task, a note's whoever wrote it, and any other
   * change's the one it recorded. null takes every change; a change whose maker was not recorded is
   * taken whoever is listed. Set only while a deal, task or note event is among its events.
   */
  crmChangeMakers: text('crm_change_makers').array().$type<WebhookCrmChangeMaker[]>(),
  /**
   * The API keys whose deal, task and note changes it leaves out (migration 0243, ADR-321): the
   * changes one of them made through the API, or a key one of them was rotated from or into. null
   * leaves nothing out. Set only while a deal, task or note event is among its events.
   */
  crmExcludedApiKeyIds: uuid('crm_excluded_api_key_ids').array(),
  /**
   * The scores of the satisfaction survey answers it takes (migration 0230, ADR-307), by the score
   * the customer's tap recorded; null takes every answer. Set only while
   * `satisfaction_survey.answered` is among its events.
   */
  surveyScores: smallint('survey_scores').array().$type<WebhookSurveyScore[]>(),
  /**
   * The members credited with the satisfaction survey answers it takes (migration 0234, ADR-311):
   * the member each answered survey's conversation was assigned to when it was resolved. null takes
   * every answer. Set only while `satisfaction_survey.answered` is among its events.
   */
  surveyAssigneeIds: uuid('survey_assignee_ids').array(),
  /**
   * The teams whose conversations' satisfaction survey answers it takes (migration 0234, ADR-311),
   * by the team the conversation is in when the customer answers. null takes every answer. Set only
   * while `satisfaction_survey.answered` is among its events.
   */
  surveyTeamIds: uuid('survey_team_ids').array(),
  /**
   * The contact tags whose satisfaction survey answers it takes (migration 0235, ADR-312), by the
   * tags the answering contact has when they answer, as contacts carry them. null takes every
   * answer. Set only while `satisfaction_survey.answered` is among its events.
   */
  surveyContactTags: text('survey_contact_tags').array(),
  /**
   * The conversation tags whose satisfaction survey answers it takes (migration 0235, ADR-312), by
   * the tags the conversation has when the customer answers. null takes every answer. Set only
   * while `satisfaction_survey.answered` is among its events.
   */
  surveyConversationTags: text('survey_conversation_tags').array(),
  /**
   * The contact tags whose `contact.created` and `contact.updated` it takes (migration 0239,
   * ADR-316): the changes of a contact that has one of them, and those adding or removing one, as
   * contacts carry them. null takes every contact. Set only while one of the two is among its
   * events.
   */
  contactEventTags: text('contact_event_tags').array(),
  /**
   * The custom field values whose `contact.created` and `contact.updated` it takes (migration
   * 0253, ADR-332): a field's key with a value of its type, as contacts keep them, or since 0256
   * (ADR-335) with a word its text contains or a range of its numbers or dates. A change is taken
   * when the contact passes one of them, or when it changes one of the fields. null takes every
   * contact. Set only while one of the two is among its events.
   */
  contactEventFieldValues: jsonb('contact_event_field_values').$type<
    (
      | { key: string; value: string | number | boolean }
      | { key: string; contains: string }
      | { key: string; atLeast?: number | string; atMost?: number | string }
    )[]
  >(),
  /**
   * The consent changes it takes as `consent.changed` (ADR-189), by purpose and action; null takes
   * every change. Set only while `consent.changed` is among its events.
   */
  consentChanges: text('consent_changes').array().$type<WebhookConsentChange[]>(),
  /**
   * Where the contacts whose `contact.created` it takes came from (ADR-190), as the payload's
   * `contact.source`; null takes every contact. Set only while `contact.created` is among its events.
   */
  contactSources: text('contact_sources').array().$type<ContactSource[]>(),
  /**
   * The types of the received messages it takes as `message.received` (ADR-191); null takes every
   * type. Set only while `message.received` is among its events.
   */
  messageTypes: text('message_types').array().$type<WebhookReceivedMessageType[]>(),
  /**
   * The words or phrases whose received messages it takes as `message.received` (migration 0257,
   * ADR-337): a message whose text, as the payload's `message.text` gives it, contains one of them,
   * whatever its case; null takes every message. Set only while `message.received` is among its
   * events.
   */
  messageWords: text('message_words').array(),
  /**
   * The reasons the runs it takes as `automation.run_ended` ended for (ADR-192), applied with the
   * ends it chose; null takes every reason. Set only while `automation.run_ended` is among its events.
   */
  runEndReasons: text('run_end_reasons').array().$type<AutomationEndReason[]>(),
  /**
   * The endpoint's OAuth client (ADR-173): its authorization server's token endpoint, the client
   * identifier, the secret encrypted by the keyring and the scope to ask for (null: none). All
   * null without OAuth; the scope alone is optional.
   */
  oauthTokenUrl: text('oauth_token_url'),
  oauthClientId: text('oauth_client_id'),
  oauthClientSecretCiphertext: text('oauth_client_secret_ciphertext'),
  oauthScope: text('oauth_scope'),
  /**
   * How the OAuth client authenticates to its authorization server (migration 0279, ADR-357), as
   * RFC 7591 names the methods: HTTP Basic (the default, kept unused without a client) or its
   * identifier and secret in the request body.
   */
  oauthClientAuth: text('oauth_client_auth', { enum: WEBHOOK_OAUTH_CLIENT_AUTHS })
    .notNull()
    .default('client_secret_basic'),
  state: text('state', { enum: ['active', 'disabled'] })
    .notNull()
    .default('active'),
  disabledReason: text('disabled_reason', { enum: ['manual', 'failing'] }),
  disabledAt: tz('disabled_at'),
  failingSince: tz('failing_since'),
  lastSuccessAt: tz('last_success_at'),
  lastFailureAt: tz('last_failure_at'),
  /** The member who created the endpoint in settings, or the key that created it (ADR-081). */
  createdByUserId: text('created_by_user_id'),
  createdByApiKeyId: uuid('created_by_api_key_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

/**
 * What happened, without personal data; written by the capture triggers (and test sends). The
 * contact events' `captured_xact` (migration 0047) is used only by the capture functions in SQL.
 */
export const webhookEvents = appSchema.table('webhook_events', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  type: text('type', { enum: [...WEBHOOK_EVENT_TYPES, 'ping'] }).notNull(),
  messageId: uuid('message_id'),
  conversationId: uuid('conversation_id'),
  contactId: uuid('contact_id'),
  templateId: uuid('template_id'),
  status: text('status'),
  detail: jsonb('detail').notNull().$type<Record<string, unknown>>(),
  /** What a contact.updated event's transaction changed (ADR-121); null for other events. */
  contactChanges: text('contact_changes').array(),
  /**
   * The tags a contact.updated event's transaction added and removed (ADR-182), both null for other
   * events, for those captured before migration 0129 and once the contact is erased.
   */
  tagsAdded: text('tags_added').array(),
  tagsRemoved: text('tags_removed').array(),
  occurredAt: tz('occurred_at').notNull().defaultNow(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

/** One delivery of an event to an endpoint, with its attempts. */
export const webhookDeliveries = appSchema.table('webhook_deliveries', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  endpointId: uuid('endpoint_id').notNull(),
  eventId: uuid('event_id').notNull(),
  state: text('state', { enum: WEBHOOK_DELIVERY_STATES }).notNull().default('pending'),
  attempts: smallint('attempts').notNull().default(0),
  nextAttemptAt: tz('next_attempt_at').notNull().defaultNow(),
  leaseUntil: tz('lease_until'),
  lastAttemptAt: tz('last_attempt_at'),
  lastStatusCode: smallint('last_status_code'),
  lastError: text('last_error'),
  lastDurationMs: integer('last_duration_ms'),
  deliveredAt: tz('delivered_at'),
  replayOf: uuid('replay_of'),
  createdAt: tz('created_at').notNull().defaultNow(),
});
