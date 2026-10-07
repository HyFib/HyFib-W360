import type { NextRequest } from 'next/server';
import { apiUpdatePipeline } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * PATCH /api/v1/pipelines/{id}: renames a CRM pipeline, sets its stages, or archives or restores it
 * (ADR-286), once per Idempotency-Key when one is given.
 */
export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) =>
      apiUpdatePipeline(runtime.outbound, ctx, id, body, idempotency),
    { json: true, idempotency: 'optional' },
  );
}
