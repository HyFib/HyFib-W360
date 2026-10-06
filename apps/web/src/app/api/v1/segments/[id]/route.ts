import type { NextRequest } from 'next/server';
import { apiArchiveSegment, apiGetSegment, apiUpdateSegment } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * One saved segment: read it with how many contacts match it now (ADR-206), change it or archive
 * it (ADR-207).
 */
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiGetSegment(runtime.outbound, ctx, id) },
  }));
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: { data: await apiUpdateSegment(runtime.outbound, ctx, id, body) },
    }),
    { json: true },
  );
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiArchiveSegment(runtime.outbound, ctx, id) },
  }));
}
