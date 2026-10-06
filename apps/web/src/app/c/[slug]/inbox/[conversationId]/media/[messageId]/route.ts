import { isAppError } from '@w360/core';
import { contentDisposition, type ReceivedMediaFile } from '@w360/domain';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const dynamic = 'force-dynamic';

const text = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });

/**
 * A file a customer sent, fetched from WhatsApp for this request and passed on as it arrives
 * (messaging/received-media, ADR-216). The member's access, the account and Meta's answer are all
 * checked before the first byte, so those refusals are plain-text errors; a file that grows past
 * 100 MB while passing is cut off, which the browser reports as a failed download. Photos,
 * stickers, voice notes and videos are shown in the page; other files download.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; conversationId: string; messageId: string }> },
) {
  const { slug, conversationId, messageId } = await params;
  const ctx = await requireTenant(slug);
  const { receivedMedia } = await getRuntime();
  if (!receivedMedia) return text(501, 'WhatsApp is not set up on this server.');
  let file: ReceivedMediaFile;
  try {
    file = await receivedMedia.openReceivedMedia(ctx, conversationId, messageId);
  } catch (error) {
    if (isAppError(error)) return text(error.httpStatus, error.publicMessage);
    throw error;
  }
  return new Response(file.body, {
    headers: {
      'content-type': file.contentType,
      'content-disposition': contentDisposition(file.disposition, file.filename),
      // A message's file never changes; only this member's browser keeps it.
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
    },
  });
}
