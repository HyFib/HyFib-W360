import type { NextRequest } from 'next/server';
import { apiListFlows } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/flows: the company's WhatsApp Flows, newest first (ADR-298). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListFlows(runtime.outbound, ctx, query)) },
  }));
}
