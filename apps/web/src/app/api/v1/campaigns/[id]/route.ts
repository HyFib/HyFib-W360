import type { NextRequest } from 'next/server';
import { apiGetCampaign } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/campaigns/{id}: one campaign with its results, counted when read (ADR-125). */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiGetCampaign(runtime.outbound, ctx, id) },
  }));
}
