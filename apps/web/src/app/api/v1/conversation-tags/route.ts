import type { NextRequest } from 'next/server';
import { apiListConversationTags } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/conversation-tags: the tags on the company's conversations, alphabetically (ADR-272). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListConversationTags(runtime.outbound, ctx, query)) },
  }));
}
