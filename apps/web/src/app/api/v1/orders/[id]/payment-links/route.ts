import type { NextRequest } from 'next/server';
import { apiListOrderPaymentLinks } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/orders/{id}/payment-links: a WhatsApp order's Payment Links, newest first (ADR-284). */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListOrderPaymentLinks(runtime.outbound, ctx, id, query)) },
  }));
}
