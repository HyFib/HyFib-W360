import { isAppError } from '@w360/core';
import {
  byteRange,
  byteRangeStream,
  contentDisposition,
  type ReceivedMediaFile,
} from '@w360/domain';
import { FILE_POLICY } from '@/lib/document-routes';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const dynamic = 'force-dynamic';

const text = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': FILE_POLICY,
      ...headers,
    },
  });

/**
 * A file a customer sent, fetched from WhatsApp for this request and passed on as it arrives
 * (messaging/received-media, ADR-216). The member's access, the account and Meta's answer are all
 * checked before the first byte, so those refusals are plain-text errors; a file that grows past
 * 100 MB while passing is cut off, which the browser reports as a failed download. Photos,
 * stickers, voice notes and videos are shown in the page; other files download.
 *
 * A request for one range of bytes gets that part (206) when WhatsApp gave the file's length, as
 * Safari's and iOS's players ask for recordings and videos (ADR-382): the file is still fetched
 * from its start, and the download stops after the part.
 */
export async function GET(
  request: Request,
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
  // Next sends the headers next.config.ts and proxy.ts give before a route's own, so these repeat
  // theirs: no browser keeps a customer's file, and nothing in it runs (ADR-382).
  const headers = {
    'content-type': file.contentType,
    'content-disposition': contentDisposition(file.disposition, file.filename),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': FILE_POLICY,
    'cross-origin-resource-policy': 'same-origin',
  };
  const range = byteRange(request, file.size);
  if (range.kind === 'unsatisfiable') {
    await file.body.cancel();
    return text(416, 'This file has no such part.', { 'content-range': `bytes */${range.size}` });
  }
  if (range.kind === 'part') {
    return new Response(byteRangeStream(file.body, range.start, range.end), {
      status: 206,
      headers: {
        ...headers,
        'accept-ranges': 'bytes',
        'content-range': `bytes ${range.start}-${range.end}/${range.size}`,
        'content-length': String(range.end - range.start + 1),
      },
    });
  }
  return new Response(file.body, {
    headers: file.size === null ? headers : { ...headers, 'accept-ranges': 'bytes' },
  });
}
