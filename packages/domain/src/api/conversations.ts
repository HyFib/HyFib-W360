import { z } from 'zod';
import { AppError, notFound, uuidv7 } from '@w360/core';
import {
  and,
  asc,
  contacts,
  conversationNotes,
  conversations,
  conversationTags,
  CONVERSATION_STATUSES,
  desc,
  eq,
  exactTimestamp,
  inArray,
  isNull,
  messages,
  sql,
  teams,
  type ConversationStatus,
  type MessageStatus,
  type MessageType,
  type SQL,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { endRunForHuman } from '../automations/runs';
import { normalizeTag } from '../contacts/fields';
import {
  MAX_TAGS_PER_CONVERSATION,
  conversationHasTag,
  conversationTagsOf,
} from '../inbox/conversation-tags';
import { lockAssignableMember, lockTeam, routeConversation } from '../inbox/routing';
import { emitTenantEvent } from '../messaging/events';
import { outboundText } from '../messaging/message-text';
import { NOTE_MAX_LENGTH } from '../messaging/notes';
import { SERVICE_WINDOW_MS, type OutboundDeps } from '../messaging/outbound';
import { answeredJoin, answeredMessages } from '../messaging/reply-context';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import {
  contactCards,
  inboundOmissions,
  inboundSummary,
  type ContactCard,
  type TappedReply,
} from '../webhooks/payloads';
import { apiTags } from './contacts';
import { apiActor, assertScope, type ApiContext } from './context';
import type { ApiResponse, IdempotencyInput } from './idempotency';
import { API_LIMITS } from './model';
import { idempotent } from './resources';

/**
 * Conversations through the public API. A key with `conversations.read` lists the company's
 * conversations and reads their messages (ADR-072), or every message across them (ADR-088), and their
 * internal notes (ADR-089); one with `conversations.write` resolves and reopens them (ADR-075), adds
 * internal notes (ADR-084), assigns them or moves them between teams (ADR-093) and tags them
 * (ADR-221), many at once (ADR-120) or those a filter finds (ADR-166). The conversations of erased
 * contacts are left out, as their contacts are. Messages read as the webhooks describe them
 * (ADR-053).
 */

const page = {
  limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
  cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
};

/** What GET /conversations filters by, as changing conversations by a filter takes it (ADR-166). */
const conversationFilters = {
  status: z.enum(CONVERSATION_STATUSES).optional().describe('Only conversations in this status.'),
  contactId: z.uuid().optional().describe('Only the conversations of this contact.'),
  channelId: z.uuid().optional().describe('Only the conversations on this WhatsApp number.'),
  assigneeId: z
    .union([z.uuid(), z.literal('none')])
    .optional()
    .describe('Only the conversations assigned to this member, or `none` for those without one.'),
  teamId: z
    .union([z.uuid(), z.literal('none')])
    .optional()
    .describe('Only the conversations of this team, or `none` for those without one.'),
  updatedSince: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      'Only conversations changed at or after this time (a new message, a status, assignee or tag change, a read).',
    ),
  tag: z
    .string()
    .max(100)
    .refine((value) => normalizeTag(value).ok, 'Give a tag: up to 40 characters, without commas.')
    .optional()
    .describe('Only the conversations with this tag, however its letters are cased.'),
};

export const apiConversationListQuerySchema = z
  .object({ ...page, ...conversationFilters })
  .strict();

/** A filter of GET /conversations: the conversations it finds. */
export type ConversationFilter = Omit<
  z.infer<typeof apiConversationListQuerySchema>,
  'limit' | 'cursor'
>;

export const apiMessageListQuerySchema = z.object(page).strict();

/** A conversation's internal notes (ADR-089). */
export const apiNoteListQuerySchema = z.object(page).strict();

/** The messages of every conversation (ADR-088). */
export const apiMessageFeedQuerySchema = z
  .object({
    ...page,
    direction: z
      .enum(['inbound', 'outbound'])
      .optional()
      .describe('Only messages the contacts wrote (inbound) or the company sent (outbound).'),
    channelId: z
      .uuid()
      .optional()
      .describe('Only messages received on or sent from this WhatsApp number.'),
    since: z.iso
      .datetime({ offset: true })
      .optional()
      .describe('Only messages created at or after this time.'),
  })
  .strict();

/** An internal note (ADR-084): for the team, never sent to WhatsApp. */
export const apiAddNoteSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(NOTE_MAX_LENGTH)
      .describe('The note, which the team reads in the inbox. WhatsApp never receives it.'),
  })
  .strict();

/**
 * What a key changes in a conversation (ADR-075, ADR-093): its status (those the inbox sets, so not
 * `pending`), its assignee or its team, at least one of them.
 */
const conversationChange = {
  status: z.enum(['open', 'resolved']).optional(),
  assigneeId: z.uuid().nullable().optional(),
  teamId: z.uuid().nullable().optional(),
  addTags: z.array(z.string().max(40)).max(MAX_TAGS_PER_CONVERSATION).optional(),
  removeTags: z.array(z.string().max(40)).max(MAX_TAGS_PER_CONVERSATION).optional(),
};
const someChange = (v: {
  status?: unknown;
  assigneeId?: unknown;
  teamId?: unknown;
  addTags?: unknown;
  removeTags?: unknown;
}) =>
  v.status !== undefined ||
  v.assigneeId !== undefined ||
  v.teamId !== undefined ||
  v.addTags !== undefined ||
  v.removeTags !== undefined;
const SOME_CHANGE = 'Give status, assigneeId, teamId, addTags or removeTags.';
const ADD_TAGS = `Tags to put on the conversation, as members do in the inbox (lower-cased; commas are not allowed). A conversation has at most ${MAX_TAGS_PER_CONVERSATION}.`;
const REMOVE_TAGS = 'Tags to take off the conversation; a tag it does not have changes nothing.';

export const apiUpdateConversationSchema = z
  .object({
    status: conversationChange.status.describe(
      '`resolved` to resolve the conversation, `open` to reopen it.',
    ),
    assigneeId: conversationChange.assigneeId.describe(
      'A member from GET /members to assign the conversation to, or null to unassign it.',
    ),
    teamId: conversationChange.teamId.describe(
      'A team from GET /teams to move the conversation to, or null for no team.',
    ),
    addTags: conversationChange.addTags.describe(ADD_TAGS),
    removeTags: conversationChange.removeTags.describe(REMOVE_TAGS),
  })
  .strict()
  .refine(someChange, SOME_CHANGE);

/** The change many conversations get alike (ADR-120, ADR-166). */
const manyConversationsChange = {
  status: conversationChange.status.describe(
    '`resolved` to resolve the conversations, `open` to reopen them.',
  ),
  assigneeId: conversationChange.assigneeId.describe(
    'A member from GET /members to assign the conversations to, or null to unassign them.',
  ),
  teamId: conversationChange.teamId.describe(
    'A team from GET /teams to move the conversations to, or null for no team.',
  ),
  addTags: conversationChange.addTags.describe(ADD_TAGS),
  removeTags: conversationChange.removeTags.describe(REMOVE_TAGS),
};

/** The same change for up to 100 conversations at once (ADR-120), each named once. */
export const apiUpdateManyConversationsSchema = z
  .object({
    conversationIds: z
      .array(z.uuid({ error: 'Give the ids of conversations (GET /conversations).' }))
      .min(1, 'Give at least one conversation.')
      .max(
        API_LIMITS.conversationsPerChange,
        `Give at most ${API_LIMITS.conversationsPerChange} conversations.`,
      )
      .refine((ids) => new Set(ids).size === ids.length, 'Give each conversation once.')
      .describe(
        `The conversations to change, 1 to ${API_LIMITS.conversationsPerChange}, each once; they are changed in this order.`,
      ),
    ...manyConversationsChange,
  })
  .strict()
  .refine(someChange, SOME_CHANGE);

/**
 * Changing the conversations a filter finds, a page at a time (ADR-166): GET /conversations'
 * filters, at least one, the change each conversation of the page gets, and the page.
 */
export const apiUpdateMatchingConversationsSchema = z
  .object({
    filter: z
      .object(conversationFilters)
      .strict()
      .refine(
        (filter) => Object.values(filter).some((value) => value !== undefined),
        'Give at least one filter: status, contactId, channelId, assigneeId, teamId, updatedSince or tag.',
      )
      .describe(
        'The conversations to change, as GET /conversations filters them: at least one filter.',
      ),
    change: z
      .object(manyConversationsChange)
      .strict()
      .refine(someChange, SOME_CHANGE)
      .describe(
        'What each conversation of the page gets, as PATCH /conversations/{id} takes it: any of status, assigneeId, teamId, addTags and removeTags.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(API_LIMITS.conversationsPerChange)
      .default(50)
      .describe(
        `The conversations one call changes, at most ${API_LIMITS.conversationsPerChange}; a page can hold fewer.`,
      ),
    cursor: page.cursor,
  })
  .strict();

export interface ApiConversation {
  id: string;
  contactId: string;
  channelId: string;
  status: ConversationStatus;
  assigned: boolean;
  /** The member assigned (an id from GET /members; ADR-093). */
  assigneeId: string | null;
  teamId: string | null;
  /** The conversation's tags, alphabetically (ADR-221). */
  tags: string[];
  unreadCount: number;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  serviceWindowEndsAt: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export type ApiSentBy = 'agent' | 'bot' | 'campaign' | 'api' | 'system';

/** A note a key added to a conversation (ADR-084). */
export interface ApiConversationNote {
  id: string;
  conversationId: string;
  text: string;
  /** Written by a member in the inbox (agent, as messages say), or added through the API (ADR-089). */
  writtenBy: 'agent' | 'api';
  /** The key that added the note through the API, named in the inbox; null for members' notes. */
  apiKeyId: string | null;
  createdAt: string;
}

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
  /** The content was too large to keep (ADR-131, ADR-132); false for outbound messages. */
  contentTooLarge: boolean;
  /** How many contacts a contact card left out (ADR-131, ADR-132); 0 otherwise. */
  contactsLeftOut: number;
  /** The contacts a contact card shares (ADR-196); null for other messages. */
  contacts: ContactCard[] | null;
  templateId: string | null;
  templateName: string | null;
  sentBy: ApiSentBy | null;
  apiKeyId: string | null;
  status: MessageStatus;
  statusAt: string;
  error: { code: string | null; title: string | null } | null;
  createdAt: string;
}

/**
 * A message of the feed across conversations (ADR-088), with its conversation's contact and the
 * number it was received on or sent from.
 */
export interface ApiFeedMessage extends ApiConversationMessage {
  contactId: string;
  channelId: string;
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
  teamId: conversations.teamId,
  tags: conversationTagsOf(sql`${conversations.tenantId}`, sql`${conversations.id}`),
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
  teamId: string | null;
  tags: string[];
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
  assigneeId: r.assignedMembershipId,
  teamId: r.teamId,
  tags: r.tags,
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

/**
 * The conditions of a filter of GET /conversations on the company's conversations: the page read
 * and, when the conversations a filter finds are changed (ADR-166), the lock of the page's rows.
 */
export function conversationFilterSql(tenantId: string, filter: ConversationFilter): SQL[] {
  const conditions = [eq(conversations.tenantId, tenantId)];
  if (filter.status) conditions.push(eq(conversations.status, filter.status));
  if (filter.contactId) conditions.push(eq(conversations.contactId, filter.contactId));
  if (filter.channelId) conditions.push(eq(conversations.channelAccountId, filter.channelId));
  if (filter.assigneeId) {
    conditions.push(
      filter.assigneeId === 'none'
        ? isNull(conversations.assignedMembershipId)
        : eq(conversations.assignedMembershipId, filter.assigneeId),
    );
  }
  if (filter.teamId) {
    conditions.push(
      filter.teamId === 'none'
        ? isNull(conversations.teamId)
        : eq(conversations.teamId, filter.teamId),
    );
  }
  if (filter.updatedSince) {
    conditions.push(sql`${conversations.updatedAt} >= ${filter.updatedSince}::timestamptz`);
  }
  if (filter.tag !== undefined) {
    conditions.push(
      conversationHasTag(sql`${conversations.tenantId}`, sql`${conversations.id}`, filter.tag),
    );
  }
  return conditions;
}

/** A page of the conversations a filter finds, newest first, without erased contacts' ones. */
async function conversationPage(
  tx: Tx,
  tenantId: string,
  filter: ConversationFilter,
  limit: number,
  cursor: { at: string; id: string } | null,
) {
  const rows = await tx
    .select(conversationColumns)
    .from(conversations)
    .innerJoin(contacts, contactNotErased)
    .where(
      and(
        ...conversationFilterSql(tenantId, filter),
        cursor
          ? sql`(${conversations.createdAt}, ${conversations.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(conversations.createdAt), desc(conversations.id))
    .limit(limit + 1);
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return {
    rows: shown,
    nextCursor: rows.length > limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
  };
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
      const page = await conversationPage(tx, ctx.tenant.id, q, q.limit, cursor);
      return { data: page.rows.map(toApiConversation), nextCursor: page.nextCursor };
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

/** A message's columns as the API reads them, with the message it answers (ADR-082). */
const messageColumns = {
  id: messages.id,
  conversationId: messages.conversationId,
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
};

interface MessageRow {
  id: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  type: MessageType;
  content: Record<string, unknown>;
  status: MessageStatus;
  statusAt: Date;
  errorCode: string | null;
  errorTitle: string | null;
  senderType: string;
  templateId: string | null;
  apiKeyId: string | null;
  replyTo: string | null;
  createdAt: Date;
}

/** A stored message as the webhooks describe it: words, a tap, the sender; never media. */
function toApiMessage(m: MessageRow): ApiConversationMessage {
  const inbound = m.direction === 'inbound';
  const summary = inbound
    ? inboundSummary(m.type, m.content)
    : { text: outboundText(m.type, m.content), reply: null, mimeType: null };
  const omissions = inbound
    ? inboundOmissions(m.type, m.content)
    : { contentTooLarge: false, contactsLeftOut: 0 };
  const template = obj(m.content.template);
  return {
    id: m.id,
    conversationId: m.conversationId,
    direction: m.direction,
    type: m.type,
    text: summary.text,
    reply: summary.reply,
    replyTo: m.replyTo,
    mimeType: summary.mimeType,
    contentTooLarge: omissions.contentTooLarge,
    contactsLeftOut: omissions.contactsLeftOut,
    contacts: contactCards(m.type, m.content),
    templateId: m.templateId,
    templateName: m.type === 'template' ? str(template?.name) : null,
    sentBy: inbound ? null : sentBy(m.senderType),
    apiKeyId: m.apiKeyId,
    status: m.status,
    statusAt: m.statusAt.toISOString(),
    error: m.errorCode || m.errorTitle ? { code: m.errorCode, title: m.errorTitle } : null,
    createdAt: m.createdAt.toISOString(),
  };
}

/**
 * The columns of a feed message (ADR-088, ADR-116): a message's, with its conversation's contact and
 * the number it was received on or sent from. The query joins the message's conversation and
 * `answeredMessages`.
 */
export const feedMessageColumns = {
  ...messageColumns,
  contactId: conversations.contactId,
  channelId: messages.channelAccountId,
};

/** A message of a feed across conversations, as GET /messages gives it. */
export function toApiFeedMessage(
  m: MessageRow & { contactId: string; channelId: string },
): ApiFeedMessage {
  return { ...toApiMessage(m), contactId: m.contactId, channelId: m.channelId };
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
        .select(messageColumns)
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
        data: shown.map(toApiMessage),
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
 * A conversation's internal notes, newest first on exact keyset pages (ADR-089): what members wrote
 * in the inbox and what keys added through the API (ADR-084), each saying which, and for a key's
 * note which key; never which member wrote a note or whom it mentions. Erased contacts'
 * conversations are not found, as in every read (their notes went with the erasure).
 */
export async function apiListConversationNotes(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  conversationId: string,
  query: unknown,
): Promise<{ data: ApiConversationNote[]; nextCursor: string | null }> {
  assertScope(ctx, 'conversations.read');
  if (!z.uuid().safeParse(conversationId).success) throw notFound('Conversation');
  const q = parseInput(apiNoteListQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  const result = await deps.db.run(
    ctx.scope,
    async (tx) => {
      if (!(await visibleConversation(tx, ctx.tenant.id, conversationId))) return null;
      const rows = await tx
        .select({
          id: conversationNotes.id,
          body: conversationNotes.body,
          apiKeyId: conversationNotes.authorApiKeyId,
          createdAt: conversationNotes.createdAt,
          cursorAt: exactTimestamp(conversationNotes.createdAt),
        })
        .from(conversationNotes)
        .where(
          and(
            eq(conversationNotes.tenantId, ctx.tenant.id),
            eq(conversationNotes.conversationId, conversationId),
            cursor
              ? sql`(${conversationNotes.createdAt}, ${conversationNotes.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(conversationNotes.createdAt), desc(conversationNotes.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      const last = shown.at(-1);
      return {
        data: shown.map((n): ApiConversationNote => ({
          id: n.id,
          conversationId,
          text: n.body,
          writtenBy: n.apiKeyId ? 'api' : 'agent',
          apiKeyId: n.apiKeyId,
          createdAt: n.createdAt.toISOString(),
        })),
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
 * The most messages one page of the feed reads (ADR-088), whatever it shows: filters that leave out
 * most of a company's messages give short pages, never a scan of every message it has.
 */
export const API_MESSAGE_FEED_WINDOW = 2000;

/**
 * The company's messages across its conversations, newest first on exact keyset pages (ADR-088), as
 * a conversation's messages read (ADR-072), each with its conversation's contact and the number it
 * was received on or sent from. The conversations of erased contacts are left out; internal notes
 * are not messages. A page reads at most API_MESSAGE_FEED_WINDOW messages: when the filters leave out
 * most of them it shows fewer than the limit, or none, and its cursor continues after the last one
 * it read. Both reads see one snapshot.
 */
export async function apiListMessages(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiFeedMessage[]; nextCursor: string | null }> {
  assertScope(ctx, 'conversations.read');
  const q = parseInput(apiMessageFeedQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const range = and(
        eq(messages.tenantId, ctx.tenant.id),
        q.since ? sql`${messages.createdAt} >= ${q.since}::timestamptz` : undefined,
        cursor
          ? sql`(${messages.createdAt}, ${messages.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
          : undefined,
      );
      // The last message this page may read; none when fewer remain.
      const [edge] = await tx
        .select({ at: exactTimestamp(messages.createdAt), id: messages.id })
        .from(messages)
        .where(range)
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .offset(API_MESSAGE_FEED_WINDOW - 1)
        .limit(1);
      const rows = await tx
        .select(feedMessageColumns)
        .from(messages)
        .innerJoin(
          conversations,
          and(
            eq(conversations.tenantId, messages.tenantId),
            eq(conversations.id, messages.conversationId),
          ),
        )
        .innerJoin(contacts, contactNotErased)
        .leftJoin(answeredMessages, answeredJoin())
        .where(
          and(
            range,
            edge
              ? sql`(${messages.createdAt}, ${messages.id}) >= (${edge.at}::timestamptz, ${edge.id}::uuid)`
              : undefined,
            q.direction ? eq(messages.direction, q.direction) : undefined,
            q.channelId ? eq(messages.channelAccountId, q.channelId) : undefined,
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      const last = shown.at(-1);
      return {
        data: shown.map(toApiFeedMessage),
        nextCursor:
          rows.length > q.limit && last
            ? encodeKeysetCursor(last.cursorAt, last.id)
            : edge
              ? encodeKeysetCursor(edge.at, edge.id)
              : null,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** A refused assignee or team, named by the field that gave it (`change.teamId` in ADR-166). */
const invalidField = (path: string, message: string) =>
  new AppError('validation_failed', message, { issues: [{ path, message }] });
const INVALID_TEAM = 'Give the id of one of the company’s teams (GET /teams).';
const INVALID_ASSIGNEE = 'Give the id of a member who can answer conversations (GET /members).';

/** A change as changeLockedConversation applies it, with its tags as the app keeps them. */
type ConversationChange = Omit<
  z.infer<typeof apiUpdateConversationSchema>,
  'addTags' | 'removeTags'
> & { addTags: string[]; removeTags: string[] };

/**
 * Checks a change's tags before its transaction (ADR-221), as contacts' are checked: written as
 * tags are, each once, and never both added and removed. A refusal names `<place><field>`.
 */
function prepareConversationChange(
  data: z.infer<typeof apiUpdateConversationSchema>,
  place = '',
): ConversationChange {
  const addTags = apiTags(data.addTags ?? [], `${place}addTags`);
  const removeTags = apiTags(data.removeTags ?? [], `${place}removeTags`);
  const both = addTags.find((tag) => removeTags.includes(tag));
  if (both) {
    throw invalidField(`${place}removeTags`, `The tag ${both} cannot be both added and removed.`);
  }
  return { ...data, addTags, removeTags };
}

/** A conversation's row as a change locks it. */
interface LockedConversation {
  status: ConversationStatus;
  assignedMembershipId: string | null;
  teamId: string | null;
}

/**
 * Changes a conversation whose row the caller has locked, as the inbox's controls do: its team, then
 * its assignee (ADR-093), then its status (ADR-075), then its tags (ADR-221).
 * - A team must be the company's, and an assignee a member who can answer conversations (the members
 *   GET /members lists); both rows are locked while the change is written, so a member suspended or a
 *   team deleted at the same time is refused, or releases the conversation once this commits.
 * - Assigning a member ends an automation answering the conversation, as a member's assignment does.
 *   Moving it to a team then routes it when it has no member and is not resolved, as the inbox's
 *   team control does. Unassigning alone leaves it to routing's minute sweep, as in the inbox.
 * - Resolving stops an automation answering the conversation; the triggers close the waiting reply
 *   turn and the case, open a new case on reopening and capture the webhook events.
 * The key is the audit actor, so per-member report counts leave the change out, and no satisfaction
 * survey is sent (surveys follow a member's resolve, ADR-032).
 * - Tags are added and removed as members do in the inbox (ADR-220), at most 20 on a conversation,
 *   counted under the conversation's lock; a change of its tags is a change of the conversation
 *   (`updatedAt`, a live event and an audit entry with the counts, never the tags).
 * What the conversation already has changes nothing, so a retried request does no harm. A refused
 * field is named after `place`, the object holding the change in the body (`change.` for ADR-166).
 */
async function changeLockedConversation(
  tx: Tx,
  ctx: ApiContext,
  conversationId: string,
  current: LockedConversation,
  data: ConversationChange,
  now: Date,
  place = '',
): Promise<void> {
  const thisConversation = and(
    eq(conversations.tenantId, ctx.tenant.id),
    eq(conversations.id, conversationId),
  );
  const audit = (action: string, metadata: Record<string, unknown>) =>
    recordSystemAudit(
      tx,
      ctx.tenant.id,
      {
        action,
        subjectType: 'conversation',
        subjectId: conversationId,
        correlationId: ctx.requestId,
        metadata: { ...metadata, source: 'api' },
      },
      apiActor(ctx),
    );

  const moved = data.teamId !== undefined && data.teamId !== current.teamId;
  if (moved) {
    if (data.teamId && !(await lockTeam(tx, ctx.tenant.id, data.teamId))) {
      throw invalidField(`${place}teamId`, INVALID_TEAM);
    }
    await tx
      .update(conversations)
      .set({ teamId: data.teamId, version: sql`${conversations.version} + 1` })
      .where(thisConversation);
    await emitTenantEvent(tx, ctx.tenant.id, {
      type: 'conversation.team',
      conversationId,
      assignedMembershipId: current.assignedMembershipId,
      payload: { teamId: data.teamId },
    });
    await audit('conversation.team_changed', { from: current.teamId, to: data.teamId });
  }

  let assignee = current.assignedMembershipId;
  if (data.assigneeId !== undefined && data.assigneeId !== current.assignedMembershipId) {
    if (data.assigneeId) {
      if (!(await lockAssignableMember(tx, ctx.tenant.id, data.assigneeId))) {
        throw invalidField(`${place}assigneeId`, INVALID_ASSIGNEE);
      }
      await endRunForHuman(tx, {
        tenantId: ctx.tenant.id,
        conversationId,
        reason: 'assigned',
        actorMembershipId: null,
        assigneeMembershipId: data.assigneeId,
        now,
      });
    }
    await tx
      .update(conversations)
      .set({ assignedMembershipId: data.assigneeId, version: sql`${conversations.version} + 1` })
      .where(thisConversation);
    await emitTenantEvent(tx, ctx.tenant.id, {
      type: 'conversation.assigned',
      conversationId,
      assignedMembershipId: data.assigneeId,
      payload: { previous: current.assignedMembershipId },
    });
    await audit('conversation.assigned', {
      from: current.assignedMembershipId,
      to: data.assigneeId,
    });
    assignee = data.assigneeId;
  }

  if (data.status !== undefined && data.status !== current.status) {
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
      .where(thisConversation);
    await emitTenantEvent(tx, ctx.tenant.id, {
      type: 'conversation.status',
      conversationId,
      assignedMembershipId: assignee,
      payload: { status: data.status },
    });
    await audit('conversation.status_changed', { from: current.status, to: data.status });
  }

  if (data.addTags.length > 0 || data.removeTags.length > 0) {
    const existing = (
      await tx
        .select({ tag: conversationTags.tag })
        .from(conversationTags)
        .where(
          and(
            eq(conversationTags.tenantId, ctx.tenant.id),
            eq(conversationTags.conversationId, conversationId),
          ),
        )
    ).map((row) => row.tag);
    const added = data.addTags.filter((tag) => !existing.includes(tag));
    const removed = data.removeTags.filter((tag) => existing.includes(tag));
    const total = existing.length + added.length - removed.length;
    if (total > MAX_TAGS_PER_CONVERSATION) {
      throw invalidField(
        `${place}addTags`,
        `A conversation can have at most ${MAX_TAGS_PER_CONVERSATION} tags; conversation ${conversationId} would have ${total}.`,
      );
    }
    if (added.length > 0) {
      await tx
        .insert(conversationTags)
        .values(
          added.map((tag) => ({ id: uuidv7(), tenantId: ctx.tenant.id, conversationId, tag })),
        );
    }
    if (removed.length > 0) {
      await tx
        .delete(conversationTags)
        .where(
          and(
            eq(conversationTags.tenantId, ctx.tenant.id),
            eq(conversationTags.conversationId, conversationId),
            inArray(conversationTags.tag, removed),
          ),
        );
    }
    if (added.length > 0 || removed.length > 0) {
      await tx
        .update(conversations)
        .set({ updatedAt: sql`now()` })
        .where(thisConversation);
      await emitTenantEvent(tx, ctx.tenant.id, {
        type: 'conversation.tags',
        conversationId,
        assignedMembershipId: assignee,
      });
      await audit('conversation.tags_changed', { added: added.length, removed: removed.length });
    }
  }

  // Routing leaves a resolved or assigned conversation, and one an automation answers, as it is.
  if (moved && data.teamId) {
    await routeConversation(tx, ctx.tenant.id, conversationId, { newCase: false, text: null });
  }
}

const lockedColumns = {
  id: conversations.id,
  status: conversations.status,
  assignedMembershipId: conversations.assignedMembershipId,
  teamId: conversations.teamId,
};

/**
 * Changes a conversation (ADR-075, ADR-093) in one transaction with its row locked like a member's
 * change; see changeLockedConversation.
 */
export async function apiUpdateConversation(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  conversationId: string,
  input: unknown,
): Promise<ApiConversation> {
  assertScope(ctx, 'conversations.write');
  if (!z.uuid().safeParse(conversationId).success) throw notFound('Conversation');
  const data = prepareConversationChange(parseInput(apiUpdateConversationSchema, input));
  const row = await deps.db.run(ctx.scope, async (tx) => {
    const [current] = await tx
      .select(lockedColumns)
      .from(conversations)
      .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversationId)))
      .for('update');
    if (!current || !(await visibleConversation(tx, ctx.tenant.id, conversationId))) return null;
    await changeLockedConversation(tx, ctx, conversationId, current, data, deps.clock.now());
    return visibleConversation(tx, ctx.tenant.id, conversationId);
  });
  if (!row) throw notFound('Conversation');
  return toApiConversation(row);
}

/** The conversations among `ids` whose contacts are not erased, by id. */
async function visibleConversations(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, ConversationRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select(conversationColumns)
    .from(conversations)
    .innerJoin(contacts, contactNotErased)
    .where(and(eq(conversations.tenantId, tenantId), inArray(conversations.id, [...ids])));
  return new Map(rows.map((row) => [row.id, row]));
}

/** A conversation id that names none of the company's conversations, by its place in the list. */
const unknownConversation = (index: number) => {
  const message = 'Give the id of one of the company’s conversations (GET /conversations).';
  return new AppError('validation_failed', message, {
    issues: [{ path: `conversationIds.${index}`, message }],
  });
};

/**
 * Changes up to 100 conversations at once (ADR-120), each exactly as PATCH changes one, in one
 * transaction: all of them or none. Locks are taken in the order the other writers take them: the
 * member first (a suspension locks the member, then releases its conversations), then every
 * conversation's row in id order, so calls changing the same conversations take turns instead of
 * deadlocking, and the team only as a conversation moves into it (a team's deletion releases its
 * conversations, then deletes the team). An id that names none of the company's conversations
 * (another company's, or an erased contact's, included) refuses the call, naming its place in the
 * list. The conversations are changed in the order given, which routing into a round-robin team
 * follows, and answered in it.
 */
export async function apiUpdateManyConversations(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  input: unknown,
): Promise<ApiConversation[]> {
  assertScope(ctx, 'conversations.write');
  const data = parseInput(apiUpdateManyConversationsSchema, input);
  const change = prepareConversationChange(data);
  const ids = data.conversationIds;
  const rows = await deps.db.run(ctx.scope, async (tx) => {
    if (data.assigneeId && !(await lockAssignableMember(tx, ctx.tenant.id, data.assigneeId))) {
      throw invalidField('assigneeId', INVALID_ASSIGNEE);
    }
    const locked = new Map(
      (
        await tx
          .select(lockedColumns)
          .from(conversations)
          .where(and(eq(conversations.tenantId, ctx.tenant.id), inArray(conversations.id, ids)))
          .orderBy(asc(conversations.id))
          .for('update')
      ).map((row) => [row.id, row]),
    );
    const visible = () => visibleConversations(tx, ctx.tenant.id, ids);
    const before = await visible();
    const changes = ids.map((id, index) => {
      const current = locked.get(id);
      if (!current || !before.has(id)) throw unknownConversation(index);
      return { id, current };
    });
    const now = deps.clock.now();
    for (const { id, current } of changes) {
      await changeLockedConversation(tx, ctx, id, current, change, now);
    }
    const after = await visible();
    return ids.map((id) => {
      const row = after.get(id);
      if (!row) throw new Error('A conversation locked for a change is no longer shown');
      return row;
    });
  });
  return rows.map(toApiConversation);
}

/** Whether the team is the company's, read without locking it: teams are locked after conversations. */
async function isCompanyTeam(tx: Tx, tenantId: string, teamId: string): Promise<boolean> {
  const [team] = await tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.tenantId, tenantId), eq(teams.id, teamId)));
  return team !== undefined;
}

/**
 * Changes the conversations a filter of GET /conversations finds, a page at a time (ADR-166): the
 * page is read as GET /conversations reads it and each of its conversations changed as PATCH changes
 * one, in the order read, with the locks changing many conversations takes (ADR-120): the member
 * first, then the page's rows in id order, the team as a conversation moves into it.
 * - The rows are locked with the filter again, so a conversation someone else took out of the filter
 *   after the page was read is left out instead of being changed, and one that still matches is
 *   changed as it now is. Read committed, as every change of a conversation, since routing counts
 *   members' conversations once it holds its lock: a snapshot taken before would miss some.
 * - A member who cannot answer conversations or a team that is not the company's refuses the call
 *   before the page is read, even when nothing on it would change.
 * Needs `conversations.read` and `conversations.write`. What a conversation already has changes
 * nothing, and one the change took out of the filter is not found again, so a call sent again after
 * a lost answer is safe: the pages still reach every conversation the filter finds, each changed once.
 */
export async function apiUpdateMatchingConversations(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  input: unknown,
): Promise<{ data: ApiConversation[]; nextCursor: string | null }> {
  assertScope(ctx, 'conversations.read');
  assertScope(ctx, 'conversations.write');
  const {
    filter,
    change,
    limit,
    cursor: after,
  } = parseInput(apiUpdateMatchingConversationsSchema, input);
  const cursor = decodeKeysetCursor(after);
  const prepared = prepareConversationChange(change, 'change.');
  return deps.db.run(ctx.scope, async (tx) => {
    if (change.assigneeId && !(await lockAssignableMember(tx, ctx.tenant.id, change.assigneeId))) {
      throw invalidField('change.assigneeId', INVALID_ASSIGNEE);
    }
    if (change.teamId && !(await isCompanyTeam(tx, ctx.tenant.id, change.teamId))) {
      throw invalidField('change.teamId', INVALID_TEAM);
    }
    const page = await conversationPage(tx, ctx.tenant.id, filter, limit, cursor);
    const ids = page.rows.map((row) => row.id);
    if (ids.length === 0) return { data: [], nextCursor: page.nextCursor };
    const locked = new Map(
      (
        await tx
          .select(lockedColumns)
          .from(conversations)
          .where(
            and(...conversationFilterSql(ctx.tenant.id, filter), inArray(conversations.id, ids)),
          )
          .orderBy(asc(conversations.id))
          .for('update')
      ).map((row) => [row.id, row]),
    );
    const shown = await visibleConversations(tx, ctx.tenant.id, [...locked.keys()]);
    const changes = ids.flatMap((id) => {
      const current = locked.get(id);
      return current && shown.has(id) ? [{ id, current }] : [];
    });
    const now = deps.clock.now();
    for (const { id, current } of changes) {
      await changeLockedConversation(tx, ctx, id, current, prepared, now, 'change.');
    }
    const changed = await visibleConversations(
      tx,
      ctx.tenant.id,
      changes.map(({ id }) => id),
    );
    return {
      data: changes.map(({ id }) => {
        const row = changed.get(id);
        if (!row) throw new Error('A conversation locked for a change is no longer shown');
        return toApiConversation(row);
      }),
      nextCursor: page.nextCursor,
    };
  });
}

/**
 * Adds an internal note to a conversation (ADR-084), once per `Idempotency-Key`: the team reads it
 * in the inbox, named as the key's, and WhatsApp never receives it. The conversation's row is locked
 * first, as erasure locks it before deleting the contact's notes, so a note cannot outlive an erasure
 * that runs at the same time. Nothing else changes: the status, the assignee, the unread count and
 * the wait for a reply stay as they are.
 */
export async function apiAddConversationNote(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  conversationId: string,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertScope(ctx, 'conversations.write');
  if (!z.uuid().safeParse(conversationId).success) throw notFound('Conversation');
  const data = parseInput(apiAddNoteSchema, input);
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, (tx) =>
    idempotent(tx, ctx, idempotency, now, async () => {
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversationId)))
        .for('update');
      const conversation = await visibleConversation(tx, ctx.tenant.id, conversationId);
      if (!conversation) throw notFound('Conversation');
      const id = uuidv7();
      await tx.insert(conversationNotes).values({
        id,
        tenantId: ctx.tenant.id,
        conversationId,
        authorApiKeyId: ctx.key.id,
        body: data.text,
        createdAt: now,
      });
      await emitTenantEvent(tx, ctx.tenant.id, {
        type: 'conversation.note',
        conversationId,
        assignedMembershipId: conversation.assignedMembershipId,
      });
      const body: ApiConversationNote = {
        id,
        conversationId,
        text: data.text,
        writtenBy: 'api',
        apiKeyId: ctx.key.id,
        createdAt: now.toISOString(),
      };
      return { status: 201, body: { data: body } };
    }),
  );
}
