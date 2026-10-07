import type { NextRequest } from 'next/server';
import { apiListDeals } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/deals (CRM deals, a page, newest first; ADR-253). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListDeals(runtime.outbound, ctx, query)) },
  }));
}
