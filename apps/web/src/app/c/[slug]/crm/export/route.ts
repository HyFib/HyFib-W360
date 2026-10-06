import { isAppError } from '@w360/core';
import { getRuntime } from '@/server/runtime';
import { requestMeta, requireTenant } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * Streams the deals the board or a list shows as CSV (ADR-239; formula-safe, needs `crm.read` and
 * `contacts.export`), filtered by `?status=`, `?pipeline=` and `?owner=` as the CRM page filters
 * them. Authorization runs before the first byte, so a refused export is a plain 403, 404 or 400,
 * never a truncated file.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  const { crm, logger } = await getRuntime();
  const query = new URL(request.url).searchParams;
  const status = query.get('status');
  const pipelineId = query.get('pipeline');
  const owner = query.get('owner');
  const iterator = crm.exportDeals(
    ctx,
    {
      ...(status ? { status } : {}),
      ...(pipelineId ? { pipelineId } : {}),
      ...(owner ? { owner } : {}),
    },
    await requestMeta(),
  );
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
        logger.error({ err: error, tenantId: ctx.tenant.id }, 'deals export failed mid-stream');
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
      // The status was checked against the deal statuses before the first byte.
      'content-disposition': `attachment; filename="deals${status ? `-${status.replace(/[^a-z]/g, '')}` : ''}.csv"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
