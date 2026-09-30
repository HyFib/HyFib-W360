import type { NextRequest } from 'next/server';
import { apiGetConversation, apiUpdateConversation } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/conversations/{id} (ADR-072); PATCH resolves or reopens it (ADR-075), assigns it or
 * moves it to a team (ADR-093).
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiGetConversation(runtime.outbound, ctx, id) },
  }));
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: { data: await apiUpdateConversation(runtime.outbound, ctx, id, body) },
    }),
    { json: true },
  );
}
