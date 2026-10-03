import { z } from 'zod';
import { clipText, jsonbSize } from '@w360/core';
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

/**
 * What an inbound message's stored content may take as jsonb (ADR-131): under the 64 KB its column
 * allows (`messages_content_check`), so that one message never fails its receipt with every message
 * and status beside it.
 */
export const INBOUND_CONTENT_BUDGET = 60 * 1024;

/** The longest text kept from one value of an inbound message, in UTF-16 code units. */
const MAX_TEXT = 4096;
/** The most contacts kept from one contact card, while they fit the budget. */
const MAX_CONTACTS = 20;
/** The most errors kept from a message WhatsApp could not read. */
const MAX_ERRORS = 5;

type InboundType =
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

interface InboundContent {
  type: InboundType;
  content: Record<string, unknown>;
  preview: string;
}

/**
 * Keeps `keys` of an object that hold text (clipped without splitting a character), a finite number
 * or true or false; anything else (objects, lists) is left out, so what is kept stays bounded.
 */
function pick(
  value: unknown,
  keys: readonly string[],
  maxText = MAX_TEXT,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (typeof v === 'string') out[k] = clipText(v, maxText);
    else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** Errors as kept: at most 5, each with its code, title, message and details, clipped. */
function boundedErrors(errors: unknown, maxText = 1000): Record<string, unknown>[] {
  if (!Array.isArray(errors)) return [];
  return errors.slice(0, MAX_ERRORS).map((error: unknown) => {
    const kept = pick(error, ['code', 'title', 'message'], maxText);
    const data =
      typeof error === 'object' && error !== null
        ? (error as Record<string, unknown>).error_data
        : null;
    const details = pick(data, ['details'], maxText);
    return Object.keys(details).length > 0 ? { ...kept, error_data: details } : kept;
  });
}

/**
 * What a status's errors and pricing may take as jsonb (ADR-131): under the 4 KB and 2 KB their
 * columns allow, so that one status never fails its receipt.
 */
const STATUS_ERRORS_BUDGET = 3584;
const STATUS_PRICING_BUDGET = 1536;

/**
 * A status's errors as stored (ADR-131): as WhatsApp sent them when they fit the budget, otherwise
 * each error's code, title, message and details, clipped, while they fit. The first error's code and
 * title always fit (500 code units each take at most 1,500 bytes).
 */
export function statusErrorsToStore(
  errors: Record<string, unknown>[] | undefined,
): Record<string, unknown>[] | null {
  if (errors === undefined) return null;
  if (jsonbSize(errors) <= STATUS_ERRORS_BUDGET) return errors;
  const kept: Record<string, unknown>[] = [];
  for (const error of boundedErrors(errors, 500)) {
    if (jsonbSize([...kept, error]) > STATUS_ERRORS_BUDGET) break;
    kept.push(error);
  }
  return kept.length > 0 ? kept : [pick(errors[0], ['code', 'title'], 500)];
}

/**
 * A status's pricing as stored (ADR-131): as WhatsApp sent it when it fits the budget, otherwise its
 * billable flag, pricing model, category and type, clipped (reports read the category and the flag).
 */
export function statusPricingToStore(
  pricing: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (pricing === undefined) return null;
  if (jsonbSize(pricing) <= STATUS_PRICING_BUDGET) return pricing;
  return pick(pricing, ['billable', 'pricing_model', 'category', 'type'], 64);
}

/**
 * Normalises an inbound message into our message type and a content object of bounded size
 * (ADR-131): text is clipped, values are picked, a contact card keeps the contacts that fit, and
 * content that would still exceed the budget is kept as `{ tooLarge: true }`.
 */
export function normaliseInboundContent(message: MetaMessage): InboundContent {
  const normalised = buildInboundContent(message);
  if (jsonbSize(normalised.content) <= INBOUND_CONTENT_BUDGET) return normalised;
  return {
    type: normalised.type,
    content: { tooLarge: true },
    preview: '[message too large to keep]',
  };
}

function buildInboundContent(message: MetaMessage): InboundContent {
  const raw = message as Record<string, unknown>;
  const type = KNOWN_TYPES.has(message.type) ? (message.type as InboundType) : 'unsupported';
  const body = raw[message.type];
  switch (type) {
    case 'text': {
      const text = clipText(String((body as { body?: unknown } | undefined)?.body ?? ''), MAX_TEXT);
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
    case 'contacts': {
      // The first contacts that fit the budget, as WhatsApp sent them, and how many were left out.
      const all: unknown[] = Array.isArray(body) ? body : [];
      const contacts: unknown[] = [];
      for (const contact of all.slice(0, MAX_CONTACTS)) {
        const candidate = { contacts: [...contacts, contact], omittedContacts: all.length };
        if (jsonbSize(candidate) > INBOUND_CONTENT_BUDGET) break;
        contacts.push(contact);
      }
      const omittedContacts = all.length - contacts.length;
      return {
        type,
        content: omittedContacts > 0 ? { contacts, omittedContacts } : { contacts },
        preview: '[contact card]',
      };
    }
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
      // The tapped button or row: its id, title and description, as WhatsApp sent them (clipped).
      const tapped = i.button_reply ?? i.list_reply ?? i.nfm_reply;
      const reply =
        typeof tapped === 'object' && tapped !== null
          ? pick(tapped, ['id', 'title', 'description'])
          : null;
      const title = typeof reply?.title === 'string' ? reply.title : '';
      return {
        type,
        content: {
          interactiveType: typeof i.type === 'string' ? clipText(i.type, 64) : null,
          reply,
        },
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
        content: {
          originalType: clipText(message.type, 64),
          errors: boundedErrors(message.errors),
        },
        preview: '[unsupported message]',
      };
  }
}
