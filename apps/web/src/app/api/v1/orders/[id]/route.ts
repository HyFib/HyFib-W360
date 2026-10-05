import type { NextRequest } from 'next/server';
import { apiGetOrder } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/orders/{id} (a WhatsApp order with its items; ADR-167). */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiGetOrder(runtime.outbound, ctx, id) },
  }));
}
