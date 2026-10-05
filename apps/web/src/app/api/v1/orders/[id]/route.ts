import type { NextRequest } from 'next/server';
import { apiGetOrder, apiUpdateOrder } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/orders/{id} (a WhatsApp order with its items; ADR-167); PATCH confirms, fulfils or
 * cancels it (ADR-168).
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiGetOrder(runtime.outbound, ctx, id) },
  }));
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: { data: await apiUpdateOrder(runtime.outbound, ctx, id, body) },
    }),
    { json: true },
  );
}
