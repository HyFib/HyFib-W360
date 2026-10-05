import type { NextRequest } from 'next/server';
import { apiGetCampaign, apiUpdateCampaign } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/campaigns/{id}: one campaign with its results, counted when read (ADR-125), and its
 * settings (ADR-186). PATCH: edit a draft (ADR-186).
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiGetCampaign(runtime.outbound, ctx, id) },
  }));
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: { data: await apiUpdateCampaign(runtime.outbound, ctx, id, body) },
    }),
    { json: true },
  );
}
