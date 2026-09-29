import type { NextRequest } from 'next/server';
import { handleApiRequest } from '@/server/api';

/**
 * POST /api/v1/webhook-deliveries/{id}/replay: a finished delivery's event again, as a new delivery
 * to the same endpoint, once per Idempotency-Key (ADR-083).
 */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    ({ ctx, runtime, idempotency }) => {
      if (!idempotency) throw new Error('Idempotency-Key is required to replay a delivery');
      return runtime.apiWebhookEndpoints.replay(ctx, id, idempotency);
    },
    { idempotency: 'required' },
  );
}
