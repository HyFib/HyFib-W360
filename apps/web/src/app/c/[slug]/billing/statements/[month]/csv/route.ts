import { isAppError } from '@w360/core';
import { getRuntime } from '@/server/runtime';
import { requestMeta, requireTenant } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * One month's statement as CSV (formula-safe, see contacts/csv). Needs `billing.read`; the service
 * audits the download before returning data, so a refused one is a plain 403/404.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; month: string }> },
) {
  const { slug, month } = await params;
  const ctx = await requireTenant(slug);
  const { billingHistory } = await getRuntime();
  try {
    const file = await billingHistory.statementCsv(ctx, { month }, await requestMeta());
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
