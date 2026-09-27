import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { FlowAnswerMapping } from '@w360/db';
import { TOKEN_ALPHABET, randomToken } from '../growth/model';
import { FLOW_LIMITS } from './flow-json';

/** A flow's public id, in HyFib's data endpoint address (16 base32 characters, like widget ids). */
export const FLOW_PUBLIC_ID_RE = /^[a-z2-7]{16}$/;
export const newFlowPublicId = () => randomToken(TOKEN_ALPHABET, 16);

/** The random flow_token sent with each flow message (256 bits, base64url). */
export const FLOW_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const newFlowToken = () => randomBytes(32).toString('base64url');

/** How long a sent flow keeps working for its data endpoint (HyFib's choice; Meta sets none). */
export const FLOW_TOKEN_DAYS = 30;

/** How long a replaced key still opens requests from clients that have not refreshed it yet. */
export const PREVIOUS_KEY_HOURS = 24;

/** Keyring associated data binding a flow private key to its row. */
export const flowKeyAad = (tenantId: string, keyId: string) => `flow-key:${tenantId}:${keyId}`;

/**
 * The name the flow has at Meta: the member's name plus a short HyFib reference, so the worker can
 * recognise its own flow after a lost create response instead of creating a second one.
 */
export const metaFlowName = (name: string, publicId: string) =>
  `${name} (w360 ${publicId.slice(0, 8)})`;
export const isOwnMetaFlow = (remoteName: string | null, publicId: string) =>
  remoteName !== null && remoteName.endsWith(`(w360 ${publicId.slice(0, 8)})`);

/** HyFib's data endpoint for a flow (set as the flow's endpoint_uri at Meta, research M-161). */
export const flowEndpointUrl = (appBaseUrl: string, publicId: string) =>
  `${appBaseUrl.replace(/\/$/, '')}/api/flows/endpoint/${publicId}`;

export const ANSWER_KEY_RE = /^[A-Za-z0-9_]{1,80}$/;
const TARGET_RE = /^(name|email|field:[a-z][a-z0-9_]{0,49})$/;

export const answerMappingSchema = z
  .array(
    z.object({
      key: z.string().regex(ANSWER_KEY_RE, 'Answer names use letters, digits and underscores.'),
      target: z.string().regex(TARGET_RE, 'Choose where the answer goes.'),
    }),
  )
  .max(50, 'Map at most 50 answers.')
  .refine(
    (list) => new Set(list.map((m) => m.target)).size === list.length,
    'Each contact detail can take only one answer.',
  )
  .transform((list): FlowAnswerMapping[] => list);

export const flowMessageSchema = z.object({
  header: z
    .string()
    .trim()
    .max(FLOW_LIMITS.headerLength, `Use at most ${FLOW_LIMITS.headerLength} characters.`)
    .transform((v) => v || null),
  body: z
    .string()
    .trim()
    .min(1, 'Write the message that comes with the form.')
    .max(FLOW_LIMITS.bodyLength, `Use at most ${FLOW_LIMITS.bodyLength} characters.`),
  footer: z
    .string()
    .trim()
    .max(FLOW_LIMITS.footerLength, `Use at most ${FLOW_LIMITS.footerLength} characters.`)
    .transform((v) => v || null),
  cta: z
    .string()
    .trim()
    .min(1, 'Write the button text.')
    .max(FLOW_LIMITS.ctaLength, `Use at most ${FLOW_LIMITS.ctaLength} characters.`),
});
export type FlowMessage = z.infer<typeof flowMessageSchema>;

/** The Graph request for a flow message (research M-165). */
export function buildFlowMessageRequest(
  to: string,
  message: FlowMessage,
  flow: { metaFlowId: string; token: string; mode: 'draft' | 'published' },
): Record<string, unknown> {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'flow',
      ...(message.header ? { header: { type: 'text', text: message.header } } : {}),
      body: { text: message.body },
      ...(message.footer ? { footer: { text: message.footer } } : {}),
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_id: flow.metaFlowId,
          flow_cta: message.cta,
          mode: flow.mode,
          flow_token: flow.token,
          flow_action: 'navigate',
        },
      },
    },
  };
}

export interface FlowHealthSummary {
  /** Meta's overall verdict, for example `AVAILABLE`, `LIMITED` or `BLOCKED`; null when absent. */
  canSendMessage: string | null;
  problems: { entity: string; description: string; solution: string | null }[];
}

const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

/**
 * Reads a flow’s `health_status` as stored from Meta (research M-107, M-163): `can_send_message`, and
 * `entities[]` each with `entity_type`, `can_send_message` and `errors[]` (`error_description`,
 * `possible_solution`). Unknown or malformed parts are left out rather than guessed.
 */
export function flowHealthSummary(health: Record<string, unknown> | null): FlowHealthSummary {
  if (!health) return { canSendMessage: null, problems: [] };
  const problems: FlowHealthSummary['problems'] = [];
  const entities = Array.isArray(health.entities) ? health.entities : [];
  for (const entity of entities.slice(0, 20)) {
    if (typeof entity !== 'object' || entity === null) continue;
    const e = entity as Record<string, unknown>;
    const errors = Array.isArray(e.errors) ? e.errors : [];
    for (const error of errors.slice(0, 10)) {
      if (typeof error !== 'object' || error === null) continue;
      const description = text((error as Record<string, unknown>).error_description, 500);
      if (!description) continue;
      problems.push({
        entity: text(e.entity_type, 40) ?? 'UNKNOWN',
        description,
        solution: text((error as Record<string, unknown>).possible_solution, 500),
      });
    }
  }
  return { canSendMessage: text(health.can_send_message, 40), problems };
}
