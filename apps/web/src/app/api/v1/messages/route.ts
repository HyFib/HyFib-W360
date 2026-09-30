import type { NextRequest } from 'next/server';
import { apiListMessages, apiSendMessage } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * POST /api/v1/messages: send an approved template, or a text reply within the 24-hour window,
 * once per Idempotency-Key (ADR-052, ADR-070). GET: the messages of every conversation, newest
 * first (ADR-088).
 */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListMessages(runtime.outbound, ctx, query)) },
  }));
}

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) => {
      if (!idempotency) throw new Error('Idempotency-Key is required for sends');
      return apiSendMessage(runtime.outbound, ctx, body, idempotency);
    },
    { json: true, idempotency: 'required' },
  );
}
