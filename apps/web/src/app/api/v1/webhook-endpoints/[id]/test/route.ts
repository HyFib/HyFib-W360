import type { NextRequest } from 'next/server';
import { handleApiRequest } from '@/server/api';

/** POST /api/v1/webhook-endpoints/{id}/test: a test event, once per Idempotency-Key (ADR-083). */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    ({ ctx, runtime, idempotency }) => {
      if (!idempotency) throw new Error('Idempotency-Key is required to send a test event');
      return runtime.apiWebhookEndpoints.sendTest(ctx, id, idempotency);
    },
    { idempotency: 'required' },
  );
}
