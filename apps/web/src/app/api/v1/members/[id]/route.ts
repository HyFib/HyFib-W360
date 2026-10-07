import type { NextRequest } from 'next/server';
import { apiUpdateMember } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** PATCH /api/v1/members/{id}: whether the member takes conversations routing gives out (ADR-289). */
export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: { data: await apiUpdateMember(runtime.outbound, ctx, id, body) },
    }),
    { json: true },
  );
}
