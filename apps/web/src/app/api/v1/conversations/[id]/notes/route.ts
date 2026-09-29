import type { NextRequest } from 'next/server';
import { apiAddConversationNote } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * POST /api/v1/conversations/{id}/notes: an internal note for the team, once per Idempotency-Key;
 * WhatsApp never receives it (ADR-084).
 */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) => {
      if (!idempotency) throw new Error('Idempotency-Key is required to add a note');
      return apiAddConversationNote(runtime.outbound, ctx, id, body, idempotency);
    },
    { json: true, idempotency: 'required' },
  );
}
