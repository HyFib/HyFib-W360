import type { NextRequest } from 'next/server';
import { apiListTasks } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/tasks (CRM tasks, a page, newest first; ADR-258). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListTasks(runtime.outbound, ctx, query)) },
  }));
}
