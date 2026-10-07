import type { NextRequest } from 'next/server';
import { apiGetDeal } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/deals/{id} (a CRM deal; ADR-253). */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiGetDeal(runtime.outbound, ctx, id) },
  }));
}
