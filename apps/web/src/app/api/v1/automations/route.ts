import type { NextRequest } from 'next/server';
import { apiListAutomations } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/automations: automations started through the API, oldest first (ADR-077). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListAutomations(runtime.outbound, ctx, query)) },
  }));
}
