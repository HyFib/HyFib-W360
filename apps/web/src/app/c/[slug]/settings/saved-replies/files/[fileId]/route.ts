import { isAppError } from '@w360/core';
import {
  byteRange,
  contentDisposition,
  mediaPresentation,
  type SavedReplyFilePart,
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
 * A saved reply's file (ADR-411), for members who use or manage saved replies to look at in
 * Settings and in the reply box before sending. Photos, recordings and videos show in the page;
 * other files download. Never cached, and nothing in it runs (proxy.ts gives it FILE_POLICY too).
 *
 * A request for one range of bytes gets that part (206), as media players ask for recordings and
 * videos (ADR-382's `byteRange`); only that part is read from the database. The bytes are passed
 * on as the database driver read them, without another copy.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; fileId: string }> },
) {
  const { slug, fileId } = await params;
  const ctx = await requireTenant(slug);
  const { savedReplies } = await getRuntime();
  let file: Awaited<ReturnType<typeof savedReplies.openSavedReplyFile>>;
  try {
    file = await savedReplies.openSavedReplyFile(ctx, fileId, (size): SavedReplyFilePart => {
      const range = byteRange(request, size);
      return range.kind === 'part' ? { kind: 'part', start: range.start, end: range.end } : range;
    });
  } catch (error) {
    if (isAppError(error)) return text(error.httpStatus, error.publicMessage);
    throw error;
  }
  if (!file) return text(404, 'This file is no longer kept.');
  if (file.part.kind === 'unsatisfiable') {
    return text(416, 'This file has no such part.', {
      'content-range': `bytes */${file.sizeBytes}`,
    });
  }
  const shown = mediaPresentation(file.mimeType);
  const headers = {
    'content-type': shown.contentType,
    'content-disposition': contentDisposition(shown.disposition, file.filename),
    'content-length': String(file.content.byteLength),
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': FILE_POLICY,
    'cross-origin-resource-policy': 'same-origin',
  };
  const body = file.content as Uint8Array<ArrayBuffer>;
  if (file.part.kind === 'part') {
    return new Response(body, {
      status: 206,
      headers: {
        ...headers,
        'content-range': `bytes ${file.part.start}-${file.part.end}/${file.sizeBytes}`,
      },
    });
  }
  return new Response(body, { headers });
}
