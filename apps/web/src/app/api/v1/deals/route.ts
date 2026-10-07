import type { NextRequest } from 'next/server';
import { apiCreateDeal, apiListDeals } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/deals (CRM deals, a page, newest first; ADR-253); POST creates one (ADR-254). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListDeals(runtime.outbound, ctx, query)) },
  }));
}

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) =>
      apiCreateDeal(runtime.outbound, ctx, body, idempotency),
    { json: true, idempotency: 'optional' },
  );
}
