import type { NextRequest } from 'next/server';
import { apiSubmitCampaign } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * POST /api/v1/campaigns/{id}/submit: submit a draft, which always waits for a member's approval
 * (ADR-202).
 */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: {
        data: await apiSubmitCampaign(
          { ...runtime.outbound, campaignNotices: runtime.campaignNotices },
          ctx,
          id,
          body,
        ),
      },
    }),
    { json: true },
  );
}
