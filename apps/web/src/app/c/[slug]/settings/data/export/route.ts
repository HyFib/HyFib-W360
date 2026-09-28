import { isAppError } from '@w360/core';
import { getRuntime } from '@/server/runtime';
import { requestMeta, requireTenant } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * Streams the company export (gzip-compressed JSON Lines, ADR-055). The response starts only once
 * the export has written its header line, so a refusal (not an owner, or an export already
 * running) is a plain error response, never a truncated file. A file without its end line is
 * incomplete.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  const { companyExport, logger } = await getRuntime();
  const meta = await requestMeta();

  const { readable, writable } = new TransformStream<string, string>();
  const writer = writable.getWriter();
  let markStarted!: () => void;
  const started = new Promise<'started'>((resolve) => {
    markStarted = () => resolve('started');
  });
  const write = async (chunk: string) => {
    markStarted();
    await writer.ready;
    await writer.write(chunk);
  };
  // Resolves to the error when the export fails (logged here, and the download is cut short).
  const finished: Promise<'done' | Error> = companyExport(ctx, write, meta).then(
    async () => {
      await writer.close();
      return 'done' as const;
    },
    async (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!isAppError(failure)) {
        logger.warn({ err: failure, tenantId: ctx.tenant.id }, 'company export stopped');
      }
      await writer.abort(failure).catch((abortError: unknown) => {
        logger.warn({ err: abortError, tenantId: ctx.tenant.id }, 'company export abort failed');
      });
      return failure;
    },
  );

  const first = await Promise.race([started, finished]);
  if (first instanceof Error) {
    if (isAppError(first)) {
      const status =
        first.code === 'forbidden' ||
        first.code === 'tenant_suspended' ||
        first.code === 'mfa_required' ||
        first.code === 'step_up_required'
          ? 403
          : first.code === 'conflict'
            ? 409
            : 400;
      return new Response(first.publicMessage, {
        status,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    throw first;
  }

  const body = readable
    .pipeThrough(new TextEncoderStream())
    .pipeThrough(new CompressionStream('gzip'));
  const date = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="hyfib-w360-${ctx.tenant.slug}-${date}.jsonl.gz"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
