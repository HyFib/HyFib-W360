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
  sql,
  users,
  type Database,
  type Tx,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { recordAudit, type RequestMeta } from '../audit';
import { canSeeConversation } from '../messaging/outbound';
import { checkReplyFile, type ReplyFile } from '../messaging/file-replies';
import { parseInput } from '../validation';
import {
  checkSavedReplyText,
  deleteUnusedSavedReplyFiles,
  listSavedReplyAttachments,
  lockSavedReplies,
  readableSavedReplyFile,
  savedReplyFileContent,
  savedReplyFileKind,
  takesCaption,
  writeAttachSavedReplyFile,
  writeRemoveSavedReplyFile,
  type SavedReplyAttachmentView,
} from './saved-reply-files';

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
  /** Last changed by an API key (ADR-291), which has no name to show. */
  updatedThroughApi: boolean;
  /** The file it carries (ADR-411), or null. */
  attachment: SavedReplyAttachmentView | null;
}

export type SavedReplyInput = z.output<typeof savedReplySchema>;

/**
 * The most saved replies a company keeps (ADR-291): Settings and the reply box list them all, and
 * listed them only up to this many before.
 */
export const MAX_SAVED_REPLIES = 500;

/**
 * Who adds or changes a saved reply: a member, or a key since ADR-291. The last editor is the member
 * when one is named, otherwise the key: a server from before ADR-291 names its member and leaves the
 * key's column as it was.
 */
export type SavedReplyAuthor = { membershipId: string } | { apiKeyId: string };

const authorOf = (by: SavedReplyAuthor) => ({
  membershipId: 'membershipId' in by ? by.membershipId : null,
  apiKeyId: 'apiKeyId' in by ? by.apiKeyId : null,
});

/** A shortcut another saved reply has, as a conflict; any other error as it is. */
export function savedReplyShortcutError(error: unknown): unknown {
  return isUniqueViolation(error, 'saved_replies_shortcut_uq')
    ? new AppError('conflict', 'Another saved reply already uses this shortcut.')
    : error;
}

/**
 * Adds a saved reply (Settings, and keys since ADR-291) within MAX_SAVED_REPLIES, counted under the
 * company's lock so two additions at once never pass it. The caller audits it and maps a shortcut in
 * use with `savedReplyShortcutError`.
 */
export async function writeCreateSavedReply(
  tx: Tx,
  tenantId: string,
  data: SavedReplyInput,
  by: SavedReplyAuthor,
): Promise<string> {
  await lockSavedReplies(tx, tenantId);
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(savedReplies)
    .where(eq(savedReplies.tenantId, tenantId));
  if ((count?.n ?? 0) >= MAX_SAVED_REPLIES) {
    throw new AppError(
      'conflict',
      `The company already has ${MAX_SAVED_REPLIES} saved replies. Delete one before adding another.`,
    );
  }
  const id = uuidv7();
  const author = authorOf(by);
  await tx.insert(savedReplies).values({
    id,
    tenantId,
    shortcut: data.shortcut,
    title: data.title,
    body: data.body,
    createdByMembershipId: author.membershipId,
    createdByApiKeyId: author.apiKeyId,
    updatedByMembershipId: author.membershipId,
    updatedByApiKeyId: author.apiKeyId,
  });
  return id;
}

/**
 * Changes a saved reply (Settings, and keys since ADR-291), naming who changed it last; false when
 * the company has no such reply. With a photo, video or document (ADR-411) the text is its caption
 * and must fit one. The caller audits it and maps a shortcut in use with `savedReplyShortcutError`.
 */
export async function writeUpdateSavedReply(
  tx: Tx,
  tenantId: string,
  id: string,
  data: SavedReplyInput,
  by: SavedReplyAuthor,
): Promise<boolean> {
  await lockSavedReplies(tx, tenantId);
  checkSavedReplyText(data.body, await savedReplyFileKind(tx, tenantId, id));
  const author = authorOf(by);
  const [updated] = await tx
    .update(savedReplies)
    .set({
      shortcut: data.shortcut,
      title: data.title,
      body: data.body,
      updatedByMembershipId: author.membershipId,
      updatedByApiKeyId: author.apiKeyId,
    })
    .where(and(eq(savedReplies.tenantId, tenantId), eq(savedReplies.id, id)))
    .returning({ id: savedReplies.id });
  return updated !== undefined;
}

/**
 * Deletes a saved reply (Settings, and keys since ADR-291); null when the company has no such reply.
 * Its file (ADR-411) goes with it unless another reply carries the same file.
 */
export async function writeDeleteSavedReply(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<{ shortcut: string } | null> {
  await lockSavedReplies(tx, tenantId);
  const attached = (await listSavedReplyAttachments(tx, tenantId, [id])).get(id) ?? null;
  const [deleted] = await tx
    .delete(savedReplies)
    .where(and(eq(savedReplies.tenantId, tenantId), eq(savedReplies.id, id)))
    .returning({ shortcut: savedReplies.shortcut });
  if (!deleted) return null;
  // The reply's attachment row went with it (ON DELETE CASCADE).
  await deleteUnusedSavedReplyFiles(tx, tenantId, [attached?.fileId ?? null]);
  return deleted;
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
              updatedByMembershipId: savedReplies.updatedByMembershipId,
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
      const files = await db.run(ctx.scope, (tx) => listSavedReplyAttachments(tx, ctx.tenant.id), {
        accessMode: 'read only',
      });
      return rows.map(({ updatedByMembershipId, ...r }) => ({
        ...r,
        updatedAt: r.updatedAt.toISOString(),
        updatedThroughApi: updatedByMembershipId === null,
        attachment: files.get(r.id) ?? null,
      }));
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
          const files = await listSavedReplyAttachments(tx, ctx.tenant.id);
          return rows.map((r) => {
            const rendered = renderSavedReply(r.body, values);
            return {
              id: r.id,
              shortcut: r.shortcut,
              title: r.title,
              text: rendered.text,
              missing: rendered.missing,
              attachment: files.get(r.id) ?? null,
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
      try {
        return await db.run(ctx.scope, async (tx) => {
          const id = await writeCreateSavedReply(tx, ctx.tenant.id, data, {
            membershipId: ctx.membership.id,
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
          return { id };
        });
      } catch (error) {
        throw savedReplyShortcutError(error);
      }
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
          const updated = await writeUpdateSavedReply(tx, ctx.tenant.id, id, data, {
            membershipId: ctx.membership.id,
          });
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
        throw savedReplyShortcutError(error);
      }
    },

    /**
     * Gives a saved reply a file, in place of any it had (ADR-411): stored once per company, the
     * replaced file deleted unless another reply carries it. Audited with its kind and size, never
     * its name or content.
     */
    async attachSavedReplyFile(
      ctx: TenantContext,
      id: string,
      file: ReplyFile,
      meta: RequestMeta = {},
    ): Promise<SavedReplyAttachmentView> {
      assertCan(ctx, 'inbox.supervise');
      if (!z.uuid().safeParse(id).success) throw notFound('Saved reply');
      checkReplyFile(file);
      return db.run(ctx.scope, async (tx) => {
        const result = await writeAttachSavedReplyFile(
          tx,
          ctx.tenant.id,
          id,
          file,
          ctx.membership.id,
        );
        if (!result.unchanged) {
          await recordAudit(
            tx,
            ctx,
            {
              action: 'saved_reply.file_attached',
              subjectType: 'saved_reply',
              subjectId: id,
              metadata: {
                shortcut: result.shortcut,
                kind: result.attachment.kind,
                sizeBytes: result.attachment.sizeBytes,
                shared: result.shared,
                replaced: result.replacedFileId !== null,
              },
            },
            meta,
          );
        }
        return result.attachment;
      });
    },

    /** Takes a saved reply's file away (ADR-411); 404 when the reply has none. */
    async removeSavedReplyFile(ctx: TenantContext, id: string, meta: RequestMeta = {}) {
      assertCan(ctx, 'inbox.supervise');
      if (!z.uuid().safeParse(id).success) throw notFound('Saved reply');
      await db.run(ctx.scope, async (tx) => {
        const removed = await writeRemoveSavedReplyFile(tx, ctx.tenant.id, id);
        if (!removed) throw notFound('Saved reply file');
        await recordAudit(
          tx,
          ctx,
          {
            action: 'saved_reply.file_removed',
            subjectType: 'saved_reply',
            subjectId: id,
            metadata: {
              shortcut: removed.shortcut,
              kind: removed.kind,
              fileDeleted: removed.fileDeleted,
            },
          },
          meta,
        );
      });
    },

    /**
     * What the reply box attaches when a member inserts a saved reply with a file (ADR-411), in a
     * conversation the member can see: the file's details once it is known to be there and to read
     * back whole. A file that is gone or unreadable is refused here, before anything is attached,
     * rather than when the member sends. Members who reply use it; managing replies is not needed.
     */
    async savedReplyFileForInsert(
      ctx: TenantContext,
      conversationId: string,
      savedReplyId: string,
    ): Promise<SavedReplyAttachmentView & { caption: boolean }> {
      assertCan(ctx, 'inbox.reply');
      if (!z.uuid().safeParse(conversationId).success) throw notFound('Conversation');
      if (!z.uuid().safeParse(savedReplyId).success) throw notFound('Saved reply');
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
          const [reply] = await tx
            .select({ title: savedReplies.title })
            .from(savedReplies)
            .where(
              and(eq(savedReplies.tenantId, ctx.tenant.id), eq(savedReplies.id, savedReplyId)),
            );
          if (!reply) {
            throw new AppError(
              'conflict',
              'This saved reply was deleted after the page loaded. Reload the page to see the saved replies as they are now.',
            );
          }
          const file = await readableSavedReplyFile(tx, ctx.tenant.id, savedReplyId);
          if (!file) {
            throw new AppError(
              'conflict',
              `The file of “${reply.title}” was removed after the page loaded, so nothing was inserted. Reload the page to see the saved reply as it is now.`,
            );
          }
          if (!file.readable) {
            throw new AppError(
              'precondition_failed',
              `The file of “${reply.title}” can no longer be read, so nothing was inserted. A supervisor can attach it again in Settings → Saved replies.`,
            );
          }
          const { readable: _readable, ...view } = file;
          return { ...view, caption: takesCaption(view.kind) };
        },
        { accessMode: 'read only' },
      );
    },

    /**
     * A saved reply's file for members to look at (Settings and the reply box): anyone who uses or
     * manages saved replies. Null when it is gone.
     */
    async openSavedReplyFile(ctx: TenantContext, fileId: string) {
      if (!can(ctx, 'inbox.supervise')) assertCan(ctx, 'inbox.reply');
      if (!z.uuid().safeParse(fileId).success) return null;
      return db.run(ctx.scope, (tx) => savedReplyFileContent(tx, ctx.tenant.id, fileId), {
        accessMode: 'read only',
      });
    },

    async deleteSavedReply(ctx: TenantContext, id: string, meta: RequestMeta = {}) {
      assertCan(ctx, 'inbox.supervise');
      if (!z.uuid().safeParse(id).success) throw notFound('Saved reply');
      await db.run(ctx.scope, async (tx) => {
        const deleted = await writeDeleteSavedReply(tx, ctx.tenant.id, id);
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
