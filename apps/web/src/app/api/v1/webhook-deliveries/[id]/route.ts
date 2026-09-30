import type { NextRequest } from 'next/server';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/webhook-deliveries/{id}: a delivery to an endpoint an API key added (ADR-083). */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await runtime.apiWebhookEndpoints.getDelivery(ctx, id) },
  }));
}
