import type { NextRequest } from 'next/server';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/webhook-endpoints/{id}/deliveries: a page of deliveries, newest first (ADR-083). */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await runtime.apiWebhookEndpoints.deliveries(ctx, id, query)) },
  }));
}
