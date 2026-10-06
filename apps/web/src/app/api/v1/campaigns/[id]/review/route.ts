import type { NextRequest } from 'next/server';
import { apiReviewCampaign } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/campaigns/{id}/review: what submitting a draft would do now (ADR-193). */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiReviewCampaign(runtime.outbound, ctx, id) },
  }));
}
