import { z } from 'zod';
import { notFound } from '@w360/core';
import { and, asc, eq, savedReplies, type Tx } from '@w360/db';
import { recordSystemAudit } from '../audit';
import {
  MAX_SAVED_REPLIES,
  savedReplySchema,
  savedReplyShortcutError,
  writeCreateSavedReply,
  writeDeleteSavedReply,
  writeUpdateSavedReply,
} from '../inbox/saved-replies';
import {
  listSavedReplyAttachments,
  lockSavedReplies,
  type SavedReplyAttachmentView,
} from '../inbox/saved-reply-files';
import type { OutboundDeps } from '../messaging/outbound';
import { parseInput } from '../validation';
import { apiActor, assertAnyScope, assertScope, type ApiContext } from './context';
import {
  claimIdempotencyKey,
  storeIdempotentResponse,
  type ApiResponse,
  type IdempotencyInput,
} from './idempotency';

/**
 * Saved replies through the public API (ADR-291): read by keys that send replies
 * (`messages.reply`) or manage them, and added, changed and deleted with `saved_replies.manage`
 * through the writes Settings → Saved replies uses, recorded as the key's.
 */

/** A saved reply as the API gives it. */
export interface ApiSavedReply {
  id: string;
  /** What members type after / in the reply box to find it. */
  shortcut: string;
  title: string;
  /** The text, with {{name}}, {{agent}} and {{company}} where the reply box fills them in. */
  body: string;
  /** Who added it: a member (never which) or a key, by its id. */
  createdBy: 'member' | 'api';
  createdByApiKeyId: string | null;
  /** Who last changed it, likewise. */
  updatedBy: 'member' | 'api';
  updatedByApiKeyId: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * The file it carries (ADR-411), which the reply box attaches when a member inserts it, or null:
   * its details only, never its content or where it is kept.
   */
  attachment: ApiSavedReplyAttachment | null;
}

/** A saved reply's file as the API describes it (ADR-411). */
export interface ApiSavedReplyAttachment {
  id: string;
  type: 'image' | 'video' | 'audio' | 'document';
  mimeType: string;
  filename: string;
  sizeBytes: number;
  /** Whether the reply's text goes as the file's caption (not for a recording). */
  caption: boolean;
}

/** A saved reply's file as the API gives it. */
export function toApiSavedReplyAttachment(
  view: SavedReplyAttachmentView | null | undefined,
): ApiSavedReplyAttachment | null {
  if (!view) return null;
  return {
    id: view.fileId,
    type: view.kind,
    mimeType: view.mimeType,
    filename: view.filename,
    sizeBytes: view.sizeBytes,
    caption: view.kind !== 'audio',
  };
}

/** What `POST /saved-replies` takes: a reply as members add one in Settings. */
export const apiCreateSavedReplySchema = savedReplySchema.strict();

/** What `PATCH /saved-replies/{id}` takes: any of the three; those left out stay as they are. */
export const apiUpdateSavedReplySchema = savedReplySchema
  .partial()
  .strict()
  .refine((change) => Object.keys(change).length > 0, {
    message: 'Give at least one of `shortcut`, `title` and `body`.',
  });

const replyColumns = {
  id: savedReplies.id,
  shortcut: savedReplies.shortcut,
  title: savedReplies.title,
  body: savedReplies.body,
  createdByApiKeyId: savedReplies.createdByApiKeyId,
  updatedByMembershipId: savedReplies.updatedByMembershipId,
  updatedByApiKeyId: savedReplies.updatedByApiKeyId,
  createdAt: savedReplies.createdAt,
  updatedAt: savedReplies.updatedAt,
};

/**
 * A saved reply row as the API gives it. The last editor is the member when one is named, otherwise
 * the key: a server from before ADR-291 names its member and leaves the key's column as it was.
 */
export function toApiSavedReply(
  row: {
    id: string;
    shortcut: string;
    title: string;
    body: string;
    createdByApiKeyId: string | null;
    updatedByMembershipId: string | null;
    updatedByApiKeyId: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  attachment: SavedReplyAttachmentView | null = null,
): ApiSavedReply {
  return {
    id: row.id,
    shortcut: row.shortcut,
    title: row.title,
    body: row.body,
    createdBy: row.createdByApiKeyId ? 'api' : 'member',
    createdByApiKeyId: row.createdByApiKeyId,
    updatedBy: row.updatedByMembershipId ? 'member' : 'api',
    updatedByApiKeyId: row.updatedByMembershipId ? null : row.updatedByApiKeyId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    attachment: toApiSavedReplyAttachment(attachment),
  };
}

async function readApiSavedReply(tx: Tx, tenantId: string, id: string): Promise<ApiSavedReply> {
  const [row] = await tx
    .select(replyColumns)
    .from(savedReplies)
    .where(and(eq(savedReplies.tenantId, tenantId), eq(savedReplies.id, id)));
  if (!row) throw notFound('Saved reply');
  const files = await listSavedReplyAttachments(tx, tenantId, [id]);
  return toApiSavedReply(row, files.get(row.id) ?? null);
}

const isUuid = (id: string) => z.uuid().safeParse(id).success;

/**
 * The company's saved replies by shortcut, all of them (a company keeps at most 500). Reading works
 * while the company is suspended.
 */
export async function apiListSavedReplies(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
): Promise<{ data: ApiSavedReply[] }> {
  assertAnyScope(ctx, ['messages.reply', 'saved_replies.manage']);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const rows = await tx
        .select(replyColumns)
        .from(savedReplies)
        .where(eq(savedReplies.tenantId, ctx.tenant.id))
        .orderBy(asc(savedReplies.shortcut))
        .limit(MAX_SAVED_REPLIES);
      const files = await listSavedReplyAttachments(tx, ctx.tenant.id);
      return { data: rows.map((row) => toApiSavedReply(row, files.get(row.id) ?? null)) };
    },
    { accessMode: 'read only' },
  );
}

/**
 * Adds a saved reply as members do in Settings (409 for a shortcut in use or at the limit), and
 * answers it. Once per `Idempotency-Key` when one is given.
 */
export async function apiCreateSavedReply(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput | null,
): Promise<ApiResponse> {
  assertScope(ctx, 'saved_replies.manage');
  const data = parseInput(apiCreateSavedReplySchema, input);
  const now = deps.clock.now();
  try {
    return await deps.db.run(ctx.scope, async (tx) => {
      // Claimed in the reply's transaction, so a refused reply leaves the key unused.
      let claimed: string | null = null;
      if (idempotency) {
        const claim = await claimIdempotencyKey(tx, ctx, idempotency, now);
        if ('replay' in claim) return claim.replay;
        claimed = claim.claimed;
      }
      const id = await writeCreateSavedReply(tx, ctx.tenant.id, data, { apiKeyId: ctx.key.id });
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action: 'saved_reply.created',
          subjectType: 'saved_reply',
          subjectId: id,
          correlationId: ctx.requestId,
          metadata: { shortcut: data.shortcut, source: 'api' },
        },
        apiActor(ctx),
      );
      const response = {
        status: 201,
        body: { data: await readApiSavedReply(tx, ctx.tenant.id, id) },
      };
      if (claimed) await storeIdempotentResponse(tx, ctx, claimed, response);
      return { ...response, replayed: false };
    });
  } catch (error) {
    throw savedReplyShortcutError(error);
  }
}

/**
 * Changes what is given of a saved reply, the rest kept, as members save it in Settings, and
 * answers it. A change that leaves it as it is answers it as it is, with no audit entry, so a retry
 * needs no key.
 */
export async function apiUpdateSavedReply(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  id: string,
  input: unknown,
): Promise<ApiSavedReply> {
  assertScope(ctx, 'saved_replies.manage');
  if (!isUuid(id)) throw notFound('Saved reply');
  const change = parseInput(apiUpdateSavedReplySchema, input);
  try {
    return await deps.db.run(ctx.scope, async (tx) => {
      // The company's lock before the reply's row lock, as every saved-reply write takes them.
      await lockSavedReplies(tx, ctx.tenant.id);
      const [current] = await tx
        .select({
          shortcut: savedReplies.shortcut,
          title: savedReplies.title,
          body: savedReplies.body,
        })
        .from(savedReplies)
        .where(and(eq(savedReplies.tenantId, ctx.tenant.id), eq(savedReplies.id, id)))
        .for('update');
      if (!current) throw notFound('Saved reply');
      const data = { ...current, ...change };
      if (
        data.shortcut !== current.shortcut ||
        data.title !== current.title ||
        data.body !== current.body
      ) {
        await writeUpdateSavedReply(tx, ctx.tenant.id, id, data, { apiKeyId: ctx.key.id });
        await recordSystemAudit(
          tx,
          ctx.tenant.id,
          {
            action: 'saved_reply.updated',
            subjectType: 'saved_reply',
            subjectId: id,
            correlationId: ctx.requestId,
            metadata: { shortcut: data.shortcut, source: 'api' },
          },
          apiActor(ctx),
        );
      }
      return readApiSavedReply(tx, ctx.tenant.id, id);
    });
  } catch (error) {
    throw savedReplyShortcutError(error);
  }
}

/** Deletes a saved reply as members do in Settings. One already deleted answers 404. */
export async function apiDeleteSavedReply(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  id: string,
): Promise<{ id: string; deleted: true }> {
  assertScope(ctx, 'saved_replies.manage');
  if (!isUuid(id)) throw notFound('Saved reply');
  return deps.db.run(ctx.scope, async (tx) => {
    const deleted = await writeDeleteSavedReply(tx, ctx.tenant.id, id);
    if (!deleted) throw notFound('Saved reply');
    await recordSystemAudit(
      tx,
      ctx.tenant.id,
      {
        action: 'saved_reply.deleted',
        subjectType: 'saved_reply',
        subjectId: id,
        correlationId: ctx.requestId,
        metadata: { shortcut: deleted.shortcut, source: 'api' },
      },
      apiActor(ctx),
    );
    return { id, deleted: true };
  });
}
