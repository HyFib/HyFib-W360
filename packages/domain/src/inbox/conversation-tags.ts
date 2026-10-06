import { z } from 'zod';
import { AppError, notFound, uuidv7 } from '@w360/core';
import {
  and,
  asc,
  contacts,
  conversations,
  conversationTags,
  eq,
  sql,
  type Database,
  type SQL,
  type Tx,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { normalizeTag } from '../contacts/fields';
import { emitTenantEvent } from '../messaging/events';
import { canSeeConversation } from '../messaging/outbound';
import { parseInput } from '../validation';

/**
 * Conversation tags (ADR-220): short labels ("refund", "follow up") that members who can reply put
 * on conversations they can see, written as contact tags are. The inbox shows them on each
 * conversation and lists the conversations that have a tag. Tags carry no permission of their own:
 * whoever sees a conversation sees its tags, and the tags offered in the inbox's filter are those
 * on conversations the member can see.
 */
export const MAX_TAGS_PER_CONVERSATION = 20;
/** The most tags the inbox's filter offers, alphabetically. */
export const TAGS_IN_USE_LIMIT = 200;

export const addConversationTagsSchema = z.object({
  conversationId: z.uuid(),
  /** One tag, or several separated by commas. */
  tags: z.string().max(1000, 'Add fewer tags at once.'),
});

export const removeConversationTagSchema = z.object({
  conversationId: z.uuid(),
  tag: z.string().max(200),
});

export interface ConversationTagInUse {
  tag: string;
  /** Conversations the member can see that have the tag. */
  conversations: number;
}

const tagRefusal = (path: string, message: string) =>
  new AppError('validation_failed', message, { issues: [{ path, message }] });

/**
 * The tags a member typed: split at commas and written as tags are, without repeats. Pieces left
 * blank between commas are skipped; a piece that cannot be a tag refuses the whole list.
 */
export function parseTagList(raw: string): string[] {
  const tags: string[] = [];
  for (const piece of raw.split(',')) {
    if (!piece.trim()) continue;
    const tag = normalizeTag(piece);
    if (!tag.ok) throw tagRefusal('tags', tag.message);
    if (!tags.includes(tag.tag)) tags.push(tag.tag);
  }
  if (tags.length === 0) throw tagRefusal('tags', 'Write a tag.');
  return tags;
}

/**
 * SQL: the tags of the conversation whose company and id are `tenantIdColumn` and
 * `conversationIdColumn`, alphabetically; an empty array when it has none.
 */
export function conversationTagsOf(tenantIdColumn: SQL, conversationIdColumn: SQL): SQL<string[]> {
  return sql<string[]>`coalesce((select array_agg(t.tag order by t.tag) from app.conversation_tags t
    where t.tenant_id = ${tenantIdColumn} and t.conversation_id = ${conversationIdColumn}), '{}')`;
}

/**
 * SQL: that conversation has the tag `raw` (as a member typed it). A value that cannot be a tag
 * matches no conversation, since no conversation has such a tag.
 */
export function conversationHasTag(
  tenantIdColumn: SQL,
  conversationIdColumn: SQL,
  raw: string,
): SQL {
  const tag = normalizeTag(raw);
  if (!tag.ok) return sql`false`;
  return sql`exists (select 1 from app.conversation_tags t where t.tenant_id = ${tenantIdColumn}
    and t.conversation_id = ${conversationIdColumn} and t.tag = ${tag.tag})`;
}

export interface ConversationTagsDeps {
  db: Database;
}

export function createConversationTagsService({ db }: ConversationTagsDeps) {
  /**
   * Locks the conversation (when the member can see it), so the count of its tags and the change
   * see one state, and contact erasure (which locks conversations first) waits or goes first.
   */
  async function lockConversation(tx: Tx, ctx: TenantContext, conversationId: string) {
    const [row] = await tx
      .select({
        id: conversations.id,
        contactId: conversations.contactId,
        assignedMembershipId: conversations.assignedMembershipId,
      })
      .from(conversations)
      .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversationId)))
      .for('update');
    if (!row || !canSeeConversation(ctx, row.assignedMembershipId)) throw notFound('Conversation');
    return row;
  }

  async function tagsOf(tx: Tx, tenantId: string, conversationId: string): Promise<string[]> {
    const rows = await tx
      .select({ tag: conversationTags.tag })
      .from(conversationTags)
      .where(
        and(
          eq(conversationTags.tenantId, tenantId),
          eq(conversationTags.conversationId, conversationId),
        ),
      )
      .orderBy(asc(conversationTags.tag));
    return rows.map((r) => r.tag);
  }

  return {
    /**
     * Adds tags to a conversation the member can see; tags it already has are kept once. Refused
     * past 20 tags, and for the conversation of an erased contact (erasure deleted its tags).
     */
    async addTags(
      ctx: TenantContext,
      input: unknown,
    ): Promise<{ tags: string[]; added: string[] }> {
      assertCan(ctx, 'inbox.reply');
      const data = parseInput(addConversationTagsSchema, input);
      const tags = parseTagList(data.tags);
      return db.run(ctx.scope, async (tx) => {
        const conversation = await lockConversation(tx, ctx, data.conversationId);
        const [contact] = await tx
          .select({ erasedAt: contacts.erasedAt })
          .from(contacts)
          .where(
            and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, conversation.contactId)),
          );
        if (contact?.erasedAt) throw new AppError('conflict', 'This contact was erased.');
        const current = await tagsOf(tx, ctx.tenant.id, conversation.id);
        const added = tags.filter((tag) => !current.includes(tag));
        if (current.length + added.length > MAX_TAGS_PER_CONVERSATION) {
          throw tagRefusal(
            'tags',
            `A conversation can have at most ${MAX_TAGS_PER_CONVERSATION} tags.`,
          );
        }
        if (added.length === 0) return { tags: current, added };
        await tx.insert(conversationTags).values(
          added.map((tag) => ({
            id: uuidv7(),
            tenantId: ctx.tenant.id,
            conversationId: conversation.id,
            tag,
          })),
        );
        await emitTenantEvent(tx, ctx.tenant.id, {
          type: 'conversation.tags',
          conversationId: conversation.id,
          assignedMembershipId: conversation.assignedMembershipId,
        });
        return { tags: await tagsOf(tx, ctx.tenant.id, conversation.id), added };
      });
    },

    /** Removes a tag from a conversation the member can see; a tag it does not have is no change. */
    async removeTag(
      ctx: TenantContext,
      input: unknown,
    ): Promise<{ tags: string[]; removed: boolean }> {
      assertCan(ctx, 'inbox.reply');
      const data = parseInput(removeConversationTagSchema, input);
      const tag = normalizeTag(data.tag);
      if (!tag.ok) throw tagRefusal('tag', tag.message);
      return db.run(ctx.scope, async (tx) => {
        const conversation = await lockConversation(tx, ctx, data.conversationId);
        const removed = await tx
          .delete(conversationTags)
          .where(
            and(
              eq(conversationTags.tenantId, ctx.tenant.id),
              eq(conversationTags.conversationId, conversation.id),
              eq(conversationTags.tag, tag.tag),
            ),
          )
          .returning({ id: conversationTags.id });
        if (removed.length > 0) {
          await emitTenantEvent(tx, ctx.tenant.id, {
            type: 'conversation.tags',
            conversationId: conversation.id,
            assignedMembershipId: conversation.assignedMembershipId,
          });
        }
        return {
          tags: await tagsOf(tx, ctx.tenant.id, conversation.id),
          removed: removed.length > 0,
        };
      });
    },

    /**
     * The tags on conversations the member can see, alphabetically, with how many of those
     * conversations have each: what the inbox's filter offers.
     */
    async tagsInUse(ctx: TenantContext): Promise<ConversationTagInUse[]> {
      if (!can(ctx, 'inbox.read_all')) assertCan(ctx, 'inbox.read_assigned');
      // Members who see every conversation read the tags alone; others only those of the
      // conversations assigned to them or to nobody.
      const visible = can(ctx, 'inbox.read_all')
        ? undefined
        : sql`exists (select 1 from app.conversations c
            where c.tenant_id = ${conversationTags.tenantId} and c.id = ${conversationTags.conversationId}
              and (c.assigned_membership_id = ${ctx.membership.id}::uuid
                   or c.assigned_membership_id is null))`;
      return db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({ tag: conversationTags.tag, conversations: sql<number>`count(*)::int` })
            .from(conversationTags)
            .where(and(eq(conversationTags.tenantId, ctx.tenant.id), visible))
            .groupBy(conversationTags.tag)
            .orderBy(asc(conversationTags.tag))
            .limit(TAGS_IN_USE_LIMIT),
        { accessMode: 'read only' },
      );
    },
  };
}

export type ConversationTagsService = ReturnType<typeof createConversationTagsService>;
