import { z } from 'zod';
import { notFound } from '@w360/core';
import {
  and,
  contacts,
  conversations,
  CONVERSATION_STATUSES,
  desc,
  eq,
  exactTimestamp,
  isNull,
  messages,
  sql,
  type ConversationStatus,
  type MessageStatus,
  type MessageType,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { endRunForHuman } from '../automations/runs';
import { emitTenantEvent } from '../messaging/events';
import { outboundText } from '../messaging/message-text';
import { SERVICE_WINDOW_MS, type OutboundDeps } from '../messaging/outbound';
import { answeredJoin, answeredMessages } from '../messaging/reply-context';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { inboundSummary, type TappedReply } from '../webhooks/payloads';
import { apiActor, assertScope, type ApiContext } from './context';
import { API_LIMITS } from './model';

/**
 * Conversations through the public API. A key with `conversations.read` lists the company's
 * conversations and reads their messages (ADR-072); one with `conversations.write` resolves and
 * reopens them (ADR-075). The conversations of erased contacts are left out, as their contacts are.
 * Messages read as the webhooks describe them (ADR-053).
 */

const page = {
  limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
  cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
};

export const apiConversationListQuerySchema = z
  .object({
    ...page,
    status: z.enum(CONVERSATION_STATUSES).optional().describe('Only conversations in this status.'),
    contactId: z.uuid().optional().describe('Only the conversations of this contact.'),
    channelId: z.uuid().optional().describe('Only the conversations on this WhatsApp number.'),
    updatedSince: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        'Only conversations changed at or after this time (a new message, a status or assignee change, a read).',
      ),
  })
  .strict();

export const apiMessageListQuerySchema = z.object(page).strict();

/** The statuses the inbox sets: `pending` is not one of them. */
export const apiConversationStatusSchema = z
  .object({
    status: z
      .enum(['open', 'resolved'])
      .describe('`resolved` to resolve the conversation, `open` to reopen it.'),
  })
  .strict();

export interface ApiConversation {
  id: string;
  contactId: string;
  channelId: string;
  status: ConversationStatus;
  assigned: boolean;
  unreadCount: number;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  serviceWindowEndsAt: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export type ApiSentBy = 'agent' | 'bot' | 'campaign' | 'api' | 'system';

export interface ApiConversationMessage {
  id: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  type: MessageType;
  text: string | null;
  reply: TappedReply;
  /** The message this one quotes, reacts to or taps a button of, when it is in the conversation (ADR-082). */
  replyTo: string | null;
  mimeType: string | null;
  templateId: string | null;
  templateName: string | null;
  sentBy: ApiSentBy | null;
  apiKeyId: string | null;
  status: MessageStatus;
  statusAt: string;
  error: { code: string | null; title: string | null } | null;
  createdAt: string;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const obj = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const sentBy = (senderType: string): ApiSentBy =>
  senderType === 'agent' ||
  senderType === 'bot' ||
  senderType === 'campaign' ||
  senderType === 'api'
    ? senderType
    : 'system';

const conversationColumns = {
  id: conversations.id,
  contactId: conversations.contactId,
  channelId: conversations.channelAccountId,
  status: conversations.status,
  assignedMembershipId: conversations.assignedMembershipId,
  unreadCount: conversations.unreadCount,
  lastMessageAt: conversations.lastMessageAt,
  lastInboundAt: conversations.lastInboundAt,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
  resolvedAt: conversations.resolvedAt,
  cursorAt: exactTimestamp(conversations.createdAt),
};

type ConversationRow = {
  id: string;
  contactId: string;
  channelId: string;
  status: ConversationStatus;
  assignedMembershipId: string | null;
  unreadCount: number;
  lastMessageAt: Date | null;
  lastInboundAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
};

const toApiConversation = (r: ConversationRow): ApiConversation => ({
  id: r.id,
  contactId: r.contactId,
  channelId: r.channelId,
  status: r.status,
  assigned: r.assignedMembershipId !== null,
  unreadCount: r.unreadCount,
  lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
  lastInboundAt: r.lastInboundAt?.toISOString() ?? null,
  serviceWindowEndsAt: r.lastInboundAt
    ? new Date(r.lastInboundAt.getTime() + SERVICE_WINDOW_MS).toISOString()
    : null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  resolvedAt: r.resolvedAt?.toISOString() ?? null,
});

/** The conversation's contact must exist and not be erased. */
const contactNotErased = and(
  eq(contacts.tenantId, conversations.tenantId),
  eq(contacts.id, conversations.contactId),
  isNull(contacts.erasedAt),
);

async function visibleConversation(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<ConversationRow | null> {
  const [row] = await tx
    .select(conversationColumns)
    .from(conversations)
    .innerJoin(contacts, contactNotErased)
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));
  return row ?? null;
}

export async function apiListConversations(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiConversation[]; nextCursor: string | null }> {
  assertScope(ctx, 'conversations.read');
  const q = parseInput(apiConversationListQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const rows = await tx
        .select(conversationColumns)
        .from(conversations)
        .innerJoin(contacts, contactNotErased)
        .where(
          and(
            eq(conversations.tenantId, ctx.tenant.id),
            q.status ? eq(conversations.status, q.status) : undefined,
            q.contactId ? eq(conversations.contactId, q.contactId) : undefined,
            q.channelId ? eq(conversations.channelAccountId, q.channelId) : undefined,
            q.updatedSince
              ? sql`${conversations.updatedAt} >= ${q.updatedSince}::timestamptz`
              : undefined,
            cursor
              ? sql`(${conversations.createdAt}, ${conversations.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(conversations.createdAt), desc(conversations.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      const last = shown.at(-1);
      return {
        data: shown.map(toApiConversation),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
}

export async function apiGetConversation(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  conversationId: string,
): Promise<ApiConversation> {
  assertScope(ctx, 'conversations.read');
  if (!z.uuid().safeParse(conversationId).success) throw notFound('Conversation');
  const row = await deps.db.run(
    ctx.scope,
    (tx) => visibleConversation(tx, ctx.tenant.id, conversationId),
    { accessMode: 'read only' },
  );
  if (!row) throw notFound('Conversation');
  return toApiConversation(row);
}

export async function apiListConversationMessages(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  conversationId: string,
  query: unknown,
): Promise<{ data: ApiConversationMessage[]; nextCursor: string | null }> {
  assertScope(ctx, 'conversations.read');
  if (!z.uuid().safeParse(conversationId).success) throw notFound('Conversation');
  const q = parseInput(apiMessageListQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  const result = await deps.db.run(
    ctx.scope,
    async (tx) => {
      if (!(await visibleConversation(tx, ctx.tenant.id, conversationId))) return null;
      const rows = await tx
        .select({
          id: messages.id,
          direction: messages.direction,
          type: messages.type,
          content: messages.content,
          status: messages.status,
          statusAt: messages.statusAt,
          errorCode: messages.errorCode,
          errorTitle: messages.errorTitle,
          senderType: messages.senderType,
          templateId: messages.templateId,
          apiKeyId: messages.apiKeyId,
          replyTo: answeredMessages.id,
          createdAt: messages.createdAt,
          cursorAt: exactTimestamp(messages.createdAt),
        })
        .from(messages)
        .leftJoin(answeredMessages, answeredJoin())
        .where(
          and(
            eq(messages.tenantId, ctx.tenant.id),
            eq(messages.conversationId, conversationId),
            cursor
              ? sql`(${messages.createdAt}, ${messages.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      const last = shown.at(-1);
      return {
        data: shown.map((m): ApiConversationMessage => {
          const inbound = m.direction === 'inbound';
          const summary = inbound
            ? inboundSummary(m.type, m.content)
            : { text: outboundText(m.type, m.content), reply: null, mimeType: null };
          const template = obj(m.content.template);
          return {
            id: m.id,
            conversationId,
            direction: m.direction,
            type: m.type,
            text: summary.text,
            reply: summary.reply,
            replyTo: m.replyTo,
            mimeType: summary.mimeType,
            templateId: m.templateId,
            templateName: m.type === 'template' ? str(template?.name) : null,
            sentBy: inbound ? null : sentBy(m.senderType),
            apiKeyId: m.apiKeyId,
            status: m.status,
            statusAt: m.statusAt.toISOString(),
            error: m.errorCode || m.errorTitle ? { code: m.errorCode, title: m.errorTitle } : null,
            createdAt: m.createdAt.toISOString(),
          };
        }),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
  if (!result) throw notFound('Conversation');
  return result;
}

/**
 * Resolves or reopens a conversation as the inbox's Resolve and Reopen do (ADR-075), with the
 * conversation row locked like a member's change. Resolving stops an automation answering the
 * conversation; the triggers close the waiting reply turn and the case, open a new case on reopening
 * and capture the webhook event. The key is the audit actor, so per-member report counts leave the
 * change out, and no satisfaction survey is sent (surveys follow a member's resolve, ADR-032). The
 * status the conversation already has changes nothing, so a retried request does no harm.
 */
export async function apiSetConversationStatus(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  conversationId: string,
  input: unknown,
): Promise<ApiConversation> {
  assertScope(ctx, 'conversations.write');
  if (!z.uuid().safeParse(conversationId).success) throw notFound('Conversation');
  const data = parseInput(apiConversationStatusSchema, input);
  const row = await deps.db.run(ctx.scope, async (tx) => {
    const [current] = await tx
      .select({
        status: conversations.status,
        assignedMembershipId: conversations.assignedMembershipId,
      })
      .from(conversations)
      .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversationId)))
      .for('update');
    if (!current || !(await visibleConversation(tx, ctx.tenant.id, conversationId))) return null;
    if (current.status === data.status)
      return visibleConversation(tx, ctx.tenant.id, conversationId);
    const now = deps.clock.now();
    if (data.status === 'resolved') {
      await endRunForHuman(tx, {
        tenantId: ctx.tenant.id,
        conversationId,
        reason: 'conversation_resolved',
        actorMembershipId: null,
        now,
      });
    }
    await tx
      .update(conversations)
      .set({
        status: data.status,
        resolvedAt: data.status === 'resolved' ? now : null,
        ...(data.status === 'resolved' ? { unreadCount: 0 } : {}),
        version: sql`${conversations.version} + 1`,
      })
      .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversationId)));
    await emitTenantEvent(tx, ctx.tenant.id, {
      type: 'conversation.status',
      conversationId,
      assignedMembershipId: current.assignedMembershipId,
      payload: { status: data.status },
    });
    await recordSystemAudit(
      tx,
      ctx.tenant.id,
      {
        action: 'conversation.status_changed',
        subjectType: 'conversation',
        subjectId: conversationId,
        correlationId: ctx.requestId,
        metadata: { from: current.status, to: data.status, source: 'api' },
      },
      apiActor(ctx),
    );
    return visibleConversation(tx, ctx.tenant.id, conversationId);
  });
  if (!row) throw notFound('Conversation');
  return toApiConversation(row);
}
