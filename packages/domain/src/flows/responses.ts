import { clipText, jsonbSize, jsonbText, parseExternalJson, uuidv7 } from '@w360/core';
import {
  and,
  contactFields,
  contacts,
  eq,
  flowResponses,
  flowSends,
  flows,
  isNull,
  sql,
  type FlowAnswerOutcome,
  type Tx,
} from '@w360/db';
import { coerceFieldValue, normalizeEmail } from '../contacts/fields';
import { FLOW_TOKEN_RE } from './model';

/**
 * Completed flows. WhatsApp sends the answers as an inbound interactive message of type `nfm_reply`
 * whose `response_json` string holds the flow token and the answers (research M-166). The answers
 * are kept on a response row (erased with the contact) and applied to the contact according to the
 * flow's mapping, answer by answer; answers that do not fit are listed, never dropped silently.
 * Completing a flow never records consent.
 */

/** HyFib's limit on the answers kept from one completion (the message row holds 64 KB at most). */
export const MAX_ANSWERS_BYTES = 48 * 1024;

/**
 * The same limit on the answers once stored as jsonb (ADR-131), which can take more than their JSON
 * text (numbers most): under what the message's content and the response row may hold.
 */
export const MAX_ANSWERS_JSONB_BYTES = 55 * 1024;

export interface FlowCompletion {
  token: string | null;
  /** The answers without the token, or null when they could not be read or were too large. */
  answers: Record<string, unknown> | null;
  tooLarge: boolean;
  body: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads a webhook message's `interactive.nfm_reply`, or null when it is not a flow completion. */
export function parseFlowCompletion(interactive: unknown): FlowCompletion | null {
  if (!isObject(interactive) || interactive.type !== 'nfm_reply') return null;
  const nfm = isObject(interactive.nfm_reply) ? interactive.nfm_reply : {};
  const body = typeof nfm.body === 'string' ? clipText(nfm.body, 1024) : '';
  const raw = nfm.response_json;
  if (typeof raw !== 'string') return { token: null, answers: null, tooLarge: false, body };
  if (Buffer.byteLength(raw, 'utf8') > MAX_ANSWERS_BYTES) {
    return { token: null, answers: null, tooLarge: true, body };
  }
  let parsed: unknown;
  try {
    parsed = parseExternalJson(raw);
  } catch {
    return { token: null, answers: null, tooLarge: false, body };
  }
  if (!isObject(parsed)) return { token: null, answers: null, tooLarge: false, body };
  const { flow_token: rawToken, ...answers } = parsed;
  const token = typeof rawToken === 'string' && FLOW_TOKEN_RE.test(rawToken) ? rawToken : null;
  if (jsonbSize(answers) > MAX_ANSWERS_JSONB_BYTES)
    return { token, answers: null, tooLarge: true, body };
  return { token, answers, tooLarge: false, body };
}

/** One answer as a single line of text, or null for lists and objects (which are not mapped). */
function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

/**
 * Records a completion in the ingest transaction (after the message row was inserted): matches the
 * token to the flow message it came from, stores the answers and applies the flow's mapping.
 */
export async function recordFlowCompletion(
  tx: Tx,
  input: {
    tenantId: string;
    conversationId: string;
    contactId: string;
    messageId: string;
    completion: FlowCompletion;
    receivedAt: Date;
  },
): Promise<{ flowId: string | null; applied: FlowAnswerOutcome[] }> {
  const { completion } = input;
  const [send] = completion.token
    ? await tx
        .select({
          id: flowSends.id,
          flowId: flowSends.flowId,
          contactId: flowSends.contactId,
          completedAt: flowSends.completedAt,
          mapping: flows.answerMapping,
        })
        .from(flowSends)
        .innerJoin(
          flows,
          and(eq(flows.tenantId, flowSends.tenantId), eq(flows.id, flowSends.flowId)),
        )
        .where(and(eq(flowSends.tenantId, input.tenantId), eq(flowSends.token, completion.token)))
    : [];

  const applied: FlowAnswerOutcome[] = [];
  if (send && !completion.answers) {
    applied.push({
      key: '*',
      target: '*',
      outcome: 'skipped',
      message: completion.tooLarge
        ? 'The answers were larger than HyFib keeps, so none were applied.'
        : 'The answers could not be read, so none were applied.',
    });
  } else if (send && send.contactId !== input.contactId) {
    applied.push({
      key: '*',
      target: '*',
      outcome: 'skipped',
      message: 'The form was sent to another contact, so the answers were not applied.',
    });
  } else if (send && completion.answers && send.mapping.length > 0) {
    // The answers belong to the contact the form was sent to (the token names that send).
    const [contact] = await tx
      .select({ id: contacts.id, erasedAt: contacts.erasedAt })
      .from(contacts)
      .where(and(eq(contacts.tenantId, input.tenantId), eq(contacts.id, send.contactId)))
      .for('update');
    const fieldRows = await tx
      .select({ key: contactFields.key, label: contactFields.label, type: contactFields.type })
      .from(contactFields)
      .where(eq(contactFields.tenantId, input.tenantId));
    const fields = new Map(fieldRows.map((f) => [f.key, f]));
    const set: { displayName?: string; email?: string | null } = {};
    const attrSet: Record<string, string | number | boolean> = {};
    const attrRemove: string[] = [];
    for (const { key, target } of send.mapping) {
      const raw = completion.answers[key];
      if (!contact || contact.erasedAt) {
        applied.push({ key, target, outcome: 'skipped', message: 'The contact was erased.' });
        continue;
      }
      if (raw === undefined || raw === null || raw === '') {
        applied.push({ key, target, outcome: 'missing' });
        continue;
      }
      const text = scalar(raw);
      if (text === null) {
        applied.push({
          key,
          target,
          outcome: 'invalid',
          message: 'The answer is not a single value.',
        });
        continue;
      }
      if (target === 'name') {
        if (text.length === 0 || text.length > 200) {
          applied.push({
            key,
            target,
            outcome: 'invalid',
            message: 'Names have 1 to 200 characters.',
          });
        } else {
          set.displayName = text;
          applied.push({ key, target, outcome: 'applied' });
        }
      } else if (target === 'email') {
        const email = normalizeEmail(text);
        if (!email.ok || !email.email) {
          applied.push({
            key,
            target,
            outcome: 'invalid',
            message: 'The email address is not valid.',
          });
        } else {
          set.email = email.email;
          applied.push({ key, target, outcome: 'applied' });
        }
      } else {
        const field = fields.get(target.slice('field:'.length));
        if (!field) {
          applied.push({
            key,
            target,
            outcome: 'invalid',
            message: 'The contact field no longer exists.',
          });
          continue;
        }
        const coerced = coerceFieldValue(field, text);
        if (!coerced.ok) {
          applied.push({ key, target, outcome: 'invalid', message: coerced.message });
        } else {
          if (coerced.value === null) attrRemove.push(field.key);
          else attrSet[field.key] = coerced.value;
          applied.push({ key, target, outcome: 'applied' });
        }
      }
    }
    if (contact && !contact.erasedAt && applied.some((a) => a.outcome === 'applied')) {
      let attributes = sql`${contacts.attributes} || ${jsonbText(attrSet)}::jsonb`;
      for (const key of attrRemove) attributes = sql`(${attributes}) - ${key}::text`;
      await tx
        .update(contacts)
        .set({ ...set, attributes })
        .where(
          and(
            eq(contacts.tenantId, input.tenantId),
            eq(contacts.id, contact.id),
            isNull(contacts.erasedAt),
          ),
        );
    }
  }

  await tx
    .insert(flowResponses)
    .values({
      id: uuidv7(),
      tenantId: input.tenantId,
      flowId: send?.flowId ?? null,
      flowSendId: send?.id ?? null,
      conversationId: input.conversationId,
      contactId: input.contactId,
      messageId: input.messageId,
      answers: completion.answers ?? {},
      applied,
      receivedAt: input.receivedAt,
    })
    .onConflictDoNothing();
  if (send && !send.completedAt) {
    await tx
      .update(flowSends)
      .set({ completedAt: input.receivedAt })
      .where(and(eq(flowSends.tenantId, input.tenantId), eq(flowSends.id, send.id)));
  }
  return { flowId: send?.flowId ?? null, applied };
}
