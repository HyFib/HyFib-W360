import { isAppError } from '@w360/core';
import { getRuntime } from '@/server/runtime';
import { requestMeta, requireTenant } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * Downloads a stored company export (ADR-415) through the app: the signed-in owner, with a recent
 * sign-in, of the company's own exports only. The file is read a part at a time from the company's
 * rows and opened with the keyring as the response is read; nothing hands out a link of its own.
 * A refusal is a plain error response, never a file; a part that cannot be read stops the download
 * (the file is then incomplete, and its SHA-256 on the page does not match).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; exportId: string }> },
) {
  const { slug, exportId } = await params;
  const ctx = await requireTenant(slug);
  const { storedExports, logger } = await getRuntime();
  let download;
  try {
    download = await storedExports.open(ctx, exportId, await requestMeta());
  } catch (error) {
    if (!isAppError(error)) throw error;
    const status =
      error.code === 'forbidden' ||
      error.code === 'tenant_suspended' ||
      error.code === 'mfa_required' ||
      error.code === 'step_up_required'
        ? 403
        : error.code === 'not_found'
          ? 404
          : 400;
    return new Response(error.publicMessage, {
      status,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const parts = download.parts;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await parts.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        logger.warn(
          { err: error, tenantId: ctx.tenant.id, exportId },
          'stored export download stopped',
        );
        controller.error(error);
      }
    },
    async cancel() {
      await parts.return(undefined);
    },
  });
  return new Response(body, {
    headers: {
      'content-type': 'application/gzip',
      'content-length': String(download.byteSize),
      'content-disposition': `attachment; filename="${download.filename}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
