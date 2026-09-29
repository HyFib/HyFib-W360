import type { NextRequest } from 'next/server';
import { apiListConversationMessages } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/conversations/{id}/messages (a page, newest first; ADR-072). */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListConversationMessages(runtime.outbound, ctx, id, query)) },
  }));
}
