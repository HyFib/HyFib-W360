import type { NextRequest } from 'next/server';
import { apiStopAutomationRun } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** POST /api/v1/automation-runs/{id}/stop: stop a run started through the API (ADR-079). */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiStopAutomationRun(runtime.outbound, ctx, id) },
  }));
}
