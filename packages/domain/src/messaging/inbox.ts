import { z } from 'zod';
import { AppError, forbidden, notFound, uuidv7, type Clock } from '@w360/core';
import {
  and,
  apiKeys,
  asc,
  campaigns,
  channelAccounts,
  contactIdentities,
  contacts,
  conversationNotes,
  conversations,
  conversationTags,
  conversationTurns,
  desc,
  eq,
  exactTimestamp,
  inArray,
  isNull,
  lt,
  memberships,
  messages,
  messagingSettings,
  noteMentions,
  or,
  sql,
  teams,
  users,
  type Database,
  type SQL,
  type TenantRole,
  type Tx,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { seesNumbers, shownNumber } from '../contacts/number-masking';
import { ROLE_PERMISSIONS, type Permission } from '../authz/permissions';
import { recordAudit, type RequestMeta } from '../audit';
import { DEFAULT_MESSAGING_SETTINGS } from '../consent/service';
import { endRunForHuman } from '../automations/runs';
import { automationStateForConversation } from '../automations/service';
import { latestConversationSource } from '../growth/sources';
import { conversationHasTag, conversationTagsOf } from '../inbox/conversation-tags';
import { latestCsatSurvey, queueCsatSurvey } from '../inbox/csat';
import { queueReadReceipt } from '../inbox/read-receipts';
import { MENTION_EMAIL_DELAY_MS, scheduleMentionEmail } from '../inbox/mention-emails';
import {
  INBOX_WORKER_ROLES,
  lockAssignableMember,
  lockTeam,
  routeConversation,
} from '../inbox/routing';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { WAITING_REPLY_LIMIT, type WaitingReply } from '../inbox/overdue-notice';
import { loadReplyTarget, replyDueAt, replyTimer, type ReplyTarget } from '../inbox/sla';
import { decodeKeysetCursor, encodeKeysetCursor, likePattern } from '../validation';
import { emitTenantEvent } from './events';
import { messageSnippet } from './message-text';
import { NOTE_MAX_LENGTH } from './notes';
import { SERVICE_WINDOW_MS, canSeeConversation } from './outbound';
import { transcriptEntry, transcriptHeader } from './transcript';
import { answeredJoin, answeredMessages } from './reply-context';

/**
 * Shared inbox queries and commands. Visibility: `inbox.read_all` sees every conversation;
 * `inbox.read_assigned` sees conversations assigned to the member plus the unassigned queue.
 * Teams and routing decide who receives conversations, never who may read them.
 * Assignment, team and status changes use optimistic concurrency (conversation `version`) so two
 * agents can never silently overwrite each other.
 */
export const listConversationsSchema = z.object({
  view: z.enum(['mine', 'unassigned', 'all']).default('all'),
  status: z.enum(['open', 'resolved']).default('open'),
  /** A team id, or 'none' for conversations without a team. */
  team: z.union([z.uuid(), z.literal('none')]).optional(),
  channel: z.uuid().optional(),
  /** Conversations with this tag (ADR-220), as a member typed it. */
  tag: z.string().trim().max(100).optional(),
  /** Contact name, or at least three digits of the phone number. */
  q: z.string().trim().max(100).optional(),
  /** 'waiting': conversations whose customer awaits a reply, longest wait first. */
  order: z.enum(['recent', 'waiting']).default('recent'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListConversationsInput = z.input<typeof listConversationsSchema>;

export const assignSchema = z.object({
  conversationId: z.uuid(),
  membershipId: z.uuid().nullable(),
  expectedVersion: z.number().int().min(0),
});

export const statusSchema = z.object({
  conversationId: z.uuid(),
  status: z.enum(['open', 'resolved']),
  expectedVersion: z.number().int().min(0),
});

export const conversationTeamSchema = z.object({
  conversationId: z.uuid(),
  teamId: z.uuid().nullable(),
  expectedVersion: z.number().int().min(0),
});

/** Minutes within which the company aims to answer a waiting customer; null clears it. */
export const responseTargetSchema = z.object({
  minutes: z.coerce
    .number()
    .int('Enter whole minutes.')
    .min(1, 'Enter at least 1 minute.')
    .max(1440, 'Enter at most 1440 minutes (24 hours).')
    .nullable(),
});

export const noteSchema = z.object({
  conversationId: z.uuid(),
  body: z.string().trim().min(1, 'Write a note').max(NOTE_MAX_LENGTH),
  /** Members to notify; each must be able to see the conversation. */
  mentionIds: z.array(z.uuid()).max(20).default([]),
});

export interface ConversationSummary {
  id: string;
  status: 'open' | 'pending' | 'resolved';
  contactName: string | null;
  contactPhone: string | null;
  channelName: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  assignedMembershipId: string | null;
  assignedName: string | null;
  teamId: string | null;
  teamName: string | null;
  /** The conversation's tags, alphabetically (ADR-220). */
  tags: string[];
  windowOpen: boolean;
  /** Start of the open reply turn (the customer is waiting), if any. */
  waitingSince: string | null;
  /** When the reply is due under the first-response target (null: no target or not waiting). */
  replyDueAt: string | null;
  overdue: boolean;
  /** Business hours are on and the business is closed: when the reply timer resumes. */
  timerPausedUntil: string | null;
  /** An automation is handling the conversation (nobody waits for a member meanwhile). */
  automationActive: boolean;
  version: number;
}

function rolesWith(permission: Permission): TenantRole[] {
  return (Object.keys(ROLE_PERMISSIONS) as TenantRole[]).filter((r) =>
    ROLE_PERMISSIONS[r].has(permission),
  );
}
const READ_ALL_ROLES = rolesWith('inbox.read_all');
const READ_ASSIGNED_ROLES = rolesWith('inbox.read_assigned');

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError('validation_failed', result.error.issues[0]?.message ?? 'Invalid input', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

function encodeCursor(at: Date | null, id: string): string {
  return Buffer.from(`${at ? at.toISOString() : ''}|${id}`).toString('base64url');
}

function decodeCursor(value: string | undefined): { at: Date | null; id: string } | null {
  if (!value) return null;
  const [at, id] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (!id || !/^[0-9a-f-]{36}$/.test(id))
    throw new AppError('validation_failed', 'Invalid cursor.');
  const date = at ? new Date(at) : null;
  if (date && Number.isNaN(date.getTime()))
    throw new AppError('validation_failed', 'Invalid cursor.');
  return { at: date, id };
}

function timerFields(target: ReplyTarget, waitingSince: Date | null, now: Date) {
  if (!waitingSince) {
    return { waitingSince: null, replyDueAt: null, overdue: false, timerPausedUntil: null };
  }
  const timer = replyTimer(target, waitingSince, now);
  return {
    waitingSince: waitingSince.toISOString(),
    replyDueAt: timer.dueAt?.toISOString() ?? null,
    overdue: timer.overdue,
    timerPausedUntil: timer.pausedUntil?.toISOString() ?? null,
  };
}

/**
 * SQL condition: the member `membershipId` (with `rolesColumn`) can see the conversation whose
 * assignee is `assigneeColumn`. Mirrors canSeeConversation for another member.
 */
export function memberCanSee(rolesColumn: SQL, membershipIdColumn: SQL, assigneeColumn: SQL): SQL {
  return sql`(${rolesColumn} && ${sql.param(READ_ALL_ROLES)}::text[]
    or (${rolesColumn} && ${sql.param(READ_ASSIGNED_ROLES)}::text[]
        and (${assigneeColumn} is null or ${assigneeColumn} = ${membershipIdColumn})))`;
}

export interface InboxDeps {
  db: Database;
  clock: Clock;
  /**
   * Needed to send CSAT surveys when a company turns them on, and to email members mentioned in a
   * note who have not opened it (ADR-211).
   */
  jobs?: JobQueue;
  signer?: JobSigner;
}

export function createInboxService(deps: InboxDeps) {
  const { db, clock } = deps;
  const csatDeps =
    deps.jobs && deps.signer ? { jobs: deps.jobs, signer: deps.signer, clock } : null;
  const mentionDeps = deps.jobs && deps.signer ? { jobs: deps.jobs, signer: deps.signer } : null;
  const receiptDeps = mentionDeps;

  function visibilityFilter(ctx: TenantContext): SQL | undefined {
    if (can(ctx, 'inbox.read_all')) return undefined;
    return or(
      eq(conversations.assignedMembershipId, ctx.membership.id),
      isNull(conversations.assignedMembershipId),
    );
  }

  /**
   * Runs a command against one conversation inside a single transaction, holding a row lock so the
   * visibility and permission checks see the same state the update writes over.
   */
  async function withConversation<T>(
    ctx: TenantContext,
    conversationId: string,
    fn: (
      tx: Tx,
      current: {
        id: string;
        version: number;
        assignedMembershipId: string | null;
        status: string;
        teamId: string | null;
      },
    ) => Promise<T>,
  ): Promise<T> {
    if (!z.uuid().safeParse(conversationId).success) throw notFound('Conversation');
    return db.run(ctx.scope, async (tx) => {
      const [row] = await tx
        .select({
          id: conversations.id,
          version: conversations.version,
          assignedMembershipId: conversations.assignedMembershipId,
          status: conversations.status,
          teamId: conversations.teamId,
        })
        .from(conversations)
        .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversationId)))
        .for('update');
      if (!row || !canSeeConversation(ctx, row.assignedMembershipId))
        throw notFound('Conversation');
      return fn(tx, row);
    });
  }

  const staleVersion = () =>
    new AppError(
      'conflict',
      'Someone else changed this conversation. Review the latest state and try again.',
    );

  return {
    async listConversations(ctx: TenantContext, input: unknown) {
      if (!can(ctx, 'inbox.read_all') && !can(ctx, 'inbox.read_assigned'))
        assertCan(ctx, 'inbox.read_assigned');
      const q = parse(listConversationsSchema, input ?? {});
      const cursor = decodeCursor(q.cursor);
      const waitingOrder = q.order === 'waiting' && q.status === 'open';
      const now = clock.now();
      const search = q.q?.trim();
      const digits = search?.replace(/[\s()+\-.]/g, '') ?? '';
      // A member who sees numbers masked finds a conversation by the whole number only (ADR-226).
      const searchCondition = search
        ? /^[0-9]{3,15}$/.test(digits)
          ? seesNumbers(ctx)
            ? sql`${contacts.phoneE164} like ${likePattern(digits)}`
            : eq(contacts.phoneE164, `+${digits}`)
          : sql`${contacts.displayName} ilike ${likePattern(search)}`
        : undefined;
      // Turn start times carry microseconds but cursors carry milliseconds: order and page the
      // waiting view on the millisecond so a page boundary never repeats or skips a row.
      const waitingSince = sql<Date>`date_trunc('milliseconds', ${conversationTurns.startedAt})`;
      let cursorCondition: SQL | undefined;
      if (cursor && waitingOrder) {
        if (!cursor.at) throw new AppError('validation_failed', 'Invalid cursor.');
        const at = cursor.at.toISOString();
        cursorCondition = sql`(${waitingSince} > ${at}::timestamptz
          or (${waitingSince} = ${at}::timestamptz and ${conversations.id} > ${cursor.id}::uuid))`;
      } else if (cursor) {
        cursorCondition = cursor.at
          ? or(
              lt(conversations.lastMessageAt, cursor.at),
              and(eq(conversations.lastMessageAt, cursor.at), lt(conversations.id, cursor.id)),
              isNull(conversations.lastMessageAt),
            )
          : and(isNull(conversations.lastMessageAt), lt(conversations.id, cursor.id));
      }
      const { rows, target } = await db.run(
        ctx.scope,
        async (tx) => {
          const target = await loadReplyTarget(tx, ctx.tenant.id, ctx.tenant.timezone);
          const rows = await tx
            .select({
              id: conversations.id,
              status: conversations.status,
              contactName: contacts.displayName,
              contactPhone: contacts.phoneE164,
              channelName: channelAccounts.displayPhoneNumber,
              lastMessageAt: conversations.lastMessageAt,
              lastMessagePreview: conversations.lastMessagePreview,
              unreadCount: conversations.unreadCount,
              assignedMembershipId: conversations.assignedMembershipId,
              assignedName: users.name,
              teamId: conversations.teamId,
              teamName: teams.name,
              tags: conversationTagsOf(sql`${conversations.tenantId}`, sql`${conversations.id}`),
              lastInboundAt: conversations.lastInboundAt,
              waitingSince: conversationTurns.startedAt,
              automationActive: sql<boolean>`exists (select 1 from app.automation_runs r
                 where r.tenant_id = ${conversations.tenantId} and r.conversation_id = ${conversations.id}
                   and r.status in ('running', 'waiting'))`,
              version: conversations.version,
            })
            .from(conversations)
            .innerJoin(
              contacts,
              and(
                eq(contacts.tenantId, conversations.tenantId),
                eq(contacts.id, conversations.contactId),
              ),
            )
            .innerJoin(
              channelAccounts,
              and(
                eq(channelAccounts.tenantId, conversations.tenantId),
                eq(channelAccounts.id, conversations.channelAccountId),
              ),
            )
            .leftJoin(
              memberships,
              and(
                eq(memberships.tenantId, conversations.tenantId),
                eq(memberships.id, conversations.assignedMembershipId),
              ),
            )
            .leftJoin(users, eq(users.id, memberships.userId))
            .leftJoin(
              teams,
              and(eq(teams.tenantId, conversations.tenantId), eq(teams.id, conversations.teamId)),
            )
            // At most one open turn per conversation (unique partial index), so no duplicates.
            .leftJoin(
              conversationTurns,
              and(
                eq(conversationTurns.tenantId, conversations.tenantId),
                eq(conversationTurns.conversationId, conversations.id),
                isNull(conversationTurns.endedAt),
              ),
            )
            .where(
              and(
                eq(conversations.tenantId, ctx.tenant.id),
                q.status === 'open'
                  ? or(eq(conversations.status, 'open'), eq(conversations.status, 'pending'))
                  : eq(conversations.status, 'resolved'),
                q.view === 'mine'
                  ? eq(conversations.assignedMembershipId, ctx.membership.id)
                  : undefined,
                q.view === 'unassigned' ? isNull(conversations.assignedMembershipId) : undefined,
                q.team === 'none'
                  ? isNull(conversations.teamId)
                  : q.team
                    ? eq(conversations.teamId, q.team)
                    : undefined,
                q.channel ? eq(conversations.channelAccountId, q.channel) : undefined,
                q.tag
                  ? conversationHasTag(
                      sql`${conversations.tenantId}`,
                      sql`${conversations.id}`,
                      q.tag,
                    )
                  : undefined,
                searchCondition,
                waitingOrder ? sql`${conversationTurns.id} is not null` : undefined,
                visibilityFilter(ctx),
                cursorCondition,
              ),
            )
            .orderBy(
              ...(waitingOrder
                ? [asc(waitingSince), asc(conversations.id)]
                : [sql`${conversations.lastMessageAt} desc nulls last`, desc(conversations.id)]),
            )
            .limit(q.limit + 1);
          return { rows, target };
        },
        { accessMode: 'read only' },
      );
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      const items: ConversationSummary[] = page.map((r) => ({
        id: r.id,
        status: r.status,
        contactName: r.contactName,
        contactPhone: shownNumber(ctx, r.contactPhone),
        channelName: r.channelName,
        lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
        lastMessagePreview: r.lastMessagePreview,
        unreadCount: r.unreadCount,
        assignedMembershipId: r.assignedMembershipId,
        assignedName: r.assignedName,
        teamId: r.teamId,
        teamName: r.teamName,
        tags: r.tags,
        windowOpen: Boolean(
          r.lastInboundAt && now.getTime() - r.lastInboundAt.getTime() <= SERVICE_WINDOW_MS,
        ),
        ...timerFields(target, r.status === 'resolved' ? null : r.waitingSince, now),
        automationActive: r.automationActive,
        version: r.version,
      }));
      return {
        items,
        nextCursor:
          rows.length > q.limit && last
            ? waitingOrder
              ? encodeCursor(last.waitingSince, last.id)
              : encodeCursor(last.lastMessageAt, last.id)
            : null,
      };
    },

    async getConversation(ctx: TenantContext, conversationId: string, before?: string) {
      if (!z.uuid().safeParse(conversationId).success) throw notFound('Conversation');
      const beforeCursor = decodeKeysetCursor(before);
      const now = clock.now();
      return db.run(
        ctx.scope,
        async (tx) => {
          const [conv] = await tx
            .select({
              id: conversations.id,
              status: conversations.status,
              version: conversations.version,
              assignedMembershipId: conversations.assignedMembershipId,
              teamId: conversations.teamId,
              teamName: teams.name,
              lastInboundAt: conversations.lastInboundAt,
              channelAccountId: conversations.channelAccountId,
              contactId: contacts.id,
              contactName: contacts.displayName,
              contactPhone: contacts.phoneE164,
              channelName: channelAccounts.displayPhoneNumber,
              channelStatus: channelAccounts.status,
              whatsappAccountId: channelAccounts.whatsappAccountId,
            })
            .from(conversations)
            .innerJoin(
              contacts,
              and(
                eq(contacts.tenantId, conversations.tenantId),
                eq(contacts.id, conversations.contactId),
              ),
            )
            .innerJoin(
              channelAccounts,
              and(
                eq(channelAccounts.tenantId, conversations.tenantId),
                eq(channelAccounts.id, conversations.channelAccountId),
              ),
            )
            .leftJoin(
              teams,
              and(eq(teams.tenantId, conversations.tenantId), eq(teams.id, conversations.teamId)),
            )
            .where(
              and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversationId)),
            );
          if (!conv || !canSeeConversation(ctx, conv.assignedMembershipId))
            throw notFound('Conversation');
          const [identity] = await tx
            .select({
              waId: contactIdentities.waId,
              bsuid: contactIdentities.bsuid,
              profileName: contactIdentities.profileName,
            })
            .from(contactIdentities)
            .where(
              and(
                eq(contactIdentities.tenantId, ctx.tenant.id),
                eq(contactIdentities.contactId, conv.contactId),
                eq(contactIdentities.whatsappAccountId, conv.whatsappAccountId),
              ),
            )
            .limit(1);
          const pageSize = 50;
          const rows = await tx
            .select({
              id: messages.id,
              direction: messages.direction,
              type: messages.type,
              content: messages.content,
              status: messages.status,
              errorCode: messages.errorCode,
              errorTitle: messages.errorTitle,
              senderType: messages.senderType,
              senderMembershipId: messages.senderMembershipId,
              senderName: users.name,
              apiKeyName: apiKeys.name,
              createdAt: messages.createdAt,
              providerTimestamp: messages.providerTimestamp,
              cursorAt: exactTimestamp(messages.createdAt),
              answeredId: answeredMessages.id,
              answeredDirection: answeredMessages.direction,
              answeredType: answeredMessages.type,
              answeredContent: answeredMessages.content,
            })
            .from(messages)
            .leftJoin(answeredMessages, answeredJoin())
            .leftJoin(
              memberships,
              and(
                eq(memberships.tenantId, messages.tenantId),
                eq(memberships.id, messages.senderMembershipId),
              ),
            )
            .leftJoin(users, eq(users.id, memberships.userId))
            .leftJoin(
              apiKeys,
              and(eq(apiKeys.tenantId, messages.tenantId), eq(apiKeys.id, messages.apiKeyId)),
            )
            .where(
              and(
                eq(messages.tenantId, ctx.tenant.id),
                eq(messages.conversationId, conversationId),
                beforeCursor
                  ? sql`(${messages.createdAt}, ${messages.id}) < (${beforeCursor.at}::timestamptz, ${beforeCursor.id}::uuid)`
                  : undefined,
              ),
            )
            .orderBy(desc(messages.createdAt), desc(messages.id))
            .limit(pageSize + 1);
          // A note's author is a member, or an API key for notes added through the API (ADR-084).
          const notes = await tx
            .select({
              id: conversationNotes.id,
              body: conversationNotes.body,
              createdAt: conversationNotes.createdAt,
              authorName: users.name,
              apiKeyName: apiKeys.name,
            })
            .from(conversationNotes)
            .leftJoin(
              memberships,
              and(
                eq(memberships.tenantId, conversationNotes.tenantId),
                eq(memberships.id, conversationNotes.authorMembershipId),
              ),
            )
            .leftJoin(users, eq(users.id, memberships.userId))
            .leftJoin(
              apiKeys,
              and(
                eq(apiKeys.tenantId, conversationNotes.tenantId),
                eq(apiKeys.id, conversationNotes.authorApiKeyId),
              ),
            )
            .where(
              and(
                eq(conversationNotes.tenantId, ctx.tenant.id),
                eq(conversationNotes.conversationId, conversationId),
              ),
            )
            .orderBy(asc(conversationNotes.createdAt))
            .limit(200);
          const mentioned =
            notes.length === 0
              ? []
              : await tx
                  .select({
                    noteId: noteMentions.noteId,
                    membershipId: noteMentions.membershipId,
                    name: users.name,
                  })
                  .from(noteMentions)
                  .innerJoin(
                    memberships,
                    and(
                      eq(memberships.tenantId, noteMentions.tenantId),
                      eq(memberships.id, noteMentions.membershipId),
                    ),
                  )
                  .innerJoin(users, eq(users.id, memberships.userId))
                  .where(
                    and(
                      eq(noteMentions.tenantId, ctx.tenant.id),
                      inArray(
                        noteMentions.noteId,
                        notes.map((n) => n.id),
                      ),
                    ),
                  )
                  .orderBy(asc(users.name));
          const [turn] =
            conv.status === 'resolved'
              ? []
              : await tx
                  .select({ startedAt: conversationTurns.startedAt })
                  .from(conversationTurns)
                  .where(
                    and(
                      eq(conversationTurns.tenantId, ctx.tenant.id),
                      eq(conversationTurns.conversationId, conv.id),
                      isNull(conversationTurns.endedAt),
                    ),
                  );
          const tags = await tx
            .select({ tag: conversationTags.tag })
            .from(conversationTags)
            .where(
              and(
                eq(conversationTags.tenantId, ctx.tenant.id),
                eq(conversationTags.conversationId, conv.id),
              ),
            )
            .orderBy(asc(conversationTags.tag));
          const target = await loadReplyTarget(tx, ctx.tenant.id, ctx.tenant.timezone);
          const survey = await latestCsatSurvey(tx, ctx.tenant.id, conv.id);
          const automation = await automationStateForConversation(tx, ctx.tenant.id, conv.id);
          const source = await latestConversationSource(tx, ctx.tenant.id, conv.id);
          const page = rows.slice(0, pageSize);
          const oldest = page[page.length - 1];
          return {
            conversation: {
              id: conv.id,
              status: conv.status,
              version: conv.version,
              assignedMembershipId: conv.assignedMembershipId,
              teamId: conv.teamId,
              teamName: conv.teamName,
              tags: tags.map((t) => t.tag),
              contactId: conv.contactId,
              channelAccountId: conv.channelAccountId,
              whatsappAccountId: conv.whatsappAccountId,
              contactName: conv.contactName ?? identity?.profileName ?? null,
              contactPhone: shownNumber(ctx, conv.contactPhone),
              identity: { hasPhone: Boolean(identity?.waId), hasUserId: Boolean(identity?.bsuid) },
              channelName: conv.channelName,
              channelActive: conv.channelStatus === 'active',
              windowExpiresAt: conv.lastInboundAt
                ? new Date(conv.lastInboundAt.getTime() + SERVICE_WINDOW_MS).toISOString()
                : null,
              windowOpen: Boolean(
                conv.lastInboundAt &&
                now.getTime() - conv.lastInboundAt.getTime() <= SERVICE_WINDOW_MS,
              ),
              ...timerFields(target, turn?.startedAt ?? null, now),
            },
            messages: page
              .reverse()
              .map(
                ({
                  cursorAt: _cursorAt,
                  answeredId,
                  answeredDirection,
                  answeredType,
                  answeredContent,
                  ...m
                }) => ({
                  ...m,
                  createdAt: m.createdAt.toISOString(),
                  providerTimestamp: m.providerTimestamp?.toISOString() ?? null,
                  // The message this one quotes, reacts to or taps a button of (ADR-082).
                  replyTo:
                    answeredId && answeredDirection && answeredType && answeredContent
                      ? {
                          id: answeredId,
                          direction: answeredDirection,
                          text: messageSnippet(answeredDirection, answeredType, answeredContent),
                        }
                      : null,
                }),
              ),
            olderCursor:
              rows.length > pageSize && oldest
                ? encodeKeysetCursor(oldest.cursorAt, oldest.id)
                : null,
            automation,
            source,
            csat: survey
              ? {
                  skipReason: survey.skipReason,
                  score: survey.score,
                  answeredAt: survey.answeredAt?.toISOString() ?? null,
                  createdAt: survey.createdAt.toISOString(),
                  messageStatus: survey.messageStatus,
                }
              : null,
            notes: notes.map((n) => ({
              ...n,
              createdAt: n.createdAt.toISOString(),
              mentions: mentioned
                .filter((m) => m.noteId === n.id)
                .map((m) => ({ membershipId: m.membershipId, name: m.name })),
            })),
          };
        },
        { accessMode: 'read only' },
      );
    },

    /**
     * Streams a conversation's transcript as plain text (ADR-212), oldest message first, for a
     * member with `inbox.export` who can see the conversation. The check and the audit entry come
     * before the first byte, so a refused download is a 403 or 404, never a partial file.
     */
    async *exportTranscript(
      ctx: TenantContext,
      conversationId: string,
      meta: RequestMeta = {},
    ): AsyncGenerator<string> {
      assertCan(ctx, 'inbox.export');
      if (!z.uuid().safeParse(conversationId).success) throw notFound('Conversation');
      const conv = await db.run(ctx.scope, async (tx) => {
        const [row] = await tx
          .select({
            assignedMembershipId: conversations.assignedMembershipId,
            contactName: contacts.displayName,
            contactPhone: contacts.phoneE164,
            number: channelAccounts.displayPhoneNumber,
          })
          .from(conversations)
          .innerJoin(
            contacts,
            and(
              eq(contacts.tenantId, conversations.tenantId),
              eq(contacts.id, conversations.contactId),
            ),
          )
          .innerJoin(
            channelAccounts,
            and(
              eq(channelAccounts.tenantId, conversations.tenantId),
              eq(channelAccounts.id, conversations.channelAccountId),
            ),
          )
          .where(
            and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversationId)),
          );
        if (!row || !canSeeConversation(ctx, row.assignedMembershipId))
          throw notFound('Conversation');
        await recordAudit(
          tx,
          ctx,
          {
            action: 'conversation.transcript_exported',
            subjectType: 'conversation',
            subjectId: conversationId,
          },
          meta,
        );
        return row;
      });
      const timeZone = ctx.tenant.timezone;
      yield transcriptHeader({
        contactName: conv.contactName,
        contactPhone: shownNumber(ctx, conv.contactPhone),
        number: conv.number,
        companyName: ctx.tenant.name,
        timeZone,
        downloadedBy: ctx.user.name,
        downloadedAt: clock.now(),
      });
      /** The next 500 messages after `cursor`, oldest first. */
      const page = (cursor: { at: string; id: string } | null) =>
        db.run(
          ctx.scope,
          (tx) =>
            tx
              .select({
                id: messages.id,
                direction: messages.direction,
                type: messages.type,
                content: messages.content,
                status: messages.status,
                errorTitle: messages.errorTitle,
                senderType: messages.senderType,
                memberName: users.name,
                apiKeyName: apiKeys.name,
                campaignName: campaigns.name,
                createdAt: messages.createdAt,
                providerTimestamp: messages.providerTimestamp,
                cursorAt: exactTimestamp(messages.createdAt),
              })
              .from(messages)
              .leftJoin(
                memberships,
                and(
                  eq(memberships.tenantId, messages.tenantId),
                  eq(memberships.id, messages.senderMembershipId),
                ),
              )
              .leftJoin(users, eq(users.id, memberships.userId))
              .leftJoin(
                apiKeys,
                and(eq(apiKeys.tenantId, messages.tenantId), eq(apiKeys.id, messages.apiKeyId)),
              )
              .leftJoin(
                campaigns,
                and(
                  eq(campaigns.tenantId, messages.tenantId),
                  eq(campaigns.id, messages.campaignId),
                ),
              )
              .where(
                and(
                  eq(messages.tenantId, ctx.tenant.id),
                  eq(messages.conversationId, conversationId),
                  cursor
                    ? sql`(${messages.createdAt}, ${messages.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
                    : undefined,
                ),
              )
              .orderBy(asc(messages.createdAt), asc(messages.id))
              .limit(500),
          { accessMode: 'read only' },
        );
      let after: { at: string; id: string } | null = null;
      for (;;) {
        const rows = await page(after);
        const last = rows.at(-1);
        if (!last) break;
        yield rows
          .map((m) =>
            transcriptEntry(
              {
                direction: m.direction,
                type: m.type,
                content: m.content,
                status: m.status,
                errorTitle: m.errorTitle,
                senderType: m.senderType,
                memberName: m.memberName,
                apiKeyName: m.apiKeyName,
                campaignName: m.campaignName,
                at: m.providerTimestamp ?? m.createdAt,
              },
              conv.contactName,
              timeZone,
            ),
          )
          .join('');
        after = { at: last.cursorAt, id: last.id };
      }
    },

    async assign(ctx: TenantContext, input: unknown) {
      const data = parse(assignSchema, input);
      await withConversation(ctx, data.conversationId, async (tx, current) => {
        if (current.version !== data.expectedVersion) throw staleVersion();
        const managing = can(ctx, 'inbox.assign');
        const claimingSelf =
          data.membershipId === ctx.membership.id && current.assignedMembershipId === null;
        const releasingSelf =
          data.membershipId === null && current.assignedMembershipId === ctx.membership.id;
        if (!managing && !claimingSelf && !releasingSelf) {
          throw forbidden('You can only claim unassigned conversations or release your own.');
        }
        // Only members who can answer conversations hold them, as in teams and routing.
        if (
          data.membershipId &&
          !(await lockAssignableMember(tx, ctx.tenant.id, data.membershipId))
        ) {
          throw new AppError(
            'validation_failed',
            'Choose an active member whose role can reply in the inbox.',
          );
        }
        // Assigning a person ends an automation handling the conversation (hand-off lock).
        if (data.membershipId) {
          await endRunForHuman(tx, {
            tenantId: ctx.tenant.id,
            conversationId: current.id,
            reason: 'assigned',
            actorMembershipId: ctx.membership.id,
            assigneeMembershipId: data.membershipId,
            now: clock.now(),
          });
        }
        await tx
          .update(conversations)
          .set({
            assignedMembershipId: data.membershipId,
            version: sql`${conversations.version} + 1`,
          })
          .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, current.id)));
        await emitTenantEvent(tx, ctx.tenant.id, {
          type: 'conversation.assigned',
          conversationId: current.id,
          assignedMembershipId: data.membershipId,
          payload: { previous: current.assignedMembershipId },
        });
        await recordAudit(tx, ctx, {
          action: 'conversation.assigned',
          subjectType: 'conversation',
          subjectId: current.id,
          metadata: { from: current.assignedMembershipId, to: data.membershipId },
        });
      });
    },

    /**
     * Moves a conversation to another team (or none). An unassigned conversation moved to a
     * round-robin team is routed straight away.
     */
    async setTeam(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'inbox.assign');
      const data = parse(conversationTeamSchema, input);
      return withConversation(ctx, data.conversationId, async (tx, current) => {
        if (current.version !== data.expectedVersion) throw staleVersion();
        if (data.teamId && !(await lockTeam(tx, ctx.tenant.id, data.teamId))) {
          throw new AppError('validation_failed', 'Choose a team of this company.');
        }
        if (current.teamId === data.teamId) return { assignedMembershipId: null };
        await tx
          .update(conversations)
          .set({ teamId: data.teamId, version: sql`${conversations.version} + 1` })
          .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, current.id)));
        await emitTenantEvent(tx, ctx.tenant.id, {
          type: 'conversation.team',
          conversationId: current.id,
          assignedMembershipId: current.assignedMembershipId,
          payload: { teamId: data.teamId },
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'conversation.team_changed',
            subjectType: 'conversation',
            subjectId: current.id,
            metadata: { from: current.teamId, to: data.teamId },
          },
          meta,
        );
        if (current.assignedMembershipId || current.status === 'resolved' || !data.teamId) {
          return { assignedMembershipId: null };
        }
        const routed = await routeConversation(tx, ctx.tenant.id, current.id, {
          newCase: false,
          text: null,
        });
        return { assignedMembershipId: routed.assignedMembershipId };
      });
    },

    async setStatus(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'inbox.reply');
      const data = parse(statusSchema, input);
      await withConversation(ctx, data.conversationId, async (tx, current) => {
        if (current.version !== data.expectedVersion) throw staleVersion();
        if (data.status === 'resolved' && current.status !== 'resolved') {
          await endRunForHuman(tx, {
            tenantId: ctx.tenant.id,
            conversationId: current.id,
            reason: 'conversation_resolved',
            actorMembershipId: ctx.membership.id,
            now: clock.now(),
          });
        }
        await tx
          .update(conversations)
          .set({
            status: data.status,
            resolvedAt: data.status === 'resolved' ? clock.now() : null,
            ...(data.status === 'resolved' ? { unreadCount: 0 } : {}),
            version: sql`${conversations.version} + 1`,
          })
          .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, current.id)));
        await emitTenantEvent(tx, ctx.tenant.id, {
          type: 'conversation.status',
          conversationId: current.id,
          assignedMembershipId: current.assignedMembershipId,
          payload: { status: data.status },
        });
        // Reports count resolutions per member from these entries (agent.resolved).
        if (current.status !== data.status) {
          await recordAudit(tx, ctx, {
            action: 'conversation.status_changed',
            subjectType: 'conversation',
            subjectId: current.id,
            metadata: { from: current.status, to: data.status },
          });
          if (data.status === 'resolved') await queueCsatSurvey(tx, csatDeps, ctx, current.id);
        }
      });
    },

    /**
     * Adds an internal note; mentioned members are notified and must be able to see the thread.
     * Those who have not opened it a while later are emailed (ADR-211).
     */
    async addNote(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'inbox.reply');
      const data = parse(noteSchema, input);
      const mentionIds = [...new Set(data.mentionIds)];
      await withConversation(ctx, data.conversationId, async (tx, current) => {
        if (mentionIds.length) {
          const allowed = await tx
            .select({ id: memberships.id })
            .from(memberships)
            .where(
              and(
                eq(memberships.tenantId, ctx.tenant.id),
                inArray(memberships.id, mentionIds),
                eq(memberships.status, 'active'),
                memberCanSee(
                  sql`${memberships.roles}`,
                  sql`${memberships.id}`,
                  sql`${current.assignedMembershipId}::uuid`,
                ),
              ),
            );
          if (allowed.length !== mentionIds.length) {
            throw new AppError(
              'validation_failed',
              'You can only mention active members who can see this conversation.',
            );
          }
        }
        const noteId = uuidv7();
        await tx.insert(conversationNotes).values({
          id: noteId,
          tenantId: ctx.tenant.id,
          conversationId: current.id,
          authorMembershipId: ctx.membership.id,
          body: data.body,
        });
        if (mentionIds.length) {
          const now = clock.now();
          const rows = mentionIds.map((membershipId) => ({
            id: uuidv7(),
            tenantId: ctx.tenant.id,
            noteId,
            membershipId,
            // Mentioning yourself needs no notification.
            readAt: membershipId === ctx.membership.id ? now : null,
          }));
          await tx.insert(noteMentions).values(rows);
          const notified = rows.filter((row) => row.readAt === null);
          if (notified.length) {
            if (!mentionDeps) throw new Error('Mention emails need the job queue');
            const at = new Date(now.getTime() + MENTION_EMAIL_DELAY_MS);
            for (const row of notified) {
              await scheduleMentionEmail(mentionDeps, tx, {
                tenantId: ctx.tenant.id,
                mentionId: row.id,
                at,
              });
            }
          }
        }
        await emitTenantEvent(tx, ctx.tenant.id, {
          type: mentionIds.length ? 'conversation.mention' : 'conversation.note',
          conversationId: current.id,
          assignedMembershipId: current.assignedMembershipId,
          ...(mentionIds.length ? { payload: { mentioned: mentionIds } } : {}),
        });
      });
    },

    /** Active members who can see a conversation (for the mention picker). */
    async mentionableMembers(ctx: TenantContext, conversationId: string) {
      assertCan(ctx, 'inbox.reply');
      if (!z.uuid().safeParse(conversationId).success) throw notFound('Conversation');
      return db.run(
        ctx.scope,
        async (tx) => {
          const [conv] = await tx
            .select({ assignedMembershipId: conversations.assignedMembershipId })
            .from(conversations)
            .where(
              and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversationId)),
            );
          if (!conv || !canSeeConversation(ctx, conv.assignedMembershipId))
            throw notFound('Conversation');
          return tx
            .select({ membershipId: memberships.id, name: users.name })
            .from(memberships)
            .innerJoin(users, eq(users.id, memberships.userId))
            .where(
              and(
                eq(memberships.tenantId, ctx.tenant.id),
                eq(memberships.status, 'active'),
                memberCanSee(
                  sql`${memberships.roles}`,
                  sql`${memberships.id}`,
                  sql`${conv.assignedMembershipId}::uuid`,
                ),
              ),
            )
            .orderBy(asc(users.name));
        },
        { accessMode: 'read only' },
      );
    },

    /** The current member's mentions in conversations they can still see, newest first. */
    async listMentions(ctx: TenantContext, input: { unreadOnly?: boolean } = {}) {
      if (!can(ctx, 'inbox.read_all') && !can(ctx, 'inbox.read_assigned'))
        assertCan(ctx, 'inbox.read_assigned');
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: noteMentions.id,
              readAt: noteMentions.readAt,
              createdAt: noteMentions.createdAt,
              conversationId: conversationNotes.conversationId,
              body: conversationNotes.body,
              authorName: users.name,
              contactName: contacts.displayName,
              contactPhone: contacts.phoneE164,
            })
            .from(noteMentions)
            .innerJoin(
              conversationNotes,
              and(
                eq(conversationNotes.tenantId, noteMentions.tenantId),
                eq(conversationNotes.id, noteMentions.noteId),
              ),
            )
            .innerJoin(
              conversations,
              and(
                eq(conversations.tenantId, conversationNotes.tenantId),
                eq(conversations.id, conversationNotes.conversationId),
              ),
            )
            .innerJoin(
              contacts,
              and(
                eq(contacts.tenantId, conversations.tenantId),
                eq(contacts.id, conversations.contactId),
              ),
            )
            .innerJoin(
              memberships,
              and(
                eq(memberships.tenantId, conversationNotes.tenantId),
                eq(memberships.id, conversationNotes.authorMembershipId),
              ),
            )
            .innerJoin(users, eq(users.id, memberships.userId))
            .where(
              and(
                eq(noteMentions.tenantId, ctx.tenant.id),
                eq(noteMentions.membershipId, ctx.membership.id),
                input.unreadOnly ? isNull(noteMentions.readAt) : undefined,
                visibilityFilter(ctx),
              ),
            )
            .orderBy(desc(noteMentions.createdAt), desc(noteMentions.id))
            .limit(50),
        { accessMode: 'read only' },
      );
      return rows.map((r) => ({
        ...r,
        contactPhone: shownNumber(ctx, r.contactPhone),
        readAt: r.readAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      }));
    },

    /**
     * When the replies to the customers waiting in conversations the member can see are due
     * (ADR-241), the earliest first and at most WAITING_REPLY_LIMIT, for the inbox's notice of
     * overdue replies; none without a first-response target. Only times and whether each
     * conversation is the member's: nothing about the customers, conversations or messages.
     */
    async waitingReplies(ctx: TenantContext): Promise<{ waits: WaitingReply[]; capped: boolean }> {
      if (!can(ctx, 'inbox.read_all') && !can(ctx, 'inbox.read_assigned')) {
        return { waits: [], capped: false };
      }
      return db.run(
        ctx.scope,
        async (tx) => {
          const target = await loadReplyTarget(tx, ctx.tenant.id, ctx.tenant.timezone);
          if (!target.minutes) return { waits: [], capped: false };
          // A due time follows its start (business minutes only move it later), so the earliest
          // starts are the earliest due.
          const rows = await tx
            .select({
              startedAt: conversationTurns.startedAt,
              assignedMembershipId: conversations.assignedMembershipId,
            })
            .from(conversationTurns)
            .innerJoin(
              conversations,
              and(
                eq(conversations.tenantId, conversationTurns.tenantId),
                eq(conversations.id, conversationTurns.conversationId),
              ),
            )
            .where(
              and(
                eq(conversationTurns.tenantId, ctx.tenant.id),
                isNull(conversationTurns.endedAt),
                or(eq(conversations.status, 'open'), eq(conversations.status, 'pending')),
                visibilityFilter(ctx),
              ),
            )
            .orderBy(asc(conversationTurns.startedAt), asc(conversationTurns.id))
            .limit(WAITING_REPLY_LIMIT + 1);
          const waits = rows.slice(0, WAITING_REPLY_LIMIT).flatMap((r) => {
            const due = replyDueAt(target, r.startedAt);
            return due
              ? [{ dueAt: due.toISOString(), mine: r.assignedMembershipId === ctx.membership.id }]
              : [];
          });
          return { waits, capped: rows.length > WAITING_REPLY_LIMIT };
        },
        { accessMode: 'read only' },
      );
    },

    /** Unread mentions of the current member in conversations they can see. */
    async unreadMentionCount(ctx: TenantContext): Promise<number> {
      if (!can(ctx, 'inbox.read_all') && !can(ctx, 'inbox.read_assigned')) return 0;
      const [row] = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({ count: sql<number>`count(*)::int` })
            .from(noteMentions)
            .innerJoin(
              conversationNotes,
              and(
                eq(conversationNotes.tenantId, noteMentions.tenantId),
                eq(conversationNotes.id, noteMentions.noteId),
              ),
            )
            .innerJoin(
              conversations,
              and(
                eq(conversations.tenantId, conversationNotes.tenantId),
                eq(conversations.id, conversationNotes.conversationId),
              ),
            )
            .where(
              and(
                eq(noteMentions.tenantId, ctx.tenant.id),
                eq(noteMentions.membershipId, ctx.membership.id),
                isNull(noteMentions.readAt),
                visibilityFilter(ctx),
              ),
            ),
        { accessMode: 'read only' },
      );
      return row?.count ?? 0;
    },

    /** Marks the conversation read for the team and the member's mentions in it as seen. */
    async markRead(ctx: TenantContext, conversationId: string) {
      await withConversation(ctx, conversationId, async (tx, current) => {
        const updated = await tx
          .update(conversations)
          .set({ unreadCount: 0 })
          .where(
            and(
              eq(conversations.tenantId, ctx.tenant.id),
              eq(conversations.id, current.id),
              sql`${conversations.unreadCount} > 0`,
            ),
          )
          .returning({ id: conversations.id });
        const seen = await tx
          .update(noteMentions)
          .set({ readAt: clock.now() })
          .where(
            and(
              eq(noteMentions.tenantId, ctx.tenant.id),
              eq(noteMentions.membershipId, ctx.membership.id),
              isNull(noteMentions.readAt),
              sql`${noteMentions.noteId} in (select n.id from app.conversation_notes n
                    where n.tenant_id = ${ctx.tenant.id}::uuid and n.conversation_id = ${current.id}::uuid)`,
            ),
          )
          .returning({ id: noteMentions.id });
        if (updated.length > 0 || seen.length > 0) {
          await emitTenantEvent(tx, ctx.tenant.id, {
            type: 'conversation.read',
            conversationId: current.id,
            assignedMembershipId: current.assignedMembershipId,
          });
        }
        // The customer's latest message is marked read in WhatsApp, when the company turned read
        // receipts on (ADR-223).
        if (updated.length > 0 && receiptDeps) {
          await queueReadReceipt(tx, receiptDeps, ctx.tenant.id, current.id);
        }
      });
    },

    /** The first-response target in minutes (reports compare reply times with it). */
    async getResponseTarget(ctx: TenantContext): Promise<number | null> {
      assertCan(ctx, 'tenant.read');
      const [row] = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({ minutes: messagingSettings.firstResponseTargetMinutes })
            .from(messagingSettings)
            .where(eq(messagingSettings.tenantId, ctx.tenant.id)),
        { accessMode: 'read only' },
      );
      return row?.minutes ?? null;
    },

    async updateResponseTarget(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'tenant.settings.manage');
      const data = parse(responseTargetSchema, input);
      await db.run(ctx.scope, async (tx) => {
        const values = {
          firstResponseTargetMinutes: data.minutes,
          updatedByUserId: ctx.user.id,
          updatedAt: clock.now(),
        };
        await tx
          .insert(messagingSettings)
          .values({
            tenantId: ctx.tenant.id,
            optOutKeywords: [...DEFAULT_MESSAGING_SETTINGS.optOutKeywords],
            marketingOptOutKeywords: [...DEFAULT_MESSAGING_SETTINGS.marketingOptOutKeywords],
            optInKeywords: [...DEFAULT_MESSAGING_SETTINGS.optInKeywords],
            requireMarketingOptIn: DEFAULT_MESSAGING_SETTINGS.requireMarketingOptIn,
            ...values,
          })
          .onConflictDoUpdate({ target: messagingSettings.tenantId, set: values });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'inbox.response_target_updated',
            subjectType: 'tenant',
            subjectId: ctx.tenant.id,
            metadata: { minutes: data.minutes },
          },
          meta,
        );
      });
    },

    /** Members the assignment picker offers: active, with a role that answers conversations. */
    async assignableMembers(ctx: TenantContext) {
      assertCan(ctx, 'members.read');
      return db.run(
        ctx.scope,
        async (tx) =>
          tx
            .select({ membershipId: memberships.id, name: users.name, roles: memberships.roles })
            .from(memberships)
            .innerJoin(users, eq(users.id, memberships.userId))
            .where(
              and(
                eq(memberships.tenantId, ctx.tenant.id),
                eq(memberships.status, 'active'),
                sql`${memberships.roles} && ${sql.param([...INBOX_WORKER_ROLES])}::text[]`,
              ),
            )
            .orderBy(users.name),
        { accessMode: 'read only' },
      );
    },
  };
}

export type InboxService = ReturnType<typeof createInboxService>;
