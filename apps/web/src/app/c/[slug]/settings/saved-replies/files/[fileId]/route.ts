import { isAppError } from '@w360/core';
import { contentDisposition, mediaPresentation } from '@w360/domain';
import { FILE_POLICY } from '@/lib/document-routes';
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
      'content-security-policy': FILE_POLICY,
    },
  });

/**
 * A saved reply's file (ADR-411), for members who use or manage saved replies to look at in
 * Settings and in the reply box before sending. Photos, recordings and videos show in the page;
 * other files download. Never cached, and nothing in it runs (proxy.ts gives it FILE_POLICY too).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; fileId: string }> },
) {
  const { slug, fileId } = await params;
  const ctx = await requireTenant(slug);
  const { savedReplies } = await getRuntime();
  let file: Awaited<ReturnType<typeof savedReplies.openSavedReplyFile>>;
  try {
    file = await savedReplies.openSavedReplyFile(ctx, fileId);
  } catch (error) {
    if (isAppError(error)) return text(error.httpStatus, error.publicMessage);
    throw error;
  }
  if (!file) return text(404, 'This file is no longer kept.');
  const shown = mediaPresentation(file.mimeType);
  return new Response(new Uint8Array(file.content), {
    headers: {
      'content-type': shown.contentType,
      'content-disposition': contentDisposition(shown.disposition, file.filename),
      'content-length': String(file.content.byteLength),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': FILE_POLICY,
      'cross-origin-resource-policy': 'same-origin',
    },
  });
}
