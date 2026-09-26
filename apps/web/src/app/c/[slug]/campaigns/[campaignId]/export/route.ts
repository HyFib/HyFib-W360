import { isAppError } from '@w360/core';
import { getRuntime } from '@/server/runtime';
import { requestMeta, requireTenant } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * Streams a campaign's per-recipient outcomes as CSV (formula-safe, see contacts/csv; needs
 * `contacts.export`). Authorization runs before the first byte, so a refused export is a plain
 * 403/404, never a truncated file.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; campaignId: string }> },
) {
  const { slug, campaignId } = await params;
  const ctx = await requireTenant(slug);
  const { campaigns, logger } = await getRuntime();
  const iterator = campaigns.exportRecipients(ctx, campaignId, await requestMeta());
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
        logger.error({ err: error, tenantId: ctx.tenant.id }, 'campaign export failed mid-stream');
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="campaign-${campaignId.slice(0, 8)}-recipients.csv"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
