import { createHash } from 'node:crypto';
import { AppError, notFound, uuidv7 } from '@w360/core';
import {
  and,
  eq,
  inArray,
  savedReplies,
  savedReplyAttachments,
  savedReplyFiles,
  sql,
  type SavedReplyFileKind,
  type Tx,
} from '@w360/db';
import { checkReplyFile, REPLY_FILE_TYPES, type ReplyFile } from '../messaging/file-replies';
import { mediaFilename } from '../messaging/received-media';

/**
 * Files saved replies carry (ADR-411, W-087). A saved reply may carry one photo, video, recording
 * or document of the types members send from the inbox (ADR-218, `checkReplyFile`). HyFib has no
 * object storage and Meta keeps an upload 30 days for one number (research M-046), so the bytes are
 * kept in `app.saved_reply_files`, once per company: the same bytes, type and name are one row that
 * any number of replies name. Every write here runs under the company's saved-replies lock
 * (`lockSavedReplies`), so a file is never deleted while another write starts to name it, and the
 * company's total is counted without a race.
 */

/** The most bytes a company keeps in saved replies' files, all files together. */
export const SAVED_REPLY_FILES_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

/** A caption's limit, as a file sent from the inbox has it (`fileReplySchema`, research M-191). */
export const SAVED_REPLY_CAPTION_MAX = 1024;

/** A text message's limit, the saved reply's own (`savedReplySchema`). */
export const SAVED_REPLY_TEXT_MAX = 4096;

/** A saved reply's file as members and keys see it: never its bytes or where they are. */
export interface SavedReplyAttachmentView {
  fileId: string;
  kind: SavedReplyFileKind;
  mimeType: string;
  filename: string;
  sizeBytes: number;
}

/**
 * Whether a file of this kind takes the reply's text as its caption: photos, videos and documents
 * do; a recording takes no caption (research M-191), so its reply's text stays a text message.
 */
export function takesCaption(kind: SavedReplyFileKind | null | undefined): boolean {
  return kind === 'image' || kind === 'video' || kind === 'document';
}

/** The most characters a reply's text may have with a file of this kind (or none). */
export function savedReplyTextLimit(kind: SavedReplyFileKind | null | undefined): number {
  return takesCaption(kind) ? SAVED_REPLY_CAPTION_MAX : SAVED_REPLY_TEXT_MAX;
}

/** Refuses a reply's text that a file of this kind cannot carry as its caption. */
export function checkSavedReplyText(body: string, kind: SavedReplyFileKind | null | undefined) {
  if (body.length <= savedReplyTextLimit(kind)) return;
  const message = `With a photo, video or document the reply’s text is its caption, limited to ${SAVED_REPLY_CAPTION_MAX} characters. Shorten the text or remove the file.`;
  throw new AppError('validation_failed', message, { issues: [{ path: 'body', message }] });
}

/**
 * Takes the company's saved-replies lock for the transaction. Every write of saved replies and
 * their files takes it first, before any row lock, so two writes never wait on each other in turn.
 */
export async function lockSavedReplies(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`saved-replies:${tenantId}`}, 0))`,
  );
}

const attachmentColumns = {
  savedReplyId: savedReplyAttachments.savedReplyId,
  fileId: savedReplyFiles.id,
  kind: savedReplyFiles.kind,
  mimeType: savedReplyFiles.mimeType,
  filename: savedReplyFiles.filename,
  sizeBytes: savedReplyFiles.sizeBytes,
};

/** The files of the company's replies (all, or those named), by reply id, without their bytes. */
export async function listSavedReplyAttachments(
  tx: Tx,
  tenantId: string,
  replyIds?: readonly string[],
): Promise<Map<string, SavedReplyAttachmentView>> {
  if (replyIds && replyIds.length === 0) return new Map();
  const rows = await tx
    .select(attachmentColumns)
    .from(savedReplyAttachments)
    .innerJoin(
      savedReplyFiles,
      and(
        eq(savedReplyFiles.tenantId, savedReplyAttachments.tenantId),
        eq(savedReplyFiles.id, savedReplyAttachments.fileId),
      ),
    )
    .where(
      and(
        eq(savedReplyAttachments.tenantId, tenantId),
        replyIds ? inArray(savedReplyAttachments.savedReplyId, [...replyIds]) : undefined,
      ),
    );
  return new Map(rows.map(({ savedReplyId, ...view }) => [savedReplyId, view]));
}

/**
 * Deletes those of the files that no reply names any more. Called under the saved-replies lock, so
 * no other write is about to name one of them.
 */
export async function deleteUnusedSavedReplyFiles(
  tx: Tx,
  tenantId: string,
  fileIds: readonly (string | null)[],
): Promise<number> {
  const ids = [...new Set(fileIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return 0;
  const deleted = await tx
    .delete(savedReplyFiles)
    .where(
      and(
        eq(savedReplyFiles.tenantId, tenantId),
        inArray(savedReplyFiles.id, ids),
        sql`not exists (select 1 from app.saved_reply_attachments a where a.tenant_id = ${savedReplyFiles.tenantId} and a.file_id = ${savedReplyFiles.id})`,
      ),
    )
    .returning({ id: savedReplyFiles.id });
  return deleted.length;
}

/**
 * Deletes every file of the company that no reply names: those a web server of the release before
 * this one left when it deleted a reply (it knows nothing of files; the reply's attachment row goes
 * with the reply). Called under the saved-replies lock before a file is stored, so they never count
 * against the company's total for long.
 */
export async function deleteOrphanedSavedReplyFiles(tx: Tx, tenantId: string): Promise<number> {
  const deleted = await tx
    .delete(savedReplyFiles)
    .where(
      and(
        eq(savedReplyFiles.tenantId, tenantId),
        sql`not exists (select 1 from app.saved_reply_attachments a where a.tenant_id = ${savedReplyFiles.tenantId} and a.file_id = ${savedReplyFiles.id})`,
      ),
    )
    .returning({ id: savedReplyFiles.id });
  return deleted.length;
}

/** The file a reply carries now, or null; under the lock, the reply's row is not read again. */
async function currentFile(tx: Tx, tenantId: string, replyId: string) {
  const [row] = await tx
    .select({ fileId: savedReplyAttachments.fileId, kind: savedReplyFiles.kind })
    .from(savedReplyAttachments)
    .innerJoin(
      savedReplyFiles,
      and(
        eq(savedReplyFiles.tenantId, savedReplyAttachments.tenantId),
        eq(savedReplyFiles.id, savedReplyAttachments.fileId),
      ),
    )
    .where(
      and(
        eq(savedReplyAttachments.tenantId, tenantId),
        eq(savedReplyAttachments.savedReplyId, replyId),
      ),
    );
  return row ?? null;
}

/** The kind of file a reply carries now, or null (for checking its text). */
export async function savedReplyFileKind(
  tx: Tx,
  tenantId: string,
  replyId: string,
): Promise<SavedReplyFileKind | null> {
  return (await currentFile(tx, tenantId, replyId))?.kind ?? null;
}

export interface AttachResult {
  shortcut: string;
  attachment: SavedReplyAttachmentView;
  /** The same bytes, type and name were already stored for another reply and are shared. */
  shared: boolean;
  /** The reply already carried this very file: nothing changed. */
  unchanged: boolean;
  /** The file the reply carried before, deleted if no other reply names it. */
  replacedFileId: string | null;
}

/**
 * Gives a reply this file, in place of any it had (Settings → Saved replies). The file is checked as
 * a file sent from the inbox is, stored once per company within SAVED_REPLY_FILES_MAX_TOTAL_BYTES,
 * and the file it replaces is deleted unless another reply names it. The reply's text must fit a
 * caption when the file takes one. The caller audits it.
 */
export async function writeAttachSavedReplyFile(
  tx: Tx,
  tenantId: string,
  replyId: string,
  file: ReplyFile,
  membershipId: string,
): Promise<AttachResult> {
  const { kind, mimeType } = checkReplyFile(file);
  await lockSavedReplies(tx, tenantId);
  const [reply] = await tx
    .select({ shortcut: savedReplies.shortcut, body: savedReplies.body })
    .from(savedReplies)
    .where(and(eq(savedReplies.tenantId, tenantId), eq(savedReplies.id, replyId)));
  if (!reply) throw notFound('Saved reply');
  checkSavedReplyText(reply.body, kind);
  await deleteOrphanedSavedReplyFiles(tx, tenantId);

  const filename = mediaFilename({ type: kind, mimeType, filename: file.name, messageId: null });
  const sha256 = createHash('sha256').update(file.bytes).digest('hex');
  const sizeBytes = file.bytes.byteLength;
  const [stored] = await tx
    .select({ id: savedReplyFiles.id })
    .from(savedReplyFiles)
    .where(
      and(
        eq(savedReplyFiles.tenantId, tenantId),
        eq(savedReplyFiles.sha256, sha256),
        eq(savedReplyFiles.mimeType, mimeType),
        eq(savedReplyFiles.filename, filename),
      ),
    );
  const previous = await currentFile(tx, tenantId, replyId);
  const attachment: SavedReplyAttachmentView = {
    fileId: stored?.id ?? uuidv7(),
    kind,
    mimeType,
    filename,
    sizeBytes,
  };
  if (stored && previous?.fileId === stored.id) {
    return {
      shortcut: reply.shortcut,
      attachment,
      shared: true,
      unchanged: true,
      replacedFileId: null,
    };
  }
  if (!stored) {
    const [total] = await tx
      .select({ bytes: sql<string>`coalesce(sum(${savedReplyFiles.sizeBytes}), 0)::text` })
      .from(savedReplyFiles)
      .where(eq(savedReplyFiles.tenantId, tenantId));
    // The file being replaced counts until it is deleted, unless another reply still names it.
    const freed =
      previous && !(await namedElsewhere(tx, tenantId, previous.fileId, replyId))
        ? await sizeOf(tx, tenantId, previous.fileId)
        : 0;
    if (Number(total?.bytes ?? 0) - freed + sizeBytes > SAVED_REPLY_FILES_MAX_TOTAL_BYTES) {
      throw new AppError(
        'conflict',
        `Saved replies’ files are limited to ${SAVED_REPLY_FILES_MAX_TOTAL_BYTES / (1024 * 1024)} MB for the company. Remove a file from another saved reply first.`,
      );
    }
    await tx.insert(savedReplyFiles).values({
      id: attachment.fileId,
      tenantId,
      kind,
      mimeType,
      filename,
      sizeBytes,
      sha256,
      content: file.bytes,
      createdByMembershipId: membershipId,
    });
  }
  if (previous) {
    await tx
      .delete(savedReplyAttachments)
      .where(
        and(
          eq(savedReplyAttachments.tenantId, tenantId),
          eq(savedReplyAttachments.savedReplyId, replyId),
        ),
      );
  }
  await tx.insert(savedReplyAttachments).values({
    id: uuidv7(),
    tenantId,
    savedReplyId: replyId,
    fileId: attachment.fileId,
    attachedByMembershipId: membershipId,
  });
  if (previous) await deleteUnusedSavedReplyFiles(tx, tenantId, [previous.fileId]);
  return {
    shortcut: reply.shortcut,
    attachment,
    shared: stored !== undefined,
    unchanged: false,
    replacedFileId: previous?.fileId ?? null,
  };
}

async function namedElsewhere(tx: Tx, tenantId: string, fileId: string, replyId: string) {
  const rows = await tx.execute<{ named: boolean }>(
    sql`select exists (select 1 from app.saved_reply_attachments where tenant_id = ${tenantId} and file_id = ${fileId} and saved_reply_id <> ${replyId}) as named`,
  );
  return rows.rows[0]?.named === true;
}

async function sizeOf(tx: Tx, tenantId: string, fileId: string): Promise<number> {
  const [row] = await tx
    .select({ sizeBytes: savedReplyFiles.sizeBytes })
    .from(savedReplyFiles)
    .where(and(eq(savedReplyFiles.tenantId, tenantId), eq(savedReplyFiles.id, fileId)));
  return row?.sizeBytes ?? 0;
}

/**
 * Takes a reply's file away (Settings → Saved replies), deleting it unless another reply names it;
 * null when the reply has none. Its text is a text message again. The caller audits it.
 */
export async function writeRemoveSavedReplyFile(
  tx: Tx,
  tenantId: string,
  replyId: string,
): Promise<{ shortcut: string; kind: SavedReplyFileKind; fileDeleted: boolean } | null> {
  await lockSavedReplies(tx, tenantId);
  const [reply] = await tx
    .select({ shortcut: savedReplies.shortcut })
    .from(savedReplies)
    .where(and(eq(savedReplies.tenantId, tenantId), eq(savedReplies.id, replyId)));
  if (!reply) throw notFound('Saved reply');
  const previous = await currentFile(tx, tenantId, replyId);
  if (!previous) return null;
  await tx
    .delete(savedReplyAttachments)
    .where(
      and(
        eq(savedReplyAttachments.tenantId, tenantId),
        eq(savedReplyAttachments.savedReplyId, replyId),
      ),
    );
  const deleted = await deleteUnusedSavedReplyFiles(tx, tenantId, [previous.fileId]);
  return { shortcut: reply.shortcut, kind: previous.kind, fileDeleted: deleted > 0 };
}

/**
 * Checks, when a member inserts a reply, that its file is still there and reads back whole: its
 * length and SHA-256 are computed from the stored bytes in the database, which sends none of them,
 * and its type must still be one members send. Null when the reply carries no file.
 */
export async function readableSavedReplyFile(
  tx: Tx,
  tenantId: string,
  replyId: string,
): Promise<(SavedReplyAttachmentView & { readable: boolean }) | null> {
  const [row] = await tx
    .select({
      ...attachmentColumns,
      readable: sql<boolean>`(octet_length(${savedReplyFiles.content}) = ${savedReplyFiles.sizeBytes} and encode(pg_catalog.sha256(${savedReplyFiles.content}), 'hex') = ${savedReplyFiles.sha256})`,
    })
    .from(savedReplyAttachments)
    .innerJoin(
      savedReplyFiles,
      and(
        eq(savedReplyFiles.tenantId, savedReplyAttachments.tenantId),
        eq(savedReplyFiles.id, savedReplyAttachments.fileId),
      ),
    )
    .where(
      and(
        eq(savedReplyAttachments.tenantId, tenantId),
        eq(savedReplyAttachments.savedReplyId, replyId),
      ),
    );
  if (!row) return null;
  const { savedReplyId: _reply, readable, ...view } = row;
  return { ...view, readable: readable === true && REPLY_FILE_TYPES[view.mimeType] === view.kind };
}

/** A stored file with its bytes, for showing it to members (preview); null when there is none. */
export async function savedReplyFileContent(
  tx: Tx,
  tenantId: string,
  fileId: string,
): Promise<{ filename: string; mimeType: string; content: Uint8Array } | null> {
  const [row] = await tx
    .select({
      filename: savedReplyFiles.filename,
      mimeType: savedReplyFiles.mimeType,
      content: savedReplyFiles.content,
    })
    .from(savedReplyFiles)
    .where(and(eq(savedReplyFiles.tenantId, tenantId), eq(savedReplyFiles.id, fileId)));
  return row ?? null;
}
