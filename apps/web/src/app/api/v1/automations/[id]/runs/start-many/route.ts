import type { NextRequest } from 'next/server';
import { apiStartManyAutomationRuns } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * POST /api/v1/automations/{id}/runs/start-many: start the automation for up to 50 contacts, each
 * answered with its run or why it did not start, once per key (ADR-161).
 */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) => {
      if (!idempotency) throw new Error('Idempotency-Key is required to start runs');
      return apiStartManyAutomationRuns(runtime.outbound, ctx, id, body, idempotency);
    },
    { json: true, idempotency: 'required' },
  );
}
