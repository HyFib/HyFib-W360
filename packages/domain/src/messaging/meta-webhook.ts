import { z } from 'zod';
import { parseFlowCompletion } from '../flows/responses';
import { parseOrder } from '../commerce/model';
import { formatMinor } from '../crm/money';

/**
 * Lenient schemas for Meta WhatsApp webhook payloads (object `whatsapp_business_account`).
 * Unknown fields are preserved (passthrough) and unknown message types are stored as `unsupported`
 * rather than rejected, because Meta adds fields and types over time.
 * Field reference: docs/research/meta-whatsapp.md (M-033, M-051, M-076, M-111).
 */
const id = z.string().min(1).max(256);

export const metaContactSchema = z
  .object({
    profile: z
      .object({ name: z.string().max(500).optional() })
      .passthrough()
      .optional(),
    wa_id: z.string().max(32).optional(),
    user_id: z.string().max(128).optional(),
    parent_user_id: z.string().max(128).optional(),
  })
  .passthrough();

export const metaMessageSchema = z
  .object({
    id,
    from: z.string().max(128).optional(),
    timestamp: z.string().regex(/^\d{1,12}$/),
    type: z.string().max(64),
    context: z
      .object({ id: z.string().max(256).optional(), from: z.string().optional() })
      .passthrough()
      .optional(),
    referral: z.record(z.string(), z.unknown()).optional(),
    errors: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

export const metaStatusSchema = z
  .object({
    id,
    status: z.string().max(32),
    timestamp: z.string().regex(/^\d{1,12}$/),
    recipient_id: z.string().max(128).optional(),
    recipient_user_id: z.string().max(128).optional(),
    pricing: z.record(z.string(), z.unknown()).optional(),
    conversation: z.record(z.string(), z.unknown()).optional(),
    errors: z
      .array(
        z
          .object({
            code: z.union([z.number(), z.string()]).optional(),
            title: z.string().max(500).optional(),
            message: z.string().max(1000).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const metaMessagesValueSchema = z
  .object({
    messaging_product: z.string().optional(),
    metadata: z.object({
      display_phone_number: z.string().max(32).optional(),
      phone_number_id: z.string().regex(/^[0-9]{1,32}$/),
    }),
    contacts: z.array(metaContactSchema).max(1000).optional(),
    messages: z.array(z.unknown()).max(1000).optional(),
    statuses: z.array(z.unknown()).max(1000).optional(),
    errors: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

export const metaChangeSchema = z
  .object({ field: z.string().max(100), value: z.unknown() })
  .passthrough();

export const metaEntrySchema = z
  .object({ id: z.string().regex(/^[0-9]{1,32}$/), changes: z.array(metaChangeSchema).max(100) })
  .passthrough();

export const metaEnvelopeSchema = z
  .object({ object: z.string().max(100), entry: z.array(metaEntrySchema).max(100) })
  .passthrough();

export type MetaContact = z.infer<typeof metaContactSchema>;
export type MetaMessage = z.infer<typeof metaMessageSchema>;
export type MetaStatus = z.infer<typeof metaStatusSchema>;
export type MetaMessagesValue = z.infer<typeof metaMessagesValueSchema>;
export type MetaEnvelope = z.infer<typeof metaEnvelopeSchema>;

const KNOWN_TYPES = new Set([
  'text',
  'image',
  'video',
  'audio',
  'document',
  'sticker',
  'location',
  'contacts',
  'interactive',
  'button',
  'reaction',
  'order',
  'system',
]);

/** Normalises an inbound message into our message type and a content object (bounded size). */
export function normaliseInboundContent(message: MetaMessage): {
  type:
    | 'text'
    | 'image'
    | 'video'
    | 'audio'
    | 'document'
    | 'sticker'
    | 'location'
    | 'contacts'
    | 'interactive'
    | 'button'
    | 'reaction'
    | 'order'
    | 'system'
    | 'unsupported';
  content: Record<string, unknown>;
  preview: string;
} {
  const raw = message as Record<string, unknown>;
  const type = KNOWN_TYPES.has(message.type)
    ? (message.type as ReturnType<typeof normaliseInboundContent>['type'])
    : 'unsupported';
  const body = raw[message.type];
  const pick = (value: unknown, keys: string[]): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null) return {};
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = typeof v === 'string' ? v.slice(0, 4096) : v;
    }
    return out;
  };
  switch (type) {
    case 'text': {
      const text = String((body as { body?: unknown } | undefined)?.body ?? '').slice(0, 4096);
      return { type, content: { text }, preview: text };
    }
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker': {
      const content = pick(body, [
        'id',
        'mime_type',
        'sha256',
        'caption',
        'filename',
        'voice',
        'animated',
      ]);
      const caption = typeof content.caption === 'string' ? content.caption : '';
      return { type, content, preview: caption || `[${type}]` };
    }
    case 'location': {
      const content = pick(body, ['latitude', 'longitude', 'name', 'address', 'url']);
      return {
        type,
        content,
        preview: typeof content.name === 'string' ? content.name : '[location]',
      };
    }
    case 'contacts':
      return {
        type,
        content: { contacts: Array.isArray(body) ? body.slice(0, 20) : [] },
        preview: '[contact card]',
      };
    case 'interactive': {
      const i = (body ?? {}) as Record<string, unknown>;
      // A completed WhatsApp Flow (research M-166): the answers, without the flow token.
      const completion = parseFlowCompletion(i);
      if (completion) {
        return {
          type,
          content: {
            interactiveType: 'nfm_reply',
            reply: null,
            flow: {
              body: completion.body,
              answers: completion.answers,
              tooLarge: completion.tooLarge,
            },
          },
          preview: '[Form submitted]',
        };
      }
      const reply = (i.button_reply ?? i.list_reply ?? i.nfm_reply) as
        Record<string, unknown> | undefined;
      const title = typeof reply?.title === 'string' ? reply.title : '';
      return {
        type,
        content: { interactiveType: i.type ?? null, reply: reply ?? null },
        preview: title || '[interactive reply]',
      };
    }
    case 'button': {
      const content = pick(body, ['text', 'payload']);
      return {
        type,
        content,
        preview: typeof content.text === 'string' ? content.text : '[button]',
      };
    }
    case 'reaction': {
      const content = pick(body, ['message_id', 'emoji']);
      return {
        type,
        content,
        preview:
          typeof content.emoji === 'string' ? `Reacted ${content.emoji}` : 'Reaction removed',
      };
    }
    case 'order': {
      // A cart sent from the catalog (research M-170), with prices in minor units.
      const order = parseOrder(body);
      if (!order)
        return { type, content: { order: null }, preview: '[order that could not be read]' };
      const units = order.items.reduce((n, i) => n + i.quantity, 0);
      const total =
        order.subtotalMinor !== null && order.currency
          ? ` · ${formatMinor(order.subtotalMinor, order.currency)}`
          : '';
      return {
        type,
        content: { order },
        preview: `[Order] ${units} item${units === 1 ? '' : 's'}${total}`,
      };
    }
    case 'system':
      return {
        type,
        content: pick(body, [
          'type',
          'body',
          'user_id',
          'parent_user_id',
          'previous_user_id',
          'previous_parent_user_id',
          'wa_id',
          'new_wa_id',
        ]),
        preview: '[system update]',
      };
    default:
      return {
        type: 'unsupported',
        content: { originalType: message.type.slice(0, 64), errors: message.errors ?? [] },
        preview: '[unsupported message]',
      };
  }
}
