import type { NextRequest } from 'next/server';
import { apiStopManyAutomationRuns } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** POST /api/v1/automation-runs/stop-many: stops up to 100 runs keys started at once (ADR-162). */
export const dynamic = 'force-dynamic';

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: { data: await apiStopManyAutomationRuns(runtime.outbound, ctx, body) },
    }),
    { json: true },
  );
}
