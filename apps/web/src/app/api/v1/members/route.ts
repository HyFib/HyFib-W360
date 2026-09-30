import type { NextRequest } from 'next/server';
import { apiListMembers } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/members: the members conversations can be assigned to, oldest first (ADR-093). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListMembers(runtime.outbound, ctx, query)) },
  }));
}
