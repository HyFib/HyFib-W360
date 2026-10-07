import type { NextRequest } from 'next/server';
import { apiCreateTeam, apiListTeams } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/teams: the company's teams, oldest first (ADR-093). POST adds one with its settings,
 * members and numbers (ADR-287), once per Idempotency-Key when one is given.
 */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListTeams(runtime.outbound, ctx, query)) },
  }));
}

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) =>
      apiCreateTeam(runtime.outbound, ctx, body, idempotency),
    { json: true, idempotency: 'optional' },
  );
}
