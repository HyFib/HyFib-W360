import type { NextRequest } from 'next/server';
import { apiSearchContacts } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** POST /api/v1/contacts/search: contacts matching segments' conditions (ADR-117). */
export const dynamic = 'force-dynamic';

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: { ...(await apiSearchContacts(runtime.outbound, ctx, body)) },
    }),
    { json: true },
  );
}
