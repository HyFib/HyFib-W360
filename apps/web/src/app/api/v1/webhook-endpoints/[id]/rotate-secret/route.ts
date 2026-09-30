import type { NextRequest } from 'next/server';
import { handleApiRequest } from '@/server/api';

/**
 * POST /api/v1/webhook-endpoints/{id}/rotate-secret: a new signing secret, once per
 * Idempotency-Key and in the first response only; the previous one also signs for 24 hours
 * (ADR-081).
 */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    ({ ctx, runtime, idempotency }) => {
      if (!idempotency) throw new Error('Idempotency-Key is required to rotate a secret');
      return runtime.apiWebhookEndpoints.rotateSecret(ctx, id, idempotency);
    },
    { idempotency: 'required' },
  );
}
