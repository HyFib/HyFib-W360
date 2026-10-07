import type { NextRequest } from 'next/server';
import { apiGetChatLink } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/chat-links/{id} (a chat link with its clicks per day; ADR-299). */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: {
      data: await apiGetChatLink(
        { db: runtime.outbound.db, appBaseUrl: runtime.config.APP_BASE_URL },
        ctx,
        id,
      ),
    },
  }));
}
