import type { NextRequest } from 'next/server';
import { apiCreatePipeline, apiListPipelines } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/pipelines (CRM pipelines with their stages, a page, oldest first; ADR-253). POST adds
 * one with its stages (ADR-286), once per Idempotency-Key when one is given.
 */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListPipelines(runtime.outbound, ctx, query)) },
  }));
}

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) =>
      apiCreatePipeline(runtime.outbound, ctx, body, idempotency),
    { json: true, idempotency: 'optional' },
  );
}
