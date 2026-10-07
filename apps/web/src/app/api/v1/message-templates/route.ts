import type { NextRequest } from 'next/server';
import { apiCreateMessageTemplate, apiListMessageTemplates } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/message-templates: the company's templates of every status, newest first (ADR-294);
 * POST adds a draft, once per Idempotency-Key when one is given (ADR-295).
 */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListMessageTemplates(runtime.outbound, ctx, query)) },
  }));
}

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) =>
      apiCreateMessageTemplate(runtime.outbound, ctx, body, idempotency),
    { json: true, idempotency: 'optional' },
  );
}
