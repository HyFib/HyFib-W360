import type { NextRequest } from 'next/server';
import { apiListSatisfactionSurveys } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/satisfaction-surveys: the company's satisfaction surveys, newest first (ADR-292). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListSatisfactionSurveys(runtime.outbound, ctx, query)) },
  }));
}
