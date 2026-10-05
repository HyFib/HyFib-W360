import type { NextRequest } from 'next/server';
import { apiUpdateMatchingConversations } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * POST /api/v1/conversations/update-matching: change the conversations a filter finds, a page at a
 * time, each as PATCH /conversations/{id} changes one (ADR-166).
 */
export const dynamic = 'force-dynamic';

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: { ...(await apiUpdateMatchingConversations(runtime.outbound, ctx, body)) },
    }),
    { json: true },
  );
}
