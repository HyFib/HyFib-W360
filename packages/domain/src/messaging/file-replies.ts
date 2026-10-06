import { z } from 'zod';
import { AppError, type Keyring } from '@w360/core';
import { and, eq, messages, whatsappAccounts } from '@w360/db';
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

export interface FileRepliesDeps extends OutboundDeps {
  keyring: Keyring;
  graph: Pick<GraphClient, 'uploadMedia'>;
}

export function createFileRepliesService(deps: FileRepliesDeps) {
  return {
    /**
     * Sends a file in a conversation the member can reply in: checked as a text reply is, uploaded
     * for the conversation's number, then queued as a reply naming the media. A retry of the same
     * submission returns the first message without uploading again. If the reply is refused after
     * the upload, the media is never sent and Meta deletes it.
     */
    async queueFileReply(ctx: TenantContext, input: unknown, file: ReplyFile) {
      assertCan(ctx, 'inbox.reply');
      const parsed = fileReplySchema.safeParse(input);
      if (!parsed.success) {
        throw new AppError('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid file', {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      const data = parsed.data;
      const { kind, mimeType } = checkReplyFile(file);
      // A retry of a sent file answers the first message without uploading it again.
      const [duplicate] = await deps.db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(eq(messages.tenantId, ctx.tenant.id), eq(messages.clientKey, data.clientKey)),
            ),
        { accessMode: 'read only' },
      );
      if (duplicate) return { messageId: duplicate.id, duplicate: true };

      const route = await prepareReply(deps, ctx, data.conversationId);
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
    },
  };
}

export type FileRepliesService = ReturnType<typeof createFileRepliesService>;
