import type { NextRequest } from 'next/server';
import { apiListMessageTemplates } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/message-templates: the company's templates of every status, newest first (ADR-294). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListMessageTemplates(runtime.outbound, ctx, query)) },
  }));
}
