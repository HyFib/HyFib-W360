import type { NextRequest } from 'next/server';
import { apiGetBusinessHours, apiUpdateBusinessHours } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/business-hours: the company's business hours and whether it is open now; PUT sets
 * them (ADR-290).
 */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiGetBusinessHours(runtime.outbound, ctx) },
  }));
}

export function PUT(request: NextRequest) {
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: { data: await apiUpdateBusinessHours(runtime.outbound, ctx, body) },
    }),
    { json: true },
  );
}
