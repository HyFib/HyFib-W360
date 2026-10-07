import type { NextRequest } from 'next/server';
import { apiGetTask } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/tasks/{id} (a CRM task; ADR-258). */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiGetTask(runtime.outbound, ctx, id) },
  }));
}
