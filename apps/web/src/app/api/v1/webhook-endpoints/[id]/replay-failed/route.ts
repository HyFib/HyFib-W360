import type { NextRequest } from 'next/server';
import { handleApiRequest } from '@/server/api';

/**
 * POST /api/v1/webhook-endpoints/{id}/replay-failed: every event whose deliveries to the endpoint
 * all failed since a given time, delivered again, 500 at most per call, once per Idempotency-Key
 * (ADR-095).
 */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) => {
      if (!idempotency) throw new Error('Idempotency-Key is required to replay deliveries');
      return runtime.apiWebhookEndpoints.replayFailed(ctx, id, body, idempotency);
    },
    { json: true, idempotency: 'required' },
  );
}
