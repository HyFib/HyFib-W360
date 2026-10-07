import type { NextRequest } from 'next/server';
import { apiListChatLinks } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/chat-links: the company's chat links, newest first (ADR-299). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: {
      ...(await apiListChatLinks(
        { db: runtime.outbound.db, appBaseUrl: runtime.config.APP_BASE_URL },
        ctx,
        query,
      )),
    },
  }));
}
