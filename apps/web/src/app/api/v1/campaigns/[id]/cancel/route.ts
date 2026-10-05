import type { NextRequest } from 'next/server';
import { apiCancelCampaign } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** POST /api/v1/campaigns/{id}/cancel: cancel a campaign that has not finished (ADR-128). */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiCancelCampaign(runtime.outbound, ctx, id) },
  }));
}
