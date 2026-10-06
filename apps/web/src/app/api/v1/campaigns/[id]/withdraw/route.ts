import type { NextRequest } from 'next/server';
import { apiWithdrawCampaign } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * POST /api/v1/campaigns/{id}/withdraw: take back a submission this key made, which becomes a draft
 * again (ADR-203).
 */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiWithdrawCampaign(runtime.outbound, ctx, id) },
  }));
}
