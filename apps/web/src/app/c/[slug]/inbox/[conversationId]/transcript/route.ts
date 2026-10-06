import { isAppError } from '@w360/core';
import { getRuntime } from '@/server/runtime';
import { requestMeta, requireTenant } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * Streams a conversation's transcript as plain text (see messaging/transcript; needs
 * `inbox.export`). Authorization and the audit entry run before the first byte, so a refused
 * download is a plain 403/404, never a truncated file.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; conversationId: string }> },
) {
  const { slug, conversationId } = await params;
  const ctx = await requireTenant(slug);
  const { inbox, logger } = await getRuntime();
  const iterator = inbox.exportTranscript(ctx, conversationId, await requestMeta());
  let first: IteratorResult<string>;
  try {
    first = await iterator.next();
  } catch (error) {
    if (isAppError(error)) {
      return new Response(error.publicMessage, {
        status: error.code === 'forbidden' ? 403 : error.code === 'not_found' ? 404 : 400,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    throw error;
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!first.done) controller.enqueue(encoder.encode(first.value));
    },
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        logger.error(
          { err: error, tenantId: ctx.tenant.id },
          'transcript export failed mid-stream',
        );
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
  const date = new Date().toISOString().slice(0, 10);
  return new Response(stream, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="conversation-${conversationId.slice(0, 8)}-${date}.txt"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
