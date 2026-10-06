import { z } from 'zod';
import { AppError, notFound, preconditionFailed, type Keyring } from '@w360/core';
import {
  and,
  channelAccounts,
  conversations,
  eq,
  mediaObjects,
  messages,
  whatsappAccounts,
  type Database,
} from '@w360/db';
import type { TenantContext } from '../authz/context';
import { credentialAad } from './credentials';
import type { GraphClient, GraphFailureKind, MediaDownload } from './graph';
import { canSeeConversation } from './outbound';

/**
 * Files customers send (ADR-216). WhatsApp keeps them, not HyFib: a member's request fetches the
 * file's address from Graph with the token of the account that received it, downloads it and
 * passes it on as it arrives. Nothing is stored, so nothing is left to delete.
 */

/** The message types that carry a file a customer sent. */
export const RECEIVED_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image',
  'video',
  'audio',
  'document',
  'sticker',
]);

/** Meta's largest file (research M-049): HyFib passes on nothing larger. */
export const MEDIA_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Types shown or played in the conversation itself: photos, stickers, voice notes and videos. Any
 * other file, documents included, is sent as a download of no particular type, so a browser never
 * renders a customer's file as a page of HyFib.
 */
const INLINE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'audio/aac',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'video/3gpp',
  'video/mp4',
]);

/** The extension of a file saved without the name a customer gave it. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'video/3gpp': '3gp',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

/** A file's type without its parameters, lowercased: `audio/ogg; codecs=opus` is `audio/ogg`. */
export function baseMediaType(mimeType: string | null | undefined): string | null {
  if (!mimeType) return null;
  const base = (mimeType.split(';', 1)[0] ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(base)
    ? base
    : null;
}

/** How a file is sent to the browser: shown in the page, or saved as a download. */
export function mediaPresentation(mimeType: string | null | undefined): {
  contentType: string;
  disposition: 'inline' | 'attachment';
} {
  const base = baseMediaType(mimeType);
  return base && INLINE_TYPES.has(base)
    ? { contentType: base, disposition: 'inline' }
    : { contentType: 'application/octet-stream', disposition: 'attachment' };
}

/**
 * The name a file is saved under: the name the customer's document came with, without characters
 * a file name or a header cannot hold, or else `whatsapp-<type>-<message>.<extension>`.
 */
export function mediaFilename(input: {
  type: string;
  mimeType: string | null | undefined;
  filename: string | null | undefined;
  messageId: string;
}): string {
  const cleaned = (input.filename ?? '')
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\\/:*?"<>|]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '');
  const given = Array.from(cleaned).slice(0, 150).join('').trim();
  if (given) return given;
  const extension = EXTENSIONS[baseMediaType(input.mimeType) ?? ''];
  return `whatsapp-${input.type}-${input.messageId.slice(0, 8)}${extension ? `.${extension}` : ''}`;
}

/** A Content-Disposition value: an ASCII name, and the full name in UTF-8 (RFC 6266, RFC 8187). */
export function contentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Passes `body` on, and fails the stream once more than `max` bytes have arrived. */
export function limitedStream(
  body: ReadableStream<Uint8Array>,
  max: number,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new Error('The file is larger than HyFib passes on.'));
        else controller.enqueue(chunk);
      },
    }),
  );
}

const DISCONNECTED =
  'The WhatsApp account that received this file is disconnected. An administrator can reconnect it in Settings → Channels.';
const ACCESS_REFUSED =
  'WhatsApp refused HyFib’s access to the account that received this file. An administrator can reconnect it in Settings → Channels.';
const TOO_LARGE = 'This file is larger than the 100 MB HyFib passes on.';

/** What a failed request for a file's address tells the member. */
export function mediaLocationFailure(kind: GraphFailureKind): AppError {
  if (kind === 'auth') return preconditionFailed(ACCESS_REFUSED);
  if (kind === 'permanent') {
    return new AppError(
      'not_found',
      'WhatsApp no longer gives this file. It keeps the files customers send for a limited time.',
    );
  }
  return new AppError('provider_unavailable', 'WhatsApp did not answer. Try again in a moment.');
}

/** What a failed download tells the member. */
export function mediaDownloadFailure(failure: Extract<MediaDownload, { ok: false }>): AppError {
  if (failure.kind === 'auth') return preconditionFailed(ACCESS_REFUSED);
  return new AppError(
    'provider_unavailable',
    'WhatsApp did not give the file. Try again in a moment.',
  );
}

export interface ReceivedMediaDeps {
  db: Database;
  keyring: Keyring;
  graph: Pick<GraphClient, 'getMedia' | 'downloadMedia'>;
}

export interface ReceivedMediaFile {
  /** A type shown or played in the page, or `application/octet-stream`. */
  contentType: string;
  disposition: 'inline' | 'attachment';
  filename: string;
  body: ReadableStream<Uint8Array>;
}

const isUuid = (value: string) => z.uuid().safeParse(value).success;

export function createReceivedMediaService(deps: ReceivedMediaDeps) {
  const { db, keyring, graph } = deps;
  return {
    /**
     * The file a customer sent in a message of a conversation the member can see, fetched from
     * WhatsApp now. A message the member cannot see is not found, as the conversation is.
     */
    async openReceivedMedia(
      ctx: TenantContext,
      conversationId: string,
      messageId: string,
    ): Promise<ReceivedMediaFile> {
      if (!isUuid(conversationId) || !isUuid(messageId)) throw notFound('Message');
      const [row] = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              direction: messages.direction,
              type: messages.type,
              assignedMembershipId: conversations.assignedMembershipId,
              whatsappAccountId: whatsappAccounts.id,
              accountStatus: whatsappAccounts.status,
              credential: whatsappAccounts.credentialCiphertext,
              providerMediaId: mediaObjects.providerMediaId,
              mimeType: mediaObjects.mimeType,
              filename: mediaObjects.filename,
            })
            .from(messages)
            .innerJoin(
              conversations,
              and(
                eq(conversations.tenantId, messages.tenantId),
                eq(conversations.id, messages.conversationId),
              ),
            )
            .innerJoin(
              channelAccounts,
              and(
                eq(channelAccounts.tenantId, messages.tenantId),
                eq(channelAccounts.id, messages.channelAccountId),
              ),
            )
            .innerJoin(
              whatsappAccounts,
              and(
                eq(whatsappAccounts.tenantId, channelAccounts.tenantId),
                eq(whatsappAccounts.id, channelAccounts.whatsappAccountId),
              ),
            )
            .leftJoin(
              mediaObjects,
              and(
                eq(mediaObjects.tenantId, messages.tenantId),
                eq(mediaObjects.messageId, messages.id),
              ),
            )
            .where(
              and(
                eq(messages.tenantId, ctx.tenant.id),
                eq(messages.id, messageId),
                eq(messages.conversationId, conversationId),
              ),
            )
            .limit(1),
        { accessMode: 'read only' },
      );
      if (!row || !canSeeConversation(ctx, row.assignedMembershipId)) throw notFound('Message');
      // An erased customer's files are gone with their media rows.
      if (
        row.direction !== 'inbound' ||
        !RECEIVED_MEDIA_TYPES.has(row.type) ||
        !row.providerMediaId
      )
        throw new AppError('not_found', 'This message has no file from the customer.');
      if (row.accountStatus !== 'connected' || !row.credential)
        throw preconditionFailed(DISCONNECTED);
      const token = keyring.decryptString(
        row.credential,
        credentialAad(ctx.tenant.id, row.whatsappAccountId),
      );
      const location = await graph.getMedia(row.providerMediaId, token);
      if (!location.ok) throw mediaLocationFailure(location.kind);
      if (location.data.fileSize !== null && location.data.fileSize > MEDIA_MAX_BYTES)
        throw preconditionFailed(TOO_LARGE);
      const download = await graph.downloadMedia(location.data.url, token);
      if (!download.ok) throw mediaDownloadFailure(download);
      if (download.contentLength !== null && download.contentLength > MEDIA_MAX_BYTES) {
        await download.body.cancel();
        throw preconditionFailed(TOO_LARGE);
      }
      const mimeType = location.data.mimeType ?? row.mimeType;
      return {
        ...mediaPresentation(mimeType),
        filename: mediaFilename({ type: row.type, mimeType, filename: row.filename, messageId }),
        body: limitedStream(download.body, MEDIA_MAX_BYTES),
      };
    },
  };
}

export type ReceivedMediaService = ReturnType<typeof createReceivedMediaService>;
