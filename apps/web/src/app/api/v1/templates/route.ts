import type { NextRequest } from 'next/server';
import { apiListTemplates } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/templates: approved templates that can be sent (ADR-052). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: await apiListTemplates(runtime.outbound, ctx),
  }));
}
