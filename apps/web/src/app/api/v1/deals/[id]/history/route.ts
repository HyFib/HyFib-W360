import type { NextRequest } from 'next/server';
import { apiListDealHistory } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/deals/{id}/history (a CRM deal's changes, a page, newest first; ADR-281). */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListDealHistory(runtime.outbound, ctx, id, query)) },
  }));
}
