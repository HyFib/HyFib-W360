import { z } from 'zod';
import { AppError, type Keyring } from '@w360/core';
import {
  and,
  eq,
  messages,
  savedReplyAttachments,
  savedReplyFiles,
  whatsappAccounts,
} from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
import { credentialAad } from './credentials';
import type { GraphClient, GraphFailureKind } from './graph';
import { prepareReply, queueReply, type OutboundDeps, type ReplyBody } from './outbound';
import { baseMediaType, mediaFilename } from './received-media';

/**
 * Files members send from the inbox (ADR-218). The file is uploaded to WhatsApp for the
 * conversation's number when the member sends it, and the reply names the media id Meta answers;
 * HyFib keeps no copy, and the conversation shows the file as WhatsApp keeps it (ADR-216).
 */

/** The file types a member can send, and the kind of message each goes as. */
export const REPLY_FILE_TYPES: Readonly<Record<string, 'image' | 'video' | 'audio' | 'document'>> =
  {
    'image/jpeg': 'image',
    'image/png': 'image',
    'video/mp4': 'video',
    'video/3gpp': 'video',
    'audio/aac': 'audio',
    'audio/amr': 'audio',
    'audio/mp4': 'audio',
    'audio/mpeg': 'audio',
    'audio/ogg': 'audio',
    'application/pdf': 'document',
    'text/plain': 'document',
    'application/msword': 'document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
    'application/vnd.ms-excel': 'document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
    'application/vnd.ms-powerpoint': 'document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'document',
  };

/** The largest file a member sends through HyFib's servers. */
export const REPLY_FILE_MAX_BYTES = 16 * 1024 * 1024;

/** How long Meta keeps a file uploaded for a number to send (research M-046). */
export const UPLOADED_MEDIA_LIFETIME_MS = 30 * 24 * 3600_000;

/** What the conversation's list shows for a file sent without a caption. */
const FILE_PREVIEWS = { image: 'Photo', video: 'Video', audio: 'Audio', document: 'Document' };

export const fileReplySchema = z.object({
  conversationId: z.uuid(),
  clientKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  /** Shown under a photo, a video or a document; a recording takes none (research M-191). */
  caption: z
    .string()
    .trim()
    .max(1024, 'Captions are limited to 1024 characters')
    .transform((value) => value || undefined)
    .optional(),
  afterMessageId: z.uuid().optional(),
});

/**
 * A saved reply's file a member inserted in the reply box (ADR-411): the reply and the file it
 * carried then, sent only while the reply still carries that very file.
 */
export const savedReplyFileReplySchema = fileReplySchema.extend({
  savedReplyId: z.uuid(),
  savedReplyFileId: z.uuid(),
});

export interface ReplyFile {
  name: string;
  type: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/** The kind of message a file goes as, its type and its name, or why it cannot be sent. */
export function checkReplyFile(file: ReplyFile): {
  kind: 'image' | 'video' | 'audio' | 'document';
  mimeType: string;
} {
  const fail = (message: string) =>
    new AppError('validation_failed', message, { issues: [{ path: 'file', message }] });
  if (file.bytes.byteLength === 0) throw fail('Choose a file to send.');
  if (file.bytes.byteLength > REPLY_FILE_MAX_BYTES) throw fail('Files are limited to 16 MB.');
  const mimeType = baseMediaType(file.type);
  const kind = mimeType ? REPLY_FILE_TYPES[mimeType] : undefined;
  if (!mimeType || !kind) {
    throw fail(
      'Send a JPEG or PNG photo, an MP4 or 3GPP video, an AAC, AMR, MP3, MP4 or OGG recording, or a PDF, text, Word, Excel or PowerPoint document.',
    );
  }
  return { kind, mimeType };
}

/** What a refused upload tells the member. */
export function uploadFailure(failure: {
  kind: GraphFailureKind;
  title: string;
  detail?: string;
}): AppError {
  if (failure.kind === 'auth') {
    return new AppError(
      'precondition_failed',
      'WhatsApp refused HyFib’s access to this number’s account. An administrator can reconnect it in Settings → Channels.',
    );
  }
  if (failure.kind === 'permanent') {
    return new AppError(
      'provider_rejected',
      `WhatsApp did not accept the file${failure.detail ? `: ${failure.detail}` : '.'}`,
    );
  }
  return new AppError(
    'provider_unavailable',
    'WhatsApp did not answer, so the file was not sent. Try again in a moment.',
  );
}

/** Parses a file reply's form fields, naming the first problem. */
function parseFileInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new AppError('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid file', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

export interface FileRepliesDeps extends OutboundDeps {
  keyring: Keyring;
  graph: Pick<GraphClient, 'uploadMedia'>;
}

export function createFileRepliesService(deps: FileRepliesDeps) {
  /**
   * Checks the reply as a text reply is, reads the file, uploads it for the conversation's number,
   * then queues a reply naming the media. A retry of the same submission returns the first message
   * without reading or uploading the file again. If the reply is refused after the upload, the
   * media is never sent and Meta deletes it.
   */
  async function sendFile(
    ctx: TenantContext,
    data: z.output<typeof fileReplySchema>,
    load: () => Promise<ReplyFile>,
  ) {
    // A retry of a sent file answers the first message without uploading it again.
    const [duplicate] = await deps.db.run(
      ctx.scope,
      (tx) =>
        tx
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.tenantId, ctx.tenant.id), eq(messages.clientKey, data.clientKey))),
      { accessMode: 'read only' },
    );
    if (duplicate) return { messageId: duplicate.id, duplicate: true };

    const route = await prepareReply(deps, ctx, data.conversationId);
    const file = await load();
    const { kind, mimeType } = checkReplyFile(file);
    const [account] = await deps.db.run(
      ctx.scope,
      (tx) =>
        tx
          .select({
            status: whatsappAccounts.status,
            credential: whatsappAccounts.credentialCiphertext,
          })
          .from(whatsappAccounts)
          .where(
            and(
              eq(whatsappAccounts.tenantId, ctx.tenant.id),
              eq(whatsappAccounts.id, route.whatsappAccountId),
            ),
          ),
      { accessMode: 'read only' },
    );
    if (!account || account.status !== 'connected' || !account.credential) {
      throw new AppError(
        'precondition_failed',
        'This number’s WhatsApp account is disconnected. Reconnect it in Settings → Channels.',
      );
    }
    const token = deps.keyring.decryptString(
      account.credential,
      credentialAad(ctx.tenant.id, route.whatsappAccountId),
    );
    const filename = mediaFilename({
      type: kind,
      mimeType,
      filename: file.name,
      messageId: null,
    });
    const uploaded = await deps.graph.uploadMedia(route.phoneNumberId, token, {
      filename,
      contentType: mimeType,
      bytes: file.bytes,
    });
    if (!uploaded.ok) throw uploadFailure(uploaded);

    const caption = kind === 'audio' ? undefined : data.caption;
    const media = {
      id: uploaded.data.mediaId,
      ...(caption ? { caption } : {}),
      // The spec's examples send a document's file name with its id (research M-197).
      ...(kind === 'document' ? { filename } : {}),
    };
    const body: ReplyBody = {
      type: kind,
      content: { ...media, mime_type: mimeType },
      payload: { [kind]: media },
      preview: caption ?? FILE_PREVIEWS[kind],
      media: {
        providerMediaId: uploaded.data.mediaId,
        mimeType,
        filename: kind === 'document' ? filename : null,
        sizeBytes: file.bytes.byteLength,
      },
    };
    return queueReply(deps, ctx, data, body);
  }

  return {
    /** Sends a file the member chose, in a conversation the member can reply in (ADR-218). */
    async queueFileReply(ctx: TenantContext, input: unknown, file: ReplyFile) {
      assertCan(ctx, 'inbox.reply');
      const data = parseFileInput(fileReplySchema, input);
      checkReplyFile(file);
      return sendFile(ctx, data, () => Promise.resolve(file));
    },

    /**
     * Sends the file of a saved reply a member inserted in the reply box (ADR-411), as a file the
     * member chose is sent: the same checks, upload and queueing. Its bytes are read from the
     * company's saved replies' files only while the reply still carries the file the member
     * reviewed; otherwise nothing is sent and the member is asked to insert the reply again.
     */
    async queueSavedReplyFileReply(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'inbox.reply');
      const data = parseFileInput(savedReplyFileReplySchema, input);
      return sendFile(ctx, data, async () => {
        const [row] = await deps.db.run(
          ctx.scope,
          (tx) =>
            tx
              .select({
                filename: savedReplyFiles.filename,
                mimeType: savedReplyFiles.mimeType,
                content: savedReplyFiles.content,
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
                  eq(savedReplyAttachments.tenantId, ctx.tenant.id),
                  eq(savedReplyAttachments.savedReplyId, data.savedReplyId),
                  eq(savedReplyAttachments.fileId, data.savedReplyFileId),
                ),
              ),
          { accessMode: 'read only' },
        );
        if (!row) {
          throw new AppError(
            'conflict',
            'This saved reply’s file was changed or removed after you inserted it, so nothing was sent. Insert the reply again.',
          );
        }
        return {
          name: row.filename,
          type: row.mimeType,
          // The driver's bytes, not copied again (a 16 MB file is already read twice over).
          bytes: row.content as Uint8Array<ArrayBuffer>,
        };
      });
    },
  };
}

export type FileRepliesService = ReturnType<typeof createFileRepliesService>;
