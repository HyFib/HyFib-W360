import type { NextRequest } from 'next/server';
import { apiPauseCampaign } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** POST /api/v1/campaigns/{id}/pause: pause a scheduled or running campaign (ADR-128). */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiPauseCampaign(runtime.outbound, ctx, id) },
  }));
}
