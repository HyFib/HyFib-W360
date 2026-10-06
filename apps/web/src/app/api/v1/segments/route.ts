import type { NextRequest } from 'next/server';
import { apiListSegments } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/segments: the company's saved segments, newest first (ADR-206). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListSegments(runtime.outbound, ctx, query)) },
  }));
}
