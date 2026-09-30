import type { NextRequest } from 'next/server';
import { apiListTeams } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/teams: the company's teams, oldest first (ADR-093). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListTeams(runtime.outbound, ctx, query)) },
  }));
}
