import type { NextRequest } from 'next/server';
import { apiMergeContacts } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** POST /api/v1/contacts/{id}/merge: merges another contact into this one (ADR-227). */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) =>
      apiMergeContacts(runtime.outbound, ctx, id, body, idempotency),
    { json: true, idempotency: 'optional' },
  );
}
