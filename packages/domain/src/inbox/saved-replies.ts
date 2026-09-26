import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  contactIdentities,
  contacts,
  conversations,
  eq,
  isUniqueViolation,
  memberships,
  savedReplies,
  users,
  type Database,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { recordAudit, type RequestMeta } from '../audit';
import { canSeeConversation } from '../messaging/outbound';
import { parseInput } from '../validation';

/**
 * Saved replies: shared answers members insert into the composer. `inbox.supervise` manages them;
 * anyone who can reply uses them. Placeholders are filled in for the conversation before the
 * member reviews the text, so nothing is sent without being read first.
 */
export const SAVED_REPLY_PLACEHOLDERS = ['name', 'agent', 'company'] as const;
type Placeholder = (typeof SAVED_REPLY_PLACEHOLDERS)[number];
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;

export const savedReplySchema = z.object({
  shortcut: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9][a-z0-9_-]{0,31}$/,
      'Use 1 to 32 lower-case letters, digits, hyphens or underscores for the shortcut.',
    ),
  title: z.string().trim().min(1, 'Enter a title.').max(80, 'Use at most 80 characters.'),
  body: z
    .string()
    .trim()
    .min(1, 'Write the reply.')
    .max(4096, 'WhatsApp text messages are limited to 4096 characters.')
    .superRefine((body, ctx) => {
      for (const match of body.matchAll(PLACEHOLDER_RE)) {
        const name = (match[1] ?? '').toLowerCase();
        if (!(SAVED_REPLY_PLACEHOLDERS as readonly string[]).includes(name)) {
          ctx.addIssue({
            code: 'custom',
            message: `Unknown placeholder ${match[0]}. Use {{name}}, {{agent}} or {{company}}.`,
          });
          return;
        }
      }
    }),
});

export interface SavedReplyView {
  id: string;
  shortcut: string;
  title: string;
  body: string;
  updatedAt: string;
  updatedByName: string | null;
}

/** Fills placeholders; values that are unknown (for example a contact without a name) are empty. */
export function renderSavedReply(
  body: string,
  values: Record<Placeholder, string | null>,
): { text: string; missing: Placeholder[] } {
  const missing = new Set<Placeholder>();
  const text = body.replace(PLACEHOLDER_RE, (whole, raw: string) => {
    const name = raw.toLowerCase() as Placeholder;
    if (!(SAVED_REPLY_PLACEHOLDERS as readonly string[]).includes(name)) return whole;
    const value = values[name];
    if (!value) missing.add(name);
    return value ?? '';
  });
  return { text, missing: [...missing] };
}

export function createSavedRepliesService(deps: { db: Database; clock: Clock }) {
  const { db } = deps;

  const duplicate = () =>
    new AppError('conflict', 'Another saved reply already uses this shortcut.');

  return {
    async listSavedReplies(ctx: TenantContext): Promise<SavedReplyView[]> {
      if (!can(ctx, 'inbox.supervise')) assertCan(ctx, 'inbox.reply');
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: savedReplies.id,
              shortcut: savedReplies.shortcut,
              title: savedReplies.title,
              body: savedReplies.body,
              updatedAt: savedReplies.updatedAt,
              updatedByName: users.name,
            })
            .from(savedReplies)
            .leftJoin(
              memberships,
              and(
                eq(memberships.tenantId, savedReplies.tenantId),
                eq(memberships.id, savedReplies.updatedByMembershipId),
              ),
            )
            .leftJoin(users, eq(users.id, memberships.userId))
            .where(eq(savedReplies.tenantId, ctx.tenant.id))
            .orderBy(asc(savedReplies.shortcut))
            .limit(500),
        { accessMode: 'read only' },
      );
      return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
    },

    /** Saved replies with placeholders filled for one conversation the member can see. */
    async savedRepliesFor(ctx: TenantContext, conversationId: string) {
      assertCan(ctx, 'inbox.reply');
      if (!z.uuid().safeParse(conversationId).success) throw notFound('Conversation');
      return db.run(
        ctx.scope,
        async (tx) => {
          const [conv] = await tx
            .select({
              assignedMembershipId: conversations.assignedMembershipId,
              contactName: contacts.displayName,
              profileName: contactIdentities.profileName,
            })
            .from(conversations)
            .innerJoin(
              contacts,
              and(
                eq(contacts.tenantId, conversations.tenantId),
                eq(contacts.id, conversations.contactId),
              ),
            )
            .leftJoin(
              contactIdentities,
              and(
                eq(contactIdentities.tenantId, conversations.tenantId),
                eq(contactIdentities.contactId, conversations.contactId),
              ),
            )
            .where(
              and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversationId)),
            )
            .limit(1);
          if (!conv || !canSeeConversation(ctx, conv.assignedMembershipId))
            throw notFound('Conversation');
          const rows = await tx
            .select({
              id: savedReplies.id,
              shortcut: savedReplies.shortcut,
              title: savedReplies.title,
              body: savedReplies.body,
            })
            .from(savedReplies)
            .where(eq(savedReplies.tenantId, ctx.tenant.id))
            .orderBy(asc(savedReplies.shortcut))
            .limit(500);
          const values = {
            name: conv.contactName ?? conv.profileName ?? null,
            agent: ctx.user.name || null,
            company: ctx.tenant.name,
          };
          return rows.map((r) => {
            const rendered = renderSavedReply(r.body, values);
            return {
              id: r.id,
              shortcut: r.shortcut,
              title: r.title,
              text: rendered.text,
              missing: rendered.missing,
            };
          });
        },
        { accessMode: 'read only' },
      );
    },

    async createSavedReply(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<{ id: string }> {
      assertCan(ctx, 'inbox.supervise');
      const data = parseInput(savedReplySchema, input);
      const id = uuidv7();
      try {
        await db.run(ctx.scope, async (tx) => {
          await tx.insert(savedReplies).values({
            id,
            tenantId: ctx.tenant.id,
            shortcut: data.shortcut,
            title: data.title,
            body: data.body,
            createdByMembershipId: ctx.membership.id,
            updatedByMembershipId: ctx.membership.id,
          });
          await recordAudit(
            tx,
            ctx,
            {
              action: 'saved_reply.created',
              subjectType: 'saved_reply',
              subjectId: id,
              metadata: { shortcut: data.shortcut },
            },
            meta,
          );
        });
      } catch (error) {
        if (isUniqueViolation(error, 'saved_replies_shortcut_uq')) throw duplicate();
        throw error;
      }
      return { id };
    },

    async updateSavedReply(
      ctx: TenantContext,
      id: string,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<void> {
      assertCan(ctx, 'inbox.supervise');
      if (!z.uuid().safeParse(id).success) throw notFound('Saved reply');
      const data = parseInput(savedReplySchema, input);
      try {
        await db.run(ctx.scope, async (tx) => {
          const [updated] = await tx
            .update(savedReplies)
            .set({
              shortcut: data.shortcut,
              title: data.title,
              body: data.body,
              updatedByMembershipId: ctx.membership.id,
            })
            .where(and(eq(savedReplies.tenantId, ctx.tenant.id), eq(savedReplies.id, id)))
            .returning({ id: savedReplies.id });
          if (!updated) throw notFound('Saved reply');
          await recordAudit(
            tx,
            ctx,
            {
              action: 'saved_reply.updated',
              subjectType: 'saved_reply',
              subjectId: id,
              metadata: { shortcut: data.shortcut },
            },
            meta,
          );
        });
      } catch (error) {
        if (isUniqueViolation(error, 'saved_replies_shortcut_uq')) throw duplicate();
        throw error;
      }
    },

    async deleteSavedReply(ctx: TenantContext, id: string, meta: RequestMeta = {}) {
      assertCan(ctx, 'inbox.supervise');
      if (!z.uuid().safeParse(id).success) throw notFound('Saved reply');
      await db.run(ctx.scope, async (tx) => {
        const [deleted] = await tx
          .delete(savedReplies)
          .where(and(eq(savedReplies.tenantId, ctx.tenant.id), eq(savedReplies.id, id)))
          .returning({ shortcut: savedReplies.shortcut });
        if (!deleted) throw notFound('Saved reply');
        await recordAudit(
          tx,
          ctx,
          {
            action: 'saved_reply.deleted',
            subjectType: 'saved_reply',
            subjectId: id,
            metadata: { shortcut: deleted.shortcut },
          },
          meta,
        );
      });
    },
  };
}

export type SavedRepliesService = ReturnType<typeof createSavedRepliesService>;
