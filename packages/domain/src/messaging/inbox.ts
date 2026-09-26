import { z } from 'zod';
import { AppError, forbidden, notFound, uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  channelAccounts,
  contactIdentities,
  contacts,
  conversationNotes,
  conversations,
  desc,
  eq,
  isNull,
  lt,
  memberships,
  messages,
  messagingSettings,
  or,
  sql,
  users,
  type Database,
  type SQL,
  type Tx,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { recordAudit, type RequestMeta } from '../audit';
import { DEFAULT_MESSAGING_SETTINGS } from '../consent/service';
import { emitTenantEvent } from './events';
import { SERVICE_WINDOW_MS, canSeeConversation } from './outbound';

/**
 * Shared inbox queries and commands. Visibility: `inbox.read_all` sees every conversation;
 * `inbox.read_assigned` sees conversations assigned to the member plus the unassigned queue.
 * Assignment and status changes use optimistic concurrency (conversation `version`) so two agents
 * can never silently overwrite each other.
 */
export const listConversationsSchema = z.object({
  view: z.enum(['mine', 'unassigned', 'all']).default('all'),
  status: z.enum(['open', 'resolved']).default('open'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

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
  body: z.string().trim().min(1, 'Write a note').max(4000),
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
  windowOpen: boolean;
  version: number;
}

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

export function createInboxService(deps: { db: Database; clock: Clock }) {
  const { db, clock } = deps;

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
      current: { id: string; version: number; assignedMembershipId: string | null; status: string },
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
      const now = clock.now();
      const rows = await db.run(
        ctx.scope,
        async (tx) =>
          tx
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
              lastInboundAt: conversations.lastInboundAt,
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
                visibilityFilter(ctx),
                cursor
                  ? cursor.at
                    ? or(
                        lt(conversations.lastMessageAt, cursor.at),
                        and(
                          eq(conversations.lastMessageAt, cursor.at),
                          lt(conversations.id, cursor.id),
                        ),
                        isNull(conversations.lastMessageAt),
                      )
                    : and(isNull(conversations.lastMessageAt), lt(conversations.id, cursor.id))
                  : undefined,
              ),
            )
            .orderBy(sql`${conversations.lastMessageAt} desc nulls last`, desc(conversations.id))
            .limit(q.limit + 1),
        { accessMode: 'read only' },
      );
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      const items: ConversationSummary[] = page.map((r) => ({
        id: r.id,
        status: r.status,
        contactName: r.contactName,
        contactPhone: r.contactPhone,
        channelName: r.channelName,
        lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
        lastMessagePreview: r.lastMessagePreview,
        unreadCount: r.unreadCount,
        assignedMembershipId: r.assignedMembershipId,
        assignedName: r.assignedName,
        windowOpen: Boolean(
          r.lastInboundAt && now.getTime() - r.lastInboundAt.getTime() <= SERVICE_WINDOW_MS,
        ),
        version: r.version,
      }));
      return {
        items,
        nextCursor:
          rows.length > q.limit && last ? encodeCursor(last.lastMessageAt, last.id) : null,
      };
    },

    async getConversation(ctx: TenantContext, conversationId: string, before?: string) {
      if (!z.uuid().safeParse(conversationId).success) throw notFound('Conversation');
      const beforeCursor = decodeCursor(before);
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
              senderName: users.name,
              createdAt: messages.createdAt,
              providerTimestamp: messages.providerTimestamp,
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
            .where(
              and(
                eq(messages.tenantId, ctx.tenant.id),
                eq(messages.conversationId, conversationId),
                beforeCursor?.at
                  ? or(
                      lt(messages.createdAt, beforeCursor.at),
                      and(
                        eq(messages.createdAt, beforeCursor.at),
                        lt(messages.id, beforeCursor.id),
                      ),
                    )
                  : undefined,
              ),
            )
            .orderBy(desc(messages.createdAt), desc(messages.id))
            .limit(pageSize + 1);
          const notes = await tx
            .select({
              id: conversationNotes.id,
              body: conversationNotes.body,
              createdAt: conversationNotes.createdAt,
              authorName: users.name,
            })
            .from(conversationNotes)
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
                eq(conversationNotes.tenantId, ctx.tenant.id),
                eq(conversationNotes.conversationId, conversationId),
              ),
            )
            .orderBy(asc(conversationNotes.createdAt))
            .limit(200);
          const page = rows.slice(0, pageSize);
          const oldest = page[page.length - 1];
          return {
            conversation: {
              id: conv.id,
              status: conv.status,
              version: conv.version,
              assignedMembershipId: conv.assignedMembershipId,
              contactId: conv.contactId,
              channelAccountId: conv.channelAccountId,
              whatsappAccountId: conv.whatsappAccountId,
              contactName: conv.contactName ?? identity?.profileName ?? null,
              contactPhone: conv.contactPhone,
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
            },
            messages: page.reverse().map((m) => ({
              ...m,
              createdAt: m.createdAt.toISOString(),
              providerTimestamp: m.providerTimestamp?.toISOString() ?? null,
            })),
            olderCursor:
              rows.length > pageSize && oldest ? encodeCursor(oldest.createdAt, oldest.id) : null,
            notes: notes.map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
          };
        },
        { accessMode: 'read only' },
      );
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
        if (data.membershipId) {
          const [target] = await tx
            .select({ id: memberships.id, status: memberships.status })
            .from(memberships)
            .where(
              and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.id, data.membershipId)),
            );
          if (!target || target.status !== 'active') {
            throw new AppError('validation_failed', 'Choose an active member.');
          }
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

    async setStatus(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'inbox.reply');
      const data = parse(statusSchema, input);
      await withConversation(ctx, data.conversationId, async (tx, current) => {
        if (current.version !== data.expectedVersion) throw staleVersion();
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
        }
      });
    },

    async addNote(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'inbox.reply');
      const data = parse(noteSchema, input);
      await withConversation(ctx, data.conversationId, async (tx, current) => {
        await tx.insert(conversationNotes).values({
          id: uuidv7(),
          tenantId: ctx.tenant.id,
          conversationId: current.id,
          authorMembershipId: ctx.membership.id,
          body: data.body,
        });
        await emitTenantEvent(tx, ctx.tenant.id, {
          type: 'conversation.note',
          conversationId: current.id,
          assignedMembershipId: current.assignedMembershipId,
        });
      });
    },

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
        if (updated.length > 0) {
          await emitTenantEvent(tx, ctx.tenant.id, {
            type: 'conversation.read',
            conversationId: current.id,
            assignedMembershipId: current.assignedMembershipId,
          });
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

    /** Active members for the assignment picker. */
    async assignableMembers(ctx: TenantContext) {
      assertCan(ctx, 'members.read');
      return db.run(
        ctx.scope,
        async (tx) =>
          tx
            .select({ membershipId: memberships.id, name: users.name, roles: memberships.roles })
            .from(memberships)
            .innerJoin(users, eq(users.id, memberships.userId))
            .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.status, 'active')))
            .orderBy(users.name),
        { accessMode: 'read only' },
      );
    },
  };
}

export type InboxService = ReturnType<typeof createInboxService>;
