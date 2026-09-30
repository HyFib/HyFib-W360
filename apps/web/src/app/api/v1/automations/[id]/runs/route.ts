import type { NextRequest } from 'next/server';
import { apiStartAutomationRun } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** POST /api/v1/automations/{id}/runs: start the automation for a contact, once per key (ADR-077). */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) => {
      if (!idempotency) throw new Error('Idempotency-Key is required to start a run');
      return apiStartAutomationRun(runtime.outbound, ctx, id, body, idempotency);
    },
    { json: true, idempotency: 'required' },
  );
}
