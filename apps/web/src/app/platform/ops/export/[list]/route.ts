import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { isOpsExportList } from '@w360/domain';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * One of the operations console's lists as CSV, formula-safe: the Usage tab for `days` (ADR-154),
 * every company's health or the Signals tab (ADR-155). The pages' checks run first, and the service
 * writes the export to the platform audit log before it returns the file.
 */
export async function GET(request: Request, { params }: { params: Promise<{ list: string }> }) {
  const actor = await requirePlatformActor();
  const { list } = await params;
  if (!isOpsExportList(list)) notFound();
  const days = Number(new URL(request.url).searchParams.get('days') ?? 30);
  const { platformOps } = await getRuntime();
  try {
    const file = await platformOps.exportList(actor, list, days);
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
        status: error.code === 'forbidden' ? 403 : 400,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    throw error;
  }
}
