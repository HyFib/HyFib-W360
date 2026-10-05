import type { NextRequest } from 'next/server';
import { apiUpdateMatchingContacts } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * POST /api/v1/contacts/update-matching: change the contacts a search finds, a page at a time, each
 * as PATCH /contacts/{id} changes one (ADR-165).
 */
export const dynamic = 'force-dynamic';

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: { ...(await apiUpdateMatchingContacts(runtime.outbound, ctx, body)) },
    }),
    { json: true },
  );
}
