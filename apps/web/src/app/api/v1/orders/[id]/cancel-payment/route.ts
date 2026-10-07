import type { NextRequest } from 'next/server';
import { apiCancelOrderPayment } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** POST /api/v1/orders/{id}/cancel-payment: cancel a WhatsApp order's open Payment Link (ADR-283). */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiCancelOrderPayment(runtime.outbound, ctx, id) },
  }));
}
