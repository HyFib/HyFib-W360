import { z } from 'zod';
import { notFound, uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  conversations,
  conversationViewers,
  eq,
  gt,
  memberships,
  ne,
  sql,
  systemScope,
  users,
  type Database,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { memberCanSee } from '../messaging/inbox';
import { canSeeConversation } from '../messaging/outbound';
import { PRESENCE_NAMES, PRESENCE_WINDOW_MS, type ConversationViewers } from './presence';

/**
 * Members who have a conversation open (ADR-243). Each member has one row per conversation, its time
 * moved forward by each report; leaving the conversation deletes it, and rows not reported for an
 * hour are deleted by the minute sweep. A member sees only the others who can see the conversation
 * now (the inbox's visibility rule), and only in conversations they can see themselves.
 */
export function createPresenceService(deps: { db: Database; clock: Clock }) {
  const { db, clock } = deps;

  function assertInboxReader(ctx: TenantContext) {
    if (!can(ctx, 'inbox.read_all') && !can(ctx, 'inbox.read_assigned'))
      assertCan(ctx, 'inbox.read_assigned');
  }

  return {
    /**
     * Records that the member has the conversation open now, and names the other active members
     * reported within PRESENCE_WINDOW_MS who can see it, by name. A conversation the member cannot
     * see is not found.
     */
    async report(ctx: TenantContext, conversationId: string): Promise<ConversationViewers> {
      assertInboxReader(ctx);
      if (!z.uuid().safeParse(conversationId).success) throw notFound('Conversation');
      const now = clock.now();
      return db.run(ctx.scope, async (tx) => {
        const [conversation] = await tx
          .select({ assignedMembershipId: conversations.assignedMembershipId })
          .from(conversations)
          .where(
            and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversationId)),
          );
        if (!conversation || !canSeeConversation(ctx, conversation.assignedMembershipId))
          throw notFound('Conversation');
        await tx
          .insert(conversationViewers)
          .values({
            id: uuidv7(),
            tenantId: ctx.tenant.id,
            conversationId,
            membershipId: ctx.membership.id,
            seenAt: now,
          })
          .onConflictDoUpdate({
            target: [
              conversationViewers.tenantId,
              conversationViewers.conversationId,
              conversationViewers.membershipId,
            ],
            set: { seenAt: now },
          });
        const name = sql<string>`coalesce(${memberships.displayName}, ${users.name})`;
        const others = await tx
          .select({ name, total: sql<number>`count(*) over ()`.mapWith(Number) })
          .from(conversationViewers)
          .innerJoin(
            memberships,
            and(
              eq(memberships.tenantId, conversationViewers.tenantId),
              eq(memberships.id, conversationViewers.membershipId),
            ),
          )
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(conversationViewers.tenantId, ctx.tenant.id),
              eq(conversationViewers.conversationId, conversationId),
              ne(conversationViewers.membershipId, ctx.membership.id),
              gt(conversationViewers.seenAt, new Date(now.getTime() - PRESENCE_WINDOW_MS)),
              eq(memberships.status, 'active'),
              memberCanSee(
                sql`${memberships.roles}`,
                sql`${memberships.id}`,
                sql`${conversation.assignedMembershipId}::uuid`,
              ),
            ),
          )
          .orderBy(asc(name), asc(memberships.id))
          .limit(PRESENCE_NAMES);
        return { names: others.map((o) => o.name), total: others[0]?.total ?? 0 };
      });
    },

    /**
     * The member left the conversation: they no longer have it open. Deletes only the member's own
     * row, so it needs no inbox permission: a member who lost it can still say they left.
     */
    async leave(ctx: TenantContext, conversationId: string): Promise<void> {
      if (!z.uuid().safeParse(conversationId).success) throw notFound('Conversation');
      await db.run(ctx.scope, (tx) =>
        tx
          .delete(conversationViewers)
          .where(
            and(
              eq(conversationViewers.tenantId, ctx.tenant.id),
              eq(conversationViewers.conversationId, conversationId),
              eq(conversationViewers.membershipId, ctx.membership.id),
            ),
          ),
      );
    },
  };
}

export type PresenceService = ReturnType<typeof createPresenceService>;

/**
 * Deletes up to `limit` rows not reported for an hour, in every company (the minute sweep), through
 * a definer function that sees only those rows. Returns how many were deleted.
 */
export async function purgeConversationViewers(db: Database, limit = 5000): Promise<number> {
  const res = await db.run(systemScope, (tx) =>
    tx.execute<{ purged: number }>(
      sql`select ops.purge_conversation_viewers(${limit}::int) as purged`,
    ),
  );
  return Number(res.rows[0]?.purged ?? 0);
}
