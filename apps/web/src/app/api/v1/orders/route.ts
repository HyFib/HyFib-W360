import type { NextRequest } from 'next/server';
import { apiListOrders } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/orders (WhatsApp orders, a page, newest first; ADR-167). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListOrders(runtime.outbound, ctx, query)) },
  }));
}
