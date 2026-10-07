import type { NextRequest } from 'next/server';
import { apiListFlowResponses } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/flow-responses: the forms customers completed, newest first (ADR-298). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListFlowResponses(runtime.outbound, ctx, query)) },
  }));
}
