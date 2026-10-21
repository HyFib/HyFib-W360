import { z } from 'zod';
import {
  and,
  asc,
  AUTOMATION_END_REASONS,
  AUTOMATION_RUN_STATUSES,
  AUTOMATION_STEP_OUTCOMES,
  automationRunSteps,
  automationRuns,
  automations,
  CAMPAIGN_COMPLETION_REASONS,
  CAMPAIGN_PAUSE_REASONS,
  CAMPAIGN_STATUSES,
  campaignRecipients,
  campaigns,
  channelAccounts,
  commerceOrderItems,
  commerceOrders,
  commercePaymentLinks,
  commerceStoreCheckouts,
  commerceStoreMessages,
  commerceStoreOrders,
  commerceStores,
  contactMerges,
  contacts,
  CONVERSATION_STATUSES,
  conversations,
  CRM_CHANGERS,
  crmActivities,
  crmDeals,
  crmPipelines,
  crmTasks,
  csatSurveys,
  DEAL_STATUSES,
  eq,
  messageTemplates,
  messages,
  ORDER_STATUSES,
  ORDER_STATUS_CHANGERS,
  PAYMENT_LINK_STATUSES,
  SKIP_REASONS,
  sql,
  STORE_MESSAGE_ANSWERS,
  STORE_PLATFORMS,
  TASK_STATUSES,
  type OrderStatusChanger,
  type Tx,
  type WebhookEventType,
} from '@w360/db';
import { apiContactColumns, apiContactSchema, toApiContact } from '../api/contact-view';
import { apiDealItemsSchema, readApiDealItems } from '../api/deal-item-view';
import { FIELD_KEY_RE, NODE_TYPES } from '../automations/graph';
import {
  apiPaymentLinkSchema,
  paymentLinkColumns,
  toApiPaymentLink,
} from '../api/payment-link-view';
import {
  apiSatisfactionSurveySchema,
  satisfactionSurveyColumns,
  toApiSatisfactionSurvey,
} from '../api/satisfaction-survey-view';
import { campaignAnalytics, campaignResultsSchema, toCampaignResults } from '../campaigns/results';
import { VARIANT_LABELS, parseVariantLabel } from '../campaigns/variants';
import { runCampaignOf } from '../automations/run-campaigns';
import { COMMERCE_LIMITS } from '../commerce/model';
import { crmCreatedBy, noteWriter } from '../crm/common';
import { MAX_DEAL_ITEMS } from '../crm/deal-item-limits';
import { findAnsweredMessageId } from '../messaging/reply-context';
import { ORDER_MESSAGE_EVENTS } from '../stores/messages-model';
import {
  WEBHOOK_CART_REMINDER_SKIP_REASONS,
  WEBHOOK_CART_REMINDERS,
  WEBHOOK_MESSAGE_STATUSES,
  WEBHOOK_ORDER_MESSAGE_SKIP_REASONS,
  WEBHOOK_RUN_TRIGGERS,
} from './model';

/**
 * The JSON bodies of outgoing webhooks (ADR-053, ADR-074, ADR-078, ADR-085, ADR-087). The zod schemas
 * describe them in the OpenAPI document; `buildWebhookPayload` builds them from an event when it is
 * delivered, reading the company's current data (an erased contact has no number or name).
 */

const contactSchema = z.object({
  id: z.uuid(),
  phone: z
    .string()
    .nullable()
    .describe('E.164, like +919876543210; null once the contact is erased.'),
  name: z.string().nullable(),
});
const channelSchema = z.object({
  id: z.uuid(),
  phone: z.string().nullable().describe('The WhatsApp number as WhatsApp displays it.'),
});

/**
 * A time to the microsecond as webhook bodies give it (ADR-330): UTC with six fractional digits, as
 * `exactTimestamp` writes it, so such times sort as text in time order.
 */
export const WEBHOOK_EXACT_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** `createdAt` from the exact time: the same moment cut to the millisecond (ADR-330). */
export const toWebhookMillisecond = (exact: string): string => `${exact.slice(0, 23)}Z`;

function envelope<T extends string, D extends z.ZodType>(type: T, data: D) {
  return z.object({
    id: z
      .uuid()
      .describe('The event id: the same for every attempt and replay. Deduplicate on it.'),
    type: z.literal(type),
    createdAt: z.iso.datetime().describe('When it happened.'),
    createdAtExact: z
      .string()
      .regex(WEBHOOK_EXACT_TIME_RE)
      .describe(
        'createdAt to the microsecond, in UTC with six fractional digits (like 2026-10-09T08:15:30.123456Z), so such times sort as text. Two events that share a createdAt, cut to the millisecond, can differ in it; events stamped with the same moment, such as changes saved together in one transaction, share it too.',
      ),
    data,
  });
}

/** The reply a contact tapped, as webhooks and the API give it (ADR-080 added type and description). */
export const tappedReplySchema = z
  .object({
    id: z.string().nullable().describe('The id the button or row was sent with.'),
    title: z.string().nullable(),
    type: z
      .enum(['button', 'list'])
      .nullable()
      .describe(
        'button: a reply button or a template’s quick reply; list: a row of a list message.',
      ),
    description: z.string().nullable().describe('The description of the list row, if it had one.'),
  })
  .nullable()
  .describe('The button or list reply the contact tapped.');

export type TappedReply = z.infer<typeof tappedReplySchema>;

/** Whether an inbound message's content was too large to keep (ADR-131, ADR-132). */
export const contentTooLargeSchema = z
  .boolean()
  .describe(
    'True when WhatsApp sent more than a message may hold (64 KB), so its content was not kept: text, reply and mimeType are null. False for outbound messages.',
  );

/** How many contacts an inbound contact card left out (ADR-131, ADR-132). */
export const contactsLeftOutSchema = z
  .number()
  .int()
  .min(0)
  .describe(
    'For a contact card: how many of its contacts were left out because the card was larger than a message may hold; 0 otherwise. The contacts kept are in `contacts`.',
  );

const cardText = z.string().nullable();

/**
 * A contact a contact card shares (ADR-196), as WhatsApp gave it (research M-193) in the API's
 * words: what the person who sent the card chose, or could, share, so any part may be missing.
 */
export const contactCardSchema = z
  .object({
    name: z.object({
      formattedName: cardText.describe('The name as the card shows it.'),
      firstName: cardText,
      lastName: cardText,
      middleName: cardText,
      prefix: cardText,
      suffix: cardText,
    }),
    phones: z.array(
      z.object({
        phone: z.string().describe('The number as the card gives it, not necessarily in E.164.'),
        waId: cardText.describe(
          'The WhatsApp id WhatsApp gave for the number, when it has one; it may differ from the number.',
        ),
        type: cardText.describe('Such as CELL, MOBILE, HOME or WORK, as the card names it.'),
      }),
    ),
    emails: z.array(z.object({ email: z.string(), type: cardText })),
    urls: z.array(
      z.object({
        url: z.string().describe('As the card gives it; not checked to be a working address.'),
        type: cardText,
      }),
    ),
    addresses: z.array(
      z.object({
        street: cardText,
        city: cardText,
        state: cardText,
        zip: cardText,
        country: cardText,
        countryCode: cardText,
        type: cardText,
      }),
    ),
    org: z
      .object({ company: cardText, department: cardText, title: cardText })
      .nullable()
      .describe('Where the person works, if the card says.'),
    birthday: cardText.describe('As the card gives it, normally YYYY-MM-DD.'),
  })
  .describe(
    'A contact the card shares, as WhatsApp gave it: what the person who sent the card chose, or could, share, so any part may be missing.',
  );

export type ContactCard = z.infer<typeof contactCardSchema>;

/** The contacts of a contact card (ADR-196), on messages the API and webhooks give. */
export const messageContactsSchema = z
  .array(contactCardSchema)
  .nullable()
  .describe(
    'For a contact card: the contacts it shares, those kept when it was larger than a message may hold (see contactsLeftOut). Null for other messages, and when the content was removed or too large to keep.',
  );

export const messageReceivedPayloadSchema = envelope(
  'message.received',
  z.object({
    message: z.object({
      id: z.uuid(),
      type: z
        .string()
        .describe(
          'text, image, video, audio, document, sticker, location, contacts, interactive, button, reaction, order, system or unsupported.',
        ),
      text: z
        .string()
        .nullable()
        .describe(
          'The text, a caption, the title of a tapped reply, a reaction, or a location’s name (its address if it has no name); null if none.',
        ),
      reply: tappedReplySchema,
      replyTo: z
        .uuid()
        .nullable()
        .describe(
          'The id of the message this one answers: the message the contact quoted, the message a reaction is for, or the message whose button or row was tapped. Null when there is none or it is not in the conversation.',
        ),
      mimeType: z.string().nullable().describe('For media messages (the media is not attached).'),
      contentTooLarge: contentTooLargeSchema,
      contactsLeftOut: contactsLeftOutSchema,
      contacts: messageContactsSchema,
      receivedAt: z.iso.datetime(),
    }),
    conversation: z.object({ id: z.uuid() }),
    contact: contactSchema,
    channel: channelSchema,
  }),
);

export const messageStatusPayloadSchema = envelope(
  'message.status',
  z.object({
    message: z.object({
      id: z.uuid(),
      status: z.enum(WEBHOOK_MESSAGE_STATUSES),
      templateId: z.uuid().nullable(),
      templateName: z.string().nullable(),
      sentBy: z.enum(['agent', 'bot', 'campaign', 'api', 'system']),
      apiKeyId: z
        .uuid()
        .nullable()
        .describe('The API key that sent it, for messages sent through the API.'),
      campaignId: z
        .uuid()
        .nullable()
        .describe(
          'The campaign that sent it, as GET /campaigns lists it, for messages a campaign sent; null otherwise.',
        ),
    }),
    error: z.object({ code: z.string().nullable(), title: z.string().nullable() }).nullable(),
    conversation: z.object({ id: z.uuid() }),
    contact: contactSchema,
    channel: channelSchema,
  }),
);

export const consentChangedPayloadSchema = envelope(
  'consent.changed',
  z.object({
    contact: contactSchema,
    purpose: z.enum(['marketing', 'utility']),
    action: z.enum(['opt_in', 'opt_out']),
    source: z.string().describe('keyword, agent, import, provider, api, store or erasure.'),
  }),
);

export const templateStatusPayloadSchema = envelope(
  'template.status_changed',
  z.object({
    template: z.object({
      id: z.uuid(),
      name: z.string().nullable(),
      language: z.string().nullable(),
      category: z.string().nullable(),
      status: z
        .string()
        .describe(
          'pending, approved, rejected, paused, disabled, in_appeal, flagged, archived, deleted, limit_exceeded or locked.',
        ),
      reason: z.string().nullable().describe('The reason Meta gave, when it gave one.'),
    }),
  }),
);

const conversationStatusSchema = z.enum(CONVERSATION_STATUSES);

export const conversationStatusPayloadSchema = envelope(
  'conversation.status_changed',
  z.object({
    conversation: z.object({
      id: z.uuid(),
      status: conversationStatusSchema.describe('The status this event reports.'),
      previousStatus: conversationStatusSchema.describe('The status before it.'),
      assigned: z.boolean().describe('Whether a member is assigned when the event is delivered.'),
      assigneeId: z
        .uuid()
        .nullable()
        .describe('The member assigned when the event is delivered, as GET /members lists them.'),
      teamId: z
        .uuid()
        .nullable()
        .describe('The team when the event is delivered, as GET /teams lists them.'),
      resolvedAt: z.iso
        .datetime()
        .nullable()
        .describe('When it was resolved, if it is resolved when the event is delivered.'),
    }),
    contact: contactSchema,
    channel: channelSchema,
  }),
);

export const conversationAssignmentPayloadSchema = envelope(
  'conversation.assignment_changed',
  z.object({
    conversation: z.object({
      id: z.uuid(),
      status: conversationStatusSchema.describe('The status when the event is delivered.'),
      assigned: z
        .boolean()
        .describe('Whether a member is assigned after the change this event reports.'),
      assigneeId: z
        .uuid()
        .nullable()
        .describe(
          'The member assigned by the change, as GET /members lists them; null for none. Null too for events captured before members were named.',
        ),
      previousAssigneeId: z
        .uuid()
        .nullable()
        .describe('The member before the change; null for none, or for events captured before.'),
      teamId: z
        .uuid()
        .nullable()
        .describe('The team when the event is delivered, as GET /teams lists them.'),
    }),
    contact: contactSchema,
    channel: channelSchema,
  }),
);

export const conversationTeamPayloadSchema = envelope(
  'conversation.team_changed',
  z.object({
    conversation: z.object({
      id: z.uuid(),
      status: conversationStatusSchema.describe('The status when the event is delivered.'),
      teamId: z
        .uuid()
        .nullable()
        .describe('The team after the change, as GET /teams lists them; null for none.'),
      previousTeamId: z.uuid().nullable().describe('The team before the change; null for none.'),
      assigneeId: z
        .uuid()
        .nullable()
        .describe('The member assigned when the event is delivered, as GET /members lists them.'),
    }),
    contact: contactSchema,
    channel: channelSchema,
  }),
);

/** A contact in the API's words (the `Contact` of GET /contacts/{id}), and whether it was erased. */
const webhookContactSchema = apiContactSchema.extend({
  erased: z
    .boolean()
    .describe(
      'An erased contact is sent with its id, source and creation time only: delete your copy.',
    ),
});

export const contactCreatedPayloadSchema = envelope(
  'contact.created',
  z.object({ contact: webhookContactSchema }),
);
/** A part of the contact a change can change, in the API contact's names (ADR-121). */
export const CONTACT_CHANGE_PART_RE = /^(name|phone|email|tags|fields\.[a-z][a-z0-9_]{0,39})$/;

export const contactUpdatedPayloadSchema = envelope(
  'contact.updated',
  z.object({
    contact: webhookContactSchema,
    changes: z
      .array(z.string().regex(CONTACT_CHANGE_PART_RE))
      .nullable()
      .describe(
        'What the change changed, sorted, once each: `name`, `phone`, `email`, `tags` (a tag added or removed), and `fields.<key>` for each custom field whose value changed (GET /contact-fields). Names only: the contact carries the values as they are now. Null for an event captured before HyFib recorded what changed.',
      ),
    tagsAdded: z
      .array(z.string())
      .nullable()
      .describe(
        'The tags the change added, sorted, as the contact lists them; empty when it added none. A tag added and removed again in the same change is in neither list. Null for an event captured before HyFib recorded tags, and once the contact is erased.',
      ),
    tagsRemoved: z
      .array(z.string())
      .nullable()
      .describe(
        'The tags the change removed, sorted, as the contact listed them; empty when it removed none. Null for an event captured before HyFib recorded tags, and once the contact is erased.',
      ),
  }),
);
export const contactErasedPayloadSchema = envelope(
  'contact.erased',
  z.object({ contact: webhookContactSchema }),
);
export const contactMergedPayloadSchema = envelope(
  'contact.merged',
  z.object({
    contact: webhookContactSchema.describe(
      'The contact the other was merged into, as it is when the event is delivered; if it was merged into another contact since, that contact.',
    ),
    mergedContactId: z
      .uuid()
      .describe(
        'The contact merged and deleted: its conversations, consent, tags and other records are the contact’s now, and its id is no longer found. Delete your copy, or move what you keep of it to the contact.',
      ),
  }),
);

const webhookRunSchema = z.object({
  id: z.uuid(),
  automationId: z.uuid(),
  automationName: z
    .string()
    .nullable()
    .describe('The automation’s name when the event is delivered.'),
  trigger: z
    .enum(WEBHOOK_RUN_TRIGGERS)
    .describe(
      'What started it: a keyword, a new conversation, any message, a store’s order event, a call through the API or an enrolment of the contact by a member or an API key (api; apiKeyId or enrollmentId says which), or the contact’s reply to a campaign message (campaign_reply; campaign says which).',
    ),
  apiKeyId: z
    .uuid()
    .nullable()
    .describe(
      'The API key that started it, for a run started through the API; null for every other run, including a run an enrolment started, whether a member or an API key started the enrolment (enrollmentId names it; the enrolment names its key).',
    ),
  enrollmentId: z
    .uuid()
    .nullable()
    .describe(
      'The enrolment that started it, by a member or an API key (trigger api, apiKeyId null); null for every other run. One enrolment starts many runs, one per contact.',
    ),
  campaign: z
    .object({
      id: z.uuid(),
      name: z.string().describe('The campaign’s name when the event is delivered.'),
      variant: z
        .enum(VARIANT_LABELS)
        .describe(
          'The variant the contact was sent, as GET /campaigns/{id}/recipients gives it (A for a campaign without variants).',
        ),
    })
    .nullable()
    .describe(
      'The campaign whose message the contact answered, quoting it or tapping one of its quick-reply buttons, for a run started by a reply to a campaign (trigger campaign_reply); null for every other run. The button tapped is not given, as a run’s answers are not.',
    ),
  status: z
    .enum(AUTOMATION_RUN_STATUSES)
    .describe('The status this event reports: running when it started, the status it ended with.'),
  endReason: z
    .enum(Object.values(AUTOMATION_END_REASONS).flat() as [string, ...string[]])
    .nullable()
    .describe('Why it ended; null for automation.run_started.'),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable().describe('When it ended; null for automation.run_started.'),
});
const webhookRunDataSchema = z.object({
  run: webhookRunSchema,
  conversation: z.object({ id: z.uuid() }),
  contact: contactSchema,
  channel: channelSchema,
});

export const automationRunStartedPayloadSchema = envelope(
  'automation.run_started',
  webhookRunDataSchema,
);
export const automationRunEndedPayloadSchema = envelope(
  'automation.run_ended',
  webhookRunDataSchema,
);

/**
 * A step of an automation run (ADR-326): its number, the kind of node it ran, its outcome and the
 * message it sent, as the run's log recorded them. Never the branch it took (for an answered
 * question, the title of the button the customer tapped: their answer, withheld as a run's answers
 * are) or the step's detail (a note for the run's page).
 */
const webhookRunStepSchema = z.object({
  number: z
    .number()
    .int()
    .min(0)
    .describe(
      'The step’s place in its run, from 0 (the run starting). Deliveries are not ordered: order a run’s steps by it.',
    ),
  nodeType: z
    .enum(NODE_TYPES)
    .nullable()
    .describe(
      'The kind of node the step ran, as the automation builder names it (send_text, ask_buttons, condition, http_request, create_deal…); null for what happened to the run outside a node: it started, it was stopped or taken over, or it failed between steps (it expired, say).',
    ),
  outcome: z
    .enum(AUTOMATION_STEP_OUTCOMES)
    .describe(
      'What the step did, as the run’s page in Automations lists it: started; sent a message; asked the customer, got an answer (answered), asked again (retried) or had no reply in time (timed_out); checked a condition (branched); updated the contact or conversation; started waiting or the wait ended (resumed); made a web request (requested) and had it finish (responded); created, moved or closed in the CRM, or skipped a CRM step; handed_off, completed, failed, stopped or taken_over.',
    ),
  messageId: z
    .uuid()
    .nullable()
    .describe(
      'The message the step sent (a message, a question, a template or a form), whose message.status events follow it; null for a step that sent none. Erasing the contact redacts the message and keeps its id.',
    ),
});
export const automationRunStepPayloadSchema = envelope(
  'automation.run_step',
  z.object({
    run: webhookRunSchema
      .pick({
        id: true,
        automationId: true,
        automationName: true,
        trigger: true,
        apiKeyId: true,
        enrollmentId: true,
        startedAt: true,
      })
      .describe('The run the step belongs to, as it is when the event is delivered.'),
    step: webhookRunStepSchema,
    conversation: z.object({ id: z.uuid() }),
    contact: contactSchema,
    channel: channelSchema,
  }),
);

const orderStatusSchema = z.enum(ORDER_STATUSES);

const webhookOrderSchema = z.object({
  id: z.uuid(),
  reference: z
    .string()
    .describe('The short reference members and the customer quote, like K7M2QX9P.'),
  status: orderStatusSchema.describe(
    'The status this event reports: received for order.received, the new status for a change.',
  ),
  previousStatus: orderStatusSchema
    .nullable()
    .describe('The status before it; null for order.received.'),
  changedBy: z
    .enum(ORDER_STATUS_CHANGERS)
    .nullable()
    .describe(
      'Who made the change order.status_changed reports: a member on the order page (member, never which member), an API key (api, named by apiKeyId) or HyFib applying what Razorpay reports for the order’s Payment Link (payment_link: paid, or back to confirmed when the link ended unpaid). Null for order.received, and for a change HyFib did not record the maker of.',
    ),
  apiKeyId: z
    .uuid()
    .nullable()
    .describe('The API key that made the change, when changedBy is api; null otherwise.'),
  messageId: z.uuid().describe('The order message, as message.received names it.'),
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
      `Cart items that could not be read or were beyond the limit of ${COMMERCE_LIMITS.orderItems}.`,
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
  paidAt: z.iso
    .datetime()
    .nullable()
    .describe('When Razorpay reported it paid, if it is paid when the event is delivered.'),
});
const webhookOrderDataSchema = z.object({
  order: webhookOrderSchema,
  conversation: z.object({ id: z.uuid() }),
  contact: contactSchema,
  channel: channelSchema,
});

export const orderReceivedPayloadSchema = envelope('order.received', webhookOrderDataSchema);
export const orderStatusChangedPayloadSchema = envelope(
  'order.status_changed',
  webhookOrderDataSchema,
);

/**
 * A Payment Link's change of status (ADR-285): the link as GET /orders/{id}/payment-links reads it
 * when the event is delivered (ADR-284), with the status and the one before it as captured; never
 * its address or Razorpay's ids.
 */
const webhookPaymentLinkSchema = apiPaymentLinkSchema.extend({
  status: z
    .enum(PAYMENT_LINK_STATUSES)
    .describe(
      'The status this event reports, as the worker wrote it: created (open: sent in the chat, or notSentReason says why not), partially_paid, paid (which marks the order paid), expired, cancelled, or failed (Razorpay could not create it: error says why).',
    ),
  previousStatus: z.enum(PAYMENT_LINK_STATUSES).describe('The status before it.'),
});
export const paymentLinkStatusChangedPayloadSchema = envelope(
  'payment_link.status_changed',
  z.object({
    paymentLink: webhookPaymentLinkSchema,
    order: z.object({
      id: z.uuid().describe('The order, as GET /orders/{id} reads it.'),
      reference: z.string().describe('The short reference members and the customer quote.'),
      status: z
        .enum(ORDER_STATUSES)
        .describe(
          'The order’s status when the event is delivered: order.status_changed reports its changes.',
        ),
    }),
    conversation: z.object({ id: z.uuid() }),
    contact: contactSchema,
    channel: channelSchema,
  }),
);

const campaignStatusSchema = z.enum(CAMPAIGN_STATUSES);

const webhookCampaignSchema = z.object({
  id: z.uuid(),
  name: z.string().describe('The campaign’s name when the event is delivered.'),
  status: campaignStatusSchema.describe('The status this event reports.'),
  previousStatus: campaignStatusSchema.describe('The status before it.'),
  pauseReason: z
    .enum(CAMPAIGN_PAUSE_REASONS)
    .nullable()
    .describe(
      'Why it paused, when the status is paused: a member paused it (manual), an API key did (api), the spending or message cap was reached, the template is no longer approved, the number is not active, the member whose authority it runs under left or lost the permission, or no rate card is published for its spending cap. Null otherwise.',
    ),
  completionReason: z
    .enum(CAMPAIGN_COMPLETION_REASONS)
    .nullable()
    .describe(
      'Why it completed, when the status is completed: every recipient was processed, or its sending time ran out. Null otherwise.',
    ),
  templateId: z
    .uuid()
    .nullable()
    .describe(
      'Variant A’s (the campaign’s own) template; a campaign with variants also sends theirs, B to E (see `variants` in GET /campaigns/{id}).',
    ),
  templateName: z
    .string()
    .nullable()
    .describe(
      'Variant A’s (the campaign’s own) template’s name when the event is delivered; see `variants` in GET /campaigns/{id} for the other variants’.',
    ),
  scheduledAt: z.iso.datetime().nullable().describe('When it was set to start.'),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  canceledAt: z.iso.datetime().nullable(),
  audienceCount: z
    .number()
    .int()
    .describe('Contacts in the audience taken when it was submitted; 0 while it is a draft.'),
  queuedCount: z.number().int().describe('Recipients whose message has been queued.'),
  skippedCount: z
    .number()
    .int()
    .describe('Recipients skipped: no consent, suppressed, erased, over a cap and the like.'),
  results: campaignResultsSchema
    .nullable()
    .describe(
      'Its results as GET /campaigns/{id} counts them, counted when this request was built (the t of its W360-Signature), so a retry or a replay counts again. Null while it is a draft, which has no recipients yet.',
    ),
});

export const campaignStatusChangedPayloadSchema = envelope(
  'campaign.status_changed',
  z.object({
    campaign: webhookCampaignSchema,
    channel: channelSchema.nullable().describe('The number it sends from; null if none is set.'),
  }),
);

/** A recipient a campaign skipped, as `campaign.recipient_skipped` gives it (ADR-358). */
export const campaignRecipientSkippedPayloadSchema = envelope(
  'campaign.recipient_skipped',
  z.object({
    recipient: z.object({
      id: z
        .uuid()
        .describe(
          'The recipient, as GET /campaigns/{id}/recipients lists it while its contact is not erased.',
        ),
      skipReason: z
        .enum(SKIP_REASONS)
        .describe(
          'Why the campaign did not send it its message, as the campaign’s page explains it: contact_erased, no_phone (no WhatsApp number), suppressed (on the suppression list), opted_out, no_marketing_opt_in, missing_variable (no value for a variable without a fallback), frequency_capped (the marketing frequency cap), cost_unknown (no price for the number’s market under a spending cap) or expired (the sending period ended first).',
        ),
      variant: z
        .enum(VARIANT_LABELS)
        .describe(
          'The variant the recipient was given when the audience was taken, as GET /campaigns/{id}/recipients gives it: A, the campaign’s own template, B, its second template, or C, D or E, its third to fifth for a campaign that tests more than two. A for every recipient of a campaign without variants. The reason was checked against its variant’s template (a marketing variant needs marketing consent).',
        ),
    }),
    campaign: z.object({
      id: z.uuid(),
      name: z.string().describe('The campaign’s name when the event is delivered.'),
      status: campaignStatusSchema.describe('Its status when the event is delivered.'),
      templateId: z
        .uuid()
        .nullable()
        .describe(
          'Variant A’s (the campaign’s own) template; the recipient’s template is its variant’s (see `recipient.variant`).',
        ),
      templateName: z
        .string()
        .nullable()
        .describe(
          'Variant A’s (the campaign’s own) template’s name when the event is delivered; see `recipient.variant`.',
        ),
    }),
    contact: contactSchema.describe(
      'The recipient’s contact as it is when the event is delivered (a contact merged into another is the one it was merged into), as erasure left it.',
    ),
    channel: channelSchema
      .nullable()
      .describe('The number the campaign sends from; null if none is set.'),
  }),
);

const dealStatusSchema = z.enum(DEAL_STATUSES);

/**
 * A CRM deal as its events give it (ADR-256): its stage, pipeline and status (and those before them)
 * as the event's step left them, the rest as it is when the event is delivered.
 */
const webhookDealSchema = z.object({
  id: z.uuid().describe('The deal, as GET /deals/{id} reads it.'),
  title: z
    .string()
    .describe(
      'The deal’s title when the event is delivered; “Deal (contact erased)” once its contact is erased.',
    ),
  pipelineId: z
    .uuid()
    .describe('The deal’s pipeline as this event left it, as GET /pipelines lists it.'),
  stageId: z
    .uuid()
    .describe(
      'The deal’s stage as this event left it: for deal.stage_changed, the one it moved to.',
    ),
  status: dealStatusSchema.describe(
    'The deal’s status as this event left it: for deal.status_changed, the new one.',
  ),
  previousStageId: z
    .uuid()
    .nullable()
    .describe('deal.stage_changed: the stage it left. Null for other events.'),
  previousPipelineId: z
    .uuid()
    .nullable()
    .describe(
      'deal.stage_changed: the pipeline it left, when it moved to another one. Null otherwise.',
    ),
  previousStatus: dealStatusSchema
    .nullable()
    .describe('deal.status_changed: the status before it. Null for other events.'),
  previousOwnerId: z
    .uuid()
    .nullable()
    .describe(
      'deal.owner_changed: the member who owned the deal before, or null when it had no owner. Null for other events.',
    ),
  valueMinor: z
    .number()
    .int()
    .nullable()
    .describe(
      'Its value in the currency’s minor units (paise for INR) when the event is delivered; null when it has none.',
    ),
  currency: z.string().describe('ISO 4217, like INR: its pipeline’s currency.'),
  ownerId: z
    .uuid()
    .nullable()
    .describe(
      'The member who owns the deal (an id from GET /members): for deal.owner_changed, the one it was given to, or null when it was left without one; for other events, its owner when the event is delivered.',
    ),
  expectedCloseOn: z.iso.date().nullable(),
  lostReason: z
    .string()
    .nullable()
    .describe(
      'Why a lost deal was lost, when the event is delivered; null otherwise, and once its contact is erased.',
    ),
  createdBy: z
    .enum(['member', 'automation', 'api'])
    .describe('Who added the deal: a member, an automation’s run or an API key.'),
  createdAt: z.iso.datetime(),
  items: apiDealItemsSchema.describe(
    `The deal’s products when the event is delivered, exactly as GET /deals/{id}/items lists them (\`deals.read\`): in the order they were added, at most ${MAX_DEAL_ITEMS}, each with its content id, its catalog, its name when it was added, its quantity, the price of one and their total in the minor units of its currency, and who added it; empty when it lists none. An erased contact’s deal keeps its products (they name catalog products, not the customer), so they are sent. Each product added or removed sends deal.updated naming \`items\` in its changes. Bodies delivered before deal events carried products have no items.`,
  ),
  changedBy: z
    .enum(CRM_CHANGERS)
    .nullable()
    .describe(
      'Who made what this event reports, as it was captured: a member (never which member), an automation’s run, or an API key (api, named by apiKeyId); for deal.created, who added the deal, and for a product added, who added the product. Null for a change HyFib did not record the maker of, such as erasure retitling the deal.',
    ),
  apiKeyId: z
    .uuid()
    .nullable()
    .describe(
      'The API key that made what this event reports, when changedBy is api; null otherwise.',
    ),
});
const webhookDealDataSchema = z.object({
  deal: webhookDealSchema,
  conversation: z
    .object({ id: z.uuid() })
    .nullable()
    .describe('The conversation the deal was created from, if any.'),
  contact: contactSchema,
});

export const dealCreatedPayloadSchema = envelope('deal.created', webhookDealDataSchema);

/**
 * The details of a deal whose change deal.updated reports (ADR-275), as its payload names them:
 * `fields` is a change of its custom field values (ADR-390), after the fixed details, and `items` a
 * product added or removed (ADR-397), captured alone by the trigger on the deal's items.
 */
export const WEBHOOK_DEAL_DETAIL_CHANGES = [
  'title',
  'valueMinor',
  'expectedCloseOn',
  'fields',
  'items',
] as const;
export const dealUpdatedPayloadSchema = envelope(
  'deal.updated',
  webhookDealDataSchema.extend({
    changes: z
      .array(z.enum(WEBHOOK_DEAL_DETAIL_CHANGES))
      .min(1)
      .describe(
        'What the change changed, once each and in this order: `title`, `valueMinor` (the value, set, changed or cleared), `expectedCloseOn`, `fields` (custom field values, set, changed or removed; changedFields names the fields) and `items` (a product added to or removed from the deal, each its own event naming `items` alone). Names only: the deal carries the details as they are when the event is delivered, its products among them (deal.items), and GET /deals/{id} reads its custom field values (`fields`).',
      ),
    changedFields: z
      .array(z.string().regex(FIELD_KEY_RE))
      .describe(
        'The keys of the custom deal fields whose values the change set, changed or removed (GET /deal-fields), once each, in the order the fields were added, as GET /deal-fields lists them; empty when changes does not name `fields`. Keys only, never the values.',
      ),
  }),
);

/**
 * What a deal.updated event captured as changed (ADR-275, ADR-390, ADR-397), as its payload gives
 * it: the details its payload knows, in the payload's order, and the keys of the custom fields whose
 * values changed (only when the details name `fields`), once each, in the order captured. An event
 * captured before keys were recorded names none; a change of products names `items` and no keys.
 */
export function dealUpdatedChanges(detail: Record<string, unknown>) {
  const changes = detailChanges(detail, WEBHOOK_DEAL_DETAIL_CHANGES);
  const captured =
    changes.includes('fields') && Array.isArray(detail.changedFields) ? detail.changedFields : [];
  const changedFields = [
    ...new Set(
      captured.filter((key): key is string => typeof key === 'string' && FIELD_KEY_RE.test(key)),
    ),
  ];
  return { changes, changedFields };
}
export const dealStageChangedPayloadSchema = envelope('deal.stage_changed', webhookDealDataSchema);
export const dealOwnerChangedPayloadSchema = envelope('deal.owner_changed', webhookDealDataSchema);
export const dealStatusChangedPayloadSchema = envelope(
  'deal.status_changed',
  webhookDealDataSchema,
);

const taskStatusSchema = z.enum(TASK_STATUSES);

/**
 * A CRM task as its events give it (ADR-261): its status (and the one before it) as the event left
 * it, the rest as it is when the event is delivered. Never its notes: GET /tasks/{id} reads them.
 */
const webhookTaskSchema = z.object({
  id: z.uuid().describe('The task, as GET /tasks/{id} reads it with `tasks.read`.'),
  title: z.string().describe('The task’s title when the event is delivered.'),
  status: taskStatusSchema.describe(
    'The task’s status as this event left it: for task.status_changed, the new one.',
  ),
  previousStatus: taskStatusSchema
    .nullable()
    .describe('task.status_changed: the status before it. Null for task.created.'),
  dueAt: z.iso
    .datetime()
    .nullable()
    .describe('When the task is due, when the event is delivered; null when it has no due time.'),
  assigneeId: z
    .uuid()
    .describe(
      'The member the task is assigned to (an id from GET /members): for task.assignee_changed, the one it was given to; for other events, its assignee when the event is delivered.',
    ),
  previousAssigneeId: z
    .uuid()
    .nullable()
    .describe(
      'task.assignee_changed: the member the task was assigned to before. Null for other events.',
    ),
  dealId: z
    .uuid()
    .nullable()
    .describe(
      'The deal the task is about, as GET /deals/{id} reads it; null when it is about none.',
    ),
  createdBy: z
    .enum(['member', 'automation', 'api'])
    .describe('Who added the task: a member, an automation’s run or an API key.'),
  createdAt: z.iso.datetime(),
  changedBy: z
    .enum(CRM_CHANGERS)
    .nullable()
    .describe(
      'Who made what this event reports, as it was captured: a member (never which member) or an API key (api, named by apiKeyId); for task.created, who added the task, an automation’s run among them. Null for a change HyFib did not record the maker of.',
    ),
  apiKeyId: z
    .uuid()
    .nullable()
    .describe(
      'The API key that made what this event reports, when changedBy is api; null otherwise.',
    ),
});
const webhookTaskDataSchema = z.object({
  task: webhookTaskSchema,
  contact: contactSchema
    .nullable()
    .describe('The customer the task is about, as it is now; null when it is about none.'),
});

export const taskCreatedPayloadSchema = envelope('task.created', webhookTaskDataSchema);

/** The details of a task whose change task.updated reports (ADR-276), as its payload names them. */
export const WEBHOOK_TASK_DETAIL_CHANGES = ['title', 'notes', 'dueAt', 'remindAt'] as const;
export const taskUpdatedPayloadSchema = envelope(
  'task.updated',
  webhookTaskDataSchema.extend({
    changes: z
      .array(z.enum(WEBHOOK_TASK_DETAIL_CHANGES))
      .min(1)
      .describe(
        'What the change changed, once each and in this order: `title`, `notes`, `dueAt` (the due time, set, changed or cleared) and `remindAt` (the reminder time, likewise). Names only: the task carries its title and due time as they are when the event is delivered, and GET /tasks/{id} reads its notes and reminder.',
      ),
  }),
);
export const taskAssigneeChangedPayloadSchema = envelope(
  'task.assignee_changed',
  webhookTaskDataSchema,
);
export const taskStatusChangedPayloadSchema = envelope(
  'task.status_changed',
  webhookTaskDataSchema,
);

/**
 * A CRM note as its event gives it (ADR-280): what it is about and who wrote it, as it is when the
 * event is delivered. Never its text, which may hold anything a member wrote: GET /notes/{id} reads
 * it with `notes.read` (ADR-279).
 */
const webhookNoteSchema = z.object({
  id: z.uuid().describe('The note, as GET /notes/{id} reads it with `notes.read`.'),
  dealId: z
    .uuid()
    .nullable()
    .describe(
      'The deal the note is about, as GET /deals/{id} reads it; null when it is about the contact only.',
    ),
  writtenBy: z
    .enum(['member', 'api'])
    .describe(
      'Who wrote the note: a member on the contact or deal page (member, never which member) or an API key (api, named by apiKeyId).',
    ),
  apiKeyId: z
    .uuid()
    .nullable()
    .describe('The API key that added the note, when writtenBy is api; null otherwise.'),
  createdAt: z.iso.datetime().describe('When the note was added.'),
});
export const noteCreatedPayloadSchema = envelope(
  'note.created',
  z.object({
    note: webhookNoteSchema,
    contact: contactSchema.describe(
      'The customer whose timeline holds the note, as it is now: the one it was added to, or the contact kept when a merge moved it.',
    ),
  }),
);

/**
 * A customer's answer to a satisfaction survey (ADR-293): the survey as GET /satisfaction-surveys
 * reads it when the event is delivered (ADR-292), with its conversation, contact and number.
 */
export const satisfactionSurveyAnsweredPayloadSchema = envelope(
  'satisfaction_survey.answered',
  z.object({
    survey: apiSatisfactionSurveySchema,
    conversation: z.object({ id: z.uuid() }),
    contact: contactSchema,
    channel: channelSchema,
  }),
);

/**
 * A customer's answer to a store order's cash on delivery confirmation (ADR-348): the answer, the one
 * before it, the tap and the confirmation as captured; the order and its store as they are when the
 * event is delivered. Never the customer's details from the store, which the contact replaces.
 */
const webhookStoreConfirmationSchema = z.object({
  answer: z
    .enum(STORE_MESSAGE_ANSWERS)
    .describe(
      'The answer this event reports, by the button the customer tapped: confirmed or cancelled.',
    ),
  previousAnswer: z
    .enum(STORE_MESSAGE_ANSWERS)
    .nullable()
    .describe('The answer it replaced; null for the first.'),
  answeredAt: z.iso.datetime().describe('When the customer tapped, as WhatsApp dated the tap.'),
  messageId: z
    .uuid()
    .describe('The cash on delivery confirmation HyFib sent, among the conversation’s messages.'),
  answerMessageId: z.uuid().describe('The customer’s tap, among the conversation’s messages.'),
});
const webhookStoreOrderSchema = z.object({
  id: z.uuid().describe('HyFib’s copy of the order.'),
  externalId: z.string().describe('The order’s id at the store, to find it there.'),
  name: z.string().describe('The order’s name at the store, like #1001.'),
  status: z
    .string()
    .describe(
      'The order’s status as HyFib’s copy keeps it: open, closed or cancelled for a Shopify order; the store’s own status, like processing or completed, for a WooCommerce order.',
    ),
  financialStatus: z
    .string()
    .nullable()
    .describe(
      'Shopify’s payment status in lower case, like pending or paid; null for WooCommerce.',
    ),
  fulfillmentStatus: z
    .string()
    .nullable()
    .describe(
      'Shopify’s fulfilment status in lower case, like unfulfilled or fulfilled; null for WooCommerce.',
    ),
  test: z.boolean().describe('A test order.'),
  currency: z.string().nullable().describe('ISO 4217 code; null when the store gave none.'),
  totalMinor: z
    .number()
    .int()
    .nullable()
    .describe(
      'The order’s total as an integer in the currency’s minor units; null without a currency.',
    ),
  placedAt: z.iso.datetime(),
  cancelledAt: z.iso
    .datetime()
    .nullable()
    .describe(
      'When the store says the order was cancelled; null when it was not, or when the store gives no time (WooCommerce).',
    ),
  deletedAt: z.iso
    .datetime()
    .nullable()
    .describe('When HyFib learned that the store deleted the order; null while it has not.'),
});
const webhookStoreSchema = z.object({
  id: z.uuid(),
  platform: z.enum(STORE_PLATFORMS),
  name: z.string().nullable().describe('The store’s name, as the store gives it.'),
  url: z.string().describe('The store’s address.'),
});
export const storeOrderCodAnsweredPayloadSchema = envelope(
  'store_order.cod_answered',
  z.object({
    confirmation: webhookStoreConfirmationSchema,
    storeOrder: webhookStoreOrderSchema,
    store: webhookStoreSchema,
    conversation: z.object({ id: z.uuid() }),
    contact: contactSchema,
    channel: channelSchema,
  }),
);

/**
 * A store's order message that HyFib did not send (ADR-351): the event it was for, why, and when the
 * order's event happened, as captured; the order and its store as they are when the event is
 * delivered. Never the customer's details from the store, and no contact or number: the message was
 * never sent.
 */
const webhookSkippedOrderMessageSchema = z.object({
  event: z
    .enum(ORDER_MESSAGE_EVENTS)
    .describe(
      'What the message was about, as the store’s order messages name it: order_placed, cod_confirmation (asking the customer to confirm or cancel an order paid on delivery), order_shipped, order_delivered or order_cancelled.',
    ),
  skipReason: z
    .enum(WEBHOOK_ORDER_MESSAGE_SKIP_REASONS)
    .describe(
      'Why HyFib did not send it, as the store’s Messages page (Commerce → Stores) explains it: recorded without sending (test_order, too_late, or cash_on_delivery for an order placed message that the order’s cash on delivery confirmation replaced) or a check that failed when it was due (for example store_disconnected, rule_disabled, order_deleted, order_cancelled, no_phone, suppressed, opted_out, template_unavailable, channel_unavailable, frequency_capped, automation_busy). The reasons that concern only cart reminders never appear here.',
    ),
  occurredAt: z.iso
    .datetime()
    .describe(
      'When the order’s event happened, as the store dated it; for a cancellation the store gives no time for, when HyFib saw it.',
    ),
});
export const storeOrderMessageSkippedPayloadSchema = envelope(
  'store_order.message_skipped',
  z.object({
    orderMessage: webhookSkippedOrderMessageSchema,
    storeOrder: webhookStoreOrderSchema,
    store: webhookStoreSchema,
  }),
);

/**
 * A store's order message that went out (ADR-353): the event it was for, when that happened and the
 * message or the run, as captured; the order, its store, the conversation's contact and its number
 * as they are when the event is delivered. Never the customer's details from the store, which the
 * contact replaces.
 */
const webhookSentOrderMessageSchema = z.object({
  event: z
    .enum(ORDER_MESSAGE_EVENTS)
    .describe(
      'What the message was about, as the store’s order messages name it: order_placed, cod_confirmation (asking the customer to confirm or cancel an order paid on delivery), order_shipped, order_delivered or order_cancelled.',
    ),
  occurredAt: z.iso
    .datetime()
    .describe(
      'When the order’s event happened, as the store dated it; for a cancellation the store gives no time for, when HyFib saw it.',
    ),
  messageId: z
    .uuid()
    .nullable()
    .describe(
      'The template message HyFib sent, among the conversation’s messages: its delivery follows as message.status events with this message.id. Null when the rule started an automation instead.',
    ),
  automationRunId: z
    .uuid()
    .nullable()
    .describe(
      'The automation run the rule started instead of sending a template, as automation.run_started events give it in run.id; null for a template.',
    ),
});
export const storeOrderMessageSentPayloadSchema = envelope(
  'store_order.message_sent',
  z.object({
    orderMessage: webhookSentOrderMessageSchema,
    storeOrder: webhookStoreOrderSchema,
    store: webhookStoreSchema,
    conversation: z.object({ id: z.uuid() }),
    contact: contactSchema,
    channel: channelSchema,
  }),
);

/**
 * A checkout a customer left in a connected Shopify store, as the cart reminder events give it
 * (ADR-355): HyFib's copy, read when the event is delivered. Never the customer's name, number or
 * consent, the items' titles or the link back to the checkout.
 */
const webhookStoreCheckoutSchema = z.object({
  id: z.uuid().describe('HyFib’s copy of the checkout.'),
  externalId: z.string().describe('The checkout’s id at the store, to find it there.'),
  name: z.string().nullable().describe('The checkout’s name at the store, if it gave one.'),
  currency: z.string().nullable().describe('ISO 4217 code; null when the store gave none.'),
  totalMinor: z
    .number()
    .int()
    .nullable()
    .describe(
      'The checkout’s total as an integer in the currency’s minor units; null without a currency.',
    ),
  itemCount: z.number().int().nullable().describe('How many items the checkout holds.'),
  startedAt: z.iso
    .datetime()
    .describe('When the customer began the checkout, as the store dated it.'),
  completedAt: z.iso
    .datetime()
    .nullable()
    .describe('When the customer completed it; null while they have not.'),
});
const webhookCartReminderEventSchema = z
  .enum(WEBHOOK_CART_REMINDERS)
  .describe(
    'Which reminder it was: cart_reminder, the first, or cart_second_reminder, the second.',
  );
export const storeCheckoutReminderSkippedPayloadSchema = envelope(
  'store_checkout.reminder_skipped',
  z.object({
    reminder: z.object({
      event: webhookCartReminderEventSchema,
      skipReason: z
        .enum(WEBHOOK_CART_REMINDER_SKIP_REASONS)
        .describe(
          'Why HyFib did not send it, as the store’s Messages page (Commerce → Stores) explains it: for example checkout_completed, cart_too_old, order_placed (an order with the same number since the checkout began), first_reminder_not_sent, no_phone, no_marketing_opt_in or frequency_capped.',
        ),
      occurredAt: z.iso
        .datetime()
        .describe(
          'When the checkout was last left, as the store dated it, from which the reminder counted.',
        ),
    }),
    storeCheckout: webhookStoreCheckoutSchema,
    store: webhookStoreSchema,
  }),
);
export const storeCheckoutReminderSentPayloadSchema = envelope(
  'store_checkout.reminder_sent',
  z.object({
    reminder: z.object({
      event: webhookCartReminderEventSchema,
      occurredAt: z.iso
        .datetime()
        .describe(
          'When the checkout was last left, as the store dated it, from which the reminder counted.',
        ),
      messageId: z
        .uuid()
        .describe(
          'The template message HyFib sent, among the conversation’s messages: its delivery follows as message.status events with this message.id.',
        ),
    }),
    storeCheckout: webhookStoreCheckoutSchema,
    store: webhookStoreSchema,
    conversation: z.object({ id: z.uuid() }),
    contact: contactSchema,
    channel: channelSchema,
  }),
);

export const pingPayloadSchema = envelope(
  'ping',
  z.object({ endpointId: z.uuid(), message: z.string() }),
);

export type WebhookPayload = {
  id: string;
  type: string;
  createdAt: string;
  createdAtExact: string;
  data: unknown;
};

/**
 * The event as stored: ids and non-personal facts, and the tags a contact change added and removed,
 * which erasing the contact clears (ADR-182).
 */
export interface StoredWebhookEvent {
  id: string;
  tenantId: string;
  type: WebhookEventType | 'ping';
  messageId: string | null;
  conversationId: string | null;
  contactId: string | null;
  templateId: string | null;
  status: string | null;
  detail: Record<string, unknown>;
  /** What a contact.updated event's transaction changed (ADR-121); null for other events. */
  contactChanges: string[] | null;
  /** The tags a contact.updated event's transaction added and removed (ADR-182). */
  tagsAdded: string[] | null;
  tagsRemoved: string[] | null;
  occurredAt: Date;
  /**
   * `occurredAt` to the microsecond, as `exactTimestamp` writes it (ADR-330); null for a time with
   * no such form (an infinite one).
   */
  occurredAtExact: string | null;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * The details a deal.updated (ADR-275) or task.updated (ADR-276) event captured as changed, among
 * the names its payload knows, in the payload's order.
 */
const detailChanges = <T extends string>(detail: Record<string, unknown>, names: readonly T[]) => {
  const captured = Array.isArray(detail.changes) ? detail.changes : [];
  return names.filter((name) => captured.includes(name));
};

/**
 * Who made a deal's or task's change, as its event captured it (ADR-277), with the key for `api`;
 * nobody when the change did not record it, and for events captured before it.
 */
export const capturedCrmChanger = (detail: Record<string, unknown>) => {
  const changedBy = CRM_CHANGERS.find((changer) => changer === detail.changedBy) ?? null;
  return { changedBy, apiKeyId: changedBy === 'api' ? str(detail.apiKeyId) : null };
};

/** Who changed an order's status, as its event captured it (ADR-270); null when not recorded. */
const orderChanger = (detail: Record<string, unknown>): OrderStatusChanger | null => {
  const by = detail.changedBy;
  return ORDER_STATUS_CHANGERS.find((changer) => changer === by) ?? null;
};

/** Meta's `interactive.type` of a tap (M-158), as `reply.type` names it. */
const INTERACTIVE_REPLY_TYPES: Record<string, 'button' | 'list'> = {
  button_reply: 'button',
  list_reply: 'list',
};

/** The readable part of an inbound message: its text, the reply tapped, the media type. */
export function inboundSummary(
  type: string,
  content: Record<string, unknown>,
): {
  text: string | null;
  reply: TappedReply;
  mimeType: string | null;
} {
  // Content larger than a message may hold was kept without it (ADR-131): nothing to read.
  if (content.tooLarge === true) return { text: null, reply: null, mimeType: null };
  switch (type) {
    case 'text':
      return { text: str(content.text), reply: null, mimeType: null };
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker':
      return { text: str(content.caption), reply: null, mimeType: str(content.mime_type) };
    case 'button':
      return {
        text: str(content.text),
        reply: {
          id: str(content.payload),
          title: str(content.text),
          type: 'button',
          description: null,
        },
        mimeType: null,
      };
    case 'interactive': {
      const reply = (content.reply ?? null) as Record<string, unknown> | null;
      const kind = INTERACTIVE_REPLY_TYPES[str(content.interactiveType) ?? ''] ?? null;
      return {
        text: reply ? str(reply.title) : null,
        reply: reply
          ? {
              id: str(reply.id),
              title: str(reply.title),
              type: kind,
              description: kind === 'list' ? str(reply.description) || null : null,
            }
          : null,
        mimeType: null,
      };
    }
    case 'reaction':
      return { text: str(content.emoji), reply: null, mimeType: null };
    case 'location':
      return { text: str(content.name) ?? str(content.address), reply: null, mimeType: null };
    default:
      return { text: null, reply: null, mimeType: null };
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.map(record).filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

const ADDRESS_PARTS = ['street', 'city', 'state', 'zip', 'country', 'country_code'] as const;

/**
 * The contacts of a contact card (ADR-196), read from the contact objects WhatsApp sent and HyFib
 * kept (research M-193), in the API's words; null for any other message, and for content removed
 * or too large to keep. Every part is optional: a value of the wrong type is left out, as are a
 * phone, email or link without its value and an address without any part.
 */
export function contactCards(type: string, content: Record<string, unknown>): ContactCard[] | null {
  if (type !== 'contacts' || content.tooLarge === true || !Array.isArray(content.contacts)) {
    return null;
  }
  return records(content.contacts).map((contact) => {
    const name = record(contact.name);
    const org = record(contact.org);
    return {
      name: {
        formattedName: str(name?.formatted_name),
        firstName: str(name?.first_name),
        lastName: str(name?.last_name),
        middleName: str(name?.middle_name),
        prefix: str(name?.prefix),
        suffix: str(name?.suffix),
      },
      phones: records(contact.phones).flatMap((p) =>
        filled(p.phone) ? [{ phone: p.phone, waId: str(p.wa_id), type: str(p.type) }] : [],
      ),
      emails: records(contact.emails).flatMap((e) =>
        filled(e.email) ? [{ email: e.email, type: str(e.type) }] : [],
      ),
      urls: records(contact.urls).flatMap((u) =>
        filled(u.url) ? [{ url: u.url, type: str(u.type) }] : [],
      ),
      addresses: records(contact.addresses)
        .filter((a) => ADDRESS_PARTS.some((part) => filled(a[part])))
        .map((a) => ({
          street: str(a.street),
          city: str(a.city),
          state: str(a.state),
          zip: str(a.zip),
          country: str(a.country),
          countryCode: str(a.country_code),
          type: str(a.type),
        })),
      org:
        org && [org.company, org.department, org.title].some(filled)
          ? { company: str(org.company), department: str(org.department), title: str(org.title) }
          : null,
      birthday: str(contact.birthday),
    };
  });
}

/**
 * What was left out of an inbound message's content (ADR-132): whether WhatsApp sent more than a
 * message may hold, so its content was not kept, and how many contacts a contact card left out
 * (ADR-131).
 */
export function inboundOmissions(
  type: string,
  content: Record<string, unknown>,
): { contentTooLarge: boolean; contactsLeftOut: number } {
  const leftOut = type === 'contacts' ? content.omittedContacts : undefined;
  return {
    contentTooLarge: content.tooLarge === true,
    contactsLeftOut:
      typeof leftOut === 'number' && Number.isSafeInteger(leftOut) && leftOut > 0 ? leftOut : 0,
  };
}

async function contactOf(tx: Tx, tenantId: string, contactId: string | null) {
  if (!contactId) return null;
  const [row] = await tx
    .select({ phone: contacts.phoneE164, name: contacts.displayName, erasedAt: contacts.erasedAt })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)));
  return {
    id: contactId,
    phone: row && !row.erasedAt ? row.phone : null,
    name: row && !row.erasedAt ? row.name : null,
  };
}

async function messageContext(tx: Tx, tenantId: string, messageId: string | null) {
  if (!messageId) return null;
  const [row] = await tx
    .select({
      type: messages.type,
      content: messages.content,
      contextExternalId: messages.contextExternalId,
      conversationId: messages.conversationId,
      senderType: messages.senderType,
      apiKeyId: messages.apiKeyId,
      campaignId: messages.campaignId,
      templateId: messages.templateId,
      channelId: messages.channelAccountId,
      channelPhone: channelAccounts.displayPhoneNumber,
      contactId: conversations.contactId,
    })
    .from(messages)
    .innerJoin(
      conversations,
      and(
        eq(conversations.tenantId, messages.tenantId),
        eq(conversations.id, messages.conversationId),
      ),
    )
    .innerJoin(
      channelAccounts,
      and(
        eq(channelAccounts.tenantId, messages.tenantId),
        eq(channelAccounts.id, messages.channelAccountId),
      ),
    )
    .where(and(eq(messages.tenantId, tenantId), eq(messages.id, messageId)));
  return row ?? null;
}

async function templateOf(tx: Tx, tenantId: string, templateId: string | null) {
  if (!templateId) return null;
  const [row] = await tx
    .select({
      name: messageTemplates.name,
      language: messageTemplates.language,
      category: messageTemplates.category,
    })
    .from(messageTemplates)
    .where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.id, templateId)));
  return row ?? null;
}

async function conversationContext(tx: Tx, tenantId: string, conversationId: string | null) {
  if (!conversationId) return null;
  const [row] = await tx
    .select({
      status: conversations.status,
      assignedMembershipId: conversations.assignedMembershipId,
      teamId: conversations.teamId,
      resolvedAt: conversations.resolvedAt,
      contactId: conversations.contactId,
      channelId: conversations.channelAccountId,
      channelPhone: channelAccounts.displayPhoneNumber,
    })
    .from(conversations)
    .innerJoin(
      channelAccounts,
      and(
        eq(channelAccounts.tenantId, conversations.tenantId),
        eq(channelAccounts.id, conversations.channelAccountId),
      ),
    )
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));
  return row ?? null;
}

/** The contact as the API describes it; an erased contact keeps its id, source and creation time. */
async function webhookContactOf(tx: Tx, tenantId: string, contactId: string | null) {
  if (!contactId) return null;
  const [row] = await tx
    .select(apiContactColumns)
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)));
  if (!row) return null;
  if (!row.erasedAt) return { ...toApiContact(row), erased: false };
  return {
    id: row.id,
    name: null,
    phone: null,
    email: null,
    tags: [],
    fields: {},
    consent: { marketing: null, utility: null },
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    erased: true,
  };
}

/**
 * The contact a merged contact belongs to now (ADR-225): app.contact_merges names it, and a later
 * merge of that contact points its row at the contact kept then.
 */
async function keptContactOf(tx: Tx, tenantId: string, mergedContactId: string | null) {
  if (!mergedContactId || !z.uuid().safeParse(mergedContactId).success) return null;
  const [row] = await tx
    .select({ id: contactMerges.keptContactId })
    .from(contactMerges)
    .where(
      and(eq(contactMerges.tenantId, tenantId), eq(contactMerges.mergedContactId, mergedContactId)),
    );
  return row?.id ?? null;
}

/** A live run with its automation's name and its number, in the company. */
async function runOf(tx: Tx, tenantId: string, runId: string | null) {
  if (!runId || !z.uuid().safeParse(runId).success) return null;
  const [row] = await tx
    .select({
      id: automationRuns.id,
      automationId: automationRuns.automationId,
      automationName: automations.name,
      triggerType: automationRuns.triggerType,
      apiKeyId: automationRuns.apiKeyId,
      enrollmentId: automationRuns.enrollmentId,
      startedAt: automationRuns.startedAt,
      conversationId: automationRuns.conversationId,
      contactId: automationRuns.contactId,
      channelId: automationRuns.channelAccountId,
      channelPhone: channelAccounts.displayPhoneNumber,
    })
    .from(automationRuns)
    .leftJoin(
      automations,
      and(
        eq(automations.tenantId, automationRuns.tenantId),
        eq(automations.id, automationRuns.automationId),
      ),
    )
    .leftJoin(
      channelAccounts,
      and(
        eq(channelAccounts.tenantId, automationRuns.tenantId),
        eq(channelAccounts.id, automationRuns.channelAccountId),
      ),
    )
    .where(and(eq(automationRuns.tenantId, tenantId), eq(automationRuns.id, runId)));
  return row ?? null;
}

/**
 * A run's step as its event gives it (ADR-326), or null once its run is gone. Steps are never
 * changed.
 */
async function runStepOf(tx: Tx, tenantId: string, stepId: string | null) {
  if (!stepId || !z.uuid().safeParse(stepId).success) return null;
  const [row] = await tx
    .select({
      runId: automationRunSteps.runId,
      seq: automationRunSteps.seq,
      nodeType: automationRunSteps.nodeType,
      outcome: automationRunSteps.outcome,
      messageId: automationRunSteps.messageId,
    })
    .from(automationRunSteps)
    .where(and(eq(automationRunSteps.tenantId, tenantId), eq(automationRunSteps.id, stepId)));
  return row ?? null;
}

/** A deal with what its events give as it is now (ADR-256), or null once it is gone. */
async function dealOf(tx: Tx, tenantId: string, dealId: string | null) {
  if (!dealId || !z.uuid().safeParse(dealId).success) return null;
  const [row] = await tx
    .select({
      id: crmDeals.id,
      title: crmDeals.title,
      contactId: crmDeals.contactId,
      conversationId: crmDeals.conversationId,
      pipelineId: crmDeals.pipelineId,
      stageId: crmDeals.stageId,
      status: crmDeals.status,
      valueMinor: crmDeals.valueMinor,
      currency: crmPipelines.currency,
      ownerId: crmDeals.ownerMembershipId,
      expectedCloseOn: crmDeals.expectedCloseOn,
      lostReason: crmDeals.lostReason,
      automationId: crmDeals.createdByAutomationId,
      apiKeyId: crmDeals.createdByApiKeyId,
      createdAt: crmDeals.createdAt,
    })
    .from(crmDeals)
    .innerJoin(
      crmPipelines,
      and(eq(crmPipelines.tenantId, crmDeals.tenantId), eq(crmPipelines.id, crmDeals.pipelineId)),
    )
    .where(and(eq(crmDeals.tenantId, tenantId), eq(crmDeals.id, dealId)));
  return row ?? null;
}

/** A task with what its events give as it is now (ADR-261), or null once it is gone. */
async function taskOf(tx: Tx, tenantId: string, taskId: string | null) {
  if (!taskId || !z.uuid().safeParse(taskId).success) return null;
  const [row] = await tx
    .select({
      id: crmTasks.id,
      title: crmTasks.title,
      status: crmTasks.status,
      dueAt: crmTasks.dueAt,
      assigneeId: crmTasks.assigneeMembershipId,
      contactId: crmTasks.contactId,
      dealId: crmTasks.dealId,
      automationId: crmTasks.createdByAutomationId,
      apiKeyId: crmTasks.createdByApiKeyId,
      createdAt: crmTasks.createdAt,
    })
    .from(crmTasks)
    .where(and(eq(crmTasks.tenantId, tenantId), eq(crmTasks.id, taskId)));
  return row ?? null;
}

/**
 * A CRM note with what its event gives (ADR-280), never its text, or null once it is gone (erasure
 * deletes an erased contact's notes). Any other timeline entry is not a note.
 */
async function noteOf(tx: Tx, tenantId: string, noteId: string | null) {
  if (!noteId || !z.uuid().safeParse(noteId).success) return null;
  const [row] = await tx
    .select({
      id: crmActivities.id,
      contactId: crmActivities.contactId,
      dealId: crmActivities.dealId,
      // Whether a member wrote it, never which: keys' notes have no member and name the key.
      byMember: sql<boolean>`(${crmActivities.actorMembershipId} IS NOT NULL)`,
      apiKeyId: sql<string | null>`(${crmActivities.data} ->> 'apiKeyId')`,
      createdAt: crmActivities.createdAt,
    })
    .from(crmActivities)
    .where(
      and(
        eq(crmActivities.tenantId, tenantId),
        eq(crmActivities.id, noteId),
        eq(crmActivities.kind, 'note'),
      ),
    );
  return row ?? null;
}

/**
 * A satisfaction survey with its conversation's contact and number, in the company, read as the API
 * reads it (ADR-292, ADR-293); null if there is none.
 */
async function satisfactionSurveyOf(tx: Tx, tenantId: string, surveyId: string | null) {
  if (!surveyId || !z.uuid().safeParse(surveyId).success) return null;
  const [row] = await tx
    .select({
      ...satisfactionSurveyColumns,
      contactId: conversations.contactId,
      channelId: conversations.channelAccountId,
      channelPhone: channelAccounts.displayPhoneNumber,
    })
    .from(csatSurveys)
    .innerJoin(
      conversations,
      and(
        eq(conversations.tenantId, csatSurveys.tenantId),
        eq(conversations.id, csatSurveys.conversationId),
      ),
    )
    .leftJoin(
      messages,
      and(eq(messages.tenantId, csatSurveys.tenantId), eq(messages.id, csatSurveys.messageId)),
    )
    .leftJoin(
      channelAccounts,
      and(
        eq(channelAccounts.tenantId, conversations.tenantId),
        eq(channelAccounts.id, conversations.channelAccountId),
      ),
    )
    .where(and(eq(csatSurveys.tenantId, tenantId), eq(csatSurveys.id, surveyId)));
  return row ?? null;
}

/**
 * A Payment Link with its order's reference, status, conversation, contact and number, in the
 * company, read as the API reads it (ADR-284, ADR-285); null if there is none.
 */
async function paymentLinkOf(tx: Tx, tenantId: string, linkId: string | null) {
  if (!linkId || !z.uuid().safeParse(linkId).success) return null;
  const [row] = await tx
    .select({
      ...paymentLinkColumns,
      orderReference: commerceOrders.reference,
      orderStatus: commerceOrders.status,
      conversationId: commerceOrders.conversationId,
      contactId: commerceOrders.contactId,
      channelId: commerceOrders.channelAccountId,
      channelPhone: channelAccounts.displayPhoneNumber,
    })
    .from(commercePaymentLinks)
    .innerJoin(
      commerceOrders,
      and(
        eq(commerceOrders.tenantId, commercePaymentLinks.tenantId),
        eq(commerceOrders.id, commercePaymentLinks.orderId),
      ),
    )
    .leftJoin(
      channelAccounts,
      and(
        eq(channelAccounts.tenantId, commerceOrders.tenantId),
        eq(channelAccounts.id, commerceOrders.channelAccountId),
      ),
    )
    .where(and(eq(commercePaymentLinks.tenantId, tenantId), eq(commercePaymentLinks.id, linkId)));
  return row ?? null;
}

/** A store's order as the store order events give it (ADR-348, ADR-351). */
const storeOrderColumns = {
  id: commerceStoreOrders.id,
  externalId: commerceStoreOrders.externalId,
  name: commerceStoreOrders.name,
  status: commerceStoreOrders.status,
  financialStatus: commerceStoreOrders.financialStatus,
  fulfillmentStatus: commerceStoreOrders.fulfillmentStatus,
  test: commerceStoreOrders.test,
  currency: commerceStoreOrders.currency,
  totalMinor: commerceStoreOrders.totalMinor,
  placedAt: commerceStoreOrders.placedAt,
  cancelledAt: commerceStoreOrders.cancelledAt,
  deletedAt: commerceStoreOrders.deletedAt,
};
/** A store's checkout as the cart reminder events give it (ADR-355): no customer details. */
const storeCheckoutColumns = {
  id: commerceStoreCheckouts.id,
  externalId: commerceStoreCheckouts.externalId,
  name: commerceStoreCheckouts.name,
  currency: commerceStoreCheckouts.currency,
  totalMinor: commerceStoreCheckouts.totalMinor,
  itemCount: commerceStoreCheckouts.itemCount,
  startedAt: commerceStoreCheckouts.remoteCreatedAt,
  completedAt: commerceStoreCheckouts.completedAt,
};
/** A store's checkout as read with `storeCheckoutColumns`, its times written out. */
const toWebhookStoreCheckout = <T extends { startedAt: Date; completedAt: Date | null }>(
  checkout: T,
) => ({
  ...checkout,
  startedAt: checkout.startedAt.toISOString(),
  completedAt: checkout.completedAt?.toISOString() ?? null,
});
/** A store as the store order events give it. */
const storeColumns = {
  id: commerceStores.id,
  platform: commerceStores.platform,
  name: commerceStores.name,
  url: commerceStores.storeUrl,
};
/** A store's order as read with `storeOrderColumns`, its times written out. */
const toWebhookStoreOrder = <
  T extends { placedAt: Date; cancelledAt: Date | null; deletedAt: Date | null },
>(
  order: T,
) => ({
  ...order,
  placedAt: order.placedAt.toISOString(),
  cancelledAt: order.cancelledAt?.toISOString() ?? null,
  deletedAt: order.deletedAt?.toISOString() ?? null,
});

/**
 * A store order's cash on delivery confirmation (ADR-348) with the order, its store and the
 * confirmation's conversation, contact and number, in the company; null if there is none.
 */
async function storeConfirmationOf(tx: Tx, tenantId: string, storeMessageId: string | null) {
  if (!storeMessageId || !z.uuid().safeParse(storeMessageId).success) return null;
  const [row] = await tx
    .select({
      messageId: messages.id,
      order: storeOrderColumns,
      store: storeColumns,
      conversationId: messages.conversationId,
      contactId: conversations.contactId,
      channelId: messages.channelAccountId,
      channelPhone: channelAccounts.displayPhoneNumber,
    })
    .from(commerceStoreMessages)
    .innerJoin(
      commerceStoreOrders,
      and(
        eq(commerceStoreOrders.tenantId, commerceStoreMessages.tenantId),
        eq(commerceStoreOrders.id, commerceStoreMessages.orderId),
      ),
    )
    .innerJoin(
      commerceStores,
      and(
        eq(commerceStores.tenantId, commerceStoreMessages.tenantId),
        eq(commerceStores.id, commerceStoreMessages.storeId),
      ),
    )
    .innerJoin(
      messages,
      and(
        eq(messages.tenantId, commerceStoreMessages.tenantId),
        eq(messages.id, commerceStoreMessages.messageId),
      ),
    )
    .innerJoin(
      conversations,
      and(
        eq(conversations.tenantId, messages.tenantId),
        eq(conversations.id, messages.conversationId),
      ),
    )
    .leftJoin(
      channelAccounts,
      and(
        eq(channelAccounts.tenantId, messages.tenantId),
        eq(channelAccounts.id, messages.channelAccountId),
      ),
    )
    .where(
      and(
        eq(commerceStoreMessages.tenantId, tenantId),
        eq(commerceStoreMessages.id, storeMessageId),
        eq(commerceStoreMessages.event, 'cod_confirmation'),
      ),
    );
  return row ?? null;
}

/**
 * A store's order message (ADR-351) with its order and the store, in the company; null if there is
 * none (a cart reminder has a checkout, not an order).
 */
async function storeOrderMessageOf(tx: Tx, tenantId: string, storeMessageId: string | null) {
  if (!storeMessageId || !z.uuid().safeParse(storeMessageId).success) return null;
  const [row] = await tx
    .select({ order: storeOrderColumns, store: storeColumns })
    .from(commerceStoreMessages)
    .innerJoin(
      commerceStoreOrders,
      and(
        eq(commerceStoreOrders.tenantId, commerceStoreMessages.tenantId),
        eq(commerceStoreOrders.id, commerceStoreMessages.orderId),
      ),
    )
    .innerJoin(
      commerceStores,
      and(
        eq(commerceStores.tenantId, commerceStoreMessages.tenantId),
        eq(commerceStores.id, commerceStoreMessages.storeId),
      ),
    )
    .where(
      and(
        eq(commerceStoreMessages.tenantId, tenantId),
        eq(commerceStoreMessages.id, storeMessageId),
      ),
    );
  return row ?? null;
}

/**
 * A store's cart reminder (ADR-355) with its checkout and the store, in the company; null if there
 * is none (an order message has an order, not a checkout).
 */
async function storeCartReminderOf(tx: Tx, tenantId: string, storeMessageId: string | null) {
  if (!storeMessageId || !z.uuid().safeParse(storeMessageId).success) return null;
  const [row] = await tx
    .select({ checkout: storeCheckoutColumns, store: storeColumns })
    .from(commerceStoreMessages)
    .innerJoin(
      commerceStoreCheckouts,
      and(
        eq(commerceStoreCheckouts.tenantId, commerceStoreMessages.tenantId),
        eq(commerceStoreCheckouts.id, commerceStoreMessages.checkoutId),
      ),
    )
    .innerJoin(
      commerceStores,
      and(
        eq(commerceStores.tenantId, commerceStoreMessages.tenantId),
        eq(commerceStores.id, commerceStoreMessages.storeId),
      ),
    )
    .where(
      and(
        eq(commerceStoreMessages.tenantId, tenantId),
        eq(commerceStoreMessages.id, storeMessageId),
      ),
    );
  return row ?? null;
}

/**
 * A store's sent cart reminder (ADR-355) with its checkout, the store, and the conversation it went
 * out in with that conversation's contact and number, in the company; null if there is none.
 */
async function sentStoreCartReminderOf(
  tx: Tx,
  tenantId: string,
  storeMessageId: string | null,
  conversationId: string,
) {
  if (!storeMessageId || !z.uuid().safeParse(storeMessageId).success) return null;
  const [row] = await tx
    .select({
      checkout: storeCheckoutColumns,
      store: storeColumns,
      contactId: conversations.contactId,
      channelId: conversations.channelAccountId,
      channelPhone: channelAccounts.displayPhoneNumber,
    })
    .from(commerceStoreMessages)
    .innerJoin(
      commerceStoreCheckouts,
      and(
        eq(commerceStoreCheckouts.tenantId, commerceStoreMessages.tenantId),
        eq(commerceStoreCheckouts.id, commerceStoreMessages.checkoutId),
      ),
    )
    .innerJoin(
      commerceStores,
      and(
        eq(commerceStores.tenantId, commerceStoreMessages.tenantId),
        eq(commerceStores.id, commerceStoreMessages.storeId),
      ),
    )
    .innerJoin(
      conversations,
      and(
        eq(conversations.tenantId, commerceStoreMessages.tenantId),
        eq(conversations.id, conversationId),
      ),
    )
    .leftJoin(
      channelAccounts,
      and(
        eq(channelAccounts.tenantId, conversations.tenantId),
        eq(channelAccounts.id, conversations.channelAccountId),
      ),
    )
    .where(
      and(
        eq(commerceStoreMessages.tenantId, tenantId),
        eq(commerceStoreMessages.id, storeMessageId),
      ),
    );
  return row ?? null;
}

/**
 * A store's sent order message (ADR-353) with its order, the store, and the conversation it went
 * out in with that conversation's contact and number, in the company; null if there is none.
 */
async function sentStoreOrderMessageOf(
  tx: Tx,
  tenantId: string,
  storeMessageId: string | null,
  conversationId: string,
) {
  if (!storeMessageId || !z.uuid().safeParse(storeMessageId).success) return null;
  const [row] = await tx
    .select({
      order: storeOrderColumns,
      store: storeColumns,
      contactId: conversations.contactId,
      channelId: conversations.channelAccountId,
      channelPhone: channelAccounts.displayPhoneNumber,
    })
    .from(commerceStoreMessages)
    .innerJoin(
      commerceStoreOrders,
      and(
        eq(commerceStoreOrders.tenantId, commerceStoreMessages.tenantId),
        eq(commerceStoreOrders.id, commerceStoreMessages.orderId),
      ),
    )
    .innerJoin(
      commerceStores,
      and(
        eq(commerceStores.tenantId, commerceStoreMessages.tenantId),
        eq(commerceStores.id, commerceStoreMessages.storeId),
      ),
    )
    .innerJoin(
      conversations,
      and(
        eq(conversations.tenantId, commerceStoreMessages.tenantId),
        eq(conversations.id, conversationId),
      ),
    )
    .leftJoin(
      channelAccounts,
      and(
        eq(channelAccounts.tenantId, conversations.tenantId),
        eq(channelAccounts.id, conversations.channelAccountId),
      ),
    )
    .where(
      and(
        eq(commerceStoreMessages.tenantId, tenantId),
        eq(commerceStoreMessages.id, storeMessageId),
      ),
    );
  return row ?? null;
}

/** A WhatsApp order with its items in cart order and its number, in the company. */
async function orderOf(tx: Tx, tenantId: string, orderId: string | null) {
  if (!orderId || !z.uuid().safeParse(orderId).success) return null;
  const [row] = await tx
    .select({
      id: commerceOrders.id,
      reference: commerceOrders.reference,
      messageId: commerceOrders.messageId,
      conversationId: commerceOrders.conversationId,
      contactId: commerceOrders.contactId,
      catalogId: commerceOrders.metaCatalogId,
      currency: commerceOrders.currency,
      subtotalMinor: commerceOrders.subtotalMinor,
      itemCount: commerceOrders.itemCount,
      droppedItems: commerceOrders.droppedItems,
      customerNote: commerceOrders.customerNote,
      receivedAt: commerceOrders.receivedAt,
      paidAt: commerceOrders.paidAt,
      channelId: commerceOrders.channelAccountId,
      channelPhone: channelAccounts.displayPhoneNumber,
    })
    .from(commerceOrders)
    .leftJoin(
      channelAccounts,
      and(
        eq(channelAccounts.tenantId, commerceOrders.tenantId),
        eq(channelAccounts.id, commerceOrders.channelAccountId),
      ),
    )
    .where(and(eq(commerceOrders.tenantId, tenantId), eq(commerceOrders.id, orderId)));
  if (!row) return null;
  const items = await tx
    .select({
      retailerId: commerceOrderItems.retailerId,
      name: commerceOrderItems.name,
      quantity: commerceOrderItems.quantity,
      unitPriceMinor: commerceOrderItems.unitPriceMinor,
      currency: commerceOrderItems.currency,
    })
    .from(commerceOrderItems)
    .where(and(eq(commerceOrderItems.tenantId, tenantId), eq(commerceOrderItems.orderId, orderId)))
    .orderBy(asc(commerceOrderItems.position));
  return { ...row, items };
}

/** A campaign with its template's name and its number, in the company. */
async function campaignOf(tx: Tx, tenantId: string, campaignId: string | null) {
  if (!campaignId || !z.uuid().safeParse(campaignId).success) return null;
  const [row] = await tx
    .select({
      id: campaigns.id,
      name: campaigns.name,
      status: campaigns.status,
      templateId: campaigns.templateId,
      templateName: messageTemplates.name,
      scheduledAt: campaigns.scheduledAt,
      startedAt: campaigns.startedAt,
      completedAt: campaigns.completedAt,
      canceledAt: campaigns.canceledAt,
      audienceCount: campaigns.audienceCount,
      queuedCount: campaigns.queuedCount,
      skippedCount: campaigns.skippedCount,
      channelId: campaigns.channelAccountId,
      channelPhone: channelAccounts.displayPhoneNumber,
    })
    .from(campaigns)
    .leftJoin(
      messageTemplates,
      and(
        eq(messageTemplates.tenantId, campaigns.tenantId),
        eq(messageTemplates.id, campaigns.templateId),
      ),
    )
    .leftJoin(
      channelAccounts,
      and(
        eq(channelAccounts.tenantId, campaigns.tenantId),
        eq(channelAccounts.id, campaigns.channelAccountId),
      ),
    )
    .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, campaignId)));
  return row ?? null;
}

/**
 * A campaign's recipient, in the company (ADR-358): kept with its campaign until the company is
 * deleted, unless a contact merge removed it (both contacts were in the campaign's audience).
 */
async function campaignRecipientOf(tx: Tx, tenantId: string, recipientId: string | null) {
  if (!recipientId || !z.uuid().safeParse(recipientId).success) return null;
  const [row] = await tx
    .select({
      id: campaignRecipients.id,
      campaignId: campaignRecipients.campaignId,
      contactId: campaignRecipients.contactId,
      variant: campaignRecipients.variant,
    })
    .from(campaignRecipients)
    .where(and(eq(campaignRecipients.tenantId, tenantId), eq(campaignRecipients.id, recipientId)));
  return row ?? null;
}

const isCampaignSkipReason = (reason: string): reason is (typeof SKIP_REASONS)[number] =>
  (SKIP_REASONS as readonly string[]).includes(reason);

const sentBy = (senderType: string | undefined) =>
  senderType === 'agent' ||
  senderType === 'bot' ||
  senderType === 'campaign' ||
  senderType === 'api'
    ? senderType
    : 'system';

/**
 * The body delivered for an event, built from the company's data now. Throws when the message,
 * conversation, contact, run or order an event names no longer exists (it cannot be described);
 * callers fail the delivery.
 */
export async function buildWebhookPayload(
  tx: Tx,
  event: StoredWebhookEvent,
  endpointId: string,
): Promise<WebhookPayload> {
  // The time to the microsecond, and createdAt as the same moment cut to the millisecond (ADR-330).
  // A time with no such form cannot be described, as a date with no ISO form could not before.
  const exact = event.occurredAtExact;
  if (exact === null || !WEBHOOK_EXACT_TIME_RE.test(exact)) {
    throw new RangeError('The event has no time to the microsecond.');
  }
  const base = {
    id: event.id,
    type: event.type,
    createdAt: toWebhookMillisecond(exact),
    createdAtExact: exact,
  };
  const tenantId = event.tenantId;
  switch (event.type) {
    case 'ping':
      return {
        ...base,
        data: { endpointId, message: 'A test event from HyFib W360. Your endpoint received it.' },
      };
    case 'consent.changed':
      return {
        ...base,
        data: {
          contact: await contactOf(tx, tenantId, event.contactId),
          purpose: event.detail.purpose,
          action: event.detail.action,
          source: event.detail.source,
        },
      };
    case 'template.status_changed': {
      const template = await templateOf(tx, tenantId, event.templateId);
      return {
        ...base,
        data: {
          template: {
            id: event.templateId,
            name: template?.name ?? null,
            language: template?.language ?? null,
            category: template ? template.category.toLowerCase() : null,
            status: event.status,
            reason: str(event.detail.reason),
          },
        },
      };
    }
    case 'conversation.status_changed':
    case 'conversation.assignment_changed':
    case 'conversation.team_changed': {
      const conversation = await conversationContext(tx, tenantId, event.conversationId);
      if (!conversation) throw new WebhookEventGoneError();
      const contact = await contactOf(tx, tenantId, conversation.contactId);
      const channel = { id: conversation.channelId, phone: conversation.channelPhone };
      if (event.type === 'conversation.status_changed') {
        return {
          ...base,
          data: {
            conversation: {
              id: event.conversationId,
              status: event.status,
              previousStatus: str(event.detail.previousStatus),
              assigned: conversation.assignedMembershipId !== null,
              assigneeId: conversation.assignedMembershipId,
              teamId: conversation.teamId,
              resolvedAt: conversation.resolvedAt?.toISOString() ?? null,
            },
            contact,
            channel,
          },
        };
      }
      // The change as captured (ADR-094); the rest as the conversation is now.
      if (event.type === 'conversation.team_changed') {
        return {
          ...base,
          data: {
            conversation: {
              id: event.conversationId,
              status: conversation.status,
              teamId: str(event.detail.teamId),
              previousTeamId: str(event.detail.previousTeamId),
              assigneeId: conversation.assignedMembershipId,
            },
            contact,
            channel,
          },
        };
      }
      return {
        ...base,
        data: {
          conversation: {
            id: event.conversationId,
            status: conversation.status,
            assigned: event.detail.assigned === true,
            assigneeId: str(event.detail.assigneeId),
            previousAssigneeId: str(event.detail.previousAssigneeId),
            teamId: conversation.teamId,
          },
          contact,
          channel,
        },
      };
    }
    case 'contact.created':
    case 'contact.updated':
    case 'contact.erased': {
      const contact = await webhookContactOf(tx, tenantId, event.contactId);
      if (!contact) throw new WebhookEventGoneError();
      // What changed and the tags as captured (ADR-121, ADR-182), none of an erased contact; the
      // contact as it is now.
      return event.type === 'contact.updated'
        ? {
            ...base,
            data: {
              contact,
              changes: event.contactChanges,
              tagsAdded: contact.erased ? null : event.tagsAdded,
              tagsRemoved: contact.erased ? null : event.tagsRemoved,
            },
          }
        : { ...base, data: { contact } };
    }
    case 'contact.merged': {
      // The merged contact as captured; the contact it belongs to as it is now.
      const mergedContactId = str(event.detail.mergedContactId);
      const keptId = await keptContactOf(tx, tenantId, mergedContactId);
      const contact = await webhookContactOf(tx, tenantId, keptId);
      if (!contact || !mergedContactId) throw new WebhookEventGoneError();
      return { ...base, data: { contact, mergedContactId } };
    }
    case 'automation.run_started':
    case 'automation.run_ended': {
      // The status, end reason and end as captured; the rest as it is now.
      const run = await runOf(tx, tenantId, str(event.detail.runId));
      if (!run) throw new WebhookEventGoneError();
      const ended = event.type === 'automation.run_ended';
      // The campaign a reply to a campaign answers (ADR-414), read only for such runs.
      const campaign =
        run.triggerType === 'campaign_reply' ? await runCampaignOf(tx, tenantId, run.id) : null;
      if (run.triggerType === 'campaign_reply' && !campaign) {
        throw new Error('A run started by a reply to a campaign has no campaign recorded');
      }
      return {
        ...base,
        data: {
          run: {
            id: run.id,
            automationId: run.automationId,
            automationName: run.automationName ?? null,
            trigger: run.triggerType,
            apiKeyId: run.apiKeyId,
            enrollmentId: run.enrollmentId ?? null,
            campaign: campaign
              ? {
                  id: campaign.campaignId,
                  name: campaign.name,
                  variant: parseVariantLabel(campaign.variant ?? ''),
                }
              : null,
            status: event.status,
            endReason: ended ? str(event.detail.endReason) : null,
            startedAt: run.startedAt.toISOString(),
            endedAt: ended ? event.occurredAt.toISOString() : null,
          },
          conversation: { id: run.conversationId },
          contact: await contactOf(tx, tenantId, run.contactId),
          channel: { id: run.channelId, phone: run.channelPhone ?? null },
        },
      };
    }
    case 'automation.run_step': {
      // The step as its run's log recorded it, never its detail or branch; the run as it is now.
      const step = await runStepOf(tx, tenantId, str(event.detail.stepId));
      const run = step ? await runOf(tx, tenantId, step.runId) : null;
      if (!step || !run) throw new WebhookEventGoneError();
      return {
        ...base,
        data: {
          run: {
            id: run.id,
            automationId: run.automationId,
            automationName: run.automationName ?? null,
            trigger: run.triggerType,
            apiKeyId: run.apiKeyId,
            enrollmentId: run.enrollmentId ?? null,
            startedAt: run.startedAt.toISOString(),
          },
          step: {
            number: step.seq,
            nodeType: step.nodeType,
            outcome: step.outcome,
            messageId: step.messageId,
          },
          conversation: { id: run.conversationId },
          contact: await contactOf(tx, tenantId, run.contactId),
          channel: { id: run.channelId, phone: run.channelPhone ?? null },
        },
      };
    }
    case 'order.received':
    case 'order.status_changed': {
      // The status and the one before it as captured; the rest as it is now (an erased
      // contact's note is gone).
      const order = await orderOf(tx, tenantId, str(event.detail.orderId));
      if (!order) throw new WebhookEventGoneError();
      return {
        ...base,
        data: {
          order: {
            id: order.id,
            reference: order.reference,
            status: event.status,
            previousStatus:
              event.type === 'order.status_changed' ? str(event.detail.previousStatus) : null,
            // Who made the change, as captured (ADR-270); absent from earlier events.
            changedBy: event.type === 'order.status_changed' ? orderChanger(event.detail) : null,
            apiKeyId:
              event.type === 'order.status_changed' && orderChanger(event.detail) === 'api'
                ? str(event.detail.apiKeyId)
                : null,
            messageId: order.messageId,
            catalogId: order.catalogId,
            currency: order.currency,
            subtotalMinor: order.subtotalMinor,
            itemCount: order.itemCount,
            droppedItems: order.droppedItems,
            customerNote: order.customerNote,
            items: order.items,
            receivedAt: order.receivedAt.toISOString(),
            paidAt: order.paidAt?.toISOString() ?? null,
          },
          conversation: { id: order.conversationId },
          contact: await contactOf(tx, tenantId, order.contactId),
          channel: { id: order.channelId, phone: order.channelPhone ?? null },
        },
      };
    }
    case 'payment_link.status_changed': {
      // The status and the one before it as captured; the rest as the link and its order are now.
      // Links are kept until the company is deleted, so a link that is gone was never one of the
      // company's.
      const link = await paymentLinkOf(tx, tenantId, str(event.detail.paymentLinkId));
      if (!link) throw new WebhookEventGoneError();
      return {
        ...base,
        data: {
          paymentLink: {
            ...toApiPaymentLink(link),
            status: event.status ?? link.status,
            previousStatus: str(event.detail.previousStatus),
          },
          order: { id: link.orderId, reference: link.orderReference, status: link.orderStatus },
          conversation: { id: link.conversationId },
          contact: await contactOf(tx, tenantId, link.contactId),
          channel: { id: link.channelId, phone: link.channelPhone ?? null },
        },
      };
    }
    case 'store_order.cod_answered': {
      // The answer, the one before it and the tap as captured, so a later answer changes nothing
      // here; the order and its store as they are now. A confirmation goes with its order or its
      // store (removing a store deletes its copy), so one that is gone can no longer be described.
      const answeredAt = str(event.detail.answeredAt);
      const answerMessageId = str(event.detail.answerMessageId);
      // Every such event is captured with its tap (0266): one without cannot be described.
      if (answeredAt === null || answerMessageId === null) {
        throw new Error('The cash on delivery answer was captured without its tap');
      }
      const confirmation = await storeConfirmationOf(
        tx,
        tenantId,
        str(event.detail.storeMessageId),
      );
      if (!confirmation) throw new WebhookEventGoneError();
      const { order, store } = confirmation;
      return {
        ...base,
        data: {
          confirmation: {
            answer: event.status,
            previousAnswer: str(event.detail.previousAnswer),
            answeredAt: new Date(answeredAt).toISOString(),
            messageId: confirmation.messageId,
            answerMessageId,
          },
          storeOrder: toWebhookStoreOrder(order),
          store,
          conversation: { id: confirmation.conversationId },
          contact: await contactOf(tx, tenantId, confirmation.contactId),
          channel: { id: confirmation.channelId, phone: confirmation.channelPhone ?? null },
        },
      };
    }
    case 'store_order.message_skipped': {
      // The event, the reason and when the order's event happened as captured (a skipped message
      // keeps them); the order and its store as they are now. A message goes with its order or its
      // store (removing a store deletes its copy), so one that is gone can no longer be described.
      const skipReason = str(event.detail.skipReason);
      const occurredAt = str(event.detail.occurredAt);
      // Every such event is captured with them (0270): one without cannot be described.
      if (event.status === null || skipReason === null || occurredAt === null) {
        throw new Error('The skipped order message was captured without its event, reason or time');
      }
      const skipped = await storeOrderMessageOf(tx, tenantId, str(event.detail.storeMessageId));
      if (!skipped) throw new WebhookEventGoneError();
      return {
        ...base,
        data: {
          orderMessage: {
            event: event.status,
            skipReason,
            occurredAt: new Date(occurredAt).toISOString(),
          },
          storeOrder: toWebhookStoreOrder(skipped.order),
          store: skipped.store,
        },
      };
    }
    case 'store_order.message_sent': {
      // The event, when the order's event happened, the message or the run and the conversation as
      // captured; the order, its store, the conversation's contact and its number as they are now.
      // A message goes with its order or its store, so one that is gone can no longer be described.
      const occurredAt = str(event.detail.occurredAt);
      const automationRunId = str(event.detail.automationRunId);
      // Every such event is captured with them, and with a message or a run (0273): one without
      // cannot be described.
      if (
        event.status === null ||
        occurredAt === null ||
        event.conversationId === null ||
        (event.messageId === null) === (automationRunId === null)
      ) {
        throw new Error(
          'The sent order message was captured without its event, time, conversation, message or run',
        );
      }
      const sent = await sentStoreOrderMessageOf(
        tx,
        tenantId,
        str(event.detail.storeMessageId),
        event.conversationId,
      );
      if (!sent) throw new WebhookEventGoneError();
      return {
        ...base,
        data: {
          orderMessage: {
            event: event.status,
            occurredAt: new Date(occurredAt).toISOString(),
            messageId: event.messageId,
            automationRunId,
          },
          storeOrder: toWebhookStoreOrder(sent.order),
          store: sent.store,
          conversation: { id: event.conversationId },
          contact: await contactOf(tx, tenantId, sent.contactId),
          channel: { id: sent.channelId, phone: sent.channelPhone ?? null },
        },
      };
    }
    case 'store_checkout.reminder_skipped': {
      // The reminder, the reason and when the checkout was left as captured (a skipped reminder
      // keeps them); the checkout and its store as they are now. A reminder goes with its checkout
      // (deleted 30 days after its last update in the store) or its store, so one that is gone can
      // no longer be described.
      const skipReason = str(event.detail.skipReason);
      const occurredAt = str(event.detail.occurredAt);
      // Every such event is captured with them (0276): one without cannot be described.
      if (event.status === null || skipReason === null || occurredAt === null) {
        throw new Error(
          'The skipped cart reminder was captured without its reminder, reason or time',
        );
      }
      const skipped = await storeCartReminderOf(tx, tenantId, str(event.detail.storeMessageId));
      if (!skipped) throw new WebhookEventGoneError();
      return {
        ...base,
        data: {
          reminder: {
            event: event.status,
            skipReason,
            occurredAt: new Date(occurredAt).toISOString(),
          },
          storeCheckout: toWebhookStoreCheckout(skipped.checkout),
          store: skipped.store,
        },
      };
    }
    case 'store_checkout.reminder_sent': {
      // The reminder, when the checkout was left, the message and the conversation as captured;
      // the checkout, its store, the conversation's contact and its number as they are now. A
      // reminder goes with its checkout or its store, so one that is gone can no longer be described.
      const occurredAt = str(event.detail.occurredAt);
      // Every such event is captured with them (0276): one without cannot be described.
      if (
        event.status === null ||
        occurredAt === null ||
        event.messageId === null ||
        event.conversationId === null
      ) {
        throw new Error(
          'The sent cart reminder was captured without its reminder, time, message or conversation',
        );
      }
      const sent = await sentStoreCartReminderOf(
        tx,
        tenantId,
        str(event.detail.storeMessageId),
        event.conversationId,
      );
      if (!sent) throw new WebhookEventGoneError();
      return {
        ...base,
        data: {
          reminder: {
            event: event.status,
            occurredAt: new Date(occurredAt).toISOString(),
            messageId: event.messageId,
          },
          storeCheckout: toWebhookStoreCheckout(sent.checkout),
          store: sent.store,
          conversation: { id: event.conversationId },
          contact: await contactOf(tx, tenantId, sent.contactId),
          channel: { id: sent.channelId, phone: sent.channelPhone ?? null },
        },
      };
    }
    case 'satisfaction_survey.answered': {
      // The survey as it is now, its answer recorded once: surveys are kept with their conversation
      // until the company is deleted, so a survey that is gone was never one of the company's. An
      // erased contact's survey is sent as erasure left the contact.
      const survey = await satisfactionSurveyOf(tx, tenantId, str(event.detail.surveyId));
      if (!survey) throw new WebhookEventGoneError();
      return {
        ...base,
        data: {
          survey: toApiSatisfactionSurvey(survey),
          conversation: { id: survey.conversationId },
          contact: await contactOf(tx, tenantId, survey.contactId),
          channel: { id: survey.channelId, phone: survey.channelPhone ?? null },
        },
      };
    }
    case 'deal.created':
    case 'deal.updated':
    case 'deal.stage_changed':
    case 'deal.owner_changed':
    case 'deal.status_changed': {
      // The stage, pipeline and status, and those before them, as captured, for a change of owner
      // the owners, and who made the change (an addition's maker is the deal's creator); the rest
      // as it is now, so an erased contact's deal is sent as erasure left it.
      const deal = await dealOf(tx, tenantId, str(event.detail.dealId));
      if (!deal) throw new WebhookEventGoneError();
      // Its products as the API reads them, at delivery (ADR-395): a read of its own after the
      // deal's, at read committed, so not one snapshot with it.
      const items = await readApiDealItems(tx, tenantId, deal.id);
      const moved = event.type === 'deal.stage_changed';
      const owned = event.type === 'deal.owner_changed';
      const { createdBy, createdByApiKeyId } = crmCreatedBy(deal.automationId, deal.apiKeyId);
      const changer =
        event.type === 'deal.created'
          ? { changedBy: createdBy, apiKeyId: createdByApiKeyId }
          : capturedCrmChanger(event.detail);
      return {
        ...base,
        data: {
          deal: {
            id: deal.id,
            title: deal.title,
            pipelineId: str(event.detail.pipelineId) ?? deal.pipelineId,
            stageId: str(event.detail.stageId) ?? deal.stageId,
            status: event.status ?? deal.status,
            previousStageId: moved ? str(event.detail.previousStageId) : null,
            previousPipelineId: moved ? str(event.detail.previousPipelineId) : null,
            previousStatus:
              event.type === 'deal.status_changed' ? str(event.detail.previousStatus) : null,
            previousOwnerId: owned ? str(event.detail.previousOwnerId) : null,
            valueMinor: deal.valueMinor,
            currency: deal.currency,
            ownerId: owned ? str(event.detail.ownerId) : deal.ownerId,
            expectedCloseOn: deal.expectedCloseOn,
            lostReason: deal.lostReason,
            createdBy,
            createdAt: deal.createdAt.toISOString(),
            items,
            ...changer,
          },
          conversation: deal.conversationId ? { id: deal.conversationId } : null,
          contact: await contactOf(tx, tenantId, deal.contactId),
          ...(event.type === 'deal.updated' ? dealUpdatedChanges(event.detail) : {}),
        },
      };
    }
    case 'task.created':
    case 'task.updated':
    case 'task.assignee_changed':
    case 'task.status_changed': {
      // The status, and the one before it, as captured, for a change of assignee the assignees, for
      // a change of details the names of what changed, and who made the change (an addition's
      // maker is the task's creator); the rest as it is now. Erasing a contact deletes its tasks,
      // so an erased contact's task is gone and its events send nothing.
      const task = await taskOf(tx, tenantId, str(event.detail.taskId));
      if (!task) throw new WebhookEventGoneError();
      const reassigned = event.type === 'task.assignee_changed';
      const { createdBy, createdByApiKeyId } = crmCreatedBy(task.automationId, task.apiKeyId);
      const changer =
        event.type === 'task.created'
          ? { changedBy: createdBy, apiKeyId: createdByApiKeyId }
          : capturedCrmChanger(event.detail);
      return {
        ...base,
        data: {
          task: {
            id: task.id,
            title: task.title,
            status: event.status ?? task.status,
            previousStatus:
              event.type === 'task.status_changed' ? str(event.detail.previousStatus) : null,
            dueAt: task.dueAt?.toISOString() ?? null,
            assigneeId: reassigned ? str(event.detail.assigneeId) : task.assigneeId,
            previousAssigneeId: reassigned ? str(event.detail.previousAssigneeId) : null,
            dealId: task.dealId,
            createdBy,
            createdAt: task.createdAt.toISOString(),
            ...changer,
          },
          contact: await contactOf(tx, tenantId, task.contactId),
          ...(event.type === 'task.updated'
            ? { changes: detailChanges(event.detail, WEBHOOK_TASK_DETAIL_CHANGES) }
            : {}),
        },
      };
    }
    case 'note.created': {
      // The note as it is now, without its text (GET /notes/{id} reads that with notes.read): a
      // merge moves a note to the contact kept, which the payload then gives, and erasing a contact
      // deletes its notes, so an erased contact's note is gone and its event sends nothing.
      const note = await noteOf(tx, tenantId, str(event.detail.noteId));
      if (!note) throw new WebhookEventGoneError();
      return {
        ...base,
        data: {
          note: {
            id: note.id,
            dealId: note.dealId,
            ...noteWriter(note.byMember, note.apiKeyId),
            createdAt: note.createdAt.toISOString(),
          },
          contact: await contactOf(tx, tenantId, note.contactId),
        },
      };
    }
    case 'campaign.status_changed': {
      // The status, the one before it and why it paused or completed as captured; the rest as it
      // is now, its results counted now in one statement (ADR-150).
      const campaign = await campaignOf(tx, tenantId, str(event.detail.campaignId));
      if (!campaign) throw new WebhookEventGoneError();
      const results =
        campaign.status === 'draft'
          ? null
          : toCampaignResults(await campaignAnalytics(tx, tenantId, campaign.id));
      return {
        ...base,
        data: {
          campaign: {
            id: campaign.id,
            name: campaign.name,
            status: event.status,
            previousStatus: str(event.detail.previousStatus),
            pauseReason: str(event.detail.pauseReason),
            completionReason: str(event.detail.completionReason),
            templateId: campaign.templateId,
            templateName: campaign.templateName ?? null,
            scheduledAt: campaign.scheduledAt?.toISOString() ?? null,
            startedAt: campaign.startedAt?.toISOString() ?? null,
            completedAt: campaign.completedAt?.toISOString() ?? null,
            canceledAt: campaign.canceledAt?.toISOString() ?? null,
            audienceCount: campaign.audienceCount,
            queuedCount: campaign.queuedCount,
            skippedCount: campaign.skippedCount,
            results,
          },
          channel: campaign.channelId
            ? { id: campaign.channelId, phone: campaign.channelPhone ?? null }
            : null,
        },
      };
    }
    case 'campaign.recipient_skipped': {
      // The recipient and its reason as captured (a skipped recipient never changes again); its
      // campaign, its contact and the campaign's number as they are now. A recipient a contact
      // merge removed can no longer be described.
      const skipReason = event.status;
      // Every such event is captured with its reason (0280): one without cannot be described.
      if (skipReason === null || !isCampaignSkipReason(skipReason)) {
        throw new Error('The skipped campaign recipient was captured without its reason');
      }
      const recipient = await campaignRecipientOf(tx, tenantId, str(event.detail.recipientId));
      if (!recipient) throw new WebhookEventGoneError();
      const campaign = await campaignOf(tx, tenantId, recipient.campaignId);
      if (!campaign) throw new WebhookEventGoneError();
      return {
        ...base,
        data: {
          // The variant recorded with the snapshot (ADR-405, A to E since ADR-410): it never
          // changes.
          recipient: {
            id: recipient.id,
            skipReason,
            variant: parseVariantLabel(recipient.variant),
          },
          campaign: {
            id: campaign.id,
            name: campaign.name,
            status: campaign.status,
            templateId: campaign.templateId,
            templateName: campaign.templateName ?? null,
          },
          contact: await contactOf(tx, tenantId, recipient.contactId),
          channel: campaign.channelId
            ? { id: campaign.channelId, phone: campaign.channelPhone ?? null }
            : null,
        },
      };
    }
    case 'message.received':
    case 'message.status': {
      const message = await messageContext(tx, tenantId, event.messageId);
      if (!message) throw new WebhookEventGoneError();
      const contact = await contactOf(tx, tenantId, message.contactId);
      const conversation = { id: event.conversationId };
      const channel = { id: message.channelId, phone: message.channelPhone };
      if (event.type === 'message.received') {
        return {
          ...base,
          data: {
            message: {
              id: event.messageId,
              type: message.type,
              ...inboundSummary(message.type, message.content),
              ...inboundOmissions(message.type, message.content),
              contacts: contactCards(message.type, message.content),
              replyTo: await findAnsweredMessageId(tx, tenantId, {
                conversationId: message.conversationId,
                channelAccountId: message.channelId,
                type: message.type,
                content: message.content,
                contextExternalId: message.contextExternalId,
              }),
              receivedAt: event.occurredAt.toISOString(),
            },
            conversation,
            contact,
            channel,
          },
        };
      }
      const template = await templateOf(tx, tenantId, message.templateId);
      const errorCode = str(event.detail.errorCode);
      const errorTitle = str(event.detail.errorTitle);
      return {
        ...base,
        data: {
          message: {
            id: event.messageId,
            status: event.status,
            templateId: message.templateId,
            templateName: template?.name ?? null,
            sentBy: sentBy(message.senderType),
            apiKeyId: message.apiKeyId,
            campaignId: message.campaignId,
          },
          error: errorCode || errorTitle ? { code: errorCode, title: errorTitle } : null,
          conversation,
          contact,
          channel,
        },
      };
    }
  }
  // A type this build does not describe, such as one a newer release added, read by a worker
  // rolled back: the delivery fails without an attempt (and is replayed once fixed) rather than
  // sending a body without data.
  throw new Error(`No webhook payload is built for events of type ${String(event.type)}`);
}

/**
 * The message, conversation, contact, run or order an event names was deleted (retention); the
 * delivery fails as `event_gone`.
 */
export class WebhookEventGoneError extends Error {
  constructor() {
    super('What this event names no longer exists');
    this.name = 'WebhookEventGoneError';
  }
}
