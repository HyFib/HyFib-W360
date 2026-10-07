import type { NextRequest } from 'next/server';
import { apiDeleteSavedReply, apiUpdateSavedReply } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** PATCH /api/v1/saved-replies/{id} changes a saved reply; DELETE deletes it (ADR-291). */
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: { data: await apiUpdateSavedReply(runtime.outbound, ctx, id, body) },
    }),
    { json: true },
  );
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiDeleteSavedReply(runtime.outbound, ctx, id) },
  }));
}
