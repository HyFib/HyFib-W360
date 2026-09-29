import type { NextRequest } from 'next/server';
import { apiListConversations } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/conversations (a page, newest first; ADR-072). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListConversations(runtime.outbound, ctx, query)) },
  }));
}
