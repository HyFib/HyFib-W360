import { z } from 'zod';
import {
  and,
  asc,
  AUTOMATION_END_REASONS,
  AUTOMATION_RUN_STATUSES,
  automationRuns,
  automations,
  CAMPAIGN_COMPLETION_REASONS,
  CAMPAIGN_PAUSE_REASONS,
  CAMPAIGN_STATUSES,
  campaigns,
  channelAccounts,
  commerceOrderItems,
  commerceOrders,
  contacts,
  CONVERSATION_STATUSES,
  conversations,
  eq,
  messageTemplates,
  messages,
  ORDER_STATUSES,
  type Tx,
  type WebhookEventType,
} from '@w360/db';
import { apiContactColumns, apiContactSchema, toApiContact } from '../api/contact-view';
import { COMMERCE_LIMITS } from '../commerce/model';
import { findAnsweredMessageId } from '../messaging/reply-context';
import { WEBHOOK_MESSAGE_STATUSES } from './model';

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

function envelope<T extends string, D extends z.ZodType>(type: T, data: D) {
  return z.object({
    id: z
      .uuid()
      .describe('The event id: the same for every attempt and replay. Deduplicate on it.'),
    type: z.literal(type),
    createdAt: z.iso.datetime().describe('When it happened.'),
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
        .describe('The text, a caption, the title of a tapped reply or a reaction; null if none.'),
      reply: tappedReplySchema,
      replyTo: z
        .uuid()
        .nullable()
        .describe(
          'The id of the message this one answers: the message the contact quoted, the message a reaction is for, or the message whose button or row was tapped. Null when there is none or it is not in the conversation.',
        ),
      mimeType: z.string().nullable().describe('For media messages (the media is not attached).'),
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
          'The member assigned by the change, as GET /members lists them; null for none. Null too for events captured before members were named (ADR-094).',
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
export const contactUpdatedPayloadSchema = envelope(
  'contact.updated',
  z.object({ contact: webhookContactSchema }),
);
export const contactErasedPayloadSchema = envelope(
  'contact.erased',
  z.object({ contact: webhookContactSchema }),
);

/** What starts a live run; members' test runs send no events. */
export const WEBHOOK_RUN_TRIGGERS = [
  'keyword',
  'conversation_started',
  'any_message',
  'store_event',
  'api',
] as const;

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
      'What started it: a keyword, a new conversation, any message, a store’s order event or a call through the API.',
    ),
  apiKeyId: z
    .uuid()
    .nullable()
    .describe('The API key that started it, for a run started through the API.'),
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
      'Why it paused, when the status is paused: a member paused it (manual), the spending or message cap was reached, the template is no longer approved, the number is not active, the member whose authority it runs under left or lost the permission, or no rate card is published for its spending cap. Null otherwise.',
    ),
  completionReason: z
    .enum(CAMPAIGN_COMPLETION_REASONS)
    .nullable()
    .describe(
      'Why it completed, when the status is completed: every recipient was processed, or its sending time ran out. Null otherwise.',
    ),
  templateId: z.uuid().nullable(),
  templateName: z.string().nullable().describe('The template’s name when the event is delivered.'),
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
});

export const campaignStatusChangedPayloadSchema = envelope(
  'campaign.status_changed',
  z.object({
    campaign: webhookCampaignSchema,
    channel: channelSchema.nullable().describe('The number it sends from; null if none is set.'),
  }),
);

export const pingPayloadSchema = envelope(
  'ping',
  z.object({ endpointId: z.uuid(), message: z.string() }),
);

export type WebhookPayload = { id: string; type: string; createdAt: string; data: unknown };

/** The event as stored (ids and non-personal facts). */
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
  occurredAt: Date;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

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
  const base = { id: event.id, type: event.type, createdAt: event.occurredAt.toISOString() };
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
      return { ...base, data: { contact } };
    }
    case 'automation.run_started':
    case 'automation.run_ended': {
      // The status, end reason and end as captured; the rest as it is now.
      const run = await runOf(tx, tenantId, str(event.detail.runId));
      if (!run) throw new WebhookEventGoneError();
      const ended = event.type === 'automation.run_ended';
      return {
        ...base,
        data: {
          run: {
            id: run.id,
            automationId: run.automationId,
            automationName: run.automationName ?? null,
            trigger: run.triggerType,
            apiKeyId: run.apiKeyId,
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
    case 'campaign.status_changed': {
      // The status, the one before it and why it paused or completed as captured; the rest as it
      // is now.
      const campaign = await campaignOf(tx, tenantId, str(event.detail.campaignId));
      if (!campaign) throw new WebhookEventGoneError();
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
          },
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
          },
          error: errorCode || errorTitle ? { code: errorCode, title: errorTitle } : null,
          conversation,
          contact,
          channel,
        },
      };
    }
  }
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
