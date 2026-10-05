import type { NextRequest } from 'next/server';
import { apiSendManyTemplates } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * POST /api/v1/messages/send-many: send an approved template to up to 50 numbers, each answered
 * with its queued message or why it was not sent, once per key (ADR-163).
 */
export const dynamic = 'force-dynamic';

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) => {
      if (!idempotency) throw new Error('Idempotency-Key is required for sends');
      return apiSendManyTemplates(runtime.outbound, ctx, body, idempotency);
    },
    { json: true, idempotency: 'required' },
  );
}
