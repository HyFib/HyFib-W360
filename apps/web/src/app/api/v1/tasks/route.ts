import type { NextRequest } from 'next/server';
import { apiCreateTask, apiListTasks } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/tasks (CRM tasks, a page, newest first; ADR-258); POST creates one (ADR-259). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListTasks(runtime.outbound, ctx, query)) },
  }));
}

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) =>
      apiCreateTask(runtime.outbound, ctx, body, idempotency),
    { json: true, idempotency: 'optional' },
  );
}
