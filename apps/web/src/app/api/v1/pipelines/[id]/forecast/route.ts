import type { NextRequest } from 'next/server';
import { apiGetPipelineForecast } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/pipelines/{id}/forecast (a CRM pipeline's weighted forecast, now; ADR-288). */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiGetPipelineForecast(runtime.outbound, ctx, id) },
  }));
}
