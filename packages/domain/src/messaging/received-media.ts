import { z } from 'zod';
import { AppError, notFound, type AppErrorCode, type Keyring } from '@w360/core';
import {
  and,
  channelAccounts,
  contacts,
  conversations,
  eq,
  mediaObjects,
  messages,
  whatsappAccounts,
  type Database,
  type TenantScope,
} from '@w360/db';
import { assertScope, type ApiContext } from '../api/context';
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
 * The name a file is saved under: the name the document came with, without characters a file name
 * or a header cannot hold, or else `whatsapp-<type>-<message>.<extension>` (without the message for
 * a file not yet sent).
 */
export function mediaFilename(input: {
  type: string;
  mimeType: string | null | undefined;
  filename: string | null | undefined;
  messageId: string | null;
}): string {
  const cleaned = (input.filename ?? '')
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\\/:*?"<>|]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '');
  const given = Array.from(cleaned).slice(0, 150).join('').trim();
  if (given) return given;
  const extension = EXTENSIONS[baseMediaType(input.mimeType) ?? ''];
  const message = input.messageId ? `-${input.messageId.slice(0, 8)}` : '';
  return `whatsapp-${input.type}${message}${extension ? `.${extension}` : ''}`;
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

/** The part of a file a request asks for (ADR-382): all of it, bytes `start` to `end`, or none. */
export type ByteRange =
  | { kind: 'whole' }
  | { kind: 'part'; start: number; end: number; size: number }
  | { kind: 'unsatisfiable'; size: number };

/** One range of bytes: `first-last`, `first-` or the last `-n` bytes (RFC 9110 §14.1). */
const BYTE_RANGE = /^bytes=[ \t]*(?:(\d+)-(\d*)|-(\d+))[ \t]*$/i;

/**
 * The part of a file of `size` bytes a request's Range header asks for (RFC 9110 §14, ADR-382).
 * Bytes are counted from 0 and `end` is included. A single range is answered; any other request
 * gets the whole file: no Range, a method other than GET, a file whose length is not known or is
 * 0, an If-Range (HyFib gives no validator it could match), and a header a server may ignore
 * (another unit, several ranges, or one malformed). A range starting past the end has no part.
 */
export function byteRange(
  request: { method: string; headers: Headers },
  size: number | null,
): ByteRange {
  const header = request.headers.get('range');
  if (
    request.method !== 'GET' ||
    header === null ||
    request.headers.has('if-range') ||
    size === null ||
    size === 0
  )
    return { kind: 'whole' };
  const match = BYTE_RANGE.exec(header);
  if (!match) return { kind: 'whole' };
  const [, first, last, suffix] = match;
  if (suffix !== undefined) {
    const length = Number(suffix);
    return length === 0
      ? { kind: 'unsatisfiable', size }
      : { kind: 'part', start: Math.max(size - length, 0), end: size - 1, size };
  }
  const start = Number(first);
  if (last && Number(last) < start) return { kind: 'whole' };
  if (start >= size) return { kind: 'unsatisfiable', size };
  return { kind: 'part', start, end: last ? Math.min(Number(last), size - 1) : size - 1, size };
}

/**
 * Passes on bytes `start` to `end` of `body` (from 0, `end` included), then cancels the rest of
 * the download. The stream fails when `body` ends first, so a shorter file is never passed on as
 * the part asked for.
 */
export function byteRangeStream(
  body: ReadableStream<Uint8Array>,
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let read = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          controller.error(new Error('The file ended before the part asked for.'));
          return;
        }
        const from = read;
        read += value.byteLength;
        if (read <= start) continue;
        const part = value.subarray(
          Math.max(start - from, 0),
          Math.min(end + 1 - from, value.byteLength),
        );
        if (read > end) {
          await reader.cancel();
          controller.enqueue(part);
          controller.close();
        } else {
          controller.enqueue(part);
        }
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

const DISCONNECTED =
  'The WhatsApp account that received this file is disconnected. An administrator can reconnect it in Settings → Channels.';
const ACCESS_REFUSED =
  'WhatsApp refused HyFib’s access to the account that received this file. An administrator can reconnect it in Settings → Channels.';
const TOO_LARGE = 'This file is larger than the 100 MB HyFib passes on.';

/** A refusal with the reason the public API names (ADR-217); members read its message. */
const refusal = (code: AppErrorCode, message: string, apiReason: string) =>
  new AppError(code, message, { details: { apiReason } });

/** What a failed request for a file's address says. */
export function mediaLocationFailure(kind: GraphFailureKind): AppError {
  if (kind === 'auth') return refusal('precondition_failed', ACCESS_REFUSED, 'access_refused');
  if (kind === 'permanent') {
    return refusal(
      'not_found',
      'WhatsApp no longer gives this file. It keeps the files customers send for a limited time.',
      'file_expired',
    );
  }
  return new AppError('provider_unavailable', 'WhatsApp did not answer. Try again in a moment.');
}

/** What a failed download says. */
export function mediaDownloadFailure(failure: Extract<MediaDownload, { ok: false }>): AppError {
  if (failure.kind === 'auth')
    return refusal('precondition_failed', ACCESS_REFUSED, 'access_refused');
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
  /** The file's type, or `application/octet-stream` when it is not given one. */
  contentType: string;
  disposition: 'inline' | 'attachment';
  filename: string;
  /** The bytes in `body`, when WhatsApp's download gives their length (ADR-382). */
  size: number | null;
  body: ReadableStream<Uint8Array>;
}

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/**
 * A message of the company with its conversation's assignee and contact, its number's account and
 * its media record, read in the company's scope; in one conversation when `conversationId` is set.
 */
async function findReceivedFile(
  db: Database,
  scope: TenantScope,
  tenantId: string,
  messageId: string,
  conversationId: string | null,
) {
  const [row] = await db.run(
    scope,
    (tx) =>
      tx
        .select({
          direction: messages.direction,
          type: messages.type,
          assignedMembershipId: conversations.assignedMembershipId,
          contactErasedAt: contacts.erasedAt,
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
          contacts,
          and(
            eq(contacts.tenantId, conversations.tenantId),
            eq(contacts.id, conversations.contactId),
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
            eq(messages.tenantId, tenantId),
            eq(messages.id, messageId),
            ...(conversationId ? [eq(messages.conversationId, conversationId)] : []),
          ),
        )
        .limit(1),
    { accessMode: 'read only' },
  );
  return row ?? null;
}

export function createReceivedMediaService(deps: ReceivedMediaDeps) {
  const { db, keyring, graph } = deps;

  /** Fetches the file of a message the caller may read, refusing with the reason it cannot. */
  async function fetchFile(
    tenantId: string,
    messageId: string,
    row: NonNullable<Awaited<ReturnType<typeof findReceivedFile>>>,
    customerOnly: boolean,
  ): Promise<{
    mimeType: string | null;
    filename: string;
    size: number | null;
    body: ReadableStream<Uint8Array>;
  }> {
    // A message has a media record when the customer sent a file or a member uploaded one
    // (ADR-218); an erased customer's are gone with their messages' content.
    if (
      (customerOnly && row.direction !== 'inbound') ||
      !RECEIVED_MEDIA_TYPES.has(row.type) ||
      !row.providerMediaId
    )
      throw refusal(
        'not_found',
        customerOnly ? 'This message has no file from the customer.' : 'This message has no file.',
        'no_file',
      );
    if (row.accountStatus !== 'connected' || !row.credential)
      throw refusal('precondition_failed', DISCONNECTED, 'channel_disconnected');
    const token = keyring.decryptString(
      row.credential,
      credentialAad(tenantId, row.whatsappAccountId),
    );
    const location = await graph.getMedia(row.providerMediaId, token);
    if (!location.ok) throw mediaLocationFailure(location.kind);
    if (location.data.fileSize !== null && location.data.fileSize > MEDIA_MAX_BYTES)
      throw refusal('precondition_failed', TOO_LARGE, 'file_too_large');
    const download = await graph.downloadMedia(location.data.url, token);
    if (!download.ok) throw mediaDownloadFailure(download);
    if (download.contentLength !== null && download.contentLength > MEDIA_MAX_BYTES) {
      await download.body.cancel();
      throw refusal('precondition_failed', TOO_LARGE, 'file_too_large');
    }
    const mimeType = location.data.mimeType ?? row.mimeType;
    return {
      mimeType,
      filename: mediaFilename({ type: row.type, mimeType, filename: row.filename, messageId }),
      size: download.contentLength,
      body: limitedStream(download.body, MEDIA_MAX_BYTES),
    };
  }

  return {
    /**
     * The file of a message of a conversation the member can see, a customer's or one a member
     * sent (ADR-218), fetched from WhatsApp now. A message the member cannot see is not found, as
     * the conversation is.
     */
    async openReceivedMedia(
      ctx: TenantContext,
      conversationId: string,
      messageId: string,
    ): Promise<ReceivedMediaFile> {
      if (!isUuid(conversationId) || !isUuid(messageId)) throw notFound('Message');
      const row = await findReceivedFile(db, ctx.scope, ctx.tenant.id, messageId, conversationId);
      if (!row || !canSeeConversation(ctx, row.assignedMembershipId)) throw notFound('Message');
      const file = await fetchFile(ctx.tenant.id, messageId, row, false);
      return {
        ...mediaPresentation(file.mimeType),
        filename: file.filename,
        size: file.size,
        body: file.body,
      };
    },

    /**
     * GET /api/v1/messages/{id}/media (ADR-217): the file a customer sent, for a key that reads
     * conversations, as a download with its type. A message of an erased contact is not found, as
     * its conversation is to keys.
     */
    async openReceivedMediaForKey(ctx: ApiContext, messageId: string): Promise<ReceivedMediaFile> {
      assertScope(ctx, 'conversations.read');
      if (!isUuid(messageId)) throw notFound('Message');
      const row = await findReceivedFile(db, ctx.scope, ctx.tenant.id, messageId, null);
      if (!row || row.contactErasedAt !== null) throw notFound('Message');
      const file = await fetchFile(ctx.tenant.id, messageId, row, true);
      return {
        contentType: baseMediaType(file.mimeType) ?? 'application/octet-stream',
        disposition: 'attachment',
        filename: file.filename,
        size: file.size,
        body: file.body,
      };
    },
  };
}

export type ReceivedMediaService = ReturnType<typeof createReceivedMediaService>;
