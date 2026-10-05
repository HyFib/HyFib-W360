import type { NextRequest } from 'next/server';
import { apiListCampaignRecipients } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/campaigns/{id}/recipients: a campaign's recipients and their outcomes (ADR-127). */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListCampaignRecipients(runtime.outbound, ctx, id, query)) },
  }));
}
