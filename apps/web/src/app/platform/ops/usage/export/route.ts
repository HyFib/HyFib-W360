import { isAppError } from '@w360/core';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * The operations console's Usage tab as CSV (ADR-154), formula-safe. The page's checks run first,
 * and the service writes the export to the platform audit log before it returns the file.
 */
export async function GET(request: Request) {
  const actor = await requirePlatformActor();
  const days = Number(new URL(request.url).searchParams.get('days') ?? 30);
  const { platformOps } = await getRuntime();
  try {
    const file = await platformOps.exportUsage(actor, days);
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
