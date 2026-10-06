import type { NextRequest } from 'next/server';
import { apiCreateSegment, apiListSegments } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/segments: the company's saved segments, newest first (ADR-206). POST: create one
 * (ADR-207), once per Idempotency-Key when one is given.
 */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListSegments(runtime.outbound, ctx, query)) },
  }));
}

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) =>
      apiCreateSegment(runtime.outbound, ctx, body, idempotency),
    { json: true, idempotency: 'optional' },
  );
}
