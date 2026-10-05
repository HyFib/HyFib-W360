import type { NextRequest } from 'next/server';
import { handleApiRequest } from '@/server/api';

/**
 * POST /api/v1/webhook-endpoints/replay-failed: the failed deliveries of every endpoint the key
 * added that is on, delivered again, 500 at most per call across them, once per Idempotency-Key
 * (ADR-160).
 */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) => {
      if (!idempotency) throw new Error('Idempotency-Key is required to replay deliveries');
      return runtime.apiWebhookEndpoints.replayAllFailed(ctx, body, idempotency);
    },
    { json: true, idempotency: 'required' },
  );
}
