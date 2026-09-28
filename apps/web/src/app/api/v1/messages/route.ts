import type { NextRequest } from 'next/server';
import { apiSendTemplate } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** POST /api/v1/messages: send an approved template, once per Idempotency-Key (ADR-052). */
export const dynamic = 'force-dynamic';

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) => {
      if (!idempotency) throw new Error('Idempotency-Key is required for sends');
      return apiSendTemplate(runtime.outbound, ctx, body, idempotency);
    },
    { json: true, idempotency: 'required' },
  );
}
