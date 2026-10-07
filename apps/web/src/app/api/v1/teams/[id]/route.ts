import type { NextRequest } from 'next/server';
import { apiDeleteTeam, apiGetTeam, apiUpdateTeam } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/teams/{id}: a team with its settings, members and numbers; PATCH changes them; DELETE
 * deletes the team (ADR-287).
 */
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiGetTeam(runtime.outbound, ctx, id) },
  }));
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: { data: await apiUpdateTeam(runtime.outbound, ctx, id, body) },
    }),
    { json: true },
  );
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiDeleteTeam(runtime.outbound, ctx, id) },
  }));
}
