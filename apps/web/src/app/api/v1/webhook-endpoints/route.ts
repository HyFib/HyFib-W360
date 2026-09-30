import type { NextRequest } from 'next/server';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/webhook-endpoints: the endpoints API keys added. POST: add one, once per
 * Idempotency-Key, with its secret in the first response only (ADR-081).
 */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: await runtime.apiWebhookEndpoints.list(ctx),
  }));
}

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) => {
      if (!idempotency) throw new Error('Idempotency-Key is required to add an endpoint');
      return runtime.apiWebhookEndpoints.create(ctx, body, idempotency);
    },
    { json: true, idempotency: 'required' },
  );
}
