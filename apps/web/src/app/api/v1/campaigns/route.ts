import type { NextRequest } from 'next/server';
import { apiCreateCampaign, apiListCampaigns } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/campaigns: the company's campaigns, newest first (ADR-125). POST: create a draft
 * (ADR-186), once per Idempotency-Key when one is given.
 */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListCampaigns(runtime.outbound, ctx, query)) },
  }));
}

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) =>
      apiCreateCampaign(runtime.outbound, ctx, body, idempotency),
    { json: true, idempotency: 'optional' },
  );
}
