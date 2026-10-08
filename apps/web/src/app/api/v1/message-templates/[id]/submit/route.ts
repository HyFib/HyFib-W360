import type { NextRequest } from 'next/server';
import { apiSubmitMessageTemplate } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * POST /api/v1/message-templates/{id}/submit: submit a draft to Meta for review, as members do on
 * the Templates page (ADR-296).
 */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    ({ ctx, runtime, idempotency }) =>
      apiSubmitMessageTemplate(runtime.outbound, ctx, id, idempotency),
    { idempotency: 'optional' },
  );
}
