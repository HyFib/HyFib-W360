import type { NextRequest } from 'next/server';
import { apiGetChatLink, apiUpdateChatLink } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/chat-links/{id} (a chat link with its clicks per day; ADR-299); PATCH changes,
 * archives or restores it (ADR-300).
 */
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
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

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: {
        data: await apiUpdateChatLink(
          {
            db: runtime.outbound.db,
            clock: runtime.outbound.clock,
            appBaseUrl: runtime.config.APP_BASE_URL,
          },
          ctx,
          id,
          body,
        ),
      },
    }),
    { json: true },
  );
}
