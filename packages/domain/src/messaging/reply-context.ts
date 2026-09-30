import { alias } from 'drizzle-orm/pg-core';
import { and, eq, messages, sql, type SQL, type Tx } from '@w360/db';

/**
 * The message another one answers (ADR-082): the message a reply quotes (`context.message_id` when
 * sending, research M-041 and M-183; inbound messages keep the webhook's `context.id`: taps, M-158
 * and M-178, and replies the customer quotes, M-186), or the message a reaction is for
 * (`reaction.message_id`, M-182 and M-184). Both name it by its WhatsApp id, which is unique per
 * number (`messages_external_uq`), and only a message of the same conversation counts.
 */

/** How long after the contact sent a message a key may still react to it (M-185, the stricter reading). */
export const REACTION_MAX_AGE_MS = 30 * 24 * 3600_000;

/** Business messages WhatsApp accepted and did not fail: the ones a reply may quote. */
const QUOTABLE_OUTBOUND_STATUSES = new Set(['accepted', 'sent', 'delivered', 'read', 'played']);

/** The WhatsApp id of the message `type`/`content`/`contextExternalId` answers, if any. */
export function answeredExternalIdOf(
  type: string,
  content: Record<string, unknown>,
  contextExternalId: string | null,
): string | null {
  if (type !== 'reaction') return contextExternalId;
  const id = content.message_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** `answeredExternalIdOf` in SQL, for a row of `app.messages`. */
export function answeredExternalId(): SQL<string | null> {
  return sql<
    string | null
  >`case when ${messages.type} = 'reaction' then ${messages.content} ->> 'message_id' else ${messages.contextExternalId} end`;
}

/** `app.messages` joined as the message each listed message answers. */
export const answeredMessages = alias(messages, 'answered');

/** The join condition for `answeredMessages`: same company, number and conversation. */
export function answeredJoin(): SQL | undefined {
  return and(
    eq(answeredMessages.tenantId, messages.tenantId),
    eq(answeredMessages.channelAccountId, messages.channelAccountId),
    eq(answeredMessages.conversationId, messages.conversationId),
    eq(answeredMessages.externalMessageId, answeredExternalId()),
  );
}

/** The id of the message a stored message answers, when it is in the same conversation. */
export async function findAnsweredMessageId(
  tx: Tx,
  tenantId: string,
  message: {
    conversationId: string;
    channelAccountId: string;
    type: string;
    content: Record<string, unknown>;
    contextExternalId: string | null;
  },
): Promise<string | null> {
  const externalId = answeredExternalIdOf(message.type, message.content, message.contextExternalId);
  if (!externalId) return null;
  const [row] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.channelAccountId, message.channelAccountId),
        eq(messages.conversationId, message.conversationId),
        eq(messages.externalMessageId, externalId),
      ),
    );
  return row?.id ?? null;
}

export type AnswerKind = 'quote' | 'reaction';

/** A message of the conversation that a reply names to quote or react to. */
export interface AnswerTarget {
  direction: 'inbound' | 'outbound';
  type: string;
  status: string;
  externalMessageId: string | null;
  /** When the contact sent it (WhatsApp's time), or when it was stored. */
  at: Date;
}

/**
 * Why a reply cannot quote `target`, or a reaction cannot go on it (ADR-082); null when it can.
 * Reactions and WhatsApp notices are neither quoted nor reacted to. A reaction goes only on a
 * message the contact sent in the last 30 days (M-185). A quote needs a message WhatsApp knows: one
 * the contact sent, or one the business sent that WhatsApp accepted and that did not fail.
 */
export function answerProblem(kind: AnswerKind, target: AnswerTarget, now: Date): string | null {
  if (target.type === 'reaction' || target.type === 'system') {
    return kind === 'quote'
      ? 'Reactions and WhatsApp notices cannot be quoted.'
      : 'Reactions go on messages the contact sent, not on reactions or WhatsApp notices.';
  }
  if (kind === 'reaction') {
    if (target.direction !== 'inbound' || !target.externalMessageId) {
      return 'Reactions go on messages the contact sent.';
    }
    return now.getTime() - target.at.getTime() > REACTION_MAX_AGE_MS
      ? 'Reactions go on messages from the last 30 days.'
      : null;
  }
  if (
    !target.externalMessageId ||
    (target.direction === 'outbound' && !QUOTABLE_OUTBOUND_STATUSES.has(target.status))
  ) {
    return 'Only messages WhatsApp accepted can be quoted.';
  }
  return null;
}

/** The longest emoji accepted, in UTF-16 code units (the longest RGI sequences use 15). */
const EMOJI_MAX_LENGTH = 32;
let rgiEmoji: RegExp | undefined;

/**
 * Whether `value` is exactly one emoji from Unicode's recommended set (RGI): skin tones, flags,
 * keycaps and joined sequences count as one. Built on first use, as the `v` flag it needs is recent.
 */
export function isSingleEmoji(value: string): boolean {
  if (value.length === 0 || value.length > EMOJI_MAX_LENGTH) return false;
  rgiEmoji ??= new RegExp('^\\p{RGI_Emoji}$', 'v');
  return rgiEmoji.test(value);
}
