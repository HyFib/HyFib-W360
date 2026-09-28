import type { NextRequest } from 'next/server';
import { apiRecordConsent } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** POST /api/v1/contacts/{id}/consent: an opt-in or opt-out with its evidence (ADR-052). */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: { data: await apiRecordConsent(runtime.outbound, ctx, id, body) },
    }),
    { json: true },
  );
}
