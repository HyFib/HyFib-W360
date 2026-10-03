import type { NextRequest } from 'next/server';
import { apiListCampaigns } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/campaigns: the company's campaigns, newest first (ADR-125). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListCampaigns(runtime.outbound, ctx, query)) },
  }));
}
