import { z } from 'zod';
import {
  and,
  channelAccounts,
  contacts,
  conversations,
  eq,
  messageTemplates,
  messages,
  type Tx,
} from '@w360/db';

/**
 * The JSON bodies of outgoing webhooks (ADR-053). The zod schemas describe them in the OpenAPI
 * document; `buildWebhookPayload` builds them from an event when it is delivered, reading the
 * company's current data (an erased contact has no number or name).
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

export const WEBHOOK_MESSAGE_STATUSES = [
  'accepted',
  'sent',
  'delivered',
  'read',
  'played',
  'failed',
  'canceled',
  'unknown_outcome',
] as const;

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
      reply: z
        .object({ id: z.string().nullable(), title: z.string().nullable() })
        .nullable()
        .describe('The button or list reply the contact tapped.'),
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

export const pingPayloadSchema = envelope(
  'ping',
  z.object({ endpointId: z.uuid(), message: z.string() }),
);

export type WebhookPayload = { id: string; type: string; createdAt: string; data: unknown };

/** The event as stored (ids and non-personal facts). */
export interface StoredWebhookEvent {
  id: string;
  tenantId: string;
  type:
    'message.received' | 'message.status' | 'consent.changed' | 'template.status_changed' | 'ping';
  messageId: string | null;
  conversationId: string | null;
  contactId: string | null;
  templateId: string | null;
  status: string | null;
  detail: Record<string, unknown>;
  occurredAt: Date;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The readable part of an inbound message: its text, the reply tapped, the media type. */
export function inboundSummary(
  type: string,
  content: Record<string, unknown>,
): {
  text: string | null;
  reply: { id: string | null; title: string | null } | null;
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
        reply: { id: str(content.payload), title: str(content.text) },
        mimeType: null,
      };
    case 'interactive': {
      const reply = (content.reply ?? null) as Record<string, unknown> | null;
      return {
        text: reply ? str(reply.title) : null,
        reply: reply ? { id: str(reply.id), title: str(reply.title) } : null,
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

const sentBy = (senderType: string | undefined) =>
  senderType === 'agent' ||
  senderType === 'bot' ||
  senderType === 'campaign' ||
  senderType === 'api'
    ? senderType
    : 'system';

/**
 * The body delivered for an event, built from the company's data now. Throws when the message an
 * event names no longer exists (it cannot be described); callers fail the delivery.
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

/** The message an event names was deleted (retention); the delivery fails as `event_gone`. */
export class WebhookEventGoneError extends Error {
  constructor() {
    super('The message this event names no longer exists');
    this.name = 'WebhookEventGoneError';
  }
}
