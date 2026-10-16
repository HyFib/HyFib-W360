import { isAppError } from '@w360/core';
import { getRuntime } from '@/server/runtime';
import { requestMeta, requireTenant } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * One report section as CSV (formula-safe, see contacts/csv). Needs `reports.export`; the
 * service audits the export before returning data, so a refused export is a plain 403/400. The
 * deals section takes `?field=` (a choice or yes/no field's value, ADR-396) as the page filters
 * it: refused unless it resolves (checked by the service), and with any other section.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; section: string }> },
) {
  const { slug, section } = await params;
  const ctx = await requireTenant(slug);
  const url = new URL(request.url);
  const { reports } = await getRuntime();
  try {
    const file = await reports.exportSection(
      ctx,
      {
        preset: url.searchParams.get('preset') ?? undefined,
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
        // A repeated parameter counts by its first value, as on the page; an empty one asks for
        // nothing, as the CRM export reads it.
        field: url.searchParams.get('field') || undefined,
      },
      section,
      await requestMeta(),
    );
    return new Response(file.body, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${file.filename}"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    if (isAppError(error)) {
      return new Response(error.publicMessage, {
        status: error.code === 'forbidden' ? 403 : error.code === 'not_found' ? 404 : 400,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    throw error;
  }
}
