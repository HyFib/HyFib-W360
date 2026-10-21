import type { NextRequest } from 'next/server';
import { apiEditMessageTemplate } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * POST /api/v1/message-templates/{id}/edit: send Meta an edit of a template it has, as members do
 * on the Templates page (ADR-404).
 */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    ({ ctx, runtime, idempotency, body }) =>
      apiEditMessageTemplate(runtime.outbound, ctx, id, body, idempotency),
    { json: true, idempotency: 'optional' },
  );
}
