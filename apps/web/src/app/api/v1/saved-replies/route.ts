import type { NextRequest } from 'next/server';
import { apiCreateSavedReply, apiListSavedReplies } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/saved-replies: the company's saved replies by shortcut; POST adds one, once per
 * Idempotency-Key when one is given (ADR-291).
 */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { ...(await apiListSavedReplies(runtime.outbound, ctx)) },
  }));
}

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) =>
      apiCreateSavedReply(runtime.outbound, ctx, body, idempotency),
    { json: true, idempotency: 'optional' },
  );
}
