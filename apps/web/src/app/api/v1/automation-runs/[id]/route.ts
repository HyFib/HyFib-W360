import type { NextRequest } from 'next/server';
import { apiGetAutomationRun } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/automation-runs/{id}: a run started through the API (ADR-077). */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiGetAutomationRun(runtime.outbound, ctx, id) },
  }));
}
