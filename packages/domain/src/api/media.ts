import { z } from 'zod';
import { AppError, uuidv7, type Clock, type Keyring } from '@w360/core';
import { and, eq, mediaObjects, whatsappAccounts, type Database } from '@w360/db';
import { credentialAad } from '../messaging/credentials';
import {
  UPLOADED_MEDIA_LIFETIME_MS,
  checkReplyFile,
  uploadFailure,
  type ReplyFile,
} from '../messaging/file-replies';
import type { GraphClient } from '../messaging/graph';
import { mediaFilename } from '../messaging/received-media';
import { assertScope, type ApiContext } from './context';
import { sendingNumber } from './resources';

/**
 * Files a key uploads to send by id (ADR-219): POST /api/v1/media uploads the file to WhatsApp for
 * one of the company's numbers and records Meta's media as an upload of the company, which
 * `POST /messages` then names as `mediaId` from that number for 30 days. HyFib keeps no copy.
 */

/** A file uploaded through the API, as `POST /media` answers it. */
export interface ApiUploadedMedia {
  id: string;
  channelId: string;
  type: 'image' | 'video' | 'audio' | 'document';
  mimeType: string;
  size: number;
  fileName: string;
  createdAt: string;
  expiresAt: string;
}

export interface ApiMediaDeps {
  db: Database;
  keyring: Keyring;
  graph: Pick<GraphClient, 'uploadMedia'>;
  clock: Clock;
}

const fromSchema = z
  .uuid({ error: 'Give the id of one of the company’s WhatsApp numbers' })
  .optional();

/** Uploads a file for the number it names (or the company's only active number). */
export async function apiUploadMedia(
  deps: ApiMediaDeps,
  ctx: ApiContext,
  input: { from?: string | undefined },
  file: ReplyFile,
): Promise<ApiUploadedMedia> {
  assertScope(ctx, 'messages.reply');
  const from = fromSchema.safeParse(input.from);
  if (!from.success) {
    const message = from.error.issues[0]?.message ?? 'Give a WhatsApp number’s id';
    throw new AppError('validation_failed', message, { issues: [{ path: 'from', message }] });
  }
  const { kind, mimeType } = checkReplyFile(file);
  const target = await deps.db.run(
    ctx.scope,
    async (tx) => {
      const channel = await sendingNumber(tx, ctx, from.data);
      if (channel.status !== 'active') {
        throw new AppError('precondition_failed', 'This WhatsApp number is not active.');
      }
      const [account] = await tx
        .select({
          status: whatsappAccounts.status,
          credential: whatsappAccounts.credentialCiphertext,
        })
        .from(whatsappAccounts)
        .where(
          and(
            eq(whatsappAccounts.tenantId, ctx.tenant.id),
            eq(whatsappAccounts.id, channel.whatsappAccountId),
          ),
        );
      if (!account || account.status !== 'connected' || !account.credential) {
        throw new AppError(
          'precondition_failed',
          'This number’s WhatsApp account is disconnected. A member can reconnect it in Settings → Channels.',
        );
      }
      return { channel, credential: account.credential };
    },
    { accessMode: 'read only' },
  );
  const token = deps.keyring.decryptString(
    target.credential,
    credentialAad(ctx.tenant.id, target.channel.whatsappAccountId),
  );
  const filename = mediaFilename({ type: kind, mimeType, filename: file.name, messageId: null });
  const uploaded = await deps.graph.uploadMedia(target.channel.phoneNumberId, token, {
    filename,
    contentType: mimeType,
    bytes: file.bytes,
  });
  if (!uploaded.ok) throw uploadFailure(uploaded);
  const id = uuidv7();
  const [row] = await deps.db.run(ctx.scope, (tx) =>
    tx
      .insert(mediaObjects)
      .values({
        id,
        tenantId: ctx.tenant.id,
        messageId: null,
        providerMediaId: uploaded.data.mediaId,
        mimeType,
        sizeBytes: file.bytes.byteLength,
        filename,
        channelAccountId: target.channel.id,
        apiKeyId: ctx.key.id,
      })
      .returning({ createdAt: mediaObjects.createdAt }),
  );
  const createdAt = row?.createdAt ?? deps.clock.now();
  return {
    id,
    channelId: target.channel.id,
    type: kind,
    mimeType,
    size: file.bytes.byteLength,
    fileName: filename,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + UPLOADED_MEDIA_LIFETIME_MS).toISOString(),
  };
}
