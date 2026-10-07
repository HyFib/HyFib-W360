import type { NextRequest } from 'next/server';
import { apiCreateClosedDay, apiListClosedDays } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/business-hours/closed-days: the company's closed days in a span of a year at most;
 * POST marks a day closed, once per Idempotency-Key when one is given (ADR-290).
 */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListClosedDays(runtime.outbound, ctx, query)) },
  }));
}

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) =>
      apiCreateClosedDay(runtime.outbound, ctx, body, idempotency),
    { json: true, idempotency: 'optional' },
  );
}
