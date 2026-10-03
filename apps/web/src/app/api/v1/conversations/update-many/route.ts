import type { NextRequest } from 'next/server';
import { apiUpdateManyConversations } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** POST /api/v1/conversations/update-many: changes up to 100 conversations at once (ADR-120). */
export const dynamic = 'force-dynamic';

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: { data: await apiUpdateManyConversations(runtime.outbound, ctx, body) },
    }),
    { json: true },
  );
}
