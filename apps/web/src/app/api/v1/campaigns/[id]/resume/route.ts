import type { NextRequest } from 'next/server';
import { apiResumeCampaign } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** POST /api/v1/campaigns/{id}/resume: resume a campaign a key paused (ADR-176). */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiResumeCampaign(runtime.outbound, ctx, id) },
  }));
}
